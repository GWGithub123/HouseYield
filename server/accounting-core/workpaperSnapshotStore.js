import crypto from 'crypto';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildDefaultArtifactRecord({ packetType, taxYear, snapshot, summaryJson, releasedAt = null }) {
  return {
    filename: `${packetType}-${taxYear}.json`,
    format: 'json-manifest',
    contentType: 'application/json',
    sha256: crypto.createHash('sha256').update(summaryJson).digest('hex'),
    sizeBytes: Buffer.byteLength(summaryJson, 'utf8'),
    metadata: {
      kind: 'snapshot_manifest',
      packetType,
      taxYear,
      packetReadiness: snapshot?.packetReadiness || null,
      rulesVersion: snapshot?.rulesVersion || null
    },
    recordedAt: toIsoString(releasedAt) || new Date().toISOString()
  };
}

function normalizeArtifactRecord({ artifactRecord, packetType, taxYear, snapshot, summaryJson, releasedAt = null }) {
  const fallback = buildDefaultArtifactRecord({ packetType, taxYear, snapshot, summaryJson, releasedAt });

  if (!artifactRecord) {
    return fallback;
  }

  const sizeBytes = Number(artifactRecord.sizeBytes);
  return {
    filename: artifactRecord.filename || fallback.filename,
    format: artifactRecord.format || fallback.format,
    contentType: artifactRecord.contentType || fallback.contentType,
    sha256: artifactRecord.sha256 || fallback.sha256,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.round(sizeBytes) : fallback.sizeBytes,
    metadata: {
      ...(fallback.metadata || {}),
      ...(artifactRecord.metadata || {})
    },
    recordedAt: toIsoString(artifactRecord.recordedAt) || fallback.recordedAt
  };
}

export async function persistWorkpaperSnapshotToAzure({
  userId,
  propertyId = null,
  taxYear,
  packetType = 'cpa_packet_draft',
  snapshot,
  readinessStatus = null,
  artifactPath = null,
  artifactRecord = null,
  releasedAt = null,
  createdBy = 'system'
}) {
  if (!userId) {
    throw new Error('userId is required to persist a workpaper snapshot');
  }

  if (!snapshot?.rulesVersion || !snapshot?.packetReadiness) {
    throw new Error('snapshot with rulesVersion and packetReadiness is required');
  }

  const summaryJson = stringifyJson(snapshot);
  const effectiveReleasedAt = toIsoString(releasedAt) || toIsoString(snapshot?.releaseControl?.releasedAt);
  const normalizedArtifactRecord = normalizeArtifactRecord({
    artifactRecord,
    packetType,
    taxYear,
    snapshot,
    summaryJson,
    releasedAt: effectiveReleasedAt
  });

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      taxYear,
      packetType,
      rulesVersion: snapshot.rulesVersion,
      readinessStatus: readinessStatus || snapshot.packetReadiness,
      releasedAt: effectiveReleasedAt,
      artifactRecord: normalizedArtifactRecord
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);
  request.input('taxYear', sql.Int, taxYear);
  request.input('packetType', sql.NVarChar(120), packetType);
  request.input('readinessStatus', sql.NVarChar(40), readinessStatus || snapshot.packetReadiness);
  request.input('rulesVersion', sql.NVarChar(32), snapshot.rulesVersion);
  request.input('summaryJson', sql.NVarChar(sql.MAX), summaryJson);
  request.input('artifactPath', sql.NVarChar(400), artifactPath || null);
  request.input('artifactContentType', sql.NVarChar(120), normalizedArtifactRecord.contentType || null);
  request.input('artifactFormat', sql.NVarChar(40), normalizedArtifactRecord.format || null);
  request.input('artifactFilename', sql.NVarChar(255), normalizedArtifactRecord.filename || null);
  request.input('artifactSha256', sql.NVarChar(64), normalizedArtifactRecord.sha256 || null);
  request.input('artifactSizeBytes', sql.BigInt, normalizedArtifactRecord.sizeBytes);
  request.input('artifactMetadataJson', sql.NVarChar(sql.MAX), stringifyJson(normalizedArtifactRecord.metadata || null));
  request.input('immutableRecordedAt', sql.DateTime2, normalizedArtifactRecord.recordedAt || null);
  request.input('createdBy', sql.NVarChar(255), createdBy);
  request.input('releasedAt', sql.DateTime2, effectiveReleasedAt || null);
  const result = await request.query(`
    INSERT INTO accounting.workpaper_snapshots (
      user_id,
      property_id,
      tax_year,
      packet_type,
      readiness_status,
      rules_version,
      summary_json,
      artifact_path,
      artifact_content_type,
      artifact_format,
      artifact_filename,
      artifact_sha256,
      artifact_size_bytes,
      artifact_metadata_json,
      immutable_recorded_at,
      created_by,
      released_at
    )
    OUTPUT INSERTED.workpaper_snapshot_id
    VALUES (
      @userId,
      @propertyId,
      @taxYear,
      @packetType,
      @readinessStatus,
      @rulesVersion,
      @summaryJson,
      @artifactPath,
      @artifactContentType,
      @artifactFormat,
      @artifactFilename,
      @artifactSha256,
      @artifactSizeBytes,
      @artifactMetadataJson,
      @immutableRecordedAt,
      @createdBy,
      @releasedAt
    )
  `);

  return {
    ok: true,
    status: 'persisted',
    workpaperSnapshotId: result.recordset?.[0]?.workpaper_snapshot_id || null,
    taxYear,
    packetType,
    rulesVersion: snapshot.rulesVersion,
    readinessStatus: readinessStatus || snapshot.packetReadiness,
    releasedAt: effectiveReleasedAt,
    artifactRecord: normalizedArtifactRecord
  };
}

