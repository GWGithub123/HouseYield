/**
 * Prevent duplicate owner maintenance SMS for the same flood/leak alert.
 * Shared across auto-notify, water shutoff, and dispatchOwnerMaintenanceFromSensorAlert.
 */

import { getFirestore } from '../firebase-admin.js';

const claimedDispatchKeys = new Set();
const DISPATCH_CLAIMS_COLLECTION = 'sensorOwnerMaintenanceDispatches';

function normalizeKey(value) {
  const key = String(value || '').trim();
  return key || null;
}

export function tryClaimOwnerDispatch(key) {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return { claimed: true, key: null };
  }
  if (claimedDispatchKeys.has(normalized)) {
    return { claimed: false, key: normalized, reason: 'already_dispatched' };
  }
  claimedDispatchKeys.add(normalized);
  return { claimed: true, key: normalized };
}

export function isOwnerDispatchClaimed(key) {
  const normalized = normalizeKey(key);
  return Boolean(normalized && claimedDispatchKeys.has(normalized));
}

export function buildOwnerDispatchKey({ alertId, propertyId, sensorDeviceId } = {}) {
  return normalizeKey(alertId) || normalizeKey(propertyId && sensorDeviceId ? `${propertyId}:${sensorDeviceId}` : null);
}

export async function claimOwnerDispatchPersisted(alertId) {
  const key = normalizeKey(alertId);
  if (!key) {
    return tryClaimOwnerDispatch(buildOwnerDispatchKey({ alertId }));
  }

  const memoryClaim = tryClaimOwnerDispatch(key);
  if (!memoryClaim.claimed) {
    return memoryClaim;
  }

  try {
    const db = getFirestore();
    const ref = db.collection(DISPATCH_CLAIMS_COLLECTION).doc(key);
    const existing = await ref.get();
    if (existing.exists) {
      const data = existing.data() || {};
      if (data.requestId) {
        claimedDispatchKeys.add(key);
        return {
          claimed: false,
          key,
          reason: 'already_dispatched',
          requestId: data.requestId,
        };
      }
    }
    return { claimed: true, key };
  } catch (error) {
    console.warn('[SensorDispatchDedup] Firestore claim lookup failed, using memory only:', error.message);
    return { claimed: true, key };
  }
}

export async function recordOwnerDispatchPersisted(alertId, requestId) {
  const key = normalizeKey(alertId);
  if (!key || !requestId) {
    return;
  }

  claimedDispatchKeys.add(key);

  try {
    const db = getFirestore();
    await db.collection(DISPATCH_CLAIMS_COLLECTION).doc(key).set({
      alertId: key,
      requestId,
      dispatchedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (error) {
    console.warn('[SensorDispatchDedup] Firestore claim record failed:', error.message);
  }
}
