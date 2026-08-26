import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getDevApiBaseUrl } from '../utils/devApiBase';

interface ConnectedAccount {
  accountId: string;
  email: string;
  createdAt: string;
  onboardingComplete: boolean;
  payoutsEnabled: boolean;
  externalAccounts?: Array<{
    id: string;
    bankName: string;
    last4: string;
  }>;
}

interface ContractorAssignment {
  contractorId: string;
  contractorEmail: string;
  contractorName: string;
  contractorCompanyName: string;
  assignedAt: string | null;
  serviceCompletedAt: string | null;
}

interface MaintenancePaymentWorkflow {
  status: string;
  amount: number | null;
  currency: string;
  serviceSummary: string;
  receiptNumber: string;
  contractorStripeAccountId: string;
  contractorOnboardingLinkSentAt: string | null;
  contractorOnboardingCompletedAt: string | null;
  ownerChargeRequestedAt: string | null;
  ownerChargeSucceededAt: string | null;
  ownerPaymentIntentId: string;
  ownerPaymentStatus: string;
  ownerPaymentMethodBankName: string;
  ownerPaymentMethodLast4: string;
  receiptUrl: string;
  lastError: string;
}

interface MaintenanceRequest {
  id: string;
  category: string;
  description: string;
  location?: string;
  propertyAddress: string;
  unit?: string;
  priority: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  contractorAssignment?: ContractorAssignment | null;
  paymentWorkflow?: MaintenancePaymentWorkflow | null;
}

function formatCurrency(amount: number | null | undefined, currency = 'usd') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: String(currency || 'usd').toUpperCase(),
  }).format(Number(amount || 0));
}

