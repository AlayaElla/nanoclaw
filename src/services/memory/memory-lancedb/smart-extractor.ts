import crypto from 'crypto';
import { logger } from '../../../logger.js';
import { readEnvFile } from '../../../env.js';
import { MemoryStore, StoreEntry } from './store.js';
import { embedQuery } from '../embedder.js';
import {
  evaluateAdmission,
  type AdmissionResult,
} from './admission-control.js';
import { ExtractionRateLimiter } from './rate-limiter.js';

export interface ExtractorConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ExtractionStats {
  created: number;
  merged: number;
  skipped: number;
}

let extractorConfig: ExtractorConfig | null = null;
let rateLimiter = new ExtractionRateLimiter(30);

export function initExtractor(): void {
  const envVars = readEnvFile([
    'MEMORY_EXTRACTION_MODEL',
    'MEMORY_EXTRACTION_API_BASE',
    'MEMORY_EXTRACTION_API_KEY',
    'MEMORY_EXTRACTION_MAX_PER_HOUR',
  ]);

  const maxPerHour = parseInt(
    process.env.MEMORY_EXTRACTION_MAX_PER_HOUR ||
      envVars.MEMORY_EXTRACTION_MAX_PER_HOUR ||
      '30',
    10,
  );
  rateLimiter = new ExtractionRateLimiter(maxPerHour);

  // Fallback to primary LLM configuration if extraction config is missing
  const model =
    process.env.MEMORY_EXTRACTION_MODEL ||
    envVars.MEMORY_EXTRACTION_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    envVars.ANTHROPIC_MODEL ||
    'qwen3.5-plus';

  // LiteLLM proxy base URL normalization
  const fallbackBaseUrl =
    process.env.ANTHROPIC_BASE_URL ||
    envVars.ANTHROPIC_BASE_URL ||
    'http://localhost:4000';
  const normalizedFallbackBaseUrl = fallbackBaseUrl.endsWith('/v1')
    ? fallbackBaseUrl
    : `${fallbackBaseUrl}/v1`;

  const baseUrl =
    process.env.MEMORY_EXTRACTION_API_BASE ||
    envVars.MEMORY_EXTRACTION_API_BASE ||
    normalizedFallbackBaseUrl;

  const apiKey =
    process.env.MEMORY_EXTRACTION_API_KEY ||
    envVars.MEMORY_EXTRACTION_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    envVars.ANTHROPIC_API_KEY ||
    'sk-nanoclaw';

  extractorConfig = { apiKey, baseUrl, model };
  logger.info({ model, baseUrl }, 'Smart Extractor initialized');
}

export function getExtractorCallLLM(): (
  prompt: string,
  systemPrompt: string,
) => Promise<string> {
  return callLLM;
}

