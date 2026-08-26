import { describe, expect, it } from 'vitest';
import {
  BASEMENT_H,
  BUILDING_MARGIN_X,
  DEFAULT_BUILDING_SPEC,
  LEVEL_H,
  SIDE_LABEL,
  UNIT_W,
  buildBuilding,
  buildingCells,
  buildingLevels,
  buildingSceneAspect,
  oppositeSide,
  shouldDrawAsBuilding,
  sidesFor,
  specFromDerivation,
  unitById,
  unitsOnLevel,
  unitsOnSide,
  type BuildingSpec,
} from '../buildingModel';
import { propagateLeak } from '../leakPropagation';
import { isWetFixture } from '../coverageModel';

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  ...DEFAULT_BUILDING_SPEC,
  floors: 3,
  unitsPerFloor: 4,
  archetype: 'garden_walkup',
  ...over,
});

describe('level bands', () => {
  it('generates one band per storey, top to bottom', () => {
    const levels = buildingLevels(4);

    expect(levels).toHaveLength(4);
    expect(levels.map((level) => level.index)).toEqual([0, 1, 2, 3]);
    // Index order is the order water travels, so each band sits below the last.
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i].top).toBe(levels[i - 1].bottom);
    }
  });

  it('numbers storeys from the ground up, opposite to band order', () => {
    const levels = buildingLevels(4);
    expect(levels[0].label).toBe('Floor 4');
    expect(levels[3].label).toBe('Floor 1');
  });

  it('puts the basement last and marks it as holding no units', () => {
    const levels = buildingLevels(3, true);

    expect(levels).toHaveLength(4);
    expect(levels[3].kind).toBe('basement');
    expect(levels[3].bottom - levels[3].top).toBe(BASEMENT_H);
    expect(levels.filter((level) => level.kind === 'unit')).toHaveLength(3);
  });

  it('never generates a building with no floors', () => {
    expect(buildingLevels(0)).toHaveLength(1);
    expect(buildingLevels(-3)).toHaveLength(1);
  });
});

