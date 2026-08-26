/**
 * StripeTransactions - Display and manage Stripe Connect transactions
 * Shows balance transactions, payouts, and syncs to bookkeeping system
 */

import { useState, useEffect } from 'react';

interface StripeTransaction {
  id: string;
  amount: number;
  currency: string;
  description: string;
  fee: number;
  net: number;
  type: string;
  status: string;
  created: number;
  date: string;
  reporting_category: string;
  available_on: string | null;
}

interface Payout {
  id: string;
  amount: number;
  currency: string;
  status: string;
  type: string;
  arrivalDate: string;
  created: string;
  description: string;
}

interface Balance {
  available: Array<{ amount: number; currency: string }>;
  pending: Array<{ amount: number; currency: string }>;
  connectReserved: Array<{ amount: number; currency: string }>;
}

interface StripeTransactionsProps {
  accountId: string;
  userId: string;
  propertyId?: string;
}

export default function StripeTransactions({ accountId, userId, propertyId }: StripeTransactionsProps) {
  const [activeTab, setActiveTab] = useState<'transactions' | 'payouts' | 'balance'>('transactions');
  const [transactions, setTransactions] = useState<StripeTransaction[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'platform' | 'bank'>('bank'); // Default to full bank history

  useEffect(() => {
    if (activeTab === 'transactions') {
      loadTransactions();
    } else if (activeTab === 'payouts') {
      loadPayouts();
    } else if (activeTab === 'balance') {
      loadBalance();
    }
  }, [activeTab, accountId, viewMode]); // Reload when view mode changes

  const loadTransactions = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Choose endpoint based on view mode
      const endpoint = viewMode === 'bank' 
        ? `/api/stripe-connect/bank-transactions/${accountId}?limit=100`
        : `/api/stripe-connect/transactions/${accountId}?limit=100`;
      
      const response = await fetch(endpoint);
      const data = await response.json();

      if (data.ok) {
        setTransactions(data.transactions);
        
        // Show helpful message if Financial Connections isn't set up
        if (viewMode === 'bank' && !data.financial_connections_enabled) {
          setError(data.message || 'Full bank transaction history not available. Please reconnect your bank account.');
        }
      } else {
        setError(data.error || 'Failed to load transactions');
      }
    } catch (err: any) {
      console.error('Error loading transactions:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadPayouts = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(`/api/stripe-connect/payouts/${accountId}?limit=50`);
      const data = await response.json();

      if (data.ok) {
        setPayouts(data.payouts);
      } else {
        setError(data.error || 'Failed to load payouts');
      }
    } catch (err: any) {
      console.error('Error loading payouts:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadBalance = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(`/api/stripe-connect/balance/${accountId}`);
      const data = await response.json();

      if (data.ok) {
        setBalance(data.balance);
      } else {
        setError(data.error || 'Failed to load balance');
      }
    } catch (err: any) {
      console.error('Error loading balance:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const syncToBookkeeping = async () => {
    try {
      setSyncing(true);
      setError(null);

      const response = await fetch('/api/stripe-connect/sync-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          userId,
          propertyId,
          startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Last 90 days
          endDate: new Date().toISOString().split('T')[0]
        })
      });

      const data = await response.json();

      if (data.ok) {
        alert(`✅ Successfully synced ${data.imported} transactions to bookkeeping!\n\nTotal: ${data.total}\nImported: ${data.imported}\nSkipped: ${data.skipped}`);
        loadTransactions();
      } else {
        setError(data.error || 'Failed to sync transactions');
      }
    } catch (err: any) {
      console.error('Error syncing transactions:', err);
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const formatCurrency = (amount: number, currency: string = 'usd') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase()
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const getTransactionTypeColor = (type: string) => {
    switch (type) {
      case 'charge':
      case 'payment':
        return 'text-green-700 bg-green-50';
      case 'payment_refund':
        return 'text-red-700 bg-red-50';
      case 'payout':
        return 'text-blue-700 bg-blue-50';
      case 'stripe_fee':
      case 'application_fee':
        return 'text-yellow-700 bg-yellow-50';
      default:
        return 'text-gray-700 bg-gray-50';
    }
  };

  const getPayoutStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return 'text-green-700 bg-green-50';
      case 'pending':
        return 'text-yellow-700 bg-yellow-50';
      case 'in_transit':
        return 'text-blue-700 bg-blue-50';
      case 'canceled':
      case 'failed':
        return 'text-red-700 bg-red-50';
      default:
        return 'text-gray-700 bg-gray-50';
    }
  };

  const filteredTransactions = filterType === 'all' 
    ? transactions 
    : transactions.filter(t => t.type === filterType);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-2xl font-bold text-gray-900">Stripe Transactions</h3>
          <p className="text-sm text-gray-600 mt-1">
            {viewMode === 'bank' 
              ? 'Complete bank account transaction history' 
              : 'Platform transactions only (payments through your app)'}
          </p>
        </div>
        <div className="flex gap-3">
          {/* View Mode Toggle */}
          <div className="flex rounded-lg border border-gray-300 overflow-hidden">
            <button
              onClick={() => setViewMode('bank')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                viewMode === 'bank'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              🏦 All Bank Transactions
            </button>
            <button
              onClick={() => setViewMode('platform')}
              className={`px-4 py-2 text-sm font-medium transition-colors border-l border-gray-300 ${
                viewMode === 'platform'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              💳 Platform Only
            </button>
          </div>
          
          <button
            onClick={syncToBookkeeping}
            disabled={syncing}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              syncing
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-indigo-600 text-white hover:bg-indigo-700'
            }`}
          >
            {syncing ? (
              <>
                <span className="inline-block animate-spin mr-2">⟳</span>
                Syncing...
              </>
            ) : (
              '🔄 Sync to Bookkeeping'
            )}
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">⚠️ {error}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab('transactions')}
            className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'transactions'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            💳 Transactions
          </button>
          <button
            onClick={() => setActiveTab('payouts')}
            className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'payouts'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            🏦 Payouts
          </button>
          <button
            onClick={() => setActiveTab('balance')}
            className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'balance'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            💰 Balance
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="inline-block animate-spin text-4xl">⟳</div>
            <p className="text-gray-600 mt-2">Loading...</p>
          </div>
        ) : (
          <>
            {/* Transactions Tab */}
            {activeTab === 'transactions' && (
              <div>
                {/* Filter Bar */}
                <div className="bg-gray-50 border-b border-gray-200 p-4">
                  <div className="flex items-center gap-4">
                    <label className="text-sm font-medium text-gray-700">Filter:</label>
                    <select
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value)}
                      className="px-3 py-1 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="all">All Transactions</option>
                      <option value="charge">Charges</option>
                      <option value="payment">Payments</option>
                      <option value="payment_refund">Refunds</option>
                      <option value="payout">Payouts</option>
                      <option value="stripe_fee">Fees</option>
                    </select>
                    <span className="text-sm text-gray-600">
                      Showing {filteredTransactions.length} of {transactions.length} transactions
                    </span>
                  </div>
                </div>

                {/* Transactions Table */}
                {filteredTransactions.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    No transactions found
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Date
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Description
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Type
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Amount
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Fee
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Net
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {filteredTransactions.map((txn) => (
                          <tr key={txn.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {formatDate(txn.date)}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-900">
                              {txn.description || 'No description'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`px-2 py-1 text-xs font-medium rounded-full ${getTransactionTypeColor(txn.type)}`}>
                                {txn.type.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                              {formatCurrency(txn.amount, txn.currency)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-red-600">
                              {txn.fee > 0 ? `-${formatCurrency(txn.fee, txn.currency)}` : '—'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                              {formatCurrency(txn.net, txn.currency)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-50 text-green-700">
                                {txn.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Payouts Tab */}
            {activeTab === 'payouts' && (
              <div>
                {payouts.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    No payouts found
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Created
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Arrival Date
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Description
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Amount
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {payouts.map((payout) => (
                          <tr key={payout.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {formatDate(payout.created)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {formatDate(payout.arrivalDate)}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-900">
                              {payout.description || 'Bank payout'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                              {formatCurrency(payout.amount, payout.currency)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`px-2 py-1 text-xs font-medium rounded-full ${getPayoutStatusColor(payout.status)}`}>
                                {payout.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Balance Tab */}
            {activeTab === 'balance' && (
              <div className="p-6">
                {balance ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Available Balance */}
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                      <h4 className="text-sm font-medium text-green-800 mb-2">Available Balance</h4>
                      {balance.available.map((bal, idx) => (
                        <div key={idx} className="text-3xl font-bold text-green-900">
                          {formatCurrency(bal.amount, bal.currency)}
                        </div>
                      ))}
                      <p className="text-xs text-green-700 mt-2">Ready for payout</p>
                    </div>

                    {/* Pending Balance */}
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
                      <h4 className="text-sm font-medium text-yellow-800 mb-2">Pending Balance</h4>
                      {balance.pending.map((bal, idx) => (
                        <div key={idx} className="text-3xl font-bold text-yellow-900">
                          {formatCurrency(bal.amount, bal.currency)}
                        </div>
                      ))}
                      <p className="text-xs text-yellow-700 mt-2">Being processed</p>
                    </div>

                    {/* Reserved Balance */}
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
                      <h4 className="text-sm font-medium text-blue-800 mb-2">Reserved Balance</h4>
                      {balance.connectReserved && balance.connectReserved.length > 0 ? (
                        balance.connectReserved.map((bal, idx) => (
                          <div key={idx} className="text-3xl font-bold text-blue-900">
                            {formatCurrency(bal.amount, bal.currency)}
                          </div>
                        ))
                      ) : (
                        <div className="text-3xl font-bold text-blue-900">$0.00</div>
                      )}
                      <p className="text-xs text-blue-700 mt-2">Held by Stripe</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-gray-500 py-8">
                    No balance information available
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Info Box */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
        <h4 className="font-medium text-indigo-900 mb-2">💡 About Transaction Views</h4>
        <ul className="text-sm text-indigo-800 space-y-1 list-disc list-inside">
          <li><strong>All Bank Transactions:</strong> Complete transaction history from your bank account (requires Financial Connections)</li>
          <li><strong>Platform Only:</strong> Just the rent payments made through your app</li>
          <li>Click "Sync to Bookkeeping" to automatically import and categorize transactions</li>
          <li>Syncing covers the last 90 days and skips duplicates automatically</li>
          <li>All transactions maintain a complete audit trail in your books</li>
        </ul>
      </div>
    </div>
  );
}
