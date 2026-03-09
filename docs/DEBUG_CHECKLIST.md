# NanoClaw 调试检查清单

## 已知问题 (2026-02-08)

### 1. [已修复] Resume 从过时的分支位置恢复
当 agent teams 生成子 agent CLI 进程时，它们会写入同一个会话 JSONL。在后续 `query()` 恢复时，CLI 读取 JSONL 但可能选择一个过时的分支末端（来自子 agent 活动之前），导致 agent 的响应落在宿主机从未收到 `result` 的分支上。**修复方案**：传入 `resumeSessionAt`，使用最后一条助手消息的 UUID 来明确锚定每次恢复。

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT（都是 30 分钟）
两个定时器同时触发，导致容器总是通过硬中断 SIGKILL（退出码 137）退出，而非优雅地通过 `_close` 哨兵关闭。空闲超时应该更短（例如 5 分钟），以便容器在消息间隔期间正常关闭，而容器超时保持在 30 分钟作为卡住 agent 的安全网。

### 3. 游标在 agent 成功前就被推进
`processGroupMessages` 在 agent 运行之前就推进了 `lastAgentTimestamp`。如果容器超时，重试时找不到消息（游标已经越过了它们）。消息在超时时被永久丢失。

## 快速状态检查

```bash
# 1. 服务是否在运行？
launchctl list | grep nanoclaw
# 预期输出：PID  0  com.nanoclaw（PID = 运行中，"-" = 未运行，非零退出码 = 崩溃）

# 2. 是否有运行中的容器？
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. 是否有已停止/孤立的容器？
container ls -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. 服务日志中的最近错误？
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. WhatsApp 是否已连接？（查看最后的连接事件）
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 6. 群组是否已加载？
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## 会话记录分支

```bash
# 检查会话调试日志中的并发 CLI 进程
ls -la data/sessions/<group>/.claude/debug/

# 统计处理消息的唯一 SDK 进程数
# 每个 .txt 文件 = 一个 CLI 子进程。多个 = 并发查询。

# 检查记录中的 parentUuid 分支
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## 容器超时排查

```bash
# 检查最近的超时
grep -E 'Container timeout|timed out' logs/nanoclaw.log | tail -10

# 检查超时容器的日志文件
ls -lt agents/*/logs/container-*.log | head -10

# 读取最近的容器日志（替换路径）
cat agents/<group>/logs/container-<timestamp>.log

# 检查是否有重试调度及其结果
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent 无响应

```bash
# 检查是否从 WhatsApp 收到消息
grep 'New messages' logs/nanoclaw.log | tail -10

# 检查消息是否正在处理（容器已启动）
grep -E 'Processing messages|Spawning container' logs/nanoclaw.log | tail -10

# 检查消息是否被管道传输到活动容器
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# 检查队列状态 — 是否有活动容器？
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# 检查 lastAgentTimestamp 与最新消息时间戳的对比
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## 容器挂载问题

```bash
# 检查挂载验证日志（在容器启动时显示）
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# 验证挂载允许列表是否可读
cat ~/.config/nanoclaw/mount-allowlist.json

# 检查数据库中群组的 container_config
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# 测试运行容器以检查挂载（模拟运行）
# 将 <group-folder> 替换为群组的文件夹名
container run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## WhatsApp 认证问题

```bash
# 检查是否请求了二维码（表示认证已过期）
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# 检查认证文件是否存在
ls -la store/auth/

# 如需重新认证
npm run auth
```

## 服务管理

```bash
# 重启服务
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 查看实时日志
tail -f logs/nanoclaw.log

# 停止服务（注意 — 运行中的容器是分离的，不会被终止）
launchctl bootout gui/$(id -u)/com.nanoclaw

# 启动服务
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# 代码修改后重新构建
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
