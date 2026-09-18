import { z } from 'zod';
import { Workflow, createStep } from '@mastra/core/workflows';
import type { Agent } from '@mastra/core/agent';
import { getGithubReadonlyClient } from '../integrations/github-readonly';
import { getFeishuClient } from '../integrations/feishu';
import { feishuNotify } from '../adapters/feishu';
import { normalizeUsage } from '../log-store';
import { runEnd, runStart, runSuspend, stage, stageStart } from '../progress';

/**
 * M1 只读洞察闭环 workflow(对应里程碑卡 §6 M1-4)。
 *
 * 四步:collect → summarize → notify → confirm,强制顺序(对应文档「闸门不可跳过」)。
 * - collect:调 GitHub 只读集成拉 issue + commits(全 GET,零写入)
 * - summarize:insight-agent 用 plain generate 产出 { highlights, risks, suggestions }
 * - notify:飞书推洞察卡片(含确认/重跑按钮,value 内嵌 runId 供回调映射),未配置飞书则跳过
 * - confirm:人工关卡,`suspend()` 挂起等人点卡片按钮;resume 后记录反馈并返回终态
 *
 * 全程对目标仓库零写入(AC-6)。step4 的 resume 是独立 HTTP 请求(只持 runId),
 * 靠 LibSQLStore 跨请求恢复上下文(已在 src/mastra/index.ts 配置)。
 *
 * 共享上下文 InsightContextSchema 贯穿全流程,各 step 逐步填充字段(对应 dev-workflow 的写法)。
 */

/** 汇总结构化输出契约(plain generate 读取 res.text 再抽 JSON)。字段带默认空数组,解析失败时降级不中断闭环。 */
const InsightSchema = z.object({
  highlights: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
});

const InsightContextSchema = z.object({
  query: z.string(),
  issues: z.array(z.object({ number: z.number(), title: z.string(), state: z.string(), url: z.string() })).optional(),
  commits: z.array(z.object({ sha: z.string(), message: z.string(), author: z.string(), date: z.string() })).optional(),
  insight: z
    .object({ highlights: z.array(z.string()), risks: z.array(z.string()), suggestions: z.array(z.string()) })
    .optional(),
  /** LLM 不可用(超时/报错)时为 true,供 notify 在卡片上标注"暂不可用"而非编造内容。 */
  llmUnavailable: z.boolean().optional(),
  cardSent: z.boolean().optional(),
  feedback: z.string().optional(),
});

// ---------- summarize 步的 LLM 调用:有界超时 + 重试 + 优雅降级 ----------

/**
 * 单次 LLM 调用的最大等待时间。
 *
 * ## 为什么必须显式加超时
 *
 * 实测(2026-09-03):当前中继(lanfengai / glm-5.x)延迟极高且**可能挂起**(一次 generate 60s+ 无响应),
 * 而 Mastra `agent.generate` **没有默认网络超时**。一旦挂起,`run.start()` 永远等不到 suspend,
 * 整条「collect → … → suspend/resume」闭环被冻结(外部依赖拖垮主链路)。
 *
 * 故在此层用 `AbortController` 显式兜底:`abortSignal` 传给 generate,超时即中断本次调用进入重试;
 * 全部重试耗尽仍失败,降级为空洞察让闭环继续走完(人工确认环节不丢)。
 * 可用环境变量覆盖:`M1_LLM_TIMEOUT_MS`(默认 45000)、`M1_LLM_ATTEMPTS`(默认 3)。
 */
const LLM_TIMEOUT_MS = Number(process.env.M1_LLM_TIMEOUT_MS) || 45_000;
const LLM_MAX_ATTEMPTS = Math.max(1, Number(process.env.M1_LLM_ATTEMPTS) || 3);

/** 统一的错误文本化（M6-1）。 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 从 Mastra `generate()` 结果里取 token 用量（M6-4）；拿不到 → 归一成 null，不是 0。 */
function usageOf(res: unknown): unknown {
  if (!res || typeof res !== 'object') return undefined;
  const r = res as { usage?: unknown; totalUsage?: unknown };
  return r.usage ?? r.totalUsage;
}

/**
 * @param runId M6-2：来自 summarize 步的 execute 上下文。本函数是模块级工具函数，
 *   **拿不到** runId —— 所以必须由调用方**显式传进来**；否则其内部的重试/降级事件
 *   会归不到 run（`trace:missing` 会把这种遗漏暴露成可数事实，不静默）。
 */
