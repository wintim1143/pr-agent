# pr-agent（Midway + Mastra 多 Agent 自动开发）

基于 Midway 嵌入 Mastra 的多 Agent 自动开发工作流：IM（飞书）触发 → 需求拆解 → 编码 → 自测 → 评审 → 人工 approve → 开 PR。

> 架构与运行约束见仓库根 `agent.md`；规划（路线图 + 各里程碑卡）见 `milestones/README.md`。旧 `11-/12-/13-` 文档已归档至 `docs/archive/`，仅作历史参考。

## 快速入门

### 本地开发

```bash
$ npm i
$ npm run dev        # Midway 嵌入路径,端口 8001
$ open http://localhost:8001/
```

### 构建与启动（生产路径）

```bash
$ npm run build
$ npm start          # 端口 8001,路由 /api/agents、/api/workflows
```

### 单元测试

```bash
$ npm test
```

如需进一步了解，参见 [midway 文档][midway]。

### 内置指令

- 使用 `npm run lint` 来做代码风格检查。
- 使用 `npm test` 来执行单元测试。


[midway]: https://midwayjs.org
