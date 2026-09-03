/**
 * GitHub adapter —— K6(原 GitHub 桩)的落地实现。
 *
 * 设计取舍(先读环境再动手,非猜):
 * - `checkout`(建分支) 走本地 `git`(纯本地操作,不需要 GitHub 鉴权)。
 * - `push-open-pr` 走两件事:
 *   1. `git push` —— 用显式 `GITHUB_TOKEN` 内嵌 HTTPS URL 推分支(CI 标准做法,不依赖 SSH/gh);
 *   2. 开 PR / merge —— **全部走 GitHub REST API**(`fetch`),**不依赖 `gh` CLI**(K5 决策:macOS 无
 *      Homebrew、不引入外部二进制,统一 REST 保证跨平台行为一致)。
 * - owner/repo 优先读 `GITHUB_OWNER`/`GITHUB_REPO`,留空则自动从 `git remote get-url origin` 解析。
 * - `GITHUB_TOKEN` 是唯一鉴权来源(fine-grained PAT,需 Contents + Pull requests 写权限)。
 *
 * 重要:本模块**加载时不抛错**(否则拖垮 `npm test` 与 `GET /api/agents` 仅列元数据的场景),
 * 所有校验/报错都延迟到调用 `githubCheckout` / `githubPushAndOpenPR` / `githubMergePR` 时才暴露。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 统一 REST 调用:失败(<2xx)抛 `GithubApiError`(含 status + 响应体),供调用方判读。 */
