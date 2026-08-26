import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';
import {
  buildFinanceEvidenceSearchDocument,
  upsertFinanceEvidenceSearchDocument
} from './financeEvidenceSearch.js';

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

function buildEvidenceSearchText({
  title,
  vendorName,
  sourceRef,
  evidenceType,
  summary,
  extractedText
}) {
  const summaryText = summary
    ? typeof summary === 'string'
      ? summary
      : JSON.stringify(summary)
    : '';

  return [title, vendorName, sourceRef, evidenceType, summaryText, extractedText]
    .filter(Boolean)
    .join('\n')
    .slice(0, 32000);
}

function buildEmptyEvidenceSummary() {
  return {
    totalEvidence: 0,
    evidenceTypeCounts: {},
    digitizationStatusCounts: {}
  };
}

function buildEvidenceSummary(evidence) {
  return evidence.reduce((accumulator, item) => {
    accumulator.totalEvidence += 1;
    accumulator.evidenceTypeCounts[item.evidenceType] = (accumulator.evidenceTypeCounts[item.evidenceType] || 0) + 1;
    const digitizationKey = item.digitizationStatus || 'unknown';
    accumulator.digitizationStatusCounts[digitizationKey] = (accumulator.digitizationStatusCounts[digitizationKey] || 0) + 1;
    return accumulator;
  }, buildEmptyEvidenceSummary());
}

async function fetchFinanceEvidenceRows({
  pool,
  sql,
  userId,
  propertyId = null,
  sourceSystem = null,
  entityType = null,
  entityId = null,
  year = null,
  q = null,
  limit = 50,
  evidenceIds = null
}) {
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId || null);
  request.input('sourceSystem', sql.NVarChar(80), sourceSystem || null);
  request.input('entityType', sql.NVarChar(120), entityType || null);
  request.input('entityId', sql.NVarChar(255), entityId || null);
  request.input('year', sql.Int, year === null ? null : parseInt(year, 10));
  request.input('query', sql.NVarChar(sql.MAX), q || null);
  request.input('limit', sql.Int, limit);

  const normalizedEvidenceIds = Array.isArray(evidenceIds)
    ? Array.from(new Set(evidenceIds.filter(Boolean)))
    : null;

  const evidenceIdFilter = normalizedEvidenceIds?.length
    ? `AND fe.evidence_id IN (${normalizedEvidenceIds.map((_, index) => `@evidenceId${index}`).join(', ')})`
    : '';

  const orderBy = normalizedEvidenceIds?.length
    ? `ORDER BY CASE ${normalizedEvidenceIds.map((_, index) => `WHEN fe.evidence_id = @evidenceId${index} THEN ${index}`).join(' ')} ELSE ${normalizedEvidenceIds.length} END, fe.created_at DESC`
    : 'ORDER BY fe.created_at DESC';

  if (normalizedEvidenceIds?.length) {
    normalizedEvidenceIds.forEach((evidenceId, index) => {
      request.input(`evidenceId${index}`, sql.UniqueIdentifier, evidenceId);
    });
  }

  return request.query(`
    SELECT TOP (@limit)
      fe.evidence_id,
      fe.user_id,
      fe.property_id,
      fe.source_system,
      fe.source_ref,
      fe.evidence_type,
      fe.title,
      fe.document_date,
      fe.vendor_name,
      fe.amount,
      fe.currency_code,
      fe.storage_path,
      fe.external_url,
      fe.mime_type,
      fe.digitization_status,
      fe.summary_json,
      fe.extracted_text,
      fe.created_by,
      fe.created_at,
      fe.updated_at,
      el.entity_type,
      el.entity_id,
      el.link_role
    FROM accounting.finance_evidence fe
    LEFT JOIN accounting.evidence_links el
      ON el.evidence_id = fe.evidence_id
    WHERE fe.user_id = @userId
      AND (@propertyId IS NULL OR fe.property_id = @propertyId)
      AND (@sourceSystem IS NULL OR fe.source_system = @sourceSystem)
      AND (@year IS NULL OR YEAR(COALESCE(fe.document_date, CAST(fe.created_at AS DATE))) = @year)
      AND (
        @entityType IS NULL OR EXISTS (
          SELECT 1
          FROM accounting.evidence_links filter_links
          WHERE filter_links.evidence_id = fe.evidence_id
            AND filter_links.entity_type = @entityType
            AND (@entityId IS NULL OR filter_links.entity_id = @entityId)
        )
      )
      ${evidenceIdFilter}
      AND (
        @query IS NULL
        OR fe.search_text LIKE '%' + @query + '%'
      )
    ${orderBy}
  `);
}

