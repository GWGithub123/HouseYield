/**
 * Property network twin — animated topology of the HouseYield IoT kit.
 *
 * Layout: blue-wireframe property illustration on top, HouseYield travel router hub in
 * the middle, devices fanned radially around it with dotted links and pulsing
 * "packets", and a large ball-valve assembly (with inline open/close controls)
 * anchored at the bottom. Selecting any node opens a detail panel with the
 * device's live data and management controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Battery,
  Bluetooth,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  Cloud,
  CloudRain,
  Droplets,
  FlipHorizontal2,
  HeartPulse,
  Home,
  LockKeyhole,
  Network,
  Pencil,
  RotateCcw,
  RotateCw,
  Play,
  Plus,
  Radio,
  ShieldQuestion,
  Thermometer,
  Trash2,
  Unplug,
  Waves,
  Wrench,
  Wifi,
  Wind,
  X,
  Zap,
} from 'lucide-react';
import type { ShellyAlert, ShellyDevice } from '../hooks/useShellyFirestore';
import type { PropertyPowerEstimation, PropertyPowerSignal } from '../types/iot';
import type { ParcelGeometry } from '../types/attom';
import {
  analyzePropertyPowerSignals,
  fetchUtilityOutageStatuses,
  getPowerScoreLabel,
  parseStateFromAddress,
  POWER_ESTIMATION_META,
  type UtilityOutageStatus,
} from '../services/propertyPowerService';
import {
  buildForecastTimeline,
  fetchPropertyWeatherAssessment,
  floodBridgeFromAssessment,
  weatherRiskLabel,
  weatherRiskTone,
  type ExtremeWeatherAssessment,
  type WeatherSample,
  type ForecastSlotAction,
  type WeatherHazard,
  type WeatherOverallRisk,
} from '../services/propertyWeatherClient';
import { Link } from 'react-router-dom';
import {
  type MaintenanceProgressRequest,
} from './MaintenanceProgressTracker';
import FloodDispatchFeed from './twin/FloodDispatchFeed';
import { Modal } from '../design-system/components/Modal';
import {
  submitMaintenanceRequest,
  type MaintenanceSubmitPayload,
} from '../services/maintenanceApi';
import { getDevApiBaseUrl } from '../utils/devApiBase';
import HouseCutaway, { type LiveWeather } from './twin/HouseCutaway';
import TwinMapLayer from './twin/TwinMapLayer';
import {
  bearingToCompass,
  resolveHazard,
  type ForecastTrackKind,
  type HazardSelection,
  type TwinLayer,
} from './twin/hazardScenario';
import {
  exposureProgression,
  houseCells,
  propagateHouseLeak,
  propagateLeak,
  summarizeExposure,
  TIER_LABEL,
  type LeakExposure,
  type ValveState,
} from './twin/leakPropagation';
import {
  computeCoverage,
  rankInspectionTargets,
  summarizeCoverage,
} from './twin/coverageModel';
import {
  anchorsFor,
  inferRoom,
  roomAtPoint,
  roomById,
  DEFAULT_ROUTER_ROOM,
  DX,
  VALVE_CENTER,
  VALVE_SCALE,
  VB_H as HOUSE_VB_H,
  VB_W as HOUSE_VB_W,
  VERTICAL_UNITS_PER_M,
  WATER_MAIN_Y,
  type RoomDef,
  type RoomInference,
} from './twin/houseModel';
import { computeFloodStage, type FloodStage } from './twin/floodStage';
import { houseCameraFor, projectHouse } from './twin/houseProjection';
import { archetypeSiteModel } from './twin/siteModel';
import SiteView, { siteViewScene } from './twin/SiteView';
import { useSiteModel } from './twin/useSiteModel';
import SiteEditor, { SiteGuessBanner } from './twin/SiteEditor';
import HealthPins from './twin/HealthPins';
import {
  buildHazardCrossovers,
  buildHealthPins,
  healthTint,
  type HazardCrossover,
} from './twin/healthAnchors';
import {
  HEALTH_EVIDENCE_META,
  PROPERTY_HEALTH_CATEGORY_META,
  resolveAssetAgeYears,
  resolveLifeUsedRatio,
  resolveUsefulLifeYears,
  type PropertyHealthAsset,
} from '../types/propertyHealth';
import {
  summarizeComponentCosts,
  type ComponentCostSummary,
} from '../services/propertyHealthDocuments';
import {
  HISTORY_EVENT_META,
  buildPropertyHistoryTimeline,
  type PropertyHistoryEvent,
} from '../services/propertyHealthTimeline';
import {
  forecastComponentMaintenance,
  inferPropertyMaintenanceExposure,
  type ComponentMaintenanceForecast,
} from '../services/propertyHealthForecast';
import DeviceHero from './twin/DeviceHero';
import ComponentCondition from './twin/ComponentCondition';
import { componentRegion } from './twin/componentWear';
import {
  cameraForDevice,
  cameraForRoom,
  cameraViewBox,
  HOUSE_CAMERA,
  HOUSE_FRONT,
  SITE_ORBIT,
  clampHouseOrbit,
  useCameraTween,
  useOrbitTween,
  type Orbit,
} from './twin/twinCamera';
import BuildingCutaway, { buildingCutawayScene } from './twin/BuildingCutaway';
import BuildingPlateStack, { plateStackScene } from './twin/BuildingPlateStack';
import FloorPlate from './twin/FloorPlate';
import RiserView, { riserScene } from './twin/RiserView';
import StackEditor, { StackGuessBanner, SwitchToBuildingBanner } from './twin/StackEditor';
import { useBuildingModel } from './twin/useBuildingModel';
import {
  buildingScene,
  cameraForBuildingFocus,
  parentFocus as buildingParentFocus,
  type BuildingFocus,
} from './twin/buildingCamera';
import {
  buildBuilding,
  buildingCells,
  coverageSpacesFromUnits,
  DEFAULT_BUILDING_SPEC,
  explodeOffset,
  inferUnit,
  oppositeSide,
  shouldDrawAsBuilding,
  unitAtPoint,
  unitById,
  type BuildingSide,
  type DerivedBuildingGeometry,
} from './twin/buildingModel';
import { useFloodDepthGrid, type CoastalSurge, type LotFlow } from '../hooks/useFloodDepthGrid';
import { useFloodForecast } from '../hooks/useFloodForecast';
import StormTimeline from './twin/StormTimeline';
import { comfortTint } from '../design-system/riskPalette';

/**
 * The zoom ladder, outside-in. Ordered so moving right always means moving
 * closer, which is the mental model the labels are trading on.
 */
const LAYER_TABS: { id: TwinLayer; label: string; hint: string }[] = [
  { id: 'neighborhood', label: 'Neighborhood', hint: 'Where water collects around the property' },
  { id: 'lot', label: 'Lot', hint: 'How water crosses the parcel' },
  { id: 'interior', label: 'Interior', hint: 'What the water reaches inside' },
];

/** Outside-in, so a rising index always means "closer". */
const LAYER_ORDER: TwinLayer[] = LAYER_TABS.map((t) => t.id);

function alertMaintenanceRequestId(alert: ShellyAlert | null | undefined): string | null {
  if (!alert?.tenantNotification) return null;
  return alert.tenantNotification.requestId
    || alert.tenantNotification.maintenanceRequestId
    || null;
}

function cleanMaintenanceIssue(raw: string): string {
  const cleaned = String(raw || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Flood / leak detected';
  // Prefer a short first sentence for the side panel.
  const first = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

function sensorTicketCategory(type: ShellyAlert['type']): MaintenanceSubmitPayload['category'] {
  if (['flood', 'freeze_risk', 'pipe_burst'].includes(type)) return 'Plumbing';
  if (['temperature', 'humidity', 'mold_risk', 'insulation_failure', 'rapid_temp_change', 'humidity_damage'].includes(type)) return 'HVAC';
  if (['battery_low', 'offline'].includes(type)) return 'Electrical';
  return 'Other';
}

function sensorTicketActions(type: ShellyAlert['type']): string[] {
  if (type === 'flood') return ['Inspect the source of water', 'Dry the affected area', 'Verify the shutoff valve and repair the leak'];
  if (type === 'freeze_risk' || type === 'pipe_burst') return ['Inspect exposed plumbing', 'Restore safe heat', 'Check for leaks before reopening water'];
  if (type === 'mold_risk' || type === 'humidity_damage' || type === 'humidity') return ['Inspect for moisture intrusion', 'Check ventilation and dehumidification', 'Assess affected finishes for damage'];
  if (type === 'temperature' || type === 'rapid_temp_change' || type === 'insulation_failure') return ['Inspect HVAC operation', 'Check airflow and insulation near the sensor', 'Confirm the room returns to the safe range'];
  if (type === 'battery_low') return ['Replace the sensor battery', 'Test the sensor after replacement'];
  if (type === 'offline') return ['Inspect power and connectivity', 'Restore the sensor connection', 'Verify fresh telemetry reaches HouseYield'];
  return ['Inspect the sensor location', 'Diagnose the reported condition', 'Verify the alert is resolved'];
}

export function buildSensorMaintenanceDraft({
  device,
  alert,
  propertyAddress,
  roomLabel,
}: {
  device: ShellyDevice;
  alert: ShellyAlert;
  propertyAddress?: string;
  roomLabel?: string;
}): MaintenanceSubmitPayload {
  const detectedAt = alert.timestamp instanceof Date
    ? alert.timestamp
    : new Date(alert.timestamp);
  const detectedAtIso = Number.isNaN(detectedAt.getTime())
    ? new Date().toISOString()
    : detectedAt.toISOString();
  const location = roomLabel || device.location || alert.deviceName || device.name || 'Sensor location';
  const temperatureC = device.temperature;
  const temperatureF = device.temperatureF
    ?? (temperatureC != null ? (temperatureC * 9) / 5 + 32 : undefined);
  const actions = sensorTicketActions(alert.type);
  const readingLines = [
    temperatureC != null ? `Temperature: ${temperatureC.toFixed(1)}°C / ${temperatureF?.toFixed(1)}°F` : null,
    device.humidity != null ? `Humidity: ${device.humidity.toFixed(0)}% RH` : null,
    device.flood != null || device.isFlooded != null ? `Water detected: ${Boolean(device.flood || device.isFlooded) ? 'yes' : 'no'}` : null,
    device.batteryPercent != null ? `Battery: ${device.batteryPercent}%` : null,
    device.wifiRssi != null ? `Signal: ${device.wifiRssi} dBm` : null,
    `Device status: ${device.status}`,
  ].filter((line): line is string => Boolean(line));
  const description = [
    `SENSOR-GENERATED MAINTENANCE ISSUE: ${cleanMaintenanceIssue(alert.message)}`,
    '',
    `Property: ${propertyAddress || 'Assigned property'}`,
    `Location: ${location}`,
    `Sensor: ${alert.deviceName || device.name} (${device.deviceId})`,
    `Alert: ${alert.type.replace(/_/g, ' ')} · ${alert.severity}`,
    `Detected: ${detectedAt.toLocaleString()}`,
    '',
    'Telemetry snapshot:',
    ...readingLines.map((line) => `• ${line}`),
    '',
    'Requested resolution:',
    ...actions.map((action) => `• ${action}`),
    '• Confirm normal readings and close the sensor alert after service',
  ].join('\n');

  return {
    category: sensorTicketCategory(alert.type),
    priority: alert.severity === 'critical' ? 'urgent' : alert.severity === 'warning' ? 'normal' : 'low',
    description,
    location,
    propertyAddress,
    ownerId: alert.ownerId || device.ownerId,
    propertyId: alert.propertyId || device.propertyId,
    submittedBy: { role: 'owner' },
    autoBook: false,
    triage: {
      category: sensorTicketCategory(alert.type),
      priority: alert.severity === 'critical' ? 'urgent' : alert.severity === 'warning' ? 'normal' : 'low',
      location,
      summary: cleanMaintenanceIssue(alert.message),
      ownerSummary: `${alert.severity} ${alert.type.replace(/_/g, ' ')} alert from ${alert.deviceName || device.name}`,
      serviceTypeHint: sensorTicketCategory(alert.type),
      readyToSubmit: true,
      emergencyLevel: alert.severity === 'critical' ? 'urgent' : 'none',
      emergencyGuidance: alert.type === 'flood'
        ? 'If water is actively flowing and it is safe to do so, close the property water shutoff.'
        : undefined,
      suggestedActions: actions,
    },
    intake: {
      mode: 'form',
      extracted: null,
      completedAt: new Date().toISOString(),
    },
    sensorContext: {
      alertId: alert.id,
      alertType: alert.type,
      severity: alert.severity,
      detectedAt: detectedAtIso,
      deviceId: device.deviceId,
      deviceName: alert.deviceName || device.name,
      deviceModel: device.model,
      room: location,
      message: alert.message,
      readings: {
        temperatureC,
        temperatureF,
        humidityPercent: device.humidity,
        floodDetected: device.flood ?? device.isFlooded,
        batteryPercent: device.batteryPercent,
        signalDbm: device.wifiRssi,
        deviceStatus: device.status,
      },
    },
  };
}

/** Compact flood-panel summary — full stepper is too wide for this column. */
type TopologyDeviceKind = 'flood' | 'gateway' | 'ht' | 'relay' | 'other';

/** What the interior camera is framing: the whole section, a room, or one device. */
/**
 * Where the interior camera is pointed.
 *
 * `floor` and `unit` are the multifamily rungs. They sit in the same union rather
 * than a parallel one because the camera, the Back button and the "leaving the
 * interior resets the view" rules are all shared — a second focus state would mean
 * two of everything and two chances for them to disagree about where you are.
 */
type TwinFocus =
  | { kind: 'house' }
  | { kind: 'room'; roomId: string }
  | { kind: 'device'; deviceId: string }
  | { kind: 'health'; assetId: string }
  | { kind: 'floor'; level: number }
  | { kind: 'unit'; unitId: string };

type NodeTone = 'healthy' | 'attention' | 'critical' | 'offline' | 'sleeping' | 'unknown';
type SetupDeviceType = 'flood' | 'ht' | 'gateway' | 'relay';

export interface TopologyPropertyOption {
  id: string;
  address: string;
  beds?: number;
  baths?: number;
  latitude?: number;
  longitude?: number;
  /** Drives the flood damage estimate in the storm preview. */
  livingSqft?: number;
  /** ATTOM id, used only to key the parcel-outline lookup. */
  attomId?: string;
  /**
   * Parcel outline already present on the loaded property data. Passing it
   * through spares the lot view a `/api/attom/parcel-geometry` request, whose
   * cache misses are expensive against the ATTOM monthly cap.
   */
  parcelGeometry?: ParcelGeometry | null;
  /**
   * Coarse stacking plan — floors, units, archetype — derived server-side from
   * the same cached ATTOM blob as everything else, so it costs nothing to pass.
   *
   * Only a seed. It decides whether to draw a house or a building and what the
   * first guess looks like; a plan someone has actually confirmed overrides it.
   */
  buildingGeometry?: DerivedBuildingGeometry | null;
}

interface DeviceTopologyMapProps {
  devices: ShellyDevice[];
  alerts: ShellyAlert[];
  properties?: TopologyPropertyOption[];
  selectedPropertyId?: string;
  onSelectProperty?: (propertyId: string) => void;
  activeValveCommand?: string | null;
  valveCommandMessage?: { type: 'success' | 'error'; text: string } | null;
  onValveCommand?: (device: ShellyDevice, action: 'open' | 'close') => void;
  onRenameDevice?: (device: ShellyDevice, newName: string) => Promise<void> | void;
  /** Persist where a device pin was dropped on the cutaway; null clears it. */
  onAssignRoom?: (device: ShellyDevice, roomId: string | null) => Promise<void> | void;
  /** Persist which apartment a pin was dropped on. Separate from rooms: a unit id is not a room id. */
  onAssignUnit?: (device: ShellyDevice, unitId: string | null) => Promise<void> | void;
  onUnassignDevice?: (device: ShellyDevice) => void;
  onDeleteDevice?: (device: ShellyDevice) => void;
  onReconfigureFlood?: (device: ShellyDevice) => void;
  onReconnectRelay?: (device: ShellyDevice) => void;
  onAcknowledgeAlert?: (alertId: string) => Promise<void> | void;
  onAddDevice?: (deviceType?: SetupDeviceType) => void;
  deletingDeviceId?: string | null;
  /**
   * Modelled depth of water at exterior grade for the storm being previewed,
   * in feet. Comes from the flood depth model's `home.depthFt`; the section
   * converts it into a water level off the basement slab.
   */
  floodDepthAtGradeFt?: number | null;
  /** Storm size the depth above belongs to, for labelling the preview. */
  floodScenarioLabel?: string | null;
  /**
   * Tracked components from Property Health. Supplied, the interior gains a
   * Health overlay drawing each component where it stands with the share of
   * its useful life already spent; omitted, the overlay switch stays hidden.
   */
  healthAssets?: PropertyHealthAsset[];
  /** Opens the component in the Property Health tab from the detail rail. */
  onOpenHealthAsset?: (assetId: string) => void;
}

/* ── classification ─────────────────────────────────────────────── */

function deviceKind(device: ShellyDevice): TopologyDeviceKind {
  const type = `${device.type} ${device.model || ''} ${device.deviceId} ${device.name || ''}`.toLowerCase();
  if (type.includes('relay') || device.capabilities?.includes('water_shutoff')) return 'relay';
  if (type.includes('gateway') || type.includes('blugw') || type.includes('sngw')) return 'gateway';
  if (type.includes('flood') || type.includes('water_leak') || type.includes('leak') || device.capabilities?.includes('flood')) return 'flood';
  if (
    type.includes('ht')
    || type.includes('h&t')
    || type.includes('humidity')
    || type.includes('temperature')
    || device.capabilities?.includes('humidity')
    || device.capabilities?.includes('temperature')
  ) return 'ht';
  if (device.bleAddress) return 'ht';
  return 'other';
}

/** Freeze risk threshold: below ~40°F pipes are at risk of bursting. */
const FREEZE_RISK_C = 4.5;
/** Sustained humidity at or above this invites mold / condensation damage. */
const HUMIDITY_RISK = 70;

function deviceHazard(device: ShellyDevice, alerts: ShellyAlert[] = []): 'flood' | 'freeze' | 'humidity' | null {
  // Only treat flood as an active hazard while an open flood alert exists.
  // After dismiss, don't keep the critical animation even if isFlooded briefly lags.
  const openFloodAlert = alerts.some((a) => (
    a.deviceId === device.deviceId && !a.acknowledged && a.type === 'flood'
  ));
  if ((device.isFlooded || device.flood) && openFloodAlert) return 'flood';
  if (device.temperature != null && device.temperature <= FREEZE_RISK_C) return 'freeze';
  if (device.humidity != null && device.humidity >= HUMIDITY_RISK) return 'humidity';
  return null;
}

/**
 * How far a press may wander, in client pixels, and still count as a tap.
 *
 * Measured in screen pixels on purpose. The same distance in SVG user units is a
 * different physical distance at every camera zoom and every canvas width, and
 * the consequence of getting it wrong is not cosmetic: crossing the threshold
 * reassigns the device to whichever room the pointer is over and persists it.
 *
 * A finger is far less precise than a mouse and has no hover state to steady it,
 * so touch gets a wider allowance. These are the conventional values — Android's
 * touch slop and the usual desktop drag threshold.
 */
export function dragSlopFor(pointerType?: string): number {
  return pointerType === 'touch' || pointerType === 'pen' ? 12 : 6;
}

function hasActiveFloodWarning(device: ShellyDevice, alerts: ShellyAlert[] = []): boolean {
  /*
   * Either signal is enough.
   *
   * An earlier version required both an open flood alert *and* the live
   * `isFlooded` flag. The flag lags the alert (and can clear while the alert is
   * still open), so a room would fill red from the critical alert while the
   * leak path stayed empty — which is exactly the drawing claiming a detection
   * and then refusing to say where the water goes.
   */
  const waterAlert = alerts.some((alert) => (
    (alert.deviceId === device.deviceId || alert.deviceId === device.id)
    && !alert.acknowledged
    && (alert.type === 'flood' || alert.type === 'pipe_burst')
  ));
  return waterAlert || Boolean(device.isFlooded || device.flood);
}

function isFloodDevice(device: ShellyDevice) {
  const id = String(device.deviceId || device.id || '').toLowerCase();
  return device.type === 'flood' || device.type === 'water_leak' || id.includes('flood');
}

/** Battery-backed sensors only — relays/gateways are mains and often report a bogus 0%. */
function isBatteryPoweredDevice(device: ShellyDevice) {
  const kind = deviceKind(device);
  if (kind === 'relay' || kind === 'gateway') return false;
  if (kind === 'flood' || kind === 'ht') return true;
  const pct = device.batteryPercent ?? device.batteryLevel;
  return pct != null && pct > 0;
}

function deviceTone(device: ShellyDevice, alerts: ShellyAlert[]): NodeTone {
  const critical = alerts.some((a) => a.deviceId === device.deviceId && !a.acknowledged && a.severity === 'critical');
  const anyAlert = alerts.some((a) => a.deviceId === device.deviceId && !a.acknowledged);
  const hazard = deviceHazard(device, alerts);
  if (critical || hazard === 'flood' || hazard === 'freeze') return 'critical';
  if (device.status === 'offline') return 'offline';
  // Flood Gen4 battery sleep: enrolled recently enough, but not a live Wi‑Fi session.
  if (isFloodDevice(device) && device.status === 'unknown') return 'sleeping';
  const lowBattery = isBatteryPoweredDevice(device)
    && device.batteryPercent != null
    && device.batteryPercent <= 20;
  if (anyAlert || hazard === 'humidity' || lowBattery) return 'attention';
  if (device.status === 'online') return 'healthy';
  return 'unknown';
}

const TONE_COLOR: Record<NodeTone, string> = {
  healthy: '#06b6d4',
  attention: '#f59e0b',
  critical: '#f43f5e',
  offline: '#94a3b8',
  sleeping: '#64748b',
  unknown: '#60a5fa',
};

const TONE_LABEL: Record<NodeTone, string> = {
  healthy: 'Live',
  attention: 'Attention',
  critical: 'Critical',
  offline: 'Offline',
  sleeping: 'Sleeping',
  unknown: 'Waiting',
};

type ValveMotion = {
  state: 'open' | 'closed' | 'opening' | 'closing' | 'unknown';
  progress: number | null;
  travelMs: number;
  openness: number;
};

const DEFAULT_VALVE_TRAVEL_MS = 15000;

function getValveTravelMs(device: ShellyDevice) {
  const configured = Number(device.valveTravelMs);
  return Number.isFinite(configured) && configured >= 5000
    ? Math.min(configured, 45000)
    : DEFAULT_VALVE_TRAVEL_MS;
}

/** Prefer live relay output over a possibly-stale valveState string. */
function resolveSettledValve(
  device: ShellyDevice,
): 'open' | 'closed' | 'unknown' {
  const closeOnEnergize = device.relayCloseOn !== false;
  if (typeof device.relayOutputOn === 'boolean') {
    if (closeOnEnergize) return device.relayOutputOn ? 'closed' : 'open';
    return device.relayOutputOn ? 'open' : 'closed';
  }
  if (device.valveState === 'open' || device.valveState === 'closed') {
    return device.valveState;
  }
  return 'unknown';
}

/** Shared 15-second state machine for the animated valve and its detail card. */
function useValveMotion(device?: ShellyDevice): ValveMotion {
  const [, setTick] = useState(0);
  const travelMs = device ? getValveTravelMs(device) : DEFAULT_VALVE_TRAVEL_MS;
  const prevSettledRef = useRef<'open' | 'closed' | 'unknown' | null>(null);
  const syntheticRef = useRef<{ command: 'open' | 'close'; at: number } | null>(null);
  // After an official open/close, ignore contradictory polls for a grace window
  // so the animation doesn't finish → snap closed → replay open.
  const commandLockRef = useRef<{ command: 'open' | 'close'; until: number } | null>(null);

  const settled = device ? resolveSettledValve(device) : 'unknown';
  const settledClosed = settled === 'closed';
  const settledOpen = settled === 'open';

  // Auto-shutoff (esp. local LAN flood→relay) often flips valveState without
  // writing lastValveCommandAt. Synthesize a travel window so the UI still
  // plays the normal open/close animation — but never while the relay is offline,
  // and never to replay a command we just finished animating.
  useEffect(() => {
    if (!device) {
      prevSettledRef.current = null;
      syntheticRef.current = null;
      commandLockRef.current = null;
      return;
    }
    const prev = prevSettledRef.current;
    prevSettledRef.current = settled;
    if (prev == null) return;
    if (device.status === 'offline') {
      syntheticRef.current = null;
      return;
    }

    const commandAt = device.lastValveCommandAt ? new Date(device.lastValveCommandAt).getTime() : NaN;
    const recentOfficial = Number.isFinite(commandAt) && Date.now() - commandAt < travelMs
      && (device.lastValveCommand === 'open' || device.lastValveCommand === 'close');

    if (recentOfficial && (device.lastValveCommand === 'open' || device.lastValveCommand === 'close')) {
      syntheticRef.current = null;
      commandLockRef.current = {
        command: device.lastValveCommand,
        until: commandAt + travelMs + 20_000,
      };
      return;
    }

    // Still inside post-command grace — don't synthesize a second travel.
    if (commandLockRef.current && Date.now() < commandLockRef.current.until) {
      return;
    }

    if (prev === 'open' && settledClosed) {
      // Don't re-close-animate if the last official command was already close.
      if (device.lastValveCommand === 'close' && Number.isFinite(commandAt) && Date.now() - commandAt < travelMs * 3) {
        return;
      }
      syntheticRef.current = { command: 'close', at: Date.now() };
      setTick((value) => value + 1);
    } else if (prev === 'closed' && settledOpen) {
      if (device.lastValveCommand === 'open' && Number.isFinite(commandAt) && Date.now() - commandAt < travelMs * 3) {
        return;
      }
      syntheticRef.current = { command: 'open', at: Date.now() };
      setTick((value) => value + 1);
    }
  }, [device, settled, settledClosed, settledOpen, travelMs]);

  const commandAtRaw = device?.lastValveCommandAt
    ? new Date(device.lastValveCommandAt).getTime()
    : NaN;
  const officialRecent = Number.isFinite(commandAtRaw)
    && Date.now() - commandAtRaw < travelMs
    && (device?.lastValveCommand === 'open' || device?.lastValveCommand === 'close');
  const commandAt = officialRecent
    ? commandAtRaw
    : (syntheticRef.current?.at ?? commandAtRaw);
  const effectiveCommand = officialRecent
    ? device!.lastValveCommand
    : (syntheticRef.current?.command ?? null);
  const elapsed = Number.isFinite(commandAt) ? Date.now() - commandAt : Number.POSITIVE_INFINITY;
  const deviceOnline = device?.status === 'online';
  const transitioning = Boolean(
    device
    && deviceOnline
    && (effectiveCommand === 'open' || effectiveCommand === 'close')
    && elapsed >= 0
    && elapsed < travelMs,
  );

  useEffect(() => {
    if (!transitioning) return undefined;
    const id = window.setInterval(() => setTick((value) => value + 1), 180);
    return () => window.clearInterval(id);
  }, [device?.deviceId, device?.lastValveCommandAt, transitioning]);

  if (!device) {
    return { state: 'unknown', progress: null, travelMs, openness: 0 };
  }

  if (transitioning) {
    const progress = Math.max(0, Math.min(100, (elapsed / travelMs) * 100));
    const closing = effectiveCommand === 'close';
    return {
      state: closing ? 'closing' : 'opening',
      progress,
      travelMs,
      openness: closing ? 1 - progress / 100 : progress / 100,
    };
  }

  // Prefer command lock end-state over a stale contradictory poll right after travel.
  const lock = commandLockRef.current;
  const lockActive = Boolean(lock && Date.now() < lock.until);
  const lockedSettled = lockActive
    ? (lock!.command === 'open' ? 'open' : 'closed')
    : null;
  const finalSettled = lockedSettled
    && settled !== 'unknown'
    && settled !== lockedSettled
    // Only hold the lock when the live reading disagrees — once it agrees, release.
    ? lockedSettled
    : settled === 'unknown' && lockedSettled
      ? lockedSettled
      : settled;

  if (lockActive && settled === lockedSettled) {
    commandLockRef.current = null;
  }

  return {
    state: finalSettled,
    progress: null,
    travelMs,
    openness: finalSettled === 'open' ? 1 : 0,
  };
}

/* ── geometry ───────────────────────────────────────────────────── */

const VB_W = HOUSE_VB_W;
const VB_H = HOUSE_VB_H;

/**
 * Local drawing frame for ValveAssembly. Its internal geometry is laid out
 * around this point and a transform maps it into the basement at render time,
 * so the constant stays put even though the valve no longer sits here.
 */
const VALVE = { x: 660, y: 742 };

interface PositionedNode {
  device: ShellyDevice;
  kind: TopologyDeviceKind;
  roomId: string;
  confidence: RoomInference['confidence'];
  x: number;
  y: number;
  linkFrom: { x: number; y: number };
  linkKind: 'wifi' | 'ble';
}

interface RoomLayout {
  nodes: PositionedNode[];
  router: { x: number; y: number; roomId: string };
}

/**
 * Place every device in the room it belongs to and spread it across that
 * room's anchor slots. The router claims the first slot in whichever room it
 * lands in so a pin never sits underneath it.
 */
function layoutDevicesInRooms(
  devices: ShellyDevice[],
  rooms: RoomDef[],
  primaryRelayId: string | null,
): RoomLayout {
  const routerRoom = roomById(rooms, DEFAULT_ROUTER_ROOM)
    || rooms.find((r) => r.floor === 'main')
    || rooms[0];

  const placed = devices
    // The first relay renders as the big valve assembly rather than a pin.
    .filter((device) => device.id !== primaryRelayId)
    .map((device) => {
      const kind = deviceKind(device);
      const inference = inferRoom(
        { name: device.name, location: device.location, twinRoomId: device.twinRoomId },
        kind,
        rooms,
      );
      return { device, kind, inference };
    });

  const byRoom = new Map<string, typeof placed>();
  placed.forEach((entry) => {
    const list = byRoom.get(entry.inference.roomId) || [];
    list.push(entry);
    byRoom.set(entry.inference.roomId, list);
  });

  const routerRoomId = routerRoom?.id ?? DEFAULT_ROUTER_ROOM;
  const routerOccupants = byRoom.get(routerRoomId)?.length ?? 0;
  const routerAnchors = routerRoom ? anchorsFor(routerRoom, routerOccupants + 1) : [];
  const routerPos = routerAnchors[0] || { x: VB_W / 2, y: VB_H / 2 };

  const nodes: PositionedNode[] = [];
  const gatewayByRoomFloor = new Map<string, { x: number; y: number }>();

  byRoom.forEach((entries, roomId) => {
    const room = roomById(rooms, roomId);
    if (!room) return;
    const isRouterRoom = roomId === routerRoomId;
    const anchors = anchorsFor(room, entries.length + (isRouterRoom ? 1 : 0));
    const slots = isRouterRoom ? anchors.slice(1) : anchors;

    entries.forEach((entry, i) => {
      const pos = slots[i] || { x: room.x + room.w / 2, y: room.y + room.h / 2 };
      if (entry.kind === 'gateway') gatewayByRoomFloor.set(room.floor, pos);
      nodes.push({
        device: entry.device,
        kind: entry.kind,
        roomId,
        confidence: entry.inference.confidence,
        x: pos.x,
        y: pos.y,
        linkFrom: routerPos,
        linkKind: 'wifi',
      });
    });
  });

  // Bluetooth sensors hop through the nearest gateway when one exists, so the
  // drawn link matches how the packet actually travels.
  const anyGateway = nodes.find((n) => n.kind === 'gateway');
  nodes.forEach((node) => {
    if (node.kind !== 'ht') return;
    const room = roomById(rooms, node.roomId);
    const sameFloor = room ? gatewayByRoomFloor.get(room.floor) : undefined;
    const bridge = sameFloor || (anyGateway ? { x: anyGateway.x, y: anyGateway.y } : null);
    if (bridge) {
      node.linkFrom = bridge;
      node.linkKind = 'ble';
    }
  });

  return { nodes, router: { ...routerPos, roomId: routerRoomId } };
}

function curvedPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const norm = Math.max(Math.hypot(dx, dy), 1);
  // Perpendicular bow, gentle
  const bow = Math.min(norm * 0.18, 46);
  const px = mx - (dy / norm) * bow;
  const py = my + (dx / norm) * bow;
  return `M ${from.x} ${from.y} Q ${px} ${py} ${to.x} ${to.y}`;
}


/* ── utility power lines (upper-right, wired into the house roof) ── */

const POWER_TOWER_H = 88;
const POWER_POLE_H = 72;

type PowerSupport = {
  x: number;
  y: number;
  scale: number;
  kind: 'lattice' | 'residential';
};

/** Clamp / insulator hang points — power on BOTH left and right arm tips. */
function powerClampPoints(tower: PowerSupport): {
  rightTop: { x: number; y: number };
  rightMid: { x: number; y: number };
  leftTop: { x: number; y: number };
  leftMid: { x: number; y: number };
  /** Lattice towers carry a third arm; wood poles do not. */
  rightLow: { x: number; y: number } | null;
} {
  const s = tower.scale;
  if (tower.kind === 'residential') {
    const h = POWER_POLE_H * s;
    const w = 20 * s;
    const hang = 2.6 * s;
    return {
      rightTop: { x: tower.x + w * 0.55, y: tower.y - h * 0.92 + hang },
      rightMid: { x: tower.x + w * 0.7, y: tower.y - h * 0.78 + hang },
      leftTop: { x: tower.x - w * 0.55, y: tower.y - h * 0.92 + hang },
      leftMid: { x: tower.x - w * 0.7, y: tower.y - h * 0.78 + hang },
      rightLow: null,
    };
  }
  const h = POWER_TOWER_H * s;
  const armTop = 38 * s;
  const armMid = 34 * s;
  const armLow = 28 * s;
  const hang = 3.2 * s;
  return {
    rightTop: { x: tower.x + armTop * 0.82, y: tower.y - h * 0.88 + hang },
    rightMid: { x: tower.x + armMid * 0.78, y: tower.y - h * 0.74 + hang },
    leftTop: { x: tower.x - armTop * 0.82, y: tower.y - h * 0.88 + hang },
    leftMid: { x: tower.x - armMid * 0.78, y: tower.y - h * 0.74 + hang },
    rightLow: { x: tower.x + armLow * 0.72, y: tower.y - h * 0.58 + hang },
  };
}

/** Residential wood distribution pole (feeds the house from the last span). */
function ResidentialPowerPole({ x, y, scale }: { x: number; y: number; scale: number }) {
  const h = POWER_POLE_H * scale;
  const w = 20 * scale;
  const s = scale;
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      <path d={`M0 0 V${-h}`} stroke="#475569" strokeWidth={2.4 * s} strokeLinecap="round" />
      <path d={`M${-w} ${-h * 0.78} H${w}`} stroke="#64748b" strokeWidth={1.9 * s} strokeLinecap="round" />
      <path d={`M${-w * 0.75} ${-h * 0.92} H${w * 0.75}`} stroke="#64748b" strokeWidth={1.6 * s} strokeLinecap="round" />
      {/* Brace */}
      <path d={`M0 ${-h * 0.7} L${-w * 0.55} ${-h * 0.78}`} stroke="#94a3b8" strokeWidth={1.1 * s} />
      <path d={`M0 ${-h * 0.7} L${w * 0.55} ${-h * 0.78}`} stroke="#94a3b8" strokeWidth={1.1 * s} />
      {/* Insulator clamps */}
      {[
        [-w * 0.7, -h * 0.78], [w * 0.7, -h * 0.78],
        [-w * 0.55, -h * 0.92], [w * 0.55, -h * 0.92],
      ].map(([cx, cy], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r={1.7 * s} fill="#94a3b8" />
          <path d={`M ${cx} ${cy} v ${2.6 * s}`} stroke="#64748b" strokeWidth={0.85 * s} strokeLinecap="round" />
          <circle cx={cx} cy={(cy as number) + 2.6 * s} r={1.1 * s} fill="#cbd5e1" />
        </g>
      ))}
      {/* Ground tip */}
      <path d={`M0 ${-h} v ${-3.5 * s}`} stroke="#475569" strokeWidth={1.4 * s} strokeLinecap="round" />
      <circle cx={0} cy={-h - 3.5 * s} r={1.3 * s} fill="#94a3b8" />
      {/* Footing */}
      <path d={`M ${-4 * s} 0 H ${4 * s}`} stroke="#1e293b" strokeWidth={2.2 * s} strokeLinecap="round" />
    </g>
  );
}

