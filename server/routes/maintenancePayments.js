import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import Stripe from 'stripe';
import { sendHtmlEmail } from '../email-service.js';
import {
  getContractorMaintenanceRequests,
  getMaintenanceRequestById,
  updateMaintenanceRequestDetails,
} from '../tenant-activity-service.js';
import { buildTenantAutopaySetupSessionParams } from '../stripe-tenant-payment-config.js';

const router = express.Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-11-20.acacia',
});

const STORAGE_DIR = path.join(process.cwd(), 'server', 'data', 'stripe-connect');
const ACCOUNTS_FILE = path.join(STORAGE_DIR, 'connected-accounts.json');

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function readAccounts() {
  try {
    ensureStorageDir();
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[Maintenance Payments] Failed to read connected accounts:', error);
  }
  return {};
}

function writeAccounts(accounts = {}) {
  ensureStorageDir();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isLoopbackUrl(value = '') {
  try {
    const parsed = new URL(value);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function isHttpsUrl(value = '') {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isStripeLiveMode() {
  return typeof STRIPE_SECRET_KEY === 'string' && STRIPE_SECRET_KEY.startsWith('sk_live_');
}

function getStripeConnectHostedFrontendBaseUrl() {
  const frontendCandidates = [
    process.env.STRIPE_CONNECT_FRONTEND_URL,
    process.env.HOUSEYIELD_PUBLIC_FRONTEND_URL,
    process.env.FRONTEND_URL,
    process.env.CLOUDFLARE_TUNNEL_URL,
    process.env.VITE_NGROK_URL,
    process.env.NGROK_URL,
    'https://myhouseyield.com',
  ].filter(Boolean);

  return frontendCandidates.find((candidate) => isHttpsUrl(candidate) && !isLoopbackUrl(candidate)) || null;
}

function getFrontendBaseUrl() {
  const frontendCandidates = [
    process.env.FRONTEND_URL,
    process.env.CLOUDFLARE_TUNNEL_URL,
    process.env.VITE_NGROK_URL,
    process.env.NGROK_URL,
  ].filter(Boolean);

  return frontendCandidates.find((candidate) => !isLoopbackUrl(candidate))
    || frontendCandidates[0]
    || process.env.PUBLIC_URL
    || 'http://localhost:5173';
}

function getOwnerMaintenanceUrl(request = null) {
  const params = new URLSearchParams({ tab: 'maintenance' });
  if (request?.propertyId) {
    params.set('property', String(request.propertyId));
  }
  return `${getFrontendBaseUrl()}/property-management?${params.toString()}`;
}

function getContractorPaymentsUrl(requestId = '') {
  const params = new URLSearchParams();
  if (requestId) {
    params.set('requestId', String(requestId));
  }
  const query = params.toString();
  return `${getFrontendBaseUrl()}/contractor/payments${query ? `?${query}` : ''}`;
}

function getInviteLoginUrl(requestId = '') {
  const redirectTarget = `/contractor/payments${requestId ? `?requestId=${encodeURIComponent(String(requestId))}&invite=1` : ''}`;
  return `${getFrontendBaseUrl()}/login/contractor?redirect=${encodeURIComponent(redirectTarget)}`;
}

function buildContractorStripeSetupUrl(setupState, requestId = '') {
  const params = new URLSearchParams();
  if (setupState) {
    params.set('setup', String(setupState));
  }
  if (requestId) {
    params.set('requestId', String(requestId));
  }

  const localUrl = new URL('/contractor/payments', getFrontendBaseUrl());
  params.forEach((value, key) => {
    localUrl.searchParams.set(key, value);
  });

  if (!isStripeLiveMode() || !isLoopbackUrl(localUrl.toString())) {
    return localUrl.toString();
  }

  const hostedFrontendBaseUrl = getStripeConnectHostedFrontendBaseUrl();
  if (!hostedFrontendBaseUrl) {
    return localUrl.toString();
  }

  const hostedUrl = new URL('/contractor/payments', hostedFrontendBaseUrl);
  params.forEach((value, key) => {
    hostedUrl.searchParams.set(key, value);
  });
  hostedUrl.searchParams.set('localReturnUrl', localUrl.toString());

  return hostedUrl.toString();
}

function getStripeResourceId(value) {
  if (!value) {
    return null;
  }
  return typeof value === 'string' ? value : value.id || null;
}

function formatCurrency(amount, currency = 'usd') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: String(currency || 'usd').toUpperCase(),
  }).format(Number(amount || 0));
}

function createReceiptNumber() {
  return `MR-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function buildMaintenanceTitle(request = {}) {
  const summary = request.paymentWorkflow?.serviceSummary || request.serviceSummary || request.description || request.category || 'Maintenance service';
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function buildOwnerPaymentStatus(paymentIntentStatus = '') {
  if (paymentIntentStatus === 'succeeded') {
    return 'paid';
  }
  if (paymentIntentStatus === 'processing') {
    return 'owner_charge_processing';
  }
  if (paymentIntentStatus === 'requires_payment_method' || paymentIntentStatus === 'canceled') {
    return 'charge_failed';
  }
  return paymentIntentStatus || 'charging_owner';
}

async function getOrCreateOwnerCustomer({ ownerId = '', ownerEmail = '', ownerName = '' }) {
  const normalizedEmail = normalizeEmail(ownerEmail);
  if (!normalizedEmail) {
    throw new Error('Owner email is required to charge maintenance payments.');
  }

  const existingCustomers = await stripe.customers.list({
    email: normalizedEmail,
    limit: 10,
  });

  const matchingCustomer = existingCustomers.data.find((customer) => {
    if (customer.metadata?.type === 'owner' && customer.metadata?.ownerId === ownerId) {
      return true;
    }
    if (customer.metadata?.type === 'owner' && !ownerId) {
      return true;
    }
    return false;
  }) || existingCustomers.data[0] || null;

  if (matchingCustomer) {
    await stripe.customers.update(matchingCustomer.id, {
      email: normalizedEmail,
      name: ownerName || matchingCustomer.name || undefined,
      metadata: {
        ...matchingCustomer.metadata,
        type: 'owner',
        ownerId: ownerId || matchingCustomer.metadata?.ownerId || '',
      },
    });
    return matchingCustomer;
  }

  return stripe.customers.create({
    email: normalizedEmail,
    name: ownerName || undefined,
    metadata: {
      type: 'owner',
      ownerId: ownerId || '',
    },
  });
}

async function getDefaultOwnerBankPaymentMethod(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || customer.deleted) {
    return null;
  }

  let paymentMethodId = getStripeResourceId(customer.invoice_settings?.default_payment_method);

  if (!paymentMethodId) {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'us_bank_account',
      limit: 1,
    });
    paymentMethodId = paymentMethods.data[0]?.id || null;
    if (paymentMethodId) {
      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      });
    }
  }

  if (!paymentMethodId) {
    return null;
  }

  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (paymentMethod?.type !== 'us_bank_account') {
    return null;
  }

  return paymentMethod;
}

async function getBestConnectedAccountForUser(userId) {
  const accounts = readAccounts();
  const userAccounts = accounts[userId] || {};
  const entries = Object.entries(userAccounts);

  if (entries.length === 0) {
    return null;
  }

  const hydratedAccounts = [];
  for (const [accountId, accountData] of entries) {
    try {
      const account = await stripe.accounts.retrieve(accountId);
      hydratedAccounts.push({
        accountId,
        accountData,
        account,
      });
    } catch (error) {
      console.error('[Maintenance Payments] Failed to hydrate Stripe account:', accountId, error.message);
    }
  }

  return hydratedAccounts.find((entry) => entry.account?.details_submitted && entry.account?.payouts_enabled)
    || hydratedAccounts.find((entry) => entry.account?.details_submitted)
    || hydratedAccounts[0]
    || null;
}

function buildContractorInviteEmailHtml({
  contractorName,
  propertyAddress,
  amount,
  serviceSummary,
  inviteUrl,
  ownerName,
}) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;background:#f8fafc">
      <div style="background:linear-gradient(135deg,#0f766e 0%,#059669 100%);padding:36px 28px;border-radius:18px 18px 0 0;color:#ffffff">
        <div style="font-size:28px;font-weight:700;line-height:1.2">Connect your payout account</div>
        <p style="margin:12px 0 0;color:#d1fae5;font-size:15px">HouseYield is ready to send your maintenance payment as soon as your Stripe payout account is connected.</p>
      </div>
      <div style="background:#ffffff;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 18px 18px">
        <p style="margin:0 0 16px;font-size:16px">Hi ${contractorName || 'there'},</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6">${ownerName || 'The property owner'} marked your maintenance work as complete. Use the secure Stripe link below to log in, connect your bank account, and receive payment.</p>
        <div style="border:1px solid #dbeafe;border-radius:14px;padding:18px 20px;background:#f8fafc;margin:20px 0">
          <div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px">Work summary</div>
          <div style="font-size:17px;font-weight:700;color:#0f172a">${serviceSummary}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Property: ${propertyAddress || 'Maintenance assignment'}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Payment amount: ${formatCurrency(amount)}</div>
        </div>
        <div style="text-align:center;margin:30px 0">
          <a href="${inviteUrl}" style="display:inline-block;padding:15px 28px;border-radius:999px;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700">Log in and connect payout account</a>
        </div>
        <ol style="margin:0 0 0 18px;padding:0;color:#334155;line-height:1.7;font-size:14px">
          <li>Log in to your contractor account.</li>
          <li>Complete Stripe onboarding and add the bank account where you want to receive payment.</li>
          <li>HouseYield will route the maintenance payment and store the receipt in your contractor payments workspace.</li>
        </ol>
      </div>
    </div>
  `;
}

function buildOwnerSetupEmailHtml({
  ownerName,
  propertyAddress,
  amount,
  serviceSummary,
  setupUrl,
}) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;background:#f8fafc">
      <div style="background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 100%);padding:36px 28px;border-radius:18px 18px 0 0;color:#ffffff">
        <div style="font-size:28px;font-weight:700;line-height:1.2">Maintenance invoice ready</div>
        <p style="margin:12px 0 0;color:#dbeafe;font-size:15px">A contractor connected payout details for completed maintenance work, but your billing bank account still needs to be confirmed.</p>
      </div>
      <div style="background:#ffffff;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 18px 18px">
        <p style="margin:0 0 16px;font-size:16px">Hi ${ownerName || 'there'},</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6">To release this maintenance payment automatically, connect the bank account HouseYield should charge for approved maintenance work.</p>
        <div style="border:1px solid #dbeafe;border-radius:14px;padding:18px 20px;background:#f8fafc;margin:20px 0">
          <div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px">Invoice summary</div>
          <div style="font-size:17px;font-weight:700;color:#0f172a">${serviceSummary}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Property: ${propertyAddress || 'Maintenance assignment'}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Amount due: ${formatCurrency(amount)}</div>
        </div>
        <div style="text-align:center;margin:30px 0">
          <a href="${setupUrl}" style="display:inline-block;padding:15px 28px;border-radius:999px;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:700">Connect owner billing account</a>
        </div>
        <p style="margin:0;font-size:14px;color:#475569;line-height:1.6">Once your bank account is confirmed, HouseYield can automatically charge approved maintenance invoices and store receipts in your maintenance workspace.</p>
      </div>
    </div>
  `;
}

function buildOwnerChargeEmailHtml({
  ownerName,
  propertyAddress,
  amount,
  serviceSummary,
  receiptNumber,
  paymentStatus,
  paymentMethodLabel,
  receiptUrl,
  transactionId,
}) {
  const statusLabel = paymentStatus === 'paid'
    ? 'Paid'
    : 'Processing';
  const detailCopy = paymentStatus === 'paid'
    ? 'The maintenance invoice has been charged successfully.'
    : 'The maintenance invoice has been submitted and is processing through ACH.';

  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;background:#f8fafc">
      <div style="background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 100%);padding:36px 28px;border-radius:18px 18px 0 0;color:#ffffff">
        <div style="font-size:28px;font-weight:700;line-height:1.2">Maintenance invoice ${statusLabel.toLowerCase()}</div>
        <p style="margin:12px 0 0;color:#dbeafe;font-size:15px">${detailCopy}</p>
      </div>
      <div style="background:#ffffff;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 18px 18px">
        <p style="margin:0 0 16px;font-size:16px">Hi ${ownerName || 'there'},</p>
        <div style="border:1px solid #dbeafe;border-radius:14px;padding:18px 20px;background:#f8fafc;margin:20px 0">
          <div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px">Payment details</div>
          <div style="font-size:17px;font-weight:700;color:#0f172a">${serviceSummary}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Property: ${propertyAddress || 'Maintenance assignment'}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Amount: ${formatCurrency(amount)}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Status: ${statusLabel}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Bank account: ${paymentMethodLabel || 'Verified owner bank account'}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Receipt number: ${receiptNumber}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Transaction ID: ${transactionId}</div>
        </div>
        <div style="text-align:center;margin:30px 0">
          <a href="${receiptUrl}" style="display:inline-block;padding:15px 28px;border-radius:999px;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:700">View maintenance receipt</a>
        </div>
      </div>
    </div>
  `;
}

