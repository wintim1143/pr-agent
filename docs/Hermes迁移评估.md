# Hermes 迁移评估与方案（2026-09-17 · **待拍板**）

> **状态：评估文档，不是已批准的计划。** 本轮未改动任何里程碑卡。
> 待拍板项见 §9。触发：用户提出「把当前项目的功能全部放 Hermes 那边，需要做什么、怎么维护、怎么自定义功能」。
> 一手来源：`hermes-agent.nousresearch.com/docs`（含 `reference/tools-reference`、`user-guide/features/kanban`、
> `user-guide/messaging/feishu`、`user-guide/features/plugins`、`getting-started/installation`）与
> `open.feishu.cn` 长连接文档。

---

## 0. 一句话

**「全部搬过去」不成立——不是工作量问题，是形态约束。**
M4 判据引擎必须是**可独立单测的程序**，所以必须留在**独立进程**里，所以**必须**是 MCP server。
终局不是 pr-agent 消失，而是 **pr-agent 收缩成「判据 + 审计」两个服务面，其余全部交给 Hermes**。

> ⚠️ **这句话有前提**：全部阻塞都来自 M4。**若剥离 M4，该结论反转为「可以全部搬」**（❌ 集合为空）
> —— 推导与代价见 **§8**（2026-09-17 追加，回答用户「假设不考虑 M4，是否可以整体迁移」）。
> 但「剥离 M4」会**连带**带走 `guard.ts` 的写路径守卫（§8.2），那不是判据，是安全边界，别一起省掉。

---

## 1. 先把「当前项目的功能」拆开，逐项判搬得动吗

| # | 功能 | 现有载体 | Hermes 对应物 | 判定 |
|---|---|---|---|---|
| 1 | dev-workflow 编排 | Mastra workflow（step + suspend/resume + snapshot） | **Kanban 持久任务板** + dispatcher + profiles | 🟡 结构可换，**判据插槽缺失** |
| 2 | insight-workflow（只读洞察） | Mastra workflow | Hermes agent 原生能力（`read_file`/`search_files`/`terminal`/`web`） | 🟢 直接消失 |
| 3 | **M4 判据引擎** | `agents/guard.ts` + `dev-workflow.ts` 判据合成 | **无对应物** | ❌ **搬不动**（§2） |
| 4 | **M4 安全测试执行** | `adapters/test-runner.ts` | `terminal` + `test-driven-development` skill | ❌ **结构性保证丢失** |
| 5 | M6 run 级审计 | `log-store.ts` + `progress.ts` + runId 穿线 | Kanban `task_events` + session DB | 🟡 有审计，**无「按 run 重建时间线 + 成本归口」语义** |
| 6 | M5 多仓库 | `repo-registry.ts` + `RepoTarget` | Kanban **boards**（一 install 多 board）+ `Worktree` workspace | 🟢 结构等价 |
| 7 | M5a 幂等 | `dedup-store.ts`（SQLite） | Kanban **idempotency key**（"dedup for retried automation"） | 🟢 等价 |
| 8 | 并发锁 | `repo-lock.ts` | dispatcher 串行 claim + worktree 隔离 | 🟡 机制不同 |
| 9 | GitHub 读写 | `adapters/github.ts`（手写，fine-grained PAT） | `github` **MCP server** / github skills | 🟡 **不是等价物** |
| 10 | 飞书出入站 | `feishu.ts` + `inbound-poll.ts` | gateway（WS + 卡片回调 + 15min 去重 + 准入 + 群策略） | 🟢 直接给，**且更好** |
| 11 | LLM 抽象 | `llm/providers.ts` | `hermes model` + provider 体系 | 🟢 直接给 |
| 12 | 状态库 | `state-db.ts`（libsql） | Kanban `kanban.db` + session DB | 🟡 两套并存，需分工 |
| 13 | 定时触发 | **无**（空白） | **`cronjob`** toolset（含 pause/resume、skill-backed jobs） | ➕ **Hermes 独有** |

**统计**（13 行逐行数）：🟢 消失或直接给 **5** · ➕ Hermes 独有 **1** · 🟡 形态可换 **5** · ❌ 搬不动 **2**（都在 M4）。
若把 ➕ 并入 🟢：**🟢6 · 🟡5 · ❌2 = 13** ✓（2026-09-17 更正：原文写「🟢6 · 🟡6」合计 14，与 13 行不符）。

---

## 2. 为什么 M4 搬不动（第一性原理推演）

