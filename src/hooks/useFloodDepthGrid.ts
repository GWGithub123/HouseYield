/**
 * Screening-level flood depth raster for a property.
 *
 * Backed by GET /api/flood/depth-grid, which runs a HAND analysis over AWS
 * terrain tiles and stages it against NOAA Atlas 14 precipitation frequency.
 * The response is intentionally scenario-oriented: one depth raster per storm
 * total, so switching the storm slider is instant and never refetches.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface FloodDepthTier {
  id: string;
  minFt: number;
  maxFt: number | null;
  label: string;
}

export interface FloodDamage {
  structure: number;
  contents: number;
  total: number;
  structureValue: number;
}

export interface FloodScenario {
  rainInches: number;
  returnPeriodYears: number | null;
  annualChancePct: number | null;
  frequencyBounded: 'above' | 'below' | null;
  /** Row-major tier index per grid cell; -1 means dry. */
  tiers: number[];
  wetFraction: number;
  maxDepthFt: number;
  home: {
    depthFt: number | null;
    depthAboveFloorFt: number | null;
    tier: number;
    damage: FloodDamage | null;
  };
}

/**
 * A traced drainage channel. Derived from the same DEM as the depth raster, so
 * the corridors and the water agree by construction.
 */
export interface DrainageChannel {
  path: { lat: number; lng: number }[];
  /** 0–1, log-compressed peak contributing area along the channel. */
  strength: number;
}

/**
 * A traced flow path across the lot. Continuous rather than per-cell, so it can
 * be smoothed into something that reads as water rather than as arrows.
 */
export interface Streamline {
  path: { lat: number; lng: number }[];
  /** 0–1, log-compressed contributing area. */
  strength: number;
  isDrainage: boolean;
}

/** Lot-scale flow field: which way water crosses the yard. */
export interface LotFlow {
  windowMetres: number;
  spacingMetres: number;
  streamlines: Streamline[];
  /** Direction and steepness of the fall at the house itself. */
  homeFall: { bearingDeg: number; slopePct: number } | null;
  contributingAreaSqm: number;
  drainageCrossesLot: boolean;
}

export interface SurgeScenario {
  category: number;
  surgeAboveMhhwFt: number;
  depthAtGradeFt: number | null;
  depthAboveFloorFt: number | null;
  recurrenceYears: number | null;
  annualChancePct: number | null;
  /** Still-water elevation for this category, same datum as terrain. */
  waterLevelFt?: number;
  /** Inundation raster, flood-filled inland from tidal water. */
  tiers?: number[] | null;
  wetFraction?: number | null;
  maxDepthFt?: number | null;
}

/**
 * Coastal surge exposure. Present only when the property is near tidal water.
 * Surge uses a tidal datum rather than the drainage network, so these figures
 * are independent of — and can far exceed — the rainfall scenarios.
 */
export interface CoastalSurge {
  exposed: true;
  confidence: 'modelled' | 'unknown';
  region?: { id: string; label: string };
  station: {
    id: string;
    name: string;
    distanceKm: number;
    datumEpoch?: string | null;
    mhhwNavd88Ft?: number | null;
  };
  groundElevationFt?: number | null;
  freeboardAboveMhhwFt?: number | null;
  routineCoastalFlooding?: { level: string; aboveMhhwFt: number; depthAtGradeFt: number | null }[];
  scenarios?: SurgeScenario[];
  firstWettingCategory?: number | null;
  /** True when surge extent could be mapped, not just modelled at the point. */
  mapped?: boolean;
  mappingNote?: string;
  method?: string;
  disclaimer?: string;
  references?: { label: string; url: string }[];
  note?: string;
  error?: string;
}

export interface FloodDepthGrid {
  ok: true;
  generatedAt: string;
  location: { lat: number; lng: number };
  grid: {
    samples: number;
    bounds: { north: number; south: number; east: number; west: number };
    spacingMetres: number;
    zoom: number;
    coverage: number;
  };
  terrain: {
    homeElevationFt: number | null;
    heightAboveDrainageFt: number | null;
    minElevationFt: number;
    maxElevationFt: number;
    drainageCells: number;
  };
  precipitation: {
    source: string | null;
    durationHours?: number;
    curve?: { years: number; inches: number }[];
    error?: string;
  };
  damageBasis: {
    livingSqft: number | null;
    costPerSqft: number;
    finishedFloorAboveGradeFt: number;
    curve: string;
  };
  tiers: FloodDepthTier[];
  scenarios: FloodScenario[];
  drainageNetwork: { channels: DrainageChannel[] } | null;
  lotFlow: LotFlow | null;
  coastalSurge: CoastalSurge | null;
  /** Which mechanism can put the most water on the property. */
  governingHazard: 'coastal_surge' | 'rainfall' | 'none_modelled';
  worstCase: {
    source: 'coastal_surge' | 'rainfall';
    depthAtGradeFt: number;
    depthAboveFloorFt: number;
    damage: FloodDamage | null;
  } | null;
  method: string;
  disclaimer: string;
}

interface Options {
  latitude?: number | null;
  longitude?: number | null;
  livingSqft?: number | null;
  /**
   * Half-width of the analysed window. The default suits the neighbourhood
   * view; the lot view asks for a much tighter window so the DEM is sampled
   * finely enough to resolve a single parcel.
   */
  radiusMetres?: number;
  /** Cells per side. More cells over a smaller radius means finer spacing. */
  samples?: number;
  /** Skip the request entirely, e.g. while a panel is collapsed. */
  enabled?: boolean;
}

export function useFloodDepthGrid({
  latitude,
  longitude,
  livingSqft,
  radiusMetres,
  samples,
  enabled = true,
}: Options) {
  const [data, setData] = useState<FloodDepthGrid | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        lat: String(latitude),
        lng: String(longitude),
      });
      if (livingSqft && livingSqft > 0) params.set('livingSqft', String(Math.round(livingSqft)));
      if (radiusMetres) params.set('radiusMeters', String(Math.round(radiusMetres)));
      if (samples) params.set('samples', String(Math.round(samples)));

      const response = await fetch(`/api/flood/depth-grid?${params}`);
      const json = await response.json();
      // A newer request has already started; its result is the one that counts.
      if (id !== requestId.current) return;

      if (!response.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${response.status}`);
      }
      setData(json as FloodDepthGrid);
    } catch (e: any) {
      if (id !== requestId.current) return;
      setError(e?.message || 'flood_depth_failed');
      setData(null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [latitude, longitude, livingSqft, radiusMetres, samples, enabled]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}
