/**
 * Auto-Categorization Rules Engine
 * QuickBooks-style smart transaction categorization
 * Learns from user corrections and applies rules automatically
 */

import { getDb } from './connection.js';

/**
 * Get all active categorization rules
 */
export function getCategorizationRules() {
  const db = getDb();
  
  return db.prepare(`
    SELECT 
      pr.*,
      a.code as account_code,
      a.name as account_name
    FROM posting_rules pr
    LEFT JOIN accounts a ON a.code = SUBSTR(pr.posting_type, -4)
    WHERE pr.is_active = 1
    ORDER BY pr.priority ASC
  `).all();
}

/**
 * Create a new categorization rule
 * @param {Object} rule - Rule definition
 */
export function createRule(rule) {
  const db = getDb();
  
  const { 
    ruleName, 
    matchType, 
    matchPattern, 
    accountCode, 
    priority = 100,
    propertyId = null
  } = rule;
  
  // Validate account exists
  const account = db.prepare('SELECT * FROM accounts WHERE code = ?').get(accountCode);
  if (!account) {
    throw new Error(`Account ${accountCode} not found`);
  }
  
  const result = db.prepare(`
    INSERT INTO posting_rules (rule_name, match_type, match_pattern, posting_type, priority, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
  `).run(
    ruleName,
    matchType, // PAYEE, DESCRIPTION, AMOUNT, CATEGORY
    matchPattern,
    `EXPENSE:${accountCode}`, // posting_type format
    priority
  );
  
  return {
    ruleId: result.lastInsertRowid,
    ruleName,
    matchType,
    matchPattern,
    accountCode,
    accountName: account.name
  };
}

/**
 * Delete/deactivate a rule
 */
export function deactivateRule(ruleId) {
  const db = getDb();
  
  const result = db.prepare(`
    UPDATE posting_rules SET is_active = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(ruleId);
  
  return { deactivated: result.changes > 0 };
}

/**
 * Learn from user categorization
 * Creates or updates rules based on user corrections
 */
export function learnFromCategorization(payee, description, accountCode, amount = null) {
  const db = getDb();
  
  // Check if rule already exists for this payee
  const existingRule = db.prepare(`
    SELECT * FROM posting_rules 
    WHERE match_type = 'PAYEE' AND match_pattern = ? AND is_active = 1
  `).get(payee);
  
  if (existingRule) {
    // Update existing rule if account changed
    if (!existingRule.posting_type.includes(accountCode)) {
      db.prepare(`
        UPDATE posting_rules 
        SET posting_type = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(`EXPENSE:${accountCode}`, existingRule.id);
      
      return { action: 'updated', ruleId: existingRule.id };
    }
    return { action: 'unchanged', ruleId: existingRule.id };
  }
  
  // Create new rule for this payee
  const result = db.prepare(`
    INSERT INTO posting_rules (rule_name, match_type, match_pattern, posting_type, priority, is_active, created_at)
    VALUES (?, 'PAYEE', ?, ?, 50, 1, datetime('now'))
  `).run(
    `Auto: ${payee}`,
    payee,
    `EXPENSE:${accountCode}`
  );
  
  return { action: 'created', ruleId: result.lastInsertRowid };
}

/**
 * Apply rules to categorize a transaction
 * Returns the best matching account
 */
export function categorizeTransaction(transaction) {
  const db = getDb();
  
  const { payee, description, amount, category_hint } = transaction;
  
  // Get all active rules, ordered by priority
  const rules = db.prepare(`
    SELECT * FROM posting_rules 
    WHERE is_active = 1 
    ORDER BY priority ASC
  `).all();
  
  for (const rule of rules) {
    let matches = false;
    const pattern = rule.match_pattern.toLowerCase();
    
    switch (rule.match_type) {
      case 'PAYEE':
        matches = payee?.toLowerCase().includes(pattern);
        break;
      case 'DESCRIPTION':
        matches = description?.toLowerCase().includes(pattern);
        break;
      case 'CATEGORY':
        matches = category_hint?.toLowerCase().includes(pattern);
        break;
      case 'AMOUNT':
        // Amount rules: ">=100" or "<=50" or "100-500"
        if (pattern.includes('-')) {
          const [min, max] = pattern.split('-').map(Number);
          matches = amount >= min && amount <= max;
        } else if (pattern.startsWith('>=')) {
          matches = amount >= parseFloat(pattern.slice(2));
        } else if (pattern.startsWith('<=')) {
          matches = amount <= parseFloat(pattern.slice(2));
        }
        break;
    }
    
    if (matches) {
      // Extract account code from posting_type (e.g., "EXPENSE:5000" -> "5000")
      const accountCode = rule.posting_type.split(':')[1];
      const account = db.prepare('SELECT * FROM accounts WHERE code = ?').get(accountCode);
      
      return {
        matched: true,
        ruleId: rule.id,
        ruleName: rule.rule_name,
        accountCode,
        accountName: account?.name || 'Unknown',
        confidence: rule.priority <= 50 ? 'high' : rule.priority <= 100 ? 'medium' : 'low'
      };
    }
  }
  
  // No rule matched - use AI-based fallback categorization
  return suggestCategory(transaction);
}

