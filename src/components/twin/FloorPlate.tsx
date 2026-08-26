/**
 * One storey seen from above — the corridor with the apartments off it.
 *
 * ## Why this view exists at all
 *
 * The side elevation shows every floor at once but only one facade, so the far
 * side has to be reached by flipping. That is the right trade for "how far down
 * does this go", and the wrong one for "who do I knock on, on this floor". A leak
 * in a shared wall puts apartments on both sides of the hall in scope, and this is
 * the only drawing that can show both at the same time.
 *
 * It is a plan, so it is a different drawing rather than a variant of the
 * elevation: no projection, no fixtures, no shading. Each unit is a rectangle with
 * a number in it, which is exactly the amount of detail a plan of a floor we have
 * not surveyed is entitled to.
 *
 * ## What it does not claim
 *
 * Unit depth, room layout, where the doors are, and which way the building faces
 * are all unknown. Drawing a plausible floor plan would invent all four. The units
 * are equal rectangles in the order the stacking plan gives, and the corridor is a
 * strip; nothing here says more than we know.
 */
import {
  UNIT_W,
  unitsOnLevel,
  bandForLevel,
  type BuildingDef,
  type BuildingSide,
  type UnitDef,
} from './buildingModel';
import type { LeakExposure } from './leakPropagation';
import { EXPOSURE_INK, EXPOSURE_WASH, INK, LINE, ROOM_FILL, SOFT, WALL } from './twinPrimitives';

/** Depth of a unit in plan. Nominal — we do not know the real footprint. */
const UNIT_D = 108;
/** Width of the corridor strip between the two rows. */
const CORRIDOR_D = 46;
const PLATE_MARGIN = 56;
/** Room for the title, the schematic disclaimer, and the FRONT row label. */
const HEADER = 68;

export interface FloorPlateProps {
  building: BuildingDef;
  /** Band index to draw. */
  level: number;
  alertUnits?: Set<string>;
  exposures?: LeakExposure[];
  coverageGaps?: Set<string>;
  occupiedUnits?: Set<string>;
  selectedUnitId?: string | null;
  /** Highlights the units on one facade, to tie the plan back to the elevation. */
  highlightSide?: BuildingSide | null;
  onUnitClick?: (unitId: string) => void;
}

export function floorPlateScene(building: BuildingDef): { w: number; h: number } {
  const rows = building.sides.length;
  return {
    w: PLATE_MARGIN * 2 + building.unitsPerFloor * UNIT_W,
    h: HEADER + PLATE_MARGIN + rows * UNIT_D + (rows > 1 ? CORRIDOR_D : CORRIDOR_D * 0.6),
  };
}

/**
 * Where a unit's rectangle goes in plan.
 *
 * Side A is the near row and side B the far one, with the corridor between. The
 * mirroring the elevation applies is *not* applied here: a plan is seen from
 * above, from one fixed direction, so there is no walking around it and column 0
 * is on the left for both rows. Carrying the elevation's mirror into the plan was
 * the first thing tried and it put a unit in two different places in two views of
 * the same floor.
 */
function plotUnit(
  building: BuildingDef,
  unit: UnitDef,
): { x: number; y: number; w: number; h: number } {
  const x = PLATE_MARGIN + unit.column * UNIT_W;
  const corridorTop = HEADER + UNIT_D;
  const y = unit.side === 'A'
    ? HEADER
    : corridorTop + CORRIDOR_D;
  return { x, y, w: UNIT_W, h: UNIT_D };
}

