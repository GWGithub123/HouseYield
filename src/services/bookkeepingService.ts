/**
 * Firestore Bookkeeping Service
 * 
 * Production-ready bookkeeping system stored in Firestore under each user's profile.
 * Supports journal entries, accounts, and QuickBooks sync.
 * 
 * Firestore Structure:
 * users/{userId}/
 *   ├── bookkeeping/
 *   │     ├── accounts/{accountId} - Chart of accounts
 *   │     ├── journalEntries/{entryId} - Journal entries with embedded lines
 *   │     ├── categories/{categoryId} - Transaction categories
 *   │     └── config/settings - Bookkeeping settings & QBO config
 *   └── properties/{propertyId} - User's properties (linked to journal lines)
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  deleteDoc,
  writeBatch,
  runTransaction,
  DocumentReference,
  QueryConstraint,
  increment
} from 'firebase/firestore';
import { db } from '../config/firebase';

// ============================================================================
// Types
// ============================================================================

export interface Account {
  id?: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  subtype?: string;
  description?: string;
  isActive: boolean;
  balance: number;
  qboAccountId?: string; // QuickBooks account mapping
  createdAt: string;
  updatedAt: string;
}

export interface JournalLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  propertyId?: string;
  tenantId?: string;
  amount: number;
  dc: 'D' | 'C'; // Debit or Credit
  memo?: string;
}

export interface JournalEntry {
  id?: string;
  entryDate: string; // YYYY-MM-DD format
  memo: string;
  source: 'MANUAL' | 'BANK' | 'QBO_IMPORT' | 'STRIPE' | 'RECURRING';
  sourceRef?: string; // External reference (bank txn id, QBO id, etc.)
  lines: JournalLine[];
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
  postedBy: string;
  createdAt: string;
  updatedAt: string;
  // Metadata
  categoryId?: string;
  tags?: string[];
}

export interface TransactionCategory {
  id?: string;
  name: string;
  type: 'income' | 'expense';
  color: string;
  icon?: string;
  defaultAccountCode?: string;
  isActive: boolean;
}

export interface BookkeepingConfig {
  fiscalYearStart: number; // Month (1-12)
  defaultCurrency: string;
  closedPeriods: string[]; // Array of YYYY-MM periods
  qboRealmId?: string;
  qboConnected: boolean;
  lastSyncDate?: string;
}

export interface BookkeepingSummary {
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  incomeByCategory: { category: string; amount: number }[];
  expensesByCategory: { category: string; amount: number }[];
  cashBalance: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getUserBookkeepingRef(userId: string) {
  return collection(db, 'users', userId, 'bookkeeping');
}

function getAccountsRef(userId: string) {
  return collection(db, 'users', userId, 'bookkeeping', 'data', 'accounts');
}

function getJournalEntriesRef(userId: string) {
  return collection(db, 'users', userId, 'bookkeeping', 'data', 'journalEntries');
}

function getCategoriesRef(userId: string) {
  return collection(db, 'users', userId, 'bookkeeping', 'data', 'categories');
}

function getConfigRef(userId: string) {
  return doc(db, 'users', userId, 'bookkeeping', 'config');
}

// ============================================================================
// Account Functions
// ============================================================================

/**
 * Initialize default chart of accounts for a new user
 */
