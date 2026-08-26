/**
 * Side-elevation section of a multifamily building — one facade with its front
 * wall removed, so every floor and every unit on that face is readable at once.
 *
 * ## Why an elevation and not a rotatable 3D model
 *
 * A free-orbit building looks impressive and answers the wrong question. The
 * thing a manager needs from this drawing is "which apartments are downstream of
 * this leak", and every unit that matters is a box behind another box: turning
 * the building necessarily hides some of them, and the ones it hides are exactly
 * the ones being asked about. An orthographic elevation has no occlusion and no
 * camera to get lost in. The far facade is reached by flipping to it, which is
 * two discrete states you can label, rather than a continuum you have to steer.
 *
 * ## Shared with the house on purpose
 *
 * Projection, palette and fixtures all come from `twinPrimitives`. The two
 * drawings are the same building seen two ways, and if they disagree about which
 * direction is "back" or what a bath looks like they stop reading that way.
 *
 * Purely presentational, like `HouseCutaway`: it draws the shell, the units and
 * their fixtures and reports hover/click upward.
 *
 * Renders a `<g>`, not an `<svg>`, for the same reason `HouseCutaway` does — the
 * caller owns the `<svg>` and its camera `viewBox`, and the device pins, links and
 * valve overlays have to share one coordinate space with the drawing or they
 * cannot be positioned against it. Use {@link buildingCutawayScene} to size that
 * `<svg>`, since the exploded view is taller than the section.
 */
import { useEffect, useRef, useState } from 'react';

import {
  BASEMENT_H,
  BUILDING_MARGIN_X,
  SIDE_LABEL,
  UNIT_W,
  explodeOffset,
  explodedScene,
  levelBand,
  oppositeSide,
  unitsOnSide,
  type BuildingDef,
  type BuildingSide,
  type UnitDef,
} from './buildingModel';
import { DX, DY, SLAB } from './houseModel';
import type { LeakExposure } from './leakPropagation';
import { spanOverlapCenter } from './leakPropagation';
import { isWetFixture } from './coverageModel';
import {
  EXPOSURE_INK,
  EXPOSURE_LABEL_MIN,
  EXPOSURE_WASH,
  ExposureFromAbove,
  ExposureStain,
  FixtureLayer,
  FLOOR_FILL,
  INK,
  LINE,
  ROOM_FILL,
  roomCeilingPath,
  roomFloorPath,
  roomVolumePath,
  SOFT,
  SOIL,
  WALL,
  back,
} from './twinPrimitives';

/** Parapet height above the roof deck. Flat roofs are the norm at this scale. */
const PARAPET = 22;
const ROOF_T = 12;
/** Thickness of the end walls the section cuts through. */
const WALL_T = 16;

export interface BuildingCutawayProps {
  building: BuildingDef;
  /** Which facade is being looked at. Changing this animates a turn. */
  side: BuildingSide;
  /** Units with a firing leak alert — an observation, drawn solid. */
  alertUnits?: Set<string>;
  /**
   * Units a detected leak may have reached, from {@link propagateLeak}.
   *
   * Includes exposures on the facade that is *not* currently shown; those drive
   * the cross-side badge rather than being drawn. Water does not care which way
   * the building is facing, so hiding them would make the flip conceal real
   * exposure.
   */
  exposures?: LeakExposure[];
  /** Units with plumbing and no working water sensor. */
  coverageGaps?: Set<string>;
  /** Units holding at least one device pin. */
  occupiedUnits?: Set<string>;
  selectedUnitId?: string | null;
  hoveredUnitId?: string | null;
  /** Riser to draw prominently, from the stack selector. */
  selectedStackId?: string | null;
  /**
   * `exploded` pulls the floors vertically apart.
   *
   * The section is honest but cramped: the slab between two floors is 16 units
   * thick, so the drips crossing it — the thing that shows *how* water got from
   * one apartment to the one below — have almost no room to be seen. Exploding
   * gives that route somewhere to be drawn and changes nothing about the model.
   */
  mode?: 'section' | 'exploded';
  onUnitClick?: (unitId: string) => void;
  onUnitHover?: (unitId: string | null) => void;
  /** Called by the facade label and the cross-side badge. */
  onFlip?: (side: BuildingSide) => void;
  onStackClick?: (stackId: string) => void;
}

