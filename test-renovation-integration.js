/**
 * Test the integrated renovation analysis with zip code cost estimator
 */

import 'dotenv/config';

console.log('\n========================================');
console.log('🧪 Testing Renovation Analysis Integration');
console.log('========================================\n');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

function normalizeCanonicalSuggestion(suggestion) {
  const canonicalResult = suggestion?.canonicalResult;
  if (!canonicalResult?.resultId) {
    return suggestion;
  }

  return {
    ...suggestion,
    id: canonicalResult.resultId,
    cost: canonicalResult.totalCost ?? suggestion.cost ?? 0,
    costRange: canonicalResult.costRange ?? suggestion.costRange,
    valueIncrease: canonicalResult.valueIncrease ?? suggestion.valueIncrease ?? 0,
    rentIncreaseDollar: canonicalResult.rentIncreaseDollar ?? suggestion.rentIncreaseDollar ?? 0,
    rentIncreasePercent: canonicalResult.rentIncreasePercent ?? suggestion.rentIncreasePercent ?? 0,
    currentRent: canonicalResult.currentRent ?? suggestion.currentRent ?? 0,
    maxPostRenovationRent: canonicalResult.maxPostRenovationRent ?? suggestion.maxPostRenovationRent ?? 0,
    marketRentBenchmark: canonicalResult.marketRentBenchmark ?? suggestion.marketRentBenchmark ?? 0,
    marketSaleBenchmark: canonicalResult.marketSaleBenchmark ?? suggestion.marketSaleBenchmark ?? 0,
    roi: canonicalResult.roi ?? suggestion.roi ?? 0,
    paybackMonths: canonicalResult.paybackMonths ?? suggestion.paybackMonths ?? null,
    confidence: canonicalResult.confidence ?? suggestion.confidence,
    timeframe: canonicalResult.timeframe ?? suggestion.timeframe,
  };
}

