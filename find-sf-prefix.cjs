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

(async () => {
  // Find San Francisco URN series
  const sfSearch = await fredFetch(
    `https://api.stlouisfed.org/fred/series/search?search_text=unemployment+rate+san+francisco+msa&api_key=${KEY}&file_type=json&limit=20`
  );
  console.log('=== SF unemployment search ===');
  for (const s of (sfSearch.seriess || [])) {
    if (s.id.endsWith('URN') || s.id.endsWith('UR')) {
      console.log(`${s.id}: ${s.title} [${s.frequency_short}]`);
    }
  }

  // Also test SANF806 (San Francisco uses 806 FIPS for county?)
  const tests = ['SANF806URN', 'SANF106URN', 'SANF006URN', 'SANF906URN'];
  for (const id of tests) {
    try {
      const d = await fredFetch(
        `https://api.stlouisfed.org/fred/series?series_id=${id}&api_key=${KEY}&file_type=json`
      );
      console.log(`${id}: ${d.seriess ? '✅ ' + d.seriess[0].title : '❌'}`);
    } catch { console.log(`${id}: ❌`); }
  }
  
  // Check the METRO_CODES SF prefix - it says SANF006URN but that fails
  // The CBSA for SF is 41860. The building permit series is SANF806BPPRIVSA
  console.log('\n=== Testing SANF806 variants ===');
  const sfTests = ['SANF806URN', 'SANF806PCPI', 'SANF806BPPRIVSA', 'SANF806UR'];
  for (const id of sfTests) {
    try {
      const d = await fredFetch(
        `https://api.stlouisfed.org/fred/series?series_id=${id}&api_key=${KEY}&file_type=json`
      );
      console.log(`${id}: ${d.seriess ? '✅ ' + d.seriess[0].title : '❌'}`);
    } catch { console.log(`${id}: ❌`); }
  }
  
  // LA uses LOSA106 - verify PCPI too
  console.log('\n=== LA LOSA106 PCPI ===');
  const lapcpi = await fredFetch(
    `https://api.stlouisfed.org/fred/series?series_id=LOSA106PCPI&api_key=${KEY}&file_type=json`
  );
  console.log(`LOSA106PCPI: ${lapcpi.seriess ? '✅ ' + lapcpi.seriess[0].title : '❌'}`);
})();
