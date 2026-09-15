# M4 · 真质量闸门 —— 数据流向图

> 配套卡片：[`M4-真质量闸门.md`](./M4-真质量闸门.md)
> 本图重点画三件事：**test 步内部从「单点」变「两路」**、**三态走向（pass / fail / null）**、**判负终止点**。
> 与 M3 的关键差异：编排层八步**结构不变**，变的只是 **test 步内部的判据来源**。

---

## 1 总览：M4 的数据流向

```mermaid
flowchart TB
    subgraph TRIGGER["触发层"]
        V["验证脚本<br/>构造 issue 形状入参"]
        ENV["env 硬设(同 M3):<br/>CODING_REPO_ROOT = D:\\code\\pr-agent-e2e<br/>GITHUB_OWNER / REPO / BASE_BRANCH<br/>GIT_PROXY(仅调用点注入)"]
    end

    subgraph ORCH["编排层 dev-workflow(八步, 结构不变)"]
        C1["1. checkout<br/>建 feat/&lt;n&gt;-&lt;slug&gt;"]
        C2["2. coding<br/>ClaudeSDKAgent"]
        C3["3. test<br/>★M4 唯一改造点"]
        C4["4. review 闸门"]
        C5["5. commit"]
        C6["6. push-open-pr<br/>★写远端①"]
        C7["7. notify<br/>飞书卡片"]
        C8["8. merge<br/>⏸ suspend"]
        C9["8'. merge 执行<br/>★写远端②"]
    end

    subgraph STORE["持久化"]
        DB[("LibSQLStore<br/>mastra.db")]
    end

    subgraph EXT["外部系统"]
        CLI["Claude Code CLI 子进程"]
        LOCAL["靶场本地 clone<br/>D:\\code\\pr-agent-e2e"]
        RUNNER["node 子进程<br/>测试 runner(新增)"]
        GH["GitHub 远端"]
        FS["飞书群"]
        HUMAN["👤 用户"]
    end

    V --> C1
    ENV -.->|定位目标仓库| C1
    C1 --> C2 --> C3 --> C4 --> C5 --> C6 --> C7 --> C8
    C8 -.->|"suspend: 落库并返回"| DB
    HUMAN -->|approve| DB
    DB --> C9
    C6 -->|"git push + REST POST /pulls"| GH
    C9 -->|"REST PUT /pulls/n/merge"| GH
    C7 --> FS

    C2 --> CLI
    C3 -->|"① 程序: spawn"| RUNNER
    RUNNER -->|"在工作树上读文件"| LOCAL
    C1 --> LOCAL
    C5 --> LOCAL

    C3 -.->|"判负 → throw<br/>不进入 4/5/6"| DB
```

> **读图要点**：M4 对编排层**没有改动** —— 八步、suspend 断点、红线位置全部沿用 M3。
> 唯一的改造发生在 `C3` 这个方框**内部**。这是可以在图上直观确认的「范围没有蔓延」。

---

## 2 test 步内部：两路分叉与汇合（M4 的核心）

```mermaid
flowchart TB
    IN["inputData<br/>issueTitle / issueBody / codingResult"]
    DIFF["buildChangeContext()<br/>真实 diff + stat (程序)"]

    IN --> DIFF

    subgraph PROG["① 程序路 (M4 新增)"]
        PROBE{"探测<br/>package.json?<br/>test script?"}
        DISC{"盘上真有测试文件?<br/>discoverTestFiles()<br/>★防假通过: 零测试文件时<br/>node --test 退出码为 0"}
        RUN["执行白名单命令<br/>jest / vitest / node --test<br/>不经过 npm ⇒ 生命周期钩子无触发机会<br/>+ 超时杀进程树 + 输出尾部截断<br/>+ 子进程 env 剥离凭据"]
        EXIT["exitCode → testsPassed<br/>★程序独占"]
        NULL["testsPassed = null<br/>no-package-json / no-test-script<br/>/ no-test-files / spawn-failed"]
        PROBE -->|存在| DISC
        DISC -->|有| RUN
        DISC -->|无| NULL
        RUN --> EXIT
        PROBE -->|不存在| NULL
    end

    subgraph SEM["② 语义路 (M3 已有, 保留)"]
        LLM["LLM 读 diff<br/>requirementMet<br/>★真能判的就这个"]
    end

    MOD{"动过测试文件?<br/>gitChangedFilesWithStatus()<br/>比对测试路径模式 (程序)"}

    DIFF --> PROBE
    DIFF --> LLM
    DIFF --> MOD

    MERGE["程序合成 passed<br/>passed = testsPassed 非 false<br/>且 requirementMet"]
    MOD -->|"modified 为空 (含仅 added)"| MERGE
    MOD -->|"modified 非空<br/>(改/删既有测试)"| POLICY{"处置策略<br/>★已定案: 默认 block<br/>TEST_GUARD_MODIFY_TESTS=warn 才降级"}
    POLICY -->|warn| MERGE
    POLICY -->|block| TERM

    EXIT --> MERGE
    NULL --> MERGE
    LLM --> MERGE

    MERGE -->|"false"| TERM["throw<br/>GATE_REJECTED@test<br/>不 commit / 不 push<br/>(复用 M3-8 路径)"]
    MERGE -->|"true"| NEXT["→ review 步"]
```

