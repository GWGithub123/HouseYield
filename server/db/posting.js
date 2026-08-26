/**
 * Double-Entry Posting Engine
 * Core accounting logic - ensures balanced journals and immutability
 */

import { getDb } from './connection.js';
import { classifyTransaction, getMortgageSplit, POSTING_TYPES } from './classifier.js';

/**
 * Check if date is in a closed period
 */
export function isInClosedPeriod(date) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM periods
    WHERE is_closed = 1 
      AND ? BETWEEN period_start AND period_end
  `);
  
  const result = stmt.get(date);
  return result.count > 0;
}

/**
 * Check if journal entry already exists for this bank transaction
 */
export function isAlreadyPosted(bankTxnId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM journal_entries
    WHERE source = 'BANK' AND source_ref = ?
  `);
  
  const result = stmt.get(bankTxnId);
  return result.count > 0;
}

/**
 * Verify journal entry is balanced (debits == credits)
 */
export function verifyBalance(journalEntryId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT 
      SUM(CASE WHEN dc = 'D' THEN amount ELSE 0 END) as total_debits,
      SUM(CASE WHEN dc = 'C' THEN amount ELSE 0 END) as total_credits
    FROM journal_lines
    WHERE journal_entry_id = ?
  `);
  
  const result = stmt.get(journalEntryId);
  const debits = parseFloat(result.total_debits || 0);
  const credits = parseFloat(result.total_credits || 0);
  
  // Allow for small floating point differences (1 cent)
  const isBalanced = Math.abs(debits - credits) < 0.01;
  
  return {
    isBalanced,
    debits,
    credits,
    difference: debits - credits
  };
}

/**
 * Get account ID by code
 */
function getAccountId(code) {
  const db = getDb();
  const stmt = db.prepare('SELECT id FROM accounts WHERE code = ? AND is_active = 1');
  const account = stmt.get(code);
  
  if (!account) {
    throw new Error(`Account not found: ${code}`);
  }
  
  return account.id;
}

/**
 * Create journal entry header
 */
function createJournalEntry(date, memo, source, sourceRef, postedBy = 'system') {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO journal_entries (entry_date, memo, source, source_ref, posted_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(date, memo, source, sourceRef, postedBy);
  return result.lastInsertRowid;
}

/**
 * Create journal line
 */
function createJournalLine(journalEntryId, line) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO journal_lines 
      (journal_entry_id, account_id, property_id, tenant_id, amount, dc, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const accountId = getAccountId(line.account_code);
  
  return stmt.run(
    journalEntryId,
    accountId,
    line.property_id || null,
    line.tenant_id || null,
    line.amount,
    line.dc,
    line.memo || null
  );
}

/**
 * Post a bank transaction to the general ledger
 * Main entry point for creating journal entries from bank data
 */
export function postBankTransaction(txn) {
  const db = getDb();
  
  // Guardrails
  if (isInClosedPeriod(txn.txn_date)) {
    throw new Error(`Cannot post to closed period: ${txn.txn_date}`);
  }
  
  if (txn.bank_txn_id && isAlreadyPosted(txn.bank_txn_id)) {
    throw new Error(`Transaction already posted: ${txn.bank_txn_id}`);
  }
  
  // Classify transaction
  const classification = classifyTransaction(txn);
  
  // Generate journal lines based on posting type
  const lines = generateJournalLines(txn, classification);
  
  // Begin transaction
  const transaction = db.transaction(() => {
    // Create journal entry
    const journalId = createJournalEntry(
      txn.txn_date,
      txn.description || txn.memo,
      'BANK',
      txn.bank_txn_id,
      'system'
    );
    
    // Create all journal lines
    for (const line of lines) {
      createJournalLine(journalId, line);
    }
    
    // Verify balance
    const balance = verifyBalance(journalId);
    if (!balance.isBalanced) {
      throw new Error(
        `Journal entry not balanced! Debits: ${balance.debits}, Credits: ${balance.credits}`
      );
    }
    
    // Mark bank transaction as posted
    if (txn.bank_txn_id) {
      const updateStmt = db.prepare(`
        UPDATE bank_transactions 
        SET is_posted = 1, posted_journal_id = ?
        WHERE bank_txn_id = ?
      `);
      updateStmt.run(journalId, txn.bank_txn_id);
    }
    
    return {
      journal_entry_id: journalId,
      posting_type: classification.type,
      lines: lines.length,
      balance
    };
  });
  
  return transaction();
}

/**
 * Generate journal lines based on classification
 */
function generateJournalLines(txn, classification) {
  const lines = [];
  const propertyId = txn.property_id;
  
  switch (classification.type) {
    case POSTING_TYPES.RENT_RECEIPT:
      // Cash basis rent
      lines.push(
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Rent received', property_id: propertyId },
        { account_code: '4000', dc: 'C', amount: txn.amount, memo: 'Rent income', property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.VENDOR_EXPENSE:
      const expenseAccount = classification.category || '5000';
      lines.push(
        { account_code: expenseAccount, dc: 'D', amount: txn.amount, memo: txn.description, property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.MORTGAGE_PAYMENT:
      const split = getMortgageSplit(txn);
      lines.push(
        { account_code: '5050', dc: 'D', amount: split.interest, memo: 'Mortgage interest', property_id: propertyId },
        { account_code: '1600', dc: 'D', amount: split.escrow, memo: 'Escrow', property_id: propertyId },
        { account_code: '2200', dc: 'C', amount: split.principal, memo: 'Principal reduction', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.SECURITY_DEPOSIT_RECEIPT:
      lines.push(
        { account_code: '1010', dc: 'D', amount: txn.amount, memo: 'Security deposit received', property_id: propertyId },
        { account_code: '2000', dc: 'C', amount: txn.amount, memo: 'Security deposits payable', property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.SECURITY_DEPOSIT_RETURN:
      lines.push(
        { account_code: '2000', dc: 'D', amount: txn.amount, memo: 'Security deposit returned', property_id: propertyId },
        { account_code: '1010', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.OWNER_CONTRIBUTION:
      lines.push(
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Owner contribution', property_id: propertyId },
        { account_code: '3000', dc: 'C', amount: txn.amount, memo: "Owner's equity", property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.OWNER_DRAW:
      lines.push(
        { account_code: '3000', dc: 'D', amount: txn.amount, memo: 'Owner draw', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.TRANSFER:
      // Asset to asset - no P&L impact
      lines.push(
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Transfer in', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Transfer out', property_id: propertyId }
      );
      break;
      
    case POSTING_TYPES.CAPEX:
      lines.push(
        { account_code: '1500', dc: 'D', amount: txn.amount, memo: 'Capital expenditure', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    // Additional tax-aware posting types
    case POSTING_TYPES.INSURANCE_PAYMENT:
      lines.push(
        { account_code: '5020', dc: 'D', amount: txn.amount, memo: 'Insurance premium', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.PROPERTY_TAX:
      lines.push(
        { account_code: '5030', dc: 'D', amount: txn.amount, memo: 'Property tax', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.UTILITIES:
      lines.push(
        { account_code: '5010', dc: 'D', amount: txn.amount, memo: txn.description || 'Utilities', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.MANAGEMENT_FEE:
      lines.push(
        { account_code: '5040', dc: 'D', amount: txn.amount, memo: 'Property management fee', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.LEGAL_PROFESSIONAL:
      lines.push(
        { account_code: '5120', dc: 'D', amount: txn.amount, memo: txn.description || 'Legal/Professional fees', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.ADVERTISING:
      lines.push(
        { account_code: '5070', dc: 'D', amount: txn.amount, memo: txn.description || 'Advertising/Leasing', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.HOA_FEES:
      lines.push(
        { account_code: '5060', dc: 'D', amount: txn.amount, memo: 'HOA/Condo fees', property_id: propertyId },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash payment', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.LATE_FEE_INCOME:
      lines.push(
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Late fee received', property_id: propertyId },
        { account_code: '4010', dc: 'C', amount: txn.amount, memo: 'Late fee income', property_id: propertyId }
      );
      break;
    
    case POSTING_TYPES.APPLICATION_FEE:
      lines.push(
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Application fee received', property_id: propertyId },
        { account_code: '4030', dc: 'C', amount: txn.amount, memo: 'Application fee income', property_id: propertyId }
      );
      break;
      
    default:
      throw new Error(`Unknown posting type: ${classification.type}`);
  }
  
  return lines;
}

/**
 * Create manual journal entry
 */
export function createManualJournalEntry(date, memo, lines, postedBy = 'user') {
  const db = getDb();
  
  // Guardrails
  if (isInClosedPeriod(date)) {
    throw new Error(`Cannot post to closed period: ${date}`);
  }
  
  // Begin transaction
  const transaction = db.transaction(() => {
    // Create journal entry
    const journalId = createJournalEntry(date, memo, 'MANUAL', null, postedBy);
    
    // Create all journal lines
    for (const line of lines) {
      createJournalLine(journalId, line);
    }
    
    // Verify balance
    const balance = verifyBalance(journalId);
    if (!balance.isBalanced) {
      throw new Error(
        `Journal entry not balanced! Debits: ${balance.debits}, Credits: ${balance.credits}`
      );
    }
    
    return {
      journal_entry_id: journalId,
      lines: lines.length,
      balance
    };
  });
  
  return transaction();
}

/**
 * Create reversal entry
 */
export function createReversalEntry(originalJournalId, reversalDate, postedBy = 'user') {
  const db = getDb();
  
  // Get original entry lines
  const getLines = db.prepare(`
    SELECT jl.*, a.code as account_code
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.journal_entry_id = ?
  `);
  
  const originalLines = getLines.all(originalJournalId);
  
  if (originalLines.length === 0) {
    throw new Error(`Journal entry not found: ${originalJournalId}`);
  }
  
  // Flip debits/credits
  const reversalLines = originalLines.map(line => ({
    account_code: line.account_code,
    property_id: line.property_id,
    tenant_id: line.tenant_id,
    amount: line.amount,
    dc: line.dc === 'D' ? 'C' : 'D', // Flip D/C
    memo: `Reversal: ${line.memo || ''}`
  }));
  
  // Begin transaction
  const transaction = db.transaction(() => {
    // Create reversal entry
    const journalId = createJournalEntry(
      reversalDate,
      `Reversal of JE#${originalJournalId}`,
      'MANUAL',
      null,
      postedBy
    );
    
    // Mark as reversal
    const updateStmt = db.prepare(`
      UPDATE journal_entries
      SET is_reversal = 1, reversed_entry_id = ?
      WHERE id = ?
    `);
    updateStmt.run(originalJournalId, journalId);
    
    // Create reversal lines
    for (const line of reversalLines) {
      createJournalLine(journalId, line);
    }
    
    // Verify balance
    const balance = verifyBalance(journalId);
    if (!balance.isBalanced) {
      throw new Error('Reversal entry not balanced!');
    }
    
    return {
      journal_entry_id: journalId,
      reversed_entry_id: originalJournalId,
      lines: reversalLines.length
    };
  });
  
  return transaction();
}

