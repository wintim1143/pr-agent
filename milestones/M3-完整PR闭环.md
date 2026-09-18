# M3 · 完整 PR 闭环（Full PR Loop）

状态：**✅ 已完成（2026-09-15）**——八项任务 M3-1~M3-8 全过；AC-1~AC-6 / AC-8 / AC-9 实测通过，**AC-7 需人工去飞书群确认**。遗留项已移交 M4（见 §11 末尾）
创建日期：2026-09-15（完成日期：2026-09-15）
**D4 目标仓库：`wintim1143/pr-agent-e2e`**（用户 2026-09-15 创建的专用靶场仓库，零污染；同日改名到位）

> ✅ **M3-1 硬前置已全部通过（2026-09-15 复测）**：
> - 仓库名 `wintim1143/pr-agent-e2e` 到位
> - token **Repository access 已修好** —— 对靶场的 `contents=write` 与 `pull_requests=write` 探针均返回 422（通过鉴权）
> - **真实写入验证**：用 Contents API 建出 initial commit（`5858bb6` + `b17e66b`），**真实 `git push` 成功**（临时分支 `__push-probe` 创建后删除）
> - 本地靶场 clone 已就绪：`D:\code\pr-agent-e2e`（main @ `b17e66b`，含 `README.md` 改动靶 + `agent.md` 红线靶）
>
> ⚠️ **环境约束（影响 M3-3，不影响 M3-1）**：本机 **`github.com` 主站直连不通**，
> `git clone/push` 必须经 HTTP 代理 **`127.0.0.1:7890`**。
> **落地方式已定（2026-09-15）：不写任何持久化 git 代理配置** —— 由脚本在调用点用
> `git -c http.proxy=...` 注入。详见 §7 M3-3 与 §11 实施日志。

> **填写分层（先定义、后完善）**
> - 🟦 **定义期必填**：头部角色责任块 + 第 1–4 节。
> - 🟨 **实施期渐进补全**：第 5–11 节，推进到对应阶段再填。
> - ⚠️ **源码级证据只进第 11 节「实施日志·已核实事实」**（行号、实测命令、接口路径）。
> - 📊 数据流向图见 [`M3-完整PR闭环-flow.md`](./M3-完整PR闭环-flow.md)。

---

## 0. 角色与责任 🟦

| 角色 | 是谁 | 在本里程碑做什么 / 何时介入 |
|---|---|---|
| 触发方 | **验证脚本**（`scripts/verify-pr-loop.js`，待建） | 构造 issue 形状入参后 `createRun().start()`。**M3 仍不接飞书 inbound** —— 那是 M5 |
| 审批方 | **用户（人工）**，在 `merge` 关卡 | ⚠️ **这是 M2→M3 的关键变化**：M2 是「运行时无闸门」（对远端零影响，风险由里程碑层承担）；M3 起会真写远端，**闸门必须回到编排层** —— workflow 在 merge 前 `suspend()`，用户确认后才 resume 合并。确认通道：M3 用 **Mastra 内建 resume 端点（HTTP）**，飞书按钮回调仍属 M5 |
| 验收方 | **用户（人工）** | 跑验证脚本 + **去 GitHub 网页亲自看 PR 与 merge 结果** + 在飞书群看卡片 |
| 卡 Owner | 当前开发会话 | 推进并更新本卡 |

> ⚠️ **「不可逆操作」的边界就在这里**。M2 最坏结果是本地沙箱变脏（`git reset --hard` 即可回滚）；M3 起 merge 一旦执行，**远端 base 分支就多了一个 commit**。因此 M3 必须做到：① 未 approve 绝不 merge；② 每个不可逆动作前后都有可判定的证据；③ 红线在远端维度同样成立（禁 force push、禁直推 base）。

---

## 1. 目标（一句话）🟦

**给定一条 issue 形状的入参，dev-workflow 在带远端的 `wintim1143/pr-agent-e2e` 里真建分支 → 真编码 → 过三闸门 → 真 commit → 真 push → 真开 PR → 推飞书卡片 → 挂起等人工确认 → 确认后 squash merge；全程 pr-agent 自身不被触碰。**

---

## 2. 为什么现在做（排序理由）🟦

| 理由 | 说明 |
|---|---|
| **M2 闸门已关** | M2 AC 全绿 + 人工验收通过（2026-09-15）。按用户规则，M3 是当前唯一可推进的里程碑 |
| **第一次产生「对外可见的产物」** | M1 只读、M2 只写本地 —— 都是自证。M3 产出的 PR 是**摆在 GitHub 上的、可被别人看见的东西**。自动开发从「本地能改」跨到「能交付」 |
| **红线已被实证，所以才敢真 push** | `guard.ts` 三类拦截在 M2 已端到端验证（run `ba77610d` / `76e7a9e5`）。这个前置不成立时，M3 不该开 |
| **D4 已定，最后一个外部前置消失** | 目标仓库选定专用靶场 `wintim1143/pr-agent-e2e`：把「链路对不对」与「产物对不对」分开验，出错成本最低 |
| **人工闸门的时机已到** | M2 把关在**里程碑层**（跑完人来看），因为零远端、放行代价可控。M3 能写远端后，放行代价不可控 —— 闸门必须**前置到编排层**（suspend/resume） |

---

## 3. 范围 / 明确不做 🟦

**做**

- 目标仓库从本地沙箱切到 `wintim1143/pr-agent-e2e`（`CODING_REPO_ROOT` + `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BASE_BRANCH`）
- `push-open-pr` 真跑：`git push`（token 内嵌 HTTPS URL）+ REST `POST /pulls`
- `notify` 真推飞书「开发完成」卡片（含分支、PR 号；卡片按钮文案与真实可用通道一致）
- `merge` 人工关卡：`suspend({waitingFor:'merge-approval'})` → 人工 resume({approved:true}) → REST `PUT /pulls/{n}/merge`（squash）
- **跨请求上下文恢复**：resume 时 workflow 上下文不丢（M2 的 `stopAfterCommit` 让 merge 步从不 suspend，这项能力在 dev-workflow 上**从未被验证过**）
- **红线扩展到远端维度**：禁 `git push --force`、禁直推 base 分支、禁改远端默认分支
- 端到端验证脚本 `scripts/verify-pr-loop.js` + AC 矩阵 + flow 图
- **吸收 M2 遗留②**：review 判 `request-changes` 后不再继续 commit（见 §7 M3-8）

**明确不做**（留给后续里程碑）

- **不接飞书 inbound / 卡片按钮回调**（M5）：人工确认走 Mastra 内建 resume 端点 —— 与 M1 的 AC-5 同一做法，M1 验收手册已明确「按钮回调属 inbound，推迟到 M5」
- **不真跑 `npm test`**、不引入 lint 闸门（M4）
- 不做多仓库 / 不做 GitHub App 鉴权 / 不做幂等防重复触发（M5）
- 不做 run 追踪 / 成本回写 / 失败告警（M6）

---

## 4. 端到端演示效果 🟦

跑完 `node scripts/verify-pr-loop.js` 并完成人工确认后，在 **GitHub 网页** 的 `wintim1143/pr-agent-e2e` 上能看到：

```
Pull requests → Closed
  #1  为 README 增加安装说明 (#1)          [Merged] ← squash 合入，紫色 merged 标记
```

同时：

- 该仓库 `main` 分支多出**一个 squash commit**（内容 = agent 的改动）
- 飞书群里收到「✅ 开发完成」卡片（含分支名与 PR 号）
- pr-agent 自身工作树**分毫未动**（`git status --short` 与运行前一致）
- 终端逐条打印 AC 判定（分支已推远端 / PR 已开 / suspend 生效 / resume 后真 merge / 未批准时不 merge / 红线）

**对标物**：远端仓库多出一个已被 squash 合并的 PR，且其 base 分支的 commit 来自一次全自动流水线。

---

## 5. 数据流向图 🟨

见 [`M3-完整PR闭环-flow.md`](./M3-完整PR闭环-flow.md)（Mermaid，含 **suspend/resume 跨请求断点**、人工闸门位置、远端写入路径与红线拦截点）。

ASCII 速览（M3 范围）：

```
[验证脚本] 构造 issue 入参
      │
      ▼
 dev-workflow ── checkout ──▶ 靶场仓库 建 feat/<n>-<slug>
      │
      ├── coding ──▶ ClaudeSDKAgent ──▶ Claude Code CLI
      │                    └── PreToolUse hook ──▶ guard.ts ── ✗ deny（红线，含禁 force push）
      ├── test / review / commit（三闸门 + 真 commit）
      │
      ├── push-open-pr ──▶ git push（token 内嵌 HTTPS）
      │                    └── REST POST /pulls ──▶ 远端 PR 诞生 ★不可逆①（可关闭回滚）
      │
      ├── notify ──▶ 飞书卡片
      │
      └── merge ⏸ suspend(waitingFor=merge-approval)   ← 人工闸门（跨请求断点）
                        │
                  人工 resume({approved:true})
                        │
                        └── REST PUT /pulls/{n}/merge (squash) ──▶ base 分支 +1 commit ★不可逆②
```

---

## 6. 用到的 Mastra 模块 🟨

| Mastra 模块 | 导入路径 | 职责 | 为什么用它，而不是裸写 |
|---|---|---|---|
| `Workflow` / `createStep` | `@mastra/core/workflows` | 八步强制顺序；`stopAfterCommit` 不传即恢复完整链路 | 顺序即闸门。M2 已实证该骨架，M3 不重造 |
| **`suspend` / `resume`** | `@mastra/core/workflows`（step 入参） | **merge 人工关卡的挂起与恢复** | M1 在 `insight-workflow` 已实证「挂起 → 人工确认 → 恢复」，M3 是**首次在 dev-workflow 上用**。裸写要自己实现「进程退出后还能恢复」的状态持久化 |
| `LibSQLStore` | `mastra.db`（`src/mastra/index.ts` 装配） | 跨请求恢复 workflow 上下文 | `resume` 是**另一次 HTTP 请求**，进程内变量全丢。上下文必须落库——这正是 M2 从未验过的那一环 |
| `ClaudeSDKAgent` | `@mastra/claude` | 编码执行体（真读写文件） | 同 M2，选型理由见 M2 卡 §6 |
| PreToolUse hook | `@anthropic-ai/claude-agent-sdk` | 唯一可靠拦截点 | 同 M2；M3 额外把「禁 force push / 禁推 base」纳入红线 |
| GitHub REST（`fetch`） | 无（`adapters/github.ts` 自封装） | 开 PR / 合并 | **不是 Mastra 模块**，但按「能复用就复用」原则保留现有 adapter，不引入 `octokit` 等新依赖（理由：M2 已跑通、跨平台一致、不依赖 `gh` CLI） |

