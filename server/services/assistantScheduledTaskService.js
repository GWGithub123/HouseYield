/**
 * Per-user scheduled AI tasks / reminders.
 * Stored under users/{uid}/assistantScheduledTasks/{taskId}.
 * A lightweight cron batch marks due tasks and optionally executes linked actions.
 */

import crypto from 'crypto';

import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';
import {
  resolveScheduledRunAt as resolveScheduledRunAtPure,
} from './assistantScheduleTime.js';
import {
  beginAssistantActivity,
  completeAssistantActivity,
} from './assistantActivityService.js';

initializeFirebaseAdmin();

const db = getFirestore();
const TASKS_SUBCOLLECTION = 'assistantScheduledTasks';
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
const VALID_STATUSES = new Set(['scheduled', 'paused', 'running', 'completed', 'cancelled', 'failed']);
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

function clip(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function tasksCollection(userId) {
  return db.collection('users').doc(userId).collection(TASKS_SUBCOLLECTION);
}

function normalizeStatus(value) {
  const status = String(value || 'scheduled').toLowerCase().trim();
  return VALID_STATUSES.has(status) ? status : 'scheduled';
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function isAssistantScheduledTaskClaimable(task = {}, now = new Date()) {
  const nowMs = now.getTime();
  if (task.status === 'scheduled' || !task.status) {
    const dueAt = toMillis(task.nextAttemptAt || task.runAt);
    return dueAt !== null && dueAt <= nowMs;
  }
  if (task.status === 'running') {
    const leaseExpiresAt = toMillis(task.leaseExpiresAt);
    return leaseExpiresAt === null || leaseExpiresAt <= nowMs;
  }
  return false;
}

export function buildAssistantScheduledTaskDedupeKey(userId, taskId, existingKey = null) {
  return existingKey || `scheduled:${userId}:${taskId}`;
}

/**
 * Resolve a natural-language or structured schedule into a Date.
 * Natural-language `when` always wins over model-invented ISO `runAt`.
 */
export function resolveScheduledRunAt(args = {}) {
  return resolveScheduledRunAtPure({
    timeZone: DEFAULT_TIME_ZONE,
    ...args,
  });
}

function serializeTask(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    ...data,
  };
}

export async function listAssistantScheduledTasks({
  userId,
  includeCompleted = false,
  limit = 40,
} = {}) {
  if (!userId) throw new Error('userId is required');

  const snapshot = await tasksCollection(userId)
    .orderBy('runAt', 'asc')
    .limit(Math.min(Math.max(Number(limit) || 40, 1), 100))
    .get();

  let tasks = snapshot.docs.map(serializeTask);
  if (!includeCompleted) {
    tasks = tasks.filter((task) => (
      task.status === 'scheduled'
      || task.status === 'paused'
      || task.status === 'running'
      || task.status === 'failed'
    ));
  }

  return { ok: true, tasks };
}

export async function createAssistantScheduledTask({
  userId,
  title,
  notes,
  runAt,
  when,
  scheduledFor,
  date,
  time,
  timeZone,
  actionId = null,
  parameters = {},
  propertyId = null,
  propertyAddress = null,
  tenantId = null,
  tenantName = null,
  kind = null,
  requestId = null,
  dedupeKey = null,
} = {}) {
  if (!userId) throw new Error('userId is required');

  const resolvedTitle = clip(title || notes || parameters?.requestSummary || 'Scheduled AI task', 120);
  if (!resolvedTitle) {
    throw new Error('title is required');
  }

  const resolvedRunAt = resolveScheduledRunAt({
    runAt,
    when,
    scheduledFor,
    date,
    time,
    timeZone: timeZone || DEFAULT_TIME_ZONE,
  });

  if (!resolvedRunAt) {
    throw new Error('Could not understand when this should run. Try “Monday at 2pm” or an exact date/time.');
  }

  const nowIso = new Date().toISOString();
  const suppliedDedupeKey = String(dedupeKey || requestId || '').trim();
  const deterministicId = suppliedDedupeKey
    ? `task_${crypto.createHash('sha256').update(suppliedDedupeKey).digest('hex').slice(0, 32)}`
    : null;
  const taskRef = deterministicId
    ? tasksCollection(userId).doc(deterministicId)
    : tasksCollection(userId).doc();
  const task = {
    id: taskRef.id,
    title: resolvedTitle,
    notes: clip(notes || '', 2000),
    runAt: resolvedRunAt.toISOString(),
    timeZone: timeZone || DEFAULT_TIME_ZONE,
    status: 'scheduled',
    kind: kind || (actionId ? 'action' : 'reminder'),
    actionId: actionId || null,
    parameters: parameters && typeof parameters === 'object' ? parameters : {},
    propertyId: propertyId || parameters?.propertyId || null,
    propertyAddress: propertyAddress || parameters?.propertyAddress || null,
    tenantId: tenantId || parameters?.tenantId || null,
    tenantName: tenantName || parameters?.tenantName || null,
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: null,
    lastError: null,
    resultSummary: null,
    requestId: requestId || null,
    dedupeKey: suppliedDedupeKey || buildAssistantScheduledTaskDedupeKey(userId, taskRef.id),
    attempts: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    lastAttemptAt: null,
    nextAttemptAt: null,
    leaseId: null,
    leaseExpiresAt: null,
    activityRunId: null,
  };

  if (deterministicId) {
    return db.runTransaction(async (transaction) => {
      const existing = await transaction.get(taskRef);
      if (existing.exists) {
        return { ok: true, task: serializeTask(existing), reused: true };
      }
      transaction.set(taskRef, task);
      return { ok: true, task, reused: false };
    });
  }

  await taskRef.set(task);
  return { ok: true, task, reused: false };
}

export async function updateAssistantScheduledTask({
  userId,
  taskId,
  updates = {},
} = {}) {
  if (!userId || !taskId) throw new Error('userId and taskId are required');

  const ref = tasksCollection(userId).doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, error: 'Task not found' };
  }

  const patch = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.title !== undefined) patch.title = clip(updates.title, 120);
  if (updates.notes !== undefined) patch.notes = clip(updates.notes, 2000);
  if (updates.status !== undefined) patch.status = normalizeStatus(updates.status);
  if (updates.actionId !== undefined) patch.actionId = updates.actionId || null;
  if (updates.parameters !== undefined) patch.parameters = updates.parameters || {};
  if (updates.resultSummary !== undefined) patch.resultSummary = clip(updates.resultSummary, 500);
  if (updates.lastError !== undefined) patch.lastError = updates.lastError || null;

  if (updates.runAt || updates.when || updates.scheduledFor || updates.date || updates.time) {
    const resolved = resolveScheduledRunAt({
      runAt: updates.runAt,
      when: updates.when,
      scheduledFor: updates.scheduledFor,
      date: updates.date,
      time: updates.time,
      timeZone: updates.timeZone,
    });
    if (!resolved) {
      return { ok: false, error: 'Could not understand the new schedule time.' };
    }
    patch.runAt = resolved.toISOString();
  }

  if (patch.status === 'completed' || patch.status === 'cancelled') {
    patch.completedAt = new Date().toISOString();
  }

  await ref.set(patch, { merge: true });
  const next = await ref.get();
  return { ok: true, task: serializeTask(next) };
}

