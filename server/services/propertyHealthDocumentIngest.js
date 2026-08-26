import Anthropic from '@anthropic-ai/sdk';
import {
  digitizeDocumentFromBytes,
  digitizeDocumentFromStorage,
  resolveDocumentMimeType
} from './documentDigitizationService.js';

/**
 * Reads maintenance receipts and home records into property-health proposals.
 *
 * Extraction is not re-implemented here. `documentDigitizationService` already
 * runs Azure Document Intelligence for layout and text and Claude for a general
 * interpretation, and it already handles PDFs — it is only the documents-page
 * caller that gates on images, which is why receipts arriving as PDFs never got
 * read. This module skips that gate and adds the one thing the general
 * interpreter cannot know: which house component a document is about, and
 * whether it describes fitting one or fixing one.
 *
 * That last distinction carries the most weight in the whole pipeline. Dating a
 * component from a repair invoice would silently reset the age that every
 * remaining-life and forecast number is computed from, so the model is asked to
 * separate the two explicitly and to abstain rather than guess.
 */

const CLAUDE_API_KEY = process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_HEALTH_DOCUMENT_MODEL
  || process.env.CLAUDE_DOCUMENT_MODEL
  || 'claude-sonnet-4-20250514';

const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

const CATEGORIES = [
  'roof',
  'hvac',
  'water_heater',
  'windows',
  'air_filter',
  'water_filter',
  'smart_home',
  'appliance',
  'electrical',
  'plumbing',
  'exterior',
  'other'
];

const WORK_KINDS = ['install', 'replace', 'repair', 'service', 'inspect', 'unknown'];

const DOCUMENT_KINDS = ['receipt', 'invoice', 'estimate', 'inspection', 'manual', 'permit', 'other'];

const SYSTEM_PROMPT = `You read home maintenance paperwork and extract what it proves about the physical components of a house.

You will be given the extracted text of one document, plus the general classification another model already produced.

Return ONLY JSON matching this shape:
{
  "documentKind": one of ${JSON.stringify(DOCUMENT_KINDS)},
  "vendor": string or null,
  "servicedAt": "YYYY-MM-DD" or null,
  "totalUsd": number or null,
  "findings": [
    {
      "category": one of ${JSON.stringify(CATEGORIES)},
      "name": string or null,
      "make": string or null,
      "model": string or null,
      "serialNumber": string or null,
      "workKind": one of ${JSON.stringify(WORK_KINDS)},
      "amountUsd": number or null,
      "description": string or null,
      "confidence": number between 0 and 1,
      "rationale": string
    }
  ]
}

Rules that matter more than completeness:

1. workKind is the most consequential field. "install" and "replace" mean a new
   unit is now in the house and the document dates it. "repair", "service" and
   "inspect" mean an existing unit was worked on and the document says NOTHING
   about its age. If the paperwork does not make this clear, use "unknown".
   Never guess "replace" because an amount looks large.
2. Only report a finding if the document actually evidences it. An estimate for
   work that may not have happened is documentKind "estimate" and its findings
   should carry low confidence.
3. amountUsd is the money attributable to that component. If the document has
   one total covering one component, they are the same. If a document covers
   several components, split by line item; if it cannot be split, leave the
   component amounts null and report only totalUsd.
4. Do not invent model or serial numbers. Part numbers on an invoice line are
   not the serial number of the installed unit. If unsure, null.
5. confidence should reflect how clearly the document supports the finding, not
   how confident you feel about your reading of the text.
6. An empty findings array is a correct answer for a document that is not about
   a house component (a tax form, a lease, a utility bill).`;

/** Anything the distiller returns that is not a known enum value is discarded. */
function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value.trim()) ? value.trim() : fallback;
}

function pickString(value, max = 160) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return undefined;
  return trimmed.slice(0, max);
}

function pickMoney(value) {
  const amount = typeof value === 'string'
    ? Number(value.replace(/[^0-9.\-]/g, ''))
    : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // Six figures on a component receipt is an extraction error, not a purchase.
  return amount > 250_000 ? null : Math.round(amount * 100) / 100;
}

/**
 * A date is only useful here if it parses and is not in the future.
 *
 * Returned as a plain calendar date: receipts carry a day, not a moment, and
 * keeping a fake time-of-day would make two records of the same day compare
 * unequal.
 */
function pickDate(value) {
  const text = pickString(value, 40);
  if (!text) return null;
  const time = Date.parse(text);
  if (Number.isNaN(time)) return null;
  if (time > Date.now() + 86_400_000) return null;
  return new Date(time).toISOString().slice(0, 10);
}

