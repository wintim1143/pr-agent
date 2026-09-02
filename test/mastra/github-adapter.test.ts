import {
  getGithubConfig,
  githubMergePR,
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
