import fs from 'fs';
import path from 'path';
import { HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { log, writeIpcStatus } from '../utils/index.js';
import { parseTranscript, formatTranscriptMarkdown, getSessionSummary, sanitizeFilename, generateFallbackName } from '../utils/index.js';

/**
 * Archive the full transcript to conversations/ before compaction.
 */
export function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

export function createPreToolUseHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name) {
      const toolInput = preInput.tool_input as Record<string, unknown> | undefined;
      let description = typeof toolInput?.description === 'string' ? toolInput.description : undefined;

      if (!description) {
        if (preInput.tool_name === 'Bash') {
          description = `执行: ${String(toolInput?.command || '').slice(0, 40)}`;
        } else if (preInput.tool_name === 'Glob') {
          description = `搜索文件: ${toolInput?.pattern}`;
        } else if (preInput.tool_name === 'Grep') {
          description = `内容搜索: ${toolInput?.pattern}`;
        } else if (preInput.tool_name === 'Read' || preInput.tool_name === 'View') {
          const file = String(toolInput?.file_path || '').split('/').pop();
          description = `读取文件: ${file}`;
        } else if (preInput.tool_name === 'Write' || preInput.tool_name === 'Edit') {
          const file = String(toolInput?.file_path || toolInput?.target_file || '').split('/').pop();
          description = `修改文件: ${file}`;
        }
      }

      writeIpcStatus({ type: 'tool_status', tool: preInput.tool_name, description, status: 'running' });
    }
    return {};
  };
}

let lastToolSig = '';
let exactRepeatCount = 0;
let lastToolName = '';
let toolNameCount = 0;

export function createPostToolUseHook(): HookCallback {
  return async (input) => {
    const postInput = input as any;
    const toolName = postInput.tool_name || '';
    const toolInputStr = postInput.tool_input ? JSON.stringify(postInput.tool_input) : '';
    const sig = `${toolName}_${toolInputStr}`;

    // 精确的特征匹配 (参数也完全一致)
    if (sig === lastToolSig && toolName) {
      exactRepeatCount++;
    } else {
      exactRepeatCount = 0;
    }
    lastToolSig = sig;

    // 仅工具名的宽泛匹配
    if (toolName === lastToolName && toolName) {
      toolNameCount++;
    } else {
      toolNameCount = 0;
      lastToolName = toolName;
    }

    // 完全参数死循环防线 (第5次拦截)
    if (exactRepeatCount >= 4) {
      exactRepeatCount = 0;
      toolNameCount = 0;
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `[System Recovery] 🚨 严重异常警告：你提取了与前 4 次完全相同的参数调用了 ${toolName} 发生深度死循环，且均未取得有效突破。系统已强制阻断当前调用。请立刻彻底放弃当前执行路径，重新分析错误源或换一种方法，必要时直接寻求用户帮助！`,
        },
      };
    }

    // 同工具多态无脑卡死防线 (第11次拦截)
    if (toolNameCount >= 10) {
      exactRepeatCount = 0;
      toolNameCount = 0;
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `[System Recovery] ⚠️ 过载警告：你已经连续 10 次调用同一个工具 (${toolName}) 进行尝试。该任务大概率遇到了无法单点打平的结构死胡同。严禁再继续盲目重试该工具。请迅速跳出现有视角，对目前的死境进行总结，明确告诉你的操作者（用户）你需要新路子。`,
        },
      };
    }

    return {};
  };
}

/**
 * PostToolUse hook: when a tool call fails validation, return the correct
 * usage/signature so the model knows exactly how to fix its call.
 */
export function createToolUsageHintHook(): HookCallback {
  // Registry of tool parameter signatures for error guidance
  const TOOL_USAGE: Record<string, string> = {
    'mcp__nanoclaw__send_message': 'send_message({ text: string, sender?: string })\n  例: send_message({ text: "你好" })',
    'mcp__nanoclaw__send_card': 'send_card({ title: string, content: string, color?: string, buttons?: [{text, url}] })\n  例: send_card({ title: "标题", content: "正文内容" })',
    'mcp__nanoclaw__send_media': 'send_media({ file_path?: string, url?: string, media_id?: string, media_type?: "photo"|"video"|"audio"|"document", caption?: string })\n  三选一: file_path / url / media_id',
    'mcp__nanoclaw__generate_image': 'generate_image({ prompt: string, source_image?: string, model?: string, size?: string, caption?: string })\n  例: generate_image({ prompt: "一只猫" })',
    'mcp__nanoclaw__schedule_task': 'schedule_task({ prompt: string, schedule_type: "cron"|"interval"|"once", schedule_value: string, context_mode?: "group"|"isolated" })',
    'mcp__nanoclaw__register_group': 'register_group({ jid: string, name: string, folder: string, trigger: string })',
    'mcp__nanoclaw__list_tasks': 'list_tasks({})',
    'mcp__nanoclaw__pause_task': 'pause_task({ task_id: string })',
    'mcp__nanoclaw__resume_task': 'resume_task({ task_id: string })',
    'mcp__nanoclaw__cancel_task': 'cancel_task({ task_id: string })',
    'mcp__nanoclaw__x_post': 'x_post({ content: string })',
    'mcp__nanoclaw__x_like': 'x_like({ tweet_url: string })',
    'mcp__nanoclaw__x_reply': 'x_reply({ tweet_url: string, content: string })',
    'mcp__nanoclaw__x_retweet': 'x_retweet({ tweet_url: string })',
    'mcp__nanoclaw__x_quote': 'x_quote({ tweet_url: string, comment: string })',
    'mcp__nanoclaw__x_trends': 'x_trends({ count?: number })',
    'mcp__nanoclaw__get_cached_media': 'get_cached_media({ mediaId: string })',
    'mcp__nanoclaw__describe_cached_image': 'describe_cached_image({ mediaId: string, prompt: string })',
    'mcp__nanoclaw__describe_cached_video': 'describe_cached_video({ mediaId: string, prompt: string })',
    'mcp__nanoclaw__transcribe_cached_audio': 'transcribe_cached_audio({ mediaId: string })',
    'TeamCreate': 'TeamCreate({ team_name: string, description?: string, agent_type?: string })',
    'SendMessage': 'SendMessage({ to: string, content: string })',
  };

  return async (input) => {
    const postInput = input as any;
    const toolName: string = postInput.tool_name || '';
    const toolOutput = postInput.tool_response || postInput.error;

    if (!toolOutput) return {};

    const outputStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);

    // Only trigger on validation errors
    const isValidationError = [
      'Invalid arguments for tool',
      'InputValidationError',
      'invalid_type',
      'is missing',
      'MCP error -32602',
      'tool_use_error',
    ].some(p => outputStr.includes(p));

    if (!isValidationError) return {};

    const usage = TOOL_USAGE[toolName];
    const hint = usage
      ? `工具调用失败。正确用法:\n${usage}\n如果连续失败，请直接用文本回复用户。`
      : `工具 ${toolName} 调用参数错误。请检查必需参数后重试，或直接用文本回复用户。`;

    log(`[ToolUsageHint] ${toolName}: returning usage hint`);

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: hint,
      },
    };
  };
}
