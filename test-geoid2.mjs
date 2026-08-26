import 'dotenv/config';

const address = '11822 Prestwick Rd, Potomac, MD 20854';
const baseUrl = 'http://localhost:3001';
const url = `${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(address)}&skipCache=1&raw=2`;
console.log('Fetching dashboard with raw=2...');
const resp = await fetch(url);
const json = await resp.json();

if (!json.ok) {
  console.error('Error:', json.error);
  process.exit(1);
}

const data = json.data || json;
const comps = data.components || {};
console.log('Component keys:', Object.keys(comps));

// Check each component for geoIdV4
for (const [name, comp] of Object.entries(comps)) {
  if (!comp || typeof comp !== 'object') continue;
  const ok = comp.ok;
  if (!ok) continue;
  const d = comp.data;
  if (!d) continue;
  
  const str = JSON.stringify(d);
  if (str.includes('geoIdV4') || str.includes('geoid') || str.includes('GeoId')) {
    const matches = str.match(/"geo[Ii]d[^"]*"\s*:\s*"[^"]+"/g);
    if (matches) {
      console.log(`${name}: ${matches.slice(0, 3).join(', ')}`);
    }
  }
}

process.exit(0);
