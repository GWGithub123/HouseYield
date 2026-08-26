/**
 * Finance Audit Assistant — canonical ledger tools.
 *
 * Read-only, owner-scoped tool wrappers around the accounting-core Azure SQL
 * read paths, exposed to Gemini via function calling from
 * server/finance-audit-assistant.js.
 *
 * SECURITY MODEL:
 *  - `userId` (the authenticated Firebase uid) and `propertyId` (the page's
 *    property scope) are bound server-side when the toolset is created. The
 *    model can never pass an ownerId/userId/propertyId of its own — any such
 *    argument is ignored.
 *  - Every tool delegates to an existing parameterized accounting-core read
 *    function (no raw SQL is ever constructed from model output).
 *  - All tools are strictly read-only.
 */

import { SchemaType } from '@google/generative-ai';
import { isAzureSqlConfigured } from './accounting-core/azureSqlClient.js';
import {
  listLedgerEntriesFromAzure,
  listLedgerAccountsFromAzure,
  buildLedgerCategoryBuckets,
  buildProfitLossFromEntries,
  buildTrialBalanceFromAccounts
} from './accounting-core/ledgerReadModel.js';
import { listFinanceEvidenceFromAzure } from './accounting-core/evidenceStore.js';
import { listEstimatedTaxPaymentsFromAzure } from './accounting-core/estimatedTaxPaymentStore.js';
import { listClosePeriodsFromAzure } from './accounting-core/closePeriodStore.js';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLedgerToolingConfigured() {
  return isAzureSqlConfigured();
}

function cleanDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  return ISO_DATE_PATTERN.test(text) ? text : null;
}

function clampInt(value, { fallback, min, max }) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function describeRange(dateFrom, dateTo) {
  if (dateFrom && dateTo) return `${dateFrom} to ${dateTo}`;
  if (dateFrom) return `from ${dateFrom}`;
  if (dateTo) return `through ${dateTo}`;
  return 'all dates';
}

function mapToObject(map) {
  const out = {};
  for (const [key, value] of map.entries()) {
    out[key] = value;
  }
  return out;
}

function compactEntry(entry) {
  return {
    date: entry.entryDate,
    memo: entry.memo || null,
    category: entry.category || null,
    type: entry.transactionType || entry.financeEventType || null,
    amount: entry.amount,
    signedAmount: entry.signedAmount,
    payee: entry.payee || null,
    propertyId: entry.propertyId || null,
    lines: (entry.lines || []).map((line) => ({
      accountCode: line.accountCode,
      accountName: line.accountName,
      dc: line.dc,
      amount: line.amount,
      scheduleELine: line.scheduleELine
    }))
  };
}

async function fetchScopedEntries(scope, { dateFrom = null, dateTo = null, fetchLimit = 2000 } = {}) {
  const result = await listLedgerEntriesFromAzure({
    userId: scope.userId,
    propertyId: scope.propertyId || null,
    startDate: dateFrom,
    endDate: dateTo,
    limit: fetchLimit
  });

  if (result.status === 'not_configured') {
    const error = new Error('The canonical ledger (Azure SQL) is not configured on this server.');
    error.code = 'ledger_not_configured';
    throw error;
  }

  return result.entries || [];
}

// ----------------------------------------------------------------------------
// Tool implementations — each returns { result, summary } where `summary` is a
// short human-readable line for the response's `dataUsed` field.
// ----------------------------------------------------------------------------

