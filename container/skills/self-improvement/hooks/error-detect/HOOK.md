---
name: self-improvement-error-detect
hookEvent: PostToolUse
matcher: Bash
entry: ./run.sh
requires:
  bins:
    - bash
description: 检测工具执行输出中的错误关键词，通过前置拦截提醒 Agent 将非直观错误反思记录到 .learnings/ERRORS.md 中。
---

## 说明

基于 NanoClaw 原生外部 Bash 脚本执行器。在 `PostToolUse` 阶段拦截工具的 StdOut 输出（如 `tool_response`）。如果脚本发现错误关键词（error / failed / Traceback 等），将会向模型当次对话上下文中注入 `<error-detected>` XML 块，迫使 Agent 思考当前的报错是否具有学习价值，并使用 `[ERR-YYYYMMDD-XXX]` 格式固化学习知识。
