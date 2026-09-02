import { execSync } from 'child_process';
import type { ClaudeSDKAgent } from '@mastra/claude';

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
 * Claude Code CLI 优先读 `ANTHROPIC_API_KEY`,也认 `CLAUDE_API_KEY`(部分封装层)。
 * 缺失时不应让 workflow 崩溃,应降级跳过(由调用方决定后续行为)。
 */
export function missingClaudeKey(): boolean {
  return !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_API_KEY;
}

/**
 * 构建真正写文件的编码 agent。
 *
 * @param cwd 目标仓库绝对路径(checkout 步建分支所在仓库;自举即当前仓库根)。缺省取 git 仓库根。
 *
 * 权限说明:
 * - `permissionMode: 'bypassPermissions'` = 全放行,适合无人值守自举 demo。
 *   ⚠️ 这是权限红线(D3 建议③)。生产环境应改为白名单 + `'default'`/'acceptEdits' + `allowedTools` 收敛。
 * - `allowedTools` 限定为文件/命令类工具,避免 agent 调用危险工具。
 */
export async function getCodingAgent(cwd?: string): Promise<ClaudeSDKAgent> {
  // 执行期懒加载 @mastra/claude:其 ESM 依赖(@anthropic-ai/claude-agent-sdk/sdk.mjs)在 jest 等非 ESM
  // 运行时会被解析失败,故不能顶层静态 import,必须推迟到真正跑 coding 步时才加载。
  const { ClaudeSDKAgent: Agent } = await import('@mastra/claude');
  return new Agent({
    id: 'coding-agent',
    name: 'Coding Agent',
    description: '使用 Claude Code CLI 在目标仓库真正读写文件,完成 issue 对应的编码',
    sdkOptions: {
      cwd: cwd || getRepoRoot(),
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'TodoWrite'],
    },
  });
}
