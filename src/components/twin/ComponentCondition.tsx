/**
 * A component's condition, drawn on the component itself.
 *
 * This replaces an earlier close-up that blurred the house and drew a synthetic
 * box on a turntable in front of it. Two things were wrong with that. The box was
 * not the component — a roof rendered as a floating slab tells you nothing a label
 * would not have — and blurring the house to make room for it threw away the
 * context that makes a location meaningful.
 *
 * So there is no second copy of anything here. The camera pushes in on the real
 * geometry and its surroundings, the surroundings wash back under a soft scrim
 * rather than a blur, and the wear is marked on the actual surfaces. What you are
 * looking at is the house, closer.
 */
import { VB_H, VB_W } from './houseModel';
import type { HealthPin } from './healthAnchors';
import {
  WEAR_LEVEL_META,
  buildWearMarks,
  surfacePath,
  wearLevel,
  type ComponentRegion,
  type WearMark,
} from './componentWear';
import type { PropertyHealthCategory } from '../../types/propertyHealth';

const SCRIM = '#f1f5f9';

interface ComponentConditionProps {
  region: ComponentRegion;
  category: PropertyHealthCategory;
  pin: HealthPin;
  onDismiss: () => void;
}

/** Per-kind ink. Weight only moves opacity, so a mark reads heavier as it ages. */
function markStyle(mark: WearMark, tint: string) {
  switch (mark.kind) {
    case 'blotch':
      return { fill: '#1e3a5f', fillOpacity: 0.09 + mark.weight * 0.17, stroke: 'none' };
    case 'streak':
      return {
        fill: 'none',
        stroke: '#334155',
        strokeOpacity: 0.06 + mark.weight * 0.14,
        strokeWidth: 7,
        strokeLinecap: 'round' as const,
      };
    case 'lift':
      return {
        fill: 'none',
        stroke: tint,
        strokeOpacity: 0.55 + mark.weight * 0.4,
        strokeWidth: 3.2,
        strokeLinecap: 'round' as const,
      };
    case 'moss':
      return { fill: '#4d7c0f', fillOpacity: 0.34 + mark.weight * 0.3, stroke: 'none' };
    case 'rust':
      return { fill: '#b45309', fillOpacity: 0.4 + mark.weight * 0.34, stroke: 'none' };
    case 'patch':
    default:
      return {
        fill: '#94a3b8',
        fillOpacity: 0.55,
        stroke: '#475569',
        strokeOpacity: 0.6,
        strokeWidth: 1.2,
      };
  }
}

export default function ComponentCondition({
  region,
  category,
  pin,
  onDismiss,
}: ComponentConditionProps) {
  /*
   * Age is the prior; an accepted photo is stronger current-condition evidence.
   * Convert its 0-100 visible-condition score onto the wear scale and keep the
   * worse reading. This never makes a visibly healthy old roof "young" again, but
   * it does let documented corrosion or lifted flashing appear before the nominal
   * replacement birthday.
   */
  const visualWearRatio = pin.asset.visualCondition
    ? Math.min(1.25, ((100 - pin.asset.visualCondition.score) / 100) * 1.2)
    : null;
  const renderedWearRatio = Math.max(pin.lifeUsedRatio ?? 0, visualWearRatio ?? 0);
  const level = wearLevel(renderedWearRatio);
  const meta = WEAR_LEVEL_META[level];
  const marks = buildWearMarks(category, region.surfaces, renderedWearRatio);
  const maskId = `hy-cond-mask-${category}`;
  const clipId = `hy-cond-clip-${category}`;
  const featherId = `hy-cond-feather-${category}`;

  const { box } = region;
  return (
    <g>
      {/*
        The wash and the marks come up over the second the camera is moving, so the
        component is arrived at rather than switched to.

        A keyframe rather than a mounted-then-transitioned flag: with only a `from`
        the browser animates up to each element's own `opacity`, so one rule serves
        three different target opacities, there is no state to hold, and a static
        render of this tree lands on the finished frame instead of a blank one.
      */}
      <style>{'@keyframes hy-cond-in{from{opacity:0}}'}</style>
      <defs>
        {/* The hole the component sits in. Feathered, so the surroundings fall
            away instead of ending at a visible rectangle. */}
        <filter id={featherId} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={VB_W} height={VB_H}>
          <rect x={0} y={0} width={VB_W} height={VB_H} fill="#fff" />
          <rect
            x={box.x - 14}
            y={box.y - 14}
            width={box.w + 28}
            height={box.h + 28}
            rx={34}
            fill="#000"
            filter={`url(#${featherId})`}
          />
        </mask>
        {region.surfaces.length > 0 && (
          <clipPath id={clipId}>
            {region.surfaces.map((surface, index) => (
              <path key={index} d={surfacePath(surface)} />
            ))}
          </clipPath>
        )}
      </defs>

      {/* Everything but the component, washed back toward the page. Click to leave. */}
      <rect
        x={0}
        y={0}
        width={VB_W}
        height={VB_H}
        fill={SCRIM}
        mask={`url(#${maskId})`}
        opacity={0.66}
        style={{ animation: 'hy-cond-in 340ms ease-out both', cursor: 'zoom-out' }}
        onClick={onDismiss}
      />

      {region.surfaces.length > 0 && (
        <g
          clipPath={`url(#${clipId})`}
          style={{ animation: 'hy-cond-in 460ms ease-out 200ms both', pointerEvents: 'none' }}
        >
          {/* A whisper of the severity colour across the whole surface, so a roof
              at twenty-two years reads warm before you have parsed a single mark. */}
          {region.surfaces.map((surface, index) => (
            <path
              key={`wash-${index}`}
              d={surfacePath(surface)}
              fill={meta.tint}
              opacity={level === 'new' ? 0 : level === 'settled' ? 0.05 : level === 'worn' ? 0.1 : 0.15}
            />
          ))}
          {marks.map((mark, index) => {
            const style = markStyle(mark, meta.tint);
            return <path key={index} d={mark.d} {...style} />;
          })}
        </g>
      )}

      {/* The component's own edge, picked out just enough to say "this one". */}
      {region.surfaces.map((surface, index) => (
        <path
          key={`edge-${index}`}
          d={surfacePath(surface)}
          fill="none"
          stroke={meta.tint}
          strokeWidth={2.4}
          strokeLinejoin="round"
          opacity={0.75}
          style={{ animation: 'hy-cond-in 420ms ease-out 120ms both', pointerEvents: 'none' }}
        />
      ))}

    </g>
  );
}
