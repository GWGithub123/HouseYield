/**
 * Bank Reconciliation Module
 * QuickBooks-style bank statement reconciliation
 * Match statement balances to book balances, track cleared items
 */

import { getDb } from './connection.js';

/**
 * Start a new bank reconciliation
 * @param {string} accountCode - Bank account code (e.g., '1000')
 * @param {string} statementDate - Statement date (YYYY-MM-DD)
 * @param {number} statementBalance - Ending balance per bank statement
 */
export function startReconciliation(accountCode, statementDate, statementBalance) {
  const db = getDb();
  
  // Check if account exists
  const account = db.prepare('SELECT * FROM accounts WHERE code = ?').get(accountCode);
  if (!account) {
    throw new Error(`Account ${accountCode} not found`);
  }
  
  // Create bank statement record
  const stmt = db.prepare(`
    INSERT INTO bank_statements (account_code, statement_date, ending_balance, is_reconciled, created_at)
    VALUES (?, ?, ?, 0, datetime('now'))
  `);
  
  const result = stmt.run(accountCode, statementDate, statementBalance);
  
  // Get uncleared items for this account
  const unclearedItems = getUnclearedItems(accountCode, statementDate);
  
  // Calculate book balance
  const bookBalance = getBookBalance(accountCode, statementDate);
  
  return {
    statementId: result.lastInsertRowid,
    accountCode,
    statementDate,
    statementBalance,
    bookBalance,
    difference: statementBalance - bookBalance,
    unclearedItems,
    status: 'in_progress'
  };
}

/**
 * Get book balance for an account as of a date
 */
export function getBookBalance(accountCode, asOfDate) {
  const db = getDb();
  
  const result = db.prepare(`
    SELECT 
      a.normal_side,
      SUM(CASE WHEN jl.dc = 'D' THEN jl.amount ELSE 0 END) as total_debits,
      SUM(CASE WHEN jl.dc = 'C' THEN jl.amount ELSE 0 END) as total_credits
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.code = ?
      AND je.entry_date <= ?
    GROUP BY a.id
  `).get(accountCode, asOfDate);
  
  if (!result) return 0;
  
  // For asset accounts (normal debit), balance = debits - credits
  // For liability accounts (normal credit), balance = credits - debits
  if (result.normal_side === 'D') {
    return (result.total_debits || 0) - (result.total_credits || 0);
  } else {
    return (result.total_credits || 0) - (result.total_debits || 0);
  }
}

/**
 * Get uncleared journal lines for an account
 */
export function getUnclearedItems(accountCode, asOfDate) {
  const db = getDb();
  
  return db.prepare(`
    SELECT 
      jl.id as line_id,
      je.id as entry_id,
      je.entry_date,
      je.memo,
      jl.amount,
      jl.dc,
      jl.memo as line_memo,
      jl.bank_cleared_at,
      a.code as account_code,
      a.name as account_name
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.code = ?
      AND je.entry_date <= ?
      AND jl.bank_cleared_at IS NULL
    ORDER BY je.entry_date DESC
  `).all(accountCode, asOfDate);
}

/**
 * Mark journal lines as cleared
 * @param {number[]} lineIds - Array of journal_line IDs to clear
 * @param {number} statementId - Bank statement ID
 */
export function clearItems(lineIds, statementId) {
  const db = getDb();
  
  // Get statement info
  const statement = db.prepare('SELECT * FROM bank_statements WHERE id = ?').get(statementId);
  if (!statement) {
    throw new Error('Statement not found');
  }
  
  const updateStmt = db.prepare(`
    UPDATE journal_lines 
    SET bank_cleared_at = datetime('now'), bank_stmt_id = ?
    WHERE id = ?
  `);
  
  const cleared = db.transaction((ids) => {
    let count = 0;
    for (const id of ids) {
      const result = updateStmt.run(statementId.toString(), id);
      count += result.changes;
    }
    return count;
  })(lineIds);
  
  return { cleared, statementId };
}

/**
 * Unclear journal lines (undo clear)
 * @param {number[]} lineIds - Array of journal_line IDs to unclear
 */
export function unclearItems(lineIds) {
  const db = getDb();
  
  const updateStmt = db.prepare(`
    UPDATE journal_lines 
    SET bank_cleared_at = NULL, bank_stmt_id = NULL
    WHERE id = ?
  `);
  
  const uncleared = db.transaction((ids) => {
    let count = 0;
    for (const id of ids) {
      const result = updateStmt.run(id);
      count += result.changes;
    }
    return count;
  })(lineIds);
  
  return { uncleared };
}

/**
 * Complete reconciliation
 * Marks statement as reconciled if difference is zero
 */
export function completeReconciliation(statementId, reconciledBy = 'user') {
  const db = getDb();
  
  const statement = db.prepare('SELECT * FROM bank_statements WHERE id = ?').get(statementId);
  if (!statement) {
    throw new Error('Statement not found');
  }
  
  // Calculate cleared balance
  const clearedBalance = db.prepare(`
    SELECT 
      SUM(CASE WHEN jl.dc = 'D' THEN jl.amount ELSE -jl.amount END) as cleared_total
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.code = ?
      AND jl.bank_stmt_id = ?
  `).get(statement.account_code, statementId.toString());
  
  const bookBalance = getBookBalance(statement.account_code, statement.statement_date);
  const difference = statement.ending_balance - bookBalance;
  
  // Allow small rounding differences
  if (Math.abs(difference) > 0.01) {
    return {
      ok: false,
      error: 'Reconciliation does not balance',
      statementBalance: statement.ending_balance,
      bookBalance,
      difference
    };
  }
  
  // Mark as reconciled
  db.prepare(`
    UPDATE bank_statements 
    SET is_reconciled = 1, reconciled_by = ?, reconciled_at = datetime('now')
    WHERE id = ?
  `).run(reconciledBy, statementId);
  
  return {
    ok: true,
    statementId,
    reconciledAt: new Date().toISOString(),
    reconciledBy,
    statementBalance: statement.ending_balance,
    bookBalance,
    difference: 0
  };
}

/**
 * Get reconciliation history for an account
 */
export function getReconciliationHistory(accountCode) {
  const db = getDb();
  
  return db.prepare(`
    SELECT 
      id,
      statement_date,
      ending_balance,
      is_reconciled,
      reconciled_by,
      reconciled_at,
      created_at
    FROM bank_statements
    WHERE account_code = ?
    ORDER BY statement_date DESC
  `).all(accountCode);
}

/**
 * Get reconciliation status/summary
 */
export function getReconciliationStatus(accountCode) {
  const db = getDb();
  
  const lastReconciled = db.prepare(`
    SELECT * FROM bank_statements 
    WHERE account_code = ? AND is_reconciled = 1
    ORDER BY statement_date DESC LIMIT 1
  `).get(accountCode);
  
  const pendingStatement = db.prepare(`
    SELECT * FROM bank_statements 
    WHERE account_code = ? AND is_reconciled = 0
    ORDER BY statement_date DESC LIMIT 1
  `).get(accountCode);
  
  const today = new Date().toISOString().split('T')[0];
  const unclearedCount = getUnclearedItems(accountCode, today).length;
  const currentBalance = getBookBalance(accountCode, today);
  
  return {
    accountCode,
    currentBalance,
    unclearedItemCount: unclearedCount,
    lastReconciledDate: lastReconciled?.statement_date || null,
    lastReconciledBalance: lastReconciled?.ending_balance || null,
    pendingReconciliation: pendingStatement ? {
      statementId: pendingStatement.id,
      statementDate: pendingStatement.statement_date,
      statementBalance: pendingStatement.ending_balance
    } : null
  };
}
