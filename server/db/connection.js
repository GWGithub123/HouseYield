/**
 * Database Connection Module
 * SQLite-based for simplicity, can be upgraded to PostgreSQL in production
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_DIR = path.join(process.cwd(), 'server', 'data', 'bookkeeping');
const DB_FILE = path.join(DB_DIR, 'accounting.db');
const SCHEMA_FILE = path.join(process.cwd(), 'server', 'db', 'schema.sql');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let db = null;

/**
 * Get database connection (singleton)
 */
export function getDb() {
  if (!db) {
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('[DB] Database connection established');
  }
  return db;
}

/**
 * Initialize database schema
 * Converts PostgreSQL schema to SQLite-compatible version
 */
export function initializeSchema() {
  const database = getDb();
  
  // For SQLite, we need to adapt the PostgreSQL schema
  // This is a simplified version - in production, use migration tools
  
  const sqliteSchema = `
    -- Core master data
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(120) NOT NULL,
      type VARCHAR(20) NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
      normal_side CHAR(1) NOT NULL CHECK (normal_side IN ('D','C')),
      tax_map VARCHAR(50),
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name VARCHAR(120) NOT NULL,
      address TEXT,
      property_data TEXT,
      financial_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      name VARCHAR(120) NOT NULL,
      email VARCHAR(120),
      phone VARCHAR(20),
      lease_start DATE,
      lease_end DATE,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS property_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      user_id INTEGER NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      monthly_rent REAL NOT NULL,
      security_deposit REAL,
      beds INTEGER,
      baths REAL,
      sqft INTEGER,
      available_date DATE,
      lease_term VARCHAR(50),
      pets_allowed BOOLEAN DEFAULT 0,
      parking_included BOOLEAN DEFAULT 0,
      utilities_included TEXT,
      amenities TEXT,
      photos TEXT,
      status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','active','pending','rented','archived')),
      views_count INTEGER DEFAULT 0,
      leads_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS listing_syndication (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES property_listings(id) ON DELETE CASCADE,
      platform VARCHAR(50) NOT NULL CHECK (platform IN ('zillow','apartments_com','facebook','craigslist','trulia','hotpads')),
      external_id VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','posted','active','error','removed')),
      posted_at DATETIME,
      last_synced_at DATETIME,
      error_message TEXT,
      platform_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(listing_id, platform)
    );

    CREATE TABLE IF NOT EXISTS tenant_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES property_listings(id),
      name VARCHAR(120) NOT NULL,
      email VARCHAR(120) NOT NULL,
      phone VARCHAR(20),
      message TEXT,
      move_in_date DATE,
      household_size INTEGER,
      pets BOOLEAN DEFAULT 0,
      employment_status VARCHAR(50),
      source VARCHAR(50) CHECK (source IN ('website','zillow','apartments_com','facebook','craigslist','referral','other')),
      status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new','contacted','scheduled','screening','approved','rejected','converted')),
      contacted_at DATETIME,
      converted_to_applicant_id INTEGER,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS showing_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES property_listings(id),
      lead_id INTEGER REFERENCES tenant_leads(id),
      requested_date DATE NOT NULL,
      requested_time VARCHAR(20),
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled','no_show')),
      confirmed_at DATETIME,
      completed_at DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date DATE NOT NULL,
      memo TEXT,
      source VARCHAR(40) CHECK (source IN ('BANK_RULE','MANUAL','SYSTEM','IMPORT','BANK')),
      source_ref VARCHAR(80),
      posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      posted_by VARCHAR(80),
      reversed_entry_id INTEGER REFERENCES journal_entries(id),
      is_reversal BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      property_id INTEGER REFERENCES properties(id),
      tenant_id INTEGER REFERENCES tenants(id),
      amount REAL NOT NULL CHECK (amount >= 0),
      dc CHAR(1) NOT NULL CHECK (dc IN ('D','C')),
      memo TEXT,
      bank_cleared_at DATETIME,
      bank_stmt_id VARCHAR(80),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      is_closed BOOLEAN DEFAULT 0,
      closed_by VARCHAR(80),
      closed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(period_start, period_end)
    );

    CREATE TABLE IF NOT EXISTS ar_open_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      property_id INTEGER NOT NULL REFERENCES properties(id),
      issue_date DATE NOT NULL,
      due_date DATE NOT NULL,
      amount REAL NOT NULL,
      open_amount REAL NOT NULL,
      journal_line_id INTEGER REFERENCES journal_lines(id),
      is_paid BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ap_open_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      vendor_name VARCHAR(120) NOT NULL,
      issue_date DATE NOT NULL,
      due_date DATE NOT NULL,
      amount REAL NOT NULL,
      open_amount REAL NOT NULL,
      journal_line_id INTEGER REFERENCES journal_lines(id),
      is_paid BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fixed_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      account_asset_id INTEGER NOT NULL REFERENCES accounts(id),
      account_accum_id INTEGER NOT NULL REFERENCES accounts(id),
      placed_in_service DATE NOT NULL,
      cost REAL NOT NULL,
      salvage REAL DEFAULT 0,
      life_months INTEGER NOT NULL,
      schedule VARCHAR(20) DEFAULT 'STRAIGHT_LINE',
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_txn_id VARCHAR(120) UNIQUE,
      account_external_id VARCHAR(80),
      txn_date DATE NOT NULL,
      amount REAL NOT NULL,
      payee VARCHAR(255),
      description TEXT,
      is_debit BOOLEAN,
      property_id INTEGER REFERENCES properties(id),
      category_hint VARCHAR(80),
      is_posted BOOLEAN DEFAULT 0,
      posted_journal_id INTEGER REFERENCES journal_entries(id),
      source_system VARCHAR(50),
      raw_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posting_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_name VARCHAR(120) NOT NULL,
      priority INTEGER DEFAULT 100,
      match_type VARCHAR(20) CHECK (match_type IN ('PAYEE','DESCRIPTION','AMOUNT','CATEGORY')),
      match_pattern VARCHAR(255),
      posting_type VARCHAR(40) NOT NULL,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bank_statements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code VARCHAR(20) NOT NULL,
      statement_date DATE NOT NULL,
      ending_balance REAL NOT NULL,
      is_reconciled BOOLEAN DEFAULT 0,
      reconciled_by VARCHAR(80),
      reconciled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_property ON journal_lines(property_id);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source, source_ref);
    CREATE INDEX IF NOT EXISTS idx_bank_txn_id ON bank_transactions(bank_txn_id);
    CREATE INDEX IF NOT EXISTS idx_ar_tenant ON ar_open_items(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_ap_vendor ON ap_open_items(vendor_name);
    
    -- Property data cache table
    CREATE TABLE IF NOT EXISTS property_data_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      normalized_address TEXT NOT NULL UNIQUE,
      attom_id VARCHAR(50),
      property_data TEXT NOT NULL,
      last_fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_property_cache_address ON property_data_cache(normalized_address);
    CREATE INDEX IF NOT EXISTS idx_property_cache_attom_id ON property_data_cache(attom_id);
    CREATE INDEX IF NOT EXISTS idx_property_cache_fetched ON property_data_cache(last_fetched_at);

    -- QuickBooks Online Sync Tables
    CREATE TABLE IF NOT EXISTS qbo_property_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL UNIQUE REFERENCES properties(id),
      qbo_department_id VARCHAR(50) NOT NULL,
      qbo_department_name VARCHAR(120),
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS qbo_account_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code VARCHAR(20) NOT NULL UNIQUE,
      qbo_account_id VARCHAR(50) NOT NULL,
      qbo_account_name VARCHAR(120),
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS qbo_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key VARCHAR(50) NOT NULL UNIQUE,
      config_value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS qbo_sync_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      doc_number VARCHAR(80) NOT NULL,
      qbo_journal_id VARCHAR(50),
      pushed_totals_json TEXT,
      sync_status VARCHAR(20) DEFAULT 'pending' CHECK (sync_status IN ('pending','success','failed')),
      error_message TEXT,
      pushed_at DATETIME,
      pushed_by VARCHAR(80),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_qbo_sync_property_period ON qbo_sync_ledger(property_id, period_start, period_end);

    -- Tenant Screening Requests Table
    CREATE TABLE IF NOT EXISTS screening_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token VARCHAR(64) NOT NULL UNIQUE,
      owner_id VARCHAR(255),
      property_id VARCHAR(255),
      applicant_email VARCHAR(255) NOT NULL,
      applicant_phone VARCHAR(40),
      applicant_name VARCHAR(255) NOT NULL,
      property_address TEXT NOT NULL,
      owner_name VARCHAR(255),
      expires_at DATETIME NOT NULL,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'completed', 'expired')),
      submitted_first_name VARCHAR(100),
      submitted_last_name VARCHAR(100),
      submitted_ssn_encrypted TEXT,
      submitted_dob DATE,
      submitted_address TEXT,
      credit_score INTEGER,
      credit_status VARCHAR(20),
      credit_report TEXT,
      background_status VARCHAR(20),
      background_report TEXT,
      income_verified BOOLEAN DEFAULT 0,
      income_data TEXT,
      stripe_session_id VARCHAR(255),
      interview_id VARCHAR(64),
      interview_booking_token VARCHAR(64),
      application_link_token VARCHAR(64),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS application_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token VARCHAR(64) NOT NULL UNIQUE,
      owner_id VARCHAR(255) NOT NULL,
      owner_name VARCHAR(255),
      property_id VARCHAR(255),
      property_address TEXT NOT NULL,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_screening_token ON screening_requests(token);
    CREATE INDEX IF NOT EXISTS idx_screening_status ON screening_requests(status);
    CREATE INDEX IF NOT EXISTS idx_screening_email ON screening_requests(applicant_email);
    CREATE INDEX IF NOT EXISTS idx_application_links_owner_property ON application_links(owner_id, property_address);
  `;

  // Execute schema
  database.exec(sqliteSchema);

  // Insert default Chart of Accounts
  const insertAccounts = database.prepare(`
    INSERT OR IGNORE INTO accounts (code, name, type, normal_side, tax_map) VALUES (?, ?, ?, ?, ?)
  `);

  const defaultAccounts = [
    ['1000', 'Cash – Operating', 'ASSET', 'D', 'N/A'],
    ['1010', 'Cash – Security Deposits', 'ASSET', 'D', 'N/A'],
    ['1200', 'Accounts Receivable – Rent', 'ASSET', 'D', 'N/A'],
    ['1300', 'Prepaid Expenses', 'ASSET', 'D', 'N/A'],
    ['1500', 'Buildings', 'ASSET', 'D', 'N/A'],
    ['1510', 'Accumulated Depreciation', 'ASSET', 'C', 'N/A'],
    ['1600', 'Escrow', 'ASSET', 'D', 'N/A'],
    ['2000', 'Security Deposits Payable', 'LIABILITY', 'C', 'N/A'],
    ['2100', 'Accounts Payable', 'LIABILITY', 'C', 'N/A'],
    ['2200', 'Mortgage Payable', 'LIABILITY', 'C', 'N/A'],
    ['2210', 'Mortgage – Escrow Liability', 'LIABILITY', 'C', 'N/A'],
    ['2300', 'Taxes Payable', 'LIABILITY', 'C', 'N/A'],
    ['3000', "Owner's Equity", 'EQUITY', 'C', 'N/A'],
    ['3100', 'Retained Earnings', 'EQUITY', 'C', 'N/A'],
    ['4000', 'Rent Income', 'REVENUE', 'C', 'Schedule E - Rents Received'],
    ['4010', 'Late Fees Income', 'REVENUE', 'C', 'Schedule E - Other Income'],
    ['4020', 'Other Rental Income', 'REVENUE', 'C', 'Schedule E - Other Income'],
    ['5000', 'Repairs & Maintenance', 'EXPENSE', 'D', 'Schedule E - Repairs'],
    ['5010', 'Utilities', 'EXPENSE', 'D', 'Schedule E - Utilities'],
    ['5020', 'Insurance', 'EXPENSE', 'D', 'Schedule E - Insurance'],
    ['5030', 'Property Taxes', 'EXPENSE', 'D', 'Schedule E - Taxes'],
    ['5040', 'Management Fees', 'EXPENSE', 'D', 'Schedule E - Management Fees'],
    ['5050', 'Mortgage Interest', 'EXPENSE', 'D', 'Schedule E - Mortgage Interest'],
    ['5060', 'HOA/Condo Fees', 'EXPENSE', 'D', 'Schedule E - Other Interest'],
    ['5070', 'Advertising/Leasing', 'EXPENSE', 'D', 'Schedule E - Advertising'],
    ['5080', 'Supplies', 'EXPENSE', 'D', 'Schedule E - Supplies'],
    ['5090', 'Depreciation Expense', 'EXPENSE', 'D', 'Schedule E - Depreciation'],
    ['5100', 'Auto & Travel', 'EXPENSE', 'D', 'Schedule E - Auto and Travel'],
    ['5110', 'Bank Fees & Commissions', 'EXPENSE', 'D', 'Schedule E - Commissions'],
    ['5120', 'Legal & Professional Fees', 'EXPENSE', 'D', 'Schedule E - Legal and Professional'],
    ['5999', 'Other Expenses', 'EXPENSE', 'D', 'Schedule E - Other']
  ];

  const insertMany = database.transaction((accounts) => {
    for (const account of accounts) {
      insertAccounts.run(...account);
    }
  });

  insertMany(defaultAccounts);

  // Run migrations for existing tables (add missing columns)
  runMigrations(database);

  console.log('[DB] Schema initialized successfully');
}

