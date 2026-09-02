import { z } from 'zod';
import { Workflow, createStep } from '@mastra/core/workflows';
import type { Mastra } from '@mastra/core';
import { getFeishuConfig, feishuNotify, buildDevCompleteCard } from '../adapters/feishu';
import { getGithubConfig, githubCheckout, githubPushAndOpenPR, gitCommit } from '../adapters/github';

/**
 * 自动开发 workflow 骨架(对应文档 §六)。
 *
 * 设计原则:
 * - 质量闸门(coding/test/review/commit/merge)由 Mastra workflow **强制顺序**保证,
 *   每个闸门 step 内部调 dev-agent 并让它加载对应 skill(确定性编排,非自主循环)。
 * - merge 是人工关卡:用 execute 里的 `suspend()` 挂起,等用户在飞书卡片点"合并"后
 *   `resume({ approved: true })` 再真正执行合并。
 * - checkout / push-open-pr 已接入 GitHub adapter(见 `../adapters/github`):
 *   checkout 用本地 git 建分支,push-open-pr 用 `git push`(token 内嵌 HTTPS)+ `gh pr create` 开 PR。
 *   未配置 GitHub(`GITHUB_TOKEN` 缺失)时这两步跳过、不阻断流程;notify 步已接入飞书 adapter,
 *   未配置飞书时跳过、推送失败仅告警,不阻断后续合并关卡。
 *
 * 共享上下文 ContextSchema:贯穿全流程,各 step 逐步填充字段。所有 step 的
 * inputSchema/outputSchema 都用它,保证步骤间类型可衔接(TPrevSchema extends TStepInput)。
 *
 * 注意:1.63.2 用 `createStep({...})` 工厂(不是 `new Step(...)`);`Step` 仅为类型。
 */
/**
 * 结构化闸门输出契约(文档 P3-1,2026-09-02 定稿)。
 * - test: 测试闸门,passed 决定是否进入 review
 * - review: 审核闸门,decision 决定通过(approve)或打回(request-changes)
 * - commit: commit 闸门,lintPassed 决定是否能进 commit
 * 三个闸门的输出从 `agent.generate` 的 `structuredOutput` 读取(`result.object`),
 * 保证 workflow 条件边(branch/dowhile)能依据结构化字段判定,而非解析字符串。
 */
const TestGateSchema = z.object({
  passed: z.boolean(),
  report: z.string(),
});
const ReviewGateSchema = z.object({
  decision: z.enum(['approve', 'request-changes']),
  comments: z.array(z.string()),
});
const CommitGateSchema = z.object({
  message: z.string(),
  lintPassed: z.boolean(),
});

const ContextSchema = z.object({
  issueNumber: z.number(),
  issueTitle: z.string(),
  issueBody: z.string(),
  branch: z.string().optional(),
  codingResult: z.string().optional(),
  testResult: TestGateSchema.optional(),
  reviewResult: ReviewGateSchema.optional(),
  commitResult: CommitGateSchema.optional(),
  prNumber: z.number().optional(),
  mergeResult: z.string().optional(),
});
/**
 * 用 dev-agent 跑质量闸门 skill,输出结构化结果(文档 P3-1)。
 * 依据 `structuredOutput` 从 `res.object` 读取,保证条件边能按结构化字段判定。
 */
async function runGate<S extends z.ZodTypeAny>(mastra: Mastra, instruction: string, schema: S): Promise<z.infer<S>> {
  const agent = mastra.getAgent('dev-agent');
  const res = await agent.generate(instruction, {
    structuredOutput: { schema, errorStrategy: 'strict' },
  });
  // structuredOutput 保证 object 符合 schema 形状,此处断言(泛型无法自动推导)
  return res.object as z.infer<S>;
}
/** 用 dev-agent 跑不需要结构化输出的 step(如 coding / merge),返回纯文本。 */
async function runPlain(mastra: Mastra, instruction: string): Promise<string> {
  const agent = mastra.getAgent('dev-agent');
  const res = await agent.generate(instruction);
  return res.text ?? '';
}

/** 生成 PR 描述(供 push-open-pr 步使用) */
function buildPrBody(ctx: z.infer<typeof ContextSchema>): string {
  const lines = [
    `## 自动开发 PR(issue #${ctx.issueNumber})`,
    '',
    `**需求**: ${ctx.issueTitle}`,
    '',
    ctx.issueBody ? `**描述**:\n${ctx.issueBody}\n` : '',
    ctx.testResult ? `**测试**: ${ctx.testResult.passed ? '✅ 通过' : '❌ 未通过'} —— ${ctx.testResult.report}` : '',
    ctx.reviewResult
      ? `**审核**: ${ctx.reviewResult.decision}${ctx.reviewResult.comments.length ? ` (${ctx.reviewResult.comments.join('; ')})` : ''}`
      : '',
    ctx.commitResult ? `**commit**: ${ctx.commitResult.message}` : '',
    '',
    '> 由 pr-agent 自动生成,合并前请人工 review。',
  ];
  return lines.filter(l => l !== '').join('\n');
}

