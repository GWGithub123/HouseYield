import 'dotenv/config';

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const HEADERS = { Accept: 'application/json', apikey: ATTOM_API_KEY };
const address = '11822 Prestwick Rd, Potomac, MD 20854';

const url = `${BASE}/allevents/detail?address=${encodeURIComponent(address)}`;
const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
const data = await resp.json();

const p = data.property?.[0] || data.property || {};
console.log('Top property keys:', Object.keys(p));

// Search for any crime or community related keys
const json = JSON.stringify(p, null, 2);
const crimeMatch = json.match(/"(crime|violent|property_crime|burglary|murder|walkScore|walkability|community|demographics)"/gi);
console.log('\nCrime/community related keys found:', crimeMatch?.length ? [...new Set(crimeMatch)] : 'none');

// Print keys at each level
for (const [k, v] of Object.entries(p)) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    console.log(`\n${k} keys:`, Object.keys(v));
  }
}

process.exit(0);
