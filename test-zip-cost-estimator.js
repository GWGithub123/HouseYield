/**
 * Test script for Zip Code Cost Estimator
 * Tests basic functionality with a single project type
 */

import 'dotenv/config';
import { getZipCodeCostEstimate } from './server/zip-cost-estimator.js';

console.log('\n========================================');
console.log('🧪 Testing Zip Code Cost Estimator');
console.log('========================================\n');

async function testBasicEstimate() {
  console.log('📍 Test 1: Kitchen Remodel in Potomac, MD (20854)');
  console.log('─'.repeat(50));
  
  const result = await getZipCodeCostEstimate(
    'kitchen remodel',
    '20854',
    { projectSize: 'medium', materials: 'mid-range' }
  );

  if (result.ok) {
    console.log('✅ SUCCESS!\n');
    console.log('Project:', result.projectType);
    console.log('Location:', result.location);
    console.log('Zip Code:', result.zipCode);
    console.log('\n💰 Cost Range:');
    console.log(`   Low:     $${result.costRange.low.toLocaleString()}`);
    console.log(`   Average: $${result.costRange.average.toLocaleString()}`);
    console.log(`   High:    $${result.costRange.high.toLocaleString()}`);
    console.log(`\n📊 Confidence: ${result.confidence.toUpperCase()}`);
    console.log(`📚 Sources: ${result.sourcesCount} websites analyzed`);
    
    if (result.costFactors && result.costFactors.length > 0) {
      console.log(`\n🔧 Cost Factors:`);
      result.costFactors.forEach(factor => console.log(`   • ${factor}`));
    }
    
    if (result.notes) {
      console.log(`\n📝 Notes: ${result.notes}`);
    }
    
    console.log(`\n🔍 Search Query Used: "${result.searchQuery}"`);
    
    console.log(`\n📄 Top Sources:`);
    result.sources.slice(0, 3).forEach((source, idx) => {
      console.log(`   ${idx + 1}. ${source.title}`);
      console.log(`      ${source.link}`);
    });
    
  } else {
    console.log('❌ FAILED:', result.error);
  }
}

async function testDifferentLocation() {
  console.log('\n\n📍 Test 2: Roof Replacement in Seattle, WA (98101)');
  console.log('─'.repeat(50));
  
  const result = await getZipCodeCostEstimate(
    'roof replacement',
    '98101'
  );

  if (result.ok) {
    console.log('✅ SUCCESS!\n');
    console.log('Project:', result.projectType);
    console.log('Location:', result.location);
    console.log('\n💰 Cost Range:');
    console.log(`   Low:     $${result.costRange.low.toLocaleString()}`);
    console.log(`   Average: $${result.costRange.average.toLocaleString()}`);
    console.log(`   High:    $${result.costRange.high.toLocaleString()}`);
    console.log(`\n📊 Confidence: ${result.confidence.toUpperCase()}`);
    console.log(`📚 Sources: ${result.sourcesCount} websites analyzed`);
  } else {
    console.log('❌ FAILED:', result.error);
  }
}

async function testLowCostProject() {
  console.log('\n\n📍 Test 3: Interior Painting in Austin, TX (78701)');
  console.log('─'.repeat(50));
  
  const result = await getZipCodeCostEstimate(
    'interior painting',
    '78701',
    { projectSize: 'small' }
  );

  if (result.ok) {
    console.log('✅ SUCCESS!\n');
    console.log('Project:', result.projectType);
    console.log('Location:', result.location);
    console.log('\n💰 Cost Range:');
    console.log(`   Low:     $${result.costRange.low.toLocaleString()}`);
    console.log(`   Average: $${result.costRange.average.toLocaleString()}`);
    console.log(`   High:    $${result.costRange.high.toLocaleString()}`);
    console.log(`\n📊 Confidence: ${result.confidence.toUpperCase()}`);
  } else {
    console.log('❌ FAILED:', result.error);
  }
}

// Run all tests
async function runTests() {
  try {
    await testBasicEstimate();
    await testDifferentLocation();
    await testLowCostProject();
    
    console.log('\n========================================');
    console.log('✅ All tests completed!');
    console.log('========================================\n');
    
  } catch (error) {
    console.error('\n❌ Test error:', error);
    process.exit(1);
  }
}

runTests();
