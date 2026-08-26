import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY || '';
const SEARCH_PROVIDER = 'gemini_local';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

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

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9$./:-]+/g, ' ')
    .trim();
}

function tokenizeSearchQuery(value) {
  return Array.from(new Set(
    normalizeSearchText(value)
      .split(/\s+/)
      .filter((token) => token.length > 1)
  ));
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) {
    return 0;
  }

  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}

function buildEvidenceSummaryText(summary) {
  if (!summary) {
    return '';
  }

  if (typeof summary === 'string') {
    return summary;
  }

  try {
    return JSON.stringify(summary);
  } catch {
    return String(summary);
  }
}

function buildEvidenceSearchContent({
  title,
  vendorName,
  sourceRef,
  evidenceType,
  summary,
  extractedText
}) {
  return [title, vendorName, sourceRef, evidenceType, buildEvidenceSummaryText(summary), extractedText]
    .filter(Boolean)
    .join('\n')
    .slice(0, 32000);
}

function extractDocumentYear(documentDate, createdAt) {
  const candidate = documentDate || createdAt;
  if (!candidate) {
    return null;
  }

  const parsedDate = new Date(candidate);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate.getUTCFullYear();
}

function buildEntityKeys(links = []) {
  return (links || [])
    .filter((link) => link?.entityType && link?.entityId)
    .map((link) => `${link.entityType}:${link.entityId}`);
}

function parseGeminiJson(text) {
  const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Gemini overview response');
  }

  return JSON.parse(jsonMatch[0]);
}

function pickFirstString(values = []) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) || null;
}

function buildOverviewItem(item = {}, index = 0) {
  const parsedSummary = typeof item.summary === 'string' ? safeParseJson(item.summary) : null;
  const summary = parsedSummary || item.summary || {};
  const excerpt = pickFirstString([
    typeof summary?.summary === 'string' ? summary.summary : null,
    typeof summary?.description === 'string' ? summary.description : null,
    typeof summary?.notes === 'string' ? summary.notes : null,
    item.notes,
    item.contentPreview,
    item.extractedText,
    item.originalFileName
  ]);

  return {
    slot: `R${index + 1}`,
    id: item.evidenceId || item.id || item.sourceRef || `result-${index + 1}`,
    title: pickFirstString([
      item.title,
      item.vendorName,
      item.documentType,
      item.evidenceType,
      item.sourceRef
    ]) || `Result ${index + 1}`,
    vendorName: item.vendorName || null,
    amount: item.amount === null || item.amount === undefined || Number.isNaN(Number(item.amount))
      ? null
      : Number(item.amount),
    documentDate: item.documentDate || item.createdAt || null,
    kind: item.evidenceType || item.documentType || item.sourceSystem || null,
    excerpt: excerpt ? String(excerpt).slice(0, 260) : null,
  };
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(Number(value));
}

