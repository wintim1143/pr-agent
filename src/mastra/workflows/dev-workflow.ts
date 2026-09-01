import { z } from 'zod';
import { Workflow, createStep } from '@mastra/core/workflows';
import type { Mastra } from '@mastra/core';

/**
 * 自动开发 workflow 骨架(对应文档 §六)。
 *
 * 设计原则:
 * - 质量闸门(coding/test/review/commit/merge)由 Mastra workflow **强制顺序**保证,
 *   每个闸门 step 内部调 dev-agent 并让它加载对应 skill(确定性编排,非自主循环)。
 * - merge 是人工关卡:用 execute 里的 `suspend()` 挂起,等用户在飞书卡片点"合并"后
 *   `resume({ approved: true })` 再真正执行合并。
 * - checkout / push-open-pr / notify 依赖 GitHub 与飞书 client,本项目尚未接入,
 *   暂时是 TODO 桩(透传上下文 / 占位值),不影响流程结构跑通。
 *
 * 共享上下文 ContextSchema:贯穿全流程,各 step 逐步填充字段。所有 step 的
 * inputSchema/outputSchema 都用它,保证步骤间类型可衔接(TPrevSchema extends TStepInput)。
 *
 * 注意:1.63.2 用 `createStep({...})` 工厂(不是 `new Step(...)`);`Step` 仅为类型。
 */
const ContextSchema = z.object({
  issueNumber: z.number(),
  issueTitle: z.string(),
  issueBody: z.string(),
  branch: z.string().optional(),
  codingResult: z.string().optional(),
  testResult: z.string().optional(),
  reviewResult: z.string().optional(),
  commitMessage: z.string().optional(),
  prNumber: z.number().optional(),
  mergeResult: z.string().optional(),
});
/** 用 dev-agent 跑某个质量闸门 skill 的辅助函数 */
async function runGate(mastra: Mastra, instruction: string): Promise<string> {
  const agent = mastra.getAgent('dev-agent');
  const res = await agent.generate(instruction);
  return res.text ?? '';
}

// 1. checkout:创建 feature 分支(GitHub/本地 git,暂未接入)
const checkout = createStep({
  id: 'checkout',
  description: '创建并切到 feature 分支 feat/<issue>-<slug>',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    // TODO: 接入 git/GitHub client,基于 issueNumber 创建 feat/<n>-<slug> 并 checkout
    const branch = `feat/${inputData.issueNumber}-dev`;
    return { ...inputData, branch };
  },
});

// 2. coding:编码 skill
const coding = createStep({
  id: 'coding',
  description: '调用编码 skill 产出代码改动',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const text = await runGate(
      mastra,
      `使用 coding skill。需求:${inputData.issueTitle}\n${inputData.issueBody}\n请在当前 feature 分支上产出代码改动。`,
    );
    return { ...inputData, codingResult: text };
  },
});

// 3. test(强制):测试 skill
const testStep = createStep({
  id: 'test',
  description: '调用测试 skill,不通过不可进入审核',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const text = await runGate(
      mastra,
      `使用 code-testing skill 对当前改动运行测试并报告通过/失败。需求:${inputData.issueTitle}`,
    );
    // TODO: 解析测试结果;失败时回到 coding 重做(条件边 branch/循环)
    return { ...inputData, testResult: text };
  },
});

// 4. review(强制):代码审核 skill
const review = createStep({
  id: 'review',
  description: '调用代码审核 skill,输出 approve 或 request changes',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const text = await runGate(
      mastra,
      `使用 code-review skill 审核当前改动。需求:${inputData.issueTitle}`,
    );
    // TODO: 解析 approve / request changes;request changes 时回到 coding
    return { ...inputData, reviewResult: text };
  },
});

// 5. commit(强制):commit message skill
const commit = createStep({
  id: 'commit',
  description: '调用 commit-message skill 生成 Conventional Commits',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const text = await runGate(
      mastra,
      `使用 commit-message skill 为改动生成 commit message,关联 issue #${inputData.issueNumber}。`,
    );
    return { ...inputData, commitMessage: text };
  },
});

// 6. push + open PR(GitHub,暂未接入)
const pushOpenPr = createStep({
  id: 'push-open-pr',
  description: 'push feature 分支并开 PR',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    // TODO: 接入 GitHub client:push + 开 PR(标题 `<type>: <subject> (#issue)`)
    const prNumber = 0; // 占位,接入后替换为真实 PR 号
    return { ...inputData, prNumber };
  },
});

// 7. notify:飞书推卡片等用户确认(飞书,暂未接入)
const notify = createStep({
  id: 'notify',
  description: '飞书推开发完成卡片,等用户确认合并',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    // TODO: 接入飞书 adapter,推卡片(合并 / 拒绝按钮,callback_id 内嵌 issue 号)
    return inputData;
  },
});

// 8. merge(强制,需用户确认):合并 PR skill + suspend/resume
const merge = createStep({
  id: 'merge',
  description: '用户确认后调用合并 PR skill 执行 squash merge',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData, suspend, resumeData }) => {
    // 未收到用户确认 → 挂起,等飞书卡片点"合并"后 resume({ approved: true })
    if (!resumeData || !(resumeData as { approved?: boolean }).approved) {
      return suspend({ waitingFor: 'merge-approval', issueNumber: inputData.issueNumber });
    }
    const text = await runGate(
      mastra,
      `使用 merge-pr skill 执行 squash merge 合入 main 并关闭 issue #${inputData.issueNumber}。`,
    );
    return { ...inputData, mergeResult: text };
  },
});

/**
 * 组装 workflow。
 * - `mastra` 不在此传入:由 index.ts 的 `new Mastra({ workflows })` 自动注入。
 * - 用 `.then()` 串联步骤(第一个步骤也用 `.then()`),末尾 `.commit()`。
 * - 失败时回退 coding 的条件边(branch/dowhile)是后续细化项,见文档 §十二。
 */
export const devWorkflow = new Workflow({
  id: 'dev-workflow',
  description: 'IM 驱动的自动开发流水线:编码→测试→审核→commit→PR→合并(质量闸门由 workflow 强制)',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
})
  .then(checkout)
  .then(coding)
  .then(testStep)
  .then(review)
  .then(commit)
  .then(pushOpenPr)
  .then(notify)
  .then(merge)
  .commit();
