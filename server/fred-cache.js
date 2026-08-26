/**
 * Firestore-backed cache for FRED API data.
 *
 * Stores the full JSON result of each FRED endpoint in a Firestore collection
 * `fred_cache`.  Every user gets instant data from Firestore; the server only
 * hits the FRED API when a manual refresh is triggered or the cache is older
 * than the configured TTL.
 *
 * Collection: fred_cache
 *   Document ID = cache key (e.g. "housing-market", "heat-map:housing")
 *   Fields:
 *     data      — the full JSON payload
 *     updatedAt — Firestore Timestamp of last refresh
 *     ttlDays   — how many days this cache entry is considered fresh
 */

import { initializeFirebaseAdmin } from './firebase-admin.js';

let db = null;
const COLLECTION = 'fred_cache';

const MARKET_INSIGHTS_TTL_DAYS = 5;

// Default freshness windows (days)
const DEFAULT_TTL_DAYS = {
  'housing-market':   MARKET_INSIGHTS_TTL_DAYS,   // National overview
  'regional-market':  MARKET_INSIGHTS_TTL_DAYS,   // Regional summary
  'treasury-yields':   1,   // Yields change daily (Thursday releases)
  'fed-meeting':       MARKET_INSIGHTS_TTL_DAYS,
  'fomc-calendar':     MARKET_INSIGHTS_TTL_DAYS,
  'macro-indicators':  MARKET_INSIGHTS_TTL_DAYS,
  'polymarket-predictions': 1 / 24, // Prediction odds move intraday
  'polymarket-economic':    1 / 24, // Same underlying live market feed
  'heat-map':         MARKET_INSIGHTS_TTL_DAYS,
  'regional-detail':  MARKET_INSIGHTS_TTL_DAYS,
  'metro-history':    MARKET_INSIGHTS_TTL_DAYS,
  'regions-search':   MARKET_INSIGHTS_TTL_DAYS,
  'county-data':      MARKET_INSIGHTS_TTL_DAYS,
  'county-by-coords': MARKET_INSIGHTS_TTL_DAYS,
  'rentcast-market':  MARKET_INSIGHTS_TTL_DAYS,
  'rentcast-metro-zips': MARKET_INSIGHTS_TTL_DAYS,
  'rentcast-zip-radius': MARKET_INSIGHTS_TTL_DAYS,
  'my-region-attom':  MARKET_INSIGHTS_TTL_DAYS,
};

/**
 * Get (or lazy-init) the Firestore instance.
 */
function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
    console.log('[FRED Cache] ✅ Firestore connected');
  } catch (err) {
    console.warn('[FRED Cache] ⚠️ Firestore unavailable:', err.message);
  }
  return db;
}

/**
 * Read a cached entry from Firestore.
 * Returns { data, updatedAt, age } or null if missing / expired.
 *
 * @param {string} key        - Cache key (e.g. "housing-market")
 * @param {number} [maxAgeDays] - Override default TTL
 */
export async function getCachedFredData(key, maxAgeDays) {
  const firestore = getDb();
  if (!firestore) return null;

  try {
    const doc = await firestore.collection(COLLECTION).doc(sanitizeKey(key)).get();
    if (!doc.exists) {
      console.log(`[FRED Cache] MISS — "${key}" not in Firestore`);
      return null;
    }

    const { data, updatedAt, ttlDays } = doc.data();
    const ts = updatedAt?.toDate?.() || new Date(updatedAt);
    const ageDays = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
    const configuredMaxAge = maxAgeDays ?? ttlForKey(key);
    const persistedMaxAge = Number.isFinite(Number(ttlDays)) ? Number(ttlDays) : configuredMaxAge;
    // Always honor the stricter current policy so older Firestore docs with a larger
    // stored ttlDays value do not stay fresh after we tighten cache windows.
    const maxAge = Math.min(configuredMaxAge, persistedMaxAge);

    if (ageDays > maxAge) {
      console.log(`[FRED Cache] STALE — "${key}" is ${ageDays.toFixed(1)}d old (max ${maxAge}d)`);
      // Return stale data anyway so the user isn't blocked; caller can
      // decide whether to refresh in the background.
      return { data, updatedAt: ts, ageDays, stale: true };
    }

    console.log(`[FRED Cache] HIT — "${key}" (${ageDays.toFixed(1)}d old)`);
    return { data, updatedAt: ts, ageDays, stale: false };
  } catch (err) {
    console.error(`[FRED Cache] Read error for "${key}":`, err.message);
    return null;
  }
}

/**
 * Write data into the Firestore cache.
 *
 * @param {string} key  - Cache key
 * @param {object} data - The full API response payload to store
 */
export async function setCachedFredData(key, data) {
  const firestore = getDb();
  if (!firestore) return;

  try {
    const admin = (await import('firebase-admin')).default;
    await firestore.collection(COLLECTION).doc(sanitizeKey(key)).set({
      data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttlDays: ttlForKey(key),
      key,   // human-readable original key
    });
    console.log(`[FRED Cache] STORED — "${key}"`);
  } catch (err) {
    console.error(`[FRED Cache] Write error for "${key}":`, err.message);
  }
}

/**
 * Delete a specific cache entry (force next request to refetch).
 */
export async function invalidateFredCache(key) {
  const firestore = getDb();
  if (!firestore) return;
  try {
    await firestore.collection(COLLECTION).doc(sanitizeKey(key)).delete();
    console.log(`[FRED Cache] INVALIDATED — "${key}"`);
  } catch (err) {
    console.error(`[FRED Cache] Delete error for "${key}":`, err.message);
  }
}

/**
 * List all cached entries with their age / staleness.
 */
export async function listFredCache() {
  const firestore = getDb();
  if (!firestore) return [];
  try {
    const snap = await firestore.collection(COLLECTION).get();
    return snap.docs.map(doc => {
      const d = doc.data();
      const ts = d.updatedAt?.toDate?.() || new Date(d.updatedAt || 0);
      const ageDays = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
      return {
        key: d.key || doc.id,
        updatedAt: ts.toISOString(),
        ageDays: parseFloat(ageDays.toFixed(1)),
        ttlDays: d.ttlDays,
        stale: ageDays > (d.ttlDays ?? 14),
        docId: doc.id,
      };
    });
  } catch (err) {
    console.error('[FRED Cache] List error:', err.message);
    return [];
  }
}

/**
 * Invalidate ALL cached entries.
 */
export async function clearFredCache() {
  const firestore = getDb();
  if (!firestore) return 0;
  try {
    const snap = await firestore.collection(COLLECTION).get();
    const batch = firestore.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`[FRED Cache] CLEARED — ${snap.size} entries deleted`);
    return snap.size;
  } catch (err) {
    console.error('[FRED Cache] Clear error:', err.message);
    return 0;
  }
}

// ── helpers ──

/** Firestore doc IDs can't contain / so we replace them */
function sanitizeKey(key) {
  return key.replace(/\//g, '_').replace(/[^a-zA-Z0-9_:-]/g, '_');
}

function ttlForKey(key) {
  // Match prefix: "heat-map:housing" → "heat-map"
  const prefix = key.split(':')[0];
  return DEFAULT_TTL_DAYS[prefix] ?? 14;
}