describe('buildBuilding', () => {
  it('generates one unit per column per floor for a single-sided building', () => {
    const building = buildBuilding(spec({ corridor: 'none' }));

    expect(building.sides).toEqual(['A']);
    expect(building.unitCount).toBe(12);
    expect(unitsOnLevel(building, 0)).toHaveLength(4);
  });

  it('doubles the units for a double-loaded corridor', () => {
    const building = buildBuilding(spec({ corridor: 'double_loaded' }));

    expect(building.sides).toEqual(['A', 'B']);
    expect(building.unitCount).toBe(24);
    expect(unitsOnSide(building, 'A')).toHaveLength(12);
    expect(unitsOnSide(building, 'B')).toHaveLength(12);
  });

  it('mirrors side B, because you walked around the building', () => {
    const building = buildBuilding(spec({ corridor: 'double_loaded' }));
    const level0 = (side: 'A' | 'B') => unitsOnLevel(building, 0)
      .filter((unit) => unit.side === side)
      .sort((a, b) => a.column - b.column);

    const a = level0('A');
    const b = level0('B');

    // Column 0 is drawn leftmost on side A and rightmost on side B.
    expect(a[0].x).toBeLessThan(a[3].x);
    expect(b[0].x).toBeGreaterThan(b[3].x);
    expect(b[0].x).toBe(a[3].x);
    expect(b[3].x).toBe(a[0].x);
  });

  it('numbers units by storey and position, continuing across the corridor', () => {
    const building = buildBuilding(spec({ floors: 3, unitsPerFloor: 2, corridor: 'double_loaded' }));
    const top = unitsOnLevel(building, 0);

    // Top of a three-storey building is floor 3.
    expect(top.every((unit) => unit.floorNumber === 3)).toBe(true);
    const labels = top.map((unit) => unit.label).sort();
    // Side A takes 301-302, side B continues with 303-304 rather than restarting.
    expect(labels).toEqual(['301', '302', '303', '304']);
  });

  it('gives every unit an id that is stable for a given spec', () => {
    const a = buildBuilding(spec());
    const b = buildBuilding(spec());

    // Device placements are stored against these ids, so a rebuild that renamed
    // them would silently move every sensor in the building.
    expect(a.units.map((unit) => unit.id)).toEqual(b.units.map((unit) => unit.id));
    expect(new Set(a.units.map((unit) => unit.id)).size).toBe(a.unitCount);
  });

  it('stacks units vertically into one riser per column, per side by default', () => {
    const building = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: false }));

    // 4 columns x 2 sides.
    expect(building.stacks).toHaveLength(8);
    for (const stack of building.stacks) {
      expect(stack.unitIds).toHaveLength(3);
      expect(stack.side).toBeDefined();
    }
  });

  it('joins the two sides into one riser per column when they share a wet wall', () => {
    const building = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: true }));

    expect(building.stacks).toHaveLength(4);
    for (const stack of building.stacks) {
      // Three floors on each of two sides.
      expect(stack.unitIds).toHaveLength(6);
      expect(stack.side).toBeUndefined();
    }
  });

  it('lists a stack from the top down, which is the direction water runs', () => {
    const building = buildBuilding(spec());
    const stack = building.stacks[0];
    const levels = stack.unitIds.map((id) => unitById(building, id)!.level);

    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it('gives every unit wet fixtures, so coverage has something to count', () => {
    const building = buildBuilding(spec());

    for (const unit of building.units) {
      expect(unit.fixtures.some((fixture) => isWetFixture(fixture.kind)), unit.id).toBe(true);
      // Fixtures have to stand inside their own unit or they draw through walls.
      for (const fixture of unit.fixtures) {
        expect(fixture.x, `${unit.id} ${fixture.kind}`).toBeGreaterThanOrEqual(unit.x);
        expect(fixture.x, `${unit.id} ${fixture.kind}`).toBeLessThanOrEqual(unit.x + unit.w);
      }
    }
  });

  it('sizes the scene to the building rather than to the house canvas', () => {
    const wide = buildBuilding(spec({ unitsPerFloor: 12 }));
    const narrow = buildBuilding(spec({ unitsPerFloor: 3 }));

    expect(wide.scene.w).toBeGreaterThan(narrow.scene.w);
    expect(wide.scene.w).toBeGreaterThan(BUILDING_MARGIN_X * 2 + 12 * UNIT_W - 1);

    const tall = buildBuilding(spec({ floors: 8 }));
    expect(tall.scene.h).toBeGreaterThan(wide.scene.h);
    expect(tall.scene.h - narrow.scene.h).toBeCloseTo(5 * LEVEL_H, 5);
  });

  it('frames a long facade to a readable slice rather than shrinking it to fit', () => {
    const long = buildBuilding(spec({ unitsPerFloor: 40 }));
    const short = buildBuilding(spec({ unitsPerFloor: 6 }));

    // A 40-unit facade squeezed into one screen would give each unit a few
    // pixels, so the default frame caps the columns in view and pans instead.
    expect(buildingSceneAspect(long)).toBeLessThan(long.scene.w / long.scene.h);
    // A short building already fits, so it is not cropped.
    expect(buildingSceneAspect(short)).toBeCloseTo(short.scene.w / short.scene.h, 5);
  });

  it('never builds a degenerate building from nonsense input', () => {
    const building = buildBuilding(spec({ floors: 0, unitsPerFloor: 0 }));

    expect(building.floors).toBe(1);
    expect(building.unitsPerFloor).toBe(1);
    expect(building.unitCount).toBe(1);
  });
});

describe('sides', () => {
  it('only offers a far side when there is a corridor to have one', () => {
    expect(sidesFor('none')).toEqual(['A']);
    expect(sidesFor('double_loaded')).toEqual(['A', 'B']);
  });

  it('disables the flip for a single-sided building instead of flipping to nothing', () => {
    const walkup = buildBuilding(spec({ corridor: 'none' }));
    expect(oppositeSide(walkup, 'A')).toBeNull();

    const midrise = buildBuilding(spec({ corridor: 'double_loaded' }));
    expect(oppositeSide(midrise, 'A')).toBe('B');
    expect(oppositeSide(midrise, 'B')).toBe('A');
  });

  it('labels facades relatively, since we do not know the orientation', () => {
    // A compass bearing would be a fact we invented.
    expect(SIDE_LABEL.A).not.toMatch(/north|south|east|west/i);
    expect(SIDE_LABEL.B).not.toMatch(/north|south|east|west/i);
  });
});

