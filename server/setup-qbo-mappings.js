#!/usr/bin/env node

/**
 * QuickBooks Sync Setup - Add Default Mappings
 * Creates sample property and account mappings for testing
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH_1 = path.join(__dirname, 'data', 'bookkeeping', 'accounting.db');
const DB_PATH_2 = path.join(__dirname, 'data', 'bookkeeping.db');
const DB_PATH = fs.existsSync(DB_PATH_1) ? DB_PATH_1 : DB_PATH_2;

console.log('🔧 QuickBooks Sync - Setup Default Mappings');
console.log('=============================================\n');

try {
  const db = new Database(DB_PATH);
  
  // Insert or update property mapping (property_id 1 -> demo location)
  console.log('📍 Setting up property mapping...');
  const propertyMapping = db.prepare(`
    INSERT OR REPLACE INTO qbo_property_mappings 
    (property_id, qbo_department_id, qbo_department_name, is_active)
    VALUES (?, ?, ?, ?)
  `);
  
  propertyMapping.run(1, 'DEMO_LOC_123', 'Property 1 - Demo Location', 1);
  console.log('   ✅ Property 1 mapped to DEMO_LOC_123');
  
  // Set equity plug account
  console.log('\n💰 Setting up equity plug account...');
  const equityPlug = db.prepare(`
    INSERT OR REPLACE INTO qbo_config (id, config_key, config_value)
    VALUES (1, 'equity_plug_account_id', 'QBO_EQUITY_3000')
  `);
  equityPlug.run();
  console.log('   ✅ Equity plug account set to QBO_EQUITY_3000');
  
  // Map common revenue accounts
  console.log('\n💵 Mapping revenue accounts...');
  const revenueAccounts = [
    { code: '4000', qbo_id: 'QBO_REV_4000', name: 'Rent Income' },
    { code: '4010', qbo_id: 'QBO_REV_4010', name: 'Late Fees Income' },
    { code: '4020', qbo_id: 'QBO_REV_4020', name: 'Other Rental Income' }
  ];
  
  const accountMapping = db.prepare(`
    INSERT OR REPLACE INTO qbo_account_mappings 
    (account_code, qbo_account_id, qbo_account_name, is_active)
    VALUES (?, ?, ?, ?)
  `);
  
  revenueAccounts.forEach(acc => {
    accountMapping.run(acc.code, acc.qbo_id, acc.name, 1);
    console.log(`   ✅ ${acc.code} -> ${acc.name}`);
  });
  
  // Map common expense accounts
  console.log('\n💸 Mapping expense accounts...');
  const expenseAccounts = [
    { code: '5000', qbo_id: 'QBO_EXP_5000', name: 'Repairs & Maintenance' },
    { code: '5010', qbo_id: 'QBO_EXP_5010', name: 'Utilities' },
    { code: '5020', qbo_id: 'QBO_EXP_5020', name: 'Insurance' },
    { code: '5030', qbo_id: 'QBO_EXP_5030', name: 'Property Taxes' },
    { code: '5040', qbo_id: 'QBO_EXP_5040', name: 'Management Fees' },
    { code: '5050', qbo_id: 'QBO_EXP_5050', name: 'Mortgage Interest' },
    { code: '5060', qbo_id: 'QBO_EXP_5060', name: 'HOA/Condo Fees' },
    { code: '5070', qbo_id: 'QBO_EXP_5070', name: 'Advertising/Leasing' },
    { code: '5080', qbo_id: 'QBO_EXP_5080', name: 'Supplies' },
    { code: '5090', qbo_id: 'QBO_EXP_5090', name: 'Depreciation' }
  ];
  
  expenseAccounts.forEach(acc => {
    accountMapping.run(acc.code, acc.qbo_id, acc.name, 1);
    console.log(`   ✅ ${acc.code} -> ${acc.name}`);
  });
  
  // Verify mappings
  console.log('\n📊 Verification:');
  const accountCount = db.prepare('SELECT COUNT(*) as count FROM qbo_account_mappings').get();
  const propertyCount = db.prepare('SELECT COUNT(*) as count FROM qbo_property_mappings').get();
  console.log(`   - Account mappings: ${accountCount.count}`);
  console.log(`   - Property mappings: ${propertyCount.count}`);
  
  console.log('\n✅ Setup completed successfully!');
  console.log('\n⚠️  Note: These are DEMO mappings for testing.');
  console.log('In production, you should map to your actual QuickBooks account IDs.');
  console.log('\nYou can now:');
  console.log('1. Connect to QuickBooks');
  console.log('2. Try the sync preview');
  console.log('3. Update mappings to real QuickBooks IDs via the API\n');
  
  db.close();
  
} catch (error) {
  console.error('❌ Setup failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}
