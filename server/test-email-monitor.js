/**
 * Test script for Tenant Email Monitoring
 * 
 * This script tests the email monitoring functionality by:
 * 1. Checking for new tenant emails
 * 2. Analyzing them for maintenance issues
 * 3. Auto-triggering provider searches when issues are detected
 * 
 * Usage:
 *   node server/test-email-monitor.js
 * 
 * Requirements:
 *   - Backend server running (npm run push-server)
 *   - Gmail OAuth configured (.gmail-token.json)
 *   - OPENAI_API_KEY in .env
 */

import fetch from 'node-fetch';

const SERVER_URL = process.env.VITE_PUSH_SERVER_URL || 'http://localhost:3001';

async function testEmailMonitoring() {
  console.log('🔍 Testing Tenant Email Monitoring\n');
  console.log('Server URL:', SERVER_URL);
  console.log('=' .repeat(60));

  // Test 1: Check monitor state
  console.log('\n📊 Test 1: Getting monitor state...');
  try {
    const stateResponse = await fetch(`${SERVER_URL}/api/tenant-emails/state`);
    const state = await stateResponse.json();
    
    if (state.ok) {
      console.log('✓ Monitor state retrieved:');
      console.log('  Last checked:', state.lastCheckTime || 'Never');
      console.log('  Emails checked:', state.emailsChecked || 0);
      console.log('  Issues detected:', state.issuesDetected || 0);
    } else {
      console.log('✗ Failed to get state:', state.error);
    }
  } catch (error) {
    console.error('✗ State check failed:', error.message);
  }

  // Test 2: Check for new emails (without auto-trigger first)
  console.log('\n📧 Test 2: Checking for new tenant emails...');
  try {
    const checkResponse = await fetch(`${SERVER_URL}/api/tenant-emails/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // You can specify tenant emails here, or leave empty to check all recent emails
        tenantEmails: process.env.TENANT_EMAILS || '',
        maxEmails: 10,
        autoTriggerSearch: false // Just analyze, don't trigger searches yet
      })
    });

    const checkResult = await checkResponse.json();
    
    if (checkResult.ok) {
      console.log(`✓ Checked ${checkResult.checked} email(s)`);
      console.log(`  Maintenance issues found: ${checkResult.maintenanceIssues}`);
      
      if (checkResult.results && checkResult.results.length > 0) {
        console.log('\n  Email details:');
        checkResult.results.forEach((email, i) => {
          console.log(`\n  ${i + 1}. ${email.subject}`);
          console.log(`     From: ${email.from}`);
          console.log(`     Date: ${email.date}`);
          
          if (email.analysis) {
            console.log(`     Is Maintenance: ${email.analysis.isMaintenanceIssue ? 'YES' : 'NO'}`);
            if (email.analysis.isMaintenanceIssue) {
              console.log(`     Confidence: ${email.analysis.confidence}%`);
              console.log(`     Issue: ${email.analysis.issue}`);
              console.log(`     Category: ${email.analysis.serviceCategory}`);
              console.log(`     Urgency: ${email.analysis.urgency}`);
              console.log(`     Search Query: ${email.analysis.searchQuery}`);
            }
          }
        });
      }
    } else {
      console.log('✗ Email check failed:', checkResult.error);
      return;
    }
  } catch (error) {
    console.error('✗ Email check failed:', error.message);
    return;
  }

  // Test 3: Check again with auto-trigger enabled
  console.log('\n🔧 Test 3: Checking emails WITH auto-trigger...');
  try {
    const autoResponse = await fetch(`${SERVER_URL}/api/tenant-emails/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantEmails: process.env.TENANT_EMAILS || '',
        maxEmails: 10,
        autoTriggerSearch: true // Enable automatic provider search
      })
    });

    const autoResult = await autoResponse.json();
    
    if (autoResult.ok) {
      console.log(`✓ Checked ${autoResult.checked} email(s)`);
      console.log(`  Maintenance issues: ${autoResult.maintenanceIssues}`);
      
      if (autoResult.triggeredSearches && autoResult.triggeredSearches.length > 0) {
        console.log(`\n  🎯 Auto-triggered ${autoResult.triggeredSearches.length} provider search(es):`);
        
        autoResult.triggeredSearches.forEach((search, i) => {
          console.log(`\n  ${i + 1}. Issue: ${search.issue}`);
          if (search.searchResult) {
            if (search.searchResult.error) {
              console.log(`     ✗ Search failed: ${search.searchResult.error}`);
            } else {
              console.log(`     ✓ Query used: ${search.searchResult.queryUsed}`);
              console.log(`     ✓ Providers found: ${search.searchResult.providersFound}`);
              if (search.searchResult.bestProvider) {
                console.log(`     ✓ Best match: ${search.searchResult.bestProvider}`);
              }
            }
          } else if (search.error) {
            console.log(`     ✗ Error: ${search.error}`);
          }
        });
      } else {
        console.log('  No maintenance issues found to trigger searches');
      }
    } else {
      console.log('✗ Auto-trigger check failed:', autoResult.error);
    }
  } catch (error) {
    console.error('✗ Auto-trigger check failed:', error.message);
  }

  // Test 4: Manual email analysis
  console.log('\n📝 Test 4: Testing manual email analysis...');
  const testEmail = `
Hi Property Manager,

I wanted to let you know that the toilet in the upstairs bathroom is leaking. 
Water is pooling around the base and I noticed it's been getting worse over 
the past few days. Can you please send someone to fix this?

Thanks,
Tenant
  `.trim();

  try {
    const analyzeResponse = await fetch(`${SERVER_URL}/api/tenant-emails/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailContent: testEmail,
        subject: 'Bathroom Issue',
        from: 'tenant@example.com'
      })
    });

    const analysis = await analyzeResponse.json();
    
    if (analysis.ok) {
      console.log('✓ Manual analysis completed:');
      console.log('  Is Maintenance:', analysis.isMaintenanceIssue ? 'YES' : 'NO');
      console.log('  Confidence:', analysis.confidence + '%');
      if (analysis.isMaintenanceIssue) {
        console.log('  Issue:', analysis.issue);
        console.log('  Category:', analysis.serviceCategory);
        console.log('  Urgency:', analysis.urgency);
        console.log('  Location:', analysis.location || 'not specified');
        console.log('  Search Query:', analysis.searchQuery);
        console.log('  Reasoning:', analysis.reasoning);
      }
    } else {
      console.log('✗ Analysis failed:', analysis.error);
    }
  } catch (error) {
    console.error('✗ Manual analysis failed:', error.message);
  }

  // Test 5: Get history
  console.log('\n📚 Test 5: Getting processed emails history...');
  try {
    const historyResponse = await fetch(`${SERVER_URL}/api/tenant-emails/history?limit=5`);
    const history = await historyResponse.json();
    
    if (history.ok) {
      console.log(`✓ Found ${history.total} processed email(s) in history`);
      if (history.emails && history.emails.length > 0) {
        console.log('\n  Recent maintenance issues:');
        history.emails.slice(0, 5).forEach((email, i) => {
          console.log(`\n  ${i + 1}. ${email.subject}`);
          console.log(`     Issue: ${email.analysis?.issue}`);
          console.log(`     Processed: ${new Date(email.processed).toLocaleString()}`);
        });
      }
    } else {
      console.log('✗ History retrieval failed:', history.error);
    }
  } catch (error) {
    console.error('✗ History check failed:', error.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Email monitoring tests completed\n');
}

// Run tests
testEmailMonitoring().catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});
