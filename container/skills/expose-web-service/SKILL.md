---
name: expose-web-service
description: 将容器内运行的本地 Web 服务暴露到公网，以便用户可以通过他们的浏览器访问和预览。
allowed-tools: Bash(cloudflared), Bash(grep)
---

# 暴露 Web 服务 (Expose Web Service)

当你在容器内启动了一个 Web 服务器或 Web 应用程序，并且用户需要通过他们本地的浏览器来访问或预览时，你可以使用 Cloudflare Quick Tunnels (`cloudflared`) 安全地将其暴露到互联网上。

## 工作流程

1. 确保你的 Web 服务正在运行，并且配置为监听 `0.0.0.0`（所有接口）或 `127.0.0.1`（localhost）。
2. 启动 Cloudflare 隧道并指向你的本地端口：
   ```bash
   cloudflared tunnel --url http://127.0.0.1:<PORT> > cloudflared.log 2>&1 &
   ```
3. 等待几秒钟让隧道建立连接。
4. 从日志文件中提取生成的公网 URL：
   ```bash
   grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' cloudflared.log | head -n 1
   ```
5. 将提取到的 URL 发送给用户，以便他们能够访问这个 Web 服务。

## 示例

假设你在 8000 端口启动了一个 Python HTTP 服务：
```bash
python3 -m http.server 8000 &
```

暴露该服务：
```bash
cloudflared tunnel --url http://127.0.0.1:8000 > cloudflared.log 2>&1 &
```

等待并查找 URL：
```bash
sleep 3
grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' cloudflared.log | head -n 1
```

拿到 URL 后，告诉用户：“我已经为你暴露了该服务。你可以点击以下链接进行访问和预览：<URL>”

## 重要注意事项
- 这将创建一个临时的、阅后即焚的 URL。如果 `cloudflared` 进程结束或容器重启，该 URL 将失效。
- 请明确告知用户这是一个用于预览的临时 URL。
- 如果没有找到 URL，你可以阅读 `cloudflared.log` 文件来排查任何潜在的问题。
