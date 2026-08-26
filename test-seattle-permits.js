const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function testSeattlePermits() {
  try {
    // Use an address we know has permits
    const address = '1012 NE 70TH ST';
    const baseUrl = 'https://data.seattle.gov/resource/76t5-zqzr.json';
    
    console.log('Testing Seattle Permits API');
    console.log('Address:', address);
    
    const searchPatterns = [address];
    
    for (const pattern of searchPatterns) {
      console.log('\n\n=== Testing pattern:', pattern, '===');
      
      const params = new URLSearchParams({
        $where: `upper(originaladdress1) like '%${pattern}%'`,
        $limit: 10,
        $order: 'issueddate DESC'
      });
      
      const url = `${baseUrl}?${params}`;
      console.log('Fetching from:', url);
      
      const response = await fetch(url);
      console.log('Response status:', response.status);
      
      if (!response.ok) {
        console.log('Error response:', await response.text());
        continue;
      }
      
      const data = await response.json();
      console.log('Found', data.length, 'permits');
      
      if (data.length > 0) {
        console.log('\nPermits found! Displaying all results:\n');
        data.forEach((permit, i) => {
          console.log(`--- Permit ${i + 1} ---`);
          console.log('Permit #:', permit.permitnum);
          console.log('Class:', permit.permitclass || permit.permitclassmapped);
          console.log('Type:', permit.permittypedesc || permit.permittypemapped);
          console.log('Status:', permit.statuscurrent);
          console.log('Description:', permit.description?.substring(0, 100) + '...');
          console.log('Address:', permit.originaladdress1);
          console.log('Related:', permit.relatedmup || 'N/A');
          console.log('Housing Units:', permit.housingunits || 'N/A');
          console.log();
        });
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testSeattlePermits();

