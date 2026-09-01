module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // .tmp/verify/ 是一次性验证脚本(见 .gitignore),不是测试,不能被 jest 收集。
  testPathIgnorePatterns: ['<rootDir>/test/fixtures', '<rootDir>/.tmp/'],
  coveragePathIgnorePatterns: ['<rootDir>/test/', '<rootDir>/.tmp/'],
};