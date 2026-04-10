/**
 * Memory System — Registry Facade.
 *
 * All external call sites import from this module. The actual implementation
 * is provided by whichever MemoryProvider is registered at startup.
 *
 * Call sites remain unchanged:
 *   - initMemorySystem()          → src/index.ts:1188
 *   - indexMessage(scope, ...)    → src/index.ts:1258
 *   - isMemoryEnabled()           → src/index.ts, gateway.ts
 *   - recallMemory(scope, ...)    → gateway.ts:704
 *   - extractSmartMemories(...)   → src/services/memory/ internal
 */

import * as fs from 'fs';
import { logger } from '../../logger.js';
import { readEnvFile } from '../../env.js';
import { GatewayHooks, GatewayBus } from '../../gateway-bus/index.js';
import { isLowValueQuery } from './memory-lancedb/noise-filter.js';
import { getAllRegisteredGroups } from '../../db.js';
import { resolveAgentName } from '../../agents-config.js';

/**
 * Resolves a chat JID to a unified Agent Scope (e.g., 'xingmeng')
 * so that memory is shared across all channels for the same agent.
 */
export function getAgentScope(chatJidOrFolder: string): string {
  const groups = getAllRegisteredGroups();

  // Direct JID lookup
  let botToken = groups[chatJidOrFolder]?.botToken;

  // Fallback to searching by folder
  if (!botToken) {
    const group = Object.values(groups).find(
      (g) => g.folder === chatJidOrFolder,
    );
    botToken = group?.botToken;
  }

  if (botToken) {
    return resolveAgentName(botToken) || chatJidOrFolder;
  }

  return chatJidOrFolder;
}
import { getCachedMediaPath } from '../../tools/mediaTools.js';
import type {
  MemoryProvider,
  MemoryResult,
  ExtractionStats,
  MultimodalInput,
  IndexMeta,
} from './memory-provider.js';
import { NanoClawMemoryProvider } from './memory-lancedb/nanoclaw-memory-provider.js';

// Re-export types for downstream consumers
export type { MemoryResult, ExtractionStats, MultimodalInput, IndexMeta };
export type { StoreSearchResult } from './memory-lancedb/store.js';

// ============================================================================
// Provider Registry
// ============================================================================

let provider: MemoryProvider | null = null;

/**
 * Register a custom memory provider.
 * Must be called before `initMemorySystem()` to take effect.
 */
export function registerMemoryProvider(p: MemoryProvider): void {
  provider = p;
  logger.info({ provider: p.name }, 'Custom memory provider registered');
}

/**
 * Get the current memory provider instance.
 * Returns null if no provider is registered or initialized.
 */
export function getMemoryProvider(): MemoryProvider | null {
  return provider;
}

// ============================================================================
// Backward-Compatible Facade Functions
// ============================================================================

/**
 * Initialize the memory system.
 * If no custom provider was registered, uses the built-in NanoClawMemoryProvider.
 * Also registers the auto-recall hook for transparent memory injection.
 */
export function initMemorySystem(): void {
  if (!provider) {
    provider = new NanoClawMemoryProvider();
  }

  provider.init().catch((err) => {
    logger.error({ err }, 'Memory provider initialization failed');
  });

  // Auto-recall: inject relevant memories into every agent prompt
  registerAutoRecallHook();

  // Auto-capture: extract memories at the end of each turn
  registerAutoCaptureHook();
}

/**
 * Check if the memory system is operational.
 */
export function isMemoryEnabled(): boolean {
  return provider?.isEnabled() ?? false;
}

/**
 * Index a raw text message (backward-compatible signature).
 */
export async function indexMessage(
  scope: string,
  text: string,
  senderName: string,
  role: string,
): Promise<void> {
  return provider?.indexMessage(scope, text, { senderName, role });
}

/**
 * High-performance hybrid recall (backward-compatible signature).
 */
export async function recallMemory(
  scope: string,
  query: string,
  limit: number = 5,
): Promise<MemoryResult[]> {
  if (!provider) return [];
  return provider.recall(scope, query, limit);
}

/**
 * Trigger LLM-based smart extraction on a transcript.
 * Fire-and-forget recommended.
 */
export async function extractSmartMemories(
  scope: string,
  transcript: string,
  sessionId: string,
  mediaIds?: string[],
): Promise<void> {
  if (!provider) return;
  provider
    .extractAndPersist(scope, transcript, sessionId, mediaIds)
    .catch((err) => {
      logger.error(
        { err, scope },
        'Failed to run async smart memory extraction',
      );
    });
}

/**
 * Index multimodal content (text + image/video).
 * Falls back to text-only indexing if the provider doesn't support multimodal.
 */
export async function indexMultimodal(
  scope: string,
  input: MultimodalInput,
  senderName: string,
  role: string,
): Promise<void> {
  if (!provider) return;
  const meta: IndexMeta = { senderName, role };

  if (provider.indexMultimodal) {
    return provider.indexMultimodal(scope, input, meta);
  }

  // Fallback: extract text and index as plain text
  if (input.text) {
    return provider.indexMessage(scope, input.text, meta);
  }
}