function pickConfidence(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function parseJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Asks the model which components a document is about.
 *
 * Returns null rather than throwing when Claude is unconfigured or the response
 * is unusable: the caller still has the general digitization to show, and a
 * failed distillation should degrade to "we stored your document" rather than
 * losing the upload.
 */
async function distillFindings({ extractedText, documentType, summary, keyFacts, fileName }) {
  if (!anthropic) return null;

  const factLines = Array.isArray(keyFacts)
    ? keyFacts.map((fact) => `- ${fact.label}: ${fact.value} (${fact.confidence})`).join('\n')
    : '';

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `File name: ${fileName || 'unknown'}`,
          `Prior classification: ${documentType || 'unknown'}`,
          summary ? `Prior summary: ${summary}` : '',
          factLines ? `Extracted key facts:\n${factLines}` : '',
          '',
          'Document text:',
          // Enough for a multi-page invoice; the component details are near the
          // line items rather than buried at the end of a long contract.
          String(extractedText || '').slice(0, 24_000)
        ].filter(Boolean).join('\n')
      }
    ]
  });

  const text = response?.content?.map((part) => part?.text || '').join('\n') || '';
  return parseJsonBlock(text);
}

function normalizeFindings(distilled, { documentId, documentName }) {
  const documentKind = pickEnum(distilled?.documentKind, DOCUMENT_KINDS, 'other');
  const documentDate = pickDate(distilled?.servicedAt);
  const totalUsd = pickMoney(distilled?.totalUsd);
  const vendor = pickString(distilled?.vendor, 120);

  const rawFindings = Array.isArray(distilled?.findings) ? distilled.findings : [];

  const proposals = rawFindings
    .map((finding, index) => {
      const category = pickEnum(finding?.category, CATEGORIES, null);
      if (!category) return null;

      return {
        id: `prop_${index}`,
        category,
        name: pickString(finding?.name),
        make: pickString(finding?.make, 80),
        model: pickString(finding?.model, 80),
        serialNumber: pickString(finding?.serialNumber, 80),
        // A finding without its own date falls back to the document's date.
        servicedAt: pickDate(finding?.servicedAt) || documentDate,
        workKind: pickEnum(finding?.workKind, WORK_KINDS, 'unknown'),
        vendor,
        amountUsd: pickMoney(finding?.amountUsd),
        description: pickString(finding?.description, 400),
        confidence: pickConfidence(finding?.confidence),
        documentId,
        documentName,
        documentKind,
        rationale: pickString(finding?.rationale, 300)
      };
    })
    .filter(Boolean);

  /*
   * A single-component document whose line items could not be split still has a
   * total, and that total is the component's cost. Only applied when there is
   * exactly one finding, because dividing a multi-component invoice by guesswork
   * would put fabricated figures into the cost ledger.
   */
  if (proposals.length === 1 && proposals[0].amountUsd == null && totalUsd != null) {
    proposals[0].amountUsd = totalUsd;
  }

  return { documentKind, vendor, documentDate, totalUsd, proposals };
}

/**
 * Digitizes a document and returns property-health proposals for it.
 *
 * Accepts either raw bytes or a Firebase Storage path, matching the two ways
 * documents already arrive in this codebase.
 */
export async function ingestHealthDocument({
  buffer,
  storagePath,
  fileUrl,
  mimeType,
  fileName,
  documentId,
  title
}) {
  const resolvedMimeType = resolveDocumentMimeType(fileName || '', mimeType || '');

  /*
   * Called without the images-only gate the documents page applies. The
   * digitizer handles PDF directly, and a maintenance receipt is a PDF far more
   * often than it is a photo.
   */
  const digitization = buffer
    ? await digitizeDocumentFromBytes({ buffer, mimeType: resolvedMimeType, fileName, title })
    : await digitizeDocumentFromStorage({ storagePath, fileUrl, mimeType: resolvedMimeType, fileName, title });

  if (!digitization?.ok) {
    return {
      ok: false,
      status: digitization?.status || 'failed',
      reason: digitization?.reason || 'digitization_failed',
      error: digitization?.error || 'Could not read the document',
      proposals: []
    };
  }

  let distilled = null;
  let distillError = null;
  try {
    distilled = await distillFindings({
      extractedText: digitization.extractedText,
      documentType: digitization.documentType,
      summary: digitization.summary,
      keyFacts: digitization.keyFacts,
      fileName
    });
  } catch (error) {
    distillError = error.message;
    console.warn('[PropertyHealthIngest] distillation failed:', error.message);
  }

  const normalized = normalizeFindings(distilled, {
    documentId: documentId || `doc_${Date.now().toString(36)}`,
    documentName: fileName
  });

  return {
    ok: true,
    status: distilled ? 'completed' : 'partial',
    error: distillError,
    document: {
      id: documentId,
      name: fileName,
      mimeType: digitization.mimeType,
      documentType: digitization.documentType,
      documentKind: normalized.documentKind,
      summary: digitization.summary,
      vendor: normalized.vendor,
      documentDate: normalized.documentDate,
      totalUsd: normalized.totalUsd,
      pageCount: digitization.pageCount,
      extractionQuality: digitization.extractionQuality
    },
    proposals: normalized.proposals
  };
}

/** Exported for tests: the pure normalization step, with no network involved. */
export const __testing = { normalizeFindings, pickDate, pickMoney };

export default { ingestHealthDocument };
