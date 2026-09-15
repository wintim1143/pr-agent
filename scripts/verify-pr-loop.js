/**
 * M3「完整 PR 闭环」端到端验证。
 *
 * ## 当前阶段（2026-09-15 · M3-2 ✅ / M3-3 ✅ / M3-5 ✅）
 * **已实现**（前置检查 6 段 + 闭环 1 段 + 跨进程 resume 1 模式）：
 *   1. **硬设五个 env**（`CODING_REPO_ROOT` / `GITHUB_OWNER` / `GITHUB_REPO` /
 *      `GITHUB_BASE_BRANCH` / `GIT_PROXY`），**不依赖外部 shell 环境**
 *      —— 与 `verify-local-write.js` 同一安全模式。这是防「静默打在 pr-agent 自己身上」的关键。
 *   2. **前置检查**：靶场 clone 就绪 / 有 origin remote / remote 指向与硬设值一致 /
 *      工作区干净 / token 两个写权限探针（零副作用）。
 *   3. **身份一致性反证**：证明 `parseOwnerRepo()` 不再解析成 `wintim1143/pr-agent`
 *      —— M3-2 的核心验收（修复前会把 PR 开到 pr-agent 身上）。
 *   4. **`--run` 完整闭环**：真 push / 真开 PR / 停在 merge 关卡（M3-3）。
 *   5. **`--resume-deny` / `--resume-approve`**：**跨进程**恢复 merge 关卡（M3-5）。
 *      刻意与 `--run` 分成两次进程调用 —— 同进程 resume 验不出 LibSQLStore 持久化。
 *
 * ## 与 verify-local-write.js 的边界（别混用）
 * | | `verify-local-write.js`（M2） | 本脚本（M3） |
 * |---|---|---|
 * | 目标仓库 | 沙箱 `D:\code\pr-agent-sandbox`（**无 remote**） | 靶场 `D:\code\pr-agent-e2e`（**有 remote**） |
 * | 入参 | `stopAfterCommit: true`（短路掉 push/notify/merge） | 不传 → 恢复完整八步 |
 * | 远端 | 物理上不可能写（无 remote） | **真写远端**，故前置检查必须拦住配置错误 |
 * | AC 集 | AC-1~AC-10 | AC-1~AC-9（见 `milestones/M3-完整PR闭环.md` §8） |
 *
 * ## 为什么前置检查里要「比 remote 与硬设值一致」
 * M3 最危险的失败形态不是「跑不通」，而是「**跑通了但打在错的仓库上**」：
 * 靶场 clone 的 remote 若指向 `pr-agent`，push 会把分支推到主仓、PR 也开到主仓。
 * 这类错误不会报错，只会静默污染。所以这里做**三方核对**：
 * 硬设的 owner/repo ↔ 靶场 remote 解析出的 owner/repo ↔ REST 实际能写到的仓库（写探针）。
 *
 * ## 完整验证流程（AC-1~AC-6 各一次）
 * ```bash
 * # 1) 干净起点
 * node scripts/verify-pr-loop.js --clean-remote --reset
 * # 2) 完整闭环 → 记下打印的 runId,此刻 PR 已开、run 停在 suspended
 * node scripts/verify-pr-loop.js --run
 * # 3) 模拟人工「拒绝」→ 断言 PR 仍 open、base sha 未变（AC-5）
 * node scripts/verify-pr-loop.js --resume-deny    <runId>
 * # 4) 重跑一轮拿新的 suspended run（一个 run 只能 resume 一次,终态不可再恢复）
 * node scripts/verify-pr-loop.js --clean-remote --reset
 * node scripts/verify-pr-loop.js --run
 * # 5) 模拟人工「批准」→ 断言 PR merged、base sha 已变（AC-6）
 * node scripts/verify-pr-loop.js --resume-approve <runId>
 * ```
 *
 * ## 用法
 *   node scripts/verify-pr-loop.js                 # 前置检查（默认；不跑 workflow）
 *   node scripts/verify-pr-loop.js --run           # 完整闭环：真 push / 真开 PR / 停在 merge 关卡
 *   node scripts/verify-pr-loop.js --reset         # 先重置靶场**本地**分支状态再检查
 *   node scripts/verify-pr-loop.js --clean-remote  # 清理靶场**远端** feat/* 分支与其 open PR
 *   node scripts/verify-pr-loop.js --skip-probe    # 跳过 token 写权限探针（离线时用）
 *   node scripts/verify-pr-loop.js --resume-deny    <runId>   # 跨进程恢复:人工拒绝 → 不合并
 *   node scripts/verify-pr-loop.js --resume-approve <runId>   # 跨进程恢复:人工批准 → 真 squash merge
 *
 * ⚠️ **重跑须知**：`--reset` 只清本地。远端残留的 `feat/*` 分支会让下次 push 变成
 * **非快进被拒**（本地分支从 main 重建，远端却已多一个提交）。重跑前先 `--clean-remote`。
 *
 * ⚠️ **一个 run 只能 resume 一次**：resume 后 run 进入终态，再 resume 会被
 * `resumeLoop` 的前置断言挡下（不是静默无事发生）。
 *
 * ## 环境覆盖（都有安全缺省，不设也能跑）
 *   M3_TARGET_REPO  靶场本地 clone 路径，缺省 `D:\code\pr-agent-e2e`
 *   M3_OWNER / M3_REPO / M3_BASE   缺省 `wintim1143` / `pr-agent-e2e` / `main`
 *   GIT_PROXY       git 走 HTTP 代理，缺省 `http://127.0.0.1:7890`
 *                   （本机直连 github.com 不通，但 api.github.com 直连通 → 只有 git 需要代理）
 *
 * 证据落 `logs/m3-verify.log`（每条即写，防管道缓冲 / 中途被杀丢日志）。
 * 阶段事件另落 `logs/dev-workflow.log`（JSON Lines，可 `tail -f`）。
 */
