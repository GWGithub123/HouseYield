import { DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_CHART_OF_ACCOUNTS_VERSION } from '../../src/shared/chartOfAccounts.js';
import { getAccountingPeriodKey } from '../../src/shared/accountingDomain.js';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';
import { normalizeFinanceEvent } from './postingEngine.js';

let chartSyncPromise = null;

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function coerceDate(value) {
  return value ? new Date(value) : new Date();
}

function safeParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const OPEN_RECONCILIATION_MATCH_STATUSES = ['pending_match', 'pending_review', 'exception_requires_review'];
const ALLOWED_RECONCILIATION_MATCH_STATUSES = [
  ...OPEN_RECONCILIATION_MATCH_STATUSES,
  'matched',
  'resolved',
  'ignored'
];
const STRIPE_TRANSFER_MATCH_SOURCE_SYSTEM = 'STRIPE';
const STRIPE_TRANSFER_MATCH_SOURCE_REF_PREFIX = 'balance_transaction:';
const LEDGER_POSTING_MODES = {
  SHADOW: 'shadow',
  LIVE: 'live'
};

function normalizeLedgerPostingMode(postingMode) {
  return postingMode === LEDGER_POSTING_MODES.LIVE
    ? LEDGER_POSTING_MODES.LIVE
    : LEDGER_POSTING_MODES.SHADOW;
}

async function syncChartAccountsWithPool(pool, sql) {
  for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
    const request = pool.request();
    request.input('accountCode', sql.NVarChar(20), account.code);
    request.input('accountName', sql.NVarChar(255), account.name);
    request.input('accountType', sql.NVarChar(40), account.type);
    request.input('accountSubtype', sql.NVarChar(80), account.subtype || null);
    request.input('isActive', sql.Bit, account.isActive ? 1 : 0);
    request.input('chartVersion', sql.NVarChar(32), DEFAULT_CHART_OF_ACCOUNTS_VERSION);
    await request.query(`
      MERGE accounting.accounts AS target
      USING (SELECT @accountCode AS account_code) AS source
      ON target.account_code = source.account_code
      WHEN MATCHED THEN UPDATE SET
        account_name = @accountName,
        account_type = @accountType,
        account_subtype = @accountSubtype,
        is_active = @isActive,
        chart_version = @chartVersion,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (
        account_code,
        account_name,
        account_type,
        account_subtype,
        is_active,
        chart_version
      ) VALUES (
        @accountCode,
        @accountName,
        @accountType,
        @accountSubtype,
        @isActive,
        @chartVersion
      );
    `);
  }
}

export async function ensureAzureChartOfAccounts() {
  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
      syncedAccounts: 0
    };
  }

  if (!chartSyncPromise) {
    chartSyncPromise = (async () => {
      const sql = await getAzureSqlModule();
      const pool = await getAzureSqlPool();
      await syncChartAccountsWithPool(pool, sql);
      return {
        ok: true,
        status: 'synced',
        chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
        syncedAccounts: DEFAULT_CHART_OF_ACCOUNTS.length
      };
    })().catch((error) => {
      chartSyncPromise = null;
      throw error;
    });
  }

  return chartSyncPromise;
}

async function selectIdempotencyRecord(executor, sql, idempotencyScope, idempotencyKey) {
  const request = executor.request();
  request.input('idempotencyScope', sql.NVarChar(120), idempotencyScope);
  request.input('idempotencyKey', sql.NVarChar(255), idempotencyKey);
  const result = await request.query(`
    SELECT TOP 1 source_event_id, posted_journal_entry_id
    FROM accounting.idempotency_keys
    WHERE idempotency_scope = @idempotencyScope
      AND idempotency_key = @idempotencyKey
  `);
  return result.recordset?.[0] || null;
}

async function upsertSourceEvent(transaction, sql, sourceEvent) {
  const selectRequest = transaction.request();
  selectRequest.input('sourceSystem', sql.NVarChar(80), sourceEvent.sourceSystem);
  selectRequest.input('sourceObjectId', sql.NVarChar(255), sourceEvent.sourceObjectId);
  selectRequest.input('sourceEventType', sql.NVarChar(120), sourceEvent.sourceEventType);
  const existing = await selectRequest.query(`
    SELECT TOP 1 source_event_id
    FROM accounting.source_events
    WHERE source_system = @sourceSystem
      AND source_object_id = @sourceObjectId
      AND source_event_type = @sourceEventType
  `);

  if (existing.recordset?.[0]?.source_event_id) {
    return {
      sourceEventId: existing.recordset[0].source_event_id,
      inserted: false
    };
  }

  const insertRequest = transaction.request();
  insertRequest.input('sourceSystem', sql.NVarChar(80), sourceEvent.sourceSystem);
  insertRequest.input('sourceObjectId', sql.NVarChar(255), sourceEvent.sourceObjectId);
  insertRequest.input('sourceEventType', sql.NVarChar(120), sourceEvent.sourceEventType);
  insertRequest.input('userId', sql.NVarChar(128), sourceEvent.userId);
  insertRequest.input('propertyId', sql.NVarChar(128), sourceEvent.propertyId || null);
  insertRequest.input('payloadJson', sql.NVarChar(sql.MAX), stringifyJson(sourceEvent.payload));
  insertRequest.input('occurredAt', sql.DateTime2, coerceDate(sourceEvent.occurredAt));
  const inserted = await insertRequest.query(`
    INSERT INTO accounting.source_events (
      source_system,
      source_object_id,
      source_event_type,
      user_id,
      property_id,
      payload_json,
      occurred_at
    )
    OUTPUT INSERTED.source_event_id
    VALUES (
      @sourceSystem,
      @sourceObjectId,
      @sourceEventType,
      @userId,
      @propertyId,
      @payloadJson,
      @occurredAt
    )
  `);

  return {
    sourceEventId: inserted.recordset[0].source_event_id,
    inserted: true
  };
}

