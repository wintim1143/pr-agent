# agent.md — 本仓库智能体规范（常驻指令）

> 所有在本仓库运行的智能体（编码 agent / Mastra agent / 任意 AI 助手）**开工前先读本文件**，然后直接干活。
> 本文件是「共识」不是「事后记录」——git 规范、API 事实、验证纪律都固化在这里，避免不同会话/不同 agent 各凭临时约定返工。

---

## 1. 仓库本质
- TypeScript + Midway.js（Koa 底座）工程，**Mastra 编排多 agent 自动开发**。
- 主线：飞书收需求 → GitHub issue → Mastra 自动开发（workflow 强制质量闸门）→ PR 合并。
- 当前进度：已完成「Midway + `@mastra/koa` 接入」「dev-agent + 6 闸门 skill」「dev-workflow 8 步骨架」。下一步见 §6。

## 2. 技术栈与结构
- 后端：Midway.js v4（`@midwayjs/koa`，**CommonJS**，Node ≥ 20）。
- Mastra 挂载：`@mastra/koa` 的 `MastraServer` 接管 Midway 暴露的 Koa app（见 `src/mastra/server.ts` 的 `registerMastra`）。
- 编排：`src/mastra/` 下 `index.ts`(统一 Mastra 实例) / `server.ts`(Midway 嵌入) / `agents/` / `skills/` / `workflows/`。
- 关键结构约定：**`src/mastra/index.ts` 是单一真相源**，导出名为 `mastra` 的实例；Midway 嵌入路径与 `mastra dev` 路径共用同一实例，禁止双实例。

### 2.1 已验证的 Mastra API 事实（1.63.x，勿凭旧文档瞎写）
> 以下均为本仓库实测 + 读 `.d.ts` 源码确认，文档（含设计稿）里的旧写法已部分过时。

- **版本**：`@mastra/core@1.63.2`、`@mastra/koa@1.7.7`、`mastra@1.27.2`（meta 包）。
- **`@mastra/core` 主入口只导出 `Mastra`**，**不导出** `Agent` / `createSkill` / `Step` / `Workflow`。必须走子路径：
  - `Agent` → `@mastra/core/agent`
  - `createSkill` → `@mastra/core/skills`
  - workflow：`createStep` → `@mastra/core/workflows`；`Workflow` → `@mastra/core/workflows`
- **`Step` 不是可用类**（运行时 `undefined`），创建步骤用工厂函数 **`createStep({ id, description, inputSchema, outputSchema, execute })`**。
- **`Workflow` 构造必填 `outputSchema`**，`mastra` 字段可选（由 `new Mastra({ workflows })` 自动注入，无循环依赖）。
- **链式串联用 `.then(step)`（每个步骤含第一个都用 `.then()`），末尾 `.commit()`**；旧文档的 `workflow.step(...)` 已过时。
- `execute({ mastra, inputData, getStepResult(stepId), suspend() })`：`suspend()` 用于「合并需用户确认」等人工闸门；`getStepResult` 取上一步输出。
- `Agent.model` 接受 `'provider/model'` 字符串（构造期不解析，`GET /api/agents` 不触发 generate，不影响接入验证）。
- `Agent.skills` 接受 `createSkill(...)` **内联实例**（稳定，推荐）或 `'./skills/<name>'` 路径（依赖运行期 cwd 解析，构建后基准不确定，慎用）。
- `@mastra/koa` 的 `MastraServer` 构造参数 `app` 期望**标准 Koa 实例类型**，而 Midway 注入的 `this.app` 类型是 `koa.Application`(MidwayKoaApplication)，**编译期类型对不上，需 `as any` 桥接；运行期兼容（已验证）**。此 `as any` 仅允许出现在 `registerMastra` 一处。
- Mastra 报 `No storage configured` 是 **warning 非 error**（in-memory，重启丢数据）；真接 agent/workflow 状态后需配 `@mastra/libsql` / `@mastra/pg` 等持久化 storage。

## 3. 两条运行路径与端口
| 路径 | 启动命令 | 端口 | 用途 |
|------|---------|------|------|
| A. Midway 嵌入（主力） | `npm run build` → `npm start` | **8001** | 真实承载 HTTP，路由挂在 `/api/agents`、`/api/workflows` |
| B. Mastra Studio | `npx mastra dev` | 4111 | 官方 dev server + Studio 可视化检查 |

- 两条路径共用 `src/mastra/index.ts` 的同一实例，互不冲突，可并存。
- `npx mastra dev` 要求 `src/mastra/index.ts` 导出名为 `mastra` 的 `Mastra` 实例（否则报 `No index.ts and no file-based primitives found`）。本项目已满足。

## 4. Git 规范（硬约束，不可违反）
- **分支模型**：trunk-based + 短期 feature 分支 `feat/<issue-number>-<short-slug>`（如 `feat/123-user-login`），合并后即删。
- **commit**：Conventional Commits，`<type>(<scope>): <subject>`，末尾 `Closes #<issue>`；`type` ∈ feat/fix/refactor/test/docs/chore/perf；subject 祈使句、≤50 字符；必须过 `commitlint`。
- **合并**：squash merge 到 `main`，前期需**用户确认**。
- **红线（绝对禁止）**：
  1. Agent 只能操作自己的 feature 分支。
  2. 禁止 push / force push `main`；禁止 rebase `main`。
  3. 所有提交必须过测试 + 审核 skill，否则不许 commit。
  4. 合并必须用户确认（前期）或 CI 门禁 + 有权限者批准（多人后）。
