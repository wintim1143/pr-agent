'use strict';
require('dotenv').config();
const path = require('node:path');
(async () => {
  const { mastra } = require(path.resolve(__dirname, '../dist/mastra/index.js'));
  const agent = mastra.getAgent('insight-agent');
  console.log('start plain generate...');
  const t = Date.now();
  const res = await agent.generate('用一句话介绍 Apache Doris 是什么。');
  console.log('done in', Date.now() - t, 'ms');
  console.log('text=', (res.text || '').slice(0, 300));
  process.exit(0);
})().catch(e => {
  console.error('ERR', e?.message || e);
  process.exit(1);
});
