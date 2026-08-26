/**
 * The turntable is the one piece of real 3D in the twin, and it is easy to get
 * subtly wrong in ways that only show up as the object appearing to breathe or
 * turn inside out halfway round. These pin the invariants that make it read as a
 * solid: the silhouette a rotating box should cast, which faces can be seen at
 * once, and which order they sit in on screen.
 */
import { describe, expect, it } from 'vitest';
import { faceTransform, facesFor, lidPath } from '../DeviceHero';

const W = 94;
const D = 34;
const H = 94;

const at = (theta: number) => facesFor(theta, W, D, H);

/** Screen width the box should occupy: both visible faces, projected. */
const expectedSilhouette = (theta: number) =>
  W * Math.abs(Math.cos(theta)) + D * Math.abs(Math.sin(theta));

const silhouetteOf = (faces: ReturnType<typeof facesFor>) => {
  const left = Math.min(...faces.map((f) => f.x));
  const right = Math.max(...faces.map((f) => f.x + f.w));
  return right - left;
};

/** Every coordinate pair in a path, for checking where a quad actually sits. */
const pointsOf = (path: string): Array<[number, number]> =>
  [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe('facesFor', () => {
  it('shows the front square-on with no side return', () => {
    const faces = at(0);
    expect(faces.map((f) => f.id)).toEqual(['front']);
    expect(faces[0].w).toBeCloseTo(W, 5);
    expect(faces[0].x).toBeCloseTo(-W / 2, 5);
    // Square-on, the surface has no slope for artwork to follow.
    expect(faces[0].skewDeg).toBeCloseTo(0, 5);
  });

  it('shows the back square-on from behind', () => {
    const faces = at(Math.PI);
    expect(faces.map((f) => f.id)).toEqual(['back']);
    expect(faces[0].w).toBeCloseTo(W, 5);
  });

  it('shows only the side edge-on, at the box depth', () => {
    const faces = at(-Math.PI / 2);
    expect(faces.map((f) => f.id)).toEqual(['right']);
    expect(faces[0].w).toBeCloseTo(D, 5);
  });

  it('pairs the front with the near side when turned', () => {
    // Turning one way brings the left flank into view, the other the right.
    expect(new Set(at(0.7).map((f) => f.id))).toEqual(new Set(['front', 'left']));
    expect(new Set(at(-0.7).map((f) => f.id))).toEqual(new Set(['front', 'right']));
  });

  it('never shows opposing faces together', () => {
    for (let i = 0; i < 360; i += 1) {
      const ids = at((i / 180) * Math.PI).map((f) => f.id);
      expect(ids.includes('front') && ids.includes('back')).toBe(false);
      expect(ids.includes('left') && ids.includes('right')).toBe(false);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(ids.length).toBeLessThanOrEqual(2);
    }
  });

  it('casts the silhouette a solid box of these proportions would', () => {
    for (let i = 0; i < 360; i += 3) {
      const theta = (i / 180) * Math.PI;
      expect(silhouetteOf(at(theta))).toBeCloseTo(expectedSilhouette(theta), 4);
    }
  });

  it('leaves no gap or overlap between the two visible faces', () => {
    for (let i = 1; i < 360; i += 1) {
      const faces = at((i / 180) * Math.PI);
      if (faces.length !== 2) continue;
      const byX = [...faces].sort((a, b) => a.x - b.x);
      expect(byX[0].x + byX[0].w).toBeCloseTo(byX[1].x, 4);
    }
  });

  it('paints back to front, so the nearer face wins any seam', () => {
    for (let i = 0; i < 360; i += 3) {
      const faces = at((i / 180) * Math.PI);
      for (let k = 1; k < faces.length; k += 1) {
        expect(faces[k].depth).toBeGreaterThanOrEqual(faces[k - 1].depth);
      }
    }
  });

  it('reports facing as how square-on each face is', () => {
    expect(at(0)[0].facing).toBeCloseTo(1, 5);
    expect(at(Math.PI / 4).find((f) => f.id === 'front')?.facing).toBeCloseTo(Math.SQRT1_2, 5);
  });

  /*
   * The elevated viewpoint is what makes the faces quads rather than rectangles.
   * These two are the regression guard for the version that treated them as
   * rectangles: the lid then met the body at one corner and floated clear of it
   * everywhere else, which read as the object having a lid hovering above it.
   */
  it('shears each face to follow the surface under an elevated view', () => {
    const front = at(-0.62).find((f) => f.id === 'front');
    expect(front).toBeDefined();
    expect(Math.abs(front!.skewDeg)).toBeGreaterThan(4);
    const ys = pointsOf(front!.path).map(([, y]) => y);
    // A sheared quad has four distinct corner heights; a rectangle has two.
    expect(new Set(ys.map((y) => y.toFixed(2))).size).toBe(4);
  });

  it('seats the lid on the top edges of the faces it caps', () => {
    for (let i = 0; i < 360; i += 7) {
      const theta = (i / 180) * Math.PI;
      const lid = pointsOf(lidPath(theta, W, D, H));
      for (const face of at(theta)) {
        // Each face's two top corners must be corners of the lid as well, or the
        // two are not describing the same solid.
        const top = pointsOf(face.path).slice(0, 2);
        for (const [x, y] of top) {
          const shared = lid.some(([lx, ly]) => Math.abs(lx - x) < 0.02 && Math.abs(ly - y) < 0.02);
          expect(shared).toBe(true);
        }
      }
    }
  });

  /*
   * The casings are drawn as rounded rects pushed through `faceTransform`, not
   * as the quad paths, because only a rect can carry an `rx`. That is only sound
   * if the transform lands the rect exactly on the quad — otherwise the corners
   * would be rounded but the panel would sit slightly off its own edges, which
   * shows up as hairline gaps along the seams between faces.
   */
  it('maps a plain rect onto the face it is describing', () => {
    const apply = (t: string, x: number, y: number): [number, number] => {
      const [, cx, cy] = t.match(/translate\((-?[\d.]+) (-?[\d.]+)\)/)!.map(Number);
      const skew = Number(t.match(/skewY\((-?[\d.]+)\)/)![1]);
      const sx = Number(t.match(/scale\((-?[\d.]+) 1\)/)![1]);
      const px = x * sx;
      return [cx + px, cy + y + px * Math.tan((skew * Math.PI) / 180)];
    };

    for (let i = 0; i < 360; i += 3) {
      const theta = (i / 180) * Math.PI;
      for (const face of at(theta)) {
        const localW = face.id === 'front' || face.id === 'back' ? W : D;
        // Rect corners in the order the quad path lists them: both tops, then
        // the two base corners right to left.
        const corners = [
          [-localW / 2, -H / 2],
          [localW / 2, -H / 2],
          [localW / 2, H / 2],
          [-localW / 2, H / 2],
        ].map(([lx, ly]) => apply(faceTransform(face), lx, ly));
        const quad = pointsOf(face.path);
        // The rect may be laid on mirrored, so accept either winding.
        const forward = corners.every((c, k) => Math.abs(c[0] - quad[k][0]) < 0.02 && Math.abs(c[1] - quad[k][1]) < 0.02);
        const mirrored = corners.every((c, k) => {
          const m = quad[[1, 0, 3, 2][k]];
          return Math.abs(c[0] - m[0]) < 0.02 && Math.abs(c[1] - m[1]) < 0.02;
        });
        expect(forward || mirrored).toBe(true);
      }
    }
  });

  it('rests the nearest corner of the box on the platter', () => {
    for (let i = 0; i < 360; i += 7) {
      const faces = at((i / 180) * Math.PI);
      const baseYs = faces.flatMap((f) => pointsOf(f.path).slice(2).map(([, y]) => y));
      // Depths are measured from the nearest corner, so the lowest point of the
      // body is exactly the platter, never below it.
      expect(Math.max(...baseYs)).toBeCloseTo(0, 4);
    }
  });
});
