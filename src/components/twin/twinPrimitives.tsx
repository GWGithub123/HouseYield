/**
 * Drawing primitives shared by every twin section.
 *
 * These were private to `HouseCutaway`, which was fine while there was one
 * drawing. There are now two — the oblique house cutaway and the multifamily
 * side elevation — and they have to agree about the projection, the palette and
 * what a bath looks like, or the two views stop reading as the same building
 * seen two ways. Sharing the axis and the materials is what makes a pile of
 * rectangles read as objects sitting in a room; sharing them across files is
 * what stops the building view from drifting into a different drawing.
 *
 * Nothing here knows about rooms, units, floors or devices. It is geometry,
 * colour and furniture.
 */
import { DX, DY, fixtureAnchor, type Fixture, type FixtureKind } from './houseModel';

/* ── projection ──────────────────────────────────────────────────── */

/**
 * Project a point into the scene. `f` is how deep the object is as a fraction
 * of the room depth, so a fence rail (thin) and a floor slab (a whole room
 * deep) recede along the same axis by different amounts. Sharing the axis is
 * what keeps the drawing coherent; sharing the *distance* is what made the
 * fence look like a lattice the size of the house.
 */
export const back = (x: number, y: number, f = 1) => `${x + DX * f} ${y - DY * f}`;

/**
 * Silhouette of the box a room sweeps out — the front opening plus the strip of
 * ceiling and side wall the projection exposes behind it.
 *
 * Anything that wants to describe the room as a *space* rather than as a face
 * needs this outline: a plain rectangle covers only the opening, which is why a
 * tinted room used to read as a coloured panel hung in front of the furniture
 * instead of as air inside the room.
 */
function recede(
  room: { depthDx?: number; depthDy?: number },
  x: number,
  y: number,
  f = 1,
): string {
  const dx = room.depthDx ?? DX;
  const dy = room.depthDy ?? DY;
  return `${x + dx * f} ${y - dy * f}`;
}

export function roomVolumePath(room: { x: number; y: number; w: number; h: number; depthDx?: number; depthDy?: number }): string {
  const { x, y, w, h } = room;
  const b = y + h;
  return `M${x} ${b} L${x} ${y} L${recede(room, x, y)} L${recede(room, x + w, y)} L${recede(room, x + w, b)} L${x + w} ${b} Z`;
}

/**
 * The room's floor as a receding plane, rather than the line the front edge
 * draws. Anything that lies *on* the floor — a pool of water, a stain — has to
 * sit on this quad or it reads as a stripe painted up the wall.
 */
export function roomFloorPath(room: { x: number; y: number; w: number; h: number; depthDx?: number; depthDy?: number }): string {
  const { x, y, w, h } = room;
  const b = y + h;
  return `M${x} ${b} L${x + w} ${b} L${recede(room, x + w, b)} L${recede(room, x, b)} Z`;
}

/**
 * The strip of ceiling the projection exposes behind the room's front edge —
 * where water coming from the floor above actually appears.
 */
export function roomCeilingPath(room: { x: number; y: number; w: number; depthDx?: number; depthDy?: number }): string {
  const { x, y, w } = room;
  return `M${x} ${y} L${x + w} ${y} L${recede(room, x + w, y)} L${recede(room, x, y)} Z`;
}

/* ── palette ─────────────────────────────────────────────────────── */

export const INK = '#1e40af';
export const LINE = '#3b82f6';
export const SOFT = '#93c5fd';
export const WALL = '#dbeafe';
export const ROOM_FILL = '#f8fbff';
export const FLOOR_FILL = '#e0ecfd';
export const SOIL = '#eef2f7';

/* ── fixtures ────────────────────────────────────────────────────── */

export const METAL = '#cbd5e1';
export const METAL_DARK = '#94a3b8';

/**
 * Fixture depth, matching the direction the rooms recede in. Everything is lit
 * from the front-upper-left, so for any solid the top face is the lightest, the
 * front is mid and the right-hand return is darkest. Keeping that consistent is
 * what makes a pile of rectangles read as objects sitting in a room.
 */
