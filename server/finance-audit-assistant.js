/**
 * Finance Audit Assistant — interactive "ask the audit" Q&A for the
 * bookkeeping and tax pages.
 *
 * Answers free-form questions about a user's tax/bookkeeping audit using
 * Gemini, grounded in three layers:
 *   1. The audit context snapshot the frontend already has (tax year,
 *      liability summary, Schedule E summary, ledger summary, etc.)
 *   2. The static tax rules package + its official IRS source citations
 *      (src/shared/taxRules.js)
 *   3. Gemini search grounding for up-to-date rule verification
 *      (same pattern as legal-compliance-research.js)
 *   4. The canonical Azure SQL ledger, via read-only owner-scoped tools the
 *      model can invoke through Gemini function calling
 *      (server/finance-audit-ledger-tools.js) — only when the request carries
 *      a valid Firebase auth token.
 *
 * Endpoints (mounted at /api/finance-audit in server/index.js):
 *   POST /api/finance-audit/ask
 *   GET  /api/finance-audit/rules-sources?year=2025
 */

import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { verifyIdToken } from './firebase-admin.js';
import {
  createFinanceAuditToolset,
  isLedgerToolingConfigured
} from './finance-audit-ledger-tools.js';
import {
  TAX_RULES_VERSION,
  CURRENT_TAX_RULESET_TAX_YEAR,
  CURRENT_TAX_RULESET_APPROVAL_STATUS,
  DEPRECIATION_RULES,
  SCHEDULE_E_LINE_MAP,
  getTaxRulesetPackage,
  getTaxRulesGovernanceStatus,
  getTax1099ThresholdForTaxYear,
  formatTax1099Threshold
} from '../src/shared/taxRules.js';

const router = express.Router();

// ============================================================================
// CONFIGURATION
// ============================================================================

const GEMINI_API_KEY = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY || '';
// gemini-2.0-flash (used elsewhere in the repo) was retired by Google; default
// to 2.5 flash and allow override without a code change.
const GEMINI_MODEL = process.env.FINANCE_AUDIT_GEMINI_MODEL || 'gemini-2.5-flash';

const DISCLAIMER =
  'AI-assisted guidance based on your audit data and IRS sources. This is not tax, legal, or accounting advice — consult a qualified tax professional before filing.';

let geminiGrounded = null;   // model with Google Search grounding
let geminiPlain = null;      // fallback model without grounding
try {
  if (GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiGrounded = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      tools: [{ google_search: {} }]
    });
    geminiPlain = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    console.log(`[FinanceAuditAssistant] ✅ Gemini initialized (${GEMINI_MODEL}, search grounding enabled)`);
  } else {
    console.warn('[FinanceAuditAssistant] ⚠️ GEMINI_API_KEY not set — /ask will return a configuration error');
  }
} catch (error) {
  console.warn('[FinanceAuditAssistant] ⚠️ Gemini initialization failed:', error.message);
}

// ============================================================================
// OFFICIAL IRS RULES SOURCE CATALOG
// ============================================================================
// Curated, link-resolvable expansion of the citations in
// src/shared/taxRules.js getTaxRulesetPackage().sourceCitations.
// `lastUpdated` reflects the most recent review of the link/rule mapping
// against the rules package (TAX_RULES_VERSION).

const RULES_PACKAGE_REVIEW_DATE = '2026-01-15';

