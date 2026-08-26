import { getTaxRulesetPackage } from '../../src/shared/taxRules.js';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';

function stringifyJson(value) {
  return JSON.stringify(value ?? null, (_key, item) => (
    item === Infinity ? '__HOUSEYIELD_INFINITY__' : item
  ));
}

function safeParseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value, (_key, item) => (
      item === '__HOUSEYIELD_INFINITY__' ? Infinity : item
    ));
  } catch {
    return fallback;
  }
}

function enrichRulesetWithCanonicalMetadata(ruleset, canonicalRuleset) {
  if (!ruleset || typeof ruleset !== 'object') {
    return canonicalRuleset;
  }

  const sourceDocuments = Array.isArray(ruleset.sourceDocuments) && ruleset.sourceDocuments.length > 0
    ? ruleset.sourceDocuments
    : canonicalRuleset.sourceDocuments;
  const sourceCitations = Array.isArray(ruleset.sourceCitations) && ruleset.sourceCitations.length > 0
    ? ruleset.sourceCitations
    : canonicalRuleset.sourceCitations;

  return {
    ...ruleset,
    taxYear: ruleset.taxYear ?? canonicalRuleset.taxYear,
    referenceTaxYear: ruleset.referenceTaxYear ?? canonicalRuleset.referenceTaxYear,
    rulesVersion: ruleset.rulesVersion || canonicalRuleset.rulesVersion,
    approvalStatus: ruleset.approvalStatus || canonicalRuleset.approvalStatus,
    sourceCitations,
    sourceDocuments,
    lastReviewedAt: ruleset.lastReviewedAt || canonicalRuleset.lastReviewedAt,
    governance: {
      ...(canonicalRuleset.governance || {}),
      ...(ruleset.governance || {}),
      sourceDocumentCount: sourceDocuments?.length ?? canonicalRuleset.governance?.sourceDocumentCount ?? 0,
    },
    scopeSummary: ruleset.scopeSummary || canonicalRuleset.scopeSummary,
    estimatedTaxMethodology: ruleset.estimatedTaxMethodology || canonicalRuleset.estimatedTaxMethodology,
    stateTaxMethodology: ruleset.stateTaxMethodology || canonicalRuleset.stateTaxMethodology,
  };
}

function mapTaxRulesetRow(record, fallbackRuleset = null) {
  const parsedRuleset = safeParseJson(record.rules_json, null);
  const canonicalRuleset = fallbackRuleset || getTaxRulesetPackage(record.tax_year);

  return {
    taxRulesetId: record.tax_ruleset_id,
    taxYear: record.tax_year,
    rulesVersion: record.rules_version,
    approvalStatus: record.approval_status,
    sourceCitations: safeParseJson(record.source_citations_json, []),
    approvedBy: record.approved_by || null,
    approvedAt: record.approved_at || null,
    createdAt: record.created_at || null,
    ruleset: parsedRuleset ? enrichRulesetWithCanonicalMetadata(parsedRuleset, canonicalRuleset) : null,
  };
}

async function selectTaxRulesetRow({ pool, sql, taxYear, requireApproved, rulesVersion = null }) {
  const request = pool.request();
  request.input('taxYear', sql.Int, taxYear);
  request.input('approvedStatus', sql.NVarChar(40), requireApproved ? 'approved' : null);
  request.input('rulesVersion', sql.NVarChar(32), rulesVersion || null);

  const result = await request.query(`
    SELECT TOP (1)
      tax_ruleset_id,
      tax_year,
      rules_version,
      approval_status,
      rules_json,
      approved_by,
      approved_at,
      created_at
    FROM accounting.tax_rulesets
    WHERE tax_year = @taxYear
      AND (@approvedStatus IS NULL OR approval_status = @approvedStatus)
      AND (@rulesVersion IS NULL OR rules_version = @rulesVersion)
    ORDER BY
      CASE WHEN approval_status = 'approved' THEN 0 ELSE 1 END,
      approved_at DESC,
      created_at DESC
  `);

  return result.recordset?.[0] || null;
}

