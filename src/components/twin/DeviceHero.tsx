/**
 * Close-up of a single device, slowly turning on the spot.
 *
 * This is the last rung of the zoom ladder: you have picked a room, then a
 * sensor in it, and the canvas is now framed on that one object. The rotation is
 * the point — a still icon at 4x is just a big icon, whereas something turning
 * reads as a physical thing being inspected, which is exactly the claim the view
 * is making.
 *
 * The turn is a real rotation about the vertical axis rather than a squash-and-
 * flip fake. That costs almost nothing here: rotating a box about a vertical
 * axis leaves every vertical edge vertical, so each visible face stays an
 * axis-aligned screen rectangle and the whole thing is four numbers per frame.
 * What it buys is that the proportions, the face ordering and the width of the
 * side return are all correct at every angle, so the object has consistent
 * volume instead of appearing to breathe as it goes round.
 */
import { useEffect, useState } from 'react';
import type { ShellyDevice } from '../../hooks/useShellyFirestore';
import {
  TILT,
  faceShade,
  faceTransform,
  facesFor,
  lidPath,
  mix,
  planMatrix,
  useTurntable,
  type Face,
  type FaceId,
} from './turntable';

// Re-exported so existing callers and tests keep their import path.
export { faceTransform, facesFor, lidPath, planMatrix, type Face, type FaceId };


export type HeroKind = 'flood' | 'gateway' | 'ht' | 'relay' | 'other';

export interface DeviceHeroProps {
  x: number;
  y: number;
  kind: HeroKind;
  device: ShellyDevice;
  /** Selection ring colour, matched to the pin you clicked. */
  tone: string;
  /** Draws the alarm treatment instead of the calm one. */
  alarming?: boolean;
  onDismiss?: () => void;
}


/* ── hardware ────────────────────────────────────────────────────── */

type Form = 'puck' | 'slab';

interface Spec {
  form: Form;
  /** Across, deep and tall, in canvas units. */
  W: number;
  D: number;
  H: number;
  /** Corner radius of the casing. */
  r: number;
}

/**
 * Rough physical proportions of each unit.
 *
 * Form factor is doing most of the work of making these read as hardware. A
 * leak sensor is a wide, low disc that sits flat on a floor; the battery sensors
 * are thin square tiles that stick to a wall. Drawing all of them as the same
 * upright box — which is what this used to do — is why they looked like icons on
 * blocks rather than devices, and no amount of shading fixes that.
 */
const SPEC: Record<HeroKind, Spec> = {
  flood: { form: 'puck', W: 62, D: 62, H: 19, r: 0 },
  // Wider than it is tall, because a square panel seen three-quarters on is
  // foreshortened and otherwise reads as a tall card rather than a square tile.
  ht: { form: 'slab', W: 50, D: 14, H: 42, r: 8 },
  gateway: { form: 'slab', W: 38, D: 17, H: 40, r: 7 },
  relay: { form: 'slab', W: 48, D: 23, H: 42, r: 5 },
  other: { form: 'slab', W: 40, D: 18, H: 40, r: 7 },
};

/** Matte white plastic, which is what all of this hardware actually is. */
const CASING = '#f3f5f8';
const EDGE = '#a3b2c4';

/* ── silkscreen ──────────────────────────────────────────────────── */

/**
 * Markings on the front panel.
 *
 * Small, grey and low contrast on purpose. The previous version filled the whole
 * face with a saturated blue glyph, which is the single thing that made the
 * object read as an icon pasted onto a box instead of a moulding with a mark
 * printed on it. Real devices are almost blank; the glyph is here only so you
 * can tell at a glance which one you are looking at.
 */
