import 'dotenv/config';

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const HEADERS = { Accept: 'application/json', apikey: ATTOM_API_KEY };

const geoIdV4 = '3d7acc778200d4307421ec0af4b7933d';
const address = '11822 Prestwick Rd, Potomac, MD 20854';

// Test the community endpoint with different param types via the correct base
const tests = [
  { name: 'address', url: `${BASE}/neighborhood/community?address=${encodeURIComponent(address)}` },
  { name: 'geoIdV4', url: `${BASE}/neighborhood/community?geoIdV4=${geoIdV4}` },
  { name: 'area-full-geoIdV4', url: `${BASE}/area/full/community?geoIdV4=${geoIdV4}` },
  { name: 'community-profile-addr', url: `${BASE}/community/profile?address=${encodeURIComponent(address)}` },
  { name: 'neighborhood-community-addr', url: `${BASE}/neighborhood/community?address=${encodeURIComponent(address)}` },
  { name: 'allevents-detail', url: `${BASE}/allevents/detail?address=${encodeURIComponent(address)}` },
];

for (const test of tests) {
  try {
    console.log(`\n--- ${test.name} ---`);
    const resp = await fetch(test.url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    console.log('Status:', resp.status);
    if (resp.status === 200) {
      const data = await resp.json();
      console.log('SUCCESS! Keys:', Object.keys(data));
      console.log('Preview:', JSON.stringify(data).slice(0, 500));
    } else {
      const text = await resp.text();
      console.log('Error:', text.slice(0, 200));
    }
  } catch (e) {
    console.log('Failed:', e.message);
  }
}

process.exit(0);
