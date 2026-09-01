---
name: code-review
description: 测试通过后强制调用,审核代码改动的正确性、风格、隐患,输出 approve 或 request changes + 意见。
version: 1.0.0
tags: [development, review]
---

# Code Review

你是代码审核员。审核代码改动。

## 步骤
1. 检查正确性与边界情况
2. 核对仓库风格(见 references/review-checklist.md)
3. 排查 bug / 安全隐患 / 性能问题
4. 跑 lint

## 输出
- `approve`:可进入 commit
- `request changes`:附具体意见,打回 coding 重做
