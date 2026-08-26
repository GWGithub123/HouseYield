function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

const OPERATING_CASH_ACCOUNT_CODE = '1000';
const STRIPE_CLEARING_ACCOUNT_CODE = '1020';
const CASH_EQUIVALENT_ACCOUNT_CODES = new Set(['1000', '1010', '1020']);

function isIncomeAccountCode(accountCode) {
  return ['4000', '4100', '4200', '4300', '4900'].includes(String(accountCode || ''));
}

function isExpenseAccountCode(accountCode) {
  const normalizedCode = String(accountCode || '');
  return /^5/.test(normalizedCode) || ['5999', '6000', '6100'].includes(normalizedCode);
}

function buildUnsupportedResult(reason, extra = {}) {
  return {
    ok: false,
    status: 'unsupported',
    reason,
    ...extra
  };
}

function buildPendingMatchResult(reason, extra = {}) {
  return {
    ok: false,
    status: 'pending_match',
    reason,
    ...extra
  };
}

function buildFinancialConnectionsPendingMatchResult({
  sourceEvent,
  financeEventInput,
  stripeCategory,
  looksLikeStripeSettlement,
  reason
}) {
  const pendingMatchInput = {
    idempotencyKey: `stripe:financial-connections:pending-match:${sourceEvent.sourceObjectId}`,
    effectiveDate: financeEventInput.effectiveDate,
    userId: financeEventInput.userId,
    propertyId: financeEventInput.propertyId || null,
    amount: financeEventInput.amount,
    sourceSystem: 'STRIPE',
    sourceRef: financeEventInput.sourceRef,
    reconciliationScope: looksLikeStripeSettlement ? 'stripe_transfer_match' : 'cash_movement_review',
    notes: looksLikeStripeSettlement
      ? 'Bank-side Stripe settlement is waiting to be matched to the Stripe clearing transfer before posting.'
      : 'Bank-side transfer requires reviewer confirmation before canonical posting.',
    metadata: {
      ...(financeEventInput.metadata || {}),
      shadowMode: true,
      stripeObject: 'financial_connections_transaction',
      stripeCategory
    }
  };

  return buildPendingMatchResult(reason, {
    sourceEvent,
    pendingMatchInput,
    suggestedMatch: looksLikeStripeSettlement
      ? {
          transferCategory: 'stripe_payout_settlement',
          expectedFromAccountCode: STRIPE_CLEARING_ACCOUNT_CODE,
          expectedToAccountCode: OPERATING_CASH_ACCOUNT_CODE
        }
      : {
          transferCategory: 'cash_movement_review',
          expectedToAccountCode: OPERATING_CASH_ACCOUNT_CODE
        }
  });
}

function buildSourceEvent({ sourceObjectId, sourceEventType, occurredAt, payload, userId, propertyId }) {
  return {
    sourceSystem: 'STRIPE',
    sourceObjectId,
    sourceEventType,
    occurredAt,
    userId,
    propertyId: propertyId || null,
    payload
  };
}

