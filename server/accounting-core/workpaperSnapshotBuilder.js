import { ACCOUNTING_PACKET_READINESS } from '../../src/shared/accountingDomain.js';
import { getTaxRulesetPackage, getTax1099ThresholdForTaxYear } from '../../src/shared/taxRules.js';
import {
  calculateDepreciation,
  generateScheduleE,
  getTaxDocumentChecklist
} from '../tax-engine.js';

function assertRulesetMatchesTaxYear(taxYear, ruleset = null, context = 'Tax workpaper snapshot') {
  const canonicalRuleset = getTaxRulesetPackage(taxYear);
  const expectedRulesVersion = canonicalRuleset?.rulesVersion || null;
  const receivedRulesVersion = ruleset?.rulesVersion || null;

  if (!expectedRulesVersion) {
    throw new Error(`${context}: no approved ruleset is available for tax year ${taxYear}`);
  }

  if (!ruleset) {
    return canonicalRuleset;
  }

  if (Number(ruleset.taxYear) !== Number(taxYear)) {
    throw new Error(`${context}: ruleset tax year ${ruleset.taxYear} does not match requested tax year ${taxYear}`);
  }

  if (receivedRulesVersion !== expectedRulesVersion) {
    throw new Error(`${context}: expected rulesVersion ${expectedRulesVersion} for tax year ${taxYear}, received ${receivedRulesVersion}`);
  }

  return ruleset;
}

export function buildVendors1099Summary(entries = [], vendors = [], taxYear, ruleset = null) {
  const resolvedRuleset = ruleset || getTaxRulesetPackage(taxYear);
  const threshold1099 = Number(resolvedRuleset?.tax1099?.activeThreshold) || getTax1099ThresholdForTaxYear(taxYear);
  const vendorInfoByName = new Map((vendors || []).map((vendor) => [vendor.name, vendor]));
  const paymentsByVendor = new Map();

  (entries || [])
    .filter((entry) => entry.type === 'expense' && entry.vendor)
    .forEach((entry) => {
      const amount = Math.abs(Number(entry.amount) || 0);
      if (!amount) {
        return;
      }

      paymentsByVendor.set(entry.vendor, (paymentsByVendor.get(entry.vendor) || 0) + amount);
    });

  const vendors1099 = Array.from(paymentsByVendor.entries())
    .map(([name, totalPaid]) => {
      const vendor = vendorInfoByName.get(name) || {};
      const requires1099 = totalPaid >= threshold1099 && vendor.vendorType !== 'ccorp' && vendor.vendorType !== 'corporation';
      const hasTIN = Boolean(vendor.ein || vendor.ssnLast4);
      const hasAddress = Boolean(vendor.address);
      const hasW9 = Boolean(vendor.w9OnFile);

      return {
        name,
        totalPaid: Math.round(totalPaid * 100) / 100,
        requires1099,
        ready: requires1099 && hasTIN && hasAddress && hasW9,
        missingInfo: requires1099
          ? [
              !hasTIN ? 'TIN' : null,
              !hasAddress ? 'Address' : null,
              !hasW9 ? 'W-9' : null
            ].filter(Boolean)
          : []
      };
    })
    .sort((left, right) => right.totalPaid - left.totalPaid);

  const reportableVendors = vendors1099.filter((vendor) => vendor.requires1099);

  return {
    threshold1099,
    totalForms: reportableVendors.length,
    totalAmount: Math.round(reportableVendors.reduce((sum, vendor) => sum + vendor.totalPaid, 0) * 100) / 100,
    formsReady: reportableVendors.filter((vendor) => vendor.ready).length,
    formsWithMissingInfo: reportableVendors.filter((vendor) => vendor.missingInfo.length > 0).length,
    vendors: vendors1099
  };
}

