import { ACCOUNTING_DOMAIN_VERSION, getAccountingPeriodKey } from '../../src/shared/accountingDomain.js';
import {
  DEFAULT_CHART_OF_ACCOUNTS_VERSION,
  getDefaultChartAccountByCode
} from '../../src/shared/chartOfAccounts.js';
import { TAX_RULES_VERSION } from '../../src/shared/taxRules.js';
import { isAzureSqlConfigured } from './azureSqlClient.js';

function resolveRulesVersion(input = {}) {
  return input.rulesVersion || input.metadata?.rulesVersion || TAX_RULES_VERSION;
}

function ensureAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Finance event amount must be a positive number');
  }

  return Math.round(parsed * 100) / 100;
}

export function normalizeFinanceEvent(input = {}) {
  const effectiveDate = input.effectiveDate || input.date;
  if (!effectiveDate) {
    throw new Error('Finance event effectiveDate is required');
  }

  return {
    idempotencyKey: input.idempotencyKey || `${input.sourceSystem || 'manual'}:${input.sourceRef || 'draft'}`,
    financeEventType: input.financeEventType,
    effectiveDate,
    periodKey: getAccountingPeriodKey(effectiveDate),
    userId: input.userId || null,
    propertyId: input.propertyId || null,
    amount: ensureAmount(input.amount),
    memo: input.memo || input.description || '',
    sourceSystem: input.sourceSystem || 'MANUAL',
    sourceRef: input.sourceRef || null,
    counterpartyName: input.counterpartyName || input.vendorName || input.tenantName || null,
    metadata: input.metadata || {}
  };
}

function buildLine(accountCode, amount, dc, memo, propertyId = null) {
  const account = getDefaultChartAccountByCode(accountCode);
  if (!account) {
    throw new Error(`Unknown chart of accounts code: ${accountCode}`);
  }

  return {
    accountCode,
    accountName: account.name,
    amount,
    dc,
    memo,
    propertyId
  };
}

function resolveAccountCode(inputCode, fallbackCode, label) {
  const accountCode = inputCode || fallbackCode;
  if (!accountCode) {
    throw new Error(`${label} is required`);
  }

  return accountCode;
}

export function buildJournalDraftFromFinanceEvent(eventInput) {
  const event = normalizeFinanceEvent(eventInput);
  const amount = event.amount;
  const cashAccountCode = resolveAccountCode(eventInput.cashAccountCode, '1000', 'cashAccountCode');
  const rulesVersion = resolveRulesVersion(eventInput);
  let lines;

  switch (event.financeEventType) {
    case 'rent_paid':
      lines = [
        buildLine(cashAccountCode, amount, 'D', event.memo, event.propertyId),
        buildLine('4000', amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'security_deposit_received':
      lines = [
        buildLine(cashAccountCode, amount, 'D', event.memo, event.propertyId),
        buildLine('2100', amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'vendor_expense_paid':
      lines = [
        buildLine(eventInput.expenseAccountCode || '5999', amount, 'D', event.memo, event.propertyId),
        buildLine(cashAccountCode, amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'owner_contribution':
      lines = [
        buildLine(cashAccountCode, amount, 'D', event.memo, event.propertyId),
        buildLine('3000', amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'owner_draw':
      lines = [
        buildLine('3000', amount, 'D', event.memo, event.propertyId),
        buildLine(cashAccountCode, amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'income_received':
      lines = [
        buildLine(cashAccountCode, amount, 'D', event.memo, event.propertyId),
        buildLine(resolveAccountCode(eventInput.incomeAccountCode, '4900', 'incomeAccountCode'), amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'income_reversed':
      lines = [
        buildLine(resolveAccountCode(eventInput.incomeAccountCode, '4900', 'incomeAccountCode'), amount, 'D', event.memo, event.propertyId),
        buildLine(cashAccountCode, amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'expense_paid':
      lines = [
        buildLine(resolveAccountCode(eventInput.expenseAccountCode, '5999', 'expenseAccountCode'), amount, 'D', event.memo, event.propertyId),
        buildLine(cashAccountCode, amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'liability_received':
      lines = [
        buildLine(cashAccountCode, amount, 'D', event.memo, event.propertyId),
        buildLine(resolveAccountCode(eventInput.liabilityAccountCode, '2100', 'liabilityAccountCode'), amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'asset_transfer':
      lines = [
        buildLine(resolveAccountCode(eventInput.toAccountCode, cashAccountCode, 'toAccountCode'), amount, 'D', event.memo, event.propertyId),
        buildLine(resolveAccountCode(eventInput.fromAccountCode, null, 'fromAccountCode'), amount, 'C', event.memo, event.propertyId)
      ];
      break;
    case 'account_reclassified':
      lines = [
        buildLine(resolveAccountCode(eventInput.debitAccountCode, null, 'debitAccountCode'), amount, 'D', event.memo, event.propertyId),
        buildLine(resolveAccountCode(eventInput.creditAccountCode, null, 'creditAccountCode'), amount, 'C', event.memo, event.propertyId)
      ];
      break;
    default:
      throw new Error(`Unsupported finance event type for Azure posting draft: ${event.financeEventType}`);
  }

  return {
    domainVersion: ACCOUNTING_DOMAIN_VERSION,
    rulesVersion,
    chartVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
    azureSqlReady: isAzureSqlConfigured(),
    journalEntry: {
      entryDate: event.effectiveDate,
      memo: event.memo || event.financeEventType,
      sourceSystem: event.sourceSystem,
      sourceRef: event.sourceRef,
      financeEventType: event.financeEventType,
      userId: event.userId,
      propertyId: event.propertyId,
      periodKey: event.periodKey,
      totalDebits: amount,
      totalCredits: amount,
      isBalanced: true,
      lines
    }
  };
}