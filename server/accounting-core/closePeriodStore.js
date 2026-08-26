import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';
import { ACCOUNTING_ENTITY_TYPES } from '../../src/shared/accountingDomain.js';

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function safeParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeIsoDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function normalizeIsoDateTime(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function mapClosePeriodRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.close_period_id,
    closePeriodId: row.close_period_id,
    entityType: ACCOUNTING_ENTITY_TYPES.CLOSE_PERIOD,
    propertyId: row.property_id || null,
    periodKey: row.period_key,
    startDate: normalizeIsoDate(row.start_date),
    endDate: normalizeIsoDate(row.end_date),
    status: row.status,
    reason: row.reason || null,
    notes: row.notes || null,
    approvalControl: safeParseJson(row.approval_control_json),
    exceptionReview: safeParseJson(row.exception_review_json),
    closedBy: row.closed_by || null,
    closedAt: normalizeIsoDateTime(row.closed_at),
    reopenReason: row.reopen_reason || null,
    reopenNotes: row.reopen_notes || null,
    reopenApprovalControl: safeParseJson(row.reopen_approval_control_json),
    reopenedBy: row.reopened_by || null,
    reopenedAt: normalizeIsoDateTime(row.reopened_at),
    createdAt: normalizeIsoDateTime(row.created_at),
    updatedAt: normalizeIsoDateTime(row.updated_at)
  };
}

async function fetchClosePeriodRow({ pool, sql, userId, periodKey, propertyId = null }) {
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('periodKey', sql.NVarChar(7), periodKey);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);

  const result = await request.query(`
    SELECT TOP (1)
      close_period_id,
      property_id,
      period_key,
      start_date,
      end_date,
      status,
      reason,
      notes,
      approval_control_json,
      exception_review_json,
      closed_by,
      closed_at,
      reopen_reason,
      reopen_notes,
      reopen_approval_control_json,
      reopened_by,
      reopened_at,
      created_at,
      updated_at
    FROM accounting.close_periods
    WHERE user_id = @userId
      AND period_key = @periodKey
      AND ((property_id IS NULL AND @propertyId IS NULL) OR property_id = @propertyId)
    ORDER BY updated_at DESC
  `);

  return result.recordset?.[0] || null;
}

export async function getClosePeriodFromAzure({
  userId,
  periodKey,
  propertyId = null
}) {
  if (!userId) {
    throw new Error('userId is required to load a close period');
  }

  if (!periodKey) {
    throw new Error('periodKey is required to load a close period');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      closePeriod: null
    }; 
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const row = await fetchClosePeriodRow({ pool, sql, userId, periodKey, propertyId });

  return {
    ok: true,
    status: 'ready',
    lookupStatus: row ? 'loaded' : 'not_found',
    closePeriod: mapClosePeriodRow(row)
  };
}

export async function listClosePeriodsFromAzure({
  userId,
  propertyId = null,
  limit = 24
} = {}) {
  if (!userId) {
    throw new Error('userId is required to list close periods');
  }

  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 120);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      closePeriods: []
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);
  request.input('limit', sql.Int, normalizedLimit);
  const result = await request.query(`
    SELECT TOP (@limit)
      close_period_id,
      property_id,
      period_key,
      start_date,
      end_date,
      status,
      reason,
      notes,
      approval_control_json,
      exception_review_json,
      closed_by,
      closed_at,
      reopen_reason,
      reopen_notes,
      reopen_approval_control_json,
      reopened_by,
      reopened_at,
      created_at,
      updated_at
    FROM accounting.close_periods
    WHERE user_id = @userId
      AND (@propertyId IS NULL OR property_id = @propertyId)
    ORDER BY period_key DESC, updated_at DESC
  `);

  return {
    ok: true,
    status: 'ready',
    closePeriods: (result.recordset || []).map(mapClosePeriodRow)
  };
}

