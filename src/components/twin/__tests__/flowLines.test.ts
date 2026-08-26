/**
 * The drainage network is terrain-derived and therefore identical for every
 * storm. Discharge is the only thing that makes a 6-inch storm look different
 * from a half-inch one, so it is worth pinning down: a regression here is
 * silent, because the map still draws, it just stops responding.
 */
import { describe, expect, it } from 'vitest';
import { dischargeFactor } from '../../../utils/flowLines';

describe('dischargeFactor', () => {
  /*
   * The regression this exists to catch: the multiplier used to sit below 1
   * with no storm selected, which compounded with the lot view's own 0.5 width
   * scale and rendered the channels at a third of a pixel. They were drawn, and
   * invisible. Discharge may only ever add width, never remove it.
   */
  it('never shrinks strokes below the unstormed baseline', () => {
    const inputs = [null, undefined, 0, -1, 0.1, 0.5, 1, 2, 4, 6, 20];
    for (const rain of inputs) {
      expect(dischargeFactor(rain)).toBeGreaterThanOrEqual(1);
    }
  });

  it('rises monotonically with rainfall', () => {
    const series = [0.5, 1, 2, 3, 4, 6].map(dischargeFactor);
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]).toBeGreaterThan(series[i - 1]);
    }
  });

  it('separates the design storms enough to be visible', () => {
    // A 6" storm should read as clearly heavier than a 1" one. Anything under
    // about 1.4x is lost to antialiasing at these stroke widths.
    expect(dischargeFactor(6) / dischargeFactor(1)).toBeGreaterThan(1.4);
  });

  it('stays sub-linear, so a 12x storm is not a 12x channel', () => {
    expect(dischargeFactor(6) / dischargeFactor(0.5)).toBeLessThan(4);
  });

  it('treats a drizzle as indistinguishable from no storm', () => {
    // A half-inch of rain genuinely does not widen a channel, so the smallest
    // design storm and the live view should look the same rather than the
    // toggle implying a change the terrain model is not claiming.
    expect(dischargeFactor(0.5)).toBeCloseTo(dischargeFactor(null), 5);
    expect(dischargeFactor(0)).toBe(dischargeFactor(null));
  });

  it('caps out, so an extreme storm cannot blanket the map', () => {
    expect(dischargeFactor(40)).toBeLessThanOrEqual(1.9);
  });
});
