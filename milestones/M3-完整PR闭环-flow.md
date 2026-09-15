# M3 · 完整 PR 闭环 —— 数据流向图

> 配套卡片：[`M3-完整PR闭环.md`](./M3-完整PR闭环.md)
> 本图重点画三件事：**suspend/resume 跨请求断点**（M2 完全没有、M1 有）、**人工闸门的位置**、**远端写入路径与红线拦截点**。
> 与 M2 的关键差异：**虚线不再是「M3 才走」而是实线**；`stopAfterCommit` 不再传，八步全跑。

---

## 1 总览：M3 的数据流向

```mermaid
flowchart TB
    subgraph TRIGGER["触发层"]
        V["scripts/verify-pr-loop.js<br/>构造 issue 形状入参"]
        ENV["env 硬设:<br/>CODING_REPO_ROOT = D:\\code\\pr-agent-e2e<br/>GITHUB_OWNER/REPO/BASE_BRANCH"]
        RES["外部 resume 调用<br/>(HTTP /api/workflows/.../resume)"]
    end

    subgraph ORCH["编排层 dev-workflow(八步全跑)"]
        C1["1. checkout<br/>建 feat/&lt;n&gt;-&lt;slug&gt;"]
        C2["2. coding<br/>ClaudeSDKAgent"]
        C3["3. test 闸门"]
        C4["4. review 闸门"]
        C5["5. commit<br/>真 git commit"]
        C6["6. push-open-pr<br/>★真写远端①"]
        C7["7. notify<br/>飞书卡片"]
        C8["8. merge<br/>⏸ suspend"]
        C9["8'. merge 执行<br/>★真写远端②"]
    end

    subgraph STORE["持久化"]
        DB[("LibSQLStore<br/>mastra.db<br/>mastra_workflow_snapshot")]
    end

    subgraph GUARD["围栏 guard.ts(PreToolUse hook)"]
        G{"guardToolCall()"}
        GD["✗ deny<br/>含禁 force push / 禁推 base"]
        GA["✓ allow"]
    end

    subgraph EXT["外部系统"]
        CLI["Claude Code CLI 子进程"]
        LOCAL["靶场本地 clone<br/>D:\\code\\pr-agent-e2e"]
        GH["GitHub 远端<br/>靶场仓库(名字见 M3 卡头部)"]
        FS["飞书群"]
        HUMAN["👤 用户<br/>看卡片 + 决定是否合并"]
    end

    V --> C1
    ENV -.->|定位目标仓库| C1
    C1 --> C2 --> C3 --> C4 --> C5 --> C6 --> C7 --> C8
    C8 -.->|"suspend: 落库并返回<br/>（本次请求结束）"| DB
    HUMAN -->|"approve"| RES
    RES -->|"resume({approved:true})<br/>（另一次请求，上下文从 DB 恢复）"| DB
    DB --> C9

    C6 -->|"git push + REST POST /pulls"| GH
    C9 -->|"REST PUT /pulls/n/merge (squash)"| GH
    C7 --> FS
    FS -.->|"M5: 按钮回调<br/>（M3 不可用）"| HUMAN

    C2 --> CLI
    CLI --> G
    G -->|命中红线| GD
    G -->|未命中| GA
    GA --> LOCAL
    GD -.->|拒绝，不落盘| CLI

    C1 --> LOCAL
    C5 --> LOCAL

    style C6 fill:#ffcccc,stroke:#b85450,stroke-width:2px
    style C9 fill:#ffcccc,stroke:#b85450,stroke-width:2px
    style C8 fill:#ffe6cc,stroke:#d79b00,stroke-width:2px
    style DB fill:#dae8fc,stroke:#6c8ebf,stroke-width:2px
    style GD fill:#f8cecc,stroke:#b85450
    style GA fill:#d5e8d4,stroke:#82b366
    style GH fill:#e1d5e7,stroke:#9673a6,stroke-width:2px
```

**读图要点**

- **★ 两个红色节点是「不可逆写入」**：① 开 PR（可关闭，代价低）② squash merge（**base 分支多一个 commit，这才是真正不可逆的**）。M3 的全部设计都围绕「② 之前必须有人点头」
- **蓝框是 M3 首次启用的机制**：`suspend` 时把 workflow 快照落库，本次 HTTP 请求就结束了；人工 approve 后是**另一次请求**，上下文必须从库里恢复。M2 因为 `stopAfterCommit=true` 在 suspend **之前**就 return，这条链路**从未被执行过** —— 这是 M3 最高风险项
- **橙色是人工闸门**：位置在 merge 步的最前面，`suspend` 之前不做任何副作用
- **飞书卡片是「单向通知」**：M3 只推不收。卡片上的按钮点击会因缺少 inbound 而无效（M5），故卡片文案必须如实说明

---

## 2 时序：一次 M3 运行（含跨请求断点）