async function insertFinanceEvent(transaction, sql, normalizedEvent, sourceEventId) {
  const request = transaction.request();
  request.input('sourceEventId', sql.UniqueIdentifier, sourceEventId);
  request.input('financeEventType', sql.NVarChar(120), normalizedEvent.financeEventType);
  request.input('userId', sql.NVarChar(128), normalizedEvent.userId);
  request.input('propertyId', sql.NVarChar(128), normalizedEvent.propertyId || null);
  request.input('effectiveDate', sql.Date, normalizedEvent.effectiveDate);
  request.input('amount', sql.Decimal(18, 2), normalizedEvent.amount);
  request.input('currencyCode', sql.Char(3), normalizedEvent.currencyCode || 'USD');
  request.input('counterpartyName', sql.NVarChar(255), normalizedEvent.counterpartyName || null);
  request.input('memo', sql.NVarChar(400), normalizedEvent.memo || null);
  request.input('metadataJson', sql.NVarChar(sql.MAX), stringifyJson(normalizedEvent.metadata));
  const result = await request.query(`
    INSERT INTO accounting.finance_events (
      source_event_id,
      finance_event_type,
      user_id,
      property_id,
      effective_date,
      amount,
      currency_code,
      counterparty_name,
      memo,
      metadata_json
    )
    OUTPUT INSERTED.finance_event_id
    VALUES (
      @sourceEventId,
      @financeEventType,
      @userId,
      @propertyId,
      @effectiveDate,
      @amount,
      @currencyCode,
      @counterpartyName,
      @memo,
      @metadataJson
    )
  `);
  return result.recordset[0].finance_event_id;
}

async function insertJournalEntry(transaction, sql, journalDraft, normalizedEvent, financeEventId, postedBy) {
  const request = transaction.request();
  request.input('financeEventId', sql.UniqueIdentifier, financeEventId);
  request.input('userId', sql.NVarChar(128), normalizedEvent.userId);
  request.input('propertyId', sql.NVarChar(128), normalizedEvent.propertyId || null);
  request.input('entryDate', sql.Date, journalDraft.journalEntry.entryDate);
  request.input('entryType', sql.NVarChar(80), normalizedEvent.financeEventType);
  request.input('sourceSystem', sql.NVarChar(80), normalizedEvent.sourceSystem);
  request.input('sourceRef', sql.NVarChar(255), normalizedEvent.sourceRef || null);
  request.input('memo', sql.NVarChar(400), journalDraft.journalEntry.memo);
  request.input('totalDebits', sql.Decimal(18, 2), journalDraft.journalEntry.totalDebits);
  request.input('totalCredits', sql.Decimal(18, 2), journalDraft.journalEntry.totalCredits);
  request.input('rulesVersion', sql.NVarChar(32), journalDraft.rulesVersion);
  request.input('postedBy', sql.NVarChar(255), postedBy);
  request.input('isBalanced', sql.Bit, journalDraft.journalEntry.isBalanced ? 1 : 0);
  const result = await request.query(`
    INSERT INTO accounting.journal_entries (
      finance_event_id,
      user_id,
      property_id,
      entry_date,
      entry_type,
      source_system,
      source_ref,
      memo,
      total_debits,
      total_credits,
      rules_version,
      posted_by,
      is_balanced
    )
    OUTPUT INSERTED.journal_entry_id
    VALUES (
      @financeEventId,
      @userId,
      @propertyId,
      @entryDate,
      @entryType,
      @sourceSystem,
      @sourceRef,
      @memo,
      @totalDebits,
      @totalCredits,
      @rulesVersion,
      @postedBy,
      @isBalanced
    )
  `);
  return result.recordset[0].journal_entry_id;
}

async function insertJournalLines(transaction, sql, journalEntryId, journalDraft, normalizedEvent) {
  for (let index = 0; index < journalDraft.journalEntry.lines.length; index++) {
    const line = journalDraft.journalEntry.lines[index];
    const request = transaction.request();
    request.input('journalEntryId', sql.UniqueIdentifier, journalEntryId);
    request.input('lineNumber', sql.Int, index + 1);
    request.input('accountCode', sql.NVarChar(20), line.accountCode);
    request.input('dc', sql.Char(1), line.dc);
    request.input('amount', sql.Decimal(18, 2), line.amount);
    request.input('propertyId', sql.NVarChar(128), line.propertyId || normalizedEvent.propertyId || null);
    request.input('vendorName', sql.NVarChar(255), normalizedEvent.financeEventType === 'expense_paid' ? normalizedEvent.counterpartyName || null : null);
    request.input('tenantName', sql.NVarChar(255), ['income_received', 'rent_paid', 'liability_received'].includes(normalizedEvent.financeEventType)
      ? normalizedEvent.counterpartyName || null
      : null);
    request.input('taxCategory', sql.NVarChar(120), normalizedEvent.metadata?.taxCategory || null);
    request.input('scheduleELine', sql.Int, Number.isInteger(normalizedEvent.metadata?.scheduleELine)
      ? normalizedEvent.metadata.scheduleELine
      : null);
    request.input('memo', sql.NVarChar(400), line.memo || normalizedEvent.memo || null);
    await request.query(`
      INSERT INTO accounting.journal_lines (
        journal_entry_id,
        line_number,
        account_code,
        dc,
        amount,
        property_id,
        vendor_name,
        tenant_name,
        tax_category,
        schedule_e_line,
        memo
      )
      VALUES (
        @journalEntryId,
        @lineNumber,
        @accountCode,
        @dc,
        @amount,
        @propertyId,
        @vendorName,
        @tenantName,
        @taxCategory,
        @scheduleELine,
        @memo
      )
    `);
  }
}

