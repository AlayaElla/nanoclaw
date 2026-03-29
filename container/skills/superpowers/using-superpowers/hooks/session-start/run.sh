#!/bin/bash
# Superpowers Session Start Hook
# Dumps the using-superpowers SKILL.md into context

set -e

SKILL_CANDIDATES=(
  "/workspace/group/.claude/skills/using-superpowers/SKILL.md"
  "/workspace/group/.claude/skills/superpowers/using-superpowers/SKILL.md"
)

content=""
for file in "${SKILL_CANDIDATES[@]}"; do
  if [ -f "$file" ]; then
    content=$(cat "$file")
    break
  fi
done

if [ -n "$content" ]; then
  cat << EOF
<EXTREMELY_IMPORTANT>
你拥有 Superpowers。

以下是 'superpowers:using-superpowers' Skill 的完整内容 —— 这是你使用 Skills 体系的入口指南。对于其他所有 Skill，请使用 'Skill' 工具：

$content
</EXTREMELY_IMPORTANT>
EOF
fi
