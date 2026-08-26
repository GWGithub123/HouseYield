import {
  HEALTH_EVIDENCE_RANK,
  PROPERTY_HEALTH_CATEGORY_META,
  resolveAssetAgeYears,
  resolveUsefulLifeYears,
  type HealthEvidence,
  type PropertyHealthAsset,
  type PropertyHealthCategory,
} from '../types/propertyHealth';
import {
  summarizeComponentCosts,
  type ComponentCostSummary,
} from './propertyHealthDocuments';

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

export type MaintenanceUrgency = 'routine' | 'plan' | 'soon' | 'urgent' | 'verify';
export type MaintenanceAction = 'inspect' | 'service' | 'replace' | 'confirm';

/**
 * Reliability research cached for an identified make/model.
 *
 * The forecast accepts this shape now even when the registry has no match. That
 * keeps product research additive: learning a model's observed median life sharpens
 * the same forecast instead of creating a second, contradictory recommendation.
 */
export interface ComponentModelProfile {
  id: string;
  category: PropertyHealthCategory;
  make: string;
  model: string;
  reliabilityScore?: number | null;
  observedMedianLifeYears?: number | null;
  observedSampleSize?: number | null;
  recallCount?: number | null;
  reviewSummary?: string | null;
  failureModes?: string[];
  installationPitfalls?: string[];
  maintenanceRecommendations?: string[];
  recallNotes?: string[];
  sourceUrls?: string[];
  confidence?: number | null;
  researchedAt: string;
}

export interface PropertyMaintenanceExposure {
  coastal: boolean;
  freezeClimate: boolean;
  humidClimate: boolean;
  rationale: string[];
}

export interface PropertyExposureInput {
  address?: string | null;
  state?: string | null;
  county?: string | null;
}

export interface ForecastDriver {
  kind: 'age' | 'evidence' | 'exposure' | 'history' | 'model' | 'material';
  label: string;
  impact: 'raises' | 'lowers' | 'uncertainty';
}

export interface MaintenanceWindow {
  earliest: string;
  likely: string;
  latest: string;
}

export interface ComponentMaintenanceForecast {
  assetId: string;
  category: PropertyHealthCategory;
  name: string;
  urgency: MaintenanceUrgency;
  action: MaintenanceAction;
  riskScore: number;
  confidence: number;
  /** Conditional chance of failure in the next 24 months, if age is known. */
  failureProbability24m: number | null;
  ageYears: number | null;
  effectiveLifeYears: number;
  serviceBy: string;
  window: MaintenanceWindow | null;
  estimatedCostLowUsd: number;
  estimatedCostHighUsd: number;
  headline: string;
  recommendation: string;
  drivers: ForecastDriver[];
  dataGaps: string[];
  failureModes: string[];
}

export interface PropertyMaintenanceForecast {
  generatedAt: string;
  components: ComponentMaintenanceForecast[];
  nextActions: ComponentMaintenanceForecast[];
  budget12mLowUsd: number;
  budget12mHighUsd: number;
  budget24mLowUsd: number;
  budget24mHighUsd: number;
  urgentCount: number;
  soonCount: number;
  unknownCount: number;
}

const FREEZE_STATES = new Set([
  'AK', 'CO', 'CT', 'DE', 'IA', 'ID', 'IL', 'IN', 'KS', 'MA', 'MD', 'ME', 'MI',
  'MN', 'MO', 'MT', 'ND', 'NE', 'NH', 'NJ', 'NY', 'OH', 'OR', 'PA', 'RI', 'SD',
  'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
]);

/**
 * Coarse exposure inference used only as a forecast modifier, never as observed
 * condition. The rationale is returned so the UI can say exactly why it applied.
 */