### 三态走向（务必分清）

| `testsPassed` | 含义 | 对 `passed` 的影响 |
|---|---|---|
| `true` | 真跑了，退出码 0 | 由 `requirementMet` 决定 |
| `false` | 真跑了，退出码非 0 / 超时 | **直接判负**（硬红线，`requirementMet` 不参与） |
| `null` | **无测试可跑 / 无测试文件 / runner 起不来** | 由 `requirementMet` 决定，但 `report` 必须标注「未跑测试」 |

> ⚠️ **`null` 绝不能被当成 `true`**。「没有测试」与「需求实现了」是两件不同的事。
> 这正是 M2 那次 `lintPassed` 幻觉的同构错误：让 LLM 回答一个不存在的事实。
>
> ⚠️ **另一条更隐蔽的假通过**（2026-09-15 实测暴露，不在原计划内）：
> `node --test` 在「零个测试文件」时**退出码为 0**。若只看退出码，
> 「声明了测试但仓库里其实没有测试」会得到 `testsPassed=true` —— 什么都没验，却报了绿。
> 已在 runner 前加 `discoverTestFiles()` 盘上发现性检查，此时判 `null`。

### `modified` vs `added`（为什么不是单一布尔）

| 情况 | git 状态 | 归类 | 处置 |
|---|---|---|---|
| 改 / 删 / 重命名**既有**测试 | `M` / `D` / `R` | `modified` | **默认阻断**（能把断言改松 → 自证循环） |
| **新增**测试文件 | `A`（含未跟踪） | `added` | 仅记录（不可能削弱既有断言） |

> 不拆的话，一个「顺手给新函数补个测试」的良性 agent 会被误拦 ——
> 而这恰是靶场路径 A 的真实风险（模型很可能觉得补测试是好习惯）。

---

## 3 判据来源对照（M3 → M4）

```mermaid
flowchart LR
    subgraph M3["M3: 单点"]
        A["test 步"] --> B["LLM 单判 passed"]
        B --> C["prompt 原文:<br/>『若仓库存在可执行测试,<br/>以其结果为准』<br/>⚠️ 模型无执行能力"]
    end

    subgraph M4["M4: 两路 + 合成"]
        D["test 步"] --> E["程序: testsPassed"]
        D --> F["LLM: requirementMet"]
        E --> G["程序合成 passed"]
        F --> G
    end

    M3 -.->|改造| M4
```

---

## 4 与 M3 的差异速查

| 维度 | M3 | M4 |
|---|---|---|
| 编排层八步 | 完整 | **不变** |
| `test` 步内部 | 单点（一次 LLM 调用） | **两路（程序执行 + LLM 语义）+ 合成** |
| `passed` 的来源 | LLM | **程序合成** |
| 「测试过没过」 | LLM 编造 | **程序真跑取 exit code** |
| 无测试时的语义 | 混在 `passed` 里，无区分 | **`testsPassed = null`（不等于 true）** |
| agent 改测试 | 无感知 | **`agentModifiedTests` 标记 + 默认阻断**（`added` 不阻断） |
| 命令来源 | LLM 声称跑过 | **程序白名单 runner，完全不经过 npm** |
| 闸门重试 | 盲（不回灌错误） | **回灌上次 zod 错误（P0-2）** |
| 人工闸门 | merge 前 suspend | **不变**（M4 的判据不需人批） |
| 红线 / 靶场 | `wintim1143/pr-agent-e2e` | **不变，且新增被测文件 `src/greet.js` + 人工预置测试** |
| 验证脚本 | `verify-pr-loop.js`（M3，已归档） | **新增 `verify-m4-gate.js`**（有意隔离，不动 M3 的证据产出器） |
