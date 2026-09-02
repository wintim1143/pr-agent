import 'dotenv/config';
import crypto from 'node:crypto';

/**
 * 飞书(Lark)通知 adapter —— 用于 workflow 的 notify 步向飞书推送「开发完成」卡片。
 *
 * 设计目标(对应文档 §5 / K6):
 * - 全 env 驱动,支持两种接入方式,任选其一:
 *   1) 群机器人 Webhook(`FEISHU_WEBHOOK_URL`):最简单,推荐先用来验证连通性;
 *      群机器人开启「签名校验」时填 `FEISHU_WEBHOOK_SECRET`。
 *   2) 企业自建应用(`FEISHU_APP_ID` + `FEISHU_APP_SECRET` + `FEISHU_RECEIVE_ID`):
 *      走 tenant_access_token,可发到指定群/人,且卡片按钮支持 `card.action.trigger` 回调。
 * - 模块加载**绝不抛错**(否则拖垮 `npm test` 与 `GET /api/agents` 仅列元数据)。
 *   env 缺失只在真正调用 `feishuNotify()` 时由 `getFeishuConfig()` 判空、返回明确错误。
 * - 卡片交互对应设计文档 §5.2:开发完成卡片带「🔀 合并 / ❌ 拒绝」按钮,
 *   `callback_id` 内嵌 issue 号(`merge_<n>` / `reject_<n>`)。
 *   注意:按钮回调触发 `resume` 走完整 IM 入口(长连接/回调服务器),属 P1 inbound 工作,
 *   本 adapter 只负责「推」,不负责「收」。
 */

export type FeishuReceiveIdType = 'chat_id' | 'user_id' | 'open_id' | 'union_id';

export interface FeishuConfig {
  mode: 'webhook' | 'app';
  webhookUrl?: string;
  webhookSecret?: string;
  appId?: string;
  appSecret?: string;
  receiveId?: string;
  receiveIdType: FeishuReceiveIdType;
}

export interface FeishuButton {
  /** 按钮文字 */
  text: string;
  /** 业务标识,会作为卡片 `value.callback_id` 透传,如 `merge_123` / `reject_123` */
  value: string;
  type?: 'primary' | 'danger' | 'default';
}

export interface FeishuNotifyInput {
  title: string;
  /** lark_md 正文 */
  markdown: string;
  issueNumber?: number;
  template?: 'blue' | 'green' | 'red' | 'orange' | 'grey';
  buttons?: FeishuButton[];
}

export interface FeishuNotifyResult {
  ok: boolean;
  mode: string;
  statusCode?: number;
  raw?: unknown;
  error?: string;
}

const FEISHU_DOMAIN = 'https://open.feishu.cn/open-apis';

/** 从环境变量解析飞书配置;两种模式任一齐全即返回配置,否则返回 null(未配置)。 */
export function getFeishuConfig(): FeishuConfig | null {
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    return {
      mode: 'webhook',
      webhookUrl,
      webhookSecret: process.env.FEISHU_WEBHOOK_SECRET?.trim() || undefined,
      receiveIdType: 'chat_id',
    };
  }
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  const receiveId = process.env.FEISHU_RECEIVE_ID?.trim();
  if (appId && appSecret && receiveId) {
    const type = process.env.FEISHU_RECEIVE_ID_TYPE?.trim();
    const receiveIdType: FeishuReceiveIdType =
      type === 'user_id' || type === 'open_id' || type === 'union_id' ? type : 'chat_id';
    return { mode: 'app', appId, appSecret, receiveId, receiveIdType };
  }
  return null;
}

/** 返回缺失的环境变量名(用于验证脚本友好提示 / 启动自检)。 */
export function missingFeishuConfig(): string[] {
  const cfg = getFeishuConfig();
  if (cfg) return [];

  const hasWebhook = !!process.env.FEISHU_WEBHOOK_URL?.trim();
  if (hasWebhook) return []; // webhook 模式只需 URL

  const hasAppId = !!process.env.FEISHU_APP_ID?.trim();
  const hasAppSecret = !!process.env.FEISHU_APP_SECRET?.trim();
  const hasReceiveId = !!process.env.FEISHU_RECEIVE_ID?.trim();
  if (hasAppId || hasAppSecret || hasReceiveId) {
    const missing: string[] = [];
    if (!hasAppId) missing.push('FEISHU_APP_ID');
    if (!hasAppSecret) missing.push('FEISHU_APP_SECRET');
    if (!hasReceiveId) missing.push('FEISHU_RECEIVE_ID');
    return missing;
  }
  return ['FEISHU_WEBHOOK_URL', '或 FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_RECEIVE_ID'];
}

