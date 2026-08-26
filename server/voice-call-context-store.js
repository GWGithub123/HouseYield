import { getFirestore } from './firebase-admin.js';
import { FieldValue } from 'firebase-admin/firestore';

const COLLECTION = 'voice_call_context';
const TTL_MS = 45 * 60 * 1000;
const RECENT_CONTEXT_TTL_MS = 48 * 60 * 60 * 1000;
const recentContextByPhone = new Map();

function normalizePhoneKey(phone = '') {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function phoneDocId(phone = '') {
  const key = normalizePhoneKey(phone);
  return key ? `phone_${key}` : null;
}

function buildPriorCallSummary(context = {}, transcript = []) {
  const lines = Array.isArray(transcript) ? transcript : [];
  const spoken = lines
    .slice(-12)
    .map((entry) => {
      const speaker = entry.role === 'assistant' ? 'Ava' : 'Provider';
      return `${speaker}: ${entry.text}`;
    })
    .join('\n');

  const parts = [];
  if (context.issue) {
    parts.push(`Issue: ${context.issue}`);
  }
  if (context.propertyAddress) {
    parts.push(`Address: ${context.propertyAddress}`);
  }
  if (context.tenantAvailability) {
    parts.push(`Tenant availability: ${context.tenantAvailability}`);
  }
  if (context.urgency) {
    parts.push(`Urgency: ${context.urgency}`);
  }
  if (spoken) {
    parts.push(`Earlier call transcript:\n${spoken}`);
  }

  return parts.join('\n');
}

export function rememberRecentCallContextByPhone(phone, context = {}) {
  const key = normalizePhoneKey(phone);
  if (!key) {
    return;
  }

  recentContextByPhone.set(key, {
    ...context,
    storedAt: Date.now()
  });
}

export async function saveVoiceCallContextByPhone(phone, context = {}, options = {}) {
  const docId = phoneDocId(phone);
  if (!docId || !context) {
    return false;
  }

  const db = getDb();
  if (!db) {
    return false;
  }

  try {
    await db.collection(COLLECTION).doc(docId).set({
      phoneKey: normalizePhoneKey(phone),
      context,
      outboundCallSid: options.outboundCallSid || null,
      lastOutboundAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + RECENT_CONTEXT_TTL_MS).toISOString()
    }, { merge: true });
    console.log('[VoiceContext] Saved phone callback context to Firestore:', docId);
    return true;
  } catch (error) {
    console.warn('[VoiceContext] Failed to save phone callback context:', error.message);
    return false;
  }
}

export async function loadVoiceCallContextByPhone(phone = '', options = {}) {
  const docId = phoneDocId(phone);
  if (!docId) {
    return null;
  }

  const db = getDb();
  if (!db) {
    return null;
  }

  try {
    const doc = await db.collection(COLLECTION).doc(docId).get();
    if (!doc.exists) {
      return null;
    }

    const data = doc.data() || {};
    if (data.expiresAt && Date.parse(data.expiresAt) < Date.now()) {
      await db.collection(COLLECTION).doc(docId).delete().catch(() => {});
      return null;
    }

    let transcript = [];
    if (options.includeTranscript && data.outboundCallSid) {
      const callData = await loadVoiceCallContext(data.outboundCallSid, { includeTranscript: true });
      transcript = callData?.transcript || [];
    }

    const context = data.context || null;
    return {
      context,
      outboundCallSid: data.outboundCallSid || null,
      lastOutboundAt: data.lastOutboundAt || null,
      transcript,
      priorCallSummary: buildPriorCallSummary(context, transcript)
    };
  } catch (error) {
    console.warn('[VoiceContext] Failed to load phone callback context:', error.message);
    return null;
  }
}

export async function resolveMaintenanceContextForInbound(callerPhone = '', callSid = '') {
  const memoryContext = lookupRecentCallContextByPhone(callerPhone);
  if (memoryContext?.issue || memoryContext?.propertyAddress || memoryContext?.firestoreId) {
    return {
      ...memoryContext,
      inbound: true,
      callerPhone,
      callDirection: 'inbound',
      callSid
    };
  }

  const phoneData = await loadVoiceCallContextByPhone(callerPhone, { includeTranscript: true });
  if (phoneData?.context) {
    return {
      ...phoneData.context,
      inbound: true,
      callerPhone,
      callDirection: 'inbound',
      callSid,
      priorOutboundCallSid: phoneData.outboundCallSid || null,
      priorCallTranscript: phoneData.transcript || [],
      priorCallSummary: phoneData.priorCallSummary || buildPriorCallSummary(phoneData.context, phoneData.transcript),
      lastOutboundAt: phoneData.lastOutboundAt || null
    };
  }

  return {
    inbound: true,
    callerPhone,
    callDirection: 'inbound',
    callSid
  };
}

export function lookupRecentCallContextByPhone(phone = '') {
  const key = normalizePhoneKey(phone);
  if (!key) {
    return null;
  }

  const entry = recentContextByPhone.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.storedAt > RECENT_CONTEXT_TTL_MS) {
    recentContextByPhone.delete(key);
    return null;
  }

  return entry;
}

function getDb() {
  try {
    return getFirestore();
  } catch {
    return null;
  }
}

export async function saveVoiceCallContext(callSid, context) {
  if (!callSid || !context) {
    return false;
  }

  const db = getDb();
  if (!db) {
    return false;
  }

  try {
    await db.collection(COLLECTION).doc(callSid).set({
      callSid,
      context,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString()
    }, { merge: true });
    console.log('[VoiceContext] Saved call context to Firestore:', callSid);
    return true;
  } catch (error) {
    console.warn('[VoiceContext] Failed to save call context:', error.message);
    return false;
  }
}

export async function appendVoiceCallTranscriptLine(callSid, { role, text }) {
  const line = String(text || '').trim();
  if (!callSid || !line) {
    return false;
  }

  const db = getDb();
  if (!db) {
    return false;
  }

  try {
    await db.collection(COLLECTION).doc(callSid).set({
      callSid,
      transcript: FieldValue.arrayUnion({
        role: role === 'assistant' ? 'assistant' : 'user',
        text: line.slice(0, 4000),
        at: new Date().toISOString()
      }),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString()
    }, { merge: true });
    return true;
  } catch (error) {
    console.warn('[VoiceContext] Failed to append transcript line:', error.message);
    return false;
  }
}

export async function loadVoiceCallContext(callSid, options = {}) {
  if (!callSid) {
    return null;
  }

  const db = getDb();
  if (!db) {
    return null;
  }

  try {
    const doc = await db.collection(COLLECTION).doc(callSid).get();
    if (!doc.exists) {
      return null;
    }

    const data = doc.data() || {};
    if (data.expiresAt && Date.parse(data.expiresAt) < Date.now()) {
      await db.collection(COLLECTION).doc(callSid).delete().catch(() => {});
      return null;
    }

    if (options.includeTranscript) {
      return {
        context: data.context || null,
        transcript: Array.isArray(data.transcript) ? data.transcript : []
      };
    }

    return data.context || null;
  } catch (error) {
    console.warn('[VoiceContext] Failed to load call context:', error.message);
    return null;
  }
}

export async function deleteVoiceCallContext(callSid) {
  if (!callSid) {
    return;
  }

  const db = getDb();
  if (!db) {
    return;
  }

  try {
    await db.collection(COLLECTION).doc(callSid).delete();
  } catch (error) {
    console.warn('[VoiceContext] Failed to delete call context:', error.message);
  }
}