**选型备注**：评估过把 PR 操作也包成 Mastra Tool 供 agent 调用 —— 放弃。理由是**开 PR / merge 不该由 agent 自主决定时机**，它们是编排层的确定性动作（受 workflow 顺序与人工闸门约束）。包成 Tool 会把「能力」暴露给一个不该持有它的主体。

---

## 7. 任务分解 🟨

> 按依赖排序。**M3-1 是硬前置**：靶场仓库与写权限不成立时，后面全部无从验证。

### M3-1 靶场仓库就绪 + GitHub 写权限验证（硬前置）✅ **已通过（2026-09-15）**
- 内容：确认靶场仓库已创建；验证 `GITHUB_TOKEN` 的 **Pull requests: write + Contents: write** 权限真的够（此前从未验证过）
- **最终验收结论**：

| 检查项 | 结果 |
|---|---|
| 仓库名 | ✅ `wintim1143/pr-agent-e2e`（改名到位，前缀偏差已消除） |
| **`Contents: write`** | ✅ **探针 422**（`POST /git/refs` 全零 SHA → `Object does not exist`，即通过鉴权）<br>✅ **真实写入成功**：Contents API 建出 `README.md`(`5858bb6`) + `agent.md`(`b17e66b`) |
| **`Pull requests: write`** | ✅ **探针 422**（`POST /pulls` 不存在 head → `Validation Failed: field head invalid`） |
| **真实 `git push`** | ✅ 成功 —— `push origin main:refs/heads/__push-probe` → `* [new branch]`；`push --delete` 亦成功 |
| base 分支 | ✅ `main` @ `b17e66b`（2 个提交） |
| 本地 clone | ✅ `D:\code\pr-agent-e2e`（origin 已配，工作区干净） |

- **修复过程（两轮，可作为 fine-grained token 排错范本）**：
  - **第一轮**：权限未改 → 两个探针均 403（`Resource not accessible by personal access token`）
  - **第二轮**：用户改完权限后，**探针在 `pr-agent` 上变成 422、在靶场上仍是 403**
    → 说明「权限」已对，但「授权范围」不够：**Repository access 当时是 `Only select repositories` 且只勾了 `pr-agent`**
    → 全仓库扫描：名下 33 个仓库**只有 `pr-agent` 返回 422，其余 32 个全 403**
  - **第三轮（本次）**：用户把范围也改好后，靶场两个探针均 422，真实 push 成功 ✅
- ⚠️ **排错关键认知（踩过）**：`GET /repos/{o}/{r}` 返回 200 **不能**证明 token 覆盖该仓库 ——
  **public 仓库无需 token 授权即可公开读取**（未认证请求同样 200）。
  唯一可信判据是**写探针的 403 vs 422**：403 = 未授权/权限不足；422 = 鉴权已过、仅参数不合法。
- 📌 **对后续里程碑的价值**：修完之后 token 若再对某仓库 403，先看 `Repository access`，再看 `Repository permissions` —— 两个都要对

### M3-2 目标仓库切换 ✅ **已完成（2026-09-15）**
- 内容：`scripts/verify-pr-loop.js` 里硬设 `CODING_REPO_ROOT` 指向靶场仓库的**本地 clone**（**已就绪：`D:\code\pr-agent-e2e`**），并设 `GITHUB_OWNER=wintim1143` / `GITHUB_REPO=pr-agent-e2e` / `GITHUB_BASE_BRANCH=main`。**不依赖外部 shell 环境**（与 M2 同一安全模式）
- 验收：脚本打印的目标仓库与远端配置正确；前置检查能识别「本地 clone 存在 / 有 remote / 工作区干净」
- **本轮实际落地**（比原计划多两件事，理由见下）：

| 项 | 状态 |
|---|---|
| `scripts/verify-pr-loop.js` 新建 | ✅ 六个阶段：硬设 env → clone 就绪 → remote 双向核对 → **身份反证** → token 写探针 → 汇总 |
| 硬设 env | ✅ 5 个：`CODING_REPO_ROOT` / `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BASE_BRANCH` / **`GIT_PROXY`**（第 5 个是 M3-3 的依赖，提前落地） |
| **`parseOwnerRepo()` 改基于 `repoRoot()`** | ✅ 见下「隐藏陷阱」 |
| **remote ↔ 硬设值双向核对** | ✅ 新增（原计划没有）：防「跑通了但打在错的仓库上」 |
| token 写权限探针 | ✅ 零副作用，两个权限各一发；本机实测均 **422** |
| 实跑结果 | ✅ 前置检查全绿，耗时 **5.7s**；单测 **97/97**（原 90 + 7 条回归用例） |

#### 加做第一件：remote ↔ 硬设值双向核对

M3 最危险的失败形态**不是「跑不通」，而是「跑通了但打在错的仓库上」**。生产分支错位置的代价不可逆，且全程零报错。所以前置检查里做**三方核对**：

```
硬设的 OWNER/REPO  ←→  靶场 origin remote 解析值  ←→  REST 写探针实际能写到的仓库
```

任一处不一致 → 显式失败退出（`--reset` 或 `M3_OWNER/M3_REPO` 覆盖可解）。

#### 加做第二件：**身份一致性反证**（M3-2 的核心证据）

`parseOwnerRepo()` 修好了没有，光看代码不够 —— 脚本在实跑中打印三条对照：

| 调用 | 实测输出 | 说明 |
|---|---|---|
| `getGithubConfig()` | `wintim1143/pr-agent-e2e @ main` | 业务实际用的值 ✅ |
| `parseOwnerRepo()`（cwd = `repoRoot()`） | `wintim1143/pr-agent-e2e` | **修复后**取值 ✅ |
| `parseOwnerRepo(cwd = pr-agent)` | `wintim1143/pr-agent` | **修复前**的恒定值 —— 反向证明该函数确实按 cwd 走 |

三者对照即可判定修复生效，不需要人工读代码推演。

- ⚠️ **`GITHUB_OWNER` / `GITHUB_REPO` 必须显式设置，不能靠自动解析**（2026-09-15 读码发现）：
  `getGithubConfig()`（`adapters/github.ts:108`）的逻辑是「env 优先，留空则从 `git remote get-url origin` 解析」，
  而 `parseOwnerRepo()`（`:83`）**执行 `git remote get-url origin` 时未指定 cwd** → 用的是**进程工作目录**，
  即 `pr-agent` 自己 → 解析出 `wintim1143/pr-agent`。
  后果是「**push 到靶场 clone，PR 却开到 pr-agent 身上**」这种错位（push 走 `repoRoot()`=`CODING_REPO_ROOT`，
  owner/repo 却来自进程 cwd）。**M3 起会真写远端，这个错位是不可接受的**。
  → 两条一起做：① M3-2 硬设三个 env；② 把 `parseOwnerRepo()` 改为基于 `repoRoot()`（消除 cwd 隐式依赖）。✅ **两条均已完成**
- 注意：`.env` 里当前**只有 `GITHUB_TOKEN`**，没有 owner/repo —— 所以上述显式设置是必需的，不是可选优化
- ⚠️ **git 调用需在调用点注入代理**（见 M3-3）：`CODING_REPO_ROOT` 的那份 clone 要能被 push，而本机直连 `github.com` 不通。
  **不写任何持久化代理配置**，由脚本每次调用加 `-c http.proxy=<GIT_PROXY>`

### M3-3 push-open-pr 真跑打通 ✅ **已完成（2026-09-15）**
- 内容：跑通 `git push`（token 内嵌 HTTPS）+ REST 开 PR；处理已存在 PR 的复用分支
- 验收：远端出现 `feat/<n>-<slug>` 分支；REST 返回 PR number + html_url
- 注意：现有实现里 `githubPushAndOpenPR` 有「工作树脏则兜底补提交」逻辑 —— 需确认它在 M3 下不会掩盖 commit 步的失败（**兜底提交应当降级为显式报错**，否则 commit 闸门失败会被静默绕过）

#### 实跑结论（真写远端）

| AC | 判据 | 实测结果 |
|---|---|---|
| **AC-1** | `git ls-remote origin feat/<n>-<slug>` 有输出 | ✅ `a07bb2f…  refs/heads/feat/1-add-install-section` |
| **AC-2** | REST 返回 `number` + `html_url`，状态 open | ✅ **PR #1** → `https://github.com/wintim1143/pr-agent-e2e/pull/1`（state=open；head `feat/1-add-install-section` → base `main`） |
| **AC-4** | run `status=suspended`、`waitingFor=merge-approval` | ✅ `status=suspended`（停在 merge 关卡等人 approve） |

- `runId = 9bfc3dc3-e228-4b99-9c26-ef8c074c8ca6`（**M3-5 的 resume 要用它**）
- 全流程 **116s**：checkout 4.1s / coding 60.3s / test 8.5s / review 7.0s / commit 12.6s / **push-open-pr 12.2s** / notify 1.1s / merge→suspend
- 三闸门全部 **attempt=1 零重试**：`test.passed=true`、`review.decision=approve`、`commit.message=docs(readme): add install section…`
- **代理注入生效的直接证据**：`push-open-pr` 只用 **12.2s** 就完成。若未走代理，本机直连 `github.com` 会 **21s 超时**后才失败 —— 所以「12.2s 成功」本身就是代理生效的判据

#### 三处代码变更（都是「不做就会静默出错」级别）

