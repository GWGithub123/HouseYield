/**
 * CheckingAccountConnect - Connect checking/savings accounts via Stripe Financial Connections
 * Fetches transaction history and uses Gemini AI to categorize expenses
 * Feeds into Financial Independence projection for real expense data
 */

import { useState, useEffect } from 'react';

export interface CheckingAccount {
  id: string;
  institutionName: string;
  displayName: string;
  last4: string;
  status: string;
  category: string;
  subcategory: string;
  balance?: {
    current: number;
    available: number;
    asOf?: number;
  } | null;
}

export interface ExpenseCategory {
  category: string;
  totalAmount: number;
  monthlyAverage: number;
  transactionCount: number;
  percentage: number;
  color?: string;
}

export interface IncomeCategory {
  category: string;
  totalAmount: number;
  monthlyAverage: number;
  transactionCount: number;
  percentage: number;
}

export interface CategorizedTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  type: string;
  aiCategory: string;
  isTransfer: boolean;
}

export interface ExpenseData {
  summary: {
    totalTransactions: number;
    categorizedTransactions: number;
    excludedTransfers: number;
    monthsCovered: number;
    monthlyExpenseTotal: number;
    monthlyIncomeTotal: number;
    annualExpenseTotal: number;
    annualIncomeTotal: number;
  };
  periodSummaries?: {
    thisMonth: {
      monthKey: string;
      label: string;
      expenseTotal: number;
      incomeTotal: number;
      transactionCount: number;
    };
    lastMonth: {
      monthKey: string;
      label: string;
      expenseTotal: number;
      incomeTotal: number;
      transactionCount: number;
    };
  } | null;
  expenseCategories: ExpenseCategory[];
  incomeCategories: IncomeCategory[];
  categorizedTransactions?: CategorizedTransaction[];
}

// Expense category colors (matching the dark theme from the design)
const CATEGORY_COLORS: { [key: string]: string } = {
  'Housing': '#6366f1',      // Indigo
  'Utilities': '#8b5cf6',    // Purple
  'Groceries': '#06b6d4',    // Cyan
  'Dining': '#f59e0b',       // Amber
  'Transportation': '#ef4444', // Red
  'Healthcare': '#ec4899',   // Pink
  'Entertainment': '#f97316', // Orange
  'Shopping': '#14b8a6',     // Teal
  'Insurance': '#6d28d9',    // Violet
  'Education': '#2563eb',    // Blue
  'Personal Care': '#d946ef', // Fuchsia
  'Subscriptions': '#0ea5e9', // Sky
  'Childcare': '#a855f7',    // Purple-500
  'Pet': '#84cc16',          // Lime
  'Travel': '#10b981',       // Emerald
  'Gifts & Donations': '#e11d48', // Rose
  'Miscellaneous': '#64748b', // Slate
};

function getCategoryColor(category: string, index: number): string {
  if (CATEGORY_COLORS[category]) return CATEGORY_COLORS[category];
  const fallback = ['#6366f1', '#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#ec4899', '#f97316', '#14b8a6', '#0ea5e9', '#84cc16'];
  return fallback[index % fallback.length];
}

// Category icons
function getCategoryIcon(category: string): string {
  const icons: { [key: string]: string } = {
    'Housing': '🏠', 'Utilities': '💡', 'Groceries': '🛒', 'Dining': '🍽️',
    'Transportation': '🚗', 'Healthcare': '🏥', 'Entertainment': '🎬',
    'Shopping': '🛍️', 'Insurance': '🛡️', 'Education': '📚',
    'Personal Care': '💆', 'Subscriptions': '📱', 'Childcare': '👶',
    'Pet': '🐾', 'Travel': '✈️', 'Gifts & Donations': '🎁', 'Miscellaneous': '📦',
  };
  return icons[category] || '📊';
}

interface CheckingAccountConnectProps {
  userId: string;
  userEmail?: string;
  onExpenseDataLoaded?: (data: ExpenseData) => void;
  onAccountConnected?: (accounts: CheckingAccount[]) => void;
}