export function inferPropertyMaintenanceExposure(
  input: PropertyExposureInput,
): PropertyMaintenanceExposure {
  const place = [input.address, input.county, input.state].filter(Boolean).join(' ');
  const state = (input.state || '').trim().toUpperCase();
  const coastal = /\b(beach|coast|ocean|bay|island|rehoboth|lewes|sussex)\b/i.test(place);
  const freezeClimate = FREEZE_STATES.has(state);
  const humidClimate = coastal || /\b(DE|FL|GA|LA|MD|MS|NC|SC|TX|VA)\b/i.test(state);
  const rationale: string[] = [];
  if (coastal) rationale.push('Coastal salt, wind, and moisture exposure inferred from location.');
  if (freezeClimate) rationale.push('Seasonal freezing conditions are typical for this state.');
  if (humidClimate) rationale.push('A humid climate increases moisture and corrosion exposure.');
  return { coastal, freezeClimate, humidClimate, rationale };
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function addYears(date: Date, years: number): Date {
  return new Date(date.getTime() + years * YEAR_MS);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalized(value?: string | null): string {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function findComponentModelProfile(
  asset: PropertyHealthAsset,
  profiles: ComponentModelProfile[],
): ComponentModelProfile | null {
  const make = normalized(asset.make);
  const model = normalized(asset.model);
  if (!make || !model) return null;
  return profiles.find((profile) =>
    profile.category === asset.category
    && normalized(profile.make) === make
    && normalized(profile.model) === model
  ) ?? null;
}

/**
 * Blend generic useful life with observed model life.
 *
 * A small review sample should inform the baseline, not replace it. At 100+
 * observed units and high reliability it can carry 70% of the estimate; at five
 * units it barely moves it. This is the feedback loop from model research into
 * every age, failure-window, and budget calculation.
 */
export function resolveForecastUsefulLifeYears(
  asset: PropertyHealthAsset,
  profile?: ComponentModelProfile | null,
): number {
  const baseline = resolveUsefulLifeYears(asset);
  const observed = profile?.observedMedianLifeYears;
  if (typeof observed !== 'number' || !Number.isFinite(observed) || observed <= 0) {
    return baseline;
  }
  const sample = Math.max(0, profile?.observedSampleSize ?? 0);
  const reliability = clamp((profile?.reliabilityScore ?? 60) / 100);
  const sampleWeight = clamp(Math.log10(sample + 1) / 2, 0, 1);
  const weight = Math.min(0.7, sampleWeight * reliability * 0.7);
  return Math.round((baseline * (1 - weight) + observed * weight) * 10) / 10;
}

function evidenceConfidence(asset: PropertyHealthAsset): number {
  const evidence: HealthEvidence = asset.provenance?.installedAt?.evidence
    ?? asset.evidence
    ?? 'owner';
  const explicit = asset.provenance?.installedAt?.confidence;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return clamp(explicit);
  const rank = HEALTH_EVIDENCE_RANK[evidence];
  return [0.42, 0.62, 0.74, 0.8, 0.9, 0.96][rank] ?? 0.5;
}

function exposureLifeFactor(
  category: PropertyHealthCategory,
  exposure: PropertyMaintenanceExposure,
): { factor: number; drivers: ForecastDriver[] } {
  let factor = 1;
  const drivers: ForecastDriver[] = [];
  if (exposure.coastal && ['roof', 'exterior', 'hvac', 'electrical'].includes(category)) {
    factor *= category === 'exterior' ? 0.84 : 0.9;
    drivers.push({
      kind: 'exposure',
      label: 'Coastal salt, wind, and moisture shorten the expected service interval.',
      impact: 'raises',
    });
  }
  if (exposure.freezeClimate && category === 'plumbing') {
    factor *= 0.92;
    drivers.push({
      kind: 'exposure',
      label: 'Freeze-thaw cycles increase supply-line and fitting stress.',
      impact: 'raises',
    });
  }
  if (exposure.humidClimate && ['hvac', 'water_heater', 'exterior'].includes(category)) {
    factor *= 0.96;
    drivers.push({
      kind: 'exposure',
      label: 'Humidity increases corrosion and moisture-related wear.',
      impact: 'raises',
    });
  }
  return { factor, drivers };
}

/**
 * Conditional Weibull probability: chance of failure in `horizonYears` given
 * that the component has survived to its current age.
 *
 * The useful-life estimate is treated as the median, not a hard expiry date. That
 * avoids the old cliff where a component changed from healthy to failed on one
 * birthday. Shape 3 produces a broad wear-out curve suitable for building systems;
 * this remains a planning estimate and confidence is reported separately.
 */
export function conditionalFailureProbability(
  ageYears: number,
  medianLifeYears: number,
  horizonYears = 2,
): number {
  if (medianLifeYears <= 0 || horizonYears <= 0) return 0;
  const shape = 3;
  const scale = medianLifeYears / Math.pow(Math.log(2), 1 / shape);
  const cumulativeHazard = (age: number) => Math.pow(Math.max(0, age) / scale, shape);
  return clamp(
    1 - Math.exp(-(cumulativeHazard(ageYears + horizonYears) - cumulativeHazard(ageYears))),
  );
}

function latestRelevantEvent(asset: PropertyHealthAsset, kinds: Set<string>): Date | null {
  const dates = (asset.spend ?? [])
    .filter((event) => kinds.has(event.workKind))
    .map((event) => new Date(event.occurredAt))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return dates[0] ?? null;
}

function costRange(asset: PropertyHealthAsset, action: MaintenanceAction): [number, number] {
  const replacement = PROPERTY_HEALTH_CATEGORY_META[asset.category].typicalReplacementUsd;
  if (action === 'confirm') return [0, 250];
  if (action === 'inspect') return [Math.max(75, replacement * 0.015), Math.max(250, replacement * 0.04)];
  if (action === 'service') return [Math.max(50, replacement * 0.025), Math.max(300, replacement * 0.1)];
  return [replacement * 0.8, replacement * 1.3];
}

function replacementWindow(
  asset: PropertyHealthAsset,
  age: number,
  life: number,
  now: Date,
): MaintenanceWindow {
  const install = asset.installedAt && !Number.isNaN(Date.parse(asset.installedAt))
    ? new Date(asset.installedAt)
    : addYears(now, -age);
  const earliest = addYears(install, life * 0.8);
  const likely = addYears(install, life);
  const latest = addYears(install, life * 1.25);
  return {
    earliest: isoDay(earliest < now ? now : earliest),
    likely: isoDay(likely < now ? now : likely),
    latest: isoDay(latest < now ? now : latest),
  };
}

function recommendationFor(
  asset: PropertyHealthAsset,
  action: MaintenanceAction,
  profile: ComponentModelProfile | null,
): string {
  const profileTask = profile?.maintenanceRecommendations?.[0];
  if (action === 'confirm') {
    return 'Confirm the install date or upload a data-plate photo before relying on replacement timing.';
  }
  if (action === 'replace') {
    return `Get replacement quotes and inspect for active failure signs now.${profileTask ? ` ${profileTask}` : ''}`;
  }
  if (action === 'service') {
    if (asset.category === 'air_filter' || asset.category === 'water_filter') {
      return `Replace the ${asset.name.toLowerCase()} and record the date to reset its service interval.`;
    }
    return `Schedule preventive service and document measured condition.${profileTask ? ` ${profileTask}` : ''}`;
  }
  return `Inspect ${asset.name.toLowerCase()} for the listed failure modes and update its condition evidence.`;
}

export function forecastComponentMaintenance(
  asset: PropertyHealthAsset,
  options: {
    now?: Date;
    exposure?: PropertyMaintenanceExposure;
    profile?: ComponentModelProfile | null;
    cost?: ComponentCostSummary | null;
  } = {},
): ComponentMaintenanceForecast {
  const now = options.now ?? new Date();
  const exposure = options.exposure ?? {
    coastal: false,
    freezeClimate: false,
    humidClimate: false,
    rationale: [],
  };
  const profile = options.profile ?? null;
  const cost = options.cost ?? summarizeComponentCosts([asset], now)[0] ?? null;
  const age = resolveAssetAgeYears(asset, now);
  const confidence = evidenceConfidence(asset);
  const baseLife = resolveForecastUsefulLifeYears(asset, profile);
  const exposureAdjustment = exposureLifeFactor(asset.category, exposure);
  let effectiveLife = baseLife * exposureAdjustment.factor;
  const drivers: ForecastDriver[] = [...exposureAdjustment.drivers];
  const dataGaps: string[] = [];

  if (asset.riskFlag) {
    effectiveLife *= asset.riskFlag.severity === 'critical' ? 0.75 : asset.riskFlag.severity === 'warn' ? 0.87 : 0.95;
    drivers.push({ kind: 'material', label: asset.riskFlag.detail, impact: 'raises' });
  }
  effectiveLife = Math.max(0.08, Math.round(effectiveLife * 10) / 10);

  if (profile?.observedMedianLifeYears) {
    drivers.push({
      kind: 'model',
      label: `Observed model life: ${profile.observedMedianLifeYears} years across ${profile.observedSampleSize ?? 'an unknown number of'} units.`,
      impact: profile.observedMedianLifeYears < resolveUsefulLifeYears(asset) ? 'raises' : 'lowers',
    });
  }
  if (typeof profile?.reliabilityScore === 'number') {
    drivers.push({
      kind: 'model',
      label: `Model reliability evidence scores ${Math.round(profile.reliabilityScore)}/100${profile.reviewSummary ? `: ${profile.reviewSummary}` : '.'}`,
      impact: profile.reliabilityScore < 55 ? 'raises' : profile.reliabilityScore >= 75 ? 'lowers' : 'uncertainty',
    });
  }
  if ((profile?.recallCount ?? 0) > 0) {
    drivers.push({
      kind: 'model',
      label: `${profile!.recallCount} recall${profile!.recallCount === 1 ? '' : 's'} found for this model family; verify applicability.`,
      impact: 'raises',
    });
  }

  if (age == null) dataGaps.push('Install date or approximate age');
  if (!asset.make) dataGaps.push('Manufacturer');
  if (!asset.model) dataGaps.push('Model number');
  if ((asset.evidence ?? 'owner') === 'inferred') {
    drivers.push({
      kind: 'evidence',
      label: 'Age and component details are inferred, so timing confidence is limited.',
      impact: 'uncertainty',
    });
  }

  const ratio = age == null ? null : age / effectiveLife;
  const failureProbability24m = age == null
    ? null
    : conditionalFailureProbability(age, effectiveLife, 2);
  if (ratio != null) {
    drivers.unshift({
      kind: 'age',
      label: `${Math.round(ratio * 100)}% of the adjusted service life has been consumed.`,
      impact: ratio >= 0.6 ? 'raises' : 'lowers',
    });
  }

  const repairShare = cost?.replacementUsd
    ? cost.repairSpendUsd / cost.replacementUsd
    : 0;
  const repairCount = (asset.spend ?? []).filter((event) => event.workKind === 'repair').length;
  if (repairCount > 0) {
    drivers.push({
      kind: 'history',
      label: `${repairCount} repair${repairCount === 1 ? '' : 's'} totaling $${Math.round(cost?.repairSpendUsd ?? 0).toLocaleString()}.`,
      impact: repairShare >= 0.25 ? 'raises' : 'uncertainty',
    });
  }
  const recentService = latestRelevantEvent(asset, new Set(['service', 'inspect']));
  if (recentService && (now.getTime() - recentService.getTime()) / YEAR_MS <= 1) {
    drivers.push({
      kind: 'history',
      label: `Preventive service recorded ${recentService.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}.`,
      impact: 'lowers',
    });
  }
  const visual = asset.visualCondition;
  const visualCritical = Boolean(
    visual
    && visual.confidence >= 0.65
    && (
      visual.score <= 30
      || visual.observations.some((observation) => observation.severity === 'critical')
    ),
  );
  if (visual) {
    drivers.push({
      kind: 'evidence',
      label: `Latest accepted photo scored visible condition ${Math.round(visual.score)}/100 at ${Math.round(visual.confidence * 100)}% confidence.`,
      impact: visual.score < 60 ? 'raises' : visual.score >= 80 ? 'lowers' : 'uncertainty',
    });
  }

  const consequence = PROPERTY_HEALTH_CATEGORY_META[asset.category].consequence;
  let riskScore = failureProbability24m == null
    ? 20 + consequence * 3
    : failureProbability24m * 55 + clamp(ratio ?? 0, 0, 1.4) * 20 + consequence * 4;
  riskScore += Math.min(20, repairShare * 25);
  if (asset.riskFlag?.severity === 'critical') riskScore += 18;
  else if (asset.riskFlag?.severity === 'warn') riskScore += 10;
  if (visual) riskScore += Math.max(-6, (60 - visual.score) * 0.32 * visual.confidence);
  if (recentService) riskScore -= 5;
  riskScore = Math.round(clamp(riskScore, 0, 100));

  const filter = asset.category === 'air_filter' || asset.category === 'water_filter';
  let urgency: MaintenanceUrgency;
  let action: MaintenanceAction;
  let serviceBy: Date;

  if (age == null && visualCritical) {
    urgency = 'urgent';
    action = 'inspect';
    serviceBy = addYears(now, 14 / 365.25);
  } else if (age == null) {
    urgency = 'verify';
    action = 'confirm';
    serviceBy = addYears(now, 0.25);
  } else if (filter && ratio! >= 1) {
    urgency = 'urgent';
    action = 'service';
    serviceBy = addYears(now, 14 / 365.25);
  } else if (
    ratio! >= 1
    || asset.riskFlag?.severity === 'critical'
    || cost?.replaceSignal
  ) {
    urgency = 'urgent';
    action = 'replace';
    serviceBy = addYears(now, 30 / 365.25);
  } else if (visualCritical) {
    urgency = 'urgent';
    action = 'inspect';
    serviceBy = addYears(now, 14 / 365.25);
  } else if (ratio! >= 0.85 || (failureProbability24m ?? 0) >= 0.45) {
    urgency = 'soon';
    action = filter ? 'service' : 'replace';
    serviceBy = addYears(now, 0.25);
  } else if (ratio! >= 0.6 || (failureProbability24m ?? 0) >= 0.2) {
    urgency = 'plan';
    action = filter ? 'service' : 'inspect';
    serviceBy = addYears(now, 1);
  } else {
    urgency = 'routine';
    action = filter ? 'service' : 'inspect';
    // Roof imagery is cheap to refresh and degradation is only useful as a trend,
    // so keep its observation cadence annual even when replacement risk is low.
    serviceBy = addYears(now, asset.category === 'roof' ? 1 : 2);
  }

  const [estimatedCostLowUsd, estimatedCostHighUsd] = costRange(asset, action);
  const window = age == null ? null : replacementWindow(asset, age, effectiveLife, now);
  const headline = urgency === 'verify'
    ? 'Confirm before forecasting'
    : urgency === 'urgent'
      ? action === 'service' ? 'Service is overdue' : 'Replacement planning is overdue'
      : urgency === 'soon'
        ? `Act within ${action === 'replace' ? '3 months' : 'this season'}`
        : urgency === 'plan'
          ? 'Plan within 12 months'
          : 'No near-term intervention indicated';

  const failureModes = [
    ...(profile?.failureModes ?? []),
    ...(profile?.installationPitfalls ?? []).map((pitfall) => `Install: ${pitfall}`),
    ...(visual?.failureSigns ?? []),
    ...(visual?.wearSigns ?? []),
    ...(asset.watchFor ?? []),
  ].filter((mode, index, list) => mode && list.indexOf(mode) === index).slice(0, 6);

  return {
    assetId: asset.id,
    category: asset.category,
    name: asset.name,
    urgency,
    action,
    riskScore,
    confidence: Math.round(confidence * 100),
    failureProbability24m: failureProbability24m == null
      ? null
      : Math.round(failureProbability24m * 1000) / 1000,
    ageYears: age,
    effectiveLifeYears: effectiveLife,
    serviceBy: isoDay(serviceBy),
    window,
    estimatedCostLowUsd: Math.round(estimatedCostLowUsd),
    estimatedCostHighUsd: Math.round(estimatedCostHighUsd),
    headline,
    recommendation: recommendationFor(asset, action, profile),
    drivers,
    dataGaps,
    failureModes,
  };
}

const URGENCY_RANK: Record<MaintenanceUrgency, number> = {
  urgent: 0,
  soon: 1,
  verify: 2,
  plan: 3,
  routine: 4,
};

export function buildPropertyMaintenanceForecast(
  assets: PropertyHealthAsset[],
  options: {
    now?: Date;
    exposure?: PropertyMaintenanceExposure;
    profiles?: ComponentModelProfile[];
  } = {},
): PropertyMaintenanceForecast {
  const now = options.now ?? new Date();
  const profiles = options.profiles ?? [];
  const costByAsset = new Map(
    summarizeComponentCosts(assets, now).map((summary) => [summary.assetId, summary]),
  );
  const components = assets
    .filter((asset) => !asset.notApplicable)
    .map((asset) => forecastComponentMaintenance(asset, {
      now,
      exposure: options.exposure,
      profile: findComponentModelProfile(asset, profiles),
      cost: costByAsset.get(asset.id),
    }))
    .sort((a, b) =>
      URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
      || b.riskScore - a.riskScore
      || a.name.localeCompare(b.name)
    );

  const withinMonths = (forecast: ComponentMaintenanceForecast, months: number) =>
    Date.parse(forecast.serviceBy) <= addYears(now, months / 12).getTime();
  const actionable = (forecast: ComponentMaintenanceForecast) => forecast.action !== 'confirm';
  const budget = (months: number, bound: 'low' | 'high') => components
    .filter((forecast) => actionable(forecast) && withinMonths(forecast, months))
    .reduce(
      (sum, forecast) =>
        sum + (bound === 'low' ? forecast.estimatedCostLowUsd : forecast.estimatedCostHighUsd),
      0,
    );

  return {
    generatedAt: now.toISOString(),
    components,
    nextActions: components.filter((forecast) => forecast.urgency !== 'routine').slice(0, 6),
    budget12mLowUsd: budget(12, 'low'),
    budget12mHighUsd: budget(12, 'high'),
    budget24mLowUsd: budget(24, 'low'),
    budget24mHighUsd: budget(24, 'high'),
    urgentCount: components.filter((forecast) => forecast.urgency === 'urgent').length,
    soonCount: components.filter((forecast) => forecast.urgency === 'soon').length,
    unknownCount: components.filter((forecast) => forecast.urgency === 'verify').length,
  };
}

export function forecastForAsset(
  forecast: PropertyMaintenanceForecast,
  assetId: string,
): ComponentMaintenanceForecast | null {
  return forecast.components.find((component) => component.assetId === assetId) ?? null;
}
