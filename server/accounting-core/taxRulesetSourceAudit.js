function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDollarAmount(value) {
  const parsed = Number(String(value || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAmount(amount) {
  return `$${Number(amount).toLocaleString('en-US')}`;
}

function sourceById(sourceSnapshots = []) {
  return new Map((sourceSnapshots || []).map((source) => [source.id, source]));
}

function getSourcesForRequirement(requirement = {}, sourceSnapshots = []) {
  const byId = sourceById(sourceSnapshots);
  return (requirement.sourceDocumentIds || [])
    .map((id) => byId.get(id))
    .filter(Boolean);
}

function amountAppearsInSource(amount, sources = []) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) {
    return null;
  }

  const comma = numericAmount.toLocaleString('en-US');
  const plain = String(numericAmount);
  for (const source of sources) {
    const text = normalizeWhitespace(source.textExcerpt || source.scope || '');
    if (text.includes(`$${comma}`) || text.includes(`$${plain}`) || text.includes(comma)) {
      return {
        sourceDocumentId: source.id,
        sourceTitle: source.title,
        sourceUrl: source.url || null,
        evidence: `${formatAmount(numericAmount)} appears in ${source.title}.`,
      };
    }
  }

  return null;
}

function buildSourcePresenceAudit(requirement = {}, sourceSnapshots = []) {
  const sources = getSourcesForRequirement(requirement, sourceSnapshots);
  const missingSourceIds = (requirement.sourceDocumentIds || [])
    .filter((id) => !sources.some((source) => source.id === id));
  const unfetchedSources = sources.filter((source) => (
    source.authority === 'IRS'
    && source.url
    && source.fetchStatus !== 'fetched'
  ));
  const blockers = [
    ...missingSourceIds.map((id) => `Required source document ${id} is missing from the yearly rules package.`),
    ...unfetchedSources.map((source) => `Required source document ${source.title} was not fetched successfully (${source.fetchStatus || 'unknown'}).`),
  ];

  return {
    id: requirement.id,
    label: requirement.label,
    auditType: requirement.auditType,
    requiredForActivation: Boolean(requirement.requiredForActivation),
    status: blockers.length > 0 ? 'blocked' : 'passed',
    sourceDocumentIds: requirement.sourceDocumentIds || [],
    sourceTitle: sources[0]?.title || null,
    sourceUrl: sources[0]?.url || null,
    evidence: blockers.length > 0 ? null : `Required source document${sources.length === 1 ? '' : 's'} fetched or attached for ${requirement.label}.`,
    warnings: [],
    blockers,
  };
}

function auditStandardDeduction(requirement = {}, candidateRuleset = {}, sourceSnapshots = []) {
  const sources = getSourcesForRequirement(requirement, sourceSnapshots);
  const deductionEntries = Object.entries(candidateRuleset.standardDeduction || {});
  const missing = [];
  const matched = [];

  for (const [filingStatus, amount] of deductionEntries) {
    const match = amountAppearsInSource(amount, sources);
    if (match) {
      matched.push({ filingStatus, amount: Number(amount), ...match });
    } else {
      missing.push(`${filingStatus} ${formatAmount(amount)}`);
    }
  }

  const blockers = missing.length > 0
    ? [`Standard deduction amount(s) not found in required source: ${missing.join(', ')}.`]
    : [];

  return {
    id: requirement.id,
    label: requirement.label,
    auditType: requirement.auditType,
    requiredForActivation: Boolean(requirement.requiredForActivation),
    status: blockers.length > 0 ? 'blocked' : 'passed',
    sourceDocumentIds: requirement.sourceDocumentIds || [],
    sourceTitle: matched[0]?.sourceTitle || sources[0]?.title || null,
    sourceUrl: matched[0]?.sourceUrl || sources[0]?.url || null,
    evidence: blockers.length > 0
      ? null
      : `${matched.length} standard-deduction amount(s) matched the annual federal source.`,
    matchedAmounts: matched,
    warnings: [],
    blockers,
  };
}

function collectBracketAmounts(bracketTable = {}) {
  const amounts = new Set();
  for (const brackets of Object.values(bracketTable || {})) {
    for (const bracket of brackets || []) {
      if (Number.isFinite(Number(bracket.min)) && Number(bracket.min) > 0) {
        amounts.add(Number(bracket.min));
      }
      if (Number.isFinite(Number(bracket.max)) && Number(bracket.max) > 0) {
        amounts.add(Number(bracket.max));
      }
    }
  }
  return [...amounts].sort((left, right) => left - right);
}

function auditFederalBrackets(requirement = {}, candidateRuleset = {}, sourceSnapshots = []) {
  const sources = getSourcesForRequirement(requirement, sourceSnapshots);
  const bracketAmounts = collectBracketAmounts(candidateRuleset.federalTaxBrackets || {});
  const missing = [];
  const matched = [];

  for (const amount of bracketAmounts) {
    const match = amountAppearsInSource(amount, sources);
    if (match) {
      matched.push({ amount, ...match });
    } else {
      missing.push(formatAmount(amount));
    }
  }

  const blockers = missing.length > 0
    ? [`Federal bracket threshold amount(s) not found in required source: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? `, and ${missing.length - 12} more` : ''}.`]
    : [];

  return {
    id: requirement.id,
    label: requirement.label,
    auditType: requirement.auditType,
    requiredForActivation: Boolean(requirement.requiredForActivation),
    status: blockers.length > 0 ? 'blocked' : 'passed',
    sourceDocumentIds: requirement.sourceDocumentIds || [],
    sourceTitle: matched[0]?.sourceTitle || sources[0]?.title || null,
    sourceUrl: matched[0]?.sourceUrl || sources[0]?.url || null,
    evidence: blockers.length > 0
      ? null
      : `${matched.length} federal bracket threshold amount(s) matched the annual federal source.`,
    matchedAmountCount: matched.length,
    expectedAmountCount: bracketAmounts.length,
    warnings: [],
    blockers,
  };
}

function sourceAppliesToInformationReporting(source = {}) {
  const haystack = `${source.id || ''} ${source.title || ''} ${source.category || ''} ${source.scope || ''}`.toLowerCase();
  return haystack.includes('1099') || haystack.includes('information reporting') || haystack.includes('information return');
}

function findRelevantSentences(text) {
  const normalized = normalizeWhitespace(text);
  return normalized
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const lower = sentence.toLowerCase();
      return (
        lower.includes('1099-nec')
        || lower.includes('1099-misc')
        || lower.includes('information return')
        || lower.includes('information reporting')
      ) && lower.includes('threshold');
    })
    .slice(0, 12);
}

