/**
 * The cutaway property twin, in the drawing's own coordinates.
 *
 * There is still no floor-plan data for any property — ATTOM gives us beds,
 * baths, living_sqft, property_type and year_built, but no storey count,
 * basement flag or room list — so what is drawn is an *archetypal* house whose
 * visible rooms flex with the bed/bath counts we do have.
 *
 * What changed is where that archetype lives. It used to be right here, as a
 * list of SVG coordinates, which meant "the house" and "the picture of the
 * house" were one object and a measured footprint had nowhere to go. The house
 * now lives in [`siteModel.ts`](./siteModel.ts) in world metres and arrives
 * here already projected by [`houseProjection.ts`](./houseProjection.ts). This
 * module is the flat view of it, plus everything that is genuinely about the
 * drawing rather than the building: where the service enters, how pins are
 * spaced inside a room, which room a device's name suggests.
 *
 * Every export below keeps the name, shape and meaning it had, so the ~2,300
 * lines of illustration in `HouseCutaway.tsx` and the leak, coverage, health
 * and camera models that read this geometry did not have to move with it.
 *
 * Two numbers did move, because the old drawing disagreed with itself: it drew
 * a 5.2 m basement while `FLOOD_THRESHOLDS` measured the same basement at 8 ft.
 * The section now has one honest vertical scale, so `UNITS_PER_FT` and the
 * storey bands are derived rather than hand-placed, and the waterline is finally
 * drawn against the datum the hazard model was already using.
 */
import { archetypeSiteModel } from './siteModel';
import {
  DX,
  DY,
  projectHouse,
  UNITS_PER_M,
  VERTICAL_UNITS_PER_M,
} from './houseProjection';

export type {
  FloorId,
  FixtureKind,
  HouseShape,
  PropertyShapeOption,
} from './siteModel';
export type { Fixture, RoomDef } from './houseProjection';
export { propertyShape } from './siteModel';
export {
  DX,
  DY,
  UNITS_PER_M,
  VB_H,
  VB_W,
  VERTICAL_UNITS_PER_M,
} from './houseProjection';

import type { FixtureKind, FloorId, PropertyShapeOption } from './siteModel';
import type { Fixture, RoomDef } from './houseProjection';

/* ── canvas + shell geometry ─────────────────────────────────────── */

/**
 * The archetypal house, projected once.
 *
 * The exported shell and storey bands are the archetypal frame — pin placement,
 * flood maths, previews and the live house cutaway all read this same diagram.
 * A condo's missing basement is handled by not drawing rooms there.
 */
const ARCHETYPE = projectHouse(archetypeSiteModel());

export const SHELL = ARCHETYPE.shell;

export const FLOOR_BANDS: Record<Exclude<FloorId, 'exterior'>, { top: number; bottom: number }> =
  ARCHETYPE.bands;

/** Interior x-extent between the wall faces. */
export const INTERIOR_LEFT = SHELL.wallLeft + SHELL.wallThickness;
export const INTERIOR_RIGHT = SHELL.wallRight - SHELL.wallThickness;

/**
 * The basement splits into three horizontal bands so nothing has to overlap:
 * device pins near the ceiling, the water main and shutoff valve through the
 * middle, and the floor-standing mechanicals below.
 *
 * Placed at a real height above the slab now rather than at a tuned pixel, so a
 * shallower basement brings the main down with it instead of stranding it in
 * the joists.
 */
export const WATER_MAIN_Y = SHELL.basementFloor - 0.9 * VERTICAL_UNITS_PER_M;
export const VALVE_CENTER = { x: 660, y: WATER_MAIN_Y };
/** Small enough that the assembly and its status text stay inside one room. */
export const VALVE_SCALE = 0.44;

/**
 * Where the shutoff assembly's own pipe ends, in the assembly's local units.
 *
 * The valve draws its inlet and outlet spigots itself, and the house has to
 * know where they land so the service can be plumbed *into* them. Without this
 * the two were drawn independently and the assembly floated in the middle of
 * the basement with a pipe that started and stopped in mid-air — mechanically
 * the loudest object in the section and the only one not attached to anything.
 */