async function insertSubledgerRows(transaction, sql, journalEntryId, normalizedEvent) {
  if (normalizedEvent.financeEventType === 'expense_paid' && normalizedEvent.counterpartyName) {
    const vendorRequest = transaction.request();
    vendorRequest.input('journalEntryId', sql.UniqueIdentifier, journalEntryId);
    vendorRequest.input('vendorName', sql.NVarChar(255), normalizedEvent.counterpartyName);
    vendorRequest.input('propertyId', sql.NVarChar(128), normalizedEvent.propertyId || null);
    vendorRequest.input('amount', sql.Decimal(18, 2), normalizedEvent.amount);
    vendorRequest.input('reportableAmount', sql.Decimal(18, 2), normalizedEvent.metadata?.reportable1099Amount || 0);
    vendorRequest.input('effectiveDate', sql.Date, normalizedEvent.effectiveDate);
    await vendorRequest.query(`
      INSERT INTO accounting.subledger_vendor (
        journal_entry_id,
        vendor_name,
        property_id,
        amount,
        reportable_1099_amount,
        effective_date
      )
      VALUES (
        @journalEntryId,
        @vendorName,
        @propertyId,
        @amount,
        @reportableAmount,
        @effectiveDate
      )
    `);
    return;
  }

  if (normalizedEvent.financeEventType === 'liability_received' && normalizedEvent.counterpartyName) {
    const depositRequest = transaction.request();
    depositRequest.input('journalEntryId', sql.UniqueIdentifier, journalEntryId);
    depositRequest.input('tenantName', sql.NVarChar(255), normalizedEvent.counterpartyName);
    depositRequest.input('propertyId', sql.NVarChar(128), normalizedEvent.propertyId || null);
    depositRequest.input('activityType', sql.NVarChar(120), normalizedEvent.financeEventType);
    depositRequest.input('amount', sql.Decimal(18, 2), normalizedEvent.amount);
    depositRequest.input('effectiveDate', sql.Date, normalizedEvent.effectiveDate);
    await depositRequest.query(`
      INSERT INTO accounting.subledger_security_deposit (
        journal_entry_id,
        tenant_name,
        property_id,
        activity_type,
        amount,
        effective_date
      )
      VALUES (
        @journalEntryId,
        @tenantName,
        @propertyId,
        @activityType,
        @amount,
        @effectiveDate
      )
    `);
    return;
  }

  if (['owner_contribution', 'owner_draw'].includes(normalizedEvent.financeEventType)) {
    const ownerRequest = transaction.request();
    ownerRequest.input('journalEntryId', sql.UniqueIdentifier, journalEntryId);
    ownerRequest.input('ownerName', sql.NVarChar(255), normalizedEvent.counterpartyName || null);
    ownerRequest.input('activityType', sql.NVarChar(120), normalizedEvent.financeEventType);
    ownerRequest.input('amount', sql.Decimal(18, 2), normalizedEvent.amount);
    ownerRequest.input('effectiveDate', sql.Date, normalizedEvent.effectiveDate);
    await ownerRequest.query(`
      INSERT INTO accounting.subledger_owner_equity (
        journal_entry_id,
        owner_name,
        activity_type,
        amount,
        effective_date
      )
      VALUES (
        @journalEntryId,
        @ownerName,
        @activityType,
        @amount,
        @effectiveDate
      )
    `);
  }
}

async function insertAuditLog(transaction, sql, journalEntryId, financeEventId, sourceEvent, normalizedEvent, postedBy, postingMode = LEDGER_POSTING_MODES.SHADOW) {
  const effectivePostingMode = normalizeLedgerPostingMode(postingMode);
  const isShadowMode = effectivePostingMode === LEDGER_POSTING_MODES.SHADOW;
  const request = transaction.request();
  request.input('entityType', sql.NVarChar(120), 'journal_entry');
  request.input('entityId', sql.NVarChar(255), journalEntryId);
  request.input('actionType', sql.NVarChar(120), isShadowMode ? 'shadow_posted' : 'canonical_posted');
  request.input('performedBy', sql.NVarChar(255), postedBy);
  request.input('summary', sql.NVarChar(400), `${isShadowMode ? 'Shadow-posted' : 'Posted'} ${normalizedEvent.financeEventType} from ${sourceEvent.sourceEventType}`);
  request.input('afterJson', sql.NVarChar(sql.MAX), stringifyJson({
    journalEntryId,
    financeEventId,
    sourceRef: normalizedEvent.sourceRef,
    financeEventType: normalizedEvent.financeEventType,
    amount: normalizedEvent.amount,
    propertyId: normalizedEvent.propertyId,
    shadowMode: isShadowMode,
    postingMode: effectivePostingMode
  }));
  await request.query(`
    INSERT INTO accounting.audit_log (
      entity_type,
      entity_id,
      action_type,
      performed_by,
      summary,
      after_json
    )
    VALUES (
      @entityType,
      @entityId,
      @actionType,
      @performedBy,
      @summary,
      @afterJson
    )
  `);
}

async function insertIdempotencyKey(transaction, sql, idempotencyScope, idempotencyKey, sourceEventId, journalEntryId) {
  const request = transaction.request();
  request.input('idempotencyScope', sql.NVarChar(120), idempotencyScope);
  request.input('idempotencyKey', sql.NVarChar(255), idempotencyKey);
  request.input('sourceEventId', sql.UniqueIdentifier, sourceEventId);
  request.input('journalEntryId', sql.UniqueIdentifier, journalEntryId);
  await request.query(`
    INSERT INTO accounting.idempotency_keys (
      idempotency_scope,
      idempotency_key,
      source_event_id,
      posted_journal_entry_id
    )
    VALUES (
      @idempotencyScope,
      @idempotencyKey,
      @sourceEventId,
      @journalEntryId
    )
  `);
}

