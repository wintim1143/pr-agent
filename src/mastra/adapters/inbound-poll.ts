/**
 * 入口轮询的去重闸 + 游标（M5a-2）。
 *
 * ## 为什么把这段逻辑从 controller 里抽出来
 *
 * 原实现把「拉消息 → 逐条起 run」写在 `api.controller.ts` 的 `pollFeishu` 里，
 * 而那段逻辑**只能在飞书真实可达时被验证** —— 于是「去重到底生效没有」这件事
 * 就只能靠手工重投碰运气。抽成独立函数后，HTTP 入口与验证脚本
 * **走同一条代码路径**（只是喂不同的 `fetchMessages` / `startRun`），
 * 幂等行为因此变成可自动判定的。
 *
 * ## 两条状态，两个作用
 *
 * | 状态 | 表 | 解决的问题 |
 * |---|---|---|
 * | 事件认领 | `pr_agent_seen_events` | 同一条消息重投不重复起 run（**幂等键 = 消息 ID**） |
 * | 轮询游标 | `pr_agent_cursors` | 进程重启后从上次位置续读，不重扫历史窗口 |
 *
 * 两者**互补而非重复**：游标把窗口压小（省一次拉取），认领表兜住窗口重叠与重投
 * （M5 卡 §10 异常表：「飞书轮询窗口重叠 → 由去重表兜住，不依赖窗口不重叠」）。
 *
 * ## 失败策略
 *
 * 认领写库失败 → **整个 poll 立刻失败并拒绝起任何新 run**（fail-closed）。
 * 刻意不降级为「去重坏了但继续跑」—— 那正是本模块要防的重复消耗
 * （每个重复 run 都在真金白银地跑 coding + review）。
 */
import { advanceCursor, attachRunId, claimEvent, getCursor } from './dedup-store.js';

/** 与 `FeishuInboundMessage` 结构兼容的最小子集（不 import 飞书模块，保持本模块可独立单测）。 */
export interface InboundMessage {
  messageId: string;
  text: string;
  createTime: number;
}

export interface PollInboundOptions {
  /** 幂等来源标识，同时用作游标键（如 `feishu:<chatId>`） */
  source: string;
  /** 显式窗口起点（秒）。省略 → 读游标；再没有 → `now - windowSec` */
  sinceTs?: number;
  /** 首次运行（无游标）时的回溯窗口秒数，默认 `FEISHU_POLL_WINDOW_SEC` 或 3600 */
  windowSec?: number;
  /** 拉取消息。由调用方注入，使本函数不绑定具体 IM 客户端 */
  fetchMessages: (sinceTs: number) => Promise<InboundMessage[]>;
  /** 起一个 run 并返回 runId。由调用方注入（HTTP 入口起 insight-workflow，脚本起 dev-workflow） */
  startRun: (text: string, message: InboundMessage) => Promise<string>;
}

export interface PollInboundResult {
  success: boolean;
  source: string;
  /** 本轮实际使用的窗口起点 */
  sinceTs: number;
  windowSource: 'explicit' | 'cursor' | 'default';
  cursorBefore: number | null;
  cursorAfter: number;
  /** 拉取到的消息条数（含被跳过的） */
  polled: number;
  triggered: Array<{ messageId: string; runId: string }>;
  /** 跳过原因必须**可见**，不能静默丢弃（M5 卡 AC-1 的判据） */
  skipped: Array<{ messageId: string; reason: 'empty' | 'duplicate' }>;
  error?: string;
}

