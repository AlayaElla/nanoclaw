import * as lancedb from '@lancedb/lancedb';
import { logger } from '../../logger.js';
import { EMBEDDING_DIM } from './embedder.js';

export interface StoreEntry {
  id: string; // A UUID for this memory
  vector: number[];
  text: string;
  category: string;
  scope: string; // Typically the groupFolder
  importance: number;
  metadata: string; // JSON string for SmartMetadata
}

export interface StoreSearchResult {
  entry: StoreEntry;
  score: number; // For LanceDB this will be (1 - distance)
}

export class MemoryStore {
  private db: lancedb.Connection | null = null;
  private tableCache = new Map<string, lancedb.Table>();
  private tablePending = new Map<string, Promise<lancedb.Table>>();

  constructor(private dbPath: string = 'data/rag') {}

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
      logger.info(`LanceDB connected at ${this.dbPath}`);
    }
    return this.db;
  }

  // Use a common table for all memories or one per scope. 
  // memory-lancedb-pro uses a single table ('memories') and filters by scope/agent id.
  // NanoClaw used one table per groupFolder. We will adapt to one table per groupFolder to keep isolation intact.
  private sanitizeTableName(scope: string): string {
    // Allows unicode letters/numbers, dashes, dots, underscores
    return scope.replace(/[^\p{L}\p{N}_.-]/gu, '_') || 'global_memories';
  }

  private async getOrCreateTable(scope: string): Promise<lancedb.Table> {
    const tableName = this.sanitizeTableName(scope);

    const cached = this.tableCache.get(tableName);
    if (cached) return cached;

    const pending = this.tablePending.get(tableName);
    if (pending) return pending;

    const promise = (async () => {
      const connection = await this.getDb();
      try {
        const table = await connection.openTable(tableName);
        this.tableCache.set(tableName, table);
        return table;
      } catch {
        // Table doesn't exist
      }

      const emptyVector = new Array(EMBEDDING_DIM).fill(0);
      const table = await connection.createTable(tableName, [
        {
          id: '__init__',
          vector: emptyVector,
          text: '',
          category: '',
          scope: scope,
          importance: 0,
          metadata: '{}',
        },
      ]);
      
      try {
        // Enable Full Text Search index for BM25
        await table.createIndex('text', { config: lancedb.Index.fts() });
      } catch (e) {
        logger.warn({ tableName, err: e }, "Failed to create FTS index for BM25. BM25 may be disabled.");
      }

      logger.info({ scope, tableName }, 'Created memory RAG table');
      this.tableCache.set(tableName, table);
      return table;
    })();

    this.tablePending.set(tableName, promise);
    try {
      return await promise;
    } finally {
      this.tablePending.delete(tableName);
    }
  }

  public async insert(scope: string, entry: StoreEntry): Promise<void> {
    const table = await this.getOrCreateTable(scope);
    await table.add([entry as unknown as Record<string, unknown>]);
  }

  public async vectorSearch(
    scope: string,
    vector: number[],
    limit: number,
  ): Promise<StoreSearchResult[]> {
    const table = await this.getOrCreateTable(scope);
    const search = table.search(vector).limit(limit + 5); 
    const rawResults = await search.toArray();

    const results: StoreSearchResult[] = [];
    for (const row of rawResults) {
      if (row.id === '__init__') continue;
      
      results.push({
        entry: {
          id: row.id,
          vector: row.vector as any,
          text: row.text,
          category: row.category,
          scope: row.scope,
          importance: row.importance,
          metadata: row.metadata,
        },
        score: row._distance != null ? 1 - row._distance : 0,
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  public async bm25Search(
    scope: string,
    query: string,
    limit: number,
  ): Promise<StoreSearchResult[]> {
    const table = await this.getOrCreateTable(scope);
    try {
      // requires valid FTS index
      const search = table.search(query).limit(limit + 5); 
      const rawResults = await search.toArray();

      const results: StoreSearchResult[] = [];
      for (const row of rawResults) {
        if (row.id === '__init__') continue;
        
        results.push({
          entry: {
            id: row.id,
            vector: row.vector as any,
            text: row.text,
            category: row.category,
            scope: row.scope,
            importance: row.importance,
            metadata: row.metadata,
          },
          // BM25 score could be unnormalized, so we just pass it along
          score: row._score != null ? row._score : 0, 
        });
        if (results.length >= limit) break;
      }
      return results;
    } catch (e) {
      logger.warn({ scope, query, err: e }, 'BM25 search failed, likely FTS not indexed yet');
      return [];
    }
  }

  public async patchMetadata(
    scope: string,
    id: string,
    patch: Record<string, any>
  ): Promise<void> {
    const table = await this.getOrCreateTable(scope);
    // LanceDB doesn't have partial update easily; we might have to select, mutate, delete, insert.
    // BUT we can use table.update
    const records = await table.search('').where(`id = '${id}'`).limit(1).toArray();
    if (records.length === 0) return;

    const record = records[0];
    let metaObj = {};
    try {
      metaObj = JSON.parse(record.metadata || '{}');
    } catch {}

    metaObj = { ...metaObj, ...patch };

    await table.update({ where: `id = '${id}'`, values: { metadata: JSON.stringify(metaObj) } });
  }

  public async updateAccessStats(scope: string, id: string): Promise<void> {
    const table = await this.getOrCreateTable(scope);
    const records = await table.search('').where(`id = '${id}'`).limit(1).toArray();
    if (records.length === 0) return;

    const record = records[0];
    let metaObj: any = {};
    try {
      metaObj = JSON.parse(record.metadata || '{}');
    } catch {}

    const accessCount = (metaObj.accessCount || 0) + 1;
    const lastAccessedAt = Date.now();
    
    metaObj.accessCount = accessCount;
    metaObj.lastAccessedAt = lastAccessedAt;

    await table.update({ where: `id = '${id}'`, values: { metadata: JSON.stringify(metaObj) } });
  }

  public async hasId(scope: string, id: string): Promise<boolean> {
    const table = await this.getOrCreateTable(scope);
    const records = await table.search('').where(`id = '${id}'`).limit(1).toArray();
    return records.length > 0;
  }
}

export const memoryStore = new MemoryStore();
