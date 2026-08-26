/**
 * How much of a property's water risk is actually being watched.
 *
 * The insurance packet reports a `monitoredLocationCount` — a count of distinct
 * places a sensor sits. On its own that number cannot be argued with, because
 * there is nothing to compare it to: four monitored locations is excellent in a
 * two-bath house and negligent in a six-bath one. The denominator has to come
 * from somewhere, and the twin is the only thing that knows it, because the
 * archetypal room model already says which spaces contain plumbing.
 *
 * ## What counts as a wet location
 *
 * A room is a wet location if it contains a fixture that carries or holds water.
 * {@link WET_FIXTURES} is that list, and it is deliberately about *plumbing*
 * rather than about rooms people think of as wet: a finished basement with a
 * sump counts, a bedroom does not.
 *
 * The grain is the room, not the fixture. A bathroom with a tub and a toilet is
 * one location, because one sensor on that floor covers both and because
 * room-level is the grain `monitoredLocationCount` already uses — a ratio whose
 * numerator and denominator are counted differently is worse than no ratio.
 *
 * ## What counts as monitoring it
 *
 * Only a water sensor. A temperature/humidity sensor in a bathroom tells you
 * nothing about water on the floor, and letting it close a coverage gap would
 * make the ratio flattering and wrong. This module exists to find gaps, so
 * where it is unsure it reports the gap.
 *
 * ## This is a model, not a survey
 *
 * The room model is archetypal — flexed by bed and bath counts, never surveyed.
 * So a gap here means "the model expects plumbing here and sees no sensor",
 * which is a prompt to look, not a finding. Copy stays on the
 * `INSURANCE_PACKET_STANDARDS.md` side of that line.
 */

import type { FixtureKind, FloorId, RoomDef } from './houseModel';
import type { LeakExposure } from './leakPropagation';

/* ── what is wet ─────────────────────────────────────────────────── */

/**
 * Fixtures that carry, hold, or drain water.
 *
 * `dryer` is absent because it has no supply. `fridge` is absent too, which is
 * a genuine judgement call — an ice-maker line is a real and common failure —
 * but the drawn `fridge` fixture is decorative and does not record whether that
 * line exists, so counting it would put a gap in every kitchen on the strength
 * of an assumption. `furnace` and `panel` are mechanical, not plumbing.
 */
export const WET_FIXTURES: ReadonlySet<FixtureKind> = new Set<FixtureKind>([
  'sink',
  'tub',
  'toilet',
  'vanity',
  'sump',
  'water_heater',
  'washer',
]);

/**
 * Plain-language name per fixture, for the reason sentences. The raw keys are
 * snake_case identifiers and reading them back to a property manager is sloppy.
 */
const FIXTURE_LABEL: Partial<Record<FixtureKind, string>> = {
  sink: 'sink',
  tub: 'tub or shower',
  toilet: 'toilet',
  vanity: 'vanity',
  sump: 'sump pump',
  water_heater: 'water heater',
  washer: 'washing machine',
};

export function isWetFixture(kind: FixtureKind): boolean {
  return WET_FIXTURES.has(kind);
}

/** Human-readable fixture name. Falls back to a de-underscored key. */
export function fixtureLabel(kind: FixtureKind): string {
  return FIXTURE_LABEL[kind] ?? kind.replace(/_/g, ' ');
}

/* ── inputs ──────────────────────────────────────────────────────── */

/**
 * A device as far as coverage is concerned.
 *
 * Structurally the same as the topology map's positioned nodes, but declared
 * here so the model stays a pure function of data and can be tested without a
 * renderer.
 */
export interface CoveragePlacement {
  roomId: string;
  /** Device class. Only `'flood'` detects water. */
  kind: 'flood' | 'gateway' | 'ht' | 'relay' | 'other';
  /**
   * False for a device that is offline or has a dead battery. A sensor that
   * cannot report is not coverage, and the packet should not claim it is.
   */
  reporting?: boolean;
}

