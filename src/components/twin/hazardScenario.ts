/**
 * The one hazard scenario the whole zoom ladder shares.
 *
 * The three layers answer different questions at different scales — where water
 * collects in the neighbourhood, how it crosses the lot, what it reaches inside
 * the house — but they must always be describing the SAME storm. Without a
 * single source of truth it is entirely possible to show a 6" downpour on the
 * map while the cutaway sits dry, which reads as a bug even when both numbers
 * are individually right.
 *
 * So scenario selection lives here, once, and every layer derives from it.
 */
import type { FloodDepthGrid, FloodScenario, SurgeScenario } from '../../hooks/useFloodDepthGrid';
import type { FloodForecast } from '../../hooks/useFloodForecast';

export type TwinLayer = 'interior' | 'lot' | 'neighborhood';

export type ForecastTrackKind = 'rainfall' | 'surge';

export interface LatLngBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * A tier raster together with the grid it was computed on.
 *
 * These travel as one value because they are only meaningful as one value. The
 * design scenarios and the forecast timeline are independent analyses over
 * different windows — the timeline covers 900 m and the depth grid a wider
 * neighbourhood, and each snaps its own sample count to the terrain tiles it
 * pulled. Handing consumers a bare `number[]` invited them to pair it with
 * whichever grid was closest to hand, which is exactly what happened: playback
 * painted forecast tiers using the depth grid's dimensions, ran off the end of
 * the array, and threw. Even where the counts happened to agree it would have
 * drawn the right water over the wrong ground.
 */
export interface HazardRaster {
  /** Row-major tier index per cell; -1 is dry. Length is `samples * samples`. */
  tiers: number[];
  /** Cells per side. */
  samples: number;
  /** Geographic extent of the raster. */
  bounds: LatLngBounds;
}

export type HazardSelection =
  | { kind: 'live' }
  | { kind: 'rainfall'; rainInches: number }
  | { kind: 'surge'; category: number }
  /** One hour of the played-back forecast, rather than a design storm. */
  | { kind: 'forecast'; track: ForecastTrackKind; index: number };

export interface HazardScenario {
  selection: HazardSelection;
  /** True when nothing is being simulated and only live sensors apply. */
  isLive: boolean;
  /** Water depth at exterior grade, feet. Null when unknown. */
  depthAtGradeFt: number | null;
  /** Annual probability of this scenario, if known. */
  annualChancePct: number | null;
  /** Short human label, e.g. `6" in 24h` or `Category 2 storm surge`. */
  label: string | null;
  /** Tier raster for the map layers, with the grid it belongs to. */
  raster: HazardRaster | null;
  /**
   * True when a surge scenario could not be mapped spatially and only its depth
   * at the property is known, so the map has nothing trustworthy to draw.
   */
  tiersAreProxy: boolean;
  /** Which mechanism this scenario represents, for palette and copy. */
  mechanism: 'rainfall' | 'surge' | null;
  /**
   * Rain driving this scenario, as a 24-hour-equivalent depth in inches.
   *
   * Separate from `depthAtGradeFt`, which is what ends up standing at the
   * building. This is the input, and it is what the drainage network responds
   * to: how much water the channels are carrying depends on how much fell over
   * the catchment, not on how deep it got at one address. Null for surge, which
   * is not routed runoff at all.
   */
  rainInches: number | null;
  /** Estimated damage for this scenario, when the model produced one. */
  damageTotal: number | null;
  /** Set when this hazard is one hour of a forecast rather than a design storm. */
  atTime?: number | null;
}

/** Clock label for a forecast hour, e.g. `Sun 2 PM`. */
function hourLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
  });
}

const LIVE: HazardScenario = {
  selection: { kind: 'live' },
  isLive: true,
  depthAtGradeFt: null,
  annualChancePct: null,
  label: null,
  raster: null,
  tiersAreProxy: false,
  mechanism: null,
  rainInches: null,
  damageTotal: null,
};

/**
 * Resolve a selection against model output.
 *
 * Kept pure and outside React so the same resolution can be unit tested and
 * reused by any layer without threading callbacks through the tree.
 */
