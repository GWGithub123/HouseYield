/**
 * Sectioned "dollhouse" view of the property — the front wall is removed so the
 * interior reads as rooms you can point at, with a shallow depth plane on each
 * floor so it feels like a volume rather than a flat elevation.
 *
 * Purely presentational: it draws the shell, the rooms and their fixtures, and
 * reports hover/click back up. Device pins, links and the shutoff valve are
 * layered on top by DeviceTopologyMap so they can share its existing artwork.
 */
import { createContext, useContext } from 'react';
import type { Fixture, FixtureKind, RoomDef } from './houseModel';
import type { FloorBands, HouseShell } from './houseProjection';
import { cabinetOffset, HOUSE_CAMERA_3D } from './houseProjection';
import type { SceneCamera } from './twinScene';
import { MAX_YAW } from './twinCamera';
import {
  BASEMENT_DEPTH_BELOW_GRADE_FT,
  DX as REST_DX,
  DY as REST_DY,
  fixtureAnchor,
  FLOOR_BANDS,
  INTERIOR_LEFT,
  INTERIOR_RIGHT,
  SERVICE_ENTRY_Y,
  SHELL,
  VERTICAL_UNITS_PER_M,
  SLAB,
  VALVE_INLET_X,
  VALVE_OUTLET_X,
  VB_W,
  WATER_MAIN_Y,
  WATER_RISER_X,
} from './houseModel';
import { computeFloodStage } from './floodStage';
import { spanOverlapCenter, spanOverlapFraction, type LeakExposure } from './leakPropagation';
import { isWetFixture } from './coverageModel';
import {
  Box,
  Cylinder,
  EXPOSURE_INK,
  EXPOSURE_LABEL_MIN,
  EXPOSURE_WASH,
  ExposureFromAbove,
  ExposureStain,
  FixtureLayer,
  FLOOR_FILL,
  INK,
  LINE,
  METAL_DARK,
  ROOM_FILL,
  roomCeilingPath,
  roomFloorPath,
  roomVolumePath,
  SOFT,
  SOIL,
  WALL,
} from './twinPrimitives';

/**
 * Roof overhang past the wall face. Eaves are most of what makes a roof read as
 * a built object rather than a triangle sitting on a box.
 */
const EAVE = 26;
/** Thickness of the roof deck, shown on every cut and overhanging edge. */
const ROOF_T = 13;

export interface HouseCutawayProps {
  rooms: RoomDef[];
  /** Per-room translucent overlay, e.g. comfort tint or hazard wash. */
  roomTints?: Record<string, string | undefined>;
  /** Rooms with a firing alert get a pulsing outline. */
  alertRooms?: Set<string>;
  /**
   * Spaces a detected leak may have reached, from {@link propagateLeak}.
   *
   * Deliberately drawn in a different language from `alertRooms`: an alerting
   * room is an observation and fills solid red through its whole volume, while an
   * exposed room is a geometric inference and gets amber patches only where water
   * would arrive and collect. Keeping the two apart is what stops the twin from
   * implying we detected water somewhere we did not — a room with a stain on its
   * ceiling and a pool on its floor is visibly a different claim from a room
   * that is filled.
   */
  exposures?: LeakExposure[];
  /**
   * Rooms with plumbing and no working water sensor, from {@link computeCoverage}.
   *
   * Drawn as a marker rather than as an area treatment, because a blind spot and
   * an exposure are not alternatives — the worst room in the building is one
   * that is both, and an area treatment for each would leave the two washes
   * fighting for the same pixels exactly where the drawing matters most.
   */
  coverageGaps?: Set<string>;
  /** Rooms that currently hold at least one device pin. */
  occupiedRooms?: Set<string>;
  selectedRoomId?: string | null;
  hoveredRoomId?: string | null;
  /** Highlighted as a valid target while a device pin is being dragged. */
  dropTargetRoomId?: string | null;
  dragging?: boolean;
  /**
   * Modelled depth of water standing at *exterior grade*, in feet — the
   * `home.depthFt` figure from the flood depth model, not a basement depth.
   * floodStage converts it to a level off the basement slab.
   */
  floodDepthFt?: number | null;
  /**
   * A leak sensor is reporting water below grade. Draws a shallow sheet with
   * no depth claim, for when we know water is present but not how much.
   */
  standingWater?: boolean;
  /** Draw the water distribution runs through the structure. */
  showWater?: boolean;
  /** Draw the branch wiring through the structure. */
  showPower?: boolean;
  /**
   * Whether the main shutoff is passing water.
   *
   * Everything downstream of the valve keys off this: the distribution dashes
   * stop, the pipes desaturate, and an active leak stops dripping. That last
   * one is the whole argument for owning the valve, so it is worth drawing.
   */
  waterFlowing?: boolean;
  /** Observed conditions outside, for the live weather layer. */
  weather?: LiveWeather | null;
  /**
   * Projected envelope of *this* property. Defaults to the archetypal shell so
   * previews and tests keep the drawing they have always had. The live house
   * cutaway uses the same archetypal model; Lot still draws the measured site.
   */
  shell?: HouseShell;
  bands?: FloorBands;
  /** The camera `projectHouse` used. Depth faces follow it when the section turns. */
  camera?: SceneCamera;
  onRoomClick?: (roomId: string) => void;
  onRoomHover?: (roomId: string | null) => void;
}

interface HouseGeom {
  shell: HouseShell;
  bands: FloorBands;
  interiorLeft: number;
  interiorRight: number;
  dx: number;
  dy: number;
  yaw: number;
}

const HouseGeomContext = createContext<HouseGeom>({
  shell: SHELL,
  bands: FLOOR_BANDS,
  interiorLeft: INTERIOR_LEFT,
  interiorRight: INTERIOR_RIGHT,
  dx: REST_DX,
  dy: REST_DY,
  yaw: 0,
});

function useHouseGeom(): HouseGeom {
  return useContext(HouseGeomContext);
}

const roomKey = (room: RoomDef) => `${room.id}--${room.floor}`;

function useAxis() {
  const { dx, dy, yaw } = useHouseGeom();
  return {
    DX: dx,
    DY: dy,
    yaw,
    back: (x: number, y: number, f = 1) => `${x + dx * f} ${y - dy * f}`,
  };
}

/** How open the near face is. 0 = head-on section, 1 = end of the readable arc. */
function cutAmount(yaw: number): number {
  return Math.min(1, Math.abs(yaw) / Math.max(MAX_YAW * 0.45, 0.2));
}

/**
 * Near rooms go translucent as the section turns so the room behind them
 * is actually visible, not just shifted a few pixels.
 */
function roomCutOpacity(room: RoomDef, yaw: number, peers: RoomDef[]): number {
  const amount = cutAmount(yaw);
  if (amount < 0.12 || room.camDepth == null) return 1;
  const same = peers.filter((r) => r.floor === room.floor && r.camDepth != null);
  if (same.length < 2) return 1;
  const depths = same.map((r) => r.camDepth!);
  const min = Math.min(...depths);
  const max = Math.max(...depths);
  if (max - min < 1e-3) return 1;
  const t = (room.camDepth - min) / (max - min);
  return 1 - (1 - t) * 0.62 * amount;
}

/**
 * What is actually happening outside, right now.
 *
 * Deliberately small and derived rather than a raw API payload: the drawing
 * needs to know how hard it is raining and which way the wind is pushing it,
 * not what OpenWeather's condition taxonomy calls it.
 */
export interface LiveWeather {
  /** 'none' draws nothing at all — a clear day should look like a clear day. */
  kind: 'none' | 'drizzle' | 'rain' | 'heavy' | 'storm' | 'snow';
  /** 0–1, drives droplet count, runoff width and animation speed. */
  intensity: number;
  windMph?: number | null;
}


/* ── yard ────────────────────────────────────────────────────────── */

/** A shrub: two overlapping lobes with a lit cap, rather than a flat circle. */
function Shrub({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g>
      <ellipse cx={x + r * 0.35} cy={y + 2} rx={r * 1.15} ry={r * 0.22} fill="#000" opacity={0.07} />
      <circle cx={x - r * 0.42} cy={y - r * 0.72} r={r * 0.72} fill="#b9cfae" />
      <circle cx={x + r * 0.42} cy={y - r * 0.66} r={r * 0.66} fill="#a8c19c" />
      <circle cx={x} cy={y - r} r={r * 0.82} fill="#c6d9bb" stroke="#96b189" strokeWidth={0.9} />
      <circle cx={x - r * 0.22} cy={y - r * 1.24} r={r * 0.34} fill="#d8e6cf" opacity={0.85} />
    </g>
  );
}

/**
 * Picket fence along the open side of the lot. Posts carry the same depth
 * offset as the rest of the drawing, so the run recedes with the lawn instead
 * of reading as a row of stickers on a flat plane.
 */
function planPoly(points: { x: number; y: number }[]) {
  if (points.length < 3) return '';
  return `${points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} Z`;
}

function planePath(pts: { x: number; y: number }[]) {
  return planPoly(pts);
}

/**
 * The real footprint at grade. A rectangle lands on the same pixels as the
 * old slab; an L or a wing is what makes Interior stop looking like the
 * archetype box.
 */
function PlanMass() {
  const { shell, yaw } = useHouseGeom();
  const { DX, DY } = useAxis();
  const plan = shell.plan;
  if (!plan || plan.length < 3) return null;
  /*
   * The plan outline is a top-down blob in mixed coordinates. Once the
   * section turns it reads as a second, drifting house. Leave it at rest.
   */
  if (Math.abs(yaw) > 0.15) return null;
  const winged = plan.length > 4;
  const rear = plan.map((p) => ({ x: p.x + DX, y: p.y - DY }));
  return (
    <g pointerEvents="none">
      <path
        d={planPoly(rear)}
        fill={winged ? '#b7cce8' : '#dfe6ee'}
        stroke="#94a3b8"
        strokeWidth={winged ? 1.8 : 1}
      />
      <path
        d={planPoly(plan)}
        fill={winged ? '#dbeafe' : '#dfe6ee'}
        stroke={winged ? '#1d4ed8' : '#c2ccd8'}
        strokeWidth={winged ? 2.6 : 1}
      />
    </g>
  );
}

/**
 * The lower masses attached to the house — garage, carport, porch.
 *
 * Each keeps its own eave, so a roof the aerial fit measured stepping down by
 * 2.4 m draws at 2.4 m instead of at whatever constant this file used to hold.
 * Drawn before the main walls so the two-storey box is not a slab that swallows
 * them.
 */
