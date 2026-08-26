import { describe, it, expect } from 'vitest';
import { resolveHazard, bearingToCompass } from '../hazardScenario';
import type { FloodDepthGrid } from '../../../hooks/useFloodDepthGrid';

/** Minimal grid with two rainfall scenarios and one surge-exposed coast. */
function makeGrid(overrides: Partial<FloodDepthGrid> = {}): FloodDepthGrid {
  return {
    ok: true,
    generatedAt: '',
    location: { lat: 38.7, lng: -75.1 },
    grid: { samples: 2, bounds: { north: 1, south: 0, east: 1, west: 0 }, spacingMetres: 10, zoom: 14, coverage: 1 },
    terrain: {} as any,
    precipitation: null,
    damageBasis: null,
    tiers: [],
    drainageNetwork: null,
    lotFlow: null,
    coastalSurge: null,
    governingHazard: 'rainfall',
    worstCase: null,
    method: '',
    disclaimer: '',
    scenarios: [
      {
        rainInches: 1,
        returnPeriodYears: 2,
        annualChancePct: 50,
        frequencyBounded: null,
        tiers: [0, -1, -1, -1],
        wetFraction: 0.25,
        maxDepthFt: 0.5,
        home: { depthFt: 0.4, depthAboveFloorFt: 0, tier: 0, damage: null },
      },
      {
        rainInches: 6,
        returnPeriodYears: 100,
        annualChancePct: 1,
        frequencyBounded: null,
        tiers: [3, 2, 1, -1],
        wetFraction: 0.75,
        maxDepthFt: 6,
        home: { depthFt: 3.2, depthAboveFloorFt: 1.7, tier: 2, damage: { structure: 10, contents: 5, total: 15, structureValue: 100 } },
      },
    ],
    ...overrides,
  } as FloodDepthGrid;
}

describe('resolveHazard', () => {
  it('treats live as simulating nothing', () => {
    const h = resolveHazard({ kind: 'live' }, makeGrid());
    expect(h.isLive).toBe(true);
    expect(h.depthAtGradeFt).toBeNull();
    expect(h.raster).toBeNull();
  });

  /*
   * The flow layers key off `rainInches` to decide whether to draw at all, so
   * a dry day has to resolve to null rather than to zero-ish — otherwise the
   * drainage network animates on a clear afternoon and live stops meaning
   * anything.
   */
  it('reports no rain when live and dry', () => {
    expect(resolveHazard({ kind: 'live' }, makeGrid(), null, 0).rainInches).toBeNull();
    expect(resolveHazard({ kind: 'live' }, makeGrid(), null, null).rainInches).toBeNull();
  });

  it('carries observed rain through the live scenario', () => {
    const h = resolveHazard({ kind: 'live' }, makeGrid(), null, 0.12);
    expect(h.isLive).toBe(true);
    expect(h.rainInches).toBe(0.12);
    // Observed rain says water is moving; it does not say how deep it stands.
    expect(h.depthAtGradeFt).toBeNull();
  });

  it('lets a selected storm override what is falling outside', () => {
    const h = resolveHazard({ kind: 'rainfall', rainInches: 6 }, makeGrid(), null, 0.12);
    expect(h.isLive).toBe(false);
    expect(h.rainInches).toBe(6);
  });

  it('resolves a rainfall scenario to its own depth, raster and damage', () => {
    const h = resolveHazard({ kind: 'rainfall', rainInches: 6 }, makeGrid());
    expect(h.isLive).toBe(false);
    expect(h.depthAtGradeFt).toBe(3.2);
    expect(h.annualChancePct).toBe(1);
    expect(h.raster?.tiers).toEqual([3, 2, 1, -1]);
    expect(h.tiersAreProxy).toBe(false);
    expect(h.damageTotal).toBe(15);
    expect(h.label).toBe('6" in 24h');
  });

  it('falls back to live when the selected scenario is absent', () => {
    const h = resolveHazard({ kind: 'rainfall', rainInches: 99 }, makeGrid());
    expect(h.isLive).toBe(true);
  });

  it('falls back to live when there is no model output at all', () => {
    const h = resolveHazard({ kind: 'rainfall', rainInches: 6 }, null);
    expect(h.isLive).toBe(true);
  });

  describe('surge', () => {
    const coastal = makeGrid({
      governingHazard: 'coastal_surge',
      coastalSurge: {
        exposed: true,
        confidence: 'modelled',
        station: { id: '8557380', name: 'Lewes', distanceKm: 8.2 },
        mapped: true,
        scenarios: [
          {
            category: 1,
            surgeAboveMhhwFt: 5,
            depthAtGradeFt: 0,
            depthAboveFloorFt: 0,
            recurrenceYears: 12,
            annualChancePct: 8.3,
            tiers: [0, -1, -1, -1],
          },
          {
            category: 3,
            surgeAboveMhhwFt: 11,
            depthAtGradeFt: 5.7,
            depthAboveFloorFt: 4.2,
            recurrenceYears: 90,
            annualChancePct: 1.1,
            tiers: [4, 4, 3, -1],
          },
        ],
      } as any,
    });

    it('uses the surge depth, not any rainfall depth', () => {
      const h = resolveHazard({ kind: 'surge', category: 3 }, coastal);
      expect(h.depthAtGradeFt).toBe(5.7);
      expect(h.annualChancePct).toBe(1.1);
      expect(h.label).toBe('Category 3 storm surge');
    });

    it('uses the surge raster rather than any rainfall footprint', () => {
      const h = resolveHazard({ kind: 'surge', category: 3 }, coastal);
      expect(h.raster?.tiers).toEqual([4, 4, 3, -1]);
      expect(h.tiersAreProxy).toBe(false);
      expect(h.mechanism).toBe('surge');
    });

    it('still maps extent for a category that misses the house itself', () => {
      // Depth at the property is 0, but surrounding low ground still floods —
      // the map must not go blank just because this house stays dry.
      const h = resolveHazard({ kind: 'surge', category: 1 }, coastal);
      expect(h.depthAtGradeFt).toBe(0);
      expect(h.raster?.tiers).toEqual([0, -1, -1, -1]);
    });

    it('flags a stand-in when surge extent could not be mapped', () => {
      const unmapped = makeGrid({
        coastalSurge: {
          exposed: true,
          confidence: 'modelled',
          station: { id: '1', name: 'X', distanceKm: 5 },
          mapped: false,
          scenarios: [
            { category: 2, surgeAboveMhhwFt: 7, depthAtGradeFt: 3, depthAboveFloorFt: 1.5, recurrenceYears: 30, annualChancePct: 3.3, tiers: null },
          ],
        } as any,
      });
      const h = resolveHazard({ kind: 'surge', category: 2 }, unmapped);
      expect(h.depthAtGradeFt).toBe(3);
      expect(h.raster).toBeNull();
      expect(h.tiersAreProxy).toBe(true);
    });
  });
});

