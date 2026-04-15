---
name: expose-web-service
description: 将容器内运行的本地 Web 服务通过 Cloudflare Quick Tunnel 暴露到公网，让用户在浏览器中预览。
allowed-tools: Bash(cloudflared), Bash(node), Bash(grep), Bash(sleep), Bash(cat), Bash(kill), Bash(pgrep), Bash(ss), Bash(rm)
---

# 暴露 Web 服务 (Expose Web Service)

## 环境前提

你运行在一个使用 `--network host` 模式的 Docker 容器中。这意味着：
- 容器与宿主机**共享**同一个网络栈。
- `127.0.0.1` 和 `0.0.0.0` 都直接指向宿主机的网络接口。
- 你在容器内启动的任何服务器，**会直接占用宿主机的端口**。

容器内已预装 `cloudflared` 命令行工具。

## 核心流程（3 步）

### 第 1 步：启动 Web 服务器

启动你的 Web 应用，让它**监听 `0.0.0.0`**（不要使用 `localhost` 或 `127.0.0.1`，某些框架默认只监听 loopback 地址，会导致 cloudflared 无法连接）。

> **关键：端口必须从 40000-60000 范围内选择**（如 `49152`、`51234`、`55678`），避免与宿主机上已有服务冲突。低于 40000 的端口（如 `3000`、`8000`、`8080`）大概率已被占用。

```bash
# ✅ 正确：监听 0.0.0.0 + 不常见端口
python3 -m http.server 49152 --bind 0.0.0.0 &

# ✅ 正确：Node.js 示例
node -e "require('http').createServer((q,s)=>{s.end('Hello')}).listen(49152,'0.0.0.0')" &

# ❌ 错误：只监听 localhost（某些框架默认行为）
# npm run dev  ← Vite 默认监听 localhost，必须加 --host 0.0.0.0
```

**常见框架的正确启动方式：**

| 框架 | 正确命令 | 说明 |
|------|---------|------|
| Python http.server | `python3 -m http.server 49152 --bind 0.0.0.0 &` | 必须加 `--bind 0.0.0.0` |
| Vite (React/Vue/Svelte) | `npx vite --host 0.0.0.0 --port 49152 &` | 必须加 `--host 0.0.0.0` |
| Next.js | `npx next dev -H 0.0.0.0 -p 49152 &` | 必须加 `-H 0.0.0.0` |
| Flask | `flask run --host 0.0.0.0 --port 49152 &` | 必须加 `--host 0.0.0.0` |
| Express/Node | `HOST=0.0.0.0 PORT=49152 node server.js &` | 在代码中使用 `process.env.HOST` |
| 纯 HTML 文件 | `python3 -m http.server 49152 --bind 0.0.0.0 &` | 最简单的静态文件服务方式 |

### 第 2 步：启动 Cloudflare Tunnel

等服务器就绪后，启动 cloudflared 隧道。

> **必须加 `--protocol http2`**。默认 QUIC 协议需要解析 SRV 记录，在容器内 DNS 解析失败率约 50%（`server misbehaving`）。使用 http2 可完全规避此问题。

```bash
# 等待服务器启动完成
sleep 2

# 启动隧道（--protocol http2 避免 DNS/QUIC 问题，日志文件名包含端口号）
cloudflared tunnel --protocol http2 --url http://localhost:49152 > /tmp/cloudflared-49152.log 2>&1 &

# 等待隧道建立连接（通常需要 3-5 秒）
sleep 5
```

**如果隧道启动失败（日志中出现 `server misbehaving` 或无 URL），执行重试：**

```bash
# 杀掉失败的进程并重启
kill $(pgrep -f "cloudflared.*49152") 2>/dev/null
sleep 1
cloudflared tunnel --protocol http2 --url http://localhost:49152 > /tmp/cloudflared-49152.log 2>&1 &
sleep 5
```

> **日志文件必须写入 `/tmp/`，且文件名包含端口号**（格式：`/tmp/cloudflared-<PORT>.log`）。这样多个隧道可以同时运行互不干扰。

### 第 3 步：提取公网 URL 并发送给用户

```bash
grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' /tmp/cloudflared-49152.log | head -n 1
```