async function ensureReconciliationSession(transaction, sql, {
  userId,
  propertyId,
  reconciliationScope,
  periodKey,
  createdBy
}) {
  const selectRequest = transaction.request();
  selectRequest.input('userId', sql.NVarChar(128), userId);
  selectRequest.input('propertyId', sql.NVarChar(128), propertyId || null);
  selectRequest.input('reconciliationScope', sql.NVarChar(120), reconciliationScope);
  selectRequest.input('periodKey', sql.NVarChar(7), periodKey);
  const existing = await selectRequest.query(`
    SELECT TOP 1 reconciliation_session_id
    FROM accounting.reconciliation_sessions
    WHERE user_id = @userId
      AND reconciliation_scope = @reconciliationScope
      AND period_key = @periodKey
      AND ((property_id IS NULL AND @propertyId IS NULL) OR property_id = @propertyId)
      AND status = 'open'
    ORDER BY started_at DESC
  `);

  if (existing.recordset?.[0]?.reconciliation_session_id) {
    return existing.recordset[0].reconciliation_session_id;
  }

  const insertRequest = transaction.request();
  insertRequest.input('userId', sql.NVarChar(128), userId);
  insertRequest.input('propertyId', sql.NVarChar(128), propertyId || null);
  insertRequest.input('reconciliationScope', sql.NVarChar(120), reconciliationScope);
  insertRequest.input('periodKey', sql.NVarChar(7), periodKey);
  insertRequest.input('createdBy', sql.NVarChar(255), createdBy);
  const inserted = await insertRequest.query(`
    INSERT INTO accounting.reconciliation_sessions (
      user_id,
      property_id,
      reconciliation_scope,
      period_key,
      status,
      created_by
    )
    OUTPUT INSERTED.reconciliation_session_id
    VALUES (
      @userId,
      @propertyId,
      @reconciliationScope,
      @periodKey,
      'open',
      @createdBy
    )
  `);

  return inserted.recordset[0].reconciliation_session_id;
}

async function insertReconciliationItem(transaction, sql, {
  reconciliationSessionId,
  sourceSystem,
  sourceRef,
  matchStatus,
  differenceAmount,
  notes
}) {
  const request = transaction.request();
  request.input('reconciliationSessionId', sql.UniqueIdentifier, reconciliationSessionId);
  request.input('sourceSystem', sql.NVarChar(80), sourceSystem);
  request.input('sourceRef', sql.NVarChar(255), sourceRef);
  request.input('matchStatus', sql.NVarChar(40), matchStatus);
  request.input('differenceAmount', sql.Decimal(18, 2), Number.isFinite(Number(differenceAmount)) ? Number(differenceAmount) : null);
  request.input('notes', sql.NVarChar(400), notes || null);
  const result = await request.query(`
    INSERT INTO accounting.reconciliation_items (
      reconciliation_session_id,
      source_system,
      source_ref,
      match_status,
      difference_amount,
      notes
    )
    OUTPUT INSERTED.reconciliation_item_id
    VALUES (
      @reconciliationSessionId,
      @sourceSystem,
      @sourceRef,
      @matchStatus,
      @differenceAmount,
      @notes
    )
  `);

  return result.recordset[0].reconciliation_item_id;
}

async function insertPendingMatchAuditLog(transaction, sql, {
  reconciliationItemId,
  sourceEventId,
  pendingMatchInput,
  suggestedMatch,
  reason,
  postedBy
}) {
  const request = transaction.request();
  request.input('entityType', sql.NVarChar(120), 'reconciliation_item');
  request.input('entityId', sql.NVarChar(255), reconciliationItemId);
  request.input('actionType', sql.NVarChar(120), 'pending_match_staged');
  request.input('performedBy', sql.NVarChar(255), postedBy);
  request.input('summary', sql.NVarChar(400), reason || 'Pending transfer match staged for review.');
  request.input('afterJson', sql.NVarChar(sql.MAX), stringifyJson({
    reconciliationItemId,
    sourceEventId,
    sourceRef: pendingMatchInput.sourceRef,
    effectiveDate: pendingMatchInput.effectiveDate,
    amount: pendingMatchInput.amount,
    reconciliationScope: pendingMatchInput.reconciliationScope,
    suggestedMatch: suggestedMatch || null,
    metadata: pendingMatchInput.metadata || {}
  }));
  await request.query(`
    INSERT INTO accounting.audit_log (
      entity_type,
      entity_id,
      action_type,
      performed_by,
      summary,
      after_json
    )
    VALUES (
      @entityType,
      @entityId,
      @actionType,
      @performedBy,
      @summary,
      @afterJson
    )
  `);
}

async function listTransferMatchCandidates(executor, sql, {
  userId,
  propertyId = null,
  amount = null,
  effectiveDate = null,
  expectedFromAccountCode = null,
  expectedToAccountCode = null,
  limit = 5
} = {}) {
  if (!Number.isFinite(Number(amount))) {
    return [];
  }

  const request = executor.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);
  request.input('amount', sql.Decimal(18, 2), Number(amount));
  request.input('effectiveDate', sql.Date, effectiveDate || null);
  request.input('expectedFromAccountCode', sql.NVarChar(20), expectedFromAccountCode || null);
  request.input('expectedToAccountCode', sql.NVarChar(20), expectedToAccountCode || null);
  request.input('limit', sql.Int, Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10));
  const result = await request.query(`
    SELECT TOP (@limit)
      je.journal_entry_id,
      je.entry_date,
      je.source_ref,
      je.memo,
      fe.finance_event_type,
      fe.amount,
      fe.counterparty_name,
      CASE WHEN EXISTS (
        SELECT 1
        FROM accounting.journal_lines jl_from
        WHERE jl_from.journal_entry_id = je.journal_entry_id
          AND (@expectedFromAccountCode IS NULL OR jl_from.account_code = @expectedFromAccountCode)
      ) THEN 1 ELSE 0 END AS has_expected_from_account,
      CASE WHEN EXISTS (
        SELECT 1
        FROM accounting.journal_lines jl_to
        WHERE jl_to.journal_entry_id = je.journal_entry_id
          AND (@expectedToAccountCode IS NULL OR jl_to.account_code = @expectedToAccountCode)
      ) THEN 1 ELSE 0 END AS has_expected_to_account,
      ABS(DATEDIFF(DAY, COALESCE(@effectiveDate, je.entry_date), je.entry_date)) AS date_distance_days
    FROM accounting.journal_entries je
    INNER JOIN accounting.finance_events fe
      ON fe.finance_event_id = je.finance_event_id
    WHERE je.user_id = @userId
      AND ((je.property_id IS NULL AND @propertyId IS NULL) OR je.property_id = @propertyId)
      AND je.source_system = '${STRIPE_TRANSFER_MATCH_SOURCE_SYSTEM}'
      AND je.source_ref LIKE '${STRIPE_TRANSFER_MATCH_SOURCE_REF_PREFIX}%'
      AND fe.finance_event_type = 'asset_transfer'
      AND ABS(fe.amount - @amount) <= 0.01
      AND (
        @effectiveDate IS NULL
        OR ABS(DATEDIFF(DAY, @effectiveDate, je.entry_date)) <= 10
      )
    ORDER BY
      CASE WHEN @expectedFromAccountCode IS NULL THEN 0 ELSE CASE WHEN EXISTS (
        SELECT 1
        FROM accounting.journal_lines jl_from_rank
        WHERE jl_from_rank.journal_entry_id = je.journal_entry_id
          AND jl_from_rank.account_code = @expectedFromAccountCode
      ) THEN 0 ELSE 1 END END,
      CASE WHEN @expectedToAccountCode IS NULL THEN 0 ELSE CASE WHEN EXISTS (
        SELECT 1
        FROM accounting.journal_lines jl_to_rank
        WHERE jl_to_rank.journal_entry_id = je.journal_entry_id
          AND jl_to_rank.account_code = @expectedToAccountCode
      ) THEN 0 ELSE 1 END END,
      ABS(DATEDIFF(DAY, COALESCE(@effectiveDate, je.entry_date), je.entry_date)),
      je.created_at DESC
  `);

  return (result.recordset || []).map((record) => ({
    journalEntryId: record.journal_entry_id,
    entryDate: record.entry_date,
    sourceRef: record.source_ref,
    memo: record.memo,
    financeEventType: record.finance_event_type,
    amount: Number(record.amount),
    counterpartyName: record.counterparty_name || null,
    hasExpectedFromAccount: Boolean(record.has_expected_from_account),
    hasExpectedToAccount: Boolean(record.has_expected_to_account),
    dateDistanceDays: Number(record.date_distance_days || 0)
  }));
}

