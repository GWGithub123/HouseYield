#!/usr/bin/env node

/**
 * Test Script for AI Maintenance Issue Detection & Provider Search
 * 
 * This script tests the complete flow:
 * 1. Analyze sample maintenance emails
 * 2. Detect unresolved issues
 * 3. Auto-search for repair providers
 * 
 * Usage: node server/test-maintenance-search.js
 */

import 'dotenv/config';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

// Sample maintenance emails to test
const testEmails = [
  {
    name: 'Urgent Plumbing Leak',
    emailContent: `Hi,

There's a serious water leak under the kitchen sink. Water is dripping constantly and I've had to put a bucket under it. The cabinet is getting wet and I'm worried about water damage.

This started yesterday evening and is getting worse. Please send someone as soon as possible!

Thanks,
Sarah`,
    subject: 'Urgent: Kitchen sink leak',
    from: 'sarah.tenant@example.com'
  },
  {
    name: 'HVAC Issue',
    emailContent: `Hello,

The heating system is not working. I've tried adjusting the thermostat but nothing happens. The unit makes a clicking sound when I try to turn it on, but no heat comes out.

It's getting quite cold in the apartment, especially at night. Can you please send an HVAC technician to take a look?

Best regards,
Michael`,
    subject: 'No heat in apartment',
    from: 'michael.jones@example.com'
  },
  {
    name: 'Pest Control',
    emailContent: `Hi there,

I've been hearing scratching noises in the walls, particularly at night. I think there might be mice or rats in the building. I've also seen some droppings in the kitchen corner.

This is really concerning from a health perspective. Could you please arrange for pest control to come out?

Thank you,
Lisa`,
    subject: 'Rodent problem - need pest control',
    from: 'lisa.martinez@example.com'
  },
  {
    name: 'Electrical Issue',
    emailContent: `Good morning,

Several outlets in the bedroom stopped working yesterday. I checked the breaker box and they all look fine. I'm worried this might be a wiring problem.

I need to use my laptop for work so this is causing issues. Please send an electrician when possible.

Thanks,
David`,
    subject: 'Bedroom outlets not working',
    from: 'david.smith@example.com'
  },
  {
    name: 'Non-Maintenance (Rent Payment)',
    emailContent: `Hi,

I wanted to confirm that I submitted my rent payment for October through the online portal yesterday. The confirmation number is #12345.

Let me know if you need any additional information.

Best,
Jennifer`,
    subject: 'Rent payment confirmation',
    from: 'jennifer.lee@example.com'
  }
];

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(text) {
  console.log('\n' + '='.repeat(80));
  log(text, 'bright');
  console.log('='.repeat(80) + '\n');
}