describe('specFromDerivation', () => {
  it('reads the server guess', () => {
    const result = specFromDerivation({
      archetype: 'midrise_corridor',
      floors: 5,
      unitsTotal: 40,
      unitsPerFloor: 8,
      corridor: 'double_loaded',
      confidence: 'high',
      needsConfirmation: false,
    });

    expect(result).toMatchObject({
      archetype: 'midrise_corridor',
      floors: 5,
      unitsPerFloor: 8,
      corridor: 'double_loaded',
      confidence: 'high',
      needsConfirmation: false,
    });
  });

  it('derives units per floor from the total when it is not given', () => {
    const result = specFromDerivation({ floors: 4, unitsTotal: 20 });
    expect(result.unitsPerFloor).toBe(5);
  });

  it('never seeds shared risers or a basement on', () => {
    // Both widen exposure claims, so they must come from a person.
    const result = specFromDerivation({
      archetype: 'midrise_corridor',
      floors: 6,
      unitsTotal: 60,
      confidence: 'high',
      needsConfirmation: false,
    });

    expect(result.sharedRisers).toBe(false);
    expect(result.hasBasement).toBe(false);
  });

  it('falls back to a correctable default rather than to nothing', () => {
    expect(specFromDerivation(null)).toEqual(DEFAULT_BUILDING_SPEC);
    expect(specFromDerivation(undefined).needsConfirmation).toBe(true);
  });

  it('requires confirmation unless the derivation was confident', () => {
    expect(specFromDerivation({ confidence: 'low' }).needsConfirmation).toBe(true);
    expect(specFromDerivation({ confidence: 'medium' }).needsConfirmation).toBe(true);
    expect(specFromDerivation({ confidence: 'high' }).needsConfirmation).toBe(false);
  });

  it('rejects an unrecognised archetype instead of trusting it', () => {
    expect(specFromDerivation({ archetype: 'castle' }).archetype).toBe('unknown');
  });

  it('does not let a bad floor count produce a zero-storey building', () => {
    expect(specFromDerivation({ floors: 0 }).floors).toBeGreaterThanOrEqual(1);
    expect(specFromDerivation({ floors: -2 }).floors).toBeGreaterThanOrEqual(1);
  });
});

describe('shouldDrawAsBuilding', () => {
  it('keeps houses and lone condo units on the oblique cutaway', () => {
    // A house has no stacked units; a single condo unit has neighbours we know
    // nothing about, so drawing either as a building means inventing units.
    expect(shouldDrawAsBuilding(spec({ archetype: 'single_family' }))).toBe(false);
    expect(shouldDrawAsBuilding(spec({ archetype: 'condo_unit' }))).toBe(false);
  });

  it('draws duplexes, walk-ups and midrises as buildings', () => {
    expect(shouldDrawAsBuilding(spec({ archetype: 'duplex', floors: 2, unitsPerFloor: 1 }))).toBe(true);
    expect(shouldDrawAsBuilding(spec({ archetype: 'garden_walkup' }))).toBe(true);
    expect(shouldDrawAsBuilding(spec({ archetype: 'midrise_corridor' }))).toBe(true);
  });

  it('will not invent a building from an unknown archetype', () => {
    // Unknown is "we could not tell", not "draw a walk-up".
    expect(shouldDrawAsBuilding(spec({ archetype: 'unknown', floors: 3, unitsPerFloor: 4 }))).toBe(false);
    expect(shouldDrawAsBuilding(spec({ archetype: 'unknown', floors: 1, unitsPerFloor: 1 }))).toBe(false);
  });

  it('believes a confirmed plan even when the archetype was never classified', () => {
    /*
     * Manual entry is the primary source of truth. Someone who typed four floors
     * of twelve units is describing a building; refusing to draw one because our
     * classifier had no opinion would be us overruling the only person who knows.
     */
    const typed = spec({ archetype: 'unknown', floors: 4, unitsPerFloor: 12 });
    expect(shouldDrawAsBuilding(typed, true)).toBe(true);
    expect(shouldDrawAsBuilding(typed, false)).toBe(false);
  });

  it('still keeps a confirmed single-family on the house cutaway', () => {
    // The house veto is about which drawing serves the property, not about
    // doubting the numbers, so confirmation does not override it.
    expect(shouldDrawAsBuilding(spec({ archetype: 'single_family', floors: 3 }), true)).toBe(false);
    expect(shouldDrawAsBuilding(spec({ archetype: 'condo_unit', floors: 8 }), true)).toBe(false);
  });

  it('does not draw a building for one unit on one floor, however confirmed', () => {
    expect(shouldDrawAsBuilding(spec({ archetype: 'unknown', floors: 1, unitsPerFloor: 1 }), true)).toBe(false);
  });
});

