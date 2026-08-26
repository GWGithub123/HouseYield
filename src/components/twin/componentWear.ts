/**
 * Where a component actually is on the drawing, and what its condition looks like.
 *
 * The first version of this zoomed to a component and then drew a synthetic box on
 * a turntable in front of it. That was wrong twice over: a roof is not a box, and
 * substituting an abstract object for the real geometry threw away the one thing
 * the cutaway already had — an actual roof, in an actual place, on an actual house.
 *
 * So nothing is substituted here. `componentRegion` reports the real geometry so
 * the camera can frame it, and the wear is drawn onto those same surfaces. The
 * marks are generated from the component's remaining life, which is what makes the
 * close-up worth having: a roof at four years and a roof at twenty-two are the same
 * shape, and if they render identically then zooming in has told you nothing.
 */
import {
  DX,
  DY,
  FLOOR_BANDS,
  INTERIOR_LEFT,
  METER,
  SHELL,
  VALVE_CENTER,
  VB_H,
  VB_W,
  fixtureAnchor,
  type FixtureKind,
  type RoomDef,
} from './houseModel';
import type { PropertyHealthCategory } from '../../types/propertyHealth';

/** Roof deck thickness, mirroring the constant the cutaway draws with. */
const ROOF_T = 13;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A drawn surface, as a parallelogram.
 *
 * Every face in this projection is one: a rectangle in the world, sheared by the
 * oblique. Holding them as an origin plus two edge vectors means a mark can be
 * placed at a fraction across and a fraction down without knowing whether it is
 * landing on a roof slope, a wall, or the front of a boiler.
 */
export interface Surface {
  /** Origin corner. For a roof slope this is the eave end. */
  ox: number;
  oy: number;
  /** Along the surface — up the slope, or across a wall. */
  ux: number;
  uy: number;
  /** Across the surface, into the projection's depth. */
  vx: number;
  vy: number;
}

export interface ComponentRegion {
  /** What the camera should frame. */
  box: Box;
  /** The surfaces wear belongs on. Empty when the component is not drawn. */
  surfaces: Surface[];
  /** True when these are real drawn geometry rather than a boxed-off area. */
  literal: boolean;
}

export function surfacePath(s: Surface): string {
  const p = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  return `M${p(s.ox, s.oy)} L${p(s.ox + s.ux, s.oy + s.uy)} `
    + `L${p(s.ox + s.ux + s.vx, s.oy + s.uy + s.vy)} L${p(s.ox + s.vx, s.oy + s.vy)} Z`;
}

/** A point on a surface. `u` runs along it, `v` across it, both 0-1. */
export function onSurface(s: Surface, u: number, v: number): { x: number; y: number } {
  return { x: s.ox + s.ux * u + s.vx * v, y: s.oy + s.uy * u + s.vy * v };
}

/**
 * Bounds of some surfaces, padded, and never reaching past the artwork.
 *
 * The clamp is what keeps the camera honest. A water heater stands close enough to
 * the bottom of the drawing that its breathing room falls off the edge, and a
 * region the camera cannot reach is a region the camera cannot frame — it would
 * spend the rest of its life failing to contain a box made mostly of blank space.
 */
function boxOf(surfaces: Surface[], pad = 0): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of surfaces) {
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      const p = onSurface(s, u, v);
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  return clampToArtwork({
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2,
  });
}

function clampToArtwork(box: Box): Box {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return { x, y, w: Math.min(VB_W, box.x + box.w) - x, h: Math.min(VB_H, box.y + box.h) - y };
}

/** A box standing on the drawing, as a front face plus its depth. */
function facing(x: number, y: number, w: number, h: number): Surface {
  // `uy` negative because a surface's `u` runs upward from its base, matching the
  // roof slopes so wear generated for one works unchanged on the other.
  return { ox: x, oy: y + h, ux: 0, uy: -h, vx: w, vy: 0 };
}

const CATEGORY_FIXTURE: Partial<Record<PropertyHealthCategory, FixtureKind>> = {
  water_heater: 'water_heater',
  hvac: 'furnace',
  air_filter: 'furnace',
  electrical: 'panel',
};

