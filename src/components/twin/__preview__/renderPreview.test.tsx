/**
 * Development-time visual harness: renders the full twin canvas to an SVG file
 * on disk so the drawing can be eyeballed without clicking through the
 * dashboard. Not an assertion test — it just has to not throw.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, it } from 'vitest';
import DeviceTopologyMap from '../../DeviceTopologyMap';
import HouseCutaway, { type LiveWeather } from '../HouseCutaway';
import DeviceHero, { type HeroKind } from '../DeviceHero';
import ComponentCondition from '../ComponentCondition';
import { componentRegion } from '../componentWear';
import { cameraForDevice, cameraForHealthComponent, cameraViewBox } from '../twinCamera';
import { anchorsFor, visibleRooms, VB_H, VB_W } from '../houseModel';
import { propagateHouseLeak, propagateLeak, type LeakExposure } from '../leakPropagation';
import { computeCoverage } from '../coverageModel';
import BuildingCutaway, { buildingCutawayScene } from '../BuildingCutaway';
import BuildingPlateStack, { plateStackScene } from '../BuildingPlateStack';
import FloorPlate, { floorPlateScene } from '../FloorPlate';
import RiserView, { riserScene } from '../RiserView';
import {
  DEFAULT_BUILDING_SPEC,
  buildBuilding,
  buildingCells,
  type BuildingDef,
  type BuildingSide,
} from '../buildingModel';
import HealthPins from '../HealthPins';
import { buildHealthPins } from '../healthAnchors';
import SiteView, { siteViewScene } from '../SiteView';
import { archetypeSiteModel, type SiteModel } from '../siteModel';
import { houseCameraFor, projectHouse } from '../houseProjection';
import { HOUSE_FRONT, HOUSE_ORBIT, SECTION_ORBIT, SITE_ORBIT, orbitCamera, type Orbit } from '../twinCamera';
import {
  PROPERTY_HEALTH_CATEGORY_META,
  createEmptyHealthAsset,
  type PropertyHealthCategory,
} from '../../../types/propertyHealth';
import type { ShellyDevice } from '../../../hooks/useShellyFirestore';

const OUT = 'tmp-preview';

function device(over: Partial<ShellyDevice> & { id: string; name: string; type: string }): ShellyDevice {
  return {
    deviceId: over.id,
    status: 'online',
    lastSeen: new Date(),
    registeredAt: new Date(),
    ...over,
  } as ShellyDevice;
}

const devices: ShellyDevice[] = [
  device({ id: 'gw1', name: 'Living Room Gateway', type: 'ble_gateway' }),
  device({ id: 'ht1', name: 'Upstairs H&T', type: 'temperature_humidity', temperatureF: 74, humidity: 54, connectionType: 'bluetooth' }),
  device({ id: 'ht2', name: 'Primary Bedroom H&T', type: 'temperature_humidity', temperatureF: 71, humidity: 48, connectionType: 'bluetooth' }),
  device({ id: 'ht3', name: 'Basement H&T', type: 'temperature_humidity', temperatureF: 63, humidity: 61, connectionType: 'bluetooth' }),
  device({ id: 'fl1', name: 'Water Heater Flood Sensor', type: 'flood', status: 'offline' }),
  device({ id: 'fl2', name: 'Kitchen Sink Leak', type: 'flood' }),
  device({ id: 'fl3', name: 'Laundry Leak', type: 'flood' }),
  device({ id: 'rl1', name: 'Water Shutoff Relay', type: 'relay_controller', valveState: 'open', relayOutputOn: false }),
];

/**
 * A firing kitchen leak sensor. The alert state changes the drawing more than
 * anything else does — the room fills and the trap starts dripping — so it
 * needs a variant of its own rather than only ever being seen in production.
 */
const kitchenLeak = [{
  id: 'a1',
  deviceId: 'fl2',
  type: 'flood',
  severity: 'critical',
  message: 'Water detected under the kitchen sink',
  timestamp: new Date(),
  resolved: false,
}] as unknown as Parameters<typeof DeviceTopologyMap>[0]['alerts'];

const HOUSE = { id: 'p1', address: '11822 Prestwick Road, Potomac, MD 20854', beds: 4, baths: 3 };
/** No basement, no attic, and the rooms grow to fill the shell. */
const CONDO = { id: 'p1', address: '1400 S Joyce St #1503, Arlington, VA 22202', beds: 2, baths: 2 };

