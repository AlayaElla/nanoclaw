# Claude Agent SDK 深度剖析

通过逆向工程 `@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.34 的发现，旨在理解 `query()` 的工作原理、为什么 agent teams 的子 agent 会被终止，以及如何修复。辅以官方 SDK 参考文档。

## 架构

```
Agent Runner（我们的代码）
  └── query() → SDK (sdk.mjs)
        └── 生成 CLI 子进程 (cli.js)
              └── Claude API 调用、工具执行
              └── Task 工具 → 生成子 agent 子进程
```

SDK 将 `cli.js` 作为子进程生成，使用 `--output-format stream-json --input-format stream-json --print --verbose` 标志。通过 stdin/stdout 上的 JSON-lines 进行通信。

`query()` 返回一个扩展了 `AsyncGenerator<SDKMessage, void>` 的 `Query` 对象。内部机制：

- SDK 将 CLI 作为子进程生成，通过 stdin/stdout JSON-lines 通信
- SDK 的 `readMessages()` 从 CLI stdout 读取，压入内部流
- `readSdkMessages()` 异步生成器从该流中产出
- `[Symbol.asyncIterator]` 返回 `readSdkMessages()`
- 迭代器仅在 CLI 关闭 stdout 时返回 `done: true`

V1 (`query()`) 和 V2 (`createSession`/`send`/`stream`) 使用完全相同的三层架构：

```
SDK (sdk.mjs)           CLI 进程 (cli.js)
--------------          --------------------
XX Transport  ------>   stdin 读取器 (bd1)
  (生成 cli.js)            |
$X Query      <------   stdout 写入器
  (JSON-lines)             |
                        EZ() 递归生成器
                           |
                        Anthropic Messages API
```

## 核心 Agent 循环 (EZ)

CLI 内部的 agentic 循环是一个**名为 `EZ()` 的递归异步生成器**，而不是迭代式 while 循环：

```
EZ({ messages, systemPrompt, canUseTool, maxTurns, turnCount=1, ... })
```

每次调用 = 一次 Claude API 调用（一个"轮次"）。

### 每轮次的流程：

1. **准备消息** — 裁剪上下文，必要时进行压缩
2. **调用 Anthropic API**（通过 `mW1` 流式函数）
3. **从响应中提取 tool_use 块**
4. **分支：**
   - 如果**没有 tool_use 块** → 停止（运行停止钩子，返回）
   - 如果**有 tool_use 块** → 执行工具，递增 turnCount，递归

所有复杂逻辑 — agent 循环、工具执行、后台任务、团队协调 — 都在 CLI 子进程内运行。`query()` 只是一个瘦传输层包装器。

## query() 选项

官方文档中完整的 `Options` 类型：

| 属性 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `abortController` | `AbortController` | `new AbortController()` | 用于取消操作的控制器 |
| `additionalDirectories` | `string[]` | `[]` | Claude 可以访问的额外目录 |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | 编程式定义子 agent（非 agent teams — 无编排） |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | 使用 `permissionMode: 'bypassPermissions'` 时必需 |
| `allowedTools` | `string[]` | 所有工具 | 允许的工具名称列表 |
| `betas` | `SdkBeta[]` | `[]` | Beta 功能（如 `['context-1m-2025-08-07']` 启用 1M 上下文） |
| `canUseTool` | `CanUseTool` | `undefined` | 工具使用的自定义权限函数 |
| `continue` | `boolean` | `false` | 继续最近的对话 |
| `cwd` | `string` | `process.cwd()` | 当前工作目录 |
| `disallowedTools` | `string[]` | `[]` | 不允许的工具名称列表 |
| `enableFileCheckpointing` | `boolean` | `false` | 启用文件变更追踪以支持回滚 |
| `env` | `Dict<string>` | `process.env` | 环境变量 |
| `executable` | `'bun' \| 'deno' \| 'node'` | 自动检测 | JavaScript 运行时 |
| `fallbackModel` | `string` | `undefined` | 主模型失败时使用的备选模型 |
| `forkSession` | `boolean` | `false` | 恢复时分叉到新的会话 ID 而非继续原会话 |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | 事件的钩子回调 |
| `includePartialMessages` | `boolean` | `false` | 包含部分消息事件（流式传输） |
| `maxBudgetUsd` | `number` | `undefined` | 查询的最大预算（美元） |
| `maxThinkingTokens` | `number` | `undefined` | 思考过程的最大 token 数 |
| `maxTurns` | `number` | `undefined` | 最大对话轮次 |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP 服务器配置 |
| `model` | `string` | CLI 默认值 | 使用的 Claude 模型 |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | 结构化输出格式 |
| `pathToClaudeCodeExecutable` | `string` | 使用内置 | Claude Code 可执行文件的路径 |
| `permissionMode` | `PermissionMode` | `'default'` | 权限模式 |
| `plugins` | `SdkPluginConfig[]` | `[]` | 从本地路径加载自定义插件 |
| `resume` | `string` | `undefined` | 要恢复的会话 ID |
| `resumeSessionAt` | `string` | `undefined` | 在特定消息 UUID 处恢复会话 |
| `sandbox` | `SandboxSettings` | `undefined` | 沙盒行为配置 |
| `settingSources` | `SettingSource[]` | `[]`（无） | 要加载的文件系统设置。需包含 `'project'` 才能加载 CLAUDE.md |
| `stderr` | `(data: string) => void` | `undefined` | stderr 输出的回调 |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | 系统提示词。使用 preset 获取 Claude Code 的提示词，可选追加内容 |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | 工具配置 |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
```