describe('buildingCells', () => {
  it('feeds units straight into the propagation engine', () => {
    const building = buildBuilding(spec({ floors: 3, unitsPerFloor: 4, corridor: 'none' }));
    const cells = buildingCells(building);
    const top = building.units.find((unit) => unit.level === 0 && unit.column === 1)!;

    const exposures = propagateLeak({
      cells,
      sourceCellIds: [top.id],
      valveState: 'open',
      minutesSinceDetection: 90,
    });

    const below = building.units.filter((unit) => unit.column === 1 && unit.level > 0);
    for (const unit of below) {
      const hit = exposures.find((exposure) => exposure.cellId === unit.id);
      expect(hit, unit.id).toBeDefined();
      expect(hit!.tier === 'direct' || hit!.tier === 'stack').toBe(true);
    }
  });

  it('includes the far side even though only one side is drawn', () => {
    // The cross-side badge exists because the engine was given units the viewer
    // cannot currently see. Filtering to the visible side would make the flip
    // hide real exposure.
    const building = buildBuilding(spec({ corridor: 'double_loaded' }));
    const cells = buildingCells(building);

    expect(cells.filter((cell) => cell.side === 'A').length).toBeGreaterThan(0);
    expect(cells.filter((cell) => cell.side === 'B').length).toBeGreaterThan(0);
  });

  it('reaches across the corridor only when the risers are shared', () => {
    const source = (b: ReturnType<typeof buildBuilding>) =>
      b.units.find((unit) => unit.side === 'A' && unit.level === 0 && unit.column === 0)!;

    const separate = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: false }));
    const shared = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: true }));

    const exposedSides = (b: ReturnType<typeof buildBuilding>) => {
      const exposures = propagateLeak({
        cells: buildingCells(b),
        sourceCellIds: [source(b).id],
        valveState: 'open',
        minutesSinceDetection: 90,
      });
      return new Set(
        exposures
          .filter((exposure) => exposure.tier !== 'source')
          .map((exposure) => unitById(b, exposure.cellId)?.side)
          .filter(Boolean),
      );
    };

    // Without a shared wet wall, a leak stays on its own facade's risers.
    expect(exposedSides(separate).has('B')).toBe(false);
    // With one, the units back-to-back across the corridor come into scope.
    expect(exposedSides(shared).has('B')).toBe(true);
  });

  it('gives a ground-floor leak somewhere to go when there is a basement', () => {
    const building = buildBuilding(spec({ floors: 2, unitsPerFloor: 2, hasBasement: true }));
    const cells = buildingCells(building);
    const ground = building.units.find((unit) => unit.level === 1)!;

    const exposures = propagateLeak({
      cells,
      sourceCellIds: [ground.id],
      valveState: 'open',
      minutesSinceDetection: 90,
    });

    expect(exposures.some((exposure) => exposure.cellId === 'basement')).toBe(true);
  });

  it('has nothing below the lowest level when there is no basement', () => {
    const building = buildBuilding(spec({ floors: 2, unitsPerFloor: 2, hasBasement: false }));
    const ground = building.units.find((unit) => unit.level === 1)!;

    const exposures = propagateLeak({
      cells: buildingCells(building),
      sourceCellIds: [ground.id],
      valveState: 'open',
      minutesSinceDetection: 90,
    });

    // Only lateral neighbours on the same floor, nothing beneath.
    expect(exposures.every((exposure) => exposure.levelsBelow === 0)).toBe(true);
  });

  it('names cells the way a person names units, for the reason sentences', () => {
    const building = buildBuilding(spec());
    const cells = buildingCells(building);

    for (const cell of cells) {
      if (cell.id === 'basement') continue;
      expect(cell.label).toMatch(/^Unit \d+$/);
    }
  });
});
