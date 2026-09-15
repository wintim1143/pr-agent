import { z } from 'zod';
import { Workflow, createStep } from '@mastra/core/workflows';
import type { Mastra } from '@mastra/core';
import { getFeishuConfig, feishuNotify, buildDevCompleteCard } from '../adapters/feishu';
import {
  getGithubConfig,
  githubCheckout,
  githubPushAndOpenPR,
  githubMergePR,
  gitCommit,
  gitDiffForCommit,
} from '../adapters/github';
import { stage, stageStart } from '../progress';

/**
 * 流水线阶段事件埋点(2026-09-14 新增,解决「长等待期无法感知 agent 是否在跑」)。
 *
 * 每个 step 进入/结束/失败都写一条结构化事件到 `logs/dev-workflow.log`(JSON Lines),
 * 同时打到 stdout。此前 coding 步静默等待 5~15 分钟,期间零输出,无法区分
 * 「LLM 正在思考」/「上游挂死」/「子进程已崩」,只能靠 Claude Code 的会话 jsonl
 * 事后考古。埋点后可用 `tail -f logs/dev-workflow.log` 实时观察进度。
 *
 * 事件类型:`step:start` / `step:done` / `step:fail` / `llm:start` / `llm:done` / `llm:retry`
 * 详见 `src/mastra/progress.ts`。
 */

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
 * 结构化闸门输出契约(文档 P3-1,2026-09-02 定稿;2026-09-15 修契约缺失)。
 * - test: 测试闸门,passed 决定是否进入 review
 * - review: 审核闸门,decision 决定通过(approve)或打回(request-changes)
 * - commit: commit 闸门,message 是最终落盘的提交文案
 *
 * ## ⚠️ schema 只是「事后拦截」,契约必须写进 prompt(2026-09-15 教训)
 *
 * 三者原先只在 prompt 里给了**自然语言**说明(test/review 勉强写了个字段列表,commit 一个都没写),
 * 于是模型转而遵循 `dev-agent.ts` 里 skill 声明的**输出形状** —— 而 zod 按自己的字段校验,
 * 两边对不上时闸门恒失败。实测证据(run 2026-09-14):commit 步 3 次重试 byte 级相同,
 * 模型返回 `{type, scope, subject, body}`(commit-message skill 的格式),缺 schema 要的 `message`。
 *
 * 所以本文件的约定是:**每个 schema 的字段必须逐字出现在对应 prompt 的「输出契约」段里**,
 * 并附一个示例。改 schema 必须同步改 prompt —— 只改一边等于把闸门调成恒失败。
 */
const TestGateSchema = z.object({
  passed: z.boolean(),
  report: z.string(),
});
const ReviewGateSchema = z.object({
  decision: z.enum(['approve', 'request-changes']),
  comments: z.array(z.string()),
});
/**
 * commit 闸门输出契约。
 *
 * ⚠️ **`message` 必须非空**(2026-09-14 加 `.min(1)`)。
 * 端到端实测(run 2026-09-14 09:52)模型返回了 `{"message":"","lintPassed":true}` ——
 * zod 里空串是合法 string,校验通过,于是 `git commit -m ""` 报
 * `Aborting commit due to empty commit message`,AC-8 失败但**闸门本身判为通过**。
 * 这是典型的 fail-open:闸门存在的意义是拦住无效产物,空 message 显然是无效产物。
 * 约束收在 schema 层,让 runGate 的重试机制自动兜底(而非等 git 报错)。
 *
 * ## 为什么移除了 `lintPassed`(2026-09-15)
 *
 * 原 schema 有 `lintPassed: z.boolean()`,语义是「commitlint 过了吗」。但:
 * 1. 本项目**没有 commitlint** —— 无依赖、无配置、无 husky hook(已核对 package.json);
 * 2. `npm run lint` 指向 `mwts check`,在本环境冷启动卡死,跑不出 exit code;
 * 3. 于是这个字段**只能由 LLM 猜**,且猜错也无人能证伪 —— 一个恒真/随机的字段,
 *    只会给闸门「这里做过校验」的假象。
 *
 * 依「凡能由程序判定的事实,绝不委托 LLM」的原则,这里**删掉**它。
 * 将来若真要做 lint 闸门,正确形态是 workflow 程序化跑一条真实命令、把 exit code
 * 填进一个**由程序写入**的字段,而不是加回到这个 schema 里让模型回答。
 */
