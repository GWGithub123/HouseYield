import { ACCOUNTING_DOMAIN_VERSION, getAccountingPeriodKey } from '../../src/shared/accountingDomain.js';
import {
  DEFAULT_CHART_OF_ACCOUNTS_VERSION,
  getDefaultChartAccountByCode
} from '../../src/shared/chartOfAccounts.js';
import { TAX_RULES_VERSION } from '../../src/shared/taxRules.js';
import { postJournalDraftShadowToAzure, postJournalDraftToAzure } from './ledgerStore.js';

function resolveRulesVersion(entry = {}) {
  return entry.rulesVersion || entry.metadata?.rulesVersion || TAX_RULES_VERSION;
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeJournalLine(line = {}, fallbackPropertyId = null) {
  const accountCode = String(line.accountCode || line.code || '').trim();
  const account = getDefaultChartAccountByCode(accountCode);
  if (!account) {
    throw new Error(`Manual journal line uses an unsupported chart of accounts code: ${accountCode || '<missing>'}`);
  }

  const dc = String(line.dc || '').trim().toUpperCase();
  if (!['D', 'C'].includes(dc)) {
    throw new Error(`Manual journal line for account ${accountCode} must use dc of D or C`);
  }

  const amount = roundCurrency(line.amount);
  if (!amount || amount < 0) {
    throw new Error(`Manual journal line for account ${accountCode} must have a positive amount`);
  }

  return {
    accountCode,
    accountName: line.accountName || account.name,
    amount,
    dc,
    memo: line.memo || '',
    propertyId: line.propertyId || fallbackPropertyId || null
  };
}

export function buildCanonicalManualJournalCandidate({
  userId,
  journalEntryId,
  entry = {},
  sourceSystem = 'HOUSEYIELD',
  sourceEventType = 'bookkeeping.manual_journal_entry'
}) {
  if (!userId) {
    throw new Error('userId is required to mirror a manual journal entry into the canonical ledger');
  }

  if (!journalEntryId) {
    throw new Error('journalEntryId is required to mirror a manual journal entry into the canonical ledger');
  }

  if (!entry.entryDate) {
    throw new Error('entry.entryDate is required to mirror a manual journal entry into the canonical ledger');
  }

  if (!Array.isArray(entry.lines) || entry.lines.length === 0) {
    throw new Error('entry.lines is required to mirror a manual journal entry into the canonical ledger');
  }

  const propertyId = entry.propertyId || entry.lines.find((line) => line?.propertyId)?.propertyId || null;
  const normalizedLines = entry.lines.map((line) => normalizeJournalLine(line, propertyId));
  const totalDebits = roundCurrency(normalizedLines
    .filter((line) => line.dc === 'D')
    .reduce((sum, line) => sum + line.amount, 0));
  const totalCredits = roundCurrency(normalizedLines
    .filter((line) => line.dc === 'C')
    .reduce((sum, line) => sum + line.amount, 0));

  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    throw new Error(`Manual journal entry ${journalEntryId} is not balanced and cannot be mirrored into the canonical ledger`);
  }

  const sourceRef = typeof entry.sourceRef === 'string' && entry.sourceRef.trim()
    ? entry.sourceRef.trim()
    : `firestore_journal_entry:${journalEntryId}`;
  const memo = entry.memo || `Manual journal ${journalEntryId}`;
  const rulesVersion = resolveRulesVersion(entry);
  const metadata = {
    ...(entry.metadata || {}),
    legacySource: entry.source || 'MANUAL',
    legacyStore: 'bookkeeping-firestore',
    firestoreJournalEntryId: journalEntryId,
    scheduleELine: entry.scheduleELine || null,
    category: entry.category || null,
    hasReceipt: Boolean(entry.hasReceipt),
    rulesVersion
  };

  return {
    ok: true,
    sourceEvent: {
      sourceSystem,
      sourceObjectId: `journal-entry:${journalEntryId}`,
      sourceEventType,
      occurredAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
      userId,
      propertyId,
      payload: {
        journalEntryId,
        source: entry.source || 'MANUAL',
        sourceRef,
        memo,
        propertyId,
        lineCount: normalizedLines.length,
        totalDebits,
        totalCredits
      }
    },
    financeEventInput: {
      idempotencyKey: `bookkeeping:manual-journal:${journalEntryId}`,
      financeEventType: 'manual_journal',
      effectiveDate: entry.entryDate,
      userId,
      propertyId,
      amount: totalDebits,
      memo,
      sourceSystem,
      sourceRef,
      counterpartyName: entry.vendor || entry.counterpartyName || entry.tenantName || entry.payee || null,
      metadata
    },
    journalDraft: {
      domainVersion: ACCOUNTING_DOMAIN_VERSION,
      rulesVersion,
      chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
      azureSqlReady: true,
      journalEntry: {
        entryDate: entry.entryDate,
        memo,
        sourceSystem,
        sourceRef,
        financeEventType: 'manual_journal',
        userId,
        propertyId,
        periodKey: getAccountingPeriodKey(entry.entryDate),
        totalDebits,
        totalCredits,
        isBalanced: true,
        lines: normalizedLines
      }
    }
  };
}

export async function postCanonicalManualJournalEntry({
  userId,
  journalEntryId,
  entry = {},
  postedBy = 'bookkeeping-canonical',
  postingMode = 'live',
  idempotencyScope = 'bookkeeping-manual-journal',
  sourceSystem = 'HOUSEYIELD',
  sourceEventType = 'bookkeeping.manual_journal_entry'
}) {
  const candidate = buildCanonicalManualJournalCandidate({
    userId,
    journalEntryId,
    entry,
    sourceSystem,
    sourceEventType
  });

  const postJournal = postingMode === 'shadow' ? postJournalDraftShadowToAzure : postJournalDraftToAzure;
  return postJournal({
    sourceEvent: candidate.sourceEvent,
    financeEventInput: {
      ...candidate.financeEventInput,
      metadata: {
        ...(candidate.financeEventInput.metadata || {}),
        shadowMode: postingMode === 'shadow',
        postingMode
      }
    },
    journalDraft: candidate.journalDraft,
    postedBy,
    idempotencyScope
  });
}