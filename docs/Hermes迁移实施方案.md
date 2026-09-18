# Hermes 迁移实施方案（拓扑 · 三问答复 · 里程碑）

> **触发**：2026-09-17 用户告知「远程服务器上已部署 Hermes，`ssh tencent` 可登录」，并提出三问：
> ① 要不要一个项目维护 Hermes 上的自定义功能 ② 要不要配 GitHub token ③ 迁移里程碑怎么定义 + 怎么让用户用口语触发。
>
> **前置文档**（不重复）：
> - `Hermes迁移评估.md` —— **搬不搬**（13 项逐条判定 / 判据口径 / 待拍板）
> - `Hermes环境维护模型.md` —— **环境形态怎么维护**（漂移 / 整装演练 / 变更回路 / §4.1 四个插槽）
>
> 本文只回答**怎么落地**：拓扑 → 三问 → 里程碑。

---

## 0. 一句话

**Hermes 已在远程服务器上 → 这个事实决定了「pr-agent 也要上服务器」，以及对另外两问的答案。**
三问的答复：① **要**（且不是"项目"是"环境仓库"）② **要，但只给 pr-agent 一份，Hermes 不需要** ③ **不做意图识别器，做工具面 + 三级准入 + 显式「当前」指针**。

📌 **关于「能不能把 pr-agent 完全消解成 skills」—— 见 §1.6。一句话**：
**判据那层不能变成文档（执行主体不同），但"pr-agent 必须是个应用"是我上一轮的跳步推论。**
**建议「先迁移、后瘦身」**（同时改运行位置与架构形态 → 出问题无法归因）。

---

## 1. 先定拓扑：pr-agent 放哪

**这是一个前置决定 —— 它影响后面全部**，所以在回答三问之前必须先钉死。

### 1.1 三个方案

| 方案 | 拓扑 | 代价 | 判定 |
|---|---|---|---|
| **A · 同上服务器** | Hermes 与 pr-agent 都跑在 tencent 那台，MCP 走 `http://127.0.0.1:8001/mcp` | 服务器侧要补一条 **LLM 端点**（见 §1.3）；`repos.registry.json` 的 `localPath` 要改 | ✅ **推荐** |
| **B · 反向隧道** | pr-agent 留本机，`ssh -R 8001:localhost:8001 tencent` | **笔记本必须常亮 + 隧道常在线**；断了 Hermes 就调不到工具 | 🟡 只当过渡 |
| **C · 公网暴露** | pr-agent 留本机，打洞 + TLS + 认证暴露到公网 | 要自己解决公网入口、证书、鉴权、DDoS 面 | ❌ 不值得 |

### 1.2 为什么推荐 A —— 第一性理由，不是"省事"

**飞书入口的全部价值是「人不在电脑前也能指挥」。** B 要求笔记本常亮常在线 —— 那正好把这唯一的价值抵消掉：
你在外面用手机发「新增一个需求」，笔记本合盖了，链路就断。**B 不是"缩水版 A"，是把要解决的问题删掉了。**

第二性理由：dev-workflow 是**分钟级**任务（clone → 改 → 跑测试 → 开 PR），它需要一个**常驻且不睡觉**的执行环境。服务器本来就是干这个的。

### 1.3 A 的**唯一真障碍**：pr-agent 有**两条** LLM 链，别混

这是本次评估里最容易被忽略、也最容易踩的一点：

| 链 | 谁在用 | 凭据从哪来 | 搬服务器 |
|---|---|---|---|
| **① 程序侧（Mastra agent）** | `requirementMet` 判定等 | **纯 env**：`LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（`llm/providers.ts:135-143`） | 🟢 **零障碍** —— env 搬到哪都好使 |
| **② 编码侧（Claude Agent SDK）** | `coding-agent.ts` 真正改代码 | **`claude` CLI 自己解析**：`~/.claude/settings.json` 的 env 块 → 本机是 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`（**cc-switch 代理**） | 🔴 **这就是障碍** |

`coding-agent.ts:79-86` 的注释已经写明这条链路，且 `:126-127` 写明「官方 `@mastra/claude` 示例根本不传 key —— 因为凭据该由 CLI 自己解析」。

**cc-switch 是 Windows 桌面程序**（`cc-switch.exe`），Linux 服务器上没有它。三个出路：