export const VALVE_PIPE_HALF = 180;
export const VALVE_INLET_X = VALVE_CENTER.x - VALVE_PIPE_HALF * VALVE_SCALE;
export const VALVE_OUTLET_X = VALVE_CENTER.x + VALVE_PIPE_HALF * VALVE_SCALE;

/**
 * Where house-side supply turns up out of the basement to meet the trunk under
 * the main floor. Everything downstream of the valve hangs off this riser, so
 * closing the valve has somewhere visible to take effect.
 */
export const WATER_RISER_X = Math.round(VALVE_OUTLET_X + 62);

/**
 * Electric service entrance, on the outside of the right-hand wall and clear of
 * the depth planes that recede behind it.
 *
 * Mounted at the height a meter is actually set, which is roughly eye level.
 * That used to be a pixel that happened to land on the main floor band; now
 * that the section has a real vertical scale it can just be the height.
 */
export const METER = { x: SHELL.wallRight + DX + 10, y: SHELL.grade - 1.5 * VERTICAL_UNITS_PER_M };

/**
 * Where the overhead service drop lands, on the mast above the meter.
 *
 * Tied to the meter rather than placed independently. These were two separate
 * hardcoded heights, which held only while both were hand-tuned against the same
 * fixed drawing: the moment the section got a real vertical scale and the meter
 * moved to a real mounting height, the conductors from the pole terminated in
 * mid-air a metre and a half above it.
 */
export const SERVICE_HEAD = {
  x: METER.x + 6,
  y: METER.y - 20 - 0.4 * VERTICAL_UNITS_PER_M,
};

/**
 * Height at which the service conduit passes through the foundation wall.
 *
 * Shared by the exterior stub next to the meter and the interior run to the
 * panel, which are drawn in different layers — the wall has to sit between
 * them — so they can only line up if they agree on this one number.
 */
export const SERVICE_ENTRY_Y = FLOOR_BANDS.basement.top + 24;

/* ── vertical datum ──────────────────────────────────────────────── */

/**
 * Vertical is the only axis flooding cares about. Water finds a level, so a
 * horizontal water surface at a correct elevation needs no assumption about
 * which way the house faces. Everything below anchors that datum.
 *
 * This is where the old drawing was quietly broken. `UNITS_PER_FT` was derived
 * from the basement band on the stated assumption that the band was 8 ft deep,
 * but the band had been sized by eye and was really 5.2 m — so the waterline,
 * the threshold markers and the house they were drawn on were using two
 * different scales, and a "4 ft" panel threshold did not land where 4 ft of
 * water would. The section now has one vertical scale for everything, and the
 * derivation below is finally true rather than assumed.
 *
 * `SHELL.grade` is the single grade reference: it is where the soil is drawn,
 * where the utility poles stand, and where the main floor band ends. The
 * drawing does not depict the ~1.5 ft that a real finished floor sits above
 * grade, so neither does this datum — that nuance lives in the server-side
 * damage model (`finishedFloorAboveGradeFt`), which is where it changes dollars
 * rather than pixels.
 */
export const GRADE_Y = SHELL.grade;

/** An 8 ft basement puts the slab this far below grade and below the main floor. */
export const BASEMENT_DEPTH_BELOW_GRADE_FT = 8;
export const BASEMENT_FLOOR_TO_MAIN_FT = BASEMENT_DEPTH_BELOW_GRADE_FT;

/** SVG units per vertical foot, derived from the basement band. */
export const UNITS_PER_FT = (SHELL.basementFloor - SHELL.grade) / BASEMENT_FLOOR_TO_MAIN_FT;

/** Water level in feet above the basement slab → a y coordinate. */
export function waterLevelToY(levelFt: number): number {
  return SHELL.basementFloor - levelFt * UNITS_PER_FT;
}

