/**
 * The ladder's contract is that each rung answers the question it is named after
 * and stays inside the drawing. A camera that crops part of the answer, or that
 * frames empty space beside the building, is worse than not zooming at all.
 */
import { describe, expect, it } from 'vitest';

import {
  buildingScene,
  cameraForBuildingFocus,
  cameraForFloor,
  cameraForUnit,
  focusLabel,
  isPannable,
  panRange,
  parentFocus,
} from '../buildingCamera';
import {
  DEFAULT_BUILDING_SPEC,
  DEFAULT_COLUMNS_IN_VIEW,
  buildBuilding,
  unitById,
  type BuildingSpec,
} from '../buildingModel';

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  ...DEFAULT_BUILDING_SPEC,
  floors: 4,
  unitsPerFloor: 6,
  archetype: 'midrise_corridor',
  ...over,
});

const building = buildBuilding(spec());

function withinScene(camera: { x: number; y: number; w: number; h: number }, w: number, h: number) {
  expect(camera.x).toBeGreaterThanOrEqual(-0.001);
  expect(camera.y).toBeGreaterThanOrEqual(-0.001);
  expect(camera.x + camera.w).toBeLessThanOrEqual(w + 0.001);
  expect(camera.y + camera.h).toBeLessThanOrEqual(h + 0.001);
}

describe('rungs stay inside the drawing', () => {
  it('never frames space beside the building', () => {
    const { w, h } = building.scene;
    withinScene(cameraForFloor(building, 0), w, h);
    withinScene(cameraForFloor(building, 3), w, h);
    withinScene(cameraForUnit(building, 'u-A-0-0'), w, h);
    withinScene(cameraForUnit(building, `u-A-3-5`), w, h);
  });

  it('holds the scene aspect at every rung', () => {
    const aspect = buildingScene(building).aspect;
    for (const camera of [
      cameraForFloor(building, 1),
      cameraForUnit(building, 'u-A-1-2'),
      cameraForBuildingFocus(building, { kind: 'building' }),
    ]) {
      expect(camera.w / camera.h).toBeCloseTo(aspect, 4);
    }
  });

  it('falls back to the whole building rather than throwing on a bad id', () => {
    const whole = cameraForBuildingFocus(building, { kind: 'building' });
    expect(cameraForUnit(building, 'nope')).toEqual(whole);
    expect(cameraForFloor(building, 99)).toEqual(whole);
  });
});

describe('cameraForFloor', () => {
  it('frames the whole storey, even when that means zooming out', () => {
    /*
     * The question a floor answers is "which apartments on this storey", so
     * cropping the storey to get a tighter zoom would drop part of the answer.
     */
    const long = buildBuilding(spec({ unitsPerFloor: 20 }));
    const camera = cameraForFloor(long, 1);
    expect(camera.w).toBeGreaterThanOrEqual(long.unitsPerFloor * 170);
  });

  it('sits over the storey it was asked for', () => {
    const top = cameraForFloor(building, 0);
    const bottom = cameraForFloor(building, 3);
    expect(top.y).toBeLessThan(bottom.y);
  });

  it('reaches a basement, which is below every unit', () => {
    const withBasement = buildBuilding(spec({ hasBasement: true }));
    const level = withBasement.levels.find((band) => band.kind === 'basement')!;
    const camera = cameraForFloor(withBasement, level.index);

    // The band's midpoint has to actually be in shot, or the rung is a lie.
    const mid = (level.top + level.bottom) / 2;
    expect(mid).toBeGreaterThanOrEqual(camera.y);
    expect(mid).toBeLessThanOrEqual(camera.y + camera.h);
  });
});

describe('cameraForUnit', () => {
  it('is tighter than its floor', () => {
    const unit = cameraForUnit(building, 'u-A-1-2');
    const floor = cameraForFloor(building, 1);
    expect(unit.w).toBeLessThan(floor.w);
  });

  it('includes the ceiling and side-wall strip the projection exposes', () => {
    // Cropping to the opening alone cuts the back off the space you asked to see.
    const unit = unitById(building, 'u-A-1-2')!;
    const camera = cameraForUnit(building, unit.id);

    expect(camera.x).toBeLessThan(unit.x);
    expect(camera.x + camera.w).toBeGreaterThan(unit.x + unit.w);
    expect(camera.y).toBeLessThan(unit.y);
    expect(camera.y + camera.h).toBeGreaterThan(unit.y + unit.h);
  });
});

describe('parentFocus', () => {
  it('steps a unit out to its own floor, not straight to the building', () => {
    // Undoing one step at a time is the only Back behaviour that is never
    // surprising, because it retraces the way the reader came in.
    expect(parentFocus(building, { kind: 'unit', unitId: 'u-A-2-3' }))
      .toEqual({ kind: 'floor', level: 2 });
  });

  it('walks all the way out and then stops', () => {
    expect(parentFocus(building, { kind: 'floor', level: 1 })).toEqual({ kind: 'building' });
    expect(parentFocus(building, { kind: 'building' })).toEqual({ kind: 'site' });
    expect(parentFocus(building, { kind: 'site' })).toBeNull();
  });

  it('does not strand a Back button on a unit that has gone away', () => {
    expect(parentFocus(building, { kind: 'unit', unitId: 'nope' })).toEqual({ kind: 'building' });
  });
});

describe('focusLabel', () => {
  it('names each rung the way a person would', () => {
    expect(focusLabel(building, { kind: 'site' })).toBe('Site');
    expect(focusLabel(building, { kind: 'building' })).toBe('Building');
    expect(focusLabel(building, { kind: 'floor', level: 0 })).toBe('Floor 4');
    expect(focusLabel(building, { kind: 'unit', unitId: 'u-A-0-0' })).toBe('Unit 401');
  });
});

describe('panning', () => {
  it('is offered only when the facade is wider than the frame', () => {
    expect(isPannable(buildBuilding(spec({ unitsPerFloor: DEFAULT_COLUMNS_IN_VIEW })))).toBe(false);
    expect(isPannable(buildBuilding(spec({ unitsPerFloor: DEFAULT_COLUMNS_IN_VIEW + 4 })))).toBe(true);
  });

  it('cannot be dragged past the end of the building', () => {
    const long = buildBuilding(spec({ unitsPerFloor: 24 }));
    const camera = cameraForBuildingFocus(long, { kind: 'building' });
    const range = panRange(long, camera);

    expect(range.min).toBe(0);
    expect(range.max + camera.w).toBeLessThanOrEqual(long.scene.w + 0.001);
  });

  it('offers no range at all when everything already fits', () => {
    const short = buildBuilding(spec({ unitsPerFloor: 3 }));
    const camera = cameraForBuildingFocus(short, { kind: 'building' });
    expect(panRange(short, camera).max).toBe(0);
  });
});
