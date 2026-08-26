/**
 * useFirestoreBookkeeping Hook
 *
 * React hook for the owner bookkeeping workspace.
 * Raw compatibility-route access is centralized in the canonical bookkeeping client.
 */

import { useState, useEffect, useCallback } from 'react';
import { auth } from '../config/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { bookkeepingClient } from '../services/canonicalBookkeepingClient';

// Types
export interface Transaction {
  id: string;
  date: string;
  description: string;
  category: string;
  amount: number;
  type: 'income' | 'expense';
  propertyId?: string;
  source?: string;
  sourceRef?: string | null;
  financeEventType?: string | null;
  vendor?: string | null;
  accountCode?: string | null;
  scheduleELine?: number | null;
  taxMap?: string | null;
}

export interface BookkeepingSummary {
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  cashBalance: number;
  incomeByCategory: { category: string; amount: number }[];
  expensesByCategory: { category: string; amount: number }[];
}

export interface CashflowTrend {
  month: string;
  year?: number;
  income: number;
  expenses: number;
  net: number;
}

export function getDefaultBookkeepingDateRange() {
  return {
    startDate: new Date(new Date().getFullYear() - 1, 0, 1).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
  };
}

export interface Account {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  balance: number;
}

interface UseFirestoreBookkeepingResult {
  // State
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  user: User | null;
  
  // Data
  transactions: Transaction[];
  summary: BookkeepingSummary | null;
  accounts: Account[];
  cashflowTrend: CashflowTrend[];
  
  // Actions
  initialize: () => Promise<void>;
  fetchData: (options?: { startDate?: string; endDate?: string; propertyId?: string }) => Promise<void>;
  addTransaction: (txn: {
    date: string;
    description: string;
    amount: number;
    type: 'income' | 'expense';
    categoryCode?: string;
    propertyId?: string;
  }) => Promise<boolean>;
  
  // QuickBooks
  previewQBOSync: (month: string, propertyCode?: string) => Promise<any>;
  pushToQBO: (month: string, propertyCode?: string) => Promise<any>;
  importFromQBO: (transactions: any[]) => Promise<{ imported: number; skipped: number }>;
}

export function useFirestoreBookkeeping(): UseFirestoreBookkeepingResult {
  const [user, setUser] = useState<User | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<BookkeepingSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cashflowTrend, setCashflowTrend] = useState<CashflowTrend[]>([]);

  // Listen to auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      if (!firebaseUser) {
        // Clear data on logout
        setIsInitialized(false);
        setTransactions([]);
        setSummary(null);
        setAccounts([]);
        setCashflowTrend([]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Check initialization status when user changes
  useEffect(() => {
    if (user) {
      checkInitialization();
    }
  }, [user]);

  const checkInitialization = async () => {
    try {
      const data = await bookkeepingClient.getStatus();
      setIsInitialized(data.initialized === true);
    } catch (err) {
      console.error('[Bookkeeping] Error checking status:', err);
    }
  };

  const initialize = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await bookkeepingClient.initialize();
      
      if (data.ok) {
        setIsInitialized(true);
        console.log('[Bookkeeping] Initialized successfully');
      } else {
        setError(data.error || 'Failed to initialize');
      }
    } catch (err: any) {
      console.error('[Bookkeeping] Initialize error:', err);
      setError(err.message || 'Failed to initialize bookkeeping');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchData = useCallback(async (options: { startDate?: string; endDate?: string; propertyId?: string } = {}) => {
    setIsLoading(true);
    setError(null);

    try {
      const {
        transactions: txnData,
        summary: summaryData,
        accounts: accountsData,
        trend: trendData,
      } = await bookkeepingClient.getDashboard(options);

      const dashboardFailure = [txnData, summaryData, accountsData, trendData].find((response) => (
        response?._httpOk === false || response?.ok === false
      ));

      if (txnData.ok) setTransactions(txnData.transactions || []);
      if (summaryData.ok) setSummary(summaryData.summary);
      if (accountsData.ok) setAccounts(accountsData.accounts || []);
      if (trendData.ok) setCashflowTrend(trendData.trend || []);

      if (dashboardFailure) {
        setError(
          dashboardFailure.error
          || (dashboardFailure._httpStatus ? `Canonical bookkeeping request failed (${dashboardFailure._httpStatus}).` : 'Failed to load bookkeeping data.')
        );
      }

      console.log('[Bookkeeping] Data loaded successfully');
    } catch (err: any) {
      console.error('[Bookkeeping] Fetch error:', err);
      setError(err.message || 'Failed to load bookkeeping data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addTransaction = useCallback(async (txn: {
    date: string;
    description: string;
    amount: number;
    type: 'income' | 'expense';
    categoryCode?: string;
    propertyId?: string;
  }): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await bookkeepingClient.createTransaction(txn);

      if (data.ok) {
        // Refresh data after adding
        await fetchData();
        return true;
      } else {
        setError(data.error || 'Failed to add transaction');
        return false;
      }
    } catch (err: any) {
      console.error('[Bookkeeping] Add transaction error:', err);
      setError(err.message || 'Failed to add transaction');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [fetchData]);

  // QuickBooks sync functions
  const previewQBOSync = useCallback(async (month: string, propertyCode?: string) => {
    return bookkeepingClient.previewQuickBooksSync(month, propertyCode);
  }, []);

  const pushToQBO = useCallback(async (month: string, propertyCode?: string) => {
    return bookkeepingClient.pushQuickBooksSync(month, propertyCode);
  }, []);

  const importFromQBO = useCallback(async (qboTransactions: any[]): Promise<{ imported: number; skipped: number }> => {
    const data = await bookkeepingClient.importQuickBooksTransactions(qboTransactions);
    
    if (data.ok) {
      // Refresh data after import
      await fetchData();
      return { imported: data.imported, skipped: data.skipped };
    }
    
    throw new Error(data.error || 'Import failed');
  }, [fetchData]);

  return {
    // State
    isInitialized,
    isLoading,
    error,
    user,
    
    // Data
    transactions,
    summary,
    accounts,
    cashflowTrend,
    
    // Actions
    initialize,
    fetchData,
    addTransaction,
    
    // QuickBooks
    previewQBOSync,
    pushToQBO,
    importFromQBO
  };
}

export default useFirestoreBookkeeping;
