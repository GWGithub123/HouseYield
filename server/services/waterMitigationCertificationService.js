import { createHash, randomUUID } from 'node:crypto';
import { getFirestore } from '../firebase-admin.js';

const db = getFirestore();
const CERTIFICATION_COLLECTION = 'water_mitigation_certifications';
const STATE_COLLECTION = 'water_mitigation_recertification_state';
const HEALTH_COLLECTION = 'water_mitigation_health_checks';
const CERTIFICATION_VALID_DAYS = 365;
const EXPIRING_SOON_DAYS = 60;

export const WATER_MITIGATION_TEST_PROTOCOL_VERSION = 'HY-WM-ANNUAL-1.0';

export const WATER_MITIGATION_TEST_STEPS = [
  {
    id: 'inventory_verified',
    label: 'Inventory and installed locations verified',
    description: 'Confirm model, identifier, firmware, placement, valve location, and component count.',
    required: true,
  },
  {
    id: 'visual_inspection',
    label: 'Visual installation inspection passed',
    description: 'Check mounting, wiring, power, corrosion, damage, bypasses, and valve alignment.',
    required: true,
  },
  {
    id: 'leak_sensor_wet_test',
    label: 'Every leak sensor passed a controlled wet test',
    description: 'Test each enrolled point sensor and confirm it returns to a dry state.',
    required: true,
  },
  {
    id: 'automatic_shutoff_test',
    label: 'Leak event automatically triggered shutoff',
    description: 'Verify the valve closes from the configured leak automation without manual approval.',
    required: true,
  },
  {
    id: 'relay_acknowledged',
    label: 'Relay command and output were acknowledged',
    description: 'Preserve command route, RPC response, and post-command output status where available.',
    required: true,
  },
  {
    id: 'water_flow_stopped',
    label: 'Water flow stopped at a fixture',
    description: 'Open a fixture after closure and confirm that water flow actually stops.',
    required: true,
  },
  {
    id: 'alert_delivery_test',
    label: 'Owner or manager alert delivery verified',
    description: 'Confirm the configured notification path and record delivery evidence.',
    required: true,
  },
  {
    id: 'environmental_thresholds',
    label: 'Freeze and environmental thresholds verified',
    description: 'Confirm enrolled temperature/humidity devices, thresholds, and recipients.',
    required: true,
  },
  {
    id: 'offline_local_operation',
    label: 'Local/offline protection verified',
    description: 'Verify the documented local behavior without WAN connectivity, or explain why not applicable.',
    required: true,
    allowNotApplicable: true,
  },
  {
    id: 'backup_power_test',
    label: 'Backup-power behavior verified',
    description: 'Test installed backup power, or record that no backup system is installed.',
    required: true,
    allowNotApplicable: true,
  },
  {
    id: 'manual_override',
    label: 'Manual override and recovery verified',
    description: 'Confirm a person can safely operate or recover the valve if automation is unavailable.',
    required: true,
  },
  {
    id: 'water_service_restored',
    label: 'Water service restored after testing',
    description: 'Reopen the valve, verify normal flow, and clear residual test alerts.',
    required: true,
  },
  {
    id: 'deficiencies_resolved',
    label: 'Deficiencies resolved or none observed',
    description: 'Document repairs and retests for all failed steps before certification.',
    required: true,
  },
];

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function addDays(value, days) {
  const parsed = new Date(value);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString();
}

function certificationRef(certificationId) {
  return db.collection(CERTIFICATION_COLLECTION).doc(String(certificationId));
}

function stateRef(ownerId, propertyId) {
  return db.collection(STATE_COLLECTION).doc(`${ownerId}__${propertyId}`);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((output, key) => {
      if (value[key] !== undefined) output[key] = stableObject(value[key]);
      return output;
    }, {});
  }
  return value;
}

