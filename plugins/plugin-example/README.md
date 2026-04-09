# NanoClaw 插件开发指南

欢迎来到 NanoClaw 插件开发快速入门！本目录包含一个基础示例插件（`index.js`），它没有任何破坏性的副作用，仅用来记录捕获的 GatewayBus 所有事件。你可以通过这个示例快速了解并上手 NanoClaw 的插件开发。

## 概述

NanoClaw 的插件系统运行在一种高度解耦的**纯事件溯源微内核架构 (Micro-Kernel Event-Sourcing)** 上。这意味着：
- 插件代码**绝对不要**直接通过 `import` 去调用宿主的核心库。
- 插件**不会也无法**直接覆写控制内存里的数据状态。
- 一切逻辑都应建立在对**总线事件流**的监听（`api.on`）和对**阻塞式钩子**（`registerHook`）的注册之上。

## 启用与高级配置

要注册或开启一个插件，可以通过修改 `plugins/nanoclaw-plugins.json` 即可实现热插拔。

`PluginManifest` 支持以下完整的动态映射字段：

```json
{
  "plugins": [
    {
      "id": "my-custom-plugin",
      "path": "plugin-example/index.js",
      "enabled": true,
      "config": {
        "apiKeys": "sk-xxxxx",
        "customFlag": true,
        "mode": "standalone"
      }
    }
  ]
}
```

### 配置加载说明
- **`path` 指针机制**：这里的路径允许向上越级跳出目录（例如 `"path": "../external-repo/dist/index.js"`）。它将使用 Node 底层的 `path.resolve` 基于 `plugins` 文件夹计算绝对路径。
- **关于 `.ts` 和 `.js`**：如果你的宿主 NanoClaw 是通过编译后的原生 Node.js (`node dist/index.js`) 运行的，那么这里配置的入口主文件**必须是纯粹的 `.js` 后缀**！由于纯 Node 的原生 `import()` 无法编译 Typescript，任何试图挂载 `.ts` 源文件引擎的路径都会在启动时报错瘫痪。
- **动态透传 `config`**：你在 `nanoclaw-plugins.json` 里设定的独立 `config` 私有变量对象，会在入口调用时作为**第二个参数直接投递给你的插件入口函数** `init(api, config)`。这非常适合用来灌入各类独立的 API 鉴权秘钥、开关或是超参数。

## 编写插件入口

插件的核心非常简单——只需默认 `export default` 导出一个同步或异步函数：

```javascript
export default function initMyPlugin(api, config) {
    api.logger.info("在此执行插件的初始化逻辑...");
}
```

### 沙箱对象 `api` (NanoClawGatewayApi)

宿主环境会将受限制的沙箱对象 `api` 传递给你，这是你与系统的唯一通讯渠道：

1. **`api.logger`**: 自动拼装好标签的专属日志工具（包含 `.info()`, `.warn()`, `.debug()`, `.error()`）。
2. **`api.on(eventName, callback)`**: 监听异步总线事件；不阻塞执行主线程。
3. **`api.registerHook(hookName, callback)`**: 注册同步阻塞式的拦截器（常用于拒绝某些特定的消息或篡改）。

## Event (事件) 与 Hook (钩子) 的区别

在 NanoClaw 网关引擎中，底层支持两条分发走廊：
1. **`api.on(eventName, callback)`**: 旁路异步监听。触发时，引擎不会等待插件执行完毕。纯阅览拦截性质，适用于数据大盘抓取、日志上报等（所有上面的 15 种底层事件都可以通过此方法捕获）。
2. **`api.registerHook(hookName, callback)`**: 串行阻塞拦截。触发时，引擎将暂停执行主流程，**严格按注册优先级等待并遍历所有的 Hook**。在前置 Hook 中你可以直接修改传入的 `payload` 对象，后置的 Hook 和宿主代码会接收到你篡改后的参数！如果在执行时抛出异常，可以直接熔断当前行为的继续执行。

> [!TIP]
> **设计精髓**：其实**所有的 Hook 最终都会无条件地镜像降级广播为一份同名的异步事件（Event）**！所以你不用担心用 `api.on` 会漏掉某些只能用 `registerHook` 拦截的事件。它们俩共享同一套 16 个字符串的名称词库！

## 网关全域事件（与钩子）地图

