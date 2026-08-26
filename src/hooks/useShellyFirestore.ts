/**
 * useShellyFirestore - Shared real-time Firestore subscriptions for Shelly sensors
 *
 * Uses one set of Firestore listeners for the whole app (not HTTP polling).
 * Device status, alerts, and recent readings update when webhooks write to Firestore.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
import { getIotAuth, getIotFirestore } from '../config/iotFirebase';
import { resolveShellyApiBaseUrl } from '../utils/iotProjectConfig';
import { getShellyFirestoreSnapshot, subscribeShellyFirestore } from './shellyFirestoreShared';

// Types
export interface ShellyDevice {
  id: string;
  deviceId: string;
  name: string;
  location?: string;
  type: string;
  ip?: string;
  mac?: string;
  firmware?: string;
  model?: string;
  status: 'online' | 'offline' | 'unknown';
  batteryPercent?: number;
  batteryLevel?: number;
  wifiRssi?: number;
  rssi?: number;
  temperature?: number;
  temperatureF?: number;
  humidity?: number;
  flood?: boolean;
  isFlooded?: boolean;
  lastSeen: Date | null;
  lastUpdate?: string;
  registeredAt: Date | null;
  webhookUrl?: string;
  propertyId?: string;
  ownerId?: string;
  connectionType?: 'bluetooth' | 'wifi' | 'cloud' | 'bluetooth_gateway';
  connectionPreference?: 'bluetooth_preferred' | 'wifi_preferred' | 'cloud_only';
  bleAddress?: string;
  /** Last reading accepted directly by the public ingestion endpoint. */
  lastCloudIngestAt?: Date | null;
  /** Local fallback receipt; useful for detecting laptop-dependent telemetry. */
  lastLocalIngestAt?: Date | null;
  lastIngestSource?: 'cloud_webhook' | 'ble_gateway' | 'ble_gateway_fallback' | string;
  cloudDeliveryConfirmed?: boolean;
  collectorVersion?: string | null;
  capabilities?: string[];
  relayOutputOn?: boolean;
  valveState?: 'open' | 'closed' | 'unknown';
  lastValveCommand?: 'open' | 'close' | 'pulse' | null;
  lastValveCommandAt?: string | null;
  pulseDurationMs?: number | null;
  valveTravelMs?: number | null;
  actuationMode?: 'maintained' | 'momentary';
  relayCloseOn?: boolean;
  /** Room the owner placed this device in on the cutaway twin. */
  twinRoomId?: string;
  /**
   * Unit the device is in, for multifamily twins. Independent of `twinRoomId`:
   * in a building the unit identifies the space, and which room inside it is a
   * separate and finer question.
   */
  twinUnitId?: string;
}

export interface ShellyAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  type: 'flood' | 'temperature' | 'humidity' | 'motion' | 'battery_low' | 'offline' | 'mold_risk' | 'freeze_risk' | 'pipe_burst' | 'insulation_failure' | 'rapid_temp_change' | 'humidity_damage';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: Date;
  acknowledged: boolean;
  notificationSent?: boolean;
  tenantNotifiedAt?: string | null;
  tenantNotification?: {
    sentAt?: string;
    tenantName?: string;
    tenantEmail?: string | null;
    tenantPhone?: string | null;
    channel?: string;
    skipped?: boolean;
    channels?: {
      email?: { ok: boolean; error?: string } | null;
      sms?: { ok: boolean; error?: string; messageSid?: string } | null;
      phoneCall?: { ok: boolean; error?: string; callSid?: string } | null;
    };
    /** Owner-dispatch path writes `requestId`; older tenant path used `maintenanceRequestId`. */
    requestId?: string | null;
    maintenanceRequestId?: string | null;
  } | null;
  data?: Record<string, unknown>;
  propertyId?: string;
  ownerId?: string;
}

export interface SensorReading {
  id: string;
  deviceId: string;
  temperature?: number;
  humidity?: number;
  flood?: boolean;
  batteryPercent?: number;
  timestamp: Date;
}

export interface ArchivedShellyDevice {
  deviceId: string;
  name: string;
  propertyId?: string;
  ownerId?: string;
  location?: string;
  type?: string;
  deletedAt: Date | null;
}

export interface UseShellyFirestoreResult {
  devices: ShellyDevice[];
  archivedDevices: ArchivedShellyDevice[];
  alerts: ShellyAlert[];
  readings: SensorReading[];
  loading: boolean;
  error: string | null;
  acknowledgeAlert: (alertId: string) => Promise<void>;
  refreshDevices: () => void;
  updateDeviceProperty: (deviceId: string, propertyId: string | null, ownerId: string) => Promise<void>;
  deleteSensor: (deviceDocId: string, deviceId: string) => Promise<void>;
}

