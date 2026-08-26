/**
 * QuickBooks OAuth 2.0 Integration
 * Handles OAuth authentication and data retrieval from QuickBooks Online API
 */

import express from 'express';
import OAuthClient from 'intuit-oauth';
import {
  getAllQBOAccountMappings,
  savePropertyMapping,
  saveAccountMapping,
  saveEquityPlugAccount,
  getPropertiesWithActivity,
  getSyncLedgerEntry,
  getPropertyMonthSyncs,
  saveSyncLedger,
  markSyncFailed
} from './db/qbo-sync.js';
import {
  buildMonthlyJournalEntry,
  buildDeltaJournalEntry,
  validatePropertyMappings
} from './db/qbo-builder.js';

const router = express.Router();

// QuickBooks OAuth Configuration
const QUICKBOOKS_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID || '';
const QUICKBOOKS_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET || '';
const QUICKBOOKS_REDIRECT_URI = process.env.QUICKBOOKS_REDIRECT_URI || 'http://localhost:3001/api/quickbooks/callback';
const QUICKBOOKS_ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox'; // 'sandbox' or 'production'

// Initialize OAuth Client
let oauthClient = null;
let accessToken = null;
let refreshToken = null;
let realmId = null; // Company ID

// Check if OAuth credentials are configured (boolean, not the actual secret!)
const isConfigured = !!(QUICKBOOKS_CLIENT_ID && QUICKBOOKS_CLIENT_SECRET);

if (isConfigured) {
  oauthClient = new OAuthClient({
    clientId: QUICKBOOKS_CLIENT_ID,
    clientSecret: QUICKBOOKS_CLIENT_SECRET,
    environment: QUICKBOOKS_ENVIRONMENT,
    redirectUri: QUICKBOOKS_REDIRECT_URI,
  });
  console.log('✅ [QuickBooks] OAuth client initialized');
} else {
  console.warn('⚠️  [QuickBooks] OAuth credentials not configured. Set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET in .env');
}

/**
 * GET /api/quickbooks/auth
 * Initiate OAuth flow - redirects user to QuickBooks login
 */
router.get('/auth', (req, res) => {
  if (!isConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'QuickBooks OAuth not configured',
      message: 'Please set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET in environment variables'
    });
  }

  try {
    const authUri = oauthClient.authorizeUri({
      scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
      state: 'state-' + Date.now(), // Random state for security
    });
    
    res.redirect(authUri);
  } catch (error) {
    console.error('[QuickBooks] Auth error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/quickbooks/callback
 * OAuth callback endpoint - receives authorization code from QuickBooks
 */
router.get('/callback', async (req, res) => {
  if (!isConfigured) {
    return res.status(503).send('QuickBooks OAuth not configured');
  }

  try {
    const parseRedirect = req.url;
    
    // Exchange authorization code for access token
    const authResponse = await oauthClient.createToken(parseRedirect);
    accessToken = authResponse.token.access_token;
    refreshToken = authResponse.token.refresh_token;
    realmId = authResponse.token.realmId;
    
    console.log('[QuickBooks] OAuth successful! Company ID:', realmId);
    
    // Store tokens securely (in production, use a database)
    oauthClient.token.setToken(authResponse.token);
    
    // Redirect to success page
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>QuickBooks Connected</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 100px auto; padding: 20px; text-align: center; }
            .success { color: #10b981; font-size: 48px; }
            .message { margin: 20px 0; font-size: 18px; color: #374151; }
            .button { display: inline-block; margin-top: 20px; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="success">✅</div>
          <h1>QuickBooks Connected Successfully!</h1>
          <div class="message">
            Your QuickBooks account has been connected.<br>
            Company ID: ${realmId}
          </div>
          <a href="/" class="button">Return to Application</a>
          <script>
            // Auto-close window after 3 seconds
            setTimeout(() => {
              window.close();
              window.location.href = '/';
            }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('[QuickBooks] OAuth callback error:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Connection Failed</title></head>
        <body style="font-family: system-ui; max-width: 600px; margin: 100px auto; padding: 20px; text-align: center;">
          <h1 style="color: #dc2626;">❌ Connection Failed</h1>
          <p>${error.message}</p>
          <a href="/api/quickbooks/auth" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px;">Try Again</a>
        </body>
      </html>
    `);
  }
});

/**
 * GET /api/quickbooks/status
 * Check OAuth connection status
 */
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    configured: isConfigured,
    connected: !!accessToken,
    companyId: realmId,
    tokenExpired: oauthClient && oauthClient.token ? oauthClient.token.isAccessTokenValid() === false : null
  });
});

/**
 * POST /api/quickbooks/disconnect
 * Disconnect QuickBooks account (from our app)
 */
router.post('/disconnect', async (req, res) => {
  try {
    if (oauthClient && accessToken) {
      await oauthClient.revoke();
    }
    
    accessToken = null;
    refreshToken = null;
    realmId = null;
    
    res.json({ ok: true, message: 'Disconnected from QuickBooks' });
  } catch (error) {
    console.error('[QuickBooks] Disconnect error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/quickbooks/disconnected
 * Landing page when user disconnects from Intuit's side
 * This is the "Disconnect URL" required by Intuit for production apps
 */
router.get('/disconnected', (req, res) => {
  // Clear any stored tokens
  accessToken = null;
  refreshToken = null;
  realmId = null;
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>QuickBooks Disconnected</title>
        <style>
          body { font-family: system-ui; max-width: 600px; margin: 100px auto; padding: 20px; text-align: center; }
          .icon { font-size: 48px; margin-bottom: 20px; }
          .message { margin: 20px 0; font-size: 18px; color: #374151; }
          .button { display: inline-block; margin-top: 20px; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; }
        </style>
      </head>
      <body>
        <div class="icon">👋</div>
        <h1>QuickBooks Disconnected</h1>
        <div class="message">
          Your QuickBooks account has been disconnected from HouseYield.<br>
          You can reconnect at any time from the Bookkeeping section.
        </div>
        <a href="/" class="button">Return to HouseYield</a>
      </body>
    </html>
  `);
});

// Helper function to make authenticated QuickBooks API requests
async function makeQuickBooksRequest(endpoint, method = 'GET', body = null) {
  if (!isConfigured) {
    throw new Error('QuickBooks OAuth not configured');
  }

  if (!accessToken || !realmId) {
    throw new Error('Not authenticated with QuickBooks. Please connect your account first.');
  }

  // Check if token needs refresh
  if (!oauthClient.token.isAccessTokenValid()) {
    console.log('[QuickBooks] Refreshing access token...');
    try {
      const authResponse = await oauthClient.refresh();
      accessToken = authResponse.token.access_token;
      refreshToken = authResponse.token.refresh_token;
      oauthClient.token.setToken(authResponse.token);
      console.log('[QuickBooks] Token refreshed successfully');
    } catch (error) {
      console.error('[QuickBooks] Token refresh failed:', error);
      throw new Error('Session expired. Please reconnect your QuickBooks account.');
    }
  }

  try {
    const url = oauthClient.environment === 'sandbox'
      ? `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}${endpoint}`
      : `https://quickbooks.api.intuit.com/v3/company/${realmId}${endpoint}`;
    
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    // Always check content type first
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();
    
    if (!response.ok) {
      console.error('[QuickBooks] API Error:', response.status, responseText.substring(0, 500));
      
      // Try to parse error as JSON if possible
      if (contentType.includes('application/json')) {
        try {
          const errorData = JSON.parse(responseText);
          throw new Error(errorData.message || `QuickBooks API error: ${response.status}`);
        } catch (parseError) {
          throw new Error(`QuickBooks API error: ${response.status}`);
        }
      }
      
      throw new Error(`QuickBooks API error: ${response.status} - ${responseText.substring(0, 100)}`);
    }

    // Parse successful response
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(responseText);
      } catch (parseError) {
        console.error('[QuickBooks] JSON parse error:', parseError);
        console.error('[QuickBooks] Response text:', responseText.substring(0, 500));
        throw new Error('Invalid JSON response from QuickBooks API');
      }
    } else {
      console.error('[QuickBooks] Non-JSON response:', responseText.substring(0, 200));
      throw new Error('Expected JSON response from QuickBooks API but received HTML or other format');
    }
  } catch (error) {
    console.error('[QuickBooks] Request failed:', error);
    throw error;
  }
}

/**
 * GET /api/quickbooks/transactions
 * Fetch recent transactions from QuickBooks
 * Query params: limit, startDate, endDate, category
 */
router.get('/transactions', async (req, res) => {
  // Check if QuickBooks is configured
  if (!isConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'not_configured',
      message: 'QuickBooks integration is not configured. Please set up QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET in your environment variables.',
      authUrl: null
    });
  }

  // Check if user is authenticated
  if (!accessToken || !realmId) {
    return res.status(401).json({
      ok: false,
      error: 'not_authenticated',
      message: 'QuickBooks account not connected. Please authenticate first.',
      authUrl: '/api/quickbooks/auth',
      connected: false
    });
  }

  try {
    const { limit = 50, startDate, endDate, category } = req.query;
    
    // Build query for QuickBooks API
    let query = `SELECT * FROM Transaction`;
    const conditions = [];
    
    if (startDate) {
      conditions.push(`TxnDate >= '${startDate}'`);
    }
    if (endDate) {
      conditions.push(`TxnDate <= '${endDate}'`);
    }
    
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    query += ` MAXRESULTS ${limit}`;
    
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    
    // Transform QuickBooks data to our format
    const transactions = (data.QueryResponse?.Transaction || []).map(txn => ({
      id: txn.Id,
      date: txn.TxnDate,
      description: txn.PrivateNote || txn.Description || 'Transaction',
      category: txn.AccountRef?.name || 'Uncategorized',
      type: parseFloat(txn.Amount) >= 0 ? 'Income' : 'Expense',
      amount: Math.abs(parseFloat(txn.Amount || 0)),
      status: txn.Balance === 0 ? 'Cleared' : 'Pending',
      rawData: txn
    }));

    res.json({
      ok: true,
      transactions,
      total: transactions.length,
      source: 'quickbooks',
      connected: true
    });

  } catch (error) {
    console.error('[QuickBooks] Error fetching transactions:', error);
    
    // Check for specific error types
    if (error.message.includes('Session expired') || error.message.includes('401')) {
      return res.status(401).json({
        ok: false,
        error: 'session_expired',
        message: 'Your QuickBooks session has expired. Please reconnect.',
        authUrl: '/api/quickbooks/auth',
        connected: false
      });
    }
    
    if (error.message.includes('not authenticated') || error.message.includes('Not authenticated')) {
      return res.status(401).json({
        ok: false,
        error: 'not_authenticated',
        message: 'QuickBooks account not connected. Please authenticate first.',
        authUrl: '/api/quickbooks/auth',
        connected: false
      });
    }
    
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch transactions from QuickBooks'
    });
  }
});

