#!/usr/bin/env bash
# Self-Improvement Error Detector Hook
# Triggers on PostToolUse for Bash to detect command failures

set -e

# The CLAUDE_TOOL_OUTPUT env variable is passed by the dispatcher
OUTPUT="${CLAUDE_TOOL_OUTPUT:-}"

shopt -s nocasematch

ERROR_PATTERNS=(
    "error:"
    "[error]"
    "failed"
    "command not found"
    "no such file"
    "permission denied"
    "fatal:"
    "exception"
    "traceback"
    "npm err!"
    "modulenotfounderror"
    "syntaxerror"
    "typeerror"
    "exit code"
    "non-zero"
)

contains_error=false
for pattern in "${ERROR_PATTERNS[@]}"; do
    if [[ "$OUTPUT" == *"$pattern"* ]]; then
        contains_error=true
        break
    fi
done

if [ "$contains_error" = true ]; then
    cat << 'EOF'
<error-detected>
由于执行出错，这可能是一个学习的绝佳机会。请考虑将其记录到 .learnings/ERRORS.md 如果：
- 该错误是预期外或非直观的；
- 它需要您的一定调查才能被修复；
- 这种错误在以后的场景中容易再度发生；
- 该解决方案能够使未来的同类任务受益。

请务必使用 standard self-improvement format: [ERR-YYYYMMDD-XXX] 记录。

**[重要机制：提权 (Promote)]**
如果这是一个让你或系统反复踩坑的**共性报错**，或者你找到的解决方案具备极高的**全局重用度**，请不要只存放在日志中：
务必执行提权（Promote），将其凝练并追加到工作区自动加载的 **`EXPERIENCE.md`**，或封装为专属的 **Skill**，以让系统永久对其免疫！

*(注：此拦截提醒由 `self-improvement` 技能触发。如果你不清楚如何进行“提权”操作，请随时阅读该技能的 `SKILL.md` 文件获取完整指南。)*
</error-detected>
EOF
fi
