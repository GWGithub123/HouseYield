import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deleteBookkeepingPropertyFromAzure,
  deleteBookkeepingVendorFromAzure,
  ensureBookkeepingInitializedInAzure,
  listBookkeepingPropertiesFromAzure,
  upsertBookkeepingAccountInAzure,
  upsertBookkeepingPropertyInAzure,
  upsertBookkeepingVendorInAzure,
} from '../accounting-core/bookkeepingMetadataStore.js';
import { recordEstimatedTaxPaymentToAzure } from '../accounting-core/estimatedTaxPaymentStore.js';
import { postCanonicalManualJournalEntry } from '../accounting-core/manualJournalBridge.js';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from '../accounting-core/azureSqlClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ACCOUNTING_FIXTURE_DIR = __dirname;
export const DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME = 'prestwick-rental-2025';
const FIXTURE_SOURCE_SYSTEM = 'HOUSEYIELD_FIXTURE';
const FIXTURE_SOURCE_EVENT_TYPE = 'accounting.fixture.manual_journal';
const FIXTURE_PAYMENT_METHOD_PREFIX = 'fixture-';

function buildFixtureSourceRef(fixtureName, entryId) {
  return `fixture:${fixtureName}:${entryId}`;
}

function buildFixtureJournalSeedId(fixtureName, entryId) {
  return `fixture:${fixtureName}:${entryId}`;
}

export function resolveAccountingFixturePaths(fixtureName = DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME) {
  return {
    fixtureJsPath: path.join(ACCOUNTING_FIXTURE_DIR, `${fixtureName}.fixture.js`),
    fixtureJsonPath: path.join(ACCOUNTING_FIXTURE_DIR, `${fixtureName}.fixture.json`),
    expectedPath: path.join(ACCOUNTING_FIXTURE_DIR, `${fixtureName}.expected.json`),
    actualPath: path.join(ACCOUNTING_FIXTURE_DIR, `${fixtureName}.actual.json`),
    cutoverReportPath: path.join(ACCOUNTING_FIXTURE_DIR, `${fixtureName}.cutover-report.json`),
  };
}

export async function loadAccountingFixtureDefinition(fixtureName = DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME) {
  const paths = resolveAccountingFixturePaths(fixtureName);

  if (fs.existsSync(paths.fixtureJsPath)) {
    const loaded = await import(pathToFileURL(paths.fixtureJsPath).href);
    const fixture = loaded.default || loaded.ACCOUNTING_FIXTURE || loaded.fixture || null;
    if (!fixture || typeof fixture !== 'object') {
      throw new Error(`Fixture module did not export a fixture object: ${paths.fixtureJsPath}`);
    }
    return fixture;
  }

  if (fs.existsSync(paths.fixtureJsonPath)) {
    return JSON.parse(fs.readFileSync(paths.fixtureJsonPath, 'utf8'));
  }

  throw new Error(`Fixture not found: ${fixtureName}`);
}

