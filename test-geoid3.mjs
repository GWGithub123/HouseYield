import 'dotenv/config';

const address = '11822 Prestwick Rd, Potomac, MD 20854';
const baseUrl = 'http://localhost:3001';
const url = `${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(address)}&skipCache=1&raw=2`;
const resp = await fetch(url);
const json = await resp.json();
const data = json.data || json;
const comps = data.components || {};

// Dump the community component error details
console.log('=== community component ===');
console.log(JSON.stringify(comps.community, null, 2));

// Dump expandedprofile identifier
const ep = comps.expandedprofile;
if (ep?.ok && ep?.data?.property) {
  const p = Array.isArray(ep.data.property) ? ep.data.property[0] : ep.data.property;
  console.log('\n=== expandedprofile identifier ===');
  console.log(JSON.stringify(p?.identifier, null, 2));
  console.log('\n=== expandedprofile area ===');
  console.log(JSON.stringify(p?.area, null, 2));
}

// Also check detailwithschools for geoIdV4 in individual school entries
const sc = comps.detailwithschools;
if (sc?.ok && sc?.data?.property) {
  const p = Array.isArray(sc.data.property) ? sc.data.property[0] : sc.data.property;
  const schoolArr = p?.school || p?.schools;
  if (Array.isArray(schoolArr) && schoolArr.length > 0) {
    console.log('\n=== first school entry keys ===');
    console.log(Object.keys(schoolArr[0]));
    console.log('geoIdV4:', schoolArr[0].geoIdV4);
  }
  console.log('\nidentifier:', JSON.stringify(p?.identifier, null, 2));
}

process.exit(0);
