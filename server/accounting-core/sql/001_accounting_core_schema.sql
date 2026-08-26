CREATE SCHEMA accounting;
GO

CREATE TABLE accounting.accounts (
  account_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  account_code NVARCHAR(20) NOT NULL UNIQUE,
  account_name NVARCHAR(255) NOT NULL,
  account_type NVARCHAR(40) NOT NULL,
  account_subtype NVARCHAR(80) NULL,
  is_active BIT NOT NULL DEFAULT 1,
  chart_version NVARCHAR(32) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE accounting.source_events (
  source_event_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  source_system NVARCHAR(80) NOT NULL,
  source_object_id NVARCHAR(255) NOT NULL,
  source_event_type NVARCHAR(120) NOT NULL,
  user_id NVARCHAR(128) NOT NULL,
  property_id NVARCHAR(128) NULL,
  payload_json NVARCHAR(MAX) NOT NULL,
  occurred_at DATETIME2 NOT NULL,
  received_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE (source_system, source_object_id, source_event_type)
);
GO

CREATE TABLE accounting.idempotency_keys (
  idempotency_key_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  idempotency_scope NVARCHAR(120) NOT NULL,
  idempotency_key NVARCHAR(255) NOT NULL,
  source_event_id UNIQUEIDENTIFIER NULL,
  posted_journal_entry_id UNIQUEIDENTIFIER NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE (idempotency_scope, idempotency_key)
);
GO

CREATE TABLE accounting.finance_events (
  finance_event_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  source_event_id UNIQUEIDENTIFIER NULL,
  finance_event_type NVARCHAR(120) NOT NULL,
  user_id NVARCHAR(128) NOT NULL,
  property_id NVARCHAR(128) NULL,
  effective_date DATE NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  counterparty_name NVARCHAR(255) NULL,
  memo NVARCHAR(400) NULL,
  metadata_json NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (source_event_id) REFERENCES accounting.source_events(source_event_id)
);
GO

CREATE TABLE accounting.journal_entries (
  journal_entry_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  finance_event_id UNIQUEIDENTIFIER NULL,
  user_id NVARCHAR(128) NOT NULL,
  property_id NVARCHAR(128) NULL,
  entry_date DATE NOT NULL,
  entry_type NVARCHAR(80) NOT NULL,
  source_system NVARCHAR(80) NOT NULL,
  source_ref NVARCHAR(255) NULL,
  memo NVARCHAR(400) NOT NULL,
  total_debits DECIMAL(18,2) NOT NULL,
  total_credits DECIMAL(18,2) NOT NULL,
  rules_version NVARCHAR(32) NOT NULL,
  posted_by NVARCHAR(255) NOT NULL,
  is_balanced BIT NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (finance_event_id) REFERENCES accounting.finance_events(finance_event_id)
);
GO

CREATE TABLE accounting.journal_lines (
  journal_line_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  journal_entry_id UNIQUEIDENTIFIER NOT NULL,
  line_number INT NOT NULL,
  account_code NVARCHAR(20) NOT NULL,
  dc CHAR(1) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  property_id NVARCHAR(128) NULL,
  vendor_name NVARCHAR(255) NULL,
  tenant_name NVARCHAR(255) NULL,
  tax_category NVARCHAR(120) NULL,
  schedule_e_line INT NULL,
  memo NVARCHAR(400) NULL,
  evidence_link_count INT NOT NULL DEFAULT 0,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (journal_entry_id) REFERENCES accounting.journal_entries(journal_entry_id),
  FOREIGN KEY (account_code) REFERENCES accounting.accounts(account_code),
  UNIQUE (journal_entry_id, line_number)
);
GO

CREATE TABLE accounting.subledger_tenant (
  tenant_subledger_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  journal_entry_id UNIQUEIDENTIFIER NOT NULL,
  tenant_id NVARCHAR(128) NULL,
  tenant_name NVARCHAR(255) NOT NULL,
  property_id NVARCHAR(128) NULL,
  activity_type NVARCHAR(120) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  running_balance DECIMAL(18,2) NULL,
  effective_date DATE NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (journal_entry_id) REFERENCES accounting.journal_entries(journal_entry_id)
);
GO

CREATE TABLE accounting.subledger_vendor (
  vendor_subledger_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  journal_entry_id UNIQUEIDENTIFIER NOT NULL,
  vendor_id NVARCHAR(128) NULL,
  vendor_name NVARCHAR(255) NOT NULL,
  property_id NVARCHAR(128) NULL,
  amount DECIMAL(18,2) NOT NULL,
  reportable_1099_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  effective_date DATE NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (journal_entry_id) REFERENCES accounting.journal_entries(journal_entry_id)
);
GO

CREATE TABLE accounting.subledger_security_deposit (
  security_deposit_subledger_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  journal_entry_id UNIQUEIDENTIFIER NOT NULL,
  tenant_name NVARCHAR(255) NOT NULL,
  property_id NVARCHAR(128) NULL,
  activity_type NVARCHAR(120) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  running_balance DECIMAL(18,2) NULL,
  effective_date DATE NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (journal_entry_id) REFERENCES accounting.journal_entries(journal_entry_id)
);
GO

CREATE TABLE accounting.subledger_owner_equity (
  owner_equity_subledger_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  journal_entry_id UNIQUEIDENTIFIER NOT NULL,
  owner_name NVARCHAR(255) NULL,
  activity_type NVARCHAR(120) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  effective_date DATE NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (journal_entry_id) REFERENCES accounting.journal_entries(journal_entry_id)
);
GO

CREATE TABLE accounting.reconciliation_sessions (
  reconciliation_session_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  property_id NVARCHAR(128) NULL,
  reconciliation_scope NVARCHAR(120) NOT NULL,
  period_key NVARCHAR(7) NOT NULL,
  status NVARCHAR(40) NOT NULL,
  started_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  completed_at DATETIME2 NULL,
  created_by NVARCHAR(255) NOT NULL
);
GO

CREATE TABLE accounting.reconciliation_items (
  reconciliation_item_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  reconciliation_session_id UNIQUEIDENTIFIER NOT NULL,
  source_system NVARCHAR(80) NOT NULL,
  source_ref NVARCHAR(255) NOT NULL,
  journal_entry_id UNIQUEIDENTIFIER NULL,
  match_status NVARCHAR(40) NOT NULL,
  difference_amount DECIMAL(18,2) NULL,
  notes NVARCHAR(400) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (reconciliation_session_id) REFERENCES accounting.reconciliation_sessions(reconciliation_session_id),
  FOREIGN KEY (journal_entry_id) REFERENCES accounting.journal_entries(journal_entry_id)
);
GO

CREATE TABLE accounting.close_periods (
  close_period_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  property_id NVARCHAR(128) NULL,
  period_key NVARCHAR(7) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status NVARCHAR(40) NOT NULL,
  reason NVARCHAR(255) NULL,
  notes NVARCHAR(400) NULL,
  closed_by NVARCHAR(255) NULL,
  closed_at DATETIME2 NULL,
  reopened_by NVARCHAR(255) NULL,
  reopened_at DATETIME2 NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE (user_id, property_id, period_key)
);
GO

CREATE TABLE accounting.audit_log (
  audit_log_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  entity_type NVARCHAR(120) NOT NULL,
  entity_id NVARCHAR(255) NOT NULL,
  action_type NVARCHAR(120) NOT NULL,
  performed_by NVARCHAR(255) NOT NULL,
  performed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  summary NVARCHAR(400) NULL,
  before_json NVARCHAR(MAX) NULL,
  after_json NVARCHAR(MAX) NULL
);
GO

CREATE TABLE accounting.tax_rulesets (
  tax_ruleset_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  tax_year INT NOT NULL,
  rules_version NVARCHAR(32) NOT NULL,
  approval_status NVARCHAR(40) NOT NULL,
  source_citations_json NVARCHAR(MAX) NULL,
  rules_json NVARCHAR(MAX) NOT NULL,
  approved_by NVARCHAR(255) NULL,
  approved_at DATETIME2 NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE (tax_year, rules_version)
);
GO

CREATE TABLE accounting.workpaper_snapshots (
  workpaper_snapshot_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  property_id NVARCHAR(128) NULL,
  tax_year INT NOT NULL,
  packet_type NVARCHAR(120) NOT NULL,
  readiness_status NVARCHAR(40) NOT NULL,
  rules_version NVARCHAR(32) NOT NULL,
  summary_json NVARCHAR(MAX) NOT NULL,
  artifact_path NVARCHAR(400) NULL,
  created_by NVARCHAR(255) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  released_at DATETIME2 NULL
);
GO

CREATE TABLE accounting.finance_evidence (
  evidence_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  property_id NVARCHAR(128) NULL,
  source_system NVARCHAR(80) NOT NULL,
  source_ref NVARCHAR(255) NOT NULL,
  evidence_type NVARCHAR(80) NOT NULL,
  title NVARCHAR(255) NOT NULL,
  document_date DATE NULL,
  vendor_name NVARCHAR(255) NULL,
  amount DECIMAL(18,2) NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  storage_path NVARCHAR(400) NULL,
  external_url NVARCHAR(1000) NULL,
  mime_type NVARCHAR(120) NULL,
  digitization_status NVARCHAR(40) NULL,
  summary_json NVARCHAR(MAX) NULL,
  extracted_text NVARCHAR(MAX) NULL,
  search_text NVARCHAR(MAX) NULL,
  created_by NVARCHAR(255) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE (source_system, source_ref)
);
GO

CREATE TABLE accounting.evidence_links (
  evidence_link_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  evidence_id UNIQUEIDENTIFIER NOT NULL,
  entity_type NVARCHAR(120) NOT NULL,
  entity_id NVARCHAR(255) NOT NULL,
  link_role NVARCHAR(80) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (evidence_id) REFERENCES accounting.finance_evidence(evidence_id),
  UNIQUE (evidence_id, entity_type, entity_id, link_role)
);
GO