#!/bin/bash
# NanoClaw 独立启动脚本 (不启动 LiteLLM 代理)
# 请确保 LiteLLM 代理已经在运行 (通常在端口 4000)

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

# === 颜色 ===
GREEN='\e[32m'
CYAN='\e[36m'
RESET='\033[0m'

echo -e "${CYAN}正在启动 NanoClaw 主服务 (跳过 LiteLLM)...${RESET}"

# === 从 .env 读取配置 ===
if [ -f .env ]; then
  echo -e "${CYAN}加载 .env 配置...${RESET}"
  export $(grep -v '^#' .env | xargs)
fi

# === 编译 + 启动 ===
echo -e "${CYAN}正在编译项目...${RESET}"
npm run build 2>&1 | tail -1
echo -e "${GREEN}编译完成${RESET}"
echo ""

# 前台运行 NanoClaw
exec npm start
