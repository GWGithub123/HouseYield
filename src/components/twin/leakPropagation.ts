/**
 * Where water goes after a leak is detected, and why.
 *
 * Water leaves a leak by three routes, and this module models exactly those
 * three because they are the ones a person can act on:
 *
 *   1. down — through the floor assembly into whatever is directly beneath it,
 *      then onward down, which is the route that turns a one-room event into a
 *      three-unit event;
 *   2. down a shared wet wall or riser, which reaches places that are *not*
 *      directly beneath the leak and is the route people miss;
 *   3. sideways across the floor it started on, which is slower and shallower
 *      but is what wets the neighbour's carpet.
 *
 * ## One engine for houses and buildings
 *
 * The geometry is expressed as {@link PropagationCell}s rather than rooms, so a
 * bedroom and an apartment unit are the same kind of thing: something at a
 * vertical level occupying a horizontal span. A single-family house is a
 * one-unit, one-stack building. That is the whole reason multifamily support is
 * a matter of handing this function different cells rather than a second
 * implementation.
 *
 * ## These are exposures, not damage
 *
 * Nothing here observes water anywhere except the source. Everything else is a
 * geometric inference from a schematic model of a building we have never
 * surveyed. So every result carries a `reason` sentence stating the basis for
 * the flag, and the vocabulary is deliberately "possible exposure - inspect"
 * rather than any assertion that a space is wet or damaged. That follows the
 * claim discipline in `INSURANCE_PACKET_STANDARDS.md`, which is strict about
 * separating what was observed from what was inferred.
 */

import {
  FLOOR_BANDS,
  type FloorId,
  type RoomDef,
} from './houseModel';

/* ── model ───────────────────────────────────────────────────────── */

/**
 * How a space came to be flagged. Ordered by how strongly the geometry implies
 * water actually arrives there.
 */
export type ExposureTier = 'source' | 'direct' | 'stack' | 'lateral';

export interface PropagationCell {
  id: string;
  /**
   * Vertical band index. Lower numbers are *higher* in the building, matching
   * SVG y and reading order, so "below" is simply a larger level.
   */
  level: number;
  /** Left edge and width, in the same user units as the drawing. */
  x: number;
  w: number;
  /**
   * Shared plumbing riser or wet wall. Cells in the same stack are connected by
   * pipe regardless of whether they sit directly above one another, which is
   * what makes cross-corridor exposure possible.
   */
  stackId?: string;
  /** Display name, used to build the reason sentence. */
  label?: string;
  /** Which side of a double-loaded corridor, for multifamily buildings. */
  side?: 'A' | 'B';
}

export interface LeakExposure {
  cellId: string;
  tier: ExposureTier;
  /**
   * Rough confidence that water reaches this cell at all, 0..1. This is a
   * ranking aid for deciding what to inspect first, not a probability anyone
   * should quote.
   */
  likelihood: number;
  /** How many levels below the source cell this sits. 0 on the source's level. */
  levelsBelow: number;
  /**
   * The leaking cell this claim came from. Absent on `source` rows, which *are*
   * the leak.
   *
   * Carried so a renderer can put a mark where water actually arrives rather
   * than washing a whole surface: water comes through a floor where the two
   * spaces overlap, and that position is only knowable from the pair.
   */
  sourceCellId?: string;
  /**
   * Why this cell is flagged, in plain language. Always populated — a flag
   * without a stated basis is not something we are willing to show a manager.
   */
  reason: string;
}

export type ValveState = 'open' | 'closed' | 'unknown';

export interface PropagationInput {
  cells: PropagationCell[];
  /** Cells where water was actually detected. */
  sourceCellIds: string[];
  /**
   * State of the supply shutoff. A closed valve bounds the volume to what is
   * already in the pipes, which materially limits how far water travels.
   */
  valveState?: ValveState;
  /**
   * Minutes since detection. Water needs time to saturate and penetrate a floor
   * assembly, so a freshly fired sensor implies less spread than an hour-old one.
   */
  minutesSinceDetection?: number;
  /**
   * Exposures weaker than this are dropped rather than shown. Flagging an entire
   * building teaches people to ignore the flags.
   */
  minLikelihood?: number;
}

/* ── tuning ──────────────────────────────────────────────────────── */

/** Starting strength per route. */
const TIER_BASE: Record<Exclude<ExposureTier, 'source'>, number> = {
  direct: 0.8,
  stack: 0.55,
  lateral: 0.3,
};

/** Multiplied in per additional level of travel downward. */
const LEVEL_DECAY = 0.72;

/** How much a closed or unknown shutoff limits spread. */
const VALVE_FACTOR: Record<ValveState, number> = {
  open: 1,
  unknown: 0.88,
  closed: 0.5,
};

