import { createStep, Workflow } from '@mastra/core/workflows';
import { Mastra } from '@mastra/core';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * storage 持久化回归测试。
 *
 * 守护的是一条很容易被悄悄破坏的架构约束:
 * workflow 在 merge 步骤会 suspend,等用户在飞书卡片点"合并"后 resume。
 * 卡片回调是独立 HTTP 请求,手里只有 runId,必须靠 createRun({ runId }) 重建 run 对象。
 *
 * 实测(2026-09-01):不配 storage 时这条路必失败,报
 * `This workflow run was not suspended`(即使同进程、同 Mastra 实例也一样)。
 *
 * 若有人误删 src/mastra/index.ts 里的 storage 配置,这个测试会失败并说明后果。
 */
describe('Mastra storage 持久化', () => {
  const MASTRA_DB_PATH = process.env.MASTRA_DB_PATH;
  let tmpDb: string;
  let mastra: InstanceType<typeof Mastra>;

  beforeAll(async () => {
    // 指向临时库,避免污染开发库。必须在 import src/mastra 之前设置:
    // 那个模块在加载时就会读取该环境变量来决定 db 路径。
    tmpDb = join(tmpdir(), `mastra-storage-test-${Date.now()}.db`);
    process.env.MASTRA_DB_PATH = tmpDb;

    const mod = await import('../../src/mastra');
    mastra = mod.mastra;
  });

  afterAll(() => {
    if (MASTRA_DB_PATH === undefined) {
      delete process.env.MASTRA_DB_PATH;
    } else {
      process.env.MASTRA_DB_PATH = MASTRA_DB_PATH;
    }
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${tmpDb}${suffix}`, { force: true });
    }
  });

  it('应配置了持久化 storage,而非 in-memory', () => {
    const storage = mastra.getStorage();
    expect(storage).toBeDefined();
  });

  it('跨 Mastra 实例按 runId resume 应成功恢复挂起的 workflow', async () => {
    const storage = mastra.getStorage();
    if (!storage) {
      throw new Error('storage 未配置,无法验证 resume');
    }

    // 模拟 merge 步骤:未收到用户确认就挂起
    const approvalGate = createStep({
      id: 'approval-gate',
      inputSchema: z.object({ issueNumber: z.number() }),
      outputSchema: z.object({ issueNumber: z.number(), merged: z.boolean() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      suspendSchema: z.object({ waitingFor: z.string() }),
      execute: async ({ inputData, resumeData, suspend }) => {
        if (!resumeData || !resumeData.approved) {
          return await suspend({ waitingFor: 'merge-approval' });
        }
        return { issueNumber: inputData.issueNumber, merged: true };
      },
    });

    const wf = new Workflow({
      id: 'resume-probe',
      inputSchema: z.object({ issueNumber: z.number() }),
      outputSchema: z.object({ issueNumber: z.number(), merged: z.boolean() }),
    })
      .then(approvalGate)
      .commit();

    // 第一个实例:启动并挂起
    const instanceA = new Mastra({ workflows: { probe: wf }, storage });
    const runA = await instanceA.getWorkflow('probe').createRun();
    const started = await runA.start({ inputData: { issueNumber: 42 } });
    expect(started.status).toBe('suspended');

    // 第二个实例:模拟另一个进程(或卡片回调请求),只拿 runId 恢复
    const instanceB = new Mastra({ workflows: { probe: wf }, storage });
    const runB = await instanceB.getWorkflow('probe').createRun({ runId: runA.runId });
    const resumed = await runB.resume({
      step: approvalGate,
      resumeData: { approved: true },
    });

    expect(resumed.status).toBe('success');
    expect(resumed.result).toEqual({ issueNumber: 42, merged: true });
  });
});
