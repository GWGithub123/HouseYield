/**
 * Firestore-backed cache for ATTOM property data.
 *
 * ATTOM's data license allows storing property data for up to 90 days.
 * This module caches full ATTOM dashboard responses in Firestore so that:
 *   1. Repeated lookups for the same property hit Firestore, not the ATTOM API
 *   2. Data is automatically refreshed when it exceeds the 90-day limit
 *   3. Stale data (>90 days) is returned immediately while a background
 *      refresh is triggered, so users are never blocked
 *   4. Compliance is maintained — entries older than 90 days are purged
 *
 * Collection: attom_property_cache
 *   Document ID = sanitized normalized address or ATTOM ID
 *   Fields:
 *     address          — original address string
 *     normalizedAddress — uppercase, abbreviation-normalized address
 *     attomId          — ATTOM property ID (if available)
 *     data             — full ATTOM dashboard JSON
 *     cachedAt         — Firestore Timestamp of last API fetch
 *     ttlDays          — retention limit (90)
 */

import { initializeFirebaseAdmin } from './firebase-admin.js';
import { decorateDashboardPayload } from './attom.js';

let db = null;
const COLLECTION = 'attom_property_cache';
const TTL_DAYS = 90; // ATTOM license: max 90-day retention

// ── Firestore connection ────────────────────────────────────────────────────

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
    console.log('[ATTOM Cache] ✅ Firestore connected');
  } catch (err) {
    console.warn('[ATTOM Cache] ⚠️ Firestore unavailable:', err.message);
  }
  return db;
}

// ── Address normalization (matches db/property-cache.js) ────────────────────

function normalizeAddress(address) {
  if (!address) return '';
  return address
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/\bAPARTMENT\b/g, 'APT')
    .replace(/\bSUITE\b/g, 'STE');
}

/** Firestore doc IDs can't contain / or other special chars */
function sanitizeKey(str) {
  return String(str ?? '').replace(/[/\\#\[\]*?. ]/g, '_').substring(0, 200);
}

/** Build a doc ID from address or ATTOM ID */
function docIdFromAddress(address) {
  return sanitizeKey(normalizeAddress(address));
}

function docIdFromAttomId(attomId) {
  return `attomid_${sanitizeKey(attomId)}`;
}

function isNonEmptyValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function countNonEmptyFields(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  return keys.reduce((count, key) => count + (isNonEmptyValue(obj[key]) ? 1 : 0), 0);
}

export function scoreAttomDashboardData(dashboardData) {
  if (!dashboardData || typeof dashboardData !== 'object') return 0;

  const summary = dashboardData.summary || {};
  const mortgage = summary.mortgage || {};

  let score = 0;
  score += countNonEmptyFields(summary, [
    'attom_id',
    'address',
    'beds',
    'baths',
    'living_sqft',
    'year_built',
    'property_type',
    'avm_value',
    'assessed_value',
    'rental_avm',
    'latitude',
    'longitude',
  ]) * 2;

  score += countNonEmptyFields(mortgage, [
    'amount',
    'date',
    'loan_type',
    'lender_name',
    'estimated_interest_rate',
    'term_months',
  ]) * 2;

  if (Array.isArray(dashboardData.tax_history)) {
    score += Math.min(dashboardData.tax_history.length, 10);
  }
  if (Array.isArray(dashboardData.avm_history)) {
    score += Math.min(Math.ceil(dashboardData.avm_history.length / 2), 10);
  }
  if (Array.isArray(dashboardData.building_permits) && dashboardData.building_permits.length > 0) {
    score += 3;
  }
  if (Array.isArray(dashboardData.schools) && dashboardData.schools.length > 0) {
    score += 3;
  }
  if (isNonEmptyValue(dashboardData.environmental)) {
    score += 2;
  }
  if (isNonEmptyValue(dashboardData.parcel_geometry)) {
    score += 2;
  }

  return score;
}

export function isUsableAttomDashboardData(dashboardData) {
  return scoreAttomDashboardData(dashboardData) >= 8;
}

function mergeObjectsPreferIncoming(existingValue, incomingValue) {
  const existing = existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue)
    ? existingValue
    : {};
  const incoming = incomingValue && typeof incomingValue === 'object' && !Array.isArray(incomingValue)
    ? incomingValue
    : {};

  const merged = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      merged[key] = value.length > 0 ? value : merged[key];
      continue;
    }

    if (value && typeof value === 'object') {
      merged[key] = mergeObjectsPreferIncoming(merged[key], value);
      continue;
    }

    if (isNonEmptyValue(value)) {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }

  return merged;
}

