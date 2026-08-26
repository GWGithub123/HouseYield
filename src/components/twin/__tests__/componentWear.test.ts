/**
 * Component geometry and the wear drawn on it.
 *
 * The properties worth pinning down are the ones that would quietly ruin the
 * close-up: marks landing off the surface they belong to, marks that reshuffle
 * between renders, and a component that looks identical new and past its life.
 * That last one is the whole reason the close-up exists.
 */
import { describe, expect, it } from 'vitest';

import { SHELL, visibleRooms } from '../houseModel';
import {
  buildWearMarks,
  componentRegion,
  onSurface,
  wearFindings,
  wearLevel,
} from '../componentWear';
import type { PropertyHealthCategory } from '../../../types/propertyHealth';

const rooms = visibleRooms({ address: '11822 Prestwick Road', beds: 4, baths: 3 });

const CATEGORIES: PropertyHealthCategory[] = [
  'water_heater',
  'hvac',
  'air_filter',
  'water_filter',
  'appliance',
  'smart_home',
  'electrical',
  'roof',
  'plumbing',
  'windows',
  'exterior',
  'other',
];

/** Every coordinate pair in an SVG path, for checking where marks landed. */
function points(d: string): Array<{ x: number; y: number }> {
  const found: Array<{ x: number; y: number }> = [];
  const re = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
  let match = re.exec(d);
  while (match) {
    found.push({ x: Number(match[1]), y: Number(match[2]) });
    match = re.exec(d);
  }
  return found;
}

describe('componentRegion', () => {
  it('reports the real roof, both slopes and the full span', () => {
    const region = componentRegion('roof', rooms);
    expect(region.literal).toBe(true);
    expect(region.surfaces).toHaveLength(2);
    // The box has to reach the eaves on both sides, or the frame built from it
    // shows a roof with its ends cut off.
    expect(region.box.x).toBeLessThanOrEqual(SHELL.roofLeft.x);
    expect(region.box.x + region.box.w).toBeGreaterThanOrEqual(SHELL.roofRight.x);
    expect(region.box.y).toBeLessThanOrEqual(SHELL.roofPeak.y);
  });

  it('runs each roof slope from the eave up to the ridge', () => {
    // Marks that follow water are generated along `u`, so if a slope ran the other
    // way its streaks would run uphill.
    for (const surface of componentRegion('roof', rooms).surfaces) {
      const eave = onSurface(surface, 0, 0);
      const ridge = onSurface(surface, 1, 0);
      expect(ridge.y).toBeLessThan(eave.y);
      expect(ridge.x).toBeCloseTo(SHELL.roofPeak.x, 6);
    }
  });

  it('finds the drawn appliance for a component that is one', () => {
    for (const category of ['water_heater', 'hvac', 'air_filter', 'electrical'] as const) {
      const region = componentRegion(category, rooms);
      expect(region.literal).toBe(true);
      expect(region.surfaces).toHaveLength(1);
    }
  });

  it('claims no surface for a component the section does not draw', () => {
    // Honesty rather than an omission: the caller shows a marker instead of
    // weathering a surface that is not there.
    const region = componentRegion('smart_home', rooms);
    expect(region.literal).toBe(false);
    expect(region.surfaces).toHaveLength(0);
  });

  it('stays inside the artwork for every category, on every layout', () => {
    const condo = visibleRooms({ address: '4 Main St Unit 2', beds: 2, baths: 1 });
    for (const within of [rooms, condo]) {
      for (const category of CATEGORIES) {
        const { box } = componentRegion(category, within);
        expect(box.w).toBeGreaterThan(0);
        expect(box.h).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThan(-200);
        expect(box.y).toBeGreaterThan(-200);
      }
    }
  });
});

