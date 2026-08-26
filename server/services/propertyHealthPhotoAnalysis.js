import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

import {
  fetchFirebaseStorageFileByPath,
  fetchRemoteDocumentBuffer,
} from './documentDigitizationService.js';

const API_KEY = process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_PROPERTY_HEALTH_VISION_MODEL
  || process.env.CLAUDE_HEALTH_DOCUMENT_MODEL
  || 'claude-sonnet-4-20250514';
let anthropicClient = null;

function getAnthropic() {
  if (!API_KEY) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: API_KEY });
  return anthropicClient;
}

const CATEGORIES = [
  'roof', 'hvac', 'water_heater', 'windows', 'air_filter', 'water_filter',
  'smart_home', 'appliance', 'electrical', 'plumbing', 'exterior', 'other',
];
const URGENCIES = ['routine', 'monitor', 'soon', 'urgent'];
const SEVERITIES = ['info', 'watch', 'warning', 'critical'];

function text(value, max = 240) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean ? clean.slice(0, max) : null;
}

function enumValue(value, values, fallback) {
  return typeof value === 'string' && values.includes(value) ? value : fallback;
}

function score(value, min, max) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : null;
}

function list(value, limit = 10, max = 240) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => text(entry, max))
    .filter(Boolean)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, limit);
}

function date(value) {
  const clean = text(value, 40);
  if (!clean) return null;
  const parsed = Date.parse(clean);
  if (Number.isNaN(parsed) || parsed > Date.now() + 86_400_000) return null;
  return new Date(parsed).toISOString().slice(0, 10);
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

export function normalizePropertyHealthPhotoAnalysis(raw, hints = {}) {
  const hintedCategory = CATEGORIES.includes(hints.category) ? hints.category : 'other';
  const componentPresent = raw?.componentPresent !== false;
  const category = enumValue(raw?.category, CATEGORIES, hintedCategory);
  const confidence = score(raw?.confidence, 0, 1) ?? 0.35;
  const make = text(raw?.make, 80);
  const model = text(raw?.model, 100);
  const observations = Array.isArray(raw?.observations)
    ? raw.observations.map((observation) => ({
        label: text(observation?.label, 160),
        severity: enumValue(observation?.severity, SEVERITIES, 'info'),
        evidence: text(observation?.evidence, 300),
      })).filter((observation) => observation.label && observation.evidence).slice(0, 10)
    : [];

  return {
    componentPresent,
    category,
    name: text(raw?.name, 120) || text(hints.name, 120),
    make,
    model,
    serialNumber: text(raw?.serialNumber, 100),
    // A data plate can date manufacture, not installation. Keeping this separate
    // prevents a photo from silently resetting every age-derived forecast.
    manufactureDate: date(raw?.manufactureDate),
    conditionScore: componentPresent ? score(raw?.conditionScore, 0, 100) : null,
    urgency: enumValue(raw?.urgency, URGENCIES, 'monitor'),
    summary: text(raw?.summary, 600),
    observations,
    wearSigns: list(raw?.wearSigns, 8),
    failureSigns: list(raw?.failureSigns, 8),
    recommendedActions: list(raw?.recommendedActions, 8),
    ocrText: text(raw?.ocrText, 1500),
    limitations: list(raw?.limitations, 8),
    confidence,
    modelIdentityReady: Boolean(make && model && confidence >= 0.6),
  };
}

async function resolveBuffer({ buffer, storagePath, fileUrl }) {
  if (buffer) return buffer;
  if (storagePath) return (await fetchFirebaseStorageFileByPath(storagePath)).buffer;
  if (fileUrl) return (await fetchRemoteDocumentBuffer(fileUrl)).buffer;
  throw new Error('No photo source was provided');
}

async function normalizedJpeg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Photo is empty');
  if (buffer.length > 25 * 1024 * 1024) throw new Error('Photo exceeds the 25 MB limit');
  return sharp(buffer)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

export async function analyzePropertyHealthPhoto({
  buffer,
  storagePath,
  fileUrl,
  category,
  name,
  make,
  model,
  sourceKind = 'owner_photo',
}) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    return {
      ok: false,
      status: 'vision_not_configured',
      error: 'Claude property-health vision is not configured',
      analysis: null,
    };
  }

  const image = await normalizedJpeg(await resolveBuffer({ buffer, storagePath, fileUrl }));
  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 2200,
    system: `You inspect a photo of a residential building component for a property-health record.
Return ONLY JSON:
{
  "componentPresent": boolean,
  "category": one of ${JSON.stringify(CATEGORIES)},
  "name": string or null,
  "make": string or null,
  "model": string or null,
  "serialNumber": string or null,
  "manufactureDate": "YYYY-MM-DD" or null,
  "conditionScore": number 0-100 or null,
  "urgency": one of ${JSON.stringify(URGENCIES)},
  "summary": string,
  "observations": [{"label": string, "severity": one of ${JSON.stringify(SEVERITIES)}, "evidence": string}],
  "wearSigns": string[],
  "failureSigns": string[],
  "recommendedActions": string[],
  "ocrText": string or null,
  "limitations": string[],
  "confidence": number 0-1
}

Rules:
- Describe only visible evidence. Do not claim hidden damage, code violations,
  leaks, recalls, or mechanical failure from appearance alone.
- Read make/model/serial only when legible. Preserve characters exactly and use
  null when uncertain.
- manufactureDate is a date explicitly printed or reliably decoded from the data
  plate. It is NEVER the installation date.
- conditionScore is a visual-condition estimate, not a failure probability.
- For a roof, distinguish staining, moss, granule loss, lifted/missing shingles,
  flashing defects, ponding, and obvious patching only when actually visible.
- Put occlusion, distance, glare, missing angles, and inability to test operation
  in limitations.
- Recommended actions should be inspections or tests that verify the observation,
  not declarations that replacement is definitely required.`,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: image.toString('base64'),
          },
        },
        {
          type: 'text',
          text: [
            `Expected category: ${category || 'unknown'}`,
            `Owner's component name: ${name || 'unknown'}`,
            `Existing make: ${make || 'unknown'}`,
            `Existing model: ${model || 'unknown'}`,
            `Image source: ${sourceKind === 'aerial' ? 'Google satellite/aerial capture' : 'owner component photo'}`,
            sourceKind === 'aerial'
              ? 'For aerial imagery, lower confidence for ambiguous discoloration, do not infer active leaks, and list image date/resolution/occlusion as limitations when unknown.'
              : '',
            'Inspect the component and transcribe any visible data plate.',
          ].filter(Boolean).join('\n'),
        },
      ],
    }],
  });

  const output = response?.content?.map((part) => part?.text || '').join('\n') || '';
  const raw = parseJsonBlock(output);
  if (!raw) {
    return {
      ok: false,
      status: 'unreadable_response',
      error: 'Vision response was not valid structured data',
      analysis: null,
    };
  }

  return {
    ok: true,
    status: 'analyzed',
    analysis: normalizePropertyHealthPhotoAnalysis(raw, { category, name }),
  };
}