export function loadAccountingFixtureExpected(fixtureName = DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME) {
  const { expectedPath } = resolveAccountingFixturePaths(fixtureName);
  if (!fs.existsSync(expectedPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
}

export function buildRentalAnalyticsSampleFromFixture(fixture) {
  if (!fixture?.sampleProfile || !Array.isArray(fixture.analyticsTransactions)) {
    throw new Error(`Fixture ${fixture?.fixtureName || '<unknown>'} does not expose sampleProfile/analyticsTransactions`);
  }

  return {
    ...fixture.sampleProfile,
    transactions: fixture.analyticsTransactions,
  };
}

async function executeFixtureDelete(transaction, sql, label, query, params = {}) {
  const request = transaction.request();
  request.input('userId', sql.NVarChar(128), params.userId);
  request.input('sourceSystem', sql.NVarChar(80), params.sourceSystem);
  request.input('sourceEventType', sql.NVarChar(120), params.sourceEventType);
  request.input('sourceRefPattern', sql.NVarChar(255), params.sourceRefPattern);
  request.input('sourceObjectPattern', sql.NVarChar(255), params.sourceObjectPattern);
  request.input('fixtureSeedPattern', sql.NVarChar(255), params.fixtureSeedPattern);
  request.input('taxYear', sql.Int, params.taxYear);
  request.input('paymentMethodPattern', sql.NVarChar(80), params.paymentMethodPattern);
  const result = await request.query(query);
  return {
    label,
    affectedRows: (result.rowsAffected || []).reduce((sum, count) => sum + count, 0),
  };
}

function getFixtureVendorIds(fixture) {
  return (fixture?.vendors || [])
    .map((vendor) => vendor.id)
    .filter(Boolean);
}

function getFixturePropertyIds(fixture) {
  return (fixture?.properties || [])
    .map((property) => property.id)
    .filter(Boolean);
}

function buildFixturePropertyOverrideMap(fixture, propertyOverride = null) {
  if (!propertyOverride?.id) {
    return new Map();
  }

  const fixturePropertyIds = getFixturePropertyIds(fixture);
  if (fixturePropertyIds.length === 0) {
    return new Map();
  }

  return new Map([[fixturePropertyIds[0], propertyOverride.id]]);
}

function remapFixturePropertyId(propertyId, propertyOverrideMap) {
  if (!propertyId) {
    return propertyId || null;
  }

  return propertyOverrideMap.get(propertyId) || propertyId;
}

export async function clearAccountingFixtureFromAzure({
  userId,
  fixtureName = DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
  fixture = null,
} = {}) {
  if (!userId) {
    throw new Error('userId is required to clear an accounting fixture');
  }

  const resolvedFixture = fixture || await loadAccountingFixtureDefinition(fixtureName);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      deleted: 0,
      steps: [],
      propertiesDeleted: 0,
      vendorsDeleted: 0,
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const transaction = new sql.Transaction(pool);
  const sourceRefPattern = `${buildFixtureSourceRef(fixtureName, '')}%`;
  const fixtureSeedPattern = `${buildFixtureJournalSeedId(fixtureName, '')}%`;
  const sourceObjectPattern = `journal-entry:${fixtureSeedPattern}`;
  const steps = [];
  await transaction.begin();

  try {
    const scopedParams = {
      userId,
      sourceSystem: FIXTURE_SOURCE_SYSTEM,
      sourceEventType: FIXTURE_SOURCE_EVENT_TYPE,
      sourceRefPattern,
      sourceObjectPattern,
      fixtureSeedPattern,
      idempotencyScope: 'accounting-fixture-loader',
      idempotencyKeyPattern: `bookkeeping:manual-journal:${fixtureSeedPattern}`,
      taxYear: Number(resolvedFixture.taxYear),
      paymentMethodPattern: `${FIXTURE_PAYMENT_METHOD_PREFIX}%`,
    };

    const request = transaction.request();
    request.input('userId', sql.NVarChar(128), scopedParams.userId);
    request.input('sourceSystem', sql.NVarChar(80), scopedParams.sourceSystem);
    request.input('sourceEventType', sql.NVarChar(120), scopedParams.sourceEventType);
    request.input('sourceRefPattern', sql.NVarChar(255), scopedParams.sourceRefPattern);
    request.input('sourceObjectPattern', sql.NVarChar(255), scopedParams.sourceObjectPattern);
    request.input('idempotencyScope', sql.NVarChar(120), scopedParams.idempotencyScope);
    request.input('idempotencyKeyPattern', sql.NVarChar(255), scopedParams.idempotencyKeyPattern);
    request.input('taxYear', sql.Int, scopedParams.taxYear);
    request.input('paymentMethodPattern', sql.NVarChar(80), scopedParams.paymentMethodPattern);
    const purgeResult = await request.query(`
DECLARE @journal_ids TABLE (journal_entry_id UNIQUEIDENTIFIER PRIMARY KEY);
INSERT INTO @journal_ids (journal_entry_id)
SELECT journal_entry_id
FROM accounting.journal_entries
WHERE user_id=@userId
  AND source_system=@sourceSystem
  AND source_ref LIKE @sourceRefPattern;

DECLARE @source_ids TABLE (source_event_id UNIQUEIDENTIFIER PRIMARY KEY);
INSERT INTO @source_ids (source_event_id)
SELECT source_event_id
FROM accounting.source_events
WHERE user_id=@userId
  AND source_system=@sourceSystem
  AND source_event_type=@sourceEventType
  AND source_object_id LIKE @sourceObjectPattern;

DELETE FROM accounting.reconciliation_items WHERE journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids);
DECLARE @reconciliation_items INT = @@ROWCOUNT;
DELETE FROM accounting.subledger_tenant WHERE journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids);
DECLARE @subledger_tenant INT = @@ROWCOUNT;
DELETE FROM accounting.subledger_vendor WHERE journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids);
DECLARE @subledger_vendor INT = @@ROWCOUNT;
DELETE FROM accounting.subledger_security_deposit WHERE journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids);
DECLARE @subledger_security_deposit INT = @@ROWCOUNT;
DELETE FROM accounting.subledger_owner_equity WHERE journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids);
DECLARE @subledger_owner_equity INT = @@ROWCOUNT;
DELETE FROM accounting.journal_lines WHERE journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids);
DECLARE @journal_lines INT = @@ROWCOUNT;
DELETE FROM accounting.idempotency_keys
WHERE posted_journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids)
   OR source_event_id IN (SELECT source_event_id FROM @source_ids)
   OR (idempotency_scope=@idempotencyScope AND idempotency_key LIKE @idempotencyKeyPattern);
DECLARE @idempotency_keys INT = @@ROWCOUNT;
DELETE FROM accounting.journal_entries WHERE journal_entry_id IN (SELECT journal_entry_id FROM @journal_ids);
DECLARE @journal_entries INT = @@ROWCOUNT;
DELETE FROM accounting.finance_events WHERE source_event_id IN (SELECT source_event_id FROM @source_ids);
DECLARE @finance_events INT = @@ROWCOUNT;
DELETE FROM accounting.source_events WHERE source_event_id IN (SELECT source_event_id FROM @source_ids);
DECLARE @source_events INT = @@ROWCOUNT;
DELETE FROM accounting.estimated_tax_payments
WHERE user_id=@userId
  AND tax_year=@taxYear
  AND payment_method LIKE @paymentMethodPattern;
DECLARE @estimated_tax_payments INT = @@ROWCOUNT;

SELECT
  @reconciliation_items AS reconciliation_items,
  @subledger_tenant AS subledger_tenant,
  @subledger_vendor AS subledger_vendor,
  @subledger_security_deposit AS subledger_security_deposit,
  @subledger_owner_equity AS subledger_owner_equity,
  @journal_lines AS journal_lines,
  @idempotency_keys AS idempotency_keys,
  @journal_entries AS journal_entries,
  @finance_events AS finance_events,
  @source_events AS source_events,
  @estimated_tax_payments AS estimated_tax_payments;
    `);
    const purgeCounts = purgeResult.recordset?.[0] || {};
    for (const [label, affectedRows] of Object.entries(purgeCounts)) {
      steps.push({ label, affectedRows: Number(affectedRows || 0) });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }

  let propertiesDeleted = 0;
  const fixturePropertyIds = new Set(getFixturePropertyIds(resolvedFixture));
  const fixturePropertiesResult = await listBookkeepingPropertiesFromAzure({ userId });
  const propertyIdsToDelete = Array.from(new Set(
    (fixturePropertiesResult.properties || [])
      .filter((property) => {
        const seededFixtureName = String(property?.fixtureName || '').trim();
        const sourceFixturePropertyId = String(property?.sourceFixturePropertyId || '').trim();
        return fixturePropertyIds.has(property?.id)
          || fixturePropertyIds.has(sourceFixturePropertyId)
          || seededFixtureName === fixtureName;
      })
      .map((property) => String(property.id || '').trim())
      .filter(Boolean)
  ));
  for (const propertyId of propertyIdsToDelete) {
    try {
      await deleteBookkeepingPropertyFromAzure({ userId, propertyId });
      propertiesDeleted += 1;
    } catch (error) {
      if (error?.statusCode !== 404) {
        throw error;
      }
    }
  }

  let vendorsDeleted = 0;
  for (const vendorId of getFixtureVendorIds(resolvedFixture)) {
    try {
      const result = await deleteBookkeepingVendorFromAzure({ userId, vendorId });
      if (result?.deleted) {
        vendorsDeleted += 1;
      }
    } catch (error) {
      if (error?.statusCode !== 404) {
        throw error;
      }
    }
  }

  return {
    ok: true,
    status: 'cleared',
    deleted: steps.reduce((sum, step) => sum + step.affectedRows, 0) + propertiesDeleted + vendorsDeleted,
    steps,
    propertiesDeleted,
    vendorsDeleted,
  };
}

export async function seedAccountingFixtureToAzure({
  userId,
  fixtureName = DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
  fixture = null,
  clearExisting = true,
  propertyOverride = null,
} = {}) {
  if (!userId) {
    throw new Error('userId is required to seed an accounting fixture');
  }

  const resolvedFixture = fixture || await loadAccountingFixtureDefinition(fixtureName);
  const cleanup = clearExisting
    ? await clearAccountingFixtureFromAzure({ userId, fixtureName, fixture: resolvedFixture })
    : { ok: true, status: 'skipped', deleted: 0, steps: [] };
  const propertyOverrideMap = buildFixturePropertyOverrideMap(resolvedFixture, propertyOverride);

  await ensureBookkeepingInitializedInAzure({ userId });

  for (const [code, account] of Object.entries(resolvedFixture.accounts || {})) {
    await upsertBookkeepingAccountInAzure({
      userId,
      code,
      name: account.name,
      type: account.type,
      subtype: account.subtype || null,
      isActive: true,
    });
  }

  const properties = [];
  for (const property of resolvedFixture.properties || []) {
    const resolvedPropertyId = remapFixturePropertyId(property.id, propertyOverrideMap);
    const result = await upsertBookkeepingPropertyInAzure({
      userId,
      id: resolvedPropertyId,
      name: propertyOverride?.id === resolvedPropertyId
        ? (propertyOverride.name || property.name || property.address)
        : (property.name || property.address),
      address: propertyOverride?.id === resolvedPropertyId
        ? (propertyOverride.address || property.address || '')
        : (property.address || ''),
      state: property.state || null,
      purchaseDate: property.purchaseDate || null,
      purchasePrice: property.purchasePrice || 0,
      landValue: property.landValue || 0,
      improvementValue: property.improvementValue || 0,
      description: property.description || 'Residential Rental Property',
      usefulLifeMonths: property.usefulLifeMonths || 330,
      fairRentalDays: property.fairRentalDays || 365,
      personalUseDays: property.personalUseDays || 0,
      metadata: {
        fixtureName,
        seededBy: 'accounting-fixture-loader',
        sourceFixturePropertyId: property.id,
        ...(property.metadata || {}),
      },
    });
    if (result?.property) {
      properties.push(result.property);
    }
  }

  const vendors = [];
  for (const vendor of resolvedFixture.vendors || []) {
    const result = await upsertBookkeepingVendorInAzure({
      userId,
      id: vendor.id || null,
      name: vendor.name,
      vendorType: vendor.vendorType || 'unknown',
      ein: vendor.ein || null,
      ssnLast4: vendor.ssnLast4 || null,
      address: vendor.address || null,
      city: vendor.city || null,
      state: vendor.state || null,
      zip: vendor.zip || null,
      email: vendor.email || null,
      phone: vendor.phone || null,
      w9OnFile: Boolean(vendor.w9OnFile),
      w9Date: vendor.w9Date || null,
      notes: vendor.notes || '',
      metadata: {
        fixtureName,
        seededBy: 'accounting-fixture-loader',
        ...(vendor.metadata || {}),
      },
    });
    if (result?.vendor) {
      vendors.push(result.vendor);
    }
  }

  const entryResults = [];
  for (const entry of resolvedFixture.entries || []) {
    const fixtureSourceRef = buildFixtureSourceRef(fixtureName, entry.id);
    const resolvedEntryPropertyId = remapFixturePropertyId(entry.propertyId || null, propertyOverrideMap);
    const result = await postCanonicalManualJournalEntry({
      userId,
      journalEntryId: buildFixtureJournalSeedId(fixtureName, entry.id),
      entry: {
        entryDate: entry.date,
        memo: entry.memo || entry.id,
        source: 'FIXTURE',
        sourceRef: fixtureSourceRef,
        propertyId: resolvedEntryPropertyId,
        category: entry.category || null,
        vendor: entry.vendor || null,
        payee: entry.vendor || null,
        metadata: {
          fixtureName,
          fixtureEntryId: entry.id,
          fixtureEntryType: entry.type || null,
        },
        lines: (entry.lines || []).map((line) => ({
          accountCode: line.accountCode,
          accountName: line.accountName,
          amount: line.amount,
          dc: line.dc,
          memo: line.memo || entry.memo || '',
          propertyId: remapFixturePropertyId(line.propertyId || entry.propertyId || null, propertyOverrideMap),
        })),
      },
      postedBy: 'accounting-fixture-loader',
      idempotencyScope: 'accounting-fixture-loader',
      sourceSystem: FIXTURE_SOURCE_SYSTEM,
      sourceEventType: FIXTURE_SOURCE_EVENT_TYPE,
    });

    entryResults.push({
      entryId: entry.id,
      status: result?.status || 'unknown',
      journalEntryId: result?.journalEntryId || null,
      financeEventId: result?.financeEventId || null,
    });
  }

  const estimatedPayments = [];
  for (const payment of resolvedFixture.estimatedTaxPayments || []) {
    const result = await recordEstimatedTaxPaymentToAzure({
      userId,
      taxYear: payment.taxYear || resolvedFixture.taxYear,
      quarter: payment.quarter,
      amount: payment.amount,
      datePaid: payment.datePaid,
      paymentMethod: payment.paymentMethod || `${FIXTURE_PAYMENT_METHOD_PREFIX}eftps`,
    });
    if (result?.payment) {
      estimatedPayments.push(result.payment);
    }
  }

  return {
    ok: true,
    status: 'seeded',
    fixtureName,
    taxYear: resolvedFixture.taxYear,
    cleanup,
    accountsSeeded: Object.keys(resolvedFixture.accounts || {}).length,
    propertiesSeeded: properties.length,
    vendorsSeeded: vendors.length,
    entriesSeeded: entryResults.length,
    entriesCreated: entryResults.filter((result) => result.status === 'posted').length,
    estimatedPaymentsSeeded: estimatedPayments.length,
    property: properties[0] || null,
    properties,
    vendors,
    entryResults,
    estimatedPayments,
  };
}