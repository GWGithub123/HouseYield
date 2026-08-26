import { describe, expect, it } from 'vitest';
import {
  buildHazardCrossovers,
  buildHealthPins,
  healthAnchorFor,
  healthTint,
} from '../healthAnchors';
import { visibleRooms, SHELL, FLOOR_BANDS } from '../houseModel';
import {
  PROPERTY_HEALTH_CATEGORY_META,
  createEmptyHealthAsset,
  type PropertyHealthAsset,
} from '../../../types/propertyHealth';

const HOUSE = { id: 'p1', address: '11822 Prestwick Road, Potomac, MD 20854', beds: 4, baths: 3 };
const CONDO = { id: 'p2', address: '1400 S Joyce St #1503, Arlington, VA 22202', beds: 2, baths: 2 };

const NOW = new Date('2026-07-01T00:00:00.000Z');

function asset(over: Partial<PropertyHealthAsset> & Pick<PropertyHealthAsset, 'category' | 'name'>) {
  return createEmptyHealthAsset(over);
}

/** Years back from the fixed NOW, so ages do not drift as the suite ages. */
function installedYearsAgo(years: number): string {
  const d = new Date(NOW);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
}

describe('healthAnchorFor', () => {
  const houseRooms = visibleRooms(HOUSE);
  const condoRooms = visibleRooms(CONDO);

  it('puts mechanicals on their fixtures, inside the shell', () => {
    for (const category of ['water_heater', 'hvac', 'electrical'] as const) {
      const anchor = healthAnchorFor(category, houseRooms);
      expect(anchor, category).not.toBeNull();
      expect(anchor!.x).toBeGreaterThan(SHELL.wallLeft);
      expect(anchor!.x).toBeLessThan(SHELL.wallRight + 120);
      // Below grade: these all live in the basement utility room.
      expect(anchor!.y).toBeGreaterThan(SHELL.grade);
    }
  });

  it('separates the air filter from the furnace it sits on', () => {
    const furnace = healthAnchorFor('hvac', houseRooms)!;
    const filter = healthAnchorFor('air_filter', houseRooms)!;
    expect(Math.abs(filter.y - furnace.y)).toBeGreaterThan(30);
  });

  it('keeps mechanical pins on a property whose archetype lacks the fixture', () => {
    // The component is tracked even if the archetypal condo drawing has no
    // basement fixture. It gets a clearly approximate area rather than vanishing.
    for (const category of ['hvac', 'water_heater', 'electrical', 'air_filter'] as const) {
      const anchor = healthAnchorFor(category, condoRooms);
      expect(anchor, category).not.toBeNull();
      expect(anchor!.approximate, category).toBe(true);
    }
  });

  it('still places roof and windows on a basement-less property', () => {
    expect(healthAnchorFor('roof', condoRooms)).not.toBeNull();
    expect(healthAnchorFor('windows', condoRooms)).not.toBeNull();
  });

  it('keeps the roof pin above the wall line and plumbing below it', () => {
    expect(healthAnchorFor('roof', houseRooms)!.y).toBeLessThan(SHELL.wallTop);
    expect(healthAnchorFor('plumbing', houseRooms)!.y).toBeGreaterThan(FLOOR_BANDS.main.top);
  });

  it('labels interior pins inward so text stays off the walls', () => {
    for (const category of ['water_heater', 'hvac', 'electrical'] as const) {
      const anchor = healthAnchorFor(category, houseRooms)!;
      const expected = anchor.x > SHELL.roofPeak.x ? 'left' : 'right';
      expect(anchor.side, category).toBe(expected);
    }
  });

  it('labels the exterior pin outward, away from the siding it describes', () => {
    const anchor = healthAnchorFor('exterior', houseRooms)!;
    expect(anchor.x).toBeGreaterThan(SHELL.wallRight);
    expect(anchor.side).toBe('right');
  });
});

describe('healthTint', () => {
  it('grades continuously rather than by status bucket', () => {
    expect(healthTint(0.2)).not.toBe(healthTint(0.7));
    expect(healthTint(0.7)).not.toBe(healthTint(0.9));
    expect(healthTint(0.9)).not.toBe(healthTint(1.2));
  });

  it('marks an unknown age distinctly from a healthy one', () => {
    expect(healthTint(null)).not.toBe(healthTint(0.1));
  });
});

