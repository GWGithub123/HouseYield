export type PropertyHealthCategory =
  | 'roof'
  | 'hvac'
  | 'water_heater'
  | 'windows'
  | 'air_filter'
  | 'water_filter'
  | 'smart_home'
  | 'appliance'
  | 'electrical'
  | 'plumbing'
  | 'exterior'
  | 'other';

export type PropertyHealthStatus = 'healthy' | 'monitor' | 'attention' | 'unknown';

export type PropertyHealthSource = 'manual' | 'permit' | 'import';

/**
 * How we came to believe something about a component, ordered weakest to
 * strongest. A record can hold an inferred material alongside an owner-confirmed
 * install date, so evidence is tracked per fact rather than per record.
 *
 * `service` outranks everything because a technician physically looked at it.
 * That is where maintenance visits compound into data that cannot be bought.
 */
export type HealthEvidence =
  | 'inferred'
  | 'permit'
  | 'document'
  | 'photo'
  | 'owner'
  | 'service';

/**
 * Only the ordering matters — `isHigherEvidence` compares ranks, so the numbers
 * are free to be renumbered when a rung is inserted.
 *
 * `document` sits above a permit because an invoice names the actual unit that
 * was fitted rather than the work that was approved, and below a photo of the
 * component because a document can describe a unit nobody has since laid eyes on.
 */
export const HEALTH_EVIDENCE_RANK: Record<HealthEvidence, number> = {
  inferred: 0,
  permit: 1,
  document: 2,
  photo: 3,
  owner: 4,
  service: 5,
};

export const HEALTH_EVIDENCE_META: Record<HealthEvidence, { label: string; short: string }> = {
  inferred: { label: 'Estimated from property age and region', short: 'Estimated' },
  permit: { label: 'From a building permit on file', short: 'Permit' },
  document: { label: 'Read from an uploaded receipt or record', short: 'Document' },
  photo: { label: 'Read from a photo of the unit', short: 'Photo' },
  owner: { label: 'Confirmed by the owner', short: 'Confirmed' },
  service: { label: 'Verified during a maintenance visit', short: 'Verified' },
};

export interface FieldProvenance {
  evidence: HealthEvidence;
  /** 0-1. How much to trust this particular fact. */
  confidence: number;
  /** Plain-language reason, shown to the owner when they are asked to confirm. */
  rationale?: string;
  /** Permit number, attachment id, or visit id backing the claim. */
  sourceRef?: string;
  observedAt: string;
}

/** Fields that can carry independent provenance. */
export type ProvenancedField =
  | 'installedAt'
  | 'usefulLifeYears'
  | 'make'
  | 'model'
  | 'serialNumber'
  | 'material'
  | 'existence';

export function isHigherEvidence(next: HealthEvidence, current: HealthEvidence): boolean {
  return HEALTH_EVIDENCE_RANK[next] > HEALTH_EVIDENCE_RANK[current];
}

export interface PropertyHealthAttachment {
  id: string;
  name: string;
  url: string;
  storagePath?: string;
  contentType?: string;
  uploadedAt: string;
}

/**
 * What was done to a component, and whether it may re-date it.
 *
 * This distinction is the whole reason document ingestion cannot write straight
 * into the inventory. A receipt naming a water heater might be a $180 valve
 * repair or a $2,400 replacement, and treating the first as an install date
 * would silently reset the age of the component the rest of the system reasons
 * hardest about. Only `install` and `replace` may move `installedAt`.
 */
export type HealthWorkKind =
  | 'install'
  | 'replace'
  | 'repair'
  | 'service'
  | 'inspect'
  | 'unknown';

export const HEALTH_WORK_KIND_META: Record<
  HealthWorkKind,
  { label: string; datesComponent: boolean }
> = {
  install: { label: 'Installed', datesComponent: true },
  replace: { label: 'Replaced', datesComponent: true },
  repair: { label: 'Repaired', datesComponent: false },
  service: { label: 'Serviced', datesComponent: false },
  inspect: { label: 'Inspected', datesComponent: false },
  unknown: { label: 'Work recorded', datesComponent: false },
};

/**
 * Money spent on one component, attached to the component itself.
 *
 * Kept on the asset rather than in its own collection because health assets
 * persist as a single array field on the property document; a separate
 * collection would need its own join on every read for no gain at this size.
 * This is what makes lifetime spend and repair-versus-replace answerable.
 */
export interface HealthSpendEvent {
  id: string;
  occurredAt: string;
  amountUsd: number;
  workKind: HealthWorkKind;
  vendor?: string;
  description?: string;
  /** Attachment or document id the figure was read from. */
  documentId?: string;
  /** Maintenance request this came from, when it came from a visit. */
  requestId?: string;
  createdAt: string;
}

