import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = express.Router();
const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const FILE_PATH = path.join(DATA_DIR, 'ongoing-maintenance.json');

const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_SEARCH_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_ENGINE_ID || '';
const GEMINI_API_KEY = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY || '';

let geminiModel = null;
if (GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  } catch (error) {
    console.warn('[Maintenance Scheduler] Gemini unavailable:', error.message);
  }
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify({ items: [] }, null, 2));
  }
}

function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
}

function saveStore(store) {
  ensureStore();
  fs.writeFileSync(FILE_PATH, JSON.stringify(store, null, 2));
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addDays(value, days) {
  const base = new Date(value);
  if (Number.isNaN(base.getTime()) || !Number.isFinite(days)) return null;
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

function sanitizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildItem(payload) {
  const now = new Date().toISOString();
  return {
    id: payload.id || `maint_${crypto.randomUUID()}`,
    ownerId: sanitizeText(payload.ownerId),
    propertyId: sanitizeText(payload.propertyId),
    propertyAddress: sanitizeText(payload.propertyAddress),
    title: sanitizeText(payload.title),
    description: sanitizeText(payload.description),
    category: sanitizeText(payload.category) || 'general',
    source: sanitizeText(payload.source) || 'manual',
    productName: sanitizeText(payload.productName),
    modelNumber: sanitizeText(payload.modelNumber),
    installedAt: normalizeDate(payload.installedAt),
    dueDate: normalizeDate(payload.dueDate),
    cadenceDays: Number.isFinite(Number(payload.cadenceDays)) ? Number(payload.cadenceDays) : null,
    priority: sanitizeText(payload.priority) || 'medium',
    notes: sanitizeText(payload.notes),
    status: sanitizeText(payload.status) || 'active',
    sourceTransactionId: sanitizeText(payload.sourceTransactionId),
    sourceAppointmentId: sanitizeText(payload.sourceAppointmentId),
    searchQuery: sanitizeText(payload.searchQuery),
    manufacturerGuidance: payload.manufacturerGuidance || null,
    aiSummary: sanitizeText(payload.aiSummary),
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    createdAt: payload.createdAt || now,
    updatedAt: now,
  };
}

async function googleSearch(query, numResults = 5) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_CSE_CX || !query) {
    return [];
  }

  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_SEARCH_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_CX);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(numResults, 10)));

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error('[Maintenance Scheduler] Google search failed:', response.status);
      return [];
    }

    const data = await response.json();
    return (data.items || []).map((item) => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      source: item.displayLink,
    }));
  } catch (error) {
    console.error('[Maintenance Scheduler] Google search error:', error.message);
    return [];
  }
}

function parseJsonResponse(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function researchReplacementInterval({ productName, modelNumber, title, installedAt }) {
  const descriptor = [productName, modelNumber, title].filter(Boolean).join(' ').trim();
  if (!descriptor) {
    throw new Error('Product name, model number, or title is required for research');
  }

  const query = `${descriptor} manufacturer replacement interval model number`;
  const sources = await googleSearch(query, 5);

  let guidance = {
    intervalDays: null,
    intervalText: '',
    orderLeadDays: 14,
    summary: 'AI research unavailable. Review the manufacturer documentation manually.',
    confidence: 0.2,
    evidence: [],
  };

  if (geminiModel && sources.length > 0) {
    const prompt = `You are a maintenance planner for rental properties. Determine the manufacturer-recommended replacement interval for a product using the search results below. Focus on the exact model when possible. Return strict JSON only with this shape:\n{\n  "intervalDays": number | null,\n  "intervalText": string,\n  "orderLeadDays": number,\n  "summary": string,\n  "confidence": number,\n  "evidence": [{"title": string, "link": string, "note": string}]\n}\n\nProduct context:\n- title: ${title || ''}\n- productName: ${productName || ''}\n- modelNumber: ${modelNumber || ''}\n- installedAt: ${installedAt || ''}\n\nSearch results:\n${sources.map((source, index) => `${index + 1}. ${source.title}\n${source.link}\n${source.snippet}`).join('\n\n')}`;

    try {
      const result = await geminiModel.generateContent(prompt);
      const text = result.response.text();
      const parsed = parseJsonResponse(text);
      if (parsed) {
        guidance = {
          intervalDays: Number.isFinite(Number(parsed.intervalDays)) ? Number(parsed.intervalDays) : null,
          intervalText: sanitizeText(parsed.intervalText),
          orderLeadDays: Number.isFinite(Number(parsed.orderLeadDays)) ? Number(parsed.orderLeadDays) : 14,
          summary: sanitizeText(parsed.summary),
          confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.5,
          evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 5) : [],
        };
      }
    } catch (error) {
      console.error('[Maintenance Scheduler] Gemini research error:', error.message);
    }
  }

  const fallbackInterval = guidance.intervalDays || 180;
  const installBase = normalizeDate(installedAt) || new Date().toISOString();
  const dueDate = addDays(installBase, fallbackInterval);
  const orderDate = dueDate ? addDays(dueDate, -1 * (guidance.orderLeadDays || 14)) : null;

  return {
    searchQuery: query,
    dueDate,
    orderDate,
    guidance,
    sources,
  };
}

