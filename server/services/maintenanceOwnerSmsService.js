/**
 * Maintenance Owner SMS Confirmation Service
 *
 * Sends text message notifications to property owners when maintenance requests
 * are submitted and at key workflow milestones. Owners can reply YES/CONFIRM to
 * acknowledge a new request, or NO/HOLD to pause dispatch.
 */

import twilio from 'twilio';
import { getFirestore } from '../firebase-admin.js';
import {
  isPracticeModeEnabled,
  resolvePracticeCallPhone,
  resolvePracticeSmsPhone,
} from '../utils/practiceTestPhone.js';
import { resolveAddressFromPropertyId } from '../utils/sensorAlertOwner.js';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || '';
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const MAINTENANCE_OWNER_SMS_ENABLED = process.env.MAINTENANCE_OWNER_SMS_ENABLED !== '0';
const MAINTENANCE_OWNER_SMS_BLOCK_DISPATCH = process.env.MAINTENANCE_OWNER_SMS_BLOCK_DISPATCH !== '0';
const MAINTENANCE_OWNER_SMS_REQUIRE_PROVIDER_APPROVAL = process.env.MAINTENANCE_OWNER_SMS_REQUIRE_PROVIDER_APPROVAL !== '0';
const MAINTENANCE_OWNER_SMS_TEST_PHONE = process.env.MAINTENANCE_OWNER_SMS_TEST_PHONE
  || process.env.TWILIO_TEST_TO_NUMBER
  || '';

const MAINTENANCE_REQUESTS_COLLECTION = 'maintenanceRequests';
const MAINTENANCE_SMS_PENDING_COLLECTION = 'maintenanceOwnerSmsPending';
const USERS_COLLECTION = 'users';

let twilioClient = null;

function getDb() {
  try {
    return getFirestore();
  } catch {
    return null;
  }
}

function initTwilioClient() {
  if (twilioClient) {
    return twilioClient;
  }

  if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
    twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID });
  } else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }

  return twilioClient;
}

export function isMaintenanceOwnerSmsEnabled() {
  const hasSender = Boolean(TWILIO_MESSAGING_SERVICE_SID || TWILIO_FROM_NUMBER);
  return MAINTENANCE_OWNER_SMS_ENABLED && hasSender && Boolean(initTwilioClient());
}

export function shouldBlockDispatchUntilOwnerConfirm() {
  return MAINTENANCE_OWNER_SMS_BLOCK_DISPATCH;
}

export function shouldRequireProviderApprovalBeforeCall() {
  return isMaintenanceOwnerSmsEnabled() && MAINTENANCE_OWNER_SMS_REQUIRE_PROVIDER_APPROVAL;
}

function isNonProductionRuntime() {
  return process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE;
}

function resolvePracticeTestPhoneOverride(request) {
  return request?.practiceTestPhone
    || request?.ownerSmsNotifications?.practiceTestPhone
    || null;
}

function resolveSmsDestinationPhone(ownerPhone, practiceTestPhoneOverride = null) {
  if (isPracticeModeEnabled()) {
    return resolvePracticeSmsPhone(practiceTestPhoneOverride);
  }
  if (isNonProductionRuntime() && MAINTENANCE_OWNER_SMS_TEST_PHONE) {
    return normalizePhoneNumber(MAINTENANCE_OWNER_SMS_TEST_PHONE);
  }
  return ownerPhone;
}

export function shouldHoldDispatchForOwnerSms(ownerSmsResult) {
  if (!shouldBlockDispatchUntilOwnerConfirm()) {
    return false;
  }
  return Boolean(
    ownerSmsResult?.ok
    && ownerSmsResult?.confirmationState?.status === 'pending'
  );
}

