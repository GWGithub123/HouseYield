// Discover Historical Listing Data in MultiClass
// Run with: node server/discover-historical-data.js
import 'dotenv/config';
import snowflake from './snowflake.js';

async function discover() {
  console.log('🔄 Connecting to Snowflake...\n');
  const conn = await snowflake.testConnection();
  if (!conn.connected) { console.error('❌', conn.error); process.exit(1); }
  console.log(`✅ Connected\n`);

  // 1. BusinessHistory table schema
  console.log('=== BUSINESSHISTORY COLUMNS ===');
  try {
    const cols = await snowflake.describeTable('"BusinessHistory"');
    cols.forEach(c => console.log(`  ${c.name} (${c.type})`));
    console.log(`  Total: ${cols.length} columns`);
  } catch (e) { console.error('  Error:', e.message); }

  // 2. Sample BusinessHistory rows
  console.log('\n=== SAMPLE BUSINESSHISTORY ROWS ===');
  try {
    const rows = await snowflake.executeQuery('SELECT * FROM "BusinessHistory" LIMIT 5');
    rows.forEach((r, i) => { console.log(`\n  --- Row ${i+1} ---`); Object.entries(r).forEach(([k,v]) => { if (v != null) console.log(`    ${k}: ${v}`); }); });
  } catch (e) { console.error('  Error:', e.message); }

  // 3. Date range of listings
  console.log('\n=== LISTING DATE RANGES ===');
  try {
    const rows = await snowflake.executeQuery(`
      SELECT 
        MIN("ListingContractDate") AS "EarliestListing",
        MAX("ListingContractDate") AS "LatestListing",
        MIN("CloseDate") AS "EarliestClose",
        MAX("CloseDate") AS "LatestClose",
        MIN("OnMarketDate") AS "EarliestOnMarket",
        MAX("OnMarketDate") AS "LatestOnMarket",
        MIN("OriginalEntryTimestamp") AS "EarliestEntry",
        MAX("OriginalEntryTimestamp") AS "LatestEntry",
        COUNT(*) AS "TotalListings"
      FROM "Property"
    `);
    rows.forEach(r => Object.entries(r).forEach(([k,v]) => console.log(`  ${k}: ${v}`)));
  } catch (e) { console.error('  Error:', e.message); }

  // 4. Find properties that appear MULTIPLE times (re-listed)
  console.log('\n=== PROPERTIES WITH MULTIPLE LISTINGS (same address) ===');
  try {
    const rows = await snowflake.executeQuery(`
      SELECT 
        "StreetNumber", "StreetName", "StreetSuffix", "City", "StateOrProvince", "PostalCode",
        COUNT(*) AS "ListingCount",
        MIN("ListingContractDate") AS "FirstListed",
        MAX("ListingContractDate") AS "LastListed",
        MIN("ListPrice") AS "MinPrice",
        MAX("ListPrice") AS "MaxPrice",
        MIN("ClosePrice") AS "MinClose",
        MAX("ClosePrice") AS "MaxClose",
        MIN("YearBuilt") AS "YearBuilt",
        LISTAGG(DISTINCT "StandardStatus", ', ') AS "Statuses"
      FROM "Property"
      WHERE "StreetNumber" IS NOT NULL AND "StreetName" IS NOT NULL
      GROUP BY "StreetNumber", "StreetName", "StreetSuffix", "City", "StateOrProvince", "PostalCode"
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `);
    console.log(`  Found ${rows.length} addresses with multiple listings:`);
    rows.forEach((r, i) => {
      console.log(`\n  ${i+1}. ${r.StreetNumber} ${r.StreetName} ${r.StreetSuffix || ''}, ${r.City} ${r.StateOrProvince} ${r.PostalCode}`);
      console.log(`     Listings: ${r.ListingCount} | First: ${r.FirstListed} | Last: ${r.LastListed}`);
      console.log(`     Price Range: $${r.MinPrice?.toLocaleString()} – $${r.MaxPrice?.toLocaleString()}`);
      console.log(`     Close Range: $${r.MinClose?.toLocaleString()} – $${r.MaxClose?.toLocaleString()}`);
      console.log(`     Statuses: ${r.Statuses} | Built: ${r.YearBuilt}`);
    });
  } catch (e) { console.error('  Error:', e.message); }

  // 5. Check if there are parcel/tax IDs for cross-referencing
  console.log('\n=== PARCEL / TAX ID COVERAGE ===');
  try {
    const rows = await snowflake.executeQuery(`
      SELECT 
        COUNT(*) AS "Total",
        COUNT("ParcelNumber") AS "HasParcelNumber",
        COUNT("TaxParcelId") AS "HasTaxParcelId",  
        COUNT("PropertyId") AS "HasPropertyId",
        COUNT("ListingId") AS "HasListingId"
      FROM "Property"
    `);
    rows.forEach(r => Object.entries(r).forEach(([k,v]) => console.log(`  ${k}: ${v}`)));
  } catch (e) { console.error('  Error:', e.message); }

  // 6. Look at properties where price changed significantly between listings
  console.log('\n=== BIGGEST PRICE CHANGES (potential renovations) ===');
  try {
    const rows = await snowflake.executeQuery(`
      WITH addr_listings AS (
        SELECT 
          "StreetNumber" || ' ' || "StreetName" || ' ' || COALESCE("StreetSuffix",'') AS addr,
          "City", "StateOrProvince", "PostalCode",
          "ListingKey", "ListingId", "StandardStatus",
          "ListPrice", "ClosePrice", "CloseDate", "ListingContractDate",
          "YearBuilt", "BedroomsTotal", "BathroomsTotal", "LivingArea",
          "PropertyType", "PropertySubType", "PublicRemarks",
          "OriginalEntryTimestamp", "ModificationTimestamp",
          ROW_NUMBER() OVER (PARTITION BY "StreetNumber", "StreetName", COALESCE("StreetSuffix",''), "City", "PostalCode" ORDER BY "ListingContractDate" ASC NULLS LAST, "OriginalEntryTimestamp" ASC NULLS LAST) AS rn,
          COUNT(*) OVER (PARTITION BY "StreetNumber", "StreetName", COALESCE("StreetSuffix",''), "City", "PostalCode") AS listing_count
        FROM "Property"
        WHERE "StreetNumber" IS NOT NULL AND "StreetName" IS NOT NULL
      )
      SELECT 
        a.addr, a."City", a."StateOrProvince", a."PostalCode",
        a."ListPrice" AS "EarlierPrice", a."ClosePrice" AS "EarlierClose", a."CloseDate" AS "EarlierCloseDate",
        a."ListingContractDate" AS "EarlierListDate",
        a."BedroomsTotal" AS "EarlierBeds", a."BathroomsTotal" AS "EarlierBaths", a."LivingArea" AS "EarlierSqft",
        b."ListPrice" AS "LaterPrice", b."ClosePrice" AS "LaterClose", b."CloseDate" AS "LaterCloseDate",
        b."ListingContractDate" AS "LaterListDate",
        b."BedroomsTotal" AS "LaterBeds", b."BathroomsTotal" AS "LaterBaths", b."LivingArea" AS "LaterSqft",
        CASE WHEN a."ClosePrice" > 0 THEN ROUND(((COALESCE(b."ClosePrice", b."ListPrice") - a."ClosePrice") / a."ClosePrice") * 100, 1) END AS "PriceChangePercent",
        b."StandardStatus" AS "LatestStatus"
      FROM addr_listings a
      JOIN addr_listings b ON a.addr = b.addr AND a."City" = b."City" AND a."PostalCode" = b."PostalCode" AND b.rn = a.rn + 1
      WHERE a.listing_count > 1 AND a."ClosePrice" > 0
      ORDER BY "PriceChangePercent" DESC NULLS LAST
      LIMIT 15
    `);
    console.log(`  Found ${rows.length} price-change pairs:`);
    rows.forEach((r, i) => {
      console.log(`\n  ${i+1}. ${r.addr}, ${r.City} ${r.StateOrProvince} ${r.PostalCode}`);
      console.log(`     Earlier: $${r.EarlierClose?.toLocaleString()} closed ${r.EarlierCloseDate} | ${r.EarlierBeds}bd/${r.EarlierBaths}ba/${r.EarlierSqft}sqft`);
      console.log(`     Later:   $${(r.LaterClose || r.LaterPrice)?.toLocaleString()} ${r.LaterCloseDate ? 'closed ' + r.LaterCloseDate : 'listed ' + r.LaterListDate} | ${r.LaterBeds}bd/${r.LaterBaths}ba/${r.LaterSqft}sqft`);
      console.log(`     Change:  ${r.PriceChangePercent}% | Status: ${r.LatestStatus}`);
    });
  } catch (e) { console.error('  Error:', e.message); }

  // 7. Check for renovation keywords in remarks
  console.log('\n=== RENOVATION KEYWORD SEARCH IN REMARKS ===');
  try {
    const rows = await snowflake.executeQuery(`
      SELECT 
        COUNT(*) AS "Total",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%renovated%' OR LOWER("PublicRemarks") LIKE '%renovation%' THEN 1 ELSE 0 END) AS "Renovated",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%remodeled%' OR LOWER("PublicRemarks") LIKE '%remodel%' THEN 1 ELSE 0 END) AS "Remodeled",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%updated%' OR LOWER("PublicRemarks") LIKE '%updates%' THEN 1 ELSE 0 END) AS "Updated",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%new kitchen%' OR LOWER("PublicRemarks") LIKE '%kitchen remodel%' THEN 1 ELSE 0 END) AS "KitchenWork",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%new roof%' THEN 1 ELSE 0 END) AS "NewRoof",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%new bathroom%' OR LOWER("PublicRemarks") LIKE '%bath remodel%' THEN 1 ELSE 0 END) AS "BathWork",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%flip%' OR LOWER("PublicRemarks") LIKE '%flipped%' THEN 1 ELSE 0 END) AS "Flipped",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%new flooring%' OR LOWER("PublicRemarks") LIKE '%hardwood%' THEN 1 ELSE 0 END) AS "Flooring",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%new hvac%' OR LOWER("PublicRemarks") LIKE '%new furnace%' OR LOWER("PublicRemarks") LIKE '%new ac%' THEN 1 ELSE 0 END) AS "HVAC",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%new windows%' THEN 1 ELSE 0 END) AS "NewWindows",
        SUM(CASE WHEN LOWER("PublicRemarks") LIKE '%addition%' OR LOWER("PublicRemarks") LIKE '%added%' THEN 1 ELSE 0 END) AS "Addition"
      FROM "Property"
    `);
    rows.forEach(r => Object.entries(r).forEach(([k,v]) => console.log(`  ${k}: ${v}`)));
  } catch (e) { console.error('  Error:', e.message); }

  // 8. Check date distribution by year
  console.log('\n=== LISTINGS BY YEAR ===');
  try {
    const rows = await snowflake.executeQuery(`
      SELECT 
        YEAR("ListingContractDate") AS "Year",
        COUNT(*) AS "Listings",
        SUM(CASE WHEN "StandardStatus" = 'Closed' THEN 1 ELSE 0 END) AS "Closed",
        ROUND(AVG("ListPrice"), 0) AS "AvgListPrice",
        ROUND(AVG("ClosePrice"), 0) AS "AvgClosePrice"
      FROM "Property"
      WHERE "ListingContractDate" IS NOT NULL
      GROUP BY YEAR("ListingContractDate")
      ORDER BY "Year"
    `);
    rows.forEach(r => console.log(`  ${r.Year}: ${r.Listings} listings, ${r.Closed} closed, avg list $${r.AvgListPrice?.toLocaleString()}, avg close $${r.AvgClosePrice?.toLocaleString()}`));
  } catch (e) { console.error('  Error:', e.message); }

  // 9. Check for property condition / new construction flags
  console.log('\n=== PROPERTY CONDITION VALUES ===');
  try {
    const rows = await snowflake.executeQuery(`SELECT "PropertyCondition", COUNT(*) AS cnt FROM "Property" WHERE "PropertyCondition" IS NOT NULL GROUP BY "PropertyCondition" ORDER BY cnt DESC LIMIT 20`);
    rows.forEach(r => console.log(`  ${r.PropertyCondition}: ${r.cnt}`));
  } catch (e) { console.error('  Error:', e.message); }

  // 10. Check LivingArea changes for same address (sqft additions = renovations)
  console.log('\n=== SQ FT CHANGES AT SAME ADDRESS ===');
  try {
    const rows = await snowflake.executeQuery(`
      WITH addr AS (
        SELECT 
          "StreetNumber" || ' ' || "StreetName" || ' ' || COALESCE("StreetSuffix",'') || ', ' || "City" AS addr,
          "PostalCode", "LivingArea", "BedroomsTotal", "BathroomsTotal",
          "ListingContractDate", "ListPrice", "ClosePrice", "StandardStatus",
          ROW_NUMBER() OVER (PARTITION BY "StreetNumber", "StreetName", COALESCE("StreetSuffix",''), "City", "PostalCode" ORDER BY "ListingContractDate" ASC NULLS LAST) AS rn,
          COUNT(*) OVER (PARTITION BY "StreetNumber", "StreetName", COALESCE("StreetSuffix",''), "City", "PostalCode") AS cnt
        FROM "Property" WHERE "StreetNumber" IS NOT NULL AND "StreetName" IS NOT NULL AND "LivingArea" IS NOT NULL
      )
      SELECT a.addr, a."PostalCode",
        a."LivingArea" AS "OldSqft", b."LivingArea" AS "NewSqft", b."LivingArea" - a."LivingArea" AS "SqftChange",
        a."BedroomsTotal" AS "OldBeds", b."BedroomsTotal" AS "NewBeds",
        a."BathroomsTotal" AS "OldBaths", b."BathroomsTotal" AS "NewBaths",
        a."ClosePrice" AS "OldClose", b."ClosePrice" AS "NewClose",
        a."ListingContractDate" AS "OldDate", b."ListingContractDate" AS "NewDate"
      FROM addr a JOIN addr b ON a.addr = b.addr AND a."PostalCode" = b."PostalCode" AND b.rn = a.rn + 1
      WHERE a.cnt > 1 AND (b."LivingArea" - a."LivingArea") != 0
      ORDER BY ABS(b."LivingArea" - a."LivingArea") DESC
      LIMIT 15
    `);
    console.log(`  Found ${rows.length} properties with sqft changes:`);
    rows.forEach((r, i) => {
      console.log(`  ${i+1}. ${r.addr} ${r.PostalCode}`);
      console.log(`     Sqft: ${r.OldSqft} → ${r.NewSqft} (${r.SqftChange > 0 ? '+' : ''}${r.SqftChange})`);
      console.log(`     Beds: ${r.OldBeds} → ${r.NewBeds} | Baths: ${r.OldBaths} → ${r.NewBaths}`);
      console.log(`     Price: $${r.OldClose?.toLocaleString()} → $${r.NewClose?.toLocaleString()}`);
      console.log(`     Dates: ${r.OldDate} → ${r.NewDate}`);
    });
  } catch (e) { console.error('  Error:', e.message); }

  process.exit(0);
}

discover().catch(e => { console.error('Fatal:', e); process.exit(1); });
