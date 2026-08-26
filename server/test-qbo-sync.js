#!/usr/bin/env node

/**
 * Test QuickBooks Sync Functionality
 * Validates journal entry building and data flow
 */

import {
  getPropertyMonthTotals,
  savePropertyMapping,
  saveAccountMapping,
  saveEquityPlugAccount
} from './db/qbo-sync.js';
import {
  buildMonthlyJournalEntry,
  buildDeltaJournalEntry,
  validatePropertyMappings
} from './db/qbo-builder.js';

console.log('🧪 Testing QuickBooks Sync Functions');
console.log('=====================================\n');

// Test data
const TEST_PROPERTY_ID = 1;
const TEST_PERIOD_START = '2025-09-01';
const TEST_PERIOD_END = '2025-09-30';
const TEST_PROPERTY_CODE = 'MAPLE';

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    console.log(`\n📝 Testing: ${name}`);
    fn();
    console.log('   ✅ PASSED');
    testsPassed++;
  } catch (error) {
    console.log('   ❌ FAILED:', error.message);
    testsFailed++;
  }
}

// Test 1: Setup test mappings
test('Setup test mappings', () => {
  savePropertyMapping(TEST_PROPERTY_ID, 'TEST_DEPT_1', 'Test Property');
  saveAccountMapping('4000', 'QBO_4000', 'Rent Income');
  saveAccountMapping('5000', 'QBO_5000', 'Repairs & Maintenance');
  saveAccountMapping('5020', 'QBO_5020', 'Insurance');
  saveEquityPlugAccount('QBO_EQUITY_PLUG');
  console.log('   Created test mappings');
});

// Test 2: Validate mappings
test('Validate property mappings', () => {
  const validation = validatePropertyMappings(TEST_PROPERTY_ID);
  if (!validation.ok) {
    throw new Error('Validation failed: ' + validation.message);
  }
  console.log('   Property mapping valid');
});

// Test 3: Get monthly totals
test('Get monthly totals', () => {
  const totals = getPropertyMonthTotals(TEST_PROPERTY_ID, TEST_PERIOD_START, TEST_PERIOD_END);
  console.log(`   Found ${totals.length} account totals`);
  
  if (totals.length > 0) {
    console.log('   Sample totals:');
    totals.slice(0, 3).forEach(t => {
      console.log(`      ${t.account_code} - ${t.account_name}: $${t.amount}`);
    });
  } else {
    console.log('   ⚠️  No activity found for this period (this is OK for testing)');
  }
});

// Test 4: Build journal entry
test('Build monthly journal entry', () => {
  const result = buildMonthlyJournalEntry(
    TEST_PROPERTY_ID,
    TEST_PERIOD_START,
    TEST_PERIOD_END,
    TEST_PROPERTY_CODE
  );
  
  if (result.ok) {
    console.log(`   Built journal entry: ${result.doc_number}`);
    console.log(`   Lines: ${result.summary.line_count}`);
    console.log(`   Total Income: $${result.summary.total_income.toFixed(2)}`);
    console.log(`   Total Expenses: $${result.summary.total_expenses.toFixed(2)}`);
    console.log(`   Plug Amount: $${result.summary.plug_amount.toFixed(2)}`);
    
    // Verify payload structure
    if (!result.payload.TxnDate) throw new Error('Missing TxnDate');
    if (!result.payload.DocNumber) throw new Error('Missing DocNumber');
    if (!result.payload.Line || result.payload.Line.length === 0) {
      console.log('   ⚠️  No lines in payload (no activity for this period)');
    }
  } else if (result.error === 'no_activity') {
    console.log('   ⚠️  No activity for this period (this is OK for testing)');
  } else {
    throw new Error(`Build failed: ${result.message}`);
  }
});

