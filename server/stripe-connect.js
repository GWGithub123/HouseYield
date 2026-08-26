/**
 * Stripe Connect Integration for Landlord-Tenant Payments
 * Allows landlords to connect their bank accounts and receive payments directly
 * Integrates with bookkeeping system for tax-ready categorization
 */

import express from 'express';
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { mergeAttomDerivedData } from './attom-firestore-cache.js';
import { recordTenantPayment, updateMaintenanceRequestDetails, updateTenantPaymentStatus } from './tenant-activity-service.js';
import { sendHtmlEmail } from './email-service.js';
import { buildJournalDraftFromFinanceEvent } from './accounting-core/postingEngine.js';
import { postJournalDraftToAzure, postJournalDraftShadowToAzure, stagePendingMatchToAzure } from './accounting-core/ledgerStore.js';
import {
  buildStripeBalanceFinanceEvent,
  buildStripeFinancialConnectionsFinanceEvent,
  compareLegacyPostingToCanonicalDraft
} from './accounting-core/stripeFinanceEvents.js';
import {
  buildTenantAutopaySetupSessionParams,
  buildTenantAutopaySubscriptionParams,
  buildTenantCheckoutSessionParams,
  deriveStripePaymentMethodTypeFromCheckoutSession,
  deriveStripePaymentMethodTypeFromPaymentIntent
} from './stripe-tenant-payment-config.js';

const router = express.Router();

// Initialize Stripe with your secret key
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-11-20.acacia'
});

const CLAUDE_API_KEY = process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY || '';
const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

console.log('[Stripe Connect] Initialized with API key:', STRIPE_SECRET_KEY.substring(0, 20) + '...');

// Polygon API for stock data (server-side)
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || process.env.VITE_POLYGON_API_KEY || '';
if (!POLYGON_API_KEY) {
  console.warn('[Polygon] POLYGON_API_KEY not configured; price/dividend inference may be limited.');
}

if (!anthropic) {
  console.warn('[Stripe Connect] Claude API key not configured; rental analytics sample will fall back to heuristic categorization.');
}

// Storage for Connected Accounts
const STORAGE_DIR = path.join(process.cwd(), 'server', 'data', 'stripe-connect');
const ACCOUNTS_FILE = path.join(STORAGE_DIR, 'connected-accounts.json');
const AUTOPAY_CUSTOM_RENEWALS_FILE = path.join(STORAGE_DIR, 'autopay-custom-renewals.json');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Helper functions for storage
const readAccounts = () => {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[Stripe Connect] Error reading accounts:', error);
  }
  return {};
};

const writeAccounts = (accounts) => {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
};

const readAutopayCustomRenewals = () => {
  try {
    if (fs.existsSync(AUTOPAY_CUSTOM_RENEWALS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AUTOPAY_CUSTOM_RENEWALS_FILE, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (error) {
    console.error('[Stripe Autopay Schedule] Error reading persisted custom renewals:', error);
  }
  return [];
};

const LIVE_AUTOPAY_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
const MAX_AUTOPAY_TEST_SCHEDULE_MS = 24 * 60 * 60 * 1000;
const TEST_AUTOPAY_RENEWAL_JOBS = new Map();

function hasExpandedStripeResource(value) {
  return Boolean(value && typeof value === 'object');
}

function isLiveAutopaySubscription(subscription) {
  return Boolean(subscription && LIVE_AUTOPAY_STATUSES.has(subscription.status));
}

function isStripeTestMode() {
  return STRIPE_SECRET_KEY.startsWith('sk_test_');
}

function getStripeResourceId(value) {
  if (!value) {
    return null;
  }

  return typeof value === 'string' ? value : value.id || null;
}

async function getExpandedCheckoutSession(sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.payment_method', 'payment_intent.latest_charge']
  });
}

async function resolveCheckoutSessionPaymentMethodType(session) {
  const needsExpansion =
    typeof session?.payment_intent === 'string'
    || (
      hasExpandedStripeResource(session?.payment_intent)
      && !hasExpandedStripeResource(session.payment_intent.payment_method)
      && !hasExpandedStripeResource(session.payment_intent.latest_charge)
    );

  const sessionWithPaymentDetails = needsExpansion && session?.id
    ? await getExpandedCheckoutSession(session.id)
    : session;

  return deriveStripePaymentMethodTypeFromCheckoutSession(sessionWithPaymentDetails)
    || sessionWithPaymentDetails?.payment_method_types?.[0]
    || 'card';
}

async function resolvePaymentIntentPaymentMethodType(paymentIntent) {
  if (!paymentIntent?.id) {
    return 'card';
  }

  const needsExpansion =
    !hasExpandedStripeResource(paymentIntent.payment_method)
    && !hasExpandedStripeResource(paymentIntent.latest_charge);

  const paymentIntentWithPaymentDetails = needsExpansion
    ? await stripe.paymentIntents.retrieve(paymentIntent.id, {
        expand: ['payment_method', 'latest_charge']
      })
    : paymentIntent;

  return deriveStripePaymentMethodTypeFromPaymentIntent(paymentIntentWithPaymentDetails)
    || paymentIntentWithPaymentDetails?.payment_method_types?.[0]
    || 'card';
}

async function ensureUsBankAccountPaymentMethod(paymentMethodId) {
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (paymentMethod?.type !== 'us_bank_account') {
    throw new Error('Auto-pay requires a verified ACH bank account. Please complete the bank account setup again.');
  }

  return paymentMethod;
}

async function findExistingAutopaySubscription(customerId, landlordAccountId) {
  const existingSubs = await stripe.subscriptions.list({ customer: customerId, limit: 10 });
  return existingSubs.data.find((subscription) =>
    isLiveAutopaySubscription(subscription)
    && subscription.metadata?.landlordAccountId === landlordAccountId
  ) || null;
}

function serializeAutopayTestJob(job) {
  return {
    id: job.id,
    subscriptionId: job.subscriptionId,
    reason: job.reason,
    runAt: job.runAt,
    scheduledAt: job.scheduledAt,
    status: job.status,
    executedAt: job.executedAt || null,
    result: job.result || null,
    error: job.error || null
  };
}

function persistAutopayCustomRenewals() {
  try {
    const jobs = [...TEST_AUTOPAY_RENEWAL_JOBS.values()]
      .map(serializeAutopayTestJob)
      .sort((left, right) => left.runAt.localeCompare(right.runAt));
    fs.writeFileSync(AUTOPAY_CUSTOM_RENEWALS_FILE, JSON.stringify(jobs, null, 2));
  } catch (error) {
    console.error('[Stripe Autopay Schedule] Error persisting custom renewals:', error);
  }
}

function countScheduledAutopayTestJobs(subscriptionId) {
  return [...TEST_AUTOPAY_RENEWAL_JOBS.values()].filter((job) =>
    job.subscriptionId === subscriptionId && job.status === 'scheduled'
  ).length;
}

async function executeScheduledAutopayRenewalJob(job) {
  try {
    const result = await createAutopayTestRenewal({
      subscriptionId: job.subscriptionId,
      reason: job.reason,
      requestedRunAt: job.runAt
    });
    job.status = 'completed';
    job.executedAt = new Date().toISOString();
    job.result = result;
    job.error = null;
  } catch (error) {
    job.status = 'failed';
    job.executedAt = new Date().toISOString();
    job.error = error.message;
    console.error('[Stripe Autopay Schedule] Scheduled renewal failed:', error);
  } finally {
    job.timer = null;
    TEST_AUTOPAY_RENEWAL_JOBS.set(job.id, job);
    persistAutopayCustomRenewals();
  }
}

function armScheduledAutopayRenewalJob(job) {
  const runTimestamp = new Date(job.runAt).getTime();
  if (Number.isNaN(runTimestamp)) {
    job.status = 'failed';
    job.executedAt = new Date().toISOString();
    job.error = 'Scheduled renewal time is invalid.';
    job.timer = null;
    TEST_AUTOPAY_RENEWAL_JOBS.set(job.id, job);
    persistAutopayCustomRenewals();
    return;
  }

  const delayMs = runTimestamp - Date.now();
  if (delayMs < -MAX_AUTOPAY_TEST_SCHEDULE_MS) {
    job.status = 'failed';
    job.executedAt = new Date().toISOString();
    job.error = 'Scheduled renewal was missed while the server was offline for too long.';
    job.timer = null;
    TEST_AUTOPAY_RENEWAL_JOBS.set(job.id, job);
    persistAutopayCustomRenewals();
    return;
  }

  if (job.timer) {
    clearTimeout(job.timer);
  }

  job.status = 'scheduled';
  TEST_AUTOPAY_RENEWAL_JOBS.set(job.id, job);
  persistAutopayCustomRenewals();

  job.timer = setTimeout(() => {
    void executeScheduledAutopayRenewalJob(job);
  }, Math.max(0, delayMs));
}

function restorePersistedAutopayRenewalJobs() {
  const persistedJobs = readAutopayCustomRenewals();
  if (persistedJobs.length === 0) {
    return;
  }

  for (const persistedJob of persistedJobs) {
    const job = {
      ...persistedJob,
      timer: null
    };
    TEST_AUTOPAY_RENEWAL_JOBS.set(job.id, job);
  }

  for (const job of TEST_AUTOPAY_RENEWAL_JOBS.values()) {
    if (job.status === 'scheduled') {
      armScheduledAutopayRenewalJob(job);
    }
  }
}

async function createAutopayTestRenewal({ subscriptionId, reason = 'manual_test', requestedRunAt = null }) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['customer', 'items.data.price', 'default_payment_method']
  });

  if (!isLiveAutopaySubscription(subscription)) {
    throw new Error('Only active auto-pay subscriptions can receive custom scheduled renewals.');
  }

  const customerId = getStripeResourceId(subscription.customer);
  if (!customerId) {
    throw new Error('Subscription is missing a Stripe customer.');
  }

  let paymentMethodId = getStripeResourceId(subscription.default_payment_method);
  if (!paymentMethodId) {
    const customer = await stripe.customers.retrieve(customerId);
    paymentMethodId = typeof customer === 'object' && !customer.deleted
      ? getStripeResourceId(customer.invoice_settings?.default_payment_method)
      : null;
  }

  if (!paymentMethodId) {
    throw new Error('No saved ACH payment method is attached to this subscription.');
  }

  await ensureUsBankAccountPaymentMethod(paymentMethodId);

  const recurringPrice = subscription.items?.data?.[0]?.price;
  const unitAmount = recurringPrice?.unit_amount ?? 0;
  if (!unitAmount || unitAmount <= 0) {
    throw new Error('Subscription amount is invalid for a custom auto-pay renewal.');
  }

  const currency = recurringPrice?.currency || 'usd';
  const propertyAddress = subscription.metadata?.propertyAddress || 'Monthly Rent';
  const landlordAccountId = subscription.transfer_data?.destination || subscription.metadata?.landlordAccountId || null;
  const applicationFeeAmount = Math.round(unitAmount * 0.02);
  const executedAt = new Date();
  const executedAtIso = executedAt.toISOString();
  const executedTimestamp = Math.floor(executedAt.getTime() / 1000);
  const metadata = {
    ...subscription.metadata,
    autopayCustomSchedule: 'true',
    autopayCustomScheduleReason: reason,
    autopayCustomScheduledFor: requestedRunAt || '',
    sourceSubscriptionId: subscription.id
  };

  await stripe.invoiceItems.create({
    customer: customerId,
    subscription: subscription.id,
    amount: unitAmount,
    currency,
    description: `Custom Auto-Pay Renewal - ${propertyAddress}`,
    metadata,
    period: {
      start: executedTimestamp,
      end: executedTimestamp
    }
  });

  let invoice = await stripe.invoices.create({
    customer: customerId,
    subscription: subscription.id,
    collection_method: 'charge_automatically',
    auto_advance: false,
    default_payment_method: paymentMethodId,
    description: `Custom Auto-Pay Renewal - ${propertyAddress}`,
    metadata,
    ...(landlordAccountId ? { transfer_data: { destination: String(landlordAccountId) } } : {}),
    ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {})
  });

  invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
  invoice = await stripe.invoices.pay(invoice.id, {
    off_session: true,
    payment_method: paymentMethodId
  });

  return {
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    paymentIntentId: getStripeResourceId(invoice.payment_intent),
    requestedRunAt,
    executedAt: executedAtIso,
    scheduledAmount: unitAmount / 100,
    amountDue: (invoice.amount_due || 0) / 100,
    amountPaid: (invoice.amount_paid || 0) / 100,
    currency,
    stripeMode: isStripeTestMode() ? 'test' : 'live',
    status: invoice.status || 'open',
    nextPaymentAttempt: invoice.next_payment_attempt
      ? new Date(invoice.next_payment_attempt * 1000).toISOString()
      : null
  };
}

function scheduleAutopayTestRenewal({ subscriptionId, runAt, reason = 'scheduled_test' }) {
  const runDate = new Date(runAt);
  if (Number.isNaN(runDate.getTime())) {
    throw new Error('runAt must be a valid ISO timestamp.');
  }

  const delayMs = runDate.getTime() - Date.now();
  if (delayMs <= 0) {
    throw new Error('Custom auto-pay renewal times must be in the future.');
  }

  if (delayMs > MAX_AUTOPAY_TEST_SCHEDULE_MS) {
    throw new Error('Custom auto-pay renewal times must be within the next 24 hours.');
  }

  const job = {
    id: randomUUID(),
    subscriptionId,
    reason,
    runAt: runDate.toISOString(),
    scheduledAt: new Date().toISOString(),
    status: 'scheduled',
    executedAt: null,
    result: null,
    error: null,
    timer: null
  };

  TEST_AUTOPAY_RENEWAL_JOBS.set(job.id, job);
  armScheduledAutopayRenewalJob(job);
  return serializeAutopayTestJob(job);
}

restorePersistedAutopayRenewalJobs();

function createStripeShadowSummary(enabled = true, postingMode = 'shadow') {
  return {
    enabled,
    postingMode,
    evaluated: 0,
    supported: 0,
    posted: 0,
    duplicates: 0,
    notConfigured: 0,
    unsupported: 0,
    pendingMatch: 0,
    failed: 0,
    comparisonMatched: 0,
    comparisonMismatched: 0,
    issues: []
  };
}

function pushStripeShadowIssue(summary, issue) {
  if (!summary?.enabled) {
    return;
  }

  if (summary.issues.length < 25) {
    summary.issues.push(issue);
  }
}

function summarizeStripeShadow(summary) {
  if (!summary?.enabled) {
    return { enabled: false };
  }

  const { issues, ...rest } = summary;
  return issues.length > 0 ? { ...rest, issues } : rest;
}

function recordStripePostingOutcome(result, errors, transactionId, context = {}) {
  const status = result?.status || 'failed';

  switch (status) {
    case 'posted':
      return { imported: 1, skipped: 0 };
    case 'duplicate':
    case 'pending_match':
    case 'pending_review':
    case 'unsupported':
    case 'disabled':
      return { imported: 0, skipped: 1 };
    case 'not_configured':
    case 'failed':
    default:
      errors.push({
        transaction: transactionId,
        ...context,
        error: result?.error || result?.reason || `Canonical ledger posting returned status ${status}`
      });
      return { imported: 0, skipped: 1 };
  }
}

async function runStripeShadowPosting({
  summary,
  candidate,
  legacyAccountCode,
  legacyIsDebit,
  legacyMemo,
  postedBy,
  idempotencyScope = 'stripe-shadow',
  transactionId
}) {
  if (!summary?.enabled) {
    return { ok: true, status: 'disabled' };
  }

  const postingMode = summary?.postingMode === 'live' ? 'live' : 'shadow';
  summary.evaluated += 1;

  if (!candidate?.ok) {
    if (candidate?.status === 'pending_match') {
      summary.pendingMatch += 1;
      try {
        const stagedResult = await stagePendingMatchToAzure({
          sourceEvent: candidate.sourceEvent,
          pendingMatchInput: {
            ...candidate.pendingMatchInput,
            metadata: {
              ...(candidate.pendingMatchInput?.metadata || {}),
              shadowMode: postingMode === 'shadow',
              postingMode
            }
          },
          suggestedMatch: candidate.suggestedMatch,
          reason: candidate.reason,
          postedBy
        });

        if (stagedResult.status === 'duplicate') {
          summary.duplicates += 1;
        }

        if (stagedResult.status === 'not_configured') {
          summary.notConfigured += 1;
        }

        pushStripeShadowIssue(summary, {
          transactionId,
          status: candidate.status,
          reason: candidate.reason,
          suggestedMatch: candidate.suggestedMatch || null,
          stagedResult
        });

        return stagedResult;
      } catch (error) {
        summary.failed += 1;
        pushStripeShadowIssue(summary, {
          transactionId,
          status: 'failed',
          error: error.message,
          reason: candidate.reason,
          suggestedMatch: candidate.suggestedMatch || null
        });
        return {
          ok: false,
          status: 'failed',
          error: error.message
        };
      }
    } else {
      summary.unsupported += 1;
      pushStripeShadowIssue(summary, {
        transactionId,
        status: candidate?.status || 'unsupported',
        reason: candidate?.reason || 'Transaction is not mapped into the canonical shadow path yet.',
        suggestedMatch: candidate?.suggestedMatch || null
      });
    }
    return candidate;
  }

  try {
    summary.supported += 1;
    const journalDraft = buildJournalDraftFromFinanceEvent(candidate.financeEventInput);
    const comparison = compareLegacyPostingToCanonicalDraft({
      draft: journalDraft,
      legacyAccountCode,
      legacyIsDebit,
      legacyMemo
    });

    const hasMismatch = [comparison.accountMatchStatus, comparison.directionMatchStatus, comparison.memoMatchStatus]
      .some((status) => status === 'mismatch');

    if (hasMismatch) {
      summary.comparisonMismatched += 1;
      pushStripeShadowIssue(summary, {
        transactionId,
        status: 'comparison_mismatch',
        comparison
      });
    } else {
      summary.comparisonMatched += 1;
    }

    const postJournal = postingMode === 'shadow' ? postJournalDraftShadowToAzure : postJournalDraftToAzure;
    const shadowResult = await postJournal({
      sourceEvent: candidate.sourceEvent,
      financeEventInput: {
        ...candidate.financeEventInput,
        metadata: {
          ...candidate.financeEventInput.metadata,
          legacyComparison: comparison,
          shadowMode: postingMode === 'shadow',
          postingMode
        }
      },
      journalDraft,
      postedBy,
      idempotencyScope
    });

    switch (shadowResult.status) {
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
        break;
    }

    return {
      ...shadowResult,
      comparison
    };
  } catch (error) {
    summary.failed += 1;
    pushStripeShadowIssue(summary, {
      transactionId,
      status: 'failed',
      error: error.message
    });
    return {
      ok: false,
      status: 'failed',
      error: error.message
    };
  }
}

const RENTAL_ANALYTICS_CATEGORIES = {
  RENTAL_INCOME: { direction: 'income', rollup: 'monthlyRent' },
  OTHER_INCOME: { direction: 'income', rollup: 'otherIncome' },
  LATE_FEE: { direction: 'income', rollup: 'otherIncome' },
  SECURITY_DEPOSIT: { direction: 'ignore', rollup: null },
  TRANSFER: { direction: 'ignore', rollup: null },
  MORTGAGE_PAYMENT: { direction: 'expense', rollup: 'mortgage' },
  PROPERTY_TAX: { direction: 'expense', rollup: 'taxes' },
  INSURANCE: { direction: 'expense', rollup: 'insurance' },
  UTILITIES: { direction: 'expense', rollup: 'utilities' },
  HOA: { direction: 'expense', rollup: 'hoa' },
  PROPERTY_MANAGEMENT: { direction: 'expense', rollup: 'management' },
  REPAIRS_MAINTENANCE: { direction: 'expense', rollup: 'repairsCapEx' },
  LANDSCAPING: { direction: 'expense', rollup: 'repairsCapEx' },
  PEST_CONTROL: { direction: 'expense', rollup: 'repairsCapEx' },
  SUPPLIES: { direction: 'expense', rollup: 'repairsCapEx' },
  LEGAL_PROFESSIONAL: { direction: 'expense', rollup: 'repairsCapEx' },
  CAPEX: { direction: 'expense', rollup: 'repairsCapEx' },
  OTHER_EXPENSE: { direction: 'expense', rollup: 'repairsCapEx' }
};

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.map(v => Number(v || 0)).sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function extractTextFromClaudeResponse(response) {
  return (response?.content || [])
    .filter(part => part?.type === 'text')
    .map(part => part.text)
    .join('\n');
}

function parseJsonArray(text) {
  if (!text) return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return null;
  return JSON.parse(arrayMatch[0]);
}

function getMonthKey(date) {
  return String(date || '').slice(0, 7);
}

function getMonthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return monthKey;
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  });
}

function getQuarterlyGrowthPercent(firstPeriod, lastPeriod) {
  if (!firstPeriod || !lastPeriod || firstPeriod <= 0) return 0;
  return ((lastPeriod / firstPeriod) - 1) * 100;
}

function buildUpcomingBills({ mortgagePayment, hoaMonthly, insuranceMonthly, quarterlyTaxAmount }) {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const quarterEndMonth = Math.floor(nextMonth.getMonth() / 3) * 3 + 2;
  const quarterDueDate = new Date(nextMonth.getFullYear(), quarterEndMonth, 10);

  return [
    { description: 'Mortgage Payment', dueDate: new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1).toISOString(), amount: roundCurrency(mortgagePayment) },
    { description: 'HOA Dues', dueDate: new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 5).toISOString(), amount: roundCurrency(hoaMonthly) },
    { description: 'Landlord Insurance', dueDate: new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 8).toISOString(), amount: roundCurrency(insuranceMonthly) },
    { description: 'Property Tax Installment', dueDate: quarterDueDate.toISOString(), amount: roundCurrency(quarterlyTaxAmount) }
  ].filter(item => item.amount > 0);
}

