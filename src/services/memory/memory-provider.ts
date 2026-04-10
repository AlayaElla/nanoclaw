/**
 * Memory Provider Interface — Provider-agnostic abstraction layer.
 *
 * Allows the memory system implementation to be swapped without
 * changing any call sites. Current implementation: NanoClawMemoryProvider.
 */

// ============================================================================
// Core Types
// ============================================================================

export type MemoryTier = 'core' | 'working' | 'peripheral';

export interface MemoryResult {
  id: string;
  text: string;
  score: number;
  category: string;
  scope: string;
  importance: number;
  metadata: Record<string, any>;
}

export interface IndexMeta {
  senderName: string;
  role: string;
}

export interface MultimodalInput {
  text?: string;
  image?: string; // URL or base64
  video?: string; // URL or base64
}

export interface ExtractionStats {
  created: number;
  merged: number;
  skipped: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface EmbeddingProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ExtractionProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface RetrievalProviderConfig {
  vectorWeight?: number;
  bm25Weight?: number;
  minScore?: number;
  hardMinScore?: number;
  lengthNormAnchor?: number;
  candidatePoolSize?: number;
}

export interface MemoryProviderConfig {
  embedding?: EmbeddingProviderConfig;
  extraction?: ExtractionProviderConfig;
  retrieval?: RetrievalProviderConfig;
  dbPath?: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * The core memory provider interface.
 *
 * Any memory backend must implement this interface. The system uses
 * a singleton provider registered via `registerMemoryProvider()`.
 *
 * Current implementations:
 *   - NanoClawMemoryProvider (built-in, multimodal DashScope + LanceDB)
 *
 * Future possibilities:
 *   - memory-lancedb-pro adapter
 *   - Redis-backed memory
 *   - Cloud vector DB (Pinecone, Qdrant, etc.)
 */
export interface MemoryProvider {
  readonly name: string;

  // --- Lifecycle ---

  /** Initialize the provider (embedder, extractor, DB connection, etc.) */
  init(config?: MemoryProviderConfig): Promise<void>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;

  /** Whether the provider is ready to serve */
  isEnabled(): boolean;

  // --- Write Path ---

  /**
   * Index a single text message into memory.
   * Applies noise filtering before storage.
   */
  indexMessage(scope: string, text: string, meta: IndexMeta): Promise<void>;

  /**
   * Run LLM-based smart extraction on a conversation transcript.
   * Extracts structured knowledge and persists it.
   * Fire-and-forget recommended.
   */
  extractAndPersist(
    scope: string,
    transcript: string,
    sessionId: string,
    mediaIds?: string[],
  ): Promise<ExtractionStats>;

  // --- Read Path ---

  /**
   * Hybrid recall: vector search + BM25 + fusion + decay + diversity.
   * Returns top-k most relevant memories.
   */
  recall(scope: string, query: string, limit?: number): Promise<MemoryResult[]>;

  // --- Optional: Multimodal (Phase 2) ---

  /**
   * Index multimodal content (text + image/video).
   * Only available when the embedding model supports multimodal input.
   */
  indexMultimodal?(
    scope: string,
    input: MultimodalInput,
    meta: IndexMeta,
    mediaId?: string,
  ): Promise<void>;
}
