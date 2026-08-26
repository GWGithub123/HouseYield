import { initializeFirebaseAdmin } from './firebase-admin.js';

let db = null;
const COLLECTION = 'zip_market_cache';
const DEFAULT_TTL_HOURS = 24;
const STALE_THRESHOLD_HOURS = 20;

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
    console.log('[ZIP Market Cache] ✅ Firestore connected');
  } catch (err) {
    console.warn('[ZIP Market Cache] ⚠️ Firestore unavailable:', err.message);
  }
  return db;
}

function sanitizeKey(zipCode) {
  return `zip_${String(zipCode || '').replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/**
 * Get cached ZIP market data from Firestore.
 * @returns {{ data: object, isStale: boolean } | null}
 */
export async function getCachedZipMarketData(zipCode) {
  const firestore = getDb();
  if (!firestore || !zipCode) return null;

  try {
    const doc = await firestore.collection(COLLECTION).doc(sanitizeKey(zipCode)).get();
    if (!doc.exists) return null;

    const payload = doc.data();
    const updatedAt = payload.updatedAt?.toDate?.() || new Date(payload.updatedAt || 0);
    const ageHours = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);

    if (ageHours > DEFAULT_TTL_HOURS) {
      // Expired — don't return
      return null;
    }

    const isStale = ageHours > STALE_THRESHOLD_HOURS;
    return { data: payload.data || null, isStale };
  } catch (err) {
    console.error('[ZIP Market Cache] Read error:', err.message);
    return null;
  }
}

/**
 * Store ZIP market data in Firestore.
 */
export async function setCachedZipMarketData(zipCode, data) {
  const firestore = getDb();
  if (!firestore || !zipCode || !data) return;

  try {
    const admin = (await import('firebase-admin')).default;
    await firestore.collection(COLLECTION).doc(sanitizeKey(zipCode)).set({
      zipCode,
      data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttlHours: DEFAULT_TTL_HOURS,
    });
  } catch (err) {
    console.error('[ZIP Market Cache] Write error:', err.message);
  }
}
