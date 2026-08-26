CREATE TABLE accounting.bookkeeping_accounts (
  bookkeeping_account_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  account_code NVARCHAR(20) NOT NULL,
  account_name NVARCHAR(255) NOT NULL,
  account_type NVARCHAR(40) NOT NULL,
  account_subtype NVARCHAR(80) NULL,
  is_active BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  FOREIGN KEY (account_code) REFERENCES accounting.accounts(account_code),
  UNIQUE (user_id, account_code)
);
GO

CREATE TABLE accounting.bookkeeping_properties (
  bookkeeping_property_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  property_ref NVARCHAR(128) NOT NULL,
  property_name NVARCHAR(255) NOT NULL,
  address NVARCHAR(255) NULL,
  state NVARCHAR(32) NULL,
  purchase_date DATE NULL,
  purchase_price DECIMAL(18,2) NOT NULL DEFAULT 0,
  land_value DECIMAL(18,2) NOT NULL DEFAULT 0,
  improvement_value DECIMAL(18,2) NOT NULL DEFAULT 0,
  description NVARCHAR(255) NULL,
  useful_life_months INT NOT NULL DEFAULT 330,
  fair_rental_days INT NOT NULL DEFAULT 365,
  personal_use_days INT NOT NULL DEFAULT 0,
  metadata_json NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE (user_id, property_ref)
);
GO

CREATE TABLE accounting.bookkeeping_vendors (
  bookkeeping_vendor_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  vendor_ref NVARCHAR(128) NOT NULL,
  vendor_name NVARCHAR(255) NOT NULL,
  vendor_type NVARCHAR(64) NULL,
  ein NVARCHAR(32) NULL,
  ssn_last4 NVARCHAR(8) NULL,
  address NVARCHAR(255) NULL,
  city NVARCHAR(128) NULL,
  state NVARCHAR(32) NULL,
  zip NVARCHAR(32) NULL,
  email NVARCHAR(255) NULL,
  phone NVARCHAR(64) NULL,
  w9_on_file BIT NOT NULL DEFAULT 0,
  w9_date DATE NULL,
  notes NVARCHAR(1000) NULL,
  metadata_json NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE (user_id, vendor_ref)
);
GO

CREATE INDEX IX_bookkeeping_accounts_user_active
  ON accounting.bookkeeping_accounts (user_id, is_active, account_code);
GO

CREATE INDEX IX_bookkeeping_properties_user_ref
  ON accounting.bookkeeping_properties (user_id, property_ref);
GO

CREATE INDEX IX_bookkeeping_vendors_user_name
  ON accounting.bookkeeping_vendors (user_id, vendor_name);
GO