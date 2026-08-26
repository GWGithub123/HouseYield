-- Renaissance Realty Double-Entry Bookkeeping Schema
-- Implements GAAP-compliant accounting for rental property management

-- Core master data: Chart of Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_side CHAR(1) NOT NULL CHECK (normal_side IN ('D','C')),
  tax_map VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Properties master
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name VARCHAR(120) NOT NULL,
  address TEXT,
  property_data JSONB,
  financial_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenants master
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(120),
  phone VARCHAR(20),
  lease_start DATE,
  lease_end DATE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Journal entry headers
CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGSERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  memo TEXT,
  source VARCHAR(40) CHECK (source IN ('BANK_RULE','MANUAL','SYSTEM','IMPORT','BANK')),
  source_ref VARCHAR(80),
  posted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  posted_by VARCHAR(80),
  reversed_entry_id BIGINT REFERENCES journal_entries(id),
  is_reversal BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Journal entry lines (the core of double-entry)
CREATE TABLE IF NOT EXISTS journal_lines (
  id BIGSERIAL PRIMARY KEY,
  journal_entry_id BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  property_id INTEGER REFERENCES properties(id),
  tenant_id INTEGER REFERENCES tenants(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  dc CHAR(1) NOT NULL CHECK (dc IN ('D','C')),
  memo TEXT,
  bank_cleared_at TIMESTAMP WITH TIME ZONE,
  bank_stmt_id VARCHAR(80),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Accounting periods and locks
CREATE TABLE IF NOT EXISTS periods (
  id SERIAL PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  is_closed BOOLEAN DEFAULT FALSE,
  closed_by VARCHAR(80),
  closed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(period_start, period_end)
);

-- Accounts Receivable open items
CREATE TABLE IF NOT EXISTS ar_open_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  open_amount NUMERIC(14,2) NOT NULL,
  journal_line_id BIGINT REFERENCES journal_lines(id),
  is_paid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Accounts Payable open items
CREATE TABLE IF NOT EXISTS ap_open_items (
  id BIGSERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  vendor_name VARCHAR(120) NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  open_amount NUMERIC(14,2) NOT NULL,
  journal_line_id BIGINT REFERENCES journal_lines(id),
  is_paid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fixed assets for depreciation tracking
CREATE TABLE IF NOT EXISTS fixed_assets (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  account_asset_id INTEGER NOT NULL REFERENCES accounts(id),
  account_accum_id INTEGER NOT NULL REFERENCES accounts(id),
  placed_in_service DATE NOT NULL,
  cost NUMERIC(14,2) NOT NULL,
  salvage NUMERIC(14,2) DEFAULT 0,
  life_months INTEGER NOT NULL,
  schedule VARCHAR(20) DEFAULT 'STRAIGHT_LINE',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bank transactions (raw imports before posting)
CREATE TABLE IF NOT EXISTS bank_transactions (
  id BIGSERIAL PRIMARY KEY,
  bank_txn_id VARCHAR(120) UNIQUE,
  account_external_id VARCHAR(80),
  txn_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  payee VARCHAR(255),
  description TEXT,
  is_debit BOOLEAN,
  property_id INTEGER REFERENCES properties(id),
  category_hint VARCHAR(80),
  is_posted BOOLEAN DEFAULT FALSE,
  posted_journal_id BIGINT REFERENCES journal_entries(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Classification rules for auto-posting
CREATE TABLE IF NOT EXISTS posting_rules (
  id SERIAL PRIMARY KEY,
  rule_name VARCHAR(120) NOT NULL,
  priority INTEGER DEFAULT 100,
  match_type VARCHAR(20) CHECK (match_type IN ('PAYEE','DESCRIPTION','AMOUNT','CATEGORY')),
  match_pattern VARCHAR(255),
  posting_type VARCHAR(40) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reconciliation state
CREATE TABLE IF NOT EXISTS bank_statements (
  id SERIAL PRIMARY KEY,
  account_code VARCHAR(20) NOT NULL,
  statement_date DATE NOT NULL,
  ending_balance NUMERIC(14,2) NOT NULL,
  is_reconciled BOOLEAN DEFAULT FALSE,
  reconciled_by VARCHAR(80),
  reconciled_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_property ON journal_lines(property_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source, source_ref);
CREATE INDEX IF NOT EXISTS idx_bank_txn_id ON bank_transactions(bank_txn_id);
CREATE INDEX IF NOT EXISTS idx_ar_tenant ON ar_open_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ap_vendor ON ap_open_items(vendor_name);

-- Insert default Chart of Accounts (rental property focused)
INSERT INTO accounts (code, name, type, normal_side, tax_map) VALUES
  -- Assets
  ('1000', 'Cash – Operating', 'ASSET', 'D', 'N/A'),
  ('1010', 'Cash – Security Deposits', 'ASSET', 'D', 'N/A'),
  ('1200', 'Accounts Receivable – Rent', 'ASSET', 'D', 'N/A'),
  ('1300', 'Prepaid Expenses', 'ASSET', 'D', 'N/A'),
  ('1500', 'Buildings', 'ASSET', 'D', 'N/A'),
  ('1510', 'Accumulated Depreciation', 'ASSET', 'C', 'N/A'),
  ('1600', 'Escrow', 'ASSET', 'D', 'N/A'),
  
  -- Liabilities
  ('2000', 'Security Deposits Payable', 'LIABILITY', 'C', 'N/A'),
  ('2100', 'Accounts Payable', 'LIABILITY', 'C', 'N/A'),
  ('2200', 'Mortgage Payable', 'LIABILITY', 'C', 'N/A'),
  ('2210', 'Mortgage – Escrow Liability', 'LIABILITY', 'C', 'N/A'),
  ('2300', 'Taxes Payable', 'LIABILITY', 'C', 'N/A'),
  
  -- Equity
  ('3000', 'Owner''s Equity', 'EQUITY', 'C', 'N/A'),
  ('3100', 'Retained Earnings', 'EQUITY', 'C', 'N/A'),
  
  -- Revenue
  ('4000', 'Rent Income', 'REVENUE', 'C', 'Schedule E - Line 3 Rents Received'),
  ('4010', 'Late Fees Income', 'REVENUE', 'C', 'Schedule E - Line 4 Other Income'),
  ('4020', 'Other Rental Income', 'REVENUE', 'C', 'Schedule E - Line 4 Other Income'),
  ('4030', 'Application Fees', 'REVENUE', 'C', 'Schedule E - Line 4 Other Income'),
  ('4040', 'Pet Fees', 'REVENUE', 'C', 'Schedule E - Line 4 Other Income'),
  
  -- Expenses (mapped to Schedule E lines)
  ('5000', 'Repairs & Maintenance', 'EXPENSE', 'D', 'Schedule E - Line 14 Repairs'),
  ('5010', 'Utilities', 'EXPENSE', 'D', 'Schedule E - Line 17 Utilities'),
  ('5020', 'Insurance', 'EXPENSE', 'D', 'Schedule E - Line 9 Insurance'),
  ('5030', 'Property Taxes', 'EXPENSE', 'D', 'Schedule E - Line 16 Taxes'),
  ('5040', 'Management Fees', 'EXPENSE', 'D', 'Schedule E - Line 11 Management Fees'),
  ('5050', 'Mortgage Interest', 'EXPENSE', 'D', 'Schedule E - Line 12 Mortgage Interest'),
  ('5060', 'HOA/Condo Fees', 'EXPENSE', 'D', 'Schedule E - Line 13 Other Interest'),
  ('5070', 'Advertising/Leasing', 'EXPENSE', 'D', 'Schedule E - Line 5 Advertising'),
  ('5080', 'Supplies', 'EXPENSE', 'D', 'Schedule E - Line 15 Supplies'),
  ('5090', 'Depreciation Expense', 'EXPENSE', 'D', 'Schedule E - Line 18 Depreciation'),
  ('5100', 'Auto and Travel', 'EXPENSE', 'D', 'Schedule E - Line 6 Auto and Travel'),
  ('5110', 'Commissions', 'EXPENSE', 'D', 'Schedule E - Line 8 Commissions'),
  ('5120', 'Legal and Professional Fees', 'EXPENSE', 'D', 'Schedule E - Line 10 Legal Fees'),
  ('5130', 'Cleaning and Maintenance', 'EXPENSE', 'D', 'Schedule E - Line 7 Cleaning'),
  ('5999', 'Other Expenses', 'EXPENSE', 'D', 'Schedule E - Line 19 Other')
ON CONFLICT (code) DO NOTHING;

-- Property data cache table
-- Stores ATTOM API responses to avoid redundant API calls
CREATE TABLE IF NOT EXISTS property_data_cache (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  attom_id VARCHAR(50),
  property_data JSONB NOT NULL,
  last_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(normalized_address)
);

CREATE INDEX IF NOT EXISTS idx_property_cache_address ON property_data_cache(normalized_address);
CREATE INDEX IF NOT EXISTS idx_property_cache_attom_id ON property_data_cache(attom_id);
CREATE INDEX IF NOT EXISTS idx_property_cache_fetched ON property_data_cache(last_fetched_at);
