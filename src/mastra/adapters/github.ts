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
    throw new Error(
      `GitHub API ${init?.method ?? 'GET'} ${path} → ${resp.status}: ${JSON.stringify(msg)}`
    );
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
    execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'pipe' });
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
  if (branchExists(root, branch)) {
    execFileSync('git', ['checkout', branch], { cwd: root, stdio: 'pipe' });
  } else {
    execFileSync('git', ['checkout', '-b', branch, base], { cwd: root, stdio: 'pipe' });
  }
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
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`合并 PR #${prNumber} 失败: ${msg}`);
  }
}