function calculateLoanStateFromAttom(originalAmount, annualRate, termMonths, loanDate) {
  if (!originalAmount || !annualRate || !termMonths || !loanDate) {
    return {
      originalAmount: Number(originalAmount || 0),
      currentBalance: Number(originalAmount || 0),
      remainingTermMonths: Number(termMonths || 0),
      monthlyPayment: 0,
      annualDebtService: 0,
      monthsElapsed: 0
    };
  }

  const monthlyRate = annualRate / 100 / 12;
  const startDate = new Date(loanDate);
  const now = new Date();
  const monthsElapsed = Math.max(0, Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
  const cappedElapsed = Math.min(monthsElapsed, termMonths);
  const remainingTermMonths = Math.max(termMonths - cappedElapsed, 0);

  if (monthlyRate <= 0) {
    const currentBalance = remainingTermMonths > 0
      ? originalAmount * (remainingTermMonths / termMonths)
      : 0;
    const monthlyPayment = termMonths > 0 ? originalAmount / termMonths : 0;
    return {
      originalAmount,
      currentBalance,
      remainingTermMonths,
      monthlyPayment,
      annualDebtService: monthlyPayment * 12,
      monthsElapsed: cappedElapsed
    };
  }

  const onePlusR = 1 + monthlyRate;
  const monthlyPayment = (monthlyRate * originalAmount) / (1 - Math.pow(onePlusR, -termMonths));
  const currentBalance = cappedElapsed >= termMonths
    ? 0
    : originalAmount * Math.pow(onePlusR, cappedElapsed) - monthlyPayment * ((Math.pow(onePlusR, cappedElapsed) - 1) / monthlyRate);

  return {
    originalAmount,
    currentBalance: Math.max(0, currentBalance),
    remainingTermMonths,
    monthlyPayment,
    annualDebtService: monthlyPayment * 12,
    monthsElapsed: cappedElapsed
  };
}

function categorizeRentalTransactionHeuristically(transaction) {
  const text = `${transaction.description || ''} ${transaction.vendor || ''}`.toLowerCase();

  if (/transfer|internal transfer|zelle to self|venmo cashout|credit card payment/.test(text)) return 'TRANSFER';
  if (/security deposit/.test(text)) return 'SECURITY_DEPOSIT';
  if (/late fee/.test(text)) return 'LATE_FEE';
  if (/rent|stripe payout|tenant/.test(text) && Number(transaction.amount) > 0) return 'RENTAL_INCOME';
  if (/mortgage|home mortgage|prosperity/.test(text)) return 'MORTGAGE_PAYMENT';
  if (/tax|county tax/.test(text)) return 'PROPERTY_TAX';
  if (/insurance|travelers|state farm|allstate/.test(text)) return 'INSURANCE';
  if (/hoa|association/.test(text)) return 'HOA';
  if (/water|sewer|pepco|duke|utility|electric|gas|internet/.test(text)) return 'UTILITIES';
  if (/landscap|lawn|yard|snow/.test(text)) return 'LANDSCAPING';
  if (/pest|terminix/.test(text)) return 'PEST_CONTROL';
  if (/manage|property management/.test(text)) return 'PROPERTY_MANAGEMENT';
  if (/legal|attorney|cpa|accounting/.test(text)) return 'LEGAL_PROFESSIONAL';
  if (/paint|roof|gutter|hvac|plumb|repair|maintenance|appliance|service|drywall/.test(text)) return 'REPAIRS_MAINTENANCE';
  if (/home depot|lowe|supply|hardware/.test(text)) return 'SUPPLIES';

  return Number(transaction.amount) > 0 ? 'OTHER_INCOME' : 'OTHER_EXPENSE';
}

async function categorizeRentalTransactionsWithClaude(transactions) {
  const fallback = transactions.map((transaction, index) => ({
    ...transaction,
    aiCategory: categorizeRentalTransactionHeuristically(transaction),
    aiReason: 'Heuristic fallback categorization',
    aiConfidence: 0.65,
    aiProvider: 'heuristic'
  }));

  if (!anthropic) {
    return { categorizedTransactions: fallback, provider: 'heuristic' };
  }

  const chunkSize = 50;
  const categorizedTransactions = [];

  for (let start = 0; start < transactions.length; start += chunkSize) {
    const chunk = transactions.slice(start, start + chunkSize);
    const transactionList = chunk.map((transaction, index) => {
      const signedAmount = Number(transaction.amount || 0);
      const direction = signedAmount >= 0 ? 'credit' : 'debit';
      return `${index + 1}. ${transaction.date} | ${direction} | ${signedAmount.toFixed(2)} | ${transaction.description}${transaction.vendor ? ` | ${transaction.vendor}` : ''}`;
    }).join('\n');

    const prompt = `Categorize each rental property bank transaction into exactly one category.

Allowed categories:
- RENTAL_INCOME: recurring rent payments from tenants
- OTHER_INCOME: non-rent property income
- LATE_FEE: late fees or lease fees
- SECURITY_DEPOSIT: refundable deposits that should not hit projections
- TRANSFER: owner transfers, credit card payments, or non-operating movements
- MORTGAGE_PAYMENT: mortgage or debt service payment
- PROPERTY_TAX: county or municipal property taxes
- INSURANCE: landlord insurance premiums
- UTILITIES: owner-paid electric, gas, water, sewer, internet, trash
- HOA: condo/HOA/association dues
- PROPERTY_MANAGEMENT: third-party management fees
- REPAIRS_MAINTENANCE: repair or maintenance work
- LANDSCAPING: lawn, snow, exterior grounds care
- PEST_CONTROL: pest treatment or prevention
- SUPPLIES: hardware, paint, small supplies
- LEGAL_PROFESSIONAL: legal, accounting, bookkeeping, permits
- CAPEX: larger one-time improvements or capital items
- OTHER_EXPENSE: real property expense that does not fit above

Return only a JSON array. Each item must be:
{"index":1,"category":"RENTAL_INCOME","confidence":0.98,"reason":"Tenant rent deposit"}

Transactions:
${transactionList}`;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        temperature: 0,
        system: 'You are a real-estate bookkeeping analyst. Respond with valid JSON only.',
        messages: [{ role: 'user', content: prompt }]
      });

      const parsed = parseJsonArray(extractTextFromClaudeResponse(response));
      if (!Array.isArray(parsed)) {
        throw new Error('Claude did not return a JSON array');
      }

      parsed.forEach((item) => {
        const original = chunk[(item.index || 1) - 1];
        if (!original) return;
        categorizedTransactions.push({
          ...original,
          aiCategory: RENTAL_ANALYTICS_CATEGORIES[item.category] ? item.category : categorizeRentalTransactionHeuristically(original),
          aiReason: item.reason || 'Claude categorization',
          aiConfidence: Number(item.confidence || 0.8),
          aiProvider: 'claude'
        });
      });
    } catch (error) {
      console.error('[Rental Analytics] Claude categorization failed, using heuristics for chunk:', error.message);
      chunk.forEach((transaction) => {
        categorizedTransactions.push({
          ...transaction,
          aiCategory: categorizeRentalTransactionHeuristically(transaction),
          aiReason: 'Heuristic fallback after Claude failure',
          aiConfidence: 0.65,
          aiProvider: 'heuristic'
        });
      });
    }
  }

  const seenIds = new Set(categorizedTransactions.map(transaction => transaction.id));
  transactions.forEach((transaction) => {
    if (seenIds.has(transaction.id)) return;
    categorizedTransactions.push({
      ...transaction,
      aiCategory: categorizeRentalTransactionHeuristically(transaction),
      aiReason: 'Heuristic fallback for uncategorized transaction',
      aiConfidence: 0.6,
      aiProvider: 'heuristic'
    });
  });

  return {
    categorizedTransactions,
    provider: categorizedTransactions.some(transaction => transaction.aiProvider === 'claude') ? 'claude' : 'heuristic'
  };
}

function deriveRentalProjectionPayload(propertyProfile, categorizedTransactions, provider) {
  const monthsCovered = Array.from(new Set(categorizedTransactions.map(transaction => getMonthKey(transaction.date)).filter(Boolean))).sort();
  const monthCount = Math.max(monthsCovered.length, 1);

  const rollups = {
    monthlyRent: 0,
    otherIncome: 0,
    mortgage: 0,
    taxes: 0,
    insurance: 0,
    utilities: 0,
    hoa: 0,
    management: 0,
    repairsCapEx: 0
  };

  const monthlyRentByMonth = new Map();
  const stableRecurringExpensesByMonth = new Map();
  const incomeByMonth = new Map();
  const expenseByMonth = new Map();

  const stableRecurringExpenseCategories = new Set([
    'INSURANCE',
    'UTILITIES',
    'HOA',
    'PROPERTY_MANAGEMENT'
  ]);

  categorizedTransactions.forEach((transaction) => {
    const categoryConfig = RENTAL_ANALYTICS_CATEGORIES[transaction.aiCategory] || RENTAL_ANALYTICS_CATEGORIES.OTHER_EXPENSE;
    const rawAmount = Number(transaction.amount || 0);
    const absoluteAmount = Math.abs(rawAmount);
    const monthKey = getMonthKey(transaction.date);

    if (categoryConfig.direction === 'ignore') return;

    if (categoryConfig.direction === 'income') {
      incomeByMonth.set(monthKey, (incomeByMonth.get(monthKey) || 0) + absoluteAmount);
      if (transaction.aiCategory === 'RENTAL_INCOME') {
        monthlyRentByMonth.set(monthKey, (monthlyRentByMonth.get(monthKey) || 0) + absoluteAmount);
      }
    } else {
      expenseByMonth.set(monthKey, (expenseByMonth.get(monthKey) || 0) + absoluteAmount);
      if (stableRecurringExpenseCategories.has(transaction.aiCategory)) {
        stableRecurringExpensesByMonth.set(monthKey, (stableRecurringExpensesByMonth.get(monthKey) || 0) + absoluteAmount);
      }
    }

    if (categoryConfig.rollup && Object.prototype.hasOwnProperty.call(rollups, categoryConfig.rollup)) {
      rollups[categoryConfig.rollup] += absoluteAmount;
    }
  });

  const rentSeries = Array.from(monthlyRentByMonth.values()).filter(Boolean);
  const firstQuarterRent = average(rentSeries.slice(0, Math.min(3, rentSeries.length)));
  const lastQuarterRent = average(rentSeries.slice(-Math.min(3, rentSeries.length)));
  const recurringExpenseSeries = Array.from(stableRecurringExpensesByMonth.values()).filter(Boolean);
  const firstHalfExpenses = average(recurringExpenseSeries.slice(0, Math.max(1, Math.floor(recurringExpenseSeries.length / 2))));
  const lastHalfExpenses = average(recurringExpenseSeries.slice(-Math.max(1, Math.floor(recurringExpenseSeries.length / 2))));

  const attomData = propertyProfile.attomData || {};
  const dashboard = propertyProfile.dashboard || {};
  const defaults = propertyProfile.defaults || {};
  const attomMortgageAmount = Number(attomData?.mortgage?.amount) || 0;
  const attomInterestRate = Number(attomData?.mortgage?.rate) || 0;
  const attomLoanTerm = Number(attomData?.mortgage?.term) || 360;
  const attomLoanDate = attomData?.mortgage?.date || null;
  const loanState = calculateLoanStateFromAttom(
    attomMortgageAmount,
    attomInterestRate,
    attomLoanTerm,
    attomLoanDate
  );

  const monthlyRent = roundCurrency(median(rentSeries) || attomData?.rentalAvm?.amount?.value || dashboard?.summary?.rental_avm || 0);
  const otherIncome = roundCurrency((rollups.otherIncome || 0) / monthCount);
  const mortgagePaymentObserved = roundCurrency((rollups.mortgage || 0) / monthCount);
  const mortgagePayment = roundCurrency(loanState.monthlyPayment || mortgagePaymentObserved);
  const insuranceAnnual = roundCurrency((rollups.insurance / monthCount) * 12);
  const utilitiesAnnual = roundCurrency((rollups.utilities / monthCount) * 12);
  const hoaAnnual = roundCurrency((rollups.hoa / monthCount) * 12);
  const repairsAnnual = roundCurrency((rollups.repairsCapEx / monthCount) * 12);
  const managementPct = roundCurrency((rollups.management > 0 && rollups.monthlyRent + rollups.otherIncome > 0)
    ? ((rollups.management / Math.max(rollups.monthlyRent + rollups.otherIncome, 1)) * 100)
    : 0);

  const taxHistory = Array.isArray(dashboard.tax_history) ? dashboard.tax_history : [];
  const currentTaxAmount = Number(attomData?.assessment?.tax?.taxAmt) || Number(taxHistory[taxHistory.length - 1]?.tax_amount) || 0;
  const firstTaxAmount = Number(taxHistory[0]?.tax_amount) || currentTaxAmount;
  const taxInflation = taxHistory.length > 1 && firstTaxAmount > 0
    ? clamp((((currentTaxAmount / firstTaxAmount) ** (1 / (taxHistory.length - 1))) - 1) * 100, 1, 8)
    : Number(defaults.taxInflation || 3);

  const vacancyRate = roundCurrency(clamp(
    rentSeries.length < monthCount
      ? ((monthCount - rentSeries.length) / monthCount) * 100
      : Number(defaults.vacancyRate || 0),
    0,
    15
  ));

  const rentGrowth = roundCurrency(clamp(
    getQuarterlyGrowthPercent(firstQuarterRent, lastQuarterRent) || Number(defaults.rentGrowth || 3),
    -5,
    10
  ));

  const defaultExpenseInflation = Number(defaults.expenseInflation || 3);
  const observedExpenseTrend = recurringExpenseSeries.length >= 6 && firstHalfExpenses > 0 && lastHalfExpenses > 0
    ? getQuarterlyGrowthPercent(firstHalfExpenses, lastHalfExpenses)
    : null;
  const expenseInflation = roundCurrency(clamp(
    observedExpenseTrend != null
      ? (defaultExpenseInflation * 0.7) + (observedExpenseTrend * 0.3)
      : defaultExpenseInflation,
    1,
    6
  ));

  const salePrice = Number(attomData?.saleHistory?.[0]?.salePrice) || Number(dashboard?.summary?.last_sale_price) || 0;
  const avmValue = Number(attomData?.avm?.amount?.value) || Number(dashboard?.summary?.avm_value) || 0;
  const defaultAppreciationRate = Number(defaults.appreciationRate || 0);
  const attomAnnualAppreciation = Number(attomData?.avm?.changeLastYear || 0);
  const appreciationRate = roundCurrency(clamp(
    defaultAppreciationRate > 0
      ? defaultAppreciationRate
      : attomAnnualAppreciation || 3,
    1,
    6
  ));

  const downPayment = roundCurrency(Math.max(salePrice - attomMortgageAmount, 0));
  const financialInputs = {
    monthlyRent,
    otherIncome,
    vacancyRate,
    rentGrowth,
    insurance: insuranceAnnual,
    utilities: utilitiesAnnual,
    hoa: hoaAnnual,
    repairsCapEx: repairsAnnual,
    managementPct,
    expenseInflation,
    taxInflation,
    interestRate: attomInterestRate,
    loanTerm: attomLoanTerm,
    isInterestOnly: Boolean(defaults.isInterestOnly),
    extraPrincipal: Number(defaults.extraPrincipal || 0),
    downPayment,
    closingCosts: Number(defaults.closingCosts || 0),
    initialRehab: Number(defaults.initialRehab || 0),
    appreciationRate,
    originalLoanAmount: attomMortgageAmount,
    currentLoanBalance: roundCurrency(loanState.currentBalance),
    remainingLoanTermMonths: loanState.remainingTermMonths,
    loanOriginationDate: attomLoanDate,
    monthlyDebtService: mortgagePayment
  };

  const expenseCategories = Object.keys(RENTAL_ANALYTICS_CATEGORIES)
    .filter(category => RENTAL_ANALYTICS_CATEGORIES[category].direction === 'expense')
    .map((category) => {
      const categoryTransactions = categorizedTransactions.filter(transaction => transaction.aiCategory === category);
      const totalAmount = roundCurrency(categoryTransactions.reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0));
      return {
        category,
        totalAmount,
        monthlyAverage: roundCurrency(totalAmount / monthCount),
        transactionCount: categoryTransactions.length,
        percentage: 0
      };
    })
    .filter(category => category.totalAmount > 0)
    .sort((a, b) => b.totalAmount - a.totalAmount);

  const totalExpenseAmount = expenseCategories.reduce((sum, category) => sum + category.totalAmount, 0);
  expenseCategories.forEach((category) => {
    category.percentage = totalExpenseAmount > 0 ? roundCurrency((category.totalAmount / totalExpenseAmount) * 100) : 0;
  });

  const incomeCategories = ['RENTAL_INCOME', 'OTHER_INCOME', 'LATE_FEE']
    .map((category) => {
      const categoryTransactions = categorizedTransactions.filter(transaction => transaction.aiCategory === category);
      const totalAmount = roundCurrency(categoryTransactions.reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0));
      return {
        category,
        totalAmount,
        monthlyAverage: roundCurrency(totalAmount / monthCount),
        transactionCount: categoryTransactions.length,
        percentage: 0
      };
    })
    .filter(category => category.totalAmount > 0)
    .sort((a, b) => b.totalAmount - a.totalAmount);

  const totalIncomeAmount = incomeCategories.reduce((sum, category) => sum + category.totalAmount, 0);
  incomeCategories.forEach((category) => {
    category.percentage = totalIncomeAmount > 0 ? roundCurrency((category.totalAmount / totalIncomeAmount) * 100) : 0;
  });

  const monthlyTrend = monthsCovered.map((monthKey) => {
    const income = roundCurrency(incomeByMonth.get(monthKey) || 0);
    const expenses = roundCurrency(expenseByMonth.get(monthKey) || 0);
    return {
      month: getMonthLabel(monthKey),
      income,
      expenses,
      cashFlow: roundCurrency(income - expenses)
    };
  });

  const bookkeepingTransactions = categorizedTransactions
    .filter(transaction => transaction.aiCategory !== 'TRANSFER')
    .map((transaction, index) => ({
      id: transaction.id || `sample-${index + 1}`,
      date: transaction.date,
      description: transaction.description,
      vendor: transaction.vendor || null,
      category: transaction.aiCategory,
      type: Number(transaction.amount || 0) >= 0 ? 'Income' : 'Expense',
      amount: roundCurrency(Math.abs(Number(transaction.amount || 0))),
      status: 'Cleared',
      source: transaction.source || 'SAMPLE',
      confidence: transaction.aiConfidence,
      aiReason: transaction.aiReason
    }));

  const calculationBreakdown = {
    valuation: {
      avm: avmValue,
      salePrice,
      appreciationRate,
      source: 'ATTOM'
    },
    income: {
      monthlyRent,
      rentMethod: 'Median of categorized RENTAL_INCOME transactions',
      monthlyOtherIncome: otherIncome,
      vacancyRate,
      rentGrowth
    },
    expenses: {
      annualInsurance: insuranceAnnual,
      annualUtilities: utilitiesAnnual,
      annualHoa: hoaAnnual,
      annualRepairsCapEx: repairsAnnual,
      annualTaxes: currentTaxAmount,
      managementPct,
      expenseInflation,
      taxInflation
    },
    financing: {
      originalLoanAmount: attomMortgageAmount,
      currentLoanBalance: roundCurrency(loanState.currentBalance),
      monthlyPayment: mortgagePayment,
      annualDebtService: roundCurrency(loanState.annualDebtService || mortgagePayment * 12),
      interestRate: attomInterestRate,
      originalTermMonths: attomLoanTerm,
      remainingTermMonths: loanState.remainingTermMonths,
      loanOriginationDate: attomLoanDate,
      downPayment,
      closingCosts: Number(defaults.closingCosts || 0),
      initialRehab: Number(defaults.initialRehab || 0),
      source: 'ATTOM mortgage + amortization to present day'
    },
    observedHistory: {
      monthsCovered: monthCount,
      annualIncomeObserved: roundCurrency(totalIncomeAmount),
      annualExpensesObserved: roundCurrency(totalExpenseAmount),
      annualCashFlowObserved: roundCurrency(totalIncomeAmount - totalExpenseAmount)
    }
  };

  return {
    property: propertyProfile.property,
    propertyDashboard: {
      ...dashboard,
      analyticsProjection: {
        financialInputs,
        summary: null,
        calculationBreakdown,
        aiProvider: provider
      }
    },
    financialInputs,
    aiProvider: provider,
    summary: {
      monthsCovered: monthCount,
      monthlyRent,
      monthlyOtherIncome: otherIncome,
      monthlyDebtService: mortgagePayment,
      monthlyOperatingExpenseTotal: roundCurrency((insuranceAnnual + utilitiesAnnual + hoaAnnual + repairsAnnual) / 12),
      monthlyPropertyTax: roundCurrency(currentTaxAmount / 12),
      monthlyCashFlowObserved: roundCurrency(average(monthlyTrend.map(month => month.cashFlow))),
      annualIncomeObserved: roundCurrency(totalIncomeAmount),
      annualExpensesObserved: roundCurrency(totalExpenseAmount),
      annualCashFlowObserved: roundCurrency(totalIncomeAmount - totalExpenseAmount),
      attomLoanAmount: attomMortgageAmount,
      attomCurrentLoanBalance: roundCurrency(loanState.currentBalance),
      attomMonthlyPayment: mortgagePayment,
      attomAvm: avmValue,
      attomTaxAmount: currentTaxAmount
    },
    calculationBreakdown,
    categorizedTransactions: bookkeepingTransactions,
    expenseCategories,
    incomeCategories,
    monthlyTrend,
    upcomingBills: buildUpcomingBills({
      mortgagePayment,
      hoaMonthly: hoaAnnual / 12,
      insuranceMonthly: insuranceAnnual / 12,
      quarterlyTaxAmount: currentTaxAmount / 4
    })
  };
}

/**
 * Map Stripe Financial Connections categories to Chart of Accounts codes
 * Stripe categories: https://stripe.com/docs/financial-connections/transactions
 */
const LEGACY_FINANCIAL_CONNECTIONS_ACCOUNT_CODE_MAP = {
  '4010': '4100',
  '4020': '4900',
  '5010': '5100',
  '5020': '5200',
  '5030': '5300',
  '5040': '5400',
  '5050': '5500',
  '5060': '5600',
  '5070': '6000',
  '5080': '5000',
  '5120': '5900',
};

const LEGACY_FINANCIAL_CONNECTIONS_SCHEDULE_E_LINE_MAP = {
  '4010': 4,
  '4020': 4,
  '5010': 17,
  '5020': 9,
  '5030': 16,
  '5040': 11,
  '5050': 12,
  '5060': 19,
  '5070': 5,
  '5080': 15,
  '5120': 10,
};

function normalizeFinancialConnectionsAccountCode(accountCode) {
  const normalized = String(accountCode || '').trim();
  if (!normalized) {
    return null;
  }

  return LEGACY_FINANCIAL_CONNECTIONS_ACCOUNT_CODE_MAP[normalized] || normalized;
}

function getFinancialConnectionsScheduleELine(accountCode) {
  const normalized = String(accountCode || '').trim();
  if (!normalized) {
    return null;
  }

  return LEGACY_FINANCIAL_CONNECTIONS_SCHEDULE_E_LINE_MAP[normalized] || null;
}

function mapStripeCategoryToAccountCode(stripeCategory) {
  const categoryMap = {
    // Income categories
    'income': '4900',           // Other Rental Income
    'income.paycheck': '4000',  // Could be rent payment
    'income.other': '4900',     // Other Income
    'income.interest': '4900',  // Interest Income
    'income.rental': '4000',    // Rent Income
    
    // Bank fees
    'bank_fees': '5999',        // Other Expenses
    'bank_fees.atm': '5999',
    'bank_fees.overdraft': '5999',
    
    // Entertainment (rarely applicable for rental)
    'entertainment': '5999',
    
    // Food/Dining (rarely applicable for rental)
    'food_and_drink': '5999',
    
    // Home improvements/supplies
    'home': '5000',             // Repairs & Maintenance
    'home.improvement': '5000',
    'home.maintenance': '5000',
    'home.services': '5000',
    
    // Insurance
    'insurance': '5200',        // Insurance
    
    // Loans/Mortgage
    'loan_payments': '5500',    // Mortgage Interest
    'loan_payments.mortgage': '5500',
    
    // Medical (not typically rental)
    'medical': '5999',
    
    // Government/Taxes
    'government_and_non_profit': '5300', // Property Taxes
    'government_and_non_profit.tax': '5300',
    
    // Services
    'service': '5000',          // Repairs & Maintenance
    'service.contractor': '5000',
    'service.utilities': '5100', // Utilities
    'service.legal': '5900',    // Legal Fees
    'service.professional': '5900',
    
    // Shops (supplies)
    'shops': '5000',            // Supplies
    'shops.hardware': '5000',   // Repairs
    
    // Transfer (no P&L impact)
    'transfer': null,           // Will be handled separately
    'transfer.internal': null,
    
    // Travel (rarely applicable)
    'travel': '5999',           // Other Expenses
    
    // Utilities
    'utilities': '5100',
    'utilities.electric': '5100',
    'utilities.gas': '5100',
    'utilities.water': '5100',
    'utilities.internet': '5100',
    'utilities.phone': '5100',
    
    // Default
    'uncategorized': '5999'     // Other Expenses
  };
  
  // Try exact match first
  if (categoryMap[stripeCategory]) {
    return categoryMap[stripeCategory];
  }
  
  // Try prefix match
  const prefix = stripeCategory?.split('.')[0];
  if (categoryMap[prefix]) {
    return categoryMap[prefix];
  }
  
  // Default to other expenses
  return '5999';
}

