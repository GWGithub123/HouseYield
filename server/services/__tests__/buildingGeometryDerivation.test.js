import { describe, expect, it } from 'vitest';

import { deriveBuildingGeometry } from '../buildingGeometryDerivation.js';

/** A cached dashboard carrying one raw ATTOM property record. */
function dashboardWith(propertyRecord, summary = {}) {
  return {
    summary,
    attom_source: { expandedprofile: { property: [propertyRecord] } },
  };
}

describe('deriveBuildingGeometry', () => {
  it('returns null when there is nothing to derive from', () => {
    expect(deriveBuildingGeometry(null)).toBeNull();
    expect(deriveBuildingGeometry(undefined)).toBeNull();
  });

  it('reads floors and units out of the raw ATTOM blob', () => {
    const geometry = deriveBuildingGeometry(
      dashboardWith(
        { building: { summary: { levels: 5, unitsCount: 40 } } },
        { propclass: 'APARTMENT' },
      ),
    );

    expect(geometry.floors).toBe(5);
    expect(geometry.unitsTotal).toBe(40);
    expect(geometry.unitsPerFloor).toBe(8);
    expect(geometry.sources.floors).toBe('attom:building.summary.levels');
    expect(geometry.sources.unitsTotal).toBe('attom:building.summary.unitsCount');
  });

  it('classifies a tall multi-unit building as a corridor midrise needing an A/B flip', () => {
    const geometry = deriveBuildingGeometry(
      dashboardWith(
        { building: { summary: { levels: 5, unitsCount: 40 } } },
        { propclass: 'APARTMENT' },
      ),
    );

    expect(geometry.archetype).toBe('midrise_corridor');
    expect(geometry.corridor).toBe('double_loaded');
  });

  it('classifies a short, shallow multi-unit building as a garden walk-up with no corridor', () => {
    const geometry = deriveBuildingGeometry(
      dashboardWith(
        { building: { summary: { levels: 2, unitsCount: 8 } } },
        { propclass: 'APARTMENT' },
      ),
    );

    expect(geometry.archetype).toBe('garden_walkup');
    expect(geometry.corridor).toBe('none');
  });

  it('treats a single-unit house as single family', () => {
    const geometry = deriveBuildingGeometry(
      dashboardWith(
        { building: { summary: { levels: 2, unitsCount: 1 } } },
        { propclass: 'SINGLE FAMILY RESIDENCE' },
      ),
    );

    expect(geometry.archetype).toBe('single_family');
    expect(geometry.unitsTotal).toBe(1);
    expect(geometry.corridor).toBe('none');
  });

  it('infers a unit count from the property class when ATTOM gives no number', () => {
    const geometry = deriveBuildingGeometry(
      dashboardWith({ building: { summary: { levels: 2 } } }, { propclass: 'DUPLEX' }),
    );

    expect(geometry.unitsTotal).toBe(2);
    expect(geometry.archetype).toBe('duplex');
    expect(geometry.sources.unitsTotal).toBe('inferred_from_property_class');
  });

  it('prefers the owner-entered unit count over ATTOM', () => {
    const geometry = deriveBuildingGeometry(
      dashboardWith(
        { building: { summary: { levels: 3, unitsCount: 6 } } },
        { propclass: 'APARTMENT' },
      ),
      { unitCount: 12 },
    );

    expect(geometry.unitsTotal).toBe(12);
    expect(geometry.sources.unitsTotal).toBe('owner_entered');
  });

  it('reports high confidence only when both floors and units are measured', () => {
    const measured = deriveBuildingGeometry(
      dashboardWith(
        { building: { summary: { levels: 4, unitsCount: 24 } } },
        { propclass: 'APARTMENT' },
      ),
    );
    expect(measured.confidence).toBe('high');
    expect(measured.needsConfirmation).toBe(false);

    const partial = deriveBuildingGeometry(
      dashboardWith({ building: { summary: { levels: 4 } } }, { propclass: 'APARTMENT' }),
    );
    expect(partial.confidence).toBe('medium');
    expect(partial.needsConfirmation).toBe(true);
  });

  it('classifies mixed-use and apartment labels as multifamily even without a unit count', () => {
    // Downtown parcels are often "mixed use" or "apartments" with no unitsCount.
    // Treating those as a house is how a real apartment building keeps drawing
    // as a dollhouse.
    expect(deriveBuildingGeometry({ summary: { propclass: 'MIXED USE' } }).archetype)
      .toMatch(/garden_walkup|midrise_corridor/);
    expect(deriveBuildingGeometry({ summary: { proptype: 'APARTMENTS' } }).archetype)
      .toMatch(/garden_walkup|midrise_corridor/);
  });

  it('falls back to an archetype-shaped guess when ATTOM has no attributes at all', () => {
    const geometry = deriveBuildingGeometry({ summary: { propclass: 'APARTMENT' } });

    expect(geometry.floors).toBeGreaterThanOrEqual(1);
    expect(geometry.unitsTotal).toBeGreaterThanOrEqual(1);
    expect(geometry.confidence).toBe('low');
    expect(geometry.needsConfirmation).toBe(true);
    expect(geometry.sources.floors).toBe('inferred_from_archetype');
  });

  it('treats a condo record with no unit count as a single unit', () => {
    const geometry = deriveBuildingGeometry(
      dashboardWith({}, { propsubtype: 'CONDOMINIUM' }),
    );

    expect(geometry.archetype).toBe('condo_unit');
    expect(geometry.unitsTotal).toBe(1);
  });
});
