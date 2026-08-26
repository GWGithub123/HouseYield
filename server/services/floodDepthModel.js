/**
 * Screening-level flood depth, likelihood and damage model.
 *
 * Produces the three numbers a homeowner actually asks for — how deep, how
 * often, and how much it costs — from public data only:
 *
 *   depth      HAND (Height Above Nearest Drainage) against a modelled
 *              channel stage. HAND is the standard low-cost inundation proxy
 *              and is what gives the result its characteristic shape, hugging
 *              the drainage network instead of ringing the property.
 *   likelihood NOAA Atlas 14 point precipitation frequency, which returns
 *              rainfall depth by return period for the exact coordinates.
 *   damage     FEMA/USACE depth-damage curves applied to a replacement value
 *              derived from living area.
 *
 * IMPORTANT — this is a screening tool, not an engineered flood study. The
 * stage relationship below is a calibrated approximation, not a hydraulic
 * routing model, and every response carries `method` and `disclaimer` strings
 * so the UI can attribute what it draws. Do not present these figures as a
 * substitute for a FEMA Flood Insurance Study or an elevation certificate.
 */
import { fetchElevationGrid, elevationAt } from './terrainTiles.js';
import { assessCoastalSurge } from './coastalSurgeModel.js';

const M_TO_FT = 3.28084;

/* ── NOAA Atlas 14 precipitation frequency ───────────────────────── */

const ATLAS_URL = 'https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv';
const atlasCache = new Map();
const ATLAS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Published curves change rarely.

/**
 * Rainfall depth (inches) by average recurrence interval for the 24-hour
 * duration, which is the standard design storm for riverine/pluvial screening.
 */
export async function fetchPrecipFrequency(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const hit = atlasCache.get(key);
  if (hit && Date.now() - hit.at < ATLAS_TTL_MS) return hit.value;

  const url = `${ATLAS_URL}?lat=${lat}&lon=${lng}&data=depth&units=english&series=pds`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`Atlas 14 HTTP ${response.status}`);
    const text = await response.text();

    const ariLine = text.split('\n').find((l) => l.includes('by duration for ARI'));
    const dayLine = text.split('\n').find((l) => l.trim().startsWith('24-hr:'));
    if (!ariLine || !dayLine) throw new Error('Atlas 14 response missing 24-hr row');

    // Rows read "24-hr:, 2.54,3.07,..." — the field after the colon is empty,
    // and Number('') is 0, which would otherwise seed a bogus zero-year anchor.
    const numbers = (line) => line
      .split(':')[1]
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map(Number)
      .filter(Number.isFinite);

    const periods = numbers(ariLine);
    const depths = numbers(dayLine);
    if (periods.length !== depths.length || periods.length === 0) {
      throw new Error('Atlas 14 row/period length mismatch');
    }

    const value = {
      source: 'NOAA Atlas 14 point precipitation frequency (24-hour, partial duration)',
      durationHours: 24,
      curve: periods.map((years, i) => ({ years, inches: depths[i] })),
    };
    atlasCache.set(key, { at: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Interpolate a rainfall depth onto the frequency curve.
 * Return period grows roughly log-linearly with depth, so interpolation is done
 * in log space; outside the published range the nearest anchor is reported and
 * flagged rather than extrapolated into fantasy.
 */
export function returnPeriodForRainfall(inches, curve) {
  if (!curve?.length || !Number.isFinite(inches)) return null;
  const first = curve[0];
  const last = curve[curve.length - 1];

  if (inches <= first.inches) {
    return { years: first.years, annualChance: 1 / first.years, bounded: 'below' };
  }
  if (inches >= last.inches) {
    return { years: last.years, annualChance: 1 / last.years, bounded: 'above' };
  }

  for (let i = 1; i < curve.length; i += 1) {
    const lo = curve[i - 1];
    const hi = curve[i];
    if (inches > hi.inches) continue;
    const t = (inches - lo.inches) / (hi.inches - lo.inches);
    const years = Math.exp(Math.log(lo.years) + t * (Math.log(hi.years) - Math.log(lo.years)));
    return { years, annualChance: 1 / years, bounded: null };
  }
  return null;
}

/* ── terrain analysis: flow, drainage network, HAND ──────────────── */

const D8 = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

/**
 * Steepest-descent flow direction plus contributing-area accumulation.
 * Cells are processed from high to low so every donor is resolved before the
 * cell it drains into.
 */
export function computeFlow(elevations, n) {
  const downstream = new Int32Array(n * n).fill(-1);
  const accumulation = new Float32Array(n * n).fill(1);

  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const i = r * n + c;
      const e = elevations[i];
      if (!Number.isFinite(e)) continue;
      let bestDrop = 0;
      let best = -1;
      for (const [dr, dc] of D8) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= n || nc >= n) continue;
        const j = nr * n + nc;
        const ne = elevations[j];
        if (!Number.isFinite(ne)) continue;
        // Normalise by distance so diagonals do not win on raw drop alone.
        const dist = dr && dc ? Math.SQRT2 : 1;
        const slope = (e - ne) / dist;
        if (slope > bestDrop) {
          bestDrop = slope;
          best = j;
        }
      }
      downstream[i] = best;
    }
  }

  const order = Array.from({ length: n * n }, (_, i) => i)
    .filter((i) => Number.isFinite(elevations[i]))
    .sort((a, b) => elevations[b] - elevations[a]);

  for (const i of order) {
    const d = downstream[i];
    if (d >= 0) accumulation[d] += accumulation[i];
  }

  return { downstream, accumulation };
}