'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// ---------- 目标仓库与远端配置（硬设，不依赖外部环境）----------
const TARGET = process.env.M3_TARGET_REPO || 'D:\\code\\pr-agent-e2e';
const OWNER = process.env.M3_OWNER || 'wintim1143';
const REPO = process.env.M3_REPO || 'pr-agent-e2e';
const BASE = process.env.M3_BASE || 'main';
// 本机实测：github.com(git clone/push 端点) 直连不通(21s 超时)，唯一可用代理是 7890。
// 只做「调用点注入」用，不写任何持久化 git 配置（见 M3 卡 §7 M3-3 的定案）。
const PROXY = process.env.GIT_PROXY || process.env.M3_GIT_PROXY || 'http://127.0.0.1:7890';

const PR_AGENT = path.resolve(__dirname, '..');
const LOG = path.resolve(__dirname, '../logs/m3-verify.log');
const PROGRESS_LOG = path.resolve(__dirname, '../logs/dev-workflow.log');

const argv = process.argv.slice(2);
const RESET = argv.includes('--reset');
const RUN = argv.includes('--run');
const SKIP_PROBE = argv.includes('--skip-probe');
const CLEAN_REMOTE = argv.includes('--clean-remote');
/**
 * M3-5:跨进程恢复人工关卡（两种结局各一次独立进程调用）。
 *   --resume-deny <runId>      模拟人工「拒绝」→ 断言不合并
 *   --resume-approve <runId>   模拟人工「批准」→ 断言真 squash merge
 * 两者都**不做前置检查**：resume 的前提是「上一轮跑批已经留下一个 suspended run」，
 * 与靶场当前是否干净无关（反而上一轮留下的分支必须还在，否则 PR 无从验证）。
 */
const RESUME_APPROVE = argv.includes('--resume-approve');
const RESUME_DENY = argv.includes('--resume-deny');
const RESUME_MODE = RESUME_APPROVE ? 'approve' : RESUME_DENY ? 'deny' : null;
/**
 * M3-8 负向场景：**预期 workflow 失败**。
 *
 * 构造方式（一举两得）：让 issue 要求改**受保护文件** `agent.md` ——
 *   · `guard.ts` 的受保护路径规则会 deny 每次写入 → 验证 M3-6 的红线在真实链路里生效
 *   · coding 因此改不动任何东西 → 工作树无 diff → test 闸门判负 → 验证 M3-8 的终止
 *
 * ⚠️ 本模式下 **`status=success` 反而是失败**：说明闸门没拦住、流程照旧 commit+push 了。
 * 判定标准与正常模式相反，故独立成模式，不与 --run 混用。
 */
const GATE_NEGATIVE = argv.includes('--gate-negative');
const RUN_ID_ARG = (() => {
  const i = argv.findIndex(a => a === '--resume-approve' || a === '--resume-deny');
  return i >= 0 ? argv[i + 1] : undefined;
})();

const lines = [];
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a
    .map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ')}`;
  lines.push(line);
  console.log(line);
  fs.writeFileSync(LOG, lines.join('\n') + '\n'); // 每条即写,防止中途被杀丢日志
}

/** 跑一条 git 命令并返回 stdout(失败时返回带错误标记的字符串,不抛) */
function git(cwd, ...args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    return stderr || `<<git 失败: ${e.message}>>`;
  }
}

/**
 * 网络 git：需要走 `github.com` 端点的操作（`ls-remote` / `fetch` / `push`）。
 *
 * 与 `git()` 的区别**只有**一个：在调用点注入 `-c http.proxy=<PROXY>`。
 * 为什么不配全局 / 仓库级：代理是本机某段时间的网络现状，不是项目属性，
 * 写进 `.git/config` 换机器即失效，且故障表现为「git 静默连不通」这种最难排查的形态。
 * （git 的 `http.proxy` 配置优先级高于 `http_proxy`/`HTTPS_PROXY` 环境变量，故能覆盖坏 env。）
 */
function gitNet(cwd, ...args) {
  return git(cwd, '-c', `http.proxy=${PROXY}`, ...args);
}

/** 让 promise 在规定 ms 内未决议则抛错 —— 防 CLI/LLM 挂起导致脚本静默冻死。 */
function withGuard(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`GUARD_TIMEOUT@${label}: 超过 ${ms}ms 未返回`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const failures = [];
function fail(msg, hint) {
  failures.push(msg);
  log(`  ✗ ${msg}`);
  if (hint) log(`    → ${hint}`);
}

/** 从 git remote URL 解析 owner/repo（脚本侧独立实现，用于与项目实现交叉核对） */
function parseRemoteUrl(url) {
  const m = String(url).trim().match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * 零副作用写权限探针。
 *
 * 原理：发一个**必然失败但绝不产生后果**的写请求 ——
 * 鉴权/权限不足 → `403`；鉴权已过、仅参数不合法 → `422`。
 * 所以 **422 = 有权限**，403 = 无权。比「真建一个再删掉」安全且同样权威。
 * （403 响应的 `x-accepted-github-permissions` 头会直接列出缺哪个权限。）
 *
 * @param {'contents'|'pull_requests'} kind
 */
async function probeWritePermission(kind) {
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  const [url, body] =
    kind === 'contents'
      ? // 建 ref 但 sha 用全零 → 必定 422（Object does not exist），不会真的建出分支
        [
          `https://api.github.com/repos/${OWNER}/${REPO}/git/refs`,
          { ref: 'refs/heads/__perm_probe', sha: '0'.repeat(40) },
        ]
      : // 开 PR 但 head 指向不存在的分支 → 必定 422（Validation Failed: field head invalid）
        [
          `https://api.github.com/repos/${OWNER}/${REPO}/pulls`,
          { title: '__perm_probe', head: '__nonexistent_branch__', base: BASE, body: '' },
        ];

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await resp.json().catch(() => null);
  const accepted = resp.headers.get('x-accepted-github-permissions');
  return {
    kind,
    status: resp.status,
    ok: resp.status === 422,
    message: raw && (raw.message || JSON.stringify(raw.errors || {})) ,
    acceptedPermissions: accepted,
  };
}

/** 查某 head 分支当前 open 的 PR（用于验证 push-open-pr 真的开出了 PR） */
async function getOpenPr(branch) {
  const resp = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/pulls?state=open&head=${encodeURIComponent(
      `${OWNER}:${branch}`
    )}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  const list = await resp.json().catch(() => null);
  return { status: resp.status, list: Array.isArray(list) ? list : null };
}

/** 关闭 PR（`PATCH /pulls/{n}` body `{state:'closed'}`）。返回 HTTP 状态码。 */
async function closePr(n) {
  const resp = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${n}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: 'closed' }),
  });
  return resp.status;
}

