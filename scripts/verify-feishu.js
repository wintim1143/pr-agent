'use strict';
/*
 * 飞书通知验证脚本(结构 + 真实推送)。
 * - 结构校验:解析 FEISHU_* 配置、缺失项友好提示(无需真实凭据,随时可跑)。
 * - 真实推送:凭据齐全时,向飞书发一张「开发完成」测试卡片,验证 webhook / 自建应用真能用。
 *
 * 用法:
 *   node scripts/verify-feishu.js            # 结构校验(无需凭据)
 *   cp .env.example .env && 填好飞书凭据 && node scripts/verify-feishu.js   # 含真实推送
 */
require('dotenv/config');

async function main() {
  const { getFeishuConfig, missingFeishuConfig, feishuNotify, buildDevCompleteCard } = require('../dist/mastra/adapters/feishu.js');

  console.log('=== 解析后的飞书配置 ===');
  const cfg = getFeishuConfig();
  if (!cfg) {
    const appId = process.env.FEISHU_APP_ID?.trim();
    const secret = process.env.FEISHU_APP_SECRET?.trim();
    const webhook = process.env.FEISHU_WEBHOOK_URL?.trim();
    if (appId && secret) {
      console.log('(自建应用:App ID / App Secret 已配置,但缺 FEISHU_RECEIVE_ID 接收目标)');
    } else if (webhook) {
      console.log('(Webhook 已配置)');
    } else {
      console.log('(未配置)');
    }
  } else if (cfg.mode === 'webhook') {
    const url = cfg.webhookUrl || '';
    console.log({
      mode: 'webhook',
      webhookUrl: url.slice(0, 40) + (url.length > 40 ? '...' : ''),
      signed: !!cfg.webhookSecret,
    });
  } else {
    console.log({
      mode: 'app',
      appId: (cfg.appId || '').slice(0, 4) + '***(已隐藏)',
      receiveIdType: cfg.receiveIdType,
      receiveId: (cfg.receiveId || '').slice(0, 6) + '***',
    });
  }

  const missing = missingFeishuConfig();
  if (missing.length) {
    console.log(`\n[跳过真实推送] 缺失环境变量: ${missing.join(', ')}`);
    console.log('请 `cp .env.example .env` 并填好飞书凭据,再重跑本脚本做真实推送验证。');
    return;
  }

  console.log('\n=== 真实推送:向飞书发一张测试卡片 ===');
  const res = await feishuNotify(
    buildDevCompleteCard({
      issueNumber: 999,
      issueTitle: '【验证】飞书通知连通性测试',
      branch: 'feat/999-verify',
      prNumber: 999,
    })
  );
  if (res.ok) {
    console.log(`[OK] 飞书推送成功(mode=${res.mode})`);
  } else {
    console.error('[FAIL] 飞书推送失败:', res.error || JSON.stringify(res.raw));
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
