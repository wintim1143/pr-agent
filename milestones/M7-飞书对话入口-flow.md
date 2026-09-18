# M7 · 飞书对话入口 —— 数据流向图

> 配套卡片：[`M7-飞书对话入口.md`](./M7-飞书对话入口.md)
> 本图重点画四件事：**Channel 常驻通路**、**指令路由决策树（含拒绝路径）**、
> **三层幂等的分工**、**与 M8 的边界（本卡不碰 workflow）**。
> 📌 与 M1–M6 的关键差异：**本图没有任何 workflow 节点** —— 这是刻意的，M7 是纯入口层。

---

## 1 总览：M7 的数据流向

```mermaid
flowchart TB
    subgraph FEISHU["飞书侧（云端）"]
        USER["👤 群成员 / 私聊用户<br/>@bot 说一句话"]
        EV1["im.message.receive_v1"]
        EV2["card.action.trigger<br/>（本卡只注册不消费）"]
    end

    subgraph CH["★M7-1 createLarkChannel 常驻（本机，无公网入口）"]
        WS["长连接（出站 WebSocket）<br/>归一化 / 重连 / 优雅退出"]
        POL["policy: requireMention<br/>→ 未 @ 则 reject"]
        SAFE["safety: dedup / per-chat 串行"]
    end

    subgraph ROUTE["★M7-2 指令路由（纯函数，可单测）"]
        R1["以 / 开头？"]
        R2["查指令闭集"]
        R3["提取 [repoKey]"]
        R4["查仓库注册表白名单"]
        R5["✅ dispatch"]
        R6["❓ reject<br/>零 LLM 调用"]
        R7["🟨 识别但未接入<br/>（/dev /insight /status /cost）"]
    end

    subgraph EXEC["★M7-3 /ask 执行"]
        AG["ask-agent（Mastra Agent）<br/>无状态单轮"]
        ST["channel.stream()<br/>Thinking… → 打字机"]
    end

    subgraph STORE["持久化与可观测"]
        DEDUP[("M5a dedup-store<br/>SQLite 幂等 + 游标")]
        LOG["★M6 统一 logger<br/>im:route / im:reject"]
    end

    USER --> EV1 --> WS
    EV2 -.->|"本卡仅实测连通性"| WS
    WS --> POL
    POL -->|"已 @ / 私聊"| SAFE --> R1
    POL -.->|"未 @（群聊）"| REJ["on('reject', 'no_mention')<br/>落 im:reject，不回复"]
    R1 -->|"是"| R2
    R1 -.->|"否 → reason=default"| R5
    R2 -->|"命中 ask / help"| R3
    R2 -.->|"未命中"| R6
    R2 -.->|"命中 dev/insight/status/cost"| R7
    R3 --> R4
    R4 -->|"命中 / ask 可省略"| R5
    R4 -.->|"未命中"| R6
    R5 --> AG --> ST
    R7 -.-> ST
    R6 -.-> ST
    R5 -.->|"幂等第 3 层"| DEDUP
    ST -.->|"卡片推群"| FEISHU
    R5 -.-> LOG
    R6 -.-> LOG
    R7 -.-> LOG
    REJ -.-> LOG
```

---

## 2 指令路由决策树（本卡第一交付物）

> 📌 **先把协议表定全，实现只落 1 条** —— 这是「先编排好」的字面落地。
> 后续接 dev / insight 时，只往注册表里加 handler，**决策树本身不动**。

