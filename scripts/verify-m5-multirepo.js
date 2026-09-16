/**
 * M5 验收脚本：多仓库（M5b）与入口幂等（M5a）。
 *
 * ## 为什么是**独立脚本**而不是改 M3/M4 的验证器
 *
 * `verify-pr-loop.js` / `verify-m4-gate.js` 是**已归档的证据产出器** ——
 * 改动它们会让当时那份证据失去可重现性。M5 自己一份。
 *
 * ## 模式
 *
 * | 模式 | 耗时 | 覆盖 | 是否碰远端 / LLM |
 * |---|---|---|---|
 * | `--contract` | 秒级 | AC-5 / AC-7 / AC-10 + 跑 M4 的 `--adapter` 作 AC-6 回归 | 否 |
 * | `--dedup` | 秒级 | AC-1 / AC-2 / AC-3（**跨进程**） | 否 |
 * | `--serial` | 秒级 | AC-8（跨进程串行 + **无锁对照组**） | 否 |
 * | `--multi` | 分钟级 | AC-4 / AC-9 / AC-11（真 LLM + 真 push + 真 PR） | 是 |
 * | `--clean-remote` | 秒级 | 清理 `feat/*` 与对应 open PR | 是 |
 *
 * ## 三个刻意的设计选择
 *
 * 1. **AC-2 / AC-3 必须跨进程验**：进程内的 `Promise.all` 只能证明「同一个连接上的两个
 *    await 不会都成功」，证明不了「两个独立进程不会都认领」。这里用**子进程**跑同一段代码
 *    （M3-5 的方法学：同进程验 resume 等于没验持久化）。
 * 2. **AC-8 带无锁对照组**：只断言「加了锁之后不串台」没有说服力 —— 若两个临界区本来就
 *    错不开，任何实现都能通过。所以先跑一遍**不加锁**的同构场景，把「commit 落到别人分支」
 *    这个静默损坏现场拍出来，再证明加了锁就不发生。
 * 3. **不设单仓库 env**：`--multi` 刻意**不**设置 `CODING_REPO_ROOT` / `GITHUB_OWNER` /
 *    `GITHUB_REPO` / `GITHUB_BASE_BRANCH`。多仓库模式只该依赖 `GITHUB_TOKEN` +
 *    仓库注册表；如果还得靠那四个 env 才跑得动，就说明「去全局化」没做成。
 *
 * ## 环境变量（都有缺省，不看 shell）
 *
 *   REPO_REGISTRY_PATH  缺省 `<pr-agent>/repos.registry.json`
 *   M5_TARGET_A_KEY     缺省 `wintim1143/pr-agent-e2e`（真实远端，会真开 PR）
 *   M5_TARGET_B_KEY     缺省 `local/pr-agent-e2e-b`（本地仓库，走 stopAfterCommit）
 *   M5_A_LOCAL / M5_B_LOCAL / M5_A_BASE / M5_B_BASE  覆盖注册表里的路径与基线
 *   M5_ISSUE_A_NUMBER/_TITLE/_BODY  覆盖 A 的 issue
 *   GIT_PROXY           缺省 `http://127.0.0.1:7890`（本机直连 github.com 不通）
 *   M5_TOTAL_TIMEOUT_MS 单次 run 的兜底超时，缺省 1200000
 *
 * 证据追加写 `logs/m5-verify.log`（覆写丢过证据，本项目已踩）；结构化事件另落
 * `logs/dev-workflow.log`。
 */
'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const PR_AGENT = path.resolve(__dirname, '..');
const LOG = path.resolve(PR_AGENT, 'logs/m5-verify.log');
const PROGRESS_LOG = path.resolve(PR_AGENT, 'logs/dev-workflow.log');
const PROXY = process.env.GIT_PROXY || 'http://127.0.0.1:7890';

const KEY_A = process.env.M5_TARGET_A_KEY || 'wintim1143/pr-agent-e2e';
const KEY_B = process.env.M5_TARGET_B_KEY || 'local/pr-agent-e2e-b';
const [OWNER_A, REPO_A] = KEY_A.split('/');

const argv = process.argv.slice(2);
const MODE = ['contract', 'dedup', 'serial', 'multi', 'clean-remote'].find(m => argv.includes(`--${m}`)) || 'contract';
/** 子进程模式：本脚本会被自己拉起来做跨进程判定，用 `--child-*` 区分。 */
const CHILD = argv.find(a => a.startsWith('--child-'));

// ============================================================================
// 日志与判定
// ============================================================================
const results = [];
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a
    .map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* 日志失败不该拖垮验收 */
  }
}
function judge(ac, ok, detail) {
  results.push({ ac, ok });
  log(`  ${ok ? '✅' : '❌'} ${ac} ${detail}`);
  return ok;
}
function summary() {
  const fail = results.filter(r => !r.ok);
  log(`\n== 判定汇总：${results.length - fail.length}/${results.length} 通过 ==`);
  if (fail.length) log(`   未通过：${fail.map(r => r.ac).join(', ')}`);
  return fail.length === 0;
}

// ============================================================================
// 基础设施
// ============================================================================
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) return `<<git 失败: ${r.error.message}>>`;
  if (r.status !== 0) return `<<git 失败(${r.status}): ${String(r.stderr || '').trim().slice(0, 300)}>>`;
  return String(r.stdout ?? '').trim();
}
/** 网络 git：调用点注入代理（不落任何持久化 git 配置） */
const gitNet = (cwd, ...args) => git(cwd, '-c', `http.proxy=${PROXY}`, ...args);

