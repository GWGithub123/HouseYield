/**
 * Firestore Bookkeeping API Routes
 * 
 * Server-side routes that use Firebase Admin SDK to access
 * user bookkeeping data stored in Firestore.
 * 
 * All routes require Firebase Auth token in Authorization header.
 */

import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getFirestore, initializeFirebaseAdmin, requireAuth, verifyIdToken } from './firebase-admin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  generateScheduleE,
  calculateDepreciation,
  calculateFederalTax,
  calculateStateTax,
  calculateMultiStateTax,
  calculateTaxLiability,
  analyzePassiveLoss,
  yearOverYearComparison,
  findMissedDeductions,
  getTaxDocumentChecklist,
  calculateMortgageSplit,
  analyzeREProStatus,
  buildMortgage1098Summaries,
} from './tax-engine-firestore.js';
import { STATE_TAX_RATES, getNoTaxStates, getStateRateSummary } from './state-tax-rates.js';
import {
  isTax1099Configured,
  createPayer,
  createRecipient,
  create1099NEC,
  submitForFiling,
  getFilingStatus,
  getFilingsByYear,
  getFormPDF,
  validateTIN,
  validateTINBatch,
  requestW9,
  getW9Status,
  executeFilingWorkflow
} from './tax1099-service.js';
import { buildScheduleEExportModel, generateTXF, generateScheduleEPDF, generateDetailedCSV, generateScheduleESummaryCSV, generate1099NecFormsPDF, detect1099NecPdfRenderer, generateOfficialScheduleEOnlyPDF, generateTaxSupportDocumentPDF } from './tax-export.js';
import {
  calculateDeductionSavings,
  analyzeCostSegregation,
  model1031Exchange,
  calculateQBIDeduction,
  calculateTravelDeduction,
  analyzeDeMinimis,
  calculateTaxEquivalentYield,
  projectDepreciationRecapture,
  generateBenefitsSummary
} from './tax-benefits-analyzer.js';
import {
  ACCOUNTING_PACKET_READINESS,
  ACCOUNTING_CLOSE_PERIOD_STATUSES,
  ACCOUNTING_DOMAIN_VERSION,
  ACCOUNTING_ENTITY_TYPES,
  formatAccountingPeriodLabel,
  getAccountingMonthBounds,
  getAccountingPeriodKey
} from '../src/shared/accountingDomain.js';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  DEFAULT_CHART_OF_ACCOUNTS_VERSION,
  getDefaultChartAccountByCode
} from '../src/shared/chartOfAccounts.js';
import {
  getTax1099ThresholdForTaxYear,
  SCHEDULE_E_LINE_MAP,
  STANDARD_DEDUCTION_2025,
  TAX_BRACKETS_2025
} from '../src/shared/taxRules.js';
import {
  digitizeDocumentFromBytes,
  digitizeDocumentFromUrl,
  summarizeDigitizationForStorage
} from './services/documentDigitizationService.js';
import {
  getAzureSqlModule,
  getAzureSqlPool,
  isAzureSqlConfigured
} from './accounting-core/azureSqlClient.js';
import {
  buildLedgerCategoryBuckets,
  buildProfitLossFromEntries,
  buildTrialBalanceFromAccounts,
  getLedgerEntryByIdFromAzure,
  listLedgerAccountsFromAzure,
  listLedgerEntriesFromAzure
} from './accounting-core/ledgerReadModel.js';
import {
  deleteBookkeepingPropertyFromAzure,
  deleteBookkeepingVendorFromAzure,
  ensureBookkeepingInitializedInAzure,
  getBookkeepingAccountFromAzure,
  isBookkeepingInitializedInAzure,
  listBookkeepingPropertiesFromAzure,
  listBookkeepingVendorsFromAzure,
  patchBookkeepingPropertyUsageDaysInAzure,
  mergeBookkeepingPropertyMetadataInAzure,
  resolveBookkeepingAccountName,
  upsertBookkeepingAccountInAzure,
  upsertBookkeepingPropertyInAzure,
  upsertBookkeepingVendorInAzure
} from './accounting-core/bookkeepingMetadataStore.js';
import { postCanonicalManualJournalEntry } from './accounting-core/manualJournalBridge.js';
import { buildJournalDraftFromFinanceEvent } from './accounting-core/postingEngine.js';
import { getReconciliationExceptionDetail, listReconciliationExceptionQueue, postJournalDraftToAzure, postJournalDraftShadowToAzure, reviewReconciliationException, stagePendingMatchToAzure } from './accounting-core/ledgerStore.js';
import { generateFinanceSearchOverview, rankFinanceSearchCandidates } from './accounting-core/financeEvidenceSearch.js';
import { buildTaxWorkpaperSnapshot } from './accounting-core/workpaperSnapshotBuilder.js';
import { getClosePeriodFromAzure, listClosePeriodsFromAzure, upsertClosePeriodToAzure } from './accounting-core/closePeriodStore.js';
import { listFinanceEvidenceFromAzure, persistFinanceEvidenceToAzure } from './accounting-core/evidenceStore.js';
import { listEstimatedTaxPaymentsFromAzure, recordEstimatedTaxPaymentToAzure } from './accounting-core/estimatedTaxPaymentStore.js';
import { listWorkpaperSnapshotsFromAzure, persistWorkpaperSnapshotToAzure } from './accounting-core/workpaperSnapshotStore.js';
import {
  listTaxRulesetsFromAzure,
  loadTaxRulesetForRuntime
} from './accounting-core/taxRulesetStore.js';
import {
  buildClaudeRulesetExtractionContract,
  validateTaxRulesetCandidate
} from './accounting-core/taxRulesetValidation.js';
import { ingestYearlyTaxRuleset } from './accounting-core/taxRulesetIngestion.js';
import {
  buildClaudeTaxEdgeCaseReviewContract,
  reviewTaxEdgeCases
} from './accounting-core/taxEdgeCaseReviewer.js';
import {
  DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
  buildRentalAnalyticsSampleFromFixture,
  clearAccountingFixtureFromAzure,
  loadAccountingFixtureDefinition,
  loadAccountingFixtureExpected,
  seedAccountingFixtureToAzure,
} from './accounting-fixtures/index.js';

const router = express.Router();
const ACCOUNTING_APPROVAL_POLICY_VERSION = `${ACCOUNTING_DOMAIN_VERSION}.approval-control`;
const CLOSE_PERIOD_REQUIRED_APPROVAL_CHECKS = ['reconciliationReviewed', 'openExceptionsResolved'];
const REOPEN_PERIOD_REQUIRED_APPROVAL_CHECKS = ['reopenReasonApproved'];
const PACKET_RELEASE_REQUIRED_APPROVAL_CHECKS = [
  'workpapersReviewed',
  'rulesVersionReviewed',
  'evidenceReviewed',
  'packetReadinessConfirmed'
];
const CLOSE_PERIOD_INTELLIGENCE_EVIDENCE_TARGET = 5;
const PACKET_RELEASE_INTELLIGENCE_EVIDENCE_TARGET = 8;
const CASH_EQUIVALENT_ACCOUNT_CODES = new Set(['1000', '1010', '1020']);
const OPEN_RECONCILIATION_MATCH_STATUSES = new Set([
  'pending_match',
  'pending_review',
  'exception_requires_review'
]);

function buildRulesRuntimeMeta(rulesRuntime = {}) {
  const ruleset = rulesRuntime.ruleset || null;
  return {
    status: rulesRuntime.status || 'unknown',
    source: rulesRuntime.source || 'unknown',
    error: rulesRuntime.error || null,
    taxRulesetId: rulesRuntime.taxRulesetId || null,
    rulesVersion: ruleset?.rulesVersion || null,
    approvalStatus: ruleset?.approvalStatus || null,
    lastReviewedAt: ruleset?.lastReviewedAt || null,
    governance: ruleset?.governance || null,
  };
}

function countObjectKeys(value) {
  return value && typeof value === 'object' ? Object.keys(value).length : 0;
}

function buildAppliedTaxRuleGroups(ruleset = {}, taxYear = new Date().getFullYear()) {
  const scheduleLineCount = countObjectKeys(ruleset.scheduleELineMap);
  const filingStatusCount = countObjectKeys(ruleset.federalTaxBrackets);
  const standardDeductionStatusCount = countObjectKeys(ruleset.standardDeduction);
  const deadlineCount = Array.isArray(ruleset.deadlineTemplates) ? ruleset.deadlineTemplates.length : 0;
  const stateRateCount = countObjectKeys(ruleset.stateTaxRates);

  return [
    {
      id: 'schedule-e-line-map',
      label: 'Schedule E line mappings',
      status: ruleset?.scheduleELineMap ? 'applied' : 'missing',
      sourceDocumentIds: ['irs-schedule-e-instructions'],
      summary: `${scheduleLineCount} Schedule E line mappings are active for rental income, expenses, and depreciation.`,
      details: [
        { label: 'Mapped lines', value: scheduleLineCount },
        { label: 'Income treatment', value: 'Rents and tenant charges route to Schedule E line 3 unless explicitly royalty income.' },
      ],
    },
    {
      id: 'federal-brackets',
      label: 'Federal income tax brackets',
      status: ruleset?.federalTaxBrackets ? 'applied' : 'missing',
      sourceDocumentIds: ['irs-federal-tax-rates'],
      summary: `${filingStatusCount} filing-status bracket tables are loaded for ${taxYear}.`,
      details: [
        { label: 'Filing statuses', value: filingStatusCount },
        { label: 'Calculation owner', value: 'Deterministic tax engine' },
      ],
    },
    {
      id: 'standard-deduction',
      label: 'Standard deduction',
      status: ruleset?.standardDeduction ? 'applied' : 'missing',
      sourceDocumentIds: ['irs-federal-tax-rates'],
      summary: `${standardDeductionStatusCount} standard-deduction amounts are loaded by filing status.`,
      details: [
        { label: 'Filing statuses', value: standardDeductionStatusCount },
      ],
    },
    {
      id: 'estimated-tax',
      label: '1040-ES estimated tax timing and safe harbor',
      status: ruleset?.estimatedTaxMethodology || ruleset?.deadlineTemplates ? 'applied' : 'missing',
      sourceDocumentIds: ['irs-form-1040-es'],
      summary: ruleset?.estimatedTaxMethodology || 'Estimated-tax methodology metadata is not attached to this ruleset.',
      details: [
        { label: 'Deadline templates', value: deadlineCount },
        { label: 'Safe harbor', value: '90% current-year and prior-year safe harbor comparison when prior-year facts are supplied.' },
      ],
    },
    {
      id: 'depreciation',
      label: 'Rental property depreciation assumptions',
      status: ruleset?.depreciation ? 'applied' : 'missing',
      sourceDocumentIds: ['irs-publication-527'],
      summary: ruleset?.depreciation
        ? `${ruleset.depreciation.method || 'GDS'} depreciation using ${ruleset.depreciation.convention || 'mid-month'} convention.`
        : 'Depreciation rules are not attached to this ruleset.',
      details: [
        { label: 'Useful life months', value: ruleset?.depreciation?.residentialRentalUsefulLifeMonths ?? null },
        { label: 'Default land %', value: ruleset?.depreciation?.defaultLandValuePercent ?? null },
      ],
    },
    {
      id: '1099-nec',
      label: '1099-NEC contractor threshold',
      status: ruleset?.tax1099 ? 'applied' : 'missing',
      sourceDocumentIds: ['irs-publication-1099'],
      summary: ruleset?.tax1099?.activeThreshold
        ? `Active contractor threshold is $${Number(ruleset.tax1099.activeThreshold).toLocaleString('en-US')} for ${taxYear}.`
        : '1099 threshold metadata is not attached to this ruleset.',
      details: [
        { label: 'Active threshold', value: ruleset?.tax1099?.activeThreshold ?? null },
        { label: 'Threshold source', value: ruleset?.tax1099?.activeThresholdSummary || null },
        { label: 'Source audit', value: ruleset?.tax1099?.sourceRuleAudit?.status || null },
      ],
    },
    {
      id: 'state-planning',
      label: 'State tax planning lookup',
      status: ruleset?.stateTaxRates || ruleset?.stateRateSummary ? 'applied' : 'missing',
      sourceDocumentIds: ['houseyield-state-rate-table'],
      summary: ruleset?.stateTaxMethodology || 'State planning methodology metadata is not attached to this ruleset.',
      details: [
        { label: 'State rates', value: stateRateCount },
        { label: 'No-tax states', value: Array.isArray(ruleset?.noIncomeTaxStates) ? ruleset.noIncomeTaxStates.length : null },
      ],
    },
  ];
}

function buildTaxRulesValidationSummary(rulesRuntime = {}, appliedRuleGroups = []) {
  const ruleset = rulesRuntime.ruleset || null;
  const sourceDocuments = Array.isArray(ruleset?.sourceDocuments) ? ruleset.sourceDocuments : [];
  const governanceWarnings = Array.isArray(ruleset?.governance?.warnings) ? ruleset.governance.warnings : [];
  const sourceRuleAudits = Array.isArray(ruleset?.sourceRuleAudits) ? ruleset.sourceRuleAudits : [];
  const requiredSourceRuleAudits = sourceRuleAudits.filter((audit) => audit.requiredForActivation);
  const passedSourceRuleAudits = requiredSourceRuleAudits.filter((audit) => ['passed', 'corrected'].includes(audit.status));
  const blockedSourceRuleAudits = requiredSourceRuleAudits.filter((audit) => !['passed', 'corrected'].includes(audit.status));
  const missingGroups = appliedRuleGroups.filter((group) => group.status !== 'applied');
  const warnings = [
    ...governanceWarnings,
    ...missingGroups.map((group) => `${group.label} is missing from the active tax rules package.`),
    ...blockedSourceRuleAudits.map((audit) => `${audit.label || audit.id} source audit did not pass.`),
  ];

  return {
    status: rulesRuntime.status === 'loaded' && warnings.length === 0 ? 'passed' : warnings.length === 0 ? 'passed' : 'attention_needed',
    sourceDocumentCount: sourceDocuments.length,
    sourceRuleAuditCount: sourceRuleAudits.length,
    requiredSourceRuleAuditCount: requiredSourceRuleAudits.length,
    passedSourceRuleAuditCount: passedSourceRuleAudits.length,
    blockedSourceRuleAuditCount: blockedSourceRuleAudits.length,
    sourceRuleAudits,
    appliedRuleGroupCount: appliedRuleGroups.filter((group) => group.status === 'applied').length,
    missingRuleGroupCount: missingGroups.length,
    warningCount: warnings.length,
    warnings,
  };
}

async function loadRuntimeTaxRulesetPackage(taxYear) {
  const result = await loadTaxRulesetForRuntime({ taxYear }).catch((error) => {
    console.error('[Tax Rules] Runtime ruleset load error:', error);
    return {
      ok: false,
      status: 'failed',
      source: 'static_fallback',
      error: error.message,
      ruleset: null
    };
  });

  return {
    status: result.status || 'failed',
    source: result.source || 'unknown',
    error: result.error || null,
    taxRulesetId: result.taxRulesetId || null,
    ruleset: result.ruleset || null
  };
}

function getTax1099ThresholdFromRuleset(ruleset, taxYear) {
  const threshold = Number(ruleset?.tax1099?.activeThreshold);
  if (Number.isFinite(threshold) && threshold > 0) {
    return threshold;
  }

  return getTax1099ThresholdForTaxYear(taxYear);
}

function getFederalTaxBracketsFromRuleset(ruleset, filingStatus = 'single') {
  const bracketTable = ruleset?.federalTaxBrackets || TAX_BRACKETS_2025;
  return bracketTable[filingStatus] || bracketTable.single;
}

function getStandardDeductionFromRuleset(ruleset, filingStatus = 'single') {
  const deductionTable = ruleset?.standardDeduction || STANDARD_DEDUCTION_2025;
  return deductionTable[filingStatus] || deductionTable.single;
}

function createApprovalPolicyError(message, details = {}) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'APPROVAL_POLICY_REQUIRED';
  error.details = details;
  return error;
}

function buildApprovalControl({
  approval = {},
  actor,
  actionType,
  requiredChecklist = [],
  approvedAt = new Date().toISOString()
}) {
  const checklist = Object.entries(approval?.checklist || {}).reduce((accumulator, [key, value]) => {
    accumulator[key] = value === true;
    return accumulator;
  }, {});
  const missingChecklist = requiredChecklist.filter((key) => checklist[key] !== true);
  const approvedBy = String(approval?.approvedBy || actor || '').trim();

  if (approval?.attested !== true) {
    throw createApprovalPolicyError('Approval attestation is required before this action can be completed.', {
      actionType,
      missing: ['attested']
    });
  }

  if (!approvedBy) {
    throw createApprovalPolicyError('Approved by is required before this action can be completed.', {
      actionType,
      missing: ['approvedBy']
    });
  }

  if (missingChecklist.length > 0) {
    throw createApprovalPolicyError('Approval checklist is incomplete.', {
      actionType,
      missing: missingChecklist
    });
  }

  return {
    policyVersion: ACCOUNTING_APPROVAL_POLICY_VERSION,
    actionType,
    approvalStatus: 'approved',
    attested: true,
    approvedBy,
    approvedAt,
    actor: actor || approvedBy,
    checklist,
    notes: approval?.notes || null
  };
}

function isOpenReconciliationException(item) {
  return OPEN_RECONCILIATION_MATCH_STATUSES.has(String(item?.matchStatus || ''));
}

async function assessClosePeriodReconciliationReadiness(userId, periodKey) {
  const queue = await listReconciliationExceptionQueue({
    userId,
    periodKey,
    includeClosed: false,
    limit: 200
  });
  const openItems = (queue.items || []).filter(isOpenReconciliationException);
  const openStatusCounts = openItems.reduce((accumulator, item) => {
    accumulator[item.matchStatus] = (accumulator[item.matchStatus] || 0) + 1;
    return accumulator;
  }, {});

  return {
    status: queue.status,
    checkedAt: new Date().toISOString(),
    totalItems: queue.summary?.totalItems || 0,
    openItemCount: openItems.length,
    openStatusCounts
  };
}

function buildClosePeriodIntelligence({
  periodKey,
  closePeriod = null,
  exceptionReview = null,
  evidence = null,
  recentClosePeriods = [],
  canonicalCloseStatus = 'not_configured'
}) {
  const label = formatAccountingPeriodLabel(periodKey);
  const evidenceSummary = evidence?.summary || {
    totalEvidence: 0,
    evidenceTypeCounts: {},
    digitizationStatusCounts: {}
  };
  const processedEvidenceCount = (evidenceSummary.digitizationStatusCounts?.completed || 0)
    + (evidenceSummary.digitizationStatusCounts?.processed || 0);
  const blockers = [];
  const warnings = [];
  const strengths = [];
  const recommendedActions = [];
  let readinessStatus = 'ready';
  let score = 82;

  if (exceptionReview?.status === 'loaded') {
    if ((exceptionReview.openItemCount || 0) > 0) {
      blockers.push(`${exceptionReview.openItemCount} reconciliation exception${exceptionReview.openItemCount === 1 ? '' : 's'} still require action before ${label} should be closed.`);
      recommendedActions.push('Resolve, match, or explicitly review each open reconciliation exception before period close.');
      readinessStatus = 'blocked';
      score -= Math.min(45, (exceptionReview.openItemCount || 0) * 12);
    } else {
      strengths.push(`No open reconciliation exceptions remain for ${label}.`);
      score += 8;
    }
  } else if (exceptionReview?.status === 'not_configured') {
    warnings.push('Canonical reconciliation readiness is not configured in this environment, so close gating is relying on Firestore-only state.');
    recommendedActions.push('Enable Azure SQL reconciliation storage to enforce canonical close controls.');
    readinessStatus = 'attention_needed';
    score -= 10;
  } else {
    warnings.push('Reconciliation readiness could not be fully verified for this period.');
    recommendedActions.push('Re-run reconciliation diagnostics before signing off on the close.');
    readinessStatus = 'attention_needed';
    score -= 12;
  }

  if (evidence?.status === 'loaded') {
    if ((evidenceSummary.totalEvidence || 0) >= CLOSE_PERIOD_INTELLIGENCE_EVIDENCE_TARGET) {
      strengths.push(`${evidenceSummary.totalEvidence} finance evidence record${evidenceSummary.totalEvidence === 1 ? '' : 's'} are indexed for ${periodKey.slice(0, 4)}.`);
      score += 6;
    } else {
      warnings.push(`Only ${evidenceSummary.totalEvidence || 0} finance evidence record${(evidenceSummary.totalEvidence || 0) === 1 ? '' : 's'} are indexed for ${periodKey.slice(0, 4)}.`);
      recommendedActions.push('Upload remaining finance documents and receipts so the close has complete supporting evidence.');
      if (readinessStatus === 'ready') {
        readinessStatus = 'attention_needed';
      }
      score -= 18;
    }

    if ((evidenceSummary.totalEvidence || 0) > 0 && processedEvidenceCount === 0) {
      warnings.push('Evidence records exist, but none of them show completed digitization yet.');
      recommendedActions.push('Review newly uploaded evidence and complete digitization before final tax and audit outputs rely on it.');
      if (readinessStatus === 'ready') {
        readinessStatus = 'attention_needed';
      }
      score -= 8;
    }
  } else if (evidence?.status === 'not_configured') {
    warnings.push('Canonical evidence storage is not configured in this environment, so document coverage cannot be scored automatically.');
    recommendedActions.push('Enable Azure SQL evidence storage to measure close support coverage automatically.');
    if (readinessStatus === 'ready') {
      readinessStatus = 'attention_needed';
    }
    score -= 10;
  } else {
    warnings.push('Evidence coverage could not be evaluated from the canonical store.');
    recommendedActions.push('Check evidence indexing before treating this close as audit-ready.');
    if (readinessStatus === 'ready') {
      readinessStatus = 'attention_needed';
    }
    score -= 12;
  }

  if (closePeriod?.status === ACCOUNTING_CLOSE_PERIOD_STATUSES.CLOSED) {
    strengths.push(`${label} is already marked closed${closePeriod.closedAt ? ` as of ${closePeriod.closedAt.slice(0, 10)}` : ''}.`);
    score = Math.max(score, 85);
  }

  if (closePeriod?.status === ACCOUNTING_CLOSE_PERIOD_STATUSES.REOPENED) {
    warnings.push(`${label} has been reopened${closePeriod.reopenedAt ? ` since ${closePeriod.reopenedAt.slice(0, 10)}` : ''}, so the corrective work should be re-verified before reclosing.`);
    recommendedActions.push('Document the corrective work completed during reopen before reclosing the period.');
    if (readinessStatus === 'ready') {
      readinessStatus = 'attention_needed';
    }
    score -= 8;
  }

  const recentReopenedPeriods = (recentClosePeriods || []).filter((period) => (
    period?.periodKey !== periodKey && period?.status === ACCOUNTING_CLOSE_PERIOD_STATUSES.REOPENED
  ));
  if (recentReopenedPeriods.length > 0) {
    warnings.push(`${recentReopenedPeriods.length} recent accounting period${recentReopenedPeriods.length === 1 ? '' : 's'} were reopened, which suggests a recurring control gap worth reviewing.`);
    score -= 5;
  }

  if (recommendedActions.length === 0) {
    recommendedActions.push('Keep reviewer attestation and supporting evidence current so the close can be released without manual follow-up.');
  }

  score = Math.max(0, Math.min(100, score));

  const regime = readinessStatus === 'blocked'
    ? 'blocked_by_reconciliation'
    : readinessStatus === 'attention_needed'
      ? 'review_before_close'
      : 'ready_for_controller_review';

  const summary = readinessStatus === 'blocked'
    ? `${label} is blocked from a clean close because reconciliation exceptions still remain open.`
    : readinessStatus === 'attention_needed'
      ? `${label} can move toward close, but evidence coverage or recent control activity still needs reviewer attention.`
      : `${label} is in a strong position for controller review based on current reconciliation and evidence signals.`;

  return {
    periodKey,
    label,
    readinessStatus,
    regime,
    score,
    summary,
    blockers,
    warnings,
    strengths,
    recommendedActions,
    sourceMetrics: {
      openExceptionCount: exceptionReview?.openItemCount || 0,
      totalExceptionCount: exceptionReview?.totalItems || 0,
      totalEvidence: evidenceSummary.totalEvidence || 0,
      processedEvidenceCount,
      recentClosePeriods: (recentClosePeriods || []).length,
      recentReopenedPeriods: recentReopenedPeriods.length
    },
    canonicalStatus: {
      closePeriods: canonicalCloseStatus,
      evidence: evidence?.status || 'unknown'
    }
  };
}

function buildPacketReleaseIntelligence({
  taxYear,
  snapshot,
  evidence = null,
  releases = null
}) {
  const evidenceSummary = evidence?.summary || {
    totalEvidence: 0,
    evidenceTypeCounts: {},
    digitizationStatusCounts: {}
  };
  const processedEvidenceCount = (evidenceSummary.digitizationStatusCounts?.completed || 0)
    + (evidenceSummary.digitizationStatusCounts?.processed || 0);
  const requiredDocuments = snapshot?.documentChecklist?.documents?.filter((document) => document.required) || [];
  const blockingDocuments = requiredDocuments.filter((document) => ['action_required', 'awaiting_lender'].includes(document.status));
  const blockers = [];
  const warnings = [];
  const strengths = [];
  const recommendedActions = [];
  const releaseSnapshots = releases?.snapshots || [];
  const releaseIntegrityCount = releaseSnapshots.filter((release) => (
    release?.artifactRecord?.sha256
    && release?.artifactRecord?.recordedAt
    && (release?.releasedAt || release?.releaseControl?.releasedAt)
  )).length;
  let readinessStatus = 'ready';
  let score = 84;

  if (snapshot?.packetReadiness !== ACCOUNTING_PACKET_READINESS.READY_FOR_CPA_REVIEW) {
    blockers.push(`Packet readiness is ${String(snapshot?.packetReadiness || 'unknown').replace(/_/g, ' ')}, so release should stay blocked until the required workpapers are complete.`);
    recommendedActions.push('Resolve the blocking workpaper or document checklist items before releasing the CPA packet.');
    readinessStatus = 'blocked';
    score -= 32;
  } else {
    strengths.push(`Packet readiness is ${snapshot.packetReadiness.replace(/_/g, ' ')}, so the workpaper snapshot has cleared the base release gate.`);
    score += 6;
  }

  if (blockingDocuments.length > 0) {
    blockers.push(`${blockingDocuments.length} required tax document${blockingDocuments.length === 1 ? '' : 's'} still show blocking statuses.`);
    recommendedActions.push('Clear the remaining required document checklist blockers before packet release.');
    readinessStatus = 'blocked';
    score -= Math.min(24, blockingDocuments.length * 8);
  }

  if ((snapshot?.vendors1099?.formsWithMissingInfo || 0) > 0) {
    warnings.push(`${snapshot.vendors1099.formsWithMissingInfo} reportable 1099 vendor${snapshot.vendors1099.formsWithMissingInfo === 1 ? '' : 's'} still have missing filing information.`);
    recommendedActions.push('Complete missing W-9, address, or TIN data for reportable 1099 vendors before final release.');
    if (readinessStatus === 'ready') {
      readinessStatus = 'attention_needed';
    }
    score -= Math.min(18, snapshot.vendors1099.formsWithMissingInfo * 6);
  } else if ((snapshot?.vendors1099?.totalForms || 0) > 0) {
    strengths.push(`All ${snapshot.vendors1099.totalForms} reportable 1099 vendor${snapshot.vendors1099.totalForms === 1 ? '' : 's'} are currently release-ready.`);
    score += 4;
  }

  if (evidence?.status === 'loaded') {
    if ((evidenceSummary.totalEvidence || 0) >= PACKET_RELEASE_INTELLIGENCE_EVIDENCE_TARGET) {
      strengths.push(`${evidenceSummary.totalEvidence} finance evidence item${evidenceSummary.totalEvidence === 1 ? '' : 's'} support the ${taxYear} packet.`);
      score += 4;
    } else {
      warnings.push(`Only ${evidenceSummary.totalEvidence || 0} finance evidence item${(evidenceSummary.totalEvidence || 0) === 1 ? '' : 's'} are indexed for ${taxYear}.`);
      recommendedActions.push('Upload or link the remaining tax support documents so the release packet has a fuller evidence trail.');
      if (readinessStatus === 'ready') {
        readinessStatus = 'attention_needed';
      }
      score -= 12;
    }

    if ((evidenceSummary.totalEvidence || 0) > 0 && processedEvidenceCount === 0) {
      warnings.push('Evidence records exist, but none currently show completed digitization.');
      recommendedActions.push('Confirm digitization output before relying on the packet for downstream review or filing.');
      if (readinessStatus === 'ready') {
        readinessStatus = 'attention_needed';
      }
      score -= 6;
    }
  } else if (evidence?.status === 'not_configured') {
    warnings.push('Canonical finance evidence storage is not configured in this environment, so evidence coverage is being estimated from zero indexed records.');
    recommendedActions.push('Enable Azure SQL evidence persistence to measure packet support coverage automatically.');
    if (readinessStatus === 'ready') {
      readinessStatus = 'attention_needed';
    }
    score -= 10;
  } else {
    warnings.push('Evidence coverage could not be evaluated for the release packet.');
    recommendedActions.push('Re-run evidence diagnostics before releasing the final packet.');
    if (readinessStatus === 'ready') {
      readinessStatus = 'attention_needed';
    }
    score -= 12;
  }

  if (releases?.status === 'loaded' && releaseSnapshots.length > 0) {
    strengths.push(`${releaseSnapshots.length} prior packet release${releaseSnapshots.length === 1 ? '' : 's'} are already recorded for ${taxYear}.`);

    if (releaseIntegrityCount === releaseSnapshots.length) {
      strengths.push(`All recorded packet releases for ${taxYear} include immutable artifact digests and release timestamps.`);
      score += 4;
    } else {
      const missingIntegrityCount = releaseSnapshots.length - releaseIntegrityCount;
      warnings.push(`${missingIntegrityCount} recorded packet release${missingIntegrityCount === 1 ? '' : 's'} are missing immutable artifact integrity metadata.`);
      recommendedActions.push('Reissue or repair older packet releases that do not yet carry immutable digests and release timestamps.');
      if (readinessStatus === 'ready') {
        readinessStatus = 'attention_needed';
      }
      score -= Math.min(12, missingIntegrityCount * 4);
    }
  } else if (releases?.status === 'not_configured') {
    warnings.push('Immutable packet release history is not configured locally because Azure SQL is not enabled.');
    if (readinessStatus === 'ready') {
      readinessStatus = 'attention_needed';
    }
    score -= 6;
  }

  if (recommendedActions.length === 0) {
    recommendedActions.push('Maintain evidence links and reviewer attestations so the next packet release remains repeatable and audit-ready.');
  }

  score = Math.max(0, Math.min(100, score));

  const regime = readinessStatus === 'blocked'
    ? 'blocked_for_release'
    : readinessStatus === 'attention_needed'
      ? 'review_before_release'
      : 'ready_for_packet_release';

  const summary = readinessStatus === 'blocked'
    ? `${taxYear} packet release is blocked by unresolved workpaper or document requirements.`
    : readinessStatus === 'attention_needed'
      ? `${taxYear} packet release can move forward, but evidence or filing support still needs reviewer attention.`
      : `${taxYear} packet release is in a strong position for final reviewer approval.`;

  return {
    taxYear,
    readinessStatus,
    regime,
    score,
    summary,
    blockers,
    warnings,
    strengths,
    recommendedActions,
    sourceMetrics: {
      packetReadiness: snapshot?.packetReadiness || 'unknown',
      blockingDocumentCount: blockingDocuments.length,
      reportable1099Forms: snapshot?.vendors1099?.totalForms || 0,
      formsWithMissingInfo: snapshot?.vendors1099?.formsWithMissingInfo || 0,
      totalEvidence: evidenceSummary.totalEvidence || 0,
      processedEvidenceCount,
      packetReleaseCount: releaseSnapshots.length,
      releaseIntegrityCount
    },
    canonicalStatus: {
      evidence: evidence?.status || 'unknown',
      releases: releases?.status || 'unknown'
    }
  };
}

// Initialize Firebase Admin on module load
try {
  initializeFirebaseAdmin();
} catch (error) {
  console.warn('⚠️  [Bookkeeping Firestore] Firebase Admin initialization deferred');
}

// Initialize Gemini for AI categorization
const GEMINI_API_KEY = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Schedule E line mapping for AI categorization
const SCHEDULE_E_CATEGORIES = {
  // Income Categories
  'Rent Income': { code: '4000', scheduleELine: 3, type: 'income', description: 'Monthly rent payments' },
  'Rental Income': { code: '4000', scheduleELine: 3, type: 'income', description: 'Monthly rent payments (alias)' },
  // For Schedule E rental backtests, tenant-paid charges stay on line 3 rents received.
  'Late Fees': { code: '4100', scheduleELine: 3, type: 'income', description: 'Late payment fees from tenants' },
  'Security Deposit Forfeited': { code: '4100', scheduleELine: 3, type: 'income', description: 'Security deposits kept for damages' },
  'Other Rental Income': { code: '4900', scheduleELine: 3, type: 'income', description: 'Application fees, pet fees, etc.' },
  'Other Income': { code: '4900', scheduleELine: 3, type: 'income', description: 'Application fees, pet fees, etc. (alias)' },
  'Application Fees': { code: '4200', scheduleELine: 3, type: 'income', description: 'Rental application fees' },
  'Pet Fees': { code: '4300', scheduleELine: 3, type: 'income', description: 'Pet deposits and fees' },
  
  // Advertising & Marketing
  'Advertising': { code: '6000', scheduleELine: 5, type: 'expense', description: 'Zillow, Apartments.com, signs' },
  
  // Auto & Travel
  'Auto & Travel': { code: '5999', scheduleELine: 6, type: 'expense', description: 'Mileage to properties, travel for repairs' },
  'Gas & Fuel': { code: '5999', scheduleELine: 6, type: 'expense', description: 'Fuel for property-related travel' },
  'Parking & Tolls': { code: '5999', scheduleELine: 6, type: 'expense', description: 'Parking fees, toll roads' },
  
  // Cleaning & Maintenance
  'Cleaning & Maintenance': { code: '5800', scheduleELine: 7, type: 'expense', description: 'Turnover cleaning, regular maintenance' },
  'Cleaning': { code: '5800', scheduleELine: 7, type: 'expense', description: 'Turnover cleaning (alias)' },
  'Janitorial': { code: '5800', scheduleELine: 7, type: 'expense', description: 'Common area cleaning, trash removal' },
  
  // Commissions
  'Commissions': { code: '5400', scheduleELine: 8, type: 'expense', description: 'Leasing commissions, property management' },
  
  // Insurance
  'Insurance': { code: '5200', scheduleELine: 9, type: 'expense', description: 'Landlord insurance, umbrella policy' },
  
  // Legal & Professional
  'Legal & Professional': { code: '5900', scheduleELine: 10, type: 'expense', description: 'Attorney, CPA, eviction costs' },
  'Accounting & Bookkeeping': { code: '5900', scheduleELine: 10, type: 'expense', description: 'CPA fees, tax preparation' },
  'Legal Fees': { code: '5900', scheduleELine: 10, type: 'expense', description: 'Attorney fees, eviction costs' },
  
  // Management Fees
  'Management Fees': { code: '5400', scheduleELine: 11, type: 'expense', description: 'Property management company fees' },
  'Property Management': { code: '5400', scheduleELine: 11, type: 'expense', description: 'Property management company fees (alias)' },
  'Software & Subscriptions': { code: '5400', scheduleELine: 11, type: 'expense', description: 'Property management software, apps' },
  
  // Interest
  'Mortgage Interest': { code: '5500', scheduleELine: 12, type: 'expense', description: 'Interest paid to bank/lender' },
  'Other Interest': { code: '5999', scheduleELine: 13, type: 'expense', description: 'Non-mortgage interest' },
  'Bank Fees': { code: '5999', scheduleELine: 13, type: 'expense', description: 'Bank charges, wire fees' },
  
  // Repairs
  'Repairs': { code: '5000', scheduleELine: 14, type: 'expense', description: 'Plumbing, electrical, appliance repair' },
  'Repairs & Maintenance': { code: '5000', scheduleELine: 14, type: 'expense', description: 'Plumbing, electrical, appliance repair (alias)' },
  'Plumbing': { code: '5000', scheduleELine: 14, type: 'expense', description: 'Plumbing repairs and maintenance' },
  'Electrical': { code: '5000', scheduleELine: 14, type: 'expense', description: 'Electrical repairs and maintenance' },
  'HVAC': { code: '5000', scheduleELine: 14, type: 'expense', description: 'Heating, cooling, ventilation repairs' },
  'Appliance Repair': { code: '5000', scheduleELine: 14, type: 'expense', description: 'Refrigerator, washer, dryer repairs' },
  'Roof Repair': { code: '5000', scheduleELine: 14, type: 'expense', description: 'Roof repairs and maintenance' },
  
  // Supplies
  'Supplies': { code: '5000', scheduleELine: 15, type: 'expense', description: 'Hardware, cleaning supplies, paint' },
  'Office Supplies': { code: '5000', scheduleELine: 15, type: 'expense', description: 'Paper, printer ink, envelopes' },
  'Hardware & Tools': { code: '5000', scheduleELine: 15, type: 'expense', description: 'Tools, screws, nails, fixtures' },
  
  // Property Taxes
  'Property Taxes': { code: '5300', scheduleELine: 16, type: 'expense', description: 'County/city property taxes' },
  'Property Tax': { code: '5300', scheduleELine: 16, type: 'expense', description: 'County/city property taxes (alias)' },
  
  // Utilities
  'Utilities': { code: '5100', scheduleELine: 17, type: 'expense', description: 'Electric, gas, water, trash, internet' },
  'Electric': { code: '5100', scheduleELine: 17, type: 'expense', description: 'Electricity bills' },
  'Natural Gas': { code: '5100', scheduleELine: 17, type: 'expense', description: 'Natural gas bills' },
  'Water & Sewer': { code: '5100', scheduleELine: 17, type: 'expense', description: 'Water and sewer charges' },
  'Trash & Recycling': { code: '5100', scheduleELine: 17, type: 'expense', description: 'Garbage collection' },
  'Internet & Cable': { code: '5100', scheduleELine: 17, type: 'expense', description: 'Internet, cable, phone' },
  
  // Depreciation
  'Depreciation': { code: '6100', scheduleELine: 18, type: 'expense', description: 'Building depreciation (27.5 years)' },
  'Depreciation Expense': { code: '6100', scheduleELine: 18, type: 'expense', description: 'Building depreciation (27.5 years) (alias)' },
  
  // Other Expenses (Line 19)
  'HOA Fees': { code: '5600', scheduleELine: 19, type: 'expense', description: 'Homeowner association dues' },
  'Landscaping': { code: '5700', scheduleELine: 19, type: 'expense', description: 'Lawn care, tree trimming, snow removal' },
  'Pest Control': { code: '5750', scheduleELine: 19, type: 'expense', description: 'Exterminator, pest prevention' },
  'Security': { code: '5999', scheduleELine: 19, type: 'expense', description: 'Security system, locks, cameras' },
  'Tenant Screening': { code: '5999', scheduleELine: 19, type: 'expense', description: 'Background checks, credit reports' },
  'Other Expenses': { code: '5999', scheduleELine: 19, type: 'expense', description: 'Miscellaneous deductible expenses' },
  
  // Personal / Non-Deductible Categories (for mixed-use accounts)
  'Groceries': { code: null, scheduleELine: null, type: 'personal', description: 'Personal food purchases' },
  'Dining & Restaurants': { code: null, scheduleELine: null, type: 'personal', description: 'Restaurants, takeout, coffee shops' },
  'Entertainment': { code: null, scheduleELine: null, type: 'personal', description: 'Movies, streaming, games, concerts' },
  'Shopping': { code: null, scheduleELine: null, type: 'personal', description: 'Personal shopping, clothing, retail' },
  'Healthcare': { code: null, scheduleELine: null, type: 'personal', description: 'Medical, pharmacy, health' },
  'Transportation': { code: null, scheduleELine: null, type: 'personal', description: 'Personal transit, rideshare, Uber' },
  'Subscriptions': { code: null, scheduleELine: null, type: 'personal', description: 'Personal subscriptions (Netflix, Spotify, Audible)' },
  'Fitness & Gym': { code: null, scheduleELine: null, type: 'personal', description: 'Gym memberships, fitness classes' },
  'Education': { code: null, scheduleELine: null, type: 'personal', description: 'Courses, books, learning materials' },
  'Travel & Vacation': { code: null, scheduleELine: null, type: 'personal', description: 'Personal travel, hotels, flights' },
  'Gifts & Donations': { code: null, scheduleELine: null, type: 'personal', description: 'Gifts, charitable donations' },
  'ATM & Cash': { code: null, scheduleELine: null, type: 'personal', description: 'ATM withdrawals, cash transactions' },
  'Transfer': { code: null, scheduleELine: null, type: 'transfer', description: 'Internal transfers between accounts' },
  'Personal/Non-Deductible': { code: null, scheduleELine: null, type: 'personal', description: 'Not related to rental property' }
};

const RECEIPT_CATEGORY_ALIASES = {
  'Travel': 'Auto & Travel',
  'Office Supplies': 'Supplies',
  'Other Expense': 'Other Expenses'
};
const SCHEDULE_E_LINE_BY_ACCOUNT_CODE = Object.values(SCHEDULE_E_CATEGORIES).reduce((map, category) => {
  if (category?.code && Number.isInteger(category.scheduleELine) && !map.has(category.code)) {
    map.set(category.code, category.scheduleELine);
  }
  return map;
}, new Map());
const SCHEDULE_E_CATEGORY_BY_ACCOUNT_CODE = Object.entries(SCHEDULE_E_CATEGORIES).reduce((map, [categoryName, category]) => {
  if (category?.code && !map.has(category.code)) {
    map.set(category.code, categoryName);
  }
  return map;
}, new Map());
const SCHEDULE_E_CATEGORY_BY_LINE = Object.entries(SCHEDULE_E_CATEGORIES).reduce((map, [categoryName, category]) => {
  if (Number.isInteger(category?.scheduleELine) && !map.has(category.scheduleELine)) {
    map.set(category.scheduleELine, categoryName);
  }
  return map;
}, new Map());
const RECURRING_TRANSACTION_TEMPLATES = {
  MORTGAGE_INTEREST: {
    name: 'Mortgage Interest Payment',
    frequency: 'monthly',
    accountCode: '5500',
    offsetAccountCode: '1000',
    dayOfMonth: 1,
  },
  PROPERTY_TAX: {
    name: 'Property Tax Payment',
    frequency: 'quarterly',
    accountCode: '5300',
    offsetAccountCode: '1000',
    dayOfMonth: 15,
  },
  INSURANCE: {
    name: 'Insurance Premium',
    frequency: 'monthly',
    accountCode: '5200',
    offsetAccountCode: '1000',
    dayOfMonth: 1,
  },
  HOA_DUES: {
    name: 'HOA Dues',
    frequency: 'monthly',
    accountCode: '5600',
    offsetAccountCode: '1000',
    dayOfMonth: 1,
  },
  UTILITIES: {
    name: 'Utilities Payment',
    frequency: 'monthly',
    accountCode: '5100',
    offsetAccountCode: '1000',
    dayOfMonth: 1,
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

function getAccountsRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('accounts');
}

function getJournalEntriesRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('journalEntries');
}

function getCategoriesRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('categories');
}

function getConfigRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('config');
}

function getTaxDraftProfileRef(userId, taxYear) {
  return getConfigRef(userId).collection('taxDraftProfiles').doc(String(taxYear));
}

function normalizeTaxDraftProfile(input = {}, fallbackState = '') {
  const profile = input && typeof input === 'object' ? input : {};
  const cleanedState = String(profile.mailingState || fallbackState || '').trim().toUpperCase().slice(0, 2);
  const normalizeMoneyField = (value) => {
    const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '').trim();
    if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return '';
    return cleaned.slice(0, 20);
  };

  return {
    primaryName: String(profile.primaryName || '').trim().slice(0, 120),
    spouseName: String(profile.spouseName || '').trim().slice(0, 120),
    tinLast4: String(profile.tinLast4 || '').replace(/\D/g, '').slice(0, 4),
    mailingStreet: String(profile.mailingStreet || '').trim().slice(0, 180),
    mailingCity: String(profile.mailingCity || '').trim().slice(0, 120),
    mailingState: cleanedState,
    mailingZip: String(profile.mailingZip || '').trim().slice(0, 12),
  };
}

function parseOptionalMoney(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') {
    return null;
  }

  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

const MAX_SCENARIO_OTHER_INCOME = 25_000_000;

function sanitizeTaxScenarioOtherIncome(value) {
  const numeric = parseOptionalMoney(value) || 0;
  if (numeric > MAX_SCENARIO_OTHER_INCOME) {
    console.warn(`[Tax] Clamping implausible otherIncome value: ${numeric}`);
    return 0;
  }
  return numeric;
}

function resolveEstimatedTaxAsOfDate(taxYear, requestedAsOfDate = null) {
  const explicit = String(requestedAsOfDate || '').trim();
  if (explicit) {
    return explicit.slice(0, 10);
  }

  const numericTaxYear = Number(taxYear);
  const currentYear = new Date().getFullYear();
  if (Number.isInteger(numericTaxYear) && numericTaxYear < currentYear) {
    return `${numericTaxYear}-12-31`;
  }

  return new Date().toISOString().slice(0, 10);
}

function getQuarterForAsOfDate(asOfDate) {
  const normalized = new Date(`${String(asOfDate || '').slice(0, 10)}T23:59:59`);
  const fallback = Math.ceil((new Date().getMonth() + 1) / 3);
  if (Number.isNaN(normalized.getTime())) {
    return fallback;
  }
  return Math.min(4, Math.max(1, Math.ceil((normalized.getMonth() + 1) / 3)));
}

function collectRentalStates(properties = []) {
  return Array.from(new Set(
    (properties || [])
      .map((property) => String(property?.state || property?.attomState || property?.mailingState || '').trim().toUpperCase())
      .filter(Boolean)
  ));
}

/**
 * Count properties whose personal use exceeds the §280A 14-day / 10% threshold,
 * so the quarterly-estimate readiness layer can flag mixed-use exposure.
 */
function countPersonalUseLimitedProperties(properties = []) {
  return (properties || []).filter((property) => {
    const personalUseDays = Math.max(0, Number(property?.personalUseDays) || 0);
    const fairRentalDays = Math.max(0, Number(property?.fairRentalDays) || 0) || 365;
    return personalUseDays > 14 && personalUseDays > fairRentalDays * 0.10;
  }).length;
}

async function loadTaxDraftProfile(userId, taxYear, fallbackState = '') {
  const snapshot = await getTaxDraftProfileRef(userId, taxYear).get();
  const data = snapshot.exists ? snapshot.data() || {} : {};
  return {
    taxYear,
    profile: normalizeTaxDraftProfile(data.profile || {}, fallbackState),
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null,
  };
}

async function persistTaxDraftProfile(userId, taxYear, profileInput, updatedBy, fallbackState = '') {
  const profile = normalizeTaxDraftProfile(profileInput, fallbackState);
  const now = new Date().toISOString();
  await getTaxDraftProfileRef(userId, taxYear).set({
    taxYear,
    profile,
    updatedAt: now,
    updatedBy: updatedBy || null,
  }, { merge: true });
  await getConfigRef(userId).set({ updatedAt: now }, { merge: true });
  return {
    taxYear,
    profile,
    updatedAt: now,
    updatedBy: updatedBy || null,
  };
}

function getClosePeriodsRef(userId) {
  return getConfigRef(userId).collection('closePeriods');
}

function getBudgetsRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('budgets');
}

function getFinanceDocumentsRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('financeDocuments');
}

function getCategorizationRulesRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('categorizationRules');
}

function getRecurringTransactionsRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('recurringTransactions');
}

function shouldUseCanonicalLedger(result) {
  return result?.status === 'ready';
}

function buildCanonicalLedgerUnavailableError(surface, result = null) {
  const canonicalStatus = String(result?.status || 'not_ready');
  const canonicalError = result?.error || null;
  const suffix = canonicalError ? `: ${canonicalError}` : '';
  const error = new Error(`Canonical ledger unavailable for ${surface}${suffix}`);
  error.statusCode = 503;
  error.details = {
    canonicalStatus,
    canonicalError
  };
  return error;
}

function requireCanonicalLedgerResult(result, surface) {
  if (!shouldUseCanonicalLedger(result)) {
    throw buildCanonicalLedgerUnavailableError(surface, result);
  }

  return result;
}

function buildBookkeepingFoundationStatus() {
  return {
    domainVersion: ACCOUNTING_DOMAIN_VERSION,
    chartOfAccountsVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION
  };
}

async function getBookkeepingAccountRecord(userId, accountCode) {
  const canonicalResult = await getBookkeepingAccountFromAzure({ userId, accountCode }).catch((error) => {
    console.error('[Bookkeeping] Canonical account lookup error:', error);
    return { ok: false, status: 'failed', error: error.message, account: null };
  });

  const readyCanonicalResult = requireCanonicalLedgerResult(canonicalResult, `account ${accountCode}`);
  return readyCanonicalResult.account || null;
}

async function listBookkeepingPropertyMetadata(userId) {
  const canonicalResult = await listBookkeepingPropertiesFromAzure({ userId }).catch((error) => {
    console.error('[Bookkeeping] Canonical property list error:', error);
    return { ok: false, status: 'failed', error: error.message, properties: [] };
  });

  const readyCanonicalResult = requireCanonicalLedgerResult(canonicalResult, 'property metadata');
  return readyCanonicalResult.properties || [];
}

async function resolveCanonicalPropertyScope(userId, propertyId) {
  const requestedPropertyId = String(propertyId || '').trim() || null;
  if (!requestedPropertyId) {
    return {
      requestedPropertyId: null,
      propertyScopeIds: new Set(),
    };
  }

  const propertyScopeIds = new Set([requestedPropertyId]);
  const properties = await listBookkeepingPropertyMetadata(userId);

  for (const property of properties) {
    const canonicalPropertyId = String(property?.id || '').trim();
    const fixturePropertyId = String(property?.sourceFixturePropertyId || '').trim();

    if (
      canonicalPropertyId === requestedPropertyId
      || fixturePropertyId === requestedPropertyId
    ) {
      if (canonicalPropertyId) {
        propertyScopeIds.add(canonicalPropertyId);
      }
      if (fixturePropertyId) {
        propertyScopeIds.add(fixturePropertyId);
      }
    }
  }

  return {
    requestedPropertyId,
    propertyScopeIds,
  };
}

function entryMatchesCanonicalPropertyScope(entry, propertyScopeIds) {
  if (!propertyScopeIds || propertyScopeIds.size === 0) {
    return true;
  }

  const entryPropertyId = String(entry?.propertyId || '').trim();
  if (entryPropertyId && propertyScopeIds.has(entryPropertyId)) {
    return true;
  }

  return (entry?.lines || []).some((line) => {
    const linePropertyId = String(line?.propertyId || '').trim();
    return linePropertyId && propertyScopeIds.has(linePropertyId);
  });
}

function remapCanonicalEntryPropertyScope(entry, requestedPropertyId, propertyScopeIds) {
  if (!requestedPropertyId || !propertyScopeIds || propertyScopeIds.size === 0) {
    return entry;
  }

  const remapPropertyId = (value) => {
    const normalizedValue = String(value || '').trim();
    return normalizedValue && propertyScopeIds.has(normalizedValue)
      ? requestedPropertyId
      : (value || null);
  };

  return {
    ...entry,
    propertyId: remapPropertyId(entry?.propertyId),
    lines: (entry?.lines || []).map((line) => ({
      ...line,
      propertyId: remapPropertyId(line?.propertyId),
    })),
  };
}

async function resolveScopedBookkeepingProperties(userId, propertyId, properties = []) {
  const { requestedPropertyId, propertyScopeIds } = await resolveCanonicalPropertyScope(userId, propertyId);
  if (!requestedPropertyId) {
    return properties;
  }

  const matched = (properties || []).filter((property) => {
    const canonicalPropertyId = String(property?.id || '').trim();
    const fixturePropertyId = String(property?.sourceFixturePropertyId || '').trim();
    return propertyScopeIds.has(canonicalPropertyId)
      || (fixturePropertyId && propertyScopeIds.has(fixturePropertyId));
  });

  if (matched.length > 0) {
    return matched.map((property) => ({
      ...property,
      id: requestedPropertyId,
    }));
  }

  if ((properties || []).length === 1) {
    return [{
      ...properties[0],
      id: requestedPropertyId,
    }];
  }

  return matched;
}

async function loadCanonicalLedgerEntriesForScope({
  userId,
  startDate = null,
  endDate = null,
  propertyId = null,
  limit = 10000,
  errorLabel = 'ledger entries',
}) {
  const { requestedPropertyId, propertyScopeIds } = await resolveCanonicalPropertyScope(userId, propertyId);
  const shouldQueryUnscoped = requestedPropertyId && propertyScopeIds.size > 1;

  const canonicalEntries = await listLedgerEntriesFromAzure({
    userId,
    startDate,
    endDate,
    propertyId: shouldQueryUnscoped ? null : requestedPropertyId,
    limit,
  }).catch((error) => {
    console.error(`[Bookkeeping] Canonical ${errorLabel} error:`, error);
    return { ok: false, status: 'failed', error: error.message, entries: [] };
  });

  const readyCanonicalEntries = requireCanonicalLedgerResult(canonicalEntries, errorLabel);
  let scopedEntries = readyCanonicalEntries.entries || [];

  if (requestedPropertyId) {
    scopedEntries = scopedEntries
      .filter((entry) => entryMatchesCanonicalPropertyScope(entry, propertyScopeIds))
      .map((entry) => remapCanonicalEntryPropertyScope(entry, requestedPropertyId, propertyScopeIds));

    if (scopedEntries.length === 0) {
      const unscopedCanonicalEntries = await listLedgerEntriesFromAzure({
        userId,
        startDate,
        endDate,
        propertyId: null,
        limit,
      }).catch((error) => {
        console.error(`[Bookkeeping] Canonical ${errorLabel} unscoped fallback error:`, error);
        return { ok: false, status: 'failed', error: error.message, entries: [] };
      });
      const readyUnscopedEntries = requireCanonicalLedgerResult(unscopedCanonicalEntries, `${errorLabel} unscoped fallback`);
      const unscopedEntries = readyUnscopedEntries.entries || [];
      const unscopedPropertyIds = new Set();

      for (const entry of unscopedEntries) {
        const entryPropertyId = String(entry?.propertyId || '').trim();
        if (entryPropertyId) {
          unscopedPropertyIds.add(entryPropertyId);
        }
        for (const line of entry?.lines || []) {
          const linePropertyId = String(line?.propertyId || '').trim();
          if (linePropertyId) {
            unscopedPropertyIds.add(linePropertyId);
          }
        }
      }

      if (unscopedPropertyIds.size === 1) {
        const [canonicalOnlyPropertyId] = Array.from(unscopedPropertyIds);
        propertyScopeIds.add(canonicalOnlyPropertyId);
        scopedEntries = unscopedEntries
          .filter((entry) => entryMatchesCanonicalPropertyScope(entry, propertyScopeIds))
          .map((entry) => remapCanonicalEntryPropertyScope(entry, requestedPropertyId, propertyScopeIds));
      }
    }
  }

  return {
    entries: scopedEntries,
    requestedPropertyId,
    propertyScopeIds,
  };
}

async function listBookkeepingVendorMetadata(userId) {
  const canonicalResult = await listBookkeepingVendorsFromAzure({ userId }).catch((error) => {
    console.error('[Bookkeeping] Canonical vendor list error:', error);
    return { ok: false, status: 'failed', error: error.message, vendors: [] };
  });

  const readyCanonicalResult = requireCanonicalLedgerResult(canonicalResult, 'vendor metadata');
  return readyCanonicalResult.vendors || [];
}

function buildVendorPaymentsFromEntries(entries = []) {
  const vendorPayments = new Map();

  for (const entry of entries) {
    if (entry.type !== 'expense' && entry.transactionType !== 'expense' && entry.isExpense !== true) {
      continue;
    }

    const vendorName = String(entry.vendor || entry.payee || '').trim();
    if (!vendorName) {
      continue;
    }

    const amount = Math.abs(Number(entry.amount ?? entry.signedAmount ?? entry.totalDebits ?? 0) || 0);
    if (!amount) {
      continue;
    }

    const current = vendorPayments.get(vendorName) || {
      totalPaid: 0,
      transactions: []
    };
    current.totalPaid += amount;
    current.transactions.push({
      date: entry.date || entry.entryDate || null,
      amount,
      description: entry.description || entry.memo || '',
      category: entry.category || ''
    });
    vendorPayments.set(vendorName, current);
  }

  return vendorPayments;
}

function mapCanonicalEntryForReclassification(entry) {
  if (!entry) {
    return null;
  }

  const primaryNonCashLine = (entry.lines || []).find((line) => line.accountCode !== '1000') || null;
  return {
    id: entry.id,
    entryDate: entry.entryDate,
    date: entry.entryDate,
    memo: entry.memo || '',
    source: entry.sourceSystem || 'MANUAL',
    sourceRef: entry.sourceRef || null,
    lines: (entry.lines || []).map((line) => ({
      accountCode: line.accountCode,
      accountName: line.accountName,
      amount: line.amount,
      dc: line.dc,
      propertyId: line.propertyId || null,
      memo: line.memo || ''
    })),
    totalDebits: entry.totalDebits || 0,
    totalCredits: entry.totalCredits || 0,
    propertyId: entry.propertyId || null,
    category: entry.category || primaryNonCashLine?.accountName || '',
    scheduleELine: primaryNonCashLine?.scheduleELine ?? null,
    isExpense: entry.isExpense,
    type: entry.type || null,
    updatedAt: entry.updatedAt || null,
    reclassifiedAt: entry.metadata?.reclassifiedAt || null,
    reclassifiedBy: entry.metadata?.reclassifiedBy || null
  };
}

function mapCanonicalAccountForResponse(account) {
  const scheduleELine = SCHEDULE_E_LINE_BY_ACCOUNT_CODE.get(account.code) || null;
  return {
    ...account,
    scheduleELine,
    tax_map: scheduleELine ? `Schedule E Line ${scheduleELine}` : null
  };
}

function buildCanonicalTransactions(entries = [], { type = null, limit = null } = {}) {
  const requestedType = !type || type === 'all' ? null : String(type);
  const filtered = entries
    .filter((entry) => entry.transactionType)
    .filter((entry) => !requestedType || entry.transactionType === requestedType)
    .map((entry) => {
      const primaryNonCashLine = (entry.lines || []).find((line) => line.accountCode !== '1000') || null;
      const scheduleELine = entry.scheduleELine ?? primaryNonCashLine?.scheduleELine ?? null;
      const accountCode = primaryNonCashLine?.accountCode || null;

      return {
        id: entry.id,
        date: entry.entryDate,
        description: entry.description,
        category: entry.category,
        amount: entry.signedAmount,
        type: entry.transactionType,
        propertyId: entry.propertyId || null,
        source: entry.sourceSystem || 'MANUAL',
        sourceRef: entry.sourceRef || null,
        financeEventType: entry.financeEventType || null,
        vendor: entry.vendor || null,
        accountCode,
        scheduleELine,
        taxMap: scheduleELine ? `Schedule E Line ${scheduleELine}` : null
      };
    })
    .sort((left, right) => String(right.date).localeCompare(String(left.date)));

  if (!limit) {
    return filtered;
  }

  return filtered.slice(0, Math.max(1, Number(limit) || 50));
}

function buildCanonicalCashflowTrend(entries = [], months = 6, options = {}) {
  const trend = [];
  const { startDate = null, endDate = null } = options || {};
  const normalizedStart = parseDateOnly(startDate);
  const normalizedEnd = parseDateOnly(endDate);
  const monthStarts = [];

  if (normalizedStart && normalizedEnd && normalizedStart.getTime() <= normalizedEnd.getTime()) {
    let cursorYear = normalizedStart.getUTCFullYear();
    let cursorMonth = normalizedStart.getUTCMonth();
    const endYear = normalizedEnd.getUTCFullYear();
    const endMonth = normalizedEnd.getUTCMonth();

    while (cursorYear < endYear || (cursorYear === endYear && cursorMonth <= endMonth)) {
      monthStarts.push(new Date(Date.UTC(cursorYear, cursorMonth, 1)));
      cursorMonth += 1;
      if (cursorMonth > 11) {
        cursorMonth = 0;
        cursorYear += 1;
      }
    }
  } else {
    const today = new Date();
    for (let index = months - 1; index >= 0; index -= 1) {
      monthStarts.push(new Date(today.getFullYear(), today.getMonth() - index, 1));
    }
  }

  for (const date of monthStarts) {
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    let income = 0;
    let expenses = 0;

    for (const entry of entries) {
      if (String(entry.entryDate || '').slice(0, 7) !== monthKey) {
        continue;
      }

      if (entry.transactionType === 'income') {
        income += Number(entry.signedAmount || 0);
      } else if (entry.transactionType === 'expense') {
        expenses += -Number(entry.signedAmount || 0);
      }
    }

    const monthName = date.toLocaleString('default', { month: 'long' });
    trend.push({
      month: monthName,
      year: date.getFullYear(),
      revenue: roundCurrency(income),
      income: roundCurrency(income),
      expenses: roundCurrency(expenses),
      net: roundCurrency(income - expenses),
      net_income: roundCurrency(income - expenses)
    });
  }

  return trend;
}

function lineMatchesPropertyScope(line, propertyId, fallbackPropertyId = null) {
  if (!propertyId) {
    return true;
  }

  return String(line?.propertyId || fallbackPropertyId || '') === String(propertyId);
}

function buildAccountBalancesFromEntries(entries = [], accounts = [], propertyId = null) {
  const accountMap = new Map(
    (accounts || []).map((account) => [account.code, account]),
  );
  const balances = new Map();

  for (const entry of entries || []) {
    for (const line of entry.lines || []) {
      if (!line?.accountCode || !lineMatchesPropertyScope(line, propertyId, entry.propertyId || null)) {
        continue;
      }

      const signedAmount = Number(line.amount || 0) * (line.dc === 'D' ? 1 : -1);
      if (!signedAmount) {
        continue;
      }

      balances.set(line.accountCode, Number(balances.get(line.accountCode) || 0) + signedAmount);
    }
  }

  return Array.from(balances.entries())
    .map(([code, balance]) => {
      const existing = accountMap.get(code) || null;
      const defaultAccount = getDefaultChartAccountByCode(code) || null;

      return {
        code,
        name: existing?.name || defaultAccount?.name || resolveBookkeepingAccountName(code),
        type: existing?.type || defaultAccount?.type || 'ASSET',
        balance: roundCurrency(balance),
      };
    })
    .filter((account) => Math.abs(Number(account.balance || 0)) >= 0.005)
    .sort((left, right) => String(left.code).localeCompare(String(right.code)));
}

function mapCanonicalEntriesForTax(entries = []) {
  return entries.map((entry) => {
    let amount = 0;
    if (entry.transactionType === 'income') {
      amount = Number(entry.signedAmount || 0);
    } else if (entry.transactionType === 'expense') {
      amount = Number(entry.signedAmount || 0);
    }

    const category = deriveCanonicalTaxCategory(entry);
    const propertyId = deriveCanonicalTaxPropertyId(entry);
    return {
      id: entry.id,
      entryDate: entry.entryDate,
      date: entry.entryDate,
      category,
      type: entry.transactionType || '',
      isExpense: entry.transactionType === 'expense' ? true : entry.transactionType === 'income' ? false : null,
      description: entry.description || '',
      vendor: entry.vendor || '',
      payee: entry.payee || '',
      amount,
      propertyId,
      source: entry.sourceSystem || null,
      sourceRef: entry.sourceRef || null,
      memo: entry.memo || '',
      lines: entry.lines || [],
      totalDebits: entry.totalDebits || 0,
      totalCredits: entry.totalCredits || 0,
      financeEventType: entry.financeEventType || null,
      metadata: entry.metadata || {}
    };
  });
}

const FINANCE_DOCUMENT_MIME_EXTENSION_MAP = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif'
};

function sanitizeFinanceDocumentStem(value) {
  return String(value || 'finance-document')
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'finance-document';
}

function buildFinanceDocumentDownloadPath(documentId) {
  return `/api/bookkeeping/firestore/finance-documents/${documentId}/file`;
}

function parseFinanceDocumentIdFromSourceRef(sourceRef) {
  if (!sourceRef || !String(sourceRef).startsWith('finance-document:')) {
    return null;
  }

  return String(sourceRef).slice('finance-document:'.length) || null;
}

function getFinanceDocumentExtension(mimeType, originalFileName = '') {
  if (mimeType && FINANCE_DOCUMENT_MIME_EXTENSION_MAP[mimeType]) {
    return FINANCE_DOCUMENT_MIME_EXTENSION_MAP[mimeType];
  }

  const fileExtension = path.extname(String(originalFileName || '')).toLowerCase();
  return fileExtension || '.bin';
}

function getFinanceDocumentAbsolutePath(storedRelativePath) {
  return path.join(process.cwd(), 'server', ...String(storedRelativePath || '').split('/'));
}

async function persistLocalFinanceDocument({ userId, documentId, fileBase64, originalFileName = 'finance-document' }) {
  const decoded = decodeBase64Document(fileBase64);
  if (!decoded?.buffer) {
    const error = new Error('A valid base64-encoded finance document is required');
    error.statusCode = 400;
    throw error;
  }

  const extension = getFinanceDocumentExtension(decoded.mimeType, originalFileName);
  const fileStem = sanitizeFinanceDocumentStem(path.parse(originalFileName).name || 'finance-document');
  const storedFileName = `${documentId}-${fileStem}${extension}`;
  const storedRelativePath = path.join('uploads', 'bookkeeping-finance-documents', userId, storedFileName).split(path.sep).join('/');
  const absolutePath = getFinanceDocumentAbsolutePath(storedRelativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, decoded.buffer);

  return {
    mimeType: decoded.mimeType,
    originalFileName,
    storedFileName,
    storedRelativePath,
    downloadPath: buildFinanceDocumentDownloadPath(documentId)
  };
}

function matchesPropertyScope(entry, propertyId) {
  if (!propertyId) return true;
  return entry.propertyId === propertyId;
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeReceiptCategory(category) {
  return RECEIPT_CATEGORY_ALIASES[category] || category || 'Other Expenses';
}

function getCanonicalCategoryNameForAccountCode(accountCode, fallbackName = 'Other Expenses') {
  return SCHEDULE_E_CATEGORY_BY_ACCOUNT_CODE.get(String(accountCode || '')) || fallbackName;
}

function normalizeCanonicalTaxCategory(category, fallbackName = '') {
  const normalized = String(category || '').trim();
  if (!normalized) {
    return fallbackName;
  }

  const categoryAliases = {
    'Rental Income': 'Rent Income',
    'Other Income': 'Other Rental Income',
    'Repairs & Maintenance': 'Repairs',
    'Property Tax': 'Property Taxes',
    'Property Management': 'Management Fees',
    'Cleaning': 'Cleaning & Maintenance',
    'Depreciation Expense': 'Depreciation'
  };

  return categoryAliases[normalized] || normalized;
}

function deriveCanonicalTaxCategory(entry) {
  const lines = Array.isArray(entry?.lines) ? entry.lines : [];
  const primaryTaxLine = lines.find((line) => (
    ['REVENUE', 'EXPENSE'].includes(String(line.accountType || ''))
    && !CASH_EQUIVALENT_ACCOUNT_CODES.has(String(line.accountCode || ''))
    && (line.taxCategory || line.scheduleELine || line.accountCode)
  ));
  const fallbackTaxLine = lines.find((line) => line.taxCategory || line.scheduleELine || line.accountCode);
  const selectedLine = primaryTaxLine || fallbackTaxLine || null;

  if (selectedLine?.taxCategory) {
    return normalizeCanonicalTaxCategory(selectedLine.taxCategory, '');
  }

  if (Number.isInteger(selectedLine?.scheduleELine) && SCHEDULE_E_CATEGORY_BY_LINE.has(selectedLine.scheduleELine)) {
    return SCHEDULE_E_CATEGORY_BY_LINE.get(selectedLine.scheduleELine);
  }

  if (selectedLine?.accountCode) {
    return normalizeCanonicalTaxCategory(
      getCanonicalCategoryNameForAccountCode(selectedLine.accountCode, selectedLine.accountName || ''),
      '',
    );
  }

  return normalizeCanonicalTaxCategory(entry?.category || '', '');
}

function deriveCanonicalTaxPropertyId(entry) {
  if (entry?.propertyId) {
    return entry.propertyId;
  }

  const lines = Array.isArray(entry?.lines) ? entry.lines : [];
  const propertyIds = Array.from(new Set(lines.map((line) => line?.propertyId).filter(Boolean)));
  if (propertyIds.length === 1) {
    return propertyIds[0];
  }

  return propertyIds[0] || null;
}

function normalizeRuleMatchType(matchType) {
  const normalized = String(matchType || '').trim().toUpperCase();
  return ['PAYEE', 'DESCRIPTION', 'AMOUNT', 'CATEGORY'].includes(normalized) ? normalized : null;
}

function normalizeRecurringFrequency(frequency) {
  const normalized = String(frequency || '').trim().toLowerCase();
  return ['weekly', 'monthly', 'quarterly', 'annually'].includes(normalized) ? normalized : null;
}

function parseDateOnly(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  const [year, month, day] = text.split('-').map((part) => Number(part));
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateOnly(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function buildMonthlyRecurringDate(year, monthIndex, dayOfMonth) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(Math.max(1, Number(dayOfMonth || 1)), lastDay)));
}

function advanceRecurringDate(currentDate, frequency, dayOfMonth = 1) {
  const current = parseDateOnly(currentDate) || parseDateOnly(new Date().toISOString());
  if (!current) return null;

  if (frequency === 'weekly') {
    current.setUTCDate(current.getUTCDate() + 7);
    return formatDateOnly(current);
  }

  if (frequency === 'monthly') {
    return formatDateOnly(buildMonthlyRecurringDate(current.getUTCFullYear(), current.getUTCMonth() + 1, dayOfMonth));
  }

  if (frequency === 'quarterly') {
    return formatDateOnly(buildMonthlyRecurringDate(current.getUTCFullYear(), current.getUTCMonth() + 3, dayOfMonth));
  }

  if (frequency === 'annually') {
    return formatDateOnly(buildMonthlyRecurringDate(current.getUTCFullYear() + 1, current.getUTCMonth(), dayOfMonth));
  }

  return null;
}

function calculateNextRecurringDueDate(startDate, frequency, dayOfMonth = 1, referenceDate = null) {
  const normalizedFrequency = normalizeRecurringFrequency(frequency);
  const start = parseDateOnly(startDate);
  const reference = parseDateOnly(referenceDate || new Date().toISOString()) || new Date();

  if (!normalizedFrequency || !start) {
    return null;
  }

  let cursor = null;

  if (normalizedFrequency === 'weekly') {
    cursor = new Date(start);
  } else {
    cursor = buildMonthlyRecurringDate(start.getUTCFullYear(), start.getUTCMonth(), dayOfMonth);
    if (cursor < start) {
      const advanced = advanceRecurringDate(formatDateOnly(cursor), normalizedFrequency, dayOfMonth);
      cursor = parseDateOnly(advanced);
    }
  }

  while (cursor && cursor < reference) {
    const advanced = advanceRecurringDate(formatDateOnly(cursor), normalizedFrequency, dayOfMonth);
    cursor = parseDateOnly(advanced);
  }

  return cursor ? formatDateOnly(cursor) : null;
}

function transactionNeedsRuleReview(transaction) {
  const category = String(transaction?.category || 'Uncategorized');
  return !transaction?.scheduleELine
    || !transaction?.accountCode
    || category === 'Other Expenses'
    || category === 'Other Income'
    || category === 'Uncategorized';
}

function doesCategorizationRuleMatch(rule, transaction) {
  const matchType = normalizeRuleMatchType(rule?.matchType);
  const pattern = String(rule?.matchPattern || '').trim().toLowerCase();
  if (!matchType || !pattern) {
    return false;
  }

  if (rule?.propertyId && String(rule.propertyId) !== String(transaction?.propertyId || '')) {
    return false;
  }

  if (matchType === 'PAYEE') {
    return String(transaction?.payee || transaction?.vendor || '').toLowerCase().includes(pattern);
  }

  if (matchType === 'DESCRIPTION') {
    return String(transaction?.description || transaction?.memo || '').toLowerCase().includes(pattern);
  }

  if (matchType === 'CATEGORY') {
    return String(transaction?.category || '').toLowerCase().includes(pattern);
  }

  if (matchType === 'AMOUNT') {
    const amount = Math.abs(Number(transaction?.amount || 0));
    if (pattern.includes('-')) {
      const [min, max] = pattern.split('-').map((value) => Number(value));
      return Number.isFinite(min) && Number.isFinite(max) && amount >= min && amount <= max;
    }
    if (pattern.startsWith('>=')) {
      const min = Number(pattern.slice(2));
      return Number.isFinite(min) && amount >= min;
    }
    if (pattern.startsWith('<=')) {
      const max = Number(pattern.slice(2));
      return Number.isFinite(max) && amount <= max;
    }
  }

  return false;
}

function buildRuleCandidateTransaction(entry) {
  const categoryLine = (entry?.lines || []).find((line) => line.accountCode !== '1000') || null;
  const amount = Math.abs(Number(entry?.amount || entry?.originalAmount || entry?.totalDebits || entry?.totalCredits || 0));
  const category = entry?.category || categoryLine?.accountName || (entry?.isExpense ? 'Other Expenses' : 'Other Income');
  const scheduleELine = entry?.scheduleELine ?? categoryLine?.scheduleELine ?? null;

  return {
    id: entry?.id,
    date: entry?.date || entry?.entryDate || null,
    description: entry?.description || entry?.memo || '',
    memo: entry?.memo || '',
    payee: entry?.payee || entry?.vendor || '',
    vendor: entry?.vendor || entry?.payee || '',
    category,
    amount,
    propertyId: entry?.propertyId || null,
    accountCode: categoryLine?.accountCode || entry?.accountCode || null,
    scheduleELine,
    type: entry?.type || (entry?.isExpense ? 'expense' : 'income'),
    isExpense: entry?.isExpense,
  };
}

async function listCategorizationRuleCandidates(userId, { year = null, propertyId = null, limit = 250 } = {}) {
  const entries = await fetchAllEntries(userId, year);
  return entries
    .filter((entry) => !propertyId || String(entry?.propertyId || '') === String(propertyId))
    .filter((entry) => getSimpleReclassifiableLineIndex(entry) !== -1)
    .map(buildRuleCandidateTransaction)
    .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))
    .slice(0, Math.max(1, Number(limit) || 250));
}

function buildRecurringTemplateEntryPayload(template, accountRecord, offsetAccountRecord, dueDate) {
  const amount = roundCurrency(template.amount || 0);
  const accountCode = String(template.accountCode || accountRecord?.code || '');
  const category = getCanonicalCategoryNameForAccountCode(accountCode, accountRecord?.name || template.name || 'Other Expenses');
  const scheduleELine = SCHEDULE_E_LINE_BY_ACCOUNT_CODE.get(accountCode) || null;

  if (accountRecord?.type === 'REVENUE') {
    return {
      lines: [
        { accountCode: offsetAccountRecord.code, accountName: offsetAccountRecord.name, amount, dc: 'D', propertyId: template.propertyId || null },
        { accountCode: accountRecord.code, accountName: accountRecord.name, amount, dc: 'C', propertyId: template.propertyId || null, memo: template.memo || template.name },
      ],
      category,
      scheduleELine,
      type: 'income',
      isExpense: false,
      originalAmount: amount,
      description: template.memo || template.name,
      memo: `${template.name} - Auto-generated`,
      sourceRef: `recurring-template:${template.id}:${dueDate}`,
    };
  }

  return {
    lines: [
      { accountCode: accountRecord.code, accountName: accountRecord.name, amount, dc: 'D', propertyId: template.propertyId || null, memo: template.memo || template.name },
      { accountCode: offsetAccountRecord.code, accountName: offsetAccountRecord.name, amount, dc: 'C', propertyId: template.propertyId || null },
    ],
    category,
    scheduleELine,
    type: 'expense',
    isExpense: true,
    originalAmount: -amount,
    description: template.memo || template.name,
    memo: `${template.name} - Auto-generated`,
    sourceRef: `recurring-template:${template.id}:${dueDate}`,
  };
}

function getDefaultAccount(accountCode) {
  return getDefaultChartAccountByCode(accountCode);
}

function buildDefaultBookkeepingConfig(now, overrides = {}) {
  return {
    fiscalYearStart: 1,
    defaultCurrency: 'USD',
    closedPeriods: [],
    qboConnected: false,
    accountingMode: 'workpapers',
    domainVersion: ACCOUNTING_DOMAIN_VERSION,
    chartOfAccountsVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION,
    closePeriodModelVersion: ACCOUNTING_DOMAIN_VERSION,
    createdAt: now,
    initializedAt: now,
    updatedAt: now,
    ...overrides
  };
}

function buildAccountingPeriodClosedError(periodRecord, entryDate) {
  const periodKey = periodRecord?.periodKey || getAccountingPeriodKey(entryDate);
  const error = new Error(`${formatAccountingPeriodLabel(periodKey)} is closed. Reopen the period before posting or reclassifying entries.`);
  error.statusCode = 409;
  error.code = 'ACCOUNTING_PERIOD_CLOSED';
  error.details = {
    periodKey,
    status: periodRecord?.status || ACCOUNTING_CLOSE_PERIOD_STATUSES.CLOSED
  };
  return error;
}

async function assertAccountingPeriodOpen(userId, entryDate) {
  const periodKey = getAccountingPeriodKey(entryDate);
  if (!periodKey) {
    return;
  }

  const { firestoreClosePeriod, canonicalClosePeriod } = await loadStoredClosePeriod(userId, periodKey);
  const closePeriod = firestoreClosePeriod || canonicalClosePeriod;
  if (closePeriod?.status === ACCOUNTING_CLOSE_PERIOD_STATUSES.CLOSED) {
    throw buildAccountingPeriodClosedError(closePeriod, entryDate);
  }
}

function normalizeClosePeriodRecord(period = {}, fallbackId = null) {
  if (!period?.periodKey) {
    return null;
  }

  return {
    id: period.id || period.closePeriodId || fallbackId || period.periodKey,
    ...period,
    entityType: period.entityType || ACCOUNTING_ENTITY_TYPES.CLOSE_PERIOD,
    label: formatAccountingPeriodLabel(period.periodKey)
  };
}

function stripClosePeriodViewFields(period = {}) {
  const {
    id,
    label,
    closePeriodId,
    ...record
  } = period || {};

  return record;
}

function mergeClosePeriodRecordPair(canonicalPeriod = null, firestorePeriod = null) {
  const merged = {
    ...(canonicalPeriod || {}),
    ...(firestorePeriod || {})
  };

  return normalizeClosePeriodRecord(
    merged,
    firestorePeriod?.id || canonicalPeriod?.id || merged.periodKey || null
  );
}

function mergeClosePeriodLists(canonicalClosePeriods = [], firestoreClosePeriods = []) {
  const recordsByPeriodKey = new Map();

  for (const canonicalPeriod of canonicalClosePeriods || []) {
    if (!canonicalPeriod?.periodKey) {
      continue;
    }

    recordsByPeriodKey.set(canonicalPeriod.periodKey, {
      canonicalPeriod: normalizeClosePeriodRecord(canonicalPeriod)
    });
  }

  for (const firestorePeriod of firestoreClosePeriods || []) {
    if (!firestorePeriod?.periodKey) {
      continue;
    }

    recordsByPeriodKey.set(firestorePeriod.periodKey, {
      ...(recordsByPeriodKey.get(firestorePeriod.periodKey) || {}),
      firestorePeriod: normalizeClosePeriodRecord(firestorePeriod)
    });
  }

  return Array.from(recordsByPeriodKey.values())
    .map(({ canonicalPeriod = null, firestorePeriod = null }) => mergeClosePeriodRecordPair(canonicalPeriod, firestorePeriod))
    .filter(Boolean)
    .sort((left, right) => String(right.periodKey || '').localeCompare(String(left.periodKey || '')));
}

async function getCanonicalClosePeriodResult(userId, periodKey) {
  try {
    return await getClosePeriodFromAzure({ userId, periodKey });
  } catch (error) {
    console.error('[Bookkeeping] Canonical close period lookup error:', error);
    return {
      ok: false,
      status: 'failed',
      error: error.message,
      closePeriod: null
    };
  }
}

async function loadStoredClosePeriod(userId, periodKey) {
  const readyCanonicalResult = requireCanonicalLedgerResult(
    await getCanonicalClosePeriodResult(userId, periodKey),
    `close period ${periodKey}`,
  );
  const canonicalClosePeriod = normalizeClosePeriodRecord(readyCanonicalResult.closePeriod || null);

  return {
    firestoreClosePeriod: null,
    canonicalClosePeriod,
    canonicalStatus: readyCanonicalResult.status || 'ready',
    canonicalError: readyCanonicalResult.error || null,
    closePeriod: canonicalClosePeriod
  };
}

function resolveReceiptAccounting(entry = {}) {
  const normalizedCategory = normalizeReceiptCategory(entry.category);
  const categoryConfig = SCHEDULE_E_CATEGORIES[normalizedCategory] || SCHEDULE_E_CATEGORIES['Other Expenses'];
  const requestedAccountCode = entry.accountCode || entry.debitAccount || categoryConfig?.code || '5999';
  const resolvedAccount = getDefaultAccount(requestedAccountCode) || getDefaultAccount(categoryConfig?.code) || getDefaultAccount('5999');

  return {
    category: normalizedCategory,
    accountCode: resolvedAccount?.code || '5999',
    accountName: resolvedAccount?.name || normalizedCategory,
    scheduleELine: entry.scheduleELine || categoryConfig?.scheduleELine || 19
  };
}

function buildBookkeepingShadowUnsupportedResult(reason) {
  return {
    ok: false,
    status: 'unsupported',
    reason
  };
}

function normalizeBookkeepingShadowSource(source) {
  const normalized = String(source || 'manual')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'manual';
}

function buildBookkeepingShadowIdentity(sourceType, journalEntryId, entry = {}) {
  const sourceRef = typeof entry.sourceRef === 'string' && entry.sourceRef.trim()
    ? entry.sourceRef.trim()
    : null;
  const canUseExternalSourceRef = Boolean(sourceRef) && ['qbo_import', 'sample_feed', 'plaid', 'stripe', 'bank'].includes(sourceType);

  if (canUseExternalSourceRef) {
    return {
      sourceObjectId: `${sourceType}:${sourceRef}`,
      idempotencyKey: `bookkeeping:${sourceType}:${sourceRef}`,
      canonicalSourceRef: sourceRef
    };
  }

  return {
    sourceObjectId: journalEntryId,
    idempotencyKey: `bookkeeping:journal-entry:${journalEntryId}`,
    canonicalSourceRef: `firestore_journal_entry:${journalEntryId}`
  };
}

function createBookkeepingShadowBatchSummary(postingMode = 'live') {
  return {
    postingMode,
    evaluated: 0,
    posted: 0,
    duplicates: 0,
    notConfigured: 0,
    unsupported: 0,
    failed: 0,
    issues: []
  };
}

function recordBookkeepingShadowBatchResult(summary, sourceRef, result) {
  if (!summary) {
    return;
  }

  summary.evaluated += 1;

  switch (result?.status) {
    case 'posted':
      summary.posted += 1;
      break;
    case 'duplicate':
      summary.duplicates += 1;
      break;
    case 'not_configured':
      summary.notConfigured += 1;
      break;
    case 'unsupported':
      summary.unsupported += 1;
      break;
    case 'failed':
      summary.failed += 1;
      break;
    default:
      break;
  }

  if (['unsupported', 'failed'].includes(result?.status) && summary.issues.length < 25) {
    summary.issues.push({
      sourceRef,
      status: result.status,
      reason: result.reason || result.error || 'Ledger posting failed.'
    });
  }
}

export function buildBookkeepingShadowCandidate(userId, journalEntryId, entry = {}) {
  const categoryLineIndex = getSimpleReclassifiableLineIndex(entry);
  if (categoryLineIndex === -1) {
    return buildBookkeepingShadowUnsupportedResult('Only simple two-line cash journal entries are staged into the canonical shadow ledger right now.');
  }

  const categoryLine = entry.lines[categoryLineIndex];
  const cashLine = entry.lines.find((_, index) => index !== categoryLineIndex);
  const entryType = inferSimpleEntryCategoryType(entry, categoryLine);
  const amount = roundCurrency(categoryLine?.amount || cashLine?.amount || entry.amount || 0);
  if (!amount) {
    return buildBookkeepingShadowUnsupportedResult('Zero-amount manual journal entries are not staged into the canonical shadow ledger.');
  }

  if (!getDefaultAccount(categoryLine?.accountCode) || !getDefaultAccount(cashLine?.accountCode)) {
    return buildBookkeepingShadowUnsupportedResult('This journal entry uses an account code that is outside the canonical chart of accounts shadow path.');
  }

  const propertyId = entry.propertyId || categoryLine?.propertyId || cashLine?.propertyId || null;
  const counterpartyName = entry.vendor || entry.counterpartyName || entry.tenantName || null;
  const sourceType = normalizeBookkeepingShadowSource(entry.source);
  const shadowIdentity = buildBookkeepingShadowIdentity(sourceType, journalEntryId, entry);
  const sharedMetadata = {
    shadowMode: true,
    legacySource: 'bookkeeping-firestore',
    firestoreJournalEntryId: journalEntryId,
    firestoreEntrySource: entry.source || 'MANUAL',
    firestoreSourceRef: entry.sourceRef || null,
    category: entry.category || categoryLine?.accountName || null,
    scheduleELine: entry.scheduleELine || null,
    hasReceipt: Boolean(entry.hasReceipt)
  };
  const sourceEvent = {
    sourceSystem: 'HOUSEYIELD',
    sourceObjectId: shadowIdentity.sourceObjectId,
    sourceEventType: `bookkeeping.${sourceType}.journal_entry`,
    occurredAt: entry.createdAt || new Date().toISOString(),
    userId,
    propertyId,
    payload: {
      journalEntryId,
      source: entry.source || 'MANUAL',
      sourceRef: entry.sourceRef || null,
      type: entry.type || null,
      memo: entry.memo || '',
      amount,
      accountCode: categoryLine?.accountCode || null,
      propertyId,
      hasReceipt: Boolean(entry.hasReceipt)
    }
  };

  if (entryType === 'expense' && categoryLine?.dc === 'D' && cashLine?.dc === 'C') {
    return {
      ok: true,
      sourceEvent,
      financeEventInput: {
        idempotencyKey: shadowIdentity.idempotencyKey,
        financeEventType: 'expense_paid',
        effectiveDate: entry.entryDate,
        userId,
        propertyId,
        amount,
        memo: entry.memo || categoryLine?.memo || 'Manual expense entry',
        sourceSystem: 'HOUSEYIELD',
        sourceRef: shadowIdentity.canonicalSourceRef,
        counterpartyName,
        cashAccountCode: cashLine.accountCode,
        expenseAccountCode: categoryLine.accountCode,
        metadata: sharedMetadata
      }
    };
  }

  if (entryType === 'income' && categoryLine?.dc === 'C' && cashLine?.dc === 'D') {
    return {
      ok: true,
      sourceEvent,
      financeEventInput: {
        idempotencyKey: shadowIdentity.idempotencyKey,
        financeEventType: 'income_received',
        effectiveDate: entry.entryDate,
        userId,
        propertyId,
        amount,
        memo: entry.memo || categoryLine?.memo || 'Manual income entry',
        sourceSystem: 'HOUSEYIELD',
        sourceRef: shadowIdentity.canonicalSourceRef,
        counterpartyName,
        cashAccountCode: cashLine.accountCode,
        incomeAccountCode: categoryLine.accountCode,
        metadata: sharedMetadata
      }
    };
  }

  return buildBookkeepingShadowUnsupportedResult('This manual journal pattern does not map cleanly to a canonical cash income or cash expense event yet.');
}

async function postBookkeepingJournalEntryToAzure(userId, journalEntryId, entry = {}, postingMode = 'live') {
  const effectivePostingMode = postingMode === 'shadow' ? 'shadow' : 'live';
  const candidate = buildBookkeepingShadowCandidate(userId, journalEntryId, entry);
  if (candidate.ok) {
    const rulesVersion = entry.rulesVersion || candidate.financeEventInput.rulesVersion || candidate.financeEventInput.metadata?.rulesVersion || null;
    const financeEventInput = {
      ...candidate.financeEventInput,
      ...(rulesVersion ? { rulesVersion } : {}),
      metadata: {
        ...(candidate.financeEventInput.metadata || {}),
        ...(rulesVersion ? { rulesVersion } : {})
      }
    };
    const journalDraft = buildJournalDraftFromFinanceEvent(financeEventInput);
    const postJournal = effectivePostingMode === 'shadow' ? postJournalDraftShadowToAzure : postJournalDraftToAzure;
    return postJournal({
      sourceEvent: candidate.sourceEvent,
      financeEventInput: {
        ...financeEventInput,
        metadata: {
          ...(financeEventInput.metadata || {}),
          shadowMode: effectivePostingMode === 'shadow',
          postingMode: effectivePostingMode
        }
      },
      journalDraft,
      postedBy: entry.postedBy || (effectivePostingMode === 'shadow' ? 'bookkeeping-shadow' : 'bookkeeping-canonical'),
      idempotencyScope: 'bookkeeping-shadow'
    });
  }

  return postCanonicalManualJournalEntry({
    userId,
    journalEntryId,
    entry,
    postedBy: entry.postedBy || (effectivePostingMode === 'shadow' ? 'bookkeeping-shadow' : 'bookkeeping-canonical'),
    postingMode: effectivePostingMode
  });
}

export function buildBookkeepingReclassificationShadowCandidate(userId, entryId, previousEntry = {}, nextEntry = {}) {
  const previousLineIndex = getSimpleReclassifiableLineIndex(previousEntry);
  const nextLineIndex = getSimpleReclassifiableLineIndex(nextEntry);
  if (previousLineIndex === -1 || nextLineIndex === -1) {
    return buildBookkeepingShadowUnsupportedResult('Only simple two-line cash journal entries can be mirrored into the canonical reclassification shadow path right now.');
  }

  const previousLine = previousEntry.lines[previousLineIndex];
  const nextLine = nextEntry.lines[nextLineIndex];
  const propertyId = nextEntry.propertyId || nextLine?.propertyId || previousLine?.propertyId || null;
  const occurredAt = nextEntry.reclassifiedAt || new Date().toISOString();
  const effectiveDate = nextEntry.entryDate || nextEntry.date;
  const amount = roundCurrency(previousLine?.amount || nextLine?.amount || nextEntry.originalAmount || 0);
  if (!effectiveDate || !amount) {
    return buildBookkeepingShadowUnsupportedResult('Reclassification shadow posting requires a valid effective date and amount.');
  }

  const sourceEvent = {
    sourceSystem: 'HOUSEYIELD',
    sourceObjectId: `${entryId}:reclassification:${occurredAt}`,
    sourceEventType: 'bookkeeping.reclassification.journal_entry',
    occurredAt,
    userId,
    propertyId,
    payload: {
      journalEntryId: entryId,
      amount,
      fromAccountCode: previousLine?.accountCode || null,
      toAccountCode: nextLine?.accountCode || null,
      fromCategory: previousEntry.category || previousLine?.accountName || null,
      toCategory: nextEntry.category || nextLine?.accountName || null,
      fromScheduleELine: previousEntry.scheduleELine || null,
      toScheduleELine: nextEntry.scheduleELine || null
    }
  };

  if (previousLine?.accountCode === nextLine?.accountCode) {
    return {
      ok: false,
      status: 'pending_review',
      reason: 'Metadata-only reclassification changed reporting labels without changing ledger accounts, so it is staged for canonical review instead of silently mutating the ledger.',
      sourceEvent,
      pendingMatchInput: {
        idempotencyKey: `bookkeeping:reclassification-review:${entryId}:${occurredAt}`,
        effectiveDate,
        userId,
        propertyId,
        amount,
        sourceSystem: 'HOUSEYIELD',
        sourceRef: `firestore_journal_entry:${entryId}:reclassification:${occurredAt}`,
        reconciliationScope: 'bookkeeping_reclassification_review',
        notes: 'Metadata-only reclassification requires reviewer approval before canonical output changes.',
        metadata: {
          shadowMode: true,
          legacySource: 'bookkeeping-firestore',
          journalEntryId: entryId,
          fromAccountCode: previousLine?.accountCode || null,
          toAccountCode: nextLine?.accountCode || null,
          fromScheduleELine: previousEntry.scheduleELine || null,
          toScheduleELine: nextEntry.scheduleELine || null,
          reclassifiedBy: nextEntry.reclassifiedBy || null
        }
      },
      suggestedMatch: {
        reviewType: 'metadata_only_reclassification',
        journalEntryId: entryId,
        fromScheduleELine: previousEntry.scheduleELine || null,
        toScheduleELine: nextEntry.scheduleELine || null
      }
    };
  }

  if (!getDefaultAccount(previousLine?.accountCode) || !getDefaultAccount(nextLine?.accountCode)) {
    return buildBookkeepingShadowUnsupportedResult('Reclassification uses an account code outside the canonical chart of accounts shadow path.');
  }

  const categoryType = inferSimpleEntryCategoryType(previousEntry, previousLine);
  let debitAccountCode = null;
  let creditAccountCode = null;

  if (categoryType === 'expense') {
    debitAccountCode = nextLine.accountCode;
    creditAccountCode = previousLine.accountCode;
  } else if (categoryType === 'income') {
    debitAccountCode = previousLine.accountCode;
    creditAccountCode = nextLine.accountCode;
  } else {
    return buildBookkeepingShadowUnsupportedResult('Only simple expense and income reclassifications are mirrored into the canonical shadow ledger right now.');
  }

  return {
    ok: true,
    sourceEvent,
    financeEventInput: {
      idempotencyKey: `bookkeeping:reclassification:${entryId}:${occurredAt}`,
      financeEventType: 'account_reclassified',
      effectiveDate,
      userId,
      propertyId,
      amount,
      memo: `Reclassification: ${previousEntry.category || previousLine.accountName || previousLine.accountCode} -> ${nextEntry.category || nextLine.accountName || nextLine.accountCode}`,
      sourceSystem: 'HOUSEYIELD',
      sourceRef: `firestore_journal_entry:${entryId}:reclassification:${occurredAt}`,
      debitAccountCode,
      creditAccountCode,
      metadata: {
        shadowMode: true,
        legacySource: 'bookkeeping-firestore',
        journalEntryId: entryId,
        fromAccountCode: previousLine.accountCode,
        toAccountCode: nextLine.accountCode,
        fromScheduleELine: previousEntry.scheduleELine || null,
        toScheduleELine: nextEntry.scheduleELine || null,
        reclassifiedBy: nextEntry.reclassifiedBy || null
      }
    }
  };
}

async function postBookkeepingReclassificationToAzure(userId, entryId, previousEntry = {}, nextEntry = {}, reclassifiedBy = 'system', postingMode = 'live') {
  const candidate = buildBookkeepingReclassificationShadowCandidate(userId, entryId, previousEntry, nextEntry);
  const effectivePostingMode = postingMode === 'shadow' ? 'shadow' : 'live';
  if (candidate.status === 'pending_review') {
    const stagedResult = await stagePendingMatchToAzure({
      sourceEvent: candidate.sourceEvent,
      pendingMatchInput: {
        ...candidate.pendingMatchInput,
        metadata: {
          ...(candidate.pendingMatchInput?.metadata || {}),
          shadowMode: effectivePostingMode === 'shadow',
          postingMode: effectivePostingMode
        }
      },
      suggestedMatch: candidate.suggestedMatch,
      reason: candidate.reason,
      postedBy: reclassifiedBy,
      idempotencyScope: 'bookkeeping-reclassification-review',
      matchStatus: 'exception_requires_review'
    });
    return {
      ...stagedResult,
      reviewStatus: 'pending_review',
      reason: candidate.reason
    };
  }

  if (!candidate.ok) {
    return candidate;
  }

  const rulesVersion = nextEntry.rulesVersion || previousEntry.rulesVersion || candidate.financeEventInput.rulesVersion || candidate.financeEventInput.metadata?.rulesVersion || null;
  const financeEventInput = {
    ...candidate.financeEventInput,
    ...(rulesVersion ? { rulesVersion } : {}),
    metadata: {
      ...(candidate.financeEventInput.metadata || {}),
      ...(rulesVersion ? { rulesVersion } : {})
    }
  };
  const journalDraft = buildJournalDraftFromFinanceEvent(financeEventInput);
  const postJournal = effectivePostingMode === 'shadow' ? postJournalDraftShadowToAzure : postJournalDraftToAzure;
  return postJournal({
    sourceEvent: candidate.sourceEvent,
    financeEventInput: {
      ...financeEventInput,
      metadata: {
        ...(financeEventInput.metadata || {}),
        shadowMode: effectivePostingMode === 'shadow',
        postingMode: effectivePostingMode
      }
    },
    journalDraft,
    postedBy: reclassifiedBy,
    idempotencyScope: 'bookkeeping-reclassification-shadow'
  });
}

function calculateLineBalanceChange(accountType, line) {
  if (['LIABILITY', 'EQUITY', 'REVENUE'].includes(accountType)) {
    return line.dc === 'C' ? line.amount : -line.amount;
  }

  return line.dc === 'D' ? line.amount : -line.amount;
}

function getSimpleReclassifiableLineIndex(entry) {
  if (!Array.isArray(entry?.lines) || entry.lines.length !== 2) {
    return -1;
  }

  const cashLineCount = entry.lines.filter((line) => line.accountCode === '1000').length;
  if (cashLineCount !== 1) {
    return -1;
  }

  return entry.lines.findIndex((line) => line.accountCode !== '1000');
}

function inferSimpleEntryCategoryType(entry, categoryLine) {
  if (typeof entry?.isExpense === 'boolean') {
    return entry.isExpense ? 'expense' : 'income';
  }

  return categoryLine?.dc === 'D' ? 'expense' : 'income';
}

function summarizeReclassificationMutation(entry, categoryLine, target, update = {}) {
  const currentCategory = entry.category || categoryLine.accountName || categoryLine.accountCode || 'Other Expenses';
  const currentScheduleELine = entry.scheduleELine ?? null;
  const accountChanged = currentLineAccountCode(categoryLine) !== target.accountCode;
  const categoryChanged = target.category !== currentCategory;
  const scheduleELineChanged = (target.scheduleELine ?? null) !== currentScheduleELine;
  const isExpenseChanged = Object.prototype.hasOwnProperty.call(update, 'isExpense')
    ? update.isExpense !== entry.isExpense
    : false;
  const classificationChanged = categoryChanged || scheduleELineChanged || isExpenseChanged;

  return {
    accountChanged,
    categoryChanged,
    scheduleELineChanged,
    isExpenseChanged,
    classificationChanged,
    isNoop: !accountChanged && !classificationChanged,
    currentCategory,
    currentScheduleELine
  };
}

function currentLineAccountCode(categoryLine) {
  return categoryLine?.accountCode || null;
}

function resolveReclassificationTarget(entry, categoryLine, update = {}) {
  const requestedCategory = typeof update.category === 'string' && update.category.trim()
    ? normalizeReceiptCategory(update.category.trim())
    : null;
  const categoryConfig = requestedCategory ? (SCHEDULE_E_CATEGORIES[requestedCategory] || null) : null;
  const targetAccountCode = update.accountCode || categoryConfig?.code || categoryLine.accountCode;

  if (!targetAccountCode) {
    const error = new Error('Reclassification requires a valid account code');
    error.statusCode = 400;
    throw error;
  }

  return {
    category: requestedCategory || entry.category || categoryLine.accountName || 'Other Expenses',
    accountCode: targetAccountCode,
    scheduleELine: update.scheduleELine ?? categoryConfig?.scheduleELine ?? entry.scheduleELine ?? null,
    categoryType: categoryConfig?.type || null
  };
}

async function reclassifySimpleJournalEntry(userId, entryId, update, reclassifiedBy = 'system') {
  const canonicalEntryResult = await getLedgerEntryByIdFromAzure({ userId, journalEntryId: entryId }).catch((error) => {
    console.error('[Bookkeeping] Canonical journal entry lookup error:', error);
    return { ok: false, status: 'failed', error: error.message, entry: null };
  });

  if (shouldUseCanonicalLedger(canonicalEntryResult) && canonicalEntryResult.entry) {
    const now = new Date().toISOString();
    const entry = mapCanonicalEntryForReclassification(canonicalEntryResult.entry);
    await assertAccountingPeriodOpen(userId, entry.entryDate || entry.date);

    const categoryLineIndex = getSimpleReclassifiableLineIndex(entry);
    if (categoryLineIndex === -1) {
      const error = new Error('Only simple two-line cash journal entries can be reclassified automatically');
      error.statusCode = 409;
      throw error;
    }

    const currentLine = entry.lines[categoryLineIndex];
    const target = resolveReclassificationTarget(entry, currentLine, update);
    const currentCategoryType = inferSimpleEntryCategoryType(entry, currentLine);
    const changeSummary = summarizeReclassificationMutation(entry, currentLine, target, update);

    if (target.categoryType && ['expense', 'income'].includes(target.categoryType) && target.categoryType !== currentCategoryType) {
      const error = new Error(`Cannot reclassify a ${currentCategoryType} entry as ${target.categoryType}`);
      error.statusCode = 400;
      throw error;
    }

    if (!changeSummary.accountChanged && changeSummary.classificationChanged) {
      const error = new Error('Metadata-only reclassification is no longer allowed. Change the ledger account or route the adjustment through canonical review so reporting labels cannot drift from the ledger.');
      error.statusCode = 409;
      throw error;
    }

    if (changeSummary.isNoop) {
      return {
        id: entryId,
        previousEntry: entry,
        updatedEntry: entry,
        updates: {
          category: changeSummary.currentCategory,
          accountCode: currentLine.accountCode,
          scheduleELine: changeSummary.currentScheduleELine,
          updatedAt: entry.updatedAt || null,
          reclassifiedAt: entry.reclassifiedAt || null,
          reclassifiedBy: entry.reclassifiedBy || null
        },
        noop: true,
        shadowLedger: {
          ok: true,
          status: 'noop'
        }
      };
    }

    const oldAccount = await getBookkeepingAccountRecord(userId, currentLine.accountCode);
    const newAccount = await getBookkeepingAccountRecord(userId, target.accountCode);
    if (!oldAccount) {
      const error = new Error(`Account not found: ${currentLine.accountCode}`);
      error.statusCode = 400;
      throw error;
    }
    if (!newAccount) {
      const error = new Error(`Account not found: ${target.accountCode}`);
      error.statusCode = 400;
      throw error;
    }

    const updatedLine = {
      ...currentLine,
      accountCode: target.accountCode,
      accountName: newAccount.name || currentLine.accountName
    };
    const updatedLines = entry.lines.map((line, index) => index === categoryLineIndex ? updatedLine : line);
    const updatedEntry = {
      ...entry,
      lines: updatedLines,
      category: target.category,
      accountCode: target.accountCode,
      scheduleELine: target.scheduleELine,
      updatedAt: now,
      reclassifiedAt: now,
      reclassifiedBy,
      isExpense: typeof update.isExpense === 'boolean' ? update.isExpense : entry.isExpense,
      metadata: {
        ...(canonicalEntryResult.entry.metadata || {}),
        reclassifiedAt: now,
        reclassifiedBy
      }
    };

    let shadowLedger = null;
    try {
      shadowLedger = await postBookkeepingReclassificationToAzure(
        userId,
        entryId,
        entry,
        updatedEntry,
        reclassifiedBy
      );
    } catch (error) {
      console.error('[Bookkeeping] Reclassification Azure post error:', error);
      shadowLedger = {
        ok: false,
        status: 'failed',
        error: error.message
      };
    }

    return {
      id: entryId,
      previousEntry: entry,
      updatedEntry,
      updates: {
        category: target.category,
        accountCode: target.accountCode,
        scheduleELine: target.scheduleELine,
        updatedAt: now,
        reclassifiedAt: now,
        reclassifiedBy
      },
      shadowLedger
    };
  }

  const db = getFirestore();
  const entryRef = getJournalEntriesRef(userId).doc(entryId);
  const accountsRef = getAccountsRef(userId);
  const now = new Date().toISOString();
  const entrySnap = await entryRef.get();
  if (!entrySnap.exists) {
    const error = new Error('Journal entry not found');
    error.statusCode = 404;
    throw error;
  }

  await assertAccountingPeriodOpen(userId, entrySnap.data()?.entryDate || entrySnap.data()?.date);

  const result = await db.runTransaction(async (transaction) => {
    const entrySnap = await transaction.get(entryRef);
    if (!entrySnap.exists) {
      const error = new Error('Journal entry not found');
      error.statusCode = 404;
      throw error;
    }

    const entry = entrySnap.data();
    const periodKey = getAccountingPeriodKey(entry.entryDate || entry.date);
    if (periodKey) {
      const closePeriodRef = getClosePeriodsRef(userId).doc(periodKey);
      const closePeriodSnap = await transaction.get(closePeriodRef);
      if (closePeriodSnap.exists && closePeriodSnap.data()?.status === ACCOUNTING_CLOSE_PERIOD_STATUSES.CLOSED) {
        throw buildAccountingPeriodClosedError(closePeriodSnap.data(), entry.entryDate || entry.date);
      }
    }

    const categoryLineIndex = getSimpleReclassifiableLineIndex(entry);
    if (categoryLineIndex === -1) {
      const error = new Error('Only simple two-line cash journal entries can be reclassified automatically');
      error.statusCode = 409;
      throw error;
    }

    const currentLine = entry.lines[categoryLineIndex];
    const target = resolveReclassificationTarget(entry, currentLine, update);
    const currentCategoryType = inferSimpleEntryCategoryType(entry, currentLine);
    const changeSummary = summarizeReclassificationMutation(entry, currentLine, target, update);

    if (target.categoryType && ['expense', 'income'].includes(target.categoryType) && target.categoryType !== currentCategoryType) {
      const error = new Error(`Cannot reclassify a ${currentCategoryType} entry as ${target.categoryType}`);
      error.statusCode = 400;
      throw error;
    }

    if (!changeSummary.accountChanged && changeSummary.classificationChanged) {
      const error = new Error('Metadata-only reclassification is no longer allowed. Change the ledger account or route the adjustment through canonical review so reporting labels cannot drift from the ledger.');
      error.statusCode = 409;
      throw error;
    }

    if (changeSummary.isNoop) {
      return {
        id: entryId,
        previousEntry: entry,
        updatedEntry: entry,
        updates: {
          category: changeSummary.currentCategory,
          accountCode: currentLine.accountCode,
          scheduleELine: changeSummary.currentScheduleELine,
          updatedAt: entry.updatedAt || null,
          reclassifiedAt: entry.reclassifiedAt || null,
          reclassifiedBy: entry.reclassifiedBy || null
        },
        noop: true
      };
    }

    const oldAccountRef = accountsRef.doc(currentLine.accountCode);
    const newAccountRef = accountsRef.doc(target.accountCode);
    const accountSnaps = currentLine.accountCode === target.accountCode
      ? [await transaction.get(oldAccountRef)]
      : [await transaction.get(oldAccountRef), await transaction.get(newAccountRef)];

    const oldAccountSnap = accountSnaps[0];
    const newAccountSnap = currentLine.accountCode === target.accountCode ? accountSnaps[0] : accountSnaps[1];

    if (!oldAccountSnap.exists) {
      const error = new Error(`Account not found: ${currentLine.accountCode}`);
      error.statusCode = 400;
      throw error;
    }

    if (!newAccountSnap.exists) {
      const error = new Error(`Account not found: ${target.accountCode}`);
      error.statusCode = 400;
      throw error;
    }

    const oldAccount = oldAccountSnap.data();
    const newAccount = newAccountSnap.data();
    const updatedLine = {
      ...currentLine,
      accountCode: target.accountCode,
      accountName: newAccount.name || currentLine.accountName
    };
    const updatedLines = entry.lines.map((line, index) => index === categoryLineIndex ? updatedLine : line);
    const updates = {
      lines: updatedLines,
      category: target.category,
      accountCode: target.accountCode,
      scheduleELine: target.scheduleELine,
      updatedAt: now,
      reclassifiedAt: now,
      reclassifiedBy,
      reclassificationHistory: FieldValue.arrayUnion({
        at: now,
        by: reclassifiedBy,
        fromAccountCode: currentLine.accountCode,
        toAccountCode: target.accountCode,
        fromCategory: entry.category || currentLine.accountName || null,
        toCategory: target.category,
        fromScheduleELine: entry.scheduleELine || null,
        toScheduleELine: target.scheduleELine ?? null
      })
    };

    if (typeof update.isExpense === 'boolean') {
      updates.isExpense = update.isExpense;
    }

    transaction.update(entryRef, updates);

    if (currentLine.accountCode !== target.accountCode) {
      const oldBalanceChange = calculateLineBalanceChange(oldAccount.type, currentLine);
      const newBalanceChange = calculateLineBalanceChange(newAccount.type, updatedLine);

      transaction.update(oldAccountRef, {
        balance: FieldValue.increment(-oldBalanceChange),
        updatedAt: now
      });
      transaction.update(newAccountRef, {
        balance: FieldValue.increment(newBalanceChange),
        updatedAt: now
      });
    } else {
      transaction.update(newAccountRef, {
        updatedAt: now
      });
    }

    const updatedEntry = {
      ...entry,
      ...updates,
      lines: updatedLines,
      isExpense: typeof update.isExpense === 'boolean' ? update.isExpense : entry.isExpense
    };

    return {
      id: entryId,
      previousEntry: entry,
      updatedEntry,
      updates: {
        category: target.category,
        accountCode: target.accountCode,
        scheduleELine: target.scheduleELine,
        updatedAt: now,
        reclassifiedAt: now,
        reclassifiedBy
      }
    };
  });

  let shadowLedger = null;
  if (result.noop) {
    return {
      ...result,
      shadowLedger: {
        ok: true,
        status: 'noop'
      }
    };
  }

  try {
    shadowLedger = await postBookkeepingReclassificationToAzure(
      userId,
      entryId,
      result.previousEntry,
      result.updatedEntry,
      reclassifiedBy
    );
  } catch (error) {
    console.error('[Bookkeeping] Reclassification Azure post error:', error);
    shadowLedger = {
      ok: false,
      status: 'failed',
      error: error.message
    };
  }

  return {
    id: result.id,
    updates: result.updates,
    shadowLedger
  };
}

function decodeBase64Document(imageBase64) {
  if (!imageBase64) {
    return null;
  }

  const dataUrlMatch = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      buffer: Buffer.from(dataUrlMatch[2], 'base64')
    };
  }

  return {
    mimeType: 'image/jpeg',
    buffer: Buffer.from(imageBase64, 'base64')
  };
}

function stripMarkdownCodeFences(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseJsonResponse(text) {
  const cleaned = stripMarkdownCodeFences(text);
  if (!cleaned) {
    return null;
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

function normalizeOptionalString(value, maxLength = 160) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeStateCode(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

function normalizeMoneyValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? roundCurrency(value) : null;
  }

  const cleaned = String(value).replace(/[^0-9.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') {
    return null;
  }

  const numericValue = Number(cleaned);
  return Number.isFinite(numericValue) ? roundCurrency(numericValue) : null;
}

function normalizeTaxYear(value) {
  const numericValue = Number(String(value || '').replace(/[^0-9]/g, '').slice(0, 4));
  if (!Number.isInteger(numericValue) || numericValue < 2000 || numericValue > 2100) {
    return null;
  }
  return numericValue;
}

function normalizeBooleanOrNull(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(normalized)) return true;
    if (['false', 'no', 'n'].includes(normalized)) return false;
  }
  return null;
}

function normalizeStringArray(values, maxItems = 8, maxLength = 220) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeOptionalString(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}


async function buildGeminiInlineDocumentPart({ fileBase64, fileUrl }) {
  if (fileBase64) {
    const decoded = decodeBase64Document(fileBase64);
    if (decoded?.buffer?.length) {
      return {
        inlineData: {
          mimeType: decoded.mimeType || 'application/octet-stream',
          data: decoded.buffer.toString('base64')
        }
      };
    }
  }

  if (fileUrl) {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Could not fetch uploaded tax document (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      inlineData: {
        mimeType: response.headers.get('content-type') || 'application/octet-stream',
        data: Buffer.from(arrayBuffer).toString('base64')
      }
    };
  }

  return null;
}

function normalizeGeminiTaxExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const rawStateEntries = Array.isArray(parsed.stateEntries) ? parsed.stateEntries : [];
  const stateEntries = rawStateEntries
    .map((entry) => ({
      state: normalizeStateCode(entry?.state),
      stateId: normalizeOptionalString(entry?.stateId, 32),
      wages: normalizeMoneyValue(entry?.wages),
      withholding: normalizeMoneyValue(entry?.withholding)
    }))
    .filter((entry) => entry.state || entry.stateId || entry.wages !== null || entry.withholding !== null)
    .slice(0, 4);

  const box12Items = Array.isArray(parsed.box12Items)
    ? parsed.box12Items
      .map((entry) => ({
        code: normalizeOptionalString(entry?.code, 8),
        value: normalizeMoneyValue(entry?.value)
      }))
      .filter((entry) => entry.code || entry.value !== null)
      .slice(0, 8)
    : [];

  const box14Items = Array.isArray(parsed.box14Items)
    ? parsed.box14Items
      .map((entry) => ({
        label: normalizeOptionalString(entry?.label, 48),
        value: normalizeMoneyValue(entry?.value)
      }))
      .filter((entry) => entry.label || entry.value !== null)
      .slice(0, 8)
    : [];

  const documentSubtype = ['w2', '1098', 'pay_stub', 'other', 'unknown'].includes(String(parsed.documentSubtype || '').toLowerCase())
    ? String(parsed.documentSubtype || '').toLowerCase()
    : 'unknown';
  const extractionStatus = ['parsed', 'partial', 'not_applicable'].includes(String(parsed.extractionStatus || '').toLowerCase())
    ? String(parsed.extractionStatus || '').toLowerCase()
    : (documentSubtype === 'w2' ? 'partial' : 'not_applicable');
  const confidence = ['high', 'medium', 'low'].includes(String(parsed.confidence || '').toLowerCase())
    ? String(parsed.confidence || '').toLowerCase()
    : 'low';

  return {
    documentSubtype,
    extractionStatus,
    confidence,
    employerOrPayorName: normalizeOptionalString(parsed.employerOrPayorName, 160),
    employeeName: normalizeOptionalString(parsed.employeeName, 160),
    taxYear: normalizeTaxYear(parsed.taxYear),
    taxPeriodLabel: normalizeOptionalString(parsed.taxPeriodLabel, 80),
    wages: normalizeMoneyValue(parsed.wages),
    federalWithholding: normalizeMoneyValue(parsed.federalWithholding),
    socialSecurityWages: normalizeMoneyValue(parsed.socialSecurityWages),
    socialSecurityTax: normalizeMoneyValue(parsed.socialSecurityTax),
    medicareWages: normalizeMoneyValue(parsed.medicareWages),
    medicareTax: normalizeMoneyValue(parsed.medicareTax),
    tips: normalizeMoneyValue(parsed.tips),
    dependentCareBenefits: normalizeMoneyValue(parsed.dependentCareBenefits),
    retirementPlan: normalizeBooleanOrNull(parsed.retirementPlan),
    stateEntries,
    box12Items,
    box14Items,
    reviewNotes: normalizeStringArray(parsed.reviewNotes, 10),
    sourceEvidence: normalizeStringArray(parsed.sourceEvidence, 8)
  };
}

function buildPersonalTaxAliases(extraction) {
  if (!extraction || extraction.documentSubtype !== 'w2') {
    return {};
  }

  const firstStateEntry = extraction.stateEntries[0] || null;
  return {
    employerName: extraction.employerOrPayorName,
    employerOrPayorName: extraction.employerOrPayorName,
    employeeName: extraction.employeeName,
    taxYear: extraction.taxYear,
    wages: extraction.wages,
    box1: extraction.wages,
    box1Wages: extraction.wages,
    federalWages: extraction.wages,
    federalWithholding: extraction.federalWithholding,
    box2: extraction.federalWithholding,
    box2FederalIncomeTaxWithheld: extraction.federalWithholding,
    socialSecurityWages: extraction.socialSecurityWages,
    box3: extraction.socialSecurityWages,
    socialSecurityTax: extraction.socialSecurityTax,
    box4: extraction.socialSecurityTax,
    medicareWages: extraction.medicareWages,
    box5: extraction.medicareWages,
    medicareTax: extraction.medicareTax,
    box6: extraction.medicareTax,
    tips: extraction.tips,
    box7: extraction.tips,
    dependentCareBenefits: extraction.dependentCareBenefits,
    box10: extraction.dependentCareBenefits,
    stateEntries: extraction.stateEntries,
    stateCode: firstStateEntry?.state || null,
    stateWages: firstStateEntry?.wages ?? null,
    box16: firstStateEntry?.wages ?? null,
    stateWithholding: firstStateEntry?.withholding ?? null,
    box17: firstStateEntry?.withholding ?? null,
    retirementPlan: extraction.retirementPlan,
    box12Items: extraction.box12Items,
    box14Items: extraction.box14Items,
    reviewNotes: extraction.reviewNotes
  };
}

function mergeFinanceDocumentExtraction(existingExtractedFields, personalTaxExtraction) {
  if (!personalTaxExtraction) {
    return existingExtractedFields || {};
  }

  return {
    ...(existingExtractedFields || {}),
    personalTax: personalTaxExtraction,
    ...buildPersonalTaxAliases(personalTaxExtraction)
  };
}

function extractMoneyValueNearLabels(text, labels = []) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const pickLikelyMoney = (matches = []) => {
    const parsed = matches
      .map((match) => ({
        raw: match,
        value: normalizeMoneyValue(match),
      }))
      .filter((entry) => entry.value !== null);

    const filtered = parsed.filter((entry) => {
      const raw = String(entry.raw || '').replace(/[$,\s-]/g, '');
      return !(raw.length === 4 && !String(entry.raw || '').includes('.') && entry.value >= 1900 && entry.value <= 2100);
    });

    const candidates = filtered.length > 0 ? filtered : parsed;
    return candidates.length > 0 ? candidates[candidates.length - 1].value : null;
  };

  const normalizedLabels = labels.map((label) => String(label || '').replace(/[^a-z0-9]/gi, '').toLowerCase());
  const lineMatchesLabel = (line) => {
    const normalizedLine = String(line || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    return normalizedLabels.some((label) => label && normalizedLine.includes(label));
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!lineMatchesLabel(line)) {
      continue;
    }

    const candidates = [
      line,
      `${line} ${lines[index + 1] || ''}`.trim(),
      `${lines[index - 1] || ''} ${line}`.trim(),
    ];

    for (const candidate of candidates) {
      const matches = candidate.match(/-?\$?\d[\d,]*(?:\.\d{2})?/g) || [];
      const picked = pickLikelyMoney(matches);
      if (picked !== null) {
        return picked;
      }
    }
  }

  const compactText = lines.join(' ');
  for (const label of labels) {
    const compactLabel = String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${compactLabel}[\\s:.,;#-]{0,24}([^]{0,96})`, 'i');
    const match = compactText.match(pattern);
    const matches = match?.[1]?.match(/-?\$?\d[\d,]*(?:\.\d{2})?/g) || [];
    const picked = pickLikelyMoney(matches);
    if (picked !== null) {
      return picked;
    }
  }

  return null;
}

function extractTextValueNearLabels(text, labels = [], { maxLength = 160 } = {}) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLabels = labels.map((label) => String(label || '').replace(/[^a-z0-9]/gi, '').toLowerCase());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = line.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const matchedLabel = normalizedLabels.find((label) => label && normalizedLine.includes(label));
    if (!matchedLabel) {
      continue;
    }

    const originalLabel = labels[normalizedLabels.indexOf(matchedLabel)] || '';
    const escaped = String(originalLabel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sameLine = line.replace(new RegExp(`^\\s*(?:box\\s*)?\\d{0,2}\\s*${escaped}\\s*[:.-]?\\s*`, 'i'), '').trim();
    const candidate = sameLine && sameLine !== line ? sameLine : lines[index + 1] || '';
    const cleaned = String(candidate || '')
      .replace(/\b(box\s*)?\d{1,2}\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned && !/^\$?\d[\d,]*(?:\.\d{2})?$/.test(cleaned)) {
      return cleaned.slice(0, maxLength);
    }
  }

  return null;
}

function inferW2TaxYearFromContext({ contentPreview, title, originalFileName }) {
  const combined = [contentPreview, title, originalFileName].filter(Boolean).join(' ');
  const match = String(combined || '').match(/\b(20[1-4]\d)\b/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}

function inferStateEntriesFromContentPreview(contentPreview) {
  const text = String(contentPreview || '');
  if (!text.trim()) {
    return [];
  }

  const stateMatches = Array.from(text.matchAll(/\b([A-Z]{2})\b/g))
    .map((match) => String(match[1] || '').toUpperCase())
    .filter((code, index, list) => code && STATE_TAX_RATES[code] && list.indexOf(code) === index);
  const primaryState = stateMatches[0] || null;
  const stateWages = extractMoneyValueNearLabels(text, ['state wages, tips, etc', 'state wages']);
  const stateWithholding = extractMoneyValueNearLabels(text, ['state income tax', 'state income tax withheld', 'state withholding']);

  if (!primaryState && stateWages === null && stateWithholding === null) {
    return [];
  }

  return [{
    state: primaryState,
    stateId: null,
    wages: stateWages,
    withholding: stateWithholding,
  }];
}

async function maybeDigitizeReceiptDocument({ imageUrl, imageBase64, entry }) {
  if (!imageUrl && !imageBase64) {
    return null;
  }

  const fileName = `${(entry?.vendor || 'receipt').toString().trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'receipt'}-${entry?.date || new Date().toISOString().split('T')[0]}`;
  const title = entry?.description || entry?.vendor || 'Receipt';

  try {
    const digitization = imageBase64
      ? await digitizeDocumentFromBytes({
          ...decodeBase64Document(imageBase64),
          fileName,
          title
        })
      : await digitizeDocumentFromUrl({
          fileUrl: imageUrl,
          fileName,
          title
        });

    const summary = summarizeDigitizationForStorage(digitization);
    return {
      ok: !!digitization?.ok,
      contentPreview: summary.content ? summary.content.slice(0, 2000) : null,
      extractedFields: summary.extractedFields || {},
      metadata: summary.metadata?.digitization || null
    };
  } catch (error) {
    return {
      ok: false,
      contentPreview: null,
      extractedFields: {},
      metadata: {
        status: 'failed',
        supported: false,
        provider: 'azure-document-intelligence',
        interpretationProvider: null,
        processedAt: new Date().toISOString(),
        mimeType: null,
        pageCount: 0,
        rawTextLength: 0,
        documentType: null,
        classificationConfidence: 0,
        summary: null,
        extractionQuality: null,
        repairedLineCount: 0,
        keyFacts: [],
        parties: [],
        addresses: [],
        dates: [],
        monetaryAmounts: [],
        identifiers: [],
        actionItems: [],
        missingOrUnclear: [],
        reviewNotes: [],
        structuredSections: [],
        tableSummaries: [],
        lowConfidenceWords: [],
        error: error.message
      }
    };
  }
}

async function maybeDigitizeFinanceDocument({ fileBase64, originalFileName = 'finance-document', title = 'Finance document' }) {
  if (!fileBase64) {
    return null;
  }

  try {
    const digitization = await digitizeDocumentFromBytes({
      ...decodeBase64Document(fileBase64),
      fileName: originalFileName,
      title
    });
    const summary = summarizeDigitizationForStorage(digitization);
    return {
      ok: !!digitization?.ok,
      contentPreview: summary.content ? summary.content.slice(0, 12000) : null,
      extractedFields: summary.extractedFields || {},
      metadata: summary.metadata?.digitization || null
    };
  } catch (error) {
    return {
      ok: false,
      contentPreview: null,
      extractedFields: {},
      metadata: {
        status: 'failed',
        supported: false,
        provider: 'azure-document-intelligence',
        interpretationProvider: null,
        processedAt: new Date().toISOString(),
        mimeType: null,
        pageCount: 0,
        rawTextLength: 0,
        documentType: null,
        classificationConfidence: 0,
        summary: null,
        extractionQuality: null,
        repairedLineCount: 0,
        keyFacts: [],
        parties: [],
        addresses: [],
        dates: [],
        monetaryAmounts: [],
        identifiers: [],
        actionItems: [],
        missingOrUnclear: [],
        reviewNotes: [],
        structuredSections: [],
        tableSummaries: [],
        lowConfidenceWords: [],
        error: error.message
      }
    };
  }
}

async function createPostedJournalEntry(userId, payload) {
  const {
    entryDate,
    memo,
    source = 'MANUAL',
    sourceRef = null,
    lines,
    postedBy = 'system',
    ...extraFields
  } = payload;

  if (!entryDate || !memo || !Array.isArray(lines) || lines.length === 0) {
    const error = new Error('entryDate, memo, and journal lines are required');
    error.statusCode = 400;
    throw error;
  }

  const totalDebits = roundCurrency(lines.filter((line) => line.dc === 'D').reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const totalCredits = roundCurrency(lines.filter((line) => line.dc === 'C').reduce((sum, line) => sum + Number(line.amount || 0), 0));

  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    const error = new Error('Journal entry not balanced');
    error.statusCode = 400;
    throw error;
  }

  await ensureBookkeepingInitialized(userId);
  await assertAccountingPeriodOpen(userId, entryDate);

  const parsedEntryDate = new Date(entryDate);
  const entryTaxYear = Number.isFinite(parsedEntryDate.getTime())
    ? parsedEntryDate.getFullYear()
    : new Date().getFullYear();
  const rulesRuntime = await loadRuntimeTaxRulesetPackage(entryTaxYear);
  const rulesVersion = extraFields.rulesVersion || rulesRuntime.ruleset?.rulesVersion || null;

  const canonicalStatus = await isBookkeepingInitializedInAzure({ userId }).catch((error) => {
    console.error('[Bookkeeping] Canonical journal initialization status error:', error);
    return { ok: false, status: 'failed', error: error.message, initialized: false };
  });

  requireCanonicalLedgerResult(canonicalStatus, 'journal posting');

  const accountCodes = [...new Set(lines.map((line) => line.accountCode).filter(Boolean))];
  const accountRecords = await Promise.all(accountCodes.map((code) => getBookkeepingAccountRecord(userId, code)));
  const accountsByCode = new Map(accountCodes.map((code, index) => [code, accountRecords[index]]));
  const missingAccounts = accountCodes.filter((code) => !accountsByCode.get(code));

  if (missingAccounts.length > 0) {
    const error = new Error(`Account not found: ${missingAccounts.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const normalizedLines = lines.map((line) => ({
    ...line,
    accountName: line.accountName || accountsByCode.get(line.accountCode)?.name || resolveBookkeepingAccountName(line.accountCode),
    amount: roundCurrency(line.amount)
  }));
  const journalEntry = {
    entryDate,
    date: extraFields.date || entryDate,
    memo,
    source,
    sourceRef,
    rulesVersion,
    rulesSource: rulesRuntime.source || 'unknown',
    lines: normalizedLines,
    totalDebits,
    totalCredits,
    isBalanced: true,
    postedBy,
    createdAt: now,
    updatedAt: now,
    ...extraFields
  };
  const journalEntrySeed = sourceRef
    ? `${normalizeBookkeepingShadowSource(source)}:${sourceRef}`
    : randomUUID();
  const canonicalLedger = await postCanonicalManualJournalEntry({
    userId,
    journalEntryId: journalEntrySeed,
    entry: {
      ...journalEntry,
      vendor: extraFields.vendor || extraFields.payee || null,
      counterpartyName: extraFields.vendor || extraFields.payee || null
    },
    postedBy
  });

  return {
    journalEntryId: canonicalLedger.journalEntryId || journalEntrySeed,
    entry: {
      id: canonicalLedger.journalEntryId || journalEntrySeed,
      ...journalEntry
    },
    shadowLedger: canonicalLedger
  };

  if (shouldUseCanonicalLedger(canonicalStatus)) {
    const accountCodes = [...new Set(lines.map((line) => line.accountCode).filter(Boolean))];
    const accountRecords = await Promise.all(accountCodes.map((code) => getBookkeepingAccountRecord(userId, code)));
    const accountsByCode = new Map(accountCodes.map((code, index) => [code, accountRecords[index]]));
    const missingAccounts = accountCodes.filter((code) => !accountsByCode.get(code));

    if (missingAccounts.length > 0) {
      const error = new Error(`Account not found: ${missingAccounts.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }

    const now = new Date().toISOString();
    const normalizedLines = lines.map((line) => ({
      ...line,
      accountName: line.accountName || accountsByCode.get(line.accountCode)?.name || resolveBookkeepingAccountName(line.accountCode),
      amount: roundCurrency(line.amount)
    }));
    const journalEntry = {
      entryDate,
      date: extraFields.date || entryDate,
      memo,
      source,
      sourceRef,
      rulesVersion,
      rulesSource: rulesRuntime.source || 'unknown',
      lines: normalizedLines,
      totalDebits,
      totalCredits,
      isBalanced: true,
      postedBy,
      createdAt: now,
      updatedAt: now,
      ...extraFields
    };
    const journalEntrySeed = sourceRef
      ? `${normalizeBookkeepingShadowSource(source)}:${sourceRef}`
      : randomUUID();
    const canonicalLedger = await postCanonicalManualJournalEntry({
      userId,
      journalEntryId: journalEntrySeed,
      entry: {
        ...journalEntry,
        vendor: extraFields.vendor || extraFields.payee || null,
        counterpartyName: extraFields.vendor || extraFields.payee || null
      },
      postedBy
    });

    return {
      journalEntryId: canonicalLedger.journalEntryId || journalEntrySeed,
      entry: {
        id: canonicalLedger.journalEntryId || journalEntrySeed,
        ...journalEntry
      },
      shadowLedger: canonicalLedger
    };
  }
}

// Currency formatting helper for template strings
function fmtCurrencyHelper(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

// Default category budgets for rental properties (monthly)
const DEFAULT_BUDGETS = {
  '5000': { category: 'Repairs', monthlyBudget: 200, annualBudget: 2400 },
  '5100': { category: 'Utilities', monthlyBudget: 150, annualBudget: 1800 },
  '5200': { category: 'Insurance', monthlyBudget: 100, annualBudget: 1200 },
  '5300': { category: 'Property Taxes', monthlyBudget: 250, annualBudget: 3000 },
  '5400': { category: 'Management Fees', monthlyBudget: 100, annualBudget: 1200 },
  '5500': { category: 'Mortgage Interest', monthlyBudget: 800, annualBudget: 9600 },
  '5600': { category: 'HOA Fees', monthlyBudget: 50, annualBudget: 600 },
  '5700': { category: 'Landscaping', monthlyBudget: 75, annualBudget: 900 },
  '5800': { category: 'Cleaning & Maintenance', monthlyBudget: 50, annualBudget: 600 },
  '5900': { category: 'Legal & Professional', monthlyBudget: 50, annualBudget: 600 },
  '6000': { category: 'Advertising', monthlyBudget: 25, annualBudget: 300 }
};

function getInvoicesRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('invoices');
}

function getRecurringInvoicesRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('recurringInvoices');
}

// Default chart of accounts for real estate
const DEFAULT_ACCOUNTS = DEFAULT_CHART_OF_ACCOUNTS;

// ============================================================================
// Initialization Routes
// ============================================================================

/**
 * Check if bookkeeping is initialized for user
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const canonicalStatus = await isBookkeepingInitializedInAzure({ userId }).catch((error) => {
      console.error('[Bookkeeping] Canonical initialization status error:', error);
      return { ok: false, status: 'failed', error: error.message, initialized: false };
    });

    const readyCanonicalStatus = requireCanonicalLedgerResult(canonicalStatus, 'bookkeeping status');
    return res.json({
      ok: true,
      initialized: readyCanonicalStatus.initialized === true,
      config: readyCanonicalStatus.initialized
        ? {
            accountingMode: 'workpapers',
            domainVersion: ACCOUNTING_DOMAIN_VERSION,
            chartOfAccountsVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION
          }
        : null,
      foundation: buildBookkeepingFoundationStatus()
    });

    if (shouldUseCanonicalLedger(canonicalStatus)) {
      return res.json({
        ok: true,
        initialized: canonicalStatus.initialized === true,
        config: canonicalStatus.initialized
          ? {
              accountingMode: 'workpapers',
              domainVersion: ACCOUNTING_DOMAIN_VERSION,
              chartOfAccountsVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION
            }
          : null,
        foundation: buildBookkeepingFoundationStatus()
      });
    }

    const configRef = getConfigRef(userId);
    const configSnap = await configRef.get();
    
    res.json({
      ok: true,
      initialized: configSnap.exists,
      config: configSnap.exists ? configSnap.data() : null,
      foundation: buildBookkeepingFoundationStatus()
    });
  } catch (error) {
    console.error('[Bookkeeping] Status check error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/close-periods', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    await ensureBookkeepingInitialized(userId);

    const readyCanonicalClosePeriods = requireCanonicalLedgerResult(
      await listClosePeriodsFromAzure({ userId, limit: 60 }).catch((error) => {
        console.error('[Bookkeeping] Canonical close periods list error:', error);
        return {
          ok: false,
          status: 'failed',
          error: error.message,
          closePeriods: []
        };
      }),
      'close period list',
    );

    return res.json({
      ok: true,
      closePeriods: readyCanonicalClosePeriods.closePeriods || [],
      canonicalStatus: readyCanonicalClosePeriods.status || 'unknown',
      canonicalError: readyCanonicalClosePeriods.error || null
    });

    const [snapshot, canonicalResult] = await Promise.all([
      getClosePeriodsRef(userId).orderBy('periodKey', 'desc').get(),
      listClosePeriodsFromAzure({ userId, limit: 60 }).catch((error) => {
        console.error('[Bookkeeping] Canonical close periods list error:', error);
        return {
          ok: false,
          status: 'failed',
          error: error.message,
          closePeriods: []
        };
      })
    ]);
    const firestoreClosePeriods = snapshot.docs
      .map((doc) => normalizeClosePeriodRecord({ id: doc.id, ...doc.data() }))
      .filter(Boolean);
    const closePeriods = mergeClosePeriodLists(canonicalResult.closePeriods || [], firestoreClosePeriods);

    res.json({
      ok: true,
      closePeriods,
      canonicalStatus: canonicalResult.status || 'not_configured',
      canonicalError: canonicalResult.error || null
    });
  } catch (error) {
    console.error('[Bookkeeping] Get close periods error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/close-periods/:periodKey/intelligence', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const periodKey = req.params.periodKey;

    if (!/^\d{4}-\d{2}$/.test(String(periodKey || ''))) {
      return res.status(400).json({ ok: false, error: 'periodKey must be in YYYY-MM format' });
    }

    await ensureBookkeepingInitialized(userId);

    const year = parseInt(String(periodKey).slice(0, 4), 10);
    const [storedClosePeriod, exceptionReview, evidenceResult, recentCanonicalResult] = await Promise.all([
      loadStoredClosePeriod(userId, periodKey),
      assessClosePeriodReconciliationReadiness(userId, periodKey),
      listFinanceEvidenceFromAzure({ userId, year, limit: 200 }).catch((error) => {
        console.error('[Bookkeeping] Close period intelligence evidence error:', error);
        return {
          ok: false,
          status: 'failed',
          error: error.message,
          evidence: [],
          summary: {
            totalEvidence: 0,
            evidenceTypeCounts: {},
            digitizationStatusCounts: {}
          }
        };
      }),
      listClosePeriodsFromAzure({ userId, limit: 6 }).catch((error) => {
        console.error('[Bookkeeping] Close period intelligence canonical list error:', error);
        return {
          ok: false,
          status: 'failed',
          error: error.message,
          closePeriods: []
        };
      })
    ]);

    const readyRecentCanonicalClosePeriods = requireCanonicalLedgerResult(
      recentCanonicalResult,
      'close period intelligence history',
    );
    const recentClosePeriods = (readyRecentCanonicalClosePeriods.closePeriods || []).slice(0, 6);

    const intelligence = buildClosePeriodIntelligence({
      periodKey,
      closePeriod: storedClosePeriod.closePeriod,
      exceptionReview,
      evidence: evidenceResult,
      recentClosePeriods,
      canonicalCloseStatus: storedClosePeriod.canonicalStatus
    });

    res.json({
      ok: true,
      intelligence,
      closePeriod: storedClosePeriod.closePeriod,
      exceptionReview,
      evidenceSummary: evidenceResult.summary || {
        totalEvidence: 0,
        evidenceTypeCounts: {},
        digitizationStatusCounts: {}
      }
    });
  } catch (error) {
    console.error('[Bookkeeping] Close period intelligence error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.post('/close-periods', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { periodKey, reason = null, notes = null, approval = {} } = req.body || {};
    const actor = req.user.email || req.user.uid;
    const normalizedReason = String(reason || '').trim();

    if (!/^\d{4}-\d{2}$/.test(String(periodKey || ''))) {
      return res.status(400).json({ ok: false, error: 'periodKey is required in YYYY-MM format' });
    }

    if (!normalizedReason) {
      return res.status(400).json({ ok: false, error: 'A close reason is required' });
    }

    await ensureBookkeepingInitialized(userId);

    const storedClosePeriod = await loadStoredClosePeriod(userId, periodKey);
    const bounds = getAccountingMonthBounds(periodKey);
    const now = new Date().toISOString();
    const approvalControl = buildApprovalControl({
      approval,
      actor,
      actionType: 'close_period',
      requiredChecklist: CLOSE_PERIOD_REQUIRED_APPROVAL_CHECKS,
      approvedAt: now
    });
    const exceptionReview = await assessClosePeriodReconciliationReadiness(userId, periodKey);

    if (exceptionReview.status === 'loaded' && exceptionReview.openItemCount > 0) {
      return res.status(409).json({
        ok: false,
        error: `Cannot close ${formatAccountingPeriodLabel(periodKey)} while reconciliation exceptions remain open.`,
        details: exceptionReview
      });
    }

    const existingRecord = stripClosePeriodViewFields(storedClosePeriod.closePeriod || {});
    const closePeriod = {
      ...existingRecord,
      entityType: ACCOUNTING_ENTITY_TYPES.CLOSE_PERIOD,
      periodKey,
      startDate: bounds.startDate,
      endDate: bounds.endDate,
      status: ACCOUNTING_CLOSE_PERIOD_STATUSES.CLOSED,
      reason: normalizedReason,
      notes,
      approvalControl,
      exceptionReview,
      closedAt: now,
      closedBy: actor,
      createdAt: existingRecord.createdAt || now,
      updatedAt: now
    };

    await getClosePeriodsRef(userId).doc(periodKey).set(closePeriod, { merge: true });
    await getConfigRef(userId).set({ updatedAt: now }, { merge: true });

    let canonicalClosePeriod = {
      ok: true,
      status: 'not_configured',
      closePeriod: null,
      error: null
    };
    try {
      canonicalClosePeriod = await upsertClosePeriodToAzure({
        userId,
        propertyId: closePeriod.propertyId || null,
        periodKey: closePeriod.periodKey,
        startDate: closePeriod.startDate,
        endDate: closePeriod.endDate,
        status: closePeriod.status,
        reason: closePeriod.reason || null,
        notes: closePeriod.notes || null,
        approvalControl: closePeriod.approvalControl || null,
        exceptionReview: closePeriod.exceptionReview || null,
        closedBy: closePeriod.closedBy || null,
        closedAt: closePeriod.closedAt || null,
        reopenReason: closePeriod.reopenReason || null,
        reopenNotes: closePeriod.reopenNotes || null,
        reopenApprovalControl: closePeriod.reopenApprovalControl || null,
        reopenedBy: closePeriod.reopenedBy || null,
        reopenedAt: closePeriod.reopenedAt || null,
        performedBy: actor,
        actionType: 'close_period',
        summary: `Closed accounting period ${periodKey}`
      });
    } catch (error) {
      console.error('[Bookkeeping] Canonical close period persistence error:', error);
      canonicalClosePeriod = {
        ok: false,
        status: 'failed',
        error: error.message,
        closePeriod: null
      };
    }

    const responseClosePeriod = mergeClosePeriodRecordPair(
      normalizeClosePeriodRecord(canonicalClosePeriod.closePeriod || null),
      normalizeClosePeriodRecord({ id: periodKey, ...closePeriod })
    );

    res.json({
      ok: true,
      closePeriod: responseClosePeriod,
      canonicalClosePeriod: {
        status: canonicalClosePeriod.status,
        error: canonicalClosePeriod.error || null,
        closePeriodId: canonicalClosePeriod.closePeriod?.closePeriodId || null
      }
    });
  } catch (error) {
    console.error('[Bookkeeping] Close period error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.post('/close-periods/:periodKey/reopen', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const periodKey = req.params.periodKey;
    const { notes = null, reason = null, approval = {} } = req.body || {};
    const actor = req.user.email || req.user.uid;
    const normalizedReason = String(reason || '').trim();

    if (!/^\d{4}-\d{2}$/.test(String(periodKey || ''))) {
      return res.status(400).json({ ok: false, error: 'periodKey must be in YYYY-MM format' });
    }

    if (!normalizedReason) {
      return res.status(400).json({ ok: false, error: 'A reopen reason is required' });
    }

    await ensureBookkeepingInitialized(userId);

    const storedClosePeriod = await loadStoredClosePeriod(userId, periodKey);
    if (!storedClosePeriod.closePeriod) {
      return res.status(404).json({ ok: false, error: 'Close period not found' });
    }

    const now = new Date().toISOString();
    const approvalControl = buildApprovalControl({
      approval,
      actor,
      actionType: 'reopen_period',
      requiredChecklist: REOPEN_PERIOD_REQUIRED_APPROVAL_CHECKS,
      approvedAt: now
    });
    const existingRecord = stripClosePeriodViewFields(storedClosePeriod.closePeriod);
    const closePeriodRef = getClosePeriodsRef(userId).doc(periodKey);
    const updatedClosePeriod = {
      ...existingRecord,
      entityType: ACCOUNTING_ENTITY_TYPES.CLOSE_PERIOD,
      periodKey,
      startDate: existingRecord.startDate || getAccountingMonthBounds(periodKey).startDate,
      endDate: existingRecord.endDate || getAccountingMonthBounds(periodKey).endDate,
      status: ACCOUNTING_CLOSE_PERIOD_STATUSES.REOPENED,
      reopenReason: normalizedReason,
      reopenNotes: notes,
      reopenApprovalControl: approvalControl,
      reopenedAt: now,
      reopenedBy: actor,
      updatedAt: now
    };
    await closePeriodRef.set(updatedClosePeriod, { merge: true });
    await getConfigRef(userId).set({ updatedAt: now }, { merge: true });

    let canonicalClosePeriod = {
      ok: true,
      status: 'not_configured',
      closePeriod: null,
      error: null
    };
    try {
      canonicalClosePeriod = await upsertClosePeriodToAzure({
        userId,
        propertyId: updatedClosePeriod.propertyId || null,
        periodKey: updatedClosePeriod.periodKey,
        startDate: updatedClosePeriod.startDate,
        endDate: updatedClosePeriod.endDate,
        status: updatedClosePeriod.status,
        reason: updatedClosePeriod.reason || null,
        notes: updatedClosePeriod.notes || null,
        approvalControl: updatedClosePeriod.approvalControl || null,
        exceptionReview: updatedClosePeriod.exceptionReview || null,
        closedBy: updatedClosePeriod.closedBy || null,
        closedAt: updatedClosePeriod.closedAt || null,
        reopenReason: updatedClosePeriod.reopenReason || null,
        reopenNotes: updatedClosePeriod.reopenNotes || null,
        reopenApprovalControl: updatedClosePeriod.reopenApprovalControl || null,
        reopenedBy: updatedClosePeriod.reopenedBy || null,
        reopenedAt: updatedClosePeriod.reopenedAt || null,
        performedBy: actor,
        actionType: 'reopen_period',
        summary: `Reopened accounting period ${periodKey}`
      });
    } catch (error) {
      console.error('[Bookkeeping] Canonical reopen period persistence error:', error);
      canonicalClosePeriod = {
        ok: false,
        status: 'failed',
        error: error.message,
        closePeriod: null
      };
    }

    const updated = normalizeClosePeriodRecord({ id: periodKey, ...(await closePeriodRef.get()).data() });
    res.json({
      ok: true,
      closePeriod: mergeClosePeriodRecordPair(
        normalizeClosePeriodRecord(canonicalClosePeriod.closePeriod || null),
        updated
      ),
      canonicalClosePeriod: {
        status: canonicalClosePeriod.status,
        error: canonicalClosePeriod.error || null,
        closePeriodId: canonicalClosePeriod.closePeriod?.closePeriodId || null
      }
    });
  } catch (error) {
    console.error('[Bookkeeping] Reopen close period error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/reconciliation-exceptions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      propertyId = null,
      reconciliationScope = null,
      periodKey = null,
      limit = 50,
      includeClosed = 'false'
    } = req.query;

    const queue = await listReconciliationExceptionQueue({
      userId,
      propertyId,
      reconciliationScope,
      periodKey,
      limit,
      includeClosed: includeClosed === 'true'
    });

    res.json(queue);
  } catch (error) {
    console.error('[Bookkeeping] Reconciliation exception queue error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/reconciliation-exceptions/:reconciliationItemId/evidence', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const reconciliationItemId = req.params.reconciliationItemId;

    if (!reconciliationItemId) {
      return res.status(400).json({ ok: false, error: 'reconciliationItemId is required' });
    }

    const detail = await getReconciliationExceptionDetail({ userId, reconciliationItemId });
    const item = detail.item;
    if (!item) {
      return res.status(404).json({ ok: false, error: 'Reconciliation item not found' });
    }

    const evidenceQueries = [
      { entityType: 'reconciliation_item', entityId: reconciliationItemId },
      item.journalEntryId ? { entityType: 'journal_entry', entityId: item.journalEntryId } : null,
      item.matchResolution?.journalEntryId ? { entityType: 'journal_entry', entityId: item.matchResolution.journalEntryId } : null,
      item.matchResolution?.firestoreJournalEntryId ? { entityType: 'firestore_journal_entry', entityId: item.matchResolution.firestoreJournalEntryId } : null,
      item.sourceRef ? { q: item.sourceRef } : null
    ].filter(Boolean);

    const evidenceResponses = await Promise.all(
      evidenceQueries.map((query) => listFinanceEvidenceFromAzure({
        userId,
        propertyId: item.propertyId || null,
        year: item.periodKey ? parseInt(String(item.periodKey).slice(0, 4), 10) : null,
        limit: 10,
        ...query
      }))
    );

    const evidenceMap = new Map();
    for (const response of evidenceResponses) {
      for (const evidenceItem of response.evidence || []) {
        if (!evidenceMap.has(evidenceItem.evidenceId)) {
          evidenceMap.set(evidenceItem.evidenceId, evidenceItem);
        }
      }
    }

    res.json({
      ok: true,
      status: evidenceResponses.some((response) => response.status === 'loaded')
        ? 'loaded'
        : (evidenceResponses[0]?.status || 'not_configured'),
      evidence: Array.from(evidenceMap.values()),
      search: evidenceResponses.map((response) => response.search).filter(Boolean)
    });
  } catch (error) {
    console.error('[Bookkeeping] Reconciliation evidence error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.post('/reconciliation-exceptions/:reconciliationItemId/review', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const reconciliationItemId = req.params.reconciliationItemId;
    const { matchStatus, notes = undefined, journalEntryId = undefined, matchResolution = undefined } = req.body || {};

    const result = await reviewReconciliationException({
      userId,
      reconciliationItemId,
      matchStatus,
      notes,
      journalEntryId,
      matchResolution,
      reviewedBy: req.user.email || req.user.uid
    });

    res.json(result);
  } catch (error) {
    console.error('[Bookkeeping] Reconciliation exception review error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.post('/reconciliation-exceptions/:reconciliationItemId/adjusting-entry', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const reconciliationItemId = req.params.reconciliationItemId;
    const {
      entryDate = null,
      memo = null,
      amount = null,
      debitAccountCode,
      creditAccountCode
    } = req.body || {};

    if (!debitAccountCode || !creditAccountCode) {
      return res.status(400).json({ ok: false, error: 'debitAccountCode and creditAccountCode are required' });
    }

    const detail = await getReconciliationExceptionDetail({ userId, reconciliationItemId });
    const item = detail.item;
    const openStatuses = ['pending_match', 'pending_review', 'exception_requires_review'];
    if (!item || !openStatuses.includes(item.matchStatus)) {
      return res.status(409).json({
        ok: false,
        error: `Adjusting entries can only be created for open reconciliation items. Current status: ${item?.matchStatus || 'unknown'}`
      });
    }

    const effectiveEntryDate = String(entryDate || item.effectiveDate || item.createdAt || new Date().toISOString()).slice(0, 10);
    const normalizedAmount = roundCurrency(amount ?? item.amount ?? 0);
    if (!normalizedAmount) {
      return res.status(400).json({ ok: false, error: 'A non-zero amount is required to create an adjusting entry' });
    }

    const entryMemo = String(memo || `Adjustment for reconciliation exception ${item.sourceRef}`).trim();
    const result = await createPostedJournalEntry(userId, {
      entryDate: effectiveEntryDate,
      memo: entryMemo,
      source: 'ADJUSTMENT',
      sourceRef: `reconciliation_exception:${reconciliationItemId}`,
      postedBy: req.user.email || req.user.uid,
      propertyId: item.propertyId || null,
      reconciliationItemId,
      lines: [
        {
          accountCode: debitAccountCode,
          dc: 'D',
          amount: normalizedAmount,
          memo: entryMemo
        },
        {
          accountCode: creditAccountCode,
          dc: 'C',
          amount: normalizedAmount,
          memo: entryMemo
        }
      ]
    });

    const canonicalJournalEntryId = result.shadowLedger?.journalEntryId || null;
    const reviewResult = await reviewReconciliationException({
      userId,
      reconciliationItemId,
      matchStatus: 'resolved',
      notes: item.notes || undefined,
      journalEntryId: canonicalJournalEntryId,
      matchResolution: {
        journalEntryId: canonicalJournalEntryId,
        firestoreJournalEntryId: result.journalEntryId,
        matchedSourceRef: canonicalJournalEntryId ? `journal_entry:${canonicalJournalEntryId}` : `firestore_journal_entry:${result.journalEntryId}`,
        matchedSourceSystem: 'HOUSEYIELD',
        matchReason: 'Resolved with adjusting journal entry',
        adjustmentEntry: {
          journalEntryId: canonicalJournalEntryId,
          firestoreJournalEntryId: result.journalEntryId,
          entryDate: effectiveEntryDate,
          amount: normalizedAmount,
          debitAccountCode,
          creditAccountCode,
          memo: entryMemo
        }
      },
      reviewedBy: req.user.email || req.user.uid
    });

    res.json({
      ok: true,
      adjustingEntry: result.entry,
      shadowLedger: result.shadowLedger,
      reviewResult
    });
  } catch (error) {
    console.error('[Bookkeeping] Reconciliation adjusting entry error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * Initialize bookkeeping for a new user
 */
router.post('/initialize', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const canonicalResult = await ensureBookkeepingInitializedInAzure({ userId }).catch((error) => {
      console.error('[Bookkeeping] Canonical initialize error:', error);
      return { ok: false, status: 'failed', error: error.message, initialized: false };
    });

    const readyCanonicalInitialize = requireCanonicalLedgerResult(canonicalResult, 'bookkeeping initialize');
    return res.json({
      ok: true,
      message: readyCanonicalInitialize.alreadyInitialized ? 'Already initialized' : 'Bookkeeping initialized',
      accountsCreated: readyCanonicalInitialize.alreadyInitialized ? 0 : readyCanonicalInitialize.seededAccounts,
      foundation: buildBookkeepingFoundationStatus()
    });

    if (shouldUseCanonicalLedger(canonicalResult)) {
      return res.json({
        ok: true,
        message: canonicalResult.alreadyInitialized ? 'Already initialized' : 'Bookkeeping initialized',
        accountsCreated: canonicalResult.alreadyInitialized ? 0 : canonicalResult.seededAccounts,
        foundation: buildBookkeepingFoundationStatus()
      });
    }

    const db = getFirestore();
    const batch = db.batch();
    const now = new Date().toISOString();
    
    // Check if already initialized
    const configRef = getConfigRef(userId);
    const configSnap = await configRef.get();
    
    if (configSnap.exists) {
      return res.json({ ok: true, message: 'Already initialized' });
    }
    
    // Create default accounts
    const accountsRef = getAccountsRef(userId);
    for (const account of DEFAULT_ACCOUNTS) {
      const docRef = accountsRef.doc(account.code);
      batch.set(docRef, {
        ...account,
        createdAt: now,
        updatedAt: now
      });
    }
    
    // Create config
    batch.set(configRef, buildDefaultBookkeepingConfig(now));
    
    await batch.commit();
    
    res.json({
      ok: true,
      message: 'Bookkeeping initialized',
      accountsCreated: DEFAULT_ACCOUNTS.length,
      foundation: {
        domainVersion: ACCOUNTING_DOMAIN_VERSION,
        chartOfAccountsVersion: DEFAULT_CHART_OF_ACCOUNTS_VERSION
      }
    });
  } catch (error) {
    console.error('[Bookkeeping] Initialize error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

// ============================================================================
// Account Routes
// ============================================================================

/**
 * Get all accounts
 */
router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const canonicalAccounts = await listLedgerAccountsFromAzure({ userId }).catch((error) => {
      console.error('[Bookkeeping] Canonical accounts error:', error);
      return { ok: false, status: 'failed', error: error.message, accounts: [] };
    });

    const readyCanonicalAccounts = requireCanonicalLedgerResult(canonicalAccounts, 'accounts');
    return res.json({
      ok: true,
      accounts: (readyCanonicalAccounts.accounts || []).map(mapCanonicalAccountForResponse)
    });

    if (shouldUseCanonicalLedger(canonicalAccounts)) {
      return res.json({
        ok: true,
        accounts: (canonicalAccounts.accounts || []).map(mapCanonicalAccountForResponse)
      });
    }

    const accountsRef = getAccountsRef(userId);
    const snapshot = await accountsRef.where('isActive', '==', true).orderBy('code').get();
    
    const accounts = snapshot.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        normal_side: ['ASSET', 'EXPENSE'].includes(d.type) ? 'D' : 'C',
        tax_map: d.scheduleELine ? `Schedule E Line ${d.scheduleELine}` : null
      };
    });
    
    res.json({ ok: true, accounts });
  } catch (error) {
    console.error('[Bookkeeping] Get accounts error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * Create or update an account
 */
router.post('/accounts', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { code, name, type, subtype } = req.body;
    
    if (!code || !name || !type) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: code, name, type' });
    }
    
    const canonicalResult = await upsertBookkeepingAccountInAzure({
      userId,
      code,
      name,
      type,
      subtype,
      isActive: true
    }).catch((error) => {
      console.error('[Bookkeeping] Canonical account save error:', error);
      return { ok: false, status: 'failed', error: error.message, account: null };
    });

    const readyCanonicalAccountSave = requireCanonicalLedgerResult(canonicalResult, `account save ${code}`);
    return res.json({ ok: true, code, account: readyCanonicalAccountSave.account });

    if (shouldUseCanonicalLedger(canonicalResult)) {
      return res.json({ ok: true, code, account: canonicalResult.account });
    }

    const accountsRef = getAccountsRef(userId);
    const docRef = accountsRef.doc(code);
    const now = new Date().toISOString();
    const existing = await docRef.get();
    if (existing.exists) {
      await docRef.update({ name, type, subtype, updatedAt: now });
    } else {
      await docRef.set({
        code, name, type, subtype,
        isActive: true,
        balance: 0,
        createdAt: now,
        updatedAt: now
      });
    }
    
    res.json({ ok: true, code });
  } catch (error) {
    console.error('[Bookkeeping] Save account error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

// ============================================================================
// Transaction / Journal Entry Routes
// ============================================================================

/**
 * Get transactions (flattened for UI)
 */
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { startDate, endDate, limit: limitParam, type, propertyId } = req.query;

    const { entries } = await loadCanonicalLedgerEntriesForScope({
      userId,
      startDate: startDate || null,
      endDate: endDate || null,
      propertyId: propertyId || null,
      limit: limitParam ? Math.max(50, parseInt(limitParam, 10) || 50) : 5000
    ,
      errorLabel: 'transactions',
    });
    return res.json({
      ok: true,
      transactions: buildCanonicalTransactions(entries, {
        type,
        limit: limitParam
      })
    });

    if (shouldUseCanonicalLedger(canonicalEntries)) {
      return res.json({
        ok: true,
        transactions: buildCanonicalTransactions(canonicalEntries.entries || [], {
          type,
          limit: limitParam
        })
      });
    }
    
    const entriesRef = getJournalEntriesRef(userId);
    let query = entriesRef.orderBy('entryDate', 'desc');
    
    if (startDate) {
      query = query.where('entryDate', '>=', startDate);
    }
    if (endDate) {
      query = query.where('entryDate', '<=', endDate);
    }
    if (limitParam) {
      query = query.limit(parseInt(limitParam) || 50);
    }
    
    const snapshot = await query.get();
    
    // Flatten entries into transactions using isExpense flag
    const transactions = [];

    for (const doc of snapshot.docs) {
      const entry = doc.data();
      if (!matchesPropertyScope(entry, propertyId)) continue;
      const amount = Math.abs(entry.totalCredits || entry.totalDebits || 0);

      // Determine if expense - check explicit flag first, otherwise infer from amount/lines
      let isExpense = entry.isExpense;
      if (isExpense === undefined) {
        isExpense = (entry.totalDebits > entry.totalCredits);
      }

      // Derive category from the non-cash journal line's accountName
      // (the line whose accountCode is NOT '1000' Operating Cash)
      const categoryLine = (entry.lines || []).find(l => l.accountCode !== '1000');
      const derivedCategory = entry.category
        || (categoryLine && categoryLine.accountName !== 'Other Expenses' && categoryLine.accountName !== 'Other Income' ? categoryLine.accountName : null)
        || entry.payee
        || (isExpense ? 'Other Expenses' : 'Other Income');
      const scheduleELine = entry.scheduleELine ?? categoryLine?.scheduleELine ?? null;
      const accountCode = categoryLine?.accountCode || null;

      if (isExpense === false) {
        // Income
        if (!type || type === 'all' || type === 'income') {
          transactions.push({
            id: doc.id,
            date: entry.entryDate,
            description: entry.memo,
            category: derivedCategory,
            amount: amount,
            type: 'income',
            propertyId: entry.propertyId || null,
            source: entry.source || entry.sourceSystem || 'MANUAL',
            sourceRef: entry.sourceRef || null,
            financeEventType: entry.financeEventType || null,
            vendor: entry.vendor || null,
            accountCode,
            scheduleELine,
            taxMap: scheduleELine ? `Schedule E Line ${scheduleELine}` : null
          });
        }
      } else if (isExpense === true) {
        // Expense
        if (!type || type === 'all' || type === 'expense') {
          transactions.push({
            id: doc.id,
            date: entry.entryDate,
            description: entry.memo,
            category: derivedCategory,
            amount: -amount, // Negative for expenses
            type: 'expense',
            propertyId: entry.propertyId || null,
            source: entry.source || entry.sourceSystem || 'MANUAL',
            sourceRef: entry.sourceRef || null,
            financeEventType: entry.financeEventType || null,
            vendor: entry.vendor || null,
            accountCode,
            scheduleELine,
            taxMap: scheduleELine ? `Schedule E Line ${scheduleELine}` : null
          });
        }
      }
    }
    
    // Sort by date
    transactions.sort((a, b) => b.date.localeCompare(a.date));

    const limitedTransactions = limitParam
      ? transactions.slice(0, parseInt(limitParam) || 50)
      : transactions;
    
    res.json({ ok: true, transactions: limitedTransactions });
  } catch (error) {
    console.error('[Bookkeeping] Get transactions error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * Get summary (income, expenses, net)
 */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { startDate, endDate, propertyId } = req.query;

    const [canonicalEntryScope, canonicalAccounts] = await Promise.all([
      loadCanonicalLedgerEntriesForScope({
        userId,
        startDate: startDate || null,
        endDate: endDate || null,
        propertyId: propertyId || null,
        limit: 10000,
        errorLabel: 'summary entries',
      }),
      listLedgerAccountsFromAzure({ userId }).catch((error) => {
        console.error('[Bookkeeping] Canonical summary accounts error:', error);
        return { ok: false, status: 'failed', error: error.message, accounts: [] };
      })
    ]);

    const readyCanonicalSummaryAccounts = requireCanonicalLedgerResult(canonicalAccounts, 'summary accounts');
    const canonicalBuckets = buildLedgerCategoryBuckets(canonicalEntryScope.entries || []);
    const canonicalCashAccount = (readyCanonicalSummaryAccounts.accounts || []).find((account) => account.code === '1000');
    const canonicalNetCashFlow = roundCurrency(canonicalBuckets.totalIncome - canonicalBuckets.totalExpenses);

    return res.json({
      ok: true,
      summary: {
        totalIncome: canonicalBuckets.totalIncome,
        totalExpenses: canonicalBuckets.totalExpenses,
        netIncome: canonicalNetCashFlow,
        netCashFlow: canonicalNetCashFlow,
        margin: canonicalBuckets.totalIncome > 0 ? ((canonicalNetCashFlow / canonicalBuckets.totalIncome) * 100).toFixed(1) : '0.0',
        cashBalance: canonicalCashAccount ? roundCurrency(canonicalCashAccount.balance) : 0,
        incomeByCategory: Array.from(canonicalBuckets.incomeByCategory.entries())
          .map(([category, amount]) => ({ category, amount: roundCurrency(amount) }))
          .filter((item) => item.amount !== 0),
        expensesByCategory: Array.from(canonicalBuckets.expensesByCategory.entries())
          .map(([category, amount]) => ({ category, amount: roundCurrency(amount) }))
          .filter((item) => item.amount !== 0)
      }
    });

    if (shouldUseCanonicalLedger(canonicalEntries) && shouldUseCanonicalLedger(canonicalAccounts)) {
      const buckets = buildLedgerCategoryBuckets(canonicalEntries.entries || []);
      const cashAccount = (canonicalAccounts.accounts || []).find((account) => account.code === '1000');
      const netCashFlow = roundCurrency(buckets.totalIncome - buckets.totalExpenses);

      return res.json({
        ok: true,
        summary: {
          totalIncome: buckets.totalIncome,
          totalExpenses: buckets.totalExpenses,
          netIncome: netCashFlow,
          netCashFlow,
          margin: buckets.totalIncome > 0 ? ((netCashFlow / buckets.totalIncome) * 100).toFixed(1) : '0.0',
          cashBalance: cashAccount ? roundCurrency(cashAccount.balance) : 0,
          incomeByCategory: Array.from(buckets.incomeByCategory.entries())
            .map(([category, amount]) => ({ category, amount: roundCurrency(amount) }))
            .filter((item) => item.amount !== 0),
          expensesByCategory: Array.from(buckets.expensesByCategory.entries())
            .map(([category, amount]) => ({ category, amount: roundCurrency(amount) }))
            .filter((item) => item.amount !== 0)
        }
      });
    }
    
    const entriesRef = getJournalEntriesRef(userId);
    let query = entriesRef;
    
    if (startDate) {
      query = query.where('entryDate', '>=', startDate);
    }
    if (endDate) {
      query = query.where('entryDate', '<=', endDate);
    }
    
    const snapshot = await query.get();
    
    // Get accounts for lookup
    const accountsRef = getAccountsRef(userId);
    const accountsSnap = await accountsRef.get();
    
    let totalIncome = 0;
    let totalExpenses = 0;
    const incomeByCategory = new Map();
    const expensesByCategory = new Map();
    
    // Use isExpense flag for consistent calculations
    for (const doc of snapshot.docs) {
      const entry = doc.data();
      if (!matchesPropertyScope(entry, propertyId)) continue;
      const amount = Math.abs(entry.totalCredits || entry.totalDebits || 0);

      // Derive category from the non-cash journal line's accountName (same logic as GET /transactions)
      const categoryLine = (entry.lines || []).find(l => l.accountCode !== '1000');
      const categoryName = entry.category
        || (categoryLine && categoryLine.accountName !== 'Other Expenses' && categoryLine.accountName !== 'Other Income' ? categoryLine.accountName : null)
        || entry.payee
        || (entry.isExpense ? 'Other Expenses' : 'Other Income');

      if (entry.isExpense === false) {
        totalIncome += amount;
        incomeByCategory.set(categoryName, (incomeByCategory.get(categoryName) || 0) + amount);
      } else if (entry.isExpense === true) {
        totalExpenses += amount;
        expensesByCategory.set(categoryName, (expensesByCategory.get(categoryName) || 0) + amount);
      }
    }
    
    // Get cash balance
    const cashAccount = accountsSnap.docs.find(d => d.id === '1000');
    const cashBalance = cashAccount ? cashAccount.data().balance : 0;
    
    // Calculate net cash flow and margin for consistency with QuickBooks API
    const netCashFlow = Math.round((totalIncome - totalExpenses) * 100) / 100;
    const margin = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome * 100).toFixed(1) : '0.0';
    
    res.json({
      ok: true,
      summary: {
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netIncome: netCashFlow,
        netCashFlow: netCashFlow, // Alias for compatibility
        margin: margin,
        cashBalance,
        incomeByCategory: Array.from(incomeByCategory.entries())
          .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
          .filter(c => c.amount !== 0),
        expensesByCategory: Array.from(expensesByCategory.entries())
          .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
          .filter(c => c.amount !== 0)
      }
    });
  } catch (error) {
    console.error('[Bookkeeping] Get summary error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * Get categories breakdown
 */
router.get('/categories', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { startDate, endDate } = req.query;
    
    const entriesRef = getJournalEntriesRef(userId);
    let query = entriesRef;
    
    if (startDate) {
      query = query.where('entryDate', '>=', startDate);
    }
    if (endDate) {
      query = query.where('entryDate', '<=', endDate);
    }
    
    const snapshot = await query.get();
    
    // Get accounts for lookup
    const accountsRef = getAccountsRef(userId);
    const accountsSnap = await accountsRef.get();
    const accountMap = new Map(accountsSnap.docs.map(d => [d.id, d.data()]));
    
    const categories = new Map();
    
    for (const doc of snapshot.docs) {
      const entry = doc.data();
      
      for (const line of (entry.lines || [])) {
        const account = accountMap.get(line.accountCode);
        if (!account || !['REVENUE', 'EXPENSE'].includes(account.type)) continue;
        
        const type = account.type === 'REVENUE' ? 'income' : 'expense';
        const amount = (account.type === 'REVENUE' && line.dc === 'C') || 
                      (account.type === 'EXPENSE' && line.dc === 'D') 
          ? line.amount : -line.amount;
        
        const key = `${type}-${account.name}`;
        const existing = categories.get(key) || { name: account.name, type, amount: 0, count: 0 };
        existing.amount += amount;
        existing.count += 1;
        categories.set(key, existing);
      }
    }
    
    res.json({
      ok: true,
      categories: Array.from(categories.values())
        .filter(c => Math.abs(c.amount) > 0.005)
        .map(c => ({ ...c, amount: Math.round(c.amount * 100) / 100 }))
    });
  } catch (error) {
    console.error('[Bookkeeping] Get categories error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DEBUG: Get detailed transaction breakdown for a specific month
 * Helps identify discrepancies between displayed transactions and cashflow calculations
 */
router.get('/debug-month/:year/:month', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);
    
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0]; // Last day of month
    
    const entriesRef = getJournalEntriesRef(userId);
    const snapshot = await entriesRef
      .where('entryDate', '>=', startDate)
      .where('entryDate', '<=', endDate)
      .get();
    
    let totalIncome = 0;
    let totalExpenses = 0;
    const entries = [];
    
    for (const doc of snapshot.docs) {
      const entry = doc.data();
      const amount = Math.abs(entry.totalCredits || entry.totalDebits || 0);
      
      const entryDetails = {
        id: doc.id,
        date: entry.entryDate,
        memo: entry.memo,
        payee: entry.payee,
        category: entry.category,
        amount,
        isExpense: entry.isExpense,
        totalDebits: entry.totalDebits,
        totalCredits: entry.totalCredits,
        source: entry.source,
        sourceRef: entry.sourceRef
      };
      
      if (entry.isExpense === false) {
        totalIncome += amount;
        entryDetails.classification = 'INCOME';
      } else if (entry.isExpense === true) {
        totalExpenses += amount;
        entryDetails.classification = 'EXPENSE';
      } else {
        entryDetails.classification = 'UNKNOWN (isExpense not set)';
      }
      
      entries.push(entryDetails);
    }
    
    res.json({
      ok: true,
      period: { year, month, startDate, endDate },
      summary: {
        totalEntries: snapshot.size,
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netCashFlow: Math.round((totalIncome - totalExpenses) * 100) / 100
      },
      entries: entries.sort((a, b) => a.date.localeCompare(b.date))
    });
  } catch (error) {
    console.error('[Bookkeeping] Debug month error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Get cashflow trend (last N months)
 */
router.get('/cashflow-trend', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const months = parseInt(req.query.months) || 6;
    const { propertyId, startDate, endDate } = req.query;
    const parsedStartDate = parseDateOnly(startDate);
    const parsedEndDate = parseDateOnly(endDate);
    const hasExplicitWindow = Boolean(
      parsedStartDate
      && parsedEndDate
      && parsedStartDate.getTime() <= parsedEndDate.getTime(),
    );
    const canonicalStartDate = hasExplicitWindow
      ? String(startDate).slice(0, 10)
      : new Date(new Date().getFullYear(), new Date().getMonth() - Math.max(months, 1) - 1, 1).toISOString().slice(0, 10);
    const trendOptions = hasExplicitWindow
      ? { startDate: canonicalStartDate, endDate: String(endDate).slice(0, 10) }
      : {};

    const { entries } = await loadCanonicalLedgerEntriesForScope({
      userId,
      propertyId: propertyId || null,
      startDate: canonicalStartDate,
      endDate: hasExplicitWindow ? String(endDate).slice(0, 10) : null,
      limit: 10000
    ,
      errorLabel: 'cashflow trend',
    });
    return res.json({ ok: true, trend: buildCanonicalCashflowTrend(entries || [], months, trendOptions) });

    if (shouldUseCanonicalLedger(canonicalEntries) && !debug) {
      return res.json({ ok: true, trend: buildCanonicalCashflowTrend(canonicalEntries.entries || [], months) });
    }
    
    const entriesRef = getJournalEntriesRef(userId);
    const accountsRef = getAccountsRef(userId);
    const accountsSnap = await accountsRef.get();
    const accountMap = new Map(accountsSnap.docs.map(d => [d.id, d.data()]));
    
    const trend = [];
    const today = new Date();
    
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const startDate = `${month}-01`;
      const endDate = new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0];
      
      const snapshot = await entriesRef
        .where('entryDate', '>=', startDate)
        .where('entryDate', '<=', endDate)
        .get();
      
      let income = 0;
      let expenses = 0;
      const debugEntries = [];
      
      // Use isExpense flag to determine income vs expenses (same as breakdown logic)
      for (const doc of snapshot.docs) {
        const entry = doc.data();
        if (!matchesPropertyScope(entry, propertyId)) continue;
        const amount = Math.abs(entry.totalCredits || entry.totalDebits || 0);
        
        // Log February entries for debugging
        if (date.getMonth() === 1) { // February is month 1 (0-indexed)
          console.log(`[Cashflow Debug] ${entry.entryDate}: ${entry.memo} | $${amount} | isExpense=${entry.isExpense}`);
        }
        
        if (entry.isExpense === false) {
          // Income
          income += amount;
          if (debug) debugEntries.push({ type: 'income', memo: entry.memo, amount, date: entry.entryDate });
        } else if (entry.isExpense === true) {
          // Expense
          expenses += amount;
          if (debug) debugEntries.push({ type: 'expense', memo: entry.memo, amount, date: entry.entryDate });
        } else {
          // isExpense is undefined - log for debugging
          console.log(`[Cashflow Warning] Entry missing isExpense flag: ${entry.memo} | $${amount}`);
          if (debug) debugEntries.push({ type: 'unknown', memo: entry.memo, amount, date: entry.entryDate, isExpense: entry.isExpense });
        }
      }
      
      // Log monthly totals for debugging
      if (date.getMonth() === 1) { // February
        console.log(`[Cashflow Debug] February totals: Income=$${income}, Expenses=$${expenses}, Net=$${income - expenses}`);
      }
      
      // Format month name to match SQLite format (e.g., "January" instead of "2026-01")
      const monthName = date.toLocaleString('default', { month: 'long' });
      
      const trendItem = {
        month: monthName,
        year: date.getFullYear(),
        revenue: Math.round(income * 100) / 100,
        income: Math.round(income * 100) / 100,
        expenses: Math.round(expenses * 100) / 100,
        net: Math.round((income - expenses) * 100) / 100,
        net_income: Math.round((income - expenses) * 100) / 100,  // For compatibility
        entryCount: snapshot.size
      };
      
      if (debug) {
        trendItem.debugEntries = debugEntries;
      }
      
      trend.push(trendItem);
    }
    
    res.json({ ok: true, trend });
  } catch (error) {
    console.error('[Bookkeeping] Get cashflow trend error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * Get income breakdown by category
 */
router.get('/income-by-category', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { start, end, propertyId } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: 'start and end dates required' });
    }

    const canonicalEntries = await listLedgerEntriesFromAzure({
      userId,
      startDate: start,
      endDate: end,
      propertyId: propertyId || null,
      limit: 10000
    }).catch((error) => {
      console.error('[Bookkeeping] Canonical income breakdown error:', error);
      return { ok: false, status: 'failed', error: error.message, entries: [] };
    });

    if (shouldUseCanonicalLedger(canonicalEntries)) {
      const incomeByCategory = new Map();

      for (const entry of canonicalEntries.entries || []) {
        if (entry.transactionType !== 'income') {
          continue;
        }

        const categoryName = entry.category || entry.payee || entry.vendor || 'Uncategorized Income';
        const amount = roundCurrency(entry.signedAmount || 0);
        if (!amount) {
          continue;
        }

        const existing = incomeByCategory.get(categoryName) || { category: categoryName, amount: 0, count: 0 };
        existing.amount += amount;
        existing.count += 1;
        incomeByCategory.set(categoryName, existing);
      }

      return res.json({
        ok: true,
        categories: Array.from(incomeByCategory.values())
          .map((category) => ({ ...category, amount: roundCurrency(category.amount) }))
          .sort((left, right) => right.amount - left.amount)
      });
    }
    
    const entriesRef = getJournalEntriesRef(userId);
    
    const snapshot = await entriesRef
      .where('entryDate', '>=', start)
      .where('entryDate', '<=', end)
      .get();
    
    const incomeByCategory = new Map();
    
    console.log('[Income Breakdown] Processing', snapshot.size, 'journal entries for', start, 'to', end);
    
    for (const doc of snapshot.docs) {
      const entry = doc.data();
      if (!matchesPropertyScope(entry, propertyId)) continue;
      
      // Only process income entries (isExpense must be explicitly false)
      if (entry.isExpense !== false) {
        console.log('[Income Breakdown] Skipping entry:', entry.memo, 'isExpense:', entry.isExpense);
        continue;
      }
      
      const amount = Math.abs(entry.totalCredits || entry.totalDebits || 0);
      if (amount <= 0) continue;
      
      console.log('[Income Breakdown] Processing income:', entry.memo, amount);
      
      // Get the revenue account line (the one with Credit that's not Operating Cash)
      const revenueLine = (entry.lines || []).find(l => 
        l.dc === 'C' && l.accountCode !== '1000'
      );
      
      const categoryName = revenueLine?.accountName || entry.payee || 'Uncategorized Income';
      
      const existing = incomeByCategory.get(categoryName) || { category: categoryName, amount: 0, count: 0 };
      existing.amount += amount;
      existing.count += 1;
      incomeByCategory.set(categoryName, existing);
    }
    
    const categories = Array.from(incomeByCategory.values())
      .map(c => ({ ...c, amount: Math.round(c.amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);
    
    res.json({ ok: true, categories });
  } catch (error) {
    console.error('[Bookkeeping] Get income by category error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Get expense breakdown by category
 */
router.get('/expense-breakdown', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { start, end, propertyId } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({ ok: false, error: 'start and end dates required' });
    }

    const { entries } = await loadCanonicalLedgerEntriesForScope({
      userId,
      startDate: start,
      endDate: end,
      propertyId: propertyId || null,
      limit: 10000
    ,
      errorLabel: 'expense breakdown',
    });

    if (entries) {
      const expensesByCategory = new Map();

      for (const entry of entries || []) {
        if (entry.transactionType !== 'expense') {
          continue;
        }

        const categoryName = entry.category || entry.vendor || entry.payee || 'Uncategorized Expenses';
        const amount = roundCurrency(-entry.signedAmount || 0);
        if (!amount) {
          continue;
        }

        const existing = expensesByCategory.get(categoryName) || { category: categoryName, amount: 0, count: 0 };
        existing.amount += amount;
        existing.count += 1;
        expensesByCategory.set(categoryName, existing);
      }

      return res.json({
        ok: true,
        categories: Array.from(expensesByCategory.values())
          .map((category) => ({ ...category, amount: roundCurrency(category.amount) }))
          .sort((left, right) => right.amount - left.amount)
      });
    }
    
    const entriesRef = getJournalEntriesRef(userId);
    
    const snapshot = await entriesRef
      .where('entryDate', '>=', start)
      .where('entryDate', '<=', end)
      .get();
    
    const expensesByCategory = new Map();
    
    console.log('[Expense Breakdown] Processing', snapshot.size, 'journal entries for', start, 'to', end);
    
    for (const doc of snapshot.docs) {
      const entry = doc.data();
      if (!matchesPropertyScope(entry, propertyId)) continue;
      
      // Only process expense entries (isExpense must be explicitly true)
      if (entry.isExpense !== true) {
        console.log('[Expense Breakdown] Skipping entry:', entry.memo, 'isExpense:', entry.isExpense);
        continue;
      }
      
      const amount = Math.abs(entry.totalDebits || entry.totalCredits || 0);
      if (amount <= 0) continue;
      
      console.log('[Expense Breakdown] Processing expense:', entry.memo, amount, 'category:', entry.category);
      
      // Use category field first (from AI categorization), then payee, then account name
      let categoryName = entry.category;
      
      if (!categoryName || categoryName === 'Other Expenses' || categoryName === 'Uncategorized') {
        // Try to get from expense line
        const expenseLine = (entry.lines || []).find(l => 
          l.dc === 'D' && l.accountCode !== '1000'
        );
        categoryName = expenseLine?.accountName || entry.payee || 'Uncategorized Expenses';
      }
      
      const existing = expensesByCategory.get(categoryName) || { category: categoryName, amount: 0, count: 0 };
      existing.amount += amount;
      existing.count += 1;
      expensesByCategory.set(categoryName, existing);
    }
    
    const categories = Array.from(expensesByCategory.values())
      .map(c => ({ ...c, amount: Math.round(c.amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);
    
    res.json({ ok: true, categories });
  } catch (error) {
    console.error('[Bookkeeping] Get expense breakdown error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Canonical helper: clear live Financial Connections transactions from Azure SQL.
 */
function buildFinancialConnectionsSourceEventScope(alias = 'source_event') {
  return `
    ${alias}.user_id = @userId
      AND ${alias}.source_system = 'STRIPE'
      AND ${alias}.source_event_type = 'stripe.financial_connections.transaction'
      AND (@propertyId IS NULL OR ${alias}.property_id = @propertyId)
      AND (@startDate IS NULL OR CAST(${alias}.occurred_at AS DATE) >= @startDate)
      AND (@endDate IS NULL OR CAST(${alias}.occurred_at AS DATE) <= @endDate)
  `;
}

function createFinancialConnectionsClearRequest(connection, sql, scope) {
  const request = connection.request();
  request.input('userId', sql.NVarChar(128), scope.userId);
  request.input('propertyId', sql.NVarChar(128), scope.propertyId || null);
  request.input('startDate', sql.Date, scope.startDate || null);
  request.input('endDate', sql.Date, scope.endDate || null);
  return request;
}

function getAffectedRowCount(result) {
  return Array.isArray(result?.rowsAffected)
    ? result.rowsAffected.reduce((sum, count) => sum + Number(count || 0), 0)
    : 0;
}

async function clearLiveFinancialConnectionsTransactionsFromAzure({
  userId,
  propertyId = null,
  startDate = null,
  endDate = null,
} = {}) {
  if (!userId) {
    throw new Error('userId is required to clear live Financial Connections transactions.');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: false,
      status: 'not_configured',
      error: 'Azure SQL is not configured for canonical live-transaction cleanup.',
    };
  }

  const normalizedPropertyId = String(propertyId || '').trim() || null;
  const parsedStartDate = startDate ? parseDateOnly(startDate) : null;
  const parsedEndDate = endDate ? parseDateOnly(endDate) : null;

  if (startDate && !parsedStartDate) {
    throw new Error('startDate must be a valid YYYY-MM-DD value.');
  }

  if (endDate && !parsedEndDate) {
    throw new Error('endDate must be a valid YYYY-MM-DD value.');
  }

  if (parsedStartDate && parsedEndDate && parsedStartDate > parsedEndDate) {
    throw new Error('startDate must be on or before endDate.');
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const transaction = new sql.Transaction(pool);
  const scope = {
    userId,
    propertyId: normalizedPropertyId,
    startDate: parsedStartDate,
    endDate: parsedEndDate,
  };
  const sourceEventWhere = buildFinancialConnectionsSourceEventScope('source_event');
  const sourceRefSubquery = `
    SELECT CONCAT('financial_connections_transaction:', source_event.source_object_id)
    FROM accounting.source_events source_event
    WHERE ${sourceEventWhere}
  `;
  const journalEntryIdSubquery = `
    SELECT journal_entry.journal_entry_id
    FROM accounting.journal_entries journal_entry
    INNER JOIN accounting.finance_events finance_event
      ON finance_event.finance_event_id = journal_entry.finance_event_id
    INNER JOIN accounting.source_events source_event
      ON source_event.source_event_id = finance_event.source_event_id
    WHERE ${sourceEventWhere}
  `;
  const financeEventIdSubquery = `
    SELECT finance_event.finance_event_id
    FROM accounting.finance_events finance_event
    INNER JOIN accounting.source_events source_event
      ON source_event.source_event_id = finance_event.source_event_id
    WHERE ${sourceEventWhere}
  `;
  const sourceEventIdSubquery = `
    SELECT source_event.source_event_id
    FROM accounting.source_events source_event
    WHERE ${sourceEventWhere}
  `;
  const reconciliationItemWhere = `
    reconciliation_item.journal_entry_id IN (${journalEntryIdSubquery})
      OR reconciliation_item.source_ref IN (${sourceRefSubquery})
  `;

  await transaction.begin();

  try {
    const countRequest = createFinancialConnectionsClearRequest(transaction, sql, scope);
    const matchedCounts = (await countRequest.query(`
      SELECT
        (
          SELECT COUNT(1)
          FROM accounting.source_events source_event
          WHERE ${sourceEventWhere}
        ) AS source_event_count,
        (
          SELECT COUNT(1)
          FROM accounting.finance_events finance_event
          INNER JOIN accounting.source_events source_event
            ON source_event.source_event_id = finance_event.source_event_id
          WHERE ${sourceEventWhere}
        ) AS finance_event_count,
        (
          SELECT COUNT(1)
          FROM accounting.journal_entries journal_entry
          INNER JOIN accounting.finance_events finance_event
            ON finance_event.finance_event_id = journal_entry.finance_event_id
          INNER JOIN accounting.source_events source_event
            ON source_event.source_event_id = finance_event.source_event_id
          WHERE ${sourceEventWhere}
        ) AS journal_entry_count,
        (
          SELECT COUNT(1)
          FROM accounting.reconciliation_items reconciliation_item
          WHERE ${reconciliationItemWhere}
        ) AS reconciliation_item_count
    `)).recordset?.[0] || {};

    const totalMatchedTransactions = Number(matchedCounts.source_event_count || 0);
    const deletedCounts = {
      reconciliationItemAuditLogs: 0,
      journalEntryAuditLogs: 0,
      reconciliationItems: 0,
      reconciliationSessions: 0,
      idempotencyKeys: 0,
      subledgerTenant: 0,
      subledgerVendor: 0,
      subledgerSecurityDeposit: 0,
      subledgerOwnerEquity: 0,
      journalLines: 0,
      journalEntries: 0,
      financeEvents: 0,
      sourceEvents: 0,
    };

    if (totalMatchedTransactions === 0 && Number(matchedCounts.reconciliation_item_count || 0) === 0) {
      await transaction.commit();
      return {
        ok: true,
        status: 'cleared',
        clearedTransactions: 0,
        matchedCounts: {
          sourceEvents: 0,
          financeEvents: 0,
          journalEntries: 0,
          reconciliationItems: 0,
        },
        deletedCounts,
        scope: {
          propertyId: normalizedPropertyId,
          startDate: parsedStartDate ? formatDateOnly(parsedStartDate) : null,
          endDate: parsedEndDate ? formatDateOnly(parsedEndDate) : null,
        },
      };
    }

    const deleteStatements = [
      {
        key: 'reconciliationItemAuditLogs',
        sql: `
          DELETE FROM accounting.audit_log
          WHERE entity_type = 'reconciliation_item'
            AND entity_id IN (
              SELECT CAST(reconciliation_item.reconciliation_item_id AS NVARCHAR(255))
              FROM accounting.reconciliation_items reconciliation_item
              WHERE ${reconciliationItemWhere}
            )
        `,
      },
      {
        key: 'journalEntryAuditLogs',
        sql: `
          DELETE FROM accounting.audit_log
          WHERE entity_type = 'journal_entry'
            AND entity_id IN (
              SELECT CAST(journal_entry.journal_entry_id AS NVARCHAR(255))
              FROM accounting.journal_entries journal_entry
              WHERE journal_entry.journal_entry_id IN (${journalEntryIdSubquery})
            )
        `,
      },
      {
        key: 'reconciliationItems',
        sql: `
          DELETE reconciliation_item
          FROM accounting.reconciliation_items reconciliation_item
          WHERE ${reconciliationItemWhere}
        `,
      },
      {
        key: 'reconciliationSessions',
        sql: `
          DELETE FROM accounting.reconciliation_sessions
          WHERE user_id = @userId
            AND (@propertyId IS NULL OR property_id = @propertyId)
            AND reconciliation_scope IN ('stripe_transfer_match', 'cash_movement_review')
            AND NOT EXISTS (
              SELECT 1
              FROM accounting.reconciliation_items reconciliation_item
              WHERE reconciliation_item.reconciliation_session_id = accounting.reconciliation_sessions.reconciliation_session_id
            )
        `,
      },
      {
        key: 'idempotencyKeys',
        sql: `
          DELETE FROM accounting.idempotency_keys
          WHERE source_event_id IN (${sourceEventIdSubquery})
             OR posted_journal_entry_id IN (${journalEntryIdSubquery})
        `,
      },
      {
        key: 'subledgerTenant',
        sql: `
          DELETE FROM accounting.subledger_tenant
          WHERE journal_entry_id IN (${journalEntryIdSubquery})
        `,
      },
      {
        key: 'subledgerVendor',
        sql: `
          DELETE FROM accounting.subledger_vendor
          WHERE journal_entry_id IN (${journalEntryIdSubquery})
        `,
      },
      {
        key: 'subledgerSecurityDeposit',
        sql: `
          DELETE FROM accounting.subledger_security_deposit
          WHERE journal_entry_id IN (${journalEntryIdSubquery})
        `,
      },
      {
        key: 'subledgerOwnerEquity',
        sql: `
          DELETE FROM accounting.subledger_owner_equity
          WHERE journal_entry_id IN (${journalEntryIdSubquery})
        `,
      },
      {
        key: 'journalLines',
        sql: `
          DELETE FROM accounting.journal_lines
          WHERE journal_entry_id IN (${journalEntryIdSubquery})
        `,
      },
      {
        key: 'journalEntries',
        sql: `
          DELETE FROM accounting.journal_entries
          WHERE journal_entry_id IN (${journalEntryIdSubquery})
        `,
      },
      {
        key: 'financeEvents',
        sql: `
          DELETE FROM accounting.finance_events
          WHERE finance_event_id IN (${financeEventIdSubquery})
        `,
      },
      {
        key: 'sourceEvents',
        sql: `
          DELETE FROM accounting.source_events
          WHERE source_event_id IN (${sourceEventIdSubquery})
        `,
      },
    ];

    for (const statement of deleteStatements) {
      const deleteRequest = createFinancialConnectionsClearRequest(transaction, sql, scope);
      const result = await deleteRequest.query(statement.sql);
      deletedCounts[statement.key] = getAffectedRowCount(result);
    }

    await transaction.commit();

    return {
      ok: true,
      status: 'cleared',
      clearedTransactions: totalMatchedTransactions,
      matchedCounts: {
        sourceEvents: totalMatchedTransactions,
        financeEvents: Number(matchedCounts.finance_event_count || 0),
        journalEntries: Number(matchedCounts.journal_entry_count || 0),
        reconciliationItems: Number(matchedCounts.reconciliation_item_count || 0),
      },
      deletedCounts,
      scope: {
        propertyId: normalizedPropertyId,
        startDate: parsedStartDate ? formatDateOnly(parsedStartDate) : null,
        endDate: parsedEndDate ? formatDateOnly(parsedEndDate) : null,
      },
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

/**
 * DELETE /api/bookkeeping/firestore/clear-bank-entries
 * Clear all bank-synced journal entries (for reimporting with corrected logic)
 */
router.delete('/clear-bank-entries', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const canonicalResult = await clearLiveFinancialConnectionsTransactionsFromAzure({ userId });
    const entriesRef = getJournalEntriesRef(userId);
    
    // Find all entries with source = 'STRIPE' or 'BANK'
    const snapshot = await entriesRef
      .where('source', 'in', ['STRIPE', 'BANK'])
      .get();
    
    console.log('[Clear Bank Entries] Found', snapshot.size, 'bank entries to delete');
    
    const batch = getFirestore().batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();

    const canonicalDeleted = canonicalResult.ok ? Number(canonicalResult.clearedTransactions || 0) : 0;
    const legacyDeleted = snapshot.size;
    const totalDeleted = canonicalDeleted || legacyDeleted;
    
    res.json({ 
      ok: true, 
      deleted: totalDeleted,
      deletedCanonicalTransactions: canonicalDeleted,
      deletedLegacyEntries: legacyDeleted,
      canonical: canonicalResult.ok ? canonicalResult : undefined,
      message: canonicalDeleted > 0
        ? `Deleted ${canonicalDeleted} live Financial Connections transaction${canonicalDeleted === 1 ? '' : 's'} from the canonical ledger${legacyDeleted > 0 ? ` and ${legacyDeleted} legacy Firestore entr${legacyDeleted === 1 ? 'y' : 'ies'}` : ''}. You can now resync.`
        : `Deleted ${legacyDeleted} legacy bank-synced entr${legacyDeleted === 1 ? 'y' : 'ies'}. You can now resync.`
    });
  } catch (error) {
    console.error('[Bookkeeping] Clear bank entries error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/bookkeeping/firestore/clear-live-transactions
 * Clear canonical live Financial Connections activity for a specific date window.
 */
router.delete('/clear-live-transactions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { startDate, endDate, propertyId } = req.body || {};
    const result = await clearLiveFinancialConnectionsTransactionsFromAzure({
      userId,
      startDate,
      endDate,
      propertyId,
    });

    if (!result.ok && result.status === 'not_configured') {
      return res.status(503).json(result);
    }

    const scopeLabel = result.scope?.startDate || result.scope?.endDate
      ? `${result.scope?.startDate || 'the beginning'} to ${result.scope?.endDate || 'today'}`
      : 'the full live-import history';

    res.json({
      ...result,
      deleted: result.clearedTransactions || 0,
      message: `Cleared ${result.clearedTransactions || 0} live Financial Connections transaction${result.clearedTransactions === 1 ? '' : 's'} for ${scopeLabel}.`,
    });
  } catch (error) {
    console.error('[Bookkeeping] Clear live transactions error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Get upcoming bills (recurring expenses due soon)
 */
router.get('/upcoming-bills', requireAuth, async (req, res) => {
  try {
    // For now return empty - this would integrate with recurring transactions
    res.json({ ok: true, upcomingBills: [] });
  } catch (error) {
    console.error('[Bookkeeping] Get upcoming bills error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// Journal Entry CRUD
// ============================================================================

/**
 * GET /journal-entries - List journal entries (double-entry format)
 * Used by DoubleEntryBookkeeping journals tab
 */
router.get('/journal-entries', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { limit: limitParam, startDate, endDate, propertyId } = req.query;

    const canonicalEntries = await listLedgerEntriesFromAzure({
      userId,
      startDate: startDate || null,
      endDate: endDate || null,
      propertyId: propertyId || null,
      limit: limitParam ? Math.max(50, parseInt(limitParam, 10) || 50) : 5000
    }).catch((error) => {
      console.error('[Bookkeeping] Canonical journal entries error:', error);
      return { ok: false, status: 'failed', error: error.message, entries: [] };
    });

    if (shouldUseCanonicalLedger(canonicalEntries)) {
      const journal_entries = (canonicalEntries.entries || []).map((entry) => ({
        id: entry.id,
        entry_date: entry.entryDate,
        memo: entry.memo,
        source: entry.sourceSystem || 'MANUAL',
        line_count: (entry.lines || []).length,
        total_debits: roundCurrency(entry.totalDebits || 0),
        property_id: entry.propertyId || null
      }));

      return res.json({ ok: true, journal_entries });
    }

    const entriesRef = getJournalEntriesRef(userId);
    let query = entriesRef.orderBy('entryDate', 'desc');

    if (startDate) query = query.where('entryDate', '>=', startDate);
    if (endDate) query = query.where('entryDate', '<=', endDate);
    const snapshot = await query.get();
    const journal_entries = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((entry) => matchesPropertyScope(entry, propertyId))
      .slice(0, limitParam ? (parseInt(limitParam) || 50) : Number.MAX_SAFE_INTEGER)
      .map((d) => ({
        id: d.id,
        entry_date: d.entryDate,
        memo: d.memo,
        source: d.source || 'MANUAL',
        line_count: (d.lines || []).length,
        total_debits: d.totalDebits || 0,
        property_id: d.propertyId || null,
      }));

    res.json({ ok: true, journal_entries });
  } catch (error) {
    console.error('[Bookkeeping] Get journal entries error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /journal-entries/:id - Journal entry detail with lines
 */
router.get('/journal-entries/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const canonicalEntries = await listLedgerEntriesFromAzure({ userId, limit: 10000 }).catch((error) => {
      console.error('[Bookkeeping] Canonical journal entry detail error:', error);
      return { ok: false, status: 'failed', error: error.message, entries: [] };
    });

    if (shouldUseCanonicalLedger(canonicalEntries)) {
      const canonicalEntry = (canonicalEntries.entries || []).find((entry) => entry.id === req.params.id);
      if (canonicalEntry) {
        return res.json({
          ok: true,
          journal_entry: {
            id: canonicalEntry.id,
            entry_date: canonicalEntry.entryDate,
            memo: canonicalEntry.memo,
            source: canonicalEntry.sourceSystem || 'MANUAL',
            lines: (canonicalEntry.lines || []).map((line, index) => ({
              id: index,
              account_code: line.accountCode,
              account_name: line.accountName || line.accountCode,
              amount: line.amount,
              dc: line.dc,
              memo: line.memo || '',
              property_name: line.propertyId || null
            })),
            total_debits: roundCurrency(canonicalEntry.totalDebits || 0),
            total_credits: roundCurrency(canonicalEntry.totalCredits || 0)
          }
        });
      }
    }

    const doc = await getJournalEntriesRef(userId).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Journal entry not found' });

    const d = doc.data();
    const lines = (d.lines || []).map((line, idx) => ({
      id: idx,
      account_code: line.accountCode,
      account_name: line.accountName || line.accountCode,
      amount: line.amount,
      dc: line.dc,
      memo: line.memo || '',
      property_name: line.propertyId || null
    }));

    res.json({
      ok: true,
      journal_entry: {
        id: doc.id,
        entry_date: d.entryDate,
        memo: d.memo,
        source: d.source || 'MANUAL',
        lines,
        total_debits: d.totalDebits || 0,
        total_credits: d.totalCredits || 0
      }
    });
  } catch (error) {
    console.error('[Bookkeeping] Get journal entry detail error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// Financial Reports (Firestore-backed)
// ============================================================================

/**
 * GET /reports/trial-balance - Computed from account balances
 */
router.get('/reports/trial-balance', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId, as_of: asOfDate } = req.query;
    const canonicalAccounts = await listLedgerAccountsFromAzure({ userId }).catch((error) => {
      console.error('[Bookkeeping] Canonical trial balance accounts error:', error);
      return { ok: false, status: 'failed', error: error.message, accounts: [] };
    });

    const readyCanonicalTrialBalanceAccounts = requireCanonicalLedgerResult(canonicalAccounts, 'trial balance accounts');
    let canonicalScopedAccounts = readyCanonicalTrialBalanceAccounts.accounts || [];

    if (propertyId) {
      const propertyScopedCanonicalEntries = await loadCanonicalLedgerEntriesForScope({
        userId,
        endDate: asOfDate || null,
        propertyId: propertyId || null,
        limit: 10000,
        errorLabel: 'property-scoped trial balance entries',
      });

      canonicalScopedAccounts = buildAccountBalancesFromEntries(
        propertyScopedCanonicalEntries.entries || [],
        readyCanonicalTrialBalanceAccounts.accounts || [],
        propertyScopedCanonicalEntries.requestedPropertyId || propertyId || null,
      );
    }

    const canonicalTrialBalance = buildTrialBalanceFromAccounts(canonicalScopedAccounts);
    return res.json({
      ok: true,
      as_of_date: asOfDate || new Date().toISOString().split('T')[0],
      accounts: canonicalTrialBalance.accounts,
      total_debits: canonicalTrialBalance.totalDebits,
      total_credits: canonicalTrialBalance.totalCredits,
      is_balanced: canonicalTrialBalance.isBalanced
    });

    if (shouldUseCanonicalLedger(canonicalAccounts)) {
      let scopedAccounts = canonicalAccounts.accounts || [];

      if (propertyId) {
        const canonicalEntries = await listLedgerEntriesFromAzure({
          userId,
          endDate: asOfDate || null,
          propertyId: propertyId || null,
          limit: 10000,
        }).catch((error) => {
          console.error('[Bookkeeping] Canonical property-scoped trial balance entries error:', error);
          return { ok: false, status: 'failed', error: error.message, entries: [] };
        });

        scopedAccounts = buildAccountBalancesFromEntries(
          canonicalEntries.entries || [],
          canonicalAccounts.accounts || [],
          propertyId || null,
        );
      }

      const trialBalance = buildTrialBalanceFromAccounts(scopedAccounts);
      return res.json({
        ok: true,
        as_of_date: asOfDate || new Date().toISOString().split('T')[0],
        accounts: trialBalance.accounts,
        total_debits: trialBalance.totalDebits,
        total_credits: trialBalance.totalCredits,
        is_balanced: trialBalance.isBalanced
      });
    }

    const accountsRef = getAccountsRef(userId);
    const snapshot = await accountsRef.where('isActive', '==', true).orderBy('code').get();
    const accountRows = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        code: data.code,
        name: data.name,
        type: data.type,
        balance: Number(data.balance || 0),
      };
    });

    const scopedAccounts = propertyId
      ? buildAccountBalancesFromEntries(
          (await getJournalEntriesRef(userId)
            .where('entryDate', '<=', asOfDate || new Date().toISOString().split('T')[0])
            .get()).docs.map((doc) => doc.data()),
          accountRows,
          propertyId || null,
        )
      : accountRows;
    const trialBalance = buildTrialBalanceFromAccounts(scopedAccounts);

    res.json({
      ok: true,
      as_of_date: asOfDate || new Date().toISOString().split('T')[0],
      accounts: trialBalance.accounts,
      total_debits: trialBalance.totalDebits,
      total_credits: trialBalance.totalCredits,
      is_balanced: trialBalance.isBalanced
    });
  } catch (error) {
    console.error('[Bookkeeping] Trial balance error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /reports/profit-loss - P&L from journal lines in date range
 */
router.get('/reports/profit-loss', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { start, end, propertyId } = req.query;

    const { entries } = await loadCanonicalLedgerEntriesForScope({
      userId,
      startDate: start || null,
      endDate: end || null,
      propertyId: propertyId || null,
      limit: 10000
    ,
      errorLabel: 'profit and loss',
    });
    const canonicalProfitLoss = buildProfitLossFromEntries(entries || []);
    return res.json({
      ok: true,
      period: { start: start || null, end: end || null },
      revenues: canonicalProfitLoss.revenues.map((row) => ({
        code: row.code,
        name: row.name,
        amount: row.amount,
        tax_map: row.scheduleELine ? `Schedule E Line ${row.scheduleELine}` : null
      })),
      expenses: canonicalProfitLoss.expenses.map((row) => ({
        code: row.code,
        name: row.name,
        amount: row.amount,
        tax_map: row.scheduleELine ? `Schedule E Line ${row.scheduleELine}` : null
      })),
      summary: {
        total_revenue: canonicalProfitLoss.totalRevenue,
        total_expenses: canonicalProfitLoss.totalExpenses,
        net_income: canonicalProfitLoss.netIncome
      }
    });

    if (shouldUseCanonicalLedger(canonicalEntries)) {
      const profitLoss = buildProfitLossFromEntries(canonicalEntries.entries || []);
      return res.json({
        ok: true,
        period: { start: start || null, end: end || null },
        revenues: profitLoss.revenues.map((row) => ({
          code: row.code,
          name: row.name,
          amount: row.amount,
          tax_map: row.scheduleELine ? `Schedule E Line ${row.scheduleELine}` : null
        })),
        expenses: profitLoss.expenses.map((row) => ({
          code: row.code,
          name: row.name,
          amount: row.amount,
          tax_map: row.scheduleELine ? `Schedule E Line ${row.scheduleELine}` : null
        })),
        summary: {
          total_revenue: profitLoss.totalRevenue,
          total_expenses: profitLoss.totalExpenses,
          net_income: profitLoss.netIncome
        }
      });
    }

    const entriesRef = getJournalEntriesRef(userId);
    const accountsRef = getAccountsRef(userId);

    // Get all entries in the date range
    let query = entriesRef;
    if (start) query = query.where('entryDate', '>=', start);
    if (end) query = query.where('entryDate', '<=', end);
    const snapshot = await query.get();

    // Accumulate amounts per account from journal lines
    const accountTotals = {};
    snapshot.docs.forEach(doc => {
      const entry = doc.data();
      if (!matchesPropertyScope(entry, propertyId)) return;
      (entry.lines || []).forEach(line => {
        const code = line.accountCode;
        if (!code) return;
        if (!accountTotals[code]) accountTotals[code] = { debits: 0, credits: 0 };
        if (line.dc === 'D') accountTotals[code].debits += line.amount;
        else accountTotals[code].credits += line.amount;
      });
    });

    // Get account metadata
    const acctSnap = await accountsRef.get();
    const acctMap = {};
    acctSnap.docs.forEach(doc => { acctMap[doc.data().code] = doc.data(); });

    const revenues = [];
    const expenses = [];
    let total_revenue = 0;
    let total_expenses = 0;

    for (const [code, totals] of Object.entries(accountTotals)) {
      const acct = acctMap[code];
      if (!acct) continue;
      if (acct.type === 'REVENUE') {
        const amount = totals.credits - totals.debits;
        revenues.push({ code, name: acct.name, amount: Math.round(amount * 100) / 100, tax_map: acct.scheduleELine ? `Schedule E Line ${acct.scheduleELine}` : null });
        total_revenue += amount;
      }
      if (acct.type === 'EXPENSE') {
        const amount = totals.debits - totals.credits;
        expenses.push({ code, name: acct.name, amount: Math.round(amount * 100) / 100, tax_map: acct.scheduleELine ? `Schedule E Line ${acct.scheduleELine}` : null });
        total_expenses += amount;
      }
    }

    res.json({
      ok: true,
      period: { start: start || null, end: end || null },
      revenues: revenues.sort((a, b) => b.amount - a.amount),
      expenses: expenses.sort((a, b) => b.amount - a.amount),
      summary: {
        total_revenue: Math.round(total_revenue * 100) / 100,
        total_expenses: Math.round(total_expenses * 100) / 100,
        net_income: Math.round((total_revenue - total_expenses) * 100) / 100
      }
    });
  } catch (error) {
    console.error('[Bookkeeping] Profit & loss error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /reports/balance-sheet - Grouped by account type
 */
router.get('/reports/balance-sheet', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId, as_of: asOfDate } = req.query;
    const canonicalAccounts = await listLedgerAccountsFromAzure({ userId }).catch((error) => {
      console.error('[Bookkeeping] Canonical balance sheet accounts error:', error);
      return { ok: false, status: 'failed', error: error.message, accounts: [] };
    });

    const readyCanonicalBalanceSheetAccounts = requireCanonicalLedgerResult(canonicalAccounts, 'balance sheet accounts');
    let canonicalScopedAccounts = readyCanonicalBalanceSheetAccounts.accounts || [];

    if (propertyId) {
      const propertyScopedCanonicalEntries = await loadCanonicalLedgerEntriesForScope({
        userId,
        endDate: asOfDate || null,
        propertyId: propertyId || null,
        limit: 10000,
        errorLabel: 'property-scoped balance sheet entries',
      });

      canonicalScopedAccounts = buildAccountBalancesFromEntries(
        propertyScopedCanonicalEntries.entries || [],
        readyCanonicalBalanceSheetAccounts.accounts || [],
        propertyScopedCanonicalEntries.requestedPropertyId || propertyId || null,
      );
    }

    const canonicalAssets = [];
    const canonicalLiabilities = [];
    const canonicalEquity = [];
    let canonicalTotalAssets = 0;
    let canonicalTotalLiabilities = 0;
    let canonicalTotalEquity = 0;

    for (const account of canonicalScopedAccounts) {
      const entry = {
        code: account.code,
        name: account.name,
        balance: roundCurrency(account.balance)
      };

      if (account.type === 'ASSET') {
        canonicalAssets.push(entry);
        canonicalTotalAssets += entry.balance;
      } else if (account.type === 'LIABILITY') {
        canonicalLiabilities.push(entry);
        canonicalTotalLiabilities += entry.balance;
      } else if (account.type === 'EQUITY') {
        canonicalEquity.push(entry);
        canonicalTotalEquity += entry.balance;
      }
    }

    return res.json({
      ok: true,
      as_of_date: asOfDate || new Date().toISOString().split('T')[0],
      assets: canonicalAssets,
      liabilities: canonicalLiabilities,
      equity: canonicalEquity,
      total_assets: roundCurrency(canonicalTotalAssets),
      total_liabilities: roundCurrency(canonicalTotalLiabilities),
      total_equity: roundCurrency(canonicalTotalEquity),
      is_balanced: Math.abs(canonicalTotalAssets - canonicalTotalLiabilities - canonicalTotalEquity) < 0.01
    });

    if (shouldUseCanonicalLedger(canonicalAccounts)) {
      let scopedAccounts = canonicalAccounts.accounts || [];

      if (propertyId) {
        const canonicalEntries = await listLedgerEntriesFromAzure({
          userId,
          endDate: asOfDate || null,
          propertyId: propertyId || null,
          limit: 10000,
        }).catch((error) => {
          console.error('[Bookkeeping] Canonical property-scoped balance sheet entries error:', error);
          return { ok: false, status: 'failed', error: error.message, entries: [] };
        });

        scopedAccounts = buildAccountBalancesFromEntries(
          canonicalEntries.entries || [],
          canonicalAccounts.accounts || [],
          propertyId || null,
        );
      }

      const assets = [];
      const liabilities = [];
      const equity = [];
      let totalAssets = 0;
      let totalLiabilities = 0;
      let totalEquity = 0;

      for (const account of scopedAccounts) {
        const entry = {
          code: account.code,
          name: account.name,
          balance: roundCurrency(account.balance)
        };

        if (account.type === 'ASSET') {
          assets.push(entry);
          totalAssets += entry.balance;
        } else if (account.type === 'LIABILITY') {
          liabilities.push(entry);
          totalLiabilities += entry.balance;
        } else if (account.type === 'EQUITY') {
          equity.push(entry);
          totalEquity += entry.balance;
        }
      }

      return res.json({
        ok: true,
        as_of_date: asOfDate || new Date().toISOString().split('T')[0],
        assets,
        liabilities,
        equity,
        total_assets: roundCurrency(totalAssets),
        total_liabilities: roundCurrency(totalLiabilities),
        total_equity: roundCurrency(totalEquity),
        is_balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01
      });
    }

    const accountsRef = getAccountsRef(userId);
    const snapshot = await accountsRef.where('isActive', '==', true).orderBy('code').get();

    const accountRows = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        code: data.code,
        name: data.name,
        type: data.type,
        balance: Number(data.balance || 0),
      };
    });

    const scopedAccounts = propertyId
      ? buildAccountBalancesFromEntries(
          (await getJournalEntriesRef(userId)
            .where('entryDate', '<=', asOfDate || new Date().toISOString().split('T')[0])
            .get()).docs.map((doc) => doc.data()),
          accountRows,
          propertyId || null,
        )
      : accountRows;

    const assets = [];
    const liabilities = [];
    const equity = [];
    let total_assets = 0;
    let total_liabilities = 0;
    let total_equity = 0;

    scopedAccounts.forEach((account) => {
      const balance = Math.round((account.balance || 0) * 100) / 100;
      const entry = { code: account.code, name: account.name, balance };

      if (account.type === 'ASSET') { assets.push(entry); total_assets += balance; }
      else if (account.type === 'LIABILITY') { liabilities.push(entry); total_liabilities += balance; }
      else if (account.type === 'EQUITY') { equity.push(entry); total_equity += balance; }
    });

    res.json({
      ok: true,
      as_of_date: asOfDate || new Date().toISOString().split('T')[0],
      assets,
      liabilities,
      equity,
      total_assets: Math.round(total_assets * 100) / 100,
      total_liabilities: Math.round(total_liabilities * 100) / 100,
      total_equity: Math.round(total_equity * 100) / 100,
      is_balanced: Math.abs(total_assets - total_liabilities - total_equity) < 0.01
    });
  } catch (error) {
    console.error('[Bookkeeping] Balance sheet error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * Create a journal entry
 */
router.post('/journal-entry', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { entryDate, memo, source, sourceRef, lines, propertyId } = req.body;
    
    if (!entryDate || !memo || !lines || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    
    const result = await createPostedJournalEntry(userId, {
      entryDate,
      memo,
      source: source || 'MANUAL',
      sourceRef: sourceRef || null,
      lines: lines.map((line) => ({
        ...line,
        propertyId: line.propertyId || propertyId || null
      })),
      propertyId: propertyId || null,
      postedBy: req.user.email || req.user.uid
    });

    res.json({
      ok: true,
      journalEntryId: result.journalEntryId,
      totalDebits: result.entry.totalDebits,
      totalCredits: result.entry.totalCredits,
      shadowLedger: result.shadowLedger
    });
  } catch (error) {
    console.error('[Bookkeeping] Create journal entry error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

/**
 * PATCH /api/bookkeeping/firestore/journal-entry/:id
 * Update a journal entry (e.g., with AI categorization)
 */
router.patch('/journal-entry/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { id } = req.params;
    const { category, accountCode, scheduleELine, isExpense } = req.body;

    const result = await reclassifySimpleJournalEntry(
      userId,
      id,
      { category, accountCode, scheduleELine, isExpense },
      req.user.email || req.user.uid
    );

    res.json({ ok: true, id: result.id, status: result.noop ? 'noop' : 'updated', updates: result.updates, shadowLedger: result.shadowLedger });
  } catch (error) {
    console.error('[Bookkeeping] Update journal entry error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/apply-categorizations
 * Batch apply AI categorizations to multiple journal entries
 */
router.post('/apply-categorizations', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { categorizations } = req.body;
    
    if (!categorizations || !Array.isArray(categorizations)) {
      return res.status(400).json({ ok: false, error: 'categorizations array required' });
    }
    
    let updated = 0;
    let unchanged = 0;
    const errors = [];
    
    for (const cat of categorizations) {
      if (!cat.id) continue;

      try {
        const result = await reclassifySimpleJournalEntry(
          userId,
          cat.id,
          {
            category: cat.category,
            accountCode: cat.accountCode,
            scheduleELine: cat.scheduleELine
          },
          req.user.email || req.user.uid
        );
        if (result.noop) {
          unchanged++;
        } else {
          updated++;
        }
      } catch (error) {
        errors.push({
          id: cat.id,
          error: error.message
        });
      }
    }

    res.json({
      ok: errors.length === 0,
      updated,
      unchanged,
      errors
    });
  } catch (error) {
    console.error('[Bookkeeping] Apply categorizations error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// OWNER-SCOPED CATEGORIZATION RULES
// ============================================================================

router.get('/rules', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId } = req.query;
    const snapshot = await getCategorizationRulesRef(userId).get();
    const rules = [];
    snapshot.forEach((doc) => {
      const rule = { id: doc.id, ...doc.data() };
      if (rule.isActive === false) {
        return;
      }
      if (propertyId && rule.propertyId && String(rule.propertyId) !== String(propertyId)) {
        return;
      }
      rules.push(rule);
    });

    const accountCodes = Array.from(new Set(rules.map((rule) => String(rule.accountCode || '')).filter(Boolean)));
    const accountRecords = await Promise.all(accountCodes.map((accountCode) => getBookkeepingAccountRecord(userId, accountCode)));
    const accountNames = new Map(accountCodes.map((accountCode, index) => [accountCode, accountRecords[index]?.name || null]));

    const enrichedRules = rules
      .map((rule) => ({
        ...rule,
        matchType: normalizeRuleMatchType(rule.matchType) || rule.matchType,
        accountName: accountNames.get(String(rule.accountCode || '')) || null,
      }))
      .sort((left, right) => Number(left.priority || 100) - Number(right.priority || 100) || String(left.ruleName || '').localeCompare(String(right.ruleName || '')));

    res.json({ ok: true, rules: enrichedRules, count: enrichedRules.length });
  } catch (error) {
    console.error('[Categorization] Error getting rules:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/rules', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { ruleName, matchType, matchPattern, accountCode, priority, propertyId } = req.body;
    const normalizedMatchType = normalizeRuleMatchType(matchType);
    const normalizedRuleName = String(ruleName || '').trim();
    const normalizedPattern = String(matchPattern || '').trim();
    const normalizedAccountCode = String(accountCode || '').trim();

    if (!normalizedRuleName || !normalizedMatchType || !normalizedPattern || !normalizedAccountCode) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: ruleName, matchType, matchPattern, accountCode',
      });
    }

    const accountRecord = await getBookkeepingAccountRecord(userId, normalizedAccountCode);
    if (!accountRecord) {
      return res.status(400).json({ ok: false, error: `Account ${normalizedAccountCode} not found` });
    }

    if (!['EXPENSE', 'REVENUE'].includes(String(accountRecord.type || '').toUpperCase())) {
      return res.status(400).json({ ok: false, error: 'Categorization rules currently support revenue and expense accounts only' });
    }

    const now = new Date().toISOString();
    const ruleData = {
      ruleName: normalizedRuleName,
      matchType: normalizedMatchType,
      matchPattern: normalizedPattern,
      accountCode: normalizedAccountCode,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 100,
      propertyId: propertyId || null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.email || req.user.uid,
    };

    const docRef = await getCategorizationRulesRef(userId).add(ruleData);
    res.json({
      ok: true,
      ruleId: docRef.id,
      rule: {
        id: docRef.id,
        ...ruleData,
        accountName: accountRecord.name || null,
      },
    });
  } catch (error) {
    console.error('[Categorization] Error creating rule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.delete('/rules/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { id } = req.params;
    const docRef = getCategorizationRulesRef(userId).doc(id);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ ok: false, error: 'Rule not found' });
    }

    await docRef.update({
      isActive: false,
      updatedAt: new Date().toISOString(),
      deletedBy: req.user.email || req.user.uid,
    });

    res.json({ ok: true, deactivated: true });
  } catch (error) {
    console.error('[Categorization] Error deactivating rule:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/categorize/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, propertyId } = req.query;
    const activeRulesSnapshot = await getCategorizationRulesRef(userId).get();
    const activeRules = [];
    activeRulesSnapshot.forEach((doc) => {
      const rule = { id: doc.id, ...doc.data() };
      if (rule.isActive !== false) {
        activeRules.push(rule);
      }
    });

    const candidates = await listCategorizationRuleCandidates(userId, {
      year: year || new Date().getFullYear(),
      propertyId: propertyId || null,
      limit: 500,
    });

    const rulesByTypeMap = new Map();
    for (const rule of activeRules) {
      const matchType = normalizeRuleMatchType(rule.matchType) || 'UNKNOWN';
      rulesByTypeMap.set(matchType, (rulesByTypeMap.get(matchType) || 0) + 1);
    }

    const topMatchingRules = activeRules
      .map((rule) => ({
        ruleId: rule.id,
        ruleName: rule.ruleName,
        matchType: normalizeRuleMatchType(rule.matchType) || rule.matchType || 'UNKNOWN',
        matchCount: candidates.filter((candidate) => doesCategorizationRuleMatch(rule, candidate)).length,
      }))
      .filter((rule) => rule.matchCount > 0)
      .sort((left, right) => right.matchCount - left.matchCount || String(left.ruleName || '').localeCompare(String(right.ruleName || '')))
      .slice(0, 10);

    res.json({
      ok: true,
      totalActiveRules: activeRules.length,
      rulesByType: Array.from(rulesByTypeMap.entries()).map(([matchType, count]) => ({ matchType, count })),
      topMatchingRules,
      totalCandidates: candidates.length,
      reviewCandidates: candidates.filter(transactionNeedsRuleReview).length,
    });
  } catch (error) {
    console.error('[Categorization] Error getting stats:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/categorize/bulk', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, propertyId, limit, dryRun } = req.body || {};
    const rulesSnapshot = await getCategorizationRulesRef(userId).get();
    const rules = [];
    rulesSnapshot.forEach((doc) => {
      const rule = { id: doc.id, ...doc.data() };
      if (rule.isActive !== false) {
        rules.push(rule);
      }
    });
    rules.sort((left, right) => Number(left.priority || 100) - Number(right.priority || 100));

    const accountCodes = Array.from(new Set(rules.map((rule) => String(rule.accountCode || '')).filter(Boolean)));
    const accountRecords = await Promise.all(accountCodes.map((accountCode) => getBookkeepingAccountRecord(userId, accountCode)));
    const accountMap = new Map(accountCodes.map((accountCode, index) => [accountCode, accountRecords[index] || null]));

    const candidates = await listCategorizationRuleCandidates(userId, {
      year: year || new Date().getFullYear(),
      propertyId: propertyId || null,
      limit: limit || 100,
    });

    let matched = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    const results = [];
    const errors = [];

    for (const candidate of candidates) {
      const matchedRule = rules.find((rule) => doesCategorizationRuleMatch(rule, candidate));
      if (!matchedRule) {
        continue;
      }

      matched += 1;
      const accountRecord = accountMap.get(String(matchedRule.accountCode || ''));
      if (!accountRecord) {
        skipped += 1;
        if (errors.length < 25) {
          errors.push({ id: candidate.id, error: `Account ${matchedRule.accountCode} is not available for rule ${matchedRule.ruleName}` });
        }
        continue;
      }

      const transactionType = candidate.type || (candidate.isExpense ? 'expense' : 'income');
      const accountType = String(accountRecord.type || '').toUpperCase();
      if ((transactionType === 'expense' && accountType !== 'EXPENSE') || (transactionType === 'income' && accountType !== 'REVENUE')) {
        skipped += 1;
        results.push({
          id: candidate.id,
          ruleId: matchedRule.id,
          ruleName: matchedRule.ruleName,
          status: 'skipped',
          reason: `Rule account ${matchedRule.accountCode} is not compatible with this ${transactionType} entry.`,
        });
        continue;
      }

      if (candidate.accountCode === matchedRule.accountCode) {
        unchanged += 1;
        results.push({
          id: candidate.id,
          ruleId: matchedRule.id,
          ruleName: matchedRule.ruleName,
          status: 'unchanged',
          reason: 'Ledger account already matches the rule target.',
        });
        continue;
      }

      if (dryRun) {
        updated += 1;
        results.push({
          id: candidate.id,
          ruleId: matchedRule.id,
          ruleName: matchedRule.ruleName,
          status: 'preview',
          category: getCanonicalCategoryNameForAccountCode(matchedRule.accountCode, accountRecord.name || candidate.category || 'Other Expenses'),
          accountCode: matchedRule.accountCode,
          scheduleELine: SCHEDULE_E_LINE_BY_ACCOUNT_CODE.get(String(matchedRule.accountCode || '')) || null,
        });
        continue;
      }

      try {
        const mutation = await reclassifySimpleJournalEntry(
          userId,
          candidate.id,
          {
            category: getCanonicalCategoryNameForAccountCode(matchedRule.accountCode, accountRecord.name || candidate.category || 'Other Expenses'),
            accountCode: matchedRule.accountCode,
            scheduleELine: SCHEDULE_E_LINE_BY_ACCOUNT_CODE.get(String(matchedRule.accountCode || '')) || null,
            isExpense: transactionType === 'expense',
          },
          req.user.email || req.user.uid,
        );

        if (mutation.noop) {
          unchanged += 1;
          results.push({ id: candidate.id, ruleId: matchedRule.id, ruleName: matchedRule.ruleName, status: 'unchanged' });
        } else {
          updated += 1;
          results.push({ id: candidate.id, ruleId: matchedRule.id, ruleName: matchedRule.ruleName, status: 'updated' });
        }
      } catch (error) {
        skipped += 1;
        if (errors.length < 25) {
          errors.push({ id: candidate.id, error: error.message });
        }
      }
    }

    res.json({
      ok: errors.length === 0,
      totalCandidates: candidates.length,
      matched,
      updated,
      unchanged,
      skipped,
      results,
      errors,
    });
  } catch (error) {
    console.error('[Categorization] Error bulk categorizing:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// OWNER-SCOPED RECURRING JOURNAL TEMPLATES
// ============================================================================

router.get('/recurring', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId, isActive } = req.query;
    const activeFilter = isActive === 'false' ? false : isActive === 'all' ? null : true;
    const snapshot = await getRecurringTransactionsRef(userId).get();
    const templates = [];
    snapshot.forEach((doc) => {
      const template = { id: doc.id, ...doc.data() };
      if (activeFilter !== null && Boolean(template.isActive !== false) !== activeFilter) {
        return;
      }
      if (propertyId && String(template.propertyId || '') !== String(propertyId)) {
        return;
      }
      templates.push(template);
    });

    const accountCodes = Array.from(new Set(templates.flatMap((template) => [template.accountCode, template.offsetAccountCode]).filter(Boolean).map((code) => String(code))));
    const accountRecords = await Promise.all(accountCodes.map((accountCode) => getBookkeepingAccountRecord(userId, accountCode)));
    const accountMap = new Map(accountCodes.map((accountCode, index) => [accountCode, accountRecords[index] || null]));

    const enrichedTemplates = templates
      .map((template) => ({
        ...template,
        amount: roundCurrency(template.amount || 0),
        accountName: accountMap.get(String(template.accountCode || ''))?.name || null,
        offsetAccountName: accountMap.get(String(template.offsetAccountCode || ''))?.name || null,
      }))
      .sort((left, right) => String(left.nextDue || '').localeCompare(String(right.nextDue || '')) || String(left.name || '').localeCompare(String(right.name || '')));

    res.json({ ok: true, transactions: enrichedTemplates, count: enrichedTemplates.length });
  } catch (error) {
    console.error('[Recurring] Error getting transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/recurring', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      name,
      frequency,
      amount,
      accountCode,
      offsetAccountCode,
      memo,
      dayOfMonth,
      startDate,
      endDate,
      propertyId,
      tenantId,
    } = req.body;

    const normalizedFrequency = normalizeRecurringFrequency(frequency);
    const normalizedName = String(name || '').trim();
    const normalizedAccountCode = String(accountCode || '').trim();
    const normalizedOffsetAccountCode = String(offsetAccountCode || '').trim();
    const normalizedAmount = roundCurrency(amount || 0);
    const normalizedDayOfMonth = Math.min(31, Math.max(1, Number(dayOfMonth || 1) || 1));

    if (!normalizedName || !normalizedFrequency || !normalizedAccountCode || !normalizedOffsetAccountCode || !startDate || normalizedAmount <= 0) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: name, frequency, amount, accountCode, offsetAccountCode, startDate' });
    }

    const accountRecord = await getBookkeepingAccountRecord(userId, normalizedAccountCode);
    const offsetAccountRecord = await getBookkeepingAccountRecord(userId, normalizedOffsetAccountCode);
    if (!accountRecord) {
      return res.status(400).json({ ok: false, error: `Account ${normalizedAccountCode} not found` });
    }
    if (!offsetAccountRecord) {
      return res.status(400).json({ ok: false, error: `Offset account ${normalizedOffsetAccountCode} not found` });
    }
    if (!['EXPENSE', 'REVENUE'].includes(String(accountRecord.type || '').toUpperCase())) {
      return res.status(400).json({ ok: false, error: 'Recurring journal templates currently support revenue and expense accounts only' });
    }

    const nextDue = calculateNextRecurringDueDate(startDate, normalizedFrequency, normalizedDayOfMonth);
    if (!nextDue) {
      return res.status(400).json({ ok: false, error: 'Unable to calculate the next due date for this recurring template' });
    }

    const now = new Date().toISOString();
    const templateData = {
      name: normalizedName,
      frequency: normalizedFrequency,
      amount: normalizedAmount,
      accountCode: normalizedAccountCode,
      offsetAccountCode: normalizedOffsetAccountCode,
      memo: String(memo || normalizedName).trim(),
      dayOfMonth: normalizedDayOfMonth,
      startDate: String(startDate).slice(0, 10),
      endDate: endDate ? String(endDate).slice(0, 10) : null,
      propertyId: propertyId || null,
      tenantId: tenantId || null,
      lastGenerated: null,
      nextDue,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.email || req.user.uid,
    };

    const docRef = await getRecurringTransactionsRef(userId).add(templateData);
    res.json({
      ok: true,
      transaction: {
        id: docRef.id,
        ...templateData,
        accountName: accountRecord.name || null,
        offsetAccountName: offsetAccountRecord.name || null,
      },
    });
  } catch (error) {
    console.error('[Recurring] Error creating transaction:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.put('/recurring/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { id } = req.params;
    const docRef = getRecurringTransactionsRef(userId).doc(id);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ ok: false, error: 'Recurring template not found' });
    }

    const existing = snapshot.data() || {};
    const nextTemplate = {
      ...existing,
      ...req.body,
      accountCode: req.body.accountCode ? String(req.body.accountCode).trim() : existing.accountCode,
      offsetAccountCode: req.body.offsetAccountCode ? String(req.body.offsetAccountCode).trim() : existing.offsetAccountCode,
      frequency: req.body.frequency ? normalizeRecurringFrequency(req.body.frequency) : existing.frequency,
      dayOfMonth: Object.prototype.hasOwnProperty.call(req.body, 'dayOfMonth') ? Math.min(31, Math.max(1, Number(req.body.dayOfMonth || 1) || 1)) : existing.dayOfMonth,
      amount: Object.prototype.hasOwnProperty.call(req.body, 'amount') ? roundCurrency(req.body.amount || 0) : existing.amount,
      startDate: req.body.startDate ? String(req.body.startDate).slice(0, 10) : existing.startDate,
      endDate: Object.prototype.hasOwnProperty.call(req.body, 'endDate') ? (req.body.endDate ? String(req.body.endDate).slice(0, 10) : null) : existing.endDate,
      propertyId: Object.prototype.hasOwnProperty.call(req.body, 'propertyId') ? (req.body.propertyId || null) : existing.propertyId,
      tenantId: Object.prototype.hasOwnProperty.call(req.body, 'tenantId') ? (req.body.tenantId || null) : existing.tenantId,
      memo: Object.prototype.hasOwnProperty.call(req.body, 'memo') ? String(req.body.memo || existing.name || '').trim() : existing.memo,
      isActive: Object.prototype.hasOwnProperty.call(req.body, 'isActive') ? Boolean(req.body.isActive) : existing.isActive !== false,
      name: Object.prototype.hasOwnProperty.call(req.body, 'name') ? String(req.body.name || '').trim() : existing.name,
    };

    if (!nextTemplate.name || !nextTemplate.frequency || !nextTemplate.accountCode || !nextTemplate.offsetAccountCode || !nextTemplate.startDate || nextTemplate.amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Recurring template update is missing required values' });
    }

    const accountRecord = await getBookkeepingAccountRecord(userId, nextTemplate.accountCode);
    const offsetAccountRecord = await getBookkeepingAccountRecord(userId, nextTemplate.offsetAccountCode);
    if (!accountRecord) {
      return res.status(400).json({ ok: false, error: `Account ${nextTemplate.accountCode} not found` });
    }
    if (!offsetAccountRecord) {
      return res.status(400).json({ ok: false, error: `Offset account ${nextTemplate.offsetAccountCode} not found` });
    }
    if (!['EXPENSE', 'REVENUE'].includes(String(accountRecord.type || '').toUpperCase())) {
      return res.status(400).json({ ok: false, error: 'Recurring journal templates currently support revenue and expense accounts only' });
    }

    const scheduleChanged = ['frequency', 'dayOfMonth', 'startDate'].some((field) => Object.prototype.hasOwnProperty.call(req.body, field));
    const nextDue = scheduleChanged
      ? calculateNextRecurringDueDate(nextTemplate.startDate, nextTemplate.frequency, nextTemplate.dayOfMonth, existing.lastGenerated || null)
      : existing.nextDue;

    await docRef.update({
      ...nextTemplate,
      nextDue: nextDue || existing.nextDue || calculateNextRecurringDueDate(nextTemplate.startDate, nextTemplate.frequency, nextTemplate.dayOfMonth),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.email || req.user.uid,
    });

    res.json({ ok: true, updated: true });
  } catch (error) {
    console.error('[Recurring] Error updating transaction:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.delete('/recurring/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { id } = req.params;
    const docRef = getRecurringTransactionsRef(userId).doc(id);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return res.status(404).json({ ok: false, error: 'Recurring template not found' });
    }

    await docRef.update({
      isActive: false,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.email || req.user.uid,
    });

    res.json({ ok: true, deleted: true });
  } catch (error) {
    console.error('[Recurring] Error deleting transaction:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/recurring/generate', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { asOfDate, propertyId } = req.body || {};
    const targetDate = String(asOfDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const snapshot = await getRecurringTransactionsRef(userId).get();
    const templates = [];
    snapshot.forEach((doc) => {
      const template = { id: doc.id, ...doc.data() };
      if (template.isActive === false) {
        return;
      }
      if (propertyId && String(template.propertyId || '') !== String(propertyId)) {
        return;
      }
      templates.push(template);
    });

    templates.sort((left, right) => String(left.nextDue || '').localeCompare(String(right.nextDue || '')));

    let generated = 0;
    let duplicates = 0;
    const entries = [];
    const errors = [];

    for (const template of templates) {
      const accountRecord = await getBookkeepingAccountRecord(userId, template.accountCode);
      const offsetAccountRecord = await getBookkeepingAccountRecord(userId, template.offsetAccountCode);
      if (!accountRecord || !offsetAccountRecord) {
        errors.push({ id: template.id, error: `Account mapping missing for ${template.name}` });
        continue;
      }

      let currentDue = String(template.nextDue || calculateNextRecurringDueDate(template.startDate, template.frequency, template.dayOfMonth) || '');
      let lastGenerated = template.lastGenerated || null;
      let guard = 0;

      while (currentDue && currentDue <= targetDate && guard < 60) {
        if (template.endDate && String(template.endDate) < currentDue) {
          currentDue = null;
          break;
        }

        try {
          const payload = buildRecurringTemplateEntryPayload(template, accountRecord, offsetAccountRecord, currentDue);
          const result = await createPostedJournalEntry(userId, {
            entryDate: currentDue,
            memo: payload.memo,
            source: 'RECURRING_TEMPLATE',
            sourceRef: payload.sourceRef,
            lines: payload.lines,
            propertyId: template.propertyId || null,
            type: payload.type,
            isExpense: payload.isExpense,
            amount: roundCurrency(template.amount || 0),
            originalAmount: payload.originalAmount,
            category: payload.category,
            accountCode: template.accountCode,
            scheduleELine: payload.scheduleELine,
            description: payload.description,
            postedBy: req.user.email || req.user.uid,
            metadata: {
              recurringTemplateId: template.id,
              recurringTemplateName: template.name,
              recurringFrequency: template.frequency,
            },
          });

          const status = result?.shadowLedger?.status || 'posted';
          if (status === 'duplicate') {
            duplicates += 1;
          } else {
            generated += 1;
          }

          entries.push({
            recurringId: template.id,
            name: template.name,
            journalEntryId: result.journalEntryId,
            amount: roundCurrency(template.amount || 0),
            date: currentDue,
            status,
          });
          lastGenerated = currentDue;
        } catch (error) {
          errors.push({ id: template.id, date: currentDue, error: error.message });
          break;
        }

        currentDue = advanceRecurringDate(currentDue, template.frequency, template.dayOfMonth);
        guard += 1;
      }

      await getRecurringTransactionsRef(userId).doc(template.id).update({
        lastGenerated: lastGenerated || template.lastGenerated || null,
        nextDue: currentDue || template.nextDue || null,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.email || req.user.uid,
      });
    }

    res.json({ ok: errors.length === 0, generated, duplicates, entries, errors });
  } catch (error) {
    console.error('[Recurring] Error generating transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/recurring/upcoming', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { days = 30, propertyId } = req.query;
    const limitDays = Math.max(1, Number(days) || 30);
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + limitDays);
    const boundary = futureDate.toISOString().slice(0, 10);

    const snapshot = await getRecurringTransactionsRef(userId).get();
    const transactions = [];
    snapshot.forEach((doc) => {
      const template = { id: doc.id, ...doc.data() };
      if (template.isActive === false) {
        return;
      }
      if (propertyId && String(template.propertyId || '') !== String(propertyId)) {
        return;
      }
      if (!template.nextDue || String(template.nextDue) > boundary) {
        return;
      }
      if (template.endDate && String(template.endDate) < new Date().toISOString().slice(0, 10)) {
        return;
      }
      transactions.push(template);
    });

    transactions.sort((left, right) => String(left.nextDue || '').localeCompare(String(right.nextDue || '')));
    res.json({ ok: true, transactions, count: transactions.length });
  } catch (error) {
    console.error('[Recurring] Error getting upcoming transactions:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/recurring/templates', requireAuth, async (_req, res) => {
  try {
    res.json({ ok: true, templates: RECURRING_TRANSACTION_TEMPLATES });
  } catch (error) {
    console.error('[Recurring] Error getting recurring templates:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Add a simple transaction (creates balanced journal entry automatically)
 */
router.post('/transaction', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { date, description, amount, type, categoryCode, propertyId } = req.body;
    
    if (!date || !description || !amount || !type) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    
    // Get the category account
    const defaultAccountCode = type === 'income' ? '4000' : '5000';
    let categoryAccountCode = categoryCode || defaultAccountCode;
    let categoryAccount = await getBookkeepingAccountRecord(userId, categoryAccountCode);

    if (!categoryAccount && categoryAccountCode !== defaultAccountCode) {
      categoryAccountCode = defaultAccountCode;
      categoryAccount = await getBookkeepingAccountRecord(userId, categoryAccountCode);
    }

    if (!categoryAccount) {
      return res.status(400).json({ ok: false, error: `Account not found: ${categoryAccountCode}` });
    }
    
    // Build journal lines
    const lines = [];
    
    if (type === 'income') {
      // Debit cash, credit revenue
      lines.push({
        accountCode: '1000',
        accountName: 'Operating Cash',
        amount: parseFloat(amount),
        dc: 'D',
        propertyId
      });
      lines.push({
        accountCode: categoryAccountCode,
        accountName: categoryAccount.name,
        amount: parseFloat(amount),
        dc: 'C',
        propertyId
      });
    } else {
      // Debit expense, credit cash
      lines.push({
        accountCode: categoryAccountCode,
        accountName: categoryAccount.name,
        amount: parseFloat(amount),
        dc: 'D',
        propertyId
      });
      lines.push({
        accountCode: '1000',
        accountName: 'Operating Cash',
        amount: parseFloat(amount),
        dc: 'C',
        propertyId
      });
    }
    
    const accountingType = type === 'income' ? 'income' : 'expense';
    const result = await createPostedJournalEntry(userId, {
      entryDate: date,
      memo: description,
      source: 'MANUAL',
      sourceRef: null,
      lines,
      type: accountingType,
      propertyId: propertyId || null,
      accountCode: categoryAccountCode,
      category: categoryAccount.name,
      scheduleELine: Object.values(SCHEDULE_E_CATEGORIES).find((config) => config.code === categoryAccountCode)?.scheduleELine || null,
      amount: roundCurrency(amount),
      originalAmount: roundCurrency(amount),
      isExpense: accountingType === 'expense',
      postedBy: req.user.email || req.user.uid
    });
    
    res.json({ 
      ok: true, 
      journalEntryId: result.journalEntryId,
      message: `${type === 'income' ? 'Income' : 'Expense'} recorded successfully`,
      shadowLedger: result.shadowLedger
    });
  } catch (error) {
    console.error('[Bookkeeping] Add transaction error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// QuickBooks Export Helpers
// ============================================================================

/**
 * Get monthly totals for QBO export
 */
router.get('/qbo-export/:month', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { month } = req.params; // YYYY-MM format
    
    const startDate = `${month}-01`;
    const [year, monthNum] = month.split('-').map(Number);
    const endDate = new Date(year, monthNum, 0).toISOString().split('T')[0];
    
    const entriesRef = getJournalEntriesRef(userId);
    const accountsRef = getAccountsRef(userId);
    
    const [entriesSnap, accountsSnap] = await Promise.all([
      entriesRef.where('entryDate', '>=', startDate).where('entryDate', '<=', endDate).get(),
      accountsRef.get()
    ]);
    
    const accountMap = new Map(accountsSnap.docs.map(d => [d.id, d.data()]));
    
    // Aggregate by account
    const revenueTotals = new Map();
    const expenseTotals = new Map();
    
    for (const doc of entriesSnap.docs) {
      const entry = doc.data();
      
      for (const line of (entry.lines || [])) {
        const account = accountMap.get(line.accountCode);
        if (!account) continue;
        
        const key = `${line.accountCode}-${line.propertyId || 'none'}`;
        
        if (account.type === 'REVENUE') {
          const amount = line.dc === 'C' ? line.amount : -line.amount;
          const existing = revenueTotals.get(key) || { accountCode: line.accountCode, accountName: account.name, amount: 0, propertyId: line.propertyId };
          existing.amount += amount;
          revenueTotals.set(key, existing);
        } else if (account.type === 'EXPENSE') {
          const amount = line.dc === 'D' ? line.amount : -line.amount;
          const existing = expenseTotals.get(key) || { accountCode: line.accountCode, accountName: account.name, amount: 0, propertyId: line.propertyId };
          existing.amount += amount;
          expenseTotals.set(key, existing);
        }
      }
    }
    
    const revenue = Array.from(revenueTotals.values()).filter(r => Math.abs(r.amount) > 0.005);
    const expenses = Array.from(expenseTotals.values()).filter(e => Math.abs(e.amount) > 0.005);
    
    if (revenue.length === 0 && expenses.length === 0) {
      return res.json({ ok: false, error: 'no_activity', message: 'No transactions found for this month' });
    }
    
    const totalRevenue = revenue.reduce((sum, r) => sum + r.amount, 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
    
    // Build QBO journal entry lines
    const lines = [];
    
    for (const rev of revenue) {
      lines.push({
        accountCode: rev.accountCode,
        accountName: rev.accountName,
        amount: Math.abs(rev.amount),
        dc: 'C'
      });
    }
    
    for (const exp of expenses) {
      lines.push({
        accountCode: exp.accountCode,
        accountName: exp.accountName,
        amount: Math.abs(exp.amount),
        dc: 'D'
      });
    }
    
    res.json({
      ok: true,
      month,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      netIncome: Math.round((totalRevenue - totalExpenses) * 100) / 100,
      lines,
      entryCount: entriesSnap.docs.length
    });
  } catch (error) {
    console.error('[Bookkeeping] QBO export error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// Import from QuickBooks
// ============================================================================

/**
 * Import transactions from QuickBooks
 */
router.post('/import-qbo', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { transactions } = req.body; // Array of { date, memo, amount, accountCode, accountName, type, qboId }
    
    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ ok: false, error: 'Missing transactions array' });
    }
    
    await ensureBookkeepingInitialized(userId);

    const entriesRef = getJournalEntriesRef(userId);
    const accountsRef = getAccountsRef(userId);
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];
    const shadowLedger = createBookkeepingShadowBatchSummary();
    
    for (const txn of transactions) {
      try {
        const sourceRef = txn.qboId || [txn.date, txn.memo || 'qbo', txn.accountCode || '', txn.amount].join(':');
        const existingSnap = await entriesRef
          .where('source', '==', 'QBO_IMPORT')
          .where('sourceRef', '==', sourceRef)
          .limit(1)
          .get();

        if (!existingSnap.empty) {
          skipped++;
          continue;
        }

        const isIncome = txn.type === 'income';
        const amount = roundCurrency(Math.abs(Number(txn.amount || 0)));
        if (!amount) {
          failed++;
          if (errors.length < 25) {
            errors.push({ sourceRef, error: 'QBO transaction amount must be non-zero.' });
          }
          continue;
        }

        const defaultAccountCode = isIncome ? '4000' : '5000';
        let categoryAccountCode = txn.accountCode || defaultAccountCode;
        let categorySnap = await accountsRef.doc(categoryAccountCode).get();

        if (!categorySnap.exists && categoryAccountCode !== defaultAccountCode) {
          categoryAccountCode = defaultAccountCode;
          categorySnap = await accountsRef.doc(categoryAccountCode).get();
        }

        if (!categorySnap.exists) {
          failed++;
          if (errors.length < 25) {
            errors.push({ sourceRef, error: `Account not found: ${categoryAccountCode}` });
          }
          continue;
        }

        const categoryAccount = categorySnap.data();
        const propertyId = txn.propertyId || null;
        const lines = isIncome
          ? [
              {
                accountCode: '1000',
                accountName: 'Operating Cash',
                amount,
                dc: 'D',
                propertyId
              },
              {
                accountCode: categoryAccountCode,
                accountName: categoryAccount.name,
                amount,
                dc: 'C',
                propertyId
              }
            ]
          : [
              {
                accountCode: categoryAccountCode,
                accountName: categoryAccount.name,
                amount,
                dc: 'D',
                propertyId
              },
              {
                accountCode: '1000',
                accountName: 'Operating Cash',
                amount,
                dc: 'C',
                propertyId
              }
            ];

        const result = await createPostedJournalEntry(userId, {
          entryDate: txn.date,
          memo: txn.memo || txn.accountName || 'QuickBooks import',
          source: 'QBO_IMPORT',
          sourceRef,
          lines,
          type: isIncome ? 'income' : 'expense',
          propertyId,
          accountCode: categoryAccountCode,
          category: categoryAccount.name,
          scheduleELine: Object.values(SCHEDULE_E_CATEGORIES).find((config) => config.code === categoryAccountCode)?.scheduleELine || null,
          amount,
          originalAmount: amount,
          isExpense: !isIncome,
          postedBy: req.user.email || 'qbo_import'
        });

        recordBookkeepingShadowBatchResult(shadowLedger, sourceRef, result.shadowLedger);
        imported++;
      } catch (txnError) {
        failed++;
        if (errors.length < 25) {
          errors.push({ sourceRef: txn.qboId || null, error: txnError.message });
        }
      }
    }
    
    res.json({ ok: failed === 0, imported, skipped, failed, shadowLedger, errors });
  } catch (error) {
    console.error('[Bookkeeping] Import QBO error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// Bank Transaction Posting (Called from Stripe/Plaid integrations)
// ============================================================================

/**
 * Post a bank transaction to Firestore bookkeeping
 * This is the core function that converts bank data into journal entries
 * 
 * @param {string} userId - Firebase user ID
 * @param {object} txn - Bank transaction data
 * @param {string} txn.bankTxnId - Unique bank transaction ID
 * @param {string} txn.date - Transaction date (YYYY-MM-DD)
 * @param {number} txn.amount - Absolute transaction amount
 * @param {string} txn.description - Transaction description
 * @param {string} txn.payee - Merchant/payee name
 * @param {boolean} txn.isDebit - True if money left the account (expense)
 * @param {string} txn.propertyId - Optional property ID for allocation
 * @param {string} txn.categoryCode - Account code for categorization (defaults based on type)
 * @param {string} txn.source - Source identifier (e.g., 'STRIPE', 'PLAID')
 */
export function buildBankTransactionJournalPayload(txn = {}, categoryAccountName = null) {
  const isExpense = Boolean(txn.isDebit);
  const source = txn.source || 'BANK';
  const defaultCategoryCode = isExpense ? '5999' : '4000';
  const categoryCode = txn.categoryCode || defaultCategoryCode;
  const category = categoryAccountName || txn.payee || (isExpense ? 'Other Expenses' : 'Other Income');
  const scheduleELine = Object.values(SCHEDULE_E_CATEGORIES).find((config) => config.code === categoryCode)?.scheduleELine || null;
  const amount = Math.abs(parseFloat(txn.amount));
  const lines = isExpense
    ? [
        {
          accountCode: categoryCode,
          accountName: category,
          amount,
          dc: 'D',
          propertyId: txn.propertyId || null,
          memo: txn.payee || txn.description
        },
        {
          accountCode: '1000',
          accountName: 'Operating Cash',
          amount,
          dc: 'C',
          propertyId: txn.propertyId || null
        }
      ]
    : [
        {
          accountCode: '1000',
          accountName: 'Operating Cash',
          amount,
          dc: 'D',
          propertyId: txn.propertyId || null
        },
        {
          accountCode: categoryCode,
          accountName: category,
          amount,
          dc: 'C',
          propertyId: txn.propertyId || null,
          memo: txn.payee || txn.description
        }
      ];

  return {
    entryDate: txn.date,
    memo: txn.description || txn.payee || 'Bank transaction',
    source,
    sourceRef: txn.bankTxnId,
    lines,
    payee: txn.payee || null,
    vendor: isExpense ? (txn.payee || null) : null,
    category,
    categoryCode,
    scheduleELine,
    originalAmount: txn.amount,
    isExpense,
    type: isExpense ? 'expense' : 'income',
    propertyId: txn.propertyId || null,
    amount
  };
}

export async function postBankTransactionToFirestore(userId, txn) {
  if (!userId) {
    throw new Error('userId is required for Firestore posting');
  }

  await ensureBookkeepingInitialized(userId);
  await assertAccountingPeriodOpen(userId, txn.date);

  const canonicalStatus = await isBookkeepingInitializedInAzure({ userId }).catch((error) => {
    console.error('[Bookkeeping] Canonical bank transaction initialization status error:', error);
    return { ok: false, status: 'failed', error: error.message, initialized: false };
  });
  const isExpense = txn.isDebit;
  const defaultCategoryCode = isExpense ? '5999' : '4000';
  const categoryCode = txn.categoryCode || defaultCategoryCode;
  const categoryAccount = await getBookkeepingAccountRecord(userId, categoryCode);
  const payload = buildBankTransactionJournalPayload(txn, categoryAccount?.name || null);

  if (!shouldUseCanonicalLedger(canonicalStatus)) {
    const existingQuery = await getJournalEntriesRef(userId)
      .where('source', '==', payload.source)
      .where('sourceRef', '==', txn.bankTxnId)
      .limit(1)
      .get();

    if (!existingQuery.empty) {
      return {
        ok: false,
        skipped: true,
        message: `Transaction already posted: ${txn.bankTxnId}`,
        journalEntryId: existingQuery.docs[0].id
      };
    }
  }

  const result = await createPostedJournalEntry(userId, {
    ...payload,
    postedBy: 'system'
  });

  if (result.shadowLedger?.status === 'duplicate') {
    return {
      ok: false,
      skipped: true,
      message: `Transaction already posted: ${txn.bankTxnId}`,
      journalEntryId: result.journalEntryId,
      shadowLedger: result.shadowLedger
    };
  }

  return {
    ok: true,
    journalEntryId: result.journalEntryId,
    isExpense: payload.isExpense,
    amount: payload.amount,
    categoryCode: payload.categoryCode,
    shadowLedger: result.shadowLedger
  };
}

/**
 * Initialize bookkeeping for a user if not already done
 * Call this before posting transactions for a new user
 */
export async function ensureBookkeepingInitialized(userId) {
  const canonicalResult = await ensureBookkeepingInitializedInAzure({ userId }).catch((error) => {
    console.error('[Bookkeeping] Canonical ensure initialization error:', error);
    return { ok: false, status: 'failed', error: error.message, initialized: false };
  });

  const readyCanonicalResult = requireCanonicalLedgerResult(canonicalResult, 'bookkeeping initialization');
  return {
    ok: true,
    alreadyInitialized: readyCanonicalResult.alreadyInitialized,
    seededAccounts: readyCanonicalResult.seededAccounts || 0,
    status: readyCanonicalResult.status
  };

  if (shouldUseCanonicalLedger(canonicalResult)) {
    return {
      ok: true,
      alreadyInitialized: canonicalResult.alreadyInitialized,
      seededAccounts: canonicalResult.seededAccounts || 0,
      status: canonicalResult.status
    };
  }

  const db = getFirestore();
  const configRef = getConfigRef(userId);
  const configSnap = await configRef.get();
  
  if (configSnap.exists) {
    return { ok: true, alreadyInitialized: true };
  }
  
  // Initialize with default chart of accounts
  const batch = db.batch();
  const accountsRef = getAccountsRef(userId);
  const now = new Date().toISOString();
  
  for (const account of DEFAULT_ACCOUNTS) {
    const accountDoc = accountsRef.doc(account.code);
    batch.set(accountDoc, {
      ...account,
      createdAt: now,
      updatedAt: now
    });
  }
  
  batch.set(configRef, {
    ...buildDefaultBookkeepingConfig(now),
    initializedAt: now
  });
  
  await batch.commit();
  
  console.log(`[Firestore Bookkeeping] Initialized bookkeeping for user ${userId}`);
  return { ok: true, alreadyInitialized: false };
}

// ============================================================================
// API Route for Bank Transaction Posting (with auth)
// ============================================================================

/**
 * POST /bank-transaction
 * Post a bank transaction from the frontend (requires auth)
 */
router.post('/bank-transaction', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { bankTxnId, date, amount, description, payee, isDebit, propertyId, categoryCode, source } = req.body;
    
    if (!bankTxnId || !date || amount === undefined) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required fields: bankTxnId, date, amount' 
      });
    }
    
    const result = await postBankTransactionToFirestore(userId, {
      bankTxnId,
      date,
      amount,
      description: description || payee,
      payee,
      isDebit: isDebit ?? (amount < 0),
      propertyId,
      categoryCode,
      source: source || 'MANUAL'
    });
    
    res.json(result);
  } catch (error) {
    console.error('[Bookkeeping] Bank transaction posting error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Map AI category names (from rental analytics) to chart-of-accounts codes
const AI_CATEGORY_TO_ACCOUNT = {
  'RENTAL_INCOME': '4000',
  'RENT_INCOME': '4000',
  'LATE_FEE': '4100',
  'APPLICATION_FEE': '4200',
  'PET_FEE': '4300',
  'OTHER_INCOME': '4900',
  'OTHER_RENTAL_INCOME': '4900',
  'REPAIRS_MAINTENANCE': '5000',
  'REPAIRS': '5000',
  'MAINTENANCE': '5000',
  'UTILITIES': '5100',
  'INSURANCE': '5200',
  'PROPERTY_TAX': '5300',
  'PROPERTY_TAXES': '5300',
  'PROPERTY_MANAGEMENT': '5400',
  'MANAGEMENT_FEES': '5400',
  'MORTGAGE_PAYMENT': '5500',
  'MORTGAGE': '5500',
  'MORTGAGE_INTEREST': '5500',
  'HOA': '5600',
  'HOA_FEE': '5600',
  'HOA_FEES': '5600',
  'LANDSCAPING': '5700',
  'PEST_CONTROL': '5750',
  'CLEANING': '5800',
  'CLEANING_MAINTENANCE': '5800',
  'LEGAL': '5900',
  'LEGAL_PROFESSIONAL': '5900',
  'ADVERTISING': '6000',
  'DEPRECIATION': '6100',
  'OTHER_EXPENSE': '5999',
  'UNCATEGORIZED': '5999',
};

/**
 * POST /sync-sample-transactions
 * Syncs categorized sample transactions from the rental analytics feed into canonical journal entries
 */
router.post('/sync-sample-transactions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { transactions, propertyId } = req.body;

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ ok: false, error: 'No transactions to sync' });
    }

    await ensureBookkeepingInitialized(userId);

    const now = new Date().toISOString();
    const targetYear = new Date().getFullYear();

    console.log(`[Sample Sync] Starting sync for user ${userId}, remapping dates to ${targetYear}`);

    // Ensure pest control account exists
    await upsertBookkeepingAccountInAzure({
      userId,
      code: '5750',
      name: 'Pest Control',
      type: 'EXPENSE',
      subtype: 'Expense',
      isActive: true
    }).catch((error) => {
      console.error('[Sample Sync] Error ensuring pest control account:', error);
      return { ok: false, status: 'failed', error: error.message, account: null };
    });

    // Upsert the canonical fixture property so all sample paths point at the same metadata.
    const fixture = await loadAccountingFixtureDefinition(DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME);
    const sampleProp = buildRentalAnalyticsSampleFromFixture(fixture);
    const attom = sampleProp.attomData || {};
    const fixtureProperty = fixture.properties?.[0] || null;
    const samplePropertyResult = await upsertBookkeepingPropertyInAzure({
      userId,
      id: fixtureProperty?.id || 'sample-portfolio-analytics-property',
      name: sampleProp.property.label,
      address: `${sampleProp.property.address}, ${sampleProp.property.location}`,
      state: fixtureProperty?.state || attom.address?.countrySubd || 'MD',
      purchaseDate: fixtureProperty?.purchaseDate || attom.saleHistory?.[0]?.saleDate || '2022-05-04',
      purchasePrice: fixtureProperty?.purchasePrice || attom.saleHistory?.[0]?.salePrice || 785000,
      landValue: fixtureProperty?.landValue || attom.assessment?.assessed?.assdLandValue || 318000,
      improvementValue: fixtureProperty?.improvementValue || attom.assessment?.assessed?.assdImprValue || 592400,
      description: 'Residential Rental Property',
      usefulLifeMonths: fixtureProperty?.usefulLifeMonths || 330,
      fairRentalDays: fixtureProperty?.fairRentalDays || 365,
      personalUseDays: fixtureProperty?.personalUseDays || 0,
      metadata: {
        propertyType: 'Residential Rental Property',
        isMockData: true,
        fixtureName: DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
        attomMortgageAmount: attom.mortgage?.amount || null,
        attomMortgageRate: attom.mortgage?.rate || null,
        attomMortgageLender: attom.mortgage?.lender || null,
        mortgageAmount: attom.mortgage?.amount || null,
        mortgageRate: attom.mortgage?.rate || null,
        mortgageLender: attom.mortgage?.lender || null,
        mortgageTermMonths: attom.mortgage?.term || 360,
        mortgageDate: attom.mortgage?.date || '2022-05-04',
        attomTaxAmount: attom.assessment?.tax?.taxAmt || null,
        attomAVM: attom.avm?.amount?.value || null,
        seededAt: now
      }
    });
    const samplePropertyId = samplePropertyResult.property?.id || propertyId || null;

    console.log(`[Sample Sync] Created property "${sampleProp.property.label}" (${samplePropertyId})`);

    let imported = 0;
    let skipped = 0;
    const shadowLedger = createBookkeepingShadowBatchSummary();
    const errors = [];

    for (let i = 0; i < transactions.length; i++) {
      const txn = transactions[i];
      try {
        const isExpense = txn.type === 'debit' || txn.type === 'Expense';
        const amount = Math.abs(Number(txn.amount || 0));
        const category = (txn.category || 'UNCATEGORIZED').toUpperCase();
        const accountCode = AI_CATEGORY_TO_ACCOUNT[category] || (isExpense ? '5999' : '4000');

        // Look up account name from chart of accounts
        const account = await getBookkeepingAccountRecord(userId, accountCode);
        const accountName = account?.name || (isExpense ? 'Other Expenses' : 'Other Income');

        const lines = [];
        const effectivePropertyId = samplePropertyId || propertyId || null;
        if (isExpense) {
          lines.push({ accountCode, accountName, amount, dc: 'D', propertyId: effectivePropertyId, memo: txn.merchant || txn.description });
          lines.push({ accountCode: '1000', accountName: 'Operating Cash', amount, dc: 'C', propertyId: effectivePropertyId });
        } else {
          lines.push({ accountCode: '1000', accountName: 'Operating Cash', amount, dc: 'D', propertyId: effectivePropertyId });
          lines.push({ accountCode, accountName, amount, dc: 'C', propertyId: effectivePropertyId, memo: txn.merchant || txn.description });
        }

        // Remap transaction dates to current year so Tax Center can find them
        const remappedDate = (txn.date || '').replace(/^\d{4}/, String(targetYear));
        const sourceRef = `sample-feed-${txn.id || i + 1}`;
        const result = await createPostedJournalEntry(userId, {
          entryDate: remappedDate,
          memo: txn.description || txn.merchant || 'Sample transaction',
          source: 'SAMPLE_FEED',
          sourceRef,
          lines,
          type: isExpense ? 'expense' : 'income',
          isExpense,
          payee: txn.merchant || null,
          category: accountName,
          accountCode,
          scheduleELine: Object.values(SCHEDULE_E_CATEGORIES).find((config) => config.code === accountCode)?.scheduleELine || null,
          originalAmount: isExpense ? -amount : amount,
          propertyId: effectivePropertyId,
          isSampleData: true,
          postedBy: 'sample-feed-loader'
        });

        recordBookkeepingShadowBatchResult(shadowLedger, sourceRef, result.shadowLedger);
        if (result.shadowLedger?.status === 'duplicate') {
          skipped++;
        } else {
          imported++;
        }
      } catch (txnError) {
        console.error(`[Sample Sync] Error on txn ${i}:`, txnError.message);
        skipped++;
        if (errors.length < 25) {
          errors.push({ id: txn.id || i + 1, error: txnError.message });
        }
      }
    }

    res.json({ ok: skipped === 0, imported, skipped, total: transactions.length, shadowLedger, errors });
  } catch (error) {
    console.error('[Bookkeeping] Sync sample transactions error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /bank-transactions/batch
 * Batch import multiple bank transactions (requires auth)
 */
router.post('/bank-transactions/batch', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { transactions, source } = req.body;
    
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ ok: false, error: 'transactions array is required' });
    }
    
    // Ensure bookkeeping is initialized
    await ensureBookkeepingInitialized(userId);
    
    const results = {
      total: transactions.length,
      imported: 0,
      skipped: 0,
      errors: []
    };
    
    for (const txn of transactions) {
      try {
        const result = await postBankTransactionToFirestore(userId, {
          ...txn,
          source: source || txn.source || 'BANK'
        });
        
        if (result.ok) {
          results.imported++;
        } else if (result.skipped) {
          results.skipped++;
        }
      } catch (txnError) {
        results.errors.push({
          bankTxnId: txn.bankTxnId,
          error: txnError.message
        });
      }
    }
    
    res.json({
      ok: true,
      ...results,
      message: `Imported ${results.imported} transactions, skipped ${results.skipped} duplicates`
    });
  } catch (error) {
    console.error('[Bookkeeping] Batch import error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// AI Transaction Categorization (Gemini 3 Pro)
// ============================================================================

/**
 * POST /api/bookkeeping/firestore/categorize-ai
 * Use Gemini to categorize transactions for Schedule E
 */
router.post('/categorize-ai', requireAuth, async (req, res) => {
  try {
    const { transactions } = req.body;
    
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ ok: false, error: 'transactions array required' });
    }
    
    // Build prompt for Gemini
    const categoryList = Object.keys(SCHEDULE_E_CATEGORIES).join(', ');
    
    const transactionDescriptions = transactions.map((t, i) => 
      `${i + 1}. ${t.description || t.memo || 'Unknown'} - $${Math.abs(t.amount || 0).toFixed(2)} (${t.amount >= 0 ? 'credit/deposit' : 'debit/payment'})`
    ).join('\n');
    
    const prompt = `You are an expert accountant specializing in rental property taxes and IRS Schedule E.

Categorize each bank transaction for a rental property owner. Use ONLY these categories:
${categoryList}

IMPORTANT TAX RULES:
1. Rental property expenses are 100% deductible on Schedule E (no limits like personal residence)
2. Property taxes on rental properties have NO $10,000 SALT cap (that only applies to personal residence)
3. Mortgage interest on rental properties is fully deductible (no $750K limit)
4. Repairs vs Improvements: Repairs (fix/restore) are immediately deductible; Improvements (add value/extend life) must be depreciated
5. Personal expenses are NOT deductible - mark as "Personal/Non-Deductible"

TRANSACTIONS TO CATEGORIZE:
${transactionDescriptions}

Respond in JSON format only:
{
  "categorizations": [
    { "index": 1, "category": "Category Name", "confidence": 0.95, "reason": "Brief explanation" },
    ...
  ]
}`;

    // Use Gemini 2.0 Pro for best categorization accuracy
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.1, // Low temperature for consistent categorization
        topP: 0.8,
        maxOutputTokens: 4096
      }
    });
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Parse JSON response
    let categorizations;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        categorizations = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('[AI Categorization] Parse error:', parseError);
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to parse AI response',
        rawResponse: text 
      });
    }
    
    // Enrich with Schedule E info
    const enrichedResults = categorizations.categorizations.map(cat => {
      const scheduleEInfo = SCHEDULE_E_CATEGORIES[cat.category] || SCHEDULE_E_CATEGORIES['Other Expenses'];
      return {
        ...cat,
        accountCode: scheduleEInfo.code,
        scheduleELine: scheduleEInfo.scheduleELine,
        type: scheduleEInfo.type,
        isDeductible: scheduleEInfo.type !== 'personal'
      };
    });
    
    res.json({
      ok: true,
      categorizations: enrichedResults,
      model: 'gemini-2.5-flash',
      scheduleECategories: SCHEDULE_E_CATEGORIES
    });
    
  } catch (error) {
    console.error('[AI Categorization] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/categorize-single
 * Categorize a single transaction (for real-time categorization)
 */
router.post('/categorize-single', requireAuth, async (req, res) => {
  try {
    const { description, amount, merchantName } = req.body;
    
    if (!description && !merchantName) {
      return res.status(400).json({ ok: false, error: 'description or merchantName required' });
    }
    
    const categoryList = Object.entries(SCHEDULE_E_CATEGORIES)
      .map(([name, info]) => `- ${name}: ${info.description}`)
      .join('\n');
    
    const prompt = `You are a rental property tax expert. Categorize this bank transaction:

Transaction: "${description || merchantName}"
Amount: $${Math.abs(amount || 0).toFixed(2)} (${amount >= 0 ? 'deposit' : 'payment'})

Available categories for rental properties (Schedule E):
${categoryList}

TAX RULES:
- Rental expenses are fully deductible (no SALT cap, no mortgage interest limit)
- Repairs are immediately deductible; capital improvements must be depreciated
- Personal expenses are NOT deductible

Respond with JSON only:
{
  "category": "Category Name",
  "confidence": 0.95,
  "reason": "Brief explanation",
  "scheduleELine": 14,
  "isDeductible": true
}`;

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash', // Faster model for single transactions
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
    });
    
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in response');
    }
    
    const categorization = JSON.parse(jsonMatch[0]);
    const scheduleEInfo = SCHEDULE_E_CATEGORIES[categorization.category] || SCHEDULE_E_CATEGORIES['Other Expenses'];
    
    res.json({
      ok: true,
      ...categorization,
      accountCode: scheduleEInfo.code,
      scheduleELine: scheduleEInfo.scheduleELine || categorization.scheduleELine,
      type: scheduleEInfo.type
    });
    
  } catch (error) {
    console.error('[AI Categorization Single] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/schedule-e-categories
 * Get all Schedule E categories for reference
 */
router.get('/schedule-e-categories', requireAuth, async (req, res) => {
  res.json({
    ok: true,
    categories: SCHEDULE_E_CATEGORIES,
    taxRules: {
      saltCap: 'Does NOT apply to rental properties - only personal residence',
      mortgageInterestLimit: 'Does NOT apply to rental properties - only personal residence',
      depreciation: '27.5 years straight-line for residential rental property',
      passiveLossLimit: '$25,000 allowance for active participation, phases out at $100K-$150K AGI',
      qbiDeduction: '20% qualified business income deduction may apply (Section 199A)',
      repairsVsImprovements: 'Repairs deduct immediately; Improvements depreciate over time'
    }
  });
});

/**
 * POST /api/bookkeeping/firestore/receipt-ocr
 * Extract transaction data from receipt image using Gemini Vision
 */
router.post('/receipt-ocr', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { imageBase64, imageUrl, propertyId, propertyAddress } = req.body;
    
    if (!imageBase64 && !imageUrl) {
      return res.status(400).json({ ok: false, error: 'Image data required (base64 or URL)' });
    }
    
    // Build the image content
    let imageContent;
    if (imageBase64) {
      // Remove data URL prefix if present
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageContent = {
        inlineData: {
          data: base64Data,
          mimeType: 'image/jpeg'
        }
      };
    } else {
      // Fetch image from URL
      const imageRes = await fetch(imageUrl);
      const arrayBuffer = await imageRes.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      imageContent = {
        inlineData: {
          data: base64Data,
          mimeType: 'image/jpeg'
        }
      };
    }
    
    // Use Gemini 1.5 Flash for vision (faster for OCR)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const prompt = `You are analyzing a receipt image for a rental property expense. Extract the following information:

1. Vendor/Store name
2. Date of purchase (format: YYYY-MM-DD)
3. Total amount (just the number, no currency symbol)
4. Line items if visible (description and amount for each)
5. Category - must be one of these rental property expense categories:
   - Repairs & Maintenance
   - Utilities
   - Supplies
   - Landscaping
   - Cleaning
   - Insurance
   - Property Tax
   - Mortgage Interest
   - HOA Fees
   - Legal & Professional
   - Advertising
   - Travel (for property visits)
   - Office Supplies
   - Other Expense

6. Tax-deductible? (Yes/No/Partial)
7. Description for bookkeeping (brief summary)
8. Any warranty or guarantee mentioned

Respond in valid JSON format only:
{
  "vendor": "string",
  "date": "YYYY-MM-DD",
  "total": number,
  "lineItems": [{"description": "string", "amount": number}],
  "category": "string",
  "taxDeductible": true/false,
  "description": "string",
  "warranty": "string or null",
  "confidence": 0.0-1.0,
  "rawText": "full text from receipt if readable"
}

If you cannot read certain fields clearly, set confidence lower and note what's unclear.`;

    const result = await model.generateContent([prompt, imageContent]);
    const response = result.response;
    const text = response.text();
    
    // Parse the JSON response
    let extractedData;
    try {
      // Clean up the response - remove markdown code blocks if present
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error('[Receipt OCR] Failed to parse AI response:', text);
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to parse receipt data',
        rawResponse: text 
      });
    }
    
    // Map category to account code
    const normalizedCategory = normalizeReceiptCategory(extractedData.category);
    const categoryConfig = SCHEDULE_E_CATEGORIES[normalizedCategory] || SCHEDULE_E_CATEGORIES['Other Expenses'];
    const accountCode = categoryConfig?.code || '5999';
    const scheduleELine = categoryConfig?.scheduleELine || 19;
    
    // Prepare the response with suggested journal entry
    const suggestedEntry = {
      date: extractedData.date || new Date().toISOString().split('T')[0],
      type: 'expense',
      category: normalizedCategory,
      accountCode,
      scheduleELine,
      debitAccount: accountCode,
      creditAccount: '1000', // Cash/Bank
      amount: extractedData.total,
      description: extractedData.description || `${extractedData.vendor} - ${extractedData.category}`,
      vendor: extractedData.vendor,
      propertyId: propertyId || null,
      propertyAddress: propertyAddress || '',
      isDeductible: extractedData.taxDeductible !== false,
      source: 'receipt_ocr',
      receiptData: {
        lineItems: extractedData.lineItems,
        warranty: extractedData.warranty,
        rawText: extractedData.rawText
      }
    };
    
    res.json({
      ok: true,
      extractedData,
      suggestedEntry,
      confidence: extractedData.confidence || 0.8
    });
  } catch (error) {
    console.error('Error processing receipt:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/receipt-save
 * Save a receipt-extracted transaction as a journal entry
 */
router.post('/receipt-save', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { entry, imageUrl, imageBase64 } = req.body;
    
    if (!entry || !entry.amount) {
      return res.status(400).json({ ok: false, error: 'Entry with amount required' });
    }
    
    const amount = roundCurrency(entry.amount);
    const accounting = resolveReceiptAccounting(entry);
    const receiptDigitization = await maybeDigitizeReceiptDocument({ imageUrl, imageBase64, entry });
    const memo = entry.description || `${entry.vendor || 'Receipt'} - ${accounting.category}`;
    const sourceRef = imageUrl || null;

    const result = await createPostedJournalEntry(userId, {
      entryDate: entry.date || new Date().toISOString().split('T')[0],
      memo,
      source: 'RECEIPT',
      sourceRef,
      lines: [
        {
          accountCode: accounting.accountCode,
          accountName: accounting.accountName,
          amount,
          dc: 'D',
          propertyId: entry.propertyId || null,
          memo
        },
        {
          accountCode: '1000',
          accountName: 'Operating Cash',
          amount,
          dc: 'C',
          propertyId: entry.propertyId || null,
          memo
        }
      ],
      type: 'expense',
      category: accounting.category,
      accountCode: accounting.accountCode,
      scheduleELine: accounting.scheduleELine,
      debitAccount: accounting.accountCode,
      creditAccount: '1000',
      amount,
      description: entry.description || '',
      vendor: entry.vendor || '',
      propertyId: entry.propertyId || null,
      propertyAddress: entry.propertyAddress || '',
      isDeductible: entry.isDeductible !== false,
      isExpense: true,
      originalAmount: amount,
      hasReceipt: true,
      receiptData: entry.receiptData || null,
      receiptImage: imageUrl || (imageBase64 ? 'stored_inline' : null),
      receiptDigitization,
      postedBy: req.user.email || req.user.uid
    });

    let evidence = null;
    if (imageUrl || imageBase64) {
      try {
        const receiptMimeType = imageBase64
          ? decodeBase64Document(imageBase64)?.mimeType || null
          : receiptDigitization?.metadata?.mimeType || null;
        const links = [
          {
            entityType: 'firestore_journal_entry',
            entityId: result.journalEntryId,
            linkRole: 'receipt_support'
          }
        ];

        if (result.shadowLedger?.journalEntryId) {
          links.push({
            entityType: 'journal_entry',
            entityId: result.shadowLedger.journalEntryId,
            linkRole: 'receipt_support'
          });
        }

        evidence = await persistFinanceEvidenceToAzure({
          userId,
          propertyId: entry.propertyId || null,
          sourceSystem: 'bookkeeping_firestore_receipt',
          sourceRef: `receipt:${result.journalEntryId}`,
          evidenceType: 'receipt_image',
          title: memo,
          documentDate: entry.date || new Date().toISOString().split('T')[0],
          vendorName: entry.vendor || null,
          amount,
          currencyCode: 'USD',
          externalUrl: imageUrl || null,
          mimeType: receiptMimeType,
          digitizationStatus: receiptDigitization?.metadata?.status || null,
          summary: {
            receiptData: entry.receiptData || null,
            extractedFields: receiptDigitization?.extractedFields || {},
            digitization: receiptDigitization?.metadata || null
          },
          extractedText: receiptDigitization?.contentPreview || null,
          createdBy: req.user.email || req.user.uid,
          links
        });
      } catch (error) {
        console.error('[Bookkeeping] Receipt evidence persistence error:', error);
        evidence = {
          ok: false,
          status: 'failed',
          error: error.message
        };
      }
    }

    res.json({ ok: true, entryId: result.journalEntryId, entry: result.entry, shadowLedger: result.shadowLedger, evidence });
  } catch (error) {
    console.error('Error saving receipt entry:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

router.get('/evidence', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      propertyId = null,
      sourceSystem = null,
      entityType = null,
      entityId = null,
      year = null,
      q = null,
      limit = 50
    } = req.query;

    const evidence = await listFinanceEvidenceFromAzure({
      userId,
      propertyId,
      sourceSystem,
      entityType,
      entityId,
      year,
      q,
      limit
    });

    const trimmedQuery = String(q || '').trim();
    if (trimmedQuery && Array.isArray(evidence?.evidence) && evidence.evidence.length > 0) {
      const ranked = rankFinanceSearchCandidates({
        query: trimmedQuery,
        candidates: evidence.evidence,
        limit: evidence.evidence.length,
        buildSearchText: (item) => [
          item.title,
          item.vendorName,
          item.sourceRef,
          item.evidenceType,
          typeof item.summary === 'string' ? item.summary : JSON.stringify(item.summary || null),
          item.extractedText,
        ].filter(Boolean).join('\n'),
        compareCandidates: (left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')),
      });

      evidence.evidence = ranked.items.map((item) => item.candidate);
      evidence.search = {
        ...(evidence.search || {}),
        provider: 'sql_like',
        status: 'searched',
        usedQuery: ranked.usedQuery,
        hitCount: ranked.totalCount,
      };
    }

    evidence.overview = await generateFinanceSearchOverview({
      query: trimmedQuery,
      results: evidence?.evidence || [],
      resultLabel: 'evidence records',
      scope: {
        propertyId,
        sourceSystem,
        year,
      }
    });

    res.json(evidence);
  } catch (error) {
    console.error('[Bookkeeping] Evidence list error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

function buildFinanceAiLedgerSummary(entries = []) {
  const categoryTotals = new Map();
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const entry of entries) {
    const amount = Math.abs(parseFloat(entry?.amount) || 0);
    const type = String(entry?.type || '').toLowerCase();
    const category = String(entry?.category || 'Uncategorized').trim() || 'Uncategorized';

    if (type === 'income' || type === 'revenue') {
      totalIncome += amount;
    } else if (type === 'expense') {
      totalExpenses += amount;
    }

    categoryTotals.set(category, (categoryTotals.get(category) || 0) + amount);
  }

  const topCategories = Array.from(categoryTotals.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([category, amount]) => ({
      category,
      amount: Math.round(amount * 100) / 100
    }));

  return {
    entryCount: entries.length,
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    netCashFlow: Math.round((totalIncome - totalExpenses) * 100) / 100,
    topCategories
  };
}

function buildFinanceAiEvidenceExcerpt(evidence = {}) {
  const summary = evidence?.summary || {};
  const summaryText = [summary.summary, summary.description, summary.notes]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)[0];
  const extractedText = typeof evidence?.extractedText === 'string' ? evidence.extractedText.trim() : '';
  const excerpt = summaryText || extractedText || 'No OCR excerpt available.';
  return excerpt.slice(0, 420);
}

function parseFinanceAiJson(text) {
  const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in finance AI response');
  }

  return JSON.parse(jsonMatch[0]);
}

async function generateGroundedFinanceAnswer({
  question,
  evidence = [],
  financeContext = {},
  retrieval = {},
}) {
  if (!GEMINI_API_KEY) {
    return {
      ok: true,
      status: 'not_configured',
      answer: 'Finance AI answer generation is not configured in this environment yet. The workspace will stay on local finance retrieval until Gemini is enabled.',
      bullets: [],
      citations: [],
      followUps: [],
      confidence: 'low',
      answering: {
        provider: 'gemini',
        model: null,
        status: 'not_configured'
      }
    };
  }

  const evidenceSlots = evidence.slice(0, 6).map((item, index) => ({
    slot: `E${index + 1}`,
    evidenceId: item.evidenceId,
    title: item.title || item.vendorName || item.evidenceType || 'Evidence item',
    sourceSystem: item.sourceSystem || null,
    sourceRef: item.sourceRef || null,
    documentDate: item.documentDate || null,
    amount: item.amount === null || item.amount === undefined ? null : Number(item.amount),
    vendorName: item.vendorName || null,
    evidenceType: item.evidenceType || null,
    excerpt: buildFinanceAiEvidenceExcerpt(item)
  }));

  const evidenceSlotMap = new Map(evidenceSlots.map((item) => [item.slot, item]));
  const prompt = `You are HouseYield Finance Copilot. Answer the user's finance question using ONLY the scoped finance context and evidence provided below.

Rules:
- Never invent facts that are not present in the supplied context.
- If the evidence is insufficient, say so plainly.
- Keep the answer concise and operational.
- When referencing evidence-backed claims, cite the evidence slot inline like [E1].
- Use US dollar formatting where applicable.
- Return JSON only with this schema:
{
  "answer": "short answer with inline evidence slots like [E1] when used",
  "bullets": ["supporting point", "supporting point"],
  "citationSlots": ["E1", "E2"],
  "followUps": ["follow up question", "follow up question"],
  "confidence": "high|medium|low"
}

Question:
${question}

Scoped finance context:
${JSON.stringify(financeContext, null, 2)}

Retrieval metadata:
${JSON.stringify(retrieval, null, 2)}

Evidence slots:
${JSON.stringify(evidenceSlots, null, 2)}`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.15,
      topP: 0.8,
      maxOutputTokens: 2048
    }
  });

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const parsed = parseFinanceAiJson(response.text());
  const citationSlots = Array.isArray(parsed.citationSlots)
    ? parsed.citationSlots.filter((slot) => typeof slot === 'string' && evidenceSlotMap.has(slot))
    : [];

  return {
    ok: true,
    status: 'answered',
    answer: typeof parsed.answer === 'string' ? parsed.answer.trim() : '',
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets.filter((item) => typeof item === 'string' && item.trim()) : [],
    citations: citationSlots.map((slot) => ({
      slot,
      ...evidenceSlotMap.get(slot)
    })),
    followUps: Array.isArray(parsed.followUps) ? parsed.followUps.filter((item) => typeof item === 'string' && item.trim()) : [],
    confidence: ['high', 'medium', 'low'].includes(String(parsed.confidence || '').toLowerCase())
      ? String(parsed.confidence).toLowerCase()
      : 'low',
    answering: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      status: 'answered'
    }
  };
}

router.post('/ai-query', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      question,
      propertyId = null,
      year = null,
      sourceSystem = null,
      limit = 8,
    } = req.body || {};

    const trimmedQuestion = String(question || '').trim();
    if (!trimmedQuestion) {
      return res.status(400).json({ ok: false, error: 'question is required' });
    }

    const normalizedYear = Number.isFinite(parseInt(year, 10)) ? parseInt(year, 10) : null;
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 12);
    const evidenceResult = await listFinanceEvidenceFromAzure({
      userId,
      propertyId,
      sourceSystem,
      year: normalizedYear,
      q: trimmedQuestion,
      limit: normalizedLimit,
    });

    let financeContext = {
      year: normalizedYear,
      propertyId: propertyId || null,
      propertyLabel: null,
      ledgerSummary: null,
      scheduleE: null,
      depreciation: null,
      rulesRuntime: null,
    };

    if (normalizedYear !== null) {
      const [rulesRuntime, entries, properties] = await Promise.all([
        loadRuntimeTaxRulesetPackage(normalizedYear),
        fetchAllEntries(userId, normalizedYear, propertyId || null),
        fetchUserProperties(userId),
      ]);

      const scopedProperties = await resolveScopedBookkeepingProperties(userId, propertyId || null, properties);
      const propertyRecord = propertyId ? scopedProperties[0] || null : null;
      const scheduleE = generateScheduleE(entries, normalizedYear, propertyId || null, properties, rulesRuntime.ruleset);
      const depreciation = calculateDepreciation(
        propertyId ? scopedProperties : properties,
        normalizedYear,
        rulesRuntime.ruleset,
      );

      financeContext = {
        year: normalizedYear,
        propertyId: propertyId || null,
        propertyLabel: propertyRecord
          ? propertyRecord.propertyName || propertyRecord.name || propertyRecord.address || propertyRecord.id
          : null,
        ledgerSummary: buildFinanceAiLedgerSummary(entries),
        scheduleE: scheduleE?.summary || null,
        depreciation: depreciation?.summary || null,
        rulesRuntime: buildRulesRuntimeMeta(rulesRuntime),
      };
    }

    const retrieval = {
      provider: evidenceResult?.search?.provider || null,
      status: evidenceResult?.search?.status || evidenceResult?.status || 'unknown',
      usedQuery: evidenceResult?.search?.usedQuery || trimmedQuestion,
      hitCount: evidenceResult?.search?.hitCount ?? evidenceResult?.evidence?.length ?? 0,
      evidenceCount: evidenceResult?.evidence?.length || 0,
    };

    if ((evidenceResult?.evidence?.length || 0) === 0 && !financeContext?.ledgerSummary?.entryCount) {
      return res.json({
        ok: true,
        status: 'no_results',
        answer: 'No finance evidence or scoped ledger activity matched this question yet.',
        bullets: [
          'Try a vendor name, source reference, property-specific phrase, or a narrower tax-year question.',
          'The AI surface stays grounded to the current finance scope and will not answer beyond the available ledger/evidence context.'
        ],
        citations: [],
        followUps: [
          'Show me receipts tied to this question',
          'Which categories drove the biggest totals this year?'
        ],
        confidence: 'low',
        retrieval,
        financeContext,
        answering: {
          provider: 'gemini',
          model: GEMINI_API_KEY ? 'gemini-2.5-flash' : null,
          status: GEMINI_API_KEY ? 'no_results' : 'not_configured'
        }
      });
    }

    const aiResult = await generateGroundedFinanceAnswer({
      question: trimmedQuestion,
      evidence: evidenceResult?.evidence || [],
      financeContext,
      retrieval,
    });

    res.json({
      ...aiResult,
      retrieval,
      financeContext,
    });
  } catch (error) {
    console.error('[Bookkeeping] Finance AI query error:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/property-pnl
 * Get profit & loss report per property
 */
router.get('/property-pnl', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { startDate, endDate, propertyId } = req.query;
    
    const year = new Date().getFullYear();
    const start = startDate || `${year}-01-01`;
    const end = endDate || new Date().toISOString().split('T')[0];
    
    const entriesRef = getJournalEntriesRef(userId);
    const snapshot = await entriesRef.get();
    
    // Group entries by property
    const propertyData = {};
    const noPropertyData = {
      propertyId: 'unassigned',
      propertyAddress: 'Unassigned',
      income: {},
      expenses: {},
      totalIncome: 0,
      totalExpenses: 0,
      netIncome: 0
    };
    
    snapshot.forEach(doc => {
      const entry = doc.data();
      const entryDate = entry.date;
      
      // Filter by date range
      if (entryDate < start || entryDate > end) return;
      
      // Filter by specific property if requested
      if (propertyId && entry.propertyId !== propertyId) return;
      
      const propId = entry.propertyId || 'unassigned';
      const propAddress = entry.propertyAddress || 'Unassigned';
      
      if (!propertyData[propId] && propId !== 'unassigned') {
        propertyData[propId] = {
          propertyId: propId,
          propertyAddress: propAddress,
          income: {},
          expenses: {},
          totalIncome: 0,
          totalExpenses: 0,
          netIncome: 0
        };
      }
      
      const targetData = propId === 'unassigned' ? noPropertyData : propertyData[propId];
      const amount = Math.abs(parseFloat(entry.amount) || 0);
      const category = entry.category || 'Other';
      
      if (entry.type === 'income') {
        targetData.income[category] = (targetData.income[category] || 0) + amount;
        targetData.totalIncome += amount;
      } else if (entry.type === 'expense') {
        targetData.expenses[category] = (targetData.expenses[category] || 0) + amount;
        targetData.totalExpenses += amount;
      }
    });
    
    // Calculate net income for each property
    Object.values(propertyData).forEach((prop) => {
      prop.netIncome = prop.totalIncome - prop.totalExpenses;
    });
    noPropertyData.netIncome = noPropertyData.totalIncome - noPropertyData.totalExpenses;
    
    // Convert to array and sort by net income
    const properties = Object.values(propertyData);
    if (noPropertyData.totalIncome > 0 || noPropertyData.totalExpenses > 0) {
      properties.push(noPropertyData);
    }
    
    properties.sort((a, b) => b.netIncome - a.netIncome);
    
    // Portfolio summary
    const portfolioSummary = {
      totalIncome: properties.reduce((sum, p) => sum + p.totalIncome, 0),
      totalExpenses: properties.reduce((sum, p) => sum + p.totalExpenses, 0),
      netIncome: properties.reduce((sum, p) => sum + p.netIncome, 0),
      propertyCount: properties.filter(p => p.propertyId !== 'unassigned').length,
      bestPerformer: properties.find(p => p.propertyId !== 'unassigned') || null,
      worstPerformer: [...properties].filter(p => p.propertyId !== 'unassigned').sort((a, b) => a.netIncome - b.netIncome)[0] || null
    };
    
    res.json({
      ok: true,
      period: { start, end },
      properties,
      portfolioSummary
    });
  } catch (error) {
    console.error('Error getting property P&L:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/property-pnl/:propertyId
 * Get detailed P&L for a specific property
 */
router.get('/property-pnl/:propertyId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId } = req.params;
    const { startDate, endDate } = req.query;
    
    const year = new Date().getFullYear();
    const start = startDate || `${year}-01-01`;
    const end = endDate || new Date().toISOString().split('T')[0];
    
    const entriesRef = getJournalEntriesRef(userId);
    
    // Query entries for this property
    let query = entriesRef;
    if (propertyId !== 'unassigned') {
      query = entriesRef.where('propertyId', '==', propertyId);
    }
    
    const snapshot = await query.get();
    
    const incomeByCategory = {};
    const expensesByCategory = {};
    const monthlyData = {};
    const transactions = [];
    let propertyAddress = '';
    
    snapshot.forEach(doc => {
      const entry = doc.data();
      const entryDate = entry.date;
      
      // Filter by date range
      if (entryDate < start || entryDate > end) return;
      
      // For unassigned, only include entries without propertyId
      if (propertyId === 'unassigned' && entry.propertyId) return;
      
      if (!propertyAddress && entry.propertyAddress) {
        propertyAddress = entry.propertyAddress;
      }
      
      const amount = Math.abs(parseFloat(entry.amount) || 0);
      const category = entry.category || 'Other';
      const month = entryDate.substring(0, 7); // YYYY-MM
      
      // Monthly tracking
      if (!monthlyData[month]) {
        monthlyData[month] = { month, income: 0, expenses: 0, netIncome: 0 };
      }
      
      if (entry.type === 'income') {
        incomeByCategory[category] = (incomeByCategory[category] || 0) + amount;
        monthlyData[month].income += amount;
      } else if (entry.type === 'expense') {
        expensesByCategory[category] = (expensesByCategory[category] || 0) + amount;
        monthlyData[month].expenses += amount;
      }
      
      transactions.push({
        id: doc.id,
        date: entryDate,
        type: entry.type,
        category,
        amount,
        description: entry.description,
        vendor: entry.vendor
      });
    });
    
    // Calculate monthly net income
    Object.values(monthlyData).forEach((m) => {
      m.netIncome = m.income - m.expenses;
    });
    
    const totalIncome = Object.values(incomeByCategory).reduce((a, b) => a + b, 0);
    const totalExpenses = Object.values(expensesByCategory).reduce((a, b) => a + b, 0);
    
    // Calculate Schedule E mapping
    const scheduleE = {
      line3: incomeByCategory['Rent Income'] || 0,
      line5: expensesByCategory['Advertising'] || 0,
      line6: expensesByCategory['Auto'] || 0,
      line7: expensesByCategory['Cleaning'] || expensesByCategory['Maintenance'] || 0,
      line9: expensesByCategory['Insurance'] || 0,
      line10: expensesByCategory['Legal & Professional'] || 0,
      line11: expensesByCategory['Property Management'] || 0,
      line12: expensesByCategory['Mortgage Interest'] || 0,
      line14: expensesByCategory['Repairs & Maintenance'] || 0,
      line15: expensesByCategory['Supplies'] || 0,
      line16: expensesByCategory['Property Tax'] || 0,
      line17: expensesByCategory['Utilities'] || 0,
      line19: Object.entries(expensesByCategory)
        .filter(([cat]) => !['Advertising', 'Auto', 'Cleaning', 'Insurance', 'Legal & Professional', 'Property Management', 'Mortgage Interest', 'Repairs & Maintenance', 'Supplies', 'Property Tax', 'Utilities'].includes(cat))
        .reduce((sum, [_, amt]) => sum + amt, 0)
    };
    
    res.json({
      ok: true,
      propertyId,
      propertyAddress: propertyAddress || 'Unknown Property',
      period: { start, end },
      incomeByCategory: Object.entries(incomeByCategory).map(([category, amount]) => ({ category, amount })),
      expensesByCategory: Object.entries(expensesByCategory).map(([category, amount]) => ({ category, amount })),
      monthlyTrend: Object.values(monthlyData).sort((a, b) => a.month.localeCompare(b.month)),
      scheduleE,
      summary: {
        totalIncome,
        totalExpenses,
        netIncome: totalIncome - totalExpenses,
        margin: totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome * 100).toFixed(1) : 0,
        transactionCount: transactions.length
      },
      recentTransactions: transactions.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20)
    });
  } catch (error) {
    console.error('Error getting property P&L detail:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/finance-documents
 * List uploaded finance documents for review, download, and search.
 */
router.get('/finance-documents', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const rawQuery = String(req.query.q || '').trim().toLowerCase();
    const docsRef = getFinanceDocumentsRef(userId);
    const snapshot = await docsRef.orderBy('createdAt', 'desc').limit(100).get();

    let documents = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    if (rawQuery) {
      documents = documents.filter((document) => ([
        document.title,
        document.documentType,
        document.vendorName,
        document.notes,
        document.originalFileName,
        document.contentPreview
      ].filter(Boolean).join(' ').toLowerCase().includes(rawQuery)));
    }

    const trimmed = documents.slice(0, limit);
    res.json({
      ok: true,
      documents: trimmed,
      search: {
        status: rawQuery ? 'loaded' : 'not_requested',
        provider: rawQuery ? 'local_filter' : 'browse'
      },
      overview: null
    });
  } catch (error) {
    console.error('Error listing finance documents:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/finance-documents
 * Upload a generic finance document and store OCR/evidence metadata.
 */
router.post('/finance-documents', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      title,
      documentType,
      propertyId = null,
      vendorName = null,
      documentDate = null,
      amount = null,
      notes = null,
      originalFileName = 'finance-document',
      fileBase64
    } = req.body || {};

    if (!title || !documentType || !fileBase64) {
      return res.status(400).json({ ok: false, error: 'title, documentType, and fileBase64 are required' });
    }

    const documentId = randomUUID();
    const storage = await persistLocalFinanceDocument({
      userId,
      documentId,
      fileBase64,
      originalFileName
    });
    const digitization = await maybeDigitizeFinanceDocument({
      fileBase64,
      originalFileName,
      title
    });

    let evidenceShadow = null;
    if (digitization?.contentPreview) {
      try {
        evidenceShadow = await persistFinanceEvidenceToAzure({
          userId,
          evidenceType: 'finance_document',
          title,
          sourceRef: `finance-document:${documentId}`,
          content: digitization.contentPreview,
          metadata: {
            financeDocumentId: documentId,
            documentType,
            propertyId,
            vendorName,
            documentDate,
            amount,
            originalFileName: storage.originalFileName
          }
        });
      } catch (evidenceError) {
        evidenceShadow = {
          status: 'failed',
          error: evidenceError.message || 'Failed to persist evidence shadow'
        };
      }
    }

    const now = new Date().toISOString();
    const documentRecord = {
      title: String(title).trim(),
      documentType: String(documentType).trim(),
      propertyId: propertyId || null,
      vendorName: vendorName || null,
      documentDate: documentDate || null,
      amount: amount == null || amount === '' ? null : roundCurrency(amount),
      notes: notes || null,
      mimeType: storage.mimeType || null,
      originalFileName: storage.originalFileName || null,
      storedRelativePath: storage.storedRelativePath,
      storedFileName: storage.storedFileName,
      downloadPath: storage.downloadPath,
      contentPreview: digitization?.contentPreview || null,
      extractedFields: digitization?.extractedFields || {},
      digitization: digitization?.metadata || {
        status: 'not_requested',
        supported: false
      },
      evidenceShadow,
      createdAt: now,
      updatedAt: now
    };

    await getFinanceDocumentsRef(userId).doc(documentId).set(documentRecord);

    res.json({
      ok: true,
      document: {
        id: documentId,
        ...documentRecord
      }
    });
  } catch (error) {
    console.error('Error uploading finance document:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/finance-documents/:documentId/file
 * Download the stored finance document file.
 */
router.get('/finance-documents/:documentId/file', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { documentId } = req.params;
    const snapshot = await getFinanceDocumentsRef(userId).doc(documentId).get();
    if (!snapshot.exists) {
      return res.status(404).json({ ok: false, error: 'Finance document not found' });
    }

    const document = snapshot.data() || {};
    const storedRelativePath = document.storedRelativePath;
    if (!storedRelativePath) {
      return res.status(404).json({ ok: false, error: 'Stored finance document file is missing' });
    }

    const absolutePath = getFinanceDocumentAbsolutePath(storedRelativePath);
    const downloadName = document.originalFileName || document.storedFileName || `${documentId}.bin`;
    res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.sendFile(absolutePath);
  } catch (error) {
    console.error('Error downloading finance document:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/budgets
 * Get all category budgets for the user
 */
router.get('/budgets', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const budgetsRef = getBudgetsRef(userId);
    const snapshot = await budgetsRef.get();
    
    let budgets = {};
    if (snapshot.empty) {
      // Initialize with defaults if none exist
      budgets = { ...DEFAULT_BUDGETS };
    } else {
      snapshot.forEach(doc => {
        budgets[doc.id] = doc.data();
      });
    }
    
    res.json({ ok: true, budgets });
  } catch (error) {
    console.error('Error getting budgets:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/budgets
 * Create or update a category budget
 */
router.post('/budgets', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { accountCode, category, monthlyBudget, annualBudget, notes } = req.body;
    
    if (!accountCode) {
      return res.status(400).json({ ok: false, error: 'accountCode is required' });
    }
    
    const budgetsRef = getBudgetsRef(userId);
    const budgetData = {
      category: category || SCHEDULE_E_CATEGORIES[accountCode]?.name || 'Unknown',
      monthlyBudget: monthlyBudget || 0,
      annualBudget: annualBudget || (monthlyBudget * 12) || 0,
      notes: notes || '',
      updatedAt: new Date().toISOString()
    };
    
    await budgetsRef.doc(accountCode).set(budgetData, { merge: true });
    
    res.json({ ok: true, budget: { accountCode, ...budgetData } });
  } catch (error) {
    console.error('Error saving budget:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/budgets/initialize
 * Initialize all default budgets for a user
 */
router.post('/budgets/initialize', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const budgetsRef = getBudgetsRef(userId);
    
    const batch = getFirestore().batch();
    
    for (const [accountCode, budgetData] of Object.entries(DEFAULT_BUDGETS)) {
      const docRef = budgetsRef.doc(accountCode);
      batch.set(docRef, {
        ...budgetData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, { merge: true });
    }
    
    await batch.commit();
    
    res.json({ ok: true, message: 'Budgets initialized', count: Object.keys(DEFAULT_BUDGETS).length });
  } catch (error) {
    console.error('Error initializing budgets:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/bookkeeping/firestore/budgets/:accountCode
 * Delete a category budget
 */
router.delete('/budgets/:accountCode', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { accountCode } = req.params;
    
    const budgetsRef = getBudgetsRef(userId);
    await budgetsRef.doc(accountCode).delete();
    
    res.json({ ok: true, message: 'Budget deleted' });
  } catch (error) {
    console.error('Error deleting budget:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/budget-vs-actual
 * Compare budgets against actual spending
 */
router.get('/budget-vs-actual', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, month } = req.query;
    
    const currentDate = new Date();
    const targetYear = parseInt(year) || currentDate.getFullYear();
    const targetMonth = month ? parseInt(month) : null; // null = YTD
    
    // Get budgets
    const budgetsRef = getBudgetsRef(userId);
    const budgetsSnapshot = await budgetsRef.get();
    
    let budgets = {};
    if (budgetsSnapshot.empty) {
      budgets = { ...DEFAULT_BUDGETS };
    } else {
      budgetsSnapshot.forEach(doc => {
        budgets[doc.id] = doc.data();
      });
    }
    
    // Get actual spending from journal entries
    const entriesRef = getJournalEntriesRef(userId);
    
    // Fetch all entries (we filter in memory since isExpense flag is used, not type field)
    const snapshot = await entriesRef.get();
    
    // Aggregate spending by account code
    const actualSpending = {};
    snapshot.forEach(doc => {
      const entry = doc.data();
      
      // Only expense entries
      if (entry.isExpense !== true && entry.type !== 'expense') return;
      
      const entryDate = entry.entryDate || entry.date || '';
      if (!entryDate) return;
      const dateParts = entryDate.split('-');
      const entryYear = parseInt(dateParts[0]);
      const entryMonth = parseInt(dateParts[1]);
      
      // Filter by year
      if (entryYear !== targetYear) return;
      
      // Filter by month if specified
      if (targetMonth !== null && entryMonth !== targetMonth) return;
      
      // Get account code from entry or from journal lines
      let accountCode = entry.accountCode;
      if (!accountCode) {
        const expenseLine = (entry.lines || []).find(l => l.dc === 'D' && l.accountCode !== '1000');
        accountCode = expenseLine?.accountCode || '5000';
      }
      const amount = Math.abs(parseFloat(entry.totalDebits) || parseFloat(entry.amount) || 0);
      
      if (!actualSpending[accountCode]) {
        actualSpending[accountCode] = 0;
      }
      actualSpending[accountCode] += amount;
    });
    
    // Calculate months elapsed for pro-rating annual budgets
    const monthsElapsed = targetMonth 
      ? 1 
      : (targetYear === currentDate.getFullYear() 
          ? currentDate.getMonth() + 1 
          : 12);
    
    // Build comparison
    const comparison = {};
    const allCodes = new Set([...Object.keys(budgets), ...Object.keys(actualSpending)]);
    
    for (const code of allCodes) {
      const budget = budgets[code] || { monthlyBudget: 0, annualBudget: 0 };
      const actual = actualSpending[code] || 0;
      
      // Pro-rate budget based on months elapsed
      const expectedBudget = targetMonth 
        ? budget.monthlyBudget 
        : budget.monthlyBudget * monthsElapsed;
      
      const variance = expectedBudget - actual;
      const variancePercent = expectedBudget > 0 ? (variance / expectedBudget) * 100 : 0;
      
      comparison[code] = {
        category: budget.category || SCHEDULE_E_CATEGORIES[code]?.name || 'Unknown',
        monthlyBudget: budget.monthlyBudget || 0,
        annualBudget: budget.annualBudget || 0,
        expectedBudget: Math.round(expectedBudget * 100) / 100,
        actual: Math.round(actual * 100) / 100,
        variance: Math.round(variance * 100) / 100,
        variancePercent: Math.round(variancePercent * 10) / 10,
        status: variance >= 0 ? 'under_budget' : 'over_budget',
        utilizationPercent: expectedBudget > 0 
          ? Math.round((actual / expectedBudget) * 100) 
          : (actual > 0 ? 999 : 0)
      };
    }
    
    // Summary stats
    const totalBudgeted = Object.values(comparison).reduce((sum, c) => sum + c.expectedBudget, 0);
    const totalActual = Object.values(comparison).reduce((sum, c) => sum + c.actual, 0);
    const overBudgetCount = Object.values(comparison).filter(c => c.status === 'over_budget').length;
    
    res.json({
      ok: true,
      year: targetYear,
      month: targetMonth,
      monthsElapsed,
      comparison,
      summary: {
        totalBudgeted: Math.round(totalBudgeted * 100) / 100,
        totalActual: Math.round(totalActual * 100) / 100,
        totalVariance: Math.round((totalBudgeted - totalActual) * 100) / 100,
        overBudgetCategories: overBudgetCount,
        utilizationPercent: totalBudgeted > 0 
          ? Math.round((totalActual / totalBudgeted) * 100) 
          : 0
      }
    });
  } catch (error) {
    console.error('Error getting budget vs actual:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===========================================
// RENT INVOICING ENDPOINTS
// ===========================================

/**
 * GET /api/bookkeeping/firestore/invoices
 * Get all invoices for the user with optional filters
 */
router.get('/invoices', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { status, propertyId, tenantId, startDate, endDate } = req.query;
    
    const invoicesRef = getInvoicesRef(userId);
    let query = invoicesRef.orderBy('dueDate', 'desc');
    
    const snapshot = await query.limit(100).get();
    
    let invoices = [];
    snapshot.forEach(doc => {
      const invoice = { id: doc.id, ...doc.data() };
      
      // Apply filters
      if (status && invoice.status !== status) return;
      if (propertyId && invoice.propertyId !== propertyId) return;
      if (tenantId && invoice.tenantId !== tenantId) return;
      if (startDate && invoice.dueDate < startDate) return;
      if (endDate && invoice.dueDate > endDate) return;
      
      invoices.push(invoice);
    });
    
    // Calculate summary stats
    const summary = {
      total: invoices.length,
      totalAmount: invoices.reduce((sum, inv) => sum + (inv.amount || 0), 0),
      paid: invoices.filter(inv => inv.status === 'paid').length,
      pending: invoices.filter(inv => inv.status === 'pending').length,
      overdue: invoices.filter(inv => inv.status === 'overdue').length,
      paidAmount: invoices.filter(inv => inv.status === 'paid').reduce((sum, inv) => sum + (inv.amount || 0), 0),
      pendingAmount: invoices.filter(inv => inv.status === 'pending' || inv.status === 'overdue').reduce((sum, inv) => sum + (inv.amount || 0), 0)
    };
    
    res.json({ ok: true, invoices, summary });
  } catch (error) {
    console.error('Error getting invoices:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/invoices
 * Create a new rent invoice
 */
router.post('/invoices', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      propertyId,
      propertyAddress,
      tenantId,
      tenantName,
      tenantEmail,
      amount,
      dueDate,
      description,
      lineItems,
      notes
    } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Valid amount is required' });
    }
    
    if (!dueDate) {
      return res.status(400).json({ ok: false, error: 'Due date is required' });
    }
    
    const invoicesRef = getInvoicesRef(userId);
    
    // Generate invoice number
    const year = new Date().getFullYear();
    const countSnapshot = await invoicesRef.where('createdYear', '==', year).get();
    const invoiceNumber = `INV-${year}-${String(countSnapshot.size + 1).padStart(4, '0')}`;
    
    const invoiceData = {
      invoiceNumber,
      propertyId: propertyId || null,
      propertyAddress: propertyAddress || '',
      tenantId: tenantId || null,
      tenantName: tenantName || '',
      tenantEmail: tenantEmail || '',
      amount: parseFloat(amount),
      dueDate,
      description: description || `Rent Payment - ${new Date(dueDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
      lineItems: lineItems || [{ description: 'Monthly Rent', amount: parseFloat(amount) }],
      notes: notes || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      createdYear: year,
      updatedAt: new Date().toISOString(),
      paidAt: null,
      paidAmount: 0,
      paymentMethod: null
    };
    
    const docRef = await invoicesRef.add(invoiceData);
    
    res.json({ ok: true, invoiceId: docRef.id, invoice: { id: docRef.id, ...invoiceData } });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * PUT /api/bookkeeping/firestore/invoices/:invoiceId
 * Update an invoice
 */
router.put('/invoices/:invoiceId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { invoiceId } = req.params;
    const updates = req.body;
    
    const invoicesRef = getInvoicesRef(userId);
    const docRef = invoicesRef.doc(invoiceId);
    
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'Invoice not found' });
    }
    
    // Prevent changing certain fields
    delete updates.id;
    delete updates.invoiceNumber;
    delete updates.createdAt;
    delete updates.createdYear;
    
    updates.updatedAt = new Date().toISOString();
    
    await docRef.update(updates);
    
    res.json({ ok: true, message: 'Invoice updated' });
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/invoices/:invoiceId/mark-paid
 * Mark an invoice as paid and create journal entry
 */
router.post('/invoices/:invoiceId/mark-paid', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { invoiceId } = req.params;
    const { paidAmount, paymentMethod, paymentDate, stripePaymentId } = req.body;
    
    const invoicesRef = getInvoicesRef(userId);
    const docRef = invoicesRef.doc(invoiceId);
    
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'Invoice not found' });
    }
    
    const invoice = doc.data();
    const payAmount = roundCurrency(paidAmount || invoice.amount);
    const payDate = paymentDate || new Date().toISOString().split('T')[0];

    if (!payAmount || payAmount <= 0) {
      return res.status(400).json({ ok: false, error: 'Valid paidAmount is required' });
    }

    const paymentSourceRef = `invoice_payment:${invoiceId}`;

    if (invoice.status === 'paid') {
      if (invoice.bookkeepingJournalEntryId || invoice.bookkeepingSourceRef === paymentSourceRef) {
        return res.json({
          ok: true,
          message: 'Invoice already marked as paid',
          journalCreated: false,
          noOp: true,
          journalEntryId: invoice.bookkeepingJournalEntryId || null
        });
      }

      const existingEntrySnapshot = await getJournalEntriesRef(userId)
        .where('invoiceId', '==', invoiceId)
        .limit(1)
        .get();

      if (!existingEntrySnapshot.empty) {
        const existingEntry = existingEntrySnapshot.docs[0];
        await docRef.update({
          bookkeepingJournalEntryId: existingEntry.id,
          bookkeepingSourceRef: existingEntry.data()?.sourceRef || paymentSourceRef,
          updatedAt: new Date().toISOString()
        });

        return res.json({
          ok: true,
          message: 'Invoice was already paid and linked to an existing journal entry',
          journalCreated: false,
          noOp: true,
          journalEntryId: existingEntry.id
        });
      }
    }

    const paymentMemo = `Rent payment - ${invoice.invoiceNumber} - ${invoice.tenantName || 'Tenant'}`;
    const paymentLines = [
      {
        accountCode: '1000',
        accountName: 'Operating Cash',
        amount: payAmount,
        dc: 'D',
        propertyId: invoice.propertyId || null,
        memo: paymentMemo
      },
      {
        accountCode: '4000',
        accountName: 'Rent Income',
        amount: payAmount,
        dc: 'C',
        propertyId: invoice.propertyId || null,
        memo: paymentMemo
      }
    ];

    const result = await createPostedJournalEntry(userId, {
      entryDate: payDate,
      memo: paymentMemo,
      source: 'INVOICE_PAYMENT',
      sourceRef: paymentSourceRef,
      lines: paymentLines,
      type: 'income',
      propertyId: invoice.propertyId || null,
      propertyAddress: invoice.propertyAddress || '',
      tenantId: invoice.tenantId || null,
      tenantName: invoice.tenantName || '',
      invoiceId,
      accountCode: '4000',
      category: 'Rent Income',
      scheduleELine: 3,
      amount: payAmount,
      originalAmount: payAmount,
      isExpense: false,
      description: paymentMemo,
      postedBy: req.user.email || req.user.uid
    });

    // Mark invoice paid only after the journal has been posted successfully.
    await docRef.update({
      status: 'paid',
      paidAt: new Date().toISOString(),
      paidAmount: payAmount,
      paymentMethod: paymentMethod || 'manual',
      paymentDate: payDate,
      stripePaymentId: stripePaymentId || null,
      bookkeepingJournalEntryId: result.journalEntryId,
      bookkeepingSourceRef: paymentSourceRef,
      updatedAt: new Date().toISOString()
    });
    
    res.json({
      ok: true,
      message: 'Invoice marked as paid',
      journalCreated: true,
      journalEntryId: result.journalEntryId,
      shadowLedger: result.shadowLedger
    });
  } catch (error) {
    console.error('Error marking invoice paid:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/bookkeeping/firestore/invoices/:invoiceId
 * Delete an invoice
 */
router.delete('/invoices/:invoiceId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { invoiceId } = req.params;
    
    const invoicesRef = getInvoicesRef(userId);
    await invoicesRef.doc(invoiceId).delete();
    
    res.json({ ok: true, message: 'Invoice deleted' });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/invoices/generate-recurring
 * Generate invoices from recurring templates
 */
router.post('/invoices/generate-recurring', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { targetMonth } = req.body; // Format: 'YYYY-MM'
    
    const recurringRef = getRecurringInvoicesRef(userId);
    const snapshot = await recurringRef.where('active', '==', true).get();
    
    if (snapshot.empty) {
      return res.json({ ok: true, message: 'No active recurring invoices', generated: 0 });
    }
    
    const invoicesRef = getInvoicesRef(userId);
    const generated = [];
    const [year, month] = (targetMonth || new Date().toISOString().slice(0, 7)).split('-').map(Number);
    
    for (const doc of snapshot.docs) {
      const template = doc.data();
      
      // Check if already generated for this month
      const existingSnapshot = await invoicesRef
        .where('recurringTemplateId', '==', doc.id)
        .where('dueDateMonth', '==', targetMonth || new Date().toISOString().slice(0, 7))
        .limit(1)
        .get();
      
      if (!existingSnapshot.empty) {
        continue; // Already generated
      }
      
      // Generate due date
      const dayOfMonth = template.dueDayOfMonth || 1;
      const dueDate = new Date(year, month - 1, dayOfMonth).toISOString().split('T')[0];
      
      // Generate invoice number
      const countSnapshot = await invoicesRef.where('createdYear', '==', year).get();
      const invoiceNumber = `INV-${year}-${String(countSnapshot.size + 1).padStart(4, '0')}`;
      
      const invoiceData = {
        invoiceNumber,
        recurringTemplateId: doc.id,
        propertyId: template.propertyId || null,
        propertyAddress: template.propertyAddress || '',
        tenantId: template.tenantId || null,
        tenantName: template.tenantName || '',
        tenantEmail: template.tenantEmail || '',
        amount: template.amount,
        dueDate,
        dueDateMonth: `${year}-${String(month).padStart(2, '0')}`,
        description: template.description || `Rent Payment - ${new Date(dueDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
        lineItems: template.lineItems || [{ description: 'Monthly Rent', amount: template.amount }],
        notes: template.notes || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        createdYear: year,
        updatedAt: new Date().toISOString(),
        paidAt: null,
        paidAmount: 0,
        paymentMethod: null
      };
      
      const newDoc = await invoicesRef.add(invoiceData);
      generated.push({ id: newDoc.id, ...invoiceData });
    }
    
    res.json({ ok: true, generated: generated.length, invoices: generated });
  } catch (error) {
    console.error('Error generating recurring invoices:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/recurring-invoices
 * Get all recurring invoice templates
 */
router.get('/recurring-invoices', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const recurringRef = getRecurringInvoicesRef(userId);
    const snapshot = await recurringRef.get();
    
    const templates = [];
    snapshot.forEach(doc => {
      templates.push({ id: doc.id, ...doc.data() });
    });
    
    res.json({ ok: true, templates });
  } catch (error) {
    console.error('Error getting recurring invoices:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/recurring-invoices
 * Create a recurring invoice template
 */
router.post('/recurring-invoices', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      propertyId,
      propertyAddress,
      tenantId,
      tenantName,
      tenantEmail,
      amount,
      dueDayOfMonth,
      description,
      lineItems,
      notes
    } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Valid amount is required' });
    }
    
    const recurringRef = getRecurringInvoicesRef(userId);
    
    const templateData = {
      propertyId: propertyId || null,
      propertyAddress: propertyAddress || '',
      tenantId: tenantId || null,
      tenantName: tenantName || '',
      tenantEmail: tenantEmail || '',
      amount: parseFloat(amount),
      dueDayOfMonth: dueDayOfMonth || 1,
      description: description || 'Monthly Rent',
      lineItems: lineItems || [{ description: 'Monthly Rent', amount: parseFloat(amount) }],
      notes: notes || '',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    const docRef = await recurringRef.add(templateData);
    
    res.json({ ok: true, templateId: docRef.id, template: { id: docRef.id, ...templateData } });
  } catch (error) {
    console.error('Error creating recurring invoice:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * PUT /api/bookkeeping/firestore/recurring-invoices/:templateId
 * Update a recurring invoice template
 */
router.put('/recurring-invoices/:templateId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { templateId } = req.params;
    const updates = req.body;
    
    const recurringRef = getRecurringInvoicesRef(userId);
    const docRef = recurringRef.doc(templateId);
    
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'Template not found' });
    }
    
    delete updates.id;
    delete updates.createdAt;
    updates.updatedAt = new Date().toISOString();
    
    await docRef.update(updates);
    
    res.json({ ok: true, message: 'Template updated' });
  } catch (error) {
    console.error('Error updating recurring invoice:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/bookkeeping/firestore/recurring-invoices/:templateId
 * Delete a recurring invoice template
 */
router.delete('/recurring-invoices/:templateId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { templateId } = req.params;
    
    const recurringRef = getRecurringInvoicesRef(userId);
    await recurringRef.doc(templateId).delete();
    
    res.json({ ok: true, message: 'Template deleted' });
  } catch (error) {
    console.error('Error deleting recurring invoice:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/accounts-receivable
 * Get accounts receivable summary with aging buckets
 */
router.get('/accounts-receivable', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const invoicesRef = getInvoicesRef(userId);
    
    // Get all unpaid invoices
    const snapshot = await invoicesRef
      .where('status', 'in', ['pending', 'overdue'])
      .get();
    
    const today = new Date();
    const aging = {
      current: { count: 0, amount: 0, invoices: [] },
      '1-30': { count: 0, amount: 0, invoices: [] },
      '31-60': { count: 0, amount: 0, invoices: [] },
      '61-90': { count: 0, amount: 0, invoices: [] },
      '90+': { count: 0, amount: 0, invoices: [] }
    };
    
    snapshot.forEach(doc => {
      const invoice = { id: doc.id, ...doc.data() };
      const dueDate = new Date(invoice.dueDate);
      const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
      
      let bucket;
      if (daysOverdue <= 0) {
        bucket = 'current';
      } else if (daysOverdue <= 30) {
        bucket = '1-30';
        // Update status to overdue if needed
        if (invoice.status !== 'overdue') {
          getInvoicesRef(userId).doc(doc.id).update({ status: 'overdue', updatedAt: new Date().toISOString() });
          invoice.status = 'overdue';
        }
      } else if (daysOverdue <= 60) {
        bucket = '31-60';
      } else if (daysOverdue <= 90) {
        bucket = '61-90';
      } else {
        bucket = '90+';
      }
      
      aging[bucket].count++;
      aging[bucket].amount += invoice.amount || 0;
      aging[bucket].invoices.push({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        tenantName: invoice.tenantName,
        propertyAddress: invoice.propertyAddress,
        amount: invoice.amount,
        dueDate: invoice.dueDate,
        daysOverdue: Math.max(0, daysOverdue)
      });
    });
    
    const totalOutstanding = Object.values(aging).reduce((sum, bucket) => sum + bucket.amount, 0);
    const totalCount = Object.values(aging).reduce((sum, bucket) => sum + bucket.count, 0);
    
    res.json({
      ok: true,
      aging,
      summary: {
        totalOutstanding,
        totalCount,
        averageDaysOutstanding: totalCount > 0 
          ? Math.round(
              Object.entries(aging).reduce((sum, [key, bucket]) => {
                const midpoint = key === 'current' ? 0 : key === '1-30' ? 15 : key === '31-60' ? 45 : key === '61-90' ? 75 : 120;
                return sum + (midpoint * bucket.count);
              }, 0) / totalCount
            )
          : 0
      }
    });
  } catch (error) {
    console.error('Error getting accounts receivable:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===========================================
// 1099 VENDOR MANAGEMENT ENDPOINTS
// ===========================================

function getVendorsRef(userId) {
  const db = getFirestore();
  return db.collection('users').doc(userId).collection('bookkeeping').doc('data').collection('vendors');
}

/**
 * GET /api/bookkeeping/firestore/vendors
 * Get all vendors with 1099 eligibility and YTD payments
 */
router.get('/vendors', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const targetYear = parseInt(year, 10) || new Date().getFullYear();
    const [rulesRuntime, savedVendors, entries] = await Promise.all([
      loadRuntimeTaxRulesetPackage(targetYear),
      listBookkeepingVendorMetadata(userId),
      fetchAllEntries(userId, targetYear)
    ]);
    const threshold1099 = getTax1099ThresholdFromRuleset(rulesRuntime.ruleset, targetYear);
    const vendorPayments = buildVendorPaymentsFromEntries(entries);
    
    // Build vendor list with saved info and calculated payments
    const vendors = [];
    const savedVendorNames = new Set();

    for (const vendor of savedVendors) {
      savedVendorNames.add(vendor.name);

      const payments = vendorPayments.get(vendor.name) || { totalPaid: 0, transactions: [] };

      vendors.push({
        ...vendor,
        ytdPaid: payments.totalPaid,
        transactionCount: payments.transactions.length,
        requires1099: vendor.vendorType !== 'corporation' && payments.totalPaid >= threshold1099,
        threshold1099
      });
    }
    
    // Add vendors from transactions that aren't in the saved list
    for (const [vendorName, payments] of vendorPayments.entries()) {
      if (!savedVendorNames.has(vendorName) && vendorName !== 'Unknown') {
        vendors.push({
          id: null,
          name: vendorName,
          vendorType: 'unknown',
          ein: null,
          address: null,
          email: null,
          phone: null,
          w9OnFile: false,
          ytdPaid: payments.totalPaid,
          transactionCount: payments.transactions.length,
          requires1099: payments.totalPaid >= threshold1099,
          threshold1099,
          needsSetup: true
        });
      }
    }
    
    // Sort by YTD paid descending
    vendors.sort((a, b) => b.ytdPaid - a.ytdPaid);
    
    // Summary stats
    const summary = {
      totalVendors: vendors.length,
      vendorsNeedingW9: vendors.filter(v => v.requires1099 && !v.w9OnFile).length,
      vendorsRequiring1099: vendors.filter(v => v.requires1099).length,
      total1099Amount: vendors.filter(v => v.requires1099).reduce((sum, v) => sum + v.ytdPaid, 0),
      vendorsNeedingSetup: vendors.filter(v => v.needsSetup).length
    };
    
    res.json({ ok: true, vendors, summary, year: targetYear, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime) });
  } catch (error) {
    console.error('Error getting vendors:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/bookkeeping/firestore/vendors
 * Create or update a vendor
 */
router.post('/vendors', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      name,
      vendorType, // individual, llc, partnership, scorp, ccorp, corporation
      ein,
      ssn, // Only for individuals, store securely
      address,
      city,
      state,
      zip,
      email,
      phone,
      w9OnFile,
      w9Date,
      notes
    } = req.body;
    
    if (!name) {
      return res.status(400).json({ ok: false, error: 'Vendor name is required' });
    }
    
    const canonicalResult = await upsertBookkeepingVendorInAzure({
      userId,
      name,
      vendorType,
      ein,
      ssn,
      address,
      city,
      state,
      zip,
      email,
      phone,
      w9OnFile,
      w9Date,
      notes
    }).catch((error) => {
      console.error('Error saving canonical vendor:', error);
      return { ok: false, status: 'failed', error: error.message, vendor: null };
    });

    const readyCanonicalVendorSave = requireCanonicalLedgerResult(canonicalResult, `vendor save ${name}`);
    return res.json({ ok: true, vendorId: readyCanonicalVendorSave.vendor?.id || null, vendor: readyCanonicalVendorSave.vendor });

    if (shouldUseCanonicalLedger(canonicalResult)) {
      return res.json({ ok: true, vendorId: canonicalResult.vendor?.id || null, vendor: canonicalResult.vendor });
    }

    const vendorsRef = getVendorsRef(userId);
    const existingSnapshot = await vendorsRef.where('name', '==', name).limit(1).get();
    const vendorData = {
      name,
      vendorType: vendorType || 'unknown',
      ein: ein || null,
      ssnLast4: ssn ? ssn.slice(-4) : null,
      address: address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      email: email || null,
      phone: phone || null,
      w9OnFile: w9OnFile || false,
      w9Date: w9Date || null,
      notes: notes || '',
      updatedAt: new Date().toISOString()
    };
    let docRef;
    if (!existingSnapshot.empty) {
      docRef = existingSnapshot.docs[0].ref;
      await docRef.update(vendorData);
    } else {
      vendorData.createdAt = new Date().toISOString();
      docRef = await vendorsRef.add(vendorData);
    }
    
    res.json({ ok: true, vendorId: docRef.id, vendor: { id: docRef.id, ...vendorData } });
  } catch (error) {
    console.error('Error saving vendor:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * DELETE /api/bookkeeping/firestore/vendors/:vendorId
 * Delete a vendor
 */
router.delete('/vendors/:vendorId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { vendorId } = req.params;

    const canonicalResult = await deleteBookkeepingVendorFromAzure({ userId, vendorId }).catch((error) => {
      console.error('Error deleting canonical vendor:', error);
      return { ok: false, status: 'failed', error: error.message, deleted: false };
    });

    requireCanonicalLedgerResult(canonicalResult, `vendor delete ${vendorId}`);
    return res.json({ ok: true, message: 'Vendor deleted' });

    if (shouldUseCanonicalLedger(canonicalResult)) {
      return res.json({ ok: true, message: 'Vendor deleted' });
    }
    
    const vendorsRef = getVendorsRef(userId);
    await vendorsRef.doc(vendorId).delete();
    
    res.json({ ok: true, message: 'Vendor deleted' });
  } catch (error) {
    console.error('Error deleting vendor:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/1099-report
 * Generate 1099-NEC/MISC report for tax year
 */
router.get('/1099-report', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const targetYear = parseInt(year, 10) || new Date().getFullYear() - 1; // Default to last year for tax filing
    const [rulesRuntime, vendors, entries] = await Promise.all([
      loadRuntimeTaxRulesetPackage(targetYear),
      fetchUserVendors(userId),
      fetchAllEntries(userId, targetYear)
    ]);
    const threshold1099 = getTax1099ThresholdFromRuleset(rulesRuntime.ruleset, targetYear);
    const vendorPayments = buildVendorPaymentsFromEntries(entries);
    const vendorInfo = Object.fromEntries(vendors.map((vendor) => [vendor.name, vendor]));
    
    // Build 1099 report
    const forms1099 = [];
    
    for (const [vendorName, paymentSummary] of vendorPayments.entries()) {
      const totalPaid = paymentSummary.totalPaid;
      if (totalPaid < threshold1099) continue; // Below 1099 threshold
      
      const info = vendorInfo[vendorName] || {};
      
      // Skip corporations (C-corps) - they don't get 1099s
      if (info.vendorType === 'ccorp' || info.vendorType === 'corporation') continue;
      
      forms1099.push({
        recipientName: vendorName,
        recipientTIN: info.ein || (info.ssnLast4 ? `***-**-${info.ssnLast4}` : 'MISSING'),
        recipientAddress: info.address ? `${info.address}, ${info.city || ''} ${info.state || ''} ${info.zip || ''}` : 'MISSING',
        amount: Math.round(totalPaid * 100) / 100,
        formType: info.vendorType === 'individual' ? '1099-NEC' : '1099-NEC', // Box 1 for NEC
        box: 1, // Nonemployee compensation
        w9OnFile: info.w9OnFile || false,
        missingInfo: []
      });
      
      // Flag missing info
      const form = forms1099[forms1099.length - 1];
      if (!info.ein && !info.ssnLast4) form.missingInfo.push('TIN');
      if (!info.address) form.missingInfo.push('Address');
      if (!info.w9OnFile) form.missingInfo.push('W-9');
    }
    
    // Sort by amount descending
    forms1099.sort((a, b) => b.amount - a.amount);
    
    const summary = {
      taxYear: targetYear,
      totalForms: forms1099.length,
      totalAmount: forms1099.reduce((sum, f) => sum + f.amount, 0),
      formsWithMissingInfo: forms1099.filter(f => f.missingInfo.length > 0).length,
      formsReady: forms1099.filter(f => f.missingInfo.length === 0 && f.w9OnFile).length,
      threshold1099,
      filingDeadline: `${parseInt(targetYear) + 1}-01-31` // January 31 of following year
    };
    
    res.json({ ok: true, forms1099, summary, year: targetYear, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime) });
  } catch (error) {
    console.error('Error generating 1099 report:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===========================================
// TAX CENTER ENDPOINTS (Firestore-backed)
// ===========================================

/**
 * Helper: Fetch all journal entries for a user (for tax calculations)
 * Normalizes field names so the tax engine gets consistent data:
 *   entryDate → date, memo → description, payee → vendor,
 *   originalAmount/totalDebits → amount
 * Also normalizes category names to match SCHEDULE_E_LINE_MAP categories.
 */
async function fetchAllEntries(userId, year, propertyId = null) {
  const taxYear = parseInt(year, 10);
  const startDate = Number.isInteger(taxYear) ? `${taxYear}-01-01` : null;
  const endDate = Number.isInteger(taxYear) ? `${taxYear}-12-31` : null;

  try {
    const { entries } = await loadCanonicalLedgerEntriesForScope({
      userId,
      startDate,
      endDate,
      propertyId: propertyId || null,
      limit: 20000,
      errorLabel: 'tax ledger entries',
    });
    return mapCanonicalEntriesForTax(entries || []);
  } catch (error) {
    console.error('[Bookkeeping Tax] Canonical fetchAllEntries error:', error);
    return [];
  }
}

/**
 * Helper: Fetch properties for a user (for depreciation)
 */
function resolvePropertyMortgageLender(property = {}) {
  return property.mortgageLender
    || property.attomMortgageLender
    || property.metadata?.mortgageLender
    || property.metadata?.attomMortgageLender
    || null;
}

/**
 * Backfill mortgage lender metadata from cached ATTOM property data when the
 * bookkeeping property record is missing it but ATTOM was already fetched.
 */
async function enrichPropertiesMortgageFromAttomCache(userId, properties = []) {
  if (!userId || !Array.isArray(properties) || properties.length === 0) {
    return properties;
  }

  const { getCachedAttomData } = await import('./attom-firestore-cache.js');
  const enriched = [];

  for (const property of properties) {
    if (resolvePropertyMortgageLender(property) || !property.address) {
      enriched.push(property);
      continue;
    }

    try {
      const cached = await getCachedAttomData(property.address);
      const mortgage = cached?.data?.summary?.mortgage;
      const lenderName = mortgage?.lender_name || mortgage?.lender || null;
      if (!lenderName) {
        enriched.push(property);
        continue;
      }

      const metadata = {
        mortgageLender: String(lenderName).trim(),
        attomMortgageLender: String(lenderName).trim(),
        attomMortgageAmount: mortgage?.amount ?? null,
        attomMortgageRate: mortgage?.estimated_interest_rate ?? mortgage?.rate ?? null,
        mortgageDate: mortgage?.date ?? null,
        mortgageTermMonths: mortgage?.term ?? mortgage?.termMonths ?? null,
        attomEnrichedAt: new Date().toISOString(),
      };

      await mergeBookkeepingPropertyMetadataInAzure({
        userId,
        propertyId: property.id,
        metadata,
      });

      enriched.push({ ...property, ...metadata });
    } catch (error) {
      console.warn('[Bookkeeping] ATTOM mortgage enrichment skipped for property', property.id, error.message);
      enriched.push(property);
    }
  }

  return enriched;
}

async function fetchUserProperties(userId) {
  const properties = await listBookkeepingPropertyMetadata(userId);
  return enrichPropertiesMortgageFromAttomCache(userId, properties);
}

async function fetchUserVendors(userId) {
  return listBookkeepingVendorMetadata(userId);
}

async function listEstimatedTaxPayments(userId, taxYear) {
  const canonicalResult = await listEstimatedTaxPaymentsFromAzure({ userId, taxYear }).catch((error) => {
    console.error('[Bookkeeping] Canonical estimated payment list error:', error);
    return { ok: false, status: 'failed', error: error.message, payments: [] };
  });

  const readyCanonicalResult = requireCanonicalLedgerResult(canonicalResult, `estimated tax payments ${taxYear}`);
  return readyCanonicalResult.payments || [];
}

function buildInlineExportArtifactPath(taxYear, filename) {
  return `inline-downloads/${taxYear}/${filename}`;
}

function buildImmutableArtifactRecord({
  artifactContent,
  filename,
  format,
  contentType,
  includeTaxEstimate = false,
  metadata = {}
}) {
  const contentBuffer = Buffer.isBuffer(artifactContent)
    ? artifactContent
    : Buffer.from(String(artifactContent ?? ''), 'utf8');
  const recordedAt = new Date().toISOString();

  return {
    filename,
    format,
    contentType,
    sha256: createHash('sha256').update(contentBuffer).digest('hex'),
    sizeBytes: contentBuffer.byteLength,
    recordedAt,
    metadata: {
      kind: 'inline_response',
      includeTaxEstimate,
      ...metadata
    }
  };
}

function applyArtifactHeaders(res, storage) {
  if (!storage?.artifactRecord) {
    return;
  }

  const { artifactRecord } = storage;
  if (artifactRecord.sha256) {
    res.setHeader('X-HouseYield-Artifact-Sha256', artifactRecord.sha256);
  }
  if (artifactRecord.sizeBytes != null) {
    res.setHeader('X-HouseYield-Artifact-Size-Bytes', String(artifactRecord.sizeBytes));
  }
  if (artifactRecord.recordedAt) {
    res.setHeader('X-HouseYield-Artifact-Recorded-At', artifactRecord.recordedAt);
  }
}

async function recordGeneratedWorkpaperArtifact({
  user,
  taxYear,
  packetType,
  snapshot,
  filename,
  exportFormat,
  includeTaxEstimate = false,
  artifactContent = null,
  contentType = null,
  artifactMetadata = null
}) {
  return persistWorkpaperSnapshotToAzure({
    userId: user.uid,
    taxYear,
    packetType,
    snapshot: {
      ...snapshot,
      exportArtifact: {
        ...(snapshot?.exportArtifact || {}),
        filename,
        format: exportFormat,
        includeTaxEstimate,
        generatedAt: new Date().toISOString()
      }
    },
    artifactPath: buildInlineExportArtifactPath(taxYear, filename),
    artifactRecord: artifactContent == null
      ? null
      : buildImmutableArtifactRecord({
          artifactContent,
          filename,
          format: exportFormat,
          contentType,
          includeTaxEstimate,
          metadata: artifactMetadata || null
        }),
    createdBy: user.email || user.uid
  });
}

function buildTax1099FilingRecords({ taxYear, filingResult, eligibleVendors, filedAt }) {
  const vendorIndex = new Map((eligibleVendors || []).map((vendor) => [vendor.name, vendor]));

  return (filingResult.forms || []).map((form, index) => {
    const vendor = vendorIndex.get(form.vendorName) || {};
    return {
      id: form.formId || `${filingResult.filingId || 'tax1099'}:${index + 1}`,
      filingId: filingResult.filingId || null,
      confirmationNumber: filingResult.filingId || null,
      formId: form.formId || null,
      recipientName: form.vendorName,
      amount: roundCurrency(form.amount || vendor.totalPaid || 0),
      status: 'pending',
      filedAt,
      taxYear,
      vendorId: vendor.id || null
    };
  });
}

function buildTax1099FilingSnapshot({ taxYear, payerInfo, filingResult, filingRecords, filedAt }) {
  return {
    rulesVersion: `${ACCOUNTING_DOMAIN_VERSION}.tax1099`,
    packetReadiness: 'filed',
    summary: {
      taxYear,
      filingId: filingResult.filingId || null,
      payerName: payerInfo?.name || null,
      filedAt,
      vendorCount: filingRecords.length,
      totalAmount: roundCurrency(filingRecords.reduce((sum, filing) => sum + Number(filing.amount || 0), 0)),
      filedCount: filingResult.summary?.filed || filingRecords.length,
      createdCount: filingResult.summary?.created || filingRecords.length,
      failedCount: filingResult.summary?.failed || 0,
      errors: filingResult.errors || [],
      filings: filingRecords
    }
  };
}

async function persistTax1099FilingHistoryToAzure({ user, taxYear, payerInfo, eligibleVendors, filingResult }) {
  const filedAt = new Date().toISOString();
  const filingRecords = buildTax1099FilingRecords({
    taxYear,
    filingResult,
    eligibleVendors,
    filedAt
  });
  const snapshot = buildTax1099FilingSnapshot({
    taxYear,
    payerInfo,
    filingResult,
    filingRecords,
    filedAt
  });

  const storage = await persistWorkpaperSnapshotToAzure({
    userId: user.uid,
    taxYear,
    packetType: `tax1099_filing_${filingResult.filingId || filedAt.slice(0, 10)}`,
    snapshot,
    artifactPath: `tax1099/${taxYear}/${filingResult.filingId || filedAt}`,
    createdBy: user.email || user.uid
  });

  return {
    storage,
    filingRecords,
    filedAt
  };
}

async function listTax1099FilingHistoryFromAzure({ userId, taxYear, limit = 20 }) {
  const snapshots = await listWorkpaperSnapshotsFromAzure({
    userId,
    taxYear,
    packetTypeLike: 'tax1099_filing%',
    limit
  });

  if (snapshots.status !== 'loaded') {
    return {
      ok: snapshots.ok,
      status: snapshots.status,
      filings: []
    };
  }

  const filings = (snapshots.snapshots || [])
    .flatMap((snapshot) => {
      const storedFilings = Array.isArray(snapshot.summary?.filings) ? snapshot.summary.filings : [];
      return storedFilings.map((filing) => ({
        ...filing,
        workpaperSnapshotId: snapshot.workpaperSnapshotId
      }));
    })
    .sort((left, right) => new Date(right.filedAt || 0).getTime() - new Date(left.filedAt || 0).getTime());

  return {
    ok: true,
    status: 'loaded',
    filings
  };
}

/**
 * GET /api/bookkeeping/firestore/tax/debug-entries
 * Debug: Show raw entries with category info for troubleshooting Schedule E mapping
 */
router.get('/tax/debug-entries', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    const entries = await fetchAllEntries(userId, taxYear, propertyId || null);
    
    // Show category distribution
    const categoryCounts = {};
    const unmapped = [];
    const { CATEGORY_TO_LINE: catMap } = await import('./tax-engine-firestore.js');
    
    entries.forEach(e => {
      const cat = e.category || 'UNCATEGORIZED';
      if (!categoryCounts[cat]) categoryCounts[cat] = { count: 0, totalAmount: 0, mapped: !!catMap[cat] };
      categoryCounts[cat].count++;
      categoryCounts[cat].totalAmount += Math.abs(e.amount || 0);
      if (!catMap[cat] && cat !== 'UNCATEGORIZED') {
        unmapped.push({ id: e.id, category: cat, memo: e.description, amount: e.amount });
      }
    });

    res.json({
      ok: true,
      totalEntries: entries.length,
      categoryCounts,
      unmappedCategories: [...new Set(unmapped.map(u => u.category))],
      unmappedSample: unmapped.slice(0, 10),
      sampleEntries: entries.slice(0, 5).map(e => ({
        id: e.id, date: e.date, category: e.category, amount: e.amount,
        description: e.description, isExpense: e.isExpense, scheduleELine: e.scheduleELine,
        accountCode: e.accountCode
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/schedule-e
 * Generate full IRS Schedule E from Firestore journal entries
 */
router.get('/tax/schedule-e', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    console.log(`\n🔍 [Schedule E DEBUG] userId=${userId}, taxYear=${taxYear}`);
    const entries = await fetchAllEntries(userId, taxYear, propertyId || null);
    console.log(`🔍 [Schedule E DEBUG] fetchAllEntries returned ${entries.length} entries`);
    
    // Log category distribution
    const catCounts = {};
    entries.forEach(e => {
      const c = e.category || 'NO_CATEGORY';
      catCounts[c] = (catCounts[c] || 0) + 1;
    });
    console.log(`🔍 [Schedule E DEBUG] Categories:`, JSON.stringify(catCounts));
    
    // Log first 3 entries to see field shapes
    console.log(`🔍 [Schedule E DEBUG] Sample entries:`, entries.slice(0, 3).map(e => ({
      id: e.id, date: e.date, category: e.category, amount: e.amount,
      description: e.description, source: e.source
    })));

    const [rulesRuntime, properties] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchUserProperties(userId)
    ]);
    const scheduleE = generateScheduleE(entries, taxYear, propertyId || null, properties, rulesRuntime.ruleset);
    const scopedProperties = await resolveScopedBookkeepingProperties(userId, propertyId || null, properties);
    const depreciation = calculateDepreciation(
      propertyId ? scopedProperties : properties,
      taxYear,
      rulesRuntime.ruleset,
    );
    const exportScheduleE = buildScheduleEExportModel(scheduleE, depreciation);
    console.log(`🔍 [Schedule E DEBUG] Result summary:`, scheduleE.summary);
    console.log(`🔍 [Schedule E DEBUG] Non-zero lines:`, Object.entries(scheduleE.scheduleELines)
      .filter(([, v]) => v.amount > 0)
      .map(([k, v]) => `${k}: $${v.amount} (${v.entries.length} entries)`)
    );

    res.json({ ok: true, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime), ...exportScheduleE });
  } catch (error) {
    console.error('Error generating Schedule E:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/depreciation
 * Calculate depreciation schedule for all properties
 */
router.get('/tax/depreciation', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, properties] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchUserProperties(userId)
    ]);
    const depreciation = calculateDepreciation(properties, taxYear, rulesRuntime.ruleset);

    res.json({ ok: true, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime), ...depreciation });
  } catch (error) {
    console.error('Error calculating depreciation:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/properties
 * Add/update a property for depreciation tracking
 */
router.post('/tax/properties', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      id, name, address, state, purchaseDate, purchasePrice,
      landValue, improvementValue, description, usefulLifeMonths,
      fairRentalDays, personalUseDays
    } = req.body;

    if (!name && !address) {
      return res.status(400).json({ ok: false, error: 'Property name or address required' });
    }

    const canonicalResult = await upsertBookkeepingPropertyInAzure({
      userId,
      id,
      name,
      address,
      state,
      purchaseDate,
      purchasePrice,
      landValue,
      improvementValue,
      description,
      usefulLifeMonths,
      fairRentalDays,
      personalUseDays
    }).catch((error) => {
      console.error('Error saving canonical property:', error);
      return { ok: false, status: 'failed', error: error.message, property: null };
    });

    const readyCanonicalPropertySave = requireCanonicalLedgerResult(canonicalResult, `tax property save ${id || name || address || 'property'}`);
    return res.json({ ok: true, propertyId: readyCanonicalPropertySave.property?.id || null, property: readyCanonicalPropertySave.property });
  } catch (error) {
    console.error('Error saving property:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * PATCH /api/bookkeeping/firestore/tax/properties/:propertyId/usage-days
 * Update fair rental days and personal use days for 14-day rule / §280A
 */
router.patch('/tax/properties/:propertyId/usage-days', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId } = req.params;
    const { fairRentalDays, personalUseDays } = req.body;

    const canonicalResult = await patchBookkeepingPropertyUsageDaysInAzure({
      userId,
      propertyId,
      fairRentalDays,
      personalUseDays
    }).catch((error) => {
      if (error.statusCode === 404) {
        throw error;
      }
      console.error('Error updating canonical usage days:', error);
      return { ok: false, status: 'failed', error: error.message, property: null };
    });

    const readyCanonicalUsageDays = requireCanonicalLedgerResult(canonicalResult, `tax property usage-days ${propertyId}`);
    return res.json({
      ok: true,
      propertyId,
      fairRentalDays: readyCanonicalUsageDays.property?.fairRentalDays ?? null,
      personalUseDays: readyCanonicalUsageDays.property?.personalUseDays ?? null,
      updatedAt: readyCanonicalUsageDays.property?.updatedAt || null
    });
  } catch (error) {
    console.error('Error updating usage days:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * PATCH /api/bookkeeping/firestore/tax/properties/:propertyId/enrich-mortgage
 * Merge ATTOM mortgage metadata (lender, rate, amount) into a property record
 * without touching any other fields. Called from the client when ATTOM property
 * data is available (e.g. after viewing the property detail panel).
 */
router.patch('/tax/properties/:propertyId/enrich-mortgage', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId } = req.params;
    const { mortgageLender, mortgageAmount, mortgageRate, mortgageDate, mortgageTermMonths } = req.body;

    if (!mortgageLender && !mortgageAmount) {
      return res.status(400).json({ ok: false, error: 'At least mortgageLender or mortgageAmount is required' });
    }

    const metadata = {};
    if (mortgageLender) {
      metadata.mortgageLender = String(mortgageLender).trim();
      metadata.attomMortgageLender = String(mortgageLender).trim();
    }
    if (mortgageAmount != null) metadata.attomMortgageAmount = Number(mortgageAmount);
    if (mortgageRate != null) metadata.attomMortgageRate = Number(mortgageRate);
    if (mortgageDate) metadata.mortgageDate = String(mortgageDate);
    if (mortgageTermMonths != null) metadata.mortgageTermMonths = Number(mortgageTermMonths);
    metadata.attomEnrichedAt = new Date().toISOString();

    const result = await mergeBookkeepingPropertyMetadataInAzure({ userId, propertyId, metadata }).catch((error) => {
      if (error.statusCode === 404) throw error;
      console.error('[enrich-mortgage] Error merging property metadata:', error);
      return { ok: false, status: 'failed', error: error.message };
    });

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error || 'Failed to enrich property metadata' });
    }

    return res.json({ ok: true, propertyId, enriched: metadata });
  } catch (error) {
    console.error('Error enriching property mortgage metadata:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /api/bookkeeping/firestore/tax/properties/:propertyId
 */
router.delete('/tax/properties/:propertyId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { propertyId } = req.params;

    const canonicalResult = await deleteBookkeepingPropertyFromAzure({ userId, propertyId }).catch((error) => {
      console.error('Error deleting canonical property:', error);
      return { ok: false, status: 'failed', error: error.message, deleted: false };
    });

    requireCanonicalLedgerResult(canonicalResult, `tax property delete ${propertyId}`);
    return res.json({ ok: true, message: 'Property deleted' });
  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/properties
 * List all properties
 */
router.get('/tax/properties', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const properties = await fetchUserProperties(userId);
    res.json({ ok: true, properties });
  } catch (error) {
    console.error('Error fetching properties:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/calculate
 * Full tax liability calculation with federal + state + NIIT + passive loss
 */
router.post('/tax/calculate', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      year,
      filingStatus = 'single',
      otherIncome = 0,
      otherDeductions = 0,
      taxCredits = 0,
      withholdingYtd = 0,
      stateWithholdingYtd = null,
      rentalServiceHours = null,
      homeState = null,
      propertyStates = [],
      propertyId = null,
      priorYearTotalTax = null,
      priorYearAdjustedGrossIncome = null,
    } = req.body;

    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties, stateWithholding] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear, propertyId || null),
      fetchUserProperties(userId),
      resolveStateWithholdingInput({ userId, taxYear, requestValue: stateWithholdingYtd })
    ]);

    const scopedProperties = await resolveScopedBookkeepingProperties(userId, propertyId || null, properties);
    const scheduleE = generateScheduleE(entries, taxYear, propertyId, properties, rulesRuntime.ruleset);
    const depreciation = calculateDepreciation(
      propertyId ? scopedProperties : properties,
      taxYear,
      rulesRuntime.ruleset,
    );
    const rentalStates = collectRentalStates(propertyId ? scopedProperties : properties);

    const result = calculateTaxLiability(
      {
        taxYear,
        filingStatus,
        otherIncome: sanitizeTaxScenarioOtherIncome(otherIncome),
        otherDeductions: parseOptionalMoney(otherDeductions) || 0,
        taxCredits: parseOptionalMoney(taxCredits) || 0,
        withholdingYtd: parseOptionalMoney(withholdingYtd) || 0,
        stateWithholdingYtd: stateWithholding.value,
        stateWithholdingSource: stateWithholding.source,
        rentalServiceHours: parseOptionalMoney(rentalServiceHours),
        homeState,
        propertyStates,
        propertyId,
        priorYearTotalTax: parseOptionalMoney(priorYearTotalTax),
        priorYearAdjustedGrossIncome: parseOptionalMoney(priorYearAdjustedGrossIncome),
        rentalStates,
      },
      scheduleE,
      depreciation,
      rulesRuntime.ruleset
    );

    res.json({
      ok: true,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime),
      ...result,
      stateWithholding: {
        ...(result.stateWithholding || {}),
        derivation: stateWithholding.derivation,
      },
    });
  } catch (error) {
    console.error('Error calculating tax:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/year-summary
 * High-level year summary (replaces old SQLite version)
 */
router.get('/tax/year-summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, propertyId } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    console.log(`\n🔍 [Year Summary DEBUG] userId=${userId}, taxYear=${taxYear}`);
    const [rulesRuntime, entries, properties] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear, propertyId || null),
      fetchUserProperties(userId)
    ]);
    console.log(`🔍 [Year Summary DEBUG] fetchAllEntries returned ${entries.length} entries`);
    console.log(`🔍 [Year Summary DEBUG] ${properties.length} properties`);

    const scopedEntries = entries;
    const scopedProperties = await resolveScopedBookkeepingProperties(userId, propertyId || null, properties);

    const scheduleE = generateScheduleE(entries, taxYear, propertyId || null, properties, rulesRuntime.ruleset);
    console.log(`🔍 [Year Summary DEBUG] scheduleE summary:`, scheduleE.summary);
    const depreciation = calculateDepreciation(
      propertyId ? scopedProperties : properties,
      taxYear,
      rulesRuntime.ruleset,
    );

    // Summarize by category
    const categoryBreakdown = {};
    scopedEntries.forEach(e => {
      const cat = e.category || 'Uncategorized';
      if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { count: 0, total: 0 };
      categoryBreakdown[cat].count += 1;
      categoryBreakdown[cat].total += parseFloat(e.amount) || 0;
    });

    res.json({
      ok: true,
      taxYear,
      scheduleE: scheduleE.summary,
      depreciation: depreciation.summary,
      entryCount: scopedEntries.length,
      propertyCount: scopedProperties.length,
      categoryBreakdown,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime),
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting year summary:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/missed-deductions
 * Find commonly missed deductions
 */
router.get('/tax/missed-deductions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId)
    ]);

    const scheduleE = generateScheduleE(entries, taxYear, null, properties, rulesRuntime.ruleset);
    const depreciation = calculateDepreciation(properties, taxYear, rulesRuntime.ruleset);
    const missed = findMissedDeductions(scheduleE, depreciation, entries);

    res.json({ ok: true, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime), ...missed });
  } catch (error) {
    console.error('Error finding missed deductions:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/year-over-year
 * Compare tax data with prior year
 */
router.get('/tax/year-over-year', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const currentEntries = await fetchAllEntries(userId, taxYear);
    const priorEntries = await fetchAllEntries(userId, taxYear - 1);

    const comparison = yearOverYearComparison(currentEntries, priorEntries, taxYear);

    res.json({ ok: true, ...comparison });
  } catch (error) {
    console.error('Error comparing year-over-year:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/tax/workpaper-snapshot', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, homeState } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties, vendors, draftProfile] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId),
      loadTaxDraftProfile(userId, taxYear, String(homeState || ''))
    ]);

    const snapshot = {
      ...buildTaxWorkpaperSnapshot({
        taxYear,
        entries,
        properties,
        vendors,
        ruleset: rulesRuntime.ruleset
      }),
      draftFormProfile: draftProfile.profile,
      draftFormProfileUpdatedAt: draftProfile.updatedAt,
      draftFormProfileUpdatedBy: draftProfile.updatedBy,
    };

    res.json({ ok: true, snapshot, draftFormProfile: draftProfile.profile, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime) });
  } catch (error) {
    console.error('Error building workpaper snapshot:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/tax/draft-form-profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, homeState } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    const profileState = await loadTaxDraftProfile(userId, taxYear, String(homeState || ''));

    res.json({
      ok: true,
      taxYear,
      profile: profileState.profile,
      updatedAt: profileState.updatedAt,
      updatedBy: profileState.updatedBy,
    });
  } catch (error) {
    console.error('Error loading tax draft form profile:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.post('/tax/draft-form-profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, homeState, profile } = req.body || {};
    const taxYear = parseInt(year) || new Date().getFullYear();
    const savedProfile = await persistTaxDraftProfile(userId, taxYear, profile || {}, req.user.email || req.user.uid, String(homeState || ''));

    res.json({ ok: true, ...savedProfile });
  } catch (error) {
    console.error('Error saving tax draft form profile:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.post('/tax/workpaper-snapshot', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, packetType = 'cpa_packet_draft', artifactPath = null, draftFormProfile = null, homeState = '' } = req.body || {};
    const taxYear = parseInt(year) || new Date().getFullYear();
    const actor = req.user.email || req.user.uid;

    const [rulesRuntime, entries, properties, vendors] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId)
    ]);

    const persistedDraftProfile = await persistTaxDraftProfile(
      userId,
      taxYear,
      draftFormProfile || {},
      actor,
      String(homeState || ''),
    );

    const snapshot = {
      ...buildTaxWorkpaperSnapshot({
        taxYear,
        entries,
        properties,
        vendors,
        ruleset: rulesRuntime.ruleset
      }),
      draftFormProfile: persistedDraftProfile.profile,
      draftFormProfileUpdatedAt: persistedDraftProfile.updatedAt,
      draftFormProfileUpdatedBy: persistedDraftProfile.updatedBy,
    };

    const storage = await persistWorkpaperSnapshotToAzure({
      taxYear,
      userId,
      taxYear,
      packetType,
      snapshot,
      artifactPath,
      createdBy: actor
    });

    res.json({ ok: true, snapshot, draftFormProfile: persistedDraftProfile.profile, storage, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime) });
  } catch (error) {
    console.error('Error persisting workpaper snapshot:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/tax/packet-releases', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, limit = 12 } = req.query;
    const taxYear = year ? (parseInt(year) || new Date().getFullYear()) : null;
    const releases = await listWorkpaperSnapshotsFromAzure({
      userId,
      taxYear,
      packetTypeLike: 'packet_release_%',
      limit
    });

    if (releases.status !== 'loaded') {
      const releasesError = new Error(`Canonical packet release history unavailable${releases.error ? `: ${releases.error}` : ''}`);
      releasesError.statusCode = 503;
      releasesError.details = {
        canonicalStatus: releases.status || 'unknown',
        canonicalError: releases.error || null
      };
      throw releasesError;
    }

    res.json({
      ok: true,
      status: releases.status,
      releases: releases.snapshots || []
    });
  } catch (error) {
    console.error('Error listing packet releases:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.get('/tax/packet-release-intelligence', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties, vendors] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId)
    ]);

    const snapshot = buildTaxWorkpaperSnapshot({
      taxYear,
      entries,
      properties,
      vendors,
      ruleset: rulesRuntime.ruleset
    });

    const [evidence, releases] = await Promise.all([
      listFinanceEvidenceFromAzure({ userId, year: taxYear, limit: 200 }),
      listWorkpaperSnapshotsFromAzure({
        userId,
        taxYear,
        packetTypeLike: 'packet_release_%',
        limit: 12
      })
    ]);

    if (evidence.status !== 'loaded') {
      const evidenceError = new Error(`Canonical finance evidence unavailable${evidence.error ? `: ${evidence.error}` : ''}`);
      evidenceError.statusCode = 503;
      evidenceError.details = {
        canonicalStatus: evidence.status || 'unknown',
        canonicalError: evidence.error || null
      };
      throw evidenceError;
    }

    if (releases.status !== 'loaded') {
      const releasesError = new Error(`Canonical packet release history unavailable${releases.error ? `: ${releases.error}` : ''}`);
      releasesError.statusCode = 503;
      releasesError.details = {
        canonicalStatus: releases.status || 'unknown',
        canonicalError: releases.error || null
      };
      throw releasesError;
    }

    res.json({
      ok: true,
      intelligence: buildPacketReleaseIntelligence({
        taxYear,
        snapshot,
        evidence,
        releases
      }),
      snapshot,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime),
      evidenceSummary: evidence.summary,
      releaseStatus: releases.status || 'unknown'
    });
  } catch (error) {
    console.error('Error building packet release intelligence:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

router.post('/tax/packet-releases', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      year,
      releaseType = 'cpa_packet',
      artifactPath = null,
      notes = null,
      approval = {},
      draftFormProfile = null,
      homeState = ''
    } = req.body || {};
    const actor = req.user.email || req.user.uid;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties, vendors] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId)
    ]);

    const persistedDraftProfile = await persistTaxDraftProfile(
      userId,
      taxYear,
      draftFormProfile || {},
      actor,
      String(homeState || ''),
    );

    const snapshot = {
      ...buildTaxWorkpaperSnapshot({
        taxYear,
        entries,
        properties,
        vendors,
        ruleset: rulesRuntime.ruleset
      }),
      draftFormProfile: persistedDraftProfile.profile,
      draftFormProfileUpdatedAt: persistedDraftProfile.updatedAt,
      draftFormProfileUpdatedBy: persistedDraftProfile.updatedBy,
    };

    if (snapshot.packetReadiness !== ACCOUNTING_PACKET_READINESS.READY_FOR_CPA_REVIEW) {
      return res.status(409).json({
        ok: false,
        error: `Packet cannot be released while readiness is ${snapshot.packetReadiness}`,
        packetReadiness: snapshot.packetReadiness,
        rulesVersion: snapshot.rulesVersion
      });
    }

    const releasedAt = new Date().toISOString();
    const approvalControl = buildApprovalControl({
      approval,
      actor,
      actionType: 'packet_release',
      requiredChecklist: PACKET_RELEASE_REQUIRED_APPROVAL_CHECKS,
      approvedAt: releasedAt
    });
    const packetType = `packet_release_${releaseType}`;
    const releaseSnapshot = {
      ...snapshot,
      releaseControl: {
        releaseType,
        releasedAt,
        releasedBy: actor,
        notes: notes || null,
        approvalControl,
        draftFormProfileIncluded: true,
      }
    };

    const storage = await persistWorkpaperSnapshotToAzure({
      taxYear,
      userId,
      taxYear,
      packetType,
      snapshot: releaseSnapshot,
      readinessStatus: 'released',
      artifactPath: artifactPath || `packet-releases/${taxYear}/${releaseType}`,
      createdBy: actor
    });

    if (!storage?.artifactRecord?.sha256 || !storage?.artifactRecord?.recordedAt) {
      const error = new Error('Packet release storage did not return immutable artifact integrity metadata.');
      error.statusCode = 500;
      throw error;
    }

    res.json({
      ok: true,
      release: {
        releaseType,
        releasedAt,
        releasedBy: actor,
        notes: notes || null,
        approvalControl,
        packetReadiness: snapshot.packetReadiness,
        rulesVersion: snapshot.rulesVersion,
        draftFormProfile: persistedDraftProfile.profile,
        artifactIntegrity: {
          sha256: storage.artifactRecord.sha256,
          recordedAt: storage.artifactRecord.recordedAt,
          sizeBytes: storage.artifactRecord.sizeBytes || null,
          contentType: storage.artifactRecord.contentType || null
        }
      },
      storage,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime)
    });
  } catch (error) {
    console.error('Error releasing packet snapshot:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/document-checklist
 * Get tax document readiness checklist
 */
router.get('/tax/document-checklist', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties, vendors] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId)
    ]);

    const snapshot = buildTaxWorkpaperSnapshot({ taxYear, entries, properties, vendors, ruleset: rulesRuntime.ruleset });

    res.json({
      ok: true,
      ...snapshot.documentChecklist,
      rulesVersion: snapshot.rulesVersion,
      packetReadiness: snapshot.packetReadiness,
      workpaperSummary: snapshot.summary,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime),
      generatedAt: snapshot.generatedAt
    });
  } catch (error) {
    console.error('Error getting document checklist:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/re-pro-status
 * Analyze Real Estate Professional status
 */
router.get('/tax/re-pro-status', requireAuth, async (req, res) => {
  try {
    const { rentalHours, otherWorkHours } = req.query;
    const result = analyzeREProStatus({
      rentalHours: parseFloat(rentalHours) || 0,
      otherWorkHours: parseFloat(otherWorkHours) || 0
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error analyzing RE Pro status:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/mortgage-split
 * Calculate real interest/principal split for a mortgage payment
 */
router.post('/tax/mortgage-split', requireAuth, async (req, res) => {
  try {
    const { originalBalance, annualRate, termMonths, originationDate, paymentDate } = req.body;

    if (!originalBalance || !annualRate) {
      return res.status(400).json({ ok: false, error: 'originalBalance and annualRate are required' });
    }

    const split = calculateMortgageSplit(
      parseFloat(originalBalance),
      parseFloat(annualRate),
      parseInt(termMonths) || 360,
      originationDate || '2020-01-01',
      paymentDate || new Date().toISOString().split('T')[0]
    );

    res.json({ ok: true, ...split });
  } catch (error) {
    console.error('Error calculating mortgage split:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/state-rates
 * Get state tax rate info
 */
router.get('/tax/state-rates', requireAuth, async (req, res) => {
  try {
    const { state } = req.query;
    if (state) {
      const info = STATE_TAX_RATES[state.toUpperCase()];
      if (!info) return res.status(404).json({ ok: false, error: 'State not found' });
      res.json({ ok: true, state: state.toUpperCase(), ...info });
    } else {
      res.json({ ok: true, states: getStateRateSummary(), noTaxStates: getNoTaxStates() });
    }
  } catch (error) {
    console.error('Error getting state rates:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/rules-package
 * Expose the runtime rules package and source metadata
 */
router.get('/tax/rules-package', requireAuth, async (req, res) => {
  try {
    const { year } = req.query;
    const taxYear = parseInt(year, 10) || new Date().getFullYear();
    const rulesRuntime = await loadRuntimeTaxRulesetPackage(taxYear);
    const ruleset = rulesRuntime.ruleset || null;
    const sourceDocuments = Array.isArray(ruleset?.sourceDocuments) ? ruleset.sourceDocuments : [];
    const appliedRuleGroups = buildAppliedTaxRuleGroups(ruleset, taxYear);
    const validation = buildTaxRulesValidationSummary(rulesRuntime, appliedRuleGroups);
    const activationValidation = validateTaxRulesetCandidate({
      candidateRuleset: ruleset,
      taxYear,
      sourceRuleAudits: Array.isArray(ruleset?.sourceRuleAudits) ? ruleset.sourceRuleAudits : [],
    });

    res.json({
      ok: true,
      taxYear,
      ruleset,
      sourceDocuments,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime),
      validation,
      activationValidation,
      claudeExtractionContract: buildClaudeRulesetExtractionContract(taxYear),
      appliedRuleGroups,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting tax rules package:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/rules-package/validate
 * Validate a candidate yearly tax ruleset before runtime activation.
 */
router.post('/tax/rules-package/validate', requireAuth, async (req, res) => {
  try {
    const { year, ruleset, expectedRulesVersion, fixtureGate } = req.body || {};
    const taxYear = parseInt(year, 10) || Number(ruleset?.taxYear) || new Date().getFullYear();
    const validation = validateTaxRulesetCandidate({
      candidateRuleset: ruleset,
      taxYear,
      expectedRulesVersion,
      fixtureGate,
    });

    res.json({
      ok: true,
      validation,
      claudeExtractionContract: buildClaudeRulesetExtractionContract(taxYear),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error validating tax rules package:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/rules-package/history
 * List persisted runtime/candidate rulesets for a tax year.
 */
router.get('/tax/rules-package/history', requireAuth, async (req, res) => {
  try {
    const { year, limit } = req.query;
    const taxYear = parseInt(year, 10) || new Date().getFullYear();
    const result = await listTaxRulesetsFromAzure({
      taxYear,
      limit: parseInt(limit, 10) || 20,
    });

    res.json({
      ok: true,
      ...result,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error listing tax rules package history:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/rules-package/ingest
 * Fetch yearly source docs, build a candidate ruleset, validate it, and optionally activate after gates pass.
 */
router.post('/tax/rules-package/ingest', requireAuth, async (req, res) => {
  try {
    const { year, activateIfValid = false, runFixtureGate = true } = req.body || {};
    const taxYear = parseInt(year, 10) || new Date().getFullYear();
    const actor = req.user?.email || req.user?.uid || 'system-tax-rules-ingestion';
    const result = await ingestYearlyTaxRuleset({
      taxYear,
      activateIfValid: activateIfValid === true,
      runFixtureGateBeforeActivation: runFixtureGate !== false,
      actor,
    });

    res.json(result);
  } catch (error) {
    console.error('Error ingesting tax rules package:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/edge-case-review
 * Run guarded post-computation tax edge-case review.
 */
router.post('/tax/edge-case-review', requireAuth, async (req, res) => {
  try {
    const { context, preferClaude = true } = req.body || {};
    const review = await reviewTaxEdgeCases({
      context: context || {},
      preferClaude: preferClaude !== false,
    });

    res.json({
      ok: true,
      review,
      contract: buildClaudeTaxEdgeCaseReviewContract(),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error running tax edge-case review:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/brackets
 * Get current federal tax brackets
 */
router.get('/tax/brackets', requireAuth, async (req, res) => {
  try {
    const { filingStatus, year } = req.query;
    const status = filingStatus || 'single';
    const taxYear = parseInt(year, 10) || new Date().getFullYear();
    const rulesRuntime = await loadRuntimeTaxRulesetPackage(taxYear);
    const brackets = getFederalTaxBracketsFromRuleset(rulesRuntime.ruleset, status);
    const deduction = getStandardDeductionFromRuleset(rulesRuntime.ruleset, status);

    res.json({
      ok: true,
      filingStatus: status,
      brackets: brackets.map(b => ({
        rate: `${(b.rate * 100).toFixed(0)}%`,
        min: b.min,
        max: b.max === Infinity ? null : b.max,
        rateDecimal: b.rate
      })),
      standardDeduction: deduction,
      year: taxYear,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime)
    });
  } catch (error) {
    console.error('Error getting brackets:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// NOTE: CSV export route moved below PDF export to support ?detailed=true param.
// See the unified /tax/export-csv route after export-pdf.

// ===========================================
// TAX1099 E-FILING ENDPOINTS
// ===========================================

/**
 * GET /api/bookkeeping/firestore/tax/1099-config
 * Check Tax1099 API configuration status
 */
router.get('/tax/1099-config', requireAuth, async (req, res) => {
  try {
    res.json({
      ok: true,
      configured: isTax1099Configured(),
      apiUrl: process.env.TAX1099_API_URL || 'https://api.tax1099.com/v2',
      hasPayerTIN: !!(process.env.TAX1099_PAYER_TIN)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/1099-efile
 * E-file 1099-NEC forms with the IRS via Tax1099.com
 */
router.post('/tax/1099-efile', requireAuth, async (req, res) => {
  try {
    if (!isTax1099Configured()) {
      return res.status(400).json({
        ok: false,
        error: 'Tax1099 API not configured. Add TAX1099_API_KEY to your environment variables.'
      });
    }

    const userId = req.user.uid;
    const {
      year,
      payerInfo, // { name, tin, address, city, state, zip, phone, email }
      vendorIds  // Optional: specific vendors to file for. If empty, files all eligible.
    } = req.body;

    const taxYear = parseInt(year) || new Date().getFullYear() - 1;
  const rulesRuntime = await loadRuntimeTaxRulesetPackage(taxYear);
  const threshold1099 = getTax1099ThresholdFromRuleset(rulesRuntime.ruleset, taxYear);

    // Get vendors and their payments
    const [vendors, entries] = await Promise.all([
      fetchUserVendors(userId),
      fetchAllEntries(userId, taxYear)
    ]);
    const vendorPayments = buildVendorPaymentsFromEntries(entries);

    // Build eligible vendor list
    const eligibleVendors = [];
    for (const v of vendors) {
      const totalPaid = vendorPayments.get(v.name)?.totalPaid || 0;
      
      if (totalPaid < threshold1099) continue;
      if (v.vendorType === 'ccorp' || v.vendorType === 'corporation') continue;
      if (vendorIds && vendorIds.length > 0 && !vendorIds.includes(v.id)) continue;
      if (!v.ein && !v.ssnLast4) continue; // Can't file without TIN

      eligibleVendors.push({
        name: v.name,
        tin: v.ein || null,
        tinType: v.ein ? 'EIN' : 'SSN',
        address: v.address,
        city: v.city,
        state: v.state,
        zip: v.zip,
        email: v.email,
        totalPaid: Math.round(totalPaid * 100) / 100
      });
    }

    if (eligibleVendors.length === 0) {
      return res.status(400).json({
        ok: false,
        error: `No eligible vendors found for 1099 filing. Ensure vendors have TIN and payments ≥ ${threshold1099.toLocaleString('en-US')}.`
      });
    }

    // Execute the filing workflow
    const result = await executeFilingWorkflow(payerInfo, eligibleVendors, taxYear);

    const azureHistory = await persistTax1099FilingHistoryToAzure({
      user: req.user,
      taxYear,
      payerInfo,
      eligibleVendors,
      filingResult: result
    }).catch((error) => {
      console.error('Error storing canonical 1099 filing history:', error);
      return { storage: { ok: false, status: 'failed', error: error.message }, filingRecords: [], filedAt: new Date().toISOString() };
    });

    res.json({
      ok: true,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime),
      historyStorage: azureHistory.storage || null,
      historyRecorded: azureHistory.storage?.status === 'persisted',
      ...result
    });
  } catch (error) {
    console.error('Error e-filing 1099s:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/1099-efile/status
 * Get filing status for a specific filing or all filings for a year
 */
router.get('/tax/1099-efile/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, filingId } = req.query;

    if (filingId && isTax1099Configured()) {
      // Get real-time status from Tax1099
      const status = await getFilingStatus(filingId);
      return res.json({ ok: true, status });
    }

    const canonicalHistory = await listTax1099FilingHistoryFromAzure({
      userId,
      taxYear: year ? (parseInt(year) || null) : null,
      limit: 20
    }).catch((error) => {
      console.error('Error loading canonical 1099 filing history:', error);
      return { ok: false, status: 'failed', error: error.message, filings: [] };
    });

    if (canonicalHistory.status !== 'loaded') {
      const historyError = new Error(`Canonical 1099 filing history unavailable${canonicalHistory.error ? `: ${canonicalHistory.error}` : ''}`);
      historyError.statusCode = 503;
      historyError.details = {
        canonicalStatus: canonicalHistory.status || 'unknown',
        canonicalError: canonicalHistory.error || null
      };
      throw historyError;
    }

    return res.json({ ok: true, filings: canonicalHistory.filings || [] });
  } catch (error) {
    console.error('Error getting filing status:', error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message, details: error.details || null });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/1099-tin-check
 * Validate a vendor's TIN against IRS database
 */
router.post('/tax/1099-tin-check', requireAuth, async (req, res) => {
  try {
    if (!isTax1099Configured()) {
      return res.status(400).json({
        ok: false,
        error: 'Tax1099 API not configured'
      });
    }

    const { name, tin, tinType } = req.body;
    
    if (!name || !tin) {
      return res.status(400).json({ ok: false, error: 'Name and TIN are required' });
    }

    const result = await validateTIN(name, tin, tinType || 'SSN');
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error validating TIN:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/1099-tin-check-batch
 * Validate TINs for all 1099-eligible vendors
 */
router.post('/tax/1099-tin-check-batch', requireAuth, async (req, res) => {
  try {
    if (!isTax1099Configured()) {
      return res.status(400).json({ ok: false, error: 'Tax1099 API not configured' });
    }

    const userId = req.user.uid;
    const savedVendors = await fetchUserVendors(userId);
    const vendors = savedVendors
      .filter((vendor) => vendor.ein || vendor.ssnLast4)
      .map((vendor) => ({
        id: vendor.id,
        name: vendor.name,
        tin: vendor.ein || vendor.ssnLast4,
        tinType: vendor.ein ? 'EIN' : 'SSN'
      }));

    if (vendors.length === 0) {
      return res.json({ ok: true, results: [], message: 'No vendors with TINs to validate' });
    }

    const results = await validateTINBatch(vendors);
    res.json({ ok: true, results });
  } catch (error) {
    console.error('Error batch validating TINs:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/1099-w9-request
 * Send W-9 request to a vendor via email
 */
router.post('/tax/1099-w9-request', requireAuth, async (req, res) => {
  try {
    if (!isTax1099Configured()) {
      return res.status(400).json({ ok: false, error: 'Tax1099 API not configured' });
    }

    const { vendorName, vendorEmail, payerName } = req.body;
    
    if (!vendorName || !vendorEmail) {
      return res.status(400).json({ ok: false, error: 'Vendor name and email are required' });
    }

    const result = await requestW9({
      recipientName: vendorName,
      recipientEmail: vendorEmail,
      payerName: payerName || 'Renaissance Realty'
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error requesting W-9:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/1099-form-pdf/:formId
 * Download a filed 1099 form PDF
 */
router.get('/tax/1099-form-pdf/:formId', requireAuth, async (req, res) => {
  try {
    if (!isTax1099Configured()) {
      return res.status(400).json({ ok: false, error: 'Tax1099 API not configured' });
    }

    const { formId } = req.params;
    const pdfBuffer = await getFormPDF(formId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="1099-NEC-${formId}.pdf"`);
    res.send(Buffer.from(pdfBuffer));
  } catch (error) {
    console.error('Error getting form PDF:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/export-1099-draft
 * Generate draft 1099 PDFs from reportable vendor readiness data.
 */
router.get('/tax/export-1099-draft', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, homeState } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    const filename = `draft-1099-forms-${taxYear}.pdf`;

    const [rulesRuntime, vendors, entries, draftProfile] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchUserVendors(userId),
      fetchAllEntries(userId, taxYear),
      loadTaxDraftProfile(userId, taxYear, String(homeState || '')),
    ]);
    const threshold1099 = getTax1099ThresholdFromRuleset(rulesRuntime.ruleset, taxYear);
    const vendorPayments = buildVendorPaymentsFromEntries(entries);
    const vendorInfo = Object.fromEntries(vendors.map((vendor) => [vendor.name, vendor]));

    const forms1099 = [];
    for (const [vendorName, paymentSummary] of vendorPayments.entries()) {
      const totalPaid = paymentSummary.totalPaid;
      if (totalPaid < threshold1099) continue;

      const info = vendorInfo[vendorName] || {};
      if (info.vendorType === 'ccorp' || info.vendorType === 'corporation') continue;

      const missingInfo = [];
      if (!info.ein && !info.ssnLast4) missingInfo.push('TIN');
      if (!info.address) missingInfo.push('Address');
      if (!info.w9OnFile) missingInfo.push('W-9');

      forms1099.push({
        recipientName: vendorName,
        recipientTIN: info.ein || (info.ssnLast4 ? `***-**-${info.ssnLast4}` : 'MISSING'),
        recipientAddress: info.address ? `${info.address}, ${info.city || ''} ${info.state || ''} ${info.zip || ''}`.replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim() : 'MISSING',
        amount: Math.round(totalPaid * 100) / 100,
        formType: '1099-NEC',
        box: 1,
        w9OnFile: info.w9OnFile || false,
        missingInfo,
      });
    }

    forms1099.sort((left, right) => right.amount - left.amount);

    if (forms1099.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No reportable 1099 vendors are currently in scope for this tax year.',
      });
    }

    const userDoc = await getFirestore().collection('users').doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const payerInfo = {
      ...draftProfile.profile,
      primaryName: draftProfile.profile.primaryName || userData.displayName || userData.name || '',
      mailingStreet: draftProfile.profile.mailingStreet || userData.address || '',
      mailingCity: draftProfile.profile.mailingCity || userData.city || '',
      mailingState: draftProfile.profile.mailingState || userData.state || String(homeState || '').toUpperCase(),
      mailingZip: draftProfile.profile.mailingZip || userData.zip || '',
    };

    const pdfBytes = await generate1099NecFormsPDF(forms1099, payerInfo, taxYear);
    const pdfBuffer = Buffer.from(pdfBytes);
    const pdfRenderer = await detect1099NecPdfRenderer(pdfBytes, forms1099.length);
    const storage = await recordGeneratedWorkpaperArtifact({
      user: req.user,
      taxYear,
      packetType: 'draft_1099_forms_pdf',
      snapshot: {
        taxYear,
        rulesVersion: rulesRuntime.ruleset?.rulesVersion || 'unknown',
        packetReadiness: forms1099.some((form) => (form.missingInfo || []).length > 0)
          ? 'action_required'
          : 'draft_ready',
        draftFormProfile: payerInfo,
        vendors1099: {
          threshold1099,
          totalForms: forms1099.length,
          totalAmount: Math.round(forms1099.reduce((sum, form) => sum + Number(form.amount || 0), 0) * 100) / 100,
          formsWithMissingInfo: forms1099.filter((form) => (form.missingInfo || []).length > 0).length,
          formsReady: forms1099.filter((form) => (form.missingInfo || []).length === 0 && form.w9OnFile).length,
          vendors: forms1099,
        },
      },
      filename,
      exportFormat: 'pdf',
      artifactContent: pdfBuffer,
      contentType: 'application/pdf',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-HouseYield-Pdf-Renderer', pdfRenderer);
    res.setHeader('X-HouseYield-Tax-Rules-Version', rulesRuntime.ruleset?.rulesVersion || 'unknown');
    res.setHeader('X-HouseYield-Tax-Rules-Source', rulesRuntime.source || 'unknown');
    res.setHeader('X-HouseYield-Workpaper-Storage-Status', storage.status);
    applyArtifactHeaders(res, storage);
    if (storage.workpaperSnapshotId) {
      res.setHeader('X-HouseYield-Workpaper-Snapshot-Id', storage.workpaperSnapshotId);
    }
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating draft 1099 PDF:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===========================================
// TAX EXPORT ENDPOINTS (TXF, PDF, CSV)
// ===========================================

/**
 * GET /api/bookkeeping/firestore/tax/export-txf
 * Export Schedule E data as TXF file for TurboTax import
 */
router.get('/tax/export-txf', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, propertyId, includeTax, filingStatus, otherIncome, otherDeductions, taxCredits, withholdingYtd, homeState } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    const filename = `schedule-e-${taxYear}.txf`;

    const [rulesRuntime, entries, properties, vendors] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId)
    ]);

    const snapshot = buildTaxWorkpaperSnapshot({ taxYear, entries, properties, vendors, ruleset: rulesRuntime.ruleset });
    const txfContent = generateTXF(snapshot.scheduleE, snapshot.depreciation);
    const storage = await recordGeneratedWorkpaperArtifact({
      user: req.user,
      taxYear,
      packetType: 'tax_software_import_txf',
      snapshot,
      filename,
      exportFormat: 'txf',
      artifactContent: txfContent,
      contentType: 'application/octet-stream'
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-HouseYield-Tax-Rules-Version', snapshot.rulesVersion);
    res.setHeader('X-HouseYield-Tax-Rules-Source', rulesRuntime.source || 'unknown');
    res.setHeader('X-HouseYield-Workpaper-Storage-Status', storage.status);
    applyArtifactHeaders(res, storage);
    if (storage.workpaperSnapshotId) {
      res.setHeader('X-HouseYield-Workpaper-Snapshot-Id', storage.workpaperSnapshotId);
    }
    res.send(txfContent);
  } catch (error) {
    console.error('Error generating TXF:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/export-pdf
 * Generate professional Schedule E summary PDF
 */
router.get('/tax/export-pdf', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      year,
      taxYear: taxYearAlias,
      homeState,
      propertyId,
      ignoreRecordedPayments,
      asOfDate,
    } = req.query;
    const taxYear = parseInt(year || taxYearAlias) || new Date().getFullYear();
    const resolvedAsOfDate = resolveEstimatedTaxAsOfDate(taxYear, asOfDate);
    const filename = `schedule-e-report-${taxYear}.pdf`;

    const [rulesRuntime, entries, properties, vendors, draftProfile] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId),
      loadTaxDraftProfile(userId, taxYear, String(homeState || '')),
    ]);

    const snapshot = buildTaxWorkpaperSnapshot({ taxYear, entries, properties, vendors, ruleset: rulesRuntime.ruleset });
    const taxpayerInfo = {
      ...draftProfile.profile,
      propertyScope: snapshot.propertyCount === 1
        ? snapshot.scheduleE?.propertySummaries?.[0]?.address || snapshot.scheduleE?.propertySummaries?.[0]?.name || 'Rental property'
        : `${snapshot.propertyCount || snapshot.scheduleE?.propertySummaries?.length || 0} rental properties`,
    };

    const mortgage1098 = buildMortgage1098Summaries(properties, snapshot.scheduleE, taxYear);

    const pdfBytes = await generateScheduleEPDF(
      snapshot.scheduleE,
      snapshot.depreciation,
      taxpayerInfo,
      snapshot.vendors1099,
      { mortgage1098 },
    );
    const pdfBuffer = Buffer.from(pdfBytes);

    // Artifact recording is best-effort — never block the owner from viewing/downloading the PDF.
    let storage = { status: 'skipped' };
    try {
      storage = await recordGeneratedWorkpaperArtifact({
        user: req.user,
        taxYear,
        packetType: 'cpa_packet_pdf',
        snapshot: {
          ...snapshot,
          draftFormProfile: draftProfile.profile,
        },
        filename,
        exportFormat: 'pdf',
        artifactContent: pdfBuffer,
        contentType: 'application/pdf'
      });
    } catch (storageError) {
      console.warn('[tax/export-pdf] Workpaper artifact recording failed (continuing with PDF):', storageError?.message || storageError);
      storage = { status: 'failed', error: storageError?.message || 'artifact_record_failed' };
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-HouseYield-Tax-Rules-Version', snapshot.rulesVersion);
    res.setHeader('X-HouseYield-Tax-Rules-Source', rulesRuntime.source || 'unknown');
    res.setHeader('X-HouseYield-Workpaper-Storage-Status', storage.status || 'unknown');
    applyArtifactHeaders(res, storage);
    if (storage.workpaperSnapshotId) {
      res.setHeader('X-HouseYield-Workpaper-Snapshot-Id', storage.workpaperSnapshotId);
    }
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/tax/document-pdf', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, homeState, docType } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();
    const normalizedDocType = String(docType || '').toLowerCase();

    if (normalizedDocType === '1099-nec') {
      const [rulesRuntime, vendors, entries, draftProfile] = await Promise.all([
        loadRuntimeTaxRulesetPackage(taxYear),
        fetchUserVendors(userId),
        fetchAllEntries(userId, taxYear),
        loadTaxDraftProfile(userId, taxYear, String(homeState || '')),
      ]);
      const threshold1099 = getTax1099ThresholdFromRuleset(rulesRuntime.ruleset, taxYear);
      const vendorPayments = buildVendorPaymentsFromEntries(entries);
      const vendorInfo = Object.fromEntries(vendors.map((vendor) => [vendor.name, vendor]));
      const forms1099 = [];
      for (const [vendorName, paymentSummary] of vendorPayments.entries()) {
        const totalPaid = paymentSummary.totalPaid;
        if (totalPaid < threshold1099) continue;
        const info = vendorInfo[vendorName] || {};
        if (info.vendorType === 'ccorp' || info.vendorType === 'corporation') continue;
        const missingInfo = [];
        if (!info.ein && !info.ssnLast4) missingInfo.push('TIN');
        if (!info.address) missingInfo.push('Address');
        if (!info.w9OnFile) missingInfo.push('W-9');
        forms1099.push({
          recipientName: vendorName,
          recipientTIN: info.ein || (info.ssnLast4 ? `***-**-${info.ssnLast4}` : 'MISSING'),
          recipientAddress: info.address ? `${info.address}, ${info.city || ''} ${info.state || ''} ${info.zip || ''}`.replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim() : 'MISSING',
          amount: Math.round(totalPaid * 100) / 100,
          formType: '1099-NEC',
          box: 1,
          w9OnFile: info.w9OnFile || false,
          missingInfo,
        });
      }
      forms1099.sort((left, right) => right.amount - left.amount);
      if (forms1099.length === 0) {
        return res.status(400).json({ ok: false, error: 'No reportable 1099 vendors are currently in scope for this tax year.' });
      }
      const userDoc = await getFirestore().collection('users').doc(userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      const payerInfo = {
        ...draftProfile.profile,
        primaryName: draftProfile.profile.primaryName || userData.displayName || userData.name || '',
        mailingStreet: draftProfile.profile.mailingStreet || userData.address || '',
        mailingCity: draftProfile.profile.mailingCity || userData.city || '',
        mailingState: draftProfile.profile.mailingState || userData.state || String(homeState || '').toUpperCase(),
        mailingZip: draftProfile.profile.mailingZip || userData.zip || '',
      };
      const pdfBytes = await generate1099NecFormsPDF(forms1099, payerInfo, taxYear);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="1099-nec-${taxYear}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    }

    const [rulesRuntime, entries, properties, vendors, draftProfile] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId),
      loadTaxDraftProfile(userId, taxYear, String(homeState || '')),
    ]);
    const snapshot = buildTaxWorkpaperSnapshot({ taxYear, entries, properties, vendors, ruleset: rulesRuntime.ruleset });
    const mortgage1098 = buildMortgage1098Summaries(properties, snapshot.scheduleE, taxYear);
    const taxpayerInfo = {
      ...draftProfile.profile,
      propertyScope: snapshot.propertyCount === 1
        ? snapshot.scheduleE?.propertySummaries?.[0]?.address || snapshot.scheduleE?.propertySummaries?.[0]?.name || 'Rental property'
        : `${snapshot.propertyCount || snapshot.scheduleE?.propertySummaries?.length || 0} rental properties`,
    };

    const pdfBytes = normalizedDocType === 'schedule-e'
      ? await generateOfficialScheduleEOnlyPDF(snapshot.scheduleE, snapshot.depreciation, taxpayerInfo)
      : await generateTaxSupportDocumentPDF(
        snapshot.scheduleE,
        snapshot.depreciation,
        taxpayerInfo,
        snapshot.vendors1099,
        normalizedDocType,
        {
          propertyScope: taxpayerInfo.propertyScope,
          lenderLabel: mortgage1098.lenderLabel,
          mortgage1098,
        },
      );

    const filenameByType = {
      'schedule-e': `schedule-e-${taxYear}.pdf`,
      'form-4562': `form-4562-${taxYear}.pdf`,
      'form-1098': `form-1098-${taxYear}.pdf`,
      'property-tax': `property-tax-support-${taxYear}.pdf`,
      'insurance': `insurance-support-${taxYear}.pdf`,
    };
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameByType[normalizedDocType] || `tax-document-${taxYear}.pdf`}"`);
    res.setHeader('X-HouseYield-Tax-Rules-Version', snapshot.rulesVersion);
    res.setHeader('X-HouseYield-Tax-Rules-Source', rulesRuntime.source || 'unknown');
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('Error generating document PDF:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/export-csv
 * Export tax data as CSV
 */
router.get('/tax/export-csv', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { year, detailed } = req.query;
    const taxYear = parseInt(year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties, vendors] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId),
      fetchUserVendors(userId)
    ]);

    if (detailed === 'true') {
      const filename = `tax-entries-${taxYear}.csv`;
      const csv = generateDetailedCSV(entries, taxYear);
      const detailedSnapshot = buildTaxWorkpaperSnapshot({ taxYear, entries, properties, vendors, ruleset: rulesRuntime.ruleset });
      const storage = await recordGeneratedWorkpaperArtifact({
        user: req.user,
        taxYear,
        packetType: 'workpaper_entries_csv',
        snapshot: {
          ...detailedSnapshot,
          exportArtifact: {
            filename,
            format: 'csv',
            exportVariant: 'detailed_entries',
            generatedAt: new Date().toISOString()
          }
        },
        filename,
        exportFormat: 'csv',
        artifactContent: csv,
        contentType: 'text/csv',
        artifactMetadata: {
          exportVariant: 'detailed_entries'
        }
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-HouseYield-Tax-Rules-Version', detailedSnapshot.rulesVersion);
      res.setHeader('X-HouseYield-Tax-Rules-Source', rulesRuntime.source || 'unknown');
      res.setHeader('X-HouseYield-Workpaper-Storage-Status', storage.status);
      applyArtifactHeaders(res, storage);
      if (storage.workpaperSnapshotId) {
        res.setHeader('X-HouseYield-Workpaper-Snapshot-Id', storage.workpaperSnapshotId);
      }
      return res.send(csv);
    }

    const snapshot = buildTaxWorkpaperSnapshot({ taxYear, entries, properties, vendors, ruleset: rulesRuntime.ruleset });
    const filename = `schedule-e-${taxYear}.csv`;

    const summaryCsv = generateScheduleESummaryCSV(snapshot.scheduleE);
    const storage = await recordGeneratedWorkpaperArtifact({
      user: req.user,
      taxYear,
      packetType: 'workpaper_summary_csv',
      snapshot,
      filename,
      exportFormat: 'csv',
      artifactContent: summaryCsv,
      contentType: 'text/csv',
      artifactMetadata: {
        exportVariant: 'schedule_e_summary'
      }
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-HouseYield-Tax-Rules-Version', snapshot.rulesVersion);
    res.setHeader('X-HouseYield-Tax-Rules-Source', rulesRuntime.source || 'unknown');
    res.setHeader('X-HouseYield-Workpaper-Storage-Status', storage.status);
    applyArtifactHeaders(res, storage);
    if (storage.workpaperSnapshotId) {
      res.setHeader('X-HouseYield-Workpaper-Snapshot-Id', storage.workpaperSnapshotId);
    }
    res.send(summaryCsv);
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});


// ===========================================
// TAX BENEFITS ANALYSIS ENDPOINTS
// ===========================================

/**
 * GET /api/bookkeeping/firestore/tax/rental-tax-shield
 * Auto-calculated "with rental properties vs without" comparison
 * Shows exactly how much the user saves by owning rental property.
 * No manual input required — pulls everything from transactions + ATTOM data.
 */
router.get('/tax/rental-tax-shield', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const taxYear = parseInt(req.query.year) || new Date().getFullYear();
    const filingStatus = req.query.filingStatus || 'single';
    const otherIncome = parseFloat(req.query.otherIncome) || 0;
    const homeState = req.query.state || null;

    const [rulesRuntime, entries, properties] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId)
    ]);
    const scheduleE = generateScheduleE(entries, taxYear, null, properties, rulesRuntime.ruleset);
    const depreciationData = calculateDepreciation(properties, taxYear, rulesRuntime.ruleset);

    // ─── WITHOUT rental property (just W-2 / other income) ────────────
    const taxWithout = calculateTaxLiability(
      { taxYear, filingStatus, otherIncome, homeState, propertyStates: [] },
      { summary: { netIncomeOrLoss: 0, totalIncome: 0, totalExpenses: 0 }, scheduleELines: {} },
      { summary: { totalCurrentYearDepreciation: 0 } },
      rulesRuntime.ruleset
    );

    // ─── WITH rental property (full Schedule E + depreciation) ────────
    const taxWith = calculateTaxLiability(
      { taxYear, filingStatus, otherIncome, homeState, propertyStates: [] },
      scheduleE,
      depreciationData,
      rulesRuntime.ruleset
    );

    // ─── Compute savings ──────────────────────────────────────────────
    const taxSaved = Math.max(0, taxWith.taxes.total > 0 || taxWithout.taxes.total > 0
      ? taxWithout.taxes.total - taxWith.taxes.total
      : 0);
    const federalSaved = Math.max(0, taxWithout.taxes.federal - taxWith.taxes.federal);
    const stateSaved = Math.max(0, taxWithout.taxes.state - taxWith.taxes.state);

    // ─── Break down deduction categories ──────────────────────────────
    const combinedRate = ((taxWith.rates?.marginalFederal || 0) + (taxWith.rates?.effectiveState || 0)) / 100;
    const depreciationAmt = depreciationData?.summary?.totalCurrentYearDepreciation || 0;

    const deductionBreakdown = [];
    // Pull from Schedule E lines
    const lineData = scheduleE?.scheduleELines || {};
    const deductionMap = [
      { key: 'MORTGAGE_INTEREST', label: 'Mortgage Interest', icon: '🏦', description: 'No $750K limit on rental properties (unlike personal residence)' },
      { key: 'TAXES', label: 'Property Taxes', icon: '🏛️', description: 'No $10,000 SALT cap on rental property taxes' },
      { key: 'INSURANCE', label: 'Insurance', icon: '🛡️', description: 'Landlord insurance, liability, umbrella policies' },
      { key: 'REPAIRS', label: 'Repairs & Maintenance', icon: '🔧', description: 'Painting, fixing leaks, appliance repair — deductible when paid' },
      { key: 'CLEANING_MAINTENANCE', label: 'Cleaning & Maintenance', icon: '🧹', description: 'Regular upkeep, janitorial, turnover cleaning' },
      { key: 'MANAGEMENT_FEES', label: 'Management & Software', icon: '💼', description: 'Property management fees, software subscriptions' },
      { key: 'UTILITIES', label: 'Utilities', icon: '💡', description: 'Electric, gas, water, sewer, trash, internet if landlord-paid' },
      { key: 'LEGAL_PROFESSIONAL', label: 'Legal & Professional', icon: '⚖️', description: 'Attorney, CPA, tax prep, eviction costs' },
      { key: 'ADVERTISING', label: 'Advertising', icon: '📢', description: 'Listing fees, signage, marketing' },
      { key: 'AUTO_TRAVEL', label: 'Travel & Auto', icon: '🚗', description: 'Mileage to/from properties, travel for management' },
      { key: 'SUPPLIES', label: 'Supplies', icon: '🧰', description: 'Hardware, tools, office supplies' },
      { key: 'COMMISSIONS', label: 'Commissions', icon: '🤝', description: 'Leasing commissions, finder\'s fees' },
      { key: 'OTHER', label: 'Other Deductible', icon: '📋', description: 'HOA, landscaping, pest control, security' },
    ];

    for (const { key, label, icon, description } of deductionMap) {
      const amt = lineData[key]?.amount || 0;
      if (amt > 0) {
        deductionBreakdown.push({
          category: label,
          icon,
          description,
          deduction: Math.round(amt * 100) / 100,
          taxSaved: Math.round(amt * combinedRate * 100) / 100,
          entryCount: lineData[key]?.entries?.length || 0,
          scheduleELine: lineData[key]?.line
        });
      }
    }

    // Always add depreciation (it's the biggest benefit)
    deductionBreakdown.push({
      category: 'Depreciation (27.5yr)',
      icon: '📉',
      description: 'Non-cash deduction — you save taxes while your property potentially appreciates',
      deduction: Math.round(depreciationAmt * 100) / 100,
      taxSaved: Math.round(depreciationAmt * combinedRate * 100) / 100,
      entryCount: properties.length,
      scheduleELine: 18,
      isNonCash: true
    });

    // Sort by tax saved descending
    deductionBreakdown.sort((a, b) => b.taxSaved - a.taxSaved);

    const totalDeductions = deductionBreakdown.reduce((s, d) => s + d.deduction, 0);
    const totalTaxSavedFromDeductions = deductionBreakdown.reduce((s, d) => s + d.taxSaved, 0);

    // ─── Additional rental-specific benefits ──────────────────────────
    const additionalBenefits = [];

    // No FICA
    const rentalIncome = scheduleE?.summary?.totalIncome || 0;
    const ficaSaved = Math.round(rentalIncome * 0.153 * 100) / 100; // 15.3% SE tax
    if (rentalIncome > 0) {
      additionalBenefits.push({
        name: 'No Self-Employment Tax (FICA)',
        icon: '🎯',
        amount: ficaSaved,
        description: `Rental income of ${fmtCurrencyHelper(rentalIncome)} is exempt from 15.3% FICA — saving you ${fmtCurrencyHelper(ficaSaved)}/year vs. active business income`
      });
    }

    // Passive loss offset
    if (taxWith.passiveLoss?.hasLoss && taxWith.passiveLoss?.allowableLoss > 0) {
      const plSavings = Math.round(taxWith.passiveLoss.allowableLoss * combinedRate * 100) / 100;
      additionalBenefits.push({
        name: 'Passive Loss Offset (§469)',
        icon: '📊',
        amount: plSavings,
        description: `${fmtCurrencyHelper(taxWith.passiveLoss.allowableLoss)} in rental losses offsets your W-2 income, saving ${fmtCurrencyHelper(plSavings)} in taxes`
      });
    }

    // NIIT savings if rental losses bring below threshold
    if (taxWithout.taxes.niit > 0 && taxWith.taxes.niit < taxWithout.taxes.niit) {
      additionalBenefits.push({
        name: 'NIIT Reduction (3.8%)',
        icon: '💰',
        amount: Math.round((taxWithout.taxes.niit - taxWith.taxes.niit) * 100) / 100,
        description: 'Rental deductions reduce your net investment income tax'
      });
    }

    // Property data from ATTOM
    const propertyDetails = properties.map(p => ({
      name: p.name || p.address,
      address: p.address,
      purchasePrice: p.purchasePrice || 0,
      currentValue: p.attomAVM || p.attomMarketValue || p.purchasePrice || 0,
      appreciation: p.attomAVM && p.purchasePrice ? Math.round(((p.attomAVM - p.purchasePrice) / p.purchasePrice * 100) * 10) / 10 : null,
      rentalAVM: p.attomRentalAVM || null,
      yearBuilt: p.attomYearBuilt || null,
      depreciationThisYear: depreciationData?.assets?.find(a => a.propertyId === (p.id || p.propertyId))?.currentYearDepreciation || 0,
      mortgageAmount: p.attomMortgageAmount || null,
      mortgageRate: p.attomMortgageRate || null
    }));

    res.json({
      ok: true,
      taxYear,
      filingStatus,
      otherIncome,

      // Headline numbers
      totalTaxSaved: Math.round(taxSaved * 100) / 100,
      totalTaxSavedMonthly: Math.round(taxSaved / 12 * 100) / 100,
      ficaSaved,
      effectiveRateWithout: taxWithout.rates?.effectiveTotal || 0,
      effectiveRateWith: taxWith.rates?.effectiveTotal || 0,
      rateReduction: Math.round(((taxWithout.rates?.effectiveTotal || 0) - (taxWith.rates?.effectiveTotal || 0)) * 100) / 100,

      // Side-by-side comparison
      comparison: {
        withoutRental: {
          grossIncome: taxWithout.income?.gross || otherIncome,
          taxableIncome: taxWithout.taxableIncome || 0,
          federalTax: taxWithout.taxes.federal,
          stateTax: taxWithout.taxes.state,
          niit: taxWithout.taxes.niit,
          totalTax: taxWithout.taxes.total,
          effectiveRate: taxWithout.rates?.effectiveTotal || 0
        },
        withRental: {
          grossIncome: taxWith.income?.gross || 0,
          rentalNet: taxWith.income?.rental || 0,
          depreciation: depreciationAmt,
          taxableIncome: taxWith.taxableIncome || 0,
          federalTax: taxWith.taxes.federal,
          stateTax: taxWith.taxes.state,
          niit: taxWith.taxes.niit,
          totalTax: taxWith.taxes.total,
          effectiveRate: taxWith.rates?.effectiveTotal || 0
        },
        savings: {
          federal: federalSaved,
          state: stateSaved,
          total: taxSaved
        }
      },

      // Deduction breakdown
      deductionBreakdown,
      totalDeductions: Math.round(totalDeductions * 100) / 100,
      totalTaxSavedFromDeductions: Math.round(totalTaxSavedFromDeductions * 100) / 100,
      combinedMarginalRate: Math.round(combinedRate * 10000) / 100,

      // Additional benefits
      additionalBenefits,

      // Property details
      properties: propertyDetails,
      propertyCount: properties.length,

      // Schedule E summary
      scheduleESummary: scheduleE?.summary || null,
      depreciationSummary: depreciationData?.summary || null,

      // Passive loss info
      passiveLoss: taxWith.passiveLoss || null,
      rulesRuntime: buildRulesRuntimeMeta(rulesRuntime)
    });
  } catch (error) {
    console.error('Error calculating rental tax shield:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/benefits-summary
 * Full tax benefits summary combining all analyses
 */
router.get('/tax/benefits-summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const taxYear = parseInt(req.query.year) || new Date().getFullYear();
    const rentalHoursPerYear = parseInt(req.query.rentalHours) || 0;
    const totalMiles = parseInt(req.query.totalMiles) || 0;

    const [rulesRuntime, entries, properties] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId)
    ]);
    const scheduleE = generateScheduleE(entries, taxYear, null, properties, rulesRuntime.ruleset);
    const depreciation = calculateDepreciation(properties, taxYear, rulesRuntime.ruleset);

    const filingStatus = req.query.filingStatus || 'single';
    const otherIncome = parseFloat(req.query.otherIncome) || 0;
    const homeState = req.query.state || null;
    const taxCalc = calculateTaxLiability(
      { taxYear, filingStatus, otherIncome, homeState },
      scheduleE, depreciation, rulesRuntime.ruleset
    );

    const propertyValue = properties.reduce((sum, p) => sum + (p.purchasePrice || 0), 0);
    const summary = generateBenefitsSummary({
      scheduleE, depreciation, taxCalc,
      propertyValue,
      originalPurchasePrice: propertyValue,
      rentalHoursPerYear, totalMiles, taxYear
    });

    res.json({ ok: true, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime), ...summary });
  } catch (error) {
    console.error('Error generating benefits summary:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/bookkeeping/firestore/tax/deduction-savings
 * Per-category tax savings at user's marginal rate
 */
router.get('/tax/deduction-savings', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const taxYear = parseInt(req.query.year) || new Date().getFullYear();

    const [rulesRuntime, entries, properties] = await Promise.all([
      loadRuntimeTaxRulesetPackage(taxYear),
      fetchAllEntries(userId, taxYear),
      fetchUserProperties(userId)
    ]);
    const scheduleE = generateScheduleE(entries, taxYear, null, properties, rulesRuntime.ruleset);

    const marginalRate = parseFloat(req.query.marginalRate) || 0.24;
    const stateRate = parseFloat(req.query.stateRate) || 0.05;
    const niitRate = parseFloat(req.query.niitRate) || 0;

    const result = calculateDeductionSavings(scheduleE, marginalRate, stateRate, niitRate);
    res.json({ ok: true, rulesRuntime: buildRulesRuntimeMeta(rulesRuntime), ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/cost-segregation
 * Model cost segregation study impact
 */
router.post('/tax/cost-segregation', requireAuth, async (req, res) => {
  try {
    const { propertyValue, landPercent, taxYear, marginalRate } = req.body;
    if (!propertyValue) return res.status(400).json({ ok: false, error: 'propertyValue required' });

    const result = analyzeCostSegregation(
      propertyValue,
      landPercent || 0.20,
      taxYear || new Date().getFullYear(),
      marginalRate || 0.24
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/1031-exchange
 * Model 1031 like-kind exchange scenario
 */
router.post('/tax/1031-exchange', requireAuth, async (req, res) => {
  try {
    const result = model1031Exchange(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/qbi-deduction
 * Calculate QBI / §199A deduction
 */
router.post('/tax/qbi-deduction', requireAuth, async (req, res) => {
  try {
    const result = calculateQBIDeduction(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/travel-deduction
 * Calculate travel / mileage deduction
 */
router.post('/tax/travel-deduction', requireAuth, async (req, res) => {
  try {
    const result = calculateTravelDeduction(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/de-minimis
 * Analyze safe harbor de minimis election
 */
router.post('/tax/de-minimis', requireAuth, async (req, res) => {
  try {
    const { expenses } = req.body;
    if (!expenses || !Array.isArray(expenses)) return res.status(400).json({ ok: false, error: 'expenses array required' });
    const result = analyzeDeMinimis(expenses);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/tax-equivalent-yield
 * Compare rental property returns to other investments
 */
router.post('/tax/tax-equivalent-yield', requireAuth, async (req, res) => {
  try {
    const result = calculateTaxEquivalentYield(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/bookkeeping/firestore/tax/depreciation-recapture
 * Project depreciation recapture on future sale
 */
router.post('/tax/depreciation-recapture', requireAuth, async (req, res) => {
  try {
    const result = projectDepreciationRecapture(req.body);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// Mock Data Loader — End-to-End Pipeline Demo
// ============================================================================

/**
 * POST /api/bookkeeping/firestore/load-mock-data
 * Seeds the canonical 2025 rental fixture into Azure and returns the stored
 * expected bookkeeping/tax outputs for validation.
 */
router.post('/load-mock-data', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const requestedYear = req.body?.year == null ? null : parseInt(req.body.year, 10);
    const requestedPropertyId = typeof req.body?.propertyId === 'string' && req.body.propertyId.trim()
      ? req.body.propertyId.trim()
      : null;
    const requestedPropertyAddress = typeof req.body?.propertyAddress === 'string' && req.body.propertyAddress.trim()
      ? req.body.propertyAddress.trim()
      : null;
    const fixture = await loadAccountingFixtureDefinition(DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME);

    if (Number.isInteger(requestedYear) && requestedYear !== Number(fixture.taxYear)) {
      return res.status(400).json({
        ok: false,
        error: `This fixture is pinned to tax year ${fixture.taxYear}. Requested ${requestedYear}.`,
      });
    }

    const seeded = await seedAccountingFixtureToAzure({
      userId,
      fixtureName: DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
      fixture,
      clearExisting: true,
      propertyOverride: requestedPropertyId
        ? {
            id: requestedPropertyId,
            address: requestedPropertyAddress,
          }
        : null,
    });
    const expected = loadAccountingFixtureExpected(DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME);

    res.json({
      ok: true,
      fixtureName: DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
      taxYear: fixture.taxYear,
      property: seeded.property,
      entriesCreated: seeded.entriesCreated,
      transactionsCreated: seeded.entriesCreated,
      estimatedPaymentsCreated: seeded.estimatedPaymentsSeeded,
      expected,
      cleanup: seeded.cleanup,
      message: `Loaded canonical fixture ${DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME} into Azure for ${seeded.property?.name || 'the sample property'}.`,
    });

  } catch (error) {
    console.error('[Mock Data] Pipeline error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      step: 'pipeline-failure'
    });
  }
});

/**
 * DELETE /api/bookkeeping/firestore/clear-mock-data
 * Removes the canonical rental fixture rows from Azure and any legacy mock residue.
 */
router.delete('/clear-mock-data', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const fixture = await loadAccountingFixtureDefinition(DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME);
    const canonicalCleanup = await clearAccountingFixtureFromAzure({
      userId,
      fixtureName: DEFAULT_BOOKKEEPING_SAMPLE_FIXTURE_NAME,
      fixture,
    });

    const db = getFirestore();
    let cleared = { entries: 0, properties: 0, vendors: 0 };

    // Clear ALL mock and sample entries
    const entriesRef = getJournalEntriesRef(userId);
    const mockEntries = await entriesRef.where('source', 'in', ['MOCK_BANK', 'MOCK_STRIPE', 'SAMPLE', 'SAMPLE_FEED']).get();
    if (!mockEntries.empty) {
      const batches = [];
      let currentBatch = db.batch();
      let opCount = 0;
      mockEntries.forEach(doc => {
        currentBatch.delete(doc.ref);
        opCount++;
        if (opCount >= 490) { batches.push(currentBatch); currentBatch = db.batch(); opCount = 0; }
      });
      if (opCount > 0) batches.push(currentBatch);
      for (const b of batches) await b.commit();
      cleared.entries = mockEntries.size;
    }

    // Clear mock properties
    const propsRef = db.collection(`users/${userId}/bookkeeping/data/properties`);
    const mockProps = await propsRef.where('isMockData', '==', true).get();
    if (!mockProps.empty) {
      const batch = db.batch();
      mockProps.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      cleared.properties = mockProps.size;
    }

    // Clear mock vendors
    const vendorsRef = db.collection(`users/${userId}/bookkeeping/data/vendors`);
    const mockVendors = await vendorsRef.where('isMockData', '==', true).get();
    if (!mockVendors.empty) {
      const batch = db.batch();
      mockVendors.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      cleared.vendors = mockVendors.size;
    }

    res.json({
      ok: true,
      message: 'Canonical fixture data cleared',
      deleted: canonicalCleanup.deleted,
      cleanup: canonicalCleanup,
      cleared,
    });
  } catch (error) {
    console.error('[Mock Data] Clear error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const SAMPLE_PERSONAL_TAX_BACKTEST_TAG = 'sample-tax-backtest-2025';

function buildSamplePersonalTaxBacktestDocuments() {
  return [
    {
      title: '2025 W-2 - Alex Practice',
      originalFileName: '2025-w2-alex-practice.pdf',
      vendorName: 'Fixture Analytics Inc.',
      employeeName: 'Alex Practice',
      documentDate: '2025-12-31',
      notes: 'Synthetic W-2 seeded for the sample taxpayer backtest.',
      contentPreview: `Form W-2 Wage and Tax Statement
Tax Year 2025
Employer name Fixture Analytics Inc.
Employee name Alex Practice
Box 1 Wages, tips, other compensation 120000.00
Box 2 Federal income tax withheld 16000.00
Box 3 Social security wages 120000.00
Box 4 Social security tax withheld 7440.00
Box 5 Medicare wages and tips 120000.00
Box 6 Medicare tax withheld 1740.00
State MD
Box 16 State wages, tips, etc 120000.00
Box 17 State income tax 7200.00`,
    },
    {
      title: '2025 W-2 - Jordan Practice',
      originalFileName: '2025-w2-jordan-practice.pdf',
      vendorName: 'Fixture Design Studio LLC',
      employeeName: 'Jordan Practice',
      documentDate: '2025-12-31',
      notes: 'Synthetic W-2 seeded for the sample taxpayer backtest.',
      contentPreview: `Form W-2 Wage and Tax Statement
Tax Year 2025
Employer name Fixture Design Studio LLC
Employee name Jordan Practice
Box 1 Wages, tips, other compensation 65000.00
Box 2 Federal income tax withheld 8000.00
Box 3 Social security wages 65000.00
Box 4 Social security tax withheld 4030.00
Box 5 Medicare wages and tips 65000.00
Box 6 Medicare tax withheld 942.50
State MD
Box 16 State wages, tips, etc 65000.00
Box 17 State income tax 3900.00`,
    },
  ];
}

async function seedSamplePersonalTaxBacktestDocumentsForUser(userId, authUser = null) {
  await ensureBookkeepingInitialized(userId);

  const docsRef = getFinanceDocumentsRef(userId);
  const existingDocs = await docsRef.get();
  const sampleSeeds = buildSamplePersonalTaxBacktestDocuments();
  const sampleTitles = new Set(sampleSeeds.map((seed) => seed.title));
  const sampleFileNames = new Set(sampleSeeds.map((seed) => seed.originalFileName));
  const sampleEmployeeNames = new Set(sampleSeeds.map((seed) => seed.employeeName));
  const staleDocs = existingDocs.docs.filter((doc) => {
    const data = doc.data() || {};
    const sampleBacktest = data.sampleBacktest || {};
    const contentPreview = String(data.contentPreview || '');

    return data.mockDataTag === SAMPLE_PERSONAL_TAX_BACKTEST_TAG
      || sampleBacktest.fixtureName === 'prestwick-rental-2025'
      || sampleTitles.has(data.title)
      || sampleFileNames.has(data.originalFileName)
      || (
        data.documentType === 'tax_form'
        && sampleEmployeeNames.has(data.employeeName)
      )
      || (
        data.documentType === 'tax_form'
        && sampleEmployeeNames.has(sampleBacktest.employeeName)
      )
      || (
        data.isMockData === true
        && data.documentType === 'tax_form'
        && sampleEmployeeNames.has(sampleBacktest.employeeName)
      )
      || (
        data.isMockData === true
        && data.documentType === 'tax_form'
        && contentPreview.includes('Synthetic W-2 seeded for the sample taxpayer backtest')
      )
      || (
        data.documentType === 'tax_form'
        && contentPreview.includes('Synthetic W-2 seeded for the sample taxpayer backtest')
      );
  });
  if (staleDocs.length > 0) {
    const batch = getFirestore().batch();
    staleDocs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  const now = new Date().toISOString();
  const seededDocuments = [];

  for (const seed of sampleSeeds) {
    const documentRef = docsRef.doc();
    const personalTaxExtraction = await maybeExtractPersonalTaxFieldsWithGemini({
      documentType: 'tax_form',
      title: seed.title,
      originalFileName: seed.originalFileName,
      vendorName: seed.vendorName,
      notes: seed.notes,
      contentPreview: seed.contentPreview,
      fileBase64: null,
      fileUrl: null,
    });
    const mergedExtractedFields = mergeFinanceDocumentExtraction({}, personalTaxExtraction);

    let evidenceShadow = null;
    try {
      evidenceShadow = await persistFinanceEvidenceToAzure({
        userId,
        propertyId: null,
        sourceSystem: 'bookkeeping_finance_document',
        sourceRef: `finance-document:${documentRef.id}`,
        evidenceType: 'tax_form',
        title: seed.title,
        documentDate: seed.documentDate,
        vendorName: seed.vendorName,
        amount: null,
        externalUrl: null,
        mimeType: 'text/plain',
        digitizationStatus: 'seeded_sample',
        summary: {
          notes: seed.notes,
          extractedFields: mergedExtractedFields,
          digitization: {
            status: 'seeded_sample',
            provider: 'fixture',
            processedAt: now,
            mimeType: 'text/plain',
            pageCount: 1,
            rawTextLength: seed.contentPreview.length,
            summary: 'Synthetic W-2 seeded for sample taxpayer backtest',
          },
        },
        extractedText: seed.contentPreview,
        createdBy: authUser?.email || authUser?.uid || userId,
        links: [
          {
            entityType: 'bookkeeping_finance_document',
            entityId: documentRef.id,
            linkRole: 'source_document',
          },
        ],
      });
    } catch (error) {
      console.error('[Bookkeeping] Sample personal tax evidence persistence error:', error);
      evidenceShadow = {
        ok: false,
        status: 'failed',
        error: error.message,
      };
    }

    const financeDocument = {
      title: seed.title,
      documentType: 'tax_form',
      vendorName: seed.vendorName,
      documentDate: seed.documentDate,
      amount: null,
      notes: seed.notes,
      propertyId: null,
      mimeType: 'text/plain',
      originalFileName: seed.originalFileName,
      storedRelativePath: null,
      downloadPath: null,
      sourceUrl: null,
      digitization: {
        status: 'seeded_sample',
        provider: 'fixture',
        processedAt: now,
        mimeType: 'text/plain',
        pageCount: 1,
        rawTextLength: seed.contentPreview.length,
        summary: 'Synthetic W-2 seeded for sample taxpayer backtest',
        personalTaxExtraction: personalTaxExtraction
          ? {
              provider: GEMINI_API_KEY ? 'gemini' : 'heuristic',
              model: GEMINI_API_KEY ? 'gemini-2.5-flash' : 'heuristic-fallback',
              status: personalTaxExtraction.extractionStatus,
              documentSubtype: personalTaxExtraction.documentSubtype,
              confidence: personalTaxExtraction.confidence,
              reviewNotes: personalTaxExtraction.reviewNotes,
            }
          : null,
      },
      extractedFields: mergedExtractedFields,
      contentPreview: seed.contentPreview,
      evidenceShadow,
      createdAt: now,
      updatedAt: now,
      uploadedBy: authUser?.email || authUser?.uid || userId,
      isMockData: true,
      mockDataTag: SAMPLE_PERSONAL_TAX_BACKTEST_TAG,
      sampleBacktest: {
        fixtureName: 'prestwick-rental-2025',
        role: 'sample_taxpayer_w2',
        employeeName: seed.employeeName,
      },
    };

    await documentRef.set(financeDocument);
    seededDocuments.push({
      id: documentRef.id,
      ...financeDocument,
    });
  }

  return seededDocuments;
}

// ============================================================================
// PER-CARD AI METRIC EXPLANATIONS (Bookkeeping + Tax Center)
// ============================================================================

const METRIC_EXPLAIN_OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const METRIC_EXPLAIN_MODEL = process.env.OPENAI_METRIC_EXPLAIN_MODEL || 'gpt-4o-mini';
const METRIC_EXPLAIN_DISCLAIMER = 'AI-generated explanation grounded in your current ledger data. Verify against source records before relying on it for filings.';

function buildMetricExplainFallback({ label, value, detail, citations }) {
  const lead = detail || `${label}${value ? ` is currently ${value}` : ''}.`;
  return {
    explanation: lead,
    bullets: (Array.isArray(citations) ? citations : []).slice(0, 4),
    confidence: 'medium',
    aiGenerated: false,
  };
}

/**
 * POST /api/bookkeeping/firestore/explain-metric
 * Body: {
 *   surface: 'bookkeeping' | 'tax',
 *   metricId: string,
 *   label: string,
 *   value?: string,
 *   detail?: string,
 *   citations: string[],
 * }
 */
router.post('/explain-metric', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      surface,
      metricId,
      label,
      value = '',
      detail = '',
      citations = [],
    } = req.body || {};

    if (surface !== 'bookkeeping' && surface !== 'tax') {
      return res.status(400).json({ ok: false, error: "Invalid 'surface' — must be 'bookkeeping' or 'tax'." });
    }
    if (!label || typeof label !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_label' });
    }

    const groundingCitations = Array.isArray(citations)
      ? citations.filter((item) => typeof item === 'string' && item.trim()).slice(0, 12)
      : [];

    if (!METRIC_EXPLAIN_OPENAI_API_KEY) {
      return res.json({
        ok: true,
        ...buildMetricExplainFallback({ label, value, detail, citations: groundingCitations }),
        disclaimer: METRIC_EXPLAIN_DISCLAIMER,
        warning: 'OPENAI_API_KEY not configured on this server — showing the underlying citations directly.',
      });
    }

    const systemPrompt = 'You are a precise financial analyst embedded in a property owner\'s bookkeeping/tax dashboard. '
      + 'You explain ONE metric at a time to a non-accountant owner. '
      + 'Ground your explanation strictly in the provided citations — they are the only facts you may reference. '
      + 'Never invent numbers, dates, or facts that are not present in the citations. '
      + 'If the citations are sparse, say so plainly rather than guessing. '
      + 'Write 2-4 plain-English sentences, then up to 4 short supporting bullet points. '
      + 'Return strict JSON: {"explanation": string, "bullets": string[], "confidence": "high"|"medium"|"low"}.';

    const userPrompt = JSON.stringify({
      surface,
      metricId,
      metricLabel: label,
      metricValue: value,
      existingTemplateDetail: detail,
      groundingCitations,
    });

    let aiPayload = null;
    let warning = null;
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${METRIC_EXPLAIN_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: METRIC_EXPLAIN_MODEL,
          temperature: 0.2,
          max_tokens: 500,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        warning = `OpenAI request failed (${response.status}): ${errorText.slice(0, 300)}`;
      } else {
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (content) {
          try {
            aiPayload = JSON.parse(content);
          } catch {
            aiPayload = { explanation: content };
          }
        }
      }
    } catch (fetchError) {
      warning = `OpenAI request error: ${fetchError.message}`;
    }

    if (!aiPayload || !aiPayload.explanation) {
      console.warn(`[Bookkeeping][ExplainMetric] Falling back for metric ${metricId} (user ${userId}):`, warning || 'no content');
      return res.json({
        ok: true,
        ...buildMetricExplainFallback({ label, value, detail, citations: groundingCitations }),
        disclaimer: METRIC_EXPLAIN_DISCLAIMER,
        warning: warning || 'AI did not return an explanation — showing the underlying citations directly.',
      });
    }

    const confidence = ['high', 'medium', 'low'].includes(aiPayload.confidence) ? aiPayload.confidence : 'medium';

    return res.json({
      ok: true,
      explanation: String(aiPayload.explanation || '').trim(),
      bullets: Array.isArray(aiPayload.bullets)
        ? aiPayload.bullets.filter((item) => typeof item === 'string' && item.trim()).slice(0, 4)
        : [],
      confidence,
      aiGenerated: true,
      model: METRIC_EXPLAIN_MODEL,
      disclaimer: METRIC_EXPLAIN_DISCLAIMER,
    });
  } catch (error) {
    console.error('[Bookkeeping][ExplainMetric] Error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'explain_metric_failed' });
  }
});

export default router;

export {
  createPostedJournalEntry,
  loadCanonicalLedgerEntriesForScope,
  buildCanonicalTransactions,
  deriveCanonicalTaxCategory,
  normalizeCanonicalTaxCategory,
};
