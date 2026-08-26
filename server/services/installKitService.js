/**
 * Install kit records — WiFi credentials + bench provisioning state per property.
 * Accessed only via staff-authenticated internal APIs (server Admin SDK).
 */

import { getFirestore } from '../firebase-admin.js';

const COLLECTION = 'install_kits';

function kitRef(propertyId) {
  return getFirestore().collection(COLLECTION).doc(String(propertyId));
}

function normalizeKit(docSnap) {
  if (!docSnap.exists) return null;
  const data = docSnap.data() || {};
  return {
    propertyId: docSnap.id,
    ...data,
    provisionedDevices: Array.isArray(data.provisionedDevices) ? data.provisionedDevices : [],
  };
}

export async function getInstallKit(propertyId) {
  const snap = await kitRef(propertyId).get();
  return normalizeKit(snap);
}

export async function upsertInstallKit(propertyId, payload = {}, staffEmail = '') {
  if (!propertyId) {
    throw new Error('propertyId is required');
  }

  const existing = await getInstallKit(propertyId);
  const now = new Date().toISOString();

  const update = {
    propertyId: String(propertyId),
    ownerId: payload.ownerId || existing?.ownerId || null,
    propertyLabel: payload.propertyLabel || existing?.propertyLabel || null,
    wifiSsid: payload.wifiSsid ?? existing?.wifiSsid ?? '',
    wifiPassword: payload.wifiPassword ?? existing?.wifiPassword ?? '',
    networkType: payload.networkType || existing?.networkType || 'private',
    customerContact: payload.customerContact ?? existing?.customerContact ?? null,
    installNotes: payload.installNotes ?? existing?.installNotes ?? '',
    status: payload.status || existing?.status || 'draft',
    updatedAt: now,
    updatedByStaffEmail: staffEmail || existing?.updatedByStaffEmail || null,
  };

  if (!existing) {
    update.createdAt = now;
    update.createdByStaffEmail = staffEmail || null;
    update.provisionedDevices = [];
  }

  if (payload.provisionedDevices) {
    update.provisionedDevices = payload.provisionedDevices;
  } else if (!existing) {
    update.provisionedDevices = [];
  }

  await kitRef(propertyId).set(update, { merge: true });
  return getInstallKit(propertyId);
}

export async function recordProvisionedDevice(propertyId, device, staffEmail = '') {
  const kit = await getInstallKit(propertyId);
  if (!kit) {
    throw new Error('Install kit not found — save WiFi details first');
  }

  const provisionedDevices = [...(kit.provisionedDevices || [])];
  const entry = {
    deviceId: device.deviceId,
    type: device.type || 'unknown',
    name: device.name || null,
    location: device.location || null,
    model: device.model || null,
    provisionedAt: new Date().toISOString(),
    provisionedBy: staffEmail || null,
  };

  const existingIndex = provisionedDevices.findIndex((row) => row.deviceId === entry.deviceId);
  if (existingIndex >= 0) {
    provisionedDevices[existingIndex] = { ...provisionedDevices[existingIndex], ...entry };
  } else {
    provisionedDevices.push(entry);
  }

  const status = provisionedDevices.length > 0 ? 'partially_provisioned' : kit.status;

  return upsertInstallKit(propertyId, {
    ownerId: kit.ownerId,
    propertyLabel: kit.propertyLabel,
    wifiSsid: kit.wifiSsid,
    wifiPassword: kit.wifiPassword,
    networkType: kit.networkType,
    customerContact: kit.customerContact,
    installNotes: kit.installNotes,
    status,
    provisionedDevices,
  }, staffEmail);
}
