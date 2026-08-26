import * as snowflake from './server/snowflake.js';
await snowflake.connect();

// Get rental pairs for analysis
const pairs = await snowflake.findRentalRenovationPairs({ zip: '22193', limit: 500 });
console.log(`Total rental pairs: ${pairs.length}`);

// Group by beds to understand rent ranges
const byBeds = {};
for (const p of pairs) {
  const beds = p.BEDS || 'unknown';
  if (!byBeds[beds]) byBeds[beds] = [];
  byBeds[beds].push({
    before: p.BEFORE_RENT,
    after: p.AFTER_RENT,
    increase: p.AFTER_RENT - p.BEFORE_RENT,
    pct: p.RENT_INCREASE_PCT,
    sqft: p.SQFT,
    days: p.DAYS_BETWEEN_LISTINGS,
    type: p.PROPERTYTYPE
  });
}

console.log('\n=== Rent increase by beds ===');
for (const [beds, data] of Object.entries(byBeds).sort()) {
  const increases = data.map(d => d.increase).filter(v => v > 0);
  const avgIncrease = increases.length > 0 ? Math.round(increases.reduce((a,b)=>a+b,0)/increases.length) : 0;
  const medianIncrease = increases.length > 0 ? increases.sort((a,b)=>a-b)[Math.floor(increases.length/2)] : 0;
  const avgBefore = Math.round(data.map(d=>d.before).reduce((a,b)=>a+b,0)/data.length);
  const avgAfter = Math.round(data.map(d=>d.after).reduce((a,b)=>a+b,0)/data.length);
  console.log(`  ${beds} bed: n=${data.length}, avg rent $${avgBefore}→$${avgAfter}, avg increase +$${avgIncrease}/mo, median +$${medianIncrease}/mo`);
}

// Group by property type
const byType = {};
for (const p of pairs) {
  const type = p.PROPERTYTYPE || 'unknown';
  if (!byType[type]) byType[type] = 0;
  byType[type]++;
}
console.log('\n=== Property types in rental pairs ===');
for (const [type, count] of Object.entries(byType).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${type}: ${count}`);
}

// Can we match rentals to renovated properties by similar characteristics?
console.log('\n=== Can we match by area (not address)? ===');
const salePairs = await snowflake.findRenovationPairs({ zip: '22193', limit: 60 });
console.log(`Sale pairs: ${salePairs.length}`);

// For each sale pair, find rental data from similar properties in the ZIP
for (const sp of salePairs.slice(0, 5)) {
  const addr = `${sp.STREETNUMBER} ${sp.STREETNAME} ${sp.STREETSUFFIX || ''}`.trim();
  const spBeds = sp.BEDS || sp.AFTER_BEDS || 0;
  const spSqft = sp.SQFT || sp.AFTER_SQFT || 0;
  
  // Find rental pairs with similar beds (±1) and sqft (±30%)
  const similar = pairs.filter(rp => {
    const beds = rp.BEDS || 0;
    const sqft = rp.SQFT || 0;
    if (spBeds > 0 && Math.abs(beds - spBeds) > 1) return false;
    if (spSqft > 0 && sqft > 0) {
      const ratio = Math.min(spSqft, sqft) / Math.max(spSqft, sqft);
      if (ratio < 0.7) return false;
    }
    return true;
  });
  
  if (similar.length > 0) {
    const increases = similar.map(s => s.AFTER_RENT - s.BEFORE_RENT).filter(v => v > 0);
    const avgIncrease = increases.length > 0 ? Math.round(increases.reduce((a,b)=>a+b,0)/increases.length) : 0;
    console.log(`  ${addr} (${spBeds}bd/${spSqft}sf): ${similar.length} similar rentals, avg increase +$${avgIncrease}/mo`);
  } else {
    console.log(`  ${addr} (${spBeds}bd/${spSqft}sf): 0 similar rentals found`);
  }
}

// What about the BIGGER picture: use nearby ZIP codes too
console.log('\n=== Nearby ZIP lease data ===');
const nearbyZips = ['22191', '22192', '22193', '22194', '22195', '22026', '22025'];
for (const z of nearbyZips) {
  const count = await snowflake.executeQuery(`
    SELECT COUNT(*) as cnt FROM "Property"
    WHERE "POSTALCODE" = '${z}'
      AND (
        UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%LEASE%'
        OR UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%RENT%'
        OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%LEASE%'  
        OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%RENT%'
        OR UPPER(COALESCE("STANDARDSTATUS", '')) IN ('LEASED', 'RENTED')
      )
  `);
  console.log(`  ZIP ${z}: ${count[0]?.CNT || 0} lease listings`);
}

await snowflake.disconnect();
