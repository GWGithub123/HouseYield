// Test MLS property search with images
import 'dotenv/config';
import snowflake from './snowflake.js';

async function test() {
  // First, let's see what statuses exist
  console.log('Checking available statuses...');
  const statuses = await snowflake.executeQuery(`
    SELECT "STANDARDSTATUS", COUNT(*) as cnt 
    FROM "Property" 
    GROUP BY "STANDARDSTATUS" 
    ORDER BY cnt DESC
  `);
  console.log('Property statuses:');
  statuses.forEach(s => console.log(`  - ${s.STANDARDSTATUS}: ${s.CNT}`));
  
  // Check cities
  console.log('\nTop cities:');
  const cities = await snowflake.executeQuery(`
    SELECT "CITY", COUNT(*) as cnt 
    FROM "Property" 
    GROUP BY "CITY" 
    ORDER BY cnt DESC 
    LIMIT 10
  `);
  cities.forEach(c => console.log(`  - ${c.CITY}: ${c.CNT}`));
  
  // Now search without status filter
  console.log('\nSearching for any properties in Maryland...\n');
  const properties = await snowflake.searchMLSPropertiesWithImages({
    state: 'MD',
    limit: 3,
    status: null // Remove status filter
  });
  
  console.log(`Found ${properties.length} properties:\n`);
  properties.forEach((p, i) => {
    console.log(`${i+1}. ${p.STREETNUMBER} ${p.STREETNAME} ${p.STREETSUFFIX || ''}`);
    console.log(`   ${p.CITY}, ${p.STATEORPROVINCE} ${p.POSTALCODE}`);
    console.log(`   $${p.LISTPRICE?.toLocaleString()} | ${p.BEDROOMSTOTAL} bed | ${p.BATHROOMSTOTALINTEGER} bath`);
    console.log(`   Status: ${p.STANDARDSTATUS}`);
    console.log(`   Image: ${p.primaryImage || 'No image'}`);
    console.log('');
  });
  
  await snowflake.disconnect();
}
test();
