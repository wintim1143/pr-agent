# M3 · 完整 PR 闭环（Full PR Loop）

状态：**待开始**
创建日期：2026-09-15
**D4 目标仓库（已定）：`wintim1143/pr-agent-e2e`**（用户创建的专用靶场仓库，零污染）

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

**给定一条 issue 形状的入参，dev-workflow 在带远端的靶场仓库 `wintim1143/pr-agent-e2e` 里真建分支 → 真编码 → 过三闸门 → 真 commit → 真 push → 真开 PR → 推飞书卡片 → 挂起等人工确认 → 确认后 squash merge；全程 pr-agent 自身不被触碰。**

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

跑完 `node scripts/verify-pr-loop.js` 并完成人工确认后，在 **GitHub 网页** `wintim1143/pr-agent-e2e` 上能看到：

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

### M3-1 靶场仓库就绪 + GitHub 写权限验证（硬前置）
- 内容：确认 `wintim1143/pr-agent-e2e` 已创建（空仓或仅有 README）；验证 `GITHUB_TOKEN` 的 **Pull requests: write + Contents: write** 权限真的够（此前从未验证过）。最小验证：直接调 REST 建一个 draft PR 再关掉，或 `git push` 一个空分支再删
- 验收：`POST /repos/{o}/{r}/pulls` 返回 201 而非 403/422；`git push` 成功
- ⚠️ 若 token 权限不足 → **立刻停下**，这是 M3 的唯一硬阻塞

### M3-2 目标仓库切换
- 内容：`scripts/verify-pr-loop.js` 里硬设 `CODING_REPO_ROOT` 指向靶场仓库的**本地 clone**（建议 `D:\code\pr-agent-e2e`），并设 `GITHUB_OWNER=wintim1143` / `GITHUB_REPO=pr-agent-e2e` / `GITHUB_BASE_BRANCH=main`。**不依赖外部 shell 环境**（与 M2 同一安全模式）
- 验收：脚本打印的目标仓库与远端配置正确；前置检查能识别「本地 clone 存在 / 有 remote / 工作区干净」

### M3-3 push-open-pr 真跑打通
- 内容：跑通 `git push`（token 内嵌 HTTPS）+ REST 开 PR；处理已存在 PR 的复用分支
- 验收：远端出现 `feat/<n>-<slug>` 分支；REST 返回 PR number + html_url
- 注意：现有实现里 `githubPushAndOpenPR` 有「工作树脏则兜底补提交」逻辑 —— 需确认它在 M3 下不会掩盖 commit 步的失败（**兜底提交应当降级为显式报错**，否则 commit 闸门失败会被静默绕过）

### M3-4 notify 真推飞书卡片
- 内容：`buildDevCompleteCard` 补上真实 PR 链接；卡片文案与「按钮回调不可用」的现状一致（避免误导用户去点无效按钮）
- 验收：飞书群收到卡片；`feishuNotify` 返回 `ok:true`

### M3-5 merge 人工关卡（核心）
- 内容：`suspend({waitingFor:'merge-approval'})` → 验证 `status=suspended` → 外部 `resume({approved:true})` → REST squash merge。**同时验证 resume 后上下文未丢**（能拿到 `prNumber` / `branch` 等字段）
- 验收：① 未 resume 时 run 停在 suspended；② `resume({approved:false})` 时**不合并**、PR 保持 open；③ `resume({approved:true})` 后 PR `merged=true`、base 分支出现 squash commit
- ⚠️ **M2 从未验证过 dev-workflow 的 suspend/resume** —— 这是 M3 风险最高的一项，建议单独先跑通再合进端到端

### M3-6 红线扩展到远端维度
- 内容：把「禁 force push / 禁直推 base / 禁改远端默认分支」纳入 `guard.ts` 的危险命令表（若已有则补单测），并端到端验证一次
- 验收：红线单测全绿；端到端跑一次 `--redline` 类场景，deny 日志出现且远端未受影响

