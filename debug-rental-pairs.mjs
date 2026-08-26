import * as snowflake from './server/snowflake.js';
await snowflake.connect();

// Test 1: How many rental pairs does findRentalRenovationPairs actually return?
console.log('\n=== Test 1: findRentalRenovationPairs for 22193 ===');
const pairs = await snowflake.findRentalRenovationPairs({ zip: '22193', limit: 200 });
console.log(`Found ${pairs.length} rental pairs`);
if (pairs.length > 0) {
  console.log('Sample pair:', JSON.stringify(pairs[0], null, 2));
}

// Test 2: Check how many of those pairs match addresses of our sale-pair comps
console.log('\n=== Test 2: Sale pairs for 22193 ===');
const salePairs = await snowflake.findRenovationPairs({ zip: '22193', limit: 60 });
console.log(`Found ${salePairs.length} sale pairs`);

// Build address keys from sale pairs
const norm = (s) => (s || '').toUpperCase().trim();
const saleAddresses = new Set(
  salePairs.map(p => `${norm(p.STREETNUMBER)}|${norm(p.STREETNAME)}`)
);
console.log(`Unique sale addresses: ${saleAddresses.size}`);

// Build address keys from rental pairs
const rentalAddresses = new Set(
  pairs.map(p => `${norm(p.STREETNUMBER)}|${norm(p.STREETNAME)}`)
);
console.log(`Unique rental addresses: ${rentalAddresses.size}`);

// Intersection
const overlap = [...saleAddresses].filter(a => rentalAddresses.has(a));
console.log(`Address overlap (sale ∩ rental): ${overlap.length}`);
if (overlap.length > 0) {
  console.log('Overlapping addresses:', overlap.slice(0, 10));
}

// Test 3: Are there lease listings for ANY of our sale-pair addresses?
console.log('\n=== Test 3: Do sale-pair addresses have lease listings? ===');
const sampleSaleAddresses = salePairs.slice(0, 5);
for (const sp of sampleSaleAddresses) {
  const addr = `${sp.STREETNUMBER} ${sp.STREETNAME} ${sp.STREETSUFFIX || ''}`.trim();
  const leases = await snowflake.executeQuery(`
    SELECT COUNT(*) as cnt, MIN("LISTPRICE") as min_rent, MAX("LISTPRICE") as max_rent,
           MIN("ONMARKETDATE") as earliest, MAX("ONMARKETDATE") as latest
    FROM "Property"
    WHERE "POSTALCODE" = '22193'
      AND "STREETNUMBER" = ?
      AND "STREETNAME" = ?
      AND (
        UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%LEASE%'
        OR UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%RENT%'
        OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%LEASE%'
        OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%RENT%'
        OR UPPER(COALESCE("STANDARDSTATUS", '')) IN ('LEASED', 'RENTED')
      )
  `, [sp.STREETNUMBER, sp.STREETNAME]);
  console.log(`  ${addr}: ${leases[0]?.CNT || 0} lease listings (rent $${leases[0]?.MIN_RENT}-$${leases[0]?.MAX_RENT})`);
}

// Test 4: Check how address matching works in processor
// The processor matches rental pairs to sale pairs using key variants
console.log('\n=== Test 4: Why matching might fail ===');
if (pairs.length > 0 && salePairs.length > 0) {
  // Check if street suffix differences cause mismatches
  const rentalSuffixes = new Map();
  for (const p of pairs) {
    const base = `${norm(p.STREETNUMBER)}|${norm(p.STREETNAME)}`;
    rentalSuffixes.set(base, p.STREETSUFFIX || '(none)');
  }
  const saleSuffixes = new Map();
  for (const p of salePairs) {
    const base = `${norm(p.STREETNUMBER)}|${norm(p.STREETNAME)}`;
    saleSuffixes.set(base, p.STREETSUFFIX || '(none)');
  }
  
  // Check for suffix mismatches in overlapping addresses
  let suffixMismatches = 0;
  for (const [base, rentalSuffix] of rentalSuffixes) {
    const saleSuffix = saleSuffixes.get(base);
    if (saleSuffix && norm(saleSuffix) !== norm(rentalSuffix)) {
      suffixMismatches++;
      if (suffixMismatches <= 3) {
        console.log(`  Suffix mismatch: sale="${saleSuffix}" vs rental="${rentalSuffix}" for ${base}`);
      }
    }
  }
  console.log(`Total suffix mismatches: ${suffixMismatches}`);
}

// Test 5: Check if the real problem is timing - do leases happen AFTER or BEFORE the sale dates?
console.log('\n=== Test 5: Timing analysis ===');
if (overlap.length > 0 && pairs.length > 0 && salePairs.length > 0) {
  for (const addr of overlap.slice(0, 3)) {
    const [sn, st] = addr.split('|');
    const sale = salePairs.find(p => norm(p.STREETNUMBER) === sn && norm(p.STREETNAME) === st);
    const rental = pairs.find(p => norm(p.STREETNUMBER) === sn && norm(p.STREETNAME) === st);
    if (sale && rental) {
      console.log(`  ${sn} ${st}:`);
      console.log(`    Sale: before=${sale.BEFORE_DATE} → after=${sale.AFTER_DATE} ($${sale.BEFORE_PRICE}→$${sale.AFTER_PRICE})`);
      console.log(`    Rental: before=${rental.BEFORE_DATE} → after=${rental.AFTER_DATE} ($${rental.BEFORE_RENT}→$${rental.AFTER_RENT})`);
    }
  }
}

await snowflake.disconnect();
