# Hermes 环境维护模型（2026-09-17 · 「环境形态」怎么维护功能）

> 触发：用户提问「我们当前是**通过项目启动**的，但是 Hermes 更像一个**环境**，这个应该要怎么维护功能呢」。
> 前置：`docs/Hermes迁移评估.md`（讲**搬不搬**）。本文只讲**搬过去之后怎么活**。
> 本文与 `Hermes迁移评估.md` §5 的分工：§5 讲**边界与依赖面**（谁在哪、依赖什么契约）；
> 本文讲**变更-验证回路**（改了怎么知道没改坏）。

---

## 0. 一句话

**环境形态不是「没有维护机制」，是维护机制换了一整套。**
你熟悉的那套（改代码 → 编译 → 单测 → 重启）**大部分能找到对应物**，**唯独「单测」没有等价物** ——
它被替换成「**整装环境演练**」。

一句话记住粒度差：

> **项目形态的测试单位是「函数」；环境形态的测试单位是「整个 profile」。**

---

## 1. 心智转换：同一个东西，换了位置和名字

| 项目形态（pr-agent 现状） | 环境形态（Hermes） | 现成命令 |
|---|---|---|
| 源码 = git 仓库 | **profile 目录**（`~/.hermes/profiles/<name>/`）= 待纳入 git | `hermes config path` / `config env-path` |
| 编译 / 类型检查 | **`hermes config check`**（缺项、过时项） | `hermes config check` / `config migrate` |
| **单测（291 个）** | ⚠️ **无等价物** → 降级为「整装环境演练」（§3） | **需自建** |
| 依赖解析 | 按平台启用哪些 toolset / skill / MCP | `hermes tools list` / `skills list` / `mcp list` |
| 部署（重启进程） | `hermes gateway restart`；skill 改动用 `/reset`；代码改动重启 CLI | 分三档：MCP → **`/reload-mcp`**；skill → **`/reset`**；其他 → `hermes gateway restart`（§4） |
| 排障 bisect | **`hermes --safe-mode`**（关掉全部定制） | `hermes --safe-mode` |
| 发布 = tag | **`hermes profile export` → tar** | `hermes profile export` / `import` |
| `find src -name '*.ts'`（看有什么） | **三条 list 命令** = 环境的「目录树」 | `tools list` / `skills list` / `mcp list` |

📌 **表里最值钱的两条**：
- **`hermes --safe-mode`** = 环境形态的**排障刀**（关掉全部定制 → 二分「是不是我的定制搞坏的」）
- **`hermes profile export`** = 环境形态的**「构建产物」**（环境可打包、可还原）

⚠️ **置信标注**：`user-guide/profiles` 页为**官方直读（高置信）**；
上面这串 CLI 命令面来自**三处转载且彼此一致**（形似官方 `reference/cli-commands` 原文），
标 **中高** —— 装完用 **`hermes --help`** 当场核实一遍（这正是本项目「断言必须能反查」的规矩）。

---

## 2. 环境形态独有的问题：**漂移**（项目形态没有）

| | 项目形态 | 环境形态 |
|---|---|---|
| 真相源 | **源码唯一**，`dist/` 可丢弃重建 | `~/.hermes/profiles/<name>/` 是**活着的目录** |
| 期望态 vs 实际态 | **不会不一致** | ⚠️ **会漂** |

**三个漂移源**：

1. 你手工 `hermes config set` 了几次，**忘了写回仓库**
2. **`hermes update` 会把新 bundled skills 同步到所有 profile**（官方 profiles 页明写）→ **上游替你改环境**
3. agent 自己在 session 里改了 config / 装了 skill

→ **需要「期望态 vs 实际态」的 diff。Hermes 没有内置这个**
（`config check` 只查缺项/过时，**不是** diff 你的仓库）。

### 推荐做法：让「期望态」可被 `git status` 直接看见

```
hermes-env/                       ← 🆕 git 仓库 = 环境的真相源（本机编辑，服务器执行）
├── profiles/
│   └── <name>/
│       ├── config.yaml
│       ├── SOUL.md
│       ├── skills/            ← 自己写的
│       ├── hooks/  plugins/
│       └── .env.example
├── scripts/                   ← ⚠️ .sh 不是 .ps1：真正执行的是 Linux 服务器
│   ├── deploy.sh              ← 幂等施加到 ~/.hermes/（软链或复制）+ reload
│   ├── drift.sh               ← 期望态 vs 实际态 diff
│   └── verify.sh              ← 验收脚本（§3）
└── .gitignore                 ← 排掉运行时状态
```

