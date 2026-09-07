import { z } from 'zod';
import { Workflow, createStep } from '@mastra/core/workflows';
import type { Mastra } from '@mastra/core';
import { getFeishuConfig, feishuNotify, buildDevCompleteCard } from '../adapters/feishu';
import { getGithubConfig, githubCheckout, githubPushAndOpenPR, githubMergePR, gitCommit } from '../adapters/github';

/**
 * 自动开发 workflow 骨架(对应文档 §六)。
 *
 * 设计原则:
 * - 质量闸门(coding/test/review/commit/merge)由 Mastra workflow **强制顺序**保证,
 *   每个闸门 step 内部调 dev-agent 并让它加载对应 skill(确定性编排,非自主循环)。
 * - merge 是人工关卡:用 execute 里的 `suspend()` 挂起,等用户在飞书卡片点"合并"后
 *   `resume({ approved: true })` 再真正执行合并。
 * - checkout / push-open-pr 已接入 GitHub adapter(见 `../adapters/github`):
 *   checkout 用本地 git 建分支,push-open-pr 用 `git push`(token 内嵌 HTTPS)+ REST `POST /pulls` 开 PR。
 *   全链路不依赖 `gh` CLI(见 K5 决策)。
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
  /**
   * M2 的「零远端」开关(2026-09-07)。
   *
   * `devWorkflow` 是八步全串,末尾三步 push-open-pr / notify / merge 都会接触远端或远端语义:
   * push 会真推分支、merge 会 suspend 等人工 approve。M2 的范围是「本地写入闭环」,
   * 不截断就会真 push 或卡在 suspend 上 —— 两者都违反零远端。
   *
   * 为真时这三步直接原样返回、不执行任何副作用。默认 `false`,
   * 因此 M3 不传该字段行为与改造前完全一致。
   */
  stopAfterCommit: z.boolean().optional(),
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
 *
 * ## 为什么不走 Mastra `structuredOutput`(2026-09-07 修复)
 *
 * 实测当前中继(lanfengai / glm-5.2)**不支持** Mastra 的 structuredOutput ——
 * `res.object` 返回 `undefined`,`errorStrategy: 'strict'` 直接抛
 * `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED`(与 insight-workflow 2026-09-03 踩的是同一个坑,
 * 见其 summarize 步注释)。闸门因此永远失败,M2 端到端卡在 review 步。
 *
 * 改为:plain generate + 提示词强制「只输出 JSON」→ 从文本中抽取 JSON → **zod 严格解析**。
 * 解析失败仍抛错(fail-closed,与原 strict 策略语义一致)—— 闸门宁可不通过,不能假通过。
 */
async function runGate<S extends z.ZodTypeAny>(mastra: Mastra, instruction: string, schema: S): Promise<z.infer<S>> {
  const agent = mastra.getAgent('dev-agent');
  const prompt =
    `${instruction}\n\n【输出格式(强制)】最终回答只输出一个 JSON 对象,不要包含任何解释性文字或代码围栏以外的内容。`;
  // 重试(2026-09-07 补):glm 中继偶发**空响应**(res.text 为空,2026-09-07 review 步实测),
  // 以及偶发不守 JSON 格式。这类瞬时故障重试即可恢复,不该直接炸掉整条流水线。
  // 重试仍失败则抛错(fail-closed)——闸门宁可不通过,不能假通过。
  const maxAttempts = Number(process.env.GATE_MAX_ATTEMPTS ?? 3);
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await agent.generate(prompt);
      const obj = extractJson(res.text);
      const parsed = schema.safeParse(obj);
      if (!parsed.success) {
        throw new Error(
          `GATE_SCHEMA_INVALID: 闸门输出不符合 schema —— ${parsed.error.message.slice(0, 300)}` +
            ` | 模型原文(前 200 字): ${String(res.text).slice(0, 200)}`,
        );
      }
      return parsed.data as z.infer<S>;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[runGate] 第 ${attempt}/${maxAttempts} 次闸门调用失败: ${lastErr.message}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr ?? new Error('GATE_FAILED: 闸门调用未知失败');
}