/**
 * AI-based category suggestion when no rules match
 */
export function suggestCategory(transaction) {
  const { payee, description, amount } = transaction;
  const text = `${payee || ''} ${description || ''}`.toLowerCase();
  
  // Common expense patterns
  const patterns = [
    { pattern: /home\s*depot|lowes|hardware|lumber|plumb/i, code: '5000', name: 'Repairs & Maintenance' },
    { pattern: /electric|gas|water|utility|pge|sdge|power/i, code: '5010', name: 'Utilities' },
    { pattern: /insurance|geico|allstate|state\s*farm|liberty/i, code: '5020', name: 'Insurance' },
    { pattern: /tax|property\s*tax|county\s*treasurer/i, code: '5030', name: 'Property Taxes' },
    { pattern: /property\s*manage|hoa|association|condo\s*fee/i, code: '5040', name: 'Management Fees' },
    { pattern: /mortgage|loan|interest|bank\s*payment/i, code: '5050', name: 'Mortgage Interest' },
    { pattern: /clean|maid|janitorial|housekeep/i, code: '5000', name: 'Repairs & Maintenance' },
    { pattern: /advertising|zillow|apartments\.com|craigslist/i, code: '5070', name: 'Advertising' },
    { pattern: /office|staples|amazon|supply|supplies/i, code: '5080', name: 'Supplies' },
    { pattern: /uber|lyft|gas|mileage|travel|parking/i, code: '5100', name: 'Auto & Travel' },
    { pattern: /lawyer|attorney|legal|cpa|accountant/i, code: '5120', name: 'Legal & Professional' },
    { pattern: /rent|tenant|lease/i, code: '4000', name: 'Rent Income' }
  ];
  
  for (const { pattern, code, name } of patterns) {
    if (pattern.test(text)) {
      return {
        matched: false,
        suggested: true,
        accountCode: code,
        accountName: name,
        confidence: 'low',
        reason: `Matched pattern: ${pattern.source}`
      };
    }
  }
  
  // Default to Other Expenses
  return {
    matched: false,
    suggested: true,
    accountCode: '5999',
    accountName: 'Other Expenses',
    confidence: 'low',
    reason: 'No matching pattern found'
  };
}

/**
 * Get categorization statistics
 */
export function getCategorizationStats() {
  const db = getDb();
  
  const totalRules = db.prepare('SELECT COUNT(*) as count FROM posting_rules WHERE is_active = 1').get();
  
  const rulesByType = db.prepare(`
    SELECT match_type, COUNT(*) as count 
    FROM posting_rules 
    WHERE is_active = 1 
    GROUP BY match_type
  `).all();
  
  const recentMatches = db.prepare(`
    SELECT pr.rule_name, COUNT(*) as match_count
    FROM posting_rules pr
    JOIN bank_transactions bt ON bt.category_hint LIKE '%' || pr.match_pattern || '%'
    WHERE pr.is_active = 1 AND bt.is_posted = 1
    GROUP BY pr.id
    ORDER BY match_count DESC
    LIMIT 10
  `).all();
  
  return {
    totalActiveRules: totalRules.count,
    rulesByType,
    topMatchingRules: recentMatches
  };
}

/**
 * Bulk categorize unposted transactions
 */
export function bulkCategorize() {
  const db = getDb();
  
  const unposted = db.prepare(`
    SELECT * FROM bank_transactions 
    WHERE is_posted = 0 OR is_posted IS NULL
  `).all();
  
  const results = unposted.map(txn => {
    const categorization = categorizeTransaction({
      payee: txn.payee,
      description: txn.description,
      amount: Math.abs(txn.amount),
      category_hint: txn.category_hint
    });
    
    return {
      transactionId: txn.id,
      description: txn.description,
      amount: txn.amount,
      ...categorization
    };
  });
  
  return {
    total: unposted.length,
    categorized: results.filter(r => r.matched || r.suggested).length,
    results
  };
}