async function githubRequest<T>(
  cfg: { owner: string; repo: string; token: string },
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const resp = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!resp.ok) {
    const msg = (raw && (raw.message || raw.errors)) || `HTTP ${resp.status}`;
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path} → ${resp.status}: ${JSON.stringify(msg)}`);
  }
  return raw as T;
}

export interface GithubConfig {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

/** 仓库根目录(git 工作树顶层) */
function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** 从 git remote 解析 owner/repo(支持 SSH 与 HTTPS 两种 remote URL) */
function parseOwnerRepo(): { owner: string; repo: string } | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {
    /* 无 remote 时返回 null */
  }
  return null;
}

/** issue 标题转分支 slug */
function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'task';
}

/** 读取 GitHub 配置;缺少 token 或无法解析 owner/repo 时返回 null */
export function getGithubConfig(): GithubConfig | null {
  const token = process.env.GITHUB_TOKEN;

  let owner = process.env.GITHUB_OWNER;
  let repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    const parsed = parseOwnerRepo();
    owner = owner || parsed?.owner;
    repo = repo || parsed?.repo;
  }
  if (!owner || !repo || !token) return null;

  const baseBranch = process.env.GITHUB_BASE_BRANCH || 'main';
  return { token, owner, repo, baseBranch };
}

/** 返回缺失的配置项(用于验证脚本提示用户去哪补) */
export function missingGithubConfig(): string[] {
  const miss: string[] = [];
  if (!process.env.GITHUB_TOKEN) {
    miss.push('GITHUB_TOKEN(fine-grained PAT,需 Contents + Pull requests 写权限)');
  }
  let owner = process.env.GITHUB_OWNER;
  let repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    const p = parseOwnerRepo();
    owner = owner || p?.owner;
    repo = repo || p?.repo;
  }
  if (!owner) miss.push('GITHUB_OWNER(或留空自动从 git remote 解析)');
  if (!repo) miss.push('GITHUB_REPO(或留空自动从 git remote 解析)');
  return miss;
}

/** 工作树是否脏(有已暂存或未暂存改动) */
function isDirty(root: string): boolean {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: root, stdio: 'pipe' });
  } catch {
    return true; // 有已暂存改动
  }
  try {
    execFileSync('git', ['diff', '--quiet'], { cwd: root, stdio: 'pipe' });
  } catch {
    return true; // 有未暂存改动
  }
  return false;
}

/** 分支是否存在 */
function branchExists(root: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** 实际 git 目录(worktree 场景下是 `.git/worktrees/<name>` 而非 `.git`)。`--git-dir` 返回相对 cwd 的路径,需 join。 */
function gitDir(root: string): string {
  const dir = execFileSync('git', ['rev-parse', '--git-dir'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return join(root, dir);
}

/** 当前分支名;HEAD 处于 detached 时返回 null */
function currentBranch(root: string): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 确保 `refs/heads/<当前分支>` 的 ref 文件**真的落盘**。
 *
 * ## 为什么需要这一层
 *
 * 本环境(PortableGit + 沙箱)存在间歇性缺陷:**部分写 ref 的 git 操作会假成功** ——
 * exit 0、输出正常,但 `.git/refs/heads/<branch>` 没被写入。已实测到的两种:
 *
 * 1. `git checkout -b <branch> <base>`(2026-09-03 踩中):写了 `.git/HEAD` 却没写 ref,
 *    仓库进入 unborn 状态;后续 `git add -A && git commit` 把**整个工作树**当成新文件
 *    提交成孤儿 commit(实测 66 files / 23647 insertions),历史全丢。
 * 2. `git commit`:偶发不更新 ref 文件。
 *
 * 拆解后经实测可靠的命令:
 * - `git checkout <branch>`      —— 切到**已存在**的 ref ✅(只写 HEAD,不动 ref)
 * - 直接写 ref 文件 ✅(但**必须先 mkdir 父目录**:分支名含斜杠时 ref 路径是
 *   `refs/heads/<dir>/<name>`,PortableGit 的 `git branch`/`git update-ref` 在创建含斜杠分支时
 *   会假成功——退出 0 却连 `refs/heads/<dir>/` 目录都没建,导致后续 `git commit` 把整棵工作树
 *   当新文件提交成孤儿 commit。所以建分支一律走 `createBranchVerified` 的 fs 兜底。)
 *
 * ## 为什么先校验再写,而不是无条件写
 *
 * 无条件覆盖有风险(detached HEAD / 并发提交)。所以先比对 `git rev-parse HEAD`,
 * 只有不一致时才补写;写完再校验一次,仍不通过则抛错 ——
 * **宁可显式失败,也不要静默把提交丢进孤儿对象**。
 */
function ensureRefFlushed(root: string, expectedSha: string): void {
  const readHead = (): string | null => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  };

  if (readHead() === expectedSha) return;

  const branch = currentBranch(root);
  if (!branch) {
    throw new Error(`ref 未落盘且 HEAD 处于 detached 状态,无法自动修复(期望 ${expectedSha})`);
  }
  const refPath = join(gitDir(root), 'refs', 'heads', branch);
  // 分支名可能含斜杠(如 feat/123-xxx)→ ref 落盘路径需先在 refs/heads/ 下建子目录。
  // 本环境 PortableGit 对"含斜杠分支的 ref 写入"会假成功(目录未建却 exit 0),故这里显式 mkdir 兜底。
  mkdirSync(dirname(refPath), { recursive: true });
  writeFileSync(refPath, `${expectedSha}\n`);

  if (readHead() !== expectedSha) {
    const actual = existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() : '<文件不存在>';
    throw new Error(
      `ref 落盘校验失败:已写 ${refPath} = ${expectedSha},但 git 读到 ${actual}。` +
        '这是本环境已知的 PortableGit ref-not-flushed 缺陷,需人工介入。'
    );
  }
}

/**
 * 创建分支并校验 ref 落盘。
 *
 * **不能用 `git checkout -b <branch> <base>`** —— 见 `ensureRefFlushed` 的说明,
 * 它在本环境会假成功并让仓库进入 unborn 状态。拆成 `git branch` + `git checkout` 两步。
 */
function createBranchVerified(root: string, branch: string, base: string): void {
  execFileSync('git', ['branch', branch, base], { cwd: root, stdio: 'pipe' });
  if (!branchExists(root, branch)) {
    // 兜底:直接写 ref 文件(本环境实测可靠的落盘手段)。
    // 注意:分支名含斜杠(如 feat/123-xxx)时,ref 路径需先在 refs/heads/ 下建子目录,
    // 否则 writeFileSync 会因目录不存在而 ENOENT。PortableGit 的 git branch/update-ref
    // 对此会假成功(目录未建却 exit 0),故这里显式 mkdir 兜底。
    const sha = execFileSync('git', ['rev-parse', base], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const refPath = join(gitDir(root), 'refs', 'heads', branch);
    mkdirSync(dirname(refPath), { recursive: true });
    writeFileSync(refPath, `${sha}\n`);
  }
  if (!branchExists(root, branch)) {
    throw new Error(`创建分支 ${branch} 失败:ref 未落盘(PortableGit ref-not-flushed 缺陷)`);
  }
}

/** 从 `git commit` 输出中提取新提交 SHA,如 `[main abc1234] feat: x` / `[b (root-commit) abc1234] x` */
function parseCommitSha(output: string): string | null {
  const m = output.match(/\[[^\]]*?([0-9a-f]{7,40})\]/);
  return m ? m[1] : null;
}

/** 计算 branch 领先 base 的提交数 */
function countAhead(root: string, base: string, branch: string): number {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${base}..${branch}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * 真正执行一次 git 提交(供 commit 步与 push-open-pr 兜底使用)。
 * - 先 `git add -A`(仅暂跟踪内文件;`.env` 等 gitignore 项不会被加入)
 * - 若没有任何改动可提交,返回 { committed:false, error:'nothing-to-commit' }
 */
export function gitCommit(
  message: string,
  root: string = repoRoot()
): {
  committed: boolean;
  error?: string;
} {
  try {
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
    const out = execFileSync('git', ['commit', '-m', message], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // commit 在本环境同样可能假成功(exit 0 但 ref 未更新)→ 显式校验并兜底补写
    const shortSha = parseCommitSha(out);
    if (shortSha) {
      const full = execFileSync('git', ['rev-parse', shortSha], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      ensureRefFlushed(root, full);
    }
    return { committed: true };
  } catch (e) {
    const msg =
      e instanceof Error
        ? (e as NodeJS.ErrnoException & { stderr?: Buffer | string }).stderr?.toString() || e.message
        : String(e);
    if (/nothing to commit/i.test(msg)) return { committed: false, error: 'nothing-to-commit' };
    return { committed: false, error: msg };
  }
}

/**
 * checkout 步:基于 issue 创建并切到 feature 分支 `feat/<n>-<slug>`。
 * 不抛错——失败时由调用方降级为占位分支名,后续 push-open-pr 会再次暴露错误。
 */
export async function githubCheckout(issueNumber: number, issueTitle: string): Promise<string> {
  const root = repoRoot();
  const branch = `feat/${issueNumber}-${slug(issueTitle)}`;
  const base = getGithubConfig()?.baseBranch || 'main';
  // 红线:绝不允许在 base 分支上直接开发。同名说明 issue 标题 slug 退化成了 base 名。
  if (branch === base) {
    throw new Error(`拒绝 checkout:目标分支 ${branch} 与 base 分支 ${base} 同名(不得在 base 分支上直接开发)`);
  }
  if (!branchExists(root, branch)) {
    createBranchVerified(root, branch, base);
  }
  execFileSync('git', ['checkout', branch], { cwd: root, stdio: 'pipe' });
  return branch;
}

export interface PushPrResult {
  prNumber: number;
  prUrl: string | null;
  skipped?: boolean;
  error?: string;
}

/**
 * push-open-pr 步:把当前分支推到 origin 并开 PR。
 * - 未配置 GitHub(token 缺失或无法解析 owner/repo)→ 返回 { prNumber:0, skipped:true }
 * - 工作树脏(commit 步没提交成功)→ 用 commitMessage 兜底补一个提交
 * - 没有任何领先 base 的提交 → 返回 { prNumber:0, error:'no-commits-to-push' }(PR 会是空的)
 * - 失败(推送/开 PR 异常)→ 返回 { prNumber:0, error:<原因> },不抛
 */
export async function githubPushAndOpenPR(opts: {
  branch: string;
  title: string;
  body: string;
  baseBranch?: string;
  commitMessage?: string;
}): Promise<PushPrResult> {
  const cfg = getGithubConfig();
  if (!cfg) {
    return { prNumber: 0, prUrl: null, skipped: true };
  }
  const root = repoRoot();
  const branch = opts.branch;
  const base = opts.baseBranch || cfg.baseBranch;

  try {
    // 1) 兜底提交:工作树脏则补一个提交,保证 PR 非空
    if (isDirty(root)) {
      const cr = gitCommit(opts.commitMessage || `chore: auto-dev ${branch}`, root);
      if (!cr.committed) {
        return { prNumber: 0, prUrl: null, error: `git-commit-failed: ${cr.error ?? 'unknown'}` };
      }
    }
    // 2) 是否有领先 base 的提交
    const ahead = countAhead(root, base, branch);
    if (ahead === 0) {
      return { prNumber: 0, prUrl: null, error: 'no-commits-to-push' };
    }
    // 3) 推送(用 token 内嵌 HTTPS URL,不依赖 SSH / credential helper / gh)
    const tokenUrl = `https://x-access-token:${cfg.token}@github.com/${cfg.owner}/${cfg.repo}.git`;
    execFileSync('git', ['push', tokenUrl, `HEAD:refs/heads/${branch}`], {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe',
    });
    // 4) 开 PR(走 REST;若该分支已有 open PR 则复用,避免 422 重复建)
    try {
      const created = await openPrForBranch(cfg, branch, base, opts.title, opts.body);
      return { prNumber: created.number, prUrl: created.url };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { prNumber: 0, prUrl: null, error: msg };
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const msg = err.stderr?.toString() || err.message || String(e);
    return { prNumber: 0, prUrl: null, error: msg };
  }
}

