#!/usr/bin/env bash
# Self-Improvement Activator Hook
# Triggers on SessionStart to remind the agent about learning capture.

set -e

cat << 'EOF'
<self-improvement-reminder>
在本次会话结束之前，请务必评估是否涌现了值得提取的知识：
- 在调查过程中是否发现了非直观的解决方案？
- 对于预期外的运行行为是否有可用的 workaround（变通方案）？
- 您是否掌握了特定于本项目的架构模式或开发规范？
- 您是否通过复杂的 Debugging 解决了一个棘手的错误？

如果有，请将它们以文档的形式保存至 .learnings/ 目录下。
如果是全局性、高价值的新模式，应当考虑将其提取为标准 Skill。
</self-improvement-reminder>
EOF