/** High-voltage lattice transmission tower. */
function PowerTower({ x, y, scale }: { x: number; y: number; scale: number }) {
  const h = POWER_TOWER_H * scale;
  const s = scale;
  const ink = '#334155';
  const mid = '#475569';
  const soft = '#64748b';
  // Base width → waist → top (hourglass lattice silhouette)
  const baseW = 22 * s;
  const waistW = 9 * s;
  const topW = 7 * s;
  const yBase = 0;
  const yWaist = -h * 0.42;
  const yArmsLow = -h * 0.58;
  const yArmsMid = -h * 0.74;
  const yArmsTop = -h * 0.88;
  const yPeak = -h;
  const armLow = 28 * s;
  const armMid = 34 * s;
  const armTop = 38 * s;

  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      {/* Main lattice legs */}
      <path
        d={`M ${-baseW} ${yBase} L ${-waistW} ${yWaist} L ${-topW} ${yArmsTop} L 0 ${yPeak} L ${topW} ${yArmsTop} L ${waistW} ${yWaist} L ${baseW} ${yBase}`}
        fill="none"
        stroke={ink}
        strokeWidth={1.7 * s}
        strokeLinejoin="round"
      />
      {/* Inner vertical spine */}
      <path d={`M 0 ${yBase} V ${yPeak}`} stroke={mid} strokeWidth={1.1 * s} opacity={0.85} />
      {/* Lattice X-bracing — lower bay */}
      <path d={`M ${-baseW * 0.72} ${-h * 0.08} L ${waistW * 0.55} ${yWaist + h * 0.06}`} stroke={soft} strokeWidth={0.9 * s} />
      <path d={`M ${baseW * 0.72} ${-h * 0.08} L ${-waistW * 0.55} ${yWaist + h * 0.06}`} stroke={soft} strokeWidth={0.9 * s} />
      <path d={`M ${-baseW * 0.55} ${-h * 0.2} L ${waistW * 0.35} ${yWaist}`} stroke={soft} strokeWidth={0.75 * s} opacity={0.9} />
      <path d={`M ${baseW * 0.55} ${-h * 0.2} L ${-waistW * 0.35} ${yWaist}`} stroke={soft} strokeWidth={0.75 * s} opacity={0.9} />
      {/* Lattice X-bracing — upper bay */}
      <path d={`M ${-waistW} ${yWaist} L ${topW * 0.8} ${yArmsMid}`} stroke={soft} strokeWidth={0.85 * s} />
      <path d={`M ${waistW} ${yWaist} L ${-topW * 0.8} ${yArmsMid}`} stroke={soft} strokeWidth={0.85 * s} />
      <path d={`M ${-topW * 1.1} ${yArmsMid} L ${topW} ${yArmsTop}`} stroke={soft} strokeWidth={0.75 * s} />
      <path d={`M ${topW * 1.1} ${yArmsMid} L ${-topW} ${yArmsTop}`} stroke={soft} strokeWidth={0.75 * s} />
      {/* Horizontal lattice rungs */}
      {[0.18, 0.3, 0.5, 0.66, 0.8].map((frac) => {
        const yy = -h * frac;
        const t = frac < 0.42 ? (frac / 0.42) : ((frac - 0.42) / 0.58);
        const half = frac < 0.42
          ? baseW + (waistW - baseW) * (frac / 0.42)
          : waistW + (topW - waistW) * ((frac - 0.42) / 0.58);
        return (
          <path
            key={frac}
            d={`M ${-half * 0.92} ${yy} H ${half * 0.92}`}
            stroke={soft}
            strokeWidth={0.7 * s}
            opacity={0.75 + t * 0.1}
          />
        );
      })}
      {/* Three conductor cross-arms (HV lattice style) */}
      <path d={`M ${-armLow} ${yArmsLow} H ${armLow}`} stroke={ink} strokeWidth={1.55 * s} strokeLinecap="round" />
      <path d={`M ${-armMid} ${yArmsMid} H ${armMid}`} stroke={ink} strokeWidth={1.65 * s} strokeLinecap="round" />
      <path d={`M ${-armTop} ${yArmsTop} H ${armTop}`} stroke={ink} strokeWidth={1.75 * s} strokeLinecap="round" />
      {/* Arm braces */}
      <path d={`M ${-topW} ${yArmsTop + 2 * s} L ${-armTop * 0.55} ${yArmsTop}`} stroke={mid} strokeWidth={0.8 * s} />
      <path d={`M ${topW} ${yArmsTop + 2 * s} L ${armTop * 0.55} ${yArmsTop}`} stroke={mid} strokeWidth={0.8 * s} />
      <path d={`M ${-waistW * 0.7} ${yArmsMid + 3 * s} L ${-armMid * 0.5} ${yArmsMid}`} stroke={mid} strokeWidth={0.75 * s} />
      <path d={`M ${waistW * 0.7} ${yArmsMid + 3 * s} L ${armMid * 0.5} ${yArmsMid}`} stroke={mid} strokeWidth={0.75 * s} />
      {/* Insulators */}
      {[
        [-armTop * 0.82, yArmsTop], [armTop * 0.82, yArmsTop],
        [-armMid * 0.78, yArmsMid], [armMid * 0.78, yArmsMid],
        [-armLow * 0.72, yArmsLow], [armLow * 0.72, yArmsLow],
      ].map(([cx, cy], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r={1.6 * s} fill="#94a3b8" />
          <path d={`M ${cx} ${cy} v ${3.2 * s}`} stroke="#64748b" strokeWidth={0.9 * s} strokeLinecap="round" />
          <circle cx={cx} cy={(cy as number) + 3.2 * s} r={1.15 * s} fill="#cbd5e1" />
        </g>
      ))}
      {/* Peak / ground-wire tip */}
      <path d={`M 0 ${yPeak} v ${-4 * s}`} stroke={ink} strokeWidth={1.3 * s} strokeLinecap="round" />
      <circle cx={0} cy={yPeak - 4 * s} r={1.4 * s} fill="#94a3b8" />
      {/* Concrete footing */}
      <path d={`M ${-baseW - 3 * s} ${yBase} H ${baseW + 3 * s}`} stroke="#1e293b" strokeWidth={2.4 * s} strokeLinecap="round" />
      <path d={`M ${-baseW * 0.55} ${yBase} L ${-baseW * 0.4} ${4 * s} H ${baseW * 0.4} L ${baseW * 0.55} ${yBase}`} fill="#94a3b8" opacity={0.35} />
    </g>
  );
}

/** Continuous slack path through a series of points (grid → house). */
function slackPolyline(points: Array<{ x: number; y: number } | null | undefined>, sagForIndex: (i: number) => number): string {
  const pts = points.filter((p): p is { x: number; y: number } =>
    !!p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (pts.length < 2) return '';
  const parts: string[] = [`M ${pts[0]!.x} ${pts[0]!.y}`];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const sag = sagForIndex(i);
    const mx = (a.x + b.x) / 2;
    const my = Math.max(a.y, b.y) + sag;
    parts.push(`Q ${mx} ${my} ${b.x} ${b.y}`);
  }
  return parts.join(' ');
}

function UtilityPowerLines({
  houseX,
  houseY,
  estimation,
  selected,
  onSelect,
  supports,
  attach,
}: {
  houseX: number;
  houseY: number;
  estimation: PropertyPowerEstimation;
  selected?: boolean;
  onSelect?: () => void;
  /** Override the pole/tower run — the cutaway needs grounded, taller supports. */
  supports?: PowerSupport[];
  /** Where the service drop lands on the building. */
  attach?: { x: number; y: number };
}) {
  const outage = estimation === 'power_outage_suspected' || estimation === 'power_outage_likely';
  const uncertain = estimation === 'power_uncertain';
  // Live / uncertain grid feed animates green (outage stays red).
  const lineColor = outage ? '#f43f5e' : uncertain ? '#4ade80' : '#16a34a';
  const label = outage ? 'outage' : 'power';

  // Near house: residential feed pole. Lattice towers taper back — kept inside the frame.
  const towers: PowerSupport[] = supports ?? [
    { x: houseX + 188, y: houseY + 28, scale: 1.28, kind: 'residential' },
    { x: houseX + 288, y: houseY + 6, scale: 1.06, kind: 'lattice' },
    { x: houseX + 370, y: houseY - 12, scale: 0.78, kind: 'lattice' },
    { x: houseX + 438, y: houseY - 28, scale: 0.5, kind: 'lattice' },
    { x: houseX + 492, y: houseY - 40, scale: 0.32, kind: 'lattice' },
  ];
  const roofAttach = attach ?? { x: houseX + 42, y: houseY - 58 };
  const clamps = towers.map(powerClampPoints);

  /*
   * Conductors run in SPANS between neighbouring supports, not as one polyline
   * threaded through the same-side clamp of every support.
   *
   * The old approach connected each pole's right-arm tip to the next pole's
   * right-arm tip. Because an arm tip sits to the side of its own pole, that
   * wire had to cross back over the pole body to reach the neighbour, so every
   * support had conductors cutting through its lattice — which is what read as
   * the lines tangling with each other. A span instead leaves the arm facing
   * its neighbour and lands on the arm facing back, so wire only ever occupies
   * the gap between supports.
   */
  const houseEnd = { x: roofAttach.x, y: roofAttach.y };
  // Far → near, since the run terminates at the house.
  const chain = clamps.slice().reverse();

  const spansFor = (level: 'Top' | 'Mid') => {
    const near = level === 'Top' ? 'leftTop' : 'leftMid';
    const far = level === 'Top' ? 'rightTop' : 'rightMid';
    const out: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];

    for (let i = 0; i < chain.length - 1; i += 1) {
      out.push([chain[i][near], chain[i + 1][far]]);
    }
    // Service drop from the last support to the weatherhead.
    out.push([chain[chain.length - 1][near], houseEnd]);
    return out;
  };

  /*
   * A short span leaving the farthest support toward the edge of the frame.
   * Conductors that simply stop at the last tower make the line look severed;
   * running them out of frame implies the grid continues, which is the point of
   * drawing the towers at all.
   */
  const farthest = chain[0];
  const offFrame = (from: { x: number; y: number }) => slackPolyline(
    [from, { x: from.x + 76, y: from.y - 10 }],
    () => 7,
  );

  const topSpans = spansFor('Top');
  const midSpans = spansFor('Mid');

  // The drop to the house hangs slacker than the pole-to-pole spans, the way a
  // service drop actually does.
  const spanPath = (
    spans: Array<[{ x: number; y: number }, { x: number; y: number }]>,
    base: number,
    dropSag: number,
  ) => spans
    .map(([a, b], i) => slackPolyline([a, b], () => (i === spans.length - 1 ? dropSag : base)))
    .join(' ');

  const rightTopPath = `${spanPath(topSpans, 11, 22)} ${offFrame(farthest.rightTop)}`;
  // The tower's third arm only ever carries line away from us — the tap to the
  // house comes off the upper two — so it just leaves frame.
  const rightMidPath = `${spanPath(midSpans, 9, 19)} ${offFrame(farthest.rightMid)}`
    + (farthest.rightLow ? ` ${offFrame(farthest.rightLow)}` : '');

  // Clear of the conductors and of the pole tops. Sitting it level with the
  // crossarms, as it used to, put the badge straight through the arm.
  const statusX = houseX + 104;
  const statusY = houseY - 168;

  return (
    <g
      aria-label={`${label}. Click for power status details.`}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
    >
      {/* Invisible hit target spanning the span of towers + house feed */}
      <rect
        x={houseX + 20}
        y={houseY - 150}
        width={520}
        height={220}
        fill="transparent"
        pointerEvents="all"
      />
      {/* Power on both arm sides — same dash cadence, no telecom clutter */}
      <g filter={selected ? 'url(#hy-power-selected-glow)' : undefined}>
        <path
          d={rightTopPath}
          fill="none"
          stroke={lineColor}
          strokeWidth={selected ? 2.55 : 1.85}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.95}
          className={outage ? undefined : 'hy-power-dash'}
          strokeDasharray={outage ? '3 7' : '6 8'}
          pointerEvents="none"
        />
        <path
          d={rightMidPath}
          fill="none"
          stroke={lineColor}
          strokeWidth={selected ? 1.75 : 1.45}
          strokeLinecap="round"
          opacity={0.8}
          className={outage ? undefined : 'hy-power-dash'}
          strokeDasharray={outage ? '3 7' : '6 8'}
          pointerEvents="none"
        />
      </g>
      {towers.map((tower) => (
        tower.kind === 'residential' ? (
          <ResidentialPowerPole key={`${tower.x}-${tower.y}`} x={tower.x} y={tower.y} scale={tower.scale} />
        ) : (
          <PowerTower key={`${tower.x}-${tower.y}`} x={tower.x} y={tower.y} scale={tower.scale} />
        )
      ))}
      <path
        d={`M ${roofAttach.x - 2} ${roofAttach.y} V ${roofAttach.y + 18}`}
        stroke="#475569"
        strokeWidth={2}
        strokeLinecap="round"
        pointerEvents="none"
      />
      <circle cx={roofAttach.x - 2} cy={roofAttach.y} r={2.4} fill="#94a3b8" stroke="#475569" strokeWidth={1} pointerEvents="none" />
      {/* Compact power mark — soft halo when selected */}
      <g transform={`translate(${statusX} ${statusY})`} pointerEvents="none">
        {selected && (
          <ellipse
            cx={18}
            cy={0}
            rx={34}
            ry={12}
            fill={outage ? 'rgba(244,63,94,0.12)' : 'rgba(22,163,74,0.12)'}
          />
        )}
        <PowerConfirmationBadge estimation={estimation} x={0} y={0} />
        <text
          x={16}
          y={0}
          dominantBaseline="central"
          fontSize={17}
          fontWeight={800}
          fill={outage ? '#be123c' : '#166534'}
        >
          {label}
        </text>
      </g>
    </g>
  );
}

/* ── product-accurate hardware glyphs (Shelly kit reference) ─────── */

/**
 * Shelly Flood / leak sensor — ivory rippled square puck with the twisted
 * black-and-white leak-detection rope exiting the side (matches both product
 * photos: the rippled Gen4 puck and the rope-probe leak cable).
 */
