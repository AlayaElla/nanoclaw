# 管理员工具

以下内容仅适用于主通道（isMain）。

## 管理员上下文

这是**主通道**，拥有提升的权限。

## 🐦 X/Twitter 集成

可以操作 X (Twitter)：

| 工具 | 用途 |
|------|------|
| `x_post` | 发布新推文 |
| `x_like` | 点赞推文 |
| `x_reply` | 回复推文 |
| `x_retweet` | 转推 |
| `x_quote` | 引用推文并评论 |
| `x_trends` | 查看全球热门推文 |

使用时需要推文 URL（如 `https://x.com/user/status/123`）。
`x_trends` 不需要 URL。

## 容器挂载

主通道对项目有只读访问权限，对其群组文件夹有读写访问权限：

| 容器路径 | 宿主机路径 | 访问权限 |
|----------|-----------|---------|
| `/workspace/project` | 项目根目录 | 只读 |
| `/workspace/group` | `data/workspace/{agent}/` | 读写 |

容器内的关键路径：
- `/workspace/project/store/messages.db` - 消息数据库（SQLite）
- `/workspace/project/store/groups.db`（registered_groups 表）- 群组配置
- `/workspace/project/agents/` - 所有群组的 CLAUDE.md 文件

---

## 群组管理

### 查找可用群组

可用群组在 `/workspace/ipc/available_groups.json` 中提供：

```json
{
  "groups": [
    {
      "jid": "120363336345536173@g.us",
      "name": "家庭聊天",
      "lastActivity": "2026-01-31T12:00:00.000Z",
      "isRegistered": false
    }
  ],
  "lastSync": "2026-01-31T12:00:00.000Z"
}
```

群组按最近活动时间排序。列表每天从通道同步。

如果用户提到的群组不在列表中，请求重新同步：

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

等待片刻后重新读取 `available_groups.json`。

**备选方案**：直接查询 SQLite 数据库：

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, last_message_time
  FROM chats
  WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

### 已注册群组配置

群组注册在 SQLite `registered_groups` 表中：

```json
{
  "1234567890-1234567890@g.us": {
    "name": "家庭聊天",
    "folder": "whatsapp_family-chat",
    "trigger": "@Andy",
    "added_at": "2024-01-31T12:00:00.000Z"
  }
}
```

字段说明：
- **Key**：聊天 JID（唯一标识符 — WhatsApp、Telegram、Slack、Discord 等）
- **name**：群组显示名称
- **folder**：以通道为前缀的文件夹名，位于 `agents/` 下，用于该群组的文件和记忆
- **trigger**：触发词（通常与全局相同，但可以不同）
- **requiresTrigger**：是否需要 `@trigger` 前缀（默认：`true`）。对于不需要触发词的私聊设置为 `false`
- **isMain**：是否为主控制群组（提升权限，不需要触发词）
- **added_at**：注册时的 ISO 时间戳

### 触发词行为

- **主群组**（`isMain: true`）：不需要触发词 — 所有消息自动处理
- **设置 `requiresTrigger: false` 的群组**：不需要触发词 — 所有消息都处理（用于一对一或私聊）
- **其他群组**（默认）：消息必须以 `@助理名` 开头才会被处理

### 添加群组

1. 查询数据库找到群组的 JID
2. 使用 `register_group` MCP 工具，提供 JID、名称、文件夹和触发词
3. 可选包含 `containerConfig` 用于额外挂载
4. 群组文件夹自动创建：`/workspace/project/agents/{folder-name}/`
5. 可选为该群组创建初始 `CLAUDE.md`

文件夹命名规范 — 通道前缀加下划线分隔，**文件夹名必须使用英文**（不能使用中文或其他非 ASCII 字符）：
- WhatsApp "家庭聊天" → `whatsapp_family-chat`
- Telegram "开发团队" → `telegram_dev-team`
- Discord "综合" → `discord_general`
- Slack "工程" → `slack_engineering`
- 使用小写英文字母，群组名部分使用连字符

#### 为群组添加额外目录

群组可以挂载额外的目录。在其配置中添加 `containerConfig`：

```json
{
  "1234567890@g.us": {
    "name": "开发团队",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

该目录将出现在该群组容器的 `/workspace/extra/webapp` 中。

### 移除群组

1. 在 `groups.db` 的 `registered_groups` 表中删除该群组的条目
2. 群组文件夹和文件保留不变（不要删除它们）

### 列出群组

读取 `groups.db` 的 `registered_groups` 表并格式化显示。

---

## 为其他群组安排任务

为其他群组安排任务时，使用 `target_group_jid` 参数并提供群组的 JID（来自 `groups.db`）：
- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "120363336345536173@g.us")`

任务将在该群组的上下文中运行，可以访问其文件和记忆。
