import 'dotenv/config';

const address = '11822 Prestwick Rd, Potomac, MD 20854';
const baseUrl = 'http://localhost:3001';
const url = `${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(address)}&skipCache=1&raw=2`;
const resp = await fetch(url);
const json = await resp.json();
const data = json.data || json;
const comps = data.components || {};

const comp = comps.expandedprofile;
const d = comp.data;
console.log('expandedprofile data type:', typeof d);
console.log('expandedprofile data keys:', d ? Object.keys(d) : 'null');
if (d && d.property) {
  const prop = d.property;
  console.log('property type:', typeof prop, 'isArray:', Array.isArray(prop));
  const p = Array.isArray(prop) ? prop[0] : prop;
  if (p) {
    console.log('property keys:', Object.keys(p));
    console.log('identifier:', JSON.stringify(p.identifier));
    console.log('area:', JSON.stringify(p.area));
  }
} else if (d) {
  // Maybe the data IS the property directly
  console.log('Top-level data sample:', JSON.stringify(d).slice(0, 500));
}

process.exit(0);