/**
 * GET /api/quickbooks/summary
 * Get financial summary (income, expenses, cash flow)
 * Query params: startDate, endDate
 */
router.get('/summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Get Profit & Loss Report
    let reportUrl = `/reports/ProfitAndLoss`;
    const params = [];
    
    if (startDate) params.push(`start_date=${startDate}`);
    if (endDate) params.push(`end_date=${endDate}`);
    
    if (params.length > 0) {
      reportUrl += `?${params.join('&')}`;
    }
    
    const data = await makeQuickBooksRequest(reportUrl);
    
    // Parse the report data
    const report = data.Rows?.Row || [];
    let totalIncome = 0;
    let totalExpenses = 0;
    
    report.forEach(section => {
      if (section.Header?.ColData?.[0]?.value === 'Income') {
        const incomeRow = section.Rows?.Row?.find(r => r.ColData?.[1]?.value);
        totalIncome = parseFloat(incomeRow?.ColData?.[1]?.value || 0);
      }
      if (section.Header?.ColData?.[0]?.value === 'Expenses') {
        const expenseRow = section.Rows?.Row?.find(r => r.ColData?.[1]?.value);
        totalExpenses = parseFloat(expenseRow?.ColData?.[1]?.value || 0);
      }
    });
    
    const netCashFlow = totalIncome - totalExpenses;
    const margin = totalIncome > 0 ? (netCashFlow / totalIncome) * 100 : 0;

    res.json({
      ok: true,
      summary: {
        totalIncome,
        totalExpenses,
        netCashFlow,
        margin: margin.toFixed(1),
        currency: 'USD'
      },
      source: 'quickbooks'
    });

  } catch (error) {
    console.error('Error fetching QuickBooks summary:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch financial summary from QuickBooks'
    });
  }
});

/**
 * GET /api/quickbooks/categories
 * Get expense categories breakdown
 */
router.get('/categories', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Get all accounts
    const accountsData = await makeQuickBooksRequest('/query?query=' + encodeURIComponent('SELECT * FROM Account'));
    const accounts = accountsData.QueryResponse?.Account || [];
    
    // Get expense breakdown
    const expenseCategories = {};
    
    for (const account of accounts) {
      if (account.AccountType === 'Expense' && account.CurrentBalance) {
        expenseCategories[account.Name] = parseFloat(account.CurrentBalance || 0);
      }
    }
    
    // Sort by amount descending
    const sortedCategories = Object.entries(expenseCategories)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, amount]) => ({ name, amount }));

    res.json({
      ok: true,
      categories: sortedCategories,
      source: 'quickbooks'
    });

  } catch (error) {
    console.error('Error fetching QuickBooks categories:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch expense categories from QuickBooks'
    });
  }
});

/**
 * GET /api/quickbooks/cashflow-trend
 * Get monthly cash flow trend
 */
router.get('/cashflow-trend', async (req, res) => {
  try {
    const months = [];
    const today = new Date();
    
    // Get last 6 months of data
    for (let i = 5; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const startDate = date.toISOString().split('T')[0];
      const endDate = new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0];
      
      const reportUrl = `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}`;
      const data = await makeQuickBooksRequest(reportUrl);
      
      // Parse income and expenses
      const report = data.Rows?.Row || [];
      let income = 0;
      let expenses = 0;
      
      report.forEach(section => {
        if (section.Header?.ColData?.[0]?.value === 'Income') {
          const incomeRow = section.Rows?.Row?.find(r => r.ColData?.[1]?.value);
          income = parseFloat(incomeRow?.ColData?.[1]?.value || 0);
        }
        if (section.Header?.ColData?.[0]?.value === 'Expenses') {
          const expenseRow = section.Rows?.Row?.find(r => r.ColData?.[1]?.value);
          expenses = parseFloat(expenseRow?.ColData?.[1]?.value || 0);
        }
      });
      
      months.push({
        month: date.toLocaleString('default', { month: 'long' }),
        income,
        expenses,
        cashFlow: income - expenses
      });
    }

    res.json({
      ok: true,
      trend: months,
      source: 'quickbooks'
    });

  } catch (error) {
    console.error('Error fetching QuickBooks cash flow trend:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch cash flow trend from QuickBooks'
    });
  }
});

/**
 * POST /api/quickbooks/transaction
 * Create a new transaction in QuickBooks
 */
router.post('/transaction', async (req, res) => {
  try {
    const { date, description, category, type, amount, accountRef } = req.body;
    
    if (!date || !amount || !type) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: date, amount, type'
      });
    }
    
    // Create transaction based on type
    const txnData = {
      TxnDate: date,
      PrivateNote: description,
      Line: [{
        Amount: parseFloat(amount),
        DetailType: type === 'Income' ? 'SalesItemLineDetail' : 'ItemBasedExpenseLineDetail',
        Description: description
      }]
    };
    
    const endpoint = type === 'Income' ? '/invoice' : '/purchase';
    const data = await makeQuickBooksRequest(endpoint, 'POST', txnData);
    
    res.json({
      ok: true,
      transaction: data,
      message: 'Transaction created successfully',
      source: 'quickbooks'
    });

  } catch (error) {
    console.error('Error creating QuickBooks transaction:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to create transaction in QuickBooks'
    });
  }
});

/**
 * GET /api/quickbooks/upcoming-bills
 * Get upcoming bills and scheduled payments
 */
router.get('/upcoming-bills', async (req, res) => {
  try {
    // Query for unpaid bills
    const query = `SELECT * FROM Bill WHERE Balance > 0`;
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    
    const bills = (data.QueryResponse?.Bill || []).map(bill => ({
      description: bill.VendorRef?.name || 'Bill',
      dueDate: bill.DueDate,
      amount: parseFloat(bill.Balance || 0),
      category: 'Bill Payment'
    }));
    
    // Sort by due date
    bills.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    res.json({
      ok: true,
      upcomingBills: bills.slice(0, 5),
      source: 'quickbooks'
    });

  } catch (error) {
    console.error('Error fetching upcoming bills:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch upcoming bills from QuickBooks'
    });
  }
});

// ============================================================================
// IMPORT FROM QUICKBOOKS - Load transactions INTO native bookkeeping system
// ============================================================================

/**
 * GET /api/quickbooks/import/preview
 * Preview what will be imported from QuickBooks before actually importing
 * Query params: startDate, endDate, type (all|expenses|income|bills)
 */