| 出路 | 做法 | 代价 |
|---|---|---|
| **① 直连上游** | 服务器上装 `claude` CLI，`~/.claude/settings.json` 里把 `ANTHROPIC_BASE_URL` 指向**真实上游**（跳过 cc-switch），配真 key | 最小；但**多一台机器持有 key** |
| **② 服务器侧跑 Linux 代理** | 用可在 Linux 跑的同类代理（如 claude-code-router）复现 cc-switch 的角色 | 多一个组件要维护 |
| **③ 服务器上独立登录** | `claude` 用自己的订阅登录 | 干净，但与现有链路是两套账 |

⚠️ **不做这件事的后果不是"报错"，是"看起来在跑但模型不对"** —— 与本项目 `providers.ts:214-222` 记录过的「模型名幻觉」同型：请求成功、回的却是别的模型。**验收时必须打印一次实际生效的端点与模型。**

### 1.4 好消息：代码零改动，要改的只有**两个文件**

已逐条 grep 核实，pr-agent 本来就是跨平台写的：

| 地方 | 现状 | 结论 |
|---|---|---|
| `test-runner.ts:287` | `detached: process.platform !== 'win32'` | 已有 POSIX 分支 |
| `test-runner.ts:347-354` | Windows 走 `taskkill /T`，POSIX 走进程组信号 | 已有 POSIX 分支 |
| `github.ts:75-79` | 路径比较按平台决定是否忽略大小写 | 已处理 |
| `repo-registry.ts:85` | 接受 Windows 盘符 | 已处理 |
| `log-store.ts:37` | 文件名不含 `:`（Windows 保留字符） | 比 Linux 更严，无碍 |

**迁移 = 改这两份配置，不动代码**：

| 文件 | 改什么 | 为什么是这个文件 |
|---|---|---|
| **`repos.registry.json`** | `localPath` 改成服务器上的路径 | 它**本来就被 gitignore**（`repos.registry.example.json` 才是入库模板） |
| **`.env`** | LLM 四项 + `GITHUB_TOKEN` + 飞书三项 | 已被 gitignore |

🔑 **这里有一个 M5 埋下的、现在才显形的红利**：`repo-registry.ts:10` 把 `localPath` 定性为「**本机事实，绝不进 `ContextSchema`**」，理由是「`ContextSchema` 会被序列化进 `mastra.db` 的 snapshot，跨进程 resume 靠快照恢复 —— 写绝对路径，换台机器 resume 就指向不存在的目录」。

**所以「换一台机器」在本项目里被设计成「换一份 gitignored 的配置文件」。** 迁移没有触发任何"本机绑定"的隐雷 —— 这不是运气，是 M5 那条约束的直接兑现。

### 1.5 拓扑不决定的两件小事（顺手记）

- **`mastra.db`**（LibSQL 单文件）可整体拷过去；已在飞的 run 不跟着走，**迁移窗口期不要有 running run**。
- Windows 上那个「`git commit` 成功但 ref 未落盘」的先例是**本工作区的 git 行为**，不是 pr-agent 运行时代码的问题；Linux 上不复现。

### 1.6 追问：能不能把 pr-agent 完全消解成 skills？

**触发**：用户 2026-09-17 追问「为什么还需要 pr-agent，我们不是可以把当前项目抽象成对应的 skills 给 Hermes 的吗，
无法完全剥离 pr-agent 吗，只使用一个代码编辑功能而把整个项目同步过去是不是不合适」。

**结论两句话**：
1. **判据那一层不能变成 skill** —— 这不是"复杂不复杂"的问题，是**执行主体**的问题。
2. **但「pr-agent 必须是一个常驻应用」是我上一轮跳步加的推论，没论证。** 下面给第三种形态。

#### (1) 先拆一个隐含前提：skill 不是"更轻的代码"，是**另一种执行主体**

- **Skill = 给 LLM 看的文档，执行者是 LLM。**
- pr-agent 的核心输出**不是文档，是执行事实**：`testsPassed` = 「那个测试进程**真的跑过**、exit code 0」。

判据只有一条：

> 把这段逻辑写成 Markdown 之后，**LLM 有没有可能在"读懂"的情况下给出错误结论**？
> **能 → 它就不能是 skill。**

`testsPassed` 恰好是最典型的"能"：**LLM 自己写了 diff，再让它读自己的测试输出判"过了没" —— 它既有动机也有能力误读。**
M4 的全部工作，就是把这个判断**从 LLM 手里拿走**。把它变回 skill = 把 M3→M4 那次演进原路退回。

#### (2) 但你的直觉对了一半 —— 我上一轮的推论**跳步了**（自查更正）

刚查了实际代码，三条硬事实：