三个前提，任一不成立则结论反转。

### P1 · M4 的定义是「判据归属」，不是「更严的代码评审」

| 判据 | 归属 | 为什么 |
|---|---|---|
| `testsPassed` | 🟢 程序 | **事实**，需要执行力 |
| `agentModifiedTests` | 🟢 程序 | **检测**，需要比对 diff |
| `requirementMet` | 🔵 LLM | **语义**，需要阅读理解 |
| `passed` | 🟢 程序合成 | 决策规则 |

这是一个**正交拆分**。Hermes 的 `kanban_request_review` / `request_changes` + `github-code-review` skill
是**单一 LLM 评审 diff**。
把 M4 塞进 Hermes 的 review 步骤 = 把这个拆分压回**一个布尔**
—— **正是 M3 → M4 演进中被否掉的那个设计**。

### P2 · 程序判据必须可独立单测

现有资产：**291 个单测**（M6 收口 291/291），覆盖 M4 判据的**两条正交判负路径**：
① `testsPassed=false` + `requirementMet=true`（测试红）
② `testsPassed=true` + `requirementMet=false`（agent 主动拒绝执行）

若改成 Hermes 的两种扩展形态：

| 形态 | 后果 |
|---|---|
| **Skill**（markdown + 脚本） | 判据变成 **LLM 按文档自由裁量** → P1 直接崩 |
| **Plugin**（Python） | 需重写为 Python；**291 个 TS 单测作废**，且判据逻辑在 Hermes 侧无可验证性来源 |

→ **唯一同时满足 P1 + P2 的形态：M4 保持独立进程 + 暴露成 MCP 工具。**

### P3 · MCP 是唯一「Hermes 原生支持」且「能保住独立进程」的契约

官方 tools-reference 明示：Hermes 内建 MCP client，支持 **stdio + HTTP** 两种 transport，
启动时自动发现工具，并以 `mcp__<server>__<tool>` 前缀**注入所有平台 toolset**（零配置）。

**推论**：既然 M4 必须是 MCP server，pr-agent **不会消失**，只是**收缩**。
所谓「全部搬过去」的实际形态 = **pr-agent 从 41 个源文件收缩到「判据 + 审计」两个服务面**。

---

## 3. 目标架构

```
飞书群 / 私聊
   │  WS 长连接（仅 Hermes 持有）
   ▼
Hermes gateway ── 卡片回调 /card button {…} ──▶ gateway hook（确定性）
   │
   ▼
Kanban 任务板（kanban.db · dispatcher 每 60s）
   │  按 profile 分派
   ▼
worker 进程（implementer profile）
   │  mcp__pragent__*
   ▼
pr-agent  MCP server（HTTP · 127.0.0.1:8001/mcp）
   ├─ gate_check / test_run      ← M4 判据（护城河）
   └─ run_timeline / run_cost    ← M6 审计
```

**三层归属：**

| 层 | 归属 | 内容 |
|---|---|---|
| **L1 Hermes 原生** | 第三方 | IM 出入站、会话、路由、卡片、Kanban 编排、cron、记忆 |
| **L2 Hermes 扩展** | **我们写**（少量） | profiles 配置、skills（流程编排）、gateway hook（回调→确定性工具调用）、`github` MCP 配置 |
| **L3 pr-agent MCP server** | **我们写**（主要） | 判据 + 审计 + 安全测试执行 |

**硬约束（飞书官方原文）**：
> 「长连接模式的消息推送为**集群模式，不支持广播**，即如果同一应用部署了多个客户端，那么**只有其中随机一个**会收到消息。」

→ 同一飞书 app **不能有两个 WS 消费者**。Hermes 持 WS 后：
- ✅ pr-agent **保留 REST 出站 + 发卡**（`feishu.ts` 本来就走 `tenant_access_token` REST，**从未用过 WS**）
- ❌ pr-agent **不得起 WS**
- ❌ `POST /insights/feishu-poll`（`api.controller.ts:71`）**必须退役**

---

## 4. 需要做什么

### 阶段 0 · 装与配（半天）

1. ~~Windows 原生安装~~ → **✅ 已完成（2026-09-17 更正）**：Hermes **已部署在远程 Linux 服务器**
   （用户告知 `ssh tencent` 可登录）。官方 Linux 侧用 `install.sh`；安装器自带 Python 3.11 / Node / ripgrep / ffmpeg。
   ⚠️ 这条改动**连锁影响拓扑决定** —— 见 `Hermes迁移实施方案.md` §1
