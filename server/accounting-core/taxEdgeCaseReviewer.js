import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_API_KEY = process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_TAX_REVIEW_MODEL = process.env.CLAUDE_TAX_REVIEW_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
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

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function normalizeReviewPayload(payload, fallbackProvider = 'heuristic') {
  const blockers = normalizeStringList(payload?.blockers);
  const warnings = normalizeStringList(payload?.warnings);
  const missingInfoQuestions = normalizeStringList(payload?.missingInfoQuestions);

  return {
    ok: true,
    provider: payload?.provider || fallbackProvider,
    status: blockers.length > 0 ? 'blocked' : warnings.length > 0 || missingInfoQuestions.length > 0 ? 'attention_needed' : 'clear',
    summary: payload?.summary || (
      blockers.length > 0
        ? 'Tax edge-case review found blockers that should be resolved before packet readiness.'
        : warnings.length > 0
          ? 'Tax edge-case review found warnings to inspect before filing.'
          : 'Tax edge-case review did not find additional blockers in the supplied context.'
    ),
    blockers,
    warnings,
    missingInfoQuestions,
    citations: normalizeStringList(payload?.citations),
    reviewedAt: new Date().toISOString(),
    guardrails: buildClaudeTaxEdgeCaseReviewContract().hardConstraints,
  };
}

function buildHeuristicEdgeCaseReview(context = {}) {
  const blockers = [];
  const warnings = [];
  const missingInfoQuestions = [];
  const citations = [];
  const taxLiability = context.taxLiability || {};
  const rulesMetadata = context.rulesMetadata || {};
  const draftFormProfile = context.draftFormProfile || {};
  const checklist = context.checklist || {};

  normalizeStringList(taxLiability.modelingReadiness?.blockers).forEach((blocker) => blockers.push(blocker));
  normalizeStringList(taxLiability.modelingReadiness?.warnings).forEach((warning) => warnings.push(warning));
  normalizeStringList(rulesMetadata.validation?.warnings).forEach((warning) => warnings.push(warning));
  normalizeStringList(rulesMetadata.activationValidation?.blockers).forEach((blocker) => blockers.push(blocker));

  if (!draftFormProfile.priorYearTotalTax) {
    missingInfoQuestions.push('What was the taxpayer prior-year total tax? This is needed to confirm prior-year estimated-tax safe harbor.');
  }

  if (!draftFormProfile.primaryName || !draftFormProfile.tinLast4) {
    missingInfoQuestions.push('Confirm taxpayer legal name and TIN last four before preparing filing PDFs.');
  }

  if (Array.isArray(checklist.documents)) {
    const requiredMissing = checklist.documents
      .filter((document) => document.required && (document.status === 'missing' || document.blocking))
      .map((document) => document.name || document.id)
      .filter(Boolean);
    if (requiredMissing.length > 0) {
      blockers.push(`Required tax evidence is missing: ${requiredMissing.slice(0, 3).join(', ')}.`);
    }
  }

  if (rulesMetadata.rulesRuntime?.rulesVersion) {
    citations.push(`Rules version ${rulesMetadata.rulesRuntime.rulesVersion}`);
  }

  if (rulesMetadata.rulesRuntime?.source) {
    citations.push(`Rules runtime source ${rulesMetadata.rulesRuntime.source}`);
  }

  return normalizeReviewPayload({
    provider: 'heuristic',
    summary: 'Deterministic edge-case precheck completed. Claude review will use the same guarded output shape when configured.',
    blockers,
    warnings,
    missingInfoQuestions,
    citations,
  });
}

export function buildClaudeTaxEdgeCaseReviewContract() {
  return {
    modelRole: 'post_computation_tax_edge_case_reviewer',
    hardConstraints: [
      'Do not calculate or recalculate tax amounts.',
      'Do not alter Schedule E, 1099, 1040-ES, or PDF fields.',
      'Do not change categories, line mappings, source documents, or ruleset versions.',
      'Return only blockers, warnings, missing-info questions, citations, and explanation text.',
      'Every issue must reference supplied workpaper, rules, evidence, or taxpayer-context facts.',
      'When uncertain, ask a missing-info question instead of inventing a tax treatment.',
    ],
    requiredOutputShape: {
      summary: 'string',
      blockers: 'string[]',
      warnings: 'string[]',
      missingInfoQuestions: 'string[]',
      citations: 'string[]',
    },
  };
}

export async function reviewTaxEdgeCases({
  context = {},
  preferClaude = true,
} = {}) {
  const heuristicReview = buildHeuristicEdgeCaseReview(context);

  if (!preferClaude || !anthropic) {
    return {
      ...heuristicReview,
      provider: anthropic ? heuristicReview.provider : 'heuristic_no_claude_key',
      claudeAvailable: Boolean(anthropic),
    };
  }

  const contract = buildClaudeTaxEdgeCaseReviewContract();
  const prompt = `Review this tax workpaper context for edge cases and readiness issues.

Guardrails:
${contract.hardConstraints.map((item) => `- ${item}`).join('\n')}

Return exactly this JSON object shape:
${JSON.stringify(contract.requiredOutputShape, null, 2)}

Context:
${JSON.stringify(context, null, 2)}`;

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_TAX_REVIEW_MODEL,
      max_tokens: 2200,
      temperature: 0,
      system: 'You are a tax edge-case reviewer for HouseYield. You identify blockers and missing facts after deterministic tax computation. You never change tax calculations or form fields.',
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = extractJsonObject(extractTextFromClaudeResponse(response));

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Claude returned an invalid tax edge-case review payload');
    }

    return {
      ...normalizeReviewPayload(parsed, 'claude'),
      provider: 'claude',
      claudeAvailable: true,
      heuristicPrecheck: heuristicReview,
    };
  } catch (error) {
    return {
      ...heuristicReview,
      provider: 'heuristic_after_claude_error',
      claudeAvailable: true,
      claudeError: error.message,
    };
  }
}
