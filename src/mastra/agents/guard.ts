import path from 'node:path';

/**
 * 编码执行体的权限围栏 —— 判定「某次工具调用该不该放行」。
 *
 * ## 为什么必须有这一层
 *
 * `coding` 步跑的是 `ClaudeSDKAgent`（Claude Code CLI），它真能读写文件、执行 shell。
 * 若不加约束，一次失控的编码就可能改写 workflow 本体、改掉本文件的拦截规则，
 * 或把 `.env` 里的凭据带走。围栏是「先关笼子再放 agent」的那一层笼子。
 *
 * ## 为什么用 PreToolUse hook，而不是 canUseTool
 *
 * claude-agent-sdk 源码（`sdk.mjs`，函数 `zKe`）里有一句官方警告，原文：
 *
 * > `canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves
 * > every tool call (except explicit deny rules) before the callback is consulted.
 * > To gate every tool call, use a PreToolUse hook instead.`
 *
 * 即：在 `bypassPermissions` 下 `canUseTool` 回调**根本不会被调用**。
 * 唯一能拦住每一次工具调用的是 PreToolUse hook —— 本模块就是它的判定内核。
 * 因此即便将来把 permissionMode 调回 `bypassPermissions`，本拦截依然生效。
 *
 * ## 设计边界
 *
 * 本模块是**纯函数**：输入 (工具名, 工具入参)，输出放行/拒绝。不 import 任何 SDK、
 * 不做 IO、不读 env，因此可以在 jest 里直接单测，也是唯一能被信任的拦截点。
 */

/**
 * 受保护路径 —— 自举期间 agent 不得写入（依据 `12-自动开发Agent任务列表与验收标准.md` §83）。
 *
 * 为什么是这些：它们定义了「流水线自身的行为」，一旦可被 agent 改写，
 * 所有闸门与红线都失去意义（agent 可以直接把校验逻辑删掉）。
 *
 * 匹配规则：
 * - `exact` 家族：与相对路径**精确相等**，或以该前缀 + `/` 开头（目录语义）。
 *   适用于目录（`.github`、`src/mastra/...`）与单体文件（`agent.md`）。
 * - `family` 家族：与相对路径**精确相等**，或以该前缀 + `.` 开头（点号同族语义）。
 *   适用于会把配置拆成多个同族文件的情形（`.env` → `.env.local` / `.env.production`）。
 */
export interface ProtectedPathRule {
  path: string;
  /** 前缀语义。'exact' = 精确 / 目录前缀；'family' = 精确 / 点号同族前缀。 */
  match: 'exact' | 'family';
}
export const PROTECTED_PATHS: readonly ProtectedPathRule[] = [
  { path: 'agent.md', match: 'exact' },
  { path: '.github', match: 'exact' },
  { path: '.env', match: 'family' },
  { path: 'src/mastra/workflows', match: 'exact' },
  { path: 'src/mastra/agents', match: 'exact' },
];
/** 兼容旧签名：仅返回受保护路径字符串（供测试/日志快速引用）。 */
export const PROTECTED_PATH_STRINGS: readonly string[] = PROTECTED_PATHS.map((p) => p.path);

/** 会写入文件的工具，及其入参里承载路径的字段名。 */
const WRITE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

/**
 * 危险 shell 命令模式。
 *
 * 每条都对应 `agent.md` 的一条红线或一类不可逆损害：
 * - force push / 直推 main：git 红线第 2 条
 * - reset --hard / clean -fd：丢弃未提交工作，不可逆
 * - rm -rf：不可逆删除
 * - 写 .git/ 内部：绕过所有 git 层保护
 */
const DANGEROUS_COMMANDS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b[^\n]*?\s(?:-f|--force)\b/, reason: '禁止 force push（git 红线）' },
  {
    pattern: /\bgit\s+push\b[^\n]*?\b(?:origin[^\n]*?)?\b(?:main|master)\b/,
    reason: '禁止直推 main/master（git 红线）',
  },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard 会丢弃未提交改动，不可逆' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/, reason: 'git clean -f 会删除未跟踪文件，不可逆' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, reason: 'rm -rf 不可逆删除' },
  { pattern: /\bgit\s+checkout\s+(?:-B\s+)?(?:main|master)\b/, reason: '禁止切换到 main/master 分支' },
  { pattern: /\bgit\s+branch\s+-[a-zA-Z]*D\b/, reason: '禁止强制删除分支' },
  { pattern: />\s*\.git\//, reason: '禁止直接写 .git/ 内部（绕过 git 层保护）' },
  { pattern: /\b(?:gh|git)\s+auth\b/, reason: '禁止操作凭据（gh/git auth）' },
  { pattern: /\bgh\s+pr\s+(?:merge|close)\b/, reason: '合并/关闭 PR 由人工关卡负责，agent 不得越权' },
  { pattern: /\bsudo\b/, reason: '禁止提权' },
  { pattern: /\bcurl\b[^\n]*?(?:\|\s*(?:ba)?sh|\s-o\s)/, reason: '禁止下载即执行 / 下载落盘' },
];

