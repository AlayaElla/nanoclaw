#!/bin/bash

# 启动 LiteLLM 本地代理服务器
# 请在使用前确保 Ubuntu 系统安装了 Docker 并且已经启动

# 提示输入百炼 API Key
read -p "请输入你的阿里云百炼 API Key (sk-...): " QWEN_API_KEY

if [ -z "$QWEN_API_KEY" ]; then
    echo -e "\e[31m错误: 必须提供 QWEN_API_KEY\e[0m"
    exit 1
fi

echo -e "\e[36m正在拉取并启动 LiteLLM 代理容器 (端口 4000)...\e[0m"

# 停止可能已经存在的旧容器
docker rm -f nanoclaw-litellm-proxy 2>/dev/null

# 启动容器并挂载配置文件
# 注意：配置文件的路径需要绝对路径，这里用 $(pwd) 动态获取
docker run -d \
  -v $(pwd)/litellm_config.yaml:/app/config.yaml \
  -e QWEN_API_KEY=$QWEN_API_KEY \
  -p 4000:4000 \
  --name nanoclaw-litellm-proxy \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml

echo -e "\e[32mLiteLLM 已启动！运行 docker logs -f nanoclaw-litellm-proxy 查看日志。\e[0m"
echo -e "\e[33m接下来，请修改 NanoClaw 的 .env 文件：\e[0m"
echo -e "\e[33mANTHROPIC_BASE_URL=http://<宿主机物理IP>:4000\e[0m"
echo -e "\e[33mANTHROPIC_API_KEY=sk-proxy-key-not-used\e[0m"
echo -e "\e[33mANTHROPIC_MODEL=claude-3-5-sonnet-20241022\e[0m"
