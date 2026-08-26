/**
 * Unit test for zip code extraction helper
 */

console.log('\n========================================');
console.log('🧪 Testing Zip Code Extraction');
console.log('========================================\n');

// Copy of the helper function we added to server
function extractZipCode(address) {
  if (!address) return null;
  
  // Strategy 1: Look for zip code after state abbreviation (most common pattern)
  // Matches: "MD 20854" or "MD20854" or "Maryland 20854"
  const stateZipMatch = address.match(/\b[A-Z]{2}\s*(\d{5})(?:-\d{4})?\b/);
  if (stateZipMatch) return stateZipMatch[1];
  
  // Strategy 2: Look for zip code at the end of the address
  const endZipMatch = address.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (endZipMatch) return endZipMatch[1];
  
  // Strategy 3: Look for any 5-digit number that's not at the beginning (to avoid street numbers)
  // Must be preceded by a comma or space
  const anyZipMatch = address.match(/[,\s](\d{5})(?:-\d{4})?\b/);
  if (anyZipMatch) return anyZipMatch[1];
  
  return null;
}

// Test cases
const testCases = [
  {
    address: '10301 Glen Road, Potomac, MD 20854',
    expected: '20854',
    description: 'Standard address with 5-digit zip'
  },
  {
    address: '123 Main Street, Seattle, WA 98101-1234',
    expected: '98101',
    description: 'Address with ZIP+4 format'
  },
  {
    address: '456 Oak Ave, Austin, TX 78701',
    expected: '78701',
    description: 'Simple address with zip at end'
  },
  {
    address: 'No zip code here',
    expected: null,
    description: 'Address without zip code'
  },
  {
    address: '',
    expected: null,
    description: 'Empty address'
  },
  {
    address: null,
    expected: null,
    description: 'Null address'
  }
];

let passed = 0;
let failed = 0;

testCases.forEach((test, idx) => {
  const result = extractZipCode(test.address);
  const success = result === test.expected;
  
  if (success) {
    console.log(`✅ Test ${idx + 1}: ${test.description}`);
    console.log(`   Address: "${test.address}"`);
    console.log(`   Extracted: ${result}`);
    passed++;
  } else {
    console.log(`❌ Test ${idx + 1}: ${test.description}`);
    console.log(`   Address: "${test.address}"`);
    console.log(`   Expected: ${test.expected}`);
    console.log(`   Got: ${result}`);
    failed++;
  }
  console.log('');
});

console.log('========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed === 0) {
  console.log('🎉 All tests passed! Zip code extraction working correctly.\n');
  process.exit(0);
} else {
  console.log('⚠️  Some tests failed. Check implementation.\n');
  process.exit(1);
}