router.get('/import/preview', async (req, res) => {
  // Check if QuickBooks is configured and connected
  if (!isConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'not_configured',
      message: 'QuickBooks integration is not configured'
    });
  }

  if (!accessToken || !realmId) {
    return res.status(401).json({
      ok: false,
      error: 'not_authenticated',
      message: 'QuickBooks account not connected',
      authUrl: '/api/quickbooks/auth'
    });
  }

  try {
    const { startDate, endDate, type = 'all' } = req.query;
    
    // Calculate default date range (last 30 days if not specified)
    const today = new Date();
    const defaultEndDate = today.toISOString().split('T')[0];
    const defaultStartDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const useStartDate = startDate || defaultStartDate;
    const useEndDate = endDate || defaultEndDate;
    
    const transactionsToImport = [];
    
    // Fetch Purchases/Expenses
    if (type === 'all' || type === 'expenses') {
      const purchaseQuery = `SELECT * FROM Purchase WHERE TxnDate >= '${useStartDate}' AND TxnDate <= '${useEndDate}' MAXRESULTS 100`;
      const purchaseData = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(purchaseQuery)}`);
      
      const purchases = (purchaseData.QueryResponse?.Purchase || []).map(p => ({
        qbo_id: p.Id,
        qbo_type: 'Purchase',
        date: p.TxnDate,
        description: p.PrivateNote || p.Line?.[0]?.Description || `Purchase from ${p.EntityRef?.name || 'Unknown'}`,
        vendor: p.EntityRef?.name || 'Unknown Vendor',
        amount: parseFloat(p.TotalAmt || 0),
        type: 'Expense',
        category: p.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Uncategorized',
        payment_type: p.PaymentType || 'Other',
        account: p.AccountRef?.name || 'Unknown Account',
        already_imported: false // Will be set after checking local DB
      }));
      
      transactionsToImport.push(...purchases);
    }
    
    // Fetch Sales Receipts / Income
    if (type === 'all' || type === 'income') {
      const salesQuery = `SELECT * FROM SalesReceipt WHERE TxnDate >= '${useStartDate}' AND TxnDate <= '${useEndDate}' MAXRESULTS 100`;
      const salesData = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(salesQuery)}`);
      
      const sales = (salesData.QueryResponse?.SalesReceipt || []).map(s => ({
        qbo_id: s.Id,
        qbo_type: 'SalesReceipt',
        date: s.TxnDate,
        description: s.PrivateNote || s.Line?.[0]?.Description || `Sale to ${s.CustomerRef?.name || 'Customer'}`,
        customer: s.CustomerRef?.name || 'Unknown Customer',
        amount: parseFloat(s.TotalAmt || 0),
        type: 'Income',
        category: 'Rental Income',
        already_imported: false
      }));
      
      transactionsToImport.push(...sales);
    }
    
    // Fetch Invoices (Accounts Receivable)
    if (type === 'all' || type === 'income') {
      const invoiceQuery = `SELECT * FROM Invoice WHERE TxnDate >= '${useStartDate}' AND TxnDate <= '${useEndDate}' MAXRESULTS 100`;
      const invoiceData = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(invoiceQuery)}`);
      
      const invoices = (invoiceData.QueryResponse?.Invoice || []).map(inv => ({
        qbo_id: inv.Id,
        qbo_type: 'Invoice',
        date: inv.TxnDate,
        description: inv.PrivateNote || `Invoice #${inv.DocNumber || inv.Id} - ${inv.CustomerRef?.name || 'Customer'}`,
        customer: inv.CustomerRef?.name || 'Unknown Customer',
        amount: parseFloat(inv.TotalAmt || 0),
        type: 'Income',
        category: inv.Line?.[0]?.SalesItemLineDetail?.ItemRef?.name || 'Rental Income',
        status: inv.Balance > 0 ? 'Outstanding' : 'Paid',
        already_imported: false
      }));
      
      transactionsToImport.push(...invoices);
    }
    
    // Fetch Bills (Accounts Payable)
    if (type === 'all' || type === 'bills') {
      const billQuery = `SELECT * FROM Bill WHERE TxnDate >= '${useStartDate}' AND TxnDate <= '${useEndDate}' MAXRESULTS 100`;
      const billData = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(billQuery)}`);
      
      const bills = (billData.QueryResponse?.Bill || []).map(bill => ({
        qbo_id: bill.Id,
        qbo_type: 'Bill',
        date: bill.TxnDate,
        due_date: bill.DueDate,
        description: bill.PrivateNote || `Bill from ${bill.VendorRef?.name || 'Vendor'}`,
        vendor: bill.VendorRef?.name || 'Unknown Vendor',
        amount: parseFloat(bill.TotalAmt || 0),
        type: 'Expense',
        category: bill.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Accounts Payable',
        status: bill.Balance > 0 ? 'Unpaid' : 'Paid',
        already_imported: false
      }));
      
      transactionsToImport.push(...bills);
    }
    
    // Sort by date descending
    transactionsToImport.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Calculate totals
    const totalIncome = transactionsToImport
      .filter(t => t.type === 'Income')
      .reduce((sum, t) => sum + t.amount, 0);
    const totalExpenses = transactionsToImport
      .filter(t => t.type === 'Expense')
      .reduce((sum, t) => sum + t.amount, 0);

    res.json({
      ok: true,
      transactions: transactionsToImport,
      summary: {
        totalTransactions: transactionsToImport.length,
        totalIncome,
        totalExpenses,
        netCashFlow: totalIncome - totalExpenses,
        dateRange: { start: useStartDate, end: useEndDate }
      },
      source: 'quickbooks'
    });

  } catch (error) {
    console.error('[QuickBooks Import] Error fetching preview:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch transactions from QuickBooks for preview'
    });
  }
});

/**
 * POST /api/quickbooks/import/execute
 * Actually import selected transactions from QuickBooks into native bookkeeping
 * Body: { transactions: [array of qbo_ids to import], property_id (optional) }
 */
router.post('/import/execute', async (req, res) => {
  // Check if QuickBooks is configured and connected
  if (!isConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'not_configured',
      message: 'QuickBooks integration is not configured'
    });
  }

  if (!accessToken || !realmId) {
    return res.status(401).json({
      ok: false,
      error: 'not_authenticated',
      message: 'QuickBooks account not connected',
      authUrl: '/api/quickbooks/auth'
    });
  }

  try {
    const { transactions, property_id = 1 } = req.body;
    
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Missing or empty transactions array'
      });
    }
    
    // Import the bookkeeping posting module dynamically
    let postBankTransaction, createManualJournalEntry;
    try {
      const postingModule = await import('./db/posting.js');
      postBankTransaction = postingModule.postBankTransaction;
      createManualJournalEntry = postingModule.createManualJournalEntry;
    } catch (importError) {
      console.error('[QuickBooks Import] Failed to load posting module:', importError);
      return res.status(500).json({
        ok: false,
        error: 'Bookkeeping module not available'
      });
    }
    
    const results = {
      imported: [],
      failed: [],
      skipped: []
    };
    
    for (const txn of transactions) {
      try {
        // Map QuickBooks transaction to journal entry
        const journalLines = [];
        
        if (txn.type === 'Expense') {
          // Debit: Expense account, Credit: Cash/Bank
          journalLines.push({
            account_code: mapCategoryToAccountCode(txn.category, 'expense'),
            dc: 'D',
            amount: txn.amount,
            memo: txn.description,
            property_id: property_id
          });
          journalLines.push({
            account_code: '1000', // Cash account
            dc: 'C',
            amount: txn.amount,
            memo: `Payment: ${txn.description}`,
            property_id: property_id
          });
        } else if (txn.type === 'Income') {
          // Debit: Cash/Bank, Credit: Revenue account
          journalLines.push({
            account_code: '1000', // Cash account
            dc: 'D',
            amount: txn.amount,
            memo: `Received: ${txn.description}`,
            property_id: property_id
          });
          journalLines.push({
            account_code: mapCategoryToAccountCode(txn.category, 'income'),
            dc: 'C',
            amount: txn.amount,
            memo: txn.description,
            property_id: property_id
          });
        }
        
        // Create the journal entry
        const result = createManualJournalEntry(
          txn.date,
          `[QBO Import] ${txn.description}`,
          journalLines,
          'quickbooks-import'
        );
        
        results.imported.push({
          qbo_id: txn.qbo_id,
          journal_entry_id: result.journal_entry_id,
          description: txn.description,
          amount: txn.amount
        });
        
      } catch (txnError) {
        console.error(`[QuickBooks Import] Error importing transaction ${txn.qbo_id}:`, txnError);
        results.failed.push({
          qbo_id: txn.qbo_id,
          description: txn.description,
          error: txnError.message
        });
      }
    }

    res.json({
      ok: true,
      results,
      summary: {
        totalRequested: transactions.length,
        imported: results.imported.length,
        failed: results.failed.length,
        skipped: results.skipped.length
      },
      message: `Successfully imported ${results.imported.length} of ${transactions.length} transactions`
    });

  } catch (error) {
    console.error('[QuickBooks Import] Error executing import:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to import transactions from QuickBooks'
    });
  }
});

/**
 * Helper function to map QuickBooks category names to local account codes
 */
function mapCategoryToAccountCode(category, type) {
  const categoryLower = (category || '').toLowerCase();
  
  if (type === 'expense') {
    // Expense account mappings
    if (categoryLower.includes('rent') || categoryLower.includes('lease')) return '5010';
    if (categoryLower.includes('mortgage') || categoryLower.includes('interest')) return '5020';
    if (categoryLower.includes('tax') || categoryLower.includes('property tax')) return '5030';
    if (categoryLower.includes('insurance')) return '5040';
    if (categoryLower.includes('utilit') || categoryLower.includes('electric') || categoryLower.includes('gas') || categoryLower.includes('water')) return '5050';
    if (categoryLower.includes('repair') || categoryLower.includes('maintenance')) return '5080';
    if (categoryLower.includes('clean')) return '5070';
    if (categoryLower.includes('management') || categoryLower.includes('hoa')) return '5090';
    if (categoryLower.includes('legal') || categoryLower.includes('professional')) return '5120';
    if (categoryLower.includes('advertis') || categoryLower.includes('market')) return '5110';
    if (categoryLower.includes('deprec')) return '5060';
    if (categoryLower.includes('office') || categoryLower.includes('supplies')) return '5150';
    if (categoryLower.includes('travel')) return '5160';
    if (categoryLower.includes('bank') || categoryLower.includes('fee')) return '5130';
    return '5100'; // Default: Other Operating Expenses
  } else {
    // Income account mappings
    if (categoryLower.includes('rent')) return '4010';
    if (categoryLower.includes('late') || categoryLower.includes('fee')) return '4020';
    if (categoryLower.includes('pet')) return '4030';
    if (categoryLower.includes('parking')) return '4050';
    if (categoryLower.includes('laundry')) return '4080';
    if (categoryLower.includes('utilit') || categoryLower.includes('reimburs')) return '4040';
    if (categoryLower.includes('security') || categoryLower.includes('deposit')) return '4060';
    return '4010'; // Default: Rental Income
  }
}

/**
 * GET /api/quickbooks/import/accounts
 * Get QuickBooks chart of accounts for mapping purposes
 */
router.get('/import/accounts', async (req, res) => {
  if (!isConfigured || !accessToken || !realmId) {
    return res.status(401).json({
      ok: false,
      error: 'not_authenticated',
      message: 'QuickBooks account not connected'
    });
  }

  try {
    const query = 'SELECT * FROM Account WHERE Active = true MAXRESULTS 500';
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    
    const accounts = (data.QueryResponse?.Account || []).map(acct => ({
      id: acct.Id,
      name: acct.Name,
      fullyQualifiedName: acct.FullyQualifiedName,
      type: acct.AccountType,
      subType: acct.AccountSubType,
      balance: parseFloat(acct.CurrentBalance || 0)
    }));

    // Group by type
    const grouped = {
      income: accounts.filter(a => a.type === 'Income'),
      expense: accounts.filter(a => a.type === 'Expense'),
      asset: accounts.filter(a => ['Bank', 'Other Current Asset', 'Fixed Asset'].includes(a.type)),
      liability: accounts.filter(a => ['Accounts Payable', 'Other Current Liability', 'Long Term Liability'].includes(a.type)),
      equity: accounts.filter(a => a.type === 'Equity'),
      other: accounts.filter(a => !['Income', 'Expense', 'Bank', 'Other Current Asset', 'Fixed Asset', 'Accounts Payable', 'Other Current Liability', 'Long Term Liability', 'Equity'].includes(a.type))
    };

    res.json({
      ok: true,
      accounts,
      grouped,
      total: accounts.length
    });

  } catch (error) {
    console.error('[QuickBooks Import] Error fetching accounts:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/import/vendors
 * Get QuickBooks vendors for mapping
 */
router.get('/import/vendors', async (req, res) => {
  if (!isConfigured || !accessToken || !realmId) {
    return res.status(401).json({
      ok: false,
      error: 'not_authenticated',
      message: 'QuickBooks account not connected'
    });
  }

  try {
    const query = 'SELECT * FROM Vendor WHERE Active = true MAXRESULTS 200';
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    
    const vendors = (data.QueryResponse?.Vendor || []).map(v => ({
      id: v.Id,
      name: v.DisplayName || v.CompanyName,
      company: v.CompanyName,
      email: v.PrimaryEmailAddr?.Address,
      phone: v.PrimaryPhone?.FreeFormNumber,
      balance: parseFloat(v.Balance || 0)
    }));

    res.json({
      ok: true,
      vendors,
      total: vendors.length
    });

  } catch (error) {
    console.error('[QuickBooks Import] Error fetching vendors:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/import/customers
 * Get QuickBooks customers (tenants) for mapping
 */
router.get('/import/customers', async (req, res) => {
  if (!isConfigured || !accessToken || !realmId) {
    return res.status(401).json({
      ok: false,
      error: 'not_authenticated',
      message: 'QuickBooks account not connected'
    });
  }

  try {
    const query = 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 200';
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    
    const customers = (data.QueryResponse?.Customer || []).map(c => ({
      id: c.Id,
      name: c.DisplayName || c.CompanyName,
      company: c.CompanyName,
      email: c.PrimaryEmailAddr?.Address,
      phone: c.PrimaryPhone?.FreeFormNumber,
      balance: parseFloat(c.Balance || 0)
    }));

    res.json({
      ok: true,
      customers,
      total: customers.length
    });

  } catch (error) {
    console.error('[QuickBooks Import] Error fetching customers:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================================================
// QUICKBOOKS SYNC API - Mapping Wizard & Monthly Sync
// ============================================================================

/**
 * GET /api/quickbooks/sync/departments
 * Fetch all Departments/Locations from QuickBooks for mapping wizard
 */
router.get('/sync/departments', async (req, res) => {
  try {
    const query = 'SELECT * FROM Department WHERE Active = true MAXRESULTS 1000';
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    
    const departments = (data.QueryResponse?.Department || []).map(dept => ({
      id: dept.Id,
      name: dept.Name,
      fully_qualified_name: dept.FullyQualifiedName || dept.Name,
      active: dept.Active
    }));

    res.json({
      ok: true,
      departments,
      count: departments.length
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error fetching departments:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch QuickBooks departments'
    });
  }
});

/**
 * POST /api/quickbooks/sync/departments
 * Create a new Department/Location in QuickBooks
 */
router.post('/sync/departments', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: name'
      });
    }
    
    const departmentData = {
      Name: name,
      Active: true
    };
    
    const data = await makeQuickBooksRequest('/department', 'POST', departmentData);
    
    res.json({
      ok: true,
      department: {
        id: data.Department.Id,
        name: data.Department.Name
      },
      message: 'Department created successfully'
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error creating department:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to create QuickBooks department'
    });
  }
});

/**
 * GET /api/quickbooks/sync/accounts
 * Fetch Chart of Accounts from QuickBooks for mapping wizard
 */
router.get('/sync/accounts', async (req, res) => {
  try {
    const query = 'SELECT * FROM Account WHERE Active = true MAXRESULTS 1000';
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    
    const accounts = (data.QueryResponse?.Account || []).map(acct => ({
      id: acct.Id,
      name: acct.Name,
      fully_qualified_name: acct.FullyQualifiedName || acct.Name,
      account_type: acct.AccountType,
      account_sub_type: acct.AccountSubType,
      active: acct.Active
    }));

    res.json({
      ok: true,
      accounts,
      count: accounts.length
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error fetching accounts:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Failed to fetch QuickBooks accounts'
    });
  }
});

/**
 * POST /api/quickbooks/sync/map-property
 * Map a property to a QuickBooks Department/Location
 */
router.post('/sync/map-property', (req, res) => {
  try {
    const { property_id, qbo_department_id, qbo_department_name } = req.body;
    
    if (!property_id || !qbo_department_id) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: property_id, qbo_department_id'
      });
    }
    
    savePropertyMapping(property_id, qbo_department_id, qbo_department_name);
    
    res.json({
      ok: true,
      message: 'Property mapping saved successfully'
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error saving property mapping:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * POST /api/quickbooks/sync/map-account
 * Map a chart of accounts entry to a QuickBooks account
 */
router.post('/sync/map-account', (req, res) => {
  try {
    const { account_code, qbo_account_id, qbo_account_name } = req.body;
    
    if (!account_code || !qbo_account_id) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: account_code, qbo_account_id'
      });
    }
    
    saveAccountMapping(account_code, qbo_account_id, qbo_account_name);
    
    res.json({
      ok: true,
      message: 'Account mapping saved successfully'
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error saving account mapping:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * POST /api/quickbooks/sync/map-equity-plug
 * Set the equity plug account for balancing entries
 */
router.post('/sync/map-equity-plug', (req, res) => {
  try {
    const { qbo_account_id } = req.body;
    
    if (!qbo_account_id) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: qbo_account_id'
      });
    }
    
    saveEquityPlugAccount(qbo_account_id);
    
    res.json({
      ok: true,
      message: 'Equity plug account configured successfully'
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error saving equity plug:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/sync/mappings
 * Get current mapping status
 */
router.get('/sync/mappings', (req, res) => {
  try {
    const accountMappings = getAllQBOAccountMappings();
    
    res.json({
      ok: true,
      account_mappings: accountMappings
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error fetching mappings:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * POST /api/quickbooks/sync/auto-map
 * Automatically map accounts based on name matching
 */
router.post('/sync/auto-map', async (req, res) => {
  if (!isConfigured || !accessToken || !realmId) {
    return res.status(401).json({
      ok: false,
      error: 'not_authenticated',
      message: 'QuickBooks account not connected'
    });
  }

  try {
    // Fetch QuickBooks accounts
    const query = 'SELECT * FROM Account WHERE Active = true MAXRESULTS 500';
    const data = await makeQuickBooksRequest(`/query?query=${encodeURIComponent(query)}`);
    const qboAccounts = data.QueryResponse?.Account || [];
    
    // Local accounts to map
    const localAccounts = [
      { code: '4000', name: 'Rental Income', type: 'Income' },
      { code: '4100', name: 'Late Fees', type: 'Income' },
      { code: '4200', name: 'Application Fees', type: 'Income' },
      { code: '4300', name: 'Pet Fees', type: 'Income' },
      { code: '4900', name: 'Other Income', type: 'Income' },
      { code: '5000', name: 'Repairs & Maintenance', type: 'Expense' },
      { code: '5100', name: 'Utilities', type: 'Expense' },
      { code: '5200', name: 'Insurance', type: 'Expense' },
      { code: '5300', name: 'Property Tax', type: 'Expense' },
      { code: '5400', name: 'Property Management', type: 'Expense' },
      { code: '5500', name: 'Mortgage Interest', type: 'Expense' },
      { code: '5600', name: 'HOA Fees', type: 'Expense' },
      { code: '5700', name: 'Landscaping', type: 'Expense' },
      { code: '5800', name: 'Cleaning', type: 'Expense' },
      { code: '5900', name: 'Legal & Professional', type: 'Expense' },
      { code: '5999', name: 'Other Expenses', type: 'Expense' },
      { code: '6000', name: 'Advertising', type: 'Expense' },
      { code: '6100', name: 'Depreciation Expense', type: 'Expense' },
    ];
    
    const mapped = [];
    const unmapped = [];
    
    for (const local of localAccounts) {
      // Try to find a matching QBO account
      const normalizedLocalName = local.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      let match = qboAccounts.find(qbo => {
        const normalizedQboName = qbo.Name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return normalizedQboName === normalizedLocalName || 
               normalizedQboName.includes(normalizedLocalName) ||
               normalizedLocalName.includes(normalizedQboName);
      });
      
      // If no direct match, try type + partial match
      if (!match) {
        match = qboAccounts.find(qbo => {
          if (qbo.AccountType !== local.type) return false;
          const qboWords = qbo.Name.toLowerCase().split(/\s+/);
          const localWords = local.name.toLowerCase().split(/\s+/);
          return localWords.some(lw => qboWords.some(qw => qw.includes(lw) || lw.includes(qw)));
        });
      }
      
      // If still no match, use a generic fallback based on type
      if (!match) {
        if (local.type === 'Expense') {
          match = qboAccounts.find(qbo => 
            qbo.AccountType === 'Expense' && 
            (qbo.Name.toLowerCase().includes('other') || qbo.Name.toLowerCase().includes('misc'))
          );
        } else if (local.type === 'Income') {
          match = qboAccounts.find(qbo => 
            qbo.AccountType === 'Income' && 
            (qbo.Name.toLowerCase().includes('other') || qbo.Name.toLowerCase().includes('services'))
          );
        }
      }
      
      if (match) {
        saveAccountMapping(local.code, match.Id, match.Name);
        mapped.push({
          local: local,
          qbo: { id: match.Id, name: match.Name }
        });
      } else {
        unmapped.push(local);
      }
    }
    
    res.json({
      ok: true,
      mapped: mapped.length,
      unmapped: unmapped.length,
      mappings: mapped,
      needsManualMapping: unmapped,
      message: `Auto-mapped ${mapped.length} accounts. ${unmapped.length} accounts need manual mapping.`
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Auto-map error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/sync/properties-with-activity/:period
 * Get all properties with bookkeeping activity in a given month
 */
router.get('/sync/properties-with-activity/:period', (req, res) => {
  try {
    const { period } = req.params; // Format: YYYY-MM
    
    // Parse period to get start and end dates
    const [year, month] = period.split('-').map(Number);
    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const periodEnd = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    
    const properties = getPropertiesWithActivity(periodStart, periodEnd);
    
    res.json({
      ok: true,
      period,
      properties
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error fetching properties:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/sync/preview/:property_id/:period
 * Preview what will be synced for a property/month before actually posting
 */
router.get('/sync/preview/:property_id/:period', (req, res) => {
  try {
    const { property_id, period } = req.params;
    const { property_code } = req.query;
    
    // Parse period
    const [year, month] = period.split('-').map(Number);
    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const periodEnd = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    
    // Build the journal entry
    const result = buildMonthlyJournalEntry(
      Number(property_id),
      periodStart,
      periodEnd,
      property_code || 'PROP'
    );
    
    if (!result.ok) {
      return res.status(400).json({
        ...result,
        // Include helpful info for missing mappings
        missingMappings: result.missing_accounts || []
      });
    }
    
    // Check if already synced
    const syncs = getPropertyMonthSyncs(Number(property_id), period);
    const alreadySynced = syncs.length > 0;
    
    // Transform summary to match frontend expectations (camelCase)
    const summary = {
      totalIncome: result.summary?.total_income || 0,
      totalExpenses: result.summary?.total_expenses || 0,
      plugAmount: result.summary?.plug_amount || 0,
      lineCount: result.summary?.line_count || 0,
      propertyId: result.summary?.property_id,
      txn_id: result.doc_number,
      period: result.summary?.period
    };
    
    res.json({
      ok: true,
      journalEntry: result.payload,
      summary,
      docNumber: result.doc_number,
      alreadySynced,
      previousSyncs: syncs
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error in preview:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * POST /api/quickbooks/sync/push/:property_id/:period
 * Push bookkeeping data to QuickBooks
 */
router.post('/sync/push/:property_id/:period', async (req, res) => {
  try {
    const { property_id, period } = req.params;
    const { property_code, posted_by } = req.body;
    
    // Parse period
    const [year, month] = period.split('-').map(Number);
    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const periodEnd = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    
    // Build the journal entry
    const result = buildMonthlyJournalEntry(
      Number(property_id),
      periodStart,
      periodEnd,
      property_code || 'PROP'
    );
    
    if (!result.ok) {
      return res.status(400).json({
        ...result,
        missingMappings: result.missing_accounts || []
      });
    }
    
    // Transform summary to camelCase for consistency
    const summary = {
      totalIncome: result.summary?.total_income || 0,
      totalExpenses: result.summary?.total_expenses || 0,
      plugAmount: result.summary?.plug_amount || 0,
      lineCount: result.summary?.line_count || 0
    };
    
    // Check if already synced
    const syncs = getPropertyMonthSyncs(Number(property_id), period);
    const alreadySynced = syncs.length > 0;
    
    let journalEntryToPost = result.payload; // Use payload, not journalEntry
    let isDelta = false;
    
    if (alreadySynced) {
      // Check if totals changed - if not, skip
      const lastSync = syncs[syncs.length - 1];
      if (
        Math.abs((lastSync.total_income || 0) - summary.totalIncome) < 0.01 &&
        Math.abs((lastSync.total_expenses || 0) - summary.totalExpenses) < 0.01
      ) {
        return res.json({
          ok: true,
          message: 'Already synced with same totals. No changes needed.',
          qbo_journal_id: lastSync.qbo_journal_id,
          summary,
          skipped: true
        });
      }
      
      // Build delta entry
      const deltaResult = buildDeltaJournalEntry(
        Number(property_id),
        periodStart,
        periodEnd,
        property_code || 'PROP',
        1 // Adjustment number
      );
      
      if (deltaResult.ok) {
        journalEntryToPost = deltaResult.payload; // Use payload, not journalEntry
        isDelta = true;
      }
    }
    
    // Post to QuickBooks
    const qboResponse = await makeQuickBooksRequest('/journalentry', 'POST', journalEntryToPost);
    
    if (!qboResponse || !qboResponse.JournalEntry) {
      throw new Error('Invalid response from QuickBooks');
    }
    
    const qboJournalId = qboResponse.JournalEntry.Id;
    const txnNumber = qboResponse.JournalEntry.DocNumber;
    
    // Build totals map for the ledger
    const totalsMap = {
      totalIncome: summary.totalIncome,
      totalExpenses: summary.totalExpenses,
      lineCount: summary.lineCount
    };
    
    // Save to sync ledger (matches function signature: propertyId, periodStart, periodEnd, docNumber, qboJournalId, pushedTotals, pushedBy)
    saveSyncLedger(
      Number(property_id),
      periodStart,
      periodEnd,
      result.doc_number,
      qboJournalId,
      totalsMap,
      posted_by || 'system'
    );
    
    res.json({
      ok: true,
      qbo_journal_id: qboJournalId,
      txn_number: txnNumber,
      summary,
      is_adjustment: isDelta
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error pushing to QuickBooks:', error);
    
    // Try to mark as failed in ledger
    try {
      const { property_id, period } = req.params;
      markSyncFailed(Number(property_id), period, error.message);
    } catch (ledgerError) {
      console.error('[QuickBooks Sync] Error marking sync as failed:', ledgerError);
    }
    
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/**
 * GET /api/quickbooks/sync/status/:property_id/:period
 * Get sync history for a property/period
 */
router.get('/sync/status/:property_id/:period', (req, res) => {
  try {
    const { property_id, period } = req.params;
    
    const syncs = getPropertyMonthSyncs(Number(property_id), period);
    
    res.json({
      ok: true,
      syncs,
      count: syncs.length,
      latest: syncs.length > 0 ? syncs[syncs.length - 1] : null
    });

  } catch (error) {
    console.error('[QuickBooks Sync] Error fetching sync status:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================================================
// FIRESTORE-BASED SYNC ROUTES (Production - Per-User Data)
// These routes use Firebase Auth and Firestore instead of SQLite
// ============================================================================

/**
 * Helper: Verify Firebase token and return user ID
 */
async function verifyFirebaseAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  
  try {
    const { verifyIdToken } = await import('./firebase-admin.js');
    const decodedToken = await verifyIdToken(authHeader.split('Bearer ')[1]);
    return decodedToken?.uid || null;
  } catch (error) {
    console.error('[QuickBooks] Firebase auth error:', error);
    return null;
  }
}

/**
 * Helper: Get Firestore bookkeeping data for a user/month
 */
async function getFirestoreMonthlyTotals(userId, month) {
  try {
    const { getFirestore } = await import('./firebase-admin.js');
    const db = getFirestore();
    
    const startDate = `${month}-01`;
    const [year, monthNum] = month.split('-').map(Number);
    const endDate = new Date(year, monthNum, 0).toISOString().split('T')[0];
    
    // Get journal entries for the month
    const entriesRef = db.collection('users').doc(userId)
      .collection('bookkeeping').doc('data').collection('journalEntries');
    
    const entriesSnap = await entriesRef
      .where('entryDate', '>=', startDate)
      .where('entryDate', '<=', endDate)
      .get();
    
    // Get accounts for lookup
    const accountsRef = db.collection('users').doc(userId)
      .collection('bookkeeping').doc('data').collection('accounts');
    const accountsSnap = await accountsRef.get();
    const accountMap = new Map(accountsSnap.docs.map(d => [d.id, d.data()]));
    
    // Aggregate by account
    const revenueTotals = new Map();
    const expenseTotals = new Map();
    
    for (const doc of entriesSnap.docs) {
      const entry = doc.data();
      
      for (const line of (entry.lines || [])) {
        const account = accountMap.get(line.accountCode);
        if (!account) continue;
        
        const key = line.accountCode;
        
        if (account.type === 'REVENUE') {
          const amount = line.dc === 'C' ? line.amount : -line.amount;
          const existing = revenueTotals.get(key) || { 
            accountCode: line.accountCode, 
            accountName: account.name, 
            qboAccountId: account.qboAccountId,
            amount: 0 
          };
          existing.amount += amount;
          revenueTotals.set(key, existing);
        } else if (account.type === 'EXPENSE') {
          const amount = line.dc === 'D' ? line.amount : -line.amount;
          const existing = expenseTotals.get(key) || { 
            accountCode: line.accountCode, 
            accountName: account.name, 
            qboAccountId: account.qboAccountId,
            amount: 0 
          };
          existing.amount += amount;
          expenseTotals.set(key, existing);
        }
      }
    }
    
    return {
      revenue: Array.from(revenueTotals.values()).filter(r => Math.abs(r.amount) > 0.005),
      expenses: Array.from(expenseTotals.values()).filter(e => Math.abs(e.amount) > 0.005),
      entryCount: entriesSnap.docs.length
    };
  } catch (error) {
    console.error('[QuickBooks] Firestore totals error:', error);
    return { revenue: [], expenses: [], entryCount: 0 };
  }
}

/**
 * GET /api/quickbooks/firestore/sync/preview/:period
 * Preview what will be synced from Firestore data for a month
 */
router.get('/firestore/sync/preview/:period', async (req, res) => {
  try {
    const userId = await verifyFirebaseAuth(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Firebase auth required' });
    }
    
    const { period } = req.params;
    const { property_code } = req.query;
    
    const totals = await getFirestoreMonthlyTotals(userId, period);
    
    if (totals.revenue.length === 0 && totals.expenses.length === 0) {
      return res.json({
        ok: false,
        error: 'no_activity',
        message: 'No transactions found for this month in your bookkeeping'
      });
    }
    
    const totalIncome = totals.revenue.reduce((sum, r) => sum + r.amount, 0);
    const totalExpenses = totals.expenses.reduce((sum, e) => sum + e.amount, 0);
    
    // Map our account names to QuickBooks standard account names
    const qboAccountMapping = {
      'Rental Income': 'Services',
      'Late Fees': 'Services',
      'Application Fees': 'Services',
      'Pet Fees': 'Services',
      'Other Income': 'Services',
      'Repairs & Maintenance': 'Repairs & Maintenance',
      'Utilities': 'Utilities',
      'Insurance': 'Insurance',
      'Property Tax': 'Taxes & Licenses',
      'Property Management': 'Management',
      'Mortgage Interest': 'Interest Expense',
      'HOA Fees': 'Other Miscellaneous Service Cost',
      'Landscaping': 'Repairs & Maintenance',
      'Cleaning': 'Repairs & Maintenance',
      'Legal & Professional': 'Legal & Professional Fees',
      'Other Expenses': 'Other Miscellaneous Service Cost',
      'Advertising': 'Advertising',
      'Depreciation Expense': 'Depreciation',
      'Operating Cash': 'Checking'
    };
    
    const getQboAccountName = (ourAccountName) => {
      return qboAccountMapping[ourAccountName] || 'Other Miscellaneous Service Cost';
    };
    
    // Build journal entry lines for QBO
    const lines = [];
    
    for (const rev of totals.revenue) {
      lines.push({
        Description: `${rev.accountName} - ${period}`,
        Amount: Math.abs(rev.amount).toFixed(2),
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: rev.qboAccountId ? { value: rev.qboAccountId } : { name: getQboAccountName(rev.accountName) }
        }
      });
    }
    
    for (const exp of totals.expenses) {
      lines.push({
        Description: `${exp.accountName} - ${period}`,
        Amount: Math.abs(exp.amount).toFixed(2),
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: exp.qboAccountId ? { value: exp.qboAccountId } : { name: getQboAccountName(exp.accountName) }
        }
      });
    }
    
    // Add equity plug line to balance
    const netIncome = totalIncome - totalExpenses;
    if (Math.abs(netIncome) > 0.01) {
      lines.push({
        Description: `Net Income Equity Plug - ${period}`,
        Amount: Math.abs(netIncome).toFixed(2),
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: netIncome > 0 ? 'Debit' : 'Credit',
          AccountRef: { name: "Opening Balance Equity" }
        }
      });
    }
    
    const docNumber = `FS-${property_code || 'PROP'}-${period}`;
    
    const journalEntry = {
      DocNumber: docNumber,
      TxnDate: `${period}-01`,
      PrivateNote: `Monthly bookkeeping sync from app for ${period}`,
      Line: lines
    };
    
    res.json({
      ok: true,
      journalEntry,
      summary: {
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netIncome: Math.round(netIncome * 100) / 100,
        lineCount: lines.length,
        period
      },
      docNumber,
      alreadySynced: false, // TODO: Check Firestore sync ledger
      entryCount: totals.entryCount
    });
    
  } catch (error) {
    console.error('[QuickBooks Firestore] Preview error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/quickbooks/firestore/sync/push/:period
 * Push Firestore bookkeeping data to QuickBooks
 */
router.post('/firestore/sync/push/:period', async (req, res) => {
  try {
    const userId = await verifyFirebaseAuth(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Firebase auth required' });
    }
    
    const { period } = req.params;
    const { property_code, posted_by } = req.body;
    
    const totals = await getFirestoreMonthlyTotals(userId, period);
    
    if (totals.revenue.length === 0 && totals.expenses.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'no_activity',
        message: 'No transactions found for this month'
      });
    }
    
    const totalIncome = totals.revenue.reduce((sum, r) => sum + r.amount, 0);
    const totalExpenses = totals.expenses.reduce((sum, e) => sum + e.amount, 0);
    
    // Map our account names to QuickBooks standard account names
    // QuickBooks requires exact account name matches or account IDs
    const qboAccountMapping = {
      // Revenue accounts
      'Rental Income': 'Services',
      'Late Fees': 'Services',
      'Application Fees': 'Services',
      'Pet Fees': 'Services',
      'Other Income': 'Services',
      // Expense accounts
      'Repairs & Maintenance': 'Repairs & Maintenance',
      'Utilities': 'Utilities',
      'Insurance': 'Insurance',
      'Property Tax': 'Taxes & Licenses',
      'Property Management': 'Management',
      'Mortgage Interest': 'Interest Expense',
      'HOA Fees': 'Other Miscellaneous Service Cost',
      'Landscaping': 'Repairs & Maintenance',
      'Cleaning': 'Repairs & Maintenance',
      'Legal & Professional': 'Legal & Professional Fees',
      'Other Expenses': 'Other Miscellaneous Service Cost',
      'Advertising': 'Advertising',
      'Depreciation Expense': 'Depreciation',
      // Cash account
      'Operating Cash': 'Checking'
    };
    
    const getQboAccountName = (ourAccountName) => {
      return qboAccountMapping[ourAccountName] || 'Other Miscellaneous Service Cost';
    };
    
    // Build journal entry
    const lines = [];
    
    for (const rev of totals.revenue) {
      lines.push({
        Description: `${rev.accountName} - ${period}`,
        Amount: Math.abs(rev.amount).toFixed(2),
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: rev.qboAccountId ? { value: rev.qboAccountId } : { name: getQboAccountName(rev.accountName) }
        }
      });
    }
    
    for (const exp of totals.expenses) {
      lines.push({
        Description: `${exp.accountName} - ${period}`,
        Amount: Math.abs(exp.amount).toFixed(2),
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: exp.qboAccountId ? { value: exp.qboAccountId } : { name: getQboAccountName(exp.accountName) }
        }
      });
    }
    
    // Add equity plug to balance the journal entry
    const netIncome = totalIncome - totalExpenses;
    if (Math.abs(netIncome) > 0.01) {
      lines.push({
        Description: `Net Income Equity Plug - ${period}`,
        Amount: Math.abs(netIncome).toFixed(2),
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: netIncome > 0 ? 'Debit' : 'Credit',
          AccountRef: { name: "Opening Balance Equity" }  // Standard QBO account
        }
      });
    }
    
    const docNumber = `FS-${property_code || 'PROP'}-${period}`;
    
    const journalEntry = {
      DocNumber: docNumber,
      TxnDate: `${period}-01`,
      PrivateNote: `Monthly bookkeeping sync from app for ${period}`,
      Line: lines
    };
    
    // Post to QuickBooks
    const qboResponse = await makeQuickBooksRequest('/journalentry', 'POST', journalEntry);
    
    if (!qboResponse || !qboResponse.JournalEntry) {
      throw new Error('Invalid response from QuickBooks');
    }
    
    const qboJournalId = qboResponse.JournalEntry.Id;
    const txnNumber = qboResponse.JournalEntry.DocNumber;
    
    // Save sync record to Firestore
    try {
      const { getFirestore } = await import('./firebase-admin.js');
      const db = getFirestore();
      
      await db.collection('users').doc(userId)
        .collection('bookkeeping').doc('data').collection('qboSyncs')
        .add({
          period,
          qboJournalId,
          txnNumber,
          totalIncome,
          totalExpenses,
          netIncome,
          lineCount: lines.length,
          pushedBy: posted_by || userId,
          pushedAt: new Date().toISOString()
        });
    } catch (syncError) {
      console.warn('[QuickBooks] Failed to save sync record:', syncError);
    }
    
    res.json({
      ok: true,
      qbo_journal_id: qboJournalId,
      txn_number: txnNumber,
      summary: {
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netIncome: Math.round(netIncome * 100) / 100,
        lineCount: lines.length
      }
    });
    
  } catch (error) {
    console.error('[QuickBooks Firestore] Push error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/quickbooks/firestore/import
 * Import QuickBooks transactions into user's Firestore bookkeeping
 */
router.post('/firestore/import', async (req, res) => {
  try {
    const userId = await verifyFirebaseAuth(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Firebase auth required' });
    }
    
    const { transactions } = req.body;
    
    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ ok: false, error: 'Missing transactions array' });
    }
    
    const { getFirestore } = await import('./firebase-admin.js');
    const { FieldValue } = await import('firebase-admin/firestore');
    const db = getFirestore();
    
    const entriesRef = db.collection('users').doc(userId)
      .collection('bookkeeping').doc('data').collection('journalEntries');
    const accountsRef = db.collection('users').doc(userId)
      .collection('bookkeeping').doc('data').collection('accounts');
    
    const now = new Date().toISOString();
    let imported = 0;
    let skipped = 0;
    
    for (const txn of transactions) {
      // Check if already imported
      const existingSnap = await entriesRef
        .where('source', '==', 'QBO_IMPORT')
        .where('sourceRef', '==', txn.qboId)
        .limit(1)
        .get();
      
      if (!existingSnap.empty) {
        skipped++;
        continue;
      }
      
      // Build journal lines
      const lines = [];
      
      if (txn.type === 'income') {
        lines.push({
          accountCode: '1000',
          accountName: 'Operating Cash',
          amount: txn.amount,
          dc: 'D'
        });
        lines.push({
          accountCode: txn.accountCode || '4000',
          accountName: txn.accountName || 'Rental Income',
          amount: txn.amount,
          dc: 'C'
        });
      } else {
        lines.push({
          accountCode: txn.accountCode || '5000',
          accountName: txn.accountName || 'Repairs & Maintenance',
          amount: txn.amount,
          dc: 'D'
        });
        lines.push({
          accountCode: '1000',
          accountName: 'Operating Cash',
          amount: txn.amount,
          dc: 'C'
        });
      }
      
      const journalEntry = {
        entryDate: txn.date,
        memo: txn.memo,
        source: 'QBO_IMPORT',
        sourceRef: txn.qboId,
        lines,
        totalDebits: txn.amount,
        totalCredits: txn.amount,
        isBalanced: true,
        postedBy: 'qbo_import',
        createdAt: now,
        updatedAt: now
      };
      
      // Use transaction to update balances atomically
      await db.runTransaction(async (transaction) => {
        const entryDoc = entriesRef.doc();
        transaction.set(entryDoc, journalEntry);
        
        for (const line of lines) {
          const accountRef = accountsRef.doc(line.accountCode);
          const accountSnap = await transaction.get(accountRef);
          
          if (accountSnap.exists) {
            const account = accountSnap.data();
            let balanceChange = line.amount;
            
            if (['LIABILITY', 'EQUITY', 'REVENUE'].includes(account.type)) {
              balanceChange = line.dc === 'C' ? line.amount : -line.amount;
            } else {
              balanceChange = line.dc === 'D' ? line.amount : -line.amount;
            }
            
            transaction.update(accountRef, {
              balance: FieldValue.increment(balanceChange),
              updatedAt: now
            });
          }
        }
      });
      
      imported++;
    }
    
    res.json({ ok: true, imported, skipped });
    
  } catch (error) {
    console.error('[QuickBooks Firestore] Import error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// Individual Transaction Sync Routes
// ============================================================================

/**
 * Get individual transactions from Firestore for a month
 */
async function getFirestoreIndividualTransactions(userId, month) {
  try {
    const { getFirestore } = await import('./firebase-admin.js');
    const db = getFirestore();
    
    const startDate = `${month}-01`;
    const [year, monthNum] = month.split('-').map(Number);
    const endDate = new Date(year, monthNum, 0).toISOString().split('T')[0];
    
    // Get journal entries for the month
    const entriesRef = db.collection('users').doc(userId)
      .collection('bookkeeping').doc('data').collection('journalEntries');
    
    const entriesSnap = await entriesRef
      .where('entryDate', '>=', startDate)
      .where('entryDate', '<=', endDate)
      .orderBy('entryDate', 'asc')
      .get();
    
    // Get accounts for lookup
    const accountsRef = db.collection('users').doc(userId)
      .collection('bookkeeping').doc('data').collection('accounts');
    const accountsSnap = await accountsRef.get();
    const accountMap = new Map(accountsSnap.docs.map(d => [d.id, d.data()]));
    
    const transactions = [];
    
    for (const doc of entriesSnap.docs) {
      const entry = doc.data();
      const entryId = doc.id;
      
      // Find the primary line (expense or income line, not the cash offset)
      for (const line of (entry.lines || [])) {
        const account = accountMap.get(line.accountCode);
        if (!account) continue;
        
        // Skip cash/bank accounts - we want the category accounts
        if (account.type === 'ASSET' && account.subtype === 'Bank') continue;
        
        if (account.type === 'EXPENSE') {
          const amount = line.dc === 'D' ? line.amount : -line.amount;
          if (Math.abs(amount) > 0.005) {
            transactions.push({
              id: entryId,
              date: entry.entryDate,
              description: entry.memo || `${account.name} expense`,
              category: account.name,
              categoryCode: line.accountCode,
              amount: Math.abs(amount),
              type: 'expense',
              source: entry.source,
              sourceRef: entry.sourceRef,
              qboSynced: entry.qboSyncedAt ? true : false
            });
          }
        } else if (account.type === 'REVENUE') {
          const amount = line.dc === 'C' ? line.amount : -line.amount;
          if (Math.abs(amount) > 0.005) {
            transactions.push({
              id: entryId,
              date: entry.entryDate,
              description: entry.memo || `${account.name} income`,
              category: account.name,
              categoryCode: line.accountCode,
              amount: Math.abs(amount),
              type: 'income',
              source: entry.source,
              sourceRef: entry.sourceRef,
              qboSynced: entry.qboSyncedAt ? true : false
            });
          }
        }
      }
    }
    
    return transactions;
  } catch (error) {
    console.error('[QuickBooks] Get individual transactions error:', error);
    return [];
  }
}

/**
 * GET /api/quickbooks/firestore/sync/individual/preview/:period
 * Preview individual transactions that will be synced to QuickBooks
 */
router.get('/firestore/sync/individual/preview/:period', async (req, res) => {
  try {
    const userId = await verifyFirebaseAuth(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Firebase auth required' });
    }
    
    const { period } = req.params;
    
    const transactions = await getFirestoreIndividualTransactions(userId, period);
    
    if (transactions.length === 0) {
      return res.json({
        ok: false,
        error: 'no_activity',
        message: 'No transactions found for this month in your bookkeeping'
      });
    }
    
    const expenses = transactions.filter(t => t.type === 'expense');
    const income = transactions.filter(t => t.type === 'income');
    const totalExpenses = expenses.reduce((sum, t) => sum + t.amount, 0);
    const totalIncome = income.reduce((sum, t) => sum + t.amount, 0);
    const unsyncedCount = transactions.filter(t => !t.qboSynced).length;
    
    res.json({
      ok: true,
      transactions,
      summary: {
        totalTransactions: transactions.length,
        expenseCount: expenses.length,
        incomeCount: income.length,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        totalIncome: Math.round(totalIncome * 100) / 100,
        netIncome: Math.round((totalIncome - totalExpenses) * 100) / 100,
        unsyncedCount,
        period
      }
    });
    
  } catch (error) {
    console.error('[QuickBooks] Individual preview error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/quickbooks/firestore/sync/individual/push/:period
 * Push individual transactions to QuickBooks as Expenses and Deposits
 */
router.post('/firestore/sync/individual/push/:period', async (req, res) => {
  try {
    const userId = await verifyFirebaseAuth(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Firebase auth required' });
    }
    
    const { period } = req.params;
    const { skipSynced = true } = req.body;
    
    const transactions = await getFirestoreIndividualTransactions(userId, period);
    
    if (transactions.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'no_activity',
        message: 'No transactions found for this month'
      });
    }
    
    const { getFirestore } = await import('./firebase-admin.js');
    const db = getFirestore();
    const entriesRef = db.collection('users').doc(userId)
      .collection('bookkeeping').doc('data').collection('journalEntries');
    
    const results = {
      pushed: 0,
      skipped: 0,
      failed: 0,
      errors: []
    };
    
    // First, get a valid bank account and expense/income accounts from QuickBooks
    let bankAccountRef = null;
    let expenseAccountRef = null;
    let incomeAccountRef = null;
    
    try {
      // Get bank account
      const bankQuery = await makeQuickBooksRequest(
        "/query?query=" + encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1"),
        'GET'
      );
      if (bankQuery?.QueryResponse?.Account?.[0]) {
        bankAccountRef = { value: bankQuery.QueryResponse.Account[0].Id };
        console.log('[QuickBooks] Found bank account:', bankQuery.QueryResponse.Account[0].Name);
      }
      
      // Get expense account  
      const expenseQuery = await makeQuickBooksRequest(
        "/query?query=" + encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1"),
        'GET'
      );
      if (expenseQuery?.QueryResponse?.Account?.[0]) {
        expenseAccountRef = { value: expenseQuery.QueryResponse.Account[0].Id };
        console.log('[QuickBooks] Found expense account:', expenseQuery.QueryResponse.Account[0].Name);
      }
      
      // Get income account
      const incomeQuery = await makeQuickBooksRequest(
        "/query?query=" + encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1"),
        'GET'
      );
      if (incomeQuery?.QueryResponse?.Account?.[0]) {
        incomeAccountRef = { value: incomeQuery.QueryResponse.Account[0].Id };
        console.log('[QuickBooks] Found income account:', incomeQuery.QueryResponse.Account[0].Name);
      }
    } catch (e) {
      console.error('[QuickBooks] Error fetching accounts:', e.message);
      return res.status(400).json({
        ok: false,
        error: 'qbo_not_connected',
        message: 'Could not connect to QuickBooks. Please reconnect your account.'
      });
    }
    
    if (!bankAccountRef) {
      return res.status(400).json({
        ok: false,
        error: 'no_bank_account',
        message: 'No bank account found in QuickBooks. Please create a bank account first.'
      });
    }
    
    for (const txn of transactions) {
      // Skip already synced if requested
      if (skipSynced && txn.qboSynced) {
        results.skipped++;
        continue;
      }
      
      try {
        let qboResponse;
        
        if (txn.type === 'expense') {
          // Create a Purchase (expense) in QuickBooks
          const purchase = {
            PaymentType: 'Cash',
            TxnDate: txn.date,
            PrivateNote: `Synced from bookkeeping app - ${txn.source || 'manual'}`,
            Line: [{
              Description: txn.description,
              Amount: txn.amount,
              DetailType: 'AccountBasedExpenseLineDetail',
              AccountBasedExpenseLineDetail: {
                AccountRef: expenseAccountRef || { value: '1' }  // Use found account or fallback
              }
            }],
            AccountRef: bankAccountRef
          };
          
          console.log('[QuickBooks] Creating Purchase:', JSON.stringify(purchase, null, 2));
          qboResponse = await makeQuickBooksRequest('/purchase', 'POST', purchase);
          
        } else if (txn.type === 'income') {
          // Create a Deposit in QuickBooks
          const deposit = {
            TxnDate: txn.date,
            PrivateNote: `Synced from bookkeeping app - ${txn.source || 'manual'}`,
            DepositToAccountRef: bankAccountRef,
            Line: [{
              Description: txn.description,
              Amount: txn.amount,
              DetailType: 'DepositLineDetail',
              DepositLineDetail: {
                AccountRef: incomeAccountRef || { value: '1' }  // Use found account or fallback
              }
            }]
          };
          
          console.log('[QuickBooks] Creating Deposit:', JSON.stringify(deposit, null, 2));
          qboResponse = await makeQuickBooksRequest('/deposit', 'POST', deposit);
        }
        
        // Mark as synced in Firestore
        if (qboResponse && txn.id) {
          const qboId = qboResponse.Purchase?.Id || qboResponse.Deposit?.Id;
          await entriesRef.doc(txn.id).update({
            qboSyncedAt: new Date().toISOString(),
            qboTxnId: qboId,
            qboTxnType: txn.type === 'expense' ? 'Purchase' : 'Deposit'
          });
        }
        
        results.pushed++;
        
      } catch (txnError) {
        console.error(`[QuickBooks] Failed to push transaction ${txn.id}:`, txnError.message);
        results.failed++;
        results.errors.push({
          id: txn.id,
          description: txn.description,
          error: txnError.message
        });
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    res.json({
      ok: results.failed === 0,
      ...results,
      summary: {
        total: transactions.length,
        pushed: results.pushed,
        skipped: results.skipped,
        failed: results.failed
      }
    });
    
  } catch (error) {
    console.error('[QuickBooks] Individual push error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