async function upsertEvidenceRow(transaction, sql, evidence) {
  const request = transaction.request();
  request.input('userId', sql.NVarChar(128), evidence.userId);
  request.input('propertyId', sql.NVarChar(128), evidence.propertyId || null);
  request.input('sourceSystem', sql.NVarChar(80), evidence.sourceSystem);
  request.input('sourceRef', sql.NVarChar(255), evidence.sourceRef);
  request.input('evidenceType', sql.NVarChar(80), evidence.evidenceType);
  request.input('title', sql.NVarChar(255), evidence.title);
  request.input('documentDate', sql.Date, evidence.documentDate || null);
  request.input('vendorName', sql.NVarChar(255), evidence.vendorName || null);
  request.input('amount', sql.Decimal(18, 2), Number.isFinite(Number(evidence.amount)) ? Number(evidence.amount) : null);
  request.input('currencyCode', sql.Char(3), evidence.currencyCode || 'USD');
  request.input('storagePath', sql.NVarChar(400), evidence.storagePath || null);
  request.input('externalUrl', sql.NVarChar(1000), evidence.externalUrl || null);
  request.input('mimeType', sql.NVarChar(120), evidence.mimeType || null);
  request.input('digitizationStatus', sql.NVarChar(40), evidence.digitizationStatus || null);
  request.input('summaryJson', sql.NVarChar(sql.MAX), stringifyJson(evidence.summary));
  request.input('extractedText', sql.NVarChar(sql.MAX), evidence.extractedText || null);
  request.input('searchText', sql.NVarChar(sql.MAX), buildEvidenceSearchText(evidence));
  request.input('createdBy', sql.NVarChar(255), evidence.createdBy || 'system');
  const result = await request.query(`
    MERGE accounting.finance_evidence AS target
    USING (SELECT @sourceSystem AS source_system, @sourceRef AS source_ref) AS source
      ON target.source_system = source.source_system
     AND target.source_ref = source.source_ref
    WHEN MATCHED THEN UPDATE SET
      user_id = @userId,
      property_id = @propertyId,
      evidence_type = @evidenceType,
      title = @title,
      document_date = @documentDate,
      vendor_name = @vendorName,
      amount = @amount,
      currency_code = @currencyCode,
      storage_path = @storagePath,
      external_url = @externalUrl,
      mime_type = @mimeType,
      digitization_status = @digitizationStatus,
      summary_json = @summaryJson,
      extracted_text = @extractedText,
      search_text = @searchText,
      updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (
      user_id,
      property_id,
      source_system,
      source_ref,
      evidence_type,
      title,
      document_date,
      vendor_name,
      amount,
      currency_code,
      storage_path,
      external_url,
      mime_type,
      digitization_status,
      summary_json,
      extracted_text,
      search_text,
      created_by
    ) VALUES (
      @userId,
      @propertyId,
      @sourceSystem,
      @sourceRef,
      @evidenceType,
      @title,
      @documentDate,
      @vendorName,
      @amount,
      @currencyCode,
      @storagePath,
      @externalUrl,
      @mimeType,
      @digitizationStatus,
      @summaryJson,
      @extractedText,
      @searchText,
      @createdBy
    )
    OUTPUT $action AS merge_action, inserted.evidence_id;
  `);

  return {
    mergeAction: String(result.recordset?.[0]?.merge_action || 'UPSERT').toLowerCase(),
    evidenceId: result.recordset?.[0]?.evidence_id || null
  };
}

async function upsertEvidenceLink(transaction, sql, evidenceId, link) {
  const request = transaction.request();
  request.input('evidenceId', sql.UniqueIdentifier, evidenceId);
  request.input('entityType', sql.NVarChar(120), link.entityType);
  request.input('entityId', sql.NVarChar(255), link.entityId);
  request.input('linkRole', sql.NVarChar(80), link.linkRole || 'supporting_document');
  await request.query(`
    MERGE accounting.evidence_links AS target
    USING (
      SELECT
        @evidenceId AS evidence_id,
        @entityType AS entity_type,
        @entityId AS entity_id,
        @linkRole AS link_role
    ) AS source
      ON target.evidence_id = source.evidence_id
     AND target.entity_type = source.entity_type
     AND target.entity_id = source.entity_id
     AND target.link_role = source.link_role
    WHEN NOT MATCHED THEN INSERT (
      evidence_id,
      entity_type,
      entity_id,
      link_role
    ) VALUES (
      @evidenceId,
      @entityType,
      @entityId,
      @linkRole
    );
  `);
}

async function insertEvidenceAuditLog(transaction, sql, {
  evidenceId,
  actionType,
  performedBy,
  summary,
  afterJson
}) {
  const request = transaction.request();
  request.input('entityType', sql.NVarChar(120), 'finance_evidence');
  request.input('entityId', sql.NVarChar(255), evidenceId);
  request.input('actionType', sql.NVarChar(120), actionType);
  request.input('performedBy', sql.NVarChar(255), performedBy);
  request.input('summary', sql.NVarChar(400), summary);
  request.input('afterJson', sql.NVarChar(sql.MAX), stringifyJson(afterJson));
  await request.query(`
    INSERT INTO accounting.audit_log (
      entity_type,
      entity_id,
      action_type,
      performed_by,
      summary,
      after_json
    ) VALUES (
      @entityType,
      @entityId,
      @actionType,
      @performedBy,
      @summary,
      @afterJson
    )
  `);
}

