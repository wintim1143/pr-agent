# M3 · 完整 PR 闭环（Full PR Loop）

状态：**待开始**（✅ M3-1 已通过：靶场就绪 + 写权限实测通过 + 真实 push 成功）
创建日期：2026-09-15
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

### M3-2 目标仓库切换
- 内容：`scripts/verify-pr-loop.js` 里硬设 `CODING_REPO_ROOT` 指向靶场仓库的**本地 clone**（**已就绪：`D:\code\pr-agent-e2e`**），并设 `GITHUB_OWNER=wintim1143` / `GITHUB_REPO=pr-agent-e2e` / `GITHUB_BASE_BRANCH=main`。**不依赖外部 shell 环境**（与 M2 同一安全模式）
- 验收：脚本打印的目标仓库与远端配置正确；前置检查能识别「本地 clone 存在 / 有 remote / 工作区干净」
- ⚠️ **`GITHUB_OWNER` / `GITHUB_REPO` 必须显式设置，不能靠自动解析**（2026-09-15 读码发现）：
  `getGithubConfig()`（`adapters/github.ts:108`）的逻辑是「env 优先，留空则从 `git remote get-url origin` 解析」，
  而 `parseOwnerRepo()`（`:83`）**执行 `git remote get-url origin` 时未指定 cwd** → 用的是**进程工作目录**，
  即 `pr-agent` 自己 → 解析出 `wintim1143/pr-agent`。
  后果是「**push 到靶场 clone，PR 却开到 pr-agent 身上**」这种错位（push 走 `repoRoot()`=`CODING_REPO_ROOT`，
  owner/repo 却来自进程 cwd）。**M3 起会真写远端，这个错位是不可接受的**。
  → 两条一起做：① M3-2 硬设三个 env；② 把 `parseOwnerRepo()` 改为基于 `repoRoot()`（消除 cwd 隐式依赖）。
- 注意：`.env` 里当前**只有 `GITHUB_TOKEN`**，没有 owner/repo —— 所以上述显式设置是必需的，不是可选优化
- ⚠️ **git 调用需在调用点注入代理**（见 M3-3）：`CODING_REPO_ROOT` 的那份 clone 要能被 push，而本机直连 `github.com` 不通。
  **不写任何持久化代理配置**，由脚本每次调用加 `-c http.proxy=<GIT_PROXY>`

### M3-3 push-open-pr 真跑打通
- 内容：跑通 `git push`（token 内嵌 HTTPS）+ REST 开 PR；处理已存在 PR 的复用分支
- 验收：远端出现 `feat/<n>-<slug>` 分支；REST 返回 PR number + html_url
- 注意：现有实现里 `githubPushAndOpenPR` 有「工作树脏则兜底补提交」逻辑 —— 需确认它在 M3 下不会掩盖 commit 步的失败（**兜底提交应当降级为显式报错**，否则 commit 闸门失败会被静默绕过）
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
  - ⬜ 下一步：M3-2 目标仓库切换（显式设 `GITHUB_OWNER`/`GITHUB_REPO` + 修 `parseOwnerRepo()` 的 cwd 隐式依赖）