function buildContractorChargeEmailHtml({
  contractorName,
  propertyAddress,
  amount,
  serviceSummary,
  receiptNumber,
  paymentStatus,
  receiptUrl,
  transactionId,
}) {
  const statusLabel = paymentStatus === 'paid'
    ? 'Payment received'
    : 'Payment initiated';
  const detailCopy = paymentStatus === 'paid'
    ? 'HouseYield routed the maintenance payment to your connected Stripe payout account.'
    : 'HouseYield initiated the maintenance payment. ACH settlement can take a few business days.';

  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;background:#f8fafc">
      <div style="background:linear-gradient(135deg,#0f766e 0%,#059669 100%);padding:36px 28px;border-radius:18px 18px 0 0;color:#ffffff">
        <div style="font-size:28px;font-weight:700;line-height:1.2">${statusLabel}</div>
        <p style="margin:12px 0 0;color:#d1fae5;font-size:15px">${detailCopy}</p>
      </div>
      <div style="background:#ffffff;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 18px 18px">
        <p style="margin:0 0 16px;font-size:16px">Hi ${contractorName || 'there'},</p>
        <div style="border:1px solid #d1fae5;border-radius:14px;padding:18px 20px;background:#f0fdf4;margin:20px 0">
          <div style="font-size:13px;color:#047857;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px">Receipt details</div>
          <div style="font-size:17px;font-weight:700;color:#0f172a">${serviceSummary}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Property: ${propertyAddress || 'Maintenance assignment'}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Amount: ${formatCurrency(amount)}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Receipt number: ${receiptNumber}</div>
          <div style="margin-top:8px;font-size:14px;color:#334155">Transaction ID: ${transactionId}</div>
        </div>
        <div style="text-align:center;margin:30px 0">
          <a href="${receiptUrl}" style="display:inline-block;padding:15px 28px;border-radius:999px;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700">Open contractor payment receipt</a>
        </div>
      </div>
    </div>
  `;
}

async function emailOwnerBillingSetup(request, ownerEmail, ownerName) {
  const now = new Date().toISOString();
  const setupUrl = getOwnerMaintenanceUrl(request);
  const result = await sendHtmlEmail({
    to: ownerEmail,
    subject: `Maintenance invoice ready - ${formatCurrency(request.paymentWorkflow?.amount)}`,
    html: buildOwnerSetupEmailHtml({
      ownerName,
      propertyAddress: request.propertyAddress,
      amount: request.paymentWorkflow?.amount,
      serviceSummary: buildMaintenanceTitle(request),
      setupUrl,
    }),
  });

  return {
    emailResult: result,
    setupUrl,
    sentAt: result.ok ? now : null,
  };
}

async function emailMaintenanceReceipts({
  request,
  ownerEmail,
  ownerName,
  contractorEmail,
  contractorName,
  receiptNumber,
  receiptUrl,
  transactionId,
  paymentStatus,
  paymentMethodLabel,
}) {
  const now = new Date().toISOString();
  const ownerPromise = ownerEmail
    ? sendHtmlEmail({
        to: ownerEmail,
        subject: `Maintenance invoice ${paymentStatus === 'paid' ? 'paid' : 'processing'} - ${formatCurrency(request.paymentWorkflow?.amount)}`,
        html: buildOwnerChargeEmailHtml({
          ownerName,
          propertyAddress: request.propertyAddress,
          amount: request.paymentWorkflow?.amount,
          serviceSummary: buildMaintenanceTitle(request),
          receiptNumber,
          paymentStatus,
          paymentMethodLabel,
          receiptUrl: getOwnerMaintenanceUrl(request),
          transactionId,
        }),
      })
    : Promise.resolve({ ok: false, skipped: true });

  const contractorPromise = contractorEmail
    ? sendHtmlEmail({
        to: contractorEmail,
        subject: `Maintenance payment ${paymentStatus === 'paid' ? 'received' : 'initiated'} - ${formatCurrency(request.paymentWorkflow?.amount)}`,
        html: buildContractorChargeEmailHtml({
          contractorName,
          propertyAddress: request.propertyAddress,
          amount: request.paymentWorkflow?.amount,
          serviceSummary: buildMaintenanceTitle(request),
          receiptNumber,
          paymentStatus,
          receiptUrl,
          transactionId,
        }),
      })
    : Promise.resolve({ ok: false, skipped: true });

  const [ownerResult, contractorResult] = await Promise.all([ownerPromise, contractorPromise]);

  return {
    ownerInvoiceSentAt: ownerResult.ok ? now : null,
    ownerReceiptSentAt: ownerResult.ok ? now : null,
    contractorReceiptSentAt: contractorResult.ok ? now : null,
  };
}

async function chargeOwnerForMaintenanceRequest(request, { contractorId, contractorEmail, contractorName, contractorStripeAccountId }) {
  const amount = Number(request?.paymentWorkflow?.amount || 0);
  const currency = request?.paymentWorkflow?.currency || 'usd';
  const ownerEmail = normalizeEmail(request?.paymentWorkflow?.ownerEmail);
  const ownerName = request?.paymentWorkflow?.ownerName || 'Property owner';
  const normalizedContractorEmail = normalizeEmail(contractorEmail || request?.contractorEmail || request?.contractorAssignment?.contractorEmail || '');
  const resolvedContractorName = contractorName || request?.contractorName || request?.contractorAssignment?.contractorName || 'Contractor';

  if (!amount || amount <= 0) {
    throw new Error('A positive maintenance payment amount is required before charging the owner.');
  }

  if (!ownerEmail) {
    throw new Error('Owner email is required before charging the owner for maintenance.');
  }

  if (!contractorStripeAccountId) {
    throw new Error('The contractor has not connected a Stripe payout account yet.');
  }

  const contractorAccount = await stripe.accounts.retrieve(contractorStripeAccountId);
  if (!contractorAccount?.payouts_enabled) {
    throw new Error('The contractor Stripe payout account is not ready for payouts yet.');
  }

  const now = new Date().toISOString();
  const ownerCustomer = await getOrCreateOwnerCustomer({
    ownerId: request.ownerId || '',
    ownerEmail,
    ownerName,
  });

  const ownerPaymentMethod = await getDefaultOwnerBankPaymentMethod(ownerCustomer.id);
  if (!ownerPaymentMethod) {
    const billingEmail = await emailOwnerBillingSetup(request, ownerEmail, ownerName);
    const updateResult = await updateMaintenanceRequestDetails(request.id, {
      paymentWorkflow: {
        status: 'awaiting_owner_billing_setup',
        ownerBillingCustomerId: ownerCustomer.id,
        ownerChargeRequestedAt: now,
        lastError: 'Owner has not connected a bank account for maintenance billing.',
        emails: {
          ownerInvoiceSentAt: billingEmail.sentAt,
        },
      },
    });

    return {
      ok: false,
      requiresOwnerBillingSetup: true,
      request: updateResult.request,
      setupUrl: billingEmail.setupUrl,
    };
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency,
    customer: ownerCustomer.id,
    payment_method: ownerPaymentMethod.id,
    confirm: true,
    off_session: true,
    description: buildMaintenanceTitle(request),
    receipt_email: ownerEmail,
    transfer_data: {
      destination: contractorStripeAccountId,
    },
    metadata: {
      flowType: 'maintenance_payment',
      maintenanceRequestId: request.id,
      ownerId: request.ownerId || '',
      ownerEmail,
      contractorId: contractorId || request.contractorId || '',
      contractorEmail: normalizedContractorEmail,
      contractorName: resolvedContractorName,
      propertyId: request.propertyId || '',
      propertyAddress: request.propertyAddress || '',
      serviceSummary: buildMaintenanceTitle(request),
    },
  });

  const paymentStatus = buildOwnerPaymentStatus(paymentIntent.status);
  const receiptNumber = request.paymentWorkflow?.receiptNumber || createReceiptNumber();
  const receiptUrl = getContractorPaymentsUrl(request.id);
  const paymentMethodLabel = ownerPaymentMethod.us_bank_account?.bank_name
    ? `${ownerPaymentMethod.us_bank_account.bank_name} •••• ${ownerPaymentMethod.us_bank_account.last4}`
    : `Bank account •••• ${ownerPaymentMethod.us_bank_account?.last4 || ''}`;

  const emailTimestamps = await emailMaintenanceReceipts({
    request,
    ownerEmail,
    ownerName,
    contractorEmail: normalizedContractorEmail,
    contractorName: resolvedContractorName,
    receiptNumber,
    receiptUrl,
    transactionId: paymentIntent.id,
    paymentStatus,
    paymentMethodLabel,
  });

  const updateResult = await updateMaintenanceRequestDetails(request.id, {
    contractorId: contractorId || request.contractorId || '',
    contractorEmail: normalizedContractorEmail,
    contractorName: resolvedContractorName,
    serviceCompletion: request.serviceCompletion || {
      completedAt: now,
      completedBy: 'contractor',
      notes: buildMaintenanceTitle(request),
    },
    status: 'completed',
    paymentWorkflow: {
      status: paymentStatus,
      amount,
      currency,
      ownerBillingCustomerId: ownerCustomer.id,
      ownerBillingSetupCompletedAt: now,
      ownerChargeRequestedAt: now,
      ownerChargeSucceededAt: paymentStatus === 'paid' ? now : null,
      ownerInvoiceId: receiptNumber,
      ownerInvoiceUrl: getOwnerMaintenanceUrl(request),
      ownerPaymentIntentId: paymentIntent.id,
      ownerPaymentMethodId: ownerPaymentMethod.id,
      ownerPaymentMethodLast4: ownerPaymentMethod.us_bank_account?.last4 || '',
      ownerPaymentMethodBankName: ownerPaymentMethod.us_bank_account?.bank_name || '',
      ownerPaymentStatus: paymentIntent.status,
      contractorStripeAccountId,
      contractorStripeUserKey: contractorId || request.contractorId || '',
      contractorOnboardingCompletedAt: request.paymentWorkflow?.contractorOnboardingCompletedAt || now,
      receiptNumber,
      receiptUrl,
      lastError: '',
      emails: emailTimestamps,
    },
  });

  if (paymentStatus === 'paid' && updateResult.request) {
    try {
      const { notifyMaintenanceOwnerProviderPaid } = await import('../services/maintenanceOwnerSmsService.js');
      await notifyMaintenanceOwnerProviderPaid(updateResult.request);
    } catch (smsError) {
      console.warn('[MaintenancePayments] Owner paid SMS failed:', smsError.message);
    }
  }

  return {
    ok: true,
    request: updateResult.request,
    paymentIntentId: paymentIntent.id,
    paymentStatus,
  };
}

router.get('/owner-billing-status', async (req, res) => {
  try {
    const ownerEmail = normalizeEmail(String(req.query.ownerEmail || ''));
    const ownerId = String(req.query.ownerId || '');

    if (!ownerEmail) {
      return res.status(400).json({ ok: false, error: 'ownerEmail is required' });
    }

    const customers = await stripe.customers.list({ email: ownerEmail, limit: 10 });
    const customer = customers.data.find((entry) => entry.metadata?.type === 'owner' && (!ownerId || entry.metadata?.ownerId === ownerId))
      || customers.data[0]
      || null;

    if (!customer) {
      return res.json({ ok: true, connected: false, customerId: null, paymentMethod: null });
    }

    const paymentMethod = await getDefaultOwnerBankPaymentMethod(customer.id);

    return res.json({
      ok: true,
      connected: Boolean(paymentMethod),
      customerId: customer.id,
      paymentMethod: paymentMethod ? {
        id: paymentMethod.id,
        type: paymentMethod.type,
        bankName: paymentMethod.us_bank_account?.bank_name || '',
        last4: paymentMethod.us_bank_account?.last4 || '',
      } : null,
    });
  } catch (error) {
    console.error('[Maintenance Payments] Failed to fetch owner billing status:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to fetch owner billing status' });
  }
});

router.post('/owner-billing/setup', async (req, res) => {
  try {
    const { ownerId, ownerEmail, ownerName, propertyId, propertyAddress } = req.body || {};
    const normalizedOwnerEmail = normalizeEmail(ownerEmail || '');

    if (!ownerId || !normalizedOwnerEmail) {
      return res.status(400).json({ ok: false, error: 'ownerId and ownerEmail are required' });
    }

    const customer = await getOrCreateOwnerCustomer({
      ownerId,
      ownerEmail: normalizedOwnerEmail,
      ownerName: ownerName || '',
    });

    const baseUrl = getFrontendBaseUrl();
    const successParams = new URLSearchParams({
      tab: 'maintenance',
      maintenanceBilling: 'success',
      setup_session_id: '{CHECKOUT_SESSION_ID}',
    });
    const cancelParams = new URLSearchParams({
      tab: 'maintenance',
      maintenanceBilling: 'cancelled',
    });
    if (propertyId) {
      successParams.set('property', String(propertyId));
      cancelParams.set('property', String(propertyId));
    }

    const session = await stripe.checkout.sessions.create(
      buildTenantAutopaySetupSessionParams({
        customerId: customer.id,
        successUrl: `${baseUrl}/property-management?${successParams.toString()}`,
        cancelUrl: `${baseUrl}/property-management?${cancelParams.toString()}`,
        setupIntentMetadata: {
          flowType: 'owner_maintenance_billing',
          ownerId,
          ownerEmail: normalizedOwnerEmail,
          ownerName: ownerName || '',
          propertyId: propertyId || '',
          propertyAddress: propertyAddress || '',
        },
        metadata: {
          flowType: 'owner_maintenance_billing',
          ownerId,
          ownerEmail: normalizedOwnerEmail,
          propertyId: propertyId || '',
          propertyAddress: propertyAddress || '',
        },
      })
    );

    res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      customerId: customer.id,
    });
  } catch (error) {
    console.error('[Maintenance Payments] Failed to create owner billing setup session:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to create owner billing setup session' });
  }
});

router.post('/owner-billing/confirm', async (req, res) => {
  try {
    const { setupSessionId } = req.body || {};
    if (!setupSessionId) {
      return res.status(400).json({ ok: false, error: 'setupSessionId is required' });
    }

    const session = await stripe.checkout.sessions.retrieve(setupSessionId, {
      expand: ['setup_intent.payment_method'],
    });

    const customerId = getStripeResourceId(session.customer);
    if (!customerId) {
      return res.status(400).json({ ok: false, error: 'Stripe customer not found for the setup session.' });
    }

    const setupIntent = session.setup_intent;
    const paymentMethod = typeof setupIntent === 'object' && setupIntent
      ? (typeof setupIntent.payment_method === 'string'
        ? await stripe.paymentMethods.retrieve(setupIntent.payment_method)
        : setupIntent.payment_method)
      : null;

    if (!paymentMethod || paymentMethod.type !== 'us_bank_account') {
      return res.status(400).json({ ok: false, error: 'A verified bank account was not found on this setup session.' });
    }

    try {
      await stripe.paymentMethods.attach(paymentMethod.id, { customer: customerId });
    } catch (error) {
      if (!String(error?.message || '').toLowerCase().includes('already attached')) {
        throw error;
      }
    }

    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethod.id,
      },
    });

    res.json({
      ok: true,
      customerId,
      paymentMethod: {
        id: paymentMethod.id,
        bankName: paymentMethod.us_bank_account?.bank_name || '',
        last4: paymentMethod.us_bank_account?.last4 || '',
      },
    });
  } catch (error) {
    console.error('[Maintenance Payments] Failed to confirm owner billing setup:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to confirm owner billing setup' });
  }
});

router.get('/contractor-requests', async (req, res) => {
  try {
    const contractorId = String(req.query.contractorId || '');
    const contractorEmail = normalizeEmail(String(req.query.contractorEmail || ''));

    if (!contractorId && !contractorEmail) {
      return res.status(400).json({ ok: false, error: 'contractorId or contractorEmail is required' });
    }

    const result = await getContractorMaintenanceRequests(contractorId, contractorEmail);
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error || 'Failed to fetch contractor requests' });
    }

    res.json({ ok: true, requests: result.requests || [] });
  } catch (error) {
    console.error('[Maintenance Payments] Failed to fetch contractor requests:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to fetch contractor requests' });
  }
});

router.put('/request/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const payload = req.body || {};
    const requestResult = await getMaintenanceRequestById(requestId);
    if (!requestResult.ok || !requestResult.request) {
      return res.status(404).json({ ok: false, error: requestResult.error || 'Maintenance request not found' });
    }

    const normalizedContractorEmail = normalizeEmail(payload.contractorEmail || payload.contractorAssignment?.contractorEmail || '');
    const amount = payload.paymentWorkflow?.amount;
    const serviceSummary = payload.paymentWorkflow?.serviceSummary || payload.serviceCompletion?.notes || buildMaintenanceTitle(requestResult.request);

    const updates = {
      ...payload,
      contractorEmail: normalizedContractorEmail || requestResult.request.contractorEmail || '',
      contractorAssignment: {
        ...(payload.contractorAssignment || {}),
        contractorEmail: normalizedContractorEmail || payload.contractorAssignment?.contractorEmail || requestResult.request.contractorAssignment?.contractorEmail || '',
        assignedAt: payload.contractorAssignment?.assignedAt || requestResult.request.contractorAssignment?.assignedAt || new Date().toISOString(),
      },
      paymentWorkflow: {
        ...(payload.paymentWorkflow || {}),
        amount: typeof amount === 'number' ? amount : Number(amount || requestResult.request.paymentWorkflow?.amount || 0) || null,
        serviceSummary,
      },
    };

    const result = await updateMaintenanceRequestDetails(requestId, updates);
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error || 'Failed to update maintenance request' });
    }

    res.json(result);
  } catch (error) {
    console.error('[Maintenance Payments] Failed to update maintenance request:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to update maintenance request' });
  }
});

router.post('/request/:requestId/send-contractor-invite', async (req, res) => {
  try {
    const { requestId } = req.params;
    const requestResult = await getMaintenanceRequestById(requestId);
    if (!requestResult.ok || !requestResult.request) {
      return res.status(404).json({ ok: false, error: requestResult.error || 'Maintenance request not found' });
    }

    const request = requestResult.request;
    const contractorEmail = normalizeEmail(req.body?.contractorEmail || request.contractorEmail || request.contractorAssignment?.contractorEmail || '');
    const contractorName = req.body?.contractorName || request.contractorName || request.contractorAssignment?.contractorName || '';
    const contractorCompanyName = req.body?.contractorCompanyName || request.contractorCompanyName || request.contractorAssignment?.contractorCompanyName || '';
    const amount = Number(req.body?.amount ?? request.paymentWorkflow?.amount ?? 0);
    const serviceSummary = req.body?.serviceSummary || request.paymentWorkflow?.serviceSummary || buildMaintenanceTitle(request);
    const ownerEmail = normalizeEmail(req.body?.ownerEmail || request.paymentWorkflow?.ownerEmail || '');
    const ownerName = req.body?.ownerName || request.paymentWorkflow?.ownerName || 'Property owner';

    if (!contractorEmail) {
      return res.status(400).json({ ok: false, error: 'contractorEmail is required' });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'A positive maintenance payment amount is required' });
    }

    const now = new Date().toISOString();
    const inviteUrl = getInviteLoginUrl(requestId);
    const emailResult = await sendHtmlEmail({
      to: contractorEmail,
      subject: `Connect payout account for ${formatCurrency(amount)} maintenance payment`,
      html: buildContractorInviteEmailHtml({
        contractorName,
        propertyAddress: request.propertyAddress,
        amount,
        serviceSummary,
        inviteUrl,
        ownerName,
      }),
    });

    const updateResult = await updateMaintenanceRequestDetails(requestId, {
      contractorId: req.body?.contractorId || request.contractorId || '',
      contractorEmail,
      contractorName,
      contractorCompanyName,
      contractorAssignment: {
        contractorId: req.body?.contractorId || request.contractorId || '',
        contractorEmail,
        contractorName,
        contractorCompanyName,
        assignedAt: request.contractorAssignment?.assignedAt || now,
        serviceCompletedAt: req.body?.serviceCompletedAt || request.contractorAssignment?.serviceCompletedAt || now,
      },
      serviceCompletion: request.serviceCompletion || {
        completedAt: req.body?.serviceCompletedAt || now,
        completedBy: 'owner',
        notes: serviceSummary,
      },
      status: 'completed',
      paymentWorkflow: {
        status: 'awaiting_contractor_onboarding',
        amount,
        serviceSummary,
        ownerEmail,
        ownerName,
        contractorOnboardingLinkSentAt: now,
        lastError: '',
        emails: {
          contractorInviteSentAt: emailResult.ok ? now : null,
        },
      },
    });

    res.json({
      ok: updateResult.ok,
      request: updateResult.request,
      inviteUrl,
      email: emailResult,
    });
  } catch (error) {
    console.error('[Maintenance Payments] Failed to send contractor invite:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to send contractor invite' });
  }
});

router.post('/contractor/connect-account-link', async (req, res) => {
  try {
    const { contractorId, contractorEmail, contractorCompanyName, requestId } = req.body || {};
    const normalizedContractorEmail = normalizeEmail(contractorEmail || '');

    if (!contractorId || !normalizedContractorEmail) {
      return res.status(400).json({ ok: false, error: 'contractorId and contractorEmail are required' });
    }

    const accounts = readAccounts();
    if (!accounts[contractorId]) {
      accounts[contractorId] = {};
    }

    let accountRecord = await getBestConnectedAccountForUser(contractorId);

    if (!accountRecord) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: normalizedContractorEmail,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: contractorCompanyName ? 'company' : 'individual',
        metadata: {
          userId: contractorId,
          maintenanceRequestId: requestId || '',
        },
      });

      accounts[contractorId][account.id] = {
        accountId: account.id,
        email: normalizedContractorEmail,
        propertyId: null,
        createdAt: new Date().toISOString(),
        onboardingComplete: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        financialConnectionsEnabled: false,
      };
      writeAccounts(accounts);

      accountRecord = {
        accountId: account.id,
        accountData: accounts[contractorId][account.id],
        account,
      };
    }

    const refreshUrl = buildContractorStripeSetupUrl('refresh', requestId);
    const returnUrl = buildContractorStripeSetupUrl('complete', requestId);

    const accountLink = await stripe.accountLinks.create({
      account: accountRecord.accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    res.json({
      ok: true,
      accountId: accountRecord.accountId,
      url: accountLink.url,
      onboardingComplete: Boolean(accountRecord.account?.details_submitted),
      payoutsEnabled: Boolean(accountRecord.account?.payouts_enabled),
    });
  } catch (error) {
    console.error('[Maintenance Payments] Failed to create contractor account link:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to create contractor account link' });
  }
});

router.post('/contractor/complete-onboarding', async (req, res) => {
  try {
    const { requestId, contractorId, contractorEmail, contractorName } = req.body || {};
    if (!requestId || !contractorId) {
      return res.status(400).json({ ok: false, error: 'requestId and contractorId are required' });
    }

    const requestResult = await getMaintenanceRequestById(requestId);
    if (!requestResult.ok || !requestResult.request) {
      return res.status(404).json({ ok: false, error: requestResult.error || 'Maintenance request not found' });
    }

    const connectedAccount = await getBestConnectedAccountForUser(contractorId);
    if (!connectedAccount?.accountId || !connectedAccount.account?.details_submitted || !connectedAccount.account?.payouts_enabled) {
      return res.status(400).json({ ok: false, error: 'The contractor payout account is not fully connected yet.' });
    }

    const now = new Date().toISOString();
    const prepResult = await updateMaintenanceRequestDetails(requestId, {
      contractorId,
      contractorEmail: normalizeEmail(contractorEmail || requestResult.request.contractorEmail || requestResult.request.contractorAssignment?.contractorEmail || ''),
      contractorName: contractorName || requestResult.request.contractorName || requestResult.request.contractorAssignment?.contractorName || '',
      paymentWorkflow: {
        status: 'charging_owner',
        contractorStripeAccountId: connectedAccount.accountId,
        contractorStripeUserKey: contractorId,
        contractorOnboardingCompletedAt: now,
        lastError: '',
      },
    });

    if (!prepResult.ok || !prepResult.request) {
      return res.status(500).json({ ok: false, error: prepResult.error || 'Failed to update maintenance request before charging owner' });
    }

    const chargeResult = await chargeOwnerForMaintenanceRequest(prepResult.request, {
      contractorId,
      contractorEmail,
      contractorName,
      contractorStripeAccountId: connectedAccount.accountId,
    });

    res.json(chargeResult);
  } catch (error) {
    console.error('[Maintenance Payments] Failed to complete contractor onboarding:', error);
    const requestId = req.body?.requestId;
    if (requestId) {
      await updateMaintenanceRequestDetails(requestId, {
        paymentWorkflow: {
          status: 'charge_failed',
          lastError: error.message || 'Failed to charge owner for maintenance payment.',
          ownerPaymentStatus: 'failed',
        },
      }).catch(() => {});
    }
    res.status(500).json({ ok: false, error: error.message || 'Failed to complete contractor onboarding' });
  }
});

router.post('/request/:requestId/charge-owner', async (req, res) => {
  try {
    const { requestId } = req.params;
    const requestResult = await getMaintenanceRequestById(requestId);
    if (!requestResult.ok || !requestResult.request) {
      return res.status(404).json({ ok: false, error: requestResult.error || 'Maintenance request not found' });
    }

    const request = requestResult.request;
    const contractorId = req.body?.contractorId || request.contractorId || request.contractorAssignment?.contractorId || request.paymentWorkflow?.contractorStripeUserKey || '';
    const contractorEmail = req.body?.contractorEmail || request.contractorEmail || request.contractorAssignment?.contractorEmail || '';
    const contractorName = req.body?.contractorName || request.contractorName || request.contractorAssignment?.contractorName || '';
    const contractorStripeAccountId = req.body?.contractorStripeAccountId || request.paymentWorkflow?.contractorStripeAccountId || '';

    const chargeResult = await chargeOwnerForMaintenanceRequest(request, {
      contractorId,
      contractorEmail,
      contractorName,
      contractorStripeAccountId,
    });

    res.json(chargeResult);
  } catch (error) {
    console.error('[Maintenance Payments] Failed to charge owner:', error);
    const { requestId } = req.params;
    await updateMaintenanceRequestDetails(requestId, {
      paymentWorkflow: {
        status: 'charge_failed',
        lastError: error.message || 'Failed to charge owner for maintenance payment.',
        ownerPaymentStatus: 'failed',
      },
    }).catch(() => {});
    res.status(500).json({ ok: false, error: error.message || 'Failed to charge owner' });
  }
});

router.get('/receipt/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const result = await getMaintenanceRequestById(requestId);
    if (!result.ok || !result.request) {
      return res.status(404).json({ ok: false, error: result.error || 'Maintenance request not found' });
    }

    const request = result.request;
    res.json({
      ok: true,
      receiptNumber: request.paymentWorkflow?.receiptNumber || '',
      amount: request.paymentWorkflow?.amount || null,
      currency: request.paymentWorkflow?.currency || 'usd',
      serviceSummary: buildMaintenanceTitle(request),
      propertyAddress: request.propertyAddress || '',
      paymentStatus: request.paymentWorkflow?.status || 'not_started',
      ownerPaymentIntentId: request.paymentWorkflow?.ownerPaymentIntentId || '',
      ownerInvoiceUrl: request.paymentWorkflow?.ownerInvoiceUrl || getOwnerMaintenanceUrl(request),
      contractorReceiptUrl: request.paymentWorkflow?.receiptUrl || getContractorPaymentsUrl(request.id),
      ownerChargeRequestedAt: request.paymentWorkflow?.ownerChargeRequestedAt || null,
      ownerChargeSucceededAt: request.paymentWorkflow?.ownerChargeSucceededAt || null,
      contractorName: request.contractorName || request.contractorAssignment?.contractorName || '',
      contractorEmail: request.contractorEmail || request.contractorAssignment?.contractorEmail || '',
      ownerName: request.paymentWorkflow?.ownerName || '',
      ownerEmail: request.paymentWorkflow?.ownerEmail || '',
      paymentMethodLabel: request.paymentWorkflow?.ownerPaymentMethodBankName
        ? `${request.paymentWorkflow.ownerPaymentMethodBankName} •••• ${request.paymentWorkflow.ownerPaymentMethodLast4 || ''}`
        : '',
    });
  } catch (error) {
    console.error('[Maintenance Payments] Failed to fetch receipt:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to fetch maintenance receipt' });
  }
});

export default router;