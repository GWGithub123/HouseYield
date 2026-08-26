import Anthropic from '@anthropic-ai/sdk';
import admin from 'firebase-admin';

import { runGoogleCustomSearch } from './googleCustomSearchService.js';

const CLAUDE_API_KEY = process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_COMPONENT_RESEARCH_MODEL
  || process.env.CLAUDE_HEALTH_DOCUMENT_MODEL
  || 'claude-sonnet-4-20250514';
const CACHE_DAYS = Math.max(7, Number(process.env.COMPONENT_MODEL_CACHE_DAYS || 90));
let anthropicClient = null;

function getAnthropic() {
  if (!CLAUDE_API_KEY) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: CLAUDE_API_KEY });
  return anthropicClient;
}

const CATEGORIES = new Set([
  'roof', 'hvac', 'water_heater', 'windows', 'air_filter', 'water_filter',
  'smart_home', 'appliance', 'electrical', 'plumbing', 'exterior', 'other',
]);

function text(value, max = 240) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean ? clean.slice(0, max) : null;
}

function number(value, min, max) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : null;
}

function numberInRange(value, min, max) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function stringList(value, limit = 8, max = 240) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => text(entry, max))
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index)
    .slice(0, limit);
}

function parseJsonBlock(value) {
  if (typeof value !== 'string') return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function componentModelKey(category, make, model) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return [normalize(category), normalize(make), normalize(model)].filter(Boolean).join('_').slice(0, 180);
}

export function normalizeComponentModelResearch(
  raw,
  { id, category, make, model, sources = [], researchedAt = new Date().toISOString() },
) {
  const observedMedianLifeYears = numberInRange(raw?.observedMedianLifeYears, 0.25, 100);
  const observedSampleSize = numberInRange(raw?.observedSampleSize, 0, 1_000_000);
  const reliabilityScore = number(raw?.reliabilityScore, 0, 100);
  const recallCount = numberInRange(raw?.recallCount, 0, 1000);
  const confidence = number(raw?.confidence, 0, 1) ?? 0.35;

  return {
    id,
    category: CATEGORIES.has(category) ? category : 'other',
    make: text(make, 80),
    model: text(model, 100),
    reliabilityScore,
    observedMedianLifeYears,
    observedSampleSize: observedSampleSize == null ? null : Math.round(observedSampleSize),
    recallCount: recallCount == null ? null : Math.round(recallCount),
    reviewSummary: text(raw?.reviewSummary, 600),
    failureModes: stringList(raw?.failureModes),
    installationPitfalls: stringList(raw?.installationPitfalls),
    maintenanceRecommendations: stringList(raw?.maintenanceRecommendations),
    recallNotes: stringList(raw?.recallNotes, 6, 320),
    sourceUrls: sources
      .map((source) => text(source?.link, 500))
      .filter(Boolean)
      .filter((url, index, list) => list.indexOf(url) === index)
      .slice(0, 20),
    sourceTitles: sources
      .map((source) => text(source?.title, 180))
      .filter(Boolean)
      .slice(0, 20),
    confidence,
    researchedAt,
  };
}

function cacheIsFresh(profile, now = new Date()) {
  const researched = Date.parse(profile?.researchedAt || '');
  return Number.isFinite(researched)
    && now.getTime() - researched < CACHE_DAYS * 24 * 60 * 60 * 1000;
}

async function searchModel({ category, make, model }) {
  const identity = `"${make}" "${model}"`;
  const queries = [
    `${identity} recall safety notice CPSC manufacturer`,
    `${identity} reliability reviews common failure problems`,
    `${identity} service life maintenance installation manual ${category}`,
  ];
  const responses = await Promise.all(queries.map((query) => runGoogleCustomSearch(query, 6)));
  return responses
    .flatMap((response) => response?.results || [])
    .filter((result, index, list) =>
      result.link && list.findIndex((candidate) => candidate.link === result.link) === index
    );
}

