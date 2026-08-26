const key = '7c4ed2fe0381744731a6e3c1dafac70a';
const f = (u) => fetch(u).then(r => r.json()).catch(() => null);

async function main() {
  // === Unemployment: try release-based approach ===
  // BLS Local Area Unemployment = Release 116
  console.log('=== Release 116 Sample Series ===');
  const rel = await f(`https://api.stlouisfed.org/fred/release/series?api_key=${key}&file_type=json&release_id=116&limit=30&search_text=unemployment+rate&filter_variable=frequency&filter_value=Monthly`);
  const msa = (rel?.seriess || []).filter(s => s.title.includes('MSA') && s.id.includes('URN'));
  console.log(`  Found ${msa.length} MSA unemployment rate series (monthly NSA)`);
  msa.slice(0, 10).forEach(s => console.log(`    ${s.id} - ${s.title}`));

  // Unemployment: check if the "city-prefix + stFIPS" pattern is consistent
  // PHOE004URN = Phoenix (04 = AZ FIPS)
  // AUST648URN = Austin? No, 648 doesn't map to a state FIPS
  // Actually: AUST4 = city prefix, 48 = TX FIPS? Wait...
  // Let me check: AUST648URN - the "648" part
  // Actually the search showed AUST448URN not AUST648URN!
  console.log('\n=== Correct Austin unemployment ===');
  const austTests = ['AUST448URN', 'AUST648URN', 'AUST448UR'];
  for (const sid of austTests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }

  // So the pattern is: {CITY_PREFIX}{STATE_FIPS}URN for NSA monthly
  // This matches building permits: {CITY_PREFIX}{STATE_FIPS}BPPRIVSA
  // The city prefix varies and can't be derived from CBSA code!
  // This means unemployment needs the same manual mapping as permits.

  // === Income: BEA Personal Income ===
  // Release 175 = BEA MSA personal income
  console.log('\n=== Release 175 (BEA MSA Income) ===');
  const rel175 = await f(`https://api.stlouisfed.org/fred/release/series?api_key=${key}&file_type=json&release_id=175&limit=20&search_text=per+capita`);
  (rel175?.seriess || []).slice(0, 10).forEach(s => 
    console.log(`  ${s.id} - ${s.title} [${s.frequency_short}] ${s.seasonal_adjustment_short}`)
  );

  // === Let's try the NEW per capita income pattern ===
  // From BEA, maybe it's like PCPI + MSA_FIPS or different code
  console.log('\n=== MSA Per Capita Income Patterns ===');
  const incTests2 = [
    // Maybe the new (non-discontinued) series use a different naming?
    'ATLA013PCPI',    // Atlanta city-prefix
    'AUST448PCPI',    // Austin city-prefix  
    'PHOE004PCPI',    // Phoenix
    // Or just the CBSA directly?
    'PCPI12420',      // Austin CBSA
  ];
  for (const sid of incTests2) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }

  // === GDP: check if RGMP is truly CBSA-based and the new replacement ===
  console.log('\n=== GDP: RGMP vs GDPMETRO ===');
  // RGMP is DISCONTINUED, but what replaced it?
  const rgmp = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=RGMP12420`);
  if (rgmp?.seriess?.length) {
    const s = rgmp.seriess[0];
    console.log(`  RGMP12420: "${s.title}" [${s.frequency_short}]`);
    console.log(`  Notes: ${s.notes?.slice(0, 300)}`);
  }
  
  // Try new GDP series
  const gdpNew = [
    'REALGDPALL12420',
    'GDP12420',
    'GDPMETRO12420',
  ];
  for (const sid of gdpNew) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }

  // === How many URN series total? ===
  console.log('\n=== URN series count ===');
  const urnCount = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=URN&search_type=series_id&limit=1&filter_variable=frequency&filter_value=Monthly`);
  console.log(`  URN monthly series: ${urnCount?.count || 0}`);
  
  // How many are MSA level?
  const urnMsa = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=URN&search_type=series_id&limit=500&filter_variable=frequency&filter_value=Monthly`);
  const msaSeries = (urnMsa?.seriess || []).filter(s => s.title.includes('MSA'));
  console.log(`  URN MSA monthly series: ${msaSeries.length}`);
  msaSeries.slice(0, 5).forEach(s => console.log(`    ${s.id}`));

  // === Population: try the CBSA approach ===
  console.log('\n=== Population ===');
  // Maybe it's {CITY}POP (which won't scale) or something else
  // Let's check release 118 (Census estimates)
  const rel118 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=resident+population+MSA&limit=20`);
  const popSeries = (rel118?.seriess || []).filter(s => s.title.includes('MSA'));
  console.log(`  Population MSA series: ${popSeries.length}`);
  popSeries.slice(0, 10).forEach(s => console.log(`    ${s.id} - ${s.title}`));

  // === PERMITS: count how many exist vs our 67 ===
  console.log('\n=== Building Permits ===');
  const permCount = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=BPPRIVSA&search_type=series_id&limit=1`);
  console.log(`  BPPRIVSA series total: ${permCount?.count || 0}`);
}

main().catch(console.error);
