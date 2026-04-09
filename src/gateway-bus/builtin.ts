import { GatewayBus } from './index.js';
import { isMemoryEnabled, indexMessage } from '../services/memory/index.js';

/**
 * Initializes all built-in event handlers.
 * This keeps the event system wiring independent from internal subsystem initializations.
 */
export function initBuiltinEventHandlers(): void {
  // Unify legacy RAG indexing by listening to the exact same 'agent_end' event
  // used by OpenClaw memory-lancedb-pro auto-capture.
  GatewayBus.on('agent_end', (payload: any, meta: any) => {
    if (!isMemoryEnabled() || payload.status !== 'success' || !payload.messages)
      return;

    const agentId = meta?.agentId || 'assistant';
    const msgs = payload.messages;
    if (!msgs || msgs.length === 0) return;

    const finalBotMsg = msgs[msgs.length - 1];
    if (finalBotMsg?.role === 'assistant' && finalBotMsg?.content) {
      indexMessage(
        agentId, // scope
        finalBotMsg.content, // text
        agentId, // senderName
        'assistant', // role
      ).catch(() => {});
    }
  });
}
