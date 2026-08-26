/**
 * Regional hourly weather field — the "radar" half of the storm playback.
 *
 * The flood timeline already answers "how deep, and when". It cannot answer
 * "what is the sky doing", because a single hourly rain total at one point says
 * nothing about a band sweeping in from the southwest. This module fills that
 * gap by sampling a lattice of points across the region and returning a small
 * raster per hour, so the playback can show weather arriving rather than just
 * a number going up.
 *
 * WHY A LATTICE AND NOT A RADAR MOSAIC
 * ------------------------------------
 * Public radar mosaics (RainViewer, NWS MRMS) are observations plus a very
 * short nowcast — typically 30 minutes ahead. This feature is about the next
 * day, which is forecast territory, so it has to come from a numerical model.
 * Sampling the model on a lattice is the honest way to get a field out of a
 * point-forecast API: every cell is a real model value, and the resolution of
 * the picture is the resolution of the model rather than something invented by
 * interpolation. Smoothing for display happens on the client, where it is
 * clearly cosmetic.
 */

const GRID_N = 11;
/** Roughly 40 km each way — wide enough to see a band before it arrives. */
const SPAN_LAT = 0.72;
const SPAN_LNG = 0.92;

const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 40;

/**
 * WMO code → a short label and a coarse family the client can pick an icon
 * from. Kept narrow on purpose: the exact difference between "slight" and
 * "moderate" drizzle is not something this UI acts on.
 */
const WMO = new Map([
  [0, ['Clear', 'clear']],
  [1, ['Mostly clear', 'clear']],
  [2, ['Partly cloudy', 'partly']],
  [3, ['Overcast', 'cloudy']],
  [45, ['Fog', 'fog']], [48, ['Freezing fog', 'fog']],
  [51, ['Light drizzle', 'drizzle']], [53, ['Drizzle', 'drizzle']], [55, ['Heavy drizzle', 'drizzle']],
  [56, ['Freezing drizzle', 'sleet']], [57, ['Freezing drizzle', 'sleet']],
  [61, ['Light rain', 'rain']], [63, ['Rain', 'rain']], [65, ['Heavy rain', 'rain']],
  [66, ['Freezing rain', 'sleet']], [67, ['Freezing rain', 'sleet']],
  [71, ['Light snow', 'snow']], [73, ['Snow', 'snow']], [75, ['Heavy snow', 'snow']],
  [77, ['Snow grains', 'snow']],
  [80, ['Light showers', 'showers']], [81, ['Showers', 'showers']], [82, ['Violent showers', 'showers']],
  [85, ['Snow showers', 'snow']], [86, ['Heavy snow showers', 'snow']],
  [95, ['Thunderstorm', 'storm']],
  [96, ['Thunderstorm with hail', 'storm']], [99, ['Severe thunderstorm', 'storm']],
]);

function describe(code) {
  const hit = WMO.get(Number(code));
  return { code: Number(code), label: hit?.[0] ?? 'Unsettled', icon: hit?.[1] ?? 'cloudy' };
}