function preferLongerArray(existingValue, incomingValue) {
  const existing = Array.isArray(existingValue) ? existingValue : [];
  const incoming = Array.isArray(incomingValue) ? incomingValue : [];
  return incoming.length >= existing.length ? incoming : existing;
}

function mergeAttomDashboardData(existingData, incomingData) {
  if (!existingData) return incomingData;
  if (!incomingData) return existingData;

  const merged = {
    ...existingData,
    ...incomingData,
    summary: mergeObjectsPreferIncoming(existingData.summary, incomingData.summary),
    tax_meta: mergeObjectsPreferIncoming(existingData.tax_meta, incomingData.tax_meta),
    environmental: mergeObjectsPreferIncoming(existingData.environmental, incomingData.environmental),
    location: mergeObjectsPreferIncoming(existingData.location, incomingData.location),
    parcel_geometry: incomingData.parcel_geometry || existingData.parcel_geometry,
    school_district: mergeObjectsPreferIncoming(existingData.school_district, incomingData.school_district),
    analyticsProjection: mergeObjectsPreferIncoming(existingData.analyticsProjection, incomingData.analyticsProjection),
    avm_comparable_context: mergeObjectsPreferIncoming(existingData.avm_comparable_context, incomingData.avm_comparable_context),
    tax_history: preferLongerArray(existingData.tax_history, incomingData.tax_history),
    avm_history: preferLongerArray(existingData.avm_history, incomingData.avm_history),
    avm_comparable_history: preferLongerArray(existingData.avm_comparable_history, incomingData.avm_comparable_history),
    building_permits: preferLongerArray(existingData.building_permits, incomingData.building_permits),
    schools: preferLongerArray(existingData.schools, incomingData.schools),
  };

  if (!isNonEmptyValue(merged.components)) {
    delete merged.components;
  }

  return merged;
}

// ── Read from cache ─────────────────────────────────────────────────────────

/**
 * Get cached ATTOM property data by address.
 *
 * @param {string} address - Property address
 * @returns {Promise<{data: object, cachedAt: Date, ageDays: number, stale: boolean}|null>}
 */
export async function getCachedAttomData(address) {
  if (!address) return null;
  const firestore = getDb();
  if (!firestore) return null;

  const docId = docIdFromAddress(address);
  return _readCacheDoc(docId, address);
}

/**
 * Get cached ATTOM property data by ATTOM ID.
 *
 * @param {string} attomId - ATTOM property identifier
 * @returns {Promise<{data: object, cachedAt: Date, ageDays: number, stale: boolean}|null>}
 */
export async function getCachedAttomDataById(attomId) {
  if (!attomId) return null;
  const firestore = getDb();
  if (!firestore) return null;

  const docId = docIdFromAttomId(attomId);
  return _readCacheDoc(docId, attomId);
}

/**
 * Internal: read + validate a cache document.
 */
async function _readCacheDoc(docId, label) {
  const firestore = getDb();
  try {
    const doc = await firestore.collection(COLLECTION).doc(docId).get();
    if (!doc.exists) {
      console.log(`[ATTOM Cache] MISS — "${label}" not in Firestore`);
      return null;
    }

    const record = doc.data();
    const ts = record.cachedAt?.toDate?.() || new Date(record.cachedAt);
    const ageDays = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
    const stale = ageDays > TTL_DAYS;

    if (stale) {
      console.log(`[ATTOM Cache] STALE — "${label}" is ${ageDays.toFixed(1)}d old (limit ${TTL_DAYS}d)`);
    } else {
      console.log(`[ATTOM Cache] HIT — "${label}" (${ageDays.toFixed(1)}d old)`);
    }

    return {
      data: decorateDashboardPayload(record.data),
      cachedAt: ts,
      ageDays: parseFloat(ageDays.toFixed(1)),
      stale,
      attomId: record.attomId || null,
    };
  } catch (err) {
    console.error(`[ATTOM Cache] Read error for "${label}":`, err.message);
    return null;
  }
}

// ── Write to cache ──────────────────────────────────────────────────────────

/**
 * Cache ATTOM dashboard data in Firestore.
 *
 * Creates TWO documents if an attomId is present — one keyed by address and
 * one keyed by attomId — so lookups by either key are fast.
 *
 * @param {string} address      - Original property address
 * @param {object} dashboardData - Full ATTOM dashboard response
 * @param {string} [attomId]     - ATTOM property ID (extracted automatically if omitted)
 */