interface FeishuCard {
  config: { wide_screen_mode: boolean };
  header: { title: { tag: 'plain_text'; content: string }; template: string };
  elements: Array<Record<string, unknown>>;
}

/** 构造飞书 interactive 卡片(对应设计文档 §5.2 的卡片结构)。 */
export function buildCard(input: FeishuNotifyInput): FeishuCard {
  const elements: Array<Record<string, unknown>> = [{ tag: 'div', text: { tag: 'lark_md', content: input.markdown } }];
  if (input.buttons && input.buttons.length > 0) {
    elements.push({
      tag: 'action',
      actions: input.buttons.map(b => ({
        tag: 'button',
        text: { tag: 'plain_text', content: b.text },
        type: b.type || 'default',
        value: { callback_id: b.value },
      })),
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: input.title },
      template: input.template || 'blue',
    },
    elements,
  };
}

/** 构造「开发完成」卡片(notify 步直接调用)。 */
export function buildDevCompleteCard(ctx: {
  issueNumber: number;
  issueTitle: string;
  branch?: string;
  prNumber?: number;
}): FeishuNotifyInput {
  const lines = [
    `**需求**: #${ctx.issueNumber} ${ctx.issueTitle}`,
    ctx.branch ? `**分支**: \`${ctx.branch}\`` : '',
    typeof ctx.prNumber === 'number' && ctx.prNumber > 0 ? `**PR**: #${ctx.prNumber}` : '',
    '',
    '请在飞书卡片上点 **🔀 合并** 或 **❌ 拒绝**(按钮回调需 IM 入口,后续接入)。',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    title: `✅ 开发完成 · #${ctx.issueNumber} ${ctx.issueTitle}`,
    markdown: lines,
    issueNumber: ctx.issueNumber,
    template: 'blue',
    buttons: [
      { text: '🔀 合并', value: `merge_${ctx.issueNumber}`, type: 'primary' },
      { text: '❌ 拒绝', value: `reject_${ctx.issueNumber}`, type: 'danger' },
    ],
  };
}

// ---------- Webhook(群机器人)模式 ----------

function signWebhook(timestamp: string, secret: string): string {
  // 飞书签名算法:base64(HMAC-SHA256(timestamp + '\n' + secret, key=secret))
  return crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
}

async function sendViaWebhook(cfg: FeishuConfig, card: FeishuCard): Promise<FeishuNotifyResult> {
  const body: Record<string, unknown> = { msg_type: 'interactive', card };
  if (cfg.webhookSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = signWebhook(timestamp, cfg.webhookSecret);
  }
  const resp = await fetch(cfg.webhookUrl as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await resp.json().catch(() => null);
  const ok = resp.ok && ((raw as { StatusCode?: number })?.StatusCode === 0 || (raw as { code?: number })?.code === 0);
  return { ok, mode: 'webhook', statusCode: resp.status, raw };
}

// ---------- 自建应用模式 ----------

let tokenCache: { token: string; exp: number } | null = null;

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now + 60_000) return tokenCache.token;
  const resp = await fetch(`${FEISHU_DOMAIN}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = (await resp.json().catch(() => null)) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (j?.code !== 0 || !j?.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: code=${j?.code} msg=${j?.msg}`);
  }
  tokenCache = { token: j.tenant_access_token, exp: now + (j.expire ?? 7200) * 1000 };
  return j.tenant_access_token;
}

async function sendViaApp(cfg: FeishuConfig, card: FeishuCard): Promise<FeishuNotifyResult> {
  const token = await getTenantAccessToken(cfg.appId as string, cfg.appSecret as string);
  const url = `${FEISHU_DOMAIN}/im/v1/messages?receive_id_type=${cfg.receiveIdType}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: cfg.receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const raw = await resp.json().catch(() => null);
  const ok = resp.ok && (raw as { code?: number })?.code === 0;
  return { ok, mode: 'app', statusCode: resp.status, raw };
}

/**
 * 向飞书推送一张卡片。未配置时返回明确错误(不抛);真实发送失败仅在返回结果里标记,
 * 由调用方决定是否阻断流程(本项目的 notify 步选择不阻断)。
 */
export async function feishuNotify(input: FeishuNotifyInput): Promise<FeishuNotifyResult> {
  const cfg = getFeishuConfig();
  if (!cfg) {
    return {
      ok: false,
      mode: 'none',
      error: '飞书未配置:缺少 FEISHU_WEBHOOK_URL 或 FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_RECEIVE_ID',
    };
  }
  const card = buildCard(input);
  try {
    return cfg.mode === 'webhook' ? await sendViaWebhook(cfg, card) : await sendViaApp(cfg, card);
  } catch (e) {
    return { ok: false, mode: cfg.mode, error: e instanceof Error ? e.message : String(e) };
  }
}
