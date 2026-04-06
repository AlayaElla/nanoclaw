import { logger } from '../../logger.js';
import { readEnvFile } from '../../env.js';

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface EmbeddingInput {
  text?: string;
  image?: string;
  video?: string;
}

let embeddingConfig: EmbeddingConfig | null = null;
export const EMBEDDING_DIM = 2560; // qwen3-vl-embedding default dimension (can be adjusted if model changes)

export function initEmbedder(): void {
  const envVars = readEnvFile([
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL',
  ]);

  const apiKey = process.env.EMBEDDING_API_KEY || envVars.EMBEDDING_API_KEY || '';
  let baseUrl =
    process.env.EMBEDDING_BASE_URL ||
    envVars.EMBEDDING_BASE_URL ||
    'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding';
  const model =
    process.env.EMBEDDING_MODEL ||
    envVars.EMBEDDING_MODEL ||
    'qwen3-vl-embedding';

  // Force multimodal endpoint if using multimodal models, as they don't support compatible-mode
  if (model.includes('vl-embedding') || model.includes('vision') || model.includes('multimodal')) {
    baseUrl = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding';
  }

  if (!apiKey) {
    logger.warn('Embedder: EMBEDDING_API_KEY not set, embedder disabled');
    return;
  }

  embeddingConfig = { apiKey, baseUrl, model };
  logger.info({ model, baseUrl }, 'Embedder initialized');
}

export function isEmbedderEnabled(): boolean {
  return embeddingConfig !== null;
}

export async function getEmbedding(input: string | EmbeddingInput): Promise<number[]> {
  if (!embeddingConfig) {
    throw new Error('Embedder not initialized: EMBEDDING_API_KEY not set');
  }

  const inputObj = typeof input === 'string' ? { text: input } : input;

  // Use compatible mode for standard text embeddings like text-embedding-v3
  if (!embeddingConfig.model.includes('vl-embedding') && !embeddingConfig.model.includes('vision') && !embeddingConfig.model.includes('multimodal')) {
    const textInput = inputObj.text || '';
    const response = await fetch(embeddingConfig.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${embeddingConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: embeddingConfig.model,
        input: textInput,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embedding API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as any;
    return result.data[0].embedding;
  }

  // Multimodal endpoints
  const response = await fetch(embeddingConfig.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${embeddingConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: embeddingConfig.model,
      input: {
        contents: [inputObj],
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Multimodal Embedding API error ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as {
    output: {
      embeddings: Array<{ embedding: number[] }>;
    };
    usage?: {
      total_tokens: number;
    };
  };

  if (!result.output?.embeddings?.[0]?.embedding) {
    throw new Error('Malformed embedding response');
  }

  // Natively log token usage for RAG
  if (result.usage?.total_tokens) {
    import('../../db.js').then(module => {
      import('crypto').then(crypto => {
        module.insertTokenUsage({
          id: crypto.randomUUID(),
          group_id: 'system',
          task_id: 'rag',
          timestamp: new Date().toISOString(),
          model: embeddingConfig!.model,
          input_tokens: result.usage!.total_tokens,
          output_tokens: 0,
          total_tokens: result.usage!.total_tokens,
        });
      }).catch(() => {});
    }).catch(() => {});
  }

  return result.output.embeddings[0].embedding;
}

export async function embedQuery(text: string): Promise<number[]> {
  return getEmbedding(text);
}

export async function embedPassage(text: string): Promise<number[]> {
  return getEmbedding(text);
}
