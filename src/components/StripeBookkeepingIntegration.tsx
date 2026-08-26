/**
 * StripeBookkeepingIntegration - Connects bank accounts via Stripe Financial Connections
 * Provides read-only access to transaction history for bookkeeping
 */

import { useState, useEffect } from 'react';
import { bookkeepingClient } from '../services/canonicalBookkeepingClient';

interface BankTransaction {
  id: string;
  amount: number;
  currency: string;
  description: string;
  date: string;
  status: string;
  type: string;
  category: string;
  merchant: string | null;
  pending: boolean;
}

export interface StripeBookkeepingIntegrationProps {
  userId: string;
  userEmail: string;
  propertyId?: string;
  onTransactionsSynced?: (count: number) => void;
}

export default function StripeBookkeepingIntegration({ 
  userId, 
  userEmail, 
  propertyId,
  onTransactionsSynced
}: StripeBookkeepingIntegrationProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionClientSecret, setSessionClientSecret] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [syncSuccess, setSyncSuccess] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [connectedAccountId, setConnectedAccountId] = useState<string | null>(null);
  const [accountDetails, setAccountDetails] = useState<any>(null);
  const [unpostedCount, setUnpostedCount] = useState<number>(0);
  const [isPostingAll, setIsPostingAll] = useState(false);
  const [showTransactions, setShowTransactions] = useState(false);
  const [isSampleDataLoaded, setIsSampleDataLoaded] = useState(false);

  useEffect(() => {
    // Check if already connected by trying to load transactions
    checkConnection();
    checkUnpostedTransactions();
  }, [userId]);

  const checkUnpostedTransactions = async () => {
    try {
      const response = await fetch('/api/bookkeeping/bank-transactions/unposted');
      const data = await response.json();
      if (data.ok) {
        setUnpostedCount(data.count || 0);
      }
    } catch (err) {
      console.error('Error checking unposted transactions:', err);
    }
  };

  const handlePostAllTransactions = async () => {
    try {
      setIsPostingAll(true);
      setError(null);
      
      const response = await fetch('/api/bookkeeping/bank-transactions/post-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const data = await response.json();
      
      if (data.ok) {
        const message = data.posted > 0
          ? `✅ Posted ${data.posted} transactions to journal entries`
          : 'No transactions to post';
        setSyncSuccess(message);
        
        // Refresh unposted count
        setUnpostedCount(0);
        await checkUnpostedTransactions();
        
        if (data.errors && data.errors.length > 0) {
          console.warn('Some transactions had errors:', data.errors);
          setError(`${data.errors.length} transactions failed to post. Check console for details.`);
        }
        
        setTimeout(() => setSyncSuccess(null), 8000);
      } else {
        throw new Error(data.error || 'Failed to post transactions');
      }
    } catch (err: any) {
      console.error('Error posting transactions:', err);
      setError(err.message || 'Failed to post transactions');
    } finally {
      setIsPostingAll(false);
    }
  };

  const checkConnection = async () => {
    // Check if user has Financial Connections accounts
    try {
      const response = await fetch(`/api/stripe-connect/check-financial-connections/${userId}`);
      const data = await response.json();
      
      if (data.ok && data.connected && data.accounts && data.accounts.length > 0) {
        setIsConnected(true);
        setCustomerId(data.customerId);
        setConnectedAccountId(data.accounts[0].id);
        setAccountDetails(data.accounts[0]);
        // Try to load transactions
        loadTransactions(data.accounts[0].id);
      } else {
        setIsConnected(false);
      }
    } catch (err) {
      // Not connected yet
      setIsConnected(false);
    }
  };

  const handleConnectBank = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Create Financial Connections session
      const response = await fetch('/api/stripe-connect/create-financial-connections-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to create connection session');
      }

      setSessionClientSecret(data.clientSecret);
      setCustomerId(data.customerId);
      
      // Load Stripe.js and Financial Connections SDK
      await loadStripeFinancialConnections(data.clientSecret);
    } catch (err: any) {
      console.error('Error connecting bank:', err);
      setError(err.message || 'Failed to connect bank account');
    } finally {
      setIsLoading(false);
    }
  };

  const loadStripeFinancialConnections = async (clientSecret: string) => {
    // Dynamically load Stripe.js if not already loaded
    if (!(window as any).Stripe) {
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      document.head.appendChild(script);
      await new Promise((resolve) => { script.onload = resolve; });
    }

    const stripe = (window as any).Stripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);
    
    // Collect Financial Connections account
    const { financialConnectionsSession, error: fcError } = await stripe.collectFinancialConnectionsAccounts({
      clientSecret
    });

    if (fcError) {
      throw new Error(fcError.message);
    }

    if (financialConnectionsSession) {
      setIsConnected(true);
      setSyncSuccess('Bank account connected successfully!');
      setTimeout(() => setSyncSuccess(null), 5000);
      
      // Store the connected account ID if available
      if (financialConnectionsSession.accounts && financialConnectionsSession.accounts.length > 0) {
        setConnectedAccountId(financialConnectionsSession.accounts[0].id);
      }
      
      // After connection, check for transactions
      checkConnection();
    }
  };

  const loadTransactions = async (accountId?: string) => {
    if (!accountId) return;

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`/api/stripe-connect/financial-connections-transactions/${accountId}?limit=100`);
      const data = await response.json();

      if (data.ok && data.transactions) {
        setTransactions(data.transactions);
      } else if (data.syncing) {
        setError('Transaction data is being synchronized from your bank. This usually takes 2-3 minutes. Please refresh in a moment.');
      } else {
        setError(data.message || 'Unable to load transactions');
      }
    } catch (err: any) {
      console.error('Error loading transactions:', err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const clearAndResync = async () => {
    if (!confirm('This will delete all existing bank journal entries and reimport them. Continue?')) {
      return;
    }
    
    try {
      setIsLoading(true);
      setError(null);
      setSyncSuccess(null);

      // Clear existing entries
      const clearData = await bookkeepingClient.clearBankEntries();
      console.log('Cleared entries:', clearData);
      
      if (!clearData.ok) {
        throw new Error(clearData.error || 'Failed to clear entries');
      }
      
      setSyncSuccess(`Deleted ${clearData.deleted} old entries. Now resyncing...`);
      
      // Wait a moment then resync
      await new Promise(r => setTimeout(r, 1500));
      
      // Now sync fresh
      await syncTransactions();
      
    } catch (err: any) {
      console.error('Error clearing and resyncing:', err);
      setError(err.message || 'Failed to clear and resync');
      setIsLoading(false);
    }
  };

  const syncTransactions = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setSyncSuccess(null);

      const response = await fetch('/api/stripe-connect/sync-financial-connections-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          customerId: customerId,
          accountId: connectedAccountId,
          propertyId,
        })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to sync transactions');
      }

      // If there were posting errors, try posting unposted transactions
      if (data.postingErrors && data.postingErrors > 0) {
        console.log('Retrying posting for failed transactions...');
        try {
          const postResponse = await fetch('/api/bookkeeping/bank-transactions/post-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const postData = await postResponse.json();
          console.log('Post-all result:', postData);
        } catch (postErr) {
          console.error('Error in post-all:', postErr);
        }
      }

      const shadowLedger = data.shadowLedger || {};
      const skippedDetails = [];
      if (Number(shadowLedger.duplicates || 0) > 0) {
        skippedDetails.push(`${shadowLedger.duplicates} duplicates`);
      }
      if (Number(shadowLedger.pendingMatch || 0) > 0) {
        skippedDetails.push(`${shadowLedger.pendingMatch} staged for match/review`);
      }
      if (Number(shadowLedger.unsupported || 0) > 0) {
        skippedDetails.push(`${shadowLedger.unsupported} unsupported`);
      }
      const failedCount = Number(shadowLedger.failed || 0) + Number(shadowLedger.notConfigured || 0);
      if (failedCount > 0) {
        skippedDetails.push(`${failedCount} failed`);
      }
      const skippedSummary = skippedDetails.length > 0
        ? ` Skipped breakdown: ${skippedDetails.join(', ')}.`
        : '';

      const message = data.imported > 0 
        ? `Created ${data.imported} canonical journal entr${data.imported === 1 ? 'y' : 'ies'} from ${data.total || data.imported} bank transaction${Number(data.total || data.imported) === 1 ? '' : 's'}.${skippedSummary}`
        : data.skipped > 0 
          ? skippedSummary
            ? `No new journal entries created.${skippedSummary}`
            : `${data.skipped} transaction${data.skipped === 1 ? '' : 's'} were already synced`
          : data.message || 'Sync complete';
      
      setSyncSuccess(message);
      setTimeout(() => setSyncSuccess(null), 8000);

      if (onTransactionsSynced) {
        onTransactionsSynced(data.imported);
      }

      // Reload transactions and check for unposted
      checkConnection();
      checkUnpostedTransactions();
    } catch (err: any) {
      console.error('Error syncing transactions:', err);
      setError(err.message || 'Failed to sync transactions');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveBankAccount = async () => {
    const confirmRemove = window.confirm(
      'Are you sure you want to remove this bank account connection? ' +
      'This will disconnect the account but will not delete any previously synced transactions.'
    );

    if (!confirmRemove) return;

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/stripe-connect/disconnect-financial-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to remove bank account');
      }

      setIsConnected(false);
      setTransactions([]);
      setCustomerId(null);
      setSessionClientSecret(null);
      setConnectedAccountId(null);
      setSyncSuccess('Bank account removed successfully');
      setTimeout(() => setSyncSuccess(null), 5000);
    } catch (err: any) {
      console.error('Error removing bank account:', err);
      setError(err.message || 'Failed to remove bank account');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddNewBankAccount = async () => {
    const confirmAdd = window.confirm(
      'This will disconnect your current bank account and allow you to add a new one. ' +
      'Previously synced transactions will be preserved. Continue?'
    );

    if (!confirmAdd) return;

    try {
      setIsLoading(true);
      setError(null);

      // First disconnect the current account
      const disconnectResponse = await fetch('/api/stripe-connect/disconnect-financial-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });

      const disconnectData = await disconnectResponse.json();

      if (!disconnectData.ok) {
        throw new Error(disconnectData.error || 'Failed to disconnect current bank account');
      }

      // Reset state
      setIsConnected(false);
      setTransactions([]);
      setCustomerId(null);
      setSessionClientSecret(null);
      setConnectedAccountId(null);

      // Now initiate new connection
      await handleConnectBank();
    } catch (err: any) {
      console.error('Error adding new bank account:', err);
      setError(err.message || 'Failed to add new bank account');
      setIsLoading(false);
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
    return type === 'credit' ? 'text-green-700 bg-green-50' : 'text-red-700 bg-red-50';
  };

  const filteredTransactions = filterType === 'all' 
    ? transactions 
    : transactions.filter(t => t.type === filterType);

  const hasTransactionFeed = isConnected || isSampleDataLoaded;

  const handleLoadSampleTransactions = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setSyncSuccess(null);

      const response = await fetch('/api/stripe-connect/project-rental-analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          useSampleData: true,
          userId,
          propertyId
        })
      });

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.error || 'Failed to load sample property transactions');
      }

      const sampleTransactions: BankTransaction[] = (data.bookkeeping?.transactions || []).map((txn: any) => ({
        id: txn.id,
        amount: Number(txn.amount || 0),
        currency: 'usd',
        description: txn.description,
        date: txn.date,
        status: (txn.status || 'posted').toLowerCase(),
        type: txn.type === 'Income' ? 'credit' : 'debit',
        category: txn.category || 'uncategorized',
        merchant: txn.vendor || null,
        pending: false
      }));

      setTransactions(sampleTransactions);
      setIsSampleDataLoaded(true);
      setShowTransactions(true);
      setUnpostedCount(0);

      if (!isConnected) {
        setAccountDetails({ institutionName: 'Sample Property Feed', last4: 'TEST' });
      }

      // Sync sample transactions to Firestore bookkeeping as journal entries
      try {
        const syncData = await bookkeepingClient.syncSampleTransactions({
          transactions: sampleTransactions,
          propertyId,
        });
        if (syncData.ok && onTransactionsSynced) {
          onTransactionsSynced(syncData.imported);
        }
      } catch (syncErr) {
        console.warn('[Sample Feed] Could not sync to Firestore bookkeeping:', syncErr);
      }

      window.dispatchEvent(new CustomEvent('houseyield:sample-rental-analytics-loaded', {
        detail: data
      }));

      setSyncSuccess(`Loaded ${sampleTransactions.length} sample transactions and synced to bookkeeping.`);
      setTimeout(() => setSyncSuccess(null), 8000);
    } catch (err: any) {
      console.error('Error loading sample transactions:', err);
      setError(err.message || 'Failed to load sample transactions');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="stripe-bookkeeping-integration">
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          Bank Account Integration
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Connect your bank account via Stripe Financial Connections to automatically import transaction history into your bookkeeping system.
        </p>

        {!isConnected && (
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleConnectBank}
              disabled={isLoading}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
            >
              {isLoading ? (
                <>
                  <span className="inline-block animate-spin mr-2">⟳</span>
                  Connecting...
                </>
              ) : (
                '🏦 Connect Bank Account'
              )}
            </button>
            <button
              onClick={handleLoadSampleTransactions}
              disabled={isLoading}
              className="px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
            >
              {isLoading ? (
                <>
                  <span className="inline-block animate-spin mr-2">⟳</span>
                  Loading Sample...
                </>
              ) : (
                'Load Sample Property Feed'
              )}
            </button>
          </div>
        )}
      </div>

      {/* Success message */}
      {syncSuccess && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="text-sm text-green-800">{syncSuccess}</p>
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <p className="text-sm text-red-800">{error}</p>
          </div>
        </div>
      )}

      {/* Connected State */}
      {hasTransactionFeed && (
        <div className="space-y-4">
          <div className="p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="font-medium text-gray-900">
                    {isConnected ? 'Bank Account Connected' : 'Sample Property Feed Loaded'}
                  </p>
                  <p className="text-sm text-gray-500">
                    {isConnected && accountDetails ? (
                      <>{accountDetails.institutionName} ••••{accountDetails.last4}</>
                    ) : (
                      '12 months of simulated rent and property expenses for analytics testing'
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleLoadSampleTransactions}
                  disabled={isLoading}
                  className="px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                >
                  {isLoading ? (
                    <>
                      <span className="inline-block animate-spin mr-2">⟳</span>
                      Loading...
                    </>
                  ) : (
                    'Load Sample Feed'
                  )}
                </button>
                {isConnected && (
                  <>
                    <button
                      onClick={syncTransactions}
                      disabled={isLoading}
                      className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                    >
                      {isLoading ? (
                        <>
                          <span className="inline-block animate-spin mr-2">⟳</span>
                          Syncing...
                        </>
                      ) : (
                        '🔄 Sync to Bookkeeping'
                      )}
                    </button>
                    <button
                      onClick={clearAndResync}
                      disabled={isLoading}
                      className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                      title="Delete all bank entries and reimport with corrected logic"
                    >
                      {isLoading ? (
                        <>
                          <span className="inline-block animate-spin mr-2">⟳</span>
                          Processing...
                        </>
                      ) : (
                        '🔄 Clear & Resync'
                      )}
                    </button>
                    <button
                      onClick={handleAddNewBankAccount}
                      disabled={isLoading}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                      title="Switch to a different bank account"
                    >
                      {isLoading ? (
                        <>
                          <span className="inline-block animate-spin mr-2">⟳</span>
                          Switching...
                        </>
                      ) : (
                        '🏦 Add New Bank'
                      )}
                    </button>
                    <button
                      onClick={handleRemoveBankAccount}
                      disabled={isLoading}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                      title="Disconnect bank account"
                    >
                      {isLoading ? (
                        <>
                          <span className="inline-block animate-spin mr-2">⟳</span>
                          Removing...
                        </>
                      ) : (
                        '🗑️ Remove Bank'
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Unposted Transactions Alert */}
          {isConnected && unpostedCount > 0 && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                    <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-medium text-amber-900">{unpostedCount} Unposted Transactions</p>
                    <p className="text-sm text-amber-700">
                      These bank transactions haven't been posted to journal entries yet
                    </p>
                  </div>
                </div>
                <button
                  onClick={handlePostAllTransactions}
                  disabled={isPostingAll}
                  className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                >
                  {isPostingAll ? (
                    <>
                      <span className="inline-block animate-spin mr-2">⟳</span>
                      Posting...
                    </>
                  ) : (
                    '📝 Post to Journal'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Transactions Table - Collapsible */}
          {transactions.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              {/* Collapsible Header */}
              <button
                onClick={() => setShowTransactions(!showTransactions)}
                className="w-full bg-gray-50 border-b border-gray-200 p-4 flex items-center justify-between hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <svg 
                    className={`w-5 h-5 text-gray-500 transition-transform duration-200 ${showTransactions ? 'rotate-90' : ''}`} 
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700">
                    Bank Transactions ({transactions.length})
                  </span>
                </div>
                <span className="text-xs text-gray-500">
                  {showTransactions ? 'Click to collapse' : 'Click to expand'}
                </span>
              </button>

              {/* Collapsible Content */}
              {showTransactions && (
                <>
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
                        <option value="credit">Credits (Incoming)</option>
                        <option value="debit">Debits (Outgoing)</option>
                      </select>
                      <span className="text-sm text-gray-600">
                        Showing {filteredTransactions.length} of {transactions.length} transactions
                      </span>
                    </div>
                  </div>

                  {/* Transactions Table */}
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
                            Category
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Type
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
                        {filteredTransactions.map((txn) => (
                          <tr key={txn.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {formatDate(txn.date)}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-900">
                              <div>{txn.description}</div>
                              {txn.merchant && (
                                <div className="text-xs text-gray-500">{txn.merchant}</div>
                              )}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                              {txn.category}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`px-2 py-1 text-xs font-medium rounded-full ${getTransactionTypeColor(txn.type)}`}>
                                {txn.type}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                              {formatCurrency(txn.amount, txn.currency)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                                txn.pending ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'
                              }`}>
                                {txn.pending ? 'pending' : txn.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Info Box */}
      <div className="mt-6 bg-indigo-50 border border-indigo-200 rounded-lg p-4">
        <h4 className="font-medium text-indigo-900 mb-2">💡 About Stripe Financial Connections</h4>
        <ul className="text-sm text-indigo-800 space-y-1 list-disc list-inside">
          <li><strong>Read-Only Access:</strong> View transaction history without payment processing capabilities</li>
          <li><strong>Complete History:</strong> Access all bank transactions, not just app payments</li>
          <li><strong>Bank-Level Security:</strong> Your credentials are never stored by us</li>
          <li><strong>Automatic Categorization:</strong> Transactions are intelligently categorized</li>
          <li><strong>Bookkeeping Integration:</strong> Syncs last 90 days and skips duplicates</li>
          <li><strong>Full Audit Trail:</strong> GAAP-compliant records maintained</li>
        </ul>
      </div>
    </div>
  );
}
