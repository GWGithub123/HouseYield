/**
 * Discover exact table names and query historical data
 */
import sfModule from './snowflake.js';

async function discover() {
  const conn = await sfModule.connect();
  const run = (sql) => new Promise((resolve, reject) => {
    conn.execute({ sqlText: sql, complete: (err, stmt, rows) => err ? reject(err) : resolve(rows) });
  });

  // Step 1: Show all tables with exact names
  console.log('\n=== EXACT TABLE NAMES ===');
  const tables = await run(`SHOW TABLES IN SCHEMA "PREMIUMMULTICLASS"`);
  tables.forEach(t => console.log(`  Schema: ${t.schema_name}, Table: "${t.name}", Kind: ${t.kind}, Rows: ${t.rows}`));

  // Step 2: Try quoted table names (these came from the previous discovery)
  console.log('\n=== TESTING PROPERTY TABLE QUERY ===');
  for (const tbl of ['Property', 'PROPERTY', 'property']) {
    try {
      const res = await run(`SELECT COUNT(*) as CNT FROM "PREMIUMMULTICLASS"."${tbl}"`);
      console.log(`  "${tbl}" works! Count: ${res[0].CNT}`);
      break;
    } catch (e) {
      console.log(`  "${tbl}" failed: ${e.message.substring(0, 80)}`);
    }
  }

  // Step 3: Try using the table names exactly as SHOW TABLES returned them
  const propertyTable = tables.find(t => t.name.toLowerCase() === 'property');
  const historyTable = tables.find(t => t.name.toLowerCase() === 'businesshistory');
  const mediaTable = tables.find(t => t.name.toLowerCase() === 'media');

  if (propertyTable) {
    const PT = propertyTable.name;
    console.log(`\nUsing Property table name: "${PT}"`);

    console.log('\n=== DATE RANGE & COUNTS ===');
    try {
      const stats = await run(`
        SELECT 
          COUNT(*) as TOTAL,
          MIN("OriginalOnMarket") as EARLIEST_MARKET,
          MAX("OriginalOnMarket") as LATEST_MARKET,
          MIN("CloseDate") as EARLIEST_CLOSE,
          MAX("CloseDate") as LATEST_CLOSE,
          MIN("ModificationTimestamp") as EARLIEST_MOD,
          MAX("ModificationTimestamp") as LATEST_MOD,
          MIN("ListingContractDate") as EARLIEST_CONTRACT,
          MAX("ListingContractDate") as LATEST_CONTRACT
        FROM "PREMIUMMULTICLASS"."${PT}"
      `);
      console.log(JSON.stringify(stats[0], null, 2));
    } catch (e) {
      // Try all uppercase columns
      console.log('Mixed case failed, trying uppercase...');
      const stats = await run(`
        SELECT 
          COUNT(*) as TOTAL,
          MIN("ORIGINALONMARKET") as EARLIEST_MARKET,
          MAX("ORIGINALONMARKET") as LATEST_MARKET,
          MIN("CLOSEDATE") as EARLIEST_CLOSE,
          MAX("CLOSEDATE") as LATEST_CLOSE,
          MIN("MODIFICATIONTIMESTAMP") as EARLIEST_MOD,
          MAX("MODIFICATIONTIMESTAMP") as LATEST_MOD
        FROM "PREMIUMMULTICLASS"."${PT}"
      `);
      console.log(JSON.stringify(stats[0], null, 2));
    }

    console.log('\n=== PRICE COLUMNS ===');
    try {
      const cols = await run(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = '${PT}'
        AND (COLUMN_NAME ILIKE '%price%' OR COLUMN_NAME ILIKE '%close%date%' 
             OR COLUMN_NAME ILIKE '%original%' OR COLUMN_NAME ILIKE '%list%date%'
             OR COLUMN_NAME ILIKE '%market%' OR COLUMN_NAME ILIKE '%status%'
             OR COLUMN_NAME ILIKE '%sold%' OR COLUMN_NAME ILIKE '%pending%')
        ORDER BY COLUMN_NAME
      `);
      cols.forEach(c => console.log(`  ${c.COLUMN_NAME}`));
    } catch(e) { console.log('Error:', e.message); }

    console.log('\n=== YEAR DISTRIBUTION ===');
    try {
      const yearDist = await run(`
        SELECT 
          YEAR("OriginalOnMarket") as YR,
          COUNT(*) as CNT,
          ROUND(AVG("ListPrice"), 0) as AVG_PRICE,
          ROUND(AVG("ClosePrice"), 0) as AVG_CLOSE
        FROM "PREMIUMMULTICLASS"."${PT}"
        WHERE "OriginalOnMarket" IS NOT NULL
        GROUP BY YEAR("OriginalOnMarket")
        ORDER BY YR
      `);
      yearDist.forEach(r => console.log(`  ${r.YR}: ${r.CNT} listings, avg list $${r.AVG_PRICE?.toLocaleString()}, avg close $${r.AVG_CLOSE?.toLocaleString()}`));
    } catch(e) {
      // Try uppercase
      const yearDist = await run(`
        SELECT 
          YEAR("ORIGINALONMARKET") as YR,
          COUNT(*) as CNT,
          ROUND(AVG("LISTPRICE"), 0) as AVG_PRICE
        FROM "PREMIUMMULTICLASS"."${PT}"
        WHERE "ORIGINALONMARKET" IS NOT NULL
        GROUP BY YEAR("ORIGINALONMARKET")
        ORDER BY YR
      `);
      yearDist.forEach(r => console.log(`  ${r.YR}: ${r.CNT} listings, avg list $${r.AVG_PRICE?.toLocaleString()}`));
    }

    console.log('\n=== PROPERTIES WITH MULTIPLE LISTINGS ===');
    try {
      const repeats = await run(`
        SELECT 
          "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode",
          COUNT(*) as CNT,
          MIN("ListPrice") as MIN_PRICE, MAX("ListPrice") as MAX_PRICE,
          MIN("OriginalOnMarket") as FIRST, MAX("OriginalOnMarket") as LAST,
          LISTAGG(DISTINCT "StandardStatus", ', ') as STATUSES
        FROM "PREMIUMMULTICLASS"."${PT}"
        WHERE "StreetNumber" IS NOT NULL
        GROUP BY "StreetNumber", "StreetName", "City", "StateOrProvince", "PostalCode"
        HAVING COUNT(*) > 1
        ORDER BY (MAX("ListPrice") - MIN("ListPrice")) DESC
        LIMIT 15
      `);
      console.log(`Found ${repeats.length} with multiple listings:`);
      repeats.forEach(r => {
        const pctChange = r.MIN_PRICE > 0 ? ((r.MAX_PRICE - r.MIN_PRICE) / r.MIN_PRICE * 100).toFixed(1) : '?';
        console.log(`  ${r.StreetNumber} ${r.StreetName}, ${r.City} ${r.StateOrProvince}: ${r.CNT}x | $${r.MIN_PRICE?.toLocaleString()} → $${r.MAX_PRICE?.toLocaleString()} (${pctChange}%) | ${r.FIRST} to ${r.LAST} | [${r.STATUSES}]`);
      });
    } catch(e) { console.log('Multi-listing Error:', e.message.substring(0, 200)); }

    console.log('\n=== RENOVATION-SIGNAL COLUMNS ===');
    try {
      const cols = await run(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = '${PT}'
        AND (COLUMN_NAME ILIKE '%renov%' OR COLUMN_NAME ILIKE '%remodel%'
             OR COLUMN_NAME ILIKE '%condition%' OR COLUMN_NAME ILIKE '%year%'
             OR COLUMN_NAME ILIKE '%updated%' OR COLUMN_NAME ILIKE '%improve%')
        ORDER BY COLUMN_NAME
      `);
      cols.forEach(c => console.log(`  ${c.COLUMN_NAME}`));
    } catch(e) { console.log('Error:', e.message); }

    console.log('\n=== PARCEL/APN COLUMNS ===');
    try {
      const cols = await run(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = '${PT}'
        AND (COLUMN_NAME ILIKE '%parcel%' OR COLUMN_NAME ILIKE '%apn%'
             OR COLUMN_NAME ILIKE '%tax%id%' OR COLUMN_NAME ILIKE '%fips%')
        ORDER BY COLUMN_NAME
      `);
      cols.forEach(c => console.log(`  ${c.COLUMN_NAME}`));
    } catch(e) { console.log('Error:', e.message); }
  }

  if (historyTable) {
    const HT = historyTable.name;
    console.log(`\n=== BUSINESSHISTORY TABLE: "${HT}" ===`);
    try {
      const stats = await run(`
        SELECT 
          COUNT(*) as TOTAL,
          COUNT(DISTINCT "ListingKey") as UNIQUE_LISTINGS,
          MIN("EffectiveTimestamp") as EARLIEST,
          MAX("EffectiveTimestamp") as LATEST
        FROM "PREMIUMMULTICLASS"."${HT}"
      `);
      console.log(JSON.stringify(stats[0], null, 2));
    } catch(e) {
      // uppercase
      const stats = await run(`SELECT COUNT(*) as TOTAL FROM "PREMIUMMULTICLASS"."${HT}"`);
      console.log('Count:', stats[0].TOTAL);
    }

    console.log('\nSample BusinessHistory rows:');
    try {
      const sample = await run(`SELECT * FROM "PREMIUMMULTICLASS"."${HT}" LIMIT 10`);
      sample.forEach((row, i) => {
        const vals = Object.entries(row).filter(([,v]) => v != null).map(([k,v]) => `${k}=${v}`).join(' | ');
        console.log(`  ${i+1}: ${vals}`);
      });
    } catch(e) { console.log('Error:', e.message.substring(0, 200)); }
  }

  if (mediaTable) {
    const MT = mediaTable.name;
    console.log(`\n=== MEDIA TABLE: "${MT}" ===`);
    try {
      const stats = await run(`
        SELECT COUNT(*) as TOTAL, COUNT(DISTINCT "ListingKey") as UNIQUE_LISTINGS
        FROM "PREMIUMMULTICLASS"."${MT}"
      `);
      console.log(JSON.stringify(stats[0], null, 2));
    } catch(e) {
      const stats = await run(`SELECT COUNT(*) as TOTAL FROM "PREMIUMMULTICLASS"."${MT}"`);
      console.log('Count:', stats[0].TOTAL);
    }

    console.log('\nMedia columns:');
    try {
      const cols = await run(`
        SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = '${MT}'
        ORDER BY ORDINAL_POSITION
      `);
      cols.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
    } catch(e) { console.log('Error:', e.message); }

    console.log('\nSample media row:');
    try {
      const sample = await run(`SELECT * FROM "PREMIUMMULTICLASS"."${MT}" LIMIT 3`);
      sample.forEach((row, i) => {
        console.log(`  --- Media ${i+1} ---`);
        for (const [k, v] of Object.entries(row)) {
          if (v != null && v !== '') console.log(`    ${k}: ${String(v).substring(0, 150)}`);
        }
      });
    } catch(e) { console.log('Error:', e.message.substring(0, 200)); }
  }

  conn.destroy(() => process.exit(0));
}

discover().catch(e => { console.error(e); process.exit(1); });
