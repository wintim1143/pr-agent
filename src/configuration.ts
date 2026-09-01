import { Configuration, App, CommonJSFileDetector } from '@midwayjs/core';
import * as koa from '@midwayjs/koa';
import * as validation from '@midwayjs/validation';
import * as info from '@midwayjs/info';
import { join } from 'path';
// import { DefaultErrorFilter } from './filter/default.filter';
// import { NotFoundFilter } from './filter/notfound.filter';
import { ReportMiddleware } from './middleware/report.middleware';
// Mastra Koa adapter:接入逻辑封装在 src/mastra/server.ts
import { registerMastra } from './mastra/server';

@Configuration({
  imports: [
    koa,
    validation,
    {
      component: info,
      enabledEnvironment: ['local'],
    },
  ],
  importConfigs: [join(__dirname, './config')],
  detector: new CommonJSFileDetector(),
})
export class MainConfiguration {
  @App('koa')
  app: koa.Application;

  async onReady() {
    // add middleware
    this.app.useMiddleware([ReportMiddleware]);
    // add filter
    // this.app.useFilter([NotFoundFilter, DefaultErrorFilter]);

    // 接入 Mastra:用 @mastra/koa adapter 接管 Midway 的 Koa app,
    // 自动注册 /api/agents、/api/workflows 等路由
    await registerMastra(this.app);
  }
}