async function maybeBuildReconciliationMatchCandidates(executor, sql, item) {
  if (item.reconciliationScope !== 'stripe_transfer_match') {
    return [];
  }

  return listTransferMatchCandidates(executor, sql, {
    userId: item.userId,
    propertyId: item.propertyId,
    amount: item.amount,
    effectiveDate: item.effectiveDate || item.createdAt,
    expectedFromAccountCode: item.suggestedMatch?.expectedFromAccountCode || null,
    expectedToAccountCode: item.suggestedMatch?.expectedToAccountCode || null,
    limit: 5
  });
}

function mapReconciliationQueueRecord(record, userId) {
  const auditPayload = safeParseJson(record.audit_after_json) || {};
  return {
    userId,
    propertyId: record.property_id || null,
    reconciliationItemId: record.reconciliation_item_id,
    reconciliationSessionId: record.reconciliation_session_id,
    reconciliationScope: record.reconciliation_scope,
    periodKey: record.period_key,
    sessionStatus: record.session_status,
    sourceSystem: record.source_system,
    sourceRef: record.source_ref,
    journalEntryId: record.journal_entry_id || null,
    matchStatus: record.match_status,
    differenceAmount: record.difference_amount === null ? null : Number(record.difference_amount),
    notes: record.notes || null,
    createdAt: record.created_at,
    effectiveDate: auditPayload.effectiveDate || null,
    sourceEventId: auditPayload.sourceEventId || null,
    amount: Number.isFinite(Number(auditPayload.amount)) ? Number(auditPayload.amount) : null,
    suggestedMatch: auditPayload.suggestedMatch || null,
    matchResolution: auditPayload.matchResolution || null,
    metadata: auditPayload.metadata || {}
  };
}

async function postJournalDraftToAzureInternal({
  sourceEvent,
  financeEventInput,
  journalDraft,
  postedBy,
  idempotencyScope,
  postingMode = LEDGER_POSTING_MODES.LIVE
}) {
  if (!sourceEvent?.sourceSystem || !sourceEvent?.sourceObjectId || !sourceEvent?.sourceEventType || !sourceEvent?.userId) {
    throw new Error('sourceEvent with sourceSystem, sourceObjectId, sourceEventType, and userId is required');
  }

  const effectivePostingMode = normalizeLedgerPostingMode(postingMode);
  const normalizedEvent = normalizeFinanceEvent(financeEventInput);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      financeEventType: normalizedEvent.financeEventType,
      chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
      postingMode: effectivePostingMode
    };
  }

  await ensureAzureChartOfAccounts();

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const existing = await selectIdempotencyRecord(transaction, sql, idempotencyScope, normalizedEvent.idempotencyKey);
    if (existing) {
      await transaction.commit();
      return {
        ok: true,
        status: 'duplicate',
        financeEventType: normalizedEvent.financeEventType,
        journalEntryId: existing.posted_journal_entry_id || null,
        sourceEventId: existing.source_event_id || null,
        chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
        postingMode: effectivePostingMode
      };
    }

    const { sourceEventId, inserted } = await upsertSourceEvent(transaction, sql, sourceEvent);
    const financeEventId = await insertFinanceEvent(transaction, sql, normalizedEvent, sourceEventId);
    const journalEntryId = await insertJournalEntry(transaction, sql, journalDraft, normalizedEvent, financeEventId, postedBy);
    await insertJournalLines(transaction, sql, journalEntryId, journalDraft, normalizedEvent);
    await insertSubledgerRows(transaction, sql, journalEntryId, normalizedEvent);
    await insertAuditLog(transaction, sql, journalEntryId, financeEventId, sourceEvent, normalizedEvent, postedBy, effectivePostingMode);
    await insertIdempotencyKey(transaction, sql, idempotencyScope, normalizedEvent.idempotencyKey, sourceEventId, journalEntryId);

    await transaction.commit();

    return {
      ok: true,
      status: 'posted',
      financeEventType: normalizedEvent.financeEventType,
      journalEntryId,
      financeEventId,
      sourceEventId,
      sourceEventInserted: inserted,
      chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
      postingMode: effectivePostingMode
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});

    if (/duplicate key/i.test(error.message || '')) {
      const existing = await selectIdempotencyRecord(pool, sql, idempotencyScope, normalizedEvent.idempotencyKey);
      return {
        ok: true,
        status: 'duplicate',
        financeEventType: normalizedEvent.financeEventType,
        journalEntryId: existing?.posted_journal_entry_id || null,
        sourceEventId: existing?.source_event_id || null,
        chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
        postingMode: effectivePostingMode
      };
    }

    throw error;
  }
}