const TOOLS = {
  list_journal_entries: {
    declaration: {
      name: 'list_journal_entries',
      description:
        'List individual journal entries from the canonical double-entry ledger for the current owner (and current property scope, if any). Returns entry-level detail: date, memo, category, signed amount, payee, and debit/credit lines with account codes. Use for questions about specific transactions, amounts, vendors, or categories.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          dateFrom: { type: SchemaType.STRING, description: 'Earliest entry date, YYYY-MM-DD (optional).' },
          dateTo: { type: SchemaType.STRING, description: 'Latest entry date, YYYY-MM-DD (optional).' },
          category: { type: SchemaType.STRING, description: 'Case-insensitive category/account-name filter, e.g. "Repairs" (optional).' },
          accountCode: { type: SchemaType.STRING, description: 'Restrict to entries touching this chart-of-accounts code, e.g. "6100" (optional).' },
          limit: { type: SchemaType.NUMBER, description: 'Max entries to return (default 25, max 50).' }
        }
      }
    },
    async run(scope, args = {}) {
      const dateFrom = cleanDate(args.dateFrom);
      const dateTo = cleanDate(args.dateTo);
      const limit = clampInt(args.limit, { fallback: 25, min: 1, max: 50 });
      const category = String(args.category || '').trim().toLowerCase();
      const accountCode = String(args.accountCode || '').trim();

      let entries = await fetchScopedEntries(scope, { dateFrom, dateTo });
      if (category) {
        entries = entries.filter((entry) => String(entry.category || '').toLowerCase().includes(category));
      }
      if (accountCode) {
        entries = entries.filter((entry) => (entry.lines || []).some((line) => line.accountCode === accountCode));
      }

      const matched = entries.length;
      const returned = entries.slice(0, limit).map(compactEntry);
      const filters = [
        category ? `category~"${args.category}"` : null,
        accountCode ? `account ${accountCode}` : null
      ].filter(Boolean).join(', ');

      return {
        result: { matchedEntries: matched, returnedEntries: returned.length, entries: returned },
        summary: `Queried ledger: ${matched} entr${matched === 1 ? 'y' : 'ies'} (${describeRange(dateFrom, dateTo)}${filters ? `, ${filters}` : ''})`
      };
    }
  },

  get_trial_balance: {
    declaration: {
      name: 'get_trial_balance',
      description:
        'Get the trial balance (per-account debit/credit balances and whether total debits equal total credits) from the canonical ledger for the current owner. Balances are life-to-date across all activity.',
      parameters: { type: SchemaType.OBJECT, properties: {} }
    },
    async run(scope) {
      const result = await listLedgerAccountsFromAzure({ userId: scope.userId });
      if (result.status === 'not_configured') {
        const error = new Error('The canonical ledger (Azure SQL) is not configured on this server.');
        error.code = 'ledger_not_configured';
        throw error;
      }
      const trialBalance = buildTrialBalanceFromAccounts(result.accounts || []);
      return {
        result: trialBalance,
        summary: `Pulled trial balance: ${trialBalance.accounts.length} accounts, ${trialBalance.isBalanced ? 'balanced' : 'NOT balanced'}`
      };
    }
  },

  get_profit_and_loss: {
    declaration: {
      name: 'get_profit_and_loss',
      description:
        'Compute a profit & loss statement (revenue and expense totals by account, plus net income) from canonical ledger entries for the current owner/property scope over a date range.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          dateFrom: { type: SchemaType.STRING, description: 'Period start, YYYY-MM-DD (optional).' },
          dateTo: { type: SchemaType.STRING, description: 'Period end, YYYY-MM-DD (optional).' }
        }
      }
    },
    async run(scope, args = {}) {
      const dateFrom = cleanDate(args.dateFrom);
      const dateTo = cleanDate(args.dateTo);
      const entries = await fetchScopedEntries(scope, { dateFrom, dateTo });
      const pnl = buildProfitLossFromEntries(entries);
      return {
        result: { period: describeRange(dateFrom, dateTo), entryCount: entries.length, ...pnl },
        summary: `Computed P&L from ${entries.length} ledger entries (${describeRange(dateFrom, dateTo)}): net ${pnl.netIncome}`
      };
    }
  },

  get_category_breakdown: {
    declaration: {
      name: 'get_category_breakdown',
      description:
        'Get income and expense totals grouped by category from canonical ledger entries for the current owner/property scope over a date range. Use for "where did my money go" / biggest-expense style questions.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          dateFrom: { type: SchemaType.STRING, description: 'Period start, YYYY-MM-DD (optional).' },
          dateTo: { type: SchemaType.STRING, description: 'Period end, YYYY-MM-DD (optional).' }
        }
      }
    },
    async run(scope, args = {}) {
      const dateFrom = cleanDate(args.dateFrom);
      const dateTo = cleanDate(args.dateTo);
      const entries = await fetchScopedEntries(scope, { dateFrom, dateTo });
      const buckets = buildLedgerCategoryBuckets(entries);
      return {
        result: {
          period: describeRange(dateFrom, dateTo),
          entryCount: entries.length,
          totalIncome: buckets.totalIncome,
          totalExpenses: buckets.totalExpenses,
          incomeByCategory: mapToObject(buckets.incomeByCategory),
          expensesByCategory: mapToObject(buckets.expensesByCategory)
        },
        summary: `Built category breakdown from ${entries.length} ledger entries (${describeRange(dateFrom, dateTo)})`
      };
    }
  },

  search_evidence: {
    declaration: {
      name: 'search_evidence',
      description:
        'Search the owner\'s finance evidence vault (receipts, invoices, statements and other supporting documents) by free-text query. Returns matching documents with title, vendor, amount, date, and linked entities.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          query: { type: SchemaType.STRING, description: 'Free-text search, e.g. a vendor name or "roof repair invoice".' },
          year: { type: SchemaType.NUMBER, description: 'Restrict to documents dated in this calendar year (optional).' },
          limit: { type: SchemaType.NUMBER, description: 'Max documents to return (default 10, max 25).' }
        },
        required: ['query']
      }
    },
    async run(scope, args = {}) {
      const query = String(args.query || '').trim().slice(0, 200);
      if (!query) {
        throw new Error('search_evidence requires a non-empty query.');
      }
      const limit = clampInt(args.limit, { fallback: 10, min: 1, max: 25 });
      const year = clampInt(args.year, { fallback: null, min: 2000, max: 2100 });

      const result = await listFinanceEvidenceFromAzure({
        userId: scope.userId,
        propertyId: scope.propertyId || null,
        year,
        q: query,
        limit
      });
      if (result.status === 'not_configured') {
        const error = new Error('The evidence vault (Azure SQL) is not configured on this server.');
        error.code = 'ledger_not_configured';
        throw error;
      }

      const documents = (result.evidence || []).map((record) => ({
        title: record.title,
        evidenceType: record.evidenceType,
        vendorName: record.vendorName,
        amount: record.amount,
        documentDate: record.documentDate,
        sourceSystem: record.sourceSystem,
        digitizationStatus: record.digitizationStatus,
        links: record.links
      }));

      return {
        result: { query, hitCount: documents.length, documents },
        summary: `Searched evidence for "${query}": ${documents.length} document${documents.length === 1 ? '' : 's'}`
      };
    }
  },

  get_estimated_tax_payments: {
    declaration: {
      name: 'get_estimated_tax_payments',
      description:
        'List the owner\'s recorded quarterly estimated tax payments (quarter, amount, date paid, method) for a tax year from the canonical store.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          taxYear: { type: SchemaType.NUMBER, description: 'Tax year, e.g. 2025.' }
        },
        required: ['taxYear']
      }
    },
    async run(scope, args = {}) {
      const taxYear = clampInt(args.taxYear, { fallback: null, min: 2000, max: 2100 });
      if (!taxYear) {
        throw new Error('get_estimated_tax_payments requires a valid taxYear.');
      }
      const result = await listEstimatedTaxPaymentsFromAzure({ userId: scope.userId, taxYear });
      if (result.status === 'not_configured') {
        const error = new Error('The canonical ledger (Azure SQL) is not configured on this server.');
        error.code = 'ledger_not_configured';
        throw error;
      }
      const payments = result.payments || [];
      const total = payments.reduce((sum, payment) => sum + (payment.amount || 0), 0);
      return {
        result: { taxYear, paymentCount: payments.length, totalPaid: Math.round(total * 100) / 100, payments },
        summary: `Checked estimated tax payments for ${taxYear}: ${payments.length} payment${payments.length === 1 ? '' : 's'}`
      };
    }
  },

  get_close_periods: {
    declaration: {
      name: 'get_close_periods',
      description:
        'List the owner\'s accounting close periods (month-end close / reconciliation status): period key, open/closed status, who closed it and when, and exception review state.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          limit: { type: SchemaType.NUMBER, description: 'Max periods to return, most recent first (default 12, max 36).' }
        }
      }
    },
    async run(scope, args = {}) {
      const limit = clampInt(args.limit, { fallback: 12, min: 1, max: 36 });
      const result = await listClosePeriodsFromAzure({
        userId: scope.userId,
        propertyId: scope.propertyId || null,
        limit
      });
      if (result.status === 'not_configured') {
        const error = new Error('The canonical ledger (Azure SQL) is not configured on this server.');
        error.code = 'ledger_not_configured';
        throw error;
      }
      const periods = (result.closePeriods || []).map((period) => ({
        periodKey: period.periodKey,
        status: period.status,
        startDate: period.startDate,
        endDate: period.endDate,
        closedBy: period.closedBy,
        closedAt: period.closedAt,
        reopenedAt: period.reopenedAt,
        exceptionReview: period.exceptionReview || null
      }));
      return {
        result: { periodCount: periods.length, closePeriods: periods },
        summary: `Checked close periods: ${periods.length} period${periods.length === 1 ? '' : 's'}`
      };
    }
  }
};

/**
 * Build an owner-scoped, read-only toolset for one /ask request.
 *
 * @param {object} scope
 * @param {string} scope.userId      Authenticated Firebase uid (required).
 * @param {string|null} scope.propertyId Optional property scope from page context.
 */
export function createFinanceAuditToolset({ userId, propertyId = null } = {}) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('createFinanceAuditToolset requires an authenticated userId');
  }

  const scope = Object.freeze({
    userId,
    propertyId: typeof propertyId === 'string' && propertyId.trim() ? propertyId.trim() : null
  });

  return {
    scope,
    declarations: Object.values(TOOLS).map((tool) => tool.declaration),
    async execute(name, args = {}) {
      const tool = TOOLS[name];
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      // Strip any model-supplied scope overrides before running — owner and
      // property scope are bound server-side at toolset creation.
      const { ownerId, userId: _ignoredUser, uid, propertyId: _ignoredProperty, ...safeArgs } =
        args && typeof args === 'object' ? args : {};
      void ownerId; void _ignoredUser; void uid; void _ignoredProperty;
      return tool.run(scope, safeArgs);
    }
  };
}

export default createFinanceAuditToolset;
