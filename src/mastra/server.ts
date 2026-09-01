import * as koa from '@midwayjs/koa';
import { MastraServer } from '@mastra/koa';
import { mastra } from './index';

/**
 * 把 Midway 暴露的 Koa app 交给 @mastra/koa 的 MastraServer 接管，
 * 自动注册 /api/agents、/api/workflows 等 Mastra 路由。
 *
 * 类型说明:Midway 注入的 app 类型是 `koa.Application`(即 MidwayKoaApplication),
 * 而 @mastra/koa 的 MastraServer 构造参数期望标准 Koa 实例类型。
 * 运行期两者兼容(已在 spike 中验证 init() 成功),但 TS 编译期类型对不上,
 * 因此需要 `as any` 桥接。这里把 `as any` 收敛到唯一一处,避免散落到业务代码。
 *
 * 接入入口见 src/configuration.ts 的 onReady()。
 */
export async function registerMastra(app: koa.Application): Promise<void> {
  // mastra 实例来自 ./index.ts(单一真相源,同时供 `mastra dev` 使用)
  const server = new MastraServer({
    app: app as any, // @mastra/koa 期望标准 Koa 实例类型,运行期兼容见上方注释
    mastra,
  });

  await server.init();
}
