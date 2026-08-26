import { describe, it, expect } from 'vitest';
import {
  HOUSE_LEVEL_ORDER,
  cellsBeside,
  cellsBelow,
  exposureProgression,
  houseCells,
  houseLevelOf,
  propagateHouseLeak,
  propagateLeak,
  spanOverlapCenter,
  spanOverlapFraction,
  summarizeExposure,
  type PropagationCell,
} from '../leakPropagation';
import { visibleRooms } from '../houseModel';

/**
 * A three-storey building, two units per floor, side by side. Unit ids read
 * `<level><slot>`, so `0a` is top-left. Stacks run vertically through slot.
 */
function testTower(): PropagationCell[] {
  const cells: PropagationCell[] = [];
  for (let level = 0; level < 3; level += 1) {
    cells.push({ id: `${level}a`, level, x: 0, w: 100, stackId: 'a', label: `Unit ${level}A` });
    cells.push({ id: `${level}b`, level, x: 100, w: 100, stackId: 'b', label: `Unit ${level}B` });
  }
  return cells;
}

const idsOf = <T extends { cellId: string }>(exposures: T[]) =>
  exposures.map((e) => e.cellId).sort();
const find = <T extends { cellId: string }>(exposures: T[], id: string) =>
  exposures.find((e) => e.cellId === id);

/**
 * A double-loaded corridor draws both facades over the same horizontal range,
 * so `x` alone cannot distinguish "the unit below" from "the unit across the
 * hall". Without the side rule the engine concluded that a front unit was
 * directly above a rear one, which is a confident claim about the wrong
 * apartment — the single worst failure this model can have.
 */
describe('corridor sides', () => {
  /** Two facades over the same x range, one column, two levels. */
  const corridor = (stackIds?: { a: string; b: string }): PropagationCell[] => [
    { id: 'a0', level: 0, x: 0, w: 100, side: 'A', label: 'Unit 201', stackId: stackIds?.a },
    { id: 'b0', level: 0, x: 0, w: 100, side: 'B', label: 'Unit 202', stackId: stackIds?.b },
    { id: 'a1', level: 1, x: 0, w: 100, side: 'A', label: 'Unit 101', stackId: stackIds?.a },
    { id: 'b1', level: 1, x: 0, w: 100, side: 'B', label: 'Unit 102', stackId: stackIds?.b },
  ];

  it('does not treat the far facade as being below the near one', () => {
    const cells = corridor();
    const source = cells.find((c) => c.id === 'a0')!;

    expect(idsOf(cellsBelow(cells, source).map((c) => ({ cellId: c.id })))).toEqual(['a1']);
  });

  it('does not treat the far facade as adjoining across the corridor', () => {
    const cells = corridor();
    const source = cells.find((c) => c.id === 'a0')!;

    expect(cellsBeside(cells, source)).toEqual([]);
  });

  it('keeps a leak on its own facade when the risers are separate', () => {
    const exposures = propagateLeak({
      cells: corridor({ a: 'riser-a', b: 'riser-b' }),
      sourceCellIds: ['a0'],
      valveState: 'open',
      minutesSinceDetection: 90,
    });

    expect(idsOf(exposures)).toEqual(['a0', 'a1']);
  });

  it('crosses the corridor on the same floor when the two share a wet wall', () => {
    // The pipe is *in* the wall between them, so a failure in it is on both
    // sides of it at once.
    const exposures = propagateLeak({
      cells: corridor({ a: 'riser-0', b: 'riser-0' }),
      sourceCellIds: ['a0'],
      valveState: 'open',
      minutesSinceDetection: 90,
    });

    expect(idsOf(exposures)).toEqual(['a0', 'a1', 'b0', 'b1']);
    expect(find(exposures, 'b0')?.tier).toBe('lateral');
  });

  it('says which side it crossed to, in the reason', () => {
    const exposures = propagateLeak({
      cells: corridor({ a: 'riser-0', b: 'riser-0' }),
      sourceCellIds: ['a0'],
      valveState: 'open',
      minutesSinceDetection: 90,
    });

    expect(find(exposures, 'b1')?.reason).toContain('opposite side of the corridor');
  });

  it('lets a sideless cell sit under both facades, which a basement does', () => {
    const cells: PropagationCell[] = [
      ...corridor(),
      { id: 'basement', level: 2, x: 0, w: 100, label: 'Basement' },
    ];

    for (const id of ['a1', 'b1']) {
      const source = cells.find((c) => c.id === id)!;
      expect(idsOf(cellsBelow(cells, source).map((c) => ({ cellId: c.id })))).toEqual(['basement']);
    }
  });
});

