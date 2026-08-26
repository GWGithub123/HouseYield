import { initializeFirebaseAdmin } from './firebase-admin.js';

let db = null;
const COLLECTION = 'polygon_cache';

const DEFAULT_TTL_DAYS = {
  quote: 15 / (24 * 60),
  company: 7,
  dividends: 1,
  'historical-dividends': 7,
  splits: 30,
  history: 7,
  financials: 7,
  news: 1 / 24,
  basic: 1 / 24,
};

function getDb() {
  if (db) return db;

  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
    console.log('[Polygon Cache] ✅ Firestore connected');
  } catch (error) {
    console.warn('[Polygon Cache] ⚠️ Firestore unavailable:', error.message);
  }

  return db;
}

export async function getCachedPolygonData(key, maxAgeDays) {
  const firestore = getDb();
  if (!firestore) return null;

  try {
    const doc = await firestore.collection(COLLECTION).doc(sanitizeKey(key)).get();
    if (!doc.exists) {
      console.log(`[Polygon Cache] MISS — "${key}" not in Firestore`);
      return null;
    }

    const { data, updatedAt, ttlDays } = doc.data();
    const ts = updatedAt?.toDate?.() || new Date(updatedAt);
    const ageDays = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
    const maxAge = maxAgeDays ?? ttlDays ?? ttlForKey(key);

    if (ageDays > maxAge) {
      console.log(`[Polygon Cache] STALE — "${key}" is ${ageDays.toFixed(2)}d old (max ${maxAge}d)`);
      return { data, updatedAt: ts, ageDays, stale: true };
    }

    console.log(`[Polygon Cache] HIT — "${key}" (${ageDays.toFixed(2)}d old)`);
    return { data, updatedAt: ts, ageDays, stale: false };
  } catch (error) {
    console.error(`[Polygon Cache] Read error for "${key}":`, error.message);
    return null;
  }
}

export async function setCachedPolygonData(key, data, ttlDays) {
  const firestore = getDb();
  if (!firestore) return;

  try {
    const admin = (await import('firebase-admin')).default;
    await firestore.collection(COLLECTION).doc(sanitizeKey(key)).set({
      data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttlDays: ttlDays ?? ttlForKey(key),
      key,
    });
    console.log(`[Polygon Cache] STORED — "${key}"`);
  } catch (error) {
    console.error(`[Polygon Cache] Write error for "${key}":`, error.message);
  }
}

function sanitizeKey(key) {
  return key.replace(/\//g, '_').replace(/[^a-zA-Z0-9_:-]/g, '_');
}

function ttlForKey(key) {
  return DEFAULT_TTL_DAYS[key.split(':')[0]] ?? 1;
}
