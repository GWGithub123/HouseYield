const key = '7c4ed2fe0381744731a6e3c1dafac70a';
const f = (u) => fetch(u).then(r => r.json());

async function main() {
  // === UNEMPLOYMENT ===
  // Current pattern in METRO_CODES: 'AUST648URN' (city-prefix, not CBSA-based)
  // Let's search for what unemployment patterns exist for CBSA 12420 (Austin)
  console.log('\n=== UNEMPLOYMENT (CBSA 12420 = Austin) ===');
  const search1 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=unemployment+rate+austin&limit=20`);
  for (const s of (search1.seriess || [])) {
    if (s.id.includes('12420') || s.id.includes('URN') || s.id.includes('AUST')) {
      console.log(`  ${s.id} - ${s.title} [${s.frequency_short}] ${s.seasonal_adjustment_short}`);
    }
  }
  
  // Try specific CBSA-based patterns
  const unempPatterns = [
    'LAUMT481242000000003',   // LAUMT + stFIPS(48) + CBSA(12420) + suffix
    'LAUMT481242000000003A',
    'AUST648URN',             // Known working pattern (city-prefix)
  ];
  for (const sid of unempPatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }

  // Search by series_id pattern for unemployment + CBSA
  const search1b = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=12420URN&search_type=series_id&limit=10`);
  console.log('\n  Series containing "12420URN":');
  for (const s of (search1b.seriess || [])) {
    console.log(`    ${s.id} - ${s.title}`);
  }

  // Try the release approach - BLS unemployment is release 116
  const rel = await f(`https://api.stlouisfed.org/fred/release/series?api_key=${key}&file_type=json&release_id=116&limit=10&search_text=Austin`);
  console.log('\n  Release 116 (BLS Employment) Austin series:');
  for (const s of (rel.seriess || [])) {
    if (s.title.includes('Unemployment')) {
      console.log(`    ${s.id} - ${s.title} [${s.frequency_short}]`);
    }
  }

  // === INCOME ===
  console.log('\n=== INCOME (CBSA 12420 = Austin) ===');
  // Current pattern: 'MHITX12420' (MHI + state + CBSA)
  const incPatterns = [
    'MHITX12420',             // Known - MHI + state_abbrev + CBSA
    'MHICA41860',             // SF
    'MHIAZ38060',             // Phoenix
    'MHIFL33100',             // Miami
  ];
  for (const sid of incPatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${sid}`);
  }

  // Search for CBSA-only income pattern
  const search2 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=median+household+income+12420&search_type=series_id&limit=10`);
  console.log('\n  Series matching "median household income 12420":');
  for (const s of (search2.seriess || [])) {
    console.log(`    ${s.id} - ${s.title} [${s.frequency_short}]`);
  }

  // === WAGES ===
  console.log('\n=== WAGES (CBSA 12420 = Austin) ===');
  // Current pattern: 'SMU48124000500000011SA' (SMU + stFIPS + CBSA_padded + industry + earnings_code + SA)
  const wagePatterns = [
    'SMU48124200500000011SA',  // SMU + 48 + 12420 + 0 + 05 + 0000001 + 1SA
    'SMU48124000500000011SA',  // existing (but may be wrong?)
    'SMS48124200000000011',    // SMS variant
    'SMU48124200000000011SA',  // Total nonfarm?
  ];
  for (const sid of wagePatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${sid}`);
  }

  // Try QCEW-based patterns (quarterly county data)
  // ENU + county_fips + 40510 = avg weekly wages
  const qcewPatterns = [
    'ENU4845340510',           // Travis County quarterly wages
    'ENU1208640510',           // Miami-Dade quarterly wages
    'ENU0607540510',           // San Francisco County
  ];
  console.log('\n  QCEW quarterly wages:');
  for (const sid of qcewPatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`    ✅ ${sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`    ❌ ${sid}`);
  }

  // === SEARCH for CBSA-based per capita income ===
  console.log('\n=== PER CAPITA PERSONAL INCOME ===');
  const pcpiPatterns = [
    'PCPI12420',     // Per capita personal income, Austin MSA
    'PCPI38060',     // Phoenix
    'PCPI33100',     // Miami  
    'PCPI10180',     // Abilene (small MSA)
    'PCPI15500',     // Burlington VT (small MSA)
  ];
  for (const sid of pcpiPatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${sid}`);
  }

  // === GDP by Metro ===
  console.log('\n=== REAL GDP (metro) ===');
  const gdpPatterns = [
    'RGMP12420',     // Real GDP Austin MSA
    'RGMP38060',     // Phoenix  
    'RGMP10180',     // Abilene
    'NGMP12420',     // Nominal GDP Austin
  ];
  for (const sid of gdpPatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title} [${r.seriess[0].frequency_short}]`);
    else console.log(`  ❌ ${sid}`);
  }

  // === TOTAL EMPLOYMENT (nonfarm payroll) ===
  console.log('\n=== NONFARM EMPLOYMENT ===');
  const empPatterns = [
    'AUST648NAN',    // Known Austin nonfarm employment?
    'PAYEMS12420',   // PAYEMS + CBSA
  ];
  for (const sid of empPatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }

  // === POPULATION ===
  console.log('\n=== POPULATION ===');
  const popPatterns = [
    'CBPOP12420',     // CBSA population?
    'POP12420',
    'POPESTIMATE12420',
  ];
  for (const sid of popPatterns) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`).catch(() => null);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }

  // === Count total series for key patterns ===
  console.log('\n=== SERIES COUNTS ===');
  const countPatterns = ['PCPI', 'RGMP', 'NGMP', 'MHITX'];
  for (const prefix of countPatterns) {
    const sr = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=${prefix}&search_type=series_id&limit=1`);
    console.log(`  ${prefix}: ${sr.count || 0} total series`);
  }
}

main().catch(console.error);