export interface WetLocation {
  roomId: string;
  label: string;
  floor: FloorId;
  /** Wet fixtures found in the room, de-duplicated and in drawing order. */
  fixtures: FixtureKind[];
  monitored: boolean;
  /** Water sensors placed in the room that are actually reporting. */
  waterSensorCount: number;
  /**
   * True when the only water sensor in the room is offline or flat. Distinct
   * from never having had one, because the fix is different: replace a battery
   * rather than buy a sensor.
   */
  sensorNotReporting: boolean;
  /** Why this room is in the denominator, in plain language. */
  reason: string;
}

export interface CoverageReport {
  locations: WetLocation[];
  monitored: WetLocation[];
  unmonitored: WetLocation[];
  monitoredCount: number;
  totalCount: number;
  /** Monitored fraction, 0..1. `0` when there is nothing to monitor. */
  ratio: number;
  /**
   * e.g. `"3 of 5 wet locations in this layout monitored"`. Empty when there are
   * none.
   *
   * "In this layout" is load-bearing. The room model is an archetype that draws
   * one bathroom whatever the property's bath count is, so this counts fixtures
   * visible in the drawing, not plumbing in the building. The insurance packet
   * states a separate, records-based figure for that
   * (`server/services/wetLocationDerivation.js`), and the two are allowed to
   * differ because they answer different questions.
   */
  headline: string;
}

/* ── model ───────────────────────────────────────────────────────── */

/** Wet fixture kinds in a room, de-duplicated, preserving drawing order. */
export function wetFixturesIn(room: RoomDef): FixtureKind[] {
  const seen = new Set<FixtureKind>();
  const kinds: FixtureKind[] = [];
  for (const fixture of room.fixtures) {
    if (!isWetFixture(fixture.kind) || seen.has(fixture.kind)) continue;
    seen.add(fixture.kind);
    kinds.push(fixture.kind);
  }
  return kinds;
}