如果没有提取到 URL：
1. 检查日志：`cat /tmp/cloudflared-<PORT>.log`
2. 常见原因：服务器未启动完成、端口被占用、网络问题
3. 如果日志显示 `connection refused`，说明服务器没有正确监听，回到第 1 步检查

拿到 URL 后，立即发送给用户，格式如下：

> 你的 Web 服务已上线！点击以下链接在浏览器中预览：
> 🔗 https://xxxx-xxxx.trycloudflare.com
>
> ⚠️ 这是一个临时预览链接。

---

## 自带静态文件服务器

本技能附带了一个现成的 `server.js`，位于技能目录内。**提供静态文件预览时，直接使用它，不需要自己编写服务器代码。**

路径：`/workspace/group/.claude/skills/expose-web-service/server.js`

```bash
# 用法：node server.js [目录] [端口]
node /workspace/group/.claude/skills/expose-web-service/server.js           # 服务 cwd，端口 49152
node /workspace/group/.claude/skills/expose-web-service/server.js ./dist    # 服务 ./dist 目录
node /workspace/group/.claude/skills/expose-web-service/server.js ./build 50080  # 自定义端口
```

功能：自动处理 MIME 类型、目录 index.html、路径穿越防护、CORS 跨域头、端口范围校验（40000-60000）。

---

## 完整可复制示例

### 示例 A：提供 HTML/静态文件预览（推荐）

```bash
# 1. 用自带服务器服务当前目录
node /workspace/group/.claude/skills/expose-web-service/server.js . 49152 &
sleep 1

# 2. 启动隧道
cloudflared tunnel --protocol http2 --url http://localhost:49152 > /tmp/cloudflared-49152.log 2>&1 &
sleep 5

# 3. 提取 URL
grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' /tmp/cloudflared-49152.log | head -n 1
```

### 示例 B：Vite / Next.js 等框架项目

```bash
# 1. 安装依赖并启动开发服务器（注意 --host 和端口范围）
npm install
npx vite --host 0.0.0.0 --port 49152 &
sleep 5  # 首次启动可能较慢

# 2. 启动隧道
cloudflared tunnel --protocol http2 --url http://localhost:49152 > /tmp/cloudflared-49152.log 2>&1 &
sleep 5

# 3. 提取 URL
grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' /tmp/cloudflared-49152.log | head -n 1
```

### 示例 C：用自带服务器服务构建产物

```bash
# 1. 构建项目
npm run build

# 2. 用自带服务器服务 dist/ 目录
node /workspace/group/.claude/skills/expose-web-service/server.js ./dist 49152 &
sleep 1

# 3. 启动隧道 + 提取 URL
cloudflared tunnel --protocol http2 --url http://localhost:49152 > /tmp/cloudflared-49152.log 2>&1 &
sleep 5
grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' /tmp/cloudflared-49152.log | head -n 1
```

---

## 清理（当用户不再需要预览时）

```bash
# 终止 cloudflared 隧道
kill $(pgrep cloudflared) 2>/dev/null

# 终止 Web 服务器（根据实际情况选择）
kill $(pgrep -f "http.server") 2>/dev/null   # Python
kill $(pgrep -f "vite") 2>/dev/null          # Vite
kill $(pgrep -f "node.*server") 2>/dev/null  # Node

# 清理日志（删除所有隧道日志）
rm -f /tmp/cloudflared-*.log
```

## 常见错误排查

| 现象 | 原因 | 解决方案 |
|------|------|---------|
| `grep` 未提取到 URL | 隧道尚未就绪 | 多等几秒：`sleep 10` 后重试 grep |
| 日志显示 `server misbehaving` | DNS 解析失败（QUIC/SRV 问题） | 确认已加 `--protocol http2`，然后 kill 并重启隧道 |
| 日志显示 `connection refused` | 服务器未监听或端口不对 | 检查服务器是否在运行：`ss -tlnp \| grep 49152` |
| `Address already in use` | 端口被宿主机服务占用 | 换一个 40000-60000 范围内的端口（如 `51234`） |
| 页面加载但内容为空 | 服务器监听了 `localhost` 而非 `0.0.0.0` | 加 `--host 0.0.0.0` 或 `--bind 0.0.0.0` |
| URL 打开后 502 Bad Gateway | 服务器崩溃或未完全启动 | 检查服务器日志，确认进程存活 |