2. `hermes setup` 配 LLM provider（可复用现有 key）
3. `hermes gateway setup` → 飞书（**复用现有自建应用三件套**；`card.action.trigger` 只有自建应用支持，现有配置已具备）
4. ⚠️ **先停 pr-agent 的 `/insights/feishu-poll`**（`api.controller.ts:71`）
   —— **更正理由**：它不是 WS 客户端，**不构成长连接的"多消费者"冲突**；真正的问题是
   **同一条群消息会被两边各回一次**（Hermes 走长连接收到，pr-agent 走 REST 轮询也收到）→ **重复响应**。

### 阶段 1 · pr-agent 改造成 MCP server（**主要工作量**）

1. 加依赖：`@mastra/mcp` **当前未安装**（`node_modules/@mastra/` 只有 claude/core/deployer/koa/libsql/loggers/schema-compat/server）；
   也可直接用官方 `@modelcontextprotocol/sdk`
2. 挂到**现有 8001 服务**，路径 `/mcp`，走 **HTTP transport**
   —— ⚠️ **不用 stdio**：stdio 每次调用起新进程，工作流状态会丢；工作流必须跨工具调用存活
3. **工具面（草案）**：

| 工具 | 入参 | 返回 | 现在的家 |
|---|---|---|---|
| `dev_start` | `repo, requirement` | `{runId, status}` | dev-workflow 入口 |
| `dev_status` | `runId` | 阶段 / 卡在哪 / 判据现状 | log-store 时间线 |
| **`gate_check`** | `runId` | `{testsPassed, agentModifiedTests, requirementMet, passed}` | **M4 判据（核心）** |
| `test_run` | `repo, ref` | 结构化测试结果 | `test-runner.ts` |
| `run_timeline` | `runId` | 按 run 的事件序列 | `log-store.ts` |
| `run_cost` | `runId` \| `repo` + 时间窗 | 成本归口 | M6 |
| `repo_list` | — | 白名单仓库 | `repo-registry.ts` |

> ⚠️ **铁律 1 —— 所有工具立即返回，绝不阻塞到工作流结束。**
> MCP 是请求/响应模型；工作流跑几分钟会让调用方超时。工具形状恒为「起跑 + 查询」两段式。

> ⚠️ **铁律 2 —— `gate_check` 不把决策交给调用方 LLM。**
> 它返回**结构化判据**，决策规则**写在 pr-agent 里**。若让 Hermes 的 LLM 读判据再决定合不合，
> 等于把 M4 拆出来的正交维度又合回去（P1 失效）。

### 阶段 2 · Hermes 侧扩展（**我们写的部分，量小**）

| 做什么 | 形态 | 说明 |
|---|---|---|
| 3 个 profile：`orchestrator` / `implementer` / `reviewer` | 配置 | 每个 profile 可各自指定模型与工具集（`platform_toolsets`） |
| Kanban board 按 repo 分 | 配置 | 对应 M5 的 `RepoTarget`；单 install 可多 board |
| **把 M7 的路由表写成 skill** | Skill | ⚠️ 这是 M7 **唯一的幸存资产**（哪个指令触发哪个流程） |
| 卡片回调 → 确定性工具调用 | **Gateway hook** | ⚠️ **必须确定性**，不能交给 LLM —— 这是「合入 main」，与 M4 判据归属同源 |
| `github` MCP server 配置 | 配置 | 替代 `adapters/github.ts` |

### 阶段 3 · 验收判据（草案）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 真群里**点得动**按钮 | 人工点，看回调 |
| 2 | 卡片回调走**确定性**路径（非 LLM 自由裁量） | 断掉 LLM 后回调仍能触发工具 |
| 3 | 判据由 `gate_check` 产出，且与**现有 291 单测**结论一致 | 同 run 双跑对比 |
| 4 | Kanban **crash → reclaim** 不丢卡 | kill worker 进程，看 dispatcher 回收 |
| 5 | 同一飞书 app **只有 Hermes 一个 WS 消费者** | 断 pr-agent 侧任何 WS 依赖 |

---

## 5. 怎么维护

> 📌 **本节只讲「边界与依赖面」（谁在哪、依赖什么契约）。**
> 「**改了怎么知道没改坏**」—— 即环境形态的**变更-验证回路**（漂移检测、整装演练、`--safe-mode` 二分、功能清单）
> 见单独文档：**`docs/Hermes环境维护模型.md`**（2026-09-17 新增）。