function listFixtures(kinds: FixtureKind[]): string {
  const names = kinds.map(fixtureLabel);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * Work out which of a property's wet rooms are covered by a water sensor.
 *
 * Rooms with no plumbing are absent from the result entirely rather than
 * present and monitored: they are not part of the question, and including them
 * would inflate the ratio with rooms nobody would ever put a sensor in.
 */
export function computeCoverage(
  rooms: RoomDef[],
  placements: CoveragePlacement[],
): CoverageReport {
  /*
   * Two tallies per room, because "no sensor" and "a sensor that stopped
   * reporting" are different problems with different fixes, and collapsing them
   * would hide dead batteries behind a coverage number that still looks fine.
   */
  const reporting = new Map<string, number>();
  const silent = new Map<string, number>();

  for (const placement of placements) {
    if (placement.kind !== 'flood') continue;
    const bucket = placement.reporting === false ? silent : reporting;
    bucket.set(placement.roomId, (bucket.get(placement.roomId) ?? 0) + 1);
  }

  const locations: WetLocation[] = [];

  for (const room of rooms) {
    const fixtures = wetFixturesIn(room);
    if (fixtures.length === 0) continue;

    const live = reporting.get(room.id) ?? 0;
    const dead = silent.get(room.id) ?? 0;
    const monitored = live > 0;

    locations.push({
      roomId: room.id,
      label: room.label,
      floor: room.floor,
      fixtures,
      monitored,
      waterSensorCount: live,
      sensorNotReporting: !monitored && dead > 0,
      reason: monitored
        ? `${room.label} has a water sensor covering its ${listFixtures(fixtures)}.`
        : dead > 0
          ? `${room.label} has a water sensor, but it is not reporting, so its ${listFixtures(fixtures)} is effectively unmonitored.`
          : `${room.label} contains a ${listFixtures(fixtures)} and has no water sensor.`,
    });
  }

  const monitoredLocations = locations.filter((location) => location.monitored);
  const unmonitored = locations.filter((location) => !location.monitored);
  const totalCount = locations.length;
  const monitoredCount = monitoredLocations.length;

  return {
    locations,
    monitored: monitoredLocations,
    unmonitored,
    monitoredCount,
    totalCount,
    ratio: totalCount === 0 ? 0 : monitoredCount / totalCount,
    headline: totalCount === 0
      ? ''
      : `${monitoredCount} of ${totalCount} wet ${totalCount === 1 ? 'location' : 'locations'} in this layout monitored`,
  };
}

/* ── composition with propagation ────────────────────────────────── */

/**
 * Urgency bands. Priority is `band + likelihood`, and the bands are spaced far
 * wider than the 0..1 likelihood range on purpose: within a band the model's
 * confidence decides the order, but no amount of confidence promotes a room
 * into a higher band. That keeps a barely-touched monitored room from ever
 * outranking a blind spot the water is heading for.
 */
const BAND = {
  blindSpotInPath: 200,
  inPath: 100,
  standingGap: 0,
} as const;

export interface InspectionTarget {
  roomId: string;
  label: string;
  /** Higher is more urgent. Ordering is what matters, not the value. */
  priority: number;
  /** Set when the room is in the path of a live leak. */
  exposure?: LeakExposure;
  /** Set when the room has plumbing and no working water sensor. */
  gap?: WetLocation;
  reason: string;
}

/**
 * Order the rooms someone should physically walk into, most urgent first.
 *
 * The point of composing the two models is the intersection. An unmonitored wet
 * room in the path of a live leak is the worst case in the building: water is
 * probably arriving and nothing there will ever say so, so the only way anyone
 * finds out is by looking or by the ceiling failing later. That case has to
 * outrank both a monitored room in the leak path — where a sensor will speak
 * for itself — and an unmonitored room nowhere near the leak, which is a
 * purchasing decision rather than a today problem.
 */
export function rankInspectionTargets(
  coverage: CoverageReport,
  exposures: LeakExposure[],
): InspectionTarget[] {
  const gapByRoom = new Map(coverage.unmonitored.map((location) => [location.roomId, location]));
  const labelByRoom = new Map(coverage.locations.map((location) => [location.roomId, location.label]));
  const targets: InspectionTarget[] = [];

  for (const exposure of exposures) {
    if (exposure.tier === 'source') continue;
    const gap = gapByRoom.get(exposure.cellId);
    const label = labelByRoom.get(exposure.cellId) ?? exposure.cellId;

    targets.push({
      roomId: exposure.cellId,
      label,
      priority: (gap ? BAND.blindSpotInPath : BAND.inPath) + exposure.likelihood,
      exposure,
      gap,
      reason: gap
        ? `${label} is in the path of the leak and has no working water sensor, so nothing there will report water. Inspect first.`
        : exposure.reason,
    });
  }

  const flagged = new Set(targets.map((target) => target.roomId));

  for (const gap of coverage.unmonitored) {
    if (flagged.has(gap.roomId)) continue;
    targets.push({
      roomId: gap.roomId,
      label: gap.label,
      // A dead sensor edges out a room that never had one: somebody already
      // decided that space needed watching, and a battery is the cheaper fix.
      priority: BAND.standingGap + (gap.sensorNotReporting ? 0.5 : 0.25),
      gap,
      reason: gap.reason,
    });
  }

  return targets.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.roomId.localeCompare(b.roomId);
  });
}

/**
 * One-line summary of the gaps, for a banner. Returns null when fully covered
 * so callers can render nothing rather than a reassuring-but-noisy line.
 */
export function summarizeCoverage(coverage: CoverageReport): string | null {
  const count = coverage.unmonitored.length;
  if (count === 0) return null;
  const noun = count === 1 ? 'wet location' : 'wet locations';
  return `${count} ${noun} without a working water sensor.`;
}
