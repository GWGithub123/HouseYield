/**
 * Turns a flood depth into a water level inside the house section.
 *
 * The unit conversion here is the part that is easy to get badly wrong. The
 * flood model reports depth of water standing at *exterior grade*. The section
 * draws water rising off the *basement slab*, which is about seven feet lower.
 * Passing one straight into the other would understate a flood enormously: a
 * model reading of "1 ft at grade" does not mean a foot of water in the
 * basement, it means the basement is completely full and there is a foot of
 * water standing against the first floor.
 *
 * Why below-grade space fills at all: standing surface water saturates the soil
 * around the foundation, and the water level inside an unsealed basement tracks
 * that saturated level through the slab joint, footing drains and walls. A
 * working sump can hold the level down while it keeps up with inflow and keeps
 * power, which is exactly why the sump and the electrical panel appear in the
 * threshold ladder.
 */
import {
  BASEMENT_DEPTH_BELOW_GRADE_FT,
  BASEMENT_FLOOR_TO_MAIN_FT,
  FLOOD_THRESHOLDS,
  FloodThreshold,
  waterLevelToY,
} from './houseModel';

export type FloodSource = 'surface' | 'sensor' | null;

export interface FloodStage {
  /** Feet of water above the basement slab. */
  levelFt: number;
  /** y coordinate of the water surface in section space. */
  waterY: number;
  /** Depth above the first finished floor, 0 when water is still below it. */
  aboveMainFloorFt: number;
  /** True once the below-grade space is full. */
  belowGradeFull: boolean;
  /** Where this reading came from, which drives how confidently it is labelled. */
  source: FloodSource;
  /** Thresholds the water has reached, shallowest first. */
  reached: FloodThreshold[];
  /** The next threshold, for a "what happens if it rises" hint. */
  next: FloodThreshold | null;
  /** One-line summary for the section label. */
  headline: string;
}

interface Input {
  /**
   * Modelled depth of water standing at exterior grade, in feet. This is the
   * `home.depthFt` figure from the flood depth model.
   */
  depthAtGradeFt?: number | null;
  /**
   * A leak sensor is reporting water below grade. Used when there is no modelled
   * surface flooding — we know water is present but not how deep.
   */
  sensorWater?: boolean;
  /** Slab-on-grade homes have no below-grade space to fill. */
  hasBasement?: boolean;
}

/** Nominal level to draw for a sensor trip, where depth is unknown. */
const SENSOR_LEVEL_FT = 0.35;

/**
 * Surface depth at which the below-grade space is assumed to have fully
 * equalised with the water table outside.
 *
 * Below this, the basement is filling but has not caught up: seepage through
 * the slab joint and walls takes time, and a sump with power holds the level
 * down while it keeps up with inflow. Without this damping the model would
 * claim an inch of ponding drowns the electrical panel, which is both wrong and
 * the kind of overstatement that makes people stop trusting the whole map.
 */
const EQUALISATION_DEPTH_FT = 1.5;

export function computeFloodStage({
  depthAtGradeFt,
  sensorWater,
  hasBasement = true,
}: Input): FloodStage | null {
  let levelFt: number;
  let source: FloodSource;

  if (depthAtGradeFt != null && depthAtGradeFt > 0) {
    source = 'surface';
    if (!hasBasement) {
      // Nothing below grade to fill; water simply stands against the floor,
      // which in this drawing sits at grade.
      levelFt = BASEMENT_FLOOR_TO_MAIN_FT + depthAtGradeFt;
    } else {
      // Equilibrium is the outside water surface, measured off the slab.
      const equilibrium = BASEMENT_DEPTH_BELOW_GRADE_FT + depthAtGradeFt;
      const caughtUp = Math.min(1, Math.sqrt(depthAtGradeFt / EQUALISATION_DEPTH_FT));
      levelFt = equilibrium * caughtUp;
    }
  } else if (sensorWater) {
    levelFt = SENSOR_LEVEL_FT;
    source = 'sensor';
  } else {
    return null;
  }

  const applicable = hasBasement
    ? FLOOD_THRESHOLDS
    : FLOOD_THRESHOLDS.filter((t) => t.id === 'grade' || t.id === 'main_floor');
  const reached = applicable.filter((t) => levelFt >= t.levelFt);
  const next = applicable.find((t) => levelFt < t.levelFt) ?? null;
  const aboveMainFloorFt = Math.max(0, levelFt - BASEMENT_FLOOR_TO_MAIN_FT);

  return {
    levelFt,
    waterY: waterLevelToY(levelFt),
    aboveMainFloorFt,
    belowGradeFull: levelFt >= BASEMENT_DEPTH_BELOW_GRADE_FT,
    source,
    reached,
    next,
    headline: headlineFor(levelFt, aboveMainFloorFt, source),
  };
}

function headlineFor(levelFt: number, aboveMainFloorFt: number, source: FloodSource): string {
  if (source === 'sensor') return 'Water detected below grade';
  if (aboveMainFloorFt > 0) {
    return `${aboveMainFloorFt.toFixed(1)} ft above first floor`;
  }
  if (levelFt >= BASEMENT_DEPTH_BELOW_GRADE_FT) return 'Below-grade space full';
  return `${levelFt.toFixed(1)} ft in basement`;
}

/**
 * Whether a fixture standing on the basement slab is submerged.
 * @param fixtureBaseY y of the fixture's baseline, i.e. where it meets the floor.
 */
export function isSubmerged(fixtureBaseY: number, stage: FloodStage | null): boolean {
  if (!stage) return false;
  return fixtureBaseY >= stage.waterY;
}
