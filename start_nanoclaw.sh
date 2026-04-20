#!/bin/bash
# NanoClaw 独立启动脚本 (不启动 LiteLLM 代理)
# 请确保 LiteLLM 代理已经在运行 (通常在端口 4000)

set -e
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# === 确保带上 messagebus(gid=101) 组 ===
# 本地 telegram-bot-api 容器以 uid:gid=101:101 写下载文件，
# NanoClaw 进程需要继承该组才能读到。id -G 未包含 101 时用 sg 重入。
if ! id -G | tr ' ' '\n' | grep -qx 101; then
  if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx messagebus \
     || getent group messagebus | awk -F: -v u="$USER" '{split($4,m,","); for(i in m) if(m[i]==u) exit 0; exit 1}'; then
    echo -e "\e[36m以 messagebus 组重新进入启动脚本...\e[0m"
    exec sg messagebus -c "'$0' $*"
  else
    echo -e "\e[33m警告: 当前用户不在 messagebus(gid=101) 组，Telegram 本地文件读取可能失败。\e[0m"
    echo -e "\e[33m执行一次: sudo usermod -aG 101 \$USER 后重新登录。\e[0m"
  fi
fi

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

# === 检测并释放端口 ===
PORT=${GATEWAY_PORT:-18789}

echo -e "${CYAN}检查端口 $PORT 是否被占用...${RESET}"
if bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
  echo -e "\e[33m警告: 端口已被占用，正在尝试精确关闭占用进程...\e[0m"
  if [ -f "stop_nanoclaw.sh" ]; then
    bash stop_nanoclaw.sh >/dev/null 2>&1
  fi
  sleep 1
  
  # 使用纯 bash 读取 /proc/net/tcp 查找精准 PID (避开 lsof 引发的系统态段错误，同时防止误杀其他实例)
  if bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
    HEX_PORT=$(printf "%04X" $PORT)
    INODE=$(awk -v hex=":$HEX_PORT" '$2 ~ hex && $4 == "0A" {print $10}' /proc/net/tcp 2>/dev/null | head -n 1)
    if [ -n "$INODE" ]; then
      for fd_dir in /proc/[0-9]*/fd; do
        if [ ! -r "$fd_dir" ]; then continue; fi
        if ls -l "$fd_dir" 2>/dev/null | grep -q "socket:\[$INODE\]"; then
          PID=$(echo "$fd_dir" | cut -d/ -f3)
          echo -e "\e[33m清理存留的进程 PID: $PID\e[0m"
          kill -9 "$PID" 2>/dev/null || true
        fi
      done
    fi
    sleep 1
  fi
  echo -e "${GREEN}端口已释放。${RESET}"
fi

# === 编译 + 启动 ===
echo -e "${CYAN}正在编译项目...${RESET}"
npm run build 2>&1 | tail -1
echo -e "${CYAN}正在编译容器代理端...${RESET}"
npm run build --prefix container/agent-runner 2>&1 | tail -1
echo -e "${GREEN}编译完成${RESET}"
echo ""

# 前台运行 NanoClaw
exec npm start