/**
 * Dynamically extracts the effective tax year from an IRS sentence by parsing the
 * actual year number mentioned in the text. This avoids hardcoding year-specific
 * string patterns (e.g. "after december 31, 2025") so the function works
 * automatically for any future threshold change without code modifications.
 *
 * Supported IRS phrasings:
 *   "after December 31, YYYY"               → effective year = YYYY + 1
 *   "payments made after December 31, YYYY" → effective year = YYYY + 1
 *   "tax years beginning after YYYY"        → effective year = YYYY + 1
 *   "beginning in YYYY"                     → effective year = YYYY
 *   "starting in YYYY"                      → effective year = YYYY
 *   "for tax year YYYY"                     → effective year = YYYY
 */
function extractEffectiveTaxYearFromSentence(lower) {
  // "after December 31, YYYY" — highest specificity, check first
  let m = lower.match(/after december 31,?\s+(\d{4})/);
  if (m) return Number(m[1]) + 1;

  // "tax years? beginning after YYYY"
  m = lower.match(/tax years?\s+beginning\s+after\s+(\d{4})/);
  if (m) return Number(m[1]) + 1;

  // "years? beginning after YYYY" (abbreviated form)
  m = lower.match(/years?\s+beginning\s+after\s+(\d{4})/);
  if (m) return Number(m[1]) + 1;

  // "beginning in YYYY" or "starting in YYYY"
  m = lower.match(/(?:beginning|starting)\s+in\s+(\d{4})/);
  if (m) return Number(m[1]);

  // "for tax year YYYY" or "for taxable year YYYY"
  m = lower.match(/for (?:tax|taxable) year\s+(\d{4})/);
  if (m) return Number(m[1]);

  // Generic "after YYYY" — lowest specificity, only when year is plausible future
  m = lower.match(/after\s+(20\d{2})/);
  if (m) return Number(m[1]) + 1;

  return null;
}

/**
 * Detects whether the sentence indicates the threshold is inflation-indexed after
 * a specific year, and returns that base year if found.
 */
function extractInflationIndexBaseYear(lower) {
  // "inflation-adjusted after YYYY" / "adjusted for inflation beginning in YYYY"
  let m = lower.match(/inflation[- ]adjusted\s+after\s+(20\d{2})/);
  if (m) return Number(m[1]);

  m = lower.match(/adjusted\s+for\s+inflation\s+(?:beginning|starting)\s+in\s+(20\d{2})/);
  if (m) return Number(m[1]);

  m = lower.match(/indexed\s+for\s+inflation\s+after\s+(20\d{2})/);
  if (m) return Number(m[1]);

  return null;
}

