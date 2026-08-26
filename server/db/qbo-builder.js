/**
 * QuickBooks Journal Entry Builder
 * Constructs QBO-compliant journal entry payloads
 */

import {
  getPropertyMonthTotals,
  getQBOPropertyMapping,
  getQBOAccountMapping,
  getEquityPlugAccount
} from './qbo-sync.js';

/**
 * Build a QuickBooks Journal Entry payload for a property month
 * @param {number} propertyId - Property ID
 * @param {string} periodStart - Period start date (YYYY-MM-DD)
 * @param {string} periodEnd - Period end date (YYYY-MM-DD)
 * @param {string} propertyCode - Short property code for doc number
 * @returns {object} QBO JournalEntry payload or error
 */
export function buildMonthlyJournalEntry(propertyId, periodStart, periodEnd, propertyCode) {
  // Get monthly totals
  const totals = getPropertyMonthTotals(propertyId, periodStart, periodEnd);
  
  if (totals.length === 0) {
    return {
      ok: false,
      error: 'no_activity',
      message: 'No activity found for this property in the specified period'
    };
  }
  
  // Get property mapping
  const propertyMapping = getQBOPropertyMapping(propertyId);
  if (!propertyMapping) {
    return {
      ok: false,
      error: 'missing_property_mapping',
      message: `Property ${propertyId} is not mapped to a QuickBooks Location/Department`
    };
  }
  
  // Get equity plug account
  const equityPlugAccountId = getEquityPlugAccount();
  if (!equityPlugAccountId) {
    return {
      ok: false,
      error: 'missing_equity_plug',
      message: 'Equity plug account not configured. Please complete QuickBooks setup.'
    };
  }
  
  // Build lines
  const lines = [];
  let totalExpenses = 0;
  let totalIncome = 0;
  const missingMappings = [];
  const skippedAccounts = [];
  
  for (const total of totals) {
    const accountMapping = getQBOAccountMapping(total.account_code);
    
    if (!accountMapping) {
      // Don't fail - skip unmapped accounts with warning
      skippedAccounts.push({
        code: total.account_code,
        name: total.account_name,
        amount: total.amount
      });
      continue;
    }
    
    const isExpense = total.type === 'EXPENSE';
    const amount = Math.abs(total.amount);
    
    if (amount < 0.01) continue; // Skip negligible amounts
    
    lines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: amount.toFixed(2),
      Description: total.account_name,
      JournalEntryLineDetail: {
        PostingType: isExpense ? 'Debit' : 'Credit',
        AccountRef: { value: accountMapping.qbo_account_id },
        DepartmentRef: { value: propertyMapping.qbo_department_id }
      }
    });
    
    if (isExpense) {
      totalExpenses += amount;
    } else {
      totalIncome += amount;
    }
  }
  
  // Check for missing mappings - warn but don't fail
  if (skippedAccounts.length > 0) {
    console.warn(`[QBO Builder] Skipped ${skippedAccounts.length} unmapped accounts:`, skippedAccounts.map(a => a.code).join(', '));
  }
  
  // If ALL accounts are unmapped, that's an error
  if (lines.length === 0 && skippedAccounts.length > 0) {
    return {
      ok: false,
      error: 'missing_account_mappings',
      message: `None of the accounts are mapped to QuickBooks. Please map your accounts first.`,
      missing_accounts: skippedAccounts.map(a => a.code)
    };
  }
  
  // Calculate plug amount (net income/loss)
  const plugAmount = Math.round((totalExpenses - totalIncome) * 100) / 100;
  
  // Add equity plug line if needed
  if (Math.abs(plugAmount) >= 0.01) {
    lines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: Math.abs(plugAmount).toFixed(2),
      Description: 'Monthly summary plug',
      JournalEntryLineDetail: {
        PostingType: plugAmount > 0 ? 'Credit' : 'Debit',
        AccountRef: { value: equityPlugAccountId },
        DepartmentRef: { value: propertyMapping.qbo_department_id }
      }
    });
  }
  
  // Generate doc number
  const yearMonth = periodEnd.substring(0, 7).replace('-', '');
  const docNumber = `MYAPP-${propertyCode}-${yearMonth}`;
  
  // Build payload
  const payload = {
    TxnDate: periodEnd, // Last day of month
    DocNumber: docNumber,
    PrivateNote: `Monthly summary for ${propertyCode} (${periodStart} to ${periodEnd}) - Property ID: ${propertyId}`,
    Line: lines
  };
  
  return {
    ok: true,
    payload,
    doc_number: docNumber,
    summary: {
      total_expenses: totalExpenses,
      total_income: totalIncome,
      plug_amount: plugAmount,
      line_count: lines.length,
      property_id: propertyId,
      period: { start: periodStart, end: periodEnd }
    },
    skipped_accounts: skippedAccounts.length > 0 ? skippedAccounts : undefined,
    warning: skippedAccounts.length > 0 
      ? `${skippedAccounts.length} account(s) were skipped because they are not mapped to QuickBooks` 
      : undefined
  };
}

