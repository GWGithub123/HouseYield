/**
 * Double-Entry Bookkeeping System
 * GAAP-compliant accounting for rental properties
 * Features: immutable journals, balanced entries, audit trail, property/tenant tracking
 * Tax Preparation: Schedule E reports, 1099 tracking, depreciation schedules
 * 
 * Enhanced with QuickBooks-style features:
 * - Bank Reconciliation
 * - Auto-categorization Rules
 * - Recurring Transactions
 * - Advanced Tax Calculator (TurboTax-style)
 */

import express from 'express';
import { getDb } from './db/connection.js';
import { postBankTransaction, createManualJournalEntry, createReversalEntry, postMonthlyDepreciation } from './db/posting.js';
import { testClassification, TAX_CATEGORIES } from './db/classifier.js';
import { 
  getTrialBalance, 
  getProfitLoss, 
  getBalanceSheet, 
  getCashFlowTrend,
  getExpenseBreakdown,
  getARaging,
  getAPaging,
  getJournalEntries,
  getJournalEntryDetails
} from './db/reports.js';
import {
  getTaxYearSummary,
  getScheduleE,
  getQuarterlyEstimate,
  getDepreciationSchedule,
  get1099Vendors,
  getCashVsAccrualComparison,
  getYearOverYearComparison,
  getTaxDocumentChecklist,
  exportTaxDataCSV,
  SCHEDULE_E_LINES
} from './db/tax-reports.js';

// New QuickBooks/TurboTax-style modules
import {
  startReconciliation,
  getBookBalance,
  getUnclearedItems,
  clearItems,
  unclearItems,
  completeReconciliation,
  getReconciliationHistory,
  getReconciliationStatus
} from './db/reconciliation.js';

import {
  getCategorizationRules,
  createRule,
  deactivateRule,
  learnFromCategorization,
  categorizeTransaction,
  bulkCategorize,
  getCategorizationStats
} from './db/categorization.js';

import {
  createRecurringTransaction,
  getRecurringTransactions,
  generateDueTransactions,
  updateRecurringTransaction,
  deleteRecurringTransaction,
  getUpcomingRecurring,
  RECURRING_TEMPLATES
} from './db/recurring.js';

import {
  calculateFederalTax,
  calculateTaxLiability,
  analyzePassiveLoss,
  findMissedDeductions,
  analyzeREProStatus
} from './db/tax-calculator.js';

const router = express.Router();


// ============================================================================
// WRITE ENDPOINTS (modify the books)
// ============================================================================

/**
 * POST /api/bookkeeping/journals/ai/receipt
 * AI-powered journal entry creation from receipt image
 * Uses GPT-5 Vision to analyze receipt and extract transaction details
 */