⚠️ **脚本后缀 = `.sh`，不是 `.ps1`**（2026-09-17 更正）：Hermes 部署在**远程 Linux 服务器**上
（用户告知 `ssh tencent` 可登录），仓库虽然在本机 Windows 编辑，但 `deploy` / `drift` / `verify`
**真正执行的位置是服务器** → 必须写 POSIX shell。若本机也要跑同套脚本，再另加 `.ps1` 包装，**不要二选一地猜**。

**依据**：官方支持 **`HERMES_HOME` 及 `hooks` / `skills` / `sessions` / `logs` 子目录软链**
→ **可以只把「功能定义」软链进仓库，运行时状态留在原地**。

⚠️ **这是环境形态唯一真正需要小心的地方**：

> `~/.hermes/` 把「**功能定义**」和「**运行时状态**」放在**同一个目录**里。
> 项目形态里 `src/` 与 `node_modules/` / `dist/` 是天然分开的 —— 环境形态没这个天然边界。

| 进 git（功能定义） | **不进 git（运行时状态）** |
|---|---|
| `config.yaml` / `SOUL.md` | `state.db`（sessions，SQLite + FTS5） |
| `skills/`（自己写的） | `kanban.db`（任务板） |
| `hooks/` / `plugins/` | `logs/` |
| `.env.example` | `.env`（凭据） |
| `scripts/` | `memories/`（agent 自写） |

**软链粒度如果只能到整个 `~/.hermes/`，`.gitignore` 就成了唯一防线** —— 漏一个，`git status` 天天脏。

---

## 3. 环境的「测试」= 整装演练（替换掉单测）

**没有单测的等价物** —— 环境里没有「纯函数」可单测。但有一条替代路径，**而且官方给了工具**：

> **`hermes profile create tmp --clone-all`**
> 官方 profiles 页：「Copies everything — config, API keys, personality, all memories, full session history,
> skills, cron jobs, plugins. **A complete snapshot.**」

→ 得到一个**完整环境的副本** → 在副本里施加改动、跑演练 → 绿了才 promote 到正式 profile。

**这就是环境形态的「编译 + 测试」。** 粒度是整装环境，所以**按改动面分级**：

| 改动面 | 跑什么 | 成本 |
|---|---|---|
| `config.yaml` 键值 | `hermes config check` + `hermes doctor` | 秒级 |
| skill / hook 文档 | 临时 profile 里 `/skill` 加载 + 走一遍 | 十秒级 |
| **MCP 工具面（pr-agent）** | `hermes mcp test NAME` + 项目的 **291 单测** | 秒级 |
| 跨链路（飞书 → 路由 → 工具 → Kanban） | 临时 profile + `--clone-all` 全链路演练 | 分钟级 |

📌 **关键分层（这不是妥协，是两种变更用两种验证）**：

> **需要「保证等级」的逻辑留在项目形态**（MCP server → 编译 + 291 单测）
> **「配出来的」逻辑才进环境形态**（skill / config / hook → 靠演练）

---

## 4. 变更流程（对应项目的 locate → confirm → edit → compile → log）

| 步 | 项目形态 | 环境形态 |
|---|---|---|
| 1 · 改 | 编辑 `src/*.ts` | 编辑仓库里的 `config.yaml` / `SKILL.md` |
| 2 · 验 | `npm test`（**秒级**） | `profile create tmp --clone-all` → apply → 演练（**分钟级**） |
| 3 · 施加 | 编译产物即生效 | **按改动面分级，默认不重启**（见下） |
| 4 · 记录 | `git commit` | `git commit`（**同一个习惯，不用换**） |
| 5 · 防漂移 | **不存在这一步** | `drift.sh` 定期跑（在**服务器**上跑） |

⚠️ 第 2 步比 `npm test` **贵两个数量级** → **不要每次改动都跑全量演练**，按 §3 分级走。

⚠️ **更正（2026-09-17）：第 3 步不是「一律重启 gateway」。** 官方现成机制按改动面分（`user-guide/features/mcp`）：