/**
 * Minutes at which time stops mattering. Before this, water is still working
 * through the floor; after it, the assembly is saturated and further delay does
 * not change which spaces are exposed.
 */
const TIME_SATURATION_MINUTES = 60;
const TIME_FLOOR = 0.55;

const DEFAULT_MIN_LIKELIHOOD = 0.12;

/** Cells whose spans come within this many units count as neighbours. */
const LATERAL_GAP_TOLERANCE = 4;

/* ── geometry helpers ────────────────────────────────────────────── */

/** Overlap of two spans as a fraction of the narrower one, 0..1. */
export function spanOverlapFraction(
  a: { x: number; w: number },
  b: { x: number; w: number },
): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const overlap = right - left;
  if (overlap <= 0) return 0;
  const narrower = Math.min(a.w, b.w);
  if (narrower <= 0) return 0;
  return Math.min(1, overlap / narrower);
}

/**
 * Where two spans overlap, horizontally — the position water crosses between
 * them. Falls back to the second span's own centre when they do not overlap,
 * which is the `stack` case: water arrives via a riser rather than straight
 * down, so there is no shared footprint to point at.
 */
export function spanOverlapCenter(
  a: { x: number; w: number },
  b: { x: number; w: number },
): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  if (right - left <= 0) return b.x + b.w / 2;
  return (left + right) / 2;
}

/**
 * Whether two cells share a coordinate space at all.
 *
 * `x` is measured along a facade, so it is only comparable between cells on the
 * same facade. In a double-loaded corridor the two sides are drawn over the same
 * horizontal range — mirrored, since you walk around the building to see the far
 * side — which means a naive overlap test concludes that a unit on the front is
 * directly above a unit at the back. It is not; there is a corridor between them.
 *
 * A cell with no side belongs to every space: a house room, or a building's
 * basement, which really does sit under both facades.
 */
function comparableSpans(a: PropagationCell, b: PropagationCell): boolean {
  if (a.side === undefined || b.side === undefined) return true;
  return a.side === b.side;
}

/**
 * Cells on the level immediately below `cell` that it overlaps horizontally —
 * that is, the things water falls into.
 */
export function cellsBelow(cells: PropagationCell[], cell: PropagationCell): PropagationCell[] {
  return cells
    .filter((candidate) => candidate.level === cell.level + 1)
    .filter((candidate) => comparableSpans(cell, candidate))
    .filter((candidate) => spanOverlapFraction(cell, candidate) > 0);
}

/**
 * Cells on the same level whose spans touch or nearly touch `cell`.
 *
 * A shared plumbing stack counts as touching even across a corridor, because
 * that is what sharing a wet wall means: the pipe is *in* the wall between the
 * two units, so a failure in it is on both sides of it at once. This is the only
 * route by which a leak reaches the far facade on its own floor, and it is why
 * `sharedRisers` is something a manager confirms rather than something we assume.
 */
export function cellsBeside(cells: PropagationCell[], cell: PropagationCell): PropagationCell[] {
  return cells.filter((candidate) => {
    if (candidate.id === cell.id || candidate.level !== cell.level) return false;
    const sharesWetWall = Boolean(cell.stackId) && candidate.stackId === cell.stackId;
    if (!sharesWetWall && !comparableSpans(cell, candidate)) return false;
    if (sharesWetWall) return true;
    const gap = Math.max(cell.x, candidate.x) - Math.min(cell.x + cell.w, candidate.x + candidate.w);
    return gap <= LATERAL_GAP_TOLERANCE;
  });
}

/* ── reason sentences ────────────────────────────────────────────── */

function nameOf(cell: PropagationCell): string {
  return cell.label || cell.id;
}

/**
 * The sentence shown next to every flag. It names the route and the basis, and
 * it never claims the space is wet.
 */
function reasonFor(
  tier: Exclude<ExposureTier, 'source'>,
  source: PropagationCell,
  target: PropagationCell,
  levelsBelow: number,
): string {
  const from = nameOf(source);
  const to = nameOf(target);

  if (tier === 'direct') {
    const depth = levelsBelow === 1
      ? 'directly below'
      : `${levelsBelow} levels below`;
    return `${to} sits ${depth} ${from}, so water leaving that floor can reach it. Possible exposure - inspect.`;
  }

  if (tier === 'stack') {
    const sideNote = target.side && source.side && target.side !== source.side
      ? ' on the opposite side of the corridor'
      : '';
    return `${to} shares a plumbing stack with ${from}${sideNote}, so water can travel down the wet wall rather than straight down. Possible exposure - inspect.`;
  }

  return `${to} adjoins ${from} on the same level, so water can spread across the floor into it. Possible exposure - inspect.`;
}

