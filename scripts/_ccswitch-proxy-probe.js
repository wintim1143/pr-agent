/**
 * 探测 cc-switch 本地代理(127.0.0.1:15721)的 Anthropic Messages 端点是否可用。
 *
 * 背景与动机:
 * - 官方 @mastra/claude 示例**不传 API key**,只给 model + cwd → 说明 Claude Agent SDK
 *   走的是「环境里既有的凭据」(ANTHROPIC_API_KEY env,或 Claude Code CLI 的登录态)。
 * - 本机 ~/.claude/settings.json 把 ANTHROPIC_BASE_URL 指向 http://127.0.0.1:15721(cc-switch 代理),
 *   并注入 ANTHROPIC_AUTH_TOKEN。也就是说:**本机 Claude Code 本来就有可用通路**。
 * - 但 src/mastra/agents/coding-agent.ts:126-131 在 sdkOptions.env 里把 ANTHROPIC_BASE_URL
 *   硬改成了 LLM_BASE_URL(lanfengai 直连),**覆盖掉了这条本机可用通路**。
 *   若 lanfengai 直连挂了而代理可用,那 M2 卡死的原因就是我们自己覆盖坏的。
 *
 * 本脚本验证:代理的 /v1/messages 是否通、是否支持 tool_use。
 *
 * 运行: node scripts/_ccswitch-proxy-probe.js
 */
'use strict';
require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 从 ~/.claude/settings.json 读代理配置(值不落盘、只在内存用)
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env || {};
} catch (e) {
  console.log('⚠️ 读 ~/.claude/settings.json 失败:', e.message);
}

const base = (cfg.ANTHROPIC_BASE_URL || 'http://127.0.0.1:15721').replace(/\/+$/, '');
const token = cfg.ANTHROPIC_AUTH_TOKEN || '';
const model = cfg.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';

console.log('代理 base =', base);
console.log('模型      =', model);
console.log('token     =', token ? `${token.slice(0, 7)}...(${token.length}字符)` : '(空)');
console.log('(settings 里 ANTHROPIC_DEFAULT_SONNET_MODEL_NAME =', cfg.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME || '(无)', ')');
console.log('');

async function probe(label, url, payload, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, raw, json };
  } catch (e) {
    return { ok: false, status: e?.name === 'AbortError' ? 'TIMEOUT' : 'ERROR', ms: Date.now() - t0, raw: e?.message || String(e), json: null };
  } finally {
    clearTimeout(to);
  }
}

(async () => {
  // 1) 纯文本
  const r1 = await probe('纯文本', `${base}/v1/messages`, {
    model,
    max_tokens: 32,
    messages: [{ role: 'user', content: '只回复两个字:收到' }],
  }, 60_000);
  console.log('--- ① /v1/messages 纯文本 ---');
  console.log('  结果 =', r1.status, `(${r1.ms}ms)`);
  if (r1.json) console.log('  content =', String(JSON.stringify(r1.json.content) ?? '(无 content)').slice(0, 300));
  else console.log('  响应(截断 300) =', String(r1.raw).slice(0, 300));

  if (!r1.ok) {
    console.log('\n❌ 代理的 /v1/messages 不可用。本机 Claude Code 通路也走不通。');
    process.exit(1);
  }
  console.log('  ✅ 代理可用');

  // 2) 带 tools
  const r2 = await probe('tool_use', `${base}/v1/messages`, {
    model,
    max_tokens: 512,
    tools: [{
      name: 'Read',
      description: 'Read a file from the filesystem.',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    }],
    messages: [{ role: 'user', content: '请调用 Read 工具读取 /tmp/hello.txt,不要只回文字。' }],
  }, 90_000);
  console.log('\n--- ② /v1/messages 带 tools ---');
  console.log('  结果 =', r2.status, `(${r2.ms}ms)`);
  if (r2.json) {
    console.log('  stop_reason =', r2.json.stop_reason);
    console.log('  content =', String(JSON.stringify(r2.json.content) ?? '(无 content)').slice(0, 500));
    const hasToolUse = (r2.json.content || []).some(b => b && b.type === 'tool_use');
    console.log('\n=== 判定 ===');
    if (hasToolUse) {
      console.log('✅ 代理支持 tool_use → 本机 Claude Code 通路完整可用。');
      console.log('   M2 卡死的原因极可能是 coding-agent.ts 把 ANTHROPIC_BASE_URL 覆盖成了 lanfengai 直连。');
    } else {
      console.log('⚠️ 代理 200 但没发起 tool_use → 该模型(经代理映射后)不会调工具。');
    }
    process.exit(hasToolUse ? 0 : 2);
  } else {
    console.log('  响应(截断 400) =', String(r2.raw).slice(0, 400));
    console.log('\n❌ 带 tools 请求失败。');
    process.exit(1);
  }
})();