function buildIrsSourceCatalog(taxYear) {
  const threshold1099 = formatTax1099Threshold(taxYear);
  const pkg = getTaxRulesetPackage(taxYear);
  const canonicalSources = Array.isArray(pkg.sourceDocuments) ? pkg.sourceDocuments : [];
  const mappedSources = canonicalSources.map((document) => ({
    id: document.id,
    title: document.title,
    url: document.url,
    authority: document.authority,
    appliesTo: document.scope,
    citation: document.publishedLabel,
    lastUpdated: document.lastReviewedAt || RULES_PACKAGE_REVIEW_DATE,
  }));

  if (pkg.approvalStatus === 'unsupported') {
    return mappedSources;
  }

  return [
    ...mappedSources,
    {
      id: '1099-nec',
      title: `Instructions for Forms 1099-MISC and 1099-NEC (${taxYear})`,
      url: taxYear >= 2025 ? 'https://www.irs.gov/instructions/i1099mec' : `https://www.irs.gov/pub/irs-prior/i1099mec--${taxYear}.pdf`,
      authority: 'IRS',
      appliesTo: `Contractor reporting threshold (${threshold1099} for tax year ${taxYear}); threshold rises to $2,000 effective tax year 2027 under current HouseYield rule metadata`,
      citation: '1099-NEC/1099-MISC reporting thresholds',
      lastUpdated: pkg.lastReviewedAt || RULES_PACKAGE_REVIEW_DATE
    }
  ];
}

// ============================================================================
// GOVERNANCE / STALENESS
// ============================================================================

function buildGovernance(requestedYear) {
  const governance = getTaxRulesGovernanceStatus(requestedYear);

  return {
    rulesVersion: governance.rulesVersion || TAX_RULES_VERSION,
    rulesetTaxYear: governance.supportedTaxYear,
    requestedTaxYear: requestedYear,
    approvalStatus: governance.approvalStatus || CURRENT_TAX_RULESET_APPROVAL_STATUS,
    lastReviewed: governance.lastReviewedAt || RULES_PACKAGE_REVIEW_DATE,
    stalenessStatus: governance.freshnessStatus,
    notes: governance.warnings || []
  };
}

// ============================================================================
// PROMPT BUILDING
// ============================================================================

function summarizeRulesPackage(taxYear) {
  const pkg = getTaxRulesetPackage(taxYear);
  const scheduleELines = Object.entries(SCHEDULE_E_LINE_MAP)
    .map(([line, def]) => `  Line ${line} (${def.name}, ${def.type}): categories ${def.categories.join(', ')}`)
    .join('\n');

  return `TAX RULES PACKAGE (version ${pkg.rulesVersion}, tax year ${pkg.taxYear}, approval status: ${pkg.approvalStatus})
Official source citations: ${pkg.sourceCitations.join('; ')}

Depreciation rules: ${DEPRECIATION_RULES.method}, ${DEPRECIATION_RULES.convention} convention, ${DEPRECIATION_RULES.residentialRentalUsefulLifeMonths} months (${DEPRECIATION_RULES.residentialRentalUsefulLifeMonths / 12} years) for residential rental, default land value ${DEPRECIATION_RULES.defaultLandValuePercent * 100}% of basis (land is not depreciable).

Standard deduction (${pkg.taxYear}): single $${Number(pkg.standardDeduction?.single || 0).toLocaleString()}, MFJ $${Number(pkg.standardDeduction?.married_filing_jointly || 0).toLocaleString()}, MFS $${Number(pkg.standardDeduction?.married_filing_separately || 0).toLocaleString()}, HoH $${Number(pkg.standardDeduction?.head_of_household || 0).toLocaleString()}.

1099-NEC threshold: $${getTax1099ThresholdForTaxYear(taxYear).toLocaleString()} for tax year ${pkg.taxYear} (rises to $2,000 effective tax year 2027 under OBBBA).

Schedule E line map used by the bookkeeping → tax pipeline:
${scheduleELines}`;
}

function summarizeSectionsForPrompt(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return '';
  const lines = sections
    .filter((s) => s && s.id && s.title)
    .slice(0, 40)
    .map((s) => `- [${s.id}] ${s.title}${s.description ? ` — ${s.description}` : ''}`)
    .join('\n');
  if (!lines) return '';
  return `\n=== PAGE SECTIONS THE USER CAN NAVIGATE TO ===\n${lines}\n`;
}

