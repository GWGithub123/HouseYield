// Discover REdistribute MultiClass Schema - Tables and Columns
// Run with: node server/discover-multiclass-schema.js
import 'dotenv/config';
import snowflake from './snowflake.js';

async function discover() {
  console.log('🔄 Connecting to Snowflake MultiClass...\n');
  
  const connResult = await snowflake.testConnection();
  if (!connResult.connected) {
    console.error('❌ Connection failed:', connResult.error);
    process.exit(1);
  }
  console.log(`✅ Connected — DB: ${connResult.database}, Schema: ${connResult.schema}\n`);

  // 1. List all tables
  console.log('=== TABLES IN SCHEMA ===');
  const tables = await snowflake.listTables();
  const tableNames = tables.map(t => t.name);
  tableNames.forEach(n => console.log(`  📋 ${n}`));
  console.log(`\nTotal tables: ${tableNames.length}\n`);

  // 2. Describe each table (columns)
  for (const tableName of tableNames) {
    console.log(`\n=== TABLE: "${tableName}" ===`);
    try {
      const cols = await snowflake.describeTable(`"${tableName}"`);
      cols.forEach(c => {
        console.log(`  ${c.name} (${c.type})`);
      });
      console.log(`  Total columns: ${cols.length}`);
    } catch (err) {
      console.log(`  ❌ Error describing: ${err.message}`);
    }
  }

  // 3. Check if there are new property types beyond residential
  console.log('\n=== DISTINCT PROPERTY TYPES ===');
  try {
    const types = await snowflake.executeQuery(`
      SELECT DISTINCT "PROPERTYTYPE", COUNT(*) as cnt 
      FROM "Property" 
      GROUP BY "PROPERTYTYPE" 
      ORDER BY cnt DESC
    `);
    types.forEach(t => console.log(`  ${t.PROPERTYTYPE}: ${t.CNT} listings`));
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  // 4. Check distinct property subtypes
  console.log('\n=== DISTINCT PROPERTY SUBTYPES ===');
  try {
    const subtypes = await snowflake.executeQuery(`
      SELECT DISTINCT "PROPERTYSUBTYPE", COUNT(*) as cnt 
      FROM "Property" 
      GROUP BY "PROPERTYSUBTYPE" 
      ORDER BY cnt DESC
      LIMIT 50
    `);
    subtypes.forEach(t => console.log(`  ${t.PROPERTYSUBTYPE}: ${t.CNT} listings`));
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  // 5. Check distinct listing statuses
  console.log('\n=== DISTINCT STATUSES ===');
  try {
    const statuses = await snowflake.executeQuery(`
      SELECT DISTINCT "STANDARDSTATUS", COUNT(*) as cnt 
      FROM "Property" 
      GROUP BY "STANDARDSTATUS" 
      ORDER BY cnt DESC
    `);
    statuses.forEach(t => console.log(`  ${t.STANDARDSTATUS}: ${t.CNT} listings`));
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  // 6. Check geographic coverage
  console.log('\n=== TOP STATES BY LISTING COUNT ===');
  try {
    const states = await snowflake.executeQuery(`
      SELECT "STATEORPROVINCE", COUNT(*) as cnt 
      FROM "Property" 
      GROUP BY "STATEORPROVINCE" 
      ORDER BY cnt DESC
      LIMIT 20
    `);
    states.forEach(t => console.log(`  ${t.STATEORPROVINCE}: ${t.CNT} listings`));
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  // 7. Sample some new table columns to understand what's available
  console.log('\n=== SAMPLE PROPERTY RECORD (non-residential if available) ===');
  try {
    const sample = await snowflake.executeQuery(`
      SELECT * FROM "Property" 
      WHERE "PROPERTYTYPE" != 'Residential' 
      LIMIT 1
    `);
    if (sample.length > 0) {
      const record = sample[0];
      const keys = Object.keys(record).filter(k => record[k] !== null);
      keys.forEach(k => console.log(`  ${k}: ${JSON.stringify(record[k]).substring(0, 100)}`));
    } else {
      console.log('  No non-residential properties found');
    }
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  // 8. Check for any new tables beyond Property, Media, OpenHouse, PropertyRooms
  const knownTables = ['Property', 'Media', 'OpenHouse', 'PropertyRooms'];
  const newTables = tableNames.filter(t => !knownTables.includes(t));
  if (newTables.length > 0) {
    console.log('\n=== NEW TABLES (not in current integration) ===');
    newTables.forEach(n => console.log(`  🆕 ${n}`));
    
    // Sample a record from each new table
    for (const tableName of newTables) {
      console.log(`\n  Sample from "${tableName}":`);
      try {
        const sample = await snowflake.executeQuery(`SELECT * FROM "${tableName}" LIMIT 1`);
        if (sample.length > 0) {
          const record = sample[0];
          const keys = Object.keys(record).filter(k => record[k] !== null);
          keys.forEach(k => console.log(`    ${k}: ${JSON.stringify(record[k]).substring(0, 120)}`));
        }
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
      }
    }
  }

  await snowflake.disconnect();
  console.log('\n✅ Done');
}

discover().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
