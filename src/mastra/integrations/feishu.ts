import 'dotenv/config';
import { z } from 'zod';
import { Integration } from '@mastra/core/integration';
import { createTool } from '@mastra/core/tools';
import {
  feishuNotify,
  feishuListMessages,
  getFeishuConfig,
  type FeishuNotifyResult,
  type FeishuInboundMessage,
} from '../adapters/feishu';

/**
 * 飞书收发集成(M1-3)。
 *
 * 设计取舍(先读现有代码再动手,非猜):
 * - **发**:直接复用 `adapters/feishu.ts` 的 `feishuNotify`(Webhook / 自建应用两模式都支持,
 *   卡片按钮用 `value.callback_id` 透传业务标识)。M1 的 notify 步与 inbound 回调都走它。
 * - **收**:复用本模块新增的 `feishuListMessages`(自建应用模式,tenant_access_token 轮询群消息)。
 *   Webhook 机器人无读消息权限,故收消息要求 app 模式——不满足则降级为「仅发不收」。
 * - 继承 `Integration` 基类(对应 M1 卡 §5):认证 + 工具集收敛到一个对象,供 agent / workflow 复用。
 *
 * 重要:本模块**加载不抛错**。未配置飞书时 `getFeishuClient()` 返回 null,工具 execute 内部判空给明确错误。
 */

export interface FeishuClient {
  notify(input: {
    title: string;
    markdown: string;
    buttons?: Array<{ text: string; value: string; type?: 'primary' | 'danger' | 'default' }>;
  }): Promise<FeishuNotifyResult>;
  listMessages(chatId: string, sinceTs: number): Promise<FeishuInboundMessage[]>;
}

/** 读取飞书 client;未配置返回 null(不抛)。 */
export function getFeishuClient(): FeishuClient | null {
  if (!getFeishuConfig()) return null;
  return {
    notify: input => feishuNotify(input),
    listMessages: (chatId, sinceTs) => feishuListMessages(chatId, sinceTs),
  };
}

// ---------- 两个工具(发卡片 / 拉消息) ----------

const NotifyResultSchema = z.object({
  ok: z.boolean(),
  mode: z.string(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
});

const sendCardTool = createTool({
  id: 'feishu-send-card',
  description: '向飞书(群/人)推送一张 interactive 卡片,可带按钮(按钮 value 透传业务标识,如 confirm_<runId>)。',
  inputSchema: z.object({
    title: z.string().describe('卡片标题'),
    markdown: z.string().describe('lark_md 正文'),
    buttons: z
      .array(
        z.object({
          text: z.string(),
          value: z.string(),
          type: z.enum(['primary', 'danger', 'default']).optional(),
        })
      )
      .optional()
      .describe('卡片按钮,可选'),
  }),
  outputSchema: NotifyResultSchema,
  execute: async inputData => {
    const client = getFeishuClient();
    if (!client) throw new Error('飞书未配置:缺少 FEISHU_WEBHOOK_URL 或 FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_RECEIVE_ID');
    return client.notify({
      title: inputData.title,
      markdown: inputData.markdown,
      buttons: inputData.buttons,
    });
  },
});

const MessagesListSchema = z.object({
  count: z.number(),
  messages: z.array(
    z.object({
      messageId: z.string(),
      text: z.string(),
      senderId: z.string(),
      createTime: z.number(),
    })
  ),
});

const listMessagesTool = createTool({
  id: 'feishu-list-messages',
  description: '拉取群聊历史消息(自建应用模式,轮询)。用于 inbound:识别 @bot 文本并去重。',
  inputSchema: z.object({
    chatId: z.string().describe('群 chat_id(对应 FEISHU_RECEIVE_ID)'),
    sinceTs: z.number().int().describe('起始 unix 秒级时间戳,只拉该时刻之后的消息'),
  }),
  outputSchema: MessagesListSchema,
  execute: async inputData => {
    const client = getFeishuClient();
    if (!client) throw new Error('飞书未配置或不支持收消息(收消息需自建应用模式且机器人已入群)');
    const messages = await client.listMessages(inputData.chatId, inputData.sinceTs);
    return { count: messages.length, messages };
  },
});

/**
 * 飞书 Integration(M1 卡 §5)。
 * - `listStaticTools()`:sendCard / listMessages 两个工具。
 * - `getApiClient()`:返回可直接调用的 client(供 workflow notify 步直接调,不必绕经工具抽象)。
 */
export class FeishuIntegration extends Integration<void, FeishuClient> {
  name = 'feishu';

  getApiClient(): Promise<FeishuClient> {
    const client = getFeishuClient();
    if (!client) {
      return Promise.reject(new Error('飞书未配置:缺少 FEISHU_WEBHOOK_URL 或 FEISHU_APP_ID + FEISHU_APP_SECRET + FEISHU_RECEIVE_ID'));
    }
    return Promise.resolve(client);
  }

  listStaticTools() {
    return {
      sendCard: sendCardTool,
      listMessages: listMessagesTool,
    };
  }
}

/** 单例。 */
export const feishuIntegration = new FeishuIntegration();