| 事实 | 反查点 | 含义 |
|---|---|---|
| **`runGate` 已经导出**，`TestGateSchema` / `LlmTestGateSchema` 也是 | `test/mastra/dev-gate-contract.test.ts:12` **直接 import 这三个** | 判据**已经是纯函数**，没缠在编排里 |
| `passed` 的合成是**一行纯表达式** | `dev-workflow.ts:92` 与 `:137`：`(testsPassed !== false) && requirementMet` | 剥出来是**移动文件**，不是重写 |
| 单测绝大多数是**纯逻辑模块**的测试 | 见附「单测分布」 | 换壳后**大部分原样保留** |

**「判据需要独立进程」这个理由成立；「所以必须是一个常驻 MCP server 应用」是我加上的，没有论证。**
**独立进程 ≠ 必须是应用。**

#### (3) 第三条路：(C) pr-agent 从「应用」降级为「一组确定性函数 + 一个薄 MCP 壳」

| | **(A) 常驻服务**（我上一轮） | **(C) 薄壳 + 纯函数** | (B) 全变 skill |
|---|---|---|---|
| pr-agent 形态 | Mastra 应用 + MCP server，8001 常驻 | **无 Mastra（无编排）**：判据函数 + 安全执行 + 薄包装 | 无 |
| 编排（步骤顺序 / 重试 / 暂停） | Mastra workflow | **交给 Hermes Kanban** | Hermes Kanban |
| 判据 | `runGate` | **`runGate`（同一个函数）** | ❌ 无 |
| 单测 | 291 | **大部分保留** | ❌ 全丢 |
| 三级闸门 | ✅ | ✅（仍是 MCP 工具） | ❌ |

⚠️ **(C) 的关键代价**：`readOnlyHint` / `trust: untrusted` / `elicitation` 这套闸门**只对 MCP 工具生效**。
一旦退化成"让 LLM 用 `terminal` 跑命令"，闸门全没 —— 而 Hermes 的 `approvals` 是**命令字符串维度**
（`Hermes迁移评估.md` §8.4 已论证它**不等价**）。

#### (4) 但我**不建议现在就选 (C)** —— 三条实测理由

| # | 理由 | 具体 |
|---|---|---|
| 1 | **端到端证据会失效** | `scripts/verify-pr-loop.js` / `verify-m4-gate.js` / `verify-m5-multirepo.js` / `verify-m6-observability.js` **全是驱动 workflow 的**。M1–M6 的验收正是靠它们 —— 删编排 = **M1–M6 的验收资产一起作废** |
| 2 | **Kanban 替代不了"这件事内部的步骤编排"** | Kanban 的粒度是 **task**，workflow 的粒度是 **step**。`dev-gate-contract` 里有一条契约正是「**重试回灌上次错误**」（AC-9 / P0-2）—— 那是 **step 内部**的语义，Kanban 不提供 |
| 3 | **一次只改一个变量** | M9–M14 已经在改「运行位置」。同时改「架构形态」→ **出问题无法归因**（是搬挂了，还是拆挂了？） |

#### (5) 「同步整个项目过去」的成本，和你以为的不一样

| | 成本 |
|---|---|
| **搬过去** | 改 **2 个 gitignored 文件**（`repos.registry.json` + `.env`），**代码零改动**（已逐条 grep，§1.4） |
| **抽象成 skills** | 每个 skill 都是**一份没有测试的文档**。它**不会告诉你「我这次理解错了」** |

而且关键一点：**这里没有"同步一份副本"** —— pr-agent 只是**换台机器跑**，Hermes **没有替代它任何东西**。

#### (6) 可推翻条件：「什么时候真的可以删 pr-agent」

> 当「**这个结论是谁得出的、可信度多少**」不再重要，**只要结果**的时候。

反过来说 —— 这是本节的**核心一句**：

> **"删掉 pr-agent"最终会变成"在 Hermes 里重写一遍 pr-agent 里的那些程序" —— 那是同一个东西，只是少了 291 个测试。**
> **你无法删掉「程序被判据需要」这件事，只能选这段程序住在哪个壳里。**

📌 **建议时序：先迁移（M9–M14）、后瘦身。**
等 Kanban 的编排能力被**真实使用**验证过，再用**实测证据**而不是推测，决定要不要删 Mastra。
→ 已作为 §6 第 9 条待拍板。

---

## 2. Q1 · 要不要一个项目维护 Hermes 的自定义功能

### 2.1 要 —— 而且是**现在比之前更必要**

之前 Hermes 在哪儿还没定，这条是"建议"；现在它在你**远程服务器的 `~/.hermes/`** 里，这条变成"必须"：

> 服务器上的 `~/.hermes/` 是一个**你 ssh 进去手改的活目录**。不落 git = **不可回滚 + 不可复现 + 三个月后没人知道里面有什么**。

