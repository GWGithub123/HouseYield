/**
 * QuickBooks Online Sync Functions
 * Compute monthly totals and prepare data for pushing to QBO
 */

import { getDb } from './connection.js';

/**
 * Get monthly revenue totals by property and account
 * Returns: { property_id, account_code, amount }[]
 * If propertyId is null or 0, includes all transactions (even those without property_id)
 */
export function getMonthlyRevenueTotals(periodStart, periodEnd, propertyId = null) {
  const db = getDb();
  
  let query = `
    SELECT 
      COALESCE(jl.property_id, 1) as property_id,
      a.code AS account_code,
      a.name AS account_name,
      SUM(CASE WHEN jl.dc='C' THEN jl.amount ELSE -jl.amount END) AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type = 'REVENUE'
  `;
  
  const params = [periodStart, periodEnd];
  
  // If propertyId is provided and > 0, filter; otherwise include all (including NULL property_id)
  if (propertyId && propertyId > 0) {
    query += ` AND (jl.property_id = ? OR jl.property_id IS NULL)`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY COALESCE(jl.property_id, 1), a.code, a.name
    HAVING ABS(SUM(CASE WHEN jl.dc='C' THEN jl.amount ELSE -jl.amount END)) > 0.005
    ORDER BY property_id, a.code
  `;
  
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  
  // Round to 2 decimals for QBO
  return rows.map(row => ({
    property_id: row.property_id,
    account_code: row.account_code,
    account_name: row.account_name,
    amount: Math.round(parseFloat(row.amount) * 100) / 100
  }));
}

/**
 * Get monthly expense totals by property and account
 * Returns: { property_id, account_code, amount }[]
 * If propertyId is null or 0, includes all transactions (even those without property_id)
 */
export function getMonthlyExpenseTotals(periodStart, periodEnd, propertyId = null) {
  const db = getDb();
  
  let query = `
    SELECT 
      COALESCE(jl.property_id, 1) as property_id,
      a.code AS account_code,
      a.name AS account_name,
      SUM(CASE WHEN jl.dc='D' THEN jl.amount ELSE -jl.amount END) AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type = 'EXPENSE'
  `;
  
  const params = [periodStart, periodEnd];
  
  // If propertyId is provided and > 0, filter; otherwise include all (including NULL property_id)
  if (propertyId && propertyId > 0) {
    query += ` AND (jl.property_id = ? OR jl.property_id IS NULL)`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY COALESCE(jl.property_id, 1), a.code, a.name
    HAVING ABS(SUM(CASE WHEN jl.dc='D' THEN jl.amount ELSE -jl.amount END)) > 0.005
    ORDER BY property_id, a.code
  `;
  
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  
  // Round to 2 decimals for QBO
  return rows.map(row => ({
    property_id: row.property_id,
    account_code: row.account_code,
    account_name: row.account_name,
    amount: Math.round(parseFloat(row.amount) * 100) / 100
  }));
}

/**
 * Get combined monthly totals for a specific property
 * Returns: { account_code, account_name, type, amount }[]
 */
export function getPropertyMonthTotals(propertyId, periodStart, periodEnd) {
  const revenues = getMonthlyRevenueTotals(periodStart, periodEnd, propertyId);
  const expenses = getMonthlyExpenseTotals(periodStart, periodEnd, propertyId);
  
  const combined = [
    ...revenues.map(r => ({ ...r, type: 'REVENUE' })),
    ...expenses.map(e => ({ ...e, type: 'EXPENSE' }))
  ];
  
  return combined;
}

/**
 * Get all properties with activity in a given month
 */
export function getPropertiesWithActivity(periodStart, periodEnd) {
  const db = getDb();
  
  const query = `
    SELECT DISTINCT 
      p.id,
      p.name,
      p.address
    FROM properties p
    JOIN journal_lines jl ON jl.property_id = p.id
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.entry_date BETWEEN ? AND ?
    ORDER BY p.id
  `;
  
  const stmt = db.prepare(query);
  return stmt.all(periodStart, periodEnd);
}

/**
 * Get QBO property mapping
 */
export function getQBOPropertyMapping(propertyId) {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT * FROM qbo_property_mappings 
    WHERE property_id = ? AND is_active = TRUE
  `);
  
  return stmt.get(propertyId);
}

/**
 * Get QBO account mapping
 */
export function getQBOAccountMapping(accountCode) {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT * FROM qbo_account_mappings 
    WHERE account_code = ? AND is_active = TRUE
  `);
  
  return stmt.get(accountCode);
}

/**
 * Get all QBO account mappings
 */
