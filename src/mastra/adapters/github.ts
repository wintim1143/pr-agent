/**
 * GitHub adapter —— K6(原 GitHub 桩)的落地实现。
 *
 * 设计取舍(先读环境再动手,非猜):
 * - `checkout`(建分支) 走本地 `git`(纯本地操作,不需要 GitHub 鉴权)。
 * - `push-open-pr` 走两件事:
 *   1. `git push` —— 鉴权优先级:显式 `GITHUB_TOKEN`(内嵌 HTTPS URL,CI 标准做法) > `gh` 登录态
 *      (走 `gh auth setup-git` 配置的 git credential helper,OAuth 鉴权,本机交互最省事,**无需手动建 token**);
 *   2. `gh pr create` —— 用已安装的 GitHub CLI(`gh`,K5 已装)开 PR,走 GitHub API。
 * - `gh` 二进制路径自动探测:先读 `GH_PATH`,否则 Windows 上探测 `C:\Program Files\GitHub CLI\gh.exe`,
 *   再回退到 PATH 里的 `gh`。这样用户在正常终端跑 `npm start`(gh 在 PATH)时也能用,不强制设 GH_PATH。
 * - owner/repo 优先读 `GITHUB_OWNER`/`GITHUB_REPO`,留空则自动从 `git remote get-url origin` 解析,
 *   因此用户**只需二选一**:填 `GITHUB_TOKEN`,或本机 `gh auth login` + `gh auth setup-git`(免建 token)。
 *
 * 重要:本模块**加载时不抛错**(否则拖垮 `npm test` 与 `GET /api/agents` 仅列元数据的场景),
 * 所有校验/报错都延迟到调用 `githubCheckout` / `githubPushAndOpenPR` 时才暴露。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export interface GithubConfig {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  ghPath: string;
  /** true=走 gh 登录态(OAuth 凭证),不依赖 GITHUB_TOKEN */
  useGhAuth?: boolean;
}

/** 自动探测 gh 可执行文件路径 */
function resolveGhPath(): string {
  if (process.env.GH_PATH) return process.env.GH_PATH;
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\gh.exe` : null,
    ].filter((c): c is string => Boolean(c));
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'gh';
}

/** 探测 gh 是否已登录(可走 OAuth 凭证,无需 GITHUB_TOKEN)。仅 github.com。 */
function ghAuthenticated(ghPath: string): boolean {
  try {
    execFileSync(ghPath, ['auth', 'status', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
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
  if (!owner || !repo) return null;

  const ghPath = resolveGhPath();
  const baseBranch = process.env.GITHUB_BASE_BRANCH || 'main';
  // 优先显式 GITHUB_TOKEN(适合 CI);否则探测 gh 登录态(OAuth,适合本机交互)
  if (token) {
    return { token, owner, repo, baseBranch, ghPath };
  }
  if (ghAuthenticated(ghPath)) {
    return { token: '', owner, repo, baseBranch, ghPath, useGhAuth: true };
  }
  return null;
}

/** 返回缺失的配置项(用于验证脚本提示用户去哪补) */
export function missingGithubConfig(): string[] {
  const miss: string[] = [];
  const ghPath = resolveGhPath();
  if (!process.env.GITHUB_TOKEN && !ghAuthenticated(ghPath)) {
    miss.push('GITHUB_TOKEN(或本机运行 `gh auth login` + `gh auth setup-git` 用 OAuth 凭证,免建 token)');
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
    // 3) 推送
    let pushArgs: string[];
    if (cfg.useGhAuth) {
      // 走 gh 登录态:git 经 `gh auth setup-git` 配置的 credential helper 用 OAuth 鉴权
      pushArgs = ['push', 'origin', `HEAD:refs/heads/${branch}`];
    } else {
      // 用 token 内嵌 HTTPS URL,不依赖 SSH / credential helper(CI 标准做法)
      const tokenUrl = `https://x-access-token:${cfg.token}@github.com/${cfg.owner}/${cfg.repo}.git`;
      pushArgs = ['push', tokenUrl, `HEAD:refs/heads/${branch}`];
    }
    execFileSync('git', pushArgs, {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe',
    });
    // 4) 开 PR(gh 自动从 remote 解析 owner/repo;GITHUB_TOKEN 由 env 传入)
    const out = execFileSync(
      cfg.ghPath,
      [
        'pr',
        'create',
        '--base',
        base,
        '--head',
        branch,
        '--title',
        opts.title,
        '--body',
        opts.body,
        '--json',
        'number,url',
      ],
      { cwd: root, env: process.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const json = JSON.parse(out) as { number: number; url: string };
    return { prNumber: json.number, prUrl: json.url };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const msg = err.stderr?.toString() || err.message || String(e);
    return { prNumber: 0, prUrl: null, error: msg };
  }
}