// ============================================================================
// Auto-Recall Hook
// ============================================================================

const AUTO_RECALL_TOP_K = 3;

/**
 * Register the auto-recall hook on `agent:new_message`.
 * This transparently injects relevant memories into every agent prompt.
 */
function registerAutoRecallHook(): void {
  GatewayHooks.register(
    'agent:new_message',
    async (event: {
      sourceGroup: string;
      chatJid: string;
      messages: Array<{ content: string | any[]; sender_name?: string }>;
      prompt: string;
    }) => {
      if (!provider?.isEnabled()) return;

      // Extract the latest user message text for recall query
      const lastMsg = event.messages[event.messages.length - 1];
      if (!lastMsg) return;

      const queryText =
        typeof lastMsg.content === 'string'
          ? lastMsg.content
          : lastMsg.content
              ?.filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('\n') || '';

      if (!queryText || isLowValueQuery(queryText)) return;

      try {
        const agentScope = getAgentScope(event.chatJid || event.sourceGroup);
        const memories = await provider.recall(
          agentScope,
          queryText,
          AUTO_RECALL_TOP_K,
        );

        if (memories.length === 0) return;

        const formatted = formatMemoriesForInjection(memories);
        return { additionalContext: formatted };
      } catch (err) {
        logger.debug({ err }, 'Auto-recall failed (non-fatal)');
        return;
      }
    },
    { priority: -10 }, // Low priority: run after other hooks
  );

  logger.info('Auto-recall hook registered on agent:new_message');
}

/**
 * Format memory results into an XML block for system prompt injection.
 */
function formatMemoriesForInjection(memories: MemoryResult[]): string {
  const items = memories
    .map((m) => {
      const l0 = m.metadata?.l0_abstract;
      const label = l0 ? ` (${l0})` : '';
      const mediaInfo = m.metadata?.MediaIDs?.length
        ? ` [Media: ${m.metadata.MediaIDs.join(', ')}]`
        : '';
      return `- [${m.category}]${label}: ${m.text}${mediaInfo}`;
    })
    .join('\n');

  return `<relevant-memories>
The following are relevant memories from past interactions. Use them to provide more personalized and context-aware responses. Do not mention these memories explicitly unless the user asks.
${items}
</relevant-memories>`;
}

// ============================================================================
// Auto-Capture Hook (Deferred Storage)
// ============================================================================

const extractionTurnCounters: Record<string, number> = {};
const messageBuffer: Record<string, Array<any>> = {};
const lastSeenTimestamps: Record<string, string> = {};

/**
 * Register the auto-capture hook on `agent:idle`.
 * This effectively replaces the old per-message real-time indexing.
 * When the turn completes, we batch the transcript and trigger Smart Extraction.
 */
