import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';
import { buildCanonicalManualJournalCandidate, postCanonicalManualJournalEntry } from './manualJournalBridge.js';

function parseArgs(argv) {
  const options = {
    userIds: [],
    allUsers: false,
    dryRun: false,
    postingMode: 'live',
    limit: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--user':
        if (argv[index + 1]) {
          options.userIds.push(argv[index + 1]);
          index += 1;
        }
        break;
      case '--all-users':
        options.allUsers = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--shadow':
        options.postingMode = 'shadow';
        break;
      case '--limit':
        if (argv[index + 1]) {
          options.limit = Math.max(1, parseInt(argv[index + 1], 10) || 1);
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  return options;
}

async function resolveUserIds(db, options) {
  if (options.allUsers) {
    const userDocs = await db.collection('users').listDocuments();
    return userDocs.map((doc) => doc.id);
  }

  return [...new Set(options.userIds.filter(Boolean))];
}

function createUserSummary(userId, scanned) {
  return {
    userId,
    scanned,
    evaluated: 0,
    posted: 0,
    duplicates: 0,
    notConfigured: 0,
    failed: 0,
    issues: []
  };
}

function recordBackfillOutcome(summary, journalEntryId, result, error = null) {
  summary.evaluated += 1;

  if (error) {
    summary.failed += 1;
    if (summary.issues.length < 25) {
      summary.issues.push({ journalEntryId, error: error.message });
    }
    return;
  }

  switch (result?.status) {
    case 'posted':
      summary.posted += 1;
      break;
    case 'duplicate':
      summary.duplicates += 1;
      break;
    case 'not_configured':
      summary.notConfigured += 1;
      break;
    default:
      summary.failed += 1;
      if (summary.issues.length < 25) {
        summary.issues.push({
          journalEntryId,
          error: result?.error || result?.reason || `Unexpected canonical posting status ${result?.status || 'unknown'}`
        });
      }
      break;
  }
}

async function backfillUserJournalEntries(db, userId, options) {
  const entriesRef = db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('journalEntries');
  const snapshot = await entriesRef.orderBy('entryDate', 'asc').get();
  const docs = options.limit ? snapshot.docs.slice(0, options.limit) : snapshot.docs;
  const summary = createUserSummary(userId, docs.length);

  for (const doc of docs) {
    const entry = doc.data();

    try {
      if (options.dryRun) {
        buildCanonicalManualJournalCandidate({ userId, journalEntryId: doc.id, entry });
        recordBackfillOutcome(summary, doc.id, { status: 'posted' });
        continue;
      }

      const result = await postCanonicalManualJournalEntry({
        userId,
        journalEntryId: doc.id,
        entry,
        postedBy: 'bookkeeping-backfill',
        postingMode: options.postingMode
      });
      recordBackfillOutcome(summary, doc.id, result);
    } catch (error) {
      recordBackfillOutcome(summary, doc.id, null, error);
    }
  }

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  initializeFirebaseAdmin();
  const db = getFirestore();
  const userIds = await resolveUserIds(db, options);

  if (userIds.length === 0) {
    throw new Error('Provide at least one --user <uid> or use --all-users');
  }

  const summaries = [];
  for (const userId of userIds) {
    summaries.push(await backfillUserJournalEntries(db, userId, options));
  }

  const totals = summaries.reduce((accumulator, summary) => ({
    users: accumulator.users + 1,
    scanned: accumulator.scanned + summary.scanned,
    evaluated: accumulator.evaluated + summary.evaluated,
    posted: accumulator.posted + summary.posted,
    duplicates: accumulator.duplicates + summary.duplicates,
    notConfigured: accumulator.notConfigured + summary.notConfigured,
    failed: accumulator.failed + summary.failed
  }), {
    users: 0,
    scanned: 0,
    evaluated: 0,
    posted: 0,
    duplicates: 0,
    notConfigured: 0,
    failed: 0
  });

  console.log(JSON.stringify({
    ok: totals.failed === 0,
    mode: options.dryRun ? 'dry-run' : options.postingMode,
    totals,
    users: summaries
  }, null, 2));

  if (totals.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[Accounting Core] Firestore journal backfill failed:', error);
  process.exitCode = 1;
});