export async function postJournalDraftToAzure({
  sourceEvent,
  financeEventInput,
  journalDraft,
  postedBy = 'accounting-canonical',
  idempotencyScope = 'accounting-canonical'
}) {
  return postJournalDraftToAzureInternal({
    sourceEvent,
    financeEventInput,
    journalDraft,
    postedBy,
    idempotencyScope,
    postingMode: LEDGER_POSTING_MODES.LIVE
  });
}

export async function postJournalDraftShadowToAzure({
  sourceEvent,
  financeEventInput,
  journalDraft,
  postedBy = 'stripe-shadow',
  idempotencyScope = 'stripe-shadow'
}) {
  return postJournalDraftToAzureInternal({
    sourceEvent,
    financeEventInput,
    journalDraft,
    postedBy,
    idempotencyScope,
    postingMode: LEDGER_POSTING_MODES.SHADOW
  });
}

export async function stagePendingMatchToAzure({
  sourceEvent,
  pendingMatchInput,
  suggestedMatch = null,
  reason = null,
  postedBy = 'stripe-shadow',
  idempotencyScope = 'stripe-shadow-pending-match',
  matchStatus = 'pending_match'
}) {
  if (!sourceEvent?.sourceSystem || !sourceEvent?.sourceObjectId || !sourceEvent?.sourceEventType || !sourceEvent?.userId) {
    throw new Error('sourceEvent with sourceSystem, sourceObjectId, sourceEventType, and userId is required');
  }

  if (!pendingMatchInput?.idempotencyKey || !pendingMatchInput?.effectiveDate || !pendingMatchInput?.sourceRef) {
    throw new Error('pendingMatchInput with idempotencyKey, effectiveDate, and sourceRef is required');
  }

  const periodKey = getAccountingPeriodKey(pendingMatchInput.effectiveDate);
  if (!periodKey) {
    throw new Error('pendingMatchInput.effectiveDate must resolve to a valid accounting period');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      reconciliationScope: pendingMatchInput.reconciliationScope || 'pending_match',
        matchStatus,
      periodKey
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const existing = await selectIdempotencyRecord(transaction, sql, idempotencyScope, pendingMatchInput.idempotencyKey);
    if (existing) {
      await transaction.commit();
      return {
        ok: true,
        status: 'duplicate',
        sourceEventId: existing.source_event_id || null,
        reconciliationScope: pendingMatchInput.reconciliationScope || 'pending_match',
        matchStatus,
        periodKey
      };
    }

    const { sourceEventId, inserted } = await upsertSourceEvent(transaction, sql, sourceEvent);
    const reconciliationSessionId = await ensureReconciliationSession(transaction, sql, {
      userId: sourceEvent.userId,
      propertyId: sourceEvent.propertyId || null,
      reconciliationScope: pendingMatchInput.reconciliationScope || 'pending_match',
      periodKey,
      createdBy: postedBy
    });
    const reconciliationItemId = await insertReconciliationItem(transaction, sql, {
      reconciliationSessionId,
      sourceSystem: pendingMatchInput.sourceSystem || sourceEvent.sourceSystem,
      sourceRef: pendingMatchInput.sourceRef,
      matchStatus,
      differenceAmount: null,
      notes: pendingMatchInput.notes || reason
    });
    await insertPendingMatchAuditLog(transaction, sql, {
      reconciliationItemId,
      sourceEventId,
      pendingMatchInput,
      suggestedMatch,
      reason,
      postedBy
    });
    await insertIdempotencyKey(transaction, sql, idempotencyScope, pendingMatchInput.idempotencyKey, sourceEventId, null);

    await transaction.commit();

    return {
      ok: true,
      status: 'staged',
      sourceEventId,
      sourceEventInserted: inserted,
      reconciliationSessionId,
      reconciliationItemId,
      reconciliationScope: pendingMatchInput.reconciliationScope || 'pending_match',
      matchStatus,
      periodKey
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});

    if (/duplicate key/i.test(error.message || '')) {
      const existing = await selectIdempotencyRecord(pool, sql, idempotencyScope, pendingMatchInput.idempotencyKey);
      return {
        ok: true,
        status: 'duplicate',
        sourceEventId: existing?.source_event_id || null,
        reconciliationScope: pendingMatchInput.reconciliationScope || 'pending_match',
        matchStatus,
        periodKey
      };
    }

    throw error;
  }
}

