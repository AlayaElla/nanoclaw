#!/bin/bash
# Self-Improvement Error Detector Hook
# Triggers on PostToolUse for Bash to detect command failures

set -e

# The CLAUDE_TOOL_OUTPUT env variable is passed by the dispatcher
OUTPUT="${CLAUDE_TOOL_OUTPUT:-}"

ERROR_PATTERNS=(
    "error:"
    "Error:"
    "ERROR:"
    "failed"
    "FAILED"
    "command not found"
    "No such file"
    "Permission denied"
    "fatal:"
    "Exception"
    "Traceback"
    "npm ERR!"
    "ModuleNotFoundError"
    "SyntaxError"
    "TypeError"
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
</error-detected>
EOF
fi
