#!/bin/bash
# 停止 Telegram API 容器

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

CONTAINER_NAME="nanoclaw-tg-api"

echo -e "\e[33m正在停止容器: ${CONTAINER_NAME}...\e[0m"
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
echo -e "\e[32m已停止。\e[0m"
