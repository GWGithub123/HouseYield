import { initializeFirebaseAdmin } from './firebase-admin.js';

let db = null;
const COLLECTION = 'rent_potential_cache';
const DEFAULT_TTL_HOURS = 12;

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
    console.log('[Rent Potential Cache] ✅ Firestore connected');
  } catch (err) {
    console.warn('[Rent Potential Cache] ⚠️ Firestore unavailable:', err.message);
  }
  return db;
}

function sanitizeKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9_:-]/g, '_');
}

function signaturesMatch(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

export async function getCachedRentPotentialData(key, signature, maxAgeHours = DEFAULT_TTL_HOURS) {
  const firestore = getDb();
  if (!firestore || !key) return null;

  try {
    const doc = await firestore.collection(COLLECTION).doc(sanitizeKey(key)).get();
    if (!doc.exists) return null;

    const payload = doc.data();
    const updatedAt = payload.updatedAt?.toDate?.() || new Date(payload.updatedAt || 0);
    const ageHours = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);

    if (ageHours > maxAgeHours) {
      return null;
    }

    if (!signaturesMatch(signature, payload.signature)) {
      return null;
    }

    return payload.data || null;
  } catch (err) {
    console.error('[Rent Potential Cache] Read error:', err.message);
    return null;
  }
}

export async function setCachedRentPotentialData(key, signature, data, ttlHours = DEFAULT_TTL_HOURS) {
  const firestore = getDb();
  if (!firestore || !key || !data) return;

  try {
    const admin = (await import('firebase-admin')).default;
    await firestore.collection(COLLECTION).doc(sanitizeKey(key)).set({
      key,
      signature,
      data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttlHours,
    });
  } catch (err) {
    console.error('[Rent Potential Cache] Write error:', err.message);
  }
}