/** 从模型自由文本中抽取第一个 JSON 对象。找不到 / 解析失败都抛错(闸门 fail-closed)。 */
function extractJson(text: string | undefined | null): unknown {
  if (!text?.trim()) throw new Error('GATE_EMPTY_OUTPUT: 模型未返回任何内容');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i); // 容错:模型爱套 ```json 围栏
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`GATE_NO_JSON: 输出中找不到 JSON 对象,原文(前 200 字): ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`GATE_JSON_PARSE_FAILED: JSON 解析失败(${msg}),原文(前 200 字): ${text.slice(0, 200)}`);
  }
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
      // 2026-09-07 改:原实现失败后返回占位分支名 `feat/<n>-dev` 并仅 warn,**不阻断**。
      // 后果:分支其实没建成,后续 coding 仍在原分支(可能是 main)上改文件、commit 也落在那里,
      // 而 AC-1「当前分支 = feat/<n>-<slug>」会因占位名看起来成立 —— 典型的假绿。
      // 建分支失败没有安全的降级路径,必须显式失败。
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[checkout] 建分支失败,终止流程(不降级到占位分支名): ${msg}`);
      throw e;
    }
  },
});

/**
 * 编码执行的超时守卫(2026-09-07 补)。
 *
 * 为什么必须有:CLI 子进程可能因后端 502、本机 `reg.exe` 被安全策略拦截、或单纯卡死而
 * **永不返回**。没有守卫时整条 workflow 会被冻住,既不报错也不产出 —— 无法与"还在跑"区分。
 * M1 的同类教训:LLM 中继挂起曾冻结整条 suspend/resume 闭环,靠守卫才解掉。
 *
 * 超时是**显式失败**(抛错并被 coding 步捕获写成 `ERROR: GUARD_TIMEOUT@coding`),
 * 不是静默截断 —— 调用方据此能判定"这次没跑完",而不是拿到一个看似正常的结果。
 */
function withCodingGuard<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`GUARD_TIMEOUT@coding: 超过 ${ms}ms 未返回(编码子进程可能挂起)`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