1. **`adapters/github.ts` 的 `git push` 加调用点代理注入**
   ```ts
   const pushArgs = ['push', tokenUrl, `HEAD:refs/heads/${branch}`];
   const proxy = process.env.GIT_PROXY?.trim();
   if (proxy) pushArgs.unshift('-c', `http.proxy=${proxy}`);
   ```
   adapter **不给缺省值**：代理是「某台机器在某段时间的网络现状」，不是项目属性。
   缺省值（7890）由调用方提供，adapter 只负责「配了就走」。
2. **移除「工作树脏则兜底补提交」→ 显式报错 `dirty-worktree`**
   M2 的兜底本意是「保证 PR 非空」，但它会**静默掩盖 commit 闸门的失败** ——
   commit 步挂掉 → 工作树自然脏 → 兜底补一个 `chore: auto-dev <branch>` → PR 照开，
   闸门的判负被吞掉，人工看到的却是一条「看起来正常」的 PR。M3 真写远端，推上去撤不回来。
   顺带删掉因此失效的 `commitMessage` 入参（留着会让人以为还有兜底行为）。
3. **`dev-workflow.ts` 的 push-open-pr 步：`res.error` 从「仅告警」改为 `throw`**
   推不动远端却继续往下走，会走到 merge 步并 suspend —— 那是**一个永远不会被点掉的挂起**
   （根本没有 PR 可合）。§10 定调：影响远端的失败必须显式阻断。

> **刻意保留的职责边界**：adapter 仍**不抛**，只返回 `{error}` 结构化结果，由编排层决定是否 throw。
> 「如实报告」与「是否阻断流程」是两件事 —— adapter 这样才可被「只查状态、不希望抛错」的场景复用。

#### 验证脚本新增两项能力

- `--run`：完整八步（**不传 `stopAfterCommit`**）→ 真 push / 真开 PR / 停在 merge 关卡
- `--clean-remote`：清理远端 `feat/*` 分支与对应 open PR
  - **顺序必须先关 PR 再删分支**：反了会让 PR 落进「head 分支已被删除」的悬空状态，
    GitHub 不会自动关它，会一直挂在 open 列表里成为噪音
  - ⚠️ **重跑前必须用**：`--reset` 只清本地，远端残留分支会让下次 push 变成**非快进被拒**
    （本地分支从 base 重建，远端却已多一个提交）→ 每跑第二次必挂

#### 单测锁

`test/mastra/github-adapter.test.ts` 新增 2 条（共 99 条全绿）：
- `工作树脏 → 返回 dirty-worktree，且不产生任何兜底提交`
  —— **第二个断言是关键**：只断言「返回了 error」不够，「返回错误但顺手补了提交」同样会污染远端，
  故用 `git rev-list --count --all === 0` 证明没有新提交
- `未配置 token → skipped（不触发任何 git 操作）`
- 📌 造脏工作树必须 `git add` —— `isDirty()` 查的是 `git diff --cached` 与 `git diff`，
  **未跟踪文件不算脏**，只写文件不 add 是造不出来的

- ⚠️ **`git push` 必须经 HTTP 代理**（2026-09-15 实测，环境级约束）：
  | 目标 | 直连 | 结果 |
  |---|---|---|
  | `api.github.com`（REST） | ✅ 通 | 54ms —— 所以本项目所有 REST 调用**不需要代理** |
  | `codeload.github.com` | ✅ 通 | 546ms |
  | **`github.com`（git clone/push 的实际端点）** | ❌ **不通** | 21s 超时（DNS/SNI 阻断） |
  - 本机可用的 HTTP 代理：**`http://127.0.0.1:7890`**（实测 `CONNECT github.com:443` → `200 Connection established`）
  - ⚠️ **持久化代理配置已清零，且不再新增**（2026-09-15 用户拍板「清理代理，不要配置新的」）。
    环境里原有的坏代理只有两个落点，**都已查清**：
    1. `pr-agent/.git/config` 的 `http.proxy=http://127.0.0.1:10917` —— **仓库级，不是全局**
       （`~/.gitconfig` 从来没配过任何代理项）。已 `git config --local --unset http.proxy` 删除；
       并对 `D:\code` / `D:\vipc` 下 36 个本地仓库全量扫过，**无第二处残留**
    2. 宿主进程注入的环境变量 `HTTPS_PROXY`/`HTTP_PROXY=http://127.0.0.1:14724`（对 github.com 返 502）
       —— 它**不落盘**（实测 `HKCU\Environment` 与机器级环境变量中均无 proxy 项），属 agent shell 运行时注入，**不动它**
  - → **唯一落地方式：调用点注入**。脚本对每次 git 调用加 `-c http.proxy=<GIT_PROXY>`；
    git 的 `http.proxy` **配置优先级高于环境变量**（`http.c` 中 config 命中后不再读 env），
    所以即便 shell 里挂着坏的 `HTTPS_PROXY` 也能被覆盖。
    定义 env `GIT_PROXY`，缺省 `http://127.0.0.1:7890` —— 与 `CODING_REPO_ROOT` 同一「不依赖外部环境」模式
  - ❌ **已否决的两种做法**：① 在靶场 clone 内 `git config http.proxy`（会留下持久化配置）；
    ② 改全局 `git config --global http.proxy`（同样持久化）。两者都与「不配置新代理」相悖
  - 注：node 的 `fetch` 是**直连**（Node 24 默认不读 `HTTPS_PROXY`，实测 `NODE_USE_ENV_PROXY` 未设置），
    这解释了「REST 一直好用、git 一直不好用」的分裂现象

### M3-4 notify 真推飞书卡片 ✅ **已完成（2026-09-15）**
- 内容：`buildDevCompleteCard` 补上真实 PR 链接；卡片文案与「按钮回调不可用」的现状一致（避免误导用户去点无效按钮）
- 验收：飞书群收到卡片；`feishuNotify` 返回 `ok:true`

#### 实测
`notify` 步在三轮跑批里均成功（`step:done mode=app`，约 1.1~1.5s），飞书自建应用模式链路通畅。
**AC-7 仍需人工去飞书群确认**（脚本只能证明推送调用成功，证明不了「群里真的显示了」）。

#### 实际改动（比原计划多一处）
| 改动 | 说明 |
|---|---|
| `ContextSchema` 新增 `prUrl` | 原先上下文里只有 `prNumber`，卡片就只能显示光秃秃的 `#1` |
| `push-open-pr` 步回填 `prUrl: res.prUrl ?? undefined` | `PushPrResult.prUrl` 是 `string \| null`，而 schema 是 `z.string().optional()` **不接受 null** —— 直接透传会让 zod 校验失败 |
| `buildDevCompleteCard` 渲染 `[#3](url)` | 拿不到链接时**显式说明**「未拿到链接，请到仓库 Pull requests 查看」，而不是静默只显示号 |
| 卡片文案 | 改为 **「⚠️ 卡片按钮的回调尚未接入（需 IM 入口），当前点击无效；合并不由卡片按钮驱动，请人工确认后执行 resume」** —— 原文案「按钮回调需 IM 入口，后续接入」容易被读成「能用但还在做」 |

### M3-5 merge 人工关卡（核心）✅ **已完成（2026-09-15）——M3 最高风险项解除**
- 内容：`suspend({waitingFor:'merge-approval'})` → 验证 `status=suspended` → 外部 `resume({approved:true})` → REST squash merge。**同时验证 resume 后上下文未丢**（能拿到 `prNumber` / `branch` 等字段）
- 验收：① 未 resume 时 run 停在 suspended；② `resume({approved:false})` 时**不合并**、PR 保持 open；③ `resume({approved:true})` 后 PR `merged=true`、base 分支出现 squash commit
- ⚠️ **M2 从未验证过 dev-workflow 的 suspend/resume** —— 这是 M3 风险最高的一项，建议单独先跑通再合进端到端

#### 实测（全部通过 · 每一条都跑了独立进程）
| run | 动作 | 结果 |
|---|---|---|
| `d5a53a0a…` | `resume({approved:false})` | ✅ PR **#2** `state=open` / `merged=false`；main `b17e66b → b17e66b` **未变**；耗时 4.3s |
| `1a670d74…` | `resume({approved:true})` | ✅ PR **#3** `state=closed` / `merged=true`；main `b17e66b → e2d1ee7` **已变**；squash sha `e2d1ee77…`；耗时 8.2s |

**上下文未丢**（两项都验到）：跨进程 resume 后 merge 步仍能读到
`prNumber` / `branch` / `issueTitle` / `testResult` / `reviewResult` / `commitResult` ——
这些字段**只可能来自 LibSQLStore**，进程内不存在任何变量。

#### 🔑 关键方法学：必须「跨进程」才验得到持久化
M1 的 `insight-workflow` 也验过 suspend/resume，但那是**同进程**的：`createRun()` 与 `run.resume()`
写在同一个脚本里，变量还在内存里 —— 等于没验持久化。本次刻意把 resume 拆成**独立的一次进程调用**
（`--resume-deny` / `--resume-approve` 各自起进程），复现「进程内变量全丢」，这才验到了 LibSQLStore 那一环。
→ 脚本 `resumeLoop()` 里对此有详细注释，勿改回同进程。

#### 实际改动：merge 步的「三态」语义（原实现有个永不消失的挂起）
原实现是 `if (!resumeData || !approved) suspend()` —— 于是**「明确拒绝」与「还没表态」走了同一条路**：
用户点「❌ 拒绝」→ 又挂起一次 → 卡片再次出现 → 再点再出现，**一个永远点不掉的循环**
（与 M3-3 踩的「push 失败仍走到 suspend」是同一类坑）。现拆成三态：

| `resumeData` | 语义 | 动作 | run 状态 |
|---|---|---|---|
| 从未 resume | 还没人看 | `suspend()` | `suspended` |
| `{approved:true}` | 批准 | 真 squash merge | `success` |
| `{approved:false}` | **明确拒绝** | 终止，PR 保持 open | `success` |

拒绝时 run 记 `success` 而非 `failed`：**「拒绝」是合法的人工决策，不是流水线故障** ——
记成失败会污染「哪些 run 真的坏了」这一判断。同时**刻意不关 PR**：关闭是另一个不可逆动作，
且「拒绝合并」与「废弃这个 PR」不是同一件事，留 open 让人自己决定。

