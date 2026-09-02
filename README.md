# pr-agent (Midway + Mastra multi-agent auto-dev)

A Midway-embedded Mastra multi-agent auto-development workflow: IM (Feishu/Lark) trigger → requirement breakdown → coding → self-test → review → human approve → open PR.

> Architecture and runtime constraints: see `agent.md` at repo root. Workflow design: `11-IM驱动的多Agent自动开发工作流设计.md`.

## QuickStart

### Development

```bash
$ npm i
$ npm run dev        # Midway-embedded path, port 8001
$ open http://localhost:8001/
```

### Build & start (production path)

```bash
$ npm run build
$ npm start          # port 8001, routes /api/agents, /api/workflows
```

### Unit test

```bash
$ npm test
```

see [midway docs][midway] for more detail.

### npm scripts

- Use `npm run lint` to check code style.
- Use `npm test` to run unit test.


[midway]: https://midwayjs.org