function renderCanvas(
  floodDepthAtGradeFt: number | null,
  alerts: Parameters<typeof DeviceTopologyMap>[0]['alerts'] = [],
  property = HOUSE,
): string {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <DeviceTopologyMap
        devices={devices}
        alerts={alerts}
        properties={[property]}
        selectedPropertyId="p1"
        onValveCommand={() => {}}
        onAssignRoom={() => {}}
        floodDepthAtGradeFt={floodDepthAtGradeFt}
        floodScenarioLabel={floodDepthAtGradeFt ? '6" storm, ~4% chance per year' : null}
      />
    </MemoryRouter>,
  );

  // Skip the lucide icons in the header and grab the canvas itself.
  const start = html.lastIndexOf('<svg', html.indexOf('aria-label="Live network topology'));
  const end = html.indexOf('</svg>', start) + '</svg>'.length;
  const inner = html.slice(start, end);
  const openEnd = inner.indexOf('>') + 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="920" viewBox="0 0 1320 920">`
    + '<rect width="1320" height="920" fill="#f6faff"/>'
    + inner.slice(openEnd);
}

/**
 * The cutaway on its own, with props set directly.
 *
 * The full canvas cannot reach the weather or shutoff states from here: both
 * are derived from network responses that never arrive under SSR, so live rain
 * and a closed valve are permanently unreachable through `renderCanvas`. Those
 * are exactly the states worth looking at, so they get a harness that sets them
 * without asking the component where they came from.
 */
function renderCutaway(over: {
  weather?: LiveWeather;
  waterFlowing?: boolean;
  showPower?: boolean;
  alertRooms?: Set<string>;
  exposures?: LeakExposure[];
  coverageGaps?: Set<string>;
  property?: typeof HOUSE;
}): string {
  const body = renderToStaticMarkup(
    <HouseCutaway
      rooms={visibleRooms(over.property ?? HOUSE)}
      alertRooms={over.alertRooms}
      exposures={over.exposures}
      coverageGaps={over.coverageGaps}
      occupiedRooms={new Set(['kitchen', 'basement_open', 'laundry'])}
      showWater
      showPower={over.showPower ?? false}
      waterFlowing={over.waterFlowing ?? true}
      weather={over.weather ?? null}
    />,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VB_W}" height="${VB_H}" viewBox="0 0 ${VB_W} ${VB_H}">`
    + `<rect width="${VB_W}" height="${VB_H}" fill="#f6faff"/>${body}</svg>`;
}

/**
 * The multifamily side elevation, on its own.
 *
 * Sized to the building's own extent rather than the house canvas — that is the
 * whole reason the camera grew a scene, and a preview that forced it back into
 * 1320x920 would be checking a framing nobody sees.
 */
function renderBuilding(
  building: BuildingDef,
  side: BuildingSide,
  over: {
    alertUnits?: Set<string>;
    exposures?: LeakExposure[];
    coverageGaps?: Set<string>;
    selectedStackId?: string;
    mode?: 'section' | 'exploded';
  },
): string {
  const body = renderToStaticMarkup(
    <BuildingCutaway
      building={building}
      side={side}
      mode={over.mode}
      alertUnits={over.alertUnits}
      exposures={over.exposures}
      coverageGaps={over.coverageGaps}
      selectedStackId={over.selectedStackId}
      occupiedUnits={new Set(['u-A-0-0', 'u-A-2-2'])}
      onFlip={() => {}}
      onStackClick={() => {}}
    />,
  );
  const { w, h } = buildingCutawayScene(building, over.mode);
  // The component is a <g>, like HouseCutaway, so the harness supplies the <svg>
  // exactly as DeviceTopologyMap does.
  return withCanvas(
    `<svg viewBox="0 0 ${w} ${h}">${body}</svg>`,
    w,
    h,
  );
}

/**
 * The exploded plate stack, which is the drawing the elevation cannot be.
 *
 * Sized from its own layout: the whole reason this view exists is that it grows
 * in a different direction than the facade does, so forcing it into the
 * elevation's scene would be checking a framing that does not exist.
 */
function renderStack(
  building: BuildingDef,
  over: {
    alertUnits?: Set<string>;
    exposures?: LeakExposure[];
    coverageGaps?: Set<string>;
    selectedStackId?: string;
    valveClosed?: boolean;
    detail?: 'full' | 'reduced';
  } = {},
): string {
  const body = renderToStaticMarkup(
    <BuildingPlateStack
      building={building}
      alertUnits={over.alertUnits}
      exposures={over.exposures}
      coverageGaps={over.coverageGaps}
      selectedStackId={over.selectedStackId}
      valveClosed={over.valveClosed}
      detail={over.detail}
      occupiedUnits={new Set(['u-A-0-0', 'u-A-2-2', 'u-B-1-1'])}
      onUnitClick={() => {}}
      onStackClick={() => {}}
    />,
  );
  const { w, h } = plateStackScene(building);
  return withCanvas(`<svg viewBox="0 0 ${w} ${h}">${body}</svg>`, w, h);
}

/**
 * One riser, which is the operational view: a call list with a valve on it.
 *
 * Rendered because this is where the house's fixture vocabulary has to survive
 * being reused at a different scale in a different drawing. Assertions can prove
 * the right units are on the riser; only looking says whether a tub in an
 * apartment reads like a tub in a house.
 */
function renderRiser(
  building: BuildingDef,
  stackId: string,
  over: {
    alertUnits?: Set<string>;
    exposures?: LeakExposure[];
    coverageGaps?: Set<string>;
    valveState?: 'open' | 'closed';
  } = {},
): string {
  const stack = building.stacks.find((s) => s.id === stackId);
  if (!stack) throw new Error(`no stack ${stackId}`);
  const body = renderToStaticMarkup(
    <RiserView
      building={building}
      stack={stack}
      alertUnits={over.alertUnits}
      exposures={over.exposures}
      coverageGaps={over.coverageGaps}
      valveState={over.valveState}
      onUnitClick={() => {}}
      onValveToggle={() => {}}
    />,
  );
  const { w, h } = riserScene(building, stack);
  return withCanvas(`<svg viewBox="0 0 ${w} ${h}">${body}</svg>`, w, h);
}

