import 'dotenv/config';

const address = '11822 Prestwick Rd, Potomac, MD 20854';
const baseUrl = 'http://localhost:3001';
const url = `${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(address)}&skipCache=1&components=1`;
const resp = await fetch(url);
const json = await resp.json();
const data = json.data || json;
const comps = data.components || {};

// Find geoIdV4 in any component
for (const [name, comp] of Object.entries(comps)) {
  if (!comp?.ok || !comp?.data) continue;
  const props = comp.data.property;
  const p = Array.isArray(props) ? props[0] : props;
  if (!p) continue;
  
  // Check identifier
  if (p.identifier) {
    const id = p.identifier;
    const geoKeys = Object.keys(id).filter(k => k.toLowerCase().includes('geo'));
    if (geoKeys.length) {
      console.log(`${name}.identifier geo keys:`, geoKeys.map(k => `${k}=${id[k]}`));
    }
  }
  
  // Check area
  if (p.area) {
    const area = p.area;
    const geoKeys = Object.keys(area).filter(k => k.toLowerCase().includes('geo'));
    if (geoKeys.length) {
      console.log(`${name}.area geo keys:`, geoKeys.map(k => `${k}=${area[k]}`));
    }
  }
}

// Also just dump the full identifier from expandedprofile
const ep = comps.expandedprofile || comps.detail;
if (ep?.ok && ep?.data) {
  const p = Array.isArray(ep.data.property) ? ep.data.property[0] : ep.data.property;
  if (p) {
    console.log('\nFull identifier:', JSON.stringify(p?.identifier, null, 2));
    console.log('\nFull area:', JSON.stringify(p?.area, null, 2));
  }
}

process.exit(0);
