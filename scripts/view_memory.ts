import * as lancedb from '@lancedb/lancedb';
import path from 'path';

async function main() {
  const scope = process.argv[2];
  if (!scope) {
    console.log("Usage: npx tsx scripts/view_memory.ts <table_name>");
    console.log("Example: npx tsx scripts/view_memory.ts alaya_claw");
    
    // Attempt to list tables
    try {
      const db = await lancedb.connect('data/rag');
      const tables = await db.tableNames();
      console.log('\nAvailable memory tables:');
      for (const t of tables) {
        console.log(`- ${t}`);
      }
    } catch (e) {
      console.log('No memory tables found yet.');
    }
    process.exit(0);
  }

  const dbPath = path.resolve('data/rag');
  let db;
  try {
    db = await lancedb.connect(dbPath);
  } catch (err: any) {
    console.error(`Failed to connect to LanceDB at ${dbPath}:`, err.message);
    process.exit(1);
  }

  try {
    const table = await db.openTable(scope);
    const count = await table.countRows();
    console.log(`\n=== Table [${scope}] contains ${count} memories ===\n`);
    
    const records = await table.query()
      .where('id != "__init__"')
      .limit(100) // limit to 100 to avoid giant dumps
      .toArray();

    if (records.length === 0) {
      console.log('Table is empty (only __init__ record exists).');
      return;
    }

    records.forEach((r, idx) => {
      console.log(`[#${idx + 1}] ID: ${r.id}`);
      console.log(`  Category  : ${r.category}`);
      console.log(`  Text      : ${String(r.text).substring(0, 150).replace(/\n/g, ' ')}${(r.text as string).length > 150 ? '...' : ''}`);
      console.log(`  Importance: ${r.importance}`);
      console.log(`  Metadata  : ${r.metadata}`);
      console.log('----------------------------------------------------');
    });

  } catch (e: any) {
    console.error(`Failed to read table [${scope}]. Are you sure it exists?`, e.message);
  }
}

main();
