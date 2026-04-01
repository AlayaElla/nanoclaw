# 代码质量评审员提示词模板 (Code Quality Reviewer Prompt Template)

在分派代码质量评审子 Agent 时使用此模板。

**用途：** 验证实现方案是否构建良好（整洁、经过测试、易于维护）。

**请仅在规范合规性评审通过后再分派。**

```
Task 工具 (superpowers:code-reviewer):
  使用位于 requesting-code-review/code-reviewer.md 的模板

  WHAT_WAS_IMPLEMENTED: [摘自实施者的报告]
  PLAN_OR_REQUIREMENTS: 来自 [计划文件] 的任务 N
  BASE_SHA: [任务开始前的提交]
  HEAD_SHA: [当前的提交]
  DESCRIPTION: [任务摘要]
```

**除了标准的代码质量关注点外，评审员还应检查：**
- 每个文件是否都有单一且清晰的职责，以及定义良好的接口？
- 单元是否进行了拆解，以便能够被独立地理解和测试？
- 实施过程是否遵循了计划中的文件结构？
- 本次实施是否创建了已经过于臃肿的新文件，或者使现有文件显著增大？（不要指责预先存在的文件大小 —— 请专注于本次变更所带来的影响。）

**代码评审员返回：** 优点、问题（致命/重要/次要）、综合评估
