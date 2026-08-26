import { describe, expect, it } from 'vitest';

import {
  buildPropertyMaintenanceForecast,
  conditionalFailureProbability,
  findComponentModelProfile,
  forecastComponentMaintenance,
  inferPropertyMaintenanceExposure,
  resolveForecastUsefulLifeYears,
  type ComponentModelProfile,
} from '../propertyHealthForecast';
import { createEmptyHealthAsset, type PropertyHealthAsset } from '../../types/propertyHealth';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function asset(overrides: Partial<PropertyHealthAsset> = {}): PropertyHealthAsset {
  return createEmptyHealthAsset({
    id: overrides.id || 'roof-1',
    category: overrides.category || 'roof',
    name: overrides.name || 'Roof',
    installedAt: '2006-07-27',
    evidence: 'owner',
    usefulLifeYears: 25,
    ...overrides,
  });
}

const exposure = inferPropertyMaintenanceExposure({
  address: '37418 4th Street, Rehoboth Beach',
  state: 'DE',
  county: 'Sussex',
});

describe('conditionalFailureProbability', () => {
  it('rises smoothly with age instead of flipping on one birthday', () => {
    const young = conditionalFailureProbability(5, 25, 2);
    const middle = conditionalFailureProbability(15, 25, 2);
    const old = conditionalFailureProbability(24, 25, 2);
    expect(young).toBeLessThan(middle);
    expect(middle).toBeLessThan(old);
    expect(old).toBeLessThan(1);
  });

  it('rises when the planning horizon gets longer', () => {
    expect(conditionalFailureProbability(15, 25, 1))
      .toBeLessThan(conditionalFailureProbability(15, 25, 3));
  });
});

describe('property exposure', () => {
  it('identifies the reasons applied to a coastal Delaware property', () => {
    expect(exposure.coastal).toBe(true);
    expect(exposure.freezeClimate).toBe(true);
    expect(exposure.humidClimate).toBe(true);
    expect(exposure.rationale.length).toBeGreaterThan(1);
  });

  it('does not invent coastal exposure from a state alone', () => {
    expect(inferPropertyMaintenanceExposure({ state: 'DE' }).coastal).toBe(false);
  });
});

describe('model-life feedback', () => {
  const profile: ComponentModelProfile = {
    id: 'rheem-x',
    category: 'water_heater',
    make: 'Rheem',
    model: 'XE50T10',
    reliabilityScore: 85,
    observedMedianLifeYears: 7,
    observedSampleSize: 180,
    recallCount: 0,
    researchedAt: NOW.toISOString(),
  };

  it('matches a model without caring about punctuation or case', () => {
    const unit = asset({
      category: 'water_heater',
      make: 'RHEEM',
      model: 'XE50-T10',
      usefulLifeYears: 10,
    });
    expect(findComponentModelProfile(unit, [profile])?.id).toBe(profile.id);
  });

  it('moves useful life toward observed data but does not discard the baseline', () => {
    const unit = asset({ category: 'water_heater', usefulLifeYears: 10 });
    const life = resolveForecastUsefulLifeYears(unit, profile);
    expect(life).toBeGreaterThan(7);
    expect(life).toBeLessThan(10);
  });

  it('barely moves the baseline for a tiny sample', () => {
    const unit = asset({ category: 'water_heater', usefulLifeYears: 10 });
    const life = resolveForecastUsefulLifeYears(unit, {
      ...profile,
      observedMedianLifeYears: 5,
      observedSampleSize: 2,
    });
    expect(life).toBeGreaterThan(8);
  });
});

