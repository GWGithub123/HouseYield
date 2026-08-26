/**
 * BrokerageAccountConnect - Connect brokerage/investment accounts via Stripe Financial Connections
 * Allows users to link their brokerage accounts to automatically import holdings and balances
 */

import { useState, useEffect } from 'react';

interface BrokerageAccount {
  id: string;
  institutionName: string;
  displayName: string;
  last4: string;
  status: string;
  category: string;
  subcategory: string;
  balance?: {
    current: number;
    cash?: number;
    asOf?: string;
  } | null;
}

interface BrokerageTransaction {
  id: string;
  amount: number;
  currency: string;
  description: string;
  date: string;
  type: string;
  investmentType: string;
  category: string;
}

interface ImportedHolding {
  ticker: string;
  source: string;
  lastDividend?: number;
  shares?: number | null;
  avgCostBasis?: number | null;
  firstBuyDate?: string | null;
  totalDividends?: number | null;
  transactionCount?: number;
  confidence?: 'high' | 'medium' | 'low';
  inferenceNotes?: string[] | string;
}

interface TransactionSummary {
  totalBuys: number;
  totalSells: number;
  totalDividends: number;
  analyzedTransactions: number;
}

interface BrokerageAccountConnectProps {
  userId: string;
  userEmail?: string;
  compact?: boolean;
  onAccountConnected?: (accounts: BrokerageAccount[]) => void;
  onBalanceUpdated?: (balance: number) => void;
  onHoldingsImported?: (holdings: ImportedHolding[]) => void;
}