export async function listReconciliationExceptionQueue({
  userId,
  propertyId = null,
  reconciliationScope = null,
  periodKey = null,
  limit = 50,
  includeClosed = false
} = {}) {
  if (!userId) {
    throw new Error('userId is required to list reconciliation exceptions');
  }

  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      items: [],
      summary: {
        totalItems: 0,
        matchStatusCounts: {},
        reconciliationScopeCounts: {}
      }
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('limit', sql.Int, normalizedLimit);
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);
  request.input('reconciliationScope', sql.NVarChar(120), reconciliationScope || null);
  request.input('periodKey', sql.NVarChar(7), periodKey || null);

  const result = await request.query(`
    SELECT TOP (@limit)
      ri.reconciliation_item_id,
      ri.reconciliation_session_id,
      rs.property_id,
      rs.reconciliation_scope,
      rs.period_key,
      rs.status AS session_status,
      ri.source_system,
      ri.source_ref,
      ri.journal_entry_id,
      ri.match_status,
      ri.difference_amount,
      ri.notes,
      ri.created_at,
      audit_entry.after_json AS audit_after_json
    FROM accounting.reconciliation_items ri
    INNER JOIN accounting.reconciliation_sessions rs
      ON rs.reconciliation_session_id = ri.reconciliation_session_id
    OUTER APPLY (
      SELECT TOP 1 al.after_json
      FROM accounting.audit_log al
      WHERE al.entity_type = 'reconciliation_item'
        AND al.entity_id = CAST(ri.reconciliation_item_id AS NVARCHAR(255))
      ORDER BY al.performed_at DESC
    ) audit_entry
    WHERE rs.user_id = @userId
      AND ((rs.property_id IS NULL AND @propertyId IS NULL) OR rs.property_id = @propertyId)
      AND (@reconciliationScope IS NULL OR rs.reconciliation_scope = @reconciliationScope)
      AND (@periodKey IS NULL OR rs.period_key = @periodKey)
      ${includeClosed ? '' : "AND rs.status = 'open'"}
    ORDER BY ri.created_at DESC
  `);

  const baseItems = (result.recordset || []).map((record) => mapReconciliationQueueRecord(record, userId));

  const items = await Promise.all(baseItems.map(async (item) => ({
    ...item,
    matchCandidates: await maybeBuildReconciliationMatchCandidates(pool, sql, item)
  })));

  const summary = items.reduce((accumulator, item) => {
    accumulator.totalItems += 1;
    accumulator.matchStatusCounts[item.matchStatus] = (accumulator.matchStatusCounts[item.matchStatus] || 0) + 1;
    accumulator.reconciliationScopeCounts[item.reconciliationScope] = (accumulator.reconciliationScopeCounts[item.reconciliationScope] || 0) + 1;
    return accumulator;
  }, {
    totalItems: 0,
    matchStatusCounts: {},
    reconciliationScopeCounts: {}
  });

  return {
    ok: true,
    status: 'loaded',
    items,
    summary
  };
}

