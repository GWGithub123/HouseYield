import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../utils';

export interface TileGridProps {
  children: ReactNode;
  minTile?: number;
  gap?: number;
  className?: string;
}

export function TileGrid({ children, minTile = 180, gap = 12, className }: TileGridProps) {
  const style = {
    gridTemplateColumns: `repeat(auto-fit, minmax(${minTile}px, 1fr))`,
    gap: `${gap}px`,
  } as CSSProperties;

  return (
    <div className={cn('ds-tile-grid', className)} style={style}>
      {children}
    </div>
  );
}

export default TileGrid;
