/**
 * Gateway Event Test Plugin (Plugin Example)
 * 
 * 测试网关层事件接入点是否正确触发。
 * 所有事件仅打印日志，不产生任何副作用。
 */

const TAG = '\x1b[43m\x1b[30m [GatewayEventTest] \x1b[0m';  // 黄底黑字
const HOOK = '\x1b[45m\x1b[37m registerHook \x1b[0m';      // 紫底白字
const ON = '\x1b[46m\x1b[30m api.on \x1b[0m';            // 青底黑字

export default function initGatewayEventTestPlugin(api, config) {
    api.logger.info(`${TAG} Plugin loaded. Registering all gateway events...`);

    // 只有核心引擎调用了 GatewayHooks.execute() 的事件才能引发真正的钩子阻塞拦截。
    // 当前系统中支持阻塞下发拦截的包括：session:clear, session:start, agent:new_message, agent:pre_tool_use, agent:post_tool_use, agent:end_message
    // ═══════════════════════════════════════════════════════════════════

    api.registerHook("session:clear", async (payload) => {
        api.logger.info(`${TAG} ${HOOK} session:clear | sessionKey=${payload?.sessionKey} action=${payload?.action}`);
    });

    api.registerHook("session:start", async (payload) => {
        api.logger.info(`${TAG} ${HOOK} session:start | sessionKey=${payload?.sessionKey} isMain=${payload?.isMain} hasExisting=${payload?.hasExistingSession}`);
        // 动态注入：返回的 additionalContext 将作为 SDK 系统级上下文注入，在整个会话生命周期内持续生效。
        return { additionalContext: `[系统提示]：会话启动于 ${new Date().toLocaleString()}` };
    });


    api.registerHook("agent:new_message", async (payload) => {
        api.logger.info(`${TAG} ${HOOK} agent:new_message | chatJid=${payload?.chatJid} msgs=${payload?.messages?.length}`);
        // 动态注入：返回的 additionalContext 将作为 SDK 系统级上下文（通过 CLAUDE.md autoloader）注入，
        // 与容器内 external.ts 的 hookSpecificOutput.additionalContext 效果一致。
        return { additionalContext: `\n[系统提示]：当前服务器时间为 - ${new Date().toLocaleString()}` };
    });

    api.registerHook("agent:pre_tool_use", async (payload) => {
        api.logger.info(`${TAG} ${HOOK} agent:pre_tool_use | tool=${payload?.tool}`);
        // 动态注入/拦截：同 agent:new_message 一样，你可以通过 additionalContext 同步拦截并传导前置信息
        // 例如当工具名为 'Bash' 时，提醒模型注意安全风险，或者拦截并查改参数
        if (payload?.tool === 'Bash') {
            return { additionalContext: `[安全提醒]：请在执行 ${payload.tool} 前再次确认命令绝不会破坏系统文件！` };
        }
    });

    api.registerHook("agent:post_tool_use", async (payload) => {
        api.logger.info(`${TAG} ${HOOK} agent:post_tool_use | tool=${payload?.tool}`);
        // 动态修复/脱敏：在底层容器获得工具结果并返回给大模型前，你可以在这步脱敏执行结果或修正错误
        return { additionalContext: `[系统过滤提示]：部分敏感日志已被自动剥离隐藏。` };
    });

    api.registerHook("agent:end_message", async (payload) => {
        api.logger.info(`${TAG} ${HOOK} agent:end_message | channelId=${payload?.channelId}`);
        // 示例：对即将发送的消息进行过滤或修改
        payload.text = payload.text.replace("喵", "***");
    });

    // ═══════════════════════════════════════════════════════════════════
    // Category 2: api.on — 异步强类型事件监听
    // ═══════════════════════════════════════════════════════════════════

    // --- System ---
    api.on("system:startup", async (payload) => {
        api.logger.info(`${TAG} ${ON} system:startup | bots=${payload?.bots?.length || 0} channels=${payload?.channels?.length || 0}`);
    });

    api.on("system:shutdown", async (payload) => {
        api.logger.info(`${TAG} ${ON} system:shutdown`);
    });

    // --- Session ---
    api.on("session:new_message", async (payload) => {
        const preview = (payload?.content || '').slice(0, 40).replace(/\n/g, ' ');
        api.logger.info(`${TAG} ${ON} session:new_message | from=${payload?.from} msg="${preview}"`);
    });

    api.on("session:clear", async (payload) => {
        api.logger.info(`${TAG} ${ON} session:clear | action=${payload?.action} sessionKey=${payload?.sessionKey}`);
    });

    api.on("session:start", async (payload) => {
        api.logger.info(`${TAG} ${ON} session:start | sessionKey=${payload?.sessionKey} isMain=${payload?.isMain}`);
    });

    // --- Agent ---
    api.on("agent:container_start", async (payload) => {
        api.logger.info(`${TAG} ${ON} agent:container_start | group=${payload?.group} container=${payload?.containerName}`);
    });

    api.on("agent:container_stop", async (payload) => {
        api.logger.info(`${TAG} ${ON} agent:container_stop | group=${payload?.group} status=${payload?.status}`);
    });

    api.on("agent:before_prompt_build", async (payload) => {
        const msgCount = payload?.context?.messages?.length || 0;
        api.logger.info(`${TAG} ${ON} agent:before_prompt_build | newMsgs=${msgCount} promptOverrideLen=${payload?.systemPrompt?.length || 0}`);
    });

    api.on("agent:pre_tool_use", async (payload) => {
        api.logger.info(`${TAG} ${ON} agent:pre_tool_use | group=${payload?.group} tool=${payload?.tool}`);
    });

    api.on("agent:post_tool_use", async (payload) => {
        api.logger.info(`${TAG} ${ON} agent:post_tool_use | group=${payload?.group} tool=${payload?.tool}`);
    });

    api.on("agent:sdk_task_status", async (payload) => {
        api.logger.info(`${TAG} ${ON} agent:sdk_task_status | group=${payload?.group}`);
    });

    api.on("agent:before_message_write", async (payload) => {
        const preview = (payload?.text || '').slice(0, 20).replace(/\n/g, ' ');
        api.logger.info(`${TAG} ${ON} agent:before_message_write | channelId=${payload?.channelId} text="${preview}..."`);
    });

    api.on("agent:idle", async (payload) => {
        api.logger.info(`${TAG} ${ON} agent:idle | group=${payload?.group} status=${payload?.status}`);
    });

    // --- Channel ---
    api.on("channel:connect", async (payload) => {
        api.logger.info(`${TAG} ${ON} channel:connect | name=${payload?.channelName}`);
    });

    api.on("channel:disconnect", async (payload) => {
        api.logger.info(`${TAG} ${ON} channel:disconnect | name=${payload?.channelName}`);
    });

    // --- Task ---
    api.on("task:execute", async (payload) => {
        api.logger.info(`${TAG} ${ON} task:execute | taskId=${payload?.taskId} group=${payload?.group}`);
    });

    api.on("task:change", async (payload) => {
        api.logger.info(`${TAG} ${ON} task:change | taskId=${payload?.taskId} status=${payload?.status}`);
    });

    api.logger.info(`${TAG} All events registered.`);
}