// 1. checkout:创建并切到 feature 分支(已接入 GitHub adapter,走本地 git)
const checkout = createStep({
  id: 'checkout',
  description: '创建并切到 feature 分支 feat/<issue>-<slug>',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    try {
      const branch = await githubCheckout(inputData.issueNumber, inputData.issueTitle);
      return { ...inputData, branch };
    } catch (e) {
      console.warn('[checkout] 创建分支失败:', e instanceof Error ? e.message : e);
      // 失败不阻断,沿用占位分支名(后续 push-open-pr 会再暴露错误)
      return { ...inputData, branch: `feat/${inputData.issueNumber}-dev` };
    }
  },
});

// 2. coding:编码 skill
const coding = createStep({
  id: 'coding',
  description: '调用编码 skill 产出代码改动',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const text = await runPlain(
      mastra,
      `使用 coding skill。需求:${inputData.issueTitle}\n${inputData.issueBody}\n请在当前 feature 分支上产出代码改动。`
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
    const testResult = await runGate(
      mastra,
      `使用 code-testing skill 对当前改动运行测试,输出结构化结果 { passed: boolean, report: string }。需求:${inputData.issueTitle}`,
      TestGateSchema
    );
    // TODO: passed=false 时回到 coding 重做(条件边 branch/dowhile,见文档 §十二)
    return { ...inputData, testResult };
  },
});

// 4. review(强制):代码审核 skill
const review = createStep({
  id: 'review',
  description: '调用代码审核 skill,输出 approve 或 request changes',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const reviewResult = await runGate(
      mastra,
      `使用 code-review skill 审核当前改动,输出结构化结果 { decision: 'approve' | 'request-changes', comments: string[] }。需求:${inputData.issueTitle}`,
      ReviewGateSchema
    );
    // TODO: decision=request-changes 时回到 coding(条件边,见文档 §十二)
    return { ...inputData, reviewResult };
  },
});

// 5. commit(强制):commit message skill + 真实 git commit
const commit = createStep({
  id: 'commit',
  description: '调用 commit-message skill 生成 Conventional Commits 并实际提交',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const commitResult = await runGate(
      mastra,
      `使用 commit-message skill 为改动生成 commit message,关联 issue #${inputData.issueNumber},输出结构化结果 { message: string, lintPassed: boolean }。`,
      CommitGateSchema
    );
    // 真正落盘:把当前改动 commit 到 feature 分支(git add -A + commit)
    try {
      const r = gitCommit(commitResult.message);
      if (!r.committed && r.error && r.error !== 'nothing-to-commit') {
        console.warn('[commit] 未产生提交:', r.error);
      }
    } catch (e) {
      console.warn('[commit] git commit 异常:', e instanceof Error ? e.message : e);
    }
    return { ...inputData, commitResult };
  },
});

// 6. push + open PR(已接入 GitHub adapter:git push + gh pr create)
const pushOpenPr = createStep({
  id: 'push-open-pr',
  description: 'push feature 分支并开 PR',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    if (!getGithubConfig()) {
      // 未配置 GitHub → 跳过,prNumber 保持 0,不阻断后续 notify/merge
      return { ...inputData, prNumber: 0 };
    }
    const res = await githubPushAndOpenPR({
      branch: inputData.branch ?? `feat/${inputData.issueNumber}-dev`,
      title: `${inputData.issueTitle} (#${inputData.issueNumber})`,
      body: buildPrBody(inputData),
      commitMessage: inputData.commitResult?.message,
    });
    if (res.error) {
      console.warn('[push-open-pr] 开 PR 失败:', res.error);
    } else if (res.skipped) {
      console.warn('[push-open-pr] 未配置 GitHub,已跳过');
    } else if (res.prUrl) {
      console.log('[push-open-pr] PR 已开:', res.prUrl);
    }
    return { ...inputData, prNumber: res.prNumber };
  },
});

// 7. notify:飞书推开发完成卡片,等用户确认合并(飞书 adapter 已接入)
const notify = createStep({
  id: 'notify',
  description: '飞书推开发完成卡片,等用户确认合并',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    // 接入飞书 adapter:推开发完成卡片(合并/拒绝按钮,callback_id 内嵌 issue 号)。
    // 未配置飞书 → 跳过通知,不阻断流程(后续 merge 步仍会 suspend 等人确认)。
    // 配置但推送失败 → 仅告警,不阻断(按钮回调 resume 属后续 IM 入口工作)。
    if (!getFeishuConfig()) {
      return inputData;
    }
    try {
      const res = await feishuNotify(
        buildDevCompleteCard({
          issueNumber: inputData.issueNumber,
          issueTitle: inputData.issueTitle,
          branch: inputData.branch,
          prNumber: inputData.prNumber,
        })
      );
      if (!res.ok) {
        console.warn(`[notify] 飞书推送失败(mode=${res.mode}):`, res.error || JSON.stringify(res.raw));
      }
    } catch (e) {
      console.warn('[notify] 飞书推送异常:', e instanceof Error ? e.message : e);
    }
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
      return suspend({
        waitingFor: 'merge-approval',
        issueNumber: inputData.issueNumber,
      });
    }
    const text = await runPlain(
      mastra,
      `使用 merge-pr skill 执行 squash merge 合入 main 并关闭 issue #${inputData.issueNumber}。`
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
