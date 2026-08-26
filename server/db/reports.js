/**
 * Reporting and Query Engine
 * Financial reports: Trial Balance, P&L, Balance Sheet
 */

import { getDb } from './connection.js';

/**
 * Generate Trial Balance as of a date
 */
export function getTrialBalance(asOfDate, propertyId = null) {
  const db = getDb();
  
  let query = `
    SELECT 
      a.code,
      a.name,
      a.type,
      a.normal_side,
      SUM(CASE WHEN jl.dc = 'D' THEN jl.amount ELSE 0 END) AS debits,
      SUM(CASE WHEN jl.dc = 'C' THEN jl.amount ELSE 0 END) AS credits,
      SUM(
        CASE 
          WHEN a.normal_side = 'D' THEN 
            (CASE WHEN jl.dc = 'D' THEN jl.amount ELSE -jl.amount END)
          ELSE 
            (CASE WHEN jl.dc = 'C' THEN jl.amount ELSE -jl.amount END)
        END
      ) AS balance
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date <= ?
  `;
  
  const params = [asOfDate];
  
  if (propertyId) {
    query += ` AND jl.property_id = ?`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY a.code, a.name, a.type, a.normal_side
    HAVING ABS(balance) > 0.01
    ORDER BY a.code
  `;
  
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  
  // Calculate totals
  const totalDebits = rows.reduce((sum, row) => sum + parseFloat(row.debits), 0);
  const totalCredits = rows.reduce((sum, row) => sum + parseFloat(row.credits), 0);
  
  return {
    as_of_date: asOfDate,
    property_id: propertyId,
    accounts: rows,
    total_debits: totalDebits,
    total_credits: totalCredits,
    is_balanced: Math.abs(totalDebits - totalCredits) < 0.01
  };
}

/**
 * Generate Profit & Loss Statement
 */
export function getProfitLoss(startDate, endDate, propertyId = null) {
  const db = getDb();
  
  let query = `
    SELECT 
      a.type,
      a.code,
      a.name,
      a.tax_map,
      SUM(CASE WHEN jl.dc = 'D' THEN jl.amount ELSE -jl.amount END) AS net
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type IN ('REVENUE', 'EXPENSE')
  `;
  
  const params = [startDate, endDate];
  
  if (propertyId) {
    query += ` AND jl.property_id = ?`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY a.type, a.code, a.name, a.tax_map
    HAVING ABS(net) > 0.01
    ORDER BY a.type DESC, a.code
  `;
  
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  
  // Separate revenues and expenses
  const revenues = rows
    .filter(row => row.type === 'REVENUE')
    .map(row => ({
      code: row.code,
      name: row.name,
      tax_map: row.tax_map,
      amount: -parseFloat(row.net) // Revenues are negative net, flip for display
    }));
  
  const expenses = rows
    .filter(row => row.type === 'EXPENSE')
    .map(row => ({
      code: row.code,
      name: row.name,
      tax_map: row.tax_map,
      amount: parseFloat(row.net)
    }));
  
  const totalRevenue = revenues.reduce((sum, row) => sum + row.amount, 0);
  const totalExpenses = expenses.reduce((sum, row) => sum + row.amount, 0);
  const netIncome = totalRevenue - totalExpenses;
  
  return {
    period: { start: startDate, end: endDate },
    property_id: propertyId,
    revenues,
    expenses,
    summary: {
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      net_income: netIncome,
      margin: totalRevenue > 0 ? (netIncome / totalRevenue) * 100 : 0
    }
  };
}

/**
 * Generate Balance Sheet as of a date
 */
export function getBalanceSheet(asOfDate, propertyId = null) {
  const db = getDb();
  
  let query = `
    SELECT 
      a.type,
      a.code,
      a.name,
      SUM(CASE WHEN jl.dc = 'D' THEN jl.amount ELSE -jl.amount END) AS net
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date <= ?
      AND a.type IN ('ASSET', 'LIABILITY', 'EQUITY')
  `;
  
  const params = [asOfDate];
  
  if (propertyId) {
    query += ` AND jl.property_id = ?`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY a.type, a.code, a.name
    HAVING ABS(net) > 0.01
    ORDER BY a.type, a.code
  `;
  
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  
  // Separate by type
  const assets = rows
    .filter(row => row.type === 'ASSET')
    .map(row => ({
      code: row.code,
      name: row.name,
      amount: parseFloat(row.net)
    }));
  
  const liabilities = rows
    .filter(row => row.type === 'LIABILITY')
    .map(row => ({
      code: row.code,
      name: row.name,
      amount: -parseFloat(row.net) // Liabilities show as positive
    }));
  
  const equity = rows
    .filter(row => row.type === 'EQUITY')
    .map(row => ({
      code: row.code,
      name: row.name,
      amount: -parseFloat(row.net) // Equity shows as positive
    }));
  
  const totalAssets = assets.reduce((sum, row) => sum + row.amount, 0);
  const totalLiabilities = liabilities.reduce((sum, row) => sum + row.amount, 0);
  const totalEquity = equity.reduce((sum, row) => sum + row.amount, 0);
  
  return {
    as_of_date: asOfDate,
    property_id: propertyId,
    assets,
    liabilities,
    equity,
    summary: {
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      total_equity: totalEquity,
      is_balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
    }
  };
}

/**
 * Get cash flow trend by month
 */
export function getCashFlowTrend(months = 6, propertyId = null) {
  const db = getDb();
  
  const results = [];
  const today = new Date();
  
  for (let i = months - 1; i >= 0; i--) {
    const startDate = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const endDate = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
    
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    
    const pl = getProfitLoss(startStr, endStr, propertyId);
    
    results.push({
      month: startDate.toLocaleString('default', { month: 'long' }),
      year: startDate.getFullYear(),
      revenue: pl.summary.total_revenue,
      expenses: pl.summary.total_expenses,
      net_income: pl.summary.net_income
    });
  }
  
  return results;
}

/**
 * Get expense breakdown by category
 */
export function getExpenseBreakdown(startDate, endDate, propertyId = null, limit = 10) {
  const db = getDb();
  
  let query = `
    SELECT 
      a.code,
      a.name,
      a.tax_map,
      SUM(jl.amount) AS total
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type = 'EXPENSE'
      AND jl.dc = 'D'
  `;
  
  const params = [startDate, endDate];
  
  if (propertyId) {
    query += ` AND jl.property_id = ?`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY a.code, a.name, a.tax_map
    ORDER BY total DESC
    LIMIT ?
  `;
  
  params.push(limit);
  
  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get accounts receivable aging
 */
export function getARaging(asOfDate = null) {
  const db = getDb();
  
  const dateFilter = asOfDate || new Date().toISOString().split('T')[0];
  
  const query = `
    SELECT 
      ar.id,
      ar.issue_date,
      ar.due_date,
      ar.amount,
      ar.open_amount,
      t.name AS tenant_name,
      p.name AS property_name,
      JULIANDAY(?) - JULIANDAY(ar.due_date) AS days_overdue
    FROM ar_open_items ar
    JOIN tenants t ON t.id = ar.tenant_id
    JOIN properties p ON p.id = ar.property_id
    WHERE ar.is_paid = 0
      AND ar.open_amount > 0
    ORDER BY days_overdue DESC
  `;
  
  const stmt = db.prepare(query);
  const items = stmt.all(dateFilter);
  
  // Group by aging buckets
  const aging = {
    current: [],
    days_1_30: [],
    days_31_60: [],
    days_61_90: [],
    over_90: []
  };
  
  items.forEach(item => {
    const days = item.days_overdue;
    if (days <= 0) aging.current.push(item);
    else if (days <= 30) aging.days_1_30.push(item);
    else if (days <= 60) aging.days_31_60.push(item);
    else if (days <= 90) aging.days_61_90.push(item);
    else aging.over_90.push(item);
  });
  
  return aging;
}

/**
 * Get accounts payable aging
 */
export function getAPaging(asOfDate = null) {
  const db = getDb();
  
  const dateFilter = asOfDate || new Date().toISOString().split('T')[0];
  
  const query = `
    SELECT 
      ap.id,
      ap.vendor_name,
      ap.issue_date,
      ap.due_date,
      ap.amount,
      ap.open_amount,
      p.name AS property_name,
      JULIANDAY(?) - JULIANDAY(ap.due_date) AS days_overdue
    FROM ap_open_items ap
    JOIN properties p ON p.id = ap.property_id
    WHERE ap.is_paid = 0
      AND ap.open_amount > 0
    ORDER BY days_overdue DESC
  `;
  
  const stmt = db.prepare(query);
  return stmt.all(dateFilter);
}

/**
 * Get journal entries with filters
 */
export function getJournalEntries(filters = {}) {
  const db = getDb();
  
  let query = `
    SELECT 
      je.*,
      COUNT(jl.id) AS line_count,
      SUM(CASE WHEN jl.dc = 'D' THEN jl.amount ELSE 0 END) AS total_debits
    FROM journal_entries je
    LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
    WHERE 1=1
  `;
  
  const params = [];
  
  if (filters.startDate) {
    query += ` AND je.entry_date >= ?`;
    params.push(filters.startDate);
  }
  
  if (filters.endDate) {
    query += ` AND je.entry_date <= ?`;
    params.push(filters.endDate);
  }
  
  if (filters.source) {
    query += ` AND je.source = ?`;
    params.push(filters.source);
  }
  
  query += `
    GROUP BY je.id
    ORDER BY je.entry_date DESC, je.id DESC
    LIMIT ?
  `;
  
  params.push(filters.limit || 100);
  
  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get journal entry details with all lines
 */
export function getJournalEntryDetails(journalEntryId) {
  const db = getDb();
  
  const headerStmt = db.prepare(`
    SELECT * FROM journal_entries WHERE id = ?
  `);
  const header = headerStmt.get(journalEntryId);
  
  if (!header) {
    return null;
  }
  
  const linesStmt = db.prepare(`
    SELECT 
      jl.*,
      a.code AS account_code,
      a.name AS account_name,
      p.name AS property_name,
      t.name AS tenant_name
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN properties p ON p.id = jl.property_id
    LEFT JOIN tenants t ON t.id = jl.tenant_id
    WHERE jl.journal_entry_id = ?
    ORDER BY jl.id
  `);
  
  const lines = linesStmt.all(journalEntryId);
  
  return {
    ...header,
    lines
  };
}