/**
 * What standing water reaches, and in what order, as it rises off the basement
 * slab. Heights are typical installation heights rather than measurements of
 * this specific house, so they are presented as "what to check" rather than as
 * a survey. Each one is a real insurance or habitability threshold: burner
 * assemblies and control boards are what make a flooded furnace a replacement
 * instead of a clean-up.
 */
export interface FloodThreshold {
  id: string;
  /** Feet above the basement slab. */
  levelFt: number;
  label: string;
  detail: string;
  severity: 'info' | 'warn' | 'critical';
}

export const FLOOD_THRESHOLDS: FloodThreshold[] = [
  {
    id: 'slab',
    levelFt: 0,
    label: 'Basement slab wet',
    detail: 'Sump pit at capacity; finished flooring and anything stored on the floor is at risk.',
    severity: 'info',
  },
  {
    id: 'burners',
    levelFt: 1,
    label: 'Furnace burners and water-heater pilot',
    detail: 'Gas burner assemblies and pilot controls submerge here. Both typically require replacement, not drying out.',
    severity: 'warn',
  },
  {
    id: 'blower',
    levelFt: 2.5,
    label: 'HVAC blower and control boards',
    detail: 'Air handler motor and low-voltage boards flood. Heating and cooling are down until replaced.',
    severity: 'critical',
  },
  {
    id: 'panel',
    levelFt: 4,
    label: 'Electrical panel',
    detail: 'Service panel at typical mounting height is compromised. The utility must pull the meter before anyone re-enters.',
    severity: 'critical',
  },
  {
    id: 'main_floor',
    levelFt: BASEMENT_FLOOR_TO_MAIN_FT,
    label: 'Grade and first finished floor',
    detail: 'Below-grade space is full and water is entering living space. This is the threshold that drives most of the structural damage claim.',
    severity: 'critical',
  },
];

/** Router lives wherever it is inferred, but this is the fallback hub anchor. */
export const DEFAULT_ROUTER_ROOM = 'living';

/* ── rooms ───────────────────────────────────────────────────────── */

/**
 * Half-thickness of the floor assembly drawn between two bands. Rooms inset by
 * this much top and bottom, so the gap between one room's bottom edge and the
 * next room's top edge is the slab water has to get through — which is why the
 * exposure drips are drawn crossing it.
 */
export const SLAB = ARCHETYPE.slab;

/**
 * How far back into a room a fixture stands, as a fraction of the room's depth.
 *
 * Everything used to sit at zero — the front edge of the slab, flush with the
 * cut face of the house — so every bed, sofa and run of cabinets was jammed up
 * against the opening with the entire floor stretching away *behind* it. Real
 * furniture stands against a wall with floor in front of it, and that strip of
 * visible floor is the whole reason the room reads as something you are looking
 * into rather than a shelf of objects.
 *
 * A room is one depth unit deep and a fixture's own box eats roughly a quarter
 * of it, so the wall-standing default leaves floor in front and clearance at
 * the back. Anything that belongs in the middle of the room sits shallower.
 */
const AGAINST_WALL = 0.46;
/** Anything that belongs out in the room rather than up against a wall. */
const MID_ROOM = 0.3;

export const FIXTURE_DEPTH: Record<FixtureKind, number> = {
  water_heater: AGAINST_WALL,
  furnace: AGAINST_WALL,
  // Wall-mounted, so it hangs on the back wall rather than standing near it.
  panel: 0.62,
  washer: AGAINST_WALL,
  dryer: AGAINST_WALL,
  sump: MID_ROOM,
  fridge: AGAINST_WALL,
  counter: AGAINST_WALL,
  // Must match the counter exactly or the basin stops landing in the worktop.
  sink: AGAINST_WALL,
  stove: AGAINST_WALL,
  tub: AGAINST_WALL,
  toilet: AGAINST_WALL,
  vanity: AGAINST_WALL,
  bed: AGAINST_WALL,
  sofa: AGAINST_WALL,
  tv: AGAINST_WALL,
  table: MID_ROOM,
  door: AGAINST_WALL,
  stairs: MID_ROOM,
};

