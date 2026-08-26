/**
 * RegionalRenovationTestModal.tsx
 *
 * End-to-end test harness for the full regional renovation uplift pipeline.
 *
 * Flow:
 *   1. User enters an address of a property on the market
 *   2. Load ATTOM property data + Zillow listing + photos
 *   3. Run GPT-4o Vision to detect needed renovations from photos
 *   4. Trigger regional uplift processing for the ZIP code (Zillow API)
 *   5. Fetch area-summary with real uplift-isolated ROI data
 *   6. Combine measurement-based costs + regional ROI → final analysis
 */

import React, { useState, useCallback, useRef } from 'react';
import { normalizeCanonicalRenovationSuggestion } from '../utils/canonicalRenovationSuggestion';

// ───────────────────────── types ─────────────────────────

interface PropertyData {
  address: string;
  attomId?: string;
  beds: number;
  baths: number;
  sqft: number;
  yearBuilt: number;
  propertyType: string;
  avm?: number;
  rentalAvm?: number;
  lastSalePrice?: number;
  lastSaleDate?: string;
  taxAssessed?: number;
  zipCode: string;
  city: string;
  state: string;
}

interface MLSListing {
  LISTINGKEY: string;
  LISTPRICE: number;
  CLOSEPRICE?: number;
  STANDARDSTATUS: string;
  ONMARKETDATE?: string;
  CLOSEDATE?: string;
  PHOTOSCOUNT: number;
  photos: string[];
}

interface DetectedRenovation {
  area: string;
  type: string;
  scope: string;
  confidence: number;
  priority?: string;
  estimatedCost?: string;
  description: string;
}

interface RegionalROI {
  renovationType: string;
  avgROI: number;
  avgValueUplift: number;
  avgRentIncrease: number;
  avgCost: number;
  medianROI: number;
  sampleSize: number;
  confidenceLevel: string;
  paybackMonths: number;
  roiTrend: string | { direction?: string; percentChange?: number };
}

interface MeasurementSuggestion {
  id: string;
  name: string;
  type: string;
  cost: number;
  costRange?: { low: number; high: number };
  valueIncrease?: number;
  rentIncreaseDollar?: number;
  roi?: number;
  confidence?: string;
  timeframe?: string;
  canonicalContext?: {
    primaryKey: string;
    source: string;
    canonicalOpportunityId: string | null;
    canonicalRoomType: string | null;
    canonicalCategory: string | null;
    canonicalScopeType: string | null;
  };
  canonicalResult?: {
    resultId: string;
    primaryKey: string;
    source: string;
    canonicalOpportunityId: string | null;
    canonicalRoomType: string | null;
    canonicalCategory: string | null;
    canonicalScopeType: string | null;
    totalCost: number;
    costRange?: { low: number; high: number };
    valueIncrease: number;
    rentIncreaseDollar: number;
    roi: number;
    paybackMonths: number | null;
    confidence: string;
    timeframe: string;
  };
  measurements?: {
    measured?: boolean;
    roomType?: string;
    roomDimensions?: {
      widthFt?: number;
      lengthFt?: number;
      heightFt?: number;
      floorAreaSqFt?: number;
      wallAreaSqFt?: number;
      wallAreaGrossSqFt?: number;
      wallOpeningAreaSqFt?: number;
      wallAreaIncludesOpenings?: boolean;
      perimeterFt?: number;
    };
    sourcePhotoIndexes?: number[];
  };
  materialBreakdown?: Array<{ category?: string; item?: string; quantity?: number; unit?: string; totalCost?: number }>;
  laborBreakdown?: Array<{ trade?: string; hours?: number; rate?: number; totalCost?: number }>;
}

interface ComparableProperty {
  id: string;
  address: string;
  propertyType?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  beforeSalePrice?: number;
  afterSalePrice?: number;
  overallValueROI?: number;
  renovationAttributedUplift?: number;
  totalRenovationCost?: number;
  photoComparison?: {
    beforePhotos: string[];
    afterPhotos: string[];
    renovationCount?: number;
    overallConfidence?: number;
  };
  rentAnalysis?: {
    rentBefore?: number | null;
    rentAfter?: number | null;
    rentIncrease?: number | null;
    rentIncreasePercent?: number | null;
  };
  renovations?: Array<{
    category: string;
    scope: string;
    description?: string;
    qualityLevel?: string;
    beforeDescription?: string;
    afterDescription?: string;
    estimatedCost?: number;
    allocatedUplift?: number;
    valueROI?: number;
    affectedRooms?: string[];
    estimatedAreaSqFt?: number;
    materials?: Array<{
      name: string;
      materialTier?: string;
      confidence?: number;
    }>;
  }>;
}

interface PipelineStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  detail?: string;
  duration?: number;
}

// ───────────────────────── component ─────────────────────────

interface RegionalRenovationTestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const RegionalRenovationTestModal: React.FC<RegionalRenovationTestModalProps> = ({ isOpen, onClose }) => {
  // Inputs
  const [address, setAddress] = useState('');
  
  // Data stores
  const [property, setProperty] = useState<PropertyData | null>(null);
  const [mlsListing, setMlsListing] = useState<MLSListing | null>(null);
  const [allPhotos, setAllPhotos] = useState<string[]>([]);
  const [detectedRenovations, setDetectedRenovations] = useState<DetectedRenovation[]>([]);
  const [detectedOverallCondition, setDetectedOverallCondition] = useState<string | null>(null);
  const [detectedConditionScore, setDetectedConditionScore] = useState<number | null>(null);
  const [regionalROIs, setRegionalROIs] = useState<RegionalROI[]>([]);
  const [regionalROIsFilteredForSubject, setRegionalROIsFilteredForSubject] = useState(false);
  const [areaSummary, setAreaSummary] = useState<any>(null);
  const [processingResult, setProcessingResult] = useState<any>(null);
  const [combinedAnalysis, setCombinedAnalysis] = useState<any>(null);
  const [measurementSuggestions, setMeasurementSuggestions] = useState<MeasurementSuggestion[]>([]);

  const [areaComparables, setAreaComparables] = useState<ComparableProperty[]>([]);
  const [marketContext, setMarketContext] = useState<{
    appreciationRate: number;        // annualized YoY appreciation %
    avgDOM: number;                  // average days-on-market
    avgSaleToListPct: number;        // sale-to-list price ratio %
    monthsOfSupply: number | null;   // FRED MSACSR (null if unavailable)
    heatScore: number;               // continuous 0-100 (50 = neutral)
    heatLabel: string;               // 'cold' | 'cool' | 'neutral' | 'warm' | 'hot'
  } | null>(null);

