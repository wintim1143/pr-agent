import { Mastra } from '@mastra/core';
import { devAgent } from './agents/dev-agent';
import { devWorkflow } from './workflows/dev-workflow';

/**
 * Mastra 统一入口(单一真相源)。
 *
 * - `mastra dev`(Mastra 自带 dev server + Studio)约定从此文件导出名为 `mastra` 的实例。
 * - Midway 嵌入路径(server.ts 的 registerMastra)也复用本实例,避免双实例。
 *
 * 注意:本文件只负责"装配 Mastra 实例",不负责 HTTP 挂载——
 * 挂载由 Midway 侧的 registerMastra(@mastra/koa) 或 `mastra dev` 各自完成。
 */
export const mastra = new Mastra({
  agents: {
    'dev-agent': devAgent,
  },
  workflows: {
    'dev-workflow': devWorkflow,
  },
});