/**
 * Post monthly depreciation
 */
export function postMonthlyDepreciation(periodEnd, postedBy = 'system') {
  const db = getDb();
  
  const getActiveAssets = db.prepare(`
    SELECT * FROM fixed_assets WHERE is_active = 1
  `);
  
  const assets = getActiveAssets.all();
  const results = [];
  
  for (const asset of assets) {
    // Calculate monthly depreciation
    const monthlyDepreciation = (asset.cost - asset.salvage) / asset.life_months;
    
    if (monthlyDepreciation <= 0) continue;
    
    // Check if already posted for this period
    const checkStmt = db.prepare(`
      SELECT COUNT(*) as count FROM journal_entries je
      JOIN journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.entry_date = ?
        AND je.source = 'SYSTEM'
        AND jl.account_id = ?
        AND jl.property_id = ?
    `);
    
    const existing = checkStmt.get(periodEnd, asset.account_accum_id, asset.property_id);
    if (existing.count > 0) {
      continue; // Already posted
    }
    
    // Create depreciation entry
    const lines = [
      {
        account_code: '5090', // Depreciation Expense
        dc: 'D',
        amount: monthlyDepreciation,
        memo: `Monthly depreciation - Asset #${asset.id}`,
        property_id: asset.property_id
      },
      {
        account_code: '1510', // Accumulated Depreciation
        dc: 'C',
        amount: monthlyDepreciation,
        memo: `Accumulated depreciation - Asset #${asset.id}`,
        property_id: asset.property_id
      }
    ];
    
    try {
      const result = createManualJournalEntry(
        periodEnd,
        `Depreciation for ${periodEnd}`,
        lines,
        postedBy
      );
      results.push({ asset_id: asset.id, ...result });
    } catch (error) {
      console.error(`[Posting] Error posting depreciation for asset ${asset.id}:`, error);
    }
  }
  
  return results;
}