export async function cancelAssistantScheduledTask({ userId, taskId } = {}) {
  return updateAssistantScheduledTask({
    userId,
    taskId,
    updates: { status: 'cancelled' },
  });
}

export async function deleteAssistantScheduledTask({ userId, taskId } = {}) {
  if (!userId || !taskId) throw new Error('userId and taskId are required');
  await tasksCollection(userId).doc(taskId).delete();
  return { ok: true };
}

export async function claimAssistantScheduledTask({
  taskRef,
  userId,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  dbInstance = db,
} = {}) {
  if (!taskRef || !userId) throw new Error('taskRef and userId are required');
  return dbInstance.runTransaction(async (transaction) => {
    const snap = await transaction.get(taskRef);
    if (!snap.exists) return { claimed: false, reason: 'not_found' };
    const task = { id: snap.id, ...(snap.data() || {}) };
    if (!isAssistantScheduledTaskClaimable(task, now)) {
      return { claimed: false, reason: 'not_claimable', task };
    }

    const attempts = (Number(task.attempts) || 0) + 1;
    const maxAttempts = Math.max(Number(task.maxAttempts) || DEFAULT_MAX_ATTEMPTS, 1);
    if (attempts > maxAttempts) {
      transaction.set(taskRef, {
        status: 'failed',
        lastError: task.lastError || 'maximum_attempts_exceeded',
        updatedAt: now.toISOString(),
        completedAt: now.toISOString(),
        leaseId: null,
        leaseExpiresAt: null,
      }, { merge: true });
      return { claimed: false, reason: 'attempts_exhausted', task };
    }

    const leaseId = crypto.randomUUID();
    const dedupeKey = buildAssistantScheduledTaskDedupeKey(userId, task.id, task.dedupeKey);
    const leaseExpiresAt = new Date(now.getTime() + Math.max(Number(leaseMs) || DEFAULT_LEASE_MS, 1000)).toISOString();
    const patch = {
      status: 'running',
      attempts,
      maxAttempts,
      dedupeKey,
      activityRunId: task.activityRunId || dedupeKey,
      leaseId,
      leaseExpiresAt,
      lastAttemptAt: now.toISOString(),
      nextAttemptAt: null,
      updatedAt: now.toISOString(),
    };
    transaction.set(taskRef, patch, { merge: true });
    return { claimed: true, leaseId, task: { ...task, ...patch } };
  });
}