function normalizeGateMessages(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function normalizeStateCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function buildScopeGateSummary(properties = []) {
  const rentalStates = Array.from(new Set(
    (properties || [])
      .map((property) => normalizeStateCode(property?.state || property?.attomState || property?.mailingState))
      .filter(Boolean)
  ));

  if (rentalStates.length <= 1) {
    return {
      blockers: [],
      warnings: [],
      rentalStates,
    };
  }

  return {
    blockers: [
      `Rental properties in this packet span multiple states (${rentalStates.join(', ')}). Filing-grade resident credits, apportionment, conformity adjustments, and local tax overlays are not fully modeled, so packet release must remain blocked until a preparer reviews the state returns.`
    ],
    warnings: [],
    rentalStates,
  };
}

function buildPacketGateSummary({ ruleset = null, rulesValidation = null, fixtureGate = null, edgeCaseReview = null, scopeGate = null } = {}) {
  const validation = rulesValidation || ruleset?.validation || null;
  const rulesBlockers = normalizeGateMessages(validation?.blockers);
  const rulesWarnings = normalizeGateMessages(validation?.warnings);
  const edgeBlockers = normalizeGateMessages(edgeCaseReview?.blockers);
  const edgeWarnings = [
    ...normalizeGateMessages(edgeCaseReview?.warnings),
    ...normalizeGateMessages(edgeCaseReview?.missingInfoQuestions),
  ];
  const scopeBlockers = normalizeGateMessages(scopeGate?.blockers);
  const scopeWarnings = normalizeGateMessages(scopeGate?.warnings);
  const fixtureStatus = fixtureGate?.status || validation?.fixtureGate?.status || ruleset?.validation?.fixtureGate?.status || 'not_run';
  const blockers = [
    ...rulesBlockers,
    ...edgeBlockers,
    ...scopeBlockers,
  ];
  const warnings = [
    ...rulesWarnings,
    ...edgeWarnings,
    ...scopeWarnings,
  ];

  if (fixtureStatus === 'failed') {
    blockers.push('Tax fixture gate failed for the active ruleset.');
  } else if (fixtureStatus === 'not_run') {
    warnings.push('Tax fixture gate has not run for the active ruleset.');
  }

  return {
    rulesValidationStatus: validation?.status || 'not_attached',
    fixtureGateStatus: fixtureStatus,
    edgeCaseReviewStatus: edgeCaseReview?.status || 'not_run',
    blockerCount: blockers.length,
    warningCount: warnings.length,
    blockers,
    warnings,
  };
}

function resolvePacketReadiness(documentChecklist, packetGates = null) {
  const requiredDocuments = (documentChecklist?.documents || []).filter((document) => document.required);

  if (requiredDocuments.length === 0) {
    return ACCOUNTING_PACKET_READINESS.DRAFT;
  }

  if (packetGates?.blockerCount > 0) {
    return ACCOUNTING_PACKET_READINESS.BLOCKED_MISSING_DATA;
  }

  const blockingStatuses = new Set(['action_required', 'awaiting_lender']);
  if (requiredDocuments.some((document) => blockingStatuses.has(document.status))) {
    return ACCOUNTING_PACKET_READINESS.BLOCKED_MISSING_DATA;
  }

  return ACCOUNTING_PACKET_READINESS.READY_FOR_CPA_REVIEW;
}

export function buildTaxWorkpaperSnapshot({
  taxYear,
  entries = [],
  properties = [],
  vendors = [],
  ruleset = null,
  rulesValidation = null,
  fixtureGate = null,
  edgeCaseReview = null
}) {
  const resolvedRuleset = assertRulesetMatchesTaxYear(taxYear, ruleset, 'Tax workpaper snapshot');
  const scheduleE = generateScheduleE(entries, taxYear, null, properties, resolvedRuleset);
  const depreciation = calculateDepreciation(properties, taxYear, resolvedRuleset);
  const vendors1099 = buildVendors1099Summary(entries, vendors, taxYear, resolvedRuleset);
  const documentChecklist = getTaxDocumentChecklist(scheduleE, depreciation, vendors1099, resolvedRuleset, properties);
  const scopeGate = buildScopeGateSummary(properties);
  const packetGates = buildPacketGateSummary({
    ruleset: resolvedRuleset,
    rulesValidation,
    fixtureGate,
    edgeCaseReview,
    scopeGate,
  });
  const packetReadiness = resolvePacketReadiness(documentChecklist, packetGates);

  return {
    taxYear,
    rulesVersion: resolvedRuleset.rulesVersion,
    rulesApprovalStatus: resolvedRuleset.approvalStatus,
    rulesLastReviewedAt: resolvedRuleset.lastReviewedAt || null,
    rulesGovernance: resolvedRuleset.governance || null,
    packetGates,
    packetReadiness,
    sourceLedger: 'azure-sql-canonical-ledger',
    summary: {
      entryCount: entries.length,
      propertyCount: properties.length,
      vendorCount: vendors.length,
      totalIncome: scheduleE.summary.totalIncome,
      totalExpenses: scheduleE.summary.totalExpenses,
      totalDepreciation: depreciation.summary.totalCurrentYearDepreciation,
      reportable1099Vendors: vendors1099.totalForms,
      rulesSourceDocumentCount: (resolvedRuleset.sourceDocuments || []).length,
    },
    scheduleE,
    depreciation,
    vendors1099,
    documentChecklist,
    generatedAt: new Date().toISOString()
  };
}