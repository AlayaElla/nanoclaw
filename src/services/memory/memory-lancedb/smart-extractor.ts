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
你是一个能力极强的 AI 记忆提取器。
你的任务是分析提供的对话记录，并提取出关于用户、项目或环境中持久的、独立于上下文的知识。

忽略对话中的噪音、问候语或短暂的状态更新（例如：“我正在修复一个bug”）。
仅提取在未来不相关的会话中具有价值的结构化知识。

将每个发现归类为以下之一：
- profile: 用户身份、角色、沟通方式偏好。
- preferences: 偏好的框架、工具、设计选择或架构原则。
- entities: 特定位置、代码库路径、凭证（如果明确要求记住），或基础设施的详细信息。
- events: 重要的里程碑、已解决的架构决策，或重大事件/经验教训。
- patterns: 反复出现的工作模式、编码习惯、决策启发式，或习惯性方法。
- procedures: 分步操作规程、部署工作流，或调试常规。

对于每条记忆，提供：
- category: 上述 6 个类别之一。
- content: 具体的、独立于上下文的事实。
- l0_abstract: 一句话摘要（最多 30 个字），捕捉精髓。
- importance: 介于 0.1（微不足道）和 1.0（关键任务）之间的浮点数。

返回一个完全符合此架构的有效 JSON 对象：
{
  "memories": [
    {
      "category": "preferences" | "profile" | "entities" | "events" | "patterns" | "procedures",
      "content": "具体的独立于上下文的事实（必须使用中文说明）",
      "l0_abstract": "一句话简短摘要（必须使用中文说明）",
      "importance": <0.1 - 1.0 之间的浮点数>
    }
  ]
}
如果没有存在价值的知识，则返回 {"memories": []}。
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