/**
 * Height Above Nearest Drainage.
 *
 * Walks each cell downhill along the flow network until it reaches a drainage
 * cell, then reports the elevation difference. Results are memoised as the
 * walk unwinds, so the whole grid resolves in roughly linear time.
 */
export function computeHand(elevations, n, downstream, accumulation, drainageThreshold) {
  const isDrainage = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i += 1) {
    if (accumulation[i] >= drainageThreshold && Number.isFinite(elevations[i])) isDrainage[i] = 1;
  }

  const hand = new Float32Array(n * n).fill(NaN);
  const outletElev = new Float32Array(n * n).fill(NaN);

  for (let start = 0; start < n * n; start += 1) {
    if (!Number.isFinite(elevations[start]) || Number.isFinite(outletElev[start])) continue;

    const path = [];
    let cur = start;
    let guard = 0;
    let resolved = NaN;

    while (guard < n * n) {
      guard += 1;
      if (!Number.isFinite(elevations[cur])) break;
      if (isDrainage[cur]) { resolved = elevations[cur]; break; }
      if (Number.isFinite(outletElev[cur])) { resolved = outletElev[cur]; break; }
      path.push(cur);
      const next = downstream[cur];
      // A pit with no downhill neighbour is its own local outlet.
      if (next < 0) { resolved = elevations[cur]; break; }
      cur = next;
    }

    if (!Number.isFinite(resolved)) resolved = elevations[cur];
    for (const idx of path) {
      outletElev[idx] = resolved;
      hand[idx] = Math.max(0, elevations[idx] - resolved);
    }
    if (Number.isFinite(elevations[cur])) {
      outletElev[cur] = resolved;
      hand[cur] = Math.max(0, elevations[cur] - resolved);
    }
  }

  return { hand, isDrainage };
}

/* ── stage model ─────────────────────────────────────────────────── */

/**
 * Channel stage above the drainage line for a design storm.
 *
 * Anchored so a 100-year 24-hour event produces roughly 4.5 ft of stage in a
 * small suburban catchment, which is the order of magnitude FEMA studies
 * report for such settings. Stage grows faster than rainfall (exponent > 1)
 * because runoff response is non-linear once soils saturate, and grows with
 * contributing area because larger catchments concentrate more water.
 *
 * This is the model's biggest simplification and the reason every result is
 * labelled as screening-level.
 */
const STAGE_100YR_FT = 4.5;
const RAIN_EXPONENT = 1.4;
const AREA_EXPONENT = 0.3;

export function stageFor(rainInches, rain100Inches, accumulation, accumulationRef) {
  if (!(rain100Inches > 0)) return 0;
  const rainRatio = Math.max(0, rainInches / rain100Inches);
  const areaRatio = accumulationRef > 0
    ? Math.max(0.35, Math.min(2.4, accumulation / accumulationRef))
    : 1;
  return STAGE_100YR_FT * Math.pow(rainRatio, RAIN_EXPONENT) * Math.pow(areaRatio, AREA_EXPONENT);
}

/* ── surge inundation ────────────────────────────────────────────── */

/**
 * Spatial surge inundation for one still-water level.
 *
 * Surge is not routed by the drainage network, so `stageFor` and HAND are the
 * wrong tools: it is ocean water pushed inland, filling whatever it can reach
 * from the coast up to some elevation. That makes it a connectivity problem
 * rather than a rainfall problem.
 *
 * A naive "flood every cell below the water level" bathtub is the usual
 * shortcut and it lies badly — it floods inland depressions that have no path
 * to the sea, which is precisely the false positive that makes people distrust
 * surge maps. So we flood-fill outward from cells that are actually tidal water
 * and only cross into neighbours that sit below the water level. A hollow
 * behind high ground stays dry, as it should.
 *
 * Cells at or below MHHW are existing open water and are left untiered: the
 * overlay is meant to show land that floods, not to repaint the bay.
 *
 * @param {Float32Array|number[]} elevationsFt Row-major elevations, feet.
 * @param {number} n Cells per side.
 * @param {number} waterLevelFt Still-water elevation, same datum as elevations.
 * @param {number} mhhwElevFt MHHW elevation, same datum.
 * @returns {{tiers:number[],wetFraction:number,maxDepthFt:number,seedCells:number}|null}
 *   null when the window contains no tidal water to fill from.
 */
