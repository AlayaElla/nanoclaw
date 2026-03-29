---
name: superpowers-session-start
hookEvent: SessionStart
matcher: ""
entry: ./run.sh
description: 在会话开始时向 Agent 强制注入 using-superpowers 技能的核心大纲内容，以确保其优先按照规范进行深度思考开发。
---

## 说明

本 Hook 会在每次会话环境初始化时 (`SessionStart`) 执行，主动向模型发送 `superpowers:using-superpowers` 的 `SKILL.md` 正文作为追加上下文，强化模型在使用工具和思考路径时的规范。

## 文件发现

按优先级查找 `using-superpowers/SKILL.md`：
1. `/workspace/group/.claude/skills/using-superpowers/SKILL.md`（扁平布局）
2. `/workspace/group/.claude/skills/superpowers/using-superpowers/SKILL.md`（命名空间布局）

若文件不存在则静默跳过（fail-open）。