const BD = 11;
const BT = 7;

interface Material {
  front: string;
  top: string;
  side: string;
}

/**
 * Each material spans a wide value range on purpose. A narrow, uniformly pale
 * palette flattens the drawing no matter how correct the geometry is — the
 * sense of volume comes from the gap between the top and side faces.
 */
const MAT: Record<string, Material> = {
  appliance: { front: '#c8d6e8', top: '#eaf1f9', side: '#8698ae' },
  metal: { front: '#b6c3d3', top: '#dde5ef', side: '#75879c' },
  cabinet: { front: '#bed5f4', top: '#e7f0ff', side: '#7fa3d6' },
  soft: { front: '#a7c5ef', top: '#d3e3fb', side: '#7194c8' },
  porcelain: { front: '#dfe9f6', top: '#fbfdff', side: '#a0b3ca' },
  dark: { front: '#334155', top: '#4a5a6f', side: '#18212f' },
};

/** Approximate footprint width per fixture, used for the contact shadow. */
const SHADOW_W: Partial<Record<FixtureKind, number>> = {
  water_heater: 42, furnace: 48, panel: 0, washer: 46, dryer: 46, sump: 0,
  fridge: 38, counter: 94, sink: 0, stove: 40, tub: 64, toilet: 24,
  vanity: 48, bed: 82, sofa: 78, tv: 0, table: 64, door: 0, stairs: 50,
};

/**
 * Axonometric box with its front-bottom-left corner at (x, y).
 * Faces are drawn back-to-front so the front panel always wins.
 */
export function Box({
  x, y, w, h, d = BD, mat, rx = 0,
}: {
  x: number; y: number; w: number; h: number; d?: number; mat: Material; rx?: number;
}) {
  const t = d * (BT / BD);
  return (
    <g>
      <path
        d={`M${x} ${y - h} L${x + d} ${y - h - t} L${x + w + d} ${y - h - t} L${x + w} ${y - h} Z`}
        fill={mat.top}
        stroke={mat.side}
        strokeWidth={0.75}
        strokeLinejoin="round"
      />
      <path
        d={`M${x + w} ${y - h} L${x + w + d} ${y - h - t} L${x + w + d} ${y - t} L${x + w} ${y} Z`}
        fill={mat.side}
        stroke={mat.side}
        strokeWidth={0.75}
        strokeLinejoin="round"
      />
      <rect x={x} y={y - h} width={w} height={h} rx={rx} fill={mat.front} stroke={mat.side} strokeWidth={0.75} />
    </g>
  );
}

/** Upright cylinder — an ellipse cap plus a shaded barrel reads round. */
export function Cylinder({
  x, y, w, h, mat,
}: {
  x: number; y: number; w: number; h: number; mat: Material;
}) {
  const rx = w / 2;
  const ry = Math.max(3.5, w * 0.17);
  return (
    <g>
      <rect x={x} y={y - h} width={w} height={h} fill={`url(#hy-cyl-${mat === MAT.metal ? 'metal' : 'app'})`} />
      <path d={`M${x} ${y - h} v${h}`} stroke={mat.side} strokeWidth={0.75} fill="none" />
      <path d={`M${x + w} ${y - h} v${h}`} stroke={mat.side} strokeWidth={0.75} fill="none" />
      <ellipse cx={x + rx} cy={y} rx={rx} ry={ry} fill={mat.side} />
      <ellipse cx={x + rx} cy={y - h} rx={rx} ry={ry} fill={mat.top} stroke={mat.side} strokeWidth={0.75} />
    </g>
  );
}

