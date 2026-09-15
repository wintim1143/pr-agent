import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 流水线阶段事件日志(2026-09-14)。
 *
 * ## 解决什么问题
 *
 * dev-workflow 的 coding 步是**同步阻塞、静默无输出**的:一次 generate 可能跑 5~15 分钟,
 * 期间终端只有一个卡住的提示符。使用者无法区分三种状态:
 * 1. LLM 正常思考中(该等)
 * 2. 上游中继挂死(该杀)
 * 3. CLI 子进程已崩但 Promise 未 settle(该查)
 *
 * 只能事后翻 `~/.claude/projects/<repo>/*.jsonl` 考古,成本极高。
 *
 * ## 做法
 *
 * 每个阶段边界写一条 **JSON Lines** 事件到 `logs/dev-workflow.log`,同时打一行人类可读文本到 stdout。
 * JSONL 的好处:可 `tail -f` 实时看,也可用 jq / node 做结构化统计(每阶段耗时、重试次数)。
 *
 * ## 为什么不用 Mastra 的 tracing
 *
 * Mastra 有内置 telemetry,但需要 OTEL exporter 与额外依赖,且本仓库当前**没有观测后端**;
 * 写本地文件的收益(零依赖、可直接 tail)在 M6 引入真观测前更直接。M6 做 run 追踪时
 * 可把本模块替换为 OTEL span,事件字段已按 span 语义命名(start/end/durationMs)以便迁移。
 */

/** 环境变量 `PR_AGENT_PROGRESS_LOG=0` 可关闭,`PR_AGENT_PROGRESS_FILE` 可改路径。 */
const enabled = process.env.PR_AGENT_PROGRESS_LOG !== '0';
const LOG_FILE = path.resolve(process.env.PR_AGENT_PROGRESS_FILE || path.join(process.cwd(), 'logs/dev-workflow.log'));

/** 事件类型:step 级与 llm 级分开,便于统计「哪个阶段慢」。 */
export type ProgressEvent =
  | 'step:start'
  | 'step:done'
  | 'step:fail'
  | 'llm:start'
  | 'llm:done'
  | 'llm:retry';

export interface ProgressFields {
  /** 流水线阶段名(checkout / coding / test / review / commit / push-open-pr / notify / merge) */
  stage?: string;
  /** run 标识,便于把并发/多次运行的事件分开 */
  runId?: string;
  /** 本次事件耗时(毫秒);仅 done/fail 类事件有 */
  durationMs?: number;
  /** 补充信息:轮次、重试次数、错误摘要等 */
  [key: string]: unknown;
}

function write(event: ProgressEvent, fields: ProgressFields = {}): void {
  if (!enabled) return;
  const { durationMs, ...rest } = fields;
  const record = {
    ts: new Date().toISOString(),
    event,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...rest,
  };

  // 人类可读行:阶段 + 事件 + 耗时 + 关键字段
  const secs = durationMs !== undefined ? ` (${(durationMs / 1000).toFixed(1)}s)` : '';
  const extra = Object.entries(rest)
    .filter(([k]) => k !== 'stage' && k !== 'runId')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  console.log(`[${record.ts}] ${fields.stage ?? '-'} ${event}${secs}${extra ? ' | ' + extra : ''}`);

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    // 日志写失败绝不能拖垮流水线本体(与闸门 fail-closed 相反:观测是辅助,不是安全边界)。
    console.warn(`[progress] 写日志失败(不影响流程): ${e instanceof Error ? e.message : e}`);
  }
}

/** 记录一个阶段的开始,返回结束/失败回调(内部计时,调用方无需自己算耗时)。 */
export function stageStart(stageName: string, runId?: string): {
  done: (fields?: ProgressFields) => number;
  fail: (error: unknown, fields?: ProgressFields) => number;
} {
  const t0 = Date.now();
  write('step:start', { stage: stageName, runId });
  return {
    done(fields = {}) {
      const durationMs = Date.now() - t0;
      write('step:done', { stage: stageName, runId, durationMs, ...fields });
      return durationMs;
    },
    fail(error, fields = {}) {
      const durationMs = Date.now() - t0;
      const message = error instanceof Error ? error.message : String(error);
      write('step:fail', { stage: stageName, runId, durationMs, error: message.slice(0, 300), ...fields });
      return durationMs;
    },
  };
}

/** 单条事件(用于 step 内部,如 LLM 调用开始/结束、重试)。 */
export function stage(event: ProgressEvent, fields: ProgressFields = {}): void {
  write(event, fields);
}

export const stageOk = stage;
export const stageFail = stage;

/** 当前日志文件绝对路径(供脚本/文档展示)。 */
export function progressLogPath(): string {
  return LOG_FILE;
}