function buildLedgerToolsPromptSection(ledgerToolsEnabled) {
  if (!ledgerToolsEnabled) {
    return `\n=== CANONICAL LEDGER ACCESS ===\nNo live ledger connection is available for this request. Answer from the page snapshot and rules package only, and if the question needs entry-level verification, say you could not verify against the canonical ledger.\n`;
  }

  return `\n=== CANONICAL LEDGER ACCESS ===
You have READ-ONLY tools that query this user's canonical accounting ledger — the same source of truth the bookkeeping and tax systems compute from. The tools are already scoped to this user (and their current property filter); you cannot and must not try to query anyone else's data.
- When the question concerns specific transactions, amounts, balances, category totals, evidence documents, estimated tax payments, or close/reconciliation status, call the relevant tool to verify against the canonical ledger rather than relying only on the page snapshot.
- Prefer canonical tool results over page-snapshot numbers if they disagree, and mention the discrepancy.
- You have a budget of at most 4 tool calls — be selective.
- If a tool fails or returns no data, answer from the page snapshot and say you could not verify against the ledger.
`;
}

function buildSystemPrompt({ surface, question, context, taxYear, sections, ledgerToolsEnabled = false }) {
  const catalog = buildIrsSourceCatalog(taxYear);
  const catalogText = catalog
    .map((s) => `- [${s.id}] ${s.title} — ${s.url}\n  Applies to: ${s.appliesTo}`)
    .join('\n');

  const contextText = context && Object.keys(context).length > 0
    ? JSON.stringify(context, null, 2)
    : '(no audit snapshot provided)';

  const sectionsText = summarizeSectionsForPrompt(sections);
  const sectionsRequirement = sectionsText
    ? `\n  "relatedSectionIds": ["ids from PAGE SECTIONS that the user should look at for this answer, max 3, omit or empty array if none apply"],`
    : '';

  return `You are a concise tax and bookkeeping audit assistant for a residential rental property platform. The user is viewing their ${surface === 'tax' ? 'tax audit' : 'bookkeeping audit'} page and asked a question about their numbers or the rules behind them.

GROUND YOUR ANSWER IN, IN PRIORITY ORDER:
1. The user's audit context snapshot below (their actual numbers — never invent figures not present in it).
2. The platform's tax rules package below (the exact rules this audit abides by).
3. If the question requires verifying whether a rule is current (e.g. "is this up to date for ${taxYear}?"), use Google Search to verify against irs.gov and cite what you find.

=== USER AUDIT CONTEXT (surface: ${surface}, tax year: ${taxYear}) ===
${contextText}

=== ${summarizeRulesPackage(taxYear)} ===

=== OFFICIAL IRS SOURCES FOR THIS RULES PACKAGE ===
${catalogText}
${buildLedgerToolsPromptSection(ledgerToolsEnabled)}${sectionsText}
USER QUESTION: ${question}

RESPONSE REQUIREMENTS:
- Respond with ONLY a JSON object (no markdown fences) with this exact shape:
{
  "answer": "2-3 sentence direct answer to the question, referencing the user's actual numbers when relevant",
  "bullets": ["optional short supporting points, max 5, omit or empty array if not needed"],
  "sourceIds": ["ids from the OFFICIAL IRS SOURCES list above that support the answer"],${sectionsRequirement}
  "confidence": "high" | "medium" | "low"
}
- Be concise and specific. Use the user's actual figures from the context when explaining amounts.
- Use plain English: when you must use jargon (tie-out, safe harbor, trial balance, §280A, QBI), add a few words explaining what it means.
- If the context lacks data needed to answer precisely, say so in the answer and set confidence to "low".
- Never give definitive legal/tax advice; describe what the rules say and how the audit applied them.`;
}

/**
 * Prompt for the lightweight page-summary mode used by the AI assistant
 * header. Returns a single friendly status sentence (no sources/citations).
 */
function buildSummaryPrompt({ surface, context, taxYear }) {
  const contextText = context && Object.keys(context).length > 0
    ? JSON.stringify(context, null, 2)
    : '(no audit snapshot provided)';

  return `You are summarizing the current state of a residential rental property owner's ${surface === 'tax' ? 'tax center' : 'bookkeeping'} page in ONE friendly plain-English sentence (max ~30 words).

Their page data snapshot (tax year ${taxYear}):
${contextText}

Rules:
- Lead with the most decision-relevant numbers (net cash flow, net due, exceptions, blockers, readiness).
- Plain English, no jargon, no advice, no disclaimers.
- Respond with ONLY a JSON object (no markdown fences): { "summary": "one sentence" }`;
}

