'use strict';
/*
 * 飞书「列出群 chat_id」辅助脚本(仅自建应用模式用)。
 * 用途:帮你拿到要接收通知的群 chat_id,填进 .env 的 FEISHU_RECEIVE_ID。
 *
 * 前置:已在 .env 配好 FEISHU_APP_ID / FEISHU_APP_SECRET,且机器人已加入目标群。
 * 用法:node scripts/feishu-list-chats.js
 *
 * 同时可顺带验证 App ID / App Secret 是否有效(拿不到 token 即凭证错误)。
 */
require('dotenv/config');

const APP_ID = process.env.FEISHU_APP_ID?.trim();
const APP_SECRET = process.env.FEISHU_APP_SECRET?.trim();
const DOMAIN = 'https://open.feishu.cn/open-apis';

if (!APP_ID || !APP_SECRET) {
  console.error('[FAIL] 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET,无法列举群。');
  process.exit(1);
}

async function getTenantToken() {
  const r = await fetch(`${DOMAIN}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: code=${j.code} msg=${j.msg} ${JSON.stringify(j)}`);
  }
  return j.tenant_access_token;
}

async function listChats(token) {
  const r = await fetch(`${DOMAIN}/im/v1/chats?page_size=50&user_id_type=open_id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (j.code !== 0) {
    throw new Error(`列举群失败: code=${j.code} msg=${j.msg} ${JSON.stringify(j)}`);
  }
  return j.data?.items || [];
}

(async () => {
  console.log('=== 获取 tenant_access_token ===');
  const token = await getTenantToken();
  console.log('[OK] token 获取成功(App ID / Secret 有效)');

  console.log(
    '\n=== 你的群(选一个,把 chat_id 填进 .env 的 FEISHU_RECEIVE_ID,FEISHU_RECEIVE_ID_TYPE 保持默认 chat_id) ==='
  );
  const chats = await listChats(token);
  if (!chats.length) {
    console.log('(空)机器人尚未加入任何群 —— 先在飞书把本应用机器人拉进目标群,再重跑本脚本。');
    return;
  }
  for (const c of chats) {
    console.log(`  chat_id=${c.chat_id}  name=${c.name || '(未命名)'}`);
  }
  console.log(
    '\n下一步:把上面某个 chat_id 填入 .env 的 FEISHU_RECEIVE_ID,然后 `node scripts/verify-feishu.js` 做真实推送验证。'
  );
})().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