/**
 * 为某分支开 PR(先查已 open 的,存在则复用)。走 REST,不依赖 gh。
 * 开不了(权限不足 / 无领先提交等)抛错,由调用方 catch 判读。
 */
async function openPrForBranch(
  cfg: GithubConfig,
  branch: string,
  base: string,
  title: string,
  body: string
): Promise<{ number: number; url: string }> {
  // a) 该 head 分支已存在 open PR?复用之
  const existing = await githubRequest<Array<{ number: number; html_url: string }>>(
    cfg,
    `/pulls?state=open&head=${encodeURIComponent(`${cfg.owner}:${branch}`)}`
  );
  if (existing.length > 0) {
    return { number: existing[0].number, url: existing[0].html_url };
  }
  // b) 没有则新建
  const pr = await githubRequest<{ number: number; html_url: string }>(cfg, '/pulls', {
    method: 'POST',
    body: { title, head: branch, base, body },
  });
  return { number: pr.number, url: pr.html_url };
}

/**
 * merge 步:把已开的 PR 以 squash 方式合入 base 分支(走 REST `PUT /pulls/{n}/merge`)。
 * 合完返回合并状态;不成功(冲突 / 权限不足 / 已被保护规则拦截)抛错由调用方判读。
 */
export async function githubMergePR(
  prNumber: number,
  opts: { baseBranch?: string } = {}
): Promise<{
  merged: boolean;
  message: string | null;
  sha: string | null;
}> {
  const cfg = getGithubConfig();
  if (!cfg) {
    throw new Error('GitHub 未配置:缺少 GITHUB_TOKEN(需 Contents + Pull requests 写权限)');
  }
  try {
    const res = await githubRequest<{
      merged: boolean;
      message: string | null;
      sha: string | null;
    }>(cfg, `/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: {
        commit_title: `Merge pull request #${prNumber}`,
        merge_method: 'squash',
        base: opts.baseBranch || cfg.baseBranch,
      },
    });
    return res;
  } catch (e) {
    // 保留 cause:原始异常里带 GitHub 的状态码与响应体(如 405「PR 不可合并」、409 冲突),
    // 只保留 message 会让上层无法判断失败类型,排查时只能看到一句拼装后的中文。
    // 注意:项目 target 是 ES2021,`new Error(msg, { cause })` 的第二个参数是 ES2022 才有的,
    // 直接写会 TS2554,所以手动挂载 —— eslint 的 preserve-caught-error 认这种写法。
    const wrapped = new Error(`合并 PR #${prNumber} 失败: ${e instanceof Error ? e.message : String(e)}`);
    (wrapped as Error & { cause?: unknown }).cause = e;
    throw wrapped;
  }
}
