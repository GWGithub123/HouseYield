/**
 * TenantPaymentForm - Component for tenants to make rent payments
 * Integrates with landlord's Stripe Connect account
 */

import { useState, useEffect, useRef } from 'react';

interface TenantPaymentFormProps {
  landlordAccountId: string | null;
  tenantName: string;
  tenantEmail: string;
  tenantId?: string;
  ownerId?: string;
  propertyId?: string;
  propertyAddress: string;
  defaultAmount?: number;
  monthlyRent?: number;
  onPaymentComplete?: (sessionId: string) => void;
  onError?: (error: string) => void;
}

interface AutoPayStatus {
  hasAutoPay: boolean;
  subscription: {
    id: string;
    status: string;
    amount: number;
    nextPaymentDate: string;
    createdAt: string;
    cancelAtPeriodEnd?: boolean;
    cancelAt?: string | null;
    dayOfMonth?: number;
  } | null;
  paymentMethod: {
    type: string;
    bankName?: string;
    last4?: string;
    accountType?: string;
    brand?: string;
  } | null;
  customerId: string | null;
  lastPayment: { amount: number; date: string } | null;
}

interface OneTimeReceipt {
  amount: number;
  propertyAddress: string;
  tenantName: string;
  paymentMethod: string;
  date: string;
  transactionId: string;
  status: string;
}

interface AutopayTestRun {
  id: string;
  subscriptionId: string;
  reason: string;
  runAt: string;
  scheduledAt: string;
  status: string;
  executedAt: string | null;
  result: {
    invoiceId: string;
    paymentIntentId?: string | null;
    requestedRunAt?: string | null;
    executedAt: string;
    scheduledAmount: number;
    amountDue: number;
    amountPaid: number;
    currency: string;
    status: string;
    nextPaymentAttempt?: string | null;
  } | null;
  error: string | null;
}

interface AutopayTestScheduleInputs {
  first: string;
  second: string;
}

const toLocalDateTimeInputValue = (date: Date) => {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
};

const createDefaultAutopayTestSchedule = (): AutopayTestScheduleInputs => ({
  first: toLocalDateTimeInputValue(new Date(Date.now() + 30 * 60 * 1000)),
  second: toLocalDateTimeInputValue(new Date(Date.now() + 2 * 60 * 60 * 1000))
});