/**
 * Run database migrations to add missing columns
 */
function runMigrations(database) {
  // Check and add property_data column to properties table
  const propColumns = database.prepare("PRAGMA table_info(properties)").all();
  const columnNames = propColumns.map(c => c.name);
  
  if (!columnNames.includes('property_data')) {
    database.exec("ALTER TABLE properties ADD COLUMN property_data TEXT");
    console.log('[DB] Migration: Added property_data column to properties');
  }
  
  if (!columnNames.includes('financial_data')) {
    database.exec("ALTER TABLE properties ADD COLUMN financial_data TEXT");
    console.log('[DB] Migration: Added financial_data column to properties');
  }

  const screeningColumns = database.prepare("PRAGMA table_info(screening_requests)").all();
  const screeningColumnNames = screeningColumns.map(c => c.name);
  const screeningMigrations = [
    ['owner_id', 'ALTER TABLE screening_requests ADD COLUMN owner_id VARCHAR(255)'],
    ['property_id', 'ALTER TABLE screening_requests ADD COLUMN property_id VARCHAR(255)'],
    ['applicant_phone', 'ALTER TABLE screening_requests ADD COLUMN applicant_phone VARCHAR(40)'],
    ['background_status', 'ALTER TABLE screening_requests ADD COLUMN background_status VARCHAR(20)'],
    ['background_report', 'ALTER TABLE screening_requests ADD COLUMN background_report TEXT'],
    ['interview_id', 'ALTER TABLE screening_requests ADD COLUMN interview_id VARCHAR(64)'],
    ['interview_booking_token', 'ALTER TABLE screening_requests ADD COLUMN interview_booking_token VARCHAR(64)'],
    ['application_link_token', 'ALTER TABLE screening_requests ADD COLUMN application_link_token VARCHAR(64)']
  ];

  screeningMigrations.forEach(([columnName, sql]) => {
    if (!screeningColumnNames.includes(columnName)) {
      database.exec(sql);
      console.log(`[DB] Migration: Added ${columnName} column to screening_requests`);
    }
  });

  database.exec(`
    CREATE TABLE IF NOT EXISTS application_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token VARCHAR(64) NOT NULL UNIQUE,
      owner_id VARCHAR(255) NOT NULL,
      owner_name VARCHAR(255),
      property_id VARCHAR(255),
      property_address TEXT NOT NULL,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_screening_owner_id ON screening_requests(owner_id);
    CREATE INDEX IF NOT EXISTS idx_screening_property_id ON screening_requests(property_id);
    CREATE INDEX IF NOT EXISTS idx_screening_application_token ON screening_requests(application_link_token);
    CREATE INDEX IF NOT EXISTS idx_application_links_owner_property ON application_links(owner_id, property_address);
  `);
}

/**
 * Close database connection
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
    console.log('[DB] Database connection closed');
  }
}

// Initialize on module load
initializeSchema();
