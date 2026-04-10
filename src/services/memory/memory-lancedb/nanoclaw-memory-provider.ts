/**
 * NanoClaw Memory Provider — Built-in implementation.
 *
 * Wraps the existing LanceDB + DashScope multimodal embedding system
 * into the MemoryProvider interface. This is a pure refactor — no
 * logic changes from the original flat module.
 */

import crypto from 'crypto';
import { logger } from '../../../logger.js';
import { memoryStore, StoreSearchResult } from './store.js';
import { MemoryRetriever } from './retriever.js';
import { DecayEngine } from './decay-engine.js';
import { shouldSkipRetrieval } from './adaptive-retrieval.js';
import {
  SmartExtractor,
  initExtractor,
  getExtractorCallLLM,
} from './smart-extractor.js';
import {
  embedQuery,
  getEmbedding,
  initEmbedder,
  isEmbedderEnabled,
} from '../embedder.js';
import type { EmbeddingInput } from '../embedder.js';
import { shouldCapture } from './noise-filter.js';
import { initReranker } from './reranker.js';
import { MemoryCompactor } from './compactor.js';
import type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryResult,
  IndexMeta,
  MultimodalInput,
  ExtractionStats,
} from '../memory-provider.js';

export class NanoClawMemoryProvider implements MemoryProvider {
  readonly name = 'nanoclaw-builtin';

  private decayEngine: DecayEngine;
  private retriever: MemoryRetriever;
  private smartExtractor: SmartExtractor;
  private compactor: MemoryCompactor | null = null;
  private initialized = false;

  constructor() {
    this.decayEngine = new DecayEngine();
    this.retriever = new MemoryRetriever(
      memoryStore,
      undefined,
      this.decayEngine,
    );
    this.smartExtractor = new SmartExtractor(memoryStore);
  }

  async init(_config?: MemoryProviderConfig): Promise<void> {
    initEmbedder();
    initExtractor();
    initReranker();

    // Initialize compactor (depends on extractor's LLM being ready)
    this.compactor = new MemoryCompactor(memoryStore, getExtractorCallLLM());

    this.initialized = true;
    logger.info('[MemoryProvider:nanoclaw] Memory services initialized.');
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    logger.info('[MemoryProvider:nanoclaw] Memory services shut down.');
  }

  isEnabled(): boolean {
    return this.initialized && isEmbedderEnabled();
  }

  async indexMessage(
    scope: string,
    text: string,
    meta: IndexMeta,
  ): Promise<void> {
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
        importance: 0.5,
        metadata: JSON.stringify({
          sender_name: meta.senderName,
          role: meta.role,
          created_at: now,
          last_accessed_at: now,
          accessCount: 0,
          tier: 'peripheral',
          confidence: 0.9,
          source: 'transcript',
        }),
      });
    } catch (err) {
      logger.error({ err, scope }, 'Failed to index text message into memory');
    }
  }

  async extractAndPersist(
    scope: string,
    transcript: string,
    sessionId: string,
    mediaIds?: string[],
  ): Promise<ExtractionStats> {
    if (!this.isEnabled()) {
      return { created: 0, merged: 0, skipped: 0 };
    }

    try {
      return await this.smartExtractor.extractAndPersist(
        scope,
        transcript,
        sessionId,
        mediaIds,
      );
    } catch (err) {
      logger.error(
        { err, scope },
        'Failed to run async smart memory extraction',
      );
      return { created: 0, merged: 0, skipped: 0 };
    }
  }

  async recall(
    scope: string,
    query: string,
    limit: number = 5,
  ): Promise<MemoryResult[]> {
    if (!this.isEnabled()) return [];

    if (shouldSkipRetrieval(query)) {
      logger.debug(
        { scope, query: query.substring(0, 50) },
        'Skipped memory recall for low-value/skip pattern query',
      );
      return [];
    }

    try {
      const results: StoreSearchResult[] = await this.retriever.retrieve(
        scope,
        query,
        limit,
      );

      return results.map((r) => {
        let metadata: Record<string, any> = {};
        try {
          metadata = JSON.parse(r.entry.metadata || '{}');
        } catch {}

        return {
          id: r.entry.id,
          text: r.entry.text,
          score: r.score,
          category: r.entry.category,
          scope: r.entry.scope,
          importance: r.entry.importance,
          metadata,
        };
      });
    } catch (err) {
      logger.error({ err, scope, query }, 'Memory recall failed');
      return [];
    }
  }

  async indexMultimodal(
    scope: string,
    input: MultimodalInput,
    meta: IndexMeta,
    mediaId?: string,
  ): Promise<void> {
    const text = input.text || '';
    if (!text && !input.image && !input.video) return;
    if (text && !shouldCapture(text)) return;

    try {
      const embeddingInput: EmbeddingInput = {
        text: input.text,
        image: input.image,
        video: input.video,
      };
      const vector = await getEmbedding(embeddingInput);
      const now = Date.now();

      await memoryStore.insert(scope, {
        id: crypto.randomUUID(),
        vector,
        text: text || '[multimodal content]',
        category: 'transcript',
        scope,
        importance: 0.5,
        metadata: JSON.stringify({
          sender_name: meta.senderName,
          role: meta.role,
          created_at: now,
          last_accessed_at: now,
          accessCount: 0,
          tier: 'peripheral',
          confidence: 0.9,
          source: 'multimodal-transcript',
          has_image: !!input.image,
          has_video: !!input.video,
          MediaIDs: mediaId ? [mediaId] : [],
        }),
      });
    } catch (err) {
      logger.error(
        { err, scope },
        'Failed to index multimodal content into memory',
      );
    }
  }
}
