#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")"

# 从 .env 读取 INSTANCE_ID
INSTANCE_ID=$(grep '^INSTANCE_ID=' .env | cut -d '=' -f2 | tr -d '"'\' | xargs)
INSTANCE_ID=${INSTANCE_ID:-nanoclaw}

echo "=========================================="
echo "正在将当前实例注册进 PM2: [${INSTANCE_ID}]"
echo "=========================================="

npx pm2 delete "$INSTANCE_ID" 2>/dev/null || true
npx pm2 start start_nanoclaw.sh --name "$INSTANCE_ID"
npx pm2 save

echo "✅ 注册完成！"
