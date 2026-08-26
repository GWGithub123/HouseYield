import { describe, expect, it } from 'vitest';

import { normalizeBuildingSpec } from '../buildingModelStore.js';

describe('normalizeBuildingSpec', () => {
  it('passes a well-formed plan through', () => {
    expect(normalizeBuildingSpec({
      floors: 5,
      unitsPerFloor: 8,
      corridor: 'double_loaded',
      sharedRisers: true,
      hasBasement: true,
      archetype: 'midrise_corridor',
      confidence: 'high',
      needsConfirmation: false,
    })).toEqual({
      floors: 5,
      unitsPerFloor: 8,
      corridor: 'double_loaded',
      sharedRisers: true,
      hasBasement: true,
      archetype: 'midrise_corridor',
      confidence: 'high',
      needsConfirmation: false,
    });
  });

  it('coerces numeric strings, which is what a form posts', () => {
    const spec = normalizeBuildingSpec({ floors: '4', unitsPerFloor: '6' });
    expect(spec.floors).toBe(4);
    expect(spec.unitsPerFloor).toBe(6);
  });

  it('caps the plan so a request cannot ask for a million units', () => {
    // Units are generated as floors x unitsPerFloor x sides, so an unvalidated
    // pair of large numbers is a way to make the client allocate forever.
    const spec = normalizeBuildingSpec({ floors: 100000, unitsPerFloor: 99999 });
    expect(spec.floors).toBeLessThanOrEqual(60);
    expect(spec.unitsPerFloor).toBeLessThanOrEqual(40);
  });

  it('never produces a zero or negative building', () => {
    for (const value of [0, -5, 0.2]) {
      expect(normalizeBuildingSpec({ floors: value }).floors).toBeGreaterThanOrEqual(1);
      expect(normalizeBuildingSpec({ unitsPerFloor: value }).unitsPerFloor).toBeGreaterThanOrEqual(1);
    }
  });

  it('falls back per field rather than rejecting the whole plan', () => {
    // A manager should not lose four correct answers because a fifth arrived as
    // a string.
    const spec = normalizeBuildingSpec({
      floors: 6,
      unitsPerFloor: 4,
      corridor: 'spiral',
      archetype: 'castle',
      confidence: 'certain',
    });

    expect(spec.floors).toBe(6);
    expect(spec.unitsPerFloor).toBe(4);
    expect(spec.corridor).toBe('none');
    expect(spec.archetype).toBe('unknown');
    expect(spec.confidence).toBe('low');
  });

  it('treats the risk-widening flags as opt-in', () => {
    // Both widen exposure claims about specific apartments, so anything other
    // than an explicit true means no.
    for (const value of [undefined, null, 0, '', 'true', 1, 'yes']) {
      expect(normalizeBuildingSpec({ sharedRisers: value }).sharedRisers).toBe(false);
      expect(normalizeBuildingSpec({ hasBasement: value }).hasBasement).toBe(false);
    }
    expect(normalizeBuildingSpec({ sharedRisers: true }).sharedRisers).toBe(true);
  });

  it('keeps asking for confirmation unless told explicitly not to', () => {
    expect(normalizeBuildingSpec({}).needsConfirmation).toBe(true);
    expect(normalizeBuildingSpec({ needsConfirmation: true }).needsConfirmation).toBe(true);
    expect(normalizeBuildingSpec({ needsConfirmation: false }).needsConfirmation).toBe(false);
  });

  it('survives junk input without throwing', () => {
    for (const input of [undefined, null, 'nope', 42, []]) {
      expect(() => normalizeBuildingSpec(input)).not.toThrow();
      expect(normalizeBuildingSpec(input).floors).toBeGreaterThanOrEqual(1);
    }
  });
});
