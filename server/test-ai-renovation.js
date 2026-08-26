/**
 * Test script for AI Renovation Analysis endpoint
 * 
 * Usage:
 *   node server/test-ai-renovation.js
 * 
 * Requirements:
 *   - Backend server running (npm run push-server)
 *   - OPENAI_API_KEY in .env file
 *   - Test image file (or will use a sample base64)
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const SERVER_URL = process.env.VITE_PUSH_SERVER_URL || 'http://localhost:3001';

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
    afterRepairValue: canonicalResult.afterRepairValue ?? suggestion.afterRepairValue ?? null,
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

// Sample small test image (1x1 red pixel PNG)
const SAMPLE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function testRenovationAnalysis() {
  console.log('🏠 Testing AI Renovation Analysis Endpoint\n');
  console.log('Server URL:', SERVER_URL);
  console.log('Endpoint: POST /api/analyze-renovations\n');

  // Sample property data
  const propertyData = {
    address: '123 Main Street',
    location: 'Austin, TX',
    monthlyRent: 2500,
    propertyValue: 450000,
    bedrooms: 3,
    bathrooms: 2,
    squareFeet: 1800,
    yearBuilt: 1995
  };

  // For testing, you can replace this with actual image files
  let images = [];
  
  // Check if any test images exist in public/submissions
  const testImageDir = path.join(process.cwd(), 'public', 'submissions');
  if (fs.existsSync(testImageDir)) {
    const files = fs.readdirSync(testImageDir)
      .filter(f => f.match(/\.(jpg|jpeg|png|gif)$/i))
      .slice(0, 3); // Take up to 3 images
    
    if (files.length > 0) {
      console.log(`📁 Found ${files.length} test image(s) in public/submissions/`);
      images = files.map(file => {
        const filePath = path.join(testImageDir, file);
        const imageData = fs.readFileSync(filePath);
        const base64 = imageData.toString('base64');
        const ext = path.extname(file).slice(1).toLowerCase();
        const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
        return `data:${mimeType};base64,${base64}`;
      });
    }
  }
  
  // Fallback to sample image
  if (images.length === 0) {
    console.log('⚠️  No test images found, using sample 1x1 pixel image');
    console.log('   (Results will be generic. Add images to public/submissions/ for better testing)\n');
    images = [SAMPLE_IMAGE];
  }

  const requestBody = {
    images,
    propertyData
  };

  console.log('📤 Sending request...');
  console.log(`   Images: ${images.length}`);
  console.log(`   Property: ${propertyData.address}\n`);

  try {
    const startTime = Date.now();
    
    const response = await fetch(`${SERVER_URL}/api/analyze-renovations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`⏱️  Response time: ${duration}s`);
    console.log(`📊 Status: ${response.status} ${response.statusText}\n`);

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error('❌ Error:', result.error || 'Unknown error');
      console.error('Full response:', JSON.stringify(result, null, 2));
      process.exit(1);
    }

    const suggestions = (result.suggestions || []).map(normalizeCanonicalSuggestion);

    console.log('✅ Analysis completed successfully!\n');
    console.log(`📋 Received ${suggestions.length} renovation suggestions\n`);

    if (suggestions.length > 0) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 RENOVATION SUGGESTIONS:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      suggestions.forEach((suggestion, idx) => {
        const roi = Number(suggestion.roi || 0).toFixed(1);
        
        console.log(`${idx + 1}. ${suggestion.name}`);
        console.log(`   Priority: ${suggestion.priority.toUpperCase()}`);
        console.log(`   Summary: ${suggestion.summary}`);
        if (suggestion.canonicalResult?.resultId) {
          console.log(`   Canonical Result: ${suggestion.canonicalResult.resultId}`);
        }
        console.log(`   Cost: $${suggestion.cost.toLocaleString()}`);
        console.log(`   Value Increase: $${suggestion.valueIncrease.toLocaleString()}`);
        console.log(`   ROI: ${roi}%`);
        console.log(`   Rent Increase: $${suggestion.rentIncreaseDollar}/month (${suggestion.rentIncreasePercent}%)`);
        console.log(`   Timeframe: ${suggestion.timeframe}`);
        if (suggestion.details) {
          console.log(`   Details: ${suggestion.details.substring(0, 100)}${suggestion.details.length > 100 ? '...' : ''}`);
        }
        console.log();
      });

      // Summary stats
      const totalCost = suggestions.reduce((sum, s) => sum + (s.cost || 0), 0);
      const totalValueIncrease = suggestions.reduce((sum, s) => sum + (s.valueIncrease || 0), 0);
      const totalRentIncrease = suggestions.reduce((sum, s) => sum + (s.rentIncreaseDollar || 0), 0);
      const totalModeledReturn = suggestions.reduce((sum, s) => sum + (s.valueIncrease || 0) + ((s.rentIncreaseDollar || 0) * 12 * 5), 0);
      const overallROI = totalCost > 0 ? ((totalModeledReturn / totalCost) * 100).toFixed(1) : '0.0';

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📈 SUMMARY (All Renovations):');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`   Total Investment: $${totalCost.toLocaleString()}`);
      console.log(`   Total Value Increase: $${totalValueIncrease.toLocaleString()}`);
      console.log(`   Overall Modeled ROI: ${overallROI}%`);
      console.log(`   Total Rent Increase: $${totalRentIncrease.toLocaleString()}/month`);
      console.log(`   Annual Rent Increase: $${(totalRentIncrease * 12).toLocaleString()}/year`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }

    console.log('✅ Test completed successfully!');
    console.log('\nℹ️  For better results, add actual property images to public/submissions/');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('\nTroubleshooting:');
    console.error('  1. Is the backend server running? (npm run push-server)');
    console.error('  2. Is OPENAI_API_KEY set in .env?');
    console.error('  3. Check server logs for errors');
    console.error(`  4. Try: curl ${SERVER_URL}/healthz`);
    process.exit(1);
  }
}

// Run the test
testRenovationAnalysis();
