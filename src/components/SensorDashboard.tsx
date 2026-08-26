import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Home } from 'lucide-react';
import { SystemStatus } from '../types/iot';
import type { ParcelGeometry } from '../types/attom';
import { useShellyFirestore, type ShellyDevice } from '../hooks/useShellyFirestore';
import { usePropertyHealthAssets } from '../hooks/usePropertyHealthAssets';
import { useAuth } from '../contexts/AuthContext';
import { useVoiceActionHandler } from '../contexts/VoiceCommandContext';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import ShellySetupWizard from './ShellySetupWizard';
import EnvironmentalAnalytics from './EnvironmentalAnalytics';
import DeviceTopologyMap from './DeviceTopologyMap';
import WorkspaceTabsHeader from './WorkspaceTabsHeader';
import { KpiStrip } from '../design-system';
import { alertMatchesProperty, propertyIdsMatch } from '../utils/sensorPropertyMatching';
import { getStoredPracticeTestPhone } from '../utils/practiceTestPhone';
import { resolveShellyApiBaseUrl, resolveShellyWebhookUrl } from '../utils/iotProjectConfig';
import { fetchRelayStatus, sendRelayCommand } from '../utils/shellyRelayCommand';

const SHELLY_API_BASE = resolveShellyApiBaseUrl();

interface AlertNotificationResult {
  alertId: string;
  notifications: {
    email: { ok: boolean; error?: string } | null;
    sms: { ok: boolean; error?: string; messageSid?: string } | null;
    phoneCall: { ok: boolean; error?: string; callSid?: string } | null;
  };
  maintenanceRequest: {
    id: string;
    category: string;
    priority: string;
    description: string;
  } | null;
}