export function buildInventoryFingerprint(devices = []) {
  const normalized = devices.map((device) => ({
    deviceId: device.deviceId || device.id || '',
    type: device.type || '',
    manufacturer: device.manufacturer || '',
    model: device.model || '',
    firmware: device.firmware || '',
    location: device.location || '',
    mac: device.mac || '',
  })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return createHash('sha256').update(JSON.stringify(stableObject(normalized))).digest('hex');
}

function defaultStepRecord(step) {
  return {
    id: step.id,
    label: step.label,
    description: step.description,
    required: step.required,
    allowNotApplicable: step.allowNotApplicable === true,
    result: 'pending',
    testedAt: null,
    testedBy: '',
    notes: '',
    evidenceUrls: [],
    sourceEventIds: [],
    measurements: {},
  };
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

function normalizeStepUpdate(step, update = {}) {
  const allowedResults = new Set(['pending', 'passed', 'failed', 'not_applicable']);
  const result = allowedResults.has(update.result) ? update.result : step.result;
  if (result === 'not_applicable' && !step.allowNotApplicable) {
    throw new Error(`${step.label} cannot be marked not applicable`);
  }
  if (result === 'not_applicable' && !String(update.notes || step.notes || '').trim()) {
    throw new Error(`${step.label} requires an explanation when marked not applicable`);
  }
  return {
    ...step,
    result,
    testedAt: result === 'pending' ? null : normalizeDate(update.testedAt) || new Date().toISOString(),
    testedBy: String(update.testedBy ?? step.testedBy ?? '').trim(),
    notes: String(update.notes ?? step.notes ?? '').trim(),
    evidenceUrls: update.evidenceUrls === undefined ? step.evidenceUrls : normalizeStringArray(update.evidenceUrls),
    sourceEventIds: update.sourceEventIds === undefined ? step.sourceEventIds : normalizeStringArray(update.sourceEventIds),
    measurements: update.measurements && typeof update.measurements === 'object'
      ? stableObject(update.measurements)
      : step.measurements || {},
  };
}

export function evaluateTestSteps(steps = []) {
  const required = steps.filter((step) => step.required);
  const failed = required.filter((step) => step.result === 'failed');
  const incomplete = required.filter((step) => !['passed', 'not_applicable'].includes(step.result));
  return {
    readyForSignature: failed.length === 0 && incomplete.length === 0 && required.length > 0,
    failedStepIds: failed.map((step) => step.id),
    incompleteStepIds: incomplete.map((step) => step.id),
    completionPercent: required.length
      ? Math.round(((required.length - incomplete.length) / required.length) * 100)
      : 0,
  };
}

export async function createWaterMitigationCertification({
  ownerId,
  propertyId,
  type = 'annual_full',
  reason = 'annual_due',
  technician = {},
  propertyAddress = '',
  devices = [],
  monitoringEvidence = null,
}) {
  if (!ownerId || !propertyId) throw new Error('ownerId and propertyId are required');
  const now = new Date().toISOString();
  const certificationId = `wmc_${randomUUID()}`;
  const record = {
    id: certificationId,
    ownerId,
    propertyId,
    propertyAddress,
    type,
    reason,
    status: 'in_progress',
    protocolVersion: WATER_MITIGATION_TEST_PROTOCOL_VERSION,
    validForDays: CERTIFICATION_VALID_DAYS,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    certifiedAt: null,
    expiresAt: null,
    nextDueAt: null,
    technician: {
      name: String(technician.name || '').trim(),
      company: String(technician.company || '').trim(),
      email: String(technician.email || '').trim(),
      phone: String(technician.phone || '').trim(),
      licenseNumber: String(technician.licenseNumber || '').trim(),
    },
    inventorySnapshot: devices.map((device) => stableObject({
      deviceId: device.deviceId || device.id,
      type: device.type,
      manufacturer: device.manufacturer,
      model: device.model,
      firmware: device.firmware,
      location: device.location,
      mac: device.mac,
      protectionRole: device.protectionRole,
      statusAtTestStart: device.status,
      lastSeenAtTestStart: device.lastSeen,
    })),
    inventoryFingerprint: buildInventoryFingerprint(devices),
    monitoringSnapshot: monitoringEvidence ? stableObject(monitoringEvidence) : null,
    steps: WATER_MITIGATION_TEST_STEPS.map(defaultStepRecord),
    testSummary: evaluateTestSteps(WATER_MITIGATION_TEST_STEPS.map(defaultStepRecord)),
    deficiencies: [],
    correctiveActions: [],
    generalNotes: '',
    attestationDocumentId: null,
    attestationSigningUrl: null,
    signatureStatus: 'not_requested',
    signerAssurance: 'email_link',
    sealedDocumentHash: null,
    documentIntegrityStatus: null,
  };
  await certificationRef(certificationId).set(record);
  return record;
}

export async function getWaterMitigationCertification(certificationId) {
  const snapshot = await certificationRef(certificationId).get();
  return snapshot.exists ? snapshot.data() : null;
}

export async function listWaterMitigationCertifications(ownerId, propertyId, limit = 20) {
  const snapshot = await db.collection(CERTIFICATION_COLLECTION)
    .where('propertyId', '==', propertyId)
    .get();
  return snapshot.docs
    .map((doc) => doc.data())
    .filter((record) => record.ownerId === ownerId)
    .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime())
    .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100));
}