export function normalizePhoneNumber(rawPhone = '') {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) {
    return '';
  }
  if (digits.length === 10) {
    digits = `1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (String(rawPhone).trim().startsWith('+')) {
    return `+${digits}`;
  }
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function truncate(text = '', max = 140) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function priorityLabel(priority = 'normal') {
  const value = String(priority || 'normal').toLowerCase();
  if (value === 'urgent' || value === 'emergency') {
    return 'URGENT';
  }
  if (value === 'high') {
    return 'High priority';
  }
  return 'New';
}

async function resolveOwnerPhone(ownerId) {
  if (!ownerId) {
    return '';
  }

  const db = getDb();
  if (!db) {
    return '';
  }

  try {
    const userDoc = await db.collection(USERS_COLLECTION).doc(ownerId).get();
    if (!userDoc.exists) {
      return '';
    }

    const userData = userDoc.data() || {};
    const ownerProfile = userData.ownerProfile && typeof userData.ownerProfile === 'object'
      ? userData.ownerProfile
      : {};

    if (!ownerProfile.maintenanceSmsConsent
      && !(isNonProductionRuntime() && MAINTENANCE_OWNER_SMS_TEST_PHONE)
      && !isPracticeModeEnabled()) {
      return '';
    }

    const rawPhone = userData.phone
      || ownerProfile.phone
      || ownerProfile.contactPhone
      || '';

    return resolveSmsDestinationPhone(normalizePhoneNumber(rawPhone), null);
  } catch (error) {
    console.warn('[MaintenanceOwnerSMS] Failed to resolve owner phone:', error.message);
    return '';
  }
}

async function resolveOwnerName(ownerId, fallback = 'Property owner') {
  if (!ownerId) {
    return fallback;
  }

  const db = getDb();
  if (!db) {
    return fallback;
  }

  try {
    const userDoc = await db.collection(USERS_COLLECTION).doc(ownerId).get();
    if (!userDoc.exists) {
      return fallback;
    }
    const userData = userDoc.data() || {};
    return userData.name
      || userData.ownerProfile?.fullName
      || userData.displayName
      || fallback;
  } catch {
    return fallback;
  }
}

function formatTwilioDeliveryError(errorCode, errorMessage) {
  if (Number(errorCode) === 30034) {
    return 'SMS blocked by carrier (Twilio error 30034): your sending number is not registered for US A2P 10DLC. In Twilio Console, create an A2P Campaign on your Messaging Service and wait for approval.';
  }
  if (errorMessage) {
    return errorMessage;
  }
  if (errorCode) {
    return `Twilio delivery error ${errorCode}`;
  }
  return 'SMS delivery failed';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveMessageDelivery(client, messageSid) {
  const terminalStatuses = new Set(['delivered', 'undelivered', 'failed', 'canceled']);
  let message = await client.messages(messageSid).fetch();

  if (terminalStatuses.has(message.status)) {
    return message;
  }

  for (const delayMs of [1500, 2000, 2500]) {
    await sleep(delayMs);
    message = await client.messages(messageSid).fetch();
    if (terminalStatuses.has(message.status)) {
      return message;
    }
  }

  return message;
}

export async function sendOwnerInboundConfirmationSms(to, body) {
  const message = String(body || '').trim();
  if (!message) {
    return { ok: false, skipped: true, reason: 'empty_message' };
  }
  return sendSms(to, message);
}

async function sendSms(to, body) {
  const client = initTwilioClient();
  if (!client || (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_FROM_NUMBER)) {
    return { ok: false, error: 'Twilio SMS is not configured' };
  }

  const normalizedTo = normalizePhoneNumber(to);
  if (!normalizedTo) {
    return { ok: false, error: 'Invalid destination phone number' };
  }

  try {
    const createParams = {
      body,
      to: normalizedTo,
    };

    if (TWILIO_MESSAGING_SERVICE_SID) {
      createParams.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
    } else {
      createParams.from = TWILIO_FROM_NUMBER;
    }

    const message = await client.messages.create(createParams);
    const finalMessage = await resolveMessageDelivery(client, message.sid);
    const deliveryFailed = ['undelivered', 'failed', 'canceled'].includes(finalMessage.status);

    if (deliveryFailed) {
      const error = formatTwilioDeliveryError(finalMessage.errorCode, finalMessage.errorMessage);
      console.error('[MaintenanceOwnerSMS] SMS delivery failed:', {
        messageSid: finalMessage.sid,
        status: finalMessage.status,
        errorCode: finalMessage.errorCode,
        to: normalizedTo,
        error,
      });
      return {
        ok: false,
        error,
        messageSid: finalMessage.sid,
        to: normalizedTo,
        status: finalMessage.status,
        errorCode: finalMessage.errorCode,
      };
    }

    return {
      ok: true,
      messageSid: finalMessage.sid,
      to: normalizedTo,
      status: finalMessage.status,
    };
  } catch (error) {
    console.error('[MaintenanceOwnerSMS] SMS send failed:', error.message);
    return { ok: false, error: error.message };
  }
}

function formatPropertyAddress(request = {}) {
  const propertyId = request.propertyId
    || request.pendingDispatch?.propertyId
    || request.activeDispatchContext?.propertyId;
  let address = String(request.propertyAddress || '').trim();
  const decoded = resolveAddressFromPropertyId(propertyId || '');
  const looksLikeSensorLabel = !address
    || /^flood sensor\b/i.test(address)
    || /^sensor\b/i.test(address);

  if (decoded && looksLikeSensorLabel) {
    address = decoded.includes(' Rd') || decoded.includes(' Road') || decoded.includes(',')
      ? decoded
      : `${decoded} Rd`;
  }

  return truncate(address || decoded || 'your property', 80);
}

function buildPracticeModeNotice() {
  if (!isPracticeModeEnabled()) {
    return '';
  }

  const testPhone = formatProviderPhone(resolvePracticeSmsPhone());
  return `Practice mode: notifications routed to test number ${testPhone}.`;
}

function finalizeOwnerSmsBody(lines) {
  const body = Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || '');
  const practiceNotice = buildPracticeModeNotice();
  return practiceNotice ? `${body}\n\n${practiceNotice}` : body;
}

function buildSubmittedMessage(request, ownerName) {
  const priority = priorityLabel(request.priority);
  const address = formatPropertyAddress(request);
  const issue = truncate(request.description || 'Maintenance issue reported', 120);
  const reporter = request.tenantName ? `Reported by: ${request.tenantName}` : null;

  return finalizeOwnerSmsBody([
    'HouseYield — New Maintenance Request',
    '',
    `Property: ${address}`,
    `Issue: ${issue}`,
    reporter,
    `Priority: ${priority}`,
    '',
    'Reply YES to authorize dispatch and provider search.',
    'Reply NO to hold this request.',
  ]);
}

function formatProviderPhone(phone = '') {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) {
    return 'Phone not listed';
  }
  const digits = normalized.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    const area = digits.slice(1, 4);
    const prefix = digits.slice(4, 7);
    const line = digits.slice(7);
    return `(${area}) ${prefix}-${line}`;
  }
  return normalized;
}

function buildProviderTrackRecordSummary(provider = {}) {
  const parts = [];
  if (provider.aiScore != null) {
    parts.push(`AI match score ${Math.round(Number(provider.aiScore))}/100`);
  }
  if (provider.selectionReasoning) {
    parts.push(truncate(provider.selectionReasoning, 90));
  } else if (provider.reviewAnalysis?.summary) {
    parts.push(truncate(provider.reviewAnalysis.summary, 90));
  } else if (provider.trustedNote) {
    parts.push(truncate(provider.trustedNote, 90));
  } else if (provider.isTrusted) {
    parts.push('Pre-approved trusted provider on your account');
  }
  if (provider.reviewCount) {
    parts.push(`${provider.reviewCount} verified reviews`);
  }
  return parts.length > 0 ? parts.join('. ') : 'Strong local track record for this type of repair';
}

function buildProviderApprovalMessage(request) {
  const provider = request.aiAutomation?.selectedProvider || {};
  const address = formatPropertyAddress(request);
  const issue = truncate(request.description || 'Maintenance issue reported', 110);
  const providerName = provider.name || 'Recommended provider';
  const rating = provider.rating != null ? `${Number(provider.rating).toFixed(1)}/5` : 'Not rated';
  const phone = formatProviderPhone(provider.phone);
  const website = provider.website ? truncate(provider.website, 60) : '';
  const trackRecord = truncate(buildProviderTrackRecordSummary(provider), 120);
  const priority = priorityLabel(request.priority);

  const lines = [
    'HouseYield — Provider Authorization Required',
    '',
    `Property: ${address}`,
    `Issue: ${issue}`,
    `Priority: ${priority}`,
    '',
    `Recommended provider: ${providerName}`,
    `Contact: ${phone} | Rating: ${rating}`,
    `Why this provider: ${trackRecord}`,
  ];

  if (website) {
    lines.push(`Website: ${website}`);
  }

  lines.push(
    '',
    'Reply YES to authorize HouseYield to schedule service.',
    'Reply NO to decline or suggest another provider (e.g. "No - ABC Plumbing 301-555-1234").',
  );

  return finalizeOwnerSmsBody(lines);
}

function buildProviderConnectedMessage(request) {
  const providerName = request.aiAutomation?.selectedProvider?.name || 'A provider';
  const address = truncate(request.propertyAddress || 'your property', 80);
  return `HouseYield: ${providerName} was connected for maintenance at ${address}. We are scheduling the visit now.`;
}

function buildVisitScheduledMessage(request) {
  const visit = request.scheduledVisit || {};
  const providerName = visit.providerName || request.aiAutomation?.selectedProvider?.name || 'Provider';
  const start = visit.startAt ? new Date(visit.startAt) : null;
  const when = start && !Number.isNaN(start.getTime())
    ? start.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: visit.timezone || 'America/New_York',
    })
    : 'soon';

  return `HouseYield: Maintenance visit scheduled with ${providerName} on ${when} at ${truncate(request.propertyAddress || 'your property', 80)}.`;
}

function buildServiceCompletedMessage(request) {
  return `HouseYield: Maintenance service was marked complete at ${truncate(request.propertyAddress || 'your property', 80)}. Payment processing will follow if applicable.`;
}

function buildProviderPaidMessage(request) {
  const amount = Number(request.paymentWorkflow?.amount || 0);
  const amountLabel = Number.isFinite(amount) && amount > 0
    ? `$${amount.toFixed(2)}`
    : 'the maintenance invoice';
  return `HouseYield: ${amountLabel} was paid to the maintenance provider for ${truncate(request.propertyAddress || 'your property', 80)}.`;
}

async function persistOwnerSmsState(requestId, patch) {
  const db = getDb();
  if (!db || !requestId) {
    return { ok: false, error: 'Database unavailable' };
  }

  try {
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId).set({
      ownerSmsNotifications: patch,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return { ok: true };
  } catch (error) {
    console.error('[MaintenanceOwnerSMS] Failed to persist SMS state:', error.message);
    return { ok: false, error: error.message };
  }
}

async function registerPendingConfirmation({ requestId, ownerId, ownerPhone, phase = 'dispatch' }) {
  const db = getDb();
  if (!db) {
    return;
  }

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  await db.collection(MAINTENANCE_SMS_PENDING_COLLECTION).doc(requestId).set({
    requestId,
    ownerId,
    ownerPhone,
    phase,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt,
  }, { merge: true });
}

async function clearPendingConfirmation(requestId) {
  const db = getDb();
  if (!db || !requestId) {
    return;
  }
  await db.collection(MAINTENANCE_SMS_PENDING_COLLECTION).doc(requestId).delete().catch(() => {});
}

async function clearOtherPendingProviderApprovals(ownerPhone, activeRequestId) {
  const db = getDb();
  if (!db || !ownerPhone) {
    return;
  }

  const normalizedPhone = normalizePhoneNumber(ownerPhone);
  const snapshot = await db.collection(MAINTENANCE_SMS_PENDING_COLLECTION)
    .where('ownerPhone', '==', normalizedPhone)
    .where('status', '==', 'pending')
    .limit(20)
    .get()
    .catch(() => null);

  if (!snapshot || snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (data.requestId && data.requestId !== activeRequestId) {
      batch.delete(doc.ref);
    }
  });
  await batch.commit().catch(() => {});
}

async function clearDispatchPendingForPhone(ownerPhone) {
  const db = getDb();
  if (!db || !ownerPhone) {
    return;
  }

  const normalizedPhone = normalizePhoneNumber(ownerPhone);
  const snapshot = await db.collection(MAINTENANCE_SMS_PENDING_COLLECTION)
    .where('ownerPhone', '==', normalizedPhone)
    .where('status', '==', 'pending')
    .limit(20)
    .get()
    .catch(() => null);

  if (!snapshot || snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    const data = doc.data() || {};
    if ((data.phase || 'dispatch') === 'dispatch') {
      batch.delete(doc.ref);
    }
  });
  await batch.commit().catch(() => {});
}

async function appendOwnerSmsUpdate(requestId, existingNotifications, updateEntry) {
  const updates = Array.isArray(existingNotifications?.updates)
    ? [...existingNotifications.updates, updateEntry]
    : [updateEntry];

  await persistOwnerSmsState(requestId, {
    ...existingNotifications,
    updates,
  });
}

export async function sendMaintenanceOwnerSubmittedSms(request) {
  if (!isMaintenanceOwnerSmsEnabled() || !request?.id || !request?.ownerId) {
    return { ok: false, skipped: true, reason: 'sms_disabled_or_missing_owner' };
  }

  const rawOwnerPhone = request.ownerSmsNotifications?.ownerPhone || await resolveOwnerPhone(request.ownerId);
  if (!rawOwnerPhone && !isPracticeModeEnabled()) {
    return { ok: false, skipped: true, reason: 'owner_phone_missing' };
  }

  const ownerPhone = resolveSmsDestinationPhone(rawOwnerPhone, resolvePracticeTestPhoneOverride(request));
  if (!ownerPhone) {
    return { ok: false, skipped: true, reason: 'owner_phone_missing' };
  }

  const ownerName = await resolveOwnerName(request.ownerId);
  const body = buildSubmittedMessage(request, ownerName);
  const result = await sendSms(ownerPhone, body);

  const confirmationState = {
    enabled: true,
    ownerPhone,
    practiceTestPhone: resolvePracticeSmsPhone(resolvePracticeTestPhoneOverride(request)),
    status: result.ok ? 'pending' : 'send_failed',
    sentAt: result.ok ? new Date().toISOString() : null,
    messageSid: result.messageSid || null,
    confirmedAt: null,
    declinedAt: null,
    lastReply: null,
    lastError: result.error || null,
    updates: [],
  };

  await persistOwnerSmsState(request.id, confirmationState);

  if (result.ok) {
    await registerPendingConfirmation({
      requestId: request.id,
      ownerId: request.ownerId,
      ownerPhone,
    });
  }

  console.log('[MaintenanceOwnerSMS] Submission SMS', result.ok ? 'sent' : 'failed', request.id, ownerPhone);
  return { ...result, ownerPhone, confirmationState };
}

export async function sendMaintenanceOwnerProviderApprovalSms(request) {
  if (!isMaintenanceOwnerSmsEnabled() || !request?.id || !request?.ownerId) {
    return { ok: false, skipped: true, reason: 'sms_disabled_or_missing_owner' };
  }

  const selectedProvider = request.aiAutomation?.selectedProvider;
  if (!selectedProvider?.name) {
    return { ok: false, skipped: true, reason: 'provider_missing' };
  }

  const rawOwnerPhone = request.ownerSmsNotifications?.ownerPhone || await resolveOwnerPhone(request.ownerId);
  if (!rawOwnerPhone && !isPracticeModeEnabled()) {
    return { ok: false, skipped: true, reason: 'owner_phone_missing' };
  }

  const ownerPhone = resolveSmsDestinationPhone(rawOwnerPhone, resolvePracticeTestPhoneOverride(request));
  if (!ownerPhone) {
    return { ok: false, skipped: true, reason: 'owner_phone_missing' };
  }

  const body = buildProviderApprovalMessage(request);
  const result = await sendSms(ownerPhone, body);

  const providerApprovalState = {
    enabled: true,
    ownerPhone,
    practiceTestPhone: resolvePracticeSmsPhone(resolvePracticeTestPhoneOverride(request)),
    phase: 'provider',
    status: result.ok ? 'pending' : 'send_failed',
    sentAt: result.ok ? new Date().toISOString() : null,
    messageSid: result.messageSid || null,
    providerApprovedAt: null,
    providerDeclinedAt: null,
    lastReply: null,
    lastError: result.error || null,
    selectedProviderSnapshot: {
      name: selectedProvider.name,
      phone: selectedProvider.phone || '',
      rating: selectedProvider.rating ?? null,
      website: selectedProvider.website || '',
    },
  };

  const existing = request.ownerSmsNotifications || {};
  await persistOwnerSmsState(request.id, {
    ...existing,
    providerApproval: providerApprovalState,
  });

  if (result.ok) {
    await clearDispatchPendingForPhone(ownerPhone);
    await clearOtherPendingProviderApprovals(ownerPhone, request.id);
    await registerPendingConfirmation({
      requestId: request.id,
      ownerId: request.ownerId,
      ownerPhone,
      phase: 'provider',
    });
  }

  console.log('[MaintenanceOwnerSMS] Provider approval SMS', result.ok ? 'sent' : 'failed', request.id, ownerPhone);
  return {
    ...result,
    ownerPhone,
    confirmationState: providerApprovalState,
  };
}

export function shouldHoldProviderCallForOwnerSms(providerSmsResult) {
  if (!shouldRequireProviderApprovalBeforeCall()) {
    return false;
  }
  return Boolean(
    providerSmsResult?.ok
    && providerSmsResult?.confirmationState?.status === 'pending'
  );
}

export async function sendMaintenanceOwnerUpdateSms(request, event) {
  if (!isMaintenanceOwnerSmsEnabled() || !request?.id || !request?.ownerId) {
    return { ok: false, skipped: true, reason: 'sms_disabled_or_missing_owner' };
  }

  const ownerPhone = request.ownerSmsNotifications?.ownerPhone || await resolveOwnerPhone(request.ownerId);
  if (!ownerPhone) {
    return { ok: false, skipped: true, reason: 'owner_phone_missing' };
  }

  const existing = request.ownerSmsNotifications || {};
  const alreadySent = Array.isArray(existing.updates)
    && existing.updates.some((entry) => entry.event === event);
  if (alreadySent) {
    return { ok: true, skipped: true, reason: 'already_sent' };
  }

  let body = '';
  switch (event) {
    case 'provider_connected':
      body = buildProviderConnectedMessage(request);
      break;
    case 'visit_scheduled':
      body = buildVisitScheduledMessage(request);
      break;
    case 'service_completed':
      body = buildServiceCompletedMessage(request);
      break;
    case 'provider_paid':
      body = buildProviderPaidMessage(request);
      break;
    default:
      return { ok: false, skipped: true, reason: 'unknown_event' };
  }

  const result = await sendSms(ownerPhone, body);
  if (result.ok) {
    await appendOwnerSmsUpdate(request.id, existing, {
      event,
      sentAt: new Date().toISOString(),
      messageSid: result.messageSid,
    });
  }

  console.log('[MaintenanceOwnerSMS] Update SMS', event, result.ok ? 'sent' : 'failed', request.id);
  return result;
}

function parseAlternateProviderSuggestion(body = '') {
  const raw = String(body || '').trim();
  const noMatch = raw.match(/^no\b\s*[-–:]?\s*(.+)$/i);
  if (!noMatch) {
    return null;
  }

  const remainder = noMatch[1].trim();
  if (!remainder) {
    return null;
  }

  const phoneMatch = remainder.match(/(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
  if (!phoneMatch) {
    return null;
  }

  const phone = normalizePhoneNumber(phoneMatch[0]);
  const name = remainder
    .replace(phoneMatch[0], '')
    .replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '')
    .trim();

  if (!phone) {
    return null;
  }

  return {
    name: name || 'Owner suggested provider',
    phone,
  };
}

function providerKey(provider = {}) {
  const name = String(provider.name || '').trim().toLowerCase();
  const phone = normalizePhoneNumber(provider.phone || provider.formatted_phone_number || '');
  return `${name}|${phone}`;
}

async function appendRejectedProvider(requestId, existingNotifications, provider) {
  const rejectedProviders = Array.isArray(existingNotifications?.rejectedProviders)
    ? [...existingNotifications.rejectedProviders]
    : [];

  const entry = {
    name: provider.name || '',
    phone: provider.phone || '',
    rejectedAt: new Date().toISOString(),
  };

  if (!rejectedProviders.some((item) => providerKey(item) === providerKey(entry))) {
    rejectedProviders.push(entry);
  }

  await persistOwnerSmsState(requestId, {
    ...existingNotifications,
    rejectedProviders,
  });

  return rejectedProviders;
}

function parseOwnerReply(body = '') {
  const normalized = String(body || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/^(yes|y|confirm|confirmed|approve|approved|ok|okay|proceed|go ahead|dispatch)\b/.test(normalized)) {
    return 'confirmed';
  }

  if (/^(no|n|hold|stop|decline|declined|cancel|wait|pause)\b/.test(normalized)) {
    return 'declined';
  }

  return null;
}

async function findPendingRequestForPhone(fromPhone) {
  const db = getDb();
  if (!db) {
    return null;
  }

  const normalizedFrom = normalizePhoneNumber(fromPhone);
  const snapshot = await db.collection(MAINTENANCE_SMS_PENDING_COLLECTION)
    .where('ownerPhone', '==', normalizedFrom)
    .where('status', '==', 'pending')
    .limit(10)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const pendingDocs = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((entry) => !entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())
    .filter((entry) => {
      if (!shouldRequireProviderApprovalBeforeCall()) {
        return true;
      }
      return (entry.phase || 'dispatch') === 'provider';
    })
    .sort((a, b) => {
      const phaseOrder = { provider: 2, dispatch: 1 };
      const phaseDiff = (phaseOrder[b.phase] || 0) - (phaseOrder[a.phase] || 0);
      if (phaseDiff !== 0) {
        return phaseDiff;
      }
      return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
    });

  return pendingDocs[0] || null;
}

async function handleDispatchConfirmationReply({ pending, decision, body, requestRef, requestData, existingNotifications, now }) {
  const nextNotifications = {
    ...existingNotifications,
    status: decision,
    lastReply: String(body || '').trim(),
    confirmedAt: decision === 'confirmed' ? now : existingNotifications.confirmedAt || null,
    declinedAt: decision === 'declined' ? now : existingNotifications.declinedAt || null,
  };

  await requestRef.set({
    ownerSmsNotifications: nextNotifications,
    ownerConfirmed: decision === 'confirmed',
    ownerDeclinedDispatch: decision === 'declined',
    updatedAt: now,
    ...(decision === 'declined' ? { status: 'on_hold' } : {}),
  }, { merge: true });

  const db = getDb();
  await db.collection(MAINTENANCE_SMS_PENDING_COLLECTION).doc(pending.requestId).set({
    status: decision,
    resolvedAt: now,
  }, { merge: true });

  if (decision === 'confirmed') {
    await clearPendingConfirmation(pending.requestId);
    return {
      ok: true,
      requestId: pending.requestId,
      decision,
      phase: 'dispatch',
      replyMessage: 'HouseYield: Dispatch authorized. We will identify a qualified provider and text you for approval before booking.',
      shouldResumeAutomation: true,
    };
  }

  await clearPendingConfirmation(pending.requestId);
  return {
    ok: true,
    requestId: pending.requestId,
    decision,
    phase: 'dispatch',
    replyMessage: 'HouseYield: Request held. Reply YES when you are ready for HouseYield to proceed.',
    shouldResumeAutomation: false,
  };
}

async function handleProviderApprovalReply({ pending, decision, body, requestRef, requestData, existingNotifications, now }) {
  const selectedProvider = requestData.aiAutomation?.selectedProvider || {};
  const providerApproval = {
    ...(existingNotifications.providerApproval || {}),
    phase: 'provider',
    status: decision,
    lastReply: String(body || '').trim(),
    providerApprovedAt: decision === 'confirmed' ? now : existingNotifications.providerApproval?.providerApprovedAt || null,
    providerDeclinedAt: decision === 'declined' ? now : existingNotifications.providerApproval?.providerDeclinedAt || null,
  };

  const nextNotifications = {
    ...existingNotifications,
    providerApproval,
    lastReply: String(body || '').trim(),
  };

  await requestRef.set({
    ownerSmsNotifications: nextNotifications,
    ownerProviderApproved: decision === 'confirmed',
    updatedAt: now,
  }, { merge: true });

  const db = getDb();
  await db.collection(MAINTENANCE_SMS_PENDING_COLLECTION).doc(pending.requestId).set({
    status: decision,
    resolvedAt: now,
  }, { merge: true });
  await clearPendingConfirmation(pending.requestId);

  if (decision === 'confirmed') {
    const practiceMode = isPracticeModeEnabled();
    const practiceNotice = practiceMode ? ` ${buildPracticeModeNotice()}` : '';
    return {
      ok: true,
      requestId: pending.requestId,
      decision,
      phase: 'provider',
      replyMessage: practiceMode
        ? `HouseYield: Authorization confirmed. Scheduling a practice booking call to your test line now (not the provider).${practiceNotice}`
        : 'HouseYield: Authorization confirmed. We are contacting the provider now to schedule service. You will receive a confirmation when the visit is booked.',
      shouldBookProvider: true,
    };
  }

  const alternateProvider = parseAlternateProviderSuggestion(body);
  if (alternateProvider) {
    await appendRejectedProvider(pending.requestId, nextNotifications, selectedProvider);
    await requestRef.set({
      aiAutomation: {
        ...(requestData.aiAutomation || {}),
        selectedProvider: {
          name: alternateProvider.name,
          phone: alternateProvider.phone,
          rating: null,
          aiScore: null,
          address: '',
          isOwnerSuggested: true,
        },
        status: 'provider_found',
      },
      updatedAt: now,
    }, { merge: true });

    return {
      ok: true,
      requestId: pending.requestId,
      decision,
      phase: 'provider',
      alternateProvider,
      replyMessage: `Got it — HouseYield will call ${alternateProvider.name} to schedule the visit.`,
      shouldBookProvider: true,
    };
  }

  await appendRejectedProvider(pending.requestId, nextNotifications, selectedProvider);

  return {
    ok: true,
    requestId: pending.requestId,
    decision,
    phase: 'provider',
    replyMessage: 'Understood — HouseYield will find another trusted provider and text you shortly.',
    shouldReselectProvider: true,
  };
}

export async function handleMaintenanceOwnerInboundSms({ from, body }) {
  const decision = parseOwnerReply(body);
  if (!decision) {
    return {
      ok: true,
      replyMessage: 'Reply YES to confirm, or NO to decline. For provider recommendations you can reply NO with company name and phone.',
    };
  }

  const pending = await findPendingRequestForPhone(from);
  if (!pending?.requestId) {
    return {
      ok: true,
      replyMessage: shouldRequireProviderApprovalBeforeCall()
        ? 'No pending provider approval was found. Wait for the latest provider recommendation text, then reply YES to book.'
        : 'No pending HouseYield maintenance request was found for this number.',
    };
  }

  const db = getDb();
  if (!db) {
    return { ok: false, replyMessage: 'HouseYield could not process your reply right now. Please try again shortly.' };
  }

  const requestRef = db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(pending.requestId);
  const requestSnap = await requestRef.get();
  const requestData = requestSnap.exists ? requestSnap.data() || {} : {};
  const existingNotifications = requestData.ownerSmsNotifications || {};
  const now = new Date().toISOString();
  const phase = pending.phase || 'dispatch';

  if (phase === 'provider') {
    return handleProviderApprovalReply({
      pending,
      decision,
      body,
      requestRef,
      requestData,
      existingNotifications,
      now,
    });
  }

  return handleDispatchConfirmationReply({
    pending,
    decision,
    body,
    requestRef,
    requestData,
    existingNotifications,
    now,
  });
}

export async function sendOwnerConfirmationAndShouldHoldDispatch(request) {
  if (!isMaintenanceOwnerSmsEnabled()) {
    return { holdDispatch: false, ownerSmsResult: null, reason: 'sms_disabled' };
  }

  if (!request?.ownerId || !request?.id) {
    return { holdDispatch: false, ownerSmsResult: null, reason: 'missing_owner_or_request' };
  }

  const ownerSmsResult = await sendMaintenanceOwnerSubmittedSms(request);
  const holdDispatch = shouldHoldDispatchForOwnerSms(ownerSmsResult);

  console.log('[MaintenanceOwnerSMS] Dispatch gate', {
    requestId: request.id,
    holdDispatch,
    smsOk: ownerSmsResult?.ok,
    smsStatus: ownerSmsResult?.confirmationState?.status,
    ownerPhone: ownerSmsResult?.ownerPhone || null,
    blockDispatchEnabled: shouldBlockDispatchUntilOwnerConfirm(),
  });

  return {
    holdDispatch,
    ownerSmsResult,
    reason: holdDispatch ? 'awaiting_owner_reply' : ownerSmsResult?.reason || ownerSmsResult?.error || 'dispatch_allowed',
  };
}

export async function notifyMaintenanceOwnerSubmitted(request) {
  return sendMaintenanceOwnerSubmittedSms(request);
}

export async function notifyMaintenanceOwnerProviderConnected(request) {
  return sendMaintenanceOwnerUpdateSms(request, 'provider_connected');
}

export async function notifyMaintenanceOwnerVisitScheduled(request) {
  return sendMaintenanceOwnerUpdateSms(request, 'visit_scheduled');
}

export async function notifyMaintenanceOwnerServiceCompleted(request) {
  return sendMaintenanceOwnerUpdateSms(request, 'service_completed');
}

export async function notifyMaintenanceOwnerProviderPaid(request) {
  return sendMaintenanceOwnerUpdateSms(request, 'provider_paid');
}

export default {
  isMaintenanceOwnerSmsEnabled,
  shouldBlockDispatchUntilOwnerConfirm,
  shouldRequireProviderApprovalBeforeCall,
  shouldHoldDispatchForOwnerSms,
  shouldHoldProviderCallForOwnerSms,
  sendOwnerConfirmationAndShouldHoldDispatch,
  sendMaintenanceOwnerProviderApprovalSms,
  normalizePhoneNumber,
  notifyMaintenanceOwnerSubmitted,
  notifyMaintenanceOwnerProviderConnected,
  notifyMaintenanceOwnerVisitScheduled,
  notifyMaintenanceOwnerServiceCompleted,
  notifyMaintenanceOwnerProviderPaid,
  sendOwnerInboundConfirmationSms,
  handleMaintenanceOwnerInboundSms,
};
