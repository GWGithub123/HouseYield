import assert from 'node:assert/strict';

import { createAssistantActivityService } from './services/assistantActivityService.js';
import {
  buildAssistantScheduledTaskDedupeKey,
  claimAssistantScheduledTask,
  isAssistantScheduledTaskClaimable,
} from './services/assistantScheduledTaskService.js';

class FakeSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== undefined;
    this._value = value;
  }

  data() {
    return this._value === undefined ? undefined : structuredClone(this._value);
  }
}

class FakeDocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split('/').at(-1);
  }

  collection(name) {
    return new FakeCollectionReference(this.db, `${this.path}/${name}`);
  }

  async get() {
    return new FakeSnapshot(this, this.db.values.get(this.path));
  }

  async set(value, options = {}) {
    const current = this.db.values.get(this.path) || {};
    this.db.values.set(
      this.path,
      structuredClone(options.merge ? { ...current, ...value } : value),
    );
  }
}

class FakeQuery {
  constructor(collection, options = {}) {
    this.collection = collection;
    this.options = options;
  }

  orderBy(field, direction) {
    return new FakeQuery(this.collection, { ...this.options, orderBy: [field, direction] });
  }

  limit(limit) {
    return new FakeQuery(this.collection, { ...this.options, limit });
  }

  async get() {
    const prefix = `${this.collection.path}/`;
    let docs = [...this.collection.db.values.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, value]) => new FakeSnapshot(new FakeDocumentReference(this.collection.db, path), value));
    if (this.options.orderBy) {
      const [field, direction] = this.options.orderBy;
      docs.sort((left, right) => {
        const delta = Number(left.data()?.[field] || 0) - Number(right.data()?.[field] || 0);
        return direction === 'desc' ? -delta : delta;
      });
    }
    if (this.options.limit) docs = docs.slice(0, this.options.limit);
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeCollectionReference extends FakeQuery {
  constructor(db, path) {
    super(null);
    this.db = db;
    this.path = path;
    this.collection = this;
  }

  doc(id = `fake_${this.db.nextId++}`) {
    return new FakeDocumentReference(this.db, `${this.path}/${id}`);
  }
}

class FakeFirestore {
  constructor() {
    this.values = new Map();
    this.nextId = 1;
    this.transactionTail = Promise.resolve();
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
  }

  runTransaction(callback) {
    const run = this.transactionTail.then(async () => {
      const transaction = {
        get: (ref) => ref.get(),
        set: (ref, value, options) => ref.set(value, options),
      };
      return callback(transaction);
    });
    this.transactionTail = run.catch(() => {});
    return run;
  }
}

async function testActivityOwnershipAndIdempotency() {
  const db = new FakeFirestore();
  let clockMs = Date.parse('2026-07-11T12:00:00.000Z');
  const service = createAssistantActivityService({
    db,
    now: () => new Date(clockMs),
  });

  const first = await service.beginActivity({
    userId: 'owner-a',
    requestId: 'request-1',
    actionId: 'analyze-property',
    requestSummary: 'Analyze 123 Main Street',
  });
  assert.equal(first.created, true);
  assert.equal(first.activity.runId, 'request-1');
  assert.equal(first.activity.sequence, 1);

  await service.completeActivity({
    userId: 'owner-a',
    runId: first.activity.runId,
    response: {
      ok: true,
      actionId: 'analyze-property',
      summary: 'Analysis complete',
      result: { capRate: 7.1 },
      actions: [{ id: 'open', kind: 'navigate' }],
      artifacts: [{ id: 'report-1' }],
    },
  });

  const duplicate = await service.beginActivity({
    userId: 'owner-a',
    requestId: 'request-1',
    actionId: 'analyze-property',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.response.reused, true);
  assert.deepEqual(duplicate.response.result, { capRate: 7.1 });

  const wrongOwner = await service.getActivity({ userId: 'owner-b', runId: 'request-1' });
  assert.equal(wrongOwner.ok, false);

  const otherOwner = await service.beginActivity({
    userId: 'owner-b',
    requestId: 'request-1',
    actionId: 'analyze-property',
  });
  assert.equal(otherOwner.created, true);
  assert.equal(otherOwner.activity.sequence, 1);

  clockMs += 1000;
  const updated = await service.updateActivity({
    userId: 'owner-a',
    runId: 'request-1',
    updates: { status: 'needs_input', needsInput: true, error: null },
  });
  assert.equal(updated.ignored, 'terminal_activity');
  assert.equal(updated.activity.needsInput, false);
  assert.equal(updated.activity.status, 'completed');

  const listed = await service.listActivities({ userId: 'owner-a' });
  assert.equal(listed.activities.length, 1);
  assert.equal(listed.activities[0].requestSummary, 'Analyze 123 Main Street');
}

async function testScheduledClaimsAndLegacyCompatibility() {
  const db = new FakeFirestore();
  const now = new Date('2026-07-11T12:00:00.000Z');
  const taskRef = db.collection('users').doc('owner-a').collection('assistantScheduledTasks').doc('legacy-task');
  await taskRef.set({
    title: 'Legacy reminder',
    status: 'scheduled',
    runAt: '2026-07-11T11:00:00.000Z',
  });

  assert.equal(isAssistantScheduledTaskClaimable((await taskRef.get()).data(), now), true);
  const firstClaim = await claimAssistantScheduledTask({
    taskRef,
    userId: 'owner-a',
    now,
    leaseMs: 60_000,
    dbInstance: db,
  });
  assert.equal(firstClaim.claimed, true);
  assert.equal(firstClaim.task.attempts, 1);
  assert.equal(firstClaim.task.dedupeKey, buildAssistantScheduledTaskDedupeKey('owner-a', 'legacy-task'));

  const duplicateClaim = await claimAssistantScheduledTask({
    taskRef,
    userId: 'owner-a',
    now,
    dbInstance: db,
  });
  assert.equal(duplicateClaim.claimed, false);

  const recoveredAt = new Date('2026-07-11T12:02:00.000Z');
  const recoveryClaim = await claimAssistantScheduledTask({
    taskRef,
    userId: 'owner-a',
    now: recoveredAt,
    dbInstance: db,
  });
  assert.equal(recoveryClaim.claimed, true);
  assert.equal(recoveryClaim.task.attempts, 2);
  assert.notEqual(recoveryClaim.leaseId, firstClaim.leaseId);

  const oldRunningRef = db.collection('users').doc('owner-a').collection('assistantScheduledTasks').doc('old-running');
  await oldRunningRef.set({
    status: 'running',
    runAt: '2026-07-10T12:00:00.000Z',
  });
  assert.equal(isAssistantScheduledTaskClaimable((await oldRunningRef.get()).data(), now), true);
}

await testActivityOwnershipAndIdempotency();
await testScheduledClaimsAndLegacyCompatibility();

console.log('✅ Assistant activity/scheduler fixture passed');
