/**
 * Paints the regional precipitation and cloud fields to canvases.
 *
 * The model lattice is only 11 × 11 over ~80 km, which is the honest resolution
 * of an hourly forecast at this range. Drawn one pixel per cell it would be an
 * unreadable mosaic, so the raster is upsampled with bilinear interpolation
 * before colouring. That smoothing is explicitly cosmetic — it makes the shape
 * of a band legible without claiming detail the model does not have, which is
 * why the caller labels this a forecast rather than radar.
 */

/**
 * Precipitation colour ramp, in mm/h.
 *
 * Anchored on the conventional intensity classes (light below 2.5, moderate to
 * 7.6, heavy to 50) rather than on evenly spaced numbers, so a colour change
 * corresponds to a change in what the rain would actually feel like. The hue
 * order — blue through magenta to yellow — is the one weather maps have used
 * for long enough that it needs no legend to read as "worse toward yellow".
 */
const PRECIP_STOPS: Array<{ mmh: number; rgb: [number, number, number]; alpha: number }> = [
  { mmh: 0.08, rgb: [56, 189, 248], alpha: 0.0 },
  { mmh: 0.3, rgb: [56, 189, 248], alpha: 0.35 },
  { mmh: 1.2, rgb: [37, 99, 235], alpha: 0.6 },
  { mmh: 2.5, rgb: [79, 70, 229], alpha: 0.72 },
  { mmh: 5, rgb: [147, 51, 234], alpha: 0.8 },
  { mmh: 7.6, rgb: [219, 39, 119], alpha: 0.85 },
  { mmh: 14, rgb: [244, 114, 22], alpha: 0.88 },
  { mmh: 25, rgb: [250, 204, 21], alpha: 0.9 },
  { mmh: 50, rgb: [254, 249, 195], alpha: 0.92 },
];

export const PRECIP_LEGEND = [
  { label: 'Light', color: 'rgb(56,189,248)' },
  { label: 'Moderate', color: 'rgb(79,70,229)' },
  { label: 'Heavy', color: 'rgb(219,39,119)' },
  { label: 'Extreme', color: 'rgb(250,204,21)' },
];

function precipColor(mmh: number): [number, number, number, number] {
  if (mmh <= PRECIP_STOPS[0].mmh) return [0, 0, 0, 0];

  for (let i = 1; i < PRECIP_STOPS.length; i += 1) {
    const a = PRECIP_STOPS[i - 1];
    const b = PRECIP_STOPS[i];
    if (mmh > b.mmh) continue;
    // Interpolate in log space: the classes span three orders of magnitude, so
    // a linear blend would leave everything below moderate looking identical.
    const t = (Math.log(mmh) - Math.log(a.mmh)) / (Math.log(b.mmh) - Math.log(a.mmh));
    return [
      a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t,
      a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t,
      a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t,
      (a.alpha + (b.alpha - a.alpha) * t) * 255,
    ];
  }

  const last = PRECIP_STOPS[PRECIP_STOPS.length - 1];
  return [last.rgb[0], last.rgb[1], last.rgb[2], last.alpha * 255];
}

/** Bilinear sample of a row-major field at fractional cell coordinates. */
function sample(field: number[], rows: number, cols: number, fr: number, fc: number): number {
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor(fr)));
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fc)));
  const r1 = Math.min(rows - 1, r0 + 1);
  const c1 = Math.min(cols - 1, c0 + 1);
  const dr = fr - r0;
  const dc = fc - c0;

  const v00 = field[r0 * cols + c0] ?? 0;
  const v01 = field[r0 * cols + c1] ?? 0;
  const v10 = field[r1 * cols + c0] ?? 0;
  const v11 = field[r1 * cols + c1] ?? 0;

  return v00 * (1 - dr) * (1 - dc)
    + v01 * (1 - dr) * dc
    + v10 * dr * (1 - dc)
    + v11 * dr * dc;
}

export interface RadarPaintOptions {
  rows: number;
  cols: number;
  /** Output size in pixels. Upsampling is what makes the band shapes legible. */
  width?: number;
  height?: number;
  /** Cloud is drawn under the rain when supplied. */
  cloudPct?: number[] | null;
  /** Scales the whole layer, for fading between hours. */
  opacity?: number;
}

/**
 * @returns a data URL, or null when there is nothing worth drawing.
 */
export function paintRadar(
  precipMmH: number[],
  {
    rows,
    cols,
    width = 320,
    height = 320,
    cloudPct = null,
    opacity = 1,
  }: RadarPaintOptions,
): string | null {
  if (!precipMmH.length) return null;

  const wettest = Math.max(...precipMmH);
  const cloudiest = cloudPct ? Math.max(...cloudPct) : 0;
  if (wettest < 0.05 && cloudiest < 5) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const image = ctx.createImageData(width, height);
  const data = image.data;

  for (let y = 0; y < height; y += 1) {
    // Map pixel centres onto cell centres so the edges are not half a cell out.
    const fr = ((y + 0.5) / height) * (rows - 1);
    for (let x = 0; x < width; x += 1) {
      const fc = ((x + 0.5) / width) * (cols - 1);
      const i = (y * width + x) * 4;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (cloudPct) {
        const cover = sample(cloudPct, rows, cols, fr, fc);
        if (cover > 8) {
          // Overcast reads as a pale veil; anything lighter stays transparent
          // so the map underneath is still usable.
          r = 226; g = 232; b = 240;
          a = Math.min(0.34, ((cover - 8) / 92) * 0.34);
        }
      }

      const mmh = sample(precipMmH, rows, cols, fr, fc);
      if (mmh > PRECIP_STOPS[0].mmh) {
        const [pr, pg, pb, pa] = precipColor(mmh);
        const alpha = pa / 255;
        // Source-over by hand, since we are writing raw pixels.
        const out = alpha + a * (1 - alpha);
        r = out > 0 ? (pr * alpha + r * a * (1 - alpha)) / out : 0;
        g = out > 0 ? (pg * alpha + g * a * (1 - alpha)) / out : 0;
        b = out > 0 ? (pb * alpha + b * a * (1 - alpha)) / out : 0;
        a = out;
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(a * 255 * opacity);
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Peak intensity in the frame, for labelling the legend. */
export function describeIntensity(mmh: number): string {
  if (mmh < 0.1) return 'No rain';
  if (mmh < 2.5) return 'Light';
  if (mmh < 7.6) return 'Moderate';
  if (mmh < 25) return 'Heavy';
  return 'Extreme';
}
