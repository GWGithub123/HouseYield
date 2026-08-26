-- QuickBooks Online Integration Schema
-- Stores mappings between our bookkeeping system and QuickBooks Online
-- SQLite version

-- Property to QBO Location/Department mapping
CREATE TABLE IF NOT EXISTS qbo_property_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL,
  qbo_department_id VARCHAR(40) NOT NULL,
  qbo_department_name VARCHAR(120),
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(property_id),
  FOREIGN KEY(property_id) REFERENCES properties(id)
);

-- Chart of Accounts to QBO Account mapping
CREATE TABLE IF NOT EXISTS qbo_account_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_code VARCHAR(20) NOT NULL,
  qbo_account_id VARCHAR(40) NOT NULL,
  qbo_account_name VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_code)
);

-- Equity plug account mapping (special mapping for the balancing entry)
CREATE TABLE IF NOT EXISTS qbo_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key VARCHAR(80) UNIQUE NOT NULL,
  config_value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default equity plug account config
INSERT OR IGNORE INTO qbo_config (config_key, config_value) 
VALUES ('equity_plug_account_id', NULL);

-- Sync state tracking: which months have been pushed to QBO
CREATE TABLE IF NOT EXISTS qbo_sync_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  qbo_journal_id VARCHAR(40),
  doc_number VARCHAR(120) NOT NULL,
  pushed_totals_json TEXT,
  sync_status VARCHAR(40) DEFAULT 'pending' CHECK (sync_status IN ('pending','success','failed','adjusted')),
  error_message TEXT,
  pushed_at DATETIME,
  pushed_by VARCHAR(80),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(property_id, period_start, period_end, doc_number),
  FOREIGN KEY(property_id) REFERENCES properties(id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_qbo_property_mappings_property ON qbo_property_mappings(property_id);
CREATE INDEX IF NOT EXISTS idx_qbo_account_mappings_account ON qbo_account_mappings(account_code);
CREATE INDEX IF NOT EXISTS idx_qbo_sync_ledger_property ON qbo_sync_ledger(property_id);
CREATE INDEX IF NOT EXISTS idx_qbo_sync_ledger_period ON qbo_sync_ledger(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_qbo_sync_ledger_status ON qbo_sync_ledger(sync_status);
