/**
 * Discover historical listing data available in MultiClass dataset
 * Focus: prices, images, listing metrics over time per property
 */
import sfModule from './snowflake.js';

async function discover() {
  const conn = await sfModule.connect();
  const run = (sql) => new Promise((resolve, reject) => {
    conn.execute({ sqlText: sql, complete: (err, stmt, rows) => err ? reject(err) : resolve(rows) });
  });

  console.log('\n=== 1. BUSINESSHISTORY TABLE — ALL COLUMNS ===');
  try {
    const cols = await run(`DESCRIBE TABLE "PROPERTY_LISTING_HISTORY"."BUSINESSHISTORY"`);
    console.log(`BusinessHistory has ${cols.length} columns:`);
    cols.forEach(c => console.log(`  ${c.name} (${c.type})`));
  } catch (e) {
    console.log('BusinessHistory not found at that path, trying alternatives...');
    // Try to find it
    const tables = await run(`SHOW TABLES LIKE '%HISTORY%'`);
    console.log('History-related tables:', tables.map(t => t.name));
    
    if (tables.length > 0) {
      for (const t of tables) {
        const cols = await run(`DESCRIBE TABLE "${t.schema_name}"."${t.name}"`);
        console.log(`\n${t.name} (${cols.length} columns):`);
        cols.forEach(c => console.log(`  ${c.name} (${c.type})`));
      }
    }
  }

  console.log('\n=== 2. BUSINESSHISTORY SAMPLE DATA ===');
  try {
    const sample = await run(`SELECT * FROM "PREMIUMMULTICLASS"."BUSINESSHISTORY" LIMIT 5`);
    if (sample.length > 0) {
      console.log('Sample row keys:', Object.keys(sample[0]));
      sample.forEach((row, i) => {
        console.log(`\n--- Row ${i + 1} ---`);
        for (const [k, v] of Object.entries(row)) {
          if (v != null && v !== '') console.log(`  ${k}: ${v}`);
        }
      });
    }
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 3. DATE RANGE OF LISTINGS ===');
  try {
    const dateRange = await run(`
      SELECT 
        MIN("ORIGINALONMARKET") as EARLIEST_ONMARKET,
        MAX("ORIGINALONMARKET") as LATEST_ONMARKET,
        MIN("LISTINGCONTRACTDATE") as EARLIEST_CONTRACT,
        MAX("LISTINGCONTRACTDATE") as LATEST_CONTRACT,
        MIN("CLOSEDATE") as EARLIEST_CLOSE,
        MAX("CLOSEDATE") as LATEST_CLOSE,
        MIN("MODIFICATIONTIMESTAMP") as EARLIEST_MOD,
        MAX("MODIFICATIONTIMESTAMP") as LATEST_MOD,
        MIN("ORIGINALISTPRICE") as MIN_ORIG_PRICE,
        MAX("ORIGINALISTPRICE") as MAX_ORIG_PRICE,
        COUNT(*) as TOTAL_ROWS
      FROM "PREMIUMMULTICLASS"."PROPERTY"
    `);
    console.log('Date ranges:', JSON.stringify(dateRange[0], null, 2));
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 4. PRICE-RELATED COLUMNS ON PROPERTY TABLE ===');
  try {
    const priceCols = await run(`
      SELECT COLUMN_NAME, DATA_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' 
        AND TABLE_NAME = 'PROPERTY'
        AND (COLUMN_NAME LIKE '%PRICE%' OR COLUMN_NAME LIKE '%CLOSE%' OR COLUMN_NAME LIKE '%LIST%DATE%' 
             OR COLUMN_NAME LIKE '%ORIGINAL%' OR COLUMN_NAME LIKE '%PENDING%' OR COLUMN_NAME LIKE '%STATUS%'
             OR COLUMN_NAME LIKE '%MARKET%' OR COLUMN_NAME LIKE '%SOLD%' OR COLUMN_NAME LIKE '%CHANGE%')
      ORDER BY COLUMN_NAME
    `);
    console.log(`Found ${priceCols.length} price/date/status columns:`);
    priceCols.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 5. MEDIA TABLE — CHECK FOR HISTORICAL IMAGES ===');
  try {
    const mediaCols = await run(`
      SELECT COLUMN_NAME, DATA_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' 
        AND TABLE_NAME = 'MEDIA'
      ORDER BY COLUMN_NAME
    `);
    console.log(`Media table has ${mediaCols.length} columns:`);
    mediaCols.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 6. MEDIA SAMPLE — date/timestamp fields ===');
  try {
    const mediaSample = await run(`
      SELECT * FROM "PREMIUMMULTICLASS"."MEDIA" LIMIT 3
    `);
    if (mediaSample.length > 0) {
      mediaSample.forEach((row, i) => {
        console.log(`\n--- Media Row ${i + 1} ---`);
        for (const [k, v] of Object.entries(row)) {
          if (v != null && v !== '') console.log(`  ${k}: ${String(v).substring(0, 200)}`);
        }
      });
    }
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 7. PROPERTIES WITH MULTIPLE LISTINGS (renovation signal) ===');
  try {
    // Find properties at same address with multiple listing records
    const repeats = await run(`
      SELECT 
        "STREETNUMBER", "STREETNAME", "CITY", "STATEORPROVINCE", "POSTALCODE",
        COUNT(*) as LISTING_COUNT,
        MIN("LISTPRICE") as MIN_PRICE,
        MAX("LISTPRICE") as MAX_PRICE,
        MIN("ORIGINALONMARKET") as FIRST_LISTED,
        MAX("ORIGINALONMARKET") as LAST_LISTED,
        LISTAGG(DISTINCT "STANDARDSTATUS", ', ') as STATUSES,
        LISTAGG(DISTINCT "PROPERTYTYPE", ', ') as TYPES
      FROM "PREMIUMMULTICLASS"."PROPERTY"
      WHERE "STREETNUMBER" IS NOT NULL AND "STREETNAME" IS NOT NULL
      GROUP BY "STREETNUMBER", "STREETNAME", "CITY", "STATEORPROVINCE", "POSTALCODE"
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `);
    console.log(`Properties with multiple listings: ${repeats.length} found`);
    repeats.forEach(r => {
      console.log(`  ${r.STREETNUMBER} ${r.STREETNAME}, ${r.CITY} ${r.STATEORPROVINCE} ${r.POSTALCODE}: ${r.LISTING_COUNT} listings, $${r.MIN_PRICE?.toLocaleString()} - $${r.MAX_PRICE?.toLocaleString()}, ${r.FIRST_LISTED} to ${r.LAST_LISTED} [${r.STATUSES}]`);
    });
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 8. BUSINESSHISTORY DATE RANGE & COUNTS ===');
  try {
    const bhStats = await run(`
      SELECT 
        COUNT(*) as TOTAL_RECORDS,
        COUNT(DISTINCT "LISTINGKEY") as DISTINCT_LISTINGS,
        MIN("MODIFICATIONTIMESTAMP") as EARLIEST,
        MAX("MODIFICATIONTIMESTAMP") as LATEST
      FROM "PREMIUMMULTICLASS"."BUSINESSHISTORY"
    `);
    console.log('BusinessHistory stats:', JSON.stringify(bhStats[0], null, 2));
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 9. LISTING YEAR DISTRIBUTION ===');
  try {
    const yearDist = await run(`
      SELECT 
        YEAR("ORIGINALONMARKET") as LISTING_YEAR,
        COUNT(*) as COUNT,
        AVG("LISTPRICE") as AVG_PRICE,
        MIN("LISTPRICE") as MIN_PRICE,
        MAX("LISTPRICE") as MAX_PRICE
      FROM "PREMIUMMULTICLASS"."PROPERTY"
      WHERE "ORIGINALONMARKET" IS NOT NULL
      GROUP BY YEAR("ORIGINALONMARKET")
      ORDER BY LISTING_YEAR
    `);
    console.log('Listing distribution by year:');
    yearDist.forEach(r => console.log(`  ${r.LISTING_YEAR}: ${r.COUNT} listings, avg $${Math.round(r.AVG_PRICE).toLocaleString()}`));
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 10. MEDIA COUNT BY LISTING — any with lots of images? ===');
  try {
    const imgStats = await run(`
      SELECT 
        COUNT(*) as TOTAL_MEDIA,
        COUNT(DISTINCT "LISTINGKEY") as LISTINGS_WITH_MEDIA,
        MIN("MODIFICATIONTIMESTAMP") as EARLIEST_MEDIA,
        MAX("MODIFICATIONTIMESTAMP") as LATEST_MEDIA
      FROM "PREMIUMMULTICLASS"."MEDIA"
    `);
    console.log('Media stats:', JSON.stringify(imgStats[0], null, 2));
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 11. KEY RENOVATION-SIGNAL COLUMNS ===');
  try {
    const renoCols = await run(`
      SELECT COLUMN_NAME, DATA_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' 
        AND TABLE_NAME = 'PROPERTY'
        AND (COLUMN_NAME LIKE '%RENOV%' OR COLUMN_NAME LIKE '%REMODEL%' OR COLUMN_NAME LIKE '%UPDATED%'
             OR COLUMN_NAME LIKE '%IMPROVE%' OR COLUMN_NAME LIKE '%FLIP%' OR COLUMN_NAME LIKE '%REHAB%'
             OR COLUMN_NAME LIKE '%CONDITION%' OR COLUMN_NAME LIKE '%YEAR%')
      ORDER BY COLUMN_NAME
    `);
    console.log(`Renovation-signal columns: ${renoCols.length}`);
    renoCols.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  } catch (e) { console.log('Error:', e.message); }

  console.log('\n=== 12. CHECK FOR PARCEL/APN FOR ADDRESS MATCHING ===');
  try {
    const parcelCols = await run(`
      SELECT COLUMN_NAME, DATA_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'PREMIUMMULTICLASS' 
        AND TABLE_NAME = 'PROPERTY'
        AND (COLUMN_NAME LIKE '%PARCEL%' OR COLUMN_NAME LIKE '%APN%' OR COLUMN_NAME LIKE '%TAX%ID%'
             OR COLUMN_NAME LIKE '%FIPS%')
      ORDER BY COLUMN_NAME
    `);
    console.log(`Parcel/APN columns: ${parcelCols.length}`);
    parcelCols.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  } catch (e) { console.log('Error:', e.message); }

  // Disconnect
  conn.destroy((err) => process.exit(0));
}

discover().catch(e => { console.error(e); process.exit(1); });
