import sfModule from './snowflake.js';

async function run() {
  const conn = await sfModule.connect();
  const q = (sql) => new Promise((r, j) => conn.execute({ sqlText: sql, complete: (e, s, rows) => e ? j(e) : r(rows) }));

  // Find on-market date columns
  const dateCols = await q(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='PREMIUMMULTICLASS' AND TABLE_NAME='Property' AND COLUMN_NAME ILIKE '%onmarket%' ORDER BY COLUMN_NAME`);
  console.log("OnMarket columns:", dateCols.map(c => c.COLUMN_NAME));

  // Date range
  const range = await q(`SELECT COUNT(*) as T, MIN("ONMARKETDATE") as EARLIEST, MAX("ONMARKETDATE") as LATEST, MIN("CLOSEDATE") as EC, MAX("CLOSEDATE") as LC, MIN("LISTINGCONTRACTDATE") as ELCD, MAX("LISTINGCONTRACTDATE") as LLCD FROM "PREMIUMMULTICLASS"."Property"`);
  console.log("Date range:", JSON.stringify(range[0], null, 2));

  // Year distribution
  const years = await q(`SELECT YEAR("ONMARKETDATE") as Y, COUNT(*) as C, ROUND(AVG("LISTPRICE"),0) as A, ROUND(AVG("CLOSEPRICE"),0) as AC FROM "PREMIUMMULTICLASS"."Property" WHERE "ONMARKETDATE" IS NOT NULL GROUP BY Y ORDER BY Y`);
  console.log("\nYear distribution:");
  years.forEach(r => console.log(`  ${r.Y}: ${r.C} listings, avg list $${(r.A||0).toLocaleString()}, avg close $${r.AC ? r.AC.toLocaleString() : 'N/A'}`));

  // Multi-listing addresses with biggest price jumps
  const multi = await q(`
    SELECT "PARCELNUMBER", "STREETNUMBER", "STREETNAME", "CITY", "STATEORPROVINCE", 
      COUNT(*) as C, MIN("LISTPRICE") as MN, MAX("LISTPRICE") as MX,
      MIN("ONMARKETDATE") as F, MAX("ONMARKETDATE") as L,
      LISTAGG(DISTINCT "STANDARDSTATUS", ', ') as S
    FROM "PREMIUMMULTICLASS"."Property" 
    WHERE "STREETNUMBER" IS NOT NULL 
    GROUP BY "PARCELNUMBER","STREETNUMBER","STREETNAME","CITY","STATEORPROVINCE"
    HAVING COUNT(*) > 1
    ORDER BY (MAX("LISTPRICE") - MIN("LISTPRICE")) DESC
    LIMIT 15
  `);
  console.log("\nMulti-listing properties (biggest price jumps):");
  multi.forEach(r => {
    const pct = r.MN > 0 ? ((r.MX - r.MN) / r.MN * 100).toFixed(1) : '?';
    console.log(`  ${r.STREETNUMBER} ${r.STREETNAME}, ${r.CITY} ${r.STATEORPROVINCE}: ${r.C}x | $${r.MN?.toLocaleString()} -> $${r.MX?.toLocaleString()} (+${pct}%) | ${r.F} to ${r.L} | APN:${r.PARCELNUMBER} [${r.S}]`);
  });

  // How many unique addresses have multiple listings?
  const multiCount = await q(`
    SELECT COUNT(*) as TOTAL_MULTI_LISTING_ADDRESSES FROM (
      SELECT "STREETNUMBER", "STREETNAME", "CITY", "STATEORPROVINCE"
      FROM "PREMIUMMULTICLASS"."Property"
      WHERE "STREETNUMBER" IS NOT NULL
      GROUP BY "STREETNUMBER", "STREETNAME", "CITY", "STATEORPROVINCE"
      HAVING COUNT(*) > 1
    )
  `);
  console.log("\nTotal addresses with multiple listings:", multiCount[0].TOTAL_MULTI_LISTING_ADDRESSES);

  // Check how media links to listings - can we get images for old vs new?
  const mediaPerListing = await q(`
    SELECT p."LISTINGKEY", p."STREETNUMBER", p."STREETNAME", p."CITY",
      p."ONMARKETDATE", p."LISTPRICE", p."STANDARDSTATUS",
      COUNT(m."MEDIAKEY") as IMG_COUNT
    FROM "PREMIUMMULTICLASS"."Property" p
    LEFT JOIN "PREMIUMMULTICLASS"."Media" m ON p."LISTINGKEY" = m."LISTINGKEY"
    WHERE p."STREETNUMBER" IS NOT NULL
    GROUP BY p."LISTINGKEY", p."STREETNUMBER", p."STREETNAME", p."CITY",
      p."ONMARKETDATE", p."LISTPRICE", p."STANDARDSTATUS"
    ORDER BY p."ONMARKETDATE" ASC
    LIMIT 10
  `);
  console.log("\nOldest listings with image counts:");
  mediaPerListing.forEach(r => console.log(`  ${r.ONMARKETDATE} | ${r.STREETNUMBER} ${r.STREETNAME}, ${r.CITY} | $${r.LISTPRICE?.toLocaleString()} | ${r.STANDARDSTATUS} | ${r.IMG_COUNT} images`));

  conn.destroy(() => process.exit(0));
}
run().catch(e => { console.error(e); process.exit(1); });
