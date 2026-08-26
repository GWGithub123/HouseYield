#!/usr/bin/env node

/**
 * Shelly Integration Test Script
 * Run this to verify your Shelly Cloud integration is working
 */

const BASE_URL = process.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';

console.log('🧪 Testing Shelly Integration...\n');

async function runTests() {
  let passedTests = 0;
  let totalTests = 0;

  // Test 1: Health Check
  console.log('Test 1: Health Check');
  console.log('─────────────────────────────');
  try {
    totalTests++;
    const response = await fetch(`${BASE_URL}/api/iot/shelly/health`);
    const data = await response.json();
    
    console.log('Status:', data.status);
    console.log('Message:', data.message);
    console.log('Configured:', data.configured);
    
    if (data.configured && data.deviceCount !== undefined) {
      console.log('Device Count:', data.deviceCount);
      console.log('Online Devices:', data.onlineDevices);
    }
    
    if (data.status === 'ok') {
      console.log('✅ PASSED\n');
      passedTests++;
    } else if (data.status === 'not_configured') {
      console.log('⚠️  NOT CONFIGURED - Set SHELLY_CLOUD_AUTH_KEY in .env\n');
    } else {
      console.log('❌ FAILED:', data.message, '\n');
    }
  } catch (error) {
    console.log('❌ FAILED:', error.message, '\n');
  }

  // Test 2: Get All Sensors
  console.log('Test 2: Get All Sensors');
  console.log('─────────────────────────────');
  try {
    totalTests++;
    const response = await fetch(`${BASE_URL}/api/iot/shelly/sensors`);
    const data = await response.json();
    
    if (Array.isArray(data)) {
      console.log(`Found ${data.length} sensor(s)`);
      
      data.forEach((sensor, i) => {
        console.log(`\nSensor ${i + 1}:`);
        console.log('  Name:', sensor.name);
        console.log('  Location:', sensor.location);
        console.log('  Status:', sensor.status);
        console.log('  Flooded:', sensor.isFlooded ? '🚨 YES' : '✅ No');
        console.log('  Battery:', sensor.batteryLevel + '%');
        console.log('  Temperature:', sensor.temperature ? sensor.temperature + '°C' : 'N/A');
        console.log('  Signal (RSSI):', sensor.rssi ? sensor.rssi + ' dBm' : 'N/A');
      });
      
      console.log('\n✅ PASSED\n');
      passedTests++;
    } else if (data.error === 'Shelly service not configured') {
      console.log('⚠️  NOT CONFIGURED\n');
    } else {
      console.log('❌ FAILED: Invalid response\n');
    }
  } catch (error) {
    console.log('❌ FAILED:', error.message, '\n');
  }

  // Test 3: Webhook Endpoint
  console.log('Test 3: Webhook Endpoint');
  console.log('─────────────────────────────');
  try {
    totalTests++;
    const testPayload = {
      device_id: 'test-device-123',
      device_name: 'Test Sensor',
      location: 'Test Location',
      flood: true,
      battery_level: 85,
      temperature: 22.5,
      timestamp: new Date().toISOString()
    };
    
    const response = await fetch(`${BASE_URL}/api/iot/shelly/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Webhook endpoint working');
      console.log('Alert created successfully\n');
      passedTests++;
    } else {
      console.log('❌ FAILED: Webhook processing failed\n');
    }
  } catch (error) {
    console.log('❌ FAILED:', error.message, '\n');
  }

  // Test 4: Integration with Main IoT System
  console.log('Test 4: IoT System Status');
  console.log('─────────────────────────────');
  try {
    totalTests++;
    const response = await fetch(`${BASE_URL}/api/iot/system-status`);
    const data = await response.json();
    
    console.log('Total Sensors:', data.totalSensors);
    console.log('Online Sensors:', data.onlineSensors);
    console.log('Active Alerts:', data.activeAlerts);
    console.log('All Systems Online:', data.allSystemsOnline ? '✅ Yes' : '⚠️  No');
    
    console.log('✅ PASSED\n');
    passedTests++;
  } catch (error) {
    console.log('❌ FAILED:', error.message, '\n');
  }

  // Summary
  console.log('═════════════════════════════');
  console.log('Test Summary');
  console.log('═════════════════════════════');
  console.log(`Passed: ${passedTests}/${totalTests}`);
  console.log(`Failed: ${totalTests - passedTests}/${totalTests}`);
  
  if (passedTests === totalTests) {
    console.log('\n🎉 All tests passed! Integration is working correctly.');
  } else if (passedTests === 0) {
    console.log('\n❌ All tests failed. Check that:');
    console.log('   1. Backend server is running (npm run push-server)');
    console.log('   2. SHELLY_CLOUD_AUTH_KEY is set in .env');
    console.log('   3. SHELLY_DEVICE_IDS contains valid device IDs');
  } else {
    console.log('\n⚠️  Some tests failed. Check the output above for details.');
  }
  
  console.log('\nFor detailed setup instructions, see:');
  console.log('  - SHELLY_QUICK_START.md');
  console.log('  - SHELLY_FLOOD_INTEGRATION_GUIDE.md\n');
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
