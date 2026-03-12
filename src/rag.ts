/**
 * RAG (Retrieval Augmented Generation) module for NanoClaw.
 * Uses DashScope text-embedding-v4 for embeddings and LanceDB for vector storage.
 * Each group has its own table for message isolation.
 */

import * as lancedb from '@lancedb/lancedb';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// --- Configuration ---

const CHUNK_SIZE = 1000; // Max characters per chunk
const EMBEDDING_DIM = 1024; // text-embedding-v4 dimension

interface EmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface RagMetadata {
  role: 'user' | 'assistant';
  sender_name?: string;
  message_id?: string;
  timestamp?: string;
  chat_source?: string;
  chunk_index?: number;
  total_chunks?: number;
}

export interface SearchResult {
  text: string;
  role: string;
  sender_name: string;
  timestamp: string;
  chat_source: string;
  score: number;
}

// --- State ---

let db: lancedb.Connection | null = null;
let embeddingConfig: EmbeddingConfig | null = null;

// --- Initialization ---

export function initRag(): void {
  const envVars = readEnvFile([
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL',
  ]);

  const apiKey =
    process.env.EMBEDDING_API_KEY || envVars.EMBEDDING_API_KEY || '';
  const baseUrl =
    process.env.EMBEDDING_BASE_URL ||
    envVars.EMBEDDING_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model =
    process.env.EMBEDDING_MODEL ||
    envVars.EMBEDDING_MODEL ||
    'text-embedding-v4';

  if (!apiKey) {
    logger.warn('RAG: EMBEDDING_API_KEY not set, RAG disabled');
    return;
  }

  embeddingConfig = { apiKey, baseUrl, model };
  logger.info({ model, baseUrl }, 'RAG initialized with DashScope embedding');
}

async function getDb(): Promise<lancedb.Connection> {
  if (!db) {
    db = await lancedb.connect('data/rag');
    logger.info('LanceDB connected at data/rag/');
  }
  return db;
}

// --- Text chunking ---

export function chunkText(
  text: string,
  maxSize: number = CHUNK_SIZE,
): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxSize && current) {
      chunks.push(current.trim());
      current = '';
    }

    // If a single paragraph exceeds maxSize, split by sentences
    if (trimmed.length > maxSize) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      // Split by sentence boundaries
      const sentences = trimmed.split(/(?<=[。！？.!?\n])/);
      for (const sentence of sentences) {
        if (current.length + sentence.length > maxSize && current) {
          chunks.push(current.trim());
          current = '';
        }
        current += sentence;
      }
    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text.slice(0, maxSize)];
}

// --- Embedding ---

export async function getEmbedding(text: string): Promise<number[]> {
  if (!embeddingConfig) {
    throw new Error('RAG not initialized: EMBEDDING_API_KEY not set');
  }

  const response = await fetch(`${embeddingConfig.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${embeddingConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: embeddingConfig.model,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return result.data[0].embedding;
}

// --- Table helpers ---

function sanitizeTableName(groupFolder: string): string {
  // LanceDB only allows alphanumeric ASCII, underscores, hyphens, and periods
  return groupFolder.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function getOrCreateTable(groupFolder: string): Promise<lancedb.Table> {
  const connection = await getDb();
  const tableName = sanitizeTableName(groupFolder);

  const tableNames = await connection.tableNames();
  if (tableNames.includes(tableName)) {
    return connection.openTable(tableName);
  }

  // Create table with a dummy record (LanceDB requires data on creation)
  const emptyVector = new Array(EMBEDDING_DIM).fill(0);
  const table = await connection.createTable(tableName, [
    {
      vector: emptyVector,
      text: '',
      role: 'system',
      sender_name: '',
      message_id: '__init__',
      timestamp: new Date().toISOString(),
      chat_source: '',
      chunk_index: 0,
      total_chunks: 0,
    },
  ]);

  logger.info({ groupFolder, tableName }, 'Created RAG table');
  return table;
}

// --- Indexing ---

export async function indexMessage(
  groupFolder: string,
  text: string,
  metadata: RagMetadata,
): Promise<void> {
  if (!embeddingConfig) return; // RAG disabled

  try {
    const chunks = chunkText(text);
    const table = await getOrCreateTable(groupFolder);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.trim()) continue;

      const vector = await getEmbedding(chunk);

      await table.add([
        {
          vector,
          text: chunk,
          role: metadata.role,
          sender_name: metadata.sender_name || '',
          message_id: metadata.message_id || '',
          timestamp: metadata.timestamp || new Date().toISOString(),
          chat_source: metadata.chat_source || '',
          chunk_index: i,
          total_chunks: chunks.length,
        },
      ]);
    }

    logger.debug(
      { groupFolder, role: metadata.role, chunks: chunks.length },
      'Indexed message',
    );
  } catch (err) {
    logger.error({ err, groupFolder }, 'Failed to index message');
  }
}

// --- Search ---

export async function searchMemory(
  groupFolder: string,
  query: string,
  topK: number = 5,
  roleFilter?: 'user' | 'assistant',
): Promise<SearchResult[]> {
  if (!embeddingConfig) {
    return [];
  }

  try {
    const table = await getOrCreateTable(groupFolder);
    const queryVector = await getEmbedding(query);

    let search = table.search(queryVector).limit(topK + 5); // Over-fetch for filtering

    const rawResults = await search.toArray();

    // Filter and format
    const results: SearchResult[] = [];
    for (const row of rawResults) {
      // Skip init record
      if (row.message_id === '__init__') continue;
      // Role filter
      if (roleFilter && row.role !== roleFilter) continue;
      // Skip empty text
      if (!row.text?.trim()) continue;

      results.push({
        text: row.text,
        role: row.role,
        sender_name: row.sender_name,
        timestamp: row.timestamp,
        chat_source: row.chat_source || '',
        score: row._distance != null ? 1 - row._distance : 0,
      });

      if (results.length >= topK) break;
    }

    logger.debug(
      { groupFolder, query: query.slice(0, 50), results: results.length },
      'RAG search completed',
    );

    return results;
  } catch (err) {
    logger.error({ err, groupFolder, query }, 'RAG search failed');
    return [];
  }
}

// --- Status ---

export function isRagEnabled(): boolean {
  return embeddingConfig !== null;
}