const CommitGateSchema = z.object({
  message: z.string().min(1, 'commit message 不能为空'),
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
  /**
   * PR 网页链接(M3-4 补)。
   *
   * 原先只有 `prNumber`,飞书卡片上就只能显示一个光秃秃的 `#1` —— 收到通知的人
   * 没法一键跳转,得自己去仓库里翻 PR 列表。链接是 push-open-pr 步从 REST 响应里
   * 已经拿到的字段(`html_url`),此前只是没往上下文里存。
   */
  prUrl: z.string().optional(),
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
  const t0 = Date.now();
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      stage('llm:start', { stage: 'gate', attempt, maxAttempts });
      const res = await agent.generate(prompt);
      const obj = extractJson(res.text);
      const parsed = schema.safeParse(obj);
      if (!parsed.success) {
        throw new Error(
          `GATE_SCHEMA_INVALID: 闸门输出不符合 schema —— ${parsed.error.message.slice(0, 300)}` +
            ` | 模型原文(前 200 字): ${String(res.text).slice(0, 200)}`,
        );
      }
      stage('llm:done', { stage: 'gate', attempt, durationMs: Date.now() - t0 });
      return parsed.data as z.infer<S>;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[runGate] 第 ${attempt}/${maxAttempts} 次闸门调用失败: ${lastErr.message}`);
      stage('llm:retry', { stage: 'gate', attempt, maxAttempts, error: lastErr.message.slice(0, 200) });
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
/**
 * 构造闸门输入里的「改动上下文」段 —— 把**真实 diff** 喂给质量闸门(2026-09-15)。
 *
 * ## 为什么必须喂(原实现的致命缺陷)
 *
 * 修之前,test / review 两个闸门的 prompt **只插了 `issueTitle`**,从头到尾没传过 diff
 * 或 codingResult。也就是说模型被要求「对当前改动运行测试」「审核当前改动」,
 * 却**看不见任何改动**。它返回 `passed=false` / `request-changes` 不是乱判 ——
 * 是正确地拒绝为看不见的东西背书(fail-closed)。闸门因此恒判负,等于废掉。
 *
 * 讽刺的是 commit 闸门反而传了 diff(2026-09-14 补),只是没传契约 —— **两条闸门各缺一半**。
 * 本次把 diff 输入统一补齐,commit 那边的契约也一并钉死。
 *
 * ## 为什么复用 `gitDiffForCommit` 而不是各写一份
 *
 * 它取的是「工作树 ∪ 已提交」的并集(coding 的改动此刻还在工作树里未提交),
 * 与 `verify-local-write.js` 的 AC-2 判据同源,保证「闸门看到的」与「验收看到的」一致。
 *
 * @param maxChars 截断上限;不传则由 `gitDiffForCommit` 读 `COMMIT_DIFF_MAX_CHARS`(默认 8000)
 */
function buildChangeContext(maxChars?: number): { text: string; diffChars: number; truncated: boolean } {
  const { stat, diff, truncated } = gitDiffForCommit('main', maxChars);
  const text =
    `【改动统计】\n${stat || '(无 diff stat)'}\n\n` +
    `【改动内容 diff】\n${diff || '(无 diff 内容 —— 工作树与目标分支均无差异)'}`;
  return { text, diffChars: diff.length, truncated };
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
    const p = stageStart('checkout');
    try {
      const branch = await githubCheckout(inputData.issueNumber, inputData.issueTitle);
      p.done({ branch });
      return { ...inputData, branch };
    } catch (e) {
      // 2026-09-07 改:原实现失败后返回占位分支名 `feat/<n>-dev` 并仅 warn,**不阻断**。
      // 后果:分支其实没建成,后续 coding 仍在原分支(可能是 main)上改文件、commit 也落在那里,
      // 而 AC-1「当前分支 = feat/<n>-<slug>」会因占位名看起来成立 —— 典型的假绿。
      // 建分支失败没有安全的降级路径,必须显式失败。
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[checkout] 建分支失败,终止流程(不降级到占位分支名): ${msg}`);
      p.fail(e);
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
    const p = stageStart('coding');
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
      p.fail('SKIPPED_NO_CREDENTIALS: 未发现编码后端凭据');
      throw new Error('SKIPPED_NO_CREDENTIALS: 未发现编码后端凭据,编码未执行');
    }
    try {
      const agent = await getCodingAgent(getRepoRoot());
      const timeoutMs = Number(process.env.CODING_TIMEOUT_MS ?? 600_000);
      const prompt =
        `你在一个 git 仓库的 feature 分支 \`${inputData.branch}\` 上。请实现以下 issue 对应的代码改动:\n\n` +
        `**标题**: ${inputData.issueTitle}\n` +
        (inputData.issueBody ? `**描述**:\n${inputData.issueBody}\n` : '') +
        '\n要求:\n- 直接修改仓库中的文件(不要只输出代码片段)\n' +
        '- 保持代码风格一致\n- 完成后简要说明你改了哪些文件、为什么\n' +
        '- 不要 git commit(后续 commit 步会提交)';

      // 关键观测点(2026-09-14):编码是唯一「分钟级静默阻塞」的步骤。此处显式打出
      // 「即将调用、超时预算多少」,让使用者知道**等待是预期的**而非挂死。
      stage('llm:start', { stage: 'coding', timeoutMs, repoRoot: getRepoRoot(), branch: inputData.branch });

      // 心跳(2026-09-14):每 HEARTBEAT_MS 打一条,证明进程活着。Claude Code CLI 内部
      // 无法逐轮回调(见下方 stream 方案评估),心跳是当前唯一能区分「慢」与「死」的手段。
      // 默认 30s,设 PR_AGENT_HEARTBEAT_MS=0 可关闭。
      const heartbeatMs = Number(process.env.PR_AGENT_HEARTBEAT_MS ?? 30_000);
      const t0 = Date.now();
      const heartbeat = heartbeatMs > 0
        ? setInterval(() => {
            stage('llm:done', {
              stage: 'coding',
              heartbeat: true,
              elapsedMs: Date.now() - t0,
              note: '编码子进程仍在运行(此为心跳,非完成)',
            });
          }, heartbeatMs)
        : undefined;

      let res;
      try {
        res = await withCodingGuard(agent.generate([{ role: 'user', content: prompt }]), timeoutMs);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }

      stage('llm:done', { stage: 'coding', durationMs: Date.now() - t0, resultLen: String(res.text ?? '').length });
      p.done({ durationMs: Date.now() - t0 });
      return { ...inputData, codingResult: res.text ?? '(no output)' };
    } catch (e) {
      // 2026-09-07 改:同上 —— 编码失败后 test/review/commit 失去意义,不降级、不占位,直接终止。
      // 实测依据(2026-09-07):编码因后端 502 超时 600s 后,后续 test 步仍基于空改动继续调用
      // LLM 并因 502 失败,整个 run 变成「两次超时的叠加」,错误信息反而更难读。
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[coding] ClaudeSDKAgent 执行异常,终止流程:', msg);
      p.fail(e);
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
    const p = stageStart('test');
    try {
      // 2026-09-15 修:原先 prompt 只给 issueTitle,模型看不见改动 → 恒判 false(盲评)。
      // 现在把真实 diff + coding 自述一起喂进去,判定才有依据。
      const change = buildChangeContext();
      stage('llm:start', { stage: 'test', diffChars: change.diffChars, truncated: change.truncated });
      const testResult = await runGate(
        mastra,
        `使用 code-testing skill 对**下列改动**运行/评估测试。\n\n` +
          `【需求】${inputData.issueTitle}\n\n` +
          `【编码者自述】\n${(inputData.codingResult ?? '(无)').slice(0, 1500)}\n\n` +
          `${change.text}\n\n` +
          `【输出契约(强制)】只输出一个 JSON 对象,字段如下(不得增删):\n` +
          `{\n  "passed": boolean,   // 改动是否可安全进入审核\n  "report": string      // 你根据上面 diff 得出的结论与依据\n}\n` +
          `示例:{"passed":true,"report":"新增 README 安装小节,两条命令与需求一致;纯文档改动无测试可跑。"}\n\n` +
          `【判定依据】passed 必须基于**上面看到的真实改动**。若仓库存在可执行测试,以其结果为准;` +
          `若为纯文档/配置类改动(无可执行测试),则判断改动本身是否满足需求、是否引入破坏性变更。` +
          `改动为空或明显不完整时判 false,并在 report 里说明缺什么。**不要为看不见的内容背书。**`,
        TestGateSchema
      );
      // M3-8:闸门判负 → **显式终止**,不再往下走 review / commit / push-open-pr。
      //
      // ## 为什么是 throw,而不是 Mastra 条件边(`.branch()`)
      //
      // 卡里原本设想的形态是「条件边判负则终止」。实测否定了这个方案
      // (证据:`.tmp/branch-probe.js` / `.tmp/branch-probe2.js`,@mastra/core 1.63.2):
      //
      // 1. **branch 的多条条件不是互斥的,而是「谁为真谁就执行」**。兜底分支
      //    (`async () => true`)会让**所有**分支都跑 —— 实测 `b-pass` 与 `b-other`
      //    在同一次运行里都执行了。没有「else」语义,无法表达「二选一」。
      // 2. **branch 之后链接的 `.then(step)` 收到的 inputData 是聚合对象**
      //    `{ '<stepId>': <该步输出>, ... }`,不再是上一步的输出。实测 c 的入参是
      //    `{"b-pass":{...},"b-other":{...}}`,于是 `inputData.branch` / `inputData.prNumber`
      //    全部读不到 —— 与本文件「八步全链路共用同一个 ContextSchema」的约定直接冲突。
      // 3. branch 内 step 抛错 → run `status=failed` 且后续步骤不执行(实测)。**终止本来就该用 throw**。
      //
      // 结论:闸门判负的终止路径用「step 内显式失败」表达 —— 语义等价(后续一律不执行),
      // 且是 fail-closed。**有意只做「终止」,不做「回退 coding 重做」**:回退需要循环
      // (`.dowhile()`)+ 次数上限 + 失败累积策略,属独立工作量,M3 范围外(见卡 §7 M3-8)。
      if (!testResult.passed) {
        const msg =
          `GATE_REJECTED@test: 测试闸门判负,终止流水线(不进入 review/commit/push)。` +
          `报告: ${testResult.report.slice(0, 300)}`;
        p.fail(msg, { passed: false });
        throw new Error(msg);
      }
      p.done({ passed: true });
      return { ...inputData, testResult };
    } catch (e) {
      p.fail(e);
      throw e;
    }
  },
});