export async function updateWaterMitigationCertification({
  ownerId,
  propertyId,
  certificationId,
  payload = {},
}) {
  const current = await getWaterMitigationCertification(certificationId);
  if (!current || current.ownerId !== ownerId || current.propertyId !== propertyId) {
    throw new Error('Certification not found');
  }
  if (['certified', 'expired', 'superseded'].includes(current.status)) {
    throw new Error('A finalized certification cannot be edited');
  }
  const stepUpdates = new Map(
    (Array.isArray(payload.steps) ? payload.steps : []).map((step) => [String(step.id), step]),
  );
  const steps = current.steps.map((step) =>
    stepUpdates.has(step.id) ? normalizeStepUpdate(step, stepUpdates.get(step.id)) : step,
  );
  const testSummary = evaluateTestSteps(steps);
  const status = testSummary.failedStepIds.length > 0
    ? 'failed'
    : current.status === 'failed'
      ? 'in_progress'
      : current.status;
  const next = {
    ...current,
    status,
    steps,
    testSummary,
    technician: payload.technician
      ? {
          ...current.technician,
          name: String(payload.technician.name ?? current.technician.name ?? '').trim(),
          company: String(payload.technician.company ?? current.technician.company ?? '').trim(),
          email: String(payload.technician.email ?? current.technician.email ?? '').trim(),
          phone: String(payload.technician.phone ?? current.technician.phone ?? '').trim(),
          licenseNumber: String(payload.technician.licenseNumber ?? current.technician.licenseNumber ?? '').trim(),
        }
      : current.technician,
    deficiencies: payload.deficiencies === undefined ? current.deficiencies : normalizeStringArray(payload.deficiencies),
    correctiveActions: payload.correctiveActions === undefined ? current.correctiveActions : normalizeStringArray(payload.correctiveActions),
    generalNotes: payload.generalNotes === undefined ? current.generalNotes : String(payload.generalNotes || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  await certificationRef(certificationId).set(next);
  return next;
}

function buildAttestationContent(certification) {
  const stepLines = certification.steps.map((step) =>
    `${step.label}: ${step.result.toUpperCase()}${step.testedAt ? ` | ${step.testedAt}` : ''}${step.notes ? ` | ${step.notes}` : ''}`,
  ).join('\n');
  const inventoryLines = certification.inventorySnapshot.map((device) =>
    `${device.manufacturer || ''} ${device.model || device.deviceId} | ${device.type || ''} | ${device.location || ''} | ${device.deviceId || ''} | firmware ${device.firmware || 'not recorded'}`,
  ).join('\n');
  return `HOUSEYIELD WATER-LOSS PROTECTION SYSTEM RECERTIFICATION

Protocol: ${certification.protocolVersion}
Certification ID: ${certification.id}
Property: ${certification.propertyAddress}
Inspection type: ${certification.type}
Inspection reason: ${certification.reason}
Started: ${certification.startedAt}

TEST RESULTS
${stepLines}

DEVICE INVENTORY AT INSPECTION
${inventoryLines || 'No devices recorded'}

DEFICIENCIES
${certification.deficiencies.length ? certification.deficiencies.join('\n') : 'None recorded'}

CORRECTIVE ACTIONS
${certification.correctiveActions.length ? certification.correctiveActions.join('\n') : 'None recorded'}

TECHNICIAN ATTESTATION
I attest that I personally performed or supervised the recorded inspection and functional tests, that the listed results are accurate to the best of my knowledge, that water service was restored after testing, and that all deficiencies preventing certification have been resolved. I understand that this HouseYield record does not guarantee insurance eligibility, loss prevention, code compliance, or uninterrupted service.`;
}

export async function createCertificationSignatureRequest({
  ownerId,
  propertyId,
  certificationId,
}) {
  const certification = await getWaterMitigationCertification(certificationId);
  if (!certification || certification.ownerId !== ownerId || certification.propertyId !== propertyId) {
    throw new Error('Certification not found');
  }
  const testSummary = evaluateTestSteps(certification.steps);
  if (!testSummary.readyForSignature) {
    throw new Error(`Complete all required test steps before signing: ${testSummary.incompleteStepIds.join(', ') || testSummary.failedStepIds.join(', ')}`);
  }
  if (!certification.technician?.name || !certification.technician?.email) {
    throw new Error('Technician name and email are required');
  }

  const documentService = await import('../document-service.js');
  const document = await documentService.createDocument({
    ownerId,
    propertyId,
    documentType: 'water_mitigation_annual_recertification',
    title: `Annual Water-Loss Protection Recertification - ${certification.propertyAddress}`,
    content: buildAttestationContent(certification),
    metadata: {
      insurancePacket: true,
      waterMitigationCertificationId: certification.id,
      protocolVersion: certification.protocolVersion,
      inventoryFingerprint: certification.inventoryFingerprint,
    },
  });
  const signatureResult = await documentService.createSignatureRequest({
    documentId: document.id,
    signers: [{
      id: `technician-${certification.technician.email.toLowerCase()}`,
      email: certification.technician.email,
      name: certification.technician.name,
      role: 'technician',
    }],
  });
  if (!signatureResult.success) {
    throw new Error(signatureResult.error || 'Failed to create signature request');
  }
  const signingUrl = signatureResult.signingLinks?.[0]?.signingUrl || '';
  const update = {
    status: 'pending_signature',
    signatureStatus: 'pending_signature',
    attestationDocumentId: document.id,
    attestationSigningUrl: signingUrl,
    testSummary,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await certificationRef(certification.id).set(update, { merge: true });
  return { ...certification, ...update };
}

async function syncCertificationSignature(certification) {
  if (!certification?.attestationDocumentId || certification.status === 'certified') return certification;
  try {
    const documentService = await import('../document-service.js');
    const result = await documentService.getDocumentById(certification.attestationDocumentId);
    const document = result?.document;
    if (!result?.success || !document || document.ownerId !== certification.ownerId || document.propertyId !== certification.propertyId) {
      return certification;
    }
    if (document.status !== 'completed') {
      const signatureStatus = document.status === 'partially_signed' ? 'partially_signed' : 'pending_signature';
      if (signatureStatus !== certification.signatureStatus) {
        await certificationRef(certification.id).set({ signatureStatus, updatedAt: new Date().toISOString() }, { merge: true });
      }
      return { ...certification, signatureStatus };
    }
    const integrity = documentService.evaluateDocumentIntegrity(document);
    if (integrity.status !== 'INTEGRITY_VERIFIED') {
      const failed = {
        status: 'integrity_failed',
        signatureStatus: 'completed',
        documentIntegrityStatus: integrity.status,
        updatedAt: new Date().toISOString(),
      };
      await certificationRef(certification.id).set(failed, { merge: true });
      return { ...certification, ...failed };
    }
    const certifiedAt = normalizeDate(document.completedAt) || new Date().toISOString();
    const finalized = {
      status: 'certified',
      signatureStatus: 'completed',
      certifiedAt,
      expiresAt: addDays(certifiedAt, CERTIFICATION_VALID_DAYS),
      nextDueAt: addDays(certifiedAt, CERTIFICATION_VALID_DAYS),
      sealedDocumentHash: document.sealedDocumentHash || integrity.sealedHash,
      documentIntegrityStatus: integrity.status,
      signerAssurance: 'email_link_with_esign_consent',
      updatedAt: new Date().toISOString(),
    };
    await certificationRef(certification.id).set(finalized, { merge: true });
    await stateRef(certification.ownerId, certification.propertyId).set({
      ownerId: certification.ownerId,
      propertyId: certification.propertyId,
      latestCertificationId: certification.id,
      recertificationRequired: false,
      requiredReason: null,
      requiredAt: null,
      clearedAt: certifiedAt,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    try {
      const { createAssistantScheduledTask } = await import('./assistantScheduledTaskService.js');
      const reminder = await createAssistantScheduledTask({
        userId: certification.ownerId,
        title: 'Water-loss protection recertification due soon',
        notes: `The signed ${certification.protocolVersion} certification for ${certification.propertyAddress || 'this property'} expires in 30 days. Schedule the controlled wet test, shutoff test, stopped-flow verification, service restoration, and technician signature.`,
        runAt: addDays(certifiedAt, CERTIFICATION_VALID_DAYS - 30),
        actionId: 'annual-water-recertification',
        propertyId: certification.propertyId,
        propertyAddress: certification.propertyAddress,
        kind: 'action',
        parameters: {
          propertyId: certification.propertyId,
          propertyAddress: certification.propertyAddress,
          certificationId: certification.id,
          protocolVersion: certification.protocolVersion,
        },
      });
      if (reminder?.task?.id) {
        finalized.renewalReminderTaskId = reminder.task.id;
        finalized.renewalReminderAt = reminder.task.runAt;
        await certificationRef(certification.id).set({
          renewalReminderTaskId: reminder.task.id,
          renewalReminderAt: reminder.task.runAt,
        }, { merge: true });
      }
    } catch (error) {
      console.warn('[Certification] Could not schedule annual reminder:', error.message);
    }
    return { ...certification, ...finalized };
  } catch (error) {
    console.warn('[Certification] Could not synchronize signature:', error.message);
    return certification;
  }
}

export async function synchronizeWaterMitigationCertification(certificationId) {
  const certification = await getWaterMitigationCertification(certificationId);
  return certification ? syncCertificationSignature(certification) : null;
}

export async function getWaterMitigationCertificationSummary({
  ownerId,
  propertyId,
  currentDevices = [],
}) {
  const [records, stateSnapshot, healthSnapshot] = await Promise.all([
    listWaterMitigationCertifications(ownerId, propertyId, 20),
    stateRef(ownerId, propertyId).get(),
    db.collection(HEALTH_COLLECTION)
      .where('propertyId', '==', propertyId)
      .get(),
  ]);
  const synchronized = [];
  for (const record of records) synchronized.push(await syncCertificationSignature(record));
  const state = stateSnapshot.exists ? stateSnapshot.data() : {};
  const latest = synchronized[0] || null;
  const latestCertified = synchronized.find((record) => record.status === 'certified') || null;
  const currentFingerprint = buildInventoryFingerprint(currentDevices);
  const inventoryChanged = Boolean(
    latestCertified?.inventoryFingerprint &&
    currentFingerprint &&
    latestCertified.inventoryFingerprint !== currentFingerprint,
  );
  const now = Date.now();
  const expiresAt = latestCertified?.expiresAt ? new Date(latestCertified.expiresAt).getTime() : null;
  const expiringSoonAt = expiresAt ? expiresAt - EXPIRING_SOON_DAYS * 86400000 : null;
  const requiredAtMs = state.requiredAt ? new Date(state.requiredAt).getTime() : 0;
  const certifiedAtMs = latestCertified?.certifiedAt ? new Date(latestCertified.certifiedAt).getTime() : 0;
  const stateRequiresRetest = state.recertificationRequired === true && requiredAtMs > certifiedAtMs;
  const currentSignedCertification =
    Boolean(latestCertified && expiresAt && expiresAt > now) &&
    !stateRequiresRetest &&
    !inventoryChanged;
  let status = 'not_certified';
  if (latest?.status === 'failed' || latest?.status === 'integrity_failed') status = 'failed';
  else if (stateRequiresRetest || inventoryChanged) status = 'retest_required';
  else if (latestCertified && expiresAt && expiresAt <= now) status = 'expired';
  else if (latestCertified && expiringSoonAt && expiringSoonAt <= now) status = 'expiring_soon';
  else if (latestCertified) status = 'certified';
  else if (latest?.status === 'in_progress') status = 'in_progress';
  else if (latest?.status === 'pending_signature') status = 'pending_signature';

  return {
    status,
    packetEligible: currentSignedCertification && !['failed', 'integrity_failed'].includes(latest?.status),
    latest,
    latestCertified,
    records: synchronized,
    currentInventoryFingerprint: currentFingerprint,
    inventoryChanged,
    recertificationRequired: stateRequiresRetest || inventoryChanged,
    requiredReason: inventoryChanged ? 'device_inventory_changed' : state.requiredReason || null,
    requiredAt: state.requiredAt || null,
    expiresAt: latestCertified?.expiresAt || null,
    nextDueAt: latestCertified?.nextDueAt || null,
    daysUntilDue: expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null,
    protocolVersion: WATER_MITIGATION_TEST_PROTOCOL_VERSION,
    validForDays: CERTIFICATION_VALID_DAYS,
    latestAutomatedHealthCheck: healthSnapshot.docs
      .map((doc) => doc.data())
      .filter((record) => record.ownerId === ownerId)
      .sort((a, b) => new Date(b.checkedAt || 0).getTime() - new Date(a.checkedAt || 0).getTime())[0] || null,
  };
}

export async function markWaterMitigationRecertificationRequired({
  ownerId,
  propertyId,
  reason,
  sourceId = null,
  details = null,
}) {
  if (!ownerId || !propertyId) return null;
  const now = new Date().toISOString();
  const record = {
    ownerId,
    propertyId,
    recertificationRequired: true,
    requiredReason: String(reason || 'material_change'),
    requiredAt: now,
    sourceId,
    details: details && typeof details === 'object' ? stableObject(details) : null,
    updatedAt: now,
  };
  await stateRef(ownerId, propertyId).set(record, { merge: true });
  return record;
}

function deviceObservedAt(device = {}) {
  return device.lastSeen?.toDate?.()?.toISOString?.()
    || normalizeDate(device.lastSeen)
    || normalizeDate(device.updatedAt)
    || null;
}

function isAlwaysOnDevice(device = {}) {
  const id = String(device.deviceId || device.id || '').toLowerCase();
  const type = String(device.type || device.deviceType || '').toLowerCase();
  return type === 'relay_controller'
    || type === 'ble_gateway'
    || id.includes('blugw')
    || id.includes('1g4')
    || (Array.isArray(device.capabilities) && device.capabilities.includes('water_shutoff'));
}

export async function recordAutomatedWaterMitigationHealthChecks(devices = []) {
  const grouped = new Map();
  for (const device of devices) {
    const propertyId = String(device.propertyId || '').trim();
    if (!propertyId) continue;
    if (!grouped.has(propertyId)) grouped.set(propertyId, []);
    grouped.get(propertyId).push(device);
  }
  const results = [];
  const now = new Date();
  const checkedAt = now.toISOString();
  const dayKey = checkedAt.slice(0, 10);
  for (const [propertyId, propertyDevices] of grouped) {
    let ownerId = propertyDevices.find((device) => device.ownerId || device.userId)?.ownerId
      || propertyDevices.find((device) => device.ownerId || device.userId)?.userId
      || null;
    if (!ownerId) {
      const propertySnapshot = await db.collection('properties').doc(propertyId).get().catch(() => null);
      const property = propertySnapshot?.exists ? propertySnapshot.data() : null;
      ownerId = property?.ownerId || property?.userId || property?.landlordId || null;
    }
    if (!ownerId) continue;
    const evidence = propertyDevices.map((device) => {
      const observedAt = deviceObservedAt(device);
      const ageMs = observedAt ? now.getTime() - new Date(observedAt).getTime() : Number.POSITIVE_INFINITY;
      const alwaysOn = isAlwaysOnDevice(device);
      const healthy = alwaysOn ? ageMs <= 60 * 60 * 1000 : ageMs <= 24 * 60 * 60 * 1000;
      return {
        deviceId: device.deviceId || device.id || '',
        type: device.type || device.deviceType || '',
        alwaysOn,
        healthy,
        observedAt,
        batteryPercent: device.batteryPercent ?? null,
        valveState: device.valveState || null,
      };
    });
    const unhealthy = evidence.filter((device) => !device.healthy);
    const lowBattery = evidence.filter((device) =>
      device.batteryPercent != null && Number(device.batteryPercent) < 20,
    );
    const relayControllers = evidence.filter((device) => device.alwaysOn && (
      device.type === 'relay_controller' || String(device.deviceId).toLowerCase().includes('1g4')
    ));
    const record = {
      id: `${ownerId}__${propertyId}__${dayKey}`,
      ownerId,
      propertyId,
      checkedAt,
      checkType: 'automated_non_disruptive',
      status: unhealthy.length || lowBattery.length || relayControllers.length === 0 ? 'warning' : 'healthy',
      deviceCount: evidence.length,
      healthyDeviceCount: evidence.length - unhealthy.length,
      unhealthyDeviceIds: unhealthy.map((device) => device.deviceId),
      lowBatteryDeviceIds: lowBattery.map((device) => device.deviceId),
      relayControllerCount: relayControllers.length,
      evidence,
      limitation: 'This automated check verifies recent telemetry and reported state only. It does not replace the annual controlled wet test and physical stopped-flow verification.',
    };
    await db.collection(HEALTH_COLLECTION).doc(record.id).set(record);
    results.push(record);
  }
  return results;
}