export default function FloorPlate({
  building,
  level,
  alertUnits,
  exposures = [],
  coverageGaps,
  occupiedUnits,
  selectedUnitId,
  highlightSide,
  onUnitClick,
}: FloorPlateProps) {
  const band = bandForLevel(building, level);
  const units = unitsOnLevel(building, level);
  const exposureByUnit = new Map(exposures.map((exposure) => [exposure.cellId, exposure]));
  const { w, h } = floorPlateScene(building);

  const corridorY = HEADER + UNIT_D;
  const corridorW = building.unitsPerFloor * UNIT_W;
  const doubleSided = building.sides.length > 1;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img"
      aria-label={`${band?.label ?? 'Floor'} plan, ${units.length} units`}
    >
      <text x={PLATE_MARGIN} y={26} fontSize={13} fontWeight={700} fill={INK} letterSpacing={1.5}>
        {(band?.label ?? 'FLOOR').toUpperCase()} — SEEN FROM ABOVE
      </text>
      <text x={PLATE_MARGIN} y={41} fontSize={9.5} fill={INK} opacity={0.55}>
        {units.length} {units.length === 1 ? 'unit' : 'units'} on this floor
        {doubleSided ? ', both sides of the corridor' : ''}
        {/* Said out loud because a plan invites the assumption that it is
            measured, and this one is not. */}
        {' · '}schematic: unit depth and room layout are not surveyed
      </text>

      {/* The corridor. Drawn before the units so their edges sit on it. */}
      <rect
        x={PLATE_MARGIN}
        y={corridorY}
        width={corridorW}
        height={doubleSided ? CORRIDOR_D : CORRIDOR_D * 0.6}
        fill={WALL}
        stroke={LINE}
        strokeWidth={1.2}
      />
      <text
        x={PLATE_MARGIN + 10}
        y={corridorY + (doubleSided ? CORRIDOR_D / 2 + 3.5 : CORRIDOR_D * 0.3 + 3.5)}
        fontSize={9}
        fill={INK}
        opacity={0.5}
        letterSpacing={1.6}
      >
        {doubleSided ? 'CORRIDOR' : 'BREEZEWAY'}
      </text>

      {units.map((unit) => {
        const box = plotUnit(building, unit);
        const exposure = exposureByUnit.get(unit.id);
        const exposed = exposure != null && exposure.tier !== 'source';
        const alerting = alertUnits?.has(unit.id);
        const dimmed = highlightSide != null && unit.side !== highlightSide;
        const strength = exposure?.likelihood ?? 0;

        return (
          /* Dimmed, not hidden: the far row is context for which side you are
             looking at in the elevation, and it still has to be readable — an
             exposed unit over there is exactly what you came here to see. */
          <g key={unit.id} opacity={dimmed ? 0.58 : 1}>
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              fill={ROOM_FILL}
              stroke={LINE}
              strokeWidth={1.2}
            />

            {/* Same two languages as everywhere else: an observation fills, an
                inference washes. A plan is the view most likely to be screenshotted
                into an email, so it is the last place to blur that line. */}
            {alerting && (
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                fill="#ef4444"
                opacity={0.3}
                stroke="#dc2626"
                strokeWidth={2.2}
              />
            )}
            {exposed && !alerting && (
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                fill={EXPOSURE_WASH}
                opacity={0.1 + strength * 0.3}
                stroke={EXPOSURE_INK}
                strokeWidth={1.4}
                strokeDasharray="6 4"
              />
            )}

            <text
              x={box.x + box.w / 2}
              y={box.y + box.h / 2 + 4}
              fontSize={13}
              fontWeight={600}
              textAnchor="middle"
              fill={alerting ? '#991b1b' : INK}
              opacity={alerting ? 1 : 0.75}
              pointerEvents="none"
            >
              {unit.label}
            </text>

            {coverageGaps?.has(unit.id) && (
              <g pointerEvents="none">
                <circle
                  cx={box.x + box.w - 15}
                  cy={box.y + 15}
                  r={7.5}
                  fill="#f8fafc"
                  stroke="#64748b"
                  strokeWidth={1.3}
                />
                <path
                  d={`M${box.x + box.w - 20} ${box.y + 20} L${box.x + box.w - 10} ${box.y + 10}`}
                  stroke="#64748b"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              </g>
            )}

            {occupiedUnits?.has(unit.id) && (
              <circle
                cx={box.x + 13}
                cy={box.y + box.h - 12}
                r={3}
                fill="#0ea5e9"
                pointerEvents="none"
              />
            )}

            {selectedUnitId === unit.id && (
              <rect
                x={box.x + 2}
                y={box.y + 2}
                width={box.w - 4}
                height={box.h - 4}
                fill="none"
                stroke="#1d4ed8"
                strokeWidth={2.4}
                pointerEvents="none"
              />
            )}

            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              fill="transparent"
              style={{ cursor: onUnitClick ? 'pointer' : 'default' }}
              onClick={() => onUnitClick?.(unit.id)}
            >
              <title>{`Unit ${unit.label}`}</title>
            </rect>
          </g>
        );
      })}

      {/* Which row is which facade, so the plan and the elevation can be read
          together rather than as two unrelated pictures. */}
      <text x={PLATE_MARGIN} y={HEADER - 6} fontSize={8.5} fill={INK} opacity={0.5} letterSpacing={1.3}>
        FRONT
      </text>
      {doubleSided && (
        <text
          x={PLATE_MARGIN}
          y={h - PLATE_MARGIN + 14}
          fontSize={8.5}
          fill={INK}
          opacity={0.5}
          letterSpacing={1.3}
        >
          REAR
        </text>
      )}
      <rect
        x={PLATE_MARGIN - 4}
        y={HEADER - 4}
        width={corridorW + 8}
        height={h - HEADER - PLATE_MARGIN + 8}
        fill="none"
        stroke={SOFT}
        strokeWidth={1}
        opacity={0.7}
      />
    </svg>
  );
}
