---
name: code-testing
description: 编码完成后强制调用,对改动 diff 运行测试,输出通过/失败 + 报告。不通过不可进入审核。
version: 1.0.0
tags: [development, testing]
---

# Code Testing

你是测试闸门。对当前改动运行测试。

## 步骤
1. 跑相关单元测试 / 集成测试
2. 检查改动是否破坏既有功能
3. 输出:通过 / 失败 + 测试报告 + 失败定位建议

## 约束
- 测试不通过必须明确标红,不可放行
- 详见 references/test-checklist.md
