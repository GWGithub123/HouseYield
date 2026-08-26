/**
 * Geometry model for multifamily buildings, generalizing the house cutaway.
 *
 * The house model in `houseModel.ts` is a fixed `Record` of four named floors and
 * a hand-placed room list, which is right for a single archetype drawn once. A
 * building cannot work that way: the floor count and the units per floor are
 * properties of the address, so both the bands and the cells have to be
 * generated. This module is that generator.
 *
 * ## What is shared with the house, and why
 *
 * The projection (`DX`/`DY`), the slab inset (`SLAB`) and the fixture vocabulary
 * are imported rather than redefined. A unit is geometrically the same kind of
 * thing as a room — a rectangle on a band, with fixtures standing on its floor —
 * so `BuildingCutaway` can share primitives with `HouseCutaway` and, more
 * importantly, the propagation engine takes cells from either without caring.
 * The moment these diverge the two drawings start disagreeing about which way is
 * back, and the section stops reading as a volume.
 *
 * ## Side elevation, not a plan
 *
 * A double-loaded corridor has units on both sides of a hallway. In a side
 * elevation you are looking at one facade, so you see one side's units; the
 * other side is behind the corridor. That is why a unit belongs to exactly one
 * `side` and carries the `x` it is drawn at *when that side is shown*, and why
 * side B's columns are mirrored — you walked around the building, so the unit
 * that was on your left is now on your right. Getting that wrong makes the flip
 * a meaningless shuffle instead of a spatial move.
 *
 * ## Everything here is a guess until someone confirms it
 *
 * The spec is seeded from cached ATTOM stories and unit counts, which are
 * frequently wrong or absent, so `BuildingDef` carries `confidence` and
 * `needsConfirmation` through to the renderer. Until a manager has confirmed the
 * stacking plan we are not entitled to tell them which specific unit is exposed.
 */

import {
  DX,
  DY,
  SLAB,
  type Fixture,
  type RoomDef,
} from './houseModel';
import type { PropagationCell } from './leakPropagation';

/* ── model ───────────────────────────────────────────────────────── */

/**
 * Which facade a unit is on. Two discrete states rather than a rotation: the
 * cutaway carries its information in the unit cells, and turning the building
 * would hide exactly the cells that are trying to be read.
 */
export type BuildingSide = 'A' | 'B';

export type BuildingArchetype =
  | 'single_family'
  | 'condo_unit'
  | 'duplex'
  | 'garden_walkup'
  | 'midrise_corridor'
  | 'unknown';

export type CorridorKind = 'none' | 'double_loaded';

export interface UnitDef {
  id: string;
  /** Unit number as a resident would say it, e.g. `"302"`. */
  label: string;
  short: string;
  /** Band index. 0 is the top level, matching SVG y and "below" being larger. */
  level: number;
  /** Position along the facade, 0-based from the left *as drawn for its side*. */
  column: number;
  side: BuildingSide;
  /** Shared plumbing riser. */
  stackId: string;
  /** Storey as a person counts them, 1 at the bottom. */
  floorNumber: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fixtures: Fixture[];
}

export interface StackDef {
  id: string;
  /** Column the riser runs up, in side-A terms. */
  column: number;
  /** Absent when the riser is shared back-to-back across the corridor. */
  side?: BuildingSide;
  /** Units on this riser, top level first. */
  unitIds: string[];
}

export interface BuildingLevel {
  index: number;
  top: number;
  bottom: number;
  /** A basement level holds no units but water still collects in it. */
  kind: 'unit' | 'basement';
  label: string;
}

/**
 * The confirmable facts about a building — what the stack editor edits and what
 * gets cached. Deliberately small: everything else is derived, so a manager
 * confirms five things rather than a floor plan.
 */
export interface BuildingSpec {
  floors: number;
  unitsPerFloor: number;
  corridor: CorridorKind;
  /**
   * Whether column-aligned units on opposite sides of the corridor share a wet
   * wall. Common where kitchens and baths are stacked back-to-back against the
   * corridor to keep the riser count down. Off by default: it materially widens
   * exposure claims, so it should be something someone said, not something we
   * assumed.
   */
  sharedRisers: boolean;
  hasBasement: boolean;
  archetype: BuildingArchetype;
  /** Provenance, carried straight from the server-side derivation. */
  confidence: 'low' | 'medium' | 'high';
  needsConfirmation: boolean;
}