function withGuard(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`GUARD_TIMEOUT@${label}: 超过 ${ms}ms 未返回`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const GH_HEADERS = () => ({
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});
async function getOpenPr(branch, owner = OWNER_A, repo = REPO_A) {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    { headers: GH_HEADERS() }
  );
  const list = await resp.json().catch(() => null);
  return Array.isArray(list) ? list : [];
}
async function closePr(n, owner = OWNER_A, repo = REPO_A) {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${n}`, {
    method: 'PATCH',
    headers: GH_HEADERS(),
    body: JSON.stringify({ state: 'closed' }),
  });
  return resp.status;
}

function progressMark() {
  try {
    return fs.readFileSync(PROGRESS_LOG, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}
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
      /* 非 JSON 行忽略 */
    }
  }
  return out;
}
const lastEvent = (events, name) => [...events].reverse().find(e => e.event === name);

function snapshotSelf() {
  return { status: git(PR_AGENT, 'status', '--porcelain'), branches: git(PR_AGENT, 'branch', '--format=%(refname:short)') };
}
function judgeSelfUntouched(before) {
  const after = snapshotSelf();
  const same = before.status === after.status && before.branches === after.branches;
  return judge('AC-11', same, `pr-agent 自身未被触碰：工作树${before.status === after.status ? '一致' : '有变化'} / 本地分支${before.branches === after.branches ? '无新增' : '有变化'}`);
}

/** 仓库注册表：一律显式指向项目内那份，避免 cwd 影响判定 */
function ensureRegistry() {
  if (!process.env.REPO_REGISTRY_PATH) process.env.REPO_REGISTRY_PATH = path.resolve(PR_AGENT, 'repos.registry.json');
  return process.env.REPO_REGISTRY_PATH;
}
function registryEntry(key) {
  const raw = JSON.parse(fs.readFileSync(ensureRegistry(), 'utf8'));
  return raw?.repos?.[key];
}
function targetOf(key, base) {
  const [owner, repo] = key.split('/');
  const entry = registryEntry(key);
  return { owner, repo, baseBranch: base || entry?.baseBranch || 'main' };
}

/** 取 dist 里的模块（脚本一律跑编译产物，与 workflow 运行时同一份代码） */
function dist(rel) {
  return require(path.resolve(PR_AGENT, 'dist', rel));
}

// ============================================================================
// 子进程：跨进程判定用（本脚本拉自己）
// ============================================================================
/** 子进程把结果打成 `__RESULT__<json>` 供父进程解析 */
function emitResult(obj) {
  process.stdout.write(`\n__RESULT__${JSON.stringify(obj)}\n`);
}

/**
 * 起一个子进程并取回它的 `__RESULT__`。
 *
 * ⚠️ 一律用 `spawn`（异步）而不是 `spawnSync`：AC-2 要求「两个进程**同时**发起认领」，
 * 同步版本只能一个跑完再跑下一个 —— 那验证的是顺序幂等，不是原子性（M4 已踩过同类坑）。
 */
function runChildAsync(flag, extraEnv = {}, positional = [], timeoutMs = 120_000) {
  return new Promise(resolve => {
    const buf = [];
    const cp = spawn(process.execPath, [__filename, flag, ...positional], {
      cwd: PR_AGENT,
      env: { ...process.env, ...extraEnv },
    });
    const timer = setTimeout(() => {
      try {
        cp.kill();
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);
    cp.stdout.on('data', d => buf.push(String(d)));
    cp.stderr.on('data', d => buf.push(String(d)));
    cp.on('exit', code => {
      clearTimeout(timer);
      const out = buf.join('');
      const m = out.match(/__RESULT__(.+)/);
      if (!m) return resolve({ ok: false, exitCode: code, raw: out.slice(-1200) });
      try {
        resolve({ ok: true, exitCode: code, ...JSON.parse(m[1]) });
      } catch (e) {
        resolve({ ok: false, exitCode: code, raw: `结果解析失败: ${e.message}\n${out.slice(-800)}` });
      }
    });
  });
}

// ============================================================================
// 子进程实现
// ============================================================================
/** 子进程：认领一个事件（AC-2 跨进程原子性） */
async function childClaim() {
  const [key, source] = argv.filter(a => !a.startsWith('--'));
  const { claimEvent } = dist('mastra/adapters/dedup-store.js');
  const res = await claimEvent(key, source);
  emitResult({ claimed: res.claimed, reason: res.reason, pid: process.pid });
}

/** 子进程：跑一轮轮询（AC-1 / AC-3）。来源用 `M5_POLL_SOURCE` 传入，保证三轮共享同一游标。 */
async function childPollOnce() {
  const source = process.env.M5_POLL_SOURCE;
  if (!source) throw new Error('--child-poll-once 需要 M5_POLL_SOURCE');
  const { pollInboundOnce } = dist('mastra/adapters/inbound-poll.js');
  const started = [];
  const res = await pollInboundOnce({
    source,
    // 固定返回同一条消息：模拟「窗口重叠 / 同一条消息被投了多次」
    fetchMessages: async () => [{ messageId: 'm5-fixed-msg-1', text: '固定消息', createTime: 1_700_000_000 }],
    startRun: async text => {
      started.push(text);
      return `child-run-${process.pid}-${started.length}`;
    },
  });
  emitResult({
    success: res.success,
    ranCount: started.length,
    skipped: res.skipped,
    sinceTs: res.sinceTs,
    windowSource: res.windowSource,
  });
}

/**
 * 子进程：抢锁 + 持锁 N 毫秒（AC-8）。
 * enter/exit 记进共享 JSONL，父进程据此判定「有没有交叠」——
 * 这是锁的**唯一**可判定证据（日志时间戳精度不够看清交叠）。
 */
async function childLockHold() {
  const pos = argv.filter(a => !a.startsWith('--'));
  const [repoKey, holder, holdMs, recordFile] = pos;
  const { acquireRepoLock, releaseRepoLock } = dist('mastra/adapters/repo-lock.js');
  const res = await acquireRepoLock(repoKey, holder, { waitMs: Number(process.env.M5_LOCK_WAIT_MS || 30000), pollMs: 20, ttlMs: 120000 });
  if (!res.acquired) {
    emitResult({ acquired: false, error: res.error, waitedMs: res.waitedMs, blocker: res.holder });
    return;
  }
  const rec = line => fs.appendFileSync(recordFile, `${JSON.stringify(line)}\n`);
  rec({ who: holder, at: 'enter', ts: Date.now() });
  await new Promise(r => setTimeout(r, Number(holdMs)));
  rec({ who: holder, at: 'exit', ts: Date.now() });
  const released = await releaseRepoLock(repoKey, holder);
  emitResult({ acquired: true, waitedMs: res.waitedMs, released });
}

/**
 * 子进程：**不加锁**的「checkout → 写文件 → commit」临界区（AC-8 对照组）。
 *
 * 这里刻意用真实的 git 操作而不是模拟：要证明的失败模式是
 * 「run-A 切到自己的分支后，run-B 把工作树切走，于是 A 的 commit 落到了 B 的分支上」。
 * 用模拟的话，证明的是模拟的行为，不是 git 的行为。
 */
async function childCommitNoLock() {
  const pos = argv.filter(a => !a.startsWith('--'));
  const [repo, base, ownBranch, file, settleMs, recordFile] = pos;
  const rec = line => fs.appendFileSync(recordFile, `${JSON.stringify(line)}\n`);
  const own = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(repo, 'checkout', ownBranch);
  rec({ who: ownBranch, at: 'checked-out', ts: Date.now(), head: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') });
  fs.writeFileSync(path.join(repo, file), `written by ${ownBranch}\n`);
  // 让两个进程有机会在这里交错（真实场景里这段是 coding 步的分钟级耗时）
  await new Promise(r => setTimeout(r, Number(settleMs)));
  git(repo, 'add', '-A');
  const commit = git(repo, 'commit', '-m', `chore(m5-serial): ${ownBranch}`);
  const headAtCommit = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  rec({ who: ownBranch, at: 'committed', ts: Date.now(), headAtCommit, commitOk: !commit.startsWith('<<git 失败'), startedOn: own });
  emitResult({ ownBranch, headAtCommit, commitOk: !commit.startsWith('<<git 失败') });
}

// ============================================================================
// 判定实现
// ============================================================================
async function judgeContract() {
  ensureRegistry();
  log('\n== --contract：代码级判定（零副作用，不跑 LLM、不碰远端）==');

  // ---- AC-5：ContextSchema 里没有本机路径 ----
  const { ContextSchema } = dist('mastra/workflows/dev-workflow.js');
  const { z } = require('zod');
  const json = z.toJSONSchema(ContextSchema);
  const targetProps = Object.keys(json.properties?.target?.properties ?? {}).sort();
  const topKeys = Object.keys(json.properties ?? {});
  const pathish = ['localPath', 'localRoot', 'clonePath', 'cwd', 'repoRoot'].filter(k => topKeys.includes(k));
  judge(
    'AC-5',
    JSON.stringify(targetProps) === JSON.stringify(['baseBranch', 'owner', 'repo']) && pathish.length === 0,
    `ContextSchema：target 字段 = [${targetProps.join(', ')}] / 顶层无路径型字段（命中 ${pathish.length} 个）`
  );
  // 真的把路径塞进去，运行时必须拒绝
  const { assertLogicalTarget } = dist('mastra/adapters/repo-registry.js');
  let rejected = false;
  try {
    assertLogicalTarget({ owner: 'o', repo: 'r', baseBranch: process.env.M5_A_LOCAL || 'D:\\code\\pr-agent-e2e' });
  } catch {
    rejected = true;
  }
  judge('AC-5', rejected, '把本机路径塞进 target 时，运行时显式拒绝（不让它进快照）');

  // ---- AC-10：未知 repoKey 显式报错，绝不回退 ----
  const { repoRoot } = dist('mastra/adapters/github.js');
  let unknownErr = '';
  try {
    repoRoot({ owner: 'no-such-owner', repo: 'no-such-repo', baseBranch: 'main' });
  } catch (e) {
    unknownErr = e.message;
  }
  judge('AC-10', /未知 repoKey/.test(unknownErr) && /刻意不回退/.test(unknownErr), `未知 repoKey → 显式报错：${unknownErr.slice(0, 160)}`);

  // ---- AC-7：红线 per-target ----
  const { resolveProtectedBranchNames } = dist('mastra/agents/coding-agent.js');
  const aTarget = targetOf(KEY_A, process.env.M5_A_BASE);
  const bTarget = targetOf(KEY_B, process.env.M5_B_BASE);
  const savedBase = process.env.GITHUB_BASE_BRANCH;
  delete process.env.GITHUB_BASE_BRANCH;
  const namesA = resolveProtectedBranchNames(aTarget);
  const namesB = resolveProtectedBranchNames(bTarget);
  const namesNone = resolveProtectedBranchNames();
  if (savedBase !== undefined) process.env.GITHUB_BASE_BRANCH = savedBase;
  judge(
    'AC-7',
    namesB.includes(bTarget.baseBranch) && !namesNone.includes(bTarget.baseBranch),
    `红线随 target 走：B(${bTarget.baseBranch}) → 保护 [${namesB.join(', ')}]；不带 target（旧 env 模式，=${namesNone.join(',') || '空'}）时**不含** ${bTarget.baseBranch}`
  );
  judge('AC-7', namesA.includes(aTarget.baseBranch), `A 的基线 ${aTarget.baseBranch} 也在受保护集合里：[${namesA.join(', ')}]`);

  // ---- AC-4 的解析面：两个 target → 两套 (root/base) ----
  const rootA = repoRoot(aTarget);
  const rootB = repoRoot(bTarget);
  judge('AC-4', rootA !== rootB, `两个 target 解析出各自的本地工作树：A=${rootA} / B=${rootB}`);
  judge('AC-4', path.normalize(rootB) === path.normalize(registryEntry(KEY_B).localPath), `B 的 root 来自注册表而非 env`);

  // ---- AC-6：跑 M4 的 --adapter 做向后兼容回归 ----
  log('\n  → AC-6 回归：调用 M4 的验证器（不改它，只跑它的 adapter 夹具）');
  const r = spawnSync(process.execPath, [path.resolve(__dirname, 'verify-m4-gate.js'), '--adapter'], {
    encoding: 'utf8',
    cwd: PR_AGENT,
    env: { ...process.env },
    timeout: 300_000,
  });
  const m4out = `${r.stdout || ''}\n${r.stderr || ''}`;
  // ⚠️ M4 脚本的汇总行是半角冒号（`=== 判定汇总: 17/17 通过 ===`），M5 的是全角。
  // 只按一种写会得到「明明 17/17 却解析不出来」的假阴性 —— 这里两种都收。
  const m4 = m4out.match(/判定汇总\s*[:：]\s*(\d+)\s*\/\s*(\d+)/);
  const m4ok = Boolean(m4) && m4[1] === m4[2] && Number(m4[2]) > 0;
  judge('AC-6', m4ok, `M4 --adapter 回归：${m4 ? `判定汇总 ${m4[1]}/${m4[2]} 通过` : `（未能解析出汇总；尾部输出：${m4out.trim().split('\n').slice(-3).join(' / ').slice(0, 200)}）`}`);
}

async function judgeDedup() {
  ensureRegistry();
  log('\n== --dedup：入口幂等（AC-1 / AC-2 / AC-3，全部跨进程）==');
  const { resetEventState, countSeenEvents, listSeenEvents } = dist('mastra/adapters/dedup-store.js');
  const { resetStateDb } = dist('mastra/adapters/state-db.js');

  // ---- AC-2：两个**独立进程**同时认领同一 key ----
  const key = `key-${Date.now()}`;
  const claimSource = `m5-verify-claim:${Date.now()}`;
  await resetEventState(claimSource);
  const claimedResults = await Promise.all([
    runChildAsync('--child-claim', { M5_X: '' }, [key, claimSource]),
    runChildAsync('--child-claim', { M5_X: '' }, [key, claimSource]),
  ]);
  const winners = claimedResults.filter(x => x.claimed === true);
  const losers = claimedResults.filter(x => x.claimed === false);
  judge(
    'AC-2',
    winners.length === 1 && losers.length === 1,
    `两个独立进程并发认领同一 key：成功 ${winners.length} 个（pid ${winners.map(w => w.pid).join(',')}）/ 判 duplicate ${losers.length} 个`
  );
  const ledger = await countSeenEvents(claimSource);
  judge('AC-2', ledger === 1, `账本只留下 1 条记录（实际 ${ledger} 条）`);

  // ---- AC-1 + AC-3：同一条消息被投 3 轮，只有第一轮起 run ----
  const pollSource = `m5-verify-poll:${Date.now()}`;
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    rounds.push(await runChildAsync('--child-poll-once', { M5_POLL_SOURCE: pollSource }, []));
  }
  const ranCounts = rounds.map(r => (r.ok ? r.ranCount : 'ERR'));
  judge(
    'AC-1',
    rounds.every(r => r.ok) && ranCounts[0] === 1 && ranCounts[1] === 0 && ranCounts[2] === 0,
    `同一条 messageId 投 3 轮（各自独立进程）：起 run 数 = [${ranCounts.join(', ')}]（期望 [1, 0, 0]）`
  );
  judge(
    'AC-1',
    rounds.slice(1).every(r => (r.skipped || []).some(s => s.reason === 'duplicate')),
    `第 2/3 轮的跳过带可见证据（skipped.reason=duplicate），不是静默丢弃`
  );
  judge(
    'AC-3',
    rounds.slice(1).every(r => r.windowSource === 'cursor'),
    `第 2/3 轮从**持久化游标**续读（windowSource = ${rounds.map(r => r.windowSource).join(' → ')}），进程重启不重放`
  );
  const seen = await listSeenEvents({ source: pollSource });
  judge('AC-3', seen.length === 1 && Boolean(seen[0].runId), `账本落盘且 runId 已回填：${seen.length} 条 / runId=${seen[0]?.runId}`);

  await resetEventState(claimSource);
  await resetEventState(pollSource);
  await resetStateDb();
}

async function judgeSerial() {
  ensureRegistry();
  log('\n== --serial：同仓库串行（AC-8，跨进程 + 无锁对照组）==');
  const aTarget = targetOf(KEY_A, process.env.M5_A_BASE);
  const repo = repoRoot_();
  log(`  目标仓库 = ${KEY_A} @ ${repo}`);

  const recordFile = path.join(os.tmpdir(), `m5-serial-${Date.now()}.jsonl`);
  fs.writeFileSync(recordFile, '');

  // ---- 对照组：不加锁，两个进程各切分支再提交 ----
  const brA = `m5-serial-a-${Date.now()}`;
  const brB = `m5-serial-b-${Date.now()}`;
  git(repo, 'checkout', aTarget.baseBranch);
  git(repo, 'checkout', '-b', brA, aTarget.baseBranch);
  git(repo, 'checkout', aTarget.baseBranch);
  git(repo, 'checkout', '-b', brB, aTarget.baseBranch);
  git(repo, 'checkout', aTarget.baseBranch);

  const fileA = `m5-serial-a-${Date.now()}.txt`;
  const fileB = `m5-serial-b-${Date.now()}.txt`;

  await Promise.all([
    runChildAsync('--child-commit-nolock', {}, [repo, aTarget.baseBranch, brA, fileA, '400', recordFile]),
    runChildAsync('--child-commit-nolock', {}, [repo, aTarget.baseBranch, brB, fileB, '400', recordFile]),
  ]);
  const noLockRecords = fs
    .readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
  const mislanded = noLockRecords.filter(r => r.at === 'committed' && r.headAtCommit !== r.who);
  const mislandedB = git(repo, 'log', '--oneline', brB).includes(brA) || git(repo, 'show', '--stat', '--name-only', brB).includes(fileA);
  judge(
    'AC-8',
    mislanded.length > 0 || mislandedB,
    `【无锁对照组】确实会串台：${mislanded.length} 个 commit 落到了别人的分支上` +
      `${mislanded.length ? `（例：${mislanded[0].who} 的提交落在 ${mislanded[0].headAtCommit}）` : ''}` +
      `${mislandedB ? '；且分支 ' + brB + ' 里出现了 ' + fileA : ''}`
  );

  // 清理对照组残留
  git(repo, 'checkout', '--', '.');
  git(repo, 'checkout', aTarget.baseBranch);
  git(repo, 'branch', '-D', brA);
  git(repo, 'branch', '-D', brB);
  fs.rmSync(path.join(repo, fileA), { force: true });
  fs.rmSync(path.join(repo, fileB), { force: true });
  git(repo, 'checkout', '--', '.');

  // ---- 实验组：加锁，同样的两个进程 ----
  fs.writeFileSync(recordFile, '');
  await Promise.all([
    runChildAsync('--child-lock-hold', { M5_LOCK_WAIT_MS: '30000' }, [KEY_A, 'holder-X', '300', recordFile]),
    runChildAsync('--child-lock-hold', { M5_LOCK_WAIT_MS: '30000' }, [KEY_A, 'holder-Y', '300', recordFile]),
  ]);
  const lockRec = fs
    .readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
  const enters = lockRec.filter(r => r.at === 'enter');
  const exits = lockRec.filter(r => r.at === 'exit');
  // 串行的判据：第一个 exit 早于第二个 enter（即第二个临界区在第一个结束之后才开始）
  const serialized =
    enters.length === 2 && exits.length === 2 && exits[0].ts <= enters[1].ts && enters[0].who !== enters[1].who;
  judge(
    'AC-8',
    serialized,
    `【加锁】两个独立进程的临界区严格串行：${lockRec.map(r => `${r.who}:${r.at}@${r.ts}`).join(' → ')}`
  );

  const waited = await runChildAsync('--child-lock-hold', {}, [KEY_A, 'holder-Z', '50', recordFile], 60_000);
  judge('AC-8', waited.acquired === true, `锁释放后可被下一个 run 正常获取（waitedMs=${waited.waitedMs ?? 'n/a'}）`);

  fs.rmSync(recordFile, { force: true });
}

/** 从注册表解析 A 的本地工作树（--serial 用） */
function repoRoot_() {
  return dist('mastra/adapters/github.js').repoRoot(targetOf(KEY_A, process.env.M5_A_BASE));
}

// ============================================================================
// --multi：两仓库端到端
// ============================================================================
const ISSUE_A = {
  issueNumber: Number(process.env.M5_ISSUE_A_NUMBER || 201),
  issueTitle: process.env.M5_ISSUE_A_TITLE || 'docs: 在 README 新增「快速开始」一节',
  issueBody:
    process.env.M5_ISSUE_BODY ||
    '请在 README.md 末尾新增一个名为「快速开始」的二级标题小节，内容说明：运行测试的命令是 `node --test`（零依赖，不需要先 npm install）。' +
    '标点请与仓库既有行文保持一致（使用半角冒号 `:` 与半角逗号 `,`）。' +
    '只改 README.md，不要改动 src/ 下的任何文件，也不要修改测试。',
};
const ISSUE_B = {
  issueNumber: Number(process.env.M5_ISSUE_B_NUMBER || 1),
  issueTitle: process.env.M5_ISSUE_B_TITLE || 'docs: 在 README 新增「快速开始」一节',
  issueBody:
    process.env.M5_ISSUE_B_BODY ||
    '请在 README.md 末尾新增一个名为「快速开始」的二级标题小节，内容说明：运行测试的命令是 `node --test`。' +
    '标点请与仓库既有行文保持一致（使用半角冒号 `:` 与半角逗号 `,`）。' +
    '只改 README.md，不要改动 src/ 下的任何文件，也不要修改测试。',
};

/** 一次端到端 run。返回结构化结果供逐条判定。 */
async function runOnce(label, target, issue, extra = {}) {
  const { mastra } = dist('mastra/index.js');
  const wf = mastra.getWorkflow('dev-workflow');
  const run = await wf.createRun();
  const key = `${target.owner}/${target.repo}`;
  const local = dist('mastra/adapters/github.js').repoRoot(target);
  log(`\n  ▶ ${label}: ${key}@${target.baseBranch} → ${local}`);
  const mark = progressMark();
  let result;
  let startError;
  const t0 = Date.now();
  try {
    result = await withGuard(
      run.start({ inputData: { ...issue, target, ...extra } }),
      Number(process.env.M5_TOTAL_TIMEOUT_MS ?? 1_200_000),
      label
    );
  } catch (e) {
    startError = e instanceof Error ? e : new Error(String(e));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const events = progressSince(mark);
  // 错误必须**双来源**取：闸门判负时 run.start() resolve 出 {status:'failed', error} 而非 reject（M4 踩过）
  const errText = [
    startError ? startError.message : '',
    result && typeof result.error === 'string' ? result.error : result ? JSON.stringify(result.error ?? '') : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const rec = {
    label,
    runId: run.runId,
    elapsed,
    status: startError ? '(start() 抛错)' : result?.status,
    errText,
    targetEvent: lastEvent(events, 'repo:target'),
    lockEvent: lastEvent(events, 'repo:lock'),
    unlockEvent: lastEvent(events, 'repo:unlock'),
    testRun: lastEvent(events, 'test:run'),
    testTouch: lastEvent(events, 'test:touch'),
    // `steps[id].output` 是成功路径；`results[id].output` 是部分版本/失败路径的落点，两者都取
    output: id => result?.steps?.[id]?.output ?? result?.results?.[id]?.output ?? {},
  };
  log(`      runId=${rec.runId} 耗时=${elapsed}s status=${rec.status} prNumber=${rec.output('push-open-pr')?.prNumber ?? '(n/a)'}`);
  log(`      repo:target = ${JSON.stringify(rec.targetEvent)}`);
  log(`      test:run.command = ${rec.testRun?.command ?? '(无)'}`);
  if (errText) log(`      错误 = ${errText.slice(0, 300)}`);
  // 锁的终局态：必须在 run 结束后（无论成功还是判负终止）已经释放。
  // 为什么这条判据必要（2026-09-16 实测教训）：只断言「串行有效」会漏掉「泄漏」——
  // 锁机制本身工作正常，漏的只是**释放路径的覆盖**（原先只在 push-open-pr 的 finally 释放，
  // 而 test/review/commit 三处闸门判负都在它之前 throw）。实测后果：review 判负后锁仍挂库，
  // 下一次同仓库 run 白等 600001ms 才报 REPO_LOCK_TIMEOUT。故把「终止后无残锁」也变成可数判据。
  rec.lockAfter = await dist('mastra/adapters/repo-lock.js').peekRepoLock(key);
  log(`      锁终局态 = ${rec.lockAfter ? `❌ 仍被 ${rec.lockAfter.holder} 持有(疑似泄漏)` : '✅ 已释放'}`);
  return rec;
}

async function judgeMulti() {
  ensureRegistry();
  log('\n== --multi：两仓库端到端（AC-4 / AC-9 / AC-11）==');
  // ⚠️ 刻意不设 CODING_REPO_ROOT / GITHUB_OWNER / GITHUB_REPO / GITHUB_BASE_BRANCH：
  // 多仓库模式只该依赖 token + 注册表。
  for (const k of ['CODING_REPO_ROOT', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BASE_BRANCH']) delete process.env[k];
  if (!process.env.GIT_PROXY) process.env.GIT_PROXY = PROXY;
  if (!process.env.GITHUB_TOKEN) {
    log('  ❌ 缺少 GITHUB_TOKEN，无法跑 --multi');
    judge('AC-4', false, '缺少 GITHUB_TOKEN');
    return;
  }

  const targetA = targetOf(KEY_A, process.env.M5_A_BASE);
  const targetB = targetOf(KEY_B, process.env.M5_B_BASE);
  const rootA = dist('mastra/adapters/github.js').repoRoot(targetA);
  const rootB = dist('mastra/adapters/github.js').repoRoot(targetB);
  const selfBefore = snapshotSelf();

  // 起点：两边都回到各自基线，清掉上次跑批残留（只动本地）
  for (const [repo, base] of [[rootA, targetA.baseBranch], [rootB, targetB.baseBranch]]) {
    git(repo, 'checkout', '--', '.');
    git(repo, 'checkout', base);
  }
  log(`  A = ${KEY_A}@${targetA.baseBranch} (${rootA})  ← 真 push + 真开 PR`);
  log(`  B = ${KEY_B}@${targetB.baseBranch} (${rootB})  ← stopAfterCommit，零远端`);

  const runA1 = await runOnce('A#1', targetA, ISSUE_A);
  const runA2 = await runOnce('A#2', targetA, ISSUE_A); // AC-9：同 issue 重跑
  const runB = await runOnce('B#1', targetB, ISSUE_B, { stopAfterCommit: true });

  // ---- AC-4：两侧互不串台 ----
  const tA = runA1.targetEvent;
  const tB = runB.targetEvent;
  const sep =
    tA &&
    tB &&
    tA.repoKey === KEY_A &&
    tB.repoKey === KEY_B &&
    tA.baseBranch === targetA.baseBranch &&
    tB.baseBranch === targetB.baseBranch &&
    path.normalize(tA.localPath) === path.normalize(rootA) &&
    path.normalize(tB.localPath) === path.normalize(rootB);
  judge('AC-4', Boolean(sep), `两个 run 各自锚定到自己的仓库/基线/工作树：A=${tA?.repoKey}@${tA?.baseBranch} / B=${tB?.repoKey}@${tB?.baseBranch}`);
  const cmdA = runA1.testRun?.command || '';
  const cmdB = runB.testRun?.command || '';
  judge('AC-4', cmdA.includes(rootA.replace(/\\/g, '/')) && cmdB.includes(rootB.replace(/\\/g, '/')), `test:run.command 分别指向各自工作树`);
  log(`      A 命令：${cmdA}`);
  log(`      B 命令：${cmdB}`);

  // 串台物证：A 的工作树里不该出现 B 的被测文件，反之亦然
  const cross =
    fs.existsSync(path.join(rootA, 'src', 'farewell.js')) || fs.existsSync(path.join(rootB, 'src', 'greet.js'));
  judge('AC-4', !cross, `工作树未交叉污染：A 无 src/farewell.js、B 无 src/greet.js`);

  // ---- AC-4：A 的 PR 开在 A 的仓库上 ----
  // 「走到过 push 的那一轮」——两轮里取任一真开出了 PR 的。
  // ⚠️ 不能写死 runA1：review 闸门的通过与否由 LLM 判（实测 A#1 就因「全角冒号 vs 半角」
  // 被 request-changes 而没 push）。判据要落在「这个仓库上有没有开出一条属于本 issue 的 PR」，
  // 而不是「第几轮开的」—— 后者会把一次合理的闸门判负误报成多仓库失败。
  const pushedRun = [runA2, runA1].find(r => {
    const n = r.output('push-open-pr')?.prNumber;
    return typeof n === 'number' && n > 0;
  });
  const branchA = pushedRun?.output('checkout')?.branch;
  const prA = pushedRun?.output('push-open-pr');
  if (branchA) {
    const list = await getOpenPr(branchA);
    judge(
      'AC-4',
      list.length > 0 && list[0].number === prA?.prNumber,
      `A 的 PR #${prA?.prNumber}（由 ${pushedRun.label} 开出）确实在 ${KEY_A} 上（远端查得 ${list.length} 条同 head 的 open PR）`
    );
  } else {
    judge('AC-4', false, `A 的两次 run 都没有产出 prNumber（A#1 status=${runA1.status} / A#2 status=${runA2.status}）`);
  }

  // ---- AC-9：产物幂等（同 issue 重跑不新建 PR）----
  //
  // 判定策略（2026-09-16 修订）：**主判据走确定性探针**，不依赖「两轮 LLM 都成功」。
  // 为什么改：AC-9 的本质是 `openPrForBranch()` 对同一 head 的复用（M3 的产物层幂等），
  // 那是**纯程序行为**；而「两轮都跑通」里混进了 review 闸门的 LLM 判断，
  // 会因标点/风格这类内容细节在两轮间不同（实测 A#1 就是这样被判负的）。
  // 于是「两轮 prNumber 相同」在 A#1 未 push 时退化成 `undefined === undefined` 的**假通过**
  // —— 这正是 M4 踩过的同构错误（把「没验」报成「验过了」）。
  // 现在直接对同一 branch/target 再调一次 `githubPushAndOpenPR`：若复用逻辑退化，
  // 第二次会真的 POST /pulls，GitHub 回 422「A pull request already exists」→ 判负。
  const prA2 = runA2.output('push-open-pr');
  const prAny = prA;
  const branchAny = branchA;
  const reuse = branchAny
    ? await dist('mastra/adapters/github.js').githubPushAndOpenPR({
        branch: branchAny,
        title: `${ISSUE_A.issueTitle} (#${ISSUE_A.issueNumber})`,
        body: 'AC-9 复用探针：该 head 已有 open PR，应复用而不是新建。',
        target: targetA,
      })
    : { error: 'no branch', prNumber: undefined };
  judge(
    'AC-9',
    typeof prAny?.prNumber === 'number' &&
      prAny.prNumber > 0 &&
      !reuse.error &&
      reuse.prNumber === prAny.prNumber,
    `产物幂等（确定性探针）：同一 head 再推一次仍复用 PR #${reuse.prNumber}` +
      `（原 #${prAny?.prNumber}${reuse.error ? `，error=${reuse.error}` : ''}）`
  );
  // 附加观察：若两轮都真开出了 PR，则必须是同一个（这是更强的端到端证据，但受 LLM 影响不作主判据）
  const n1 = runA1.output('push-open-pr')?.prNumber;
  const n2 = prA2?.prNumber;
  if (typeof n1 === 'number' && typeof n2 === 'number' && n1 > 0 && n2 > 0) {
    judge('AC-9', n1 === n2, `两轮端到端复用同一 PR：#${n1} → #${n2}`);
  } else {
    log(
      `      （端到端两轮对比不可用：A#1 prNumber=${n1 ?? 'n/a'}（status=${runA1.status}）/ A#2 prNumber=${n2 ?? 'n/a'}）` +
        ` —— 已由上面的确定性探针覆盖`
    );
  }
  judge('AC-9', !/422/.test(runA2.errText || ''), `A#2 未因 422 判负：${!/422/.test(runA2.errText || '')}`);

  // ---- AC-8 的顺带观察：不同仓库之间不该互相等待 ----
  judge(
    'AC-8',
    runA1.lockEvent?.acquired === true && runB.lockEvent?.acquired === true && !runB.lockEvent?.waited,
    `不同 repoKey 互不阻塞：A awaited=${runA1.lockEvent?.waited} / B waited=${runB.lockEvent?.waited}（都拿到、都没在等）`
  );

  // ---- AC-8：终止路径不留残锁（2026-09-16 实测新增的判据）----
  // 判定依据见 runOnce 里 `lockAfter` 的注释：串行有效 ≠ 释放完整。
  for (const r of [runA1, runA2, runB]) {
    judge(
      'AC-8',
      r.lockAfter === null,
      `${r.label}（status=${r.status}）结束后无残锁：` +
        (r.lockAfter === null ? '已释放' : `❌ 仍被 ${r.lockAfter.holder} 持有 —— 后续同仓库 run 会白等到 REPO_LOCK_WAIT_MS`)
    );
  }

  // ---- B 的基线确实生效（trunk，不是 main）----
  const branchB = runB.output('checkout')?.branch;
  const bBase = branchB ? git(rootB, 'merge-base', branchB, targetB.baseBranch) : '<<no branch>>';
  judge(
    'AC-4',
    Boolean(branchB) && !String(bBase).startsWith('<<git 失败'),
    `B 的分支 ${branchB} 基于 ${targetB.baseBranch}（merge-base=${String(bBase).slice(0, 8)}）`
  );

  // ---- AC-11 ----
  judgeSelfUntouched(selfBefore);

  log(`\n  提示：A 的 PR 与远端分支留作证据；需要清理时跑 --clean-remote`);
}