/** The floor plan, which is a different drawing rather than a variant. */
function renderPlate(
  building: BuildingDef,
  level: number,
  over: {
    exposures?: LeakExposure[];
    coverageGaps?: Set<string>;
    highlightSide?: BuildingSide;
  },
): string {
  const body = renderToStaticMarkup(
    <FloorPlate
      building={building}
      level={level}
      exposures={over.exposures}
      coverageGaps={over.coverageGaps}
      highlightSide={over.highlightSide}
      occupiedUnits={new Set(['u-A-1-0'])}
      onUnitClick={() => {}}
    />,
  );
  const { w, h } = floorPlateScene(building);
  return withCanvas(body, w, h);
}

/**
 * Give a viewBox-only SVG a size and a background so it rasterizes standalone.
 *
 * The components size themselves with `width:100%`, which is right in the page and
 * useless as a file: with no intrinsic width the rasterizer has nothing to work
 * from and the drawing comes out either empty or clipped.
 */
function withCanvas(body: string, w: number, h: number): string {
  const openEnd = body.indexOf('>') + 1;
  return `${body.slice(0, openEnd)}<rect width="${w}" height="${h}" fill="#f6faff"/>${body.slice(openEnd)}`
    .replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" `);
}

/**
 * The lot, from an angle.
 *
 * Shot at several orbits because the entire claim being made is that one model
 * survives being looked at from more than one place: head-on it has to still be
 * the elevation the section implies, and turned it has to read as a solid with a
 * near and a far side rather than as a flat shape that sheared. Nothing but
 * looking will say whether the shading carries that.
 */
function renderSite(
  model: SiteModel,
  orbit: Orbit,
  over: { showStoreys?: boolean; selectedStructureId?: string } = {},
): string {
  const { w, h } = siteViewScene();
  const body = renderToStaticMarkup(
    <SiteView
      model={model}
      orbit={orbit}
      width={w}
      height={h}
      showStoreys={over.showStoreys}
      selectedStructureId={over.selectedStructureId ?? null}
    />,
  );
  return withCanvas(`<svg viewBox="0 0 ${w} ${h}">${body}</svg>`, w, h);
}

/*
 * Shot through the same camera the app uses, not a preview-only one. A harness
 * that frames the house differently from production can only tell you the
 * drawing is fine when it is not.
 */
function renderSectionOrbit(model: SiteModel, yaw: number): string {
  const projected = projectHouse(model, houseCameraFor(model, yaw));
  const body = renderToStaticMarkup(
    <HouseCutaway
      rooms={projected.rooms}
      shell={projected.shell}
      bands={projected.bands}
      camera={projected.camera}
      occupiedRooms={new Set(['kitchen', 'basement_open', 'laundry'])}
      showWater
    />,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VB_W}" height="${VB_H}" viewBox="0 0 ${VB_W} ${VB_H}">`
    + `<rect width="${VB_W}" height="${VB_H}" fill="#f6faff"/>${body}</svg>`;
}

/**
 * The archetype programme standing on a different outline.
 *
 * Stands in for a measured property without needing a live ATTOM record: the
 * room list and storey count come from the archetype, the shape comes from the
 * footprint, which is exactly the split the site model makes.
 */
function withFootprint(property: typeof HOUSE, footprint: { x: number; y: number }[]): SiteModel {
  const base = archetypeSiteModel(property);
  const primary = base.structures[0];
  return {
    ...base,
    structures: [{
      ...primary,
      footprint,
      provenance: 'measured',
      levels: primary.levels.map((level) => ({ ...level, source: 'rules' as const })),
    }],
  };
}

/**
 * The twin, turned.
 *
 * There is no separate renderer for this any more: turning the house is the
 * same drawing at a different yaw, which is the only way the detail survives
 * the gesture.
 */
function renderTurned(model: SiteModel, yaw: number): string {
  return renderSectionOrbit(model, yaw);
}

/**
 * A lot with more than one building on it, which is the case the section cannot
 * draw at all and the reason this view exists.
 */
