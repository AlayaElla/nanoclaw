# NanoClaw 注册与启动指南

## 配置文件

### agents.yaml — Bot 配置

每个 bot 的 token、名字、模型：

```yaml
bots:
  - name: 星梦
    token: "your-bot-1-token"
    model: kimi-k2.5

  - name: 星月
    token: "your-bot-2-token"
    model: qwen3.5-plus
```

### .env — 秘钥与基础设施

API Key、代理地址等。Bot token 不放这里，放 `agents.yaml`。

---

## 全新启动流程

### 1. 首次建表

```bash
npm start
# 看到 "Database initialized" 后 Ctrl+C
```

### 2. 获取 JID

给每个 bot 发送 `/chatid`，获取格式如 `tg:{userId}@{botId}` 的 JID。

### 3. 注册群组

```bash
sqlite3 store/messages.db "
INSERT INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, is_main, requires_trigger, bot_token, assistant_name)
VALUES
  -- 1. 主 Agent (星梦):
  -- folder必须是'main', is_main=1, bot_token=NULL (系统自动分配给agents.yaml中的第1个Bot)
  ('tg:你的ID@bot1的ID', '星梦私聊', 'main', '@星梦', datetime('now'), 1, 0, NULL, '星梦'),

  -- 2. 第二个 Agent (星月):
  -- folder必须带通道前缀(如'telegram_XXX'), is_main=0, bot_token='TELEGRAM_BOT_TOKEN_2' (对应第2个Bot)
  ('tg:你的ID@bot2的ID', '星月私聊', 'telegram_星月', '@星月', datetime('now'), 0, 0, 'TELEGRAM_BOT_TOKEN_2', '星月');
"
```

**关键字段说明：**

| 字段 | 说明 | 示例 (星梦) | 示例 (星月) |
|------|------|----------|----------|
| `jid` | Telegram的唯一会话ID | `tg:123@456` | `tg:123@789` |
| `folder` | 记忆存放的文件夹 | `main` (固定) | `telegram_星月` |
| `is_main` | 是否为最高权限主群组 | `1` | `0` |
| `requires_trigger` | 是否必须用`@`才能触发它聊天。私聊设为0，群聊设为1。 | `0` | `0` |
| `bot_token` | 分配给该群组的 Bot，对应 `agents.yaml` 里的编号。 | `NULL` | `TELEGRAM_BOT_TOKEN_2` |

### 实际例子解析
```bash
sqlite3 store/messages.db "
INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, is_main, requires_trigger, bot_token, assistant_name)
VALUES
  -- 1. 主 Agent (星梦):
  -- folder必须是'main', is_main=1
  ('tg:8627609390@8624060050', '星梦私聊', 'main', '@星梦', datetime('now'), 1, 0, 'TELEGRAM_BOT_TOKEN_1', '星梦'),

  -- 2. 第二个 Agent (星月):
  -- folder必须带通道前缀(如'telegram_XXX'), is_main=0
  ('tg:8627609390@8505631292', '星月私聊', 'telegram_星月', '@星月', datetime('now'), 0, 0, 'TELEGRAM_BOT_TOKEN_2', '星月');
"

```


### 4. 启动

```bash
./start.sh
```

---

## 模型配置

模型配置仅由 `agents.yaml` 控制。每个 Bot 的 `model` 决定了由它处理的所有消息（无论是哪个群组或私聊）使用的模型。如果需要为不同场景使用不同模型，请新建 Bot 并配置不同的 Token 和 Model。

## 清理重置

```bash
rm -f store/messages.db
rm -rf data/sessions/ data/ipc/ data/rag/ data/x-browser-profile/
rm -f groups/*/logs/*.log
```

然后重新走上面的启动流程。