这不是洁癖，是本项目已经吃过的教训的同型——**「文档幻觉」的反面**：环境里存在的东西，如果没有一条命令能枚举它，它就会在记忆里消失。

### 2.2 但它不是"新项目"，是一份**环境仓库**

| | 内容 |
|---|---|
| **进 git（功能定义）** | `config.yaml`（含 `mcp_servers`）· `skills/` · `hooks/` · `SOUL.md` 或 `AGENTS.md` · profiles 与 cron 的**声明** · `deploy.sh` · `verify.sh` |
| **不进 git（运行时状态）** | `state.db`（sessions）· `kanban.db` · `logs/` · `.env` · `memories/` |

⚠️ **这条边界是环境形态唯一真正危险的地方**：`~/.hermes/` 把「功能定义」和「运行时状态」放在**同一个目录**里，
而项目形态的 `src/` 与 `node_modules/`、`dist/` 是天然分开的（详见 `Hermes环境维护模型.md` §2）。

### 2.3 部署回路（服务器是运行时，仓库是定义）

```
本机/D:\code\hermes-env  ──git push──▶  GitHub（私有）
                                            │
                                    ssh tencent
                                            ▼
                              /opt/hermes-env  ──git pull──▶ 软链 ──▶ ~/.hermes/{skills,hooks,config.yaml}
                                            │
                                            ▼
                                   deploy.sh：reload / restart
```

**核心理由**：`~/.hermes/` **不做** git 工作副本，只做**软链的宿主**。这样 `cd /opt/hermes-env && git status` 就是**漂移检测**——
手工 `config set` 忘了写回、`hermes update` 同步了新 bundled skills、agent 自己在 session 里改了配置，**三种漂移都会被 `git status` 照出来**。

（官方依据：`HERMES_HOME` 及 `hooks` / `skills` / `sessions` / `logs` 子目录支持软链 —— 见 `Hermes环境维护模型.md` 附录。）

### 2.4 ⚠️ 更正我之前的说法：**多数改动不需要重启 gateway**

`Hermes环境维护模型.md` §4 写的是「`apply` → `hermes gateway restart`」。**这偏重了**，官方现成机制是按改动面分的：

| 改了什么 | 正确做法 |
|---|---|
| **MCP 配置**（`mcp_servers` 增删改、换凭据） | **`/reload-mcp`**（聊天会话内）—— 官方明写「no restart needed」 |
| **Skill** | session 内 **`/reset`** 重新加载 |
| `config.yaml` 其他键 / hook 代码 | 重启 gateway（最后手段） |

**结论：默认走 `/reload-mcp` + `/reset`，重启是例外。** 这与「整装演练很贵，按改动面分级」是同一条思路的延续。

---

## 3. Q2 · 要不要配 GitHub token

### 3.1 要，但**只需要一份，给 pr-agent；Hermes 侧不需要**

前提是你接受这个分工：**GitHub 操作留在 pr-agent，不放给 Hermes**。理由三条，逐条可反查：

1. **保证等级不同。** pr-agent 的 `adapters/github.ts` 是**手写 REST 集成**，有 **15 个单测覆盖失败分支**；Hermes 的 `github-pr-workflow` skill 是**驱动 `gh` CLI 的 prompt**，失败分支**没有等价物**。
2. **token 只在一处** → 作用域好收敛、好轮换、好审计。
3. **pr-agent 不依赖 `gh` CLI**（`.env.example:72` 明写「**全部走 GitHub REST API + 本地 git，不依赖 `gh` CLI**（K5 决策）」）→ 服务器上**不用装 `gh`**。

好消息：**PAT 不随机器变化**（不是 SSH key），所以迁移本身**不需要重新签发** —— 只是把它从本机 `.env` 复制到服务器 `.env`。

### 3.2 服务器上的密钥放哪（新增的一条）

| 做法 | 评价 |
|---|---|
| `/opt/pr-agent/.env` + `chmod 600` | ✅ 简单，与现有 `.env` 加载方式（`dotenv`）一致，**改一行都不用** |
| systemd `EnvironmentFile=` | ✅ 更规范，但要改启动方式 |
| 写进 git / 写进 `config.yaml` | ❌ 绝对不行 |

⚠️ **顺带一个易踩点**：若将来给 Hermes 加 **stdio** 型 MCP server，官方明写「stdio MCP servers run as subprocesses with a **filtered environment** — only `PATH`, `HOME`, `LANG` … are passed through by default，**Credentials must be specified explicitly in the server's `env` block**」。