function siteWithOutbuildings(): SiteModel {
  const base = archetypeSiteModel(HOUSE);
  const rect = (x0: number, y0: number, x1: number, y1: number) =>
    [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

  return {
    ...base,
    parcel: rect(-19, -16, 19, 26),
    streetEdge: [{ x: -19, y: -16 }, { x: 19, y: -16 }],
    structures: [
      ...base.structures,
      {
        id: 'garage',
        role: 'garage',
        footprint: rect(-11.5, 7, -4.5, 13.5),
        wallThickness: 0.2,
        levels: [{ id: 'main', label: 'Garage', z: 0, height: 2.7, rooms: [], source: 'rules' }],
        roof: {
          form: 'gable', ridgeAxis: 'x', eaveZ: 2.7, ridgeZ: 4.1, overhang: 0.35,
          provenance: 'archetype',
        },
        provenance: 'inferred',
        confidence: 'low',
      },
      {
        id: 'shed',
        role: 'shed',
        footprint: rect(7, 15, 10.4, 18),
        wallThickness: 0.12,
        levels: [{ id: 'main', label: 'Shed', z: 0, height: 2.1, rooms: [], source: 'rules' }],
        roof: {
          form: 'flat', ridgeAxis: 'x', eaveZ: 2.1, ridgeZ: 2.1, overhang: 0.1,
          provenance: 'archetype',
        },
        provenance: 'inferred',
        confidence: 'low',
      },
    ],
  };
}

/**
 * The device close-up, framed the way the camera frames it.
 *
 * Under SSR the turntable holds its resting angle, so this checks the artwork and
 * the shading rather than the motion — the rotation's geometry is covered by
 * assertions in `deviceHero.test.ts`, which is the part worth being strict about.
 */
function renderHero(kind: HeroKind, over: { alarming?: boolean } = {}): string {
  const at = { x: 660, y: 470 };
  const camera = cameraForDevice(at);
  const body = renderToStaticMarkup(
    <DeviceHero
      x={at.x}
      y={at.y}
      kind={kind}
      device={device({ id: 'x', name: `${kind} sensor`, type: kind })}
      tone="#0ea5e9"
      alarming={over.alarming ?? false}
    />,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="660" height="${Math.round(660 / (VB_W / VB_H))}" viewBox="${cameraViewBox(camera)}">`
    + `<rect x="${camera.x}" y="${camera.y}" width="${camera.w}" height="${camera.h}" fill="#f6faff"/>${body}</svg>`;
}

/**
 * The close-up as it is actually seen: standing in its room, with the camera
 * where the zoom leaves it. This is the variant that matters — the device on a
 * blank field says nothing about whether it is the right size for the space it
 * is supposed to be sitting in.
 */
function renderFocused(roomId: string, kind: HeroKind, alarming = false): string {
  const rooms = visibleRooms(HOUSE);
  const room = rooms.find((r) => r.id === roomId)!;
  const at = anchorsFor(room, 1)[0];
  const camera = cameraForDevice(at, room);
  const body = renderToStaticMarkup(
    <>
      {/* Stands in for the app's CSS blur, which a static rasteriser will not
          apply. Same idea, so the composition reads the same. */}
      <g filter="url(#dof)">
        <HouseCutaway rooms={rooms} occupiedRooms={new Set([roomId])} showWater />
      </g>
      <DeviceHero
        x={at.x}
        y={at.y}
        kind={kind}
        device={device({ id: 'x', name: 'Sensor', type: kind })}
        tone={alarming ? '#e11d48' : '#0ea5e9'}
        alarming={alarming}
      />
    </>,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${Math.round(900 / (VB_W / VB_H))}" viewBox="${cameraViewBox(camera)}">`
    + `<defs><filter id="dof" x="-10%" y="-10%" width="120%" height="120%">`
    + `<feGaussianBlur stdDeviation="${(camera.w / 900) * 3.5}"/></filter></defs>`
    + `<rect x="${camera.x}" y="${camera.y}" width="${camera.w}" height="${camera.h}" fill="#f6faff"/>${body}</svg>`;
}

/**
 * The health overlay standing in the house it describes.
 *
 * Pin coordinates are the one part of this that cannot be checked by
 * assertion: a test can say the water-heater pin is below grade and inside the
 * shell, but only looking at it says whether it is on the water heater rather
 * than floating over the stairs.
 */
function renderHealth(): string {
  const rooms = visibleRooms(HOUSE);
  const yearsAgo = (n: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  };

  const assets = [
    { category: 'water_heater' as const, name: 'Rheem 50 gal', installedAt: yearsAgo(11) },
    { category: 'hvac' as const, name: 'Carrier furnace', installedAt: yearsAgo(16) },
    { category: 'electrical' as const, name: '200A panel', installedAt: yearsAgo(4) },
    { category: 'roof' as const, name: 'Architectural shingle', installedAt: yearsAgo(19) },
    { category: 'plumbing' as const, name: 'Copper supply', installedAt: yearsAgo(58) },
    { category: 'windows' as const, name: 'Double-hung vinyl', installedAt: yearsAgo(8) },
    { category: 'air_filter' as const, name: 'MERV 11 filter', installedAt: yearsAgo(0) },
    // No install date: the ring should read as unknown, not as new.
    { category: 'exterior' as const, name: 'Cedar siding' },
  ].map((a) => createEmptyHealthAsset(a));

  const body = renderToStaticMarkup(
    <>
      <HouseCutaway rooms={rooms} showWater />
      <HealthPins pins={buildHealthPins(assets, rooms)} />
    </>,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VB_W}" height="${VB_H}" viewBox="0 0 ${VB_W} ${VB_H}">`
    + `<rect width="${VB_W}" height="${VB_H}" fill="#f6faff"/>${body}</svg>`;
}

/**
 * A component close-up as the app composes it: the real geometry, zoomed, with its
 * condition marked on it and the surroundings washed back.
 *
 * Nothing is blurred and no stand-in object is drawn, so the questions this answers
 * are whether the frame actually contains the component and whether the wear reads
 * as wear on that surface. Shot at several ages, because a component that renders
 * identically at four years and twenty-two has made the close-up pointless.
 */
function renderHealthFocus(category: PropertyHealthCategory, ageYears: number | null): string {
  const rooms = visibleRooms(HOUSE);
  const yearsAgo = (n: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  };

  const asset = createEmptyHealthAsset({
    category,
    name: PROPERTY_HEALTH_CATEGORY_META[category].label,
    make: 'Rheem',
    model: 'XE50T10',
    installedAt: ageYears == null ? null : yearsAgo(ageYears),
  });

  const pin = buildHealthPins([asset], rooms)[0];
  if (!pin) throw new Error(`no pin for ${category}`);

  const region = componentRegion(category, rooms);
  const camera = cameraForHealthComponent(
    region.box,
    pin.anchor.roomId ? rooms.find((r) => r.id === pin.anchor.roomId) ?? null : null,
  );

  const body = renderToStaticMarkup(
    <>
      <HouseCutaway rooms={rooms} showWater />
      <ComponentCondition region={region} category={category} pin={pin} onDismiss={() => {}} />
    </>,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${Math.round(760 / (VB_W / VB_H))}" viewBox="${cameraViewBox(camera)}">`
    + `<rect x="${camera.x}" y="${camera.y}" width="${camera.w}" height="${camera.h}" fill="#f6faff"/>${body}</svg>`;
}

describe('twin canvas preview', () => {
  it('renders to svg', () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/cutaway-health.svg`, renderHealth());
    writeFileSync(`${OUT}/cutaway.svg`, renderCanvas(null));
    writeFileSync(`${OUT}/turned-quarter.svg`, renderTurned(archetypeSiteModel(HOUSE), -0.6));
    writeFileSync(`${OUT}/turned-front.svg`, renderTurned(archetypeSiteModel(HOUSE), 0));
    /*
     * The pair the whole view exists for: the same model, spun half a turn.
     * Checked together rather than singly, because what matters is not that
     * either frame looks like a house but that the rooms open on the side you
     * are standing on — the front rank from the street, the back rank from
     * behind — off one cull rule and no per-view special casing.
     */
    writeFileSync(`${OUT}/turned-back.svg`, renderTurned(archetypeSiteModel(HOUSE), Math.PI));
    /*
     * The 11819 case: a carport recovered from a roof plane the footprint has no
     * walls for. Rendered rather than only unit-tested because the failure that
     * matters is visual — a mass can exist in the model and still draw as a
     * solid block glued to the side of the house.
     */
    {
      const base = archetypeSiteModel(HOUSE);
      const primary = base.structures[0];
      writeFileSync(`${OUT}/turned-carport.svg`, renderTurned({
        ...base,
        structures: [{
          ...primary,
          roof: {
            ...primary.roof,
            tiers: [{ dropM: -3.2, rect: { x0: 7, y0: -3.5, x1: 13.5, y1: 3.5 } }],
          },
        }],
      }, -0.6));
    }
    writeFileSync(`${OUT}/turned-back-quarter.svg`, renderTurned(archetypeSiteModel(HOUSE), Math.PI - 0.34));
    // Flood scenarios, to check the waterline lands at a believable elevation.
    writeFileSync(`${OUT}/cutaway-flood-shallow.svg`, renderCanvas(0.4));
    writeFileSync(`${OUT}/cutaway-flood-deep.svg`, renderCanvas(2.5));
    writeFileSync(`${OUT}/cutaway-alert.svg`, renderCanvas(null, kitchenLeak));
    // Flexed layout: the services are routed off the room geometry, so the
    // variant that drops a whole storey is the one that can leave pipework
    // hanging in a room that no longer exists.
    writeFileSync(`${OUT}/cutaway-condo.svg`, renderCanvas(null, [], CONDO));

    writeFileSync(`${OUT}/cutaway-rain.svg`, renderCutaway({
      weather: { kind: 'heavy', intensity: 0.8, windMph: 16 },
    }));
    writeFileSync(`${OUT}/cutaway-snow.svg`, renderCutaway({
      weather: { kind: 'snow', intensity: 0.6, windMph: 6 },
    }));
    // Valve shut with a live leak: the drips stop, the puddle stays.
    writeFileSync(`${OUT}/cutaway-valve-closed.svg`, renderCutaway({
      waterFlowing: false,
      alertRooms: new Set(['kitchen']),
    }));
    writeFileSync(`${OUT}/cutaway-power.svg`, renderCutaway({ showPower: true }));

    /*
     * Leak propagation. This is the variant that has to be looked at rather than
     * asserted: the tests can prove which rooms are flagged, but only the drawing
     * says whether the hatch is distinguishable from the alert fill at a glance
     * and whether the drips land on the rooms below rather than in the slab.
     */
    const propagationRooms = visibleRooms(HOUSE);
    const upstairsLeak = (over: Parameters<typeof propagateHouseLeak>[2]) =>
      propagateHouseLeak(propagationRooms, ['bath_up'], over);

    writeFileSync(`${OUT}/cutaway-propagation.svg`, renderCutaway({
      alertRooms: new Set(['bath_up']),
      exposures: upstairsLeak({ valveState: 'open', minutesSinceDetection: 90 }),
    }));
    // Just detected: the ramp has barely started, so fewer rooms are in scope.
    writeFileSync(`${OUT}/cutaway-propagation-fresh.svg`, renderCutaway({
      alertRooms: new Set(['bath_up']),
      exposures: upstairsLeak({ valveState: 'open', minutesSinceDetection: 0 }),
    }));
    // Shut off: the drips stop and the exposed set shrinks. Side by side with the
    // open-valve shot, this is the picture that argues for the shutoff hardware.
    writeFileSync(`${OUT}/cutaway-propagation-valve-closed.svg`, renderCutaway({
      waterFlowing: false,
      alertRooms: new Set(['bath_up']),
      exposures: upstairsLeak({ valveState: 'closed', minutesSinceDetection: 90 }),
    }));
    // A basement leak has nothing under it, so nothing should be hatched.
    writeFileSync(`${OUT}/cutaway-propagation-basement.svg`, renderCutaway({
      alertRooms: new Set(['utility']),
      exposures: propagateHouseLeak(propagationRooms, ['utility'], {
        valveState: 'open',
        minutesSinceDetection: 90,
      }),
    }));

    /*
     * Coverage gaps. Two shots, because the badge has two jobs: reading clearly
     * on a calm house, and still reading when it lands on top of the amber
     * exposure hatch — which is the case that matters, since a blind spot in the
     * leak path is the worst room in the building.
     */
    const gapCoverage = computeCoverage(
      propagationRooms,
      [{ roomId: 'laundry', kind: 'flood' }],
    );
    const gapRooms = new Set(gapCoverage.unmonitored.map((location) => location.roomId));

    writeFileSync(`${OUT}/cutaway-coverage-gaps.svg`, renderCutaway({
      coverageGaps: gapRooms,
    }));
    writeFileSync(`${OUT}/cutaway-coverage-with-leak.svg`, renderCutaway({
      alertRooms: new Set(['bath_up']),
      exposures: upstairsLeak({ valveState: 'open', minutesSinceDetection: 90 }),
      coverageGaps: gapRooms,
    }));

    /*
     * The multifamily side elevation.
     *
     * Four shots, because the drawing has to survive four separate things: an
     * empty walk-up (is the shell right?), a leak on a middle floor (does the
     * exposure read down the stack?), the far facade (does the mirrored order
     * make sense?), and a long midrise (does it still work at 12 columns?).
     */
    const walkup = buildBuilding({
      ...DEFAULT_BUILDING_SPEC,
      floors: 3,
      unitsPerFloor: 4,
      archetype: 'garden_walkup',
      hasBasement: true,
    });
    writeFileSync(`${OUT}/building-walkup.svg`, renderBuilding(walkup, 'A', {}));

    const walkupLeak = propagateLeak({
      cells: buildingCells(walkup),
      sourceCellIds: ['u-A-0-1'],
      valveState: 'open',
      minutesSinceDetection: 90,
    });
    writeFileSync(`${OUT}/building-walkup-leak.svg`, renderBuilding(walkup, 'A', {
      alertUnits: new Set(['u-A-0-1']),
      exposures: walkupLeak,
      selectedStackId: 'riser-A-1',
      coverageGaps: new Set(['u-A-1-1', 'u-A-2-3']),
    }));

    const midrise = buildBuilding({
      ...DEFAULT_BUILDING_SPEC,
      floors: 5,
      unitsPerFloor: 8,
      corridor: 'double_loaded',
      sharedRisers: true,
      archetype: 'midrise_corridor',
    });
    const midriseLeak = propagateLeak({
      cells: buildingCells(midrise),
      sourceCellIds: ['u-A-1-2'],
      valveState: 'open',
      minutesSinceDetection: 120,
    });
    writeFileSync(`${OUT}/building-midrise.svg`, renderBuilding(midrise, 'A', {
      alertUnits: new Set(['u-A-1-2']),
      exposures: midriseLeak,
    }));
    // The far facade, where the cross-side badge has taken you.
    writeFileSync(`${OUT}/building-midrise-rear.svg`, renderBuilding(midrise, 'B', {
      exposures: midriseLeak,
    }));

    /*
     * Exploded, which exists because the slab between two floors is 16 units
     * thick and the drips crossing it have nowhere to be seen in a section.
     */
    writeFileSync(`${OUT}/building-exploded.svg`, renderBuilding(walkup, 'A', {
      alertUnits: new Set(['u-A-0-1']),
      exposures: walkupLeak,
      mode: 'exploded',
    }));

    /*
     * The exploded plate stack, which is where the multifamily drawing is
     * actually going. Shot at three sizes, because the whole claim being made is
     * that one projection survives all of them:
     *
     *  - the walk-up, where the detail has to justify itself against the house
     *  - the midrise mid-leak, which is the working case
     *  - a 300-unit tower, which is the size that broke the elevation
     */
    writeFileSync(`${OUT}/stack-walkup.svg`, renderStack(walkup));
    writeFileSync(`${OUT}/stack-walkup-leak.svg`, renderStack(walkup, {
      alertUnits: new Set(['u-A-0-1']),
      exposures: walkupLeak,
      selectedStackId: 'riser-A-1',
      coverageGaps: new Set(['u-A-1-1', 'u-A-2-3']),
    }));
    writeFileSync(`${OUT}/stack-midrise.svg`, renderStack(midrise, {
      alertUnits: new Set(['u-A-1-2']),
      exposures: midriseLeak,
      selectedStackId: 'riser-2',
    }));

    const tower = buildBuilding({
      ...DEFAULT_BUILDING_SPEC,
      floors: 15,
      unitsPerFloor: 10,
      corridor: 'double_loaded',
      sharedRisers: true,
      hasBasement: true,
      archetype: 'midrise_corridor',
      confidence: 'high',
      needsConfirmation: false,
    });
    const towerLeak = propagateLeak({
      cells: buildingCells(tower),
      sourceCellIds: ['u-A-4-6'],
      valveState: 'open',
      minutesSinceDetection: 150,
    });
    writeFileSync(`${OUT}/stack-tower.svg`, renderStack(tower));
    writeFileSync(`${OUT}/stack-tower-leak.svg`, renderStack(tower, {
      alertUnits: new Set(['u-A-4-6']),
      exposures: towerLeak,
      selectedStackId: 'riser-6',
      coverageGaps: new Set(['u-B-6-6', 'u-A-8-6']),
    }));

    /*
     * The riser view. Three shots, because the drawing has three jobs: an
     * unshared riser in a walk-up (does the fixture detail hold up?), a shared
     * riser mid-leak (does the cross-corridor claim look like a claim?), and the
     * same riser isolated (does closing the valve visibly change anything?).
     */
    writeFileSync(`${OUT}/riser-walkup.svg`, renderRiser(walkup, 'riser-A-1', {
      alertUnits: new Set(['u-A-0-1']),
      exposures: walkupLeak,
      coverageGaps: new Set(['u-A-1-1']),
    }));
    writeFileSync(`${OUT}/riser-shared.svg`, renderRiser(midrise, 'riser-2', {
      alertUnits: new Set(['u-A-1-2']),
      exposures: midriseLeak,
      coverageGaps: new Set(['u-B-3-2']),
    }));
    writeFileSync(`${OUT}/riser-closed.svg`, renderRiser(midrise, 'riser-2', {
      alertUnits: new Set(['u-A-1-2']),
      exposures: midriseLeak,
      valveState: 'closed',
    }));
    writeFileSync(`${OUT}/riser-tower.svg`, renderRiser(tower, 'riser-6', {
      alertUnits: new Set(['u-A-4-6']),
      exposures: towerLeak,
    }));

    /*
     * The floor plate. Two shots: the wet floor of a corridor building, which is
     * the only drawing that shows both sides of the hall at once, and a walk-up,
     * which has no far side and must not pretend otherwise.
     */
    writeFileSync(`${OUT}/plate-midrise.svg`, renderPlate(midrise, 2, {
      exposures: midriseLeak,
      highlightSide: 'A',
    }));
    writeFileSync(`${OUT}/plate-walkup.svg`, renderPlate(walkup, 1, {
      exposures: walkupLeak,
      coverageGaps: new Set(['u-A-1-3']),
    }));

    /*
     * The site view, at four poses. This one has to be looked at from more than
     * one angle by definition: the entire claim is that one model survives being
     * turned, and the thing that carries it is the shading. Two walls of the same
     * house have to differ in tone or the corner between them disappears and the
     * whole lot flattens into a set of overlapping outlines.
     */
    const site = siteWithOutbuildings();
    writeFileSync(`${OUT}/site-default.svg`, renderSite(site, SITE_ORBIT));
    // Round the other side, where the garage should occlude rather than be occluded.
    writeFileSync(`${OUT}/site-opposite.svg`, renderSite(site, { yaw: Math.PI - 0.62, pitch: 0.5 }));
    // Near plan, which is the pose that tests the footprint rather than the massing.
    writeFileSync(`${OUT}/site-high.svg`, renderSite(site, { yaw: -0.3, pitch: 1.02 }));
    // Storeys banded, which asserts a floor count the plain prism does not.
    writeFileSync(`${OUT}/site-storeys.svg`, renderSite(site, { yaw: 0.5, pitch: 0.5 }, {
      showStoreys: true,
      selectedStructureId: 'garage',
    }));

    for (const kind of ['flood', 'ht', 'relay', 'gateway'] as HeroKind[]) {
      writeFileSync(`${OUT}/hero-${kind}.svg`, renderHero(kind));
    }
    writeFileSync(`${OUT}/hero-flood-alarm.svg`, renderHero('flood', { alarming: true }));

    // In situ, which is the only framing that says whether the scale is right.
    writeFileSync(`${OUT}/focus-kitchen.svg`, renderFocused('kitchen', 'flood'));
    writeFileSync(`${OUT}/focus-primary.svg`, renderFocused('bed_primary', 'ht'));
    writeFileSync(`${OUT}/focus-hall.svg`, renderFocused('hall_up', 'gateway'));
    writeFileSync(`${OUT}/focus-laundry-alarm.svg`, renderFocused('laundry', 'flood', true));

    // Component close-ups. The ages span the condition scale, because the wear on
    // the surface is the whole point of the drawing.
    writeFileSync(`${OUT}/component-water-heater.svg`, renderHealthFocus('water_heater', 11));
    writeFileSync(`${OUT}/component-hvac.svg`, renderHealthFocus('hvac', 16));
    writeFileSync(`${OUT}/component-panel.svg`, renderHealthFocus('electrical', 4));
    // The roof at three ages, which is the comparison that says whether the wear
    // is reading as condition or as decoration.
    writeFileSync(`${OUT}/component-roof-new.svg`, renderHealthFocus('roof', 3));
    writeFileSync(`${OUT}/component-roof.svg`, renderHealthFocus('roof', 19));
    writeFileSync(`${OUT}/component-roof-overdue.svg`, renderHealthFocus('roof', 27));
    // No install date: the gauge must read as unknown, not as new.
    writeFileSync(`${OUT}/component-exterior.svg`, renderHealthFocus('exterior', null));
  });

  /**
   * The house, walked around.
   *
   * This is the view the rotation gesture actually drives, so it is shot at the
   * poses a user reaches: dead front, both three-quarters, both ends, and dead
   * back. The claim being checked by eye is that one model survives all seven —
   * that the front view opens the street rooms, the back view opens the back
   * rooms, and neither is a special case in the code.
   */
  it('renders the house at every angle the gesture reaches', () => {
    mkdirSync(OUT, { recursive: true });
    const rect = archetypeSiteModel(HOUSE);
    const lShaped = withFootprint(HOUSE, [
      // Two-storey colonial with a lower garage wing on the west — the shape
      // that used to need the wing hardcoded to appear at all.
      { x: -11.2, y: -4.8 }, { x: -4.2, y: -4.8 }, { x: -4.2, y: -7.4 },
      { x: 8.6, y: -7.4 }, { x: 8.6, y: 5.2 }, { x: -11.2, y: 5.2 },
    ]);
    const stepped = withFootprint(HOUSE, [
      // Garage, main block, and a rear addition: three masses, two roof steps.
      { x: -12, y: -2 }, { x: -5.5, y: -2 }, { x: -5.5, y: -6.5 },
      { x: 6, y: -6.5 }, { x: 6, y: -2 }, { x: 11.5, y: -2 },
      { x: 11.5, y: 5 }, { x: -12, y: 5 },
    ]);

    const poses: Array<[string, number]> = [
      ['front', 0],
      ['front-left', -0.55],
      ['front-right', 0.55],
      ['side', Math.PI / 2],
      ['back-right', Math.PI - 0.55],
      ['back', Math.PI],
    ];
    const pitch = HOUSE_FRONT.pitch;
    for (const [name, yaw] of poses) {
      writeFileSync(`${OUT}/house-rect-${name}.svg`, renderTurned(rect, yaw));
      writeFileSync(`${OUT}/house-l-${name}.svg`, renderTurned(lShaped, yaw));
      writeFileSync(`${OUT}/house-stepped-${name}.svg`, renderTurned(stepped, yaw));
    }
  });

  it('renders section orbit frames', () => {
    mkdirSync(OUT, { recursive: true });
    const model = archetypeSiteModel(HOUSE);
    const prestwick = (() => {
      const base = archetypeSiteModel(HOUSE);
      const primary = base.structures[0];
      return {
        ...base,
        structures: [{
          ...primary,
          footprint: [
            { x: -6.847, y: 4.019 },
            { x: -0.752, y: 10.375 },
            { x: 10.642, y: -0.557 },
            { x: 1.815, y: -9.774 },
            { x: -1.193, y: -6.88 },
            { x: 1.547, y: -4.03 },
          ],
          levels: primary.levels.map((level) => ({ ...level, source: 'rules' as const })),
          roof: { ...primary.roof, ridgeAxis: 'x' as const, eaveZ: 5.4, ridgeZ: 8.951, overhang: 0.6 },
        }],
      };
    })();
    const frames: Array<[string, number]> = [
      ['orbit-0', 0],
      ['orbit-25', 0.4],
      ['orbit-50', 0.8],
      ['orbit-90', Math.PI / 2],
      ['orbit-180', Math.PI],
      ['orbit-n50', -0.8],
    ];
    for (const [name, yaw] of frames) {
      writeFileSync(`${OUT}/${name}.svg`, renderSectionOrbit(model, yaw));
      writeFileSync(`${OUT}/prestwick-${name}.svg`, renderSectionOrbit(prestwick, yaw));
    }
  });
});
