/**
 * Structured service records.
 *
 * Replaces the old `serviceCompletion` blob ({completedAt, completedBy, notes}) with
 * parts line items, labor, costs, photos, and warranty terms. This is the raw material
 * for the per-property and per-provider data layer, so normalization happens here
 * rather than being trusted from the client.
 */

const PHOTO_KINDS = ['before', 'after', 'parts', 'receipt'];

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveInt(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function normalizePhotoList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((photo) => photo && typeof photo === 'object' && photo.url)
    .map((photo) => ({
      url: String(photo.url),
      name: String(photo.name || ''),
      contentType: String(photo.contentType || ''),
      size: toNumberOrNull(photo.size),
      kind: String(photo.kind || ''),
      storagePath: String(photo.storagePath || ''),
      inline: Boolean(photo.inline),
      uploadedAt: photo.uploadedAt || null,
    }));
}

export function buildDefaultServiceRecord() {
  return {
    completedAt: null,
    completedBy: '',
    providerId: '',
    providerName: '',
    diagnosis: '',
    workPerformed: '',
    parts: [],
    labor: { hours: null, rate: null, cost: null },
    totals: { parts: null, labor: null, tax: null, total: null },
    photos: { before: [], after: [], parts: [], receipt: [] },
    warranty: { months: null, expiresAt: null, terms: '' },
    followUpRecommended: false,
    followUpDueAt: null,
    notes: '',
  };
}

export function normalizeServicePart(part) {
  const quantity = toPositiveInt(part?.quantity, 1);
  const unitCost = toNumberOrNull(part?.unitCost);

  return {
    name: String(part?.name || '').trim(),
    manufacturer: String(part?.manufacturer || '').trim(),
    modelNumber: String(part?.modelNumber || '').trim(),
    partNumber: String(part?.partNumber || '').trim(),
    category: String(part?.category || '').trim(),
    quantity,
    unitCost,
    warrantyMonths: toNumberOrNull(part?.warrantyMonths),
    lineTotal: unitCost === null ? null : quantity * unitCost,
  };
}

/**
 * Costs are derived from the line items rather than trusted, so the numbers on the
 * owner's receipt always reconcile with the parts list shown beside them.
 */
export function computeServiceTotals(parts, labor, taxInput) {
  const partsTotal = parts.reduce((sum, part) => {
    if (part.unitCost === null) return sum;
    return sum + part.quantity * part.unitCost;
  }, 0);

  const explicitLabor = toNumberOrNull(labor?.cost);
  const laborTotal = explicitLabor !== null
    ? explicitLabor
    : (toNumberOrNull(labor?.hours) || 0) * (toNumberOrNull(labor?.rate) || 0);

  const tax = toNumberOrNull(taxInput) || 0;
  const roundCents = (value) => Math.round(value * 100) / 100;

  return {
    parts: roundCents(partsTotal),
    labor: roundCents(laborTotal),
    tax: roundCents(tax),
    total: roundCents(partsTotal + laborTotal + tax),
  };
}

function resolveWarrantyExpiry(warranty, completedAt) {
  const months = toNumberOrNull(warranty?.months);
  if (warranty?.expiresAt) return warranty.expiresAt;
  if (!months || !completedAt) return null;

  const start = new Date(completedAt);
  if (Number.isNaN(start.getTime())) return null;

  const expiry = new Date(start);
  expiry.setMonth(expiry.getMonth() + months);
  return expiry.toISOString();
}

export function mergeServiceRecord(existing = null, updates = null) {
  const base = buildDefaultServiceRecord();
  const current = existing && typeof existing === 'object' ? existing : {};
  const next = updates && typeof updates === 'object' ? updates : {};

  const merged = { ...base, ...current, ...next };

  merged.completedAt = merged.completedAt || null;
  merged.completedBy = String(merged.completedBy || '');
  merged.providerId = String(merged.providerId || '');
  merged.providerName = String(merged.providerName || '');
  merged.diagnosis = String(merged.diagnosis || '');
  merged.workPerformed = String(merged.workPerformed || '');
  merged.notes = String(merged.notes || '');

  merged.parts = (Array.isArray(merged.parts) ? merged.parts : [])
    .map(normalizeServicePart)
    .filter((part) => part.name);

  merged.labor = {
    hours: toNumberOrNull(merged.labor?.hours),
    rate: toNumberOrNull(merged.labor?.rate),
    cost: toNumberOrNull(merged.labor?.cost),
  };

  const providedTax = merged.totals?.tax ?? next.tax;
  merged.totals = computeServiceTotals(merged.parts, merged.labor, providedTax);
  // Keep labor.cost consistent with what the totals report.
  merged.labor.cost = merged.totals.labor;

  const photoSource = merged.photos && typeof merged.photos === 'object' ? merged.photos : {};
  merged.photos = PHOTO_KINDS.reduce((accumulator, kind) => {
    accumulator[kind] = normalizePhotoList(photoSource[kind]);
    return accumulator;
  }, {});

  merged.warranty = {
    months: toNumberOrNull(merged.warranty?.months),
    expiresAt: resolveWarrantyExpiry(merged.warranty, merged.completedAt),
    terms: String(merged.warranty?.terms || ''),
  };

  merged.followUpRecommended = Boolean(merged.followUpRecommended);
  merged.followUpDueAt = merged.followUpDueAt || null;

  return merged;
}

/** One-line description used for receipts and the legacy `serviceCompletion.notes`. */
export function summarizeServiceRecord(record) {
  if (!record) return '';

  const pieces = [];
  if (record.workPerformed) pieces.push(record.workPerformed);
  else if (record.diagnosis) pieces.push(record.diagnosis);

  if (record.parts?.length) {
    const partNames = record.parts.map((part) => (
      part.quantity > 1 ? `${part.quantity}× ${part.name}` : part.name
    ));
    pieces.push(`Parts: ${partNames.join(', ')}`);
  }

  if (record.labor?.hours) {
    pieces.push(`${record.labor.hours}h labor`);
  }

  return pieces.join(' · ');
}

export function buildDefaultMaintenanceOutcome() {
  return {
    resolvedFirstVisit: null,
    repeatIssue: false,
    repeatOfRequestId: '',
    verifiedAt: null,
    ownerRating: null,
    notes: '',
  };
}

export function mergeMaintenanceOutcome(existing = null, updates = null) {
  const merged = {
    ...buildDefaultMaintenanceOutcome(),
    ...((existing && typeof existing === 'object') ? existing : {}),
    ...((updates && typeof updates === 'object') ? updates : {}),
  };

  merged.resolvedFirstVisit = merged.resolvedFirstVisit === null || merged.resolvedFirstVisit === undefined
    ? null
    : Boolean(merged.resolvedFirstVisit);
  merged.repeatIssue = Boolean(merged.repeatIssue);
  merged.repeatOfRequestId = String(merged.repeatOfRequestId || '');
  merged.ownerRating = toNumberOrNull(merged.ownerRating);
  merged.notes = String(merged.notes || '');

  return merged;
}