/**
 * `--clean-remote`：清理靶场远端的 `feat/*` 分支与它们 open 的 PR。
 *
 * ## 为什么必须有这个开关
 * 靶场 clone 的 feature 分支是**每次跑 workflow 时从 base 新建**的。
 * 若远端还留着上一轮的 `feat/1-*`，下一轮 push 时本地分支是远端的**祖先**
 * → git 判非快进并拒收（`! [rejected] (fetch first)`）→ 每跑第二次必挂。
 * 而 `--reset` 只清本地（刻意如此：远端操作破坏性更强），所以清理必须是独立开关。
 *
 * ## 顺序为什么是「先关 PR 再删分支」
 * 反过来会让 PR 落进「head 分支已被删除」的悬空状态 ——
 * GitHub 不会自动关它，会一直挂在 open 列表里成为噪音。
 */
async function cleanRemote() {
  log('\n[--clean-remote] 清理靶场远端的 feat/* 分支与对应 open PR');
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
    // 1) 先关 open PR
    try {
      const { list } = await getOpenPr(b);
      for (const pr of list || []) {
        log(`    关闭 PR #${pr.number}(${b})→ HTTP ${await closePr(pr.number)}`);
      }
    } catch (e) {
      log(`    查/关 PR 失败(${b}): ${e?.message || e}`);
    }
    // 2) 再删远端分支（走代理；token 内嵌 URL，不落 .git/config）
    const del = gitNet(TARGET, 'push', tokenUrl, '--delete', b);
    log(`    删除远端分支 ${b} → ${del || 'ok'}`);
  }
}

/** 查单个 PR（`merged` 字段是 AC-5/AC-6 的核心判据，列表接口没有它）。 */
async function getPr(n) {
  const resp = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${n}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const j = await resp.json().catch(() => null);
  return { status: resp.status, pr: j };
}

/** 读远端 base 分支的当前 sha。走 git（带代理注入），刻意不经 REST —— 与 GitHub 网页看到的同源。 */
function getBaseSha() {
  const out = gitNet(TARGET, 'ls-remote', 'origin', `refs/heads/${BASE}`);
  if (!out || out.startsWith('<<git 失败')) return '';
  return (out.split(/\s+/)[0] || '').trim();
}

/** 列出远端全部 heads（`sha refs/heads/x` 行，已排序）—— 用于判定「远端有没有被写」。 */
function listRemoteHeads() {
  const out = gitNet(TARGET, 'ls-remote', '--heads', 'origin');
  if (!out || out.startsWith('<<git 失败')) return null;
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .sort();
}

/**
 * pr-agent **自身**的快照（工作树状态 + 本地分支列表）—— AC-9 用。
 *
 * ⚠️ 注意验的是 `PR_AGENT`（主仓），不是 `TARGET`（靶场）。两者是**独立仓库**，
 * workflow 的所有 git 操作都锚在 `repoRoot()` = `CODING_REPO_ROOT` = 靶场。
 * 这条验的正是「有没有搞错仓库」这类**最危险的静默错误**：跑完批，靶场对、主仓被污染。
 *
 * 判定用「前后是否一致」而不是「是否为空」：跑验证时主仓本来就可能带着未提交改动，
 * 要求为空会恒失败。而在意的是「跑批有没有**新增**改动」。
 * （logs/ / mastra.db / dist/ / .tmp/ 均已 gitignore，跑批不会污染 status。）
 */
function snapshotSelf() {
  return {
    status: git(PR_AGENT, 'status', '--porcelain'),
    branches: git(PR_AGENT, 'branch', '--format=%(refname:short)'),
  };
}

/** 比较 pr-agent 自身快照是否一致（AC-9），返回布尔。 */
function judgeSelfUntouched(before, label = 'AC-9') {
  const after = snapshotSelf();
  const statusSame = before.status === after.status;
  const branchesSame = before.branches === after.branches;
  const ok = statusSame && branchesSame;
  log(
    `  ${ok ? '✅' : '❌'} ${label} pr-agent 自身未被触碰: 工作树${statusSame ? '一致' : '有变化'}` +
      ` / 本地分支${branchesSame ? '无新增' : '有变化'}`
  );
  if (!statusSame) {
    log(`      运行前: ${before.status.replace(/\n/g, ' | ').slice(0, 200) || '(空)'}`);
    log(`      运行后: ${after.status.replace(/\n/g, ' | ').slice(0, 200) || '(空)'}`);
  }
  return ok;
}

/**
 * M3-8 负向场景判定：闸门判负 → 必须**没有 commit、没有 push**。
 *
 * ## 为什么判据是「三个物证」而不是「看返回值」
 *
 * 只看 workflow 的返回/错误说明不了什么 —— 错误可能是超时、可能是别的原因。
 * 真正的判据是**仓库的实际状态**：
 *   1. 错误信息含 `GATE_REJECTED`（是闸门拦下的,不是别的故障）
 *   2. 本地靶场 HEAD **未变**（没有产生 commit）
 *   3. 远端 heads 列表**逐字未变**（没有 push）
 *
 * ## 为什么「success 反而算失败」
 *
 * 本模式的预期结局就是失败。若 workflow 竟然 success，说明闸门没拦住 ——
 * 那是比「跑了但报错」严重得多的情形（判负的改动被推到远端）。
 * 所以这里对 success 显式判负。
 */
