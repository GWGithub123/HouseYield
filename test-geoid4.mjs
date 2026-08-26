import 'dotenv/config';

const address = '11822 Prestwick Rd, Potomac, MD 20854';
const baseUrl = 'http://localhost:3001';
const url = `${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(address)}&skipCache=1&raw=2`;
const resp = await fetch(url);
const json = await resp.json();
const data = json.data || json;
const comps = data.components || {};

// List all components and their status
for (const [name, comp] of Object.entries(comps)) {
  if (comp && typeof comp === 'object') {
    console.log(name, ':', comp.ok ? 'OK' : `FAIL(${comp.status})`);
  }
}

// Get identifier from the first successful property endpoint
for (const key of ['expandedprofile', 'detail', 'basicprofile', 'detailwithschools']) {
  const comp = comps[key];
  if (comp && comp.ok && comp.data) {
    const prop = comp.data.property;
    const p = Array.isArray(prop) ? prop[0] : prop;
    if (p) {
      console.log('\nFrom', key, ':');
      console.log('identifier:', JSON.stringify(p.identifier));
      console.log('area keys:', p.area ? Object.keys(p.area) : 'none');
      console.log('area:', JSON.stringify(p.area));
      break;
    }
  }
}

process.exit(0);