describe('exposure provenance', () => {
  it('names the leaking cell every claim came from', () => {
    const exposures = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      minutesSinceDetection: 90,
    });

    for (const exposure of exposures) {
      if (exposure.tier === 'source') {
        // The source *is* the leak; pointing it at itself would be noise.
        expect(exposure.sourceCellId).toBeUndefined();
      } else {
        expect(exposure.sourceCellId, exposure.cellId).toBe('0a');
      }
    }
  });

  it('attributes each claim to whichever leak produced it', () => {
    const exposures = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a', '0b'],
      minutesSinceDetection: 90,
    });

    // `1a` sits under `0a` and `1b` under `0b`, so each is attributed to the
    // leak directly above it rather than to whichever was processed first.
    expect(find(exposures, '1a')?.sourceCellId).toBe('0a');
    expect(find(exposures, '1b')?.sourceCellId).toBe('0b');
  });
});

describe('span geometry', () => {
  it('measures overlap against the narrower span', () => {
    expect(spanOverlapFraction({ x: 0, w: 100 }, { x: 0, w: 100 })).toBe(1);
    expect(spanOverlapFraction({ x: 0, w: 100 }, { x: 50, w: 100 })).toBeCloseTo(0.5, 5);
    // A narrow room fully under a wide one is fully exposed, not 25% exposed.
    expect(spanOverlapFraction({ x: 0, w: 200 }, { x: 50, w: 50 })).toBe(1);
  });

  it('reports no overlap for disjoint spans', () => {
    expect(spanOverlapFraction({ x: 0, w: 100 }, { x: 100, w: 100 })).toBe(0);
    expect(spanOverlapFraction({ x: 0, w: 10 }, { x: 500, w: 10 })).toBe(0);
  });

  it('centres the crossing point on the shared footprint', () => {
    // Fully aligned: water crosses in the middle.
    expect(spanOverlapCenter({ x: 0, w: 100 }, { x: 0, w: 100 })).toBe(50);
    // Half-lapped: it crosses in the middle of the lap, not of either room.
    expect(spanOverlapCenter({ x: 0, w: 100 }, { x: 50, w: 100 })).toBe(75);
    // A narrow room under a wide one: the whole narrow room is the footprint.
    expect(spanOverlapCenter({ x: 0, w: 200 }, { x: 40, w: 20 })).toBe(50);
  });

  it('falls back to the target centre when the spans do not overlap', () => {
    // The stack case: water arrives via a riser, so there is no shared
    // footprint to point at and the mark belongs in the middle of the space.
    expect(spanOverlapCenter({ x: 0, w: 100 }, { x: 300, w: 80 })).toBe(340);
  });

  it('finds only the level immediately below, and only where spans overlap', () => {
    const cells = testTower();
    const source = cells.find((c) => c.id === '0a')!;
    expect(idsOf(cellsBelow(cells, source).map((c) => ({ cellId: c.id })))).toEqual(['1a']);
  });

  it('treats touching spans on the same level as neighbours', () => {
    const cells = testTower();
    const source = cells.find((c) => c.id === '0a')!;
    expect(cellsBeside(cells, source).map((c) => c.id)).toEqual(['0b']);
  });
});