function formatDate(value?: string | null) {
  if (!value) {
    return 'Pending';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Pending';
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isLoopbackHostname(value = '') {
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function getValidatedLocalReturnUrl(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (!isLoopbackHostname(parsed.hostname)) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function getPaymentStatusLabel(status = '') {
  switch (status) {
    case 'awaiting_contractor_onboarding':
      return 'Connect payout account';
    case 'charging_owner':
      return 'Charging owner';
    case 'awaiting_owner_billing_setup':
      return 'Owner bank setup required';
    case 'owner_charge_processing':
      return 'Payment processing';
    case 'paid':
      return 'Paid';
    case 'charge_failed':
      return 'Charge failed';
    case 'not_started':
      return 'Not started';
    default:
      return status ? status.replace(/_/g, ' ') : 'Not started';
  }
}

function getPaymentStatusClass(status = '') {
  switch (status) {
    case 'paid':
      return 'bg-emerald-100 text-emerald-700';
    case 'owner_charge_processing':
    case 'charging_owner':
      return 'bg-blue-100 text-blue-700';
    case 'awaiting_contractor_onboarding':
    case 'awaiting_owner_billing_setup':
      return 'bg-amber-100 text-amber-700';
    case 'charge_failed':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

export default function ContractorPaymentsPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [handledSetupRedirect, setHandledSetupRedirect] = useState(false);

  const requestIdFromQuery = searchParams.get('requestId') || '';
  const setupState = searchParams.get('setup') || '';
  const localReturnUrl = getValidatedLocalReturnUrl(searchParams.get('localReturnUrl'));
  const baseUrl = getDevApiBaseUrl();
  const activeAccount = accounts.find((account) => account.onboardingComplete && account.payoutsEnabled) || accounts[0] || null;
  const highlightedRequest = requests.find((request) => request.id === requestIdFromQuery) || null;
  const receiptRequests = requests.filter((request) => {
    const paymentWorkflow = request.paymentWorkflow;
    return Boolean(paymentWorkflow?.receiptNumber) || ['paid', 'owner_charge_processing'].includes(paymentWorkflow?.status || '');
  });

  const fetchData = async () => {
    if (!user?.id && !user?.email) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const requestParams = new URLSearchParams();
      if (user?.id) {
        requestParams.set('contractorId', user.id);
      }
      if (user?.email) {
        requestParams.set('contractorEmail', user.email);
      }

      const [requestsResponse, accountsResponse] = await Promise.all([
        fetch(`${baseUrl}/api/maintenance/payments/contractor-requests?${requestParams.toString()}`),
        user?.id ? fetch(`${baseUrl}/api/stripe-connect/accounts/${encodeURIComponent(user.id)}`) : Promise.resolve(null),
      ]);

      const requestsPayload = await requestsResponse.json();
      if (!requestsResponse.ok || !requestsPayload.ok) {
        throw new Error(requestsPayload.error || 'Failed to load contractor payment requests.');
      }

      setRequests(Array.isArray(requestsPayload.requests) ? requestsPayload.requests : []);

      if (accountsResponse) {
        const accountsPayload = await accountsResponse.json();
        if (accountsResponse.ok && accountsPayload.ok) {
          setAccounts(Array.isArray(accountsPayload.accounts) ? accountsPayload.accounts : []);
        }
      }
    } catch (fetchError: any) {
      console.error('[Contractor Payments] Failed to load:', fetchError);
      setError(fetchError.message || 'Failed to load contractor payments.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, [user?.id, user?.email]);

  useEffect(() => {
    if (!localReturnUrl) {
      return;
    }

    if (isLoopbackHostname(window.location.hostname)) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('localReturnUrl');
      window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}`);
      return;
    }

    window.location.replace(localReturnUrl);
  }, [localReturnUrl]);

  useEffect(() => {
    if (!setupState || handledSetupRedirect) {
      return;
    }

    if (setupState === 'refresh') {
      setHandledSetupRedirect(true);
      setActionMessage('Stripe needs one more step to finish onboarding. Use the connect button below to resume payout setup.');
      return;
    }

    if (setupState !== 'complete' || !requestIdFromQuery || !user?.id) {
      return;
    }

    setHandledSetupRedirect(true);
    setProcessingRequestId(requestIdFromQuery);
    setActionMessage('Stripe onboarding completed. Finalizing owner charge and saving your receipt...');

    fetch(`${baseUrl}/api/maintenance/payments/contractor/complete-onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requestIdFromQuery,
        contractorId: user.id,
        contractorEmail: user.email || '',
        contractorName: user.name || '',
      }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || 'Failed to finalize contractor payout onboarding.');
        }

        if (payload.requiresOwnerBillingSetup) {
          setActionMessage('Your payout account is connected. The owner still needs to connect a billing bank account before payment can be released.');
        } else {
          setActionMessage('Your payout account is connected. HouseYield recorded the maintenance payment and saved the receipt below.');
        }

        await fetchData();
      })
      .catch((finishError: any) => {
        console.error('[Contractor Payments] Failed to finalize onboarding:', finishError);
        setError(finishError.message || 'Failed to finalize contractor payout onboarding.');
      })
      .finally(() => {
        setProcessingRequestId(null);
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete('setup');
        nextUrl.searchParams.delete('localReturnUrl');
        window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}`);
      });
  }, [baseUrl, handledSetupRedirect, requestIdFromQuery, setupState, user?.email, user?.id, user?.name]);

  const handleConnectPayout = async (requestId: string) => {
    if (!user?.id || !user?.email) {
      setError('You must be signed in as a contractor to connect a payout account.');
      return;
    }

    try {
      setConnectLoading(true);
      setError(null);

      const response = await fetch(`${baseUrl}/api/maintenance/payments/contractor/connect-account-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          contractorId: user.id,
          contractorEmail: user.email,
          contractorCompanyName: user.companyName || '',
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload.ok || !payload.url) {
        throw new Error(payload.error || 'Failed to create a Stripe onboarding link.');
      }

      window.location.href = payload.url;
    } catch (connectError: any) {
      console.error('[Contractor Payments] Failed to connect payout account:', connectError);
      setError(connectError.message || 'Failed to connect payout account.');
    } finally {
      setConnectLoading(false);
    }
  };

  const handleRetryCharge = async (requestId: string) => {
    if (!user?.id) {
      return;
    }

    try {
      setProcessingRequestId(requestId);
      setError(null);
      setActionMessage('Retrying the owner charge and refreshing your receipt...');

      const response = await fetch(`${baseUrl}/api/maintenance/payments/request/${encodeURIComponent(requestId)}/charge-owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractorId: user.id,
          contractorEmail: user.email || '',
          contractorName: user.name || '',
          contractorStripeAccountId: activeAccount?.accountId || '',
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Failed to retry the owner charge.');
      }

      setActionMessage(
        payload.requiresOwnerBillingSetup
          ? 'Your payout account is connected. The owner still needs to complete bank billing setup before payment can be released.'
          : 'HouseYield refreshed the maintenance charge and updated your receipt list.'
      );
      await fetchData();
    } catch (retryError: any) {
      console.error('[Contractor Payments] Failed to retry charge:', retryError);
      setError(retryError.message || 'Failed to retry the owner charge.');
    } finally {
      setProcessingRequestId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-12 w-12 rounded-full border-4 border-emerald-100 border-t-emerald-600 animate-spin" />
          <p className="mt-4 text-sm text-slate-600">Loading contractor payments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.12),_transparent_30%),linear-gradient(180deg,_#f8fafc_0%,_#edf7f3_100%)] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="rounded-3xl border border-emerald-100 bg-white/95 p-6 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <Link to="/contractor/marketplace" className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 hover:text-emerald-800">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to marketplace
              </Link>
              <h1 className="mt-4 text-3xl font-semibold text-slate-900">Contractor Payments</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">Connect your Stripe payout account, monitor maintenance invoice status, and access saved payment receipts for completed work.</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
              <div className="font-medium text-slate-900">{user?.name || 'Contractor account'}</div>
              <div>{user?.email || 'No email available'}</div>
            </div>
          </div>
        </header>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">{error}</div>
        )}

        {actionMessage && (
          <div className="rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4 text-sm text-blue-700">{actionMessage}</div>
        )}

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_48px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">Payout setup</div>
                <h2 className="mt-2 text-2xl font-semibold text-slate-900">Stripe contractor payout account</h2>
                <p className="mt-2 text-sm text-slate-600">Use Stripe to connect the bank account where HouseYield should send maintenance payments.</p>
              </div>
              <div className={`rounded-full px-3 py-1 text-xs font-semibold ${activeAccount?.onboardingComplete && activeAccount?.payoutsEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {activeAccount?.onboardingComplete && activeAccount?.payoutsEnabled ? 'Ready for payouts' : 'Setup needed'}
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
              {activeAccount ? (
                <div className="space-y-3 text-sm text-slate-700">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium text-slate-900">Connected Stripe account</span>
                    <span className="font-mono text-xs text-slate-500">{activeAccount.accountId}</span>
                  </div>
                  <div>Onboarding: {activeAccount.onboardingComplete ? 'Complete' : 'Incomplete'}</div>
                  <div>Payouts enabled: {activeAccount.payoutsEnabled ? 'Yes' : 'Not yet'}</div>
                  {activeAccount.externalAccounts && activeAccount.externalAccounts.length > 0 && (
                    <div>
                      Payout bank: {activeAccount.externalAccounts[0].bankName || 'Bank account'} •••• {activeAccount.externalAccounts[0].last4}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3 text-sm text-slate-700">
                  <p>No payout account has been connected yet.</p>
                  <p>When you open a maintenance invite, HouseYield will send you through secure Stripe onboarding to connect the account where you want to receive funds.</p>
                </div>
              )}

              <button
                type="button"
                onClick={() => handleConnectPayout(requestIdFromQuery || highlightedRequest?.id || requests[0]?.id || '')}
                disabled={connectLoading}
                className="mt-5 inline-flex items-center justify-center rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {connectLoading ? 'Preparing Stripe onboarding...' : activeAccount ? 'Resume payout setup' : 'Connect payout account'}
              </button>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_48px_rgba(15,23,42,0.08)]">
            <div className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">Queue</div>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Maintenance payment actions</h2>
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-medium text-slate-900">Assignments tracked</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{requests.length}</div>
                <div className="mt-1 text-xs text-slate-500">Jobs that already reference your contractor account or email.</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-medium text-slate-900">Receipts saved</div>
                <div className="mt-2 text-3xl font-semibold text-slate-900">{receiptRequests.length}</div>
                <div className="mt-1 text-xs text-slate-500">Paid or processing maintenance receipts available in your portal.</div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_48px_rgba(15,23,42,0.08)]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">Assignments</div>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">Maintenance payment workflow</h2>
              <p className="mt-2 text-sm text-slate-600">Connect payout details for assigned maintenance work and track owner charge status in one place.</p>
            </div>
            <button type="button" onClick={() => void fetchData()} className="inline-flex items-center justify-center rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
              Refresh
            </button>
          </div>

          {requests.length === 0 ? (
            <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center text-sm text-slate-600">
              Maintenance assignments will appear here after an owner sends you a payout invite.
            </div>
          ) : (
            <div className="mt-8 space-y-4">
              {requests.map((request) => {
                const paymentWorkflow = request.paymentWorkflow;
                const status = paymentWorkflow?.status || 'not_started';
                const isActiveRequest = request.id === requestIdFromQuery;
                const needsPayoutSetup = ['awaiting_contractor_onboarding', 'not_started'].includes(status) || !activeAccount?.onboardingComplete || !activeAccount?.payoutsEnabled;

                return (
                  <article key={request.id} className={`rounded-3xl border p-5 transition ${isActiveRequest ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200 bg-white'}`}>
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${getPaymentStatusClass(status)}`}>{getPaymentStatusLabel(status)}</span>
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{request.category}</span>
                          {paymentWorkflow?.receiptNumber && (
                            <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">Receipt {paymentWorkflow.receiptNumber}</span>
                          )}
                        </div>
                        <div>
                          <h3 className="text-xl font-semibold text-slate-900">{paymentWorkflow?.serviceSummary || request.description}</h3>
                          <p className="mt-1 text-sm text-slate-600">{request.propertyAddress}{request.unit ? ` • ${request.unit}` : ''}</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Amount</div>
                            <div className="mt-2 text-lg font-semibold text-slate-900">{formatCurrency(paymentWorkflow?.amount, paymentWorkflow?.currency)}</div>
                          </div>
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Invite sent</div>
                            <div className="mt-2 text-sm font-medium text-slate-900">{formatDate(paymentWorkflow?.contractorOnboardingLinkSentAt)}</div>
                          </div>
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Owner charge</div>
                            <div className="mt-2 text-sm font-medium text-slate-900">{formatDate(paymentWorkflow?.ownerChargeRequestedAt)}</div>
                          </div>
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Last update</div>
                            <div className="mt-2 text-sm font-medium text-slate-900">{formatDate(request.updatedAt || request.createdAt)}</div>
                          </div>
                        </div>
                        {paymentWorkflow?.lastError && (
                          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{paymentWorkflow.lastError}</div>
                        )}
                      </div>

                      <div className="xl:w-[280px] xl:flex-shrink-0">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                          <div className="font-medium text-slate-900">Receipt and payout</div>
                          <div className="mt-3 space-y-2">
                            <div>Stripe account: {paymentWorkflow?.contractorStripeAccountId || activeAccount?.accountId || 'Not connected yet'}</div>
                            <div>Owner payment status: {paymentWorkflow?.ownerPaymentStatus || 'Not started'}</div>
                            {paymentWorkflow?.ownerPaymentMethodBankName && (
                              <div>Owner bank: {paymentWorkflow.ownerPaymentMethodBankName} •••• {paymentWorkflow.ownerPaymentMethodLast4}</div>
                            )}
                            {paymentWorkflow?.ownerPaymentIntentId && (
                              <div className="break-all text-xs text-slate-500">Transaction: {paymentWorkflow.ownerPaymentIntentId}</div>
                            )}
                          </div>
                        </div>

                        <div className="mt-4 flex flex-col gap-3">
                          {needsPayoutSetup && (
                            <button
                              type="button"
                              onClick={() => handleConnectPayout(request.id)}
                              disabled={connectLoading}
                              className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {connectLoading && request.id === requestIdFromQuery ? 'Preparing Stripe...' : 'Connect payout account'}
                            </button>
                          )}
                          {status === 'charge_failed' && activeAccount?.accountId && (
                            <button
                              type="button"
                              onClick={() => handleRetryCharge(request.id)}
                              disabled={processingRequestId === request.id}
                              className="inline-flex items-center justify-center rounded-full border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {processingRequestId === request.id ? 'Retrying owner charge...' : 'Retry owner charge'}
                            </button>
                          )}
                          {status === 'awaiting_owner_billing_setup' && (
                            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                              The owner still needs to connect a billing bank account before your payment can be released.
                            </div>
                          )}
                          {paymentWorkflow?.receiptUrl && (
                            <a href={paymentWorkflow.receiptUrl} className="inline-flex items-center justify-center rounded-full border border-emerald-200 px-4 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50">
                              Open saved receipt
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_48px_rgba(15,23,42,0.08)]">
          <div className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">Receipts</div>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Saved payment receipts</h2>
          <p className="mt-2 text-sm text-slate-600">Completed and in-flight maintenance payments stay available inside your contractor portal.</p>

          {receiptRequests.length === 0 ? (
            <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center text-sm text-slate-600">
              Once an owner charge is initiated, receipt details will appear here automatically.
            </div>
          ) : (
            <div className="mt-8 overflow-hidden rounded-3xl border border-slate-200">
              <div className="grid grid-cols-[1.5fr_0.9fr_0.8fr_1fr] gap-4 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <div>Service</div>
                <div>Status</div>
                <div>Amount</div>
                <div>Receipt</div>
              </div>
              <div className="divide-y divide-slate-200">
                {receiptRequests.map((request) => (
                  <div key={`receipt-${request.id}`} className="grid grid-cols-[1.5fr_0.9fr_0.8fr_1fr] gap-4 px-5 py-4 text-sm text-slate-700">
                    <div>
                      <div className="font-medium text-slate-900">{request.paymentWorkflow?.serviceSummary || request.description}</div>
                      <div className="mt-1 text-xs text-slate-500">{request.propertyAddress}</div>
                    </div>
                    <div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${getPaymentStatusClass(request.paymentWorkflow?.status || '')}`}>
                        {getPaymentStatusLabel(request.paymentWorkflow?.status || '')}
                      </span>
                    </div>
                    <div className="font-medium text-slate-900">{formatCurrency(request.paymentWorkflow?.amount, request.paymentWorkflow?.currency)}</div>
                    <div className="space-y-1">
                      <div className="text-xs text-slate-500">{request.paymentWorkflow?.receiptNumber || 'Receipt pending'}</div>
                      {request.paymentWorkflow?.receiptUrl && (
                        <a href={request.paymentWorkflow.receiptUrl} className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
                          View receipt
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}