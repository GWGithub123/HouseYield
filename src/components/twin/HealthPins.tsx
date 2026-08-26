import type { HealthPin } from './healthAnchors';

/**
 * The property-health overlay for the cutaway.
 *
 * Device pins answer "what is installed and is it online". These answer "what
 * is wearing out and how long is left", so they are drawn in the same space but
 * read differently: a ring that fills clockwise with the share of useful life
 * already spent, tinted from green to red as it closes. A component at 40% and
 * one at 95% are then distinguishable at a glance, which a status dot cannot do.
 */

const R = 17;
const CIRC = 2 * Math.PI * R;

function LifeRing({ ratio, tint }: { ratio: number | null; tint: string }) {
  // An unknown age gets a dashed ring rather than an empty one: nothing known
  // should not look the same as nothing worn.
  if (ratio == null) {
    return (
      <circle
        r={R}
        fill="none"
        stroke={tint}
        strokeWidth={3}
        strokeDasharray="4 5"
        opacity={0.8}
      />
    );
  }

  const shown = Math.max(0, Math.min(1, ratio));
  return (
    <>
      <circle r={R} fill="none" stroke="#e2e8f0" strokeWidth={3.5} />
      <circle
        r={R}
        fill="none"
        stroke={tint}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeDasharray={`${CIRC * shown} ${CIRC}`}
        transform="rotate(-90)"
      />
    </>
  );
}

export interface HealthPinsProps {
  pins: HealthPin[];
  selectedAssetId?: string | null;
  onSelect?: (assetId: string) => void;
}

export function HealthPins({ pins, selectedAssetId, onSelect }: HealthPinsProps) {
  return (
    <g aria-label="Property health components">
      {pins.map((pin) => {
        const selected = pin.asset.id === selectedAssetId;
        const pct = pin.lifeUsedRatio == null ? null : Math.round(pin.lifeUsedRatio * 100);
        const anchorEnd = pin.anchor.side === 'left';

        return (
          <g
            key={pin.asset.id}
            transform={`translate(${pin.anchor.x}, ${pin.anchor.y})`}
            onClick={() => onSelect?.(pin.asset.id)}
            style={{ cursor: onSelect ? 'pointer' : 'default' }}
            role={onSelect ? 'button' : undefined}
            aria-label={`${pin.label}: ${pin.asset.name}`}
          >
            <title>
              {`${pin.label} — ${pin.asset.name}`}
              {pin.ageYears != null
                ? ` · ${Math.round(pin.ageYears)} of ~${pin.usefulLifeYears} yrs`
                : ' · age unknown'}
              {pin.anchor.approximate ? ' · approximate area; confirm location' : ''}
            </title>

            {selected ? <circle r={R + 7} fill={pin.tint} opacity={0.16} /> : null}

            <circle r={R - 1} fill="#ffffff" stroke="#cbd5e1" strokeWidth={selected ? 2 : 1} />
            <LifeRing ratio={pin.lifeUsedRatio} tint={pin.tint} />

            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={pct == null ? 11 : 10.5}
              fontWeight={700}
              fill="#0f172a"
            >
              {pct == null ? '?' : `${pct}%`}
            </text>

            <text
              x={anchorEnd ? -(R + 8) : R + 8}
              y={4}
              textAnchor={anchorEnd ? 'end' : 'start'}
              fontSize={11.5}
              fontWeight={700}
              fill="#0f172a"
              paintOrder="stroke"
              stroke="#f8fafc"
              strokeWidth={3.5}
              strokeLinejoin="round"
            >
              {pin.label}
              {pin.anchor.approximate ? ' ≈' : ''}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export default HealthPins;
