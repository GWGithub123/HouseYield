/**
 * Vintage and regional priors for property health.
 *
 * Nobody fills out an empty form. This produces a credible starting inventory
 * from what we already know — year built, county, coastal exposure — so the
 * owner's job becomes confirm-or-correct rather than enter-twelve-records.
 *
 * Every record produced here is marked `evidence: 'inferred'` with a plain
 * rationale, and is expected to be overwritten the moment a permit, photo, owner
 * correction, or service visit says otherwise.
 *
 * These are construction-era conventions, not claims about a specific house.
 * The UI must present them as questions.
 */

import {
  PROPERTY_HEALTH_CATEGORY_META,
  createEmptyHealthAsset,
  type PropertyHealthAsset,
  type PropertyHealthCategory,
} from '../types/propertyHealth';

export interface PriorContext {
  yearBuilt?: number | null;
  /** Full address, used only for coarse regional hints. */
  address?: string | null;
  state?: string | null;
  county?: string | null;
  /** Set when the property is near open salt water. */
  coastal?: boolean;
}

interface PriorSpec {
  key: string;
  category: PropertyHealthCategory;
  name: string;
  material?: string;
  /** Multiplies the category default. */
  lifeFactor?: number;
  usefulLifeYears?: number;
  /**
   * Where the component's age is assumed to come from. `original` means it dates
   * to construction; `cycled` means it has likely been replaced at least once and
   * we estimate age from a typical replacement cycle instead.
   */
  ageBasis: 'original' | 'cycled';
  rationale: string;
  watchFor?: string[];
  confidence: number;
  riskFlag?: PropertyHealthAsset['riskFlag'];
}

interface VintageBand {
  id: string;
  from: number;
  to: number;
  label: string;
  specs: PriorSpec[];
}

const UNIVERSAL: PriorSpec[] = [
  {
    key: 'roof',
    category: 'roof',
    name: 'Roof',
    ageBasis: 'cycled',
    rationale: 'Every home has one, and roofs are usually replaced at least once within their life.',
    confidence: 0.5,
  },
  {
    key: 'hvac',
    category: 'hvac',
    name: 'HVAC system',
    ageBasis: 'cycled',
    rationale: 'Heating and cooling equipment turns over roughly every 15 years.',
    confidence: 0.5,
  },
  {
    key: 'water_heater',
    category: 'water_heater',
    name: 'Water heater',
    ageBasis: 'cycled',
    rationale: 'Water heaters are replaced roughly every 10 years.',
    watchFor: ['Anode rod depletion', 'Tank corrosion at the base', 'TPR valve weeping'],
    confidence: 0.5,
  },
];

/**
 * Ordered oldest to newest. Bands overlap intentionally where a material was in
 * transition — polybutylene in particular spans two eras.
 */