export interface BuildingDef extends BuildingSpec {
  levels: BuildingLevel[];
  units: UnitDef[];
  stacks: StackDef[];
  sides: BuildingSide[];
  /** Drawing extent, for `CameraScene`. */
  scene: { w: number; h: number };
  /** Total units across every side and floor. */
  unitCount: number;
}

/* ── geometry ────────────────────────────────────────────────────── */

/** Nominal unit width along the facade. */
export const UNIT_W = 170;
/** Band height per storey. */
export const LEVEL_H = 176;
/** Room above the top level for the roof and its overhang. */
export const BUILDING_TOP = 118;
/** Depth of a below-grade level, when there is one. */
export const BASEMENT_H = 196;
/** Foundation and grade below the lowest level. */
export const BUILDING_BOTTOM = 54;
/** Shell wall plus enough clear space for the receding eave and pins. */
export const BUILDING_MARGIN_X = 92;

/**
 * Vertical bands for a building, top to bottom — the generalization of the
 * house's fixed `FLOOR_BANDS`.
 *
 * Index order is the order water travels, so `level + 1` is always the space
 * below. The basement, when present, is the last band and holds no units.
 */
export function buildingLevels(floors: number, hasBasement = false): BuildingLevel[] {
  const count = Math.max(1, Math.floor(floors));
  const levels: BuildingLevel[] = [];

  for (let index = 0; index < count; index += 1) {
    const top = BUILDING_TOP + index * LEVEL_H;
    levels.push({
      index,
      top,
      bottom: top + LEVEL_H,
      kind: 'unit',
      // Storeys are numbered from the ground up, the opposite of band order.
      label: `Floor ${count - index}`,
    });
  }

  if (hasBasement) {
    const top = BUILDING_TOP + count * LEVEL_H;
    levels.push({
      index: count,
      top,
      bottom: top + BASEMENT_H,
      kind: 'basement',
      label: 'Basement',
    });
  }

  return levels;
}

/** Interior of a band, inset by the slab — the house's `band()`, generalized. */
export function levelBand(level: BuildingLevel): { y: number; h: number } {
  return { y: level.top + SLAB, h: level.bottom - level.top - SLAB * 2 };
}

/**
 * Fixtures for one unit, positioned inside its box.
 *
 * A kitchen run and a bath, which is both what almost every apartment has and
 * the entire set of things this product is about. Anything more would be
 * inventing a floor plan we do not have, and every fixture drawn is a place the
 * coverage model will then expect a sensor.
 *
 * The counter and the tub together are 158 units wide against a 170-unit bay, so
 * a toilet does not fit and is left out rather than drawn overlapping something.
 * It would add a third wet fixture and no information: a unit with an unmonitored
 * bath is already flagged.
 */
function unitFixtures(x: number, w: number, floorY: number): Fixture[] {
  return [
    { kind: 'counter', x: x + w * 0.3, y: floorY },
    // Set into the worktop, whose top face lands 28 above the floor. A sink
    // drawn at floor level floats, which is the one thing that stops a fixture
    // reading as an object in a room.
    { kind: 'sink', x: x + w * 0.3, y: floorY - 28 },
    { kind: 'tub', x: x + w * 0.76, y: floorY },
  ];
}

/**
 * Which sides a corridor implies. A walk-up or a garden building is one row of
 * units off an exterior breezeway, so there is nothing on the far side to flip
 * to; a double-loaded corridor has two.
 */
export function sidesFor(corridor: CorridorKind): BuildingSide[] {
  return corridor === 'double_loaded' ? ['A', 'B'] : ['A'];
}

/**
 * Unit number in the usual convention: storey, then position, e.g. `302`.
 *
 * Side B continues the numbering of its floor rather than restarting, because
 * that is how buildings are actually numbered — 301..304 runs down one side of
 * the hall and back up the other, and a resident asked to check "302" needs the
 * label to mean what it means on their door.
 */
function unitNumber(floorNumber: number, indexOnFloor: number): string {
  return `${floorNumber}${String(indexOnFloor + 1).padStart(2, '0')}`;
}

/**
 * Build the drawable model from a confirmed (or guessed) spec.
 *
 * Pure and deterministic, so the same spec always yields the same drawing and
 * the same cell ids — device placements are stored against `unit.id`, so an id
 * that shifted when the model was rebuilt would silently move every sensor.
 */
