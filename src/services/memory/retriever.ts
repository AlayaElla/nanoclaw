import { MemoryStore, StoreSearchResult } from './store.js';
import { embedQuery } from './embedder.js';
import { DecayEngine } from './decay-engine.js';
import { DecayableMemory } from './types.js';

export interface RetrieverConfig {
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  hardMinScore: number;
  lengthNormAnchor: number;
  candidatePoolSize: number;
}

const DEFAULT_CONFIG: RetrieverConfig = {
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.2,
  hardMinScore: 0.1,
  lengthNormAnchor: 600,
  candidatePoolSize: 20,
};

function clamp01(val: number, floor: number = 0): number {
  return Math.max(floor, Math.min(1.0, val));
}

// MMR helper
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
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

export class MemoryRetriever {
  constructor(
    private store: MemoryStore,
    private config: RetrieverConfig = DEFAULT_CONFIG,
    private decayEngine: DecayEngine | null = null,
  ) {}

  public async retrieve(
    scope: string,
    query: string,
    limit: number = 5,
  ): Promise<StoreSearchResult[]> {
    const candidatePoolSize = Math.max(
      this.config.candidatePoolSize,
      limit * 2,
    );

    // 1. Embed query
    let queryVector: number[] = [];
    try {
      queryVector = await embedQuery(query);
    } catch (e) {
      console.warn('Retriever: Failed to embed query', e);
      return [];
    }

    // 2. Parallel Search
    const [vectorResults, bm25Results] = await Promise.all([
      this.store
        .vectorSearch(scope, queryVector, candidatePoolSize)
        .catch(() => []),
      this.store.bm25Search(scope, query, candidatePoolSize).catch(() => []),
    ]);

    // 3. RRF Fusion
    const fusedResults = await this.fuseResults(
      scope,
      vectorResults,
      bm25Results,
    );

    // 4. Initial filtering and Text Deduplication
    const seenTexts = new Set<string>();
    const scoreFiltered = fusedResults.filter((r) => {
      // Drop results below minimum score
      if (r.score < this.config.minScore) return false;

      const textTrim = r.entry.text.trim();
      // Drop exact literal matches to the query to avoid immediate echoing
      if (textTrim === query.trim()) return false;
      // Deduplicate exactly identical texts
      if (seenTexts.has(textTrim)) return false;
      seenTexts.add(textTrim);

      // Time echo prevention: ignore raw transcripts generated in the last 15 seconds
      if (r.entry.category === 'transcript') {
        let metaObj: any = {};
        try {
          metaObj = JSON.parse(r.entry.metadata || '{}');
        } catch {}
        const created_at = metaObj.created_at || Date.now();
        if (Date.now() - created_at < 15000) return false;
      }

      return true;
    });

    // 5. Apply time and lifecycle decay
    let lifecycleRanked: StoreSearchResult[];
    if (this.decayEngine) {
      lifecycleRanked = this.applyDecayBoost(scoreFiltered);
    } else {
      // Basic time decay if decay engine is off
      lifecycleRanked = this.applyTimeDecay(scoreFiltered);
    }

    // 6. Length Normalization
    const lengthNormalized = this.applyLengthNormalization(lifecycleRanked);

    // 7. Hard Filter
    const hardFiltered = lengthNormalized.filter(
      (r) => r.score >= this.config.hardMinScore,
    );

    // 8. MMR Diversity (Deduplication / Diversity)
    const diverseResults = this.applyMMRDiversity(hardFiltered);

    // 9. Return top-k
    const finalResults = diverseResults.slice(0, limit);

    // 10. Best effort: Record access for top 3
    if (finalResults.length > 0) {
      this.recordAccess(scope, finalResults.slice(0, 3)).catch((err) => {
        console.warn('Failed to record memory access async', err);
      });
    }

    return finalResults;
  }

  private async fuseResults(
    scope: string,
    vectorResults: StoreSearchResult[],
    bm25Results: StoreSearchResult[],
  ): Promise<StoreSearchResult[]> {
    const vectorMap = new Map<string, StoreSearchResult>();
    const bm25Map = new Map<string, StoreSearchResult>();

    vectorResults.forEach((r) => vectorMap.set(r.entry.id, r));
    bm25Results.forEach((r) => bm25Map.set(r.entry.id, r));

    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);
    const fusedResults: StoreSearchResult[] = [];

