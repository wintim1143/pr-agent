---
tags: [领域/Agent, 项目/计划, 自动开发工作流]
created: 2026-09-01
status: 待确认
---

# pr-agent 任务列表与分阶段验收标准

> ⚠️ **已归档**：本文档是旧 S0–S6 纵向切层规划的产物，已被 `milestones/` 取代。新规划（路线图 + 各里程碑卡）以 `milestones/README.md` 为准；本文仅作历史参考，不再更新。

> 一句话最终目标：**在飞书里 @机器人 提一句需求，机器人自动把它变成 GitHub issue；人点"可开发"后，Agent 在指定仓库的 feature 分支上改代码、跑测试、过审核、生成合规 commit、开 PR；人点"合并"后 squash 合入 main 并关闭 issue。全链路走真实 GitHub，每个质量闸门由 Mastra workflow 强制不可跳过。**

本文档是后续所有会话的**唯一计划真相源**。开工前先读 `agent.md`（行为约束），再读本文档（任务与验收）。

---

## 零、当前盘点（2026-09-01 实测，非推测）

| 项目 | 实际状态 |
|------|---------|
| 代码 | 8 步 workflow 已串通;`checkout`+`commit`+`push-open-pr`(GitHub)已接 adapter(`src/mastra/adapters/github.ts`,真实建分支/提交/推送+开 PR),`notify`(飞书)已接 adapter;闸门输出已结构化(`testResult`/`reviewResult`/`commitResult` 带 schema) |
| Skills | 6 个 SKILL.md 各约 20 行，只有 prompt 壳；agent 内是 `createSkill` 内联版 |
| 闸门输出 | **全部是 `string`**（`codingResult` / `testResult` / `reviewResult`），无法做条件判断——这是最大技术债 |
| 依赖 | `node_modules` 已安装(`npm install`);流水线 build/test/lint 全绿 |
| Storage | 无（in-memory，重启丢状态）→ **无法支撑 suspend/resume 等飞书卡片回调** |
| 测试 | 只有 Midway 自带的 2 个 controller 冒烟，无业务逻辑测试 |
| 凭据 | `ANTHROPIC_API_KEY` 未设置；`gh` CLI 未安装 |
| dev-agent 模型 | env 驱动 `OpenAICompatibleConfig`(适配中转站,见 `src/mastra/config.ts` 与 `.env.example`)→ 需 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` |

## 一、已锁定决策（本次新验证，取代设计文档 §十二 的旧假设）

### 1.1 Mastra 官方支持对接 Claude Code ✅ 已验证

设计文档 §十二 里"Claude Code 经 Mastra SDK 嵌入的具体配置（`ClaudeSDKAgent`）"这一待办，**官方已经给答案了**：

- 包：`@mastra/claude@0.3.0`，导出 `ClaudeSDKAgent`
- peer 依赖：`@mastra/core >=1.34.0-0 <2.0.0-0` ✅（本仓 `^1.63.2` 满足）；`@anthropic-ai/claude-agent-sdk ^0.3.145` ✅（当前 0.3.252）
- 用法：`new ClaudeSDKAgent({ id, name, description, sdkOptions })`，`sdkOptions` 原样透传给 Claude SDK 的 `query()`
- 注册进 `new Mastra({ agents })`，和其他 agent 一样被 workflow step 调用，行为和用量进 Studio 可观测
- 支持 `structuredOutput`（zod schema 约束输出）和 `resumeGenerate({ sessionId })`

**关键配置项**（`sdkOptions` 透传，足以支撑无人值守）：

| 选项 | 作用 |
|------|------|
| `cwd` | **指向目标仓库路径** —— 这是"改别的仓库"的落点 |
| `model` | 如 `claude-sonnet-4-6` |
| `allowedTools` | 工具白名单 |
| `permissionMode` | 权限模式（见 1.2） |
| `maxTurns` / `maxBudgetUsd` | **防跑飞的硬上限，必须设** |
| `mcpServers` | 挂自建工具 |

### 1.2 无人值守的权限模型（决定"会不会卡住"）

这是自动化流水线最容易翻车的地方——Claude Code 默认会在每次 Edit/Bash 时弹窗等人确认，workflow 会**挂死**。三种可用模式：

| 模式 | 行为 | 结论 |
|------|------|------|
| `dontAsk` | `allowedTools` 白名单内放行，白名单外**直接拒绝**（不弹窗、不回调） | 备选（切回非 bypass 时生效） |
| `acceptEdits` | **cwd 内**的文件操作自动放行，Bash 等仍需确认 | ⚠️ 会卡在 Bash（跑测试要 Bash），不可用于无人值守 |
| `bypassPermissions` | 全部放行（含 Bash） | ✅ **已拍板采用**（无人值守零弹窗）；硬拦截由 `guard.ts` PreToolUse hook 承担，非 `allowedTools` |

**已拍板方案（2026-09-03）：`permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`，配套 `maxTurns` 与 `maxBudgetUsd`。真正的硬拦截靠 PreToolUse hook → `guard.ts`（fail-closed），与 permissionMode 无关。`allowedTools`/`disallowedTools` 仅作防御纵深。详见 `agent.md` §4.1。**

> 注意：子 agent 会**强制继承**父 agent 的权限模式，无法在子级覆盖。

### 1.3 目标仓库

前期让 agent 改**本仓库**（自建 feature 分支，自举）；`cwd` / `owner` / `repo` 抽成 **RepoTarget 配置**，`sdkOptions.cwd` 与所有 git 命令都读它，Phase 6 换成外部仓库时只改配置不改代码。

### 1.4 验收方式

**全程真实 GitHub**：issue、PR、label、commit 都是真的，人工端到端验收。
但 `npm test` 里的**单元测试仍需 mock**（不可重复、不能污染仓库历史的动作不进 CI）。即：**真实环境验端到端，mock 环境保回归。**

### 1.5 落地顺序

**先跑通无 IM 闭环**（D5 已拍板①）：编码引擎 → 闸门 → PR/合并 先用 HTTP 触发跑通主轴；飞书入口(inbound)推迟到 Phase 1 具体实现。

---

## 二、全局红线（任何阶段都不得违反）

1. Agent 只能操作自己的 feature 分支（**仅限目标仓库**）；本仓库(pr-agent)开发允许直接改 `main`。**禁止 force push `main`、禁止 rebase `main`**；普通 `push main` 允许。
2. **受保护路径**：`agent.md`、`.github/`、`.env*`、`src/mastra/workflows/`、`src/mastra/agents/` —— 自举期间 Agent **不得修改**，用 `disallowedTools` + PreToolUse hook + 分支保护三重拦截。
3. 不通过测试与审核，**不得 commit**。
4. 合并**必须人类确认**（飞书卡片）。
5. 禁止硬编码密钥，一律走 env。
6. 每次编码 run 必须有 `maxTurns` + `maxBudgetUsd` 上限。

---

## 三、前置条件（P0 之前必须解决，否则全线阻塞）

| # | 阻塞项 | 当前状态 | 需要你做的 |
|---|--------|---------|-----------|
| B1 | `node_modules` | ❌ 未安装 | `npm i` |
| B2 | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | ❌ | dev-agent 现由 `src/mastra/config.ts` 的 `OpenAICompatibleConfig` 驱动(中转站就绪),三项填好即可;模板见 `.env.example` |
| B3 | `ANTHROPIC_API_KEY` | ❌ | ClaudeSDKAgent（编码 agent）必需 |
| B4 | GitHub 凭据 | ❌ `gh` 未装 | 用 `@octokit/rest` + PAT（服务内），或装 `gh` CLI |
| B5 | 飞书 App ID/Secret | ❓ | 企业自建应用 + 机器人能力 + 长连接模式 |

---

## 四、阶段与工单

> 图例：`🔴`=硬阻塞下游 ｜ 工单编号 `P<n>-<m>` ｜ 依赖写在「阻塞/被阻塞」里

---

### Phase 0 — 地基：依赖、配置、持久化

**目标**：让"能跑、能配、能存"成立。后续每个阶段都建立在这层之上。
**为什么在最前**：Storage 缺失会让 Phase 1 的卡片回调无法 resume；RepoTarget 未抽象会让 Phase 2 的编码路径写死。

| 工单 | 标题 | 要点 |
|------|------|------|
| P0-1 | 依赖安装与流水线跑通 | `npm i`；`npm run build` / `npm test` / `npm run lint` 全绿 |
| P0-2 | 配置与密钥管理 | 统一 config schema（zod 校验，缺 key 启动即报错并指明缺哪个）；`.env.example`；`.gitignore` 加 `.env*` |
| P0-3 | ~~RepoTarget 抽象~~ ✅ 经实测非硬编码 | `repoRoot()`/`getRepoRoot()` 已统一用 `git rev-parse --show-toplevel`，无需额外配置源；Phase 6 多仓库时再补 `repoPath` 配置项 |
| P0-4 | **Mastra Storage 持久化** 🔴 | 接 `@mastra/libsql`（本地 SQLite 起步）；workflow run 状态重启后可恢复 |

**验收标准（AC0）**

- AC0-1：`npm run build` 退出码 0，无 TS 错误。
- AC0-2：故意删掉一个必需 env，`npm start` **立即失败**并打印缺失项名称（而不是运行到一半才炸）。
- AC0-3：RepoTarget 指向临时目录时，git 操作作用于该目录；指向本仓库时作用于本仓库。**只改配置，不改代码。**
- AC0-4：启动 → 触发一个 workflow → `kill` 进程 → 重启 → 该 run 的状态**仍可查到**（`storage` 生效）。
- AC0-5：`.env` 不在 git 跟踪内（`git check-ignore .env` 命中）。

**退出条件**：四条全绿，且 `agent.md` 已同步 §2.1 新增的 storage / RepoTarget 事实。

---

### Phase 1 — 飞书入口闭环（提需求 → issue → 卡片 → 批准）🔴

**目标**：人能在飞书里把需求变成真实的 GitHub issue，并用一个按钮启动开发。
**为什么在最前**：本次拍板。且这一阶段**不依赖编码引擎**，可以独立交付、独立演示。

| 工单 | 标题 | 要点 | 依赖 |
|------|------|------|------|
| P1-1 | 飞书长连接 adapter | WebSocket 接入；**3 秒约束**：收事件 → 投递 → 立即返回，重活异步丢给 Mastra | P0-2 |
| P1-2 | 需求解析真实化 | `requirement-parser` skill + `structuredOutput`（zod：`{title, body, acceptance, questions[]}`）；信息不足时**回卡片追问**而非瞎猜 | P1-1 |
| P1-3 | 创建 GitHub issue + 回卡片 | 真实建 issue；卡片含 issue 号、标题、验收标准预览 + `✅可开发` / `❌拒绝` 按钮 | P0-3, P1-2 |
| P1-4 | 卡片回调 → 状态机 | approve → 打 label `approved` → 触发 dev-workflow（拿到 runId）；reject → 关 issue + 回执卡片 | P1-3, P0-4 |
| P1-5 | `/list` 命令 | 列待审核 issue，每项带审批按钮 | P1-3 |

**验收标准（AC1）— 全部在真实飞书 + 真实 GitHub 上验**

- AC1-1：在飞书 @机器人 提一句完整需求 → 真实仓库出现对应 issue（标题/正文/验收标准齐全）。
- AC1-2：提一句**信息残缺**的需求（如"帮我优化下性能"）→ 机器人**回卡片追问缺失信息**，且**没有**创建 issue。
- AC1-3：卡片上点 `✅可开发` → issue 被打上 `approved` label，且**产生了一个 workflow run（有 runId 可查）**。
- AC1-4：卡片上点 `❌拒绝` → issue 关闭，label 为 `rejected`，飞书收到回执。
- AC1-5：`/list` 返回的待审核列表与 GitHub 上 `open` + 无 `approved` 的 issue **完全一致**。
- AC1-6：模拟飞书 3 秒超时——adapter 在 200ms 内返回，**不阻塞**后续异步任务（用日志时间戳证明）。

**退出条件**：AC1-1 ~ AC1-6 在真实环境各跑通一次，截图/issue 链接留档。
> ⚠️ 本阶段**不要求** workflow 真的写出代码——此时它仍是骨架，验收点是"被正确触发并留痕"。

---

### Phase 2 — 编码引擎：ClaudeSDKAgent 接入与权限围栏 🔴

**目标**：让"编码"这一步真的能在目标仓库的 feature 分支上改出文件，且跑在可控的笼子里。

| 工单 | 标题 | 要点 | 依赖 |
|------|------|------|------|
| P2-1 | 装包与注册 | `@mastra/claude` + `@anthropic-ai/claude-agent-sdk`；新建 `coder-agent`，`sdkOptions.cwd` = RepoTarget 路径 | P0-3 |
| P2-2 | **API 事实核对** | 装完立刻读 `.d.ts`，确认：① 取 agent 是 `getAgent` 还是 `getAgentById`（文档与现有代码不一致）；② `permissionMode` 是否被透传。**结论写进 `agent.md` §2.1** | P2-1 |
| P2-3 | 权限与预算围栏 | `allowedTools` 白名单 + `permissionMode: 'dontAsk'` + `maxTurns` + `maxBudgetUsd`；超限必须**显式失败**而非静默截断 | P2-2 |
| P2-4 | **红线拦截** | 禁写 `main`、禁 force push；受保护路径（`agent.md` / `.github/` / `.env*` / `src/mastra/{workflows,agents}/`）用 `disallowedTools` + hook 拦截 | P2-3 |
| P2-5 | CoderAdapter 抽象 | workflow 只依赖接口 `{ run(task, repoTarget) -> { diff, files, summary } }`，编码引擎可替换 | P2-4 |

**验收标准（AC2）**

- AC2-1：给 coder-agent 一个真实小需求（如"给 `src/service/user.service.ts` 加一个 `findByEmail` 方法"）→ 目标仓库 feature 分支上 `git diff` **可见真实改动**，文件确实被修改。
- AC2-2：命令它**修改 `agent.md`** → 被拒绝，且日志里有拦截记录；`git status` 显示 `agent.md` 未被改动。
- AC2-3：命令它 **`git push --force origin main`** → 被拒绝；`main` 的 remote HEAD 未变。
- AC2-4：把 `maxTurns` 调到极小值后跑一个复杂需求 → 任务**显式报"超出上限"并中止**，不是无限循环、不是静默返回半截结果。
- AC2-5：整个 run 过程**零弹窗阻塞**（无交互等待），总耗时与 token/cost 可在 Studio 查到。
- AC2-6：`getAgent` / `getAgentById` 的分歧已在 `agent.md` 写明并附 `.d.ts` 出处。

**退出条件**：AC2-1 ~ AC2-6 全绿。**红线（AC2-2/2-3）不通过 = 整个 Phase 2 不通过，不得进入 Phase 3。**

---

### Phase 3 — 质量闸门真实化（test / review / commit 从"提示词"变成"判据"）🔴

**目标**：把现在返回 `string` 的假闸门，换成返回**结构化结论**的真闸门，失败能自动打回重做。
**为什么关键**：现在 `testResult` 是一个字符串，workflow 无法判断"测试到底过没过"——条件边根本无从实现。

| 工单 | 标题 | 要点 | 依赖 |
|------|------|------|------|
| P3-1 | **结构化输出契约** 🔴 | 每个闸门 outputSchema 换成 zod：`test{passed, report}`、`review{decision, comments[]}`、`commit{message, lintPassed}` | P2-5 |
| P3-2 | 测试闸门 | 在 RepoTarget 目录**真跑** `npm test`，解析退出码与报告 → `{passed, report}` | P3-1 |
| P3-3 | 审核闸门 | dev-agent 加载 `code-review` skill，输入**真实 diff** → `structuredOutput {decision, comments[]}` | P3-1 |
| P3-4 | commit 闸门 | 生成 Conventional Commits + **真跑 commitlint**，不合规直接拒 | P3-1 |
| P3-5 | **条件边与重试上限** | test 失败 / review request changes → 回 coding 重做，**带最大重试次数**（防死循环），超限则中止并上报 | P3-2, P3-3 |

**验收标准（AC3）**

- AC3-1：注入一个**必然让测试失败**的改动 → 测试闸门返回 `passed: false`，workflow **自动回到 coding** 重做，重试次数被记录。
- AC3-2：达到重试上限后 → workflow **中止**并向飞书上报失败原因，**不无限循环**。
- AC3-3：注入一个干净改动 → test `passed: true` → review `decision: "approve"` → commit message 通过 commitlint。
- AC3-4：让审核闸门收到一段**有明显 bug** 的 diff → 返回 `request changes` 且 `comments` 非空、指向具体代码位置。
- AC3-5：构造一条不合规的 commit message → `lintPassed: false`，**不会**产生 commit。
- AC3-6：所有闸门输出均为 zod 校验通过的结构化对象（不是字符串解析出来的）。

**退出条件**：AC3-1 ~ AC3-6 全绿，其中 AC3-1 / AC3-2（失败路径）必须真实验到。

---

### Phase 4 — PR 与合并闭环（真实 GitHub）

**目标**：打通最后一公里——push、开 PR、飞书等人、squash 合并、关 issue。

| 工单 | 标题 | 要点 | 依赖 |
|------|------|------|------|
| P4-1 | push 分支 | 真实 push 到 `feat/<issue>-<slug>` | P3-5 |
| P4-2 | 开 PR | 标题 `<type>: <subject> (#<issue>)`；body 含改动摘要 + 测试结果 + review 结论；`Closes #<issue>` | P4-1 |
| P4-3 | 飞书卡片 + suspend | 推 `🔀合并` / `❌拒绝` 卡片；workflow `suspend()` 等人 | P4-2, P0-4 |
| P4-4 | resume 与合并 | 合并 → **squash merge** → 关 issue → label `merged`；拒绝 → 关 PR → label `rejected` | P4-3 |
| P4-5 | 状态机同步 | `open → approved → in_progress → pr_opened → merged/rejected`，每步 label 与飞书卡片**双向一致** | P4-4 |

**验收标准（AC4）— 端到端真实跑通一次**

- AC4-1：飞书提需求 → 点"可开发" → **点"合并"** → GitHub 上留下：issue（已关闭）、PR（squash merged）、`main` 上一条合规 commit。
- AC4-2：全程无人干预（除两次点击）；`main` 历史线性、无 merge commit、无 force push 痕迹。
- AC4-3：卡片点 `❌拒绝` → PR 关闭、issue 打 `rejected`、**`main` 完全没变**。
- AC4-4：label 迁移序列与状态机**逐一致**；任一环节的卡片文案与 GitHub 实际状态不矛盾。
- AC4-5：合并后 issue 自动关闭（靠 `Closes #n`，不是手动关）。

**退出条件**：AC4-1 完整跑通一次并留档（issue 链接 + PR 链接 + commit hash）。**这一条通过 = 项目 MVP 达成。**

---

### Phase 5 — 可观测性与成本控制

**目标**：让每一次自动开发**可回放、可计价、可重复触发而不出错**。

| 工单 | 标题 | 要点 |
|------|------|------|
| P5-1 | run 回放 | Storage 落库后，Studio 可回看每次 run 的每一步输入输出 |
| P5-2 | 成本核算 | 每次 run 的 token / cost / 耗时写回 issue 评论 |
| P5-3 | 幂等与失败告警 | 同一 issue 重复触发**不重复开发**；任一步骤失败主动推飞书告警卡片 |

**验收标准（AC5）**

- AC5-1：任意历史 run 可在 Studio 完整回放（含每步输入输出）。
- AC5-2：合并后的 issue 上有一条评论，含本次 run 的 token / cost / 耗时。
- AC5-3：对**同一个已 approved 的 issue 连点两次"可开发"** → 只产生一次开发流程（第二次被识别为重复）。
- AC5-4：人为制造一个 GitHub API 失败 → 飞书收到告警卡片，指明失败步骤与 issue 号。

---

### Phase 6 — 多仓库与多人化（MVP 之后）

| 工单 | 标题 | 要点 |
|------|------|------|
| P6-1 | 多仓库支持 | RepoTarget 外部化为仓库列表/配置；一个 pr-agent 服务多个目标仓库 |
| P6-2 | GitHub App 鉴权 | PAT → GitHub App + 最小权限 + 操作审计 |
| P6-3 | 多人审核与 CI 门禁 | 合并从"人类点卡片"升级为 CI 门禁（test+lint+commitlint）+ 有权限者批准 |

**验收标准（AC6）**

- AC6-1：切换 RepoTarget 到**另一个真实仓库**，全流程跑通（只改配置）。
- AC6-2：凭据从 PAT 换为 GitHub App，权限scope 收窄到 issue/PR/contents。
- AC6-3：`main` 开启分支保护后，Agent **无法通过**保护，必须走 PR + 门禁。

---

## 五、阶段依赖图

```
P0 地基 ──┬──> P1 飞书入口 ──┐
          │                  │
          └──> P2 编码引擎 ──┴──> P3 质量闸门 ──> P4 PR与合并 ──> P5 可观测 ──> P6 多仓库
                                                        │
                                                    🎯 MVP 达成（AC4-1）

硬阻塞边：
  P0-3 RepoTarget ──> P2-1（编码 cwd 依赖它）
  P0-4 Storage     ──> P1-4（卡片回调要 resume）、P4-3（suspend 等人）
  P2-5 CoderAdapter──> P3-1（闸门要吃结构化 diff）
  P3-1 结构化契约  ──> P3-2/3-3/3-4（三个闸门全部依赖）
  P3-5 条件边      ──> P4-1
```

---

## 六、待你拍板的 3 件事

1. **权限模式**：✅ 已拍板 —— `bypassPermissions` + `allowDangerouslySkipPermissions`，硬拦截靠 `guard.ts` PreToolUse hook（fail-closed）。（见 `agent.md` §4.1）
2. **模型分工**：✅ 已拍板 —— 闸门用中转站(`LLM_*`/glm 系)，编码用 ClaudeSDKAgent 走 lanfengai（已注入 `coding-agent.ts:122-147`）。接受两套 key。
3. **飞书凭据**：🟠 B5 是否具备仍待确认；但 D5 已拍板「先无 IM 闭环」，飞书 inbound 推迟到 Phase 1，故不阻塞主轴。
4. **目标仓库（D4）**：🟠 自举(改本仓库) vs 独立 demo 仓库，待拍板。

---

## 七、执行纪律

- 每个工单开工前读 `agent.md`；改完 Mastra API 事实，同步更新 `agent.md` §2.1。
- 测试节奏（2026-09-03 新规）：**不每文件/每提交跑测试**；一个需求完成后统一跑一次 `lint + build + test` 作收尾验证（`agent.md` §4 红线 3）。小改动可只跑 `npm run build` 做类型校验。
- 每个阶段验收不通过 → 不进入下一阶段。红线项（AC2-2 / AC2-3 / AC3-2）一票否决。
- 本仓库(pr-agent)开发允许直接改 `main`（用户决策 2026-09-03）；较大改动仍建议走 `feat/<issue>-<slug>` 分支 + Conventional Commits + squash merge。

## 关联

- `agent.md` — 行为约束与 API 事实（唯一真相源）
- `11-IM驱动的多Agent自动开发工作流设计.md` — 原始设计（§十二 的 Claude Code 待办已由本文档 §1.1 收口）