/** shell 里「把内容写进文件」的写法 —— 命中后需再检查目标是否受保护。 */
const REDIRECT_WRITE = /(?:(?:^|[;&|]\s*)[\w./-]+\s*)?(?:>>?|tee(?:\s+-a)?)\s*([^\s;|&>]+)/g;

export type GuardDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string };

/**
 * 把工具入参里的路径归一化成「相对仓库根、POSIX 分隔符」的形态。
 *
 * @returns 相对路径；若落在仓库根之外则返回 `null`（调用方视作越界，应拒绝）。
 *
 * Claude Code 传来的 `file_path` 绝大多数是绝对路径，但也可能相对 `cwd`，
 * 统一先按 `repoRoot` 解析再取相对值，两种情况都能覆盖。
 */
export function normalizeRepoPath(targetPath: unknown, repoRoot: string): string | null {
  if (typeof targetPath !== 'string' || targetPath === '') return null;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
  const rel = path.relative(path.resolve(repoRoot), abs);
  // 逃出仓库根（含 Windows 下跨盘符导致的绝对路径）
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** 判断归一化后的相对路径是否命中受保护清单。 */
export function isProtectedPath(relPath: string | null): boolean {
  if (!relPath) return false;
  return PROTECTED_PATHS.some(({ path: p, match }) => {
    if (relPath === p) return true;
    return match === 'exact'
      ? relPath.startsWith(p + '/')
      : relPath.startsWith(p + '.');
  });
}

/** 扫描 shell 命令里被重定向写入的目标，返回命中的受保护路径（没有则 null）。 */
function findRedirectTargetInProtected(command: string, repoRoot: string): string | null {
  REDIRECT_WRITE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REDIRECT_WRITE.exec(command)) !== null) {
    const target = m[1];
    if (!target || /^[-|]/.test(target)) continue;
    // `2>&1` 之类的 fd 重定向、以及管道右侧不是文件的情形会被上面的 [-|] 过滤掉
    const rel = normalizeRepoPath(target.replace(/^["']|["']$/g, ''), repoRoot);
    if (isProtectedPath(rel)) return rel;
  }
  return null;
}

/**
 * 判定一次工具调用是否放行 —— 围栏的唯一入口。
 *
 * @param toolName Claude Code 工具名，如 `Write` / `Edit` / `Bash`
 * @param input    该工具调用的入参（`PreToolUseHookInput.tool_input`）
 * @param repoRoot 目标仓库根绝对路径，用于把路径归一化
 */
export function guardToolCall(
  toolName: string,
  input: Record<string, unknown>,
  repoRoot: string,
): GuardDecision {
  // 1) 写文件类工具：检查目标路径
  const pathFields = WRITE_TOOLS[toolName];
  if (pathFields) {
    for (const field of pathFields) {
      const rel = normalizeRepoPath(input[field], repoRoot);
      if (rel === null) {
        return { decision: 'deny', reason: `目标路径落在仓库之外，越界写入被拒（${toolName}.${field}）` };
      }
      if (isProtectedPath(rel)) {
        return { decision: 'deny', reason: `受保护路径禁止写入：${rel}（自举期 agent 不得改动流水线自身）` };
      }
    }
    return { decision: 'allow' };
  }

  // 2) Bash：先查危险命令，再查重定向写入受保护路径
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) return { decision: 'allow' };

    for (const { pattern, reason } of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) {
        return { decision: 'deny', reason: `${reason}｜命令：${command.slice(0, 120)}` };
      }
    }

    const redirectHit = findRedirectTargetInProtected(command, repoRoot);
    if (redirectHit) {
      return { decision: 'deny', reason: `禁止通过 shell 重定向写入受保护路径：${redirectHit}` };
    }
    return { decision: 'allow' };
  }

  // 3) 其余工具（Read / Glob / Grep / TodoWrite 等）只读或无害，放行
  return { decision: 'allow' };
}
