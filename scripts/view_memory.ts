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
      let metaObj: any = {};
      try {
        if (r.metadata) metaObj = JSON.parse(r.metadata as string);
      } catch (e) {}

      const dateStr = metaObj.created_at ? new Date(metaObj.created_at).toLocaleString() : 'Unknown';
      const tier = metaObj.tier || '?';
      const access = metaObj.accessCount || 0;
      const media = (metaObj.MediaIDs && metaObj.MediaIDs.length > 0) ? ` \x1b[45m[Media: ${metaObj.MediaIDs.length}]\x1b[0m` : '';
      const source = metaObj.source || 'N/A';

      // Clean up text for terminal viewing
      const rawText = String(r.text);
      const textToPrint = rawText.length > 300 
        ? rawText.substring(0, 300).replace(/\n/g, ' ') + '...\x1b[90m (truncated)\x1b[0m'
        : rawText.replace(/\n/g, ' ');

      let vecInfo = 'None';
      if (r.vector && (r.vector as any).length) {
        const v = Array.from(r.vector as any);
        vecInfo = `\x1b[90m[${v.length} dims]\x1b[0m <${v.slice(0, 3).map(n => Number(n).toFixed(3)).join(', ')}...>`;
      }

      console.log(`\x1b[36m[#${String(idx + 1).padStart(3, '0')}] ID:\x1b[0m ${r.id}`);
      console.log(`  \x1b[36mVector   :\x1b[0m ${vecInfo}`);
      console.log(`  \x1b[33mCategory :\x1b[0m ${String(r.category).padEnd(12)} \x1b[90m|\x1b[0m \x1b[35mImportance:\x1b[0m ${Number(r.importance).toFixed(2)} \x1b[90m|\x1b[0m \x1b[32mTier:\x1b[0m ${tier} \x1b[90m|\x1b[0m \x1b[34mHits:\x1b[0m ${access}`);
      console.log(`  \x1b[32mTime     :\x1b[0m ${dateStr}  \x1b[90m[Src: ${source}]\x1b[0m${media}`);
      console.log(`  \x1b[37mText     :\x1b[0m ${textToPrint}`);
      
      // Print remaining metadata (except the ones we already extracted)
      const otherMeta = { ...metaObj };
      delete otherMeta.created_at;
      delete otherMeta.last_accessed_at;
      delete otherMeta.accessCount;
      delete otherMeta.tier;
      delete otherMeta.source;
      delete otherMeta.MediaIDs;
      
      if (Object.keys(otherMeta).length > 0) {
        console.log(`  \x1b[90mExtraMeta:\x1b[0m ${JSON.stringify(otherMeta).substring(0, 200)}`);
      }
      console.log('\x1b[90m--------------------------------------------------------------------------------\x1b[0m');
    });

  } catch (e: any) {
    console.error(`Failed to read table [${scope}]. Are you sure it exists?`, e.message);
  }
}

main();