  // UI state
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);
  const [showPhotos, setShowPhotos] = useState(false);
  const abortRef = useRef(false);

  // ─────────── helpers ───────────

  const updateStep = useCallback((id: string, patch: Partial<PipelineStep>) => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }, []);

  const fmt = (n?: number) => n != null ? '$' + Math.round(n).toLocaleString() : '—';
  const pct = (n?: number) => n != null ? n.toFixed(1) + '%' : '—';
  const getTrendDirection = (trend: RegionalROI['roiTrend']): 'rising' | 'falling' | 'stable' => {
    if (!trend) return 'stable';
    if (typeof trend === 'string') {
      const t = trend.toLowerCase();
      if (t === 'increasing' || t === 'rising') return 'rising';
      if (t === 'decreasing' || t === 'falling') return 'falling';
      return 'stable';
    }
    const d = (trend.direction || '').toLowerCase();
    if (d === 'increasing' || d === 'rising') return 'rising';
    if (d === 'decreasing' || d === 'falling') return 'falling';
    return 'stable';
  };

  const normalizeRenoType = (value: string = '') => value.toLowerCase().replace(/[_\s-]+/g, ' ').trim();

  // Bidirectional matching: measured suggestion type → regional comp type
  const matchMeasuredToRegional = (measuredType: string, measuredName: string, bestRenos: any[]): any | null => {
    const mt = normalizeRenoType(measuredType);
    const mn = normalizeRenoType(measuredName);
    const combined = `${mt} ${mn}`;

    // Mapping from measured suggestion keywords → possible regional renovation types
    const keywordToRegional: Record<string, string[]> = {
      kitchen: ['kitchen', 'kitchen_full', 'kitchen_cosmetic'],
      bathroom: ['bathroom_master', 'bathroom_secondary', 'bathroom_full', 'bathroom_cosmetic'],
      flooring: ['flooring'], floor: ['flooring'], tile: ['flooring'], hardwood: ['flooring'], lvp: ['flooring'], vinyl: ['flooring'],
      paint: ['paint_interior', 'paint_exterior'], primer: ['paint_interior'],
      window: ['windows'], windows: ['windows'],
      roof: ['roof'], roofing: ['roof'],
      siding: ['siding'],
      landscape: ['landscaping'], landscaping: ['landscaping'], yard: ['landscaping'], driveway: ['landscaping'],
      deck: ['deck_patio'], patio: ['deck_patio'],
      hvac: ['hvac'], furnace: ['hvac'], 'air conditioning': ['hvac'],
      door: ['doors'], doors: ['doors'],
      cabinet: ['kitchen', 'kitchen_cosmetic'], countertop: ['kitchen'],
      appliance: ['kitchen'], vanity: ['bathroom_secondary', 'bathroom_master'],
      exterior: ['paint_exterior', 'siding'],
      interior: ['paint_interior'],
      trim: ['paint_interior'],
    };

    // Find all candidate regional types from the measured item's keywords
    const candidateTypes = new Set<string>();
    for (const [keyword, types] of Object.entries(keywordToRegional)) {
      if (combined.includes(keyword)) {
        types.forEach(t => candidateTypes.add(t));
      }
    }

    // Find the best matching regional comp data
    // Normalize candidate types too — keywordToRegional uses underscores (paint_interior)
    // but bestRenos.renovationType is also stored with underscores. After normalizeRenoType,
    // both become space-separated ("paint interior") so comparisons succeed.
    for (const rawCandidate of candidateTypes) {
      const candidateNorm = normalizeRenoType(rawCandidate);
      const match = bestRenos.find((r: any) => {
        const rt = normalizeRenoType(r.renovationType);
        return rt === candidateNorm || rt.includes(candidateNorm) || candidateNorm.includes(rt);
      });
      if (match) return match;
    }
    return null;
  };

  const mapRegionalTypeToCandidates = (regionalType: string): string[] => {
    const t = normalizeRenoType(regionalType);
    // Map keys are normalized (spaces, not underscores) to match normalizeRenoType output
    const map: Record<string, string[]> = {
      'kitchen': ['kitchen', 'kitchen update', 'kitchen remodel'],
      'kitchen full': ['kitchen', 'kitchen remodel'],
      'kitchen cosmetic': ['kitchen', 'kitchen update'],
      'bathroom master': ['bathroom', 'master bathroom', 'bathroom remodel'],
      'bathroom secondary': ['bathroom', 'secondary bathroom', 'bathroom remodel'],
      'bathroom full': ['bathroom', 'bathroom remodel'],
      'bathroom cosmetic': ['bathroom', 'bathroom refresh'],
      'flooring': ['flooring', 'floor', 'tile', 'hardwood'],
      'paint interior': ['paint', 'interior paint', 'paint interior'],
      'paint exterior': ['paint', 'exterior paint', 'paint exterior'],
      'windows': ['window', 'windows'],
      'roof': ['roof'],
      'siding': ['siding'],
      'landscaping': ['landscape', 'landscaping', 'yard'],
      'deck patio': ['deck', 'patio', 'deck patio'],
      'hvac': ['hvac'],
      'doors': ['door', 'doors'],
      'basement': ['basement'],
      'other': ['other'],
    };
    return map[t] || [t];
  };

  // ── Condition scoring on 1-100 scale ──
  // Convert any condition representation (string label, 1-10 score, 1-100 score) to a normalized 1-100 score.
  // Returns null if no condition data is available.
  const conditionToScore100 = (value?: string | number | null): number | null => {
    if (value == null) return null;
    // Already numeric
    if (typeof value === 'number') {
      if (value >= 0 && value <= 10) return Math.round(value * 10); // 1-10 → 10-100
      if (value >= 0 && value <= 100) return Math.round(value);     // already 1-100
      return null;
    }
    // String label or text
    const v = value.toLowerCase();
    // Check for embedded numeric score first (e.g., "45/100" or "score: 72")
    const numMatch = v.match(/(\d{1,3})\s*\/\s*100/) || v.match(/score\s*:?\s*(\d{1,3})/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n >= 0 && n <= 100) return n;
    }
    // Map string labels to 1-100 ranges (midpoint of each bracket)
    if (/(severely|major|dilapidated|damaged|neglected|distressed|uninhabitable)/.test(v)) return 10;
    if (/(poor|very dated|deferred maintenance|significant wear)/.test(v)) return 20;
    if (/(below average|worn|tired|needs work)/.test(v)) return 30;
    if (/(fair|dated|original|builder.?grade|functional|older finishes|needs update)/.test(v)) return 40;
    if (/(average|adequate|acceptable|decent|usable)/.test(v)) return 50;
    if (/(above average|clean|solid|maintained|good condition)/.test(v)) return 60;
    if (/(good|well maintained|updated|recent updates|well kept)/.test(v)) return 70;
    if (/(very good|move.?in ready|recently refreshed|modern|upgraded)/.test(v)) return 80;
    if (/(excellent|fully renovated|fully updated|like new|newly remodeled|pristine)/.test(v)) return 90;
    if (/(perfect|brand new|just built|luxury finish)/.test(v)) return 95;
    return null;
  };

  // Infer a 1-100 condition score from text descriptions (GPT-4o generated before/after descriptions)
  const inferConditionScore = (...texts: Array<string | undefined | null>): number | null => {
    const t = texts.filter(Boolean).join(' ').toLowerCase();
    if (!t) return null;

    // Look for severity signals and assign a nuanced score
    let score = 50; // default midpoint
    let signals = 0;

    // Negative signals (lower score)
    if (/(severely|dilapidated|damaged|safety concern|uninhabitable)/.test(t)) { score -= 35; signals++; }
    if (/(neglected|distressed|deferred maintenance|major repair)/.test(t)) { score -= 25; signals++; }
    if (/(very dated|very worn|very old|peeling|cracked|broken|rotting|rusted)/.test(t)) { score -= 20; signals++; }
    if (/(dated|original|builder.?grade|old|worn|needs update|laminate|formica|linoleum)/.test(t)) { score -= 12; signals++; }
    if (/(stained|discolored|faded|chipped|scratched|dented)/.test(t)) { score -= 8; signals++; }
    if (/(white appliances|brass fixtures|oak cabinets|popcorn ceiling|wallpaper)/.test(t)) { score -= 6; signals++; }

    // Positive signals (higher score)
    if (/(excellent|pristine|like new|brand new|luxury|custom)/.test(t)) { score += 30; signals++; }
    if (/(fully renovated|fully updated|newly remodeled|recently renovated)/.test(t)) { score += 25; signals++; }
    if (/(modern|upgraded|quartz|granite|stainless|hardwood|subway tile)/.test(t)) { score += 15; signals++; }
    if (/(good condition|well maintained|clean|functional|solid|updated)/.test(t)) { score += 10; signals++; }
    if (/(adequate|average|acceptable|fair condition)/.test(t)) { score += 0; signals++; }

    if (signals === 0) return null;
    return Math.max(1, Math.min(100, Math.round(score)));
  };

  // Backward-compat: map to label for display purposes
  const scoreToConditionLabel = (score: number | null): string => {
    if (score == null) return 'unknown';
    if (score <= 20) return 'poor';
    if (score <= 45) return 'fair';
    if (score <= 70) return 'good';
    return 'excellent';
  };

  // ── Condition adjustment (1-100 continuous scale) ──
  // A lower-condition subject has MORE upside from renovation than a higher-condition comp.
  // Both scores on 1-100 scale. We compute "room to improve" ratio.
  // Score 100 = perfect/no room. Room = (100 - score).
  // Factor = subjectRoom / compRoom, clamped [0.5, 2.0].
  // Example: subject=25 (poor), comp=50 (fair) → room 75/50 = 1.5× uplift
  //          subject=70 (good), comp=30 (poor) → room 30/70 = 0.43 → clamped 0.5×
  const conditionAdjustment = (subjectScore: number | null, compScore: number | null): number => {
    if (subjectScore == null || compScore == null) return 1.0;
    const subjectRoom = 100 - subjectScore; // how much room to improve
    const compRoom = 100 - compScore;
    if (compRoom <= 5) return subjectRoom > 10 ? 0.75 : 1.0; // comp was already near-perfect
    if (subjectRoom <= 0) return 0.5; // subject already perfect, minimal uplift expected
    const factor = subjectRoom / compRoom;
    return Math.max(0.5, Math.min(2.0, factor));
  };

  // ── Size adjustment ──
  // Scale comp uplift by room size ratio when DAv3 measured, or dampened house-size ratio as proxy.
  // Returns multiplier [0.5, 2.0].
  const sizeAdjustment = (subjectSqft?: number, compSqft?: number, subjectRoomSqft?: number): number => {
    // If we have room-level measurements, use those for a tighter adjustment
    // (room-level comp data isn't available per-comp, so we use house ratio as proxy with dampening)
    if (!subjectSqft || !compSqft || subjectSqft <= 0 || compSqft <= 0) return 1.0;
    const ratio = subjectSqft / compSqft;
    // Dampen: sqrt brings 2.0 → 1.41, 0.5 → 0.71. Renovation uplift doesn't scale linearly with house size.
    const dampened = ratio > 1 ? Math.sqrt(ratio) : 1 / Math.sqrt(1 / ratio);
    return Math.max(0.5, Math.min(2.0, dampened));
  };

  // ── Material tier adjustment ──
  // Comp uplift reflects the materials THEY used. If the subject plans different materials,
  // the expected uplift should scale accordingly.
  // Numeric tier: budget=1, mid_grade=2, high_end=3, luxury=4.
  // E.g. comp used luxury marble (4) → $30k uplift. Subject plans mid_grade LVP (2).
  // Ratio = 2/4 = 0.5 → subject should expect ~$15k uplift from that comp data point.
  // Dampened with sqrt so the effect isn't too extreme.
  const MATERIAL_TIER_SCORE: Record<string, number> = {
    budget: 1, mid_grade: 2, high_end: 3, luxury: 4,
  };
  const materialTierAdjustment = (
    subjectMaterialTier: string | null | undefined,
    compMaterialTier: string | null | undefined,
  ): number => {
    if (!subjectMaterialTier || !compMaterialTier) return 1.0;
    const subScore = MATERIAL_TIER_SCORE[subjectMaterialTier] ?? null;
    const compScore = MATERIAL_TIER_SCORE[compMaterialTier] ?? null;
    if (subScore == null || compScore == null) return 1.0;
    if (compScore === 0) return 1.0; // shouldn't happen, but guard
    const ratio = subScore / compScore;
    // Dampen: sqrt(0.5)=0.71, sqrt(2.0)=1.41. Prevents over-scaling.
    const dampened = ratio > 1 ? Math.sqrt(ratio) : 1 / Math.sqrt(1 / ratio);
    return Math.max(0.5, Math.min(2.0, dampened));
  };

  // ── Property type proximity ──
  // Groups property types by renovation economics similarity.
  // SFH ↔ Townhouse are close (similar reno costs & uplifts).
  // Condo is different (HOA constraints, shared walls, lower exterior scope).
  // Multi-family is most different (commercial reno economics).
  const PROPERTY_TYPE_GROUP: Record<string, number> = {
    sfh: 1, singlefamily: 1, 'single family': 1, house: 1,
    townhouse: 2, townhome: 2, rowhome: 2,
    condo: 3, condominium: 3, coop: 3,
    multifamily: 4, 'multi family': 4, duplex: 4, triplex: 4, apartment: 4,
  };
  const normalizePropertyType = (t: string | undefined | null): number =>
    PROPERTY_TYPE_GROUP[(t || '').toLowerCase().replace(/[_\-]/g, '')] ?? 1;

  // Returns weight multiplier [0.3, 1.0]. Same group = 1.0, adjacent = 0.7, far = 0.4
  const propertyTypeProximity = (
    subjectType: string | undefined | null,
    compType: string | undefined | null,
  ): number => {
    if (!subjectType || !compType) return 0.8; // unknown → slight penalty
    const sg = normalizePropertyType(subjectType);
    const cg = normalizePropertyType(compType);
    const diff = Math.abs(sg - cg);
    if (diff === 0) return 1.0;   // same group
    if (diff === 1) return 0.7;   // adjacent (SFH↔Townhouse or Townhouse↔Condo)
    return 0.4;                   // far apart (SFH↔Condo, anything↔Multi)
  };

  // ── Condition cost multiplier ──
  // A property in worse condition than the comp will need MORE renovation work
  // (greater scope, more demolition, structural surprises) so cost should scale up.
  // This is separate from the VALUE uplift adjustment (conditionAdjustment).
  // Returns multiplier [0.7, 1.8]. Worse condition → higher cost.
  const conditionCostMultiplier = (subjectScore: number | null, compScore: number | null): number => {
    if (subjectScore == null || compScore == null) return 1.0;
    // Lower score = worse condition = more work needed
    const subjectRoom = 100 - subjectScore; // how much room to improve
    const compRoom = 100 - compScore;
    if (compRoom <= 5) return subjectRoom > 30 ? 1.4 : 1.0; // comp near-perfect, subject rough → more costly
    // Base ratio: subject needs more work → costs scale up
    // Use 0.6 dampening (between sqrt=0.5 and linear=1.0) — costs DO scale
    // more than sqrt but not linearly (bulk discounts, overlapping trades)
    const ratio = subjectRoom / compRoom;
    const dampened = Math.pow(ratio, 0.6);
    return Math.max(0.7, Math.min(1.8, dampened));
  };

  // ── Year-built proximity ──
  // Comps built in a similar era share construction methods, code requirements,
  // and buyer expectations. Gaussian decay with ~25yr half-life.
  // Same decade = 1.0, 25yr apart ≈ 0.5, 50yr apart ≈ 0.06.
  const yearBuiltProximity = (
    subjectYear: number | undefined | null,
    compYear: number | undefined | null,
  ): number => {
    if (!subjectYear || !compYear || subjectYear <= 0 || compYear <= 0) return 0.7; // unknown → mild penalty
    const diff = Math.abs(subjectYear - compYear);
    // Gaussian: exp(-diff²/(2·σ²)), σ=25 → half-life ≈ 25 years
    return Math.exp(-(diff * diff) / (2 * 25 * 25));
  };

  // ── Absolute condition uplift potential ──
  // Separate from the relative condition adjustment (subject vs comp).
  // This captures the "headroom" effect: a room at 15/100 has enormous
  // transformation potential — buyers see a dramatic before→after jump.
  // A room at 80/100 has marginal improvement potential.
  //
  // Returns multiplier [0.65, 1.50]:
  //   score ≤ 15 → 1.50  (terrible → wow factor, huge buyer perceived uplift)
  //   score = 30 → 1.25
  //   score = 50 → 1.00  (baseline — average condition, average uplift)
  //   score = 70 → 0.80
  //   score ≥ 85 → 0.65  (already nice, marginal improvement)
  const conditionUpliftPotential = (subjectCondScore: number | null): number => {
    if (subjectCondScore == null) return 1.0; // unknown → no adjustment
    // Linear interpolation: score 0 → 1.50, score 50 → 1.00, score 100 → 0.65
    // Using two segments for slight asymmetry (poor condition bonus is bigger
    // than good condition penalty, matching market data).
    if (subjectCondScore <= 50) {
      // 0 → 1.50,  50 → 1.00  (slope = -0.01/pt)
      return 1.50 - (subjectCondScore / 50) * 0.50;
    }
    // 50 → 1.00,  100 → 0.65  (slope = -0.007/pt)
    return 1.00 - ((subjectCondScore - 50) / 50) * 0.35;
  };

  // ══════════════════════════════════════════════════════════════════
  // MARKET HEAT — continuous score derived from appreciation, DOM, FRED supply
  // Score 0-100: 0=very cold, 50=neutral, 100=very hot
  // ══════════════════════════════════════════════════════════════════

  const computeMarketHeatScore = (
    appreciationRate: number,    // annualized YoY % (e.g. 5.2)
    avgDOM: number,              // average days-on-market
    avgSaleToListPct: number,    // e.g. 98.5
    monthsOfSupply: number | null, // FRED MSACSR
  ): { heatScore: number; heatLabel: string } => {
    // Each signal contributes 0-100, then we blend them
    // Appreciation signal: 0% → 25, 3% → 40, 5% → 55, 8% → 70, 12%+ → 90
    const appreciationSignal = Math.max(0, Math.min(100,
      25 + (appreciationRate / 12) * 65
    ));

    // DOM signal: >90 days → cold (20), 60 → 35, 30 → 60, 14 → 80, ≤7 → 95
    const domSignal = avgDOM > 0 ? Math.max(0, Math.min(100,
      100 - (avgDOM / 90) * 80
    )) : 50;

    // Sale-to-list signal: <95% → cold (20), 97% → 40, 100% → 65, 103%+ → 90
    const saleToListSignal = Math.max(0, Math.min(100,
      (avgSaleToListPct - 90) * 6.5
    ));

    // Months-of-supply signal (if available): >8 → cold (15), 6 → 35, 4 → 55, 2 → 80, <1 → 95
    let supplySignal = 50; // default neutral if no FRED data
    if (monthsOfSupply != null && monthsOfSupply > 0) {
      supplySignal = Math.max(0, Math.min(100,
        100 - (monthsOfSupply / 8) * 85
      ));
    }

    // Weighted blend: appreciation 35%, DOM 25%, sale-to-list 25%, supply 15%
    const hasSupply = monthsOfSupply != null;
    const heatScore = hasSupply
      ? appreciationSignal * 0.35 + domSignal * 0.25 + saleToListSignal * 0.25 + supplySignal * 0.15
      : appreciationSignal * 0.40 + domSignal * 0.30 + saleToListSignal * 0.30;

    const rounded = Math.round(Math.max(0, Math.min(100, heatScore)));
    const heatLabel = rounded <= 20 ? 'cold' : rounded <= 35 ? 'cool' : rounded <= 60 ? 'neutral' : rounded <= 80 ? 'warm' : 'hot';
    return { heatScore: rounded, heatLabel };
  };

  // Market heat → equity uplift multiplier (continuous, not bracketed)
  // Hot market (score 80): equity 1.10-1.12×, Cold market (score 20): equity 0.88-0.92×
  // The multiplier smoothly interpolates around 1.0 at score=50.
  const marketHeatEquityMultiplier = (heatScore: number): number => {
    // Linear interpolation: score 0 → 0.85, score 50 → 1.0, score 100 → 1.15
    return 0.85 + (heatScore / 100) * 0.30;
  };

  // Market heat → rent uplift multiplier (dampened — rent responds less to market heat)
  // Hot market: demand overflow → wider renovation rent spread (1.05-1.08×)
  // Cold market: still captures rent premium from quality gap (0.95-0.97×)
  const marketHeatRentMultiplier = (heatScore: number): number => {
    // Dampened: score 0 → 0.93, score 50 → 1.0, score 100 → 1.08
    return 0.93 + (heatScore / 100) * 0.15;
  };

  // ══════════════════════════════════════════════════════════════════
  // SEASONAL TIMING — curb appeal renovations have seasonal ROI variation
  // ══════════════════════════════════════════════════════════════════

  const EXTERIOR_RENOVATION_TYPES = new Set([
    'landscaping', 'deck patio', 'deck', 'patio', 'siding', 'exterior paint',
    'paint exterior', 'roof', 'fence', 'driveway', 'pool', 'exterior',
    'curb appeal', 'outdoor living', 'garage'
  ]);

  // Returns a multiplier for seasonal timing effect on renovation ROI
  // Spring/summer exterior renos sell ~15-25% better; fall/winter ~10-20% worse
  // Interior renos are season-neutral
  const seasonalTimingMultiplier = (renovationType: string, month?: number): number => {
    const renoType = normalizeRenoType(renovationType);
    if (!EXTERIOR_RENOVATION_TYPES.has(renoType)) return 1.0; // interior = no seasonal effect

    const m = month ?? new Date().getMonth(); // 0=Jan, 11=Dec
    // Sinusoidal model peaking in June (month 5), trough in December (month 11)
    // Amplitude: ±0.18 (max +18% in peak summer, -18% in deep winter)
    const seasonalFactor = Math.cos((m - 5) * Math.PI / 6) * 0.18;
    return 1.0 + seasonalFactor;
  };

  // ══════════════════════════════════════════════════════════════════
  // STRATIFICATION TIER LOOKUP — match subject to proper comp tier
  // ══════════════════════════════════════════════════════════════════

  const getPriceTier = (price: number): string => {
    if (price < 200000) return 'under_200k';
    if (price < 350000) return '200k_350k';
    if (price < 500000) return '350k_500k';
    if (price < 750000) return '500k_750k';
    if (price < 1000000) return '750k_1m';
    return 'over_1m';
  };

  const getYearBuiltBracket = (yearBuilt: number): string => {
    if (yearBuilt < 1950) return 'pre_1950';
    if (yearBuilt < 1970) return '1950_1970';
    if (yearBuilt < 1990) return '1970_1990';
    if (yearBuilt < 2005) return '1990_2005';
    if (yearBuilt < 2015) return '2005_2015';
    return 'post_2015';
  };

  // Infer material tier from quality levels detected in photos + property value context
  // Returns 'budget' | 'mid' | 'high' | 'luxury' | null
  const inferMaterialTier = (
    qualityLevels: string[],
    propertyValue?: number,
  ): string | null => {
    // Score quality keywords: budget=1, mid=2, high=3, luxury=4
    const qualityScoreMap: Record<string, number> = {
      budget: 1, basic: 1, builder: 1, 'builder-grade': 1, economy: 1, standard: 1.5,
      mid: 2, 'mid-range': 2, moderate: 2, average: 2,
      high: 3, 'high-end': 3, premium: 3, upscale: 3, quality: 3,
      luxury: 4, custom: 4, designer: 4, 'ultra-luxury': 4,
    };
    const scores = qualityLevels
      .map(q => qualityScoreMap[(q || '').toLowerCase().trim()] ?? null)
      .filter((s): s is number => s !== null);

    let avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    // Property value as secondary signal (nudges tier estimate)
    if (propertyValue && avgScore === 0) {
      // No quality info from photos — infer from property value
      if (propertyValue < 200000) avgScore = 1.3;
      else if (propertyValue < 400000) avgScore = 2.0;
      else if (propertyValue < 700000) avgScore = 2.8;
      else avgScore = 3.5;
    } else if (propertyValue && avgScore > 0) {
      // Blend photo quality with value signal (80% photo, 20% value)
      let valueSignal = 2.0;
      if (propertyValue < 200000) valueSignal = 1.3;
      else if (propertyValue < 400000) valueSignal = 2.0;
      else if (propertyValue < 700000) valueSignal = 2.8;
      else valueSignal = 3.5;
      avgScore = avgScore * 0.8 + valueSignal * 0.2;
    }

    if (avgScore <= 0) return null;
    if (avgScore < 1.5) return 'budget';
    if (avgScore < 2.5) return 'mid';
    if (avgScore < 3.5) return 'high';
    return 'luxury';
  };

  // Look up tier-specific ROI data from area summary stratification
  // Returns { weightedAvgROI, weightedAvgUplift, avgCost, sampleSize } or null
  const lookupStratificationTier = (
    renoType: string,
    areaSummaryData: any,
    subjectPrice?: number,
    subjectYearBuilt?: number,
    subjectConditionScore?: number | null,
    subjectMaterialTier?: string | null,
  ): { roi: number; uplift: number; cost: number; sampleSize: number; tierSource: string } | null => {
    if (!areaSummaryData?.bestROIRenovations) return null;
    const normType = normalizeRenoType(renoType);
    const reno = areaSummaryData.bestROIRenovations.find(
      (r: any) => normalizeRenoType(r.renovationType) === normType
    );
    if (!reno) return null;

    // Try increasingly specific stratification tiers, fall back to less specific
    // Priority: priceTier > yearBuilt > beforeCondition > aggregate
    const tryTier = (stratMap: any, key: string, label: string) => {
      if (!stratMap || !stratMap[key]) return null;
      const tier = stratMap[key];
      if (!tier || tier.sampleSize < 2) return null;
      return {
        roi: tier.weightedAvgROI ?? tier.avgROI ?? 0,
        uplift: tier.weightedAvgUplift ?? tier.avgUplift ?? 0,
        cost: tier.avgCost ?? 0,
        sampleSize: tier.sampleSize,
        tierSource: label,
      };
    };

    // Try price tier first (most predictive for renovation ROI)
    if (subjectPrice) {
      const tier = getPriceTier(subjectPrice);
      const result = tryTier(reno.byPriceTier, tier, `price-tier:${tier}`);
      if (result) return result;
    }

    // Try year-built bracket
    if (subjectYearBuilt) {
      const bracket = getYearBuiltBracket(subjectYearBuilt);
      const result = tryTier(reno.byYearBuilt, bracket, `year-built:${bracket}`);
      if (result) return result;
    }

    // Try condition bracket
    if (subjectConditionScore != null) {
      const label = scoreToConditionLabel(subjectConditionScore);
      const result = tryTier(reno.byBeforeCondition, label, `condition:${label}`);
      if (result) return result;
    }

    // Try material tier (budget/mid/high/luxury — from DAv3 photo analysis)
    if (subjectMaterialTier) {
      const result = tryTier(reno.byMaterialTier, subjectMaterialTier, `material:${subjectMaterialTier}`);
      if (result) return result;
    }

    return null;
  };

  // ══════════════════════════════════════════════════════════════════
  // ADJUSTMENT METADATA — tracks what adjustments were applied per reco
  // ══════════════════════════════════════════════════════════════════

  interface AdjustmentMeta {
    conditionAdj: number;        // condition multiplier applied
    sizeAdj: number;             // size multiplier applied
    upliftPotentialAdj: number;  // absolute condition headroom multiplier
    marketHeatAdj: number;       // market heat equity multiplier
    marketHeatRentAdj: number;   // market heat rent multiplier
    seasonalAdj: number;         // seasonal timing multiplier
    stratTierSource: string | null; // which stratification tier was used
    heatScore: number | null;    // market heat score 0-100
    heatLabel: string | null;    // hot/warm/neutral/cool/cold
  }

  const defaultAdjustments = (): AdjustmentMeta => ({
    conditionAdj: 1.0, sizeAdj: 1.0, upliftPotentialAdj: 1.0, marketHeatAdj: 1.0,
    marketHeatRentAdj: 1.0, seasonalAdj: 1.0,
    stratTierSource: null, heatScore: null, heatLabel: null,
  });

  const clampMultiplier = (value: number, min: number, max: number): number => {
    return Math.max(min, Math.min(max, value));
  };

  const buildFilteredComparableStats = (
    renovationType: string,
    comps: ComparableProperty[],
    subjectSqft?: number,
    subjectConditionScore?: number | null, // 1-100 score
    subjectRoomSqft?: number, // DAv3-measured room size if available
    subjectMaterialTier?: string | null, // budget/mid_grade/high_end/luxury from DAv3+Vision
    subjectPropertyType?: string | null, // SFH/Townhouse/Condo/Multi
    subjectYearBuilt?: number | null, // year built for era-proximity weighting
  ) => {
    const candidates = mapRegionalTypeToCandidates(renovationType).map(normalizeRenoType);
    const points: Array<{ valueAdd: number; rentIncrease: number | null; weight: number; compAreaSqFt: number }> = [];
    const renoCategory = normalizeRenoType(renovationType);

    // Map renovation categories to beforeCondition area keys
    // Keys use normalized form (spaces) to match normalizeRenoType output
    const categoryToConditionKey: Record<string, string> = {
      'kitchen': 'kitchen', 'kitchen full': 'kitchen', 'kitchen cosmetic': 'kitchen',
      'bathroom': 'bathrooms', 'bathroom master': 'bathrooms', 'bathroom secondary': 'bathrooms',
      'bathroom full': 'bathrooms', 'bathroom cosmetic': 'bathrooms',
      'flooring': 'flooring', 'paint interior': 'flooring', 'paint exterior': 'exterior',
      'siding': 'exterior', 'roof': 'exterior', 'windows': 'exterior', 'doors': 'exterior',
      'landscaping': 'exterior', 'deck patio': 'exterior',
      'hvac': 'systems', 'plumbing': 'systems', 'electrical': 'systems',
      'basement': 'overall', 'other': 'overall',
    };
    const conditionKey = categoryToConditionKey[renoCategory] || 'overall';

    // ── Hard property type exclusion with fallback ──
    // Exclude comps where property type proximity < 0.5 (e.g. SFH↔Multi, Condo↔Multi)
    // UNLESS that would drop us below 3 data points, in which case fall back to soft weighting.
    const MIN_HARD_FILTER_COMPS = 3;
    const hardFilteredComps = (comps || []).filter(c => propertyTypeProximity(subjectPropertyType, c.propertyType) >= 0.5);
    const useHardFilter = hardFilteredComps.length >= MIN_HARD_FILTER_COMPS;
    const effectiveComps = useHardFilter ? hardFilteredComps : (comps || []);

    for (const comp of effectiveComps) {
      // Property type proximity weight — same type gets full weight, different types penalized
      const ptProx = propertyTypeProximity(subjectPropertyType, comp.propertyType);

      // Year-built proximity — same era comps are more relevant
      const ybProx = yearBuiltProximity(subjectYearBuilt, comp.yearBuilt);

      // Size: compute adjustment factor instead of filtering
      const szAdj = sizeAdjustment(subjectSqft, comp.sqft, subjectRoomSqft);

      const renos = comp.renovations || [];
      for (const reno of renos) {
        const cat = normalizeRenoType(reno.category || '');
        const match = candidates.some(c => cat.includes(c) || c.includes(cat));
        if (!match) continue;

        // Condition: use numeric beforeCondition score (1-10 scale from GPT-4o photo analysis)
        // when available, otherwise fall back to text-based inference
        const compBeforeConditionRaw = (comp as any).beforeCondition;
        let compCondScore: number | null = null;
        if (compBeforeConditionRaw && typeof compBeforeConditionRaw === 'object') {
          // Per-area score (1-10) — use the area-specific score for this reno category
          const areaScore = compBeforeConditionRaw[conditionKey] ?? compBeforeConditionRaw.overall;
          compCondScore = conditionToScore100(areaScore);
        }
        if (compCondScore == null) {
          // Fall back to text inference from GPT-4o descriptions
          compCondScore = inferConditionScore(reno.beforeDescription, reno.description);
        }

        const condAdj = conditionAdjustment(subjectConditionScore ?? null, compCondScore);

        // Material tier: comp's qualityLevel or dominant material tier for this renovation
        const compMatTier = reno.qualityLevel || reno.materials?.[0]?.materialTier || null;
        const matAdj = materialTierAdjustment(subjectMaterialTier, compMatTier);

        const rawValueAdd = Number(reno.allocatedUplift || 0);
        // Comp costs removed — they were fabricated by estimateCostForCategory.
        // Real cost estimation is done on the subject property only.

        // Apply adjustments: value scales with size, condition, material tier,
        // AND absolute condition uplift potential (headroom effect).
        //
        // ADDITIVE BLENDING (appraisal-style): instead of multiplying factors
        // (which compounds quickly: 1.3×1.2×1.0×1.25=1.95), we sum their
        // deviations from 1.0 and dampen the total. This is how real appraisers
        // work — they add/subtract adjustments, preventing runaway compounding.
        //
        //   deviation = (condAdj-1) + (szAdj-1) + (matAdj-1) + (upliftPot-1)
        //   combined  = 1.0 + deviation × dampening
        //
        // Dampening of 0.65 means: if raw sum of deviations = +0.80 (all factors up),
        // effective multiplier = 1.0 + 0.80×0.65 = 1.52 (vs 1.95 multiplicative).
        const upliftPotential = conditionUpliftPotential(subjectConditionScore ?? null);
        const deviationSum = (condAdj - 1) + (szAdj - 1) + (matAdj - 1) + (upliftPotential - 1);
        const ADJUSTMENT_DAMPENING = 0.65;
        const combinedValueAdj = clampMultiplier(1.0 + deviationSum * ADJUSTMENT_DAMPENING, 0.5, 1.8);

        const valueAdd = rawValueAdd * combinedValueAdj;

        let rentIncrease: number | null = null;
        const compRentIncrease = Number(comp.rentAnalysis?.rentIncrease || 0);
        const compTotalUplift = Number(comp.renovationAttributedUplift || 0);
        if (compRentIncrease > 0 && compTotalUplift > 0 && rawValueAdd > 0) {
          const share = Math.min(1, Math.max(0, rawValueAdd / compTotalUplift));
          rentIncrease = compRentIncrease * share * condAdj;
        }

        // Weight: comps closer in size, condition, material tier, property type, AND era are more reliable
        const sizeProximity = subjectSqft && comp.sqft ? 1 - Math.abs(subjectSqft - comp.sqft) / Math.max(subjectSqft, comp.sqft) : 0.5;
        const condProximity = (subjectConditionScore != null && compCondScore != null)
          ? 1 - Math.abs(subjectConditionScore - compCondScore) / 100  // continuous proximity 0-1
          : 0.5;
        const matProximity = (subjectMaterialTier && compMatTier)
          ? 1 - Math.abs((MATERIAL_TIER_SCORE[subjectMaterialTier] ?? 2) - (MATERIAL_TIER_SCORE[compMatTier] ?? 2)) / 4
          : 0.5;
        const weight = sizeProximity * condProximity * matProximity * ptProx * ybProx;

        const compAreaSqFt = Number(reno.estimatedAreaSqFt || 0);
        points.push({ valueAdd, rentIncrease, weight, compAreaSqFt });
      }
    }

    if (points.length === 0) {
      return {
        sampleSize: 0,
        avgValueAdd: null as number | null,
        avgCost: null as number | null,
        avgRentIncrease: null as number | null,
        adjustmentApplied: false,
        adjustments: defaultAdjustments(),
      };
    }

    // ── IQR outlier filtering on adjusted value uplift ──
    // Prevents a single comp with an extreme value from skewing the weighted average.
    // Uses the same 2× IQR approach as the backend areaAggregator.
    let filteredPoints = points;
    if (points.length >= 4) {
      const sortedVals = [...points].map(p => p.valueAdd).sort((a, b) => a - b);
      const q1 = sortedVals[Math.floor(sortedVals.length * 0.25)];
      const q3 = sortedVals[Math.floor(sortedVals.length * 0.75)];
      const iqr = q3 - q1;
      if (iqr > 0) {
        const iqrLow = q1 - 2.0 * iqr;
        const iqrHigh = q3 + 2.0 * iqr;
        const beforeLen = filteredPoints.length;
        filteredPoints = filteredPoints.filter(p => p.valueAdd >= iqrLow && p.valueAdd <= iqrHigh);
        if (filteredPoints.length < beforeLen) {
          console.log(`[CompStats] IQR filtered ${beforeLen - filteredPoints.length} outlier(s) for ${renovationType} (range [${Math.round(iqrLow)}, ${Math.round(iqrHigh)}])`);
        }
        // Don't filter below 2 data points
        if (filteredPoints.length < 2) filteredPoints = points;
      }
    }

    // Weighted average: closer comps count more
    const totalWeight = filteredPoints.reduce((s, p) => s + p.weight, 0);
    const wavg = (getter: (p: typeof filteredPoints[0]) => number | null) => {
      const valid = filteredPoints.filter(p => {
        const v = getter(p);
        return typeof v === 'number' && v > 0;
      });
      if (valid.length === 0) return null;
      const wSum = valid.reduce((s, p) => s + (getter(p) as number) * p.weight, 0);
      const wTotal = valid.reduce((s, p) => s + p.weight, 0);
      return wTotal > 0 ? wSum / wTotal : null;
    };

    // Base comp-weighted averages
    let valueAdd = wavg(p => p.valueAdd);
    let rentIncrease = wavg(p => p.rentIncrease);

    // Apply market heat and seasonal multipliers on top of comp adjustments
    const heatScore = marketContext?.heatScore ?? 50;
    const heatLabel = marketContext?.heatLabel ?? 'neutral';
    const mhEquity = marketHeatEquityMultiplier(heatScore);
    const mhRent = marketHeatRentMultiplier(heatScore);
    const seasonal = seasonalTimingMultiplier(renovationType);

    if (valueAdd != null) valueAdd = valueAdd * mhEquity * seasonal;
    if (rentIncrease != null) rentIncrease = rentIncrease * mhRent;

    // ── Category-aware uplift sanity ──
    // Even after IQR filtering and additive adjustments, the weighted average
    // can be unrealistically high if the underlying comp data was skewed
    // (e.g., proportional allocation gave paint $60K uplift on a $200K property).
    // These caps match industry data (NAR Cost vs. Value 2024-2025).
    // Scaled to property value when available (via closure over `propertyValue`
    // from the outer scope — set in the pipeline).
    if (valueAdd != null) {
      const CATEGORY_MAX_UPLIFT: Record<string, number> = {
        'kitchen': 65000, 'kitchen full': 80000, 'kitchen cosmetic': 35000,
        'bathroom master': 40000, 'bathroom secondary': 25000, 'bathroom full': 40000, 'bathroom cosmetic': 18000,
        'basement': 50000, 'addition': 90000,
        'flooring': 25000, 'windows': 18000, 'roof': 18000, 'siding': 18000,
        'deck patio': 20000, 'garage': 18000,
        'paint interior': 15000, 'paint exterior': 18000,
        'landscaping': 18000, 'hvac': 12000, 'smart home': 8000,
        'electrical': 10000, 'plumbing': 10000, 'doors': 8000,
      };
      const cat = normalizeRenoType(renovationType);
      const baseCap = CATEGORY_MAX_UPLIFT[cat] ?? 40000;
      if (valueAdd > baseCap) {
        console.log(`[CompStats] Uplift sanity: ${cat} $${Math.round(valueAdd)} exceeds cap $${baseCap} → clamped`);
        valueAdd = baseCap;
      }
    }

    const adjustments: AdjustmentMeta = {
      conditionAdj: filteredPoints.length > 0 ? conditionAdjustment(subjectConditionScore ?? null, null) : 1.0,
      sizeAdj: filteredPoints.length > 0 ? sizeAdjustment(subjectSqft, undefined) : 1.0,
      upliftPotentialAdj: conditionUpliftPotential(subjectConditionScore ?? null),
      marketHeatAdj: mhEquity,
      marketHeatRentAdj: mhRent,
      seasonalAdj: seasonal,
      stratTierSource: null, // set at card-level when stratification is used
      heatScore,
      heatLabel,
    };

    return {
      sampleSize: filteredPoints.length,
      avgValueAdd: valueAdd,
      avgCost: null, // Removed: comp costs were fabricated, real cost comes from subject property estimation
      avgRentIncrease: rentIncrease,
      avgCompAreaSqFt: wavg(p => p.compAreaSqFt),
      adjustmentApplied: true,
      adjustments,
    };
  };

  const buildSubjectSpecificRegionalROIs = (
    baseRois: RegionalROI[],
    comps: ComparableProperty[],
    subjectSqft?: number,
    subjectConditionScore?: number | null,
    subjectMaterialTier?: string | null,
    subjectPropertyType?: string | null,
    subjectYearBuilt?: number | null,
  ): RegionalROI[] => {
    const rows = (baseRois || []).map((r) => {
      const stats = buildFilteredComparableStats(r.renovationType, comps, subjectSqft, subjectConditionScore, undefined, subjectMaterialTier, subjectPropertyType, subjectYearBuilt);

      // Use adjusted comp stats when available, fall back to area-level bestRenos data
      // Note: avgCost is null here — comp costs were removed (fabricated data).
      // Real cost is determined per-recommendation from measurements/templates.
      const avgValueUplift = stats.avgValueAdd ?? r.avgValueUplift ?? 0;
      const avgRentIncrease = stats.avgRentIncrease ?? r.avgRentIncrease ?? 0;
      const sampleSize = stats.sampleSize || r.sampleSize || 0;

      // Require minimum 3 comps for a recommendation — fewer is unreliable
      if (sampleSize < 3) return null;

      // Only skip if there's truly no uplift data at all
      if (avgValueUplift <= 0) return null;

      return {
        ...r,
        sampleSize,
        avgCost: 0, // Will be filled in per-recommendation from subject property cost estimation
        avgValueUplift: Math.round(avgValueUplift),
        avgRentIncrease: Math.round(avgRentIncrease || 0),
        avgROI: 0, // Placeholder — real ROI computed per-recommendation with real cost
      };
    }).filter(Boolean) as RegionalROI[];

    rows.sort((a, b) => (b.avgValueUplift || 0) - (a.avgValueUplift || 0));
    return rows;
  };

  const getRentalByType = (rentalByType: Record<string, any>, renoType: string) => {
    if (!rentalByType || !renoType) return null;
    const target = normalizeRenoType(renoType);
    const direct = rentalByType[renoType];
    if (direct) return direct;

    const entries = Object.entries(rentalByType);
    const exactNormalized = entries.find(([k]) => normalizeRenoType(k) === target)?.[1];
    if (exactNormalized) return exactNormalized;

    const loose = entries.find(([k]) => {
      const nk = normalizeRenoType(k);
      return nk.includes(target) || target.includes(nk);
    })?.[1];
    return loose || null;
  };

  const extractZip = (addr: string): string => {
    // Match ZIP after state abbreviation (e.g., "MD 20906" or "VA 20191")
    // Must be 5 digits to be a valid ZIP — avoids 4-digit typos like "VA 2019"
    const stateZip = addr.match(/[A-Z]{2}\s+(\d{5})(?:-\d{4})?/i);
    if (stateZip) return stateZip[1];
    // Fallback: last 5-digit number that is NOT the first token (street number)
    const allFives = addr.match(/\d{5}/g);
    if (allFives && allFives.length > 0) {
      // Filter out matches that appear at the very start of the address (street numbers)
      const streetNumMatch = addr.match(/^\s*(\d+)/);
      const streetNum = streetNumMatch ? streetNumMatch[1] : '';
      const filtered = allFives.filter(z => z !== streetNum);
      if (filtered.length > 0) return filtered[filtered.length - 1];
      // If only match IS the street number, don't return it as a ZIP
      // — it's almost certainly not a ZIP code
    }
    return '';
  };

  // ─────────── main pipeline ───────────

  const runPipeline = async () => {
    if (!address.trim()) return;
    abortRef.current = false;
    setRunning(true);
    setError(null);
    setProperty(null);
    setMlsListing(null);
    setAllPhotos([]);
    setDetectedRenovations([]);
    setDetectedOverallCondition(null);
    setDetectedConditionScore(null);
    setRegionalROIs([]);
    setRegionalROIsFilteredForSubject(false);
    setAreaSummary(null);
    setProcessingResult(null);
    setCombinedAnalysis(null);
    setMeasurementSuggestions([]);
    setAreaComparables([]);

    // LOCAL variables for cross-step data flow within this async function.
    // React state (setX) is for rendering, but state updates don't take effect
    // until the next render. Within a single async run we must use locals.
    let localDetectedRenovations: DetectedRenovation[] = [];
    let localDetectedConditionScore: number | null = null;
    let localAllPhotos: string[] = [];

    const pipeline: PipelineStep[] = [
      { id: 'attom',    label: '1. Fetch ATTOM Property Data',          status: 'pending' },
      { id: 'mls',      label: '2. Fetch Zillow Listing + Photos',     status: 'pending' },
      { id: 'detect',   label: '3. AI Renovation Detection (GPT-4o)',  status: 'pending' },
      { id: 'process',  label: '4. Regional Uplift Processing',        status: 'pending' },
      { id: 'summary',  label: '5. Fetch Area Summary',                status: 'pending' },
      { id: 'combine',  label: '6. Build Combined Analysis',           status: 'pending' },
    ];
    setSteps(pipeline);

    try {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STEP 1 — ATTOM
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const t1 = Date.now();
      updateStep('attom', { status: 'running' });
      const attomRes = await fetch(`/api/attom/dashboard?address=${encodeURIComponent(address)}&skipCache=1`);
      const attomJson = await attomRes.json();
      if (!attomJson.ok) throw new Error(attomJson.error || 'ATTOM fetch failed');

      // ATTOM returns { ok, data: { summary, tax_history, ... } }
      const dashboard = attomJson.data || attomJson;
      const s = dashboard.summary || {};
      // Prefer ATTOM's canonical ZIP over regex extraction from user-typed address
      const zipCode = s.zip || extractZip(address) || '';
      // Parse city/state from the address string if ATTOM doesn't provide them
      const addressParts = address.split(',').map((p: string) => p.trim());
      const stateZipPart = addressParts.length >= 3 ? addressParts[addressParts.length - 1] : '';
      const parsedCity = addressParts.length >= 2 ? addressParts[addressParts.length - 2] : '';
      const parsedState = stateZipPart.replace(/\d+/g, '').trim();
      const prop: PropertyData = {
        address,
        attomId: s.attom_id,
        beds: s.beds || 0,
        baths: s.baths || 0,
        sqft: s.living_sqft || s.sqft || 0,
        yearBuilt: s.year_built || 0,
        propertyType: s.property_type || 'SFH',
        avm: s.avm_value,
        rentalAvm: s.rental_avm,
        lastSalePrice: s.last_sale_price,
        lastSaleDate: s.last_sale_date,
        taxAssessed: s.assessed_value,
        zipCode,
        city: s.city || parsedCity,
        state: s.state || parsedState,
      };
      setProperty(prop);
      updateStep('attom', { status: 'done', duration: Date.now() - t1, detail: `AVM: ${fmt(prop.avm)} | Rent: ${fmt(prop.rentalAvm)}/mo` });
      if (abortRef.current) return;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STEP 2 — Zillow Listing + Photos
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const t2 = Date.now();
      updateStep('mls', { status: 'running' });

      // Fetch property listing + photos via Zillow API (same endpoint, now backed by Zillow)
      let mlsJson: any = { ok: false, data: [] };
      try {
        const mlsRes = await fetch(`/api/snowflake/property-history/${encodeURIComponent(address)}?strictMatch=true&noCache=1`);
        if (mlsRes.ok) {
          mlsJson = await mlsRes.json();
        } else {
          console.warn('Zillow property-history returned', mlsRes.status);
        }
      } catch (e) {
        console.warn('Zillow property-history failed:', e);
      }

      let listing: MLSListing | null = null;
      let photos: string[] = [];

      // property-history returns { ok, data: [ { ...property, images: [...] }, ... ] }
      const properties = Array.isArray(mlsJson.data) ? mlsJson.data : [];

      if (mlsJson.ok && properties.length > 0) {
        // Take the most recent listing
        const p = properties[0];
        const listingPhotos = (p.images || [])
          .map((img: any) => img.MEDIAURL)
          .filter(Boolean);

        listing = {
          LISTINGKEY: p.LISTINGKEY,
          LISTPRICE: p.LISTPRICE || 0,
          CLOSEPRICE: p.CLOSEPRICE,
          STANDARDSTATUS: p.STANDARDSTATUS || 'Unknown',
          ONMARKETDATE: p.ONMARKETDATE,
          CLOSEDATE: p.CLOSEDATE,
          PHOTOSCOUNT: listingPhotos.length,
          photos: listingPhotos,
        };
        photos = listingPhotos;
      }

      // If first listing didn't have enough photos, collect from all listings
      if (photos.length < 5 && properties.length > 1) {
        const allImgUrls: string[] = properties
          .flatMap((prop: any) => (prop.images || []))
          .map((img: any) => img.MEDIAURL)
          .filter((url: any): url is string => !!url);
        if (allImgUrls.length > photos.length) {
          photos = [...new Set(allImgUrls)]; // deduplicate
        }
      }

      setMlsListing(listing);
      setAllPhotos(photos);
      localAllPhotos = photos;
      updateStep('mls', {
        status: 'done',
        duration: Date.now() - t2,
        detail: listing
          ? `${listing.STANDARDSTATUS} | ${listing.LISTPRICE ? `Zestimate: ${fmt(listing.LISTPRICE)}` : 'No price'} | ${photos.length} photos`
          : `No Zillow listing found — ${photos.length} photos`,
      });
      if (abortRef.current) return;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STEP 3 — AI Renovation Detection
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const t3 = Date.now();
      updateStep('detect', { status: 'running', detail: `Sending ${photos.length} photos to GPT-4o Vision…` });

      if (photos.length === 0) {
        updateStep('detect', { status: 'skipped', detail: 'No photos available' });
      } else {
        // Use the detect-needs endpoint — analyzes current property photos to identify
        // what renovations the property NEEDS (not comparing before/after)
        try {
          const detectRes = await fetch('/api/renovation-roi/detect-needs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              photos,
              propertyType: prop.propertyType,
              yearBuilt: prop.yearBuilt,
              sqft: prop.sqft,
              beds: prop.beds,
              baths: prop.baths,
              avm: prop.avm,
              zipCode: prop.zipCode,
              state: prop.state,
            }),
          });

          const detectJson = await detectRes.json();
          if (detectJson.ok && detectJson.renovations?.length > 0) {
            localDetectedRenovations = detectJson.renovations;
            localDetectedConditionScore = detectJson.conditionScore ?? conditionToScore100(detectJson.overallCondition) ?? null;
            setDetectedRenovations(detectJson.renovations);
            setDetectedOverallCondition(detectJson.overallCondition || null);
            setDetectedConditionScore(localDetectedConditionScore);
            updateStep('detect', {
              status: 'done',
              duration: Date.now() - t3,
              detail: `${detectJson.renovations.length} renovation opportunities detected`,
            });
          } else {
            localDetectedConditionScore = detectJson.conditionScore ?? conditionToScore100(detectJson.overallCondition) ?? null;
            setDetectedOverallCondition(detectJson.overallCondition || null);
            setDetectedConditionScore(localDetectedConditionScore);
            updateStep('detect', {
              status: 'done',
              duration: Date.now() - t3,
              detail: detectJson.error || 'Property appears well-maintained — no urgent renovations detected',
            });
          }
        } catch (e: any) {
          updateStep('detect', {
            status: 'error',
            duration: Date.now() - t3,
            detail: e.message || 'AI detection failed',
          });
        }
      }
      if (abortRef.current) return;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STEP 4 — Regional Uplift Processing
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const t4 = Date.now();
      updateStep('process', { status: 'running', detail: `Processing ZIP ${prop.zipCode}… (comparing before/after pairs from Zillow API)` });

      let processJson: any = { ok: false };
      try {
        const processRes = await fetch('/api/renovation-roi/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            zipCode: prop.zipCode,
            state: prop.state,
            subjectPropertyType: prop.propertyType || null,
            limit: 30,
            forceReprocess: true,
          }),
        });
        if (processRes.ok) {
          processJson = await processRes.json();
        } else {
          const errText = await processRes.text().catch(() => '');
          processJson = { ok: false, error: `Server returned ${processRes.status}: ${errText.slice(0, 200)}` };
        }
      } catch (e: any) {
        processJson = { ok: false, error: e.message || 'Network error' };
      }
      setProcessingResult(processJson);

      if (processJson.ok) {
        const totalComps = processJson.result?.totalComparables || 0;
        const renoTypes = processJson.result?.renovationTypesFound || 0;
        const newlyProcessed = processJson.result?.successful || 0;
        const pairsFound = processJson.result?.candidatePairsFound || 0;
        const rentalPairsLoaded = processJson.result?.rentalPairsLoaded || 0;
        const rentalMatchesUsed = processJson.result?.rentalMatchesUsed || 0;
        updateStep('process', {
          status: 'done',
          duration: Date.now() - t4,
          detail: `${totalComps} comps, ${renoTypes} renovation types${newlyProcessed > 0 ? ` (${newlyProcessed} new)` : ''}${pairsFound > 0 ? ` • ${pairsFound} candidate pairs found` : ''}${rentalPairsLoaded > 0 ? ` • ${rentalMatchesUsed}/${rentalPairsLoaded} rent matches` : ''}`,
        });
      } else {
        updateStep('process', {
          status: 'error',
          duration: Date.now() - t4,
          detail: processJson.error || 'Processing failed',
        });
      }
      if (abortRef.current) return;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STEP 5 — Fetch Area Summary (with real regional data)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const t5 = Date.now();
      updateStep('summary', { status: 'running' });

      let fetchedComparables: ComparableProperty[] = [];

      const summaryRes = await fetch(`/api/renovation-roi/area-summary/${prop.zipCode}?processIfMissing=true&maxAge=0`);
      const summaryJson = await summaryRes.json();

      if (summaryJson.ok && summaryJson.summary) {
        setAreaSummary(summaryJson.summary);
        const rois = summaryJson.summary.bestROIRenovations || [];
        let subjectSpecificRois: RegionalROI[] = [];

        // Fetch specific comparable properties used in analysis for context display
        try {
          const compLimit = Math.max(20, Math.min(50, Number(summaryJson.summary.totalComparables || 20)));
          const compsRes = await fetch(`/api/renovation-roi/area-comparables/${prop.zipCode}?limit=${compLimit}`);
          const compsJson = await compsRes.json();
          if (compsJson.ok && Array.isArray(compsJson.comparables)) {
            fetchedComparables = compsJson.comparables;
            setAreaComparables(compsJson.comparables);
            subjectSpecificRois = buildSubjectSpecificRegionalROIs(
              rois,
              compsJson.comparables,
              prop.sqft,
              localDetectedConditionScore,
              null, // material tier not yet known at Step 5
              prop.propertyType,
              prop.yearBuilt,
            );
          }
        } catch (e) {
          console.warn('Comparable fetch failed:', e);
        }

        setRegionalROIs(subjectSpecificRois);
        setRegionalROIsFilteredForSubject(true);

        updateStep('summary', {
          status: 'done',
          duration: Date.now() - t5,
          detail: `Source: ${summaryJson.source} | ${subjectSpecificRois.length} subject-matched renovation types | ${summaryJson.summary.totalComparables} comps • subject-filtered (size+condition)`,
        });
      } else {
        updateStep('summary', { status: 'error', duration: Date.now() - t5, detail: summaryJson.error || 'No summary' });
      }
      if (abortRef.current) return;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STEP 5b — Fetch Market Heat Signals (Zillow ZHVI + FRED)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      let mktCtx: typeof marketContext = null;
      try {
        // Fetch Zillow ZHVI market appreciation and FRED supply in parallel
        const [mktRes, fredRes] = await Promise.all([
          fetch(`/api/mls/history/market-appreciation?zip=${prop.zipCode}`).then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/fred/housing-market').then(r => r.json()).catch(() => ({ ok: false })),
        ]);

        // Extract most recent year's stats from Zillow ZHVI data
        let appreciationRate = 3.5; // default neutral
        let avgDOM = 30;
        let avgSaleToListPct = 98;
        if (mktRes.ok && Array.isArray(mktRes.stats) && mktRes.stats.length >= 2) {
          const sorted = [...mktRes.stats].sort((a: any, b: any) => b.YEAR - a.YEAR);
          const recent = sorted[0];
          const prev = sorted[1];
          // Zillow ZHVI may not have DOM/sale-to-list — use defaults if null
          avgDOM = recent.AVG_DOM ?? 30;
          avgSaleToListPct = recent.AVG_SALE_TO_LIST_PCT ?? 98;
          // Compute appreciation from ZHVI median prices
          const recentPrice = recent.MEDIAN_CLOSE_PRICE || recent.AVG_CLOSE_PRICE;
          const prevPrice = prev.MEDIAN_CLOSE_PRICE || prev.AVG_CLOSE_PRICE;
          if (prevPrice && recentPrice && prevPrice > 0) {
            appreciationRate = ((recentPrice - prevPrice) / prevPrice) * 100;
          }
        }

        // FRED months-of-supply (MSACSR)
        let monthsOfSupply: number | null = null;
        if (fredRes.ok && fredRes.data?.overview?.inventory?.value) {
          monthsOfSupply = parseFloat(fredRes.data.overview.inventory.value);
          if (isNaN(monthsOfSupply)) monthsOfSupply = null;
        }

        const { heatScore, heatLabel } = computeMarketHeatScore(appreciationRate, avgDOM, avgSaleToListPct, monthsOfSupply);
        mktCtx = { appreciationRate, avgDOM, avgSaleToListPct, monthsOfSupply, heatScore, heatLabel };
        setMarketContext(mktCtx);
        console.log(`[Pipeline] Market heat: score=${heatScore} (${heatLabel}), appreciation=${appreciationRate.toFixed(1)}%, DOM=${avgDOM}, S/L=${avgSaleToListPct}%, supply=${monthsOfSupply ?? 'n/a'}`);
      } catch (e) {
        console.warn('Market heat fetch failed, using neutral:', e);
      }
      if (abortRef.current) return;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STEP 6 — Build Combined Analysis
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const t6 = Date.now();
      updateStep('combine', { status: 'running' });

      const bestRenos = summaryJson?.summary?.bestROIRenovations || [];
      const rentalByType = summaryJson?.summary?.rentalAnalysis?.byRenovationType || {};
      const comparablesForSubject = (fetchedComparables.length > 0 ? fetchedComparables : areaComparables) || [];
      const propertyValue = prop.avm || prop.lastSalePrice || listing?.LISTPRICE || 300000;
      const monthlyRent = prop.rentalAvm || 1500;

      // Market adjustment multipliers (continuous, not bracketed)
      const mktHeatScore = mktCtx?.heatScore ?? 50;
      const mktEquityMult = marketHeatEquityMultiplier(mktHeatScore);
      const mktRentMult = marketHeatRentMultiplier(mktHeatScore);
      const mktHeatLabel = mktCtx?.heatLabel ?? 'neutral';

      // Infer material tier from detected renovations quality levels + property value
      const qualityLevels = (localDetectedRenovations || [])
        .map((d: any) => d.qualityLevel || d.quality || '')
        .filter(Boolean);
      const subjectMaterialTier = inferMaterialTier(qualityLevels, propertyValue);

      // Measurement-based cost analysis (same cost analysis system used on renovation analysis page)
      let measuredSuggestions: MeasurementSuggestion[] = [];
      if (photos.length > 0) {
        try {
          const costRes = await fetch('/api/analyze-renovations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              images: photos.slice(0, 10),
              propertyData: {
                address: prop.address,
                location: `${prop.city}, ${prop.state}`,
                monthlyRent,
                propertyValue,
                bedrooms: prop.beds,
                bathrooms: prop.baths,
                yearBuilt: prop.yearBuilt,
                squareFeet: prop.sqft,
              }
            })
          });
          const costJson = await costRes.json();
          if (costJson.ok && Array.isArray(costJson.suggestions)) {
            measuredSuggestions = costJson.suggestions.map(normalizeCanonicalRenovationSuggestion);
            setMeasurementSuggestions(measuredSuggestions);
          }
        } catch (e) {
          console.warn('Measurement cost analysis unavailable:', e);
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // BUILD RECOMMENDATIONS — unified single-pass approach
      // For each detected renovation need (from GPT-4o vision + DAv3 measurements),
      // pick the best available data with fallback chain:
      //   Cost:  DAv3 measured → regional comp median → GPT-4o estimate
      //   Value: regional comp data (stratified + adjusted) → conservative 70% ROI
      // ═══════════════════════════════════════════════════════════════════════

      // Step 1: Build a deduplicated map of all renovation needs, keyed by normalized type
      const unifiedMap = new Map<string, {
        key: string;
        displayName: string;
        detections: any[];
        measurements: MeasurementSuggestion[];
        regionalMatch: any | null;
      }>();

      // Room/area name → canonical renovation type (GPT-4o detects by room, we group by reno type)
      const roomToCanonicalType: Record<string, string> = {
        'living room': 'paint interior', 'living_room': 'paint interior',
        'bedroom': 'paint interior', 'bedrooms': 'paint interior',
        'master bedroom': 'paint interior', 'dining room': 'paint interior',
        'hallway': 'paint interior', 'foyer': 'paint interior',
        'front yard': 'landscaping', 'back yard': 'landscaping', 'yard': 'landscaping',
        'driveway': 'landscaping',
        'porch': 'deck patio', 'deck': 'deck patio', 'patio': 'deck patio',
        'attic': 'other', 'garage': 'other',
      };

      // Detection type → canonical renovation type
      const detTypeToCanonical: Record<string, string> = {
        'paint_refresh': 'paint interior', 'paint refresh': 'paint interior',
        'paint_exterior': 'paint exterior', 'paint exterior': 'paint exterior',
        'flooring_update': 'flooring', 'flooring update': 'flooring', 'flooring': 'flooring',
        'kitchen_update': 'kitchen', 'kitchen update': 'kitchen',
        'kitchen_remodel': 'kitchen', 'kitchen remodel': 'kitchen',
        'bathroom_update': 'bathroom master', 'bathroom update': 'bathroom master',
        'bathroom_remodel': 'bathroom master', 'bathroom remodel': 'bathroom master',
        'roof_replacement': 'roof', 'roof replacement': 'roof', 'roof_repair': 'roof',
        'window_replacement': 'windows', 'window replacement': 'windows',
        'hvac_update': 'hvac', 'hvac update': 'hvac', 'hvac': 'hvac',
        'siding_replacement': 'siding', 'siding': 'siding',
        'exterior_update': 'paint exterior', 'exterior update': 'paint exterior',
      };

      // Resolve the best canonical key for a detection: prefer type mapping, then area mapping, then raw area
      const resolveDetectionKey = (d: any): string => {
        const rawType = (d.type || '').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
        const rawArea = (d.area || '').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
        // 1) Detection type → canonical
        if (detTypeToCanonical[rawType]) return normalizeRenoType(detTypeToCanonical[rawType]);
        if (detTypeToCanonical[d.type || '']) return normalizeRenoType(detTypeToCanonical[d.type || '']);
        // 2) Room/area → canonical
        if (roomToCanonicalType[rawArea]) return normalizeRenoType(roomToCanonicalType[rawArea]);
        if (roomToCanonicalType[d.area || '']) return normalizeRenoType(roomToCanonicalType[d.area || '']);
        // 3) Fall back to area name (for things like "kitchen", "bathroom", "exterior", "roof" that ARE renovation types)
        return normalizeRenoType(d.area || d.type || '');
      };

      // Add GPT-4o detections — keyed by canonical renovation type, not room name
      for (const d of (localDetectedRenovations || [])) {
        const key = resolveDetectionKey(d);
        if (!key) continue;
        if (!unifiedMap.has(key)) {
          unifiedMap.set(key, {
            key,
            displayName: key.replace(/_/g, ' '),
            detections: [],
            measurements: [],
            regionalMatch: null,
          });
        }
        unifiedMap.get(key)!.detections.push(d);
      }

      // Add DAv3 measured suggestions — merge into existing detection or create new entry
      for (const s of measuredSuggestions) {
        const sKey = normalizeRenoType(s.type || s.name || '');
        if (!sKey) continue;
        // Try to find an existing detection entry this measurement belongs to
        let matched = false;
        for (const [existingKey, entry] of unifiedMap) {
          if (existingKey === sKey || existingKey.includes(sKey) || sKey.includes(existingKey)) {
            entry.measurements.push(s);
            matched = true;
            break;
          }
        }
        if (!matched) {
          const existing = unifiedMap.get(sKey);
          if (existing) {
            existing.measurements.push(s);
          } else {
            unifiedMap.set(sKey, {
              key: sKey,
              displayName: s.name || sKey,
              detections: [],
              measurements: [s],
              regionalMatch: null,
            });
          }
        }
      }

      // Find best regional comp match for each unified entry
      // Keys are now canonical renovation types, so matching is much simpler
      const usedRegionalTypes = new Set<string>();

      const findRegionalMatch = (searchTerms: string[], bestRenos: any[]): any | null => {
        for (const term of searchTerms) {
          const normTerm = normalizeRenoType(term);
          const found = bestRenos.find((r: any) => {
            const rType = normalizeRenoType(r.renovationType);
            return rType === normTerm || rType.includes(normTerm) || normTerm.includes(rType);
          });
          if (found) return found;
        }
        return null;
      };

      for (const [key, entry] of unifiedMap) {
        let match: any = null;
        // Try matching via specific measurement names first (most specific — has keyword mapping)
        for (const s of entry.measurements) {
          match = matchMeasuredToRegional(s.type, s.name, bestRenos);
          if (match) break;
        }

        // Try direct key match (key is already a canonical renovation type)
        if (!match) {
          match = findRegionalMatch([key], bestRenos);
        }

        // Try detection type fields as additional signal
        if (!match && entry.detections.length > 0) {
          for (const d of entry.detections) {
            const dType = normalizeRenoType(d.type || '');
            if (dType && dType !== key) {
              match = findRegionalMatch([dType], bestRenos);
              if (match) break;
            }
            const dArea = normalizeRenoType(d.area || '');
            if (dArea && dArea !== key) {
              match = findRegionalMatch([dArea], bestRenos);
              if (match) break;
            }
          }
        }

        // Prevent two entries from claiming the same regional comp (first match wins)
        if (match && !usedRegionalTypes.has(normalizeRenoType(match.renovationType))) {
          entry.regionalMatch = match;
          usedRegionalTypes.add(normalizeRenoType(match.renovationType));
        }
      }

      // Step 2: Build one recommendation per unified entry
      const recommendations = Array.from(unifiedMap.values()).map((entry) => {
        const { key, displayName, detections, measurements, regionalMatch } = entry;
        const hasMeasurements = measurements.length > 0;
        const hasCompData = !!regionalMatch;

        // ── Get comp data once (reused for cost fallback + value uplift) ──
        let compStats: any = null;
        if (regionalMatch) {
          compStats = buildFilteredComparableStats(
            regionalMatch.renovationType,
            comparablesForSubject,
            prop.sqft,
            localDetectedConditionScore,
            undefined,
            subjectMaterialTier,
            prop.propertyType,
            prop.yearBuilt,
          );
        }

        // ── Determine cost (best available) ──
        // Priority: DAv3 measured → regional comp → GPT-4o estimate
        let cost = 0;
        let costRange: { low: number; high: number } | null = null;
        let costSource: string = 'unknown';
        let measuredCost: number | null = null;
        let measuredCostRange: { low: number; high: number } | null = null;
        let measuredConfidence: string | null = null;

        // 1) DAv3 measured cost (sum all measured items for this renovation type)
        const totalMeasuredCost = measurements.reduce((sum, s) => sum + (s.cost || 0), 0);
        if (totalMeasuredCost > 0) {
          cost = totalMeasuredCost;
          measuredCost = totalMeasuredCost;
          if (measurements.length === 1 && measurements[0].costRange) {
            costRange = measurements[0].costRange;
            measuredCostRange = measurements[0].costRange;
          }
          measuredConfidence = measurements[0]?.confidence || null;
          costSource = 'measured';
        }

        // 2) Regional comp cost — removed. Comp costs were fabricated by estimateCostForCategory.
        // Cost estimation now relies on measured (DAv3) or GPT-4o detection for subject property.

        // 3) GPT-4o estimated cost (fallback when no measurement available)
        if (cost <= 0 && detections.length > 0) {
          const bestDet = detections.reduce((best: any, d: any) =>
            (d.confidence || 0) > (best?.confidence || 0) ? d : best, detections[0]);
          if (bestDet?.estimatedCost != null) {
            // estimatedCost may be a string ("$15,000-$25,000") or a number (15000)
            const ecStr = String(bestDet.estimatedCost);
            const nums = ecStr.match(/[\d,]+/g)?.map((n: string) => parseInt(n.replace(/,/g, ''), 10)) || [];
            if (nums.length >= 2) {
              costRange = { low: nums[0], high: nums[1] };
              cost = Math.round((nums[0] + nums[1]) / 2);
            } else if (nums.length === 1) {
              cost = nums[0];
            }
          }
          if (costSource === 'unknown') costSource = 'ai_estimated';
        }

        if (cost <= 0) return null; // No cost data from any source — skip

        // ── Determine value uplift + rental (best available) ──
        let valueAdd = 0;
        let rentAdd = 0;
        let sampleSize = 0;
        let adj: AdjustmentMeta = { ...defaultAdjustments(), heatScore: mktHeatScore, heatLabel: mktHeatLabel };

        if (regionalMatch) {
          // Regional comp data available — use stratified + adjusted uplift
          let baseValueAdd = compStats?.avgValueAdd ?? regionalMatch.avgValueUplift ?? 0;
          sampleSize = compStats?.sampleSize ?? regionalMatch.sampleSize ?? 0;
          const rentalStats = getRentalByType(rentalByType, regionalMatch.renovationType);
          let baseRentAdd = regionalMatch.avgRentIncrease ?? compStats?.avgRentIncrease ?? rentalStats?.avgMonthlyRentIncrease ?? 0;

          if (compStats?.adjustments) {
            adj = { ...compStats.adjustments, stratTierSource: adj.stratTierSource ?? compStats.adjustments.stratTierSource };
          }

          // Stratification tier lookup — blend tier-specific uplift with aggregate
          const stratResult = lookupStratificationTier(
            regionalMatch.renovationType,
            summaryJson?.summary,
            propertyValue, prop.yearBuilt, localDetectedConditionScore,
            subjectMaterialTier,
          );
          if (stratResult && stratResult.sampleSize >= 2) {
            const blendWeight = Math.min(0.85, 0.5 + stratResult.sampleSize * 0.05);
            baseValueAdd = baseValueAdd * (1 - blendWeight) + stratResult.uplift * blendWeight;
            adj.stratTierSource = stratResult.tierSource;
          }

          // Market heat + seasonal adjustments (avoid double-apply if compStats already did it)
          if (compStats?.adjustments) {
            valueAdd = baseValueAdd;
            rentAdd = baseRentAdd;
          } else {
            adj.marketHeatAdj = mktEquityMult;
            adj.marketHeatRentAdj = mktRentMult;
            const seasonAdj = seasonalTimingMultiplier(regionalMatch.renovationType);
            adj.seasonalAdj = seasonAdj;
            valueAdd = baseValueAdd * mktEquityMult * seasonAdj;
            rentAdd = baseRentAdd * mktRentMult;
          }

          // Area-based scope scaling when DAv3 room measurements are available.
          // For whole-house renovation types (paint, flooring), compare property total sqft
          // to comp area — since comp estimatedAreaSqFt represents whole-house area too.
          // For room-specific types (kitchen, bathroom), compare individual room measurements.
          if (hasMeasurements) {
            const isWholeHouseType = /paint|flooring|carpet|full.?reno/i.test(key);
            let subjectAreaForScaling = 0;
            
            if (isWholeHouseType && prop.sqft > 0) {
              // Use property total sqft for whole-house renovations
              subjectAreaForScaling = prop.sqft;
            } else {
              // Use measured room floor area for room-specific renovations
              subjectAreaForScaling = measurements[0].measurements?.roomDimensions?.floorAreaSqFt || 0;
            }
            
            const compAvgAreaSqFt = compStats?.avgCompAreaSqFt || 0;
            if (subjectAreaForScaling > 0 && compAvgAreaSqFt > 0) {
              const areaRatio = subjectAreaForScaling / compAvgAreaSqFt;
              // Dampened scaling: sqrt prevents extreme swings from size differences
              const dampened = Math.sqrt(areaRatio);
              const clampedAreaRatio = Math.max(0.4, Math.min(1.8, dampened));
              valueAdd *= clampedAreaRatio;
              rentAdd *= clampedAreaRatio;
              if (Math.abs(clampedAreaRatio - 1.0) > 0.05) {
                console.log(`[Reno] Area scaling for "${key}": subject ${Math.round(subjectAreaForScaling)} sqft vs comp avg ${Math.round(compAvgAreaSqFt)} sqft → ratio ${clampedAreaRatio.toFixed(2)}×`);
              }
            }
          }
        } else {
          // No regional comp data — conservative AI estimate (70% of cost)
          const conservativeROI = 0.70;
          valueAdd = Math.round(cost * conservativeROI * (mktEquityMult || 1));
          adj.marketHeatAdj = mktEquityMult;
        }

        if (valueAdd <= 0 && cost <= 0) return null;

        // ── SANITY CHECKS on final value uplift vs cost ──
        // These catch runaway figures that would undermine trust in the analysis.
        
        // 1. Value uplift should not exceed ~150% of property value for any single renovation.
        //    Even the most transformative renovation (full gut reno) doesn't double a home's value.
        const maxReasonableUplift = propertyValue * 1.5;
        if (valueAdd > maxReasonableUplift) {
          console.warn(`[Reno] ⚠️ "${key}" uplift ${valueAdd} exceeds 150% of property value ${propertyValue}. Clamping.`);
          valueAdd = maxReasonableUplift;
        }

        // 2. For cosmetic/moderate renovations, cap uplift to reasonable industry multipliers.
        //    Even the best cosmetic renos rarely create more than ~6× their cost in value.
        //    When cost is DAv3-measured (reliable), allow a higher cap since the cost is real data
        //    and low measured cost + high comp uplift genuinely happens (e.g., $7K kitchen refresh
        //    adding $30K+ in a market where kitchens drive value).
        const isCosmetic = /paint|flooring|carpet|landscaping|curb|deck|smart|lighting/.test(key);
        const isMeasuredCost = costSource === 'measured';
        const maxROIMultiple = isCosmetic
          ? (isMeasuredCost ? 8.0 : 6.0)
          : (isMeasuredCost ? 6.0 : 4.0);
        let roiWasCapped = false;
        if (cost > 0 && valueAdd > cost * maxROIMultiple) {
          console.warn(`[Reno] ⚠️ "${key}" value ${valueAdd} is ${(valueAdd / cost).toFixed(1)}× cost — capping to ${maxROIMultiple}×`);
          valueAdd = Math.round(cost * maxROIMultiple);
          roiWasCapped = true;
        }

        // 3. Cross-check: cost should not exceed property value for any single renovation
        //    (full gut renos of a $100K house don't cost $200K)
        if (cost > propertyValue * 0.8) {
          console.warn(`[Reno] ⚠️ "${key}" cost ${cost} exceeds 80% of property value ${propertyValue}. Likely over-scoped.`);
          // Don't clamp cost here (it's "measured"), but flag it
        }

        // ── Compute derived metrics ──
        const equityCreated = valueAdd - cost;
        const equityMultiple = cost > 0 ? valueAdd / cost : 0;
        const roi = cost > 0 ? (valueAdd / cost) * 100 : 0;
        const payback = rentAdd > 0 ? Math.ceil(cost / rentAdd) : 999;

        // Wedge classification
        let wedgeType: 'value_add' | 'cash_flow_turnaround' | 'brrrr_candidate' | null = null;
        let wedgeLabel = '';
        if (equityMultiple >= 1.5) {
          wedgeType = 'value_add';
          wedgeLabel = `💎 Value-Add Wedge — spend ${fmt(cost)}, create ${fmt(valueAdd)} value (${equityMultiple.toFixed(1)}× return)`;
        }
        if (rentAdd > 0 && monthlyRent > 0 && equityMultiple >= 1.2) {
          const arvAfterReno = propertyValue + valueAdd;
          const refinanceAmount = arvAfterReno * 0.75;
          const capitalNeeded = propertyValue * 0.80 + cost;
          if (refinanceAmount >= capitalNeeded) {
            wedgeType = 'brrrr_candidate';
            wedgeLabel = `🔄 BRRRR Candidate — ARV ${fmt(arvAfterReno)}, refi at 75% LTV = ${fmt(refinanceAmount)}, recapture capital`;
          }
        }
        if (rentAdd > 0 && equityMultiple >= 1.0 && !wedgeType) {
          wedgeType = 'cash_flow_turnaround';
          wedgeLabel = `📈 Cash Flow Boost — +${fmt(rentAdd)}/mo rent plus ${fmt(equityCreated)} instant equity`;
        }

        // ── Determine confidence + roiSource labels ──
        const roiSource = costSource === 'measured' && hasCompData ? 'measured_cost'
          : costSource === 'measured' ? 'measured_cost_no_comp'
          : hasCompData ? (compStats?.sampleSize > 0 ? 'comp_adjusted' : 'area_level')
          : 'ai_estimated';

        const confidence = hasCompData
          ? (regionalMatch?.confidenceLevel || 'medium')
          : costSource === 'ai_estimated' ? 'ai_estimated'
          : (measurements[0]?.confidence || 'medium');

        // ── Build measurement detail (primary DAv3 item, if available) ──
        const primaryMeasurement = hasMeasurements ? measurements[0] : null;
        const measurementDetail = primaryMeasurement ? {
          name: primaryMeasurement.name,
          summary: (primaryMeasurement as any).summary || '',
          details: (primaryMeasurement as any).details || '',
          timeframe: primaryMeasurement.timeframe,
          confidence: primaryMeasurement.confidence,
          measurements: primaryMeasurement.measurements,
          materialBreakdown: primaryMeasurement.materialBreakdown,
          laborBreakdown: primaryMeasurement.laborBreakdown,
          shoppableProducts: (primaryMeasurement as any).shoppableProducts,
          objectMeasurements: primaryMeasurement.measurements?.measured
            ? ((primaryMeasurement as any).measurements?.objectMeasurements || null) : null,
        } : null;

        // ── Build AI detection detail (shown when no comp data, GPT-4o detected) ──
        const bestDetection = detections.length > 0
          ? detections.reduce((best: any, d: any) => (d.confidence || 0) > (best?.confidence || 0) ? d : best, detections[0])
          : null;
        const aiDetectionDetail = (!hasCompData && bestDetection) ? {
          area: bestDetection.area,
          type: bestDetection.type,
          scope: bestDetection.scope,
          confidence: bestDetection.confidence,
          priority: bestDetection.priority,
          description: bestDetection.description,
          estimatedCost: bestDetection.estimatedCost,
        } : undefined;

        return {
          renovationType: regionalMatch?.renovationType || (hasMeasurements ? (measurements[0].type || 'general') : key.replace(/ /g, '_')),
          displayName: hasMeasurements ? primaryMeasurement!.name : displayName,
          scope: regionalMatch?.scope || bestDetection?.scope || (primaryMeasurement as any)?.summary || '',
          cost,
          valueAdd,
          rentIncrease: rentAdd,
          roi: hasCompData ? roi : roi,
          valueROI: roi,
          medianROI: regionalMatch?.medianROI || null,
          paybackMonths: payback,
          equityCreated,
          postRenoValue: propertyValue + valueAdd,
          sampleSize,
          confidence,
          trend: regionalMatch?.roiTrend || null,
          fiveYearRentalReturn: rentAdd * 12 * 5,
          totalReturn: equityCreated + (rentAdd * 12 * 5),
          measuredCost,
          measuredCostRange,
          measuredConfidence,
          measuredSource: hasMeasurements ? 'DAv3+Vision cost analysis' : null,
          roiSource,
          roiWasCapped,
          wedgeType,
          wedgeLabel,
          equityMultiple,
          hasCompData,
          adjustments: adj,
          measurementDetail,
          allMeasuredItems: measurements.map(s => ({
            name: s.name,
            type: s.type,
            cost: s.cost,
            costRange: s.costRange,
            measurements: s.measurements,
            materialBreakdown: s.materialBreakdown,
            laborBreakdown: s.laborBreakdown,
          })),
          ...(aiDetectionDetail ? { aiDetectionDetail } : {}),
        };
      }).filter(Boolean) as any[];

      // Sort: comp-backed positive-equity items first, then measured, then by total return
      recommendations.sort((a: any, b: any) => {
        const aPositiveEquity = a.hasCompData && (a.equityMultiple ?? 0) >= 1.0;
        const bPositiveEquity = b.hasCompData && (b.equityMultiple ?? 0) >= 1.0;
        const aScore = (aPositiveEquity ? 2000000 : 0) + (a.hasCompData ? 1000000 : 0) + (a.measurementDetail ? 500000 : 0) + (a.totalReturn || 0);
        const bScore = (bPositiveEquity ? 2000000 : 0) + (b.hasCompData ? 1000000 : 0) + (b.measurementDetail ? 500000 : 0) + (b.totalReturn || 0);
        return bScore - aScore;
      });

      const totalCost = recommendations.reduce((s: number, r: any) => s + r.cost, 0);
      const totalValue = recommendations.reduce((s: number, r: any) => s + r.valueAdd, 0);
      const totalRent = recommendations.reduce((s: number, r: any) => s + r.rentIncrease, 0);
      const measuredRecommendations = recommendations.filter((r: any) => r.roiSource === 'measured_cost');
      const measuredCostTotal = measuredRecommendations.reduce((s: number, r: any) => s + r.cost, 0);
      const measuredValueTotal = measuredRecommendations.reduce((s: number, r: any) => s + r.valueAdd, 0);

      const combined = {
        property: prop,
        currentValue: propertyValue,
        currentRent: monthlyRent,
        recommendations,
        totals: {
          cost: totalCost,
          valueAdd: totalValue,
          rentIncrease: totalRent,
          portfolioROI: measuredCostTotal > 0 ? (measuredValueTotal / measuredCostTotal * 100) : null,
          paybackMonths: totalRent > 0 ? Math.ceil(totalCost / totalRent) : 999,
          postRenoValue: propertyValue + totalValue,
          postRenoRent: monthlyRent + totalRent,
          measuredCount: measuredRecommendations.length,
        },
        dataSource: summaryJson?.source || 'unknown',
        comparablesUsed: summaryJson?.summary?.totalComparables || 0,
        marketSignals: summaryJson?.summary?.marketSignals || null,
        measurementCostCount: measuredSuggestions.length,
        leaseComparableRentSource: Object.keys(rentalByType || {}).length > 0,
        comparableRelevanceFilter: {
          applied: true,
          dimensions: ['size', 'condition', 'condition_headroom', 'property_type', 'year_built', 'material_tier', 'market_heat', 'seasonal', 'stratification'],
          subjectCondition: detectedOverallCondition || 'unknown',
          subjectConditionScore: localDetectedConditionScore,
          subjectSqft: prop.sqft || null,
          subjectPropertyType: prop.propertyType || null,
          subjectYearBuilt: prop.yearBuilt || null,
        },
        marketContext: mktCtx,
      };

      setCombinedAnalysis(combined);
      updateStep('combine', {
        status: 'done',
        duration: Date.now() - t6,
        detail: `${recommendations.length} recommendations | +${fmt(totalValue)} value | +${fmt(totalRent)}/mo rent`,
      });

    } catch (err: any) {
      setError(err.message || 'Pipeline failed');
      // Mark remaining steps as error
      setSteps(prev => prev.map(s => s.status === 'pending' || s.status === 'running' ? { ...s, status: 'error' as const } : s));
    } finally {
      setRunning(false);
    }
  };

  const handleAbort = () => {
    abortRef.current = true;
    setRunning(false);
  };

  // ─────────── render ───────────

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 overflow-hidden">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl h-[92vh] flex flex-col overflow-hidden">

        {/* ─── Header ─── */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gradient-to-r from-violet-600 to-indigo-700">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              🧪 Regional Renovation Pipeline Test
            </h2>
            <p className="text-violet-200 text-sm mt-0.5">
              End-to-end: ATTOM → Zillow Photos → AI Detection → Regional Uplift → ROI
            </p>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white hover:bg-white/20 rounded-full p-2 transition">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* ─── Input Bar ─── */}
        <div className="px-6 py-4 border-b bg-gray-50">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Property Address</label>
              <input
                type="text"
                value={address}
                onChange={e => setAddress(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !running && runPipeline()}
                placeholder="e.g. 1234 Elm St, Dallas, TX 75001"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <button
              onClick={running ? handleAbort : runPipeline}
              disabled={!address.trim() && !running}
              className={`px-6 py-2.5 rounded-lg font-semibold text-white shadow transition text-sm ${
                running
                  ? 'bg-red-500 hover:bg-red-600'
                  : 'bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {running ? '⏹ Abort' : '▶ Run Full Pipeline'}
            </button>
          </div>
          {error && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">⚠️ {error}</div>
          )}
        </div>

        {/* ─── Main Content ─── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Pipeline Progress */}
          {steps.length > 0 && (
            <div className="bg-white border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-4">Pipeline Progress</h3>
              <div className="space-y-3">
                {steps.map(step => (
                  <div key={step.id} className="flex items-center gap-3">
                    {/* Icon */}
                    <div className="w-7 h-7 flex items-center justify-center rounded-full flex-shrink-0" style={{
                      backgroundColor: step.status === 'done' ? '#dcfce7' : step.status === 'running' ? '#dbeafe' : step.status === 'error' ? '#fee2e2' : step.status === 'skipped' ? '#fef9c3' : '#f3f4f6',
                      color: step.status === 'done' ? '#16a34a' : step.status === 'running' ? '#2563eb' : step.status === 'error' ? '#dc2626' : step.status === 'skipped' ? '#ca8a04' : '#9ca3af',
                    }}>
                      {step.status === 'done' && '✓'}
                      {step.status === 'running' && <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
                      {step.status === 'error' && '✗'}
                      {step.status === 'skipped' && '—'}
                      {step.status === 'pending' && '○'}
                    </div>
                    {/* Label + detail */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${step.status === 'running' ? 'text-blue-700' : 'text-gray-800'}`}>{step.label}</span>
                        {step.duration != null && <span className="text-xs text-gray-400">{(step.duration / 1000).toFixed(1)}s</span>}
                      </div>
                      {step.detail && <p className="text-xs text-gray-500 truncate">{step.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Property Card */}
          {property && (
            <div className="bg-white border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">Property Details</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div><span className="text-gray-500">Address</span><p className="font-semibold text-gray-900 truncate">{property.address}</p></div>
                <div><span className="text-gray-500">Beds / Baths</span><p className="font-semibold">{property.beds} bd / {property.baths} ba</p></div>
                <div><span className="text-gray-500">Sq Ft</span><p className="font-semibold">{property.sqft.toLocaleString()}</p></div>
                <div><span className="text-gray-500">Year Built</span><p className="font-semibold">{property.yearBuilt}</p></div>
                <div><span className="text-gray-500">AVM</span><p className="font-semibold text-green-700">{fmt(property.avm)}</p></div>
                <div><span className="text-gray-500">Rental AVM</span><p className="font-semibold text-blue-700">{fmt(property.rentalAvm)}/mo</p></div>
                <div><span className="text-gray-500">Last Sale</span><p className="font-semibold">{fmt(property.lastSalePrice)}</p></div>
                <div><span className="text-gray-500">ZIP</span><p className="font-semibold">{property.zipCode}</p></div>
              </div>
            </div>
          )}

          {/* Photos Strip */}
          {allPhotos.length > 0 && (
            <div className="bg-white border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">MLS Photos ({allPhotos.length})</h3>
                <button onClick={() => setShowPhotos(!showPhotos)} className="text-xs text-violet-600 hover:underline">
                  {showPhotos ? 'Hide' : 'Show All'}
                </button>
              </div>
              <div className={`flex gap-2 overflow-x-auto pb-2 ${showPhotos ? 'flex-wrap' : ''}`}>
                {(showPhotos ? allPhotos : allPhotos.slice(0, 8)).map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt={`Photo ${i + 1}`}
                    className={`h-24 w-36 object-cover rounded-lg border-2 cursor-pointer flex-shrink-0 transition ${activePhotoIdx === i ? 'border-violet-500 ring-2 ring-violet-300' : 'border-gray-200 hover:border-violet-300'}`}
                    onClick={() => setActivePhotoIdx(i)}
                    loading="lazy"
                  />
                ))}
                {!showPhotos && allPhotos.length > 8 && (
                  <button onClick={() => setShowPhotos(true)} className="h-24 w-36 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-500 text-sm hover:border-violet-400 hover:text-violet-600 flex-shrink-0">
                    +{allPhotos.length - 8} more
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Detected Renovations */}
          {detectedRenovations.length > 0 && (
            <div className="bg-white border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
                AI-Detected Renovation Needs ({detectedRenovations.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {detectedRenovations.map((r, i) => (
                  <div key={i} className="border rounded-lg p-3 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm text-gray-800">{r.area || r.type}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${r.confidence > 0.7 ? 'bg-green-100 text-green-700' : r.confidence > 0.4 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                        {(r.confidence * 100).toFixed(0)}% conf
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">{r.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Regional ROI Table */}
          {regionalROIs.length > 0 && (
            <div className="bg-white border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-1">
                Regional Renovation Value Uplifts — ZIP {property?.zipCode}
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                Based on {areaSummary?.totalComparables || 0} real before/after comparable sales with uplift isolation
                {regionalROIsFilteredForSubject ? ' • filtered for subject size + condition' : ''}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b">
                      <th className="py-2 pr-3">Renovation</th>
                      <th className="py-2 pr-3 text-right">Value Uplift</th>
                      <th className="py-2 pr-3 text-right">Rent +/mo</th>
                      <th className="py-2 pr-3 text-right">Avg Cost</th>
                      <th className="py-2 pr-3 text-center">Trend</th>
                      <th className="py-2 pr-3 text-center">N</th>
                      <th className="py-2 text-center">Conf</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regionalROIs.map((r, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-violet-50/50">
                        <td className="py-2 pr-3 font-medium text-gray-800">{r.renovationType.replace(/_/g, ' ')}</td>
                        <td className="py-2 pr-3 text-right text-green-700">{fmt(r.avgValueUplift)}</td>
                        <td className="py-2 pr-3 text-right text-blue-600">+{fmt(r.avgRentIncrease)}</td>
                        <td className="py-2 pr-3 text-right">{fmt(r.avgCost)}</td>
                        <td className="py-2 pr-3 text-center">
                          {getTrendDirection(r.roiTrend) === 'rising' && <span className="text-green-600">📈</span>}
                          {getTrendDirection(r.roiTrend) === 'falling' && <span className="text-red-500">📉</span>}
                          {getTrendDirection(r.roiTrend) === 'stable' && <span className="text-gray-400">➡️</span>}
                        </td>
                        <td className="py-2 pr-3 text-center text-gray-500">{r.sampleSize}</td>
                        <td className="py-2 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${r.confidenceLevel === 'high' ? 'bg-green-100 text-green-700' : r.confidenceLevel === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                            {r.confidenceLevel}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Market Timing / Saturation Signals */}
          {areaSummary?.marketSignals && (
            <div className="bg-white border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
                Market Timing & Saturation Signals
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                <div className="rounded-lg border p-3 bg-gray-50">
                  <p className="text-xs text-gray-500">Overall Market Health</p>
                  <p className="font-bold capitalize">{areaSummary.marketSignals.overallHealth || 'unknown'}</p>
                </div>
                <div className="rounded-lg border p-3 bg-gray-50">
                  <p className="text-xs text-gray-500">High Opportunity</p>
                  <p className="font-bold">{(areaSummary.marketSignals.highOpportunityRenovations || []).length}</p>
                  <p className="text-xs text-gray-500 truncate">{(areaSummary.marketSignals.highOpportunityRenovations || []).join(', ') || '—'}</p>
                </div>
                <div className="rounded-lg border p-3 bg-gray-50">
                  <p className="text-xs text-gray-500">Saturated Types</p>
                  <p className="font-bold">{(areaSummary.marketSignals.saturatedRenovations || []).length}</p>
                  <p className="text-xs text-gray-500 truncate">{(areaSummary.marketSignals.saturatedRenovations || []).join(', ') || '—'}</p>
                </div>
              </div>
              {(areaSummary.marketSignals.warnings || []).length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-semibold text-amber-700 mb-1">Warnings</p>
                  <ul className="text-xs text-amber-800 list-disc ml-4 space-y-1">
                    {(areaSummary.marketSignals.warnings || []).slice(0, 6).map((w: string, i: number) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Property-Specific Cost Analysis — now folded into combined analysis below */}
          {measurementSuggestions.length > 0 && !combinedAnalysis && (
            <div className="bg-white border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
                Property Cost Analysis (DAv3 + Vision + Local Pricing) — Loading regional uplift data...
              </h3>
              <div className="space-y-3">
                {measurementSuggestions.slice(0, 8).map((s, i) => (
                  <div key={s.id || i} className="rounded-lg border p-3 bg-gray-50">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold text-sm">{s.name}</p>
                        <p className="text-xs text-gray-500">{s.type} {s.measurements?.measured ? `• measured ${s.measurements?.roomType || 'room'}` : '• estimated'}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-sm">{fmt(s.cost)}</p>
                        <p className="text-xs text-gray-500">ROI {pct(s.roi)} {s.confidence ? `• ${s.confidence}` : ''}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Specific Comparable Properties Used */}
          {areaComparables.length > 0 && (
            <div className="bg-white border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-1">
                Comparable Properties Used in Uplift Analysis ({areaComparables.length}{areaSummary?.totalComparables ? ` of ${areaSummary.totalComparables}` : ''})
              </h3>
              <p className="text-xs text-gray-500 mb-3">Before/after sales, photos, and renovation allocations from the comps used (showing most recent subset for readability).</p>
              <div className="space-y-4 max-h-[640px] overflow-y-auto pr-1">
                {areaComparables.slice(0, 8).map((c, i) => (
                  <div key={c.id || i} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div>
                        <p className="font-semibold text-sm">{c.address}</p>
                        <p className="text-xs text-gray-500">{c.propertyType || 'Residential'} • {c.beds || 0}bd/{c.baths || 0}ba • {(c.sqft || 0).toLocaleString()} sqft • Built {c.yearBuilt || '—'}</p>
                      </div>
                      <div className="text-right text-xs">
                        <p className="text-gray-600">Uplift {fmt(c.renovationAttributedUplift)} • Cost {fmt(c.totalRenovationCost)}</p>
                        <p className="text-blue-600">Rent +/mo {fmt(c.rentAnalysis?.rentIncrease ?? undefined)}</p>
                        <p className="text-gray-500">{fmt(c.beforeSalePrice)} → {fmt(c.afterSalePrice)}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">Before Photos</p>
                        <div className="grid grid-cols-3 gap-1">
                          {(c.photoComparison?.beforePhotos || []).slice(0, 3).map((u, idx) => (
                            <img key={idx} src={u} alt="before" className="h-20 w-full object-cover rounded border" loading="lazy" />
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">After Photos</p>
                        <div className="grid grid-cols-3 gap-1">
                          {(c.photoComparison?.afterPhotos || []).slice(0, 3).map((u, idx) => (
                            <img key={idx} src={u} alt="after" className="h-20 w-full object-cover rounded border" loading="lazy" />
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {(c.renovations || []).slice(0, 6).map((r, ridx) => (
                        <span key={ridx} className="text-xs px-2 py-1 rounded bg-violet-50 border border-violet-200 text-violet-700">
                          {r.category.replace(/_/g, ' ')} • {r.scope} • uplift {fmt(r.allocatedUplift)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Combined Analysis — What This Means For YOUR Property */}
          {combinedAnalysis && (
            <div className="bg-gradient-to-br from-violet-50 to-indigo-50 border-2 border-violet-200 rounded-xl p-5">
              <h3 className="text-lg font-bold text-violet-800 mb-1">🎯 Renovation Investment Analysis</h3>
              <p className="text-xs text-violet-600 mb-2">
                Regional comp uplift + DAv3 measured costs + cap-rate rent — {property?.address}
              </p>

              {/* Market Heat & Adjustment Summary Bar */}
              {combinedAnalysis.marketContext && (
                <div className="mb-4 rounded-lg border border-violet-200 bg-white/70 p-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* Heat gauge */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-600">Market Temperature:</span>
                      <div className="flex items-center gap-1">
                        <div className="w-24 h-2.5 rounded-full bg-gradient-to-r from-blue-400 via-yellow-400 to-red-500 relative">
                          <div
                            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white border-2 border-gray-800 shadow-sm"
                            style={{ left: `calc(${combinedAnalysis.marketContext.heatScore}% - 6px)` }}
                          />
                        </div>
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                          combinedAnalysis.marketContext.heatLabel === 'hot' ? 'bg-red-100 text-red-700' :
                          combinedAnalysis.marketContext.heatLabel === 'warm' ? 'bg-orange-100 text-orange-700' :
                          combinedAnalysis.marketContext.heatLabel === 'neutral' ? 'bg-yellow-100 text-yellow-700' :
                          combinedAnalysis.marketContext.heatLabel === 'cool' ? 'bg-sky-100 text-sky-700' :
                          'bg-blue-100 text-blue-700'
                        }`}>
                          {combinedAnalysis.marketContext.heatLabel.toUpperCase()} ({combinedAnalysis.marketContext.heatScore})
                        </span>
                      </div>
                    </div>
                    {/* Key signals */}
                    <div className="flex items-center gap-2 text-[11px] text-gray-500">
                      <span>📈 {combinedAnalysis.marketContext.appreciationRate >= 0 ? '+' : ''}{combinedAnalysis.marketContext.appreciationRate.toFixed(1)}% YoY</span>
                      <span>⏱ {combinedAnalysis.marketContext.avgDOM}d DOM</span>
                      <span>💰 {combinedAnalysis.marketContext.avgSaleToListPct.toFixed(1)}% S/L</span>
                      {combinedAnalysis.marketContext.monthsOfSupply != null && <span>📦 {combinedAnalysis.marketContext.monthsOfSupply.toFixed(1)}mo supply</span>}
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1.5">
                    Adjustments applied: Equity uplift ×{marketHeatEquityMultiplier(combinedAnalysis.marketContext.heatScore).toFixed(3)} | Rent uplift ×{marketHeatRentMultiplier(combinedAnalysis.marketContext.heatScore).toFixed(3)} | Condition: {detectedOverallCondition || 'unknown'} ({detectedConditionScore ?? '—'}/100) | Seasonal exterior ROI: ×{seasonalTimingMultiplier('landscaping').toFixed(3)}
                  </p>
                </div>
              )}

              {/* ═══════════════════════════════════════════════════════════════
                  INVESTMENT STRATEGY CENTER — AI-powered deal analysis
                  ═══════════════════════════════════════════════════════════════ */}
              {combinedAnalysis.recommendations.length > 0 && (() => {
                const recs = combinedAnalysis.recommendations as any[];
                const wedgeRecs = recs.filter((r: any) => r.wedgeType);
                const valueAddWedges = wedgeRecs.filter((r: any) => r.wedgeType === 'value_add');
                const brrrrCandidates = wedgeRecs.filter((r: any) => r.wedgeType === 'brrrr_candidate');
                const cashFlowBoosts = wedgeRecs.filter((r: any) => r.wedgeType === 'cash_flow_turnaround');

                const totalCost = combinedAnalysis.totals.cost;
                const totalValueAdd = combinedAnalysis.totals.valueAdd;
                const totalRent = combinedAnalysis.totals.rentIncrease;
                const currentValue = combinedAnalysis.currentValue || 0;
                const currentRent = combinedAnalysis.currentRent || 0;
                const coreValuation = areaSummary?.coreValuation;
                const coreArv = coreValuation?.coreArv;
                const coreRent = coreValuation?.arRent;

                // Phase 6: core underwriting uses Sales Comparison ARV/AR-rent output.
                // Fallback to legacy valueAdd/rentAdd aggregation only if core valuation is unavailable.
                const arvAfterAll = coreArv?.available && Number.isFinite(coreArv?.base)
                  ? Number(coreArv.base)
                  : (currentValue + totalValueAdd);
                const postRenoRent = coreRent?.available && Number.isFinite(coreRent?.base)
                  ? Number(coreRent.base)
                  : (currentRent + totalRent);
                const effectiveValueAdd = Math.max(0, arvAfterAll - currentValue);
                const effectiveRentAdd = Math.max(0, postRenoRent - currentRent);
                const totalEquity = effectiveValueAdd - totalCost;
                const overallMultiple = totalCost > 0 ? effectiveValueAdd / totalCost : 0;
                const refinanceAmount75 = arvAfterAll * 0.75;
                const acquisitionCost = currentValue * 0.80;
                const totalCapitalNeeded = acquisitionCost + totalCost;
                const capitalRecaptured = refinanceAmount75 - acquisitionCost;
                const cashLeftIn = Math.max(0, totalCapitalNeeded - refinanceAmount75);
                const annualCashFlow = postRenoRent * 12;
                const cocReturn = cashLeftIn > 0 ? (annualCashFlow / cashLeftIn * 100) : 0;

                const tier1 = recs.filter((r: any) => r.hasCompData && r.equityMultiple >= 1.5);
                const tier2 = recs.filter((r: any) => r.hasCompData && r.equityMultiple >= 1.0 && r.equityMultiple < 1.5);
                const tier3 = recs.filter((r: any) => !r.hasCompData || r.equityMultiple < 1.0);
                const tier1Cost = tier1.reduce((s: number, r: any) => s + r.cost, 0);
                const tier1Value = tier1.reduce((s: number, r: any) => s + r.valueAdd, 0);
                const tier1Rent = tier1.reduce((s: number, r: any) => s + r.rentIncrease, 0);

                const isBRRRR = refinanceAmount75 >= totalCapitalNeeded && overallMultiple >= 1.2 && effectiveRentAdd > 0;
                const isValueAdd = overallMultiple >= 1.5;
                const isCashFlow = effectiveRentAdd > 200 && overallMultiple >= 1.0;
                const primaryStrategy = isBRRRR ? 'brrrr' : isValueAdd ? 'value_add' : isCashFlow ? 'cash_flow' : 'selective';

                return (
                  <div className="mb-5 rounded-xl shadow-md border-2 border-green-300 overflow-hidden">
                    {/* Strategy Header */}
                    <div className={`px-5 py-4 ${
                      primaryStrategy === 'brrrr' ? 'bg-gradient-to-r from-blue-600 to-indigo-700' :
                      primaryStrategy === 'value_add' ? 'bg-gradient-to-r from-green-600 to-emerald-700' :
                      primaryStrategy === 'cash_flow' ? 'bg-gradient-to-r from-teal-600 to-cyan-700' :
                      'bg-gradient-to-r from-violet-600 to-purple-700'
                    }`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-base font-bold text-white flex items-center gap-2">
                            {primaryStrategy === 'brrrr' && '🔄'}
                            {primaryStrategy === 'value_add' && '💎'}
                            {primaryStrategy === 'cash_flow' && '📈'}
                            {primaryStrategy === 'selective' && '🎯'}
                            {' '}Investment Strategy Analysis
                          </h3>
                          <p className="text-sm text-white/80 mt-0.5">
                            {primaryStrategy === 'brrrr' && 'BRRRR Candidate — Buy, Rehab, Rent, Refinance, Repeat'}
                            {primaryStrategy === 'value_add' && `Value-Add Opportunity — ${overallMultiple.toFixed(1)}× return on renovation investment`}
                            {primaryStrategy === 'cash_flow' && `Cash Flow Play — +${fmt(effectiveRentAdd)}/mo rent uplift with equity upside`}
                            {primaryStrategy === 'selective' && 'Selective Renovation — focus on highest-ROI improvements'}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-black text-white">{fmt(totalEquity)}</p>
                          <p className="text-xs text-white/70">instant equity created</p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-gradient-to-b from-green-50 to-white p-5 space-y-4">
                      {/* Key Metrics Bar */}
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="bg-white rounded-lg p-3 text-center shadow-sm border">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Current Value</p>
                          <p className="text-sm font-bold text-gray-700">{fmt(currentValue)}</p>
                        </div>
                        <div className="bg-white rounded-lg p-3 text-center shadow-sm border">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Renovation Cost</p>
                          <p className="text-sm font-bold text-red-600">{fmt(totalCost)}</p>
                        </div>
                        <div className="bg-white rounded-lg p-3 text-center shadow-sm border border-green-200">
                          <p className="text-[10px] text-green-600 uppercase tracking-wider font-semibold">After-Repair Value</p>
                          <p className="text-sm font-bold text-green-700">{fmt(arvAfterAll)}</p>
                        </div>
                        <div className="bg-white rounded-lg p-3 text-center shadow-sm border">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Post-Reno Rent</p>
                          <p className="text-sm font-bold text-blue-700">{fmt(postRenoRent)}/mo</p>
                        </div>
                        <div className="bg-white rounded-lg p-3 text-center shadow-sm border">
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Value Multiple</p>
                          <p className={`text-sm font-bold ${overallMultiple >= 2 ? 'text-green-600' : overallMultiple >= 1.5 ? 'text-blue-600' : 'text-gray-700'}`}>
                            {overallMultiple.toFixed(1)}× return
                          </p>
                        </div>
                      </div>

                      {/* ── BRRRR Detailed Walkthrough ── */}
                      {isBRRRR && (
                        <div className="bg-white rounded-lg border-2 border-blue-200 overflow-hidden">
                          <div className="bg-blue-50 px-4 py-2 border-b border-blue-200">
                            <h4 className="text-sm font-bold text-blue-800">🔄 BRRRR Strategy Walkthrough</h4>
                            <p className="text-xs text-blue-600">How to recapture your capital and build infinite ROI</p>
                          </div>
                          <div className="p-4 space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                              {[
                                { step: 'BUY', icon: '🏠', desc: `Acquire at ${fmt(currentValue)}`, detail: `${fmt(acquisitionCost)} with 80% LTV financing`, color: 'blue' },
                                { step: 'REHAB', icon: '🔨', desc: `Invest ${fmt(totalCost)}`, detail: `${recs.filter((r:any) => r.measurementDetail).length} photo-measured + ${recs.filter((r:any) => !r.measurementDetail && r.hasCompData).length} comp-validated + ${recs.filter((r:any) => r.roiSource === 'ai_estimated').length} AI-detected`, color: 'orange' },
                                { step: 'RENT', icon: '🔑', desc: `${fmt(postRenoRent)}/mo`, detail: `+${fmt(effectiveRentAdd)}/mo over current (${fmt(annualCashFlow)}/yr)`, color: 'teal' },
                                { step: 'REFI', icon: '🏦', desc: `75% of ${fmt(arvAfterAll)}`, detail: `= ${fmt(refinanceAmount75)} cash-out refi`, color: 'violet' },
                                { step: 'REPEAT', icon: '🔁', desc: capitalRecaptured > 0 ? `${fmt(capitalRecaptured)} recaptured` : 'Partial recap', detail: cashLeftIn > 0 ? `Only ${fmt(cashLeftIn)} left in deal` : 'All capital recovered!', color: 'green' },
                              ].map((s) => (
                                <div key={s.step} className={`rounded-lg border p-2.5 text-center bg-${s.color}-50 border-${s.color}-200`}>
                                  <p className="text-lg">{s.icon}</p>
                                  <p className={`text-[10px] font-black tracking-widest text-${s.color}-700`}>{s.step}</p>
                                  <p className="text-xs font-bold text-gray-800 mt-0.5">{s.desc}</p>
                                  <p className="text-[10px] text-gray-500 mt-0.5">{s.detail}</p>
                                </div>
                              ))}
                            </div>
                            <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
                              <p className="text-sm text-blue-900">
                                <span className="font-bold">Bottom Line: </span>
                                {cashLeftIn <= 0 ? (
                                  <>Fully recapture your {fmt(totalCost)} renovation investment through refinancing at the new {fmt(arvAfterAll)} ARV. Hold the property with <span className="font-bold text-green-700">zero capital left in</span> and collect {fmt(postRenoRent)}/mo rent — that's infinite cash-on-cash return.</>
                                ) : (
                                  <>After refinancing at 75% of {fmt(arvAfterAll)} ARV, you'll have only <span className="font-bold">{fmt(cashLeftIn)}</span> left in the deal while collecting {fmt(postRenoRent)}/mo rent — a <span className="font-bold text-green-700">{cocReturn.toFixed(0)}% cash-on-cash return</span>.</>
                                )}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ── Value-Add / Flip Strategy ── */}
                      {isValueAdd && !isBRRRR && (
                        <div className="bg-white rounded-lg border-2 border-green-200 overflow-hidden">
                          <div className="bg-green-50 px-4 py-2 border-b border-green-200">
                            <h4 className="text-sm font-bold text-green-800">💎 Value-Add Strategy</h4>
                            <p className="text-xs text-green-600">Forced appreciation through strategic renovation</p>
                          </div>
                          <div className="p-4 space-y-3">
                            <div className="grid grid-cols-3 gap-3 text-center">
                              <div className="bg-red-50 rounded-lg p-3 border border-red-100">
                                <p className="text-[10px] text-gray-500 uppercase">You Invest</p>
                                <p className="text-lg font-black text-red-600">{fmt(totalCost)}</p>
                              </div>
                              <div className="text-2xl flex items-center justify-center text-green-500">→</div>
                              <div className="bg-green-50 rounded-lg p-3 border border-green-200">
                                <p className="text-[10px] text-gray-500 uppercase">Equity Created</p>
                                <p className="text-lg font-black text-green-700">{fmt(totalEquity)}</p>
                              </div>
                            </div>
                            <div className="bg-green-50 rounded-lg p-3 border border-green-100">
                              <p className="text-sm text-green-900">
                                <span className="font-bold">Strategy: </span>
                                Every $1 spent on renovation creates ${overallMultiple.toFixed(2)} in property value based on {combinedAnalysis.comparablesUsed} comparable sales in your market.
                                {effectiveRentAdd > 0 && <> While holding, you'll earn an additional <span className="font-bold text-blue-700">{fmt(effectiveRentAdd)}/mo</span> in rental income — {fmt(effectiveRentAdd * 12 * 5)} over 5 years.</>}
                                {tier1.length > 0 && <> For maximum ROI, prioritize <span className="font-semibold">{tier1.map((r: any) => r.displayName || r.renovationType.replace(/_/g, ' ')).join(', ')}</span> — these alone generate {fmt(tier1Value)} in value from {fmt(tier1Cost)} invested ({tier1Cost > 0 ? (tier1Value / tier1Cost).toFixed(1) : '∞'}× return).</>}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ── Cash Flow Strategy ── */}
                      {isCashFlow && !isBRRRR && !isValueAdd && (
                        <div className="bg-white rounded-lg border-2 border-teal-200 overflow-hidden">
                          <div className="bg-teal-50 px-4 py-2 border-b border-teal-200">
                            <h4 className="text-sm font-bold text-teal-800">📈 Cash Flow Strategy</h4>
                            <p className="text-xs text-teal-600">Boost rental income while building equity</p>
                          </div>
                          <div className="p-4">
                            <div className="grid grid-cols-3 gap-3 text-center mb-3">
                              <div className="bg-white rounded-lg p-3 border">
                                <p className="text-[10px] text-gray-500 uppercase">Current Rent</p>
                                <p className="text-base font-bold text-gray-600">{fmt(currentRent)}/mo</p>
                              </div>
                              <div className="text-xl flex items-center justify-center text-teal-500">→ +{fmt(effectiveRentAdd)}</div>
                              <div className="bg-teal-50 rounded-lg p-3 border border-teal-200">
                                <p className="text-[10px] text-gray-500 uppercase">Post-Reno Rent</p>
                                <p className="text-base font-bold text-teal-700">{fmt(postRenoRent)}/mo</p>
                              </div>
                            </div>
                            <div className="bg-teal-50 rounded-lg p-3 border border-teal-100">
                              <p className="text-sm text-teal-900">
                                <span className="font-bold">Strategy: </span>
                                Invest {fmt(totalCost)} to boost monthly rent by {fmt(effectiveRentAdd)}/mo while creating {fmt(totalEquity)} in instant equity. 
                                Renovation pays for itself in <span className="font-bold">{effectiveRentAdd > 0 ? Math.ceil(totalCost / effectiveRentAdd) : '—'} months</span> through increased rental income alone — 
                                any equity appreciation is pure bonus.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ── Selective Strategy ── */}
                      {primaryStrategy === 'selective' && (
                        <div className="bg-white rounded-lg border-2 border-violet-200 overflow-hidden">
                          <div className="bg-violet-50 px-4 py-2 border-b border-violet-200">
                            <h4 className="text-sm font-bold text-violet-800">🎯 Selective Renovation Strategy</h4>
                            <p className="text-xs text-violet-600">Focus on the highest-ROI improvements</p>
                          </div>
                          <div className="p-4">
                            <div className="bg-violet-50 rounded-lg p-3 border border-violet-100">
                              <p className="text-sm text-violet-900">
                                <span className="font-bold">Strategy: </span>
                                Not every renovation creates a positive return in this market. 
                                {tier1.length > 0 ? (
                                  <>Focus only on <span className="font-semibold">{tier1.map((r: any) => r.displayName || r.renovationType.replace(/_/g, ' ')).join(', ')}</span> which generate ≥1.5× return. Skip or defer lower-ROI items to avoid over-improving for the neighborhood.</>
                                ) : (
                                  <>Consider deferring non-essential renovations. The comparable data shows limited value uplift for renovation types detected at this property. Focus on maintenance-level repairs to preserve current value.</>
                                )}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ── Renovation Priority Tiers ── */}
                      {(tier1.length > 0 || tier2.length > 0) && (
                        <div className="space-y-2">
                          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Renovation Priority Tiers</h4>
                          {tier1.length > 0 && (
                            <div className="bg-green-50 rounded-lg border border-green-200 p-3">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-bold text-green-800">🥇 Tier 1 — High Impact (≥1.5× return)</span>
                                <span className="text-xs text-green-600 font-semibold">{fmt(tier1Cost)} → {fmt(tier1Value)} value + {fmt(tier1Rent)}/mo rent</span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {tier1.map((r: any, i: number) => (
                                  <span key={i} className="text-xs bg-green-100 text-green-800 rounded-full px-2 py-0.5 font-medium">
                                    {r.displayName || r.renovationType.replace(/_/g, ' ')} ({r.equityMultiple.toFixed(1)}×)
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {tier2.length > 0 && (
                            <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-3">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-bold text-yellow-800">🥈 Tier 2 — Moderate Impact (1.0–1.5× return)</span>
                                <span className="text-xs text-yellow-600 font-semibold">{fmt(tier2.reduce((s: number, r: any) => s + r.cost, 0))} → {fmt(tier2.reduce((s: number, r: any) => s + r.valueAdd, 0))} value</span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {tier2.map((r: any, i: number) => (
                                  <span key={i} className="text-xs bg-yellow-100 text-yellow-800 rounded-full px-2 py-0.5 font-medium">
                                    {r.displayName || r.renovationType.replace(/_/g, ' ')} ({r.equityMultiple.toFixed(1)}×)
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {tier3.length > 0 && (
                            <div className="bg-gray-50 rounded-lg border border-gray-200 p-3">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-bold text-gray-600">🥉 Tier 3 — Low/Uncertain Impact</span>
                                <span className="text-xs text-gray-500">{tier3.length} items — consider deferring</span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {tier3.map((r: any, i: number) => (
                                  <span key={i} className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
                                    {r.displayName || r.renovationType.replace(/_/g, ' ')} {r.hasCompData ? `(${r.equityMultiple.toFixed(1)}×)` : '(cost only)'}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Data confidence footer */}
                      <p className="text-[10px] text-gray-400 text-center pt-2 border-t border-gray-100">
                        Analysis based on {combinedAnalysis.comparablesUsed} comparable sales • 
                        {recs.filter((r:any) => r.measurementDetail).length} items with DAv3 photo-measured costs • 
                        {recs.filter((r:any) => r.hasCompData).length} items with regional comp uplift data • 
                        {recs.filter((r:any) => r.roiSource === 'ai_estimated').length} AI-detected (est. cost only) • 
                        Cap-rate-derived rent estimates
                      </p>
                    </div>
                  </div>
                );
              })()}

              {/* Recommendation Cards — merged with DAv3 cost analysis */}
              <h4 className="text-sm font-semibold text-violet-700 mb-2">Ranked Renovation Recommendations</h4>
              <div className="space-y-3">
                {(combinedAnalysis.recommendations as any[]).map((rec, i) => {
                  const md = rec.measurementDetail;
                  const hasMeasurement = !!md;
                  const mats = md?.materialBreakdown || rec.allMeasuredItems?.[0]?.materialBreakdown;
                  const labor = md?.laborBreakdown || rec.allMeasuredItems?.[0]?.laborBreakdown;
                  const roomMeasurements = md?.measurements || rec.allMeasuredItems?.[0]?.measurements;
                  const objectMeasurements = md?.objectMeasurements;

                  return (
                    <details key={i} className={`rounded-lg shadow-sm group ${rec.wedgeType ? 'bg-gradient-to-r from-white to-green-50 border border-green-200' : 'bg-white border'}`}>
                      <summary className="p-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                        <div className="flex items-center gap-4">
                          <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${rec.wedgeType === 'value_add' ? 'bg-green-100 text-green-700' : rec.wedgeType === 'brrrr_candidate' ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700'}`}>
                            {i + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-sm text-gray-800">
                                {rec.displayName || rec.renovationType.replace(/_/g, ' ')}
                              </span>
                              {rec.wedgeType === 'value_add' && <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-semibold">💎 VALUE-ADD WEDGE</span>}
                              {rec.wedgeType === 'brrrr_candidate' && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">🔄 BRRRR</span>}
                              {rec.wedgeType === 'cash_flow_turnaround' && <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 font-semibold">📈 CASH FLOW</span>}
                              {rec.hasCompData && !rec.wedgeType && (rec.equityMultiple ?? 0) < 1.0 && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold">⚠️ NEGATIVE EQUITY</span>
                              )}
                              {hasMeasurement && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">📐 MEASURED</span>}
                              {!rec.hasCompData && rec.roiSource === 'ai_estimated' && <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">🤖 AI-detected</span>}
                              {!rec.hasCompData && rec.roiSource !== 'ai_estimated' && <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">cost only</span>}
                              {rec.trend === 'rising' && <span className="text-xs text-green-600">📈 rising</span>}
                              {rec.trend === 'falling' && <span className="text-xs text-red-500">📉 falling</span>}
                              {rec.hasCompData && rec.sampleSize > 0 && (
                                <span className={`text-xs px-1.5 py-0.5 rounded ${rec.confidence === 'high' ? 'bg-green-100 text-green-700' : rec.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                                  n={rec.sampleSize}
                                </span>
                              )}
                            </div>
                            {rec.hasCompData ? (
                              <>
                                <p className="text-xs text-gray-500 mt-0.5">
                                  Cost: {fmt(rec.cost)}{rec.measuredCostRange ? ` (${fmt(rec.measuredCostRange.low)}–${fmt(rec.measuredCostRange.high)})` : ''} → <span className={`font-semibold ${rec.equityCreated >= 0 ? 'text-green-700' : 'text-red-600'}`}>{rec.equityCreated >= 0 ? '+' : ''}{fmt(rec.equityCreated)} instant equity</span> ({rec.equityMultiple?.toFixed(1)}× value return)
                                </p>
                                {rec.equityCreated < 0 && (
                                  <p className="text-[10px] text-red-500 mt-0.5">
                                    ⚠️ Cost exceeds comparable value uplift — consider only for rent income or if you expect market appreciation
                                  </p>
                                )}
                                <p className="text-xs text-gray-400">
                                  +{fmt(rec.valueAdd)} comp value uplift, +{fmt(rec.rentIncrease)}/mo cap-rate rent{rec.paybackMonths < 999 ? ` (${rec.paybackMonths}mo rent payback)` : ''}
                                </p>
                              </>
                            ) : (
                              <p className="text-xs text-gray-500 mt-0.5">
                                Cost: {fmt(rec.cost)}{rec.measuredCostRange ? ` (${fmt(rec.measuredCostRange.low)}–${fmt(rec.measuredCostRange.high)})` : ''} — {hasMeasurement ? 'DAv3 measured cost' : 'estimated cost'} (no regional comp uplift data for this type)
                              </p>
                            )}
                          </div>
                          <div className="text-right flex-shrink-0">
                            {rec.hasCompData ? (
                              <>
                                <p className={`text-sm font-bold ${rec.equityMultiple >= 2 ? 'text-green-600' : rec.equityMultiple >= 1.5 ? 'text-blue-600' : rec.equityMultiple >= 1 ? 'text-gray-700' : 'text-red-500'}`}>
                                  {rec.equityMultiple?.toFixed(1)}× value
                                </p>
                                <p className="text-xs text-gray-500">
                                  {typeof rec.roi === 'number' ? `${pct(rec.roi)} ROI` : `${pct(rec.valueROI)} est. ROI`}
                                  {rec.roiWasCapped && <span className="text-amber-500 ml-1" title="ROI was capped — raw comp uplift data suggested a higher return">⚠ capped</span>}
                                </p>
                              </>
                            ) : (
                              <p className="text-sm font-bold text-gray-500">{fmt(rec.cost)}</p>
                            )}
                            <p className="text-[10px] text-gray-400 mt-0.5">▼ details</p>
                          </div>
                        </div>
                        {rec.wedgeLabel && (
                          <div className="mt-1.5 ml-12 text-xs text-green-700 bg-green-50 rounded px-2 py-1 border border-green-100">
                            {rec.wedgeLabel}
                          </div>
                        )}
                      </summary>

                      {/* Expanded detail — DAv3 measurements + material/labor breakdown */}
                      <div className="px-3 pb-3 border-t border-gray-100 mt-1 pt-3 space-y-3">
                        {/* Source Photos — the MLS photos that matched this renovation's room */}
                        {(() => {
                          const photoIdxs: number[] = roomMeasurements?.sourcePhotoIndexes || md?.measurements?.sourcePhotoIndexes || [];
                          if (photoIdxs.length === 0 || allPhotos.length === 0) return null;
                          const urls = photoIdxs.map(idx => allPhotos[idx]).filter(Boolean);
                          if (urls.length === 0) return null;
                          return (
                            <div className="rounded border border-sky-200 bg-sky-50 p-2">
                              <p className="text-[11px] font-semibold text-sky-700 uppercase tracking-wide mb-1">📷 Source Photos ({urls.length})</p>
                              <div className="flex gap-2 overflow-x-auto">
                                {urls.slice(0, 6).map((url, pi) => (
                                  <img key={pi} src={url} alt={`Room photo ${pi + 1}`} className="h-20 w-auto rounded border border-sky-200 object-cover flex-shrink-0" loading="lazy" />
                                ))}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Adjustment Factors Applied */}
                        {rec.adjustments && rec.hasCompData && (
                          <div className="rounded border border-amber-200 bg-amber-50/60 p-2">
                            <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide mb-1">⚙️ Adjustment Factors Applied</p>
                            <div className="flex flex-wrap gap-1.5">
                              {rec.adjustments.marketHeatAdj !== 1.0 && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                                  rec.adjustments.marketHeatAdj > 1 ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'
                                }`}>
                                  🌡️ Market Heat: ×{rec.adjustments.marketHeatAdj.toFixed(3)} equity
                                  {rec.adjustments.heatLabel && ` (${rec.adjustments.heatLabel})`}
                                </span>
                              )}
                              {rec.adjustments.marketHeatRentAdj !== 1.0 && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                                  rec.adjustments.marketHeatRentAdj > 1 ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'
                                }`}>
                                  🏠 Market Rent: ×{rec.adjustments.marketHeatRentAdj.toFixed(3)}
                                </span>
                              )}
                              {rec.adjustments.seasonalAdj !== 1.0 && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                                  rec.adjustments.seasonalAdj > 1 ? 'bg-green-50 text-green-700 border-green-200' : 'bg-blue-50 text-blue-700 border-blue-200'
                                }`}>
                                  📅 Seasonal: ×{rec.adjustments.seasonalAdj.toFixed(3)}
                                  {rec.adjustments.seasonalAdj > 1 ? ' (peak season)' : ' (off-season)'}
                                </span>
                              )}
                              {rec.adjustments.stratTierSource && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border bg-purple-50 text-purple-700 border-purple-200 font-medium">
                                  📊 Stratified: {rec.adjustments.stratTierSource}
                                </span>
                              )}
                              {rec.adjustments.conditionAdj !== 1.0 && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                                  rec.adjustments.conditionAdj > 1 ? 'bg-green-50 text-green-700 border-green-200' : 'bg-orange-50 text-orange-700 border-orange-200'
                                }`}>
                                  🔧 Condition: ×{rec.adjustments.conditionAdj.toFixed(2)}
                                </span>
                              )}
                              {rec.adjustments.sizeAdj !== 1.0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border bg-sky-50 text-sky-700 border-sky-200 font-medium">
                                  📐 Size: ×{rec.adjustments.sizeAdj.toFixed(2)}
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {/* AI Detection Context — shown for AI-estimated items (no comp data) */}
                        {rec.aiDetectionDetail && (
                          <div className="rounded border border-purple-200 bg-purple-50/60 p-2">
                            <p className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide mb-1">🤖 AI Detection Details</p>
                            <div className="text-xs text-purple-900 space-y-1">
                              <p><span className="font-medium">Area:</span> {rec.aiDetectionDetail.area} — <span className="font-medium">Type:</span> {rec.aiDetectionDetail.type}</p>
                              <p><span className="font-medium">Scope:</span> {rec.aiDetectionDetail.scope} • <span className="font-medium">Priority:</span> {rec.aiDetectionDetail.priority || 'not set'} • <span className="font-medium">Confidence:</span> {rec.aiDetectionDetail.confidence ? `${Math.round(rec.aiDetectionDetail.confidence * 100)}%` : '—'}</p>
                              {rec.aiDetectionDetail.description && <p className="text-[10px] text-purple-700 italic">{rec.aiDetectionDetail.description}</p>}
                              {rec.aiDetectionDetail.estimatedCost && <p><span className="font-medium">GPT-4o Cost Range:</span> {rec.aiDetectionDetail.estimatedCost}</p>}
                              <p className="text-[10px] text-purple-500 mt-1">⚠️ Value uplift estimated at 70% of cost (conservative avg). Run more regional comps for data-backed uplift.</p>
                            </div>
                          </div>
                        )}

                        {/* Data source boxes */}
                        <div className={`grid gap-2 text-xs ${rec.hasCompData ? 'grid-cols-3' : 'grid-cols-2'}`}>
                          {rec.hasCompData && (
                            <div className="bg-violet-50 rounded p-2 text-center">
                              <p className="text-gray-500">Value Uplift</p>
                              <p className="font-bold text-violet-700">{fmt(rec.valueAdd)}</p>
                              <p className="text-[10px] text-violet-500">
                                from {rec.sampleSize} sale comp{rec.sampleSize !== 1 ? 's' : ''}
                                {rec.sampleSize >= 10 ? ' ✓' : rec.sampleSize >= 5 ? '' : ' ⚠️'}
                              </p>
                            </div>
                          )}
                          <div className={`rounded p-2 text-center ${hasMeasurement ? 'bg-indigo-50' : 'bg-gray-50'}`}>
                            <p className="text-gray-500">Cost</p>
                            <p className={`font-bold ${hasMeasurement ? 'text-indigo-700' : 'text-gray-700'}`}>{fmt(rec.cost)}</p>
                            <p className="text-[10px] text-gray-500">{hasMeasurement ? 'DAv3 measured' : rec.roiSource === 'ai_estimated' ? 'GPT-4o estimated' : 'regional estimate'}</p>
                          </div>
                          {rec.hasCompData && (
                            <div className="bg-blue-50 rounded p-2 text-center">
                              <p className="text-gray-500">Rent +/mo</p>
                              <p className="font-bold text-blue-700">{fmt(rec.rentIncrease)}</p>
                              <p className="text-[10px] text-blue-500">cap-rate derived</p>
                            </div>
                          )}
                        </div>

                        {/* Photo Measurements (DAv3) */}
                        {roomMeasurements?.measured && (() => {
                          const dims = roomMeasurements.roomDimensions;
                          const isPaintReno = normalizeRenoType(rec.renovationType).includes('paint') || normalizeRenoType(rec.displayName || '').includes('paint');

                          // Use real measured opening data from GPT-4o room envelope when available
                          const hasEnvelopeData = dims?.wallAreaGrossSqFt != null && dims?.wallOpeningAreaSqFt != null;
                          const grossWall = hasEnvelopeData
                            ? dims.wallAreaGrossSqFt!
                            : (dims?.wallAreaSqFt || (dims?.widthFt && dims?.lengthFt && dims?.heightFt
                              ? Math.round(2 * ((dims.widthFt || 0) + (dims.lengthFt || 0)) * (dims.heightFt || 8))
                              : null));
                          const measuredOpeningArea = hasEnvelopeData ? dims.wallOpeningAreaSqFt! : null;
                          // Paintable = net wall area (already computed by server when wallAreaIncludesOpenings===false)
                          // or gross minus measured openings, or null if no data
                          const paintableArea = hasEnvelopeData
                            ? Math.round((dims.wallAreaSqFt ?? (grossWall! - measuredOpeningArea!)))
                            : (grossWall != null ? grossWall : null); // no deduction without measurement
                          const openingPct = grossWall && measuredOpeningArea ? Math.round((measuredOpeningArea / grossWall) * 100) : null;

                          return (
                            <div className="rounded border border-blue-200 bg-blue-50 p-2">
                              <p className="text-[11px] font-semibold text-blue-700 uppercase tracking-wide mb-1">📐 Photo Measurements (DAv3)</p>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-blue-900">
                                <div>Room: {roomMeasurements.roomType || '—'}</div>
                                {isPaintReno && grossWall ? (
                                  <>
                                    <div>Gross Wall Area: {grossWall} sq ft</div>
                                    {measuredOpeningArea != null ? (
                                      <div>
                                        <span className="font-semibold text-blue-700">Paintable Area: {paintableArea} sq ft</span>
                                        <span className="text-[10px] text-blue-500 ml-1">(−{measuredOpeningArea} sq ft windows/doors, {openingPct}%)</span>
                                      </div>
                                    ) : (
                                      <div>
                                        <span className="font-semibold text-blue-700">Wall Area: {grossWall} sq ft</span>
                                        <span className="text-[10px] text-orange-500 ml-1">(window/door openings not measured)</span>
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <div>Floor: {dims?.floorAreaSqFt || '—'} sq ft</div>
                                )}
                                <div>Size: {dims?.widthFt || '—'}' × {dims?.lengthFt || '—'}'{dims?.heightFt ? ` × ${dims.heightFt}'h` : ''}</div>
                                <div>Confidence: {md?.confidence || roomMeasurements.confidence || '—'}</div>
                              </div>
                              {isPaintReno && paintableArea && measuredOpeningArea != null && (
                                <p className="text-[10px] text-blue-600 mt-1">
                                  🎨 Paint estimate: ~{Math.ceil(paintableArea / 350)} gallons needed (350 sq ft/gal coverage) • {Math.ceil(paintableArea / 350) * 2} gal for 2 coats + {Math.ceil(paintableArea / 300)} gal primer
                                </p>
                              )}
                              {isPaintReno && grossWall && measuredOpeningArea == null && (
                                <p className="text-[10px] text-orange-500 mt-1">
                                  ⚠️ Upload multiple room photos showing windows &amp; doors for accurate paintable area — opening deductions are measured from photos, not estimated
                                </p>
                              )}
                            </div>
                          );
                        })()}

                        {/* Object Measurements (appliances, fixtures, specific dimensions) */}
                        {objectMeasurements && objectMeasurements.length > 0 && (
                          <div className="rounded border border-purple-200 bg-purple-50 p-2">
                            <p className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide mb-1">📏 Object Measurements ({objectMeasurements.length})</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                              {objectMeasurements.map((obj: any, oi: number) => (
                                <div key={oi} className="text-xs bg-white border rounded px-2 py-1 text-gray-700 flex flex-col gap-0.5">
                                  <div className="flex justify-between">
                                    <span className="font-medium">{(obj.description || obj.type || 'object').replace(/_/g, ' ')}</span>
                                    <span className="text-gray-500">
                                      {obj.dimensions?.widthInches && `${obj.dimensions.widthInches}"W`}
                                      {obj.dimensions?.heightInches && ` × ${obj.dimensions.heightInches}"H`}
                                      {obj.dimensions?.depthInches && ` × ${obj.dimensions.depthInches}"D`}
                                    </span>
                                  </div>
                                  {obj.applianceFit && (
                                    <div className="text-[10px] text-purple-600">
                                      Fits: {obj.applianceFit.recommendedSize ? `${obj.applianceFit.recommendedSize}" standard` : 'non-standard'}
                                      {obj.applianceFit.note && ` — ${obj.applianceFit.note}`}
                                    </div>
                                  )}
                                  {obj.sanityClamped && <span className="text-[10px] text-orange-500">⚠️ Dimensions adjusted to realistic range</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Itemized Material Breakdown */}
                        {mats && mats.length > 0 && (
                          <div>
                            <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide mb-1">🧱 Itemized Materials ({mats.length})</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                              {mats.slice(0, 20).map((m: any, mi: number) => (
                                <div key={mi} className="text-xs bg-gray-50 border rounded px-2 py-1 text-gray-700 flex justify-between gap-2">
                                  <span className="flex-1">
                                    {m.item || m.category || 'material'}
                                    {m.wastePercent ? <span className="text-[10px] text-orange-500 ml-1">(+{m.wastePercent}% waste)</span> : null}
                                    {m.room ? <span className="text-[10px] text-gray-400 ml-1">[{m.room}]</span> : null}
                                  </span>
                                  <span className="text-gray-500 flex-shrink-0">{m.quantity || '—'} {m.unit?.replace(/_/g, ' ') || ''} • {fmt(m.totalCost || 0)}</span>
                                </div>
                              ))}
                            </div>
                            {mats.length > 20 && <p className="text-[10px] text-gray-400 mt-1">+ {mats.length - 20} more items...</p>}
                            {mats.some((m: any) => m.wastePercent) && (
                              <p className="text-[10px] text-gray-400 mt-1 italic">
                                💡 Material quantities include waste factor (cuts, breakage, pattern matching). Flooring: +10-15% over floor area. Tile: +15%.
                              </p>
                            )}
                          </div>
                        )}

                        {/* Labor Breakdown */}
                        {labor && labor.length > 0 && (
                          <div>
                            <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide mb-1">👷 Labor ({labor.length})</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                              {labor.slice(0, 16).map((l: any, li: number) => (
                                <div key={li} className="text-xs bg-gray-50 border rounded px-2 py-1 text-gray-700 flex justify-between gap-2">
                                  <span className="flex-1">
                                    {l.task || l.trade || l.item || l.description || `Labor task ${li + 1}`}
                                    {l.tradeType && <span className="text-[10px] text-gray-400 ml-1">({l.tradeType.replace(/_/g, ' ')})</span>}
                                  </span>
                                  <span className="text-gray-500 flex-shrink-0">
                                    {l.hours || l.estimatedHours || 0}h
                                    {(l.hourlyRate || l.rate) ? ` @ ${fmt(l.hourlyRate || l.rate)}/hr` : ''}
                                     • {fmt(l.totalCost || l.cost || 0)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Timeframe */}
                        {md?.timeframe && (
                          <p className="text-xs text-gray-500">⏱ Estimated timeframe: {md.timeframe}</p>
                        )}

                        {/* Source explanation for items without photo measurement */}
                        {!hasMeasurement && rec.hasCompData && (
                          <p className="text-xs text-gray-400 italic">💡 This renovation type shows strong ROI in your area based on {rec.sampleSize} comparable sales. Cost estimated from regional data — get a precise cost with material/labor breakdown by uploading property photos.</p>
                        )}
                        {!rec.hasCompData && (
                          <p className="text-xs text-orange-500 italic">⚠️ No regional comp data available for this renovation type in your ZIP code. Cost is from DAv3 photo measurement — value uplift and rent impact cannot be estimated without comparable sale data.</p>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>

              {/* Equity & Returns Summary */}
              {combinedAnalysis.recommendations.length > 0 && (
                <div className="mt-4 bg-white rounded-lg p-4 shadow-sm">
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">5-Year Investment Summary</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500">Instant Equity</span>
                      <p className="font-bold text-green-700">{fmt(combinedAnalysis.totals.valueAdd - combinedAnalysis.totals.cost)}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">5-Yr Rental Income</span>
                      <p className="font-bold text-blue-700">{fmt(combinedAnalysis.totals.rentIncrease * 12 * 5)}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">Total 5-Yr Return</span>
                      <p className="font-bold text-violet-700">{fmt((combinedAnalysis.totals.valueAdd - combinedAnalysis.totals.cost) + (combinedAnalysis.totals.rentIncrease * 12 * 5))}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">Comparables Used</span>
                      <p className="font-bold">{combinedAnalysis.comparablesUsed}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Raw Data (collapsible) */}
          {(processingResult || areaSummary) && (
            <details className="bg-white border rounded-xl overflow-hidden">
              <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-gray-600 hover:bg-gray-50">
                🔍 Raw Data (debug)
              </summary>
              <div className="px-5 pb-4 space-y-3">
                {processingResult && (
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 mb-1">Processing Result</h4>
                    <pre className="bg-gray-900 text-green-400 p-3 rounded-lg overflow-auto max-h-48 text-xs">{JSON.stringify(processingResult, null, 2)}</pre>
                  </div>
                )}
                {areaSummary && (
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 mb-1">Area Summary</h4>
                    <pre className="bg-gray-900 text-green-400 p-3 rounded-lg overflow-auto max-h-48 text-xs">{JSON.stringify(areaSummary, null, 2)}</pre>
                  </div>
                )}
              </div>
            </details>
          )}

          {/* Empty state */}
          {steps.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <div className="text-6xl mb-4">🏠</div>
              <p className="text-lg font-medium">Enter an address and run the pipeline</p>
              <p className="text-sm mt-1">Tests: ATTOM → Zillow Photos → GPT-4o Vision → Regional Uplift → Combined ROI</p>
            </div>
          )}
        </div>

        {/* ─── Footer ─── */}
        <div className="px-6 py-3 border-t bg-gray-50 text-xs text-gray-500 flex justify-between items-center">
          <span>
            {property ? `${property.city}, ${property.state} ${property.zipCode}` : 'No property loaded'}
            {areaSummary ? ` • ${areaSummary.totalComparables || 0} area comps` : ''}
          </span>
          <button onClick={onClose} className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 transition text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default RegionalRenovationTestModal;
