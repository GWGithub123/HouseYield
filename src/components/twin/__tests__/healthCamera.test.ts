/**
 * Framing a health component.
 *
 * Three things have to hold. The canvas aspect ratio, for the same reason every
 * other camera respects it — the SVG is `width:100%; height:auto`, so an off-ratio
 * frame resizes the element and shoves the page around. The frame has to stay
 * inside the drawing. And the component has to be *wholly* in shot, which is the
 * guarantee that matters most: nothing is blurred and no stand-in is drawn at this
 * rung, so a frame that clips the subject leaves the user looking at part of a roof
 * with no indication that there is more of it.
 */
import { describe, expect, it } from 'vitest';
import { cameraForHealthComponent, cameraForRoom, cameraZoom } from '../twinCamera';
import { VB_H, VB_W, visibleRooms } from '../houseModel';
import { componentRegion } from '../componentWear';
import { buildHealthPins, healthAnchorFor } from '../healthAnchors';
import { createEmptyHealthAsset, type PropertyHealthAsset } from '../../../types/propertyHealth';

const ASPECT = VB_W / VB_H;
const rooms = visibleRooms({ address: '11822 Prestwick Road', beds: 4, baths: 3 });
const condoRooms = visibleRooms({ address: '4 Main St Unit 2', beds: 2, baths: 1 });

const room = (id: string) => {
  const found = rooms.find((r) => r.id === id);
  if (!found) throw new Error(`no room ${id}`);
  return found;
};

const inBounds = (c: { x: number; y: number; w: number; h: number }) =>
  c.x >= -0.001 && c.y >= -0.001 && c.x + c.w <= VB_W + 0.001 && c.y + c.h <= VB_H + 0.001;

function asset(over: Partial<PropertyHealthAsset> = {}): PropertyHealthAsset {
  return createEmptyHealthAsset({
    category: 'water_heater',
    name: 'Water heater',
    installedAt: '2013-06-18',
    ...over,
  });
}

const CATEGORIES = [
  'water_heater',
  'hvac',
  'air_filter',
  'water_filter',
  'appliance',
  'smart_home',
  'electrical',
  'roof',
  'plumbing',
  'windows',
  'exterior',
  'other',
] as const;

/** The camera as the app builds it: from the geometry, framed against its room. */
const cameraFor = (category: (typeof CATEGORIES)[number], within = rooms) => {
  const anchor = healthAnchorFor(category, within);
  return cameraForHealthComponent(
    componentRegion(category, within).box,
    anchor?.roomId ? within.find((r) => r.id === anchor.roomId) ?? null : null,
  );
};

const contains = (
  c: { x: number; y: number; w: number; h: number },
  box: { x: number; y: number; w: number; h: number },
) =>
  box.x >= c.x - 0.001
  && box.y >= c.y - 0.001
  && box.x + box.w <= c.x + c.w + 0.001
  && box.y + box.h <= c.y + c.h + 0.001;

describe('cameraForHealthComponent', () => {
  it('keeps the canvas aspect ratio with a room', () => {
    expect(cameraFor('water_heater').w / cameraFor('water_heater').h).toBeCloseTo(ASPECT, 6);
  });

  it('keeps the canvas aspect ratio without a room', () => {
    expect(cameraFor('roof').w / cameraFor('roof').h).toBeCloseTo(ASPECT, 6);
  });

  it('never frames the void outside the drawing', () => {
    for (const category of CATEGORIES) expect(inBounds(cameraFor(category))).toBe(true);
    // The roof runs to the top edge of the artwork, which is where clamping bites.
    expect(inBounds(cameraForHealthComponent({ x: 600, y: 10, w: 120, h: 60 }, null))).toBe(true);
    expect(inBounds(cameraForHealthComponent({ x: 20, y: 880, w: 120, h: 60 }, null))).toBe(true);
  });

  it('holds the whole component in shot, on every category', () => {
    // The guarantee the close-up rests on. Half a roof, framed with no blur and no
    // stand-in beside it, is indistinguishable from a roof that stops there.
    for (const category of CATEGORIES) {
      expect(contains(cameraFor(category), componentRegion(category, rooms).box)).toBe(true);
    }
  });

  it('frames the whole roof rather than a crop of the middle of it', () => {
    const c = cameraFor('roof');
    const { box } = componentRegion('roof', rooms);
    expect(contains(c, box)).toBe(true);
    // Wide subject, so the zoom is modest — filling the frame with roof would mean
    // cutting the eaves off, and the eaves are where a roof fails first.
    expect(cameraZoom(c)).toBeGreaterThan(1);
    expect(cameraZoom(c)).toBeLessThan(2);
  });

  it('zooms in, but keeps enough of the room to place the component', () => {
    const c = cameraFor('water_heater');
    expect(cameraZoom(c)).toBeGreaterThan(1);
    // The pan under a water heater and the pipes off the top are the reason to look
    // closely at all, so the frame stays wide of the appliance itself.
    expect(c.w).toBeGreaterThan(cameraForRoom(room('utility')).w * 0.5);
  });

  it('holds every guarantee on a layout that drops whole storeys', () => {
    for (const category of CATEGORIES) {
      const c = cameraFor(category, condoRooms);
      expect(c.w / c.h).toBeCloseTo(ASPECT, 6);
      expect(inBounds(c)).toBe(true);
      expect(contains(c, componentRegion(category, condoRooms).box)).toBe(true);
    }
  });
});

describe('health anchors carry their room', () => {
  it('reports the room for a component that stands in one', () => {
    const anchor = healthAnchorFor('water_heater', rooms);
    expect(anchor?.roomId).toBeTruthy();
    expect(rooms.some((r) => r.id === anchor!.roomId)).toBe(true);
  });

  it('reports no room for the roof, which is part of the shell', () => {
    expect(healthAnchorFor('roof', rooms)?.roomId).toBeUndefined();
  });

  it('reports no room for the exterior', () => {
    expect(healthAnchorFor('exterior', rooms)?.roomId).toBeUndefined();
  });

  it('keeps the room after pins are spread apart to avoid collisions', () => {
    // The water heater and furnace stand close enough that spreading kicks in,
    // and an earlier version rebuilt the anchor and dropped the room with it.
    const pins = buildHealthPins(
      [
        asset({ category: 'water_heater', name: 'Water heater' }),
        asset({ category: 'hvac', name: 'Furnace' }),
        asset({ category: 'electrical', name: 'Panel' }),
      ],
      rooms,
    );

    expect(pins.length).toBeGreaterThan(1);
    for (const pin of pins) {
      expect(pin.anchor.roomId).toBeTruthy();
    }
  });

  it('marks the anchor approximate when the archetype lacks the fixture', () => {
    // A condo with no basement has no furnace to hang the HVAC pin on, but a
    // tracked component must remain discoverable.
    expect(healthAnchorFor('hvac', condoRooms)?.approximate).toBe(true);
  });
});