async function settleClaimedTask({
  taskRef,
  leaseId,
  patch,
  now = new Date(),
  dbInstance = db,
} = {}) {
  return dbInstance.runTransaction(async (transaction) => {
    const snap = await transaction.get(taskRef);
    if (!snap.exists) return false;
    const current = snap.data() || {};
    if (current.status !== 'running' || current.leaseId !== leaseId) return false;
    transaction.set(taskRef, {
      ...patch,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now.toISOString(),
    }, { merge: true });
    return true;
  });
}

/**
 * Find due scheduled tasks across users and execute linked actions when present.
 */
export async function runAssistantScheduledTaskBatch({
  reason = 'scheduler',
  now = new Date(),
  limitPerUser = 10,
  maxUsers = 200,
} = {}) {
  const summary = {
    reason,
    scannedUsers: 0,
    due: 0,
    completed: 0,
    failed: 0,
    reminders: 0,
  };

  // Include expired/legacy running records so a crashed worker cannot strand work.
  let dueDocs = [];
  try {
    const [scheduledSnap, runningSnap] = await Promise.all([
      db.collectionGroup(TASKS_SUBCOLLECTION)
      .where('status', '==', 'scheduled')
      .where('runAt', '<=', now.toISOString())
      .limit(Math.min(maxUsers * limitPerUser, 500))
      .get(),
      db.collectionGroup(TASKS_SUBCOLLECTION)
        .where('status', '==', 'running')
        .limit(Math.min(maxUsers * limitPerUser, 500))
        .get(),
    ]);
    const byPath = new Map();
    for (const doc of [...scheduledSnap.docs, ...runningSnap.docs]) {
      if (isAssistantScheduledTaskClaimable(doc.data() || {}, now)) byPath.set(doc.ref.path, doc);
    }
    dueDocs = [...byPath.values()];
  } catch (error) {
    console.warn('[AssistantScheduledTasks] collectionGroup query failed, falling back:', error.message);
    const usersSnap = await db.collection('users').limit(maxUsers).get();
    summary.scannedUsers = usersSnap.size;
    for (const userDoc of usersSnap.docs) {
      const scheduledSnap = await userDoc.ref.collection(TASKS_SUBCOLLECTION)
        .where('status', '==', 'scheduled')
        .where('runAt', '<=', now.toISOString())
        .limit(limitPerUser)
        .get();
      const runningSnap = await userDoc.ref.collection(TASKS_SUBCOLLECTION)
        .where('status', '==', 'running')
        .limit(limitPerUser)
        .get();
      dueDocs.push(
        ...scheduledSnap.docs,
        ...runningSnap.docs.filter((doc) => isAssistantScheduledTaskClaimable(doc.data() || {}, now)),
      );
    }
  }

  summary.due = dueDocs.length;
  if (!dueDocs.length) return summary;

  const { executeAssistantAction } = await import('./assistantActionExecutionService.js');

  for (const doc of dueDocs) {
    const userId = doc.ref.parent.parent?.id;
    if (!userId) continue;
    const claim = await claimAssistantScheduledTask({ taskRef: doc.ref, userId, now });
    if (!claim.claimed) continue;
    const task = claim.task;

    try {
      if (task.actionId) {
        const result = await executeAssistantAction({
          userId,
          actionId: task.actionId,
          runId: task.activityRunId || task.dedupeKey,
          requestId: task.dedupeKey,
          idempotencyKey: task.dedupeKey,
          retryFailed: true,
          recoverRunning: task.attempts > 1,
          parameters: {
            ...(task.parameters || {}),
            propertyId: task.propertyId || task.parameters?.propertyId,
            propertyAddress: task.propertyAddress || task.parameters?.propertyAddress,
            tenantId: task.tenantId || task.parameters?.tenantId,
            tenantName: task.tenantName || task.parameters?.tenantName,
            autoSend: task.parameters?.autoSend === true,
            requestSummary: task.parameters?.requestSummary || task.title,
          },
        });

        if (result?.ok === false && !result?.needsInput) {
          const attempts = Number(task.attempts) || 1;
          const maxAttempts = Number(task.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
          const willRetry = attempts < maxAttempts;
          const retryAt = new Date(now.getTime() + Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** (attempts - 1))));
          await settleClaimedTask({
            taskRef: doc.ref,
            leaseId: claim.leaseId,
            now,
            patch: {
              status: willRetry ? 'scheduled' : 'failed',
              lastError: result.error || result.summary || 'action_failed',
              resultSummary: clip(result.summary || result.error || 'Action failed', 500),
              completedAt: willRetry ? null : now.toISOString(),
              nextAttemptAt: willRetry ? retryAt.toISOString() : null,
              runAt: willRetry ? retryAt.toISOString() : task.runAt,
              activityRunId: result.runId || task.activityRunId || task.dedupeKey,
            },
          });
          summary.failed += 1;
          continue;
        }

        await settleClaimedTask({
          taskRef: doc.ref,
          leaseId: claim.leaseId,
          now,
          patch: {
            status: 'completed',
            lastError: null,
            resultSummary: clip(result.summary || `Ran ${task.actionId}`, 500),
            completedAt: now.toISOString(),
            activityRunId: result.runId || task.activityRunId || task.dedupeKey,
            executionResult: {
              actionId: result.actionId,
              title: result.title,
              summary: result.summary,
              ok: result.ok,
            },
          },
        });
        summary.completed += 1;
      } else {
        const activity = await beginAssistantActivity({
          userId,
          runId: task.activityRunId || task.dedupeKey,
          requestId: task.dedupeKey,
          idempotencyKey: task.dedupeKey,
          actionId: 'scheduled-reminder',
          requestSummary: task.title,
          retryFailed: true,
          recoverRunning: task.attempts > 1,
        });
        const reminderResponse = activity.created
          ? {
            ok: true,
            actionId: 'scheduled-reminder',
            summary: clip(`Reminder due: ${task.title}`, 500),
            result: {
              type: 'reminder',
              title: task.title,
              message: task.notes || task.title,
            },
            actions: [],
            artifacts: [],
            runId: activity.activity.runId,
            requestId: task.dedupeKey,
            idempotencyKey: task.dedupeKey,
          }
          : activity.response;
        if (activity.created) {
          await completeAssistantActivity({
            userId,
            runId: activity.activity.runId,
            response: reminderResponse,
          });
        }
        await settleClaimedTask({
          taskRef: doc.ref,
          leaseId: claim.leaseId,
          now,
          patch: {
            status: 'completed',
            resultSummary: clip(`Reminder due: ${task.title}`, 500),
            completedAt: now.toISOString(),
            activityRunId: activity.activity.runId,
          },
        });
        summary.reminders += 1;
        summary.completed += 1;
      }
    } catch (error) {
      const attempts = Number(task.attempts) || 1;
      const maxAttempts = Number(task.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
      const willRetry = attempts < maxAttempts;
      const retryAt = new Date(now.getTime() + Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** (attempts - 1))));
      await settleClaimedTask({
        taskRef: doc.ref,
        leaseId: claim.leaseId,
        now,
        patch: {
          status: willRetry ? 'scheduled' : 'failed',
          lastError: error.message || 'execution_failed',
          completedAt: willRetry ? null : now.toISOString(),
          nextAttemptAt: willRetry ? retryAt.toISOString() : null,
          runAt: willRetry ? retryAt.toISOString() : task.runAt,
        },
      }).catch(() => {});
      summary.failed += 1;
      console.warn('[AssistantScheduledTasks] Task execution failed:', task.id, error.message);
    }
  }

  return summary;
}