function rasterOn(
  tiers: number[] | null | undefined,
  source: { samples: number; bounds: LatLngBounds } | null | undefined,
): HazardRaster | null {
  if (!tiers?.length || !source) return null;
  return { tiers, samples: source.samples, bounds: source.bounds };
}

export function resolveHazard(
  selection: HazardSelection,
  grid: FloodDepthGrid | null,
  forecast?: FloodForecast | null,
  /**
   * Rain observed at the property right now, in inches.
   *
   * Live used to mean "no storm selected", which the drainage layer read as
   * "draw the network at its resting width" — so a dry Tuesday and a passing
   * shower looked identical, and both looked like water was moving. Live has to
   * mean live: this is the number that decides whether anything is flowing, and
   * how hard.
   */
  liveRainInches?: number | null,
): HazardScenario {
  const live: HazardScenario = {
    ...LIVE,
    selection,
    rainInches: liveRainInches != null && liveRainInches > 0 ? liveRainInches : null,
  };

  /*
   * The forecast track resolves against its own payload rather than the design
   * grid, but produces the same shape — so every layer animates through a storm
   * without knowing that playback exists.
   */
  if (selection.kind === 'forecast') {
    const track = selection.track === 'surge' ? forecast?.surge : forecast?.rainfall;
    const step = track?.steps?.[selection.index];
    if (!step) return live;

    const isSurge = selection.track === 'surge';
    return {
      selection,
      isLive: false,
      depthAtGradeFt: step.homeDepthFt ?? null,
      // A forecast hour has a time, not a recurrence interval. Reporting an
      // annual chance here would conflate "this is what is coming" with "this
      // is how often such a thing happens".
      annualChancePct: null,
      label: isSurge
        ? `${hourLabel(step.timestamp)} · ${step.aboveMhhwFt?.toFixed(1)} ft above MHHW`
        : `${hourLabel(step.timestamp)} · ${step.rainIn?.toFixed(2)}" this hour`,
      raster: rasterOn(step.tiers, forecast?.grid),
      tiersAreProxy: isSurge && step.tiers == null,
      mechanism: isSurge ? 'surge' : 'rainfall',
      // The routed 24-hour equivalent, not the raw hourly total: the channels
      // respond to what is in the catchment, which lags the sky.
      rainInches: isSurge ? null : step.effectiveIn ?? null,
      damageTotal: step.damageTotal ?? null,
      atTime: step.timestamp,
    };
  }

  if (selection.kind === 'live' || !grid) return live;


  if (selection.kind === 'rainfall') {
    const scenario: FloodScenario | undefined = grid.scenarios
      ?.find((s) => s.rainInches === selection.rainInches);
    if (!scenario) return live;

    return {
      selection,
      isLive: false,
      depthAtGradeFt: scenario.home.depthFt ?? null,
      annualChancePct: scenario.annualChancePct ?? null,
      label: `${scenario.rainInches}" in 24h`,
      raster: rasterOn(scenario.tiers, grid.grid),
      tiersAreProxy: false,
      mechanism: 'rainfall',
      rainInches: scenario.rainInches,
      damageTotal: scenario.home.damage?.total ?? null,
    };
  }

  const surge: SurgeScenario | undefined = grid.coastalSurge?.scenarios
    ?.find((s) => s.category === selection.category);
  if (!surge) return live;

  return {
    selection,
    isLive: false,
    depthAtGradeFt: surge.depthAtGradeFt ?? null,
    annualChancePct: surge.annualChancePct ?? null,
    label: `Category ${surge.category} storm surge`,
    // The model now flood-fills surge extent inland from tidal water, so this is
    // a real surge footprint rather than a rainfall stand-in. It stays null when
    // the window held no tidal water to fill from.
    raster: rasterOn(surge.tiers, grid.grid),
    tiersAreProxy: surge.tiers == null,
    mechanism: 'surge',
    rainInches: null,
    damageTotal: null,
  };
}

/** Compass label for a bearing, for describing which way the ground falls. */
export function bearingToCompass(deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(((deg % 360) / 45)) % 8];
}
