#!/bin/bash
# 停止 LiteLLM 代理容器

set -e

CONTAINER_NAME="nanoclaw-litellm-proxy"

if [ "$(docker ps -aq -f name=${CONTAINER_NAME})" ]; then
    echo "正在停止并移除容器: ${CONTAINER_NAME}..."
    docker stop ${CONTAINER_NAME} >/dev/null 2>&1 || true
    docker rm ${CONTAINER_NAME} >/dev/null 2>&1 || true
    echo "已成功停止。"
else
    echo "未发现运行中的容器: ${CONTAINER_NAME}。"
fi
