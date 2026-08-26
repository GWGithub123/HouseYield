import { getFirestore } from './firebase-admin.js';

const parsedMonthlyLimit = parseInt(process.env.ATTOM_MONTHLY_CALL_LIMIT || '1000', 10);
const ATTOM_MONTHLY_LIMIT = Number.isFinite(parsedMonthlyLimit) && parsedMonthlyLimit >= 0
  ? parsedMonthlyLimit
  : 1000;
const USAGE_COLLECTION = process.env.ATTOM_USAGE_COLLECTION || 'attom_api_usage';
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE);
const ATTOM_HOST_PATTERN = /(^|\.)attomdata\.com$/i;
const WARNING_THRESHOLDS = [100, 50, 25, 10, 5, 0];

const localUsageByPeriod = new Map();
const localUsageSnapshotsByPeriod = new Map();
const loggedWarnings = new Set();

let usageDb;

function getUsageDb() {
  if (usageDb !== undefined) return usageDb;

  try {
    usageDb = getFirestore();
    console.log(`[ATTOM Limit] Firestore usage tracking enabled (${USAGE_COLLECTION})`);
  } catch (error) {
    usageDb = null;
    const message = error?.message || String(error);
    if (IS_PRODUCTION) {
      console.error('[ATTOM Limit] Firestore usage tracking unavailable in production:', message);
    } else {
      console.warn('[ATTOM Limit] Firestore usage tracking unavailable, using process-local limiter:', message);
    }
  }

  return usageDb;
}

function getPeriodWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const month = String(monthIndex + 1).padStart(2, '0');

  return {
    now,
    periodKey: `${year}-${month}`,
    periodStart: new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0)),
    resetAt: new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0)),
  };
}

function normalizeRequestPath(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url || 'unknown');
  }
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') {
    const converted = value.toDate();
    return converted instanceof Date ? converted : null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildUsageSnapshot({
  backend,
  periodKey,
  periodStart,
  resetAt,
  used = 0,
  updatedAt = null,
  lastReservedAt = null,
  lastRequestPath = null,
  lastContext = null,
}) {
  return {
    vendor: 'attom',
    backend,
    periodKey,
    periodStart: normalizeDate(periodStart),
    resetAt: normalizeDate(resetAt),
    limit: ATTOM_MONTHLY_LIMIT,
    used,
    remaining: Math.max(ATTOM_MONTHLY_LIMIT - used, 0),
    updatedAt: normalizeDate(updatedAt),
    lastReservedAt: normalizeDate(lastReservedAt),
    lastRequestPath: lastRequestPath || null,
    lastContext: lastContext || null,
  };
}

function maybeLogThreshold(snapshot) {
  for (const threshold of WARNING_THRESHOLDS) {
    if (snapshot.remaining <= threshold) {
      const key = `${snapshot.periodKey}:${threshold}`;
      if (!loggedWarnings.has(key)) {
        loggedWarnings.add(key);
        console.warn(
          `[ATTOM Limit] ${snapshot.used}/${snapshot.limit} calls used for ${snapshot.periodKey}; ` +
          `${snapshot.remaining} remaining before reset at ${snapshot.resetAt.toISOString()}`
        );
      }
      break;
    }
  }
}

export class AttomMonthlyLimitError extends Error {
  constructor({ limit, used, resetAt, backend }) {
    super(`ATTOM monthly API limit reached (${used}/${limit}). Next reset at ${resetAt.toISOString()}.`);
    this.name = 'AttomMonthlyLimitError';
    this.code = 'ATTOM_MONTHLY_LIMIT_EXCEEDED';
    this.statusCode = 429;
    this.limit = limit;
    this.used = used;
    this.resetAt = resetAt;
    this.backend = backend;
  }
}

class AttomUsageGuardUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttomUsageGuardUnavailableError';
    this.code = 'ATTOM_USAGE_GUARD_UNAVAILABLE';
    this.statusCode = 503;
  }
}

export function isAttomLimitError(error) {
  return error?.code === 'ATTOM_MONTHLY_LIMIT_EXCEEDED';
}