/**
 * How long the turn takes, and how long the facade is edge-on.
 *
 * The swap happens while the building is compressed to a vertical line, which is
 * what makes a mirrored unit order read as *turning around* rather than as the
 * apartments shuffling. Half a turn is enough: a full 360 would end up showing
 * the same face it started on.
 */
const FLIP_MS = 190;

/**
 * Extent the caller's `<svg>` and camera must cover.
 *
 * Its own function because the exploded view is taller and framing it with the
 * sectioned extent clamps the camera above the lowest floor, which quietly makes
 * the basement unreachable.
 */
export function buildingCutawayScene(
  building: BuildingDef,
  mode: 'section' | 'exploded' = 'section',
): { w: number; h: number } {
  return mode === 'exploded' ? explodedScene(building) : building.scene;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Lags the `side` prop so the content can be swapped mid-turn.
 *
 * Returns the facade to *draw* plus how compressed it currently is. The caller
 * squashes the facade horizontally by that factor, so 0 is edge-on and 1 is
 * square to the viewer.
 */
function useFacadeFlip(side: BuildingSide): { drawn: BuildingSide; squash: number } {
  const [drawn, setDrawn] = useState(side);
  const [squash, setSquash] = useState(1);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (drawn === side) return undefined;

    if (prefersReducedMotion() || typeof window === 'undefined') {
      setDrawn(side);
      setSquash(1);
      return undefined;
    }

    setSquash(0);
    // Swapped at the point the facade has no width, so the change of content is
    // never visible as a change of content.
    timers.current.push(window.setTimeout(() => {
      setDrawn(side);
      setSquash(1);
    }, FLIP_MS));

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [side, drawn]);

  return { drawn, squash };
}

/* ── shell ───────────────────────────────────────────────────────── */

function BuildingShell({
  building,
  lift,
}: {
  building: BuildingDef;
  /** Vertical offset for a level, non-zero only in the exploded view. */
  lift: (level: number) => number;
}) {
  const left = BUILDING_MARGIN_X;
  const right = BUILDING_MARGIN_X + building.unitsPerFloor * UNIT_W;
  const levels = building.levels;
  const roofY = levels[0].top;
  const lowest = levels[levels.length - 1];
  const baseY = lowest.bottom + lift(lowest.index);
  const grade = building.hasBasement
    ? baseY - BASEMENT_H
    : baseY;

  return (
    <g>
      {/* Soil, drawn first so the foundation cuts into it. */}
      <path
        d={`M0 ${grade} L${right + DX + 200} ${grade} L${right + DX + 200} ${baseY + 60} L0 ${baseY + 60} Z`}
        fill={SOIL}
      />
      <path d={`M0 ${grade} L${right + DX + 200} ${grade}`} stroke={SOFT} strokeWidth={2} />

      {/* Receding top plane, then the parapet in front of it, so the roof reads
          as a surface you could stand on rather than as a lid. */}
      <path
        d={`M${left} ${roofY} L${right} ${roofY} L${back(right, roofY)} L${back(left, roofY)} Z`}
        fill={FLOOR_FILL}
        stroke={LINE}
        strokeWidth={1.2}
      />
      <rect
        x={left - WALL_T}
        y={roofY - PARAPET}
        width={right - left + WALL_T * 2}
        height={PARAPET}
        fill={WALL}
        stroke={INK}
        strokeWidth={1.6}
      />
      <rect
        x={left - WALL_T}
        y={roofY}
        width={right - left + WALL_T * 2}
        height={ROOF_T}
        fill={FLOOR_FILL}
        stroke={INK}
        strokeWidth={1.4}
      />

      {/*
        End walls, drawn outside the unit bays.

        An earlier version put them on the same lines as the outermost units, so
        the units covered them and all that showed was a sliver above the top
        floor that read as a rendering fault. A wall the section cuts through has
        to be somewhere the section can show it.
      */}
      {[{ x: left - WALL_T, flip: false }, { x: right, flip: true }].map((wall) => (
        <g key={wall.x}>
          <path
            d={`M${wall.x} ${roofY} L${wall.x + WALL_T} ${roofY} L${back(wall.x + WALL_T, roofY)} L${back(wall.x, roofY)} Z`}
            fill={FLOOR_FILL}
            stroke={LINE}
            strokeWidth={1}
          />
          <rect
            x={wall.x}
            y={roofY}
            width={WALL_T}
            height={baseY - roofY}
            fill={WALL}
            stroke={INK}
            strokeWidth={1.4}
          />
          {/* Receding inner face, so the wall has thickness rather than being a
              painted stripe. */}
          <path
            d={`M${wall.flip ? wall.x : wall.x + WALL_T} ${roofY} L${back(wall.flip ? wall.x : wall.x + WALL_T, roofY)} L${back(wall.flip ? wall.x : wall.x + WALL_T, baseY)} L${wall.flip ? wall.x : wall.x + WALL_T} ${baseY} Z`}
            fill={WALL}
            stroke={LINE}
            strokeWidth={1}
            opacity={0.75}
          />
        </g>
      ))}

      {/* Floor slabs between levels, and the base slab. */}
      {building.levels.map((level) => {
        const slabY = level.bottom - SLAB + lift(level.index);
        return (
          <g key={level.index}>
            <path
              d={`M${left} ${slabY} L${right} ${slabY} L${back(right, slabY)} L${back(left, slabY)} Z`}
              fill={FLOOR_FILL}
              stroke={LINE}
              strokeWidth={1}
            />
            <rect
              x={left}
              y={slabY}
              width={right - left}
              height={SLAB * 2}
              fill={FLOOR_FILL}
              stroke={INK}
              strokeWidth={1.2}
            />
          </g>
        );
      })}

      <rect
        x={left - 10}
        y={baseY}
        width={right - left + 20}
        height={16}
        fill={WALL}
        stroke={INK}
        strokeWidth={1.5}
      />
    </g>
  );
}