export function getAllQBOAccountMappings() {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT * FROM qbo_account_mappings 
    WHERE is_active = TRUE
    ORDER BY account_code
  `);
  
  return stmt.all();
}

/**
 * Get equity plug account configuration
 */
export function getEquityPlugAccount() {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT config_value FROM qbo_config 
    WHERE config_key = 'equity_plug_account_id'
  `);
  
  const result = stmt.get();
  return result?.config_value || null;
}

/**
 * Save or update property mapping
 */
export function savePropertyMapping(propertyId, qboDepartmentId, qboDepartmentName) {
  const db = getDb();
  
  const stmt = db.prepare(`
    INSERT INTO qbo_property_mappings (property_id, qbo_department_id, qbo_department_name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (property_id) 
    DO UPDATE SET 
      qbo_department_id = excluded.qbo_department_id,
      qbo_department_name = excluded.qbo_department_name,
      is_active = TRUE,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  return stmt.run(propertyId, qboDepartmentId, qboDepartmentName);
}

/**
 * Save or update account mapping
 */
export function saveAccountMapping(accountCode, qboAccountId, qboAccountName) {
  const db = getDb();
  
  const stmt = db.prepare(`
    INSERT INTO qbo_account_mappings (account_code, qbo_account_id, qbo_account_name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (account_code) 
    DO UPDATE SET 
      qbo_account_id = excluded.qbo_account_id,
      qbo_account_name = excluded.qbo_account_name,
      is_active = TRUE,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  return stmt.run(accountCode, qboAccountId, qboAccountName);
}

/**
 * Save equity plug account configuration
 */
export function saveEquityPlugAccount(qboAccountId) {
  const db = getDb();
  
  const stmt = db.prepare(`
    INSERT INTO qbo_config (config_key, config_value, updated_at)
    VALUES ('equity_plug_account_id', ?, CURRENT_TIMESTAMP)
    ON CONFLICT (config_key) 
    DO UPDATE SET 
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  return stmt.run(qboAccountId);
}

/**
 * Check if a month has already been synced for a property
 */
export function getSyncLedgerEntry(propertyId, periodStart, periodEnd, docNumber) {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT * FROM qbo_sync_ledger 
    WHERE property_id = ? 
      AND period_start = ? 
      AND period_end = ?
      AND doc_number = ?
  `);
  
  return stmt.get(propertyId, periodStart, periodEnd, docNumber);
}

/**
 * Get all sync entries for a property in a given month
 * Can be called with either:
 * - (propertyId, period) where period is "YYYY-MM"
 * - (propertyId, periodStart, periodEnd) where dates are "YYYY-MM-DD"
 */
export function getPropertyMonthSyncs(propertyId, periodStartOrPeriod, periodEnd = null) {
  const db = getDb();
  
  let periodStart;
  let actualPeriodEnd;
  
  // If periodEnd is not provided, assume first arg is a YYYY-MM period string
  if (periodEnd === null && typeof periodStartOrPeriod === 'string' && periodStartOrPeriod.length === 7) {
    const [year, month] = periodStartOrPeriod.split('-').map(Number);
    periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    actualPeriodEnd = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  } else {
    periodStart = periodStartOrPeriod;
    actualPeriodEnd = periodEnd;
  }
  
  const stmt = db.prepare(`
    SELECT * FROM qbo_sync_ledger 
    WHERE property_id = ? 
      AND period_start = ? 
      AND period_end = ?
    ORDER BY created_at DESC
  `);
  
  return stmt.all(propertyId, periodStart, actualPeriodEnd);
}

/**
 * Save sync ledger entry
 */
export function saveSyncLedger(propertyId, periodStart, periodEnd, docNumber, qboJournalId, pushedTotals, pushedBy) {
  const db = getDb();
  
  const stmt = db.prepare(`
    INSERT INTO qbo_sync_ledger 
      (property_id, period_start, period_end, doc_number, qbo_journal_id, 
       pushed_totals_json, sync_status, pushed_at, pushed_by)
    VALUES (?, ?, ?, ?, ?, ?, 'success', CURRENT_TIMESTAMP, ?)
  `);
  
  return stmt.run(
    propertyId,
    periodStart,
    periodEnd,
    docNumber,
    qboJournalId,
    JSON.stringify(pushedTotals),
    pushedBy
  );
}

/**
 * Update sync status to failed
 */
export function markSyncFailed(propertyId, periodStart, periodEnd, docNumber, errorMessage) {
  const db = getDb();
  
  const stmt = db.prepare(`
    UPDATE qbo_sync_ledger 
    SET sync_status = 'failed',
        error_message = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE property_id = ? 
      AND period_start = ? 
      AND period_end = ?
      AND doc_number = ?
  `);
  
  return stmt.run(errorMessage, propertyId, periodStart, periodEnd, docNumber);
}