// 2. coding:用 ClaudeSDKAgent(Claude Code CLI)真正读写文件(替代 dev-agent 纯文本)
const coding = createStep({
  id: 'coding',
  description: '用 ClaudeSDKAgent 在 feature 分支上真正读写文件完成编码',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    // 懒加载编码执行体:避免 Midway app 启动时静态拉入 @mastra/claude(其 ESM 依赖在 jest/部分运行时环境会干扰框架初始化)
    const { getCodingAgent, missingCodingCredentials, getRepoRoot } = await import('../agents/coding-agent.js');
    if (missingCodingCredentials()) {
      // 用 error 而非 warn:走到这里意味着「编码这个核心能力根本没执行」,静默降级会让
      // 后续 test/review/commit 全部基于空结果跑完,表面上全绿实则什么都没做。
      // 凭据判定逻辑与历史坑见 coding-agent.ts 的 missingCodingCredentials 注释。
      console.error(
        '[coding] 未发现任何编码后端凭据,跳过真实编码。已检查:进程 env 的 ANTHROPIC_API_KEY/CLAUDE_API_KEY、' +
          'CODING_ANTHROPIC_*、以及 ~/.claude/settings.json 的 env 块。' +
          '若本机 Claude Code 可正常使用,请确认 ~/.claude/settings.json 里存在 env.ANTHROPIC_BASE_URL;' +
          '否则显式设置 CODING_ANTHROPIC_BASE_URL / CODING_ANTHROPIC_API_KEY。'
      );
      // 2026-09-07 改:原先返回占位串继续跑,于是 test/review/commit 基于「什么都没改」的空仓库
      // 全部跑完,末尾还可能提交一个空 commit —— 表面走完全流程,实质零产出且难判别。
      // 编码是后续一切闸门的输入,它没跑就等于这次运行没有意义,应当终止。
      throw new Error('SKIPPED_NO_CREDENTIALS: 未发现编码后端凭据,编码未执行');
    }
    try {
      const agent = await getCodingAgent(getRepoRoot());
      const timeoutMs = Number(process.env.CODING_TIMEOUT_MS ?? 600_000);
      const res = await withCodingGuard(
        agent.generate([
        {
          role: 'user',
          content:
          `你在一个 git 仓库的 feature 分支 \`${inputData.branch}\` 上。请实现以下 issue 对应的代码改动:\n\n` +
            `**标题**: ${inputData.issueTitle}\n` +
            (inputData.issueBody ? `**描述**:\n${inputData.issueBody}\n` : '') +
            '\n要求:\n- 直接修改仓库中的文件(不要只输出代码片段)\n' +
            '- 保持代码风格一致\n- 完成后简要说明你改了哪些文件、为什么\n' +
            '- 不要 git commit(后续 commit 步会提交)',
        },
        ]),
        timeoutMs
      );
      return { ...inputData, codingResult: res.text ?? '(no output)' };
    } catch (e) {
      // 2026-09-07 改:同上 —— 编码失败后 test/review/commit 失去意义,不降级、不占位,直接终止。
      // 实测依据(2026-09-07):编码因后端 502 超时 600s 后,后续 test 步仍基于空改动继续调用
      // LLM 并因 502 失败,整个 run 变成「两次超时的叠加」,错误信息反而更难读。
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[coding] ClaudeSDKAgent 执行异常,终止流程:', msg);
      throw e;
    }
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

// 6. push + open PR(已接入 GitHub adapter:git push + REST POST /repos/{o}/{r}/pulls)
const pushOpenPr = createStep({
  id: 'push-open-pr',
  description: 'push feature 分支并开 PR',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData }) => {
    if (inputData.stopAfterCommit) {
      // M2「零远端」:不 push、不开 PR。与「未配置 GitHub」走同一出口(prNumber=0),
      // 下游 merge 步据此判定无可合对象。
      return { ...inputData, prNumber: 0 };
    }
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
    if (inputData.stopAfterCommit) {
      // M2 不发卡片:buildDevCompleteCard 是「PR 已开、待合并」语义,与本地写入闭环不符,
      // 发出去只会误导(卡片上的 PR 号是 0)。
      return inputData;
    }
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

// 8. merge(强制,需用户确认):suspend 等人点"合并"→ REST squash merge 合入 base
const merge = createStep({
  id: 'merge',
  description: '用户确认后经 GitHub REST API 对 PR 执行 squash merge',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData, suspend, resumeData }) => {
    // M2:不进人工合并关卡。必须在 suspend 之前判断,否则 workflow 会停在这里等人 approve,
    // 而 M2 根本没有可合的 PR —— 那是一个永远不会被点掉的挂起。
    if (inputData.stopAfterCommit) {
      return { ...inputData, mergeResult: '(skipped: stopAfterCommit,M2 不执行合并关卡)' };
    }
    // 未收到用户确认 → 挂起,等飞书卡片点"合并"后 resume({ approved: true })
    if (!resumeData || !(resumeData as { approved?: boolean }).approved) {
      return suspend({
        waitingFor: 'merge-approval',
        issueNumber: inputData.issueNumber,
      });
    }
    // 已确认:真实合并。没开出 PR(prNumber=0)就没东西可合,标记失败供上层判读。
    if (!inputData.prNumber || inputData.prNumber <= 0) {
      const mergeResult = `merge-skipped: 无已开 PR(prNumber=${inputData.prNumber ?? 0}),无法合并`;
      console.warn(`[merge] ${mergeResult}`);
      return { ...inputData, mergeResult };
    }
    try {
      const res = await githubMergePR(inputData.prNumber);
      const mergeResult = res.merged
        ? `merge-ok: PR #${inputData.prNumber} 已 squash 合入(sha=${res.sha})`
        : `merge-fail: ${res.message ?? '未知原因'}`;
      if (!res.merged) console.warn(`[merge] ${mergeResult}`);
      else console.log(`[merge] ${mergeResult}`);
      return { ...inputData, mergeResult };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const mergeResult = `merge-error: ${msg}`;
      console.error(`[merge] ${mergeResult}`);
      return { ...inputData, mergeResult };
    }
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