### 5.1 三个仓库 / 目录，边界清晰

| 位置 | 内容 | 变更频率 | 怎么测 |
|---|---|---|---|
| **`pr-agent`**（现有 git 仓库） | L3 MCP server（TS）+ **291 单测** | 判据逻辑变动时 | `npm test`（**现有，不变**） |
| **`~/.hermes/`（应纳入 git）** | `config.yaml` / `skills/` / `hooks/` / `profiles` | 流程编排变动时 | 验收脚本（§4 阶段 3） |
| **Hermes 本体** | 第三方 | `hermes update`，**不 fork** | 官方 |

📌 官方支持 **`HERMES_HOME` 软链，以及 `hooks`/`skills`/`sessions`/`logs` 子目录软链**
（安装文档「Symlinked home directories and external storage」节）→ 可以直接把 `~/.hermes` 指向一个 git 仓库，**配置即代码**。
若软链目标不可达，Hermes 会**主动停下报存储错误**而不是覆盖链接——这是好事（不会静默写坏）。

### 5.2 依赖面：只依赖两个契约（升级风险控制）

| 契约 | 定义方 | 稳定性 |
|---|---|---|
| **MCP 工具协议** | 标准（不由 Hermes 定义） | 高 |
| **Kanban 的 task / status 状态机** + `kanban_*` 工具名 | Hermes | 中 |

`triage | todo | ready | running | blocked | done | archived`

> ⚠️ **不要依赖 Hermes 内部实现**。`hermes update` 之后跑一次 §4 阶段 3 的验收脚本即可。

### 5.3 部署：两个常驻进程

| 进程 | 运行时 | 端口 |
|---|---|---|
| `hermes gateway` | Python（Hermes 自带 venv） | profile 级 `gateway.api_server.port` |
| pr-agent | Node ≥20（`npm start`） | **8001**（含 `/mcp`） |

⚠️ **Windows 上两个坑**：
1. Hermes 会复用系统 Node **22.22+ / 24.11+ / 26+**；本机现有 **24.10.0 低于 24.11** → 它可能自行装 Node 26
2. **每个 profile 的 `gateway.api_server.port` 必须唯一**（默认值会撞），否则「port already in use」+ 零平台连接

---

## 6. 怎么自定义功能（扩展面对照表）

| 扩展面 | 形态 | 适合什么 | 我们的用法 |
|---|---|---|---|
| **MCP server** | **外部进程**（stdio / http） | **领域逻辑、需要独立单测的程序** | ✅ **M4 判据 + M6 审计 + 安全测试执行** |
| **Plugin** | Python 包 / 目录 + `plugin.yaml`（`provides_tools`/`provides_hooks`） | 生命周期钩子、新工具、slash command | 暂不用（要写 Python） |
| **Skill** | markdown + 脚本，兼容 agentskills.io，可从 git 装 | **流程知识 / 套路** | ✅ 路由编排、评审话术 |
| **Gateway hook** | `HOOK.yaml` + `handler.py`，事件 `gateway:startup` / `session:start` / `agent:end` / `command:*` | 事件驱动反应 | ✅ 卡片回调 → 工具调用 |
| **Shell hook** | `config.yaml` 的 `hooks:` shell 模板 | 通知 / 审计 | 可选 |
| **Profile** | 配置 | 角色分权（模型 + 工具集） | ✅ orchestrator / implementer / reviewer |
| **Cronjob** | 调度（`hermes` CLI / `cronjob` 工具） | 定时任务 | 未来 |

### 选择规则（一条就够）

> **这段逻辑需要独立单测吗？**
> - **需要** → **MCP server**（写 TS，进 pr-agent）
> - 不需要，是「怎么做好一件事的套路」 → **Skill**
> - 是「事件发生时自动反应」 → **Gateway hook**
> - 是「换 LLM / 换平台 / 换存储」 → 用 Hermes 已有的 provider / adapter / 配置，**不自己写**

⚠️ 官方在插件指南里明确：**集成第三方产品的插件应作为独立仓库分发，不并入 Hermes 核心树**
（「a coupling-and-maintenance decision... not a quality bar」）→ 我们若写 plugin，也放自己的仓库。

---

## 7. 诚实记录：风险与代价

