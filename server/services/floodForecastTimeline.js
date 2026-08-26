/**
 * Hour-by-hour flood forecast for the next day.
 *
 * The rest of the flood stack answers "what would a 3-inch storm do here?".
 * That is the right question for underwriting and the wrong one for an owner
 * looking at tonight's sky, because it has no time in it: no sense of when
 * water arrives, how long it stays, or whether it is still rising. This module
 * adds the missing axis by producing one depth raster per hour, so the map can
 * be played rather than toggled.
 *
 * WHAT IS FORECAST AND WHAT IS SCENARIO
 * -------------------------------------
 * The rainfall track is a genuine forecast: hourly precipitation from Open-Meteo
 * routed through the same screening stage model the static scenarios use.
 *
 * The surge track is deliberately half and half. Hourly astronomical tide comes
 * from NOAA CO-OPS predictions and is real. The storm surge riding on top of it
 * is a *scenario* — there is no public hourly surge forecast for an arbitrary
 * address, and inventing one would be the kind of false precision this codebase
 * has avoided elsewhere. So the caller picks a hurricane category, the surge is
 * shaped as a hydrograph peaked on the highest tide in the window (the credible
 * worst case), and the response says plainly which half is which.
 */

import {
  DEPTH_TIERS,
  computeFlow,
  computeHand,
  estimateDamage,
  fetchPrecipFrequency,
  returnPeriodForRainfall,
  stageFor,
  surgeInundation,
  tierIndexFor,
  DEFAULT_REPLACEMENT_COST_PER_SQFT,
} from './floodDepthModel.js';
import { fetchElevationGrid, elevationAt } from './terrainTiles.js';
import { assessCoastalSurge } from './coastalSurgeModel.js';
import { fetchWeatherField } from './weatherFieldForecast.js';

const M_TO_FT = 3.28084;

const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 60;

/* ── hourly precipitation ────────────────────────────────────────── */

/**
 * Open-Meteo hourly precipitation. Chosen over the OpenWeather feed already in
 * the codebase because that one is on a 3-hour step, and interpolating it into
 * hours would invent detail the source does not have — the whole point here is
 * hourly resolution.
 */
async function fetchHourlyPrecip(lat, lng, hours) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + '&hourly=precipitation,precipitation_probability'
    + '&precipitation_unit=inch&timezone=UTC&forecast_days=2';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let json;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`open-meteo HTTP ${response.status}`);
    json = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  const times = json?.hourly?.time || [];
  const precip = json?.hourly?.precipitation || [];
  const chance = json?.hourly?.precipitation_probability || [];
  if (!times.length) throw new Error('open-meteo returned no hourly data');

  // Open-Meteo timestamps are naive UTC ("2026-07-26T14:00"), so tag them.
  const rows = times.map((t, i) => ({
    timestamp: Date.parse(`${t}:00Z`),
    rainIn: Math.max(0, Number(precip[i]) || 0),
    chancePct: Number.isFinite(Number(chance[i])) ? Number(chance[i]) : null,
  }));

  // Start from the hour we are currently in, not from midnight.
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
  const forward = rows.filter((r) => Number.isFinite(r.timestamp) && r.timestamp >= nowHour);
  const window = forward.slice(0, hours);
  // Anything already on the ground shapes the first hours of the playback.
  const antecedent = rows
    .filter((r) => Number.isFinite(r.timestamp) && r.timestamp < nowHour)
    .slice(-24);

  return { window, antecedent };
}

/* ── rainfall routing ────────────────────────────────────────────── */

/**
 * Half-life of water leaving a small suburban catchment. Six hours is the usual
 * order of magnitude for a basin of a few hundred acres with storm sewers — long
 * enough that back-to-back bands compound, short enough that a passing shower
 * has drained by evening.
 */
const DECAY_PER_HOUR = 0.5 ** (1 / 6);
const WINDOW_HOURS = 24;

