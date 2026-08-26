const key = '7c4ed2fe0381744731a6e3c1dafac70a';
const f = (u) => fetch(u).then(r => r.json()).catch(() => null);

async function main() {
  // Get ALL URN series with pagination (up to 1000)
  console.log('Fetching all URN series...');
  let allUrn = [];
  let offset = 0;
  while (true) {
    const r = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=URN&search_type=series_id&limit=1000&offset=${offset}`);
    if (!r?.seriess?.length) break;
    allUrn = allUrn.concat(r.seriess);
    if (allUrn.length >= (r.count || 0)) break;
    offset += 1000;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`Total URN series fetched: ${allUrn.length}`);
  
  // Filter to MSA unemployment rate only
  const urnMsa = allUrn.filter(s => s.title.includes('(MSA)') && s.id.endsWith('URN'));
  console.log(`URN MSA series: ${urnMsa.length}`);
  
  // Also get BPPRIVSA
  console.log('\nFetching all BPPRIVSA series...');
  let allBp = [];
  offset = 0;
  while (true) {
    const r = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=BPPRIVSA&search_type=series_id&limit=1000&offset=${offset}`);
    if (!r?.seriess?.length) break;
    allBp = allBp.concat(r.seriess);
    if (allBp.length >= (r.count || 0)) break;
    offset += 1000;
    await new Promise(r => setTimeout(r, 500));
  }
  const bpMsa = allBp.filter(s => s.title.includes('(MSA)') && s.id.endsWith('BPPRIVSA'));
  console.log(`BPPRIVSA MSA series: ${bpMsa.length}`);

  // Also get PCPI
  console.log('\nFetching all PCPI MSA series...');
  let allPcpi = [];
  offset = 0;
  while (true) {
    const r = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=PCPI&search_type=series_id&limit=1000&offset=${offset}`);
    if (!r?.seriess?.length) break;
    allPcpi = allPcpi.concat(r.seriess);
    if (allPcpi.length >= (r.count || 0)) break;
    offset += 1000;
    await new Promise(r => setTimeout(r, 500));
  }
  const pcpiMsa = allPcpi.filter(s => s.title.includes('(MSA)') && s.id.endsWith('PCPI'));
  console.log(`PCPI MSA series: ${pcpiMsa.length}`);

  // Load CBSA_CATALOG
  const cbsaCatalog = await import('./server/cbsa-catalog.js');
  const catalog = cbsaCatalog.CBSA_CATALOG;
  const catalogEntries = Object.entries(catalog);

  // Build unified CITY_PREFIX_MAP from all three datasets
  const prefixMap = {};
  
  // From URN
  for (const s of urnMsa) {
    const prefix = s.id.replace('URN', '');
    const titleMatch = s.title.match(/Unemployment Rate in (.+?) \(MSA\)/);
    if (!titleMatch) continue;
    matchToCbsa(prefix, titleMatch[1], catalogEntries, prefixMap);
  }
  console.log(`\nAfter URN matching: ${Object.keys(prefixMap).length} CBSAs mapped`);
  
  // From BPPRIVSA
  for (const s of bpMsa) {
    const prefix = s.id.replace('BPPRIVSA', '');
    const titleMatch = s.title.match(/New Private Housing .+? in (.+?) \(MSA\)/);
    if (!titleMatch) continue;
    matchToCbsa(prefix, titleMatch[1], catalogEntries, prefixMap);
  }
  console.log(`After BPPRIVSA matching: ${Object.keys(prefixMap).length} CBSAs mapped`);
  
  // From PCPI
  for (const s of pcpiMsa) {
    const prefix = s.id.replace('PCPI', '');
    const titleMatch = s.title.match(/Per Capita Personal Income in (.+?) \(MSA\)/);
    if (!titleMatch) continue;
    matchToCbsa(prefix, titleMatch[1], catalogEntries, prefixMap);
  }
  console.log(`After PCPI matching: ${Object.keys(prefixMap).length} CBSAs mapped`);
  
  // Print the full map as JavaScript
  console.log('\n// === CITY_PREFIX_MAP: CBSA → city prefix for BLS/BEA series ===');
  console.log('const CITY_PREFIX_MAP = {');
  const sorted = Object.entries(prefixMap).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cbsa, prefix] of sorted) {
    const info = catalog[cbsa];
    console.log(`  '${cbsa}': '${prefix}',  // ${info?.n || '?'}`);
  }
  console.log('};');
  console.log(`\n// Total: ${sorted.length} entries`);
  
  // Now check: which series exist for each prefix?
  // Sample a few to verify availability
  console.log('\n=== Availability check (sample) ===');
  const sample = sorted.filter((_, i) => i % 20 === 0).slice(0, 10);
  for (const [cbsa, prefix] of sample) {
    const checks = {
      URN: prefix + 'URN',
      UR: prefix + 'UR',
      BPPRIVSA: prefix + 'BPPRIVSA',
      PCPI: prefix + 'PCPI',
    };
    const results = {};
    for (const [label, sid] of Object.entries(checks)) {
      const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`);
      results[label] = r?.seriess?.length > 0 ? '✅' : '❌';
    }
    console.log(`  ${cbsa} (${prefix}): ${Object.entries(results).map(([k,v])=>k+'='+v).join(' ')}`);
    await new Promise(r => setTimeout(r, 300));
  }
}

function matchToCbsa(prefix, msaName, catalogEntries, prefixMap) {
  const lowerName = msaName.toLowerCase();
  
  // Exact match
  for (const [cbsa, info] of catalogEntries) {
    if (info.n.toLowerCase() === lowerName) {
      if (!prefixMap[cbsa]) prefixMap[cbsa] = prefix;
      return true;
    }
  }
  
  // Fuzzy: match first city before comma
  const mainCity = lowerName.split(',')[0].split('-')[0].trim();
  const state = (lowerName.split(',')[1] || '').trim();
  for (const [cbsa, info] of catalogEntries) {
    const catCity = info.n.toLowerCase().split(',')[0].split('-')[0].trim();
    const catState = (info.n.toLowerCase().split(',')[1] || '').trim();
    if (catCity === mainCity && (!state || catState.includes(state.split('-')[0].trim()))) {
      if (!prefixMap[cbsa]) prefixMap[cbsa] = prefix;
      return true;
    }
  }
  
  return false;
}

main().catch(console.error);