- 禁止在代码里硬编码密钥（用 env / secret 管理）。

## 5. Skill 使用约定
- 每个质量闸门（需求解析/编码/测试/审核/commit/合并）都是一个 Mastra skill，**不可跳过**。
- skill 见 `src/mastra/skills/<name>/SKILL.md`，格式遵循 Agent Skills spec（frontmatter 必需 `name`/`description`）。
- 编码由编码 agent 经 workflow 编排执行，Mastra 只负责编排与闸门强制。

## 6. 验证纪律（重要：别为每个小改动起服务）
> **原则：小改动只跑类型/编译校验；整段需求告一段落后再做运行期验证。** 每改一处就 `npm start` + curl 一轮，启动（Midway bootstrap + MastraServer.init）和往返开销大、拖慢整个流程。

- **改动 `.ts` 后，第一道反馈用 `npm run build`（mwtsc）**：它把 `src` 编译到 `dist` 并做类型检查，**能抓出 99% 的写法/类型/导入错误**，秒级反馈，无需起服务。
  - 可选：`npm run lint`（`mwts check`）做风格校验。
- **禁止为每个小改动启动服务测试**。以下情况才算「整段需求告一段落」，可以起服务做运行期验证：
  - 一个完整逻辑单元写完（如「agent + 6 skill 接好」「workflow 8 步骨架完成」「某闸门 skill 真实实现 + 串进 workflow」）。
- **运行期验证标准流程**（仅在告一段落时执行）：
  1. `npm run build` 确保编译通过。
  2. `npm start`（路径 A，端口 8001）或 `npx mastra dev`（路径 B，Studio 4111）。
  3. curl 验证：`GET /api/agents` → 应返回 `dev-agent` 含 6 个 inline skill；`GET /api/workflows` → 应返回 `dev-workflow` 含 8 步。
  4. **验证完立即停掉服务释放端口**（避免下次端口冲突 / 残留进程）。
- 验证时若 `mastra dev` 在「非真实终端」环境下被回收（Studio 代理起但内层 connection refused），属环境怪象，非代码问题；本机真实终端跑正常。

### 6.1 测试与临时脚本的位置约定（两类，严格分开）
- **正式测试（会长期存在的）**：必须放在**框架要求的位置**。本仓用 jest，单测放 `test/`（jest 默认收集 `*.test.ts`）。`.tmp/` 里的任何东西都不会被 jest 收集。
- **一次性验证脚本 / 探针（跑完即弃或留着无妨）**：一律放 `.tmp/verify/`，**自己命名**。这是验证依赖（`@mastra/core` 等）时的落点——`/tmp` 解析不到项目 `node_modules`。
  - 放 `.tmp/` 里**不需要删除**，gitignore 已忽略，不入库。
  - `.tmp/` 已在本项目 `.workbuddy/settings.local.json` 的 `sandbox.extraAllowWrite` 写白名单里（权限弹窗免确认），见 §6.2。
  - `jest.config.js` 的 `testPathIgnorePatterns` / `coveragePathIgnorePatterns` 已排除 `.tmp/`，不会误收集、不会污染覆盖率。

### 6.2 权限弹窗与临时目录白名单
- **WorkBuddy 支持项目级配置**：项目根 `.workbuddy/settings.local.json`（本地，不进 git）承载本项目专有的 `sandbox.extraAllowWrite`（如 `.tmp/`）。用户级在 `~/.workbuddy/settings.json`。CodeBuddy Code CLI 形态则用 `.codebuddy/settings.json` / `settings.local.json`。
- 开发机曾遇到 file-safety「会话累计」计数器弹窗（装 skill 一次性写 50 个文件打满阈值后，后续每条涉及文件的命令都被拦）。缓解手段：
  - **中间产物、探针脚本一律落 `.tmp/verify/`，不落项目根**。
  - `.tmp/` 已加入本项目 `.workbuddy/settings.local.json → sandbox.extraAllowWrite`，此后在 `.tmp/` 里写文件不再弹窗。
- 若又遇到无理由授权弹窗，先查 `~/.workbuddy/audit-log/`，别盲目猜是命令本身的问题。

## 7. 沟通与状态反馈
- 需求状态变更必须同步到 GitHub issue label（open/approved/in_progress/pr_opened/merged/rejected）+ 飞书卡片。
- 所有对外动作（创建/合并 PR）都要可追踪、可回滚。

## 8. 不要做的事
- 不要绕过 workflow 直接改 `main` / 直接合并 PR。
- 不要为每个小改动起服务做运行期测试（见 §6）。
- 不要在代码里硬编码密钥。
- 不要凭旧文档瞎写 Mastra API（见 §2.1，以本仓库已装版本的 `.d.ts` 为准）。
- 不要删除或破坏 `agent.md` 与 git 规范约定。

---

> 本规范随项目演进迭代。若调整了默认行为（如多人后放宽保护/确认），直接改这里。
