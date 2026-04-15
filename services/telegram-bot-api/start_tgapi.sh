#!/bin/bash

# 启动 Telegram Bot API 本地服务器
# 兼容 PM2 管理: 前台运行 + 信号捕获自动清理容器

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

CONTAINER_NAME="nanoclaw-tg-api"

# === 信号捕获: PM2 stop/restart 时自动清理 Docker 容器 ===
cleanup() {
    echo -e "\e[33m收到停止信号，正在清理 Docker 容器: ${CONTAINER_NAME}...\e[0m"
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    echo -e "\e[32m容器已清理。\e[0m"
    exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

# === 从 .env 读取 API Key ===
if [ -f ".env" ]; then
    echo -e "\e[36m从当前目录 .env 加载环境变量...\e[0m"
    export $(grep -E '^(TELEGRAM_API_ID|TELEGRAM_API_HASH)=' ".env" | xargs)
elif [ -f "../../.env" ]; then
    echo -e "\e[36m从父目录 .env 加载环境变量...\e[0m"
    export $(grep -E '^(TELEGRAM_API_ID|TELEGRAM_API_HASH)=' "../../.env" | xargs)
fi

if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
    echo -e "\e[31m错误: 必须提供 TELEGRAM_API_ID 和 TELEGRAM_API_HASH\e[0m"
    echo -e "\e[31m请在 services/telegram-bot-api/.env 中配置\e[0m"
    exit 1
fi

echo -e "\e[36m正在启动 Telegram Bot API 代理容器 (端口 8081)...\e[0m"

# 停止可能已经存在的旧容器
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# 准备工作目录
# 容器里 telegram-bot-api 用户固定为 uid:gid = 101:101。
# 宿主要读下载的文件，只需把自己加进 gid=101 组一次（脚本自动检测提示）。
TG_DATA_DIR="$(pwd)/tg-data"
mkdir -p "$TG_DATA_DIR"

# 检查 tg-data 所有权（容器内 telegram-bot-api 用户为 uid:gid=101:101）
if [ "$(stat -c '%u' "$TG_DATA_DIR")" != "101" ]; then
    echo -e "\e[31m错误: tg-data 所有权不是 101:101，容器无法写入。\e[0m"
    echo -e "\e[33m首次运行请手动执行一次: sudo chown -R 101:101 \"$TG_DATA_DIR\"\e[0m"
    exit 1
fi

# 检查宿主用户是否在 gid=101 组里，否则提示
if ! id -G | tr ' ' '\n' | grep -qx 101; then
    echo -e "\e[33m警告: 当前用户不在 gid=101 组，无法读取 bot 下载的文件。\e[0m"
    echo -e "\e[33m执行下面命令一次（之后需要重新登录或 newgrp 101 生效）:\e[0m"
    echo -e "\e[36m  sudo groupadd -g 101 tgapi 2>/dev/null; sudo usermod -aG 101 \$USER\e[0m"
fi

# 前台运行容器（保持默认 uid=101，不覆盖 --user、不设 TELEGRAM_UID/GID）
exec docker run --rm \
  -e TELEGRAM_API_ID="$TELEGRAM_API_ID" \
  -e TELEGRAM_API_HASH="$TELEGRAM_API_HASH" \
  -e TELEGRAM_LOCAL=1 \
  -v "$TG_DATA_DIR:/var/lib/telegram-bot-api" \
  -p 127.0.0.1:8081:8081 \
  --name "$CONTAINER_NAME" \
  aiogram/telegram-bot-api:latest
