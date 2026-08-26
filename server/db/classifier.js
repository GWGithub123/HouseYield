/**
 * Classification Rules Engine
 * Determines posting type from bank transaction characteristics
 * Tax-aware categorization for Schedule E preparation
 */

import { getDb } from './connection.js';

/**
 * Posting types and their templates
 */
export const POSTING_TYPES = {
  RENT_RECEIPT: 'RENT_RECEIPT',
  VENDOR_EXPENSE: 'VENDOR_EXPENSE',
  MORTGAGE_PAYMENT: 'MORTGAGE_PAYMENT',
  SECURITY_DEPOSIT_RECEIPT: 'SECURITY_DEPOSIT_RECEIPT',
  SECURITY_DEPOSIT_RETURN: 'SECURITY_DEPOSIT_RETURN',
  TRANSFER: 'TRANSFER',
  OWNER_CONTRIBUTION: 'OWNER_CONTRIBUTION',
  OWNER_DRAW: 'OWNER_DRAW',
  CAPEX: 'CAPEX',
  REFUND: 'REFUND',
  // Additional tax-relevant types
  INSURANCE_PAYMENT: 'INSURANCE_PAYMENT',
  PROPERTY_TAX: 'PROPERTY_TAX',
  UTILITIES: 'UTILITIES',
  MANAGEMENT_FEE: 'MANAGEMENT_FEE',
  LEGAL_PROFESSIONAL: 'LEGAL_PROFESSIONAL',
  ADVERTISING: 'ADVERTISING',
  HOA_FEES: 'HOA_FEES',
  LATE_FEE_INCOME: 'LATE_FEE_INCOME',
  APPLICATION_FEE: 'APPLICATION_FEE'
};

/**
 * Tax category mappings - Maps expense types to Schedule E line items
 */
export const TAX_CATEGORIES = {
  '4000': { scheduleELine: 3, description: 'Rents Received' },
  '4010': { scheduleELine: 4, description: 'Late Fees/Other Income' },
  '4020': { scheduleELine: 4, description: 'Other Income' },
  '5000': { scheduleELine: 14, description: 'Repairs' },
  '5010': { scheduleELine: 17, description: 'Utilities' },
  '5020': { scheduleELine: 9, description: 'Insurance' },
  '5030': { scheduleELine: 16, description: 'Taxes' },
  '5040': { scheduleELine: 11, description: 'Management Fees' },
  '5050': { scheduleELine: 12, description: 'Mortgage Interest' },
  '5060': { scheduleELine: 13, description: 'Other Interest (HOA)' },
  '5070': { scheduleELine: 5, description: 'Advertising' },
  '5080': { scheduleELine: 15, description: 'Supplies' },
  '5090': { scheduleELine: 18, description: 'Depreciation' },
  '5100': { scheduleELine: 6, description: 'Auto and Travel' },
  '5110': { scheduleELine: 8, description: 'Commissions' },
  '5120': { scheduleELine: 10, description: 'Legal and Professional Fees' },
  '5999': { scheduleELine: 19, description: 'Other Expenses' }
};

/**
 * Classification rules (pattern matching)
 * Enhanced for tax-aware categorization
 */