function FloodGlyph({ pulsing }: { pulsing?: boolean }) {
  const stroke = '#2563eb';
  const soft = '#60a5fa';
  return (
    <g>
      {/* twisted black/white leak rope, coiled to the right of the puck */}
      <path
        d="M18 4 C24 6 26 12 21 15 C15 18 12 11 18 9 C24 7 28 12 26 16"
        fill="none"
        stroke="#1e293b"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <path
        d="M18 4 C24 6 26 12 21 15 C15 18 12 11 18 9 C24 7 28 12 26 16"
        fill="none"
        stroke="#f8fafc"
        strokeWidth={1.2}
        strokeDasharray="1.6 2"
        strokeLinecap="round"
      />
      <rect x={24} y={15} width={7} height={5} rx={2} fill="#f8fafc" stroke="#64748b" strokeWidth={1} />
      {/* ivory puck with concentric ripple ridges */}
      <rect x={-22} y={-20} width={40} height={40} rx={11} fill="#faf9f6" stroke={stroke} strokeWidth={2.2} />
      {[16, 12, 8].map((r, i) => (
        <rect key={r} x={-2 - r} y={-r} width={r * 2} height={r * 2} rx={r * 0.5} fill="none" stroke="#e7e5e4" strokeWidth={1.1}>
          {pulsing && (
            <animate attributeName="opacity" values="0.3;0.9;0.3" dur={`${1.3 + i * 0.25}s`} repeatCount="indefinite" />
          )}
        </rect>
      ))}
      {/* raised center pill: LED button on top, Shelly mark below */}
      <ellipse cx={-2} cy={0} rx={6} ry={9.5} fill="#f5f5f4" stroke="#d6d3d1" strokeWidth={1.3} />
      <circle cx={-2} cy={-4} r={2.6} fill="#ffffff" stroke={soft} strokeWidth={1.3} />
      <circle cx={-2} cy={4.5} r={2.3} fill="none" stroke="#a8a29e" strokeWidth={0.9} />
      <text x={-2} y={5.8} textAnchor="middle" fontSize={4} fontWeight={800} fill="#a8a29e">S</text>
      {pulsing && (
        <circle cx={-2} cy={0} r={22} fill="none" stroke="#f43f5e" strokeWidth={1.6} opacity={0.5}>
          <animate attributeName="r" values="14;26" dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.6;0" dur="1.8s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

/**
 * Shelly BLU H&T — compact white square puck with a segment display showing
 * temperature and humidity (no probe rope; that belongs to the leak sensor).
 */
function HtGlyph({ device }: { device?: ShellyDevice }) {
  const stroke = '#2563eb';
  const tempLabel = device?.temperatureF != null
    ? `${Math.round(device.temperatureF)}°`
    : device?.temperature != null
      ? `${Math.round((device.temperature * 9) / 5 + 32)}°`
      : '--';
  const rhLabel = device?.humidity != null ? `${Math.round(device.humidity)}%` : '--';
  return (
    <g>
      <rect x={-17} y={-17} width={34} height={34} rx={9} fill="#ffffff" stroke={stroke} strokeWidth={2.1} />
      {/* segment LCD */}
      <rect x={-11} y={-11} width={22} height={14} rx={2.5} fill="#eef2f7" stroke="#cbd5e1" strokeWidth={1} />
      <text x={0} y={-3.6} textAnchor="middle" fontSize={7.5} fontWeight={800} fill="#334155" fontFamily="ui-monospace, monospace">{tempLabel}</text>
      <text x={0} y={1.8} textAnchor="middle" fontSize={5} fontWeight={700} fill="#64748b" fontFamily="ui-monospace, monospace">{rhLabel}</text>
      {/* humidity vent slots */}
      <path d="M-8 8 h16 M-8 11 h16" stroke="#e2e8f0" strokeWidth={1.4} strokeLinecap="round" />
      {/* Shelly mark + BLE tick */}
      <circle cx={11} cy={11} r={2.6} fill="none" stroke="#cbd5e1" strokeWidth={0.9} />
      <text x={11} y={12.4} textAnchor="middle" fontSize={3.6} fontWeight={800} fill="#94a3b8">S</text>
      <circle cx={-11} cy={11} r={1.5} fill="#22d3ee">
        <animate attributeName="opacity" values="1;0.25;1" dur="2.2s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}

/** Shelly BLU Gateway — compact USB dongle with BLE arcs */
function GatewayGlyph() {
  const stroke = '#2563eb';
  const soft = '#60a5fa';
  return (
    <g>
      <rect x={-11} y={-18} width={22} height={34} rx={5.5} fill="#f8fafc" stroke={stroke} strokeWidth={2} />
      <circle cx={0} cy={-6} r={3.2} fill="none" stroke="#cbd5e1" strokeWidth={1.1} />
      <text x={0} y={-4.2} textAnchor="middle" fontSize={4.5} fontWeight={800} fill="#94a3b8">S</text>
      <rect x={-6} y={2} width={12} height={8} rx={2} fill="#eff6ff" stroke={soft} strokeWidth={1.2} />
      <path d="M-18 -4c-4 2.5-4 9 0 11.5M18 -4c4 2.5 4 9 0 11.5" fill="none" stroke="#0ea5e9" strokeWidth={1.6} strokeLinecap="round" />
      <circle cx={0} cy={10} r={2} fill="#22d3ee">
        <animate attributeName="opacity" values="1;0.2;1" dur="2s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}

/** Travel router hub — HouseYield branded GL.iNet Slate-style form factor (3/4 view) */
function GlinetRouterGlyph() {
  const ink = '#2563eb';
  return (
    <g>
      {/* paddle antennas hinged at the rear corners */}
      <g transform="rotate(-8 -34 -18)">
        <rect x={-40} y={-56} width={12} height={40} rx={6} fill="#ffffff" stroke={ink} strokeWidth={2} />
        <path d="M-34 -50 v26" stroke="#e2e8f0" strokeWidth={2} strokeLinecap="round" />
      </g>
      <g transform="rotate(8 34 -18)">
        <rect x={28} y={-56} width={12} height={40} rx={6} fill="#ffffff" stroke={ink} strokeWidth={2} />
        <path d="M34 -50 v26" stroke="#e2e8f0" strokeWidth={2} strokeLinecap="round" />
      </g>
      {/* antenna hinges */}
      <rect x={-40} y={-22} width={10} height={8} rx={3} fill="#e2e8f0" stroke={ink} strokeWidth={1.4} />
      <rect x={30} y={-22} width={10} height={8} rx={3} fill="#e2e8f0" stroke={ink} strokeWidth={1.4} />
      {/* Closed rounded body — no overshooting top plate */}
      <rect x={-46} y={-18} width={92} height={38} rx={12} fill="#ffffff" stroke={ink} strokeWidth={2.4} />
      {/* Inset top lip stays inside the rounded corners */}
      <path
        d="
          M -34 -15
          H 34
          Q 42 -15 42 -8
          H -42
          Q -42 -15 -34 -15
          Z
        "
        fill="#f1f5f9"
      />
      <text x={0} y={-10} textAnchor="middle" fontSize={5.5} fontWeight={700} fill="#94a3b8" letterSpacing={0.4}>HouseYield</text>
      {/* Soft seam under the lip */}
      <path d="M-38 -5 H38" stroke="#e2e8f0" strokeWidth={1.2} strokeLinecap="round" />
      {/* diagonal vent slats (left end, like the Slate's grille) */}
      {[-8, -3, 2, 7, 12].map((y) => (
        <path key={y} d={`M-40 ${y + 2} l 9 -7`} stroke="#cbd5e1" strokeWidth={2} strokeLinecap="round" />
      ))}
      {/* MODE switch in the vent area */}
      <rect x={-30} y={11} width={9} height={4} rx={2} fill="#e2e8f0" stroke="#94a3b8" strokeWidth={0.8} />
      <circle cx={-27.5} cy={13} r={1.4} fill="#94a3b8" />
      {/* recessed port strip: WAN + 2x LAN + USB + USB-C */}
      <rect x={-14} y={4} width={54} height={14} rx={4} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={1} />
      {[-9, 1, 11].map((x) => (
        <g key={x}>
          <rect x={x} y={7} width={8} height={8} rx={1} fill="#e2e8f0" stroke="#64748b" strokeWidth={0.9} />
          <path d={`M${x + 2} 7 v-1.5 h4 v1.5`} stroke="#64748b" strokeWidth={0.8} fill="none" />
        </g>
      ))}
      <rect x={23} y={7} width={4.5} height={8} rx={1} fill="#dbeafe" stroke="#64748b" strokeWidth={0.9} />
      <rect x={31} y={9} width={6} height={4} rx={2} fill="#e2e8f0" stroke="#64748b" strokeWidth={0.9} />
      {/* status LEDs across the front lip */}
      <circle cx={-2} cy={-1} r={2} fill="#22d3ee">
        <animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite" />
      </circle>
      <circle cx={6} cy={-1} r={2} fill="#60a5fa" />
      <circle cx={14} cy={-1} r={2} fill="#93c5fd" />
    </g>
  );
}

function NodeGlyph({ kind, device, alerts = [] }: { kind: TopologyDeviceKind; device?: ShellyDevice; alerts?: ShellyAlert[] }) {
  if (kind === 'flood') return <FloodGlyph pulsing={device ? hasActiveFloodWarning(device, alerts) : false} />;
  if (kind === 'ht') return <HtGlyph device={device} />;
  if (kind === 'gateway') return <GatewayGlyph />;
  if (kind === 'relay') {
    return (
      <g>
        <path d="M-24 10h48" stroke="#b45309" strokeWidth={8} strokeLinecap="round" />
        <rect x={-10} y={4} width={20} height={12} rx={4} fill="#d97706" stroke="#92400e" strokeWidth={1.6} />
        <rect x={-14} y={-16} width={28} height={18} rx={5} fill="#bae6fd" stroke="#0369a1" strokeWidth={1.8} />
        <path d="M4 -8 h 10" stroke="#dc2626" strokeWidth={3} strokeLinecap="round" />
      </g>
    );
  }
  const stroke = '#2563eb';
  const soft = '#60a5fa';
  return (
    <g>
      <rect x={-19} y={-13} width={38} height={26} rx={7} fill="#dbeafe" stroke={stroke} strokeWidth={2.2} />
      <circle cx={-8} cy={0} r={3} fill="#38bdf8" />
      <circle cx={0} cy={0} r={3} fill={soft} />
      <circle cx={8} cy={0} r={3} fill="#93c5fd" />
    </g>
  );
}

/** Online check / offline X + mini signal bars beside each device node. */
function ConnectivityBadge({
  tone,
  x = 34,
  y = -34,
}: {
  tone: NodeTone;
  x?: number;
  y?: number;
}) {
  const online = tone === 'healthy' || tone === 'attention' || tone === 'critical';
  const sleeping = tone === 'sleeping';
  const badgeFill = online ? '#16a34a' : sleeping ? '#d97706' : '#94a3b8';
  const barFill = online ? '#16a34a' : sleeping ? '#f59e0b' : '#cbd5e1';
  const bars = online ? [5, 8, 12] : sleeping ? [5, 8, 4] : [4, 4, 4];

  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none" aria-label={online ? 'Online' : sleeping ? 'Sleeping' : 'Offline'}>
      {/* Signal bars */}
      <g transform="translate(12 -1)">
        {bars.map((h, i) => (
          <rect
            key={i}
            x={i * 5}
            y={12 - h}
            width={3.2}
            height={h}
            rx={1}
            fill={barFill}
            opacity={online ? 0.55 + i * 0.2 : sleeping && i < 2 ? 0.7 : 0.35}
          />
        ))}
        {!online && !sleeping && (
          <path d="M1 2 L13 14 M13 2 L1 14" stroke="#94a3b8" strokeWidth={1.6} strokeLinecap="round" />
        )}
      </g>
      {/* Status circle */}
      <circle r={10} fill={badgeFill} stroke="#ffffff" strokeWidth={2} />
      {online ? (
        <path d="M-4 0.5 L-1.3 3.2 L4.2 -3" fill="none" stroke="#ffffff" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" />
      ) : sleeping ? (
        <path d="M1.8 -3.8 A5 5 0 1 0 1.8 3.8 A3.8 3.8 0 0 1 1.8 -3.8 Z" fill="#ffffff" opacity={0.95} />
      ) : (
        <path d="M-3.4 -3.4 L3.4 3.4 M3.4 -3.4 L-3.4 3.4" stroke="#ffffff" strokeWidth={2.1} strokeLinecap="round" />
      )}
    </g>
  );
}

/** Standalone yellow bolt when power is on; red dash mark when out. */
function PowerConfirmationBadge({
  estimation,
  x = 0,
  y = 0,
}: {
  estimation: PropertyPowerEstimation;
  x?: number;
  y?: number;
}) {
  const outage = estimation === 'power_outage_suspected' || estimation === 'power_outage_likely';

  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none" aria-label={outage ? 'outage' : 'power'}>
      {outage ? (
        <g>
          <circle r={8.5} fill="none" stroke="#e11d48" strokeWidth={2.2} />
          <path d="M-4.2 0 H4.2" stroke="#e11d48" strokeWidth={2.6} strokeLinecap="round" />
        </g>
      ) : (
        <path
          d="M2.6 -8.2 L-4.4 1 H0.7 L-2.6 8.2 L4.9 -0.7 H0.9 Z"
          fill="#eab308"
          stroke="#ca8a04"
          strokeWidth={0.7}
          strokeLinejoin="round"
        />
      )}
    </g>
  );
}

function hazardShortLabel(hazard: WeatherHazard | null | undefined): string {
  if (!hazard) return 'Outdoor';
  const map: Record<WeatherHazard, string> = {
    heat: 'Heat',
    cold: 'Cold',
    high_wind: 'High wind',
    heavy_rain: 'Heavy rain',
    flood: 'Flood watch',
    thunderstorm: 'Storm',
    winter_storm: 'Winter storm',
    humidity_spike: 'Humidity',
  };
  return map[hazard] || 'Outdoor';
}

function weatherRiskColor(risk: WeatherOverallRisk | undefined | null): string {
  const tone = weatherRiskTone(risk);
  return TONE_COLOR[tone];
}

/**
 * Observed conditions → what the cutaway should draw falling out of the sky.
 *
 * Reads the condition code first and the measured accumulation second, in that
 * order deliberately. OpenWeather's current-conditions endpoint frequently
 * reports `rain` absent even while the code says it is raining, because the
 * `1h`/`3h` accumulation buckets are only populated by some stations. Trusting
 * the number alone would leave the house dry in a downpour; trusting the code
 * alone would lose the difference between a shower and a deluge. Using the code
 * for the category and the accumulation to push the intensity up gets both.
 */
function liveWeatherFrom(current: WeatherSample | null | undefined): LiveWeather {
  const dry: LiveWeather = { kind: 'none', intensity: 0, windMph: current?.windMph ?? null };
  if (!current) return dry;

  const id = current.weatherId ?? null;
  const group = id == null ? null : Math.floor(id / 100);
  const precip = Number.isFinite(current.precipIn) ? Math.max(0, Number(current.precipIn)) : 0;

  let kind: LiveWeather['kind'];
  let base: number;
  if (group === 2) {
    kind = 'storm';
    base = 0.72;
  } else if (group === 3) {
    kind = 'drizzle';
    base = 0.22;
  } else if (group === 6) {
    kind = 'snow';
    base = 0.45;
  } else if (group === 5) {
    // 500/520 light · 501/521 moderate · 502+/522/531 heavy or worse.
    const sub = id == null ? 1 : id % 100;
    const heavy = sub >= 2 && sub <= 4;
    kind = heavy ? 'heavy' : 'rain';
    base = heavy ? 0.8 : sub === 1 || sub === 21 ? 0.5 : 0.32;
  } else if (precip > 0.01) {
    kind = precip >= 0.25 ? 'heavy' : 'rain';
    base = precip >= 0.25 ? 0.75 : 0.4;
  } else {
    return dry;
  }

  // A measured rate can only argue the storm is *worse* than its code implies.
  const fromRate = Math.min(1, precip / 0.4);
  return {
    kind,
    intensity: Math.max(0.15, Math.min(1, Math.max(base, fromRate))),
    windMph: current.windMph ?? null,
  };
}

/** A simulated storm, expressed the same way, so the house responds to it too. */
function scenarioWeather(rainInches: number | null): LiveWeather {
  if (rainInches == null || rainInches <= 0) return { kind: 'none', intensity: 0 };
  // Design storms are 24-hour totals; anything at or above ~3" is a downpour
  // for as long as anyone is looking at this drawing.
  const intensity = Math.max(0.25, Math.min(1, rainInches / 3.5));
  return { kind: rainInches >= 2 ? 'heavy' : 'rain', intensity, windMph: rainInches >= 3 ? 22 : 9 };
}

/** Outdoor weather glyph — upper-left mirror of the utility power overlay. */
function OutdoorWeatherNode({
  houseX,
  houseY,
  assessment,
  loading,
  selected,
  onSelect,
}: {
  houseX: number;
  houseY: number;
  assessment: ExtremeWeatherAssessment | null;
  loading?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const risk = assessment?.overallRisk || 'none';
  const tone = weatherRiskTone(risk);
  const color = TONE_COLOR[tone];
  const label = loading && !assessment ? '…' : weatherRiskLabel(risk);
  const cx = houseX - 220;
  const cy = houseY - 8;
  const stormy = risk === 'high' || risk === 'critical'
    || assessment?.mostUrgentHazard === 'thunderstorm'
    || assessment?.mostUrgentHazard === 'heavy_rain'
    || assessment?.mostUrgentHazard === 'flood';

  return (
    <g
      aria-label={`Outdoor weather ${label}. Click for weather risk details.`}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
    >
      <rect x={cx - 70} y={cy - 48} width={150} height={96} fill="transparent" pointerEvents="all" />
      {selected && (
        <ellipse cx={cx} cy={cy} rx={58} ry={42} fill={`${color}18`} pointerEvents="none" />
      )}
      {(tone === 'attention' || tone === 'critical') && (
        <circle cx={cx} cy={cy} r={36} fill="none" stroke={color} strokeWidth={1.6} pointerEvents="none">
          <animate attributeName="r" values="36;48" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.55;0" dur="2.4s" repeatCount="indefinite" />
        </circle>
      )}
      <circle
        cx={cx}
        cy={cy}
        r={34}
        fill="#ffffff"
        stroke={selected ? '#2563eb' : color}
        strokeWidth={selected ? 3.2 : 2.4}
        pointerEvents="none"
      />
      {/* Cloud / wind glyph */}
      <g transform={`translate(${cx - 16} ${cy - 10})`} pointerEvents="none">
        <ellipse cx={10} cy={10} rx={14} ry={9} fill={stormy ? '#94a3b8' : '#cbd5e1'} />
        <ellipse cx={20} cy={12} rx={11} ry={8} fill={stormy ? '#64748b' : '#e2e8f0'} />
        <ellipse cx={4} cy={13} rx={8} ry={6} fill={stormy ? '#94a3b8' : '#cbd5e1'} />
        {stormy ? (
          <>
            <path d="M6 22 L4 30" stroke="#38bdf8" strokeWidth={2} strokeLinecap="round" />
            <path d="M14 22 L12 31" stroke="#0ea5e9" strokeWidth={2} strokeLinecap="round" />
            <path d="M22 22 L21 29" stroke="#38bdf8" strokeWidth={2} strokeLinecap="round" />
          </>
        ) : (
          <path d="M28 8 Q36 12 28 16" fill="none" stroke="#64748b" strokeWidth={1.8} strokeLinecap="round" opacity={0.75} />
        )}
      </g>
      <text
        x={cx}
        y={cy + 52}
        textAnchor="middle"
        fontSize={15}
        fontWeight={800}
        fill={color}
        stroke="#f8fafc"
        strokeWidth={4}
        paintOrder="stroke"
        pointerEvents="none"
      >
        {label}
      </text>
      <text
        x={cx}
        y={cy + 70}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill="#64748b"
        stroke="#f8fafc"
        strokeWidth={3}
        paintOrder="stroke"
        pointerEvents="none"
      >
        {assessment?.current?.tempF != null
          ? `${Math.round(assessment.current.tempF)}°F · ${hazardShortLabel(assessment.mostUrgentHazard)}`
          : 'Outdoor risk'}
      </text>
    </g>
  );
}

/* ── link with traveling pulse ──────────────────────────────────── */

type LinkActuation = 'opening' | 'closing' | 'closed';

function TopologyLink({
  id,
  from,
  to,
  tone,
  linkKind,
  reverse,
  actuation,
  muted,
}: {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  tone: NodeTone;
  linkKind: 'wifi' | 'ble';
  reverse?: boolean;
  /** Valve travel: calm protective command, not an emergency race. */
  actuation?: LinkActuation | null;
  /**
   * Whether this link is one the viewer is currently interested in.
   *
   * Every device draws a curve back to its hub, so a normally-equipped house
   * throws eight or nine animated dashed arcs across the section at once. They
   * all crossed the rooms, they all moved, and none of them was answering a
   * question anybody had asked — the connectivity of a healthy device is
   * exactly the thing you do not need to look at. Muted links stay legible as
   * structure but stop competing: no animation, thin, and well back in the
   * value range. Anything actually worth attention — selected, hovered,
   * alerting, or mid-actuation — comes forward at full strength.
   */
  muted?: boolean;
}) {
  const online = tone !== 'offline' && tone !== 'unknown';
  const alerting = !actuation && (tone === 'critical' || tone === 'attention');
  const alertColor = tone === 'critical' ? '#f43f5e' : '#f59e0b';
  // An alert or an actuation always speaks up, whatever the caller asked for.
  const quiet = muted && !alerting && !actuation;

  // Protective action palette — sky open, amber close (not alarm red).
  const actuationColor = actuation === 'opening'
    ? '#0ea5e9'
    : actuation === 'closing'
      ? '#d97706'
      : actuation === 'closed'
        ? '#e11d48'
        : null;

  const d = reverse ? curvedPath(to, from) : curvedPath(from, to);
  const end = reverse ? from : to;
  const color = actuationColor
    || (alerting ? alertColor : linkKind === 'ble' ? '#3b82f6' : '#0ea5e9');
  const dur = `${(2.6 + (id.length % 4) * 0.45).toFixed(2)}s`;
  const alertDur = tone === 'critical' ? '0.9s' : '1.4s';
  const travelDur = '2.8s';
  const traveling = actuation === 'opening' || actuation === 'closing';
  const settledClosed = actuation === 'closed';

  return (
    <g>
      <path
        id={id}
        d={d}
        fill="none"
        stroke={online || actuation ? color : '#cbd5e1'}
        strokeWidth={quiet ? 1.1 : alerting || traveling || settledClosed ? 2.2 : 1.8}
        strokeDasharray={
          settledClosed
            ? '3 5'
            : linkKind === 'ble' ? '2 7' : '5 7'
        }
        strokeLinecap="round"
        opacity={quiet ? 0.26 : settledClosed ? 0.9 : online || actuation ? 0.85 : 0.55}
        className={
          quiet || settledClosed
            ? undefined
            : (online || traveling) ? (traveling ? 'hy-valve-dash' : 'hy-link-dash') : undefined
        }
      />

      {/* Valve closing — single calm amber packet (protective action) */}
      {actuation === 'closing' && (
        <circle r={4.2} fill="#f59e0b" stroke="#ffffff" strokeWidth={1.4}>
          <animateMotion dur={travelDur} repeatCount="indefinite" rotate="auto">
            <mpath href={`#${id}`} />
          </animateMotion>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur={travelDur} repeatCount="indefinite" />
        </circle>
      )}

      {/* Valve closed: quiet parked marker at the valve end */}
      {settledClosed && (
        <>
          <path d={d} fill="none" stroke="#e11d48" strokeWidth={4} strokeLinecap="round" opacity={0.16} />
          <circle cx={end.x} cy={end.y} r={4} fill="#f43f5e" stroke="#fff" strokeWidth={1.2} opacity={0.9} />
        </>
      )}

      {/* Valve opening — single calm sky packet */}
      {actuation === 'opening' && (
        <circle r={4.2} fill="#38bdf8" stroke="#ffffff" strokeWidth={1.4}>
          <animateMotion dur={travelDur} repeatCount="indefinite" rotate="auto">
            <mpath href={`#${id}`} />
          </animateMotion>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur={travelDur} repeatCount="indefinite" />
        </circle>
      )}

      {alerting && (
        <>
          <path
            d={d}
            fill="none"
            stroke={alertColor}
            strokeWidth={6}
            strokeLinecap="round"
            opacity={0.25}
          >
            <animate attributeName="opacity" values="0.05;0.4;0.05" dur={alertDur} repeatCount="indefinite" />
          </path>
          <circle r={5} fill={alertColor} stroke="#ffffff" strokeWidth={1.4}>
            <animateMotion dur={alertDur} repeatCount="indefinite" rotate="auto">
              <mpath href={`#${id}`} />
            </animateMotion>
            <animate attributeName="opacity" values="1;0.9;0" keyTimes="0;0.7;1" dur={alertDur} repeatCount="indefinite" />
          </circle>
        </>
      )}
      {online && !alerting && !actuation && (
        <circle r={3.4} fill="#67e8f9" stroke={color} strokeWidth={1}>
          <animateMotion dur={dur} repeatCount="indefinite" rotate="auto">
            <mpath href={`#${id}`} />
          </animateMotion>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur={dur} repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

/* ── ball valve assembly ────────────────────────────────────────── */

function ValveAssembly({
  device,
  pending,
  onCommand,
  selected,
  onSelect,
  center = VALVE,
  scale = 1,
  linkFrom,
}: {
  device: ShellyDevice;
  pending: boolean;
  onCommand?: (device: ShellyDevice, action: 'open' | 'close') => void;
  selected: boolean;
  onSelect: () => void;
  /** Where the valve should sit on the canvas. */
  center?: { x: number; y: number };
  scale?: number;
  /** Hub end of the control link, drawn outside the scaled group. */
  linkFrom?: { x: number; y: number };
}) {
  const motion = useValveMotion(device);
  const closed = motion.openness <= 0.01;
  const unknown = motion.state === 'unknown';
  const closingFraction = 1 - motion.openness;
  // The assembly is drawn in its own local frame around (cx, cy); this
  // transform maps that frame onto `center` at `scale` so the intricate
  // linkage geometry below never has to know where it ended up on the canvas.
  const cx = VALVE.x;
  const cy = VALVE.y;
  const tx = center.x - scale * cx;
  const ty = center.y - scale * cy;
  const toParent = (p: { x: number; y: number }) => ({ x: tx + scale * p.x, y: ty + scale * p.y });
  const tone = deviceTone(device, []);
  const offline = device.status === 'offline' || device.status === 'unknown';
  const alreadyOpen = motion.state === 'open';
  const alreadyClosed = motion.state === 'closed';
  const openBlocked = pending || offline || alreadyOpen;
  const closeBlocked = pending || offline || alreadyClosed;
  const linkActuation: LinkActuation | null =
    device.status === 'online' && (motion.state === 'opening' || motion.state === 'closing' || motion.state === 'closed')
      ? motion.state
      : null;

  /*
   * One rigid rotating group — exactly like the real Bulldog: the motor spins
   * the black actuator arm, whose fork straddles the red valve handle. Arm,
   * fork, and handle are drawn in the SAME group rotating about the stem, so
   * they stay mechanically connected through the whole 90° stroke.
   * Open = handle along the pipe (0°); closed = handle across the pipe (90°,
   * swinging down IN FRONT of the pipe where it stays fully visible).
   */
  const boreAngle = 90 * closingFraction;
  const pivot = { x: cx, y: cy - 40 };

  // Bulldog motor: set back upstream, sitting closer to the pipe (photo proportions).
  const motorL = cx - 114;
  const motorR = cx + 20;
  const motorTop = cy - 154;
  const motorBot = cy - 86;

  /*
   * 3D Bulldog linkage. Stem is vertical, so closing swings the handle out of
   * the pipe plane TOWARD the viewer. Arm and handle share the SAME swing
   * vector so they stay parallel — handle sits a fixed offset below the arm
   * with no growing gap. Depth is mild (mostly foreshortening); the two fork
   * pins stay vertical and straddle the handle near its tip.
   */
  const swing = (Math.PI / 2) * closingFraction;
  const cosA = Math.cos(swing);
  const sinA = Math.sin(swing);
  const FORESHORT = 0.55;
  const HANDLE_LEN = 66;
  const HANDLE_H = 10;
  const CLAMP_AT = 56; // pin cage near the handle tip
  const PIN_SPREAD = 9;
  // Mild depth: foreshorten toward camera without hinging the handle downward.
  const EZX = 0.24;
  const EZY = 0.18;
  const NEAR = 1 + 0.35 * sinA;
  const armPlateY = pivot.y - 14;
  const dirX = cosA + sinA * EZX;
  const dirY = sinA * EZY;

  const handleTip = { x: pivot.x + HANDLE_LEN * dirX, y: pivot.y + HANDLE_LEN * dirY };
  const clampPt = { x: pivot.x + CLAMP_AT * dirX, y: armPlateY + CLAMP_AT * dirY };
  // Sideways offset — pins straddle the handle.
  const SIDE_EZX = 0.16;
  const SIDE_EZY = 0.22;
  const sideOff = (s: number) => ({
    dx: s * (-sinA + cosA * SIDE_EZX),
    dy: s * cosA * SIDE_EZY,
  });
  const sideF = sideOff(PIN_SPREAD);
  const sideR = sideOff(-PIN_SPREAD);
  const pinTopF = { x: clampPt.x + sideF.dx, y: clampPt.y + sideF.dy + 2 };
  const pinTopR = { x: clampPt.x + sideR.dx, y: clampPt.y + sideR.dy + 2 };
  // Pins span the fixed vertical gap between arm and handle.
  const PIN_LEN = (pivot.y - armPlateY) + HANDLE_H / 2 + 2;
  const handleW = HANDLE_H * (0.95 + 0.25 * sinA);
  const footC = {
    x: (pinTopF.x + pinTopR.x) / 2,
    y: (pinTopF.y + pinTopR.y) / 2 + PIN_LEN,
  };
  const footR = Math.max(Math.abs(pinTopR.x - pinTopF.x) / 2 + 6.5, 9);
  const crossbarY = clampPt.y; // arm tip = clamp point (shared path)

  // Water: fill level, wave amplitude and slide speed all track openness.
  // Flow direction is left → right (supply on the left).
  const flow = motion.openness;
  const PIPE_R = 10; // interior half-height
  const waveSpeed = Math.max(0.7, 3.4 - flow * 2.6);
  const surfaceUp = cy - PIPE_R + 3.5;
  const surfaceDown = cy + PIPE_R - (PIPE_R * 2 - 3.5) * flow;
  const downAmp = 1 + 2.2 * flow + 3 * flow * (1 - flow);

  /** Water body with an undulating sine top surface; loops seamlessly every 44px. */
  const waterBody = (x0: number, x1: number, surfaceY: number, amp: number) => {
    const period = 44;
    const start = x0 - period * 2;
    const spans = Math.ceil((x1 - start + period) / period);
    let d = `M ${start} ${surfaceY}`;
    for (let i = 0; i < spans; i += 1) {
      d += ` q ${period / 4} ${-amp} ${period / 2} 0 q ${period / 4} ${amp} ${period / 2} 0`;
    }
    d += ` V ${cy + PIPE_R} H ${start} Z`;
    return d;
  };

  return (
    <g>
      {linkFrom && (
        <TopologyLink
          id="hy-link-valve"
          from={linkFrom}
          to={toParent({ x: (motorL + motorR) / 2, y: motorTop - 1 })}
          tone={tone}
          linkKind="wifi"
          actuation={linkActuation}
          // Quiet like every other link until it has something to say. An
          // actuation or an alert overrides this inside TopologyLink, which is
          // the only time the valve's connectivity is the story.
          muted={!selected}
        />
      )}

      <g transform={`translate(${tx} ${ty}) scale(${scale})`} style={{ cursor: 'pointer' }} onClick={onSelect}>
      <defs>
        <clipPath id="hy-clip-water-up">
          <rect x={cx - 176} y={cy - PIPE_R} width={112} height={PIPE_R * 2} rx={5} />
        </clipPath>
        <clipPath id="hy-clip-water-down">
          <rect x={cx + 64} y={cy - PIPE_R} width={112} height={PIPE_R * 2} rx={5} />
        </clipPath>
      </defs>

      {selected && (
        <ellipse cx={cx} cy={cy - 60} rx={330} ry={160} fill="rgba(59,130,246,0.05)" />
      )}

      {/* ── copper pipe shell — butts into the valve flanges (no white gap) ── */}
      <ellipse cx={cx - 180} cy={cy} rx={8} ry={15} fill="#8a4a16" stroke="#5b2d0c" strokeWidth={1.5} />
      <ellipse cx={cx + 180} cy={cy} rx={8} ry={15} fill="#8a4a16" stroke="#5b2d0c" strokeWidth={1.5} />
      <rect x={cx - 180} y={cy - 15} width={118} height={30} fill="url(#hy-pipe-copper)" stroke="#5b2d0c" strokeWidth={1.4} />
      <rect x={cx + 62} y={cy - 15} width={118} height={30} fill="url(#hy-pipe-copper)" stroke="#5b2d0c" strokeWidth={1.4} />
      <path d={`M ${cx - 174} ${cy - 10} H ${cx - 68}`} stroke="rgba(254,243,199,0.55)" strokeWidth={3} strokeLinecap="round" />
      <path d={`M ${cx + 68} ${cy - 10} H ${cx + 174}`} stroke="rgba(254,243,199,0.55)" strokeWidth={3} strokeLinecap="round" />
      {/* hollow interior */}
      <rect x={cx - 176} y={cy - PIPE_R} width={112} height={PIPE_R * 2} rx={5} fill="#082f49" opacity={0.28} />
      <rect x={cx + 64} y={cy - PIPE_R} width={112} height={PIPE_R * 2} rx={5} fill="#082f49" opacity={0.28} />

      {/* ── upstream water (left / supply): always full, rolling waves ── */}
      <g clipPath="url(#hy-clip-water-up)">
        <path d={waterBody(cx - 180, cx - 64, surfaceUp, 2.6)} fill="#38bdf8" opacity={0.92} className="hy-wave" style={{ animationDuration: '1.4s' }} />
        <path d={waterBody(cx - 180, cx - 64, surfaceUp + 2, 1.8)} fill="#7dd3fc" opacity={0.5} className="hy-wave" style={{ animationDuration: '0.95s' }} />
        <path d={waterBody(cx - 180, cx - 64, surfaceUp + 6, 1.2)} fill="#bae6fd" opacity={0.3} className="hy-wave" style={{ animationDuration: '0.7s' }} />
      </g>

      {/* ── downstream water (right): level drains / refills with the valve ── */}
      <g clipPath="url(#hy-clip-water-down)">
        {flow > 0.02 ? (
          <>
            <path
              d={waterBody(cx + 62, cx + 180, surfaceDown, downAmp)}
              fill="#38bdf8"
              opacity={0.45 + flow * 0.47}
              className="hy-wave"
              style={{ animationDuration: `${waveSpeed}s` }}
            />
            <path
              d={waterBody(cx + 62, cx + 180, surfaceDown + 2, downAmp * 0.65)}
              fill="#7dd3fc"
              opacity={0.15 + flow * 0.35}
              className="hy-wave"
              style={{ animationDuration: `${waveSpeed * 0.7}s` }}
            />
          </>
        ) : (
          !unknown && (
            <path
              d={waterBody(cx + 62, cx + 180, cy + PIPE_R - 2.5, 0.7)}
              fill="#38bdf8"
              opacity={0.4}
              className="hy-wave"
              style={{ animationDuration: '5s' }}
            />
          )
        )}
      </g>
      {/* churn bubbles just past the valve while partially open (flow left → right) */}
      {flow > 0.05 && flow < 0.95 && (
        <g>
          {[0, 1, 2].map((i) => (
            <circle key={i} r={1.5 + (i % 2)} cy={cy + 3 - i * 4} fill="#e0f2fe">
              <animate attributeName="cx" values={`${cx + 74};${cx + 102 + i * 10}`} dur={`${0.55 + i * 0.2}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0" dur={`${0.55 + i * 0.2}s`} repeatCount="indefinite" />
            </circle>
          ))}
        </g>
      )}
      {/* Annotations are sub-pixel at canvas scale — only worth it when focused. */}
      {selected && (
        <g>
          <path d={`M ${cx - 248} ${cy - 32} l 12 0 m -4 -4 l 4 4 l -4 4`} stroke="#0ea5e9" strokeWidth={2} fill="none" strokeLinecap="round" />
          <text x={cx - 172} y={cy - 28} fill="#0369a1" fontSize={13} fontWeight={600}>supply</text>
        </g>
      )}

      {/* ── black cast bracket: clamps the pipe upstream, short rise to the motor ── */}
      {/* clamp jaw wrapping the pipe */}
      <rect x={cx - 106} y={cy - 23} width={32} height={46} rx={5} fill="#1e293b" stroke="#0f172a" strokeWidth={1.4} />
      <path d={`M ${cx - 106} ${cy + 21} q 16 16 32 0`} fill="#1e293b" stroke="#0f172a" strokeWidth={1.4} />
      {/* clamp bolts under the pipe */}
      <rect x={cx - 102} y={cy + 25} width={5} height={15} rx={2} fill="#94a3b8" stroke="#334155" strokeWidth={1} />
      <rect x={cx - 83} y={cy + 25} width={5} height={15} rx={2} fill="#94a3b8" stroke="#334155" strokeWidth={1} />
      {/* short cast column rising to the motor base */}
      <path
        d={`M ${cx - 104} ${cy - 22} L ${cx - 100} ${motorBot + 2} h 46 L ${cx - 76} ${cy - 22} Z`}
        fill="#1e293b"
        stroke="#0f172a"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
      {/* cross-head screw on the casting */}
      <circle cx={cx - 89} cy={(cy - 22 + motorBot) / 2} r={4.5} fill="#334155" stroke="#94a3b8" strokeWidth={1.3} />
      <path d={`M ${cx - 92.5} ${(cy - 22 + motorBot) / 2} h 7 M ${cx - 89} ${(cy - 22 + motorBot) / 2 - 3.5} v 7`} stroke="#cbd5e1" strokeWidth={1.1} strokeLinecap="round" />
      {/* motor base plate */}
      <rect x={motorL - 4} y={motorBot} width={motorR - motorL + 8} height={8} rx={3} fill="#334155" stroke="#0f172a" strokeWidth={1.2} />

      {/* ── brass ball valve ── */}
      {[-1, 1].map((side) => (
        <g key={side}>
          <path
            d={`M ${cx + side * 64} ${cy - 20} h ${side * -20} l ${side * -6} 6 v 28 l ${side * 6} 6 h ${side * 20} Z`}
            fill="#d97706"
            stroke="#92400e"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <path d={`M ${cx + side * 56} ${cy - 13} v 26 M ${cx + side * 48} ${cy - 17} v 34`} stroke="#92400e" strokeWidth={1.3} opacity={0.6} />
        </g>
      ))}
      <rect x={cx - 40} y={cy - 25} width={80} height={50} rx={12} fill="url(#hy-valve-body)" stroke="#92400e" strokeWidth={2.4} />
      <ellipse cx={cx} cy={cy - 25} rx={24} ry={4.5} fill="#fcd34d" stroke="#92400e" strokeWidth={1.3} opacity={0.9} />
      <circle cx={cx} cy={cy} r={18} fill="#fef3c7" stroke="#b45309" strokeWidth={2} />
      {/* rotating bore inside the ball */}
      <g
        style={{
          transform: `rotate(${boreAngle}deg)`,
          transformOrigin: `${cx}px ${cy}px`,
          transformBox: 'view-box',
          transition: 'transform 190ms linear',
        }}
      >
        <rect
          x={cx - 16}
          y={cy - 5.5}
          width={32}
          height={11}
          rx={5.5}
          fill={closed ? '#fda4af' : '#38bdf8'}
          stroke={closed ? '#e11d48' : '#0284c7'}
          strokeWidth={1.3}
          style={{ transition: 'fill 0.8s, stroke 0.8s' }}
        />
      </g>
      {/* valve stem rising to the pivot */}
      <rect x={cx - 4.5} y={pivot.y - 2} width={9} height={cy - 24 - pivot.y + 2} rx={2} fill="#a16207" stroke="#713f12" strokeWidth={1.3} />

      {/* ── Bulldog Valve Robot motor (behind the arm) ── */}
      <g>
        {/* Closed rounded housing — no overshooting top plate */}
        <rect
          x={motorL}
          y={motorTop}
          width={motorR - motorL}
          height={motorBot - motorTop}
          rx={12}
          fill="#bae6fd"
          stroke="#0369a1"
          strokeWidth={2.4}
        />
        {/* Inset top lip (stays inside the rounded corners) */}
        <path
          d={`
            M ${motorL + 12} ${motorTop + 3}
            H ${motorR - 12}
            Q ${motorR - 4} ${motorTop + 3} ${motorR - 4} ${motorTop + 11}
            H ${motorL + 4}
            Q ${motorL + 4} ${motorTop + 3} ${motorL + 12} ${motorTop + 3}
            Z
          `}
          fill="#7dd3fc"
          opacity={0.85}
        />
        {/* Soft front highlight */}
        <path
          d={`M ${motorL + 10} ${motorTop + 14} H ${motorR - 10}`}
          stroke="#e0f2fe"
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.7}
        />
        {/* White round button on the top lip */}
        <circle cx={motorL + 62} cy={motorTop + 9} r={5.5} fill="#f8fafc" stroke="#0369a1" strokeWidth={1.3} />
        <circle cx={motorL + 60.5} cy={motorTop + 7.5} r={1.6} fill="#ffffff" opacity={0.8} />
        {/* product sticker */}
        <rect x={motorL + 10} y={motorTop + 18} width={motorR - motorL - 20} height={20} rx={4} fill="#f0f9ff" stroke="#7dd3fc" strokeWidth={1} />
        {selected && (
          <text x={(motorL + motorR) / 2} y={motorTop + 32} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#0369a1">BULLDOG VALVE ROBOT</text>
        )}
        {/* status LEDs */}
        <circle cx={motorL + 18} cy={motorTop + 54} r={3.6} fill={pending ? '#f59e0b' : unknown ? '#94a3b8' : '#22d3ee'}>
          {(pending || !unknown) && <animate attributeName="opacity" values="1;0.25;1" dur={pending ? '0.5s' : '2s'} repeatCount="indefinite" />}
        </circle>
        <circle cx={motorL + 34} cy={motorTop + 54} r={2.5} fill="#0ea5e9" opacity={0.7} />
      </g>

      {/* Shelly 1 Gen4 relay wired to the Bulldog — shifted right for room */}
      <g>
        <rect x={motorR + 48} y={motorTop + 2} width={64} height={40} rx={8} fill="#dbeafe" stroke="#2563eb" strokeWidth={2.3} />
        {selected && (
          <g>
            <text x={motorR + 80} y={motorTop + 18} textAnchor="middle" fontSize={10} fontWeight={800} fill="#1d4ed8">SHELLY 1</text>
            <text x={motorR + 80} y={motorTop + 31} textAnchor="middle" fontSize={8.5} fontWeight={600} fill="#3b82f6">Gen4</text>
          </g>
        )}
        <circle cx={motorR + 58} cy={motorTop + 28} r={2.6} fill={offline ? '#94a3b8' : '#22d3ee'} />
        <path d={`M ${motorR + 48} ${motorTop + 22} q -22 8 -47 0`} fill="none" stroke="#334155" strokeWidth={2.2} strokeDasharray="3 2" />
        {/* Live pulse — form-fits the badge and expands outward from its outline */}
        {!offline && (
          <rect
            x={motorR + 48}
            y={motorTop + 2}
            width={64}
            height={40}
            rx={8}
            fill="none"
            stroke="#06b6d4"
            strokeWidth={1.7}
          >
            <animate attributeName="x" values={`${motorR + 48};${motorR + 42}`} dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="y" values={`${motorTop + 2};${motorTop - 3}`} dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="width" values="64;76" dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="height" values="40;50" dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="rx" values="8;10" dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.7;0" dur="2.8s" repeatCount="indefinite" />
          </rect>
        )}
      </g>

      {/* static drive shaft: motor gearbox down to the arm hub (stops there so
          it never covers the rotating arm) */}
      <rect x={pivot.x - 6} y={motorBot + 6} width={12} height={armPlateY - motorBot - 6} rx={3.5} fill="#1e293b" stroke="#0f172a" strokeWidth={1.2} />

      {/* Projected 3D linkage — handle swings out of the pipe plane toward the viewer */}
      <g>
        {/* Soft ground shadow tracks the handle tip */}
        <ellipse
          cx={handleTip.x}
          cy={cy + 14}
          rx={6 + 10 * cosA}
          ry={3}
          fill="rgba(15,23,42,0.1)"
        />

        {/* Rear pin — far side of the handle */}
        <rect
          x={pinTopR.x - 2.2}
          y={pinTopR.y}
          width={4.4}
          height={PIN_LEN}
          rx={2}
          fill="#94a3b8"
          stroke="#64748b"
          strokeWidth={0.9}
        />

        {/* Bottom oval foot plate closing the cage */}
        <ellipse
          cx={footC.x}
          cy={footC.y}
          rx={footR}
          ry={3.4}
          fill="#1e293b"
          stroke="#0f172a"
          strokeWidth={1}
        />

        {/* Red vinyl-dipped handle — swings toward the camera between the pins */}
        <line
          x1={pivot.x}
          y1={pivot.y}
          x2={handleTip.x}
          y2={handleTip.y}
          stroke="#7f1d1d"
          strokeWidth={handleW + 2.2}
          strokeLinecap="round"
        />
        <line
          x1={pivot.x}
          y1={pivot.y}
          x2={handleTip.x}
          y2={handleTip.y}
          stroke="#ef4444"
          strokeWidth={handleW}
          strokeLinecap="round"
        />
        <line
          x1={pivot.x + (handleTip.x - pivot.x) * 0.15}
          y1={pivot.y + (handleTip.y - pivot.y) * 0.15 - handleW * 0.22}
          x2={pivot.x + (handleTip.x - pivot.x) * 0.8}
          y2={pivot.y + (handleTip.y - pivot.y) * 0.8 - handleW * 0.22}
          stroke="#fca5a5"
          strokeWidth={1.6}
          strokeLinecap="round"
          opacity={0.85}
        />
        {/* Rounded handle end — grows as it points toward you */}
        <circle
          cx={handleTip.x}
          cy={handleTip.y}
          r={(HANDLE_H / 2 + 0.6) * NEAR}
          fill="#ef4444"
          stroke="#7f1d1d"
          strokeWidth={1.3}
        />
        <circle cx={handleTip.x - 1.5} cy={handleTip.y - 1.5} r={1.7 * NEAR} fill="#fca5a5" opacity={0.9} />

        {/* Silver stem bracket + hex nut (under the arm) */}
        <rect x={pivot.x - 8} y={pivot.y - 8} width={16} height={12} rx={2.5} fill="#e2e8f0" stroke="#64748b" strokeWidth={1.1} />
        <path
          d={`M ${pivot.x - 5} ${pivot.y - 2} l 2.5 -4.4 h 5 l 2.5 4.4 l -2.5 4.4 h -5 Z`}
          fill="#cbd5e1"
          stroke="#475569"
          strokeWidth={1}
          strokeLinejoin="round"
        />

        {/* Black actuator arm — hub to crossbar, drawn OVER the handle.
            Nothing else paints on top of it, so it stays visible closed. */}
        <line
          x1={pivot.x}
          y1={armPlateY}
          x2={clampPt.x}
          y2={crossbarY}
          stroke="#0f172a"
          strokeWidth={10}
          strokeLinecap="round"
        />
        <line
          x1={pivot.x}
          y1={armPlateY}
          x2={clampPt.x}
          y2={crossbarY}
          stroke="#1e293b"
          strokeWidth={7}
          strokeLinecap="round"
        />
        {/* Crossbar spanning both cage pins */}
        <line
          x1={pinTopR.x}
          y1={pinTopR.y - 2}
          x2={pinTopF.x}
          y2={pinTopF.y - 2}
          stroke="#0f172a"
          strokeWidth={8}
          strokeLinecap="round"
        />
        <line
          x1={pinTopR.x}
          y1={pinTopR.y - 2}
          x2={pinTopF.x}
          y2={pinTopF.y - 2}
          stroke="#1e293b"
          strokeWidth={5.4}
          strokeLinecap="round"
        />

        {/* Front pin — camera side, crosses in front of the handle */}
        <rect
          x={pinTopF.x - 2.2}
          y={pinTopF.y}
          width={4.4}
          height={PIN_LEN}
          rx={2}
          fill="#e2e8f0"
          stroke="#64748b"
          strokeWidth={1}
        />
        <path
          d={`M ${pinTopF.x - 1} ${pinTopF.y + 3} v ${PIN_LEN - 7}`}
          stroke="#f8fafc"
          strokeWidth={1}
          strokeLinecap="round"
          opacity={0.85}
        />
        {/* Pin screw heads on the crossbar */}
        <circle cx={pinTopR.x} cy={pinTopR.y - 2} r={2.4} fill="#cbd5e1" stroke="#475569" strokeWidth={0.9} />
        <circle cx={pinTopF.x} cy={pinTopF.y - 2} r={2.4} fill="#cbd5e1" stroke="#475569" strokeWidth={0.9} />

        {/* Hub cap on top of the arm's origin */}
        <circle cx={pivot.x} cy={armPlateY} r={7.5} fill="#1e293b" stroke="#0f172a" strokeWidth={1.3} />
        <circle cx={pivot.x} cy={armPlateY} r={3.4} fill="#94a3b8" />
        <circle cx={pivot.x - 1} cy={armPlateY - 1} r={1.1} fill="#e2e8f0" />
      </g>

      {(pending || motion.state === 'opening' || motion.state === 'closing') && (
        <ellipse
          cx={pivot.x}
          cy={pivot.y}
          rx={54}
          ry={54 * FORESHORT + 10}
          fill="none"
          stroke={motion.state === 'closing' ? '#f59e0b' : '#38bdf8'}
          strokeWidth={1.6}
          strokeDasharray="8 10"
          className="hy-spin"
          opacity={0.55}
        />
      )}

      <g>
        <rect
          x={cx - 86}
          y={cy + 44}
          width={172}
          height={30}
          rx={15}
          fill={
            motion.state === 'opening' ? '#f0f9ff'
              : motion.state === 'closing' ? '#fffbeb'
                : unknown ? '#f1f5f9'
                  : closed ? '#fff1f2'
                    : '#ecfeff'
          }
          stroke={
            motion.state === 'opening' ? '#7dd3fc'
              : motion.state === 'closing' ? '#fcd34d'
                : unknown ? '#cbd5e1'
                  : closed ? '#fda4af'
                    : '#67e8f9'
          }
          strokeWidth={1.4}
        />
        <text
          x={cx}
          y={cy + 64}
          textAnchor="middle"
          fontSize={16}
          fontWeight={800}
          fill={
            motion.state === 'opening' ? '#0369a1'
              : motion.state === 'closing' ? '#b45309'
                : unknown ? '#64748b'
                  : closed ? '#be123c'
                    : '#0e7490'
          }
        >
          {motion.state === 'closing' ? 'CLOSING' : motion.state === 'opening' ? 'OPENING' : unknown ? 'VALVE UNKNOWN' : closed ? 'WATER STOPPED' : 'WATER FLOWING'}
        </text>
      </g>
      {/* Name only while selected — the valve art is already unmistakable. */}
      {selected && (
        <text x={cx} y={motorTop - 28} textAnchor="middle" fontSize={17} fontWeight={700} fill="#0f172a">
          {device.name || 'Water Shutoff Valve'}
        </text>
      )}
      <g transform={`translate(${cx + 148} ${motorTop - 36})`}>
        <ConnectivityBadge tone={tone} x={0} y={0} />
      </g>

      {/*
       * The full-size OPEN/CLOSE controls are wide enough to cross neighbouring
       * rooms, so they only appear once the valve is the focused object.
       */}
      {onCommand && selected && (
        <g>
          <g
            style={{ cursor: openBlocked ? 'not-allowed' : pending ? 'wait' : 'pointer', opacity: openBlocked ? 0.45 : 1 }}
            onClick={(e) => {
              e.stopPropagation();
              if (!openBlocked) onCommand(device, 'open');
            }}
          >
            <rect x={cx - 230} y={cy + 44} width={128} height={36} rx={18} fill="#059669" stroke="#047857" strokeWidth={1.4} />
            <text x={cx - 166} y={cy + 67} textAnchor="middle" fontSize={15} fontWeight={800} fill="#ffffff">
              {device.status === 'offline' ? 'OFFLINE' : device.status === 'unknown' ? 'CHECKING…' : alreadyOpen ? 'ALREADY OPEN' : pending ? 'WORKING…' : 'OPEN VALVE'}
            </text>
          </g>
          <g
            style={{ cursor: closeBlocked ? 'not-allowed' : pending ? 'wait' : 'pointer', opacity: closeBlocked ? 0.45 : 1 }}
            onClick={(e) => {
              e.stopPropagation();
              if (!closeBlocked) onCommand(device, 'close');
            }}
          >
            <rect x={cx + 102} y={cy + 44} width={128} height={36} rx={18} fill="#e11d48" stroke="#be123c" strokeWidth={1.4} />
            <text x={cx + 166} y={cy + 67} textAnchor="middle" fontSize={15} fontWeight={800} fill="#ffffff">
              {device.status === 'offline' ? 'OFFLINE' : device.status === 'unknown' ? 'CHECKING…' : alreadyClosed ? 'ALREADY CLOSED' : pending ? 'WORKING…' : 'CLOSE VALVE'}
            </text>
          </g>
        </g>
      )}
      </g>
    </g>
  );
}

/* ── detail panel ───────────────────────────────────────────────── */

function DetailMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-blue-100 bg-white/80 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-slate-800">{children}</div>
    </div>
  );
}

function formatWhen(value?: string | Date | null) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function PowerDetailPanel({
  signal,
  utilityStatus,
  devices,
  onClose,
}: {
  signal: PropertyPowerSignal | null;
  utilityStatus?: UtilityOutageStatus | null;
  devices: ShellyDevice[];
  onClose: () => void;
}) {
  const estimation = signal?.estimation || 'power_likely_on';
  const meta = POWER_ESTIMATION_META[estimation];
  const mainsDevices = devices.filter((d) => {
    const type = String(d.type || '').toLowerCase();
    const caps = d.capabilities || [];
    return type === 'relay_controller' || type === 'relay' || type === 'ble_gateway' || type === 'gateway'
      || caps.includes('water_shutoff') || caps.includes('ble_bridge');
  });

  return (
    <aside className="flex h-full flex-col rounded-2xl border border-sky-200 bg-white/90 p-4 shadow-[0_14px_40px_rgba(14,165,233,0.12)] backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sky-700">
            <Zap size={14} />
            <span className="text-[10px] font-bold uppercase tracking-[0.16em]">Grid power</span>
          </div>
          <h3 className="mt-1 truncate text-sm font-bold text-slate-900">
            {signal?.propertyAddress || 'Property power status'}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Extrapolated from mains-powered monitors + utility feed
          </p>
        </div>
        <button onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-slate-50">Close</button>
      </div>

      <div
        className="mt-3 rounded-xl border px-3 py-2.5"
        style={{ borderColor: `${meta.color}55`, backgroundColor: `${meta.color}14` }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold" style={{ color: meta.color }}>
            {meta.icon} {meta.label}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {getPowerScoreLabel(signal?.score ?? 50)}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70">
          <div
            className={`h-full rounded-full ${meta.barClass}`}
            style={{ width: `${Math.max(6, Math.min(100, signal?.score ?? 50))}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] font-semibold text-slate-500">
          <span>Score {signal?.score ?? '—'} / 100</span>
          <span>Confidence {signal?.confidence ?? '—'}%</span>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">
        {signal?.recommendation || 'Waiting for mains-powered device signals.'}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <DetailMetric label="Mains monitors">
          {signal ? `${signal.mainsOnlineCount}/${signal.mainsDeviceCount} live` : '—'}
        </DetailMetric>
        <DetailMetric label="Offline mains">
          {signal?.mainsOfflineCount ?? 0}
        </DetailMetric>
        <DetailMetric label="Utility feed">
          {utilityStatus?.activeOutages
            ? `${utilityStatus.outageCount ?? 'Active'} outage(s)`
            : utilityStatus?.ok === false
              ? 'Unavailable'
              : 'No area outage'}
        </DetailMetric>
        <DetailMetric label="Checked">
          {formatWhen(utilityStatus?.checkedAt || signal?.detectedAt)}
        </DetailMetric>
      </div>

      {signal?.offlineMainsDevices && signal.offlineMainsDevices.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Silent mains devices</div>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
            {signal.offlineMainsDevices.map((name) => (
              <li key={name}>· {name}</li>
            ))}
          </ul>
        </div>
      )}

      {utilityStatus?.summary && (
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Utility detail</div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">{utilityStatus.summary}</p>
          {(utilityStatus.customersAffected != null || utilityStatus.stateName) && (
            <p className="mt-1 text-[11px] text-slate-500">
              {utilityStatus.stateName || utilityStatus.stateCode || 'Area'}
              {utilityStatus.customersAffected != null
                ? ` · ${utilityStatus.customersAffected.toLocaleString()} customers affected`
                : ''}
            </p>
          )}
        </div>
      )}

      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Mains-powered monitors</div>
        <ul className="mt-1.5 space-y-1.5">
          {mainsDevices.length === 0 && (
            <li className="rounded-lg border border-dashed border-slate-200 px-2.5 py-2 text-xs text-slate-500">
              No mains-powered devices enrolled yet.
            </li>
          )}
          {mainsDevices.map((device) => {
            const online = device.status === 'online';
            return (
              <li
                key={device.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white/80 px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-slate-800">{device.name}</div>
                  <div className="truncate text-[10px] text-slate-500">
                    {device.type || 'device'} · last {formatWhen(device.lastSeen)}
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${online ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {online ? 'Live' : 'Quiet'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

function forecastActionChipClass(action: ForecastSlotAction): string {
  if (action === 'act') return 'bg-rose-50 text-rose-700 border-rose-200';
  if (action === 'prep') return 'bg-amber-50 text-amber-800 border-amber-200';
  if (action === 'watch') return 'bg-sky-50 text-sky-800 border-sky-200';
  return 'bg-slate-50 text-slate-500 border-slate-200';
}

function WeatherDetailPanel({
  assessment,
  loading,
  error,
  onClose,
}: {
  assessment: ExtremeWeatherAssessment | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}) {
  const risk = assessment?.overallRisk || 'none';
  const color = weatherRiskColor(risk);
  const timeline = useMemo(() => buildForecastTimeline(assessment, { hours: 48, maxSlots: 16 }), [assessment]);
  const floodBridge = useMemo(() => floodBridgeFromAssessment(assessment), [assessment]);
  const nextActionSlot = timeline.find((slot) => slot.action === 'act' || slot.action === 'prep') || null;
  const maxPrecip = Math.max(0.15, ...timeline.map((slot) => slot.precipIn));

  return (
    <aside className="flex h-full min-h-0 flex-col rounded-2xl border border-sky-200 bg-white/90 p-4 shadow-[0_14px_40px_rgba(14,165,233,0.12)] backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sky-700">
            <Cloud size={14} />
            <span className="text-[10px] font-bold uppercase tracking-[0.16em]">Outdoor risk</span>
          </div>
          <h3 className="mt-1 truncate text-sm font-bold text-slate-900">
            {assessment?.propertyAddress || 'Property outdoor conditions'}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            3-hour forecast steps · NWS alerts · property actions
          </p>
        </div>
        <button onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-slate-50">Close</button>
      </div>

      {loading && !assessment && (
        <p className="mt-3 text-xs text-slate-500">Loading outdoor assessment…</p>
      )}
      {error && !assessment && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</p>
      )}

      {assessment && (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
          <div
            className="rounded-xl border px-3 py-2.5"
            style={{ borderColor: `${color}55`, backgroundColor: `${color}14` }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold" style={{ color }}>{weatherRiskLabel(risk)}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {assessment.mostUrgentHazard
                  ? hazardShortLabel(assessment.mostUrgentHazard)
                  : 'No active hazard'}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-600">
              {nextActionSlot
                ? `${nextActionSlot.actionLabel}: ${nextActionSlot.actionDetail}`
                : assessment.hoursToNextEvent != null
                  ? `Next scored window in ~${Math.max(0, Math.round(assessment.hoursToNextEvent))}h`
                  : 'No elevated action window in the next 48h'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <DetailMetric label="Outdoor temp">
              {assessment.current?.tempF != null ? `${Math.round(assessment.current.tempF)}°F` : '—'}
            </DetailMetric>
            <DetailMetric label="Outdoor RH">
              {assessment.current?.humidity != null ? `${Math.round(assessment.current.humidity)}%` : '—'}
            </DetailMetric>
            <DetailMetric label="Wind / gust">
              {assessment.current?.windMph != null
                ? `${Math.round(assessment.current.windMph)}${assessment.current.windGustMph != null ? ` / ${Math.round(assessment.current.windGustMph)}` : ''} mph`
                : '—'}
            </DetailMetric>
            <DetailMetric label="Rain next 24h">
              {floodBridge ? `${floodBridge.precipNext24hIn.toFixed(2)} in` : '—'}
            </DetailMetric>
          </div>

          {timeline.length > 0 && (
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-2.5 py-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Next 48h timeline
                </div>
                <span className="text-[10px] text-slate-400">OpenWeather 3h steps</span>
              </div>
              <div className="-mx-0.5 flex gap-1.5 overflow-x-auto pb-1">
                {timeline.map((slot) => {
                  const precipPct = Math.round((slot.precipIn / maxPrecip) * 100);
                  return (
                    <div
                      key={slot.timestamp}
                      className="w-[4.6rem] shrink-0 rounded-lg border border-white bg-white/95 px-1.5 py-1.5 shadow-sm"
                      title={slot.actionDetail}
                    >
                      <div className="truncate text-[10px] font-bold text-slate-700">{slot.label}</div>
                      <div className="mt-0.5 text-sm font-bold text-slate-900">
                        {slot.tempF != null ? `${Math.round(slot.tempF)}°` : '—'}
                      </div>
                      <div className="mt-1 flex h-8 items-end rounded bg-sky-50 px-[3px] pb-0.5">
                        <div
                          className="w-full rounded-sm bg-sky-500/85"
                          style={{ height: `${Math.max(4, Math.round((precipPct / 100) * 28))}px` }}
                        />
                      </div>
                      <div className="mt-1 text-[9px] font-semibold text-slate-500">
                        {slot.precipIn > 0 ? `${slot.precipIn.toFixed(2)}"` : 'dry'}
                        {slot.windMph != null ? ` · ${Math.round(slot.windMph)}mph` : ''}
                      </div>
                      <div className={`mt-1 rounded border px-1 py-0.5 text-center text-[9px] font-bold uppercase tracking-wide ${forecastActionChipClass(slot.action)}`}>
                        {slot.actionLabel}
                      </div>
                    </div>
                  );
                })}
              </div>
              {nextActionSlot && (
                <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                  <span className="font-semibold text-slate-800">{nextActionSlot.label}:</span>
                  {' '}
                  {nextActionSlot.actionDetail}
                </p>
              )}
            </div>
          )}

          {floodBridge && (
            <div className={`rounded-xl border px-3 py-2 ${
              floodBridge.shouldSimulateWaterFlow
                ? 'border-sky-200 bg-sky-50/80'
                : 'border-slate-100 bg-slate-50/80'
            }`}
            >
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-700">
                <Droplets size={11} /> Flood map bridge
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-700">{floodBridge.actionHint}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                Suggested storm intensity: <span className="font-semibold text-slate-800">{floodBridge.suggestedStormInches}"</span>
                {' · '}peak 3h {floodBridge.peakPrecipIn3h.toFixed(2)}"
              </p>
              <Link
                to="/portfolio"
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-sky-700 hover:text-sky-900"
              >
                Open Portfolio Flood Risk / water flow →
              </Link>
            </div>
          )}

          {assessment.actions?.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <CheckSquare size={11} /> Prep checklist
              </div>
              <ul className="mt-1.5 space-y-1.5">
                {assessment.actions.map((action) => (
                  <li
                    key={action.id}
                    className="rounded-lg border border-slate-100 bg-white/80 px-2.5 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-800">{action.label}</span>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                        action.priority === 'high'
                          ? 'bg-rose-50 text-rose-700'
                          : action.priority === 'medium'
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-slate-100 text-slate-500'
                      }`}
                      >
                        {action.priority}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{action.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {assessment.indoorBridge?.risingOutdoorHumidity && (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Indoor humidity watch</div>
              <p className="mt-1 text-xs text-emerald-900">
                Outdoor humidity is elevated — watch
                {' '}
                {assessment.indoorBridge.roomsToWatch?.length
                  ? assessment.indoorBridge.roomsToWatch.join(', ')
                  : 'basement / laundry H&T sensors'}
                .
              </p>
            </div>
          )}

          {assessment.disclaimer && (
            <p className="text-[10px] leading-relaxed text-slate-400">{assessment.disclaimer}</p>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * A tracked component's condition, in the same rail a device would use.
 *
 * The point of putting it here rather than only in the Property Health tab is
 * the flood crossover at the bottom: it is the one place where the component's
 * age and the water in the drawing are on screen together, and that pairing is
 * the whole reason for reading the two models against each other.
 */
function HealthDetailPanel({
  asset,
  crossovers,
  cost,
  history,
  forecast,
  onOpenInHealth,
  onClose,
}: {
  asset: PropertyHealthAsset;
  crossovers: HazardCrossover[];
  /** Absent until any spend has been recorded against this component. */
  cost?: ComponentCostSummary | null;
  /** This component's events only, newest first. */
  history: PropertyHistoryEvent[];
  forecast: ComponentMaintenanceForecast;
  onOpenInHealth?: (assetId: string) => void;
  onClose: () => void;
}) {
  const meta = PROPERTY_HEALTH_CATEGORY_META[asset.category];
  const life = resolveUsefulLifeYears(asset);
  const age = resolveAssetAgeYears(asset);
  const ratio = resolveLifeUsedRatio(asset);
  const tint = healthTint(ratio);
  const yearsLeft = age == null ? null : Math.max(0, Math.round(life - age));
  const mine = crossovers.filter((c) => c.assetId === asset.id);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            {meta.label}
          </div>
          <div className="truncate text-sm font-bold text-slate-900" title={asset.name}>
            {asset.name}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Close component detail"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-2.5">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="font-semibold text-slate-600">
            {age == null ? 'Age unknown' : `${Math.round(age)} of ~${life} yrs`}
          </span>
          <span className="font-bold" style={{ color: tint }}>
            {ratio == null
              ? 'No install date'
              : yearsLeft === 0
                ? 'At end of life'
                : `~${yearsLeft} yr${yearsLeft === 1 ? '' : 's'} left`}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%`, background: tint }}
          />
        </div>
      </div>

      <dl className="mt-2.5 space-y-1 text-[11px]">
        {asset.make || asset.model ? (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Make / model</dt>
            <dd className="truncate font-semibold text-slate-800">
              {[asset.make, asset.model].filter(Boolean).join(' ')}
            </dd>
          </div>
        ) : null}
        {asset.material ? (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Material</dt>
            <dd className="font-semibold text-slate-800">{asset.material}</dd>
          </div>
        ) : null}
        {asset.serialNumber ? (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Serial</dt>
            <dd className="truncate font-mono text-[10.5px] font-semibold text-slate-800" title={asset.serialNumber}>
              {asset.serialNumber}
            </dd>
          </div>
        ) : null}
        {asset.installedAt ? (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Installed</dt>
            <dd className="font-semibold tabular-nums text-slate-800">
              {asset.installedAt.slice(0, 10)}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Typical replacement</dt>
          <dd className="font-semibold text-slate-800">
            ${meta.typicalReplacementUsd.toLocaleString()}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Evidence</dt>
          <dd className="font-semibold text-slate-800" title={HEALTH_EVIDENCE_META[asset.evidence ?? 'owner'].label}>
            {asset.evidence === 'inferred'
              ? 'Inferred — needs confirming'
              : HEALTH_EVIDENCE_META[asset.evidence ?? 'owner'].short}
          </dd>
        </div>
      </dl>

      <div
        className={`mt-2.5 rounded-lg border p-2 ${
          forecast.urgency === 'urgent'
            ? 'border-rose-200 bg-rose-50'
            : forecast.urgency === 'soon' || forecast.urgency === 'plan'
              ? 'border-amber-200 bg-amber-50'
              : forecast.urgency === 'verify'
                ? 'border-cyan-200 bg-cyan-50'
                : 'border-emerald-200 bg-emerald-50'
        }`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
            Predictive outlook
          </span>
          <span className="text-[10.5px] font-bold tabular-nums text-slate-800">
            {forecast.failureProbability24m == null
              ? 'Age needed'
              : `${Math.round(forecast.failureProbability24m * 100)}% / 24 mo`}
          </span>
        </div>
        <div className="mt-1 text-[11px] font-bold text-slate-900">{forecast.headline}</div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-slate-600">
          {forecast.recommendation}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-slate-500">
          <span>Act by {new Date(`${forecast.serviceBy}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
          <span className="font-semibold tabular-nums">
            ${forecast.estimatedCostLowUsd.toLocaleString()}–${forecast.estimatedCostHighUsd.toLocaleString()}
          </span>
        </div>
        {forecast.drivers.length > 0 ? (
          <ul className="mt-1.5 space-y-1 border-t border-black/5 pt-1.5">
            {forecast.drivers.slice(0, 3).map((driver, index) => (
              <li key={`${driver.kind}-${index}`} className="flex gap-1.5 text-[10px] leading-snug text-slate-600">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                    driver.impact === 'raises'
                      ? 'bg-amber-500'
                      : driver.impact === 'lowers'
                        ? 'bg-emerald-500'
                        : 'bg-cyan-500'
                  }`}
                />
                {driver.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {asset.visualCondition ? (
        <div className="mt-2.5 rounded-lg border border-slate-200 bg-white p-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
              Latest visual inspection
            </span>
            <span className="text-[10.5px] font-bold tabular-nums text-slate-800">
              {Math.round(asset.visualCondition.score)}/100
            </span>
          </div>
          {asset.visualCondition.summary ? (
            <p className="mt-1 text-[10.5px] leading-snug text-slate-600">
              {asset.visualCondition.summary}
            </p>
          ) : null}
          {asset.visualCondition.observations.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {asset.visualCondition.observations.slice(0, 4).map((observation, index) => (
                <li key={`${observation.label}-${index}`} className="text-[10px] leading-snug text-slate-600">
                  <span className="font-bold text-slate-700">{observation.label}:</span>{' '}
                  {observation.evidence}
                </li>
              ))}
            </ul>
          ) : null}
          {asset.visualCondition.limitations.length > 0 ? (
            <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-[9.5px] leading-snug text-slate-400">
              Not visible: {asset.visualCondition.limitations.slice(0, 2).join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
        What it has actually cost, and what has been done to it.
        
        The reason to put spend on the twin rather than leaving it on the health
        tab is that this is where the question gets asked: you are looking at the
        thing, you can see it is near the end of its life, and the next thought is
        always whether to keep paying to fix it.
      */}
      {cost && cost.eventCount > 0 ? (
        <div className="mt-2.5 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
              Spent to date
            </span>
            <span className="text-[13px] font-bold tabular-nums text-slate-900">
              ${Math.round(cost.lifetimeSpendUsd).toLocaleString()}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between text-[10.5px] text-slate-600">
            <span>
              {cost.repairSpendUsd > 0
                ? `$${Math.round(cost.repairSpendUsd).toLocaleString()} of that on repairs`
                : 'No repairs on record'}
            </span>
            {cost.annualizedUsd != null ? (
              <span
                className="font-semibold tabular-nums"
                title="Replacement spread over the life it buys, plus the observed rate of upkeep"
              >
                ${Math.round(cost.annualizedUsd).toLocaleString()}/yr
              </span>
            ) : null}
          </div>

          {cost.replaceSignal ? (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-600" />
              <p className="text-[10.5px] font-semibold leading-snug text-amber-900">
                {cost.replaceSignal.reason}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="mt-2.5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
            History
          </div>
          <ol className="mt-1 space-y-1">
            {history.slice(0, 5).map((event) => (
              <li key={event.id} className="flex items-baseline gap-1.5 text-[10.5px]">
                <span className="w-[62px] shrink-0 tabular-nums text-slate-400">
                  {event.occurredAt.slice(0, 7)}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-700" title={event.detail || event.title}>
                  {HISTORY_EVENT_META[event.kind].label}
                  {event.vendor ? ` · ${event.vendor}` : ''}
                </span>
                {event.amountUsd ? (
                  <span className="shrink-0 font-semibold tabular-nums text-slate-800">
                    ${Math.round(event.amountUsd).toLocaleString()}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {history.length > 5 ? (
            <div className="mt-1 text-[10px] text-slate-400">
              +{history.length - 5} older on the health tab
            </div>
          ) : null}
        </div>
      ) : null}

      {mine.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {mine.map((c) => (
            <div
              key={`${c.assetId}-${c.thresholdId}`}
              className={`rounded-lg border p-2 ${
                c.severity === 'critical'
                  ? 'border-rose-200 bg-rose-50'
                  : c.severity === 'warn'
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-slate-200 bg-slate-50'
              }`}
            >
              <div className="text-[11px] font-bold text-slate-900">{c.headline}</div>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-600">{c.detail}</p>
            </div>
          ))}
        </div>
      )}

      {onOpenInHealth && (
        <button
          type="button"
          onClick={() => onOpenInHealth(asset.id)}
          className="mt-2.5 w-full rounded-lg border border-slate-300 bg-white py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50"
        >
          Open in Property Health
        </button>
      )}
    </div>
  );
}

function DeviceDetailPanel({
  device,
  alerts,
  propertyAddress,
  roomLabel,
  pendingValve,
  onValveCommand,
  onRenameDevice,
  onUnassignDevice,
  onDeleteDevice,
  onReconfigureFlood,
  onReconnectRelay,
  onAcknowledgeAlert,
  deletingDeviceId,
  onClose,
}: {
  device: ShellyDevice;
  alerts: ShellyAlert[];
  propertyAddress?: string;
  roomLabel?: string;
  pendingValve: boolean;
  onValveCommand?: (device: ShellyDevice, action: 'open' | 'close') => void;
  onRenameDevice?: (device: ShellyDevice, newName: string) => Promise<void> | void;
  onUnassignDevice?: (device: ShellyDevice) => void;
  onDeleteDevice?: (device: ShellyDevice) => void;
  onReconfigureFlood?: (device: ShellyDevice) => void;
  onReconnectRelay?: (device: ShellyDevice) => void;
  onAcknowledgeAlert?: (alertId: string) => Promise<void> | void;
  deletingDeviceId?: string | null;
  onClose: () => void;
}) {
  const kind = deviceKind(device);
  const tone = deviceTone(device, alerts);
  const valveMotion = useValveMotion(kind === 'relay' ? device : undefined);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(device.name || '');
  const [saving, setSaving] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [linkedRequest, setLinkedRequest] = useState<MaintenanceProgressRequest | null>(null);
  const [linkedRequestStatus, setLinkedRequestStatus] = useState<'idle' | 'loading' | 'ok' | 'missing' | 'error'>('idle');
  const [linkedRequestError, setLinkedRequestError] = useState<string | null>(null);
  const [ticketDraft, setTicketDraft] = useState<MaintenanceSubmitPayload | null>(null);
  const [ticketSubmitting, setTicketSubmitting] = useState(false);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [submittedTicketId, setSubmittedTicketId] = useState<string | null>(null);
  const openAlerts = alerts.filter((a) => a.deviceId === device.deviceId && !a.acknowledged);
  const openFloodAlerts = openAlerts.filter((a) => a.type === 'flood');
  const showAcknowledge = openAlerts.length > 0 && Boolean(onAcknowledgeAlert);
  const floodHistory = useMemo(() => (
    alerts
      .filter((a) => a.deviceId === device.deviceId && (a.type === 'flood' || a.type === 'humidity_damage'))
      .slice()
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  ), [alerts, device.deviceId]);
  const leakEventCount = floodHistory.length;
  const acknowledgedLeakCount = floodHistory.filter((a) => a.acknowledged).length;

  // Default selection: newest open flood alert, else newest history item.
  useEffect(() => {
    if (kind !== 'flood') {
      setSelectedAlertId(null);
      return;
    }
    if (selectedAlertId && floodHistory.some((a) => a.id === selectedAlertId)) return;
    const newestOpen = floodHistory.find((a) => !a.acknowledged);
    setSelectedAlertId(newestOpen?.id || floodHistory[0]?.id || null);
  }, [kind, floodHistory, selectedAlertId]);

  const selectedFloodAlert = useMemo(
    () => floodHistory.find((a) => a.id === selectedAlertId) || null,
    [floodHistory, selectedAlertId],
  );
  const ticketAlert = selectedFloodAlert && !selectedFloodAlert.acknowledged
    ? selectedFloodAlert
    : openAlerts[0] || null;

  // Load the maintenance request linked to the selected flood alert.
  useEffect(() => {
    if (kind !== 'flood' || !selectedFloodAlert) {
      setLinkedRequest(null);
      setLinkedRequestStatus('idle');
      setLinkedRequestError(null);
      return undefined;
    }

    const ownerId = selectedFloodAlert.ownerId || device.ownerId;
    const requestId = alertMaintenanceRequestId(selectedFloodAlert);
    const alertId = selectedFloodAlert.id;
    if (!ownerId) {
      setLinkedRequest(null);
      setLinkedRequestStatus('missing');
      setLinkedRequestError('No owner on this alert yet — maintenance dispatch needs an owner.');
      return undefined;
    }

    let cancelled = false;
    setLinkedRequestStatus('loading');
    setLinkedRequestError(null);

    const baseUrl = getDevApiBaseUrl();
    const params = new URLSearchParams({ ownerId });
    if (device.propertyId) params.set('propertyId', device.propertyId);

    fetch(`${baseUrl}/api/maintenance/requests?${params.toString()}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok === false) {
          throw new Error(payload?.error || `Failed to load maintenance requests (${response.status})`);
        }
        const requests = Array.isArray(payload?.requests) ? payload.requests as Array<MaintenanceProgressRequest & {
          aiAutomation?: MaintenanceProgressRequest['aiAutomation'] & { sensorAlertId?: string };
        }> : [];
        const byId = requestId
          ? requests.find((r) => r.id === requestId)
          : null;
        const bySensor = requests.find((r) => String(r.aiAutomation?.sensorAlertId || '') === alertId);
        const match = byId || bySensor || null;
        if (cancelled) return;
        setLinkedRequest(match);
        setLinkedRequestStatus(match ? 'ok' : 'missing');
        if (!match) {
          setLinkedRequestError(
            requestId
              ? 'Linked maintenance request was not found yet.'
              : 'No maintenance request linked to this alert yet.',
          );
        }
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setLinkedRequest(null);
        setLinkedRequestStatus('error');
        setLinkedRequestError(error?.message || 'Failed to load maintenance progress');
      });

    return () => { cancelled = true; };
  }, [kind, selectedFloodAlert, device.ownerId, device.propertyId]);

  const submitRename = async () => {
    if (!onRenameDevice || !nameDraft.trim()) return;
    setSaving(true);
    try {
      await onRenameDevice(device, nameDraft.trim());
      setRenaming(false);
    } finally {
      setSaving(false);
    }
  };

  const isBleClimate = kind === 'ht' && (
    device.connectionType === 'bluetooth'
    || device.connectionType === 'bluetooth_gateway'
    || String(device.deviceId || '').toLowerCase().startsWith('blu-ht-')
  );
  const cloudIngestFresh = Boolean(
    device.lastCloudIngestAt
    && Date.now() - device.lastCloudIngestAt.getTime() < 5 * 60 * 1000,
  );

  const acknowledgeOpenAlerts = async () => {
    if (!onAcknowledgeAlert || openAlerts.length === 0) return;
    setAcknowledging(true);
    try {
      // Acknowledge newest first; flood clear runs per alert and is idempotent.
      for (const alert of openAlerts) {
        await onAcknowledgeAlert(alert.id);
      }
    } finally {
      setAcknowledging(false);
    }
  };

  const openSensorTicket = () => {
    if (!ticketAlert) return;
    setTicketError(null);
    setTicketDraft(buildSensorMaintenanceDraft({
      device,
      alert: ticketAlert,
      propertyAddress,
      roomLabel,
    }));
  };

  const submitSensorTicket = async () => {
    if (!ticketDraft || !ticketAlert) return;
    if (!ticketDraft.ownerId) {
      setTicketError('Assign this sensor to an owner before creating a maintenance ticket.');
      return;
    }
    setTicketSubmitting(true);
    setTicketError(null);
    try {
      const result = await submitMaintenanceRequest(ticketDraft);
      const requestId = result.request.firestoreId || result.request.id;
      setSubmittedTicketId(requestId);
      setTicketDraft(null);
    } catch (error) {
      setTicketError(error instanceof Error ? error.message : 'Could not create the maintenance ticket.');
    } finally {
      setTicketSubmitting(false);
    }
  };

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-y-auto rounded-2xl border border-blue-200 bg-white/90 p-4 shadow-[0_14px_40px_rgba(30,64,175,0.10)] backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1.5">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(); if (e.key === 'Escape') setRenaming(false); }}
                autoFocus
                disabled={saving}
                className="w-full rounded-lg border border-blue-200 px-2 py-1 text-sm font-semibold text-slate-800 focus:border-blue-400 focus:outline-none"
              />
              <button onClick={() => void submitRename()} className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-bold text-white">{saving ? '…' : 'Save'}</button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-bold text-slate-900">{device.name}</h3>
              {onRenameDevice && (
                <button onClick={() => { setNameDraft(device.name || ''); setRenaming(true); }} className="rounded p-1 text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="Rename">
                  <Pencil size={12} />
                </button>
              )}
            </div>
          )}
          <p className="mt-0.5 truncate text-[11px] text-slate-500">{device.location || device.deviceId}</p>
        </div>
        <button onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-slate-50">Close</button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" style={{ color: TONE_COLOR[tone], backgroundColor: `${TONE_COLOR[tone]}18`, border: `1px solid ${TONE_COLOR[tone]}55` }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TONE_COLOR[tone] }} />
          {TONE_LABEL[tone]}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
          {device.connectionType === 'bluetooth' || device.connectionType === 'bluetooth_gateway' ? <Bluetooth size={10} /> : <Wifi size={10} />}
          {device.connectionType === 'bluetooth' || device.connectionType === 'bluetooth_gateway' ? 'BLE via gateway' : 'Wi-Fi'}
        </span>
        {isBleClimate && (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              cloudIngestFresh
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-amber-200 bg-amber-50 text-amber-700'
            }`}
            title={cloudIngestFresh
              ? `Cloud ingestion confirmed${device.collectorVersion ? ` · ${device.collectorVersion}` : ''}`
              : 'No recent direct reading at the cloud collector; telemetry may depend on the local gateway fallback'}
          >
            <Cloud size={10} />
            {cloudIngestFresh ? 'Cloud synced' : 'Cloud unverified'}
          </span>
        )}
        {device.model && <span className="rounded-full border border-slate-100 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-500">{device.model}</span>}
      </div>

      {openAlerts.length > 0 && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="font-bold">{openAlerts.length} open alert{openAlerts.length > 1 ? 's' : ''}:</span>{' '}
              {openAlerts[0].message}
            </div>
            {showAcknowledge && (
              <button
                type="button"
                onClick={() => void acknowledgeOpenAlerts()}
                disabled={acknowledging}
                className="shrink-0 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                {acknowledging ? '…' : 'Acknowledge'}
              </button>
            )}
          </div>
          {submittedTicketId ? (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-white/80 px-2.5 py-2 text-emerald-700">
              <span className="font-semibold">Maintenance ticket created</span>
              <Link
                to="/property-management?section=maintenance"
                className="shrink-0 font-bold underline underline-offset-2"
              >
                Track ticket
              </Link>
            </div>
          ) : !linkedRequest && (
            <button
              type="button"
              onClick={openSensorTicket}
              className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-300 bg-white px-2.5 py-2 text-[10px] font-bold uppercase tracking-wide text-rose-700 hover:bg-rose-100"
            >
              <Wrench size={12} />
              Review prefilled maintenance ticket
            </button>
          )}
          {openFloodAlerts.length > 0 && (
            <p className="mt-1.5 text-[10px] text-rose-600/80">
              Acknowledging clears the flood warning animation on the twin.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {device.temperature != null && (
          <DetailMetric label="Temperature">{device.temperature.toFixed(1)}°C / {((device.temperature * 9) / 5 + 32).toFixed(0)}°F</DetailMetric>
        )}
        {device.humidity != null && (
          <DetailMetric label="Humidity">
            <span className={device.humidity >= 70 ? 'text-rose-600' : device.humidity >= 60 ? 'text-amber-600' : 'text-emerald-600'}>{device.humidity.toFixed(0)}% RH</span>
          </DetailMetric>
        )}
        {(kind === 'flood') && (
          <DetailMetric label="Leak status">
            <span className={hasActiveFloodWarning(device, alerts) ? 'text-rose-600' : 'text-emerald-600'}>
              {hasActiveFloodWarning(device, alerts) ? 'Water detected' : 'Clear'}
            </span>
          </DetailMetric>
        )}
        {(kind === 'flood') && (
          <DetailMetric label="Leak events">
            {leakEventCount > 0
              ? `${leakEventCount} logged · ${acknowledgedLeakCount} cleared`
              : 'None yet'}
          </DetailMetric>
        )}
        {kind === 'relay' && (
          <>
            <DetailMetric label="Valve state">{valveMotion.state === 'opening' ? 'Opening' : valveMotion.state === 'closing' ? 'Closing' : valveMotion.state === 'open' ? 'Open' : valveMotion.state === 'closed' ? 'Closed' : 'Unknown'}</DetailMetric>
            <DetailMetric label="Relay output">
              <span className={device.relayOutputOn ? 'text-amber-600' : 'text-emerald-600'}>{device.relayOutputOn ? 'Energized' : 'Idle'}</span>
            </DetailMetric>
            <DetailMetric label="Last command">{device.lastValveCommand ? `${device.lastValveCommand} · ${formatWhen(device.lastValveCommandAt)}` : 'None yet'}</DetailMetric>
            <DetailMetric label="Actuation">{device.actuationMode === 'momentary' ? 'Momentary pulse' : 'Maintained contact'}</DetailMetric>
          </>
        )}
        {isBatteryPoweredDevice(device) && (
          <DetailMetric label="Battery">
            {device.batteryPercent != null ? (
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-100">
                  <span className={`block h-full rounded-full ${device.batteryPercent > 20 ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${Math.max(0, Math.min(100, device.batteryPercent))}%` }} />
                </span>
                {device.batteryPercent}%
              </span>
            ) : (
              <span className="text-slate-500">— waiting for live reading</span>
            )}
          </DetailMetric>
        )}
        {device.wifiRssi != null && <DetailMetric label="Signal">{device.wifiRssi} dBm</DetailMetric>}
        <DetailMetric label="Last check-in">{formatWhen(device.lastUpdate || device.lastSeen)}</DetailMetric>
      </div>

      {kind === 'relay' && valveMotion.progress != null && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-amber-800">
            <span>{valveMotion.state === 'closing' ? 'Closing travel' : 'Opening travel'}</span>
            <span>{Math.round(valveMotion.progress)}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/90">
            <div
              className={valveMotion.state === 'closing' ? 'h-full rounded-full bg-amber-500' : 'h-full rounded-full bg-sky-500'}
              style={{ width: `${valveMotion.progress}%`, transition: 'width 180ms linear' }}
            />
          </div>
          <div className="mt-1 text-[10px] text-amber-700">
            {Math.max(1, Math.ceil((valveMotion.travelMs * (100 - valveMotion.progress)) / 100 / 1000))}s remaining · water flow is {Math.round(valveMotion.openness * 100)}%
          </div>
        </div>
      )}

      {device.capabilities && device.capabilities.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {device.capabilities.map((cap) => (
            <span key={cap} className="rounded-full border border-blue-100 bg-blue-50/60 px-2 py-0.5 text-[10px] text-blue-600">{cap}</span>
          ))}
        </div>
      )}

      {kind === 'flood' && (
        <div className="mt-3 space-y-3">
          {selectedFloodAlert && (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              {linkedRequestStatus === 'error' && !linkedRequest && (
                <p className="mb-2 text-[11px] text-rose-600">{linkedRequestError || 'Could not load maintenance details.'}</p>
              )}
              <FloodDispatchFeed
                request={linkedRequest}
                alertMessage={selectedFloodAlert.message}
              />
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50/80">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <Droplets size={12} className="text-sky-600" />
                Flood &amp; leak history
              </div>
              <span className="text-[10px] font-semibold text-slate-400">
                {leakEventCount === 0 ? 'No events' : `${leakEventCount} event${leakEventCount === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="max-h-44 space-y-1.5 overflow-y-auto p-2">
              {floodHistory.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-[11px] text-slate-400">
                  No flood or leak detections logged yet. Events stay here after you acknowledge them.
                </div>
              )}
              {floodHistory.map((alert) => {
                const selected = alert.id === selectedAlertId;
                return (
                  <button
                    key={alert.id}
                    type="button"
                    onClick={() => setSelectedAlertId(alert.id)}
                    className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                      selected
                        ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-200'
                        : alert.acknowledged
                          ? 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                          : 'border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold">
                          {alert.type === 'flood' ? 'Flood / leak detected' : alert.message}
                        </div>
                        <div className="mt-0.5 text-[10px] opacity-80">{formatWhen(alert.timestamp)}</div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                          alert.acknowledged
                            ? 'bg-slate-100 text-slate-500'
                            : 'bg-rose-100 text-rose-700'
                        }`}
                      >
                        {alert.acknowledged ? 'Cleared' : 'Open'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
            {floodHistory.length > 0 && (
              <div className="border-t border-slate-200 px-3 py-1.5 text-[10px] text-slate-400">
                Select an alert for issue &amp; provider details
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-auto space-y-2 pt-4">
        {showAcknowledge && (
          <button
            type="button"
            onClick={() => void acknowledgeOpenAlerts()}
            disabled={acknowledging}
            className="w-full rounded-xl border border-rose-300 bg-rose-600 px-3 py-2.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {acknowledging
              ? 'Acknowledging…'
              : openFloodAlerts.length > 0
                ? `Acknowledge flood alert${openFloodAlerts.length > 1 ? 's' : ''}`
                : `Acknowledge alert${openAlerts.length > 1 ? 's' : ''}`}
          </button>
        )}
        {kind === 'relay' && onValveCommand && (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onValveCommand(device, 'open')}
              disabled={pendingValve || device.status !== 'online' || device.valveState === 'open'}
              className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {device.status === 'offline'
                ? 'Offline'
                : device.status !== 'online'
                  ? 'Checking…'
                  : device.valveState === 'open'
                    ? 'Already open'
                    : pendingValve
                      ? 'Working…'
                      : 'Open Valve'}
            </button>
            <button
              onClick={() => onValveCommand(device, 'close')}
              disabled={pendingValve || device.status !== 'online' || device.valveState === 'closed'}
              className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {device.status === 'offline'
                ? 'Offline'
                : device.status !== 'online'
                  ? 'Checking…'
                  : device.valveState === 'closed'
                    ? 'Already closed'
                    : pendingValve
                      ? 'Working…'
                      : 'Close Valve'}
            </button>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {kind === 'relay' && onReconnectRelay && (
            <button onClick={() => onReconnectRelay(device)} className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100">
              Reconnect Remote
            </button>
          )}
          {kind === 'flood' && onReconfigureFlood && (
            <button onClick={() => onReconfigureFlood(device)} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100">
              Reconfigure Alerts
            </button>
          )}
          {onUnassignDevice && (
            <button onClick={() => onUnassignDevice(device)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
              Unassign
            </button>
          )}
          {onDeleteDevice && (
            <button
              onClick={() => onDeleteDevice(device)}
              disabled={deletingDeviceId === device.id}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
            >
              <Trash2 size={11} />
              {deletingDeviceId === device.id ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* ── room detail panel ──────────────────────────────────────────── */

function RoomDetailPanel({
  room,
  devices,
  alerts,
  exposure,
  onSelectDevice,
  onClose,
}: {
  room: RoomDef;
  devices: Array<{ device: ShellyDevice; kind: TopologyDeviceKind; confidence: RoomInference['confidence'] }>;
  alerts: ShellyAlert[];
  /** Set when a leak elsewhere may have reached this room. */
  exposure?: LeakExposure;
  onSelectDevice: (deviceId: string) => void;
  onClose: () => void;
}) {
  const temps = devices
    .map((d) => d.device.temperatureF)
    .filter((t): t is number => t != null && Number.isFinite(t));
  const humidities = devices
    .map((d) => d.device.humidity)
    .filter((h): h is number => h != null && Number.isFinite(h));
  const wet = devices.some((d) => hasActiveFloodWarning(d.device, alerts));
  const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const avgRh = humidities.length ? humidities.reduce((a, b) => a + b, 0) / humidities.length : null;

  return (
    <aside className="flex h-full flex-col gap-3 rounded-2xl border border-blue-100 bg-white p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-blue-500">Room</p>
          <h3 className="text-base font-bold text-slate-900">{room.label}</h3>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-50"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <DetailMetric label="Temperature">
          {avgTemp != null ? `${Math.round(avgTemp)}°F` : '—'}
        </DetailMetric>
        <DetailMetric label="Humidity">
          {avgRh != null ? `${Math.round(avgRh)}% RH` : '—'}
        </DetailMetric>
      </div>

      <div
        className={`rounded-xl border px-3 py-2 text-[12px] font-semibold ${
          wet ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}
      >
        {wet ? 'Water detected in this room' : 'No leak detected'}
      </div>

      {/*
        Why this room is flagged.
        
        A hatch on the drawing without a stated basis is just an alarming
        colour, so the panel always carries the sentence the propagation model
        produced. Shown even when this room has its own sensor reporting dry,
        because "dry sensor, but it sits under the leak" is exactly the case
        where someone needs to go and look anyway.
      */}
      {exposure && exposure.tier !== 'source' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
            {TIER_LABEL[exposure.tier]}
          </p>
          <p className="mt-1 text-[11.5px] font-medium leading-snug text-amber-900">
            {exposure.reason}
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Devices ({devices.length})
        </p>
        {devices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-[12px] text-slate-500">
            Nothing here yet. Drag a device pin into this room to place it.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {devices.map(({ device, kind, confidence }) => (
              <li key={device.id}>
                <button
                  onClick={() => onSelectDevice(device.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 px-2.5 py-2 text-left transition hover:border-blue-300 hover:bg-blue-50/60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-semibold text-slate-800">
                      {device.name || device.deviceId}
                    </span>
                    <span className="block truncate text-[11px] text-slate-500">
                      {deviceStatusLine(device, kind, alerts)}
                    </span>
                  </span>
                  {confidence !== 'assigned' && (
                    <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-700">
                      Guessed
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/* ── network summary (default panel) ────────────────────────────── */

function deviceStatusLine(device: ShellyDevice, kind: TopologyDeviceKind, alerts: ShellyAlert[] = []) {
  if (kind === 'ht') {
    const temp = device.temperatureF != null
      ? `${Math.round(device.temperatureF)}°F`
      : device.temperature != null
        ? `${Math.round((device.temperature * 9) / 5 + 32)}°F`
        : null;
    const rh = device.humidity != null ? `${Math.round(device.humidity)}% RH` : null;
    if (temp || rh) return [temp, rh].filter(Boolean).join(' · ');
  }
  if (kind === 'flood') {
    if (hasActiveFloodWarning(device, alerts)) return 'Water detected';
    if (device.status === 'offline') return 'Offline — no recent check-in';
    if (device.status === 'unknown') return 'Sleeping — battery save mode';
    return 'Dry · monitoring';
  }
  if (kind === 'relay') {
    if (device.valveState === 'open') return 'Valve open';
    if (device.valveState === 'closed') return 'Valve closed';
    return device.relayOutputOn ? 'Relay energized' : 'Relay idle';
  }
  if (kind === 'gateway') return 'Wi-Fi ⇄ Bluetooth bridge';
  return TONE_LABEL[deviceTone(device, alerts)];
}

function NetworkSummaryPanel({
  devices,
  alerts,
  weatherAssessment,
  weatherLoading,
  floodStage,
  floodScenarioLabel,
  coastalSurge,
  governingHazard,
  lotFlow,
  activeLayer,
  onSelectDevice,
  onSelectWeather,
  onAddDevice,
  onZoomToLayer,
}: {
  devices: ShellyDevice[];
  alerts: ShellyAlert[];
  weatherAssessment?: ExtremeWeatherAssessment | null;
  weatherLoading?: boolean;
  floodStage?: FloodStage | null;
  floodScenarioLabel?: string | null;
  coastalSurge?: CoastalSurge | null;
  governingHazard?: 'coastal_surge' | 'rainfall' | 'none_modelled' | null;
  lotFlow?: LotFlow | null;
  activeLayer?: TwinLayer;
  onSelectDevice?: (deviceId: string) => void;
  onSelectWeather?: () => void;
  onAddDevice?: (deviceType?: SetupDeviceType) => void;
  onZoomToLayer?: (layer: TwinLayer) => void;
}) {
  const [expanded, setExpanded] = useState<Partial<Record<TopologyDeviceKind, boolean>>>({});
  const online = devices.filter((d) => d.status === 'online').length;
  const open = alerts.filter((a) => !a.acknowledged).length;
  const weatherTone = weatherRiskTone(weatherAssessment?.overallRisk);
  const weatherColor = TONE_COLOR[weatherTone];
  const kinds: Array<{ kind: TopologyDeviceKind; label: string; icon: ReactNode; setupType: SetupDeviceType }> = [
    { kind: 'ht', label: 'Climate sensors', icon: <Thermometer size={13} />, setupType: 'ht' },
    { kind: 'flood', label: 'Leak sensors', icon: <Droplets size={13} />, setupType: 'flood' },
    { kind: 'relay', label: 'Shutoff valves', icon: <Waves size={13} />, setupType: 'relay' },
    { kind: 'gateway', label: 'BLE bridges', icon: <Bluetooth size={13} />, setupType: 'gateway' },
  ];

  return (
    <aside className="flex h-full flex-col rounded-2xl border border-blue-200 bg-white/85 p-4 shadow-[0_14px_40px_rgba(30,64,175,0.08)] backdrop-blur">
      <div className="flex items-center gap-2 text-blue-800">
        <Network size={15} />
        <h3 className="text-sm font-bold">Network health</h3>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">Select any device on the map — or expand a category below — to see live readings and controls.</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <DetailMetric label="Devices live"><span className="text-cyan-700">{online}/{devices.length}</span></DetailMetric>
        <DetailMetric label="Open alerts"><span className={open ? 'text-rose-600' : 'text-emerald-600'}>{open}</span></DetailMetric>
      </div>
      <button
        type="button"
        onClick={() => onSelectWeather?.()}
        className="mt-2 flex w-full items-center justify-between gap-2 rounded-xl border border-sky-100 bg-sky-50/60 px-2.5 py-2 text-left hover:bg-sky-50"
      >
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
          <Cloud size={13} className="text-sky-600" />
          Outdoor conditions
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold" style={{ color: weatherColor }}>
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: weatherColor }} />
          {weatherLoading && !weatherAssessment
            ? 'Loading…'
            : weatherAssessment
              ? weatherRiskLabel(weatherAssessment.overallRisk)
              : '—'}
        </span>
      </button>
      {/* What the modelled water actually reaches. Ordered by elevation, so it
          reads as a sequence of consequences rather than a list of warnings. */}
      {floodStage && (
        <div className="mt-2 rounded-xl border border-blue-100 bg-blue-50/60 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-blue-900">
              <Droplets size={13} className="text-blue-600" />
              {floodStage.source === 'sensor' ? 'Water detected' : 'Modelled flood'}
            </span>
            <span className="text-[11px] font-bold text-blue-800">{floodStage.headline}</span>
          </div>

          {floodStage.source === 'surface' && (
            <div className="mt-1 text-[10px] leading-snug text-slate-600">
              {floodScenarioLabel ? `${floodScenarioLabel}. ` : ''}
              {floodStage.levelFt.toFixed(1)} ft above the basement slab.
            </div>
          )}

          {floodStage.reached.length > 0 && (
            <ul className="mt-2 space-y-1">
              {floodStage.reached.map((t) => (
                <li key={t.id} className="flex items-start gap-1.5">
                  <span
                    className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${
                      t.severity === 'critical'
                        ? 'bg-rose-500'
                        : t.severity === 'warn' ? 'bg-amber-500' : 'bg-slate-400'
                    }`}
                  />
                  <span className="text-[10px] leading-snug">
                    <span className="font-semibold text-slate-800">{t.label}</span>
                    <span className="text-slate-500"> — {t.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {floodStage.next && (
            <div className="mt-1.5 border-t border-blue-100 pt-1.5 text-[10px] text-slate-500">
              Next at {floodStage.next.levelFt.toFixed(1)} ft above the slab:{' '}
              <span className="font-semibold text-slate-700">{floodStage.next.label}</span>
            </div>
          )}

          <div className="mt-1.5 text-[9px] italic leading-snug text-slate-400">
            Equipment heights are typical installation heights, not a survey of this house.
          </div>
        </div>
      )}

      {/* Coastal exposure stands alone from any simulated storm: the rainfall
          model can look dry while surge is still the hazard that matters. */}
      {coastalSurge?.exposed && coastalSurge.freeboardAboveMhhwFt != null && (
        <div className={`mt-2 rounded-xl border p-2.5 ${
          governingHazard === 'coastal_surge'
            ? 'border-rose-200 bg-rose-50/70'
            : 'border-slate-200 bg-slate-50/70'
        }`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-slate-800">Coastal storm surge</span>
            {governingHazard === 'coastal_surge' && (
              <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[9px] font-bold text-white">
                GOVERNING
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] leading-snug text-slate-600">
            {coastalSurge.freeboardAboveMhhwFt} ft above mean higher high water
            {coastalSurge.station?.name ? ` · ${coastalSurge.station.name}` : ''}.
            {coastalSurge.firstWettingCategory
              ? ` Category ${coastalSurge.firstWettingCategory}+ puts water on the property.`
              : ' No modelled hurricane category reaches the property.'}
          </div>
          {onZoomToLayer && activeLayer === 'interior' && (
            <button
              type="button"
              onClick={() => onZoomToLayer('neighborhood')}
              className="mt-1.5 text-[10px] font-bold text-blue-600 hover:underline"
            >
              See neighborhood flood extent →
            </button>
          )}
        </div>
      )}

      {lotFlow?.homeFall && activeLayer !== 'lot' && (
        <div className="mt-2 rounded-xl border border-sky-100 bg-sky-50/50 p-2.5">
          <div className="text-[11px] font-bold text-slate-800">Yard drainage</div>
          <div className="mt-1 text-[10px] leading-snug text-slate-600">
            Ground falls {bearingToCompass(lotFlow.homeFall.bearingDeg)} at{' '}
            {lotFlow.homeFall.slopePct}% grade.
            {lotFlow.drainageCrossesLot
              ? ' A drainage channel crosses this lot.'
              : ''}
          </div>
          {onZoomToLayer && (
            <button
              type="button"
              onClick={() => onZoomToLayer('lot')}
              className="mt-1.5 text-[10px] font-bold text-blue-600 hover:underline"
            >
              Open lot view →
            </button>
          )}
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {kinds.map(({ kind, label, icon, setupType }) => {
          const kindDevices = devices.filter((d) => deviceKind(d) === kind);
          const count = kindDevices.length;
          const kindOnline = kindDevices.filter((d) => d.status === 'online').length;
          const kindSleeping = kindDevices.filter((d) => d.status === 'unknown').length;
          const isOpen = Boolean(expanded[kind]);
          const countLabel = count === 0
            ? 'None'
            : kind === 'flood' && kindSleeping > 0
              ? `${kindOnline}/${count} live${kindSleeping ? ` · ${kindSleeping} sleeping` : ''}`
              : `${kindOnline}/${count} live`;
          return (
            <div key={kind} className="overflow-hidden rounded-xl border border-blue-100 bg-blue-50/40">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [kind]: !prev[kind] }))}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-blue-50/80"
              >
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
                  <span className="text-blue-600">{icon}</span>
                  {label}
                  <ChevronDown size={12} className={`text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </span>
                <span className={`text-[11px] font-bold ${count === 0 ? 'text-slate-400' : kindOnline === count ? 'text-cyan-700' : 'text-amber-600'}`}>
                  {countLabel}
                </span>
              </button>
              {isOpen && (
                <div className="space-y-1 border-t border-blue-100/80 bg-white/70 px-2 py-1.5">
                  {kindDevices.length === 0 ? (
                    <div className="flex items-center justify-between gap-2 px-1 py-1">
                      <span className="text-[10.5px] text-slate-400">No devices in this category yet</span>
                      {onAddDevice && (
                        <button
                          type="button"
                          onClick={() => onAddDevice(setupType)}
                          className="rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 hover:bg-blue-100"
                        >
                          Add
                        </button>
                      )}
                    </div>
                  ) : (
                    kindDevices.map((device) => {
                      const tone = deviceTone(device, alerts);
                      return (
                        <button
                          key={device.id}
                          type="button"
                          onClick={() => onSelectDevice?.(device.id)}
                          className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-blue-50"
                        >
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: TONE_COLOR[tone] }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-semibold text-slate-800">{device.name || device.deviceId}</span>
                            <span className="block truncate text-[10px] text-slate-500">{deviceStatusLine(device, kind, alerts)}</span>
                          </span>
                          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide" style={{ color: TONE_COLOR[tone] }}>
                            {TONE_LABEL[tone]}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-auto space-y-2 pt-4">
        <div className="space-y-1.5 text-[10.5px] text-slate-500">
          <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-cyan-500" /> Live · pulses travel along active links</div>
          <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" /> Attention needed</div>
          <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-500" /> Critical</div>
          <div className="flex items-center gap-1.5"><Unplug size={11} /> Offline or unconfirmed</div>
        </div>
        {onAddDevice && (
          <button
            type="button"
            onClick={() => onAddDevice()}
            className="ml-auto flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-600 px-3 py-2 text-[11px] font-bold text-white shadow-sm hover:bg-blue-700"
          >
            <Plus size={13} />
            Add Device
          </button>
        )}
      </div>
    </aside>
  );
}

/* ── main component ─────────────────────────────────────────────── */

export default function DeviceTopologyMap({
  devices,
  alerts,
  properties = [],
  selectedPropertyId,
  onSelectProperty,
  activeValveCommand,
  valveCommandMessage,
  onValveCommand,
  onRenameDevice,
  onAssignRoom,
  onAssignUnit,
  onUnassignDevice,
  onDeleteDevice,
  onReconfigureFlood,
  onReconnectRelay,
  onAcknowledgeAlert,
  onAddDevice,
  deletingDeviceId,
  floodDepthAtGradeFt = null,
  floodScenarioLabel = null,
  healthAssets = [],
  onOpenHealthAsset,
}: DeviceTopologyMapProps) {
  /**
   * Which overlay the interior is showing. Devices and health pins occupy the
   * same rooms and would sit on top of each other, so they take turns rather
   * than both being switches you can leave on.
   */
  const [overlayMode, setOverlayMode] = useState<'devices' | 'health'>('devices');
  const [selectedHealthAssetId, setSelectedHealthAssetId] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);
  const [hoveredDeviceId, setHoveredDeviceId] = useState<string | null>(null);
  const [powerPanelOpen, setPowerPanelOpen] = useState(false);
  const [weatherPanelOpen, setWeatherPanelOpen] = useState(false);
  const [utilityStatusByState, setUtilityStatusByState] = useState<Record<string, UtilityOutageStatus>>({});
  const [weatherAssessment, setWeatherAssessment] = useState<ExtremeWeatherAssessment | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{
    deviceId: string;
    x: number;
    y: number;
    roomId: string | null;
    unitId: string | null;
    /**
     * Where the press started, in client pixels.
     *
     * The drag/tap decision is made in screen space rather than SVG user units.
     * A user-unit threshold is a different physical distance at every zoom level
     * and every canvas width — at the resting camera on a phone, 10 user units
     * is under 3 px, so ordinary finger jitter on a tap silently reassigned the
     * device to another room and wrote that to Firestore. Client pixels are the
     * only frame in which "did the user intend to drag this" is a fixed question.
     */
    originClientX: number;
    originClientY: number;
  } | null>(null);
  /** Optimistic placements so a dropped pin lands instantly, before Firestore echoes back. */
  const [pendingRooms, setPendingRooms] = useState<Record<string, string>>({});

  const relays = useMemo(() => devices.filter((d) => deviceKind(d) === 'relay'), [devices]);
  const primaryRelay = relays[0];
  const onlineCount = devices.filter((d) => d.status === 'online').length;
  const activeAlerts = alerts.filter((a) => !a.acknowledged);
  const hasGateway = devices.some((d) => deviceKind(d) === 'gateway');

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) || null;
  const selectedProperty = properties.find((p) => p.id === selectedPropertyId);
  const propertyLabel = selectedPropertyId && selectedPropertyId !== 'all'
    ? selectedProperty?.address || 'Property'
    : properties.length === 1 ? properties[0]?.address : 'All properties';
  const wireframeOption = selectedPropertyId && selectedPropertyId !== 'all' ? selectedProperty : properties[0];

  const siteQuery = useSiteModel({
    propertyId: wireframeOption?.id,
    address: wireframeOption?.address,
    attomId: wireframeOption?.attomId,
    option: wireframeOption,
    apiBase: getDevApiBaseUrl(),
  });
  const siteModel = siteQuery.model;
  /*
   * Houses stay on the archetypal dollhouse. The measured footprint still
   * drives Lot, but stretching the section to a public outline made every
   * address look like a different building and put rooms where the kit's
   * sensors were never meant to sit. Until interiors are real, the cutaway
   * is a standard single-family diagram that flexes only with bed count.
   *
   * The cutaway still turns: `projectHouse` re-plans rooms into near and far
   * ranks as the camera yaws, which is what turning a cutaway actually means.
   * Pitch stays fixed at the drawing's authored cabinet.
   */
  const houseModel = useMemo(
    () => archetypeSiteModel(wireframeOption),
    [wireframeOption?.address, wireframeOption?.beds, wireframeOption?.baths],
  );
  const [orbitDragging, setOrbitDragging] = useState(false);
  const [houseOrbit, setHouseOrbit] = useState<Orbit>(HOUSE_FRONT);
  const liveHouseOrbit = useOrbitTween(houseOrbit);
  const houseOrbitDrag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const projectedHouse = useMemo(
    () => projectHouse(houseModel, houseCameraFor(houseModel, liveHouseOrbit.yaw)),
    [houseModel, liveHouseOrbit.yaw],
  );
  const rooms = projectedHouse.rooms;
  const houseShell = projectedHouse.shell;
  const houseBands = projectedHouse.bands;
  const serviceHead = useMemo(() => {
    const meterX = houseShell.wallRight + DX + 10;
    const meterY = houseShell.grade - 1.5 * VERTICAL_UNITS_PER_M;
    return { x: meterX + 6, y: meterY - 20 - 0.4 * VERTICAL_UNITS_PER_M };
  }, [houseShell]);

  /*
   * ── multifamily ────────────────────────────────────────────────────
   *
   * A house and a building are drawn differently enough that they are two
   * components, but everything around them — pins, camera, leak model, coverage,
   * the side panel — is shared. So the choice is made once here and the rest of
   * the component branches on `isBuilding` rather than being duplicated.
   */
  const buildingModel = useBuildingModel({
    propertyId: wireframeOption?.id,
    derived: wireframeOption?.buildingGeometry,
    address: wireframeOption?.address,
    attomId: wireframeOption?.attomId,
    apiBase: getDevApiBaseUrl(),
  });
  /*
   * Only a building when we have a reason to think it is one.
   *
   * `specFromDerivation(null)` falls back to a 3-floor walk-up so the editor has
   * something to correct — which is right for the form and disastrous as a
   * default drawing. Without a saved plan or an ATTOM seed, this is a house.
   */
  const isBuilding = shouldDrawAsBuilding(buildingModel.spec, buildingModel.confirmed)
    && (buildingModel.confirmed || buildingModel.hasSeed);
  const building = useMemo(() => buildBuilding(buildingModel.spec), [buildingModel.spec]);

  // Optimistic drops are folded in here so the pin moves on release rather than
  // waiting for the Firestore snapshot to come back around.
  const devicesWithPlacement = useMemo(
    () => devices.map((d) => (pendingRooms[d.id] ? { ...d, twinRoomId: pendingRooms[d.id] } : d)),
    [devices, pendingRooms],
  );

  /*
   * The mechanical assembly is drawn on the basement service run, so a layout
   * without a basement has nowhere to put it. It used to be drawn anyway, at
   * fixed coordinates, which left a metre of copper and a motorised valve
   * floating in the lawn below a condo. Where there is no service run to mount
   * it on, the relay is just another device and takes an ordinary pin.
   */
  const hasBasement = useMemo(() => rooms.some((r) => r.floor === 'basement'), [rooms]);
  const assemblyRelay = hasBasement ? primaryRelay : undefined;

  const { nodes, router } = useMemo(
    () => layoutDevicesInRooms(devicesWithPlacement, rooms, assemblyRelay?.id ?? null),
    [devicesWithPlacement, rooms, assemblyRelay],
  );

  // Drop the optimistic override once the real record agrees with it.
  useEffect(() => {
    setPendingRooms((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [deviceId, roomId] of Object.entries(prev)) {
        if (devices.find((d) => d.id === deviceId)?.twinRoomId === roomId) {
          delete next[deviceId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [devices]);

  const nodeByDeviceId = useMemo(
    () => new Map(nodes.map((n) => [n.device.id, n])),
    [nodes],
  );

  const roomTints = useMemo(() => {
    const tints: Record<string, string | undefined> = {};
    rooms.forEach((room) => {
      const inRoom = nodes.filter((n) => n.roomId === room.id);
      const temps = inRoom
        .map((n) => n.device.temperatureF)
        .filter((t): t is number => t != null && Number.isFinite(t));
      if (temps.length === 0) return;
      const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
      tints[room.id] = comfortTint(avg) ?? undefined;
    });
    return tints;
  }, [rooms, nodes]);

  const alertRooms = useMemo(() => {
    const set = new Set<string>();
    nodes.forEach((node) => {
      if (deviceTone(node.device, alerts) === 'critical') set.add(node.roomId);
    });
    return set;
  }, [nodes, alerts]);

  const occupiedRooms = useMemo(
    () => new Set(nodes.map((n) => n.roomId)),
    [nodes],
  );

  /*
   * Rooms where a leak sensor is actually reporting water.
   *
   * Deliberately narrower than `alertRooms`, which also covers freeze and
   * humidity criticals. Water is the only condition that travels, so it is the
   * only one allowed to seed an exposure claim about another room.
   */
  const wetRooms = useMemo(() => {
    const set = new Set<string>();
    nodes.forEach((node) => {
      if (hasActiveFloodWarning(node.device, alerts)) set.add(node.roomId);
    });
    return set;
  }, [nodes, alerts]);

  /**
   * Minutes since the oldest still-open flood alert.
   *
   * Recomputed whenever the live alert feed changes rather than on a timer: the
   * spread ramp saturates within the hour, so sub-minute freshness buys nothing.
   */
  const minutesSinceLeak = useMemo(() => {
    const open = alerts.filter((a) => (
      (a.type === 'flood' || a.type === 'pipe_burst') && !a.acknowledged && a.timestamp
    ));
    if (open.length === 0) return undefined;
    const oldest = Math.min(...open.map((a) => a.timestamp.getTime()));
    if (!Number.isFinite(oldest)) return undefined;
    return Math.max(0, (Date.now() - oldest) / 60000);
  }, [alerts]);

  /*
   * A wet below-grade leak sensor tells us water is present, not how deep it
   * is, so it draws a shallow sheet with no depth claim. A modelled storm depth
   * takes precedence when there is one, since that figure does carry a depth.
   */
  const basementWater = useMemo(
    () => nodes.some((node) => (
      roomById(rooms, node.roomId)?.floor === 'basement'
      && hasActiveFloodWarning(node.device, alerts)
    )),
    [nodes, rooms, alerts],
  );

  /**
   * Storm preview is opt-in and off by default. This is a *live* view of the
   * house, so painting a hypothetical flood across it unasked would read as a
   * real event. The user picks a storm to simulate; otherwise only actual sensor
   * readings put water in the drawing.
   *
   * One selection drives all three rungs of the zoom ladder, so a storm chosen
   * on the map is still the storm flooding the cutaway when you zoom in.
   */
  const [hazardSelection, setHazardSelection] = useState<HazardSelection>({ kind: 'live' });

  /** Which rung of the ladder is showing. */
  const [layer, setLayer] = useState<TwinLayer>('interior');

  /** Distribution runs through the cutaway, switched separately so the section
      never has to carry both networks at once. */
  const [showWater, setShowWater] = useState(true);
  const [showPower, setShowPower] = useState(false);
  /*
   * Coverage gaps are off by default, unlike water.
   *
   * They are a property of the install rather than of today, so leaving them on
   * would put permanent "you are missing sensors" marks on a section whose job
   * the rest of the time is to show what the sensors are reporting. It is a
   * question you go and ask.
   */
  const [showCoverage, setShowCoverage] = useState(false);

  /* ── multifamily view state ──────────────────────────────────────── */

  /**
   * Which facade is on screen. Two discrete states rather than an angle, because
   * the far side is reached by turning the building around, not by orbiting it.
   */
  const [buildingSide, setBuildingSide] = useState<BuildingSide>('A');
  /**
   * Which drawing is on screen.
   *
   * These are modes rather than rungs on the zoom ladder because each is a
   * different projection in its own coordinate space — a plan is not an elevation
   * seen from further away.
   *
   * `stack` is the default. The elevation was the default for as long as it was
   * the only drawing, and it is the weakest of the four for anything bigger than a
   * walk-up: it hides the far row of units behind the corridor and shows the
   * risers edge-on, which are the two things a manager needs during a leak. The
   * exploded plate stack shows every unit on every floor and draws the risers as
   * lines through all of them, so that is what opens.
   */
  const [buildingView, setBuildingView] = useState<'stack' | 'riser' | 'section' | 'exploded' | 'plate'>('stack');

  /*
   * The house has two drawings now, and they answer different questions.
   *
   * The cutaway is the working view — it is where the sensors, the plumbing and
   * the leak live, and it opens because that is what the page is for. The lot
   * view answers the one the cutaway cannot: whether this is *your* house. It is
   * the only view that shows the real outline, the outbuildings and which way the
   * building faces the street, so it is where a corrected footprint will show up
   * first.
   */
  const [houseView, setHouseView] = useState<'section' | 'site'>('section');
  const [siteOrbit, setSiteOrbit] = useState<Orbit>(SITE_ORBIT);
  const liveSiteOrbit = useOrbitTween(siteOrbit);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [hoveredUnitId, setHoveredUnitId] = useState<string | null>(null);
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
  const [stackEditorOpen, setStackEditorOpen] = useState(false);
  const [siteEditorOpen, setSiteEditorOpen] = useState(false);
  const [stackSaving, setStackSaving] = useState(false);
  /** Optimistic unit drops, the unit-keyed twin of `pendingRooms`. */
  const [pendingUnits, setPendingUnits] = useState<Record<string, string>>({});

  /*
   * Which way the last layer change travelled, so the transition can zoom in or
   * out to match. Derived during render rather than in an effect: the ref still
   * holds the previous rung on the render where `layer` changes, which is
   * exactly the render whose markup carries the animation class. Doing it in an
   * effect would land the class one render too late, after the keyed remount
   * that restarts the animation.
   */
  const previousLayer = useRef<TwinLayer>(layer);
  const zoomDirection = LAYER_ORDER.indexOf(layer) >= LAYER_ORDER.indexOf(previousLayer.current)
    ? 'in'
    : 'out';
  useEffect(() => { previousLayer.current = layer; }, [layer]);

  /*
   * Where the camera is pointed inside the section.
   *
   * A fourth rung below 'interior', but a different kind of one: the neighborhood,
   * lot and interior views are separate renderers, whereas a room and a device are
   * regions of the section's own coordinate space. So this is a real camera move
   * rather than a cut, and it is kept out of `layer` for that reason — nothing
   * about the rung has changed, only what part of it fills the frame.
   */
  const [focus, setFocus] = useState<TwinFocus>({ kind: 'house' });

  // Declared above the camera because a health pin is one of the things the
  // camera can be pointed at.
  const healthPins = useMemo(
    () => buildHealthPins(healthAssets, rooms),
    [healthAssets, rooms],
  );

  /**
   * Device pins placed in apartments.
   *
   * Declared above the camera because a device focus in a building frames the
   * apartment holding the sensor, and that lookup has to exist before the camera
   * memo runs. Only devices with an explicit `twinUnitId` are placed: guessing
   * from a name like "Bath Leak" would put a sensor in the wrong apartment, which
   * is a confident claim about somebody else's home.
   */
  const unitNodes = useMemo(() => {
    if (!isBuilding) return [];
    const placed = devices.map((device) => (
      pendingUnits[device.id] ? { ...device, twinUnitId: pendingUnits[device.id] } : device
    ));

    const byUnit = new Map<string, ShellyDevice[]>();
    for (const device of placed) {
      const inference = inferUnit(building, device);
      if (!inference) continue;
      const list = byUnit.get(inference.unitId);
      if (list) list.push(device);
      else byUnit.set(inference.unitId, [device]);
    }

    const out: Array<{ device: ShellyDevice; kind: TopologyDeviceKind; unitId: string; x: number; y: number }> = [];
    byUnit.forEach((inUnit, unitId) => {
      const unit = unitById(building, unitId);
      if (!unit) return;
      const anchors = anchorsFor(unit as unknown as RoomDef, inUnit.length);
      const dy = buildingView === 'exploded' ? explodeOffset(unit.level) : 0;
      inUnit.forEach((device, i) => {
        const at = anchors[i] ?? { x: unit.x + unit.w / 2, y: unit.y + unit.h / 2 };
        out.push({ device, kind: deviceKind(device), unitId, x: at.x, y: at.y + dy });
      });
    });
    return out;
  }, [isBuilding, building, devices, pendingUnits, buildingView]);

  useEffect(() => {
    setPendingUnits((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [deviceId, unitId] of Object.entries(prev)) {
        if (devices.find((d) => d.id === deviceId)?.twinUnitId === unitId) {
          delete next[deviceId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [devices]);

  /*
   * The building's own scene, which is a different size and a different shape from
   * the house canvas.
   *
   * The exploded view is taller than the section, so the extent has to follow the
   * view mode — framing the exploded drawing with the sectioned extent clamps the
   * camera above the lowest floor and quietly makes the basement unreachable.
   */
  const buildingCameraScene = useMemo(() => {
    const extent = buildingCutawayScene(
      building,
      buildingView === 'exploded' ? 'exploded' : 'section',
    );
    return buildingScene({ ...building, scene: extent });
  }, [building, buildingView]);

  const cameraTarget = useMemo(() => {
    if (layer !== 'interior') return HOUSE_CAMERA;

    /*
     * A building's rungs are resolved against its own scene, so this branches
     * before the house cases rather than after. The two coordinate spaces are not
     * interchangeable and a house camera applied to a building frames the sky.
     */
    if (isBuilding) {
      const buildingFocus: BuildingFocus = focus.kind === 'unit'
        ? { kind: 'unit', unitId: focus.unitId }
        : focus.kind === 'floor'
          ? { kind: 'floor', level: focus.level }
          : focus.kind === 'device'
            // A device focus lands on the apartment holding it: the unit is the
            // smallest thing in a building worth framing, and a close-up of a
            // sensor tells you nothing about whose home it is in.
            ? (() => {
              const node = unitNodes.find((n) => n.device.id === focus.deviceId);
              return node
                ? { kind: 'unit' as const, unitId: node.unitId }
                : { kind: 'building' as const };
            })()
            : { kind: 'building' };
      return cameraForBuildingFocus(
        { ...building, scene: buildingCameraScene },
        buildingFocus,
      );
    }

    if (focus.kind === 'device') {
      const node = nodeByDeviceId.get(focus.deviceId);
      return node ? cameraForDevice({ x: node.x, y: node.y }) : HOUSE_CAMERA;
    }
    if (focus.kind === 'room') {
      const room = rooms.find((r) => r.id === focus.roomId);
      return room ? cameraForRoom(room) : HOUSE_CAMERA;
    }
    return HOUSE_CAMERA;
  }, [layer, focus, nodeByDeviceId, rooms, isBuilding, building, buildingCameraScene, unitNodes]);

  const camera = useCameraTween(
    cameraTarget,
    undefined,
    isBuilding ? buildingCameraScene : undefined,
  );

  const focusedNode = useMemo(() => {
    if (focus.kind !== 'device') return null;
    if (isBuilding) {
      const node = unitNodes.find((entry) => entry.device.id === focus.deviceId);
      if (!node) return null;
      return {
        device: node.device,
        kind: node.kind,
        roomId: node.unitId,
        confidence: 'assigned' as const,
        x: node.x,
        y: node.y,
        linkFrom: { x: node.x, y: node.y },
        linkKind: 'wifi' as const,
      };
    }
    return nodeByDeviceId.get(focus.deviceId) ?? null;
  }, [focus, isBuilding, unitNodes, nodeByDeviceId]);

  const focusedHealthPin = focus.kind === 'health'
    ? healthPins.find((pin) => pin.asset.id === focus.assetId) ?? null
    : null;

  const focusedHealthRegion = useMemo(
    () => (focusedHealthPin ? componentRegion(focusedHealthPin.asset.category, rooms) : null),
    [focusedHealthPin, rooms],
  );

  /**
   * A device close-up throws the drawing out of focus behind it; a component
   * close-up does not.
   *
   * The difference is whether the thing being inspected is on the drawing. A
   * sensor is a pin standing in for an object the cutaway never draws, so a hero
   * rendering is the only way to see it and the house behind it is scenery. A roof
   * or a water heater *is* drawn, so blurring the house would blur the subject.
   * That rung zooms the real geometry and washes the surroundings back instead.
   */
  const inspecting = Boolean(focusedNode);

  /** Devices sitting in a given room, which is what makes a room worth zooming to. */
  const nodesInRoom = useCallback(
    (roomId: string) => nodes.filter((n) => n.roomId === roomId),
    [nodes],
  );

  const unconfirmedCount = nodes.filter((n) => n.confidence === 'low').length;
  const selectedRoom = roomById(rooms, selectedRoomId);

  const valvePending = Boolean(primaryRelay && activeValveCommand?.startsWith(`${primaryRelay.deviceId}:`));

  const stateCodes = useMemo(() => (
    [...new Set(
      properties
        .map((property) => parseStateFromAddress(property.address || ''))
        .filter(Boolean) as string[],
    )]
  ), [properties]);

  useEffect(() => {
    if (stateCodes.length === 0) return undefined;
    let cancelled = false;
    fetchUtilityOutageStatuses(stateCodes)
      .then((statuses) => {
        if (!cancelled) setUtilityStatusByState(statuses);
      })
      .catch(() => {
        if (!cancelled) setUtilityStatusByState({});
      });
    return () => { cancelled = true; };
  }, [stateCodes.join('|')]);

  const powerSignals = useMemo(() => {
    const propertyMap = new Map(properties.map((p) => [p.id, p.address]));
    return analyzePropertyPowerSignals(
      devices,
      properties.map((p) => ({ id: p.id, address: p.address })),
      propertyMap,
      utilityStatusByState,
    );
  }, [devices, properties, utilityStatusByState]);

  const focusedPropertyId = selectedPropertyId && selectedPropertyId !== 'all'
    ? selectedPropertyId
    : properties[0]?.id;

  const focusedProperty = properties.find((p) => p.id === focusedPropertyId);

  /** The map rungs cannot render without a position. */
  const hasCoordinates = Number.isFinite(focusedProperty?.latitude)
    && Number.isFinite(focusedProperty?.longitude);

  /**
   * Fall back to the interior view if the property loses its coordinates, so a
   * map rung is never left mounted with nothing to centre on.
   */
  useEffect(() => {
    if (layer !== 'interior' && !hasCoordinates) setLayer('interior');
  }, [layer, hasCoordinates]);

  /** Screening-level flood depth for this address, used by the storm preview. */
  const {
    data: floodDepth,
    loading: floodDepthLoading,
    error: floodDepthError,
  } = useFloodDepthGrid({
    latitude: focusedProperty?.latitude ?? null,
    longitude: focusedProperty?.longitude ?? null,
    livingSqft: focusedProperty?.livingSqft ?? null,
  });

  /*
   * The lot view needs its own, much tighter analysis. Re-using the
   * neighbourhood grid meant tracing flow at 19 m spacing over a 340 m window,
   * which is wider than the map shows at lot zoom — so the "lot" flow paths
   * were literally neighbourhood drainage. 400 m at 80 samples lands on 10 m
   * spacing, which is the elevation source's real resolution.
   */
  const { data: lotDepth, loading: lotDepthLoading } = useFloodDepthGrid({
    latitude: focusedProperty?.latitude ?? null,
    longitude: focusedProperty?.longitude ?? null,
    livingSqft: focusedProperty?.livingSqft ?? null,
    radiusMetres: 400,
    samples: 80,
    enabled: layer === 'lot',
  });

  const surgeScenarios = floodDepth?.coastalSurge?.exposed
    ? floodDepth.coastalSurge.scenarios ?? []
    : [];

  /*
   * Storm playback.
   *
   * Off until asked for: the timeline costs a terrain pass plus two upstream
   * APIs, and unlike the design scenarios it expires, so there is no value in
   * fetching it for someone who only wants to see their sensors.
   */
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [forecastTrack, setForecastTrack] = useState<ForecastTrackKind>('rainfall');
  const [forecastIndex, setForecastIndex] = useState(0);
  const [forecastPlaying, setForecastPlaying] = useState(false);

  // Ask for a surge track only where surge is actually a hazard, and use the
  // strongest category the exposure model produced as the headline what-if.
  const forecastSurgeCategory = surgeScenarios.length
    ? Math.max(...surgeScenarios.map((s) => s.category))
    : null;

  const {
    data: forecast,
    loading: forecastLoading,
    error: forecastError,
  } = useFloodForecast({
    latitude: focusedProperty?.latitude ?? null,
    longitude: focusedProperty?.longitude ?? null,
    livingSqft: focusedProperty?.livingSqft ?? null,
    surgeCategory: forecastSurgeCategory,
    enabled: timelineOpen,
  });

  /*
   * Rain measured at the property in the last hour or three.
   *
   * This is what makes "live" a real state rather than a synonym for "nothing
   * selected". It is an observation, not a design storm, so it is small — but
   * the only question the map layers ask of it is whether it is above zero and
   * by how much, and for that an observation is exactly the right input.
   */
  const liveRainInches = useMemo(() => {
    const current = weatherAssessment?.current;
    if (!current) return null;
    const measured = Number.isFinite(current.precipIn) ? Math.max(0, Number(current.precipIn)) : 0;
    if (measured > 0.005) return measured;
    // Stations that report a condition code but no accumulation are common
    // enough that treating them as dry would hide real rain. Fall back to a
    // nominal light-rain rate so the layers switch on, without inventing depth.
    const group = current.weatherId == null ? null : Math.floor(current.weatherId / 100);
    return group === 2 || group === 3 || group === 5 ? 0.04 : null;
  }, [weatherAssessment]);

  /** The single scenario every layer renders. */
  const hazard = useMemo(
    () => resolveHazard(hazardSelection, floodDepth ?? null, forecast, liveRainInches),
    [hazardSelection, floodDepth, forecast, liveRainInches],
  );

  /*
   * Whether the house is actually receiving water.
   *
   * Read once here rather than only inside the valve so the consequences of
   * closing it can reach the rest of the drawing: the distribution runs stop
   * moving, and an active leak stops dripping. With no relay enrolled there is
   * nothing to shut, so supply is assumed on.
   */
  const supplyMotion = useValveMotion(primaryRelay);
  const supplyFlowing = !primaryRelay || supplyMotion.openness > 0.02;

  /*
   * Where a detected leak may have travelled.
   *
   * With no relay enrolled there is nothing installed that could have stopped
   * the water, so the supply counts as open — which is the higher-exposure
   * reading, and the honest one.
   */
  const valveState: ValveState = primaryRelay
    ? (supplyFlowing ? 'open' : 'closed')
    : 'open';

  /**
   * Which wet rooms have a water sensor watching them, and which do not.
   *
   * A battery-sleeping flood puck still counts: `sleeping` is how a Gen4 spends
   * most of its life and it wakes to alarm, so calling it a coverage gap would
   * report a gap in every correctly installed house. Only `offline` — enrolled
   * but not heard from — is treated as not reporting.
   */
  const occupiedUnits = useMemo(
    () => new Set(unitNodes.map((node) => node.unitId)),
    [unitNodes],
  );

  const alertUnits = useMemo(() => {
    const set = new Set<string>();
    unitNodes.forEach((node) => {
      if (deviceTone(node.device, alerts) === 'critical') set.add(node.unitId);
    });
    return set;
  }, [unitNodes, alerts]);

  /** Apartments where a leak sensor is actually reporting water. */
  const wetUnits = useMemo(() => {
    const set = new Set<string>();
    unitNodes.forEach((node) => {
      if (hasActiveFloodWarning(node.device, alerts)) set.add(node.unitId);
    });
    return set;
  }, [unitNodes, alerts]);

  /**
   * Exposure across the whole building, both facades.
   *
   * Computed for every unit rather than only the visible facade, because water
   * does not care which way the building is facing. The elevation uses the
   * off-screen half to raise its cross-side badge; filtering here would make the
   * flip hide real exposure.
   */
  const buildingExposures = useMemo(() => {
    if (!isBuilding || wetUnits.size === 0) return [];
    return propagateLeak({
      cells: buildingCells(building),
      sourceCellIds: [...wetUnits],
      valveState,
      minutesSinceDetection: minutesSinceLeak,
    });
  }, [isBuilding, building, wetUnits, valveState, minutesSinceLeak]);

  const buildingCoverage = useMemo(
    () => (isBuilding
      ? computeCoverage(
        coverageSpacesFromUnits(building),
        unitNodes.map((node) => ({
          roomId: node.unitId,
          kind: node.kind,
          reporting: deviceTone(node.device, alerts) !== 'offline',
        })),
      )
      : null),
    [isBuilding, building, unitNodes, alerts],
  );

  const coverageGapUnits = useMemo(
    () => new Set((buildingCoverage?.unmonitored ?? []).map((location) => location.roomId)),
    [buildingCoverage],
  );

  const coverage = useMemo(
    () => computeCoverage(
      rooms,
      nodes.map((node) => ({
        roomId: node.roomId,
        kind: node.kind,
        reporting: deviceTone(node.device, alerts) !== 'offline',
      })),
    ),
    [rooms, nodes, alerts],
  );

  const coverageGapRooms = useMemo(
    () => new Set(coverage.unmonitored.map((location) => location.roomId)),
    [coverage],
  );

  const leakExposures = useMemo(() => {
    if (wetRooms.size === 0) return [];
    return propagateHouseLeak(rooms, [...wetRooms], {
      valveState,
      minutesSinceDetection: minutesSinceLeak,
    });
  }, [rooms, wetRooms, valveState, minutesSinceLeak]);

  /**
   * The same exposure set as a plain room lookup, for the 3D view.
   *
   * The section paints exposure as a stain whose height tracks how far the water
   * has got up the wall, which needs the full tier and depth. The dollhouse has
   * no wall to run a stain up, so it washes the floor of any room in scope and
   * only needs to know which those are.
   */
  const orbitExposedRooms = useMemo(
    () => new Set(leakExposures.map((e) => e.cellId)),
    [leakExposures],
  );

  /** Spaces the leak may have reached, excluding the rooms actually reporting. */
  const activeExposures = isBuilding ? buildingExposures : leakExposures;
  const exposedCount = activeExposures.filter((e) => e.tier !== 'source').length;
  const coverageForUi = (isBuilding ? buildingCoverage : coverage) ?? coverage;

  const plateLevel = (() => {
    if (focus.kind === 'floor') return focus.level;
    if (focus.kind === 'unit') return unitById(building, focus.unitId)?.level ?? 0;
    const source = buildingExposures.find((exposure) => exposure.tier === 'source');
    return source ? (unitById(building, source.cellId)?.level ?? 0) : 0;
  })();

  /**
   * The riser the riser view shows.
   *
   * Falls back to the leak rather than to the first riser. Opening this view with
   * riser 1 selected while the leak is on riser 7 is worse than useless — it
   * answers the right question about the wrong column, and the drawing gives no
   * hint that it is the wrong one. Explicit selection still wins, because a
   * manager who clicked a riser meant that riser.
   */
  const focusedStack = useMemo(() => {
    if (!isBuilding) return null;
    const byId = (id: string | null) => building.stacks.find((stack) => stack.id === id) ?? null;
    const explicit = byId(selectedStackId)
      ?? byId(selectedUnitId ? unitById(building, selectedUnitId)?.stackId ?? null : null);
    if (explicit) return explicit;

    const source = buildingExposures.find((exposure) => exposure.tier === 'source')
      ?? buildingExposures[0];
    return byId(source ? unitById(building, source.cellId)?.stackId ?? null : null)
      ?? building.stacks[0]
      ?? null;
  }, [isBuilding, building, selectedStackId, selectedUnitId, buildingExposures]);

  const canvasW = isBuilding ? buildingCameraScene.w : VB_W;
  const canvasH = isBuilding ? buildingCameraScene.h : VB_H;

  /**
   * Rooms to walk into, worst first.
   *
   * The composition of the two models is the point: a wet room with no working
   * sensor that the leak is also heading for is the one place in the house where
   * water can arrive and nothing will ever say so.
   */
  const inspectionTargets = useMemo(
    () => rankInspectionTargets(coverageForUi, activeExposures),
    [coverageForUi, activeExposures],
  );

  /**
   * How the exposed set grows if the leak keeps running. Only worth drawing once
   * the count actually changes across the window — a flat strip says nothing.
   */
  const leakProgression = useMemo(() => {
    const sourceIds = isBuilding ? [...wetUnits] : [...wetRooms];
    if (sourceIds.length === 0) return [];
    const points = exposureProgression(
      {
        cells: isBuilding ? buildingCells(building) : houseCells(rooms),
        sourceCellIds: sourceIds,
        valveState,
      },
      minutesSinceLeak,
    );
    const counts = new Set(points.map((p) => p.count));
    return counts.size > 1 ? points : [];
  }, [isBuilding, building, wetUnits, rooms, wetRooms, valveState, minutesSinceLeak]);

  /*
   * What the cutaway draws falling on the roof.
   *
   * Live means live: the observed condition code and rate, and nothing at all
   * on a clear day. When a storm is being simulated the house shows that
   * storm's rain instead, so the section is never contradicting the scenario
   * the map layers are drawing.
   */
  const cutawayWeather = useMemo<LiveWeather>(() => (
    hazard.isLive
      ? liveWeatherFrom(weatherAssessment?.current)
      : scenarioWeather(hazard.rainInches)
  ), [hazard.isLive, hazard.rainInches, weatherAssessment]);

  /*
   * The hour of regional weather that goes on the map, but only while the
   * timeline is driving. Outside playback there is no single "current" frame to
   * show, and leaving yesterday's rain painted over the map would be worse than
   * showing none.
   */
  const weatherFrame = useMemo(() => {
    if (hazardSelection.kind !== 'forecast') return null;
    const weather = forecast?.weather;
    const frame = weather?.steps[forecastIndex];
    if (!weather || !frame) return null;
    return {
      precipMmH: frame.precipMmH,
      cloudPct: frame.cloudPct,
      rows: weather.grid.rows,
      cols: weather.grid.cols,
      bounds: weather.grid.bounds,
    };
  }, [hazardSelection.kind, forecast, forecastIndex]);

  // Playback drives the shared hazard, so the map raster, the lot view and the
  // cutaway's waterline all step through the storm together.
  useEffect(() => {
    if (!timelineOpen) return;
    setHazardSelection({ kind: 'forecast', track: forecastTrack, index: forecastIndex });
  }, [timelineOpen, forecastTrack, forecastIndex]);

  const exitTimeline = useCallback(() => {
    setTimelineOpen(false);
    setForecastPlaying(false);
    setForecastIndex(0);
    setHazardSelection({ kind: 'live' });
  }, []);

  /**
   * Picking a design storm leaves playback. Without this the next playback tick
   * would silently overwrite the chip the user just pressed, so the selection
   * would appear to bounce back on its own.
   */
  const selectHazard = useCallback((selection: HazardSelection) => {
    setTimelineOpen(false);
    setForecastPlaying(false);
    setHazardSelection(selection);
  }, []);

  /** An explicit prop wins over the local preview. */
  const effectiveDepthAtGradeFt = floodDepthAtGradeFt ?? hazard.depthAtGradeFt;

  const effectiveScenarioLabel = floodScenarioLabel ?? (hazard.label
    ? hazard.label + (hazard.annualChancePct != null ? `, ${hazard.annualChancePct}% chance per year` : '')
    : null);

  /**
   * Water level in the section, from either the modelled storm or a leak
   * sensor. Also drives the "what the water reaches" list in the side panel.
   */
  const floodStage = useMemo(
    () => computeFloodStage({
      depthAtGradeFt: effectiveDepthAtGradeFt,
      sensorWater: basementWater,
      hasBasement: rooms.some((r) => r.floor === 'basement'),
    }),
    [effectiveDepthAtGradeFt, basementWater, rooms],
  );

  /**
   * Device pins and their links step aside while the health overlay is up.
   *
   * A building's pins go through the same loop as a house's, adapted to the pin
   * layer's shape rather than given a second renderer. There is one pin design and
   * one drag gesture, and duplicating them would mean two places to fix the next
   * time either changes.
   *
   * `confidence` is always `assigned` here, because a unit placement is never
   * inferred — an unplaced device is left off the drawing rather than guessed into
   * somebody's apartment.
   */
  const overlayNodes = useMemo<PositionedNode[]>(() => {
    if (overlayMode === 'health') return [];
    if (!isBuilding) return nodes;
    return unitNodes.map((node) => ({
      device: node.device,
      kind: node.kind,
      roomId: node.unitId,
      confidence: 'assigned' as const,
      x: node.x,
      y: node.y,
      // Links are a house idea: they run to a router mounted on the service run,
      // which a building drawing does not have. Anchored on the pin so nothing
      // is drawn.
      linkFrom: { x: node.x, y: node.y },
      linkKind: 'wifi' as const,
    }));
  }, [overlayMode, isBuilding, nodes, unitNodes]);

  /**
   * Age and flood exposure read together. Computed off the same scenario depth
   * the waterline is drawn from, so the advice in the rail always matches the
   * water on screen rather than a stale default storm.
   */
  const hazardCrossovers = useMemo(
    () => buildHazardCrossovers(healthAssets, rooms, floodStage?.levelFt ?? null),
    [healthAssets, rooms, floodStage?.levelFt],
  );

  const selectedHealthAsset = useMemo(
    () => healthAssets.find((asset) => asset.id === selectedHealthAssetId) ?? null,
    [healthAssets, selectedHealthAssetId],
  );

  /*
   * Cost and history for the selected component only.
   *
   * Both are derived from the same functions the health tab uses, so the twin
   * cannot quote a different lifetime spend than the ledger does. Scoped to the
   * selection rather than computed for the whole inventory because the rail only
   * ever shows one component at a time.
   */
  const selectedHealthCost = useMemo(() => {
    if (!selectedHealthAsset) return null;
    return summarizeComponentCosts([selectedHealthAsset])[0] ?? null;
  }, [selectedHealthAsset]);

  const selectedHealthHistory = useMemo(() => {
    if (!selectedHealthAsset) return [];
    return buildPropertyHistoryTimeline({ assets: [selectedHealthAsset] });
  }, [selectedHealthAsset]);

  const selectedHealthForecast = useMemo(() => {
    if (!selectedHealthAsset) return null;
    return forecastComponentMaintenance(selectedHealthAsset, {
      exposure: inferPropertyMaintenanceExposure({
        address: focusedProperty?.address,
        state: parseStateFromAddress(focusedProperty?.address || ''),
      }),
      cost: selectedHealthCost,
    });
  }, [selectedHealthAsset, selectedHealthCost, focusedProperty?.address]);

  useEffect(() => {
    if (!focusedPropertyId) {
      setWeatherAssessment(null);
      setWeatherError(null);
      return undefined;
    }
    let cancelled = false;
    setWeatherLoading(true);
    setWeatherError(null);
    fetchPropertyWeatherAssessment({
      propertyId: focusedPropertyId,
      latitude: focusedProperty?.latitude,
      longitude: focusedProperty?.longitude,
      address: focusedProperty?.address,
    })
      .then((assessment) => {
        if (!cancelled) setWeatherAssessment(assessment);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setWeatherAssessment(null);
          setWeatherError(error?.message || 'Weather assessment unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setWeatherLoading(false);
      });
    return () => { cancelled = true; };
  }, [focusedPropertyId, focusedProperty?.latitude, focusedProperty?.longitude, focusedProperty?.address]);

  const powerSignal = useMemo(
    () => powerSignals.find((s) => s.propertyId === focusedPropertyId) || powerSignals[0] || null,
    [powerSignals, focusedPropertyId],
  );

  const powerEstimation = powerSignal?.estimation || 'power_likely_on';

  const focusedUtilityStatus = useMemo(() => {
    const address = powerSignal?.propertyAddress
      || properties.find((p) => p.id === focusedPropertyId)?.address
      || '';
    const stateCode = parseStateFromAddress(address);
    return stateCode ? utilityStatusByState[stateCode] || null : null;
  }, [powerSignal?.propertyAddress, properties, focusedPropertyId, utilityStatusByState]);

  const showWeatherPill = Boolean(
    weatherAssessment
    && (weatherAssessment.overallRisk === 'moderate'
      || weatherAssessment.overallRisk === 'high'
      || weatherAssessment.overallRisk === 'critical'),
  );

  const resetSidePanel = () => {
    setPowerPanelOpen(false);
    setWeatherPanelOpen(false);
    setSelectedDeviceId(null);
    setSelectedRoomId(null);
    setSelectedUnitId(null);
    setStackEditorOpen(false);
    setFocus({ kind: 'house' });
  };

  const selectPowerPanel = () => {
    setSelectedDeviceId(null);
    setSelectedRoomId(null);
    setWeatherPanelOpen(false);
    setPowerPanelOpen(true);
  };

  const selectWeatherPanel = () => {
    setSelectedDeviceId(null);
    setSelectedRoomId(null);
    setPowerPanelOpen(false);
    setWeatherPanelOpen(true);
  };

  const selectDevice = (deviceId: string | null) => {
    setPowerPanelOpen(false);
    setWeatherPanelOpen(false);
    setSelectedRoomId(null);
    setSelectedDeviceId(deviceId);
  };

  const selectRoom = (roomId: string | null) => {
    setPowerPanelOpen(false);
    setWeatherPanelOpen(false);
    setSelectedDeviceId(null);
    setSelectedRoomId(roomId);
  };

  /* ── interior camera ── */

  /**
   * Clicking a room that has sensors in it flies to that room. An empty room
   * still selects — the side panel has something to say about it — but there is
   * nothing in there worth filling the frame with, so the camera stays put.
   */
  const focusRoom = (roomId: string) => {
    if (focus.kind === 'room' && focus.roomId === roomId) {
      selectRoom(null);
      setFocus({ kind: 'house' });
      return;
    }
    selectRoom(roomId);
    setFocus(nodesInRoom(roomId).length > 0 ? { kind: 'room', roomId } : { kind: 'house' });
  };

  const focusDevice = (deviceId: string) => {
    selectDevice(deviceId);
    setFocus({ kind: 'device', deviceId });
  };

  /**
   * Fly to an apartment. A second click on the one you are already in steps back
   * out, so a unit is a toggle, matching what a room already does.
   */
  const focusUnit = (unitId: string) => {
    if (focus.kind === 'unit' && focus.unitId === unitId) {
      setSelectedUnitId(null);
      setFocus({ kind: 'house' });
      return;
    }
    setSelectedUnitId(unitId);
    setFocus({ kind: 'unit', unitId });
  };

  /** Fly to a storey, which is what the floor plate and the plan rung show. */
  const focusFloor = (level: number) => {
    setSelectedUnitId(null);
    setFocus({ kind: 'floor', level });
  };

  /**
   * Fly to a component and open its record.
   *
   * The same gesture as a sensor, because it is the same question asked of a
   * different thing: show me that part of the house and tell me about it. A second
   * click on the pin you are already inside steps back out, so the pin is a toggle
   * rather than a one-way trip that needs the Back control to undo.
   */
  const focusHealthAsset = (assetId: string) => {
    if (focus.kind === 'health' && focus.assetId === assetId) {
      setSelectedHealthAssetId(null);
      setFocus({ kind: 'house' });
      return;
    }
    setSelectedHealthAssetId(assetId);
    selectDevice(null);
    setFocus({ kind: 'health', assetId });
  };

  /**
   * Step back out one rung.
   *
   * From a device this returns to its room only when there is something left to
   * choose between. In a single-sensor room the room view auto-advances to the
   * sensor, so returning there would immediately fly back in again and the
   * control would appear to do nothing.
   */
  const focusOut = useCallback(() => {
    setFocus((current) => {
      /*
       * In a building, stepping out of a unit lands on its floor rather than on
       * the whole building. Undoing one rung at a time is the only Back behaviour
       * that is never surprising, because it retraces the way the reader came in.
       */
      if (isBuilding && (current.kind === 'unit' || current.kind === 'floor' || current.kind === 'device')) {
        const unitId = current.kind === 'unit'
          ? current.unitId
          : current.kind === 'device'
            ? unitNodes.find((node) => node.device.id === current.deviceId)?.unitId
            : undefined;
        const step = buildingParentFocus(
          building,
          unitId ? { kind: 'unit', unitId } : { kind: 'floor', level: 0 },
        );
        setSelectedDeviceId(null);
        setSelectedUnitId(null);
        if (step?.kind === 'floor' && current.kind !== 'floor') {
          return { kind: 'floor', level: step.level };
        }
        return { kind: 'house' };
      }

      if (current.kind === 'device') {
        const node = nodeByDeviceId.get(current.deviceId);
        if (node && nodesInRoom(node.roomId).length > 1) {
          setSelectedDeviceId(null);
          setSelectedRoomId(node.roomId);
          return { kind: 'room', roomId: node.roomId };
        }
      }
      // A component goes straight back to the whole house: its room holds no
      // other health pins to choose between, so stopping there would be a rung
      // with nothing on it.
      if (current.kind === 'health') setSelectedHealthAssetId(null);
      setSelectedDeviceId(null);
      setSelectedRoomId(null);
      return { kind: 'house' };
    });
  }, [nodeByDeviceId, nodesInRoom, isBuilding, building, unitNodes]);

  /*
   * A room holding exactly one sensor continues straight through to it. Asking
   * for a second click to select the only thing in the room is busywork, and the
   * two moves chained together are the whole gesture the view is selling: here
   * is the room, and here is the device in it.
   *
   * The hand-off is deliberately early — the room move is still running when the
   * device move takes over — so the pair reads as one continuous push instead of
   * a move, a pause, and then a second smaller move.
   */
  const chainRoomId = focus.kind === 'room' ? focus.roomId : null;
  const chainDeviceId = chainRoomId && nodesInRoom(chainRoomId).length === 1
    ? nodesInRoom(chainRoomId)[0].device.id
    : null;
  useEffect(() => {
    if (!chainDeviceId) return undefined;
    const timer = setTimeout(() => {
      setSelectedRoomId(null);
      setSelectedDeviceId(chainDeviceId);
      setFocus({ kind: 'device', deviceId: chainDeviceId });
    }, 320);
    return () => clearTimeout(timer);
  }, [chainDeviceId]);

  /** Leaving the rung entirely drops the camera back to the whole section. */
  useEffect(() => {
    if (layer !== 'interior') setFocus({ kind: 'house' });
  }, [layer]);

  /** A device that disappears while being inspected must not trap the camera. */
  useEffect(() => {
    if (focus.kind !== 'device') return;
    const stillHere = devices.some((device) => device.id === focus.deviceId);
    if (!stillHere) setFocus({ kind: 'house' });
  }, [focus, devices]);

  /*
   * Same for a component. It can leave under the camera by being marked as not
   * applicable on the health tab, or by losing its pin when the property shape
   * changes and the fixture it hung on stops being drawn.
   */
  useEffect(() => {
    if (focus.kind === 'health' && !healthPins.some((pin) => pin.asset.id === focus.assetId)) {
      setFocus({ kind: 'house' });
    }
  }, [focus, healthPins]);

  /** Switching back to the device overlay must not leave the camera on a component. */
  useEffect(() => {
    if (overlayMode === 'devices' && focus.kind === 'health') setFocus({ kind: 'house' });
  }, [overlayMode, focus.kind]);

  useEffect(() => {
    if (focus.kind === 'house') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') focusOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus.kind, focusOut]);

  /* ── pin dragging ── */

  const toSvgPoint = (event: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  };

  const handlePinPointerDown = (deviceId: string) => (event: ReactPointerEvent<SVGGElement>) => {
    if ((!onAssignRoom && !onAssignUnit) || event.button !== 0) return;
    const point = toSvgPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const lift = buildingView === 'exploded' ? explodeOffset : () => 0;
    setDrag({
      deviceId,
      x: point.x,
      y: point.y,
      roomId: isBuilding ? null : roomAtPoint(rooms, point.x, point.y)?.id ?? null,
      unitId: isBuilding ? unitAtPoint(building, buildingSide, point.x, point.y, lift)?.id ?? null : null,
      originClientX: event.clientX,
      originClientY: event.clientY,
    });
  };

  const handlePinPointerMove = (event: ReactPointerEvent<SVGGElement>) => {
    if (!drag) return;
    const point = toSvgPoint(event);
    if (!point) return;
    const lift = buildingView === 'exploded' ? explodeOffset : () => 0;
    setDrag({
      ...drag,
      x: point.x,
      y: point.y,
      roomId: isBuilding ? null : roomAtPoint(rooms, point.x, point.y)?.id ?? null,
      unitId: isBuilding ? unitAtPoint(building, buildingSide, point.x, point.y, lift)?.id ?? null : null,
    });
  };

  const handlePinPointerUp = (deviceId: string) => (event: ReactPointerEvent<SVGGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const active = drag;
    setDrag(null);
    if (!active || active.deviceId !== deviceId) return;

    const startNode = isBuilding
      ? unitNodes.find((node) => node.device.id === deviceId)
      : nodeByDeviceId.get(deviceId);
    const movedFar = Math.hypot(
      event.clientX - active.originClientX,
      event.clientY - active.originClientY,
    ) > dragSlopFor(event.pointerType);

    // A press without meaningful movement is a click, not a drag.
    if (!movedFar) {
      if (selectedDeviceId === deviceId && focus.kind === 'device') focusOut();
      else focusDevice(deviceId);
      return;
    }

    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;

    if (isBuilding) {
      if (!active.unitId || !onAssignUnit) return;
      if (active.unitId === (startNode && 'unitId' in startNode ? startNode.unitId : null)) return;
      setPendingUnits((prev) => ({ ...prev, [deviceId]: active.unitId as string }));
      void onAssignUnit(device, active.unitId);
      return;
    }

    if (!active.roomId || !onAssignRoom) return;
    if (active.roomId === (startNode && 'roomId' in startNode ? startNode.roomId : null)) return;

    setPendingRooms((prev) => ({ ...prev, [deviceId]: active.roomId as string }));
    void onAssignRoom(device, active.roomId);
  };

  const hasDevices = devices.length > 0;

  return (
    <section
      className="overflow-hidden rounded-3xl border border-blue-200 bg-[radial-gradient(circle_at_50%_0%,rgba(224,242,254,0.9),transparent_48%),linear-gradient(160deg,#f8fbff_0%,#eef6ff_55%,#f8fafc_100%)] p-4 sm:p-5"
      data-voice-id="sensor-topology-content"
    >
      <style>{`
        @keyframes hy-link-dash { to { stroke-dashoffset: -24; } }
        .hy-link-dash { animation: hy-link-dash 1.6s linear infinite; }
        @keyframes hy-valve-dash { to { stroke-dashoffset: -20; } }
        .hy-valve-dash { animation: hy-valve-dash 2.4s linear infinite; }
        @keyframes hy-power-dash { to { stroke-dashoffset: -28; } }
        .hy-power-dash { animation: hy-power-dash 1.6s linear infinite; }
        @keyframes hy-wave-slide { to { transform: translateX(44px); } }
        .hy-wave { animation: hy-wave-slide 1.4s linear infinite; }
        @keyframes hy-spin-dash { to { stroke-dashoffset: -36; } }
        .hy-spin { animation: hy-spin-dash 2.6s linear infinite; }
      `}</style>

      <header className="flex flex-col gap-3 border-b border-blue-100 pb-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-blue-700">
            <Network size={16} />
            <span className="text-[11px] font-bold uppercase tracking-[0.18em]">Live property twin</span>
          </div>
          <h2 className="mt-0.5 text-lg font-bold text-slate-950">{propertyLabel}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
          {properties.length > 1 && onSelectProperty && (
            <div className="flex max-w-full flex-wrap gap-1.5">
              <button
                onClick={() => onSelectProperty('all')}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${selectedPropertyId === 'all' || !selectedPropertyId ? 'border-blue-500 bg-blue-600 text-white' : 'border-blue-200 bg-white text-blue-700 hover:bg-blue-50'}`}
              >
                All
              </button>
              {properties.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelectProperty(p.id)}
                  className={`max-w-[180px] truncate rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${selectedPropertyId === p.id ? 'border-blue-500 bg-blue-600 text-white' : 'border-blue-200 bg-white text-blue-700 hover:bg-blue-50'}`}
                  title={p.address}
                >
                  {p.address.split(',')[0]}
                </button>
              ))}
            </div>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-cyan-800"><HeartPulse size={12} />{onlineCount} live</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${activeAlerts.length ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-white text-slate-600'}`}><CircleAlert size={12} />{activeAlerts.length} alerts</span>
          {showWeatherPill && weatherAssessment && (
            <button
              type="button"
              onClick={selectWeatherPanel}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition hover:opacity-90"
              style={{
                borderColor: `${weatherRiskColor(weatherAssessment.overallRisk)}66`,
                backgroundColor: `${weatherRiskColor(weatherAssessment.overallRisk)}14`,
                color: weatherRiskColor(weatherAssessment.overallRisk),
              }}
            >
              <CloudRain size={12} />
              {weatherRiskLabel(weatherAssessment.overallRisk)}
            </button>
          )}
        </div>
      </header>

      {valveCommandMessage && (
        <div className={`mt-3 rounded-xl border px-3 py-2 text-xs font-semibold ${valveCommandMessage.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
          {valveCommandMessage.text}
        </div>
      )}

      <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* ── canvas column ── */}
        <div className="min-w-0">
        {/* Controls live in a real toolbar above the drawing rather than
            floating over it. Panels pinned to the corners of the canvas always
            end up covering the thing they describe — on the lot view the storm
            card sat squarely on the neighbouring parcels, and on the interior it
            covered the roof. */}
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Zoom ladder. Interior is always available; the map rungs need
              coordinates, so they only appear once we know where the house is. */}
          <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
            {LAYER_TABS.map((tab) => {
              const needsCoords = tab.id !== 'interior';
              const disabled = needsCoords && !hasCoordinates;
              return (
                <button
                  key={tab.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setLayer(tab.id)}
                  title={disabled ? 'No coordinates for this property yet' : tab.hint}
                  className={`rounded-lg px-2.5 py-1 text-[10.5px] font-bold transition-colors ${
                    layer === tab.id
                      ? 'bg-slate-800 text-white'
                      : disabled
                        ? 'cursor-not-allowed text-slate-300'
                        : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* One switch per system rather than one for both.
              Drawing wiring and plumbing together put two dashed networks
              through every slab and partition at once, and the section could
              not carry both on top of the furniture, tints, pins and labels it
              already has. Water is on by default because this is a water
              product — the leak sensors and the shutoff are all on that
              network — and power is the thing you turn on when you have a
              question about power. */}
          {layer === 'interior' && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowWater((v) => !v)}
                title={showWater ? 'Hide the water distribution runs' : 'Show how water reaches each fixture'}
                aria-pressed={showWater}
                className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold transition-colors ${
                  showWater
                    ? 'border-sky-200 bg-sky-50 text-sky-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                <Droplets size={11} />
                Water
              </button>
              {!isBuilding && (
              <button
                type="button"
                onClick={() => setShowPower((v) => !v)}
                title={showPower ? 'Hide the branch wiring' : 'Show how power reaches each room'}
                aria-pressed={showPower}
                className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold transition-colors ${
                  showPower
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                <Zap size={11} />
                Power
              </button>
              )}
              {/*
                Single-family only. A five-storey building's "site" is a tower on
                a pad, so the lot view has nothing to say about it that the
                elevation does not; the multifamily tabs below cover that case.
              */}
              {!isBuilding && (
                <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
                  {([
                    { id: 'section' as const, label: 'House' },
                    { id: 'site' as const, label: 'Lot' },
                  ]).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setHouseView(tab.id)}
                      aria-pressed={houseView === tab.id}
                      title={tab.id === 'site'
                        ? 'See the property from outside, and turn it'
                        : 'The house itself, cut open. Drag to walk around it.'}
                      className={`rounded-lg px-2 py-1 text-[10px] font-bold transition-colors ${
                        houseView === tab.id
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
              {/*
                The turn controls drive the same orbit the drag gesture does, so
                the keyboard-and-mouse route and the touch route cannot disagree
                about which way the house is facing.
              */}
              {!isBuilding && houseView === 'section' && (
                <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
                  <button
                    type="button"
                    onClick={() => setHouseOrbit((o) => clampHouseOrbit({ ...o, yaw: o.yaw - Math.PI / 8 }))}
                    title="Turn left"
                    aria-label="Turn the house left"
                    className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setHouseOrbit((o) => clampHouseOrbit({ ...o, yaw: o.yaw + Math.PI / 8 }))}
                    title="Turn right"
                    aria-label="Turn the house right"
                    className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
                  >
                    <RotateCw size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setHouseOrbit(HOUSE_FRONT)}
                    title="Look at the street side and the rooms behind it"
                    className="rounded-lg px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100"
                  >
                    Front
                  </button>
                  <button
                    type="button"
                    onClick={() => setHouseOrbit({ yaw: Math.PI, pitch: HOUSE_FRONT.pitch })}
                    title="Look at the back of the house and the rooms on it"
                    className="rounded-lg px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100"
                  >
                    Back
                  </button>
                </div>
              )}
              {!isBuilding && houseView === 'site' && (
                <button
                  type="button"
                  onClick={() => setSiteEditorOpen(true)}
                  title="Confirm storeys and what each building is"
                  className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
                >
                  <Pencil size={11} />
                  Lot
                </button>
              )}
              {!isBuilding && houseView === 'site' && (
                <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
                  <button
                    type="button"
                    onClick={() => setSiteOrbit((o) => ({ ...o, yaw: o.yaw - Math.PI / 8 }))}
                    title="Turn left"
                    aria-label="Turn the property left"
                    className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSiteOrbit((o) => ({ ...o, yaw: o.yaw + Math.PI / 8 }))}
                    title="Turn right"
                    aria-label="Turn the property right"
                    className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
                  >
                    <RotateCw size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSiteOrbit(SITE_ORBIT)}
                    title="Back to the default angle"
                    className="rounded-lg px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100"
                  >
                    Reset
                  </button>
                </div>
              )}
              {isBuilding && (
                <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
                  {([
                    { id: 'stack' as const, label: 'Stack' },
                    { id: 'riser' as const, label: 'Riser' },
                    { id: 'plate' as const, label: 'Floor' },
                    { id: 'section' as const, label: 'Elevation' },
                    { id: 'exploded' as const, label: 'Exploded' },
                  ]).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setBuildingView(tab.id)}
                      aria-pressed={buildingView === tab.id}
                      className={`rounded-lg px-2 py-1 text-[10px] font-bold transition-colors ${
                        buildingView === tab.id
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
              {isBuilding && (
                <button
                  type="button"
                  onClick={() => setStackEditorOpen(true)}
                  title="Edit the stacking plan"
                  className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
                >
                  <Pencil size={11} />
                  Plan
                </button>
              )}
              {isBuilding && oppositeSide(building, buildingSide) && (
                <button
                  type="button"
                  onClick={() => {
                    const far = oppositeSide(building, buildingSide);
                    if (!far) return;
                    setBuildingSide(far);
                    setSelectedUnitId(null);
                    setHoveredUnitId(null);
                  }}
                  title="Show the other side of the corridor"
                  className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
                >
                  <FlipHorizontal2 size={11} />
                  Flip
                </button>
              )}
              {/* Only offered when there is something to find. On a fully
                  covered property this button can only ever report good news,
                  and a control that does nothing is worse than no control. */}
              {coverageForUi.unmonitored.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowCoverage((v) => !v)}
                  title={
                    showCoverage
                      ? 'Hide the unmonitored fixtures'
                      : `Show the ${coverageForUi.unmonitored.length} wet locations with no working water sensor`
                  }
                  aria-pressed={showCoverage}
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold transition-colors ${
                    showCoverage
                      ? 'border-slate-300 bg-slate-100 text-slate-700'
                      : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  <ShieldQuestion size={11} />
                  Gaps
                </button>
              )}
            </div>
          )}

          {/* Devices or health, not both. The two overlays pin to the same
              rooms, so showing them together buries one under the other. */}
          {layer === 'interior' && healthAssets.length > 0 && (
            <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
              {(['devices', 'health'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setOverlayMode(mode);
                    if (mode === 'devices') setSelectedHealthAssetId(null);
                    else selectDevice(null);
                  }}
                  aria-pressed={overlayMode === mode}
                  title={
                    mode === 'devices'
                      ? 'Show sensors and their network'
                      : `Show all ${healthPins.length} tracked components and how much life each has left`
                  }
                  className={`rounded-lg px-2.5 py-1 text-[10.5px] font-bold transition-colors ${
                    overlayMode === mode
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {mode === 'devices' ? 'Devices' : `Components ${healthPins.length}`}
                </button>
              ))}
            </div>
          )}

          {/* Storm controls, inline in the toolbar. The selection is shared
              across all three rungs, so it must stay put as you move between
              them — hence living outside the layer switch. */}
          {floodDepth && floodDepth.scenarios.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <Droplets size={11} className="text-blue-500" />
                Simulate
              </span>

              <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
                <button
                  type="button"
                  onClick={() => selectHazard({ kind: 'live' })}
                  className={`rounded-md px-2 py-1 text-[10px] font-bold transition-colors ${
                    hazardSelection.kind === 'live'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Live
                </button>
                {floodDepth.scenarios.map((s) => {
                  const active = hazardSelection.kind === 'rainfall'
                    && hazardSelection.rainInches === s.rainInches;
                  return (
                    <button
                      key={s.rainInches}
                      type="button"
                      onClick={() => selectHazard(active
                        ? { kind: 'live' }
                        : { kind: 'rainfall', rainInches: s.rainInches })}
                      title={s.annualChancePct != null
                        ? `${s.rainInches}" in 24h — ${s.annualChancePct}% chance per year`
                        : `${s.rainInches}" in 24h`}
                      className={`rounded-md px-1.5 py-1 text-[10px] font-bold transition-colors ${
                        active ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {s.rainInches}&quot;
                    </button>
                  );
                })}
              </div>

              {/* Surge is a different hazard on a different datum, so it stays
                  visually separate from the rainfall chips. */}
              {surgeScenarios.length > 0 && (
                <div className="flex items-center gap-0.5 rounded-lg bg-rose-50 p-0.5">
                  <span className="px-1 text-[9.5px] font-bold uppercase tracking-wide text-rose-400">
                    Surge
                  </span>
                  {surgeScenarios.map((s) => {
                    const active = hazardSelection.kind === 'surge'
                      && hazardSelection.category === s.category;
                    return (
                      <button
                        key={s.category}
                        type="button"
                        onClick={() => selectHazard(active
                          ? { kind: 'live' }
                          : { kind: 'surge', category: s.category })}
                        title={`Category ${s.category} — ${s.surgeAboveMhhwFt} ft above MHHW`
                          + ((s.depthAtGradeFt ?? 0) > 0 ? `, ${s.depthAtGradeFt} ft at the house` : ', does not reach the house')}
                        className={`rounded-md px-1.5 py-1 text-[10px] font-bold transition-colors ${
                          active
                            ? 'bg-rose-600 text-white'
                            : (s.depthAtGradeFt ?? 0) > 0
                              ? 'text-rose-700 hover:bg-rose-100'
                              : 'text-slate-400 hover:bg-rose-100'
                        }`}
                      >
                        C{s.category}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* The forecast answers a different question from the chips —
                  not "what would 3 inches do" but "what is actually coming". */}
              {hasCoordinates && !timelineOpen && (
                <button
                  type="button"
                  onClick={() => {
                    setTimelineOpen(true);
                    setForecastIndex(0);
                    setForecastPlaying(true);
                  }}
                  className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[10px] font-bold text-white shadow-sm hover:bg-blue-700"
                >
                  <Play size={10} />
                  Play 24h forecast
                </button>
              )}
            </div>
          )}
        </div>

        {/* Scenario provenance, on its own line so the toolbar stays compact. */}
        {!hazard.isLive && (
          <div className="mb-2 text-[10px] leading-snug text-slate-500">
            {hazardSelection.kind === 'forecast' ? (
              <span className="font-semibold text-blue-700">Playing the forecast · {hazard.label}</span>
            ) : (
              <>
                Simulated, not a live reading.
                {hazardSelection.kind === 'surge' && ' Regional surge envelope.'}
                {hazard.annualChancePct != null && ` ${hazard.annualChancePct}% chance per year.`}
              </>
            )}
            {layer === 'interior' && hasCoordinates && (
              <button
                type="button"
                onClick={() => setLayer('lot')}
                className="ml-2 font-bold text-blue-600 hover:underline"
              >
                Where does this water come from? →
              </button>
            )}
          </div>
        )}

        {layer === 'interior' && !hasDevices && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2">
            <Network size={13} className="mt-0.5 shrink-0 text-slate-500" />
            <div className="min-w-0">
              <p className="text-[11px] font-bold leading-snug text-slate-800">
                No sensors on this property yet.
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-slate-600">
                The twin still shows the building. Add a device to place it on the drawing.
                {onAddDevice && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => onAddDevice()}
                      className="font-bold text-blue-600 hover:underline"
                    >
                      Add a device
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {layer === 'interior' && !isBuilding && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2">
            <Home size={13} className="mt-0.5 shrink-0 text-slate-500" />
            <div className="min-w-0">
              <p className="text-[11px] font-bold leading-snug text-slate-800">
                Drawing a single-family house.
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-slate-600">
                Drag to turn the house. Rooms behind the front wall come into view.
                {' '}
                Open Lot to see this property's outline and garage.
                {' '}
                Property records often miss that a downtown address is apartments.
                {' '}
                <button
                  type="button"
                  onClick={() => setStackEditorOpen(true)}
                  className="font-bold text-blue-600 hover:underline"
                >
                  Switch to a building view
                </button>
              </p>
            </div>
          </div>
        )}

        {layer === 'interior' && isBuilding && buildingModel.error && !stackEditorOpen && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-700" />
            <div className="min-w-0">
              <p className="text-[11px] leading-snug text-amber-900">{buildingModel.error}</p>
              <button
                type="button"
                onClick={() => setStackEditorOpen(true)}
                className="mt-0.5 text-[10px] font-bold text-amber-800 hover:underline"
              >
                Open stacking plan
              </button>
            </div>
          </div>
        )}

        {/*
          What the leak may have reached, stated above the drawing.

          The hatching in the section says *where*; this says *how many* and,
          critically, that these are spaces to inspect rather than spaces known
          to be wet. Only shown on the interior rung, since the map rungs have no
          rooms to talk about.
        */}
        {layer === 'interior' && showWater && exposedCount > 0 && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2">
            {/* A pooling patch, matching the mark used in the section. */}
            <span
              aria-hidden
              className="mt-1 h-2 w-3.5 shrink-0 rounded-full border border-amber-600/70 bg-amber-400/60"
            />
            <div className="min-w-0">
              <p className="text-[11px] font-bold leading-snug text-amber-900">
                {summarizeExposure(activeExposures)}
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-amber-800/80">
                Worked out from where these spaces sit relative to the leak, not from
                sensors in them. The section marks where water would arrive and
                collect in {exposedCount === 1 ? 'it' : 'them'}.
              </p>

              {/* How much worse this gets if it keeps running. Explicitly a
                  projection, so it is labelled as one. */}
              {leakProgression.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[9.5px] font-bold uppercase tracking-wide text-amber-700/80">
                    If unaddressed
                  </span>
                  {leakProgression.map((point) => (
                    <span
                      key={point.minutes}
                      className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums ${
                        point.reached
                          ? 'bg-amber-200 text-amber-900'
                          : 'border border-dashed border-amber-300 text-amber-700/70'
                      }`}
                      title={
                        point.reached
                          ? `${point.minutes === 0 ? 'At detection' : `${point.minutes} min in`}: ${point.count} in scope`
                          : `Projected at ${point.minutes} min: ${point.count} in scope`
                      }
                    >
                      {point.minutes === 0 ? '0m' : `${point.minutes}m`} · {point.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/*
          What is not being watched.

          Slate rather than amber, and phrased as coverage rather than as risk: on
          a normal day this is a shopping list, not an incident. The exception is
          a blind spot the leak is heading for, which is why the copy leads with
          that room when there is one — it is the only case where a missing sensor
          is a problem right now.
        */}
        {layer === 'interior' && showCoverage && coverageForUi.unmonitored.length > 0 && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2">
            <ShieldQuestion size={13} className="mt-0.5 shrink-0 text-slate-500" />
            <div className="min-w-0">
              <p className="text-[11px] font-bold leading-snug text-slate-800">
                {summarizeCoverage(coverageForUi)} {coverageForUi.headline}.
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-slate-600">
                {inspectionTargets[0]?.gap && inspectionTargets[0]?.exposure
                  ? inspectionTargets[0].reason
                  : 'Marked in the section with a crossed-out drop above the fixture. Based on the modelled room layout, so confirm before quoting it.'}
              </p>
            </div>
          </div>
        )}

        <div className="relative overflow-hidden rounded-2xl border border-blue-100/80 bg-white/40">
          {/* A short scale-and-fade on layer change, run in the direction of
              travel. The rungs are genuinely different renderers, so there is
              no continuous camera to animate; this is the cheapest way to say
              which way you just moved. */}
          <div key={layer} className={`hy-twin-layer-${zoomDirection}`}>
          {layer !== 'interior' && hasCoordinates ? (
            <TwinMapLayer
              scale={layer === 'lot' ? 'lot' : 'neighborhood'}
              latitude={focusedProperty!.latitude!}
              longitude={focusedProperty!.longitude!}
              address={focusedProperty?.address}
              attomId={focusedProperty?.attomId}
              parcelGeometry={focusedProperty?.parcelGeometry}
              grid={floodDepth ?? null}
              lotGrid={lotDepth ?? null}
              hazard={hazard}
              weatherFrame={weatherFrame}
              floodLoading={floodDepthLoading || (layer === 'lot' && lotDepthLoading)}
              floodError={floodDepthError}
              height={520}
              onZoomIn={() => setLayer(layer === 'neighborhood' ? 'lot' : 'interior')}
            />
          ) : !isBuilding && houseView === 'site' ? (
            /*
              The lot, from outside. Brings its own `<svg>` for the same reason
              the plate stack does: it is framed by fitting a camera to the
              property's own extent, so borrowing the cutaway's viewBox would
              crop a wide lot and strand a narrow one in the middle of the frame.
            */
            <svg
              viewBox={`0 0 ${siteViewScene().w} ${siteViewScene().h}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label={`${propertyLabel} seen from outside. Use the turn controls to rotate.`}
            >
              <SiteView
                model={siteModel}
                orbit={liveSiteOrbit}
                width={siteViewScene().w}
                height={siteViewScene().h}
                showRooms
                onStructureClick={() => setSiteEditorOpen(true)}
              />
            </svg>
          ) : isBuilding && buildingView === 'stack' ? (
            /*
              The plate stack and the riser view are `<g>` like the cutaways, but
              they size themselves from their own layout rather than from the
              elevation's scene, so they bring their own `<svg>` instead of
              borrowing the camera's. Sharing the camera would mean framing them
              with a viewBox computed for a completely different drawing.
            */
            <svg
              viewBox={`0 0 ${plateStackScene(building).w} ${plateStackScene(building).h}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label={`Exploded stacking section, ${building.floors} floors, ${building.unitCount} units`}
            >
              <BuildingPlateStack
                building={building}
                alertUnits={alertUnits}
                exposures={showWater ? buildingExposures : []}
                coverageGaps={showCoverage ? coverageGapUnits : undefined}
                occupiedUnits={occupiedUnits}
                selectedStackId={focusedStack?.id}
                showWater={showWater}
                valveClosed={valveState === 'closed'}
                onUnitClick={(unit) => focusUnit(unit.id)}
                onStackClick={(stack) => setSelectedStackId(stack.id)}
              />
            </svg>
          ) : isBuilding && buildingView === 'riser' && focusedStack ? (
            <svg
              viewBox={`0 0 ${riserScene(building, focusedStack).w} ${riserScene(building, focusedStack).h}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label={`Riser ${focusedStack.column + 1}, floor by floor`}
            >
              <RiserView
                building={building}
                stack={focusedStack}
                alertUnits={alertUnits}
                exposures={showWater ? buildingExposures : []}
                coverageGaps={showCoverage ? coverageGapUnits : undefined}
                valveState={valveState === 'closed' ? 'closed' : 'open'}
                waterFlowing={supplyFlowing}
                onUnitClick={(unit) => focusUnit(unit.id)}
              />
            </svg>
          ) : isBuilding && buildingView === 'plate' ? (
            <FloorPlate
              building={building}
              level={plateLevel}
              alertUnits={alertUnits}
              exposures={showWater ? buildingExposures : []}
              coverageGaps={showCoverage ? coverageGapUnits : undefined}
              occupiedUnits={occupiedUnits}
              selectedUnitId={selectedUnitId}
              highlightSide={buildingSide}
              onUnitClick={focusUnit}
            />
          ) : (
          <svg
            ref={svgRef}
            viewBox={cameraViewBox(camera)}
            className="h-auto w-full"
            role="img"
            aria-label="Live network topology of property devices"
          >
            <defs>
              <linearGradient id="hy-valve-body" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7dd3fc" />
                <stop offset="45%" stopColor="#0ea5e9" />
                <stop offset="100%" stopColor="#0369a1" />
              </linearGradient>
              <radialGradient id="hy-router-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="rgba(34,211,238,0.28)" />
                <stop offset="100%" stopColor="rgba(34,211,238,0)" />
              </radialGradient>
              <linearGradient id="hy-pipe-copper" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#d97b2e" />
                <stop offset="30%" stopColor="#b45309" />
                <stop offset="75%" stopColor="#8a4a16" />
                <stop offset="100%" stopColor="#5b2d0c" />
              </linearGradient>
              <filter id="hy-power-selected-glow" x="-8%" y="-40%" width="116%" height="180%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Empty canvas is a reset target: click away to go back to Network health. */}
            <rect
              x={0}
              y={0}
              width={canvasW}
              height={canvasH}
              fill="transparent"
              onClick={() => resetSidePanel()}
            />

            {/*
              Everything except the inspected device, thrown out of focus behind it.

              A CSS filter rather than an SVG `feGaussianBlur`: it is composited on
              the GPU, and its radius is in rendered pixels, so the background holds
              the same softness at every zoom instead of the blur appearing to grow
              as the camera pushes in. Pointer events come off at the same time —
              the blurred layer is scenery at this point, and letting clicks land on
              a control you cannot read is how you end up somewhere unexpected.
            */}
            <g
              style={{
                filter: inspecting ? 'blur(3.5px)' : undefined,
                pointerEvents: inspecting ? 'none' : undefined,
                transition: 'filter 300ms ease-out',
              }}
            >
            {/*
              The house-only scenery.

              A service run in a basement, a meter on a wall, a gable to rain on
              and a router mounted next to the valve are all facts about a
              detached house. Drawn against a building's geometry they land in
              mid-air, so the whole group is gated rather than repositioned —
              there is no right place for a single-family power drop on a
              five-storey elevation.
            */}
            {!isBuilding && (
            <>
            <UtilityPowerLines
              houseX={958}
              houseY={590}
              estimation={powerEstimation}
              selected={powerPanelOpen}
              /* Spacing is set by crossarm reach, not by taste: at the previous
                 scales the pole's arms ended at x≈1162 and the tower's began at
                 x≈1155, so the two overlapped. These leave a clear gap for the
                 span to hang in. */
              supports={[
                { x: 1118, y: houseShell.grade, scale: 1.95, kind: 'residential' },
                { x: 1248, y: houseShell.grade - 14, scale: 1.32, kind: 'lattice' },
              ]}
              attach={serviceHead}
              onSelect={() => {
                if (powerPanelOpen) {
                  setPowerPanelOpen(false);
                } else {
                  selectPowerPanel();
                }
              }}
            />
            </>
            )}

            {isBuilding ? (
              <BuildingCutaway
                building={building}
                side={buildingSide}
                mode={buildingView === 'exploded' ? 'exploded' : 'section'}
                alertUnits={alertUnits}
                exposures={showWater ? buildingExposures : []}
                coverageGaps={showCoverage ? coverageGapUnits : undefined}
                occupiedUnits={occupiedUnits}
                selectedUnitId={selectedUnitId}
                hoveredUnitId={hoveredUnitId}
                selectedStackId={selectedStackId}
                onUnitClick={focusUnit}
                onUnitHover={setHoveredUnitId}
                onFlip={(next) => {
                  setBuildingSide(next);
                  // The unit you were looking at is on the facade you just turned
                  // away from, so keeping it selected would leave the side panel
                  // describing an apartment that is no longer on screen.
                  setSelectedUnitId(null);
                  setHoveredUnitId(null);
                }}
                onStackClick={(stackId) => setSelectedStackId(
                  (current) => (current === stackId ? null : stackId),
                )}
              />
            ) : (
            <>
            <HouseCutaway
              rooms={rooms}
              shell={houseShell}
              bands={houseBands}
              camera={projectedHouse.camera}
              roomTints={roomTints}
              alertRooms={alertRooms}
              exposures={showWater ? leakExposures : []}
              coverageGaps={showCoverage ? coverageGapRooms : undefined}
              occupiedRooms={occupiedRooms}
              selectedRoomId={selectedRoomId}
              hoveredRoomId={hoveredRoomId}
              dropTargetRoomId={drag?.roomId ?? null}
              dragging={Boolean(drag)}
              floodDepthFt={effectiveDepthAtGradeFt}
              standingWater={basementWater}
              showWater={showWater}
              showPower={showPower}
              waterFlowing={supplyFlowing}
              weather={cutawayWeather}
              onRoomClick={focusRoom}
              onRoomHover={setHoveredRoomId}
            />

            {!isBuilding && houseView === 'section' && !inspecting && (
              <rect
                x={camera.x}
                y={camera.y}
                width={camera.w}
                height={camera.h}
                fill="transparent"
                style={{ cursor: orbitDragging ? 'grabbing' : 'grab' }}
                onPointerDown={(event) => {
                  houseOrbitDrag.current = {
                    x: event.clientX,
                    y: event.clientY,
                    yaw: houseOrbit.yaw,
                    pitch: houseOrbit.pitch,
                  };
                  setOrbitDragging(true);
                  (event.currentTarget as SVGRectElement).setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const start = houseOrbitDrag.current;
                  if (start) {
                    /*
                     * The drag turns this drawing. The threshold is what keeps a
                     * click on a room from nudging the house a couple of degrees
                     * on the way to selecting it.
                     */
                    const dx = event.clientX - start.x;
                    if (Math.abs(dx) < 10) return;
                    setHouseOrbit(clampHouseOrbit({
                      yaw: start.yaw + dx * 0.008,
                      pitch: start.pitch,
                    }));
                    return;
                  }
                  const pt = toSvgPoint(event);
                  const hit = pt ? roomAtPoint(rooms, pt.x, pt.y) : null;
                  setHoveredRoomId(hit && hit.floor !== 'exterior' ? hit.id : null);
                }}
                onPointerUp={(event) => {
                  const start = houseOrbitDrag.current;
                  houseOrbitDrag.current = null;
                  setOrbitDragging(false);
                  if (!start) return;
                  if (Math.abs(event.clientX - start.x) >= 10) return;
                  const pt = toSvgPoint(event);
                  const hit = pt ? roomAtPoint(rooms, pt.x, pt.y) : null;
                  if (hit && hit.floor !== 'exterior') focusRoom(hit.id);
                  else resetSidePanel();
                }}
                onPointerCancel={() => {
                  houseOrbitDrag.current = null;
                  setOrbitDragging(false);
                }}
                onPointerLeave={() => setHoveredRoomId(null)}
              />
            )}

            <OutdoorWeatherNode
              houseX={410}
              houseY={138}
              assessment={weatherAssessment}
              loading={weatherLoading}
              selected={weatherPanelOpen}
              onSelect={() => {
                if (weatherPanelOpen) {
                  setWeatherPanelOpen(false);
                } else {
                  selectWeatherPanel();
                }
              }}
            />

            <text
              x={660}
              y={isBuilding ? canvasH - 16 : VB_H - 16}
              textAnchor="middle"
              fontSize={16}
              fontWeight={700}
              fill="#1e40af"
              style={{ cursor: 'pointer' }}
              onClick={resetSidePanel}
            >
              {wireframeOption ? wireframeOption.address.split(',')[0] : 'Protected property'}
            </text>

            {/* device links (under pins) — quiet unless you are asking about
                that particular device, or it is asking about itself */}
            {overlayNodes.map((node, i) => (
              <TopologyLink
                key={`link-${node.device.id}`}
                id={`hy-link-${i}`}
                from={{ x: node.x, y: node.y }}
                to={node.linkFrom}
                tone={deviceTone(node.device, alerts)}
                linkKind={node.linkKind}
                muted={
                  selectedDeviceId !== node.device.id
                  && hoveredDeviceId !== node.device.id
                }
              />
            ))}

            {/* valve assembly, mounted on the basement water main */}
            {assemblyRelay && (
              <ValveAssembly
                device={assemblyRelay}
                pending={valvePending}
                center={VALVE_CENTER}
                scale={VALVE_SCALE}
                linkFrom={router}
                onCommand={onValveCommand ? (device, action) => {
                  selectDevice(device.id);
                  onValveCommand(device, action);
                } : undefined}
                selected={selectedDeviceId === assemblyRelay.id}
                onSelect={() => selectDevice(selectedDeviceId === assemblyRelay.id ? null : assemblyRelay.id)}
              />
            )}
            {hasBasement && !primaryRelay && hasDevices && (
              <g>
                <path
                  d={`M${VALVE_CENTER.x - 190} ${WATER_MAIN_Y} H${VALVE_CENTER.x + 190}`}
                  stroke="#cbd5e1"
                  strokeWidth={12}
                  strokeLinecap="round"
                />
                <text x={VALVE_CENTER.x} y={WATER_MAIN_Y - 26} textAnchor="middle" fontSize={14} fontWeight={700} fill="#64748b">
                  No shutoff valve enrolled
                </text>
                <text x={VALVE_CENTER.x} y={WATER_MAIN_Y + 34} textAnchor="middle" fontSize={12} fill="#94a3b8">
                  Add a Shelly 1 Gen4 relay to control the main line from here
                </text>
              </g>
            )}

            {/* travel router hub, sitting in the room it serves from */}
            {hasDevices && (
            <g style={{ cursor: 'default' }}>
              <circle cx={router.x} cy={router.y} r={52} fill="url(#hy-router-glow)" />
              <circle cx={router.x} cy={router.y} r={27} fill="#ffffff" stroke="#2563eb" strokeWidth={2.2} />
              <circle cx={router.x} cy={router.y} r={27} fill="none" stroke="#67e8f9" strokeWidth={1.5}>
                <animate attributeName="r" values="27;44" dur="2.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.7;0" dur="2.6s" repeatCount="indefinite" />
              </circle>
              <g transform={`translate(${router.x} ${router.y}) scale(0.52)`}>
                <GlinetRouterGlyph />
              </g>
              {/*
               * Sits below the glyph, clear of the room name in the top-left
               * corner. The live count already lives in the header pills, so
               * one line is enough.
               */}
              <text
                x={router.x}
                y={router.y + 40}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight={800}
                fill="#1e40af"
                stroke="#f8fafc"
                strokeWidth={3.5}
                paintOrder="stroke"
              >
                HouseYield-IoT
              </text>
            </g>
            )}
            </>
            )}

            {/* device pins — shared, so a building gets the same pin and the same
                drag gesture as a house rather than a second implementation */}
            {overlayNodes.map((node) => {
              // The device under inspection is drawn as the hero instead, so its
              // pin would only sit behind the close-up as a ghost.
              if (focusedNode?.device.id === node.device.id) return null;
              const tone = deviceTone(node.device, alerts);
              const selected = selectedDeviceId === node.device.id;
              const color = TONE_COLOR[tone];
              const isDragging = drag?.deviceId === node.device.id;
              const px = isDragging ? drag.x : node.x;
              const py = isDragging ? drag.y : node.y;
              const wet = node.kind === 'flood' && hasActiveFloodWarning(node.device, alerts);
              const valueLabel = wet
                ? 'WATER'
                : node.kind === 'ht' && node.device.temperatureF != null
                  ? `${node.device.temperatureF.toFixed(0)}°`
                    : tone === 'offline'
                      ? 'Offline'
                      : null;
              const valueUrgent = wet;
              const showName = selected || hoveredDeviceId === node.device.id || isDragging;
              return (
                <g
                  key={node.device.id}
                  transform={`translate(${px} ${py})`}
                  style={{ cursor: (onAssignRoom || onAssignUnit) ? 'grab' : 'pointer' }}
                  opacity={isDragging ? 0.85 : 1}
                  onPointerDown={handlePinPointerDown(node.device.id)}
                  onPointerMove={handlePinPointerMove}
                  onPointerUp={handlePinPointerUp(node.device.id)}
                  onMouseEnter={() => setHoveredDeviceId(node.device.id)}
                  onMouseLeave={() => setHoveredDeviceId((cur) => (cur === node.device.id ? null : cur))}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Click handling lives in pointerup so a drag never selects.
                    if (onAssignRoom || onAssignUnit) return;
                    if (selected && focus.kind === 'device') focusOut();
                    else focusDevice(node.device.id);
                  }}
                >
                  {tone === 'healthy' && !isDragging && (
                    <circle r={22} fill="none" stroke={color} strokeWidth={1.5}>
                      <animate attributeName="r" values="22;33" dur="2.8s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.55;0" dur="2.8s" repeatCount="indefinite" />
                    </circle>
                  )}
                  <circle
                    r={22}
                    fill="#ffffff"
                    stroke={selected ? '#2563eb' : color}
                    strokeWidth={selected ? 3.4 : 2.4}
                    strokeDasharray={node.confidence === 'low' ? '5 4' : undefined}
                  />
                  <g transform="scale(0.62)">
                    <NodeGlyph kind={node.kind} device={node.device} alerts={alerts} />
                  </g>
                  <ConnectivityBadge tone={tone} x={18} y={-18} />
                  {/*
                   * Only the live reading stays on the canvas. Names are the
                   * bulkiest text and the least urgent — several pins share a
                   * room, so showing every name at once buries the artwork.
                   */}
                  {valueLabel && (
                    <text
                      y={38}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={700}
                      fill={valueUrgent ? '#e11d48' : '#475569'}
                      stroke="#f8fafc"
                      strokeWidth={3.5}
                      paintOrder="stroke"
                      style={{ pointerEvents: 'none' }}
                    >
                      {valueLabel}
                    </text>
                  )}
                  {showName && (
                    <text
                      y={valueLabel ? 52 : 38}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight={700}
                      fill="#0f172a"
                      stroke="#f8fafc"
                      strokeWidth={4}
                      paintOrder="stroke"
                      style={{ pointerEvents: 'none' }}
                    >
                      {(node.device.name || node.device.deviceId).slice(0, 22)}
                    </text>
                  )}
                </g>
              );
            })}

            {overlayMode === 'health' && (
              <HealthPins
                /* The other pins come off while one component is being inspected.
                   They are labelled markers scattered across the house, and at this
                   zoom they crowd the very surface being read. */
                pins={focusedHealthPin ? [] : healthPins}
                selectedAssetId={selectedHealthAssetId}
                onSelect={focusHealthAsset}
              />
            )}
            </g>

            {/* The inspected component, marked up in place on the real geometry.
                Outside the group above so the wash it lays over the surroundings
                is not itself washed. */}
            {focusedHealthPin && focusedHealthRegion && (
              <ComponentCondition
                region={focusedHealthRegion}
                category={focusedHealthPin.asset.category}
                pin={focusedHealthPin}
                onDismiss={focusOut}
              />
            )}

            {/* The inspected device, up close and turning. Outside the group above
                so it stays the one sharp thing in the frame. */}
            {inspecting && (
              <rect
                x={0}
                y={0}
                width={canvasW}
                height={canvasH}
                fill="transparent"
                onClick={focusOut}
                style={{ cursor: 'zoom-out' }}
              />
            )}
            {focusedNode && (
              <DeviceHero
                x={focusedNode.x}
                y={focusedNode.y}
                kind={focusedNode.kind}
                device={focusedNode.device}
                tone={TONE_COLOR[deviceTone(focusedNode.device, alerts)]}
                alarming={
                  focusedNode.kind === 'flood'
                    ? hasActiveFloodWarning(focusedNode.device, alerts)
                    : deviceTone(focusedNode.device, alerts) === 'critical'
                }
                onDismiss={focusOut}
              />
            )}
          </svg>
          )}

          {/* Way back out. Lives in the DOM rather than the canvas because the
              canvas is what is being zoomed — an on-canvas control would grow
              with the camera and drift off wherever the frame happened to land. */}
          {layer === 'interior' && focus.kind !== 'house' && (
            <button
              type="button"
              onClick={focusOut}
              className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-white/90 px-3 py-1.5 text-xs font-bold text-blue-700 shadow-sm backdrop-blur transition hover:bg-white"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              {focus.kind === 'device' || focus.kind === 'health' || focus.kind === 'unit'
                ? 'Back'
                : isBuilding
                  ? 'Whole building'
                  : 'Whole house'}
            </button>
          )}
          </div>


          {((onAssignRoom && unconfirmedCount > 0) || (isBuilding && !buildingModel.confirmed) || (!isBuilding && layer === 'interior') || (!isBuilding && houseView === 'site' && siteQuery.needsConfirmation)) && !timelineOpen && (
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex justify-center">
              <div className="pointer-events-auto">
                {isBuilding && !buildingModel.confirmed ? (
                  <StackGuessBanner spec={buildingModel.spec} onEdit={() => setStackEditorOpen(true)} />
                ) : !isBuilding && houseView === 'site' && siteQuery.needsConfirmation ? (
                  <SiteGuessBanner onEdit={() => setSiteEditorOpen(true)} />
                ) : !isBuilding ? (
                  <SwitchToBuildingBanner onEdit={() => setStackEditorOpen(true)} />
                ) : (
                  <span className="rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-[11px] font-semibold text-amber-800 shadow-sm">
                    {unconfirmedCount} {unconfirmedCount === 1 ? 'device is' : 'devices are'} placed by guess — drag a pin into the right room to correct it
                  </span>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Playback transport, under whichever rung is showing. */}
        {timelineOpen && (
          <div className="mt-2">
            <StormTimeline
              forecast={forecast}
              loading={forecastLoading}
              error={forecastError}
              track={forecastTrack}
              onTrackChange={setForecastTrack}
              index={forecastIndex}
              onIndexChange={setForecastIndex}
              playing={forecastPlaying}
              onPlayingChange={setForecastPlaying}
              onExit={exitTimeline}
            />
          </div>
        )}
        </div>

        {/* ── side panel ── */}
        <div className="min-h-[320px] space-y-2">
          {/* Crossovers are the reason for reading age against the waterline,
              so they cannot wait behind a click on the right pin. */}
          {overlayMode === 'health' && !selectedHealthAsset && hazardCrossovers.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-amber-800">
                <AlertTriangle size={11} />
                Age meets flood risk
              </div>
              <div className="mt-1.5 space-y-1.5">
                {hazardCrossovers.slice(0, 3).map((c) => (
                  <button
                    key={`${c.assetId}-${c.thresholdId}`}
                    type="button"
                    onClick={() => setSelectedHealthAssetId(c.assetId)}
                    className="block w-full text-left"
                  >
                    <div className="text-[11px] font-bold text-slate-900">{c.headline}</div>
                    <p className="text-[11px] leading-snug text-slate-600">{c.detail}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {siteEditorOpen ? (
            <SiteEditor
              spec={{
                structures: siteModel.structures.map((s) => ({
                  id: s.id,
                  role: s.role,
                  storeys: Math.max(1, s.levels.filter((l) => l.z >= 0 && l.id !== 'attic').length || 1),
                  hasBasement: s.levels.some((l) => l.id === 'basement'),
                })),
              }}
              confirmed={siteQuery.confirmed}
              error={siteQuery.error}
              onSave={async (spec) => {
                await siteQuery.save(spec, { confirmedBy: 'owner' });
                setSiteEditorOpen(false);
              }}
              onCancel={() => setSiteEditorOpen(false)}
            />
          ) : stackEditorOpen ? (
            <StackEditor
              spec={
                shouldDrawAsBuilding(buildingModel.spec, buildingModel.confirmed)
                  ? buildingModel.spec
                  : { ...DEFAULT_BUILDING_SPEC, archetype: 'garden_walkup' }
              }
              confirmed={buildingModel.confirmed}
              saving={stackSaving}
              error={buildingModel.error}
              onSave={async (spec) => {
                /*
                 * Saving is a confirmation, so the numbers are believed as typed.
                 * The coercion only catches the case where someone has described a
                 * house — one floor, one unit — in the building form, which no
                 * building drawing can represent.
                 */
                const next = shouldDrawAsBuilding(spec, true)
                  ? spec
                  : { ...spec, archetype: 'garden_walkup' as const };
                setStackSaving(true);
                setStackEditorOpen(false);
                await buildingModel.save(next, { confirmedBy: 'owner' });
                setStackSaving(false);
              }}
              onCancel={() => setStackEditorOpen(false)}
            />
          ) : weatherPanelOpen ? (
            <WeatherDetailPanel
              assessment={weatherAssessment}
              loading={weatherLoading}
              error={weatherError}
              onClose={() => setWeatherPanelOpen(false)}
            />
          ) : powerPanelOpen ? (
            <PowerDetailPanel
              signal={powerSignal}
              utilityStatus={focusedUtilityStatus}
              devices={devices.filter((d) => !focusedPropertyId || d.propertyId === focusedPropertyId || properties.length <= 1)}
              onClose={() => setPowerPanelOpen(false)}
            />
          ) : selectedHealthAsset && selectedHealthForecast ? (
            <HealthDetailPanel
              asset={selectedHealthAsset}
              crossovers={hazardCrossovers}
              cost={selectedHealthCost}
              history={selectedHealthHistory}
              forecast={selectedHealthForecast}
              onOpenInHealth={onOpenHealthAsset}
              onClose={() => {
                setSelectedHealthAssetId(null);
                // Closing the card while zoomed into the component would leave
                // the camera pointed at something with nothing to say about it.
                if (focus.kind === 'health') setFocus({ kind: 'house' });
              }}
            />
          ) : selectedDevice ? (
            <DeviceDetailPanel
              device={selectedDevice}
              alerts={alerts}
              pendingValve={Boolean(activeValveCommand?.startsWith(`${selectedDevice.deviceId}:`))}
              onValveCommand={onValveCommand}
              onRenameDevice={onRenameDevice}
              onUnassignDevice={onUnassignDevice}
              onDeleteDevice={onDeleteDevice}
              onReconfigureFlood={onReconfigureFlood}
              onReconnectRelay={onReconnectRelay}
              onAcknowledgeAlert={onAcknowledgeAlert}
              deletingDeviceId={deletingDeviceId}
              onClose={() => setSelectedDeviceId(null)}
            />
          ) : selectedUnitId && isBuilding ? (
            <RoomDetailPanel
              room={coverageSpacesFromUnits(building).find((space) => space.id === selectedUnitId)
                ?? {
                  id: selectedUnitId,
                  label: 'Unit',
                  short: 'Unit',
                  floor: 'main',
                  x: 0,
                  y: 0,
                  w: 0,
                  h: 0,
                  fixtures: [],
                }}
              devices={unitNodes
                .filter((node) => node.unitId === selectedUnitId)
                .map((node) => ({ device: node.device, kind: node.kind, confidence: 'assigned' as const }))}
              alerts={alerts}
              exposure={buildingExposures.find((exposure) => exposure.cellId === selectedUnitId)}
              onSelectDevice={selectDevice}
              onClose={() => {
                setSelectedUnitId(null);
                if (focus.kind === 'unit') setFocus({ kind: 'house' });
              }}
            />
          ) : selectedRoom ? (
            <RoomDetailPanel
              room={selectedRoom}
              devices={nodes
                .filter((n) => n.roomId === selectedRoom.id)
                .map((n) => ({ device: n.device, kind: n.kind, confidence: n.confidence }))}
              alerts={alerts}
              exposure={leakExposures.find((e) => e.cellId === selectedRoom.id)}
              onSelectDevice={selectDevice}
              onClose={() => setSelectedRoomId(null)}
            />
          ) : (
            <NetworkSummaryPanel
              devices={devices}
              alerts={alerts}
              weatherAssessment={weatherAssessment}
              weatherLoading={weatherLoading}
              floodStage={floodStage}
              floodScenarioLabel={effectiveScenarioLabel}
              coastalSurge={floodDepth?.coastalSurge ?? null}
              governingHazard={floodDepth?.governingHazard ?? null}
              lotFlow={floodDepth?.lotFlow ?? null}
              activeLayer={layer}
              onSelectDevice={selectDevice}
              onSelectWeather={selectWeatherPanel}
              onAddDevice={onAddDevice}
              onZoomToLayer={setLayer}
            />
          )}
        </div>
      </div>

      <footer className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-blue-100 pt-3 text-[10.5px] text-slate-500">
        <span className="inline-flex items-center gap-1.5"><Wifi size={11} className="text-sky-500" /> Wi-Fi link</span>
        <span className="inline-flex items-center gap-1.5"><Bluetooth size={11} className="text-blue-500" /> BLE link</span>
        <span className="inline-flex items-center gap-1.5"><Activity size={11} className="text-cyan-500" /> Pulses show live traffic</span>
        <span className="inline-flex items-center gap-1.5"><Droplets size={11} className="text-blue-500" /> Neighborhood → Lot → Interior share one storm</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" /> Amber pulse = valve closing</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" /> Sky pulse = valve opening</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500 text-[8px] font-bold text-white">✓</span> Online</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-slate-400 text-[8px] font-bold text-white">✕</span> Offline</span>
        <span className="inline-flex items-center gap-1.5"><Zap size={11} className="text-amber-500" /> Yellow bolt = power</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-flex h-3 w-3 items-center justify-center rounded-full border-2 border-rose-500 text-[9px] font-bold leading-none text-rose-500">–</span> Red dash = outage</span>
        <span className="inline-flex items-center gap-1.5"><Zap size={11} className="text-green-600" /> Click power lines for grid status</span>
        <span className="inline-flex items-center gap-1.5"><Cloud size={11} className="text-sky-600" /> Click outdoor node for weather risk</span>
        <span className="inline-flex items-center gap-1.5"><Wind size={11} className="text-slate-400" /> Watch / storm pills appear when risk rises</span>
        <span className="inline-flex items-center gap-1.5"><Radio size={11} className="text-slate-400" /> Click any device for details &amp; controls</span>
        <span className="inline-flex items-center gap-1.5"><LockKeyhole size={11} className="text-rose-400" /> Valve handle turns as the ball valve actuates</span>
        <span className="inline-flex items-center gap-1.5"><Battery size={11} className="text-emerald-500" /> Live metrics in the side panel</span>
      </footer>
    </section>
  );
}