export interface PropertyHealthAsset {
  id: string;
  category: PropertyHealthCategory;
  name: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  installedAt?: string | null;
  /** Used when install date is unknown but owner knows approximate age. */
  estimatedAgeYears?: number | null;
  usefulLifeYears?: number | null;
  notes?: string;
  source?: PropertyHealthSource;
  attachments?: PropertyHealthAttachment[];
  /** Every repair, service and replacement billed against this component. */
  spend?: HealthSpendEvent[];
  /** Latest owner-accepted visual inspection; appearance is not hidden condition. */
  visualCondition?: {
    score: number;
    observedAt: string;
    summary?: string;
    observations: Array<{
      label: string;
      severity: 'info' | 'watch' | 'warning' | 'critical';
      evidence: string;
    }>;
    wearSigns: string[];
    failureSigns: string[];
    recommendedActions: string[];
    limitations: string[];
    confidence: number;
    attachmentId?: string;
  } | null;

  /** Expected material, e.g. "PEX", "copper", "architectural shingle". */
  material?: string;
  /**
   * Weakest evidence backing this record's existence. Anything at `inferred` is a
   * guess awaiting confirm-or-correct and is rendered differently.
   */
  evidence?: HealthEvidence;
  /** Per-field provenance. Absent entries fall back to `evidence`. */
  provenance?: Partial<Record<ProvenancedField, FieldProvenance>>;
  /** Set on records produced by the priors engine so they can be regenerated. */
  priorKey?: string;
  /**
   * The owner told us this component does not exist here. Persisted rather than
   * simply deleted so the priors engine stops re-suggesting it on every load.
   */
  notApplicable?: boolean;
  /** Failure modes this vintage/material is prone to, shown as context. */
  watchFor?: string[];
  /** Elevated to the top of the rail when a prior flags a known-bad material. */
  riskFlag?: {
    severity: 'info' | 'warn' | 'critical';
    label: string;
    detail: string;
  } | null;

  createdAt: string;
  updatedAt: string;
}

/** An inferred record the owner has neither confirmed nor corrected yet. */
export function isUnconfirmedAsset(asset: PropertyHealthAsset): boolean {
  return (asset.evidence ?? 'owner') === 'inferred';
}

/**
 * `consequence` is what failure costs beyond the part itself. A water heater
 * rupture floods a finished basement; a stale air filter costs efficiency. The
 * health score weights by this rather than treating every component equally,
 * which is why a tracked air filter cannot mask an unknown roof.
 */
export const PROPERTY_HEALTH_CATEGORY_META: Record<
  PropertyHealthCategory,
  {
    label: string;
    defaultUsefulLifeYears: number;
    description: string;
    typicalReplacementUsd: number;
    consequence: number;
    /** Counts toward baseline coverage — the systems every home has. */
    core: boolean;
  }
> = {
  roof: { label: 'Roof', defaultUsefulLifeYears: 25, description: 'Shingles, membrane, underlayment', typicalReplacementUsd: 14000, consequence: 5, core: true },
  hvac: { label: 'HVAC', defaultUsefulLifeYears: 15, description: 'Furnace, AC, heat pump, air handler', typicalReplacementUsd: 8500, consequence: 4, core: true },
  water_heater: { label: 'Water heater', defaultUsefulLifeYears: 10, description: 'Tank or tankless water heater', typicalReplacementUsd: 2200, consequence: 5, core: true },
  windows: { label: 'Windows', defaultUsefulLifeYears: 30, description: 'Window units or whole-home replacement', typicalReplacementUsd: 12000, consequence: 2, core: true },
  air_filter: { label: 'Air filter', defaultUsefulLifeYears: 0.25, description: 'Furnace / HVAC filter', typicalReplacementUsd: 30, consequence: 1, core: false },
  water_filter: { label: 'Water filter', defaultUsefulLifeYears: 0.5, description: 'Whole-home, fridge, or RO filter', typicalReplacementUsd: 80, consequence: 1, core: false },
  smart_home: { label: 'Smart home', defaultUsefulLifeYears: 7, description: 'Sensors, leak shutoffs, hubs, cameras', typicalReplacementUsd: 400, consequence: 2, core: false },
  appliance: { label: 'Appliance', defaultUsefulLifeYears: 12, description: 'Fridge, washer, dryer, dishwasher, range', typicalReplacementUsd: 1200, consequence: 2, core: false },
  electrical: { label: 'Electrical', defaultUsefulLifeYears: 40, description: 'Panel, wiring upgrades, EV charger', typicalReplacementUsd: 3500, consequence: 5, core: true },
  plumbing: { label: 'Plumbing', defaultUsefulLifeYears: 40, description: 'Supply lines, sewer, fixtures', typicalReplacementUsd: 9000, consequence: 5, core: true },
  exterior: { label: 'Exterior', defaultUsefulLifeYears: 25, description: 'Siding, gutters, deck, driveway', typicalReplacementUsd: 9000, consequence: 2, core: false },
  other: { label: 'Other', defaultUsefulLifeYears: 10, description: 'Anything else worth tracking', typicalReplacementUsd: 500, consequence: 1, core: false },
};

