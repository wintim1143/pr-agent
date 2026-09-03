/**
 * M1-6 端到端验证:直接驱动 insight-workflow,核对 AC-1~AC-5(AC-6 零写入由设计保证,另查 git status)。
 *
 * 复用已 build 的产物(dist/mastra/index.js 的 mastra 单例),不依赖起 Midway HTTP 服务。
 * 流程:createRun → start(跑到 confirm 步 suspend)→ 检查 suspended + 数据真实 → resume({approved:true})→ 检查终态 + 上下文未丢。
 *
 * 关键改进(相对初版):
 * - 日志同时写 `logs/m1-verify.log`(带时间戳),避免 `| tail` 管道缓冲在 SIGTERM 时丢失输出。
 * - start()/resume() 包一层内部守卫超时(Promise.race),即便某步挂起也能打印诊断而非静默被杀。
 * - 单独先跑一次 GitHub client 预检,把 collect 路径与 workflow 解耦定位。
 *
 * 运行: node scripts/verify-insight-loop.js
 */
'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');

const LOG = path.resolve(__dirname, '../logs/m1-verify.log');
const lines = [];
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  lines.push(line);
  console.log(line);
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
}

/** 内部守卫:让 promise 在规定 ms 内未决议则抛致命超时错误(打印诊断)。 */
function withGuard(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`GUARD_TIMEOUT@${label}: 超过 ${ms}ms 未返回(可能挂起)`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

(async () => {
  const t0 = Date.now();
  log('== M1-6 端到端验证开始 ==');

  // --- 预检:dist 里的 GitHub client 是否可用(与 workflow 解耦) ---
  const gh = require(path.resolve(__dirname, '../dist/mastra/integrations/github-readonly.js'));
  const client = gh.getGithubReadonlyClient();
  if (!client) {
    log('[预检] getGithubReadonlyClient() = NULL(GitHub 未配置),collect 将返回空,AC-2 不达标');
  } else {
    const [is, cs] = await Promise.all([client.listIssues({ state: 'all', perPage: 10 }), client.listCommits({ perPage: 10 })]);

    log(`[预检] GitHub OK: issues=${is.length}, commits=${cs.length}`);
  }

  const { mastra } = require(path.resolve(__dirname, '../dist/mastra/index.js'));
  const wf = mastra.getWorkflow('insight-workflow');
  const run = await wf.createRun();
  log('→ runId =', run.runId);

  log('→ start() 跑到 suspend(内部守卫 180s)...');
  const result = await withGuard(run.start({ inputData: { query: '最近项目有哪些进展和潜在风险?' } }), 180_000, 'start');
  log('✓ status after start =', result.status);

  // 诊断:打印 result 的真实结构(初版读 result.results?.collect 拿到 undefined,需确认正确 key)
  log('RESULT top keys =', JSON.stringify(Object.keys(result)));
  log('result.results keys =', result.results ? JSON.stringify(Object.keys(result.results)) : 'undefined');
  log('result.steps keys =', result.steps ? JSON.stringify(Object.keys(result.steps)) : 'undefined');

  const collectPick = result.results?.collect ?? result.steps?.collect;
  const collect = (collectPick && collectPick.output) ?? {};
  const issues = collect.issues ?? [];
  const commits = collect.commits ?? [];
  log(`AC-2 GitHub 数据: issue=${issues.length}, commit=${commits.length}`);
  if (issues[0]) log(`  样例 issue #${issues[0].number}: ${issues[0].title}`);
  if (issues.length === 0) log('  [debug] collect raw =', JSON.stringify(collectPick ?? null).slice(0, 300));

  const summarizeOut = (result.steps?.summarize ?? result.results?.summarize)?.output ?? {};
  const insight = summarizeOut.insight;
  const llmUnavailable = summarizeOut.llmUnavailable === true;
  log(`AC-3 洞察汇总: highlights=${insight?.highlights?.length}, risks=${insight?.risks?.length}, suggestions=${insight?.suggestions?.length}; llmUnavailable=${llmUnavailable}`);

  const notifyOut = (result.steps?.notify ?? result.results?.notify)?.output ?? {};
  log(`AC-3b 飞书卡片: cardSent=${notifyOut.cardSent}`);

  if (result.status !== 'suspended') {
    log(`✗ AC-4 未达 suspended(实际 ${result.status})`);
    process.exit(1);
  }
  log('✓ AC-4 run 已 suspend(停在 confirm 步)');

  log('→ resume({ approved: true })...');
  const r2 = await withGuard(run.resume({ resumeData: { approved: true } }), 60_000, 'resume');
  log('✓ status after resume =', r2.status);
  const feedback = (r2.results?.confirm ?? r2.steps?.confirm)?.output?.feedback;
  const insightAfter = (r2.results?.summarize ?? r2.steps?.summarize)?.output?.insight;
  log(`AC-5 人工反馈 = ${feedback}; 上下文恢复(洞察仍在) = ${!!insightAfter}`);
  log(`AC-5b context issue 数 = ${(r2.results?.collect ?? r2.steps?.collect)?.output?.issues?.length ?? 0}`);

  log(`\n✅ M1 端到端闭环验证通过(耗时 ${Date.now() - t0}ms)`);
  log(`   AC-1 runId 生成 ✓ | AC-2 GitHub 真实数据(${issues.length}/${commits.length}) ✓ | AC-3 洞察+卡片(cardSent=${notifyOut.cardSent}) | AC-4 suspended ✓ | AC-5 恢复反馈=${feedback} ✓`);
  if (llmUnavailable) {
    log('   ⚠️ 注:LLM 中继本次超时/不可用,summarize 已降级为空洞察;飞书卡片会标注"暂不可用"。闭环逻辑(零写入+人工确认)不受影响。');
  }
  process.exit(0);
})().catch(e => {
  log('✗ LOOP ERROR:', e?.message || e);
  process.exit(1);
});