这与 pr-agent 自己对子进程做 env 剥离（`/TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY$|AUTH/i`）是**同一个安全直觉**，两处都别忘。
（本条也是「MCP 走 HTTP 而非 stdio」的又一理由 —— 见 §5 M12。）

### 3.3 什么时候会变成"两套凭据"

如果你日后想让 Hermes 也能直接碰 GitHub（比如它自己去读 issue、自己开 PR），**就会多出第二套凭据**（Hermes 的 `github` MCP preset 用 `GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}`，值是另配的）。

**那时的真风险不是"多一个 token"，是两套 token 的作用域不一致** —— 会出现「pr-agent 能合并 PR、Hermes 读不到 issue」这类**症状与根因隔一层**的怪事。
**规则：真要加，就加同一个 PAT，不要另签发一个。**

---

## 4. Q3 · 意图识别与口语触发（本次的核心）

用户要求原话：

> 「怎么快速处理和识别用户的意图是想修改代码而不是普通的对话」
> 「Hermes 是自己维护了上下文和记忆的，所以我希望用户能使用尽量简单的描述触发功能，
> 比如【我要看下当前需求】/【合并当前分支】/【我要新增xxx需求】」

### 4.1 结论：**不做"识别器"**，做「工具面 + 触发条件描述」

意图识别本来就是 LLM 的职责 —— **我们不该写分类器，也不该写关键字路由器**。
我们要做的是**把每个能力暴露成一个工具，把触发条件写进工具的 `description`**，然后让 Hermes 的 LLM 去决定调哪个。

这与本项目 M4 那条铁律**同源**：

> `testsPassed` 🟢程序 · `requirementMet` 🔵LLM · `passed` 🟢程序合成
> —— **不是替换 LLM，是分工**。

**语义理解给 LLM，动作准入绝不能给 LLM。** 下面 4.2 就是这个分界线的落点。

### 4.2 高危动作的**三级闸门** —— 全部是官方现成机制，不自己造

一手来源：`hermes-agent.nousresearch.com/docs/reference/mcp-config-reference`（官方）。

| 级 | 性质 | 机制 | 例 |
|---|---|---|---|
| **① 免批准** | 只读 | 工具带 MCP 标准注解 **`readOnlyHint: true`** → 「any tool without a `readOnlyHint: true` annotation」才需要批准 | `run_status` / `run_cost` / `repo_list` |
| **② 程序决定要不要问** | 有代价、可逆 | 服务端 **`elicitation`**（server-initiated user-input）；官方原文「**Form-mode requests route through the approval surface**」 | `dev_start`（起一次开发 run） |
| **③ 必须人工点头** | **不可逆** | server 标 **`trust: untrusted`** → 写工具"**every write-capable tool call … requires user approval through the standard approval surface**" | `dev_decide(merge)` |

**为什么这三级是对的（而不是"权限先不考虑"）：**

1. `readOnlyHint` 是 **MCP 标准注解**，不是 Hermes 私有 hack → **pr-agent 的工具面同时也能被 Claude Code / Cursor / WorkBuddy 驱动**，不绑死 Hermes。
2. `trust: untrusted` 官方明写是 **fail-closed**：「Unrecognized values are treated as untrusted」。
3. `elicitation` 的「要不要问人」这个判断**由服务端程序做**，不是由 Hermes 的 LLM 做 —— **这正是「判据归属」要求的那种确定性**。

> 📌 一句话：**LLM 只能决定"调用哪个工具"，不能决定"这个动作要不要放行"。**

### 4.3 「当前」指针 —— **本次最大的真风险**

用户举的三个例子，有两个含**相对指代**：「我要看下**当前**需求」「合并**当前**分支」。

**这是本次设计里唯一会出事的地方** —— 因为"当前"没有定义时，LLM 会**猜**，而猜错 = 合错分支。

**规则（写死，不给 LLM 自由裁量）：**

| 维度 | 规则 |
|---|---|
| **作用域** | **飞书群（`chat_id`）**，不是"某个人"，也不是全局（群内任何人说"当前"，指的是同一个） |
| **定义** | 该群**最近一次 `dev_start` 成功**的 run |
| **失效** | 超过 **T（建议 2 小时）** 或该 run 已到终态 → 「当前」**为空** |
| **多义** | 该群有 **≥2 个未结 run** → **反问，不猜**："你指的是 A（…）还是 B（…）？" |
| **反查** | 任何时候不带参数的 `run_status` 都把「当前」**打印出来** → 断言可反查 |

⚠️ **一条硬禁令：不允许 LLM 从对话记忆里"回忆"出当前是哪个 run。**
理由不是洁癖 —— 是**不可反查**。这违反本项目已经立过的规矩：