const VINTAGE_BANDS: VintageBand[] = [
  {
    id: 'pre1960',
    from: 0,
    to: 1959,
    label: 'Pre-1960 construction',
    specs: [
      {
        key: 'plumbing_supply',
        category: 'plumbing',
        name: 'Supply lines',
        material: 'Galvanized steel',
        ageBasis: 'original',
        usefulLifeYears: 50,
        rationale: 'Homes of this era were typically plumbed in galvanized steel, which corrodes from the inside and is usually well past its service life by now.',
        watchFor: ['Reduced pressure from internal scaling', 'Rust-tinted water', 'Pinhole leaks at threaded joints'],
        confidence: 0.6,
        riskFlag: {
          severity: 'warn',
          label: 'Galvanized supply likely',
          detail: 'Galvanized supply lines from this era are typically at or past end of life. Worth confirming what the house actually has before a failure decides for you.',
        },
      },
      {
        key: 'electrical_panel',
        category: 'electrical',
        name: 'Electrical panel',
        ageBasis: 'cycled',
        rationale: 'Original service from this era is almost always undersized for modern load and has usually been upgraded at least once.',
        watchFor: ['Knob-and-tube remnants in unfinished areas', 'Undersized service', 'Ungrounded outlets'],
        confidence: 0.45,
        riskFlag: {
          severity: 'warn',
          label: 'Knob-and-tube possible',
          detail: 'Pre-1960 homes can retain knob-and-tube wiring in unfinished spaces, which many insurers will not cover.',
        },
      },
      {
        key: 'windows',
        category: 'windows',
        name: 'Windows',
        material: 'Single pane (if original)',
        ageBasis: 'cycled',
        rationale: 'Original windows of this era are single pane; many have since been replaced.',
        confidence: 0.4,
      },
    ],
  },
  {
    id: '1960s80s',
    from: 1960,
    to: 1989,
    label: '1960–1989 construction',
    specs: [
      {
        key: 'plumbing_supply',
        category: 'plumbing',
        name: 'Supply lines',
        material: 'Copper',
        ageBasis: 'original',
        usefulLifeYears: 50,
        rationale: 'Copper supply was the standard through this period and generally ages well.',
        watchFor: ['Pinhole leaks in aggressive water', 'Green staining at joints'],
        confidence: 0.6,
      },
      {
        key: 'electrical_panel',
        category: 'electrical',
        name: 'Electrical panel',
        ageBasis: 'original',
        rationale: 'Panels of this era are often original.',
        watchFor: ['Federal Pacific Stab-Lok or Zinsco panels', 'Aluminum branch wiring in late-1960s to mid-1970s homes'],
        confidence: 0.45,
        riskFlag: {
          severity: 'critical',
          label: 'Check panel brand',
          detail: 'Federal Pacific and Zinsco panels were installed widely in this era and have documented failure-to-trip problems. Identifying the brand is worth doing early.',
        },
      },
      {
        key: 'windows',
        category: 'windows',
        name: 'Windows',
        ageBasis: 'cycled',
        rationale: 'Original units from this era are usually single pane or early double pane and are frequently replaced by now.',
        confidence: 0.4,
      },
    ],
  },
  {
    id: '1990s',
    from: 1990,
    to: 2005,
    label: '1990–2005 construction',
    specs: [
      {
        key: 'plumbing_supply',
        category: 'plumbing',
        name: 'Supply lines',
        material: 'Copper or CPVC',
        ageBasis: 'original',
        usefulLifeYears: 45,
        rationale: 'Copper remained common, with CPVC appearing widely in this period.',
        confidence: 0.55,
      },
      {
        key: 'electrical_panel',
        category: 'electrical',
        name: 'Electrical panel',
        ageBasis: 'original',
        rationale: 'Panels from this era are usually original and generally adequate.',
        confidence: 0.55,
      },
      {
        key: 'windows',
        category: 'windows',
        name: 'Windows',
        material: 'Double pane',
        ageBasis: 'original',
        rationale: 'Double-pane units were standard by this period.',
        watchFor: ['Seal failure showing as fogging between panes'],
        confidence: 0.5,
      },
    ],
  },
  {
    id: 'modern',
    from: 2006,
    to: 9999,
    label: '2006 and newer construction',
    specs: [
      {
        key: 'plumbing_supply',
        category: 'plumbing',
        name: 'Supply lines',
        material: 'PEX',
        ageBasis: 'original',
        usefulLifeYears: 45,
        rationale: 'PEX became the dominant supply material for new construction in this period.',
        watchFor: ['UV degradation where runs were left exposed', 'Fitting failures at crimp joints'],
        confidence: 0.6,
      },
      {
        key: 'electrical_panel',
        category: 'electrical',
        name: 'Electrical panel',
        ageBasis: 'original',
        rationale: 'Original panel, typically 200A and modern breaker design.',
        confidence: 0.6,
      },
      {
        key: 'windows',
        category: 'windows',
        name: 'Windows',
        material: 'Double pane, low-E',
        ageBasis: 'original',
        rationale: 'Low-E double glazing was standard for new construction by this period.',
        confidence: 0.6,
      },
    ],
  },
];

