#!/usr/bin/env node
/**
 * Practice maintenance owner SMS + booking call flow.
 *
 * Usage:
 *   node server/scripts/test-maintenance-owner-sms-flow.js
 *   node server/scripts/test-maintenance-owner-sms-flow.js --approve
 */

import 'dotenv/config';
import { getFirestore } from '../firebase-admin.js';
import maintenanceOwnerSmsService from '../services/maintenanceOwnerSmsService.js';

const TEST_PHONE = process.env.MAINTENANCE_OWNER_SMS_TEST_PHONE
  || process.env.TWILIO_TEST_TO_NUMBER
  || '+12026420437';

const args = new Set(process.argv.slice(2));
const shouldApprove = args.has('--approve');

async function writeTestRequest(requestId) {
  const db = getFirestore();
  const dispatchContext = {
    autoBook: true,
    category: 'plumbing',
    serviceType: 'plumbing',
    description: 'Practice maintenance issue: kitchen sink is leaking under the cabinet.',
    location: 'Kitchen',
    propertyAddress: '123 Test Property Ln, Potomac, MD 20854',
    unit: '2B',
    tenantAvailability: 'Weekdays after 5pm or weekends',
    tenantName: 'Test Tenant',
    tenantEmail: 'tenant@example.com',
    ownerId: 'test-owner-sms',
    propertyId: 'test-property',
    priority: 'high',
    createdAt: new Date().toISOString(),
  };

  const selectedProvider = {
    name: 'ARI Plumbing (Practice Provider)',
    phone: '+12404323005',
    rating: 4.9,
    reviewCount: 32,
    website: 'https://www.ariplumbing.com',
    aiScore: 92,
    address: '11816 Smoketree Rd, Potomac, MD 20854',
    selectionReasoning: 'Strong local plumbing reviews and reliable emergency response for sink leak repairs.',
  };

  await db.collection('maintenanceRequests').doc(requestId).set({
    id: requestId,
    ownerId: dispatchContext.ownerId,
    propertyAddress: dispatchContext.propertyAddress,
    description: dispatchContext.description,
    category: dispatchContext.category,
    serviceType: dispatchContext.serviceType,
    priority: dispatchContext.priority,
    location: dispatchContext.location,
    unit: dispatchContext.unit,
    tenantName: dispatchContext.tenantName,
    tenantEmail: dispatchContext.tenantEmail,
    tenantAvailability: dispatchContext.tenantAvailability,
    pendingDispatch: dispatchContext,
    activeDispatchContext: dispatchContext,
    ownerSmsNotifications: {
      ownerPhone: maintenanceOwnerSmsService.normalizePhoneNumber(TEST_PHONE),
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    },
    aiAutomation: {
      status: 'provider_found',
      selectedProvider,
      callInitiated: false,
      usedTrustedProvider: false,
    },
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return { dispatchContext, selectedProvider };
}

async function initiatePracticeCall(requestId, dispatchContext, provider) {
  const publicUrl = process.env.BACKEND_PUBLIC_URL
    || process.env.CLOUDFLARE_TUNNEL_URL
    || process.env.NGROK_URL
    || process.env.PUBLIC_URL;

  if (!publicUrl || publicUrl.includes('localhost')) {
    throw new Error('Set BACKEND_PUBLIC_URL (or a tunnel URL) so Twilio can reach voice webhooks.');
  }

  const voiceModule = await import('../voice-call.js');
  if (!voiceModule?.findProviderAndCall) {
    throw new Error('Voice call module unavailable');
  }

  const maintenanceContext = {
    issue: dispatchContext.description,
    urgency: 'high',
    serviceCategory: dispatchContext.serviceType,
    tenantAvailability: dispatchContext.tenantAvailability,
    tenantName: dispatchContext.tenantName,
    tenantEmail: dispatchContext.tenantEmail,
    propertyAddress: dispatchContext.propertyAddress,
    unitNumber: dispatchContext.unit,
    firestoreId: requestId,
    ownerId: dispatchContext.ownerId,
    providerName: provider.name,
    providerPhone: provider.phone,
  };

  return voiceModule.findProviderAndCall({
    repairType: dispatchContext.serviceType,
    serviceCategory: dispatchContext.serviceType,
    location: dispatchContext.propertyAddress,
    urgency: 'high',
    maintenanceContext,
    publicUrl,
    skipProviderSearch: true,
    preSelectedProvider: {
      ...provider,
      formatted_phone_number: provider.phone,
    },
  });
}

async function main() {
  console.log('HouseYield maintenance owner SMS practice flow');
  console.log('Target phone:', TEST_PHONE);
  console.log('SMS enabled:', maintenanceOwnerSmsService.isMaintenanceOwnerSmsEnabled());

  if (!maintenanceOwnerSmsService.isMaintenanceOwnerSmsEnabled()) {
    throw new Error('Twilio SMS is not configured. Set TWILIO credentials and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID.');
  }

  const requestId = `test_sms_${Date.now()}`;
  const { dispatchContext, selectedProvider } = await writeTestRequest(requestId);
  console.log('Created test maintenance request:', requestId);

  const smsResult = await maintenanceOwnerSmsService.sendMaintenanceOwnerProviderApprovalSms({
    id: requestId,
    ownerId: dispatchContext.ownerId,
    propertyAddress: dispatchContext.propertyAddress,
    description: dispatchContext.description,
    category: dispatchContext.category,
    priority: dispatchContext.priority,
    ownerSmsNotifications: {
      ownerPhone: maintenanceOwnerSmsService.normalizePhoneNumber(TEST_PHONE),
      status: 'confirmed',
    },
    aiAutomation: {
      status: 'provider_found',
      selectedProvider,
    },
  });

  console.log('Provider approval SMS:', smsResult.ok ? 'sent' : 'failed', smsResult.error || smsResult.status || '');

  if (!smsResult.ok) {
    process.exitCode = 1;
    return;
  }

  if (!shouldApprove) {
    console.log('\nNext steps:');
    console.log(`- Reply YES from ${TEST_PHONE} to your Twilio number to trigger the practice booking call.`);
    console.log('- Or rerun with --approve to simulate YES and place the practice call immediately.');
    console.log(`- Request ID: ${requestId}`);
    return;
  }

  console.log('\nSimulating owner YES reply...');
  const replyResult = await maintenanceOwnerSmsService.handleMaintenanceOwnerInboundSms({
    from: TEST_PHONE,
    body: 'YES',
  });
  console.log('Inbound reply result:', replyResult);

  if (!replyResult.shouldBookProvider) {
    throw new Error('Expected shouldBookProvider after YES reply');
  }

  console.log('Initiating practice booking call to', TEST_PHONE, '(not the real provider)...');
  const callResult = await initiatePracticeCall(requestId, dispatchContext, selectedProvider);
  console.log('Practice call result:', callResult.ok ? 'initiated' : 'failed', callResult.error || callResult.call?.callSid || '');
}

main().catch((error) => {
  console.error('Test failed:', error.message);
  process.exitCode = 1;
});
