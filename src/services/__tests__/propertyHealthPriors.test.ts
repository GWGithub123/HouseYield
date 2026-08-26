import { describe, it, expect } from 'vitest';
import {
  buildPropertyHealthPriors,
  mergePriorsWithSaved,
  inferCoastal,
} from '../propertyHealthPriors';
import {
  computePropertyHealthScore,
  createEmptyHealthAsset,
  isUnconfirmedAsset,
  PROPERTY_HEALTH_CATEGORY_META,
} from '../../types/propertyHealth';

const NOW = new Date('2026-07-26T00:00:00Z');

describe('vintage priors', () => {
  it('produces nothing without a year built, rather than guessing', () => {
    expect(buildPropertyHealthPriors({ yearBuilt: null }, NOW).assets).toHaveLength(0);
    expect(buildPropertyHealthPriors({ yearBuilt: 0 }, NOW).assets).toHaveLength(0);
    expect(buildPropertyHealthPriors({ yearBuilt: 3000 }, NOW).assets).toHaveLength(0);
  });

  it('marks every inferred record as unconfirmed with a stated reason', () => {
    const { assets } = buildPropertyHealthPriors({ yearBuilt: 1968 }, NOW);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(isUnconfirmedAsset(asset)).toBe(true);
      expect(asset.provenance?.existence?.rationale).toBeTruthy();
      expect(asset.provenance?.existence?.confidence).toBeLessThan(1);
    }
  });

  it('reads copper supply for a 1968 build and PEX for a 2015 build', () => {
    const midCentury = buildPropertyHealthPriors({ yearBuilt: 1968 }, NOW).assets
      .find((asset) => asset.priorKey === 'plumbing_supply');
    const modern = buildPropertyHealthPriors({ yearBuilt: 2015 }, NOW).assets
      .find((asset) => asset.priorKey === 'plumbing_supply');

    expect(midCentury?.material).toBe('Copper');
    expect(modern?.material).toBe('PEX');
  });

  it('flags the polybutylene era over the band default', () => {
    const { assets } = buildPropertyHealthPriors({ yearBuilt: 1986 }, NOW);
    const supply = assets.find((asset) => asset.priorKey === 'plumbing_supply');

    expect(supply?.material).toBe('Possible polybutylene');
    expect(supply?.riskFlag?.severity).toBe('critical');
  });

  it('does not flag polybutylene outside its era', () => {
    const before = buildPropertyHealthPriors({ yearBuilt: 1965 }, NOW).assets
      .find((asset) => asset.priorKey === 'plumbing_supply');
    const after = buildPropertyHealthPriors({ yearBuilt: 2001 }, NOW).assets
      .find((asset) => asset.priorKey === 'plumbing_supply');

    expect(before?.riskFlag?.label).not.toBe('Polybutylene era');
    expect(after?.riskFlag?.label).not.toBe('Polybutylene era');
  });
});

describe('coastal modifiers', () => {
  it('recognizes a Delaware beach address but not an inland one', () => {
    expect(inferCoastal({ address: '12 Oak Ave, Rehoboth Beach, DE 19971', state: 'DE' })).toBe(true);
    expect(inferCoastal({ address: '12 Oak Ave, Dover, DE 19901', state: 'DE' })).toBe(false);
  });

  it('shortens HVAC life in salt air and says why', () => {
    const inland = buildPropertyHealthPriors({ yearBuilt: 2015, address: 'Dover, DE', state: 'DE' }, NOW).assets
      .find((asset) => asset.category === 'hvac');
    const coastal = buildPropertyHealthPriors(
      { yearBuilt: 2015, address: 'Rehoboth Beach, DE', state: 'DE' },
      NOW,
    ).assets.find((asset) => asset.category === 'hvac');

    expect(coastal!.usefulLifeYears!).toBeLessThan(inland!.usefulLifeYears!);
    expect(coastal!.watchFor?.join(' ')).toMatch(/salt/i);
  });

  it('leaves categories salt air does not affect alone', () => {
    const inland = buildPropertyHealthPriors({ yearBuilt: 2015, address: 'Dover, DE', state: 'DE' }, NOW).assets
      .find((asset) => asset.category === 'water_heater');
    const coastal = buildPropertyHealthPriors(
      { yearBuilt: 2015, address: 'Rehoboth Beach, DE', state: 'DE' },
      NOW,
    ).assets.find((asset) => asset.category === 'water_heater');

    expect(coastal!.usefulLifeYears).toBe(inland!.usefulLifeYears);
  });
});

