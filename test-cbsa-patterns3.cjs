const key = '7c4ed2fe0381744731a6e3c1dafac70a';
const f = (u) => fetch(u).then(r => r.json()).catch(() => null);

async function main() {
  // Phoenix AZ failed with LAUMT040380600000003A
  // stFIPS for AZ = 04, CBSA = 38060
  // But Phoenix spans multiple states? No, it's just AZ.
  // Let me search for Phoenix unemployment to find the actual series ID
  console.log('=== Phoenix Unemployment Search ===');
  const s1 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=unemployment+rate+phoenix+metropolitan&limit=15`);
  for (const s of (s1?.seriess || [])) {
    console.log(`  ${s.id} - ${s.title} [${s.frequency_short}]`);
  }

  // Try searching for LAUMT04 
  console.log('\n=== LAUMT04 search ===');
  const s2 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=LAUMT04&search_type=series_id&limit=15`);
  for (const s of (s2?.seriess || [])) {
    if (s.title.includes('Unemployment Rate') && s.id.endsWith('3A')) {
      console.log(`  ${s.id} - ${s.title}`);
    }
  }

  // The issue might be zero-padding. CBSA 38060 -> 
  // LAUMT + 04 (stFIPS) + 38060 (CBSA) = LAUMT04380600000003A
  // But maybe stFIPS doesn't have leading zero? Let me try
  console.log('\n=== Phoenix LAUMT Variants ===');
  const variants = [
    'LAUMT043806000000003A',  // stFIPS=04, CBSA=38060, extra 0?
    'LAUMT040380600000003A',  // what we tried
    'LAUMT4380600000003A',    // no leading zero on stFIPS
    'LAUMT04386000000003A',   // different padding
  ];
  for (const sid of variants) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }

  // Austin worked: LAUMT481242000000003A
  // Let's decompose: LAUMT + 48 + 12420 + 00000003A
  // So it's: LAUMT + stFIPS(2) + CBSA(5) + 00000003A
  // Phoenix: LAUMT + 04 + 38060 + 00000003A = LAUMT04386000000003A? No.
  // Wait, Austin = LAUMT + 48 + 12420 + 00000003A = LAUMT481242000000003A
  //   48 + 12420 = 4812420 -> LAUMT + 4812420 + 0000003A
  // Phoenix: 04 + 38060 = 0438060 -> LAUMT + 0438060 + 0000003A = LAUMT04380600000003A
  // Hmm that's what we tried...
  
  // Let me count the characters:
  // LAUMT481242000000003A = LAUMT + 481242000000003 + A
  // LAUMT = 5, 481242000000003 = 15, A = 1 -> total 21
  // LAUMT04380600000003A = LAUMT + 0438060000003 + A = 5 + 13 + 1 = 19 chars
  // That's different lengths! Let me check
  console.log('\nLength check:');
  console.log('Austin:', 'LAUMT481242000000003A'.length);
  console.log('PhxTry:', 'LAUMT040380600000003A'.length);
  
  // Austin: LAUMT481242000000003A = 21 chars
  // Format must be: LAUMT + XX + XXXXX + XXXXXXXXX = LAUMT + 2 + 5 + 9 + A
  // 48 + 12420 + 000000003 -> LAUMT48124200000003A -> no, let me count again
  // L-A-U-M-T-4-8-1-2-4-2-0-0-0-0-0-0-0-0-3-A = yes, 21
  // So: LAUMT + "48" + "12420" + "00000003" + "A"
  //     5 + 2 + 5 + 8 + 1 = 21. 
  // Phoenix: LAUMT + "04" + "38060" + "00000003" + "A" = LAUMT043806000000003A
  console.log('Phoenix correct?:', 'LAUMT043806000000003A'.length);
  
  const phxTest = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=LAUMT043806000000003A`);
  if (phxTest?.seriess?.length) console.log('✅ LAUMT043806000000003A works!', phxTest.seriess[0].title);
  else console.log('❌ LAUMT043806000000003A');

  // Actually, wait. Let me just search for any LAUMT series with 38060
  console.log('\n=== Search for 38060 in LAUMT ===');
  const s3 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=LAUMT+38060&search_type=series_id&limit=10`);
  for (const s of (s3?.seriess || [])) {
    console.log(`  ${s.id} - ${s.title}`);
  }
  
  // Try direct search for 38060 unemployment
  const s4 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=LAUMT%25380600000003&search_type=series_id&limit=5`);
  console.log('\n=== LAUMT*38060 ===');
  for (const s of (s4?.seriess || [])) {
    console.log(`  ${s.id} - ${s.title}`);
  }
  
  // Maybe multi-state MSAs have different handling? Phoenix is single-state.
  // Try with just the PHOE prefix
  console.log('\n=== PHOE search (city prefix) ===');
  const s5 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=PHOE004UR&search_type=series_id&limit=10`);
  for (const s of (s5?.seriess || [])) {
    console.log(`  ${s.id} - ${s.title} [${s.frequency_short}]`);
  }

  // === Test income patterns more ===
  console.log('\n=== Income: Search for per capita by MSA ===');
  const s6 = await f(`https://api.stlouisfed.org/fred/series/search?api_key=${key}&file_type=json&search_text=per+capita+personal+income+metropolitan&limit=10`);
  for (const s of (s6?.seriess || []).slice(0, 8)) {
    console.log(`  ${s.id} - ${s.title} [${s.frequency_short}]`);
  }
  
  // Maybe the PCPI pattern uses a different code? Try county FIPS
  console.log('\n=== PCPI with FIPS ===');
  const pcpiTests = [
    'PCPI48453',  // Travis County FIPS
    'PCPI06075',  // SF County FIPS
  ];
  for (const sid of pcpiTests) {
    const r = await f(`https://api.stlouisfed.org/fred/series?api_key=${key}&file_type=json&series_id=${sid}`);
    if (r?.seriess?.length) console.log(`  ✅ ${sid} - ${r.seriess[0].title}`);
    else console.log(`  ❌ ${sid}`);
  }
}

main().catch(console.error);
