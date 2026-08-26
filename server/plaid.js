/**
 * Plaid Bank Integration for Automatic Bookkeeping
 * Connects user bank accounts to auto-populate transactions
 */

import express from 'express';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import fs from 'fs';
import path from 'path';
import { encrypt, decrypt } from './utils/encryption.js';
import { securityLog, errorLog, EventType, getClientIp } from './utils/audit-logger.js';

const router = express.Router();

// Plaid Configuration — credentials come from env, never from source
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET = process.env.PLAID_SECRET || '';
const PLAID_ENV = PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'] || PlaidEnvironments.sandbox;

console.log('[Plaid] Initializing. Environment:', PLAID_ENV, 'Client ID set:', Boolean(PLAID_CLIENT_ID));

const configuration = new Configuration({
  basePath: PLAID_ENV,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

// Storage for access tokens (in production, use a database)
const STORAGE_DIR = path.join(process.cwd(), 'server', 'data', 'plaid');
const TOKENS_FILE = path.join(STORAGE_DIR, 'access-tokens.json');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Initialize tokens file
if (!fs.existsSync(TOKENS_FILE)) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({}, null, 2));
}

// Helper functions
const readTokens = () => {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (error) {
    console.error('[Plaid] Error reading tokens:', error);
    return {};
  }
};

const writeTokens = (tokens) => {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch (error) {
    console.error('[Plaid] Error writing tokens:', error);
  }
};

/**
 * POST /api/plaid/create-link-token
 * Create a Link token for initializing Plaid Link
 */
router.post('/create-link-token', async (req, res) => {
  try {
    const { userId, propertyId } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required' });
    }

    const configs = {
      user: {
        client_user_id: userId,
      },
      client_name: 'Renaissance Realty',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    };

    const createTokenResponse = await plaidClient.linkTokenCreate(configs);
    
    res.json({
      ok: true,
      link_token: createTokenResponse.data.link_token,
      expiration: createTokenResponse.data.expiration
    });

    securityLog(EventType.SENSITIVE_DATA_ACCESS, userId, {
      action: 'plaid_link_token_created',
      propertyId
    }, getClientIp(req));
    
    console.log('[Plaid] Link token created for user:', userId);
  } catch (error) {
    errorLog(EventType.PLAID_API_ERROR, userId || 'unknown', error, getClientIp(req));
    console.error('[Plaid] Error creating link token:', error.response?.data || error);
    res.status(500).json({ 
      ok: false, 
      error: error.response?.data?.error_message || error.message 
    });
  }
});

/**
 * POST /api/plaid/exchange-public-token
 * Exchange public token for access token after user connects their bank
 */
router.post('/exchange-public-token', async (req, res) => {
  try {
    const { public_token, userId, propertyId } = req.body;

    if (!public_token || !userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'public_token and userId are required' 
      });
    }

    // Exchange public token for access token
    const tokenResponse = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const accessToken = tokenResponse.data.access_token;
    const itemId = tokenResponse.data.item_id;

    // Get account information
    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accounts = accountsResponse.data.accounts;

    // Store access token
    const tokens = readTokens();
    if (!tokens[userId]) {
      tokens[userId] = {};
    }

    const connectionId = `conn-${Date.now()}`;
    tokens[userId][connectionId] = {
      accessToken: encrypt(accessToken), // Encrypt access token at rest
      itemId,
      propertyId: propertyId || null,
      accounts: accounts.map(acc => ({
        id: acc.account_id,
        name: acc.name,
        type: acc.type,
        subtype: acc.subtype,
        mask: acc.mask
      })),
      createdAt: new Date().toISOString()
    };

    writeTokens(tokens);
    
    console.log('[Plaid] ✅ Access token encrypted and stored securely');

    securityLog(EventType.BANK_CONNECTED, userId, {
      action: 'bank_account_connected',
      connectionId,
      itemId,
      accountCount: accounts.length,
      propertyId
    }, getClientIp(req));

    res.json({
      ok: true,
      connectionId,
      itemId,
      accounts: accounts.map(acc => ({
        id: acc.account_id,
        name: acc.name,
        type: acc.type,
        subtype: acc.subtype,
        mask: acc.mask,
        balance: acc.balances
      })),
      message: 'Bank account connected successfully'
    });

    console.log('[Plaid] Bank account connected for user:', userId);
  } catch (error) {
    console.error('[Plaid] Error exchanging public token:', error.response?.data || error);
    res.status(500).json({ 
      ok: false, 
      error: error.response?.data?.error_message || error.message 
    });
  }
});

