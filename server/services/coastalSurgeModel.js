/**
 * Coastal storm surge exposure.
 *
 * WHY THIS EXISTS SEPARATELY FROM floodDepthModel.js
 * -------------------------------------------------
 * The rainfall model measures Height Above Nearest Drainage and stages it
 * against precipitation frequency. That is the right physics for pluvial and
 * riverine flooding and completely the wrong physics for surge, because surge
 * is ocean water pushed inland by wind — it does not care where the nearest
 * ditch is.
 *
 * Left alone, the rainfall model reports a confident "0 ft, no flood risk" for
 * an oceanfront property at 7 ft elevation, because that property genuinely
 * does sit above its local drainage. That false all-clear is far more dangerous
 * than saying nothing, which is the reason this module exists.
 *
 * The correct vertical reference for surge is the tidal datum, not the drainage
 * network: how far the ground sits above Mean Higher High Water. That comes from
 * NOAA CO-OPS, which publishes both tidal datums and station-calibrated
 * flood-stage thresholds, so the routine end of the range is measured rather
 * than modelled.
 *
 * Sources:
 *   NOAA CO-OPS station datums and flood levels (api.tidesandcurrents.noaa.gov)
 *   NHC/SLOSH regional surge envelopes by hurricane category
 */

const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';

/* ── tide station index ──────────────────────────────────────────── */

let stationIndex = null;
let stationIndexAt = 0;
const STATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const datumCache = new Map();