const CLASSIFICATION_RULES = [
  // Mortgage Payments - Schedule E Line 12
  {
    name: 'Mortgage Payment',
    priority: 10,
    test: (txn) => {
      const lenders = ['WELLS FARGO', 'CHASE MTG', 'QUICKEN', 'ROCKET', 'MORTGAGE', 'NATIONSTAR', 
        'MR COOPER', 'PENNYMAC', 'FREEDOM MORTGAGE', 'CALIBER', 'GUILD MORTGAGE', 'USBANK HOME',
        'HOME POINT', 'LOANCARE', 'HOMEBRIDGE', 'FAIRWAY'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      return lenders.some(lender => desc.includes(lender)) && !txn.is_debit;
    },
    type: POSTING_TYPES.MORTGAGE_PAYMENT
  },
  // Insurance Payments - Schedule E Line 9
  {
    name: 'Insurance Payment',
    priority: 12,
    test: (txn) => {
      const insurers = ['STATE FARM', 'ALLSTATE', 'GEICO', 'PROGRESSIVE', 'FARMERS', 'LIBERTY MUTUAL',
        'USAA', 'NATIONWIDE', 'TRAVELERS', 'AMERICAN FAMILY', 'CHUBB', 'HOMESITE', 'LEMONADE',
        'HIPPO', 'LANDLORD INS', 'PROPERTY INSURANCE', 'INSURANCE', 'ASSURANT'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      return insurers.some(ins => desc.includes(ins)) && !txn.is_debit;
    },
    type: POSTING_TYPES.INSURANCE_PAYMENT,
    category: '5020'
  },
  // Property Tax - Schedule E Line 16
  {
    name: 'Property Tax Payment',
    priority: 13,
    test: (txn) => {
      const taxKeywords = ['PROPERTY TAX', 'COUNTY TAX', 'REAL ESTATE TAX', 'PROP TAX', 
        'TAX COLLECTOR', 'TREASURER', 'COUNTY ASSESSOR', 'CITY TAX'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      return taxKeywords.some(kw => desc.includes(kw)) && !txn.is_debit;
    },
    type: POSTING_TYPES.PROPERTY_TAX,
    category: '5030'
  },
  // HOA Fees - Schedule E Line 13 (Other Interest)
  {
    name: 'HOA/Condo Fees',
    priority: 14,
    test: (txn) => {
      const hoaKeywords = ['HOA', 'HOMEOWNER', 'CONDO ASSOC', 'MAINTENANCE FEE', 'ASSOCIATION FEE',
        'COMMUNITY FEE', 'COA', 'ASSESSMENT'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      return hoaKeywords.some(kw => desc.includes(kw)) && !txn.is_debit;
    },
    type: POSTING_TYPES.HOA_FEES,
    category: '5060'
  },
  // Management Fees - Schedule E Line 11
  {
    name: 'Property Management Fee',
    priority: 15,
    test: (txn) => {
      const mgmtKeywords = ['PROPERTY MANAGEMENT', 'PROP MGMT', 'MANAGEMENT FEE', 'MGMT FEE',
        'RENTAL MANAGEMENT', 'PM FEE', 'MANAGEMENT CO'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      return mgmtKeywords.some(kw => desc.includes(kw)) && !txn.is_debit;
    },
    type: POSTING_TYPES.MANAGEMENT_FEE,
    category: '5040'
  },
  // Legal & Professional - Schedule E Line 10
  {
    name: 'Legal/Professional Fees',
    priority: 16,
    test: (txn) => {
      const legalKeywords = ['LAW OFFICE', 'ATTORNEY', 'LEGAL', 'CPA', 'ACCOUNTANT', 'TAX PREP',
        'EVICTION', 'COURT', 'NOTARY', 'TITLE COMPANY', 'ESCROW SERVICE'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      return legalKeywords.some(kw => desc.includes(kw)) && !txn.is_debit;
    },
    type: POSTING_TYPES.LEGAL_PROFESSIONAL,
    category: '5120'
  },
  // Advertising - Schedule E Line 5
  {
    name: 'Advertising/Marketing',
    priority: 17,
    test: (txn) => {
      const adKeywords = ['ZILLOW', 'TRULIA', 'APARTMENTS.COM', 'HOTPADS', 'RENT.COM', 'REALTOR.COM',
        'CRAIGSLIST', 'FACEBOOK ADS', 'GOOGLE ADS', 'ADVERTISING', 'MARKETING', 'LISTING FEE',
        'COZY', 'AVAIL', 'TURBOTENANT', 'RENTSPREE'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      return adKeywords.some(kw => desc.includes(kw)) && !txn.is_debit;
    },
    type: POSTING_TYPES.ADVERTISING,
    category: '5070'
  },
  // Security Deposits
  {
    name: 'Security Deposit Receipt',
    priority: 20,
    test: (txn) => {
      const keywords = ['SECURITY DEPOSIT', 'SEC DEP', 'DEPOSIT - SECURITY', 'MOVE IN DEPOSIT'];
      const desc = (txn.description || txn.memo || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw)) && txn.is_debit;
    },
    type: POSTING_TYPES.SECURITY_DEPOSIT_RECEIPT
  },
  {
    name: 'Security Deposit Return',
    priority: 20,
    test: (txn) => {
      const keywords = ['REFUND DEPOSIT', 'RETURN SECURITY', 'DEPOSIT REFUND', 'MOVE OUT'];
      const desc = (txn.description || txn.memo || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw)) && !txn.is_debit;
    },
    type: POSTING_TYPES.SECURITY_DEPOSIT_RETURN
  },
  // Late Fee Income - Schedule E Line 4
  {
    name: 'Late Fee Income',
    priority: 25,
    test: (txn) => {
      const keywords = ['LATE FEE', 'LATE CHARGE', 'LATE PAYMENT FEE', 'PENALTY'];
      const desc = (txn.description || txn.memo || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw)) && txn.is_debit;
    },
    type: POSTING_TYPES.LATE_FEE_INCOME,
    category: '4010'
  },
  // Application Fee Income
  {
    name: 'Application Fee',
    priority: 26,
    test: (txn) => {
      const keywords = ['APPLICATION FEE', 'APP FEE', 'SCREENING FEE', 'BACKGROUND CHECK'];
      const desc = (txn.description || txn.memo || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw)) && txn.is_debit;
    },
    type: POSTING_TYPES.APPLICATION_FEE,
    category: '4020'
  },
  // Rent Receipt - Schedule E Line 3
  {
    name: 'Rent Receipt',
    priority: 30,
    test: (txn) => {
      const keywords = ['RENT', 'ZELLE', 'VENMO', 'CASH APP', 'PAYPAL', 'MONTHLY PAYMENT', 
        'TENANT', 'LEASE PAYMENT'];
      const desc = (txn.description || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw)) && txn.is_debit && txn.amount > 300;
    },
    type: POSTING_TYPES.RENT_RECEIPT
  },
  // Utilities - Schedule E Line 17
  {
    name: 'Vendor Expense - Utilities',
    priority: 35,
    test: (txn) => {
      const vendors = ['PG&E', 'PECO', 'CON ED', 'ELECTRIC', 'GAS COMPANY', 'WATER', 'WASTE', 
        'SEWER', 'DUKE ENERGY', 'XCEL', 'DOMINION', 'PACIFIC GAS', 'SOUTHERN CAL EDISON',
        'FLORIDA POWER', 'ENTERGY', 'AMEREN', 'AEP', 'WE ENERGIES', 'PSEG', 'NATIONAL GRID',
        'SPECTRUM', 'COMCAST', 'ATT', 'VERIZON', 'INTERNET', 'CABLE', 'WIFI', 'TRASH',
        'REPUBLIC SERVICES', 'WASTE MANAGEMENT'];
      const payee = (txn.payee || txn.description || '').toUpperCase();
      return vendors.some(v => payee.includes(v)) && !txn.is_debit;
    },
    type: POSTING_TYPES.UTILITIES,
    category: '5010'
  },
  // Repairs & Maintenance - Schedule E Line 14
  {
    name: 'Vendor Expense - Home Improvement',
    priority: 40,
    test: (txn) => {
      const vendors = ['HOME DEPOT', 'LOWES', 'ACE HARDWARE', 'MENARDS', 'TRUE VALUE', 
        'HARBOR FREIGHT', 'NORTHERN TOOL', 'GRAINGER', 'FASTENAL', 'PLUMBING', 'HVAC',
        'ELECTRICIAN', 'HANDYMAN', 'REPAIR', 'MAINTENANCE', 'APPLIANCE', 'CARPET', 'FLOORING'];
      const payee = (txn.payee || txn.description || '').toUpperCase();
      return vendors.some(v => payee.includes(v)) && !txn.is_debit;
    },
    type: POSTING_TYPES.VENDOR_EXPENSE,
    category: '5000' // Repairs & Maintenance
  },
  // Supplies - Schedule E Line 15
  {
    name: 'Supplies',
    priority: 42,
    test: (txn) => {
      const vendors = ['OFFICE DEPOT', 'STAPLES', 'AMAZON', 'WALMART', 'TARGET', 'COSTCO',
        'CLEANING SUPPLIES', 'PAINT', 'SHERWIN WILLIAMS', 'BENJAMIN MOORE', 'PPG'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      const amount = txn.amount || 0;
      return vendors.some(v => desc.includes(v)) && !txn.is_debit && amount < 500;
    },
    type: POSTING_TYPES.VENDOR_EXPENSE,
    category: '5080' // Supplies
  },
  // Capital Expenditures (larger purchases)
  {
    name: 'Capital Expenditure',
    priority: 45,
    test: (txn) => {
      const vendors = ['APPLIANCE', 'REFRIGERATOR', 'WASHER', 'DRYER', 'HVAC', 'AC UNIT',
        'WATER HEATER', 'FURNACE', 'ROOF', 'WINDOWS', 'SIDING'];
      const desc = (txn.description || txn.payee || '').toUpperCase();
      const amount = txn.amount || 0;
      return vendors.some(v => desc.includes(v)) && !txn.is_debit && amount > 2500;
    },
    type: POSTING_TYPES.CAPEX
  },
  // Transfers (no tax impact)
  {
    name: 'Transfer',
    priority: 50,
    test: (txn) => {
      const keywords = ['TRANSFER', 'XFER', 'FROM SAVINGS', 'TO CHECKING', 'BETWEEN ACCOUNTS'];
      const desc = (txn.description || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw));
    },
    type: POSTING_TYPES.TRANSFER
  },
  // Owner Contributions
  {
    name: 'Owner Contribution',
    priority: 60,
    test: (txn) => {
      const keywords = ['OWNER', 'CAPITAL', 'CONTRIBUTION', 'PERSONAL FUNDS'];
      const desc = (txn.description || txn.memo || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw)) && txn.is_debit;
    },
    type: POSTING_TYPES.OWNER_CONTRIBUTION
  },
  {
    name: 'Owner Draw',
    priority: 60,
    test: (txn) => {
      const keywords = ['OWNER DRAW', 'DISTRIBUTION', 'PERSONAL WITHDRAWAL', 'PROFIT DISTRIBUTION'];
      const desc = (txn.description || txn.memo || '').toUpperCase();
      return keywords.some(kw => desc.includes(kw)) && !txn.is_debit;
    },
    type: POSTING_TYPES.OWNER_DRAW
  }
];

/**
 * Classify a bank transaction
 * @param {Object} txn - Bank transaction object
 * @returns {Object} - { type, category, split, confidence }
 */
export function classifyTransaction(txn) {
  // Sort rules by priority
  const sortedRules = [...CLASSIFICATION_RULES].sort((a, b) => a.priority - b.priority);
  
  // Find first matching rule
  for (const rule of sortedRules) {
    if (rule.test(txn)) {
      return {
        type: rule.type,
        category: rule.category || null,
        rule_name: rule.name,
        confidence: 0.9
      };
    }
  }
  
  // Default fallback: generic expense or income
  if (txn.is_debit) {
    return {
      type: POSTING_TYPES.RENT_RECEIPT,
      category: '4020', // Other Rental Income
      rule_name: 'Default Income',
      confidence: 0.5
    };
  } else {
    return {
      type: POSTING_TYPES.VENDOR_EXPENSE,
      category: txn.category_hint || '5000', // Repairs & Maintenance
      rule_name: 'Default Expense',
      confidence: 0.5
    };
  }
}

/**
 * Get mortgage split (simplified - in production, fetch from loan data)
 * @param {Object} txn - Transaction object
 * @returns {Object} - { interest, principal, escrow }
 */
export function getMortgageSplit(txn) {
  const total = txn.amount;
  
  // Simplified split logic - in production, calculate from amortization schedule
  // Typical mortgage: ~60% interest, 30% principal, 10% escrow early in loan
  const interest = total * 0.60;
  const principal = total * 0.30;
  const escrow = total * 0.10;
  
  return {
    interest: Math.round(interest * 100) / 100,
    principal: Math.round(principal * 100) / 100,
    escrow: Math.round(escrow * 100) / 100
  };
}

/**
 * Test classification on a transaction (dry run)
 * @param {Object} txn - Transaction-like payload
 * @returns {Object} - Classification result with proposed posting
 */
export function testClassification(txn) {
  const classification = classifyTransaction(txn);
  
  let proposedPosting = {
    posting_type: classification.type,
    rule_name: classification.rule_name,
    confidence: classification.confidence,
    lines: []
  };
  
  // Generate proposed journal lines based on type
  switch (classification.type) {
    case POSTING_TYPES.MORTGAGE_PAYMENT:
      const split = getMortgageSplit(txn);
      proposedPosting.proposed_split = split;
      proposedPosting.lines = [
        { account_code: '5050', dc: 'D', amount: split.interest, memo: 'Mortgage Interest' },
        { account_code: '1600', dc: 'D', amount: split.escrow, memo: 'Escrow' },
        { account_code: '2200', dc: 'C', amount: split.principal, memo: 'Principal Reduction' },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash Payment' }
      ];
      break;
      
    case POSTING_TYPES.RENT_RECEIPT:
      proposedPosting.lines = [
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Rent Received' },
        { account_code: '4000', dc: 'C', amount: txn.amount, memo: 'Rent Income' }
      ];
      break;
      
    case POSTING_TYPES.VENDOR_EXPENSE:
      proposedPosting.lines = [
        { account_code: classification.category, dc: 'D', amount: txn.amount, memo: 'Expense' },
        { account_code: '1000', dc: 'C', amount: txn.amount, memo: 'Cash Payment' }
      ];
      break;
      
    case POSTING_TYPES.SECURITY_DEPOSIT_RECEIPT:
      proposedPosting.lines = [
        { account_code: '1010', dc: 'D', amount: txn.amount, memo: 'Security Deposit Received' },
        { account_code: '2000', dc: 'C', amount: txn.amount, memo: 'Security Deposits Payable' }
      ];
      break;
      
    case POSTING_TYPES.OWNER_CONTRIBUTION:
      proposedPosting.lines = [
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Owner Contribution' },
        { account_code: '3000', dc: 'C', amount: txn.amount, memo: "Owner's Equity" }
      ];
      break;
      
    default:
      proposedPosting.lines = [
        { account_code: '1000', dc: 'D', amount: txn.amount, memo: 'Unclassified' }
      ];
  }
  
  return proposedPosting;
}

/**
 * Add custom rule to database
 */
export function addPostingRule(rule) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO posting_rules (rule_name, priority, match_type, match_pattern, posting_type)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  return stmt.run(
    rule.rule_name,
    rule.priority || 100,
    rule.match_type,
    rule.match_pattern,
    rule.posting_type
  );
}

/**
 * Get all active posting rules from database
 */
export function getActiveRules() {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM posting_rules WHERE is_active = 1 ORDER BY priority ASC
  `);
  
  return stmt.all();
}
