import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

export default function PaymentReceipt() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [receipt, setReceipt] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) { setError('No session ID provided.'); setLoading(false); return; }
    fetch(`/api/stripe-connect/receipt/${sessionId}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) setReceipt(data);
        else setError(data.error || 'Receipt not found.');
      })
      .catch(() => setError('Failed to load receipt.'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <svg className="animate-spin h-8 w-8 text-blue-600" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    </div>
  );

  if (error) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center max-w-sm">
        <div className="text-red-600 font-semibold mb-2">Receipt Not Found</div>
        <div className="text-gray-500 text-sm mb-4">{error}</div>
        <Link to="/tenant/dashboard" className="text-blue-600 text-sm hover:underline">← Back to Dashboard</Link>
      </div>
    </div>
  );

  const isPaid = receipt.status === 'paid';

  return (
    <div className="min-h-screen bg-gray-50 flex items-start justify-center py-12 px-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className={`rounded-t-xl p-8 text-center ${isPaid ? 'bg-green-600' : 'bg-amber-500'}`}>
          <div className="h-16 w-16 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4">
            <svg className="h-8 w-8 text-white" fill="currentColor" viewBox="0 0 20 20">
              {isPaid
                ? <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                : <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 102 0V6zm0 6a1 1 0 10-2 0 1 1 0 002 0z" clipRule="evenodd" />
              }
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">
            {isPaid ? 'Payment Received' : 'Payment Processing'}
          </h1>
          <p className="text-white/80 text-sm">
            {isPaid ? 'Your rent payment has been confirmed.' : 'ACH payments typically settle in 3–5 business days.'}
          </p>
        </div>

        {/* Receipt body */}
        <div className="bg-white border border-gray-200 border-t-0 rounded-b-xl shadow-sm">
          <div className="divide-y divide-gray-100">
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Amount</span>
              <span className={`font-bold text-lg ${isPaid ? 'text-green-700' : 'text-amber-600'}`}>
                ${receipt.amount?.toFixed(2)}
              </span>
            </div>
            {receipt.tenantName && (
              <div className="flex justify-between px-6 py-4">
                <span className="text-gray-500 text-sm">Tenant</span>
                <span className="font-medium text-sm text-right">{receipt.tenantName}</span>
              </div>
            )}
            {receipt.propertyAddress && (
              <div className="flex justify-between px-6 py-4">
                <span className="text-gray-500 text-sm">Property</span>
                <span className="font-medium text-sm text-right max-w-xs">{receipt.propertyAddress}</span>
              </div>
            )}
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Date</span>
              <span className="font-medium text-sm">{fmtDate(receipt.date)}</span>
            </div>
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Payment Method</span>
              <span className="font-medium text-sm capitalize">
                {receipt.paymentMethod === 'us_bank_account' ? 'ACH Bank Transfer' : receipt.paymentMethod}
              </span>
            </div>
            <div className="flex justify-between px-6 py-4">
              <span className="text-gray-500 text-sm">Status</span>
              <span className={`text-sm font-semibold px-2.5 py-0.5 rounded-full ${isPaid ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                {isPaid ? 'Settled' : 'Pending'}
              </span>
            </div>
            <div className="flex justify-between px-6 py-4 bg-gray-50 rounded-b-xl">
              <span className="text-gray-500 text-sm">Transaction ID</span>
              <span className="font-mono text-xs text-gray-600 truncate max-w-[220px]">{receipt.transactionId}</span>
            </div>
          </div>

          <div className="px-6 py-5 border-t border-gray-100">
            <Link
              to="/tenant/dashboard"
              className="block w-full text-center bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
            >
              Back to Dashboard
            </Link>
            <button
              onClick={() => window.print()}
              className="block w-full text-center mt-2 border border-gray-300 text-gray-600 py-2.5 rounded-lg text-sm hover:bg-gray-50 transition-colors"
            >
              Print Receipt
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