/**
 * What this facade is, in words, under its label.
 *
 * An earlier version tried to draw the corridor as a tinted strip on the ceiling
 * plane behind each unit. It was invisible — the units are in front of it, so
 * their own ceiling strips covered it — and the fix would have been to draw the
 * corridor over the units, which puts a hallway in front of the apartments.
 *
 * The corridor's only job in this drawing is to explain why there is a far side
 * at all, and a sentence does that better than geometry we would be inventing.
 * It also says how many units are back there, which the drawing genuinely cannot.
 */
function FacadeCaption({
  building,
  side,
  x,
  y,
}: {
  building: BuildingDef;
  side: BuildingSide;
  x: number;
  y: number;
}) {
  const far = oppositeSide(building, side);
  const parts = [
    `${building.floors} floors`,
    `${building.unitsPerFloor} units per floor`,
  ];
  if (far) {
    parts.push(
      `double-loaded corridor, ${building.unitsPerFloor * building.floors} more on the ${SIDE_LABEL[far].toLowerCase()}`,
    );
  }
  if (building.sharedRisers) parts.push('risers shared across the corridor');

  return (
    <text x={x} y={y} fontSize={9.5} fill={INK} opacity={0.55} letterSpacing={0.3}>
      {parts.join(' · ')}
    </text>
  );
}

/**
 * The below-grade level.
 *
 * Rendered separately from the units because it holds none, and skipped entirely
 * when the building has no basement. It still has to be drawn: the propagation
 * engine gives a ground-floor leak the basement to run into, and a space the
 * model flags but the drawing omits is exposure the reader never sees.
 */
function BasementLevel({
  building,
  lift,
  exposure,
}: {
  building: BuildingDef;
  lift: (level: number) => number;
  exposure?: LeakExposure;
}) {
  const level = building.levels.find((band) => band.kind === 'basement');
  if (!level) return null;

  const band = levelBand(level);
  const y = band.y + lift(level.index);
  const { h } = band;
  const x = BUILDING_MARGIN_X;
  const w = building.unitsPerFloor * UNIT_W;
  const box = { x, y, w, h };
  const strength = exposure?.likelihood ?? 0;
  const exposed = exposure != null && exposure.tier !== 'source';

  return (
    <g>
      <path d={roomVolumePath(box)} fill={ROOM_FILL} stroke={LINE} strokeWidth={1.1} />
      <path d={roomFloorPath(box)} fill={FLOOR_FILL} opacity={0.7} />
      <text
        x={x + 12}
        y={y + 17}
        fontSize={11}
        fontWeight={600}
        fill={INK}
        opacity={0.6}
        letterSpacing={1.2}
        pointerEvents="none"
      >
        BASEMENT
      </text>
      {exposed && (
        <g pointerEvents="none">
          <ExposureStain
            cx={x + w / 2}
            cy={y + h - DY * 0.5}
            strength={strength}
            id="bc-basement"
            spread={2.4}
            hostW={w}
          />
        </g>
      )}
    </g>
  );
}