> 「凡『已同步 / 已改为』的断言，必须能配一条命令当场反查。**写不进一条反查命令的『已完成』，不算完成。**」

**「当前是哪个 run」如果只存在于 LLM 的记忆里，就没有任何一条命令能证明它是对的还是错的。** 所以它必须由 pr-agent 侧按上表**程序化解析**，解析不出就返回"需要澄清"。

🔑 **这里正好用上 M6 的投资**：M6 把 `runId` 做成了全局唯一键（新格式事件覆盖率实测 57/57，起点 0/701）——
「定位一个 run」这件事在 M6 之后才**可信**。这也是当初把 M6 排在飞书双向控制之前的那条论证，现在同样成立。
📌 而且「当前指针」**是净新增**，M6 没覆盖：M6 有 runId ↔ 日志，但没有 `chat_id` ↔ runId。

### 4.4 口令表：从"路由器"**降级为"验收用例集"**

你之前提的「先定义一些关键字模板」——**方向对，但位置要挪**。它不该当路由器（那是 LLM 的活），它应该是**回归样例集**：

每个能力配**三类**样例：

| 类型 | 例（对应 `dev_start`） | 期望 |
|---|---|---|
| ✅ 正例 | 「我要新增一个需求：给 market-api 加个限流」 | 调 `dev_start` |
| ⛔ 近似但**不该**触发 | 「我看到有人新增了个需求」（**陈述**，不是指令） | **不调** |
| ❓ 歧义 | 「合并一下」 | **反问**，不猜 |

**为什么这样就有价值了**：它把"口语能不能用"变成了**可回归的问题** —— 而这正是你在 M4 里建立的那套思维方式（LLM 判据必须有确定性配套）。

⚠️ **但要说清这层的验证等级**：LLM 的意图识别**无法像 291 个单测那样全自动判定**。
可行的最客观做法是**不看好文本、看事件日志最终调了哪个工具**（Hermes 侧有 session/审计，pr-agent 侧有 M6 的 runId 日志），
比"读回复像不像"客观得多。**这层的验收是"样例集 + 人工过一遍"，不是"全绿才算过"** —— 诚实标注，别假装能自动化。

### 4.5 用户原话 → 落到哪个工具（对照表）

| 用户说的话 | 意图 | 落到 | 闸门 |
|---|---|---|---|
| 「我要看下当前需求」 | 查状态 | `run_status`（无参 → 程序解析"当前"） | ① 免批准 |
| 「合并当前分支」 | 合入 | `dev_decide(runId, action='merge')` | ③ **人工点头** |
| 「我要新增 xxx 需求」 | 起流程 | `dev_start` | ② 程序决定是否 elicitation |
| 「现在花了多少钱」 | 查成本 | `run_cost` | ① 免批准 |
| 「有哪些仓库能改」 | 查白名单 | `repo_list` | ① 免批准 |
| 「Hermes 是什么」 | 闲聊 | **不调工具** | — |

**这张表就是 §4.4 那个样例集的种子。**

### 4.6 一条"没被问到但会咬人"的约束

MCP 是**请求/响应**模型：`dev_start` 必须**立即返回**（工作流跑几分钟会超时；`timeout` 默认 120–300s，两处官方页不一致）。

→ **所有工具恒为「起跑 + 查询」两段式**，不存在"阻塞到跑完"的工具。
→ 这也决定了飞书侧的话术：**发一句"已开跑，runId=xxx"，完成后另发消息（或走 Kanban 状态）** —— 不是等在那。

---

## 5. 迁移里程碑 M9–M14

**命名说明**：M7 / M8 两张飞的卡**被本方案替代**（M7「飞书对话入口」= Hermes 提供；M8「飞书双向控制」拆进 M12/M13）。
新序列从 **M9** 起，**不复用 M7/M8 编号**（避免与已写入 M6 卡与 README 的旧引用撞车）。
⚠️ **卡尚未改写**，本表是待拍板草案。

