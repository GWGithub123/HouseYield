/**
 * Recurring Transactions Module
 * QuickBooks-style scheduled/recurring transactions
 * Auto-generate rent charges, mortgage payments, etc.
 */

import { getDb } from './connection.js';
import { createManualJournalEntry } from './posting.js';

/**
 * Create a recurring transaction template
 */
export function createRecurringTransaction(template) {
  const db = getDb();
  
  const {
    name,
    frequency, // 'monthly', 'quarterly', 'annually', 'weekly'
    amount,
    accountCode,
    offsetAccountCode,
    memo,
    dayOfMonth = 1,
    startDate,
    endDate = null,
    propertyId = null,
    tenantId = null
  } = template;
  
  // Validate accounts exist
  const account = db.prepare('SELECT * FROM accounts WHERE code = ?').get(accountCode);
  const offsetAccount = db.prepare('SELECT * FROM accounts WHERE code = ?').get(offsetAccountCode);
  
  if (!account) throw new Error(`Account ${accountCode} not found`);
  if (!offsetAccount) throw new Error(`Account ${offsetAccountCode} not found`);
  
  // Create recurring_transactions table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(120) NOT NULL,
      frequency VARCHAR(20) NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'annually')),
      amount REAL NOT NULL,
      account_code VARCHAR(20) NOT NULL,
      offset_account_code VARCHAR(20) NOT NULL,
      memo TEXT,
      day_of_month INTEGER DEFAULT 1,
      start_date DATE NOT NULL,
      end_date DATE,
      property_id INTEGER REFERENCES properties(id),
      tenant_id INTEGER REFERENCES tenants(id),
      last_generated DATE,
      next_due DATE,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Calculate next due date
  const nextDue = calculateNextDue(startDate, frequency, dayOfMonth);
  
  const result = db.prepare(`
    INSERT INTO recurring_transactions (
      name, frequency, amount, account_code, offset_account_code,
      memo, day_of_month, start_date, end_date, property_id, tenant_id,
      next_due, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    name,
    frequency,
    amount,
    accountCode,
    offsetAccountCode,
    memo || name,
    dayOfMonth,
    startDate,
    endDate,
    propertyId,
    tenantId,
    nextDue
  );
  
  return {
    id: result.lastInsertRowid,
    name,
    frequency,
    amount,
    nextDue,
    accountName: account.name,
    offsetAccountName: offsetAccount.name
  };
}

/**
 * Calculate next due date based on frequency
 */
function calculateNextDue(fromDate, frequency, dayOfMonth = 1) {
  const date = new Date(fromDate);
  const today = new Date();
  
  // Start from today if fromDate is in the past
  if (date < today) {
    date.setTime(today.getTime());
  }
  
  switch (frequency) {
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      date.setDate(Math.min(dayOfMonth, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
      break;
    case 'quarterly':
      date.setMonth(date.getMonth() + 3);
      date.setDate(Math.min(dayOfMonth, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
      break;
    case 'annually':
      date.setFullYear(date.getFullYear() + 1);
      date.setDate(Math.min(dayOfMonth, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
      break;
  }
  
  return date.toISOString().split('T')[0];
}

/**
 * Get all recurring transactions
 */
export function getRecurringTransactions(options = {}) {
  const db = getDb();
  const { propertyId, isActive = true } = options;
  
  // Ensure table exists
  try {
    db.prepare('SELECT 1 FROM recurring_transactions LIMIT 1').get();
  } catch {
    return [];
  }
  
  let query = `
    SELECT rt.*, 
           a1.name as account_name,
           a2.name as offset_account_name,
           p.name as property_name
    FROM recurring_transactions rt
    LEFT JOIN accounts a1 ON a1.code = rt.account_code
    LEFT JOIN accounts a2 ON a2.code = rt.offset_account_code
    LEFT JOIN properties p ON p.id = rt.property_id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (isActive !== null) {
    query += ` AND rt.is_active = ?`;
    params.push(isActive ? 1 : 0);
  }
  
  if (propertyId) {
    query += ` AND rt.property_id = ?`;
    params.push(propertyId);
  }
  
  query += ` ORDER BY rt.next_due ASC`;
  
  return db.prepare(query).all(...params);
}

/**
 * Generate due recurring transactions
 * Creates journal entries for all transactions due up to today
 */