async function getJson(url, timeoutMs = 14000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`open-meteo HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Quantise a field to one byte per cell, then base64.
 *
 * A day of playback is 24 × 121 cells per variable. Sent as JSON numbers that
 * is roughly 15 kB per variable of mostly zeros and decimal points; as bytes it
 * is 121 per hour. The precision thrown away is far below what the model
 * actually resolves.
 */
export function packBytes(values, scale, max = 255) {
  const bytes = Uint8Array.from(values, (v) => {
    const n = Math.round((Number(v) || 0) * scale);
    return Math.max(0, Math.min(max, n));
  });
  return Buffer.from(bytes).toString('base64');
}

/**
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lng
 * @param {number} [params.hours]
 */
export async function fetchWeatherField({ lat, lng, hours = 24 }) {
  const cacheKey = `${lat.toFixed(3)}|${lng.toFixed(3)}|${hours}|${Math.floor(Date.now() / 3600000)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const lats = [];
  const lngs = [];
  for (let r = 0; r < GRID_N; r += 1) {
    for (let c = 0; c < GRID_N; c += 1) {
      // Row 0 is the NORTH edge, so the raster is already in image order and
      // the client can hand it straight to a canvas.
      lats.push((lat + SPAN_LAT * (0.5 - r / (GRID_N - 1))).toFixed(4));
      lngs.push((lng + SPAN_LNG * (c / (GRID_N - 1) - 0.5)).toFixed(4));
    }
  }

  const fieldUrl = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lats.join(',')}&longitude=${lngs.join(',')}`
    + '&hourly=precipitation,cloud_cover&forecast_days=2&timezone=UTC';

  const pointUrl = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + '&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,'
    + 'weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,is_day'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
    + '&forecast_days=2&timezone=UTC';

  const [field, point] = await Promise.all([getJson(fieldUrl), getJson(pointUrl)]);

  const cells = Array.isArray(field) ? field : [field];
  if (cells.length !== GRID_N * GRID_N) {
    throw new Error(`expected ${GRID_N * GRID_N} grid cells, got ${cells.length}`);
  }

  const times = cells[0]?.hourly?.time || [];
  if (!times.length) throw new Error('open-meteo returned no hourly field');

  const startMs = Math.floor(Date.now() / 3600000) * 3600000;
  const stamps = times.map((t) => Date.parse(`${t}:00Z`));
  const first = stamps.findIndex((ts) => ts >= startMs);
  if (first < 0) throw new Error('forecast window does not reach the current hour');
  const count = Math.min(hours, stamps.length - first);

  /*
   * Open-Meteo snaps each request to the nearest model cell, so the returned
   * coordinates are not the ones asked for. Deriving the bounds from what came
   * back keeps the raster registered to the data instead of to the request.
   */
  const gotLats = cells.map((c) => c.latitude);
  const gotLngs = cells.map((c) => c.longitude);

  const steps = [];
  for (let h = 0; h < count; h += 1) {
    const i = first + h;
    steps.push({
      timestamp: stamps[i],
      // Tenths of a millimetre per hour, capped at 25.5 mm/h — well past the
      // point where the display is already saturated at "extreme".
      precip: packBytes(cells.map((c) => c.hourly.precipitation?.[i] ?? 0), 10),
      cloudPct: packBytes(cells.map((c) => c.hourly.cloud_cover?.[i] ?? 0), 1, 100),
    });
  }

  const ph = point?.hourly;
  const pStamps = (ph?.time || []).map((t) => Date.parse(`${t}:00Z`));
  const pFirst = pStamps.findIndex((ts) => ts >= startMs);
  const conditions = [];
  for (let h = 0; h < count && pFirst >= 0; h += 1) {
    const i = pFirst + h;
    if (i >= pStamps.length) break;
    conditions.push({
      timestamp: pStamps[i],
      tempF: Math.round(ph.temperature_2m?.[i] ?? 0),
      feelsLikeF: Math.round(ph.apparent_temperature?.[i] ?? 0),
      precipIn: Math.round((ph.precipitation?.[i] ?? 0) * 100) / 100,
      chancePct: ph.precipitation_probability?.[i] ?? null,
      cloudPct: ph.cloud_cover?.[i] ?? null,
      windMph: Math.round(ph.wind_speed_10m?.[i] ?? 0),
      gustMph: Math.round(ph.wind_gusts_10m?.[i] ?? 0),
      windDirDeg: ph.wind_direction_10m?.[i] ?? null,
      humidityPct: ph.relative_humidity_2m?.[i] ?? null,
      isDay: (ph.is_day?.[i] ?? 1) === 1,
      ...describe(ph.weather_code?.[i]),
    });
  }

  const value = {
    source: 'Open-Meteo hourly forecast',
    grid: {
      rows: GRID_N,
      cols: GRID_N,
      // Cell centres, so the client can expand by half a cell when it draws.
      bounds: {
        north: Math.max(...gotLats),
        south: Math.min(...gotLats),
        east: Math.max(...gotLngs),
        west: Math.min(...gotLngs),
      },
      modelSpacingKm: Math.round((SPAN_LAT * 111) / (GRID_N - 1)),
    },
    steps,
    conditions,
    note: 'Precipitation and cloud cover are sampled from a numerical forecast model on a '
      + 'lattice across the region. This is a forecast, not observed radar — radar mosaics only '
      + 'extend about half an hour ahead.',
  };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