function reserveLocally(meta = {}) {
  const { now, periodKey, periodStart, resetAt } = getPeriodWindow();
  const currentUsed = localUsageByPeriod.get(periodKey) || 0;

  if (currentUsed >= ATTOM_MONTHLY_LIMIT) {
    throw new AttomMonthlyLimitError({
      limit: ATTOM_MONTHLY_LIMIT,
      used: currentUsed,
      resetAt,
      backend: 'memory',
    });
  }

  for (const existingKey of localUsageByPeriod.keys()) {
    if (existingKey !== periodKey) {
      localUsageByPeriod.delete(existingKey);
      localUsageSnapshotsByPeriod.delete(existingKey);
    }
  }

  const used = currentUsed + 1;
  localUsageByPeriod.set(periodKey, used);

  const snapshot = buildUsageSnapshot({
    backend: 'memory',
    periodKey,
    periodStart,
    resetAt,
    used,
    updatedAt: now,
    lastReservedAt: now,
    lastRequestPath: normalizeRequestPath(meta.url),
    lastContext: meta.context || null,
  });
  localUsageSnapshotsByPeriod.set(periodKey, snapshot);

  maybeLogThreshold(snapshot);
  return snapshot;
}

async function reserveInFirestore(meta = {}) {
  const db = getUsageDb();
  if (!db) {
    if (IS_PRODUCTION) {
      throw new AttomUsageGuardUnavailableError(
        'ATTOM usage tracking is unavailable in production, blocking ATTOM requests to avoid exceeding the monthly cap.'
      );
    }
    return reserveLocally(meta);
  }

  const { now, periodKey, periodStart, resetAt } = getPeriodWindow();
  const docRef = db.collection(USAGE_COLLECTION).doc(periodKey);

  const snapshot = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);
    const currentUsed = Number(doc.get('used')) || 0;

    if (currentUsed >= ATTOM_MONTHLY_LIMIT) {
      throw new AttomMonthlyLimitError({
        limit: ATTOM_MONTHLY_LIMIT,
        used: currentUsed,
        resetAt,
        backend: 'firestore',
      });
    }

    const used = currentUsed + 1;
    const payload = {
      vendor: 'attom',
      periodKey,
      periodStart,
      resetAt,
      limit: ATTOM_MONTHLY_LIMIT,
      used,
      remaining: Math.max(ATTOM_MONTHLY_LIMIT - used, 0),
      updatedAt: now,
      lastReservedAt: now,
      lastRequestPath: normalizeRequestPath(meta.url),
      lastContext: meta.context || null,
    };

    transaction.set(docRef, payload, { merge: true });
    return { ...payload, backend: 'firestore' };
  });

  maybeLogThreshold(snapshot);
  return snapshot;
}

export async function reserveAttomCall(meta = {}) {
  return reserveInFirestore(meta);
}

export async function getAttomUsageSnapshot() {
  const { now, periodKey, periodStart, resetAt } = getPeriodWindow();
  const db = getUsageDb();

  if (!db) {
    if (IS_PRODUCTION) {
      throw new AttomUsageGuardUnavailableError(
        'ATTOM usage tracking is unavailable in production, usage status cannot be read safely.'
      );
    }

    const used = localUsageByPeriod.get(periodKey) || 0;
    const snapshot = localUsageSnapshotsByPeriod.get(periodKey);

    return buildUsageSnapshot({
      backend: 'memory',
      periodKey,
      periodStart,
      resetAt,
      used,
      updatedAt: snapshot?.updatedAt || null,
      lastReservedAt: snapshot?.lastReservedAt || null,
      lastRequestPath: snapshot?.lastRequestPath || null,
      lastContext: snapshot?.lastContext || null,
    });
  }

  const docRef = db.collection(USAGE_COLLECTION).doc(periodKey);
  const doc = await docRef.get();
  const data = doc.exists ? (doc.data() || {}) : {};

  return buildUsageSnapshot({
    backend: 'firestore',
    periodKey,
    periodStart: data.periodStart || periodStart,
    resetAt: data.resetAt || resetAt,
    used: Number(data.used) || 0,
    updatedAt: data.updatedAt || null,
    lastReservedAt: data.lastReservedAt || null,
    lastRequestPath: data.lastRequestPath || null,
    lastContext: data.lastContext || null,
  });
}

export async function fetchAttom(url, init = {}, meta = {}) {
  const requestUrl = String(url);
  const parsedUrl = new URL(requestUrl);

  if (!ATTOM_HOST_PATTERN.test(parsedUrl.hostname)) {
    throw new Error(`fetchAttom only supports ATTOM hosts, received: ${parsedUrl.hostname}`);
  }

  await reserveAttomCall({ ...meta, url: requestUrl });
  return fetch(requestUrl, init);
}