async function callLLM(prompt: string, systemPrompt: string): Promise<string> {
  if (!extractorConfig) throw new Error('Extractor not initialized');

  const response = await fetch(`${extractorConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${extractorConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: extractorConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Extraction LLM error ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as any;
  return result.choices[0].message.content;
}

const EXTRACTION_SYSTEM_PROMPT = `
You are a highly capable AI Memory Extractor.
Your task is to analyze the provided conversation transcript and extract enduring, context-independent knowledge about the user, project, or environment.

Ignore conversational noise, greetings, or ephemeral status updates (e.g., "I'm fixing a bug").
Extract ONLY structural knowledge that will be valuable across future, unrelated sessions.

Categorize each finding into one of the following:
- profile: User identity, roles, communication style preferences.
- preferences: Preferred frameworks, tools, design choices, or architectural principles.
- entities: Specific locations, repo paths, credentials (if explicitly requested to remember), or infrastructure details.
- events: Significant milestones, resolved architectural decisions, or major incidents/lessons learned.
- patterns: Recurring work patterns, coding idioms, decision-making heuristics, or habitual approaches.
- procedures: Step-by-step operational procedures, deployment workflows, or debugging routines.

For each memory, provide:
- category: One of the 6 categories above.
- content: The specific context-independent fact.
- l0_abstract: A single-sentence summary (max 20 words) that captures the essence.
- importance: A float between 0.1 (trivial) and 1.0 (mission-critical).

Return a valid JSON object matching this schema exactly:
{
  "memories": [
    {
      "category": "preferences" | "profile" | "entities" | "events" | "patterns" | "procedures",
      "content": "The specific context-independent fact",
      "l0_abstract": "Brief one-sentence summary",
      "importance": <float 0.1 - 1.0>
    }
  ]
}
If no valuable knowledge is present, return {"memories": []}.
`;

export class SmartExtractor {
  constructor(private store: MemoryStore) {}

  public async extractAndPersist(
    scope: string,
    transcript: string,
    sourceSession: string,
    mediaIds?: string[],
  ): Promise<ExtractionStats> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };
    if (!extractorConfig) {
      logger.warn('Extractor config missing, skipping smart extraction');
      return stats;
    }

    // Rate limit check
    if (!rateLimiter.tryAcquire(scope)) {
      return stats;
    }

    try {
      const responseText = await callLLM(transcript, EXTRACTION_SYSTEM_PROMPT);
      let cleanText = responseText;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanText = jsonMatch[0];
      }

      let parsed: any;
      try {
        parsed = JSON.parse(cleanText);
      } catch (e) {
        logger.warn(
          { responseText },
          'Failed to parse JSON from smart extraction',
        );
        return stats;
      }

      const memories = parsed.memories || [];
      for (const mem of memories) {
        if (!mem.content || !mem.category || mem.importance == null) {
          stats.skipped++;
          continue;
        }

        const vector = await embedQuery(mem.content);

        // --- Admission Control (two-stage deduplication) ---
        const existingList = await this.store.vectorSearch(scope, vector, 1);

        let admission: AdmissionResult = {
          decision: 'CREATE',
          reason: 'No existing match',
        };

        if (existingList.length > 0 && existingList[0].score > 0.5) {
          const existing = existingList[0];
          admission = await evaluateAdmission(
            mem.content,
            existing.entry.text,
            existing.score,
            callLLM,
          );
        }

        if (admission.decision === 'SKIP') {
          stats.skipped++;
          logger.debug(
            { scope, reason: admission.reason, category: mem.category },
            'Admission: SKIP',
          );
          continue;
        }

        const finalText =
          admission.decision === 'MERGE' && admission.mergedText
            ? admission.mergedText
            : mem.content;

        // If MERGE, re-embed the merged text
        const finalVector =
          admission.decision === 'MERGE' ? await embedQuery(finalText) : vector;

        const now = Date.now();
        const entryId = crypto.randomUUID();
        const entry: StoreEntry = {
          id: entryId,
          vector: finalVector,
          text: finalText,
          category: mem.category,
          scope,
          importance: mem.importance,
          metadata: JSON.stringify({
            created_at: now,
            last_accessed_at: now,
            accessCount: 0,
            tier: 'working',
            confidence: 0.9,
            source_session: sourceSession,
            source: 'smart-extraction',
            l0_abstract: mem.l0_abstract || '',
            admission_decision: admission.decision,
            MediaIDs: mediaIds && mediaIds.length > 0 ? mediaIds : [],
          }),
        };

        await this.store.insert(scope, entry);

        if (admission.decision === 'MERGE') {
          stats.merged++;
          // Mark old entry as merged
          if (existingList.length > 0) {
            await this.store
              .patchMetadata(scope, existingList[0].entry.id, {
                state: 'merged',
                merged_into: entryId,
              })
              .catch(() => {});
          }
        } else {
          stats.created++;
        }
      }

      if (stats.created > 0 || stats.merged > 0) {
        logger.info({ scope, ...stats }, 'Smart extraction completed');
      }
    } catch (err) {
      logger.error({ err, scope }, 'Smart extraction failed');
    }

    return stats;
  }
}
