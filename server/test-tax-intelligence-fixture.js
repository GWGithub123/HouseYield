import assert from 'node:assert/strict';
import { getTaxRulesetPackage } from '../src/shared/taxRules.js';
import { buildTaxWorkpaperSnapshot } from './accounting-core/workpaperSnapshotBuilder.js';
import {
  buildClaudeRulesetExtractionContract,
  validateTaxRulesetCandidate,
} from './accounting-core/taxRulesetValidation.js';
import {
  buildClaudeTaxEdgeCaseReviewContract,
  reviewTaxEdgeCases,
} from './accounting-core/taxEdgeCaseReviewer.js';
import {
  applySourceAuditOverrides,
  auditInformationReportingThreshold,
  buildSystemicSourceRuleAudits,
} from './accounting-core/taxRulesetSourceAudit.js';

const taxYear = 2025;
const ruleset = getTaxRulesetPackage(taxYear);

const passedValidation = validateTaxRulesetCandidate({
  candidateRuleset: ruleset,
  taxYear,
  fixtureGate: { status: 'passed' },
});

assert.equal(passedValidation.status, 'passed', 'canonical ruleset validates');
assert.equal(passedValidation.activationAllowed, true, 'fixture-passed ruleset can activate');
assert.ok(passedValidation.sourceCoverage.irsDocumentCount >= 5, 'IRS source coverage is present');

const blockedValidation = validateTaxRulesetCandidate({
  candidateRuleset: { taxYear, rulesVersion: 'test.missing' },
  taxYear,
  fixtureGate: { status: 'failed' },
});

assert.equal(blockedValidation.status, 'blocked', 'incomplete ruleset blocks activation');
assert.equal(blockedValidation.activationAllowed, false, 'failed fixture gate prevents activation');
assert.ok(blockedValidation.blockers.length > 0, 'blocked validation returns blockers');

const wrong2026ThresholdRuleset = {
  ...getTaxRulesetPackage(2026),
  tax1099: {
    ...getTaxRulesetPackage(2026).tax1099,
    activeThreshold: 600,
    activeThresholdSummary: 'stale $600',
  },
};
const thresholdAudit = auditInformationReportingThreshold({
  taxYear: 2026,
  candidateRuleset: wrong2026ThresholdRuleset,
  sourceSnapshots: [{
    id: 'irs-publication-1099',
    title: 'Publication 1099 (2026), General Instructions for Certain Information Returns',
    authority: 'IRS',
    category: 'information-reporting',
    url: 'https://www.irs.gov/publications/p1099',
    fetchStatus: 'fetched',
    textExcerpt: 'Increase in threshold for requiring filing of certain information returns and backup withholding. For tax years beginning after 2025, the minimum threshold amount for reporting certain payments required to be reported on certain information returns and/or perform backup withholding on those payments increased to $2,000 and will be adjusted for inflation beginning in calendar year 2027. Previously, the threshold amount was $600.',
  }],
});
const sourceCorrectedRuleset = applySourceAuditOverrides(wrong2026ThresholdRuleset, [thresholdAudit]);
assert.equal(thresholdAudit.status, 'corrected', 'source audit detects stale 1099 threshold');
assert.equal(sourceCorrectedRuleset.tax1099.activeThreshold, 2000, 'source audit applies extracted 1099 threshold');
assert.equal(sourceCorrectedRuleset.tax1099.sourceDocumentId, 'irs-publication-1099', 'source audit preserves source document id');

const rules2026 = getTaxRulesetPackage(2026);
const federalAmountsText = [
  ...Object.values(rules2026.standardDeduction || {}),
  ...Object.values(rules2026.federalTaxBrackets || {}).flatMap((brackets) => (
    brackets.flatMap((bracket) => [bracket.min, bracket.max]).filter((amount) => Number.isFinite(amount) && amount > 0)
  )),
].map((amount) => `$${Number(amount).toLocaleString('en-US')}`).join(' ');
const systemicAudits = buildSystemicSourceRuleAudits({
  taxYear: 2026,
  candidateRuleset: {
    ...wrong2026ThresholdRuleset,
    sourceAuditRequirements: rules2026.sourceAuditRequirements,
  },
  sourceSnapshots: [
    {
      id: 'irs-federal-tax-rates',
      title: 'Internal Revenue Bulletin 2025-45, Revenue Procedure 2025-32',
      authority: 'IRS',
      category: 'federal-brackets',
      url: 'https://www.irs.gov/irb/2025-45_IRB',
      fetchStatus: 'fetched',
      textExcerpt: federalAmountsText,
    },
    {
      id: 'irs-publication-1099',
      title: 'Publication 1099 (2026), General Instructions for Certain Information Returns',
      authority: 'IRS',
      category: 'information-reporting',
      url: 'https://www.irs.gov/publications/p1099',
      fetchStatus: 'fetched',
      textExcerpt: 'For tax years beginning after 2025, the minimum threshold amount for reporting certain payments required to be reported on certain information returns and/or perform backup withholding on those payments increased to $2,000 and will be adjusted for inflation beginning in calendar year 2027. Previously, the threshold amount was $600.',
    },
    {
      id: 'irs-schedule-e-instructions',
      title: '2026 draft Schedule E (Form 1040), Supplemental Income and Loss',
      authority: 'IRS',
      url: 'https://www.irs.gov/pub/irs-dft/f1040se--dft.pdf',
      fetchStatus: 'fetched',
      textExcerpt: 'Schedule E source attached.',
    },
    {
      id: 'irs-form-1040-es',
      title: '2026 Form 1040-ES, Estimated Tax for Individuals',
      authority: 'IRS',
      url: 'https://www.irs.gov/pub/irs-pdf/f1040es.pdf',
      fetchStatus: 'fetched',
      textExcerpt: '1040-ES source attached.',
    },
    {
      id: 'irs-publication-527',
      title: 'Publication 527 current revision status',
      authority: 'IRS',
      url: 'https://www.irs.gov/publications/p527',
      fetchStatus: 'fetched',
      textExcerpt: 'Publication 527 source attached.',
    },
  ],
});
assert.equal(systemicAudits.every((audit) => audit.status === 'passed' || audit.status === 'corrected'), true, 'systemic source audits pass or correct all required rule groups');
assert.equal(systemicAudits.some((audit) => audit.id === 'federal-brackets' && audit.status === 'passed'), true, 'federal brackets are source-audited');
assert.equal(systemicAudits.some((audit) => audit.id === 'standard-deduction' && audit.status === 'passed'), true, 'standard deduction is source-audited');
assert.equal(systemicAudits.some((audit) => audit.id === '1099-nec-threshold' && audit.status === 'corrected'), true, '1099 threshold is source-corrected inside systemic audit plan');