### M3-6 红线扩展到远端维度 ✅ **已完成（2026-09-15）**
- 内容：把「禁 force push / 禁直推 base / 禁改远端默认分支」纳入 `guard.ts` 的危险命令表（若已有则补单测），并端到端验证一次
- 验收：红线单测全绿；端到端跑一次 `--redline` 类场景，deny 日志出现且远端未受影响

#### 原表的两类漏洞（读码发现，都不报错、只是静默放行）
| 漏洞 | 具体形态 |
|---|---|
| **远端破坏性操作整片缺失** | `--mirror`（全 ref 同步）、`--prune`（删远端有而本地无的分支）、`-d`/`--delete`、空 refspec `git push origin :branch`、`git remote set-url\|rename\|remove\|set-head`、`gh repo edit --default-branch` —— 原表**一条都没有** |
| **force push 只认孤立 `-f`** | 原正则 `\s(?:-f\|--force)\b` 漏掉短选项组合 `git push -uf origin x` |
| **base 分支名写死** | 原正则硬编码 `(?:main\|master)`。而 base 由 `GITHUB_BASE_BRANCH` 决定 —— **改名后这条红线静默失效**（不报错、不告警，只是不再拦） |

#### 顺带修掉一个真实误拦
原实现用 `\bmain\b` 全文匹配 → `git push origin feat/add-main-section` 里分支名嵌了 `main`，
`-` 是词边界 → **正常推自己的分支被拦**。现改为**只认 refspec 位置上的分支名**
（要求 base 名前面是空白、可带 `+` 与 `src:`、可带 `refs/heads/`，后面是空白或行尾），
于是 `feat/add-main-section`（前缀 `-`）、`feature/main`（前缀 `/`）都不再命中。

#### 实际改动
| 文件 | 改动 |
|---|---|
| `guard.ts` | 新增 `DEFAULT_PROTECTED_BRANCHES` / `resolveProtectedBranches()`（**只增不减**：传入项与默认值取并集，不可能靠传参把 main/master 移出保护）；`DANGEROUS_COMMANDS` 常量改为 `buildDangerousCommands(protectedBranches)`；新增 6 条远端维度规则 + 动态 `pushProtected` 正则（分支名经 `escapeRegExp` 转义，`release/1.0` 不会当通配）；`guardToolCall()` 加第 4 个可选参数 |
| `coding-agent.ts` | 新增 `resolveProtectedBranchNames()` 从 `GITHUB_BASE_BRANCH` 读实际 base；`makeGuardHook(repoRoot, protectedBranches?)` |
| `progress.ts` | 新增事件类型 **`guard:deny`** |
| `coding-agent.ts` | deny 分支加 `stage('guard:deny', …)` 埋点 |

#### 🔑 为什么给 deny 加埋点（原有实现的可观测性缺口）
原来 guard 拦下一次调用只打 `console.warn` —— **终端输出会随会话消失**，「红线确实生效了」
这件事事后**无法从任何持久化文件证明**。而 M3-6 的验收恰恰要求「deny 日志出现」。
现每次拦截落一条结构化事件到 `logs/dev-workflow.log`。只记工具名与原因摘要，**不记入参**
（入参可能含 `.env`、token 等凭据）。

#### 实测
- **单测 95 条全绿**（原 57 + 新增 38）：「新红线」18 条 deny + 「不得误拦」12 条 allow + 动态注入/只增不减 8 条
- **端到端**（`--gate-negative`，见 M3-8）：`guard:deny` 埋点 **2 条**，内容
  `Edit: 受保护路径禁止写入：agent.md（自举期 agent 不得改动流水线自身）`；
  靶场工作树**逐字节未变**、远端 heads **未变**、coding agent 自述「被 permission guard 当场拒绝」
- 端到端刻意用「受保护路径」而非「远端 force push」构造：后者需要 agent 主动执行危险命令，
  不可控且若真跑出去就已是事故。**红线端到端验证本身不能引入红线风险**。

### M3-7 端到端验证脚本 + AC 矩阵回填 ✅ **已完成（2026-09-15）**
- 内容：`scripts/verify-pr-loop.js`：前置检查（靶场就绪 / 工作区干净 / token 有写权限）→ 跑 workflow 到 suspend → 自动 resume → 逐条打印 AC 判定。证据落 `logs/m3-verify.log`
- 验收：脚本可重复运行；AC-1~AC-9 全部有可判定输出

#### 脚本能力（4 种模式）
| 模式 | 作用 |
|---|---|
| （默认） | 前置检查 6 段：硬设 5 env / 靶场就绪 / remote 双向核对 / 身份反证 / token 写探针 / 汇总 |
| `--run` | 完整八步，真 push、真开 PR，止于 `suspended`，打印 runId |
| `--resume-deny <runId>` | **独立进程** resume 拒绝 → 验 AC-5 |
| `--resume-approve <runId>` | **独立进程** resume 批准 → 验 AC-6 |
| `--gate-negative` | 负向场景：预期失败，验「闸门判负 → 无 commit / 无 push」 |
| `--clean-remote` / `--reset` / `--skip-probe` | 清远端 / 清本地 / 跳过探针 |

#### 两个在设计上刻意做的取舍
1. **resume 模式不做前置检查**：它的验证对象是「上一轮留下的 suspended run」，
   若先跑 `--reset`/`--clean-remote` 会把证据清掉。故 resume 在 main 里**独立分流**，早于前置检查。
2. **脚本侧独立实现 `parseRemoteUrl()` 做交叉核对**，不复用 `parseOwnerRepo()` ——
   避免「用被测对象验证被测对象」的自证循环。

#### 踩坑与修复（都写在脚本注释里）
- **`--gate-negative` 一开始被 `if (!RUN)` 挡在前置检查**，只跑检查就退出 → 条件改为 `if (!RUN && !GATE_NEGATIVE)`
- **「HEAD sha 变没变」不能当「有没有 commit」的判据**：checkout 会把 HEAD 从上一轮分支切到
  「从 base 新建的分支」，sha 必然变化（实测 `42b313a(feat/3) → b17e66b(新分支)` 被误判成「产生了 commit」）。
  改用「领先 base 的提交数 = 0」+「本地 base 未移动」
- **改函数签名漏改调用点**：`judgeGateNegative` 加了 `baseLocalBefore` 参数却没更新调用处 →
  函数内是 `undefined` → 比较恒 false → 报出一条**并不存在**的失败。已修，并加了内部告警
  （`if (!baseLocalBefore) log('⚠️ …调用方漏传?')`）防止同类静默失真

#### AC 回填
见 §8 表格「实测」列（AC-1~AC-9 全部有实测值或明确标注未覆盖项）。

### M3-8 吸收 M2 遗留②：`request-changes` 后不再 commit ✅ **已完成（2026-09-15）**
- 内容：当前 `test` / `review` 步判负后，流程**仍会继续走 commit**（代码里是 TODO，条件边未实现）。M3 起 commit 会被 push 到远端，误判代价升高 → 应实现「判负则终止（或回退 coding）」的条件边
- 验收：构造一个 review 必判 `request-changes` 的场景，验证**没有 commit、没有 push**（而非「commit 了但没人看」）
- 📌 若本轮只做「终止」不做「回退重做」，需在卡里写清这是有意为之的一半（回退涉及循环/次数上限，成本高）

#### ⚠️ 计划中的 `branch` 条件边**经实测被否决**（这是本里程碑最有价值的一条否证）
卡里原设想用 Mastra 的 `.branch()` 做条件边。动手前先写了两个一次性实验
（`.tmp/branch-probe.js` / `.tmp/branch-probe2.js`，`@mastra/core@1.63.2`）探运行时语义，
三条事实**全部与设想相反**：

| 实验发现 | 后果 |
|---|---|
| 多条条件**不互斥**，而是「谁为真谁执行」。兜底的 `async () => true` 让 `b-pass` 与 `b-other` **在同一次运行里都执行了** | **没有 else 语义**，无法表达「二选一」 |
| branch 之后链接的 `.then(step)` 收到的 inputData 是**聚合对象** `{'b-pass':{…},'b-other':{…}}`，不再是上一步输出 | 与本文件「八步共用同一 `ContextSchema`」直接冲突；`inputData.prNumber` 全部读不到 |
| 分支内 step 抛错 → run `status=failed`，后续步骤不执行 | **终止本来就该用 throw** |

→ 结论：**闸门判负的终止用「step 内显式 throw」表达**，语义等价（后续一律不执行）且是 fail-closed。
实验脚本在 `.tmp/`（已被 gitignore），故结论**必须写在这里**，否则下次又会有人去试。

#### 有意只做「终止」的一半
**不做「回退 coding 重做」**：回退需要循环（`.dowhile()`）+ 次数上限 + 失败累积策略 + 防死循环，
属独立工作量，M3 范围外。这是**有意为之的一半**，不是漏做。

#### 实测（`--gate-negative`，4/4 通过）
构造：issue 要求改**受保护文件** `agent.md` → `guard` 拦下每次写入 → 工作树无 diff → test 闸门判负。
| 判据 | 结果 |
|---|---|
| 错误含 `GATE_REJECTED` | ✅ `GATE_REJECTED@test: 测试闸门判负,终止流水线(不进入 review/commit/push)` |
| 没有产生 commit | ✅ 领先 base 的提交数 = 0，本地 base 未移动 |
| 靶场工作树无残留 | ✅ 干净（受保护路径写入确实被拒，未留残留） |
| 远端未被写 | ✅ heads 运行前后均 4 条、逐字未变；`push-open-pr` 步**未执行** |

**这个构造一举两得**：同时验证了 M3-6（红线在真实链路生效，`guard:deny` 埋点 2 条）
与 M3-8（判负即终止）。且本次是 **test 闸门**判负 —— review 那条路径共用同一实现，未单独构造。

---

## 8. 验收清单（AC）🟨

> 定义期先列预期判据，实施到对应阶段再按实际端点 / 字段校准。
> **验证方式列是强制的**：写清「由哪个脚本 / 手工动作判定，证据落在哪个文件」。

