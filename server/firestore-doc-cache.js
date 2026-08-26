import crypto from 'crypto';
import { initializeFirebaseAdmin } from './firebase-admin.js';

let db = null;

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
  } catch (err) {
    console.warn('[DocCache] Firestore unavailable:', err.message);
  }
  return db;
}

export function hashCacheKey(parts) {
  const raw = typeof parts === 'string' ? parts : JSON.stringify(parts);
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

/**
 * Generic Firestore document cache read.
 * @returns {{ data: object, ageHours: number, isStale: boolean } | null}
 */
export async function getCachedDoc(collection, key, ttlHours, staleThresholdHours = null) {
  const firestore = getDb();
  if (!firestore || !collection || !key) return null;

  try {
    const doc = await firestore.collection(collection).doc(key).get();
    if (!doc.exists) return null;

    const payload = doc.data();
    const updatedAt = payload.updatedAt?.toDate?.() || new Date(payload.updatedAt || 0);
    const ageHours = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);

    if (Number.isFinite(ttlHours) && ageHours > ttlHours) return null;

    const staleAt = Number.isFinite(staleThresholdHours) ? staleThresholdHours : (ttlHours ? ttlHours * 0.8 : Infinity);
    return { data: payload.data ?? null, ageHours, isStale: ageHours > staleAt };
  } catch (err) {
    console.error(`[DocCache] Read error (${collection}/${key}):`, err.message);
    return null;
  }
}

export async function setCachedDoc(collection, key, data, meta = {}) {
  const firestore = getDb();
  if (!firestore || !collection || !key || data === undefined) return;

  try {
    const admin = (await import('firebase-admin')).default;
    await firestore.collection(collection).doc(key).set({
      ...meta,
      data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[DocCache] Write error (${collection}/${key}):`, err.message);
  }
}
