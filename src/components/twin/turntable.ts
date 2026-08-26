/**
 * Turntable projection for the twin's close-up views.
 *
 * Extracted from the device hero so the property-health close-up can turn on the
 * same axis rather than reimplementing the projection beside it. Nothing here
 * knows what it is drawing: it takes a box's width, depth and height and an angle,
 * and reports where each visible face lands on screen.
 *
 * The turn is a real rotation about the vertical axis rather than a squash-and-
 * flip fake. That costs almost nothing: rotating a box about a vertical axis
 * leaves every vertical edge vertical, so each visible face stays an axis-aligned
 * screen rectangle and the whole thing is four numbers per frame. What it buys is
 * that the proportions, the face ordering and the width of the side return are all
 * correct at every angle, so the object has consistent volume instead of appearing
 * to breathe as it goes round.
 */
import { useEffect, useState } from 'react';

/* ── turntable ───────────────────────────────────────────────────── */

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * One revolution every `periodMs`.
 *
 * Deliberately a state-driven rAF loop rather than SMIL: the face ordering
 * changes as the object turns, which is a structural change to the drawing and
 * not something a declarative attribute animation can express. Confined to this
 * component so the surrounding canvas is not re-rendering sixty times a second.
 */
export function useTurntable(periodMs: number): number {
  // Three-quarters on is the most legible resting angle, and the one to hold if
  // the viewer has asked for less motion.
  const [theta, setTheta] = useState(-0.62);

  useEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') return undefined;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      setTheta(-0.62 + ((now - t0) / periodMs) * Math.PI * 2);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [periodMs]);

  return theta;
}

export type FaceId = 'front' | 'back' | 'left' | 'right';

export interface Face {
  id: FaceId;
  /** Screen-space left edge and width of the face's footprint. */
  x: number;
  w: number;
  /** Closed quad for the face. Sheared, not rectangular — see `project`. */
  path: string;
  /** Centre of the face, where its artwork is anchored. */
  cx: number;
  cy: number;
  /** Vertical shear of the surface, in degrees, for laying artwork on it. */
  skewDeg: number;
  /** How square-on the face is, 0–1. Drives both shading and label legibility. */
  facing: number;
  /** Mean depth, used to paint back to front. */
  depth: number;
}

/**
 * How far the viewpoint sits above the object, as a rise per unit of depth.
 *
 * Any value above zero is what forces the faces to be quads rather than
 * rectangles: with the camera above, two points at the same height but different
 * depths do not land at the same height on screen, so a face spanning depth is
 * sheared. Getting this wrong is subtle and looks specific — a rectangular front
 * face with a properly projected lid leaves the lid touching the body at a single
 * corner and floating clear of it everywhere else.
 */
export const TILT = 0.4;

/**
 * Plan point (x across, z towards the viewer) at height h, in screen space.
 *
 * Rotation is about the vertical axis, so the plan rotates and heights are
 * untouched; the elevation then pushes nearer points down the page. Depths are
 * measured against the nearest corner of the box so the object rests on its
 * platter instead of hovering above or sinking into it.
 */
export function project(
  x: number,
  z: number,
  h: number,
  c: number,
  s: number,
  nearest: number,
  tilt: number,
) {
  const depth = z * c - x * s;
  return { X: x * c + z * s, Y: (depth - nearest) * tilt - h };
}

/**
 * Which faces of a W×D×H box are visible at angle `theta`, and where they land.
 *
 * A face is visible exactly when its rotated normal points towards the camera,
 * which for a box about a vertical axis means at most one of each opposing pair —
 * so there are never more than two, and the pair is always a front-or-back plus a
 * left-or-right.
 */
