import crypto from 'crypto';
import { logger } from '../../logger.js';
import { memoryStore, StoreSearchResult } from './store.js';
import { MemoryRetriever } from './retriever.js';
import { DecayEngine } from './decay-engine.js';
import { SmartExtractor, initExtractor } from './smart-extractor.js';
import { embedQuery, initEmbedder, isEmbedderEnabled } from './embedder.js';
import { shouldCapture } from './noise-filter.js';

export { StoreSearchResult } from './store.js';

// Init Singletons
const decayEngine = new DecayEngine();
const retriever = new MemoryRetriever(memoryStore, undefined, decayEngine);
const smartExtractor = new SmartExtractor(memoryStore);

export function initMemorySystem(): void {
  initEmbedder();
  initExtractor();
  logger.info('Memory services initialized.');
}

export function isMemoryEnabled(): boolean {
  return isEmbedderEnabled();
}

/**
 * Legacy API equivalent: Indises a raw text message.
 * We apply basic noise filtering here directly.
 */
export async function indexMessage(scope: string, text: string, senderName: string, role: string): Promise<void> {
  if (!shouldCapture(text)) {
    logger.debug({ scope }, 'Skipped indexing low-value message');
    return;
  }

  try {
    const vector = await embedQuery(text);
    const now = Date.now();
    
    await memoryStore.insert(scope, {
      id: crypto.randomUUID(),
      vector,
      text,
      category: 'transcript',
      scope,
      importance: 0.5, // Base transcript importance
      metadata: JSON.stringify({
        sender_name: senderName,
        role: role,
        created_at: now,
        last_accessed_at: now,
        accessCount: 0,
        tier: 'peripheral', // Raw logs start at bottom tier
        confidence: 0.9,
        source: 'transcript'
      }),
    });
  } catch (err) {
    logger.error({ err, scope }, 'Failed to index text message into memory');
  }
}

/**
 * High-performance hybrid recall used by Auto-Recall and slash commands.
 */
export async function recallMemory(scope: string, query: string, limit: number = 5): Promise<StoreSearchResult[]> {
  if (!isMemoryEnabled()) return [];
  try {
    return await retriever.retrieve(scope, query, limit);
  } catch (err) {
    logger.error({ err, scope, query }, 'Memory recall failed');
    return [];
  }
}

/**
 * Triggers LLM analysis of the transcript.
 * Recommended to trigger fire-and-forget in the Stop hook.
 */
export async function extractSmartMemories(scope: string, transcript: string, sessionId: string): Promise<void> {
  if (!isMemoryEnabled()) return;
  // Fire and forget
  smartExtractor.extractAndPersist(scope, transcript, sessionId).catch((err) => {
    logger.error({ err, scope }, 'Failed to run async smart memory extraction');
  });
}
