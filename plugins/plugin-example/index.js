/**
 * Gateway Event Test Plugin (Plugin Example)
 * 
 * 测试网关层事件接入点是否正确触发。
 * 所有事件仅打印日志，不产生任何副作用。
 */

const TAG = '\x1b[43m\x1b[30m [GatewayEventTest] \x1b[0m';  // 黄底黑字
const HOOK = '\x1b[45m\x1b[37m registerHook \x1b[0m';      // 紫底白字
const ON   = '\x1b[46m\x1b[30m api.on \x1b[0m';            // 青底黑字

export default function initGatewayEventTestPlugin(api, config) {
    api.logger.info(`${TAG} Plugin loaded. Registering all gateway events...`);

    // 只有核心引擎调用了 GatewayHooks.execute() 的事件才能引发真正的钩子阻塞拦截。
    // 当前 NanoClaw V3 核心系统中，只有 `session:before_reset` 采用了阻塞下发。
    // ═══════════════════════════════════════════════════════════════════
    api.registerHook("session:before_reset", async (payload) => {
        api.logger.info(`${TAG} ${HOOK} session:before_reset | sessionKey=${payload?.sessionKey} action=${payload?.action}`);
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

    api.on("session:before_reset", async (payload) => {
        api.logger.info(`${TAG} ${ON} session:before_reset | action=${payload?.action} sessionKey=${payload?.sessionKey}`);
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

    api.on("agent:tool_use", async (payload) => {
        api.logger.info(`${TAG} ${ON} agent:tool_use | group=${payload?.group} tool=${payload?.tool}`);
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