export function generateDueTransactions(asOfDate = null) {
  const db = getDb();
  const today = asOfDate || new Date().toISOString().split('T')[0];
  
  // Ensure table exists
  try {
    db.prepare('SELECT 1 FROM recurring_transactions LIMIT 1').get();
  } catch {
    return { generated: 0, entries: [] };
  }
  
  const dueTransactions = db.prepare(`
    SELECT * FROM recurring_transactions
    WHERE is_active = 1 
      AND next_due <= ?
      AND (end_date IS NULL OR end_date >= ?)
  `).all(today, today);
  
  const entries = [];
  
  for (const txn of dueTransactions) {
    try {
      // Determine debit/credit based on account types
      const account = db.prepare('SELECT * FROM accounts WHERE code = ?').get(txn.account_code);
      const offsetAccount = db.prepare('SELECT * FROM accounts WHERE code = ?').get(txn.offset_account_code);
      
      let lines;
      
      // Revenue (Rent Income): Debit Cash/AR, Credit Revenue
      if (account.type === 'REVENUE') {
        lines = [
          { account_code: txn.offset_account_code, dc: 'D', amount: txn.amount, memo: txn.memo },
          { account_code: txn.account_code, dc: 'C', amount: txn.amount, memo: txn.memo }
        ];
      } 
      // Expense (Mortgage, etc.): Debit Expense, Credit Cash/AP
      else if (account.type === 'EXPENSE') {
        lines = [
          { account_code: txn.account_code, dc: 'D', amount: txn.amount, memo: txn.memo },
          { account_code: txn.offset_account_code, dc: 'C', amount: txn.amount, memo: txn.memo }
        ];
      }
      // Asset changes
      else {
        lines = [
          { account_code: txn.account_code, dc: 'D', amount: txn.amount, memo: txn.memo },
          { account_code: txn.offset_account_code, dc: 'C', amount: txn.amount, memo: txn.memo }
        ];
      }
      
      // Add property_id to lines if set
      if (txn.property_id) {
        lines = lines.map(l => ({ ...l, property_id: txn.property_id }));
      }
      
      const entry = createManualJournalEntry(
        txn.next_due,
        `${txn.name} - Auto-generated`,
        lines,
        'recurring'
      );
      
      entries.push({
        recurringId: txn.id,
        name: txn.name,
        journalEntryId: entry.journal_entry_id,
        amount: txn.amount,
        date: txn.next_due
      });
      
      // Update next_due and last_generated
      const nextDue = calculateNextDue(txn.next_due, txn.frequency, txn.day_of_month);
      
      db.prepare(`
        UPDATE recurring_transactions 
        SET last_generated = ?, next_due = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(txn.next_due, nextDue, txn.id);
      
    } catch (err) {
      console.error(`Error generating recurring transaction ${txn.id}:`, err);
    }
  }
  
  return {
    generated: entries.length,
    entries
  };
}

/**
 * Update a recurring transaction
 */
export function updateRecurringTransaction(id, updates) {
  const db = getDb();
  
  const allowedFields = ['name', 'frequency', 'amount', 'account_code', 'offset_account_code', 
                         'memo', 'day_of_month', 'end_date', 'is_active'];
  
  const setClause = [];
  const params = [];
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClause.push(`${key} = ?`);
      params.push(value);
    }
  }
  
  if (setClause.length === 0) {
    throw new Error('No valid fields to update');
  }
  
  setClause.push('updated_at = datetime(\'now\')');
  params.push(id);
  
  const result = db.prepare(`
    UPDATE recurring_transactions 
    SET ${setClause.join(', ')}
    WHERE id = ?
  `).run(...params);
  
  return { updated: result.changes > 0 };
}

/**
 * Delete (deactivate) a recurring transaction
 */
export function deleteRecurringTransaction(id) {
  const db = getDb();
  
  const result = db.prepare(`
    UPDATE recurring_transactions 
    SET is_active = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  
  return { deleted: result.changes > 0 };
}

/**
 * Get upcoming recurring transactions
 */
export function getUpcomingRecurring(days = 30) {
  const db = getDb();
  const today = new Date();
  const futureDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
  
  // Ensure table exists
  try {
    db.prepare('SELECT 1 FROM recurring_transactions LIMIT 1').get();
  } catch {
    return [];
  }
  
  return db.prepare(`
    SELECT rt.*, a.name as account_name, p.name as property_name
    FROM recurring_transactions rt
    LEFT JOIN accounts a ON a.code = rt.account_code
    LEFT JOIN properties p ON p.id = rt.property_id
    WHERE rt.is_active = 1
      AND rt.next_due <= ?
      AND (rt.end_date IS NULL OR rt.end_date >= ?)
    ORDER BY rt.next_due ASC
  `).all(futureDate.toISOString().split('T')[0], today.toISOString().split('T')[0]);
}

/**
 * Common recurring transaction templates
 */
export const RECURRING_TEMPLATES = {
  RENT_CHARGE: {
    name: 'Monthly Rent',
    frequency: 'monthly',
    accountCode: '4000', // Rent Income
    offsetAccountCode: '1200', // Accounts Receivable
    dayOfMonth: 1
  },
  MORTGAGE_PAYMENT: {
    name: 'Mortgage Payment',
    frequency: 'monthly',
    accountCode: '5050', // Mortgage Interest
    offsetAccountCode: '1000', // Cash
    dayOfMonth: 1
  },
  PROPERTY_TAX: {
    name: 'Property Tax',
    frequency: 'quarterly',
    accountCode: '5030', // Property Taxes
    offsetAccountCode: '1000', // Cash
    dayOfMonth: 15
  },
  INSURANCE_PREMIUM: {
    name: 'Insurance Premium',
    frequency: 'monthly',
    accountCode: '5020', // Insurance
    offsetAccountCode: '1000', // Cash
    dayOfMonth: 1
  },
  HOA_DUES: {
    name: 'HOA Dues',
    frequency: 'monthly',
    accountCode: '5060', // HOA/Condo Fees
    offsetAccountCode: '1000', // Cash
    dayOfMonth: 1
  }
};