describe('leak propagation tiers', () => {
  it('returns nothing when the source is unknown', () => {
    expect(propagateLeak({ cells: testTower(), sourceCellIds: ['nope'] })).toEqual([]);
    expect(propagateLeak({ cells: testTower(), sourceCellIds: [] })).toEqual([]);
  });

  it('tags the leaking cell as the source with full likelihood', () => {
    const result = propagateLeak({ cells: testTower(), sourceCellIds: ['0a'] });
    const source = find(result, '0a')!;
    expect(source.tier).toBe('source');
    expect(source.likelihood).toBe(1);
    expect(source.reason).toContain('Water detected');
  });

  it('cascades downward through every level beneath the leak', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    expect(find(result, '1a')!.tier).toBe('direct');
    expect(find(result, '2a')!.tier).toBe('direct');
    expect(find(result, '1a')!.levelsBelow).toBe(1);
    expect(find(result, '2a')!.levelsBelow).toBe(2);
  });

  it('weakens with distance so the nearest space is inspected first', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });
    expect(find(result, '1a')!.likelihood).toBeGreaterThan(find(result, '2a')!.likelihood);
  });

  it('never flags anything above the leak', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['2a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });
    expect(idsOf(result)).toEqual(['2a', '2b']);
  });

  it('reaches down a shared stack without needing vertical overlap', () => {
    // `far` sits on the opposite side and overlaps nothing, but shares the riser.
    const cells: PropagationCell[] = [
      { id: 'top', level: 0, x: 0, w: 50, stackId: 'riser', label: 'Unit 301' },
      { id: 'far', level: 1, x: 400, w: 50, stackId: 'riser', label: 'Unit 205', side: 'B' },
    ];
    const result = propagateLeak({
      cells,
      sourceCellIds: ['top'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    const far = find(result, 'far')!;
    expect(far.tier).toBe('stack');
    expect(far.reason).toContain('shares a plumbing stack');
  });

  it('mentions the corridor when a stack crosses to the other side', () => {
    const cells: PropagationCell[] = [
      { id: 'top', level: 0, x: 0, w: 50, stackId: 'riser', label: 'Unit 301', side: 'A' },
      { id: 'far', level: 1, x: 400, w: 50, stackId: 'riser', label: 'Unit 205', side: 'B' },
    ];
    const result = propagateLeak({ cells, sourceCellIds: ['top'], valveState: 'open' });
    expect(find(result, 'far')!.reason).toContain('opposite side of the corridor');
  });

  it('prefers the stronger route when a cell is reachable two ways', () => {
    // `below` is both directly beneath the source and on its stack; direct wins.
    const cells: PropagationCell[] = [
      { id: 'src', level: 0, x: 0, w: 100, stackId: 's' },
      { id: 'below', level: 1, x: 0, w: 100, stackId: 's' },
    ];
    const result = propagateLeak({
      cells,
      sourceCellIds: ['src'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });
    expect(result.filter((e) => e.cellId === 'below')).toHaveLength(1);
    expect(find(result, 'below')!.tier).toBe('direct');
  });

  it('flags the adjoining space on the same level as lateral spread', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });
    const beside = find(result, '0b')!;
    expect(beside.tier).toBe('lateral');
    expect(beside.levelsBelow).toBe(0);
    expect(beside.reason).toContain('adjoins');
  });

  it('does not downgrade a second leaking cell into an exposure', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a', '0b'],
      valveState: 'open',
    });
    expect(find(result, '0a')!.tier).toBe('source');
    expect(find(result, '0b')!.tier).toBe('source');
  });
});

describe('valve and elapsed-time modifiers', () => {
  it('shrinks exposure when the supply has been shut off', () => {
    const open = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });
    const closed = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'closed',
      minutesSinceDetection: 120,
    });

    expect(find(closed, '1a')!.likelihood).toBeLessThan(find(open, '1a')!.likelihood);
  });

  it('treats an unknown valve as worse than closed and better than open', () => {
    const likelihoodFor = (valveState: 'open' | 'closed' | 'unknown') =>
      find(
        propagateLeak({
          cells: testTower(),
          sourceCellIds: ['0a'],
          valveState,
          minutesSinceDetection: 120,
        }),
        '1a',
      )!.likelihood;

    expect(likelihoodFor('closed')).toBeLessThan(likelihoodFor('unknown'));
    expect(likelihoodFor('unknown')).toBeLessThan(likelihoodFor('open'));
  });

  it('grows exposure the longer a leak has been running', () => {
    const at = (minutes: number) =>
      find(
        propagateLeak({
          cells: testTower(),
          sourceCellIds: ['0a'],
          valveState: 'open',
          minutesSinceDetection: minutes,
        }),
        '1a',
      )!.likelihood;

    expect(at(0)).toBeLessThan(at(30));
    expect(at(30)).toBeLessThan(at(60));
  });

  it('stops growing once the floor assembly is saturated', () => {
    const at = (minutes: number) =>
      find(
        propagateLeak({
          cells: testTower(),
          sourceCellIds: ['0a'],
          valveState: 'open',
          minutesSinceDetection: minutes,
        }),
        '1a',
      )!.likelihood;

    expect(at(60)).toBe(at(600));
  });

  it('drops exposures under the reporting threshold rather than flagging everything', () => {
    const permissive = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
      minLikelihood: 0,
    });
    const strict = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
      minLikelihood: 0.9,
    });

    expect(strict.length).toBeLessThan(permissive.length);
    // The source is an observation, not an inference, so it always survives.
    expect(idsOf(strict)).toEqual(['0a']);
  });
});