/**
 * Polybutylene spans the 1970s-to-90s bands and is severe enough to warrant its
 * own rule rather than being buried in a band's material string.
 */
const POLYBUTYLENE_ERA = { from: 1978, to: 1995 };

/**
 * Salt air measurably shortens the life of condenser coils, exterior fasteners
 * and roof flashing. Applied as a multiplier rather than a separate record so it
 * shows up directly in remaining-life math.
 */
const COASTAL_LIFE_FACTOR: Partial<Record<PropertyHealthCategory, number>> = {
  hvac: 0.75,
  roof: 0.85,
  exterior: 0.75,
  windows: 0.9,
};

const COASTAL_WATCH: Partial<Record<PropertyHealthCategory, string[]>> = {
  hvac: ['Salt corrosion on the outdoor condenser coil and cabinet'],
  roof: ['Flashing and fastener corrosion from salt air'],
  exterior: ['Accelerated fastener and finish corrosion'],
};

const COASTAL_STATES = new Set(['DE', 'MD', 'NJ', 'VA', 'NC', 'SC', 'GA', 'FL', 'TX', 'CA', 'OR', 'WA', 'RI', 'MA', 'ME', 'CT', 'NY', 'LA', 'AL', 'MS', 'NH']);

const COASTAL_PLACE_HINTS = [
  'beach', 'shores', 'harbor', 'harbour', 'bay', 'island', 'cape', 'coast',
  'seaside', 'oceanside', 'inlet', 'sound', 'point pleasant',
];

export function inferCoastal(context: PriorContext): boolean {
  if (typeof context.coastal === 'boolean') return context.coastal;
  const haystack = `${context.address || ''} ${context.county || ''}`.toLowerCase();
  if (!haystack.trim()) return false;
  const hasPlaceHint = COASTAL_PLACE_HINTS.some((hint) => haystack.includes(hint));
  if (!hasPlaceHint) return false;
  const state = (context.state || '').toUpperCase();
  return state ? COASTAL_STATES.has(state) : true;
}

function resolveBand(yearBuilt: number): VintageBand | null {
  return VINTAGE_BANDS.find((band) => yearBuilt >= band.from && yearBuilt <= band.to) ?? null;
}

function estimateInstallYear(spec: PriorSpec, yearBuilt: number, lifeYears: number, now: Date): number {
  if (spec.ageBasis === 'original') return yearBuilt;
  // Assume the component sits somewhere in its current replacement cycle rather
  // than pretending we know the install date. Mid-cycle is the least-wrong guess.
  const currentYear = now.getFullYear();
  const age = currentYear - yearBuilt;
  if (age <= lifeYears) return yearBuilt;
  const cyclesElapsed = Math.floor(age / lifeYears);
  return yearBuilt + cyclesElapsed * lifeYears;
}

export interface PriorsResult {
  assets: PropertyHealthAsset[];
  bandLabel: string | null;
  coastal: boolean;
}

/**
 * Builds the inferred starting inventory. Returns an empty result when year built
 * is unknown, because without it every guess would be unfounded.
 */