这是系统当前**全部且完整**的 16 个事件集合。由于所有 Hook 执行前都会同名广播 Event，所以**这 16 个单词全都可以挂载为异步的 `api.on`**。
但在这些事件中，宿主目前**仅针对破坏性指令开放了串行阻塞的 `registerHook`**。

### 1. 系统底层级 (System)
- `system:startup` (仅 Event): 主服务冷启动加载完毕时触发一次。
  - **Payload**: `{ action: string, config: any, bots: any[], groups: Record<string, any>, tasks: any[], channels: {name: string, connected: boolean}[], system: any }`
- `system:shutdown` (仅 Event): 系统执行退出清理流程时触发。
  - **Payload**: `{ action?: string }`

### 2. 会话生命流 (Session)
- `session:clear` (**🔥Hook** + Event): 当要求手动清理/重置隔离容器沙盒（如发送 `/new` 或 `/clear`）时触发。
  - **Payload**: `{ action: 'new' | 'clear', sessionKey: string, cfg?: any }`
- `session:start` (**🔥Hook** + Event): 每次会话启动（容器即将拉起执行）时触发。通过 Hook 返回 `{ additionalContext: "..." }` 可注入**持久化的 SDK 系统级上下文**，在整个会话生命周期内生效（与容器内 `external.ts` 的 `hookSpecificOutput.additionalContext` 效果一致）。
  - **Payload**: `{ sessionKey: string, chatJid: string, isMain: boolean, hasExistingSession: boolean }`

### 3. 沙箱引擎流 (Agent)
- `agent:container_start` (仅 Event): 容器拉起进入忙碌时触发。
  - **Payload**: `{ group: string, containerName?: string }`
- `agent:container_stop` (仅 Event): 当系统清理资源终结某个容器时触发。
  - **Payload**: `{ group: string, status?: string }`
- `agent:pre_tool_use` (**🔥Hook** + Event): 当 LLM 决定使用工具尚未启动进程前瞬间触发。可通过 Hook 的 `additionalContext` 同步阻塞注入前置拦截验证。
  - **Payload**: `{ group: string, tool: string, tool_input?: string }`
- `agent:post_tool_use` (**🔥Hook** + Event): 当底层容器获得工具执行结果并即将返回给大模型前瞬间触发。极其适合用于结果脱敏审查与修改。
  - **Payload**: `{ group: string, tool: string, tool_input?: string }`
- `agent:sdk_task_status` (仅 Event): Agent SDK 内层执行并行后台子任务（Swarm）时上报的数据信标。
  - **Payload**: `{ group: string, detail: string }`
- `agent:idle` (仅 Event): 整个对话查询回合处理完毕且大模型停止回答，退回空闲状态时触发。
  - **Payload**: `{ group: string, sessionKey: string, status: string, sessionId: string }`
- `agent:new_message` (**🔥Hook** + Event): **针对常驻容器环境**！这个 Hook 会在无论大模型容器是死是活，只要有任何从数据库/IPC 被提成 Pending 状态的“最新新消息合集”将要推入给底层大模型沙箱时瞬间触发。可非常方便地通过返回 `{ additionalContext: "..." }` 对**此轮**的所有对话开头强制增加额外的前置系统上下文。
  - **Payload**: `{ sourceGroup: string, chatJid: string, messages: any[], prompt: string }`
- `agent:end_message` (**🔥Hook** + Event): 大模型生成完文本并在宿主侧完成解析，即将调用外部通信通道回信给你前触发。注册 Hook 后，可直接覆写 `payload.text` 从而对最终将发送的消息进行任意过滤与修改。
  - **Payload**: `{ text: string, channelId: string }`

### 4. 适配通道流 (Channel)
- `channel:connect` & `channel:disconnect` (占位幽灵事件，当前通信适配层已内部接管重连，未触发该外围广播)。
  - **Payload**: `{ channelName?: string }`

### 5. 计划任务流 (Task)
- `task:execute` & `task:change` (仅 Event): 定时调度的 Job 发起以及大模型使用工具增删改该任务时的状态变更事件。
  - **Payload (execute)**: `{ taskId: string, group?: string, scheduleType?: string }`
  - **Payload (change)**: `{ taskId: string, status: 'created' | 'active' | 'paused' | 'completed' | 'deleted' }`

如果想要构建控制面板（例如 `status-manager`）或者是消息审计系统，你只需要利用这些事件就足够将宿主的任何动向映射成数据对象并实现无侵入的闭环了。