export function buildBuilding(spec: BuildingSpec): BuildingDef {
  const floors = Math.max(1, Math.floor(spec.floors));
  const unitsPerFloor = Math.max(1, Math.floor(spec.unitsPerFloor));
  const sides = sidesFor(spec.corridor);
  const levels = buildingLevels(floors, spec.hasBasement);
  const unitLevels = levels.filter((level) => level.kind === 'unit');

  const units: UnitDef[] = [];

  for (const level of unitLevels) {
    const { y, h } = levelBand(level);
    const floorNumber = floors - level.index;

    sides.forEach((side, sideIndex) => {
      for (let column = 0; column < unitsPerFloor; column += 1) {
        /*
         * Side B is mirrored. You are looking at the opposite facade, so the
         * column that was leftmost is now rightmost; drawing them in the same
         * order would make the flip a shuffle rather than a move around the
         * building, and would put a unit on the wrong end of the corridor.
         */
        const drawnColumn = side === 'A' ? column : unitsPerFloor - 1 - column;
        const x = BUILDING_MARGIN_X + drawnColumn * UNIT_W;
        const label = unitNumber(floorNumber, sideIndex * unitsPerFloor + column);

        units.push({
          id: `u-${side}-${level.index}-${column}`,
          label,
          short: label,
          level: level.index,
          column,
          side,
          floorNumber,
          stackId: spec.sharedRisers ? `riser-${column}` : `riser-${side}-${column}`,
          x,
          y,
          w: UNIT_W,
          h,
          fixtures: unitFixtures(x, UNIT_W, y + h),
        });
      }
    });
  }

  const stacks = buildStacks(units, spec.sharedRisers);

  return {
    ...spec,
    floors,
    unitsPerFloor,
    levels,
    units,
    stacks,
    sides,
    unitCount: units.length,
    scene: {
      w: BUILDING_MARGIN_X * 2 + unitsPerFloor * UNIT_W + DX,
      h: (levels[levels.length - 1]?.bottom ?? BUILDING_TOP) + BUILDING_BOTTOM,
    },
  };
}