describe('buildHealthPins', () => {
  const rooms = visibleRooms(HOUSE);

  it('keeps every asset when several share a category', () => {
    const pins = buildHealthPins(
      [
        asset({ category: 'windows', name: 'Front windows', installedAt: installedYearsAgo(2) }),
        asset({ category: 'windows', name: 'Rear windows', installedAt: installedYearsAgo(28) }),
      ],
      rooms,
      NOW,
    );

    expect(pins).toHaveLength(2);
    expect(pins.map((pin) => pin.asset.name)).toEqual(
      expect.arrayContaining(['Front windows', 'Rear windows']),
    );
    expect(new Set(pins.map((pin) => `${pin.anchor.x}:${pin.anchor.y}`)).size).toBe(2);
  });

  it('skips assets the owner marked not applicable', () => {
    const pins = buildHealthPins(
      [asset({ category: 'hvac', name: 'Furnace', notApplicable: true })],
      rooms,
      NOW,
    );
    expect(pins).toHaveLength(0);
  });

  it('uses an approximate area instead of dropping a category', () => {
    const pins = buildHealthPins(
      [asset({ category: 'hvac', name: 'Heat pump', installedAt: installedYearsAgo(5) })],
      visibleRooms(CONDO),
      NOW,
    );
    expect(pins).toHaveLength(1);
    expect(pins[0].anchor.approximate).toBe(true);
  });

  it('draws every supported health category, including filters', () => {
    const categories = [
      'roof', 'hvac', 'water_heater', 'windows', 'air_filter', 'water_filter',
      'smart_home', 'appliance', 'electrical', 'plumbing', 'exterior', 'other',
    ] as const;
    const pins = buildHealthPins(
      categories.map((category) => asset({
        category,
        name: PROPERTY_HEALTH_CATEGORY_META[category].label,
        installedAt: installedYearsAgo(2),
      })),
      rooms,
      NOW,
    );
    expect(new Set(pins.map((pin) => pin.asset.category))).toEqual(new Set(categories));
  });

  it('separates pins that would otherwise sit on top of each other', () => {
    // The water heater and the furnace stand about fifty units apart on the
    // same basement wall — close enough that their rings and labels collided.
    const pins = buildHealthPins(
      [
        asset({ category: 'water_heater', name: 'Heater', installedAt: installedYearsAgo(11) }),
        asset({ category: 'hvac', name: 'Furnace', installedAt: installedYearsAgo(16) }),
      ],
      rooms,
      NOW,
    );

    expect(pins).toHaveLength(2);
    const [a, b] = pins.map((p) => p.anchor);
    const clear = Math.abs(a.x - b.x) >= 108 || Math.abs(a.y - b.y) >= 40;
    expect(clear).toBe(true);
  });

  it('orders pins top-down so labels do not cover the pin above', () => {
    const pins = buildHealthPins(
      [
        asset({ category: 'water_heater', name: 'Heater', installedAt: installedYearsAgo(9) }),
        asset({ category: 'roof', name: 'Roof', installedAt: installedYearsAgo(12) }),
      ],
      rooms,
      NOW,
    );
    expect(pins.map((p) => p.asset.category)).toEqual(['roof', 'water_heater']);
  });
});

describe('buildHazardCrossovers', () => {
  const rooms = visibleRooms(HOUSE);
  const heater = asset({
    category: 'water_heater',
    name: 'Rheem 50 gal',
    installedAt: installedYearsAgo(11),
  });

  it('says nothing when there is no water', () => {
    expect(buildHazardCrossovers([heater], rooms, null, NOW)).toEqual([]);
    expect(buildHazardCrossovers([heater], rooms, 0, NOW)).toEqual([]);
  });

  it('flags a basement mechanical once water reaches it', () => {
    const found = buildHazardCrossovers([heater], rooms, 2, NOW);
    expect(found).toHaveLength(1);
    expect(found[0].assetId).toBe(heater.id);
    expect(found[0].category).toBe('water_heater');
  });

  it('escalates severity when the component is also near end of life', () => {
    const young = asset({
      category: 'water_heater',
      name: 'New heater',
      installedAt: installedYearsAgo(1),
    });

    const oldOne = buildHazardCrossovers([heater], rooms, 1.2, NOW)[0];
    const newOne = buildHazardCrossovers([young], rooms, 1.2, NOW)[0];

    expect(oldOne.severity).toBe('critical');
    expect(newOne.severity).not.toBe('critical');
    // The advice differs too: only the aging one is worth replacing early.
    expect(oldOne.headline).toMatch(/aging/i);
    expect(newOne.headline).not.toMatch(/aging/i);
  });

  it('leaves the roof alone no matter how deep the basement floods', () => {
    const roof = asset({ category: 'roof', name: 'Asphalt shingle', installedAt: installedYearsAgo(20) });
    expect(buildHazardCrossovers([roof], rooms, 4, NOW)).toEqual([]);
  });

  it('reports the deepest threshold the water has actually reached', () => {
    // 4 ft is the panel line; a 2.5 ft flood must not claim it.
    const shallow = buildHazardCrossovers([heater], rooms, 2.5, NOW)[0];
    const deep = buildHazardCrossovers([heater], rooms, 4.5, NOW)[0];
    expect(shallow.levelFt).toBeLessThan(deep.levelFt);
    expect(deep.thresholdId).toBe('panel');
  });

  it('sorts the worst crossovers first', () => {
    const young = asset({
      category: 'electrical',
      name: 'New panel',
      installedAt: installedYearsAgo(1),
    });
    const found = buildHazardCrossovers([young, heater], rooms, 4.5, NOW);
    const rank = { critical: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < found.length; i += 1) {
      expect(rank[found[i - 1].severity]).toBeLessThanOrEqual(rank[found[i].severity]);
    }
  });
});