/** Every glyph is drawn with its baseline centered on the origin. */
export function FixtureGlyph({ kind }: { kind: FixtureKind }) {
  const s = { fill: WALL, stroke: LINE, strokeWidth: 1.3 };
  const metal = { fill: METAL, stroke: METAL_DARK, strokeWidth: 1.2 };

  switch (kind) {
    case 'water_heater':
      return (
        <g>
          <Cylinder x={-19} y={0} w={38} h={60} mat={MAT.metal} />
          <path d="M-8 -66 v-12 h18" fill="none" stroke={METAL_DARK} strokeWidth={2.6} strokeLinecap="round" />
          <rect x={-11} y={-36} width={22} height={12} rx={2} fill="#f8fafc" stroke={METAL_DARK} strokeWidth={0.9} />
          <circle cx={0} cy={-13} r={3.2} fill="#f8fafc" stroke={METAL_DARK} strokeWidth={0.9} />
        </g>
      );
    case 'furnace':
      return (
        <g>
          <Box x={-22} y={0} w={44} h={56} mat={MAT.metal} rx={2} />
          <path d="M-8 -63 v-14 h16" fill="none" stroke={METAL_DARK} strokeWidth={2.6} strokeLinecap="round" />
          {[0, 1, 2, 3].map((i) => (
            <path key={i} d={`M-14 ${-46 + i * 7} h28`} stroke={MAT.metal.side} strokeWidth={1} opacity={0.75} />
          ))}
          <rect x={-14} y={-17} width={28} height={11} rx={1.5} fill="#f1f5f9" stroke={MAT.metal.side} strokeWidth={0.9} />
        </g>
      );
    case 'panel':
      return (
        <g>
          <Box x={-13} y={0} w={26} h={33} d={5} mat={MAT.metal} rx={1.5} />
          <path d="M0 -32 v31" stroke={MAT.metal.side} strokeWidth={0.8} opacity={0.7} />
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <rect x={-10} y={-28 + i * 7} width={8} height={4} rx={1} fill="#f8fafc" />
              <rect x={2} y={-28 + i * 7} width={8} height={4} rx={1} fill="#f8fafc" />
            </g>
          ))}
        </g>
      );
    case 'washer':
    case 'dryer':
      return (
        <g>
          <Box x={-21} y={0} w={42} h={47} mat={MAT.appliance} rx={2} />
          <rect x={-16} y={-43} width={32} height={7} rx={1.5} fill="#f8fafc" stroke={MAT.appliance.side} strokeWidth={0.8} />
          <circle cx={0} cy={-21} r={12.5} fill="#f8fafc" stroke={MAT.appliance.side} strokeWidth={1.1} />
          <circle cx={0} cy={-21} r={8} fill="#dbe4ef" opacity={kind === 'dryer' ? 0.5 : 0.9} />
        </g>
      );
    case 'sump':
      return (
        <g>
          <ellipse cx={0} cy={0} rx={20} ry={7} fill="#b8c6d6" />
          <ellipse cx={0} cy={-1.5} rx={15} ry={5} fill="#1e3a8a" opacity={0.32} />
          <path d="M0 -4 v-30 h14" fill="none" stroke={METAL_DARK} strokeWidth={2.4} strokeLinecap="round" />
        </g>
      );
    case 'fridge':
      return (
        <g>
          <Box x={-17} y={0} w={34} h={60} mat={MAT.appliance} rx={2} />
          <path d="M-17 -38 h34" stroke={MAT.appliance.side} strokeWidth={1} />
          <path d="M11 -34 v9 M11 -53 v9" stroke={MAT.appliance.side} strokeWidth={1.8} strokeLinecap="round" />
        </g>
      );
    case 'counter':
      // Worktop overhangs the cabinet run, which is what sells it as a solid.
      return (
        <g>
          <Box x={-44} y={-4} w={88} h={24} mat={MAT.cabinet} />
          <Box x={-46} y={-28} w={92} h={4} mat={MAT.porcelain} />
          <path d="M-16 -28 v24 M16 -28 v24" stroke={MAT.cabinet.side} strokeWidth={0.9} opacity={0.8} />
        </g>
      );
    case 'sink':
      return (
        <g>
          <path d="M-15 -10 h30 v7 q0 3 -3 3 h-24 q-3 0 -3 -3 Z" fill="#c4d3e6" stroke={MAT.porcelain.side} strokeWidth={0.9} />
          <ellipse cx={0} cy={-10} rx={15} ry={3.4} fill="#f8fafc" stroke={MAT.porcelain.side} strokeWidth={0.9} />
          <path d="M0 -12 v-10 q0 -4 7 -4" fill="none" stroke={METAL_DARK} strokeWidth={1.8} strokeLinecap="round" />
        </g>
      );
    case 'stove':
      // Burners live on the top face so the cooktop reads as a horizontal plane.
      return (
        <g>
          <Box x={-18} y={0} w={36} h={30} mat={MAT.appliance} rx={2} />
          {[-8, 7].map((bx, i) => (
            <ellipse
              key={bx}
              cx={bx + BD * 0.5}
              cy={-30 - BT * 0.5 + i * 0}
              rx={6}
              ry={3}
              fill="none"
              stroke={MAT.appliance.side}
              strokeWidth={1.1}
            />
          ))}
          <rect x={-14} y={-26} width={28} height={8} rx={1.5} fill="#f8fafc" stroke={MAT.appliance.side} strokeWidth={0.8} />
        </g>
      );
    case 'tub':
      return (
        <g>
          <Box x={-30} y={0} w={60} h={20} mat={MAT.porcelain} rx={3} />
          <path
            d={`M${-26} ${-20} L${-26 + BD} ${-20 - BT} L${26 + BD} ${-20 - BT} L${26} ${-20} Z`}
            fill="#dbeafe"
            stroke={MAT.porcelain.side}
            strokeWidth={0.9}
          />
          <path d="M-30 -22 q-5 -2 -5 -8" fill="none" stroke={METAL_DARK} strokeWidth={1.6} strokeLinecap="round" />
        </g>
      );
    case 'toilet':
      return (
        <g>
          <Box x={-9} y={-16} w={18} h={15} d={7} mat={MAT.porcelain} rx={1.5} />
          <Box x={-10} y={0} w={20} h={16} d={9} mat={MAT.porcelain} rx={5} />
          <ellipse cx={-1 + 4} cy={-16 - 3} rx={8} ry={3.4} fill="#f8fafc" stroke={MAT.porcelain.side} strokeWidth={0.8} />
        </g>
      );
    case 'vanity':
      return (
        <g>
          <Box x={-22} y={0} w={44} h={24} mat={MAT.cabinet} />
          <Box x={-24} y={-26} w={48} h={4} mat={MAT.porcelain} />
          <ellipse cx={0 + BD * 0.5} cy={-30 - BT * 0.4} rx={9} ry={3.6} fill="#f8fafc" stroke={MAT.porcelain.side} strokeWidth={0.8} />
        </g>
      );
    case 'bed':
      return (
        <g>
          <Box x={-38} y={0} w={76} h={16} d={16} mat={MAT.cabinet} rx={2} />
          <Box x={-38} y={-16} w={76} h={7} d={16} mat={MAT.soft} rx={3} />
          <Box x={-40} y={-16} w={9} h={26} d={16} mat={MAT.cabinet} rx={2} />
          <path
            d={`M${-24} ${-23} L${-24 + 10} ${-23 - 6} L${-2 + 10} ${-23 - 6} L${-2} ${-23} Z`}
            fill="#f8fafc"
            stroke={MAT.soft.side}
            strokeWidth={0.8}
          />
        </g>
      );
    case 'sofa':
      return (
        <g>
          <Box x={-35} y={0} w={70} h={13} d={15} mat={MAT.cabinet} rx={2} />
          <Box x={-35} y={-13} w={70} h={6} d={15} mat={MAT.soft} rx={3} />
          <Box x={-38} y={-13} w={8} h={17} d={15} mat={MAT.cabinet} rx={3} />
          <Box x={30} y={-13} w={8} h={17} d={15} mat={MAT.cabinet} rx={3} />
        </g>
      );
    case 'tv':
      return (
        <g>
          <Box x={-26} y={-9} w={52} h={29} d={4} mat={MAT.dark} rx={2} />
          <rect x={-22} y={-34} width={44} height={21} rx={1.5} fill="#3f5470" />
          <path d="M-16 -28 l8 8 l6 -5 l10 11" fill="none" stroke="#7dd3fc" strokeWidth={1.4} strokeLinecap="round" />
          <path d="M0 -9 v6 M-11 -3 h22" stroke={MAT.dark.side} strokeWidth={2} strokeLinecap="round" />
        </g>
      );
    case 'table':
      return (
        <g>
          <Box x={-30} y={-18} w={60} h={5} d={14} mat={MAT.cabinet} rx={1.5} />
          <path d="M-24 -18 v18 M24 -18 v18" stroke={MAT.cabinet.side} strokeWidth={2.2} strokeLinecap="round" />
          {[-15, 15].map((x) => (
            <g key={x}>
              <Box x={x - 8} y={-11} w={16} h={4} d={8} mat={MAT.soft} rx={1.5} />
              <path d={`M${x} -7 v7`} stroke={MAT.cabinet.side} strokeWidth={1.5} strokeLinecap="round" />
            </g>
          ))}
        </g>
      );
    case 'door':
      // Sits in the plane of the wall, so it gets a reveal rather than a box.
      return (
        <g>
          <path
            d={`M-15 0 L-15 -58 L${-15 + 7} ${-58 - 4} L${15 + 7} ${-58 - 4} L15 -58 L15 0 Z`}
            fill="#cfe0f8"
            stroke={MAT.cabinet.side}
            strokeWidth={0.9}
            strokeLinejoin="round"
          />
          <rect x={-15} y={-58} width={30} height={58} rx={1.5} fill="#e6effc" stroke={LINE} strokeWidth={1.3} />
          <rect x={-10} y={-52} width={20} height={20} rx={1.5} fill="none" stroke={SOFT} strokeWidth={1} />
          <circle cx={9} cy={-28} r={2.2} fill={LINE} />
        </g>
      );
    case 'stairs':
      return (
        <g>
          {[0, 1, 2, 3, 4].map((i) => (
            <Box key={i} x={-22 + i * 9} y={-i * 8} w={9} h={8} d={7} mat={MAT.cabinet} />
          ))}
        </g>
      );
    default:
      return null;
  }
}

