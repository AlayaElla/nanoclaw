#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")"

# 从 .env 安全读取 INSTANCE_ID，去除可能存在的引号，如果没填则默认为 alaya_claw
INSTANCE_ID=$(grep '^INSTANCE_ID=' .env | cut -d '=' -f2 | tr -d '"'\' | xargs)
INSTANCE_ID=${INSTANCE_ID:-alaya_claw}

echo "正在停止 NanoClaw (${INSTANCE_ID})..."
npx pm2 stop "$INSTANCE_ID"