export async function getReconciliationExceptionDetail({
  userId,
  reconciliationItemId
} = {}) {
  if (!userId) {
    throw new Error('userId is required to fetch reconciliation exception details');
  }

  if (!reconciliationItemId) {
    throw new Error('reconciliationItemId is required');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      item: null
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('reconciliationItemId', sql.UniqueIdentifier, reconciliationItemId);
  const result = await request.query(`
    SELECT TOP 1
      ri.reconciliation_item_id,
      ri.reconciliation_session_id,
      rs.property_id,
      rs.reconciliation_scope,
      rs.period_key,
      rs.status AS session_status,
      ri.source_system,
      ri.source_ref,
      ri.journal_entry_id,
      ri.match_status,
      ri.difference_amount,
      ri.notes,
      ri.created_at,
      audit_entry.after_json AS audit_after_json
    FROM accounting.reconciliation_items ri
    INNER JOIN accounting.reconciliation_sessions rs
      ON rs.reconciliation_session_id = ri.reconciliation_session_id
    OUTER APPLY (
      SELECT TOP 1 al.after_json
      FROM accounting.audit_log al
      WHERE al.entity_type = 'reconciliation_item'
        AND al.entity_id = CAST(ri.reconciliation_item_id AS NVARCHAR(255))
      ORDER BY al.performed_at DESC
    ) audit_entry
    WHERE ri.reconciliation_item_id = @reconciliationItemId
      AND rs.user_id = @userId
  `);

  const record = result.recordset?.[0] || null;
  if (!record) {
    const error = new Error('Reconciliation exception not found');
    error.statusCode = 404;
    throw error;
  }

  const item = mapReconciliationQueueRecord(record, userId);
  return {
    ok: true,
    status: 'loaded',
    item: {
      ...item,
      matchCandidates: await maybeBuildReconciliationMatchCandidates(pool, sql, item)
    }
  };
}

export async function reviewReconciliationException({
  userId,
  reconciliationItemId,
  matchStatus,
  notes,
  journalEntryId,
  matchResolution,
  reviewedBy = 'system'
} = {}) {
  if (!userId) {
    throw new Error('userId is required to review reconciliation exceptions');
  }

  if (!reconciliationItemId) {
    throw new Error('reconciliationItemId is required');
  }

  if (!ALLOWED_RECONCILIATION_MATCH_STATUSES.includes(matchStatus)) {
    throw new Error(`matchStatus must be one of: ${ALLOWED_RECONCILIATION_MATCH_STATUSES.join(', ')}`);
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      reconciliationItemId,
      matchStatus
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const selectRequest = transaction.request();
    selectRequest.input('userId', sql.NVarChar(128), userId);
    selectRequest.input('reconciliationItemId', sql.UniqueIdentifier, reconciliationItemId);
    const existing = await selectRequest.query(`
      SELECT TOP 1
        ri.reconciliation_item_id,
        ri.reconciliation_session_id,
        ri.source_system,
        ri.source_ref,
        ri.journal_entry_id,
        ri.match_status,
        ri.difference_amount,
        ri.notes,
        ri.created_at,
        rs.reconciliation_scope,
        rs.period_key,
        rs.status AS session_status
      FROM accounting.reconciliation_items ri
      INNER JOIN accounting.reconciliation_sessions rs
        ON rs.reconciliation_session_id = ri.reconciliation_session_id
      WHERE ri.reconciliation_item_id = @reconciliationItemId
        AND rs.user_id = @userId
    `);

    const current = existing.recordset?.[0] || null;
    if (!current) {
      const error = new Error('Reconciliation exception not found');
      error.statusCode = 404;
      throw error;
    }

    const normalizedMatchResolution = matchResolution && typeof matchResolution === 'object'
      ? {
          journalEntryId: matchResolution.journalEntryId || journalEntryId || null,
          matchedSourceRef: matchResolution.matchedSourceRef || null,
          matchedSourceSystem: matchResolution.matchedSourceSystem || null,
          matchReason: matchResolution.matchReason || null,
          adjustmentEntry: matchResolution.adjustmentEntry || null,
          matchedBy: reviewedBy,
          matchedAt: new Date().toISOString()
        }
      : null;

    const resolvedJournalEntryId = journalEntryId !== undefined
      ? journalEntryId
      : normalizedMatchResolution?.journalEntryId || undefined;

    const updateRequest = transaction.request();
    updateRequest.input('reconciliationItemId', sql.UniqueIdentifier, reconciliationItemId);
    updateRequest.input('matchStatus', sql.NVarChar(40), matchStatus);
    updateRequest.input('notesProvided', sql.Bit, notes !== undefined ? 1 : 0);
    updateRequest.input('notes', sql.NVarChar(400), notes === undefined ? null : (notes || null));
    updateRequest.input('journalEntryProvided', sql.Bit, resolvedJournalEntryId !== undefined ? 1 : 0);
    updateRequest.input('journalEntryId', sql.UniqueIdentifier, resolvedJournalEntryId === undefined ? null : (resolvedJournalEntryId || null));
    const updatedResult = await updateRequest.query(`
      UPDATE accounting.reconciliation_items
      SET match_status = @matchStatus,
          notes = CASE WHEN @notesProvided = 1 THEN @notes ELSE notes END,
          journal_entry_id = CASE WHEN @journalEntryProvided = 1 THEN @journalEntryId ELSE journal_entry_id END
      OUTPUT
        INSERTED.reconciliation_item_id,
        INSERTED.reconciliation_session_id,
        INSERTED.source_system,
        INSERTED.source_ref,
        INSERTED.journal_entry_id,
        INSERTED.match_status,
        INSERTED.difference_amount,
        INSERTED.notes,
        INSERTED.created_at
      WHERE reconciliation_item_id = @reconciliationItemId
    `);

    const updated = updatedResult.recordset?.[0] || null;

    const auditRequest = transaction.request();
    auditRequest.input('entityType', sql.NVarChar(120), 'reconciliation_item');
    auditRequest.input('entityId', sql.NVarChar(255), reconciliationItemId);
    auditRequest.input('actionType', sql.NVarChar(120), 'reconciliation_item_reviewed');
    auditRequest.input('performedBy', sql.NVarChar(255), reviewedBy);
    auditRequest.input('summary', sql.NVarChar(400), `Updated reconciliation item to ${matchStatus}`);
    auditRequest.input('beforeJson', sql.NVarChar(sql.MAX), stringifyJson({
      reconciliationItemId: current.reconciliation_item_id,
      reconciliationSessionId: current.reconciliation_session_id,
      sourceSystem: current.source_system,
      sourceRef: current.source_ref,
      journalEntryId: current.journal_entry_id,
      matchStatus: current.match_status,
      differenceAmount: current.difference_amount === null ? null : Number(current.difference_amount),
      notes: current.notes,
      createdAt: current.created_at,
      reconciliationScope: current.reconciliation_scope,
      periodKey: current.period_key,
      sessionStatus: current.session_status,
      matchResolution: null
    }));
    auditRequest.input('afterJson', sql.NVarChar(sql.MAX), stringifyJson({
      reconciliationItemId: updated?.reconciliation_item_id || reconciliationItemId,
      reconciliationSessionId: updated?.reconciliation_session_id || current.reconciliation_session_id,
      sourceSystem: updated?.source_system || current.source_system,
      sourceRef: updated?.source_ref || current.source_ref,
      journalEntryId: updated?.journal_entry_id || null,
      matchStatus: updated?.match_status || matchStatus,
      differenceAmount: updated?.difference_amount === null || updated?.difference_amount === undefined
        ? (current.difference_amount === null ? null : Number(current.difference_amount))
        : Number(updated.difference_amount),
      notes: updated?.notes ?? current.notes ?? null,
      createdAt: updated?.created_at || current.created_at,
      reconciliationScope: current.reconciliation_scope,
      periodKey: current.period_key,
      matchResolution: normalizedMatchResolution
    }));
    await auditRequest.query(`
      INSERT INTO accounting.audit_log (
        entity_type,
        entity_id,
        action_type,
        performed_by,
        summary,
        before_json,
        after_json
      )
      VALUES (
        @entityType,
        @entityId,
        @actionType,
        @performedBy,
        @summary,
        @beforeJson,
        @afterJson
      )
    `);

    const remainingRequest = transaction.request();
    remainingRequest.input('reconciliationSessionId', sql.UniqueIdentifier, current.reconciliation_session_id);
    const remaining = await remainingRequest.query(`
      SELECT COUNT(1) AS open_count
      FROM accounting.reconciliation_items
      WHERE reconciliation_session_id = @reconciliationSessionId
        AND match_status IN ('pending_match', 'pending_review', 'exception_requires_review')
    `);
    const openCount = Number(remaining.recordset?.[0]?.open_count || 0);

    const sessionUpdateRequest = transaction.request();
    sessionUpdateRequest.input('reconciliationSessionId', sql.UniqueIdentifier, current.reconciliation_session_id);
    if (openCount === 0) {
      await sessionUpdateRequest.query(`
        UPDATE accounting.reconciliation_sessions
        SET status = 'completed',
            completed_at = COALESCE(completed_at, SYSUTCDATETIME())
        WHERE reconciliation_session_id = @reconciliationSessionId
      `);
    } else {
      await sessionUpdateRequest.query(`
        UPDATE accounting.reconciliation_sessions
        SET status = 'open',
            completed_at = NULL
        WHERE reconciliation_session_id = @reconciliationSessionId
      `);
    }

    await transaction.commit();

    return {
      ok: true,
      status: 'reviewed',
      reconciliationItem: {
        reconciliationItemId: updated?.reconciliation_item_id || reconciliationItemId,
        reconciliationSessionId: updated?.reconciliation_session_id || current.reconciliation_session_id,
        reconciliationScope: current.reconciliation_scope,
        periodKey: current.period_key,
        sessionStatus: openCount === 0 ? 'completed' : 'open',
        sourceSystem: updated?.source_system || current.source_system,
        sourceRef: updated?.source_ref || current.source_ref,
        journalEntryId: updated?.journal_entry_id || null,
        matchStatus: updated?.match_status || matchStatus,
        differenceAmount: updated?.difference_amount === null || updated?.difference_amount === undefined
          ? (current.difference_amount === null ? null : Number(current.difference_amount))
          : Number(updated.difference_amount),
        notes: updated?.notes ?? current.notes ?? null,
        createdAt: updated?.created_at || current.created_at,
        matchResolution: normalizedMatchResolution
      }
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}