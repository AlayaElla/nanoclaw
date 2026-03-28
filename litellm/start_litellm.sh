#!/bin/bash

# 启动 LiteLLM 本地代理服务器
# 请在使用前确保系统安装了 Docker 并且已经启动

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

# 如果没有环境变量，则提示输入
if [ -z "$QWEN_API_KEY" ]; then
    read -p "请输入阿里云百炼 API Key (sk-..., 用于千问模型): " QWEN_API_KEY
fi
if [ -z "$WHATAI_API_KEY" ]; then
    read -p "请输入 WhatAI API Key (sk-..., 用于 Grok 模型): " WHATAI_API_KEY
fi

if [ -z "$QWEN_API_KEY" ] && [ -z "$WHATAI_API_KEY" ]; then
    echo -e "\e[31m错误: 至少需要提供一个 API Key\e[0m"
    exit 1
fi

echo -e "\e[36m正在拉取并启动 LiteLLM 代理容器 (端口 4000)...\e[0m"

# 停止可能已经存在的旧容器
docker rm -f nanoclaw-litellm-proxy 2>/dev/null

# 构建环境变量参数
ENV_ARGS=""
[ -n "$QWEN_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e QWEN_API_KEY=$QWEN_API_KEY"
[ -n "$WHATAI_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e WHATAI_API_KEY=$WHATAI_API_KEY"
[ -n "$VOLCANO_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e VOLCANO_API_KEY=$VOLCANO_API_KEY"

# 启动容器前确保日志文件和数据库文件存在并可写
touch $(pwd)/litellm.log
chmod 666 $(pwd)/litellm.log
touch $(pwd)/spend.db
chmod 666 $(pwd)/spend.db

# 启动容器并挂载配置文件
docker run -d \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -v $(pwd)/raw_logger.py:/app/raw_logger.py \
  -v $(pwd)/litellm.log:/app/litellm.log \
  -v $(pwd)/spend.db:/app/spend.db \
  $ENV_ARGS \
  -p 127.0.0.1:4000:4000 \
  --name nanoclaw-litellm-proxy \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml

echo -e "\e[32mLiteLLM 已启动！运行 docker logs -f nanoclaw-litellm-proxy 查看日志。\e[0m"
echo ""
echo -e "\e[33m可用模型:\e[0m"
[ -n "$QWEN_API_KEY" ] && echo -e "  \e[36mqwen-plus\e[0m        → DashScope 千问"
[ -n "$WHATAI_API_KEY" ] && echo -e "  \e[36mgrok-4-fast-reasoning\e[0m → WhatAI.cc Grok"
echo ""
echo -e "\e[33m请确保 .env 文件中包含:\e[0m"
echo -e "  ANTHROPIC_BASE_URL=http://<宿主机IP>:4000"
echo -e "  ANTHROPIC_API_KEY=sk-proxy-dummy-key"
echo -e "  ANTHROPIC_MODEL=qwen-plus  # 默认模型 (每个 group 可单独配置)"