/**
 * The two roof slopes, exactly as the cutaway draws them.
 *
 * `u` runs from the eave up to the ridge, so anything that runs downhill — a
 * streak, a run of granule loss below a lifted tab — is generated the same way on
 * both slopes despite them facing opposite directions.
 */
function roofSurfaces(): Surface[] {
  const { roofLeft: L, roofRight: R, roofPeak: P } = SHELL;
  return [
    { ox: L.x, oy: L.y, ux: P.x - L.x, uy: P.y - L.y, vx: DX, vy: -DY },
    { ox: R.x, oy: R.y, ux: P.x - R.x, uy: P.y - R.y, vx: DX, vy: -DY },
  ];
}

/**
 * The geometry for a category, and whether it is the real thing.
 *
 * `literal` is the honest part. The roof, the siding and the drawn appliances are
 * really there in the cutaway, so wear goes straight onto them. For a category
 * with no distinct geometry — the plumbing runs, the smart-home kit — there is
 * nothing to weather, and the caller shows a marker instead of pretending.
 */
export function componentRegion(
  category: PropertyHealthCategory,
  rooms: RoomDef[],
): ComponentRegion {
  if (category === 'roof') {
    const surfaces = roofSurfaces();
    const box = boxOf(surfaces, 26);
    // The rake boards hang below the slopes, so the frame has to include them or
    // the roof appears to be cut off along its own bottom edge.
    return { box: clampToArtwork({ ...box, h: box.h + ROOF_T }), surfaces, literal: true };
  }

  if (category === 'exterior') {
    // The front wall face, from the eave line down to grade.
    const surfaces = [facing(
      SHELL.wallLeft,
      SHELL.wallTop,
      SHELL.wallRight - SHELL.wallLeft,
      SHELL.grade - SHELL.wallTop,
    )];
    return { box: boxOf(surfaces, 30), surfaces, literal: true };
  }

  if (category === 'windows') {
    // The upper storey, where the section shows glazing on the front wall.
    const band = FLOOR_BANDS.upper;
    const surfaces = [facing(
      SHELL.wallLeft + 8,
      band.top + 18,
      SHELL.wallRight - SHELL.wallLeft - 16,
      band.bottom - band.top - 44,
    )];
    return { box: boxOf(surfaces, 34), surfaces, literal: true };
  }

  const wantedFixture = CATEGORY_FIXTURE[category];
  if (wantedFixture) {
    for (const room of rooms) {
      const fixture = room.fixtures.find((f) => f.kind === wantedFixture);
      if (!fixture) continue;
      const at = fixtureAnchor(fixture);
      // Sized to the drawn glyph so the wear sits on the appliance rather than
      // floating in the room around it.
      const w = category === 'air_filter' ? 54 : wantedFixture === 'panel' ? 46 : 62;
      const h = category === 'air_filter' ? 18 : wantedFixture === 'panel' ? 62 : 96;
      // A filter occupies the return slot near the top of the furnace rather than
      // the furnace's entire cabinet.
      const bottom = category === 'air_filter' ? at.y - 42 : at.y;
      const surfaces = [facing(at.x - w / 2, bottom - h, w, h)];
      return { box: boxOf(surfaces, 66), surfaces, literal: true };
    }
  }

  // Nothing distinct on the drawing. Frame the neighbourhood of the anchor so the
  // camera still goes somewhere sensible, but claim no surface to weather.
  const mainMid = (FLOOR_BANDS.main.top + FLOOR_BANDS.main.bottom) / 2;
  const at = category === 'plumbing'
    ? plumbingAnchor(rooms, mainMid)
    : category === 'smart_home'
      ? { x: METER.x - 120, y: mainMid }
      : { x: INTERIOR_LEFT + 120, y: mainMid };

  return {
    box: clampToArtwork({ x: at.x - 150, y: at.y - 110, w: 300, h: 220 }),
    surfaces: [],
    literal: false,
  };
}

/** The shutoff valve, or the wall the service enters through when there is no basement. */
function plumbingAnchor(rooms: RoomDef[], mainMid: number): { x: number; y: number } {
  return rooms.some((room) => room.floor === 'basement')
    ? { x: VALVE_CENTER.x, y: VALVE_CENTER.y }
    : { x: SHELL.wallLeft + 96, y: mainMid };
}

/* ── condition ─────────────────────────────────────────────────────── */

export type WearLevel = 'new' | 'settled' | 'worn' | 'failing' | 'overdue';

export function wearLevel(lifeUsedRatio: number | null): WearLevel {
  if (lifeUsedRatio == null) return 'settled';
  if (lifeUsedRatio >= 1) return 'overdue';
  if (lifeUsedRatio >= 0.85) return 'failing';
  if (lifeUsedRatio >= 0.6) return 'worn';
  if (lifeUsedRatio >= 0.3) return 'settled';
  return 'new';
}

export const WEAR_LEVEL_META: Record<WearLevel, { label: string; tint: string }> = {
  new: { label: 'As new', tint: '#10b981' },
  settled: { label: 'Settled in', tint: '#10b981' },
  worn: { label: 'Wearing', tint: '#f59e0b' },
  failing: { label: 'Near end of life', tint: '#f97316' },
  overdue: { label: 'Past expected life', tint: '#e11d48' },
};

/**
 * Deterministic noise.
 *
 * The marks have to be the same on every render. Anything drawn from `Math.random`
 * would reshuffle every frame the camera moves, and a roof whose damage crawls
 * around as you look at it is worse than no damage at all. Seeded from the
 * category, so two properties' roofs weather the same way — which is correct here,
 * because this is a diagram of a condition and not a photograph of one house.
 */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function seedOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export type WearMarkKind =
  /** Patchy loss of surface: granules off a shingle, paint off siding. */
  | 'blotch'
  /** A run of staining, downhill from where water sits or sheds. */
  | 'streak'
  /** An edge that has stopped lying flat. */
  | 'lift'
  /** Organic growth where damp lingers. */
  | 'moss'
  /** Corrosion, at the base of anything that has been sweating for years. */
  | 'rust'
  /** Somebody has already been up here to fix something. */
  | 'patch';

export interface WearMark {
  kind: WearMarkKind;
  /** Surface index the mark sits on. */
  surface: number;
  /** Path data in cutaway space, ready to draw. */
  d: string;
  /** 0-1, for opacity. Heavier as the component ages. */
  weight: number;
}

/** How many of each kind of mark a level shows, per surface. */
const COUNTS: Record<WearLevel, Partial<Record<WearMarkKind, number>>> = {
  new: {},
  settled: { blotch: 2 },
  worn: { blotch: 5, streak: 2 },
  failing: { blotch: 8, streak: 4, lift: 2, moss: 1 },
  overdue: { blotch: 11, streak: 6, lift: 4, moss: 3, patch: 2 },
};

/** What the marks are, in words, so the drawing is legible rather than decorative. */
export const WEAR_MARK_META: Record<WearMarkKind, { roof: string; generic: string }> = {
  blotch: { roof: 'Granule loss', generic: 'Surface breaking down' },
  streak: { roof: 'Algae streaking', generic: 'Staining and run-off' },
  lift: { roof: 'Tabs lifting at the edge', generic: 'Seals and edges failing' },
  moss: { roof: 'Moss holding damp', generic: 'Damp not drying out' },
  rust: { roof: 'Corrosion', generic: 'Corrosion at the base' },
  patch: { roof: 'Previous patch repairs', generic: 'Previous repairs' },
};