async function generateInsight(
  agent: Agent,
  prompt: string,
  runId: string | null
): Promise<{ insight: z.infer<typeof InsightSchema>; degraded: boolean; lastError?: string }> {
  let lastError = '';
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      stage('llm:start', { stage: 'summarize', runId, attempt, maxAttempts: LLM_MAX_ATTEMPTS, timeoutMs: LLM_TIMEOUT_MS });
      const res = await agent.generate(prompt, { abortSignal: ctrl.signal });
      clearTimeout(timer);
      const text = (res.text ?? '').toString();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        lastError = '模型未返回 JSON';
        // M6-1：原先只 console.warn（随会话消失）。落结构化事件，终端的镜像由 logger 统一给。
        stage('llm:retry', { stage: 'summarize', runId, attempt, error: lastError, durationMs: Date.now() - t0 });
        continue;
      }
      try {
        const parsed = InsightSchema.parse(JSON.parse(m[0]));
        stage('llm:done', {
          stage: 'summarize',
          runId,
          attempt,
          durationMs: Date.now() - t0,
          usage: normalizeUsage(usageOf(res)),
        });
        return { insight: parsed, degraded: false };
      } catch (e) {
        lastError = `JSON 结构校验失败:${(e as Error).message}`;
        stage('llm:retry', { stage: 'summarize', runId, attempt, error: lastError, durationMs: Date.now() - t0 });
        continue;
      }
    } catch (e) {
      clearTimeout(timer);
      lastError = errorText(e);
      stage('llm:retry', { stage: 'summarize', runId, attempt, error: lastError, durationMs: Date.now() - t0 });
      continue;
    }
  }
  return {
    insight: { highlights: [], risks: [], suggestions: [] },
    degraded: true,
    lastError,
  };
}

// 1. collect:调 GitHub 只读集成拉数据(全 GET,零写入)
const collect = createStep({
  id: 'collect',
  description: '调用 GitHub 只读集成拉取 issue 与 commits',
  inputSchema: InsightContextSchema,
  outputSchema: InsightContextSchema,
  execute: async ({ inputData, runId }) => {
    // M6-5：本工作流没有 `terminateStep` 那样的失败收口（四步都不抛异常）,
    // 所以 run:start / run:end 在这里就地落。collect 是第一步 → 落 start。
    runStart({ stage: 'collect', runId, workflow: 'insight-workflow', query: inputData.query });
    const p = stageStart({ stage: 'collect', runId });
    try {
      const client = getGithubReadonlyClient();
      if (!client) {
        // M6-1：原先只 console.warn。收编成 step:done 的字段（「跳过」也要留痕）。
        p.done({ skipped: true, note: 'GitHub 未配置,跳过数据拉取(issue/commit 为空)' });
        return { ...inputData, issues: [], commits: [] };
      }
      const [issues, commits] = await Promise.all([
        client.listIssues({ state: 'all', perPage: 10 }),
        client.listCommits({ perPage: 10 }),
      ]);
      p.done({ issues: issues.length, commits: commits.length });
      return { ...inputData, issues, commits };
    } catch (e) {
      p.fail(e);
      runEnd({ stage: 'collect', runId, status: 'failed', failedStage: 'collect', reason: errorText(e).slice(0, 300) });
      throw e;
    }
  },
});

// 2. summarize:用 insight-agent 汇总洞察。
// 注:当前中继(lanfengai / glm)实测不支持 Mastra 的 structuredOutput(返回 undefined),
// 故直接 plain generate 并约束模型只输出 JSON,再抽取解析。带默认值兜底,解析失败也不中断闭环。
// LLM 调用经 generateInsight 包裹:有界超时 + 重试 + 降级(见上方说明)。
const summarize = createStep({
  id: 'summarize',
  description:
    '用 insight-agent 汇总洞察(plain generate + 解析 JSON,带超时/重试/降级,兼容不支持 structured output 的中继)',
  inputSchema: InsightContextSchema,
  outputSchema: InsightContextSchema,
  execute: async ({ mastra, inputData, runId }) => {
    const p = stageStart({ stage: 'summarize', runId });
    try {
      const agent = mastra.getAgent('insight-agent');
      const data =
        `仓库近期 issue(${inputData.issues?.length ?? 0}):\n` +
        (inputData.issues ?? []).map(i => `#${i.number} [${i.state}] ${i.title}`).join('\n') +
        `\n\n近期 commit(${inputData.commits?.length ?? 0}):\n` +
        (inputData.commits ?? []).map(c => `${c.sha.slice(0, 7)} ${c.message} (@${c.author})`).join('\n');
      const prompt = `请基于以下 GitHub 数据产出项目洞察,**只输出一个 JSON 对象**(不要输出 JSON 以外的任何文字),结构为:
{"highlights":["值得关注的进展,3-5 条"],"risks":["潜在风险或技术债信号"],"suggestions":["给维护者的可执行建议"]}

${data}`;

      const { insight, degraded, lastError } = await generateInsight(agent, prompt, runId);
      // M6-1：降级是**语义上重要的**事实（洞察内容是空的，不是「没有风险」），
      // 必须落结构化事件 —— 原先只有一行 console.warn。
      p.done({ degraded, ...(degraded ? { lastError: (lastError ?? '').slice(0, 300) } : {}) });
      return { ...inputData, insight, llmUnavailable: degraded };
    } catch (e) {
      p.fail(e);
      runEnd({ stage: 'summarize', runId, status: 'failed', failedStage: 'summarize', reason: errorText(e).slice(0, 300) });
      throw e;
    }
  },
});

