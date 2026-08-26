/**
 * Test script for room dimension calculation
 * Tests the /calculate-dimensions endpoint with sample depth data
 */

import fetch from 'node-fetch';

const BACKEND_URL = 'http://localhost:3001';

// Sample depth maps from a room scan (typical ZoeDepth output for a room)
const sampleDepthMaps = [
  {
    minDepth: 0.5,   // 0.5m to closest wall
    maxDepth: 5.2,   // 5.2m to far wall
    isMetricDepth: true,
    orientation: { alpha: 0, beta: 45, gamma: 0, absolute: false }
  },
  {
    minDepth: 0.4,
    maxDepth: 4.8,
    isMetricDepth: true,
    orientation: { alpha: 90, beta: 45, gamma: 0, absolute: false }
  },
  {
    minDepth: 0.6,
    maxDepth: 5.5,
    isMetricDepth: true,
    orientation: { alpha: 180, beta: 45, gamma: 0, absolute: false }
  },
  {
    minDepth: 0.5,
    maxDepth: 4.9,
    isMetricDepth: true,
    orientation: { alpha: 270, beta: 45, gamma: 0, absolute: false }
  }
];

async function testDimensionCalculation() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 Testing Room Dimension Calculation');
  console.log('='.repeat(80) + '\n');

  console.log(`Sending request to: ${BACKEND_URL}/api/room-scanner/calculate-dimensions`);
  console.log(`Sample depth maps: ${sampleDepthMaps.length}`);
  console.log('\nDepth data:');
  sampleDepthMaps.forEach((map, idx) => {
    console.log(`  ${idx + 1}. minDepth: ${map.minDepth}m, maxDepth: ${map.maxDepth}m, orientation: ${map.orientation.alpha}°`);
  });

  try {
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/calculate-dimensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        depthMaps: sampleDepthMaps,
        cameraFov: 70,
        imageWidth: 1920,
        imageHeight: 1080
      })
    });

    console.log(`\nResponse status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Error response:', errorText);
      return;
    }

    const result = await response.json();
    
    console.log('\n✅ SUCCESS! Dimensions calculated:\n');
    console.log(JSON.stringify(result, null, 2));

    if (result.success && result.dimensions) {
      const dims = result.dimensions;
      console.log('\n📏 Room Dimensions:');
      console.log(`   Width:  ${dims.widthFeet.toFixed(1)} ft (${dims.widthMeters.toFixed(2)} m)`);
      console.log(`   Length: ${dims.lengthFeet.toFixed(1)} ft (${dims.lengthMeters.toFixed(2)} m)`);
      console.log(`   Height: ${dims.heightFeet.toFixed(1)} ft (${dims.heightMeters.toFixed(2)} m)`);
      console.log(`\n📐 Areas:`);
      console.log(`   Floor: ${dims.floorAreaSqFt} sq ft (${dims.floorAreaSqM.toFixed(2)} sq m)`);
      console.log(`   Walls: ${dims.wallAreaSqFt} sq ft (${dims.wallAreaSqM.toFixed(2)} sq m)`);
      console.log(`\n📊 Quality:`);
      console.log(`   Confidence: ${(dims.confidence * 100).toFixed(0)}%`);
      console.log(`   Accuracy: ${dims.estimatedAccuracy}`);
      console.log(`   Method: ${dims.methodology}`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Test completed successfully!');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    console.log('\n' + '='.repeat(80) + '\n');
  }
}

// Run the test
testDimensionCalculation();