```mermaid
flowchart TB
    IN["群里一句话（已过 policy + dedup）"]

    IN --> Q1{"以 / 开头？"}
    Q1 -.->|"否"| DEF["默认意图 = /ask<br/>reason=default<br/>（确定性规则，不是 LLM 猜）"]
    Q1 -->|"是"| Q2{"首段在指令闭集？"}

    Q2 -.->|"否"| X1["❌ 未知指令<br/>回『可用指令』清单<br/>零 LLM 调用"]
    Q2 -->|"是"| Q3{"该指令本轮已实现？"}

    Q3 -.->|"否：dev / insight<br/>status / cost"| X2["🟨 明确回『该指令将在 M8 接入』<br/>零 run 起"]
    Q3 -->|"是：ask / help"| Q4{"文本含 [repo]？"}

    Q4 -.->|"否"| Q5{"该指令要求仓库？"}
    Q5 -.->|"ask：不要求"| OK
    Q5 -->|"dev / insight：要求"| X3["❌ 缺仓库标识<br/>回『请指定仓库』"]

    Q4 -->|"是"| Q6{"repoKey 在注册表白名单？"}
    Q6 -.->|"否"| X4["❌ 未知仓库<br/>列出可用仓库<br/>**绝不回退默认仓库**"]
    Q6 -->|"是"| OK["✅ dispatch → handler"]

    DEF --> OK
    OK --> H1["/ask → ask-agent → channel.stream()"]
    OK --> H2["/help → 指令清单卡片"]

    X1 --> NO["零副作用：<br/>零 LLM 调用 / 零 run 起"]
    X2 --> NO
    X3 --> NO
    X4 --> NO
```

| 指令 | 语法 | 仓库 | 本卡状态 | 去向 |
|---|---|---|---|---|
| `/ask` | `/ask [<repo>] <问题>` | 可选 | ✅ **实现** | `ask-agent` 通用对话（流式） |
| `/help` | `/help` | — | ✅ **实现** | 回指令清单卡片 |
| （无指令） | `<任意文本>` | — | ✅ **实现** | 默认 → `/ask` |
| `/dev` | `/dev [<repo>] <需求>` | **必填** | 🟨 识别但拒绝执行 | M8 → `dev-workflow` |
| `/insight` | `/insight [<repo>] <问题 \| #issue>` | **必填** | 🟨 识别但拒绝执行 | M8 → `insight-workflow` |
| `/status` | `/status [#<runId>]` | — | 🟨 识别但拒绝执行 | M8 → M6 日志时间线 |
| `/cost` | `/cost [<repo>]` | 可选 | 🟨 识别但拒绝执行 | M8 → M6 成本归口 |

**为什么 `/ask` 的仓库可选，而 `/dev` 必填**：通用问答常与仓库无关（「这个项目怎么跑」）；
而 `/dev` 一旦路由错，代价是**在错误的仓库开 PR** —— 不对称，所以必须显式（同 M5 §3 论证）。

---

## 3 三层幂等：SDK 两层 + M5a 一层，各管一段

> ⚠️ **这节是防止「重复建设」与「误删」的关键** —— 看到 SDK 自带 dedup 就删掉 M5a 的去重，会丢掉跨重启能力。

```mermaid
flowchart LR
    MSG["同一条飞书消息"]

    MSG --> L1{"第 1 层<br/>SDK safety dedup<br/>（**内存**）"}
    L1 -.->|"秒级重投"| D1["静默丢弃<br/>⚠️ SDK 不 emit 事件<br/>→ 需我们补日志"]
    L1 -->|通过| L2{"第 2 层<br/>SDK per-chat 串行<br/>（内存）"}
    L2 --> L3{"第 3 层<br/>M5a dedup-store<br/>（**SQLite 持久化**）"}
    L3 -.->|"跨重启重复"| D3["记 duplicate<br/>**可观测**"]
    L3 -->|"原子认领成功"| OK["✅ 真正处理"]
```

| 层 | 提供方 | 挡什么 | 生命周期 | 可观测性 |
|---|---|---|---|---|
| 1 | SDK `safety` | 长连接**秒级重投** | 进程内 | ⚠️ 静默（官方明示：只有 policy 拒绝才 emit `reject`） |
| 2 | SDK `safety` | 同会话并发 | 进程内 | 静默 |
| 3 | **M5a（我方）** | **跨重启重复** | **持久化** | ✅ 落 `duplicate` 事件 |

> 📌 **职责划分**：SDK 两层是「免费的防线」，M5a 那层是「唯一跨进程有效的防线」。
> M7 的 AC-8 断言的是**第 3 层**（可数），因为第 1 层静默、不可数。

---

## 4 为什么从 `WSClient` 上移到 `Channel`