export function buildStripeBalanceFinanceEvent(txn, context = {}) {
  const amount = roundCurrency(Math.abs(Number(txn?.net || 0)) / 100);
  if (!amount) {
    return buildUnsupportedResult('Zero-amount Stripe balance transactions are not posted to the canonical ledger path.');
  }

  const effectiveDate = new Date(Number(txn.created || 0) * 1000 || Date.now()).toISOString();
  const sourceEvent = buildSourceEvent({
    sourceObjectId: txn.id,
    sourceEventType: 'stripe.balance_transaction',
    occurredAt: effectiveDate,
    payload: txn,
    userId: context.userId,
    propertyId: context.propertyId
  });

  const sharedMetadata = {
    shadowMode: true,
    stripeObject: 'balance_transaction',
    stripeType: txn.type || null,
    reportingCategory: txn.reporting_category || null,
    grossAmount: roundCurrency(Math.abs(Number(txn.amount || 0)) / 100),
    feeAmount: roundCurrency(Math.abs(Number(txn.fee || 0)) / 100)
  };

  switch (txn.type) {
    case 'charge':
    case 'payment':
      return {
        ok: true,
        sourceEvent,
        financeEventInput: {
          idempotencyKey: `stripe:balance:${txn.id}`,
          financeEventType: 'income_received',
          effectiveDate: effectiveDate.slice(0, 10),
          userId: context.userId,
          propertyId: context.propertyId || null,
          amount,
          memo: `Payment received: ${txn.description || 'Rent payment'}`,
          sourceSystem: 'STRIPE',
          sourceRef: `balance_transaction:${txn.id}`,
          counterpartyName: txn.description || null,
          cashAccountCode: STRIPE_CLEARING_ACCOUNT_CODE,
          incomeAccountCode: '4000',
          metadata: {
            ...sharedMetadata,
            legacyRoute: 'sync-transactions'
          }
        }
      };
    case 'stripe_fee':
    case 'application_fee':
      return {
        ok: true,
        sourceEvent,
        financeEventInput: {
          idempotencyKey: `stripe:balance:${txn.id}`,
          financeEventType: 'expense_paid',
          effectiveDate: effectiveDate.slice(0, 10),
          userId: context.userId,
          propertyId: context.propertyId || null,
          amount,
          memo: `Stripe fee: ${txn.description || 'Processing fee'}`,
          sourceSystem: 'STRIPE',
          sourceRef: `balance_transaction:${txn.id}`,
          counterpartyName: 'Stripe',
          cashAccountCode: STRIPE_CLEARING_ACCOUNT_CODE,
          expenseAccountCode: '5999',
          metadata: {
            ...sharedMetadata,
            legacyRoute: 'sync-transactions'
          }
        }
      };
    case 'payment_refund':
      return {
        ok: true,
        sourceEvent,
        financeEventInput: {
          idempotencyKey: `stripe:balance:${txn.id}`,
          financeEventType: 'income_reversed',
          effectiveDate: effectiveDate.slice(0, 10),
          userId: context.userId,
          propertyId: context.propertyId || null,
          amount,
          memo: `Refund issued: ${txn.description || 'Payment refund'}`,
          sourceSystem: 'STRIPE',
          sourceRef: `balance_transaction:${txn.id}`,
          counterpartyName: txn.description || null,
          cashAccountCode: STRIPE_CLEARING_ACCOUNT_CODE,
          incomeAccountCode: '4000',
          metadata: {
            ...sharedMetadata,
            legacyRoute: 'sync-transactions'
          }
        }
      };
    case 'payout':
      return {
        ok: true,
        sourceEvent,
        financeEventInput: {
          idempotencyKey: `stripe:balance:${txn.id}`,
          financeEventType: 'asset_transfer',
          effectiveDate: effectiveDate.slice(0, 10),
          userId: context.userId,
          propertyId: context.propertyId || null,
          amount,
          memo: `Payout to bank: ${txn.description || 'Bank payout'}`,
          sourceSystem: 'STRIPE',
          sourceRef: `balance_transaction:${txn.id}`,
          counterpartyName: 'Stripe',
          fromAccountCode: STRIPE_CLEARING_ACCOUNT_CODE,
          toAccountCode: OPERATING_CASH_ACCOUNT_CODE,
          metadata: {
            ...sharedMetadata,
            transferCategory: 'stripe_payout',
            legacyRoute: 'sync-transactions'
          }
        }
      };
    default:
      return buildUnsupportedResult(`Stripe balance transaction type ${txn.type || 'unknown'} is not mapped into the canonical ledger path yet.`, {
        sourceEvent
      });
  }
}