/**
 * Where a fixture is actually drawn, once its depth is projected.
 *
 * Every consumer has to agree on this — the glyph, its contact shadow, the
 * supply riser that feeds it and the trap that drains it. When the riser used
 * the raw coordinate and the glyph used a projected one, the pipe surfaced a
 * couple of feet away from the sink it was supposed to serve.
 */
export function fixtureAnchor(f: Fixture): { x: number; y: number } {
  const d = f.depth ?? FIXTURE_DEPTH[f.kind] ?? 0;
  const dx = f.depthDx ?? DX;
  const dy = f.depthDy ?? DY;
  return { x: f.x + dx * d, y: f.y - dy * d };
}

/*
 * A note on fixture coordinates.
 *
 * Standing a fixture back in its room moves it *right* as well as up — that is
 * what depth means here — and a wall-standing fixture therefore eats about 20
 * units of the room's width before its own footprint is counted. So placements
 * are not free: each room's contents have to fit inside its width once the
 * projection has been applied, or a cabinet's depth faces climb the partition
 * into the room next door and get clipped off mid-object.
 *
 * The placements themselves now live in `siteModel.ts`, measured from the left
 * wall of the room they stand in rather than from the canvas. That is what lets
 * a room change width without every fixture after it being retyped, which is
 * the whole prerequisite for a real footprint driving the drawing.
 */

/**
 * Rooms to draw for a given property.
 *
 * Derived rather than filtered. The old version kept one array of screen
 * rectangles and edited it — dropping the basement for a unit address, widening
 * the bath when there was no second bedroom — which worked only because every
 * room's width was a literal. Now the property flexes the *world* model and the
 * projection follows, so the same two rules fall out of the layout instead of
 * being patched onto its output.
 *
 * Memoised on the inputs that can change it. Callers pass the result straight
 * into `useMemo` dependency lists, so handing back a fresh array each render
 * would invalidate the leak, coverage and pin models on every frame.
 */
const roomCache = new Map<string, RoomDef[]>();

export function visibleRooms(option?: PropertyShapeOption): RoomDef[] {
  const key = `${option?.address ?? ''}|${option?.beds ?? ''}|${option?.baths ?? ''}`;
  const hit = roomCache.get(key);
  if (hit) return hit;
  const rooms = projectHouse(archetypeSiteModel(option)).rooms;
  roomCache.set(key, rooms);
  return rooms;
}

export function roomById(rooms: RoomDef[], id: string | null | undefined): RoomDef | null {
  if (!id) return null;
  return rooms.find((r) => r.id === id) || null;
}