export async function upsertClosePeriodToAzure({
  userId,
  propertyId = null,
  periodKey,
  startDate,
  endDate,
  status,
  reason = null,
  notes = null,
  approvalControl = null,
  exceptionReview = null,
  closedBy = null,
  closedAt = null,
  reopenReason = null,
  reopenNotes = null,
  reopenApprovalControl = null,
  reopenedBy = null,
  reopenedAt = null,
  performedBy = 'system',
  actionType = 'close_period_upsert',
  summary = null
}) {
  if (!userId) {
    throw new Error('userId is required to persist a close period');
  }

  if (!periodKey || !startDate || !endDate || !status) {
    throw new Error('periodKey, startDate, endDate, and status are required to persist a close period');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      periodKey,
      closePeriod: null
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const currentRow = await fetchClosePeriodRow({ pool, sql, userId, periodKey, propertyId });
  const currentClosePeriod = mapClosePeriodRow(currentRow);

  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);
  request.input('periodKey', sql.NVarChar(7), periodKey);
  request.input('startDate', sql.Date, startDate);
  request.input('endDate', sql.Date, endDate);
  request.input('status', sql.NVarChar(40), status);
  request.input('reason', sql.NVarChar(255), reason || null);
  request.input('notes', sql.NVarChar(400), notes || null);
  request.input('approvalControlJson', sql.NVarChar(sql.MAX), stringifyJson(approvalControl));
  request.input('exceptionReviewJson', sql.NVarChar(sql.MAX), stringifyJson(exceptionReview));
  request.input('closedBy', sql.NVarChar(255), closedBy || null);
  request.input('closedAt', sql.DateTime2, closedAt || null);
  request.input('reopenReason', sql.NVarChar(255), reopenReason || null);
  request.input('reopenNotes', sql.NVarChar(400), reopenNotes || null);
  request.input('reopenApprovalControlJson', sql.NVarChar(sql.MAX), stringifyJson(reopenApprovalControl));
  request.input('reopenedBy', sql.NVarChar(255), reopenedBy || null);
  request.input('reopenedAt', sql.DateTime2, reopenedAt || null);

  const result = currentRow
    ? await request.query(`
        UPDATE accounting.close_periods
        SET
          start_date = @startDate,
          end_date = @endDate,
          status = @status,
          reason = @reason,
          notes = @notes,
          approval_control_json = @approvalControlJson,
          exception_review_json = @exceptionReviewJson,
          closed_by = @closedBy,
          closed_at = @closedAt,
          reopen_reason = @reopenReason,
          reopen_notes = @reopenNotes,
          reopen_approval_control_json = @reopenApprovalControlJson,
          reopened_by = @reopenedBy,
          reopened_at = @reopenedAt,
          updated_at = SYSUTCDATETIME()
        OUTPUT
          INSERTED.close_period_id,
          INSERTED.property_id,
          INSERTED.period_key,
          INSERTED.start_date,
          INSERTED.end_date,
          INSERTED.status,
          INSERTED.reason,
          INSERTED.notes,
          INSERTED.approval_control_json,
          INSERTED.exception_review_json,
          INSERTED.closed_by,
          INSERTED.closed_at,
          INSERTED.reopen_reason,
          INSERTED.reopen_notes,
          INSERTED.reopen_approval_control_json,
          INSERTED.reopened_by,
          INSERTED.reopened_at,
          INSERTED.created_at,
          INSERTED.updated_at
        WHERE user_id = @userId
          AND period_key = @periodKey
          AND ((property_id IS NULL AND @propertyId IS NULL) OR property_id = @propertyId)
      `)
    : await request.query(`
        INSERT INTO accounting.close_periods (
          user_id,
          property_id,
          period_key,
          start_date,
          end_date,
          status,
          reason,
          notes,
          approval_control_json,
          exception_review_json,
          closed_by,
          closed_at,
          reopen_reason,
          reopen_notes,
          reopen_approval_control_json,
          reopened_by,
          reopened_at
        )
        OUTPUT
          INSERTED.close_period_id,
          INSERTED.property_id,
          INSERTED.period_key,
          INSERTED.start_date,
          INSERTED.end_date,
          INSERTED.status,
          INSERTED.reason,
          INSERTED.notes,
          INSERTED.approval_control_json,
          INSERTED.exception_review_json,
          INSERTED.closed_by,
          INSERTED.closed_at,
          INSERTED.reopen_reason,
          INSERTED.reopen_notes,
          INSERTED.reopen_approval_control_json,
          INSERTED.reopened_by,
          INSERTED.reopened_at,
          INSERTED.created_at,
          INSERTED.updated_at
        VALUES (
          @userId,
          @propertyId,
          @periodKey,
          @startDate,
          @endDate,
          @status,
          @reason,
          @notes,
          @approvalControlJson,
          @exceptionReviewJson,
          @closedBy,
          @closedAt,
          @reopenReason,
          @reopenNotes,
          @reopenApprovalControlJson,
          @reopenedBy,
          @reopenedAt
        )
      `);

  const persistedClosePeriod = mapClosePeriodRow(result.recordset?.[0] || null);

  const auditRequest = pool.request();
  auditRequest.input('entityType', sql.NVarChar(120), ACCOUNTING_ENTITY_TYPES.CLOSE_PERIOD);
  auditRequest.input('entityId', sql.NVarChar(255), persistedClosePeriod?.closePeriodId || periodKey);
  auditRequest.input('actionType', sql.NVarChar(120), actionType);
  auditRequest.input('performedBy', sql.NVarChar(255), performedBy || 'system');
  auditRequest.input('summary', sql.NVarChar(400), summary || `Persisted close period ${periodKey} with status ${status}`);
  auditRequest.input('beforeJson', sql.NVarChar(sql.MAX), stringifyJson(currentClosePeriod));
  auditRequest.input('afterJson', sql.NVarChar(sql.MAX), stringifyJson(persistedClosePeriod));
  await auditRequest.query(`
    INSERT INTO accounting.audit_log (
      entity_type,
      entity_id,
      action_type,
      performed_by,
      summary,
      before_json,
      after_json
    )
    VALUES (
      @entityType,
      @entityId,
      @actionType,
      @performedBy,
      @summary,
      @beforeJson,
      @afterJson
    )
  `);

  return {
    ok: true,
    status: 'persisted',
    periodKey,
    closePeriod: persistedClosePeriod
  };
}