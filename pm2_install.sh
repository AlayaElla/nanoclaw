#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")"

# 从 .env 读取 INSTANCE_ID
INSTANCE_ID=$(grep '^INSTANCE_ID=' .env | cut -d '=' -f2 | tr -d '"'\' | xargs)
INSTANCE_ID=${INSTANCE_ID:-nanoclaw}

LITELLM_NAME="litellm"
SCRIPT_DIR="$(pwd)"

echo "=========================================="
echo "  PM2 服务注册 (NanoClaw + LiteLLM)"
echo "=========================================="

# --- 注册 LiteLLM ---
if npx pm2 describe "$LITELLM_NAME" &>/dev/null; then
  echo "🔄 LiteLLM 服务 [$LITELLM_NAME] 已存在，正在替换..."
  npx pm2 delete "$LITELLM_NAME"
fi
echo "🚀 正在注册 LiteLLM 服务: [$LITELLM_NAME]"
npx pm2 start "${SCRIPT_DIR}/services/litellm/start_litellm.sh" \
  --name "$LITELLM_NAME" \
  --cwd "${SCRIPT_DIR}/services/litellm" \
  -o /dev/null \
  -e /dev/null
echo "✅ LiteLLM 注册完成"

# --- 注册 Telegram Bot API ---
TG_API_NAME="tg-api"
if [ -f "${SCRIPT_DIR}/services/telegram-bot-api/.env" ] || grep -q 'TELEGRAM_API_ID' "${SCRIPT_DIR}/.env"; then
  if npx pm2 describe "$TG_API_NAME" &>/dev/null; then
    echo "🔄 Telegram API 服务 [$TG_API_NAME] 已存在，正在替换..."
    npx pm2 delete "$TG_API_NAME"
  fi
  echo "🚀 正在注册 Telegram API 服务: [$TG_API_NAME]"
  npx pm2 start "${SCRIPT_DIR}/services/telegram-bot-api/start_tgapi.sh" \
    --name "$TG_API_NAME" \
    --cwd "${SCRIPT_DIR}/services/telegram-bot-api" \
    -o /dev/null \
    -e /dev/null
  echo "✅ Telegram API 注册完成"
fi

# --- 注册 NanoClaw ---
if npx pm2 describe "$INSTANCE_ID" &>/dev/null; then
  echo "🔄 NanoClaw 服务 [$INSTANCE_ID] 已存在，正在替换..."
  npx pm2 delete "$INSTANCE_ID"
fi
echo "🚀 正在注册 NanoClaw 服务: [$INSTANCE_ID]"
npx pm2 start "${SCRIPT_DIR}/start_nanoclaw.sh" \
  --name "$INSTANCE_ID" \
  --cwd "${SCRIPT_DIR}" \
  -o /dev/null \
  -e /dev/null
echo "✅ NanoClaw 注册完成"

# --- 保存 + 开机自启 ---
echo ""
echo "💾 保存 PM2 进程列表..."
npx pm2 save

echo "🔧 设置 PM2 开机自启..."
# pm2 startup 会输出一条需要 sudo 执行的命令，自动执行它
STARTUP_CMD=$(npx pm2 startup 2>/dev/null | grep 'sudo' | head -1)
if [ -n "$STARTUP_CMD" ]; then
  echo "执行: $STARTUP_CMD"
  eval "$STARTUP_CMD"
else
  echo "ℹ️  PM2 开机自启已配置或无需额外操作"
fi

npx pm2 save

echo ""
echo "=========================================="
echo "✅ 全部完成！已注册服务:"
npx pm2 list
echo "=========================================="