export default function BrokerageAccountConnect({
  userId,
  userEmail,
  compact = false,
  onAccountConnected,
  onBalanceUpdated,
  onHoldingsImported
}: BrokerageAccountConnectProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<BrokerageAccount[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [showTransactions, setShowTransactions] = useState(false);
  const [transactions, setTransactions] = useState<BrokerageTransaction[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [importedData, setImportedData] = useState<{
    balance: number | null;
    holdings: ImportedHolding[];
    dividends: any[];
    transactionSummary?: TransactionSummary | null;
    reconciliation?: {
      totalHoldingsValue: number;
      balanceCurrent: number;
      discrepancy: number;
      asOf?: string | null;
    } | null;
  } | null>(null);

  // Load connected accounts on mount
  useEffect(() => {
    checkConnectedAccounts();
  }, [userId]);

  const checkConnectedAccounts = async () => {
    try {
      const response = await fetch(`/api/stripe-connect/brokerage-accounts/${userId}`);
      const data = await response.json();

      if (data.ok && data.accounts && data.accounts.length > 0) {
        setAccounts(data.accounts);
        setIsConnected(true);
        if (onAccountConnected) {
          onAccountConnected(data.accounts);
        }
        
        // Auto-load balance for first account
        if (data.accounts.length > 0) {
          loadAccountBalance(data.accounts[0].id);
        }
      } else {
        setAccounts([]);
        setIsConnected(false);
      }
    } catch (err) {
      console.error('Error checking brokerage accounts:', err);
      setIsConnected(false);
    }
  };

  const loadAccountBalance = async (accountId: string) => {
    try {
      const response = await fetch(`/api/stripe-connect/brokerage-balance/${accountId}`);
      const data = await response.json();

      if (data.ok && data.balance) {
        // Update account with balance
        setAccounts(prev => prev.map(acc => 
          acc.id === accountId 
            ? { ...acc, balance: { current: data.balance.current / 100, cash: data.balance.cash?.available / 100 } }
            : acc
        ));
        
        if (onBalanceUpdated) {
          onBalanceUpdated(data.balance.current / 100);
        }
      }
    } catch (err) {
      console.error('Error loading balance:', err);
    }
  };

  const handleConnectBrokerage = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Create brokerage connection session
      const response = await fetch('/api/stripe-connect/create-brokerage-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, userEmail })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to create connection session');
      }

      // Load Stripe.js and launch Financial Connections
      await launchStripeFinancialConnections(data.clientSecret);
    } catch (err: any) {
      console.error('Error connecting brokerage:', err);
      setError(err.message || 'Failed to connect brokerage account');
    } finally {
      setIsLoading(false);
    }
  };

  const launchStripeFinancialConnections = async (clientSecret: string) => {
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
      setSuccess('Brokerage account connected successfully!');
      setTimeout(() => setSuccess(null), 5000);
      
      // Refresh connected accounts
      await checkConnectedAccounts();
    }
  };

  const handleLoadTransactions = async (accountId: string) => {
    try {
      setIsLoading(true);
      setError(null);
      setSelectedAccountId(accountId);

      const response = await fetch(`/api/stripe-connect/brokerage-transactions/${accountId}?limit=50`);
      const data = await response.json();

      if (data.ok) {
        setTransactions(data.transactions || []);
        setShowTransactions(true);
        
        if (data.syncing) {
          setSuccess('Transaction data is being synchronized. Please check back in a few minutes.');
        }
      } else {
        setError(data.message || 'Unable to load transactions');
      }
    } catch (err: any) {
      console.error('Error loading transactions:', err);
      setError(err.message || 'Failed to load transactions');
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportHoldings = async (accountId: string) => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/stripe-connect/import-brokerage-holdings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, accountId })
      });

      const data = await response.json();

      if (data.ok) {
        // Use new 'holdings' field (from buy/sell analysis) with fallback to old 'inferredHoldings'
        const holdingsList = data.holdings || data.inferredHoldings || [];
        
        setImportedData({
          balance: data.balance?.current || null,
          holdings: holdingsList,
          dividends: data.recentDividends || [],
          transactionSummary: data.transactionSummary || null,
          reconciliation: data.reconciliation || null
        });

        const holdingCount = holdingsList.length;
        const summaryMsg = data.transactionSummary 
          ? `Analyzed ${data.transactionSummary.analyzedTransactions} transactions`
          : '';
        setSuccess(data.message || `Imported ${holdingCount} holdings. ${summaryMsg}`);
        setTimeout(() => setSuccess(null), 8000);

        if (onHoldingsImported && holdingsList.length > 0) {
          onHoldingsImported(holdingsList);
        }

        if (onBalanceUpdated && data.balance?.current) {
          onBalanceUpdated(data.balance.current);
        }
      } else {
        setError(data.error || 'Failed to import holdings');
      }
    } catch (err: any) {
      console.error('Error importing holdings:', err);
      setError(err.message || 'Failed to import holdings');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisconnectAccount = async (accountId: string) => {
    const confirmDisconnect = window.confirm(
      'Are you sure you want to disconnect this brokerage account? ' +
      'This will remove the connection but will not delete any previously imported data.'
    );

    if (!confirmDisconnect) return;

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/stripe-connect/disconnect-brokerage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, accountId })
      });

      const data = await response.json();

      if (data.ok) {
        setSuccess('Account disconnected successfully');
        setTimeout(() => setSuccess(null), 5000);
        
        // Refresh accounts list
        await checkConnectedAccounts();
      } else {
        setError(data.error || 'Failed to disconnect account');
      }
    } catch (err: any) {
      console.error('Error disconnecting account:', err);
      setError(err.message || 'Failed to disconnect account');
    } finally {
      setIsLoading(false);
    }
  };

  const getInvestmentTypeIcon = (type: string) => {
    switch (type) {
      case 'dividend':
        return '💰';
      case 'buy':
        return '📈';
      case 'sell':
        return '📉';
      case 'interest':
        return '💵';
      case 'deposit':
        return '⬆️';
      case 'withdrawal':
        return '⬇️';
      case 'fee':
        return '💸';
      case 'reinvestment':
        return '🔄';
      default:
        return '📝';
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2
    }).format(amount);
  };

  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      {/* Header */}
      <div className={`${compact ? 'p-3.5' : 'p-4'} border-b bg-gradient-to-r from-emerald-50 to-teal-50`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`${compact ? 'w-9 h-9' : 'w-10 h-10'} rounded-full bg-emerald-100 flex items-center justify-center`}>
              <svg className={`${compact ? 'w-4.5 h-4.5' : 'w-5 h-5'} text-emerald-600`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <div>
              <h3 className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-gray-900`}>Brokerage Accounts</h3>
              <p className={`${compact ? 'text-xs' : 'text-sm'} text-gray-500`}>Connect your investment accounts to track holdings</p>
            </div>
          </div>
          {!isConnected && (
            <button
              onClick={handleConnectBrokerage}
              disabled={isLoading}
              className={`flex items-center gap-2 ${compact ? 'px-3.5 py-2 text-sm' : 'px-4 py-2'} bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium`}
            >
              {isLoading ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  <span>Connect Brokerage</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2">
          <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-700">×</button>
        </div>
      )}

      {success && (
        <div className="mx-4 mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm flex items-center gap-2">
          <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <span>{success}</span>
          <button onClick={() => setSuccess(null)} className="ml-auto text-green-500 hover:text-green-700">×</button>
        </div>
      )}

      {/* Connected Accounts */}
      {isConnected && accounts.length > 0 ? (
        <div className="p-4">
          <div className="space-y-3">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="border rounded-lg p-4 hover:border-emerald-300 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center">
                      <span className="text-lg font-bold text-emerald-700">
                        {account.institutionName?.charAt(0) || '?'}
                      </span>
                    </div>
                    <div>
                      <div className="font-semibold text-gray-900">{account.institutionName}</div>
                      <div className="text-sm text-gray-500">
                        {account.displayName || account.subcategory || 'Investment Account'} •••• {account.last4}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          account.status === 'active' 
                            ? 'bg-green-100 text-green-700'
                            : 'bg-yellow-100 text-yellow-700'
                        }`}>
                          {account.status}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {account.category || account.subcategory || 'account'}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="text-right">
                    {account.balance ? (
                      <div className="text-xl font-bold text-gray-900">
                        {formatCurrency(account.balance.current)}
                      </div>
                    ) : (
                      <button
                        onClick={() => loadAccountBalance(account.id)}
                        className="text-sm text-emerald-600 hover:text-emerald-700 font-medium"
                      >
                        Load Balance
                      </button>
                    )}
                  </div>
                </div>

                {/* Account Actions */}
                <div className="flex items-center gap-2 mt-4 pt-3 border-t">
                  <button
                    onClick={() => handleImportHoldings(account.id)}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Import Holdings
                  </button>
                  
                  <button
                    onClick={() => handleLoadTransactions(account.id)}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    View Activity
                  </button>
                  
                  <button
                    onClick={() => loadAccountBalance(account.id)}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100 text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Refresh
                  </button>
                  
                  <button
                    onClick={() => handleDisconnectAccount(account.id)}
                    disabled={isLoading}
                    className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add Another Account */}
          <button
            onClick={handleConnectBrokerage}
            disabled={isLoading}
            className="w-full mt-4 rounded-lg border-2 border-dashed border-gray-300 p-4 text-sm text-gray-600 hover:border-emerald-500 hover:text-emerald-600 font-medium transition-colors"
          >
            + Connect Another Brokerage
          </button>
        </div>
      ) : !isConnected ? (
        /* Empty State */
        <div className={`${compact ? 'p-5' : 'p-8'} text-center`}>
          <div className={`${compact ? 'w-12 h-12 mb-3' : 'w-16 h-16 mb-4'} mx-auto rounded-full bg-emerald-50 flex items-center justify-center`}>
            <svg className={`${compact ? 'w-6 h-6' : 'w-8 h-8'} text-emerald-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <h4 className={`${compact ? 'text-base mb-1.5' : 'text-lg mb-2'} font-semibold text-gray-900`}>Connect Your Brokerage</h4>
          <p className={`${compact ? 'text-sm mb-4 max-w-lg' : 'text-gray-500 mb-6 max-w-md'} text-gray-500 mx-auto`}>
            Link your investment accounts to automatically track your portfolio holdings, 
            dividends, and account balances in real-time.
          </p>
          <div className={`flex flex-wrap justify-center ${compact ? 'gap-2 mb-4' : 'gap-3 mb-6'}`}>
            {['Fidelity', 'Schwab', 'Vanguard', 'TD Ameritrade', 'E*TRADE', 'Robinhood'].map((broker) => (
              <span key={broker} className={`${compact ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm'} bg-gray-100 rounded-full text-gray-600`}>
                {broker}
              </span>
            ))}
          </div>
          <button
            onClick={handleConnectBrokerage}
            disabled={isLoading}
            className={`inline-flex items-center gap-2 ${compact ? 'px-5 py-2.5 text-sm' : 'px-6 py-3'} bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium shadow-sm`}
          >
            {isLoading ? (
              <>
                <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                <span>Connecting...</span>
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span>Securely Connect Brokerage</span>
              </>
            )}
          </button>
          <p className={`${compact ? 'mt-3' : 'mt-4'} text-xs text-gray-400`}>
            Powered by Stripe Financial Connections. Your credentials are never shared with us.
          </p>
        </div>
      ) : null}

      {/* Transactions Modal */}
      {showTransactions && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50">
              <h3 className="text-lg font-semibold text-gray-900">Investment Activity</h3>
              <button
                onClick={() => setShowTransactions(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="p-4 overflow-auto max-h-[60vh]">
              {transactions.length > 0 ? (
                <div className="space-y-2">
                  {transactions.map((txn) => (
                    <div
                      key={txn.id}
                      className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xl">{getInvestmentTypeIcon(txn.investmentType)}</span>
                        <div>
                          <div className="font-medium text-gray-900 text-sm">
                            {txn.description.substring(0, 50)}{txn.description.length > 50 ? '...' : ''}
                          </div>
                          <div className="text-xs text-gray-500">
                            {txn.date} • {txn.investmentType}
                          </div>
                        </div>
                      </div>
                      <div className={`font-semibold ${txn.type === 'credit' ? 'text-green-600' : 'text-red-600'}`}>
                        {txn.type === 'credit' ? '+' : '-'}{formatCurrency(txn.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <p>No transactions available yet.</p>
                  <p className="text-sm mt-2">Transaction data may take a few minutes to sync from your bank.</p>
                </div>
              )}
            </div>
            
            <div className="p-4 border-t bg-gray-50">
              <button
                onClick={() => setShowTransactions(false)}
                className="w-full py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Imported Data Summary */}
      {importedData && (
        <div className="p-4 border-t bg-gradient-to-r from-emerald-50 to-teal-50">
          <h4 className="font-semibold text-gray-900 mb-3">Imported Data Summary</h4>
          
          {importedData.balance && (
            <div className="mb-3 p-3 bg-white rounded-lg border">
              <div className="text-sm text-gray-500">Account Balance</div>
              <div className="text-2xl font-bold text-emerald-600">
                {formatCurrency(importedData.balance)}
              </div>
            </div>
          )}

          {/* Transaction Summary */}
          {importedData.transactionSummary && (
            <div className="mb-3 p-3 bg-white rounded-lg border">
              <div className="text-sm text-gray-500 mb-2">Transaction Analysis</div>
              <div className="flex gap-4 text-sm">
                <div className="text-center">
                  <div className="font-bold text-green-600">{importedData.transactionSummary.totalBuys}</div>
                  <div className="text-xs text-gray-500">Buys</div>
                </div>
                <div className="text-center">
                  <div className="font-bold text-red-600">{importedData.transactionSummary.totalSells}</div>
                  <div className="text-xs text-gray-500">Sells</div>
                </div>
                <div className="text-center">
                  <div className="font-bold text-blue-600">{importedData.transactionSummary.totalDividends}</div>
                  <div className="text-xs text-gray-500">Dividends</div>
                </div>
              </div>
            </div>
          )}
          
          {importedData.holdings.length > 0 && (
            <div className="mb-3">
              <div className="text-sm text-gray-500 mb-2">Holdings from Transactions</div>
              <div className="space-y-2">
                {importedData.holdings.map((holding, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-white border rounded-lg flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-bold text-gray-800 bg-gray-100 px-2 py-1 rounded">
                        {holding.ticker}
                      </span>
                      <div className="text-sm">
                        {holding.shares ? (
                          <div className="font-medium text-gray-700">
                            {holding.shares.toLocaleString()} shares
                          </div>
                        ) : (
                          <div className="text-gray-400 text-xs">Shares unknown</div>
                        )}
                        {holding.avgCostBasis && (
                          <div className="text-xs text-gray-500">
                            Avg cost: ${holding.avgCostBasis.toFixed(2)}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${
                        holding.source === 'transaction_parsed' 
                          ? 'bg-green-100 text-green-700' 
                          : holding.source === 'price_estimation'
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {holding.source === 'transaction_parsed' ? 'Parsed' : 
                         holding.source === 'price_estimation' ? 'Price Est.' : 'Div. Inferred'}
                      </span>
                      {holding.confidence && (
                        <div className={`inline-block ml-2 px-2 py-0.5 rounded-full text-xs ${
                          holding.confidence === 'high' ? 'bg-emerald-100 text-emerald-700' :
                          holding.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {holding.confidence}
                        </div>
                      )}
                      {holding.totalDividends && (
                        <div className="text-green-600 text-xs mt-1">
                          +${holding.totalDividends.toFixed(2)} divs
                        </div>
                      )}
                      {holding.inferenceNotes && (
                        <div className="text-xs text-gray-400 mt-1 max-w-xs line-clamp-2">
                          {Array.isArray(holding.inferenceNotes) ? holding.inferenceNotes[0] : holding.inferenceNotes}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {importedData.dividends.length > 0 && (
            <div>
              <div className="text-sm text-gray-500 mb-2">Recent Dividends</div>
              <div className="space-y-1">
                {importedData.dividends.slice(0, 5).map((div, idx) => (
                  <div key={idx} className="flex justify-between text-sm bg-white p-2 rounded border">
                    <span className="text-gray-600">
                      {div.ticker ? <strong>{div.ticker}</strong> : ''} {div.date}
                    </span>
                    <span className="font-medium text-green-600">+${div.amount.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reconciliation */}
          {importedData.reconciliation && (
            <div className="mt-3 p-3 bg-white rounded-lg border">
              <div className="text-sm text-gray-500 mb-1">Reconciliation</div>
              <div className="flex items-center justify-between text-sm">
                <div>
                  <div className="text-gray-600">Estimated Holdings Value</div>
                  <div className="font-medium">{formatCurrency(importedData.reconciliation.totalHoldingsValue)}</div>
                </div>
                <div>
                  <div className="text-gray-600">Account Balance</div>
                  <div className="font-medium">{formatCurrency(importedData.reconciliation.balanceCurrent)}</div>
                </div>
                <div>
                  <div className="text-gray-600">Discrepancy</div>
                  <div className={`font-bold ${importedData.reconciliation.discrepancy >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatCurrency(importedData.reconciliation.discrepancy)}
                  </div>
                </div>
              </div>
              {importedData.reconciliation.asOf && (
                <div className="text-xs text-gray-400 mt-1">As of {new Date(importedData.reconciliation.asOf).toLocaleString()}</div>
              )}
            </div>
          )}
          
          <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-800">
              <strong>📊 How it works:</strong> We analyze buy/sell history and, when needed, infer shares from dividend payments matched to public dividend data. 
              Confidence levels indicate estimation strength; you can review and adjust if needed.
            </p>
          </div>
        </div>
      )}

      {/* Info Box */}
      <div className="p-4 border-t bg-gray-50">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="text-sm text-gray-600">
            <p className="font-medium text-gray-700 mb-1">Secure Connection</p>
            <p>
              Your brokerage login credentials are never shared with HouseYield. 
              We use Stripe's bank-grade security to access read-only account information.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