### SettingSource

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json（版本控制的）
// 'local'   → .claude/settings.local.json（gitignored）
```

未指定时，SDK 不加载任何文件系统设置（默认隔离）。优先级：local > project > user。编程式选项始终覆盖文件系统设置。

### AgentDefinition

编程式子 agent（非 agent teams — 这些更简单，无 agent 间协调）：

```typescript
type AgentDefinition = {
  description: string;  // 何时使用此 agent
  tools?: string[];     // 允许的工具（未指定则继承所有）
  prompt: string;       // Agent 的系统提示词
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }  // 进程内
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// 为 Opus 4.6、Sonnet 4.5、Sonnet 4 启用 1M token 上下文窗口
```

### CanUseTool

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage 类型

`query()` 可以产出 16 种消息类型。官方文档展示了简化的 7 种联合类型，但 `sdk.d.ts` 包含完整集合：

| 类型 | 子类型 | 用途 |
|------|--------|------|
| `system` | `init` | 会话初始化，包含 session_id、tools、model |
| `system` | `task_notification` | 后台 agent 已完成/失败/停止 |
| `system` | `compact_boundary` | 对话已被压缩 |
| `system` | `status` | 状态变更（如压缩中） |
| `system` | `hook_started` | 钩子执行开始 |
| `system` | `hook_progress` | 钩子执行进度 |
| `system` | `hook_response` | 钩子执行完成 |
| `system` | `files_persisted` | 文件已保存 |
| `assistant` | — | Claude 的响应（文本 + 工具调用） |
| `user` | — | 用户消息（内部） |
| `user`（重放） | — | 恢复时重放的用户消息 |
| `result` | `success` / `error_*` | 一轮提示处理的最终结果 |
| `stream_event` | — | 部分流式传输（当 includePartialMessages 启用时） |
| `tool_progress` | — | 长时间运行工具的进度 |
| `auth_status` | — | 认证状态变更 |
| `tool_use_summary` | — | 前面工具使用的摘要 |

### SDKTaskNotificationMessage (sdk.d.ts:1507)

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (sdk.d.ts:1375)

两个变体，共享字段：

```typescript
// 两个变体的共享字段：
// uuid, session_id, duration_ms, duration_api_ms, is_error, num_turns,
// total_cost_usd, usage: NonNullableUsage, modelUsage, permission_denials

// 成功：
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;
  structured_output?: unknown;
  // ...共享字段
};

// 错误：
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // ...共享字段
};
```

结果上的有用字段：`total_cost_usd`、`duration_ms`、`num_turns`、`modelUsage`（按模型细分，包含 `costUSD`、`inputTokens`、`outputTokens`、`contextWindow`）。

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // 来自 Anthropic SDK
  parent_tool_use_id: string | null; // 来自子 agent 时为非 null
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
};
```

## 轮次行为：Agent 何时停止 vs 继续

### Agent 停止的情况（不再进行 API 调用）

**1. 响应中没有 tool_use 块（主要情况）**

Claude 只回复了文本 — 它决定任务已完成。API 的 `stop_reason` 将是 `"end_turn"`。SDK 不做此决定 — 完全由 Claude 的模型输出驱动。

**2. 超过最大轮次** — 产生 `SDKResultError`，`subtype: "error_max_turns"`。