/** The systems coverage is measured against. */
export const CORE_HEALTH_CATEGORIES = (
  Object.keys(PROPERTY_HEALTH_CATEGORY_META) as PropertyHealthCategory[]
).filter((category) => PROPERTY_HEALTH_CATEGORY_META[category].core);

export const PROPERTY_HEALTH_QUICK_ADD: Array<{
  category: PropertyHealthCategory;
  name: string;
}> = [
  { category: 'roof', name: 'Roof' },
  { category: 'hvac', name: 'HVAC system' },
  { category: 'water_heater', name: 'Water heater' },
  { category: 'windows', name: 'Windows' },
  { category: 'air_filter', name: 'Air filter' },
  { category: 'water_filter', name: 'Water filter' },
  { category: 'smart_home', name: 'Leak sensor / shutoff' },
  { category: 'appliance', name: 'Refrigerator' },
  { category: 'appliance', name: 'Washer / dryer' },
  { category: 'electrical', name: 'Electrical panel' },
];

export function yearsBetween(fromIso: string, toDate = new Date()): number | null {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return null;
  const ms = toDate.getTime() - from.getTime();
  if (ms < 0) return 0;
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

export function resolveAssetAgeYears(asset: PropertyHealthAsset, now = new Date()): number | null {
  if (asset.installedAt) {
    const fromInstall = yearsBetween(asset.installedAt, now);
    if (fromInstall != null) return fromInstall;
  }
  if (typeof asset.estimatedAgeYears === 'number' && Number.isFinite(asset.estimatedAgeYears)) {
    return Math.max(0, asset.estimatedAgeYears);
  }
  return null;
}

export function resolveUsefulLifeYears(asset: PropertyHealthAsset): number {
  if (typeof asset.usefulLifeYears === 'number' && Number.isFinite(asset.usefulLifeYears) && asset.usefulLifeYears > 0) {
    return asset.usefulLifeYears;
  }
  return PROPERTY_HEALTH_CATEGORY_META[asset.category]?.defaultUsefulLifeYears ?? 10;
}

export function resolveAssetStatus(asset: PropertyHealthAsset, now = new Date()): PropertyHealthStatus {
  const age = resolveAssetAgeYears(asset, now);
  if (age == null) return 'unknown';
  const life = resolveUsefulLifeYears(asset);
  if (life <= 0) return 'unknown';
  const ratio = age / life;
  if (ratio >= 0.85) return 'attention';
  if (ratio >= 0.6) return 'monitor';
  return 'healthy';
}

export function formatAgeLabel(years: number | null): string {
  if (years == null || !Number.isFinite(years)) return 'Age unknown';
  if (years < 1 / 12) return 'Installed recently';
  if (years < 1) {
    const months = Math.max(1, Math.round(years * 12));
    return `${months} mo old`;
  }
  if (years < 10) return `${years.toFixed(1)} yr old`;
  return `${Math.round(years)} yr old`;
}

export function createEmptyHealthAsset(
  partial: Partial<PropertyHealthAsset> & Pick<PropertyHealthAsset, 'category' | 'name'>,
): PropertyHealthAsset {
  const now = new Date().toISOString();
  return {
    id: partial.id || `health_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    category: partial.category,
    name: partial.name,
    make: partial.make || '',
    model: partial.model || '',
    serialNumber: partial.serialNumber || '',
    installedAt: partial.installedAt ?? null,
    estimatedAgeYears: partial.estimatedAgeYears ?? null,
    usefulLifeYears:
      partial.usefulLifeYears
      ?? PROPERTY_HEALTH_CATEGORY_META[partial.category]?.defaultUsefulLifeYears
      ?? 10,
    notes: partial.notes || '',
    source: partial.source || 'manual',
    attachments: partial.attachments || [],
    spend: partial.spend || [],
    visualCondition: partial.visualCondition ?? null,
    material: partial.material,
    evidence: partial.evidence ?? 'owner',
    provenance: partial.provenance,
    priorKey: partial.priorKey,
    notApplicable: partial.notApplicable ?? false,
    watchFor: partial.watchFor,
    riskFlag: partial.riskFlag ?? null,
    createdAt: partial.createdAt || now,
    updatedAt: now,
  };
}

/* ── health scoring ────────────────────────────────────────────────── */

export interface PropertyHealthScore {
  /** 0-100. Condition of what we know about, weighted by consequence of failure. */
  score: number;
  /** 0-100. How much of the core system set we have any information on. */
  coverage: number;
  tracked: number;
  confirmed: number;
  unconfirmed: number;
  attention: number;
  monitor: number;
  avgAgeYears: number | null;
  /** Replacement cost of everything already past 85% of its life. */
  deferredLiabilityUsd: number;
  headline: string;
  missingCoreCategories: PropertyHealthCategory[];
}

/**
 * Condition weighted by what failure would actually cost, then discounted by how
 * confident we are. The old measure was `assets.length / 8`, which let eight
 * tracked air filters read as full coverage while the roof was unknown.
 */
export function computePropertyHealthScore(
  assets: PropertyHealthAsset[],
  now = new Date(),
): PropertyHealthScore {
  const tracked = assets.length;
  const trackedCategories = new Set(assets.map((asset) => asset.category));
  const missingCoreCategories = CORE_HEALTH_CATEGORIES.filter(
    (category) => !trackedCategories.has(category),
  );

  const coverage = CORE_HEALTH_CATEGORIES.length
    ? Math.round(
        ((CORE_HEALTH_CATEGORIES.length - missingCoreCategories.length)
          / CORE_HEALTH_CATEGORIES.length) * 100,
      )
    : 0;

  let weightSum = 0;
  let weightedConditionSum = 0;
  let attention = 0;
  let monitor = 0;
  let confirmed = 0;
  let deferredLiabilityUsd = 0;
  const ages: number[] = [];

  for (const asset of assets) {
    const meta = PROPERTY_HEALTH_CATEGORY_META[asset.category];
    const status = resolveAssetStatus(asset, now);
    if (status === 'attention') attention += 1;
    if (status === 'monitor') monitor += 1;
    if (!isUnconfirmedAsset(asset)) confirmed += 1;

    const age = resolveAssetAgeYears(asset, now);
    if (age != null) ages.push(age);

    const life = resolveUsefulLifeYears(asset);
    const lifeUsed = age != null && life > 0 ? Math.min(age / life, 1.5) : null;

    if (lifeUsed != null && lifeUsed >= 0.85) {
      deferredLiabilityUsd += meta?.typicalReplacementUsd ?? 0;
    }

    const weight = meta?.consequence ?? 1;
    if (weight <= 0) continue;

    const condition = lifeUsed == null
      ? 0.5 // unknown age is neither good news nor bad
      : Math.max(0, 1 - lifeUsed);

    const evidenceConfidence = Math.min(
      1,
      Math.max(
        0,
        asset.provenance?.installedAt?.confidence
          ?? (isUnconfirmedAsset(asset) ? 0.45 : 1),
      ),
    );

    /*
     * Uncertainty pulls a component toward the neutral midpoint rather than
     * discounting its weight. Reweighting alone would cancel out of the average,
     * so an inventory of pure guesses would have scored the same as a verified
     * one. Shrinking instead means a guessed-fresh component reads better than
     * nothing but never as good as a confirmed-fresh one, and a guessed-old
     * component is not condemned on evidence we do not have.
     */
    const effectiveCondition = 0.5 + (condition - 0.5) * evidenceConfidence;

    weightSum += weight;
    weightedConditionSum += effectiveCondition * weight;
  }

  const conditionScore = weightSum > 0 ? (weightedConditionSum / weightSum) * 100 : 0;
  // Unknown systems cannot be healthy, so coverage caps the score rather than
  // being reported beside it as if the two were independent.
  const score = tracked === 0 ? 0 : Math.round(conditionScore * (0.4 + 0.6 * (coverage / 100)));

  const avgAgeYears = ages.length ? ages.reduce((sum, age) => sum + age, 0) / ages.length : null;

  const headline = tracked === 0
    ? 'Not started'
    : attention > 0
      ? 'Needs attention'
      : missingCoreCategories.length > 0
        ? 'Gaps to fill'
        : monitor > 0
          ? 'Monitor closely'
          : 'Looking solid';

  return {
    score,
    coverage,
    tracked,
    confirmed,
    unconfirmed: tracked - confirmed,
    attention,
    monitor,
    avgAgeYears,
    deferredLiabilityUsd,
    headline,
    missingCoreCategories,
  };
}

/** 0-1 share of useful life consumed, for the life bars on inventory cards. */
export function resolveLifeUsedRatio(asset: PropertyHealthAsset, now = new Date()): number | null {
  const age = resolveAssetAgeYears(asset, now);
  if (age == null) return null;
  const life = resolveUsefulLifeYears(asset);
  if (life <= 0) return null;
  return Math.max(0, age / life);
}
