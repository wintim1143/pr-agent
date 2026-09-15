import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getGithubConfig,
  githubMergePR,
  parseOwnerRepo,
} from '../../src/mastra/adapters/github';

/** mock 全局 fetch:返回指定响应;记录最后一次调用以便断言请求参数 */
function mockFetchOnce(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const orig = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => (global.fetch = orig) };
}

const BASE_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  // 记录并在每例后恢复,避免污染其他测试(不残留 GITHUB_TOKEN)
  const keys: Array<keyof NodeJS.ProcessEnv> = [
    'GITHUB_TOKEN',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'GITHUB_BASE_BRANCH',
    // 2026-09-15 补: parseOwnerRepo 现在按 repoRoot() 解析,而 repoRoot() 读这个 env,
    // 不纳入恢复会让本文件的用例互相污染(并可能影响其他测试文件)。
    'CODING_REPO_ROOT',
  ];
  for (const k of keys) BASE_ENV[k] = process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('getGithubConfig', () => {
  it('token/owner/repo 齐全时返回配置,baseBranch 默认 main', () => {
    process.env.GITHUB_TOKEN = 'github_pat_test';
    process.env.GITHUB_OWNER = 'wintim1143';
    process.env.GITHUB_REPO = 'pr-agent';
    delete process.env.GITHUB_BASE_BRANCH;
    const cfg = getGithubConfig();
    expect(cfg).toEqual({ token: 'github_pat_test', owner: 'wintim1143', repo: 'pr-agent', baseBranch: 'main' });
  });

  it('缺 token → null(即使 owner/repo 有)', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_OWNER = 'wintim1143';
    process.env.GITHUB_REPO = 'pr-agent';
    expect(getGithubConfig()).toBeNull();
  });

  it('支持自定义 baseBranch', () => {
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'o';
    process.env.GITHUB_REPO = 'r';
    process.env.GITHUB_BASE_BRANCH = 'develop';
    expect(getGithubConfig()?.baseBranch).toBe('develop');
  });
});

describe('githubMergePR', () => {
  it('发 PUT /pulls/{n}/merge 且 merge_method=squash', async () => {
    process.env.GITHUB_TOKEN = 'github_pat_test';
    process.env.GITHUB_OWNER = 'wintim1143';
    process.env.GITHUB_REPO = 'pr-agent';
    const m = mockFetchOnce(200, {
      merged: true,
      message: 'Pull Request successfully merged',
      sha: 'abc123',
    });
    try {
      const res = await githubMergePR(7);
      expect(res.merged).toBe(true);
      expect(res.sha).toBe('abc123');
      expect(m.calls).toHaveLength(1);
      const call = m.calls[0];
      expect(call.url).toBe('https://api.github.com/repos/wintim1143/pr-agent/pulls/7/merge');
      expect(call.init?.method).toBe('PUT');
      const body = JSON.parse(String(call.init?.body));
      expect(body.merge_method).toBe('squash');
      expect((call.init?.headers as Record<string, string>).Authorization).toContain('github_pat_test');
    } finally {
      m.restore();
    }
  });

  it('未配置 token → 抛错(不触发网络)', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_OWNER = 'o';
    process.env.GITHUB_REPO = 'r';
    await expect(githubMergePR(1)).rejects.toThrow(/未配置/);
  });

  it('HTTP 失败(如分支保护 403)→ 抛 merge 失败错误', async () => {
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'o';
    process.env.GITHUB_REPO = 'r';
    const m = mockFetchOnce(403, { message: 'Branch protection rules do not allow merges' });
    try {
      await expect(githubMergePR(9)).rejects.toThrow(/合并 PR #9 失败.*403/s);
    } finally {
      m.restore();
    }
  });
});

