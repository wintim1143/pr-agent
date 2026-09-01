import { createApp, close, createHttpRequest } from '@midwayjs/mock';
import { Framework } from '@midwayjs/koa';

// Midway createApp 要拉起整个应用(加载依赖 + 初始化容器),实测需 6~10s,
// 超过 jest 默认 5000ms 超时。这里放宽到 30s。
jest.setTimeout(30000);

describe('test/controller/home.test.ts', () => {

  it('should GET /', async () => {
    // create app
    const app = await createApp<Framework>(process.cwd());

    // make request
    const result = await createHttpRequest(app).get('/');

    // use expect by jest
    expect(result.status).toBe(200);
    expect(result.text).toBe('Hello Midwayjs!');

    // close app
    await close(app);
  });

});
