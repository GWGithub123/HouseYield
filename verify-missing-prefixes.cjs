const https = require('https');
const KEY = '7c4ed2fe0381744731a6e3c1dafac70a';

function fredFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function testSeries(id) {
  try {
    const d = await fredFetch(
      `https://api.stlouisfed.org/fred/series?series_id=${id}&api_key=${KEY}&file_type=json`
    );
    if (d.seriess && d.seriess.length) return d.seriess[0].title;
    return null;
  } catch {
    return null;
  }
}

(async () => {
  // These 10 major metros were NOT matched by build-prefix-map.cjs
  // because they span multiple states or have non-standard FRED naming.
  // We know their prefixes from METRO_CODES. Verify they work for URN and PCPI.
  const majors = {
    '16980': { name: 'Chicago', prefix: 'CHIC917' },
    '19100': { name: 'Dallas', prefix: 'DALL148' },
    '19820': { name: 'Detroit', prefix: 'DETR826' },
    '31080': { name: 'Los Angeles', prefix: 'LOSA606' },
    '33100': { name: 'Miami', prefix: 'MIAM112' },
    '35620': { name: 'New York', prefix: 'NEWY636' },
    '37980': { name: 'Philadelphia', prefix: 'PHIL942' },
    '41860': { name: 'San Francisco', prefix: 'SANF006' },
    '42660': { name: 'Seattle', prefix: 'SEAT653' },
    '47900': { name: 'Washington DC', prefix: 'WASH911' },
  };

  console.log('Verifying missing major metro prefixes...\n');
  
  for (const [cbsa, { name, prefix }] of Object.entries(majors)) {
    const urn = await testSeries(`${prefix}URN`);
    const pcpi = await testSeries(`${prefix}PCPI`);
    const bpp = await testSeries(`${prefix}BPPRIVSA`);
    console.log(`${cbsa} ${name} (${prefix}):`);
    console.log(`  URN:      ${urn ? '✅ ' + urn : '❌'}`);
    console.log(`  PCPI:     ${pcpi ? '✅ ' + pcpi : '❌'}`);
    console.log(`  BPPRIVSA: ${bpp ? '✅ ' + bpp : '❌'}`);
  }
  
  // Also check a few more CBSAs from CBSA_CATALOG that may be missing
  // Look for any other missing ones
  console.log('\n--- Also checking LOSA106 vs LOSA606 ---');
  const la106 = await testSeries('LOSA106URN');
  const la606 = await testSeries('LOSA606URN');
  console.log(`LOSA106URN: ${la106 ? '✅ ' + la106 : '❌'}`);
  console.log(`LOSA606URN: ${la606 ? '✅ ' + la606 : '❌'}`);
  
  // The prefix map already has LOSA106 for BPPRIVSA — check if LOSA606 is for URN
  const la106b = await testSeries('LOSA106BPPRIVSA');
  const la606b = await testSeries('LOSA606BPPRIVSA');
  console.log(`LOSA106BPPRIVSA: ${la106b ? '✅ ' + la106b : '❌'}`);
  console.log(`LOSA606BPPRIVSA: ${la606b ? '✅ ' + la606b : '❌'}`);
})();
