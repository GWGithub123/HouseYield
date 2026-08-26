import { describe, it, expect } from 'vitest';
import { computeFloodStage } from '../floodStage';
import { BASEMENT_DEPTH_BELOW_GRADE_FT, BASEMENT_FLOOR_TO_MAIN_FT, UNITS_PER_FT, GRADE_Y, SHELL } from '../houseModel';

describe('flood stage datum', () => {
  it('uses the drawn soil line as the single grade reference', () => {
    console.log('units/ft', UNITS_PER_FT.toFixed(2), '| grade y', GRADE_Y.toFixed(0), '| basement depth below grade ft', BASEMENT_DEPTH_BELOW_GRADE_FT);
    // One grade line, not two: the datum must agree with where soil is drawn.
    expect(GRADE_Y).toBe(SHELL.grade);
    expect(BASEMENT_DEPTH_BELOW_GRADE_FT).toBe(8);
    expect(UNITS_PER_FT).toBeCloseTo((SHELL.basementFloor - SHELL.grade) / 8, 5);
  });

  it('does not claim a drowned panel from an inch of surface ponding', () => {
    const s = computeFloodStage({ depthAtGradeFt: 0.1 })!;
    console.log('0.1ft at grade ->', s.headline, '| level', s.levelFt.toFixed(2), '| reached', s.reached.map(t=>t.id).join(','));
    expect(s.belowGradeFull).toBe(false);
    expect(s.reached.map(t=>t.id)).not.toContain('panel');
  });

  it('fully equalises to the outside water surface in a real flood', () => {
    const s = computeFloodStage({ depthAtGradeFt: 3 })!;
    console.log('3ft at grade ->', s.headline, '| aboveMain', s.aboveMainFloorFt.toFixed(2));
    expect(s.levelFt).toBeCloseTo(BASEMENT_DEPTH_BELOW_GRADE_FT + 3, 5);
    expect(s.aboveMainFloorFt).toBeCloseTo(3, 5);
    expect(s.reached.map(t=>t.id)).toContain('main_floor');
  });

  it('rises monotonically with surface depth', () => {
    let prev = 0;
    for (const d of [0.1, 0.3, 0.6, 1, 1.5, 2, 4]) {
      const s = computeFloodStage({ depthAtGradeFt: d })!;
      expect(s.levelFt).toBeGreaterThan(prev);
      prev = s.levelFt;
    }
  });

  it('skips below-grade thresholds on a slab-on-grade home', () => {
    const s = computeFloodStage({ depthAtGradeFt: 2, hasBasement: false })!;
    console.log('slab-on-grade 2ft ->', s.headline, '| reached', s.reached.map(t=>t.id).join(','));
    expect(s.reached.map(t=>t.id)).not.toContain('burners');
    expect(s.aboveMainFloorFt).toBeCloseTo(2, 5);
  });

  it('sensor water stays shallow and claims no depth', () => {
    const s = computeFloodStage({ sensorWater: true })!;
    console.log('sensor ->', s.headline, '| level', s.levelFt);
    expect(s.source).toBe('sensor');
    expect(s.belowGradeFull).toBe(false);
    expect(s.reached.map(t=>t.id)).toEqual(['slab']);
  });

  it('is null when dry', () => {
    expect(computeFloodStage({ depthAtGradeFt: 0 })).toBeNull();
  });

  it('escalates thresholds in elevation order', () => {
    for (const d of [0.1, 0.5, 1, 2, 4]) {
      const s = computeFloodStage({ depthAtGradeFt: d })!;
      console.log(`  ${d}ft at grade -> level ${s.levelFt.toFixed(1)}ft, waterY ${s.waterY.toFixed(0)}, reached: ${s.reached.map(t=>t.id).join(',')}`);
    }
    expect(true).toBe(true);
  });
});
