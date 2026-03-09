#!/bin/bash
# NanoClaw 一键启动脚本
# 启动 LiteLLM 代理 + NanoClaw 主服务

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

# === 颜色 ===
RED='\e[31m'
GREEN='\e[32m'
YELLOW='\e[33m'
CYAN='\e[36m'
RESET='\e[0m'

# === 从 .env 读取配置 (如果存在) ===
if [ -f .env ]; then
  export $(grep -E '^(ASSISTANT_NAME|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_MODEL|TELEGRAM_BOT_POOL|CHROME_PATH|EMBEDDING_API_KEY|EMBEDDING_BASE_URL|EMBEDDING_MODEL|VISION_API_KEY|VISION_BASE_URL|VISION_MODEL|PARALLEL_API_KEY)=' .env | xargs)
fi

# 优先读取 litellm/.env (模型 API Key)
if [ -f litellm/.env ]; then
  echo -e "${CYAN}从 litellm/.env 加载模型 API Key...${RESET}"
  export $(grep -E '^(DASHSCOPE_API_KEY|QWEN_API_KEY|WHATAI_API_KEY)=' litellm/.env | xargs)
fi

# 用 DASHSCOPE_API_KEY 做 QWEN_API_KEY 的后备
QWEN_API_KEY="${QWEN_API_KEY:-$DASHSCOPE_API_KEY}"

if [ -z "$QWEN_API_KEY" ] && [ -z "$WHATAI_API_KEY" ]; then
  echo -e "${RED}错误: 需要至少一个 API Key (QWEN_API_KEY 或 WHATAI_API_KEY)${RESET}"
  echo "请在 .env 中设置 DASHSCOPE_API_KEY 或 QWEN_API_KEY"
  exit 1
fi

# === 1. 启动 LiteLLM ===
echo -e "${CYAN}[1/2] 启动 LiteLLM 代理...${RESET}"

# 确保日志文件存在并可写
touch "$(pwd)/litellm/litellm.log"
chmod 666 "$(pwd)/litellm/litellm.log"

# 强制清理并重启 LiteLLM 容器以加载最新 .env 配置
docker rm -f nanoclaw-litellm-proxy 2>/dev/null || true

# 构建环境变量
ENV_ARGS=""
[ -n "$QWEN_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e QWEN_API_KEY=$QWEN_API_KEY"
[ -n "$WHATAI_API_KEY" ] && ENV_ARGS="$ENV_ARGS -e WHATAI_API_KEY=$WHATAI_API_KEY"

docker run -d \
  -v "$(pwd)/litellm/config.yaml:/app/config.yaml" \
  -v "$(pwd)/litellm/raw_logger.py:/app/raw_logger.py" \
  -v "$(pwd)/litellm/litellm.log:/app/litellm.log" \
  $ENV_ARGS \
  -p 4000:4000 \
  --restart unless-stopped \
  --name nanoclaw-litellm-proxy \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml

# 等待 LiteLLM 就绪
echo -n "  等待 LiteLLM 启动"
for i in $(seq 1 15); do
  if curl -s http://localhost:4000/health > /dev/null 2>&1; then
    echo ""
    echo -e "${GREEN}  LiteLLM 就绪 (端口 4000)${RESET}"
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

# === 2. 编译 + 启动 NanoClaw ===
echo -e "${CYAN}[2/2] 启动 NanoClaw...${RESET}"
npm run build 2>&1 | tail -1
echo -e "${GREEN}  编译完成${RESET}"
echo ""

# 前台运行 NanoClaw（Ctrl+C 停止）
exec npm start