router.post('/journals/ai/receipt', async (req, res) => {
  try {
    const { image, entry_date } = req.body;
    
    if (!image) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: image (base64)'
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'OpenAI API key not configured'
      });
    }

    // Validate and normalize the image data URL
    let imageUrl = image;
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid image format. Image must be a data URL starting with data:image/'
      });
    }

    // Extract the MIME type to verify it's supported
    const mimeMatch = image.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,/);
    if (!mimeMatch) {
      return res.status(400).json({
        ok: false,
        error: 'Unsupported image format. Please use PNG, JPEG, GIF, or WEBP.'
      });
    }

    console.log('[AI Receipt] Analyzing receipt image... Format:', mimeMatch[1]);

    // Get chart of accounts for GPT context
    const db = getDb();
    const accounts = db.prepare(`
      SELECT code, name, type, normal_side 
      FROM accounts 
      ORDER BY code
    `).all();

    const accountsList = accounts.map(a => 
      `${a.code} - ${a.name} (${a.type}, normal: ${a.normal_side})`
    ).join('\n');

    // Call GPT-5 Vision to analyze the receipt
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',  // GPT-4o with vision
        messages: [
          {
            role: 'system',
            content: `You are an expert accountant analyzing receipts to create double-entry journal entries for a property management company.

CHART OF ACCOUNTS:
${accountsList}

TASK:
1. Read the receipt image and extract:
   - Vendor/merchant name
   - Date (if visible)
   - Total amount
   - Items purchased (to determine expense category)
   - Payment method (if visible)

2. Classify the expense using the Chart of Accounts above
3. Create a balanced journal entry

RULES:
- Cash payments: Debit expense account, Credit 1000 (Cash)
- Credit card: Debit expense account, Credit 2100 (Accounts Payable)
- Common categories:
  * Hardware store, plumbing, electrical → 5080 (Repairs & Maintenance)
  * Electric/Gas/Water bills → 5050 (Utilities)
  * Cleaning supplies → 5070 (Cleaning & Maintenance)
  * Office supplies → 5150 (Office Expense)
  * Property tax → 5030 (Property Tax)
  * Insurance → 5040 (Insurance)
  * Legal/Professional fees → 5120 (Professional Fees)
- Entry must balance (debits = credits)
- Return ONLY valid JSON, no markdown

RESPONSE FORMAT:
{
  "vendor": "Vendor name from receipt",
  "date": "YYYY-MM-DD if visible, else null",
  "amount": 123.45,
  "items_description": "Brief description of items purchased",
  "payment_method": "cash or credit card or unknown",
  "memo": "Generated transaction memo",
  "lines": [
    {"account_code": "XXXX", "dc": "D", "amount": 123.45, "memo": "Expense description"},
    {"account_code": "YYYY", "dc": "C", "amount": 123.45, "memo": "Payment method"}
  ]
}`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this receipt and create the journal entry:'
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        max_tokens: 1000,
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Receipt] OpenAI API error:', errorText);
      
      let errorMessage = 'Failed to analyze receipt with AI';
      try {
        const errorData = JSON.parse(errorText);
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
        }
      } catch (e) {
        // If we can't parse the error, use the raw text
      }
      
      return res.status(500).json({
        ok: false,
        error: errorMessage
      });
    }

    const data = await response.json();
    const aiResult = JSON.parse(data.choices[0].message.content);

    console.log('[AI Receipt] Extracted:', {
      vendor: aiResult.vendor,
      amount: aiResult.amount,
      category: aiResult.lines?.[0]?.account_code
    });

    // Validate the AI response
    if (!aiResult.lines || !Array.isArray(aiResult.lines)) {
      return res.status(500).json({
        ok: false,
        error: 'AI returned invalid response format'
      });
    }

    // Use the date from receipt if available, otherwise use provided date or today
    const useDate = aiResult.date || entry_date || new Date().toISOString().split('T')[0];
    
    // Create the journal entry
    const result = createManualJournalEntry(
      useDate,
      aiResult.memo || `${aiResult.vendor} - ${aiResult.items_description}`,
      aiResult.lines,
      'ai-receipt'
    );

    res.json({
      ok: true,
      ...result,
      ai_parsed: {
        vendor: aiResult.vendor,
        date: aiResult.date,
        amount: aiResult.amount,
        items: aiResult.items_description,
        payment_method: aiResult.payment_method,
        memo: aiResult.memo,
        lines: aiResult.lines
      },
      message: 'Receipt analyzed and journal entry created successfully'
    });

  } catch (error) {
    console.error('[AI Receipt] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/journals/ai
 * AI-powered journal entry creation from natural language
 * Example: "paid $500 for plumbing repair at Sunset Villa"
 */
router.post('/journals/ai', async (req, res) => {
  try {
    const { description, entry_date } = req.body;
    
    if (!description) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: description'
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'OpenAI API key not configured'
      });
    }

    // Get chart of accounts for GPT context
    const db = getDb();
    const accounts = db.prepare(`
      SELECT code, name, type, normal_side 
      FROM accounts 
      ORDER BY code
    `).all();

    const accountsList = accounts.map(a => 
      `${a.code} - ${a.name} (${a.type}, normal: ${a.normal_side})`
    ).join('\n');

    // Call GPT-5 to parse the transaction
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',  // Using latest GPT-4o model
        messages: [
          {
            role: 'system',
            content: `You are an expert accountant helping create double-entry journal entries for a property management company. 

CHART OF ACCOUNTS:
${accountsList}

RULES:
1. Every entry must balance (total debits = total credits)
2. Cash payments: Debit the expense/asset account, Credit 1000 (Cash)
3. Cash receipts: Debit 1000 (Cash), Credit the revenue/liability account
4. Accruals: Debit/Credit the appropriate expense/revenue and corresponding payable/receivable
5. Use account codes from the chart above
6. Always return valid JSON with no markdown formatting

Return ONLY a JSON object in this exact format:
{
  "memo": "Brief description of transaction",
  "lines": [
    {"account_code": "XXXX", "dc": "D", "amount": 123.45, "memo": "Line description"},
    {"account_code": "YYYY", "dc": "C", "amount": 123.45, "memo": "Line description"}
  ]
}`
          },
          {
            role: 'user',
            content: description
          }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Journal] OpenAI API error:', errorText);
      return res.status(500).json({
        ok: false,
        error: 'Failed to parse transaction with AI'
      });
    }

    const data = await response.json();
    const aiResult = JSON.parse(data.choices[0].message.content);

    // Validate the AI response
    if (!aiResult.lines || !Array.isArray(aiResult.lines)) {
      return res.status(500).json({
        ok: false,
        error: 'AI returned invalid response format'
      });
    }

    // Create the journal entry
    const useDate = entry_date || new Date().toISOString().split('T')[0];
    const result = createManualJournalEntry(
      useDate,
      aiResult.memo || description,
      aiResult.lines,
      'ai-assistant'
    );

    res.json({
      ok: true,
      ...result,
      ai_parsed: aiResult,
      message: 'AI journal entry created successfully'
    });

  } catch (error) {
    console.error('[AI Journal] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/journals
 * Create manual journal entries (adjustments, opening balances, reclasses)
 */
router.post('/journals', (req, res) => {
  try {
    const { entry_date, memo, lines, posted_by } = req.body;
    
    if (!entry_date || !lines || !Array.isArray(lines)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: entry_date, lines (array)'
      });
    }
    
    // Validate lines
    for (const line of lines) {
      if (!line.account_code || !line.dc || line.amount === undefined) {
        return res.status(400).json({
          ok: false,
          error: 'Each line must have: account_code, dc (D/C), amount'
        });
      }
    }
    
    const result = createManualJournalEntry(entry_date, memo, lines, posted_by || 'user');
    
    res.json({
      ok: true,
      ...result,
      message: 'Journal entry created successfully'
    });
  } catch (error) {
    console.error('[Bookkeeping] Error creating journal entry:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/banks/txns/:id/post
 * Post a bank transaction to the general ledger
 */
router.post('/banks/txns/:id/post', (req, res) => {
  try {
    const { id } = req.params;
    
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM bank_transactions WHERE id = ?');
    const txn = stmt.get(id);
    
    if (!txn) {
      return res.status(404).json({ ok: false, error: 'Bank transaction not found' });
    }
    
    if (txn.is_posted) {
      return res.status(400).json({ ok: false, error: 'Transaction already posted' });
    }
    
    const result = postBankTransaction(txn);
    
    res.json({
      ok: true,
      ...result,
      message: 'Transaction posted successfully'
    });
  } catch (error) {
    console.error('[Bookkeeping] Error posting transaction:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/rules/test
 * Dry-run classification engine on a transaction
 */
router.post('/rules/test', (req, res) => {
  try {
    const txn = req.body;
    
    if (!txn.amount || !txn.description) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: amount, description'
      });
    }
    
    const result = testClassification(txn);
    
    res.json({
      ok: true,
      ...result,
      message: 'Classification test complete'
    });
  } catch (error) {
    console.error('[Bookkeeping] Error testing classification:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/periods/:period/close
 * Close an accounting period
 */
router.post('/periods/:period/close', (req, res) => {
  try {
    const { period } = req.params;
    const { closed_by } = req.body;
    
    const db = getDb();
    
    // Parse period (YYYY-MM format)
    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0];
    
    // Check if period exists
    let stmt = db.prepare('SELECT * FROM periods WHERE period_start = ? AND period_end = ?');
    let periodRecord = stmt.get(periodStart, periodEnd);
    
    if (!periodRecord) {
      // Create period
      stmt = db.prepare(`
        INSERT INTO periods (period_start, period_end, is_closed, closed_by, closed_at)
        VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
      `);
      stmt.run(periodStart, periodEnd, closed_by || 'user');
    } else {
      // Update existing
      stmt = db.prepare(`
        UPDATE periods 
        SET is_closed = 1, closed_by = ?, closed_at = CURRENT_TIMESTAMP
        WHERE period_start = ? AND period_end = ?
      `);
      stmt.run(closed_by || 'user', periodStart, periodEnd);
    }
    
    res.json({
      ok: true,
      period: { start: periodStart, end: periodEnd },
      is_closed: true,
      message: `Period ${period} closed successfully`
    });
  } catch (error) {
    console.error('[Bookkeeping] Error closing period:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/periods/:period/open
 * Re-open a closed accounting period
 */
router.post('/periods/:period/open', (req, res) => {
  try {
    const { period } = req.params;
    
    const db = getDb();
    
    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0];
    
    const stmt = db.prepare(`
      UPDATE periods 
      SET is_closed = 0, closed_by = NULL, closed_at = NULL
      WHERE period_start = ? AND period_end = ?
    `);
    
    const result = stmt.run(periodStart, periodEnd);
    
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Period not found' });
    }
    
    res.json({
      ok: true,
      period: { start: periodStart, end: periodEnd },
      is_closed: false,
      message: `Period ${period} opened successfully`
    });
  } catch (error) {
    console.error('[Bookkeeping] Error opening period:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/journals/:id/reverse
 * Create a reversal entry
 */
router.post('/journals/:id/reverse', (req, res) => {
  try {
    const { id } = req.params;
    const { reversal_date, posted_by } = req.body;
    
    if (!reversal_date) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: reversal_date'
      });
    }
    
    const result = createReversalEntry(parseInt(id), reversal_date, posted_by || 'user');
    
    res.json({
      ok: true,
      ...result,
      message: 'Reversal entry created successfully'
    });
  } catch (error) {
    console.error('[Bookkeeping] Error creating reversal:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/depreciation/run
 * Post monthly depreciation for all active fixed assets
 */
router.post('/depreciation/run', (req, res) => {
  try {
    const { period_end, posted_by } = req.body;
    
    if (!period_end) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: period_end (YYYY-MM-DD)'
      });
    }
    
    const results = postMonthlyDepreciation(period_end, posted_by || 'system');
    
    res.json({
      ok: true,
      entries_created: results.length,
      results,
      message: `Posted depreciation for ${results.length} assets`
    });
  } catch (error) {
    console.error('[Bookkeeping] Error posting depreciation:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/properties
 * Create a new property for tracking
 */
router.post('/properties', (req, res) => {
  try {
    const { name, address, purchase_price, purchase_date, land_value, user_id } = req.body;
    
    if (!name || !address) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: name, address'
      });
    }
    
    const db = getDb();
    
    const result = db.prepare(`
      INSERT INTO properties (name, address, user_id, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(name, address, user_id || null);
    
    const propertyId = result.lastInsertRowid;
    
    // If purchase info provided, create a fixed asset for depreciation
    if (purchase_price && purchase_date) {
      const buildingValue = purchase_price - (land_value || 0);
      const lifeMonths = 330; // 27.5 years for residential rental property
      
      db.prepare(`
        INSERT INTO fixed_assets (
          property_id, description, cost, salvage, life_months,
          schedule, placed_in_service, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      `).run(
        propertyId,
        `Building - ${address}`,
        buildingValue,
        0, // No salvage value for buildings
        lifeMonths,
        'STRAIGHT_LINE',
        purchase_date
      );
    }
    
    res.json({
      ok: true,
      property_id: propertyId,
      message: 'Property created successfully'
    });
  } catch (error) {
    console.error('[Bookkeeping] Error creating property:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/fixed-assets
 * Add a fixed asset for depreciation tracking
 */
router.post('/fixed-assets', (req, res) => {
  try {
    const { 
      property_id, description, cost, salvage, 
      life_months, schedule, placed_in_service 
    } = req.body;
    
    if (!description || !cost || !placed_in_service) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: description, cost, placed_in_service'
      });
    }
    
    const db = getDb();
    
    const result = db.prepare(`
      INSERT INTO fixed_assets (
        property_id, description, cost, salvage, life_months,
        schedule, placed_in_service, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    `).run(
      property_id || null,
      description,
      cost,
      salvage || 0,
      life_months || 330, // Default 27.5 years
      schedule || 'STRAIGHT_LINE',
      placed_in_service
    );
    
    res.json({
      ok: true,
      asset_id: result.lastInsertRowid,
      message: 'Fixed asset created successfully'
    });
  } catch (error) {
    console.error('[Bookkeeping] Error creating fixed asset:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/fixed-assets
 * Get all fixed assets
 */
router.get('/fixed-assets', (req, res) => {
  try {
    const { property_id } = req.query;
    const db = getDb();
    
    let query = `
      SELECT fa.*, p.name as property_name, p.address as property_address
      FROM fixed_assets fa
      LEFT JOIN properties p ON p.id = fa.property_id
      WHERE fa.is_active = 1
    `;
    const params = [];
    
    if (property_id) {
      query += ' AND fa.property_id = ?';
      params.push(parseInt(property_id));
    }
    
    query += ' ORDER BY fa.placed_in_service DESC';
    
    const assets = db.prepare(query).all(...params);
    
    res.json({
      ok: true,
      assets,
      count: assets.length
    });
  } catch (error) {
    console.error('[Bookkeeping] Error fetching fixed assets:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/bank-transactions/unposted
 * Get bank transactions that haven't been posted to journal entries
 */
router.get('/bank-transactions/unposted', (req, res) => {
  try {
    const db = getDb();
    
    const unposted = db.prepare(`
      SELECT bt.* 
      FROM bank_transactions bt
      WHERE bt.is_posted = 0 OR bt.is_posted IS NULL
      ORDER BY bt.txn_date DESC
      LIMIT 100
    `).all();
    
    res.json({
      ok: true,
      transactions: unposted,
      count: unposted.length
    });
  } catch (error) {
    console.error('[Bookkeeping] Error fetching unposted transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/bank-transactions/post-all
 * Post all unposted bank transactions to journal entries
 */
router.post('/bank-transactions/post-all', async (req, res) => {
  try {
    const db = getDb();
    
    // Get all unposted transactions
    const unposted = db.prepare(`
      SELECT * FROM bank_transactions
      WHERE is_posted = 0 OR is_posted IS NULL
      ORDER BY txn_date
    `).all();
    
    if (unposted.length === 0) {
      return res.json({
        ok: true,
        message: 'No unposted transactions found',
        posted: 0
      });
    }
    
    let posted = 0;
    const errors = [];
    
    for (const txn of unposted) {
      try {
        // Create transaction object for posting
        const txnForPosting = {
          bank_txn_id: txn.bank_txn_id,
          txn_date: txn.txn_date,
          amount: parseFloat(txn.amount),
          description: txn.description,
          payee: txn.payee,
          is_debit: txn.is_debit === 1,
          property_id: txn.property_id,
          category_hint: txn.category_hint
        };
        
        const result = postBankTransaction(txnForPosting);
        posted++;
        console.log(`[Bookkeeping] Posted bank transaction ${txn.bank_txn_id} -> Journal Entry #${result.journal_entry_id}`);
      } catch (postError) {
        errors.push({
          bank_txn_id: txn.bank_txn_id,
          description: txn.description,
          error: postError.message
        });
      }
    }
    
    res.json({
      ok: true,
      total: unposted.length,
      posted,
      errors: errors.length > 0 ? errors : undefined,
      message: `Posted ${posted} of ${unposted.length} transactions`
    });
  } catch (error) {
    console.error('[Bookkeeping] Error posting bank transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// READ ENDPOINTS (reports/queries)
// ============================================================================

/**
 * GET /api/bookkeeping/reports/trial-balance
 * Trial balance as of a date
 */
router.get('/reports/trial-balance', (req, res) => {
  try {
    const { as_of, property_id } = req.query;
    
    if (!as_of) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required parameter: as_of (YYYY-MM-DD)'
      });
    }
    
    const result = getTrialBalance(as_of, property_id ? parseInt(property_id) : null);
    
    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating trial balance:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reports/pl
 * Profit & Loss statement
 */
router.get('/reports/pl', (req, res) => {
  try {
    const { start, end, property_id } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required parameters: start, end (YYYY-MM-DD)'
      });
    }
    
    const result = getProfitLoss(start, end, property_id ? parseInt(property_id) : null);
    
    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating P&L:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reports/balance-sheet
 * Balance sheet as of a date
 */
router.get('/reports/balance-sheet', (req, res) => {
  try {
    const { as_of, property_id } = req.query;
    
    if (!as_of) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required parameter: as_of (YYYY-MM-DD)'
      });
    }
    
    const result = getBalanceSheet(as_of, property_id ? parseInt(property_id) : null);
    
    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating balance sheet:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reports/cashflow-trend
 * Monthly cash flow trend
 */
router.get('/reports/cashflow-trend', (req, res) => {
  try {
    const { months = 6, property_id } = req.query;
    
    const result = getCashFlowTrend(
      parseInt(months), 
      property_id ? parseInt(property_id) : null
    );
    
    res.json({
      ok: true,
      trend: result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating cash flow trend:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reports/expense-breakdown
 * Expense breakdown by category
 */
router.get('/reports/expense-breakdown', (req, res) => {
  try {
    const { start, end, property_id, limit = 10 } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required parameters: start, end (YYYY-MM-DD)'
      });
    }
    
    const result = getExpenseBreakdown(
      start, 
      end, 
      property_id ? parseInt(property_id) : null,
      parseInt(limit)
    );
    
    res.json({
      ok: true,
      categories: result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating expense breakdown:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reports/ar-aging
 * Accounts receivable aging report
 */
router.get('/reports/ar-aging', (req, res) => {
  try {
    const { as_of } = req.query;
    
    const result = getARaging(as_of);
    
    res.json({
      ok: true,
      aging: result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating AR aging:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reports/ap-aging
 * Accounts payable aging report
 */
router.get('/reports/ap-aging', (req, res) => {
  try {
    const { as_of } = req.query;
    
    const result = getAPaging(as_of);
    
    res.json({
      ok: true,
      aging: result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating AP aging:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/journals
 * Get journal entries with filters
 */
router.get('/journals', (req, res) => {
  try {
    const { start_date, end_date, source, limit = 100 } = req.query;
    
    const filters = {
      startDate: start_date,
      endDate: end_date,
      source,
      limit: parseInt(limit)
    };
    
    const result = getJournalEntries(filters);
    
    res.json({
      ok: true,
      journal_entries: result,
      count: result.length
    });
  } catch (error) {
    console.error('[Bookkeeping] Error fetching journal entries:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/journals/:id
 * Get journal entry details with all lines
 */
router.get('/journals/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    const result = getJournalEntryDetails(parseInt(id));
    
    if (!result) {
      return res.status(404).json({ ok: false, error: 'Journal entry not found' });
    }
    
    res.json({
      ok: true,
      journal_entry: result
    });
  } catch (error) {
    console.error('[Bookkeeping] Error fetching journal entry:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/accounts
 * Get chart of accounts
 */
router.get('/accounts', (req, res) => {
  try {
    const { type, is_active = true } = req.query;
    
    const db = getDb();
    
    let query = 'SELECT * FROM accounts WHERE 1=1';
    const params = [];
    
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    
    if (is_active !== undefined) {
      query += ' AND is_active = ?';
      params.push(is_active === 'true' ? 1 : 0);
    }
    
    query += ' ORDER BY code';
    
    const stmt = db.prepare(query);
    const accounts = stmt.all(...params);
    
    res.json({
      ok: true,
      accounts,
      count: accounts.length
    });
  } catch (error) {
    console.error('[Bookkeeping] Error fetching accounts:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/properties
 * Get all properties
 */
router.get('/properties', (req, res) => {
  try {
    const { user_id } = req.query;
    
    const db = getDb();
    
    let query = 'SELECT * FROM properties WHERE 1=1';
    const params = [];
    
    if (user_id) {
      query += ' AND user_id = ?';
      params.push(user_id);
    }
    
    query += ' ORDER BY name';
    
    const stmt = db.prepare(query);
    const properties = stmt.all(...params);
    
    res.json({
      ok: true,
      properties,
      count: properties.length
    });
  } catch (error) {
    console.error('[Bookkeeping] Error fetching properties:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/summary
 * Legacy endpoint - now uses P&L calculation
 */
router.get('/summary', (req, res) => {
  try {
    const { startDate, endDate, propertyId } = req.query;
    
    // Default to current month if not specified
    const today = new Date();
    const start = startDate || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const end = endDate || today.toISOString().split('T')[0];
    
    const pl = getProfitLoss(start, end, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      summary: {
        totalIncome: pl.summary.total_revenue,
        totalExpenses: pl.summary.total_expenses,
        netIncome: pl.summary.net_income,
        netCashFlow: pl.summary.net_income, // Alias for compatibility
        margin: pl.summary.margin.toFixed(1),
        currency: 'USD'
      },
      source: 'double-entry'
    });
  } catch (error) {
    console.error('[Bookkeeping] Error generating summary:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/transactions
 * Get transactions from journal entries
 */
router.get('/transactions', (req, res) => {
  try {
    const { limit = 50, startDate, endDate, propertyId } = req.query;
    
    const db = getDb();
    
    let query = `
      SELECT 
        je.id,
        je.entry_date as date,
        je.memo as description,
        a.name as category,
        a.type,
        jl.amount,
        jl.dc,
        je.source as status
      FROM journal_entries je
      JOIN journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounts a ON a.id = jl.account_id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (startDate) {
      query += ` AND je.entry_date >= ?`;
      params.push(startDate);
    }
    
    if (endDate) {
      query += ` AND je.entry_date <= ?`;
      params.push(endDate);
    }
    
    if (propertyId) {
      query += ` AND jl.property_id = ?`;
      params.push(parseInt(propertyId));
    }
    
    query += `
      ORDER BY je.entry_date DESC, je.id DESC
      LIMIT ?
    `;
    params.push(parseInt(limit));
    
    const stmt = db.prepare(query);
    const rows = stmt.all(...params);
    
    // Transform to match expected format
    const transactions = rows.map(row => ({
      id: row.id,
      date: row.date,
      description: row.description || row.category,
      category: row.category,
      type: row.type === 'REVENUE' ? 'Income' : 'Expense',
      amount: parseFloat(row.amount),
      status: row.status === 'BANK' ? 'Cleared' : 'Posted'
    }));
    
    res.json({
      ok: true,
      transactions,
      total: transactions.length,
      source: 'native-bookkeeping'
    });
    
  } catch (error) {
    console.error('[Bookkeeping] Error fetching transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/categories
 * Get expense categories breakdown
 */
router.get('/categories', (req, res) => {
  try {
    const { startDate, endDate, propertyId } = req.query;
    
    const today = new Date();
    const start = startDate || new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0]; // Default to YTD
    const end = endDate || today.toISOString().split('T')[0];
    
    const breakdown = getExpenseBreakdown(start, end, propertyId ? parseInt(propertyId) : null);
    
    // Transform to expected format with name and amount
    const categories = breakdown.map(item => ({
      name: item.name,
      code: item.code,
      amount: parseFloat(item.total || 0),
      tax_map: item.tax_map
    }));
    
    res.json({
      ok: true,
      categories,
      source: 'native-bookkeeping'
    });
    
  } catch (error) {
    console.error('[Bookkeeping] Error fetching categories:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/cashflow-trend
 * Get cash flow trend data
 */
router.get('/cashflow-trend', (req, res) => {
  try {
    const { months = 6, propertyId, property_id } = req.query;
    const scopedPropertyId = propertyId || property_id;
    
    const trend = getCashFlowTrend(
      parseInt(months),
      scopedPropertyId ? parseInt(scopedPropertyId) : null
    );
    
    // Transform to include cashFlow for compatibility
    const trendWithCashFlow = trend.map(item => ({
      ...item,
      cashFlow: item.net_income // Add cashFlow alias for frontend compatibility
    }));
    
    res.json({
      ok: true,
      trend: trendWithCashFlow,
      source: 'native-bookkeeping'
    });
    
  } catch (error) {
    console.error('[Bookkeeping] Error fetching cashflow trend:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/upcoming-bills
 * Get upcoming bills from AP aging
 */
router.get('/upcoming-bills', (req, res) => {
  try {
    const asOf = new Date().toISOString().split('T')[0];
    const aging = getAPaging(asOf);
    
    // Transform AP items to "upcoming bills" format
    const upcomingBills = (aging || [])
      .filter(item => !item.is_paid)
      .slice(0, 5)
      .map(item => ({
        description: `${item.vendor_name} - Invoice`,
        dueDate: item.due_date,
        amount: parseFloat(item.open_amount),
        category: 'Accounts Payable'
      }));
    
    res.json({
      ok: true,
      upcomingBills,
      source: 'native-bookkeeping'
    });
    
  } catch (error) {
    console.error('[Bookkeeping] Error fetching upcoming bills:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// TAX PREPARATION ENDPOINTS
// ============================================================================

/**
 * GET /api/bookkeeping/tax/year-summary
 * Get comprehensive tax year summary
 */
router.get('/tax/year-summary', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const summary = getTaxYearSummary(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      ...summary
    });
  } catch (error) {
    console.error('[Tax Reports] Error generating year summary:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/schedule-e
 * Generate Schedule E (Supplemental Income and Loss) report
 */
router.get('/tax/schedule-e', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const scheduleE = getScheduleE(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      ...scheduleE
    });
  } catch (error) {
    console.error('[Tax Reports] Error generating Schedule E:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/depreciation-schedule
 * Get depreciation schedule for tax purposes
 */
router.get('/tax/depreciation-schedule', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const schedule = getDepreciationSchedule(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      ...schedule
    });
  } catch (error) {
    console.error('[Tax Reports] Error generating depreciation schedule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/1099-vendors
 * Get vendors requiring 1099 forms (paid over $600)
 */
router.get('/tax/1099-vendors', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const vendors = get1099Vendors(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      ...vendors
    });
  } catch (error) {
    console.error('[Tax Reports] Error getting 1099 vendors:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/cash-vs-accrual
 * Compare cash vs accrual accounting methods
 */
router.get('/tax/cash-vs-accrual', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const comparison = getCashVsAccrualComparison(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      ...comparison
    });
  } catch (error) {
    console.error('[Tax Reports] Error comparing cash vs accrual:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/year-over-year
 * Get year-over-year comparison
 */
router.get('/tax/year-over-year', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const comparison = getYearOverYearComparison(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      ...comparison
    });
  } catch (error) {
    console.error('[Tax Reports] Error generating year-over-year comparison:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/document-checklist
 * Get tax document checklist and status
 */
router.get('/tax/document-checklist', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const checklist = getTaxDocumentChecklist(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.json({
      ok: true,
      ...checklist
    });
  } catch (error) {
    console.error('[Tax Reports] Error generating document checklist:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/export-csv
 * Export tax data as CSV for tax software import
 */
router.get('/tax/export-csv', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const csvData = exportTaxDataCSV(taxYear, propertyId ? parseInt(propertyId) : null);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="schedule-e-${taxYear}.csv"`);
    res.send(csvData);
  } catch (error) {
    console.error('[Tax Reports] Error exporting CSV:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/categories
 * Get tax category mappings (Schedule E lines)
 */
router.get('/tax/categories', (req, res) => {
  try {
    res.json({
      ok: true,
      categories: TAX_CATEGORIES,
      scheduleELines: SCHEDULE_E_LINES
    });
  } catch (error) {
    console.error('[Tax Reports] Error getting tax categories:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/dashboard
 * Get comprehensive tax dashboard data
 */
router.get('/tax/dashboard', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    const propId = propertyId ? parseInt(propertyId) : null;
    
    // Gather all tax data for dashboard
    const yearSummary = getTaxYearSummary(taxYear, propId);
    const scheduleE = getScheduleE(taxYear, propId);
    const depreciation = getDepreciationSchedule(taxYear, propId);
    const vendors1099 = get1099Vendors(taxYear, propId);
    const yearOverYear = getYearOverYearComparison(taxYear, propId);
    const checklist = getTaxDocumentChecklist(taxYear, propId);
    
    // Current quarter estimate
    const currentQuarter = Math.ceil((new Date().getMonth() + 1) / 3);
    const quarterlyEstimate = getQuarterlyEstimate(taxYear, currentQuarter, propId);
    
    res.json({
      ok: true,
      taxYear,
      propertyId: propId,
      yearSummary: yearSummary.summary,
      scheduleESummary: scheduleE.summary,
      depreciation: depreciation.summary,
      vendors1099: vendors1099.summary,
      yearOverYear: yearOverYear.changes,
      quarterlyEstimate: quarterlyEstimate.estimatedTax,
      documentChecklist: checklist.summary,
      upcomingDeadlines: [
        { 
          form: 'Form 1099-NEC', 
          dueDate: `${taxYear + 1}-01-31`,
          description: 'Contractor payments over $600' 
        },
        { 
          form: 'Form 1040 + Schedule E', 
          dueDate: `${taxYear + 1}-04-15`,
          description: 'Individual tax return with rental income' 
        },
        { 
          form: 'Q1 Estimated Tax', 
          dueDate: `${taxYear}-04-15`,
          description: 'Quarterly estimated payment' 
        }
      ]
    });
  } catch (error) {
    console.error('[Tax Reports] Error generating tax dashboard:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// BANK RECONCILIATION ENDPOINTS (QuickBooks-style)
// ============================================================================

/**
 * POST /api/bookkeeping/reconciliation/start
 * Start a new bank reconciliation
 */
router.post('/reconciliation/start', (req, res) => {
  try {
    const { accountCode, statementDate, statementBalance } = req.body;
    
    if (!accountCode || !statementDate || statementBalance === undefined) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: accountCode, statementDate, statementBalance'
      });
    }
    
    const result = startReconciliation(accountCode, statementDate, parseFloat(statementBalance));
    
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Reconciliation] Error starting reconciliation:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reconciliation/status/:accountCode
 * Get reconciliation status for an account
 */
router.get('/reconciliation/status/:accountCode', (req, res) => {
  try {
    const { accountCode } = req.params;
    const status = getReconciliationStatus(accountCode);
    res.json({ ok: true, ...status });
  } catch (error) {
    console.error('[Reconciliation] Error getting status:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reconciliation/uncleared/:accountCode
 * Get uncleared items for an account
 */
router.get('/reconciliation/uncleared/:accountCode', (req, res) => {
  try {
    const { accountCode } = req.params;
    const { asOf } = req.query;
    const date = asOf || new Date().toISOString().split('T')[0];
    
    const items = getUnclearedItems(accountCode, date);
    const balance = getBookBalance(accountCode, date);
    
    res.json({ ok: true, items, bookBalance: balance, count: items.length });
  } catch (error) {
    console.error('[Reconciliation] Error getting uncleared items:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/reconciliation/clear
 * Mark items as cleared
 */
router.post('/reconciliation/clear', (req, res) => {
  try {
    const { lineIds, statementId } = req.body;
    
    if (!Array.isArray(lineIds) || !statementId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: lineIds (array), statementId'
      });
    }
    
    const result = clearItems(lineIds, statementId);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Reconciliation] Error clearing items:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/reconciliation/complete
 * Complete a reconciliation
 */
router.post('/reconciliation/complete', (req, res) => {
  try {
    const { statementId, reconciledBy } = req.body;
    
    if (!statementId) {
      return res.status(400).json({ ok: false, error: 'Missing statementId' });
    }
    
    const result = completeReconciliation(statementId, reconciledBy);
    res.json(result);
  } catch (error) {
    console.error('[Reconciliation] Error completing reconciliation:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/reconciliation/history/:accountCode
 * Get reconciliation history
 */
router.get('/reconciliation/history/:accountCode', (req, res) => {
  try {
    const { accountCode } = req.params;
    const history = getReconciliationHistory(accountCode);
    res.json({ ok: true, history });
  } catch (error) {
    console.error('[Reconciliation] Error getting history:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// AUTO-CATEGORIZATION ENDPOINTS (QuickBooks-style)
// ============================================================================

/**
 * GET /api/bookkeeping/rules
 * Get all categorization rules
 */
router.get('/rules', (req, res) => {
  try {
    const rules = getCategorizationRules();
    res.json({ ok: true, rules, count: rules.length });
  } catch (error) {
    console.error('[Categorization] Error getting rules:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/rules
 * Create a new categorization rule
 */
router.post('/rules', (req, res) => {
  try {
    const { ruleName, matchType, matchPattern, accountCode, priority } = req.body;
    
    if (!ruleName || !matchType || !matchPattern || !accountCode) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: ruleName, matchType, matchPattern, accountCode'
      });
    }
    
    const result = createRule({ ruleName, matchType, matchPattern, accountCode, priority });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Categorization] Error creating rule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/bookkeeping/rules/:id
 * Deactivate a categorization rule
 */
router.delete('/rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = deactivateRule(parseInt(id));
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Categorization] Error deactivating rule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/categorize
 * Categorize a single transaction
 */
router.post('/categorize', (req, res) => {
  try {
    const transaction = req.body;
    const result = categorizeTransaction(transaction);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Categorization] Error categorizing:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/categorize/bulk
 * Bulk categorize unposted transactions
 */
router.post('/categorize/bulk', (req, res) => {
  try {
    const result = bulkCategorize();
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Categorization] Error bulk categorizing:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/categorize/learn
 * Learn from user categorization
 */
router.post('/categorize/learn', (req, res) => {
  try {
    const { payee, description, accountCode } = req.body;
    
    if (!payee || !accountCode) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: payee, accountCode'
      });
    }
    
    const result = learnFromCategorization(payee, description, accountCode);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Categorization] Error learning:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/categorize/stats
 * Get categorization statistics
 */
router.get('/categorize/stats', (req, res) => {
  try {
    const stats = getCategorizationStats();
    res.json({ ok: true, ...stats });
  } catch (error) {
    console.error('[Categorization] Error getting stats:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// RECURRING TRANSACTIONS ENDPOINTS (QuickBooks-style)
// ============================================================================

/**
 * GET /api/bookkeeping/recurring
 * Get all recurring transactions
 */
router.get('/recurring', (req, res) => {
  try {
    const { propertyId, isActive } = req.query;
    const transactions = getRecurringTransactions({ 
      propertyId: propertyId ? parseInt(propertyId) : null,
      isActive: isActive !== 'false'
    });
    res.json({ ok: true, transactions, count: transactions.length });
  } catch (error) {
    console.error('[Recurring] Error getting transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/recurring
 * Create a recurring transaction
 */
router.post('/recurring', (req, res) => {
  try {
    const result = createRecurringTransaction(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Recurring] Error creating transaction:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * PUT /api/bookkeeping/recurring/:id
 * Update a recurring transaction
 */
router.put('/recurring/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = updateRecurringTransaction(parseInt(id), req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Recurring] Error updating transaction:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/bookkeeping/recurring/:id
 * Delete (deactivate) a recurring transaction
 */
router.delete('/recurring/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = deleteRecurringTransaction(parseInt(id));
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Recurring] Error deleting transaction:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/recurring/generate
 * Generate due recurring transactions
 */
router.post('/recurring/generate', (req, res) => {
  try {
    const { asOfDate } = req.body;
    const result = generateDueTransactions(asOfDate);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Recurring] Error generating transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/recurring/upcoming
 * Get upcoming recurring transactions
 */
router.get('/recurring/upcoming', (req, res) => {
  try {
    const { days = 30 } = req.query;
    const transactions = getUpcomingRecurring(parseInt(days));
    res.json({ ok: true, transactions, count: transactions.length });
  } catch (error) {
    console.error('[Recurring] Error getting upcoming:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/recurring/templates
 * Get predefined recurring transaction templates
 */
router.get('/recurring/templates', (req, res) => {
  try {
    res.json({ ok: true, templates: RECURRING_TEMPLATES });
  } catch (error) {
    console.error('[Recurring] Error getting templates:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// ADVANCED TAX CALCULATOR ENDPOINTS (TurboTax-style)
// ============================================================================

/**
 * POST /api/bookkeeping/tax/calculate
 * Calculate full tax liability with brackets
 */
router.post('/tax/calculate', (req, res) => {
  try {
    const { 
      taxYear, 
      filingStatus, 
      otherIncome, 
      otherDeductions, 
      stateRate, 
      propertyId 
    } = req.body;
    
    // Normalize stateRate: if > 1, assume percentage and divide by 100
    const parsedStateRate = parseFloat(stateRate) || 0.05;
    const normalizedStateRate = parsedStateRate > 1 ? parsedStateRate / 100 : parsedStateRate;
    
    const result = calculateTaxLiability({
      taxYear: taxYear || new Date().getFullYear(),
      filingStatus: filingStatus || 'single',
      otherIncome: parseFloat(otherIncome) || 0,
      otherDeductions: parseFloat(otherDeductions) || 0,
      stateRate: normalizedStateRate,
      propertyId: propertyId ? parseInt(propertyId) : null
    });
    
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Tax Calculator] Error calculating tax:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/deductions/find
 * Find potentially missed deductions
 */
router.get('/tax/deductions/find', (req, res) => {
  try {
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    
    const result = findMissedDeductions(taxYear, propertyId ? parseInt(propertyId) : null);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Tax Calculator] Error finding deductions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/tax/passive-loss
 * Analyze passive activity loss rules
 */
router.post('/tax/passive-loss', (req, res) => {
  try {
    const { rentalNetIncome, otherIncome, filingStatus } = req.body;
    
    const result = analyzePassiveLoss(
      parseFloat(rentalNetIncome) || 0,
      parseFloat(otherIncome) || 0,
      filingStatus || 'single'
    );
    
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Tax Calculator] Error analyzing passive loss:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/tax/re-pro-status
 * Analyze Real Estate Professional status
 */
router.post('/tax/re-pro-status', (req, res) => {
  try {
    const { rentalHours, otherWorkHours, materialParticipation } = req.body;
    
    const result = analyzeREProStatus({
      rentalHours: parseInt(rentalHours) || 0,
      otherWorkHours: parseInt(otherWorkHours) || 0,
      materialParticipation: !!materialParticipation
    });
    
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Tax Calculator] Error analyzing RE Pro status:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/tax/brackets
 * Get current tax brackets
 */
router.get('/tax/brackets', (req, res) => {
  try {
    const { filingStatus = 'single' } = req.query;
    
    const TAX_BRACKETS = {
      single: [
        { min: 0, max: 11600, rate: 10 },
        { min: 11600, max: 47150, rate: 12 },
        { min: 47150, max: 100525, rate: 22 },
        { min: 100525, max: 191950, rate: 24 },
        { min: 191950, max: 243725, rate: 32 },
        { min: 243725, max: 609350, rate: 35 },
        { min: 609350, max: null, rate: 37 }
      ],
      married_filing_jointly: [
        { min: 0, max: 23200, rate: 10 },
        { min: 23200, max: 94300, rate: 12 },
        { min: 94300, max: 201050, rate: 22 },
        { min: 201050, max: 383900, rate: 24 },
        { min: 383900, max: 487450, rate: 32 },
        { min: 487450, max: 731200, rate: 35 },
        { min: 731200, max: null, rate: 37 }
      ]
    };
    
    const STANDARD_DEDUCTIONS = {
      single: 14600,
      married_filing_jointly: 29200,
      head_of_household: 21900,
      married_filing_separately: 14600
    };
    
    res.json({
      ok: true,
      year: 2025,
      brackets: TAX_BRACKETS[filingStatus] || TAX_BRACKETS.single,
      standardDeduction: STANDARD_DEDUCTIONS[filingStatus] || STANDARD_DEDUCTIONS.single,
      filingStatuses: ['single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household']
    });
  } catch (error) {
    console.error('[Tax Calculator] Error getting brackets:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;