**3. 中止信号** — 用户通过 `abortController` 中断。

**4. 超出预算** — `totalCost >= maxBudgetUsd` → `"error_max_budget_usd"`。

**5. 停止钩子阻止继续** — 钩子返回 `{preventContinuation: true}`。

### Agent 继续的情况（进行另一次 API 调用）

**1. 响应包含 tool_use 块（主要情况）** — 执行工具，递增 turnCount，递归进入 EZ。

**2. max_output_tokens 恢复** — 最多 3 次重试，附带"将工作拆分为更小的部分"的上下文消息。

**3. 停止钩子阻塞错误** — 错误作为上下文消息反馈，循环继续。

**4. 模型回退** — 使用备选模型重试（一次性）。

### 决策表

| 条件 | 动作 | 结果类型 |
|------|------|----------|
| 响应有 `tool_use` 块 | 执行工具，递归进入 `EZ` | 继续 |
| 响应没有 `tool_use` 块 | 运行停止钩子，返回 | `success` |
| `turnCount > maxTurns` | 产出 max_turns_reached | `error_max_turns` |
| `totalCost >= maxBudgetUsd` | 产出预算错误 | `error_max_budget_usd` |
| `abortController.signal.aborted` | 产出中断消息 | 取决于上下文 |
| `stop_reason === "max_tokens"`（输出） | 最多重试 3 次，附带恢复提示 | 继续 |
| 停止钩子 `preventContinuation` | 立即返回 | `success` |
| 停止钩子阻塞错误 | 反馈错误，递归 | 继续 |
| 模型回退错误 | 使用备选模型重试（一次性） | 继续 |

## 子 Agent 执行模式

### 情况 1：同步子 Agent（`run_in_background: false`）— 阻塞

父 agent 调用 Task 工具 → `VR()` 为子 agent 运行 `EZ()` → 父 agent 等待完整结果 → 工具结果返回给父 agent → 父 agent 继续。

子 agent 运行完整的递归 EZ 循环。父 agent 的工具执行通过 `await` 挂起。有一个执行中的"提升"机制：同步子 agent 可以通过 `Promise.race()` 与 `backgroundSignal` promise 竞争来提升为后台运行。

### 情况 2：后台任务（`run_in_background: true`）— 不等待

- **Bash 工具：** 命令启动，工具立即返回空结果 + `backgroundTaskId`
- **Task/Agent 工具：** 子 agent 在即发即弃包装器（`g01()`）中启动，工具立即返回 `status: "async_launched"` + `outputFile` 路径

在发出 `type: "result"` 消息之前没有"等待后台任务"的逻辑。当后台任务完成时，会单独发出 `SDKTaskNotificationMessage`。

### 情况 3：Agent Teams（TeammateTool / SendMessage）— 先结果，后轮询

团队领导运行其正常的 EZ 循环，包括生成队友。当领导的 EZ 循环结束时，发出 `type: "result"`。然后领导进入结果后的轮询循环：

```javascript
while (true) {
    // 检查是否没有活跃队友且没有运行中的任务 → 跳出
    // 检查来自队友的未读消息 → 重新注入为新提示，重新启动 EZ 循环
    // 如果 stdin 关闭但有活跃队友 → 注入关闭提示
    // 每 500ms 轮询
}
```

从 SDK 消费者的角度：你收到初始的 `type: "result"`，但 AsyncGenerator 可能会继续产出更多消息，因为团队领导处理队友的响应并重新进入 agent 循环。生成器仅在所有队友关闭后才真正结束。

## isSingleUserTurn 问题

来自 sdk.mjs：

```javascript
QK = typeof X === "string"  // isSingleUserTurn = true 当 prompt 是字符串时
```

当 `isSingleUserTurn` 为 true 且第一个 `result` 消息到达时：

```javascript
if (this.isSingleUserTurn) {
  this.transport.endInput();  // 关闭 CLI 的 stdin
}
```

这触发了连锁反应：

1. SDK 关闭 CLI stdin
2. CLI 检测到 stdin 关闭
3. 轮询循环看到 `D = true`（stdin 关闭）且有活跃的队友
4. 注入关闭提示 → 领导向所有队友发送 `shutdown_request`
5. **队友在研究过程中被终止**

关闭提示（通过混淆代码中的 `BGq` 变量找到）：