| # | 验收项 | 判据 | 验证方式 · 证据位置 | 实测（2026-09-15 · M3 收口） |
|---|---|---|---|---|
| AC-1 | feature 分支真推到远端 | `git ls-remote origin feat/<n>-<slug>` 有输出 | `verify-pr-loop.js` 打印；证据 `logs/m3-verify.log` | ✅ 三轮均成功：`feat/1-add-install-section@a07bb2f`、`feat/2-add-quickstart-section@1de6dd5`、`feat/3-add-contributing-section@42b313a` |
| AC-2 | PR 真开 | REST 返回 `number` + `html_url`；网页可见，状态 open | 脚本打印 + **人工去 GitHub 看** | ✅ PR **#2**（open）、PR **#3**（open → merged）。脚本自动核对 REST 返回，网页可见 |
| AC-3 | PR 内容正确 | `head` = feature 分支、`base` = main、body 含 test/review 结论 | REST 查询 + 人工看 PR 描述 | ✅ PR #2：`head=feat/2-…` → `base=main`，`+10/-0`，body 含 **测试/审核/commit** 三段完整结论（测试报告还主动列出「非阻塞遗留确认项」——证明模型确实在读 diff） |
| AC-4 | merge 关卡真挂起 | run `status = suspended`、`waitingFor = merge-approval`；此时 PR **仍 open** | 脚本打印 + `GET /api/workflows/dev-workflow/runs/<id>` | ✅ 三个 run 均如此；跨进程读 storage 得 `status=suspended`、`suspendedPaths={"merge":[7]}`，PR 同时保持 open |
| AC-5 | 未批准不合并 | `resume({approved:false})` 后 PR 保持 open、base 分支 sha 未变 | 脚本打印 + 人工核对 | ✅ run `d5a53a0a…` → PR #2 `state=open` / `merged=false`；main `b17e66b → b17e66b` **未变**（另 run `9bfc3dc3…` 亦同，PR #1 保持 open） |
| AC-6 | 批准后真 merge | `resume({approved:true})` 后 PR `state=closed` / `merged=true`；base 分支出现 squash commit | REST 查询 + **人工去 GitHub 看 Merged 标记** | ✅ run `1a670d74…` → PR #3 `state=closed` / `merged=true`；main `b17e66b → e2d1ee7`；squash sha `e2d1ee77…`，main 最新提交 = `Merge pull request #3` |
| AC-7 | 飞书卡片真推送 | 群里收到卡片；`feishuNotify` 返回 `ok:true` | **人工去飞书群看** + 脚本打印 | ⚠️ **半验**：`notify` 步三轮均 `step:done mode=app`（1.1~1.5s，应用模式链路通畅），**但「群内是否真的显示」脚本证不了，需人工确认** |
| AC-8 | 红线（远端维度） | `git push --force` / 直推 base → `deny` | 单测 + 端到端；日志含 `[permission-guard] deny` | ✅ 单测 **95 条**（新增 38：远端红线 18 deny + 不得误拦 12 allow + 动态注入 8）；端到端 `guard:deny` 埋点 **4 条**，agent 换了 `Edit` 与 `Write` 两种途径**都被拦**，远端 heads 未受影响 |
| AC-9 | pr-agent 工作树未被触碰 | 运行前后 `git status --short` 一致、无新增分支 | 脚本打印快照对比 | ✅ `--gate-negative` 实测：`工作树一致 / 本地分支无新增`（`logs/` `mastra.db` `dist/` `.tmp/` 均已 gitignore，跑批不污染 status） |

> **AC-4/5 是本里程碑的核心价值**：它们验证的不是「能不能合并」，而是「**不该合并的时候合不了**」。这两条不过，自动开发就不该被允许接触任何真实业务仓库。

> **AC-5 / AC-6 的方法学要点**：两次 resume 都是**独立进程**调用（`--resume-deny` / `--resume-approve`），
> 而不是在跑 `--run` 的同一个进程里接续 —— 同进程 resume 时变量还在内存里，**验不出 LibSQLStore 的持久化**。
> 详见 §7 M3-5 的「关键方法学」小节。

> **AC-7 是九条里唯一没有闭环的**：它是**唯一必须以人为观测点**的一条（「群里收到卡片」）。
> 脚本侧能证明的极限是「推送调用返回成功」，剩下一步需要人去飞书群看一眼。

---

## 9. 解锁与复用 🟨

- **复用自 M2**（已回填至 [`M2-本地写入闭环.md`](./M2-本地写入闭环.md) §9）：`CODING_REPO_ROOT` 配置口子、已实证的 `guard.ts` 围栏、`stopAfterCommit` 编排开关（M3 不传即恢复完整八步）、验证脚本骨架（`verify-local-write.js` → `verify-pr-loop.js`）
- **本里程碑预期解锁**（供 M4）：
  - 一条真实 PR 作为载体 → M4 可以把「真跑的测试结果」挂在这条 PR 上
  - suspend/resume 在 dev-workflow 上已被验证 → M4/M5 可以放心在前置步骤加更多人工关卡
  - 远端红线（禁 force push / 禁推 base）已验证 → M5 的多仓库才敢放开第二个仓库
- **实际复用**（2026-09-15 建 M4 卡时回填）：
  - **编排层八步结构原样沿用** —— M4 的改造只在 `test` 步**内部**，flow 图上可直观确认「范围没有蔓延」
  - **M3-8 的判负终止路径直接复用**：M4 的程序化判负接在同一处 throw 上，不需要再动编排结构
  - `buildChangeContext()` 的 diff 取数口径（工作树 ∪ 已提交）→ M4 的 `agentModifiedTests` 复用同一份文件列表
  - **靶场 + 本地 clone 复用**：M4 只往靶场**加文件**（`package.json` + 被测文件 + 人工预置测试），不换仓库
  - `verify-pr-loop.js` 的**负向场景判据集**（`--gate-negative` 的 no-commit / clean-tree / no-push）→ M4 的 AC-5 直接沿用
  - ⚠️ 一处**预期失效**：M4 卡 §10 已记录「靶场构造可能被 `--clean-remote` 误删」的风险

---

## 10. 异常与兜底 🟨

> 判定条件必须可执行（返回码 / 超时秒数 / 配置缺失），不许写「可能出问题就兜底」。
> ⚠️ **M3 与 M2 最大的不同：失败不能再「仅告警」**。凡是会影响远端状态的步骤，失败必须显式阻断。

| 已知异常 | 判定条件（可执行） | 降级行为 | 是否阻断 AC |
|---|---|---|---|
| `GITHUB_TOKEN` 缺写权限 | REST 返回 403 / 422 | **显式失败并终止**（前置检查阶段就拦住，不进入编码） | **是**（全部） |
| 靶场仓库未创建 / 本地 clone 不存在 | 目录不存在或缺 `.git` 或 remote 解析失败 | 前置检查报错退出 | **是**（全部） |
| push 失败（网络 / 认证 / 非快进） | `git push` 非零退出 | **显式失败**；不得降级为「跳过 push 继续」 | **是**（AC-1/2/3） |
| 该分支已有 open PR | REST `GET /pulls?...head=...` 返回非空 | 复用已有 PR（不新建，避免 422） | 否 |
| 无领先 base 的提交 | `countAhead == 0` | 返回 `no-commits-to-push`，**显式失败**（空 PR 无意义） | **是**（AC-2） |
| 工作树脏但 commit 步已失败 | `isDirty == true` | ⚠️ **M3 需改**：现有「兜底补提交」会掩盖 commit 闸门失败，应改为显式报错 | **是**（AC-2） |
| merge 冲突 / 被保护规则拦截 | REST 返回 405 / 409 | **显式失败**，不回滚已开的 PR（留人工处理） | **是**（AC-6） |
| 飞书未配置 / 推送失败 | `getFeishuConfig()` 为 null 或 `res.ok=false` | 跳过 / 仅告警，**不阻断**（合并关卡仍会 suspend 等人） | 否（AC-7 除外） |
| 挂着没人 approve | run 停在 suspended 超过 N 小时 | 无自动处理（挂起是预期语义，不是异常） | 否 |
| 红线场景 agent 被拦后死磕 | 连续 N 次 deny | ⚠️ **M2 遗留③，M3 可选吸收**：加「连续 N 次 deny 主动放弃」 | 否（安全属性已成立） |

---

## 11. 实施日志 🟨（持续追加）

> 每完成一个小任务追加一条，不要等到里程碑收尾才写。
> 格式：日期 · 任务 / 改了什么 / 重点模块 / 本轮核实的既有事实 / 踩坑 / 待确认。

### 2026-09-15 · M3 建卡（定义期）
- **改了什么**：新建本卡 + [`M3-完整PR闭环-flow.md`](./M3-完整PR闭环-flow.md)；`milestones/README.md` 里程碑总览同步（M2 归档、M3 挂链接、M4 范围修订）
- **重点模块**：本卡 §0（人工闸门语义）、§7 M3-1/M3-5/M3-8（三个风险点）
- **本轮核实的既有事实**（建卡前读代码确认，非推测）：
  - `githubPushAndOpenPR`（`adapters/github.ts:418`）已实现「token 内嵌 HTTPS push + REST 开 PR + 已存在则复用」，**但从未在真实远端上跑过**（M2 全程 `stopAfterCommit=true`，直接 return）
  - `githubMergePR`（`adapters/github.ts:499`）走 `PUT /pulls/{n}/merge` + `merge_method: 'squash'`，同样**从未真实调用**
  - merge 步（`dev-workflow.ts:560`）的 `suspend({waitingFor:'merge-approval'})` 逻辑已写好，但 M2 因 `stopAfterCommit` 在 suspend **之前**就 return 了 → **该 suspend 从未真正执行过**
  - `notify` 步（`dev-workflow.ts:518`）的飞书卡片已接 `feishuNotify`，M2 同样被 `stopAfterCommit` 跳过
  - `githubCheckout` 是**纯本地 git**（不调 API、不 push），故 M2 沙箱无需远端；M3 起 `repoRoot()` 必须指向带 remote 的 clone
  - 现有 `verify-local-write.js` 的「工作区快照对比」机制可直接复用到 `verify-pr-loop.js`