```mermaid
sequenceDiagram
    autonumber
    participant V as 验证脚本
    participant W as dev-workflow
    participant DB as LibSQLStore
    participant G as 靶场 clone(git)
    participant GH as GitHub REST
    participant F as 飞书
    participant U as 👤 用户

    Note over V,W: ── 请求 1：编码 → 开 PR ──
    V->>W: start({ issueNumber, issueTitle, issueBody })<br/>（不传 stopAfterCommit）
    W->>G: checkout 建 feat/1-...
    W->>G: coding(ClaudeSDKAgent 真改文件)
    W->>W: test / review / commit 三闸门
    W->>G: git add -A && git commit
    W->>GH: git push（token 内嵌 HTTPS）
    W->>GH: POST /pulls
    GH-->>W: { number: 1, html_url }
    W->>F: 推「开发完成」卡片
    F-->>U: 群里看到卡片（含 PR 链接）

    W->>W: merge 步进入 → 先判 resumeData
    W->>DB: suspend({ waitingFor: 'merge-approval' })  落库
    Note over W,V: status = suspended<br/>请求 1 结束（进程可退出）

    Note over U: 用户去 GitHub 看 PR 内容，决定是否合并<br/>（此步可无限期，也可拒绝）

    Note over U,V: ── 请求 2：人工确认 ──
    U->>V: 决定合并
    V->>W: resume(runId, { approved: true })
    W->>DB: 读取快照，恢复上下文
    DB-->>W: prNumber=1, branch=feat/1-...
    W->>GH: PUT /pulls/1/merge (merge_method=squash)
    GH-->>W: { merged: true, sha }
    W-->>V: mergeResult = merge-ok

    Note over GH: base 分支新增一个 squash commit ★不可逆
```

**读图要点**

- **两条竖线之间的 `Note` 就是「跨请求断点」**：请求 1 结束后进程可以退出，请求 2 带着 runId 回来。这要求 workflow 上下文可序列化 —— 这正是 `ContextSchema` 里所有字段都是简单类型（string / number / 嵌套的小对象）的原因，**不要往里面塞大对象或函数**
- **「先判 resumeData，再 suspend」的顺序不能反**：若先 suspend 再判，人工 approve 后恢复时又会走到 suspend，形成**永远点不掉的挂起**
- **拒绝也是一条合法路径**：`resume({approved:false})` 时不应执行 merge，PR 保持 open 留给人工处理（AC-5）

---

## 3 红线：M3 在远端维度上加了什么

```mermaid
flowchart LR
    IN["PreToolUse hook 入参<br/>{ tool_name, tool_input }"] --> T{工具类型}

    T -->|Write / Edit 类| P["normalizeRepoPath()"]
    P --> OUT{"落在仓库外?"}
    OUT -->|是| D1["deny：越界写入"]
    OUT -->|否| PROT{"命中 PROTECTED_PATHS?"}
    PROT -->|是| D2["deny：受保护路径"]
    PROT -->|否| OK["allow"]

    T -->|Bash| CMD{"命中 DANGEROUS_COMMANDS?"}
    CMD -->|"M2 已有：<br/>push -f / push main / reset --hard<br/>clean -f / rm -rf / checkout main<br/>branch -D / 写 .git/ / sudo / curl|sh"| D3["deny：危险命令"]
    CMD -->|"M3 新增关注：<br/>force push 变体（--force-with-lease）<br/>直推 base 分支（HEAD:main）<br/>改远端默认分支（push origin :main）"| D6["deny：远端红线"]
    CMD -->|否| RED{"重定向写入受保护路径?"}
    RED -->|是| D4["deny：shell 绕过"]
    RED -->|否| OK

    T -->|Read / Glob / Grep 等| OK
    ERR["hook 自身异常"] --> D5["deny：fail-closed"]

    style D1 fill:#f8cecc,stroke:#b85450
    style D2 fill:#f8cecc,stroke:#b85450
    style D3 fill:#f8cecc,stroke:#b85450
    style D4 fill:#f8cecc,stroke:#b85450
    style D5 fill:#f8cecc,stroke:#b85450
    style D6 fill:#ffcccc,stroke:#b85450,stroke-width:2px
    style OK fill:#d5e8d4,stroke:#82b366
```

**为什么远端红线在 M3 才成为重点**：M2 的沙箱仓库**没有 remote**，`git push` 物理上不可能成功 —— 危险命令表里的 `push -f` 拦不拦得住，**没有真实后果可验证**。M3 接上真远端后，「推错分支 / 强推覆盖历史」第一次成为**会造成真实损失**的操作（AC-8 由此升级为必需项）。

---

## 4 与 M1 / M2 的边界对比

| | M1（已完成） | M2（已完成） | **M3（本卡）** |
|---|---|---|---|
| 入口 | 飞书 / HTTP | 脚本构造入参 | **脚本构造入参**（inbound 仍缺，M5） |
| 写目标仓库 | 否（只读 REST） | 仅本地分支 | **push + 开 PR + merge** |
| 运行时闸门 | suspend 在 confirm | **无**（跑完人工看） | **suspend 在 merge** |
| 人工闸门位置 | 编排层 | 里程碑层 | **编排层** |
| 远端接触 | 只读 API | **零** | 写（push / PR / merge） |
| 跨请求恢复 | ✅ 已验证 | ❌ 未走（被截断跳过） | **✅ 本里程碑首次验证** |
| 不可逆操作 | 无 | 无 | **squash merge** |
| 本图新增关注点 | suspend/resume | guard 拦截点 + 零远端边界 | **跨请求断点 + 人工闸门 + 远端红线** |