export async function syncTaxRulesetToAzure({
  taxYear,
  approvalStatus = null,
  approvedBy = null
} = {}) {
  const ruleset = getTaxRulesetPackage(taxYear);
  const effectiveApprovalStatus = approvalStatus || ruleset.approvalStatus || 'draft';

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      taxYear: ruleset.taxYear,
      rulesVersion: ruleset.rulesVersion,
      approvalStatus: effectiveApprovalStatus
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('taxYear', sql.Int, ruleset.taxYear);
  request.input('rulesVersion', sql.NVarChar(32), ruleset.rulesVersion);
  request.input('approvalStatus', sql.NVarChar(40), effectiveApprovalStatus);
  request.input('sourceCitationsJson', sql.NVarChar(sql.MAX), stringifyJson(ruleset.sourceCitations));
  request.input('rulesJson', sql.NVarChar(sql.MAX), stringifyJson(ruleset));
  request.input('approvedBy', sql.NVarChar(255), approvedBy || null);
  const result = await request.query(`
    MERGE accounting.tax_rulesets AS target
    USING (SELECT @taxYear AS tax_year, @rulesVersion AS rules_version) AS source
      ON target.tax_year = source.tax_year
     AND target.rules_version = source.rules_version
    WHEN MATCHED THEN UPDATE SET
      approval_status = @approvalStatus,
      source_citations_json = @sourceCitationsJson,
      rules_json = @rulesJson,
      approved_by = @approvedBy,
      approved_at = CASE
        WHEN @approvedBy IS NOT NULL THEN SYSUTCDATETIME()
        ELSE target.approved_at
      END
    WHEN NOT MATCHED THEN INSERT (
      tax_year,
      rules_version,
      approval_status,
      source_citations_json,
      rules_json,
      approved_by,
      approved_at
    ) VALUES (
      @taxYear,
      @rulesVersion,
      @approvalStatus,
      @sourceCitationsJson,
      @rulesJson,
      @approvedBy,
      CASE WHEN @approvedBy IS NOT NULL THEN SYSUTCDATETIME() ELSE NULL END
    )
    OUTPUT $action AS merge_action, inserted.tax_ruleset_id;
  `);

  const record = result.recordset?.[0] || {};
  return {
    ok: true,
    status: 'synced',
    mergeAction: String(record.merge_action || 'UPSERT').toLowerCase(),
    taxRulesetId: record.tax_ruleset_id || null,
    taxYear: ruleset.taxYear,
    rulesVersion: ruleset.rulesVersion,
    approvalStatus: effectiveApprovalStatus
  };
}

export async function upsertTaxRulesetToAzure({
  ruleset,
  approvalStatus = 'candidate',
  approvedBy = null,
} = {}) {
  if (!ruleset || typeof ruleset !== 'object') {
    throw new Error('ruleset is required');
  }

  const canonicalRuleset = getTaxRulesetPackage(ruleset.taxYear);
  const enrichedRuleset = enrichRulesetWithCanonicalMetadata(ruleset, canonicalRuleset);
  const effectiveApprovalStatus = approvalStatus || enrichedRuleset.approvalStatus || 'candidate';

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      taxYear: enrichedRuleset.taxYear,
      rulesVersion: enrichedRuleset.rulesVersion,
      approvalStatus: effectiveApprovalStatus,
      ruleset: enrichedRuleset
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('taxYear', sql.Int, enrichedRuleset.taxYear);
  request.input('rulesVersion', sql.NVarChar(32), enrichedRuleset.rulesVersion);
  request.input('approvalStatus', sql.NVarChar(40), effectiveApprovalStatus);
  request.input('sourceCitationsJson', sql.NVarChar(sql.MAX), stringifyJson(enrichedRuleset.sourceCitations));
  request.input('rulesJson', sql.NVarChar(sql.MAX), stringifyJson(enrichedRuleset));
  request.input('approvedBy', sql.NVarChar(255), approvedBy || null);
  const result = await request.query(`
    MERGE accounting.tax_rulesets AS target
    USING (SELECT @taxYear AS tax_year, @rulesVersion AS rules_version) AS source
      ON target.tax_year = source.tax_year
     AND target.rules_version = source.rules_version
    WHEN MATCHED THEN UPDATE SET
      approval_status = @approvalStatus,
      source_citations_json = @sourceCitationsJson,
      rules_json = @rulesJson,
      approved_by = @approvedBy,
      approved_at = CASE
        WHEN @approvalStatus = 'approved' THEN SYSUTCDATETIME()
        ELSE target.approved_at
      END
    WHEN NOT MATCHED THEN INSERT (
      tax_year,
      rules_version,
      approval_status,
      source_citations_json,
      rules_json,
      approved_by,
      approved_at
    ) VALUES (
      @taxYear,
      @rulesVersion,
      @approvalStatus,
      @sourceCitationsJson,
      @rulesJson,
      @approvedBy,
      CASE WHEN @approvalStatus = 'approved' THEN SYSUTCDATETIME() ELSE NULL END
    )
    OUTPUT $action AS merge_action, inserted.tax_ruleset_id;
  `);

  const record = result.recordset?.[0] || {};
  return {
    ok: true,
    status: 'persisted',
    mergeAction: String(record.merge_action || 'UPSERT').toLowerCase(),
    taxRulesetId: record.tax_ruleset_id || null,
    taxYear: enrichedRuleset.taxYear,
    rulesVersion: enrichedRuleset.rulesVersion,
    approvalStatus: effectiveApprovalStatus,
    ruleset: enrichedRuleset
  };
}

