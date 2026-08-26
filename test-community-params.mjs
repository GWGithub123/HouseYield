import 'dotenv/config';

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const BASE = 'https://api.gateway.attomdata.com/v1';
const HEADERS = { Accept: 'application/json', apikey: ATTOM_API_KEY };

// The geoIdV4 from the schools data
const geoIdV4 = '3d7acc778200d4307421ec0af4b7933d';
const fips = '24031';
const lat = '39.052116';
const lon = '-77.176293';

// Test different param formats for the community endpoint
const tests = [
  { name: 'geoIdV4', url: `${BASE}/neighborhood/community?geoIdV4=${geoIdV4}` },
  { name: 'geoIdV4 as geoId', url: `${BASE}/neighborhood/community?geoId=${geoIdV4}` },
  { name: 'latitude/longitude', url: `${BASE}/neighborhood/community?latitude=${lat}&longitude=${lon}` },
  { name: 'fips', url: `${BASE}/neighborhood/community?fips=${fips}` },
  { name: 'geocoding/lat/lon', url: `${BASE}/neighborhood/community?geocodinglatitude=${lat}&geocodinglongitude=${lon}` },
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