function buildStacks(units: UnitDef[], sharedRisers: boolean): StackDef[] {
  const byStack = new Map<string, UnitDef[]>();
  for (const unit of units) {
    const list = byStack.get(unit.stackId);
    if (list) list.push(unit);
    else byStack.set(unit.stackId, [unit]);
  }

  return [...byStack.entries()]
    .map(([id, list]) => {
      const sorted = [...list].sort((a, b) => a.level - b.level);
      return {
        id,
        column: sorted[0].column,
        side: sharedRisers ? undefined : sorted[0].side,
        unitIds: sorted.map((unit) => unit.id),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/* ── seeding ─────────────────────────────────────────────────────── */

/**
 * Shape of `deriveBuildingGeometry`'s output, from
 * `server/services/buildingGeometryDerivation.js`.
 */
export interface DerivedBuildingGeometry {
  archetype?: string | null;
  floors?: number | null;
  unitsTotal?: number | null;
  unitsPerFloor?: number | null;
  corridor?: string | null;
  confidence?: string | null;
  needsConfirmation?: boolean | null;
}

const ARCHETYPES: BuildingArchetype[] = [
  'single_family',
  'condo_unit',
  'duplex',
  'garden_walkup',
  'midrise_corridor',
  'unknown',
];

export const DEFAULT_BUILDING_SPEC: BuildingSpec = {
  floors: 3,
  unitsPerFloor: 4,
  corridor: 'none',
  sharedRisers: false,
  hasBasement: false,
  archetype: 'unknown',
  confidence: 'low',
  needsConfirmation: true,
};

/**
 * Turn the server's cached-ATTOM guess into a spec.
 *
 * Anything missing falls back to a plausible walk-up rather than to nothing,
 * because a building the manager can correct is far more useful than an empty
 * state — the confirm-and-correct flow needs something on screen to correct.
 * `needsConfirmation` is what keeps that honest, and it defaults to true.
 */
export function specFromDerivation(
  geometry: DerivedBuildingGeometry | null | undefined,
): BuildingSpec {
  if (!geometry) return { ...DEFAULT_BUILDING_SPEC };

  const archetype = ARCHETYPES.includes(geometry.archetype as BuildingArchetype)
    ? (geometry.archetype as BuildingArchetype)
    : 'unknown';

  const floors = Math.max(1, Math.round(geometry.floors ?? DEFAULT_BUILDING_SPEC.floors));
  const unitsPerFloor = Math.max(
    1,
    Math.round(
      geometry.unitsPerFloor
      ?? (geometry.unitsTotal ? geometry.unitsTotal / floors : DEFAULT_BUILDING_SPEC.unitsPerFloor),
    ),
  );

  const confidence = geometry.confidence === 'high' || geometry.confidence === 'medium'
    ? geometry.confidence
    : 'low';

  return {
    floors,
    unitsPerFloor,
    corridor: geometry.corridor === 'double_loaded' ? 'double_loaded' : 'none',
    // Never seeded on. Back-to-back risers widen exposure claims, so they are a
    // thing a manager tells us, not a thing we guess from a property class.
    sharedRisers: false,
    // ATTOM says nothing usable about basements in multifamily stock.
    hasBasement: false,
    archetype,
    confidence,
    needsConfirmation: geometry.needsConfirmation ?? confidence !== 'high',
  };
}

/**
 * Whether a property should be drawn as a building at all.
 *
 * A single-family house and a lone condo unit are both better served by the
 * existing oblique cutaway: one has no stacked units, and the other is one unit
 * whose neighbours we know nothing about. Drawing either as a building would
 * mean inventing units.
 *
 * `confirmed` is what someone typed into the stacking plan, and it changes the
 * unknown case entirely. When we are guessing, "unknown archetype" means we could
 * not classify the address, and inventing stacked apartments from that is worse
 * than showing a house. When a manager has told us four floors of twelve units,
 * the archetype is beside the point — they are describing a building, and
 * refusing to draw one because our classifier never had an opinion would be us
 * overruling the only person who actually knows.
 *
 * The house/condo veto survives confirmation on purpose: it is a statement about
 * what the *other* drawing is for, not a doubt about the numbers.
 */
export function shouldDrawAsBuilding(spec: BuildingSpec, confirmed = false): boolean {
  if (spec.archetype === 'single_family' || spec.archetype === 'condo_unit') return false;
  if (spec.archetype === 'unknown' && !confirmed) return false;
  return spec.floors > 1 || spec.unitsPerFloor > 1;
}

/* ── propagation adapter ─────────────────────────────────────────── */

/**
 * Turn units into propagation cells.
 *
 * Both sides are always included, even though only one is drawn. Water does not
 * care which facade is facing the viewer, and the cross-side exposure badge —
 * "2 exposed units on the far side" — only exists because the engine was given
 * the units it cannot currently see. Filtering to the visible side would make
 * the flip hide real exposure, which is the worst thing a safety view can do.
 *
 * The basement level is included as a single wide cell so a leak in a
 * ground-floor unit still has somewhere to go.
 */
export function buildingCells(building: BuildingDef): PropagationCell[] {
  const cells: PropagationCell[] = building.units.map((unit) => ({
    id: unit.id,
    level: unit.level,
    x: unit.x,
    w: unit.w,
    stackId: unit.stackId,
    label: `Unit ${unit.label}`,
    side: unit.side,
  }));

  const basement = building.levels.find((level) => level.kind === 'basement');
  if (basement) {
    cells.push({
      id: 'basement',
      level: basement.index,
      x: BUILDING_MARGIN_X,
      w: building.unitsPerFloor * UNIT_W,
      label: 'Basement',
    });
  }

  return cells;
}

export function unitById(building: BuildingDef, id: string | null | undefined): UnitDef | null {
  if (!id) return null;
  return building.units.find((unit) => unit.id === id) ?? null;
}

/** Units on one facade, in drawn order left to right. */
export function unitsOnSide(building: BuildingDef, side: BuildingSide): UnitDef[] {
  return building.units
    .filter((unit) => unit.side === side)
    .sort((a, b) => (a.level - b.level) || (a.x - b.x));
}

/** Units on one storey, whichever side they are on. */
export function unitsOnLevel(building: BuildingDef, level: number): UnitDef[] {
  return building.units.filter((unit) => unit.level === level);
}

/**
 * The unit under a point in drawing coordinates, for drag-and-drop.
 *
 * Restricted to the facade on screen, because the far side's units occupy the same
 * boxes: without the filter, dropping a sensor on the front elevation could assign
 * it to an apartment on the other side of the corridor.
 */
export function unitAtPoint(
  building: BuildingDef,
  side: BuildingSide,
  x: number,
  y: number,
  /** Vertical shift per level, used when the elevation is exploded. */
  lift: (level: number) => number = () => 0,
): UnitDef | null {
  return building.units.find((unit) => {
    const top = unit.y + lift(unit.level);
    return unit.side === side
      && x >= unit.x && x <= unit.x + unit.w
      && y >= top && y <= top + unit.h;
  }) ?? null;
}

/**
 * Units in the shape the coverage model reads.
 *
 * An adapter rather than a second implementation of coverage: "a space with
 * plumbing and no working water sensor" is the same question in a house and in an
 * apartment, and forking it would let the two drift into disagreeing about the
 * same building.
 *
 * `floor` exists only so the report can group and describe locations; an apartment
 * is `main` on the lowest storey and `upper` above it, which is what the phrasing
 * in the report needs and nothing more.
 */
export function coverageSpacesFromUnits(building: BuildingDef): RoomDef[] {
  const lowest = Math.max(...building.units.map((unit) => unit.level));
  return building.units.map((unit) => ({
    id: unit.id,
    label: `Unit ${unit.label}`,
    short: unit.label,
    floor: (unit.level >= lowest ? 'main' : 'upper') as RoomDef['floor'],
    x: unit.x,
    y: unit.y,
    w: unit.w,
    h: unit.h,
    fixtures: unit.fixtures,
  }));
}

/**
 * Which unit a device belongs to.
 *
 * Only an explicit `twinUnitId` counts. The house guesses from device names —
 * "Kitchen Leak" is almost certainly in the kitchen — and that inference does not
 * survive the move to a building: "Unit 3 Bath" tells you the room but not which
 * of forty apartments, and a sensor placed in the wrong apartment is worse than
 * one visibly placed nowhere, because it makes a confident claim about somebody
 * else's home.
 *
 * Unplaced devices are the caller's problem to surface, which is what the
 * placed-by-guess banner already does.
 */
export function inferUnit(
  building: BuildingDef,
  device: { twinUnitId?: string | null },
): { unitId: string; confidence: 'assigned' } | null {
  const unit = unitById(building, device.twinUnitId ?? null);
  return unit ? { unitId: unit.id, confidence: 'assigned' } : null;
}

/**
 * The other facade, for the flip control. Returns null for a single-sided
 * building, which is what disables the control rather than flipping to nothing.
 */
export function oppositeSide(building: BuildingDef, side: BuildingSide): BuildingSide | null {
  if (building.sides.length < 2) return null;
  return side === 'A' ? 'B' : 'A';
}

/**
 * Compass-ish label for a facade.
 *
 * Deliberately not a compass bearing. We do not know the building's orientation,
 * and "north elevation" would be a fact we invented; "front" and "rear" are
 * relative terms that stay true whichever way it faces.
 */
export const SIDE_LABEL: Record<BuildingSide, string> = {
  A: 'Front elevation',
  B: 'Rear elevation',
};

/** How much of the facade to frame by default, in units. */
export const DEFAULT_COLUMNS_IN_VIEW = 10;

/**
 * Scene for the building at a given rendered aspect.
 *
 * Long buildings are framed to roughly {@link DEFAULT_COLUMNS_IN_VIEW} columns
 * and panned horizontally rather than shrunk to fit. A 40-unit facade scaled
 * into one screen width gives every unit about 25 pixels, which is legible as a
 * bar chart and useless as a thing you click on to see which sensor is in it.
 */
export function buildingSceneAspect(building: BuildingDef): number {
  const visibleW = Math.min(
    building.scene.w,
    BUILDING_MARGIN_X * 2 + DEFAULT_COLUMNS_IN_VIEW * UNIT_W + DX,
  );
  return visibleW / building.scene.h;
}

/* ── exploded view ───────────────────────────────────────────────── */

/**
 * Vertical separation between floors in the exploded view.
 *
 * The exploded view exists because the section is honest but cramped: the slab
 * between two floors is 16 units thick, and the drips crossing it — the thing
 * that shows *how* water got from one apartment to the one below — have almost no
 * room to be seen. Pulling the floors apart gives that route somewhere to be
 * drawn without changing anything about the model.
 */
export const EXPLODE_GAP = 96;

/** How far to move a level down in the exploded view. Level 0 does not move. */
export function explodeOffset(level: number): number {
  return Math.max(0, level) * EXPLODE_GAP;
}

/**
 * Scene for the exploded view — the same drawing, taller.
 *
 * Kept as its own function rather than a flag on `scene` so a caller cannot
 * accidentally frame the exploded drawing with the sectioned extent, which would
 * clamp the camera above the lowest floor and make the basement unreachable.
 */
export function explodedScene(building: BuildingDef): { w: number; h: number } {
  return {
    w: building.scene.w,
    h: building.scene.h + explodeOffset(building.levels.length - 1),
  };
}

/** Vertical extent of a level, for renderers that only hold a level index. */
export function bandForLevel(
  building: BuildingDef,
  level: number,
): BuildingLevel | null {
  return building.levels.find((band) => band.index === level) ?? null;
}

/** Re-exported so a renderer can share the house's projection without importing both. */
export { DX, DY, SLAB };
