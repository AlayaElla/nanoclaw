#!/bin/bash
# 列出/清理 NanoClaw 容器，按 INSTANCE_ID 分组
# 用法:
#   ./scripts/nanoclaw-containers.sh          # 列出所有容器
#   ./scripts/nanoclaw-containers.sh rm <ID>  # 删除指定实例的容器

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

SKIP="nanoclaw-litellm-proxy|nanoclaw-tg-api"

list_containers() {
  echo -e "${CYAN}=== NanoClaw 容器列表 ===${RESET}\n"

  containers=$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}\t{{.Status}}\t{{.CreatedAt}}" | grep -vE "$SKIP" | sort)

  if [ -z "$containers" ]; then
    echo "没有运行中的 NanoClaw 容器"
    return
  fi

  # 提取所有 instance IDs
  declare -A instances
  while IFS=$'\t' read -r name status created; do
    # nanoclaw-{INSTANCE_ID}-{group} → 提取 INSTANCE_ID
    stripped="${name#nanoclaw-}"
    # 找到第二个 - 的位置来分割 instance_id 和 group
    # 但 instance_id 本身可能包含 -，所以用已知的 group 列表反推
    instance_id=$(echo "$stripped" | sed -E 's/-(telegram|feishu|yyt|XenoCommunitySite|xingmeng|group|main|laoxin)[-_].*$//' | sed -E 's/-(telegram|feishu|yyt|XenoCommunitySite|xingmeng|group|main|laoxin)$//')
    instances["$instance_id"]=1
  done <<< "$containers"

  # 当前 .env 中的 INSTANCE_ID
  current_id=""
  if [ -f ".env" ]; then
    current_id=$(grep -E "^INSTANCE_ID=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
  fi

  for inst in $(echo "${!instances[@]}" | tr ' ' '\n' | sort); do
    prefix="nanoclaw-${inst}-"
    count=$(echo "$containers" | grep -c "^${prefix}" || true)

    label=""
    if [ "$inst" = "$current_id" ]; then
      label="${GREEN} ← 当前实例${RESET}"
    else
      label="${YELLOW} ← 孤儿实例${RESET}"
    fi

    echo -e "${CYAN}[$inst]${RESET} (${count} 个容器)${label}"
    echo "$containers" | grep "^${prefix}" | while IFS=$'\t' read -r name status created; do
      group="${name#${prefix}}"
      echo -e "  ${group}\t${status}"
    done
    echo ""
  done

  # 也显示不匹配 nanoclaw 模式的（如 cat_claw 等）
  others=$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" | grep -vE "$SKIP" | grep -vE "^nanoclaw-($(echo "${!instances[@]}" | tr ' ' '|'))-" || true)
  if [ -n "$others" ]; then
    echo -e "${YELLOW}[其他]${RESET}"
    echo "$others" | while read -r name; do
      echo "  $name"
    done
    echo ""
  fi
}

remove_instance() {
  local target_id="$1"
  prefix="nanoclaw-${target_id}-"

  names=$(docker ps --filter "name=${prefix}" --format "{{.Names}}" | grep -vE "$SKIP")

  if [ -z "$names" ]; then
    echo -e "${YELLOW}没有找到实例 [${target_id}] 的容器${RESET}"
    exit 1
  fi

  count=$(echo "$names" | wc -l)
  echo -e "${RED}将删除实例 [${target_id}] 的 ${count} 个容器:${RESET}"
  echo "$names" | while read -r n; do echo "  $n"; done
  echo ""
  read -p "确认删除? [y/N] " confirm
  if [[ "$confirm" =~ ^[yY]$ ]]; then
    echo "$names" | xargs docker rm -f
    echo -e "${GREEN}已删除 ${count} 个容器${RESET}"
  else
    echo "已取消"
  fi
}

case "${1:-}" in
  rm|remove|del)
    if [ -z "${2:-}" ]; then
      echo "用法: $0 rm <INSTANCE_ID>"
      echo "先运行 $0 查看所有实例"
      exit 1
    fi
    remove_instance "$2"
    ;;
  *)
    list_containers
    echo -e "删除指定实例: ${CYAN}$0 rm <INSTANCE_ID>${RESET}"
    ;;
esac