export async function initializeChartOfAccounts(userId: string): Promise<void> {
  const defaultAccounts: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>[] = [
    // Assets
    { code: '1000', name: 'Operating Cash', type: 'ASSET', subtype: 'Bank', isActive: true, balance: 0 },
    { code: '1010', name: 'Security Deposits Held', type: 'ASSET', subtype: 'Bank', isActive: true, balance: 0 },
    { code: '1100', name: 'Accounts Receivable', type: 'ASSET', subtype: 'Receivable', isActive: true, balance: 0 },
    { code: '1200', name: 'Prepaid Insurance', type: 'ASSET', subtype: 'OtherCurrentAsset', isActive: true, balance: 0 },
    { code: '1500', name: 'Buildings & Improvements', type: 'ASSET', subtype: 'FixedAsset', isActive: true, balance: 0 },
    { code: '1510', name: 'Accumulated Depreciation', type: 'ASSET', subtype: 'FixedAsset', isActive: true, balance: 0 },
    
    // Liabilities
    { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', subtype: 'AccountsPayable', isActive: true, balance: 0 },
    { code: '2100', name: 'Security Deposits Liability', type: 'LIABILITY', subtype: 'OtherCurrentLiability', isActive: true, balance: 0 },
    { code: '2200', name: 'Prepaid Rent', type: 'LIABILITY', subtype: 'OtherCurrentLiability', isActive: true, balance: 0 },
    { code: '2500', name: 'Mortgage Payable', type: 'LIABILITY', subtype: 'LongTermLiability', isActive: true, balance: 0 },
    
    // Equity
    { code: '3000', name: 'Owner\'s Equity', type: 'EQUITY', subtype: 'Equity', isActive: true, balance: 0 },
    { code: '3100', name: 'Retained Earnings', type: 'EQUITY', subtype: 'RetainedEarnings', isActive: true, balance: 0 },
    
    // Revenue
    { code: '4000', name: 'Rental Income', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
    { code: '4100', name: 'Late Fees', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
    { code: '4200', name: 'Application Fees', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
    { code: '4300', name: 'Pet Fees', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
    { code: '4900', name: 'Other Income', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
    
    // Expenses
    { code: '5000', name: 'Repairs & Maintenance', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5100', name: 'Utilities', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5200', name: 'Insurance', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5300', name: 'Property Tax', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5400', name: 'Property Management', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5500', name: 'Mortgage Interest', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5600', name: 'HOA Fees', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5700', name: 'Landscaping', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5800', name: 'Cleaning', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5900', name: 'Legal & Professional', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '5999', name: 'Other Expenses', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '6000', name: 'Advertising', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
    { code: '6100', name: 'Depreciation Expense', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  ];

  const batch = writeBatch(db);
  const accountsRef = getAccountsRef(userId);
  const now = new Date().toISOString();

  for (const account of defaultAccounts) {
    const docRef = doc(accountsRef, account.code);
    batch.set(docRef, {
      ...account,
      createdAt: now,
      updatedAt: now
    });
  }

  // Initialize config
  const configRef = getConfigRef(userId);
  batch.set(configRef, {
    fiscalYearStart: 1,
    defaultCurrency: 'USD',
    closedPeriods: [],
    qboConnected: false
  } as BookkeepingConfig);

  await batch.commit();
}

/**
 * Get all accounts for a user
 */
export async function getAccounts(userId: string): Promise<Account[]> {
  const accountsRef = getAccountsRef(userId);
  const q = query(accountsRef, where('isActive', '==', true), orderBy('code'));
  const snapshot = await getDocs(q);
  
  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  } as Account));
}

/**
 * Get account by code
 */
export async function getAccountByCode(userId: string, code: string): Promise<Account | null> {
  const accountRef = doc(getAccountsRef(userId), code);
  const snapshot = await getDoc(accountRef);
  
  if (!snapshot.exists()) return null;
  
  return {
    id: snapshot.id,
    ...snapshot.data()
  } as Account;
}

/**
 * Create or update an account
 */
export async function upsertAccount(userId: string, account: Partial<Account> & { code: string }): Promise<void> {
  const accountRef = doc(getAccountsRef(userId), account.code);
  const now = new Date().toISOString();
  
  const existing = await getDoc(accountRef);
  
  if (existing.exists()) {
    await updateDoc(accountRef, {
      ...account,
      updatedAt: now
    });
  } else {
    await setDoc(accountRef, {
      ...account,
      balance: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now
    });
  }
}

// ============================================================================
// Journal Entry Functions
// ============================================================================

/**
 * Create a journal entry with validation
 */
export async function createJournalEntry(
  userId: string,
  entry: Omit<JournalEntry, 'id' | 'createdAt' | 'updatedAt' | 'totalDebits' | 'totalCredits' | 'isBalanced'>
): Promise<JournalEntry> {
  // Calculate totals
  const totalDebits = entry.lines
    .filter(l => l.dc === 'D')
    .reduce((sum, l) => sum + l.amount, 0);
  const totalCredits = entry.lines
    .filter(l => l.dc === 'C')
    .reduce((sum, l) => sum + l.amount, 0);
  
  // Validate balance (allow 1 cent variance for rounding)
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;
  
  if (!isBalanced) {
    throw new Error(`Journal entry not balanced! Debits: ${totalDebits.toFixed(2)}, Credits: ${totalCredits.toFixed(2)}`);
  }

  const now = new Date().toISOString();
  const journalEntry: Omit<JournalEntry, 'id'> = {
    ...entry,
    totalDebits: Math.round(totalDebits * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
    isBalanced,
    createdAt: now,
    updatedAt: now
  };

  // Use a transaction to update account balances atomically
  const entriesRef = getJournalEntriesRef(userId);
  const entryDocRef = doc(entriesRef);
  
  await runTransaction(db, async (transaction) => {
    // Create the journal entry
    transaction.set(entryDocRef, journalEntry);
    
    // Update account balances
    for (const line of entry.lines) {
      const accountRef = doc(getAccountsRef(userId), line.accountCode);
      const accountSnap = await transaction.get(accountRef);
      
      if (accountSnap.exists()) {
        const account = accountSnap.data() as Account;
        let balanceChange = line.amount;
        
        // For liability/equity/revenue: Credit increases, Debit decreases
        // For asset/expense: Debit increases, Credit decreases
        if (['LIABILITY', 'EQUITY', 'REVENUE'].includes(account.type)) {
          balanceChange = line.dc === 'C' ? line.amount : -line.amount;
        } else {
          balanceChange = line.dc === 'D' ? line.amount : -line.amount;
        }
        
        transaction.update(accountRef, {
          balance: increment(balanceChange),
          updatedAt: now
        });
      }
    }
  });

  return {
    id: entryDocRef.id,
    ...journalEntry
  };
}

/**
 * Get journal entries with optional filters
 */
export async function getJournalEntries(
  userId: string,
  options: {
    startDate?: string;
    endDate?: string;
    propertyId?: string;
    source?: string;
    limitCount?: number;
  } = {}
): Promise<JournalEntry[]> {
  const entriesRef = getJournalEntriesRef(userId);
  const constraints: QueryConstraint[] = [];
  
  if (options.startDate) {
    constraints.push(where('entryDate', '>=', options.startDate));
  }
  if (options.endDate) {
    constraints.push(where('entryDate', '<=', options.endDate));
  }
  if (options.source) {
    constraints.push(where('source', '==', options.source));
  }
  
  constraints.push(orderBy('entryDate', 'desc'));
  
  if (options.limitCount) {
    constraints.push(limit(options.limitCount));
  }
  
  const q = query(entriesRef, ...constraints);
  const snapshot = await getDocs(q);
  
  let entries = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  } as JournalEntry));
  
  // Filter by propertyId client-side (since lines is an array)
  if (options.propertyId) {
    entries = entries.filter(entry => 
      entry.lines.some(line => line.propertyId === options.propertyId)
    );
  }
  
  return entries;
}

/**
 * Get a single journal entry by ID
 */
export async function getJournalEntry(userId: string, entryId: string): Promise<JournalEntry | null> {
  const entryRef = doc(getJournalEntriesRef(userId), entryId);
  const snapshot = await getDoc(entryRef);
  
  if (!snapshot.exists()) return null;
  
  return {
    id: snapshot.id,
    ...snapshot.data()
  } as JournalEntry;
}

/**
 * Reverse a journal entry (creates a new entry with opposite D/C)
 */
export async function reverseJournalEntry(
  userId: string,
  entryId: string,
  reversalDate: string,
  postedBy: string
): Promise<JournalEntry> {
  const original = await getJournalEntry(userId, entryId);
  
  if (!original) {
    throw new Error(`Journal entry not found: ${entryId}`);
  }
  
  // Flip debits and credits
  const reversalLines: JournalLine[] = original.lines.map(line => ({
    ...line,
    dc: line.dc === 'D' ? 'C' : 'D',
    memo: `Reversal: ${line.memo || ''}`
  }));
  
  return createJournalEntry(userId, {
    entryDate: reversalDate,
    memo: `Reversal of: ${original.memo}`,
    source: 'MANUAL',
    sourceRef: `REV-${entryId}`,
    lines: reversalLines,
    postedBy
  });
}

// ============================================================================
// Reporting Functions
// ============================================================================

/**
 * Get bookkeeping summary for a date range
 */
export async function getBookkeepingSummary(
  userId: string,
  startDate: string,
  endDate: string
): Promise<BookkeepingSummary> {
  const entries = await getJournalEntries(userId, { startDate, endDate });
  const accounts = await getAccounts(userId);
  
  // Create account lookup
  const accountMap = new Map(accounts.map(a => [a.code, a]));
  
  let totalIncome = 0;
  let totalExpenses = 0;
  const incomeByCategory: Map<string, number> = new Map();
  const expensesByCategory: Map<string, number> = new Map();
  
  for (const entry of entries) {
    for (const line of entry.lines) {
      const account = accountMap.get(line.accountCode);
      if (!account) continue;
      
      if (account.type === 'REVENUE') {
        // Revenue increases with credit
        const amount = line.dc === 'C' ? line.amount : -line.amount;
        totalIncome += amount;
        
        const current = incomeByCategory.get(account.name) || 0;
        incomeByCategory.set(account.name, current + amount);
      } else if (account.type === 'EXPENSE') {
        // Expense increases with debit
        const amount = line.dc === 'D' ? line.amount : -line.amount;
        totalExpenses += amount;
        
        const current = expensesByCategory.get(account.name) || 0;
        expensesByCategory.set(account.name, current + amount);
      }
    }
  }
  
  // Get cash balance from operating cash account
  const cashAccount = accounts.find(a => a.code === '1000');
  const cashBalance = cashAccount?.balance || 0;
  
  return {
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    netIncome: Math.round((totalIncome - totalExpenses) * 100) / 100,
    incomeByCategory: Array.from(incomeByCategory.entries())
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
      .filter(c => c.amount !== 0)
      .sort((a, b) => b.amount - a.amount),
    expensesByCategory: Array.from(expensesByCategory.entries())
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
      .filter(c => c.amount !== 0)
      .sort((a, b) => b.amount - a.amount),
    cashBalance
  };
}

/**
 * Get transactions in a flat format (for UI display)
 */
export async function getTransactionsFlat(
  userId: string,
  options: {
    startDate?: string;
    endDate?: string;
    limitCount?: number;
    type?: 'income' | 'expense' | 'all';
  } = {}
): Promise<{
  id: string;
  date: string;
  description: string;
  category: string;
  amount: number;
  type: 'income' | 'expense';
  propertyId?: string;
}[]> {
  const entries = await getJournalEntries(userId, {
    startDate: options.startDate,
    endDate: options.endDate,
    limitCount: options.limitCount
  });
  
  const accounts = await getAccounts(userId);
  const accountMap = new Map(accounts.map(a => [a.code, a]));
  
  const transactions: {
    id: string;
    date: string;
    description: string;
    category: string;
    amount: number;
    type: 'income' | 'expense';
    propertyId?: string;
  }[] = [];
  
  for (const entry of entries) {
    // Find the main income/expense line
    for (const line of entry.lines) {
      const account = accountMap.get(line.accountCode);
      if (!account) continue;
      
      if (account.type === 'REVENUE') {
        const amount = line.dc === 'C' ? line.amount : -line.amount;
        if ((options.type === 'all' || options.type === 'income' || !options.type) && amount !== 0) {
          transactions.push({
            id: entry.id!,
            date: entry.entryDate,
            description: entry.memo,
            category: account.name,
            amount,
            type: 'income',
            propertyId: line.propertyId
          });
        }
      } else if (account.type === 'EXPENSE') {
        const amount = line.dc === 'D' ? line.amount : -line.amount;
        if ((options.type === 'all' || options.type === 'expense' || !options.type) && amount !== 0) {
          transactions.push({
            id: entry.id!,
            date: entry.entryDate,
            description: entry.memo,
            category: account.name,
            amount,
            type: 'expense',
            propertyId: line.propertyId
          });
        }
      }
    }
  }
  
  // Sort by date descending
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  
  return transactions;
}

/**
 * Get monthly totals for QuickBooks export
 */
export async function getMonthlyTotals(
  userId: string,
  month: string // YYYY-MM format
): Promise<{
  revenue: { accountCode: string; accountName: string; amount: number; propertyId?: string }[];
  expenses: { accountCode: string; accountName: string; amount: number; propertyId?: string }[];
}> {
  const startDate = `${month}-01`;
  const endDate = new Date(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]), 0)
    .toISOString().split('T')[0];
  
  const entries = await getJournalEntries(userId, { startDate, endDate });
  const accounts = await getAccounts(userId);
  const accountMap = new Map(accounts.map(a => [a.code, a]));
  
  // Aggregate by account
  const revenueTotals: Map<string, { accountCode: string; accountName: string; amount: number; propertyId?: string }> = new Map();
  const expenseTotals: Map<string, { accountCode: string; accountName: string; amount: number; propertyId?: string }> = new Map();
  
  for (const entry of entries) {
    for (const line of entry.lines) {
      const account = accountMap.get(line.accountCode);
      if (!account) continue;
      
      const key = `${line.accountCode}-${line.propertyId || 'none'}`;
      
      if (account.type === 'REVENUE') {
        const amount = line.dc === 'C' ? line.amount : -line.amount;
        const existing = revenueTotals.get(key);
        if (existing) {
          existing.amount += amount;
        } else {
          revenueTotals.set(key, {
            accountCode: line.accountCode,
            accountName: account.name,
            amount,
            propertyId: line.propertyId
          });
        }
      } else if (account.type === 'EXPENSE') {
        const amount = line.dc === 'D' ? line.amount : -line.amount;
        const existing = expenseTotals.get(key);
        if (existing) {
          existing.amount += amount;
        } else {
          expenseTotals.set(key, {
            accountCode: line.accountCode,
            accountName: account.name,
            amount,
            propertyId: line.propertyId
          });
        }
      }
    }
  }
  
  return {
    revenue: Array.from(revenueTotals.values()).filter(r => Math.abs(r.amount) > 0.005),
    expenses: Array.from(expenseTotals.values()).filter(e => Math.abs(e.amount) > 0.005)
  };
}

/**
 * Get cashflow trend (monthly net income for last N months)
 */
export async function getCashflowTrend(
  userId: string,
  months: number = 6
): Promise<{ month: string; income: number; expenses: number; net: number }[]> {
  const trend: { month: string; income: number; expenses: number; net: number }[] = [];
  const today = new Date();
  
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    const totals = await getMonthlyTotals(userId, month);
    
    const income = totals.revenue.reduce((sum, r) => sum + r.amount, 0);
    const expenses = totals.expenses.reduce((sum, e) => sum + e.amount, 0);
    
    trend.push({
      month,
      income: Math.round(income * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      net: Math.round((income - expenses) * 100) / 100
    });
  }
  
  return trend;
}

// ============================================================================
// QuickBooks Integration Helpers
// ============================================================================

/**
 * Map a QuickBooks account to local account
 */
export async function mapQBOAccount(
  userId: string,
  localAccountCode: string,
  qboAccountId: string
): Promise<void> {
  const accountRef = doc(getAccountsRef(userId), localAccountCode);
  await updateDoc(accountRef, {
    qboAccountId,
    updatedAt: new Date().toISOString()
  });
}

/**
 * Update QBO config for user
 */
export async function updateQBOConfig(
  userId: string,
  config: Partial<BookkeepingConfig>
): Promise<void> {
  const configRef = getConfigRef(userId);
  await updateDoc(configRef, {
    ...config,
  });
}

/**
 * Get QBO config for user
 */
export async function getQBOConfig(userId: string): Promise<BookkeepingConfig | null> {
  const configRef = getConfigRef(userId);
  const snapshot = await getDoc(configRef);
  
  if (!snapshot.exists()) return null;
  
  return snapshot.data() as BookkeepingConfig;
}

/**
 * Check if bookkeeping is initialized for user
 */
export async function isBookkeepingInitialized(userId: string): Promise<boolean> {
  const configRef = getConfigRef(userId);
  const snapshot = await getDoc(configRef);
  return snapshot.exists();
}

/**
 * Import transactions from QuickBooks into Firestore
 */
export async function importFromQuickBooks(
  userId: string,
  transactions: {
    date: string;
    memo: string;
    amount: number;
    accountCode: string;
    accountName: string;
    type: 'income' | 'expense';
    qboId: string;
  }[],
  postedBy: string
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  
  for (const txn of transactions) {
    // Check if already imported (by QBO ID)
    const existing = await getJournalEntries(userId, { source: 'QBO_IMPORT' });
    if (existing.some(e => e.sourceRef === txn.qboId)) {
      skipped++;
      continue;
    }
    
    // Determine lines based on transaction type
    const lines: JournalLine[] = [];
    
    if (txn.type === 'income') {
      // Debit cash, credit revenue
      lines.push({
        accountId: '',
        accountCode: '1000',
        accountName: 'Operating Cash',
        amount: txn.amount,
        dc: 'D'
      });
      lines.push({
        accountId: '',
        accountCode: txn.accountCode || '4000',
        accountName: txn.accountName || 'Rental Income',
        amount: txn.amount,
        dc: 'C'
      });
    } else {
      // Debit expense, credit cash
      lines.push({
        accountId: '',
        accountCode: txn.accountCode || '5000',
        accountName: txn.accountName || 'Repairs & Maintenance',
        amount: txn.amount,
        dc: 'D'
      });
      lines.push({
        accountId: '',
        accountCode: '1000',
        accountName: 'Operating Cash',
        amount: txn.amount,
        dc: 'C'
      });
    }
    
    await createJournalEntry(userId, {
      entryDate: txn.date,
      memo: txn.memo,
      source: 'QBO_IMPORT',
      sourceRef: txn.qboId,
      lines,
      postedBy
    });
    
    imported++;
  }
  
  return { imported, skipped };
}

// ============================================================================
// Export for QuickBooks
// ============================================================================

export interface QBOExportPayload {
  month: string;
  propertyCode: string;
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
  lines: {
    accountCode: string;
    accountName: string;
    amount: number;
    dc: 'D' | 'C';
  }[];
}

/**
 * Generate QuickBooks export payload for a month
 */
export async function generateQBOExportPayload(
  userId: string,
  month: string,
  propertyCode: string
): Promise<QBOExportPayload | null> {
  const totals = await getMonthlyTotals(userId, month);
  
  if (totals.revenue.length === 0 && totals.expenses.length === 0) {
    return null; // No activity
  }
  
  const lines: QBOExportPayload['lines'] = [];
  
  // Add revenue lines (Credit to revenue accounts)
  for (const rev of totals.revenue) {
    lines.push({
      accountCode: rev.accountCode,
      accountName: rev.accountName,
      amount: Math.abs(rev.amount),
      dc: 'C'
    });
  }
  
  // Add expense lines (Debit to expense accounts)
  for (const exp of totals.expenses) {
    lines.push({
      accountCode: exp.accountCode,
      accountName: exp.accountName,
      amount: Math.abs(exp.amount),
      dc: 'D'
    });
  }
  
  const totalRevenue = totals.revenue.reduce((sum, r) => sum + r.amount, 0);
  const totalExpenses = totals.expenses.reduce((sum, e) => sum + e.amount, 0);
  
  return {
    month,
    propertyCode,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    netIncome: Math.round((totalRevenue - totalExpenses) * 100) / 100,
    lines
  };
}