/**
 * GET /api/plaid/accounts/:userId
 * Get all connected bank accounts for a user
 */
router.get('/accounts/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const tokens = readTokens();
    
    const userConnections = tokens[userId] || {};
    
    const connections = Object.entries(userConnections).map(([connectionId, data]) => ({
      connectionId,
      itemId: data.itemId,
      propertyId: data.propertyId,
      accounts: data.accounts,
      createdAt: data.createdAt
    }));

    res.json({
      ok: true,
      connections
    });
  } catch (error) {
    console.error('[Plaid] Error fetching accounts:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/plaid/sync-transactions
 * Sync transactions from Plaid and populate bookkeeping
 */
router.post('/sync-transactions', async (req, res) => {
  try {
    const { userId, connectionId, startDate, endDate, propertyId } = req.body;

    if (!userId || !connectionId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId and connectionId are required' 
      });
    }

    const tokens = readTokens();
    const connection = tokens[userId]?.[connectionId];

    if (!connection) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Bank connection not found' 
      });
    }

    // Default to last 30 days if not specified
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    // Get transactions from Plaid (decrypt access token)
    const decryptedToken = decrypt(connection.accessToken);
    const transactionsResponse = await plaidClient.transactionsGet({
      access_token: decryptedToken,
      start_date: start,
      end_date: end,
      options: {
        count: 500,
        offset: 0,
      },
    });

    const plaidTransactions = transactionsResponse.data.transactions;

    // Transform Plaid transactions to bookkeeping format
    const bookkeepingTransactions = plaidTransactions.map(txn => {
      // Categorize transaction
      const category = categorizeTransaction(txn);
      const type = txn.amount > 0 ? 'expense' : 'income';
      
      return {
        id: `plaid-${txn.transaction_id}`,
        date: txn.date,
        description: txn.name,
        category,
        type,
        amount: Math.abs(txn.amount),
        propertyId: propertyId || connection.propertyId || null,
        status: 'Cleared',
        notes: `Auto-imported from ${txn.merchant_name || 'bank'} via Plaid`,
        plaidData: {
          transactionId: txn.transaction_id,
          accountId: txn.account_id,
          merchantName: txn.merchant_name,
          paymentChannel: txn.payment_channel,
          categories: txn.category
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });

    // Import to Firestore bookkeeping system (PRIMARY)
    const { postBankTransactionToFirestore, ensureBookkeepingInitialized } = await import('./bookkeeping-firestore.js');
    
    // Ensure user has bookkeeping initialized
    await ensureBookkeepingInitialized(userId);
    
    let imported = 0;
    let skipped = 0;
    const errors = [];
    
    for (const txn of bookkeepingTransactions) {
      try {
        // Map category to account code
        const categoryToAccountCode = {
          'rental-income': '4000',
          'late-fees': '4100',
          'repairs': '5000',
          'utilities': '5100',
          'insurance': '5200',
          'property-tax': '5300',
          'management': '5400',
          'mortgage': '5500',
          'hoa': '5600',
          'landscaping': '5700',
          'cleaning': '5800',
          'other-income': '4900',
          'other-expense': '5999'
        };
        
        const result = await postBankTransactionToFirestore(userId, {
          bankTxnId: txn.id,
          date: txn.date,
          amount: txn.amount,
          description: txn.description,
          payee: txn.plaidData?.merchantName || txn.description,
          isDebit: txn.type === 'expense',
          propertyId: txn.propertyId,
          categoryCode: categoryToAccountCode[txn.category] || (txn.type === 'income' ? '4900' : '5999'),
          source: 'PLAID'
        });
        
        if (result.ok) {
          imported++;
        } else if (result.skipped) {
          skipped++;
        }
      } catch (txnError) {
        console.error('[Plaid] Error posting transaction to Firestore:', txnError.message);
        errors.push({ id: txn.id, error: txnError.message });
      }
    }
    
    // Also save to local JSON file (legacy backup)
    const importResults = await importTransactionsToBookkeeping(bookkeepingTransactions);

    res.json({
      ok: true,
      synced: plaidTransactions.length,
      imported: imported,
      skipped: skipped,
      legacyImported: importResults.imported,
      transactions: bookkeepingTransactions,
      errors: errors.length > 0 ? errors : undefined,
      message: `Synced ${plaidTransactions.length} transactions: ${imported} to Firestore, ${skipped} duplicates`
    });

    console.log('[Plaid] Synced', plaidTransactions.length, 'transactions for user:', userId);
  } catch (error) {
    console.error('[Plaid] Error syncing transactions:', error.response?.data || error);
    res.status(500).json({ 
      ok: false, 
      error: error.response?.data?.error_message || error.message 
    });
  }
});

