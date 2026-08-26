import { describe, it, expect } from 'vitest';
import {
  WET_FIXTURES,
  computeCoverage,
  fixtureLabel,
  isWetFixture,
  rankInspectionTargets,
  summarizeCoverage,
  wetFixturesIn,
  type CoveragePlacement,
} from '../coverageModel';
import { visibleRooms, type RoomDef } from '../houseModel';
import { propagateHouseLeak } from '../leakPropagation';

function room(id: string, fixtures: RoomDef['fixtures']): RoomDef {
  return {
    id,
    label: id.replace(/_/g, ' '),
    short: id,
    floor: 'main',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    fixtures,
  };
}

const flood = (roomId: string, reporting?: boolean): CoveragePlacement => ({
  roomId,
  kind: 'flood',
  ...(reporting === undefined ? {} : { reporting }),
});

describe('wet fixture classification', () => {
  it('counts plumbing and not furniture or mechanicals', () => {
    for (const kind of ['sink', 'tub', 'toilet', 'vanity', 'sump', 'water_heater', 'washer'] as const) {
      expect(isWetFixture(kind)).toBe(true);
    }
    for (const kind of ['bed', 'sofa', 'tv', 'table', 'door', 'stairs', 'counter', 'stove'] as const) {
      expect(isWetFixture(kind)).toBe(false);
    }
  });

  it('excludes the dryer, which has no supply, and the furnace and panel', () => {
    expect(isWetFixture('dryer')).toBe(false);
    expect(isWetFixture('furnace')).toBe(false);
    expect(isWetFixture('panel')).toBe(false);
  });

  it('excludes the fridge, since the drawn fixture does not record an ice line', () => {
    expect(isWetFixture('fridge')).toBe(false);
  });

  it('de-duplicates fixture kinds within a room but keeps drawing order', () => {
    const bath = room('bath', [
      { kind: 'tub', x: 0, y: 0 },
      { kind: 'toilet', x: 10, y: 0 },
      { kind: 'tub', x: 20, y: 0 },
      { kind: 'bed', x: 30, y: 0 },
    ]);
    expect(wetFixturesIn(bath)).toEqual(['tub', 'toilet']);
  });

  it('names every wet fixture in prose rather than by key', () => {
    for (const kind of WET_FIXTURES) {
      expect(fixtureLabel(kind)).not.toContain('_');
    }
    expect(fixtureLabel('water_heater')).toBe('water heater');
    expect(fixtureLabel('tub')).toBe('tub or shower');
  });
});

describe('coverage over the archetypal house', () => {
  const rooms = visibleRooms();

  it('counts only rooms with plumbing in the denominator', () => {
    const coverage = computeCoverage(rooms, []);
    const ids = coverage.locations.map((location) => location.roomId).sort();

    expect(ids).toEqual(['basement_open', 'bath_up', 'kitchen', 'laundry', 'utility']);
    // Bedrooms, living, dining, entry, attic and the yard are not part of the
    // question and must not dilute the ratio.
    expect(ids).not.toContain('bed_primary');
    expect(ids).not.toContain('living');
    expect(ids).not.toContain('yard');
  });

  it('reports a real fraction once sensors are placed', () => {
    const coverage = computeCoverage(rooms, [flood('bath_up'), flood('laundry')]);

    expect(coverage.totalCount).toBe(5);
    expect(coverage.monitoredCount).toBe(2);
    expect(coverage.ratio).toBeCloseTo(0.4, 5);
    expect(coverage.headline).toBe('2 of 5 wet locations in this layout monitored');
  });

  it('does not let a non-water sensor close a gap', () => {
    const coverage = computeCoverage(rooms, [
      { roomId: 'bath_up', kind: 'ht' },
      { roomId: 'utility', kind: 'gateway' },
      { roomId: 'laundry', kind: 'relay' },
    ]);

    expect(coverage.monitoredCount).toBe(0);
    expect(coverage.unmonitored).toHaveLength(5);
  });

  it('treats an offline sensor as a gap, and says why', () => {
    const coverage = computeCoverage(rooms, [flood('utility', false)]);
    const utility = coverage.locations.find((location) => location.roomId === 'utility');

    expect(utility?.monitored).toBe(false);
    expect(utility?.sensorNotReporting).toBe(true);
    expect(utility?.reason).toContain('not reporting');
  });

  it('separates never-had-a-sensor from has-a-dead-one', () => {
    const coverage = computeCoverage(rooms, [flood('utility', false)]);
    const kitchen = coverage.locations.find((location) => location.roomId === 'kitchen');

    expect(kitchen?.sensorNotReporting).toBe(false);
    expect(kitchen?.reason).toContain('no water sensor');
  });

  it('counts multiple reporting sensors in one room as one covered location', () => {
    const coverage = computeCoverage(rooms, [flood('laundry'), flood('laundry')]);
    const laundry = coverage.locations.find((location) => location.roomId === 'laundry');

    expect(laundry?.waterSensorCount).toBe(2);
    expect(coverage.monitoredCount).toBe(1);
  });

  it('names the fixtures it is worried about', () => {
    const coverage = computeCoverage(rooms, []);
    const bath = coverage.locations.find((location) => location.roomId === 'bath_up');
    const utility = coverage.locations.find((location) => location.roomId === 'utility');

    expect(bath?.reason).toContain('tub or shower');
    expect(bath?.reason).toContain('toilet');
    expect(utility?.reason).toContain('water heater');
  });

  it('is fully covered when every wet room has a live sensor', () => {
    const coverage = computeCoverage(
      rooms,
      ['bath_up', 'kitchen', 'utility', 'basement_open', 'laundry'].map((id) => flood(id)),
    );

    expect(coverage.ratio).toBe(1);
    expect(coverage.unmonitored).toEqual([]);
    expect(summarizeCoverage(coverage)).toBeNull();
  });

  it('summarizes gaps without asserting damage', () => {
    const coverage = computeCoverage(rooms, [flood('bath_up')]);
    const summary = summarizeCoverage(coverage);

    expect(summary).toBe('4 wet locations without a working water sensor.');
    expect(summary).not.toMatch(/damage|flood|wet floor/i);
  });

  it('handles a property with no plumbing at all without dividing by zero', () => {
    const coverage = computeCoverage([room('empty', [{ kind: 'bed', x: 0, y: 0 }])], []);

    expect(coverage.totalCount).toBe(0);
    expect(coverage.ratio).toBe(0);
    expect(coverage.headline).toBe('');
    expect(summarizeCoverage(coverage)).toBeNull();
  });

  it('drops the basement wet rooms for a condo, which has no basement', () => {
    const condo = visibleRooms({ address: '500 Main St Apt 4B' });
    const coverage = computeCoverage(condo, []);
    const ids = coverage.locations.map((location) => location.roomId);

    expect(ids).toContain('bath_up');
    expect(ids).not.toContain('utility');
    expect(ids).not.toContain('laundry');
  });
});

