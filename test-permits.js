// Test script to check building permits data from ATTOM
import 'dotenv/config';
import { fetchPropertyDashboard } from './server/attom.js';

// Test with a known address (you can change this to your test property)
const testAddress = '123 Main St, Los Angeles, CA 90012';

console.log('Testing ATTOM building permits fetch...');
console.log('Address:', testAddress);

try {
  const result = await fetchPropertyDashboard({ 
    address: testAddress, 
    includeComponents: false 
  });
  
  console.log('\n=== RESULT ===');
  console.log('Summary address:', result.summary?.address);
  console.log('Has building_permits:', !!result.building_permits);
  console.log('Building permits count:', result.building_permits?.length || 0);
  
  if (result.building_permits && result.building_permits.length > 0) {
    console.log('\n=== BUILDING PERMITS ===');
    result.building_permits.forEach((permit, idx) => {
      console.log(`\nPermit ${idx + 1}:`);
      console.log('  Type:', permit.permit_type_description || permit.permit_type);
      console.log('  Date:', permit.issue_date);
      console.log('  Number:', permit.permit_number);
      console.log('  Cost:', permit.estimated_cost);
      console.log('  Status:', permit.status);
    });
  } else {
    console.log('\nNo building permits found for this address');
  }
  
} catch (error) {
  console.error('Error:', error.message);
}
