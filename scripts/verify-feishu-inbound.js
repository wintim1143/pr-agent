/**
 * M1-3 验证脚本:真实拉一次飞书群消息(自建应用模式)。
 *
 * 独立 Node 脚本,复用与 adapters/feishu.ts 一致的:tenant_access_token 获取 + 消息列表 REST。
 * 需要 .env 配置:FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_RECEIVE_ID(群的 chat_id)。
 *
 * 运行: node scripts/verify-feishu-inbound.js
 * 验收判据(M1-3):能打印群里最近的消息文本。
 * 若未配置 / 机器人未入群 / 缺权限,脚本给出明确提示(对应 M1 卡的降级路径)。
 */
'use strict';
require('dotenv').config();

const FEISHU_DOMAIN = 'https://open.feishu.cn/open-apis';

async function getToken(appId, appSecret) {
  const resp = await fetch(`${FEISHU_DOMAIN}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await resp.json().catch(() => null);
  if (j?.code !== 0 || !j?.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: code=${j?.code} msg=${j?.msg}`);
  }
  return j.tenant_access_token;
}

(async () => {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const chatId = process.env.FEISHU_RECEIVE_ID;
  if (!appId || !appSecret || !chatId) {
    console.error('✗ 飞书收消息需配置 FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_RECEIVE_ID(群的 chat_id)');
    console.error('  若仅做「发」或不接 inbound,可跳过本脚本(M1 降级为 HTTP 触发 + 飞书仅发不收)');
    process.exit(0); // 降级路径:不视为失败
  }
  const token = await getToken(appId, appSecret);
  const sinceTs = Math.floor(Date.now() / 1000) - 7 * 24 * 3600; // 近 7 天
  const url = `${FEISHU_DOMAIN}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(
    chatId
  )}&start_time=${sinceTs}&sort_type=ByCreateTimeAsc`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await resp.json().catch(() => null);
  if (j?.code !== 0) {
    console.error(`✗ 拉取消息失败: code=${j?.code} msg=${j?.msg}`);
    process.exit(1);
  }
  const items = j?.data?.items ?? [];
  console.log(`✓ 近 7 天群消息数: ${items.length}`);
  for (const it of items.slice(-5)) {
    let text = '';
    try {
      text = JSON.parse(it.content ?? '{}').text ?? '';
    } catch {
      text = it.msg_type || '';
    }
    console.log(`  [${it.message_id}] ${text.slice(0, 80)}`);
  }
  console.log(items.length >= 1 ? '\n✅ M1-3 收消息验收通过' : '\n⚠️ 群内暂无消息(接口可达即为通过)');
  process.exit(0);
})().catch(e => {
  console.error('✗ 验证失败:', e.message);
  process.exit(1);
});