/**
 * Weights that convert an hourly series into an effective 24-hour storm total.
 *
 * `stageFor` is calibrated against Atlas 14 *24-hour* design storms, so it has
 * to be fed a 24-hour-equivalent depth or the numbers mean nothing. A plain
 * trailing sum would do that but never recedes within the playback window, so
 * the map would only ever rise. Weighting each past hour by how much of its
 * water is still in the system gives a curve that rises on the rain and falls
 * after it, while still reproducing the design storm exactly: the weights are
 * normalised so that rain falling evenly over 24 hours yields its own total.
 */
const KERNEL = (() => {
  let sum = 0;
  const raw = [];
  for (let k = 0; k < WINDOW_HOURS; k += 1) {
    const w = DECAY_PER_HOUR ** k;
    raw.push(w);
    sum += w;
  }
  const scale = WINDOW_HOURS / sum;
  return raw.map((w) => w * scale);
})();

/**
 * Effective 24-hour-equivalent depth for each hour of the window.
 *
 * Capped relative to the raw trailing total so that a single extreme hour is
 * treated as a serious short-duration event rather than being amplified into a
 * multi-day deluge the forecast never called for.
 */
export function routeRainfall(series) {
  return series.map((_, i) => {
    let weighted = 0;
    let raw = 0;
    for (let k = 0; k < WINDOW_HOURS; k += 1) {
      const row = series[i - k];
      if (!row) break;
      weighted += row.rainIn * KERNEL[k];
      raw += row.rainIn;
    }
    return Math.min(weighted, raw * 1.5);
  });
}

/* ── tide predictions ────────────────────────────────────────────── */

