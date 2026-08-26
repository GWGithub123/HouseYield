/**
 * Migration: Add Additional Tax-Ready Accounts
 * Run this to add new Schedule E expense categories to existing database
 */

import { getDb } from './connection.js';

export function addTaxAccounts() {
  const db = getDb();
  
  const newAccounts = [
    // Additional revenue accounts
    { code: '4030', name: 'Application Fees', type: 'REVENUE', normalSide: 'C', taxMap: 'Schedule E - Line 4 Other Income' },
    { code: '4040', name: 'Pet Fees', type: 'REVENUE', normalSide: 'C', taxMap: 'Schedule E - Line 4 Other Income' },
    
    // Additional expense accounts
    { code: '5100', name: 'Auto and Travel', type: 'EXPENSE', normalSide: 'D', taxMap: 'Schedule E - Line 6 Auto and Travel' },
    { code: '5110', name: 'Commissions', type: 'EXPENSE', normalSide: 'D', taxMap: 'Schedule E - Line 8 Commissions' },
    { code: '5120', name: 'Legal and Professional Fees', type: 'EXPENSE', normalSide: 'D', taxMap: 'Schedule E - Line 10 Legal Fees' },
    { code: '5130', name: 'Cleaning and Maintenance', type: 'EXPENSE', normalSide: 'D', taxMap: 'Schedule E - Line 7 Cleaning' },
    { code: '5999', name: 'Other Expenses', type: 'EXPENSE', normalSide: 'D', taxMap: 'Schedule E - Line 19 Other' }
  ];
  
  const stmt = db.prepare(`
    INSERT INTO accounts (code, name, type, normal_side, tax_map)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (code) DO UPDATE SET 
      tax_map = excluded.tax_map,
      name = excluded.name
  `);
  
  let added = 0;
  let updated = 0;
  
  for (const account of newAccounts) {
    try {
      const result = stmt.run(
        account.code,
        account.name,
        account.type,
        account.normalSide,
        account.taxMap
      );
      
      if (result.changes > 0) {
        console.log(`[Migration] Added/Updated account: ${account.code} - ${account.name}`);
        added++;
      }
    } catch (error) {
      console.error(`[Migration] Error with account ${account.code}:`, error.message);
    }
  }
  
  // Also update existing accounts with proper Schedule E line numbers
  const updateTaxMaps = [
    { code: '4000', taxMap: 'Schedule E - Line 3 Rents Received' },
    { code: '4010', taxMap: 'Schedule E - Line 4 Other Income' },
    { code: '4020', taxMap: 'Schedule E - Line 4 Other Income' },
    { code: '5000', taxMap: 'Schedule E - Line 14 Repairs' },
    { code: '5010', taxMap: 'Schedule E - Line 17 Utilities' },
    { code: '5020', taxMap: 'Schedule E - Line 9 Insurance' },
    { code: '5030', taxMap: 'Schedule E - Line 16 Taxes' },
    { code: '5040', taxMap: 'Schedule E - Line 11 Management Fees' },
    { code: '5050', taxMap: 'Schedule E - Line 12 Mortgage Interest' },
    { code: '5060', taxMap: 'Schedule E - Line 13 Other Interest' },
    { code: '5070', taxMap: 'Schedule E - Line 5 Advertising' },
    { code: '5080', taxMap: 'Schedule E - Line 15 Supplies' },
    { code: '5090', taxMap: 'Schedule E - Line 18 Depreciation' }
  ];
  
  const updateStmt = db.prepare(`
    UPDATE accounts SET tax_map = ? WHERE code = ?
  `);
  
  for (const update of updateTaxMaps) {
    try {
      const result = updateStmt.run(update.taxMap, update.code);
      if (result.changes > 0) {
        updated++;
      }
    } catch (error) {
      console.error(`[Migration] Error updating ${update.code}:`, error.message);
    }
  }
  
  console.log(`[Migration] Complete: ${added} accounts added, ${updated} tax mappings updated`);
  
  return { added, updated };
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  addTaxAccounts();
}