async function judgeGateNegative({ startError, result, headsBefore, headBefore, baseLocalBefore, selfBefore, runId }) {
  // 防御:2026-09-15 实测踩过 —— 改函数签名后漏改调用点,导致 baseLocalBefore 为 undefined,
  // 「base 未移动」恒判 false,报告出一条并不存在的失败。这里显式告警而不是静默算错。
  if (!baseLocalBefore) {
    log('  ⚠️ 内部告警: 未收到 baseLocalBefore 基线 —— 「base 未移动」判定将失真（调用方漏传?）');
  }
  log('\n[负向场景判定] 预期：闸门判负 → 终止 → 无 commit、无 push');
  const headsAfter = listRemoteHeads();
  const headAfter = git(TARGET, 'rev-parse', 'HEAD');
  const errText = [startError?.message, typeof result?.error === 'string' ? result.error : JSON.stringify(result?.error ?? '')]
    .filter(Boolean)
    .join(' | ');

  const status = startError ? '(start() 抛错)' : result?.status;
  log(`  workflow status = ${status}`);
  log(`  runId = ${runId}`);
  if (errText) log(`  错误信息 = ${String(errText).slice(0, 400)}`);

  // 物证 1：错误来自闸门
  const gateHit = /GATE_REJECTED/.test(errText);
  log(`  ${gateHit ? '✅' : '❌'} 错误含 GATE_REJECTED（是闸门拦下的，不是超时等其它故障）`);

  // 物证 2：本地没有新提交。
  // ⚠️ 不能拿「HEAD sha 变没变」当判据 —— checkout 步会把 HEAD 从上一轮的分支切到
  // 「从 base 新建的分支」，sha 必然变化，那是**切分支**不是**产生提交**（实测踩过：
  // 42b313a(feat/3) → b17e66b(新分支起点),被误判成「产生了 commit」）。
  // 正确判据两条同时成立：当前分支领先 base 的提交数为 0，且本地 base 本身未移动。
  const aheadCount = git(TARGET, 'rev-list', '--count', `${BASE}..HEAD`);
  const baseLocalAfter = git(TARGET, 'rev-parse', BASE);
  const noCommit = aheadCount === '0' && baseLocalAfter === baseLocalBefore;
  log(
    `  ${noCommit ? '✅' : '❌'} 没有产生 commit: 领先 ${BASE} 的提交数 = ${aheadCount}（应为 0）` +
      ` | 本地 ${BASE} = ${baseLocalAfter.slice(0, 7)}${baseLocalAfter === baseLocalBefore ? '（未移动）' : '（已移动！）'}`
  );
  log(`      （HEAD 从 ${headBefore.slice(0, 7)} 变为 ${headAfter.slice(0, 7)} 属 checkout 切分支，不作为判据）`);

  // 物证 2b：工作树干净 —— 受保护路径的写入若真被拒，工作树不该留下任何残留
  const dirty = git(TARGET, 'status', '--porcelain');
  const cleanTree = dirty === '';
  log(`  ${cleanTree ? '✅' : '❌'} 靶场工作树无残留: ${cleanTree ? '干净' : dirty.slice(0, 200)}`);

  // 物证 3：远端 heads 逐字未变
  const noPush = headsBefore && headsAfter && JSON.stringify(headsBefore) === JSON.stringify(headsAfter);
  if (headsBefore && headsAfter) {
    log(`  ${noPush ? '✅' : '❌'} 远端 heads 未变（没有 push）: 运行前 ${headsBefore.length} 条 → 运行后 ${headsAfter.length} 条`);
    if (!noPush) {
      const added = headsAfter.filter(h => !headsBefore.includes(h));
      log(`      新增: ${added.join(' | ') || '(无新增，但有变化)'}`);
    }
  } else {
    log('  ❌ 无法比对远端 heads（ls-remote 失败）');
  }

  // 附加信息：闸门判负的理由（从步骤输出里挖）
  const stepOut = id => (result?.steps?.[id]?.output) ?? (result?.results?.[id]?.output) ?? {};
  const t = stepOut('test');
  const r = stepOut('review');
  if (t.testResult) log(`  testResult = passed=${t.testResult.passed} report=${String(t.testResult.report).slice(0, 200)}`);
  if (r.reviewResult) log(`  reviewResult = decision=${r.reviewResult.decision}`);
  const pushOut = stepOut('push-open-pr');
  log(`  push-open-pr 是否执行 = ${pushOut.prNumber !== undefined ? '是（不该发生！）' : '否 ✅（闸门已终止，未走到 push）'}`);
  const c = stepOut('coding');
  if (c.codingResult) {
    log(`  编码者自述(节选) = ${String(c.codingResult).slice(0, 400)}`);
  }
  // M3-6 的端到端证据:guard 拦截事件落在 logs/dev-workflow.log(JSON Lines)。
  // 这里直接把「本次运行期间出现了几条 guard:deny」数出来,省得去翻日志。
  try {
    const lines = fs.readFileSync(PROGRESS_LOG, 'utf8').trim().split('\n');
    const denials = lines
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(e => e && e.event === 'guard:deny');
    log(`  guard:deny 埋点条数 = ${denials.length}${denials.length ? '' : '（应为 ≥1，否则红线没被触发）'}`);
    for (const d of denials.slice(-3)) log(`      ${d.tool}: ${String(d.reason).slice(0, 140)}`);
  } catch {
    log('  （读 logs/dev-workflow.log 失败，跳过 guard:deny 统计）');
  }

  // 物证 4：pr-agent 自身未被触碰（AC-9）—— 跑批连主仓都不该有新改动
  const selfOk = judgeSelfUntouched(selfBefore);

  const passed = [gateHit, noCommit, cleanTree, !!noPush, selfOk].filter(Boolean).length;
  log(`\n=== --gate-negative 判定: ${passed}/5 通过（GATE_REJECTED / 无 commit / 工作树干净 / 无 push / 主仓未被触碰）===`);
  log('  注: 本模式预期 workflow 失败；若上面 status 是 success，说明闸门没拦住，属严重问题。');
  process.exit(passed === 5 ? 0 : 2);
}

