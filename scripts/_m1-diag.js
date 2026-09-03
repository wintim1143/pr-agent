'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');

const LOG = path.resolve(__dirname, '../logs/m1-diag.log');
const out = [];
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  out.push(line);
  console.log(line);
  fs.writeFileSync(LOG, out.join('\n') + '\n');
}

(async () => {
  log('== 1) GitHub readonly client in dist context ==');
  const gh = require(path.resolve(__dirname, '../dist/mastra/integrations/github-readonly.js'));
  const client = gh.getGithubReadonlyClient();
  log('getGithubReadonlyClient() =>', client ? 'NON-NULL' : 'NULL');
  if (client) {
    const t = Date.now();
    const [issues, commits] = await Promise.all([
      client.listIssues({ state: 'all', perPage: 10 }),
      client.listCommits({ perPage: 10 }),
    ]);
    log(`GitHub OK in ${Date.now() - t}ms: issues=${issues.length}, commits=${commits.length}`);
    if (issues[0]) log('  sample issue:', `#${issues[0].number}`, issues[0].title);
  }

  log('== 2) Feishu domain reachability (12s abort) ==');
  const feishuUrl = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const t2 = Date.now();
  try {
    const resp = await fetch(feishuUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = await resp.json().catch(() => null);
    log(`Feishu responded in ${Date.now() - t2}ms: status=${resp.status} code=${j?.code} msg=${j?.msg}`);
  } catch (e) {
    clearTimeout(timer);
    log(`Feishu FAILED in ${Date.now() - t2}ms: ${e.name === 'AbortError' ? 'ABORT/HANG (no response within 12s)' : e.message}`);
  }

  log('== 3) LLM relay reachability (single generate, 60s abort) ==');
  const { mastra } = require(path.resolve(__dirname, '../dist/mastra/index.js'));
  const agent = mastra.getAgent('insight-agent');
  const c3 = new AbortController();
  const timer3 = setTimeout(() => c3.abort(), 60000);
  const t3 = Date.now();
  try {
    // agent.generate does not accept AbortSignal easily; wrap with Promise.race
    const res = await Promise.race([
      agent.generate('用一句话介绍 Apache Doris 是什么。'),
      new Promise((_, rej) => c3.signal.addEventListener('abort', () => rej(new Error('LLM_ABORT_60s')))),
    ]);
    clearTimeout(timer3);
    log(`LLM OK in ${Date.now() - t3}ms: text=${((res.text || '').slice(0, 80))}`);
  } catch (e) {
    clearTimeout(timer3);
    log(`LLM FAILED in ${Date.now() - t3}ms: ${e.message}`);
  }

  log('== diag done ==');
  process.exit(0);
})().catch(e => {
  log('DIAG ERROR:', e?.message || e);
  process.exit(1);
});