| 风险 | 说明 | 缓解 |
|---|---|---|
| **攻击面变大** | Hermes 自带 `terminal` / `browser` / `file` / `computer_use`（6 种终端后端，含 `local`），而它面朝群聊。pr-agent 至少有 M4 的 `guard.ts` 白名单 + 子进程 env 剥离凭据 | profile 级 `platform_toolsets` 裁剪 + `FEISHU_ALLOWED_USERS`。⚠️ 用户已说「权限先不考虑」→ **记账不做，但不可遗忘** |
| **测试执行保证降级** | 不再有「完全不经过 npm/npx + 按文件存在性选 runner + env 剥离凭据」。若走 Hermes 的 `terminal` 跑测试，**M4 的安全边界失守** | **`test_run` 也做成 MCP 工具**，测试执行留在 pr-agent 内（见 §9 待拍板 4） |
| **291 单测是唯一可验证性来源** | 搬走即丢 | 留在 pr-agent，`npm test` 不变 |
| **两套状态库** | Kanban `kanban.db` + pr-agent SQLite | 明确分工：**Kanban = 任务生命周期**，**SQLite = run 判据与日志** |
| **成本归口无等价物** | 本次查到的 Hermes 文档中未见「按 run 归因」的对应物 | 保留在 pr-agent 侧（`run_cost`） |
| **第三方不可控** | `hermes update` 可能改 Kanban 工具签名 | 只依赖契约（§5.2）+ 验收脚本回归 |
| **反转已记录决策** | `docs/archive/11-IM驱动的多Agent自动开发工作流设计.md:29` 显式写过「纯 Mastra + 自建轻量 IM adapter（**不引入 Hermes**）」 | 前提已变：当时判「自建更便宜」，而 M7+M8 的实际体量 + Hermes 的原生覆盖推翻了该前提。**反转理由须写进卡里**（否则下次会当成文档幻觉） |

---

## 8. 假设剥离 M4：能否整体迁移（2026-09-17 追加）

> 触发：用户提问「假设不考虑 M4 部分，有需要我们再补充呢，那是否可以整体迁移」。
> 本节回答的是**搬不搬得动**，不是**该不该搬**。

### 8.1 结论

**能，而且是 100% 能。** §1 的 ❌ 只有 2 项，**两项都在 M4** → **去掉 M4 = 去掉整个阻塞集合**。
「全部搬过去」从**不成立**变成**字面成立**。

但必须把「不考虑 M4」拆成两种读法 —— **成本差一个数量级**：

| 读法 | 含义 | 迁移后 | 「以后再补」的成本 |
|---|---|---|---|
| **A · 不接进流程** | M4 的代码与出口**留着**，只是新流程不调它 | **期权保留** | **小时级**（接一行调用） |
| **B · 不做这个能力** | M4 连同守卫一起不做 | 能力消失 | **天级**（重建进程 + 重验 291 单测在今天的 node 上还绿） |

**建议 A**：保留期权的增量成本 ≈ 0；B 把「以后再补」从**改调用**变成**重建工程**。

### 8.2 ⚠️ 剥离 M4 会连带带走两样东西，不止「判据」

| 连带物 | 载体 | 为什么跟着走 |
|---|---|---|
| 判据合成 | `dev-workflow.ts:807-892`（`testsPassed` / `agentModifiedTests` / 合成 `passed`） | 它是 **Mastra step 内的代码**（`testStep`），Mastra 不跑就没有宿主 |
| **写路径守卫** `guardToolCall` | `guard.ts` + **`coding-agent.ts:313-318` 的 `PreToolUse` hook** | ⚠️ 它挂在 **Mastra agent harness** 上。编码改由 Hermes 委托 `claude-code` 之后，**guard 没有插入点** → `PROTECTED_PATHS`（写受保护路径 → deny）与 `main`/`master` 分支拦截**一并失效** |

第二条是**具体可指的损失**，不是气质问题。**替代路径存在**（§8.4），但**不是自动获得**。

### 8.3 剥掉 M4 后，剩余 11 项逐条复核（= §1 去掉第 3、4 行）

| 原 # | 功能 | 剥 M4 后 | Hermes | 备注 |
|---|---|---|---|---|
| 1 | dev-workflow 编排 | 退化为「编码 → 审核 → commit/push → PR → merge」线性流 | 🟢 | Kanban + profiles 覆盖 |
| 2 | insight-workflow | 不变 | 🟢 | — |
| 5 | M6 run 级审计 | **缩水**：`test:run` / `test:touch` 两类事件随 M4 消失 | 🟡 | ⚠️ **新必做项**：`runId` ↔ Kanban `task id` 映射（§8.5.3） |
| 6 | M5 多仓库 | 不变 | 🟢 | — |
| 7 | M5a 幂等 | 不变 | 🟢 | idempotency key |
| 8 | 并发锁 | 不变 | 🟡 | ⚠️ **worktree ≠ 独立 clone**（§8.5.2） |
| 9 | GitHub 读写 | 不变 | 🟡 | ⚠️ 降级边界见 §8.5.1 |
| 10 | 飞书出入站 | 不变 | 🟢 | gateway |
| 11 | LLM 抽象 | 不变 | 🟢 | — |
| 12 | 状态库 | 不变 | 🟡 | Kanban.db 并存，需分工 |
| 13 | 定时触发 | 不变（原本就是空白） | ➕ | `cronjob` |

