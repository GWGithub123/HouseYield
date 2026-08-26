import 'dotenv/config';

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const HEADERS = { Accept: 'application/json', apikey: ATTOM_API_KEY };
const address = '11822 Prestwick Rd, Potomac, MD 20854';

// Test various ATTOM community/neighborhood endpoints
const tests = [
  `${BASE}/area/community/crime?address=${encodeURIComponent(address)}`,
  `${BASE}/area/community?address=${encodeURIComponent(address)}`,
  `${BASE}/neighborhood/detail?address=${encodeURIComponent(address)}`,
  `${BASE}/area/detail?address=${encodeURIComponent(address)}`,
  `${BASE}/property/expandedprofile?address=${encodeURIComponent(address)}`,
];

for (const url of tests) {
  try {
    const path = new URL(url).pathname;
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    console.log(`${path}: ${resp.status}`);
    if (resp.status === 200) {
      const data = await resp.json();
      const str = JSON.stringify(data);
      // Check for crime/community data
      const hasCrime = /crime|violent|walkScore|transit/i.test(str);
      console.log('  Has crime/community data:', hasCrime);
      if (hasCrime) {
        console.log('  Preview:', str.slice(0, 500));
      }
    }
  } catch (e) {
    console.log(`FAIL: ${e.message}`);
  }
}

// Also check the expandedprofile endpoint specifically for any community data
try {
  const resp = await fetch(`${BASE}/property/expandedprofile?address=${encodeURIComponent(address)}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  const data = await resp.json();
  const p = data.property?.[0];
  if (p) {
    const allKeys = [];
    const crawl = (obj, prefix) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v && !Array.isArray(v)) {
          crawl(v, path);
        } else {
          allKeys.push(path);
        }
      }
    };
    crawl(p, '');
    // Filter for interesting keys
    const interesting = allKeys.filter(k => /crime|walk|transit|community|demo|population|income/i.test(k));
    console.log('\nExpandedProfile interesting paths:', interesting.length ? interesting : 'none');
  }
} catch (e) {
  console.log('Expanded profile fetch fail:', e.message);
}

process.exit(0);
