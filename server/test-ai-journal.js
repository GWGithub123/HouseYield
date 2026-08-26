#!/usr/bin/env node

/**
 * Test AI-powered journal entry creation
 * Tests GPT-5 integration for natural language accounting
 */

const testCases = [
  {
    name: 'Cash Payment - Plumbing',
    description: 'paid $500 for plumbing repair at Sunset Villa'
  },
  {
    name: 'Rent Collection',
    description: 'received $2,450 rent payment from John Doe'
  },
  {
    name: 'Property Tax Accrual',
    description: 'accrue $1,200 quarterly property tax'
  },
  {
    name: 'Utility Bill',
    description: 'paid $285 electric bill for October'
  },
  {
    name: 'Late Fee Collection',
    description: 'collected $50 late fee from tenant'
  }
];

async function testAiJournal() {
  const baseUrl = 'http://localhost:3001';
  
  console.log('🤖 Testing AI Journal Entry Creation\n');
  console.log('=' .repeat(60));

  for (const test of testCases) {
    console.log(`\n📝 Test: ${test.name}`);
    console.log(`Input: "${test.description}"`);
    console.log('-'.repeat(60));

    try {
      const response = await fetch(`${baseUrl}/api/bookkeeping/journals/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: test.description,
          entry_date: new Date().toISOString().split('T')[0]
        })
      });

      const data = await response.json();

      if (data.ok) {
        console.log('✅ SUCCESS');
        console.log(`Journal Entry #${data.journal_entry_id}`);
        console.log(`Memo: ${data.ai_parsed.memo}`);
        console.log(`\nLines created: ${data.lines}`);
        
        data.ai_parsed.lines.forEach((line, idx) => {
          const symbol = line.dc === 'D' ? 'DR' : 'CR';
          console.log(`  ${idx + 1}. ${symbol} ${line.account_code} - $${line.amount.toFixed(2)}`);
          console.log(`     ${line.memo}`);
        });

        console.log(`\nBalance Check:`);
        console.log(`  Debits:  $${data.balance.debits.toFixed(2)}`);
        console.log(`  Credits: $${data.balance.credits.toFixed(2)}`);
        console.log(`  Status:  ${data.balance.isBalanced ? '✓ Balanced' : '✗ Unbalanced'}`);

      } else {
        console.log('❌ FAILED');
        console.log(`Error: ${data.error}`);
      }

    } catch (error) {
      console.log('❌ ERROR');
      console.log(error.message);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✨ AI Journal Entry Tests Complete!\n');
}

// Check if server is running
async function checkServer() {
  try {
    const response = await fetch('http://localhost:3001/health');
    return response.ok;
  } catch {
    return false;
  }
}

// Run tests
(async () => {
  const serverRunning = await checkServer();
  
  if (!serverRunning) {
    console.error('❌ Server not running on port 3001');
    console.error('Start it with: npm run server');
    process.exit(1);
  }

  await testAiJournal();
})();