**复核后统计**：🟢（含 ➕）**6** · 🟡 **5** · ❌ **0** —— **阻塞集合为空。**

### 8.4 那两处「连带的」能不能补回来

| 损失 | 替代路径 | 置信 |
|---|---|---|
| **写路径守卫**（路径维度） | **Claude Code 自身的 `PreToolUse` hook**（`claude -p` 被 Hermes 以 CLI 调起时，走 Claude Code 的 hooks 配置，而非 Mastra 的） | **中高** —— 用户本机**已有**这套基建（rtk 就是 Claude Code 的 PreToolUse hook）→ 迁移面明确 |
| **测试执行安全**（命令维度） | Hermes 侧 **`approvals` 配置 + 内建危险命令 denylist**（`rm -rf` / `git push --force` / pipe-to-shell 等，含不可覆盖的 hardline blocklist） | **中低（二手）** —— 来源是社区指南（自称 schema 对齐 v0.18），**未在官方配置参考核实** |

⚠️ **口径必须分清，别混为一谈**：

- `guard.ts` 是**路径维度**（`Write`/`Edit`/`MultiEdit` 写 `PROTECTED_PATHS` 里的文件 → deny）
- Hermes 的 `approvals` 是**命令字符串维度**（危险的 shell 命令 → 拦截）
- **两者不等价**：一条 `Write` 工具调用去写 `.env`，在命令过滤器里**拦不到**
→ 所以**第一行（Claude Code hook）才是等价补法**；第二行只是**部分覆盖**，且置信度不足。

### 8.5 三条与 M4 无关、但迁移后仍是净新增的工作

**别把「剥离 M4 省下的」当成净赚** —— 下面三条不会因此消失。

**8.5.1 GitHub 操作的降级边界（细化 §1 第 9 行）**

新证据：Hermes 的 `github-pr-workflow` skill 是**驱动 `gh` CLI** ——
官方技能文档原文："每个部分先展示使用 `gh` 的方法，然后展示用于没有 `gh` 命令的机器的 `git` + `curl` 备用方案"，
配套 `github-auth` / `github-code-review` / `github-issues` / `github-repo-management`。

→ **执行层仍是 shell 命令（`gh pr create` / `gh pr merge`），不是 LLM 凭空编 API 调用。**
所以「降级」要**细化**为：**执行等价，决策主体换了。**

| 面 | 等价性 |
|---|---|
| push / PR / merge 的**机械调用** | 🟢 可覆盖 |
| **谁决定何时合** | 🟡 从「程序合成 `passed`」变成「LLM 判断 + skill 流程」 |
| **细粒度权限范围** | ⚠️ 现用 fine-grained PAT（多 repo、作用域明确）；skill 走 `gh auth` / `GITHUB_TOKEN`，作用域一致性**取决于你怎么配**，不是白给 |
| **错误处理路径** | ⚠️ `github.ts` 现有 **15 个单测**覆盖失败分支；skill 是 prompt，**无等价物** |

**8.5.2 `Worktree` ≠ 独立 clone（并发语义不同）**

| | 我们（M5 `RepoTarget`） | Hermes Kanban `--workspace worktree` |
|---|---|---|
| 形态 | **独立 clone** | 同一 clone 的**分支隔离**（共享 `.git`） |
| 磁盘 | 每 repo 一份 | ✅ 省 |
| 并发 | ✅ 各自独立 `.git`，互不干扰 | ⚠️ 共享 `.git` → 并发 `git` 写（`index.lock` / refs）**仍会撞** |

佐证（社区指南，讲编码 agent 并行时）：明确写「**没有** `delegation.git.locks` 配置块替你强制这件事」，
隔离靠 git 原生手段（一分支一委派、worktree）+ **约定**。