export async function listTaxRulesetsFromAzure({
  taxYear,
  limit = 20,
} = {}) {
  const fallbackRuleset = getTaxRulesetPackage(taxYear);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      rulesets: [{
        taxRulesetId: null,
        taxYear: fallbackRuleset.taxYear,
        rulesVersion: fallbackRuleset.rulesVersion,
        approvalStatus: fallbackRuleset.approvalStatus,
        approvedBy: null,
        approvedAt: null,
        createdAt: null,
        ruleset: fallbackRuleset,
      }]
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('taxYear', sql.Int, fallbackRuleset.taxYear);
  request.input('limit', sql.Int, Math.max(1, Math.min(Number(limit) || 20, 100)));
  const result = await request.query(`
    SELECT TOP (@limit)
      tax_ruleset_id,
      tax_year,
      rules_version,
      approval_status,
      source_citations_json,
      rules_json,
      approved_by,
      approved_at,
      created_at
    FROM accounting.tax_rulesets
    WHERE tax_year = @taxYear
    ORDER BY
      CASE WHEN approval_status = 'approved' THEN 0 ELSE 1 END,
      approved_at DESC,
      created_at DESC
  `);

  return {
    ok: true,
    status: 'loaded',
    rulesets: (result.recordset || []).map((record) => mapTaxRulesetRow(record, fallbackRuleset))
  };
}

export async function loadTaxRulesetForRuntime({
  taxYear,
  requireApproved = true
} = {}) {
  const fallbackRuleset = getTaxRulesetPackage(taxYear);

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      source: 'static_fallback',
      ruleset: fallbackRuleset
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  let row = await selectTaxRulesetRow({
    pool,
    sql,
    taxYear: fallbackRuleset.taxYear,
    requireApproved,
    rulesVersion: fallbackRuleset.rulesVersion
  });

  let bootstrapStatus = null;
  if (!row && requireApproved && fallbackRuleset.approvalStatus === 'approved') {
    const bootstrapResult = await syncTaxRulesetToAzure({
      taxYear: fallbackRuleset.taxYear,
      approvalStatus: 'approved',
      approvedBy: 'system-bootstrap'
    });

    bootstrapStatus = bootstrapResult.status;
    if (bootstrapResult.ok && bootstrapResult.status !== 'not_configured') {
      row = await selectTaxRulesetRow({
        pool,
        sql,
        taxYear: fallbackRuleset.taxYear,
        requireApproved,
        rulesVersion: fallbackRuleset.rulesVersion
      });
    }
  }

  if (row && requireApproved && fallbackRuleset.approvalStatus === 'approved') {
    const parsedExistingRuleset = safeParseJson(row.rules_json, null);
    const existingSourceTitles = Array.isArray(parsedExistingRuleset?.sourceDocuments)
      ? parsedExistingRuleset.sourceDocuments.map((document) => document.title).join('|')
      : '';
    const canonicalSourceTitles = Array.isArray(fallbackRuleset.sourceDocuments)
      ? fallbackRuleset.sourceDocuments.map((document) => document.title).join('|')
      : '';
    const hasSourceAuditedOverrides = Array.isArray(parsedExistingRuleset?.sourceRuleAudits)
      || parsedExistingRuleset?.tax1099?.sourceRuleAudit;
    const staleExactPayload = parsedExistingRuleset?.lastReviewedAt !== fallbackRuleset.lastReviewedAt
      || parsedExistingRuleset?.referenceTaxYear !== fallbackRuleset.referenceTaxYear
      || existingSourceTitles !== canonicalSourceTitles;

    if (staleExactPayload && !hasSourceAuditedOverrides) {
      const refreshResult = await syncTaxRulesetToAzure({
        taxYear: fallbackRuleset.taxYear,
        approvalStatus: 'approved',
        approvedBy: 'system-bootstrap'
      });
      bootstrapStatus = refreshResult.status;
      if (refreshResult.ok && refreshResult.status !== 'not_configured') {
        row = await selectTaxRulesetRow({
          pool,
          sql,
          taxYear: fallbackRuleset.taxYear,
          requireApproved,
          rulesVersion: fallbackRuleset.rulesVersion
        });
      }
    }
  }

  if (!row) {
    return {
      ok: true,
      status: requireApproved ? 'approved_ruleset_not_found' : 'ruleset_not_found',
      source: 'static_fallback',
      ruleset: fallbackRuleset,
      bootstrapStatus
    };
  }

  const parsedRuleset = safeParseJson(row.rules_json, null);
  if (!parsedRuleset || typeof parsedRuleset !== 'object') {
    return {
      ok: true,
      status: 'invalid_ruleset_payload',
      source: 'static_fallback',
      ruleset: fallbackRuleset,
      error: `Tax ruleset ${row.tax_ruleset_id} could not be parsed.`
    };
  }

  return {
    ok: true,
    status: 'loaded',
    source: 'azure_sql',
    bootstrapStatus,
    taxRulesetId: row.tax_ruleset_id,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    ruleset: enrichRulesetWithCanonicalMetadata(parsedRuleset, fallbackRuleset)
  };
}