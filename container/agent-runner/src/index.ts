/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, HookCallback } from '@anthropic-ai/claude-agent-sdk';

import { log, writeIpcStatus, IpcStatusEvent, MessageStream, drainIpcInput, fetchPendingBatch, IPC_POLL_MS, shouldClose, globalQuestionAnswers, globalQuestionLocks, readStdin, writeOutput, appendPromptText, ContainerOutput, IPC_INPUT_DIR, IPC_INPUT_CLOSE_SENTINEL, waitForIpcSignal } from './utils/index.js';
import { loadExternalHooks, createExternalBootHook, createPreCompactHook, createSanitizeBashHook, createPreToolUseHook, createPostToolUseHook, createToolUsageHintHook, createContextModeHook } from './hooks/index.js';

const { hooks: extHooks, bootLog: extBootLog } = loadExternalHooks();

let cachedSessionStartHooksOutput: string | null = null;

interface ContainerInput {
  prompt: string | any[];
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isGroup?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  teamRuleContent?: string;
  contextModeContent?: string;
  toolsContent?: string;
  adminToolsContent?: string;
  pluginSystemContext?: string;
  secrets?: Record<string, string>;
  gatewayToken?: string;
  gatewayUrl?: string;
  pullPendingOnStart?: boolean;
}





/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * While the query is active, it only records pending_available signals and
 * defers fetching the full batch until the current turn finishes.
 */