export async function cacheAttomData(address, dashboardData, attomId) {
  if (!address || !dashboardData) return;
  const firestore = getDb();
  if (!firestore) return;

  const resolvedAttomId = attomId || dashboardData?.summary?.attom_id || null;
  const incomingScore = scoreAttomDashboardData(dashboardData);
  const incomingUsable = isUsableAttomDashboardData(dashboardData);

  if (!incomingUsable) {
    console.warn(
      `[ATTOM Cache] SKIP WRITE — incomplete payload for "${address}" (score ${incomingScore})`
    );
    return;
  }

  const existingAddrDocRef = firestore.collection(COLLECTION).doc(docIdFromAddress(address));
  const existingAddrDoc = await existingAddrDocRef.get();
  const existingRecord = existingAddrDoc.exists ? existingAddrDoc.data() || {} : {};
  const existingData = existingRecord.data || null;
  const mergedData = decorateDashboardPayload(
    mergeAttomDashboardData(existingData, dashboardData)
  );
  const now = new Date();

  const record = {
    address,
    normalizedAddress: normalizeAddress(address),
    attomId: resolvedAttomId,
    data: mergedData,
    cachedAt: now,
    ttlDays: TTL_DAYS,
  };

  try {
    const batch = firestore.batch();

    // Primary doc keyed by normalized address
    const addrDocRef = firestore.collection(COLLECTION).doc(docIdFromAddress(address));
    batch.set(addrDocRef, record);

    // Secondary doc keyed by attomId (if we have one)
    if (resolvedAttomId) {
      const idDocRef = firestore.collection(COLLECTION).doc(docIdFromAttomId(resolvedAttomId));
      batch.set(idDocRef, record);
    }

    await batch.commit();
    console.log(`[ATTOM Cache] STORED — "${address}"${resolvedAttomId ? ` (attomId: ${resolvedAttomId})` : ''}`);
  } catch (err) {
    console.error(`[ATTOM Cache] Write error for "${address}":`, err.message);
  }
}

/**
 * Merge derived analytics data into an existing ATTOM cache record.
 * Keeps the original ATTOM payload intact while storing calculation outputs
 * alongside it for reuse on subsequent dashboard loads.
 */
export async function mergeAttomDerivedData(address, derivedData, attomId) {
  if (!address || !derivedData) return;
  const firestore = getDb();
  if (!firestore) return;

  const docRefs = [
    firestore.collection(COLLECTION).doc(docIdFromAddress(address))
  ];

  if (attomId) {
    docRefs.push(firestore.collection(COLLECTION).doc(docIdFromAttomId(attomId)));
  }

  try {
    const docs = await Promise.all(docRefs.map((docRef) => docRef.get()));
    const batch = firestore.batch();
    const now = new Date();

    docs.forEach((docSnap, index) => {
      if (!docSnap.exists) return;
      const record = docSnap.data() || {};
      const currentData = record.data || {};
      batch.set(docRefs[index], {
        ...record,
        data: {
          ...currentData,
          analyticsProjection: {
            ...(currentData.analyticsProjection || {}),
            ...derivedData,
            cachedAt: now.toISOString()
          }
        },
        updatedAt: now
      }, { merge: true });
    });

    await batch.commit();
    console.log(`[ATTOM Cache] MERGED DERIVED DATA — "${address}"`);
  } catch (err) {
    console.error(`[ATTOM Cache] Derived data merge failed for "${address}":`, err.message);
  }
}

// ── Maintenance / compliance ────────────────────────────────────────────────

/**
 * Delete all cache entries older than 90 days to comply with ATTOM data license.
 * Should be called periodically (e.g. daily cron, or on server startup).
 *
 * @returns {Promise<number>} Number of entries purged
 */
export async function purgeExpiredAttomCache() {
  const firestore = getDb();
  if (!firestore) return 0;

  try {
    const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000);
    const snapshot = await firestore
      .collection(COLLECTION)
      .where('cachedAt', '<', cutoff)
      .get();

    if (snapshot.empty) {
      console.log('[ATTOM Cache] No expired entries to purge');
      return 0;
    }

    // Firestore batches can hold max 500 operations
    const batches = [];
    let batch = firestore.batch();
    let count = 0;

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
      count++;
      if (count % 500 === 0) {
        batches.push(batch);
        batch = firestore.batch();
      }
    });
    batches.push(batch);

    await Promise.all(batches.map((b) => b.commit()));
    console.log(`[ATTOM Cache] PURGED — ${count} expired entries (>${TTL_DAYS}d old)`);
    return count;
  } catch (err) {
    console.error('[ATTOM Cache] Purge error:', err.message);
    return 0;
  }
}