- **踩坑**：（建卡阶段暂无）
- **待确认**：
  - **M3-1 是硬前置**：需用户确认靶场仓库已建、且 token 具备 Pull requests write 权限（此前从未验证）。若权限不足，M3 无法开工
  - **触发通道**：M3 人工确认走 HTTP resume（与本项目 M1 一致、与「按钮回调属 M5」的既定分工一致）。若要求 M3 就接飞书按钮回调，需把 M5 的 inbound 工作提前，成本显著上升
  - **M3-8 做到哪一半**：仅「判负即终止」还是连「回退 coding 重做」一并做（后者涉及循环与次数上限）

### 2026-09-15 · M3-1 前置探测（建卡当天，用户创建靶场仓库后即时执行）
- **改了什么**：无代码改动；本卡 M3-1 补实测结论表、头部补「仓库名偏差待拍板」
- **重点模块**：本卡 §7 M3-1
- **本轮核实的既有事实**（**全部为实测，非推测**）：
  - 用户已于 `2026-09-15T03:23Z`（北京时间 11:23）创建仓库，实际名 **`wintim1143/wintim1143-pr-agent-e2e`**（带 `wintim1143-` 前缀），空仓库、`default_branch=main`、0 分支
  - token 为 **All repositories** 模式：`GET /user/repos` 共 33 个仓库，**包含这个刚创建的新仓库** → 无需为新仓库单独授权
    > ⚠️ **此结论已被同日复测推翻，见下节**。`GET /user/repos` 能看到某仓库**不能**证明 token 已授权该仓库 ——
    > **public 仓库无需 token 授权即可公开读取**，这个列表对判断授权范围没有证明力。
  - ⚠️ **`Contents: write` 缺失**：探针 `POST /git/refs`（指向全零 SHA）→ 403，响应头 `x-accepted-github-permissions: contents=write`
  - ⚠️ **`Pull requests: write` 缺失**：探针 `POST /pulls`（head 用不存在的分支名）→ 403，响应头 `x-accepted-github-permissions: pull_requests=write`，body `Resource not accessible by personal access token`
  - 仓库级 `permissions` 字段（`admin/maintain/push/triage/pull` 全 true）反映的是**登录用户对仓库的权限**，**不代表 token 的权限粒度** —— 这两者容易混，是本轮的关键认知
  - **零副作用权限探针法（可复用）**：用「必然失败但绝不产生后果」的写请求探测权限 —— `POST /pulls` 传不存在的 head（有权→422、无权→403）、`POST /git/refs` 传全零 SHA（有权→422、无权→403）。响应头 `x-accepted-github-permissions` 在 403 时直接列出缺哪个权限。**比「真建一个再删掉」安全，且同样权威**
- **踩坑**：
  1. 空仓库无 base 分支 → `githubCheckout` 的 `createBranchVerified(root, branch, base)` 会失败。**靶场仓库必须先有一个 initial commit**
  2. 本环境没有 `perl` / `sed`（PortableGit 精简版），批量文本替换要用 `node -e`
- **待确认**：
  - **token 权限修复（硬阻塞）**：GitHub → Settings → Developer settings → Fine-grained tokens → 该 token → Repository permissions，把 **Contents** 与 **Pull requests** 改为 `Read and write`。**token 值不变，`.env` 无需改**
    > ⚠️ **这条修法不完整，已被下节修正**：只改「Repository permissions」不够 —— 还需改「Repository access」。
  - **仓库名**：改名 vs 沿用（见头部说明）
  - **靶场仓库需要 initial commit**（README 即可），否则 M3-2 起 checkout 无 base 可用

### 2026-09-15 · M3-1 复测（用户完成改名 + 改权限后）
- **改了什么**：无代码改动；本卡 M3-1 结论表重写、头部解除仓库名待拍板、M3-2 补「必须显式设 GITHUB_OWNER/GITHUB_REPO」
- **重点模块**：本卡 §7 M3-1 / M3-2
- **用户侧已确认完成**：① 仓库从 `wintim1143-pr-agent-e2e` 改名为 **`wintim1143/pr-agent-e2e`**（✅ 名字已干净）；
  ② token 权限已改（Contents + Pull requests → Read and write）
- **本轮核实的既有事实**（全部实测）：
  - ✅ **仓库名到位**：`GET /repos/wintim1143/pr-agent-e2e` → 200，无 `wintim1143-` 前缀
  - ✅ **权限本身确实改对了** —— 在 `pr-agent` 上跑同一对探针：
    `POST /git/refs`（全零 SHA）→ **422 `Object does not exist`**；`POST /pulls`（不存在的 head）→ **422 `Validation Failed: field head invalid`**。
    **422 是「通过鉴权后的参数校验失败」**，与 403 有本质区别 → 证明 `contents=write` 与 `pull_requests=write` 均已生效
  - ❌ **但对 `pr-agent-e2e` 两个探针仍是 403** → 问题不在权限，在**授权范围**
  - 🔑 **决定性证据：对名下 33 个仓库逐跑写探针 → 只有 `wintim1143/pr-agent` 返回 422，其余 32 个全部 403**（含 `pr-agent-e2e`）
    → token 的 **Repository access = 「Only select repositories」且只勾了 `pr-agent` 一个**
  - ⚠️ **`GET /repos/wintim1143/pr-agent-e2e` 返回 200 是极具误导性的假信号**：该仓库是 public，
    **public 仓库无需 token 授权即可公开读取**（未认证请求同样 200）。判断 token 是否覆盖某仓库，
    **唯一可信判据是写探针的 403 vs 422**，不能看 GET 状态码
- **修正上一节的两条错误结论**：
  1. ❌「token 为 All repositories 模式」→ 实为 **Only select repositories（仅 `pr-agent`）**
  2. ❌「改 Repository permissions 即可」→ 还需改 **Repository access**（见 M3-1 修法）
- **踩坑**：把「GET 能读到」当成了「token 已授权」—— 这是本轮唯一但关键的误判。
  根因是 public 仓库的公开读权限与 token 的细粒度授权在 API 表现上无法区分，**必须用写探针区分**
- **待确认**：
  - ⚠️ **授权范围（唯一硬阻塞）**：token 的 **Repository access** 改为 `All repositories`（推荐）
    或 `Only select repositories` 并勾上 `pr-agent-e2e` → **Update token**
  - **靶场仓库仍需 initial commit**（README 即可）：仓库当前 0 分支，`githubCheckout` 无 base 可用。
    建议顺手在仓库里放一个受保护文件（如 `agent.md`）作为红线靶子，对齐 M2 沙箱的做法
  - **M3-2 的 `GITHUB_OWNER`/`GITHUB_REPO` 必须显式设置**（见 M3-2 的解析链分析）—— 否则 PR 会开到 pr-agent 自己身上

### 2026-09-15 · M3-1 通过 + 靶场初始化 + 网络阻塞定位（第三轮）
- **改了什么**：无 pr-agent 代码改动；**远端靶场仓库真实初始化**（2 个 commit）；本卡 M3-1/M3-2/M3-3 补实测结论；头部状态更新
- **重点模块**：本卡 §7 M3-1 / M3-2 / M3-3
- **本轮实际执行的动作（都是真实写远端，非模拟）**：
  1. 探针复测 → 靶场两个写操作均 **422**（此前 403）→ **权限通了**
  2. `PUT /contents/README.md` → 201，commit `5858bb6`（**真实写入落盘**）
  3. `PUT /contents/agent.md` → 201，commit `b17e66b`
  4. `git clone`（走代理 7890）→ `D:\code\pr-agent-e2e` 就绪
  5. **真实 `git push`**：`push origin main:refs/heads/__push-probe` → `* [new branch]` ✅
  6. 清理：`push origin --delete __push-probe` → `- [deleted]` ✅，远端最终只剩 `main`
- **本轮核实的既有事实（重要，全部实测）**：
  - 🔑 **`github.com` 主站直连不通，`api.github.com` 直连通** —— 这造成「REST 一直好用、git 一直不好用」的分裂现象。
    实测：`api.github.com/zen` 200/54ms；`codeload.github.com` 200/546ms；`github.com` **21s 超时**
  - 🔑 **本机可用代理是 `127.0.0.1:7890`**（`CONNECT github.com:443` → `200 Connection established`）。
    逐端口扫了 34 个常见代理口，只有 7890 通；1087 超时；
    **10917** 连不上（落点是 `pr-agent/.git/config` 的**仓库级** `http.proxy`，不是全局，已于同日清理）；
    **14724** 返 `502 CONNECT tunnel failed`（落点是**宿主注入的环境变量**，不落盘）—— **两个默认落点都是坏的**
  - 🔑 **node 的 `fetch` 不走代理**：Node 24 默认不读 `HTTPS_PROXY`（`NODE_USE_ENV_PROXY` 未设置），
    前面所有 REST 调用都是**直连**成功的。所以「env 里配了代理」对 node 无效，但对 git 有效（且指向坏代理）
  - ⚠️ **GitHub Git Data API 在空仓库上不可用**：`POST /git/blobs` 对 0 commit 的仓库返回
    **409 `Git Repository is empty.`**。必须先经 **Contents API**（`PUT /contents/{path}`）建出首个 commit，
    之后 Git Data API 才可用。建 initial commit 只能走 Contents API
  - ⚠️ **空仓库 409 与权限 403 的区别**：409 是「仓库状态不允许」，也可能出现在有权限时 ——
    所以探针解读要分场景：空仓库时 `POST /git/refs` 返 **409**，仓库非空后才回到 **422**
- **踩坑**：
  1. 第一次 `git clone` 被沙箱网络层拦下（且代理本身也是坏的），留下一个只有空 `.git` 的残留目录 ——
     **clone 失败后重试前要先清残留**，否则报 `destination path already exists`
  2. 用 `-c credential.helper='!f(){...}'` 注入 token 而非把 token 写进 URL ——
     **避免 token 落进 `.git/config`，也避免 git 把带 token 的 URL 打印到输出里**
