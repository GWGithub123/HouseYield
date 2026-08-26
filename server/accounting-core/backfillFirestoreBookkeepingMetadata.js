import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';
import { getDefaultChartAccountByCode } from '../../src/shared/chartOfAccounts.js';
import {
  ensureBookkeepingInitializedInAzure,
  upsertBookkeepingAccountInAzure,
  upsertBookkeepingPropertyInAzure,
  upsertBookkeepingVendorInAzure
} from './bookkeepingMetadataStore.js';

const BACKFILL_TYPES = ['accounts', 'properties', 'vendors'];

function parseArgs(argv) {
  const options = {
    userIds: [],
    allUsers: false,
    dryRun: false,
    limit: null,
    types: [...BACKFILL_TYPES]
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
      case '--limit':
        if (argv[index + 1]) {
          options.limit = Math.max(1, parseInt(argv[index + 1], 10) || 1);
          index += 1;
        }
        break;
      case '--types':
        if (argv[index + 1]) {
          const requestedTypes = argv[index + 1]
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean);
          options.types = requestedTypes.filter((value) => BACKFILL_TYPES.includes(value));
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

function createTypeSummary(type, scanned) {
  return {
    type,
    scanned,
    evaluated: 0,
    upserted: 0,
    notConfigured: 0,
    failed: 0,
    issues: []
  };
}

function createUserSummary(userId) {
  return {
    userId,
    collections: Object.fromEntries(BACKFILL_TYPES.map((type) => [type, createTypeSummary(type, 0)]))
  };
}

function recordOutcome(summary, refId, result, error = null) {
  summary.evaluated += 1;

  if (error) {
    summary.failed += 1;
    if (summary.issues.length < 25) {
      summary.issues.push({ refId, error: error.message });
    }
    return;
  }

  if (result?.status === 'not_configured') {
    summary.notConfigured += 1;
    return;
  }

  if (result?.ok) {
    summary.upserted += 1;
    return;
  }

  summary.failed += 1;
  if (summary.issues.length < 25) {
    summary.issues.push({
      refId,
      error: result?.error || `Unexpected result status ${result?.status || 'unknown'}`
    });
  }
}

function trimObject(value, excludedKeys) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entryValue]) => entryValue !== undefined)
      .filter(([key]) => !excludedKeys.includes(key))
  );
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', 'n', '0'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

async function backfillAccounts(db, userId, options, summary) {
  const snapshot = await db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('accounts').get();
  const docs = options.limit ? snapshot.docs.slice(0, options.limit) : snapshot.docs;
  summary.scanned = docs.length;

  for (const doc of docs) {
    const account = doc.data() || {};
    const code = String(account.code || doc.id || '').trim();
    const defaultAccount = getDefaultChartAccountByCode(code);
    const name = String(account.name || defaultAccount?.name || '').trim();
    const type = String(account.type || defaultAccount?.type || '').trim();

    if (!code || !name || !type) {
      recordOutcome(summary, doc.id, null, new Error('Account requires code, name, and type')); 
      continue;
    }

    try {
      if (options.dryRun) {
        recordOutcome(summary, code, { ok: true, status: 'ready' });
        continue;
      }

      const result = await upsertBookkeepingAccountInAzure({
        userId,
        code,
        name,
        type,
        subtype: account.subtype || defaultAccount?.subtype || null,
        isActive: normalizeBoolean(account.isActive, true)
      });
      recordOutcome(summary, code, result);
    } catch (error) {
      recordOutcome(summary, code, null, error);
    }
  }
}

async function backfillProperties(db, userId, options, summary) {
  const snapshot = await db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('properties').get();
  const docs = options.limit ? snapshot.docs.slice(0, options.limit) : snapshot.docs;
  summary.scanned = docs.length;

  for (const doc of docs) {
    const property = doc.data() || {};
    const name = property.name || property.propertyName || property.label || property.address || null;
    const metadata = trimObject(property, [
      'id',
      'name',
      'propertyName',
      'label',
      'address',
      'state',
      'purchaseDate',
      'purchasePrice',
      'landValue',
      'improvementValue',
      'description',
      'usefulLifeMonths',
      'fairRentalDays',
      'personalUseDays',
      'createdAt',
      'updatedAt'
    ]);

    if (!name && !property.address) {
      recordOutcome(summary, doc.id, null, new Error('Property requires a name or address'));
      continue;
    }

    try {
      if (options.dryRun) {
        recordOutcome(summary, doc.id, { ok: true, status: 'ready' });
        continue;
      }

      const result = await upsertBookkeepingPropertyInAzure({
        userId,
        id: doc.id,
        name,
        address: property.address || '',
        state: property.state || null,
        purchaseDate: property.purchaseDate || null,
        purchasePrice: property.purchasePrice || 0,
        landValue: property.landValue || 0,
        improvementValue: property.improvementValue || 0,
        description: property.description || property.propertyType || 'Residential Rental Property',
        usefulLifeMonths: property.usefulLifeMonths || 330,
        fairRentalDays: property.fairRentalDays ?? 365,
        personalUseDays: property.personalUseDays ?? 0,
        metadata
      });
      recordOutcome(summary, doc.id, result);
    } catch (error) {
      recordOutcome(summary, doc.id, null, error);
    }
  }
}

