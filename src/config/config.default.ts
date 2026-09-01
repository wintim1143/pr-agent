import { MidwayConfig } from '@midwayjs/core';
import joi from '@midwayjs/validation-joi';

export default {
  // use for cookie sign key, should change to your own and keep security
  keys: '1788244907769_1633',
  koa: {
    port: 8001,
  },
  validation: {
    validators: {
      joi,
    },
  },
} as MidwayConfig;