function buildScopeLabel(scope = {}) {
  return [
    scope.propertyId ? `property ${scope.propertyId}` : null,
    scope.year ? `year ${scope.year}` : null,
    scope.sourceSystem ? String(scope.sourceSystem).replace(/_/g, ' ') : null,
    scope.documentType ? String(scope.documentType).replace(/_/g, ' ') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function buildLocalOverview({ query, items = [], resultLabel = 'results', scopeLabel = null }) {
  if (!items.length) {
    return {
      ok: true,
      status: 'no_results',
      provider: 'local',
      summary: `No ${resultLabel} matched "${query}" in the current scope.`,
      bullets: [
        scopeLabel ? `Scope: ${scopeLabel}.` : 'The search stayed inside the current finance scope.',
        'Try a shorter vendor name, source reference, OCR phrase, or a more specific amount/date cue.'
      ],
      confidence: 'low'
    };
  }

  const topKinds = new Map();
  const topVendors = new Map();
  let amountTotal = 0;
  let amountCount = 0;

  items.forEach((item) => {
    if (item.kind) {
      topKinds.set(item.kind, (topKinds.get(item.kind) || 0) + 1);
    }
    if (item.vendorName) {
      topVendors.set(item.vendorName, (topVendors.get(item.vendorName) || 0) + 1);
    }
    if (item.amount !== null && item.amount !== undefined && !Number.isNaN(Number(item.amount))) {
      amountTotal += Number(item.amount);
      amountCount += 1;
    }
  });

  const leadingKinds = Array.from(topKinds.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([kind]) => kind.replace(/_/g, ' '));
  const leadingVendors = Array.from(topVendors.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([vendor]) => vendor);

  const bullets = [];
  if (scopeLabel) {
    bullets.push(`Scope: ${scopeLabel}.`);
  }
  if (leadingKinds.length > 0) {
    bullets.push(`Most matches are ${leadingKinds.join(' and ')} records.`);
  }
  if (leadingVendors.length > 0) {
    bullets.push(`Frequent counterparties: ${leadingVendors.join(', ')}.`);
  }
  if (amountCount > 0) {
    bullets.push(`${amountCount} matched records carry explicit amounts totaling ${formatMoney(amountTotal)}.`);
  }

  return {
    ok: true,
    status: 'summarized',
    provider: 'local',
    summary: `${items.length} ${resultLabel} matched "${query}"${leadingKinds.length > 0 ? `, led by ${leadingKinds.join(' and ')}` : ''}.`,
    bullets,
    confidence: items.length >= 3 ? 'medium' : 'low'
  };
}

function scoreSearchText(query, text) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedText = normalizeSearchText(text);
  if (!normalizedQuery || !normalizedText) {
    return 0;
  }

  let score = 0;
  if (normalizedText.includes(normalizedQuery)) {
    score += 80;
  }

  const tokens = tokenizeSearchQuery(normalizedQuery);
  for (const token of tokens) {
    const occurrences = countOccurrences(normalizedText, token);
    if (!occurrences) {
      continue;
    }

    score += 12 + Math.min(occurrences, 5) * 8;
    if (normalizedText.startsWith(token)) {
      score += 10;
    }
  }

  return score;
}

export function rankFinanceSearchCandidates({
  query,
  candidates = [],
  buildSearchText,
  limit = 25,
  compareCandidates = null,
  minimumScore = 1,
}) {
  const trimmedQuery = String(query || '').trim();
  const normalizedLimit = Math.max(parseInt(limit, 10) || 25, 1);

  if (!trimmedQuery) {
    return {
      usedQuery: null,
      totalCount: candidates.length,
      items: candidates.slice(0, normalizedLimit).map((candidate) => ({ candidate, score: 0 }))
    };
  }

  const ranked = (candidates || [])
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreSearchText(trimmedQuery, buildSearchText(candidate))
    }))
    .filter((item) => item.score >= minimumScore)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (typeof compareCandidates === 'function') {
        return compareCandidates(left.candidate, right.candidate);
      }

      return left.index - right.index;
    });

  return {
    usedQuery: trimmedQuery,
    totalCount: ranked.length,
    items: ranked.slice(0, normalizedLimit)
  };
}