async function distillResearch({ category, make, model, results }) {
  const anthropic = getAnthropic();
  if (!anthropic || results.length === 0) return null;
  const evidence = results.map((result, index) =>
    `[${index + 1}] ${result.title}\n${result.snippet}\n${result.link}`
  ).join('\n\n');

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    temperature: 0,
    max_tokens: 2200,
    system: `You research installed residential equipment reliability from web-search evidence.
Return ONLY JSON:
{
  "reliabilityScore": number 0-100 or null,
  "observedMedianLifeYears": number or null,
  "observedSampleSize": number or null,
  "recallCount": number or null,
  "reviewSummary": string or null,
  "failureModes": string[],
  "installationPitfalls": string[],
  "maintenanceRecommendations": string[],
  "recallNotes": string[],
  "confidence": number 0-1
}

Rules:
- Use only the supplied snippets. Never invent a recall, sample size, failure rate,
  or lifespan. Use null when the snippets do not support a number.
- Reliability score is a cautious synthesis, not a customer-review star rating.
- Separate product failure modes from installation mistakes.
- Recall count means distinct recall campaigns that appear applicable to this exact
  model or a clearly stated model family. If applicability is uncertain, use null
  and explain it in recallNotes.
- Manufacturer guidance may support maintenance advice but not reliability claims.
- Search snippets can be wrong or duplicated. Lower confidence when sources conflict.`,
    messages: [{
      role: 'user',
      content: `Component: ${category}\nMake: ${make}\nModel: ${model}\n\nSearch evidence:\n${evidence}`,
    }],
  });

  const output = response?.content?.map((part) => part?.text || '').join('\n') || '';
  return parseJsonBlock(output);
}

/**
 * Returns a cached model profile or researches and stores a new one.
 *
 * The cache is global by make/model, not per property. That is the intended
 * network effect: every confirmed unit improves the reusable model record while
 * property-specific age, service history, and exposure remain on the property.
 */
export async function getOrResearchComponentModel({
  category,
  make,
  model,
  force = false,
}) {
  const cleanCategory = CATEGORIES.has(category) ? category : 'other';
  const cleanMake = text(make, 80);
  const cleanModel = text(model, 100);
  if (!cleanMake || !cleanModel) {
    return { ok: false, status: 'missing_identity', error: 'make and model are required', profile: null };
  }

  const id = componentModelKey(cleanCategory, cleanMake, cleanModel);
  const db = admin.firestore();
  const ref = db.collection('componentModels').doc(id);
  const snapshot = await ref.get();
  const cached = snapshot.exists ? snapshot.data() : null;
  if (!force && cacheIsFresh(cached)) {
    return { ok: true, status: 'cached', profile: cached };
  }

  let results = [];
  try {
    results = await searchModel({ category: cleanCategory, make: cleanMake, model: cleanModel });
  } catch (error) {
    if (cached) {
      return { ok: true, status: 'stale_cache', warning: error.message, profile: cached };
    }
    return { ok: false, status: 'search_failed', error: error.message, profile: null };
  }

  const distilled = await distillResearch({
    category: cleanCategory,
    make: cleanMake,
    model: cleanModel,
    results,
  });
  if (!distilled) {
    if (cached) return { ok: true, status: 'stale_cache', profile: cached };
    const researchConfigured = Boolean(CLAUDE_API_KEY);
    return {
      ok: false,
      status: researchConfigured ? 'insufficient_evidence' : 'research_not_configured',
      error: researchConfigured
        ? 'Search results did not support a model profile'
        : 'Claude component research is not configured',
      profile: null,
    };
  }

  const profile = normalizeComponentModelResearch(distilled, {
    id,
    category: cleanCategory,
    make: cleanMake,
    model: cleanModel,
    sources: results,
  });
  await ref.set(profile, { merge: true });
  return { ok: true, status: 'researched', profile };
}
