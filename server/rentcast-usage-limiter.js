import { getFirestore } from './firebase-admin.js';

const parsedMonthlyLimit = parseInt(process.env.RENTCAST_MONTHLY_CALL_LIMIT || '1000', 10);
const RENTCAST_MONTHLY_LIMIT = Number.isFinite(parsedMonthlyLimit) && parsedMonthlyLimit >= 0
  ? parsedMonthlyLimit
  : 1000;
const USAGE_COLLECTION = process.env.RENTCAST_USAGE_COLLECTION || 'rentcast_api_usage';
const WARNING_THRESHOLDS = [100, 50, 25, 10, 5, 0];

const localUsageByPeriod = new Map();
const loggedWarnings = new Set();

let usageDb;

function getUsageDb() {
  if (usageDb !== undefined) return usageDb;
  try {
    usageDb = getFirestore();
    console.log(`[RentCast Limit] Firestore usage tracking enabled (${USAGE_COLLECTION})`);
  } catch (error) {
    usageDb = null;
    console.warn('[RentCast Limit] Firestore unavailable, using process-local limiter:', error?.message || error);
  }
  return usageDb;
}

function getPeriodWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  return {
    now,
    periodKey: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    resetAt: new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0)),
  };
}

export class RentcastMonthlyLimitError extends Error {
  constructor({ limit, used, resetAt }) {
    super(`RentCast monthly API limit reached (${used}/${limit}). Next reset at ${resetAt.toISOString()}.`);
    this.name = 'RentcastMonthlyLimitError';
    this.code = 'RENTCAST_MONTHLY_LIMIT_EXCEEDED';
    this.statusCode = 429;
    this.limit = limit;
    this.used = used;
    this.resetAt = resetAt;
  }
}

export function isRentcastLimitError(error) {
  return error?.code === 'RENTCAST_MONTHLY_LIMIT_EXCEEDED';
}

function maybeLogThreshold(periodKey, used) {
  const remaining = Math.max(RENTCAST_MONTHLY_LIMIT - used, 0);
  for (const threshold of WARNING_THRESHOLDS) {
    if (remaining <= threshold) {
      const key = `${periodKey}:${threshold}`;
      if (!loggedWarnings.has(key)) {
        loggedWarnings.add(key);
        console.warn(`[RentCast Limit] ${used}/${RENTCAST_MONTHLY_LIMIT} calls used for ${periodKey}; ${remaining} remaining`);
      }
      break;
    }
  }
}

/**
 * Reserve one RentCast API call. Throws RentcastMonthlyLimitError when over budget.
 */
export async function reserveRentcastCall(meta = {}) {
  const { now, periodKey, resetAt } = getPeriodWindow();
  const db = getUsageDb();

  if (!db) {
    const used = (localUsageByPeriod.get(periodKey) || 0);
    if (used >= RENTCAST_MONTHLY_LIMIT) {
      throw new RentcastMonthlyLimitError({ limit: RENTCAST_MONTHLY_LIMIT, used, resetAt });
    }
    for (const key of localUsageByPeriod.keys()) {
      if (key !== periodKey) localUsageByPeriod.delete(key);
    }
    localUsageByPeriod.set(periodKey, used + 1);
    maybeLogThreshold(periodKey, used + 1);
    return { used: used + 1, limit: RENTCAST_MONTHLY_LIMIT, backend: 'memory' };
  }

  const docRef = db.collection(USAGE_COLLECTION).doc(periodKey);
  const snapshot = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);
    const currentUsed = Number(doc.get('used')) || 0;
    if (currentUsed >= RENTCAST_MONTHLY_LIMIT) {
      throw new RentcastMonthlyLimitError({ limit: RENTCAST_MONTHLY_LIMIT, used: currentUsed, resetAt });
    }
    const used = currentUsed + 1;
    transaction.set(docRef, {
      vendor: 'rentcast',
      periodKey,
      resetAt,
      limit: RENTCAST_MONTHLY_LIMIT,
      used,
      remaining: Math.max(RENTCAST_MONTHLY_LIMIT - used, 0),
      updatedAt: now,
      lastContext: meta.context || null,
    }, { merge: true });
    return { used, limit: RENTCAST_MONTHLY_LIMIT, backend: 'firestore' };
  });

  maybeLogThreshold(periodKey, snapshot.used);
  return snapshot;
}

export async function getRentcastUsageSnapshot() {
  const { periodKey, resetAt } = getPeriodWindow();
  const db = getUsageDb();

  if (!db) {
    const used = localUsageByPeriod.get(periodKey) || 0;
    return { periodKey, used, limit: RENTCAST_MONTHLY_LIMIT, remaining: Math.max(RENTCAST_MONTHLY_LIMIT - used, 0), resetAt, backend: 'memory' };
  }

  const doc = await db.collection(USAGE_COLLECTION).doc(periodKey).get();
  const used = doc.exists ? (Number(doc.data()?.used) || 0) : 0;
  return { periodKey, used, limit: RENTCAST_MONTHLY_LIMIT, remaining: Math.max(RENTCAST_MONTHLY_LIMIT - used, 0), resetAt, backend: 'firestore' };
}