export async function listWorkpaperSnapshotsFromAzure({
  userId,
  taxYear = null,
  packetTypeLike = null,
  limit = 20
} = {}) {
  if (!userId) {
    throw new Error('userId is required to list workpaper snapshots');
  }

  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      snapshots: []
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('taxYear', sql.Int, taxYear === null ? null : taxYear);
  request.input('packetTypeLike', sql.NVarChar(120), packetTypeLike || null);
  request.input('limit', sql.Int, normalizedLimit);
  const result = await request.query(`
    SELECT TOP (@limit)
      workpaper_snapshot_id,
      tax_year,
      packet_type,
      readiness_status,
      rules_version,
      summary_json,
      artifact_path,
      artifact_content_type,
      artifact_format,
      artifact_filename,
      artifact_sha256,
      artifact_size_bytes,
      artifact_metadata_json,
      immutable_recorded_at,
      created_by,
      created_at,
      released_at
    FROM accounting.workpaper_snapshots
    WHERE user_id = @userId
      AND (@taxYear IS NULL OR tax_year = @taxYear)
      AND (@packetTypeLike IS NULL OR packet_type LIKE @packetTypeLike)
    ORDER BY created_at DESC
  `);

  const snapshots = (result.recordset || []).map((record) => {
    const summary = JSON.parse(record.summary_json || 'null');
    return {
      workpaperSnapshotId: record.workpaper_snapshot_id,
      taxYear: record.tax_year,
      packetType: record.packet_type,
      readinessStatus: record.readiness_status,
      rulesVersion: record.rules_version,
      artifactPath: record.artifact_path || null,
      artifactRecord: {
        filename: record.artifact_filename || null,
        format: record.artifact_format || null,
        contentType: record.artifact_content_type || null,
        sha256: record.artifact_sha256 || null,
        sizeBytes: record.artifact_size_bytes == null ? null : Number(record.artifact_size_bytes),
        metadata: JSON.parse(record.artifact_metadata_json || 'null'),
        recordedAt: record.immutable_recorded_at || null
      },
      createdBy: record.created_by,
      createdAt: record.created_at,
      releasedAt: record.released_at || null,
      releaseControl: summary?.releaseControl || null,
      summary: summary?.summary || null
    };
  });

  return {
    ok: true,
    status: 'loaded',
    snapshots
  };
}