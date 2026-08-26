export const DEFAULT_CHART_OF_ACCOUNTS_VERSION = '2026.2';

export const DEFAULT_CHART_OF_ACCOUNTS = [
  { code: '1000', name: 'Operating Cash', type: 'ASSET', subtype: 'Bank', isActive: true, balance: 0 },
  { code: '1010', name: 'Security Deposits Held', type: 'ASSET', subtype: 'Bank', isActive: true, balance: 0 },
  { code: '1020', name: 'Stripe Clearing', type: 'ASSET', subtype: 'OtherCurrentAsset', isActive: true, balance: 0 },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', subtype: 'Receivable', isActive: true, balance: 0 },
  { code: '1200', name: 'Prepaid Insurance', type: 'ASSET', subtype: 'OtherCurrentAsset', isActive: true, balance: 0 },
  { code: '1500', name: 'Buildings & Improvements', type: 'ASSET', subtype: 'FixedAsset', isActive: true, balance: 0 },
  { code: '1510', name: 'Accumulated Depreciation', type: 'ASSET', subtype: 'FixedAsset', isActive: true, balance: 0 },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', subtype: 'AccountsPayable', isActive: true, balance: 0 },
  { code: '2100', name: 'Security Deposits Liability', type: 'LIABILITY', subtype: 'OtherCurrentLiability', isActive: true, balance: 0 },
  { code: '2200', name: 'Prepaid Rent', type: 'LIABILITY', subtype: 'OtherCurrentLiability', isActive: true, balance: 0 },
  { code: '2500', name: 'Mortgage Payable', type: 'LIABILITY', subtype: 'LongTermLiability', isActive: true, balance: 0 },
  { code: '3000', name: 'Owner\'s Equity', type: 'EQUITY', subtype: 'Equity', isActive: true, balance: 0 },
  { code: '3100', name: 'Retained Earnings', type: 'EQUITY', subtype: 'RetainedEarnings', isActive: true, balance: 0 },
  { code: '4000', name: 'Rent Income', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
  { code: '4100', name: 'Late Fees', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
  { code: '4200', name: 'Application Fees', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
  { code: '4300', name: 'Pet Fees', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
  { code: '4900', name: 'Other Rental Income', type: 'REVENUE', subtype: 'Income', isActive: true, balance: 0 },
  { code: '5000', name: 'Repairs', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5100', name: 'Utilities', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5200', name: 'Insurance', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5300', name: 'Property Taxes', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5400', name: 'Management Fees', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5500', name: 'Mortgage Interest', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5600', name: 'HOA Fees', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5700', name: 'Landscaping', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5750', name: 'Pest Control', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5800', name: 'Cleaning & Maintenance', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5900', name: 'Legal & Professional', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '5999', name: 'Other Expenses', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '6000', name: 'Advertising', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 },
  { code: '6100', name: 'Depreciation', type: 'EXPENSE', subtype: 'Expense', isActive: true, balance: 0 }
];

export function getDefaultChartAccountByCode(accountCode) {
  return DEFAULT_CHART_OF_ACCOUNTS.find((account) => account.code === accountCode) || null;
}

export function getDefaultChartAccountsByType(accountType) {
  return DEFAULT_CHART_OF_ACCOUNTS.filter((account) => account.type === accountType);
}