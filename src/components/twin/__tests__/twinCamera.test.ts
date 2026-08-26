/**
 * The camera's hard constraint is the canvas aspect ratio: the SVG is sized
 * `width:100%; height:auto`, so its rendered height comes from the viewBox. A
 * frame at the wrong ratio silently resizes the element and shoves the page
 * around, which is the sort of bug that looks like a CSS problem for an hour.
 */
import { describe, expect, it } from 'vitest';
import {
  cameraForDevice,
  cameraForHealthComponent,
  cameraForRoom,
  cameraViewBox,
  cameraZoom,
  HOUSE_CAMERA,
  HOUSE_SCENE,
  sameCamera,
  sceneCamera,
  sceneWithAspect,
  type CameraScene,
} from '../twinCamera';
import { DX, DY, VB_H, VB_W, visibleRooms } from '../houseModel';

const ASPECT = VB_W / VB_H;
const rooms = visibleRooms({ address: '11822 Prestwick Road', beds: 4, baths: 3 });
const room = (id: string) => {
  const found = rooms.find((r) => r.id === id);
  if (!found) throw new Error(`no room ${id}`);
  return found;
};

const inBounds = (c: { x: number; y: number; w: number; h: number }) =>
  c.x >= -0.001 && c.y >= -0.001 && c.x + c.w <= VB_W + 0.001 && c.y + c.h <= VB_H + 0.001;

describe('camera framing', () => {
  it('rests on the whole canvas', () => {
    expect(HOUSE_CAMERA).toEqual({ x: 0, y: 0, w: VB_W, h: VB_H });
    expect(cameraZoom(HOUSE_CAMERA)).toBe(1);
  });

  it('keeps the canvas aspect ratio for every room', () => {
    for (const r of rooms) {
      const c = cameraForRoom(r);
      expect(c.w / c.h).toBeCloseTo(ASPECT, 6);
    }
  });

  it('keeps the canvas aspect ratio for a device', () => {
    const c = cameraForDevice({ x: 500, y: 500 });
    expect(c.w / c.h).toBeCloseTo(ASPECT, 6);
  });

  it('stays inside the drawing, including for corner rooms', () => {
    for (const r of rooms) expect(inBounds(cameraForRoom(r))).toBe(true);
    // Devices pinned hard against each edge are the cases that pan off.
    for (const at of [{ x: 0, y: 0 }, { x: VB_W, y: 0 }, { x: 0, y: VB_H }, { x: VB_W, y: VB_H }]) {
      expect(inBounds(cameraForDevice(at))).toBe(true);
    }
  });

  it('contains the room volume it is framing, not just the opening', () => {
    const r = room('kitchen');
    const c = cameraForRoom(r);
    // The projection exposes ceiling and side wall behind the front face.
    expect(c.x).toBeLessThanOrEqual(r.x);
    expect(c.x + c.w).toBeGreaterThanOrEqual(r.x + r.w + DX);
    expect(c.y).toBeLessThanOrEqual(r.y - DY);
    expect(c.y + c.h).toBeGreaterThanOrEqual(r.y + r.h);
  });

  it('zooms further for a device than for the room holding it', () => {
    const roomZoom = cameraZoom(cameraForRoom(room('kitchen')));
    const deviceZoom = cameraZoom(cameraForDevice({ x: 500, y: 500 }));
    expect(roomZoom).toBeGreaterThan(1);
    expect(deviceZoom).toBeGreaterThan(roomZoom);
  });

  it('serialises to a viewBox', () => {
    expect(cameraViewBox({ x: 1, y: 2, w: 3, h: 4 })).toBe('1.00 2.00 3.00 4.00');
  });

  it('compares cameras by value', () => {
    expect(sameCamera(HOUSE_CAMERA, { ...HOUSE_CAMERA })).toBe(true);
    expect(sameCamera(HOUSE_CAMERA, { ...HOUSE_CAMERA, w: 10 })).toBe(false);
  });
});

/**
 * The scene was extracted from two hardcoded constants so a wide building
 * elevation and a portrait phone can both be framed. The thing that must not
 * change is the house: every existing call site passes no scene, so passing the
 * house scene explicitly has to produce the identical camera.
 */
describe('camera scenes', () => {
  it('defaults to the house, so existing call sites are unaffected', () => {
    expect(HOUSE_SCENE).toEqual({ w: VB_W, h: VB_H, aspect: ASPECT });
    expect(sceneCamera()).toEqual(HOUSE_CAMERA);
    expect(sceneCamera(HOUSE_SCENE)).toEqual(HOUSE_CAMERA);
  });

  it('produces byte-identical framing whether the house scene is passed or not', () => {
    for (const r of rooms) {
      expect(cameraForRoom(r, HOUSE_SCENE), r.id).toEqual(cameraForRoom(r));
    }
    for (const at of [{ x: 500, y: 500 }, { x: 40, y: 40 }, { x: 1300, y: 900 }]) {
      expect(cameraForDevice(at, null, HOUSE_SCENE)).toEqual(cameraForDevice(at));
      expect(cameraForDevice(at, room('kitchen'), HOUSE_SCENE))
        .toEqual(cameraForDevice(at, room('kitchen')));
    }
    const box = { x: 400, y: 300, w: 120, h: 60 };
    expect(cameraForHealthComponent(box, null, HOUSE_SCENE))
      .toEqual(cameraForHealthComponent(box, null));
    expect(cameraForHealthComponent(box, room('living'), HOUSE_SCENE))
      .toEqual(cameraForHealthComponent(box, room('living')));
  });

  it('grows a frame to whatever shape the element is', () => {
    // A long, shallow elevation: the frame has to come out wide, not square.
    const wide: CameraScene = { w: 4200, h: 900, aspect: 3.2 };
    const c = sceneCamera(wide);
    expect(c.w / c.h).toBeCloseTo(3.2, 5);

    // Portrait, over the same drawing as the house.
    const tall = sceneWithAspect(HOUSE_SCENE, 0.75);
    const t = sceneCamera(tall);
    expect(t.w / t.h).toBeCloseTo(0.75, 5);
    // The extent is unchanged, so a portrait frame over a wide drawing has to
    // give up width rather than invent drawing outside it.
    expect(t.w).toBeLessThanOrEqual(VB_W + 0.001);
  });

  it('clamps to the scene it was given, not to the house', () => {
    const wide: CameraScene = { w: 4200, h: 900, aspect: 3.2 };
    // Framing a subject at x=4000 is off the right edge of the house but well
    // inside a long building, so it must not be dragged back to VB_W.
    const c = cameraForRoom(
      { ...room('living'), x: 3900, y: 400, w: 200, h: 160 },
      wide,
    );
    expect(c.x + c.w).toBeLessThanOrEqual(wide.w + 0.001);
    expect(c.x + c.w).toBeGreaterThan(VB_W);
  });

  it('measures zoom against the scene, so 1 is always the whole drawing', () => {
    const wide: CameraScene = { w: 4200, h: 900, aspect: 3.2 };
    expect(cameraZoom(sceneCamera(wide), wide)).toBeCloseTo(1, 5);
  });

  it('ignores a nonsensical aspect rather than producing a broken frame', () => {
    expect(sceneWithAspect(HOUSE_SCENE, 0).aspect).toBe(ASPECT);
    expect(sceneWithAspect(HOUSE_SCENE, -2).aspect).toBe(ASPECT);
  });
});