→ **别默认 worktree 白送并发安全。** 这恰好是 M5 `repo-lock.ts`（13 单测）+ M6 修 `SQLITE_BUSY` 那一轮花力气的地方。

**8.5.3 `runId` ↔ Kanban `task id` 映射（净新增）**

M6 的全部价值建立在 **`runId` 是全局唯一关联键**（实测覆盖 57/57）之上。迁移后 Kanban 用自己的 **task id**。
→ 缺一张映射表，「飞书上点了按钮 → 该查哪条日志」这条链就断。
**M6 没覆盖这件事**（它假设 runId 由我们生成且全局唯一）。

### 8.6 唯一不可逆的代价（一行，不展开）

`test` 步之后流程里有**两道闸门**：

1. `if (!passed)`（`dev-workflow.ts:951`）—— **程序合成**（真跑过测试 + LLM 判需求是否实现）
2. `reviewResult.decision === 'request-changes'`（`:1010`）—— 程序**检查** LLM 判决（判定是程序做的，但输入是 LLM 结论）

剥离 M4 后**第一道消失**，只剩第二道 → **「程序真的跑过测试」这个事实不再进入准入条件**。
你自己的实测证据（两条正交判负路径）说明这会让「agent 改测试自证通过」这类失败**变得不可见**。

用户已明示「M4 先不考虑」，故**只记不辩** —— 但要落进 §9 待拍板（第 5 条），选项含「**保留桩但不拦**」这个折中。

### 8.7 判据再放松：「类似功能」够用吗（2026-09-17 用户追加约束）

**用户新约束**：「我们**不需要把所有逻辑一模一样搬过去**，Hermes 那边只要**支持类似的功能**就行。」

→ 这把判据从**等价**放宽到**能力覆盖**，**§8.1 的「剥离」动作因此不必要了** —— 因为 M4 也不是「无对应物」，
而是「**有类似物、但等级不同**」。

| 判据 | ❌ 项 | 整体迁移成立吗 | 需不需要先「剥离 M4」 |
|---|---|---|---|
| 严格**等价**（§1 原始口径） | 2（都在 M4） | ❌ 不成立 → pr-agent 必须作 MCP server | — |
| **剥离 M4**（§8.1） | 0 | ✅ 成立 | **需要**（先做一次剥离决策） |
| **能力覆盖**（§8.7 · 用户设定） | **0** | ✅ **成立** | **不需要**（接受降级即可） |

⚠️ **但要分清「类似」买到了什么、丢了什么**：

| | 含义 | 判据放松后 |
|---|---|---|
| **能力覆盖** | 这件事**做得了吗** | ✅ 买到 |
| **保证等级** | 做这件事时**给你的确定性一样吗** | ❌ 丢掉 |

具体到那两项：

| 项 | 「类似物」 | 能力 | 丢掉的保证 |
|---|---|---|---|
| M4 判据引擎 | `kanban_request_review` + `github-code-review` skill | ✅ 都能「改完让人审」 | 从「**程序跑测试** + LLM 判需求」变成「**LLM 看 diff**」 |
| M4 安全测试执行 | Hermes `terminal` | ✅ 都能「把测试跑起来」 | 「不走 npm/npx + 按文件存在性选 runner + env 剥离凭据」三层约束 |

📌 **「类似」什么时候会不够用？** 给一条可推翻条件，别让它无限期漂着：

> 当你需要**归因**（这个结论**是谁**得出的、**可信度**多少）而不只是**结果**的时候。

M4 存在的唯一理由就是这个 —— 所以这是一次**有意识的降级**，不是「那个功能不需要」。
用户已明示先不考虑，**记为已知代价，不阻塞**。

---

## 9. 待拍板

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| 1 | **确认反转** | 引入 Hermes 作前端 + 编排，推翻 `archive/11` 的旧决策 | 决定 M7/M8 卡的存废 |
| 2 | **Hermes 装哪台** | 本机 Windows 原生 / Mac / VPS | 决定 MCP 走 HTTP 还是 stdio（同机 → HTTP 最简） |
| 3 | **编排层走哪条** | (i) Kanban 当上层、Mastra 保留完整 workflow ／ **(ii) pr-agent 收缩成 MCP 服务** | **本文档假设 (ii)**；(i) 改动更小、M1–M6 全留 |
| 4 | **`test_run` 是否进 MCP** | 是（测试执行留在 pr-agent）／ 否（交给 Hermes `terminal`） | 决定 M4 安全边界是否失守 |
| **5** | **降级到「类似功能」后的**处置形态（§8.7） | **A 保留 M4 出口但不接进流程**（推荐，期权 ≈ 0 成本）／ B 不保留（以后再补 = 天级）／ C pr-agent 整体归档 | 决定「以后再补」是**小时级**还是**天级** |
| **6** | **`guard.ts` 写路径守卫的替代落点**（§8.4） | Claude Code `PreToolUse` hook（**等价**，本机已有基建）／ 只用 Hermes 命令级 approval（**不等价**，漏文件路径）／ 接受失守 | 决定 `PROTECTED_PATHS` 与 `main`/`master` 是否仍有拦截 |