function WingMasses() {
  const { shell, yaw } = useHouseGeom();
  const { DX, DY } = useAxis();
  if (Math.abs(yaw) > 0.15) return null;
  const grade = shell.grade;

  return (
    <g pointerEvents="none">
      {shell.wings.map((wing, i) => {
        const { wallLeft: L, wallRight: R, wallTop: T } = wing;
        const w = R - L;
        if (w < 8) return null;
        const rise = 18;
        const deck = `M${L} ${T} L${R} ${T} L${R + DX} ${T - rise - DY} L${L + DX} ${T - rise - DY} Z`;
        return (
          <g key={`wing-${i}`}>
            <path
              d={deck}
              fill="url(#hy-roof-grad)"
              stroke={INK}
              strokeWidth={1.4}
              strokeLinejoin="round"
            />
            <path d={deck} fill="url(#hy-shingle)" />
            {wing.openSided ? (
              /*
               * A carport is a roof you can see under. Walling it turns it into
               * a windowless room glued to the house, which reads as a building
               * the owner does not have — so it gets posts and open air.
               */
              [L + 4, R - 4].map((x) => (
                <g key={x}>
                  <rect x={x - 2.6} y={T} width={5.2} height={grade - T} fill="#c8d8ef" stroke={INK} strokeWidth={1.3} />
                  <path
                    d={`M${x + 2.6} ${T} l${DX} ${-DY} V${grade - DY} l${-DX} ${DY} Z`}
                    fill="#adc3e2"
                    stroke={INK}
                    strokeWidth={1}
                  />
                </g>
              ))
            ) : (
              <>
                <rect x={L} y={T} width={w} height={grade - T} fill="#d7e4f7" stroke={INK} strokeWidth={1.6} />
                <path
                  d={`M${R} ${T} L${R + DX} ${T - DY} V${grade - DY} L${R} ${grade} Z`}
                  fill="#b9cdea"
                  stroke={INK}
                  strokeWidth={1.3}
                  strokeLinejoin="round"
                />
                {wing.role === 'garage' && (
                  /* The door is what tells a garage from a blank bay. */
                  <rect
                    x={L + w * 0.16}
                    y={T + (grade - T) * 0.2}
                    width={w * 0.68}
                    height={(grade - T) * 0.8}
                    rx={2}
                    fill="#eaf1fb"
                    stroke={INK}
                    strokeWidth={1.2}
                  />
                )}
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}

function Yard() {
  const { shell } = useHouseGeom();
  const { DX, back } = useAxis();
  const y = shell.grade;
  const h = 34;
  const from = 62;
  const to = 252;
  const gap = 15;
  const pw = 6;
  /** A fence is a few inches thick, not a room deep. */
  const F = 0.16;

  const pickets: number[] = [];
  for (let x = from; x <= to - pw; x += gap) pickets.push(x);

  const capY = y - h + 5;

  return (
    <g pointerEvents="none" opacity={0.92}>
      <ellipse cx={(from + to) / 2} cy={y + 2} rx={(to - from) / 2} ry={4} fill="#000" opacity={0.05} />

      {/*
        One depth plane for the whole fence, not one per picket.
        Giving every picket its own top face meant a 6 px board carried a 7 px
        parallelogram — the offset was wider than the thing it belonged to, and
        a row of them read as a barcode rather than a fence. A single receding
        cap along the top says the same thing about depth and stays quiet.
      */}
      <path
        d={`M${from} ${capY} H${to} L${back(to, capY, F)} H${from + DX * F} Z`}
        fill="#eef3f8"
        stroke="#b7c5d4"
        strokeWidth={0.8}
        strokeLinejoin="round"
      />

      {pickets.map((x) => (
        <path
          key={x}
          d={`M${x} ${capY} l${pw / 2} -5 l${pw / 2} 5 v${h - 5} h${-pw} Z`}
          fill="#f4f8fc"
          stroke="#aebdce"
          strokeWidth={0.8}
          strokeLinejoin="round"
        />
      ))}

      {/* Rails read as shadow behind the pickets rather than boards in front. */}
      {[capY + 8, y - 13].map((ry) => (
        <rect key={ry} x={from} y={ry} width={to - from} height={3.5} fill="#c9d6e4" opacity={0.75} />
      ))}

      <Shrub x={288} y={y} r={16} />
      <Shrub x={shell.wallLeft - 24} y={y} r={11} />
    </g>
  );
}

/* ── building services ───────────────────────────────────────────── */

const WIRE = '#f59e0b';
const PIPE = '#38bdf8';

/** Fixtures that need a supply line run to them. */
const WET_KINDS = new Set<FixtureKind>(['sink', 'tub', 'toilet', 'washer', 'water_heater', 'vanity']);

/**
 * Thickness of a floor slab, and therefore how far the ceiling of the storey
 * below hangs beneath the band boundary.
 */
const SLAB_T = 11;

/**
 * The incoming water service, from the street to the distribution trunk.
 *
 * This exists because the shutoff assembly used to be the only object in the
 * section that was not attached to the building. It sat mid-air in the middle
 * of the basement on a pipe that began and ended in nothing, which made the
 * largest and most mechanically detailed thing in the drawing also the least
 * believable. Real service has an unmistakable route — buried in from the
 * street, through a sleeve in the foundation wall, along the joists on hangers,
 * through the shutoff, then up a riser into the trunk under the main floor —
 * and drawing that route is what puts the valve *in* the house.
 *
 * The split at the valve is also what makes the control mean something: the
 * street side always has pressure, the house side only flows when the valve is
 * open.
 */
function WaterService({
  supplyY,
  downstreamFlowing,
}: {
  supplyY: number;
  downstreamFlowing: boolean;
}) {
  const { shell, interiorLeft } = useHouseGeom();
  const y = WATER_MAIN_Y;
  const wallOuter = shell.wallLeft;
  const wallInner = interiorLeft;
  /* Basement ceiling: the underside of the slab the trunk runs in. Hangers drop
     from here, which is what stops the run reading as a floating line. */
  const ceiling = supplyY + 4;

  /** Grey casing plus, when there is flow, blue moving inside it. */
  const run = (d: string, flowing: boolean, dur = '2.4s') => (
    <>
      <path d={d} fill="none" stroke="#cbd5e1" strokeWidth={9.5} strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} fill="none" stroke="#eef2f7" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
      {flowing ? (
        <path
          d={d}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={3.6}
          strokeLinecap="round"
          strokeDasharray="9 9"
          opacity={0.95}
        >
          <animate attributeName="stroke-dashoffset" values="0;-18" dur={dur} repeatCount="indefinite" />
        </path>
      ) : (
        <path d={d} fill="none" stroke="#b6c2d1" strokeWidth={3.2} strokeLinecap="round" opacity={0.7} />
      )}
    </>
  );

  /** Joist hanger: a drop rod off the ceiling, cradling the pipe in a strap. */
  const hanger = (hx: number) => (
    <g key={`hanger-${hx}`} opacity={0.75}>
      <path d={`M${hx} ${ceiling} V${y - 6}`} stroke="#a3b0c0" strokeWidth={1.5} fill="none" />
      <path
        d={`M${hx - 7} ${y - 6} A 7 7 0 0 0 ${hx + 7} ${y - 6}`}
        fill="none"
        stroke="#a3b0c0"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <rect x={hx - 8} y={ceiling - 3} width={16} height={3.5} rx={1.5} fill="#a3b0c0" />
    </g>
  );

  return (
    <g pointerEvents="none">
      {/* Buried service in from the street. Trench bedding sells "underground"
          without drawing an excavation. */}
      <path
        d={`M${wallOuter - 200} ${y + 13} H${wallOuter}`}
        stroke="#d9c9a8"
        strokeWidth={26}
        opacity={0.5}
        strokeLinecap="round"
      />
      {run(`M${wallOuter - 200} ${y} H${wallOuter + 2}`, true, '3.1s')}

      {/* Sleeve through the foundation wall. */}
      <rect
        x={wallOuter - 4}
        y={y - 11}
        width={shell.wallThickness + 8}
        height={22}
        rx={3}
        fill="#e2e8f0"
        stroke="#94a3b8"
        strokeWidth={1.6}
      />
      <rect x={wallOuter - 4} y={y - 11} width={shell.wallThickness + 8} height={5} rx={2} fill="#fff" opacity={0.6} />

      {/* Interior run to the shutoff inlet, carried on a hanger. */}
      {run(`M${wallInner - 2} ${y} H${VALVE_INLET_X + 2}`, true)}
      {/* Upstream of the shutoff and clear of its actuator. Together with the
          riser on the far side the assembly is carried at both ends, which is
          the difference between one installed in a basement and one hovering
          in it. */}
      {hanger(Math.round(VALVE_INLET_X - 42))}

      {/* House side: out of the valve, elbow, and up into the trunk. */}
      {run(
        `M${VALVE_OUTLET_X - 2} ${y} H${WATER_RISER_X} V${supplyY}`,
        downstreamFlowing,
        '2.0s',
      )}
      {/* Elbow collar so the turn reads as a fitting, not a bent line. */}
      <circle cx={WATER_RISER_X} cy={y} r={5.5} fill="#eef2f7" stroke="#94a3b8" strokeWidth={1.6} />
      {/* Pipe clip strapping the riser to the wall it climbs. */}
      <rect x={WATER_RISER_X - 8} y={y - 52} width={16} height={5} rx={2} fill="#94a3b8" opacity={0.85} />

      <text x={wallOuter - 196} y={y - 16} fontSize={12} fontWeight={700} fill="#7c8899" letterSpacing={0.4}>
        WATER SERVICE
      </text>
      {!downstreamFlowing && (
        <text x={WATER_RISER_X + 12} y={y - 30} fontSize={11} fontWeight={700} fill="#94a3b8">
          no flow
        </text>
      )}
    </g>
  );
}

/**
 * Branch wiring and domestic water, routed through the structure.
 *
 * Both systems hide inside the floor slabs and partitions rather than crossing
 * the open rooms. That is where they run in a real house, and it is also the
 * only place in this drawing with nothing else competing for the space — the
 * rooms themselves are already carrying furniture, labels, device pins and
 * tints. Runs are derived from the room geometry rather than hard-coded, so a
 * condo with no basement or a two-bed layout still gets plausible routing
 * instead of pipework hanging in a room that is no longer there.
 *
 * Drawn beneath the fixtures on purpose: furniture occluding the services is
 * what stops them reading as an overlay printed on top of the house.
 */
function BuildingServices({
  rooms,
  showWater,
  showPower,
  waterFlowing,
}: {
  rooms: RoomDef[];
  showWater: boolean;
  showPower: boolean;
  waterFlowing: boolean;
}) {
  const solid = rooms.filter((r) => r.floor !== 'exterior' && r.floor !== 'attic');
  if (solid.length === 0) return null;

  const anyOn = (floor: string) => solid.find((r) => r.floor === floor) ?? null;
  /** Top of a storey's floor slab. Rooms on a storey share it. */
  const slabTop = (floor: string) => {
    const r = anyOn(floor);
    return r ? r.y + r.h : null;
  };
  /* Two lanes inside the 11-unit slab so the two systems never sit on top of
     each other, which would read as one dashed line changing colour. */
  const wireY = (floor: string) => { const t = slabTop(floor); return t == null ? null : t + 3.5; };
  const pipeY = (floor: string) => { const t = slabTop(floor); return t == null ? null : t + 7.5; };

  const { interiorLeft, interiorRight } = useHouseGeom();
  const partitionsOn = (floor: string) => solid
    .filter((r) => r.floor === floor && r.x + r.w < interiorRight)
    .map((r) => r.x + r.w + 3.5);

  const nearestPartition = (floor: string, x: number): number | null => {
    const ps = partitionsOn(floor);
    if (!ps.length) return null;
    return ps.reduce((best, p) => (Math.abs(p - x) < Math.abs(best - x) ? p : best), ps[0]);
  };

  const hasMain = Boolean(anyOn('main'));
  const hasUpper = Boolean(anyOn('upper'));
  const hasBasement = Boolean(anyOn('basement'));

  const runLeft = interiorLeft + 20;
  const runRight = interiorRight - 20;

  /** The slab a storey hangs its services from: its own floor. */
  const serviceFloors = ['upper', 'main', 'basement'].filter((f) => anyOn(f));

  const panelFx = solid
    .flatMap((r) => r.fixtures.filter((f) => f.kind === 'panel').map((f) => ({ room: r, f })))[0] ?? null;
  const panelAt = panelFx ? fixtureAnchor(panelFx.f) : null;

  /* ── electrical ── */
  const wirePaths: string[] = [];

  if (panelAt) {
    /* Picks up where the exterior stub beside the meter stops. The wall is
       drawn between the two halves, so the conduit reads as passing through it
       rather than as a line laid over it. */
    wirePaths.push(
      `M${interiorRight} ${SERVICE_ENTRY_Y} H${panelAt.x} V${panelAt.y - 34}`,
    );
  }

  // Riser from the panel up through the storeys, jogging into whichever
  // partition each storey actually has rather than cutting through open rooms.
  if (panelAt && hasMain) {
    const mainWire = wireY('main');
    if (mainWire != null) {
      let d = `M${panelAt.x} ${panelAt.y - 34} V${mainWire}`;
      const jog = nearestPartition('main', panelAt.x);
      const upperWire = hasUpper ? wireY('upper') : null;
      if (jog != null && upperWire != null) d += ` H${jog} V${upperWire}`;
      wirePaths.push(d);
    }
  }

  for (const floor of serviceFloors) {
    const y = wireY(floor);
    if (y != null) wirePaths.push(`M${runLeft} ${y} H${runRight}`);
  }

  /* ── water ── */
  const pipePaths: string[] = [];
  /* Supply is distributed from the basement ceiling, which is the underside of
     the main floor slab — so both live on the same line. */
  const supplyFloor = hasBasement && hasMain ? 'main' : serviceFloors[serviceFloors.length - 1];
  const supplyY = pipeY(supplyFloor);

  if (supplyY != null) pipePaths.push(`M${runLeft} ${supplyY} H${runRight}`);

  const wetFixtures = solid.flatMap((r) => r.fixtures
    .filter((f) => WET_KINDS.has(f.kind))
    .map((f) => ({ room: r, f })));

  for (const { room, f } of wetFixtures) {
    if (supplyY == null) continue;
    // Rises to where the fixture is drawn, not to where its baseline is defined.
    const a = fixtureAnchor(f);
    if (room.floor === supplyFloor) {
      // Straight up out of the slab it stands on.
      pipePaths.push(`M${a.x} ${supplyY} V${a.y - 6}`);
    } else if (room.floor === 'basement') {
      // Hanging below the same slab.
      pipePaths.push(`M${a.x} ${supplyY} V${a.y - 46}`);
    } else {
      // A storey up: climb inside a partition, then run out in that floor's slab.
      const jog = nearestPartition(supplyFloor, a.x);
      const upY = pipeY(room.floor);
      if (jog == null || upY == null) continue;
      pipePaths.push(`M${jog} ${supplyY} V${upY} H${a.x} V${a.y - 6}`);
    }
  }

  /*
   * Two strokes, not three, and both thin.
   *
   * These runs are context: they explain how power and water reach the rooms.
   * At three stacked strokes each — halo, body, and a bright travelling dash —
   * a dozen of them read as loudly as the devices they serve, and the section
   * turned into a wiring diagram with a house somewhere behind it. A hairline
   * body with a dash moving over it says the same thing for a fraction of the
   * ink.
   *
   * `flowing` is what gives the shutoff consequences: with the valve closed the
   * dashes stop and the line desaturates, so the whole distribution network
   * visibly goes quiet.
   */
  const dash = (paths: string[], color: string, speed: number, key: string, flowing = true) => paths.map((d, i) => (
    <g key={`${key}-${i}`}>
      <path d={d} fill="none" stroke="#fff" strokeWidth={2.6} opacity={0.45} strokeLinecap="round" strokeLinejoin="round" />
      <path
        d={d}
        fill="none"
        stroke={flowing ? color : '#9aa8ba'}
        strokeWidth={flowing ? 1.1 : 1.5}
        opacity={flowing ? 0.5 : 0.62}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {flowing && (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.7}
          strokeDasharray="4 14"
          strokeLinecap="round"
          opacity={0.8}
        >
          <animate attributeName="stroke-dashoffset" values="0;-18" dur={`${speed}s`} repeatCount="indefinite" />
        </path>
      )}
    </g>
  ));

  return (
    <g pointerEvents="none">
      {showWater && dash(pipePaths, PIPE, 2.2, 'pipe', waterFlowing)}
      {showPower && dash(wirePaths, WIRE, 1.1, 'wire')}
    </g>
  );
}

/**
 * The pipework under a sink, and what it does when it fails.
 *
 * A trap is the most recognisable piece of domestic plumbing there is, and it
 * is exactly where a leak puck gets installed — drawing it turns "there is a
 * sensor in the kitchen" into a picture of the thing the sensor is watching.
 *
 * Drawn over the cabinet rather than inside it. Strictly the carcass is in
 * front, but a trap hidden behind a cupboard door communicates nothing, and the
 * whole section is already a cutaway of things you could not otherwise see. The
 * drip only runs when the room is actually reporting, so the motion carries
 * information instead of just being decoration.
 */
function UnderSinkDetail({
  rooms,
  alertRooms,
  waterFlowing = true,
}: {
  rooms: RoomDef[];
  alertRooms?: Set<string>;
  /** With the main shut, the trap stops dripping and only the puddle remains. */
  waterFlowing?: boolean;
}) {
  const sinks = rooms
    .filter((r) => r.floor !== 'exterior')
    .flatMap((room) => room.fixtures
      .filter((f) => f.kind === 'sink' || f.kind === 'vanity')
      .map((f) => ({ room, f })));

  if (sinks.length === 0) return null;

  return (
    <g pointerEvents="none">
      {sinks.map(({ room, f }) => {
        const leaking = alertRooms?.has(room.id) ?? false;
        const a = fixtureAnchor(f);
        /* The drip has to land on the floor *under the sink*, which the
           projection lifts by the same amount it lifted the basin. */
        const floor = room.y + room.h - (f.y - a.y);
        const trapTop = a.y + 4;
        const trapBottom = trapTop + 22;
        const trap = `M${a.x} ${trapTop} v12 q0 10 8 10 q8 0 8 -10 v-9`;
        return (
          <g key={`trap-${room.id}-${f.x}`}>
            <path d={trap} fill="none" stroke="#f8fafc" strokeWidth={5.5} opacity={0.8} strokeLinecap="round" />
            <path d={trap} fill="none" stroke="#8b9bb0" strokeWidth={3.4} strokeLinecap="round" />
            <path d={trap} fill="none" stroke="#e2e8f0" strokeWidth={1.1} strokeLinecap="round" />
            {leaking && (
              <g>
                {/*
                 * Closing the main is supposed to end the leak, so it does. The
                 * drips stop, the puddle stays exactly where it was and stops
                 * growing, and the difference between those two states is the
                 * entire case for the valve being on the wall in the first
                 * place — worth showing rather than describing.
                 */}
                {waterFlowing && [0, 0.9].map((delay) => (
                  <circle key={delay} cx={a.x + 8} cy={trapBottom} r={2.6} fill={PIPE}>
                    <animate
                      attributeName="cy"
                      values={`${trapBottom};${floor - 3}`}
                      dur="1.8s"
                      begin={`${delay}s`}
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0;1;1;0"
                      keyTimes="0;0.12;0.8;1"
                      dur="1.8s"
                      begin={`${delay}s`}
                      repeatCount="indefinite"
                    />
                  </circle>
                ))}
                <ellipse cx={a.x + 8} cy={floor - 2} rx={13} ry={3.2} fill={PIPE} opacity={0.45}>
                  {waterFlowing && (
                    <>
                      <animate attributeName="rx" values="8;15;8" dur="1.8s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.25;0.5;0.25" dur="1.8s" repeatCount="indefinite" />
                    </>
                  )}
                </ellipse>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

/**
 * Windows, punched through the back wall of the rooms that face outside.
 *
 * A dollhouse section without windows reads as a floor plan stood on its edge:
 * every room is a sealed box and there is no sense that any of it faces
 * anywhere. One over the kitchen sink is the single most recognisable window in
 * a house, and putting it there does something else useful — it gives the
 * weather somewhere to land indoors. When it is raining outside it is raining
 * on that glass, which connects the sky to the room the leak sensor is sitting
 * in without a word of explanation.
 */
function Windows({ rooms, rain }: { rooms: RoomDef[]; rain: number }) {
  const { interiorLeft, interiorRight } = useHouseGeom();
  const { DX, DY } = useAxis();
  /* Only the storey at eye level, and only rooms against an outside wall — an
     interior hallway with a window would be worse than no window at all. */
  const candidates = rooms.filter((r) => r.floor === 'main' || r.floor === 'upper');

  const placed = candidates
    .map((room) => {
      const sink = room.fixtures.find((f) => f.kind === 'sink' || f.kind === 'vanity');
      const outsideLeft = room.x <= interiorLeft + 1;
      const outsideRight = room.x + room.w >= interiorRight - 1;
      if (!sink && !outsideLeft && !outsideRight) return null;
      const w = 58;
      const h = 46;
      // Over the sink where there is one, otherwise centred in the room.
      const cx = sink ? sink.x : room.x + room.w / 2;
      const x = Math.max(room.x + 12, Math.min(room.x + room.w - w - 12, cx - w / 2));
      if (room.w < w + 30) return null;
      return { room, x: x + DX, y: room.y + 46 - DY, w, h };
    })
    .filter((v): v is { room: RoomDef; x: number; y: number; w: number; h: number } => v !== null);

  if (!placed.length) return null;

  return (
    <g pointerEvents="none">
      {placed.map(({ room, x, y, w, h }) => (
        <g key={`win-${room.id}`}>
          <defs>
            <linearGradient id={`hy-glass-${room.id}`} x1="0" y1="0" x2="0.6" y2="1">
              <stop offset="0%" stopColor="#dff0fd" />
              <stop offset="55%" stopColor="#bfe0f7" />
              <stop offset="100%" stopColor="#e8f4fd" />
            </linearGradient>
            <clipPath id={`hy-glass-clip-${room.id}`}>
              <rect x={x} y={y} width={w} height={h} rx={1.5} />
            </clipPath>
          </defs>

          {/* Reveal: the wall is thick, so the opening has a shaded return. */}
          <rect x={x - 4} y={y - 4} width={w + 8} height={h + 8} rx={2.5} fill="#cfdcea" />
          <rect x={x} y={y} width={w} height={h} rx={1.5} fill={`url(#hy-glass-${room.id})`} />

          {rain > 0 && (
            <g clipPath={`url(#hy-glass-clip-${room.id})`}>
              {Array.from({ length: Math.round(3 + rain * 5) }, (_, i) => {
                const dx = x + 5 + jitter(i, 21) * (w - 10);
                const dur = (2.6 - rain * 1.1 + jitter(i, 23) * 1.4).toFixed(2);
                return (
                  <circle key={i} cx={dx} cy={y} r={1.3 + jitter(i, 29) * 1.1} fill="#7cc4f0" opacity={0.75}>
                    <animate
                      attributeName="cy"
                      values={`${y - 2};${y + h + 2}`}
                      dur={dur}
                      begin={`-${(jitter(i, 31) * Number(dur)).toFixed(2)}s`}
                      repeatCount="indefinite"
                    />
                  </circle>
                );
              })}
            </g>
          )}

          {/* Muntins and frame. */}
          <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y + h} stroke="#f8fafc" strokeWidth={2.2} />
          <line x1={x} y1={y + h * 0.45} x2={x + w} y2={y + h * 0.45} stroke="#f8fafc" strokeWidth={2.2} />
          <rect x={x} y={y} width={w} height={h} rx={1.5} fill="none" stroke="#f8fafc" strokeWidth={3.4} />
          <rect x={x} y={y} width={w} height={h} rx={1.5} fill="none" stroke={INK} strokeWidth={1.3} opacity={0.55} />

          {/* Sill, projecting forward out of the back wall. */}
          <path
            d={`M${x - 5} ${y + h + 4} L${x + w + 5} ${y + h + 4} L${x + w + 1} ${y + h + 9} L${x - 9} ${y + h + 9} Z`}
            fill="#e8eef6"
            stroke="#b6c2d0"
            strokeWidth={1}
            strokeLinejoin="round"
          />
        </g>
      ))}
    </g>
  );
}

/* ── weather ─────────────────────────────────────────────────────── */

/**
 * Stable pseudo-random in [0,1).
 *
 * Raindrops need to look scattered, but the scatter has to survive a re-render
 * and be identical in the snapshot previews, so `Math.random` is out.
 */
const jitter = (i: number, salt = 1) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * What the sky is doing, drawn onto the section.
 *
 * The section already shows the house responding to water from below — flood
 * stage, saturated ground, the drainage network on the map layers. What it
 * never showed was water arriving from above, which is where nearly all of it
 * comes from and the only part an owner can watch happen. Rain that visibly
 * lands on the roof, sheets down the slopes, leaves through the gutter and
 * runs away across the lot makes the drawing a picture of the property right
 * now rather than a diagram of its equipment.
 *
 * Rain is clipped out of the house silhouette rather than drawn over it. Drops
 * crossing the cutaway would be wrong — they would be falling through rooms —
 * and they would wreck the legibility of the one region that has to stay
 * readable. Stopping them at the roofline is both more accurate and quieter.
 */
function WeatherLayer({ weather }: { weather: LiveWeather }) {
  const { shell } = useHouseGeom();
  const { DX, DY } = useAxis();
  const { kind, intensity } = weather;
  if (kind === 'none' || intensity <= 0) return null;

  const snow = kind === 'snow';
  const t = Math.max(0, Math.min(1, intensity));
  /* Generous, because the house is cut out of the field: roughly half of any
     uniform scatter lands behind the roof and walls and never draws. */
  const count = Math.round((snow ? 34 : 48) + t * (snow ? 34 : 96));
  // Wind pushes the fall off vertical; capped so a gale still reads as rain
  // rather than as hatching.
  const tilt = Math.max(-0.42, Math.min(0.42, (weather.windMph ?? 0) / 46));
  const len = snow ? 0 : 13 + t * 17;
  const fallDur = snow ? 5.4 : 1.05 - t * 0.42;

  const top = -40;
  const bottom = shell.grade;
  const span = bottom - top;
  const leftX = 90;
  const rightX = VB_W - 60;

  /* The house is cut out of the rainfall so drops stop at the roof and walls
     instead of raining through the rooms. */
  const silhouette = [
    `M${shell.roofLeft.x} ${shell.roofLeft.y}`,
    `L${shell.roofPeak.x} ${shell.roofPeak.y}`,
    `L${shell.roofPeak.x + DX} ${shell.roofPeak.y - DY}`,
    `L${shell.roofRight.x + DX} ${shell.roofRight.y - DY}`,
    `L${shell.wallRight + DX} ${shell.grade}`,
    `L${shell.wallLeft} ${shell.grade}`,
    `L${shell.wallLeft} ${shell.roofLeft.y}`,
    'Z',
  ].join(' ');

  const drop = (i: number) => {
    const x = leftX + jitter(i, 3) * (rightX - leftX);
    const delay = jitter(i, 7) * fallDur;
    const depth = 0.55 + jitter(i, 11) * 0.45; // nearer drops are darker and faster
    const dur = (fallDur / depth).toFixed(2);
    const drift = tilt * (span + len);
    /* Where this drop sits before the animation takes over. Matters more than
       it looks: a static renderer ignores SMIL and draws the base transform, so
       without this every preview of a rainstorm came out dry. */
    const phase = delay / fallDur;
    const restY = top + span * (1 - phase);
    const restX = x + drift * (1 - phase);
    if (snow) {
      const sway = 10 + jitter(i, 13) * 16;
      return (
        <circle key={i} r={1.5 + depth * 1.6} fill="#e2effb" opacity={0.5 + depth * 0.4} transform={`translate(${restX.toFixed(1)} ${restY.toFixed(1)})`}>
          <animateTransform
            attributeName="transform"
            type="translate"
            values={`${x} ${top}; ${x + sway} ${(top + bottom) / 2}; ${x - sway * 0.4} ${bottom}`}
            dur={dur}
            begin={`-${delay.toFixed(2)}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0;0.85;0.85;0"
            keyTimes="0;0.08;0.86;1"
            dur={dur}
            begin={`-${delay.toFixed(2)}s`}
            repeatCount="indefinite"
          />
        </circle>
      );
    }
    return (
      <line
        key={i}
        x1={0}
        y1={0}
        x2={-tilt * len}
        y2={-len}
        stroke="#7cc4f0"
        strokeWidth={0.7 + depth * 0.9}
        strokeLinecap="round"
        opacity={0.22 + depth * 0.4}
        transform={`translate(${restX.toFixed(1)} ${restY.toFixed(1)})`}
      >
        <animateTransform
          attributeName="transform"
          type="translate"
          values={`${x} ${top}; ${x + drift} ${bottom + len}`}
          dur={dur}
          begin={`-${delay.toFixed(2)}s`}
          repeatCount="indefinite"
        />
      </line>
    );
  };

  /** Sheet flow down a roof plane, from the ridge toward the eave. */
  const roofSheet = (from: { x: number; y: number }, to: { x: number; y: number }, key: string) =>
    [0.25, 0.55, 0.85].map((f, i) => {
      const sx = from.x + (DX) * f;
      const sy = from.y - (DY) * f;
      const ex = to.x + (DX) * f;
      const ey = to.y - (DY) * f;
      return (
        <path
          key={`${key}-${i}`}
          d={`M${sx} ${sy} L${ex} ${ey}`}
          stroke="#8ccbf2"
          strokeWidth={1.8 + t * 2}
          strokeLinecap="round"
          strokeDasharray={`${10 + t * 14} ${24 - t * 9}`}
          opacity={0.4 + t * 0.4}
          fill="none"
        >
          <animate
            attributeName="stroke-dashoffset"
            values="0;-34"
            dur={`${(1.5 - t * 0.7).toFixed(2)}s`}
            repeatCount="indefinite"
          />
        </path>
      );
    });

  /** Runoff leaving the property, drawn across the lawn on both sides. */
  const runoff = (side: -1 | 1) => {
    const originX = side < 0 ? shell.wallLeft - 16 : shell.wallRight + 16;
    return [0, 1, 2].map((i) => {
      // On the grass, just above grade — below it is soil, and water running
      // through the ground is a different claim entirely.
      const y = shell.grade - 17 + i * 7;
      const reach = (110 + i * 34) * side;
      return (
        <path
          key={`runoff-${side}-${i}`}
          d={`M${originX} ${y} q ${reach * 0.5} ${6 + i * 2} ${reach} ${2 + i * 3}`}
          fill="none"
          stroke="#7cc4f0"
          strokeWidth={1.2 + t * 1.4}
          strokeLinecap="round"
          strokeDasharray="7 15"
          opacity={0.28 + t * 0.42}
        >
          <animate
            attributeName="stroke-dashoffset"
            values={side < 0 ? '0;22' : '0;-22'}
            dur={`${(1.9 - t * 0.8).toFixed(2)}s`}
            repeatCount="indefinite"
          />
        </path>
      );
    });
  };

  return (
    <g pointerEvents="none">
      <defs>
        <clipPath id="hy-sky-clip" clipRule="evenodd">
          <path d={`M0 ${top} H${VB_W} V${bottom} H0 Z ${silhouette}`} clipRule="evenodd" />
        </clipPath>
      </defs>

      {/* Overcast veil — enough to change the mood of the sky, not enough to
          grey out the drawing underneath it. */}
      {(kind === 'storm' || kind === 'heavy') && (
        <rect x={0} y={0} width={VB_W} height={shell.grade} fill="#64748b" opacity={0.05 + t * 0.05} />
      )}

      <g clipPath="url(#hy-sky-clip)">{Array.from({ length: count }, (_, i) => drop(i))}</g>

      {!snow && (
        <>
          {roofSheet(shell.roofPeak, shell.roofLeft, 'sheet-l')}
          {roofSheet(shell.roofPeak, shell.roofRight, 'sheet-r')}
        </>
      )}

      {!snow && runoff(-1)}
      {!snow && runoff(1)}

      {/* Thunderstorms get an occasional soft flash. Long period on purpose:
          anything more frequent stops being weather and starts being a
          notification. */}
      {kind === 'storm' && (
        <rect x={0} y={0} width={VB_W} height={shell.grade} fill="#fff" opacity={0}>
          <animate
            attributeName="opacity"
            values="0;0;0.42;0.05;0.3;0;0"
            keyTimes="0;0.9;0.915;0.93;0.945;0.965;1"
            dur="9s"
            repeatCount="indefinite"
          />
        </rect>
      )}
    </g>
  );
}

/**
 * Gutter and downspout on the left eave.
 *
 * Permanent architecture, not a weather effect — a house has these whether or
 * not it is raining, and a roof that sheds water into thin air was one of the
 * details making the exterior read as a diagram. It carries flow only when
 * there is flow to carry.
 */
function Gutters({ flow }: { flow: number }) {
  const { shell } = useHouseGeom();
  const { DX, DY } = useAxis();
  const eave = shell.roofLeft;
  const spoutX = shell.wallLeft - 8;
  const bottom = shell.grade - 6;
  const running = flow > 0;
  const spout = `M${eave.x + 2} ${eave.y + 12} V${eave.y + 26} L${spoutX} ${eave.y + 44} V${bottom} q0 8 -10 10`;

  return (
    <g pointerEvents="none">
      {/* Trough along the receding eave. */}
      <path
        d={`M${eave.x - 3} ${eave.y + 7} L${eave.x + DX - 3} ${eave.y - DY + 7}`}
        stroke="#cbd5e1"
        strokeWidth={7}
        strokeLinecap="round"
        fill="none"
      />
      <path
        d={`M${eave.x - 3} ${eave.y + 5} L${eave.x + DX - 3} ${eave.y - DY + 5}`}
        stroke="#eef2f7"
        strokeWidth={2.4}
        strokeLinecap="round"
        fill="none"
      />

      {/* Downspout, elbowed back to the wall and kicked out at the bottom. */}
      <path d={spout} fill="none" stroke="#cbd5e1" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
      <path d={spout} fill="none" stroke="#f1f5f9" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      {[eave.y + 90, eave.y + 200, eave.y + 300].filter((y) => y < bottom - 20).map((y) => (
        <rect key={y} x={spoutX - 5} y={y} width={10} height={3.4} rx={1.4} fill="#94a3b8" opacity={0.8} />
      ))}

      {running && (
        <path
          d={spout}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeDasharray={`${6 + flow * 8} 12`}
          opacity={0.5 + flow * 0.4}
        >
          <animate
            attributeName="stroke-dashoffset"
            values="0;-36"
            dur={`${(1.4 - flow * 0.7).toFixed(2)}s`}
            repeatCount="indefinite"
          />
        </path>
      )}
    </g>
  );
}

/* ── leak exposure ───────────────────────────────────────────────── */

/**
 * Water crossing the floor assembly between a leaking room and the room below.
 *
 * The gap between two rooms' drawn edges *is* the slab — `band()` insets every
 * room by {@link SLAB} top and bottom — so a drip that starts at the source
 * room's floor and ends inside the room beneath it visibly passes through the
 * structure water actually has to get through. That is the whole point of
 * drawing it rather than just tinting both rooms: it shows the route, not only
 * the endpoints.
 */
function ExposureDrips({
  rooms,
  exposures,
  flowing = true,
}: {
  rooms: RoomDef[];
  exposures: LeakExposure[];
  /** With the main shut there is no new water, so the drips stop. */
  flowing?: boolean;
}) {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const sources = exposures.filter((e) => e.tier === 'source');
  const direct = exposures.filter((e) => e.tier === 'direct');

  if (sources.length === 0 || direct.length === 0) return null;

  /*
   * Pair each wet room with the rooms it actually drips into. A drip is only
   * honest between rooms that are vertically adjacent and horizontally
   * overlapping, which is exactly the `direct` tier one level down.
   *
   * Chained from every wet room rather than only from the leak, so a leak two
   * floors up draws a route the whole way down. An earlier version iterated
   * sources alone and claimed in a comment that deeper rungs got their own drip
   * from the room above them — they did not, because the room above them is not a
   * source, so the route simply stopped after one floor and the basement looked
   * like it had been reached by magic.
   */
  const runs: Array<{ key: string; x: number; from: number; to: number; strength: number }> = [];

  for (const source of [...sources, ...direct]) {
    const sourceRoom = byId.get(source.cellId);
    if (!sourceRoom) continue;

    for (const exposure of direct) {
      const room = byId.get(exposure.cellId);
      if (!room) continue;
      // Only the rung immediately beneath this source; deeper rungs get their
      // own drip from the room above them.
      if (room.y <= sourceRoom.y) continue;
      if (spanOverlapFraction(sourceRoom, room) <= 0) continue;
      if (room.y - (sourceRoom.y + sourceRoom.h) > SLAB * 3) continue;

      const left = Math.max(sourceRoom.x, room.x);
      const right = Math.min(sourceRoom.x + sourceRoom.w, room.x + room.w);
      runs.push({
        key: `${source.cellId}-${exposure.cellId}`,
        x: (left + right) / 2,
        from: sourceRoom.y + sourceRoom.h,
        to: room.y + Math.min(34, room.h * 0.3),
        strength: exposure.likelihood,
      });
    }
  }

  if (runs.length === 0) return null;

  return (
    <g pointerEvents="none">
      {runs.map(({ key, x, from, to, strength }) => (
        <g key={`drip-${key}`}>
          {/* Wet stain spreading on the underside of the slab, which is what a
              ceiling leak actually looks like from below. */}
          <ellipse
            cx={x}
            cy={to - 2}
            rx={16 + strength * 12}
            ry={4.5}
            fill={EXPOSURE_WASH}
            opacity={0.16 + strength * 0.2}
          />
          <path
            d={`M${x} ${from} V${to}`}
            stroke={EXPOSURE_WASH}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeDasharray="5 7"
            opacity={0.55 + strength * 0.35}
          >
            {flowing && (
              <animate
                attributeName="stroke-dashoffset"
                values="0;-24"
                dur={`${(1.5 - strength * 0.6).toFixed(2)}s`}
                repeatCount="indefinite"
              />
            )}
          </path>
        </g>
      ))}
    </g>
  );
}

/* ── coverage gaps ───────────────────────────────────────────────── */

const GAP_INK = '#64748b';

/**
 * How far above a fixture's baseline to float its badge, per kind.
 *
 * A fixture's art is drawn upward from its anchor, so a single offset buries the
 * badge inside anything tall — the water heater in particular, whose tank and
 * flue reach 78 units up. These clear the top face of each fixture, including
 * the lift the oblique projection adds to it.
 */
const GAP_BADGE_LIFT: Partial<Record<FixtureKind, number>> = {
  sink: 38,
  tub: 44,
  toilet: 46,
  vanity: 48,
  sump: 46,
  washer: 62,
  water_heater: 92,
};

const GAP_BADGE_R = 10;

/**
 * "This room has plumbing and nothing is watching it."
 *
 * A crossed-out droplet, at the wet fixture rather than at the room label,
 * because the claim is about the fixture: the gap is not that a room is
 * unmonitored in general, it is that *that sink* has no sensor under it. Placing
 * the badge on the fixture also means a room with two wet fixtures and one
 * sensor is not misrepresented as fully covered.
 *
 * Slate, not amber or red. A coverage gap is a purchasing decision on a normal
 * day, and colouring it like an alert would put permanent hazard styling on a
 * house where nothing is wrong.
 */
function CoverageGapBadges({
  rooms,
  gaps,
}: {
  rooms: RoomDef[];
  gaps: Set<string>;
}) {
  const marks = rooms
    .filter((room) => room.floor !== 'exterior' && gaps.has(room.id))
    .flatMap((room) => room.fixtures
      .filter((fixture) => isWetFixture(fixture.kind))
      .map((fixture) => ({ room, anchor: fixtureAnchor(fixture), kind: fixture.kind })));

  if (marks.length === 0) return null;

  return (
    <g pointerEvents="none">
      {marks.map(({ room, anchor, kind }) => {
        /* Clamped into the room so a fixture near a partition does not throw its
           badge into the room next door, which would blame the wrong space. */
        const cx = Math.min(
          Math.max(anchor.x, room.x + GAP_BADGE_R + 2),
          room.x + room.w - GAP_BADGE_R - 2,
        );
        const cy = anchor.y - (GAP_BADGE_LIFT[kind] ?? 40);
        return (
          <g key={`gap-${room.id}-${kind}-${anchor.x}`}>
            <circle cx={cx} cy={cy} r={GAP_BADGE_R} fill="#f8fafc" opacity={0.94} />
            <circle cx={cx} cy={cy} r={GAP_BADGE_R} fill="none" stroke={GAP_INK} strokeWidth={1.5} opacity={0.85} />
            {/* Droplet: a point at the top, a bowl at the bottom. */}
            <path
              d={`M${cx} ${cy - 5.4} q4.6 4.8 4.6 7.7 a4.6 4.6 0 0 1 -9.2 0 q0 -2.9 4.6 -7.7 Z`}
              fill="none"
              stroke={GAP_INK}
              strokeWidth={1.5}
              strokeLinejoin="round"
              opacity={0.9}
            />
            <path
              d={`M${cx - 7} ${cy + 7} L${cx + 7} ${cy - 7}`}
              stroke={GAP_INK}
              strokeWidth={2.1}
              strokeLinecap="round"
            />
          </g>
        );
      })}
    </g>
  );
}

/* ── roof ────────────────────────────────────────────────────────── */

/**
 * A gable whose ridge runs along the street.
 *
 * The projected planes arrive sorted back to front, so this is a straight
 * painter's pass — the far slope goes down first and the near one covers
 * whatever of it should not be visible. There is deliberately no gable wall
 * here: on a side gable the facade meets the eave and the triangles are at the
 * two ends of the house, which is exactly what stops a wide colonial reading as
 * an A-frame.
 */
function SideGableRoof() {
  const { shell, bands } = useHouseGeom();
  const { DX, DY, yaw } = useAxis();
  /*
   * Sit on the bedrooms, not on ATTOM's storey count.
   *
   * `wallTop` used to be `storeys * 2.7`. When that was a storey above the
   * upper floor, the lid floated and this parallelogram only made it worse
   * by receding another half-floor into the sky. The eave is the top of
   * the rooms we drew. Rise is a shallow colonial cap, not the 3D ridge.
   */
  const upper = bands.upper;
  const eave = (upper && upper.top < upper.bottom - 4) ? upper.top : bands.main.top;
  const L = shell.roofLeft;
  const R = shell.roofRight;
  const rise = 32;
  const deck = `M${L.x} ${eave} L${R.x} ${eave} L${R.x + DX} ${eave - rise - DY} L${L.x + DX} ${eave - rise - DY} Z`;

  return (
    <g opacity={1 - cutAmount(yaw) * 0.72} pointerEvents="none">
      <path
        d={deck}
        fill="url(#hy-roof-grad)"
        stroke={INK}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <path d={deck} fill="url(#hy-shingle)" />
      <path
        d={`M${L.x} ${eave} L${R.x} ${eave} L${R.x} ${eave + ROOF_T} L${L.x} ${eave + ROOF_T} Z`}
        fill="#7ea6de"
        stroke={INK}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      {shell.wallTop < eave - 4 && (
        <rect
          x={shell.wallLeft}
          y={shell.wallTop}
          width={shell.wallRight - shell.wallLeft}
          height={eave - shell.wallTop}
          fill={WALL}
        />
      )}
    </g>
  );
}

/**
 * The colonial pent roof — a shallow shelf between the storeys.
 *
 * Not measured; it is the one facade move that makes a side-gable colonial
 * read as itself from the street, and it costs nothing once the walls are
 * in the right place.
 */
function PentRoof() {
  const { shell, bands } = useHouseGeom();
  if (shell.ridgeAxis !== 'x') return null;
  const y = bands.main.top;
  const L = shell.wallLeft;
  const R = shell.wallRight;
  const drop = 14;
  const over = 10;
  return (
    <path
      d={`M${L} ${y} H${R} L${R + over} ${y + drop} H${L - over} Z`}
      fill="#9bb6de"
      stroke={INK}
      strokeWidth={1.3}
      strokeLinejoin="round"
      pointerEvents="none"
    />
  );
}

/* ── shell ───────────────────────────────────────────────────────── */

export default function HouseCutaway({
  rooms,
  roomTints = {},
  alertRooms,
  exposures = [],
  coverageGaps,
  occupiedRooms,
  selectedRoomId,
  hoveredRoomId,
  dropTargetRoomId,
  dragging = false,
  floodDepthFt = null,
  standingWater = false,
  showWater = true,
  showPower = false,
  waterFlowing = true,
  weather = null,
  shell: shellProp,
  bands: bandsProp,
  camera: cameraProp,
  onRoomClick,
  onRoomHover,
}: HouseCutawayProps) {
  const shell = shellProp ?? SHELL;
  const bands = bandsProp ?? FLOOR_BANDS;
  const axis = cabinetOffset(cameraProp ?? HOUSE_CAMERA_3D);
  const yaw = cameraProp?.yaw ?? 0;
  const DX = Number.isFinite(shell.depthDx) ? shell.depthDx : axis.dx;
  const DY = Number.isFinite(shell.depthDy) ? shell.depthDy : axis.dy;
  const back = (x: number, y: number, f = 1) => `${x + DX * f} ${y - DY * f}`;
  /*
   * Do not drop a side wall as soon as the house turns. That is the pop
   * that reads as the drawing glitching. The cut is the missing *front*.
   */
  const hideRight = false;
  const hideLeft = false;
  const interiorLeft = shell.wallLeft + shell.wallThickness;
  const interiorRight = shell.wallRight - shell.wallThickness;
  const geom = { shell, bands, interiorLeft, interiorRight, dx: DX, dy: DY, yaw };
  const clip = {
    x: interiorLeft,
    y: shell.wallTop,
    w: interiorRight - interiorLeft,
    h: shell.basementFloor + 20 - shell.wallTop,
  };
  const interiorW = interiorRight - interiorLeft;
  const basementBand = bands.basement;
  const hasBasement = rooms.some((r) => r.floor === 'basement');
  /* Underside of the main floor slab, which is where the basement ceiling and
     therefore the supply trunk lives. Shared with BuildingServices so the riser
     out of the shutoff lands exactly on the trunk it feeds. */
  const supplyTrunkY = bands.main.bottom + 7.5;
  const meter = {
    x: shell.wallRight + DX + 10,
    y: shell.grade - 1.5 * VERTICAL_UNITS_PER_M,
  };

  /**
   * `floodDepthFt` is depth at exterior grade, not depth in the basement — the
   * stage model does that conversion. Clamped to the shell so an extreme storm
   * still draws inside the drawing.
   */
  const stage = computeFloodStage({
    depthAtGradeFt: floodDepthFt,
    sensorWater: standingWater,
    hasBasement,
  });
  const waterTop = stage ? Math.max(shell.wallTop + 20, stage.waterY) : null;

  return (
    <HouseGeomContext.Provider value={geom}>
    <g>
      <defs>
        {/* Two roof tones: the slopes face different ways, and giving them the
            same fill is what collapses a gable back into a flat triangle. */}
        <linearGradient id="hy-roof-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfe2fe" />
          <stop offset="100%" stopColor="#a3c6fb" />
        </linearGradient>
        <linearGradient id="hy-roof-grad-dark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a9c8f6" />
          <stop offset="100%" stopColor="#7ea6de" />
        </linearGradient>
        <linearGradient id="hy-flood-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(59,130,246,0.55)" />
          <stop offset="100%" stopColor="rgba(30,58,138,0.72)" />
        </linearGradient>
        <pattern id="hy-shingle" width="16" height="9" patternUnits="userSpaceOnUse">
          <path d="M0 9 h16 M8 0 v9" stroke="rgba(30,64,175,0.16)" strokeWidth="1" fill="none" />
        </pattern>
        {/* Barrel shading for upright cylinders — light from the front-left. */}
        <linearGradient id="hy-cyl-metal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#aebbcb" />
          <stop offset="32%" stopColor="#e2e8f0" />
          <stop offset="70%" stopColor="#c2cddb" />
          <stop offset="100%" stopColor="#8fa0b4" />
        </linearGradient>
        <linearGradient id="hy-cyl-app" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#bccadb" />
          <stop offset="32%" stopColor="#eef3f9" />
          <stop offset="70%" stopColor="#d2dded" />
          <stop offset="100%" stopColor="#adbdd1" />
        </linearGradient>
        {/* Rooms sink back into shadow, which separates them from the objects. */}
        <linearGradient id="hy-room-depth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfdef4" />
          <stop offset="40%" stopColor="#e9f1fc" />
          <stop offset="100%" stopColor="#f8fbff" />
        </linearGradient>
        {/*
          Contact shading where the back wall meets the ceiling and the left
          wall. Flat interior planes are what keep reading as paper no matter
          how correct the geometry is; a little occlusion in the corners is the
          cheapest possible fix and costs no extra geometry.
        */}
        <linearGradient id="hy-ao-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5b7fb5" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#5b7fb5" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hy-ao-left" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#5b7fb5" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#5b7fb5" stopOpacity="0" />
        </linearGradient>
        {/*
          The floor as a lit plane rather than a flat tint.

          This matters more than it looks like it should. Furniture stands back
          off the front of each room, so there is a strip of floor in front of
          every object — and while that strip was the same value as the wall
          behind it, it read as empty space and every sofa and bed looked like it
          was hovering. Shading the plane from a dark junction at the skirting to
          a lit front edge is what turns the strip into something the furniture is
          demonstrably standing on.
        */}
        <linearGradient id="hy-floor-plane" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#bcd5f6" />
          <stop offset="45%" stopColor="#d8e8fd" />
          <stop offset="100%" stopColor="#edf5ff" />
        </linearGradient>
        <linearGradient id="hy-floor-plane-basement" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b3c1d3" />
          <stop offset="45%" stopColor="#cfd9e6" />
          <stop offset="100%" stopColor="#e3eaf2" />
        </linearGradient>
        {/*
          The envelope every interior surface lives inside.

          Each floor's back plane is offset a room-depth up and to the right, so
          without a boundary the top storey's ceiling pushed up into the gable
          and every storey's back wall ran out through the right-hand exterior
          wall — which is what made the floors look like they missed the wall
          they were supposed to meet. Clipping at the inside faces means the
          structure can be drawn in whatever order reads best without any of it
          escaping the building.
        */}
        <clipPath id="hy-interior-clip">
          <rect x={clip.x} y={clip.y} width={clip.w} height={clip.h} />
        </clipPath>
        {/*
          One clip per room, shaped like the room's own volume. Fixtures carry a
          depth offset, so a cabinet drawn flush to a partition put its top and
          side faces through the wall and into the next room — the fridge
          standing on the kitchen/dining wall was this. Positions are corrected
          upstream; this keeps any future one honest.
        */}
        {rooms
          .filter((r) => r.floor !== 'exterior')
          .map((room) => (
            <clipPath key={`clip-${roomKey(room)}`} id={`hy-room-clip-${roomKey(room)}`}>
              <path d={roomVolumePath(room)} />
            </clipPath>
          ))}
      </defs>

      {/* ── ground ──
          The lawn is drawn as a receding plane rather than a line, so grade is
          a surface the house sits *in*. That one plane does more for the sense
          of depth than anything inside the shell, because it establishes the
          projection before the eye reaches the building. */}
      <g>
        <rect x={0} y={shell.grade} width={1320} height={920 - shell.grade} fill={SOIL} />
        <path
          d={`M-40 ${shell.grade} H1360 L${1360 + DX} ${shell.grade - DY} H${-40 + DX} Z`}
          fill="#e7eee2"
          stroke="#c8d5c0"
          strokeWidth={1}
        />
        <path d={`M-40 ${shell.grade} H1360`} stroke="#b6c4ad" strokeWidth={2} />
      </g>

      {/* ── yard ──
          A fence and some planting on the open side. None of this carries data;
          it exists so the house is standing somewhere rather than floating, and
          so the flood waterline has familiar objects to be measured against. */}
      <Yard />
      <PlanMass />
      <WingMasses />

      {/* ── street-side detail ──
          A short apron of walk at the entry end, giving the right-hand yard
          something besides bare lawn under the service equipment. */}
      <path
        d={`M${shell.wallRight + DX + 4} ${shell.grade} H1120 L${1120 + DX} ${shell.grade - DY} H${shell.wallRight + DX + 4 + DX} Z`}
        fill="#e8ecf0"
        stroke="#cfd8e0"
        strokeWidth={1}
      />

      {/* ── below-grade foundation ──
          Carried out to the same depth as everything above so the basement and
          the ground plane meet on the right instead of ending at two different
          x values, which is what made the lower right corner look broken. */}
      {hasBasement && (
        <g>
          {/*
            Flush with the walls above, not proud of them.

            A real foundation is thicker than the framing it carries, and this
            used to show that with an 8-unit offset on each side. At this scale
            it did not read as a thicker wall, it read as the storey above being
            misaligned with the one below — a visible step exactly where the eye
            is already checking whether the drawing lines up. The footing at the
            bottom still does the job of showing the house bears on something.
          */}
          <path
            d={`M${shell.wallLeft} ${shell.grade}
                H${shell.wallRight}
                L${shell.wallRight + DX} ${shell.grade - DY}
                H${shell.wallLeft + DX} Z`}
            fill="#dfe6ee"
            stroke="#c2ccd8"
            strokeWidth={1}
          />
          {/* Excavated faces of the foundation wall, left and right. */}
          <rect x={shell.wallLeft} y={shell.grade} width={shell.wallThickness} height={shell.basementFloor - shell.grade + 16} fill="#dbe3ec" stroke="#b6c2d0" strokeWidth={1.4} />
          <rect x={shell.wallRight - shell.wallThickness} y={shell.grade} width={shell.wallThickness} height={shell.basementFloor - shell.grade + 16} fill="#dbe3ec" stroke="#b6c2d0" strokeWidth={1.4} />
          <path
            d={`M${shell.wallRight} ${shell.grade}
                L${back(shell.wallRight, shell.grade)}
                V${shell.basementFloor + 16 - DY}
                L${shell.wallRight} ${shell.basementFloor + 16} Z`}
            fill="#c6d0dc"
            stroke="#b6c2d0"
            strokeWidth={1}
            strokeLinejoin="round"
          />
          {/* Footing: the house visibly bears on something. */}
          <rect x={shell.wallLeft - 16} y={shell.basementFloor + 16} width={shell.wallRight - shell.wallLeft + 32} height={11} fill="#c6d0dc" stroke="#aab6c4" strokeWidth={1.2} />
        </g>
      )}

      {/* ── exterior walls ──
          Each wall gets a lit top face and, on the right, the outer side face
          the projection exposes. The near face opens with the camera so a
          turn is a cut, not a view of the back of the removed wall. */}
      <g>
        {!hideLeft && (
          <>
            <path
              d={`M${shell.wallLeft} ${shell.wallTop} L${back(shell.wallLeft, shell.wallTop)} L${back(shell.wallLeft + shell.wallThickness, shell.wallTop)} L${shell.wallLeft + shell.wallThickness} ${shell.wallTop} Z`}
              fill="#eef4fe"
              stroke={INK}
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
            <rect x={shell.wallLeft} y={shell.wallTop} width={shell.wallThickness} height={shell.grade - shell.wallTop} fill={WALL} stroke={INK} strokeWidth={1.8} />
          </>
        )}
        {!hideRight && (
          <>
            <path
              d={`M${shell.wallRight - shell.wallThickness} ${shell.wallTop} L${back(shell.wallRight - shell.wallThickness, shell.wallTop)} L${back(shell.wallRight, shell.wallTop)} L${shell.wallRight} ${shell.wallTop} Z`}
              fill="#eef4fe"
              stroke={INK}
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
            <path
              d={`M${shell.wallRight} ${shell.wallTop} L${back(shell.wallRight, shell.wallTop)} V${shell.grade - DY} L${shell.wallRight} ${shell.grade} Z`}
              fill="#b9cdea"
              stroke={INK}
              strokeWidth={1.4}
              strokeLinejoin="round"
            />
            <clipPath id="hy-right-face-clip">
              <path d={`M${shell.wallRight} ${shell.wallTop} L${back(shell.wallRight, shell.wallTop)} V${shell.grade - DY} L${shell.wallRight} ${shell.grade} Z`} />
            </clipPath>
            <g clipPath="url(#hy-right-face-clip)">
              {Array.from(
                { length: Math.ceil((shell.grade - shell.wallTop) / 11) },
                (_, i) => shell.wallTop + i * 11,
              ).map((sy) => (
                <line
                  key={sy}
                  x1={shell.wallRight}
                  y1={sy}
                  x2={shell.wallRight + DX}
                  y2={sy - DY}
                  stroke="#8fabd4"
                  strokeWidth={0.9}
                  opacity={0.5}
                />
              ))}
            </g>
            <rect x={shell.wallRight - shell.wallThickness} y={shell.wallTop} width={shell.wallThickness} height={shell.grade - shell.wallTop} fill={WALL} stroke={INK} strokeWidth={1.8} />
          </>
        )}
      </g>

      {/*
        Everything inside the shell, clipped to the shell.

        Interior surfaces are offset back and to the right, so unclipped they
        escape the building: the top storey pushed into the gable and every
        storey ran past the right-hand wall. With the envelope enforced here,
        the walls and roof can simply be drawn over the top in the order the
        eye expects, instead of each surface having to dodge the others.
      */}
      <g clipPath="url(#hy-interior-clip)">
      {/* ── room shells: back plane and side returns per floor ── */}
      {(Object.keys(bands) as Array<keyof typeof bands>)
        .filter((floor) => floor !== 'attic' && (floor !== 'basement' || hasBasement))
        .map((floor) => {
          const { top, bottom } = bands[floor];
          return (
            <g key={floor}>
              <rect
                x={interiorLeft + DX}
                y={top - DY}
                width={interiorW}
                height={bottom - top}
                fill="url(#hy-room-depth)"
                stroke={SOFT}
                strokeWidth={1}
              />
              {/* Corner shading on the back plane. */}
              <rect x={interiorLeft + DX} y={top - DY} width={interiorW} height={26} fill="url(#hy-ao-top)" />
              <rect x={interiorLeft + DX} y={top - DY} width={30} height={bottom - top} fill="url(#hy-ao-left)" />
              {/* Inner face of the left wall — the return the viewpoint exposes. */}
              {!hideLeft && (
                <path
                  d={`M${interiorLeft} ${top} L${back(interiorLeft, top)} V${bottom - DY} L${interiorLeft} ${bottom} Z`}
                  fill="#e4edfb"
                  stroke={SOFT}
                  strokeWidth={1}
                />
              )}
            </g>
          );
        })}

      {/* ── floor slabs and partitions, one storey at a time ──
          Every room stands on its own slab rather than sharing one strip across
          the whole storey. The seam at each partition is what makes the rooms
          read as separate volumes you are looking down into.

          Order is the whole trick here, and it is why these two are interleaved
          rather than drawn as two passes over every room.

          Depth runs up and to the right, so a ceiling is *higher* at the back of
          the room than at the opening, and a partition running front-to-back has
          to follow it. Cutting the wall off flat instead left a wedge of daylight
          between the head of the wall and the floor above — the gap you could see
          widening towards the right of each wall.

          So the wall is drawn full height and the slab above is drawn *after* it,
          which trims the overshoot along exactly the receding line the ceiling
          takes. That means, per storey: this floor's slab, then this floor's
          walls standing on it, then the next storey up, whose slab becomes this
          storey's ceiling. Bottom to top, no clipping, no special cases. */}
      {(() => {
        const interior = rooms
          .filter((r) => r.floor !== 'exterior' && r.floor !== 'attic')
          .filter((r) => r.floor !== 'basement' || hasBasement);
        const bandTop = (f: string) =>
          (bands as Record<string, { top: number } | undefined>)[f]?.top ?? 0;
        const storeys = Array.from(new Set(interior.map((r) => r.floor)))
          .sort((a, b) => bandTop(b) - bandTop(a));

        return storeys.map((floor) => {
          const on = interior.filter((r) => r.floor === floor);
          const isBasement = floor === 'basement';
          return (
            <g key={`storey-${floor}`}>
              {on.map((room) => {
                const bottom = room.y + room.h;
                const T = SLAB_T;
                const right = room.x + room.w;
                const rdx = DX;
                const rdy = DY;
                const rback = (x: number, y: number, f = 1) => `${x + rdx * f} ${y - rdy * f}`;
                /*
                 * The last room on a storey butts into the exterior wall, so it
                 * has no exposed right-hand edge. Drawing one anyway pushed a
                 * slab of floor out through the wall it sits inside.
                 */
                const exposedRight = right < Math.max(...on.map((r) => r.x + r.w)) - 1;
                return (
                  <g key={`floor-${room.id}`}>
                    <path
                      d={`M${room.x} ${bottom} H${right} L${rback(right, bottom)} H${room.x + rdx} Z`}
                      fill={isBasement ? 'url(#hy-floor-plane-basement)' : 'url(#hy-floor-plane)'}
                      stroke={LINE}
                      strokeWidth={1}
                      strokeLinejoin="round"
                    />
                    <rect x={room.x} y={bottom} width={room.w} height={T} fill={isBasement ? '#aabbd0' : '#b9d0f2'} stroke={INK} strokeWidth={1.2} />
                    {/*
                      Right-hand return, so the slab has visible mass.

                      The lower back corner is `bottom + T` receded, not
                      `bottom - T`. With the sign flipped the quad's two long
                      edges crossed and every slab ended in a bow tie — the
                      little X that showed up against the right-hand wall.
                    */}
                    {exposedRight && (
                      <path
                        d={`M${right} ${bottom} L${rback(right, bottom)} L${rback(right, bottom + T)} L${right} ${bottom + T} Z`}
                        fill="#9fbde8"
                        stroke={INK}
                        strokeWidth={0.9}
                        strokeLinejoin="round"
                      />
                    )}
                  </g>
                );
              })}

              {on.map((room) => {
                const rightmost = Math.max(...on.map((r) => r.x + r.w));
                if (room.x + room.w >= rightmost - 1) return null;
                const wx = room.x + room.w;
                const T = 7;
                const top = room.y;
                const bottom = room.y + room.h;
                const rdx = DX;
                const rdy = DY;
                const rback = (x: number, y: number, f = 1) => `${x + rdx * f} ${y - rdy * f}`;
                return (
                  <g key={`wall-${room.id}`}>
                    {/* receding face of the partition */}
                    <path
                      d={`M${wx} ${top} L${rback(wx, top)} V${bottom - rdy} L${wx} ${bottom} Z`}
                      fill="#c3d6f2"
                      stroke="#93b4e2"
                      strokeWidth={0.9}
                      strokeLinejoin="round"
                    />
                    {/* Lit top edge, giving the wall a measurable thickness.
                        Only visible on the top storey, where there is no slab
                        above to bury it. */}
                    <path
                      d={`M${wx} ${top} L${rback(wx, top)} L${rback(wx + T, top)} L${wx + T} ${top} Z`}
                      fill="#e8f0fd"
                      stroke="#93b4e2"
                      strokeWidth={0.9}
                      strokeLinejoin="round"
                    />
                    {/* near face, catching the most light */}
                    <rect x={wx} y={top} width={T} height={bottom - top} fill="#d9e6fa" stroke="#93b4e2" strokeWidth={0.9} />
                    {/* Shadow this partition throws onto the back wall of the
                        room to its right, so every room gets its own lit corner. */}
                    <rect
                      x={wx + rdx + T}
                      y={top - rdy}
                      width={22}
                      height={bottom - top}
                      fill="url(#hy-ao-left)"
                    />
                  </g>
                );
              })}
            </g>
          );
        });
      })()}

      {/* ── wiring and water distribution ──
          Beneath the fixtures so furniture occludes the runs, which is what
          keeps them reading as services buried in the structure rather than
          as a diagram printed over the house. */}
      {(showWater || showPower) && (
        <BuildingServices
          rooms={rooms}
          showWater={showWater}
          showPower={showPower}
          waterFlowing={waterFlowing}
        />
      )}

      {/* On the back wall, so the fixtures in front of it occlude it. */}
      <Windows
        rooms={rooms}
        rain={weather && weather.kind !== 'none' && weather.kind !== 'snow' ? weather.intensity : 0}
      />

      {/* ── fixtures ──
          Each room's contents are clipped to that room, so a cabinet's depth
          faces cannot climb the partition into the room next door. */}
      {rooms.map((room) => (
        <g
          key={`fx-${roomKey(room)}`}
          clipPath={room.floor === 'exterior' ? undefined : `url(#hy-room-clip-${roomKey(room)})`}
        >
          <FixtureLayer fixtures={room.fixtures} waterY={waterTop} />
        </g>
      ))}

      {showWater && <UnderSinkDetail rooms={rooms} alertRooms={alertRooms} waterFlowing={waterFlowing} />}

      {/* Drawn inside the interior clip and over the fixtures, so a drip reads
          as falling through the room rather than behind its contents. */}
      {showWater && exposures.length > 0 && (
        <ExposureDrips rooms={rooms} exposures={exposures} flowing={waterFlowing} />
      )}

      {/* Over the fixtures, since the badge is about a fixture and has to be
          legible against it. Inside the interior clip so a badge cannot escape
          into the wall. */}
      {coverageGaps && coverageGaps.size > 0 && (
        <CoverageGapBadges rooms={rooms} gaps={coverageGaps} />
      )}

      </g>

      {/* ── roof ──
          Two cases, because which one you are looking at is the difference
          between a house that resembles its photograph and one that does not.
          A front gable puts the ridge perpendicular to the street and the
          section cuts straight through it. A side gable — the ordinary
          colonial — runs the ridge along the street, so from the front you see
          one long slope nearly edge-on and no gable wall at all. */}
      {shell.ridgeAxis === 'x' ? <SideGableRoof /> : (
      <g>
        {(() => {
          const { roofLeft: L, roofRight: R, roofPeak: P } = shell;
          return (
            <>
              {/* Left slope, catching the light. */}
              <path
                d={`M${L.x} ${L.y} L${P.x} ${P.y} L${back(P.x, P.y)} L${back(L.x, L.y)} Z`}
                fill="url(#hy-roof-grad)"
                stroke={INK}
                strokeWidth={1.8}
                strokeLinejoin="round"
              />
              <path d={`M${L.x} ${L.y} L${P.x} ${P.y} L${back(P.x, P.y)} L${back(L.x, L.y)} Z`} fill="url(#hy-shingle)" />
              {/* Right slope, turned away from the light so the ridge reads. */}
              <path
                d={`M${P.x} ${P.y} L${R.x} ${R.y} L${back(R.x, R.y)} L${back(P.x, P.y)} Z`}
                fill="url(#hy-roof-grad-dark)"
                stroke={INK}
                strokeWidth={1.8}
                strokeLinejoin="round"
              />
              <path d={`M${P.x} ${P.y} L${R.x} ${R.y} L${back(R.x, R.y)} L${back(P.x, P.y)} Z`} fill="url(#hy-shingle)" />
              {/* Ridge. */}
              <path d={`M${P.x} ${P.y} L${back(P.x, P.y)}`} stroke={INK} strokeWidth={2} strokeLinecap="round" />

              {/* Rake boards: the deck's own thickness along the cut edge. This
                  is the edge nearest the viewer, so it carries the silhouette. */}
              <path
                d={`M${L.x} ${L.y} L${P.x} ${P.y} L${P.x} ${P.y + ROOF_T} L${L.x} ${L.y + ROOF_T} Z`}
                fill="#7ea6de"
                stroke={INK}
                strokeWidth={1.6}
                strokeLinejoin="round"
              />
              <path
                d={`M${P.x} ${P.y} L${R.x} ${R.y} L${R.x} ${R.y + ROOF_T} L${P.x} ${P.y + ROOF_T} Z`}
                fill="#6f9ad6"
                stroke={INK}
                strokeWidth={1.6}
                strokeLinejoin="round"
              />

              {/* Gable end wall, sitting under the rake and in front of the
                  slopes. Its apex meets the underside of the rake exactly; a
                  few pixels of daylight there read as a construction error. */}
              {(() => {
                const apex = { x: P.x, y: P.y + ROOF_T };
                const wall = `M${shell.wallLeft} ${shell.wallTop} L${apex.x} ${apex.y} L${shell.wallRight} ${shell.wallTop} Z`;
                const vy = apex.y + 44;
                const vh = 30;
                const vw = 27;
                return (
                  <>
                    <path d={wall} fill="#cfe0fa" stroke={INK} strokeWidth={1.8} strokeLinejoin="round" />
                    {/* Siding courses. Clipped to the gable so they stop at the
                        rake instead of running out into the sky. */}
                    <clipPath id="hy-gable-clip"><path d={wall} /></clipPath>
                    <g clipPath="url(#hy-gable-clip)">
                      {Array.from({ length: 9 }, (_, i) => shell.wallTop - 8 - i * 11).map((sy) => (
                        <line
                          key={sy}
                          x1={shell.wallLeft}
                          y1={sy}
                          x2={shell.wallRight}
                          y2={sy}
                          stroke="#a9c4e8"
                          strokeWidth={0.9}
                          opacity={0.55}
                        />
                      ))}
                      {/* The roof edge casts onto the wall it overhangs. */}
                      <path
                        d={`M${shell.wallLeft} ${shell.wallTop} L${apex.x} ${apex.y} L${shell.wallRight} ${shell.wallTop}`}
                        fill="none"
                        stroke="#6f93c8"
                        strokeWidth={9}
                        opacity={0.28}
                        strokeLinejoin="round"
                      />
                    </g>

                    {/* Louvered gable vent: slats and a frame, so it reads as a
                        vent rather than a stray triangle. */}
                    <g>
                      <path
                        d={`M${P.x - vw} ${vy + vh} L${P.x} ${vy} L${P.x + vw} ${vy + vh} Z`}
                        fill="#b6cfee"
                        stroke={INK}
                        strokeWidth={1.4}
                        strokeLinejoin="round"
                      />
                      {[0.42, 0.62, 0.82].map((t) => (
                        <line
                          key={t}
                          x1={P.x - vw * t + 1.5}
                          y1={vy + vh * t}
                          x2={P.x + vw * t - 1.5}
                          y2={vy + vh * t}
                          stroke="#5d81b8"
                          strokeWidth={1.5}
                          opacity={0.75}
                          strokeLinecap="round"
                        />
                      ))}
                    </g>
                  </>
                );
              })()}

              {/* Ridge cap, laid over the joint where the two slopes meet. */}
              <path
                d={`M${P.x} ${P.y} L${back(P.x, P.y)} l0 4 L${P.x} ${P.y + 4} Z`}
                fill="#5b83c2"
                stroke={INK}
                strokeWidth={1.1}
                strokeLinejoin="round"
              />

              {/* Soffit under each eave overhang, with a fascia board on its
                  outer edge — without one the overhang floats. */}
              <rect x={L.x} y={L.y + ROOF_T} width={shell.wallLeft - L.x} height={7} fill="#a8c4ea" stroke={INK} strokeWidth={1.1} />
              <rect x={shell.wallRight} y={R.y + ROOF_T} width={R.x - shell.wallRight} height={7} fill="#93b3e2" stroke={INK} strokeWidth={1.1} />
              <rect x={L.x - 3} y={L.y} width={3.5} height={ROOF_T + 7} fill="#7ea6de" stroke={INK} strokeWidth={1} />
              <rect x={R.x - 0.5} y={R.y} width={3.5} height={ROOF_T + 7} fill="#6f9ad6" stroke={INK} strokeWidth={1} />
            </>
          );
        })()}

        {/*
          Chimney.

          The shaft is mitred to the roof it stands on rather than stopped at a
          flat line. A stack whose base ignores the pitch reads as a box resting
          against the roof instead of passing through it, and on a slope this
          steep the error is a whole course of brick — one side buried, the
          other floating. The bottom edge here follows the rake exactly, on the
          near face and on the receded one, and a flashing skirt covers the
          joint the way lead does on a real roof.
        */}
        {(() => {
          const { roofPeak: P, roofRight: R } = shell;
          /** Pitch of the slope the stack lands on. */
          const pitch = (R.y - P.y) / (R.x - P.x);
          const roofY = (x: number) => P.y + (x - P.x) * pitch;

          const left = 838;
          const right = 876;
          const topY = 100;
          /** Square-ish in plan, so it takes a fraction of the room depth. */
          const C = 0.4;
          const dx = DX * C;
          const dy = DY * C;

          const baseL = roofY(left);
          const baseR = roofY(right);

          return (
            <g>
              {/* Right return, from the ridge-side top corner down to the roof. */}
              <path
                d={`M${right} ${topY} L${right + dx} ${topY - dy} L${right + dx} ${baseR - dy} L${right} ${baseR} Z`}
                fill="#8d9bad"
                stroke={INK}
                strokeWidth={1.3}
                strokeLinejoin="round"
              />
              {/* Top of the shaft. */}
              <path
                d={`M${left} ${topY} L${left + dx} ${topY - dy} L${right + dx} ${topY - dy} L${right} ${topY} Z`}
                fill="#dbe4ef"
                stroke={INK}
                strokeWidth={1.2}
                strokeLinejoin="round"
              />
              {/* Near face: square at the top, cut to the pitch at the bottom. */}
              <path
                d={`M${left} ${topY} L${right} ${topY} L${right} ${baseR} L${left} ${baseL} Z`}
                fill="#c3cedb"
                stroke={INK}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
              {/* Brick courses, following the shaft rather than the slope. */}
              {[0.26, 0.46, 0.66].map((t) => {
                const y = topY + (baseL - topY) * t;
                return (
                  <line
                    key={t}
                    x1={left + 1}
                    y1={y}
                    x2={right - 1}
                    y2={y + (baseR - baseL) * t}
                    stroke="#9aa8b9"
                    strokeWidth={0.9}
                    opacity={0.6}
                  />
                );
              })}
              {/* Flashing where the shaft meets the deck. */}
              <path
                d={`M${left - 5} ${baseL + 4} L${right + 5} ${baseR + 4} L${right + 5} ${baseR - 3} L${left - 5} ${baseL - 3} Z`}
                fill="#aab7c6"
                stroke={INK}
                strokeWidth={1.1}
                strokeLinejoin="round"
              />
              {/* Cap, oversailing the shaft on every side, front face last. */}
              <path
                d={`M${left - 6} ${topY - 9} L${left - 6 + dx} ${topY - 9 - dy} L${right + 6 + dx} ${topY - 9 - dy} L${right + 6} ${topY - 9} Z`}
                fill="#e6ecf3"
                stroke={INK}
                strokeWidth={1.1}
                strokeLinejoin="round"
              />
              <path
                d={`M${right + 6} ${topY - 9} L${right + 6 + dx} ${topY - 9 - dy} L${right + 6 + dx} ${topY - dy} L${right + 6} ${topY} Z`}
                fill="#7f8d9e"
                stroke={INK}
                strokeWidth={1}
                strokeLinejoin="round"
              />
              <rect x={left - 6} y={topY - 9} width={right - left + 12} height={9} fill="#98a5b5" stroke={INK} strokeWidth={1.2} />
              {/* Flue opening, so the cap is not a solid lid. */}
              <path
                d={`M${left + 7} ${topY - 9} L${left + 7 + dx * 0.55} ${topY - 9 - dy * 0.55} L${right - 7 + dx * 0.55} ${topY - 9 - dy * 0.55} L${right - 7} ${topY - 9} Z`}
                fill="#4b5768"
                opacity={0.55}
              />
            </g>
          );
        })()}
      </g>
      )}
      <PentRoof />

      {/* ── water service: street → foundation → shutoff → riser ── */}
      {hasBasement && <WaterService supplyY={supplyTrunkY} downstreamFlowing={waterFlowing} />}

      {/* ── flood level indicator ──
          A waterline, not a water volume.
          Filling the section with translucent blue buried the rooms, the
          fixtures and the device pins under one flat slab — it dominated a view
          whose actual job is showing equipment, and it implied a solid body of
          water we cannot claim to have modelled at that fidelity. A marked level
          with a light wash communicates the same threshold and leaves the house
          readable underneath. */}
      {waterTop != null && stage && (
        <g pointerEvents="none">
          {(() => {
            const aboveGrade = stage.levelFt > BASEMENT_DEPTH_BELOW_GRADE_FT;
            const left = aboveGrade ? shell.wallLeft - 150 : shell.wallLeft;
            const right = aboveGrade ? shell.wallRight + 150 : shell.wallRight;
            return (
              <>
                {/* Very light wash purely to bias the eye downward to the
                    affected zone; deliberately faint enough to read through. */}
                <rect
                  x={left}
                  y={waterTop}
                  width={right - left}
                  height={shell.basementFloor - waterTop}
                  fill="#3b82f6"
                  opacity={0.10}
                />
                {/* The level itself: a dashed line travelling slowly sideways,
                    which suggests water without asserting a flow direction the
                    archetypal footprint cannot support. */}
                <path
                  d={`M${left} ${waterTop} H${right}`}
                  stroke="#1d4ed8"
                  strokeWidth={2}
                  strokeDasharray="14 9"
                  opacity={0.9}
                >
                  <animate attributeName="stroke-dashoffset" values="0;-46" dur="3.6s" repeatCount="indefinite" />
                </path>
                {/* A faint echo just below reads as surface thickness. */}
                <path
                  d={`M${left} ${waterTop + 3.5} H${right}`}
                  stroke="#60a5fa"
                  strokeWidth={1}
                  strokeDasharray="14 9"
                  opacity={0.5}
                >
                  <animate attributeName="stroke-dashoffset" values="0;-46" dur="3.6s" repeatCount="indefinite" />
                </path>
                {/* Anchored to the wall, not to the water's edge: once water is
                    above grade the edge is out in the yard, colliding with the
                    utility labels. */}
                <text
                  x={shell.wallRight - 12}
                  y={waterTop - 10}
                  textAnchor="end"
                  fontSize={12.5}
                  fontWeight={800}
                  fill="#1d4ed8"
                  stroke="#f8fafc"
                  strokeWidth={3.5}
                  paintOrder="stroke"
                >
                  {stage.headline}
                </text>
              </>
            );
          })()}
        </g>
      )}

      {/* Grade only gets called out during a flood, where "how far below grade"
          is the whole point. The soil line itself is already drawn above; this
          just names it. */}
      {stage && (
        <text
          x={shell.wallLeft - 176}
          y={shell.grade - 8}
          fontSize={11.5}
          fontWeight={700}
          fill="#64748b"
          stroke="#f8fafc"
          strokeWidth={3}
          paintOrder="stroke"
          pointerEvents="none"
        >
          Grade
        </text>
      )}

      {/* ── electric meter ── */}
      <g>
        {/* Service conduit down the outside of the wall and in below grade.
            Drawn here, after the wall, so it visibly crosses it and meets the
            interior run to the panel at the same height. */}
        {showPower && hasBasement && (
          <g pointerEvents="none">
            <path
              d={`M${meter.x + 13} ${meter.y + 19} V${SERVICE_ENTRY_Y} H${interiorRight - 4}`}
              fill="none"
              stroke="#fff"
              strokeWidth={4.6}
              opacity={0.65}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={`M${meter.x + 13} ${meter.y + 19} V${SERVICE_ENTRY_Y} H${interiorRight - 4}`}
              fill="none"
              stroke={WIRE}
              strokeWidth={2}
              opacity={0.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={`M${meter.x + 13} ${meter.y + 19} V${SERVICE_ENTRY_Y} H${interiorRight - 4}`}
              fill="none"
              stroke={WIRE}
              strokeWidth={2.8}
              strokeDasharray="5 13"
              strokeLinecap="round"
            >
              <animate attributeName="stroke-dashoffset" values="0;-18" dur="1.1s" repeatCount="indefinite" />
            </path>
          </g>
        )}
        <rect x={meter.x} y={meter.y - 20} width={26} height={38} rx={4} fill="#e2e8f0" stroke={INK} strokeWidth={1.6} />
        <circle cx={meter.x + 13} cy={meter.y - 5} r={8} fill="#f8fafc" stroke={METAL_DARK} strokeWidth={1.2} />
        <path d={`M${meter.x + 13} ${meter.y - 5} l4 -5`} stroke={INK} strokeWidth={1.6} strokeLinecap="round" />
        <text x={meter.x + 13} y={meter.y + 32} textAnchor="middle" fontSize={12} fontWeight={700} fill="#64748b">
          Meter
        </text>
      </g>

      {/* ── room hit targets, tints and labels (drawn last so they sit on top) ── */}
      {rooms.map((room) => {
        const cut = roomCutOpacity(room, yaw, rooms);
        // An exterior zone with nothing in it is just an empty labelled box on
        // the lawn, so it stays hidden until it is a drop target or occupied.
        if (
          room.floor === 'exterior'
          && !occupiedRooms?.has(room.id)
          && !dragging
          && selectedRoomId !== room.id
        ) {
          return null;
        }
        const tint = roomTints[room.id];
        const alerting = alertRooms?.has(room.id);
        /* The source room is already shown as alerting; hatching it as well
           would claim twice about the same room and muddy both signals. */
        const exposure = exposures.find((e) => e.cellId === room.id && e.tier !== 'source');
        const selected = selectedRoomId === room.id;
        const hovered = hoveredRoomId === room.id;
        const isDropTarget = dropTargetRoomId === room.id;
        const exterior = room.floor === 'exterior';

        return (
          <g
            key={`room-${roomKey(room)}`}
            style={{ cursor: 'pointer', opacity: cut }}
            pointerEvents={cut < 0.58 ? 'none' : undefined}
            onClick={(e) => {
              e.stopPropagation();
              onRoomClick?.(room.id);
            }}
            onMouseEnter={() => onRoomHover?.(room.id)}
            onMouseLeave={() => onRoomHover?.(null)}
          >
            {/*
              Tinted air, not a coloured panel.

              Two things were making a tinted room look flat. It was a plain
              rectangle, so it covered only the front opening and stopped dead
              at the edges the rest of the drawing spends its effort receding —
              a green room ended up looking like a green card held in front of
              the furniture. And it was one flat value, so it erased the depth
              cue underneath it. Filling the room's own volume and grading the
              colour from the shaded ceiling down to the lit floor puts it back
              in the room; multiplying keeps every shadow already there and only
              shifts its hue.
            */}
            {tint && (exterior ? (
              <rect x={room.x} y={room.y} width={room.w} height={room.h} fill={tint} />
            ) : (
              <g clipPath="url(#hy-interior-clip)" pointerEvents="none">
                <linearGradient
                  id={`hy-tint-${roomKey(room)}`}
                  gradientUnits="userSpaceOnUse"
                  x1={room.x}
                  y1={room.y - DY}
                  x2={room.x}
                  y2={room.y + room.h}
                >
                  {/* The comfort palette is already faint, so the fall-off has
                      to be gentle — grade it too hard and the room stops
                      reading as tinted at all near the floor. */}
                  <stop offset="0%" stopColor={tint} stopOpacity={1} />
                  <stop offset="45%" stopColor={tint} stopOpacity={0.84} />
                  <stop offset="100%" stopColor={tint} stopOpacity={0.6} />
                </linearGradient>
                <path
                  d={roomVolumePath(room)}
                  fill={`url(#hy-tint-${roomKey(room)})`}
                  style={{ mixBlendMode: 'multiply' }}
                />
              </g>
            ))}
            {(hovered || selected || isDropTarget) && (
              <rect
                x={room.x + 2}
                y={room.y + 2}
                width={room.w - 4}
                height={room.h - 4}
                rx={4}
                fill={isDropTarget ? 'rgba(37,99,235,0.12)' : 'rgba(37,99,235,0.06)'}
                stroke={isDropTarget ? '#2563eb' : selected ? '#1d4ed8' : '#60a5fa'}
                strokeWidth={isDropTarget ? 3 : selected ? 2.4 : 1.6}
                strokeDasharray={isDropTarget ? '8 5' : undefined}
              />
            )}
            {!exterior && (room.provenance === 'inferred' || room.provenance === 'derived') && (
              <rect
                x={room.x + 3}
                y={room.y + 3}
                width={Math.max(0, room.w - 6)}
                height={Math.max(0, room.h - 6)}
                rx={3}
                fill="none"
                stroke="#94a3b8"
                strokeWidth={1.1}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}
            {/*
              A firing room fills, rather than being outlined.

              An outline says "this rectangle is selected"; it reads as chrome,
              and it is the same language the hover and drop-target states
              already use. Water on the floor is a condition of the space, so
              the space is what changes colour — and it has to survive being
              glanced at, which a 3 px border on a pale drawing does not. The
              pulse is on the fill for the same reason.
            */}
            {/*
              Possible exposure: water arriving, not a shaded region.

              This started as a diagonal hatch over the whole room volume, which
              was wrong twice over. It read as striped wallpaper filling the
              room rather than as water, and it collided with the drawing's own
              language — the shell, roof and partitions are already hatched with
              45° hairlines, so an amber hatch was more of the same texture in a
              different colour instead of a new kind of mark.

              What it draws now is the *route*: a stain across the ceiling where
              water comes through the floor above, a wash fading down from it,
              and a pool on the floor where water collects. A soft gradient is a
              completely different visual class from the drawing's hairlines, so
              it separates cleanly at any zoom.

              The tier picks the treatment, which the uniform hatch could never
              express. Water from above enters at the ceiling; water spreading
              sideways across a floor does not, so a `lateral` room gets the pool
              only. Drawing a ceiling stain on a room the water reaches by
              running across its own floor would be a straightforward lie about
              which way it came.

              Likelihood drives the weight hard, and it has to. An upstairs leak
              legitimately puts five or six rooms in scope once it has been
              running an hour, and drawing all of them at the same strength is
              the same as drawing none of them — it tells the reader to check the
              whole house, which is what they were going to do anyway. Graded,
              the drawing says where to start. No number is printed: the ranking
              is real, the precision is not.
            */}
            {exposure && !alerting && (() => {
              const fromAbove = exposure.tier === 'direct' || exposure.tier === 'stack';
              const strength = exposure.likelihood;
              /* Where the water crosses between the two spaces. Water comes
                 through a floor where they overlap, not across the whole room,
                 so this is what the stain gets centred on. */
              const sourceRoom = exposure.sourceCellId
                ? rooms.find((r) => r.id === exposure.sourceCellId)
                : undefined;
              const arrivalX = sourceRoom
                ? spanOverlapCenter(sourceRoom, room)
                : room.x + room.w / 2;
              return (
                /* Clipped to this room rather than to the interior. A pool wide
                   enough to fill a narrow room would otherwise spill through the
                   partition and put an amber patch in a room that is not
                   flagged, which is a false claim about a specific space. */
                <g
                  pointerEvents="none"
                  clipPath={exterior ? undefined : `url(#hy-room-clip-${roomKey(room)})`}
                >
                  {fromAbove && (
                    <>
                      <ExposureFromAbove
                        id={room.id}
                        volumePath={roomVolumePath(room)}
                        left={room.x}
                        top={room.y - DY}
                        bottom={room.y + room.h}
                        strength={strength}
                      />
                      <ExposureStain
                        cx={arrivalX}
                        cy={room.y - DY * 0.5}
                        strength={strength}
                        id={`ceil-${room.id}`}
                        hostW={room.w}
                      />
                    </>
                  )}
                  {/* Water ends up on the floor whichever way it got in. */}
                  <ExposureStain
                    cx={arrivalX}
                    cy={room.y + room.h - DY * 0.5}
                    strength={strength}
                    id={`floor-${room.id}`}
                    spread={fromAbove ? 1 : 1.35}
                    hostW={room.w}
                  />
                </g>
              );
            })()}
            {/*
              The label sits outside the graded group on purpose. Its job is to
              be read, and it cannot inherit a wash opacity tuned for a texture
              behind furniture. Only the rooms worth walking into first get one:
              labelling every flag turns the section into a wall of text and
              flattens the ranking the hatch just established.
            */}
            {exposure && !alerting && exposure.likelihood >= EXPOSURE_LABEL_MIN && (
              <text
                pointerEvents="none"
                clipPath={exterior ? undefined : 'url(#hy-interior-clip)'}
                x={room.x + room.w - 8}
                y={room.y + room.h - 9}
                textAnchor="end"
                fontSize={9.5}
                fontWeight={800}
                fill={EXPOSURE_INK}
                stroke="#f8fafc"
                strokeWidth={2.6}
                paintOrder="stroke"
                style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}
              >
                Inspect
              </text>
            )}
            {alerting && (
              <g pointerEvents="none" clipPath={exterior ? undefined : 'url(#hy-interior-clip)'}>
                <linearGradient
                  id={`hy-alert-${roomKey(room)}`}
                  gradientUnits="userSpaceOnUse"
                  x1={room.x}
                  y1={room.y - DY}
                  x2={room.x}
                  y2={room.y + room.h}
                >
                  <stop offset="0%" stopColor="#e11d48" stopOpacity={0.5} />
                  <stop offset="58%" stopColor="#f43f5e" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="#fb7185" stopOpacity={0.2} />
                </linearGradient>
                <path d={roomVolumePath(room)} fill={`url(#hy-alert-${roomKey(room)})`} style={{ mixBlendMode: 'multiply' }}>
                  <animate attributeName="opacity" values="1;0.5;1" dur="1.6s" repeatCount="indefinite" />
                </path>
                <path
                  d={roomVolumePath(room)}
                  fill="none"
                  stroke="#e11d48"
                  strokeWidth={2.4}
                  strokeLinejoin="round"
                >
                  <animate attributeName="opacity" values="0.95;0.35;0.95" dur="1.6s" repeatCount="indefinite" />
                </path>
              </g>
            )}
            <text
              x={room.x + 9}
              y={room.y + 17}
              fontSize={12.5}
              fontWeight={700}
              fill={selected ? '#1d4ed8' : '#64748b'}
              opacity={dragging && !isDropTarget ? 0.45 : 1}
              style={{ pointerEvents: 'none', textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              {exterior ? room.label : room.short}
            </text>
          </g>
        );
      })}

      {/* ── weather, on top of everything ──
          Rain belongs between the viewer and the house, so it is drawn last.
          The gutter stays whatever the sky is doing; only its contents come
          and go. */}
      <Gutters flow={weather && weather.kind !== 'none' && weather.kind !== 'snow' ? weather.intensity : 0} />
      {weather && <WeatherLayer weather={weather} />}
    </g>
    </HouseGeomContext.Provider>
  );
}
