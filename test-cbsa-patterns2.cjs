const key = '7c4ed2fe0381744731a6e3c1dafac70a';
const f = (u) => fetch(u).then(r => r.json()).catch(() => null);

async function main() {
  // From the search results:
  // Unemployment: LAUMT{stFIPS}{CBSA}00000003A = Annual NSA
  //               {CITY}{stFIPS}URN = Monthly NSA (city prefix, not CBSA-based)
  //               {CITY}{stFIPS}UR  = Monthly SA
  
  // Test LAUMT pattern with different CBSAs
  console.log('=== LAUMT Unemployment Pattern ===');
  // Need: state FIPS + CBSA code
  // Austin TX = stFIPS 48, CBSA 12420
  // Phoenix AZ = stFIPS 04, CBSA 38060
  // Miami FL = stFIPS 12, CBSA 33100
  // Abilene TX = stFIPS 48, CBSA 10180
  // Burlington VT = stFIPS 50, CBSA 15540
  
  // Monthly (not annual) version = LAUMT + stFIPS + CBSA + 0000000 + 03
  const tests = [
    { name: 'Austin', sid: 'LAUMT481242000000003' },
    { name: 'Austin Annual', sid: 'LAUMT481242000000003A' },
    { name: 'Phoenix', sid: 'LAUMT040380600000003' },
    { name: 'Phoenix Annual', sid: 'LAUMT040380600000003A' },
    { name: 'Abilene', sid: 'LAUMT481018000000003' },
    { name: 'Abilene Annual', sid: 'LAUMT481018000000003A' },
    { name: 'Burlington VT', sid: 'LAUMT501554000000003A' },
  ];
  for (const t of tests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${t.sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${t.name}: ${t.sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${t.name}: ${t.sid}`);
  }

  // So LAUMT pattern doesn't use pure CBSA. It needs stFIPS + CBSA.
  // We DO have state abbreviations in CBSA_CATALOG. Let's map abbrev -> FIPS.
  // Actually, let me try another approach: search for how many series match LAUMT pattern
  console.log('\n=== LAUMT series count ===');
  const laumt = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=LAUMT&search_type=series_id&limit=1`);
  console.log(`  Total LAUMT series: ${laumt?.count || 0}`);

  // === INCOME: Test CBSA-only patterns ===
  console.log('\n=== INCOME Patterns ===');
  // PCPI{CBSA} = Per Capita Personal Income
  // MHITX12420 = Median Household Income (needs state abbrev)
  const incTests = [
    { name: 'PCPI Austin', sid: 'PCPI12420' },
    { name: 'PCPI Abilene', sid: 'PCPI10180' },
    { name: 'PCPI Burlington', sid: 'PCPI15540' },
    { name: 'PCPI Miami', sid: 'PCPI33100' },
    { name: 'PCPI Phoenix', sid: 'PCPI38060' },
    { name: 'MHI Austin', sid: 'MHITX12420' },
    { name: 'MHI Abilene', sid: 'MHITX10180' },
  ];
  for (const t of incTests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${t.sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${t.name}: ${t.sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${t.name}: ${t.sid}`);
  }

  // Count PCPI series
  const pcpiCount = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=PCPI&search_type=series_id&limit=1`);
  console.log(`\n  Total PCPI series: ${pcpiCount?.count || 0}`);

  // === GDP ===
  console.log('\n=== GDP Patterns ===');
  const gdpTests = [
    { name: 'RGMP Austin', sid: 'RGMP12420' },
    { name: 'RGMP Abilene', sid: 'RGMP10180' },
    { name: 'RGMP Burlington', sid: 'RGMP15540' },
    { name: 'NGMP Austin', sid: 'NGMP12420' },
    { name: 'NGMP Abilene', sid: 'NGMP10180' },
  ];
  for (const t of gdpTests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${t.sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${t.name}: ${t.sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${t.name}: ${t.sid}`);
  }

  const rgmpCount = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=RGMP&search_type=series_id&limit=1`);
  console.log(`  Total RGMP series: ${rgmpCount?.count || 0}`);

  // === LABOR FORCE ===
  console.log('\n=== LABOR FORCE / EMPLOYMENT ===');
  // LAUMT...06 = Labor Force, LAUMT...05 = Employment
  const laborTests = [
    { name: 'LaborForce Austin Annual', sid: 'LAUMT481242000000006A' },
    { name: 'Employment Austin Annual', sid: 'LAUMT481242000000005A' },
    { name: 'LaborForce Phoenix Annual', sid: 'LAUMT040380600000006A' },
  ];
  for (const t of laborTests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${t.sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${t.name}: ${t.sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${t.name}: ${t.sid}`);
  }

  // === WAGES: SMU pattern ===
  console.log('\n=== WAGES / EARNINGS ===');
  // SMU + stFIPS + CBSA(padded) + superSector + dataType + SA
  // Total private = 0500000011
  // All employees = 0000000001  
  // Average hourly earnings = 0500000003
  // Average weekly hours = 0500000002
  const wageTests = [
    { name: 'Wages Austin', sid: 'SMU48124200500000003SA' },   // Avg hourly earnings, private
    { name: 'Wages Austin2', sid: 'SMU48124200500000011SA' },  // Avg weekly earnings, private  
    { name: 'Wages Phoenix', sid: 'SMU04380600500000003SA' },
    { name: 'Wages Abilene', sid: 'SMU48101800500000003SA' },
    { name: 'AllEmp Austin', sid: 'SMU48124200000000001SA' },  // All employees, total nonfarm
    { name: 'AllEmp Abilene', sid: 'SMU48101800000000001SA' },
  ];
  for (const t of wageTests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${t.sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${t.name}: ${t.sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${t.name}: ${t.sid}`);
  }

  // === POPULATION === 
  console.log('\n=== POPULATION ===');
  const popTests = [
    { name: 'Pop Austin', sid: 'CBPOP12420' },
    { name: 'Pop Abilene', sid: 'CBPOP10180' },
    { name: 'Pop Burlington', sid: 'CBPOP15540' },
  ];
  for (const t of popTests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${t.sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${t.name}: ${t.sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${t.name}: ${t.sid}`);
  }

  // Search for population by MSA
  const popSearch = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=resident+population+metropolitan&limit=10`);
  console.log('\n  Population MSA series:');
  for (const s of (popSearch?.seriess || []).slice(0, 8)) {
    console.log(`    ${s.id} - ${s.title} [${s.frequency_short}]`);
  }
}

main().catch(console.error);
