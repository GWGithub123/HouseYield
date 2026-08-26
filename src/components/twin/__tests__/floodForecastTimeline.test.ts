/**
 * The two pieces of the forecast timeline that are easy to get quietly wrong:
 * the wire encoding (a decoder that disagrees with the encoder paints garbage
 * on the map) and the rainfall routing calibration (a kernel that does not
 * preserve a design storm makes every hourly depth meaningless).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS server module, no declarations; the frontend
// tsconfig does not cover server/, but vitest resolves it fine.
import { encodeTiers, routeRainfall } from '../../../../server/services/floodForecastTimeline.js';
// @ts-expect-error -- same, plain JS server module.
import { packBytes } from '../../../../server/services/weatherFieldForecast.js';
import { decodeBytes, decodeTiers } from '../../../hooks/useFloodForecast';

/** Mirrors what the browser does; jsdom provides atob. */
const roundTrip = (tiers: number[]) => decodeTiers(encodeTiers(tiers), tiers.length);

describe('tier raster wire format', () => {
  it('round-trips an all-dry raster', () => {
    const tiers = new Array(9216).fill(-1);
    expect(roundTrip(tiers)).toEqual(tiers);
  });

  it('round-trips mixed tiers including the top of the range', () => {
    const tiers = [-1, -1, 0, 0, 0, 1, 2, 3, 4, -1, 4, 4, -1];
    expect(roundTrip(tiers)).toEqual(tiers);
  });

  it('round-trips a run longer than one 16-bit counter', () => {
    // 70,000 cells of a single value forces the encoder to split the run.
    const tiers = new Array(70000).fill(2);
    expect(roundTrip(tiers)).toEqual(tiers);
  });

  it('compresses a sparse raster to a small fraction of the raw bytes', () => {
    const tiers = new Array(9216).fill(-1);
    for (let i = 4000; i < 4200; i += 1) tiers[i] = 2;
    // Raw base64 of 9,216 bytes would be over 12,000 characters.
    expect(encodeTiers(tiers).length).toBeLessThan(200);
  });
});

describe('rainfall routing', () => {
  const series = (rain: number[]) => rain.map((rainIn) => ({ rainIn }));

  it('reproduces a design storm total when rain falls evenly over 24 hours', () => {
    // The stage model is calibrated on 24-hour Atlas 14 totals, so a uniform
    // 24-hour storm must come back out as its own depth or every hourly number
    // is quietly on a different scale from the static scenarios.
    const routed = routeRainfall(series(new Array(24).fill(3 / 24)));
    expect(routed[23]).toBeCloseTo(3, 1);
  });

  it('rises during the storm and recedes after it stops', () => {
    const routed = routeRainfall(series([...new Array(4).fill(0.5), ...new Array(20).fill(0)]));
    const peak = Math.max(...routed);
    const peakAt = routed.indexOf(peak);

    expect(peakAt).toBeLessThanOrEqual(4);
    expect(routed[23]).toBeLessThan(peak * 0.5);
    expect(routed[23]).toBeGreaterThan(0);
  });

  it('caps a single cloudburst rather than amplifying it into a deluge', () => {
    // One 3" hour is a serious short-duration event, but the weighting alone
    // would turn it into an ~8" 24-hour equivalent the forecast never called.
    const routed = routeRainfall(series([3, ...new Array(23).fill(0)]));
    expect(routed[0]).toBeLessThanOrEqual(3 * 1.5 + 1e-9);
    expect(routed[0]).toBeGreaterThan(3);
  });

  it('stays flat at zero through a dry forecast', () => {
    expect(routeRainfall(series(new Array(24).fill(0)))).toEqual(new Array(24).fill(0));
  });
});

describe('weather field wire format', () => {
  it('round-trips precipitation to a tenth of a millimetre', () => {
    const mm = [0, 0.1, 0.4, 2.5, 7.6, 12.3, 25.5];
    const back = decodeBytes(packBytes(mm, 10), 10);
    mm.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 5));
  });

  it('clamps rather than wrapping when rain exceeds the byte range', () => {
    // 40 mm/h is well past the top of the display ramp, so saturating is the
    // right answer; wrapping would paint a cloudburst as a drizzle.
    expect(decodeBytes(packBytes([40], 10), 10)[0]).toBe(25.5);
  });

  it('keeps cloud cover on its own 0-100 scale', () => {
    expect(decodeBytes(packBytes([0, 37, 100], 1, 100), 1)).toEqual([0, 37, 100]);
  });
});