- **待确认 / 已闭合**：
  - ✅ token 授权范围（用户已改，本轮复测通过）
  - ✅ 靶场 initial commit（本轮已建，`main @ b17e66b`）
  - ✅ 本地 clone（`D:\code\pr-agent-e2e`）
  - ✅ **`GIT_PROXY` 落地方式已拍板**（2026-09-15）：脚本调用点注入 `-c http.proxy=$GIT_PROXY`
    （缺省 `http://127.0.0.1:7890`），**不写任何持久化配置** —— 见下节清理记录
  - ⬜ **真实建 PR 未做**：`pull_requests:write` 由探针 422 证明，**真实 `POST /pulls` 201 留给 M3-3**
    （避免在靶场留下无意义的 closed PR）

### 2026-09-15 · 清理 git 代理配置 + 文档校正（用户拍板「不配置新的」）
- **改了什么**：`pr-agent/.git/config` 删除 `http.proxy`（唯一改动，无代码改动）；本卡 §7 M3-2 / M3-3、§11 上节记录按实测校正
- **重点模块**：本卡 §7 M3-3（代理落地方式的最终定案）
- **执行的动作**：
  1. `git config --local --unset http.proxy` → 删除仓库级 `http.proxy=http://127.0.0.1:10917`
  2. 复核各层级：`git config --get http.proxy` / `https.proxy` 均返回空（rc=1）→ **无任何层级的代理配置**
  3. 全量扫描 `D:\code\*`（14 个仓库）+ `D:\vipc\*`（22 个仓库）的仓库级 `http.proxy`/`https.proxy` → **全空**，无第二处残留
- **本轮核实的事实（修正此前记录的两处错误）**：
  - ❌ 此前记「**全局** `git config --global http.proxy = 127.0.0.1:10917`」→ 实为 **`pr-agent` 仓库级**。
    证据：`git config --global --list --show-origin` 只有 `user.*` / `safe.directory` / `http.postbuffer` / `alias.m` / `credential.helper`，
    **不含任何 proxy 项**；坏代理出现在 `git config --local --list` 的 `file:.git/config` 行
  - ❌ 此前把 `HTTPS_PROXY=127.0.0.1:14724` 当成「用户配的环境变量」→ 实为**宿主进程注入**：
    `HKCU:\Environment` 全量枚举（13 项）与机器级环境变量的 `*proxy*` 匹配**均为空**，
    说明它只存在于 agent shell 的进程环境里，不落盘、不该由项目改动
- **为什么「不配置新的」是对的（第一性原理）**：
  代理是**某台机器在某段时间的网络现状**，不是项目的属性。把它写进 `.git/config`（无论全局还是仓库级）
  等于把「本机网络拓扑」固化进仓库可改动的配置面 —— 换机器就失效，且故障表现是「git 静默连不通」这种最难排查的一类。
  **正确落点是调用点**：`-c http.proxy=` 只在单次命令生效，缺省值 + env 覆盖，既解决问题又不留副作用
- **踩坑**：git 的 `http.proxy` **配置优先级高于 `http_proxy`/`HTTPS_PROXY` 环境变量**（`http.c` 中 config 命中后不再读 env）——
  这既是「清了 local 配置后 shell 里那个坏 env 才会生效」的原因，也是「调用点注入能覆盖坏 env」的依据
- **待确认**：
  - ✅ **本轮文档改动已提交**（`docs(m3): 清理 git 代理配置 + 校正落点,代理约束写入卡与流程图`，
    3 文件 +170/-29；ref 落盘已核验，未触发 ref-not-flushed bug）
    > 卡内不钉自身提交的 SHA —— 该提交就含本卡，钉了会形成「每次改卡都要再提交一次」的循环。
    > 需要 SHA 时用 `git log --oneline -1 -- milestones/` 反查
  - ✅ 下一步：M3-2 目标仓库切换 —— **已完成，见下节**

---

### 2026-09-15 · M3-2 目标仓库切换 + `parseOwnerRepo` cwd 修复 ✅

- **改了哪些文件**
  | 文件 | 改动 | 性质 |
  |---|---|---|
  | `src/mastra/adapters/github.ts` | `parseOwnerRepo()` 加 `cwd?` 参数、默认走 `repoRoot()`、并 `export`；`repoRoot()` 调用移进 `try` | **重点模块**（本次唯一的生产代码改动） |
  | `src/mastra/adapters/github.ts` | 模块头注释第 10 行 + `missingGithubConfig()` 两条提示文案，改为「从**目标仓库**的 origin remote 解析」 | 文档同步 |
  | `scripts/verify-pr-loop.js` | **新建**（约 300 行，六阶段前置检查） | 新增验证基建 |
  | `test/mastra/github-adapter.test.ts` | 新增 7 条 `parseOwnerRepo` 用例；`BASE_ENV` 补 `CODING_REPO_ROOT` 的恢复 | 回归锁 |

- **核心改动的三个细节（都是「不做就会踩」级别）**
  1. **为什么必须把 `repoRoot()` 放进 `try` 里**：若写成默认参数 `parseOwnerRepo(cwd = repoRoot())`，
     `repoRoot()` 会在**实参求值时**抛错（`CODING_REPO_ROOT` 目录不存在 / 不是 git 仓库），
     **逃逸出函数体、绕过内部 `catch`** → 把「解析不出 owner/repo」这种可降级情况放大成「整条流程崩」。
     正确写法是 `const root = cwd ?? repoRoot();` 放在 try 内。已加专门用例锁住（`指向不存在目录 → null`）。
  2. **导出 `parseOwnerRepo` 是为了做实测反证**，不是为外部调用。验证脚本用它打印「修复前/修复后」两个值对照，
     避免「改完了但没人能证明改对了」。
  3. **不改 `X-GitHub-Api-Version` / 请求头等无关面**，本次只动 cwd 这一个变量 —— 一次只改一个根因。

- **本轮核实的既有事实**
  - 本机 `pr-agent` 的 `origin` = `git@github.com:wintim1143/pr-agent.git` → 原实现恒返回 `{owner:'wintim1143', repo:'pr-agent'}`（bug 已实证）
  - 靶场 `D:\code\pr-agent-e2e`：`main @ b17e66b`、工作区干净、`origin = https://github.com/wintim1143/pr-agent-e2e.git`
  - token 两个写权限探针仍均 **422**（`contents=write` / `pull_requests=write`）—— M3-1 的结论在本轮复验后依然成立

- **三层验证**
  | 层 | 手段 | 结果 |
  |---|---|---|
  | 编译 | `node ./node_modules/mwtsc/bin/mwtsc.js --cleanOutDir` | ✅ rc=0 |
  | 单测 | `node ./node_modules/jest/bin/jest.js` 全量 | ✅ **97/97**（原 90 + 新增 7） |
  | 实跑 | `node scripts/verify-pr-loop.js` | ✅ 六阶段全绿，**5.7s**；身份反证输出 `pr-agent-e2e` ✅（对照值 `pr-agent` = 修复前） |

- **踩坑 / 设计取舍**
  - **`--reset` 只清本地、不删远端分支**（本轮刻意不做）：远端清理属 M3-7 的职责，
    且「删远端分支」是破坏性动作，不该混进一个跑在前置检查里的开关
  - **`--reset` 刻意不加 `git clean -fd`**：untracked 文件可能是有意留下的产物，静默删除风险高于收益。
    发现工作区脏时改为**列出全部文件 + 提示人工确认**，由人决定丢还是留
  - **脚本侧独立实现了一份 `parseRemoteUrl()`** 用于与项目实现交叉核对，不复用 `parseOwnerRepo()` ——
    避免「用被测对象验证被测对象」这种自证循环

- **待确认 / 下一步**
  - ⬜ **M3-3**：`githubPushAndOpenPR` 的 `git push`（`adapters/github.ts:448`）**尚未注入代理**
    → 本机直连 `github.com` 不通，直接跑必挂。需加 `-c http.proxy=${process.env.GIT_PROXY}`，同时把
    「工作树脏则兜底补提交」（`:434`）改为显式报错（否则 commit 闸门失败会被静默绕过）
  - ⬜ `--run` 分支目前显式 `exit(3)`，待 M3-3 接通 workflow 后启用
  - ⬜ 本轮改动**未提交**（等用户指令）

---

### 2026-09-15 · M3-3 push-open-pr 真跑打通 ✅（真写远端 · 3/3 通过）

- **本节一句话**：**第一次真的把分支推到远端、真的开出了 PR，并且真的停在了人工关卡上。**
  PR #1 · `https://github.com/wintim1143/pr-agent-e2e/pull/1`。`runId = 9bfc3dc3-e228-4b99-9c26-ef8c074c8ca6`

- **改了哪些文件**
  | 文件 | 改动 | 性质 |
  |---|---|---|
  | `src/mastra/adapters/github.ts` | `git push` 加 `-c http.proxy=$GIT_PROXY` 调用点注入 | **重点模块** |
  | `src/mastra/adapters/github.ts` | 移除「工作树脏则兜底补提交」→ 返回 `dirty-worktree`；删掉因此失效的 `commitMessage` 入参 | **行为变更** |
  | `src/mastra/workflows/dev-workflow.ts` | push-open-pr 步 `res.error` 从「仅告警」改为 `throw` | **行为变更** |
  | `scripts/verify-pr-loop.js` | 实现 `--run`（完整八步 + AC-1/2/4 判定）；新增 `--clean-remote` | 验证基建 |
  | `test/mastra/github-adapter.test.ts` | 新增 2 条 dirty-worktree 用例；`makeRepo` 提到模块层级共用 | 行为变更锁 |