### M3-7 端到端验证脚本 + AC 矩阵回填
- 内容：`scripts/verify-pr-loop.js`：前置检查（靶场就绪 / 工作区干净 / token 有写权限）→ 跑 workflow 到 suspend → 自动 resume → 逐条打印 AC 判定。证据落 `logs/m3-verify.log`
- 验收：脚本可重复运行；AC-1~AC-9 全部有可判定输出

### M3-8 吸收 M2 遗留②：`request-changes` 后不再 commit
- 内容：当前 `test` / `review` 步判负后，流程**仍会继续走 commit**（代码里是 TODO，条件边未实现）。M3 起 commit 会被 push 到远端，误判代价升高 → 应实现「判负则终止（或回退 coding）」的条件边
- 验收：构造一个 review 必判 `request-changes` 的场景，验证**没有 commit、没有 push**（而非「commit 了但没人看」）
- 📌 若本轮只做「终止」不做「回退重做」，需在卡里写清这是有意为之的一半（回退涉及循环/次数上限，成本高）

---

## 8. 验收清单（AC）🟨

> 定义期先列预期判据，实施到对应阶段再按实际端点 / 字段校准。
> **验证方式列是强制的**：写清「由哪个脚本 / 手工动作判定，证据落在哪个文件」。

| # | 验收项 | 判据 | 验证方式 · 证据位置 |
|---|---|---|---|
| AC-1 | feature 分支真推到远端 | `git ls-remote origin feat/<n>-<slug>` 有输出 | `verify-pr-loop.js` 打印；证据 `logs/m3-verify.log` |
| AC-2 | PR 真开 | REST 返回 `number` + `html_url`；网页可见，状态 open | 脚本打印 + **人工去 GitHub 看** |
| AC-3 | PR 内容正确 | `head` = feature 分支、`base` = main、body 含 test/review 结论 | REST 查询 + 人工看 PR 描述 |
| AC-4 | merge 关卡真挂起 | run `status = suspended`、`waitingFor = merge-approval`；此时 PR **仍 open** | 脚本打印 + `GET /api/workflows/dev-workflow/runs/<id>` |
| AC-5 | 未批准不合并 | `resume({approved:false})` 后 PR 保持 open、base 分支 sha 未变 | 脚本打印 + 人工核对 |
| AC-6 | 批准后真 merge | `resume({approved:true})` 后 PR `state=closed` / `merged=true`；base 分支出现 squash commit | REST 查询 + **人工去 GitHub 看 Merged 标记** |
| AC-7 | 飞书卡片真推送 | 群里收到卡片；`feishuNotify` 返回 `ok:true` | **人工去飞书群看** + 脚本打印 |
| AC-8 | 红线（远端维度） | `git push --force` / 直推 base → `deny` | 单测 + 端到端；日志含 `[permission-guard] deny` |
| AC-9 | pr-agent 工作树未被触碰 | 运行前后 `git status --short` 一致、无新增分支 | 脚本打印快照对比 |

> **AC-4/5 是本里程碑的核心价值**：它们验证的不是「能不能合并」，而是「**不该合并的时候合不了**」。这两条不过，自动开发就不该被允许接触任何真实业务仓库。

---

## 9. 解锁与复用 🟨

- **复用自 M2**（已回填至 [`M2-本地写入闭环.md`](./M2-本地写入闭环.md) §9）：`CODING_REPO_ROOT` 配置口子、已实证的 `guard.ts` 围栏、`stopAfterCommit` 编排开关（M3 不传即恢复完整八步）、验证脚本骨架（`verify-local-write.js` → `verify-pr-loop.js`）
- **本里程碑预期解锁**（供 M4）：
  - 一条真实 PR 作为载体 → M4 可以把「真跑的测试结果」挂在这条 PR 上
  - suspend/resume 在 dev-workflow 上已被验证 → M4/M5 可以放心在前置步骤加更多人工关卡
  - 远端红线（禁 force push / 禁推 base）已验证 → M5 的多仓库才敢放开第二个仓库
- **实际复用**：<M4 建卡后回填>

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