/**
 * List all cached entries with their age / freshness status.
 * Useful for admin dashboards.
 *
 * @returns {Promise<Array<{address: string, attomId: string|null, cachedAt: string, ageDays: number, stale: boolean}>>}
 */
export async function listAttomCache() {
  const firestore = getDb();
  if (!firestore) return [];

  try {
    const snap = await firestore.collection(COLLECTION).get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      const ts = d.cachedAt?.toDate?.() || new Date(d.cachedAt || 0);
      const ageDays = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
      return {
        docId: doc.id,
        address: d.address || null,
        attomId: d.attomId || null,
        cachedAt: ts.toISOString(),
        ageDays: parseFloat(ageDays.toFixed(1)),
        stale: ageDays > TTL_DAYS,
      };
    });
  } catch (err) {
    console.error('[ATTOM Cache] List error:', err.message);
    return [];
  }
}

/**
 * Invalidate (delete) cache for a specific property.
 *
 * @param {string} address - Property address to invalidate
 * @param {string} [attomId] - Also remove the attomId-keyed doc
 */
export async function invalidateAttomCache(address, attomId) {
  const firestore = getDb();
  if (!firestore) return;

  try {
    const batch = firestore.batch();

    if (address) {
      batch.delete(firestore.collection(COLLECTION).doc(docIdFromAddress(address)));
    }
    if (attomId) {
      batch.delete(firestore.collection(COLLECTION).doc(docIdFromAttomId(attomId)));
    }

    await batch.commit();
    console.log(`[ATTOM Cache] INVALIDATED — "${address || attomId}"`);
  } catch (err) {
    console.error(`[ATTOM Cache] Invalidate error:`, err.message);
  }
}

/**
 * Clear ALL ATTOM cache entries.
 *
 * @returns {Promise<number>} Number of entries deleted
 */
export async function clearAllAttomCache() {
  const firestore = getDb();
  if (!firestore) return 0;

  try {
    const snap = await firestore.collection(COLLECTION).get();
    if (snap.empty) return 0;

    const batches = [];
    let batch = firestore.batch();
    let count = 0;

    snap.docs.forEach((doc) => {
      batch.delete(doc.ref);
      count++;
      if (count % 500 === 0) {
        batches.push(batch);
        batch = firestore.batch();
      }
    });
    batches.push(batch);

    await Promise.all(batches.map((b) => b.commit()));
    console.log(`[ATTOM Cache] CLEARED — ${count} entries deleted`);
    return count;
  } catch (err) {
    console.error('[ATTOM Cache] Clear error:', err.message);
    return 0;
  }
}

/**
 * Get cache statistics.
 *
 * @returns {Promise<{total: number, fresh: number, stale: number, oldestDays: number|null}>}
 */
export async function getAttomCacheStats() {
  const firestore = getDb();
  if (!firestore) return { total: 0, fresh: 0, stale: 0, oldestDays: null };

  try {
    const snap = await firestore.collection(COLLECTION).get();
    let fresh = 0;
    let stale = 0;
    let oldest = 0;

    snap.docs.forEach((doc) => {
      const d = doc.data();
      const ts = d.cachedAt?.toDate?.() || new Date(d.cachedAt || 0);
      const ageDays = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > TTL_DAYS) {
        stale++;
      } else {
        fresh++;
      }
      if (ageDays > oldest) oldest = ageDays;
    });

    return {
      total: snap.size,
      fresh,
      stale,
      oldestDays: snap.size > 0 ? parseFloat(oldest.toFixed(1)) : null,
      ttlDays: TTL_DAYS,
    };
  } catch (err) {
    console.error('[ATTOM Cache] Stats error:', err.message);
    return { total: 0, fresh: 0, stale: 0, oldestDays: null };
  }
}

export default {
  getCachedAttomData,
  getCachedAttomDataById,
  cacheAttomData,
  mergeAttomDerivedData,
  isUsableAttomDashboardData,
  scoreAttomDashboardData,
  purgeExpiredAttomCache,
  listAttomCache,
  invalidateAttomCache,
  clearAllAttomCache,
  getAttomCacheStats,
};