function blotch(s: Surface, u: number, v: number, r: number, rng: () => number): string {
  // An irregular closed blob rather than an ellipse: granule loss has a ragged
  // edge, and a clean oval reads as a sticker on the roof.
  const steps = 9;
  const pts: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = 0.62 + rng() * 0.7;
    const p = onSurface(
      s,
      u + Math.cos(a) * r * wobble * 0.14,
      v + Math.sin(a) * r * wobble * 0.5,
    );
    pts.push(`${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  return `${pts.join(' ')} Z`;
}

/**
 * Generates the wear for one component.
 *
 * Placement is biased low on the surface for everything that follows water: rain
 * concentrates towards the eaves, and rust starts at the bottom of a tank. Marks
 * scattered evenly would look like damage applied with a spray can rather than
 * damage that happened for a reason.
 */
export function buildWearMarks(
  category: PropertyHealthCategory,
  surfaces: Surface[],
  lifeUsedRatio: number | null,
): WearMark[] {
  const level = wearLevel(lifeUsedRatio);
  const counts = { ...COUNTS[level] };

  // Anything metal that has stood in a basement for years rusts before it blotches.
  if (category === 'water_heater' || category === 'hvac') {
    if (counts.blotch) {
      counts.rust = Math.max(1, Math.round(counts.blotch / 2));
      counts.blotch = Math.round(counts.blotch / 2);
    }
    delete counts.moss;
  }

  const rng = noise(seedOf(category));
  const marks: WearMark[] = [];
  const weight = level === 'overdue' ? 1 : level === 'failing' ? 0.82 : level === 'worn' ? 0.6 : 0.4;

  surfaces.forEach((s, index) => {
    for (const [kind, count] of Object.entries(counts) as Array<[WearMarkKind, number]>) {
      for (let i = 0; i < count; i += 1) {
        const v = 0.08 + rng() * 0.84;

        if (kind === 'blotch') {
          // Low on the surface, where water spends longest.
          const u = 0.06 + rng() ** 1.7 * 0.8;
          marks.push({ kind, surface: index, d: blotch(s, u, v, 0.5 + rng(), rng), weight });
          continue;
        }

        if (kind === 'streak') {
          // Downhill from a point, fading out before the edge.
          const from = 0.34 + rng() * 0.6;
          const a = onSurface(s, from, v);
          const b = onSurface(s, Math.max(0.02, from - 0.3 - rng() * 0.34), v + 0.02);
          marks.push({
            kind,
            surface: index,
            d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
            weight,
          });
          continue;
        }

        if (kind === 'lift') {
          // On the bottom edge, which is where a shingle or a seal goes first.
          const a = onSurface(s, 0.03, v);
          const c = onSurface(s, 0.1, v + 0.05);
          const b = onSurface(s, 0.03, v + 0.1);
          marks.push({
            kind,
            surface: index,
            d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
            weight,
          });
          continue;
        }

        // Moss holds at the eave and rust starts at the base, so both sit low on
        // the surface. Drawn as tight blobs rather than ellipses, so every mark in
        // the set is an absolute path over the same parameter space.
        if (kind === 'moss') {
          marks.push({ kind, surface: index, d: blotch(s, 0.04 + rng() * 0.1, v, 0.34, rng), weight });
          continue;
        }

        if (kind === 'rust') {
          marks.push({ kind, surface: index, d: blotch(s, 0.02 + rng() * 0.12, v, 0.3, rng), weight });
          continue;
        }

        // patch: a rectangle of newer material, squared up to the surface.
        const u = 0.2 + rng() * 0.5;
        const w = 0.1 + rng() * 0.1;
        const corners = [
          onSurface(s, u, v),
          onSurface(s, u + w * 1.6, v),
          onSurface(s, u + w * 1.6, v + w),
          onSurface(s, u, v + w),
        ];
        marks.push({
          kind,
          surface: index,
          d: `${corners.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} Z`,
          weight,
        });
      }
    }
  });

  return marks;
}

/** The distinct kinds present, for the on-canvas legend. */
export function wearFindings(marks: WearMark[], category: PropertyHealthCategory): string[] {
  const seen: WearMarkKind[] = [];
  for (const mark of marks) if (!seen.includes(mark.kind)) seen.push(mark.kind);
  return seen.map((kind) =>
    category === 'roof' ? WEAR_MARK_META[kind].roof : WEAR_MARK_META[kind].generic,
  );
}