/** 默认回溯窗口（秒）。1 小时与 M1 的原始缺省一致，便于对比历史行为。 */
function defaultWindowSec(): number {
  const n = Number(process.env.FEISHU_POLL_WINDOW_SEC ?? 3600);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/**
 * 跑一轮入口轮询（带去重与游标）。
 *
 * @returns 结构化结果。`success:false` 时**没有起任何新 run**（fail-closed）。
 */
export async function pollInboundOnce(opts: PollInboundOptions): Promise<PollInboundResult> {
  const source = opts.source;
  const base: Omit<PollInboundResult, 'sinceTs' | 'windowSource' | 'cursorBefore' | 'cursorAfter' | 'polled' | 'triggered' | 'skipped' | 'success'> = { source };

  // ---- 1) 定窗口：显式 > 游标 > 默认回溯 ----
  let cursorBefore: number | null;
  try {
    cursorBefore = await getCursor(source);
  } catch (e) {
    return {
      ...base,
      success: false,
      error: `去重存储读取失败（fail-closed，未起任何 run）：${e instanceof Error ? e.message : String(e)}`,
      sinceTs: 0,
      windowSource: 'default',
      cursorBefore: null,
      cursorAfter: 0,
      polled: 0,
      triggered: [],
      skipped: [],
    };
  }
  const windowSource: PollInboundResult['windowSource'] =
    typeof opts.sinceTs === 'number' ? 'explicit' : cursorBefore !== null ? 'cursor' : 'default';
  const sinceTs =
    typeof opts.sinceTs === 'number'
      ? opts.sinceTs
      : cursorBefore !== null
        ? cursorBefore
        : Math.floor(Date.now() / 1000) - (opts.windowSec ?? defaultWindowSec());

  // ---- 2) 拉消息 ----
  let messages: InboundMessage[];
  try {
    messages = await opts.fetchMessages(sinceTs);
  } catch (e) {
    return {
      ...base,
      success: false,
      error: `拉取消息失败：${e instanceof Error ? e.message : String(e)}`,
      sinceTs,
      windowSource,
      cursorBefore,
      cursorAfter: cursorBefore ?? sinceTs,
      polled: 0,
      triggered: [],
      skipped: [],
    };
  }

  // ---- 3) 逐条：空消息跳过；否则**先原子认领，再起 run** ----
  const triggered: PollInboundResult['triggered'] = [];
  const skipped: PollInboundResult['skipped'] = [];
  let maxTs = sinceTs;

  for (const m of messages) {
    maxTs = Math.max(maxTs, Number.isFinite(m.createTime) ? m.createTime : maxTs);
    const text = m.text?.trim();
    if (!text) {
      // 空消息**不认领**：它不会起 run，也就没有「重复」可言；
      // 但仍要推进游标（否则全空的一轮会让游标卡住不动）。
      skipped.push({ messageId: m.messageId, reason: 'empty' });
      continue;
    }

    let claimed: boolean;
    try {
      claimed = (await claimEvent(m.messageId, source)).claimed;
    } catch (e) {
      // 认领失败 → 整轮 fail-closed。已经认领过并起过 run 的条目保留在 triggered 里（不回滚），
      // 因为回滚会丢证据；返回结构里明确说明「从这里开始没继续」。
      return {
        ...base,
        success: false,
        error:
          `去重存储不可写，fail-closed 拒绝继续起 run（已起 ${triggered.length} 个）：` +
          `${e instanceof Error ? e.message : String(e)}`,
        sinceTs,
        windowSource,
        cursorBefore,
        cursorAfter: cursorBefore ?? sinceTs,
        polled: messages.length,
        triggered,
        skipped,
      };
    }
    if (!claimed) {
      // 这正是「同一条消息重投」被挡住的地方。**必须留可见证据**（不能静默 continue）。
      skipped.push({ messageId: m.messageId, reason: 'duplicate' });
      continue;
    }

    const runId = await opts.startRun(text, m);
    try {
      await attachRunId(m.messageId, runId);
    } catch (e) {
      // 认领已成功（去重能力不受影响），只是「事件 → run」的反查索引缺失。
      // 因此只告警不失败 —— 把一个已经起起来的 run 判成失败，代价更大。
      console.warn(`[inbound-poll] 回填 runId 失败（不影响去重）：${e instanceof Error ? e.message : e}`);
    }
    triggered.push({ messageId: m.messageId, runId });
  }

  // ---- 4) 推进游标（只前进不后退，见 advanceCursor） ----
  let cursorAfter: number;
  try {
    cursorAfter = await advanceCursor(source, maxTs);
  } catch (e) {
    // run 已经起完了，此处失败只影响「下次少扫一点」，不该把本轮判成失败。
    console.warn(`[inbound-poll] 推进游标失败（不影响本轮结果）：${e instanceof Error ? e.message : e}`);
    cursorAfter = cursorBefore ?? sinceTs;
  }

  return {
    ...base,
    success: true,
    sinceTs,
    windowSource,
    cursorBefore,
    cursorAfter,
    polled: messages.length,
    triggered,
    skipped,
  };
}