/**
 * Build a delta (adjustment) journal entry
 * Used when totals have changed after initial push
 * @param {number} propertyId - Property ID
 * @param {string} periodStart - Period start date
 * @param {string} periodEnd - Period end date
 * @param {string} propertyCode - Short property code
 * @param {object} previousTotals - Previously pushed totals { account_code: amount }
 * @param {number} adjustmentNumber - Adjustment sequence (1, 2, etc.)
 * @returns {object} Delta journal entry payload
 */
export function buildDeltaJournalEntry(propertyId, periodStart, periodEnd, propertyCode, previousTotals, adjustmentNumber = 1) {
  // Get current totals
  const currentTotals = getPropertyMonthTotals(propertyId, periodStart, periodEnd);
  
  // Get mappings
  const propertyMapping = getQBOPropertyMapping(propertyId);
  const equityPlugAccountId = getEquityPlugAccount();
  
  if (!propertyMapping || !equityPlugAccountId) {
    return {
      ok: false,
      error: 'missing_mappings',
      message: 'Property or equity plug account mapping missing'
    };
  }
  
  // Calculate differences
  const currentMap = {};
  for (const total of currentTotals) {
    currentMap[total.account_code] = total.amount;
  }
  
  const deltaLines = [];
  let totalExpensesDelta = 0;
  let totalIncomeDelta = 0;
  
  // Find all accounts (union of previous and current)
  const allAccounts = new Set([
    ...Object.keys(previousTotals),
    ...Object.keys(currentMap)
  ]);
  
  for (const accountCode of allAccounts) {
    const previousAmount = previousTotals[accountCode] || 0;
    const currentAmount = currentMap[accountCode] || 0;
    const delta = currentAmount - previousAmount;
    
    if (Math.abs(delta) < 0.01) continue; // Skip negligible changes
    
    const accountMapping = getQBOAccountMapping(accountCode);
    if (!accountMapping) continue;
    
    // Find account type from current totals
    const accountInfo = currentTotals.find(t => t.account_code === accountCode);
    const isExpense = accountInfo?.type === 'EXPENSE';
    
    // Delta can be positive or negative
    const amount = Math.abs(delta);
    const postingType = (delta > 0) 
      ? (isExpense ? 'Debit' : 'Credit')
      : (isExpense ? 'Credit' : 'Debit');
    
    deltaLines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: amount.toFixed(2),
      Description: `${accountInfo?.account_name || accountCode} - Adjustment`,
      JournalEntryLineDetail: {
        PostingType: postingType,
        AccountRef: { value: accountMapping.qbo_account_id },
        DepartmentRef: { value: propertyMapping.qbo_department_id }
      }
    });
    
    if (isExpense) {
      totalExpensesDelta += (delta > 0 ? delta : -delta);
    } else {
      totalIncomeDelta += (delta > 0 ? delta : -delta);
    }
  }
  
  if (deltaLines.length === 0) {
    return {
      ok: false,
      error: 'no_changes',
      message: 'No differences found between current and previous totals'
    };
  }
  
  // Calculate plug delta
  const previousPlug = Object.values(previousTotals).reduce((sum, val) => sum + val, 0);
  const currentPlug = Object.values(currentMap).reduce((sum, val) => sum + val, 0);
  const plugDelta = Math.round((currentPlug - previousPlug) * 100) / 100;
  
  if (Math.abs(plugDelta) >= 0.01) {
    deltaLines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: Math.abs(plugDelta).toFixed(2),
      Description: 'Monthly summary plug - Adjustment',
      JournalEntryLineDetail: {
        PostingType: plugDelta > 0 ? 'Credit' : 'Debit',
        AccountRef: { value: equityPlugAccountId },
        DepartmentRef: { value: propertyMapping.qbo_department_id }
      }
    });
  }
  
  // Generate doc number with adjustment suffix
  const yearMonth = periodEnd.substring(0, 7).replace('-', '');
  const docNumber = `MYAPP-${propertyCode}-${yearMonth}-ADJ${adjustmentNumber}`;
  
  const payload = {
    TxnDate: periodEnd,
    DocNumber: docNumber,
    PrivateNote: `Adjustment ${adjustmentNumber} for ${propertyCode} (${periodStart} to ${periodEnd}) - Property ID: ${propertyId}`,
    Line: deltaLines
  };
  
  return {
    ok: true,
    payload,
    doc_number: docNumber,
    is_delta: true,
    adjustment_number: adjustmentNumber,
    summary: {
      line_count: deltaLines.length,
      plug_delta: plugDelta
    }
  };
}

/**
 * Validate all mappings exist for a property
 * @param {number} propertyId - Property ID
 * @returns {object} Validation result
 */
export function validatePropertyMappings(propertyId) {
  const propertyMapping = getQBOPropertyMapping(propertyId);
  
  if (!propertyMapping) {
    return {
      ok: false,
      error: 'missing_property_mapping',
      message: `Property ${propertyId} not mapped to QuickBooks Location`
    };
  }
  
  const equityPlugAccountId = getEquityPlugAccount();
  if (!equityPlugAccountId) {
    return {
      ok: false,
      error: 'missing_equity_plug',
      message: 'Equity plug account not configured'
    };
  }
  
  return {
    ok: true,
    property_mapping: propertyMapping,
    equity_plug_account: equityPlugAccountId
  };
}
