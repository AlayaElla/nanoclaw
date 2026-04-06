import crypto from 'crypto';
import { logger } from '../../logger.js';
import { readEnvFile } from '../../env.js';
import { MemoryStore, StoreEntry } from './store.js';
import { embedQuery } from './embedder.js';

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

export function initExtractor(): void {
  const envVars = readEnvFile([
    'MEMORY_EXTRACTION_MODEL',
    'MEMORY_EXTRACTION_API_BASE',
    'MEMORY_EXTRACTION_API_KEY',
  ]);

  // Fallback to primary LLM configuration if extraction config is missing
  const model =
    process.env.MEMORY_EXTRACTION_MODEL || envVars.MEMORY_EXTRACTION_MODEL || 'qwen3.5-plus-non-thinking';
  const baseUrl =
    process.env.MEMORY_EXTRACTION_API_BASE || envVars.MEMORY_EXTRACTION_API_BASE || 'http://host.docker.internal:18788/v1'; // Default LiteLLM proxy
  const apiKey =
    process.env.MEMORY_EXTRACTION_API_KEY || envVars.MEMORY_EXTRACTION_API_KEY || 'sk-nanoclaw';

  extractorConfig = { apiKey, baseUrl, model };
  logger.info({ model, baseUrl }, 'Smart Extractor initialized');
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
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Extraction LLM error ${response.status}: ${errorText}`);
  }

  const result = await response.json() as any;
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

For each memory, assign an importance score between 0.1 (trivial) and 1.0 (mission-critical).

Return a valid JSON object matching this schema exactly:
{
  "memories": [
    {
      "category": "preferences" | "profile" | "entities" | "events",
      "content": "The specific context-independent fact",
      "importance": <float 0.1 - 1.0>
    }
  ]
}
If no valuable knowledge is present, return {"memories": []}.
`;

export class SmartExtractor {
  constructor(private store: MemoryStore) {}

  public async extractAndPersist(scope: string, transcript: string, sourceSession: string): Promise<ExtractionStats> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };
    if (!extractorConfig) {
      logger.warn('Extractor config missing, skipping smart extraction');
      return stats;
    }

    try {
      const responseText = await callLLM(transcript, EXTRACTION_SYSTEM_PROMPT);
      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch (e) {
        logger.warn({ responseText }, 'Failed to parse JSON from smart extraction');
        return stats;
      }

      const memories = parsed.memories || [];
      for (const mem of memories) {
        if (!mem.content || !mem.category || mem.importance == null) {
          stats.skipped++;
          continue;
        }

        const vector = await embedQuery(mem.content);
        
        // Basic pre-screening for exact duplicates in the vector space
        const existingList = await this.store.vectorSearch(scope, vector, 1);
        if (existingList.length > 0 && existingList[0].score > 0.90) {
          // If a highly similar concept exists, we merge (here implemented as 'skip' due to LanceDB limits,
          // though ideal implementation would re-embed a combined string or update accessCount)
          stats.merged++;
          continue;
        }

        const now = Date.now();
        const entryId = crypto.randomUUID();
        const entry: StoreEntry = {
          id: entryId,
          vector,
          text: mem.content,
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
          })
        };

        await this.store.insert(scope, entry);
        stats.created++;
      }
    } catch (err) {
      logger.error({ err, scope }, 'Smart string extraction failed');
    }

    return stats;
  }
}
