/**
 * Admission Control — Two-stage write quality gate.
 *
 * Ported from memory-lancedb-pro's admission pipeline.
 * Before a new memory is written to the store, it passes through:
 *
 *   1. Vector pre-check: Find nearest existing memory (cosine similarity)
 *   2. If similarity > threshold: LLM decides CREATE / MERGE / SKIP
 *   3. If similarity <= threshold: direct CREATE
 *
 * This prevents duplicate or near-duplicate memories from accumulating
 * and enables intelligent merge of related facts.
 */

import { logger } from '../../../logger.js';

export type AdmissionDecision = 'CREATE' | 'MERGE' | 'SKIP';

export interface AdmissionResult {
  decision: AdmissionDecision;
  /** For MERGE: the combined text to store instead of the new one */
  mergedText?: string;
  /** Reasoning from the LLM (for debugging) */
  reason?: string;
}

export interface AdmissionConfig {
  /** Similarity threshold above which LLM judgment is triggered */
  similarityThreshold: number;
  /** Similarity above which we auto-skip without LLM */
  autoSkipThreshold: number;
}

const DEFAULT_CONFIG: AdmissionConfig = {
  similarityThreshold: 0.7,
  autoSkipThreshold: 0.95,
};

const ADMISSION_SYSTEM_PROMPT = `You are a Memory Deduplication Judge. Given an existing memory and a new candidate memory, decide:

- CREATE: The new memory contains genuinely new information not covered by the existing one.
- MERGE: They describe similar or overlapping knowledge. Produce a merged version that combines both.
- SKIP: The new memory is redundant — the existing one already captures this information.

Rules:
- Prefer MERGE over SKIP when the new memory adds even small nuances.
- The merged text should be concise but complete — no information loss.
- Output valid JSON only.

Output format:
{
  "decision": "CREATE" | "MERGE" | "SKIP",
  "merged_text": "..." (only if MERGE),
  "reason": "brief explanation"
}`;

/**
 * Evaluate whether a new memory should be created, merged, or skipped.
 */
export async function evaluateAdmission(
  newText: string,
  existingText: string,
  similarity: number,
  callLLM: (prompt: string, systemPrompt: string) => Promise<string>,
  config: AdmissionConfig = DEFAULT_CONFIG,
): Promise<AdmissionResult> {
  // Fast path: extremely similar → auto-skip
  if (similarity >= config.autoSkipThreshold) {
    return { decision: 'SKIP', reason: 'Near-identical duplicate' };
  }

  // Below threshold → no conflict, create directly
  if (similarity < config.similarityThreshold) {
    return { decision: 'CREATE', reason: 'Below similarity threshold' };
  }

  // In the gray zone — ask the LLM
  try {
    const prompt = `Existing memory:\n"""${existingText}"""\n\nNew candidate memory:\n"""${newText}"""\n\nSimilarity score: ${similarity.toFixed(3)}`;

    const responseText = await callLLM(prompt, ADMISSION_SYSTEM_PROMPT);
    let parsed: any;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // Try to extract JSON from markdown code blocks
      const match = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        parsed = JSON.parse(match[1].trim());
      } else {
        logger.warn(
          { responseText: responseText.slice(0, 200) },
          'Admission Control: Failed to parse LLM response, defaulting to CREATE',
        );
        return { decision: 'CREATE', reason: 'LLM parse failure fallback' };
      }
    }

    const decision = (
      parsed.decision || 'CREATE'
    ).toUpperCase() as AdmissionDecision;
    if (!['CREATE', 'MERGE', 'SKIP'].includes(decision)) {
      return { decision: 'CREATE', reason: 'Invalid decision from LLM' };
    }

    return {
      decision,
      mergedText: decision === 'MERGE' ? parsed.merged_text : undefined,
      reason: parsed.reason,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Admission Control: LLM call failed, defaulting to CREATE',
    );
    return { decision: 'CREATE', reason: 'LLM call failed, safe fallback' };
  }
}