const rulesContract = buildClaudeRulesetExtractionContract(taxYear);
assert.equal(rulesContract.modelRole, 'extract_candidate_rules_only');
assert.ok(rulesContract.hardConstraints.some((constraint) => constraint.includes('Do not calculate taxpayer amounts')));

const edgeContract = buildClaudeTaxEdgeCaseReviewContract();
assert.equal(edgeContract.modelRole, 'post_computation_tax_edge_case_reviewer');
assert.ok(edgeContract.hardConstraints.some((constraint) => constraint.includes('Do not calculate or recalculate tax amounts')));

const edgeReview = await reviewTaxEdgeCases({
  preferClaude: false,
  context: {
    taxYear,
    rulesMetadata: {
      rulesRuntime: {
        rulesVersion: ruleset.rulesVersion,
        source: 'fixture',
      },
      validation: { warnings: [] },
      activationValidation: { blockers: [] },
    },
    taxLiability: {
      modelingReadiness: {
        blockers: [],
        warnings: [],
      },
    },
    draftFormProfile: {
      primaryName: 'Fixture Taxpayer',
      tinLast4: '1234',
      priorYearTotalTax: 1000,
    },
    checklist: {
      documents: [],
    },
  },
});

assert.equal(edgeReview.status, 'clear', 'edge review clears complete context');
assert.ok(edgeReview.guardrails.some((constraint) => constraint.includes('Do not alter Schedule E')));

const blockedSnapshot = buildTaxWorkpaperSnapshot({
  taxYear,
  entries: [{ type: 'income', category: 'Rent Income', amount: 1000, date: `${taxYear}-01-15` }],
  properties: [],
  vendors: [],
  ruleset: {
    ...ruleset,
    validation: blockedValidation,
  },
});

assert.equal(blockedSnapshot.packetGates.rulesValidationStatus, 'blocked', 'snapshot carries rules validation gate');
assert.equal(blockedSnapshot.packetGates.blockerCount > 0, true, 'snapshot carries gate blockers');

const multiStateSnapshot = buildTaxWorkpaperSnapshot({
  taxYear,
  entries: [
    { type: 'income', category: 'Rent Income', amount: 1000, date: `${taxYear}-01-15`, propertyId: 'md-prop' },
    { type: 'income', category: 'Rent Income', amount: 1200, date: `${taxYear}-01-16`, propertyId: 'va-prop' },
  ],
  properties: [
    { id: 'md-prop', propertyName: 'Maryland Rental', address: '1 State St', state: 'MD', purchasePrice: 300000, landValue: 60000, purchaseDate: '2020-01-01' },
    { id: 'va-prop', propertyName: 'Virginia Rental', address: '2 Border Rd', state: 'VA', purchasePrice: 320000, landValue: 70000, purchaseDate: '2021-01-01' },
  ],
  vendors: [],
  ruleset,
});
assert.equal(multiStateSnapshot.packetReadiness, 'blocked_missing_data', 'multi-state packets stay blocked for release');
assert.ok(
  multiStateSnapshot.packetGates.blockers.some((blocker) => blocker.includes('multiple states')),
  'multi-state packet gate is explicit',
);

assert.throws(
  () => buildTaxWorkpaperSnapshot({
    taxYear,
    entries: [],
    properties: [],
    vendors: [],
    ruleset: getTaxRulesetPackage(2026),
  }),
  /ruleset tax year 2026 does not match requested tax year 2025/,
  'snapshot builder rejects mismatched year/version rulesets',
);

console.log('Tax intelligence fixture passed: rules validation, Claude contracts, edge review, packet gates');