router.get('/ongoing', (req, res) => {
  try {
    const ownerId = sanitizeText(req.query.ownerId);
    const store = loadStore();
    const items = store.items
      .filter((item) => !ownerId || item.ownerId === ownerId)
      .sort((a, b) => new Date(a.dueDate || a.installedAt || a.createdAt).getTime() - new Date(b.dueDate || b.installedAt || b.createdAt).getTime());

    res.json({ ok: true, items });
  } catch (error) {
    console.error('[Maintenance Scheduler] Failed to load ongoing items:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to load maintenance items' });
  }
});

router.post('/ongoing/manual', (req, res) => {
  try {
    const item = buildItem(req.body || {});
    if (!item.ownerId || !item.title) {
      return res.status(400).json({ ok: false, error: 'ownerId and title are required' });
    }

    if (!item.dueDate && item.installedAt && item.cadenceDays) {
      item.dueDate = addDays(item.installedAt, item.cadenceDays);
    }

    const store = loadStore();
    store.items = store.items.filter((existing) => existing.id !== item.id);
    store.items.push(item);
    saveStore(store);

    res.json({ ok: true, item });
  } catch (error) {
    console.error('[Maintenance Scheduler] Failed to save manual item:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to save maintenance item' });
  }
});

router.post('/ongoing/research', async (req, res) => {
  try {
    const ownerId = sanitizeText(req.body?.ownerId);
    const title = sanitizeText(req.body?.title);
    const productName = sanitizeText(req.body?.productName);
    const modelNumber = sanitizeText(req.body?.modelNumber);
    const installedAt = normalizeDate(req.body?.installedAt) || new Date().toISOString();

    if (!ownerId) {
      return res.status(400).json({ ok: false, error: 'ownerId is required' });
    }

    const research = await researchReplacementInterval({ productName, modelNumber, title, installedAt });
    const intervalDays = research.guidance.intervalDays || 180;
    const item = buildItem({
      ...req.body,
      ownerId,
      title: title || productName || modelNumber || 'Scheduled replacement',
      source: req.body?.source || 'ai_research',
      installedAt,
      dueDate: research.dueDate,
      cadenceDays: intervalDays,
      category: req.body?.category || 'replacement',
      searchQuery: research.searchQuery,
      manufacturerGuidance: {
        intervalDays,
        intervalText: research.guidance.intervalText,
        orderLeadDays: research.guidance.orderLeadDays,
        orderDate: research.orderDate,
        confidence: research.guidance.confidence,
      },
      aiSummary: research.guidance.summary,
      sources: (research.guidance.evidence || []).length > 0 ? research.guidance.evidence : research.sources,
    });

    const store = loadStore();
    store.items.push(item);
    saveStore(store);

    res.json({ ok: true, item, research });
  } catch (error) {
    console.error('[Maintenance Scheduler] Research error:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to research replacement schedule' });
  }
});

router.delete('/ongoing/:itemId', (req, res) => {
  try {
    const ownerId = sanitizeText(req.query.ownerId || req.body?.ownerId);
    const { itemId } = req.params;
    const store = loadStore();
    const before = store.items.length;
    store.items = store.items.filter((item) => item.id !== itemId || (ownerId && item.ownerId !== ownerId));
    saveStore(store);
    res.json({ ok: true, removed: before - store.items.length });
  } catch (error) {
    console.error('[Maintenance Scheduler] Delete error:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to delete maintenance item' });
  }
});

export default router;