async function backfillVendors(db, userId, options, summary) {
  const snapshot = await db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('vendors').get();
  const docs = options.limit ? snapshot.docs.slice(0, options.limit) : snapshot.docs;
  summary.scanned = docs.length;

  for (const doc of docs) {
    const vendor = doc.data() || {};
    const name = String(vendor.name || '').trim();
    const metadata = trimObject(vendor, [
      'id',
      'name',
      'vendorType',
      'ein',
      'ssn',
      'ssnLast4',
      'address',
      'city',
      'state',
      'zip',
      'email',
      'phone',
      'w9OnFile',
      'w9Date',
      'notes',
      'createdAt',
      'updatedAt'
    ]);

    if (!name) {
      recordOutcome(summary, doc.id, null, new Error('Vendor requires a name'));
      continue;
    }

    try {
      if (options.dryRun) {
        recordOutcome(summary, doc.id, { ok: true, status: 'ready' });
        continue;
      }

      const result = await upsertBookkeepingVendorInAzure({
        userId,
        id: doc.id,
        name,
        vendorType: vendor.vendorType || 'unknown',
        ein: vendor.ein || null,
        ssn: vendor.ssn || null,
        ssnLast4: vendor.ssnLast4 || null,
        address: vendor.address || null,
        city: vendor.city || null,
        state: vendor.state || null,
        zip: vendor.zip || null,
        email: vendor.email || null,
        phone: vendor.phone || null,
        w9OnFile: normalizeBoolean(vendor.w9OnFile, false),
        w9Date: vendor.w9Date || null,
        notes: vendor.notes || '',
        metadata
      });
      recordOutcome(summary, doc.id, result);
    } catch (error) {
      recordOutcome(summary, doc.id, null, error);
    }
  }
}

async function backfillUserMetadata(db, userId, options) {
  const summary = createUserSummary(userId);

  if (!options.dryRun) {
    await ensureBookkeepingInitializedInAzure({ userId });
  }

  if (options.types.includes('accounts')) {
    await backfillAccounts(db, userId, options, summary.collections.accounts);
  }

  if (options.types.includes('properties')) {
    await backfillProperties(db, userId, options, summary.collections.properties);
  }

  if (options.types.includes('vendors')) {
    await backfillVendors(db, userId, options, summary.collections.vendors);
  }

  return summary;
}

function summarizeTotals(userSummaries) {
  const totals = {
    users: userSummaries.length,
    collections: Object.fromEntries(BACKFILL_TYPES.map((type) => [type, {
      scanned: 0,
      evaluated: 0,
      upserted: 0,
      notConfigured: 0,
      failed: 0
    }]))
  };

  for (const userSummary of userSummaries) {
    for (const type of BACKFILL_TYPES) {
      const source = userSummary.collections[type];
      const target = totals.collections[type];
      target.scanned += source.scanned;
      target.evaluated += source.evaluated;
      target.upserted += source.upserted;
      target.notConfigured += source.notConfigured;
      target.failed += source.failed;
    }
  }

  return totals;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  initializeFirebaseAdmin();
  const db = getFirestore();
  const userIds = await resolveUserIds(db, options);

  if (userIds.length === 0) {
    throw new Error('Provide at least one --user <uid> or use --all-users');
  }

  if (!options.types.length) {
    throw new Error(`Provide at least one --types value from: ${BACKFILL_TYPES.join(', ')}`);
  }

  const userSummaries = [];
  for (const userId of userIds) {
    userSummaries.push(await backfillUserMetadata(db, userId, options));
  }

  const totals = summarizeTotals(userSummaries);
  const failed = BACKFILL_TYPES.reduce((sum, type) => sum + totals.collections[type].failed, 0);

  console.log(JSON.stringify({
    ok: failed === 0,
    mode: options.dryRun ? 'dry-run' : 'live',
    types: options.types,
    totals,
    users: userSummaries
  }, null, 2));

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[Accounting Core] Firestore bookkeeping metadata backfill failed:', error);
  process.exitCode = 1;
});