export function surgeInundation(elevationsFt, n, waterLevelFt, mhhwElevFt) {
  const total = n * n;
  const tiers = new Int8Array(total).fill(-1);
  const visited = new Uint8Array(total);
  const queue = [];

  for (let i = 0; i < total; i += 1) {
    const e = elevationsFt[i];
    if (!Number.isFinite(e)) continue;
    if (e <= mhhwElevFt) {
      visited[i] = 1;
      queue.push(i);
    }
  }

  const seedCells = queue.length;
  // No tidal water in frame means we cannot establish a path from the sea, and
  // guessing one would reintroduce the bathtub error we just avoided.
  if (seedCells === 0) return null;

  let head = 0;
  let wet = 0;
  let maxDepthFt = 0;

  while (head < queue.length) {
    const i = queue[head];
    head += 1;
    const row = Math.floor(i / n);
    const col = i % n;
    const e = elevationsFt[i];

    // Tier only genuine land inundation; open water keeps tier -1.
    if (e > mhhwElevFt) {
      const depth = waterLevelFt - e;
      if (depth > 0) {
        tiers[i] = tierIndexFor(depth);
        wet += 1;
        if (depth > maxDepthFt) maxDepthFt = depth;
      }
    }

    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (!dr && !dc) continue;
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= n || c >= n) continue;
        const j = r * n + c;
        if (visited[j]) continue;
        const ej = elevationsFt[j];
        if (!Number.isFinite(ej)) continue;
        if (ej < waterLevelFt) {
          visited[j] = 1;
          queue.push(j);
        }
      }
    }
  }

  return {
    tiers: Array.from(tiers),
    wetFraction: Math.round((wet / total) * 1000) / 1000,
    maxDepthFt: Math.round(maxDepthFt * 10) / 10,
    seedCells,
  };
}

/* ── depth-damage ────────────────────────────────────────────────── */

/**
 * FEMA / USACE depth-damage relationship for a one-storey single-family home
 * with no basement, expressed as percent of replacement value by depth of
 * water above the finished floor. Values follow the widely published
 * FIA/USACE curve used in FEMA Benefit-Cost Analysis.
 */
const STRUCTURE_DAMAGE_CURVE = [
  { ft: 0, pct: 0.13 }, { ft: 1, pct: 0.23 }, { ft: 2, pct: 0.32 },
  { ft: 3, pct: 0.40 }, { ft: 4, pct: 0.47 }, { ft: 5, pct: 0.53 },
  { ft: 6, pct: 0.58 }, { ft: 7, pct: 0.63 }, { ft: 8, pct: 0.67 },
];

const CONTENTS_DAMAGE_CURVE = [
  { ft: 0, pct: 0.08 }, { ft: 1, pct: 0.14 }, { ft: 2, pct: 0.21 },
  { ft: 3, pct: 0.27 }, { ft: 4, pct: 0.33 }, { ft: 5, pct: 0.38 },
  { ft: 6, pct: 0.43 }, { ft: 7, pct: 0.47 }, { ft: 8, pct: 0.50 },
];

/** National-average replacement cost when we have nothing better. */
export const DEFAULT_REPLACEMENT_COST_PER_SQFT = 180;

function interpCurve(curve, depthFt) {
  if (depthFt <= curve[0].ft) return depthFt < 0 ? 0 : curve[0].pct;
  const last = curve[curve.length - 1];
  if (depthFt >= last.ft) return last.pct;
  for (let i = 1; i < curve.length; i += 1) {
    if (depthFt > curve[i].ft) continue;
    const lo = curve[i - 1];
    const hi = curve[i];
    const t = (depthFt - lo.ft) / (hi.ft - lo.ft);
    return lo.pct + t * (hi.pct - lo.pct);
  }
  return last.pct;
}

/**
 * Damage for a given depth of water above the finished floor.
 * Replacement value is derived from living area rather than market value: an
 * AVM includes land, and land does not flood.
 */