function extractInformationReportingThreshold({ taxYear, sourceSnapshots = [] } = {}) {
  const relevantSources = (sourceSnapshots || []).filter(sourceAppliesToInformationReporting);
  const sentences = relevantSources.flatMap((source) => (
    findRelevantSentences(source.textExcerpt || source.scope || '').map((sentence) => ({
      source,
      sentence,
    }))
  ));

  const thresholdFacts = [];
  for (const { source, sentence } of sentences) {
    const lower = sentence.toLowerCase();
    const dollarMatches = [...sentence.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d{3,5})/g)]
      .map((match) => parseDollarAmount(match[1]))
      .filter((amount) => Number.isFinite(amount) && amount >= 100);

    const effectiveTaxYear = extractEffectiveTaxYearFromSentence(lower);
    const inflationBaseYear = extractInflationIndexBaseYear(lower);
    const hasPriorThresholdSignal = (
      lower.includes('previously')
      || lower.includes('from $600')
      || lower.includes('old threshold')
      || lower.includes('and prior')
    );

    for (const amount of dollarMatches) {
      thresholdFacts.push({
        amount,
        sourceDocumentId: source.id,
        sourceTitle: source.title,
        sourceUrl: source.url || null,
        sentence,
        effectiveTaxYear,
        inflationBaseYear,
        priorYearSignal: hasPriorThresholdSignal,
      });
    }
  }

  const requestedTaxYear = Number(taxYear);

  // Prefer facts with a detected effective year and a raised threshold (≥ $1,000)
  const effectiveFact = thresholdFacts.find((fact) => (
    fact.effectiveTaxYear
    && requestedTaxYear >= fact.effectiveTaxYear
    && fact.amount >= 1000
  ));
  if (effectiveFact) {
    const inflationBaseYear = effectiveFact.inflationBaseYear ?? effectiveFact.effectiveTaxYear;
    return {
      status: 'extracted',
      taxYear: requestedTaxYear,
      activeThreshold: effectiveFact.amount,
      activeThresholdSummary: `source-audited $${effectiveFact.amount.toLocaleString('en-US')}`,
      sourceDocumentId: effectiveFact.sourceDocumentId,
      sourceTitle: effectiveFact.sourceTitle,
      sourceUrl: effectiveFact.sourceUrl,
      evidence: effectiveFact.sentence,
      effectiveTaxYear: effectiveFact.effectiveTaxYear,
      inflationIndexedAfterTaxYear: inflationBaseYear,
      warnings: requestedTaxYear > inflationBaseYear
        ? [
            `The source says this threshold is inflation-adjusted after ${inflationBaseYear}; `
            + 'future-year packages must extract the adjusted amount from the annual source before activation.',
          ]
        : [],
      blockers: [],
    };
  }

  // Fall back to prior-year $600 baseline for tax years ≤ 2025
  const priorFact = thresholdFacts.find((fact) => (
    requestedTaxYear <= 2025
    && fact.amount === 600
  ));
  if (priorFact) {
    return {
      status: 'extracted',
      taxYear: requestedTaxYear,
      activeThreshold: priorFact.amount,
      activeThresholdSummary: 'source-audited $600',
      sourceDocumentId: priorFact.sourceDocumentId,
      sourceTitle: priorFact.sourceTitle,
      sourceUrl: priorFact.sourceUrl,
      evidence: priorFact.sentence,
      effectiveTaxYear: null,
      inflationIndexedAfterTaxYear: null,
      warnings: [],
      blockers: [],
    };
  }

  return {
    status: 'not_extracted',
    taxYear: requestedTaxYear,
    activeThreshold: null,
    activeThresholdSummary: null,
    sourceDocumentId: null,
    sourceTitle: null,
    sourceUrl: null,
    evidence: null,
    effectiveTaxYear: null,
    inflationIndexedAfterTaxYear: null,
    warnings: [],
    blockers: ['Could not extract an annual 1099-NEC/1099-MISC reporting threshold from fetched source documents.'],
  };
}