describe('merging priors with saved records', () => {
  it('never replaces a category the owner already tracks', () => {
    const saved = [
      createEmptyHealthAsset({
        category: 'water_heater',
        name: 'Rheem Performance 50gal',
        installedAt: '2021-05-01',
        evidence: 'owner',
      }),
    ];
    const { assets: priors } = buildPropertyHealthPriors({ yearBuilt: 1968 }, NOW);
    const merged = mergePriorsWithSaved(saved, priors);

    const heaters = merged.filter((asset) => asset.category === 'water_heater');
    expect(heaters).toHaveLength(1);
    expect(heaters[0].name).toBe('Rheem Performance 50gal');
  });

  it('still fills the categories the owner has not touched', () => {
    const saved = [
      createEmptyHealthAsset({ category: 'water_heater', name: 'Mine', evidence: 'owner' }),
    ];
    const { assets: priors } = buildPropertyHealthPriors({ yearBuilt: 1968 }, NOW);
    const merged = mergePriorsWithSaved(saved, priors);

    expect(merged.some((asset) => asset.category === 'roof')).toBe(true);
    expect(merged.length).toBeGreaterThan(saved.length);
  });
});

describe('weighted health score', () => {
  const freshCore = () => [
    createEmptyHealthAsset({ category: 'roof', name: 'Roof', installedAt: '2024-01-01', evidence: 'owner' }),
    createEmptyHealthAsset({ category: 'hvac', name: 'HVAC', installedAt: '2024-01-01', evidence: 'owner' }),
    createEmptyHealthAsset({ category: 'water_heater', name: 'WH', installedAt: '2024-01-01', evidence: 'owner' }),
    createEmptyHealthAsset({ category: 'windows', name: 'Windows', installedAt: '2024-01-01', evidence: 'owner' }),
    createEmptyHealthAsset({ category: 'electrical', name: 'Panel', installedAt: '2024-01-01', evidence: 'owner' }),
    createEmptyHealthAsset({ category: 'plumbing', name: 'Supply', installedAt: '2024-01-01', evidence: 'owner' }),
  ];

  it('scores an empty inventory at zero rather than unknown-as-healthy', () => {
    const score = computePropertyHealthScore([], NOW);
    expect(score.score).toBe(0);
    expect(score.coverage).toBe(0);
    expect(score.headline).toBe('Not started');
  });

  it('does not let a pile of air filters pass as coverage', () => {
    const filters = Array.from({ length: 8 }, (_, index) =>
      createEmptyHealthAsset({
        category: 'air_filter',
        name: `Filter ${index}`,
        installedAt: '2026-07-01',
        evidence: 'owner',
      }),
    );
    const score = computePropertyHealthScore(filters, NOW);

    expect(score.coverage).toBe(0);
    expect(score.score).toBeLessThan(50);
    expect(score.missingCoreCategories).toContain('roof');
  });

  it('rewards a fully covered, recently replaced set of core systems', () => {
    const score = computePropertyHealthScore(freshCore(), NOW);
    expect(score.coverage).toBe(100);
    expect(score.score).toBeGreaterThan(80);
    expect(score.headline).toBe('Looking solid');
  });

  it('weights a failing water heater harder than a failing air filter', () => {
    const base = freshCore();
    const deadHeater = base.map((asset) =>
      asset.category === 'water_heater' ? { ...asset, installedAt: '2004-01-01' } : asset,
    );
    const deadFilter = [
      ...base,
      createEmptyHealthAsset({ category: 'air_filter', name: 'Old filter', installedAt: '2015-01-01', evidence: 'owner' }),
    ];

    const heaterScore = computePropertyHealthScore(deadHeater, NOW).score;
    const filterScore = computePropertyHealthScore(deadFilter, NOW).score;

    expect(heaterScore).toBeLessThan(filterScore);
  });

  it('counts an expired core system toward deferred liability at its replacement cost', () => {
    const assets = freshCore().map((asset) =>
      asset.category === 'roof' ? { ...asset, installedAt: '1990-01-01' } : asset,
    );
    const score = computePropertyHealthScore(assets, NOW);

    expect(score.deferredLiabilityUsd).toBeGreaterThanOrEqual(
      PROPERTY_HEALTH_CATEGORY_META.roof.typicalReplacementUsd,
    );
    expect(score.headline).toBe('Needs attention');
  });

  it('scores a guessed inventory below the same inventory confirmed', () => {
    // Same six categories, all new construction, so condition is identical and
    // only the strength of the evidence differs.
    const confirmed = freshCore();
    const inferred = buildPropertyHealthPriors({ yearBuilt: 2024 }, NOW).assets;

    const confirmedScore = computePropertyHealthScore(confirmed, NOW);
    const inferredScore = computePropertyHealthScore(inferred, NOW);

    expect(confirmedScore.confirmed).toBe(confirmed.length);
    expect(inferredScore.unconfirmed).toBe(inferred.length);
    expect(inferredScore.score).toBeLessThan(confirmedScore.score);
  });

  it('does not condemn an old component we only guessed the age of', () => {
    // A confirmed 1990 roof is a known problem; a guessed one is a question.
    const guessed = createEmptyHealthAsset({
      category: 'roof',
      name: 'Roof',
      installedAt: '1990-01-01',
      evidence: 'inferred',
    });
    const known = createEmptyHealthAsset({
      category: 'roof',
      name: 'Roof',
      installedAt: '1990-01-01',
      evidence: 'owner',
    });

    expect(computePropertyHealthScore([guessed], NOW).score).toBeGreaterThan(
      computePropertyHealthScore([known], NOW).score,
    );
  });
});