// 4. review(强制):代码审核 skill
const review = createStep({
  id: 'review',
  description: '调用代码审核 skill,输出 approve 或 request changes',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const p = stageStart('review');
    try {
      // 2026-09-15 修:同 test 步 —— 原先只给 issueTitle,review 看不见改动 → 恒判 request-changes。
      const change = buildChangeContext();
      stage('llm:start', { stage: 'review', diffChars: change.diffChars, truncated: change.truncated });
      const reviewResult = await runGate(
        mastra,
        `使用 code-review skill 审核**下列改动**。\n\n` +
          `【需求】${inputData.issueTitle}\n\n` +
          `【编码者自述】\n${(inputData.codingResult ?? '(无)').slice(0, 1500)}\n\n` +
          `${change.text}\n\n` +
          `【输出契约(强制)】只输出一个 JSON 对象,字段如下(不得增删):\n` +
          `{\n  "decision": "approve" | "request-changes",  // 只能是这两个字面量之一\n  "comments": string[]                         // 逐条具体意见;approve 时可为空数组\n}\n` +
          `示例:{"decision":"approve","comments":[]}\n\n` +
          `【判定依据】decision 必须基于**上面看到的真实改动**:仅当改动满足需求且无明显缺陷时 approve;` +
          `否则 request-changes,并在 comments 里逐条指出具体问题(定位到文件/行为,不要泛泛而谈)。` +
          `**不要为看不见的内容背书。**`,
        ReviewGateSchema
      );
      // M3-8:审核判负 → **显式终止**(同 test 步,理由与 branch 实测结论见该步注释)。
      // 这一条比 test 那条更关键:review 通过与否决定「这次改动值不值得进远端」。
      // 修之前 review 判 `request-changes` 后流程**照旧 commit 并 push 开 PR** ——
      // 等于把「审核明确否决的改动」推到远端,而 PR 描述里还写着 decision=request-changes。
      // M2 时代价有限(只落在本地工作区),M3 起改动会被推到真实仓库,误判代价不可逆。
      if (reviewResult.decision === 'request-changes') {
        const msg =
          `GATE_REJECTED@review: 审核判 request-changes,终止流水线(不进入 commit/push)。` +
          `意见: ${reviewResult.comments.join('; ').slice(0, 300) || '(无)'}`;
        p.fail(msg, { decision: 'request-changes' });
        throw new Error(msg);
      }
      p.done({ decision: 'approve' });
      return { ...inputData, reviewResult };
    } catch (e) {
      p.fail(e);
      throw e;
    }
  },
});