describe('forecast playback', () => {
  /*
   * The timeline is a separate analysis over a tighter window than the design
   * grid, with its own sample count snapped to whatever terrain tiles it
   * pulled. Pairing its tiers with the depth grid's dimensions ran off the end
   * of the array and threw partway into playback, so the raster has to carry
   * the grid it was actually computed on.
   */
  const forecast = {
    ok: true,
    grid: { samples: 3, bounds: { north: 9, south: 8, east: 7, west: 6 }, spacingMetres: 10 },
    rainfall: {
      steps: [
        { timestamp: 1_700_000_000_000, rainIn: 0.3, effectiveIn: 1.2, homeDepthFt: 0.6, damageTotal: 400, tiers: new Array(9).fill(1) },
      ],
    },
    surge: null,
  } as any;

  it('sizes and locates the raster from the forecast, not the design grid', () => {
    const h = resolveHazard({ kind: 'forecast', track: 'rainfall', index: 0 }, makeGrid(), forecast);
    expect(h.raster?.samples).toBe(3);
    expect(h.raster?.tiers).toHaveLength(9);
    expect(h.raster?.bounds).toEqual({ north: 9, south: 8, east: 7, west: 6 });
  });

  it('keeps the raster consistent with its own dimensions', () => {
    const h = resolveHazard({ kind: 'forecast', track: 'rainfall', index: 0 }, makeGrid(), forecast);
    expect(h.raster!.tiers).toHaveLength(h.raster!.samples ** 2);
  });

  it('falls back to live for an hour the forecast does not have', () => {
    const h = resolveHazard({ kind: 'forecast', track: 'rainfall', index: 42 }, makeGrid(), forecast);
    expect(h.isLive).toBe(true);
    expect(h.raster).toBeNull();
  });

  it('reports the routed rainfall, which lags the hourly total', () => {
    const h = resolveHazard({ kind: 'forecast', track: 'rainfall', index: 0 }, makeGrid(), forecast);
    expect(h.rainInches).toBe(1.2);
    expect(h.depthAtGradeFt).toBe(0.6);
    expect(h.annualChancePct).toBeNull();
  });
});

describe('bearingToCompass', () => {
  it('maps cardinals and wraps past 360', () => {
    expect(bearingToCompass(0)).toBe('N');
    expect(bearingToCompass(90)).toBe('E');
    expect(bearingToCompass(180)).toBe('S');
    expect(bearingToCompass(270)).toBe('W');
    expect(bearingToCompass(360)).toBe('N');
    expect(bearingToCompass(45)).toBe('NE');
  });
});