export function buildPropertyHealthPriors(
  context: PriorContext,
  now = new Date(),
): PriorsResult {
  const yearBuilt = Number(context.yearBuilt);
  if (!Number.isFinite(yearBuilt) || yearBuilt < 1700 || yearBuilt > now.getFullYear() + 1) {
    return { assets: [], bandLabel: null, coastal: false };
  }

  const band = resolveBand(yearBuilt);
  const coastal = inferCoastal(context);

  const specs: PriorSpec[] = [...UNIVERSAL, ...(band?.specs ?? [])];

  if (yearBuilt >= POLYBUTYLENE_ERA.from && yearBuilt <= POLYBUTYLENE_ERA.to) {
    const index = specs.findIndex((spec) => spec.key === 'plumbing_supply');
    const polyb: PriorSpec = {
      key: 'plumbing_supply',
      category: 'plumbing',
      name: 'Supply lines',
      material: 'Possible polybutylene',
      ageBasis: 'original',
      usefulLifeYears: 30,
      rationale: `Homes built between ${POLYBUTYLENE_ERA.from} and ${POLYBUTYLENE_ERA.to} were often plumbed with polybutylene, which fails without warning.`,
      watchFor: ['Grey or blue flexible supply pipe at the water heater or main shutoff', 'Sudden pinhole failures'],
      confidence: 0.4,
      riskFlag: {
        severity: 'critical',
        label: 'Polybutylene era',
        detail: 'Polybutylene supply piping was widely installed in this era, fails without warning, and is excluded by many insurers. Confirming the pipe material is the single highest-value check on this property.',
      },
    };
    if (index >= 0) specs[index] = polyb;
    else specs.push(polyb);
  }

  const assets = specs.map((spec) => {
    const meta = PROPERTY_HEALTH_CATEGORY_META[spec.category];
    const baseLife = spec.usefulLifeYears ?? meta.defaultUsefulLifeYears;
    const coastalFactor = coastal ? COASTAL_LIFE_FACTOR[spec.category] ?? 1 : 1;
    const usefulLifeYears = Math.max(0.25, Math.round(baseLife * (spec.lifeFactor ?? 1) * coastalFactor * 100) / 100);

    const installYear = estimateInstallYear(spec, yearBuilt, usefulLifeYears, now);
    const watchFor = [
      ...(spec.watchFor ?? []),
      ...(coastal ? COASTAL_WATCH[spec.category] ?? [] : []),
    ];

    const rationale = coastal && coastalFactor < 1
      ? `${spec.rationale} Expected life shortened for salt-air exposure.`
      : spec.rationale;

    return createEmptyHealthAsset({
      id: `prior_${spec.key}`,
      category: spec.category,
      name: spec.name,
      material: spec.material,
      installedAt: `${installYear}-01-01`,
      usefulLifeYears,
      source: 'import',
      evidence: 'inferred',
      priorKey: spec.key,
      watchFor: watchFor.length ? watchFor : undefined,
      riskFlag: spec.riskFlag ?? null,
      provenance: {
        existence: {
          evidence: 'inferred',
          confidence: spec.confidence,
          rationale,
          observedAt: now.toISOString(),
        },
        installedAt: {
          evidence: 'inferred',
          confidence: spec.ageBasis === 'original' ? spec.confidence : spec.confidence * 0.7,
          rationale: spec.ageBasis === 'original'
            ? `Assumed original to the ${yearBuilt} build.`
            : `Estimated from a typical ${usefulLifeYears}-year replacement cycle since ${yearBuilt}.`,
          observedAt: now.toISOString(),
        },
        ...(spec.material
          ? {
              material: {
                evidence: 'inferred' as const,
                confidence: spec.confidence,
                rationale,
                observedAt: now.toISOString(),
              },
            }
          : {}),
      },
    });
  });

  return { assets, bandLabel: band?.label ?? null, coastal };
}

/**
 * Merges inferred records into the saved inventory without ever overwriting
 * something better. A prior only appears where the owner has nothing for that
 * category, and disappears once real evidence lands.
 */
export function mergePriorsWithSaved(
  saved: PropertyHealthAsset[],
  priors: PropertyHealthAsset[],
): PropertyHealthAsset[] {
  const savedPriorKeys = new Set(saved.map((asset) => asset.priorKey).filter(Boolean));
  const savedCategories = new Set(saved.map((asset) => asset.category));

  const additions = priors.filter((prior) => {
    if (prior.priorKey && savedPriorKeys.has(prior.priorKey)) return false;
    // If the owner already tracks anything in this category, our guess about it
    // is no longer useful and would only add noise.
    return !savedCategories.has(prior.category);
  });

  return [...saved, ...additions];
}