describe('every exposure states its basis', () => {
  it('carries a non-empty reason sentence', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    for (const exposure of result) {
      expect(exposure.reason.trim().length).toBeGreaterThan(0);
      expect(exposure.reason.trim().endsWith('.')).toBe(true);
    }
  });

  it('says "possible exposure - inspect" on inferences and never on the observation', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    for (const exposure of result) {
      if (exposure.tier === 'source') {
        expect(exposure.reason).not.toContain('Possible exposure');
      } else {
        expect(exposure.reason).toContain('Possible exposure - inspect');
      }
    }
  });

  it('never asserts that a space is wet, flooded or damaged', () => {
    const result = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    const inferred = result.filter((e) => e.tier !== 'source');
    expect(inferred.length).toBeGreaterThan(0);
    for (const exposure of inferred) {
      expect(exposure.reason).not.toMatch(/\b(is wet|flooded|damaged|destroyed)\b/i);
    }
  });

  it('summarises without asserting damage, and stays silent when nothing spread', () => {
    const spread = propagateLeak({
      cells: testTower(),
      sourceCellIds: ['0a'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });
    const summary = summarizeExposure(spread)!;
    expect(summary).toContain('may have been exposed');

    const contained = propagateLeak({
      cells: [{ id: 'only', level: 0, x: 0, w: 100 }],
      sourceCellIds: ['only'],
    });
    expect(summarizeExposure(contained)).toBeNull();
  });
});

describe('exposure progression over elapsed time', () => {
  const input = { cells: testTower(), sourceCellIds: ['0a'], valveState: 'open' as const };

  it('never shrinks as time passes', () => {
    const points = exposureProgression(input, 0);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].count).toBeGreaterThanOrEqual(points[i - 1].count);
    }
  });

  it('marks only the checkpoints the leak has actually reached', () => {
    const points = exposureProgression(input, 30);
    expect(points.filter((p) => p.reached).map((p) => p.minutes)).toEqual([0, 15, 30]);
    expect(points.filter((p) => !p.reached).map((p) => p.minutes)).toEqual([60]);
  });

  it('treats a missing elapsed time as nothing yet observed', () => {
    const points = exposureProgression(input, undefined);
    expect(points.filter((p) => p.reached).map((p) => p.minutes)).toEqual([0]);
  });

  it('honours custom checkpoints', () => {
    expect(exposureProgression(input, 0, [5, 90]).map((p) => p.minutes)).toEqual([5, 90]);
  });
});

describe('the house is a one-unit building', () => {
  it('orders levels the way water travels', () => {
    expect(HOUSE_LEVEL_ORDER).toEqual(['attic', 'upper', 'main', 'basement']);
    expect(houseLevelOf('upper')!).toBeLessThan(houseLevelOf('main')!);
    expect(houseLevelOf('main')!).toBeLessThan(houseLevelOf('basement')!);
  });

  it('excludes the yard, which is not below anything', () => {
    expect(houseLevelOf('exterior')).toBeNull();
    const cells = houseCells(visibleRooms({ address: '1 Test St' }));
    expect(cells.find((c) => c.id === 'yard')).toBeUndefined();
  });

  it('keeps room geometry so flags line up with the section', () => {
    const rooms = visibleRooms({ address: '1 Test St' });
    const cells = houseCells(rooms);
    const kitchenRoom = rooms.find((r) => r.id === 'kitchen')!;
    const kitchenCell = cells.find((c) => c.id === 'kitchen')!;

    expect(kitchenCell.x).toBe(kitchenRoom.x);
    expect(kitchenCell.w).toBe(kitchenRoom.w);
    expect(kitchenCell.label).toBe(kitchenRoom.label);
  });

  it('carries an upstairs bath leak down into the rooms beneath it', () => {
    const rooms = visibleRooms({ address: '1 Test St' });
    const result = propagateHouseLeak(rooms, ['bath_up'], {
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    const flagged = idsOf(result);
    expect(flagged).toContain('bath_up');
    // The upstairs bath spans the middle of the house, over living and dining.
    const belowIds = result
      .filter((e) => e.tier === 'direct' && e.levelsBelow === 1)
      .map((e) => e.cellId);
    expect(belowIds.length).toBeGreaterThan(0);
    for (const id of belowIds) {
      expect(rooms.find((r) => r.id === id)!.floor).toBe('main');
    }
  });

  it('reaches the basement from an upstairs leak', () => {
    const rooms = visibleRooms({ address: '1 Test St' });
    const result = propagateHouseLeak(rooms, ['bath_up'], {
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    const basementFlags = result.filter(
      (e) => e.tier !== 'source' && rooms.find((r) => r.id === e.cellId)?.floor === 'basement',
    );
    expect(basementFlags.length).toBeGreaterThan(0);
  });

  it('does not send a basement leak upstairs', () => {
    const rooms = visibleRooms({ address: '1 Test St' });
    const result = propagateHouseLeak(rooms, ['utility'], {
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    for (const exposure of result) {
      const floor = rooms.find((r) => r.id === exposure.cellId)!.floor;
      expect(floor).toBe('basement');
    }
  });
});