async function cleanRemote() {
  ensureRegistry();
  log('\n== --clean-remote：清理靶场远端 feat/* 与对应 open PR ==');
  const rootA = dist('mastra/adapters/github.js').repoRoot(targetOf(KEY_A, process.env.M5_A_BASE));
  const ls = gitNet(rootA, 'ls-remote', '--heads', 'origin', 'refs/heads/feat/*');
  if (!ls || ls.startsWith('<<git 失败') || !ls.trim()) {
    log('  远端无 feat/* 分支（或 ls-remote 失败），无需清理');
  } else {
    const branches = ls
      .split('\n')
      .map(l => (l.split('\t')[1] || '').replace('refs/heads/', ''))
      .filter(Boolean);
    const tokenUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${OWNER_A}/${REPO_A}.git`;
    for (const b of branches) {
      for (const pr of await getOpenPr(b)) {
        log(`    关闭 PR #${pr.number}(${b}) → HTTP ${await closePr(pr.number)}`);
      }
      log(`    删除远端分支 ${b} → ${gitNet(rootA, 'push', tokenUrl, '--delete', b) || 'ok'}`);
    }
  }
  // 本地残留：回到基线并清掉 feat/m5-serial 分支
  git(rootA, 'checkout', '--', '.');
  git(rootA, 'checkout', targetOf(KEY_A, process.env.M5_A_BASE).baseBranch);
  const localBranches = git(rootA, 'branch', '--format=%(refname:short)')
    .split('\n')
    .map(s => s.trim())
    .filter(b => b.startsWith('feat/') || b.startsWith('m5-serial'));
  for (const b of localBranches) git(rootA, 'branch', '-D', b);
  log(`  本地清理：删除 ${localBranches.length} 个 feat/* / m5-serial* 分支`);
  log('  远端 PR #1/#2（M3 遗留）不在本脚本处理范围：它们是 M3 的验收证据，删不删由人决定');
}

// ============================================================================
// 入口
// ============================================================================
async function main() {
  if (CHILD) {
    if (CHILD === '--child-claim') return childClaim();
    if (CHILD === '--child-poll-once') return childPollOnce();
    if (CHILD === '--child-lock-hold') return childLockHold();
    if (CHILD === '--child-commit-nolock') return childCommitNoLock();
    throw new Error(`未知子进程模式: ${CHILD}`);
  }
  log(`\n${'='.repeat(78)}\n[verify-m5] 模式 = ${MODE} | 注册表 = ${ensureRegistry()}`);
  if (MODE === 'contract') await judgeContract();
  if (MODE === 'dedup') await judgeDedup();
  if (MODE === 'serial') await judgeSerial();
  if (MODE === 'multi') await judgeMulti();
  if (MODE === 'clean-remote') await cleanRemote();
  const ok = MODE === 'clean-remote' ? true : summary();
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  log(`\n💥 脚本异常：${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