// 5. commit(强制):commit message skill + 真实 git commit
const commit = createStep({
  id: 'commit',
  description: '调用 commit-message skill 生成 Conventional Commits 并实际提交',
  inputSchema: ContextSchema,
  outputSchema: ContextSchema,
  execute: async ({ mastra, inputData }) => {
    const p = stageStart('commit');
    try {
      // 2026-09-15 修:改用公共 helper(不再各写一份 diff 取法),并把「输出契约」逐字写进 prompt。
      // 原实现只写「使用 commit-message skill 生成 commit message」——模型于是按 skill 声明的
      // {type, scope, subject, body} 输出,而 schema 要 {message}:两边对不上,3 次重试全挂。
      const change = buildChangeContext();
      stage('llm:start', { stage: 'commit', diffChars: change.diffChars, truncated: change.truncated });

      const commitResult = await runGate(
        mastra,
        `使用 commit-message skill 为**下列改动**生成 commit message,关联 issue #${inputData.issueNumber}。\n\n` +
          `【需求】${inputData.issueTitle}\n\n` +
          `${change.text}\n\n` +
          `【输出契约(强制)】只输出一个 JSON 对象,字段如下(不得增删):\n` +
          `{\n  "message": string   // 完整的 Conventional Commits 提交信息。首行形如 "docs(readme): add install section",可附 body 段;不得为空\n}\n` +
          `示例:{"message":"docs(readme): add install section\\n\\nAdd git clone and npm install steps.\\n\\nCloses #1"}\n\n` +
          `注意:message 用 \\n 表示换行。不要输出 type / scope / subject / body 这类拆分字段,` +
          `也不要输出 command 字段 —— 只要上面这一个 message 字符串。`,
        CommitGateSchema
      );
      // 真正落盘:把当前改动 commit 到 feature 分支(git add -A + commit)
      try {
        const r = gitCommit(commitResult.message);
        if (!r.committed && r.error && r.error !== 'nothing-to-commit') {
          console.warn('[commit] 未产生提交:', r.error);
        }
        p.done({ committed: r.committed, message: commitResult.message.slice(0, 60) });
      } catch (e) {
        console.warn('[commit] git commit 异常:', e instanceof Error ? e.message : e);
        p.done({ committed: false, gitError: e instanceof Error ? e.message : String(e) });
      }
      return { ...inputData, commitResult };
    } catch (e) {
      p.fail(e);
      throw e;
    }
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
    const p = stageStart('push-open-pr');
    try {
      const res = await githubPushAndOpenPR({
        branch: inputData.branch ?? `feat/${inputData.issueNumber}-dev`,
        title: `${inputData.issueTitle} (#${inputData.issueNumber})`,
        body: buildPrBody(inputData),
      });
      if (res.error) {
        // ⚠️ M3 起**显式阻断**,不再只 console.warn 后继续往下走。
        // 原因(2026-09-15 · M3-3):推不动远端却继续,流程会走到 merge 步并
        // suspend 等人 approve —— 那是一个**永远不会被点掉的挂起**(根本没有 PR 可合)。
        // 静默失败比崩溃更难排查:M2 零远端时「继续」的代价只是白跑一遍,
        // M3 真写远端后,判断依据(有没有 PR)与流程状态(等 approve)会互相矛盾。
        // M3 卡 §10 异常表:影响远端的失败必须显式阻断,不得降级为「仅告警」。
        p.fail(res.error);
        throw new Error(`[push-open-pr] 失败: ${res.error}`);
      } else if (res.skipped) {
        console.warn('[push-open-pr] 未配置 GitHub,已跳过');
        p.done({ skipped: true });
      } else if (res.prUrl) {
        console.log('[push-open-pr] PR 已开:', res.prUrl);
        p.done({ prNumber: res.prNumber, prUrl: res.prUrl });
      } else {
        p.done({});
      }
      // M3-4:把 PR 链接一并带进上下文,供 notify 步渲染成卡片上的可点链接。
      // 注意 `?? undefined`:`PushPrResult.prUrl` 是 `string | null`,而 ContextSchema
      // 的 prUrl 是 `z.string().optional()`(不接受 null)。直接透传会让 zod 校验失败。
      return { ...inputData, prNumber: res.prNumber, prUrl: res.prUrl ?? undefined };
    } catch (e) {
      p.fail(e);
      throw e;
    }
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
    const p = stageStart('notify');
    try {
      const res = await feishuNotify(
        buildDevCompleteCard({
          issueNumber: inputData.issueNumber,
          issueTitle: inputData.issueTitle,
          branch: inputData.branch,
          prNumber: inputData.prNumber,
          prUrl: inputData.prUrl,
        })
      );
      if (!res.ok) {
        console.warn(`[notify] 飞书推送失败(mode=${res.mode}):`, res.error || JSON.stringify(res.raw));
        p.fail(`飞书推送失败(mode=${res.mode})`);
      } else {
        p.done({ mode: res.mode });
      }
    } catch (e) {
      console.warn('[notify] 飞书推送异常:', e instanceof Error ? e.message : e);
      p.fail(e);
    }
    return inputData;
  },
});