function Silkscreen({ kind, w, h }: { kind: HeroKind; w: number; h: number }) {
  const ink = '#9fb0c2';
  switch (kind) {
    case 'ht':
      return (
        <g fill="none" stroke={ink} strokeLinecap="round">
          {/* Vent slots over the humidity intake. */}
          {[-0.1, 0.06, 0.22].map((f) => (
            <path key={f} d={`M${-w * 0.2} ${h * f} h${w * 0.4}`} strokeWidth={h * 0.035} opacity={0.75} />
          ))}
          <path
            d={`M${-w * 0.07} ${-h * 0.34} v${h * 0.16} a ${h * 0.07} ${h * 0.07} 0 1 0 ${w * 0.14} 0 v${-h * 0.16} a ${h * 0.07} ${h * 0.07} 0 0 0 ${-w * 0.14} 0 Z`}
            strokeWidth={h * 0.03}
          />
        </g>
      );
    case 'gateway':
      return (
        <g fill="none" stroke={ink} strokeLinecap="round" strokeWidth={h * 0.035}>
          <path d={`M${-w * 0.17} ${-h * 0.08} a ${w * 0.17} ${w * 0.17} 0 0 1 ${w * 0.34} 0`} />
          <path d={`M${-w * 0.08} ${h * 0.03} a ${w * 0.08} ${w * 0.08} 0 0 1 ${w * 0.16} 0`} />
          <circle cx={0} cy={h * 0.1} r={h * 0.024} fill={ink} stroke="none" />
        </g>
      );
    case 'relay':
      return (
        <g>
          {[-0.24, -0.02, 0.2].map((f) => (
            <g key={f}>
              <rect
                x={-w * 0.3}
                y={h * f}
                width={w * 0.6}
                height={h * 0.12}
                rx={h * 0.02}
                fill="#dbe2ea"
                stroke={ink}
                strokeWidth={h * 0.014}
              />
              {[-0.16, 0.16].map((g) => (
                <circle key={g} cx={w * g} cy={h * (f + 0.06)} r={h * 0.026} fill="#8496aa" />
              ))}
            </g>
          ))}
        </g>
      );
    default:
      return (
        <circle cx={0} cy={-h * 0.06} r={h * 0.13} fill="none" stroke={ink} strokeWidth={h * 0.03} />
      );
  }
}

/**
 * The status light, in the place each unit actually carries one.
 *
 * Worth the trouble because it is the only part of the object that says anything
 * about state. Everything else is just a white box; a red pulse on the front of
 * a white box is instantly legible as a device in alarm.
 */
function Led({ cx, cy, r, alarming }: { cx: number; cy: number; r: number; alarming: boolean }) {
  const colour = alarming ? '#ef4444' : '#22c55e';
  return (
    <g>
      <circle cx={cx} cy={cy} r={r * 2.6} fill={colour} opacity={alarming ? 0.22 : 0.13}>
        {alarming && <animate attributeName="opacity" values="0.35;0.05;0.35" dur="1.1s" repeatCount="indefinite" />}
      </circle>
      <circle cx={cx} cy={cy} r={r} fill={colour}>
        {alarming && <animate attributeName="opacity" values="1;0.25;1" dur="1.1s" repeatCount="indefinite" />}
      </circle>
    </g>
  );
}

/* ── bodies ──────────────────────────────────────────────────────── */

/**
 * The leak sensor: a wide, low disc lying on the floor.
 *
 * A cylinder's outline does not change as it turns, so unlike the slabs there is
 * nothing in the silhouette to carry the rotation — it has to come entirely from
 * the markings on the top face sweeping round, which is exactly how a real
 * turntable shot of a round object reads.
 */
function Puck({ theta, spec, alarming }: { theta: number; spec: Spec; alarming: boolean }) {
  const R = spec.W / 2;
  const ry = R * TILT;
  const topCy = -spec.H - ry;
  const baseCy = -ry;
  const side = `M${-R} ${topCy.toFixed(2)} A ${R} ${ry.toFixed(2)} 0 0 0 ${R} ${topCy.toFixed(2)}`
    + ` L${R} ${baseCy.toFixed(2)} A ${R} ${ry.toFixed(2)} 0 0 1 ${-R} ${baseCy.toFixed(2)} Z`;

  return (
    <g>
      {/* Wall of the disc. Darkened towards the bottom, where a curved matte
          surface turns away from the light. */}
      <path d={side} fill="url(#hy-hero-drum)" stroke={EDGE} strokeWidth={0.7} />
      {/* Case seam, a hairline round the disc just above the base. */}
      <path
        d={`M${-R} ${(baseCy - spec.H * 0.34).toFixed(2)} A ${R} ${ry.toFixed(2)} 0 0 0 ${R} ${(baseCy - spec.H * 0.34).toFixed(2)}`}
        fill="none"
        stroke={EDGE}
        strokeWidth={0.5}
        opacity={0.7}
      />

      <g transform={planMatrix(theta, spec.W, spec.D, spec.H)}>
        <ellipse cx={0} cy={0} rx={R} ry={R} fill="#fafbfd" stroke={EDGE} strokeWidth={0.7} />
        {/* Moulded rings. Concentric in plan, so they come out as the nested
            ellipses a disc seen at an angle actually shows. */}
        <circle cx={0} cy={0} r={R * 0.82} fill="none" stroke="#dde4ec" strokeWidth={0.8} />
        <circle cx={0} cy={0} r={R * 0.5} fill="#f4f7fa" stroke="#e3e9f0" strokeWidth={0.7} />
        <path
          d={`M0 ${-R * 0.28} c ${R * 0.14} ${R * 0.19} ${R * 0.21} ${R * 0.28} ${R * 0.21} ${R * 0.36}`
            + ` a ${R * 0.21} ${R * 0.21} 0 0 1 ${-R * 0.42} 0`
            + ` c 0 ${-R * 0.08} ${R * 0.07} ${-R * 0.17} ${R * 0.21} ${-R * 0.36} Z`}
          fill="none"
          stroke="#a9b8c9"
          strokeWidth={0.9}
          strokeLinejoin="round"
        />
        <Led cx={0} cy={R * 0.66} r={R * 0.055} alarming={alarming} />
      </g>
    </g>
  );
}