| 卡 | 名字 | 依赖 | 一句话 | 关键判据 |
|---|---|---|---|---|
| **M9** | **环境即代码** | — | `hermes-env` 仓库 + 软链 + `deploy.sh` + 漂移检查。**先让环境可回滚，再动它** | 仓库里改一个 skill → 一条命令上到服务器 → `/reset` 生效；`git status` 能照出漂移 |
| **M10** | **飞书接线** | M9 | `hermes gateway setup` 接飞书（复用现有自建应用）；**同时退役 pr-agent 的轮询入口** | 真群发一句话有回复；**同一条消息不会有两个机器人回**；pr-agent 的 `/insights/feishu-poll` 已停 |
| **M11** | **pr-agent 上服务器** | M9 | Node + `claude` CLI + **LLM 端点（§1.3）** + systemd + `.env` + 服务器版 `repos.registry.json` | 在服务器上**完整跑通一次 dev-workflow** 到开 PR；并**打印实际生效的端点与模型** |
| **M12** | **只读工具面（MCP）** | M10+M11 | 只上只读四工具：`repo_list` / `run_status` / `run_cost` /（后补 `insight_run`）。**先建立端到端链路，零破坏风险** | 真群说「我要看下当前需求」→ 返回**真** run 状态；`/reload-mcp` 可见；Hermes 侧零代码 |
| **M13** | **写工具 + 三级准入** | M12 | `dev_start` / `dev_decide` + `readOnlyHint` 分级 + `trust: untrusted` + `elicitation`；卡片 V1→V2（回调） | **未批准绝不执行；点一次执行一次**；「真群点得动」 |
| **M14** | **口语口令与「当前」指针** | M13 | §4.4 样例集 + §4.3 当前指针规则 + **歧义必须反问** | 歧义输入**必须反问，不得猜**；样例集正例全中、反例全不中 |
| **M15** | 定时巡检（**可延后**） | M10 | cron：每日体检 / 成本日报 —— **Hermes 独有，pr-agent 完全没有** | 到点自动发；失败有告警 |

### 排序依据（每条都是"谁阻塞谁"）

| 顺序约束 | 为什么 |
|---|---|
| **M9 必须最先** | 不先把环境纳入 git，后面所有改动都是"ssh 上去手改" → **不可回滚、不可复现** |
| **M10 先于 M12** | 没有飞书入口，MCP 工具面**无法验收**（只能说"配置对了"，不能说"用户真的能触发"） |
| **M11 必须先于 M12**（若选拓扑 A） | MCP 工具面要有 pr-agent **在服务器上活着**才有得连 |
| **M12 只读、M13 才写** | **只读 = 零破坏风险** → 可以在真群小范围试用、可以开放给真实用户，而不用担心误触发合代码。**这是"先打通链路"和"先能干活"之间的正确取舍** |
| **M14 最后** | 口语触发的前提是**工具已经稳定** —— 工具面没定就调 prompt，等于给不存在的功能写话术 |

⚠️ **一条继承自 M6 的提醒**：M12/M13 的工具入参与出参**都要带 `runId`**。这不是顺带 —— **runId 是迁移后唯一的跨系统定位键**
（Hermes 的 Kanban 用自己 task id，与 pr-agent 的 runId 不是一回事，缺映射这条链就断）。**M6 全价值建立在这上面。**

---

## 6. 待拍板

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| **1** | **拓扑** | **A 同上服务器（推荐）** / B 反向隧道 / C 公网 | 决定后面全部；B 会把飞书入口的价值抵消 |
| **2** | **服务器侧的 LLM 端点（§1.3）** | 直连上游 + 真 key / Linux 侧代理 / 服务器独立登录 | **M11 的唯一真障碍**；选错的表现是"看着在跑但模型不对" |
| **3** | **环境仓库放哪** | 🆕 `D:\code\hermes-env`（推荐）/ 并入 pr-agent / 其他 | 决定「功能定义」与「MCP server 代码」是否同仓 |
| **4** | **软链粒度** | 整个 `~/.hermes/` / **只软链子目录**（推荐） | 粒度粗 → `.gitignore` 成为唯一防线 |
| **5** | **`dev_start` 要不要人工点头** | 只 elicitation（②级，推荐）/ 也算不可逆（③级） | 决定日常口语触发的摩擦 |
| **6** | **`dev_decide` 的确认面** | 飞书**卡片按钮** / 聊天里点一下 | 决定 M13 是否要背 V1→V2 卡片重写的活 |
| **7** | **「当前」的超时 T** | 30min / **2h（建议）** / 不超时 | 越长越可能合错；越短越常被反问 |
| **8** | **M12 的 MCP 实现** | `@mastra/mcp`（更贴合现有栈，**未验证**）/ 官方 `@modelcontextprotocol/sdk` + 现有 8001 Koa 挂 `/mcp` | 这是 M12 开头的一个 spike，**两个都未核实**，别当成已知 |
| **9** | **pr-agent 保留成什么形态**（§1.6） | **A 应用原样迁（推荐）** / **C 拆掉 Mastra 编排，只留判据函数 + 安全执行 + 薄 MCP 壳** / B 全变 skill | 决定是否**销毁 M1–M6 的端到端验收资产**（`verify-*.js` 全是驱动 workflow 的）；**建议先迁移后瘦身**——同时改位置与形态会导致**无法归因** |