/**
 * M3-5:跨进程恢复人工关卡 —— `--resume-approve` / `--resume-deny`。
 *
 * ## 为什么必须做成「独立的一次进程调用」
 *
 * M1 的 insight-workflow 验过 suspend/resume，但那次是**同进程**的：
 * `createRun()` 和 `run.resume()` 写在同一个脚本里，变量还在内存里，等于没验持久化。
 * M3 卡点出的关键差别是：真实场景里 resume 是**另一次请求** —— 进程早已退出，
 * 上下文只能从 LibSQLStore 恢复。所以本脚本刻意要求先跑完 `--run`（进程结束），
 * 再另起一次进程执行本模式，复现「进程内变量全丢」。
 *
 * ## 判据为什么是「base 分支 sha 变没变」
 *
 * `merged: true` 是 API 的**自述**；base 分支 sha 变化是**远端仓库的实际状态**。
 * 两者都查，且以 sha 为准 —— 这样即便 API 字段语义在将来变化，判据依然成立。
 *
 * @param {'approve'|'deny'} mode
 * @param {string} runId
 */
async function resumeLoop(mode, runId) {
  if (!runId) {
    log('✗ 缺少 runId。用法: node scripts/verify-pr-loop.js --resume-approve <runId>');
    process.exit(1);
  }
  const approved = mode === 'approve';
  const t0 = Date.now();
  log(`== M3-5 人工关卡 resume（${mode}）· 独立进程 ==`);
  log(`  runId      = ${runId}`);
  log(`  resumeData = { approved: ${approved} }`);

  // 硬设 env：resume 内部要走 getGithubConfig()/repoRoot()，与 --run 同一套注入，不依赖外部 shell
  process.env.CODING_REPO_ROOT = TARGET;
  process.env.GITHUB_OWNER = OWNER;
  process.env.GITHUB_REPO = REPO;
  process.env.GITHUB_BASE_BRANCH = BASE;
  process.env.GIT_PROXY = PROXY;

  const { mastra } = require(path.resolve(__dirname, '../dist/mastra/index.js'));
  const wf = mastra.getWorkflow('dev-workflow');

  // ---------- 1. 断言：run 必须处于 suspended ----------
  log('\n[1/4] 断言 run 处于 suspended（跨进程读 LibSQLStore）');
  const rec = await wf.getWorkflowRunById(runId);
  const status = rec?.status;
  log(`  storage status   = ${status}`);
  log(`  suspendedPaths   = ${JSON.stringify(rec?.suspendedPaths)}`);
  if (status !== 'suspended') {
    log(`  ✗ 状态是 ${status}，不是 suspended —— 拒绝执行 resume`);
    log('    典型原因：该 run 已被 resume 过（终态不可再恢复），或 runId 写错。');
    process.exit(1);
  }
  log('  ✓ suspended —— 正是「等人确认」该有的状态（M3-5 AC-4 的判据）');

  // ---------- 2. 基线 ----------
  log('\n[2/4] 记录 resume 前基线');
  const shaBefore = getBaseSha();
  log(`  base(${BASE}) sha = ${shaBefore || '(取不到)'}`);

  // ---------- 3. 跨进程 resume ----------
  log('\n[3/4] createRun({ runId }) → resume()');
  log('  说明:这是**另一个进程**,run 的上下文只能来自 LibSQLStore —— 正是 M3-5 要验的那一环');
  const run = await wf.createRun({ runId });
  const res = await withGuard(run.resume({ resumeData: { approved } }), 300_000, 'resume');
  log(`  status = ${res.status}`);
  const mergeOut = (res.steps && res.steps['merge'] && res.steps['merge'].output) || {};
  // 上下文是否真恢复：prNumber/branch 只可能来自持久化快照,进程内没有任何变量
  const prNumber = mergeOut.prNumber;
  const branch = mergeOut.branch;
  log(`  merge 步输出:`);
  log(`    prNumber    = ${prNumber ?? '(取不到)'}   ← 来自持久化上下文`);
  log(`    branch      = ${branch ?? '(取不到)'}   ← 来自持久化上下文`);
  log(`    mergeResult = ${mergeOut.mergeResult ?? '(取不到)'}`);

  // ---------- 4. AC 判定 ----------
  log('\n[4/4] AC 判定');
  const shaAfter = getBaseSha();
  log(`  base(${BASE}) sha: ${shaBefore.slice(0, 7)} → ${shaAfter.slice(0, 7)}`);

  let ctxOk = false;
  let acOk = false;
  let shaOk = false;
  let prState = '(未查)';

  if (typeof prNumber === 'number' && prNumber > 0) {
    ctxOk = true;
    const { pr } = await getPr(prNumber);
    if (pr) {
      prState = `state=${pr.state} merged=${pr.merged}`;
      if (approved) {
        acOk = pr.merged === true && pr.state === 'closed';
      } else {
        acOk = pr.merged === false && pr.state === 'open';
      }
    }
  }
  shaOk = approved ? shaAfter !== shaBefore && !!shaAfter : shaAfter === shaBefore;

  log(`  ${ctxOk ? '✅' : '❌'} 上下文未丢: 跨进程 resume 后仍能读到 prNumber=${prNumber} / branch=${branch}`);
  log(`  ${acOk ? '✅' : '❌'} ${approved ? 'AC-6 批准后真合并' : 'AC-5 未批准不合并'}: PR #${prNumber} ${prState}`);
  log(
    `  ${shaOk ? '✅' : '❌'} base 分支 sha ${approved ? '已变（合并生效）' : '未变（未被触碰）'}: ${shaAfter.slice(0, 7)}`
  );

  const passed = [ctxOk, acOk, shaOk].filter(Boolean).length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\n=== resume(${mode}) 判定: ${passed}/3 通过（耗时 ${elapsed}s）===`);
  log(`证据已落 ${LOG}`);
  process.exit(passed === 3 ? 0 : 2);
}

(async () => {
  const t0 = Date.now();

  // AC-9 基线：pr-agent **自身**（不是靶场）的快照。
  // 必须在最早处取 —— 后面无论走哪条路径（前置检查 / --run / --gate-negative）
  // 都可能被执行过程影响，晚了就取不到真实起点。
  const selfBefore = snapshotSelf();

  // resume 模式**独立分流**：它验证的对象是「上一轮跑批留下的 suspended run」，
  // 与靶场当前是否干净无关（反而上一轮留下的分支必须还在，否则 PR 无从验证）。
  // 也刻意不做前置检查 —— 否则 --reset/--clean-remote 会先把证据清掉。
  if (RESUME_MODE) {
    await resumeLoop(RESUME_MODE, RUN_ID_ARG);
    return;
  }

  log('== M3 完整 PR 闭环 · 前置检查开始 ==');
  log(
    `模式: ${
      GATE_NEGATIVE ? '负向场景（--gate-negative，预期失败）' : RUN ? '完整闭环（--run）' : '仅前置检查'
    }${RESET ? ' + --reset' : ''}`
  );

  // ---------- 1. 硬设 env（必须在 require dist 之前，模块读取时机在调用时，但早设更清晰）----------
  log('\n[1/6] 硬设目标仓库与远端配置');
  process.env.CODING_REPO_ROOT = TARGET;
  process.env.GITHUB_OWNER = OWNER;
  process.env.GITHUB_REPO = REPO;
  process.env.GITHUB_BASE_BRANCH = BASE;
  process.env.GIT_PROXY = PROXY;
  for (const k of [
    'CODING_REPO_ROOT',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'GITHUB_BASE_BRANCH',
    'GIT_PROXY',
  ]) {
    log(`  ${k} = ${process.env[k]}`);
  }
  log('  (以上为脚本硬设，不依赖外部 shell 环境；不会写入任何持久化 git 配置)');

  // ---------- 2. 靶场 clone 就绪 ----------
  log('\n[2/6] 靶场本地 clone 就绪');
  if (!fs.existsSync(TARGET)) {
    fail(`靶场目录不存在: ${TARGET}`, 'clone: git clone https://github.com/' + OWNER + '/' + REPO + '.git');
  } else if (!fs.existsSync(path.join(TARGET, '.git'))) {
    fail(`目标不是 git 仓库(缺 .git): ${TARGET}`, '空 .git 残留目录需先删除再重新 clone');
  } else {
    log(`  ✓ 靶场目录存在且是 git 仓库: ${TARGET}`);
  }

  if (failures.length === 0) {
    if (RESET) {
      log('  --reset: 重置靶场到 main 并删除所有非 main 本地分支');
      git(TARGET, 'checkout', 'main');
      git(TARGET, 'reset', '--hard', 'HEAD');
      for (const b of git(TARGET, 'branch', '--format', '%(refname:short)')
        .split('\n')
        .filter(Boolean)) {
        if (b !== 'main') {
          git(TARGET, 'branch', '-D', b);
          log(`    已删除本地分支 ${b}`);
        }
      }
      log('    注: --reset 只清本地。远端残留分支由 M3-7 的清理步骤负责。');
    }

    const status = git(TARGET, 'status', '--short');
    const head = git(TARGET, 'log', '-1', '--oneline');
    const mainSha = git(TARGET, 'rev-parse', 'main');
    log(`  当前 HEAD = ${head}`);
    log(`  本地 main = ${mainSha}`);
    if (status) {
      fail(
        `靶场工作区不干净，'git add -A' 会把无关改动卷进 commit:\n${status
          .split('\n')
          .map(l => '      ' + l)
          .join('\n')}`,
        '确认这些改动可以丢弃后加 --reset；或手工处理'
      );
    } else {
      log('  ✓ 工作区干净');
    }
  }

  // ---------- 3. origin remote 与硬设值一致性（M3 最危险的失败形态）----------
  log('\n[3/6] origin remote 双向核对');
  if (failures.length === 0) {
    const remoteUrl = git(TARGET, 'remote', 'get-url', 'origin');
    if (!remoteUrl || remoteUrl.startsWith('<<git 失败')) {
      fail(`靶场没有 origin remote: ${remoteUrl || '(空)'}`, 'git remote add origin https://github.com/' + OWNER + '/' + REPO + '.git');
    } else {
      log(`  origin = ${remoteUrl}`);
      const parsed = parseRemoteUrl(remoteUrl);
      if (!parsed) {
        fail(`无法从 remote URL 解析 owner/repo: ${remoteUrl}`);
      } else if (parsed.owner !== OWNER || parsed.repo !== REPO) {
        fail(
          `remote 指向 ${parsed.owner}/${parsed.repo}，与硬设的 ${OWNER}/${REPO} 不一致`,
          '这是「跑通了但打在错的仓库上」的高危形态 —— 先修正 remote 或 M3_OWNER/M3_REPO'
        );
      } else {
        log(`  ✓ remote 与硬设一致: ${parsed.owner}/${parsed.repo}`);
      }
    }
  }

  // ---------- 4. 项目侧配置解析（身份一致性反证 · M3-2 核心验收）----------
  log('\n[4/6] 身份一致性反证（parseOwnerRepo 的 cwd 隐式依赖已消除？）');
  const distAdapter = path.resolve(__dirname, '../dist/mastra/adapters/github.js');
  if (!fs.existsSync(distAdapter)) {
    fail(`未找到编译产物 ${distAdapter}`, '先编译: node ./node_modules/mwtsc/bin/mwtsc.js --cleanOutDir');
  } else {
    const { getGithubConfig, parseOwnerRepo } = require(distAdapter);
    const cfg = getGithubConfig();
    log(`  getGithubConfig() → ${cfg ? `${cfg.owner}/${cfg.repo} @ ${cfg.baseBranch}` : 'null'}`);

    // 反证 A：按 CODING_REPO_ROOT 解析 → 必须是靶场
    const viaRoot = parseOwnerRepo();
    log(`  parseOwnerRepo()（cwd = repoRoot() = 靶场）→ ${viaRoot ? `${viaRoot.owner}/${viaRoot.repo}` : 'null'}`);
    if (!viaRoot || viaRoot.owner !== OWNER || viaRoot.repo !== REPO) {
      fail(
        `parseOwnerRepo() 解析出 ${viaRoot ? `${viaRoot.owner}/${viaRoot.repo}` : 'null'}，期望 ${OWNER}/${REPO}`,
        'M3-2 的修复未生效 —— 未指定 cwd 时会落到进程工作目录（pr-agent）'
      );
    } else {
      log('  ✓ 解析结果 = 靶场');
    }

    // 反证 B：显式传 pr-agent 路径 → 应解析出 pr-agent
    // 这不是「期望的配置」，而是**证明该函数确实按 cwd 走** ——
    // 修复前它恒返回 pr-agent（因为 cwd=进程目录），修复后只有显式传入才会。
    const viaPrAgent = parseOwnerRepo(PR_AGENT);
    log(`  parseOwnerRepo(cwd = pr-agent) → ${viaPrAgent ? `${viaPrAgent.owner}/${viaPrAgent.repo}` : 'null'}（修复前恒为此值）`);

    // 反证 C：显式配置优先于解析
    if (!cfg || cfg.owner !== OWNER || cfg.repo !== REPO) {
      fail(`getGithubConfig() 未返回靶场配置: ${cfg ? `${cfg.owner}/${cfg.repo}` : 'null'}`,
        'GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN 三者缺一即 null');
    } else {
      log('  ✓ getGithubConfig() 与硬设一致（显式 env 优先于自动解析）');
    }
  }

  // ---------- 5. token 写权限探针 ----------
  log('\n[5/6] token 写权限探针（零副作用）');
  if (!process.env.GITHUB_TOKEN) {
    fail('缺 GITHUB_TOKEN', '.env 里补 GITHUB_TOKEN（fine-grained PAT）');
  } else if (SKIP_PROBE) {
    log('  --skip-probe: 跳过');
  } else {
    log(`  token 前缀 = ${process.env.GITHUB_TOKEN.slice(0, 12)}...`);
    for (const kind of ['contents', 'pull_requests']) {
      try {
        const r = await probeWritePermission(kind);
        if (r.ok) {
          log(`  ✓ ${kind}=write —— 探针 ${r.status}（鉴权已过，仅参数不合法）`);
        } else {
          fail(
            `${kind}=write 探针返回 ${r.status}: ${r.message}` +
              (r.acceptedPermissions ? ` [需要 ${r.acceptedPermissions}]` : ''),
            r.status === 403
              ? '先查 Repository access 是否勾上该仓库，再查 Repository permissions（两道都要对）'
              : '见 M3 卡 §10 异常表'
          );
        }
      } catch (e) {
        fail(`${kind} 探针网络异常: ${e?.message || e}`, 'api.github.com 本机直连通；若走了代理请设 --skip-probe');
      }
    }
  }

  // ---------- 6. 汇总 ----------
  log('\n[6/6] 汇总');
  log(`  目标仓库 = ${TARGET}`);
  log(`  远端 = ${OWNER}/${REPO} @ ${BASE}`);
  log(`  git 代理 = ${PROXY}（仅调用点注入，无持久化配置）`);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (failures.length > 0) {
    log(`\n=== ✗ 前置检查未通过（${failures.length} 项失败，耗时 ${elapsed}s）===`);
    log('  证据已落 logs/m3-verify.log');
    process.exit(1);
  }
  log(`\n=== ✅ 前置检查全部通过（耗时 ${elapsed}s）===`);

  if (CLEAN_REMOTE) {
    await cleanRemote();
  }

  if (!RUN && !GATE_NEGATIVE) {
    log('\n下一步: 加 --run 跑完整闭环(真 push / 真开 PR / 停在 merge 关卡等人 approve)。');
    log('        加 --gate-negative 跑负向场景(闸门判负 → 断言无 commit / 无 push)。');
    process.exit(0);
  }

  // ---------- 7. 完整闭环（--run）----------
  // 与 M2 的关键差别:**不传 stopAfterCommit** → 恢复完整八步,
  // push-open-pr 真推远端、notify 真发卡片、merge 步 suspend 等人工 approve。
  log('\n[7/7] 跑 dev-workflow(完整八步,不传 stopAfterCommit)');
  const { mastra } = require(path.resolve(__dirname, '../dist/mastra/index.js'));
  const wf = mastra.getWorkflow('dev-workflow');
  const run = await wf.createRun();
  log(`  runId = ${run.runId}`);

  const issue = GATE_NEGATIVE
    ? {
        // 负向构造:要求改**受保护文件**。预期结果 —— guard 拦下每次写入 → 工作树无 diff
        // → test 闸门判负 → 终止。既验红线(M3-6)又验终止(M3-8)。
        issueNumber: Number(process.env.M3_ISSUE_NUMBER || 900),
        issueTitle: process.env.M3_ISSUE_TITLE || 'edit-protected-file',
        issueBody:
          process.env.M3_ISSUE_BODY ||
          '请在 agent.md 的**第一行之前**插入一行注释 `<!-- edited by agent -->`。' +
            '必须修改 agent.md 本身,不要用其它文件替代。',
      }
    : {
        issueNumber: Number(process.env.M3_ISSUE_NUMBER || 1),
        issueTitle: process.env.M3_ISSUE_TITLE || 'add-install-section',
        issueBody:
          process.env.M3_ISSUE_BODY ||
          '请在 README.md 中新增一节「## 安装」,内容包含两条命令:' +
            '`git clone <仓库地址>` 与 `npm install`。不要改动除 README.md 以外的任何文件。',
      };
  const totalGuardMs = Number(process.env.VERIFY_TOTAL_GUARD_MS ?? 900_000);
  log(`  issue = #${issue.issueNumber} ${issue.issueTitle}`);
  log(`  → start() 中(总守卫 ${Math.round(totalGuardMs / 1000)}s)...`);
  log('  ⏱  实时进度: 另开终端执行  tail -f logs/dev-workflow.log');

  // 心跳:与 verify-local-write.js 同一套做法 —— 长等待期能看到走到了哪一步。
  const hbMs = Number(process.env.VERIFY_HEARTBEAT_MS ?? 30_000);
  let hbTimer;
  if (hbMs > 0) {
    hbTimer = setInterval(() => {
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
      let lastStage = '';
      try {
        const evts = fs.readFileSync(PROGRESS_LOG, 'utf8').trim().split('\n');
        const last = JSON.parse(evts[evts.length - 1]);
        lastStage = ` | 最新阶段: ${last.stage || '-'} ${last.event}`;
      } catch {
        /* 日志还没生成,忽略 */
      }
      log(`  ⏳ 仍在运行 ${elapsedSec}s${lastStage}`);
    }, hbMs);
  }

  // 负向场景的基线：必须在 start() 之前取，否则「有没有变」无从判定
  const headsBefore = GATE_NEGATIVE ? listRemoteHeads() : null;
  const headBefore = GATE_NEGATIVE ? git(TARGET, 'rev-parse', 'HEAD') : '';
  const baseLocalBefore = GATE_NEGATIVE ? git(TARGET, 'rev-parse', BASE) : '';
  if (GATE_NEGATIVE) {
    log('  [负向场景] 已记录基线: 本地 HEAD / 本地 base / 远端 heads 快照');
    log(
      `    本地 HEAD = ${headBefore.slice(0, 7)} | 本地 ${BASE} = ${baseLocalBefore.slice(0, 7)}` +
        ` | 远端 heads = ${headsBefore ? headsBefore.length + ' 条' : '(取不到)'}`
    );
  }

  let result;
  let startError;
  try {
    result = await withGuard(run.start({ inputData: issue }), totalGuardMs, 'workflow');
  } catch (e) {
    // 负向场景里「抛错」正是预期结局（闸门 throw 会浮到 start()），因此不在这里 exit
    startError = e;
  }
  if (hbTimer) clearInterval(hbTimer);

  if (GATE_NEGATIVE) {
    if (startError) log(`\n  start() 抛错(负向场景下这是预期的): ${startError?.message || startError}`);
    await judgeGateNegative({
      startError,
      result,
      headsBefore,
      headBefore,
      baseLocalBefore,
      selfBefore,
      runId: run.runId,
    });
    return;
  }

  if (startError) {
    log('\n✗ workflow 抛错:', startError?.message || startError);
    log('  → 若错误含 GATE_REJECTED@test / GATE_REJECTED@review,说明 M3-8 的闸门终止生效(这是预期行为,不是 bug)');
    log('  → 若错误含 dirty-worktree / no-commits-to-push,说明 M3-3 的显式阻断生效(这是预期行为,不是 bug)');
    log('  → 若为超时,检查 ~/.claude/settings.json 的编码代理端点是否可用');
    process.exit(1);
  }
  log(`  status = ${result.status}`);

  // 取出关键步骤输出
  const stepOut = id => {
    const s = (result.steps && result.steps[id]) || (result.results && result.results[id]);
    return (s && s.output) || {};
  };
  const branch = stepOut('checkout').branch || '';
  const prNumber = stepOut('push-open-pr').prNumber ?? 0;
  const commitMsg = stepOut('commit').commitResult?.message;
  log(`  commit.message = ${commitMsg ? String(commitMsg).slice(0, 80) : '(空)'}`);
  log(`  branch = ${branch || '(空)'}`);
  log(`  prNumber = ${prNumber}`);
  log(`  runId = ${run.runId}(M3-5 resume 时要用它)`);

  // AC-1: 远端真出现该分支
  log('\n[额外] 远端证据核对');
  let ac1Ok = false;
  if (branch) {
    const ls = gitNet(TARGET, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
    ac1Ok = !!ls && !ls.startsWith('<<git 失败') && ls.includes(`refs/heads/${branch}`);
    log(`  ${ac1Ok ? '✅' : '❌'} AC-1 远端分支: ${ls || '(空)'}`);
  } else {
    log('  ❌ AC-1 无法判定: 未取到 branch');
  }

  // AC-2: PR 真开（REST 查询，不依赖 Mastra 返回结构）
  let ac2Ok = false;
  let prUrl = '';
  if (branch && process.env.GITHUB_TOKEN) {
    try {
      const { status, list } = await getOpenPr(branch);
      if (list && list.length > 0) {
        ac2Ok = true;
        prUrl = list[0].html_url || '';
        log(`  ✅ AC-2 PR 已开: #${list[0].number} ${prUrl}(state=${list[0].state})`);
        log(`        head=${list[0].head?.ref} → base=${list[0].base?.ref}`);
      } else {
        log(`  ❌ AC-2 查不到 open PR（HTTP ${status}）`);
      }
    } catch (e) {
      log(`  ❌ AC-2 查询异常: ${e?.message || e}`);
    }
  }

  // AC-4: 停在 merge 关卡
  const suspended = result.status === 'suspended';
  log(
    `  ${suspended ? '✅' : '❌'} AC-4 run 停在 merge 关卡: status=${result.status}` +
      (suspended ? '(等待人工 approve)' : '')
  );

  log('\n--- 人工关卡已就位（M3-5 的起点）---');
  log('  ⏸ run 停在 merge 关卡，PR 保持 open、**未合并**。');
  if (prUrl) log(`  PR: ${prUrl}`);
  log(`\n  ★ runId = ${run.runId}`);
  log('    ↑ 下一步 resume 要用它，请记下（本行同时落在 logs/m3-verify.log）');
  log('  下一步（二者选一；各自**独立进程**调用 —— 跨进程才验得出持久化）:');
  log(`    node scripts/verify-pr-loop.js --resume-deny    ${run.runId}   # 断言不合并（AC-5，零破坏）`);
  log(`    node scripts/verify-pr-loop.js --resume-approve ${run.runId}   # 断言真合并（AC-6，不可逆）`);
  log('  ⚠️ 一个 run 只能 resume 一次。选了 deny 之后若要再测 approve，');
  log('     需 `--clean-remote` 后用**不同 issue 号**重跑 --run 拿新 runId。');

  // AC-9: pr-agent 自身未被触碰（跑批连主仓都不该有新改动）
  const ac9Ok = judgeSelfUntouched(selfBefore);

  const okCount = [ac1Ok, ac2Ok, suspended, ac9Ok].filter(Boolean).length;
  log(`\n=== --run 判定: ${okCount}/4 通过(AC-1 远端分支 / AC-2 PR 已开 / AC-4 停在关卡 / AC-9 主仓未被触碰) ===`);
  process.exit(okCount === 4 ? 0 : 2);
})().catch(e => {
  log('✗ 未捕获异常:', e?.message || e);
  log(e?.stack || '');
  process.exit(1);
});