/* ── engine ──────────────────────────────────────────────────────── */

function timeFactor(minutes: number | undefined): number {
  if (minutes === undefined || minutes === null) return 1;
  if (!Number.isFinite(minutes) || minutes < 0) return 1;
  const ramp = Math.min(1, minutes / TIME_SATURATION_MINUTES);
  return TIME_FLOOR + (1 - TIME_FLOOR) * ramp;
}

/**
 * Work out which cells are exposed by leaks at `sourceCellIds`.
 *
 * Downward travel cascades: water reaching the space below can carry on into
 * the space below *that*, which is what makes a top-floor leak a whole-column
 * problem. Each cell keeps only its strongest claim, so a space reachable both
 * directly and via a stack is reported once, by its most likely route.
 *
 * Source cells are returned too, tagged `source`, so callers can render the
 * whole picture from one list.
 */
export function propagateLeak(input: PropagationInput): LeakExposure[] {
  const {
    cells,
    sourceCellIds,
    valveState = 'unknown',
    minutesSinceDetection,
    minLikelihood = DEFAULT_MIN_LIKELIHOOD,
  } = input;

  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const sources = sourceCellIds
    .map((id) => byId.get(id))
    .filter((cell): cell is PropagationCell => Boolean(cell));

  if (sources.length === 0) return [];

  const environmental = VALVE_FACTOR[valveState] * timeFactor(minutesSinceDetection);
  const best = new Map<string, LeakExposure>();

  const claim = (exposure: LeakExposure) => {
    const existing = best.get(exposure.cellId);
    if (!existing || exposure.likelihood > existing.likelihood) {
      best.set(exposure.cellId, exposure);
    }
  };

  for (const source of sources) {
    claim({
      cellId: source.id,
      tier: 'source',
      likelihood: 1,
      levelsBelow: 0,
      reason: `Water detected in ${nameOf(source)}.`,
    });
  }

  for (const source of sources) {
    /*
     * Downward cascade. `strength` carries the accumulated likelihood so a cell
     * three floors down inherits the decay of the path taken to reach it, and
     * `seen` keeps a single source from revisiting a cell through a longer path.
     */
    const queue: Array<{ cell: PropagationCell; strength: number; depth: number }> = [
      { cell: source, strength: 1, depth: 0 },
    ];
    const seen = new Set<string>([source.id]);

    while (queue.length > 0) {
      const { cell, strength, depth } = queue.shift()!;

      for (const below of cellsBelow(cells, cell)) {
        const overlap = spanOverlapFraction(cell, below);
        const next = strength * TIER_BASE.direct * LEVEL_DECAY ** depth * overlap;
        const likelihood = next * environmental;
        const levelsBelow = below.level - source.level;

        if (likelihood >= minLikelihood && !sourceCellIds.includes(below.id)) {
          claim({
            cellId: below.id,
            tier: 'direct',
            likelihood: round(likelihood),
            levelsBelow,
            sourceCellId: source.id,
            reason: reasonFor('direct', source, below, levelsBelow),
          });
        }

        // Continue the cascade even when this rung fell below the reporting
        // threshold only because of a narrow overlap; the space under it may
        // still be squarely in the path.
        if (!seen.has(below.id) && next >= minLikelihood * 0.5) {
          seen.add(below.id);
          queue.push({ cell: below, strength: next, depth: depth + 1 });
        }
      }
    }

    // Shared riser or wet wall: reaches down the stack without needing overlap.
    if (source.stackId) {
      for (const cell of cells) {
        if (cell.id === source.id || cell.stackId !== source.stackId) continue;
        if (cell.level <= source.level) continue;

        const levelsBelow = cell.level - source.level;
        const likelihood = TIER_BASE.stack * LEVEL_DECAY ** (levelsBelow - 1) * environmental;
        if (likelihood < minLikelihood || sourceCellIds.includes(cell.id)) continue;

        claim({
          cellId: cell.id,
          tier: 'stack',
          likelihood: round(likelihood),
          levelsBelow,
          sourceCellId: source.id,
          reason: reasonFor('stack', source, cell, levelsBelow),
        });
      }
    }

    // Lateral spread across the level the leak started on.
    for (const beside of cellsBeside(cells, source)) {
      const likelihood = TIER_BASE.lateral * environmental;
      if (likelihood < minLikelihood || sourceCellIds.includes(beside.id)) continue;

      claim({
        cellId: beside.id,
        tier: 'lateral',
        likelihood: round(likelihood),
        levelsBelow: 0,
        sourceCellId: source.id,
        reason: reasonFor('lateral', source, beside, 0),
      });
    }
  }

  return [...best.values()].sort((a, b) => {
    if (b.likelihood !== a.likelihood) return b.likelihood - a.likelihood;
    return a.cellId.localeCompare(b.cellId);
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* ── house adapter ───────────────────────────────────────────────── */

/**
 * Floor bands top to bottom. This is the vertical order water travels in, and
 * the index into it is a cell's `level`.
 *
 * `exterior` is deliberately absent: the yard is not below anything.
 */
export const HOUSE_LEVEL_ORDER: Array<Exclude<FloorId, 'exterior'>> = [
  'attic',
  'upper',
  'main',
  'basement',
];

export function houseLevelOf(floor: FloorId): number | null {
  const index = HOUSE_LEVEL_ORDER.indexOf(floor as Exclude<FloorId, 'exterior'>);
  return index === -1 ? null : index;
}

/**
 * Turn the drawn rooms into propagation cells.
 *
 * The house's own geometry is the input: `floor` gives the level, and `x`/`w`
 * give the span, so the flags line up with the section exactly. Rooms outside
 * the vertical stack (the yard) are dropped.
 *
 * Rooms are not assigned a `stackId`. We know a house has a wet wall, but not
 * which rooms share it, and inventing that would produce confident-looking
 * exposure claims with nothing behind them. Direct and lateral spread are both
 * derivable from geometry we actually have.
 */
export function houseCells(rooms: RoomDef[]): PropagationCell[] {
  return rooms
    .map((room): PropagationCell | null => {
      const level = houseLevelOf(room.floor);
      if (level === null) return null;
      return {
        id: room.id,
        level,
        x: room.x,
        w: room.w,
        label: room.label,
      };
    })
    .filter((cell): cell is PropagationCell => cell !== null);
}

/**
 * Vertical extent of a level, for drawing. Exposed here so renderers do not
 * have to know that house levels are `FLOOR_BANDS` keys.
 */
export function houseLevelBand(level: number): { top: number; bottom: number } | null {
  const floor = HOUSE_LEVEL_ORDER[level];
  if (!floor) return null;
  return FLOOR_BANDS[floor];
}

/** Convenience: propagate over a house's rooms given the leaking room ids. */
export function propagateHouseLeak(
  rooms: RoomDef[],
  leakingRoomIds: string[],
  options: Omit<PropagationInput, 'cells' | 'sourceCellIds'> = {},
): LeakExposure[] {
  return propagateLeak({
    ...options,
    cells: houseCells(rooms),
    sourceCellIds: leakingRoomIds,
  });
}

/* ── presentation helpers ────────────────────────────────────────── */

/** Short tier label for legends and badges. */
export const TIER_LABEL: Record<ExposureTier, string> = {
  source: 'Water detected',
  direct: 'Below the leak',
  stack: 'Shared plumbing stack',
  lateral: 'Adjoining space',
};

/**
 * One-line summary for a header or a notification.
 *
 * Counts spaces rather than asserting damage, and says "may have" because that
 * is what a geometric inference supports.
 */
export function summarizeExposure(exposures: LeakExposure[]): string | null {
  const affected = exposures.filter((e) => e.tier !== 'source');
  if (affected.length === 0) return null;
  const noun = affected.length === 1 ? 'space' : 'spaces';
  return `${affected.length} other ${noun} may have been exposed. Inspect before closing the ticket.`;
}

export interface ExposureProgressionPoint {
  minutes: number;
  /** Spaces in scope at that elapsed time, excluding the source. */
  count: number;
  /** True for the checkpoint the leak has actually reached. */
  reached: boolean;
}

/** Default checkpoints: the first hour is where the ramp does all its work. */
export const PROGRESSION_CHECKPOINTS = [0, 15, 30, 60];

/**
 * How the exposed set grows with elapsed time.
 *
 * This is a projection of the same model at different clock values, not a
 * record of anything observed, and callers must label it as such. Its value is
 * escalation: "leave this another half hour and two more units come into scope"
 * is a decision people can act on, where a static count is not.
 */
export function exposureProgression(
  input: Omit<PropagationInput, 'minutesSinceDetection'>,
  elapsedMinutes: number | undefined,
  checkpoints: number[] = PROGRESSION_CHECKPOINTS,
): ExposureProgressionPoint[] {
  const elapsed = Number.isFinite(elapsedMinutes as number) ? (elapsedMinutes as number) : 0;

  return checkpoints.map((minutes) => ({
    minutes,
    count: propagateLeak({ ...input, minutesSinceDetection: minutes })
      .filter((e) => e.tier !== 'source').length,
    reached: elapsed >= minutes,
  }));
}
