/**
 * M3「完整 PR 闭环」端到端验证。
 *
 * ## 当前阶段（2026-09-15 · M3-2 ✅ / M3-3 ✅）
 * **已实现**（前置检查 6 段 + 闭环 1 段）：
 *   1. **硬设五个 env**（`CODING_REPO_ROOT` / `GITHUB_OWNER` / `GITHUB_REPO` /
 *      `GITHUB_BASE_BRANCH` / `GIT_PROXY`），**不依赖外部 shell 环境**
 *      —— 与 `verify-local-write.js` 同一安全模式。这是防「静默打在 pr-agent 自己身上」的关键。
 *   2. **前置检查**：靶场 clone 就绪 / 有 origin remote / remote 指向与硬设值一致 /
 *      工作区干净 / token 两个写权限探针（零副作用）。
 *   3. **身份一致性反证**：证明 `parseOwnerRepo()` 不再解析成 `wintim1143/pr-agent`
 *      —— M3-2 的核心验收（修复前会把 PR 开到 pr-agent 身上）。
 *   4. **`--run` 完整闭环**：真 push / 真开 PR / 停在 merge 关卡（M3-3）；
 *      resume 与 merge 语义属 M3-5，本轮止于 `suspended`。
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
 * ## 用法
 *   node scripts/verify-pr-loop.js                 # 前置检查（默认；不跑 workflow）
 *   node scripts/verify-pr-loop.js --run           # 完整闭环：真 push / 真开 PR / 停在 merge 关卡
 *   node scripts/verify-pr-loop.js --reset         # 先重置靶场**本地**分支状态再检查
 *   node scripts/verify-pr-loop.js --clean-remote  # 清理靶场**远端** feat/* 分支与其 open PR
 *   node scripts/verify-pr-loop.js --skip-probe    # 跳过 token 写权限探针（离线时用）
 *
 * ⚠️ **重跑须知**：`--reset` 只清本地。远端残留的 `feat/*` 分支会让下次 push 变成
 * **非快进被拒**（本地分支从 main 重建，远端却已多一个提交）。重跑前先 `--clean-remote`。
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

(async () => {
  const t0 = Date.now();
  log('== M3 完整 PR 闭环 · 前置检查开始 ==');
  log(`模式: ${RUN ? '完整闭环（--run）' : '仅前置检查'}${RESET ? ' + --reset' : ''}`);

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

  if (!RUN) {
    log('\n下一步: 加 --run 跑完整闭环(真 push / 真开 PR / 停在 merge 关卡等人 approve)。');
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

  const issue = {
    issueNumber: 1,
    issueTitle: 'add-install-section',
    issueBody:
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

  let result;
  try {
    result = await withGuard(run.start({ inputData: issue }), totalGuardMs, 'workflow');
  } catch (e) {
    if (hbTimer) clearInterval(hbTimer);
    log('\n✗ workflow 抛错:', e?.message || e);
    log('  → 若错误含 dirty-worktree / no-commits-to-push,说明 M3-3 的显式阻断生效(这是预期行为,不是 bug)');
    log('  → 若为超时,检查 ~/.claude/settings.json 的编码代理端点是否可用');
    process.exit(1);
  }
  if (hbTimer) clearInterval(hbTimer);
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

  // 本轮不 resume —— merge 关卡的人工确认属 M3-5。
  log('\n[本轮不 resume] merge 人工关卡属 M3-5,本次止于 suspended 状态。');
  if (prUrl) {
    log(`  该 PR 现在 open 且未合并,可在 GitHub 上人工查看: ${prUrl}`);
  }
  log(`  下一步(M3-5): 用 runId=${run.runId} 调 resume({approved:false / true}) 验证关卡语义`);
  log('  注意: resume 需要同一 LibSQLStore(mastra.db)与同一进程外入口,见 M3 卡 §7 M3-5');

  const okCount = [ac1Ok, ac2Ok, suspended].filter(Boolean).length;
  log(`\n=== --run 判定: ${okCount}/3 通过(AC-1 远端分支 / AC-2 PR 已开 / AC-4 停在关卡) ===`);
  process.exit(okCount === 3 ? 0 : 2);
})().catch(e => {
  log('✗ 未捕获异常:', e?.message || e);
  log(e?.stack || '');
  process.exit(1);
});