export function useShellyFirestore(ownerId?: string): UseShellyFirestoreResult {
  const snapshot = useSyncExternalStore(
    subscribeShellyFirestore,
    getShellyFirestoreSnapshot,
    getShellyFirestoreSnapshot,
  );

  const devices = snapshot.devices;
  const archivedDevices = snapshot.archivedDevices;
  const alerts = snapshot.alerts;
  const readings = snapshot.readings;
  const loading = snapshot.loading;
  const error = snapshot.error;

  const refreshDevices = useCallback(() => {
    // Shared Firestore listeners stay live; no polling refresh needed.
  }, []);

  const acknowledgeAlert = useCallback(async (alertId: string) => {
    try {
      const iotDb = getIotFirestore();
      const alert = alerts.find((candidate) => candidate.id === alertId);
      const relatedFloodAlerts = alert?.type === 'flood' && alert.deviceId
        ? alerts.filter((candidate) => (
          candidate.deviceId === alert.deviceId
          && candidate.type === 'flood'
          && !candidate.acknowledged
        ))
        : alerts.filter((candidate) => candidate.id === alertId && !candidate.acknowledged);

      const idsToAck = relatedFloodAlerts.length > 0
        ? relatedFloodAlerts.map((candidate) => candidate.id)
        : [alertId];

      await Promise.all(
        idsToAck.map((id) => updateDoc(doc(iotDb, 'alerts', id), { acknowledged: true })),
      );

      // Dismissing a flood alert should clear the live hazard animation on the twin.
      if (alert?.type === 'flood' && alert.deviceId) {
        const device = devices.find((candidate) => (
          candidate.deviceId === alert.deviceId || candidate.id === alert.deviceId
        ));
        const deviceDocId = device?.id || alert.deviceId;
        await setDoc(doc(iotDb, 'shelly_devices', deviceDocId), {
          isFlooded: false,
          flood: false,
          hasActiveAlert: false,
          lastAlertClearedAt: new Date().toISOString(),
        }, { merge: true });
      }
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
      throw err;
    }
  }, [alerts, devices]);

  const updateDeviceProperty = useCallback(async (deviceId: string, propertyId: string | null, deviceOwnerId: string) => {
    const payload = {
      deviceId,
      propertyId: propertyId ?? null,
      ownerId: deviceOwnerId,
      updatedAt: new Date().toISOString(),
    };

    try {
      const deviceRef = doc(getIotFirestore(), 'shelly_devices', deviceId);
      await setDoc(deviceRef, payload, { merge: true });
      refreshDevices();
    } catch (err) {
      console.error('Failed to update device property:', err);
      throw err;
    }
  }, [refreshDevices]);

  const deleteSensor = useCallback(async (deviceDocId: string, deviceId: string) => {
    const iotAuth = getIotAuth();
    const currentUser = iotAuth.currentUser;
    if (!currentUser) {
      throw new Error('You must be signed in to delete this sensor');
    }

    const payload = {
      deviceDocId,
      deviceId,
      ownerId: ownerId || currentUser.uid,
    };

    const resolveDeleteApiUrl = (method: 'DELETE' | 'POST') => {
      const onLocalDev = typeof window !== 'undefined'
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
      const apiBase = onLocalDev ? '' : resolveShellyApiBaseUrl();
      const encodedId = encodeURIComponent(deviceId);
      if (method === 'POST') {
        return apiBase
          ? `${apiBase}/api/shelly/devices/${encodedId}/delete`
          : `/api/shelly/devices/${encodedId}/delete`;
      }
      return apiBase
        ? `${apiBase}/api/shelly/devices/${encodedId}`
        : `/api/shelly/devices/${encodedId}`;
    };

    const tryApiDelete = async () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await currentUser.getIdToken()}`,
      };

      const attempts: Array<{ method: 'POST' | 'DELETE'; url: string }> = [
        { method: 'POST', url: resolveDeleteApiUrl('POST') },
        { method: 'DELETE', url: resolveDeleteApiUrl('DELETE') },
      ];

      let lastError: Error | null = null;
      for (const attempt of attempts) {
        try {
          const response = await fetch(attempt.url, {
            method: attempt.method,
            headers,
            body: JSON.stringify(payload),
          });

          const result = await response.json().catch(() => null);
          if (response.ok && result?.success) {
            return;
          }

          lastError = new Error(result?.error || result?.message || `Failed to delete the sensor (${response.status})`);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('Failed to delete the sensor');
        }
      }

      throw lastError || new Error('Failed to delete the sensor');
    };

    const tryFirestoreDelete = async () => {
      const onLocalDev = typeof window !== 'undefined'
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
      if (!onLocalDev) {
        throw new Error('Sensor delete is unavailable. Please try again in a moment.');
      }

      const iotDb = getIotFirestore();
      if (!iotAuth.currentUser) {
        throw new Error('You must be signed in to delete this sensor');
      }

      await setDoc(doc(iotDb, 'shelly_deleted_devices', deviceId), {
        deviceId,
        deletedAt: new Date().toISOString(),
        deletedBy: currentUser.uid,
        source: 'dashboard_client',
      }, { merge: true });

      await deleteDoc(doc(iotDb, 'shelly_devices', deviceDocId || deviceId));
    };

    try {
      await tryApiDelete();
      refreshDevices();
      return;
    } catch (apiError) {
      console.warn('API delete failed, trying direct Firestore delete:', apiError);
    }

    try {
      await tryFirestoreDelete();
      refreshDevices();
    } catch (err) {
      console.error('Failed to delete sensor:', err);
      throw err;
    }
  }, [ownerId, refreshDevices]);

  return {
    devices,
    archivedDevices,
    alerts,
    readings,
    loading,
    error,
    acknowledgeAlert,
    refreshDevices,
    updateDeviceProperty,
    deleteSensor,
  };
}

export default useShellyFirestore;
