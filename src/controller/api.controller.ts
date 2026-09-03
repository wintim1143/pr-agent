import { Inject, Controller, Get, Query, Post, Body } from '@midwayjs/core';
import type { Context } from '@midwayjs/koa';
import { UserService } from '../service/user.service';
import { mastra } from '../mastra/index';
import { getFeishuClient } from '../mastra/integrations/feishu';

/**
 * API 控制器。
 *
 * M1-5 触发入口:
 * - `POST /api/insights`:薄业务层。参数校验 → 映射 workflow input → 起 insight-workflow run → 返回 runId。
 *   对应 M1 卡 AC-1(HTTP 能起 run 返回 runId)。resume 走 @mastra/koa 自带的
 *   `POST /api/workflows/insight-workflow/resume?runId=xxx`(卡片按钮回调或手工打)。
 * - `POST /api/insights/feishu-poll`:飞书 inbound 触发(轮询模式)。拉群消息 → 对每条 @bot 文本起一个 run。
 *   依赖飞书自建应用 + `im:message.group_msg` 权限(不满足则降级返回明确提示,见 M1 卡 §5.1)。
 */
@Controller('/api')
export class APIController {
  @Inject()
  ctx: Context;

  @Inject()
  userService: UserService;

  @Get('/get_user')
  async getUser(@Query('uid') uid) {
    const user = await this.userService.getUser({ uid });
    return { success: true, message: 'OK', data: user };
  }

  /**
   * M1 只读洞察闭环的 HTTP 触发入口。
   * 起一个 insight-workflow run,返回 runId(供后续查状态 / resume)。
   */
  @Post('/insights')
  async createInsight(@Body() body: any) {
    const query = (body?.query ?? '').toString().trim();
    if (!query) {
      return { success: false, message: 'query 不能为空' };
    }
    const wf = mastra.getWorkflow('insight-workflow');
    const run = await wf.createRun();
    // start() 会跑完到 confirm 步 suspend(或终态)后 resolve;返回前 run 已进入 suspended(AC-4)
    const result = await run.start({ inputData: { query } });
    return {
      success: true,
      runId: run.runId,
      status: (result as { status?: string }).status,
    };
  }

  /**
   * 飞书 inbound 触发(轮询一轮)。拉最近消息,对每条文本起一个 insight-workflow run。
   * 仅自建应用模式可用;不满足配置时返回明确降级提示。
   */
  @Post('/insights/feishu-poll')
  async pollFeishu(@Body() body: any) {
    const client = getFeishuClient();
    if (!client) {
      return {
        success: false,
        message: '飞书未配置或不支持收消息(需自建应用模式 + im:message.group_msg 权限 + 机器人入群)',
      };
    }
    const chatId = (body?.chatId ?? process.env.FEISHU_RECEIVE_ID ?? '').toString().trim();
    if (!chatId) {
      return { success: false, message: '缺少 chatId(用 body.chatId 或环境变量 FEISHU_RECEIVE_ID)' };
    }
    const sinceTs =
      typeof body?.sinceTs === 'number' ? body.sinceTs : Math.floor(Date.now() / 1000) - 3600;

    let messages;
    try {
      messages = await client.listMessages(chatId, sinceTs);
    } catch (e) {
      return { success: false, message: `拉取飞书消息失败: ${e instanceof Error ? e.message : String(e)}` };
    }

    const triggered: Array<{ messageId: string; runId: string }> = [];
    for (const m of messages) {
      const text = m.text?.trim();
      if (!text) continue; // 幂等/噪声过滤:空消息跳过(真实去重应在持久化游标上做,此处为最小实现)
      const wf = mastra.getWorkflow('insight-workflow');
      const run = await wf.createRun();
      await run.start({ inputData: { query: text } });
      triggered.push({ messageId: m.messageId, runId: run.runId });
    }
    return { success: true, polled: messages.length, triggered };
  }
}