// ============================================================================
// GEMINI CALL + RESPONSE PARSING
// ============================================================================

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function askGemini(prompt) {
  const generationConfig = { temperature: 0.1, maxOutputTokens: 2048 };
  const request = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig
  };

  // Prefer the search-grounded model; fall back to plain if grounding errors.
  let response;
  try {
    const result = await geminiGrounded.generateContent(request);
    response = await result.response;
  } catch (groundedError) {
    console.warn('[FinanceAuditAssistant] Grounded call failed, retrying without search:', groundedError.message);
    const result = await geminiPlain.generateContent(request);
    response = await result.response;
  }

  const text = response.text();
  const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
  const webSources = (groundingMetadata?.groundingChunks || [])
    .map((chunk) => ({
      title: chunk.web?.title || '',
      url: chunk.web?.uri || '',
      authority: 'Web (Google Search grounding)'
    }))
    .filter((s) => s.url);

  return { text, webSources };
}

/**
 * Resolve the authenticated Firebase uid from the request's Bearer token, or
 * null when absent/invalid. Auth is optional for /ask (the assistant still
 * answers from page context without it), but the canonical ledger tools are
 * only enabled for a verified user — and are always scoped to that uid.
 */
async function resolveAuthenticatedUserId(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const decoded = await verifyIdToken(authHeader.slice('Bearer '.length));
    return decoded?.uid || null;
  } catch {
    return null;
  }
}

const MAX_LEDGER_TOOL_CALLS = 4;

/**
 * Gemini function-calling loop against the owner-scoped ledger toolset.
 * Bounded at MAX_LEDGER_TOOL_CALLS tool executions; after the budget is
 * spent the model is forced to produce its final answer.
 */
export async function askGeminiWithLedgerTools({ prompt, toolset }) {
  const generationConfig = { temperature: 0.1, maxOutputTokens: 2048 };
  const tools = [{ functionDeclarations: toolset.declarations }];
  const contents = [{ role: 'user', parts: [{ text: prompt }] }];

  const dataUsed = [];
  let toolCallsUsed = 0;
  let toolFailures = 0;
  let ledgerUnavailable = false;

  // +2 turns beyond the budget: one for the post-budget forced answer, one
  // of slack for an empty/odd model turn.
  for (let turn = 0; turn < MAX_LEDGER_TOOL_CALLS + 2; turn += 1) {
    const budgetExhausted = toolCallsUsed >= MAX_LEDGER_TOOL_CALLS;
    const result = await geminiPlain.generateContent({
      contents,
      generationConfig,
      tools,
      toolConfig: { functionCallingConfig: { mode: budgetExhausted ? 'NONE' : 'AUTO' } }
    });
    const response = await result.response;
    const calls = typeof response.functionCalls === 'function' ? (response.functionCalls() || []) : [];

    if (calls.length === 0 || budgetExhausted) {
      return { text: response.text(), dataUsed, toolCallsUsed, toolFailures, ledgerUnavailable };
    }

    contents.push(response.candidates[0].content);

    const responseParts = [];
    for (const call of calls) {
      if (toolCallsUsed >= MAX_LEDGER_TOOL_CALLS) {
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { error: 'Tool call budget exhausted — answer with the data you already have.' }
          }
        });
        continue;
      }

      toolCallsUsed += 1;
      try {
        const { result: toolResult, summary } = await toolset.execute(call.name, call.args || {});
        dataUsed.push(summary);
        responseParts.push({ functionResponse: { name: call.name, response: { result: toolResult } } });
      } catch (error) {
        toolFailures += 1;
        if (error?.code === 'ledger_not_configured' || error?.code === 'ESOCKET' || error?.code === 'ETIMEOUT') {
          ledgerUnavailable = true;
        }
        console.warn(`[FinanceAuditAssistant] Ledger tool ${call.name} failed:`, error.message);
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { error: `Tool failed: ${error.message}. Answer from the page snapshot and note the ledger could not be verified.` }
          }
        });
      }
    }

    contents.push({ role: 'function', parts: responseParts });
  }

  throw new Error('Ledger tool loop did not converge to a final answer.');
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * POST /api/finance-audit/ask
 * Body: {
 *   surface: 'tax'|'bookkeeping',
 *   question: string,            // ignored when mode === 'summary'
 *   context?: object,
 *   mode?: 'qa'|'summary',       // 'summary' returns a one-line page summary
 *   sections?: [{ id, title, description }]  // navigable page sections; the
 *                                            // answer may reference them via
 *                                            // actions: [{ type:'scrollTo', sectionId }]
 * }
 */
