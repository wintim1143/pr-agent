# M2 · 本地写入闭环 —— 数据流向图

> 配套卡片：[`M2-本地写入闭环.md`](./M2-本地写入闭环.md)
> 本图重点画三件事：**触发 → 编排 → 集成 → 外部系统**的数据走向、**guard 拦截点**、**零远端边界**。
> M2 **没有 suspend/resume 断点**（运行时无闸门），这是与 M1/M3 的关键差异，图里显式标注。

---

## 7.1 总览：M2 范围内的数据流向

```mermaid
flowchart TB
    subgraph TRIGGER["触发层"]
        V["scripts/verify-local-write.js<br/>构造 issue 形状入参<br/>{ issueNumber, issueTitle, issueBody }"]
        ENV["env: CODING_REPO_ROOT<br/>= D:\\code\\pr-agent-sandbox"]
    end

    subgraph ORCH["编排层 dev-workflow"]
        C1["1. checkout<br/>建 feat/&lt;n&gt;-&lt;slug&gt;"]
        C2["2. coding<br/>ClaudeSDKAgent"]
        C3["3. test 闸门<br/>LLM 自评 → zod"]
        C4["4. review 闸门<br/>LLM 自评 → zod"]
        C5["5. commit 闸门<br/>+ 真 git commit"]
        CUT{{"stopAfterCommit = true<br/>✂ 截断"}}
        C6["6. push-open-pr<br/>（M2 不执行）"]
        C7["7. notify<br/>（M2 不执行）"]
        C8["8. merge suspend<br/>（M2 不执行）"]
    end

    subgraph GUARD["围栏 guard.ts（PreToolUse hook）"]
        G{"guardToolCall()"}
        GD["✗ deny<br/>受保护路径 / 危险命令 / 越界"]
        GA["✓ allow"]
    end

    subgraph EXT["外部系统"]
        CLI["Claude Code CLI 子进程<br/>（经 cc-switch 代理 127.0.0.1:15721）"]
        SANDBOX["沙箱仓库<br/>D:\\code\\pr-agent-sandbox<br/>feature 分支 + commit"]
        REMOTE["GitHub 远端<br/>❌ M2 零接触"]
    end

    V --> C1
    ENV -.->|定位目标仓库| C1
    C1 --> C2 --> C3 --> C4 --> C5 --> CUT
    CUT -.->|false 时（M3）| C6 --> C7 --> C8
    C8 -.->|M3 人工 approve| REMOTE
    C6 -.->|M3 push + 开 PR| REMOTE

    C2 --> CLI
    CLI --> G
    G -->|命中红线| GD
    G -->|未命中| GA
    GA --> SANDBOX
    GD -.->|拒绝，不落盘| CLI

    C1 --> SANDBOX
    C5 --> SANDBOX

    style CUT fill:#ffe6cc,stroke:#d79b00,stroke-width:2px
    style GD fill:#f8cecc,stroke:#b85450
    style GA fill:#d5e8d4,stroke:#82b366
    style REMOTE fill:#f5f5f5,stroke:#999,stroke-dasharray: 5 5
```

**读图要点**

- **✂ 截断点是 M2 的核心编排改动**：`devWorkflow` 目前是 `.then()` 八步全串，不加截断就会真 push 或卡在 merge 的 suspend 上（M2-3）
- **guard 挂在 CLI 子进程内部**，不在 workflow 层 —— 它是唯一能拦住每一次工具调用的点（bypassPermissions 下 `canUseTool` 不生效）
- **虚线 = M3 才走的路径**，M2 全部不执行

---

## 7.2 时序：一次 M2 运行（含红线拦截时序）

```mermaid
sequenceDiagram
    autonumber
    participant V as 验证脚本
    participant W as dev-workflow
    participant A as ClaudeSDKAgent
    participant H as guard hook
    participant G as 沙箱仓库(git)

    V->>W: start({ issueNumber, issueTitle, issueBody, stopAfterCommit: true })
    W->>G: githubCheckout() 建分支
    G-->>W: feat/1-add-install-section

    W->>A: generate(实现该 issue 的改动)
    A->>H: PreToolUse(Write, { file_path })
    alt 命中受保护路径 / 危险命令
        H--xA: deny + systemMessage
        Note over A: agent 收到拒绝，转向其他方案<br/>或最终失败（显式，非静默）
    else 未命中
        H-->>A: （放行，无输出）
        A->>G: 真实 Write / Edit 文件
        G-->>A: ok
    end
    A-->>W: codingResult（文本）

    W->>W: test 闸门（LLM 自评 → TestGateSchema）
    W->>W: review 闸门（LLM 自评 → ReviewGateSchema）
    W->>W: commit 闸门（LLM 自评 → CommitGateSchema）
    W->>G: git add -A && git commit -m <message>
    Note over G: 本地 feature 分支新增 commit<br/>main 未动、远端未动

    W-->>V: 终态（无 suspend，一次跑完）
    V->>V: 逐条打印 AC-1~AC-10 判定
```

---

## 7.3 围栏决策流（guard.ts 判定内核）

```mermaid
flowchart LR
    IN["PreToolUse hook 入参<br/>{ tool_name, tool_input }"] --> T{工具类型}

    T -->|Write / Edit<br/>MultiEdit / NotebookEdit| P["normalizeRepoPath()<br/>→ 相对仓库根的路径"]
    P --> OUT{"落在仓库外?"}
    OUT -->|是| D1["deny：越界写入"]
    OUT -->|否| PROT{"命中 PROTECTED_PATHS?<br/>agent.md / .github / .env*<br/>src/mastra/{workflows,agents}"}
    PROT -->|是| D2["deny：受保护路径"]
    PROT -->|否| OK["allow"]

    T -->|Bash| CMD{"命中 DANGEROUS_COMMANDS?<br/>push -f / push main / reset --hard<br/>clean -f / rm -rf / checkout main<br/>branch -D / 写 .git/ / sudo / curl|sh"}
    CMD -->|是| D3["deny：危险命令"]
    CMD -->|否| RED{"重定向写入受保护路径?<br/>（echo x > agent.md）"}
    RED -->|是| D4["deny：shell 绕过"]
    RED -->|否| OK

    T -->|Read / Glob / Grep<br/>TodoWrite 等| OK

    ERR["hook 自身异常"] --> D5["deny：fail-closed<br/>误拒可观测，误放行不可观测"]

    style D1 fill:#f8cecc,stroke:#b85450
    style D2 fill:#f8cecc,stroke:#b85450
    style D3 fill:#f8cecc,stroke:#b85450
    style D4 fill:#f8cecc,stroke:#b85450
    style D5 fill:#f8cecc,stroke:#b85450
    style OK fill:#d5e8d4,stroke:#82b366
```

**这三类 deny 分别对应 AC-4 / AC-5 / AC-6**，是 M2 最该优先验证的部分 —— 它们证明的是「失控时拦得住」，而非「功能能用」。

---

## 7.4 与 M1 / M3 的边界对比

| | M1（已完成） | **M2** | M3（待开始） |
|---|---|---|---|
| 入口 | 飞书 / HTTP | **脚本构造入参** | 飞书 / issue 事件 |
| 写目标仓库 | 否（只读 REST） | **仅本地分支** | 是（push + PR） |
| 运行时闸门 | suspend 在 confirm | **无**（跑完人工看） | suspend 在 merge |
| 远端接触 | 只读 API | **零** | push + merge |
| 本图新增关注点 | suspend/resume 断点 | **guard 拦截点 + 零远端边界** | merge 人工 approve |
