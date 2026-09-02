/**
 * verify-github.js —— 校验 GitHub adapter 的配置与鉴权(非破坏性,不开真实 PR)。
 *
 * 用法:
 *   node scripts/verify-github.js
 *
 * 行为:
 *   1. 结构校验:读 GITHUB_TOKEN / owner / repo 是否齐全(owner/repo 留空会从 git remote 解析)
 *   2. 缺失 → 打印去哪获取(默认从 .env 读取,需先 `cp .env.example .env` 并填值)
 *   3. 齐全 → 打印解析到的配置(脱敏),并跑 `gh auth status` 确认 token 真能用
 *      (gh 自动读 GITHUB_TOKEN 环境变量,只读检查,不会创建 PR)
 */
'use strict';
const { execFileSync } = require('node:child_process');
require('dotenv/config');

const github = require('../dist/mastra/adapters/github.js');

function mask(v, head = 4) {
  if (!v) return '<empty>';
  if (v.length <= head * 2) return '***';
  return v.slice(0, head) + '***' + v.slice(-head);
}

console.log('=== GitHub adapter 验证 ===');

const cfg = github.getGithubConfig();
if (!cfg) {
  const miss = github.missingGithubConfig();
  console.log('[缺失] 以下配置项未设置:');
  for (const m of miss) console.log('  - ' + m);
  console.log('');
  console.log('去哪获取(二选一):');
  console.log('  A. 免建 token(推荐,本机交互):终端跑 `gh auth login`(浏览器授权) → `gh auth setup-git`,');
  console.log('     此后 git push 自动走 OAuth 凭证,adapter 自动探测到 gh 登录态,无需配置任何变量。');
  console.log('  B. 手动建 token: GitHub → 头像 → Settings → 左侧栏最底部 Developer settings →');
  console.log('     Personal access tokens → Tokens (classic)/Fine-grained,作用域勾选 repo(含 public_repo)。');
  console.log('  GITHUB_OWNER / GITHUB_REPO: 留空会自动从 `git remote get-url origin` 解析,');
  console.log('    当前仓库 remote 解析结果见下方(若可解析则无需手填)。');
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    console.log('    当前 remote origin:', url);
  } catch {
    console.log('    当前未配置 remote origin。');
  }
  console.log('\n填好后重跑本脚本即可。未配置时 workflow 的 checkout/push-open-pr 会跳过,不阻断流程。');
  process.exit(0);
}

console.log('[配置] 已解析到:');
console.log('  authMode :', cfg.useGhAuth ? 'gh OAuth(无需 GITHUB_TOKEN)' : 'GITHUB_TOKEN');
console.log('  token    :', cfg.useGhAuth ? '(gh 登录态)' : mask(cfg.token));
console.log('  owner    :', cfg.owner);
console.log('  repo     :', cfg.repo);
console.log('  base     :', cfg.baseBranch);
console.log('  ghPath   :', cfg.ghPath);

console.log('\n=== 校验 gh 鉴权(gh auth status,只读) ===');
try {
  const out = execFileSync(cfg.ghPath, ['auth', 'status'], {
    env: process.env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(out.trim());
  console.log('\n[OK] gh 鉴权可用 → push + 开 PR 链路具备条件。');
  console.log('     实际开 PR 需运行 workflow(POST /api/workflows/dev-workflow/start-async)或在服务中触发。');
} catch (e) {
  const err = e.stderr?.toString() || e.stdout?.toString() || e.message || String(e);
  console.log('[WARN] gh auth status 失败:');
  console.log(err.trim());
  console.log('\n可能原因:');
  console.log('  - GITHUB_TOKEN 无效 / 已过期 / 作用域不含 repo');
  console.log('  - gh 未登录且未设 GITHUB_TOKEN(本脚本已确认 token 存在,基本可排除此项)');
  console.log('  - gh 路径解析错误(可显式设 GH_PATH)');
  process.exit(1);
}
