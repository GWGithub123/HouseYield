/**
 * Durable, per-user assistant execution activity.
 * Records live under users/{uid}/assistantActivities/{runId}; callers never
 * query a top-level collection, so ownership is enforced by construction.
 */

import crypto from 'crypto';

import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';

let defaultDb = null;
function getDefaultDb() {
  if (!defaultDb) {
    initializeFirebaseAdmin();
    defaultDb = getFirestore();
  }
  return defaultDb;
}
const ACTIVITIES_SUBCOLLECTION = 'assistantActivities';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const VALID_STATUSES = new Set(['queued', 'running', 'needs_input', ...TERMINAL_STATUSES]);

function clip(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function cleanId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 180 && !text.includes('/')) return text;
  return `run_${crypto.createHash('sha256').update(text).digest('hex').slice(0, 40)}`;
}

export function normalizeAssistantRunId({ runId, requestId, idempotencyKey } = {}) {
  const supplied = cleanId(runId || idempotencyKey || requestId);
  return supplied || `run_${crypto.randomUUID()}`;
}

export function isAssistantActivityTerminal(status) {
  return TERMINAL_STATUSES.has(String(status || '').toLowerCase());
}

function activitiesCollection(db, userId) {
  if (!userId) throw new Error('userId is required');
  return db.collection('users').doc(userId).collection(ACTIVITIES_SUBCOLLECTION);
}

function serializeActivity(doc) {
  if (!doc?.exists) return null;
  const data = doc.data() || {};
  return {
    ...data,
    id: doc.id,
    runId: data.runId || doc.id,
  };
}

function responseFromActivity(activity) {
  if (!activity) return null;
  if (activity.response && typeof activity.response === 'object') {
    return {
      ...activity.response,
      runId: activity.runId,
      requestId: activity.requestId || activity.response.requestId || null,
      idempotencyKey: activity.idempotencyKey || activity.response.idempotencyKey || null,
      reused: true,
    };
  }
  return {
    ok: activity.status !== 'failed',
    actionId: activity.actionId || null,
    summary: activity.requestSummary || '',
    needsInput: activity.needsInput === true,
    result: activity.result || null,
    actions: activity.actions || [],
    artifacts: activity.artifacts || [],
    error: activity.error || null,
    runId: activity.runId,
    requestId: activity.requestId || null,
    idempotencyKey: activity.idempotencyKey || null,
    reused: true,
  };
}