describe('inspection ranking', () => {
  const rooms = visibleRooms();

  it('puts an unmonitored room in the leak path above a monitored one', () => {
    // Leak in the upstairs bath. `living` sits directly below it; `dining`
    // catches the edge of the same span.
    const exposures = propagateHouseLeak(rooms, ['bath_up'], { minutesSinceDetection: 60 });
    const inPath = exposures.filter((e) => e.tier !== 'source').map((e) => e.cellId);
    expect(inPath).toContain('living');

    // Everything in the path is covered except `living`.
    const coverage = computeCoverage(
      rooms,
      ['bath_up', 'kitchen', 'utility', 'basement_open', 'laundry'].map((id) => flood(id)),
    );
    // `living` has no plumbing, so it is not a wet location and cannot be a gap.
    expect(coverage.unmonitored).toEqual([]);

    const targets = rankInspectionTargets(coverage, exposures);
    expect(targets[0]?.roomId).toBe('living');
  });

  it('ranks a blind spot in the leak path first, above stronger monitored claims', () => {
    const exposures = propagateHouseLeak(rooms, ['bath_up'], { minutesSinceDetection: 60 });
    // Only the bath is covered, so the basement wet rooms in the path are blind.
    const coverage = computeCoverage(rooms, [flood('bath_up')]);

    const targets = rankInspectionTargets(coverage, exposures);
    const first = targets[0];

    expect(first?.gap).toBeDefined();
    expect(first?.exposure).toBeDefined();
    expect(first?.reason).toContain('no working water sensor');

    // Every blind spot in the path outranks every merely-exposed room.
    const lastBlindInPath = targets.reduce(
      (last, target, index) => (target.gap && target.exposure ? index : last),
      -1,
    );
    const firstExposedOnly = targets.findIndex((target) => target.exposure && !target.gap);
    expect(firstExposedOnly).toBeGreaterThan(lastBlindInPath);
  });

  it('lists standing blind spots below anything the leak touches', () => {
    const exposures = propagateHouseLeak(rooms, ['bath_up'], { minutesSinceDetection: 60 });
    const coverage = computeCoverage(rooms, []);
    const targets = rankInspectionTargets(coverage, exposures);

    const exposedIndexes = targets
      .map((target, index) => (target.exposure ? index : -1))
      .filter((index) => index >= 0);
    const standingIndexes = targets
      .map((target, index) => (!target.exposure && target.gap ? index : -1))
      .filter((index) => index >= 0);

    expect(standingIndexes.length).toBeGreaterThan(0);
    expect(Math.min(...standingIndexes)).toBeGreaterThan(Math.max(...exposedIndexes));
  });

  it('puts a dead sensor above a room that never had one', () => {
    const coverage = computeCoverage(rooms, [flood('utility', false)]);
    const targets = rankInspectionTargets(coverage, []);

    const utility = targets.findIndex((target) => target.roomId === 'utility');
    const kitchen = targets.findIndex((target) => target.roomId === 'kitchen');

    expect(utility).toBeGreaterThanOrEqual(0);
    expect(utility).toBeLessThan(kitchen);
  });

  it('never lists a room twice', () => {
    const exposures = propagateHouseLeak(rooms, ['bath_up'], { minutesSinceDetection: 60 });
    const coverage = computeCoverage(rooms, []);
    const targets = rankInspectionTargets(coverage, exposures);
    const ids = targets.map((target) => target.roomId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('excludes the leaking room itself, which needs no inspection prompt', () => {
    const exposures = propagateHouseLeak(rooms, ['bath_up'], { minutesSinceDetection: 60 });
    const coverage = computeCoverage(rooms, [flood('bath_up')]);
    const targets = rankInspectionTargets(coverage, exposures);

    expect(targets.map((target) => target.roomId)).not.toContain('bath_up');
  });

  it('returns nothing when coverage is complete and no leak is running', () => {
    const coverage = computeCoverage(
      rooms,
      ['bath_up', 'kitchen', 'utility', 'basement_open', 'laundry'].map((id) => flood(id)),
    );
    expect(rankInspectionTargets(coverage, [])).toEqual([]);
  });
});
