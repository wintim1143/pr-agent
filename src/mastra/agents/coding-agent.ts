import { execSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeSDKAgent } from '@mastra/claude';
import type { HookCallback, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { guardToolCall } from './guard.js';

/**
 * 真正写文件的编码执行体(封装 Claude Code CLI)。
 *
 * 为什么不用 Mastra 原生 agent 自造文件工具链:
 * Phase 0 `coding` 步要"真正读写文件",若用 Mastra 原生 agent,必须自己用 `createTool`
 * 实现 read/write/edit/bash/glob/grep 一整套,还要处理流式输出、权限确认、错误恢复、沙箱边界——
 * 每个边界都是漏洞点。而 `ClaudeSDKAgent` 直接复用 Claude Code CLI 原生全套工具 + `sdkOptions`,
 * 天然支持 `cwd`(目标仓库) / `allowedTools`(工具白名单) / `permissionMode`(无人值守) / `mcpServers`
 * / `resume`·`continue`(会话续跑),对接"改别的仓库 + 无人值守流水线"明显更简单。
 *
 * 代价:引入第二套 key——Claude 编码体走 Anthropic(读 `ANTHROPIC_API_KEY` 或 Claude Code 登录态),
 * 与闸门用的中转站模型(glm-5.2 等)是两家供应商。详见 `13-卡点` K4。
 *
 * ## 权限模型(三层,见下方 `getCodingAgent`)
 *
 * 1. `permissionMode: 'bypassPermissions'` —— 无人值守全放行(含 Bash),配 `allowDangerouslySkipPermissions`。
 * 2. `allowedTools` / `disallowedTools` —— 工具级白/黑名单(bypass 下不具约束力,作防御纵深)。
 * 3. **PreToolUse hook → `guard.ts`** —— 唯一能拦住每一次工具调用的硬拦截
 *    (受保护路径 + 危险命令),且与 permissionMode 无关。
 */

/** 解析 git 仓库根(自举场景 coding 改的就是当前仓库) */
export function getRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * 是否缺少 Claude 编码所需的凭证。
 *
 * ## 历史坑(2026-09-04 修复)
 *
 * 旧实现只有一行:`!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_API_KEY`。
 * 但**正常路径下父进程本来就没有这个变量** —— 凭据来自 Claude Code CLI 启动时自行读取的
 * `~/.claude/settings.json`(本机是 cc-switch 代理:`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`
 * + `ANTHROPIC_AUTH_TOKEN`,代理再注入真 key;本机 `~/.claude.json` 与 `.credentials.json`
 * 均**无** Claude 账号 OAuth 登录态)。
 *
 * 于是该判断恒为 `true`,coding 步永远走占位降级分支,只打一行 warn —— M2 因此
 * 一直跑不出真实改动,且从结果上无法区分「agent 没跑」和「跑了但没改东西」。
 *
 * ## 优先级事实(官方 `code.claude.com/docs/en/settings`)
 *
 * > Environment variables aren't a level in this stack... `ANTHROPIC_MODEL` exported in your
 * > shell applies over the `model` key from any file.
 *
 * 即**真实进程环境变量优先于 settings.json 的 env 块**。这也解释了为什么往子进程注入
 * `ANTHROPIC_*` 会盖掉用户配好的代理端点(见 `buildCodingEnv`)。
 *
 * ## 现在的判定(命中任一即视为可用)
 *
 * 1. 进程环境里有显式 key:`ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`
 * 2. 用户显式覆盖编码后端:`CODING_ANTHROPIC_API_KEY` / `CODING_ANTHROPIC_BASE_URL`
 * 3. `~/.claude/settings.json` 的 `env` 块提供了端点或凭据(CLI 启动时自己应用)
 *
 * ⚠️ 这是**启发式**判断 —— 真正的可用性只有 CLI 跑起来才知道。因此调用方在编码失败时
 * 必须**显式报错**,不能静默降级成占位符。
 */
export function missingCodingCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) return false;
  if (process.env.CODING_ANTHROPIC_API_KEY || process.env.CODING_ANTHROPIC_BASE_URL) return false;
  return !hasClaudeSettingsCredential();
}

/** 从 `~/.claude/settings.json` 的 env 块里找端点/凭据信号。只读、任何异常都视为「没有」。 */
function hasClaudeSettingsCredential(): boolean {
  try {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(file)) return false;
    const env = JSON.parse(fs.readFileSync(file, 'utf8'))?.env ?? {};
    return Boolean(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  } catch {
    return false;
  }
}

/**
 * 构造传给 Claude Code CLI 子进程的 env。
 *
 * ## 为什么默认【不覆盖】ANTHROPIC_*(2026-09-04 修复)
 *
 * 官方 `@mastra/claude` 示例根本不传 key —— 因为凭据该由 CLI 自己解析。本机链路:
 * `~/.claude/settings.json` env 块 → `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`(cc-switch 代理)
 * → 代理注入真 key。旧实现把 `ANTHROPIC_BASE_URL` 硬改成 `LLM_BASE_URL`(lanfengai 直连),
 * 直接盖掉了这条可用通路 —— 这是 M2 编码超时的根因之一。
 *
 * 现在:**默认原样继承父进程环境**,只有用户显式设置 `CODING_ANTHROPIC_*` 时才覆盖。
 *
 * ⚠️ `sdk.d.ts` 明确:env 一旦设置会**整个替换**子进程环境、不自动合并 `process.env`。
 * 所以必须展开 `...process.env`,否则子进程会因缺 PATH/HOME 直接炸掉。
 */
function buildCodingEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const override: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: process.env.CODING_ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: process.env.CODING_ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.CODING_ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL: process.env.CODING_ANTHROPIC_MODEL,
  };
  for (const [key, value] of Object.entries(override)) {
    if (value) env[key] = value;
  }
  return env;
}

/**
 * 构造围栏用的 PreToolUse hook。
 *
 * 为什么必须走 hook 而不是 `canUseTool`:claude-agent-sdk 源码明确说明,
 * `bypassPermissions` 会在回调被咨询**之前**就自动放行所有工具调用,
 * 因此 `canUseTool` 在该模式下不会被调用;PreToolUse hook 是唯一可靠的拦截点。
 *
 * 失败策略:**fail-closed** —— hook 自身异常时一律拒绝。
 * 理由:误拒会让流水线明显报错(可观测),误放行则是静默绕过(不可观测)。
 */
export function makeGuardHook(repoRoot: string): HookCallback {
  return async input => {
    const deny = (reason: string): SyncHookJSONOutput => ({
      // 新版判定字段(SDK 推荐)
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      // 旧版字段同时给上,兼容不同 CLI 版本
      decision: 'block',
      reason,
      continue: true,
      systemMessage: `[permission-guard] 已拦截: ${reason}`,
    });

    try {
      const hookInput = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
      if (hookInput.hook_event_name !== 'PreToolUse') return {};

      const toolName = String(hookInput.tool_name ?? '');
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;

      const verdict = guardToolCall(toolName, toolInput, repoRoot);
      if (verdict.decision === 'deny') {
        console.warn(`[permission-guard] deny ${toolName}: ${verdict.reason}`);
        return deny(verdict.reason);
      }
      return {};
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return deny(`围栏自身异常,fail-closed 拒绝本次调用: ${msg}`);
    }
  };
}

/**
 * 构建真正写文件的编码 agent。
 *
 * @param cwd 目标仓库绝对路径(checkout 步建分支所在仓库;自举即当前仓库根)。缺省取 git 仓库根。
 *
 * ## 权限三层(对应 `13-卡点` K7-B)
 *
 * - `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`:
 *   无人值守下全放行(含 Bash,保证 npm test/build/git 能跑,不因缺 TTY 卡死)。
 *   ⚠️ 此模式会让 `allowedTools` / `canUseTool` 失效(sdk 源码明确说明)——所以真正的
 *   安全边界不在这两层,而在下一层 hook。
 * - `allowedTools` 白名单 + `disallowedTools` 黑名单:断掉联网工具(防数据外泄)。
 *   注意:bypass 下 allowedTools 不具约束力,此名单主要供将来切回非 bypass 模式时生效,
 *   且作为**防御纵深**(若 SDK 版本行为变化仍能兜底)。
 * - **PreToolUse hook → `guard.ts`**:唯一可靠、且与 permissionMode 无关的硬拦截点。
 *   sdk 源码警告原文:"bypassPermissions auto-approves every tool call (except explicit
 *   deny rules) before the callback is consulted. To gate every tool call, use a
 *   PreToolUse hook." → 受保护路径 + 危险命令在此硬拦,见 `makeGuardHook`。
 * - `maxTurns` / `maxBudgetUsd`:无人值守的成本与失控上限。
 */
export async function getCodingAgent(cwd?: string): Promise<ClaudeSDKAgent> {
  // 执行期懒加载 @mastra/claude:其 ESM 依赖(@anthropic-ai/claude-agent-sdk/sdk.mjs)在 jest 等非 ESM
  // 运行时会被解析失败,故不能顶层静态 import,必须推迟到真正跑 coding 步时才加载。
  const { ClaudeSDKAgent: Agent } = await import('@mastra/claude');
  const repoRoot = cwd || getRepoRoot();
  return new Agent({
    id: 'coding-agent',
    name: 'Coding Agent',
    description: '使用 Claude Code CLI 在目标仓库真正读写文件,完成 issue 对应的编码',
    sdkOptions: {
      cwd: repoRoot,
      // 默认原样继承父进程环境,不覆盖 ANTHROPIC_* —— 让 Claude Code CLI 自行读取
      // `~/.claude/settings.json` 里配好的代理端点(本机为 cc-switch 127.0.0.1:15721)。
      // 需要显式换后端时,设置 CODING_ANTHROPIC_BASE_URL / _API_KEY / _AUTH_TOKEN / _MODEL。
      // 细节与历史坑见 buildCodingEnv 的注释。
      env: buildCodingEnv(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        'Read',
        'Edit',
        'Write',
        'Bash',
        'Glob',
        'Grep',
        'TodoWrite',
        'TaskCreate',
        'TaskUpdate',
        'TaskList',
      ],
      // 断网:禁止联网工具,避免把仓库内容/凭据外发
      disallowedTools: ['WebFetch', 'WebSearch'],
      hooks: {
        // 不设 matcher:按 SDK 官方示例,默认对全部工具生效
        PreToolUse: [{ hooks: [makeGuardHook(repoRoot)] }],
      },
      // 无人值守的成本与失控上限(可被 env 覆盖)
      maxTurns: Number(process.env.CODING_MAX_TURNS ?? 30),
      maxBudgetUsd: Number(process.env.CODING_MAX_BUDGET_USD ?? 2),
    },
  });
}
