import { Agent } from '@mastra/core/agent';
import { llmModelConfig } from '../config';

/**
 * insight-agent(M1-4):只读洞察闭环的「汇总」环节。
 *
 * 由 insight-workflow 的 summarize 步按强制顺序调用,用 `structuredOutput` 把 GitHub 原始数据
 * 汇总成结构化洞察 { highlights, risks, suggestions }。`result.object` 直接给结构化对象,
 * 不用解析 LLM 自由文本。
 *
 * model 由 `../config` 的 `llmModelConfig` 提供(全环境变量,适配任意 OpenAI 兼容中转站)。
 * GET /api/agents 只列元数据不触发 generate,故不影响接入验证。
 */

export const insightAgent = new Agent({
  id: 'insight-agent',
  name: '洞察汇总 Agent',
  instructions: `你是项目洞察助手。输入是从 GitHub 拉取的近期 issue 与提交记录原始数据,请产出结构化洞察:
- highlights:近期最值得关注的点,按重要性排序,3-5 条,每条一句话
- risks:潜在风险或技术债信号
- suggestions:给维护者的可执行建议
只基于提供的数据分析,不要编造未提供的仓库事实;用中文输出。`,
  model: llmModelConfig,
});
