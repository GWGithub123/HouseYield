/**
 * The building elevation's job is to be *complete*: a manager decides which
 * apartments to knock on from it. So these assertions are mostly about what the
 * drawing must never omit — the far side's exposure, the basement, the unit
 * numbers — rather than about how it looks. Appearance is covered by the preview
 * harness, which produces SVGs a human looks at.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import BuildingCutaway, { buildingCutawayScene } from '../BuildingCutaway';
import {
  DEFAULT_BUILDING_SPEC,
  buildBuilding,
  buildingCells,
  explodeOffset,
  explodedScene,
  type BuildingSide,
  type BuildingSpec,
} from '../buildingModel';
import { propagateLeak, type LeakExposure } from '../leakPropagation';

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  ...DEFAULT_BUILDING_SPEC,
  floors: 3,
  unitsPerFloor: 4,
  archetype: 'garden_walkup',
  ...over,
});

function draw(
  building: ReturnType<typeof buildBuilding>,
  side: BuildingSide,
  over: {
    exposures?: LeakExposure[];
    alertUnits?: Set<string>;
    coverageGaps?: Set<string>;
    onFlip?: () => void;
  } = {},
): string {
  return renderToStaticMarkup(
    <BuildingCutaway
      building={building}
      side={side}
      exposures={over.exposures}
      alertUnits={over.alertUnits}
      coverageGaps={over.coverageGaps}
      onFlip={over.onFlip ?? (() => {})}
    />,
  );
}

const leakIn = (building: ReturnType<typeof buildBuilding>, unitId: string) =>
  propagateLeak({
    cells: buildingCells(building),
    sourceCellIds: [unitId],
    valveState: 'open',
    minutesSinceDetection: 120,
  });

describe('BuildingCutaway', () => {
  it('renders every unit on the facade, labelled the way a door is', () => {
    const html = draw(buildBuilding(spec()), 'A');

    for (const label of ['301', '302', '303', '304', '201', '101', '104']) {
      expect(html, label).toContain(`>${label}<`);
    }
  });

  it('draws only the facade being looked at', () => {
    const building = buildBuilding(spec({ corridor: 'double_loaded' }));
    const front = draw(building, 'A');

    // Rear units are 305-308 on the top floor; they are behind the corridor.
    expect(front).toContain('>301<');
    expect(front).not.toContain('>305<');

    const rear = draw(building, 'B');
    expect(rear).toContain('>305<');
    expect(rear).not.toContain('>301<');
  });

  it('names the facade relatively rather than by compass bearing', () => {
    expect(draw(buildBuilding(spec()), 'A')).toContain('FRONT ELEVATION');
    expect(draw(buildBuilding(spec({ corridor: 'double_loaded' })), 'B'))
      .toContain('REAR ELEVATION');
  });
});

describe('cross-side exposure', () => {
  it('reports exposure on the facade it cannot show', () => {
    // This is the entire reason the engine is fed both sides. Without it the
    // flip would hide real exposure, and a safety view whose information depends
    // on which way you happen to be looking is worse than no view.
    const building = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: true }));
    const exposures = leakIn(building, 'u-A-0-1');

    const rear = draw(building, 'B', { exposures });
    expect(rear).toContain('exposed on front elevation');
  });

  it('says nothing when the far side is clear', () => {
    const building = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: false }));
    const exposures = leakIn(building, 'u-A-0-1');

    // Separate risers keep the leak on its own facade, so there is nothing to
    // flip to and no badge to draw.
    expect(draw(building, 'A', { exposures })).not.toContain('exposed on');
  });

  it('offers no flip at all for a single-sided building', () => {
    const walkup = buildBuilding(spec({ corridor: 'none' }));
    const html = draw(walkup, 'A', { exposures: leakIn(walkup, 'u-A-0-1') });

    expect(html).not.toContain('exposed on');
    // No far side exists, so nothing may hint at one. A walk-up is a single row
    // of units off an exterior breezeway; offering a flip would be offering to
    // show apartments that are not there.
    expect(html).not.toContain('rear elevation');
    expect(html).not.toContain('corridor');
  });

  it('counts exposed units without counting the leak itself', () => {
    const building = buildBuilding(spec({
      floors: 3,
      unitsPerFloor: 2,
      corridor: 'double_loaded',
      sharedRisers: true,
    }));
    const exposures = leakIn(building, 'u-A-0-0');
    const farExposed = building.units.filter((unit) => {
      if (unit.side !== 'B') return false;
      const hit = exposures.find((exposure) => exposure.cellId === unit.id);
      return hit != null && hit.tier !== 'source';
    }).length;

    expect(farExposed).toBeGreaterThan(0);
    expect(draw(building, 'A', { exposures })).toContain(`${farExposed} exposed on rear`);
  });
});

describe('completeness', () => {
  it('draws the basement, which the engine can flag', () => {
    const building = buildBuilding(spec({ hasBasement: true }));
    // A space the model flags but the drawing omits is exposure nobody sees.
    expect(draw(building, 'A')).toContain('BASEMENT');
  });

  it('omits the basement when the building has none', () => {
    expect(draw(buildBuilding(spec({ hasBasement: false })), 'A')).not.toContain('BASEMENT');
  });

  it('says how many units are on the side you cannot see', () => {
    const building = buildBuilding(spec({ floors: 4, unitsPerFloor: 6, corridor: 'double_loaded' }));
    // The drawing genuinely cannot show this, so it is stated.
    expect(draw(building, 'A')).toContain('24 more on the rear elevation');
  });

  it('discloses shared risers, because they widen every exposure claim', () => {
    const shared = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: true }));
    const separate = buildBuilding(spec({ corridor: 'double_loaded', sharedRisers: false }));

    expect(draw(shared, 'A')).toContain('risers shared across the corridor');
    expect(draw(separate, 'A')).not.toContain('risers shared');
  });
});

describe('exploded view', () => {
  const building = buildBuilding(spec({ hasBasement: true }));

  const exploded = () => renderToStaticMarkup(
    <BuildingCutaway building={building} side="A" mode="exploded" />,
  );

  it('is taller than the section, so the gaps have somewhere to go', () => {
    expect(explodedScene(building).h).toBeGreaterThan(building.scene.h);
    expect(explodedScene(building).w).toBe(building.scene.w);
  });

  it('leaves the top floor where it was and moves each one below it further', () => {
    expect(explodeOffset(0)).toBe(0);
    expect(explodeOffset(2)).toBe(explodeOffset(1) * 2);
  });

  it('reports the taller extent for the caller to frame', () => {
    // The component is a <g>, so it cannot frame itself. Framing the exploded
    // drawing with the sectioned extent clamps the camera above the lowest floor
    // and quietly makes the basement unreachable.
    expect(buildingCutawayScene(building, 'exploded')).toEqual(explodedScene(building));
    expect(buildingCutawayScene(building, 'section')).toEqual(building.scene);
  });

  it('still draws everything the section does', () => {
    const html = exploded();
    expect(html).toContain('BASEMENT');
    expect(html).toContain('>301<');
    expect(html).toContain('>101<');
  });

  it('changes nothing about the model, only where things are drawn', () => {
    const section = renderToStaticMarkup(
      <BuildingCutaway building={building} side="A" mode="section" />,
    );
    const labels = (html: string) => (html.match(/>\d{3}</g) ?? []).sort();
    expect(labels(exploded())).toEqual(labels(section));
  });
});

describe('claim language', () => {
  it('captions only the units worth starting with', () => {
    const building = buildBuilding(spec({ floors: 5, unitsPerFloor: 3 }));
    const exposures = leakIn(building, 'u-A-0-1');
    const html = draw(building, 'A', { exposures });

    const captions = html.match(/INSPECT/g)?.length ?? 0;
    const exposed = exposures.filter((exposure) => exposure.tier !== 'source').length;

    // Graded, so the drawing says where to start. Captioning every flagged unit
    // tells the reader to check the whole building, which is what they were
    // going to do anyway.
    expect(captions).toBeGreaterThan(0);
    expect(captions).toBeLessThan(exposed);
  });

  it('does not caption a unit that is actually reporting water', () => {
    // An alert is an observation and fills; an exposure is an inference and gets
    // patches. A unit that is both must read as the observation.
    const building = buildBuilding(spec());
    const exposures = leakIn(building, 'u-A-0-1');
    const html = draw(building, 'A', {
      exposures,
      alertUnits: new Set(['u-A-0-1', 'u-A-1-1']),
    });

    expect(html).toContain('#dc2626');
    // The alerting downstream unit keeps the alert treatment, so there are fewer
    // captions than there would be without it.
    const withoutAlert = draw(building, 'A', { exposures });
    expect((html.match(/INSPECT/g)?.length ?? 0))
      .toBeLessThan(withoutAlert.match(/INSPECT/g)?.length ?? 0);
  });

  it('draws the route as a chain, not as spokes from the leak', () => {
    /*
     * A leak three floors up has to draw a drip between every adjacent pair on the
     * way down. An earlier version drew leak-to-target segments, so the unit two
     * floors down had its source two levels away, no adjacent pair to draw, and
     * the water appeared to skip a storey.
     */
    const building = buildBuilding(spec({ floors: 4, unitsPerFloor: 2 }));
    const html = draw(building, 'A', { exposures: leakIn(building, 'u-A-0-0') });

    const drips = html.match(/stroke-dasharray="4 4"/g)?.length ?? 0;
    expect(drips).toBeGreaterThanOrEqual(3);
  });

  it('renders without a leak, a device or a callback', () => {
    // The resting state is what a healthy building looks like all day.
    const html = renderToStaticMarkup(
      <BuildingCutaway building={buildBuilding(spec())} side="A" />,
    );
    expect(html).toContain('FRONT ELEVATION');
    expect(html).not.toContain('INSPECT');
  });
});