/**
 * DELETE /api/plaid/disconnect/:userId/:connectionId
 * Disconnect a bank account
 */
router.delete('/disconnect/:userId/:connectionId', async (req, res) => {
  try {
    const { userId, connectionId } = req.params;
    
    const tokens = readTokens();
    const connection = tokens[userId]?.[connectionId];

    if (!connection) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Bank connection not found' 
      });
    }

    // Remove access from Plaid (decrypt token)
    const decryptedToken = decrypt(connection.accessToken);
    await plaidClient.itemRemove({
      access_token: decryptedToken,
    });

    // Remove from storage
    delete tokens[userId][connectionId];
    if (Object.keys(tokens[userId]).length === 0) {
      delete tokens[userId];
    }
    writeTokens(tokens);

    res.json({
      ok: true,
      message: 'Bank account disconnected successfully'
    });

    console.log('[Plaid] Bank account disconnected for user:', userId);
  } catch (error) {
    console.error('[Plaid] Error disconnecting account:', error.response?.data || error);
    res.status(500).json({ 
      ok: false, 
      error: error.response?.data?.error_message || error.message 
    });
  }
});

/**
 * GET /api/plaid/balances/:userId/:connectionId
 * Get current account balances
 */
router.get('/balances/:userId/:connectionId', async (req, res) => {
  try {
    const { userId, connectionId } = req.params;
    
    const tokens = readTokens();
    const connection = tokens[userId]?.[connectionId];

    if (!connection) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Bank connection not found' 
      });
    }

    // Get balances (decrypt token)
    const decryptedToken = decrypt(connection.accessToken);
    const balancesResponse = await plaidClient.accountsBalanceGet({
      access_token: decryptedToken,
    });

    const balances = balancesResponse.data.accounts.map(acc => ({
      accountId: acc.account_id,
      name: acc.name,
      type: acc.type,
      subtype: acc.subtype,
      mask: acc.mask,
      balance: acc.balances
    }));

    res.json({
      ok: true,
      balances
    });
  } catch (error) {
    console.error('[Plaid] Error fetching balances:', error.response?.data || error);
    res.status(500).json({ 
      ok: false, 
      error: error.response?.data?.error_message || error.message 
    });
  }
});

// Helper function to categorize transactions
function categorizeTransaction(plaidTransaction) {
  const categories = plaidTransaction.category || [];
  const name = plaidTransaction.name?.toLowerCase() || '';
  
  // Map Plaid categories to bookkeeping categories
  if (categories.includes('Payment') && name.includes('rent')) {
    return 'rent-income';
  }
  if (categories.includes('Service') && (name.includes('repair') || name.includes('maintenance'))) {
    return 'maintenance';
  }
  if (categories.includes('Service') && name.includes('repair')) {
    return 'repairs';
  }
  if (categories.includes('Service') && (name.includes('electric') || name.includes('water') || name.includes('gas'))) {
    return 'utilities';
  }
  if (categories.includes('Service') && name.includes('insurance')) {
    return 'insurance';
  }
  if (name.includes('property tax') || name.includes('tax')) {
    return 'property-tax';
  }
  if (name.includes('hoa') || name.includes('homeowner')) {
    return 'hoa';
  }
  if (name.includes('mortgage') || name.includes('loan payment')) {
    return 'mortgage';
  }
  if (name.includes('management') || name.includes('property management')) {
    return 'management-fees';
  }
  if (name.includes('legal') || name.includes('attorney')) {
    return 'legal';
  }
  if (name.includes('advertising') || name.includes('marketing')) {
    return 'advertising';
  }
  
  // Default categories
  return plaidTransaction.amount > 0 ? 'other-expense' : 'other-income';
}

// Helper function to import transactions to bookkeeping
async function importTransactionsToBookkeeping(transactions) {
  const TRANSACTIONS_FILE = path.join(process.cwd(), 'server', 'data', 'bookkeeping', 'transactions.json');
  
  let existingTransactions = [];
  try {
    existingTransactions = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
  } catch (error) {
    console.error('[Plaid] Error reading transactions:', error);
  }

  const existingIds = new Set(existingTransactions.map(t => t.id));
  const newTransactions = transactions.filter(t => !existingIds.has(t.id));
  
  if (newTransactions.length > 0) {
    existingTransactions.push(...newTransactions);
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(existingTransactions, null, 2));
  }

  return {
    imported: newTransactions.length,
    skipped: transactions.length - newTransactions.length
  };
}

export default router;