export default function CheckingAccountConnect({
  userId,
  userEmail,
  onExpenseDataLoaded,
  onAccountConnected,
}: CheckingAccountConnectProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isCategorizing, setIsCategorizing] = useState(false);
  const [disconnectingAccountId, setDisconnectingAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<CheckingAccount[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [expenseData, setExpenseData] = useState<ExpenseData | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  useEffect(() => {
    checkConnectedAccounts();
    loadSavedExpenseData();
  }, [userId]);

  // Load previously saved expense data from Firestore
  const loadSavedExpenseData = async () => {
    if (!userId) return;
    try {
      const response = await fetch(`/api/stripe-connect/expense-data/${userId}`);
      const data = await response.json();

      if (data.ok && data.summary) {
        // Add colors to categories
        const coloredExpenses = (data.expenseCategories || []).map((cat: ExpenseCategory, i: number) => ({
          ...cat,
          color: getCategoryColor(cat.category, i),
        }));

        const result: ExpenseData = {
          summary: data.summary,
          periodSummaries: data.periodSummaries || null,
          expenseCategories: coloredExpenses,
          incomeCategories: data.incomeCategories || [],
          categorizedTransactions: data.categorizedTransactions || [],
        };

        setExpenseData(result);
        if (onExpenseDataLoaded) onExpenseDataLoaded(result);
        console.log('[CheckingAccountConnect] ✅ Loaded saved expense data from Firestore');
      }
    } catch (err) {
      // Silently fail — user can re-categorize manually
      console.log('[CheckingAccountConnect] No saved expense data found');
    }
  };

  const checkConnectedAccounts = async () => {
    try {
      const response = await fetch(`/api/stripe-connect/checking-accounts/${userId}`);
      const data = await response.json();

      if (data.ok && data.accounts && data.accounts.length > 0) {
        setAccounts(data.accounts);
        setIsConnected(true);
        if (onAccountConnected) onAccountConnected(data.accounts);
        setSelectedAccountId((currentSelectedId) => {
          const stillExists = currentSelectedId && data.accounts.some((account: CheckingAccount) => account.id === currentSelectedId);
          return stillExists ? currentSelectedId : data.accounts[0].id;
        });
      } else {
        setAccounts([]);
        setIsConnected(false);
        setSelectedAccountId(null);
      }
    } catch (err) {
      console.error('Error checking accounts:', err);
    }
  };

  const handleDisconnectAccount = async (accountId: string) => {
    const confirmed = window.confirm(
      'Are you sure you want to disconnect this checking account? This removes the Stripe connection but does not delete your previously saved expense analysis.'
    );

    if (!confirmed) return;

    try {
      setDisconnectingAccountId(accountId);
      setError(null);

      let response = await fetch('/api/stripe-connect/disconnect-checking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, accountId }),
      });

      if (response.status === 404) {
        response = await fetch('/api/stripe-connect/disconnect-brokerage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, accountId }),
        });
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.error || 'Failed to disconnect account');
      }

      await checkConnectedAccounts();
    } catch (err: any) {
      console.error('Error disconnecting account:', err);
      setError(err.message || 'Failed to disconnect account');
    } finally {
      setDisconnectingAccountId(null);
    }
  };

  const handleConnect = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/stripe-connect/create-checking-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, userEmail, accountLabel: 'Primary Checking' }),
      });

      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Failed to create session');

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
        clientSecret: data.clientSecret,
      });

      if (fcError) {
        throw new Error(fcError.message);
      }

      if (financialConnectionsSession) {
        // Reload accounts
        await checkConnectedAccounts();
      }
      setIsLoading(false);
    } catch (err: any) {
      setError(err.message);
      setIsLoading(false);
    }
  };

  const handleFetchAndCategorize = async (accountId: string) => {
    try {
      setIsCategorizing(true);
      setError(null);
      setSelectedAccountId(accountId);

      // Fetch past year of transactions
      const txnResponse = await fetch(`/api/stripe-connect/checking-transactions/${accountId}?months=12`);
      const txnData = await txnResponse.json();

      if (!txnData.ok) throw new Error(txnData.error || 'Failed to fetch transactions');

      if (txnData.transactions.length === 0) {
        setError('No transactions found for this account in the past year.');
        setIsCategorizing(false);
        return;
      }

      // Send to Gemini for categorization (include userId to save to Firestore)
      const catResponse = await fetch('/api/stripe-connect/categorize-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: txnData.transactions, userId }),
      });

      const catData = await catResponse.json();
      if (!catData.ok) throw new Error(catData.error || 'Failed to categorize');

      // Add colors to categories
      const coloredExpenses = catData.expenseCategories.map((cat: ExpenseCategory, i: number) => ({
        ...cat,
        color: getCategoryColor(cat.category, i),
      }));

      const result: ExpenseData = {
        summary: catData.summary,
        periodSummaries: catData.periodSummaries || null,
        expenseCategories: coloredExpenses,
        incomeCategories: catData.incomeCategories,
        categorizedTransactions: catData.categorizedTransactions || [],
      };

      setExpenseData(result);
      if (onExpenseDataLoaded) onExpenseDataLoaded(result);
      setIsCategorizing(false);
    } catch (err: any) {
      setError(err.message);
      setIsCategorizing(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M2 10h20" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Primary Checking</h3>
            <p className="text-xs text-gray-500">Connect for expense tracking</p>
          </div>
        </div>
        {isConnected && (
          <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">
            Connected
          </span>
        )}
      </div>

      {/* Connected Accounts */}
      {isConnected && accounts.length > 0 && (
        <div className="space-y-2">
          {accounts.map(account => (
            <div
              key={account.id}
              className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-colors ${
                selectedAccountId === account.id
                  ? 'border-blue-300 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
              onClick={() => setSelectedAccountId(account.id)}
            >
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-600">
                  {account.institutionName?.[0] || '?'}
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-800">
                    {account.institutionName} ••{account.last4}
                  </div>
                  <div className="text-xs text-gray-500 capitalize">{account.subcategory}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {account.balance && (
                  <div className="text-sm font-semibold text-gray-900">
                    ${account.balance.current?.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDisconnectAccount(account.id);
                  }}
                  disabled={disconnectingAccountId === account.id}
                  className="px-2.5 py-1 rounded-md border border-red-200 text-red-600 text-xs font-medium hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {disconnectingAccountId === account.id ? 'Removing...' : 'Delete'}
                </button>
              </div>
            </div>
          ))}

          {/* Analyze button */}
          <button
            onClick={() => selectedAccountId && handleFetchAndCategorize(selectedAccountId)}
            disabled={isCategorizing || !selectedAccountId}
            className="w-full py-2 px-3 rounded-lg text-sm font-medium bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
          >
            {isCategorizing ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Analyzing transactions...
              </>
            ) : expenseData ? (
              <>🔄 Re-analyze Expenses</>
            ) : (
              <>✨ Categorize with AI</>
            )}
          </button>
        </div>
      )}

      {/* Connect Button */}
      {!isConnected && (
        <button
          onClick={handleConnect}
          disabled={isLoading}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium border-2 border-dashed border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              Connecting...
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Connect Bank Account
            </>
          )}
        </button>
      )}

      {/* Add another account */}
      {isConnected && (
        <button
          onClick={handleConnect}
          disabled={isLoading}
          className="w-full py-1.5 px-3 rounded-lg text-xs font-medium text-gray-500 hover:text-blue-600 hover:bg-blue-50 transition-all flex items-center justify-center gap-1"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Connect another account
        </button>
      )}

      {/* Error */}
      {error && (
        <div className="p-2 rounded-lg bg-red-50 text-red-700 text-xs">
          {error}
        </div>
      )}
    </div>
  );
}

export { getCategoryColor, getCategoryIcon, CATEGORY_COLORS };