interface FirestoreProperty {
  id: string;
  ownerId: string;
  address: string;
  propertyData?: {
    summary?: {
      beds?: number;
      baths?: number;
      living_sqft?: number;
      avm_value?: number;
      rental_avm?: number;
      latitude?: number;
      longitude?: number;
      attom_id?: string | number;
    };
    /** ATTOM puts coordinates here; `summary` is often missing them. */
    location?: {
      latitude?: number | string;
      longitude?: number | string;
    };
    /**
     * Present when the property was hydrated from the ATTOM cache. Handed to the
     * twin so the lot view does not re-request an outline we already have.
     */
    parcel_geometry?: ParcelGeometry;
    /**
     * Coarse stacking plan derived from the same cached ATTOM blob. Seeds the
     * multifamily twin; a confirmed plan stored separately overrides it.
     */
    building_geometry?: {
      archetype?: string | null;
      floors?: number | null;
      unitsTotal?: number | null;
      unitsPerFloor?: number | null;
      corridor?: string | null;
      confidence?: string | null;
      needsConfirmation?: boolean | null;
    } | null;
  };
  image?: string;
  tenant?: {
    id: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  tenantId?: string;
}

type DashboardView = 'overview' | 'topology' | 'alerts' | 'analytics';
type AlertFilter = 'recent' | 'all' | 'critical' | 'warning' | 'info';
type AlertStatusFilter = 'open' | 'all';

/** Strip emoji/symbol noise and normalize whitespace so repeated sensor-generated
 *  alerts (e.g. "🚨 FLOOD DETECTED 🚨 ...") compare and read cleanly. */
function cleanAlertMessage(raw: string): string {
  return String(raw || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAlertDuplicateKey(alert: { deviceId?: string; type?: string; message?: string }): string {
  const normalizedMessage = cleanAlertMessage(alert.message || '')
    .toLowerCase()
    .replace(/sensor\s*id[:\s]*[\w-]+/gi, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return [(alert.deviceId || '').trim(), (alert.type || '').trim().toLowerCase(), normalizedMessage].join('|');
}

const sectionShell = 'rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_48px_rgba(15,23,42,0.08)]';
const cardPanel = 'rounded-2xl border border-slate-200 bg-slate-50';
const compactCard = 'rounded-2xl border border-slate-100 bg-white';
function formatTimestamp(value?: string | null) {
  if (!value) return 'No reading yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No reading yet';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatNotificationTime(value?: string | Date | null) {
  if (!value) return 'Unknown time';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}


function isFloodSensorDevice(device: any): boolean {
  return device?.type === 'flood'
    || device?.deviceType === 'shelly_flood_gen4'
    || (Array.isArray(device?.capabilities) && device.capabilities.includes('flood'));
}

function resolveFloodDeviceForReconnect(devices: any[]): { deviceId: string } | { error: string } {
  const floodDevices = devices.filter(isFloodSensorDevice);
  if (floodDevices.length === 0) {
    return { error: 'No flood sensor is registered for this property.' };
  }
  if (floodDevices.length > 1) {
    return { error: 'Multiple flood sensors found. Reconfigure each device from its device card.' };
  }
  const deviceId = floodDevices[0].deviceId || floodDevices[0].id;
  if (!deviceId) {
    return { error: 'Registered flood sensor is missing a device ID.' };
  }
  return { deviceId: String(deviceId) };
}

function resolvePropertyAddress(
  propertyId: string | undefined | null,
  properties: FirestoreProperty[],
  propertyMap: Map<string, string>,
) {
  if (!propertyId) return 'Unassigned property';
  const direct = propertyMap.get(propertyId);
  if (direct) return direct;
  const match = properties.find((property) => propertyIdsMatch(property.id, propertyId));
  return match?.address || 'Unassigned property';
}

function isAutoShutoffAlertType(type?: string | null) {
  return type === 'flood'
    || type === 'freeze_risk'
    || type === 'pipe_burst'
    || type === 'rapid_temp_change';
}

function readingTempF(reading: { temperature?: number | null; temperatureF?: number | null }) {
  if (reading.temperatureF != null) return reading.temperatureF;
  if (reading.temperature != null) return (reading.temperature * 9 / 5) + 32;
  return null;
}

function evaluateFreezeShutoffFromReadings(
  device: { deviceId: string; name?: string; propertyId?: string; temperature?: number | null; temperatureF?: number | null },
  readings: Array<{ deviceId: string; temperature?: number | null; timestamp: Date }>,
) {
  const deviceReadings = readings
    .filter((reading) => reading.deviceId === device.deviceId && reading.temperature != null)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const currentTempF = device.temperatureF ?? readingTempF(deviceReadings[0] || {}) ?? (
    device.temperature != null ? (device.temperature * 9 / 5) + 32 : null
  );

  if (currentTempF == null) return null;
  if (currentTempF <= 32) {
    return { reason: 'below_freezing', currentTempF };
  }

  if (deviceReadings.length < 2) return null;

  const newest = deviceReadings[0];
  const oldest = deviceReadings[deviceReadings.length - 1];
  const hours = (newest.timestamp.getTime() - oldest.timestamp.getTime()) / (60 * 60 * 1000);
  if (hours < 0.25) return null;

  const newestF = readingTempF(newest);
  const oldestF = readingTempF(oldest);
  if (newestF == null || oldestF == null) return null;

  const slopePerHour = (newestF - oldestF) / hours;
  if (slopePerHour >= -0.05) return null;

  const hoursToFreeze = (newestF - 32) / Math.abs(slopePerHour);
  if (newestF <= 40 && hoursToFreeze <= 8) {
    return { reason: 'trending_to_freeze', currentTempF: newestF, hoursToFreeze };
  }

  return null;
}

function isRelayController(device: any) {
  return device?.type === 'relay_controller' || device?.capabilities?.includes?.('water_shutoff');
}

export default function SensorDashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const ownerId = user?.id || 'owner-1';

  const tabFromUrl = searchParams.get('tab') || searchParams.get('view') || 'overview';
  const initialView: DashboardView =
    tabFromUrl === 'analytics' || tabFromUrl === 'alerts' || tabFromUrl === 'topology' || tabFromUrl === 'overview'
      ? tabFromUrl
      : 'overview';
  const layerFromUrl = searchParams.get('layer') || undefined;

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedView, setSelectedView] = useState<DashboardView>(initialView);
  const [selectedProperty, setSelectedProperty] = useState<string>('all');
  const [showInsurancePrompt, setShowInsurancePrompt] = useState(true);
  const [showAddSensor, setShowAddSensor] = useState(false);
  const [showShellySetup, setShowShellySetup] = useState(false);
  const [selectedSetupDeviceType, setSelectedSetupDeviceType] = useState<'flood' | 'ht' | 'gateway' | 'relay' | undefined>(undefined);
  const [selectedPropertyForSetup, setSelectedPropertyForSetup] = useState<string>('');
  const [properties, setProperties] = useState<FirestoreProperty[]>([]);
  const [loadingProperties, setLoadingProperties] = useState(true);
  const [editingSensorId, setEditingSensorId] = useState<string | null>(null);
  const [editingSensorName, setEditingSensorName] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [alertFilter, setAlertFilter] = useState<AlertFilter>('recent');
  const [alertStatusFilter, setAlertStatusFilter] = useState<AlertStatusFilter>('open');
  const [deletingSensorId, setDeletingSensorId] = useState<string | null>(null);
  const [floodReconnecting, setFloodReconnecting] = useState(false);
  const [floodReconnectResult, setFloodReconnectResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showFloodReconnectModal, setShowFloodReconnectModal] = useState(false);
  const [floodReconnectIp, setFloodReconnectIp] = useState('');
  const [relayReconnecting, setRelayReconnecting] = useState(false);
  const [relayReconnectResult, setRelayReconnectResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showRelayReconnectModal, setShowRelayReconnectModal] = useState(false);
  const [relayReconnectIp, setRelayReconnectIp] = useState('');
  const [selectedRelayForReconnect, setSelectedRelayForReconnect] = useState<any>(null);
  const [localShutoffSyncing, setLocalShutoffSyncing] = useState(false);
  const [notifyingAlertId, setNotifyingAlertId] = useState<string | null>(null);
  const [notificationResult, setNotificationResult] = useState<AlertNotificationResult | null>(null);
  const [showNotifyModal, setShowNotifyModal] = useState(false);

  const openAddSensor = useCallback(() => {
    setSelectedPropertyForSetup(properties[0]?.id || '');
    setSelectedSetupDeviceType(undefined);
    setShowAddSensor(true);
  }, [properties]);

  useEffect(() => {
    if (selectedView !== initialView) {
      setSelectedView(initialView);
    }
  }, [initialView]);

  const changeDashboardView = useCallback((tab: DashboardView) => {
    setSelectedView(tab);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      if (tab !== 'analytics') next.delete('layer');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useVoiceActionHandler('add-sensor', openAddSensor, [openAddSensor]);
  useVoiceActionHandler('open-sensor-analytics', () => changeDashboardView('analytics'), [changeDashboardView]);
  useVoiceActionHandler('view-sensor-data', () => changeDashboardView('overview'), [changeDashboardView]);
  useVoiceActionHandler('sensor-tab-overview', () => changeDashboardView('overview'), [changeDashboardView]);
  useVoiceActionHandler('sensor-tab-alerts', () => changeDashboardView('alerts'), [changeDashboardView]);
  useVoiceActionHandler('sensor-tab-analytics', () => changeDashboardView('analytics'), [changeDashboardView]);
  const [selectedAlertForNotify, setSelectedAlertForNotify] = useState<any>(null);
  const [notifyOptions, setNotifyOptions] = useState({
    sendEmail: true,
    sendSMS: true,
    makePhoneCall: false,
    tenantName: '',
    tenantEmail: '',
    tenantPhone: '',
    propertyAddress: '',
  });
  const [activeValveCommand, setActiveValveCommand] = useState<string | null>(null);
  const [valveCommandMessage, setValveCommandMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [relayLiveStatus, setRelayLiveStatus] = useState<Record<string, {
    valveState?: 'open' | 'closed' | 'unknown';
    relayOutputOn?: boolean;
    status?: string;
    online?: boolean;
    lastValveCommand?: string | null;
    lastValveCommandAt?: string | null;
    lastSeen?: string;
    valveTravelMs?: number;
    /** Wall-clock ms of last successful online probe — used to expire stale LIVE. */
    probedAt?: number;
    /** Consecutive unreachable polls while still holding a prior LIVE probe. */
    failCount?: number;
  }>>({});
  const autoNotifyAttemptedRef = useRef<Set<string>>(new Set());
  const autoShutoffAttemptedRef = useRef<Set<string>>(new Set());
  const autoShutoffBaselineReadyRef = useRef(false);
  const autoFreezeShutoffAttemptedRef = useRef<Set<string>>(new Set());

  const hasAutoNotifyBeenAttempted = useCallback((alertId: string) => (
    autoNotifyAttemptedRef.current.has(alertId)
    || sessionStorage.getItem(`hy-auto-notify:${alertId}`) === '1'
  ), []);

  const markAutoNotifyAttempted = useCallback((alertId: string) => {
    autoNotifyAttemptedRef.current.add(alertId);
    sessionStorage.setItem(`hy-auto-notify:${alertId}`, '1');
  }, []);

  const {
    devices: shellyDevices,
    archivedDevices: shellyArchivedDevices,
    alerts: shellyAlerts,
    readings: shellyReadings,
    loading: shellyLoading,
    acknowledgeAlert: acknowledgeShellyAlert,
    updateDeviceProperty,
    deleteSensor,
  } = useShellyFirestore(ownerId);

  const shellyConnected = !shellyLoading;

  // Hold LIVE across slow/failed polls. Local LAN to the travel-router subnet
  // often times out, and Cloud Run may miss the WS on one instance — a 45s
  // hard cut made the valve flicker OFFLINE every couple of minutes.
  const RELAY_ONLINE_STALE_MS = 150_000;

  const mergedShellyDevices = useMemo(() => (
    shellyDevices.map((device): ShellyDevice => {
      if (!isRelayController(device)) return device;
      const live = relayLiveStatus[device.deviceId];
      // Until the first live probe returns, don't trust Firestore "online" for
      // valve control — an unplugged relay can still have a fresh lastSeen.
      if (!live) {
        return {
          ...device,
          status: device.status === 'offline' ? 'offline' : 'unknown',
        };
      }
      const probeAgeMs = live.probedAt != null ? Date.now() - live.probedAt : Number.POSITIVE_INFINITY;
      const probeFresh = live.online === true && probeAgeMs <= RELAY_ONLINE_STALE_MS;
      const liveOnline = probeFresh
        ? 'online'
        : live.online === false || (live.online === true && !probeFresh)
          ? 'offline'
          : (live.status === 'online' || live.status === 'offline' ? live.status : device.status);
      return {
        ...device,
        valveState: live.valveState ?? device.valveState,
        relayOutputOn: live.relayOutputOn ?? device.relayOutputOn,
        status: liveOnline as ShellyDevice['status'],
        lastValveCommand: (live.lastValveCommand ?? device.lastValveCommand) as ShellyDevice['lastValveCommand'],
        lastValveCommandAt: live.lastValveCommandAt ?? device.lastValveCommandAt,
        // Only trust lastSeen from a successful live reachability check.
        lastSeen: (probeFresh && live.lastSeen
          ? live.lastSeen
          : device.lastSeen) as ShellyDevice['lastSeen'],
        valveTravelMs: live.valveTravelMs ?? device.valveTravelMs,
      };
    })
  ), [relayLiveStatus, shellyDevices]);

  const refreshRelayStatus = useCallback(async (device: { deviceId: string; id?: string }) => {
    try {
      const data = await fetchRelayStatus(device.deviceId, device.id);
      setRelayLiveStatus((prev) => {
        const existing = prev[device.deviceId];
        const incomingAt = data.lastValveCommandAt ? new Date(data.lastValveCommandAt).getTime() : 0;
        const existingAt = existing?.lastValveCommandAt ? new Date(existing.lastValveCommandAt).getTime() : 0;
        const keepExistingCommand = existingAt > incomingAt;
        const reachable = data.online === true;
        const priorFresh = Boolean(
          existing?.online === true
          && existing?.probedAt != null
          && (Date.now() - existing.probedAt) <= RELAY_ONLINE_STALE_MS,
        );

        // After open/close, status polls often return a stale opposite valveState
        // (cached Firestore) for a few seconds — that snapped the UI closed and
        // re-triggered the opening animation. Hold the command result briefly.
        const commandAt = keepExistingCommand
          ? existingAt
          : (incomingAt || existingAt);
        const command = keepExistingCommand
          ? existing?.lastValveCommand
          : (data.lastValveCommand ?? existing?.lastValveCommand);
        const commandLockMs = 35_000;
        const commandLocked = Boolean(
          commandAt
          && Date.now() - commandAt < commandLockMs
          && (command === 'open' || command === 'close'),
        );
        const expectedValve = command === 'open' ? 'open' : command === 'close' ? 'closed' : null;
        let nextValveState = data.valveState ?? existing?.valveState;
        let nextRelayOutputOn = data.relayOutputOn ?? existing?.relayOutputOn;
        if (commandLocked && expectedValve) {
          if (data.valveState && data.valveState !== expectedValve) {
            nextValveState = expectedValve;
          }
          // Maintained close-on-energize: open ⇒ output off, close ⇒ output on.
          if (typeof data.relayOutputOn === 'boolean') {
            const outputMatches = expectedValve === 'closed' ? data.relayOutputOn === true : data.relayOutputOn === false;
            if (!outputMatches) {
              nextRelayOutputOn = expectedValve === 'closed';
            }
          } else if (nextRelayOutputOn == null) {
            nextRelayOutputOn = expectedValve === 'closed';
          }
        }

        // One missed poll must not wipe LIVE — keep the last good probe.
        if (!reachable && priorFresh) {
          return {
            ...prev,
            [device.deviceId]: {
              ...existing,
              valveState: nextValveState,
              relayOutputOn: nextRelayOutputOn,
              lastValveCommand: keepExistingCommand ? existing?.lastValveCommand : (data.lastValveCommand ?? existing?.lastValveCommand),
              lastValveCommandAt: keepExistingCommand ? existing?.lastValveCommandAt : (data.lastValveCommandAt ?? existing?.lastValveCommandAt),
              failCount: (existing?.failCount || 0) + 1,
            },
          };
        }

        return {
          ...prev,
          [device.deviceId]: {
            valveState: nextValveState,
            relayOutputOn: nextRelayOutputOn,
            status: reachable ? 'online' : 'offline',
            online: reachable,
            probedAt: reachable ? Date.now() : existing?.probedAt,
            failCount: reachable ? 0 : (existing?.failCount || 0) + 1,
            lastValveCommand: keepExistingCommand ? existing?.lastValveCommand : data.lastValveCommand,
            lastValveCommandAt: keepExistingCommand ? existing?.lastValveCommandAt : data.lastValveCommandAt,
            lastSeen: reachable ? (data.lastSeen || new Date().toISOString()) : existing?.lastSeen,
          },
        };
      });
    } catch (error) {
      console.error('Relay status poll failed:', error);
      setRelayLiveStatus((prev) => {
        const existing = prev[device.deviceId];
        const priorFresh = Boolean(
          existing?.online === true
          && existing?.probedAt != null
          && (Date.now() - existing.probedAt) <= RELAY_ONLINE_STALE_MS,
        );
        if (priorFresh) {
          return {
            ...prev,
            [device.deviceId]: {
              ...existing,
              failCount: (existing?.failCount || 0) + 1,
            },
          };
        }
        return {
          ...prev,
          [device.deviceId]: {
            ...existing,
            online: false,
            status: 'offline',
            failCount: (existing?.failCount || 0) + 1,
          },
        };
      });
    }
  }, []);

  const applyRelayLiveStatus = useCallback((deviceId: string, patch: {
    valveState?: 'open' | 'closed' | 'unknown';
    relayOutputOn?: boolean;
    status?: string;
    online?: boolean;
    lastValveCommand?: string | null;
    lastValveCommandAt?: string | null;
    lastSeen?: string;
    valveTravelMs?: number;
  }) => {
    setRelayLiveStatus((prev) => ({
      ...prev,
      [deviceId]: {
        ...prev[deviceId],
        ...patch,
      },
    }));
  }, []);

  const applyAutoCloseResponse = useCallback((data: {
    ok?: boolean;
    skipped?: boolean;
    success?: boolean;
    results?: Array<{
      ok?: boolean;
      skipped?: boolean;
      deviceId?: string;
      valveState?: string;
      relayOutputOn?: boolean;
      reason?: string;
    }>;
  }) => {
    if (!data?.success && !data?.ok && !data?.skipped) return;
    if (!Array.isArray(data.results)) return;

    const now = new Date().toISOString();
    data.results.forEach((result) => {
      if (!result.deviceId || !result.ok) {
        if (result.deviceId && result.ok === false) {
          applyRelayLiveStatus(result.deviceId, {
            online: false,
            status: 'offline',
          });
        }
        return;
      }
      if (result.skipped && (result.reason === 'recent_auto_close' || result.reason === 'already_closed')) {
        // Do not bump reachability from a skip — only mirror known valve state.
        applyRelayLiveStatus(result.deviceId, {
          valveState: 'closed',
        });
        return;
      }
      if (result.skipped) return;

      applyRelayLiveStatus(result.deviceId, {
        valveState: result.valveState === 'open' || result.valveState === 'closed'
          ? result.valveState
          : 'closed',
        relayOutputOn: result.relayOutputOn,
        // Reachability is decided by the follow-up status poll, not by command intent.
        lastValveCommand: 'close',
        lastValveCommandAt: now,
      });
    });

    shellyDevices
      .filter(isRelayController)
      .forEach((device) => {
        window.setTimeout(() => { void refreshRelayStatus(device); }, 1500);
      });
  }, [applyRelayLiveStatus, refreshRelayStatus, shellyDevices]);

  const activeAutoShutoffAlerts = useMemo(() => (
    shellyAlerts.filter((alert) => isAutoShutoffAlertType(alert.type) && !alert.acknowledged)
  ), [shellyAlerts]);

  useEffect(() => {
    const relayTargets = shellyDevices.filter(isRelayController);
    if (relayTargets.length === 0) return undefined;

    relayTargets.forEach((device) => { void refreshRelayStatus(device); });

    const pollMs = activeAutoShutoffAlerts.length > 0 ? 8000 : 20000;
    const intervalId = window.setInterval(() => {
      relayTargets.forEach((device) => { void refreshRelayStatus(device); });
    }, pollMs);

    // Re-render so probedAt staleness can flip LIVE → offline without waiting
    // for the next network response.
    const staleWatchId = window.setInterval(() => {
      setRelayLiveStatus((prev) => ({ ...prev }));
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
      window.clearInterval(staleWatchId);
    };
  }, [activeAutoShutoffAlerts.length, refreshRelayStatus, shellyDevices]);

  useEffect(() => {
    const fetchProperties = async () => {
      setLoadingProperties(true);
      try {
        const nextProperties = await ownerPropertiesClient.listDetailed(ownerId, { withTenants: true });
        setProperties(nextProperties as FirestoreProperty[]);
        setSelectedPropertyForSetup((currentSelection) => (
          nextProperties.some((property) => property.id === currentSelection)
            ? currentSelection
            : (nextProperties[0]?.id || '')
        ));
      } catch (error) {
        console.error('Error fetching properties:', error);
        setProperties([]);
      } finally {
        setLoadingProperties(false);
      }
    };

    if (ownerId) fetchProperties();
  }, [ownerId]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const pendingFloodAlerts = shellyAlerts.filter((alert) => (
      alert.type === 'flood'
      && alert.severity === 'critical'
      && !alert.acknowledged
      && !alert.notificationSent
      && !hasAutoNotifyBeenAttempted(alert.id)
    ));

    pendingFloodAlerts.forEach((alert) => {
      markAutoNotifyAttempted(alert.id);
      setNotifyingAlertId(alert.id);

      fetch(`${SHELLY_API_BASE}/api/shelly/alerts/${encodeURIComponent(alert.id)}/auto-notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sendEmail: true,
          sendSMS: true,
          makePhoneCall: true,
          practiceTestPhone: getStoredPracticeTestPhone(),
          dispatchOwnerMaintenance: true,
        }),
      })
        .then(async (response) => {
          const data = await response.json();
          if (data.success && data.result) {
            setNotificationResult(data.result);
          } else if (data.success && data.ownerMaintenanceDispatch) {
            setNotificationResult(data.ownerMaintenanceDispatch);
          } else if (!response.ok) {
            console.error('Auto tenant notification failed:', data.error || response.statusText, data.ownerMaintenanceDispatch || '');
          } else if (data.ownerMaintenanceDispatch && !data.ownerMaintenanceDispatch.ok) {
            console.error('Owner maintenance SMS failed:', data.ownerMaintenanceDispatch.error || data.ownerMaintenanceDispatch.reason);
          }
        })
        .catch((error) => {
          console.error('Auto tenant notification failed:', error);
        })
        .finally(() => {
          setNotifyingAlertId((current) => (current === alert.id ? null : current));
        });
    });
  }, [hasAutoNotifyBeenAttempted, markAutoNotifyAttempted, shellyAlerts]);

  useEffect(() => {
    if (shellyLoading || autoShutoffBaselineReadyRef.current) {
      return;
    }

    shellyAlerts.forEach((alert) => {
      autoShutoffAttemptedRef.current.add(alert.id);
    });
    autoShutoffBaselineReadyRef.current = true;
  }, [shellyAlerts, shellyLoading]);

  useEffect(() => {
    if (!autoShutoffBaselineReadyRef.current) {
      return;
    }

    const pendingShutoffAlerts = shellyAlerts.filter((alert) => (
      isAutoShutoffAlertType(alert.type)
      && !alert.acknowledged
      && !autoShutoffAttemptedRef.current.has(alert.id)
    ));

    pendingShutoffAlerts.forEach((alert) => {
      autoShutoffAttemptedRef.current.add(alert.id);
      const isFreezeAlert = alert.type === 'freeze_risk'
        || alert.type === 'pipe_burst'
        || alert.type === 'rapid_temp_change';

      fetch(`${SHELLY_API_BASE}/api/shelly/water-shutoff/auto-close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: alert.propertyId,
          alertId: alert.id,
          sensorDeviceId: alert.deviceId,
          source: isFreezeAlert ? 'dashboard_freeze_alert' : 'dashboard_flood_alert',
          reason: isFreezeAlert ? 'freeze' : 'leak',
        }),
      })
        .then(async (response) => {
          const data = await response.json();
          if (data.success && (data.ok || data.skipped)) {
            applyAutoCloseResponse(data);
            if (data.ok) {
              setValveCommandMessage({
                type: 'success',
                text: isFreezeAlert
                  ? 'Water valve auto-closed due to freeze risk.'
                  : 'Water valve auto-closed due to leak detection.',
              });
            }
          } else if (!response.ok || (!data.ok && !data.skipped)) {
            const resultError = data.results?.find((entry: any) => !entry.ok && !entry.skipped)?.error;
            console.error(
              'Auto water shutoff failed:',
              resultError || data.error || data.reason || response.statusText,
              data,
            );
          }
        })
        .catch((error) => {
          console.error('Auto water shutoff failed:', error);
        });
    });
  }, [applyAutoCloseResponse, shellyAlerts]);

  useEffect(() => {
    if (!autoShutoffBaselineReadyRef.current || shellyLoading) {
      return;
    }

    const tempDevices = shellyDevices.filter((device) => (
      device.type === 'temperature_humidity'
      || device.temperature != null
      || device.temperatureF != null
    ));

    tempDevices.forEach((device) => {
      if (!device.propertyId) return;

      const trigger = evaluateFreezeShutoffFromReadings(device, shellyReadings);
      if (!trigger) return;

      const triggerKey = `${device.deviceId}:${trigger.reason}`;
      if (autoFreezeShutoffAttemptedRef.current.has(triggerKey)) return;
      autoFreezeShutoffAttemptedRef.current.add(triggerKey);

      fetch(`${SHELLY_API_BASE}/api/shelly/water-shutoff/auto-close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: device.propertyId,
          alertId: triggerKey,
          sensorDeviceId: device.deviceId,
          source: 'dashboard_freeze_readings',
          reason: 'freeze',
        }),
      })
        .then(async (response) => {
          const data = await response.json();
          if (data.success && (data.ok || data.skipped)) {
            applyAutoCloseResponse(data);
            if (data.ok) {
              setValveCommandMessage({
                type: 'success',
                text: `Water valve auto-closed — ${device.name} at ${trigger.currentTempF?.toFixed(0)}°F${
                  trigger.hoursToFreeze != null ? ` (~${trigger.hoursToFreeze.toFixed(1)}h to freezing)` : ''
                }.`,
              });
            }
          } else if (!response.ok || (!data.ok && !data.skipped)) {
            console.error('Auto freeze shutoff failed:', data.reason || data.error || response.statusText);
          }
        })
        .catch((error) => {
          console.error('Auto freeze shutoff failed:', error);
        });
    });
  }, [applyAutoCloseResponse, shellyDevices, shellyReadings, shellyLoading]);

  const filteredDevices = useMemo(() => (
    selectedProperty === 'all'
      ? mergedShellyDevices
      : mergedShellyDevices.filter((device) => propertyIdsMatch(device.propertyId, selectedProperty))
  ), [mergedShellyDevices, selectedProperty]);

  const propertyMap = useMemo(() => {
    const map = new Map<string, string>();
    properties.forEach((property) => map.set(property.id, property.address));
    return map;
  }, [properties]);

  /*
   * Health components for the twin's Health overlay. Only for a single
   * selected property — "all" has no one house to draw them in, and the
   * cutaway is already showing a generic shell in that case.
   */
  const twinHealthProperty = useMemo(
    () => (selectedProperty === 'all'
      ? null
      : properties.find((property) => property.id === selectedProperty) ?? null),
    [properties, selectedProperty],
  );

  // The stored summary is typed to the handful of fields the sensor views
  // need; the vintage and region fields the priors engine wants are present in
  // the payload but outside that type.
  const twinHealthSummary = (twinHealthProperty?.propertyData?.summary ?? {}) as Record<string, any>;

  const { assets: twinHealthAssets } = usePropertyHealthAssets({
    ownerId,
    propertyId: twinHealthProperty?.id ?? null,
    propertyAddress: twinHealthProperty?.address,
    yearBuilt: Number(twinHealthSummary.year_built) || null,
    state: twinHealthSummary.area_context?.state_code ?? null,
    county: twinHealthSummary.area_context?.county ?? null,
  });

  const filteredAlerts = useMemo(() => (
    selectedProperty === 'all'
      ? shellyAlerts
      : shellyAlerts.filter((alert) => alertMatchesProperty(alert, selectedProperty, shellyDevices, shellyArchivedDevices))
  ), [selectedProperty, shellyAlerts, shellyArchivedDevices, shellyDevices]);

  const filteredReadings = useMemo(() => {
    if (selectedProperty === 'all') return shellyReadings;

    const allowedDeviceIds = new Set<string>([
      ...mergedShellyDevices
        .filter((device) => propertyIdsMatch(device.propertyId, selectedProperty))
        .map((device) => device.deviceId),
      ...shellyArchivedDevices
        .filter((device) => propertyIdsMatch(device.propertyId, selectedProperty))
        .map((device) => device.deviceId),
      ...shellyAlerts
        .filter((alert) => alertMatchesProperty(alert, selectedProperty, shellyDevices, shellyArchivedDevices))
        .map((alert) => alert.deviceId)
        .filter(Boolean),
    ]);

    return shellyReadings.filter((reading) => allowedDeviceIds.has(reading.deviceId));
  }, [mergedShellyDevices, selectedProperty, shellyAlerts, shellyArchivedDevices, shellyDevices, shellyReadings]);

  const filteredArchivedDevices = useMemo(() => (
    selectedProperty === 'all'
      ? shellyArchivedDevices
      : shellyArchivedDevices.filter((device) => propertyIdsMatch(device.propertyId, selectedProperty))
  ), [selectedProperty, shellyArchivedDevices]);

  useEffect(() => {
    const totalCount = filteredDevices.length;
    const onlineSensors = filteredDevices.filter((device) => device.status === 'online').length;
    const activeAlerts = filteredAlerts.filter((alert) => !alert.acknowledged);
    const criticalAlerts = activeAlerts.filter((alert) => alert.severity === 'critical').length;

    setSystemStatus({
      allSystemsOnline: totalCount > 0 && onlineSensors === totalCount && criticalAlerts === 0,
      totalSensors: totalCount,
      onlineSensors,
      activeAlerts: activeAlerts.length,
      criticalAlerts,
      lastUpdated: new Date().toISOString(),
    });
  }, [filteredAlerts, filteredDevices]);

  async function handleRenameSensor(deviceId: string, newName: string) {
    if (!newName.trim()) return;
    setRenameSaving(true);
    try {
      const response = await fetch(`${SHELLY_API_BASE}/api/shelly/device/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!response.ok) throw new Error('Failed to rename sensor');
      setEditingSensorId(null);
      setEditingSensorName('');
    } catch (error) {
      console.error('Rename sensor error:', error);
    } finally {
      setRenameSaving(false);
    }
  }

  /** Persist where the owner dropped a device pin on the cutaway twin. */
  async function handleAssignRoom(deviceId: string, roomId: string | null) {
    try {
      const response = await fetch(`${SHELLY_API_BASE}/api/shelly/device/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ twinRoomId: roomId }),
      });
      if (!response.ok) throw new Error('Failed to save device placement');
    } catch (error) {
      console.error('Assign room error:', error);
    }
  }

  async function handleAssignUnit(deviceId: string, unitId: string | null) {
    try {
      const response = await fetch(`${SHELLY_API_BASE}/api/shelly/device/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ twinUnitId: unitId }),
      });
      if (!response.ok) throw new Error('Failed to save device placement');
    } catch (error) {
      console.error('Assign unit error:', error);
    }
  }

  async function handleRemoveFromProperty(device: any) {
    const confirmed = window.confirm(`Remove ${device.name} from its property? The sensor will stay in your account and move to Unassigned Sensors.`);
    if (!confirmed) return;

    try {
      await updateDeviceProperty(device.id, null, ownerId);
    } catch (error) {
      console.error('Remove sensor from property failed:', error);
      window.alert('Failed to remove the sensor from this property.');
    }
  }

  async function handleDeleteSensor(device: any) {
    const confirmed = window.confirm(
      `Remove ${device.name} from active monitoring? The sensor will be unregistered, but this property will keep its alert history and analytics.`
    );
    if (!confirmed) return;

    setDeletingSensorId(device.id);
    try {
      await deleteSensor(device.id, device.deviceId);
    } catch (error) {
      console.error('Delete sensor failed:', error);
      window.alert(error instanceof Error ? error.message : 'Failed to delete the sensor.');
    } finally {
      setDeletingSensorId(null);
    }
  }

  async function handleFloodReconnect(deviceId: string, manualIp?: string) {
    setFloodReconnecting(true);
    setFloodReconnectResult(null);
    try {
      const response = await fetch(`${SHELLY_API_BASE}/api/shelly/flood/reconfigure-webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          deviceIp: manualIp || undefined,
          propertyId: selectedProperty !== 'all' ? selectedProperty : undefined,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setFloodReconnectResult({ success: true, message: data.message || 'Flood alerts configured successfully.' });
        setTimeout(() => {
          setShowFloodReconnectModal(false);
          setFloodReconnectResult(null);
        }, 3000);
      } else {
        setFloodReconnectResult({ success: false, message: data.error || 'Failed to configure flood alerts.' });
      }
    } catch (error: any) {
      setFloodReconnectResult({ success: false, message: error.message || 'Network error' });
    } finally {
      setFloodReconnecting(false);
    }
  }

  async function handleSyncLocalShutoff(propertyId?: string) {
    const targetPropertyId = propertyId
      || selectedRelayForReconnect?.propertyId
      || (selectedProperty !== 'all' ? selectedProperty : '');
    if (!targetPropertyId) {
      setRelayReconnectResult({
        success: false,
        message: 'Select a property first, then sync offline LAN shutoff.',
      });
      return;
    }
    setLocalShutoffSyncing(true);
    setRelayReconnectResult(null);
    try {
      const response = await fetch(`${SHELLY_API_BASE}/api/shelly/local-shutoff/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: targetPropertyId }),
      });
      const data = await response.json();
      if (data.success) {
        setRelayReconnectResult({
          success: true,
          message: data.message || 'Flood sensors will close the valve over the GL.iNet LAN even if internet is down.',
        });
        setValveCommandMessage({
          type: 'success',
          text: data.message || 'Offline LAN shutoff synced.',
        });
      } else {
        setRelayReconnectResult({
          success: false,
          message: data.error || data.reason || 'Failed to sync offline LAN shutoff.',
        });
      }
    } catch (error: any) {
      setRelayReconnectResult({
        success: false,
        message: error.message || 'Network error',
      });
    } finally {
      setLocalShutoffSyncing(false);
    }
  }

  async function handleRelayReconnect(device: any, manualIp?: string) {
    setRelayReconnecting(true);
    setRelayReconnectResult(null);
    try {
      const response = await fetch(`${SHELLY_API_BASE}/api/shelly/relay/reconfigure-cloud`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: device.deviceId,
          deviceIp: manualIp || undefined,
        }),
      });
      const data = await response.json();
      if (data.success) {
        const localNote = data.localShutoffSync?.ok
          ? ' Offline flood→valve LAN hooks refreshed.'
          : '';
        setRelayReconnectResult({
          success: true,
          message: (data.message || 'Relay remote control configured successfully.') + localNote,
        });
        setValveCommandMessage({
          type: 'success',
          text: data.message || `Remote control restored for ${device.name}.`,
        });
        window.setTimeout(() => { void refreshRelayStatus(device); }, 1200);
        window.setTimeout(() => {
          setShowRelayReconnectModal(false);
          setRelayReconnectResult(null);
          setRelayReconnectIp('');
          setSelectedRelayForReconnect(null);
        }, 4000);
      } else {
        setRelayReconnectResult({
          success: false,
          message: data.error || 'Failed to reconfigure relay remote control.',
        });
      }
    } catch (error: any) {
      setRelayReconnectResult({
        success: false,
        message: error.message || 'Network error',
      });
    } finally {
      setRelayReconnecting(false);
    }
  }

  async function handleNotifyTenant(alertToNotify: any) {
    if (!notifyOptions.tenantEmail && !notifyOptions.tenantPhone) {
      window.alert('Please provide at least an email or phone number.');
      return;
    }

    setNotifyingAlertId(alertToNotify.id);
    try {
      const response = await fetch(`${SHELLY_API_BASE}/api/shelly/alerts/${alertToNotify.id}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert: {
            id: alertToNotify.id,
            type: alertToNotify.type || 'flood',
            level: alertToNotify.severity || 'critical',
            severity: alertToNotify.severity || 'critical',
            deviceId: alertToNotify.deviceId || alertToNotify.id,
            deviceName: alertToNotify.deviceName,
            sensorLocation: alertToNotify.deviceName || 'Unknown',
            message: alertToNotify.message || 'Sensor alert detected',
            timestamp: alertToNotify.timestamp instanceof Date
              ? alertToNotify.timestamp.toISOString()
              : alertToNotify.timestamp || new Date().toISOString(),
            acknowledged: alertToNotify.acknowledged || false,
            data: alertToNotify.data,
          },
          propertyInfo: {
            address: notifyOptions.propertyAddress || 'Property Address',
            tenants: [{
              name: notifyOptions.tenantName || 'Tenant',
              email: notifyOptions.tenantEmail,
              phone: notifyOptions.tenantPhone,
              unit: '1',
              status: 'Current',
            }],
          },
          sendEmail: notifyOptions.sendEmail,
          sendSMS: notifyOptions.sendSMS,
          makePhoneCall: notifyOptions.makePhoneCall,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setNotificationResult(data.result);
        setShowNotifyModal(false);
      }
    } catch (error) {
      console.error('Error sending notification:', error);
    } finally {
      setNotifyingAlertId(null);
    }
  }

  async function handleValveCommand(device: any, action: 'open' | 'close') {
    const offline = device?.status === 'offline' || device?.status === 'unknown';
    if (offline) {
      setValveCommandMessage({
        type: 'error',
        text: device?.status === 'unknown'
          ? 'Checking relay connectivity… wait a moment, or plug the Shelly 1 Gen4 back in.'
          : 'Water shutoff relay is offline. Plug it in and reconnect before opening or closing the valve.',
      });
      return;
    }

    const currentState = device?.valveState === 'open' || device?.valveState === 'closed'
      ? device.valveState
      : (device?.relayOutputOn === true && device?.relayCloseOn !== false
        ? 'closed'
        : device?.relayOutputOn === false && device?.relayCloseOn !== false
          ? 'open'
          : 'unknown');

    if (action === 'close' && currentState === 'closed') {
      setValveCommandMessage({
        type: 'success',
        text: 'Valve is already closed — no command sent.',
      });
      return;
    }
    if (action === 'open' && currentState === 'open') {
      setValveCommandMessage({
        type: 'success',
        text: 'Valve is already open — no command sent.',
      });
      return;
    }

    setActiveValveCommand(`${device.deviceId}:${action}`);
    setValveCommandMessage(null);
    try {
      const data = await sendRelayCommand({
        deviceId: device.deviceId,
        deviceDocId: device.id,
        action,
        ...(device.actuationMode === 'momentary'
          ? { durationMs: device.pulseDurationMs ?? 20000 }
          : {}),
      });
      setValveCommandMessage({
        type: 'success',
        text: data.message || `Valve ${action} command sent${data.source ? ` via ${data.source}` : ''}.`,
      });
      const commandedOpen = action === 'open';
      const closeOnEnergize = device.relayCloseOn !== false;
      applyRelayLiveStatus(device.deviceId, {
        valveState: data.valveState === 'open' || data.valveState === 'closed'
          ? data.valveState
          : (commandedOpen ? 'open' : 'closed'),
        relayOutputOn: typeof data.relayOutputOn === 'boolean'
          ? data.relayOutputOn
          : (closeOnEnergize ? !commandedOpen : commandedOpen),
        online: true,
        status: 'online',
        lastValveCommand: data.action || action,
        lastValveCommandAt: new Date().toISOString(),
      });
      // Delay the first status refresh until travel is mostly done so a stale
      // cached "closed" reading can't snap the animation backwards.
      window.setTimeout(() => { void refreshRelayStatus(device); }, 12_000);
    } catch (error) {
      setValveCommandMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to send valve command.',
      });
      applyRelayLiveStatus(device.deviceId, {
        online: false,
        status: 'offline',
      });
    } finally {
      setActiveValveCommand(null);
    }
  }

  const filteredAlertsByCategory = useMemo(() => {
    let base = filteredAlerts;
    if (alertFilter === 'critical') base = base.filter((a) => a.severity === 'critical');
    else if (alertFilter === 'warning') base = base.filter((a) => a.severity === 'warning');
    else if (alertFilter === 'info') base = base.filter((a) => a.severity !== 'critical' && a.severity !== 'warning');
    else if (alertFilter === 'recent') {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      base = base.filter((a) => new Date(a.timestamp).getTime() > cutoff);
    }
    return base;
  }, [filteredAlerts, alertFilter]);

  // Collapse repeated identical alerts (e.g. a flood sensor firing the same
  // message over and over) into one row with a count and first/last seen.
  const groupedAlertsByCategory = useMemo(() => {
    const groups: Array<{ alert: typeof filteredAlertsByCategory[number]; count: number; firstSeen: Date | string; lastSeen: Date | string }> = [];
    const indexByKey = new Map<string, number>();

    // Sort newest-first so the representative alert of each group is the latest occurrence.
    const sorted = [...filteredAlertsByCategory].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    sorted.forEach((alert) => {
      const key = buildAlertDuplicateKey(alert);
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, groups.length);
        groups.push({ alert, count: 1, firstSeen: alert.timestamp, lastSeen: alert.timestamp });
      } else {
        const group = groups[existingIndex];
        group.count += 1;
        if (new Date(alert.timestamp).getTime() < new Date(group.firstSeen).getTime()) group.firstSeen = alert.timestamp;
        if (new Date(alert.timestamp).getTime() > new Date(group.lastSeen).getTime()) group.lastSeen = alert.timestamp;
      }
    });

    return groups;
  }, [filteredAlertsByCategory]);

  const visibleAlertGroups = useMemo(() => (
    alertStatusFilter === 'open' ? groupedAlertsByCategory.filter((group) => !group.alert.acknowledged) : groupedAlertsByCategory
  ), [alertStatusFilter, groupedAlertsByCategory]);

  const openAlertGroupCount = useMemo(() => (
    groupedAlertsByCategory.filter((group) => !group.alert.acknowledged).length
  ), [groupedAlertsByCategory]);

  if (loading || loadingProperties) {
    return (
      <div className="flex h-screen flex-1 items-center justify-center bg-gray-50">
        <div className={`${sectionShell} w-full max-w-md text-center`}>
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-violet-500" />
          <p className="mt-5 text-base font-semibold text-slate-900">Loading predictive maintenance data...</p>
          <p className="mt-2 text-sm text-slate-500">Syncing properties, devices, and active alerts.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(226,232,240,0.8),_transparent_32%),linear-gradient(180deg,_#f8fafc_0%,_#eef2f7_100%)] text-slate-900" data-voice-id="sensor-dashboard">
      <div className="px-6 py-6">
        <div className="mx-auto w-full max-w-7xl">
          <WorkspaceTabsHeader
        eyebrow="Predictive Maintenance"
        activeTab={selectedView}
        onTabChange={(tab) => changeDashboardView(tab)}
        rightContent={
          <div className="flex flex-wrap items-end gap-3">
            {properties.length > 0 && (
              <label className="block w-full max-w-sm sm:w-[340px]">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 sm:justify-end">
                  <Home size={12} className="text-slate-400" />
                  Viewing property
                </div>
                <div className="relative">
                  <select
                    value={selectedProperty}
                    onChange={(event) => setSelectedProperty(event.target.value)}
                    data-voice-id="sensor-property-select"
                    className="ds-focus-ring w-full appearance-none rounded-2xl border-2 border-slate-300 bg-white px-4 py-2.5 pr-10 text-[15px] font-semibold text-slate-900 shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-500"
                  >
                    <option value="all">All properties</option>
                    {properties.map((property) => (
                      <option key={property.id} value={property.id}>{property.address}</option>
                    ))}
                  </select>
                  <ChevronDown size={18} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
              </label>
            )}
            <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-400">
              Updated {systemStatus?.lastUpdated ? new Date(systemStatus.lastUpdated).toLocaleTimeString() : 'N/A'}
            </span>
            {shellyConnected && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                {shellyDevices.length} live
              </span>
            )}
            <button
              onClick={() => navigate('/insurance-discount')}
              className="rounded-2xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-violet-700"
            >
              Insurance Discount
            </button>
            <button
              onClick={() => { setSelectedPropertyForSetup(properties[0]?.id || ''); setSelectedSetupDeviceType(undefined); setShowAddSensor(true); }}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Add Device
            </button>
            </div>
          </div>
        }
        tabs={[
          {
            id: 'overview',
            label: 'Overview',
            buttonProps: { 'data-voice-id': 'sensor-tab-overview' } as React.ButtonHTMLAttributes<HTMLButtonElement>,
          },
          {
            id: 'alerts',
            label: 'Alerts',
            buttonProps: { 'data-voice-id': 'sensor-tab-alerts' } as React.ButtonHTMLAttributes<HTMLButtonElement>,
          },
          {
            id: 'analytics',
            label: 'Analytics',
            buttonProps: { 'data-voice-id': 'sensor-tab-analytics' } as React.ButtonHTMLAttributes<HTMLButtonElement>,
          },
        ]}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1480px] space-y-5 px-4 py-5 lg:px-6">

        {/* ── KPI strip ── */}
        <KpiStrip
          items={[
            { label: 'Total sensors', value: systemStatus?.totalSensors || 0 },
            { label: 'Online', value: systemStatus?.onlineSensors || 0, tone: 'positive' },
            {
              label: 'Active alerts',
              value: systemStatus?.activeAlerts || 0,
              tone: (systemStatus?.activeAlerts || 0) > 0 ? 'negative' : 'default',
            },
            {
              label: 'Critical',
              value: systemStatus?.criticalAlerts || 0,
              tone: (systemStatus?.criticalAlerts || 0) > 0 ? 'negative' : 'default',
            },
          ]}
        />

        {/* ── Tabs ── */}
        <div className={`${sectionShell} !p-0 overflow-hidden`}>
          <div className="space-y-5 p-5">

            {/* ═══ OVERVIEW (includes live property twin) ═══ */}
            {(selectedView === 'overview' || selectedView === 'topology') && (
              <div className="space-y-5" data-voice-id="sensor-overview-content">
                <DeviceTopologyMap
                  devices={filteredDevices}
                  alerts={filteredAlerts}
                  properties={properties.map((property) => ({
                    id: property.id,
                    address: property.address,
                    beds: property.propertyData?.summary?.beds,
                    baths: property.propertyData?.summary?.baths,
                    // ATTOM stores coordinates under `location`; `summary` is
                    // frequently missing them, which left the twin without the
                    // position it needs to model flood risk.
                    latitude: Number(
                      property.propertyData?.summary?.latitude
                      ?? property.propertyData?.location?.latitude,
                    ) || undefined,
                    longitude: Number(
                      property.propertyData?.summary?.longitude
                      ?? property.propertyData?.location?.longitude,
                    ) || undefined,
                    livingSqft: property.propertyData?.summary?.living_sqft,
                    attomId: property.propertyData?.summary?.attom_id
                      ? String(property.propertyData.summary.attom_id)
                      : undefined,
                    // Only pass the outline when we actually have one. Leaving
                    // this undefined lets the lot view fetch for itself; passing
                    // null would tell it there is nothing to draw.
                    parcelGeometry: property.propertyData?.parcel_geometry ?? undefined,
                    buildingGeometry: property.propertyData?.building_geometry ?? undefined,
                  }))}
                  selectedPropertyId={selectedProperty}
                  onSelectProperty={setSelectedProperty}
                  healthAssets={twinHealthAssets}
                  onOpenHealthAsset={() => {
                    if (twinHealthProperty) {
                      navigate(`/portfolio?tab=properties&property=${twinHealthProperty.id}&workspace=propertyHealth`);
                    }
                  }}
                  activeValveCommand={activeValveCommand}
                  valveCommandMessage={valveCommandMessage}
                  onValveCommand={handleValveCommand}
                  onRenameDevice={(device, newName) => handleRenameSensor(device.deviceId, newName)}
                  onAssignRoom={(device, roomId) => handleAssignRoom(device.deviceId, roomId)}
                  onAssignUnit={(device, unitId) => handleAssignUnit(device.deviceId, unitId)}
                  onUnassignDevice={handleRemoveFromProperty}
                  onDeleteDevice={handleDeleteSensor}
                  onReconfigureFlood={() => { setShowFloodReconnectModal(true); setFloodReconnectIp(''); setFloodReconnectResult(null); }}
                  onReconnectRelay={(device) => {
                    setSelectedRelayForReconnect(device);
                    setRelayReconnectIp('');
                    setRelayReconnectResult(null);
                    setShowRelayReconnectModal(true);
                  }}
                  onAcknowledgeAlert={acknowledgeShellyAlert}
                  onAddDevice={(deviceType) => {
                    setSelectedPropertyForSetup(
                      selectedProperty && selectedProperty !== 'all'
                        ? selectedProperty
                        : properties[0]?.id || '',
                    );
                    setSelectedSetupDeviceType(deviceType);
                    if (deviceType) {
                      setShowShellySetup(true);
                    } else {
                      setShowAddSensor(true);
                    }
                  }}
                  deletingDeviceId={deletingSensorId}
                />

              </div>
            )}

            {/* ═══ ALERTS ═══ */}
            {selectedView === 'alerts' && (
              <div className="space-y-4" data-voice-id="sensor-alerts-content">
                {notificationResult && (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-emerald-800">Notifications Sent</h3>
                        <p className="mt-1 text-xs text-emerald-700">
                          Email {notificationResult.notifications.email?.ok ? 'sent' : 'skipped'} · SMS {notificationResult.notifications.sms?.ok ? 'sent' : 'skipped'} · Phone {notificationResult.notifications.phoneCall?.ok ? 'called' : 'skipped'}
                        </p>
                        {notificationResult.maintenanceRequest && (
                          <p className="mt-1 text-xs text-emerald-700">Maintenance request #{notificationResult.maintenanceRequest.id} created.</p>
                        )}
                      </div>
                      <button onClick={() => setNotificationResult(null)} className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">Dismiss</button>
                    </div>
                  </div>
                )}

                {/* Alert filter bar */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <div className="inline-flex border border-slate-200 bg-white p-0.5">
                      <button
                        onClick={() => setAlertStatusFilter('open')}
                        className={`px-3 py-1 text-xs font-semibold transition ${alertStatusFilter === 'open' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                      >
                        Open ({openAlertGroupCount})
                      </button>
                      <button
                        onClick={() => setAlertStatusFilter('all')}
                        className={`px-3 py-1 text-xs font-semibold transition ${alertStatusFilter === 'all' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                      >
                        All ({groupedAlertsByCategory.length})
                      </button>
                    </div>
                    <select
                      value={alertFilter}
                      onChange={(e) => setAlertFilter(e.target.value as AlertFilter)}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-violet-400 focus:outline-none"
                    >
                      <option value="recent">Recent (7 days)</option>
                      <option value="all">All Time</option>
                      <option value="critical">Critical Only</option>
                      <option value="warning">Warnings Only</option>
                      <option value="info">Info / Low</option>
                    </select>
                  </div>
                </div>

                {visibleAlertGroups.length === 0 && (
                  <div className={`${cardPanel} p-8 text-center`}>
                    <div className="text-4xl">✅</div>
                    <h3 className="mt-3 text-lg font-semibold text-slate-900">
                      {alertStatusFilter === 'open' ? 'No open alerts' : 'No alerts match this filter'}
                    </h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {alertStatusFilter === 'open'
                        ? 'Everything is quiet right now — switch to "All" to see resolved history.'
                        : 'Try switching to "All Time" or a different severity level.'}
                    </p>
                  </div>
                )}

                {/* Grouped, contained-scroll alert rows */}
                <div className="max-h-[min(560px,60vh)] space-y-2 overflow-y-auto pr-1">
                  {visibleAlertGroups.map(({ alert, count, firstSeen, lastSeen }) => {
                    const property = properties.find((candidate) => (
                      alertMatchesProperty(alert, candidate.id, shellyDevices, shellyArchivedDevices)
                    ));

                    return (
                      <div key={alert.id} className={`flex items-center gap-4 rounded-xl border bg-white px-4 py-3 ${alert.acknowledged ? 'opacity-50 border-slate-100' : 'border-slate-200'}`}>
                        <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                          alert.severity === 'critical' ? 'bg-rose-100 text-rose-700' : alert.severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {alert.severity}
                        </span>
                        {count > 1 && (
                          <span className="flex-shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                            {count}× grouped
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-slate-900">{alert.deviceName}</span>
                            {property && <span className="text-xs text-slate-400">@ {property.address}</span>}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">{cleanAlertMessage(alert.message)}</div>
                          {count > 1 && (
                            <div className="mt-0.5 text-[10px] text-slate-400">
                              First seen {formatNotificationTime(firstSeen)} · last {formatNotificationTime(lastSeen)}
                            </div>
                          )}
                          {(alert.notificationSent || alert.tenantNotifiedAt || alert.tenantNotification?.sentAt) && (
                            <div className="mt-1 text-[10px] font-medium text-emerald-600">
                              Tenant notified {formatNotificationTime(alert.tenantNotifiedAt || alert.tenantNotification?.sentAt)}
                            </div>
                          )}
                          {notifyingAlertId === alert.id && (
                            <div className="mt-1 text-[10px] font-medium text-violet-600">Notifying tenant...</div>
                          )}
                        </div>
                        <div className="flex-shrink-0 text-right text-[10px] text-slate-400">
                          {new Date(alert.timestamp).toLocaleDateString()}<br />
                          {new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        {!alert.acknowledged && (
                          <div className="flex flex-shrink-0 gap-1.5">
                            <button
                              onClick={() => { setSelectedAlertForNotify(alert); setShowNotifyModal(true); }}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                            >
                              Notify
                            </button>
                            <button
                              onClick={() => acknowledgeShellyAlert(alert.id)}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ═══ ANALYTICS ═══ */}
            {selectedView === 'analytics' && (
              <div className="space-y-5" data-voice-id="sensor-analytics-content">
                <EnvironmentalAnalytics
                  devices={filteredDevices}
                  archivedDevices={filteredArchivedDevices}
                  readings={filteredReadings}
                  properties={properties}
                  selectedProperty={selectedProperty}
                  initialLayer={layerFromUrl === 'mold' || layerFromUrl === 'freeze' || layerFromUrl === 'insulation' || layerFromUrl === 'conditions' || layerFromUrl === 'weather' ? layerFromUrl : undefined}
                  onLayerChange={(layer) => {
                    setSearchParams((prev) => {
                      const next = new URLSearchParams(prev);
                      next.set('tab', 'analytics');
                      next.set('layer', layer);
                      return next;
                    }, { replace: true });
                  }}
                />

                {systemStatus?.allSystemsOnline && showInsurancePrompt && (
                  <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <h3 className="text-base font-semibold text-violet-900">Insurance discount eligible</h3>
                        <p className="mt-1 text-sm text-violet-700">Your system has maintained stable coverage. Package your proof of protection and submit it directly to your insurer.</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => navigate('/insurance-discount')} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">Open Discount Flow</button>
                        <button onClick={() => setShowInsurancePrompt(false)} className="rounded-xl border border-violet-200 px-4 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-100">Dismiss</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
      </div>

      {/* ── Modals ── */}
      {showFloodReconnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={() => !floodReconnecting && setShowFloodReconnectModal(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900">Reconfigure Flood Alerts</h3>
            <p className="mt-1 text-sm text-slate-500">Wake the flood sensor first, then run the webhook setup within 30 seconds.</p>

            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              Press the sensor button first, then reconfigure while it is awake.
            </div>

            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600 break-all">
              <div className="font-semibold text-slate-800">Alert destination (Cloud Run)</div>
              <div className="mt-1 font-mono">{resolveShellyWebhookUrl()}?device_id=…&event=flood.alarm</div>
            </div>

            <label className="mt-4 block text-xs font-medium text-slate-600">Sensor IP (optional)</label>
            <input
              type="text"
              value={floodReconnectIp}
              onChange={(event) => setFloodReconnectIp(event.target.value)}
              placeholder="192.168.1.xxx"
              className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none"
              disabled={floodReconnecting}
            />

            {floodReconnectResult && (
              <div className={`mt-3 rounded-xl border px-3 py-2.5 text-xs ${floodReconnectResult.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
                {floodReconnectResult.message}
              </div>
            )}

            <div className="mt-4 flex gap-3">
              <button
                onClick={() => {
                  const resolved = resolveFloodDeviceForReconnect(mergedShellyDevices);
                  if ('error' in resolved) {
                    setFloodReconnectResult({ success: false, message: resolved.error });
                    return;
                  }
                  handleFloodReconnect(resolved.deviceId, floodReconnectIp || undefined);
                }}
                disabled={floodReconnecting}
                className="flex-1 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {floodReconnecting ? 'Configuring...' : 'Reconfigure'}
              </button>
              <button onClick={() => setShowFloodReconnectModal(false)} disabled={floodReconnecting} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showRelayReconnectModal && selectedRelayForReconnect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={() => !relayReconnecting && setShowRelayReconnectModal(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900">Reconnect Relay + Offline Shutoff</h3>
            <p className="mt-1 text-sm text-slate-500">
              Join the GL.iNet IoT Wi‑Fi (5 GHz is fine if you can reach the relay IP), then refresh outbound HouseYield control and LAN flood→valve hooks.
            </p>

            <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
              Reconnect installs a on-device WS watchdog (re-enables HouseYield every 2 minutes after Wi‑Fi flaps) and refreshes flood webhooks that call the relay directly on the LAN when internet is down.
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <div className="font-semibold text-slate-700">{selectedRelayForReconnect.name}</div>
              <div className="mt-1">{resolvePropertyAddress(selectedRelayForReconnect.propertyId, properties, propertyMap)}</div>
              <div className="mt-1 text-slate-500">{selectedRelayForReconnect.location || 'Main shutoff'}</div>
            </div>

            <label className="mt-4 block text-xs font-medium text-slate-600">Relay IP (optional)</label>
            <input
              type="text"
              value={relayReconnectIp}
              onChange={(event) => setRelayReconnectIp(event.target.value)}
              placeholder="192.168.1.xxx"
              className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none"
              disabled={relayReconnecting}
            />

            {relayReconnectResult && (
              <div className={`mt-3 rounded-xl border px-3 py-2.5 text-xs ${relayReconnectResult.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
                {relayReconnectResult.message}
              </div>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => handleRelayReconnect(selectedRelayForReconnect, relayReconnectIp || undefined)}
                disabled={relayReconnecting || localShutoffSyncing}
                className="w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {relayReconnecting ? 'Configuring…' : 'Reconnect HouseYield + Watchdog'}
              </button>
              <button
                onClick={() => void handleSyncLocalShutoff(selectedRelayForReconnect.propertyId)}
                disabled={relayReconnecting || localShutoffSyncing || !selectedRelayForReconnect.propertyId}
                className="w-full rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                {localShutoffSyncing ? 'Syncing…' : 'Sync Offline LAN Shutoff Only'}
              </button>
              <button
                onClick={() => {
                  setShowRelayReconnectModal(false);
                  setRelayReconnectResult(null);
                  setRelayReconnectIp('');
                  setSelectedRelayForReconnect(null);
                }}
                disabled={relayReconnecting || localShutoffSyncing}
                className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddSensor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Add New Device</h2>
                <p className="mt-0.5 text-sm text-slate-500">Assign the setup flow to a property first.</p>
              </div>
              <button onClick={() => { setShowAddSensor(false); setSelectedPropertyForSetup(''); setSelectedSetupDeviceType(undefined); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">Close</button>
            </div>

            {!selectedPropertyForSetup && properties.length > 0 && (
              <div className="mt-4">
                <label className="block text-xs font-medium text-slate-600">Select Property</label>
                <select
                  value={selectedPropertyForSetup}
                  onChange={(event) => setSelectedPropertyForSetup(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 focus:border-violet-400 focus:outline-none"
                >
                  <option value="">Choose a property...</option>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.address}</option>)}
                </select>
              </div>
            )}

            {(selectedPropertyForSetup || properties.length === 0) && (
              <div className="mt-4 space-y-3">
                {selectedPropertyForSetup && (
                  <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs text-violet-700">
                    Adding to {properties.find((p) => p.id === selectedPropertyForSetup)?.address}
                  </div>
                )}
                <button
                  onClick={() => { setSelectedSetupDeviceType('flood'); setShowAddSensor(false); setShowShellySetup(true); }}
                  className="w-full rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left transition hover:bg-emerald-100"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">💧</span>
                    <div>
                      <div className="text-sm font-semibold text-emerald-800">Add Shelly Flood Sensor</div>
                      <div className="mt-0.5 text-xs text-emerald-700">Connect a Shelly Flood Gen4 for leak monitoring and alert automation.</div>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => { setSelectedSetupDeviceType('ht'); setShowAddSensor(false); setShowShellySetup(true); }}
                  className="w-full rounded-2xl border border-sky-200 bg-sky-50 p-4 text-left transition hover:bg-sky-100"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">🌡️</span>
                    <div>
                      <div className="text-sm font-semibold text-sky-800">Add Shelly BLU H&amp;T Sensor</div>
                      <div className="mt-0.5 text-xs text-sky-700">Pair a Bluetooth temperature &amp; humidity sensor through a BLU Gateway.</div>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => { setSelectedSetupDeviceType('gateway'); setShowAddSensor(false); setShowShellySetup(true); }}
                  className="w-full rounded-2xl border border-indigo-200 bg-indigo-50 p-4 text-left transition hover:bg-indigo-100"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">📡</span>
                    <div>
                      <div className="text-sm font-semibold text-indigo-800">Add Shelly BLU Gateway</div>
                      <div className="mt-0.5 text-xs text-indigo-700">Bridge BLE H&amp;T sensors onto HouseYield-IoT and the cloud backend.</div>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => { setSelectedSetupDeviceType('relay'); setShowAddSensor(false); setShowShellySetup(true); }}
                  className="w-full rounded-2xl border border-blue-200 bg-blue-50 p-4 text-left transition hover:bg-blue-100"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">🚰</span>
                    <div>
                      <div className="text-sm font-semibold text-blue-800">Add Shelly Water Shutoff Relay</div>
                      <div className="mt-0.5 text-xs text-blue-700">Register a Shelly 1 Gen4 relay controller for remote open and close valve commands.</div>
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showShellySetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">Setup Shelly Device</h2>
              <button onClick={() => { setShowShellySetup(false); setSelectedSetupDeviceType(undefined); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">Close</button>
            </div>
            <ShellySetupWizard
              propertyId={selectedPropertyForSetup}
              initialDeviceType={selectedSetupDeviceType}
              onComplete={(device) => {
                setShowShellySetup(false);
                setSelectedPropertyForSetup('');
                setSelectedSetupDeviceType(undefined);
                if (selectedPropertyForSetup && device?.id) {
                  updateDeviceProperty(device.id, selectedPropertyForSetup, ownerId);
                }
              }}
            />
          </div>
        </div>
      )}

      {showNotifyModal && selectedAlertForNotify && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Notify Tenant</h2>
                <p className="mt-0.5 text-sm text-slate-500">Share the current sensor issue and trigger the maintenance workflow.</p>
              </div>
              <button onClick={() => setShowNotifyModal(false)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">Close</button>
            </div>

            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              <div className="font-semibold">{selectedAlertForNotify.message}</div>
              <div className="mt-1 text-[10px]">Sensor {selectedAlertForNotify.deviceId} · {new Date(selectedAlertForNotify.timestamp).toLocaleString()}</div>
            </div>

            <div className="mt-4 space-y-2">
              <input type="text" value={notifyOptions.tenantName} onChange={(e) => setNotifyOptions({ ...notifyOptions, tenantName: e.target.value })} placeholder="Tenant name" className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none" />
              <input type="email" value={notifyOptions.tenantEmail} onChange={(e) => setNotifyOptions({ ...notifyOptions, tenantEmail: e.target.value })} placeholder="Tenant email" className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none" />
              <input type="tel" value={notifyOptions.tenantPhone} onChange={(e) => setNotifyOptions({ ...notifyOptions, tenantPhone: e.target.value })} placeholder="Tenant phone" className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none" />
              <input type="text" value={notifyOptions.propertyAddress} onChange={(e) => setNotifyOptions({ ...notifyOptions, propertyAddress: e.target.value })} placeholder="Property address" className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-400 focus:outline-none" />
            </div>

            <div className="mt-4 space-y-1.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <label className="flex items-center gap-2"><input type="checkbox" checked={notifyOptions.sendEmail} onChange={(e) => setNotifyOptions({ ...notifyOptions, sendEmail: e.target.checked })} /> Email</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={notifyOptions.sendSMS} onChange={(e) => setNotifyOptions({ ...notifyOptions, sendSMS: e.target.checked })} /> SMS</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={notifyOptions.makePhoneCall} onChange={(e) => setNotifyOptions({ ...notifyOptions, makePhoneCall: e.target.checked })} /> AI Phone Call</label>
            </div>

            <div className="mt-4 flex gap-3">
              <button onClick={() => setShowNotifyModal(false)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
              <button
                onClick={() => handleNotifyTenant(selectedAlertForNotify)}
                disabled={notifyingAlertId === selectedAlertForNotify.id || (!notifyOptions.tenantEmail && !notifyOptions.tenantPhone)}
                className="flex-1 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {notifyingAlertId === selectedAlertForNotify.id ? 'Sending...' : 'Send Notifications'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