📌 另有 3 条属「环境维护模型」的待拍板（`Hermes环境维护模型.md` §8）+ 6 条属「搬不搬」的（`Hermes迁移评估.md` §9），本文不重复。

---

## 附：证据来源与置信

| 结论 | 来源 | 置信 |
|---|---|---|
| MCP 支持 **HTTP（Streamable HTTP，可切 `sse`）** + `headers` + OAuth | 官方 `reference/mcp-config-reference` + `user-guide/features/mcp` | **高（官方直读）** |
| `trust: full/untrusted`，untrusted 时写工具需批准，**fail-closed** | 同上，原文引用 | **高（官方直读）** |
| `readOnlyHint: true` 的只读工具可跳过批准 | 同上 | **高（官方直读）** |
| `elicitation` 存在；Form-mode 走 approval surface，URL-mode 被拒 | 同上 | **高（官方直读）** |
| `/reload-mcp` 改 MCP 不需重启 | 官方 `user-guide/features/mcp` + `mintlify` 镜像页一致 | **高** |
| `hermes mcp test / list / add --preset` | 官方 `mcp-config-reference`（`add --preset`）+ 多页一致 | **高** |
| **stdio** MCP 子进程 env 只继承 `PATH`/`HOME`/`LANG`，凭据须显式写 | 官方 `mintlify` 镜像 `user-guide/features/mcp` | **中高（镜像页，非主站）** |
| `timeout` 默认值 **120 还是 300** —— 两处官方页**不一致** | `reference/mcp-config-reference` 写 300；`user-guide/features/mcp` 写 120 | ⚠️ **冲突未决** → 装完以实际 config 参考为准 |
| Hermes = 远程服务器已部署（`ssh tencent`） | **用户告知** | 高 |
| pr-agent 两条 LLM 链的分工与凭据来源 | 本仓库 `llm/providers.ts` / `coding-agent.ts:79-86,126-127` / `.env.example` | **高（本地代码直读）** |
| `localPath` 是本机事实、不进 `ContextSchema`、注册表被 gitignore | 本仓库 `repo-registry.ts:10,40,135-142` + `M5-多仓库与幂等.md:359` | **高（本地代码直读）** |
| `github.ts` 15 个单测、不依赖 `gh` CLI | 本仓库 `.env.example:72` | 高 |
| cc-switch 是 Windows 桌面程序、监听 `127.0.0.1:15721` | 用户长期记忆（已实测） | 高 |
| `runGate` / `TestGateSchema` / `LlmTestGateSchema` 已导出且被契约单测直接 import | `test/mastra/dev-gate-contract.test.ts:12` | **高（本地代码直读）** |
| `passed = (testsPassed !== false) && requirementMet` | `dev-workflow.ts:92` / `:137` | **高（本地代码直读）** |
| 端到端验证脚本（`verify-pr-loop` / `verify-m4-gate` / `verify-m5-multirepo` / `verify-m6-observability` 等）**均为驱动 workflow** | `scripts/` 目录 19 个脚本 | 高 |

### 附 · 单测分布（用于 §1.6「换壳后有多少能保留」的判断）

按 `it(` 声明数统计，共 **213 条声明**（jest 实测通过 **291** 例，差额来自 `it.each` 等参数化展开）。
**按是否依赖 Mastra 运行时分类：**

| 类别 | 文件（声明数） | 小计 | 换壳后 |
|---|---|---|---|
| **纯逻辑模块**（换壳可原样保留） | `repo-registry` 33 · `guard` 26 · `llm-providers` 20 · `log-store` 19 · `test-runner` 18 · `progress` 17 · `entry-idempotency` 16 · `github-adapter` 15 · `repo-lock` 13 · `state-db` 12 · `dev-gate-contract` 10 · `m5-target-contract` 7 · `storage` 2 | **208** | ✅ **保留** |
| **依赖 Mastra 运行时**（hook 挂载点 / HTTP 控制器） | `guard-hook` 3 · `controller/api` 1 · `controller/home` 1 | **5** | ❌ 随壳消失 |

📌 **这是 §1.6 结论的量化依据**：**213 条里只有 5 条绑在 Mastra 上。**
→ 「pr-agent 是个应用」这个形态**几乎不承担单测覆盖**，它承担的是**编排**。
→ 而编排的价值证据在 **`scripts/verify-*.js`**（驱动 workflow 的端到端脚本），**不在 jest 里** —— 这才是删 Mastra 真正会作废的东西。