export function estimateDamage(depthAboveFloorFt, options = {}) {
  const {
    livingSqft,
    costPerSqft = DEFAULT_REPLACEMENT_COST_PER_SQFT,
    contentsRatio = 0.4,
  } = options;

  if (!(livingSqft > 0)) return null;
  if (!(depthAboveFloorFt > 0)) {
    return { structure: 0, contents: 0, total: 0, structureValue: livingSqft * costPerSqft };
  }

  const structureValue = livingSqft * costPerSqft;
  const contentsValue = structureValue * contentsRatio;
  const structure = structureValue * interpCurve(STRUCTURE_DAMAGE_CURVE, depthAboveFloorFt);
  const contents = contentsValue * interpCurve(CONTENTS_DAMAGE_CURVE, depthAboveFloorFt);

  return {
    structure: Math.round(structure),
    contents: Math.round(contents),
    total: Math.round(structure + contents),
    structureValue: Math.round(structureValue),
  };
}

/* ── depth tiers ─────────────────────────────────────────────────── */

/** Mirrors DEPTH_TIERS in src/design-system/riskPalette.ts. */
export const DEPTH_TIERS = [
  { id: 'd0', minFt: 0.1, maxFt: 0.5, label: '0 – 0.5 ft' },
  { id: 'd1', minFt: 0.5, maxFt: 1, label: '0.5 – 1 ft' },
  { id: 'd2', minFt: 1, maxFt: 2, label: '1 – 2 ft' },
  { id: 'd3', minFt: 2, maxFt: 3, label: '2 – 3 ft' },
  { id: 'd4', minFt: 3, maxFt: null, label: '3+ ft' },
];

export function tierIndexFor(depthFt) {
  if (!(depthFt >= DEPTH_TIERS[0].minFt)) return -1;
  for (let i = 0; i < DEPTH_TIERS.length; i += 1) {
    const t = DEPTH_TIERS[i];
    if (t.maxFt == null || depthFt < t.maxFt) return i;
  }
  return DEPTH_TIERS.length - 1;
}

/* ── top-level analysis ──────────────────────────────────────────── */

const analysisCache = new Map();
const ANALYSIS_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Bump whenever the response shape or the model maths changes, so cached
 * entries from an older version are never served against newer client code.
 */
const MODEL_VERSION = 'v9-lot-feeders';

/**
 * Full depth/probability/damage analysis for a property.
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lng
 * @param {number} [params.radiusMetres] Half-width of the analysed window.
 * @param {number} [params.samples] Raster resolution per side.
 * @param {number} [params.livingSqft] Drives the damage estimate.
 * @param {number} [params.costPerSqft]
 * @param {number} [params.finishedFloorAboveGradeFt] Typical slab/crawl rise.
 */
/**
 * Cache identity for one analysis.
 *
 * Shared with the pre-limiter peek below rather than inlined, because the two
 * silently disagreeing would be invisible: the peek would simply never find
 * anything and every request would look like a miss.
 */
function depthCacheKey(params) {
  const {
    lat,
    lng,
    radiusMetres = 900,
    samples = 96,
    livingSqft,
    costPerSqft = DEFAULT_REPLACEMENT_COST_PER_SQFT,
    finishedFloorAboveGradeFt = 1.5,
  } = params;
  return [
    MODEL_VERSION,
    lat.toFixed(4), lng.toFixed(4), radiusMetres, samples,
    livingSqft || 0, costPerSqft, finishedFloorAboveGradeFt,
  ].join('|');
}

/**
 * Return an already-computed analysis, or null. Never fetches.
 *
 * Exists so the HTTP layer can answer from cache without spending rate-limit
 * budget on a request that touches no upstream service.
 */
export function peekFloodDepth(params) {
  const cached = analysisCache.get(depthCacheKey(params));
  return cached && Date.now() - cached.at < ANALYSIS_TTL_MS ? cached.value : null;
}

