IF COL_LENGTH('accounting.close_periods', 'approval_control_json') IS NULL
BEGIN
  ALTER TABLE accounting.close_periods
  ADD approval_control_json NVARCHAR(MAX) NULL;
END
GO

IF COL_LENGTH('accounting.close_periods', 'exception_review_json') IS NULL
BEGIN
  ALTER TABLE accounting.close_periods
  ADD exception_review_json NVARCHAR(MAX) NULL;
END
GO

IF COL_LENGTH('accounting.close_periods', 'reopen_reason') IS NULL
BEGIN
  ALTER TABLE accounting.close_periods
  ADD reopen_reason NVARCHAR(255) NULL;
END
GO

IF COL_LENGTH('accounting.close_periods', 'reopen_notes') IS NULL
BEGIN
  ALTER TABLE accounting.close_periods
  ADD reopen_notes NVARCHAR(400) NULL;
END
GO

IF COL_LENGTH('accounting.close_periods', 'reopen_approval_control_json') IS NULL
BEGIN
  ALTER TABLE accounting.close_periods
  ADD reopen_approval_control_json NVARCHAR(MAX) NULL;
END
GO