function registerAutoCaptureHook(): void {
  GatewayBus.on(
    'agent:idle',
    async (event: {
      group: string;
      success: boolean;
      messages: Array<{
        content: string | any[];
        sender_name?: string;
        role?: string;
        timestamp?: string;
      }>;
    }) => {
      if (
        !provider?.isEnabled() ||
        !event.success ||
        !event.messages ||
        event.messages.length === 0
      ) {
        return;
      }

      const jid = event.group;
      if (!messageBuffer[jid]) messageBuffer[jid] = [];
      const lastTs = lastSeenTimestamps[jid] || '';

      // Filter out only physically new messages since last execution
      const newMessages = event.messages.filter(
        (m: any) => m.timestamp && m.timestamp > lastTs,
      );
      if (newMessages.length > 0) {
        lastSeenTimestamps[jid] =
          newMessages[newMessages.length - 1].timestamp!;
        messageBuffer[jid].push(...newMessages);
      }

      // Reconstruct the transcript from the newly arrived messages ONLY, for media parsing
      const newTranscriptPieces = newMessages.map((m: any) => {
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join(' ');
        }
        const sender = m.sender_name || m.role || 'unknown';
        return `${sender}: ${text}`;
      });

      const newFullTranscript = newTranscriptPieces.join('\n');
      //logger.info({ newFullTranscript }, 'Debug: incoming transcript to memory capture');

      // Extract all MediaIDs and process true multimodal data
      const mediaRegex =
        /\[(Photo|Video|Document|Audio)(?:[\s:-]+([^|]*?))?(?:\s*\|\s*User:\s*([^|]*?))?\s*\|\s*MediaID:\s*([\w.-]+)\]/gi;
      let match;
      const allMediaIds: string[] = [];

      while ((match = mediaRegex.exec(newFullTranscript)) !== null) {
        const typeStr = match[1]; // e.g., Photo, Video
        const desc = match[2] ? match[2].trim() : '';
        const userCaption = match[3] ? match[3].trim() : '';
        const mediaId = match[4].trim();
        allMediaIds.push(mediaId);

        // Immediate direct multimodal isolated storage for Images/Videos
        if (typeStr === 'Photo' || typeStr === 'Video') {
          const agentScope = getAgentScope(event.group);
          const filePath = getCachedMediaPath(agentScope, mediaId);
          if (filePath && fs.existsSync(filePath)) {
            // Deduplication: prevent re-indexing the same media across sliding windows
            const indexedMarker = filePath + '.indexed';
            if (!fs.existsSync(indexedMarker)) {
              try {
                const buffer = fs.readFileSync(filePath);
                const base64Data = `data:image/${filePath.endsWith('.png') ? 'png' : 'jpeg'};base64,${buffer.toString('base64')}`;

                const combinedText =
                  `[${typeStr}] ` +
                  (desc || 'A media attachment') +
                  (userCaption ? ` - User said: ${userCaption}` : '');

                const meta: IndexMeta = { senderName: 'user', role: 'user' };
                // We trigger isolated multimodal embedding concurrently
                if (provider.indexMultimodal) {
                  provider
                    .indexMultimodal(
                      agentScope,
                      { text: combinedText, image: base64Data },
                      meta,
                      mediaId,
                    )
                    .then(() => {
                      // Mark as successfully indexed
                      fs.writeFileSync(indexedMarker, '1');
                    })
                    .catch((err) =>
                      logger.debug(
                        { err, mediaId },
                        'Failed to isolated embed media',
                      ),
                    );
                }
              } catch (err) {
                logger.warn(
                  { err, mediaId },
                  'Failed to read media cache for embedding',
                );
              }
            }
          }
        }
      }

      // We use a dummy UUID for sessionId since NanoClaw doesn't have strict session IDs yet.
      // In the future this could be tied to telegram thread_ids.
      const pseudoSessionId = `turn-${Date.now()}`;

      const agentScope = getAgentScope(event.group);

      // Update turn counter for the specific group (not global agent scope)
      extractionTurnCounters[event.group] =
        (extractionTurnCounters[event.group] || 0) + 1;

      const configVars = readEnvFile(['MEMORY_EXTRACTION_INTERVAL']);
      const interval = parseInt(
        process.env.MEMORY_EXTRACTION_INTERVAL ||
          configVars.MEMORY_EXTRACTION_INTERVAL ||
          '1',
        10,
      );

      if (extractionTurnCounters[event.group] % interval !== 0) {
        logger.debug(
          {
            jid: event.group,
            currentTurn: extractionTurnCounters[event.group],
            interval,
          },
          'Skipping smart extraction (interval not reached), messages buffered.',
        );
        return;
      }

      // interval reached! Let's pull the accumulated buffer and summarize it.
      const bufferedMessages = messageBuffer[event.group];
      messageBuffer[event.group] = []; // explicit clear!

      // Reconstruct the transcript strictly from the accumulated buffer
      const transcriptPieces = bufferedMessages.map((m: any) => {
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join(' ');
        }
        const sender = m.sender_name || m.role || 'unknown';
        return `${sender}: ${text}`;
      });
      const bufferedFullTranscript = transcriptPieces.join('\n');

      logger.debug(
        {
          agentScope,
          jid: event.group,
          textLen: bufferedFullTranscript.length,
          mediaCount: allMediaIds.length,
          turn: extractionTurnCounters[event.group],
        },
        'Triggering deferred smart extraction on agent:idle',
      );

      // Async fire-and-forget extraction with media context!
      extractSmartMemories(
        agentScope,
        bufferedFullTranscript,
        pseudoSessionId,
        allMediaIds,
      ).catch(() => {});
    },
  );

  logger.info('Auto-capture hook registered on agent:idle');
}

/**
 * Forcibly flush the current un-extracted message buffer for a chat into LanceDB long-term memory.
 * This is useful before destructive actions like /new, /compact, or /clear.
 */
export async function forceMemoryExtraction(chatJid: string): Promise<void> {
  if (!provider?.isEnabled()) return;

  const bufferedMessages = messageBuffer[chatJid];
  if (!bufferedMessages || bufferedMessages.length === 0) {
    logger.debug({ chatJid }, 'No pending messages in buffer to flush.');
    return;
  }

  // Clear buffer immediately
  messageBuffer[chatJid] = [];

  const transcriptPieces = bufferedMessages.map((m: any) => {
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join(' ');
    }
    const sender = m.sender_name || m.role || 'unknown';
    return `${sender}: ${text}`;
  });

  const bufferedFullTranscript = transcriptPieces.join('\n');
  const agentScope = getAgentScope(chatJid);
  const pseudoSessionId = `flush-${Date.now()}`;

  logger.info(
    { chatJid, agentScope, messagesCount: bufferedMessages.length },
    'Forcibly flushing pending memory buffer to long-term memory...',
  );

  await extractSmartMemories(
    agentScope,
    bufferedFullTranscript,
    pseudoSessionId,
  );
}