describe('forecastComponentMaintenance', () => {
  it('does not claim a failure probability when age is unknown', () => {
    const result = forecastComponentMaintenance(asset({
      installedAt: null,
      estimatedAgeYears: null,
      evidence: 'inferred',
    }), { now: NOW, exposure });
    expect(result.urgency).toBe('verify');
    expect(result.action).toBe('confirm');
    expect(result.failureProbability24m).toBeNull();
    expect(result.dataGaps).toContain('Install date or approximate age');
    expect(result.recommendation).toMatch(/Confirm/i);
  });

  it('makes an overdue high-consequence component urgent', () => {
    const result = forecastComponentMaintenance(asset({
      category: 'water_heater',
      name: 'Water heater',
      installedAt: '2012-01-01',
      usefulLifeYears: 10,
    }), { now: NOW, exposure });
    expect(result.urgency).toBe('urgent');
    expect(result.action).toBe('replace');
    expect(result.riskScore).toBeGreaterThan(60);
    expect(result.window?.earliest).toBe('2026-07-27');
  });

  it('treats an overdue filter as service, not capital replacement', () => {
    const result = forecastComponentMaintenance(asset({
      category: 'air_filter',
      name: 'HVAC air filter',
      installedAt: '2025-01-01',
      usefulLifeYears: 0.25,
    }), { now: NOW });
    expect(result.urgency).toBe('urgent');
    expect(result.action).toBe('service');
    expect(result.estimatedCostHighUsd).toBeLessThan(500);
  });

  it('uses repeated repair economics as a replacement signal', () => {
    const result = forecastComponentMaintenance(asset({
      category: 'water_heater',
      name: 'Water heater',
      installedAt: '2021-01-01',
      usefulLifeYears: 10,
      spend: [
        {
          id: 'r1',
          occurredAt: '2025-01-01',
          amountUsd: 700,
          workKind: 'repair',
          createdAt: '2025-01-01',
        },
        {
          id: 'r2',
          occurredAt: '2026-01-01',
          amountUsd: 650,
          workKind: 'repair',
          createdAt: '2026-01-01',
        },
      ],
    }), { now: NOW });
    expect(result.action).toBe('replace');
    expect(result.urgency).toBe('urgent');
    expect(result.drivers.some((driver) => driver.kind === 'history')).toBe(true);
  });

  it('shortens exposed roof life and explains why', () => {
    const plain = forecastComponentMaintenance(asset(), { now: NOW });
    const coastal = forecastComponentMaintenance(asset(), { now: NOW, exposure });
    expect(coastal.effectiveLifeYears).toBeLessThan(plain.effectiveLifeYears);
    expect(coastal.drivers.some((driver) => driver.kind === 'exposure')).toBe(true);
    expect(coastal.failureProbability24m!).toBeGreaterThan(plain.failureProbability24m!);
  });

  it('raises urgency for a critical known-material flag', () => {
    const result = forecastComponentMaintenance(asset({
      installedAt: '2018-01-01',
      riskFlag: {
        severity: 'critical',
        label: 'Known failure-prone panel',
        detail: 'This panel family has a documented failure history.',
      },
    }), { now: NOW });
    expect(result.urgency).toBe('urgent');
    expect(result.drivers.some((driver) => driver.kind === 'material')).toBe(true);
  });

  it('turns accepted critical photo evidence into an urgent inspection, not an automatic replacement', () => {
    const result = forecastComponentMaintenance(asset({
      installedAt: '2022-01-01',
      visualCondition: {
        score: 24,
        observedAt: NOW.toISOString(),
        summary: 'Possible active deterioration',
        observations: [{
          label: 'Lifted flashing',
          severity: 'critical',
          evidence: 'A gap is visible along the flashing edge.',
        }],
        wearSigns: ['Lifted flashing'],
        failureSigns: ['Open flashing edge'],
        recommendedActions: ['Inspect for water entry'],
        limitations: ['Underlayment is not visible'],
        confidence: 0.84,
      },
    }), { now: NOW });
    expect(result.urgency).toBe('urgent');
    expect(result.action).toBe('inspect');
    expect(result.failureModes).toContain('Open flashing edge');
    expect(result.drivers.some((driver) => driver.label.includes('photo'))).toBe(true);
  });
});

describe('buildPropertyMaintenanceForecast', () => {
  it('orders action by urgency and builds non-duplicated budgets', () => {
    const result = buildPropertyMaintenanceForecast([
      asset({ id: 'old-roof' }),
      asset({
        id: 'unknown-panel',
        category: 'electrical',
        name: 'Panel',
        installedAt: null,
        estimatedAgeYears: null,
      }),
      asset({
        id: 'new-hvac',
        category: 'hvac',
        name: 'HVAC',
        installedAt: '2024-01-01',
        usefulLifeYears: 15,
      }),
    ], { now: NOW, exposure });

    expect(result.components[0].assetId).toBe('old-roof');
    expect(result.nextActions.some((item) => item.assetId === 'unknown-panel')).toBe(true);
    expect(result.budget12mLowUsd).toBeGreaterThan(0);
    expect(result.budget24mHighUsd).toBeGreaterThanOrEqual(result.budget12mHighUsd);
    // Confirming missing data is not counted as a capital maintenance budget.
    expect(result.budget12mHighUsd).toBeLessThan(30000);
  });

  it('ignores tombstoned inferred components', () => {
    const result = buildPropertyMaintenanceForecast([
      asset({ id: 'not-here', notApplicable: true }),
    ], { now: NOW });
    expect(result.components).toHaveLength(0);
  });
});