/**
 * 人工合并关卡的三种结局(M3-5 定稿,2026-09-15)。
 *
 * `resumeData` 有三种形态,必须**分别**处理,不能都归到「没批准就挂起」:
 *
 * | 输入 | 语义 | 动作 |
 * |---|---|---|
 * | 从未 resume(首次执行) | 还没人看 | `suspend()` 挂起等人 |
 * | `resume({ approved: true })`  | 批准 | 真 squash merge |
 * | `resume({ approved: false })` | **明确拒绝** | **终止**,PR 保持 open |
 *
 * ## 为什么「明确拒绝」不能落回 suspend
 *
 * 原实现写成 `if (!resumeData || !approved) suspend()` —— 于是「明确拒绝」和
 * 「还没表态」走了同一条路:**拒绝之后又挂起一次**。用户在卡片上点「❌ 拒绝」,
 * 会看到同一张卡片再次出现,再点再出现 —— 一个**永远点不掉的循环**,
 * 和 M3-3 里「push 失败仍走到 suspend」是同一类坑(挂起状态与真实意图矛盾)。
 *
 * ## 为什么拒绝时 run 状态是 success 而不是 failed
 *
 * 「拒绝」是**合法的人工决策**,不是流水线故障。把它记成失败会污染
 * 「哪些 run 真的坏了」这一判断;正确做法是正常结束 + `mergeResult` 写明结局。
 */
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
    const decision = (resumeData ?? {}) as { approved?: boolean };

    // ① 明确拒绝 → 终止(不合并,也不再挂起,理由见上方注释块)
    if (resumeData && decision.approved === false) {
      const p = stageStart('merge', 'rejected');
      const mergeResult = 'merge-skipped: 用户明确拒绝,PR 保持 open(未合并,可由人工处置)';
      console.log(`[merge] ${mergeResult}`);
      // 刻意不关 PR:关闭是另一个不可逆动作,且「拒绝合并」与「废弃这个 PR」
      // 不是同一件事 —— 留 open 让人自己决定关还是改。
      p.done({ merged: false, reason: 'user-rejected' });
      return { ...inputData, mergeResult };
    }

    // ② 尚未表态(首次进入 / resume 未带 approved)→ 挂起等人确认
    if (decision.approved !== true) {
      stage('step:start', { stage: 'merge', waitingFor: 'merge-approval' });
      return suspend({
        waitingFor: 'merge-approval',
        issueNumber: inputData.issueNumber,
      });
    }

    // ③ 批准 → 真合并
    const p = stageStart('merge', 'resumed');
    // 已确认:真实合并。没开出 PR(prNumber=0)就没东西可合,标记失败供上层判读。
    if (!inputData.prNumber || inputData.prNumber <= 0) {
      const mergeResult = `merge-skipped: 无已开 PR(prNumber=${inputData.prNumber ?? 0}),无法合并`;
      console.warn(`[merge] ${mergeResult}`);
      p.done({ merged: false, reason: 'no-pr' });
      return { ...inputData, mergeResult };
    }
    try {
      const res = await githubMergePR(inputData.prNumber);
      const mergeResult = res.merged
        ? `merge-ok: PR #${inputData.prNumber} 已 squash 合入(sha=${res.sha})`
        : `merge-fail: ${res.message ?? '未知原因'}`;
      if (!res.merged) {
        console.warn(`[merge] ${mergeResult}`);
        p.fail(mergeResult);
      } else {
        console.log(`[merge] ${mergeResult}`);
        p.done({ merged: true, sha: res.sha });
      }
      return { ...inputData, mergeResult };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const mergeResult = `merge-error: ${msg}`;
      console.error(`[merge] ${mergeResult}`);
      p.fail(e);
      return { ...inputData, mergeResult };
    }
  },
});

/**
 * 组装 workflow。
 * - `mastra` 不在此传入:由 index.ts 的 `new Mastra({ workflows })` 自动注入。
 * - 用 `.then()` 串联步骤(第一个步骤也用 `.then()`),末尾 `.commit()`。
 * - **闸门判负的终止不走 Mastra 条件边**:实测 `1.63.2` 的 `.branch()` 多条件不互斥、
 *   且分支后 `.then()` 的 inputData 会变成 `{stepId: output}` 聚合对象(证据 `.tmp/branch-probe*.js`),
 *   与「全链路共用 ContextSchema」冲突。改为「闸门内显式 throw」,见 test / review 两步的注释。
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