export function roomAtPoint(rooms: RoomDef[], x: number, y: number): RoomDef | null {
  // Reverse order so later-declared rooms (drawn on top) win ties.
  for (let i = rooms.length - 1; i >= 0; i -= 1) {
    const r = rooms[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

/**
 * Evenly spaced pin positions inside a room, kept in the upper portion so pins
 * sit above the floor-standing fixtures rather than on top of them.
 */
export function anchorsFor(room: RoomDef, count: number): Array<{ x: number; y: number }> {
  if (count <= 0) return [];
  const perRow = Math.min(count, room.w >= 200 ? 3 : 2);
  const rows = Math.ceil(count / perRow);
  const topInset = room.floor === 'basement' ? 40 : 38;
  const rowGap = 54;
  const points: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / perRow);
    const inRow = i % perRow;
    const rowCount = Math.min(perRow, count - row * perRow);
    const slot = (inRow + 1) / (rowCount + 1);
    points.push({
      x: room.x + room.w * slot,
      y: room.y + topInset + row * rowGap,
    });
  }

  // Keep everything inside the room even when a room collects many devices.
  const maxY = room.y + room.h - 16;
  return points.map((p) => ({ x: p.x, y: Math.min(p.y, maxY) }));
}

/* ── placement inference ─────────────────────────────────────────── */

export type DeviceKindHint = 'flood' | 'gateway' | 'ht' | 'relay' | 'other';

export interface RoomInference {
  roomId: string;
  /** 'assigned' when the user placed it, otherwise how sure the guess is. */
  confidence: 'assigned' | 'high' | 'low';
}

/** Ordered — first match wins, so specific phrases precede generic ones. */
const ROOM_KEYWORDS: Array<{ roomId: string; pattern: RegExp }> = [
  { roomId: 'utility', pattern: /water\s*heater|hot\s*water|furnace|boiler|mechanical|utility|hvac|crawl|sump\s*pump/i },
  { roomId: 'laundry', pattern: /laundry|washer|dryer|wash\s*room/i },
  { roomId: 'kitchen', pattern: /kitchen|dishwasher|fridge|refrigerator|galley|under\s*sink/i },
  { roomId: 'bath_up', pattern: /bath|shower|toilet|powder|ensuite|lavatory|vanity/i },
  { roomId: 'bed_primary', pattern: /primary|master|main\s*bed/i },
  { roomId: 'bed_2', pattern: /bed\s*2|second\s*bed|guest|nursery|kids?\s*room/i },
  { roomId: 'living', pattern: /living|family|lounge|den|great\s*room|tv\s*room/i },
  { roomId: 'dining', pattern: /dining|breakfast|nook/i },
  { roomId: 'entry', pattern: /entry|foyer|hall\s*way|mud\s*room|front\s*door/i },
  { roomId: 'basement_open', pattern: /basement|cellar|sump|below\s*grade/i },
  { roomId: 'attic', pattern: /attic|loft|roof\s*space/i },
  { roomId: 'yard', pattern: /yard|outside|outdoor|exterior|garden|patio|deck/i },
  { roomId: 'bed_primary', pattern: /bed\s*room|\bbed\b/i },
];

const FLOOR_HINTS: Array<{ floor: FloorId; pattern: RegExp }> = [
  { floor: 'upper', pattern: /upstairs|upper|second\s*floor|2nd\s*floor/i },
  { floor: 'basement', pattern: /downstairs|basement|lower\s*level|below/i },
  { floor: 'main', pattern: /main\s*floor|first\s*floor|1st\s*floor|ground\s*floor/i },
];

const KIND_FALLBACK: Record<DeviceKindHint, string> = {
  relay: 'basement_open',
  flood: 'utility',
  gateway: 'living',
  ht: 'hall_up',
  other: 'living',
};

/**
 * Guess which room a device sits in from its name and free-text location.
 * Returns low confidence for kind-based fallbacks so the UI can render those
 * pins as unconfirmed rather than pretending it knows.
 */
export function inferRoom(
  input: { name?: string; location?: string; twinRoomId?: string },
  kind: DeviceKindHint,
  rooms: RoomDef[],
): RoomInference {
  const available = new Set(rooms.map((r) => r.id));

  if (input.twinRoomId && available.has(input.twinRoomId)) {
    return { roomId: input.twinRoomId, confidence: 'assigned' };
  }

  const haystack = `${input.name || ''} ${input.location || ''}`.trim();

  if (haystack) {
    for (const { roomId, pattern } of ROOM_KEYWORDS) {
      if (!pattern.test(haystack)) continue;
      if (available.has(roomId)) return { roomId, confidence: 'high' };
      // Room was hidden for this property (e.g. condo has no basement) —
      // fall through to a floor hint rather than dropping the match.
      break;
    }

    for (const { floor, pattern } of FLOOR_HINTS) {
      if (!pattern.test(haystack)) continue;
      const onFloor = rooms.find((r) => r.floor === floor);
      if (onFloor) return { roomId: onFloor.id, confidence: 'low' };
    }
  }

  const fallback = KIND_FALLBACK[kind];
  if (available.has(fallback)) return { roomId: fallback, confidence: 'low' };
  return { roomId: rooms[0]?.id ?? 'living', confidence: 'low' };
}