/** The wall-mounted units: a thin tile with rounded corners. */
function Slab({
  theta,
  spec,
  kind,
  alarming,
}: {
  theta: number;
  spec: Spec;
  kind: HeroKind;
  alarming: boolean;
}) {
  const faces = facesFor(theta, spec.W, spec.D, spec.H);
  return (
    <g>
      {faces.map((face) => {
        const front = face.id === 'front';
        const localW = front || face.id === 'back' ? spec.W : spec.D;
        // Markings only read near square-on; fading them out as the panel turns
        // edge-on stops them smearing into a stripe.
        const legible = Math.min(1, Math.max(0, (face.facing - 0.14) / 0.3));
        return (
          <g key={face.id} transform={faceTransform(face)}>
            <rect
              x={-localW / 2}
              y={-spec.H / 2}
              width={localW}
              height={spec.H}
              rx={spec.r}
              fill={faceShade(face, theta, CASING)}
              stroke={EDGE}
              strokeWidth={0.7}
            />
            <rect
              x={-localW / 2}
              y={-spec.H / 2}
              width={localW}
              height={spec.H}
              rx={spec.r}
              fill="url(#hy-hero-sheen)"
            />
            {front && legible > 0.01 && (
              <g opacity={legible}>
                <Silkscreen kind={kind} w={spec.W} h={spec.H} />
                <Led cx={0} cy={spec.H * 0.4} r={spec.H * 0.035} alarming={alarming} />
              </g>
            )}
          </g>
        );
      })}
      {/* Lid last: the topmost surface at every angle, so it never has to take
          part in the depth sort. */}
      <g transform={planMatrix(theta, spec.W, spec.D, spec.H)}>
        <rect
          x={-spec.W / 2}
          y={-spec.D / 2}
          width={spec.W}
          height={spec.D}
          rx={spec.r}
          fill="#fbfcfd"
          stroke={EDGE}
          strokeWidth={0.7}
        />
      </g>
    </g>
  );
}

/* ── hero ────────────────────────────────────────────────────────── */

export default function DeviceHero({
  x,
  y,
  kind,
  device,
  tone,
  alarming = false,
  onDismiss,
}: DeviceHeroProps) {
  const theta = useTurntable(9000);
  const spec = SPEC[kind];

  // Sit the object's middle on the pin it replaced, so the close-up lands where
  // the marker was rather than jumping to one side of it.
  const lift = (spec.H + spec.D * TILT) / 2;
  // Tucked close to the footprint. Any wider and the ring, not the device, is
  // the biggest thing in the frame.
  const ringR = spec.W * 0.62;

  return (
    <g transform={`translate(${x} ${(y + lift).toFixed(2)})`}>
      <defs>
        <linearGradient id="hy-hero-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.42" />
          <stop offset="58%" stopColor="#ffffff" stopOpacity="0.04" />
          <stop offset="100%" stopColor="#22364d" stopOpacity="0.08" />
        </linearGradient>
        <linearGradient id="hy-hero-drum" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#eef1f5" />
          <stop offset="55%" stopColor="#e2e7ee" />
          <stop offset="100%" stopColor="#c6d0dc" />
        </linearGradient>
      </defs>

      {/* Selection ring, laid flat into the floor of the room. */}
      <ellipse cx={0} cy={0} rx={ringR} ry={ringR * TILT} fill={tone} opacity={0.07} />
      <ellipse
        cx={0}
        cy={0}
        rx={ringR}
        ry={ringR * TILT}
        fill="none"
        stroke={tone}
        strokeWidth={0.9}
        strokeDasharray="2 8"
        opacity={0.6}
      >
        <animate attributeName="stroke-dashoffset" values="0;-40" dur="3.4s" repeatCount="indefinite" />
      </ellipse>

      <ellipse
        cx={0}
        cy={0}
        rx={spec.W * 0.46}
        ry={spec.W * 0.46 * TILT * 0.7}
        fill="#1e3a8a"
        opacity={0.18}
      />

      <g
        onClick={onDismiss}
        style={{ cursor: onDismiss ? 'zoom-out' : undefined }}
        data-device={device.id}
      >
        {spec.form === 'puck'
          ? <Puck theta={theta} spec={spec} alarming={alarming} />
          : <Slab theta={theta} spec={spec} kind={kind} alarming={alarming} />}
      </g>
    </g>
  );
}