    for (const id of allIds) {
      const vRes = vectorMap.get(id);
      const bRes = bm25Map.get(id);

      if (!vRes && bRes) {
        // Ghost check
        const exists = await this.store.hasId(scope, id);
        if (!exists) continue;
      }

      const baseResult = vRes || bRes!;
      const vScore = vRes ? vRes.score : 0;
      const bScore = bRes ? bRes.score : 0;

      // Note: BM25 score from lancedb FTS isn't strictly normalized (0-1). We'll assume a bounding function.
      // Easiest is to just cap bScore for fusion if it exceeds 1
      const normalizedBScore = clamp01(bScore / 10.0); // Rough normalization hack if raw score is high

      const weightedFusion =
        vScore * this.config.vectorWeight +
        normalizedBScore * this.config.bm25Weight;
      const fusedScore = clamp01(
        Math.max(
          weightedFusion,
          normalizedBScore >= 0.75 ? normalizedBScore * 0.9 : 0,
        ),
        0.1,
      );

      fusedResults.push({
        entry: baseResult.entry,
        score: fusedScore,
      });
    }

    return fusedResults.sort((a, b) => b.score - a.score);
  }

  private applyTimeDecay(results: StoreSearchResult[]): StoreSearchResult[] {
    const halfLife = 30; // days
    const now = Date.now();
    return results
      .map((r) => {
        let metaObj: any = {};
        try {
          metaObj = JSON.parse(r.entry.metadata || '{}');
        } catch {}

        const ts = metaObj.created_at || now;
        const ageDays = (now - ts) / 86400000;
        const factor = 0.5 + 0.5 * Math.exp(-ageDays / halfLife);
        return {
          ...r,
          score: clamp01(r.score * factor, r.score * 0.5),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  private applyDecayBoost(results: StoreSearchResult[]): StoreSearchResult[] {
    if (!this.decayEngine || results.length === 0) return results;

    const scored = results.map((r) => {
      let metaObj: any = {};
      try {
        metaObj = JSON.parse(r.entry.metadata || '{}');
      } catch {}

      const memory: DecayableMemory = {
        id: r.entry.id,
        importance: r.entry.importance || 0.5,
        confidence: metaObj.confidence || 0.8,
        tier: metaObj.tier || 'peripheral',
        accessCount: metaObj.accessCount || 0,
        createdAt: metaObj.created_at || Date.now(),
        lastAccessedAt: metaObj.lastAccessedAt || Date.now(),
        temporalType: metaObj.memory_temporal_type || 'static',
      };

      return { memory, score: r.score };
    });

    this.decayEngine.applySearchBoost(scored);

    return results
      .map((r, i) => ({
        ...r,
        score: clamp01(scored[i].score, r.score * 0.3),
      }))
      .sort((a, b) => b.score - a.score);
  }

  private applyLengthNormalization(
    results: StoreSearchResult[],
  ): StoreSearchResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (anchor <= 0) return results;

    return results
      .map((r) => {
        const charLen = r.entry.text.length;
        const ratio = charLen / anchor;
        const logRatio = Math.log2(Math.max(ratio, 1));
        const factor = 1 / (1 + 0.5 * logRatio);
        return {
          ...r,
          score: clamp01(r.score * factor, r.score * 0.3),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  private applyMMRDiversity(
    results: StoreSearchResult[],
    threshold = 0.85,
  ): StoreSearchResult[] {
    if (results.length <= 1) return results;

    const selected: StoreSearchResult[] = [];
    const deferred: StoreSearchResult[] = [];

    for (const candidate of results) {
      const tooSimilar = selected.some((s) => {
        const sVec = s.entry.vector;
        const cVec = candidate.entry.vector;
        if (!sVec?.length || !cVec?.length) return false;

        let sim = 0;
        try {
          sim = cosineSimilarity(sVec as any, cVec as any);
        } catch {}
        return sim > threshold;
      });

      if (tooSimilar) {
        deferred.push(candidate);
      } else {
        selected.push(candidate);
      }
    }
    return [...selected, ...deferred];
  }

  private async recordAccess(
    scope: string,
    results: StoreSearchResult[],
  ): Promise<void> {
    for (const r of results) {
      await this.store.updateAccessStats(scope, r.entry.id);
    }
  }
}
