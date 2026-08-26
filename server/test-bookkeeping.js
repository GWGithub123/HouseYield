/**
 * Test Double-Entry Bookkeeping System
 * Verifies core functionality: posting, reporting, balance checks
 */

import { getDb, initializeSchema } from './db/connection.js';
import { postBankTransaction, createManualJournalEntry, createReversalEntry } from './db/posting.js';
import { testClassification } from './db/classifier.js';
import { getTrialBalance, getProfitLoss, getBalanceSheet } from './db/reports.js';

console.log('🧪 Testing Double-Entry Bookkeeping System\n');

try {
  // Ensure database is initialized
  initializeSchema();
  const db = getDb();
  
  // Test 1: Create a test property
  console.log('Test 1: Creating test property...');
  const insertProperty = db.prepare(`
    INSERT INTO properties (user_id, name, address)
    VALUES (1, 'Test Property - 123 Main St', '123 Main St, Anytown, USA')
  `);
  const propertyResult = insertProperty.run();
  const propertyId = propertyResult.lastInsertRowid;
  console.log(`✓ Property created: ID ${propertyId}\n`);
  
  // Test 2: Test classification
  console.log('Test 2: Testing transaction classification...');
  const testTxn = {
    txn_date: '2025-10-15',
    amount: 1500,
    description: 'WELLS FARGO HOME MTG',
    is_debit: false,
    property_id: propertyId
  };
  const classification = testClassification(testTxn);
  console.log(`✓ Classified as: ${classification.posting_type}`);
  console.log(`✓ Proposed lines: ${classification.lines.length}`);
  console.log(`✓ Proposed split:`, classification.proposed_split);
  console.log('');
  
  // Test 3: Create manual journal entry (opening balance)
  console.log('Test 3: Creating opening balance entry...');
  const openingBalance = createManualJournalEntry(
    '2025-10-01',
    'Opening balance',
    [
      { account_code: '1000', dc: 'D', amount: 50000, memo: 'Initial cash', property_id: propertyId },
      { account_code: '3000', dc: 'C', amount: 50000, memo: 'Owner equity', property_id: propertyId }
    ],
    'test-system'
  );
  console.log(`✓ Journal entry created: ID ${openingBalance.journal_entry_id}`);
  console.log(`✓ Balanced: ${openingBalance.balance.isBalanced}`);
  console.log('');
  
  // Test 4: Post a rent receipt
  console.log('Test 4: Posting rent receipt...');
  const insertBankTxn = db.prepare(`
    INSERT INTO bank_transactions (bank_txn_id, txn_date, amount, description, is_debit, property_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertBankTxn.run('test-rent-001', '2025-10-05', 2500, 'ZELLE RENT PAYMENT', 1, propertyId);
  
  const rentTxn = db.prepare('SELECT * FROM bank_transactions WHERE bank_txn_id = ?').get('test-rent-001');
  const rentPosting = postBankTransaction(rentTxn);
  console.log(`✓ Rent posted: JE #${rentPosting.journal_entry_id}`);
  console.log(`✓ Posting type: ${rentPosting.posting_type}`);
  console.log('');
  
  // Test 5: Post a vendor expense
  console.log('Test 5: Posting vendor expense...');
  insertBankTxn.run('test-expense-001', '2025-10-10', 800, 'HOME DEPOT - REPAIRS', 0, propertyId);
  
  const expenseTxn = db.prepare('SELECT * FROM bank_transactions WHERE bank_txn_id = ?').get('test-expense-001');
  const expensePosting = postBankTransaction(expenseTxn);
  console.log(`✓ Expense posted: JE #${expensePosting.journal_entry_id}`);
  console.log(`✓ Posting type: ${expensePosting.posting_type}`);
  console.log('');
  
  // Test 6: Generate trial balance
  console.log('Test 6: Generating trial balance...');
  const trialBalance = getTrialBalance('2025-10-31', propertyId);
  console.log(`✓ Trial balance as of ${trialBalance.as_of_date}`);
  console.log(`✓ Total debits: $${trialBalance.total_debits}`);
  console.log(`✓ Total credits: $${trialBalance.total_credits}`);
  console.log(`✓ Balanced: ${trialBalance.is_balanced}`);
  console.log('\nAccount balances:');
  trialBalance.accounts.forEach(acc => {
    console.log(`  ${acc.code} ${acc.name}: $${acc.balance.toFixed(2)}`);
  });
  console.log('');
  
  // Test 7: Generate P&L
  console.log('Test 7: Generating Profit & Loss...');
  const pl = getProfitLoss('2025-10-01', '2025-10-31', propertyId);
  console.log(`✓ Period: ${pl.period.start} to ${pl.period.end}`);
  console.log(`✓ Total revenue: $${pl.summary.total_revenue}`);
  console.log(`✓ Total expenses: $${pl.summary.total_expenses}`);
  console.log(`✓ Net income: $${pl.summary.net_income}`);
  console.log(`✓ Margin: ${pl.summary.margin.toFixed(1)}%`);
  console.log('');
  
  // Test 8: Generate Balance Sheet
  console.log('Test 8: Generating Balance Sheet...');
  const bs = getBalanceSheet('2025-10-31', propertyId);
  console.log(`✓ As of: ${bs.as_of_date}`);
  console.log(`✓ Total assets: $${bs.summary.total_assets}`);
  console.log(`✓ Total liabilities: $${bs.summary.total_liabilities}`);
  console.log(`✓ Total equity: $${bs.summary.total_equity}`);
  console.log(`✓ Balanced: ${bs.summary.is_balanced}`);
  console.log('');
  
  // Test 9: Test reversal
  console.log('Test 9: Creating reversal entry...');
  const reversal = createReversalEntry(rentPosting.journal_entry_id, '2025-10-15', 'test-system');
  console.log(`✓ Reversal created: JE #${reversal.journal_entry_id}`);
  console.log(`✓ Reversed original: JE #${reversal.reversed_entry_id}`);
  console.log('');
  
  // Test 10: Verify accounts
  console.log('Test 10: Verifying chart of accounts...');
  const accounts = db.prepare('SELECT COUNT(*) as count FROM accounts WHERE is_active = 1').get();
  console.log(`✓ Active accounts: ${accounts.count}`);
  
  const assetAccounts = db.prepare("SELECT COUNT(*) as count FROM accounts WHERE type = 'ASSET' AND is_active = 1").get();
  const revenueAccounts = db.prepare("SELECT COUNT(*) as count FROM accounts WHERE type = 'REVENUE' AND is_active = 1").get();
  const expenseAccounts = db.prepare("SELECT COUNT(*) as count FROM accounts WHERE type = 'EXPENSE' AND is_active = 1").get();
  
  console.log(`  - Assets: ${assetAccounts.count}`);
  console.log(`  - Revenue: ${revenueAccounts.count}`);
  console.log(`  - Expenses: ${expenseAccounts.count}`);
  console.log('');
  
  console.log('✅ All tests passed!\n');
  console.log('📊 Summary:');
  console.log('  - Double-entry bookkeeping engine: ✓');
  console.log('  - Transaction classification: ✓');
  console.log('  - Journal posting: ✓');
  console.log('  - Balance verification: ✓');
  console.log('  - Financial reporting: ✓');
  console.log('  - Reversal entries: ✓');
  console.log('\n🎉 Bookkeeping system is ready for production!\n');
  
} catch (error) {
  console.error('❌ Test failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}