describe('wearLevel', () => {
  it('reads an unknown age as settled rather than new', () => {
    // Claiming a component with no install date is as-new would be the one wrong
    // answer: it is the case where we know least and would be reassuring most.
    expect(wearLevel(null)).toBe('settled');
  });

  it('climbs with life used', () => {
    expect(wearLevel(0.1)).toBe('new');
    expect(wearLevel(0.45)).toBe('settled');
    expect(wearLevel(0.7)).toBe('worn');
    expect(wearLevel(0.9)).toBe('failing');
    expect(wearLevel(1.2)).toBe('overdue');
  });
});

describe('buildWearMarks', () => {
  const roof = componentRegion('roof', rooms).surfaces;

  it('draws nothing on a component that is essentially new', () => {
    expect(buildWearMarks('roof', roof, 0.05)).toHaveLength(0);
  });

  it('draws more as the component ages', () => {
    const young = buildWearMarks('roof', roof, 0.4).length;
    const middle = buildWearMarks('roof', roof, 0.7).length;
    const old = buildWearMarks('roof', roof, 0.95).length;
    const past = buildWearMarks('roof', roof, 1.3).length;
    expect(young).toBeLessThan(middle);
    expect(middle).toBeLessThan(old);
    expect(old).toBeLessThan(past);
  });

  it('only shows previous patches on a component past its life', () => {
    expect(buildWearMarks('roof', roof, 0.95).some((m) => m.kind === 'patch')).toBe(false);
    expect(buildWearMarks('roof', roof, 1.3).some((m) => m.kind === 'patch')).toBe(true);
  });

  it('is identical on every call, so the damage does not crawl around', () => {
    const a = buildWearMarks('roof', roof, 0.9);
    const b = buildWearMarks('roof', roof, 0.9);
    expect(a.map((m) => m.d)).toEqual(b.map((m) => m.d));
  });

  it('keeps every mark on or near the surface it belongs to', () => {
    // Clipping hides overspill, but a mark generated far outside its surface is a
    // mark that vanishes, which is how a heavily worn roof ends up looking clean.
    const { box } = componentRegion('roof', rooms);
    for (const mark of buildWearMarks('roof', roof, 1.3)) {
      for (const p of points(mark.d)) {
        expect(p.x).toBeGreaterThan(box.x - 40);
        expect(p.x).toBeLessThan(box.x + box.w + 40);
        expect(p.y).toBeGreaterThan(box.y - 40);
        expect(p.y).toBeLessThan(box.y + box.h + 40);
      }
    }
  });

  it('rusts a tank instead of growing moss on it', () => {
    const marks = buildWearMarks('water_heater', componentRegion('water_heater', rooms).surfaces, 0.95);
    expect(marks.some((m) => m.kind === 'rust')).toBe(true);
    expect(marks.some((m) => m.kind === 'moss')).toBe(false);
  });

  it('grows moss on a roof, which is the surface that stays damp', () => {
    expect(buildWearMarks('roof', roof, 0.95).some((m) => m.kind === 'moss')).toBe(true);
  });

  it('draws nothing when there is no surface to weather', () => {
    expect(buildWearMarks('smart_home', [], 1.4)).toHaveLength(0);
  });
});

describe('wearFindings', () => {
  it('names the marks in roof language on a roof', () => {
    const findings = wearFindings(buildWearMarks('roof', componentRegion('roof', rooms).surfaces, 1.3), 'roof');
    expect(findings).toContain('Granule loss');
    expect(findings).toContain('Algae streaking');
  });

  it('falls back to plain language off a roof', () => {
    const surfaces = componentRegion('water_heater', rooms).surfaces;
    const findings = wearFindings(buildWearMarks('water_heater', surfaces, 1.3), 'water_heater');
    expect(findings).toContain('Corrosion at the base');
    expect(findings).not.toContain('Granule loss');
  });

  it('lists each kind once, however many marks there are', () => {
    const marks = buildWearMarks('roof', componentRegion('roof', rooms).surfaces, 1.3);
    const findings = wearFindings(marks, 'roof');
    expect(marks.length).toBeGreaterThan(findings.length);
    expect(new Set(findings).size).toBe(findings.length);
  });
});
