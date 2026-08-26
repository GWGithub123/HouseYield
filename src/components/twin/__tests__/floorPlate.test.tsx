/**
 * The plate exists for one job the elevation cannot do: show both sides of a
 * corridor at the same time. So the assertions are about completeness on a floor,
 * about not inventing a floor plan, and about the plan agreeing with the elevation
 * on where a given unit is.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import FloorPlate, { floorPlateScene } from '../FloorPlate';
import {
  DEFAULT_BUILDING_SPEC,
  buildBuilding,
  buildingCells,
  unitsOnLevel,
  type BuildingSpec,
} from '../buildingModel';
import { propagateLeak } from '../leakPropagation';

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  ...DEFAULT_BUILDING_SPEC,
  floors: 3,
  unitsPerFloor: 4,
  archetype: 'garden_walkup',
  ...over,
});

const draw = (
  building: ReturnType<typeof buildBuilding>,
  level: number,
  over: Partial<React.ComponentProps<typeof FloorPlate>> = {},
) => renderToStaticMarkup(
  <FloorPlate building={building} level={level} {...over} />,
);

describe('FloorPlate', () => {
  it('shows both sides of the corridor at once', () => {
    // The whole reason this view exists. A leak in a shared wall puts apartments
    // on both sides of the hall in scope, and the elevation can only draw one.
    const building = buildBuilding(spec({ unitsPerFloor: 2, corridor: 'double_loaded' }));
    const html = draw(building, 0);

    for (const label of ['301', '302', '303', '304']) {
      expect(html, label).toContain(`>${label}<`);
    }
    expect(html).toContain('CORRIDOR');
  });

  it('calls it a breezeway when there is only one row', () => {
    const html = draw(buildBuilding(spec({ corridor: 'none' })), 0);
    expect(html).toContain('BREEZEWAY');
    expect(html).not.toContain('>CORRIDOR<');
  });

  it('does not label a rear row that does not exist', () => {
    expect(draw(buildBuilding(spec({ corridor: 'none' })), 0)).not.toContain('>REAR<');
    expect(draw(buildBuilding(spec({ corridor: 'double_loaded' })), 0)).toContain('>REAR<');
  });

  it('says it is schematic, because a plan invites the opposite assumption', () => {
    // Unit depth, room layout, door positions and orientation are all unknown.
    const html = draw(buildBuilding(spec()), 0);
    expect(html).toContain('not surveyed');
  });

  it('draws only the storey asked for', () => {
    const building = buildBuilding(spec());
    const html = draw(building, 1);

    expect(html).toContain('>201<');
    expect(html).not.toContain('>301<');
    expect(html).not.toContain('>101<');
  });

  it('names the storey the way a person counts them', () => {
    const building = buildBuilding(spec({ floors: 3 }));
    // Band 0 is the top of a three-storey building, which is floor 3.
    expect(draw(building, 0)).toContain('FLOOR 3');
    expect(draw(building, 2)).toContain('FLOOR 1');
  });

  it('does not mirror the far row, unlike the elevation', () => {
    /*
     * A plan is seen from above, from one fixed direction, so there is no walking
     * around it. Carrying the elevation's mirror in here would put the same unit
     * in two different places in two views of the same floor.
     */
    const building = buildBuilding(spec({ unitsPerFloor: 4, corridor: 'double_loaded' }));
    const front = unitsOnLevel(building, 0).filter((unit) => unit.side === 'A');
    const rear = unitsOnLevel(building, 0).filter((unit) => unit.side === 'B');

    // In the elevation these have opposite x ordering by column.
    expect(front.find((u) => u.column === 0)!.x).toBeLessThan(front.find((u) => u.column === 3)!.x);
    expect(rear.find((u) => u.column === 0)!.x).toBeGreaterThan(rear.find((u) => u.column === 3)!.x);

    // In the plan, column 0 is leftmost for both rows, so 301 and 305 line up.
    const html = draw(building, 0);
    const x301 = Number(/<text x="([\d.]+)"[^>]*>301</.exec(html)?.[1]);
    const x305 = Number(/<text x="([\d.]+)"[^>]*>305</.exec(html)?.[1]);
    expect(x301).toBeCloseTo(x305, 5);
  });

  it('keeps observation and inference in different languages', () => {
    const building = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: true }));
    const exposures = propagateLeak({
      cells: buildingCells(building),
      sourceCellIds: ['u-A-0-1'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });

    const html = draw(building, 0, {
      exposures,
      alertUnits: new Set(['u-A-0-1']),
    });

    // Red fill for the unit that is reporting, dashed amber for the inference.
    expect(html).toContain('#ef4444');
    expect(html).toContain('stroke-dasharray="6 4"');
  });

  it('renders a resting floor with no leak and no callbacks', () => {
    const html = draw(buildBuilding(spec()), 0);
    expect(html).toContain('FLOOR 3');
    expect(html).not.toContain('#ef4444');
  });
});

describe('floorPlateScene', () => {
  it('grows a second row only when there is a second side', () => {
    const single = floorPlateScene(buildBuilding(spec({ corridor: 'none' })));
    const double = floorPlateScene(buildBuilding(spec({ corridor: 'double_loaded' })));

    expect(double.h).toBeGreaterThan(single.h);
    expect(double.w).toBe(single.w);
  });

  it('widens with the building, not with the floor count', () => {
    const wide = floorPlateScene(buildBuilding(spec({ unitsPerFloor: 12 })));
    const narrow = floorPlateScene(buildBuilding(spec({ unitsPerFloor: 4 })));
    const tall = floorPlateScene(buildBuilding(spec({ floors: 20 })));

    expect(wide.w).toBeGreaterThan(narrow.w);
    // A plan of one storey does not care how many storeys there are.
    expect(tall.h).toBe(narrow.h);
  });
});