/** Mechanicals whose flooding is a replacement rather than a mop-up. */
const CRITICAL_KINDS = new Set<FixtureKind>(['furnace', 'water_heater', 'panel']);

export function FixtureLayer({ fixtures, waterY }: { fixtures: Fixture[]; waterY?: number | null }) {
  return (
    <>
      {fixtures.map((f, i) => {
        const shadowW = SHADOW_W[f.kind] ?? 0;
        const a = fixtureAnchor(f);
        /*
         * Submersion is judged on the un-projected baseline, not the drawn one.
         * Water finds one level across the whole room, so a wardrobe against the
         * back wall floods at the same moment as one by the door even though the
         * projection draws it higher up the page.
         */
        const submerged = waterY != null && f.y >= waterY;
        const flagged = submerged && CRITICAL_KINDS.has(f.kind);
        return (
          <g
            key={`${f.kind}-${i}`}
            transform={`translate(${a.x} ${a.y})${f.scale ? ` scale(${f.scale})` : ''}${f.flip ? ' scale(-1 1)' : ''}`}
          >
            {/* Contact shadow — cheap, and the single biggest cue that an
                object is resting on the floor rather than floating on it. */}
            {shadowW > 0 && (
              <ellipse
                cx={BD * 0.4}
                cy={-1}
                rx={shadowW / 2}
                ry={Math.max(3.5, shadowW * 0.07)}
                fill="#1e3a8a"
                opacity={0.14}
              />
            )}
            <FixtureGlyph kind={f.kind} />
            {flagged && (
              <g>
                <circle cy={-74} r={11} fill="#dc2626" stroke="#fff" strokeWidth={2} />
                <path
                  d="M0 -80 v7"
                  stroke="#fff"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                />
                <circle cy={-69} r={1.5} fill="#fff" />
                <animate attributeName="opacity" values="1;0.45;1" dur="1.8s" repeatCount="indefinite" />
              </g>
            )}
          </g>
        );
      })}
    </>
  );
}

/* ── leak exposure ───────────────────────────────────────────────── */

export const EXPOSURE_INK = '#b45309';
export const EXPOSURE_WASH = '#f59e0b';

/**
 * Likelihood at or above which an exposed space is captioned.
 *
 * Set so that the spaces immediately below a leak are named and the weaker,
 * further-away flags are left to the marks alone.
 */
export const EXPOSURE_LABEL_MIN = 0.4;

/* ── exposure as discrete steps ──────────────────────────────────── */

/**
 * Observed water, as distinct from inferred exposure.
 *
 * A different hue, not a stronger amber. These are different kinds of claim: one
 * is a sensor reporting water, the other is us reasoning about where water
 * probably went. A manager who cannot tell them apart at a glance will either
 * treat our arithmetic as a measurement or ignore a real alarm, and both of
 * those are worse than saying nothing.
 */
export const OBSERVED_WASH = '#ef4444';
export const OBSERVED_INK = '#b91c1c';

export type ExposureStepId = 'likely' | 'possible' | 'unlikely';

export interface ExposureStep {
  id: ExposureStepId;
  /** Words a manager would use, not a number. */
  label: string;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  /** Ink that still reads on top of this fill. */
  ink: string;
}

/**
 * Three steps, ordered strongest first.
 *
 * The continuous likelihood the engine produces is real, and showing it
 * continuously was a mistake. A fill whose opacity tracks a float means two
 * neighbouring units differ by an amount nobody can see and nobody could act on
 * differently, while implying a precision the model does not have — it is a
 * propagation heuristic over a stacking plan someone typed in, not a flow
 * simulation.
 *
 * Three steps is what the decision actually has: go now, go after those, and
 * be aware. Anything finer is a number pretending to be a colour, and anything
 * coarser loses the difference between the stack under the leak and the rest of
 * the floor.
 */
export const EXPOSURE_STEPS: ExposureStep[] = [
  {
    id: 'likely',
    label: 'Likely wet',
    fill: '#f59e0b',
    // Enough to dominate a scan, not enough to erase the furniture underneath —
    // a flagged unit still has to look like an apartment somebody lives in.
    fillOpacity: 0.44,
    stroke: '#b45309',
    strokeWidth: 2,
    ink: '#7c2d12',
  },
  {
    id: 'possible',
    label: 'Possible',
    fill: '#fbbf24',
    fillOpacity: 0.3,
    stroke: '#d97706',
    strokeWidth: 1.5,
    ink: '#92400e',
  },
  {
    id: 'unlikely',
    label: 'Watch',
    fill: '#fde68a',
    fillOpacity: 0.32,
    stroke: '#f59e0b',
    strokeWidth: 1.1,
    ink: '#92400e',
  },
];

/**
 * Cutoffs for the three steps, and the floor below which nothing is drawn.
 *
 * The floor matters as much as the steps. The engine assigns a small lateral
 * likelihood to a lot of units, and on a 300-unit building that tints most of
 * the drawing faintly — which reads as "the whole building is affected" when the
 * model is saying almost the opposite. Below this, the honest mark is no mark.
 */
export const EXPOSURE_MIN = 0.09;
const LIKELY_MIN = 0.55;
const POSSIBLE_MIN = 0.28;

/** Which step a likelihood falls in, or null when it is not worth a mark. */
export function exposureStep(likelihood: number): ExposureStep | null {
  if (!(likelihood > EXPOSURE_MIN)) return null;
  if (likelihood >= LIKELY_MIN) return EXPOSURE_STEPS[0];
  if (likelihood >= POSSIBLE_MIN) return EXPOSURE_STEPS[1];
  return EXPOSURE_STEPS[2];
}

/**
 * A patch of water on a receding plane — a ceiling stain, or a pool on a floor.
 *
 * This replaced a diagonal hatch over the whole room volume, which was wrong
 * twice over. It read as striped wallpaper filling the room rather than as
 * water, and it collided with the drawing's own language: the shell, roof and
 * partitions are already hatched with 45 degree hairlines, so an amber hatch was
 * more of the same texture in a different colour rather than a new kind of mark.
 *
 * A flat fill of the whole ceiling and floor was the next attempt and was also
 * wrong, because water does not uniformly coat a ceiling. It comes through at
 * the place two spaces overlap and spreads from there, so a patch centred on
 * that place says something a full-surface wash cannot, namely *where to put the
 * ladder*.
 *
 * Squashed to roughly a third of its width because it lies on a plane that
 * recedes along the drawing's projection — the same ratio the sump pit and the
 * basin ellipses use. Drawn as a radial fade so the edge is soft; a hard-edged
 * ellipse reads as a sticker stuck to the drawing.
 */
export function ExposureStain({
  cx,
  cy,
  strength,
  id,
  spread = 1,
  hostW,
}: {
  cx: number;
  cy: number;
  /** Exposure likelihood, 0..1. Drives both size and density. */
  strength: number;
  id: string;
  /** Widens the patch without making it denser, for water that ran sideways. */
  spread?: number;
  /**
   * Width of the space the patch sits in.
   *
   * Caps the patch so it stays a patch. A radius tuned to a house room is most of
   * an apartment bay, and a stain that fills its own room says "this space is
   * wet" — which is the language reserved for a room that is actually reporting.
   * The inference has to stay visibly smaller than the observation.
   */
  hostW?: number;
}) {
  const wanted = (24 + strength * 42) * spread;
  const rx = hostW ? Math.min(wanted, hostW * 0.38) : wanted;
  return (
    <g>
      <radialGradient id={`hy-stain-${id}`}>
        <stop offset="0%" stopColor={EXPOSURE_WASH} stopOpacity={0.34 + strength * 0.46} />
        <stop offset="55%" stopColor={EXPOSURE_WASH} stopOpacity={0.2 + strength * 0.3} />
        <stop offset="100%" stopColor={EXPOSURE_WASH} stopOpacity={0} />
      </radialGradient>
      <ellipse cx={cx} cy={cy} rx={rx} ry={rx * 0.34} fill={`url(#hy-stain-${id})`} />
      {/* A darker rim, well inside the fade. Standing water has an edge, and
          without one the patch reads as a glow rather than as a wet area. */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx * 0.62}
        ry={rx * 0.62 * 0.34}
        fill="none"
        stroke={EXPOSURE_INK}
        strokeWidth={1.3}
        opacity={0.2 + strength * 0.35}
      />
    </g>
  );
}

/**
 * The washed volume above a stain — water entering from the floor above.
 *
 * Gone by just past halfway down. Carrying it to the floor turns it back into a
 * filled box, and the point is that the water is at the top.
 */
export function ExposureFromAbove({
  id,
  volumePath,
  top,
  bottom,
  left,
  strength,
}: {
  id: string;
  volumePath: string;
  /** Top of the wash, which is the ceiling *behind* the front edge. */
  top: number;
  bottom: number;
  left: number;
  strength: number;
}) {
  return (
    <>
      <linearGradient
        id={`hy-exposure-${id}`}
        gradientUnits="userSpaceOnUse"
        x1={left}
        y1={top}
        x2={left}
        y2={bottom}
      >
        <stop offset="0%" stopColor={EXPOSURE_WASH} stopOpacity={0.3 * strength} />
        <stop offset="20%" stopColor={EXPOSURE_WASH} stopOpacity={0.13 * strength} />
        <stop offset="46%" stopColor={EXPOSURE_WASH} stopOpacity={0} />
      </linearGradient>
      <path d={volumePath} fill={`url(#hy-exposure-${id})`} />
    </>
  );
}