> 📌 **另有 3 条属「环境维护模型」而非「搬不搬」的待拍板**（环境仓库放哪 / 软链粒度 / 演练频率）
> —— 见 **`docs/Hermes环境维护模型.md` §8**。
>
> 📌 **另有 8 条属「怎么落地」的待拍板**（拓扑 / 服务器侧 LLM 端点 / 环境仓库放哪 / 软链粒度 /
> `dev_start` 是否人工点头 / `dev_decide` 的确认面 / 「当前」超时 T / MCP 实现选型）
> —— 见 **`docs/Hermes迁移实施方案.md` §6**。该文档同时给出 **M9–M14 迁移里程碑草案**
> （⚠️ **草案，尚未替换 `milestones/` 下的卡片**）。


---

## 附：本文档的证据来源

| 结论 | 来源 | 置信 |
|---|---|---|
| Hermes 有 Kanban 持久任务板 + block/unblock 恢复 | `hermes-agent.nousresearch.com/docs/user-guide/features/kanban` | 高（官方） |
| Hermes 无内置 github 工具集，须走 MCP | `.../docs/reference/tools-reference`「MCP Tools」节 | 中高（官方页，经摘要） |
| Hermes 内建 MCP client（stdio + HTTP） | `.../docs/reference/tools-reference` + plugin 指南 | 高（官方） |
| 飞书长连接集群模式、事件只有一个消费者 | `open.feishu.cn`「使用长连接接收事件」 | 高（官方原文） |
| Windows 原生安装脚本存在 | `.../docs/getting-started/installation` | 高（官方） |
| `HERMES_HOME` 及子目录可软链 | 同上「Symlinked home directories」节 | 高（官方） |
| per-profile 端口必须唯一、`kanban.checkpoints` 等配置项 | 二手（社区实现文章 / LobeHub skill 页） | **低 —— 未在官方页核实** |
| **§8.5.1** `github-pr-workflow` skill 驱动 `gh` CLI，另配 git+curl 备用方案；配套 `github-auth`/`github-code-review`/`github-issues`/`github-repo-management` | 官方技能文档（经第三方镜像 `hermes-agent.lzw.me/docs/user-guide/skills/bundled/github/...`） | 中高（官方内容，镜像转载） |
| **§8.5.2** 每个 Kanban 卡片可获独立 git worktree（"real, supported isolation"） | 官方 kanban 文档（Workspace 三态）+ 社区指南 | 高（官方） |
| **§8.5.2** 「没有 `delegation.git.locks` 配置块替你强制」并发隔离，靠 git 原生手段 + 约定 | 二手（`OnlyTerp/hermes-optimization-guide` part18） | **低 —— 未在官方配置参考核实** |
| **§8.4** Hermes 侧 `approvals.mode` + 内建危险命令 denylist（`rm -rf`/`git push --force`/pipe-to-shell，含不可覆盖 blocklist） | 二手（同上，自称 schema 对齐 v0.18） | **低 —— 未在官方配置参考核实** |
| **§8.4** Hermes 可通过 `pre_tool_call` / `post_tool_call` **plugin hooks** 拦截工具调用 | 二手（第三方插件 `mosqlee/hermes-delegate-guard` 依赖它）+ 官方 plugin 文档提及 hooks 存在 | 中（hook 存在性可信；具体 hook 名未在官方页逐字核实） |
| **§4/§8.4** Hermes 以 CLI/ACP 方式委托 Claude Code / Codex / OpenCode（`claude -p`、`codex exec`、`opencode run`） | 二手（社区指南 part18 + skill 聚合页） | 中（与官方「skills 委托给 coding CLI」一致，但命令形态未在官方页逐字核实） |
| **§8.1** 「以后再补 M4」= 需重建可独立单测的进程 | 本项目自身（`test/` 16 文件 / 291 用例，M4 相关约 4 个文件） | 高（本地可复跑） |
