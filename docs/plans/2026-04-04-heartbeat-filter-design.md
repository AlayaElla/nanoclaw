# 心跳机制改进设计设计文档 (Heartbeat Filter Engine)

## 核心目标
将系统的任务巡视机制从“硬编码读取 Todo 列表并死板唤醒”，升级为“大模型静默后台自我审查”。当大模型所在的容器处于存活且空闲的状态时，定期发起心跳。如果不涉及具体任务操作，则在网关侧拦截并静默抛弃，避免重置预期的容器超时生命周期。

## 架构选型
选择【方案1：Gateway 网关拦截】，由独立的 `heartbeat.ts` 服务发起，在 `src/index.ts` 主消息循环截断。

## 执行链条设计

### 1. 触发源 (`src/services/heartbeat.ts`)
不再调用 `getGroupTodos()` 检查具体数据表。
核心判定逻辑变为：
```typescript
const status = queue.getGroupStatus(group.chat_jid);
if (status && status.active === false && status.containerName) {
    queue.sendMessage(group.chat_jid, "【系统后台节拍】请检查当前状态与最近对话，思考是否有未完成的任务。如果有，请立刻使用工具处理或者提醒用户。如果没有，请仅回复唯一关键词 _SYS_HEARTBEAT_SKIP_，不要带有任何标点和前言后语。");
    // 心跳周期可设置为 5分钟 / 10分钟
}
```

### 2. 网关侧拦截机制 (`src/index.ts`)
在 `processGroupMessages` 的 `runAgent` 流式回调输出闭包中，增加对心跳信标的识别防御墙。
```typescript
let isSuppressedHeartbeat = false;

// 1. 在解析 result 时拦截
if (text.trim() === '_SYS_HEARTBEAT_SKIP_') {
    isSuppressedHeartbeat = true;
    text = ''; // 清空，不发往底层 Channel (如 Telegram/微信)
}

// 2. 根据判断，决定是否进行原有的 resetIdleTimer 操作
if (!isSuppressedHeartbeat) {
   resetIdleTimer();
}

// 3. 在 queryCompleted 生命周期时，再次防护
if (result.queryCompleted && result.status === 'success') {
   queue.notifyIdle(chatJid);
   if (!isSuppressedHeartbeat) {
       resetIdleTimer();
   }
}
```

### 3. 数据流保证
- 拦截的 `_SYS_HEARTBEAT_SKIP_` 不会通过 `channel.sendMessage` 被发出。
- 我们需要跳过 `storeMessage` 数据库记录吗？**是的**，如果被抑制了，也不写入 `messages.db` 的 `bot_` 记录表中，防止系统自身由于记录这句无效信息又导致其他交叉唤醒的逻辑。

## 验证计划
- 观察测试群组在无人发言时，日志中是否产生 Heartbeat 发送和被 `suppress` 的记录。
- 确认挂机超过 30 分钟后，Agent 容器是否如期被自动销毁（证明 IdleTimer 未被重置）。
