/**
 * Camera for the cutaway canvas.
 *
 * The three rungs of the zoom ladder (neighborhood, lot, interior) are separate
 * renderers, so moving between them can only ever be a cut with a transition
 * pasted over it. Inside the interior view it is a different story: the whole
 * section is one SVG coordinate space, so framing a room or a single device is
 * just a question of which part of that space the viewBox covers — and that can
 * be animated properly.
 *
 * Driving the `viewBox` rather than a transform on a wrapper group is deliberate.
 * Pointer positions are recovered with `getScreenCTM()`, which accounts for the
 * viewBox for free, so drag-to-assign keeps working at any zoom without the
 * hit-testing having to know the camera exists.
 */
import { useEffect, useRef, useState } from 'react';
import { DX, DY, VB_H, VB_W } from './houseModel';
import type { RoomDef } from './houseModel';
import { sectionCamera } from './houseProjection';
import type { SceneCamera } from './twinScene';

export interface Camera {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole house — the rung's resting position. */
export const HOUSE_CAMERA: Camera = { x: 0, y: 0, w: VB_W, h: VB_H };

/**
 * What the camera is looking at, and what shape the element showing it is.
 *
 * These were two hardcoded constants — the house's `VB_W`/`VB_H` for the bounds
 * and their ratio for the shape — which is fine for exactly one drawing. A
 * multifamily side elevation is a different size *and* a different shape: it is
 * long and shallow, so it needs both a wider extent to clamp against and a
 * wider rendered aspect, and mobile portrait later needs a taller aspect over
 * the same extent. Splitting them apart is what makes both possible.
 *
 * `aspect` is separate from `w / h` on purpose. The canvas is laid out with
 * `width:100%; height:auto`, so its rendered height comes from the viewBox
 * ratio; framing anything at a different ratio resizes the element and shoves
 * the rest of the page around. Every camera is therefore grown to `aspect`
 * rather than cropped to its subject, and that shape is a property of the
 * viewport, not of the drawing.
 */
export interface CameraScene {
  /** Extent of the drawing in user units. */
  w: number;
  h: number;
  /** Rendered shape of the canvas element, width over height. */
  aspect: number;
}

export const HOUSE_SCENE: CameraScene = { w: VB_W, h: VB_H, aspect: VB_W / VB_H };

/**
 * A scene over the same drawing at a different rendered shape — a portrait
 * phone, or a short wide strip. The extent is unchanged; only the shape the
 * frame is grown to differs.
 */
export function sceneWithAspect(scene: CameraScene, aspect: number): CameraScene {
  return { ...scene, aspect: aspect > 0 ? aspect : scene.aspect };
}

/** The resting camera for a scene: the whole drawing, grown to the element. */
export function sceneCamera(scene: CameraScene = HOUSE_SCENE): Camera {
  return frame(scene.w / 2, scene.h / 2, scene.w, scene.h, scene);
}

function frame(
  cx: number,
  cy: number,
  w: number,
  h: number,
  scene: CameraScene = HOUSE_SCENE,
): Camera {
  let width = Math.max(w, 1);
  let height = Math.max(h, 1);
  if (width / height < scene.aspect) width = height * scene.aspect;
  else height = width / scene.aspect;

  // Never show the void outside the drawing: past the artwork there is nothing
  // to look at, and the empty band reads as a rendering fault rather than a pan.
  const x = width >= scene.w
    ? (scene.w - width) / 2
    : Math.min(Math.max(cx - width / 2, 0), scene.w - width);
  const y = height >= scene.h
    ? (scene.h - height) / 2
    : Math.min(Math.max(cy - height / 2, 0), scene.h - height);

  return { x, y, w: width, h: height };
}

/**
 * Frame one room, including the strip of ceiling and side wall the projection
 * exposes behind it — the room is a volume here, not a rectangle, and cropping
 * to the opening alone cuts the back off the space you just asked to look at.
 */
export function cameraForRoom(room: RoomDef, scene: CameraScene = HOUSE_SCENE): Camera {
  const left = room.x;
  const right = room.x + room.w + DX;
  const top = room.y - DY;
  const bottom = room.y + room.h;
  const pad = 46;
  return frame(
    (left + right) / 2,
    (top + bottom) / 2,
    right - left + pad * 2,
    bottom - top + pad * 2,
    scene,
  );
}

/**
 * Frame a single device. Tight enough that the hero rendering has room to be a
 * physical object rather than an icon, loose enough that the room it is standing
 * in is still recognisable behind it — losing that context is what would make
 * the close-up feel like a modal instead of a zoom.
 */
export function cameraForDevice(
  at: { x: number; y: number },
  room?: RoomDef | null,
  scene: CameraScene = HOUSE_SCENE,
): Camera {
  /*
   * Framed against the room rather than as a fixed close-up.
   *
   * A constant frame size is wrong in both directions: it swallows a small room
   * whole, and in a large one it crops so hard that the device ends up floating
   * in an anonymous patch of wall. Taking a fraction of the room's own frame
   * keeps the step in from the room view feeling the same everywhere, and keeps
   * enough of the room in shot that you can still see where the sensor is.
   */
  const roomFrame = room ? cameraForRoom(room, scene) : null;
  if (!roomFrame) return frame(at.x, at.y + 8, 300, 300 / scene.aspect, scene);

  /*
   * Right inside the room, centred between the sensor and the room itself.
   *
   * How tight this can go is set by what happens behind the device. The room is
   * thrown out of focus at this rung, so cropping in hard costs nothing — the
   * background is only there to say which room you are standing in, and a soft
   * wall with a corner of furniture in it does that as well as a sharp one.
   * Splitting the difference with the room centre keeps something recognisable
   * in shot rather than an anonymous patch of wall.
   */
  const width = Math.max(roomFrame.w * 0.46, 178);
  return frame(
    (at.x + (roomFrame.x + roomFrame.w / 2)) / 2,
    (at.y + (roomFrame.y + roomFrame.h / 2)) / 2,
    width,
    width / scene.aspect,
    scene,
  );
}

/**
 * Frame a health component, given the bounds of the geometry that draws it.
 *
 * Takes the component's real extent rather than its pin. An earlier version framed
 * the pin and had to bias the shot downward to compensate, because a pin is lifted
 * clear of its fixture so its label does not cover it — so centring on it framed
 * the air above the appliance. Working from the geometry removes the guess: a roof
 * that spans the house gets a wide frame and a panel on a wall gets a tight one,
 * both without a fudge factor.
 *
 * Deliberately loose. Nothing is blurred at this rung and no stand-in is drawn, so
 * the close-up has to carry its own context: the pan under a water heater, the
 * pipes off the top, how much roof there is either side of the patch that is
 * failing. Cropping to the component alone would throw that away.
 */
export function cameraForHealthComponent(
  box: { x: number; y: number; w: number; h: number },
  room?: RoomDef | null,
  scene: CameraScene = HOUSE_SCENE,
): Camera {
  const pad = 52;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  // Grown to the canvas shape here so the comparison against the room below is
  // between two frames of the same aspect rather than a box and a frame.
  const own = Math.max(box.w + pad * 2, (box.h + pad * 2) * scene.aspect);
  if (!room) return frame(cx, cy, own, own / scene.aspect, scene);

  const roomFrame = cameraForRoom(room, scene);
  /*
   * Most of the room, so the component is seen standing somewhere — but never
   * tighter than the component's own frame, even when that means spilling past the
   * room. Containment is not negotiable here: with nothing blurred and no stand-in
   * drawn, a frame that cuts the subject in half looks exactly like a component
   * that ends there.
   */
  const width = Math.max(own, roomFrame.w * 0.72);
  const height = width / scene.aspect;

  /*
   * Shifted toward the room so the shot is composed rather than dead-centred, but
   * only as far as the margin around the component allows.
   *
   * Weighted to the component rather than split evenly, because the room is context
   * at this rung. The cap is what makes it safe: an uncapped pull toward the centre
   * of a tall room slid a basement appliance up out of its own frame, which is the
   * one failure this rung cannot survive.
   */
  const towardRoom = 0.25;
  const slackX = Math.max(0, (width - box.w) / 2);
  const slackY = Math.max(0, (height - box.h) / 2);
  const clamp = (v: number, limit: number) => Math.min(Math.max(v, -limit), limit);

  return frame(
    cx + clamp((roomFrame.x + roomFrame.w / 2 - cx) * towardRoom, slackX),
    cy + clamp((roomFrame.y + roomFrame.h / 2 - cy) * towardRoom, slackY),
    width,
    height,
    scene,
  );
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function cameraViewBox(c: Camera): string {
  return `${c.x.toFixed(2)} ${c.y.toFixed(2)} ${c.w.toFixed(2)} ${c.h.toFixed(2)}`;
}

/** How far the camera is zoomed past its resting position. 1 = whole drawing. */
export function cameraZoom(c: Camera, scene: CameraScene = HOUSE_SCENE): number {
  return scene.w / c.w;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/*
 * Decelerating, with no ease-in.
 *
 * A symmetric ease is the obvious choice and it is the wrong one here, because
 * the moves are chained: the room step retargets to the device step before it
 * has finished, and an ease-in restarts the new leg from a standstill. The
 * camera visibly stalls at the hand-off, which is the single thing that made
 * the gesture feel amateurish. Leaving in full speed means a retarget simply
 * carries on.
 */
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Animate towards a camera.
 *
 * Scale is interpolated geometrically and the centre linearly. Tweening the
 * viewBox numbers straight is the obvious thing and it looks wrong: width moving
 * at a constant rate reads as a lurch that decelerates hard, because what the
 * eye judges is the *ratio* between frames, not the difference. Multiplying
 * towards the target instead gives an even rate of apparent magnification.
 */
export function useCameraTween(
  target: Camera,
  durationMs = 540,
  scene: CameraScene = HOUSE_SCENE,
): Camera {
  const [current, setCurrent] = useState<Camera>(target);
  // Mirrors state so the effect can read the live value without depending on it
  // and restarting the tween on every frame it produces.
  const liveRef = useRef<Camera>(target);
  liveRef.current = current;

  useEffect(() => {
    const from = liveRef.current;
    if (sameCamera(from, target)) return undefined;
    if (prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') {
      setCurrent(target);
      return undefined;
    }

    const fromCx = from.x + from.w / 2;
    const fromCy = from.y + from.h / 2;
    const toCx = target.x + target.w / 2;
    const toCy = target.y + target.h / 2;
    const ratio = target.w / from.w;

    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min((now - t0) / durationMs, 1);
      const t = easeOut(p);
      const w = from.w * ratio ** t;
      const h = w / scene.aspect;
      const cx = fromCx + (toCx - fromCx) * t;
      const cy = fromCy + (toCy - fromCy) * t;
      setCurrent(p >= 1 ? target : { x: cx - w / 2, y: cy - h / 2, w, h });
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target.x, target.y, target.w, target.h, durationMs, scene.aspect]);

  return current;
}

/* ── orbit ───────────────────────────────────────────────────────── */

/**
 * Where the property is being looked at from, as opposed to what part of the
 * drawing is on screen.
 *
 * These are two genuinely different cameras and conflating them is what made
 * the twin feel like a picture rather than a model. The `viewBox` camera above
 * frames a region of a finished drawing; this one decides what the drawing is
 * *of*. Zooming to a room does not change which side of the house you are
 * standing on, and orbiting does not change how close you are, so they animate
 * independently and compose.
 */
export interface Orbit {
  /** Radians about the vertical axis. 0 is the head-on section. */
  yaw: number;
  /** Radians above the horizon. */
  pitch: number;
}

/** The pose the section has always been drawn at. */
export const SECTION_ORBIT: Orbit = { yaw: 0, pitch: sectionCamera().pitch };

/**
 * How far round the owner can swing.
 *
 * Far enough to look at the back half of the plan — that is the whole point
 * of turning — but not a full spin. Past about 120° you are staring at the
 * back of the cut and the section stops describing rooms.
 */
export const MAX_YAW = (2 * Math.PI) / 3;

/** Above the horizon only, and never quite a plan: a plan hides every storey. */
export const MIN_PITCH = 0.04;
export const MAX_PITCH = Math.PI / 3;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function clampOrbit(o: Orbit): Orbit {
  return {
    yaw: clamp(o.yaw, -MAX_YAW, MAX_YAW),
    pitch: clamp(o.pitch, MIN_PITCH, MAX_PITCH),
  };
}

export function sameOrbit(a: Orbit, b: Orbit): boolean {
  return Math.abs(a.yaw - b.yaw) < 1e-6 && Math.abs(a.pitch - b.pitch) < 1e-6;
}

/**
 * A drawing camera for an orbit.
 *
 * Rotating away from the section also has to relax the cabinet projection back
 * toward a true axonometric, because the two are different beasts: the section's
 * unforeshortened facade is exactly what makes it readable head-on, and exactly
 * what would look broken from an angle, where the eye expects depth to
 * foreshorten. Interpolating between them by how far round we have swung means
 * the head-on pose is untouched and the turn is a continuous move rather than a
 * cut between two projections.
 */
export function wrapYaw(yaw: number): number {
  let y = yaw;
  const tau = Math.PI * 2;
  y = ((y + Math.PI) % tau + tau) % tau - Math.PI;
  return y;
}

/** Walk all the way behind the house. Pitch stays a section, not a plan. */
export function clampSectionOrbit(o: Orbit): Orbit {
  return {
    yaw: wrapYaw(o.yaw),
    pitch: clamp(o.pitch, MIN_PITCH, MAX_PITCH),
  };
}

export function orbitCamera(orbit: Orbit): SceneCamera {
  /*
   * Cabinet section, turned in plan. Yaw is not clamped here: the back of
   * the house is a real pose. The UI fences how far a gesture can go.
   *
   * An earlier version lerped toward a true axonometric as you yawed. That
   * jumped `rise` eight-fold and collapsed `vertical`, so each storey flew
   * up the page and the house read as an exploded stack. The coefficients
   * stay where the drawing was authored; only the plan rotates.
   */
  return sectionCamera(orbit.yaw);
}

/**
 * Interior as a dollhouse. Same family as the lot camera: off-axis and above
 * the horizon, so two walls and the floor plates are visible and the house
 * reads as a volume you can walk around.
 */
export const HOUSE_ORBIT: Orbit = { yaw: -0.34, pitch: 0.24 };

/**
 * Head-on, still 3D — looking at the front, not flattening back into a section.
 *
 * The pitch is low, and it is worth saying why raising it is not the fix it
 * looks like. The tempting move is to look down hard enough to see over the
 * front rank into the back one, but that is not how this view shows the back of
 * the house: you turn round to it, and the cull opens the back rooms exactly as
 * the front ones open now. Pitch buys nothing there, and it costs twice.
 *
 * It costs depth compression — a rank lifted by `sin(pitch)` approaches a full
 * storey and the house starts reading as a stack of floors. And there is a hard
 * failure past that: at the pitch where the camera's rise-over-run matches the
 * *roof's*, the near roof plane is edge-on and collapses to a line, so the roof
 * disappears entirely. Roofs here are framed at {@link ROOF_PITCH}, about 0.4
 * radians, and a camera anywhere near it loses them. Staying well under is the
 * only safe side, because clearing it above means looking down on the house
 * steeply enough that the storeys stop being legible anyway.
 */
export const HOUSE_FRONT: Orbit = { yaw: 0, pitch: 0.2 };

/**
 * Where the site plan is looked at from by default.
 *
 * Turned off-axis and well above the horizon, which is the pose that reads as a
 * lot rather than as a facade: enough pitch to see how the buildings sit
 * relative to each other and the street, enough yaw that two walls of each are
 * visible so the corners exist.
 */
export const SITE_ORBIT: Orbit = { yaw: -0.62, pitch: 0.58 };

/**
 * A true axonometric for the site view.
 *
 * Deliberately *not* {@link orbitCamera}. That one exists to leave the section
 * exactly as drawn at rest, which means carrying the cabinet shear and the
 * vertical stretch the section is authored in — and applied to a site plan those
 * produce a near-elevation with the lot squashed to a sliver. Nothing out here
 * is hand-drawn, so nothing needs to be compatible with how it used to look.
 *
 * No stretch either: the whole claim of this view is that it shows real relative
 * sizes, and a vertical exaggeration would make every building read as taller
 * than its footprint says.
 */
export function axonometricCamera(orbit: Orbit): SceneCamera {
  const { yaw, pitch } = clampSiteOrbit(orbit);
  return { yaw, pitch, scale: 1 };
}

/**
 * The site view can be walked all the way round — there is no removed wall to
 * end up behind — so only the pitch is fenced.
 */
export function clampSiteOrbit(o: Orbit): Orbit {
  return { yaw: o.yaw, pitch: clamp(o.pitch, 0.12, MAX_PITCH) };
}

/**
 * The dollhouse can be walked all the way round — there is no removed wall to
 * end up behind. Pitch stays above the horizon so storeys do not flatten, and
 * short of the roof pitch: see {@link HOUSE_FRONT} for why the roof vanishes
 * there. The ceiling is set below {@link ROOF_PITCH} with margin rather than at
 * it, because a roof that is merely *nearly* edge-on is a sliver, which looks
 * more like a rendering fault than a missing roof does.
 */
export const MAX_HOUSE_PITCH = 0.3;

export function clampHouseOrbit(o: Orbit): Orbit {
  return { yaw: wrapYaw(o.yaw), pitch: clamp(o.pitch, 0.1, MAX_HOUSE_PITCH) };
}

/**
 * Animate toward an orbit.
 *
 * Angles interpolate linearly — unlike zoom, where the eye judges the ratio
 * between frames, a rotation at a constant angular rate is exactly what looks
 * even. Shares the decelerating curve so a turn chained onto a zoom does not
 * stall at the hand-off.
 *
 * The target is taken as given rather than clamped. It used to be run through
 * {@link clampOrbit}, which carries the *section's* ±120° yaw fence — a limit
 * that exists because the section has a removed wall you can end up behind. The
 * dollhouse has no such wall and its whole point is that you can walk round to
 * the back, so that fence silently capped a request for 180° at 120° and the
 * back view could not be reached at all. Each view clamps to its own rule when
 * it sets the target; this only has to animate to it.
 *
 * Yaw takes the short way round, so turning from a slight left-hand view to the
 * back sweeps 200° rather than spinning 160° the other way past the front.
 */
export function useOrbitTween(target: Orbit, durationMs = 620): Orbit {
  const [current, setCurrent] = useState<Orbit>(target);
  const liveRef = useRef<Orbit>(target);
  liveRef.current = current;

  useEffect(() => {
    const from = liveRef.current;
    const to = target;
    if (sameOrbit(from, to)) return undefined;
    if (prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') {
      setCurrent(to);
      return undefined;
    }

    const dYaw = wrapYaw(to.yaw - from.yaw);
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min((now - t0) / durationMs, 1);
      const t = easeOut(p);
      setCurrent(p >= 1 ? to : {
        yaw: from.yaw + dYaw * t,
        pitch: from.pitch + (to.pitch - from.pitch) * t,
      });
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target.yaw, target.pitch, durationMs]);

  return current;
}
