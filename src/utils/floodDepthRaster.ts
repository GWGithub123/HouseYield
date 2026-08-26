/**
 * Paints a flood depth tier raster into an image for a Google Maps
 * GroundOverlay.
 *
 * A GroundOverlay is one bitmap pinned to a lat/lng rectangle, which is the
 * right tool here: the alternative is ~14,000 Polygon objects, and Google Maps
 * gets visibly unhappy well before that. It also means storm-slider changes
 * only repaint a canvas rather than churning map objects.
 */
import { DEPTH_TIERS, withAlpha } from '../design-system/riskPalette';

/** Upscale factor. The DEM is ~15 m/cell, so the tiers are genuinely fuzzy at
 *  the edges — smoothing them is more honest than hard pixel steps that imply
 *  we know exactly where the water stops. */
const UPSCALE = 5;

export interface DepthRasterOptions {
  /** Row-major tier index per cell; -1 is dry. */
  tiers: number[];
  /** Cells per side. */
  samples: number;
  /** Peak fill opacity for the deepest tier. */
  opacity?: number;
}

/**
 * @returns a PNG data URL, or null if the scenario is entirely dry.
 */
export function paintDepthRaster({ tiers, samples, opacity = 0.72 }: DepthRasterOptions): string | null {
  if (!tiers?.length || samples <= 0) return null;

  const base = document.createElement('canvas');
  base.width = samples;
  base.height = samples;
  const bctx = base.getContext('2d');
  if (!bctx) return null;

  const image = bctx.createImageData(samples, samples);
  const px = image.data;
  let wet = 0;

  for (let i = 0; i < samples * samples; i += 1) {
    const tier = tiers[i];
    const o = i * 4;
    /*
     * Anything that is not a tier index is dry.
     *
     * The obvious guard is `tier < 0 || tier >= DEPTH_TIERS.length`, which
     * silently passes `undefined` through — both comparisons are false — and
     * then dies indexing the palette. That is not hypothetical: it is what a
     * raster shorter than `samples * samples` does, and the only symptom is a
     * crash three frames into playback.
     */
    if (!Number.isInteger(tier) || tier < 0 || tier >= DEPTH_TIERS.length) {
      px[o + 3] = 0;
      continue;
    }
    const rgb = hexToRgb(DEPTH_TIERS[tier].color);
    if (!rgb) continue;
    px[o] = rgb.r;
    px[o + 1] = rgb.g;
    px[o + 2] = rgb.b;
    // Shallow water is nearly transparent so the terrain still reads through;
    // depth is carried by both hue and opacity, which survives colour-blindness
    // better than hue alone.
    px[o + 3] = Math.round(255 * opacity * (0.45 + 0.55 * (tier / (DEPTH_TIERS.length - 1))));
    wet += 1;
  }

  if (wet === 0) return null;
  bctx.putImageData(image, 0, 0);

  const out = document.createElement('canvas');
  out.width = samples * UPSCALE;
  out.height = samples * UPSCALE;
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(base, 0, 0, out.width, out.height);

  return out.toDataURL('image/png');
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const body = hex.replace('#', '');
  const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
  if (full.length !== 6) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Legend swatch colour matching what the raster paints for a tier. */
export function tierSwatch(tierIndex: number): string {
  const tier = DEPTH_TIERS[tierIndex];
  if (!tier) return 'transparent';
  return withAlpha(tier.color, 0.45 + 0.55 * (tierIndex / (DEPTH_TIERS.length - 1)));
}
