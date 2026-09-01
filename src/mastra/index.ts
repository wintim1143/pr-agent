import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { devAgent } from './agents/dev-agent';
import { devWorkflow } from './workflows/dev-workflow';

/**
 * Storage 数据库文件位置(绝对路径)。
 *
 * 为什么必须用绝对路径:
 * `mastra dev`(Studio)与 Midway 应用是**两个独立进程**。若用相对路径 `file:./mastra.db`,
 * 二者会按各自进程的 cwd 解析成两个不同的库文件,结果是 Studio 里看不到应用的 workflow 状态。
 * 官方文档(docs-storage.md)对此有明确提示。
 *
 * 这里以 cwd 为基准拼绝对路径:两个进程都从项目根目录启动(`npm run dev` / `npx mastra dev`),
 * 解析结果一致。需要放到别处时用环境变量 MASTRA_DB_PATH 覆盖。
 */
const mastraDbPath = process.env.MASTRA_DB_PATH ?? resolve(process.cwd(), 'mastra.db');

/**
 * Mastra 统一入口(单一真相源)。
 *
 * - `mastra dev`(Mastra 自带 dev server + Studio)约定从此文件导出名为 `mastra` 的实例。
 * - Midway 嵌入路径(server.ts 的 registerMastra)也复用本实例,避免双实例。
 *
 * 注意:本文件只负责"装配 Mastra 实例",不负责 HTTP 挂载——
 * 挂载由 Midway 侧的 registerMastra(@mastra/koa) 或 `mastra dev` 各自完成。
 *
 * ## 为什么 storage 是必需项,而不是后期优化
 *
 * workflow 在 merge 步骤会 suspend,等用户在飞书卡片上点"合并"后 resume。
 * 卡片回调是一个**独立的 HTTP 请求**,手里只有 runId,必须靠 `createRun({ runId })` 重建 run 对象。
 *
 * 实测(2026-09-01,A/B 对照):
 * - 不配 storage:按 runId 重建 run 对象后 resume 一定失败,报 `This workflow run was not suspended`
 *   (即使同一进程、同一 Mastra 实例也一样——in-memory store 只有原 run 对象引用能 resume)
 * - 配上 LibSQLStore:跨 Mastra 实例按 runId resume 成功,上下文完整恢复
 *
 * 换句话说:**没有 storage,人工确认合并这条链路在设计上就不成立**。
 */
export const mastra = new Mastra({
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: `file:${mastraDbPath}`,
  }),
  agents: {
    'dev-agent': devAgent,
  },
  workflows: {
    'dev-workflow': devWorkflow,
  },
});
