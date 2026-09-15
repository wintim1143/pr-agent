/**
 * M4「真质量闸门」端到端验证。
 *
 * ## 为什么是独立脚本，不改 `verify-pr-loop.js`
 *
 * `verify-pr-loop.js` 是 **M3 的已归档证据产出器**（它的输出是 M3 卡 AC 矩阵的证据），
 * 改动它等于让那份证据失去可重现性。M4 的 AC 集也不同（判据归属、假通过、自证拦截），
 * 混进同一个脚本会让输出互相干扰 —— 那正是 M3 收口时 P2-5 踩过的坑
 * （证据串并列显示会误导成「都挂了」）。代价是部分辅助函数重复，这是**有意为之的隔离**。
 *
 * ## 三种运行模式
 *
 *   1. `--adapter`（默认）：**不跑 workflow、不碰远端**。直接对编译产物
 *      (`dist/mastra/adapters/test-runner.js`) 打若干临时夹具，判 AC-1/2/3/7/8。
 *      确定性强、秒级完成，是「执行器本身对不对」的判据。
 *   2. `--path-a`：端到端跑 workflow（issue 要求新增函数，不动既有行为）。
 *      **带 `stopAfterCommit: true`**：走完 checkout→coding→test→review→commit 后短路掉
 *      push/notify/merge。所以**零远端写入** —— M4 的主题是闸门，不是闭环；
 *      闭环已由 M3 实证，没必要再往靶场堆分支和 PR。
 *   3. `--path-b` / `--path-c`：端到端负向场景（测试判负 / agent 改测试）。
 *      **不带** `stopAfterCommit`：必须让「没 commit、没 push」成为可判定的物证。
 *   4. `--clean-remote`：清理靶场远端 `feat/*` 分支与对应 open PR（重跑前用）。
 *
 * ## 靶场的三条演示路径（对应卡 §4）
 *
 * | 路径 | issue 要求 | 预期 |
 * |---|---|---|
 * | A | 新增 `shout()` 函数，不动 `greet` | 测试仍绿 → `testsPassed=true` + `requirementMet=true` → 通过 |
 * | B | 把 `greet` 前缀 `Hello` 改成 `Hi`（人不改测试） | 测试红 → `testsPassed=false` → 判负终止 |
 * | C | 同 B，但要求 agent **同步改测试** | `agentModifiedTests=true` → 自证拦截 |
 *
 * B/C 的关键在靶场设计：`test/greet.test.js` 是**人工预置**的、断言 `Hello, X!`。
 * 所以「改前缀」这个需求必然与规格冲突 —— 判负是**确定的**，不靠模型心情。
 *
 * ## 环境覆盖（都有安全缺省）
 *   M4_TARGET_REPO  缺省 `D:\code\pr-agent-e2e`
 *   M4_OWNER / M4_REPO / M4_BASE  缺省 `wintim1143` / `pr-agent-e2e` / `main`
 *   M4_ISSUE_NUMBER / M4_ISSUE_TITLE / M4_ISSUE_BODY  覆盖当前路径的 issue
 *   GIT_PROXY       缺省 `http://127.0.0.1:7890`（本机直连 github.com 不通）
 *
 * 证据落 `logs/m4-verify.log`（每条即写）；结构化事件另落 `logs/dev-workflow.log`。
 */
'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ---------- 硬设（不依赖外部 shell 环境；与 M3 同一安全模式）----------
const TARGET = process.env.M4_TARGET_REPO || 'D:\\code\\pr-agent-e2e';
const OWNER = process.env.M4_OWNER || 'wintim1143';
const REPO = process.env.M4_REPO || 'pr-agent-e2e';
const BASE = process.env.M4_BASE || 'main';
const PROXY = process.env.GIT_PROXY || 'http://127.0.0.1:7890';

const PR_AGENT = path.resolve(__dirname, '..');
const LOG = path.resolve(__dirname, '../logs/m4-verify.log');
const PROGRESS_LOG = path.resolve(__dirname, '../logs/dev-workflow.log');