export function facesFor(
  theta: number,
  W: number,
  D: number,
  H: number,
  tilt: number = TILT,
): Face[] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const hw = W / 2;
  const hd = D / 2;
  const nearest = hd * Math.abs(c) + hw * Math.abs(s);

  const build = (
    id: FaceId,
    a: readonly [number, number],
    b: readonly [number, number],
    facing: number,
    depth: number,
  ): Face => {
    const aBase = project(a[0], a[1], 0, c, s, nearest, tilt);
    const bBase = project(b[0], b[1], 0, c, s, nearest, tilt);
    const aTop = project(a[0], a[1], H, c, s, nearest, tilt);
    const bTop = project(b[0], b[1], H, c, s, nearest, tilt);
    const run = bBase.X - aBase.X;
    return {
      id,
      x: Math.min(aBase.X, bBase.X),
      w: Math.abs(run),
      path: `M${aTop.X.toFixed(2)} ${aTop.Y.toFixed(2)} L${bTop.X.toFixed(2)} ${bTop.Y.toFixed(2)} `
        + `L${bBase.X.toFixed(2)} ${bBase.Y.toFixed(2)} L${aBase.X.toFixed(2)} ${aBase.Y.toFixed(2)} Z`,
      cx: (aTop.X + bTop.X) / 2,
      cy: (aTop.Y + bTop.Y + aBase.Y + bBase.Y) / 4,
      skewDeg: Math.abs(run) < 0.001
        ? 0
        : (Math.atan2(bBase.Y - aBase.Y, run) * 180) / Math.PI,
      facing,
      depth,
    };
  };

  const candidates: Array<{ face: Face; visible: boolean }> = [
    { face: build('front', [-hw, hd], [hw, hd], Math.abs(c), hd * c), visible: c > 0 },
    { face: build('back', [hw, -hd], [-hw, -hd], Math.abs(c), -hd * c), visible: c < 0 },
    { face: build('left', [-hw, -hd], [-hw, hd], Math.abs(s), hw * s), visible: s > 0 },
    { face: build('right', [hw, hd], [hw, -hd], Math.abs(s), -hw * s), visible: s < 0 },
  ];

  return candidates
    .filter((entry) => entry.visible && entry.face.w > 0.4)
    .map((entry) => entry.face)
    .sort((a, b) => a.depth - b.depth);
}

/**
 * The transform that lays upright artwork onto a face.
 *
 * A face is a parallelogram with vertical sides, which is exactly what you get
 * by squashing a rectangle horizontally and then shearing it vertically — so the
 * same transform that puts a label on the panel can draw the panel itself. That
 * is what lets the casing have rounded corners: an `rx` on a rect survives the
 * transform and compresses as the face turns away, which is what a real rounded
 * edge does, whereas a hand-built quad path can only ever have sharp corners.
 */
export function faceTransform(face: Face): string {
  return `translate(${face.cx.toFixed(2)} ${face.cy.toFixed(2)})`
    + ` skewY(${face.skewDeg.toFixed(2)})`
    + ` scale(${Math.max(face.facing, 0.001).toFixed(4)} 1)`;
}

/**
 * Maps plan coordinates at a given height onto the screen.
 *
 * The projection is linear in (x, z), so the whole thing collapses to an SVG
 * matrix. Anything drawn through it — the lid outline, a logo silkscreened on
 * the top, an indicator near the rim — sits on the horizontal surface and turns
 * with the object for free.
 */
export function planMatrix(
  theta: number,
  W: number,
  D: number,
  h: number,
  tilt: number = TILT,
): string {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const nearest = (D / 2) * Math.abs(c) + (W / 2) * Math.abs(s);
  return `matrix(${c.toFixed(5)} ${(-s * tilt).toFixed(5)} ${s.toFixed(5)} `
    + `${(c * tilt).toFixed(5)} 0 ${(-nearest * tilt - h).toFixed(4)})`;
}

/** The lid: the plan outline at full height, and the topmost surface at any angle. */
export function lidPath(
  theta: number,
  W: number,
  D: number,
  H: number,
  tilt: number = TILT,
): string {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const hw = W / 2;
  const hd = D / 2;
  const nearest = hd * Math.abs(c) + hw * Math.abs(s);
  return `${([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as const)
    .map(([x, z], i) => {
      const p = project(x, z, H, c, s, nearest, tilt);
      return `${i === 0 ? 'M' : 'L'}${p.X.toFixed(2)} ${p.Y.toFixed(2)}`;
    })
    .join(' ')} Z`;
}

/* ── shading ─────────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

/**
 * Light sits front-upper-left, the same place it does for every other solid in
 * the section. A face turning away darkens; the one square-on to the viewer is
 * brightest. Without this the box turns but never looks like it is turning,
 * because the only thing changing is width.
 */
export function faceShade(face: Face, theta: number, base: string): string {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const normals: Record<FaceId, [number, number]> = {
    front: [s, c],
    back: [-s, -c],
    left: [-c, s],
    right: [c, -s],
  };
  const [nx, nz] = normals[face.id];
  const lit = Math.max(0, nx * -0.46 + nz * 0.89);
  /*
   * Shading is darkening only, never lightening.
   *
   * The casings are white plastic, so there is no headroom above the base colour
   * to brighten into — mixing towards white just clips every face to the same
   * flat white and the object stops having sides. Letting the turned faces fall
   * away into grey instead is both how matte white plastic actually behaves and
   * the only axis with any range left.
   */
  return mix(base, '#40566f', (1 - lit) * 0.34);
}
