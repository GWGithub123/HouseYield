import { getTaxRulesetPackage } from '../../src/shared/taxRules.js';

const REQUIRED_RULE_GROUPS = [
  {
    id: 'source-documents',
    label: 'IRS/source documents',
    validate: (ruleset) => Array.isArray(ruleset.sourceDocuments) && ruleset.sourceDocuments.length >= 5,
  },
  {
    id: 'schedule-e-line-map',
    label: 'Schedule E line map',
    validate: (ruleset) => ruleset.scheduleELineMap && Object.keys(ruleset.scheduleELineMap).length >= 10,
  },
  {
    id: 'federal-brackets',
    label: 'Federal tax brackets',
    validate: (ruleset) => ruleset.federalTaxBrackets && Object.keys(ruleset.federalTaxBrackets).length >= 4,
  },
  {
    id: 'standard-deduction',
    label: 'Standard deduction',
    validate: (ruleset) => ruleset.standardDeduction && Object.keys(ruleset.standardDeduction).length >= 4,
  },
  {
    id: 'estimated-tax',
    label: '1040-ES estimated-tax rules',
    validate: (ruleset) => Array.isArray(ruleset.deadlineTemplates) && ruleset.deadlineTemplates.length >= 4,
  },
  {
    id: 'depreciation',
    label: 'Rental depreciation rules',
    validate: (ruleset) => Number(ruleset.depreciation?.residentialRentalUsefulLifeMonths) > 0,
  },
  {
    id: '1099-nec',
    label: '1099-NEC threshold',
    validate: (ruleset) => Number(ruleset.tax1099?.activeThreshold) > 0,
  },
];

function normalizeRuleset(candidateRuleset, taxYear) {
  if (candidateRuleset && typeof candidateRuleset === 'object') {
    return candidateRuleset;
  }

  return getTaxRulesetPackage(taxYear);
}

function buildSourceCoverage(sourceDocuments = []) {
  const documents = Array.isArray(sourceDocuments) ? sourceDocuments : [];
  const missingUrlCount = documents.filter((document) => !document.url && document.authority === 'IRS').length;
  const missingReviewDateCount = documents.filter((document) => !document.lastReviewedAt).length;

  return {
    documentCount: documents.length,
    irsDocumentCount: documents.filter((document) => document.authority === 'IRS').length,
    houseYieldDocumentCount: documents.filter((document) => document.authority === 'HouseYield').length,
    missingUrlCount,
    missingReviewDateCount,
  };
}

export function validateTaxRulesetCandidate({
  candidateRuleset = null,
  taxYear,
  expectedRulesVersion = null,
  fixtureGate = null,
  sourceRuleAudits = [],
} = {}) {
  const ruleset = normalizeRuleset(candidateRuleset, taxYear);
  const sourceCoverage = buildSourceCoverage(ruleset.sourceDocuments);
  const groupResults = REQUIRED_RULE_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    status: group.validate(ruleset) ? 'passed' : 'failed',
  }));
  const warnings = [];
  const blockers = [];

  if (!ruleset.taxYear) {
    blockers.push('Ruleset is missing taxYear.');
  }

  if (!ruleset.rulesVersion) {
    blockers.push('Ruleset is missing rulesVersion.');
  } else if (expectedRulesVersion && ruleset.rulesVersion !== expectedRulesVersion) {
    warnings.push(`Rules version ${ruleset.rulesVersion} does not match expected ${expectedRulesVersion}.`);
  }

  if (sourceCoverage.documentCount < 5) {
    blockers.push('Ruleset must include source documents before activation.');
  }

  if (sourceCoverage.missingUrlCount > 0) {
    warnings.push(`${sourceCoverage.missingUrlCount} IRS source document(s) are missing URLs.`);
  }

  if (sourceCoverage.missingReviewDateCount > 0) {
    warnings.push(`${sourceCoverage.missingReviewDateCount} source document(s) are missing lastReviewedAt.`);
  }

  const failedGroups = groupResults.filter((group) => group.status !== 'passed');
  failedGroups.forEach((group) => {
    blockers.push(`${group.label} did not pass schema coverage validation.`);
  });

  if (fixtureGate && fixtureGate.status !== 'passed') {
    blockers.push(`Fixture gate has not passed: ${fixtureGate.status || 'unknown'}.`);
  }

  const sourceAuditBlockers = (sourceRuleAudits || []).flatMap((audit) => audit.activationBlockers || audit.blockers || []);
  const sourceAuditWarnings = (sourceRuleAudits || []).flatMap((audit) => audit.warnings || []);
  blockers.push(...sourceAuditBlockers);
  warnings.push(...sourceAuditWarnings);

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'passed' : 'blocked',
    taxYear: ruleset.taxYear || taxYear || null,
    rulesVersion: ruleset.rulesVersion || null,
    sourceCoverage,
    groupResults,
    fixtureGate: fixtureGate || {
      status: 'not_run',
      requiredBeforeActivation: true,
    },
    sourceRuleAudits,
    warnings,
    blockers,
    activationAllowed: blockers.length === 0 && fixtureGate?.status === 'passed',
  };
}

export function buildClaudeRulesetExtractionContract(taxYear) {
  return {
    taxYear,
    modelRole: 'extract_candidate_rules_only',
    hardConstraints: [
      'Do not calculate taxpayer amounts.',
      'Do not fill tax forms.',
      'Return structured candidate rules and source citations only.',
      'Every extracted rule must cite an IRS or HouseYield source document.',
      'Low-confidence or ambiguous changes must be represented as warnings, not active rules.',
    ],
    requiredOutputShape: {
      taxYear: 'number',
      rulesVersion: 'string',
      sourceDocuments: 'array',
      ruleDiffs: 'array',
      candidateRuleset: 'object',
      confidence: 'number',
      warnings: 'array',
      blockers: 'array',
    },
  };
}