| 改了什么 | 正确做法 |
|---|---|
| **MCP 配置**（`mcp_servers` 增删改 / 换凭据） | **`/reload-mcp`**（会话内）—— 官方明写 *no restart needed* |
| **Skill** | 会话内 **`/reset`** |
| `config.yaml` 其他键 / hook 代码 | `hermes gateway restart`（**最后手段**） |

**默认走 `/reload-mcp` + `/reset`，重启是例外。**

### 4.1 怎么加一个功能：先选插槽，再三步走

**第一步不是写代码，是选插槽。** 判据只有一条：这件事需要「**保证等级**」吗（要单测、要确定性、要能反查）？

| 插槽 | 什么时候用它 | 放哪 | 怎么生效 | 怎么验 |
|---|---|---|---|---|
| **1 · MCP 工具** | 要写代码、要能被单测、要**确定性** | pr-agent 仓库（TS） | `<环境>/config.yaml` 的 `mcp_servers:` 指向 pr-agent | `npm test` + `hermes mcp test pr-agent` |
| **2 · Skill** | 教它「怎么做一件事」，纯文档（可附脚本） | `<环境仓库>/skills/<名>/SKILL.md` | 软链到 `~/.hermes/skills/`；session 内 `/reset` | 临时 profile 里说触发它的话 |
| **3 · Hook** | 「事件 X 发生 → 固定动作 Y」，**绝不能交给 LLM 判断** | `<环境仓库>/hooks/<名>` | 软链 + `hermes gateway restart` | 真造一次事件（如真点卡片） |
| **4 · Cron** | 到点自动跑 | 不落文件 | 官方命令 `hermes cron add` | `hermes cron run <id>` |

**① Skill（最常用，新功能先从这个试）**

1. 建 `skills/<名>/SKILL.md`，开头 frontmatter 写 `name` + `description`
   —— ⚠️ **`description` 决定「什么时候自动想起它」**，不是简介，要写清**触发场景**
2. 正文 = 步骤清单；可附脚本放同目录，用相对路径调用
3. 软链到 `~/.hermes/skills/`，session 内 `/reset` 重新加载，然后用自然语言试触发

**② MCP 工具（只有需要「保证等级」时才做）**

1. pr-agent 里写工具，`npm test` 过（**这一步是它存在的全部理由**）
2. `<环境>/config.yaml` 加 `mcp_servers:` 一段
3. `hermes mcp test <名字>` 验证连通 → **`/reload-mcp` 即可，不用重启 gateway**

📌 **写工具前先决定「谁能放行」**：MCP 标准注解 `readOnlyHint: true` 的工具免批准；
server 标 `trust: untrusted` 时**所有写工具每次调用都要人工点头**（fail-closed）。
**不要自己造审批** —— 详见 `Hermes迁移实施方案.md` §4.2 的三级闸门。

**③ Hook（事件驱动、必须确定性）**

1. `<环境仓库>/hooks/` 写脚本（**POSIX shell**，在服务器上跑）
2. config 里把它挂到对应事件上
3. `hermes gateway restart`（**hook 改动属"必须重启"那一档**），然后**真造一次事件**验证
   —— 脚本对不对，只有真事件说了算

📌 **一条容易搞混的**：Skill 是「**告诉它怎么做**」，MCP 是「**给它一个能调的能力**」。两者不互斥——
一个功能常常 = **Skill 描述流程 + MCP 工具干活**。
例：「`/dev` 起开发流程」= skill 负责路由与话术 + `dev_start` 工具负责真起流程。

---

## 5. 环境特有的维护便利（官方现成，**别自己造**）

| 命令 | 作用 |
|---|---|
| `hermes config check` / `config migrate` | 升级后配置缺项 / 过时项 |
| `hermes doctor [--fix]` | 依赖 + 配置体检 |
| **`hermes --safe-mode`** | **关掉全部定制**（含 AGENTS.md / SOUL.md / memory / skill 注入）→ 二分定位 |
| `hermes mcp list` / `mcp test NAME` | MCP 契约连通性 |
| `hermes profile export` / `import` | 环境快照 / 还原 |
| `hermes dashboard` | Web 管理面板 |
| `hermes status [--all]` | 组件状态 |
| `hermes skills check` / `update` | skill 更新面 |

