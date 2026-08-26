import type { ReactNode } from 'react';
import { cn } from '../utils';

export type KpiTileSurface = 'light' | 'glass';

export type KpiDeltaDirection = 'up' | 'down' | 'flat';

export interface KpiTileDelta {
  value: string;
  direction?: KpiDeltaDirection;
  caption?: string;
  invertColor?: boolean;
}

export interface KpiTileProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  accent?: string;
  surface?: KpiTileSurface;
  delta?: KpiTileDelta;
  className?: string;
}

function resolveDeltaClass(
  direction: KpiDeltaDirection,
  invertColor: boolean | undefined,
  surface: KpiTileSurface,
) {
  const effective = invertColor
    ? direction === 'up'
      ? 'down'
      : direction === 'down'
        ? 'up'
        : 'flat'
    : direction;

  if (effective === 'up') return 'ds-kpi-tile__delta--up';
  if (effective === 'down') return 'ds-kpi-tile__delta--down';
  return surface === 'glass' ? 'ds-kpi-tile__delta--flat' : 'ds-kpi-tile__delta--flat';
}

export function KpiTile({
  label,
  value,
  sub,
  icon,
  accent = 'var(--ds-accent)',
  surface = 'light',
  delta,
  className,
}: KpiTileProps) {
  const direction = delta?.direction || 'flat';

  return (
    <div
      className={cn(
        'ds-kpi-tile',
        surface === 'light' ? 'ds-kpi-tile--light' : 'ds-kpi-tile--glass',
        className,
      )}
    >
      <div className="ds-kpi-tile__top">
        <div className="ds-kpi-tile__label-row">
          <span
            className="ds-kpi-tile__accent-dot"
            style={{ background: accent, boxShadow: surface === 'glass' ? `0 0 10px ${accent}` : undefined }}
            aria-hidden
          />
          <span className="ds-kpi-tile__label">{label}</span>
        </div>
        {icon ? <span className="ds-kpi-tile__icon">{icon}</span> : null}
      </div>
      <div className="ds-kpi-tile__value">{value}</div>
      {delta ? (
        <div className={cn('ds-kpi-tile__delta', resolveDeltaClass(direction, delta.invertColor, surface))}>
          {delta.value}
          {delta.caption ? <span className="ml-1 font-medium opacity-80">{delta.caption}</span> : null}
        </div>
      ) : null}
      {sub ? <div className="ds-kpi-tile__sub">{sub}</div> : null}
    </div>
  );
}

export default KpiTile;
