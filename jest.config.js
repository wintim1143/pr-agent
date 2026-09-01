/**
 * Jest 配置。
 *
 * 为什么需要 babel-jest 转译 node_modules 里的 ESM 依赖:
 * @mastra/core 提供的是 CJS bundle(dist/*.cjs),但它在运行时 require 了几个
 * "纯 ESM"(package.json 无 "main"、只有 "exports" 的 ESM 入口)的依赖,例如:
 *   @sindresorhus/slugify、escape-string-regexp、xxhash-wasm、croner、p-map、tokenx。
 *
 * jest 默认不 transform node_modules,于是 CJS 运行时 require() 到这些 ESM 入口时,
 * 会抛 "Cannot use import statement outside a module"(实测 storage.test.ts 复现)。
 *
 * 解法:对 node_modules 里这些纯 ESM 依赖,单独用 babel-jest + @babel/preset-env
 * 把 ESM 语法转成 CJS;其余文件(ts)仍走 ts-jest。
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // .tmp/verify/ 是一次性验证脚本(见 .gitignore),不是测试,不能被 jest 收集。
  testPathIgnorePatterns: ['<rootDir>/test/fixtures', '<rootDir>/.tmp/'],
  coveragePathIgnorePatterns: ['<rootDir>/test/', '<rootDir>/.tmp/'],
  // 让 @mastra/core 及其 ESM-only 依赖不被 transformIgnorePatterns 忽略,
  // 从而能进入下方 babel-jest 的转译范围。
  // @sindresorhus/ 整个 scope 都是纯 ESM(slugify → transliterate → escape-string-regexp 是一条链),
  // 所以按 scope 前缀覆盖,避免逐个列包名漏掉嵌套依赖。
  // 注意 (?:/|$) 必须精确界定包名边界,否则负向前瞻会被外层结尾的斜杠破坏语义。
  transformIgnorePatterns: [
    '/node_modules/(?!(?:@mastra/core|@mastra/schema-compat|@sindresorhus|escape-string-regexp|xxhash-wasm|croner|p-map|tokenx)(?:/|$))',
  ],
  transform: {
    // ts 文件仍用 ts-jest(preset 自带的规则,显式声明以便与下面 js 规则共存)
    '^.+\\.tsx?$': 'ts-jest',
    // node_modules 里的纯 ESM 依赖,用 babel-jest 转成 CJS
    '^.+\\.m?js$': ['babel-jest', { presets: ['@babel/preset-env'] }],
  },
};
