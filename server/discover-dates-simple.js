import sfModule from './snowflake.js';

async function run() {
  const conn = await sfModule.connect();
  const q = (sql) => new Promise((r, j) => {
    conn.execute({ sqlText: sql, complete: (e, s, rows) => e ? j(e) : r(rows) });
  });

  console.log('1. Date range...');
  const range = await q(`SELECT COUNT(*) as T, MIN("ONMARKETDATE") as E, MAX("ONMARKETDATE") as L FROM "PREMIUMMULTICLASS"."Property"`);
  console.log(JSON.stringify(range[0]));

  console.log('2. Close date range...');
  const cr = await q(`SELECT MIN("CLOSEDATE") as E, MAX("CLOSEDATE") as L FROM "PREMIUMMULTICLASS"."Property" WHERE "CLOSEDATE" IS NOT NULL`);
  console.log(JSON.stringify(cr[0]));

  console.log('3. Year dist...');
  const years = await q(`SELECT YEAR("ONMARKETDATE") as Y, COUNT(*) as C, ROUND(AVG("LISTPRICE"),0) as A FROM "PREMIUMMULTICLASS"."Property" WHERE "ONMARKETDATE" IS NOT NULL GROUP BY YEAR("ONMARKETDATE") ORDER BY Y`);
  years.forEach(r => console.log(`  ${r.Y}: ${r.C} listings, avg $${r.A?.toLocaleString()}`));

  console.log('4. Multi-listing count...');
  const mc = await q(`SELECT COUNT(*) as C FROM (SELECT 1 FROM "PREMIUMMULTICLASS"."Property" WHERE "STREETNUMBER" IS NOT NULL GROUP BY "STREETNUMBER","STREETNAME","CITY","STATEORPROVINCE" HAVING COUNT(*)>1)`);
  console.log('Addresses with multiple listings:', mc[0].C);

  console.log('5. Biggest price jumps...');
  const multi = await q(`SELECT "STREETNUMBER", "STREETNAME", "CITY", "STATEORPROVINCE", COUNT(*) as C, MIN("LISTPRICE") as MN, MAX("LISTPRICE") as MX, MIN("ONMARKETDATE") as F, MAX("ONMARKETDATE") as L FROM "PREMIUMMULTICLASS"."Property" WHERE "STREETNUMBER" IS NOT NULL GROUP BY "STREETNUMBER","STREETNAME","CITY","STATEORPROVINCE" HAVING COUNT(*)>1 ORDER BY (MAX("LISTPRICE")-MIN("LISTPRICE")) DESC LIMIT 10`);
  multi.forEach(r => {
    const pct = r.MN > 0 ? ((r.MX - r.MN) / r.MN * 100).toFixed(1) : '?';
    console.log(`  ${r.STREETNUMBER} ${r.STREETNAME}, ${r.CITY} ${r.STATEORPROVINCE}: ${r.C}x | $${r.MN?.toLocaleString()} -> $${r.MX?.toLocaleString()} (+${pct}%) | ${r.F} to ${r.L}`);
  });

  console.log('6. Image counts for oldest listings...');
  const old = await q(`SELECT "LISTINGKEY", "STREETNUMBER", "STREETNAME", "CITY", "ONMARKETDATE", "LISTPRICE", "STANDARDSTATUS", "PHOTOSCOUNT" FROM "PREMIUMMULTICLASS"."Property" WHERE "ONMARKETDATE" IS NOT NULL ORDER BY "ONMARKETDATE" LIMIT 10`);
  old.forEach(r => console.log(`  ${r.ONMARKETDATE} | ${r.STREETNUMBER} ${r.STREETNAME}, ${r.CITY} | $${r.LISTPRICE?.toLocaleString()} | ${r.STANDARDSTATUS} | ${r.PHOTOSCOUNT} photos`));

  console.log('DONE');
  conn.destroy(() => process.exit(0));
}
run().catch(e => { console.error(e); process.exit(1); });
