import 'dotenv/config';

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
console.log('API Key present:', !!ATTOM_API_KEY);

// Test address - you can change this to test different properties
const testAddress = '11822 Prestwick Rd, Potomac MD, 20854';

// ATTOM mortgage/lien endpoints to test (from official API list)
const endpoints = [
  ['property/detailmortgage', 'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detailmortgage'],
  ['property/detailmortgageowner', 'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detailmortgageowner'],
  ['sale/detail', 'https://api.gateway.attomdata.com/propertyapi/v1.0.0/sale/detail'],
  ['transaction/salestrend', 'https://api.gateway.attomdata.com/propertyapi/v1.0.0/transaction/salestrend'],
];

async function testMortgageData() {
  console.log('\n=== Testing ATTOM Mortgage/Lien Data ===');
  console.log('Address:', testAddress);
  console.log('');
  
  // First, get property details to extract ATTOM ID
  console.log('\n--- Getting Property Details (for ATTOM ID) ---');
  const detailUrl = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail';
  const detailParams = new URLSearchParams({ address: testAddress });
  
  let attomId = null;
  
  try {
    const resp = await fetch(detailUrl + '?' + detailParams, {
      headers: {
        'accept': 'application/json',
        'apikey': ATTOM_API_KEY
      }
    });
    
    console.log('Property Detail Status:', resp.status);
    
    if (resp.status === 200) {
      const data = await resp.json();
      const prop = data.property?.[0] || data.property;
      attomId = prop?.identifier?.attomId;
      console.log('ATTOM ID:', attomId);
      console.log('\nProperty Info:', JSON.stringify({
        address: prop?.address?.oneLine,
        yearBuilt: prop?.summary?.yearBuilt,
        beds: prop?.building?.rooms?.beds,
        baths: prop?.building?.rooms?.bathstotal
      }, null, 2));
    }
  } catch (err) {
    console.error('Error getting property details:', err.message);
  }
  
  // Now test mortgage endpoints with both address and ID
  for (const [name, url] of endpoints) {
    console.log(`\n--- Testing ${name} endpoint ---`);
    console.log('URL:', url);
    
    // Try with address first
    console.log('\nAttempt 1: Using address...');
    const params1 = new URLSearchParams({ address: testAddress });
    
    try {
      const resp = await fetch(url + '?' + params1, {
        headers: {
          'accept': 'application/json',
          'apikey': ATTOM_API_KEY
        }
      });
      
      console.log('Status:', resp.status);
      
      if (resp.status === 200) {
        const data = await resp.json();
        console.log('\n✅ SUCCESS! Response Data:');
        console.log(JSON.stringify(data, null, 2));
        continue; // Skip ID attempt if address worked
      } else {
        const text = await resp.text();
        console.log('Error:', text.substring(0, 200));
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
    
    // Try with ATTOM ID if we have it
    if (attomId) {
      console.log('\nAttempt 2: Using ATTOM ID...');
      const params2 = new URLSearchParams({ id: attomId });
      
      try {
        const resp = await fetch(url + '?' + params2, {
          headers: {
            'accept': 'application/json',
            'apikey': ATTOM_API_KEY
          }
        });
        
        console.log('Status:', resp.status);
        
        if (resp.status === 200) {
          const data = await resp.json();
          console.log('\n✅ SUCCESS! Response Data:');
          console.log(JSON.stringify(data, null, 2));
        } else {
          const text = await resp.text();
          console.log('Error:', text.substring(0, 200));
        }
      } catch (err) {
        console.error('Error:', err.message);
      }
    }
  }
}

testMortgageData();