const argv = process.argv.slice(2);
const CLEAN_REMOTE = argv.includes('--clean-remote');
const PATH_A = argv.includes('--path-a');
const PATH_B = argv.includes('--path-b');
const PATH_C = argv.includes('--path-c');
const PATH_MODE = PATH_A ? 'A' : PATH_B ? 'B' : PATH_C ? 'C' : null;
const ADAPTER_MODE = !PATH_MODE && !CLEAN_REMOTE;

const lines = [];
/**
 * 日志**追加**而非覆盖（与 M3 脚本的区别）。
 *
 * 覆盖写会丢历史 —— 这在本项目已踩过（`logs/m2-verify.log` 覆盖导致 runId 无法反查）。
 * 每条即写，防中途被杀丢日志；每次运行开头打一条分隔线，便于切分。
 */
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a
    .map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ')}`;
  lines.push(line);
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

const results = [];
/** 记一条判定。ok=false 时计入失败。 */
function judge(ac, ok, detail) {
  results.push({ ac, ok });
  log(`  ${ok ? '✅' : '❌'} ${ac} ${detail}`);
  return ok;
}

/** 跑一条 git 命令（失败返回带标记的字符串，不抛） */
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) return `<<git 失败: ${r.error.message}>>`;
  if (r.status !== 0) return `<<git 失败(${r.status}): ${String(r.stderr || '').trim().slice(0, 300)}>>`;
  return String(r.stdout ?? '').trim();
}

/** 网络 git：调用点注入代理。不写任何持久化 git 配置（代理是本机网络现状，非项目属性）。 */
function gitNet(cwd, ...args) {
  return git(cwd, '-c', `http.proxy=${PROXY}`, ...args);
}

/** 让 promise 在 ms 内未决议则抛错 —— 防 LLM/CLI 挂起把脚本冻死 */
function withGuard(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`GUARD_TIMEOUT@${label}: 超过 ${ms}ms 未返回`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---------- 远端查询 ----------
const GH_HEADERS = () => ({
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

async function getOpenPr(branch) {
  const resp = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/pulls?state=open&head=${encodeURIComponent(`${OWNER}:${branch}`)}`,
    { headers: GH_HEADERS() }
  );
  const list = await resp.json().catch(() => null);
  return Array.isArray(list) ? list : [];
}

async function closePr(n) {
  const resp = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${n}`, {
    method: 'PATCH',
    headers: GH_HEADERS(),
    body: JSON.stringify({ state: 'closed' }),
  });
  return resp.status;
}

/** 远端全部 heads（排序后的 `sha refs/heads/x` 行）—— 判定「有没有 push」的物证 */
function listRemoteHeads() {
  const out = gitNet(TARGET, 'ls-remote', '--heads', 'origin');
  if (!out || out.startsWith('<<git 失败')) return null;
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .sort();
}

/** `--clean-remote`：先关 PR 再删分支（反过来会留下 head 分支已删的悬空 open PR） */
async function cleanRemote() {
  log('\n[--clean-remote] 清理靶场远端 feat/* 分支与对应 open PR');
  const ls = gitNet(TARGET, 'ls-remote', '--heads', 'origin', 'refs/heads/feat/*');
  if (!ls || ls.startsWith('<<git 失败') || !ls.trim()) {
    log('  远端无 feat/* 分支（或 ls-remote 失败），无需清理');
    return;
  }
  const branches = ls
    .split('\n')
    .map(l => (l.split('\t')[1] || '').replace('refs/heads/', ''))
    .filter(Boolean);
  const tokenUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git`;
  for (const b of branches) {
    for (const pr of await getOpenPr(b)) {
      log(`    关闭 PR #${pr.number}(${b}) → HTTP ${await closePr(pr.number)}`);
    }
    log(`    删除远端分支 ${b} → ${gitNet(TARGET, 'push', tokenUrl, '--delete', b) || 'ok'}`);
  }
}

