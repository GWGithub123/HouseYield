/**
 * Final discovery: exact column names + historical data
 */
import sfModule from './snowflake.js';

async function discover() {
  const conn = await sfModule.connect();
  const run = (sql) => new Promise((resolve, reject) => {
    conn.execute({ sqlText: sql, complete: (err, stmt, rows) => err ? reject(err) : resolve(rows) });
  });

  // Get exact column names for key columns
  console.log('\n=== PRICE/DATE/STATUS COLUMNS (exact names) ===');
  const cols = await run(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = 'Property'
    AND (COLUMN_NAME ILIKE '%price%' OR COLUMN_NAME ILIKE '%close%' 
         OR COLUMN_NAME ILIKE '%original%' OR COLUMN_NAME ILIKE '%list%date%'
         OR COLUMN_NAME ILIKE '%market%' OR COLUMN_NAME ILIKE '%status%'
         OR COLUMN_NAME ILIKE '%modification%' OR COLUMN_NAME ILIKE '%pending%'
         OR COLUMN_NAME ILIKE '%contract%' OR COLUMN_NAME ILIKE '%sold%'
         OR COLUMN_NAME ILIKE '%timestamp%' OR COLUMN_NAME ILIKE '%dayson%')
    ORDER BY COLUMN_NAME
  `);
  cols.forEach(c => console.log(`  "${c.COLUMN_NAME}" (${c.DATA_TYPE})`));

  // Renovation signal columns
  console.log('\n=== RENOVATION/CONDITION/YEAR COLUMNS ===');
  const renoCols = await run(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = 'Property'
    AND (COLUMN_NAME ILIKE '%renov%' OR COLUMN_NAME ILIKE '%remodel%'
         OR COLUMN_NAME ILIKE '%condition%' OR COLUMN_NAME ILIKE '%year%'
         OR COLUMN_NAME ILIKE '%updated%' OR COLUMN_NAME ILIKE '%improve%')
    ORDER BY COLUMN_NAME
  `);
  renoCols.forEach(c => console.log(`  "${c.COLUMN_NAME}" (${c.DATA_TYPE})`));

  // Parcel/address matching columns
  console.log('\n=== PARCEL/APN/FIPS COLUMNS ===');
  const parcelCols = await run(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = 'Property'
    AND (COLUMN_NAME ILIKE '%parcel%' OR COLUMN_NAME ILIKE '%apn%'
         OR COLUMN_NAME ILIKE '%tax%id%' OR COLUMN_NAME ILIKE '%fips%')
    ORDER BY COLUMN_NAME
  `);
  parcelCols.forEach(c => console.log(`  "${c.COLUMN_NAME}" (${c.DATA_TYPE})`));

  // Image/photo columns
  console.log('\n=== IMAGE/PHOTO COLUMNS ===');
  const imgCols = await run(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = 'Property'
    AND (COLUMN_NAME ILIKE '%photo%' OR COLUMN_NAME ILIKE '%image%'
         OR COLUMN_NAME ILIKE '%media%' OR COLUMN_NAME ILIKE '%picture%'
         OR COLUMN_NAME ILIKE '%virtual%')
    ORDER BY COLUMN_NAME
  `);
  imgCols.forEach(c => console.log(`  "${c.COLUMN_NAME}" (${c.DATA_TYPE})`));

  // Now use the exact column names from above
  const dateCol = cols.find(c => c.COLUMN_NAME.toLowerCase().includes('originalonmarket'))?.COLUMN_NAME;
  const closeCol = cols.find(c => c.COLUMN_NAME.toLowerCase() === 'closedate')?.COLUMN_NAME;
  const modCol = cols.find(c => c.COLUMN_NAME.toLowerCase() === 'modificationtimestamp')?.COLUMN_NAME;
  const listPriceCol = cols.find(c => c.COLUMN_NAME.toLowerCase() === 'listprice')?.COLUMN_NAME;
  const closePriceCol = cols.find(c => c.COLUMN_NAME.toLowerCase() === 'closeprice')?.COLUMN_NAME;
  const statusCol = cols.find(c => c.COLUMN_NAME.toLowerCase() === 'standardstatus')?.COLUMN_NAME;

  console.log(`\nResolved columns: date="${dateCol}", close="${closeCol}", mod="${modCol}", listPrice="${listPriceCol}", closePrice="${closePriceCol}", status="${statusCol}"`);

  if (dateCol && listPriceCol) {
    console.log('\n=== DATE RANGE ===');
    const range = await run(`
      SELECT 
        COUNT(*) as TOTAL,
        MIN("${dateCol}") as EARLIEST,
        MAX("${dateCol}") as LATEST,
        MIN("${closeCol}") as EARLIEST_CLOSE,
        MAX("${closeCol}") as LATEST_CLOSE,
        MIN("${modCol}") as EARLIEST_MOD,
        MAX("${modCol}") as LATEST_MOD
      FROM "PREMIUMMULTICLASS"."Property"
    `);
    console.log(JSON.stringify(range[0], null, 2));

    console.log('\n=== YEAR DISTRIBUTION ===');
    const yearDist = await run(`
      SELECT 
        YEAR("${dateCol}") as YR,
        COUNT(*) as CNT,
        ROUND(AVG("${listPriceCol}"), 0) as AVG_LIST,
        ROUND(AVG("${closePriceCol}"), 0) as AVG_CLOSE
      FROM "PREMIUMMULTICLASS"."Property"
      WHERE "${dateCol}" IS NOT NULL
      GROUP BY YEAR("${dateCol}")
      ORDER BY YR
    `);
    yearDist.forEach(r => console.log(`  ${r.YR}: ${r.CNT} listings, avg list $${r.AVG_LIST?.toLocaleString()}, avg close $${r.AVG_CLOSE?.toLocaleString()}`));

    console.log('\n=== PROPERTIES WITH MULTIPLE LISTINGS (biggest price changes) ===');
    const streetCol = cols.length > 0 ? 'StreetNumber' : 'STREETNUMBER'; // guess
    // Use info schema to find exact street column names
    const addrCols = await run(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = 'Property'
      AND (COLUMN_NAME ILIKE 'streetnumber' OR COLUMN_NAME ILIKE 'streetname' 
           OR COLUMN_NAME ILIKE 'city' OR COLUMN_NAME ILIKE 'stateorprovince' 
           OR COLUMN_NAME ILIKE 'postalcode')
      ORDER BY COLUMN_NAME
    `);
    console.log('Address columns:', addrCols.map(c => c.COLUMN_NAME).join(', '));

    const sn = addrCols.find(c => c.COLUMN_NAME.toLowerCase() === 'streetnumber')?.COLUMN_NAME;
    const st = addrCols.find(c => c.COLUMN_NAME.toLowerCase() === 'streetname')?.COLUMN_NAME;
    const ci = addrCols.find(c => c.COLUMN_NAME.toLowerCase() === 'city')?.COLUMN_NAME;
    const sp = addrCols.find(c => c.COLUMN_NAME.toLowerCase() === 'stateorprovince')?.COLUMN_NAME;
    const pc = addrCols.find(c => c.COLUMN_NAME.toLowerCase() === 'postalcode')?.COLUMN_NAME;

    if (sn && st) {
      const repeats = await run(`
        SELECT 
          "${sn}", "${st}", "${ci}", "${sp}", "${pc}",
          COUNT(*) as CNT,
          MIN("${listPriceCol}") as MIN_PRICE, MAX("${listPriceCol}") as MAX_PRICE,
          MIN("${closePriceCol}") as MIN_CLOSE, MAX("${closePriceCol}") as MAX_CLOSE,
          MIN("${dateCol}") as FIRST_LISTED, MAX("${dateCol}") as LAST_LISTED,
          LISTAGG(DISTINCT "${statusCol}", ', ') as STATUSES
        FROM "PREMIUMMULTICLASS"."Property"
        WHERE "${sn}" IS NOT NULL
        GROUP BY "${sn}", "${st}", "${ci}", "${sp}", "${pc}"
        HAVING COUNT(*) > 1
        ORDER BY (MAX("${listPriceCol}") - MIN("${listPriceCol}")) DESC
        LIMIT 15
      `);
      console.log(`\nFound ${repeats.length} properties with multiple listings:`);
      repeats.forEach(r => {
        const pctChange = r.MIN_PRICE > 0 ? ((r.MAX_PRICE - r.MIN_PRICE) / r.MIN_PRICE * 100).toFixed(1) : '?';
        console.log(`  ${r[sn]} ${r[st]}, ${r[ci]} ${r[sp]}: ${r.CNT}x | $${r.MIN_PRICE?.toLocaleString()} → $${r.MAX_PRICE?.toLocaleString()} (+${pctChange}%) | ${r.FIRST_LISTED} to ${r.LAST_LISTED} | [${r.STATUSES}]`);
      });
    }
  }

  // BusinessHistory details
  console.log('\n=== BUSINESSHISTORY COLUMNS (exact) ===');
  const bhCols = await run(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = 'BusinessHistory'
    ORDER BY ORDINAL_POSITION
  `);
  bhCols.forEach(c => console.log(`  "${c.COLUMN_NAME}" (${c.DATA_TYPE})`));

  console.log('\n=== BUSINESSHISTORY STATS ===');
  const bhListingKey = bhCols.find(c => c.COLUMN_NAME.toLowerCase() === 'listingkey')?.COLUMN_NAME;
  const bhTimestamp = bhCols.find(c => c.COLUMN_NAME.toLowerCase().includes('effective'))?.COLUMN_NAME;
  const bhPrice = bhCols.find(c => c.COLUMN_NAME.toLowerCase() === 'price')?.COLUMN_NAME;
  const bhStatus = bhCols.find(c => c.COLUMN_NAME.toLowerCase() === 'status')?.COLUMN_NAME;

  if (bhListingKey) {
    const bhStats = await run(`
      SELECT 
        COUNT(*) as TOTAL,
        COUNT(DISTINCT "${bhListingKey}") as UNIQUE_LISTINGS,
        MIN("${bhTimestamp}") as EARLIEST,
        MAX("${bhTimestamp}") as LATEST
      FROM "PREMIUMMULTICLASS"."BusinessHistory"
    `);
    console.log(JSON.stringify(bhStats[0], null, 2));

    console.log('\nSample BusinessHistory:');
    const bhSample = await run(`SELECT * FROM "PREMIUMMULTICLASS"."BusinessHistory" LIMIT 10`);
    bhSample.forEach((row, i) => {
      const vals = Object.entries(row).filter(([,v]) => v != null).map(([k,v]) => `${k}=${v}`).join(' | ');
      console.log(`  ${i+1}: ${vals}`);
    });

    // Show a property with lots of history
    console.log('\n=== PROPERTIES WITH MOST HISTORY ENTRIES ===');
    const topHistory = await run(`
      SELECT "${bhListingKey}", COUNT(*) as CNT
      FROM "PREMIUMMULTICLASS"."BusinessHistory"
      GROUP BY "${bhListingKey}"
      ORDER BY CNT DESC
      LIMIT 5
    `);
    for (const th of topHistory) {
      console.log(`\nListing ${th[bhListingKey]} (${th.CNT} history entries):`);
      const entries = await run(`
        SELECT * FROM "PREMIUMMULTICLASS"."BusinessHistory"
        WHERE "${bhListingKey}" = '${th[bhListingKey]}'
        ORDER BY "${bhTimestamp}"
      `);
      entries.forEach(e => {
        const vals = Object.entries(e).filter(([,v]) => v != null).map(([k,v]) => `${k}=${v}`).join(' | ');
        console.log(`    ${vals}`);
      });
    }
  }

  // Media table
  console.log('\n=== MEDIA TABLE COLUMNS ===');
  const mediaCols = await run(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' AND TABLE_NAME = 'Media'
    ORDER BY ORDINAL_POSITION
  `);
  mediaCols.forEach(c => console.log(`  "${c.COLUMN_NAME}" (${c.DATA_TYPE})`));

  console.log('\n=== MEDIA STATS ===');
  const mListingKey = mediaCols.find(c => c.COLUMN_NAME.toLowerCase() === 'listingkey')?.COLUMN_NAME;
  if (mListingKey) {
    const mStats = await run(`
      SELECT 
        COUNT(*) as TOTAL,
        COUNT(DISTINCT "${mListingKey}") as UNIQUE_LISTINGS
      FROM "PREMIUMMULTICLASS"."Media"
    `);
    console.log(JSON.stringify(mStats[0], null, 2));

    console.log('\nSample Media row:');
    const mSample = await run(`SELECT * FROM "PREMIUMMULTICLASS"."Media" LIMIT 2`);
    mSample.forEach((row, i) => {
      console.log(`  --- Media ${i+1} ---`);
      for (const [k, v] of Object.entries(row)) {
        if (v != null && v !== '') console.log(`    ${k}: ${String(v).substring(0, 200)}`);
      }
    });
  }

  conn.destroy(() => process.exit(0));
}

discover().catch(e => { console.error(e); process.exit(1); });