```
你正在非交互模式下运行，在团队关闭之前无法向用户返回响应。

你必须在准备最终响应之前关闭你的团队：
1. 使用 requestShutdown 要求每个团队成员优雅关闭
2. 等待关闭确认
3. 使用 cleanup 操作清理团队
4. 然后才提供你的最终响应给用户
```

### 实际问题

使用 V1 `query()` + 字符串 prompt + agent teams 时：

1. 领导生成队友，他们开始研究
2. 领导的 EZ 循环结束（"我已经派遣了团队，他们正在处理"）
3. 发出 `type: "result"`
4. SDK 看到 `isSingleUserTurn = true` → 立即关闭 stdin
5. 轮询循环检测到 stdin 关闭 + 活跃队友 → 注入关闭提示
6. 领导向所有队友发送 `shutdown_request`
7. **队友可能才进行了 5 分钟研究任务中的 10 秒就被告知停止**

## 修复方案：流式输入模式

不传递字符串 prompt（会设置 `isSingleUserTurn = true`），而是传递 `AsyncIterable<SDKUserMessage>`：

```typescript
// 之前（对 agent teams 有问题）：
query({ prompt: "做某事" })

// 之后（保持 CLI 存活）：
query({ prompt: asyncIterableOfMessages })
```

当 prompt 是 `AsyncIterable` 时：
- `isSingleUserTurn = false`
- SDK 在第一个结果后不关闭 stdin
- CLI 保持存活，继续处理
- 后台 agent 继续运行
- `task_notification` 消息通过迭代器流转
- 我们控制何时结束 iterable

### 额外好处：流式传入新消息

使用异步 iterable 方式，我们可以在 agent 仍在工作时将新的 WhatsApp 消息推入 iterable。不再需要将消息排队直到容器退出并启动新容器，而是直接流式传入运行中的会话。

### 使用 Agent Teams 的预期生命周期

使用异步 iterable 修复后（`isSingleUserTurn = false`），stdin 保持打开，因此 CLI 永远不会触发队友检查或关闭提示注入：

```
1. system/init          → 会话初始化
2. assistant/user       → Claude 推理、工具调用、工具结果
3. ...                  → 更多 assistant/user 轮次（生成子 agent 等）
4. result #1            → 领导 agent 的第一个响应（捕获）
5. task_notification(s) → 后台 agent 完成/失败/停止
6. assistant/user       → 领导 agent 继续（处理子 agent 结果）
7. result #2            → 领导 agent 的后续响应（捕获）
8. [iterator done]      → CLI 关闭 stdout，全部完成
```

所有结果都有意义 — 捕获每一个，不只是第一个。

## V1 vs V2 API

### V1：`query()` — 一次性异步生成器

```typescript
const q = query({ prompt: "...", options: {...} });
for await (const msg of q) { /* 处理事件 */ }
```

- 当 `prompt` 是字符串时：`isSingleUserTurn = true` → 第一个结果后自动关闭 stdin
- 多轮模式：必须传递 `AsyncIterable<SDKUserMessage>` 并自行管理协调

### V2：`createSession()` + `send()` / `stream()` — 持久会话

```typescript
await using session = unstable_v2_createSession({ model: "..." });
await session.send("第一条消息");
for await (const msg of session.stream()) { /* 事件 */ }
await session.send("后续消息");
for await (const msg of session.stream()) { /* 事件 */ }
```

- `isSingleUserTurn = false` 始终 → stdin 保持打开
- `send()` 压入异步队列（`QX`）
- `stream()` 从同一消息生成器中产出，在 `result` 类型时停止
- 多轮是自然的 — 只需交替 `send()` / `stream()`
- V2 内部不调用 V1 `query()` — 两者独立创建 Transport + Query

### 对比表

| 方面 | V1 | V2 |
|------|----|----|
| `isSingleUserTurn` | 字符串 prompt 时为 `true` | 始终为 `false` |
| 多轮 | 需要管理 `AsyncIterable` | 只需调用 `send()`/`stream()` |
| stdin 生命周期 | 第一个结果后自动关闭 | 保持打开直到 `close()` |
| Agentic 循环 | 相同的 `EZ()` | 相同的 `EZ()` |
| 停止条件 | 相同 | 相同 |
| 会话持久化 | 必须传 `resume` 到新的 `query()` | 通过 session 对象内置 |
| API 稳定性 | 稳定 | 不稳定预览（`unstable_v2_*` 前缀） |