/* ── risers ──────────────────────────────────────────────────────── */

/**
 * The plumbing riser for one column, with a tee into each unit it serves.
 *
 * Drawn because a stack is the reason a leak four floors up is a problem on the
 * ground floor, and a reader who cannot see the pipe has to take that on trust.
 * The selected riser is solid and the rest are ghosted, so picking a stack
 * changes what the drawing is *about* rather than just adding a highlight.
 */
function Risers({
  building,
  units,
  selectedStackId,
  lift,
  onStackClick,
}: {
  building: BuildingDef;
  /** Already shifted for the exploded view, so a riser spans the gaps. */
  units: UnitDef[];
  selectedStackId?: string | null;
  lift: (level: number) => number;
  onStackClick?: (stackId: string) => void;
}) {
  const byColumn = new Map<number, UnitDef[]>();
  for (const unit of units) {
    const list = byColumn.get(unit.column);
    if (list) list.push(unit);
    else byColumn.set(unit.column, [unit]);
  }

  return (
    <g>
      {[...byColumn.entries()].map(([column, columnUnits]) => {
        const sorted = [...columnUnits].sort((a, b) => a.level - b.level);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        if (!first || !last) return null;
        const active = selectedStackId != null && first.stackId === selectedStackId;
        // On the wall between this unit and the next, which is where a riser runs.
        const x = first.x + first.w - 6;
        /*
         * Carried down into the basement when there is one. A riser that stops at
         * the lowest apartment implies the water does too, and the basement is
         * where a stack leak actually ends up.
         */
        const basement = building.levels.find((level) => level.kind === 'basement');
        const bottom = basement
          ? basement.bottom - SLAB + lift(basement.index)
          : last.y + last.h + SLAB;

        return (
          <g key={column}>
            <path
              d={`M${x} ${first.y - SLAB} V${bottom}`}
              stroke={active ? '#0ea5e9' : SOFT}
              strokeWidth={active ? 3 : 1.6}
              strokeDasharray={active ? undefined : '5 5'}
              opacity={active ? 0.95 : 0.4}
              fill="none"
            />
            {sorted.map((unit) => (
              <path
                key={unit.id}
                d={`M${x} ${unit.y + unit.h * 0.45} h${-12}`}
                stroke={active ? '#0ea5e9' : SOFT}
                strokeWidth={active ? 2.2 : 1.3}
                opacity={active ? 0.9 : 0.35}
                fill="none"
              />
            ))}
            {onStackClick && (
              /* A generous transparent target: the pipe itself is 3 px wide and
                 nobody is going to hit that, least of all on a touch screen. */
              <rect
                x={x - 11}
                y={first.y - SLAB}
                width={22}
                height={bottom - (first.y - SLAB)}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onClick={(event) => {
                  event.stopPropagation();
                  onStackClick(first.stackId);
                }}
              >
                <title>{`Riser serving column ${column + 1}`}</title>
              </rect>
            )}
          </g>
        );
      })}
    </g>
  );
}

/* ── exposure ────────────────────────────────────────────────────── */

/**
 * Water crossing the floor assembly between a unit and the unit below it.
 *
 * The gap between two units' drawn edges is the slab, so a drip that starts at
 * one unit's floor and ends inside the one beneath visibly passes through the
 * structure water has to get through. Drawing the route rather than only the two
 * endpoints is the difference between "these two are wet" and "this is how it
 * got there".
 */
function UnitDrips({
  units,
  exposures,
}: {
  /** Already shifted for the exploded view. */
  units: UnitDef[];
  exposures: LeakExposure[];
}) {
  const visible = new Map(units.map((unit) => [unit.id, unit]));
  /*
   * Every unit water has reached, including the leak itself.
   *
   * The route is chained from each of these to the unit below it rather than from
   * the leak to each of them. Drawing only leak-to-target segments stops the
   * route after one floor — the second-floor-down unit's `sourceCellId` is still
   * the original leak, two levels up, so there is no adjacent pair to draw and
   * the water appears to skip a storey.
   */
  const wet = exposures.filter((exposure) => exposure.tier !== 'lateral');

  return (
    <g pointerEvents="none">
      {wet.flatMap((exposure) => {
        const from = visible.get(exposure.cellId);
        if (!from) return [];

        // The unit immediately beneath, on this facade and in this column.
        const to = units.find(
          (unit) => unit.column === from.column && unit.level === from.level + 1,
        );
        if (!to) return [];
        // Only draw into a unit water actually reaches.
        const reached = wet.some((other) => other.cellId === to.id);
        if (!reached) return [];

        const x = spanOverlapCenter(from, to);
        const strength = wet.find((other) => other.cellId === to.id)?.likelihood ?? 0;
        return [(
          <path
            key={`${from.id}-${to.id}`}
            d={`M${x} ${from.y + from.h} V${to.y + 14}`}
            stroke={EXPOSURE_INK}
            strokeWidth={1.6}
            strokeDasharray="4 4"
            opacity={0.35 + strength * 0.45}
            fill="none"
          />
        )];
      })}
    </g>
  );
}

