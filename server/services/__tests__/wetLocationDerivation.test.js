import { describe, expect, it } from 'vitest';

import {
  bathroomLocationCount,
  buildCoverageSummary,
  deriveWetLocations,
  hasBasement,
} from '../wetLocationDerivation.js';

const idsOf = (result) => result.components.map((component) => component.id);

describe('hasBasement', () => {
  it('recognises basements however ATTOM spells them', () => {
    for (const value of [
      'BASEMENT',
      'Full Basement',
      'Basement - Finished',
      'Cellar',
      'BSMT',
      'Walk Out Basement',
      'Garden Level',
    ]) {
      expect(hasBasement(value), value).toBe(true);
    }
  });

  it('does not invent a basement for slab or crawl foundations', () => {
    // These are the common values that mean *no* basement, and counting a sump
    // in a slab-on-grade house would create a gap that can never be closed.
    for (const value of ['Slab', 'SLAB ON GRADE', 'Crawl Space', 'Pier & Beam', 'None']) {
      expect(hasBasement(value), value).toBe(false);
    }
  });

  it('is false for missing or empty values rather than throwing', () => {
    expect(hasBasement(null)).toBe(false);
    expect(hasBasement(undefined)).toBe(false);
    expect(hasBasement('')).toBe(false);
    expect(hasBasement('   ')).toBe(false);
  });

  it('prefers the negative when a value says both', () => {
    // "Slab / partial basement" is ambiguous; under-counting is the safer error
    // in a document, since it understates our own coverage rather than the risk.
    expect(hasBasement('Slab / Partial Basement')).toBe(false);
  });
});

describe('bathroomLocationCount', () => {
  it('rounds a half bath up, since it still has a toilet and a supply', () => {
    expect(bathroomLocationCount(2.5)).toBe(3);
    expect(bathroomLocationCount(1.5)).toBe(2);
    expect(bathroomLocationCount(3)).toBe(3);
  });

  it('returns null when there is no usable figure', () => {
    expect(bathroomLocationCount(null)).toBeNull();
    expect(bathroomLocationCount(undefined)).toBeNull();
    expect(bathroomLocationCount(0)).toBeNull();
    expect(bathroomLocationCount('')).toBeNull();
    expect(bathroomLocationCount('many')).toBeNull();
  });

  it('accepts numeric strings, which is how ATTOM often sends them', () => {
    expect(bathroomLocationCount('2.5')).toBe(3);
  });
});

describe('deriveWetLocations', () => {
  it('counts baths plus the fixtures every dwelling has', () => {
    const result = deriveWetLocations({
      bathrooms: 2,
      propertyType: 'Single Family Residence',
      foundationType: 'Slab',
    });

    // 2 baths + kitchen + water heater + laundry, no basement.
    expect(result.count).toBe(5);
    expect(idsOf(result)).toEqual(['bathrooms', 'kitchen', 'water_heater', 'laundry']);
  });

  it('adds the basement floor when the foundation is below grade', () => {
    const result = deriveWetLocations({
      bathrooms: 2,
      propertyType: 'Single Family Residence',
      foundationType: 'Full Basement',
    });

    expect(result.count).toBe(6);
    expect(idsOf(result)).toContain('basement');
  });

  it('drops the laundry for a condo unit, which often has none', () => {
    const result = deriveWetLocations({
      bathrooms: 1,
      propertyType: 'Condominium',
    });

    expect(idsOf(result)).not.toContain('laundry');
    expect(result.count).toBe(3);
  });

  it('still returns a floor when the bath count is missing, and says so', () => {
    const result = deriveWetLocations({ propertyType: 'Single Family Residence' });

    expect(idsOf(result)).not.toContain('bathrooms');
    expect(result.count).toBe(3);
    expect(result.confidence).toBe('low');
    expect(result.basis).toMatch(/not present/i);
  });

  it('marks recorded facts separately from standard assumptions', () => {
    const result = deriveWetLocations({ bathrooms: 3, propertyType: 'Single Family' });

    expect(result.recordedCount).toBe(3);
    expect(result.confidence).toBe('moderate');
    const bathrooms = result.components.find((component) => component.id === 'bathrooms');
    expect(bathrooms.basis).toBe('recorded');
    const kitchen = result.components.find((component) => component.id === 'kitchen');
    expect(kitchen.basis).toBe('standard');
  });

  it('gives every component a reason a reader can check', () => {
    const result = deriveWetLocations({ bathrooms: 2, foundationType: 'Basement' });
    for (const component of result.components) {
      expect(component.detail, component.id).toBeTruthy();
      expect(component.label, component.id).toBeTruthy();
    }
  });

  it('handles an empty fact set without throwing', () => {
    expect(() => deriveWetLocations()).not.toThrow();
    expect(deriveWetLocations({}).count).toBeGreaterThan(0);
  });
});

describe('buildCoverageSummary', () => {
  it('states the fraction and the percentage', () => {
    const expected = deriveWetLocations({
      bathrooms: 2,
      propertyType: 'Single Family',
      foundationType: 'Slab',
    });
    const summary = buildCoverageSummary(2, expected);

    expect(summary.expectedWetLocationCount).toBe(5);
    expect(summary.monitoredWetLocationCount).toBe(2);
    expect(summary.coveragePercent).toBe(40);
    expect(summary.unmonitoredWetLocationCount).toBe(3);
  });

  it('caps at 100% rather than reporting more coverage than exists', () => {
    // ATTOM under-reporting baths is common, and a packet claiming 150%
    // coverage would discredit every other number on the page.
    const summary = buildCoverageSummary(9, deriveWetLocations({ bathrooms: 1 }));

    expect(summary.coveragePercent).toBe(100);
    expect(summary.unmonitoredWetLocationCount).toBe(0);
  });

  it('states no ratio at all when the denominator is unavailable', () => {
    const summary = buildCoverageSummary(3, { count: null, components: [] });

    expect(summary.coveragePercent).toBeNull();
    expect(summary.expectedWetLocationCount).toBeNull();
    expect(summary.confidence).toBe('unavailable');
    expect(summary.basis).toMatch(/no coverage ratio is stated/i);
  });

  it('treats a missing numerator as zero coverage, not as an error', () => {
    const summary = buildCoverageSummary(null, deriveWetLocations({ bathrooms: 2 }));

    expect(summary.monitoredWetLocationCount).toBe(0);
    expect(summary.coveragePercent).toBe(0);
  });

  it('carries the basis and confidence through for the packet to print', () => {
    const expected = deriveWetLocations({ bathrooms: 2, foundationType: 'Basement' });
    const summary = buildCoverageSummary(1, expected);

    expect(summary.confidence).toBe('moderate');
    expect(summary.basis).toBe(expected.basis);
    expect(summary.components).toHaveLength(expected.components.length);
  });
});
