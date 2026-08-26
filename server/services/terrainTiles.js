/**
 * Dense elevation sampling from AWS Terrain Tiles.
 *
 * The pooling detector fetches elevation one HTTP request per point against
 * USGS EPQS, which caps it at an 81-point 9x9 grid covering roughly
 * 100m x 100m. That is too small to shade a neighbourhood and too coarse to
 * draw a credible drainage network.
 *
 * AWS hosts the "terrarium" encoding of a global DEM as ordinary PNG tiles:
 * public, no key, no rate limit worth worrying about, and a single 256x256
 * tile carries 65,536 elevation samples. Decoding is a per-pixel formula:
 *
 *   elevation_metres = (R * 256) + G + (B / 256) - 32768
 *
 * Source: https://registry.opendata.aws/terrain-tiles/ (Mapzen/Tilezen DEM,
 * derived from SRTM, NED and other national datasets).
 */
import sharp from 'sharp';

const TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_SIZE = 256;

/** Tiles are immutable, so an in-process cache is safe and very effective. */
const tileCache = new Map();
const TILE_CACHE_MAX = 240;

/* ── web mercator helpers ────────────────────────────────────────── */

export function lngToTileX(lng, zoom) {
  return ((lng + 180) / 360) * Math.pow(2, zoom);
}

export function latToTileY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2)
    * Math.pow(2, zoom)
  );
}

/** Ground resolution in metres per pixel at a given latitude and zoom. */
export function metresPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/**
 * Smallest zoom whose pixels are at least as fine as the requested spacing.
 * Clamped to 14 because the underlying DEM is ~30 m and zooming past its real
 * resolution just interpolates, which would imply detail we do not have.
 */
export function zoomForSpacing(lat, targetMetres) {
  for (let z = 14; z >= 8; z -= 1) {
    if (metresPerPixel(lat, z) <= targetMetres) return z;
  }
  return 10;
}

/* ── tile fetch + decode ─────────────────────────────────────────── */

async function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const url = `${TILE_BASE}/${z}/${x}/${y}.png`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let heights;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`terrain tile ${key} -> HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    heights = new Float32Array(info.width * info.height);
    for (let i = 0; i < heights.length; i += 1) {
      const o = i * info.channels;
      heights[i] = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
    }
  } finally {
    clearTimeout(timeout);
  }

  if (tileCache.size >= TILE_CACHE_MAX) {
    tileCache.delete(tileCache.keys().next().value);
  }
  tileCache.set(key, heights);
  return heights;
}

/* ── grid sampling ───────────────────────────────────────────────── */

/**
 * Sample a square elevation grid centred on a point.
 *
 * Returns row-major elevations in metres alongside the geographic bounds, so
 * callers can map a cell index straight back to a lat/lng rectangle without
 * repeating the projection maths.
 *
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} radiusMetres Half-width of the sampled square.
 * @param {number} samples Cells per side of the output grid.
 */
export async function fetchElevationGrid(centerLat, centerLng, radiusMetres = 900, samples = 96) {
  const spacing = (radiusMetres * 2) / samples;
  const zoom = zoomForSpacing(centerLat, spacing);
  const mpp = metresPerPixel(centerLat, zoom);

  // Work in fractional tile space; one unit is a whole tile, so pixel steps are
  // simply 1/256 of a unit and no per-sample trigonometry is needed.
  const centerX = lngToTileX(centerLng, zoom);
  const centerY = latToTileY(centerLat, zoom);
  const halfPixels = radiusMetres / mpp;
  const stepPixels = (halfPixels * 2) / samples;

  const minX = centerX - halfPixels / TILE_SIZE;
  const maxX = centerX + halfPixels / TILE_SIZE;
  const minY = centerY - halfPixels / TILE_SIZE;
  const maxY = centerY + halfPixels / TILE_SIZE;

  // Load every tile the window touches, once.
  const needed = new Map();
  for (let tx = Math.floor(minX); tx <= Math.floor(maxX); tx += 1) {
    for (let ty = Math.floor(minY); ty <= Math.floor(maxY); ty += 1) {
      needed.set(`${tx}/${ty}`, { tx, ty });
    }
  }
  const loaded = new Map();
  await Promise.all([...needed.values()].map(async ({ tx, ty }) => {
    try {
      loaded.set(`${tx}/${ty}`, await loadTile(zoom, tx, ty));
    } catch {
      loaded.set(`${tx}/${ty}`, null);
    }
  }));

  const elevations = new Float32Array(samples * samples);
  let min = Infinity;
  let max = -Infinity;
  let valid = 0;

  for (let row = 0; row < samples; row += 1) {
    for (let col = 0; col < samples; col += 1) {
      const px = centerX * TILE_SIZE - halfPixels + (col + 0.5) * stepPixels;
      const py = centerY * TILE_SIZE - halfPixels + (row + 0.5) * stepPixels;
      const tx = Math.floor(px / TILE_SIZE);
      const ty = Math.floor(py / TILE_SIZE);
      const tile = loaded.get(`${tx}/${ty}`);
      const idx = row * samples + col;

      if (!tile) {
        elevations[idx] = NaN;
        continue;
      }
      const ix = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(px - tx * TILE_SIZE)));
      const iy = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(py - ty * TILE_SIZE)));
      const value = tile[iy * TILE_SIZE + ix];
      elevations[idx] = value;
      if (Number.isFinite(value)) {
        if (value < min) min = value;
        if (value > max) max = value;
        valid += 1;
      }
    }
  }

  if (valid === 0) {
    throw new Error('terrain tiles returned no usable elevation data');
  }

  // Geographic bounds of the sampled window, for mapping cells to rectangles.
  const north = tileYToLat(minY, zoom);
  const south = tileYToLat(maxY, zoom);
  const west = tileXToLng(minX, zoom);
  const east = tileXToLng(maxX, zoom);

  return {
    samples,
    zoom,
    spacingMetres: mpp * stepPixels,
    elevations,
    minElevation: min,
    maxElevation: max,
    coverage: valid / (samples * samples),
    bounds: { north, south, east, west },
    /** Centre lat/lng of a grid cell. */
    cellCenter(row, col) {
      return {
        lat: north + ((south - north) * (row + 0.5)) / samples,
        lng: west + ((east - west) * (col + 0.5)) / samples,
      };
    },
  };
}

export function tileXToLng(x, zoom) {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

export function tileYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Elevation in metres at a single point, reusing the tile cache. */
export async function elevationAt(lat, lng, zoom = 14) {
  const x = lngToTileX(lng, zoom);
  const y = latToTileY(lat, zoom);
  const tile = await loadTile(zoom, Math.floor(x), Math.floor(y));
  const ix = Math.min(TILE_SIZE - 1, Math.floor((x - Math.floor(x)) * TILE_SIZE));
  const iy = Math.min(TILE_SIZE - 1, Math.floor((y - Math.floor(y)) * TILE_SIZE));
  return tile[iy * TILE_SIZE + ix];
}