export function auditInformationReportingThreshold({
  taxYear,
  candidateRuleset,
  sourceSnapshots = [],
} = {}) {
  const extraction = extractInformationReportingThreshold({ taxYear, sourceSnapshots });
  const currentThreshold = Number(candidateRuleset?.tax1099?.activeThreshold);
  const blockers = [...(extraction.blockers || [])];
  const warnings = [...(extraction.warnings || [])];
  const mismatch = Number.isFinite(extraction.activeThreshold)
    && Number.isFinite(currentThreshold)
    && extraction.activeThreshold !== currentThreshold;

  // Detect whether the source-extracted effective year differs from the candidate
  // ruleset's stored effective year; include it in the mismatch summary so callers
  // know when the effective year itself was updated by the source audit.
  const currentEffectiveYear = candidateRuleset?.tax1099?.raisedThresholdEffectiveTaxYear ?? null;
  const extractedEffectiveYear = extraction.effectiveTaxYear;
  const effectiveYearMismatch = (
    extractedEffectiveYear !== null
    && currentEffectiveYear !== null
    && extractedEffectiveYear !== currentEffectiveYear
  );

  return {
    id: '1099-nec-threshold',
    label: '1099-NEC / 1099-MISC reporting threshold',
    status: blockers.length > 0 ? 'blocked' : (mismatch || effectiveYearMismatch) ? 'corrected' : 'passed',
    taxYear: Number(taxYear),
    extractedThreshold: extraction.activeThreshold,
    extractedEffectiveTaxYear: extractedEffectiveYear,
    candidateThreshold: Number.isFinite(currentThreshold) ? currentThreshold : null,
    candidateEffectiveTaxYear: currentEffectiveYear,
    mismatch,
    effectiveYearMismatch,
    sourceDocumentId: extraction.sourceDocumentId,
    sourceTitle: extraction.sourceTitle,
    sourceUrl: extraction.sourceUrl,
    evidence: extraction.evidence,
    warnings,
    blockers,
    ruleOverride: blockers.length === 0 && Number.isFinite(extraction.activeThreshold)
      ? {
          tax1099: {
            ...(candidateRuleset?.tax1099 || {}),
            activeThreshold: extraction.activeThreshold,
            activeThresholdSummary: extraction.activeThresholdSummary,
            // Propagate the source-detected effective year so the stored ruleset
            // reflects the correct year automatically, without manual code edits.
            ...(extractedEffectiveYear !== null
              ? { raisedThresholdEffectiveTaxYear: extractedEffectiveYear }
              : {}),
            ...(extraction.inflationIndexedAfterTaxYear !== null
              ? { inflationIndexedAfterTaxYear: extraction.inflationIndexedAfterTaxYear }
              : {}),
            sourceDocumentId: extraction.sourceDocumentId,
            sourceTitle: extraction.sourceTitle,
            sourceUrl: extraction.sourceUrl,
            sourceRuleAudit: {
              status: (mismatch || effectiveYearMismatch) ? 'corrected_from_source' : 'matched_source',
              evidence: extraction.evidence,
              auditedAt: new Date().toISOString(),
            },
          },
        }
      : null,
  };
}

function normalizeAuditStatusForActivation(audit) {
  if (!audit?.requiredForActivation) {
    return [];
  }
  if (audit.status === 'passed' || audit.status === 'corrected') {
    return [];
  }
  return audit.blockers?.length
    ? audit.blockers
    : [`Required source audit ${audit.label || audit.id} did not pass.`];
}

export function buildSystemicSourceRuleAudits({
  taxYear,
  candidateRuleset,
  sourceSnapshots = [],
} = {}) {
  const requirements = Array.isArray(candidateRuleset?.sourceAuditRequirements)
    ? candidateRuleset.sourceAuditRequirements
    : [];

  return requirements.map((requirement) => {
    if (requirement.id === 'federal-brackets') {
      return auditFederalBrackets(requirement, candidateRuleset, sourceSnapshots);
    }
    if (requirement.id === 'standard-deduction') {
      return auditStandardDeduction(requirement, candidateRuleset, sourceSnapshots);
    }
    if (requirement.id === '1099-nec-threshold') {
      return {
        ...auditInformationReportingThreshold({ taxYear, candidateRuleset, sourceSnapshots }),
        auditType: requirement.auditType,
        requiredForActivation: Boolean(requirement.requiredForActivation),
        sourceDocumentIds: requirement.sourceDocumentIds || [],
      };
    }
    return buildSourcePresenceAudit(requirement, sourceSnapshots);
  }).map((audit) => ({
    ...audit,
    activationBlockers: normalizeAuditStatusForActivation(audit),
  }));
}

export function applySourceAuditOverrides(candidateRuleset, audits = []) {
  return (audits || []).reduce((ruleset, audit) => {
    const ruleOverride = audit?.ruleOverride || {};

    return {
      ...ruleset,
      ...ruleOverride,
      sourceRuleAudits: [
        ...(Array.isArray(ruleset.sourceRuleAudits) ? ruleset.sourceRuleAudits : []),
        {
          id: audit.id,
          label: audit.label,
          status: audit.status,
          sourceDocumentId: audit.sourceDocumentId,
          sourceTitle: audit.sourceTitle,
          evidence: audit.evidence,
          mismatch: audit.mismatch,
          extractedThreshold: audit.extractedThreshold,
          candidateThreshold: audit.candidateThreshold,
          auditType: audit.auditType,
          requiredForActivation: audit.requiredForActivation,
          activationBlockers: audit.activationBlockers,
          matchedAmountCount: audit.matchedAmountCount,
          expectedAmountCount: audit.expectedAmountCount,
          warnings: audit.warnings,
          blockers: audit.blockers,
        },
      ],
    };
  }, candidateRuleset);
}