/**
 * POST /api/stripe-connect/create-account
 * Create a Stripe Connect account for a landlord with Financial Connections enabled
 */
router.post('/create-account', async (req, res) => {
  try {
    const { userId, email, propertyId } = req.body;

    if (!userId || !email) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId and email are required' 
      });
    }

    // Create Stripe Connect account (Express type for simplified onboarding)
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_type: 'individual',
      metadata: {
        userId: userId,
        propertyId: propertyId || ''
      }
    });

    // Store account information
    const accounts = readAccounts();
    if (!accounts[userId]) {
      accounts[userId] = {};
    }
    
    accounts[userId][account.id] = {
      accountId: account.id,
      email: email,
      propertyId: propertyId,
      createdAt: new Date().toISOString(),
      onboardingComplete: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      financialConnectionsEnabled: false
    };
    
    writeAccounts(accounts);

    res.json({
      ok: true,
      accountId: account.id,
      message: 'Stripe Connect account created successfully with Financial Connections enabled'
    });

    console.log('[Stripe Connect] Created account with Financial Connections for user:', userId);
  } catch (error) {
    console.error('[Stripe Connect] Error creating account:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/create-account-link
 * Create an account link for landlord onboarding
 */
router.post('/create-account-link', async (req, res) => {
  try {
    const { accountId } = req.body;

    if (!accountId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'accountId is required' 
      });
    }

    // Create account link for onboarding
    // Use PUBLIC_URL for production HTTPS support (required by Stripe livemode)
    const frontendUrl = process.env.PUBLIC_URL || 'http://localhost:5173';
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${frontendUrl}/portfolio?setup=refresh`,
      return_url: `${frontendUrl}/portfolio?setup=complete`,
      type: 'account_onboarding',
    });

    res.json({
      ok: true,
      url: accountLink.url
    });

    console.log('[Stripe Connect] Created account link for:', accountId);
  } catch (error) {
    console.error('[Stripe Connect] Error creating account link:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/create-financial-connections-session
 * Create a Financial Connections session to link bank account for transaction data
 */
router.post('/create-financial-connections-session', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId is required' 
      });
    }

    console.log('[Stripe Financial Connections] Creating Financial Connections session for user:', userId);

    // First, create or retrieve a Stripe Customer for this tenant
    let customer;
    try {
      // Try to find existing customer by metadata
      const customers = await stripe.customers.list({
        limit: 1,
        email: `tenant-${userId}@placeholder.com` // Use a placeholder email based on userId
      });

      if (customers.data.length > 0) {
        customer = customers.data[0];
        console.log('[Stripe Financial Connections] Using existing customer:', customer.id);
      } else {
        // Create new customer
        customer = await stripe.customers.create({
          email: `tenant-${userId}@placeholder.com`,
          metadata: {
            tenantId: userId,
            purpose: 'income-verification'
          }
        });
        console.log('[Stripe Financial Connections] Created new customer:', customer.id);
      }
    } catch (customerError) {
      console.error('[Stripe Financial Connections] Error with customer:', customerError);
      throw new Error('Failed to create/retrieve customer');
    }

    // Create a Financial Connections Session for tenant income verification
    // This allows tenants to connect their personal bank accounts for income analysis
    const session = await stripe.financialConnections.sessions.create({
      account_holder: {
        type: 'customer',
        customer: customer.id,
      },
      permissions: ['payment_method', 'balances', 'transactions', 'ownership'],
      filters: {
        countries: ['US'],
      },
    });

    console.log('[Stripe Financial Connections] Session created successfully:', session.id);

    res.json({
      ok: true,
      sessionId: session.id,
      clientSecret: session.client_secret,
      customerId: customer.id,
      message: 'Financial Connections session created successfully'
    });
  } catch (error) {
    console.error('[Stripe Financial Connections] Error creating session:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      details: 'Failed to create Financial Connections session.'
    });
  }
});

/**
 * GET /api/stripe-connect/accounts/:userId
 * Get all connected accounts for a landlord
 */
router.get('/accounts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const accounts = readAccounts();
    
    const userAccounts = accounts[userId] || {};
    
    // Fetch latest status from Stripe for each account
    const accountsWithStatus = await Promise.all(
      Object.entries(userAccounts).map(async ([accountId, accountData]) => {
        try {
          const account = await stripe.accounts.retrieve(accountId);
          
          return {
            accountId,
            email: accountData.email,
            propertyId: accountData.propertyId,
            createdAt: accountData.createdAt,
            onboardingComplete: account.details_submitted,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            country: account.country,
            defaultCurrency: account.default_currency,
            externalAccounts: account.external_accounts?.data?.map(ea => ({
              id: ea.id,
              bankName: ea.bank_name,
              last4: ea.last4,
              routingNumber: ea.routing_number
            })) || []
          };
        } catch (error) {
          console.error('[Stripe Connect] Error fetching account:', accountId, error);
          return {
            ...accountData,
            accountId,
            error: 'Failed to fetch account details'
          };
        }
      })
    );

    res.json({
      ok: true,
      accounts: accountsWithStatus
    });
  } catch (error) {
    console.error('[Stripe Connect] Error fetching accounts:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/check-financial-connections/:userId
 * Check if user has Financial Connections accounts
 */
router.get('/check-financial-connections/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Find the customer by email/userId
    const customers = await stripe.customers.list({
      limit: 1,
      email: `tenant-${userId}@placeholder.com`
    });

    if (customers.data.length === 0) {
      return res.json({
        ok: true,
        connected: false,
        message: 'No Financial Connections found'
      });
    }

    const customer = customers.data[0];

    // List all Financial Connections accounts for this customer
    const accounts = await stripe.financialConnections.accounts.list({
      account_holder: {
        customer: customer.id,
      },
      limit: 100,
    });

    if (accounts.data.length === 0) {
      return res.json({
        ok: true,
        connected: false,
        customerId: customer.id,
        message: 'No accounts connected'
      });
    }

    // Return account details
    const accountDetails = accounts.data.map(acc => ({
      id: acc.id,
      institutionName: acc.institution_name,
      displayName: acc.display_name,
      last4: acc.last4,
      status: acc.status,
      accountType: acc.account_holder?.type
    }));

    res.json({
      ok: true,
      connected: true,
      customerId: customer.id,
      accounts: accountDetails
    });

  } catch (error) {
    console.error('[Stripe Financial Connections] Error checking connections:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/financial-connections-transactions/:accountId
 * Get transactions for a specific Financial Connections account
 */
router.get('/financial-connections-transactions/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    console.log('[Stripe Financial Connections] Fetching transactions for account:', accountId);

    // Try to fetch transactions with error handling
    try {
      const transactions = await stripe.financialConnections.transactions.list({
        account: accountId,
        limit: limit,
      });

      // Format transactions
      const formattedTransactions = transactions.data.map(txn => ({
        id: txn.id,
        amount: Math.abs(txn.amount) / 100,
        currency: txn.currency || 'usd',
        description: txn.description || 'No description',
        date: new Date(txn.transacted_at * 1000).toISOString().split('T')[0],
        status: txn.status,
        type: txn.amount < 0 ? 'debit' : 'credit',
        category: txn.category || 'uncategorized',
        merchant: txn.merchant_name || null,
        pending: txn.status === 'pending',
      }));

      res.json({
        ok: true,
        transactions: formattedTransactions,
        count: formattedTransactions.length
      });

    } catch (txnError) {
      // Handle "no transactions to retrieve" error
      if (txnError.message && txnError.message.includes('no transactions to retrieve')) {
        return res.json({
          ok: true,
          transactions: [],
          syncing: true,
          message: 'Transaction data is being synchronized from your bank. This usually takes 2-3 minutes.'
        });
      }
      throw txnError;
    }

  } catch (error) {
    console.error('[Stripe Financial Connections] Error fetching transactions:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/disconnect-financial-connections
 * Disconnect Financial Connections for a user's bank account
 */
router.post('/disconnect-financial-connections', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId is required' 
      });
    }

    console.log('[Stripe Financial Connections] Disconnecting Financial Connections for user:', userId);

    // Find the customer by email/userId
    const customers = await stripe.customers.list({
      limit: 10,
      email: `tenant-${userId}@placeholder.com`
    });

    if (customers.data.length === 0) {
      return res.json({
        ok: true,
        message: 'No Financial Connections found for this user'
      });
    }

    const customer = customers.data[0];

    // List all Financial Connections accounts for this customer
    const accounts = await stripe.financialConnections.accounts.list({
      account_holder: {
        customer: customer.id,
      },
      limit: 100,
    });

    // Disconnect each account
    let disconnectedCount = 0;
    for (const account of accounts.data) {
      try {
        await stripe.financialConnections.accounts.disconnect(account.id);
        disconnectedCount++;
        console.log('[Stripe Financial Connections] Disconnected account:', account.id);
      } catch (disconnectError) {
        console.error('[Stripe Financial Connections] Error disconnecting account:', account.id, disconnectError);
      }
    }

    res.json({
      ok: true,
      message: `Successfully disconnected ${disconnectedCount} Financial Connections account(s)`,
      disconnectedCount
    });

  } catch (error) {
    console.error('[Stripe Financial Connections] Error disconnecting:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message || 'Failed to disconnect Financial Connections'
    });
  }
});

/**
 * POST /api/stripe-connect/create-payment-intent
 * Create a payment intent for tenant to pay landlord
 */
router.post('/create-payment-intent', async (req, res) => {
  try {
    const { accountId, amount, tenantEmail, tenantName, description, propertyAddress } = req.body;

    if (!accountId || !amount) {
      return res.status(400).json({ 
        ok: false, 
        error: 'accountId and amount are required' 
      });
    }

    // Create payment intent with application fee (platform fee)
    const applicationFeeAmount = Math.round(amount * 100 * 0.02); // 2% platform fee
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd',
      application_fee_amount: applicationFeeAmount,
      transfer_data: {
        destination: accountId,
      },
      metadata: {
        tenantEmail: tenantEmail || '',
        tenantName: tenantName || '',
        description: description || 'Rent Payment',
        propertyAddress: propertyAddress || ''
      },
      receipt_email: tenantEmail,
      description: description || 'Rent Payment'
    });

    res.json({
      ok: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });

    console.log('[Stripe Connect] Created payment intent:', paymentIntent.id);
  } catch (error) {
    console.error('[Stripe Connect] Error creating payment intent:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/create-checkout-session
 * Create a Stripe Checkout session for tenant payment (easier integration)
 */
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { accountId, amount, tenantEmail, tenantName, description, propertyAddress, propertyId, ownerId, tenantId } = req.body;

    if (!accountId || !amount) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Landlord has not connected their bank account yet. Please ask them to set up payment receiving first.' 
      });
    }

    // Application fee (2% platform fee)
    const applicationFeeAmount = Math.round(amount * 100 * 0.02);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    const session = await stripe.checkout.sessions.create(
      buildTenantCheckoutSessionParams({
        amount,
        tenantEmail,
        description,
        propertyAddress,
        successUrl: `${frontendUrl}/tenant/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${frontendUrl}/tenant/dashboard?payment=cancelled`,
        metadata: {
          tenantName: tenantName || '',
          tenantEmail: tenantEmail || '',
          propertyAddress: propertyAddress || '',
          propertyId: propertyId || '',
          ownerId: ownerId || '',
          tenantId: tenantId || '',
          landlordAccountId: accountId
        },
        paymentIntentData: {
          application_fee_amount: applicationFeeAmount,
          transfer_data: {
            destination: accountId
          },
          metadata: {
            tenantEmail: tenantEmail || '',
            tenantName: tenantName || '',
            propertyAddress: propertyAddress || '',
            propertyId: propertyId || '',
            ownerId: ownerId || '',
            tenantId: tenantId || '',
            landlordAccountId: accountId,
            description: description || 'Rent Payment'
          }
        }
      })
    );

    res.json({
      ok: true,
      url: session.url,
      sessionId: session.id
    });

    console.log('[Stripe Connect] Created checkout session:', session.id);
  } catch (error) {
    console.error('[Stripe Connect] Error creating checkout session:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/payment-status/:sessionId
 * Get payment status for a checkout session
 */
router.get('/payment-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await getExpandedCheckoutSession(sessionId);
    
    res.json({
      ok: true,
      status: session.payment_status,
      amountTotal: session.amount_total / 100,
      customerEmail: session.customer_email,
      metadata: session.metadata
    });
  } catch (error) {
    console.error('[Stripe Connect] Error fetching payment status:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/confirm-session
 * Called by the frontend on the success redirect to record the payment.
 * Works without a configured webhook secret.
 */
router.post('/confirm-session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Only record if actually paid or payment initiated (ACH = unpaid but intent created)
    if (session.status !== 'complete') {
      return res.json({ ok: true, recorded: false, reason: 'session not complete' });
    }

    const meta = session.metadata || {};
    const paymentStatus = session.payment_status === 'paid' ? 'completed' : 'pending';
    const transactionId = getStripeResourceId(session.payment_intent) || session.id;
    const paymentMethodType = await resolveCheckoutSessionPaymentMethodType(session);

    // Check if already recorded to avoid duplicates
    const { getFirestore } = await import('./firebase-admin.js');
    const db = getFirestore();
    const existing = await db.collection('tenantPayments')
      .where('transactionId', '==', transactionId)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.json({ ok: true, recorded: false, reason: 'already recorded', status: paymentStatus });
    }

    const result = await recordTenantPayment({
      tenantId: meta.tenantId || '',
      tenantEmail: meta.tenantEmail || session.customer_email || '',
      tenantName: meta.tenantName || '',
      ownerId: meta.ownerId || '',
      propertyId: meta.propertyId || '',
      propertyAddress: meta.propertyAddress || '',
      amount: (session.amount_total || 0) / 100,
      paymentMethod: paymentMethodType,
      transactionId,
      status: paymentStatus
    });

    console.log('[Stripe Connect] Confirmed session payment:', sessionId, 'status:', paymentStatus);

    // Send receipt email (non-blocking)
    const receiptEmail = meta.tenantEmail || session.customer_email;
    if (receiptEmail) {
      const amountFmt = `$${((session.amount_total || 0) / 100).toFixed(2)}`;
      const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const receiptUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment-receipt?session_id=${sessionId}`;
      const statusLabel = paymentStatus === 'completed' ? 'Paid' : 'Processing (ACH — typically 3–5 business days)';
      sendHtmlEmail({
        to: receiptEmail,
        subject: `Payment Receipt — ${amountFmt} Rent Payment`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#16a34a;padding:32px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:24px">Payment ${paymentStatus === 'completed' ? 'Received' : 'Processing'}</h1>
              <p style="color:#bbf7d0;margin:8px 0 0">${dateStr}</p>
            </div>
            <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;background:#fff">
              <p style="font-size:16px">Hi ${meta.tenantName || receiptEmail},</p>
              <p>Your rent payment has been ${paymentStatus === 'completed' ? 'received' : 'submitted and is being processed'}.</p>
              <table style="width:100%;border-collapse:collapse;margin:24px 0">
                <tr style="background:#f8fafc"><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb;width:45%">Amount</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;font-size:18px;font-weight:700;color:#16a34a">${amountFmt}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Property</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">${meta.propertyAddress || 'Your rental property'}</td></tr>
                <tr style="background:#f8fafc"><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Date</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">${dateStr}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Status</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">${statusLabel}</td></tr>
                <tr style="background:#f8fafc"><td style="padding:12px 16px;font-weight:600">Transaction ID</td><td style="padding:12px 16px;font-family:monospace;font-size:13px">${transactionId}</td></tr>
              </table>
              <div style="text-align:center;margin:32px 0">
                <a href="${receiptUrl}" style="background:#16a34a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">View Receipt</a>
              </div>
              <p style="font-size:13px;color:#6b7280">This is a confirmation that your payment was submitted. Please keep this email for your records.</p>
            </div>
          </div>
        `
      }).catch(e => console.error('[Stripe Connect] Receipt email failed:', e.message));
    }

    res.json({ ok: true, recorded: true, status: paymentStatus, paymentId: result.paymentId,
      receipt: {
        amount: (session.amount_total || 0) / 100,
        propertyAddress: meta.propertyAddress || '',
        tenantName: meta.tenantName || '',
        paymentMethod: paymentMethodType,
        status: paymentStatus,
        date: new Date().toISOString(),
        transactionId
      }
    });
  } catch (error) {
    console.error('[Stripe Connect] Error confirming session:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/stripe-connect/receipt/:sessionId
 * Returns full details for a payment receipt page.
 */
router.get('/receipt/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await getExpandedCheckoutSession(sessionId);
    const meta = session.metadata || {};
    const transactionId = getStripeResourceId(session.payment_intent) || session.id;
    const paymentMethodType = await resolveCheckoutSessionPaymentMethodType(session);
    const paymentStatus = session.payment_status === 'paid' ? 'completed' : 'pending';
    res.json({
      ok: true,
      amount: (session.amount_total || 0) / 100,
      status: paymentStatus,
      propertyAddress: meta.propertyAddress || '',
      tenantName: meta.tenantName || '',
      tenantEmail: meta.tenantEmail || session.customer_email || '',
      paymentMethod: paymentMethodType,
      date: new Date(session.created * 1000).toISOString(),
      transactionId
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/stripe-connect/disconnect/:userId/:accountId
 * Disconnect a Stripe account
 */
router.delete('/disconnect/:userId/:accountId', async (req, res) => {
  try {
    const { userId, accountId } = req.params;
    
    const accounts = readAccounts();
    
    if (!accounts[userId] || !accounts[userId][accountId]) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Account not found' 
      });
    }

    // Delete the Stripe account
    await stripe.accounts.del(accountId);

    // Remove from storage
    delete accounts[userId][accountId];
    if (Object.keys(accounts[userId]).length === 0) {
      delete accounts[userId];
    }
    writeAccounts(accounts);

    res.json({
      ok: true,
      message: 'Account disconnected successfully'
    });

    console.log('[Stripe Connect] Disconnected account:', accountId);
  } catch (error) {
    console.error('[Stripe Connect] Error disconnecting account:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/account-status/:accountId
 * Get detailed account status including requirements and capabilities
 */
router.get('/account-status/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    const account = await stripe.accounts.retrieve(accountId);

    res.json({
      ok: true,
      account: {
        id: account.id,
        email: account.email,
        details_submitted: account.details_submitted,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        requirements: {
          currently_due: account.requirements?.currently_due || [],
          eventually_due: account.requirements?.eventually_due || [],
          past_due: account.requirements?.past_due || [],
          pending_verification: account.requirements?.pending_verification || [],
          disabled_reason: account.requirements?.disabled_reason || null,
          errors: account.requirements?.errors || []
        },
        capabilities: account.capabilities,
        external_accounts: account.external_accounts?.data?.map(ea => ({
          id: ea.id,
          bank_name: ea.bank_name,
          last4: ea.last4,
          routing_number: ea.routing_number
        })) || []
      }
    });

    console.log('[Stripe Connect] Account status retrieved:', accountId);
  } catch (error) {
    console.error('[Stripe Connect] Error fetching account status:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/transactions/:accountId
 * Get balance transactions for a connected account (payments, fees, payouts)
 * Note: This shows Stripe platform transactions only (charges through your platform)
 * Use /bank-transactions endpoint for full bank account history via Financial Connections
 */
router.get('/transactions/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { limit = 100, starting_after, ending_before, type } = req.query;

    // Build query parameters
    const params = {
      limit: parseInt(limit),
    };

    if (starting_after) params.starting_after = starting_after;
    if (ending_before) params.ending_before = ending_before;
    if (type) params.type = type;

    // Fetch balance transactions for the connected account
    const transactions = await stripe.balanceTransactions.list(params, {
      stripeAccount: accountId
    });

    // Transform to a more readable format
    const formattedTransactions = transactions.data.map(txn => ({
      id: txn.id,
      amount: txn.amount / 100, // Convert from cents to dollars
      currency: txn.currency,
      description: txn.description,
      fee: txn.fee / 100,
      net: txn.net / 100,
      type: txn.type, // 'charge', 'payment', 'payout', etc.
      status: txn.status,
      created: txn.created,
      date: new Date(txn.created * 1000).toISOString().split('T')[0],
      source: txn.source,
      reporting_category: txn.reporting_category,
      available_on: txn.available_on ? new Date(txn.available_on * 1000).toISOString().split('T')[0] : null
    }));

    res.json({
      ok: true,
      transactions: formattedTransactions,
      has_more: transactions.has_more,
      note: 'These are Stripe platform transactions. Use /bank-transactions for full bank account history.'
    });

    console.log('[Stripe Connect] Retrieved', formattedTransactions.length, 'platform transactions for account:', accountId);
  } catch (error) {
    console.error('[Stripe Connect] Error fetching transactions:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/bank-transactions/:accountId
 * Get ALL bank account transactions via Stripe Financial Connections
 * This includes transactions from outside your platform (direct deposits, checks, other payments)
 */
router.get('/bank-transactions/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { limit = 100, starting_after, ending_before } = req.query;

    console.log('[Stripe Financial Connections] Fetching bank transactions for account:', accountId);

    // List all financial connections accounts for this Connect account
    // We don't pass stripeAccount in the list call, but need to retrieve the session
    const financialAccounts = await stripe.financialConnections.accounts.list({
      account_holder: {
        account: accountId,
      },
      limit: 10
    });

    console.log('[Stripe Financial Connections] Found', financialAccounts.data.length, 'financial accounts');

    if (financialAccounts.data.length === 0) {
      return res.json({
        ok: true,
        transactions: [],
        financial_connections_enabled: false,
        message: 'This account was not created with the required permissions (`transactions`) to perform this operation.',
        instructions: 'Click "Connect Bank Data" button to link your bank account and access full transaction history.'
      });
    }

    // Get the first financial connections account
    const financialAccount = financialAccounts.data[0];
    console.log('[Stripe Financial Connections] Using account:', financialAccount.id, 'Status:', financialAccount.status);

    // Check if transactions permission is available
    if (!financialAccount.permissions || !financialAccount.permissions.includes('transactions')) {
      return res.json({
        ok: true,
        transactions: [],
        financial_connections_enabled: false,
        message: 'This account was not created with the required permissions (`transactions`) to perform this operation.',
        instructions: 'You need to reconnect your bank account with transaction permissions enabled.'
      });
    }

    // Subscribe to transactions if not already subscribed
    try {
      await stripe.financialConnections.accounts.subscribe(
        financialAccount.id,
        { features: ['transactions'] }
      );
      console.log('[Stripe Financial Connections] Subscribed to transactions for account:', financialAccount.id);
    } catch (subscribeError) {
      // If already subscribed or other error, log but continue
      console.log('[Stripe Financial Connections] Subscribe result:', subscribeError.message);
    }

    // Refresh transactions to get the latest data
    try {
      await stripe.financialConnections.accounts.refresh(
        financialAccount.id,
        { features: ['transactions'] }
      );
      console.log('[Stripe Financial Connections] Refreshed transactions for account:', financialAccount.id);
    } catch (refreshError) {
      console.log('[Stripe Financial Connections] Refresh result:', refreshError.message);
    }

    // Fetch transactions from this financial account
    const txnParams = {
      limit: parseInt(limit),
      account: financialAccount.id
    };

    if (starting_after) txnParams.starting_after = starting_after;
    if (ending_before) txnParams.ending_before = ending_before;

    const fcTransactions = await stripe.financialConnections.transactions.list(txnParams);

    console.log('[Stripe Financial Connections] Retrieved', fcTransactions.data.length, 'transactions');

    // Format transactions to match our interface
    const formattedTransactions = fcTransactions.data.map(txn => ({
      id: txn.id,
      amount: Math.abs(txn.amount) / 100,
      currency: txn.currency || 'usd',
      description: txn.description || 'No description',
      date: new Date(txn.transacted_at * 1000).toISOString().split('T')[0],
      status: txn.status,
      type: txn.amount < 0 ? 'debit' : 'credit',
      category: txn.category || 'uncategorized',
      merchant: txn.merchant_name || null,
      pending: txn.status === 'pending',
      source: 'bank_account',
      transacted_at: txn.transacted_at
    }));

    res.json({
      ok: true,
      transactions: formattedTransactions,
      has_more: fcTransactions.has_more,
      financial_connections_enabled: true,
      account_name: financialAccount.display_name,
      institution: financialAccount.institution_name,
      last4: financialAccount.last4
    });

    console.log('[Stripe Financial Connections] Successfully returned', formattedTransactions.length, 'bank transactions');
  } catch (error) {
    console.error('[Stripe Financial Connections] Error fetching bank transactions:', error);
    
    // Check if this is the "no transactions to retrieve" error
    if (error.message && error.message.includes('no transactions to retrieve')) {
      return res.json({
        ok: true,
        transactions: [],
        financial_connections_enabled: true,
        message: 'Transaction data is being synchronized from your bank. This usually takes a few minutes.',
        instructions: 'Please wait 2-3 minutes and refresh the page. Stripe is fetching your transaction history from the bank.'
      });
    }
    
    // Check if this is a permissions error
    if (error.code === 'resource_missing' || error.message.includes('financial_connections') || error.message.includes('permissions')) {
      return res.json({
        ok: true,
        transactions: [],
        financial_connections_enabled: false,
        error: error.message,
        message: 'This account was not created with the required permissions (`transactions`) to perform this operation.',
        instructions: 'Click "Connect Bank Data" button and ensure you grant transaction access permissions during the bank connection process.'
      });
    }
    
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      details: 'Error accessing Financial Connections. The feature may not be enabled for this account.'
    });
  }
});

/**
 * POST /api/stripe-connect/sync-transactions
 * Sync Stripe transactions to bookkeeping system
 */
router.post('/sync-transactions', async (req, res) => {
  try {
    const { accountId, userId, propertyId, startDate, endDate, shadowMode = false } = req.body;

    if (!accountId || !userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'accountId and userId are required' 
      });
    }

    // Calculate date range
    const start = startDate ? new Date(startDate).getTime() / 1000 : Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    const end = endDate ? new Date(endDate).getTime() / 1000 : Math.floor(Date.now() / 1000);

    // Fetch all balance transactions in the date range
    let allTransactions = [];
    let hasMore = true;
    let lastId = null;

    while (hasMore && allTransactions.length < 500) {
      const params = {
        limit: 100,
        created: {
          gte: start,
          lte: end
        }
      };

      if (lastId) {
        params.starting_after = lastId;
      }

      const transactions = await stripe.balanceTransactions.list(params, {
        stripeAccount: accountId
      });

      allTransactions = allTransactions.concat(transactions.data);
      hasMore = transactions.has_more;
      
      if (transactions.data.length > 0) {
        lastId = transactions.data[transactions.data.length - 1].id;
      } else {
        hasMore = false;
      }
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];
    const postingMode = shadowMode === true ? 'shadow' : 'live';
    const shadowSummary = createStripeShadowSummary(true, postingMode);

    for (const txn of allTransactions) {
      try {
        // Categorize transaction type
        let accountCode = '1000'; // Default to Cash
        let memo = txn.description || 'Stripe transaction';
        let isDebit = txn.net >= 0;

        // Map Stripe transaction types to accounts
        switch (txn.type) {
          case 'charge':
          case 'payment':
            accountCode = '4000'; // Rent Income
            memo = `Payment received: ${txn.description || 'Rent payment'}`;
            isDebit = false; // Income is credit
            break;
          case 'payment_refund':
            accountCode = '4000';
            memo = `Refund issued: ${txn.description || 'Payment refund'}`;
            isDebit = true; // Refund is debit (reduces income)
            break;
          case 'payout':
            accountCode = '1000'; // Cash
            memo = `Payout to bank: ${txn.description || 'Bank payout'}`;
            isDebit = true; // Money out
            break;
          case 'stripe_fee':
          case 'application_fee':
            accountCode = '5110'; // Bank Fees
            memo = `Stripe fee: ${txn.description || 'Processing fee'}`;
            isDebit = true; // Expense
            break;
          default:
            memo = `Stripe ${txn.type}: ${txn.description || 'Transaction'}`;
        }

        const postingResult = await runStripeShadowPosting({
          summary: shadowSummary,
          candidate: buildStripeBalanceFinanceEvent(txn, { userId, propertyId }),
          legacyAccountCode: accountCode,
          legacyIsDebit: isDebit,
          legacyMemo: memo,
          postedBy: postingMode === 'shadow'
            ? `stripe-connect-shadow:${userId}`
            : `stripe-connect-canonical:${userId}`,
          idempotencyScope: 'stripe-shadow',
          transactionId: txn.id
        });
        const outcome = recordStripePostingOutcome(postingResult, errors, txn.id, {
          description: memo,
          source: 'stripe-balance-transaction'
        });
        imported += outcome.imported;
        skipped += outcome.skipped;

      } catch (err) {
        console.error('[Stripe Connect] Error processing transaction:', txn.id, err);
        errors.push({ transaction: txn.id, error: err.message });
        skipped++;
      }
    }

    res.json({
      ok: true,
      total: allTransactions.length,
      imported,
      skipped,
      shadowLedger: summarizeStripeShadow(shadowSummary),
      errors: errors.length > 0 ? errors : undefined,
      message: `Synced ${imported} transactions to the canonical bookkeeping ledger`
    });

    console.log('[Stripe Connect] Synced transactions:', {
      total: allTransactions.length,
      imported,
      skipped,
      ledger: {
        postingMode: shadowSummary.postingMode,
        posted: shadowSummary.posted,
        duplicates: shadowSummary.duplicates,
        pendingMatch: shadowSummary.pendingMatch,
        unsupported: shadowSummary.unsupported,
        failed: shadowSummary.failed,
        notConfigured: shadowSummary.notConfigured
      }
    });
  } catch (error) {
    console.error('[Stripe Connect] Error syncing transactions:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/sync-financial-connections-transactions
 * Sync Financial Connections bank transactions to bookkeeping system
 */
router.post('/sync-financial-connections-transactions', async (req, res) => {
  try {
    const { userId, customerId, accountId, propertyId, startDate, endDate, shadowMode = false } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId is required' 
      });
    }

    // Find the customer if not provided
    let customer = customerId;
    if (!customer) {
      const customers = await stripe.customers.list({
        limit: 1,
        email: `tenant-${userId}@placeholder.com`
      });

      if (customers.data.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          error: 'No Financial Connections found for this user' 
        });
      }

      customer = customers.data[0].id;
    }

    // List all Financial Connections accounts for this customer
    const accounts = await stripe.financialConnections.accounts.list({
      account_holder: {
        customer: customer,
      },
      limit: 100,
    });

    if (accounts.data.length === 0) {
      return res.json({ 
        ok: true,
        total: 0,
        imported: 0,
        skipped: 0,
        message: 'No Financial Connections accounts found' 
      });
    }

    // Use the provided accountId or the first available account
    const targetAccount = accountId 
      ? accounts.data.find(acc => acc.id === accountId) 
      : accounts.data[0];

    if (!targetAccount) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Financial Connections account not found' 
      });
    }

    console.log('[Stripe Financial Connections] Syncing transactions for account:', targetAccount.id);

    // Calculate date range (default to last 24 months for full history)
    // Stripe Financial Connections supports up to 24 months of historical data
    const defaultDaysBack = 730; // 24 months = ~730 days
    const start = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : Math.floor(Date.now() / 1000) - (defaultDaysBack * 24 * 60 * 60);
    const end = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : Math.floor(Date.now() / 1000);

    console.log('[Stripe Financial Connections] Date range:', new Date(start * 1000).toISOString(), 'to', new Date(end * 1000).toISOString());

    // Fetch transactions with proper error handling
    let allTransactions = [];
    let hasMore = true;
    let starting_after = null;

    try {
      // First, try to refresh/subscribe to transactions if needed
      try {
        await stripe.financialConnections.accounts.refresh(
          targetAccount.id,
          { features: ['transactions'] }
        );
        console.log('[Stripe Financial Connections] Transaction refresh initiated');
      } catch (refreshError) {
        // Refresh might fail if already subscribed, which is fine
        console.log('[Stripe Financial Connections] Refresh note:', refreshError.message);
      }

      while (hasMore && allTransactions.length < 500) {
        const txnParams = {
          account: targetAccount.id,
          limit: 100,
          transacted_at: {
            gte: start,
            lte: end
          }
        };

        if (starting_after) {
          txnParams.starting_after = starting_after;
        }

        const fcTransactions = await stripe.financialConnections.transactions.list(txnParams);
        allTransactions = allTransactions.concat(fcTransactions.data);
        hasMore = fcTransactions.has_more;
        
        if (fcTransactions.data.length > 0) {
          starting_after = fcTransactions.data[fcTransactions.data.length - 1].id;
        } else {
          hasMore = false;
        }
      }
    } catch (fetchError) {
      // Handle the "no transactions to retrieve" error
      if (fetchError.message && fetchError.message.includes('no transactions to retrieve')) {
        return res.json({
          ok: true,
          total: 0,
          imported: 0,
          skipped: 0,
          message: 'Transaction data is being synchronized from your bank. Please wait 2-3 minutes and try again.',
          syncing: true
        });
      }
      throw fetchError;
    }

    console.log('[Stripe Financial Connections] Retrieved', allTransactions.length, 'transactions');

    let imported = 0;
    let skipped = 0;
    const errors = [];
    const postingMode = shadowMode === true ? 'shadow' : 'live';
    const shadowSummary = createStripeShadowSummary(true, postingMode);

    // Import the classifier for tax-aware categorization
    const { classifyTransaction } = await import('./db/classifier.js');

    for (const txn of allTransactions) {
      try {
        // Determine if debit or credit
        // Stripe txn.amount: positive = money IN (income/credit), negative = money OUT (expense/debit)
        const isDebit = txn.amount < 0; // Expense = money out = debit
        const amount = Math.abs(txn.amount) / 100;

        const txnDate = new Date(txn.transacted_at * 1000).toISOString().split('T')[0];
        const description = txn.description || 'Bank transaction';
        const stripeCategory = txn.category || 'uncategorized';
        const merchantName = txn.merchant_name || '';

        // Use the tax-aware classifier to categorize the transaction
        const classificationInput = {
          txn_date: txnDate,
          amount: amount,
          description: description,
          payee: merchantName,
          is_debit: isDebit,
          category_hint: mapStripeCategoryToAccountCode(stripeCategory)
        };
        
        const classification = classifyTransaction(classificationInput);
        const legacyAccountCode = classification.category || mapStripeCategoryToAccountCode(stripeCategory);
        const accountCode = normalizeFinancialConnectionsAccountCode(legacyAccountCode);
        const scheduleELine = getFinancialConnectionsScheduleELine(legacyAccountCode);

        const postingResult = await runStripeShadowPosting({
          summary: shadowSummary,
          candidate: buildStripeFinancialConnectionsFinanceEvent(txn, {
            userId,
            propertyId,
            accountCode,
            legacyAccountCode,
            classification,
            scheduleELine,
          }),
          legacyAccountCode: accountCode,
          legacyIsDebit: isDebit,
          legacyMemo: description,
          postedBy: postingMode === 'shadow'
            ? `stripe-financial-connections-shadow:${userId}`
            : `stripe-financial-connections-canonical:${userId}`,
          idempotencyScope: 'stripe-shadow',
          transactionId: txn.id
        });
        const outcome = recordStripePostingOutcome(postingResult, errors, txn.id, {
          description,
          amount,
          source: 'stripe-financial-connections'
        });
        imported += outcome.imported;
        skipped += outcome.skipped;
      } catch (txnError) {
        console.error('[Stripe Financial Connections] Error importing transaction:', txnError);
        errors.push({
          transactionId: txn.id,
          error: txnError.message
        });
      }
    }

    const journalsCreated = imported;
    
    res.json({
      ok: true,
      total: allTransactions.length,
      imported: journalsCreated,
      skipped,
      shadowLedger: summarizeStripeShadow(shadowSummary),
      errors: errors.length > 0 ? errors : undefined,
      message: journalsCreated > 0 
        ? `Created ${journalsCreated} canonical journal entries from ${allTransactions.length} transactions`
        : errors.length > 0 
          ? `No journal entries created. ${errors.length} transactions had errors.`
          : `${skipped} transactions already synced`
    });

    console.log('[Stripe Financial Connections] Synced transactions:', {
      total: allTransactions.length,
      imported,
      skipped,
      ledger: {
        postingMode: shadowSummary.postingMode,
        posted: shadowSummary.posted,
        duplicates: shadowSummary.duplicates,
        pendingMatch: shadowSummary.pendingMatch,
        unsupported: shadowSummary.unsupported,
        failed: shadowSummary.failed,
        notConfigured: shadowSummary.notConfigured
      }
    });
  } catch (error) {
    console.error('[Stripe Financial Connections] Error syncing transactions:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      details: 'Failed to sync Financial Connections transactions'
    });
  }
});

/**
 * GET /api/stripe-connect/balance/:accountId
 * Get current balance for a connected account
 */
router.get('/balance/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });

    // Format balance data
    const formattedBalance = {
      available: balance.available.map(b => ({
        amount: b.amount / 100,
        currency: b.currency
      })),
      pending: balance.pending.map(b => ({
        amount: b.amount / 100,
        currency: b.currency
      })),
      connectReserved: balance.connect_reserved?.map(b => ({
        amount: b.amount / 100,
        currency: b.currency
      })) || []
    };

    res.json({
      ok: true,
      balance: formattedBalance
    });

    console.log('[Stripe Connect] Retrieved balance for account:', accountId);
  } catch (error) {
    console.error('[Stripe Connect] Error fetching balance:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/financial-connections-balance/:userId
 * Get current account balances from Financial Connections linked accounts
 */
router.get('/financial-connections-balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log('[Stripe Financial Connections] Fetching balance for userId:', userId);

    // Find the customer by email/userId
    const customers = await stripe.customers.list({
      limit: 1,
      email: `tenant-${userId}@placeholder.com`
    });

    console.log('[Stripe Financial Connections] Found customers:', customers.data.length);

    if (customers.data.length === 0) {
      return res.json({
        ok: true,
        balances: [],
        totals: { available: 0, current: 0 },
        message: 'No Financial Connections found'
      });
    }

    const customer = customers.data[0];
    console.log('[Stripe Financial Connections] Customer ID:', customer.id);

    // List all Financial Connections accounts for this customer
    const accounts = await stripe.financialConnections.accounts.list({
      account_holder: {
        customer: customer.id,
      },
      limit: 100,
    });

    if (accounts.data.length === 0) {
      return res.json({
        ok: true,
        balances: [],
        message: 'No accounts connected'
      });
    }

    // Refresh and retrieve balances for each account
    const accountBalances = await Promise.all(
      accounts.data.map(async (acc) => {
        try {
          // Subscribe to balance feature if not already
          try {
            await stripe.financialConnections.accounts.subscribe(acc.id, {
              features: ['account_balance']
            });
          } catch (subErr) {
            // Already subscribed or not available
          }

          // Refresh balance data
          try {
            await stripe.financialConnections.accounts.refresh(acc.id, {
              features: ['balance']
            });
          } catch (refreshErr) {
            console.log('[Stripe Financial Connections] Balance refresh:', refreshErr.message);
          }

          // Retrieve the updated account with balance
          const updatedAccount = await stripe.financialConnections.accounts.retrieve(acc.id);
          
          console.log('[Stripe FC] Account', acc.id, 'raw balance data:', JSON.stringify(updatedAccount.balance, null, 2));
          console.log('[Stripe FC] Account', acc.id, 'balance_refresh:', JSON.stringify(updatedAccount.balance_refresh, null, 2));

          // Extract balance - handle nested structure (balance.cash.available.usd or balance.current.usd)
          const bal = updatedAccount.balance;
          let available = null;
          let current = null;
          
          if (bal) {
            // Try cash.available.usd first (checking account)
            if (bal.cash?.available?.usd !== undefined) {
              available = bal.cash.available.usd / 100;
            }
            // Try current.usd
            if (bal.current?.usd !== undefined) {
              current = bal.current.usd / 100;
            }
            // Fallback to direct values
            if (available === null && typeof bal.available === 'number') {
              available = bal.available / 100;
            }
            if (current === null && typeof bal.current === 'number') {
              current = bal.current / 100;
            }
          }
          
          console.log('[Stripe FC] Account', acc.id, 'parsed: available=', available, 'current=', current);

          return {
            id: acc.id,
            institutionName: acc.institution_name,
            displayName: acc.display_name || `${acc.institution_name} Account`,
            last4: acc.last4,
            status: acc.status,
            accountType: acc.subcategory || acc.category,
            balance: {
              current: current,
              available: available,
              cash: bal?.cash?.available?.usd ? bal.cash.available.usd / 100 : null,
              currency: updatedAccount.balance_refresh?.currency || 'usd'
            },
            lastBalanceRefresh: updatedAccount.balance_refresh?.last_attempted_at
              ? new Date(updatedAccount.balance_refresh.last_attempted_at * 1000).toISOString()
              : null,
            balanceRefreshStatus: updatedAccount.balance_refresh?.status || 'unknown'
          };
        } catch (accError) {
          console.error('[Stripe Financial Connections] Error fetching balance for account:', acc.id, accError.message);
          return {
            id: acc.id,
            institutionName: acc.institution_name,
            displayName: acc.display_name || `${acc.institution_name} Account`,
            last4: acc.last4,
            status: acc.status,
            balance: null,
            error: accError.message
          };
        }
      })
    );

    // Calculate totals
    const totalAvailable = accountBalances
      .filter(a => a.balance?.available !== null)
      .reduce((sum, a) => sum + (a.balance?.available || 0), 0);

    const totalCurrent = accountBalances
      .filter(a => a.balance?.current !== null)
      .reduce((sum, a) => sum + (a.balance?.current || 0), 0);

    console.log('[Stripe Financial Connections] Totals - Available:', totalAvailable, 'Current:', totalCurrent);

    res.json({
      ok: true,
      balances: accountBalances,
      totals: {
        available: totalAvailable,
        current: totalCurrent
      },
      accountCount: accountBalances.length
    });

    console.log('[Stripe Financial Connections] Retrieved balances for', accountBalances.length, 'accounts');
  } catch (error) {
    console.error('[Stripe Financial Connections] Error fetching balances:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/stripe-connect/payouts/:accountId
 * Get payout history for a connected account
 */
router.get('/payouts/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { limit = 10 } = req.query;

    const payouts = await stripe.payouts.list(
      { limit: parseInt(limit) },
      { stripeAccount: accountId }
    );

    const formattedPayouts = payouts.data.map(payout => ({
      id: payout.id,
      amount: payout.amount / 100,
      currency: payout.currency,
      status: payout.status,
      type: payout.type,
      arrivalDate: new Date(payout.arrival_date * 1000).toISOString().split('T')[0],
      created: new Date(payout.created * 1000).toISOString().split('T')[0],
      description: payout.description,
      destination: payout.destination
    }));

    res.json({
      ok: true,
      payouts: formattedPayouts,
      has_more: payouts.has_more
    });

    console.log('[Stripe Connect] Retrieved', formattedPayouts.length, 'payouts for account:', accountId);
  } catch (error) {
    console.error('[Stripe Connect] Error fetching payouts:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/webhook
 * Handle Stripe webhooks for account updates and payment events
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('[Stripe Connect] Webhook secret not configured');
    return res.status(200).send('Webhook secret not configured');
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    // Handle the event
    switch (event.type) {
      case 'account.updated':
        console.log('[Stripe Connect] Account updated:', event.data.object.id);
        break;

      case 'checkout.session.completed': {
        const session = event.data.object;
        const meta = session.metadata || {};

        if (session.mode === 'setup') {
          // ── Auto-Pay bank verification completed → create recurring subscription ──
          console.log('[Stripe Autopay] Setup session completed:', session.id, 'customer:', session.customer);
          try {
            const customerId = session.customer;
            const setupIntent = session.setup_intent;
            const accountId = meta.landlordAccountId;
            const amountNum = parseFloat(meta.monthlyAmount || '0');

            if (!customerId || !accountId || !amountNum) {
              console.error('[Stripe Autopay] Missing data in setup session metadata:', meta);
              break;
            }

            // Retrieve the verified PaymentMethod from the SetupIntent
            const si = await stripe.setupIntents.retrieve(setupIntent, {
              expand: ['payment_method']
            });
            const paymentMethodId = typeof si.payment_method === 'string'
              ? si.payment_method
              : si.payment_method?.id;

            if (!paymentMethodId) {
              console.error('[Stripe Autopay] No payment method on SetupIntent:', setupIntent);
              break;
            }

            const paymentMethod = typeof si.payment_method === 'string'
              ? await ensureUsBankAccountPaymentMethod(paymentMethodId)
              : si.payment_method;

            if (paymentMethod?.type !== 'us_bank_account') {
              console.error('[Stripe Autopay] SetupIntent completed without a verified bank account:', setupIntent);
              break;
            }

            // Set as default on customer
            await stripe.customers.update(customerId, {
              invoice_settings: { default_payment_method: paymentMethodId }
            });

            // Check if subscription already exists (idempotency)
            const existingSubscription = await findExistingAutopaySubscription(customerId, accountId);
            if (existingSubscription) {
              console.log('[Stripe Autopay] Subscription already exists for customer:', customerId);
              break;
            }

            // Create a price for this monthly amount
            const price = await stripe.prices.create({
              currency: 'usd',
              unit_amount: Math.round(amountNum * 100),
              recurring: { interval: 'month' },
              product_data: {
                name: meta.propertyAddress ? `Monthly Rent - ${meta.propertyAddress}` : 'Monthly Rent'
              }
            });

            // Anchor to 1st of next month
            const now = new Date();
            const billingAnchor = Math.floor(
              new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).getTime() / 1000
            );

            const subscription = await stripe.subscriptions.create(
              buildTenantAutopaySubscriptionParams({
                customerId,
                priceId: price.id,
                paymentMethodId,
                billingAnchorTimestamp: billingAnchor,
                accountId,
                metadata: {
                  tenantEmail: meta.tenantEmail || '',
                  tenantName: meta.tenantName || '',
                  propertyAddress: meta.propertyAddress || '',
                  landlordAccountId: accountId
                }
              })
            );

            console.log('[Stripe Autopay] ✅ Subscription created via webhook:', subscription.id,
              '| tenant:', meta.tenantEmail, '| amount:', amountNum, '| status:', subscription.status);
          } catch (subErr) {
            console.error('[Stripe Autopay] Failed to create subscription from webhook:', subErr.message);
          }
        } else {
          // ── Normal one-time payment ──
          const status = session.payment_status === 'paid' ? 'completed' : 'pending';
          const paymentMethodType = await resolveCheckoutSessionPaymentMethodType(session);
          await recordTenantPayment({
            tenantId: meta.tenantId || '',
            tenantEmail: meta.tenantEmail || session.customer_email || '',
            tenantName: meta.tenantName || '',
            ownerId: meta.ownerId || '',
            propertyId: meta.propertyId || '',
            propertyAddress: meta.propertyAddress || '',
            amount: (session.amount_total || 0) / 100,
            paymentMethod: paymentMethodType,
            transactionId: getStripeResourceId(session.payment_intent) || session.id,
            status
          });
          console.log('[Stripe Connect] Recorded checkout payment:', session.id, 'status:', status);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;

        if (pi.metadata?.flowType === 'maintenance_payment' && pi.metadata?.maintenanceRequestId) {
          await updateMaintenanceRequestDetails(pi.metadata.maintenanceRequestId, {
            paymentWorkflow: {
              status: 'paid',
              ownerChargeSucceededAt: new Date().toISOString(),
              ownerPaymentIntentId: pi.id,
              ownerPaymentStatus: 'succeeded',
              lastError: '',
            },
          });
          console.log('[Stripe Connect] Maintenance payment succeeded:', pi.id, '| request:', pi.metadata.maintenanceRequestId);
          break;
        }

        const updated = await updateTenantPaymentStatus(pi.id, 'completed');
        if (!updated.updated) {
          // No record found — could be a subscription payment intent; record it now
          const meta = pi.metadata || {};
          if (meta.tenantEmail || meta.ownerId) {
            const paymentMethodType = await resolvePaymentIntentPaymentMethodType(pi);
            await recordTenantPayment({
              tenantId: meta.tenantId || '',
              tenantEmail: meta.tenantEmail || '',
              tenantName: meta.tenantName || '',
              ownerId: meta.ownerId || '',
              propertyId: meta.propertyId || '',
              propertyAddress: meta.propertyAddress || '',
              amount: (pi.amount_received || pi.amount || 0) / 100,
              paymentMethod: paymentMethodType,
              transactionId: pi.id,
              status: 'completed'
            });
          }
        }
        console.log('[Stripe Connect] Payment succeeded:', pi.id);
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;

        if (pi.metadata?.flowType === 'maintenance_payment' && pi.metadata?.maintenanceRequestId) {
          await updateMaintenanceRequestDetails(pi.metadata.maintenanceRequestId, {
            paymentWorkflow: {
              status: 'charge_failed',
              ownerPaymentIntentId: pi.id,
              ownerPaymentStatus: 'failed',
              lastError: pi.last_payment_error?.message || 'Stripe reported a maintenance payment failure.',
            },
          });
          console.log('[Stripe Connect] Maintenance payment failed:', pi.id, '| request:', pi.metadata.maintenanceRequestId);
          break;
        }

        await updateTenantPaymentStatus(pi.id, 'failed');
        console.log('[Stripe Connect] Payment failed:', pi.id);
        break;
      }

      // --- Recurring subscription invoice events ---
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        // Retrieve subscription metadata to get ownerId/tenantId
        let subMeta = {};
        if (invoice.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(invoice.subscription);
            subMeta = sub.metadata || {};
          } catch (_e) { /* non-critical */ }
        }
        await recordTenantPayment({
          tenantId: subMeta.tenantId || '',
          tenantEmail: invoice.customer_email || subMeta.tenantEmail || '',
          tenantName: subMeta.tenantName || '',
          ownerId: subMeta.ownerId || '',
          propertyId: subMeta.propertyId || '',
          propertyAddress: subMeta.propertyAddress || '',
          amount: (invoice.amount_paid || 0) / 100,
          paymentMethod: 'us_bank_account',
          transactionId: invoice.payment_intent || invoice.id,
          status: 'completed'
        });
        console.log(
          '[Stripe Autopay] Invoice paid:', invoice.id,
          '| amount:', (invoice.amount_paid / 100).toFixed(2),
          '| tenant:', invoice.customer_email || invoice.customer
        );
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.error(
          '[Stripe Autopay] Invoice payment FAILED:', invoice.id,
          '| tenant:', invoice.customer_email || invoice.customer,
          '| next retry:', invoice.next_payment_attempt
            ? new Date(invoice.next_payment_attempt * 1000).toISOString()
            : 'none'
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log('[Stripe Autopay] Subscription cancelled:', sub.id, '| tenant metadata:', sub.metadata);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        console.log('[Stripe Autopay] Subscription updated:', sub.id, '| status:', sub.status);
        break;
      }

      case 'setup_intent.succeeded': {
        const si = event.data.object;
        console.log('[Stripe Autopay] Bank account verified via SetupIntent:', si.id, '| tenant:', si.metadata?.tenantEmail);
        break;
      }

      default:
        console.log('[Stripe Connect] Unhandled event type:', event.type);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('[Stripe Connect] Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

/**
 * GET /api/stripe-connect/config
 * Get Stripe publishable key for client-side initialization
 */
router.get('/config', (req, res) => {
  res.json({
    ok: true,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
  });
});

/**
 * GET /api/stripe-connect/owner-payment-history?accountId=...
 * Pull all payments received by a landlord's connected Stripe account.
 */
router.get('/owner-payment-history', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) {
      return res.status(400).json({ ok: false, error: 'accountId is required' });
    }

    const payments = [];

    // ── 1. Payment intents on the connected account ───────────────────────────
    const paymentIntents = await stripe.paymentIntents.list(
      {
        limit: 50,
        expand: ['data.payment_method', 'data.latest_charge']
      },
      { stripeAccount: String(accountId) }
    );

    for (const pi of paymentIntents.data) {
      if (pi.status !== 'succeeded') continue;
      payments.push({
        id: pi.id,
        type: 'one-time',
        amount: (pi.amount_received || pi.amount || 0) / 100,
        currency: pi.currency || 'usd',
        status: 'completed',
        paymentMethod: deriveStripePaymentMethodTypeFromPaymentIntent(pi) || pi.payment_method_types?.[0] || 'card',
        tenantEmail: pi.metadata?.tenantEmail || pi.receipt_email || '',
        tenantName: pi.metadata?.tenantName || '',
        propertyAddress: pi.metadata?.propertyAddress || '',
        date: new Date(pi.created * 1000).toISOString()
      });
    }

    // ── 2. Transfers (includes subscription payouts) ──────────────────────────
    const transfers = await stripe.transfers.list({
      destination: String(accountId),
      limit: 50
    });

    for (const transfer of transfers.data) {
      // Skip if already captured via payment intent above
      if (transfer.source_type === 'card' || transfer.source_type === 'bank_account') {
        payments.push({
          id: transfer.id,
          type: transfer.metadata?.subscription ? 'autopay' : 'one-time',
          amount: (transfer.amount || 0) / 100,
          currency: transfer.currency || 'usd',
          status: 'completed',
          paymentMethod: transfer.source_type === 'bank_account' ? 'us_bank_account' : 'card',
          tenantEmail: transfer.metadata?.tenantEmail || '',
          tenantName: transfer.metadata?.tenantName || '',
          propertyAddress: transfer.metadata?.propertyAddress || '',
          date: new Date(transfer.created * 1000).toISOString()
        });
      }
    }

    // Deduplicate by amount+date within 60s window (transfers and payment intents can overlap)
    const seen = new Set();
    const deduped = payments.filter(p => {
      const key = `${p.amount}-${Math.floor(new Date(p.date).getTime() / 60000)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({ ok: true, payments: deduped });
  } catch (error) {
    console.error('[Stripe Connect] Error fetching owner payment history:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Pull full payment history for a tenant directly from the Stripe API.
 * Includes one-time checkout payments AND recurring subscription invoices.
 */
router.get('/tenant-payment-history', async (req, res) => {
  try {
    const { tenantEmail, accountId } = req.query;
    if (!tenantEmail) {
      return res.status(400).json({ ok: false, error: 'tenantEmail is required' });
    }

    const payments = [];

    // ── 1. Checkout sessions (one-time payments) ──────────────────────────────
    // Search by customer_email on checkout sessions
    const normalizedTenantEmail = String(tenantEmail).trim().toLowerCase();
    const sessions = await stripe.checkout.sessions.list({
      limit: 50,
      expand: ['data.payment_intent.payment_method', 'data.payment_intent.latest_charge']
    });

    for (const session of sessions.data) {
      if (session.status !== 'complete') continue;
      if (session.mode !== 'payment') continue;
      const sessionEmail = (
        session.customer_details?.email
        || session.customer_email
        || session.metadata?.tenantEmail
        || ''
      ).trim().toLowerCase();
      if (!sessionEmail || sessionEmail !== normalizedTenantEmail) continue;
      // Filter by landlord account if provided
      if (accountId && session.metadata?.landlordAccountId &&
          session.metadata.landlordAccountId !== String(accountId)) continue;

      payments.push({
        id: session.id,
        type: 'one-time',
        amount: (session.amount_total || 0) / 100,
        currency: session.currency || 'usd',
        status: session.payment_status === 'paid' ? 'completed' : 'pending',
        paymentMethod: deriveStripePaymentMethodTypeFromCheckoutSession(session) || session.payment_method_types?.[0] || 'card',
        description: session.metadata?.description || 'Rent Payment',
        propertyAddress: session.metadata?.propertyAddress || '',
        date: new Date(session.created * 1000).toISOString(),
        stripeUrl: `https://dashboard.stripe.com/payments/${getStripeResourceId(session.payment_intent) || session.id}`
      });
    }

    // ── 2. Subscription invoices (autopay) ────────────────────────────────────
    // Look up Stripe customer by email first
    const customers = await stripe.customers.list({ email: String(tenantEmail), limit: 10 });
    const customer = customers.data[0];

    if (customer) {
      const invoices = await stripe.invoices.list({
        customer: customer.id,
        limit: 50,
        status: 'paid'
      });

      for (const invoice of invoices.data) {
        // Skip if no subscription (not a rent autopay invoice)
        if (!invoice.subscription) continue;
        if ((invoice.amount_paid || 0) <= 0) continue;

        payments.push({
          id: invoice.id,
          type: 'autopay',
          amount: (invoice.amount_paid || 0) / 100,
          currency: invoice.currency || 'usd',
          status: 'completed',
          paymentMethod: 'us_bank_account',
          description: invoice.description || invoice.lines?.data[0]?.description || 'Monthly Rent',
          propertyAddress: invoice.metadata?.propertyAddress || '',
          autopayCustomSchedule: invoice.metadata?.autopayCustomSchedule === 'true',
          customScheduledFor: invoice.metadata?.autopayCustomScheduledFor || null,
          customScheduleReason: invoice.metadata?.autopayCustomScheduleReason || null,
          date: new Date(invoice.created * 1000).toISOString(),
          stripeUrl: invoice.hosted_invoice_url || `https://dashboard.stripe.com/invoices/${invoice.id}`
        });
      }

      // Also grab pending/open invoices
      const openInvoices = await stripe.invoices.list({
        customer: customer.id,
        limit: 20,
        status: 'open'
      });
      for (const invoice of openInvoices.data) {
        if (!invoice.subscription) continue;
        if ((invoice.amount_due || 0) <= 0) continue;
        payments.push({
          id: invoice.id,
          type: 'autopay',
          amount: (invoice.amount_due || 0) / 100,
          currency: invoice.currency || 'usd',
          status: 'pending',
          paymentMethod: 'us_bank_account',
          description: invoice.description || invoice.lines?.data[0]?.description || 'Monthly Rent',
          propertyAddress: invoice.metadata?.propertyAddress || '',
          autopayCustomSchedule: invoice.metadata?.autopayCustomSchedule === 'true',
          customScheduledFor: invoice.metadata?.autopayCustomScheduledFor || null,
          customScheduleReason: invoice.metadata?.autopayCustomScheduleReason || null,
          date: new Date(invoice.created * 1000).toISOString(),
          stripeUrl: invoice.hosted_invoice_url || `https://dashboard.stripe.com/invoices/${invoice.id}`
        });
      }
    }

    // Sort newest first
    payments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({ ok: true, payments });
  } catch (error) {
    console.error('[Stripe Connect] Error fetching tenant payment history:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// BROKERAGE ACCOUNT CONNECTIONS - Investment Account Integration
// ============================================================================

/**
 * POST /api/stripe-connect/create-brokerage-session
 * Create a Financial Connections session for brokerage/investment accounts
 * This allows users to connect their investment accounts to view holdings
 */
router.post('/create-brokerage-session', async (req, res) => {
  try {
    const { userId, userEmail } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId is required' 
      });
    }

    console.log('[Stripe Brokerage] Creating Financial Connections session for brokerage accounts, user:', userId);

    // Create or retrieve a Stripe Customer for this user
    let customer;
    const customerEmail = userEmail || `brokerage-${userId}@placeholder.com`;
    
    try {
      // Try to find existing customer by metadata or email pattern
      const customers = await stripe.customers.list({
        limit: 10,
        email: customerEmail
      });

      // Also check for tenant email pattern as the user might have connected a bank before
      const tenantCustomers = await stripe.customers.list({
        limit: 10,
        email: `tenant-${userId}@placeholder.com`
      });

      if (customers.data.length > 0) {
        customer = customers.data[0];
        console.log('[Stripe Brokerage] Using existing customer:', customer.id);
      } else if (tenantCustomers.data.length > 0) {
        customer = tenantCustomers.data[0];
        console.log('[Stripe Brokerage] Using existing tenant customer:', customer.id);
      } else {
        // Create new customer
        customer = await stripe.customers.create({
          email: customerEmail,
          metadata: {
            userId: userId,
            purpose: 'brokerage-connection'
          }
        });
        console.log('[Stripe Brokerage] Created new customer:', customer.id);
      }
    } catch (customerError) {
      console.error('[Stripe Brokerage] Error with customer:', customerError);
      throw new Error('Failed to create/retrieve customer');
    }

    // Create a Financial Connections Session for investment accounts
    // Note: Stripe Financial Connections supports investment accounts for:
    // - Account ownership verification
    // - Balance checking
    // - Some institutions support transaction history
    const session = await stripe.financialConnections.sessions.create({
      account_holder: {
        type: 'customer',
        customer: customer.id,
      },
      permissions: ['payment_method', 'balances', 'transactions', 'ownership'],
      filters: {
        countries: ['US'],
        // Note: Stripe automatically shows all supported account types including investment accounts
        // The user can select their brokerage during the connection flow
      },
      prefetch: ['balances', 'ownership'],
    });

    console.log('[Stripe Brokerage] Session created successfully:', session.id);

    res.json({
      ok: true,
      sessionId: session.id,
      clientSecret: session.client_secret,
      customerId: customer.id,
      message: 'Brokerage connection session created successfully'
    });
  } catch (error) {
    console.error('[Stripe Brokerage] Error creating session:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      details: 'Failed to create brokerage connection session.'
    });
  }
});

/**
 * GET /api/stripe-connect/brokerage-accounts/:userId
 * Get all connected investment/brokerage accounts for a user
 */
router.get('/brokerage-accounts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Find the customer(s) for this user
    const [userCustomers, tenantCustomers, brokerageCustomers] = await Promise.all([
      stripe.customers.list({ limit: 5, email: `user-${userId}@placeholder.com` }),
      stripe.customers.list({ limit: 5, email: `tenant-${userId}@placeholder.com` }),
      stripe.customers.list({ limit: 5, email: `brokerage-${userId}@placeholder.com` })
    ]);

    const allCustomers = [
      ...userCustomers.data,
      ...tenantCustomers.data,
      ...brokerageCustomers.data
    ];

    if (allCustomers.length === 0) {
      return res.json({
        ok: true,
        connected: false,
        accounts: [],
        message: 'No accounts connected'
      });
    }

    // Collect all Financial Connections accounts across all customer records
    const allAccounts = [];

    for (const customer of allCustomers) {
      try {
        const accounts = await stripe.financialConnections.accounts.list({
          account_holder: {
            customer: customer.id,
          },
          limit: 50,
        });

        // Filter for investment/brokerage accounts if available
        // Stripe returns subcategory field for account types
        for (const account of accounts.data) {
          // Include all accounts - users might have brokerage accounts at various institutions
          allAccounts.push({
            id: account.id,
            institutionName: account.institution_name,
            displayName: account.display_name,
            last4: account.last4,
            status: account.status,
            category: account.category || 'unknown', // depository, credit, investment, etc.
            subcategory: account.subcategory || 'unknown', // checking, savings, brokerage, etc.
            accountType: account.account_holder?.type,
            supportedPaymentMethodTypes: account.supported_payment_method_types || [],
            livemode: account.livemode,
            customerId: customer.id,
            ownership: account.ownership || null,
            balance: account.balance || null,
            balanceRefresh: account.balance_refresh || null,
            permissions: account.permissions || []
          });
        }
      } catch (listError) {
        console.error(`[Stripe Brokerage] Error listing accounts for customer ${customer.id}:`, listError.message);
      }
    }

    // Separate investment/brokerage accounts from other types
    const brokerageAccounts = allAccounts.filter(a => 
      a.category === 'investment' || 
      a.subcategory === 'brokerage' ||
      a.subcategory === 'investment' ||
      (a.institutionName && (
        a.institutionName.toLowerCase().includes('fidelity') ||
        a.institutionName.toLowerCase().includes('schwab') ||
        a.institutionName.toLowerCase().includes('vanguard') ||
        a.institutionName.toLowerCase().includes('td ameritrade') ||
        a.institutionName.toLowerCase().includes('etrade') ||
        a.institutionName.toLowerCase().includes('robinhood') ||
        a.institutionName.toLowerCase().includes('webull') ||
        a.institutionName.toLowerCase().includes('interactive brokers') ||
        a.institutionName.toLowerCase().includes('merrill')
      ))
    );

    res.json({
      ok: true,
      connected: allAccounts.length > 0,
      accounts: allAccounts,
      brokerageAccounts: brokerageAccounts,
      allAccountCount: allAccounts.length,
      brokerageAccountCount: brokerageAccounts.length
    });

  } catch (error) {
    console.error('[Stripe Brokerage] Error fetching accounts:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/brokerage-debug/:accountId
 * Debug endpoint to see ALL raw data Stripe returns for an account
 */
router.get('/brokerage-debug/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    console.log('[Stripe Brokerage DEBUG] Fetching full account data for:', accountId);

    // Get raw account data
    const account = await stripe.financialConnections.accounts.retrieve(accountId);
    
    // Log all available properties
    console.log('[Stripe Brokerage DEBUG] Full account object:', JSON.stringify(account, null, 2));

    res.json({
      ok: true,
      message: 'Full account data - check for any holdings/positions/securities fields',
      rawAccount: account,
      availableFields: Object.keys(account),
      permissions: account.permissions,
      supportedPaymentMethodTypes: account.supported_payment_method_types,
      category: account.category,
      subcategory: account.subcategory,
      balance: account.balance,
      balanceRefresh: account.balance_refresh,
      ownership: account.ownership,
      ownershipRefresh: account.ownership_refresh,
      transactionRefresh: account.transaction_refresh
    });

  } catch (error) {
    console.error('[Stripe Brokerage DEBUG] Error:', error);
    res.status(500).json({ ok: false, error: error.message, rawError: error });
  }
});

/**
 * GET /api/stripe-connect/brokerage-balance/:accountId
 * Get balance information for a connected brokerage account
 */
router.get('/brokerage-balance/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    console.log('[Stripe Brokerage] Fetching balance for account:', accountId);

    // Retrieve the account to check its status and balance
    const account = await stripe.financialConnections.accounts.retrieve(accountId);

    // Check if balance permission is available
    if (!account.permissions || !account.permissions.includes('balances')) {
      return res.json({
        ok: true,
        hasBalance: false,
        message: 'Balance information not available for this account'
      });
    }

    // Try to refresh balance if stale
    const balanceRefresh = account.balance_refresh;
    const isStale = balanceRefresh && 
      (Date.now() - balanceRefresh.last_attempted_at * 1000) > 3600000; // 1 hour

    if (isStale || !account.balance) {
      try {
        await stripe.financialConnections.accounts.refresh(accountId, {
          features: ['balance']
        });
        // Re-fetch the account to get updated balance
        const refreshedAccount = await stripe.financialConnections.accounts.retrieve(accountId);
        
        res.json({
          ok: true,
          hasBalance: !!refreshedAccount.balance,
          balance: refreshedAccount.balance || null,
          accountInfo: {
            id: refreshedAccount.id,
            institutionName: refreshedAccount.institution_name,
            displayName: refreshedAccount.display_name,
            last4: refreshedAccount.last4,
            category: refreshedAccount.category,
            subcategory: refreshedAccount.subcategory
          },
          refreshed: true
        });
        return;
      } catch (refreshError) {
        console.log('[Stripe Brokerage] Balance refresh note:', refreshError.message);
      }
    }

    res.json({
      ok: true,
      hasBalance: !!account.balance,
      balance: account.balance || null,
      accountInfo: {
        id: account.id,
        institutionName: account.institution_name,
        displayName: account.display_name,
        last4: account.last4,
        category: account.category,
        subcategory: account.subcategory
      },
      refreshed: false
    });

  } catch (error) {
    console.error('[Stripe Brokerage] Error fetching balance:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/stripe-connect/brokerage-transactions/:accountId
 * Get transactions/activity for a connected brokerage account
 * This can include trades, dividends, and other investment activity
 */
router.get('/brokerage-transactions/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    console.log('[Stripe Brokerage] Fetching transactions for account:', accountId);

    // Retrieve account to check permissions
    const account = await stripe.financialConnections.accounts.retrieve(accountId);

    if (!account.permissions || !account.permissions.includes('transactions')) {
      return res.json({
        ok: true,
        transactions: [],
        hasTransactions: false,
        message: 'Transaction history not available for this account'
      });
    }

    // Subscribe to transactions if needed
    try {
      await stripe.financialConnections.accounts.subscribe(accountId, {
        features: ['transactions']
      });
    } catch (subError) {
      // Already subscribed or other issue
      console.log('[Stripe Brokerage] Subscribe note:', subError.message);
    }

    // Refresh transactions
    try {
      await stripe.financialConnections.accounts.refresh(accountId, {
        features: ['transactions']
      });
    } catch (refreshError) {
      console.log('[Stripe Brokerage] Refresh note:', refreshError.message);
    }

    // Fetch transactions
    const transactions = await stripe.financialConnections.transactions.list({
      account: accountId,
      limit: limit
    });

    // Format transactions with investment-specific categorization
    const formattedTransactions = transactions.data.map(txn => ({
      id: txn.id,
      amount: Math.abs(txn.amount) / 100,
      currency: txn.currency || 'usd',
      description: txn.description || 'No description',
      date: new Date(txn.transacted_at * 1000).toISOString().split('T')[0],
      status: txn.status,
      type: txn.amount < 0 ? 'debit' : 'credit',
      category: txn.category || 'uncategorized',
      // Investment-specific transaction type detection
      investmentType: detectInvestmentTransactionType(txn.description, txn.category),
      merchant: txn.merchant_name || null,
      pending: txn.status === 'pending'
    }));

    res.json({
      ok: true,
      transactions: formattedTransactions,
      hasTransactions: true,
      count: formattedTransactions.length,
      accountInfo: {
        id: account.id,
        institutionName: account.institution_name,
        displayName: account.display_name
      }
    });

  } catch (error) {
    console.error('[Stripe Brokerage] Error fetching transactions:', error);
    
    // Handle "no transactions" error gracefully
    if (error.message && error.message.includes('no transactions')) {
      return res.json({
        ok: true,
        transactions: [],
        hasTransactions: true,
        syncing: true,
        message: 'Transaction data is being synchronized. Please wait a few minutes.'
      });
    }
    
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * Helper function to detect investment transaction types from description
 */
function detectInvestmentTransactionType(description, category) {
  if (!description) return 'unknown';
  
  const desc = description.toLowerCase();
  
  // Dividend payments
  if (desc.includes('dividend') || desc.includes('div ') || desc.includes('dist')) {
    return 'dividend';
  }
  
  // Stock purchases
  if (desc.includes('buy') || desc.includes('bought') || desc.includes('purchase')) {
    return 'buy';
  }
  
  // Stock sales
  if (desc.includes('sell') || desc.includes('sold') || desc.includes('sale')) {
    return 'sell';
  }
  
  // Interest
  if (desc.includes('interest') || desc.includes('int ')) {
    return 'interest';
  }
  
  // Deposits/contributions
  if (desc.includes('deposit') || desc.includes('contribution') || desc.includes('transfer in')) {
    return 'deposit';
  }
  
  // Withdrawals
  if (desc.includes('withdrawal') || desc.includes('transfer out')) {
    return 'withdrawal';
  }
  
  // Fee-related
  if (desc.includes('fee') || desc.includes('commission')) {
    return 'fee';
  }
  
  // Reinvestment
  if (desc.includes('reinvest') || desc.includes('drip')) {
    return 'reinvestment';
  }
  
  return category || 'other';
}

/**
 * Blacklist of common words that are NOT stock tickers
 * These often appear in transaction descriptions but aren't securities
 */
const TICKER_BLACKLIST = new Set([
  // Common corporate suffixes
  'INC', 'CORP', 'CO', 'LLC', 'LTD', 'LP', 'PLC', 'SA', 'AG', 'NV', 'SE', 'AB',
  // Common words in transaction descriptions
  'THE', 'AND', 'FOR', 'YOU', 'YOUR', 'NEW', 'OLD', 'ALL', 'ANY', 'CAN', 'HAS', 'HAD',
  'NOT', 'BUT', 'ARE', 'WAS', 'WERE', 'BEEN', 'HAVE', 'WITH', 'FROM', 'THAT', 'THIS',
  'WILL', 'EACH', 'WHEN', 'WHAT', 'CASH', 'TAX', 'NET', 'PAY', 'FEE', 'DUE', 'PER',
  // Investment transaction words
  'BUY', 'SELL', 'SOLD', 'SALE', 'DIV', 'DIST', 'DRIP', 'ADJ', 'INT', 'ACH', 'EFT',
  'REG', 'SEC', 'MKT', 'LMT', 'STP', 'GTC', 'DAY', 'IOC', 'FOK', 'AON',
  // Brokerage/Institution words
  'INDEX', 'FUND', 'FUNDS', 'TRUST', 'GROUP', 'BANK', 'ASSET', 'MGMT', 'STOCK', 'BOND',
  'SHARES', 'SHARE', 'SHS', 'CLASS', 'UNIT', 'UNITS', 'ADR', 'ADS', 'ETF', 'REIT',
  // Account types
  'IRA', 'ROTH', 'SEP', 'ACCT', 'ACNT', 'ACCOUNT', 'PLAN', 'SAVE', 'CREDIT', 'DEBIT',
  // Date/Time related
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'YTD', 'QTD', 'MTD',
  // Common words that look like tickers
  'AT', 'BY', 'IN', 'ON', 'OR', 'TO', 'UP', 'OF', 'IF', 'IS', 'IT', 'AS', 'BE', 'DO',
  'GO', 'HE', 'ME', 'MY', 'NO', 'SO', 'US', 'WE', 'AM', 'AN', 'ID', 'RE', 'VS',
  // Transaction processing words  
  'EOM', 'EOD', 'EOQ', 'EOY', 'TBD', 'TBC', 'NOM', 'PAR', 'CUM', 'EX', 'REC', 'PAY',
  // Common 3-4 letter words
  'USD', 'USA', 'CAD', 'EUR', 'GBP', 'CHF', 'JPY', 'AUD', 'CNY', 'HKD', 'SGD', 'INR',
  'ONE', 'TWO', 'TEN', 'PRE', 'VIA', 'OUT', 'OFF', 'END', 'SET', 'GOT', 'GET',
  'NOW', 'HOW', 'WHY', 'YES', 'NO', 'ADD', 'RUN', 'OUR', 'OWN', 'WAY', 'TOO'
]);

/**
 * Known popular stock tickers that might otherwise be filtered
 * These are kept even if they match common words
 */
const KNOWN_TICKERS = new Set([
  // FAANG/Big Tech
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX',
  // Major indices ETFs
  'SPY', 'QQQ', 'VOO', 'VTI', 'IVV', 'VEA', 'VWO', 'BND', 'AGG',
  // Semiconductor
  'ASML', 'AMD', 'INTC', 'AVGO', 'QCOM', 'TXN', 'MU', 'LRCX', 'KLAC',
  // Finance
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP',
  // Healthcare
  'JNJ', 'UNH', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT', 'DHR',
  // Consumer
  'WMT', 'HD', 'MCD', 'NKE', 'SBUX', 'TGT', 'COST', 'LOW', 'TJX',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'VLO', 'MPC', 'OXY',
  // Industrial
  'CAT', 'DE', 'UPS', 'HON', 'BA', 'LMT', 'GE', 'MMM', 'RTX',
  // Other popular
  'DIS', 'V', 'MA', 'PYPL', 'CRM', 'ADBE', 'ORCL', 'IBM', 'CSCO', 'ACN'
]);

/**
 * Extract stock ticker from transaction description
 * Uses pattern matching specific to brokerage transaction formats
 * Fidelity format: "YOU BOUGHT NETFLIX INC (NFLX) (Cash)"
 */
function extractTickerFromDescription(description) {
  if (!description) return null;
  
  // Primary pattern: Ticker in parentheses like (NFLX), (AAPL), (VOO)
  // This is the most reliable pattern for Fidelity and most brokerages
  const tickerInParens = description.match(/\(([A-Z]{1,5})\)(?:\s*\(Cash\))?/);
  if (tickerInParens && isValidTicker(tickerInParens[1])) {
    return { ticker: tickerInParens[1], quantity: null };
  }
  
  const desc = description.toUpperCase();
  
  // Fallback patterns...
  // Pattern: BUY/SELL followed by number then ticker
  const buyPattern = desc.match(/(?:BUY|BOUGHT|PURCHASE[D]?|SELL|SOLD|SALE)\s+(\d+(?:\.\d+)?)\s+([A-Z]{1,5})\b/);
  if (buyPattern && isValidTicker(buyPattern[2])) {
    return { ticker: buyPattern[2], quantity: parseFloat(buyPattern[1]) };
  }
  
  // Pattern: Look for known tickers anywhere in the string
  for (const knownTicker of KNOWN_TICKERS) {
    const regex = new RegExp(`\\b${knownTicker}\\b`);
    if (regex.test(desc)) {
      return { ticker: knownTicker, quantity: null };
    }
  }
  
  return null;
}

/**
 * Polygon Helpers (server-side)
 */
async function polygonGetJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon HTTP ${res.status}`);
  return res.json();
}

// Get a resilient current price approximation (snapshot or previous close)
async function getStockPrice(ticker) {
  if (!POLYGON_API_KEY) return null;
  try {
    const [snapRes, prevRes] = await Promise.all([
      polygonGetJSON(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_API_KEY}`).catch(() => null),
      polygonGetJSON(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${POLYGON_API_KEY}`).catch(() => null)
    ]);
    const snapPrice = snapRes?.ticker?.min?.price || snapRes?.ticker?.lastTrade?.p || snapRes?.ticker?.todaysChangePerc ? snapRes?.ticker?.lastTrade?.p : null;
    const prevClose = Array.isArray(prevRes?.results) && prevRes.results[0]?.c ? prevRes.results[0].c : null;
    return snapPrice || prevClose || null;
  } catch (err) {
    console.log(`[Polygon] Price fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

async function getMultipleStockPrices(tickers) {
  const prices = {};
  const unique = [...new Set(tickers)].filter(Boolean);
  await Promise.all(unique.map(async (t) => { prices[t] = await getStockPrice(t); }));
  return prices;
}

// Get recent reference dividends for mapping pay_date -> cash_amount
async function getRecentDividends(ticker, limit = 12) {
  if (!POLYGON_API_KEY) return [];
  try {
    const data = await polygonGetJSON(`https://api.polygon.io/v3/reference/dividends?ticker=${ticker}&limit=${limit}&apiKey=${POLYGON_API_KEY}`);
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map(r => ({
      cashAmount: r.cash_amount || 0,
      payDate: r.pay_date || r.declaration_date || r.record_date || null,
      exDate: r.ex_dividend_date || null,
      frequency: r.frequency || null
    })).filter(d => d.cashAmount > 0 && d.payDate);
  } catch (err) {
    console.log(`[Polygon] Dividends fetch failed for ${ticker}:`, err.message);
    return [];
  }
}

// Get closing price for a specific calendar date (YYYY-MM-DD) for estimation fallbacks
// Handles weekends/holidays by fetching a range and finding the nearest trading day
async function getCloseOnDate(ticker, date) {
  if (!POLYGON_API_KEY) return null;
  try {
    // Fetch a 7-day range ending on the target date to handle weekends/holidays
    const targetDate = new Date(date);
    const fromDate = new Date(targetDate);
    fromDate.setDate(fromDate.getDate() - 7); // Go back 7 days
    
    const from = fromDate.toISOString().split('T')[0];
    const to = date;
    
    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=5&apiKey=${POLYGON_API_KEY}`;
    const data = await polygonGetJSON(url);
    
    // Get the most recent close price (sorted desc, so first result is closest to target date)
    if (Array.isArray(data?.results) && data.results.length > 0) {
      return data.results[0].c;
    }
    return null;
  } catch (err) {
    console.log(`[Polygon] Close-on-date failed for ${ticker} ${date}:`, err.message);
    return null;
  }
}

/**
 * Check if a string is likely a valid stock ticker
 */
function isValidTicker(str) {
  if (!str || str.length < 1 || str.length > 5) return false;
  
  // If it's a known ticker, always accept
  if (KNOWN_TICKERS.has(str)) return true;
  
  // If it's in the blacklist, reject
  if (TICKER_BLACKLIST.has(str)) return false;
  
  // Must be all uppercase letters
  if (!/^[A-Z]+$/.test(str)) return false;
  
  // Single or double letter tickers are usually not real (except known ones)
  if (str.length <= 2) return false;
  
  return true;
}

/**
 * Parse quantity from transaction description
 */
function parseQuantityFromDescription(description) {
  if (!description) return null;
  
  // Patterns for quantity:
  // "100 shares", "100 SHS", "100.5 shares"
  // "BUY 100", "SOLD 50.25"
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:SHARES?|SHS)/i,
    /(?:BUY|BOUGHT|PURCHASE[D]?|SELL|SOLD|SALE)\s+(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*@/i
  ];
  
  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) {
      return parseFloat(match[1]);
    }
  }
  
  return null;
}

/**
 * POST /api/stripe-connect/disconnect-brokerage
 * Disconnect a brokerage account
 */
router.post('/disconnect-brokerage', async (req, res) => {
  try {
    const { userId, accountId } = req.body;

    if (!userId || !accountId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId and accountId are required' 
      });
    }

    console.log('[Stripe Brokerage] Disconnecting account:', accountId, 'for user:', userId);

    try {
      await stripe.financialConnections.accounts.disconnect(accountId);
      console.log('[Stripe Brokerage] Successfully disconnected account:', accountId);
    } catch (disconnectError) {
      console.error('[Stripe Brokerage] Disconnect error:', disconnectError.message);
      // Continue even if disconnect fails (account might already be disconnected)
    }

    res.json({
      ok: true,
      message: 'Brokerage account disconnected successfully'
    });

  } catch (error) {
    console.error('[Stripe Brokerage] Error disconnecting account:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/stripe-connect/import-brokerage-holdings
 * Import brokerage holdings into the user's Net Worth portfolio
 * Analyzes buy/sell transactions to determine actual holdings
 */
router.post('/import-brokerage-holdings', async (req, res) => {
  try {
    const { userId, accountId } = req.body;

    if (!userId || !accountId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId and accountId are required' 
      });
    }

    console.log('[Stripe Brokerage] Importing holdings for account:', accountId, 'user:', userId);

    // Retrieve account details
    const account = await stripe.financialConnections.accounts.retrieve(accountId);

    // Get balance
    let balance = account.balance;
    if (!balance && account.permissions?.includes('balances')) {
      try {
        await stripe.financialConnections.accounts.refresh(accountId, { features: ['balance'] });
        const refreshed = await stripe.financialConnections.accounts.retrieve(accountId);
        balance = refreshed.balance;
      } catch (refreshErr) {
        console.log('[Stripe Brokerage] Balance refresh note:', refreshErr.message);
      }
    }

    // Track holdings from buy/sell transactions
    const holdingsMap = new Map(); // ticker -> { shares: number, avgCost: number, transactions: [] }
    let dividendTransactions = [];
    let buyTransactions = [];
    let sellTransactions = [];
    
    if (account.permissions?.includes('transactions')) {
      try {
        // Subscribe and refresh transactions
        try {
          await stripe.financialConnections.accounts.subscribe(accountId, { features: ['transactions'] });
        } catch (e) { /* already subscribed */ }
        
        try {
          await stripe.financialConnections.accounts.refresh(accountId, { features: ['transactions'] });
        } catch (e) { /* refresh in progress */ }
        
        // Paginate to get ALL available transactions
        let allTransactions = [];
        let hasMore = true;
        let startingAfter = null;
        
        while (hasMore) {
          const params = {
            account: accountId,
            limit: 100 // Stripe max per page
          };
          if (startingAfter) {
            params.starting_after = startingAfter;
          }
          
          const txnPage = await stripe.financialConnections.transactions.list(params);
          allTransactions = allTransactions.concat(txnPage.data);
          
          hasMore = txnPage.has_more;
          if (txnPage.data.length > 0) {
            startingAfter = txnPage.data[txnPage.data.length - 1].id;
          } else {
            hasMore = false;
          }
          
          // Safety limit to avoid infinite loops
          if (allTransactions.length > 2000) {
            console.log('[Stripe Brokerage] Transaction limit reached (2000)');
            break;
          }
        }

        console.log(`[Stripe Brokerage] Fetched ${allTransactions.length} total transactions (paginated)`);

        // Sort transactions by date (oldest first) to calculate running positions
        const sortedTxns = [...allTransactions].sort((a, b) => a.transacted_at - b.transacted_at);

        // First pass: collect all unique tickers and dates for price lookups
        const tickerDates = new Map(); // ticker -> Set of dates
        for (const txn of sortedTxns) {
          const type = detectInvestmentTransactionType(txn.description, txn.category);
          const extracted = extractTickerFromDescription(txn.description);
          if ((type === 'buy' || type === 'sell') && extracted?.ticker) {
            const date = new Date(txn.transacted_at * 1000).toISOString().split('T')[0];
            if (!tickerDates.has(extracted.ticker)) tickerDates.set(extracted.ticker, new Set());
            tickerDates.get(extracted.ticker).add(date);
          }
        }

        // Fetch historical prices for all ticker/date combos in parallel
        const priceCache = new Map(); // "TICKER:YYYY-MM-DD" -> price
        const priceFetches = [];
        for (const [ticker, dates] of tickerDates) {
          for (const date of dates) {
            const key = `${ticker}:${date}`;
            priceFetches.push(
              getCloseOnDate(ticker, date).then(p => { if (p) priceCache.set(key, p); })
            );
          }
        }
        await Promise.all(priceFetches);
        console.log(`[Stripe Brokerage] Fetched ${priceCache.size} historical prices for share estimation`);

        // Analyze each transaction with price-based share estimation
        for (const txn of sortedTxns) {
          const type = detectInvestmentTransactionType(txn.description, txn.category);
          const extracted = extractTickerFromDescription(txn.description);
          const quantity = extracted?.quantity || parseQuantityFromDescription(txn.description);
          const amount = Math.abs(txn.amount) / 100;
          const date = new Date(txn.transacted_at * 1000).toISOString().split('T')[0];
          
          if (type === 'buy' && extracted?.ticker) {
            const ticker = extracted.ticker;
            
            // Estimate shares: use parsed quantity, or estimate from amount / price
            let shares = quantity;
            let estimated = false;
            if (!shares) {
              const priceKey = `${ticker}:${date}`;
              const price = priceCache.get(priceKey);
              if (price && price > 0) {
                shares = amount / price;
                estimated = true;
              } else {
                shares = null; // Can't determine
              }
            }
            
            // Initialize holding if new
            if (!holdingsMap.has(ticker)) {
              holdingsMap.set(ticker, { 
                shares: 0, 
                totalCost: 0, 
                transactions: [],
                dividends: [],
                firstBuy: date,
                hasEstimatedShares: false
              });
            }
            
            const holding = holdingsMap.get(ticker);
            if (shares) {
              holding.shares += shares;
              holding.totalCost += amount;
              if (estimated) holding.hasEstimatedShares = true;
            }
            holding.transactions.push({ type: 'buy', date, shares, amount, parsed: !!quantity, estimated });
            
            buyTransactions.push({
              date,
              ticker,
              shares,
              amount,
              parsed: !!quantity,
              estimated,
              description: txn.description
            });
            
            console.log(`[Stripe Brokerage] BUY: ${shares?.toFixed(3) || '?'} ${ticker} for $${amount}${estimated ? ' (est)' : ''}`);
          }
          
          else if (type === 'sell' && extracted?.ticker) {
            const ticker = extracted.ticker;
            
            let shares = quantity;
            let estimated = false;
            if (!shares) {
              const priceKey = `${ticker}:${date}`;
              const price = priceCache.get(priceKey);
              if (price && price > 0) {
                shares = amount / price;
                estimated = true;
              } else {
                shares = null;
              }
            }
            
            if (holdingsMap.has(ticker)) {
              const holding = holdingsMap.get(ticker);
              if (shares) {
                holding.shares -= shares;
                if (estimated) holding.hasEstimatedShares = true;
              }
              holding.transactions.push({ type: 'sell', date, shares, amount, parsed: !!quantity, estimated });
            } else {
              // Sold something we didn't see bought (position before our transaction window)
              holdingsMap.set(ticker, {
                shares: shares ? -shares : 0,
                totalCost: 0,
                transactions: [{ type: 'sell', date, shares, amount, parsed: !!quantity, estimated }],
                dividends: [],
                firstBuy: null,
                hasEstimatedShares: estimated
              });
            }
            
            sellTransactions.push({
              date,
              ticker,
              shares,
              amount,
              parsed: !!quantity,
              estimated,
              description: txn.description
            });
            
            console.log(`[Stripe Brokerage] SELL: ${shares?.toFixed(3) || '?'} ${ticker} for $${amount}${estimated ? ' (est)' : ''}`);
          }
          
          else if (type === 'dividend' && extracted?.ticker) {
            const ticker = extracted.ticker;
            
            // Record dividend (also indicates holding)
            if (!holdingsMap.has(ticker)) {
              holdingsMap.set(ticker, {
                shares: 0, // Unknown shares, but they hold it
                totalCost: 0,
                transactions: [],
                dividends: [{ date, amount }],
                firstBuy: null,
                inferredFromDividend: true
              });
            } else {
              holdingsMap.get(ticker).dividends.push({ date, amount });
            }
            
            dividendTransactions.push({
              date,
              ticker,
              amount,
              description: txn.description
            });
            
            console.log(`[Stripe Brokerage] DIVIDEND: ${ticker} paid $${amount}`);
          }
        }
      } catch (txnErr) {
        console.log('[Stripe Brokerage] Transaction analysis note:', txnErr.message);
      }
    }

    // Dividend-based share inference for tickers with dividends but unknown/zero/negative shares
    // Also try dividend inference for positions where we have estimated buys/sells (as a cross-check)
    const tickersNeedingInference = [];
    for (const [ticker, data] of holdingsMap) {
      const hasDivs = Array.isArray(data.dividends) && data.dividends.length > 0;
      const hasNegativeOrZeroShares = !data.shares || data.shares <= 0;
      const hasEstimatedTransactions = data.hasEstimatedShares;
      
      if (hasDivs && (hasNegativeOrZeroShares || hasEstimatedTransactions)) {
        tickersNeedingInference.push(ticker);
      }
    }

    // Helper to find nearest dividend reference by pay_date within windowDays
    function findNearestDividend(refDivs, txnDateISO, windowDays = 10) {
      const txnDate = new Date(txnDateISO);
      let best = null;
      let bestDiff = Infinity;
      for (const d of refDivs) {
        if (!d.payDate || !d.cashAmount) continue;
        const pay = new Date(d.payDate);
        const diffDays = Math.abs((pay - txnDate) / (1000 * 60 * 60 * 24));
        if (diffDays < bestDiff && diffDays <= windowDays) {
          best = d;
          bestDiff = diffDays;
        }
      }
      return best;
    }

    for (const ticker of tickersNeedingInference) {
      const data = holdingsMap.get(ticker);
      try {
        const refDivs = await getRecentDividends(ticker, 16);
        const perPaymentEstimates = [];
        let earliestDivDate = null;
        let latestDivDate = null;
        
        for (const div of data.dividends) {
          const match = findNearestDividend(refDivs, div.date, 12);
          if (match && match.cashAmount > 0) {
            const estShares = div.amount / match.cashAmount;
            if (isFinite(estShares) && estShares > 0) {
              perPaymentEstimates.push({ shares: estShares, date: div.date });
              if (!earliestDivDate || new Date(div.date) < new Date(earliestDivDate)) {
                earliestDivDate = div.date;
              }
              if (!latestDivDate || new Date(div.date) > new Date(latestDivDate)) {
                latestDivDate = div.date;
              }
            }
          }
        }

        if (perPaymentEstimates.length > 0) {
          // Use the LATEST dividend to estimate CURRENT shares (most recent snapshot)
          // Then apply only transactions AFTER that dividend date
          perPaymentEstimates.sort((a, b) => new Date(a.date) - new Date(b.date));
          
          // Get latest (most recent) dividend estimate
          const latestEstimate = perPaymentEstimates[perPaymentEstimates.length - 1];
          const baselineShares = latestEstimate.shares;
          const baselineDate = latestEstimate.date;
          
          let confidence = perPaymentEstimates.length >= 2 ? 'high' : 'medium';
          const notes = [`Shares from latest div (${baselineDate}): ${baselineShares.toFixed(2)}`];

          // Apply only transactions AFTER the latest dividend date
          const txnsAfterBaseline = (data.transactions || [])
            .filter(t => t.shares && t.date > baselineDate)
            .sort((a, b) => new Date(a.date) - new Date(b.date));
          
          let netChange = 0;
          for (const txn of txnsAfterBaseline) {
            if (txn.type === 'buy') {
              netChange += txn.shares;
            } else if (txn.type === 'sell') {
              netChange -= txn.shares;
            }
          }
          
          let finalShares = Math.max(0, baselineShares + netChange);
          
          // IMPORTANT: Also check the overall price-based net from ALL transactions
          // If user sold significantly more than bought in our ENTIRE window,
          // they likely closed the position even if dividend suggests otherwise
          // (Dividend might reflect shares at ex-date before sells occurred)
          const allTxns = (data.transactions || []).filter(t => t.shares);
          let totalBuys = 0, totalSells = 0;
          for (const txn of allTxns) {
            if (txn.type === 'buy') totalBuys += txn.shares;
            else if (txn.type === 'sell') totalSells += txn.shares;
          }
          const overallNet = totalBuys - totalSells;
          
          // If overall net is very negative (sold much more than bought),
          // position is likely closed regardless of dividend inference
          if (overallNet < -0.5 && totalSells > baselineShares * 0.8) {
            // User sold most/all of what dividend implied they had
            finalShares = Math.max(0, baselineShares + overallNet);
            notes.push(`Overall net: ${overallNet.toFixed(2)} (sold more than bought)`);
            if (finalShares < 0.1) {
              notes.push(`Position appears closed`);
            }
            confidence = 'low'; // Less confident since we're overriding dividend
          } else if (netChange !== 0) {
            notes.push(`Txn change since: ${netChange >= 0 ? '+' : ''}${netChange.toFixed(2)}`);
          }
          
          if (finalShares < 0.01 && baselineShares > 0) {
            notes.push(`Position appears closed`);
          }
          
          data.shares = finalShares;
          data.inferredFromDividend = true;
          data.inference = { confidence, notes };
          
        } else if (!data.shares || data.shares <= 0) {
          // Could not infer from dividends and have no valid shares
          data.inference = { confidence: 'low', notes: ['Unable to match dividend schedule'] };
        }
      } catch (e) {
        if (!data.shares || data.shares <= 0) {
          data.inference = { confidence: 'low', notes: ['Dividend lookup failed'] };
        }
      }
    }

    // For holdings with only price-based estimates (no dividends), mark confidence
    for (const [ticker, data] of holdingsMap) {
      if (!data.inference && data.hasEstimatedShares && data.shares > 0) {
        data.inference = { 
          confidence: 'medium', 
          notes: ['Shares estimated from transaction amounts / historical prices'] 
        };
      }
    }

    // Build final holdings array - only include positions with meaningful shares
    // For price-estimated positions, require higher threshold to filter out rounding errors
    const holdings = [];
    for (const [ticker, data] of holdingsMap) {
      const minThreshold = data.hasEstimatedShares && !data.inferredFromDividend ? 0.5 : 0.01;
      // Only include if we have meaningful shares
      if (data.shares && data.shares > minThreshold) {
        const avgCost = data.totalCost > 0 && data.shares > 0 ? data.totalCost / data.shares : null;
        const totalDividends = data.dividends.reduce((sum, d) => sum + d.amount, 0);
        
        // Determine confidence
        let confidence = data.inference?.confidence || 'medium';
        if (!data.hasEstimatedShares && !data.inferredFromDividend) {
          confidence = 'high'; // Parsed quantities from descriptions
        }
        
        holdings.push({
          ticker,
          shares: Math.round(data.shares * 1000) / 1000, // Round to 3 decimals
          avgCostBasis: avgCost ? Math.round(avgCost * 100) / 100 : null,
          source: data.inferredFromDividend ? 'dividend_inference' : 
                  data.hasEstimatedShares ? 'price_estimation' : 'transaction_parsed',
          firstBuyDate: data.firstBuy,
          totalDividends: totalDividends > 0 ? Math.round(totalDividends * 100) / 100 : null,
          transactionCount: data.transactions.length + data.dividends.length,
          confidence,
          inferenceNotes: data.inference?.notes || undefined
        });
      }
    }
    
    // Collect tickers that had activity but ended up with 0 or negative shares
    // These are likely positions held from before the transaction window
    const undetectedPositions = [];
    for (const [ticker, data] of holdingsMap) {
      if (data.shares <= 0 && data.transactions.length > 0) {
        // Had transactions but net position is negative/zero - might still hold shares
        const sells = data.transactions.filter(t => t.type === 'sell');
        const buys = data.transactions.filter(t => t.type === 'buy');
        if (sells.length > 0) {
          // Calculate net sell value (indicates they held before window)
          const totalSellValue = sells.reduce((sum, s) => sum + (s.amount || 0), 0);
          const totalBuyValue = buys.reduce((sum, b) => sum + (b.amount || 0), 0);
          const netSellValue = totalSellValue - totalBuyValue;
          
          if (netSellValue > 50) { // Only if meaningful net sells
            undetectedPositions.push({
              ticker,
              reason: 'More sells than buys in transaction window',
              netSellValue: Math.round(netSellValue * 100) / 100,
              sellCount: sells.length,
              buyCount: buys.length,
              hint: 'Position held before transaction history began'
            });
          }
        }
      }
    }
    
    // Sort holdings by share count (descending) then ticker
    holdings.sort((a, b) => {
      if (a.shares && b.shares) return b.shares - a.shares;
      if (a.shares) return -1;
      if (b.shares) return 1;
      return a.ticker.localeCompare(b.ticker);
    });

    // Reconciliation against account balance using current prices
    let reconciliation = null;
    try {
      const tickers = holdings.filter(h => h.shares).map(h => h.ticker);
      const priceMap = await getMultipleStockPrices(tickers);
      const totalHoldingsValue = holdings.reduce((sum, h) => {
        const p = priceMap[h.ticker] || 0;
        return sum + (h.shares ? (h.shares * p) : 0);
      }, 0);
      if (balance?.current) {
        const bal = balance.current / 100;
        reconciliation = {
          totalHoldingsValue: Math.round(totalHoldingsValue * 100) / 100,
          balanceCurrent: bal,
          discrepancy: Math.round((bal - totalHoldingsValue) * 100) / 100,
          undetectedPositions: undetectedPositions.length > 0 ? undetectedPositions : undefined,
          asOf: balance.as_of ? new Date(balance.as_of * 1000).toISOString() : null
        };
      }
    } catch (e) {
      // ignore reconciliation errors
    }

    console.log(`[Stripe Brokerage] Final holdings: ${holdings.length}`, holdings.map(h => `${h.ticker}:${h.shares}`));
    if (undetectedPositions.length > 0) {
      console.log(`[Stripe Brokerage] Undetected positions: ${undetectedPositions.map(p => p.ticker).join(', ')}`);
    }

    res.json({
      ok: true,
      accountInfo: {
        id: account.id,
        institutionName: account.institution_name,
        displayName: account.display_name,
        last4: account.last4,
        category: account.category,
        subcategory: account.subcategory
      },
      balance: balance ? {
        current: balance.current / 100,
        cash: balance.cash?.available / 100 || null,
        asOf: balance.as_of ? new Date(balance.as_of * 1000).toISOString() : null
      } : null,
      holdings,
      transactionSummary: {
        totalBuys: buyTransactions.length,
        totalSells: sellTransactions.length,
        totalDividends: dividendTransactions.length,
        analyzedTransactions: buyTransactions.length + sellTransactions.length + dividendTransactions.length
      },
      recentBuys: buyTransactions.slice(-10),
      recentSells: sellTransactions.slice(-10),
      recentDividends: dividendTransactions.slice(-10),
      reconciliation,
      message: holdings.length > 0 
        ? `Found ${holdings.length} holdings from analyzing ${buyTransactions.length} buys, ${sellTransactions.length} sells, and ${dividendTransactions.length} dividends`
        : 'Account connected but no stock transactions found. Holdings may need manual entry.',
      note: 'Holdings calculated from buy/sell transaction history. Share counts may be incomplete if transactions predate the available history window.'
    });

  } catch (error) {
    console.error('[Stripe Brokerage] Error importing holdings:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// ============================================================================
// CHECKING ACCOUNT CONNECTION & EXPENSE CATEGORIZATION
// ============================================================================

/**
 * POST /api/stripe-connect/create-checking-session
 * Create a Financial Connections session specifically for checking/bank accounts
 * Used for expense tracking and FI projection
 */
router.post('/create-checking-session', async (req, res) => {
  try {
    const { userId, userEmail, accountLabel } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required' });
    }

    console.log('[Stripe Checking] Creating FC session for checking account, user:', userId, 'label:', accountLabel);

    // Create or retrieve a Stripe Customer
    let customer;
    const customerEmail = userEmail || `checking-${userId}@placeholder.com`;

    try {
      const customers = await stripe.customers.list({ limit: 10, email: customerEmail });
      const brokerageCustomers = await stripe.customers.list({ limit: 10, email: `brokerage-${userId}@placeholder.com` });
      
      if (customers.data.length > 0) {
        customer = customers.data[0];
      } else if (brokerageCustomers.data.length > 0) {
        customer = brokerageCustomers.data[0];
      } else {
        customer = await stripe.customers.create({
          email: customerEmail,
          metadata: { userId, purpose: 'checking-connection' }
        });
      }
    } catch (customerError) {
      console.error('[Stripe Checking] Error with customer:', customerError);
      throw new Error('Failed to create/retrieve customer');
    }

    const session = await stripe.financialConnections.sessions.create({
      account_holder: {
        type: 'customer',
        customer: customer.id,
      },
      permissions: ['balances', 'transactions', 'ownership'],
      filters: {
        countries: ['US'],
      },
      prefetch: ['balances'],
    });

    console.log('[Stripe Checking] Session created:', session.id);

    res.json({
      ok: true,
      sessionId: session.id,
      clientSecret: session.client_secret,
      customerId: customer.id,
    });
  } catch (error) {
    console.error('[Stripe Checking] Error creating session:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/stripe-connect/checking-accounts/:userId
 * Get all connected checking/savings accounts for a user
 */
router.get('/checking-accounts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Find customers associated with this user
    const emails = [
      `checking-${userId}@placeholder.com`,
      `brokerage-${userId}@placeholder.com`,
      `tenant-${userId}@placeholder.com`,
    ];

    let allAccounts = [];

    for (const email of emails) {
      const customers = await stripe.customers.list({ limit: 5, email });
      for (const customer of customers.data) {
        try {
          const accounts = await stripe.financialConnections.accounts.list({
            account_holder: { customer: customer.id },
          });
          const checkingAccounts = accounts.data.filter(
            acc => acc.subcategory === 'checking' || acc.subcategory === 'savings'
          );
          allAccounts.push(...checkingAccounts.map(acc => ({
            id: acc.id,
            institutionName: acc.institution_name,
            displayName: acc.display_name || acc.institution_name,
            last4: acc.last4,
            status: acc.status,
            category: acc.category,
            subcategory: acc.subcategory,
            balance: acc.balance_refresh ? {
              current: (acc.balance?.current || 0) / 100,
              available: (acc.balance?.available || 0) / 100,
              asOf: acc.balance_refresh?.last_attempted_at,
            } : null,
          })));
        } catch (err) {
          console.log('[Stripe Checking] Skipping customer:', customer.id, err.message);
        }
      }
    }

    // Deduplicate by account ID
    const uniqueAccounts = [...new Map(allAccounts.map(a => [a.id, a])).values()];

    res.json({
      ok: true,
      accounts: uniqueAccounts,
      count: uniqueAccounts.length,
    });
  } catch (error) {
    console.error('[Stripe Checking] Error fetching accounts:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/stripe-connect/disconnect-checking
 * Disconnect a linked checking or savings account
 */
router.post('/disconnect-checking', async (req, res) => {
  try {
    const { userId, accountId } = req.body;

    if (!userId || !accountId) {
      return res.status(400).json({
        ok: false,
        error: 'userId and accountId are required'
      });
    }

    console.log('[Stripe Checking] Disconnecting account:', accountId, 'for user:', userId);

    try {
      await stripe.financialConnections.accounts.disconnect(accountId);
      console.log('[Stripe Checking] Successfully disconnected account:', accountId);
    } catch (disconnectError) {
      console.error('[Stripe Checking] Disconnect error:', disconnectError.message);
    }

    res.json({
      ok: true,
      message: 'Checking account disconnected successfully'
    });
  } catch (error) {
    console.error('[Stripe Checking] Error disconnecting account:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/stripe-connect/checking-transactions/:accountId
 * Fetch the past year of transactions for a checking account
 */
router.get('/checking-transactions/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const months = parseInt(req.query.months) || 12;
    
    console.log('[Stripe Checking] Fetching transactions for account:', accountId, 'months:', months);

    const account = await stripe.financialConnections.accounts.retrieve(accountId);

    // Subscribe + refresh transactions
    try {
      await stripe.financialConnections.accounts.subscribe(accountId, { features: ['transactions'] });
    } catch (e) { /* already subscribed */ }
    
    try {
      await stripe.financialConnections.accounts.refresh(accountId, { features: ['transactions'] });
    } catch (e) { /* refresh in progress */ }

    // Fetch all transactions (paginate to get full year)
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - months);
    
    let allTransactions = [];
    let hasMore = true;
    let startingAfter = undefined;

    while (hasMore) {
      const params = { account: accountId, limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      
      const txnPage = await stripe.financialConnections.transactions.list(params);
      
      const filtered = txnPage.data.filter(txn => {
        const txnDate = new Date(txn.transacted_at * 1000);
        return txnDate >= cutoffDate;
      });
      
      allTransactions.push(...filtered);
      
      // Stop if we've gone past our date range or no more pages
      if (!txnPage.has_more || filtered.length < txnPage.data.length) {
        hasMore = false;
      } else {
        startingAfter = txnPage.data[txnPage.data.length - 1].id;
      }
    }

    const formattedTransactions = allTransactions.map(txn => ({
      id: txn.id,
      amount: txn.amount / 100,
      description: txn.description || 'No description',
      date: new Date(txn.transacted_at * 1000).toISOString().split('T')[0],
      status: txn.status,
      type: txn.amount < 0 ? 'expense' : 'income',
      category: txn.category || 'uncategorized',
    }));

    res.json({
      ok: true,
      transactions: formattedTransactions,
      count: formattedTransactions.length,
      accountInfo: {
        id: account.id,
        institutionName: account.institution_name,
        displayName: account.display_name,
      },
    });
  } catch (error) {
    console.error('[Stripe Checking] Error fetching transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/stripe-connect/categorize-expenses
 * Use Gemini AI to categorize bank transactions into expense/income categories
 * Returns averaged monthly breakdown for FI projection
 */
router.post('/categorize-expenses', async (req, res) => {
  try {
    const { transactions, userId } = req.body;

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ ok: false, error: 'transactions array is required' });
    }

    console.log('[Expense Categorization] Categorizing', transactions.length, 'transactions with Gemini', userId ? `for user ${userId}` : '');

    // Dynamically import Gemini
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Batch transactions in chunks for Gemini (avoid token limits)
    const CHUNK_SIZE = 200;
    const chunks = [];
    for (let i = 0; i < transactions.length; i += CHUNK_SIZE) {
      chunks.push(transactions.slice(i, i + CHUNK_SIZE));
    }

    let allCategorized = [];

    for (const chunk of chunks) {
      const txnList = chunk.map((t, i) => 
        `${i + 1}. ${t.date} | ${t.type === 'expense' ? '-' : '+'}$${Math.abs(t.amount).toFixed(2)} | ${t.description}`
      ).join('\n');

      const prompt = `You are a personal finance categorization engine. Categorize each bank transaction into EXACTLY one of these categories.

EXPENSE CATEGORIES:
- Housing (rent, mortgage, HOA)
- Utilities (electric, gas, water, internet, phone)
- Groceries (supermarkets, grocery stores)
- Dining (restaurants, fast food, coffee shops, bars)
- Transportation (gas, car payment, insurance, parking, rideshare, transit)
- Healthcare (doctor, pharmacy, dental, vision, health insurance)
- Entertainment (streaming, movies, games, concerts, hobbies)
- Shopping (clothing, electronics, home goods, Amazon)
- Insurance (life, renters, umbrella - not health/auto)
- Education (tuition, books, courses)
- Personal Care (gym, salon, spa)
- Subscriptions (software, memberships, recurring charges)
- Childcare (daycare, school supplies)
- Pet (vet, pet food, pet supplies)
- Travel (hotels, flights, vacation)
- Gifts & Donations (charity, gifts)
- Miscellaneous (anything that doesn't fit above)

INCOME CATEGORIES:
- Salary (paycheck, direct deposit from employer)
- Freelance (contract payments, side gig income)
- Investment (dividends, interest, capital gains)
- Rental (rental income received)
- Refund (returns, reimbursements)
- Transfer (internal transfers between own accounts - EXCLUDE from expenses)
- Other Income

IMPORTANT RULES:
1. Internal transfers between accounts should be categorized as "Transfer"
2. ATM withdrawals categorize as "Miscellaneous"
3. Venmo/Zelle/CashApp payments: use description context to categorize, default to "Miscellaneous"
4. Credit card payments categorize as "Transfer"

Respond with a JSON array. Each entry: {"index": <number>, "category": "<category name>", "isTransfer": <boolean>}

Transactions:
${txnList}

Return ONLY the JSON array, no other text.`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      // Parse JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        try {
          const categorized = JSON.parse(jsonMatch[0]);
          // Merge with original transaction data
          categorized.forEach(cat => {
            const originalTxn = chunk[cat.index - 1];
            if (originalTxn) {
              allCategorized.push({
                ...originalTxn,
                aiCategory: cat.category,
                isTransfer: cat.isTransfer || false,
              });
            }
          });
        } catch (parseErr) {
          console.error('[Expense Categorization] JSON parse error:', parseErr.message);
          // Fall back: assign uncategorized
          chunk.forEach(t => allCategorized.push({ ...t, aiCategory: 'Miscellaneous', isTransfer: false }));
        }
      } else {
        chunk.forEach(t => allCategorized.push({ ...t, aiCategory: 'Miscellaneous', isTransfer: false }));
      }
    }

    // Filter out transfers
    const nonTransfers = allCategorized.filter(t => !t.isTransfer);
    
    // Separate expenses and income
    const expenses = nonTransfers.filter(t => t.amount < 0 || t.type === 'expense');
    const income = nonTransfers.filter(t => t.amount > 0 && t.type === 'income');

    // Calculate monthly averages by category
    const months = new Set(nonTransfers.map(t => t.date.substring(0, 7)));
    const numMonths = Math.max(months.size, 1);

    // Aggregate expenses by category
    const expenseByCategory = {};
    expenses.forEach(t => {
      const cat = t.aiCategory || 'Miscellaneous';
      if (!expenseByCategory[cat]) expenseByCategory[cat] = { total: 0, count: 0, transactions: [] };
      expenseByCategory[cat].total += Math.abs(t.amount);
      expenseByCategory[cat].count += 1;
      expenseByCategory[cat].transactions.push(t);
    });

    // Build category breakdown
    const totalExpenses = Object.values(expenseByCategory).reduce((sum, c) => sum + c.total, 0);
    const categoryBreakdown = Object.entries(expenseByCategory)
      .map(([category, data]) => ({
        category,
        totalAmount: data.total,
        monthlyAverage: data.total / numMonths,
        transactionCount: data.count,
        percentage: totalExpenses > 0 ? (data.total / totalExpenses) * 100 : 0,
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);

    // Aggregate income by category
    const incomeByCategory = {};
    income.forEach(t => {
      const cat = t.aiCategory || 'Other Income';
      if (!incomeByCategory[cat]) incomeByCategory[cat] = { total: 0, count: 0 };
      incomeByCategory[cat].total += t.amount;
      incomeByCategory[cat].count += 1;
    });

    const totalIncome = Object.values(incomeByCategory).reduce((sum, c) => sum + c.total, 0);
    const incomeBreakdown = Object.entries(incomeByCategory)
      .map(([category, data]) => ({
        category,
        totalAmount: data.total,
        monthlyAverage: data.total / numMonths,
        transactionCount: data.count,
        percentage: totalIncome > 0 ? (data.total / totalIncome) * 100 : 0,
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);

    const monthlyExpenseTotal = totalExpenses / numMonths;
    const monthlyIncomeTotal = totalIncome / numMonths;

    console.log('[Expense Categorization] Done.', categoryBreakdown.length, 'expense categories,', incomeBreakdown.length, 'income categories');
    console.log('[Expense Categorization] Monthly expenses:', monthlyExpenseTotal.toFixed(2), 'Monthly income:', monthlyIncomeTotal.toFixed(2));

    // Include individual categorized transactions so the frontend can filter by date
    const categorizedTransactions = allCategorized.map(t => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: t.amount,
      type: t.type,
      aiCategory: t.aiCategory,
      isTransfer: t.isTransfer || false,
    }));

    const parseTransactionDate = (dateValue) => {
      const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || '');
      if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch;
        return new Date(Number(year), Number(month) - 1, Number(day));
      }

      return new Date(dateValue);
    };

    const getReferenceMonthDate = (items) => {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();

      const hasCurrentMonthData = items.some((item) => {
        const transactionDate = parseTransactionDate(item.date);
        return !Number.isNaN(transactionDate.getTime())
          && transactionDate.getFullYear() === currentYear
          && transactionDate.getMonth() === currentMonth;
      });

      if (hasCurrentMonthData) {
        return new Date(currentYear, currentMonth, 1);
      }

      let latestDate = null;
      items.forEach((item) => {
        const transactionDate = parseTransactionDate(item.date);
        if (!Number.isNaN(transactionDate.getTime()) && (!latestDate || transactionDate > latestDate)) {
          latestDate = transactionDate;
        }
      });

      return latestDate
        ? new Date(latestDate.getFullYear(), latestDate.getMonth(), 1)
        : new Date(currentYear, currentMonth, 1);
    };

    const buildPeriodSummary = (items, monthDate) => {
      const year = monthDate.getFullYear();
      const month = monthDate.getMonth();
      const filtered = items.filter((item) => {
        const transactionDate = parseTransactionDate(item.date);
        return !Number.isNaN(transactionDate.getTime())
          && transactionDate.getFullYear() === year
          && transactionDate.getMonth() === month;
      });

      const expenseTotal = filtered
        .filter((item) => !item.isTransfer && (item.amount < 0 || item.type === 'expense'))
        .reduce((sum, item) => sum + Math.abs(item.amount), 0);

      const incomeTotal = filtered
        .filter((item) => !item.isTransfer && item.amount > 0 && item.type === 'income')
        .reduce((sum, item) => sum + item.amount, 0);

      return {
        monthKey: `${year}-${String(month + 1).padStart(2, '0')}`,
        label: monthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        expenseTotal,
        incomeTotal,
        transactionCount: filtered.length,
      };
    };

    const referenceMonthDate = getReferenceMonthDate(categorizedTransactions);
    const previousMonthDate = new Date(referenceMonthDate.getFullYear(), referenceMonthDate.getMonth() - 1, 1);
    const periodSummaries = {
      thisMonth: buildPeriodSummary(categorizedTransactions, referenceMonthDate),
      lastMonth: buildPeriodSummary(categorizedTransactions, previousMonthDate),
    };

    const responseData = {
      ok: true,
      summary: {
        totalTransactions: transactions.length,
        categorizedTransactions: allCategorized.length,
        excludedTransfers: allCategorized.length - nonTransfers.length,
        monthsCovered: numMonths,
        monthlyExpenseTotal,
        monthlyIncomeTotal,
        annualExpenseTotal: totalExpenses,
        annualIncomeTotal: totalIncome,
      },
      expenseCategories: categoryBreakdown,
      incomeCategories: incomeBreakdown,
      categorizedTransactions,
      periodSummaries,
    };

    // Save to Firestore under the user's account if userId is provided
    if (userId) {
      try {
        const { initializeFirebaseAdmin } = await import('./firebase-admin.js');
        const admin = initializeFirebaseAdmin();
        const db = admin.firestore();

        await db.collection('users').doc(userId).collection('expenseData').doc('latest').set({
          summary: responseData.summary,
          expenseCategories: responseData.expenseCategories,
          incomeCategories: responseData.incomeCategories,
          categorizedTransactions: responseData.categorizedTransactions,
          periodSummaries: responseData.periodSummaries,
          updatedAt: new Date().toISOString(),
          source: 'stripe-financial-connections',
        });

        console.log(`[Expense Categorization] ✅ Saved expense data to Firestore for user ${userId}`);
      } catch (firestoreErr) {
        console.error('[Expense Categorization] ⚠️ Failed to save to Firestore:', firestoreErr.message);
        // Don't fail the request — still return the data
      }
    }

    res.json(responseData);
  } catch (error) {
    console.error('[Expense Categorization] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/stripe-connect/project-rental-analytics
 * Categorize property transactions and derive projected analytics inputs.
 * When useSampleData=true, loads a built-in single-family rental fixture.
 */
router.post('/project-rental-analytics', async (req, res) => {
  try {
    const { useSampleData = false, transactions, propertyProfile, userId, propertyId } = req.body || {};

    let analyticsProfile = propertyProfile;
    let sourceTransactions = transactions;

    if (useSampleData) {
      const {
        DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
        buildRentalAnalyticsSampleFromFixture,
        loadAccountingFixtureDefinition,
      } = await import('./accounting-fixtures/index.js');
      const fixture = await loadAccountingFixtureDefinition(DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME);
      const sampleFixture = buildRentalAnalyticsSampleFromFixture(fixture);
      analyticsProfile = sampleFixture;
      sourceTransactions = sampleFixture.transactions;

      if (userId) {
        try {
          const { initializeFirebaseAdmin } = await import('./firebase-admin.js');
          const admin = initializeFirebaseAdmin();
          const db = admin.firestore();
          const sampleCacheDocId = `sample-feed-${propertyId || 'portfolio'}`;
          const cachedDoc = await db.collection('users').doc(userId).collection('expenseData').doc(sampleCacheDocId).get();

          if (cachedDoc.exists) {
            const cached = cachedDoc.data();
            if (cached?.response) {
              return res.json({ ok: true, cached: true, ...cached.response });
            }
          }
        } catch (cacheError) {
          console.warn('[Rental Analytics] Failed to read sample-feed cache:', cacheError.message);
        }
      }
    }

    if (!analyticsProfile || !analyticsProfile.attomData || !Array.isArray(sourceTransactions) || sourceTransactions.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'propertyProfile with attomData and a non-empty transactions array are required'
      });
    }

    const normalizedTransactions = sourceTransactions.map((transaction, index) => ({
      id: transaction.id || `rental-analytics-${index + 1}`,
      date: transaction.date,
      amount: Number(transaction.amount || 0),
      description: transaction.description || '',
      vendor: transaction.vendor || null,
      source: transaction.source || 'BANK'
    }));

    const { categorizedTransactions, provider } = await categorizeRentalTransactionsWithClaude(normalizedTransactions);
    const payload = deriveRentalProjectionPayload(analyticsProfile, categorizedTransactions, provider);

    const fullAddress = payload.propertyDashboard?.summary?.address || [payload.property?.address, payload.property?.location].filter(Boolean).join(', ');
    const attomId = analyticsProfile?.attomData?.summary?.attom_id || null;
    if (fullAddress) {
      mergeAttomDerivedData(fullAddress, {
        financialInputs: payload.financialInputs,
        summary: payload.summary,
        calculationBreakdown: payload.calculationBreakdown,
        aiProvider: payload.aiProvider,
        source: useSampleData ? 'sample-property-fixture' : 'transactions'
      }, attomId).catch((error) => {
        console.warn('[Rental Analytics] Failed to cache derived analytics:', error.message);
      });
    }

    payload.propertyDashboard = {
      ...(payload.propertyDashboard || {}),
      analyticsProjection: {
        ...(payload.propertyDashboard?.analyticsProjection || {}),
        financialInputs: payload.financialInputs,
        summary: payload.summary,
        calculationBreakdown: payload.calculationBreakdown,
        aiProvider: payload.aiProvider,
        source: useSampleData ? 'sample-property-fixture' : 'transactions'
      }
    };

    const responsePayload = {
      ok: true,
      source: useSampleData ? 'sample-property-fixture' : 'transactions',
      ...payload,
      bookkeeping: {
        transactions: payload.categorizedTransactions,
        categories: payload.expenseCategories,
        cashflowTrend: payload.monthlyTrend,
        upcomingBills: payload.upcomingBills
      }
    };

    if (useSampleData && userId) {
      try {
        const { initializeFirebaseAdmin } = await import('./firebase-admin.js');
        const admin = initializeFirebaseAdmin();
        const db = admin.firestore();
        const sampleCacheDocId = `sample-feed-${propertyId || 'portfolio'}`;

        await db.collection('users').doc(userId).collection('expenseData').doc(sampleCacheDocId).set({
          response: responsePayload,
          propertyId: propertyId || null,
          source: 'sample-property-fixture',
          updatedAt: new Date().toISOString(),
        });
      } catch (cacheError) {
        console.warn('[Rental Analytics] Failed to cache sample-feed response:', cacheError.message);
      }
    }

    res.json(responsePayload);
  } catch (error) {
    console.error('[Rental Analytics] Error projecting analytics:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/stripe-connect/expense-data/:userId
 * Load saved expense categorization data from Firestore for a user
 */
router.get('/expense-data/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required' });
    }

    const { initializeFirebaseAdmin } = await import('./firebase-admin.js');
    const admin = initializeFirebaseAdmin();
    const db = admin.firestore();

    const doc = await db.collection('users').doc(userId).collection('expenseData').doc('latest').get();

    if (!doc.exists) {
      return res.json({ ok: false, notFound: true, message: 'No saved expense data found' });
    }

    const data = doc.data();
    console.log(`[Expense Data] ✅ Loaded saved expense data for user ${userId} (${data.summary?.totalTransactions || 0} transactions)`);

    res.json({
      ok: true,
      summary: data.summary,
      expenseCategories: data.expenseCategories,
      incomeCategories: data.incomeCategories,
      categorizedTransactions: data.categorizedTransactions || [],
      periodSummaries: data.periodSummaries || null,
      updatedAt: data.updatedAt,
    });
  } catch (error) {
    console.error('[Expense Data] Error loading:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// RECURRING ACH AUTO-PAY - Stripe Subscriptions for Recurring Rent Payments
// ============================================================================

/**
 * POST /api/stripe-connect/setup-autopay
 * Creates a Stripe Checkout session (mode: setup) so a tenant can save their
 * ACH bank account with a NACHA-compliant mandate for future off-session charges.
 */
router.post('/setup-autopay', async (req, res) => {
  try {
    const { accountId, tenantEmail, tenantName, propertyAddress, amount } = req.body;

    if (!accountId || !tenantEmail || !amount) {
      return res.status(400).json({ ok: false, error: 'accountId, tenantEmail, and amount are required' });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    }

    // Create or retrieve a Stripe Customer for this tenant (on the platform account)
    const customers = await stripe.customers.list({ email: tenantEmail, limit: 10 });
    let customer = customers.data.find(c => c.metadata?.type === 'tenant') || customers.data[0];

    if (!customer) {
      customer = await stripe.customers.create({
        email: tenantEmail,
        name: tenantName || undefined,
        metadata: {
          type: 'tenant',
          landlordAccountId: accountId,
          propertyAddress: propertyAddress || ''
        }
      });
    } else {
      await stripe.customers.update(customer.id, {
        metadata: {
          ...customer.metadata,
          type: 'tenant',
          landlordAccountId: accountId,
          propertyAddress: propertyAddress || ''
        }
      });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    const session = await stripe.checkout.sessions.create(
      buildTenantAutopaySetupSessionParams({
        customerId: customer.id,
        successUrl: `${baseUrl}/tenant/dashboard?autopay=success&setup_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/tenant/dashboard?autopay=cancelled`,
        setupIntentMetadata: {
          tenantEmail,
          tenantName: tenantName || '',
          propertyAddress: propertyAddress || '',
          landlordAccountId: accountId,
          monthlyAmount: String(amountNum)
        },
        metadata: {
          tenantEmail,
          landlordAccountId: accountId,
          monthlyAmount: String(amountNum),
          propertyAddress: propertyAddress || ''
        }
      })
    );

    res.json({ ok: true, url: session.url, sessionId: session.id, customerId: customer.id });
    console.log('[Stripe Autopay] Created setup session:', session.id, 'for tenant:', tenantEmail);
  } catch (error) {
    console.error('[Stripe Autopay] Error creating setup session:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/stripe-connect/create-subscription
 * After the tenant's bank account is verified via the setup flow, create a monthly
 * Stripe Subscription that transfers funds to the landlord's connected account.
 * Call this with the setup_session_id returned from the /setup-autopay success redirect.
 */
router.post('/create-subscription', async (req, res) => {
  try {
    const { setupSessionId, customerId: bodyCustomerId, accountId, amount, propertyAddress, tenantEmail, ownerId, tenantId } = req.body;

    // Derive customerId from the setup session if not explicitly provided
    let customerId = bodyCustomerId;
    let paymentMethodId;
    let resolvedAccountId = accountId || '';
    let resolvedPropertyAddress = propertyAddress || '';
    let resolvedTenantEmail = tenantEmail || '';
    let resolvedAmountRaw = amount;

    if (setupSessionId) {
      const session = await stripe.checkout.sessions.retrieve(setupSessionId, {
        expand: ['setup_intent.payment_method']
      });
      const sessionMetadata = session.metadata || {};
      if (!customerId) customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const si = session.setup_intent;
      const setupIntentMetadata = typeof si === 'object' && si ? si.metadata || {} : {};
      resolvedAccountId = resolvedAccountId || sessionMetadata.landlordAccountId || setupIntentMetadata.landlordAccountId || '';
      resolvedPropertyAddress = resolvedPropertyAddress || sessionMetadata.propertyAddress || setupIntentMetadata.propertyAddress || '';
      resolvedTenantEmail = resolvedTenantEmail || sessionMetadata.tenantEmail || setupIntentMetadata.tenantEmail || session.customer_details?.email || session.customer_email || '';
      resolvedAmountRaw = resolvedAmountRaw || sessionMetadata.monthlyAmount || setupIntentMetadata.monthlyAmount || null;
      if (si && si.payment_method) {
        paymentMethodId = typeof si.payment_method === 'string'
          ? si.payment_method
          : si.payment_method.id;
      }
    }

    if (!resolvedAccountId) {
      return res.status(400).json({ ok: false, error: 'accountId is required' });
    }

    const amountNum = parseFloat(resolvedAmountRaw);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    }

    if (!customerId) {
      // Last resort: look up by email
      if (resolvedTenantEmail) {
        const customers = await stripe.customers.list({ email: resolvedTenantEmail, limit: 5 });
        const match = customers.data.find(c => c.metadata?.type === 'tenant') || customers.data[0];
        if (match) customerId = match.id;
      }
      if (!customerId) {
        return res.status(400).json({ ok: false, error: 'Could not identify Stripe customer. Please try setting up auto-pay again.' });
      }
    }

    if (!paymentMethodId) {
      // Fall back to the customer's default payment method
      const customer = await stripe.customers.retrieve(customerId);
      paymentMethodId = typeof customer === 'object' && !customer.deleted
        ? getStripeResourceId(customer.invoice_settings?.default_payment_method)
        : null;
    }

    if (!paymentMethodId) {
      return res.status(400).json({
        ok: false,
        error: 'No saved payment method found. Please complete the bank account setup first.'
      });
    }

    await ensureUsBankAccountPaymentMethod(paymentMethodId);

    // Attach the payment method to the customer if not already attached
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch (e) {
      // Already attached — safe to ignore
    }

    // Set as customer's default invoice payment method
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    const existingSubscription = await findExistingAutopaySubscription(customerId, resolvedAccountId);
    if (existingSubscription) {
      let subscription = existingSubscription;

      if (getStripeResourceId(existingSubscription.default_payment_method) !== paymentMethodId) {
        subscription = await stripe.subscriptions.update(existingSubscription.id, {
          default_payment_method: paymentMethodId,
          payment_settings: {
            payment_method_types: ['us_bank_account'],
            save_default_payment_method: 'on_subscription'
          }
        });
      }

      const nextPaymentDate = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString().split('T')[0]
        : null;
      const receiptUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/autopay-receipt?subscriptionId=${subscription.id}&tenantEmail=${encodeURIComponent(resolvedTenantEmail || '')}`;

      return res.json({
        ok: true,
        subscriptionId: subscription.id,
        status: subscription.status,
        nextPaymentDate,
        receiptUrl,
        existing: true
      });
    }

    // Create a one-off Price for this rent amount
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: Math.round(amountNum * 100),
      recurring: { interval: 'month' },
      product_data: {
        name: resolvedPropertyAddress ? `Monthly Rent - ${resolvedPropertyAddress}` : 'Monthly Rent'
      }
    });

    // Anchor billing to the 1st of the next calendar month
    const now = new Date();
    const billingAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const billingAnchorTimestamp = Math.floor(billingAnchor.getTime() / 1000);

    const subscription = await stripe.subscriptions.create(
      buildTenantAutopaySubscriptionParams({
        customerId,
        priceId: price.id,
        paymentMethodId,
        billingAnchorTimestamp,
        accountId: resolvedAccountId,
        metadata: {
          tenantEmail: resolvedTenantEmail || '',
          propertyAddress: resolvedPropertyAddress || '',
          landlordAccountId: resolvedAccountId,
          ownerId: ownerId || '',
          tenantId: tenantId || ''
        }
      })
    );

    const nextPaymentDate = billingAnchor.toISOString().split('T')[0];
    const receiptUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/autopay-receipt?subscriptionId=${subscription.id}&tenantEmail=${encodeURIComponent(resolvedTenantEmail || '')}`;

    res.json({
      ok: true,
      subscriptionId: subscription.id,
      status: subscription.status,
      nextPaymentDate,
      receiptUrl
    });
    console.log('[Stripe Autopay] Created subscription:', subscription.id, 'status:', subscription.status, 'tenant:', resolvedTenantEmail);

    // Send confirmation email (non-blocking)
    if (resolvedTenantEmail) {
      const fmt = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const amtFmt = `$${amountNum.toFixed(2)}`;
      sendHtmlEmail({
        to: resolvedTenantEmail,
        subject: 'Auto-Pay Confirmed — Your Monthly Rent Payments Are Set Up',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#2563eb;padding:32px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:24px">Auto-Pay Confirmed</h1>
              <p style="color:#bfdbfe;margin:8px 0 0">Your recurring rent payments are active</p>
            </div>
            <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;background:#fff">
              <p style="font-size:16px">Hi ${resolvedTenantEmail},</p>
              <p>Your automatic rent payments have been successfully set up. Here are the details:</p>
              <table style="width:100%;border-collapse:collapse;margin:24px 0">
                <tr style="background:#f8fafc"><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb;width:45%">Monthly Amount</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;font-size:18px;font-weight:700;color:#2563eb">${amtFmt}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Property</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">${resolvedPropertyAddress || 'Your rental property'}</td></tr>
                <tr style="background:#f8fafc"><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">First Payment Date</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">${fmt(nextPaymentDate)}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Payment Day</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">1st of each month</td></tr>
                <tr style="background:#f8fafc"><td style="padding:12px 16px;font-weight:600">Subscription ID</td><td style="padding:12px 16px;font-family:monospace;font-size:13px">${subscription.id}</td></tr>
              </table>
              <div style="text-align:center;margin:32px 0">
                <a href="${receiptUrl}" style="background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">View Full Receipt</a>
              </div>
              <p style="font-size:13px;color:#6b7280">You can cancel auto-pay at any time from the Payments section of your tenant portal. Payments are processed securely via Stripe.</p>
            </div>
          </div>
        `
      }).catch(e => console.error('[Stripe Autopay] Email send failed:', e.message));
    }
  } catch (error) {
    console.error('[Stripe Autopay] Error creating subscription:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/stripe-connect/autopay-status?tenantEmail=...&accountId=...
 * Returns the active subscription and saved payment method for a tenant.
 */
router.get('/autopay-status', async (req, res) => {
  try {
    const { tenantEmail, accountId } = req.query;

    if (!tenantEmail) {
      return res.status(400).json({ ok: false, error: 'tenantEmail is required' });
    }

    const customers = await stripe.customers.list({ email: String(tenantEmail), limit: 10 });
    const customer = customers.data.find(c => c.metadata?.type === 'tenant') || customers.data[0];

    if (!customer) {
      return res.json({ ok: true, hasAutoPay: false, subscription: null, paymentMethod: null });
    }

    // Find subscription, filtering by landlord account when provided
    const allSubs = await stripe.subscriptions.list({ customer: customer.id, limit: 10 });
    const liveSub = allSubs.data.find(s =>
      isLiveAutopaySubscription(s)
      && (!accountId || s.metadata?.landlordAccountId === String(accountId))
    );
    const activeSub = liveSub
      || allSubs.data.find(s => !accountId || s.metadata?.landlordAccountId === String(accountId));

    // Retrieve saved payment method details
    let paymentMethodInfo = null;
    const pmId = customer.invoice_settings?.default_payment_method ||
      activeSub?.default_payment_method;
    if (pmId) {
      try {
        const pm = await stripe.paymentMethods.retrieve(String(pmId));
        if (pm.us_bank_account) {
          paymentMethodInfo = {
            type: 'us_bank_account',
            bankName: pm.us_bank_account.bank_name,
            last4: pm.us_bank_account.last4,
            accountType: pm.us_bank_account.account_type
          };
        } else if (pm.card) {
          paymentMethodInfo = { type: 'card', brand: pm.card.brand, last4: pm.card.last4 };
        }
      } catch (_e) {
        // Ignore retrieval errors
      }
    }

    // Fetch last paid invoice for this subscription
    let lastPayment = null;
    if (activeSub) {
      try {
        const invoices = await stripe.invoices.list({
          customer: customer.id,
          subscription: activeSub.id,
          status: 'paid',
          limit: 1
        });
        if (invoices.data.length > 0) {
          const inv = invoices.data[0];
          lastPayment = {
            amount: inv.amount_paid / 100,
            date: new Date(inv.status_transitions.paid_at * 1000).toISOString().split('T')[0]
          };
        }
      } catch (_e) { /* non-critical */ }
    }

    res.json({
      ok: true,
      hasAutoPay: !!liveSub,
      subscription: activeSub ? {
        id: activeSub.id,
        status: activeSub.status,
        amount: (activeSub.items.data[0]?.price?.unit_amount ?? 0) / 100,
        nextPaymentDate: new Date(activeSub.current_period_end * 1000).toISOString().split('T')[0],
        createdAt: new Date(activeSub.created * 1000).toISOString(),
        cancelAtPeriodEnd: !!activeSub.cancel_at_period_end,
        cancelAt: (activeSub.cancel_at || activeSub.current_period_end)
          ? new Date((activeSub.cancel_at || activeSub.current_period_end) * 1000).toISOString().split('T')[0]
          : null,
        dayOfMonth: 1
      } : null,
      paymentMethod: paymentMethodInfo,
      customerId: customer.id,
      lastPayment
    });
  } catch (error) {
    console.error('[Stripe Autopay] Error checking autopay status:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/stripe-connect/cancel-subscription/:subscriptionId
 * Cancels a tenant's recurring autopay subscription at period end.
 */
router.delete('/cancel-subscription/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    if (!subscriptionId) {
      return res.status(400).json({ ok: false, error: 'subscriptionId is required' });
    }

    // Cancel at period end so the tenant isn't charged mid-cycle
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });
    const cancelAtTimestamp = subscription.cancel_at || subscription.current_period_end;
    const cancelAt = cancelAtTimestamp
      ? new Date(cancelAtTimestamp * 1000).toISOString().split('T')[0]
      : null;

    res.json({
      ok: true,
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      cancelAt
    });
    console.log('[Stripe Autopay] Scheduled cancellation of subscription:', subscriptionId);

    const tenantEmail = subscription.metadata?.tenantEmail;
    if (tenantEmail) {
      const amount = (subscription.items.data[0]?.price?.unit_amount ?? 0) / 100;
      const propertyAddress = subscription.metadata?.propertyAddress || 'Your rental property';
      const fmtDate = (value) => new Date(`${value}T12:00:00`).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });
      const fmtAmount = `$${amount.toFixed(2)}`;

      sendHtmlEmail({
        to: tenantEmail,
        subject: 'Auto-Pay Cancellation Scheduled — Your Recurring Rent Payments Will End',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#b45309;padding:32px 24px;border-radius:8px 8px 0 0;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:24px">Auto-Pay Cancellation Scheduled</h1>
              <p style="color:#fde68a;margin:8px 0 0">Your recurring rent payments will stop at the end of the current billing period</p>
            </div>
            <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;background:#fff">
              <p style="font-size:16px">Hi${tenantEmail},</p>
              <p>Your request to cancel automatic rent payments has been received and confirmed.</p>
              <table style="width:100%;border-collapse:collapse;margin:24px 0">
                <tr style="background:#fffbeb"><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb;width:45%">Monthly Amount</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;font-size:18px;font-weight:700;color:#b45309">${fmtAmount}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Property</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">${propertyAddress}</td></tr>
                <tr style="background:#fffbeb"><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Auto-Pay Ends On</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">${cancelAt ? fmtDate(cancelAt) : 'End of current billing period'}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;border-bottom:1px solid #e5e7eb">Payment Day</td><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">1st of each month</td></tr>
                <tr style="background:#fffbeb"><td style="padding:12px 16px;font-weight:600">Subscription ID</td><td style="padding:12px 16px;font-family:monospace;font-size:13px">${subscription.id}</td></tr>
              </table>
              <div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:16px 18px;margin:24px 0;color:#92400e">
                No new recurring rent payments will be created after ${cancelAt ? fmtDate(cancelAt) : 'the end of the current billing period'}.
              </div>
              <p style="font-size:13px;color:#6b7280">If you still need to pay rent after auto-pay ends, you can make a one-time payment or set up auto-pay again from the Payments section of your tenant portal.</p>
            </div>
          </div>
        `
      }).catch(e => console.error('[Stripe Autopay] Cancellation email send failed:', e.message));
    }
  } catch (error) {
    console.error('[Stripe Autopay] Error cancelling subscription:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/stripe-connect/test-autopay-renewal
 * Executes an immediate custom auto-pay renewal or schedules up to two renewals within the next 24 hours.
 * This creates one-off invoices tied to the existing subscription without changing the subscription's
 * normal monthly billing anchor.
 */
router.post('/test-autopay-renewal', async (req, res) => {
  try {
    const { subscriptionId, runAt, runAts, reason } = req.body || {};
    if (!subscriptionId) {
      return res.status(400).json({ ok: false, error: 'subscriptionId is required' });
    }

    const requestedRunAtsRaw = Array.isArray(runAts)
      ? runAts.filter(Boolean)
      : (runAt ? [runAt] : []);

    if (requestedRunAtsRaw.length > 2) {
      return res.status(400).json({
        ok: false,
        error: 'You can schedule at most two custom auto-pay renewal times at once.'
      });
    }

    const requestedRunAts = [...requestedRunAtsRaw].sort();

    if (requestedRunAts.length === 0) {
      const result = await createAutopayTestRenewal({
        subscriptionId,
        reason: reason || 'manual_custom_renewal'
      });

      return res.json({
        ok: true,
        mode: 'executed',
        stripeMode: isStripeTestMode() ? 'test' : 'live',
        runs: [{ status: 'executed', result }]
      });
    }

    const existingScheduledRunCount = countScheduledAutopayTestJobs(subscriptionId);
    if (existingScheduledRunCount + requestedRunAts.length > 2) {
      return res.status(409).json({
        ok: false,
        error: 'Cancel an existing custom auto-pay renewal before scheduling more than two pending times.'
      });
    }

    const runs = requestedRunAts.map((requestedTime) => scheduleAutopayTestRenewal({
      subscriptionId,
      runAt: requestedTime,
      reason: reason || 'scheduled_custom_renewal'
    }));

    res.json({
      ok: true,
      mode: 'scheduled',
      stripeMode: isStripeTestMode() ? 'test' : 'live',
      runs
    });
  } catch (error) {
    console.error('[Stripe Autopay Schedule] Error creating renewal schedule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/stripe-connect/test-autopay-renewal/:subscriptionId
 * Lists pending, completed, failed, or cancelled custom renewal jobs for one subscription.
 */
router.get('/test-autopay-renewal/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const runs = [...TEST_AUTOPAY_RENEWAL_JOBS.values()]
      .filter((job) => job.subscriptionId === subscriptionId)
      .sort((left, right) => left.runAt.localeCompare(right.runAt))
      .map(serializeAutopayTestJob);

    res.json({ ok: true, stripeMode: isStripeTestMode() ? 'test' : 'live', runs });
  } catch (error) {
    console.error('[Stripe Autopay Schedule] Error loading renewal schedules:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/stripe-connect/test-autopay-renewal/job/:jobId
 * Cancels a scheduled custom renewal before it runs.
 */
router.delete('/test-autopay-renewal/job/:jobId', async (req, res) => {
  try {
    const job = TEST_AUTOPAY_RENEWAL_JOBS.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'Scheduled renewal job not found.' });
    }

    if (job.status !== 'scheduled' || !job.timer) {
      return res.status(409).json({
        ok: false,
        error: `Job cannot be cancelled because it is already ${job.status}.`
      });
    }

    clearTimeout(job.timer);
    job.timer = null;
    job.status = 'cancelled';
    job.executedAt = new Date().toISOString();
    persistAutopayCustomRenewals();

    res.json({
      ok: true,
      stripeMode: isStripeTestMode() ? 'test' : 'live',
      job: serializeAutopayTestJob(job)
    });
  } catch (error) {
    console.error('[Stripe Autopay Schedule] Error cancelling renewal schedule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
