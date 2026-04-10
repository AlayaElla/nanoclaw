/**
 * Reranker — DashScope cross-encoder reranking.
 *
 * Inserted into the retrieval pipeline between hard-filter and MMR.
 * Uses DashScope's text-reranking API to re-score candidates against
 * the original query using a cross-encoder model.
 *
 * DashScope Rerank API:
 *   POST https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
 *   Model: gte-rerank-v2 (or gte-rerank)
 */

import { logger } from '../../../logger.js';
import { readEnvFile } from '../../../env.js';

export interface RerankConfig {
  apiKey: string;
  model: string;
  /** Keep top N after reranking (0 = keep all, just re-sort) */
  topN: number;
  /** Minimum relevance score to keep (0-1) */
  minRelevance: number;
}

export interface RerankInput {
  id: string;
  text: string;
  originalScore: number;
}

export interface RerankResult {
  id: string;
  text: string;
  rerankScore: number;
  originalScore: number;
}

let rerankConfig: RerankConfig | null = null;

const RERANK_API_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';

export function initReranker(): void {
  const envVars = readEnvFile([
    'RERANK_API_KEY',
    'RERANK_MODEL',
    'EMBEDDING_API_KEY',
  ]);

  // Fall back to embedding API key if rerank-specific key isn't set
  const apiKey =
    process.env.RERANK_API_KEY ||
    envVars.RERANK_API_KEY ||
    process.env.EMBEDDING_API_KEY ||
    envVars.EMBEDDING_API_KEY ||
    '';

  const model =
    process.env.RERANK_MODEL || envVars.RERANK_MODEL || 'gte-rerank-v2';

  if (!apiKey) {
    logger.info('Reranker: No API key configured, reranking disabled');
    return;
  }

  rerankConfig = {
    apiKey,
    model,
    topN: 0,
    minRelevance: 0.01,
  };

  logger.info({ model }, 'Reranker initialized (DashScope)');
}

export function isRerankerEnabled(): boolean {
  return rerankConfig !== null;
}

/**
 * Rerank candidates against a query using DashScope cross-encoder.
 *
 * @param query    The user's search query
 * @param candidates  The candidates to rerank
 * @returns  Reranked candidates, sorted by relevance (highest first)
 */
export async function rerank(
  query: string,
  candidates: RerankInput[],
): Promise<RerankResult[]> {
  if (!rerankConfig || candidates.length === 0) {
    // Passthrough: return as-is with rerankScore = originalScore
    return candidates.map((c) => ({
      ...c,
      rerankScore: c.originalScore,
    }));
  }

  try {
    const documents = candidates.map((c) => c.text);

    const response = await fetch(RERANK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rerankConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: rerankConfig.model,
        input: {
          query,
          documents,
        },
        parameters: {
          return_documents: false,
          top_n: rerankConfig.topN || candidates.length,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn(
        { status: response.status, error: errorText.slice(0, 200) },
        'Rerank API error, falling back to original scores',
      );
      return candidates.map((c) => ({
        ...c,
        rerankScore: c.originalScore,
      }));
    }

    const result = (await response.json()) as {
      output: {
        results: Array<{
          index: number;
          relevance_score: number;
        }>;
      };
      usage?: { total_tokens: number };
    };

    if (!result.output?.results) {
      logger.warn('Rerank: Malformed response, falling back');
      return candidates.map((c) => ({
        ...c,
        rerankScore: c.originalScore,
      }));
    }

    // Build reranked results
    const reranked: RerankResult[] = [];
    for (const r of result.output.results) {
      const original = candidates[r.index];
      if (!original) continue;

      // Filter by minimum relevance
      if (r.relevance_score < rerankConfig.minRelevance) continue;

      reranked.push({
        id: original.id,
        text: original.text,
        rerankScore: r.relevance_score,
        originalScore: original.originalScore,
      });
    }

    // Sort by rerank score (highest first) — API may already return sorted,
    // but we enforce it
    reranked.sort((a, b) => b.rerankScore - a.rerankScore);

    return reranked;
  } catch (err) {
    logger.warn({ err }, 'Rerank failed, falling back to original scores');
    return candidates.map((c) => ({
      ...c,
      rerankScore: c.originalScore,
    }));
  }
}
