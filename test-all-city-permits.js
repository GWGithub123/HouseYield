const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Test addresses that should have permits
const testCases = [
  {
    city: 'Los Angeles',
    address: '1600 Vine St',
    baseUrl: 'https://data.lacity.org/resource/xnhu-aczu.json',
    searchField: 'street_name',
    orderField: 'issue_date'
  },
  {
    city: 'San Francisco',
    address: '1 Market St',
    baseUrl: 'https://data.sfgov.org/resource/i98e-djp9.json',
    searchField: 'street_name',
    orderField: 'filed_date'
  },
  {
    city: 'New York',
    address: '350 5th Ave', // Empire State Building
    baseUrl: 'https://data.cityofnewyork.us/resource/rbx6-tga4.json',
    searchField: 'house_no',
    orderField: 'issued_date'
  },
  {
    city: 'Chicago',
    address: '233 S Wacker Dr', // Willis Tower
    baseUrl: 'https://data.cityofchicago.org/resource/ydr8-5enu.json',
    searchField: 'street_name',
    orderField: 'issue_date'
  },
  {
    city: 'Austin',
    address: '200 Congress Ave',
    baseUrl: 'https://data.austintexas.gov/resource/quv8-5ckq.json',
    searchField: 'permit_location',
    orderField: 'issue_date'
  }
];

async function testCityPermits(testCase) {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing ${testCase.city}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Address: ${testCase.address}`);
    
    const cleanAddress = testCase.address.split(',')[0].trim().toUpperCase();
    
    // For LA, extract just the street name
    let searchValue = cleanAddress;
    if (testCase.city === 'Los Angeles') {
      const parts = cleanAddress.split(' ');
      searchValue = parts.length > 2 ? parts.slice(1, -1).join(' ') : parts[1] || '';
    }
    
    const params = new URLSearchParams({
      $where: `upper(${testCase.searchField}) like '%${searchValue}%'`,
      $limit: 5,
      $order: `${testCase.orderField} DESC`
    });
    
    const url = `${testCase.baseUrl}?${params}`;
    console.log(`\nFetching from: ${url.substring(0, 100)}...`);
    
    const response = await fetch(url);
    console.log(`Response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`❌ Error: ${errorText.substring(0, 200)}`);
      return { city: testCase.city, success: false, error: errorText.substring(0, 100) };
    }
    
    const data = await response.json();
    console.log(`✅ Found ${data.length} permits`);
    
    if (data.length > 0) {
      console.log('\nFirst permit details:');
      const permit = data[0];
      const keys = Object.keys(permit);
      console.log(`  Available fields (${keys.length}):`, keys.slice(0, 10).join(', '), '...');
      
      // Show sample data
      console.log('\n  Sample data:');
      Object.entries(permit).slice(0, 8).forEach(([key, value]) => {
        const displayValue = typeof value === 'string' && value.length > 50 
          ? value.substring(0, 50) + '...' 
          : value;
        console.log(`    ${key}: ${displayValue}`);
      });
    }
    
    return { city: testCase.city, success: true, count: data.length };
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return { city: testCase.city, success: false, error: error.message };
  }
}

async function runAllTests() {
  console.log('Testing Municipality Permit APIs');
  console.log('='.repeat(60));
  
  const results = [];
  
  for (const testCase of testCases) {
    const result = await testCityPermits(testCase);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
  }
  
  console.log('\n\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  results.forEach(result => {
    const status = result.success ? '✅' : '❌';
    const details = result.success 
      ? `${result.count} permits found`
      : `Error: ${result.error}`;
    console.log(`${status} ${result.city}: ${details}`);
  });
  
  const successCount = results.filter(r => r.success).length;
  console.log(`\nTotal: ${successCount}/${results.length} APIs working`);
}

runAllTests();
