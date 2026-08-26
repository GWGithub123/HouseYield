/**
 * Test Detailed (Precision) Cost Estimator
 * Tests material quantities, labor hours, and exact breakdowns
 */

import 'dotenv/config';
import { getDetailedCostEstimate } from './server/zip-cost-estimator.js';

console.log('\n========================================');
console.log('🔬 Testing DETAILED Cost Estimator');
console.log('========================================\n');

async function testKitchenRemodel() {
  console.log('📍 Test 1: Detailed Kitchen Remodel - Potomac, MD');
  console.log('─'.repeat(60));
  
  const projectDetails = {
    projectType: 'kitchen remodel',
    zipCode: '20854',
    specifications: {
      roomSize: '12x15 feet',
      cabinets: 'Replace all cabinets - 24 linear feet',
      countertops: 'Granite countertops - 36 sq ft',
      flooring: 'Hardwood flooring - 180 sq ft',
      appliances: [
        'Refrigerator - mid-range stainless',
        'Dishwasher - mid-range',
        'Range/Oven - gas, mid-range'
      ],
      plumbing: 'New sink and faucet',
      electrical: '3 new outlets, under-cabinet lighting',
      paint: 'Full room paint',
      materialQuality: 'mid-range'
    }
  };

  const result = await getDetailedCostEstimate(projectDetails);

  if (result.ok) {
    console.log('✅ SUCCESS!\n');
    
    console.log('📊 COST SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Materials Total:  $${result.summary.materialsTotal.toLocaleString()}`);
    console.log(`Labor Total:      $${result.summary.laborTotal.toLocaleString()}`);
    console.log(`─`.repeat(60));
    console.log(`GRAND TOTAL:      $${result.summary.grandTotal.toLocaleString()}`);
    console.log(`Estimate Range:   $${result.summary.lowEstimate.toLocaleString()} - $${result.summary.highEstimate.toLocaleString()}`);
    console.log(`\n🎯 Overall Confidence: ${result.confidence.toUpperCase()}\n`);
    
    console.log('🧱 MATERIALS BREAKDOWN:');
    console.log('═'.repeat(60));
    result.materials.forEach((mat, idx) => {
      console.log(`${idx + 1}. ${mat.item}`);
      console.log(`   Quantity: ${mat.quantity} ${mat.unit}`);
      console.log(`   Unit Cost: $${mat.unitCost.toLocaleString()}`);
      console.log(`   Total: $${mat.totalCost.toLocaleString()} [${mat.confidence}]`);
      console.log(`   Source: ${mat.source}`);
      console.log('');
    });
    
    console.log('👷 LABOR BREAKDOWN:');
    console.log('═'.repeat(60));
    result.labor.forEach((lab, idx) => {
      console.log(`${idx + 1}. ${lab.task}`);
      console.log(`   Trade: ${lab.tradeType}`);
      console.log(`   Hours: ${lab.hours} hrs @ $${lab.hourlyRate}/hr`);
      console.log(`   Total: $${lab.totalCost.toLocaleString()} [${lab.confidence}]`);
      console.log(`   Source: ${lab.source}`);
      console.log('');
    });
    
    if (result.additionalCosts && result.additionalCosts.length > 0) {
      console.log('💰 ADDITIONAL COSTS:');
      console.log('═'.repeat(60));
      result.additionalCosts.forEach(cost => {
        console.log(`• ${cost.item}: $${cost.estimatedCost.toLocaleString()}`);
      });
      console.log('');
    }
    
    if (result.timeline) {
      console.log(`⏱️  Estimated Timeline: ${result.timeline}\n`);
    }
    
    if (result.notes) {
      console.log(`📝 Notes: ${result.notes}\n`);
    }
    
  } else {
    console.log('❌ FAILED:', result.error);
  }
}

async function testBathroomRenovation() {
  console.log('\n\n📍 Test 2: Detailed Bathroom Renovation - Seattle, WA');
  console.log('─'.repeat(60));
  
  const projectDetails = {
    projectType: 'bathroom renovation',
    zipCode: '98101',
    specifications: {
      roomSize: '8x10 feet',
      fixtures: [
        'New toilet - standard comfort height',
        'New vanity - 36 inch with sink',
        'New shower/tub combo - fiberglass'
      ],
      flooring: 'Ceramic tile - 80 sq ft',
      wallTile: 'Shower surround tile - 60 sq ft',
      plumbing: 'Replace all fixtures and connections',
      electrical: 'New vanity light, exhaust fan',
      paint: 'Moisture-resistant paint',
      materialQuality: 'mid-range'
    }
  };

  const result = await getDetailedCostEstimate(projectDetails);

  if (result.ok) {
    console.log('✅ SUCCESS!\n');
    
    console.log('📊 COST SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Materials Total:  $${result.summary.materialsTotal.toLocaleString()}`);
    console.log(`Labor Total:      $${result.summary.laborTotal.toLocaleString()}`);
    console.log(`─`.repeat(60));
    console.log(`GRAND TOTAL:      $${result.summary.grandTotal.toLocaleString()}`);
    console.log(`Estimate Range:   $${result.summary.lowEstimate.toLocaleString()} - $${result.summary.highEstimate.toLocaleString()}`);
    console.log(`\n🎯 Overall Confidence: ${result.confidence.toUpperCase()}\n`);
    
    console.log(`🧱 Materials: ${result.materials.length} items`);
    console.log(`👷 Labor: ${result.labor.length} tasks`);
    console.log(`⏱️  Timeline: ${result.timeline}\n`);
    
  } else {
    console.log('❌ FAILED:', result.error);
  }
}

async function testSimplePaint() {
  console.log('\n\n📍 Test 3: Detailed Interior Painting - Austin, TX');
  console.log('─'.repeat(60));
  
  const projectDetails = {
    projectType: 'interior painting',
    zipCode: '78701',
    specifications: {
      rooms: 3,
      totalWallArea: '1200 sq ft',
      ceilings: 'Yes - 450 sq ft',
      trim: '200 linear feet',
      coats: 2,
      paintQuality: 'mid-grade',
      prep: 'Light sanding, patching small holes'
    }
  };

  const result = await getDetailedCostEstimate(projectDetails);

  if (result.ok) {
    console.log('✅ SUCCESS!\n');
    
    console.log('📊 COST SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Materials Total:  $${result.summary.materialsTotal.toLocaleString()}`);
    console.log(`Labor Total:      $${result.summary.laborTotal.toLocaleString()}`);
    console.log(`─`.repeat(60));
    console.log(`GRAND TOTAL:      $${result.summary.grandTotal.toLocaleString()}`);
    console.log(`\n🎯 Overall Confidence: ${result.confidence.toUpperCase()}\n`);
    
    // Show simplified view
    console.log('Materials:');
    result.materials.forEach(mat => {
      console.log(`  • ${mat.quantity} ${mat.unit} ${mat.item}: $${mat.totalCost.toLocaleString()}`);
    });
    
    console.log('\nLabor:');
    result.labor.forEach(lab => {
      console.log(`  • ${lab.task} (${lab.hours}hrs): $${lab.totalCost.toLocaleString()}`);
    });
    
  } else {
    console.log('❌ FAILED:', result.error);
  }
}

// Run tests
async function runTests() {
  try {
    await testKitchenRemodel();
    
    // Comment out these for now to save API costs during testing
    // await testBathroomRenovation();
    // await testSimplePaint();
    
    console.log('\n========================================');
    console.log('✅ Detailed estimation tests completed!');
    console.log('========================================\n');
    
  } catch (error) {
    console.error('\n❌ Test error:', error);
    process.exit(1);
  }
}

runTests();
