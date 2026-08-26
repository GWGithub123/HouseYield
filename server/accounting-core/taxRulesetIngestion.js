import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getTaxRulesetPackage } from '../../src/shared/taxRules.js';
import { upsertTaxRulesetToAzure } from './taxRulesetStore.js';
import {
  buildClaudeRulesetExtractionContract,
  validateTaxRulesetCandidate,
} from './taxRulesetValidation.js';
import {
  applySourceAuditOverrides,
  buildSystemicSourceRuleAudits,
} from './taxRulesetSourceAudit.js';

const execFileAsync = promisify(execFile);
const CLAUDE_API_KEY = process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_TAX_RULE_MODEL = process.env.CLAUDE_TAX_RULE_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

function extractTextFromClaudeResponse(response) {
  return (response?.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function extractJsonObject(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function fetchSourceDocument(document) {
  if (!document.url) {
    return {
      ...document,
      fetchStatus: 'not_fetchable',
      fetchedAt: new Date().toISOString(),
      textExcerpt: document.scope || '',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(document.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HouseYieldTaxRulesetIngestion/1.0',
      },
    });
    const text = await response.text();
    return {
      ...document,
      fetchStatus: response.ok ? 'fetched' : 'http_error',
      httpStatus: response.status,
      fetchedAt: new Date().toISOString(),
      textExcerpt: text.replace(/\s+/g, ' ').slice(0, 500000),
    };
  } catch (error) {
    return {
      ...document,
      fetchStatus: 'fetch_failed',
      fetchError: error.message,
      fetchedAt: new Date().toISOString(),
      textExcerpt: document.scope || '',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRulesetSources(sourceDocuments) {
  const fetched = [];
  for (const document of sourceDocuments) {
    fetched.push(await fetchSourceDocument(document));
  }
  return fetched;
}

function mergeCandidateWithCanonical(candidateRuleset, canonicalRuleset, extractionResult, sourceSnapshots) {
  const candidate = candidateRuleset && typeof candidateRuleset === 'object' ? candidateRuleset : {};

  return {
    ...canonicalRuleset,
    ...candidate,
    taxYear: candidate.taxYear || canonicalRuleset.taxYear,
    rulesVersion: candidate.rulesVersion || canonicalRuleset.rulesVersion,
    approvalStatus: 'candidate',
    sourceDocuments: canonicalRuleset.sourceDocuments,
    sourceCitations: canonicalRuleset.sourceCitations,
    lastReviewedAt: new Date().toISOString().slice(0, 10),
    governance: {
      ...(canonicalRuleset.governance || {}),
      ...(candidate.governance || {}),
      ingestionStatus: 'candidate_generated',
      sourceDocumentCount: canonicalRuleset.sourceDocuments.length,
    },
    aiRuleExtraction: {
      provider: extractionResult?.provider || 'canonical_fallback',
      confidence: Number(extractionResult?.confidence || 0),
      warnings: Array.isArray(extractionResult?.warnings) ? extractionResult.warnings : [],
      blockers: Array.isArray(extractionResult?.blockers) ? extractionResult.blockers : [],
      ruleDiffs: Array.isArray(extractionResult?.ruleDiffs) ? extractionResult.ruleDiffs : [],
      sourceFetchSummary: sourceSnapshots.map((source) => ({
        id: source.id,
        title: source.title,
        fetchStatus: source.fetchStatus,
        httpStatus: source.httpStatus || null,
      })),
      generatedAt: new Date().toISOString(),
    },
  };
}

async function extractCandidateRulesetWithClaude({ taxYear, canonicalRuleset, sourceSnapshots }) {
  if (!anthropic) {
    return {
      provider: 'canonical_fallback_no_claude_key',
      candidateRuleset: canonicalRuleset,
      confidence: 0,
      warnings: ['Claude API key is not configured; using canonical static ruleset as candidate.'],
      blockers: [],
      ruleDiffs: [],
    };
  }

  const contract = buildClaudeRulesetExtractionContract(taxYear);
  const prompt = `Extract a candidate HouseYield tax ruleset from the supplied source snapshots.

Guardrails:
${contract.hardConstraints.map((item) => `- ${item}`).join('\n')}

Return exactly this JSON object shape:
${JSON.stringify(contract.requiredOutputShape, null, 2)}

Canonical current ruleset:
${JSON.stringify(canonicalRuleset, null, 2)}

Source snapshots:
${JSON.stringify(sourceSnapshots.map((source) => ({
  id: source.id,
  title: source.title,
  url: source.url,
  fetchStatus: source.fetchStatus,
  textExcerpt: String(source.textExcerpt || '').slice(0, 8000),
})), null, 2)}`;

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_TAX_RULE_MODEL,
      max_tokens: 5000,
      temperature: 0,
      system: 'You extract candidate yearly tax rules into structured JSON. You do not calculate taxpayer amounts or fill forms.',
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = extractJsonObject(extractTextFromClaudeResponse(response));

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Claude returned an invalid ruleset extraction payload');
    }

    return {
      provider: 'claude',
      ...parsed,
    };
  } catch (error) {
    return {
      provider: 'canonical_fallback_after_claude_error',
      candidateRuleset: canonicalRuleset,
      confidence: 0,
      warnings: [`Claude extraction failed: ${error.message}`],
      blockers: [],
      ruleDiffs: [],
    };
  }
}

export async function runTaxFixtureGate() {
  try {
    const exportResult = await execFileAsync(process.execPath, ['server/test-tax-export-fixture.js', 'prestwick-rental-2025'], {
      cwd: process.cwd(),
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    const correctnessResult = await execFileAsync(process.execPath, ['server/test-tax-engine-correctness-fixture.js'], {
      cwd: process.cwd(),
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });

    return {
      status: 'passed',
      ranAt: new Date().toISOString(),
      commands: [
        'node server/test-tax-export-fixture.js prestwick-rental-2025',
        'node server/test-tax-engine-correctness-fixture.js',
      ],
      output: `${exportResult.stdout || ''}${correctnessResult.stdout || ''}`.slice(-4000),
    };
  } catch (error) {
    return {
      status: 'failed',
      ranAt: new Date().toISOString(),
      error: error.message,
      output: `${error.stdout || ''}${error.stderr || ''}`.slice(-4000),
    };
  }
}

export async function ingestYearlyTaxRuleset({
  taxYear,
  activateIfValid = false,
  runFixtureGateBeforeActivation = true,
  actor = 'system-tax-rules-ingestion',
} = {}) {
  const canonicalRuleset = getTaxRulesetPackage(taxYear);
  const sourceSnapshots = await fetchRulesetSources(canonicalRuleset.sourceDocuments || []);
  const extraction = await extractCandidateRulesetWithClaude({
    taxYear: canonicalRuleset.taxYear,
    canonicalRuleset,
    sourceSnapshots,
  });
  const mergedCandidateRuleset = mergeCandidateWithCanonical(
    extraction.candidateRuleset,
    canonicalRuleset,
    extraction,
    sourceSnapshots,
  );
  const sourceRuleAudits = buildSystemicSourceRuleAudits({
    taxYear: canonicalRuleset.taxYear,
    candidateRuleset: mergedCandidateRuleset,
    sourceSnapshots,
  });
  const candidateRuleset = applySourceAuditOverrides(mergedCandidateRuleset, sourceRuleAudits);
  const fixtureGate = runFixtureGateBeforeActivation ? await runTaxFixtureGate() : {
    status: 'not_run',
    requiredBeforeActivation: true,
  };
  const sourceAuditBlockers = sourceRuleAudits.flatMap((audit) => audit.activationBlockers || audit.blockers || []);
  const sourceAuditsPassed = sourceRuleAudits.length > 0 && sourceAuditBlockers.length === 0;
  const sourceAuditHasVerifiedCorrection = sourceRuleAudits.some((audit) => audit.status === 'corrected');
  const extractionConfidence = Number(extraction.confidence || 0);
  const extractionProvider = String(extraction.provider || '');
  const extractionFallback = extractionProvider.includes('fallback');
  const extractionGate = sourceAuditsPassed
    ? {
        status: 'passed',
        provider: 'deterministic_source_audit',
        reason: sourceAuditHasVerifiedCorrection
          ? 'Authoritative source audit produced a verified ruleset correction.'
          : 'All required authoritative source audits passed.',
      }
    : extractionFallback || extractionConfidence < 0.75
    ? {
        status: 'blocked',
        reason: extractionFallback
          ? 'Claude extraction did not produce an independent candidate ruleset; canonical fallback cannot auto-activate a new tax year.'
          : `Claude extraction confidence ${extractionConfidence} is below the 0.75 activation threshold.`,
      }
    : {
        status: 'passed',
        confidence: extractionConfidence,
        provider: extractionProvider,
      };
  const validation = validateTaxRulesetCandidate({
    candidateRuleset,
    taxYear: canonicalRuleset.taxYear,
    fixtureGate,
    sourceRuleAudits,
  });
  if (extractionGate.status !== 'passed') {
    validation.blockers.push(extractionGate.reason);
    validation.status = 'blocked';
    validation.ok = false;
    validation.activationAllowed = false;
  }
  if (validation.blockers.length > 0) {
    validation.status = 'blocked';
    validation.ok = false;
    validation.activationAllowed = false;
  }
  const candidateStatus = validation.status === 'passed' ? 'candidate_validated' : 'validation_failed';
  const persistedCandidate = await upsertTaxRulesetToAzure({
    ruleset: {
      ...candidateRuleset,
      validation,
    },
    approvalStatus: candidateStatus,
    approvedBy: null,
  });

  let activation = null;
  if (activateIfValid && validation.activationAllowed) {
    activation = await upsertTaxRulesetToAzure({
      ruleset: {
        ...candidateRuleset,
        approvalStatus: 'approved',
        validation,
      },
      approvalStatus: 'approved',
      approvedBy: actor,
    });
  }

  return {
    ok: true,
    status: activation?.ok ? 'activated' : persistedCandidate.status,
    taxYear: canonicalRuleset.taxYear,
    rulesVersion: candidateRuleset.rulesVersion,
    sourceFetchSummary: candidateRuleset.aiRuleExtraction.sourceFetchSummary,
    sourceRuleAudits,
    extraction: {
      provider: extraction.provider,
      confidence: extractionConfidence,
      warningCount: Array.isArray(extraction.warnings) ? extraction.warnings.length : 0,
      blockerCount: Array.isArray(extraction.blockers) ? extraction.blockers.length : 0,
      ruleDiffCount: Array.isArray(extraction.ruleDiffs) ? extraction.ruleDiffs.length : 0,
    },
    extractionGate,
    fixtureGate,
    validation,
    persistedCandidate,
    activation,
    generatedAt: new Date().toISOString(),
  };
}