export async function persistFinanceEvidenceToAzure({
  userId,
  propertyId = null,
  sourceSystem,
  sourceRef,
  evidenceType,
  title,
  documentDate = null,
  vendorName = null,
  amount = null,
  currencyCode = 'USD',
  storagePath = null,
  externalUrl = null,
  mimeType = null,
  digitizationStatus = null,
  summary = null,
  extractedText = null,
  createdBy = 'system',
  links = []
} = {}) {
  if (!userId || !sourceSystem || !sourceRef || !evidenceType || !title) {
    throw new Error('userId, sourceSystem, sourceRef, evidenceType, and title are required');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      sourceSystem,
      sourceRef,
      evidenceType,
      linkedEntityCount: (links || []).length
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const evidence = {
      userId,
      propertyId,
      sourceSystem,
      sourceRef,
      evidenceType,
      title,
      documentDate,
      vendorName,
      amount,
      currencyCode,
      storagePath,
      externalUrl,
      mimeType,
      digitizationStatus,
      summary,
      extractedText,
      createdBy
    };

    const { mergeAction, evidenceId } = await upsertEvidenceRow(transaction, sql, evidence);

    for (const link of links || []) {
      if (!link?.entityType || !link?.entityId) {
        continue;
      }

      await upsertEvidenceLink(transaction, sql, evidenceId, link);
    }

    await insertEvidenceAuditLog(transaction, sql, {
      evidenceId,
      actionType: 'finance_evidence_upserted',
      performedBy: createdBy,
      summary: `${mergeAction === 'update' ? 'Updated' : 'Stored'} ${evidenceType} evidence from ${sourceSystem}`,
      afterJson: {
        evidenceId,
        sourceSystem,
        sourceRef,
        evidenceType,
        title,
        documentDate,
        vendorName,
        amount,
        digitizationStatus,
        links: (links || []).map((link) => ({
          entityType: link.entityType,
          entityId: link.entityId,
          linkRole: link.linkRole || 'supporting_document'
        }))
      }
    });

    await transaction.commit();

    let searchIndex = {
      ok: true,
      status: 'not_requested',
      provider: 'gemini_local'
    };

    try {
      searchIndex = await upsertFinanceEvidenceSearchDocument(
        buildFinanceEvidenceSearchDocument({
          ...evidence,
          evidenceId,
          links,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      );
    } catch (indexError) {
      searchIndex = {
        ok: false,
        status: 'failed',
        provider: 'gemini_local',
        error: indexError.message
      };
    }

    return {
      ok: true,
      status: mergeAction === 'update' ? 'updated' : 'stored',
      evidenceId,
      sourceSystem,
      sourceRef,
      evidenceType,
      linkedEntityCount: (links || []).length,
      searchIndex
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

export async function listFinanceEvidenceFromAzure({
  userId,
  propertyId = null,
  sourceSystem = null,
  entityType = null,
  entityId = null,
  year = null,
  q = null,
  limit = 50
} = {}) {
  if (!userId) {
    throw new Error('userId is required to list finance evidence');
  }

  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      evidence: [],
      summary: {
        totalEvidence: 0,
        evidenceTypeCounts: {},
        digitizationStatusCounts: {}
      }
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  let search = {
    provider: q ? 'sql_like' : null,
    status: q ? 'searched' : 'not_requested',
    usedQuery: q || null,
    hitCount: null
  };

  let sqlQuery = q || null;

  const result = await fetchFinanceEvidenceRows({
    pool,
    sql,
    userId,
    propertyId,
    sourceSystem,
    entityType,
    entityId,
    year,
    q: sqlQuery,
    limit: normalizedLimit,
    evidenceIds: null
  });

  const evidenceMap = new Map();
  for (const row of result.recordset || []) {
    if (!evidenceMap.has(row.evidence_id)) {
      evidenceMap.set(row.evidence_id, {
        evidenceId: row.evidence_id,
        userId: row.user_id,
        propertyId: row.property_id || null,
        sourceSystem: row.source_system,
        sourceRef: row.source_ref,
        evidenceType: row.evidence_type,
        title: row.title,
        documentDate: row.document_date || null,
        vendorName: row.vendor_name || null,
        amount: row.amount === null ? null : Number(row.amount),
        currencyCode: row.currency_code,
        storagePath: row.storage_path || null,
        externalUrl: row.external_url || null,
        mimeType: row.mime_type || null,
        digitizationStatus: row.digitization_status || null,
        summary: safeParseJson(row.summary_json),
        extractedText: row.extracted_text || null,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        links: []
      });
    }

    if (row.entity_type && row.entity_id) {
      evidenceMap.get(row.evidence_id).links.push({
        entityType: row.entity_type,
        entityId: row.entity_id,
        linkRole: row.link_role || 'supporting_document'
      });
    }
  }

  const evidence = Array.from(evidenceMap.values());
  const summary = buildEvidenceSummary(evidence);

  return {
    ok: true,
    status: 'loaded',
    evidence,
    summary,
    search: {
      ...search,
      hitCount: q ? evidence.length : search.hitCount
    }
  };
}