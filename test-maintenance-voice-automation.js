#!/usr/bin/env node
/**
 * AI Maintenance Automation - Voice Call Integration Example
 * 
 * This script demonstrates how to:
 * 1. Analyze a tenant email for maintenance issues
 * 2. Extract issue details and tenant availability
 * 3. Automatically call a maintenance provider with all the context
 */

import { analyzeTenantEmail, formatMaintenanceContextForCall } from './server/tenant-email-monitor.js';
import fetch from 'node-fetch';

// Example tenant email content
const EXAMPLE_EMAIL = {
  subject: "Urgent: Kitchen sink is leaking",
  from: "tenant@example.com",
  content: `Hi Property Management,

The kitchen sink in my unit (Apt 2B) is leaking badly under the cabinet. Water is pooling on the floor and I'm worried about damage. This needs to be fixed ASAP!

I'm available for a maintenance visit:
- Weekdays after 5pm
- Any time on weekends
- I work from home on Wednesdays, so morning works too

My phone is 555-123-4567 if you need to reach me.

Property address: 123 Main St, Potomac, MD 20854

Thanks,
Sarah Johnson`
};

// Maintenance provider info
const PROVIDER_PHONE = '+15551234567'; // Replace with actual provider number

async function demonstrateAutomation() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   AI MAINTENANCE AUTOMATION - VOICE CALL DEMO             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log('📧 STEP 1: Analyzing tenant email...\n');
  
  // Analyze the email
  const analysis = await analyzeTenantEmail(
    EXAMPLE_EMAIL.content,
    EXAMPLE_EMAIL.subject,
    EXAMPLE_EMAIL.from
  );

  if (!analysis.ok || !analysis.isMaintenanceIssue) {
    console.error('❌ No maintenance issue detected in email');
    return;
  }

  console.log('✅ Maintenance issue detected!');
  console.log('   Issue:', analysis.issue);
  console.log('   Urgency:', analysis.urgency);
  console.log('   Category:', analysis.serviceCategory);
  console.log('   Location:', analysis.location);
  console.log('   Tenant Availability:', analysis.tenantAvailability || 'Not specified');
  console.log('   Tenant Phone:', analysis.tenantPhone || 'Not provided');
  console.log('   Property Address:', analysis.propertyAddress || 'Not specified');
  console.log('   Unit:', analysis.unitNumber || 'Not specified');
  console.log('');

  console.log('🔧 STEP 2: Formatting maintenance context for voice call...\n');

  // Extract tenant name from email
  const tenantNameMatch = EXAMPLE_EMAIL.content.match(/Thanks,\s*(.+)$/m);
  const tenantName = tenantNameMatch ? tenantNameMatch[1].trim() : null;

  // Format context for voice call
  const maintenanceContext = formatMaintenanceContextForCall(
    analysis,
    EXAMPLE_EMAIL.from,
    tenantName
  );

  console.log('✅ Context formatted:');
  console.log(JSON.stringify(maintenanceContext, null, 2));
  console.log('');

  console.log('📞 STEP 3: Initiating AI voice call to maintenance provider...\n');
  console.log('   Calling:', PROVIDER_PHONE);
  console.log('');

  // Make the API call to trigger voice call
  const SERVER_URL = process.env.PUBLIC_URL || 'http://localhost:3001';
  
  try {
    const response = await fetch(`${SERVER_URL}/api/voice/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: PROVIDER_PHONE,
        maintenanceContext: maintenanceContext
      })
    });

    const result = await response.json();

    if (result.ok) {
      console.log('✅ Call initiated successfully!');
      console.log('   Call SID:', result.callSid);
      console.log('   Status:', result.status);
      console.log('');
      console.log('🎙️  The AI will now:');
      console.log('   1. Call the maintenance provider');
      console.log('   2. Introduce itself professionally');
      console.log('   3. Explain the maintenance issue: "' + maintenanceContext.issue + '"');
      console.log('   4. Communicate urgency: ' + maintenanceContext.urgency);
      console.log('   5. Share tenant availability: ' + maintenanceContext.tenantAvailability);
      console.log('   6. Schedule an appointment');
      console.log('   7. Confirm all details before ending the call');
      console.log('');
    } else {
      console.error('❌ Call failed:', result.error);
    }

  } catch (error) {
    console.error('❌ Error making call:', error.message);
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   DEMO COMPLETE                                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

// Run the demonstration
if (process.argv[1] === new URL(import.meta.url).pathname) {
  demonstrateAutomation().catch(console.error);
}

export { demonstrateAutomation };
