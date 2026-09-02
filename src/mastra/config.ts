import 'dotenv/config';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';

/**
 * LLM 接入配置 —— 全部走环境变量,支持任意 OpenAI 兼容中转站(relay)。
 *
 * ## 为什么用 OpenAICompatibleConfig,而不是 'openai/<model>' 字符串
 *
 * - 中转站(one-api / new-api / 各类 relay)几乎只实现 **OpenAI Chat Completions** 协议;
 *   Mastra 默认的 `openai/<model>` 走的是 **Responses API**,多数中转站不兼容,会直接 404/报错。
 * - `OpenAICompatibleConfig` 在运行时被 Mastra 解析为
 *   `createOpenAICompatible({ name, apiKey, baseURL: url }).chatModel(modelId)`,
 *   即标准 `/chat/completions`,且 baseURL / apiKey / 模型名全部显式可控。
 *
 * ## 环境变量(模板见仓库根 `.env.example`)
 *
 * - `LLM_PROVIDER`  自定义 provider 名(任意字符串,仅作标识,默认 `relay`)
 * - `LLM_MODEL`     中转站提供的模型名,如 `gpt-5` / `gpt-4o` / `deepseek-chat`,**必填**
 * - `LLM_BASE_URL`  中转站 base URL,必须包含到 `/v1` 这一级,如 `https://relay.example.com/v1`,**必填**
 * - `LLM_API_KEY`   中转站密钥,**必填**
 *
 * ## 关于「加载时不抛错」
 *
 * 本模块在 `src/mastra/index.ts` 被加载,而 `npm test` 会 `require('../../src/mastra')`,
 * 且 `GET /api/agents` 只列元数据不触发 generate。若在此处对缺失配置抛错,会拖垮测试与接口。
 * 因此这里**只构建配置对象**,真正缺失配置只会在 `agent.generate()` 时由 Mastra 暴露清晰的
 * 鉴权/连接错误。需要提前暴露缺失项时,调用 `missingLlmConfig()`。
 */

const provider = process.env.LLM_PROVIDER ?? 'relay';
const modelId = process.env.LLM_MODEL ?? '';
const baseURL = process.env.LLM_BASE_URL ?? '';
const apiKey = process.env.LLM_API_KEY ?? '';

export const llmModelConfig: OpenAICompatibleConfig = {
  // id 形如 'relay/gpt-5':前半是 provider 标识,后半是中转站模型名。
  // 缺失时占位 'unset',保证 id 形态合法(真正报错推迟到 generate 时由中继暴露)。
  id: `${provider}/${modelId || 'unset'}`,
  url: baseURL || undefined,
  apiKey: apiKey || undefined,
};

/**
 * 返回缺失的必填项;空数组表示三项齐全。
 * 可在应用启动(server.ts / bootstrap.js)或脚本里提前校验并给出友好提示。
 */
export function missingLlmConfig(): string[] {
  const missing: string[] = [];
  if (!modelId) missing.push('LLM_MODEL');
  if (!baseURL) missing.push('LLM_BASE_URL');
  if (!apiKey) missing.push('LLM_API_KEY');
  return missing;
}

/** 暴露解析后的原始值(便于日志/调试;apiKey 切勿打印到不安全的地方)。 */
export const llmEnv = { provider, modelId, baseURL, apiKey };