export default function TenantPaymentForm({ 
  landlordAccountId,
  tenantName, 
  tenantEmail,
  tenantId,
  ownerId,
  propertyId,
  propertyAddress,
  defaultAmount,
  monthlyRent,
  onPaymentComplete,
  onError
}: TenantPaymentFormProps) {
  const [activeTab, setActiveTab] = useState<'one-time' | 'autopay'>('one-time');
  const [amount, setAmount] = useState(defaultAmount?.toString() || monthlyRent?.toString() || '');
  const [description, setDescription] = useState('Monthly Rent Payment');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One-time payment confirmation
  const [oneTimeReceipt, setOneTimeReceipt] = useState<OneTimeReceipt | null>(null);

  // Auto-pay state
  const [autoPayStatus, setAutoPayStatus] = useState<AutoPayStatus | null>(null);
  const [autoPayLoading, setAutoPayLoading] = useState(false);
  const [autopayAmount, setAutopayAmount] = useState(monthlyRent?.toString() || defaultAmount?.toString() || '');
  const [usePresetAmount, setUsePresetAmount] = useState(true);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [awaitingWebhook, setAwaitingWebhook] = useState(false);
  const [autopayConfirmed, setAutopayConfirmed] = useState(false);
  const [autopayTestRuns, setAutopayTestRuns] = useState<AutopayTestRun[]>([]);
  const [autopayTestSchedule, setAutopayTestSchedule] = useState<AutopayTestScheduleInputs>(createDefaultAutopayTestSchedule);
  const [autopayTestLoading, setAutopayTestLoading] = useState(false);
  const [autopayTestMessage, setAutopayTestMessage] = useState<string | null>(null);
  const [autopayTestError, setAutopayTestError] = useState<string | null>(null);
  const autopayPollRef = useRef<number | null>(null);
  const isLocalAutopayTestHost = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const isAutoPayCancellationScheduled = !!autoPayStatus?.subscription?.cancelAtPeriodEnd;
  const autoPayEndDate = autoPayStatus?.subscription?.cancelAt || autoPayStatus?.subscription?.nextPaymentDate || null;
  const showAutopayTestPanel = isLocalAutopayTestHost
    && !!autoPayStatus?.hasAutoPay
    && !!autoPayStatus?.subscription?.id
    && !isAutoPayCancellationScheduled;

  // Sync preset amounts when props arrive
  useEffect(() => {
    if (monthlyRent && !amount) setAmount(monthlyRent.toString());
    if (monthlyRent && !autopayAmount) setAutopayAmount(monthlyRent.toString());
  }, [monthlyRent, defaultAmount]);

  // Load autopay status when tab is opened or on mount
  useEffect(() => {
    if (tenantEmail && landlordAccountId) {
      fetchAutoPayStatus();
    }
  }, [tenantEmail, landlordAccountId]);

  // Handle success redirect from Stripe (both one-time and autopay)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autopayParam = params.get('autopay');
    const paymentParam = params.get('payment');
    const setupSessionId = params.get('setup_session_id');
    const sessionId = params.get('session_id');
    const clearAutopayPoll = () => {
      if (autopayPollRef.current !== null) {
        window.clearInterval(autopayPollRef.current);
        autopayPollRef.current = null;
      }
    };

    // Clean URL immediately
    const url = new URL(window.location.href);
    url.searchParams.delete('autopay');
    url.searchParams.delete('setup_session_id');
    url.searchParams.delete('payment');
    url.searchParams.delete('session_id');
    window.history.replaceState({}, '', url.toString());

    if (autopayParam === 'success') {
      setActiveTab('autopay');
      setError(null);
      setAwaitingWebhook(true);

      clearAutopayPoll();

      if (setupSessionId) {
        const enteredAmount = parseFloat(autopayAmount);
        const payAmt = Number.isFinite(enteredAmount) && enteredAmount > 0
          ? enteredAmount
          : (defaultAmount && defaultAmount > 0
            ? defaultAmount
            : (monthlyRent && monthlyRent > 0 ? monthlyRent : undefined));

        void (async () => {
          try {
            const response = await fetch('/api/stripe-connect/create-subscription', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                setupSessionId,
                accountId: landlordAccountId || undefined,
                amount: payAmt,
                propertyAddress,
                tenantEmail,
                tenantId: tenantId || '',
                ownerId: ownerId || ''
              })
            });

            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.ok) {
              throw new Error(data?.error || 'Failed to activate auto-pay. Please try again.');
            }

            const latestStatus = await fetchAutoPayStatus();
            if (latestStatus?.hasAutoPay) {
              setAwaitingWebhook(false);
              setAutopayConfirmed(!latestStatus.subscription?.cancelAtPeriodEnd);
              clearAutopayPoll();
            }
          } catch (err: any) {
            setAwaitingWebhook(false);
            setAutopayConfirmed(false);
            setError(err?.message || 'Failed to activate auto-pay. Please try again.');
            clearAutopayPoll();
          }
        })();
      }

      // Poll up to 10 times (20 seconds)
      let attempts = 0;
      autopayPollRef.current = window.setInterval(async () => {
        attempts++;
        const p = new URLSearchParams({ tenantEmail, accountId: landlordAccountId || '' });
        try {
          const res = await fetch(`/api/stripe-connect/autopay-status?${p}`);
          const data = await res.json();
          if (data.ok) {
            setAutoPayStatus(data);
            if (data.hasAutoPay || attempts >= 10) {
              setAwaitingWebhook(false);
              setAutopayConfirmed(!!(data.hasAutoPay && !data.subscription?.cancelAtPeriodEnd));
              clearAutopayPoll();
            }
          }
        } catch (_e) {
          if (attempts >= 10) {
            setAwaitingWebhook(false);
            clearAutopayPoll();
          }
        }
      }, 2000);
    }

    if (paymentParam === 'success' && sessionId) {
      setActiveTab('one-time');
      // Confirm server-side and get receipt data
      fetch('/api/stripe-connect/confirm-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      })
        .then(r => r.json())
        .then(data => {
          if (data.receipt) {
            setOneTimeReceipt(data.receipt);
          } else {
            // Fallback: fetch from receipt endpoint
            return fetch(`/api/stripe-connect/receipt/${sessionId}`)
              .then(r => r.json())
              .then(d => { if (d.ok) setOneTimeReceipt(d); });
          }
        })
        .catch(err => console.error('[Payment] Confirm failed:', err));
    }

    return () => {
      clearAutopayPoll();
    };
  }, []);

  const fetchAutoPayStatus = async () => {
    try {
      const params = new URLSearchParams({ tenantEmail, accountId: landlordAccountId || '' });
      const res = await fetch(`/api/stripe-connect/autopay-status?${params}`);
      const data = await res.json();
      if (data.ok) {
        setAutoPayStatus(data);
        return data as AutoPayStatus & { ok: true };
      }
    } catch (_e) { /* non-critical */ }
    return null;
  };

  const fetchAutopayTestRuns = async (subscriptionId = autoPayStatus?.subscription?.id) => {
    if (!subscriptionId || !isLocalAutopayTestHost) {
      setAutopayTestRuns([]);
      return null;
    }

    try {
      const res = await fetch(`/api/stripe-connect/test-autopay-renewal/${subscriptionId}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Failed to load custom auto-pay renewals.');
      }

      const runs = Array.isArray(data.runs) ? data.runs as AutopayTestRun[] : [];
      setAutopayTestRuns(runs);
      return runs;
    } catch (err: any) {
      setAutopayTestRuns([]);
      setAutopayTestError(err?.message || 'Failed to load custom auto-pay renewals.');
      return null;
    }
  };

  useEffect(() => {
    if (!showAutopayTestPanel || !autoPayStatus?.subscription?.id) {
      setAutopayTestRuns([]);
      setAutopayTestMessage(null);
      setAutopayTestError(null);
      return;
    }

    void fetchAutopayTestRuns(autoPayStatus.subscription.id);
  }, [showAutopayTestPanel, autoPayStatus?.subscription?.id]);

  const handleSetupAutoPay = async () => {
    try {
      setAutoPayLoading(true);
      setError(null);

      if (!landlordAccountId) {
        throw new Error('Your landlord has not connected their bank account yet.');
      }

      const payAmount = usePresetAmount
        ? (monthlyRent || defaultAmount || parseFloat(autopayAmount))
        : parseFloat(autopayAmount);

      if (!payAmount || payAmount <= 0) {
        throw new Error('Please enter a valid monthly rent amount first.');
      }

      const res = await fetch('/api/stripe-connect/setup-autopay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: landlordAccountId,
          tenantEmail,
          tenantName,
          tenantId: tenantId || '',
          ownerId: ownerId || '',
          propertyAddress,
          amount: payAmount
        })
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to start setup');
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message);
      if (onError) onError(err.message);
    } finally {
      setAutoPayLoading(false);
    }
  };

  const handleCancelAutoPay = async () => {
    if (!autoPayStatus?.subscription?.id) return;
    try {
      setCancelLoading(true);
      setError(null);
      setAwaitingWebhook(false);
      if (autopayPollRef.current !== null) {
        window.clearInterval(autopayPollRef.current);
        autopayPollRef.current = null;
      }
      const res = await fetch(`/api/stripe-connect/cancel-subscription/${autoPayStatus.subscription.id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to cancel');
      setAutoPayStatus(current => {
        if (!current?.subscription) return current;
        return {
          ...current,
          subscription: {
            ...current.subscription,
            cancelAtPeriodEnd: true,
            cancelAt: data.cancelAt || current.subscription.nextPaymentDate
          }
        };
      });
      setCancelConfirm(false);
      setAutopayConfirmed(false);
      await fetchAutoPayStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCancelLoading(false);
    }
  };

  const handleRunAutopayTest = async (requestedRunAts: string[] = []) => {
    if (!autoPayStatus?.subscription?.id) {
      return;
    }

    try {
      setAutopayTestLoading(true);
      setAutopayTestError(null);
      setAutopayTestMessage(null);

      const normalizedRunAts = requestedRunAts
        .map((value) => value?.trim())
        .filter(Boolean)
        .map((value) => new Date(value).toISOString());

      const res = await fetch('/api/stripe-connect/test-autopay-renewal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriptionId: autoPayStatus.subscription.id,
          ...(normalizedRunAts.length > 0 ? { runAts: normalizedRunAts } : {}),
          reason: normalizedRunAts.length > 0 ? 'tenant_dashboard_scheduled_test' : 'tenant_dashboard_manual_test'
        })
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Failed to create a custom auto-pay renewal.');
      }

      if (normalizedRunAts.length > 0) {
        const runCount = Array.isArray(data.runs) ? data.runs.length : normalizedRunAts.length;
        setAutopayTestMessage(`Scheduled ${runCount} custom auto-pay renewal${runCount === 1 ? '' : 's'} for this subscription.`);
      } else {
        const result = data.runs?.[0]?.result;
        setAutopayTestMessage(
          result?.invoiceId
            ? `Custom renewal submitted. Stripe invoice ${result.invoiceId} is currently ${result.status}.`
            : 'Custom renewal submitted.'
        );
      }

      await Promise.all([
        fetchAutoPayStatus(),
        fetchAutopayTestRuns(autoPayStatus.subscription.id)
      ]);
    } catch (err: any) {
      setAutopayTestError(err?.message || 'Failed to create a custom auto-pay renewal.');
    } finally {
      setAutopayTestLoading(false);
    }
  };

  const handleScheduleAutopayTests = async () => {
    const requestedRunAts = [autopayTestSchedule.first, autopayTestSchedule.second].filter(Boolean);
    if (requestedRunAts.length === 0) {
      setAutopayTestError('Choose at least one time to schedule a custom auto-pay renewal.');
      return;
    }

    await handleRunAutopayTest(requestedRunAts);
  };

  const handleCancelAutopayTestJob = async (jobId: string) => {
    try {
      setAutopayTestLoading(true);
      setAutopayTestError(null);
      setAutopayTestMessage(null);

      const res = await fetch(`/api/stripe-connect/test-autopay-renewal/job/${jobId}`, {
        method: 'DELETE'
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Failed to cancel the scheduled custom auto-pay renewal.');
      }

      setAutopayTestMessage('Cancelled the scheduled custom auto-pay renewal.');
      await fetchAutopayTestRuns(autoPayStatus?.subscription?.id);
    } catch (err: any) {
      setAutopayTestError(err?.message || 'Failed to cancel the scheduled custom auto-pay renewal.');
    } finally {
      setAutopayTestLoading(false);
    }
  };

  const handlePayment = async () => {
    try {
      setIsLoading(true);
      setError(null);

      if (!landlordAccountId) {
        throw new Error('Your landlord has not connected their bank account yet. Please contact them to set up payment receiving.');
      }

      const paymentAmount = parseFloat(amount);
      if (isNaN(paymentAmount) || paymentAmount <= 0) {
        throw new Error('Please enter a valid payment amount');
      }

      const response = await fetch('/api/stripe-connect/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: landlordAccountId,
          amount: paymentAmount,
          tenantEmail,
          tenantName,
          tenantId: tenantId || '',
          ownerId: ownerId || '',
          propertyId: propertyId || '',
          description,
          propertyAddress
        })
      });

      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Failed to create payment session');
      window.location.href = data.url;

      if (onPaymentComplete) onPaymentComplete(data.sessionId);
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to process payment';
      setError(errorMsg);
      if (onError) onError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  const fmtDate = (d: string) =>
    new Date(d + (d.includes('T') ? '' : 'T12:00:00')).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const fmtDateTime = (d: string) =>
    new Date(d).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

  const fmtAmt = (n: number) => `$${n.toFixed(2)}`;

  const pmLabel = (pm: AutoPayStatus['paymentMethod']) => {
    if (!pm) return 'Bank account';
    if (pm.type === 'us_bank_account') {
      return [pm.bankName, pm.accountType && `(${pm.accountType})`, pm.last4 && `ending in ${pm.last4}`].filter(Boolean).join(' ');
    }
    return [pm.brand && pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1), pm.last4 && `ending in ${pm.last4}`].filter(Boolean).join(' ');
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-gray-800">Pay Rent</h3>
        <p className="text-sm text-gray-500">Make a one-time payment or set up automatic monthly ACH</p>
      </div>

      {/* Tab Switcher */}
      <div className="flex rounded-lg border border-gray-200 overflow-hidden">
        <button
          onClick={() => { setActiveTab('one-time'); setOneTimeReceipt(null); }}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            activeTab === 'one-time' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          One-Time Payment
        </button>
        <button
          onClick={() => { setActiveTab('autopay'); fetchAutoPayStatus(); }}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            activeTab === 'autopay' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Auto-Pay
          {autoPayStatus?.hasAutoPay && (
            <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-green-400" />
          )}
        </button>
      </div>

      {/* Landlord not connected warning */}
      {!landlordAccountId && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <div>
              <div className="text-sm font-medium text-amber-800">Bank Account Not Connected</div>
              <div className="text-sm text-amber-700 mt-1">Your landlord needs to connect their bank account to receive payments. Please ask them to log in as an owner and complete the bank account setup in their dashboard.</div>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <span className="font-medium">Error: </span>{error}
        </div>
      )}

      {/* ── ONE-TIME PAYMENT TAB ── */}
      {activeTab === 'one-time' && (
        <div className="space-y-4">
          {oneTimeReceipt ? (
            /* ── POST-PAYMENT CONFIRMATION ── */
            <div className="space-y-4">
              <div className="rounded-lg border border-green-200 bg-green-50 p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                    <svg className="h-6 w-6 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-base font-semibold text-green-900">
                      {oneTimeReceipt.status === 'completed' ? 'Payment Received' : 'Payment Submitted'}
                    </div>
                    <div className="text-sm text-green-700">
                      {oneTimeReceipt.status !== 'completed' && 'ACH bank transfers typically take 3–5 business days to settle.'}
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-green-200 rounded-lg border border-green-200 bg-white overflow-hidden text-sm">
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Amount</span>
                    <span className="font-bold text-green-700 text-base">{fmtAmt(oneTimeReceipt.amount)}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Property</span>
                    <span className="font-medium text-right max-w-xs">{oneTimeReceipt.propertyAddress || propertyAddress || '—'}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Date</span>
                    <span className="font-medium">{fmtDate(oneTimeReceipt.date)}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Payment Method</span>
                    <span className="font-medium capitalize">{oneTimeReceipt.paymentMethod === 'us_bank_account' ? 'ACH Bank Transfer' : oneTimeReceipt.paymentMethod}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Status</span>
                    <span className={`font-medium ${oneTimeReceipt.status === 'completed' ? 'text-green-600' : 'text-amber-600'}`}>
                      {oneTimeReceipt.status === 'completed' ? 'Settled' : 'Pending'}
                    </span>
                  </div>
                  <div className="flex justify-between px-4 py-3 bg-gray-50">
                    <span className="text-gray-500">Transaction ID</span>
                    <span className="font-mono text-xs text-gray-600 truncate max-w-[200px]">{oneTimeReceipt.transactionId}</span>
                  </div>
                </div>
                <p className="text-xs text-green-700">A receipt has been sent to <span className="font-medium">{tenantEmail}</span>.</p>
              </div>
              <button
                onClick={() => setOneTimeReceipt(null)}
                className="w-full rounded-lg border border-gray-300 text-gray-600 py-2 text-sm hover:bg-gray-50 transition-colors"
              >
                Make Another Payment
              </button>
            </div>
          ) : (
            /* ── PAYMENT FORM ── */
            <>
              <div className="rounded-lg border bg-gray-50 p-4 space-y-2">
                <div className="text-sm"><span className="text-gray-500">From:</span> <span className="font-medium text-gray-800">{tenantName}</span></div>
                <div className="text-sm"><span className="text-gray-500">Property:</span> <span className="font-medium text-gray-800">{propertyAddress}</span></div>
              </div>

              {/* Pre-fill with monthly rent if available */}
              {monthlyRent && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-blue-900">Monthly Rent</div>
                    <div className="text-xs text-blue-700">Your lease amount</div>
                  </div>
                  <button
                    onClick={() => setAmount(monthlyRent.toString())}
                    className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                      amount === monthlyRent.toString()
                        ? 'bg-blue-600 text-white'
                        : 'bg-white border border-blue-300 text-blue-700 hover:bg-blue-50'
                    }`}
                  >
                    {fmtAmt(monthlyRent)}
                  </button>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Payment Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-lg">$</span>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    min="0"
                    className="block w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-lg font-semibold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Payment Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Monthly Rent Payment"
                  className="block w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <button
                onClick={handlePayment}
                disabled={isLoading || !landlordAccountId || !amount || parseFloat(amount) <= 0}
                className="w-full rounded-lg bg-blue-600 text-white px-6 py-3 text-base font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-md"
              >
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                    Redirecting to Stripe...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                    Continue to Payment — {amount ? fmtAmt(parseFloat(amount) || 0) : '$0.00'}
                  </span>
                )}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── AUTO-PAY TAB ── */}
      {activeTab === 'autopay' && (
        <div className="space-y-4">
          {awaitingWebhook ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 space-y-3">
              <div className="flex items-center gap-3">
                <svg className="animate-spin h-5 w-5 text-blue-600 flex-shrink-0" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                <span className="text-sm font-semibold text-blue-900">Activating Auto-Pay…</span>
              </div>
              <p className="text-xs text-blue-800">Your bank account was connected successfully. We're activating your recurring payment — this takes a few seconds.</p>
            </div>

          ) : autoPayLoading ? (
            <div className="flex items-center justify-center py-8 gap-3 text-gray-500">
              <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
              <span className="text-sm">Setting up auto-pay...</span>
            </div>

          ) : autopayConfirmed && autoPayStatus?.hasAutoPay && !isAutoPayCancellationScheduled ? (
            /* ── AUTOPAY CONFIRMATION SCREEN (shown right after setup) ── */
            <div className="space-y-4">
              <div className="rounded-lg border border-green-200 bg-green-50 p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                    <svg className="h-6 w-6 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-base font-semibold text-green-900">Auto-Pay Activated!</div>
                    <div className="text-sm text-green-700">Your recurring payments are now set up.</div>
                  </div>
                </div>
                <div className="divide-y divide-green-200 rounded-lg border border-green-200 bg-white overflow-hidden text-sm">
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Monthly Amount</span>
                    <span className="font-bold text-green-700 text-base">{fmtAmt(autoPayStatus.subscription!.amount)}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Bank Account</span>
                    <span className="font-medium text-right">{pmLabel(autoPayStatus.paymentMethod)}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Payment Day</span>
                    <span className="font-medium">1st of each month</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">First Payment</span>
                    <span className="font-medium">{fmtDate(autoPayStatus.subscription!.nextPaymentDate)}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Property</span>
                    <span className="font-medium text-right max-w-xs">{propertyAddress || '—'}</span>
                  </div>
                </div>
                <p className="text-xs text-green-700">A confirmation has been sent to <span className="font-medium">{tenantEmail}</span>.</p>
              </div>
              <button
                onClick={() => setAutopayConfirmed(false)}
                className="w-full rounded-lg border border-gray-300 text-gray-600 py-2 text-sm hover:bg-gray-50 transition-colors"
              >
                View Auto-Pay Details
              </button>
            </div>

          ) : autoPayStatus?.hasAutoPay ? (
            /* ── ACTIVE AUTO-PAY DETAILS CARD ── */
            <div className="space-y-4">
              {/* Subscription card */}
              <div className={`rounded-lg border p-4 space-y-3 ${
                isAutoPayCancellationScheduled ? 'border-amber-200 bg-amber-50' : 'border-green-200 bg-green-50'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  <svg className={`h-5 w-5 ${isAutoPayCancellationScheduled ? 'text-amber-600' : 'text-green-600'}`} fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className={`text-sm font-semibold ${isAutoPayCancellationScheduled ? 'text-amber-800' : 'text-green-800'}`}>
                    {isAutoPayCancellationScheduled ? 'Auto-Pay Cancellation Scheduled' : 'Auto-Pay Active'}
                  </span>
                </div>
                <div className={`divide-y rounded-lg border bg-white overflow-hidden text-sm ${
                  isAutoPayCancellationScheduled ? 'divide-amber-200 border-amber-200' : 'divide-green-200 border-green-200'
                }`}>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Monthly Amount</span>
                    <span className={`font-bold ${isAutoPayCancellationScheduled ? 'text-amber-700' : 'text-green-700'}`}>
                      {fmtAmt(autoPayStatus.subscription!.amount)}
                    </span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Bank Account</span>
                    <span className="font-medium text-right">{pmLabel(autoPayStatus.paymentMethod)}</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Payment Day</span>
                    <span className="font-medium">1st of each month</span>
                  </div>
                  <div className="flex justify-between px-4 py-3">
                    <span className="text-gray-500">Next Payment</span>
                    <span className="font-medium">{fmtDate(autoPayStatus.subscription!.nextPaymentDate)}</span>
                  </div>
                  {autoPayStatus.lastPayment && (
                    <div className="flex justify-between px-4 py-3 bg-gray-50">
                      <span className="text-gray-500">Last Payment</span>
                      <span className="font-medium">{fmtAmt(autoPayStatus.lastPayment.amount)} · {fmtDate(autoPayStatus.lastPayment.date)}</span>
                    </div>
                  )}
                </div>
                {isAutoPayCancellationScheduled && autoPayEndDate && (
                  <p className="text-xs text-amber-800">
                    Cancellation confirmed. Auto-pay will end on <span className="font-semibold">{fmtDate(autoPayEndDate)}</span> and will not renew after that date.
                  </p>
                )}
              </div>

              {/* Cancel */}
              {isAutoPayCancellationScheduled ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  Automatic recurring rent payments have been scheduled to stop{autoPayEndDate ? ` on ${fmtDate(autoPayEndDate)}` : ''}.
                </div>
              ) : !cancelConfirm ? (
                <button
                  onClick={() => setCancelConfirm(true)}
                  className="w-full rounded-lg border border-gray-300 text-gray-600 px-4 py-2 text-sm hover:bg-gray-50 transition-colors"
                >
                  Cancel Auto-Pay
                </button>
              ) : (
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
                  <p className="text-sm text-red-800 font-medium">Cancel recurring rent payments?</p>
                  <p className="text-xs text-red-700">Your subscription will remain active until the end of the current billing period.</p>
                  <div className="flex gap-2">
                    <button onClick={handleCancelAutoPay} disabled={cancelLoading} className="flex-1 rounded-lg bg-red-600 text-white px-4 py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors">
                      {cancelLoading ? 'Cancelling...' : 'Yes, Cancel Auto-Pay'}
                    </button>
                    <button onClick={() => setCancelConfirm(false)} className="flex-1 rounded-lg border border-gray-300 text-gray-700 px-4 py-2 text-sm hover:bg-gray-50 transition-colors">
                      Keep Auto-Pay
                    </button>
                  </div>
                </div>
              )}

              {showAutopayTestPanel && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">Local Custom Auto-Pay Schedule</div>
                    <p className="mt-1 text-xs text-slate-700">
                      Schedule up to two extra ACH rent debits against the same saved auto-pay mandate without moving your normal 1st-of-the-month billing date.
                    </p>
                    <p className="mt-2 text-xs text-amber-800">
                      When live Stripe keys are active, these charges move real money. Keep this local server running until both scheduled times have passed.
                    </p>
                  </div>

                  {autopayTestError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                      {autopayTestError}
                    </div>
                  )}

                  {autopayTestMessage && (
                    <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-800">
                      {autopayTestMessage}
                    </div>
                  )}

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      onClick={() => void handleRunAutopayTest()}
                      disabled={autopayTestLoading}
                      className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                    >
                      {autopayTestLoading ? 'Working...' : 'Charge Monthly Amount Now'}
                    </button>
                    <button
                      onClick={() => setAutopayTestSchedule(createDefaultAutopayTestSchedule())}
                      disabled={autopayTestLoading}
                      className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                    >
                      Reset Suggested Times
                    </button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-medium text-slate-700">
                      Custom Renewal Time 1
                      <input
                        type="datetime-local"
                        value={autopayTestSchedule.first}
                        onChange={(e) => setAutopayTestSchedule((current) => ({ ...current, first: e.target.value }))}
                        className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300"
                      />
                    </label>
                    <label className="block text-xs font-medium text-slate-700">
                      Custom Renewal Time 2
                      <input
                        type="datetime-local"
                        value={autopayTestSchedule.second}
                        onChange={(e) => setAutopayTestSchedule((current) => ({ ...current, second: e.target.value }))}
                        className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300"
                      />
                    </label>
                  </div>

                  <button
                    onClick={() => void handleScheduleAutopayTests()}
                    disabled={autopayTestLoading}
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                  >
                    Schedule Custom Renewals
                  </button>

                  {autopayTestRuns.length > 0 && (
                    <div className="space-y-2">
                      {autopayTestRuns.map((run) => (
                        <div key={run.id} className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-xs text-slate-700">
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="font-semibold text-slate-900 capitalize">{run.status} custom renewal</div>
                              <div>Scheduled for {fmtDateTime(run.runAt)}</div>
                              {run.result?.invoiceId && (
                                <div>
                                  Invoice <span className="font-mono text-[11px]">{run.result.invoiceId}</span>
                                  {' '}· {run.result.status}
                                  {' '}· {fmtAmt(run.result.scheduledAmount)}
                                </div>
                              )}
                              {run.executedAt && <div>Processed at {fmtDateTime(run.executedAt)}</div>}
                              {run.error && <div className="text-red-700">{run.error}</div>}
                            </div>
                            {run.status === 'scheduled' && (
                              <button
                                onClick={() => void handleCancelAutopayTestJob(run.id)}
                                disabled={autopayTestLoading}
                                className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

          ) : (
            /* ── SET UP AUTO-PAY ── */
            <div className="space-y-4">
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 space-y-2">
                <p className="text-sm font-semibold text-blue-900">How Auto-Pay works</p>
                <ul className="text-xs text-blue-800 space-y-1.5">
                  <li>• Connect your bank account securely via Stripe</li>
                  <li>• Rent is automatically debited on the 1st of each month</li>
                  <li>• Lower fees than credit card (ACH bank transfer)</li>
                  <li>• Cancel anytime from this screen</li>
                  <li>• Instant email receipt after each payment</li>
                </ul>
              </div>

              {/* Pre-filled amount selector */}
              {monthlyRent && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Monthly Rent Amount</label>
                  <button
                    onClick={() => setUsePresetAmount(true)}
                    className={`w-full flex items-center justify-between rounded-lg border px-4 py-3 mb-2 transition-colors ${
                      usePresetAmount
                        ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500'
                        : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <div className="text-left">
                      <div className="text-sm font-semibold text-gray-800">{fmtAmt(monthlyRent)}/month</div>
                      <div className="text-xs text-gray-500">Your lease amount</div>
                    </div>
                    {usePresetAmount && (
                      <svg className="h-5 w-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => setUsePresetAmount(false)}
                    className={`w-full flex items-center justify-between rounded-lg border px-4 py-2 text-sm transition-colors ${
                      !usePresetAmount
                        ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500'
                        : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-gray-600">Enter a different amount</span>
                    {!usePresetAmount && <svg className="h-5 w-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>}
                  </button>
                </div>
              )}

              {(!monthlyRent || !usePresetAmount) && (
                <div>
                  {!monthlyRent && <label className="block text-sm font-medium text-gray-700 mb-2">Monthly Rent Amount</label>}
                  <div className="relative mt-2">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                    <input
                      type="number"
                      value={autopayAmount}
                      onChange={e => setAutopayAmount(e.target.value)}
                      placeholder="0.00"
                      step="0.01"
                      min="0"
                      className="block w-full pl-8 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              )}

              <button
                onClick={handleSetupAutoPay}
                disabled={autoPayLoading || !landlordAccountId}
                className="w-full rounded-lg bg-blue-600 text-white px-6 py-3 text-base font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-md"
              >
                {autoPayLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                    Redirecting to Stripe...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    Set Up Auto-Pay{usePresetAmount && monthlyRent ? ` — ${fmtAmt(monthlyRent)}/mo` : ''}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Payment Methods Info */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-blue-900 mb-2">Secure Payment Processing</div>
            <ul className="text-xs text-blue-800 space-y-1.5">
              <li>• <strong>ACH Bank Transfer:</strong> Direct from your bank account (lower fees)</li>
              <li>• <strong>Credit/Debit Card:</strong> Visa, Mastercard, American Express, Discover</li>
              <li>• Bank-level encryption with Stripe</li>
              <li>• Instant confirmation and receipt</li>
              <li>• Your payment information is never stored on our servers</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="text-xs text-gray-500 text-center">
        A 2% processing fee applies to all payments. This fee supports the platform and secure payment processing.
      </div>
    </div>
  );
}