/**
 * `parseOwnerRepo` 的 cwd 语义 —— M3-2 的**回归测试**。
 *
 * ## 为什么这些用例必须存在（这是一条静默 bug，不是理论风险）
 * 原实现执行 `git remote get-url origin` 时**未指定 cwd** → git 落在**进程工作目录**上。
 * 跑 workflow 时进程 cwd 是 pr-agent 自己 → 恒解析出 `wintim1143/pr-agent`。
 * 后果：`push` 走 `repoRoot()`（= CODING_REPO_ROOT，靶场），而 owner/repo 来自进程 cwd（pr-agent）
 * → **分支推到靶场、PR 开到 pr-agent 身上**。全程不报错、不崩溃，只是把 PR 开在错的仓库上。
 *
 * 下面「【回归】」那一条就是这条 bug 的锁：它必须解析出 `CODING_REPO_ROOT` 指向的仓库，
 * 而**不是**进程 cwd 的仓库。这一条挂了就说明 bug 复现了。
 */
describe('parseOwnerRepo（cwd 语义 · M3-2 回归）', () => {
  const cleanup: string[] = [];

  /** 造一个临时 git 仓库；remoteUrl 非空时给它加 origin */
  function makeRepo(remoteUrl?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'pr-agent-owner-'));
    cleanup.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
    if (remoteUrl) {
      execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir, stdio: 'pipe' });
    }
    return dir;
  }

  afterEach(() => {
    while (cleanup.length) {
      try {
        rmSync(cleanup.pop()!, { recursive: true, force: true });
      } catch {
        /* Windows 偶发文件锁,忽略 —— 是临时目录,不影响判定 */
      }
    }
  });

  it('HTTPS remote(带 .git 后缀)→ 正确解析且剥掉后缀', () => {
    const dir = makeRepo('https://github.com/wintim1143/pr-agent-e2e.git');
    expect(parseOwnerRepo(dir)).toEqual({ owner: 'wintim1143', repo: 'pr-agent-e2e' });
  });

  it('SSH remote(git@host:owner/repo.git)→ 正确解析', () => {
    const dir = makeRepo('git@github.com:wintim1143/pr-agent-e2e.git');
    expect(parseOwnerRepo(dir)).toEqual({ owner: 'wintim1143', repo: 'pr-agent-e2e' });
  });

  it('无 origin remote → null(不抛错)', () => {
    expect(parseOwnerRepo(makeRepo())).toBeNull();
  });

  it('cwd 指向不存在的目录 → null(不抛错)', () => {
    const ghost = join(tmpdir(), `pr-agent-ghost-${Date.now()}`);
    expect(() => parseOwnerRepo(ghost)).not.toThrow();
    expect(parseOwnerRepo(ghost)).toBeNull();
  });

  // ⬇️ 回归锁：这一条挂了就说明「PR 开到 pr-agent 身上」的 bug 复现了
  it('【回归】不传 cwd 时按 CODING_REPO_ROOT 解析,绝不能落到进程 cwd(pr-agent)', () => {
    process.env.CODING_REPO_ROOT = makeRepo('https://github.com/wintim1143/pr-agent-e2e.git');

    const r = parseOwnerRepo();
    expect(r).toEqual({ owner: 'wintim1143', repo: 'pr-agent-e2e' });
    // 显式负向断言：修复前这里会是 pr-agent（进程 cwd 的 remote）
    expect(r?.repo).not.toBe('pr-agent');
  });

  it('CODING_REPO_ROOT 指向不存在目录 → null(repoRoot() 的抛错不逃逸出本函数)', () => {
    process.env.CODING_REPO_ROOT = join(tmpdir(), `pr-agent-nope-${Date.now()}`);
    expect(() => parseOwnerRepo()).not.toThrow();
    expect(parseOwnerRepo()).toBeNull();
  });

  it('显式 env 优先于 remote 解析', () => {
    process.env.CODING_REPO_ROOT = makeRepo('https://github.com/wintim1143/pr-agent-e2e.git');
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'someone-else';
    process.env.GITHUB_REPO = 'other-repo';
    expect(getGithubConfig()).toMatchObject({ owner: 'someone-else', repo: 'other-repo' });
  });
});