router.post('/ask', async (req, res) => {
  try {
    const { surface, question, context = {}, mode = 'qa', sections = [] } = req.body || {};

    if (surface !== 'tax' && surface !== 'bookkeeping') {
      return res.status(400).json({
        ok: false,
        error: "Invalid 'surface' — must be 'tax' or 'bookkeeping'."
      });
    }

    if (!geminiGrounded || !geminiPlain) {
      return res.status(503).json({
        ok: false,
        error: 'AI assistant is not configured on this server (GEMINI_API_KEY is missing). Set Gemini_API_Key or GEMINI_API_KEY and restart.',
        code: 'gemini_not_configured'
      });
    }

    // ---- Lightweight one-line page summary mode (AI assistant header) ----
    if (mode === 'summary') {
      const taxYear = Number(context?.taxYear) || CURRENT_TAX_RULESET_TAX_YEAR;
      const prompt = buildSummaryPrompt({ surface, context, taxYear });
      const { text } = await askGemini(prompt);
      const parsed = extractJson(text);
      const summary = (parsed?.summary || (text ? text.trim().slice(0, 240) : '')).trim();
      if (!summary) {
        return res.status(502).json({ ok: false, error: 'Empty AI summary response.', code: 'empty_ai_response' });
      }
      return res.json({ ok: true, summary, surface, taxYear });
    }

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Missing 'question' — provide a non-empty string."
      });
    }
    if (question.length > 2000) {
      return res.status(400).json({
        ok: false,
        error: 'Question is too long (max 2000 characters).'
      });
    }

    const taxYear = Number(context?.taxYear) || CURRENT_TAX_RULESET_TAX_YEAR;
    const safeSections = Array.isArray(sections)
      ? sections.filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string')
      : [];

    // Canonical ledger tools: only for a verified user, always bound to that
    // user's uid (never to anything the request body claims) plus the page's
    // property scope.
    const authUserId = await resolveAuthenticatedUserId(req);
    const propertyId = typeof context?.propertyId === 'string' && context.propertyId.trim()
      ? context.propertyId.trim()
      : null;
    let toolset = null;
    if (authUserId && isLedgerToolingConfigured()) {
      try {
        toolset = createFinanceAuditToolset({ userId: authUserId, propertyId });
      } catch (toolsetError) {
        console.warn('[FinanceAuditAssistant] Could not build ledger toolset:', toolsetError.message);
      }
    }

    const prompt = buildSystemPrompt({
      surface,
      question: question.trim(),
      context,
      taxYear,
      sections: safeSections,
      ledgerToolsEnabled: Boolean(toolset)
    });

    let text = '';
    let webSources = [];
    let dataUsed = [];
    // 'checked' | 'not_needed' | 'unavailable' | 'not_connected'
    let ledgerStatus = 'not_connected';

    if (toolset) {
      try {
        const toolRun = await askGeminiWithLedgerTools({ prompt, toolset });
        text = toolRun.text;
        dataUsed = toolRun.dataUsed;
        if (toolRun.dataUsed.length > 0) {
          ledgerStatus = 'checked';
        } else if (toolRun.ledgerUnavailable || toolRun.toolFailures > 0) {
          ledgerStatus = 'unavailable';
        } else {
          ledgerStatus = 'not_needed';
        }
      } catch (toolLoopError) {
        // Graceful degradation: fall back to the search-grounded, no-tools path.
        console.warn('[FinanceAuditAssistant] Ledger tool loop failed, falling back:', toolLoopError.message);
        ledgerStatus = 'unavailable';
      }
    }

    if (!text) {
      const fallback = await askGemini(prompt);
      text = fallback.text;
      webSources = fallback.webSources;
    }

    if (ledgerStatus === 'unavailable' && dataUsed.length === 0) {
      dataUsed = ['Could not reach the canonical ledger — answered from page context only'];
    }

    const parsed = extractJson(text);

    const catalog = buildIrsSourceCatalog(taxYear);
    const catalogById = new Map(catalog.map((s) => [s.id, s]));

    // Resolve cited catalog sources; fall back to the full catalog core set
    // if the model didn't cite any.
    const citedIds = Array.isArray(parsed?.sourceIds) ? parsed.sourceIds : [];
    const citedSources = citedIds
      .map((id) => catalogById.get(id))
      .filter(Boolean)
      .map(({ id, citation, ...rest }) => rest);

    // Curated IRS citations first, then at most a few grounded web hits so the
    // source rail stays concise.
    const sources = [
      ...citedSources,
      ...webSources.filter((w) => !citedSources.some((c) => c.url === w.url)).slice(0, 4)
    ];

    const answer = parsed?.answer || (text ? text.trim().slice(0, 1500) : '');
    if (!answer) {
      return res.status(502).json({
        ok: false,
        error: 'The AI assistant returned an empty response. Please try again.',
        code: 'empty_ai_response'
      });
    }

    // Map cited section ids to client navigation actions, restricted to the
    // sections the page actually registered.
    const knownSectionIds = new Set(safeSections.map((s) => s.id));
    const relatedSectionIds = Array.isArray(parsed?.relatedSectionIds)
      ? parsed.relatedSectionIds.filter((id) => typeof id === 'string' && knownSectionIds.has(id)).slice(0, 3)
      : [];
    const actions = relatedSectionIds.map((sectionId) => ({ type: 'scrollTo', sectionId }));

    return res.json({
      ok: true,
      answer,
      bullets: Array.isArray(parsed?.bullets) ? parsed.bullets.slice(0, 5) : [],
      sources,
      actions,
      rulesVersion: TAX_RULES_VERSION,
      taxYear,
      surface,
      confidence: ['high', 'medium', 'low'].includes(parsed?.confidence) ? parsed.confidence : 'medium',
      disclaimer: DISCLAIMER,
      governance: buildGovernance(taxYear),
      // Which canonical ledger queries grounded this answer (empty when the
      // model answered from page context alone).
      dataUsed,
      ledgerStatus
    });
  } catch (error) {
    console.error('[FinanceAuditAssistant] /ask error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to answer the question. Please try again.',
      detail: error.message
    });
  }
});

/**
 * GET /api/finance-audit/rules-sources?year=2025
 * Structured IRS rules source list with governance/staleness status,
 * for the audit rail's "rules this audit abides by" section.
 */
router.get('/rules-sources', (req, res) => {
  try {
    const requestedYear = Number(req.query.year) || CURRENT_TAX_RULESET_TAX_YEAR;
    const pkg = getTaxRulesetPackage(requestedYear);
    const governance = buildGovernance(requestedYear);
    const catalog = buildIrsSourceCatalog(requestedYear);

    return res.json({
      ok: true,
      taxYear: requestedYear,
      rulesVersion: pkg.rulesVersion,
      approvalStatus: pkg.approvalStatus,
      governance,
      sourceCitations: pkg.sourceCitations,
      sources: catalog.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        authority: s.authority,
        appliesTo: s.appliesTo,
        citation: s.citation,
        lastUpdated: s.lastUpdated
      })),
      disclaimer: DISCLAIMER
    });
  } catch (error) {
    console.error('[FinanceAuditAssistant] /rules-sources error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