/* ── coverage ────────────────────────────────────────────────────── */

const GAP_INK = '#64748b';

/**
 * A crossed-out drop over a unit with plumbing and no working sensor.
 *
 * A marker rather than an area treatment, for the same reason as in the house: a
 * blind spot and an exposure are not alternatives, and the worst unit in the
 * building is one that is both. Two area washes would fight for the same pixels
 * exactly where the drawing matters most.
 */
function UnitCoverageBadge({ unit }: { unit: UnitDef }) {
  if (!unit.fixtures.some((fixture) => isWetFixture(fixture.kind))) return null;
  const cx = unit.x + unit.w - 20;
  const cy = unit.y + 18;

  return (
    <g pointerEvents="none">
      <circle cx={cx} cy={cy} r={9} fill="#f8fafc" stroke={GAP_INK} strokeWidth={1.4} />
      <path
        d={`M${cx} ${cy - 5} c 3.2 3.6 4.4 5.2 4.4 7 a4.4 4.4 0 0 1 -8.8 0 c0 -1.8 1.2 -3.4 4.4 -7 Z`}
        fill="none"
        stroke={GAP_INK}
        strokeWidth={1.3}
      />
      <path
        d={`M${cx - 6.5} ${cy + 6.5} L${cx + 6.5} ${cy - 6.5}`}
        stroke={GAP_INK}
        strokeWidth={1.7}
        strokeLinecap="round"
      />
    </g>
  );
}

/* ── main ────────────────────────────────────────────────────────── */