---

## 6. ⚠️ 三条与维护直接相关的**官方硬约束**

1. **Profile 不做沙箱** —— 官方原文：
   > 「A profile does not stop it from accessing folders outside the profile directory.」
   > 「SOUL.md can guide the model, but it does not enforce a workspace boundary.」

   → **别指望 profile 帮你隔离仓库**。要限定工具起始目录，**必须显式写绝对路径** `terminal.cwd`。
   → 对 M5「多仓库」是硬提醒：隔离得靠别的手段。
2. **`cwd: "."` 在 local backend 下 = 「Hermes 的启动目录」，不是 profile 目录** —— 经典误读点。
   官方示例：`terminal: {backend: local, cwd: /absolute/path/to/project}`。
3. **`hermes update` 会同步新 bundled skills 到所有 profile** → **= 漂移源 2**。
   升级后**必须**跑一次 `drift` + `verify`。

---

## 7. 功能清单：环境形态**没有 `src/`**

环境形态的功能散落在**五个地方**，**没有任何一条命令能一眼看全**：

`config.yaml` 键 · `skills/` · `hooks/` · **MCP 工具面** · `cron` 任务

→ **必须手工维护一张表**：

| 功能 | 载体（五选一） | 验证方式（用哪条命令） |
|---|---|---|
| 例：`dev_start` | MCP 工具面（pr-agent） | `hermes mcp test pr-agent` + `npm test` |
| 例：`/dev` 路由 | skill（`skills/dev-route/SKILL.md`） | 临时 profile 演练 |
| 例：回调 → 工具 | gateway hook | 真实卡片点击 |
| 例：每日巡检 | `cron` job | `hermes cron run <id>` |

**这张表就是环境形态的 `src/` 目录树。** 不维护它，三个月后没人知道环境里有什么。

---

## 8. 待拍板

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| 1 | **环境仓库放哪** | 🆕 `D:\code\hermes-env` ／ 并入 pr-agent 仓库 ／ 其他 | 决定「功能定义」与「MCP server 代码」是否同仓 |
| 2 | **软链粒度** | 整个 `~/.hermes/` ／ **只软链子目录**（`skills`/`hooks`/`config.yaml`） | 粒度粗 → `.gitignore` 成为唯一防线（§2） |
| 3 | **演练频率** | 每次改动都跑 ／ **只跨链路改动跑**（§3 分级） | 分钟级成本 vs 漏检风险 |

> 📌 前两条（环境仓库放哪 / 软链粒度）**与 `docs/Hermes迁移实施方案.md` §6 是同一组决策**，
> 那里给了带拓扑前提的建议值。**要看落地路线（里程碑 M9–M14）直接看那份文档。**

---

## 附：证据来源与置信

| 结论 | 来源 | 置信 |
|---|---|---|
| Profile = 独立 home 目录，含 `config.yaml`/`.env`/`SOUL.md`/memories/sessions/skills/cron/**state db** | 官方 `user-guide/profiles`（zh-Hans） | **高（官方直读）** |
| `hermes profile create X --clone[-all]`、`--clone-from`、profile 自动生成命令别名 | 同上 | **高（官方直读）** |
| `hermes profile export NAME` → tar（可 import） | 同上 | **高（官方直读）** |
| **Profile 不做沙箱**；`SOUL.md` 只引导不强制；`cwd: "."` = 启动目录 | 同上（原文引用） | **高（官方直读）** |
| `hermes update` 拉代码一次 + 同步新 bundled skills 到所有 profile | 同上 | **高（官方直读）** |
| `hermes doctor [--fix]` / `hermes config check` / `--safe-mode` / `mcp test` / `dashboard` 等命令面 | 三处转载一致（lobehub ×2、huggingface），形似官方 `reference/cli-commands` | **中高 —— 未经官方页直读，建议 `hermes --help` 当场核实** |
| `HERMES_HOME` 及 `hooks`/`skills`/`sessions`/`logs` 子目录可软链 | 官方 `getting-started/installation`「Symlinked home directories」节 | 高（官方） |
| sessions 存于 `~/.hermes/state.db`（SQLite + FTS5） | 二手（社区参考文章） | 中 |
| Kanban 存于 `~/.hermes/kanban.db` | 官方 kanban 文档 | 高（官方） |
