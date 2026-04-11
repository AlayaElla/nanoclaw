#!/bin/bash

# 启动 LiteLLM 本地代理服务器
# 兼容 PM2 管理: 前台运行 + 信号捕获自动清理容器
# 请在使用前确保系统安装了 Docker 并且已经启动

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

CONTAINER_NAME="nanoclaw-litellm-proxy"

# === 信号捕获: PM2 stop/restart 时自动清理 Docker 容器 ===
cleanup() {
    echo -e "\e[33m收到停止信号，正在清理 Docker 容器: ${CONTAINER_NAME}...\e[0m"
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    echo -e "\e[32m容器已清理。\e[0m"
    exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

# === 从 .env 读取 API Key (如果存在) ===
# 优先读取当前目录的 .env (LiteLLM 专用配置)
if [ -f ".env" ]; then
    echo -e "\e[36m从当前目录 .env 加载环境变量...\e[0m"
    export $(grep -E '^(DASHSCOPE_API_KEY|QWEN_API_KEY|WHATAI_API_KEY|VOLCANO_API_KEY)=' ".env" | xargs)
elif [ -f "../.env" ]; then
    echo -e "\e[36m从父目录 .env 加载环境变量...\e[0m"
    export $(grep -E '^(DASHSCOPE_API_KEY|QWEN_API_KEY|WHATAI_API_KEY|VOLCANO_API_KEY)=' "../.env" | xargs)
fi

# 用 DASHSCOPE_API_KEY 做 QWEN_API_KEY 的后备
QWEN_API_KEY="${QWEN_API_KEY:-$DASHSCOPE_API_KEY}"

if [ -z "$QWEN_API_KEY" ] && [ -z "$WHATAI_API_KEY" ]; then
    echo -e "\e[31m错误: 至少需要提供一个 API Key (QWEN_API_KEY 或 WHATAI_API_KEY)\e[0m"
    echo -e "\e[31m请在 litellm/.env 或项目根目录 .env 中配置\e[0m"
    exit 1
fi

echo -e "\e[36m正在启动 LiteLLM 代理容器 (端口 4000)...\e[0m"

# 停止可能已经存在的旧容器
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# 构建环境变量参数
ENV_ARGS=""
[ -n "$QWEN_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e QWEN_API_KEY=$QWEN_API_KEY"
[ -n "$WHATAI_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e WHATAI_API_KEY=$WHATAI_API_KEY"
[ -n "$VOLCANO_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e VOLCANO_API_KEY=$VOLCANO_API_KEY"

# 启动容器前确保日志目录存在并可写
mkdir -p "$(pwd)/logs"
chmod 777 "$(pwd)/logs"

echo -e "\e[33m可用模型:\e[0m"
[ -n "$QWEN_API_KEY" ] && echo -e "  \e[36mqwen-plus\e[0m        → DashScope 千问"
[ -n "$WHATAI_API_KEY" ] && echo -e "  \e[36mgrok-4-fast-reasoning\e[0m → WhatAI.cc Grok"
echo ""

# 前台运行容器 (--rm 在容器退出时自动清理)
# PM2 通过此前台进程管理生命周期
exec docker run --rm \
  -v "$(pwd)/config.yaml:/app/config.yaml" \
  -v "$(pwd)/raw_logger.py:/app/raw_logger.py" \
  -v "$(pwd)/logs:/app/logs" \
  $ENV_ARGS \
  -p 127.0.0.1:4000:4000 \
  --name "$CONTAINER_NAME" \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml
