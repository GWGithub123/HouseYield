const key = '7c4ed2fe0381744731a6e3c1dafac70a';
const f = (u) => fetch(u).then(r => r.json()).catch(() => null);

async function main() {
  // Get ALL URN (unemployment rate NSA monthly) MSA series
  console.log('=== All URN MSA Series ===');
  const allUrn = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=URN&search_type=series_id&limit=500`);
  const urnMsa = (allUrn?.seriess || []).filter(s => s.title.includes('MSA') && s.id.endsWith('URN'));
  console.log(`Total URN MSA: ${urnMsa.length}`);
  
  // Get ALL BPPRIVSA (building permits SA monthly) series
  console.log('\n=== All BPPRIVSA Series ===');
  const allBP = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=BPPRIVSA&search_type=series_id&limit=500`);
  const bpMsa = (allBP?.seriess || []).filter(s => s.title.includes('MSA'));
  console.log(`Total BPPRIVSA MSA: ${bpMsa.length}`);

  // Get ALL PCPI MSA series (per capita personal income)
  console.log('\n=== All PCPI MSA Series ===');
  const allPcpi = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=PCPI&search_type=series_id&limit=500`);
  const pcpiMsa = (allPcpi?.seriess || []).filter(s => s.title.includes('MSA'));
  console.log(`Total PCPI MSA: ${pcpiMsa.length}`);

  // Now: the city-prefix pattern for URN, BPPRIVSA, PCPI etc is the SAME prefix.
  // E.g., Austin = AUST4, Phoenix = PHOE0, Abilene = ABIL1
  // Let's extract the city prefix from the URN series and match with CBSA
  
  // For each URN MSA series, extract:
  // 1. City prefix (everything before "URN")  
  // 2. The MSA name from the title
  // Then match against CBSA_CATALOG by name similarity
  
  // Read CBSA_CATALOG to do the matching
  const cbsaCatalog = await import('./server/cbsa-catalog.js');
  const catalog = cbsaCatalog.CBSA_CATALOG;
  const catalogEntries = Object.entries(catalog);
  
  console.log(`\nCBSA_CATALOG entries: ${catalogEntries.length}`);
  
  // Build a map from normalized MSA name -> CBSA code
  const nameToCode = {};
  for (const [cbsa, info] of catalogEntries) {
    // Normalize: "Austin-Round Rock, TX" -> "austin-round rock, tx"
    nameToCode[info.n.toLowerCase()] = cbsa;
  }
  
  // Extract city prefixes from URN series and match to CBSA codes
  const cityPrefixMap = {};
  let matched = 0, unmatched = 0;
  
  for (const s of urnMsa) {
    const prefix = s.id.replace('URN', '');
    // Extract MSA name from title: "Unemployment Rate in {MSA_NAME} (MSA)"
    const titleMatch = s.title.match(/Unemployment Rate in (.+?) \(MSA\)/);
    if (!titleMatch) continue;
    const msaName = titleMatch[1];
    
    // Try to match against CBSA_CATALOG
    const lowerName = msaName.toLowerCase();
    let foundCbsa = null;
    for (const [cbsa, info] of catalogEntries) {
      if (info.n.toLowerCase() === lowerName) {
        foundCbsa = cbsa;
        break;
      }
    }
    
    // Fuzzy match: try matching first part of name
    if (!foundCbsa) {
      const mainCity = lowerName.split(',')[0].split('-')[0].trim();
      for (const [cbsa, info] of catalogEntries) {
        const catCity = info.n.toLowerCase().split(',')[0].split('-')[0].trim();
        if (catCity === mainCity) {
          foundCbsa = cbsa;
          break;
        }
      }
    }
    
    if (foundCbsa) {
      cityPrefixMap[foundCbsa] = prefix;
      matched++;
    } else {
      unmatched++;
      // Show unmatched for debugging
      if (unmatched <= 10) console.log(`  ⚠️ Unmatched: ${prefix} = "${msaName}"`);
    }
  }
  
  console.log(`\nMatched ${matched}/${urnMsa.length} URN series to CBSA codes`);
  console.log(`Unmatched: ${unmatched}`);
  
  // Now verify: do these city prefixes also work for BPPRIVSA and PCPI?
  console.log('\n=== Verify city prefix consistency ===');
  const testPrefixes = Object.entries(cityPrefixMap).slice(0, 8);
  for (const [cbsa, prefix] of testPrefixes) {
    const urnSid = prefix + 'URN';
    const bpSid = prefix + 'BPPRIVSA';
    const pcpiSid = prefix + 'PCPI';
    const urSid = prefix + 'UR';
    
    const [rUrn, rBp, rPcpi, rUr] = await Promise.all([
      f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${urnSid}`),
      f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${bpSid}`),
      f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${pcpiSid}`),
      f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${urSid}`),
    ]);
    
    const urnOk = rUrn?.seriess?.length > 0 ? '✅' : '❌';
    const bpOk = rBp?.seriess?.length > 0 ? '✅' : '❌';
    const pcpiOk = rPcpi?.seriess?.length > 0 ? '✅' : '❌';
    const urOk = rUr?.seriess?.length > 0 ? '✅' : '❌';
    
    console.log(`  CBSA ${cbsa} (${prefix}): URN=${urnOk} UR=${urOk} BPPRIVSA=${bpOk} PCPI=${pcpiOk}`);
    await new Promise(r => setTimeout(r, 500));
  }

  // Print the full mapping for code generation
  console.log('\n=== CITY PREFIX MAP (for code gen) ===');
  console.log(`Total mapped: ${Object.keys(cityPrefixMap).length}`);
  // Print as JSON
  const sorted = Object.entries(cityPrefixMap).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cbsa, prefix] of sorted.slice(0, 20)) {
    const info = catalog[cbsa];
    console.log(`  '${cbsa}': '${prefix}',  // ${info?.n || '?'}`);
  }
  console.log('  ...');
  
  // Also count BPPRIVSA matches
  let bpMatched = 0;
  for (const s of bpMsa) {
    const prefix = s.id.replace('BPPRIVSA', '').replace('BPPRIV', '');
    // Check if any CBSA has this prefix
    for (const [cbsa, p] of Object.entries(cityPrefixMap)) {
      if (p === prefix) { bpMatched++; break; }
    }
  }
  console.log(`\nBPPRIVSA series that match a known city prefix: ${bpMatched}/${bpMsa.length}`);
}

main().catch(console.error);
