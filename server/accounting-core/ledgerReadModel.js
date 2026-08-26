import { getDefaultChartAccountByCode } from '../../src/shared/chartOfAccounts.js';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';
import { ensureBookkeepingInitializedInAzure } from './bookkeepingMetadataStore.js';

const CASH_EQUIVALENT_ACCOUNT_CODES = new Set(['1000', '1010', '1020']);

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

function normalizeDateOnly(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function normalizeDateTime(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeAccountBalance(accountType, line) {
  const amount = roundCurrency(line.amount);
  if (['ASSET', 'EXPENSE'].includes(accountType)) {
    return line.dc === 'D' ? amount : -amount;
  }

  return line.dc === 'C' ? amount : -amount;
}

function buildEntryClassification(entry) {
  const financeEventType = String(entry.financeEventType || '');

  switch (financeEventType) {
    case 'income_received':
    case 'rent_paid':
      return { type: 'income', signedAmount: roundCurrency(entry.totalCredits || entry.totalDebits) };
    case 'income_reversed':
      return { type: 'income', signedAmount: -roundCurrency(entry.totalCredits || entry.totalDebits) };
    case 'expense_paid':
    case 'vendor_expense_paid':
      return { type: 'expense', signedAmount: -roundCurrency(entry.totalDebits || entry.totalCredits) };
    case 'manual_journal':
      break;
    default:
      if (['liability_received', 'asset_transfer', 'owner_contribution', 'owner_draw', 'account_reclassified'].includes(financeEventType)) {
        return { type: null, signedAmount: 0 };
      }
      break;
  }

  const primaryRevenueLine = entry.lines.find((line) => line.accountType === 'REVENUE' && !CASH_EQUIVALENT_ACCOUNT_CODES.has(line.accountCode));
  if (primaryRevenueLine) {
    return {
      type: 'income',
      signedAmount: primaryRevenueLine.dc === 'C'
        ? roundCurrency(primaryRevenueLine.amount)
        : -roundCurrency(primaryRevenueLine.amount)
    };
  }

  const primaryExpenseLine = entry.lines.find((line) => line.accountType === 'EXPENSE' && !CASH_EQUIVALENT_ACCOUNT_CODES.has(line.accountCode));
  if (primaryExpenseLine) {
    return {
      type: 'expense',
      signedAmount: primaryExpenseLine.dc === 'D'
        ? -roundCurrency(primaryExpenseLine.amount)
        : roundCurrency(primaryExpenseLine.amount)
    };
  }

  return { type: null, signedAmount: 0 };
}

function deriveEntryCategory(entry) {
  const categorizedLine = entry.lines.find((line) => (
    ['REVENUE', 'EXPENSE'].includes(line.accountType)
    && !CASH_EQUIVALENT_ACCOUNT_CODES.has(line.accountCode)
  ));

  if (categorizedLine?.accountName) {
    return categorizedLine.accountName;
  }

  const nonCashLine = entry.lines.find((line) => !CASH_EQUIVALENT_ACCOUNT_CODES.has(line.accountCode));
  if (nonCashLine?.accountName) {
    return nonCashLine.accountName;
  }

  return entry.counterpartyName || entry.memo || 'Uncategorized';
}

function mapLedgerEntries(rows = []) {
  const entriesById = new Map();

  for (const row of rows) {
    const journalEntryId = row.journal_entry_id;
    if (!journalEntryId) {
      continue;
    }

    if (!entriesById.has(journalEntryId)) {
      entriesById.set(journalEntryId, {
        id: journalEntryId,
        journalEntryId,
        financeEventId: row.finance_event_id || null,
        entryDate: normalizeDateOnly(row.entry_date),
        memo: row.entry_memo || row.memo || '',
        sourceSystem: row.source_system || null,
        sourceRef: row.source_ref || null,
        propertyId: row.entry_property_id || null,
        totalDebits: roundCurrency(row.total_debits),
        totalCredits: roundCurrency(row.total_credits),
        rulesVersion: row.rules_version || null,
        postedBy: row.posted_by || null,
        createdAt: normalizeDateTime(row.entry_created_at || row.created_at),
        updatedAt: normalizeDateTime(row.entry_updated_at || row.updated_at),
        financeEventType: row.finance_event_type || row.entry_type || null,
        counterpartyName: row.counterparty_name || null,
        metadata: safeParseJson(row.metadata_json) || {},
        lines: []
      });
    }

    if (row.line_number !== null && row.line_number !== undefined) {
      entriesById.get(journalEntryId).lines.push({
        lineNumber: Number(row.line_number),
        accountCode: row.account_code,
        accountName: row.account_name || getDefaultChartAccountByCode(row.account_code)?.name || row.account_code,
        accountType: row.account_type || getDefaultChartAccountByCode(row.account_code)?.type || null,
        dc: row.dc,
        amount: roundCurrency(row.line_amount),
        propertyId: row.line_property_id || row.entry_property_id || null,
        vendorName: row.vendor_name || null,
        tenantName: row.tenant_name || null,
        taxCategory: row.tax_category || null,
        scheduleELine: row.schedule_e_line === null || row.schedule_e_line === undefined ? null : Number(row.schedule_e_line),
        memo: row.line_memo || null
      });
    }
  }

  return Array.from(entriesById.values()).map((entry) => {
    entry.lines.sort((left, right) => left.lineNumber - right.lineNumber);
    const classification = buildEntryClassification(entry);
    const signedAmount = roundCurrency(classification.signedAmount);
    const category = deriveEntryCategory(entry);

    return {
      ...entry,
      category,
      transactionType: classification.type,
      signedAmount,
      amount: roundCurrency(Math.abs(signedAmount || entry.totalDebits || entry.totalCredits)),
      isExpense: classification.type === 'expense' ? true : classification.type === 'income' ? false : null,
      type: classification.type || null,
      description: entry.memo || '',
      vendor: entry.counterpartyName || entry.lines.find((line) => line.vendorName)?.vendorName || '',
      payee: entry.counterpartyName || entry.lines.find((line) => line.vendorName)?.vendorName || entry.lines.find((line) => line.tenantName)?.tenantName || ''
    };
  });
}

export async function listLedgerEntriesFromAzure({
  userId,
  startDate = null,
  endDate = null,
  propertyId = null,
  limit = 5000
} = {}) {
  if (!userId) {
    throw new Error('userId is required to list ledger entries from Azure');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      entries: []
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('startDate', sql.Date, startDate || null);
  request.input('endDate', sql.Date, endDate || null);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);
  request.input('limit', sql.Int, Math.max(1, Math.min(Number(limit) || 5000, 20000)));

  const result = await request.query(`
    WITH selected_entries AS (
      SELECT TOP (@limit)
        je.journal_entry_id,
        je.finance_event_id,
        je.property_id AS entry_property_id,
        je.entry_date,
        je.entry_type,
        je.source_system,
        je.source_ref,
        je.memo AS entry_memo,
        je.total_debits,
        je.total_credits,
        je.rules_version,
        je.posted_by,
        je.created_at AS entry_created_at,
        je.updated_at AS entry_updated_at
      FROM accounting.journal_entries je
      WHERE je.user_id = @userId
        AND (@startDate IS NULL OR je.entry_date >= @startDate)
        AND (@endDate IS NULL OR je.entry_date <= @endDate)
        AND (
          @propertyId IS NULL
          OR je.property_id = @propertyId
          OR EXISTS (
            SELECT 1
            FROM accounting.journal_lines jl_filter
            WHERE jl_filter.journal_entry_id = je.journal_entry_id
              AND jl_filter.property_id = @propertyId
          )
        )
      ORDER BY je.entry_date DESC, je.created_at DESC, je.journal_entry_id DESC
    )
    SELECT
      se.journal_entry_id,
      se.finance_event_id,
      se.entry_property_id,
      se.entry_date,
      se.entry_type,
      se.source_system,
      se.source_ref,
      se.entry_memo,
      se.total_debits,
      se.total_credits,
      se.rules_version,
      se.posted_by,
      se.entry_created_at,
      se.entry_updated_at,
      fe.finance_event_type,
      fe.counterparty_name,
      fe.metadata_json,
      jl.line_number,
      jl.account_code,
      jl.dc,
      jl.amount AS line_amount,
      jl.property_id AS line_property_id,
      jl.vendor_name,
      jl.tenant_name,
      jl.tax_category,
      jl.schedule_e_line,
      jl.memo AS line_memo,
      a.account_name,
      a.account_type
    FROM selected_entries se
    LEFT JOIN accounting.finance_events fe
      ON fe.finance_event_id = se.finance_event_id
    LEFT JOIN accounting.journal_lines jl
      ON jl.journal_entry_id = se.journal_entry_id
    LEFT JOIN accounting.accounts a
      ON a.account_code = jl.account_code
    ORDER BY se.entry_date DESC, se.entry_created_at DESC, se.journal_entry_id DESC, jl.line_number ASC
  `);

  return {
    ok: true,
    status: 'ready',
    entries: mapLedgerEntries(result.recordset || [])
  };
}

export async function getLedgerEntryByIdFromAzure({ userId, journalEntryId } = {}) {
  if (!userId || !journalEntryId) {
    throw new Error('userId and journalEntryId are required to load a ledger entry from Azure');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      entry: null
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('journalEntryId', sql.UniqueIdentifier, journalEntryId);

  const result = await request.query(`
    SELECT
      je.journal_entry_id,
      je.finance_event_id,
      je.entry_date,
      je.memo AS entry_memo,
      je.source_system,
      je.source_ref,
      je.property_id AS entry_property_id,
      je.total_debits,
      je.total_credits,
      je.rules_version,
      je.posted_by,
      je.created_at AS entry_created_at,
      je.updated_at AS entry_updated_at,
      fe.finance_event_type,
      fe.counterparty_name,
      fe.metadata_json,
      jl.line_number,
      jl.account_code,
      jl.dc,
      jl.amount AS line_amount,
      jl.property_id AS line_property_id,
      jl.vendor_name,
      jl.tenant_name,
      jl.tax_category,
      jl.schedule_e_line,
      jl.memo AS line_memo,
      a.account_name,
      a.account_type
    FROM accounting.journal_entries je
    LEFT JOIN accounting.finance_events fe
      ON fe.finance_event_id = je.finance_event_id
    LEFT JOIN accounting.journal_lines jl
      ON jl.journal_entry_id = je.journal_entry_id
    LEFT JOIN accounting.accounts a
      ON a.account_code = jl.account_code
    WHERE je.user_id = @userId
      AND je.journal_entry_id = @journalEntryId
    ORDER BY jl.line_number ASC
  `);

  const entries = mapLedgerEntries(result.recordset || []);
  return {
    ok: true,
    status: 'ready',
    entry: entries[0] || null
  };
}

export async function listLedgerAccountsFromAzure({
  userId,
  includeInactive = false
} = {}) {
  if (!userId) {
    throw new Error('userId is required to list ledger accounts from Azure');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      accounts: []
    };
  }

  await ensureBookkeepingInitializedInAzure({ userId });
  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('includeInactive', sql.Bit, includeInactive ? 1 : 0);

  const result = await request.query(`
    SELECT
      ba.account_code,
      ba.account_name,
      ba.account_type,
      ba.account_subtype,
      ba.is_active,
      a.chart_version,
      COALESCE(SUM(
        CASE
          WHEN je.user_id = @userId THEN
            CASE
              WHEN ba.account_type IN ('ASSET', 'EXPENSE') THEN CASE WHEN jl.dc = 'D' THEN jl.amount ELSE -jl.amount END
              ELSE CASE WHEN jl.dc = 'C' THEN jl.amount ELSE -jl.amount END
            END
          ELSE 0
        END
      ), 0) AS balance
    FROM accounting.bookkeeping_accounts ba
    LEFT JOIN accounting.accounts a
      ON a.account_code = ba.account_code
    LEFT JOIN accounting.journal_lines jl
      ON jl.account_code = ba.account_code
    LEFT JOIN accounting.journal_entries je
      ON je.journal_entry_id = jl.journal_entry_id
    WHERE ba.user_id = @userId
      AND (@includeInactive = 1 OR ba.is_active = 1)
    GROUP BY
      ba.account_code,
      ba.account_name,
      ba.account_type,
      ba.account_subtype,
      ba.is_active,
      a.chart_version
    ORDER BY ba.account_code ASC
  `);

  return {
    ok: true,
    status: 'ready',
    accounts: (result.recordset || []).map((row) => ({
      id: row.account_code,
      code: row.account_code,
      name: row.account_name || getDefaultChartAccountByCode(row.account_code)?.name || row.account_code,
      type: row.account_type,
      subtype: row.account_subtype || null,
      isActive: row.is_active === true || row.is_active === 1,
      chartVersion: row.chart_version || null,
      balance: roundCurrency(row.balance),
      normal_side: ['ASSET', 'EXPENSE'].includes(row.account_type) ? 'D' : 'C'
    }))
  };
}

export function buildLedgerAccountTotals(accounts = []) {
  return accounts.reduce((accumulator, account) => {
    accumulator[account.code] = roundCurrency(account.balance);
    return accumulator;
  }, {});
}

export function buildLedgerCategoryBuckets(entries = []) {
  const incomeByCategory = new Map();
  const expensesByCategory = new Map();
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const entry of entries) {
    const category = entry.category || 'Uncategorized';
    if (entry.transactionType === 'income') {
      totalIncome += roundCurrency(entry.signedAmount);
      incomeByCategory.set(category, roundCurrency((incomeByCategory.get(category) || 0) + entry.signedAmount));
      continue;
    }

    if (entry.transactionType === 'expense') {
      const expenseContribution = roundCurrency(-entry.signedAmount);
      totalExpenses += expenseContribution;
      expensesByCategory.set(category, roundCurrency((expensesByCategory.get(category) || 0) + expenseContribution));
    }
  }

  return {
    totalIncome: roundCurrency(totalIncome),
    totalExpenses: roundCurrency(totalExpenses),
    incomeByCategory,
    expensesByCategory
  };
}

export function buildTrialBalanceFromAccounts(accounts = []) {
  let totalDebits = 0;
  let totalCredits = 0;

  const rows = accounts.map((account) => {
    const balance = roundCurrency(account.balance);
    const isDebitNormal = ['ASSET', 'EXPENSE'].includes(account.type);
    const debits = isDebitNormal ? Math.max(0, balance) : Math.max(0, -balance);
    const credits = isDebitNormal ? Math.max(0, -balance) : Math.max(0, balance);
    totalDebits += debits;
    totalCredits += credits;

    return {
      code: account.code,
      name: account.name,
      type: account.type,
      normal_side: isDebitNormal ? 'D' : 'C',
      debits: roundCurrency(debits),
      credits: roundCurrency(credits),
      balance
    };
  });

  return {
    accounts: rows,
    totalDebits: roundCurrency(totalDebits),
    totalCredits: roundCurrency(totalCredits),
    isBalanced: Math.abs(totalDebits - totalCredits) < 0.01
  };
}

export function buildProfitLossFromEntries(entries = []) {
  const revenueByCode = new Map();
  const expenseByCode = new Map();

  for (const entry of entries) {
    for (const line of entry.lines || []) {
      if (line.accountType === 'REVENUE') {
        const amount = line.dc === 'C' ? roundCurrency(line.amount) : -roundCurrency(line.amount);
        const current = revenueByCode.get(line.accountCode) || { code: line.accountCode, name: line.accountName, amount: 0, scheduleELine: line.scheduleELine };
        current.amount = roundCurrency(current.amount + amount);
        revenueByCode.set(line.accountCode, current);
      }

      if (line.accountType === 'EXPENSE') {
        const amount = line.dc === 'D' ? roundCurrency(line.amount) : -roundCurrency(line.amount);
        const current = expenseByCode.get(line.accountCode) || { code: line.accountCode, name: line.accountName, amount: 0, scheduleELine: line.scheduleELine };
        current.amount = roundCurrency(current.amount + amount);
        expenseByCode.set(line.accountCode, current);
      }
    }
  }

  const revenues = Array.from(revenueByCode.values()).filter((row) => Math.abs(row.amount) > 0.004);
  const expenses = Array.from(expenseByCode.values()).filter((row) => Math.abs(row.amount) > 0.004);
  const totalRevenue = revenues.reduce((sum, row) => sum + row.amount, 0);
  const totalExpenses = expenses.reduce((sum, row) => sum + row.amount, 0);

  return {
    revenues: revenues.sort((left, right) => right.amount - left.amount),
    expenses: expenses.sort((left, right) => right.amount - left.amount),
    totalRevenue: roundCurrency(totalRevenue),
    totalExpenses: roundCurrency(totalExpenses),
    netIncome: roundCurrency(totalRevenue - totalExpenses)
  };
}