**关键发现：轮次行为零差异。** 两者使用相同的 CLI 进程、相同的 `EZ()` 递归生成器和相同的决策逻辑。

## 钩子事件

```typescript
type HookEvent =
  | 'PreToolUse'         // 工具执行前
  | 'PostToolUse'        // 工具执行成功后
  | 'PostToolUseFailure' // 工具执行失败后
  | 'Notification'       // 通知消息
  | 'UserPromptSubmit'   // 用户提示已提交
  | 'SessionStart'       // 会话开始（启动/恢复/清除/压缩）
  | 'SessionEnd'         // 会话结束
  | 'Stop'               // Agent 停止中
  | 'SubagentStart'      // 子 agent 已生成
  | 'SubagentStop'       // 子 agent 已停止
  | 'PreCompact'         // 对话压缩前
  | 'PermissionRequest'; // 权限请求中
```

### 钩子配置

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // 可选的工具名称匹配器
  hooks: HookCallback[];
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### 钩子返回值

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string };
};
```

### 子 Agent 钩子（来自 sdk.d.ts）

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
};

// BaseHookInput = { session_id, transcript_path, cwd, permission_mode? }
```

## Query 接口方法

`Query` 对象（sdk.d.ts:931）。官方文档列出的公共方法：

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                     // 停止当前执行（仅流式输入模式）
  rewindFiles(userMessageUuid: string): Promise<void>; // 将文件恢复到指定消息时的状态（需要 enableFileCheckpointing）
  setPermissionMode(mode: PermissionMode): Promise<void>; // 更改权限（仅流式输入模式）
  setModel(model?: string): Promise<void>;        // 更改模型（仅流式输入模式）
  setMaxThinkingTokens(max: number | null): Promise<void>; // 更改思考 token 数（仅流式输入模式）
  supportedCommands(): Promise<SlashCommand[]>;   // 可用的斜杠命令
  supportedModels(): Promise<ModelInfo[]>;         // 可用的模型
  mcpServerStatus(): Promise<McpServerStatus[]>;  // MCP 服务器连接状态
  accountInfo(): Promise<AccountInfo>;             // 已认证用户信息
}
```

在 sdk.d.ts 中找到但不在官方文档中（可能是内部的）：
- `streamInput(stream)` — 流式传入额外用户消息
- `close()` — 强制结束查询
- `setMcpServers(servers)` — 动态添加/移除 MCP 服务器

## 沙盒配置

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  ignoreViolations?: {
    file?: string[];
    network?: string[];
  };
};
```

当 `allowUnsandboxedCommands` 为 true 时，模型可以在 Bash 工具输入中设置 `dangerouslyDisableSandbox: true`，这会回退到 `canUseTool` 权限处理器。

## MCP 服务器辅助工具

### tool()

使用 Zod schema 创建类型安全的 MCP 工具定义：

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

### createSdkMcpServer()

创建进程内 MCP 服务器（我们使用 stdio 替代以支持子 agent 继承）：

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

## 内部参考

### 关键混淆标识符（sdk.mjs）

| 混淆名 | 用途 |
|--------|------|
| `s_` | V1 `query()` 导出 |
| `e_` | `unstable_v2_createSession` |
| `Xx` | `unstable_v2_resumeSession` |
| `Qx` | `unstable_v2_prompt` |
| `U9` | V2 Session 类（`send`/`stream`/`close`） |
| `XX` | ProcessTransport（生成 cli.js） |
| `$X` | Query 类（JSON-line 路由、异步 iterable） |
| `QX` | AsyncQueue（输入流缓冲区） |

### 关键混淆标识符（cli.js）

| 混淆名 | 用途 |
|--------|------|
| `EZ` | 核心递归 agentic 循环（异步生成器） |
| `_t4` | 停止钩子处理器（当没有 tool_use 块时运行） |
| `PU1` | 流式工具执行器（API 响应期间并行） |
| `TP6` | 标准工具执行器（API 响应后） |
| `GU1` | 单个工具执行器 |
| `lTq` | SDK 会话运行器（直接调用 EZ） |
| `bd1` | stdin 读取器（来自 transport 的 JSON-lines） |
| `mW1` | Anthropic API 流式调用器 |

## 关键文件

- `sdk.d.ts` — 所有类型定义（1777 行）
- `sdk-tools.d.ts` — 工具输入 schema
- `sdk.mjs` — SDK 运行时（混淆，376KB）
- `cli.js` — CLI 可执行文件（混淆，作为子进程运行）