export default function BuildingCutaway({
  building,
  side,
  alertUnits,
  exposures = [],
  coverageGaps,
  occupiedUnits,
  selectedUnitId,
  hoveredUnitId,
  selectedStackId,
  mode = 'section',
  onUnitClick,
  onUnitHover,
  onFlip,
  onStackClick,
}: BuildingCutawayProps) {
  const { drawn, squash } = useFacadeFlip(side);
  const exposureByUnit = new Map(exposures.map((exposure) => [exposure.cellId, exposure]));
  const far = oppositeSide(building, drawn);

  /*
   * The explode is applied by moving the geometry, not by wrapping it in a
   * transform.
   *
   * A transform per level was the first attempt and it splits the drawing in two:
   * anything that spans levels — a riser, a drip crossing a slab — is then in a
   * different coordinate space from the units at each of its ends, and has to
   * undo the transform to line up. Shifting the units instead means every path
   * builder, clip, stain and label downstream works unchanged and is correct in
   * both modes for free.
   */
  const lift = (level: number) => (mode === 'exploded' ? explodeOffset(level) : 0);
  const units = unitsOnSide(building, drawn).map((unit) => {
    const dy = lift(unit.level);
    if (dy === 0) return unit;
    return {
      ...unit,
      y: unit.y + dy,
      fixtures: unit.fixtures.map((fixture) => ({ ...fixture, y: fixture.y + dy })),
    };
  });

  /*
   * Exposure the current facade cannot show.
   *
   * The whole reason the propagation engine is given both sides even though only
   * one is drawn. Without this the flip would hide real exposure, and a view
   * whose safety information depends on which way you happen to be looking is
   * worse than no view.
   */
  const farExposedCount = far
    ? unitsOnSide(building, far).filter((unit) => {
      const exposure = exposureByUnit.get(unit.id);
      return exposure != null && exposure.tier !== 'source';
    }).length
    : 0;

  const centerX = BUILDING_MARGIN_X + (building.unitsPerFloor * UNIT_W) / 2;

  return (
    <g
      aria-label={`${SIDE_LABEL[drawn]}, ${building.floors} floors, ${building.unitsPerFloor} units per floor`}
      onMouseLeave={() => onUnitHover?.(null)}
    >
      <defs>
        {units.map((unit) => (
          <clipPath key={unit.id} id={`bc-clip-${unit.id}`}>
            <path d={roomVolumePath(unit)} />
          </clipPath>
        ))}
      </defs>

      <BuildingShell building={building} lift={lift} />

      {/*
        The facade squashes to nothing and back when the side changes.

        Scaled about the building's centre line so it turns in place. This is the
        entire flip animation: two discrete states with the content swapped while
        there is no width to see it swap in.
      */}
      <g
        transform={`translate(${centerX} 0) scale(${squash} 1) translate(${-centerX} 0)`}
        style={{
          transition: `transform ${FLIP_MS}ms ease-in-out`,
          // Squashed to zero width the group has no area, so it cannot be hovered
          // mid-turn — which would otherwise fire a hover for whichever unit the
          // cursor happened to be over on the *other* facade.
          pointerEvents: squash < 0.98 ? 'none' : undefined,
        }}
      >
        <BasementLevel
          building={building}
          lift={lift}
          exposure={exposureByUnit.get('basement')}
        />

        {units.map((unit) => {
          const alerting = alertUnits?.has(unit.id);
          const exposure = exposureByUnit.get(unit.id);
          const exposed = exposure != null && exposure.tier !== 'source';
          const hovered = hoveredUnitId === unit.id;
          const selected = selectedUnitId === unit.id;
          const strength = exposure?.likelihood ?? 0;
          const fromAbove = exposure?.tier === 'direct' || exposure?.tier === 'stack';

          const sourceUnit = exposure?.sourceCellId
            ? units.find((candidate) => candidate.id === exposure.sourceCellId)
            : undefined;
          const arrivalX = sourceUnit
            ? spanOverlapCenter(sourceUnit, unit)
            : unit.x + unit.w / 2;

          return (
            <g key={unit.id}>
              <path d={roomVolumePath(unit)} fill={ROOM_FILL} stroke={LINE} strokeWidth={1.1} />
              <path d={roomFloorPath(unit)} fill={FLOOR_FILL} opacity={0.7} />
              <path d={roomCeilingPath(unit)} fill={WALL} opacity={0.35} />

              <g clipPath={`url(#bc-clip-${unit.id})`}>
                <FixtureLayer fixtures={unit.fixtures} />
              </g>

              {/* An alerting unit fills, because water was observed in it. An
                  exposed unit gets patches, because it was inferred. Keeping the
                  two languages apart is what stops the drawing from claiming a
                  detection it does not have. */}
              {alerting && (
                <g pointerEvents="none">
                  <path d={roomVolumePath(unit)} fill="#ef4444" opacity={0.26}>
                    <animate
                      attributeName="opacity"
                      values="0.26;0.42;0.26"
                      dur="2.1s"
                      repeatCount="indefinite"
                    />
                  </path>
                  <path
                    d={roomVolumePath(unit)}
                    fill="none"
                    stroke="#dc2626"
                    strokeWidth={2.4}
                    strokeLinejoin="round"
                  />
                </g>
              )}

              {exposed && !alerting && (
                <g pointerEvents="none" clipPath={`url(#bc-clip-${unit.id})`}>
                  {fromAbove && (
                    <>
                      <ExposureFromAbove
                        id={unit.id}
                        volumePath={roomVolumePath(unit)}
                        left={unit.x}
                        top={unit.y - DY}
                        bottom={unit.y + unit.h}
                        strength={strength}
                      />
                      <ExposureStain
                        cx={arrivalX}
                        cy={unit.y - DY * 0.5}
                        strength={strength}
                        id={`bc-ceil-${unit.id}`}
                        hostW={unit.w}
                      />
                    </>
                  )}
                  <ExposureStain
                    cx={arrivalX}
                    cy={unit.y + unit.h - DY * 0.5}
                    strength={strength}
                    id={`bc-floor-${unit.id}`}
                    spread={fromAbove ? 1 : 1.3}
                    hostW={unit.w}
                  />
                </g>
              )}

              {coverageGaps?.has(unit.id) && <UnitCoverageBadge unit={unit} />}

              <text
                x={unit.x + 9}
                y={unit.y + 15}
                fontSize={11}
                fontWeight={600}
                fill={INK}
                opacity={0.72}
                pointerEvents="none"
              >
                {unit.label}
              </text>

              {occupiedUnits?.has(unit.id) && (
                <circle
                  cx={unit.x + unit.w - 9}
                  cy={unit.y + unit.h - 8}
                  r={2.6}
                  fill="#0ea5e9"
                  pointerEvents="none"
                />
              )}

              {/* Captioned only above the threshold, so the units immediately
                  below a leak are named and the weaker, further flags are left
                  to the marks. Drawing every one at the same weight tells the
                  reader to check the whole building, which is what they were
                  going to do anyway. */}
              {exposed && !alerting && strength >= EXPOSURE_LABEL_MIN && (
                /* Mid-height, between the ceiling stain and the floor pool. At
                   the floor it landed on top of the pool and was unreadable. */
                <text
                  x={unit.x + unit.w / 2}
                  y={unit.y + unit.h * 0.52}
                  fontSize={9}
                  fontWeight={700}
                  textAnchor="middle"
                  fill={EXPOSURE_INK}
                  stroke="#f8fafc"
                  strokeWidth={2.4}
                  paintOrder="stroke"
                  letterSpacing={0.7}
                  pointerEvents="none"
                >
                  INSPECT
                </text>
              )}

              {(hovered || selected) && (
                <path
                  d={roomVolumePath(unit)}
                  fill={selected ? 'rgba(37,99,235,0.10)' : 'rgba(37,99,235,0.05)'}
                  stroke={selected ? '#1d4ed8' : '#60a5fa'}
                  strokeWidth={selected ? 2.4 : 1.6}
                  pointerEvents="none"
                />
              )}

              <path
                d={roomVolumePath(unit)}
                fill="transparent"
                style={{ cursor: onUnitClick ? 'pointer' : 'default' }}
                onClick={() => onUnitClick?.(unit.id)}
                onMouseEnter={() => onUnitHover?.(unit.id)}
              >
                <title>{`Unit ${unit.label}`}</title>
              </path>
            </g>
          );
        })}

        <Risers
          building={building}
          units={units}
          selectedStackId={selectedStackId}
          lift={lift}
          onStackClick={onStackClick}
        />
        <UnitDrips units={units} exposures={exposures} />
      </g>

      {/* Which face this is. Relative rather than a compass bearing: we do not
          know the building's orientation, and "north elevation" would be a fact
          we invented. */}
      <text
        x={BUILDING_MARGIN_X}
        y={building.levels[0].top - PARAPET - 28}
        fontSize={13}
        fontWeight={700}
        fill={INK}
        letterSpacing={1.6}
        opacity={0.75}
      >
        {SIDE_LABEL[drawn].toUpperCase()}
      </text>
      <FacadeCaption
        building={building}
        side={drawn}
        x={BUILDING_MARGIN_X}
        y={building.levels[0].top - PARAPET - 13}
      />

      {far && farExposedCount > 0 && onFlip && (
        <CrossSideBadge
          x={BUILDING_MARGIN_X + building.unitsPerFloor * UNIT_W}
          y={building.levels[0].top - PARAPET - 18}
          count={farExposedCount}
          label={SIDE_LABEL[far]}
          onClick={() => onFlip(far)}
        />
      )}
    </g>
  );
}

/**
 * "3 exposed units on the rear elevation" — click to turn the building around.
 *
 * This is the control that makes the flip safe. Without it, exposure on the far
 * facade is invisible until you happen to look, which turns a safety view into a
 * guessing game about which side to check.
 */
function CrossSideBadge({
  x,
  y,
  count,
  label,
  onClick,
}: {
  x: number;
  y: number;
  count: number;
  label: string;
  onClick: () => void;
}) {
  const text = `${count} exposed on ${label.toLowerCase()}`;
  const w = 20 + text.length * 6.2;

  return (
    <g
      transform={`translate(${x - w} ${y - 16})`}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
    >
      <rect
        width={w}
        height={24}
        rx={12}
        fill="#fffbeb"
        stroke={EXPOSURE_INK}
        strokeWidth={1.4}
      />
      <circle cx={14} cy={12} r={5} fill={EXPOSURE_WASH} />
      <text x={26} y={16} fontSize={10.5} fontWeight={600} fill={EXPOSURE_INK}>
        {text}
      </text>
      <text x={w - 12} y={16} fontSize={11} fontWeight={700} fill={EXPOSURE_INK}>
        ›
      </text>
      <title>{`Flip to the ${label.toLowerCase()}`}</title>
    </g>
  );
}