async function runQuery(
  prompt: string | any[],
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  consumedThroughTimestamp?: string,
  isHeartbeat?: boolean,
  pluginNewMessageContext?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  hadError: boolean;
  pendingAvailableDuringQuery: boolean;
  updatedConsumedThroughTimestamp?: string;
  legacyMessagesBuffer?: string[];
}> {
  const stream = new MessageStream();

  let updatedConsumedThroughTimestamp = consumedThroughTimestamp;
  let legacyMessagesBuffer: string[] = [];

  // Poll IPC for control signals and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let pendingAvailableDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const drain = drainIpcInput();
    if (drain.pendingAvailable) {
      pendingAvailableDuringQuery = true;
      log('Received pending_available signal during active query');
    }
    if (drain.legacyMessages.length > 0) {
      pendingAvailableDuringQuery = true;
      legacyMessagesBuffer.push(...drain.legacyMessages);
      log(`Received ${drain.legacyMessages.length} legacy IPC message payload(s) during query; queued for hook injection`);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let hadError = false;
  let emittedTexts = new Set<string>();

  // Inject global rules and group-specific rules
  let additionalContext = '';
  if (containerInput.toolsContent) {
    additionalContext += '\n' + containerInput.toolsContent + '\n';
    log('Injecting Tools.md into system prompt');
  }
  if (containerInput.adminToolsContent) {
    additionalContext += '\n' + containerInput.adminToolsContent + '\n';
    log('Injecting AdminTools.md into system prompt');
  }
  if (containerInput.contextModeContent) {
    additionalContext += '\n' + containerInput.contextModeContent + '\n';
    log('Injecting ContextMode.md into system prompt');
  }
  if (!containerInput.isMain && containerInput.isGroup && containerInput.teamRuleContent) {
    additionalContext += '\n' + containerInput.teamRuleContent + '\n';
    log('Injecting GroupRule.md into system prompt for group chat');
  }

  if ((containerInput as any).userProfileContent) {
    additionalContext += '\n[用户信息/USER (文件路径: /workspace/group/USER.md)]\n' + (containerInput as any).userProfileContent + '\n';
    log('Injecting Agent USER.md into system prompt');
  }

  if ((containerInput as any).agentExperienceContent) {
    additionalContext += '\n[专属历史经验与准则/EXPERIENCE (文件路径: /workspace/group/EXPERIENCE.md)]\n' + (containerInput as any).agentExperienceContent + '\n';
    log('Injecting Agent EXPERIENCE.md into system prompt');
  }

  // --- Manually dispatch SessionStart hooks (Executed ONCE per container lifecycle) ---
  if (cachedSessionStartHooksOutput === null) {
    cachedSessionStartHooksOutput = '';
    const sessionStartHooks = [
      createExternalBootHook(extBootLog),
      createContextModeHook('sessionstart'),
      ...extHooks.filter(h => h.event === 'SessionStart').map(h => h.caller)
    ];

    log(`Resolved ${sessionStartHooks.length} SessionStart hooks for execution`);

    for (const hook of sessionStartHooks) {
      try {
        let sessionSource = (containerInput as any).sessionId ? 'resume' : 'startup';
        const stringifiedPrompt = typeof containerInput.prompt === 'string'
          ? containerInput.prompt
          : JSON.stringify(containerInput.prompt || '');
        if (sessionSource === 'startup' && stringifiedPrompt.includes('Session has been compacted')) {
          sessionSource = 'compact';
        }

        const result = await hook({
          hook_event_name: 'SessionStart',
          source: sessionSource,
          sessionId: (containerInput as any).sessionId || 'pending'
        } as any, undefined, { signal: new AbortController().signal } as any);
        const output = result as any;
        if (output && output.hookSpecificOutput) {
          const injectedContext = output.hookSpecificOutput.additionalContext || output.hookSpecificOutput.additionalSystemContext;
          if (injectedContext) {
            cachedSessionStartHooksOutput += '\n' + injectedContext + '\n';
            log('Injected context from SessionStart hook');
          }
        }
      } catch (err) {
        log(`SessionStart hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  additionalContext += cachedSessionStartHooksOutput;

  // Inject plugin-provided system context from GatewayHooks (session:start)
  // This is set once when the container starts and persists for the session lifecycle.
  if (containerInput.pluginSystemContext) {
    additionalContext += '\n' + containerInput.pluginSystemContext + '\n';
    log('Injecting plugin system context from session:start hook');
  }

  const finalAdditionalContext = additionalContext.trim() || undefined;

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';

  if (finalAdditionalContext) {
    // Inject system context natively via CLAUDE.md autoloader bypassing SDK limitations
    const systemContextDir = '/tmp/nanoclaw-system-ctx';
    if (!fs.existsSync(systemContextDir)) fs.mkdirSync(systemContextDir, { recursive: true });
    fs.writeFileSync(path.join(systemContextDir, 'CLAUDE.md'), `<system-reminder>\n${finalAdditionalContext}\n</system-reminder>\n\n`);
    extraDirs.push(systemContextDir);
    log('Propagated system context via dynamic SDK CLAUDE.md autoloader');
  }

  const recordPromptToContextModeStoreAsync = (text: string | any[]) => {
    let rawText = '';
    if (typeof text === 'string') {
      rawText = text;
    } else if (Array.isArray(text)) {
      rawText = text.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\\n');
    }
    if (!rawText || rawText.trim() === '') return;
    try {
      log('Background: Recording prompt to context-mode database');
      const hook = createContextModeHook('userpromptsubmit');
      hook(
        { hook_event_name: 'UserPromptSubmit', prompt: rawText, message: rawText, session_id: sessionId } as any,
        undefined,
        { signal: new AbortController().signal } as any
      ).catch(err => log(`Async context-mode database write failed: ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      log(`Context-mode database sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Record user prompt to context-mode's database in the background
  recordPromptToContextModeStoreAsync(prompt);


  // ─── One-shot plugin context injection (agent:new_message) ──────────
  // Injects context from gateway plugins via SDK's hookSpecificOutput on UserPromptSubmit,
  // matching how external hooks invisibly inject context blocks.
  let pluginNewMessageContextFired = false;
  const pluginNewMessageHook: HookCallback = async () => {
    if (pluginNewMessageContextFired || !pluginNewMessageContext) return {};
    pluginNewMessageContextFired = true;
    log('Injecting plugin context from agent:new_message hook via UserPromptSubmit');
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: pluginNewMessageContext
      }
    };
  };

  // Push the original pristine prompt tightly coupled to the message flow
  stream.push(prompt);

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  let alreadyInjectedDuringQuery = false;

  // ─── Mid-query user message injection ─────────────────────────────────
  //
  // KNOWN LIMITATION (SDK constraint):
  // The SDK's PostToolUse hook `additionalContext` is injected into the
  // current API request at runtime, but is NOT written to the session
  // transcript JSONL.  This means mid-query user messages injected here
  // are visible to the model in the current turn but will be LOST when
  // the session is resumed (container restart / new conversation).
  //
  // In contrast, tool_result blocks are first-class conversation messages
  // that the SDK both sends to the API and persists to the transcript.
  //
  // The dual-guarantee approach (inject via additionalContext for immediate
  // visibility + re-fetch as next query prompt for persistence) was tested
  // but causes double responses — the model processes the same message
  // twice.  Until the SDK supports persistent hook injection or we can
  // inject messages as proper user turns via MessageStream.push() without
  // losing mid-turn visibility, this limitation is accepted.
  //
  // TODO: Revisit when the SDK exposes a way to persist hook-injected
  // content, or when we can intercept the raw messages array at the
  // gateway proxy level to insert proper {type:"text"} content blocks
  // alongside tool_result in the user message.
  // ──────────────────────────────────────────────────────────────────────
  const injectionHook: HookCallback = async () => {
    let injectedMessages: string[] = [];

    // Check IPC for new pending signals (even if we already injected once)
    const drain = drainIpcInput();
    if (drain.pendingAvailable) {
      pendingAvailableDuringQuery = true;
      alreadyInjectedDuringQuery = false; // new messages arrived, allow re-injection
    }
    if (drain.legacyMessages.length > 0) {
      pendingAvailableDuringQuery = true;
      alreadyInjectedDuringQuery = false;
      legacyMessagesBuffer.push(...drain.legacyMessages);
    }

    // Skip if we already injected for this batch (avoid re-injecting same messages on every tool use)
    if (alreadyInjectedDuringQuery) return {};

    if (pendingAvailableDuringQuery) {
      const batch = await fetchPendingBatch(containerInput.gatewayUrl, containerInput.gatewayToken, updatedConsumedThroughTimestamp || consumedThroughTimestamp);
      // Don't reset pendingAvailableDuringQuery — leave it true so the
      // query loop re-fetches these messages as a proper persistent prompt
      // after the current query ends.  The additionalContext injection below
      // gives the model immediate visibility, but hook-injected context is
      // NOT persisted in the SDK transcript.  Re-fetching ensures persistence.

      if (batch.success && batch.pending && batch.prompt) {
        let msg = typeof batch.prompt === 'string' ? batch.prompt : JSON.stringify(batch.prompt);
        injectedMessages.push(msg);
        // Also inject plugin system context from agent:new_message hook
        if (batch.systemContext) {
          injectedMessages.push(batch.systemContext);
        }
        // NOTE: intentionally NOT advancing updatedConsumedThroughTimestamp
        // so the same messages are re-fetched as the next query's formal prompt
      }
      if (legacyMessagesBuffer.length > 0) {
        // Inject a copy but keep originals in buffer for the query loop
        injectedMessages.push(...legacyMessagesBuffer);
      }
    }

    if (injectedMessages.length > 0) {
      const combined = injectedMessages.join('\\n');
      log(`Injected ${injectedMessages.length} new user message(s) into context.`);
      alreadyInjectedDuringQuery = true; // prevent re-injection until new messages arrive

      // Record dynamically injected messages into context-mode's database in the background
      recordPromptToContextModeStoreAsync(combined);

      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `<user-message-arrived>\n用户在你工作期间发来了新消息，请注意查看：\n${combined}\n</user-message-arrived>`
        }
      };
    }
    return {};
  };
  let lastAssistantEmitText = '';

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        canUseTool: async (toolName, toolInput) => {
          if (toolName === 'AskUserQuestion') {
            const question_id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            globalQuestionLocks.add(question_id);
            writeIpcStatus({ type: 'ask_user_question', question_id, payload: toolInput });

            while (!globalQuestionAnswers[question_id]) {
              await new Promise(r => setTimeout(r, 500));
            }

            const answers = globalQuestionAnswers[question_id];
            delete globalQuestionAnswers[question_id];
            globalQuestionLocks.delete(question_id);

            return { behavior: 'allow', updatedInput: { questions: (toolInput as any).questions, answers } };
          }
          return { behavior: 'allow', updatedInput: toolInput as any };
        },
        model: sdkEnv.ANTHROPIC_MODEL,
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        // Heartbeat queries use persistSession:false so they don't pollute
        // the session transcript. The AI still sees full context via resume,
        // but the heartbeat prompt and response are never written to disk.
        ...(isHeartbeat ? { persistSession: false } : {}),
        resumeSessionAt: resumeAt,
        systemPrompt: undefined,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          // 'WebSearch', 'WebFetch', // Disabled: requires native Anthropic API; use mcp__parallel-search__search instead
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*',
          'mcp__context-mode__*',
          'mcp__parallel-search__*'
          //'mcp__parallel-task__*'
        ],
        disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'WebSearch', 'WebFetch'],
        env: sdkEnv,
        effort: 'high',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              NANOCLAW_GATEWAY_TOKEN: containerInput.gatewayToken || '',
              NANOCLAW_GATEWAY_URL: containerInput.gatewayUrl || '',
              ...(sdkEnv.WHATAI_API_KEY ? { WHATAI_API_KEY: sdkEnv.WHATAI_API_KEY } : {}),
              ...(sdkEnv.IMAGE_BASE_URL ? { IMAGE_BASE_URL: sdkEnv.IMAGE_BASE_URL } : {}),
              ...(sdkEnv.IMAGE_MODEL ? { IMAGE_MODEL: sdkEnv.IMAGE_MODEL } : {}),
              ...(sdkEnv.VISION_API_KEY ? { VISION_API_KEY: sdkEnv.VISION_API_KEY } : {}),
              ...(sdkEnv.VISION_BASE_URL ? { VISION_BASE_URL: sdkEnv.VISION_BASE_URL } : {}),
              ...(sdkEnv.VISION_MODEL ? { VISION_MODEL: sdkEnv.VISION_MODEL } : {}),
              ...(sdkEnv.EMBEDDING_API_KEY ? { EMBEDDING_API_KEY: sdkEnv.EMBEDDING_API_KEY } : {}),
            },
          },
          'context-mode': {
            command: '/app/node_modules/.bin/context-mode',
            args: ['--transport', 'stdio'],
            env: {
              ...process.env,
              TMPDIR: process.env.TMPDIR || '/tmp',
              HOME: process.env.CONTEXT_MODE_HOME || '/workspace/group',
            },
          },
          ...(sdkEnv.PARALLEL_API_KEY ? {
            'parallel-search': {
              type: 'http' as const,
              url: 'https://search-mcp.parallel.ai/mcp',
              headers: { 'Authorization': `Bearer ${sdkEnv.PARALLEL_API_KEY}` },
            },
          } : {}),
        },
        // Use the native SDK format for hooks and dynamically inject our extHooks
        hooks: {
          PreCompact: [
            { hooks: [createPreCompactHook(containerInput.assistantName)] },
            { hooks: [createContextModeHook('precompact')] },
            ...extHooks.filter(h => h.event === 'PreCompact').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
            { matcher: '', hooks: [createPreToolUseHook(containerInput.gatewayUrl, containerInput.gatewayToken), createContextModeHook('pretooluse')] },
            ...extHooks.filter(h => h.event === 'PreToolUse').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          PostToolUse: [
            { matcher: '', hooks: [createPostToolUseHook(containerInput.gatewayUrl, containerInput.gatewayToken), createToolUsageHintHook(), createContextModeHook('posttooluse'), injectionHook] },
            ...extHooks.filter(h => h.event === 'PostToolUse').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          PostToolUseFailure: [
            { matcher: '', hooks: [createPostToolUseHook(containerInput.gatewayUrl, containerInput.gatewayToken), createToolUsageHintHook(), createContextModeHook('posttoolusefailure'), injectionHook] },
            ...extHooks.filter(h => h.event === 'PostToolUseFailure').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          //重复触发，不需要在这里添加hook
          // SessionStart: [
          //   { matcher: '', hooks: [createExternalBootHook(extBootLog), createContextModeHook('sessionstart')] },
          //   ...extHooks.filter(h => h.event === 'SessionStart').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          // ],
          SessionStart: [],
          UserPromptSubmit: [
            { matcher: '', hooks: [pluginNewMessageHook] },
            ...extHooks.filter(h => h.event === 'UserPromptSubmit').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          Stop: [
            ...extHooks.filter(h => h.event === 'Stop').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          SessionEnd: [
            ...extHooks.filter(h => h.event === 'SessionEnd').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          Notification: [
            ...extHooks.filter(h => h.event === 'Notification').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          SubagentStart: [
            ...extHooks.filter(h => h.event === 'SubagentStart').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          SubagentStop: [
            ...extHooks.filter(h => h.event === 'SubagentStop').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
        },
        includePartialMessages: true,
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant') {
        if ('uuid' in message) {
          lastAssistantUuid = (message as { uuid: string }).uuid;
        }

        let assistantMsg: any = null;
        if ('message' in message && typeof (message as any).message === 'object') {
          assistantMsg = (message as any).message;
        } else if ('content' in message) {
          assistantMsg = message;
        }

        if (assistantMsg && assistantMsg.content && Array.isArray(assistantMsg.content)) {
          // Protection: if this turn also calls send_message, skip forwarding the
          // text block here — the Gateway will deliver the actual message content,
          // and emitting here too would cause a duplicate in the chat window.
          const hasSendMessageTool = assistantMsg.content.some(
            (c: any) => c.type === 'tool_use' && (
              c.name === 'mcp__nanoclaw__send_message' ||
              c.name === 'SendMessage'
            )
          );

          if (hasSendMessageTool) {
            log('Skipping intermediate text: same turn has send_message tool call (Gateway handles it)');
          } else {
            const textParts = assistantMsg.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            const thisTurnText = textParts.join('');

            if (thisTurnText) {
              emittedTexts.add(thisTurnText);
              lastAssistantEmitText = thisTurnText;
              log(`Emitting intermediate assistant text length: ${thisTurnText.length}`);
              writeOutput({
                status: 'success',
                result: thisTurnText,
                newSessionId,
                consumedThroughTimestamp,
              });
            }
          }
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
        const tn = message as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
        writeIpcStatus({ type: 'task_status', task_id: tn.task_id, status: tn.status, summary: tn.summary });
      }

      // Emit tool status events for host-side Telegram updates
      // SDK Hook PreToolUse handles standard tools, but tool_progress adds elapsed times for bash
      if (message.type === 'tool_progress') {
        const tp = message as { tool_name: string; elapsed_time_seconds: number };
        log(`[OpenClaw Hook: before_tool_call] Intercepting tool usage: ${tp.tool_name}`);
        writeIpcStatus({ type: 'tool_status', tool: tp.tool_name, status: 'running', elapsed: tp.elapsed_time_seconds });
      }

      if (message.type === 'result') {
        log('[Hook: agent_end] Reasoning loop completed. Yielding result out of the agent block.');
        // Signal tool status idle when a result arrives
        writeIpcStatus({ type: 'tool_status', status: 'idle' });
        resultCount++;
        let textResult = 'result' in message ? (message as { result?: string }).result : null;
        const subtype = (message as { subtype?: string }).subtype || '';
        if (subtype === 'error_during_execution' || subtype === 'error_max_turns') {
          hadError = true;
          log(`Result #${resultCount} had error subtype: ${subtype}`);
        }

        if (textResult && emittedTexts.has(textResult)) {
          log('Skipping duplicate final result text as it was already emitted');
          textResult = null;
        }

        const finalOutputText = textResult || lastAssistantEmitText;

        log(`Result #${resultCount}: subtype=${subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
        writeOutput({
          status: hadError ? 'error' : 'success',
          result: textResult || null,
          newSessionId,
          consumedThroughTimestamp,
          queryCompleted: true,
          ...(hadError ? { error: `Agent result: ${subtype}` } : {}),
        });
        // Break out of the for-await loop after receiving a result.
        // With isSingleUserTurn=false (MessageStream prompt), the SDK
        // will block waiting for the next user message from the stream
        // instead of terminating. Breaking here lets the query loop
        // fetch pending messages and start a new query turn.
        break;
      }
    }
  } finally {
    ipcPolling = false;
    stream.end();
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, hadError: ${hadError}`);
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    hadError,
    pendingAvailableDuringQuery,
    updatedConsumedThroughTimestamp,
    legacyMessagesBuffer,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build the initial prompt.
  let prompt: string | any[] = containerInput.prompt;
  let consumedThroughTimestamp: string | undefined;
  let pluginSystemContext: string | undefined;
  if (containerInput.isScheduledTask) {
    if (typeof prompt === 'string') {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    } else if (Array.isArray(prompt)) {
      prompt = [
        { type: 'text', text: `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n` },
        ...prompt
      ];
    }
  }
  const initialDrain = drainIpcInput();
  let pendingRequested = initialDrain.pendingAvailable;
  if (initialDrain.legacyMessages.length > 0) {
    log(`Draining ${initialDrain.legacyMessages.length} legacy IPC message payload(s) into initial prompt`);
    prompt = appendPromptText(prompt, initialDrain.legacyMessages.join('\n'));
  }

  if (containerInput.pullPendingOnStart) {
    const batch = await fetchPendingBatch(containerInput.gatewayUrl, containerInput.gatewayToken, consumedThroughTimestamp);
    if (!batch.success) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: batch.error || 'Failed to fetch initial pending batch'
      });
      process.exit(1);
    }

    if (batch.pending && batch.prompt) {
      prompt = batch.prompt;
      consumedThroughTimestamp = batch.consumedThroughTimestamp;
      pluginSystemContext = batch.systemContext;
      pendingRequested = false;
      log(`Fetched initial pending batch (${batch.messageCount || 0} messages) through ${consumedThroughTimestamp || 'unknown'}`);
    } else {
      log('No pending batch available on startup pull');
    }
  }

  if (
    containerInput.pullPendingOnStart &&
    !consumedThroughTimestamp &&
    typeof prompt === 'string' &&
    prompt.trim() === ''
  ) {
    log('No pending work available after startup pull, exiting without starting a query');
    return;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    queryLoop: while (true) {
      // Detect if this prompt is a heartbeat query
      const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
      const isHeartbeatQuery = promptStr.includes('[HEARTBEAT]');
      if (isHeartbeatQuery) {
        log('Heartbeat query detected, will use persistSession:false');
      }

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult: {
        newSessionId?: string;
        lastAssistantUuid?: string;
        closedDuringQuery: boolean;
        hadError: boolean;
        pendingAvailableDuringQuery: boolean;
        updatedConsumedThroughTimestamp?: string;
        legacyMessagesBuffer?: string[];
      };
      try {
        queryResult = await runQuery(
          prompt,
          sessionId,
          mcpServerPath,
          containerInput,
          sdkEnv,
          resumeAt,
          consumedThroughTimestamp,
          isHeartbeatQuery,
          pluginSystemContext,
        );
      } catch (queryErr) {
        const msg = queryErr instanceof Error ? queryErr.message : String(queryErr);
        log(`Query threw error, exiting for host-side retry: ${msg}`);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: msg,
          consumedThroughTimestamp,
          queryCompleted: true,
        });
        process.exit(1);
      }

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // When query ended with an error result, don't try to resume from the
      // error point — the SDK will crash. Restart the container cleanly.
      if (queryResult.hadError) {
        log('Query ended with error result, exiting for clean container restart');
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: 'Query ended with error, container will restart',
          consumedThroughTimestamp,
        });
        process.exit(1);
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Heartbeat queries used persistSession:false, so the session
      // transcript is untouched. Skip the session-update marker to avoid
      // resetting the host's idle timer. Fall through to the IPC wait
      // section so the container properly waits for the next signal
      // (instead of re-running the same heartbeat prompt in a loop).
      if (!isHeartbeatQuery) {
        // Emit session update so host can track it
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      } else {
        log('Heartbeat query completed, session transcript unchanged (persistSession:false)');
      }

      if (queryResult.updatedConsumedThroughTimestamp) {
        consumedThroughTimestamp = queryResult.updatedConsumedThroughTimestamp;
      }

      pendingRequested = pendingRequested || queryResult.pendingAvailableDuringQuery;

      if (queryResult.legacyMessagesBuffer && queryResult.legacyMessagesBuffer.length > 0) {
        log(`Appending ${queryResult.legacyMessagesBuffer.length} remaining legacy IPC message(s) to prompt for next query loop`);
        prompt = appendPromptText('', queryResult.legacyMessagesBuffer.join('\\n'));
        consumedThroughTimestamp = undefined;
        continue queryLoop;
      }

      while (true) {
        if (pendingRequested) {
          const batch = await fetchPendingBatch(containerInput.gatewayUrl, containerInput.gatewayToken, consumedThroughTimestamp);
          if (!batch.success) {
            log(`Pending batch fetch failed after query: ${batch.error || 'unknown error'}`);
            writeOutput({
              status: 'error',
              result: null,
              newSessionId: sessionId,
              error: batch.error || 'Failed to fetch pending batch',
            });
            process.exit(1);
          }

          pendingRequested = false;
          if (batch.pending && batch.prompt) {
            prompt = batch.prompt;
            consumedThroughTimestamp = batch.consumedThroughTimestamp;
            pluginSystemContext = batch.systemContext;
            log(`Fetched pending batch for next query (${batch.messageCount || 0} messages) through ${consumedThroughTimestamp || 'unknown'}`);
            break;
          }

          log('pending_available signal received but no pending batch was available');
        }

        log('Query ended, waiting for next IPC signal...');
        const nextSignal = await waitForIpcSignal();
        if (nextSignal === null) {
          log('Close sentinel received, exiting');
          break queryLoop;
        }

        if (nextSignal.pendingAvailable) {
          pendingRequested = true;
        }

        if (nextSignal.legacyMessages.length > 0 && !pendingRequested) {
          log(`Received ${nextSignal.legacyMessages.length} legacy IPC message payload(s) while idle`);
          prompt = appendPromptText('', nextSignal.legacyMessages.join('\n'));
          consumedThroughTimestamp = undefined;
          break;
        }
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
      consumedThroughTimestamp,
    });
    process.exit(1);
  }
}

main();