async function testEmailAnalysis() {
  header('TEST 1: Email Analysis - Maintenance Issue Detection');

  for (const email of testEmails) {
    log(`\nTesting: ${email.name}`, 'cyan');
    log('-'.repeat(60), 'cyan');

    try {
      const response = await fetch(`${SERVER_URL}/api/tenant-emails/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailContent: email.emailContent,
          subject: email.subject,
          from: email.from
        })
      });

      const result = await response.json();

      if (result.isMaintenanceIssue) {
        log('✅ MAINTENANCE ISSUE DETECTED', 'green');
        log(`   Issue: ${result.issue}`, 'yellow');
        log(`   Category: ${result.serviceCategory}`, 'blue');
        log(`   Urgency: ${result.urgency}`, 'magenta');
        log(`   Confidence: ${result.confidence}%`, 'cyan');
        log(`   Search Query: "${result.searchQuery}"`, 'blue');
      } else {
        log('❌ NOT a maintenance issue', 'red');
        log(`   Reason: ${result.reasoning}`, 'yellow');
      }
    } catch (error) {
      log(`❌ Error: ${error.message}`, 'red');
    }
  }
}

async function testProviderSearch() {
  header('TEST 2: Provider Search - Finding Repair Companies');

  const testCases = [
    {
      name: 'Emergency Plumber',
      issue: 'water leak under kitchen sink',
      location: 'Potomac Maryland',
      category: 'plumbing',
      urgency: 'emergency'
    },
    {
      name: 'HVAC Repair',
      issue: 'heating system not working',
      location: 'Bethesda Maryland',
      category: 'hvac',
      urgency: 'high'
    },
    {
      name: 'Pest Control',
      issue: 'rodent infestation in walls',
      location: 'Rockville Maryland',
      category: 'pest',
      urgency: 'high'
    }
  ];

  for (const testCase of testCases) {
    log(`\nSearching for: ${testCase.name}`, 'cyan');
    log('-'.repeat(60), 'cyan');

    try {
      const url = new URL(`${SERVER_URL}/service-search`);
      url.searchParams.set('issue', testCase.issue);
      url.searchParams.set('location', testCase.location);
      url.searchParams.set('service', 'true');
      url.searchParams.set('num', '5');

      const response = await fetch(url.toString());
      const result = await response.json();

      if (result.ok && result.bestProvider) {
        log('✅ PROVIDER FOUND', 'green');
        log(`   Company: ${result.bestProvider.title}`, 'yellow');
        log(`   Phone: ${result.bestProvider.phone || 'N/A'}`, 'blue');
        log(`   Address: ${result.bestProvider.address || 'N/A'}`, 'blue');
        log(`   Email: ${result.bestProvider.primaryEmail || 'N/A'}`, 'blue');
        log(`   Website: ${result.bestProvider.link}`, 'cyan');
        log(`   Confidence: ${Math.round((result.bestMeta?.confidence || 0) * 100)}%`, 'magenta');
      } else {
        log('❌ No providers found', 'red');
        if (result.error) {
          log(`   Error: ${result.error}`, 'yellow');
        }
      }
    } catch (error) {
      log(`❌ Error: ${error.message}`, 'red');
    }
  }
}

async function testIntegratedFlow() {
  header('TEST 3: Integrated Flow - Email to Provider');

  log('This test simulates the complete flow:', 'cyan');
  log('1. Tenant sends maintenance email', 'blue');
  log('2. AI analyzes and detects issue', 'blue');
  log('3. System searches for providers', 'blue');
  log('4. Best provider is identified\n', 'blue');

  const sampleEmail = testEmails[0]; // Use the plumbing leak email

  log('Step 1: Analyzing tenant email...', 'yellow');
  
  try {
    const analyzeResponse = await fetch(`${SERVER_URL}/api/tenant-emails/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailContent: sampleEmail.emailContent,
        subject: sampleEmail.subject,
        from: sampleEmail.from
      })
    });

    const analysis = await analyzeResponse.json();

    if (analysis.isMaintenanceIssue) {
      log('✅ Maintenance issue detected!', 'green');
      log(`   Issue: ${analysis.issue}`, 'cyan');
      log(`   Urgency: ${analysis.urgency}`, 'magenta');
      log(`   AI-generated search query: "${analysis.searchQuery}"`, 'blue');

      log('\nStep 2: Searching for repair providers...', 'yellow');

      const searchUrl = new URL(`${SERVER_URL}/service-search`);
      searchUrl.searchParams.set('q', analysis.searchQuery);
      searchUrl.searchParams.set('issue', analysis.issue);
      searchUrl.searchParams.set('location', analysis.location || 'Maryland');
      searchUrl.searchParams.set('service', 'true');

      const searchResponse = await fetch(searchUrl.toString());
      const searchResult = await searchResponse.json();

      if (searchResult.ok && searchResult.bestProvider) {
        log('✅ Provider found!', 'green');
        log(`   Company: ${searchResult.bestProvider.title}`, 'yellow');
        log(`   Phone: ${searchResult.bestProvider.phone || 'N/A'}`, 'blue');
        log(`   Email: ${searchResult.bestProvider.primaryEmail || 'N/A'}`, 'blue');
        
        log('\n✨ INTEGRATION COMPLETE!', 'green');
        log('   Property manager can now contact this provider.', 'cyan');
      } else {
        log('❌ No suitable providers found', 'red');
      }
    } else {
      log('❌ Not detected as maintenance issue', 'red');
    }
  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
  }
}

async function checkServerHealth() {
  try {
    const response = await fetch(`${SERVER_URL}/health`).catch(() => null);
    if (!response || !response.ok) {
      throw new Error('Server not responding');
    }
    return true;
  } catch (error) {
    return false;
  }
}

// Main execution
async function main() {
  console.clear();
  
  header('🏠 AI Maintenance Issue Detection & Provider Search - TEST SUITE');
  
  log('Server URL: ' + SERVER_URL, 'cyan');
  log('Date: ' + new Date().toLocaleString(), 'blue');
  
  // Check server health
  log('\nChecking server connection...', 'yellow');
  const isHealthy = await checkServerHealth();
  
  if (!isHealthy) {
    log('❌ Cannot connect to server!', 'red');
    log(`   Make sure the server is running on ${SERVER_URL}`, 'yellow');
    log('   Start with: npm run push-server\n', 'cyan');
    process.exit(1);
  }
  
  log('✅ Server is running\n', 'green');

  // Check for required environment variables
  const requiredEnvVars = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CSE_CX'];
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missingVars.length > 0) {
    log('⚠️  Warning: Missing environment variables:', 'yellow');
    missingVars.forEach(v => log(`   - ${v}`, 'red'));
    log('\n   Some tests may fail. See AI_MAINTENANCE_SEARCH.md for setup.\n', 'cyan');
  }

  // Run tests
  try {
    await testEmailAnalysis();
    await testProviderSearch();
    await testIntegratedFlow();
    
    header('✅ TEST SUITE COMPLETE');
    log('All tests finished. Review results above.\n', 'green');
  } catch (error) {
    log(`\n❌ Test suite failed: ${error.message}`, 'red');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
