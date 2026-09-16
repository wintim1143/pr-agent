import { Inject, Controller, Get, Query, Post, Body } from '@midwayjs/core';
import type { Context } from '@midwayjs/koa';
import { UserService } from '../service/user.service';
import { mastra } from '../mastra/index';
import { getFeishuClient } from '../mastra/integrations/feishu';
import { pollInboundOnce } from '../mastra/adapters/inbound-poll';

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
   *
   * ## M5a-2 起:入口有真正的幂等闸与游标
   *
   * 原实现只过滤空消息,且 `sinceTs` 每轮都取 `now - 3600` —— 本注释当时自认是
   * 「最小实现」。一旦把轮询挂上定时器，同一条消息在一小时内会被**重复触发几十次**。
   *
   * 现在整段编排挪到 `adapters/inbound-poll.ts`（`pollInboundOnce`）：
   * - 每条消息先**原子认领**（幂等键 = `messageId`），认领失败即跳过并**在响应里留下可见证据**；
   * - `sinceTs` 默认从**持久化游标**续读，进程重启不重放历史窗口；
   * - 去重存储不可写时 **fail-closed**：整轮失败、不起任何新 run。
   *
   * 把编排抽出去同时带来一个副作用（刻意的收益）：验证脚本可以注入假的飞书客户端，
   * 从而**无人值守地**验证「同一 messageId 投 3 次只起 1 个 run」——
   * 走的是与 HTTP 完全相同的代码路径。
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

    const res = await pollInboundOnce({
      source: `feishu:${chatId}`,
      sinceTs: typeof body?.sinceTs === 'number' ? body.sinceTs : undefined,
      fetchMessages: sinceTs => client.listMessages(chatId, sinceTs),
      startRun: async text => {
        const wf = mastra.getWorkflow('insight-workflow');
        const run = await wf.createRun();
        await run.start({ inputData: { query: text } });
        return run.runId;
      },
    });
    return res.success ? res : { ...res, message: res.error ?? '轮询失败' };
  }
}