async function testRenovationAnalysis() {
  console.log('📸 Simulating renovation analysis request...\n');
  
  // Create a test payload with property data and mock images
  const testPayload = {
    propertyData: {
      address: '10301 Glen Road, Potomac, MD 20854',
      location: 'Potomac, MD',
      propertyValue: 650000,
      monthlyRent: 3200,
      bedrooms: 4,
      bathrooms: 2.5,
      squareFeet: 2400,
      yearBuilt: 1995
    },
    // Mock base64 image (1x1 transparent PNG)
    images: [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    ]
  };

  console.log('Property:', testPayload.propertyData.address);
  console.log('Zip Code: 20854 (should be auto-extracted)\n');

  try {
    console.log(`Sending request to ${SERVER_URL}/api/analyze-renovations...`);
    
    const response = await fetch(`${SERVER_URL}/api/analyze-renovations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Request failed:', response.status, response.statusText);
      console.error('Error:', errorText);
      return;
    }

    const result = await response.json();

    if (!result.ok) {
      console.error('❌ API returned error:', result.error);
      return;
    }

    const suggestions = (result.suggestions || []).map(normalizeCanonicalSuggestion);

    console.log('✅ SUCCESS!\n');
    console.log('═'.repeat(70));
    console.log(`Found ${suggestions.length} renovation suggestions\n`);

    suggestions.forEach((suggestion, idx) => {
      console.log(`${idx + 1}. ${suggestion.name}`);
      console.log('─'.repeat(70));
      console.log(`   Type: ${suggestion.type}`);
      console.log(`   Summary: ${suggestion.summary}`);
      console.log(`   Priority: ${suggestion.priority}`);
      if (suggestion.canonicalResult?.resultId) {
        console.log(`   Canonical Result: ${suggestion.canonicalResult.resultId}`);
      }
      console.log('');
      
      console.log('   💰 COST BREAKDOWN:');
      console.log(`      Total Cost: $${suggestion.cost.toLocaleString()}`);
      console.log(`      Range: $${suggestion.costRange.low.toLocaleString()} - $${suggestion.costRange.high.toLocaleString()}`);
      console.log('');
      
      // Check if we got detailed breakdown from zip code estimator
      if (suggestion.materialBreakdown && suggestion.materialBreakdown.length > 0) {
        console.log('   🧱 MATERIALS (Zip Code Estimator):');
        suggestion.materialBreakdown.slice(0, 5).forEach(mat => {
          if (mat.totalCost > 0) {
            console.log(`      • ${mat.quantity} ${mat.unit} ${mat.item}: $${mat.totalCost.toLocaleString()}`);
          }
        });
        if (suggestion.materialBreakdown.length > 5) {
          console.log(`      ... and ${suggestion.materialBreakdown.length - 5} more items`);
        }
        console.log('');
      }
      
      if (suggestion.laborBreakdown && suggestion.laborBreakdown.length > 0) {
        console.log('   👷 LABOR (Zip Code Estimator):');
        suggestion.laborBreakdown.slice(0, 3).forEach(labor => {
          if (labor.totalCost > 0) {
            console.log(`      • ${labor.task}: ${labor.hours}hrs × $${labor.hourlyRate}/hr = $${labor.totalCost.toLocaleString()}`);
          }
        });
        if (suggestion.laborBreakdown.length > 3) {
          console.log(`      ... and ${suggestion.laborBreakdown.length - 3} more tasks`);
        }
        console.log('');
      }
      
      console.log('   📊 FINANCIAL METRICS:');
      console.log(`      ROI: ${suggestion.roi.toFixed(1)}%`);
      console.log(`      Value Increase: $${suggestion.valueIncrease.toLocaleString()}`);
      console.log(`      Rent Increase: $${suggestion.rentIncreaseDollar}/month (${suggestion.rentIncreasePercent}%)`);
      if (suggestion.paybackMonths) {
        console.log(`      Payback Period: ${suggestion.paybackMonths} months`);
      }
      console.log('');
      
      console.log('   📋 DATA SOURCES:');
      console.log(`      AI Analysis: ${suggestion.dataSource.aiAnalysis}`);
      console.log(`      Market Data: ${suggestion.dataSource.marketData}`);
      console.log(`      Zip Code: ${suggestion.dataSource.zipCode}`);
      console.log(`      Detailed Breakdown: ${suggestion.dataSource.detailedBreakdown ? 'YES ✓' : 'NO'}`);
      if (suggestion.dataSource.detailedBreakdown) {
        console.log(`      Material Items: ${suggestion.dataSource.materialItems}`);
        console.log(`      Labor Items: ${suggestion.dataSource.laborItems}`);
      }
      console.log(`      Contractor Sources: ${suggestion.dataSource.contractorCosts}`);
      console.log(`      Confidence: ${suggestion.confidence.toUpperCase()}`);
      console.log('');
      
      console.log(`   ⏱️  Timeline: ${suggestion.timeframe}`);
      console.log('');
      console.log('═'.repeat(70));
      console.log('');
    });

    // Summary stats
    const withDetailedBreakdown = suggestions.filter(s => s.dataSource.detailedBreakdown).length;
    const totalCost = suggestions.reduce((sum, s) => sum + (s.cost || 0), 0);
    const totalRentIncrease = suggestions.reduce((sum, s) => sum + (s.rentIncreaseDollar || 0), 0);

    console.log('📈 SUMMARY STATISTICS:');
    console.log('─'.repeat(70));
    console.log(`Total Renovation Budget: $${totalCost.toLocaleString()}`);
    console.log(`Total Monthly Rent Increase: $${totalRentIncrease.toLocaleString()}`);
    console.log(`Suggestions with Detailed Breakdown: ${withDetailedBreakdown}/${suggestions.length}`);
    console.log(`Average Confidence: ${(suggestions.reduce((sum, s) => sum + (s.confidence === 'high' ? 3 : s.confidence === 'medium' ? 2 : 1), 0) / suggestions.length).toFixed(1)}/3`);
    console.log('');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error);
  }
}

console.log('⚠️  NOTE: Make sure the server is running on port 3001!');
console.log('   Run: npm run push-server\n');

// Wait a moment for user to read the note
setTimeout(() => {
  testRenovationAnalysis().then(() => {
    console.log('\n========================================');
    console.log('✅ Integration test completed!');
    console.log('========================================\n');
  });
}, 1000);
