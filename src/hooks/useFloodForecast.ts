/**
 * Hour-by-hour flood forecast for the next day, for the twin's storm playback.
 *
 * Distinct from `useFloodDepthGrid`, which returns fixed design scenarios that
 * never change. This one expires: it is keyed to the wall-clock hour on the
 * server and is only fetched when the user actually opens the timeline, because
 * it costs a terrain pass plus two upstream APIs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ForecastStep {
  timestamp: number;
  /** Depth tier per grid cell, decoded from the wire format. */
  tiers: number[] | null;
  wetFraction: number | null;
  maxDepthFt: number | null;
  homeDepthFt: number | null;
  damageTotal: number | null;
  /* rainfall track */
  rainIn?: number;
  chancePct?: number | null;
  effectiveIn?: number;
  /* surge track */
  tideFt?: number;
  surgeFt?: number;
  waterLevelFt?: number;
  aboveMhhwFt?: number;
}

export interface RainfallTrack {
  source: string;
  steps: ForecastStep[];
  totalInchesForecast: number;
  peakEffectiveInches: number;
  peakAnnualChancePct: number | null;
  peakIndex: number;
}

export interface SurgeTrack {
  category: number;
  peakSurgeAboveMhhwFt: number;
  station: { id: string; name: string; distanceKm: number; mhhwNavd88Ft: number | null };
  tideSource: string | null;
  tideError: string | null;
  steps: ForecastStep[];
  peakIndex: number;
  mapped: boolean;
  basis: string;
}

/** Hourly conditions at the property itself, for the timeline readout. */
export interface HourConditions {
  timestamp: number;
  tempF: number;
  feelsLikeF: number;
  precipIn: number;
  chancePct: number | null;
  cloudPct: number | null;
  windMph: number;
  gustMph: number;
  windDirDeg: number | null;
  humidityPct: number | null;
  isDay: boolean;
  code: number;
  label: string;
  icon: string;
}

/** One hour of the regional field, decoded to plain arrays. */
export interface WeatherStep {
  timestamp: number;
  /** Precipitation rate per cell, mm/h, row-major from the north-west corner. */
  precipMmH: number[];
  /** Cloud cover per cell, 0–100. */
  cloudPct: number[];
}

export interface WeatherTrack {
  source: string;
  grid: {
    rows: number;
    cols: number;
    bounds: { north: number; south: number; east: number; west: number };
    modelSpacingKm: number;
  };
  steps: WeatherStep[];
  conditions: HourConditions[];
  note: string;
}

export interface FloodForecast {
  ok: true;
  generatedAt: string;
  grid: { samples: number; bounds: { north: number; south: number; east: number; west: number }; spacingMetres: number };
  hours: number;
  rainfall: RainfallTrack | null;
  rainfallError: string | null;
  surge: SurgeTrack | null;
  surgeError: string | null;
  weather: WeatherTrack | null;
  weatherError: string | null;
  method: string;
  disclaimer: string;
}

/**
 * Undo the server's run-length encoding: triples of (tier + 1, count low byte,
 * count high byte). See `encodeTiers` in floodForecastTimeline.js.
 */
export function decodeTiers(encoded: string | null, cells: number): number[] | null {
  if (!encoded) return null;

  const binary = atob(encoded);
  const out = new Array<number>(cells);
  let at = 0;

  for (let i = 0; i + 2 < binary.length; i += 3) {
    const value = binary.charCodeAt(i) - 1;
    const count = binary.charCodeAt(i + 1) | (binary.charCodeAt(i + 2) << 8);
    for (let k = 0; k < count && at < cells; k += 1) {
      out[at] = value;
      at += 1;
    }
  }

  // A short payload means a truncated run; treat the remainder as dry rather
  // than leaving holes the raster painter would read as undefined.
  while (at < cells) {
    out[at] = -1;
    at += 1;
  }
  return out;
}

function decodeTrack<T extends { steps: any[] }>(track: T | null, cells: number): T | null {
  if (!track) return null;
  return {
    ...track,
    steps: track.steps.map((s) => ({ ...s, tiers: decodeTiers(s.tiers, cells) })),
  };
}

/** One byte per cell, base64. See `packBytes` in weatherFieldForecast.js. */
export function decodeBytes(encoded: string, scale: number): number[] {
  const binary = atob(encoded);
  const out = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) / scale;
  return out;
}

function decodeWeather(track: any): WeatherTrack | null {
  if (!track) return null;
  return {
    ...track,
    steps: track.steps.map((s: any) => ({
      timestamp: s.timestamp,
      precipMmH: decodeBytes(s.precip, 10),
      cloudPct: decodeBytes(s.cloudPct, 1),
    })),
  };
}

interface Options {
  latitude?: number | null;
  longitude?: number | null;
  livingSqft?: number | null;
  /** Include a surge track for this hurricane category. */
  surgeCategory?: number | null;
  enabled?: boolean;
}

export function useFloodForecast({
  latitude,
  longitude,
  livingSqft,
  surgeCategory,
  enabled = false,
}: Options) {
  const [data, setData] = useState<FloodForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ lat: String(latitude), lng: String(longitude) });
      if (livingSqft && livingSqft > 0) params.set('livingSqft', String(Math.round(livingSqft)));
      if (surgeCategory) params.set('surgeCategory', String(surgeCategory));

      const response = await fetch(`/api/flood/forecast-timeline?${params}`);
      const json = await response.json();
      if (id !== requestId.current) return;

      if (!response.ok || !json?.ok) throw new Error(json?.error || `HTTP ${response.status}`);

      const cells = json.grid.samples * json.grid.samples;
      setData({
        ...json,
        rainfall: decodeTrack(json.rainfall, cells),
        surge: decodeTrack(json.surge, cells),
        weather: decodeWeather(json.weather),
      } as FloodForecast);
    } catch (e: any) {
      if (id !== requestId.current) return;
      setError(e?.message || 'flood_forecast_failed');
      setData(null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [latitude, longitude, livingSqft, surgeCategory, enabled]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}
