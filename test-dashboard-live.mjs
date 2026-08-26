import 'dotenv/config';

const address = '11822 Prestwick Rd, Potomac, MD 20854';
const baseUrl = 'http://localhost:3001';
const url = `${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(address)}&skipCache=1`;

console.log('Fetching:', url);
const resp = await fetch(url);
const json = await resp.json();

if (!json.ok) {
  console.error('Error:', json.error);
  process.exit(1);
}

const data = json.data || json;
console.log('\nTop-level keys:', Object.keys(data));
console.log('has community:', !!data.community, data.community ? JSON.stringify(data.community).slice(0, 200) : '');
console.log('has schools:', !!data.schools, 'count:', data.schools?.length || 0);
console.log('has school_district:', !!data.school_district);
console.log('fips:', data.summary?.area_context?.fips);
console.log('state_code:', data.summary?.area_context?.state_code);

if (data.schools?.length > 0) {
  console.log('\nFirst school:', JSON.stringify(data.schools[0]));
}

process.exit(0);