async function loadStationIndex() {
  if (stationIndex && Date.now() - stationIndexAt < STATION_TTL_MS) return stationIndex;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${MDAPI}/stations.json?type=datums`, { signal: controller.signal });
    if (!response.ok) throw new Error(`CO-OPS stations HTTP ${response.status}`);
    const json = await response.json();
    stationIndex = (json.stations || [])
      .filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
      .map((s) => ({ id: s.id, name: s.name, lat: Number(s.lat), lng: Number(s.lng) }));
    stationIndexAt = Date.now();
    return stationIndex;
  } finally {
    clearTimeout(timeout);
  }
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function nearestTideStation(lat, lng) {
  const stations = await loadStationIndex();
  let best = null;
  for (const s of stations) {
    const km = haversineKm(lat, lng, s.lat, s.lng);
    if (!best || km < best.distanceKm) best = { ...s, distanceKm: km };
  }
  return best;
}

/**
 * Tidal datums and flood thresholds for a station, both in station-datum feet.
 * MHHW and NAVD88 are returned on the same reference so the difference gives
 * MHHW as a NAVD88 elevation, which is what terrain elevations are measured
 * against.
 */
export async function stationReference(stationId) {
  const cached = datumCache.get(stationId);
  if (cached && Date.now() - cached.at < STATION_TTL_MS) return cached.value;

  const fetchJson = async (path) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${MDAPI}/stations/${stationId}/${path}`, { signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const [datums, floodLevels] = await Promise.all([
    fetchJson('datums.json?units=english'),
    fetchJson('floodlevels.json'),
  ]);

  const byName = {};
  for (const d of datums?.datums || []) byName[d.name] = Number(d.value);

  const mhhw = byName.MHHW;
  const navd88 = byName.NAVD88;
  if (!Number.isFinite(mhhw)) return null;

  // NAVD88 is not published at every station; without it we cannot tie the
  // tidal datum to terrain elevations, and we say so rather than guessing.
  const mhhwNavd88Ft = Number.isFinite(navd88) ? mhhw - navd88 : null;

  /** NWS thresholds expressed as height above MHHW, which is how they read. */
  const thresholdAboveMhhw = (v) => (Number.isFinite(v) ? Number((v - mhhw).toFixed(2)) : null);

  const value = {
    stationId,
    epoch: datums?.epoch || null,
    mhhwStationFt: mhhw,
    navd88StationFt: Number.isFinite(navd88) ? navd88 : null,
    mhhwNavd88Ft: mhhwNavd88Ft != null ? Number(mhhwNavd88Ft.toFixed(2)) : null,
    floodThresholdsAboveMhhwFt: floodLevels
      ? {
        minor: thresholdAboveMhhw(floodLevels.nws_minor ?? floodLevels.nos_minor),
        moderate: thresholdAboveMhhw(floodLevels.nws_moderate ?? floodLevels.nos_moderate),
        major: thresholdAboveMhhw(floodLevels.nws_major ?? floodLevels.nos_major),
      }
      : null,
  };

  datumCache.set(stationId, { at: Date.now(), value });
  return value;
}

/* ── regional surge envelopes ────────────────────────────────────── */

/**
 * Representative SLOSH surge height above MHHW by hurricane category, and the
 * rough climatological recurrence of a strike of that category or stronger.
 *
 * These are REGIONAL ENVELOPES, not a SLOSH raster lookup for a specific
 * address. Actual surge at a point depends on storm track, forward speed, angle
 * of approach, local bathymetry and tide stage, and can differ substantially
 * from these figures. They are here to establish order of magnitude and to stop
 * the rainfall model reporting a false all-clear — the response links to the
 * NHC maps for the authoritative answer.
 */
const SURGE_REGIONS = {
  gulf_florida: { label: 'Florida Gulf coast', surge: { 1: 5.5, 2: 8.5, 3: 12, 4: 17, 5: 22 }, recurrenceYears: { 1: 7, 2: 14, 3: 25, 4: 60, 5: 150 } },
  gulf_north: { label: 'Northern Gulf coast', surge: { 1: 5, 2: 8, 3: 12, 4: 17, 5: 22 }, recurrenceYears: { 1: 8, 2: 16, 3: 28, 4: 70, 5: 170 } },
  southeast_atlantic: { label: 'Southeast Atlantic coast', surge: { 1: 4.5, 2: 7, 3: 10.5, 4: 14.5, 5: 19 }, recurrenceYears: { 1: 9, 2: 20, 3: 40, 4: 100, 5: 260 } },
  mid_atlantic: { label: 'Mid-Atlantic coast', surge: { 1: 5, 2: 7.5, 3: 11, 4: 15 }, recurrenceYears: { 1: 12, 2: 30, 3: 90, 4: 250 } },
  northeast: { label: 'Northeast coast', surge: { 1: 5.5, 2: 8, 3: 11.5, 4: 15 }, recurrenceYears: { 1: 15, 2: 40, 3: 120, 4: 350 } },
  west_coast: { label: 'Pacific coast', surge: { 1: 2.5, 2: 3.5 }, recurrenceYears: { 1: 100, 2: 400 } },
  other: { label: 'Coastal', surge: { 1: 4.5, 2: 7, 3: 10.5, 4: 14.5 }, recurrenceYears: { 1: 15, 2: 40, 3: 110, 4: 300 } },
};

/** Coarse regional bucket from position. */
export function surgeRegionFor(lat, lng) {
  if (lng < -115) return 'west_coast';
  if (lng >= -98 && lng <= -80 && lat < 31) return 'gulf_florida';
  if (lng >= -98 && lng < -85 && lat >= 28 && lat < 32) return 'gulf_north';
  if (lat >= 30 && lat < 36.6) return 'southeast_atlantic';
  if (lat >= 36.6 && lat < 40.5) return 'mid_atlantic';
  if (lat >= 40.5) return 'northeast';
  return 'other';
}

/* ── exposure screen ─────────────────────────────────────────────── */

/**
 * How close to tidal water a property must be before surge is worth modelling.
 * Tide gauges sit on tidal water, so proximity to one is a serviceable proxy.
 * Generous on purpose: surge travels far up bays, canals and tidal creeks, and
 * under-flagging is the failure mode that matters here.
 */
const TIDAL_PROXIMITY_KM = 30;
/** Above this height over MHHW, surge stops being a credible threat. */
const SURGE_CEILING_ABOVE_MHHW_FT = 30;

/**
 * Assess coastal surge exposure for a property.
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lng
 * @param {number} params.groundElevationFt Terrain elevation, treated as NAVD88.
 * @param {number} [params.finishedFloorAboveGradeFt]
 * @returns {Promise<object|null>} null when the site is not tidally exposed.
 */
export async function assessCoastalSurge({
  lat,
  lng,
  groundElevationFt,
  finishedFloorAboveGradeFt = 1.5,
}) {
  let station;
  try {
    station = await nearestTideStation(lat, lng);
  } catch (error) {
    return { ok: false, error: `tide_station_lookup_failed: ${error.message}` };
  }
  if (!station) return null;

  const tidallyClose = station.distanceKm <= TIDAL_PROXIMITY_KM;
  if (!tidallyClose) return null;

  const reference = await stationReference(station.id);
  if (!reference) {
    return {
      exposed: true,
      confidence: 'unknown',
      station: { id: station.id, name: station.name, distanceKm: Number(station.distanceKm.toFixed(1)) },
      note: 'Nearest tide station publishes no usable datums, so surge depth cannot be estimated here.',
    };
  }

  const regionId = surgeRegionFor(lat, lng);
  const region = SURGE_REGIONS[regionId];

  // Freeboard: how far the ground sits above mean higher high water. This is
  // the number surge has to overcome, and it is the whole ball game.
  const freeboardFt = reference.mhhwNavd88Ft != null && Number.isFinite(groundElevationFt)
    ? Number((groundElevationFt - reference.mhhwNavd88Ft).toFixed(1))
    : null;

  if (freeboardFt != null && freeboardFt > SURGE_CEILING_ABOVE_MHHW_FT) return null;

  const scenarios = Object.entries(region.surge).map(([category, surgeAboveMhhwFt]) => {
    const depthAtGradeFt = freeboardFt != null
      ? Math.max(0, Number((surgeAboveMhhwFt - freeboardFt).toFixed(1)))
      : null;
    const recurrence = region.recurrenceYears[category];
    return {
      category: Number(category),
      surgeAboveMhhwFt,
      depthAtGradeFt,
      depthAboveFloorFt: depthAtGradeFt != null
        ? Math.max(0, Number((depthAtGradeFt - finishedFloorAboveGradeFt).toFixed(1)))
        : null,
      recurrenceYears: recurrence ?? null,
      annualChancePct: recurrence ? Number(((1 / recurrence) * 100).toFixed(1)) : null,
    };
  });

  // Routine coastal flooding, from measured station thresholds rather than the
  // regional envelope. This end of the range is the trustworthy end.
  const thresholds = reference.floodThresholdsAboveMhhwFt;
  const routine = thresholds
    ? Object.entries(thresholds)
      .filter(([, aboveMhhw]) => aboveMhhw != null)
      .map(([level, aboveMhhwFt]) => ({
        level,
        aboveMhhwFt,
        depthAtGradeFt: freeboardFt != null
          ? Math.max(0, Number((aboveMhhwFt - freeboardFt).toFixed(1)))
          : null,
      }))
    : [];

  const firstWetting = scenarios.find((s) => (s.depthAtGradeFt ?? 0) > 0) ?? null;

  return {
    exposed: true,
    confidence: freeboardFt != null ? 'modelled' : 'unknown',
    region: { id: regionId, label: region.label },
    station: {
      id: station.id,
      name: station.name,
      distanceKm: Number(station.distanceKm.toFixed(1)),
      datumEpoch: reference.epoch,
      mhhwNavd88Ft: reference.mhhwNavd88Ft,
    },
    groundElevationFt: Number.isFinite(groundElevationFt) ? Number(groundElevationFt.toFixed(1)) : null,
    freeboardAboveMhhwFt: freeboardFt,
    routineCoastalFlooding: routine,
    scenarios,
    /** Lowest hurricane category that puts water on the property, if any. */
    firstWettingCategory: firstWetting ? firstWetting.category : null,
    method: 'Ground elevation above NOAA Mean Higher High Water, compared against NWS station flood thresholds for routine coastal flooding and regional SLOSH surge envelopes by hurricane category.',
    disclaimer: 'Surge figures are regional envelopes, not a site-specific SLOSH or FEMA coastal study. Actual surge depends on storm track, forward speed, approach angle, local bathymetry and tide stage. Consult the NHC storm surge maps and your FEMA flood zone (V/VE zones indicate coastal high hazard with wave action).',
    references: [
      { label: 'NHC Storm Surge Risk Maps', url: 'https://www.nhc.noaa.gov/nationalsurge/' },
      { label: 'FEMA Map Service Center', url: 'https://msc.fema.gov/portal' },
      { label: `NOAA tide station ${station.id} — ${station.name}`, url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station.id}` },
    ],
  };
}