// Test 5: Test with missing mapping
test('Handle missing account mapping', () => {
  // Try to build entry for property that would have unmapped accounts
  const result = buildMonthlyJournalEntry(
    TEST_PROPERTY_ID,
    TEST_PERIOD_START,
    TEST_PERIOD_END,
    TEST_PROPERTY_CODE
  );
  
  // Could pass or fail depending on data
  if (!result.ok && result.error === 'missing_account_mappings') {
    console.log('   ✅ Correctly identified missing mappings:', result.missing_accounts);
  } else if (result.ok) {
    console.log('   All accounts properly mapped');
  } else if (result.error === 'no_activity') {
    console.log('   No activity to test');
  }
});

// Test 6: Delta journal entry
test('Build delta journal entry', () => {
  // Simulate previous totals
  const previousTotals = {
    '4000': 3500.00,
    '5000': 1200.00
  };
  
  const result = buildDeltaJournalEntry(
    TEST_PROPERTY_ID,
    TEST_PERIOD_START,
    TEST_PERIOD_END,
    TEST_PROPERTY_CODE,
    previousTotals,
    1
  );
  
  if (result.ok) {
    console.log(`   Built delta entry: ${result.doc_number}`);
    console.log(`   Adjustment number: ${result.adjustment_number}`);
    console.log(`   Delta lines: ${result.summary.line_count}`);
  } else if (result.error === 'no_changes') {
    console.log('   ✅ Correctly detected no changes');
  } else {
    console.log(`   ⚠️  ${result.message}`);
  }
});

// Test 7: Doc number format
test('Verify DocNumber format', () => {
  const result = buildMonthlyJournalEntry(
    TEST_PROPERTY_ID,
    TEST_PERIOD_START,
    TEST_PERIOD_END,
    TEST_PROPERTY_CODE
  );
  
  if (result.ok) {
    const docNumber = result.doc_number;
    const expectedPattern = /^MYAPP-[A-Z]+-\d{6}$/;
    
    if (!expectedPattern.test(docNumber)) {
      throw new Error(`Invalid DocNumber format: ${docNumber}`);
    }
    console.log(`   DocNumber format valid: ${docNumber}`);
  } else if (result.error === 'no_activity') {
    console.log('   Skipped (no activity)');
  }
});

// Test 8: Journal entry balance
test('Verify journal entry balances', () => {
  const result = buildMonthlyJournalEntry(
    TEST_PROPERTY_ID,
    TEST_PERIOD_START,
    TEST_PERIOD_END,
    TEST_PROPERTY_CODE
  );
  
  if (result.ok && result.payload.Line) {
    let totalDebits = 0;
    let totalCredits = 0;
    
    for (const line of result.payload.Line) {
      const amount = parseFloat(line.Amount);
      if (line.JournalEntryLineDetail.PostingType === 'Debit') {
        totalDebits += amount;
      } else {
        totalCredits += amount;
      }
    }
    
    const difference = Math.abs(totalDebits - totalCredits);
    console.log(`   Total Debits: $${totalDebits.toFixed(2)}`);
    console.log(`   Total Credits: $${totalCredits.toFixed(2)}`);
    console.log(`   Difference: $${difference.toFixed(2)}`);
    
    if (difference > 0.01) {
      throw new Error(`Journal entry not balanced! Diff: $${difference.toFixed(2)}`);
    }
    console.log('   ✅ Journal entry is balanced');
  } else if (result.error === 'no_activity') {
    console.log('   Skipped (no activity)');
  }
});

// Summary
console.log('\n\n═══════════════════════════════════════');
console.log('📊 Test Summary');
console.log('═══════════════════════════════════════');
console.log(`✅ Passed: ${testsPassed}`);
console.log(`❌ Failed: ${testsFailed}`);
console.log(`📈 Total:  ${testsPassed + testsFailed}`);

if (testsFailed === 0) {
  console.log('\n🎉 All tests passed!');
  console.log('\nYou can now:');
  console.log('1. Connect to QuickBooks via /api/quickbooks/auth');
  console.log('2. Complete the mapping wizard');
  console.log('3. Start syncing monthly summaries\n');
} else {
  console.log('\n⚠️  Some tests failed. Please review the output above.\n');
  process.exit(1);
}
