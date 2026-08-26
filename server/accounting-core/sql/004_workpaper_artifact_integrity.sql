IF COL_LENGTH('accounting.workpaper_snapshots', 'artifact_content_type') IS NULL
BEGIN
  ALTER TABLE accounting.workpaper_snapshots ADD artifact_content_type NVARCHAR(120) NULL;
END
GO

IF COL_LENGTH('accounting.workpaper_snapshots', 'artifact_format') IS NULL
BEGIN
  ALTER TABLE accounting.workpaper_snapshots ADD artifact_format NVARCHAR(40) NULL;
END
GO

IF COL_LENGTH('accounting.workpaper_snapshots', 'artifact_filename') IS NULL
BEGIN
  ALTER TABLE accounting.workpaper_snapshots ADD artifact_filename NVARCHAR(255) NULL;
END
GO

IF COL_LENGTH('accounting.workpaper_snapshots', 'artifact_sha256') IS NULL
BEGIN
  ALTER TABLE accounting.workpaper_snapshots ADD artifact_sha256 NVARCHAR(64) NULL;
END
GO

IF COL_LENGTH('accounting.workpaper_snapshots', 'artifact_size_bytes') IS NULL
BEGIN
  ALTER TABLE accounting.workpaper_snapshots ADD artifact_size_bytes BIGINT NULL;
END
GO

IF COL_LENGTH('accounting.workpaper_snapshots', 'artifact_metadata_json') IS NULL
BEGIN
  ALTER TABLE accounting.workpaper_snapshots ADD artifact_metadata_json NVARCHAR(MAX) NULL;
END
GO

IF COL_LENGTH('accounting.workpaper_snapshots', 'immutable_recorded_at') IS NULL
BEGIN
  ALTER TABLE accounting.workpaper_snapshots ADD immutable_recorded_at DATETIME2 NULL;
END
GO

UPDATE accounting.workpaper_snapshots
SET
  artifact_content_type = COALESCE(artifact_content_type, 'application/json'),
  artifact_format = COALESCE(artifact_format, 'json-manifest'),
  artifact_filename = COALESCE(artifact_filename, CONCAT(packet_type, '-', tax_year, '.json')),
  artifact_sha256 = COALESCE(
    artifact_sha256,
    CONVERT(NVARCHAR(64), HASHBYTES('SHA2_256', CONVERT(VARBINARY(MAX), summary_json)), 2)
  ),
  artifact_size_bytes = COALESCE(artifact_size_bytes, DATALENGTH(summary_json)),
  artifact_metadata_json = COALESCE(
    artifact_metadata_json,
    '{"kind":"snapshot_manifest","backfilled":true}'
  ),
  immutable_recorded_at = COALESCE(immutable_recorded_at, released_at, created_at)
WHERE
  artifact_content_type IS NULL
  OR artifact_format IS NULL
  OR artifact_filename IS NULL
  OR artifact_sha256 IS NULL
  OR artifact_size_bytes IS NULL
  OR artifact_metadata_json IS NULL
  OR immutable_recorded_at IS NULL;
GO