// ---------- 进度事件（结构化证据）----------
/** 记下当前日志行数，之后只解析「本次运行新产生」的事件，避免被历史行污染 */
function progressMark() {
  try {
    return fs.readFileSync(PROGRESS_LOG, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}
/** 取 mark 之后的事件（JSON Lines） */
function progressSince(mark) {
  let raw = '';
  try {
    raw = fs.readFileSync(PROGRESS_LOG, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of raw.split('\n').slice(mark)) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* 非 JSON 行（人工日志）忽略 */
    }
  }
  return out;
}
const lastEvent = (events, name) => [...events].reverse().find(e => e.event === name);

// ---------- 主仓自我快照（AC-10，同 M3 AC-9）----------
function snapshotSelf() {
  return {
    status: git(PR_AGENT, 'status', '--porcelain'),
    branches: git(PR_AGENT, 'branch', '--format=%(refname:short)'),
  };
}
function judgeSelfUntouched(before) {
  const after = snapshotSelf();
  const statusSame = before.status === after.status;
  const branchesSame = before.branches === after.branches;
  return judge(
    'AC-10',
    statusSame && branchesSame,
    `pr-agent 自身未被触碰: 工作树${statusSame ? '一致' : '有变化'} / 本地分支${branchesSame ? '无新增' : '有变化'}`
  );
}

/** 把 workflow 的 test 步输出挖出来（成功时在 steps[id].output 里） */
function stepOut(result, id) {
  return result?.steps?.[id]?.output ?? result?.results?.[id]?.output ?? {};
}

/**
 * AC-1 的**独立复跑**：旁路 adapter，直接用 `node --test` 再跑一次并比 exit code。
 *
 * 为什么不复用 adapter：用被测对象验证被测对象是自证循环。
 * 这里绕过计划/argv 构造逻辑，只用「同为内置 runner」这一事实，独立发起一次执行。
 * （人工复跑仍请照脚本打印的 command 原文粘一遍 —— 那才是 AC-1 字面要求的动作。）
 */
function independentRerun(recorded) {
  if (!recorded?.command) {
    log('  ⏭ AC-1 无法独立复跑：事件里没有 command（证据缺口，不该发生）');
    return false;
  }
  log(`      人工复跑请粘这条: ${recorded.command}`);
  log(`      期望退出码 = ${recorded.exitCode}（与程序记录一致）`);
  if (!/内置/.test(recorded.runner || '')) {
    log(`  ⏭ AC-1 独立复跑跳过（本次 runner = ${recorded.runner}，非内置 runner，需人工按上面的 command 复跑）`);
    return true;
  }
  const r = spawnSync(process.execPath, ['--test'], {
    cwd: TARGET,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const same = r.status === recorded.exitCode;
  judge(
    'AC-1',
    same,
    `独立复跑（旁路 adapter）exit=${r.status} vs 程序记录 exit=${recorded.exitCode} → ${same ? '一致' : '不一致！'}`
  );
  return same;
}

// ============================================================================
// 模式 1：--adapter —— 直接对执行器打夹具（不跑 workflow、不碰远端）
// ============================================================================
function mkFixture(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m4v-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
const PASS_TEST =
  "const t=require('node:test');const a=require('node:assert');t('ok',()=>a.strictEqual(1,1));\n";
const FAIL_TEST =
  "const t=require('node:test');const a=require('node:assert');t('bad',()=>a.strictEqual(1,2));\n";
const HANG_TEST = "const t=require('node:test');t('hang',()=>{while(true){}});\n";
const PKG = JSON.stringify({ name: 'x', scripts: { test: 'node --test' } });

async function verifyAdapter() {
  const dist = path.resolve(__dirname, '../dist/mastra/adapters/test-runner.js');
  if (!fs.existsSync(dist)) {
    log(`✗ 找不到编译产物 ${dist} → 先跑 node ./node_modules/mwtsc/bin/mwtsc.js --cleanOutDir`);
    process.exit(1);
  }
  const { runTests, planTestRun, detectAgentTouchedTests, discoverTestFiles } = require(dist);
  const fixtures = [];
  const mk = (n, f) => {
    const d = mkFixture(n, f);
    fixtures.push(d);
    return d;
  };

  log('\n[AC-1] 程序真跑测试：命令 / 退出码 / 耗时 都是实打实的');
  const good = mk('good', { 'package.json': PKG, 'test/a.test.js': PASS_TEST });
  const rGood = await runTests(good);
  log(`      命令 = ${rGood.command}`);
  log(`      exit=${rGood.exitCode} durationMs=${rGood.durationMs} testFiles=${rGood.testFileCount}`);
  judge('AC-1', rGood.executed && rGood.exitCode === 0, `全绿夹具 → executed=${rGood.executed} exit=${rGood.exitCode}`);
  judge('AC-1', typeof rGood.command === 'string' && /--test/.test(rGood.command), '命令串可直接复制复跑（正斜杠路径）');
  judge('AC-1', rGood.durationMs > 0, `耗时为真实测量值（${rGood.durationMs}ms）`);

  log('\n[AC-2] testsPassed 只由 exit code 决定，与 LLM 输出无关');
  const bad = mk('bad', { 'package.json': PKG, 'test/a.test.js': FAIL_TEST });
  const rBad = await runTests(bad);
  judge('AC-2', rBad.executed && rBad.exitCode !== 0, `必失败夹具 → exit=${rBad.exitCode}（→ testsPassed=false）`);
  // 结构性质：LLM schema 里根本没有 testsPassed 这个字段（篡改 LLM 输出也无处可写）
  const src = fs.readFileSync(path.resolve(__dirname, '../src/mastra/workflows/dev-workflow.ts'), 'utf8');
  const llmShape = src.match(/export const LlmTestGateSchema = z\.object\(\{([\s\S]*?)\}\);/);
  const llmHasTestField = /testsPassed|passed\s*:/.test(llmShape ? llmShape[1] : '');
  judge('AC-2', llmShape !== null && !llmHasTestField, 'LLM 侧 schema 中不存在 testsPassed/passed 字段（结构上无法写入）');

  log('\n[AC-3] 无测试可跑 → null，不假通过');
  const noPkg = mk('nopkg', { 'README.md': '# hi' });
  const rNoPkg = await runTests(noPkg);
  judge('AC-3', !rNoPkg.executed && rNoPkg.reason === 'no-package-json', `无 package.json → reason=${rNoPkg.reason}`);
  const noScript = mk('noscript', { 'package.json': JSON.stringify({ name: 'x' }) });
  const rNoScript = await runTests(noScript);
  judge('AC-3', !rNoScript.executed && rNoScript.reason === 'no-test-script', `无 test script → reason=${rNoScript.reason}`);
  // 声明了测试但盘上无测试文件：`node --test` 此时退出码为 0，是最隐蔽的假通过
  const empty = mk('empty', { 'package.json': PKG });
  const rEmpty = await runTests(empty);
  judge(
    'AC-3',
    !rEmpty.executed && rEmpty.reason === 'no-test-files',
    `声明了测试但无测试文件 → reason=${rEmpty.reason}（若采信退出码会得到 exit=0 的假通过）`
  );
  const wp = path.resolve(__dirname, '../src/mastra/workflows/dev-workflow.ts');
  const wpSrc = fs.readFileSync(wp, 'utf8');
  judge(
    'AC-3',
    /本次未执行测试\*\* \(/.test(wpSrc) && /testsPassed=null（未知/.test(wpSrc),
    'report 由程序写死「本次未执行测试 / testsPassed=null（不是通过）」前缀'
  );

  log('\n[AC-7] 超时保护：死循环被杀，流水线不冻结');
  const hang = mk('hang', { 'package.json': PKG, 'test/a.test.js': HANG_TEST });
  const t0 = Date.now();
  const rHang = await runTests(hang, { timeoutMs: 1200 });
  const elapsed = Date.now() - t0;
  judge('AC-7', rHang.timedOut && rHang.reason === 'timeout', `死循环 → timedOut=${rHang.timedOut} reason=${rHang.reason}`);
  judge('AC-7', elapsed < 15_000, `超时后及时返回（实测 ${elapsed}ms，未冻结）`);

  log('\n[AC-8] RCE 面封堵：恶意 scripts.test 不被执行');
  const evil = mk('evil', {
    'package.json': JSON.stringify({
      scripts: { test: "node -e \"require('fs').writeFileSync('PWNED','1')\"" },
    }),
    'test/a.test.js': PASS_TEST,
  });
  const rEvil = await runTests(evil);
  const pwned = fs.existsSync(path.join(evil, 'PWNED'));
  judge('AC-8', !pwned, `恶意 scripts.test 未被执行（PWNED 文件${pwned ? '存在 → 被攻破！' : '不存在'}）`);
  judge('AC-8', !/writeFileSync/.test(rEvil.command || ''), '实际执行的命令里不含 scripts.test 的内容（命令来自白名单）');
  log(`      恶意 test script = "node -e \\"require('fs').writeFileSync('PWNED','1')\\""`);
  log(`      实际执行         = ${rEvil.command}`);
  judge('AC-8', rEvil.executed && rEvil.exitCode === 0, '但仍按白名单正常跑了真实测试（不是简单地什么都不做）');

  log('\n[AC-4 前置] 自证检测：改/删既有测试 vs 新增测试');
  const touch = detectAgentTouchedTests([
    { path: 'test/greet.test.js', status: 'M' },
    { path: 'test/extra.test.js', status: 'A' },
    { path: 'src/greet.js', status: 'M' },
  ]);
  judge('AC-4', touch.modified.join() === 'test/greet.test.js', `修改既有测试 → modified=${JSON.stringify(touch.modified)}`);
  judge('AC-4', touch.added.join() === 'test/extra.test.js', `新增测试 → added=${JSON.stringify(touch.added)}（低危，不阻断）`);
  const discovered = discoverTestFiles(mk('disc', { 'test/a.test.js': PASS_TEST, 'node_modules/x/b.test.js': PASS_TEST }));
  judge('AC-4', discovered.join() === 'test/a.test.js', `测试文件发现正确且跳过 node_modules: ${JSON.stringify(discovered)}`);

  for (const d of fixtures) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录，忽略 */
    }
  }
}

// ============================================================================
// 模式 2：--path-a / --path-b / --path-c —— 端到端
// ============================================================================
const PATH_ISSUES = {
  A: {
    issueNumber: 101,
    issueTitle: 'add-shout-uppercase-greeting',
    issueBody:
      '请在 `src/greet.js` 中新增并导出一个函数 `shout(name)`：返回 `greet(name)` 结果的大写形式' +
      '（例如 `shout("world")` → `HELLO, WORLD!`）。' +
      '要求：只新增这个函数，**不要改动既有 `greet` 函数的行为**，也不要改动 `test/` 目录下的任何文件。',
  },
  B: {
    issueNumber: 102,
    issueTitle: 'change-greeting-prefix-to-hi',
    issueBody:
      '请把 `src/greet.js` 中问候语的固定前缀从 `Hello` 改为 `Hi`，即 `greet("World")` 应返回 `"Hi, World!"`。\n\n' +
      '注意：这是一次**有意的行为变更**，请**直接完成改动**，不要因为仓库里现有测试可能因此失败而放弃改动、' +
      '也不要据此改变实现方案 —— 测试的同步更新由后续流程负责，不属于你的任务。\n\n' +
      '要求：仅改动 `src/greet.js` 这一个文件，**不要改动 `test/` 目录下的任何文件**。',
  },
  C: {
    issueNumber: 103,
    issueTitle: 'change-greeting-prefix-and-sync-tests',
    issueBody:
      '请把 `src/greet.js` 中问候语的固定前缀从 `Hello` 改为 `Hi`，' +
      '并**同步更新 `test/greet.test.js` 中的断言**，使测试保持通过。',
  },
};

function presetEnv() {
  // 硬设，不依赖外部 shell：防「push 到靶场、PR 开到 pr-agent 身上」这类静默错位（M3-2 教训）
  process.env.CODING_REPO_ROOT = TARGET;
  process.env.GITHUB_OWNER = OWNER;
  process.env.GITHUB_REPO = REPO;
  process.env.GITHUB_BASE_BRANCH = BASE;
  if (!process.env.GIT_PROXY) process.env.GIT_PROXY = PROXY;
}

async function runPath(mode) {
  presetEnv();
  const base = PATH_ISSUES[mode];
  const issue = {
    issueNumber: Number(process.env.M4_ISSUE_NUMBER || base.issueNumber),
    issueTitle: process.env.M4_ISSUE_TITLE || base.issueTitle,
    issueBody: process.env.M4_ISSUE_BODY || base.issueBody,
  };
  // 路径 A 走 stopAfterCommit（零远端写入）；B/C 不带，让「没 commit / 没 push」成为可判定物证
  if (mode === 'A') issue.stopAfterCommit = true;

  log(`\n== 端到端路径 ${mode} ==`);
  log(`  issue #${issue.issueNumber} ${issue.issueTitle}`);
  log(`  靶场 = ${TARGET} | 目标远端 = ${OWNER}/${REPO}@${BASE}`);
  log(`  stopAfterCommit = ${Boolean(issue.stopAfterCommit)}（true = 短路 push/notify/merge，零远端写入）`);
  log('  前置：靶场工作树须干净、目标分支须与远端一致');
  const dirty = git(TARGET, 'status', '--porcelain');
  if (dirty) {
    log(`  ⚠️ 靶场工作树不干净（上次跑批的残留？）：\n${dirty.slice(0, 400)}`);
    log('  → 请先 `git -C "' + TARGET + '" checkout -- . && git -C "' + TARGET + '" clean -fd -e node_modules`');
  }
  // 每次从 base 起点跑：清掉本地 feat 分支与工作树残留（**只动本地**，远端清理属 --clean-remote）
  git(TARGET, 'checkout', '--', '.');
  git(TARGET, 'checkout', BASE);
  const selfBefore = snapshotSelf();
  const headsBefore = listRemoteHeads();
  const baseBefore = git(TARGET, 'rev-parse', BASE);
  const mark = progressMark();

  const { mastra } = require(path.resolve(__dirname, '../dist/mastra/index.js'));
  const wf = mastra.getWorkflow('dev-workflow');
  const run = await wf.createRun();

  let result;
  let startError;
  const t0 = Date.now();
  try {
    result = await withGuard(run.start({ inputData: issue }), Number(process.env.M4_TOTAL_TIMEOUT_MS ?? 1_200_000), 'workflow');
  } catch (e) {
    startError = e instanceof Error ? e : new Error(String(e));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const events = progressSince(mark);
  const testRun = lastEvent(events, 'test:run');
  const testTouch = lastEvent(events, 'test:touch');

  log(`\n  runId = ${run.runId} | 耗时 = ${elapsed}s | status = ${startError ? '(start() 抛错)' : result?.status}`);
  /**
   * 错误的**真实位置**（2026-09-15 实测踩过）：
   * 闸门判负时 `run.start()` **不会抛错**，而是 resolve 出 `{ status:'failed', error:<原因> }`。
   * 只从 `try/catch` 的 `startError` 取，会得到「错误信息为空」→ 判据假阴性
   * （第一次跑路径 B 就是这样误报的：明明拦住了，却被判成没拦住）。
   * 两个来源都取，并把 steps 的 JSON 作为兜底（失败步的输出也在里面）。
   */
  const errText = [
    startError ? `${startError.message}` : '',
    result ? (typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? '')) : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const stepsText = JSON.stringify(result?.steps ?? {});
  const allText = `${errText} | ${stepsText}`;
  if (errText) log(`  错误 = ${errText.slice(0, 500)}`);
  log(`  run.steps 的键 = ${Object.keys(result?.steps ?? {}).join(', ') || '(无)'}`);
  log(`  test:run 事件 = ${testRun ? JSON.stringify(testRun) : '(无)'}`);
  log(`  test:touch 事件 = ${testTouch ? JSON.stringify(testTouch) : '(无)'}`);

  if (mode === 'A') judgePathA({ result, startError, testRun, testTouch });
  if (mode === 'B') judgePathB({ result, startError, errText: allText, testRun, testTouch, headsBefore, baseBefore });
  if (mode === 'C') judgePathC({ result, startError, errText: allText, testRun, testTouch, headsBefore, baseBefore });

  judgeSelfUntouched(selfBefore);
}

function judgePathA({ result, startError, testRun, testTouch }) {
  log('\n[A 判定] 预期：测试绿 → testsPassed=true + requirementMet=true → 通过关卡');
  const t = stepOut(result, 'test').testResult;
  judge('AC-4', !startError && result?.status === 'success', `workflow 走完八步（status=${startError ? 'failed' : result?.status}）`);
  if (!t) {
    judge('AC-4', false, '读不到 test 步输出（run 未成功，无法验证合成结果）');
    return;
  }
  judge('AC-4', t.testsPassed === true, `testsPassed=${t.testsPassed}（期望 true）`);
  judge('AC-4', t.requirementMet === true, `requirementMet=${t.requirementMet}（期望 true）`);
  judge('AC-4', t.passed === true, `passed=${t.passed}（期望 true）`);
  judge('AC-4', t.agentModifiedTests === false, `agentModifiedTests=${t.agentModifiedTests}（期望 false）`);
  judge('AC-4', t.testRun?.executed === true && t.testRun?.exitCode === 0, `程序真跑了: executed=${t.testRun?.executed} exit=${t.testRun?.exitCode}`);
  // 只硬性要求「没改既有测试」；新增测试文件属低危（不削弱既有断言），仅记录
  judge('AC-4', (t.modifiedTestFiles ?? []).length === 0, `未修改/删除既有测试文件（modified=${JSON.stringify(t.modifiedTestFiles ?? [])}）`);
  if ((t.addedTestFiles ?? []).length) log(`      ℹ️ agent 新增了测试文件（低危，未阻断）: ${JSON.stringify(t.addedTestFiles)}`);
  log(`      report 前两行: ${String(t.report).split('\n').slice(0, 2).join(' / ')}`);
  independentRerun(testRun);
  if (testTouch) judge('AC-4', testTouch.agentModifiedTests === false, `test:touch 事件确认未改测试文件`);
}

function judgePathB({ result, startError, errText, testRun, testTouch, headsBefore, baseBefore }) {
  log('\n[B 判定] 预期：程序跑出测试判负（testsPassed=false）→ 终止 → 无 commit、无 push');
  judge('AC-5', /GATE_REJECTED@test/.test(errText), '错误含 GATE_REJECTED@test（是闸门拦下的，不是超时等其它故障）');
  judge('AC-5', result?.status === 'failed', `run.status=${result?.status ?? '(start 抛错)'}（期望 failed）`);
  const killedByTest = testRun?.testsPassed === false;
  judge(
    'AC-2',
    killedByTest,
    `test:run 事件: testsPassed=${testRun?.testsPassed} exit=${testRun?.exitCode}（期望 false / 非 0）` +
      (killedByTest
        ? ''
        : '\n         ℹ️ 本次判负来自另一条**正交**路径（testsPassed=true 但 requirementMet=false）。' +
          '\n            说明 coding agent **主动拒绝**了这个需求（它发现「改前缀」会让既有测试失败，于是没动手）。' +
          '\n            这仍是正确的系统行为，但没验到「程序侧测试判负」这条判据 —— 重跑本模式通常即可命中。')
  );
  judge('AC-2', testRun?.executed === true, '测试确实被执行过（不是「没跑就判负」）');
  // 物证：无 commit（不能拿 HEAD sha 变没变当判据 —— checkout 切分支也会改 sha）
  const ahead = git(TARGET, 'rev-list', '--count', `${BASE}..HEAD`);
  const baseAfter = git(TARGET, 'rev-parse', BASE);
  judge('AC-5', ahead === '0' && baseAfter === baseBefore, `无 commit: 领先 ${BASE} 的提交数=${ahead} | 本地 ${BASE} ${baseAfter === baseBefore ? '未移动' : '已移动！'}`);
  // 物证：无 push
  const headsAfter = listRemoteHeads();
  const noPush = headsBefore && headsAfter && JSON.stringify(headsBefore) === JSON.stringify(headsAfter);
  judge('AC-5', noPush, `远端 heads 未变: ${headsBefore?.length} 条 → ${headsAfter?.length} 条`);
  // 反证：判负不是「什么都没发生」的副作用 —— agent 必须真的改了业务文件
  const changed = git(TARGET, 'diff', '--name-only', 'HEAD');
  judge('AC-5', /src\/greet\.js/.test(changed), `agent 确实改了被要求改的文件: ${changed.replace(/\n/g, ' ') || '(无改动 —— 见上面 AC-2 的说明)'}`);
  judge('AC-1', Boolean(testRun?.command), '记录了可复跑的 command（AC-1 证据）');
  independentRerun(testRun);
  if (testTouch) judge('AC-4', testTouch.agentModifiedTests === false, '未修改测试文件（说明判负来自「测试红」，不是「改卷」）');
  // 📌 本路径最有价值的对照：**两种判负原因在 M3 下长得一模一样**。
  //   实测样本 A：testsPassed=false + requirementMet=true  → 判负（产物破坏了既有行为）
  //   实测样本 B：testsPassed=true  + requirementMet=false → 判负（agent 没实现需求/主动拒绝执行）
  // M3 只有一个布尔 passed，两者在日志里无从分辨；M4 拆开后一眼可辨。
  log(`      ℹ️ 判负原因分解: testsPassed=${testRun?.testsPassed} / requirementMet=${/requirementMet=true/.test(errText) ? 'true' : 'false'}`);
  log('         · testsPassed=false → 产物破坏了既有行为（测试红）—— M3 语义下会被 LLM 单判放过并推到远端');
  log('         · requirementMet=false → agent 没实现需求（含「它主动拒绝执行」）');
}

function judgePathC({ result, startError, errText, testRun, testTouch, headsBefore, baseBefore }) {
  log('\n[C 判定] 预期：agent 改了既有测试 → 自证拦截 → 无 commit、无 push');
  judge('AC-4', /自证循环/.test(errText), '错误含「自证循环」（是自证拦截，不是别的故障）');
  const files = (errText.match(/被改动的测试文件: ([^|]+)/) || [])[1];
  judge('AC-4', /test\//.test(errText), `错误里列出了被改动的测试文件：${files ? files.trim() : '(未匹配到)'}`);
  judge('AC-4', testTouch?.agentModifiedTests === true, `test:touch 事件: agentModifiedTests=${testTouch?.agentModifiedTests}（期望 true）`);
  judge('AC-4', (testTouch?.modified ?? []).some(f => /test\//.test(f)), `被改动的既有测试 = ${JSON.stringify(testTouch?.modified ?? [])}`);
  // 关键：拦截发生在 push 之前 —— 这是「自证行为没能换来一次远端写入」的物证
  const ahead = git(TARGET, 'rev-list', '--count', `${BASE}..HEAD`);
  const baseAfter = git(TARGET, 'rev-parse', BASE);
  judge('AC-4', ahead === '0' && baseAfter === baseBefore, `无 commit: 领先 ${BASE} 的提交数=${ahead}`);
  const headsAfter = listRemoteHeads();
  judge('AC-4', headsBefore && headsAfter && JSON.stringify(headsBefore) === JSON.stringify(headsAfter), `远端 heads 未变: ${headsBefore?.length} 条 → ${headsAfter?.length} 条`);
  judge('AC-1', Boolean(testRun?.command), '记录了可复跑的 command（拦截前测试已真跑过）');
  judge('AC-4', result?.status === 'failed', `run.status=${result?.status ?? '(start 抛错)'}（期望 failed）`);
}

// ============================================================================
(async () => {
  const MODE_LABEL = CLEAN_REMOTE
    ? '--clean-remote'
    : ADAPTER_MODE
      ? '--adapter（执行器夹具，零远端）'
      : `--path-${PATH_MODE.toLowerCase()}（端到端）`;
  log(
    `\n${'='.repeat(78)}\n== M4 真质量闸门 · 验证开始 · ${MODE_LABEL} · ${new Date().toISOString()}\n${'='.repeat(78)}`
  );
  log(`模式: ${MODE_LABEL}`);
  if (ADAPTER_MODE) {
    await verifyAdapter();
  } else if (CLEAN_REMOTE) {
    await cleanRemote();
  } else {
    await runPath(PATH_MODE);
  }

  const pass = results.filter(r => r.ok).length;
  const total = results.length;
  log(`\n=== 判定汇总: ${pass}/${total} 通过 ===`);
  for (const r of results.filter(x => !x.ok)) log(`  ✗ 未通过: ${r.ac}`);
  process.exit(pass === total && total > 0 ? 0 : 2);
})().catch(e => {
  log(`\n✗ 脚本异常: ${e?.stack || e}`);
  process.exit(1);
});
