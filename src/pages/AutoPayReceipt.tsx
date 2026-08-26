import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

export default function AutoPayReceipt() {
  const [searchParams] = useSearchParams();
  const subscriptionId = searchParams.get('subscriptionId');
  const tenantEmail = searchParams.get('tenantEmail') || '';
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantEmail) { setError('Missing tenant email.'); setLoading(false); return; }
    const params = new URLSearchParams({ tenantEmail });
    fetch(`/api/stripe-connect/autopay-status?${params}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) setStatus(data);
        else setError(data.error || 'Auto-pay details not found.');
      })
      .catch(() => setError('Failed to load auto-pay details.'))
      .finally(() => setLoading(false));
  }, [tenantEmail, subscriptionId]);

  const fmtDate = (d: string) =>
    new Date(d + (d.includes('T') ? '' : 'T12:00:00')).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <svg className="animate-spin h-8 w-8 text-blue-600" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    </div>
  );

  if (error || !status?.hasAutoPay) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center max-w-sm">
        <div className="text-red-600 font-semibold mb-2">Auto-Pay Details Not Found</div>
        <div className="text-gray-500 text-sm mb-4">{error || 'No active auto-pay subscription found.'}</div>
        <Link to="/tenant/dashboard" className="text-blue-600 text-sm hover:underline">← Back to Dashboard</Link>
      </div>
    </div>
  );

  const sub = status.subscription;
  const pm = status.paymentMethod;

  const pmLabel = () => {
    if (!pm) return 'Bank account';
    if (pm.type === 'us_bank_account') {
      return [pm.bankName, pm.accountType && `(${pm.accountType})`, pm.last4 && `ending in ${pm.last4}`].filter(Boolean).join(' ');
    }
    return [pm.brand && pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1), pm.last4 && `ending in ${pm.last4}`].filter(Boolean).join(' ');
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-start justify-center py-12 px-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="rounded-t-xl p-8 text-center bg-blue-600">
          <div className="h-16 w-16 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4">
            <svg className="h-8 w-8 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">Auto-Pay Confirmed</h1>
          <p className="text-white/80 text-sm">Your recurring rent payments are active.</p>
        </div>

        {/* Receipt body */}
        <div className="bg-white border border-gray-200 border-t-0 rounded-b-xl shadow-sm">
          <div className="divide-y divide-gray-100">
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Monthly Amount</span>
              <span className="font-bold text-lg text-blue-700">${sub.amount?.toFixed(2)}/mo</span>
            </div>
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Bank Account</span>
              <span className="font-medium text-sm text-right max-w-xs">{pmLabel()}</span>
            </div>
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Payment Day</span>
              <span className="font-medium text-sm">1st of each month</span>
            </div>
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Next Payment</span>
              <span className="font-medium text-sm">{fmtDate(sub.nextPaymentDate)}</span>
            </div>
            {status.lastPayment && (
              <div className="flex justify-between px-6 py-4">
                <span className="text-gray-500 text-sm">Last Payment</span>
                <span className="font-medium text-sm">${status.lastPayment.amount.toFixed(2)} · {fmtDate(status.lastPayment.date)}</span>
              </div>
            )}
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Status</span>
              <span className="text-sm font-semibold px-2.5 py-0.5 rounded-full bg-green-100 text-green-800 capitalize">{sub.status}</span>
            </div>
            <div className="flex justify-between px-6 py-4 bg-gray-50 rounded-b-xl">
              <span className="text-gray-500 text-sm">Subscription ID</span>
              <span className="font-mono text-xs text-gray-600 truncate max-w-[220px]">{sub.id}</span>
            </div>
          </div>

          <div className="px-6 py-5 border-t border-gray-100 space-y-2">
            <p className="text-xs text-gray-500 text-center mb-3">
              A confirmation email has been sent to <span className="font-medium">{tenantEmail}</span>. You can cancel auto-pay anytime from your dashboard.
            </p>
            <Link
              to="/tenant/dashboard"
              className="block w-full text-center bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
            >
              Back to Dashboard
            </Link>
            <button
              onClick={() => window.print()}
              className="block w-full text-center border border-gray-300 text-gray-600 py-2.5 rounded-lg text-sm hover:bg-gray-50 transition-colors"
            >
              Print Receipt
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
