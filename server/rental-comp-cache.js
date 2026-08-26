import { initializeFirebaseAdmin } from './firebase-admin.js';

let db = null;
const COLLECTION = 'rental_comp_cache';
const DEFAULT_TTL_HOURS = 72;

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
    console.log('[Rental Comp Cache] ✅ Firestore connected');
  } catch (err) {
    console.warn('[Rental Comp Cache] ⚠️ Firestore unavailable:', err.message);
  }
  return db;
}

function sanitizeKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9_:-]/g, '_');
}

export async function getCachedRentalCompData(key, signature, maxAgeHours = DEFAULT_TTL_HOURS) {
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

    if (signature && payload.signature && JSON.stringify(signature) !== JSON.stringify(payload.signature)) {
      return null;
    }

    return payload.data || null;
  } catch (err) {
    console.error('[Rental Comp Cache] Read error:', err.message);
    return null;
  }
}

export async function setCachedRentalCompData(key, signature, data) {
  const firestore = getDb();
  if (!firestore || !key || !data) return;

  try {
    const admin = (await import('firebase-admin')).default;
    await firestore.collection(COLLECTION).doc(sanitizeKey(key)).set({
      key,
      signature,
      data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttlHours: DEFAULT_TTL_HOURS,
    });
  } catch (err) {
    console.error('[Rental Comp Cache] Write error:', err.message);
  }
}