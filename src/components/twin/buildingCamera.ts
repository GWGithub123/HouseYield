/**
 * The zoom ladder for a building.
 *
 * The house has three rungs — neighborhood, lot, interior — and inside the
 * interior it frames rooms and devices. A building needs two more, because there
 * are two more things worth looking at: a floor (which apartments on this storey?)
 * and a single unit. Site sits above them for a property with more than one
 * building on it.
 *
 * Rungs, not a continuum. Each one is a question, and the camera's job is to
 * answer the one you asked rather than to let you steer somewhere between two
 * questions and get half of each.
 */
import {
  BASEMENT_H,
  BUILDING_MARGIN_X,
  DEFAULT_COLUMNS_IN_VIEW,
  LEVEL_H,
  UNIT_W,
  bandForLevel,
  buildingSceneAspect,
  unitById,
  type BuildingDef,
} from './buildingModel';
import { DX, DY } from './houseModel';
import {
  sceneCamera,
  type Camera,
  type CameraScene,
} from './twinCamera';

export type BuildingFocusKind = 'site' | 'building' | 'floor' | 'unit';

export type BuildingFocus =
  | { kind: 'site' }
  | { kind: 'building' }
  | { kind: 'floor'; level: number }
  | { kind: 'unit'; unitId: string };

/**
 * The scene a building is drawn into.
 *
 * The aspect comes from {@link buildingSceneAspect}, which caps how much of a long
 * facade is in shot. A 40-unit building scaled to fit one screen width gives every
 * apartment about 25 pixels — legible as a bar chart, useless as a thing you click
 * on — so the resting view shows a readable slice and pans instead.
 */
export function buildingScene(building: BuildingDef, aspect?: number): CameraScene {
  return {
    w: building.scene.w,
    h: building.scene.h,
    aspect: aspect ?? buildingSceneAspect(building),
  };
}

function frameIn(
  scene: CameraScene,
  cx: number,
  cy: number,
  w: number,
  h: number,
): Camera {
  let width = Math.max(w, 1);
  let height = Math.max(h, 1);
  if (width / height < scene.aspect) width = height * scene.aspect;
  else height = width / scene.aspect;

  const x = width >= scene.w
    ? (scene.w - width) / 2
    : Math.min(Math.max(cx - width / 2, 0), scene.w - width);
  const y = height >= scene.h
    ? (scene.h - height) / 2
    : Math.min(Math.max(cy - height / 2, 0), scene.h - height);

  return { x, y, w: width, h: height };
}

/**
 * Frame one storey across the whole facade.
 *
 * Deliberately the full width rather than a slice. The question a floor answers is
 * "which apartments on this storey", and cropping the storey to fit a nicer zoom
 * would drop some of the answer. Long buildings therefore end up zoomed *out* at
 * this rung, which is correct: you asked about all of them.
 */
export function cameraForFloor(building: BuildingDef, level: number): Camera {
  const scene = buildingScene(building);
  const band = bandForLevel(building, level);
  if (!band) return sceneCamera(scene);

  const height = (band.kind === 'basement' ? BASEMENT_H : LEVEL_H) + 56;
  const left = BUILDING_MARGIN_X - 40;
  const right = BUILDING_MARGIN_X + building.unitsPerFloor * UNIT_W + DX + 40;

  return frameIn(
    scene,
    (left + right) / 2,
    (band.top + band.bottom) / 2,
    right - left,
    height,
  );
}

/**
 * Frame one apartment, including the ceiling and side-wall strip the projection
 * exposes behind it. Cropping to the opening alone cuts the back off the space
 * you just asked to look at.
 */
export function cameraForUnit(building: BuildingDef, unitId: string): Camera {
  const scene = buildingScene(building);
  const unit = unitById(building, unitId);
  if (!unit) return sceneCamera(scene);

  const pad = 52;
  const left = unit.x - pad;
  const right = unit.x + unit.w + DX + pad;
  const top = unit.y - DY - pad;
  const bottom = unit.y + unit.h + pad;

  return frameIn(scene, (left + right) / 2, (top + bottom) / 2, right - left, bottom - top);
}

/** Resolve a rung to a camera. */
export function cameraForBuildingFocus(building: BuildingDef, focus: BuildingFocus): Camera {
  switch (focus.kind) {
    case 'floor':
      return cameraForFloor(building, focus.level);
    case 'unit':
      return cameraForUnit(building, focus.unitId);
    case 'site':
    case 'building':
    default:
      return sceneCamera(buildingScene(building));
  }
}

/**
 * The rung above, for a Back control.
 *
 * Unit steps out to the floor it is on rather than straight to the building,
 * because that is the step the reader took to get there and undoing one step at a
 * time is the only behaviour a Back button can have that is never surprising.
 */
export function parentFocus(
  building: BuildingDef,
  focus: BuildingFocus,
): BuildingFocus | null {
  switch (focus.kind) {
    case 'unit': {
      const unit = unitById(building, focus.unitId);
      return unit ? { kind: 'floor', level: unit.level } : { kind: 'building' };
    }
    case 'floor':
      return { kind: 'building' };
    case 'building':
      return { kind: 'site' };
    default:
      return null;
  }
}

/** Human label for the rung, for a breadcrumb or a Back button. */
export function focusLabel(building: BuildingDef, focus: BuildingFocus): string {
  switch (focus.kind) {
    case 'site':
      return 'Site';
    case 'floor': {
      const band = bandForLevel(building, focus.level);
      return band?.label ?? 'Floor';
    }
    case 'unit': {
      const unit = unitById(building, focus.unitId);
      return unit ? `Unit ${unit.label}` : 'Unit';
    }
    default:
      return 'Building';
  }
}

/**
 * Horizontal pan limits for the resting view.
 *
 * A long facade is framed to a readable slice, so panning is how you reach the far
 * end. Returned as a range rather than left to the drag handler to work out,
 * because the two have to agree or the drawing can be dragged into empty space.
 */
export function panRange(building: BuildingDef, camera: Camera): { min: number; max: number } {
  return { min: 0, max: Math.max(0, building.scene.w - camera.w) };
}

/** Whether the facade is wider than the frame, i.e. whether panning does anything. */
export function isPannable(building: BuildingDef): boolean {
  return building.unitsPerFloor > DEFAULT_COLUMNS_IN_VIEW;
}