export function buildStripeFinancialConnectionsFinanceEvent(txn, context = {}) {
  const amount = roundCurrency(Math.abs(Number(txn?.amount || 0)) / 100);
  if (!amount) {
    return buildUnsupportedResult('Zero-amount Financial Connections transactions are not posted to the canonical ledger path.');
  }

  const occurredAt = new Date(Number(txn.transacted_at || 0) * 1000 || Date.now()).toISOString();
  const accountCode = context.accountCode || null;
  const legacyAccountCode = context.legacyAccountCode || accountCode;
  const description = txn.description || 'Bank transaction';
  const merchantName = txn.merchant_name || null;
  const stripeCategory = txn.category || 'uncategorized';
  const isTransferCategory = stripeCategory === 'transfer' || String(stripeCategory).startsWith('transfer.');
  const isDebit = Number(txn.amount || 0) < 0;
  const searchableText = `${description} ${merchantName || ''} ${stripeCategory}`.toLowerCase();
  const looksLikeStripeSettlement = /stripe payout|stripe transfer|payout from stripe|ach credit stripe|transfer from stripe/.test(searchableText);
  const sourceEvent = buildSourceEvent({
    sourceObjectId: txn.id,
    sourceEventType: 'stripe.financial_connections.transaction',
    occurredAt,
    payload: txn,
    userId: context.userId,
    propertyId: context.propertyId
  });

  const financeEventInput = {
    idempotencyKey: `stripe:financial-connections:${txn.id}`,
    effectiveDate: occurredAt.slice(0, 10),
    userId: context.userId,
    propertyId: context.propertyId || null,
    amount,
    memo: description,
    sourceSystem: 'STRIPE',
    sourceRef: `financial_connections_transaction:${txn.id}`,
    counterpartyName: merchantName,
    metadata: {
      shadowMode: true,
      stripeObject: 'financial_connections_transaction',
      stripeCategory,
      classificationRule: context.classification?.rule_name || null,
      legacyAccountCode,
      canonicalAccountCode: accountCode,
      ...(Number.isInteger(context.scheduleELine)
        ? { scheduleELine: context.scheduleELine }
        : {}),
      legacyRoute: 'sync-financial-connections-transactions'
    }
  };

  if (!isDebit && (/security deposit|sec deposit/.test(searchableText) || accountCode === '2100')) {
    return {
      ok: true,
      sourceEvent,
      financeEventInput: {
        ...financeEventInput,
        financeEventType: 'liability_received',
        liabilityAccountCode: '2100'
      }
    };
  }

  if (!isDebit && isIncomeAccountCode(accountCode)) {
    return {
      ok: true,
      sourceEvent,
      financeEventInput: {
        ...financeEventInput,
        financeEventType: 'income_received',
        incomeAccountCode: accountCode
      }
    };
  }

  if (isDebit && isExpenseAccountCode(accountCode)) {
    return {
      ok: true,
      sourceEvent,
      financeEventInput: {
        ...financeEventInput,
        financeEventType: 'expense_paid',
        expenseAccountCode: accountCode
      }
    };
  }

  if (!accountCode) {
    if (isTransferCategory) {
      return buildFinancialConnectionsPendingMatchResult({
        sourceEvent,
        financeEventInput,
        stripeCategory,
        looksLikeStripeSettlement,
        reason: looksLikeStripeSettlement
          ? 'Transfer-category bank-side Stripe settlement is staged for transfer matching so it can be reconciled against the Stripe clearing event instead of dropped.'
          : 'Transfer-category bank transaction is staged for reconciliation review instead of being dropped from the canonical ledger path.'
      });
    }

    return buildUnsupportedResult('No legacy account classification was available for this Financial Connections transaction.', {
      sourceEvent
    });
  }

  if (accountCode === '1000') {
    return buildFinancialConnectionsPendingMatchResult({
      sourceEvent,
      financeEventInput,
      stripeCategory,
      looksLikeStripeSettlement,
      reason: looksLikeStripeSettlement
        ? 'Bank-side Stripe settlement is staged for transfer matching so it can be reconciled against the Stripe clearing event instead of double-posted.'
        : 'Bank-side cash movement is staged for transfer matching because the counter-account is not reliable enough for direct canonical posting yet.'
    });
  }

  return buildUnsupportedResult(`Legacy account code ${accountCode} is not yet mapped into the canonical ledger path.`, {
    sourceEvent
  });
}

export function compareLegacyPostingToCanonicalDraft({ draft, legacyAccountCode = null, legacyIsDebit = null, legacyMemo = null }) {
  const lines = draft?.journalEntry?.lines || [];
  const canonicalPrimaryLine = lines.find((line) => String(line.accountCode) === String(legacyAccountCode || ''))
    || lines.find((line) => !CASH_EQUIVALENT_ACCOUNT_CODES.has(String(line.accountCode || '')))
    || lines[0]
    || null;
  const canonicalMemo = draft?.journalEntry?.memo || null;
  const legacyPrimaryDc = legacyIsDebit === null || legacyIsDebit === undefined
    ? null
    : legacyIsDebit
      ? 'D'
      : 'C';

  const accountMatch = !legacyAccountCode || !canonicalPrimaryLine
    ? null
    : String(legacyAccountCode) === canonicalPrimaryLine.accountCode;
  const directionMatch = !legacyPrimaryDc || !canonicalPrimaryLine
    ? null
    : legacyPrimaryDc === canonicalPrimaryLine.dc;
  const memoMatch = !legacyMemo || !canonicalMemo
    ? null
    : String(legacyMemo).trim() === String(canonicalMemo).trim();

  return {
    canonicalEventType: draft?.journalEntry?.financeEventType || null,
    canonicalAccountCode: canonicalPrimaryLine?.accountCode || null,
    canonicalPrimaryDc: canonicalPrimaryLine?.dc || null,
    legacyAccountCode: legacyAccountCode || null,
    legacyPrimaryDc,
    accountMatchStatus: accountMatch === null ? 'unknown' : accountMatch ? 'match' : 'mismatch',
    directionMatchStatus: directionMatch === null ? 'unknown' : directionMatch ? 'match' : 'mismatch',
    legacyMemo: legacyMemo || null,
    canonicalMemo,
    memoMatchStatus: memoMatch === null ? 'unknown' : memoMatch ? 'match' : 'mismatch'
  };
}