const pad = (v) => String(v).padStart(2, '0');
const coopsStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** Hourly astronomical tide relative to MHHW, in feet. */
async function fetchTidePredictions(stationId, fromMs, hours) {
  const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
    + '?product=predictions&application=HouseYieldTwin&datum=MHHW'
    + `&station=${encodeURIComponent(stationId)}`
    + `&begin_date=${encodeURIComponent(coopsStamp(fromMs))}`
    + `&end_date=${encodeURIComponent(coopsStamp(fromMs + hours * 3600000))}`
    + '&time_zone=gmt&units=english&interval=h&format=json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`co-ops predictions HTTP ${response.status}`);
    const json = await response.json();
    return (json?.predictions || [])
      .map((p) => ({ timestamp: Date.parse(`${p.t.replace(' ', 'T')}:00Z`), ft: Number(p.v) }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.ft));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Storm surge hydrograph: a smooth rise and fall about the peak.
 *
 * Real surge at a given site builds over roughly half a day as the storm
 * approaches, peaks near landfall, and drains more slowly than it filled. The
 * gaussian is deliberately wider on the falling side to reflect that.
 */
function surgeAt(hourOffsetFromPeak, peakFt) {
  const sigma = hourOffsetFromPeak < 0 ? 5.5 : 7;
  return peakFt * Math.exp(-((hourOffsetFromPeak / sigma) ** 2));
}

/* ── raster encoding ─────────────────────────────────────────────── */

/**
 * Tier rasters go over the wire run-length encoded, then base64.
 *
 * At 96 samples one hour is 9,216 cells, so a day of playback across two tracks
 * is over half a megabyte of raw raster — more than the rest of the twin's data
 * combined, for a feature whose whole appeal is that it responds immediately.
 * These rasters are overwhelmingly long runs of "dry", which is exactly what RLE
 * is for; in practice it takes each hour from ~12 kB to under 1 kB.
 *
 * Each run is three bytes: the tier biased by one (so -1 fits unsigned), then
 * the run length little-endian. Runs are split at 65,535.
 */
export function encodeTiers(tiers) {
  const runs = [];
  let value = tiers[0];
  let count = 0;

  const flush = () => {
    while (count > 0) {
      const chunk = Math.min(count, 0xffff);
      runs.push(value + 1, chunk & 0xff, chunk >> 8);
      count -= chunk;
    }
  };

  for (let i = 0; i < tiers.length; i += 1) {
    if (tiers[i] === value) {
      count += 1;
    } else {
      flush();
      value = tiers[i];
      count = 1;
    }
  }
  flush();

  return Buffer.from(Uint8Array.from(runs)).toString('base64');
}

/* ── main ────────────────────────────────────────────────────────── */

/**
 * Cache identity for one timeline. Shared with the pre-limiter peek below so
 * the two cannot drift into never agreeing.
 */
function timelineCacheKey(params) {
  const {
    lat,
    lng,
    hours = 24,
    radiusMetres = 900,
    samples = 96,
    livingSqft,
    costPerSqft = DEFAULT_REPLACEMENT_COST_PER_SQFT,
    finishedFloorAboveGradeFt = 1.5,
    surgeCategory = null,
  } = params;
  return [
    lat.toFixed(4), lng.toFixed(4), hours, radiusMetres, samples,
    livingSqft || 0, costPerSqft, finishedFloorAboveGradeFt, surgeCategory || '-',
    // Forecasts go stale on the hour, so the hour is part of the identity.
    Math.floor(Date.now() / 3600000),
  ].join('|');
}

/**
 * Return an already-built timeline, or null. Never fetches.
 *
 * Lets the HTTP layer answer from cache without spending rate-limit budget on
 * a request that touches no upstream service.
 */
export function peekFloodForecastTimeline(params) {
  const hit = cache.get(timelineCacheKey(params));
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : null;
}

export async function buildFloodForecastTimeline(params) {
  const {
    lat,
    lng,
    hours = 24,
    radiusMetres = 900,
    samples = 96,
    livingSqft,
    costPerSqft = DEFAULT_REPLACEMENT_COST_PER_SQFT,
    finishedFloorAboveGradeFt = 1.5,
    surgeCategory = null,
  } = params;

  const cacheKey = timelineCacheKey(params);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  /* ── terrain, once ── */
  const grid = await fetchElevationGrid(lat, lng, radiusMetres, samples);
  const n = grid.samples;
  const total = n * n;
  const { downstream, accumulation } = computeFlow(grid.elevations, n);

  const sortedAcc = Array.from(accumulation).sort((a, b) => b - a);
  const drainageThreshold = Math.max(6, sortedAcc[Math.floor(sortedAcc.length * 0.04)] || 6);
  const { hand } = computeHand(grid.elevations, n, downstream, accumulation, drainageThreshold);
  const accumulationRef = sortedAcc[Math.floor(sortedAcc.length * 0.01)] || 1;

  const homeIdx = Math.floor(n / 2) * n + Math.floor(n / 2);
  const homeHandFt = Number.isFinite(hand[homeIdx]) ? hand[homeIdx] * M_TO_FT : null;
  const homeAcc = accumulation[homeIdx] || 1;

  let precip = null;
  try {
    precip = await fetchPrecipFrequency(lat, lng);
  } catch {
    precip = null;
  }
  const rain100 = precip?.curve.find((c) => c.years === 100)?.inches ?? 8;

  /*
   * The regional field is independent of the terrain work above, so it goes out
   * at the same time rather than after it.
   */
  const weatherPromise = fetchWeatherField({ lat, lng, hours })
    .then((value) => ({ value, error: null }))
    .catch((error) => ({ value: null, error: error.message }));

  /* ── rainfall track ── */
  let rainfall = null;
  let rainfallError = null;
  try {
    const { window, antecedent } = await fetchHourlyPrecip(lat, lng, hours);
    // Route over antecedent + window so hour zero already reflects rain that
    // has fallen, then keep only the forward hours for playback.
    const routed = routeRainfall([...antecedent, ...window]).slice(antecedent.length);

    const steps = window.map((row, i) => {
      const effectiveIn = routed[i];
      const tiers = new Int8Array(total).fill(-1);
      let wet = 0;
      let maxDepthFt = 0;

      if (effectiveIn > 0.01) {
        for (let c = 0; c < total; c += 1) {
          const h = hand[c];
          if (!Number.isFinite(h)) continue;
          const depthFt = stageFor(effectiveIn, rain100, accumulation[c], accumulationRef) - h * M_TO_FT;
          if (depthFt < DEPTH_TIERS[0].minFt) continue;
          tiers[c] = tierIndexFor(depthFt);
          wet += 1;
          if (depthFt > maxDepthFt) maxDepthFt = depthFt;
        }
      }

      const homeStage = stageFor(effectiveIn, rain100, homeAcc, accumulationRef);
      const homeDepthFt = homeHandFt != null ? Math.max(0, homeStage - homeHandFt) : null;
      const aboveFloorFt = homeDepthFt != null
        ? Math.max(0, homeDepthFt - finishedFloorAboveGradeFt)
        : null;

      return {
        timestamp: row.timestamp,
        rainIn: Math.round(row.rainIn * 100) / 100,
        chancePct: row.chancePct,
        effectiveIn: Math.round(effectiveIn * 100) / 100,
        tiers: encodeTiers(tiers),
        wetFraction: Math.round((wet / total) * 1000) / 1000,
        maxDepthFt: Math.round(maxDepthFt * 10) / 10,
        homeDepthFt: homeDepthFt != null ? Math.round(homeDepthFt * 100) / 100 : null,
        damageTotal: aboveFloorFt
          ? estimateDamage(aboveFloorFt, { livingSqft, costPerSqft })?.total ?? null
          : null,
      };
    });

    const totalIn = window.reduce((sum, r) => sum + r.rainIn, 0);
    const peakEffective = Math.max(0, ...steps.map((s) => s.effectiveIn));
    const frequency = precip && peakEffective > 0
      ? returnPeriodForRainfall(peakEffective, precip.curve)
      : null;

    rainfall = {
      source: 'Open-Meteo hourly forecast',
      steps,
      totalInchesForecast: Math.round(totalIn * 100) / 100,
      peakEffectiveInches: Math.round(peakEffective * 100) / 100,
      peakAnnualChancePct: frequency ? Math.round(frequency.annualChance * 1000) / 10 : null,
      peakIndex: steps.reduce((best, s, i) => (s.effectiveIn > steps[best].effectiveIn ? i : best), 0),
    };
  } catch (error) {
    rainfallError = error.message;
  }

  /* ── surge track ── */
  let surge = null;
  let surgeError = null;
  if (surgeCategory) {
    try {
      const homeElevM = await elevationAt(lat, lng).catch(() => NaN);
      const exposure = await assessCoastalSurge({
        lat,
        lng,
        groundElevationFt: Number.isFinite(homeElevM) ? homeElevM * M_TO_FT : NaN,
        finishedFloorAboveGradeFt,
      });

      const scenario = exposure?.scenarios?.find((s) => s.category === surgeCategory)
        ?? exposure?.scenarios?.[0] ?? null;
      const mhhwElevFt = exposure?.station?.mhhwNavd88Ft ?? null;

      if (!scenario || mhhwElevFt == null) {
        throw new Error('no surge scenario or tidal datum for this location');
      }

      const startMs = Math.floor(Date.now() / 3600000) * 3600000;
      let tideError = null;
      const tide = await fetchTidePredictions(exposure.station.id, startMs, hours)
        .catch((e) => { tideError = e.message; return []; });

      const tideAt = (ts) => {
        const match = tide.find((t) => Math.abs(t.timestamp - ts) < 1800000);
        return match ? match.ft : 0;
      };

      const timestamps = Array.from({ length: hours }, (_, i) => startMs + i * 3600000);
      // Peak the storm on the highest predicted tide in the window: that is the
      // combination that actually governs, and picking it makes the scenario the
      // credible worst case rather than an arbitrary one. With no tide to key
      // off, land it a third of the way in so the playback still shows a storm
      // arriving rather than one already at its peak in hour zero.
      let peakIndex = tide.length ? 0 : Math.round(hours / 3);
      if (tide.length) {
        timestamps.forEach((ts, i) => {
          if (tideAt(ts) > tideAt(timestamps[peakIndex])) peakIndex = i;
        });
      }

      const elevationsFt = new Float32Array(total);
      for (let i = 0; i < total; i += 1) elevationsFt[i] = grid.elevations[i] * M_TO_FT;

      let mapped = false;
      const steps = timestamps.map((ts, i) => {
        const tideFt = tideAt(ts);
        const surgeFt = surgeAt(i - peakIndex, scenario.surgeAboveMhhwFt);
        const waterLevelFt = mhhwElevFt + tideFt + surgeFt;
        const raster = surgeInundation(elevationsFt, n, waterLevelFt, mhhwElevFt);
        if (raster) mapped = true;

        const homeGroundFt = Number.isFinite(homeElevM) ? homeElevM * M_TO_FT : null;
        const homeDepthFt = homeGroundFt != null
          ? Math.max(0, waterLevelFt - homeGroundFt)
          : null;
        const aboveFloorFt = homeDepthFt != null
          ? Math.max(0, homeDepthFt - finishedFloorAboveGradeFt)
          : null;

        return {
          timestamp: ts,
          tideFt: Math.round(tideFt * 100) / 100,
          surgeFt: Math.round(surgeFt * 100) / 100,
          waterLevelFt: Math.round(waterLevelFt * 100) / 100,
          aboveMhhwFt: Math.round((tideFt + surgeFt) * 100) / 100,
          tiers: raster ? encodeTiers(raster.tiers) : null,
          wetFraction: raster?.wetFraction ?? null,
          maxDepthFt: raster?.maxDepthFt ?? null,
          homeDepthFt: homeDepthFt != null ? Math.round(homeDepthFt * 100) / 100 : null,
          damageTotal: aboveFloorFt
            ? estimateDamage(aboveFloorFt, { livingSqft, costPerSqft })?.total ?? null
            : null,
        };
      });

      surge = {
        category: scenario.category,
        peakSurgeAboveMhhwFt: scenario.surgeAboveMhhwFt,
        station: exposure.station,
        tideSource: tide.length ? 'NOAA CO-OPS hourly tide predictions' : null,
        tideError,
        steps,
        peakIndex,
        mapped,
        basis: tide.length
          ? 'Astronomical tide is a NOAA prediction. The surge riding on it is a scenario for the selected category, shaped as a hydrograph peaked on the highest tide in this window.'
          : 'Tide predictions were unavailable, so this shows the surge scenario alone without the astronomical tide.',
      };
    } catch (error) {
      surgeError = error.message;
    }
  }

  const weatherResult = await weatherPromise;

  const value = {
    ok: true,
    generatedAt: new Date().toISOString(),
    location: { lat, lng },
    grid: {
      samples: n,
      bounds: grid.bounds,
      spacingMetres: grid.spacingMetres,
    },
    hours,
    rainfall,
    rainfallError,
    surge,
    surgeError,
    weather: weatherResult.value,
    weatherError: weatherResult.error,
    method: 'Hourly precipitation is routed through an exponential catchment-storage kernel '
      + '(6-hour half-life) into a 24-hour-equivalent depth, then run through the same '
      + 'HAND stage model as the static scenarios. Surge hours are a connectivity-constrained '
      + 'fill from tidal water at the predicted tide plus a scenario surge.',
    disclaimer: 'Screening-level. Hourly depths show timing and relative severity, not surveyed '
      + 'water levels, and they do not account for local grading, storm-sewer capacity or '
      + 'flood-control structures.',
  };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
