/**
 * RAG 数据库测试/查看工具
 *
 * 用法:
 *   npx tsx scripts/test-rag.ts                  # 列出所有表和记录数
 *   npx tsx scripts/test-rag.ts --dump [表名]     # 查看表内容 (最近20条)
 *   npx tsx scripts/test-rag.ts --count [表名]    # 统计条目数
 */
import lancedb from '@lancedb/lancedb';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAG_DIR = path.resolve(__dirname, '..', 'data', 'rag');

async function main() {
  const args = process.argv.slice(2);
  const db = await lancedb.connect(RAG_DIR);
  const tables = await db.tableNames();

  if (tables.length === 0) {
    console.log('📦 RAG 数据库为空，还没有任何表。');
    return;
  }

  console.log('📦 RAG 数据库中的表:');
  for (const name of tables) {
    const table = await db.openTable(name);
    const count = await table.countRows();
    console.log(`  - ${name} (${count} 条记录)`);
  }

  if (args[0] === '--count') {
    const tableName = args[1] || tables[0];
    if (!tables.includes(tableName)) {
      console.log(`\n❌ 表 "${tableName}" 不存在`);
      return;
    }
    const table = await db.openTable(tableName);
    const count = await table.countRows();
    console.log(`\n表 "${tableName}" 共有 ${count} 条记录`);
    return;
  }

  if (args[0] === '--dump') {
    const tableName = args[1] || tables[0];
    if (!tables.includes(tableName)) {
      console.log(`\n❌ 表 "${tableName}" 不存在，可用: ${tables.join(', ')}`);
      return;
    }
    const table = await db.openTable(tableName);
    const rows = await table.query().limit(20).toArray();
    console.log(`\n📋 表 "${tableName}" 最近 ${rows.length} 条记录:\n`);
    for (const row of rows) {
      const { vector, ...rest } = row as any;
      console.log(`[${rest.role}] ${rest.sender_name || '?'} @ ${rest.timestamp}`);
      console.log(`  ${(rest.text || '').slice(0, 200)}`);
      console.log('---');
    }
  }
}

main().catch(console.error);
