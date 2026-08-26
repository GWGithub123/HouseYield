CREATE TABLE accounting.estimated_tax_payments (
  estimated_tax_payment_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  user_id NVARCHAR(128) NOT NULL,
  tax_year INT NOT NULL,
  quarter INT NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  date_paid DATE NOT NULL,
  payment_method NVARCHAR(80) NOT NULL DEFAULT 'unknown',
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_estimated_tax_payments_quarter CHECK (quarter BETWEEN 1 AND 4),
  CONSTRAINT CK_estimated_tax_payments_amount CHECK (amount > 0)
);
GO

CREATE INDEX IX_estimated_tax_payments_user_year_quarter
  ON accounting.estimated_tax_payments (user_id, tax_year, quarter, date_paid);
GO