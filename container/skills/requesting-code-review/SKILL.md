---
name: requesting-code-review
description: 当完成任务、实现重大功能，或在合并分支前用于验证工作是否符合要求时使用。
---

# 请求代码评审 (Requesting Code Review)

分派 `superpowers:code-reviewer` 子 Agent，在问题产生连锁反应前将其捕获。评审员会获得精准构建的评估上下文 —— 绝不会包含你的会话历史。这使评审员能专注于工作产出而非你的思考过程，并为你接下来的工作保留上下文。

**核心原则：** 及早评审，经常评审。

## 何时请求评审

**强制性：**
- 在子 Agent 驱动开发 (Subagent-Driven Development) 的每项任务之后。
- 完成重大功能后。
- 合并回 `main` 分支前。

**可选但有价值：**
- 卡住时（获取新的视角）。
- 重构前（基准检查）。
- 修复复杂 Bug 后。

## 如何请求

**1. 获取 Git SHA：**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # 或者 origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**2. 分派代码评审子 Agent：**

使用 Task 工具调用 `superpowers:code-reviewer` 类型，并填充位于 `code-reviewer.md` 的模板。

**占位符说明：**
- `{WHAT_WAS_IMPLEMENTED}` —— 你刚刚构建了什么。
- `{PLAN_OR_REQUIREMENTS}` —— 它应该做什么。
- `{BASE_SHA}` —— 起始提交。
- `{HEAD_SHA}` —— 结束提交。
- `{DESCRIPTION}` —— 简短摘要。

**3. 根据反馈采取行动：**
- 立即修复“致命 (Critical)”问题。
- 在继续前修复“重要 (Important)”问题。
- 记录“次要 (Minor)”问题以备后续处理。
- 如果评审员有误，请据理力争（说明理由）。

## 示例

```
[刚刚完成任务 2：添加验证函数]

你：在继续下一步之前，我先请求一次代码评审。

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[分派 superpowers:code-reviewer 子 Agent]
  WHAT_WAS_IMPLEMENTED: 对话索引的验证与修复函数
  PLAN_OR_REQUIREMENTS: docs/superpowers/plans/deployment-plan.md 中的任务 2
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661
  DESCRIPTION: 增加了 verifyIndex() 和 repairIndex()，支持 4 种错误类型

[子 Agent 返回结果]:
  优点：架构整洁，有真实的测试。
  发现的问题：
    重要：缺失进度指示器
    次要：上报间隔使用了魔法数字 (100)
  综合评估：可以继续。

你：[修复进度指示器]
[继续执行任务 3]
```

## 与工作流集成

**子 Agent 驱动开发 (Subagent-Driven Development)：**
- 每项任务后都进行评审。
- 在问题复合前将其捕获。
- 修复后再进入下一项任务。

**执行计划 (Executing Plans)：**
- 每批次（3 项任务）完成后进行评审。
- 获取反馈、应用、继续。

**即时开发 (Ad-Hoc Development)：**
- 合并前评审。
- 卡住时评审。

## 红灯信号

**绝不要：**
- 因为“很简单”而跳过评审。
- 忽略致命 (Critical) 问题。
- 在未修复重要 (Important) 问题的情况下继续。
- 与有效的技术反馈无理争辩。

**如果评审员有误：**
- 带着技术理由据理力争。
- 展示能证明其有效的代码或测试。
- 请求进一步澄清。

模板位置：`requesting-code-review/code-reviewer.md`
