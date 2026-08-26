/**
 * Income Verification using Stripe Financial Connections
 * Analyzes bank transactions to determine income patterns
 */

import express from 'express';
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// Initialize Stripe with environment variable only (no fallback)
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Storage for tenant income verification data
const STORAGE_DIR = path.join(process.cwd(), 'server', 'data', 'income-verification');
const TENANT_DATA_FILE = path.join(STORAGE_DIR, 'tenant-income.json');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Initialize storage file
if (!fs.existsSync(TENANT_DATA_FILE)) {
  fs.writeFileSync(TENANT_DATA_FILE, JSON.stringify({}, null, 2));
}

// Helper functions for data storage
const readTenantData = () => {
  try {
    return JSON.parse(fs.readFileSync(TENANT_DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('[Income Verification] Error reading tenant data:', error);
    return {};
  }
};

const writeTenantData = (data) => {
  try {
    fs.writeFileSync(TENANT_DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[Income Verification] Error writing tenant data:', error);
  }
};

/**
 * Analyze transactions to determine income patterns
 */
function analyzeIncomeFromTransactions(transactions) {
  console.log('[Income Verification] Analyzing', transactions.length, 'transactions');
  
  // Filter for income transactions (credits)
  const incomeTransactions = transactions.filter(txn => txn.amount < 0); // Negative amounts are credits in Stripe
  
  // Group by merchant/description to find regular deposits
  const depositPatterns = {};
  incomeTransactions.forEach(txn => {
    const key = txn.description || txn.merchant_name || 'Unknown';
    if (!depositPatterns[key]) {
      depositPatterns[key] = [];
    }
    depositPatterns[key].push({
      amount: Math.abs(txn.amount) / 100, // Convert to dollars
      date: new Date(txn.transacted_at * 1000)
    });
  });
  
  // Identify regular income sources (appearing 2+ times)
  const regularIncome = [];
  Object.entries(depositPatterns).forEach(([source, deposits]) => {
    if (deposits.length >= 2) {
      const amounts = deposits.map(d => d.amount);
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const stdDev = Math.sqrt(amounts.reduce((sum, amt) => sum + Math.pow(amt - avgAmount, 2), 0) / amounts.length);
      
      regularIncome.push({
        source,
        frequency: deposits.length,
        averageAmount: avgAmount,
        consistency: stdDev < (avgAmount * 0.2) ? 'high' : stdDev < (avgAmount * 0.5) ? 'medium' : 'low',
        deposits: deposits.sort((a, b) => b.date.getTime() - a.date.getTime())
      });
    }
  });
  
  // Sort by frequency and amount
  regularIncome.sort((a, b) => (b.frequency * b.averageAmount) - (a.frequency * a.averageAmount));
  
  // Calculate monthly income
  const totalIncome = incomeTransactions.reduce((sum, txn) => sum + Math.abs(txn.amount) / 100, 0);
  
  // Determine time period covered
  if (transactions.length > 0) {
    const dates = transactions.map(t => t.transacted_at * 1000);
    const oldestDate = Math.min(...dates);
    const newestDate = Math.max(...dates);
    const daysCovered = (newestDate - oldestDate) / (1000 * 60 * 60 * 24);
    const monthsCovered = daysCovered / 30;
    
    const monthlyIncome = monthsCovered > 0 ? totalIncome / monthsCovered : totalIncome;
    
    // Determine employment status based on regular deposits
    let employmentStatus = 'Unknown';
    if (regularIncome.length > 0) {
      const primarySource = regularIncome[0];
      if (primarySource.consistency === 'high' && primarySource.frequency >= 2) {
        employmentStatus = 'Employed';
      } else if (primarySource.consistency === 'medium') {
        employmentStatus = 'Self-Employed';
      } else {
        employmentStatus = 'Irregular Income';
      }
    }
    
    return {
      monthlyIncome: Math.round(monthlyIncome),
      totalIncome: Math.round(totalIncome),
      employmentStatus,
      regularIncome: regularIncome.slice(0, 3), // Top 3 sources
      periodCovered: {
        days: Math.round(daysCovered),
        months: Math.round(monthsCovered * 10) / 10
      },
      transactionCount: transactions.length,
      incomeTransactionCount: incomeTransactions.length,
      analyzedAt: new Date().toISOString()
    };
  }
  
  return {
    monthlyIncome: 0,
    totalIncome: 0,
    employmentStatus: 'Unknown',
    regularIncome: [],
    periodCovered: { days: 0, months: 0 },
    transactionCount: 0,
    incomeTransactionCount: 0,
    analyzedAt: new Date().toISOString()
  };
}

/**
 * POST /api/income-verification/analyze
 * Analyze a tenant's bank account transactions for income verification
 */
router.post('/analyze', async (req, res) => {
  try {
    const { tenantId, financialConnectionsAccountId } = req.body;
    
    if (!tenantId || !financialConnectionsAccountId) {
      return res.status(400).json({
        ok: false,
        error: 'tenantId and financialConnectionsAccountId are required'
      });
    }
    
    console.log('[Income Verification] Analyzing income for tenant:', tenantId);
    console.log('[Income Verification] Financial Connections Account:', financialConnectionsAccountId);
    
    try {
      // First, subscribe to transactions for this account
      console.log('[Income Verification] Subscribing to transactions...');
      await stripe.financialConnections.accounts.subscribe(
        financialConnectionsAccountId,
        { features: ['transactions'] }
      );
      console.log('[Income Verification] Successfully subscribed to transactions');
      
      // Wait a moment for subscription to process
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (subscribeError) {
      console.log('[Income Verification] Subscription note:', subscribeError.message);
      // Continue anyway - account might already be subscribed
    }
    
    // Fetch transactions from Stripe Financial Connections
    const transactions = await stripe.financialConnections.transactions.list({
      account: financialConnectionsAccountId,
      limit: 100 // Last 100 transactions
    });
    
    console.log('[Income Verification] Retrieved', transactions.data.length, 'transactions');
    
    // Analyze transactions for income patterns
    const analysis = analyzeIncomeFromTransactions(transactions.data);
    
    // Store the results
    const tenantData = readTenantData();
    tenantData[tenantId] = {
      ...analysis,
      financialConnectionsAccountId,
      verified: true,
      lastUpdated: new Date().toISOString()
    };
    writeTenantData(tenantData);
    
    res.json({
      ok: true,
      analysis,
      message: 'Income verification completed successfully'
    });
    
    console.log('[Income Verification] Analysis complete:', {
      monthlyIncome: analysis.monthlyIncome,
      employmentStatus: analysis.employmentStatus
    });
    
  } catch (error) {
    console.error('[Income Verification] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to analyze income'
    });
  }
});

/**
 * GET /api/income-verification/tenant/:tenantId
 * Get stored income verification data for a tenant
 */
router.get('/tenant/:tenantId', (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantData = readTenantData();
    
    if (!tenantData[tenantId]) {
      return res.json({
        ok: true,
        verified: false,
        message: 'No income verification data found for this tenant'
      });
    }
    
    res.json({
      ok: true,
      verified: true,
      data: tenantData[tenantId]
    });
    
  } catch (error) {
    console.error('[Income Verification] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to retrieve income data'
    });
  }
});

/**
 * GET /api/income-verification/all-tenants
 * Get all tenants with their income verification status
 */
router.get('/all-tenants', (req, res) => {
  try {
    const tenantData = readTenantData();
    
    // Convert to array format for easier frontend consumption
    const tenants = Object.entries(tenantData).map(([tenantId, data]) => ({
      tenantId,
      ...data
    }));
    
    res.json({
      ok: true,
      tenants,
      count: tenants.length
    });
    
  } catch (error) {
    console.error('[Income Verification] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to retrieve tenant data'
    });
  }
});

export default router;