export async function generateFinanceSearchOverview({
  query,
  results = [],
  resultLabel = 'results',
  scope = {}
} = {}) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) {
    return null;
  }

  const overviewItems = (results || []).slice(0, 8).map((item, index) => buildOverviewItem(item, index));
  const scopeLabel = buildScopeLabel(scope);

  if (!genAI) {
    return buildLocalOverview({
      query: trimmedQuery,
      items: overviewItems,
      resultLabel,
      scopeLabel,
    });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.15,
        topP: 0.8,
        maxOutputTokens: 1024
      }
    });

    const prompt = `You are HouseYield Finance Copilot. Summarize the current search results using ONLY the provided result slots and scope.

Rules:
- Do not invent facts beyond the result slots.
- Keep the summary concise and operational.
- If there are no results, say so plainly.
- Return JSON only with this schema:
{
  "summary": "one short paragraph",
  "bullets": ["supporting point", "supporting point"],
  "confidence": "high|medium|low"
}

Search query:
${trimmedQuery}

Result label:
${resultLabel}

Scope:
${JSON.stringify(scope, null, 2)}

Result slots:
${JSON.stringify(overviewItems, null, 2)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const parsed = parseGeminiJson(response.text());

    return {
      ok: true,
      status: overviewItems.length > 0 ? 'summarized' : 'no_results',
      provider: 'gemini',
      summary: typeof parsed.summary === 'string'
        ? parsed.summary.trim()
        : buildLocalOverview({ query: trimmedQuery, items: overviewItems, resultLabel, scopeLabel }).summary,
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.filter((item) => typeof item === 'string' && item.trim())
        : [],
      confidence: ['high', 'medium', 'low'].includes(String(parsed.confidence || '').toLowerCase())
        ? String(parsed.confidence).toLowerCase()
        : overviewItems.length >= 3 ? 'medium' : 'low'
    };
  } catch (error) {
    const fallback = buildLocalOverview({
      query: trimmedQuery,
      items: overviewItems,
      resultLabel,
      scopeLabel,
    });

    return {
      ...fallback,
      status: fallback.status === 'no_results' ? 'no_results' : 'fallback',
      error: error.message
    };
  }
}

export function isFinanceEvidenceSearchConfigured() {
  return true;
}

export async function ensureFinanceEvidenceSearchIndex() {
  return {
    ok: true,
    status: 'ready',
    provider: SEARCH_PROVIDER,
    indexName: null
  };
}

export function buildFinanceEvidenceSearchDocument(record = {}) {
  const createdAt = record.createdAt || new Date().toISOString();
  const updatedAt = record.updatedAt || createdAt;
  const summaryText = buildEvidenceSummaryText(record.summary).slice(0, 32000);

  return {
    documentId: String(record.evidenceId || `${record.sourceSystem || 'evidence'}:${record.sourceRef || createdAt}`),
    evidenceId: String(record.evidenceId || ''),
    userId: String(record.userId || ''),
    propertyId: record.propertyId || '',
    sourceSystem: record.sourceSystem || '',
    sourceRef: record.sourceRef || '',
    evidenceType: record.evidenceType || '',
    title: record.title || '',
    vendorName: record.vendorName || '',
    summaryText,
    extractedText: String(record.extractedText || '').slice(0, 32000),
    content: buildEvidenceSearchContent(record),
    documentYear: extractDocumentYear(record.documentDate, createdAt),
    documentDate: record.documentDate || '',
    createdAt,
    updatedAt,
    amount: Number.isFinite(Number(record.amount)) ? Number(record.amount) : null,
    currencyCode: record.currencyCode || 'USD',
    digitizationStatus: record.digitizationStatus || '',
    entityKeys: buildEntityKeys(record.links)
  };
}

export async function upsertFinanceEvidenceSearchDocument(document) {
  if (!document?.documentId || !document?.userId) {
    throw new Error('documentId and userId are required to stage finance evidence for local search');
  }

  return {
    ok: true,
    status: 'local_only',
    provider: SEARCH_PROVIDER,
    indexName: null,
    documentId: document.documentId
  };
}

export async function searchFinanceEvidenceIndex({
  q = null,
  limit = 25,
  candidates = [],
  buildSearchText = (candidate) => buildEvidenceSearchContent(candidate)
} = {}) {
  const ranked = rankFinanceSearchCandidates({
    query: q,
    candidates,
    buildSearchText,
    limit,
  });

  return {
    ok: true,
    status: ranked.usedQuery ? 'searched' : 'not_requested',
    provider: SEARCH_PROVIDER,
    hits: ranked.items.map((item) => item.candidate),
    totalCount: ranked.totalCount,
    usedQuery: ranked.usedQuery
  };
}