- **本轮核实的既有事实**
  - 代理注入实测生效：`push-open-pr` 步 **12.2s 完成**。若未走代理，本机直连 `github.com` 会先 **21s 超时**再失败 ——
    所以「12.2s 成功」本身就是判据，比事后查配置更直接
  - 三闸门**零重试**（全 attempt=1），且 test 的判定文本里出现 `+7 行`、```` ```bash ```` 代码块、
    真实 clone URL —— 再次证明 M2 收尾时补的「喂 diff」持续有效，闸门不是盲评
  - `openPrForBranch` 的「已有 open PR 则复用」逻辑本轮未触发（靶场当时无 PR），属未覆盖面

- **踩坑 / 设计取舍**
  - **adapter 不给代理缺省值**：缺省 `7890` 留在脚本里。理由是「代理是某台机器在某段时间的网络现状，不是项目属性」——
    写进 adapter 等于把本机网络拓扑固化进产品代码，换机器即失效还需改源码
  - **adapter 仍不抛、由编排层 throw**：刻意保留。「如实报告」与「是否阻断流程」是两件事，
    这样 adapter 在「只查状态、不希望抛错」的场景仍可复用
  - **`--clean-remote` 顺序：先关 PR 再删分支**。反了会让 PR 落进「head 分支已被删除」的悬空状态，
    GitHub 不会自动关它 —— 会一直作为噪音挂在 open 列表里
  - **`--reset` 与远端清理刻意分开**：本地清理是幂等的低风险动作，远端清理是破坏性的。
    合成一个开关会让「只想清本地」的人意外删掉远端分支；代价是重跑前要记得多敲一个参数（已在脚本头显式警示）
  - **造脏工作树必须 `git add`**：`isDirty()` 查 `git diff --cached` / `git diff`，
    **未跟踪文件不算脏** —— 写文件不 add 造不出脏工作树，这条第一版写测试时踩了

- **三层验证**
  | 层 | 手段 | 结果 |
  |---|---|---|
  | 编译 | `node ./node_modules/mwtsc/bin/mwtsc.js --cleanOutDir` | ✅ rc=0 |
  | 单测 | `node ./node_modules/jest/bin/jest.js` 全量 | ✅ **99/99**（M3-2 后 97 + 本轮 2） |
  | 实跑 | `node scripts/verify-pr-loop.js --run` | ✅ **3/3**（AC-1 远端分支 / AC-2 PR 已开 / AC-4 停在关卡），116s |

- **观察到的环境细节**
  - `git push` 网络操作期间，git 会在 Windows 上调 `reg.exe` 读系统代理设置 → 被沙箱 **Program Blacklist 拦截**。
    该拦截**不影响结果**（本轮 push 成功），因为我们已经用 `-c http.proxy=` 显式给了代理。
    但排查时若看到这条 block 消息，不要误判为 push 失败原因
  - 这也解释了此前「网络 git 仍弹授权」的观感：走的是网络层管控 + reg.exe 读取，与 `sandbox.versionControl` 无关

- **待确认 / 下一步**
  - ⬜ **M3-4**：`notify` 步实跑返回 `mode=app`（推送成功），但「飞书群里确实收到卡片」属人工验收，需人工确认
  - ⬜ **M3-5（最高风险项）**：用 `runId=9bfc3dc3…` 调 `resume({approved:false})` / `resume({approved:true})`
    验证关卡语义。⚠️ **本轮 run 已停在 suspended 且 PR 保持 open，正好可作 M3-5 的起点 —— 别提前 `--clean-remote`**
  - ⬜ **M3-6**：红线扩展到远端维度（禁 force push / 禁推 base）
  - ⬜ **M3-8**：`request-changes` 后不再 commit 的条件边
  - ⬜ 本轮改动**未提交**（等用户指令）

---

### 2026-09-15 · M3-4 ~ M3-8 收口 ✅（M3 八项全部完成）

**执行顺序**：先改行为（零外部动作）→ 再跑真实验证（含不可逆动作为最后）→ 最后收口。
即 **M3-8 → M3-6 → M3-4 → M3-5 → M3-7**。
好处：等走到「真写远端」那一步时，代码已经是最终形态 —— 一次跑批就能同时覆盖多条 AC。

#### 本轮最重要的一条结论：`branch` 条件边**被实测否决**

详见 §7 M3-8。这里只留教训：

> **把「文档/类型说可以这么做」与「运行时会这么发生」分开验证。**
> `.branch()` 的 API 存在、类型也能编译通过，但运行时语义与设想**完全相反**
> （多条件不互斥 + 分支后 inputData 变聚合对象）。
> 花在 `.tmp/branch-probe*.js` 上的两次实验（约 10 分钟）省下的是一次**错误的架构改造**。

#### 执行记录（时间正序）

| 时刻 | 动作 | 结果 |
|---|---|---|
| 15:46 | M3-8 + M3-6 + M3-4 改完，编译 + 全量单测 | ✅ 137/137（原 99 + guard 新增 38） |
| 15:48 | **跨进程探针**：对 M3-3 遗留的 suspended run 调 `resume({approved:false})` | ✅ 上下文完整恢复（prNumber/branch/test/review/commit 全在）→ **M3 最高风险项提前解除** |
| 15:49 | 前置检查（默认模式） | ✅ 六段全绿，1.5s |
| 15:51 | `--run`（issue #2） | ✅ 3/3；PR **#2**；runId `d5a53a0a…`；飞书 `mode=app` |
| 15:51 | `--resume-deny d5a53a0a…`（**独立进程**） | ✅ 3/3；PR #2 保持 open；main 未变 |
| 15:58 | `--run`（issue #3） | ✅ 3/3；PR **#3**；runId `1a670d74…` |
| 15:59 | `--resume-approve 1a670d74…`（**独立进程**） | ✅ 3/3；**PR #3 真合并**；main `b17e66b → e2d1ee7` |
| 16:00 | `--gate-negative`（首跑） | 🟡 2/3：闸门已生效，但「无 commit」判据写错（把 checkout 切分支误判成 commit） |
| 16:04 | 修判据 + 加 `guard:deny` 埋点后重跑 | ✅ 4/4 |
| 16:08 | 加 AC-9 判定后重跑 | ✅ **5/5**；`guard:deny` **4 条**（Edit / Write 两种途径都被拦） |

#### 改动清单（本轮累计）

| 文件 | 改动 |
|---|---|
| `workflows/dev-workflow.ts` | ① test/review 判负 → 显式 `throw` 终止（M3-8）；② `ContextSchema` 加 `prUrl`；③ merge 步**三态语义**（拒绝即终止）；④ 注释写清 branch 实测结论 |
| `agents/guard.ts` | 远端维度 6 条新规则 + 动态 `protectedBranches`（**只增不减**）+ 修「分支名嵌 main 被误拦」 |
| `agents/coding-agent.ts` | `resolveProtectedBranchNames()`；`makeGuardHook` 加参；deny 分支加 `guard:deny` 埋点 |
| `progress.ts` | 新增事件类型 `guard:deny` |
| `adapters/feishu.ts` | 卡片渲染 PR 链接；文案改为「按钮当前点击无效」 |
| `test/mastra/guard.test.ts` | +38 条（新红线 18 deny / 不得误拦 12 allow / 动态注入与只增不减 8） |
| `scripts/verify-pr-loop.js` | +`--resume-approve` / `--resume-deny` / `--gate-negative` / AC-9 判定；issue 可 env 覆盖 |

#### 三个自己踩的坑（都已写进代码注释）

1. **`branch` 语义假设错误** —— 见上。
2. **「HEAD sha 变没变」≠「有没有 commit」**：checkout 会把 HEAD 从上一轮分支切到
   「从 base 新建的分支」，sha 必然变化（实测 `42b313a(feat/3) → b17e66b(新分支)` 被误判为产生了 commit）。
   改用「**领先 base 的提交数 = 0**」+「本地 base 未移动」。
3. **改函数签名漏改调用点**：`judgeGateNegative` 加了 `baseLocalBefore` 参数却**没更新调用处**
   → 函数内是 `undefined` → 比较恒 false → **报出一条并不存在的失败**。
   这是「静默失真」的典型：报告说有问题、实际没问题，**方向恰好相反**。
   已加内部告警（`if (!baseLocalBefore) log('⚠️ …调用方漏传?')`）。

#### 遗留 / 待人工

- ⚠️ **AC-7 需人工去飞书群确认** —— 脚本能证明的极限是「推送调用返回成功」
- ⬜ **AC-6 的 Merged 标记建议人工去 GitHub 看一眼**：<https://github.com/wintim1143/pr-agent-e2e/pull/3>
- ⬜ **远端清理未做**：PR #1 / #2 仍 open，远端 `feat/1-*`、`feat/2-*`、`feat/3-*` 分支仍在。
  清理命令 `node scripts/verify-pr-loop.js --clean-remote`
  —— **故意没自动跑**：PR #1/#2 是 AC-5 的证据载体，先留着让人看过再清
- ✅ **遗留项已移交 M4**（2026-09-15 建卡时归档）：
  P0-2 `runGate` 盲重试 → **M4-6**；P2-5 AC-7 证据串误导 → **M4-7**
  —— 见 [`M4-真质量闸门.md`](./M4-真质量闸门.md) §7

#### 📌 修订说明（2026-09-16 补记，不改上文历史记录）

本卡 §3 / §7 多处写着「**不接飞书 inbound / 卡片按钮回调 —— 那是 M5**」（`:30` / `:72` / `:315` / `:544`），
`-flow.md:60` / `:86` / `:184` 也标注「按钮回调属 M5」。

⚠️ **该承诺未被 M5 承接** —— M5 做的是**另一条 inbound 通路**（群消息**轮询**，
用于**创建** run + 幂等去重），而按钮回调是**事件推送**（长连接 / 回调服务器，用于**唤醒**挂起的 run）。
两者形态与作用对象都不同，因此这个承诺**静默漂过了 M5**。

→ **现已定性移交 [`M8-飞书双向控制.md`](./M8-飞书双向控制.md)**（2026-09-16 建卡、2026-09-17 由原 M7 重切而来）；
完整来龙去脉见该卡卷首「无主债务收口」块；教训已升格为 `README.md` 全局原则 9「**「不做项」不许悬空**」。

📌 本卡 `:315` 那条「卡片文案改为『按钮当前点击无效；请人工确认后执行 resume』」是**正确且必要**的 ——
它如实反映了当时的状态；M8 落地后才应改回「点按钮即可合并」。