// 3. notify:飞书推洞察卡片(含确认/重跑按钮),未配置飞书则跳过
const notify = createStep({
  id: 'notify',
  description: '飞书推洞察卡片(含确认/重跑按钮,value 内嵌 runId),未配置飞书则跳过',
  inputSchema: InsightContextSchema,
  outputSchema: InsightContextSchema,
  execute: async ({ inputData, runId }) => {
    // M6-1：早退路径也落 step 事件（「为什么没发卡片」是排障时第一个要问的问题）。
    const p = stageStart({ stage: 'notify', runId });
    if (!getFeishuClient()) {
      p.done({ skipped: true, note: '飞书未配置,跳过通知' });
      return { ...inputData, cardSent: false };
    }
    const ins = inputData.insight;
    const md = [
      `**查询**: ${inputData.query}`,
      '',
      '**亮点**',
      ...(ins?.highlights ?? []).map(h => `- ${h}`),
      '',
      '**风险**',
      ...(ins?.risks ?? []).map(r => `- ${r}`),
      '',
      '**建议**',
      ...(ins?.suggestions ?? []).map(s => `- ${s}`),
    ];
    if (inputData.llmUnavailable) {
      md.push('', '⚠️ **LLM 汇总暂不可用**(中继超时/不可用),以上为原始数据,请人工判断。');
    }
    try {
      const res = await feishuNotify({
        title: '📊 仓库洞察',
        markdown: md.join('\n'),
        buttons: [
          // ⚠️ M8 待改：这里仍是拼接标识 `confirm_<runId>`。
          // 已拍板改为**结构化 value**（`{kind:'insight', action:'confirm'|'rerun', runId}`），
          // 见 `milestones/M8-飞书双向控制.md` §0.2 与 §7 M8-3 —— M6/M7 范围均不含卡片回调。
          { text: '✅ 确认', value: `confirm_${runId}`, type: 'primary' },
          { text: '🔄 重跑', value: `rerun_${runId}`, type: 'default' },
        ],
      });
      if (!res.ok) {
        // M6-1：原先只 console.warn。卡片没发出去 → 后续按钮回调永远等不到，
        // 这条事实必须在文件里（否则只能靠「群里没看到」来推断）。
        p.fail(`飞书推送失败(mode=${res.mode})`, {
          mode: res.mode,
          feishuError: res.error ?? null,
          raw: res.raw ? JSON.stringify(res.raw).slice(0, 300) : null,
        });
        return { ...inputData, cardSent: false };
      }
      p.done({ mode: res.mode });
      return { ...inputData, cardSent: true };
    } catch (e) {
      p.fail(e);
      return { ...inputData, cardSent: false };
    }
  },
});

// 4. confirm:人工确认关卡。首次执行 suspend 等人;resume 后记录反馈并返回终态
const confirm = createStep({
  id: 'confirm',
  description: '人工确认关卡:suspend 等人点卡片按钮,resume 后记录反馈并返回终态',
  inputSchema: InsightContextSchema,
  outputSchema: InsightContextSchema,
  execute: async ({ inputData, suspend, resumeData, runId }) => {
    const p = stageStart({ stage: 'confirm', runId });
    // 未收到 resume → 挂起,等飞书卡片点「确认/重跑」后回调 resume(或手工打 resume 端点)
    if (!resumeData) {
      // M6-5：挂起用 `run:suspend` 表达,**不是** `step:start`
      // （借 step:start 会造出一个没有配对的 start，污染 AC-4 的配对判据）。
      runSuspend({ stage: 'confirm', runId, waitingFor: 'insight-confirm' });
      return suspend({ waitingFor: 'insight-confirm', runId });
    }
    // 已 resume:记录反馈(action 来自卡片按钮 value,approved 来自手工 resume 端点)
    const action = (resumeData as { action?: string }).action;
    const approved = (resumeData as { approved?: boolean }).approved;
    const feedback = action === 'rerun' ? 'rerun' : approved ? 'confirmed' : 'dismissed';
    p.done({ feedback, action: action ?? null });
    // M6-5：本步是终点 → 落唯一一条 run:end。
    // `rerun` 归为 `rejected`：它表示**人工不接受本次洞察产物**（要重跑），
    // 与「确认」是两种相反的结论，用 `ok` 记会把两者混成一种。
    runEnd({
      stage: 'confirm',
      runId,
      status: feedback === 'rerun' ? 'rejected' : 'ok',
      reason: `人工反馈: ${feedback}`,
    });
    return { ...inputData, feedback };
  },
});

/**
 * 组装 workflow。mastra 实例由 index.ts 的 `new Mastra({ workflows })` 注入,
 * 故此处不传 mastra。用 `.then()` 串联,末尾 `.commit()`。
 */
export const insightWorkflow = new Workflow({
  id: 'insight-workflow',
  description: 'M1 只读洞察闭环:拉 GitHub issue/commit → LLM 汇总 → 飞书卡片 → 人工确认 resume(全程零写入)',
  inputSchema: InsightContextSchema,
  outputSchema: InsightContextSchema,
})
  .then(collect)
  .then(summarize)
  .then(notify)
  .then(confirm)
  .commit();
