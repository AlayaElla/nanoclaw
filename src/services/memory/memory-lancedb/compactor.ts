/**
 * Memory Compactor — Cluster and merge similar memories.
 *
 * Triggered during LanceDB compact operations. Scans for highly similar
 * memory clusters and uses LLM to merge them into condensed entries.
 *
 * Pipeline:
 *   1. Pull all memories from a scope
 *   2. Find pairs with cosine similarity > threshold
 *   3. Group into clusters (union-find)
 *   4. For each cluster > 1 entry: LLM merges → delete old → insert new
 */

import crypto from 'crypto';
import { logger } from '../../../logger.js';
import { MemoryStore, StoreEntry } from './store.js';
import { embedQuery } from '../embedder.js';

export interface CompactorConfig {
  /** Similarity threshold for clustering (default: 0.88) */
  similarityThreshold: number;
  /** Max memories to scan per compaction run (default: 200) */
  maxScanSize: number;
  /** Minimum cluster size to trigger merge (default: 2) */
  minClusterSize: number;
  /** Cooldown between compactions per scope in ms (default: 24h) */
  cooldownMs: number;
}

const DEFAULT_CONFIG: CompactorConfig = {
  similarityThreshold: 0.88,
  maxScanSize: 200,
  minClusterSize: 2,
  cooldownMs: 24 * 3600_000,
};

export interface CompactionStats {
  clustersFound: number;
  memoriesMerged: number;
  memoriesCreated: number;
}

// Track last compaction time per scope
const lastCompactionAt = new Map<string, number>();

const MERGE_SYSTEM_PROMPT = `You are a Memory Consolidation Engine. Given a cluster of related memories, merge them into a single concise but comprehensive entry.

Rules:
- Preserve ALL factual information — no information loss.
- Remove redundancy and repetition.
- Use clear, structured language.
- The result should be a single paragraph or a few bullet points.
- Output the merged text directly, no JSON wrapper needed.`;

export class MemoryCompactor {
  constructor(
    private store: MemoryStore,
    private callLLM: (prompt: string, systemPrompt: string) => Promise<string>,
    private config: CompactorConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Check if compaction should run for this scope.
   */
  shouldCompact(scope: string): boolean {
    const last = lastCompactionAt.get(scope);
    if (last && Date.now() - last < this.config.cooldownMs) {
      return false;
    }
    return true;
  }

  /**
   * Run compaction on a scope. Fire-and-forget safe.
   */
  async compact(scope: string): Promise<CompactionStats> {
    const stats: CompactionStats = {
      clustersFound: 0,
      memoriesMerged: 0,
      memoriesCreated: 0,
    };

    if (!this.shouldCompact(scope)) {
      return stats;
    }

    lastCompactionAt.set(scope, Date.now());

    try {
      // 1. Pull candidates (vector search with a zero vector to get all, or we scan)
      // Since LanceDB doesn't have a "scan all" API easily, we'll do a broad
      // vector search with a random vector to get a sample
      const sampleVector = await embedQuery('memory compaction scan');
      const candidates = await this.store.vectorSearch(
        scope,
        sampleVector,
        this.config.maxScanSize,
      );

      if (candidates.length < 2) return stats;

      // 2. Build similarity-based clusters using union-find
      const entries = candidates.map((c) => c.entry);
      const clusters = this.clusterBySimilarity(entries);

      // 3. Merge each cluster
      for (const cluster of clusters) {
        if (cluster.length < this.config.minClusterSize) continue;

        stats.clustersFound++;

        try {
          const mergedText = await this.mergeCluster(cluster);
          if (!mergedText) continue;

          // Create new merged entry
          const vector = await embedQuery(mergedText);
          const highestImportance = Math.max(
            ...cluster.map((e) => e.importance),
          );
          const now = Date.now();

          const newEntry: StoreEntry = {
            id: crypto.randomUUID(),
            vector,
            text: mergedText,
            category: cluster[0].category,
            scope,
            importance: Math.min(highestImportance * 1.1, 1.0), // Slight boost
            metadata: JSON.stringify({
              created_at: now,
              last_accessed_at: now,
              accessCount: 0,
              tier: 'working',
              confidence: 0.95,
              source: 'compaction',
              merged_from: cluster.map((e) => e.id),
            }),
          };

          await this.store.insert(scope, newEntry);
          stats.memoriesCreated++;
          stats.memoriesMerged += cluster.length;

          // Note: LanceDB doesn't support easy deletes.
          // We mark old entries as "merged" via metadata patch.
          for (const old of cluster) {
            await this.store
              .patchMetadata(scope, old.id, {
                state: 'merged',
                merged_into: newEntry.id,
              })
              .catch(() => {});
          }
        } catch (err) {
          logger.warn(
            { err, scope, clusterSize: cluster.length },
            'Failed to merge memory cluster',
          );
        }
      }

      if (stats.clustersFound > 0) {
        logger.info({ scope, ...stats }, 'Memory compaction complete');
      }
    } catch (err) {
      logger.error({ err, scope }, 'Memory compaction failed');
    }

    return stats;
  }

  /**
   * Group entries into clusters based on pairwise cosine similarity.
   * Uses simple union-find.
   */
  private clusterBySimilarity(entries: StoreEntry[]): StoreEntry[][] {
    const n = entries.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    function find(x: number): number {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]; // path compression
        x = parent[x];
      }
      return x;
    }

    function union(a: number, b: number): void {
      const pa = find(a);
      const pb = find(b);
      if (pa !== pb) parent[pa] = pb;
    }

    // O(n²) pairwise comparison — acceptable for maxScanSize ≤ 200
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = this.cosineSimilarity(entries[i].vector, entries[j].vector);
        if (sim >= this.config.similarityThreshold) {
          union(i, j);
        }
      }
    }

    // Group by root
    const groups = new Map<number, StoreEntry[]>();
    for (let i = 0; i < n; i++) {
      // Skip init entries and already-merged entries
      if (entries[i].id === '__init__') continue;
      let meta: any = {};
      try {
        meta = JSON.parse(entries[i].metadata || '{}');
      } catch {}
      if (meta.state === 'merged') continue;

      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(entries[i]);
    }

    return [...groups.values()].filter(
      (g) => g.length >= this.config.minClusterSize,
    );
  }

  /**
   * Use LLM to merge a cluster of related memories into one.
   */
  private async mergeCluster(cluster: StoreEntry[]): Promise<string | null> {
    const textsBlock = cluster
      .map((e, i) => `[Memory ${i + 1}]:\n${e.text}`)
      .join('\n\n');

    const prompt = `Merge the following ${cluster.length} related memories into one consolidated entry:\n\n${textsBlock}`;

    try {
      const result = await this.callLLM(prompt, MERGE_SYSTEM_PROMPT);
      const trimmed = result.trim();
      if (trimmed.length < 10) return null; // Too short, likely garbage
      return trimmed;
    } catch (err) {
      logger.warn({ err }, 'LLM merge call failed');
      return null;
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
