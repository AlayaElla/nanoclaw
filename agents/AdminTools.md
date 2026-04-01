# 管理员工具

以下内容仅适用于主通道（isMain）。

## 容器挂载

主通道对项目（代码和基础配置）有只读访问权限，对该 Agent 的**共享工作区**有读写访问权限（同一个 Agent 负责的所有群组会共享这个工作区）：

| 容器路径 | 宿主机路径 | 访问权限 |
|----------|-----------|---------|
| `/workspace/project` | 项目根目录 | 只读 |
| `/workspace/group` | `data/workspace/{agent_name}/` | 读写 |

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

### 注册与群组配置

群组会注册在 SQLite 中 `groups.db` 数据库的 `registered_groups` 表里。为简洁起见，**各字段的含义、文件夹的命名规范、必填项与配置项结构，请直接阅读和参考 `register_group` MCP 工具内的参数说明。**

**关键设定的补充说明：**
- **触发行为**：主群组（`isMain: true`）及明确设定了 `requires_trigger: false` 的群组（如私聊），无需呼唤触发词即可接管所有消息。其他普通群组必须由消息前导触发词（即你设定的 `@名字`）才能响应。
- **额外挂载目录**：若你在调用注册工具时提供了 `container_config` 参数并包含自定义挂载数组，对应的宿主机目录将被安全映射，并在新群组容器内的 `/workspace/extra/{containerPath}` 中出现。

### 列出群组

读取 `groups.db` 的 `registered_groups` 表并格式化显示。

---

## 为其他群组安排任务

为其他群组安排任务时，使用 `target_group_jid` 参数并提供群组的 JID（来自 `groups.db`）：
- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "120363336345536173@g.us")`

任务将在该群组的上下文中运行，可以访问其文件和记忆。
