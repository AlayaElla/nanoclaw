---
name: self-improvement-session-start
hookEvent: SessionStart
matcher: ""
entry: ./run.sh
requires:
  bins:
    - bash
description: 在会话建立初期隐式提醒 Agent，若会话中涌现值得记录的发现或方案，在结束时应萃取保存至 .learnings/ 目录。
---

## 说明

基于 NanoClaw 的外部进程执行器机制，在 `SessionStart` 阶段挂载。通过执行同目录下的 `run.sh` 将标准指令语料强力注入至对齐上下文（`additionalContext`）中，形成 Agent 终身学习机制的自动启发钩子。