export function createAssistantActivityService({ db = null, now = () => new Date() } = {}) {
  async function beginActivity({
    userId,
    runId,
    requestId = null,
    idempotencyKey = null,
    actionId,
    requestSummary = '',
    retryFailed = false,
    recoverRunning = false,
  } = {}) {
    if (!userId || !actionId) throw new Error('userId and actionId are required');
    const database = db || getDefaultDb();
    const resolvedRunId = normalizeAssistantRunId({ runId, requestId, idempotencyKey });
    const ref = activitiesCollection(database, userId).doc(resolvedRunId);
    const nowIso = now().toISOString();

    return database.runTransaction(async (transaction) => {
      const existingSnap = await transaction.get(ref);
      const existing = serializeActivity(existingSnap);
      const mayRestart = (retryFailed && existing?.status === 'failed')
        || (recoverRunning && existing?.status === 'running');
      if (existing && !mayRestart) {
        return {
          created: false,
          activity: existing,
          response: responseFromActivity(existing),
        };
      }

      const sequence = existing ? (Number(existing.sequence) || 0) + 1 : 1;

      const activity = {
        runId: resolvedRunId,
        actionId: String(actionId).trim(),
        requestId: requestId ? clip(requestId, 500) : null,
        idempotencyKey: idempotencyKey ? clip(idempotencyKey, 500) : null,
        requestSummary: clip(requestSummary, 1000),
        status: 'running',
        sequence,
        createdAt: existing?.createdAt || nowIso,
        startedAt: nowIso,
        updatedAt: nowIso,
        completedAt: null,
        needsInput: false,
        result: null,
        actions: [],
        artifacts: [],
        error: null,
        response: null,
        attempts: (Number(existing?.attempts) || 0) + 1,
      };
      transaction.set(ref, activity, { merge: true });
      return { created: true, activity: { id: resolvedRunId, ...activity }, response: null };
    });
  }

  async function completeActivity({ userId, runId, response } = {}) {
    if (!userId || !runId) throw new Error('userId and runId are required');
    const database = db || getDefaultDb();
    const ref = activitiesCollection(database, userId).doc(cleanId(runId));
    const nowIso = now().toISOString();
    const needsInput = response?.needsInput === true;
    const status = needsInput ? 'needs_input' : response?.ok === false ? 'failed' : 'completed';
    return database.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const existing = serializeActivity(snap);
      const patch = {
        status,
        sequence: (Number(existing?.sequence) || 0) + 1,
        needsInput,
        result: response?.result || null,
        actions: Array.isArray(response?.actions) ? response.actions : [],
        artifacts: Array.isArray(response?.artifacts) ? response.artifacts : [],
        error: response?.error || null,
        response: response && typeof response === 'object' ? response : null,
        updatedAt: nowIso,
        completedAt: status === 'needs_input' ? null : nowIso,
      };
      transaction.set(ref, patch, { merge: true });
      return { ...(existing || { id: cleanId(runId), runId: cleanId(runId) }), ...patch };
    });
  }

  async function failActivity({ userId, runId, error } = {}) {
    const message = error?.message || String(error || 'assistant_action_execution_failed');
    return completeActivity({
      userId,
      runId,
      response: { ok: false, error: message },
    });
  }

  async function listActivities({ userId, limit = 40, status = null, actionId = null } = {}) {
    const database = db || getDefaultDb();
    let query = activitiesCollection(database, userId).orderBy('updatedAt', 'desc');
    query = query.limit(Math.min(Math.max(Number(limit) || 40, 1), 100));
    const snapshot = await query.get();
    let activities = snapshot.docs.map(serializeActivity);
    if (status) activities = activities.filter((item) => item.status === status);
    if (actionId) activities = activities.filter((item) => item.actionId === actionId);
    return { ok: true, activities };
  }

  async function getActivity({ userId, runId } = {}) {
    if (!runId) throw new Error('runId is required');
    const database = db || getDefaultDb();
    const snap = await activitiesCollection(database, userId).doc(cleanId(runId)).get();
    const activity = serializeActivity(snap);
    return activity
      ? { ok: true, activity }
      : { ok: false, error: 'activity_not_found' };
  }

  async function updateActivity({ userId, runId, updates = {} } = {}) {
    if (!runId) throw new Error('runId is required');
    const database = db || getDefaultDb();
    const ref = activitiesCollection(database, userId).doc(cleanId(runId));
    return database.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const existing = serializeActivity(snap);
      if (!existing) return { ok: false, error: 'activity_not_found' };
      if (Number.isFinite(Number(updates.sequence)) && Number(updates.sequence) <= (Number(existing.sequence) || 0)) {
        return { ok: true, activity: existing, ignored: 'stale_sequence' };
      }

      const patch = {
        updatedAt: now().toISOString(),
        sequence: Number.isFinite(Number(updates.sequence))
          ? Number(updates.sequence)
          : (Number(existing.sequence) || 0) + 1,
      };
      if (updates.status !== undefined) {
        const status = String(updates.status || '').toLowerCase();
        if (!VALID_STATUSES.has(status)) throw new Error('invalid_activity_status');
        if (isAssistantActivityTerminal(existing.status) && status !== existing.status) {
          return { ok: true, activity: existing, ignored: 'terminal_activity' };
        }
        patch.status = status;
        if (TERMINAL_STATUSES.has(status)) patch.completedAt = patch.updatedAt;
      }
      if (updates.needsInput !== undefined) patch.needsInput = updates.needsInput === true;
      if (updates.result !== undefined) patch.result = updates.result;
      if (updates.actions !== undefined) patch.actions = Array.isArray(updates.actions) ? updates.actions : [];
      if (updates.artifacts !== undefined) patch.artifacts = Array.isArray(updates.artifacts) ? updates.artifacts : [];
      if (updates.error !== undefined) patch.error = updates.error || null;
      if (updates.requestSummary !== undefined) patch.requestSummary = clip(updates.requestSummary, 1000);
      transaction.set(ref, patch, { merge: true });
      return { ok: true, activity: { ...existing, ...patch } };
    });
  }

  return {
    beginActivity,
    completeActivity,
    failActivity,
    getActivity,
    listActivities,
    updateActivity,
  };
}

const service = createAssistantActivityService();

export const beginAssistantActivity = service.beginActivity;
export const completeAssistantActivity = service.completeActivity;
export const failAssistantActivity = service.failActivity;
export const getAssistantActivity = service.getActivity;
export const listAssistantActivities = service.listActivities;
export const updateAssistantActivity = service.updateActivity;
