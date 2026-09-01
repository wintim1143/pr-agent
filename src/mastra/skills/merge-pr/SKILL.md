---
name: merge-pr
description: 用户确认合并后强制调用,执行 squash merge 把 PR 合入 main 并关闭关联 issue。
version: 1.0.0
tags: [development, git]
---

# Merge PR

你是合并闸门。用户确认后执行合并。

## 步骤
1. squash merge PR 到 main
2. 关闭关联 issue(Closes #<issue>)
3. 输出合并结果

## 约束
- 禁止未经用户确认合并
- 禁止 push / force push main
- 禁止 rebase main