export async function analyzeFloodDepth(params) {
  const {
    lat,
    lng,
    radiusMetres = 900,
    samples = 96,
    livingSqft,
    costPerSqft = DEFAULT_REPLACEMENT_COST_PER_SQFT,
    finishedFloorAboveGradeFt = 1.5,
  } = params;

  const cacheKey = depthCacheKey(params);
  const cached = analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ANALYSIS_TTL_MS) return cached.value;

  const grid = await fetchElevationGrid(lat, lng, radiusMetres, samples);
  const n = grid.samples;
  const { downstream, accumulation } = computeFlow(grid.elevations, n);

  // Treat the top ~4% of accumulation as the drainage network. Percentile
  // rather than a fixed count so flat and steep terrain both behave.
  const sortedAcc = Array.from(accumulation).sort((a, b) => b - a);
  const drainageThreshold = Math.max(6, sortedAcc[Math.floor(sortedAcc.length * 0.04)] || 6);
  const { hand, isDrainage } = computeHand(grid.elevations, n, downstream, accumulation, drainageThreshold);

  const accumulationRef = sortedAcc[Math.floor(sortedAcc.length * 0.01)] || 1;

  let precip = null;
  let precipError = null;
  try {
    precip = await fetchPrecipFrequency(lat, lng);
  } catch (error) {
    precipError = error.message;
  }
  const rain100 = precip?.curve.find((c) => c.years === 100)?.inches ?? 8;

  // Where the home itself sits, in the grid and in elevation terms.
  const homeElevM = await elevationAt(lat, lng).catch(() => NaN);
  const homeRow = Math.floor(n / 2);
  const homeCol = Math.floor(n / 2);
  const homeIdx = homeRow * n + homeCol;
  const homeHandFt = Number.isFinite(hand[homeIdx]) ? hand[homeIdx] * M_TO_FT : null;
  const homeAcc = accumulation[homeIdx] || 1;

  /** Build a depth raster for one storm total. */
  const scenarioFor = (rainInches) => {
    const tiers = new Int8Array(n * n).fill(-1);
    let wetCells = 0;
    let maxDepthFt = 0;

    for (let i = 0; i < n * n; i += 1) {
      const h = hand[i];
      if (!Number.isFinite(h)) continue;
      const stage = stageFor(rainInches, rain100, accumulation[i], accumulationRef);
      const depthFt = stage - h * M_TO_FT;
      if (depthFt < DEPTH_TIERS[0].minFt) continue;
      tiers[i] = tierIndexFor(depthFt);
      wetCells += 1;
      if (depthFt > maxDepthFt) maxDepthFt = depthFt;
    }

    const homeStage = stageFor(rainInches, rain100, homeAcc, accumulationRef);
    const homeDepthFt = homeHandFt != null ? Math.max(0, homeStage - homeHandFt) : null;
    const aboveFloorFt = homeDepthFt != null
      ? Math.max(0, homeDepthFt - finishedFloorAboveGradeFt)
      : null;
    const frequency = precip ? returnPeriodForRainfall(rainInches, precip.curve) : null;

    return {
      rainInches,
      returnPeriodYears: frequency ? Math.round(frequency.years * 10) / 10 : null,
      annualChancePct: frequency ? Math.round(frequency.annualChance * 1000) / 10 : null,
      frequencyBounded: frequency?.bounded ?? null,
      tiers: Array.from(tiers),
      wetFraction: Math.round((wetCells / (n * n)) * 1000) / 1000,
      maxDepthFt: Math.round(maxDepthFt * 10) / 10,
      home: {
        depthFt: homeDepthFt != null ? Math.round(homeDepthFt * 10) / 10 : null,
        depthAboveFloorFt: aboveFloorFt != null ? Math.round(aboveFloorFt * 10) / 10 : null,
        tier: homeDepthFt != null ? tierIndexFor(homeDepthFt) : -1,
        damage: aboveFloorFt != null
          ? estimateDamage(aboveFloorFt, { livingSqft, costPerSqft })
          : null,
      },
    };
  };

  const STORM_CHIPS = [0.5, 1, 2, 3, 4, 6];
  const scenarios = STORM_CHIPS.map(scenarioFor);

  /*
   * Surge is a different mechanism with a different vertical datum, so it is
   * assessed independently. Critically, it can be the governing hazard at a site
   * the rainfall model calls dry: HAND measures height above the nearest ditch,
   * which tells you nothing about an ocean 1,000 ft away. Without this a
   * low-lying oceanfront property gets a confident and false all-clear.
   */
  let surge = null;
  try {
    surge = await assessCoastalSurge({
      lat,
      lng,
      groundElevationFt: Number.isFinite(homeElevM) ? homeElevM * M_TO_FT : NaN,
      finishedFloorAboveGradeFt,
    });
  } catch (error) {
    surge = { ok: false, error: error.message };
  }

  /*
   * Drainage network for the neighbourhood view, traced from the same DEM that
   * produced the depth raster.
   *
   * Deriving it here rather than reusing mapped OSM waterways matters: the
   * corridors then agree with the raster by construction. Mixing sources means
   * drawing a stream where the model shows no water, or worse, showing water
   * with no channel — and the viewer has no way to tell which one is lying.
   *
   * Each channel is traced from a headwater cell downstream until it merges into
   * an already-traced channel or leaves the window, so shared trunks are drawn
   * once instead of once per tributary.
   */
  const drainageNetwork = (() => {
    const visited = new Uint8Array(n * n);
    const channels = [];

    /** A drainage cell is a head when nothing upstream of it also drains. */
    const isHead = (idx) => {
      const row = Math.floor(idx / n);
      const col = idx % n;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (!dr && !dc) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= n || c >= n) continue;
          const j = r * n + c;
          if (isDrainage[j] && downstream[j] === idx) return false;
        }
      }
      return true;
    };

    const trace = (start) => {
      const path = [];
      let idx = start;
      let peak = 0;

      while (idx >= 0 && isDrainage[idx] && !visited[idx]) {
        visited[idx] = 1;
        const p = grid.cellCenter(Math.floor(idx / n), idx % n);
        path.push({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) });
        peak = Math.max(peak, accumulation[idx]);
        idx = downstream[idx];
      }

      // Carry one step into the merge target so tributaries visually connect to
      // the trunk instead of stopping a cell short of it.
      if (idx >= 0 && isDrainage[idx]) {
        const p = grid.cellCenter(Math.floor(idx / n), idx % n);
        path.push({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) });
      }

      if (path.length < 3) return;
      channels.push({
        path,
        strength: Math.round(Math.min(1, Math.log10(1 + peak) / Math.log10(1 + accumulationRef)) * 100) / 100,
      });
    };

    for (let i = 0; i < n * n; i += 1) {
      if (isDrainage[i] && !visited[i] && isHead(i)) trace(i);
    }
    // Anything left is a loop or an interior fragment with no traced head.
    for (let i = 0; i < n * n; i += 1) {
      if (isDrainage[i] && !visited[i]) trace(i);
    }

    channels.sort((a, b) => b.strength - a.strength);
    return { channels: channels.slice(0, 160) };
  })();

  /*
   * Lot-scale flow field. The neighbourhood view answers "where does water
   * collect"; the lot view has to answer "which way does it cross my yard", so
   * we emit the D8 direction per cell over a small window around the house
   * rather than the whole grid.
   */
  const lotFlow = (() => {
    /*
     * When the caller asks for a tight radius it is the lot view, which wants a
     * parcel-sized window densely seeded. The neighbourhood view wants a small
     * excerpt of a much wider grid. Sizing the window in metres rather than in
     * cells keeps both honest as the sampling resolution changes.
     *
     * Note the DEM itself tops out near 10 m, so asking for finer spacing than
     * that yields interpolated cells with no gradient between them and D8
     * simply finds no downstream — sampling harder produces fewer flow paths,
     * not more detail.
     */
    const lotMode = radiusMetres <= 600;
    // ~220 m across, which is roughly what the lot view frames at zoom 19. A
    // narrower window leaves the edges of the map bare.
    const targetHalfMetres = lotMode ? 110 : n * 0.09 * grid.spacingMetres;
    const half = Math.max(
      3,
      Math.min(Math.floor(n / 2) - 1, Math.round(targetHalfMetres / grid.spacingMetres)),
    );
    // Seed every cell at lot scale; the wider view only needs a sparse sample.
    const STEP = lotMode ? 1 : 2;
    /*
     * Extra spacing between streamlines, in cells, beyond "do not redraw a line
     * that already exists".
     *
     * Zero at lot scale on purpose. The merge rule below already guarantees
     * every cell ends up on exactly one line, so the network is dense but never
     * overdrawn — which is the whole point of a parcel-scale view. Any positive
     * separation here throws away most of the tributaries and reproduces the
     * sparse, stubby field this view had before.
     */
    const SEED_SEP = lotMode ? 0 : 1;

    const inWindow = (row, col) => row >= homeRow - half && row <= homeRow + half
      && col >= homeCol - half && col <= homeCol + half;

    /*
     * Streamlines, seeded from the headwaters down.
     *
     * Seed ORDER is the whole ballgame here, and getting it wrong is subtle.
     * Scanning the window row by row means the first seed traces a long path and
     * marks every cell on it; nearly every later seed then starts on, or
     * immediately runs into, that path and produces a two-point stub that gets
     * discarded. The result is a handful of short disconnected lines — which is
     * exactly what the lot view was showing.
     *
     * Seeding from the cells with the LEAST upslope area first inverts that.
     * Headwaters trace their full length down to whatever they join, so the
     * network builds up the way water actually organises itself: many fine
     * tributaries converging into progressively larger channels. A trunk is
     * drawn once, by whichever tributary reached it first, and everything after
     * merges into it rather than being thrown away.
     */
    const streamlines = [];
    /** Cells already carrying a drawn line, used to merge and to space seeds. */
    const covered = new Uint8Array(n * n);
    /** Cells too close to a drawn line to be worth seeding from. */
    const nearLine = new Uint8Array(n * n);
    const MAX_STEPS = 60;

    const markNear = (idx) => {
      if (SEED_SEP <= 0) return;
      const row = Math.floor(idx / n);
      const col = idx % n;
      for (let dr = -SEED_SEP; dr <= SEED_SEP; dr += 1) {
        for (let dc = -SEED_SEP; dc <= SEED_SEP; dc += 1) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= n || c >= n) continue;
          nearLine[r * n + c] = 1;
        }
      }
    };

    const seeds = [];
    for (let row = homeRow - half; row <= homeRow + half; row += STEP) {
      for (let col = homeCol - half; col <= homeCol + half; col += STEP) {
        if (row < 0 || col < 0 || row >= n || col >= n) continue;
        seeds.push(row * n + col);
      }
    }
    seeds.sort((a, b) => accumulation[a] - accumulation[b]);

    for (const seed of seeds) {
      if (covered[seed] || nearLine[seed]) continue;

      let idx = seed;
      const path = [];
      const walked = [];
      let peakAcc = 0;
      let touchesDrainage = false;
      let steps = 0;

      while (idx >= 0 && steps < MAX_STEPS) {
        const r = Math.floor(idx / n);
        const c = idx % n;
        const p = grid.cellCenter(r, c);
        path.push({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) });
        walked.push(idx);

        peakAcc = Math.max(peakAcc, accumulation[idx]);
        if (isDrainage[idx]) touchesDrainage = true;

        const next = downstream[idx];
        if (next < 0) break;
        // Run one cell past the stopping point either way, so a line leaves
        // frame or joins its trunk cleanly instead of ending a cell short.
        const leavingWindow = !inWindow(Math.floor(next / n), next % n);
        if (leavingWindow || covered[next]) {
          const q = grid.cellCenter(Math.floor(next / n), next % n);
          path.push({ lat: Number(q.lat.toFixed(6)), lng: Number(q.lng.toFixed(6)) });
          break;
        }
        idx = next;
        steps += 1;
      }

      /*
       * At neighbourhood scale a two-point path is a direction arrow rather
       * than a stream, and a field of them reads as scattered stubs. At lot
       * scale it means "this cell drains straight into a line we already drew",
       * which is a real feeder off the trunk and spans a visible 10-14 m of
       * yard. Keeping them is most of the difference between a parcel view that
       * looks sampled and one that looks surveyed.
       */
      if (path.length < (lotMode ? 2 : 3)) continue;

      for (const cell of walked) {
        covered[cell] = 1;
        markNear(cell);
      }

      streamlines.push({
        path,
        strength: Math.round(Math.min(1, Math.log10(1 + peakAcc) / Math.log10(1 + accumulationRef)) * 100) / 100,
        isDrainage: touchesDrainage,
      });
    }

    streamlines.sort((a, b) => b.strength - a.strength);

    // Which way the ground falls at the house, and whether the house sits
    // uphill or downhill of what drains toward it.
    const homeDownstream = downstream[homeIdx];
    const homeFall = homeDownstream >= 0
      ? (() => {
        const from = grid.cellCenter(homeRow, homeCol);
        const to = grid.cellCenter(Math.floor(homeDownstream / n), homeDownstream % n);
        const bearing = (Math.atan2(to.lng - from.lng, to.lat - from.lat) * 180) / Math.PI;
        const dropM = grid.elevations[homeIdx] - grid.elevations[homeDownstream];
        return {
          bearingDeg: Math.round((bearing + 360) % 360),
          slopePct: Math.round((dropM / grid.spacingMetres) * 1000) / 10,
        };
      })()
      : null;

    /** How much upslope area drains through the house cell, in square metres. */
    const contributingAreaSqm = Math.round(homeAcc * grid.spacingMetres * grid.spacingMetres);

    return {
      windowMetres: Math.round(half * 2 * grid.spacingMetres),
      spacingMetres: Math.round(grid.spacingMetres * 10) / 10,
      /*
       * Sort before truncating. Dendritic seeding traces headwaters first and
       * trunks last, so slicing the raw array drops the largest channels on the
       * lot — the opposite of what a cap is for. The lot view also gets a much
       * higher ceiling: at 10 m spacing a parcel window fills with real,
       * distinct flow paths, and clipping them is what made this view look
       * coarser than the neighbourhood one.
       */
      streamlines: streamlines
        .sort((a, b) => b.strength - a.strength)
        .slice(0, lotMode ? 400 : 160),
      homeFall,
      contributingAreaSqm,
      /**
       * True when a mapped drainage line runs through the lot window — the
       * strongest single signal that the yard carries concentrated flow.
       */
      drainageCrossesLot: streamlines.some((s) => s.isDrainage),
    };
  })();

  /*
   * Give every surge category its own inundation raster, so selecting a category
   * visibly redraws the map instead of reusing a rainfall footprint that happens
   * to have a similar depth at the house. The two mechanisms produce genuinely
   * different shapes — surge floods low ground continuously inland from the
   * water, rainfall fills the drainage lines — and showing one in place of the
   * other misrepresents where the risk actually is.
   */
  if (surge?.exposed && surge.scenarios?.length && surge.station?.mhhwNavd88Ft != null) {
    const mhhwElevFt = surge.station.mhhwNavd88Ft;
    const elevationsFt = new Float32Array(n * n);
    for (let i = 0; i < n * n; i += 1) elevationsFt[i] = grid.elevations[i] * M_TO_FT;

    let anyMapped = false;
    surge.scenarios = surge.scenarios.map((scenario) => {
      const waterLevelFt = mhhwElevFt + scenario.surgeAboveMhhwFt;
      const raster = surgeInundation(elevationsFt, n, waterLevelFt, mhhwElevFt);
      if (raster) anyMapped = true;
      return {
        ...scenario,
        waterLevelFt: Math.round(waterLevelFt * 10) / 10,
        tiers: raster?.tiers ?? null,
        wetFraction: raster?.wetFraction ?? null,
        maxDepthFt: raster?.maxDepthFt ?? null,
      };
    });

    surge.mapped = anyMapped;
    surge.mappingNote = anyMapped
      ? 'Inundation is flood-filled inland from tidal water, so low ground with no path to the coast stays dry.'
      : 'No tidal water inside the analysed window, so surge extent could not be mapped here — only the depth at the property is modelled.';
  }

  const rainfallMaxDepth = Math.max(0, ...scenarios.map((s) => s.home.depthFt ?? 0));
  const surgeMaxDepth = surge?.scenarios?.length
    ? Math.max(0, ...surge.scenarios.map((s) => s.depthAtGradeFt ?? 0))
    : 0;

  const value = {
    ok: true,
    generatedAt: new Date().toISOString(),
    location: { lat, lng },
    grid: {
      samples: n,
      bounds: grid.bounds,
      spacingMetres: Math.round(grid.spacingMetres * 10) / 10,
      zoom: grid.zoom,
      coverage: grid.coverage,
    },
    terrain: {
      homeElevationFt: Number.isFinite(homeElevM) ? Math.round(homeElevM * M_TO_FT) : null,
      heightAboveDrainageFt: homeHandFt != null ? Math.round(homeHandFt * 10) / 10 : null,
      minElevationFt: Math.round(grid.minElevation * M_TO_FT),
      maxElevationFt: Math.round(grid.maxElevation * M_TO_FT),
      drainageCells: isDrainage.reduce((a, b) => a + b, 0),
    },
    precipitation: precip
      ? { source: precip.source, durationHours: precip.durationHours, curve: precip.curve }
      : { source: null, error: precipError },
    damageBasis: {
      livingSqft: livingSqft || null,
      costPerSqft,
      finishedFloorAboveGradeFt,
      curve: 'FEMA/USACE depth-damage, 1-storey single-family, no basement',
    },
    tiers: DEPTH_TIERS,
    scenarios,
    drainageNetwork,
    lotFlow,
    coastalSurge: surge,
    /**
     * Which mechanism drives the risk here. Surge wins when it can put more
     * water on the property than rainfall can, which is the normal case for
     * low-lying coastal sites and the reason the rainfall figures above must
     * never be read as the whole story.
     */
    governingHazard: surgeMaxDepth > rainfallMaxDepth
      ? 'coastal_surge'
      : (rainfallMaxDepth > 0 ? 'rainfall' : 'none_modelled'),
    /** Damage for the worst modelled case from either mechanism. */
    worstCase: (() => {
      const depth = Math.max(rainfallMaxDepth, surgeMaxDepth);
      if (depth <= 0) return null;
      const aboveFloor = Math.max(0, depth - finishedFloorAboveGradeFt);
      return {
        source: surgeMaxDepth > rainfallMaxDepth ? 'coastal_surge' : 'rainfall',
        depthAtGradeFt: Math.round(depth * 10) / 10,
        depthAboveFloorFt: Math.round(aboveFloor * 10) / 10,
        damage: estimateDamage(aboveFloor, { livingSqft, costPerSqft }),
      };
    })(),
    method: 'HAND (Height Above Nearest Drainage) on AWS Terrain Tiles DEM, staged against NOAA Atlas 14 point precipitation frequency, with FEMA/USACE depth-damage curves. Coastal surge assessed separately against NOAA tidal datums.',
    disclaimer: 'Screening-level estimate for planning only. Not a hydraulic study, FEMA Flood Insurance Study, or elevation certificate, and not a substitute for flood insurance advice.',
  };

  analysisCache.set(cacheKey, { at: Date.now(), value });
  return value;
}