```mermaid
flowchart TB
    subgraph OLD["原方案（现 M8 卡 §6 的旧选型）"]
        direction TB
        O1["WSClient + EventDispatcher<br/>自己注册事件"]
        O2["自己 JSON.parse 各 msg_type"]
        O3["流式回复：做不了<br/>要手写 updateCard 轮询"]
        O4["幂等 / 并发：自己做"]
        O5["准入：自己做"]
        O1 --> O2
        O1 --> O3
        O1 --> O4
        O1 --> O5
    end

    subgraph NEW["Channel（本卡选型）"]
        direction TB
        N1["createLarkChannel<br/>transport 默认 websocket"]
        N2["NormalizedMessage<br/>10+ msg_type → markdown"]
        N3["channel.stream()<br/>原生打字机（服务端渲染）"]
        N4["safety: dedup / 串行 / 批量合并"]
        N5["policy: requireMention / allowlist<br/>+ on('reject') 带原因"]
        N1 --> N2
        N1 --> N3
        N1 --> N4
        N1 --> N5
    end
```

| 能力 | `WSClient` | `Channel` |
|---|---|---|
| 消息解析 | 自己按 `msg_type` 分支 | `NormalizedMessage` 已归一化 |
| 流式回复 | ❌ 做不了 | ✅ `channel.stream()` |
| 卡片更新 | 手拼 JSON + 自己调 API | `channel.updateCard(messageId, card)` |
| 防重投 / 并发 | 自己写 | `safety` |
| 准入 | 自己写 | `policy` + `reject` 事件 |
| 自动降级 | 无 | 回复目标被撤回 → 转为新消息；post 被拒 → 转纯文本 |
| 逃生舱 | — | `channel.rawClient` 直调 Open API |

> 📌 官方给出的取舍线：「需要对话式 bot 能力（流式、卡片交互、媒体、@ 策略）→ 用 `Channel`；
> 只需收几个事件做简单处理 → `WSClient` 就够。」**本项目属前者。**

---

## 5 与 M8 的边界（本卡刻意不越过的那条线）

```mermaid
flowchart LR
    subgraph M7["M7 本卡（能聊）"]
        A1["Channel 常驻"]
        A2["指令路由框架"]
        A3["/ask 流式对话"]
        A4["/help 指令清单"]
        A5["默认意图"]
        A6["未实现指令明确拒答"]
        A7["最小策略（SDK policy）"]
    end

    subgraph M8["M8（能开发）"]
        B1["/dev → dev-workflow"]
        B2["/insight → insight-workflow"]
        B3["卡片 V1 → V2 迁移"]
        B4["按钮回调 → resume"]
        B5["卡片补 target / runId"]
        B6["自研准入白名单"]
        B7["/status / /cost"]
    end

    subgraph OTHERS["已有资产（本卡只用不改）"]
        C1["M3: suspend / resume + githubMergePR"]
        C2["M5: dedup-store + repo-registry"]
        C3["M6: runId 贯穿 + 日志规范"]
    end

    A2 -->|"路由层一行不用改<br/>只加 handler"| B1
    A2 -->|"同上"| B2
    A1 -->|"cardAction 已注册并实测"| B4
    A4 -->|"/help 卡片直接按 V2 写<br/>避免 M8 返工"| B3
    A7 -->|"自研白名单在此升级"| B6
    C2 --> A2
    C2 --> A1
    C3 --> A3
    C1 --> B4

    style M7 fill:#e8f4ff
    style M8 fill:#fff4e8
```

> 📌 **为什么这条线要画清楚**：M7 的失败模式是「**接错端口**」（消息收到但路由错 / 没有回话），
> M8 的失败模式是「**静默驱动错误**」（在错仓库开 PR / resume 错 run）。
> 两者风险性质不同、验收方式也不同 —— 搅在一起会说不清是哪一层的问题。
>
> 📌 **依赖顺序**：M7 **不依赖 M6**，可立即开工；M8 依赖 M6 的 runId 贯穿（原「M6 → M7 硬依赖」已更正为「M6 → M8」）。
