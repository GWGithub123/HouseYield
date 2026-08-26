import { createHash, randomBytes } from 'node:crypto';
import { getFirestore, getStorage, initializeFirebaseAdmin } from '../firebase-admin.js';
import { getIotFirestore } from '../iot-cloud-firestore.js';
import { getWaterMitigationCertificationSummary } from './waterMitigationCertificationService.js';
import { getInstallKit } from './installKitService.js';
import { buildCoverageSummary, deriveWetLocations } from './wetLocationDerivation.js';

initializeFirebaseAdmin();
const db = getFirestore();
const iotDb = getIotFirestore();

const COLLECTIONS = {
  users: 'users',
  properties: 'properties',
  shellyDevices: 'shelly_devices',
  alerts: 'alerts',
  maintenanceRequests: 'maintenanceRequests',
  waterMitigationCommissioning: 'water_mitigation_commissioning',
  insurancePacketIssuances: 'insurance_packet_issuances',
};

const DEFAULT_VALVE_HARDWARE = '';
const MONITORING_LOOKBACK_DAYS = 30;
const MAX_MONITORING_READINGS = 25000;

function safeString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeIsoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value?.toDate === 'function') {
    const parsed = value.toDate();
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value?.seconds === 'number') {
    const parsed = new Date(value.seconds * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function normalizeBoolean(value) {
  return value === true;
}

function mergeBoolean(payload, baseRecord, field) {
  return Object.prototype.hasOwnProperty.call(payload, field)
    ? normalizeBoolean(payload[field])
    : normalizeBoolean(baseRecord[field]);
}

function mergeNumber(payload, baseRecord, field) {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return safeNumber(baseRecord[field]);
  return safeNumber(payload[field]);
}

function getNestedValue(source, path) {
  if (!source || !path) return undefined;
  return String(path)
    .split('.')
    .reduce((current, segment) => (current && typeof current === 'object' ? current[segment] : undefined), source);
}

function buildVerificationCode(propertyId) {
  const digest = createHash('sha1').update(propertyId).digest('hex').slice(0, 10).toUpperCase();
  return `HY-${digest}`;
}

function deriveUserPhone(userData = {}) {
  return (
    safeString(userData.phone) ||
    safeString(userData.ownerProfile?.phone) ||
    safeString(userData.ownerProfile?.contactPhone) ||
    ''
  );
}

function normalizeDeviceType(rawType) {
  const type = safeString(rawType).toLowerCase();
  if (type === 'flood' || type === 'water_leak') return 'water_leak';
  if (type === 'ht' || type === 'temperature_humidity') return 'temperature_humidity';
  if (type === 'temperature') return 'temperature';
  if (type === 'humidity') return 'humidity';
  if (type === 'gateway' || type === 'ble_gateway') return 'gateway';
  if (type === 'relay' || type === 'relay_controller') return 'automatic_shutoff_controller';
  return type || 'sensor';
}

function inferDeviceType(data = {}, docId = '') {
  const id = safeString(data.deviceId, docId).toLowerCase();
  const declared = normalizeDeviceType(data.type || data.deviceType);
  if (id.includes('flood')) return 'water_leak';
  if (id.includes('1g4') || data.capabilities?.includes?.('water_shutoff')) return 'automatic_shutoff_controller';
  if (id.includes('blugw') || id.includes('sngw')) return 'gateway';
  if (id.startsWith('blu-ht-') || id.includes('shellyht')) return 'temperature_humidity';
  return declared;
}

function canonicalDeviceKey(data = {}, docId = '') {
  const id = safeString(data.deviceId, docId).replace(/:/g, '').toLowerCase();
  if (id.startsWith('blu-ht-')) return `ht-${id.slice('blu-ht-'.length)}`;
  if (id.startsWith('shellyhtg3-')) return `ht-${id.slice('shellyhtg3-'.length)}`;
  return id;
}

function normalizeOccupancyType(rawValue) {
  const value = safeString(rawValue).toUpperCase();
  if (!value) return null;
  if (value.includes('OWNER')) return 'Owner-occupied';
  if (value.includes('ABSENTEE') || value.includes('TENANT') || value.includes('RENT')) return 'Non-owner occupied';
  if (value.includes('VACANT')) return 'Vacant';
  return rawValue;
}

function extractPermitDate(permit) {
  return (
    normalizeIsoDate(permit?.issuedate) ||
    normalizeIsoDate(permit?.issueDate) ||
    normalizeIsoDate(permit?.permitDate) ||
    normalizeIsoDate(permit?.date) ||
    null
  );
}

function looksLikePlumbingPermit(permit) {
  const haystack = [
    permit?.type,
    permit?.category,
    permit?.description,
    permit?.permitType,
    permit?.workclass,
    permit?.workClass,
  ]
    .map((value) => safeString(value).toLowerCase())
    .join(' ');
  return /plumb|pipe|water|supply|sewer|service line/.test(haystack);
}

function buildPropertyFacts(property) {
  const propertyData = property?.propertyData || {};
  const summary = propertyData.summary || {};
  const building = propertyData.building || {};
  const rooms = building.rooms || {};
  const size = building.size || {};
  const construction = building.construction || {};
  const permitsRaw =
    propertyData.building_permits ||
    propertyData.buildingPermits ||
    propertyData.permits ||
    [];
  const permits = Array.isArray(permitsRaw) ? permitsRaw : [];
  const plumbingPermits = permits.filter(looksLikePlumbingPermit);
  const plumbingPermitDates = plumbingPermits.map(extractPermitDate).filter(Boolean).sort();

  return {
    attomId:
      safeString(summary.attom_id) ||
      safeString(getNestedValue(propertyData, 'identifier.attomId')) ||
      null,
    yearBuilt:
      safeNumber(summary.year_built) ??
      safeNumber(summary.yearBuilt) ??
      safeNumber(building.yearBuilt),
    propertyType:
      safeString(summary.propsubtype) ||
      safeString(summary.propclass) ||
      safeString(summary.proptype) ||
      safeString(building.summary?.bldgType) ||
      null,
    occupancyType: normalizeOccupancyType(summary.absenteeInd || summary.absenteeOwnerStatus || summary.occupancyType),
    livingAreaSqFt:
      safeNumber(size.livingsize) ??
      safeNumber(size.livingSize) ??
      safeNumber(size.universalsize) ??
      safeNumber(size.universalSize),
    lotAreaSqFt:
      safeNumber(summary.lotsize1) ??
      safeNumber(summary.lotSizeSqFt) ??
      safeNumber(summary.lot_size_sqft),
    bedrooms: safeNumber(rooms.beds),
    bathrooms:
      safeNumber(rooms.bathstotal) ??
      safeNumber(rooms.bathsTotal) ??
      safeNumber(rooms.bathsfull) ??
      safeNumber(rooms.bathsFull),
    stories:
      safeNumber(building.summary?.levels) ??
      safeNumber(building.summary?.stories) ??
      safeNumber(summary.levels),
    foundationType: safeString(building.interior?.bsmttype) || safeString(building.interior?.foundationType) || null,
    constructionType: safeString(construction.wallType) || safeString(construction.frameType) || null,
    plumbingPermitCount: plumbingPermits.length,
    mostRecentPlumbingPermitDate: plumbingPermitDates[plumbingPermitDates.length - 1] || null,
  };
}

function buildLastSeenStatus(deviceData, normalizedType) {
  const lastSeenIso = normalizeIsoDate(deviceData.lastSeen);
  const explicitStatus = safeString(deviceData.status, 'unknown');
  const thresholdMs =
    normalizedType === 'water_leak'
      ? 45 * 60 * 1000
      : normalizedType === 'temperature_humidity'
        ? 2 * 60 * 60 * 1000
        : 5 * 60 * 1000;
  if (!lastSeenIso) {
    return {
      status: explicitStatus === 'active' ? 'online' : explicitStatus,
      lastSeen: null,
      online: explicitStatus === 'online' || explicitStatus === 'active',
      enrolled: true,
    };
  }

  const lastSeen = new Date(lastSeenIso);
  const online = Date.now() - lastSeen.getTime() <= thresholdMs;
  const sleeping =
    normalizedType === 'water_leak' &&
    !online &&
    Date.now() - lastSeen.getTime() <= 12 * 60 * 60 * 1000;
  return {
    status: online ? 'online' : sleeping ? 'sleeping' : 'offline',
    lastSeen: lastSeenIso,
    online,
    enrolled: true,
  };
}

function mapDeviceToInsuranceSensor(doc) {
  const data = doc.data() || {};
  const lastReading = data.lastReading || {};
  const normalizedType = inferDeviceType(data, doc.id);
  const deviceStatus = buildLastSeenStatus(data, normalizedType);
  const registeredAt = normalizeIsoDate(data.registeredAt) || normalizeIsoDate(data.createdAt) || new Date().toISOString();
  const floodData = lastReading['flood:0'] || {};
  const temperatureData = lastReading['temperature:0'] || {};
  const humidityData = lastReading['humidity:0'] || {};

  return {
    id: doc.id,
    deviceId: safeString(data.deviceId, doc.id),
    canonicalKey: canonicalDeviceKey(data, doc.id),
    type: normalizedType,
    name: safeString(data.name, safeString(data.location, doc.id)),
    location: safeString(data.location, 'Unknown'),
    status: deviceStatus.status,
    lastReading: {
      timestamp: deviceStatus.lastSeen || new Date().toISOString(),
      value:
        normalizedType === 'water_leak'
          ? normalizeBoolean(floodData.alarm ?? data.isFlooded ?? data.flood)
          : temperatureData.tC ?? humidityData.rh ?? lastReading.temperature ?? lastReading.humidity ?? false,
      unit:
        normalizedType === 'temperature' || normalizedType === 'temperature_humidity'
          ? 'C'
          : normalizedType === 'humidity'
            ? '%'
            : undefined,
    },
    batteryLevel: data.batteryPercent ?? lastReading.batteryPercent ?? undefined,
    installedDate: registeredAt,
    propertyId: safeString(data.propertyId) || undefined,
    model: safeString(data.model) || undefined,
    firmware: safeString(data.firmware) || undefined,
    mac: safeString(data.mac) || safeString(data.bleAddress) || undefined,
    connectionType: data.connectionType || undefined,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    manufacturer: safeString(data.manufacturer) || (
      normalizedType === 'automatic_shutoff_controller' ||
      normalizedType === 'water_leak' ||
      normalizedType === 'temperature_humidity' ||
      normalizedType === 'gateway'
        ? 'Shelly Group'
        : undefined
    ),
    protectionRole:
      normalizedType === 'water_leak'
        ? 'Point-of-leak detection'
        : normalizedType === 'automatic_shutoff_controller'
          ? 'Automatic main-water shutoff control'
          : normalizedType === 'temperature_humidity'
            ? 'Freeze and environmental monitoring'
            : normalizedType === 'gateway'
              ? 'Local sensor communications bridge'
              : 'Property monitoring',
    lastSeen: deviceStatus.lastSeen,
    online: deviceStatus.online,
    enrolled: deviceStatus.enrolled,
  };
}

function mapAlert(doc) {
  const data = doc.data() || {};
  const reading = data.reading || {};
  const timestamp =
    normalizeIsoDate(data.timestamp) ||
    normalizeIsoDate(data.createdAt) ||
    normalizeIsoDate(reading.localTimestamp) ||
    new Date().toISOString();

  return {
    id: doc.id,
    deviceId: safeString(data.deviceId || data.sensorId),
    sensorId: safeString(data.sensorId || data.deviceId),
    sensorName: safeString(data.sensorName || data.deviceName, 'Unknown Sensor'),
    sensorLocation: safeString(data.location || data.sensorLocation, 'Unknown'),
    level: safeString(data.severity || data.level, 'info'),
    message: safeString(data.message, 'Sensor event recorded'),
    timestamp,
    acknowledged: normalizeBoolean(data.acknowledged),
    propertyId: safeString(data.propertyId) || undefined,
    reading,
    type: safeString(data.type),
  };
}

function defaultCommissioningRecord(ownerProfile, property) {
  return {
    ownerId: ownerProfile.id,
    propertyId: property.id,
    insuredName: safeString(ownerProfile.name),
    insuredEmail: safeString(ownerProfile.email),
    insuredPhone: deriveUserPhone(ownerProfile),
    insurerName: '',
    policyNumber: '',
    installDate: '',
    installerName: '',
    installerCompany: '',
    installationMethod: 'Professional installation',
    installerLicenseNumber: '',
    installerEmail: '',
    installerPhone: '',
    hardwareModel: DEFAULT_VALVE_HARDWARE,
    shutoffSerialNumber: '',
    relaySerialNumber: '',
    componentInventory: [],
    valveLocation: '',
    primaryWaterLineLocation: '',
    batteryBackupInstalled: false,
    automaticLeakDetectionEnabled: false,
    automaticShutoffEnabled: false,
    unattendedShutoffVerified: false,
    manualOverrideVerified: false,
    waterFlowStoppedVerified: false,
    waterServiceRestoredVerified: false,
    valveTravelSeconds: null,
    testMethod: '',
    testPerformedBy: '',
    installationStandardized: false,
    maintenanceDocumented: false,
    wifiValidated: false,
    monitoringActive: false,
    latestSuccessfulTestDate: '',
    remoteCommandVerifiedAt: '',
    leakAlertVerifiedAt: '',
    commandPathDescription: '',
    alertPathDescription: '',
    installationPhotoCaptured: false,
    valvePhotoCaptured: false,
    sensorPhotoCaptured: false,
    modelLabelPhotosCaptured: false,
    notes: '',
    evidencePhotoUrls: [],
    appScreenshotUrls: [],
    invoiceDocumentUrls: [],
    signedAttestationDocumentUrls: [],
    supportingDocumentUrls: [],
    attestationSignedAt: '',
    attestationSignerName: '',
    attestationSignerTitle: '',
    attestationSignerEmail: '',
    attestationConsentText: '',
    attestationIpAddress: '',
    attestationDocumentId: '',
    attestationStatus: 'not_requested',
    attestationSigningUrl: '',
    shellyPartnerStatus: 'not_documented',
    shellyCredentialId: '',
    shellyCredentialDocumentUrls: [],
    econetPartnerStatus: 'not_documented',
    econetCredentialId: '',
    econetCredentialDocumentUrls: [],
    monitoringServiceLevel: 'HouseYield automated property monitoring',
    responseServiceDescription:
      'HouseYield triages qualifying property alerts and can coordinate local maintenance professionals when owner authorization and service availability permit.',
    verificationCode: buildVerificationCode(property.id),
    createdAt: null,
    updatedAt: null,
  };
}

function computeCommissioningStatus(commissioning, sensors) {
  const leakSensors = sensors.filter((sensor) => sensor.type === 'water_leak');
  // This is intentionally weighted by evidence workflow, not by the number of
  // form inputs. HouseYield can generate the majority of a packet from observed
  // property and IoT evidence, but cannot fabricate field-test or installer proof.
  const evidenceGroups = [
    ['propertyProfile', Boolean(commissioning.insuredName || commissioning.insuredEmail), 10],
    ['systemEvidence',
      leakSensors.length > 0 &&
      Array.isArray(commissioning.componentInventory) &&
      commissioning.componentInventory.length > 0 &&
      commissioning.monitoringActive === true &&
      commissioning.wifiValidated === true,
      45],
    ['installationEvidence',
      Boolean(
        commissioning.insurerName &&
        commissioning.installDate &&
        (commissioning.installerName || commissioning.installerCompany) &&
        commissioning.hardwareModel &&
        commissioning.shutoffSerialNumber &&
        commissioning.relaySerialNumber &&
        commissioning.valveLocation &&
        commissioning.primaryWaterLineLocation &&
        commissioning.evidencePhotoUrls?.length &&
        commissioning.invoiceDocumentUrls?.length,
      ),
      15],
    ['functionalCommissioning',
      Boolean(
        commissioning.latestSuccessfulTestDate &&
        commissioning.remoteCommandVerifiedAt &&
        commissioning.leakAlertVerifiedAt &&
        commissioning.automaticLeakDetectionEnabled &&
        commissioning.automaticShutoffEnabled &&
        commissioning.unattendedShutoffVerified &&
        commissioning.manualOverrideVerified &&
        commissioning.waterFlowStoppedVerified &&
        commissioning.waterServiceRestoredVerified,
      ),
      15],
    ['signedAttestation', Boolean(
      commissioning.attestationSignedAt &&
      commissioning.attestationSignerName &&
      commissioning.attestationConsentText &&
      commissioning.attestationStatus === 'completed',
    ), 5],
  ];
  const missingFields = evidenceGroups.filter(([, ok]) => !ok).map(([field]) => field);
  const completedCount = evidenceGroups.length - missingFields.length;
  const completionPercent = evidenceGroups
    .filter(([, ok]) => ok)
    .reduce((total, [, , weight]) => total + weight, 0);

  return {
    readyForSubmission: missingFields.length === 0 && leakSensors.length > 0,
    missingFields,
    completionPercent,
    requiredCount: evidenceGroups.length,
    completedCount,
  };
}

function buildSubmissionChecklist({ propertyFacts, commissioning, commissioningStatus, systemSummary, annualCertification }) {
  return [
    {
      id: 'qualifying-device',
      label: 'Whole-home automatic shutoff hardware identified by exact model',
      status: commissioning.hardwareModel ? 'complete' : 'missing',
      detail: commissioning.hardwareModel || 'Record the exact shutoff, relay, and sensor models used.',
    },
    {
      id: 'component-inventory',
      label: 'Component inventory and serial/model references attached',
      status: commissioning.componentInventory?.length ? 'complete' : 'missing',
      detail: commissioning.componentInventory?.length
        ? `${commissioning.componentInventory.length} component reference(s) recorded.`
        : 'Add exact device names, SKUs, and serials where available.',
    },
    {
      id: 'installation-attestation',
      label: 'Installer attestation with dated sign-off',
      status: commissioning.attestationSignedAt && commissioning.attestationSignerName ? 'complete' : 'missing',
      detail: commissioning.attestationSignedAt
        ? `Signed by ${commissioning.attestationSignerName} on ${commissioning.attestationSignedAt}.`
        : 'Attach a dated installer sign-off or e-signature record.',
    },
    {
      id: 'photos',
      label: 'Installation photos show valve location, sensor placement, and labels',
      status:
        commissioning.installationPhotoCaptured &&
        commissioning.valvePhotoCaptured &&
        commissioning.sensorPhotoCaptured &&
        commissioning.modelLabelPhotosCaptured
          ? 'complete'
          : 'missing',
      detail: `Evidence photos on file: ${commissioning.evidencePhotoUrls?.length || 0}.`,
    },
    {
      id: 'activation-proof',
      label: 'Activation evidence shows the system is healthy and actively monitored',
      status: commissioning.appScreenshotUrls?.length ? 'complete' : 'missing',
      detail: commissioning.appScreenshotUrls?.length
        ? `${commissioning.appScreenshotUrls.length} app screenshot or portal capture(s) recorded.`
        : 'Capture app/portal screenshots showing the devices online and connected.',
    },
    {
      id: 'functional-test',
      label: 'Functional testing documents shutoff, remote command, and alerting',
      status:
        commissioning.latestSuccessfulTestDate &&
        commissioning.remoteCommandVerifiedAt &&
        commissioning.leakAlertVerifiedAt &&
        commissioning.unattendedShutoffVerified &&
        commissioning.manualOverrideVerified
          ? 'complete'
          : 'missing',
      detail:
        commissioning.latestSuccessfulTestDate ||
        commissioning.remoteCommandVerifiedAt ||
        commissioning.leakAlertVerifiedAt
          ? 'At least part of the commissioning test trail is recorded.'
          : 'Record the successful shutoff test, remote command test, and alert test dates.',
    },
    {
      id: 'property-context',
      label: 'Property facts support underwriting context',
      status: propertyFacts.yearBuilt || propertyFacts.propertyType || propertyFacts.occupancyType ? 'complete' : 'recommended',
      detail:
        propertyFacts.yearBuilt || propertyFacts.propertyType || propertyFacts.occupancyType
          ? 'ATTOM-enriched property facts are included in the packet.'
          : 'If available, include ATTOM property facts like year built, occupancy, and recent plumbing permits.',
    },
    {
      id: 'monitoring-footprint',
      label: 'Coverage footprint shows enough monitored devices for the home',
      status: systemSummary.leakSensorCount > 0 ? 'complete' : 'missing',
      detail: `${systemSummary.leakSensorCount} leak sensor(s) are currently assigned to the property.`,
    },
    {
      id: 'annual-recertification',
      label: 'Annual water-loss protection recertification is current',
      status: annualCertification?.packetEligible ? 'complete' : 'missing',
      detail: annualCertification?.packetEligible
        ? `${annualCertification.status === 'expiring_soon' ? 'Certification expires soon' : 'Certification current'} through ${annualCertification.expiresAt || 'the recorded due date'}.`
        : `Current status: ${String(annualCertification?.status || 'not_certified').replace(/_/g, ' ')}. Complete and e-sign the guided functional test.`,
    },
    {
      id: 'readiness',
      label: 'Submission packet is ready for insurer review',
      status: commissioningStatus.readyForSubmission ? 'complete' : 'missing',
      detail: commissioningStatus.readyForSubmission
        ? 'All required documentation fields are present.'
        : `Missing items: ${commissioningStatus.missingFields.join(', ') || 'none listed'}.`,
    },
  ];
}

export async function getOwnerProfile(ownerId) {
  const userDoc = await db.collection(COLLECTIONS.users).doc(ownerId).get();
  if (!userDoc.exists) {
    throw new Error('Owner profile not found');
  }
  const userData = userDoc.data() || {};
  return {
    id: userDoc.id,
    name: safeString(userData.name, 'HouseYield Customer'),
    email: safeString(userData.email),
    phone: deriveUserPhone(userData),
    properties: Array.isArray(userData.properties) ? userData.properties : [],
  };
}

export async function getProperty(propertyId) {
  const propertyDoc = await db.collection(COLLECTIONS.properties).doc(propertyId).get();
  if (!propertyDoc.exists) {
    throw new Error('Property not found');
  }
  const propertyData = propertyDoc.data() || {};
  return {
    id: propertyDoc.id,
    ownerId: safeString(propertyData.ownerId),
    address: safeString(propertyData.address, propertyDoc.id),
    createdAt: normalizeIsoDate(propertyData.createdAt),
    updatedAt: normalizeIsoDate(propertyData.updatedAt),
    propertyData: propertyData.propertyData || propertyData.property_data || {},
    image: propertyData.image || null,
  };
}

async function getPropertySensors(propertyId) {
  const snapshot = await iotDb.collection(COLLECTIONS.shellyDevices).where('propertyId', '==', propertyId).get();
  const byCanonicalKey = new Map();
  for (const sensor of snapshot.docs.map(mapDeviceToInsuranceSensor)) {
    const current = byCanonicalKey.get(sensor.canonicalKey);
    if (!current || new Date(sensor.lastSeen || 0).getTime() > new Date(current.lastSeen || 0).getTime()) {
      byCanonicalKey.set(sensor.canonicalKey, sensor);
    }
  }
  return Array.from(byCanonicalKey.values()).sort((a, b) =>
    `${a.location}-${a.name}`.localeCompare(`${b.location}-${b.name}`),
  );
}

async function getPropertyAlerts(propertyId, limit = 25) {
  const snapshot = await iotDb.collection(COLLECTIONS.alerts).where('propertyId', '==', propertyId).get();
  const alerts = snapshot.docs.map(mapAlert);
  alerts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return alerts.slice(0, limit);
}

async function getPropertyMaintenanceRequests(propertyId, limit = 10) {
  const snapshot = await db.collection(COLLECTIONS.maintenanceRequests).where('propertyId', '==', propertyId).get();
  const records = snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      category: safeString(data.category),
      priority: safeString(data.priority),
      status: safeString(data.status),
      description: safeString(data.description),
      createdAt: normalizeIsoDate(data.createdAt) || normalizeIsoDate(data.updatedAt),
    };
  });
  records.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return records.slice(0, limit);
}

async function getMonitoringEvidence(propertyId, sensors) {
  const cutoff = new Date(Date.now() - MONITORING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const propertyDeviceIds = new Set(sensors.flatMap((sensor) => [sensor.deviceId, sensor.id]).filter(Boolean));
  let readings = [];
  try {
    const snapshot = await iotDb
      .collection('sensor_readings')
      .where('timestamp', '>=', cutoff)
      .orderBy('timestamp', 'desc')
      .limit(MAX_MONITORING_READINGS)
      .get();
    readings = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        deviceId: safeString(data.deviceId || data.sensorId),
        propertyId: safeString(data.propertyId),
        timestamp: normalizeIsoDate(data.timestamp || data.createdAt),
      };
    }).filter((reading) =>
      reading.timestamp &&
      (reading.propertyId === propertyId || (!reading.propertyId && propertyDeviceIds.has(reading.deviceId))),
    );
  } catch (error) {
    console.warn('[Insurance] Monitoring history unavailable:', error.message);
  }

  const observedDeviceIds = new Set(readings.map((reading) => reading.deviceId).filter(Boolean));
  const observedHours = new Set(
    readings.map((reading) => {
      const timestamp = new Date(reading.timestamp);
      timestamp.setMinutes(0, 0, 0);
      return timestamp.toISOString();
    }),
  );
  const sortedTimestamps = readings.map((reading) => reading.timestamp).sort();
  const firstObservedAt = sortedTimestamps[0] || null;
  const lastObservedAt = sortedTimestamps[sortedTimestamps.length - 1] || null;
  const observedPeriodHours =
    firstObservedAt && lastObservedAt
      ? Math.max(1, Math.ceil((new Date(lastObservedAt).getTime() - new Date(firstObservedAt).getTime()) / 3600000) + 1)
      : 0;
  const telemetryContinuityPercent =
    observedPeriodHours > 0
      ? Math.min(100, Math.round((observedHours.size / observedPeriodHours) * 1000) / 10)
      : null;
  const alwaysOnDevices = sensors.filter((sensor) =>
    ['automatic_shutoff_controller', 'gateway', 'temperature_humidity'].includes(sensor.type),
  );
  const currentlyHealthyDevices = sensors.filter((sensor) => sensor.online || sensor.status === 'sleeping');

  return {
    methodology:
      'Telemetry continuity is the share of hourly intervals containing at least one property reading during the observed data period. It is not a contractual service-level guarantee.',
    requestedLookbackDays: MONITORING_LOOKBACK_DAYS,
    firstObservedAt,
    lastObservedAt,
    observedPeriodHours,
    observationCount: readings.length,
    observedHourlyIntervals: observedHours.size,
    telemetryContinuityPercent,
    devicesWithTelemetry: observedDeviceIds.size,
    enrolledDeviceCount: sensors.length,
    currentlyHealthyDeviceCount: currentlyHealthyDevices.length,
    alwaysOnDeviceCount: alwaysOnDevices.length,
    alwaysOnDevicesOnline: alwaysOnDevices.filter((sensor) => sensor.online).length,
    dataLimitReached: readings.length >= MAX_MONITORING_READINGS,
    generatedAt: new Date().toISOString(),
  };
}

export async function getWaterMitigationCommissioning(ownerId, propertyId) {
  const docId = `${ownerId}__${propertyId}`;
  const commissioningDoc = await db.collection(COLLECTIONS.waterMitigationCommissioning).doc(docId).get();
  if (!commissioningDoc.exists) {
    return null;
  }
  const data = commissioningDoc.data() || {};
  return {
    ...data,
    createdAt: normalizeIsoDate(data.createdAt),
    updatedAt: normalizeIsoDate(data.updatedAt),
  };
}

export async function upsertWaterMitigationCommissioning({ ownerId, propertyId, payload }) {
  const ownerProfile = await getOwnerProfile(ownerId);
  const property = await getProperty(propertyId);
  const existing = await getWaterMitigationCommissioning(ownerId, propertyId);
  const docId = `${ownerId}__${propertyId}`;
  const baseRecord = {
    ...defaultCommissioningRecord(ownerProfile, property),
    ...(existing || {}),
  };
  const nextRecord = {
    ...baseRecord,
    ...payload,
    ownerId,
    propertyId,
    insuredName: safeString(payload.insuredName, baseRecord.insuredName),
    insuredEmail: safeString(payload.insuredEmail, baseRecord.insuredEmail),
    insuredPhone: safeString(payload.insuredPhone, baseRecord.insuredPhone),
    insurerName: safeString(payload.insurerName, baseRecord.insurerName),
    policyNumber: safeString(payload.policyNumber, baseRecord.policyNumber),
    installDate: safeString(payload.installDate, baseRecord.installDate),
    installerName: safeString(payload.installerName, baseRecord.installerName),
    installerCompany: safeString(payload.installerCompany, baseRecord.installerCompany),
    installationMethod: safeString(payload.installationMethod, baseRecord.installationMethod),
    installerLicenseNumber: safeString(payload.installerLicenseNumber, baseRecord.installerLicenseNumber),
    installerEmail: safeString(payload.installerEmail, baseRecord.installerEmail),
    installerPhone: safeString(payload.installerPhone, baseRecord.installerPhone),
    hardwareModel: safeString(payload.hardwareModel, baseRecord.hardwareModel),
    shutoffSerialNumber: safeString(payload.shutoffSerialNumber, baseRecord.shutoffSerialNumber),
    relaySerialNumber: safeString(payload.relaySerialNumber, baseRecord.relaySerialNumber),
    componentInventory: Array.isArray(payload.componentInventory)
      ? payload.componentInventory.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.componentInventory,
    valveLocation: safeString(payload.valveLocation, baseRecord.valveLocation),
    primaryWaterLineLocation: safeString(payload.primaryWaterLineLocation, baseRecord.primaryWaterLineLocation),
    latestSuccessfulTestDate: safeString(payload.latestSuccessfulTestDate, baseRecord.latestSuccessfulTestDate),
    remoteCommandVerifiedAt: safeString(payload.remoteCommandVerifiedAt, baseRecord.remoteCommandVerifiedAt),
    leakAlertVerifiedAt: safeString(payload.leakAlertVerifiedAt, baseRecord.leakAlertVerifiedAt),
    commandPathDescription: safeString(payload.commandPathDescription, baseRecord.commandPathDescription),
    alertPathDescription: safeString(payload.alertPathDescription, baseRecord.alertPathDescription),
    notes: safeString(payload.notes, baseRecord.notes),
    batteryBackupInstalled: mergeBoolean(payload, baseRecord, 'batteryBackupInstalled'),
    automaticLeakDetectionEnabled: mergeBoolean(payload, baseRecord, 'automaticLeakDetectionEnabled'),
    automaticShutoffEnabled: mergeBoolean(payload, baseRecord, 'automaticShutoffEnabled'),
    unattendedShutoffVerified: mergeBoolean(payload, baseRecord, 'unattendedShutoffVerified'),
    manualOverrideVerified: mergeBoolean(payload, baseRecord, 'manualOverrideVerified'),
    waterFlowStoppedVerified: mergeBoolean(payload, baseRecord, 'waterFlowStoppedVerified'),
    waterServiceRestoredVerified: mergeBoolean(payload, baseRecord, 'waterServiceRestoredVerified'),
    valveTravelSeconds: mergeNumber(payload, baseRecord, 'valveTravelSeconds'),
    testMethod: safeString(payload.testMethod, baseRecord.testMethod),
    testPerformedBy: safeString(payload.testPerformedBy, baseRecord.testPerformedBy),
    installationStandardized: mergeBoolean(payload, baseRecord, 'installationStandardized'),
    maintenanceDocumented: mergeBoolean(payload, baseRecord, 'maintenanceDocumented'),
    wifiValidated: mergeBoolean(payload, baseRecord, 'wifiValidated'),
    monitoringActive: mergeBoolean(payload, baseRecord, 'monitoringActive'),
    installationPhotoCaptured: mergeBoolean(payload, baseRecord, 'installationPhotoCaptured'),
    valvePhotoCaptured: mergeBoolean(payload, baseRecord, 'valvePhotoCaptured'),
    sensorPhotoCaptured: mergeBoolean(payload, baseRecord, 'sensorPhotoCaptured'),
    modelLabelPhotosCaptured: mergeBoolean(payload, baseRecord, 'modelLabelPhotosCaptured'),
    evidencePhotoUrls: Array.isArray(payload.evidencePhotoUrls)
      ? payload.evidencePhotoUrls.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.evidencePhotoUrls,
    appScreenshotUrls: Array.isArray(payload.appScreenshotUrls)
      ? payload.appScreenshotUrls.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.appScreenshotUrls,
    invoiceDocumentUrls: Array.isArray(payload.invoiceDocumentUrls)
      ? payload.invoiceDocumentUrls.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.invoiceDocumentUrls,
    signedAttestationDocumentUrls: Array.isArray(payload.signedAttestationDocumentUrls)
      ? payload.signedAttestationDocumentUrls.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.signedAttestationDocumentUrls,
    supportingDocumentUrls: Array.isArray(payload.supportingDocumentUrls)
      ? payload.supportingDocumentUrls.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.supportingDocumentUrls,
    attestationSignedAt: safeString(payload.attestationSignedAt, baseRecord.attestationSignedAt),
    attestationSignerName: safeString(payload.attestationSignerName, baseRecord.attestationSignerName),
    attestationSignerTitle: safeString(payload.attestationSignerTitle, baseRecord.attestationSignerTitle),
    attestationSignerEmail: safeString(payload.attestationSignerEmail, baseRecord.attestationSignerEmail),
    attestationConsentText: safeString(payload.attestationConsentText, baseRecord.attestationConsentText),
    attestationIpAddress: safeString(payload.attestationIpAddress, baseRecord.attestationIpAddress),
    attestationDocumentId: safeString(payload.attestationDocumentId, baseRecord.attestationDocumentId),
    attestationStatus: safeString(payload.attestationStatus, baseRecord.attestationStatus),
    attestationSigningUrl: safeString(payload.attestationSigningUrl, baseRecord.attestationSigningUrl),
    shellyPartnerStatus: safeString(payload.shellyPartnerStatus, baseRecord.shellyPartnerStatus),
    shellyCredentialId: safeString(payload.shellyCredentialId, baseRecord.shellyCredentialId),
    shellyCredentialDocumentUrls: Array.isArray(payload.shellyCredentialDocumentUrls)
      ? payload.shellyCredentialDocumentUrls.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.shellyCredentialDocumentUrls,
    econetPartnerStatus: safeString(payload.econetPartnerStatus, baseRecord.econetPartnerStatus),
    econetCredentialId: safeString(payload.econetCredentialId, baseRecord.econetCredentialId),
    econetCredentialDocumentUrls: Array.isArray(payload.econetCredentialDocumentUrls)
      ? payload.econetCredentialDocumentUrls.map((value) => safeString(value)).filter(Boolean)
      : baseRecord.econetCredentialDocumentUrls,
    monitoringServiceLevel: safeString(payload.monitoringServiceLevel, baseRecord.monitoringServiceLevel),
    responseServiceDescription: safeString(payload.responseServiceDescription, baseRecord.responseServiceDescription),
    verificationCode: baseRecord.verificationCode || buildVerificationCode(propertyId),
    createdAt: baseRecord.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.collection(COLLECTIONS.waterMitigationCommissioning).doc(docId).set(nextRecord, { merge: true });
  return nextRecord;
}

/**
 * Persist only facts that HouseYield can objectively observe. Installation
 * details, field-test outcomes, evidence photos, and signatures are excluded
 * because auto-filling them would make an underwriting claim without proof.
 */
export async function applyAutomatedPacketEvidence({ ownerId, propertyId }) {
  const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
  const current = snapshot.commissioning;
  const sensors = snapshot.sensors || [];
  const controllers = sensors.filter((sensor) => sensor.type === 'automatic_shutoff_controller');
  const primaryController = controllers.find((sensor) => sensor.online) || controllers[0] || null;
  const gateways = sensors.filter((sensor) => sensor.type === 'gateway');
  const leakSensors = sensors.filter((sensor) => sensor.type === 'water_leak');
  const controllerOnline = controllers.some((sensor) => sensor.online);
  const inventory = sensors.map((sensor) => [
    sensor.manufacturer,
    sensor.model || sensor.name || sensor.type,
    sensor.location && sensor.location !== 'Unknown' ? sensor.location : null,
    sensor.mac || sensor.deviceId,
  ].filter(Boolean).join(' | '));
  const monitoringObserved = Number(snapshot.monitoringEvidence?.observationCount || 0) > 0;
  const patch = {};
  const completed = [];

  if (!current.componentInventory?.length && inventory.length) {
    patch.componentInventory = inventory;
    completed.push('componentInventory');
  }
  if (!current.monitoringActive && monitoringObserved) {
    patch.monitoringActive = true;
    completed.push('monitoringActive');
  }
  if (!current.wifiValidated && controllerOnline) {
    patch.wifiValidated = true;
    completed.push('wifiValidated');
  }

  // Hardware identity derived from the enrolled shutoff controller. These are
  // device-registry facts (model, identifier, recorded location, enrollment
  // date) — not assertions about field workmanship or test outcomes.
  if (primaryController) {
    if (!current.hardwareModel) {
      const relayModel = primaryController.model
        ? `${primaryController.manufacturer ? `${primaryController.manufacturer} ` : ''}${primaryController.model}`
        : 'Shelly relay controller';
      patch.hardwareModel = `EcoNet Controls Bulldog valve actuator + ${relayModel}`;
      completed.push('hardwareModel');
    }
    if (!current.relaySerialNumber && (primaryController.mac || primaryController.deviceId)) {
      patch.relaySerialNumber = primaryController.mac || primaryController.deviceId;
      completed.push('relaySerialNumber');
    }
    const controllerLocation = primaryController.location && primaryController.location !== 'Unknown'
      ? primaryController.location
      : null;
    if (!current.valveLocation && controllerLocation) {
      patch.valveLocation = controllerLocation;
      completed.push('valveLocation');
    }
    if (!current.primaryWaterLineLocation && controllerLocation) {
      patch.primaryWaterLineLocation = controllerLocation;
      completed.push('primaryWaterLineLocation');
    }
    if (!current.commandPathDescription) {
      patch.commandPathDescription = `HouseYield cloud monitoring issues shutoff commands to the ${primaryController.name || 'water shutoff relay'} (${primaryController.mac || primaryController.deviceId}), which drives the EcoNet Bulldog actuator on the main water line. Leak automations run without manual approval.`;
      completed.push('commandPathDescription');
    }
  }
  if (!current.installDate && sensors.length) {
    const earliestEnrollment = sensors
      .map((sensor) => sensor.installedDate)
      .filter(Boolean)
      .sort()[0];
    if (earliestEnrollment) {
      patch.installDate = earliestEnrollment.slice(0, 10);
      completed.push('installDate');
    }
  }
  if (!current.alertPathDescription && leakSensors.length) {
    patch.alertPathDescription = `${leakSensors.length} enrolled leak sensor(s)${gateways.length ? ` report through ${gateways.length} local gateway(s)` : ''} to HouseYield 24/7 monitoring, which sends owner push/email alerts and triggers the automatic shutoff on a confirmed leak.`;
    completed.push('alertPathDescription');
  }

  const commissioning = Object.keys(patch).length
    ? await upsertWaterMitigationCommissioning({ ownerId, propertyId, payload: patch })
    : current;
  const refreshed = Object.keys(patch).length
    ? await buildInsurancePacketSnapshot({ ownerId, propertyId })
    : snapshot;

  return {
    commissioning,
    snapshot: refreshed,
    completed,
    systemEvidence: {
      enrolledDeviceCount: sensors.length,
      monitoredControllerCount: controllers.length,
      controllerOnline,
      telemetryObservationCount: Number(snapshot.monitoringEvidence?.observationCount || 0),
      inventoryGenerated: inventory.length,
    },
    manualEvidenceRequired: [
      'carrier and policy details',
      'valve actuator serial number and installer identity',
      'installation photographs and invoice/receipt',
      'controlled leak, shutoff, stopped-flow, recovery, and alert test',
      'installer attestation and annual technician recertification',
    ],
  };
}

function buildInstallationCertificate(snapshot) {
  return {
    id: `cert-${snapshot.property.id}`,
    userId: snapshot.owner.id,
    propertyId: snapshot.property.id,
    userInfo: {
      name: snapshot.insuredContact.name,
      email: snapshot.insuredContact.email,
      phone: snapshot.insuredContact.phone,
      address: snapshot.property.address,
    },
    propertyInfo: {
      propertyId: snapshot.property.id,
      address: snapshot.property.address,
      ownerId: snapshot.owner.id,
    },
    systemInfo: {
      installationDate: snapshot.commissioning.installDate || snapshot.systemSummary.earliestInstalledDate || snapshot.generatedAt,
      sensors: snapshot.sensors,
      totalSensors: snapshot.systemSummary.totalSensors,
      onlineSensors: snapshot.systemSummary.onlineSensors,
      leakSensors: snapshot.systemSummary.leakSensorCount,
      valveModel: snapshot.commissioning.hardwareModel,
      valveLocation: snapshot.commissioning.valveLocation,
      automaticShutoffEnabled: snapshot.commissioning.automaticShutoffEnabled === true,
      batteryBackupInstalled: snapshot.commissioning.batteryBackupInstalled === true,
      latestSuccessfulTestDate: snapshot.commissioning.latestSuccessfulTestDate || '',
      commissioningReady: snapshot.commissioningStatus.readyForSubmission,
      commissioningStatus: snapshot.commissioningStatus,
    },
    generatedAt: snapshot.generatedAt,
    verificationCode: snapshot.verificationCode,
  };
}

async function syncInstallerAttestation(commissioning, ownerId, propertyId) {
  if (!commissioning.attestationDocumentId) return commissioning;
  try {
    const { getDocumentById } = await import('../document-service.js');
    const result = await getDocumentById(commissioning.attestationDocumentId);
    const document = result?.document;
    if (!result?.success || !document || document.ownerId !== ownerId || document.propertyId !== propertyId) {
      return commissioning;
    }
    const signedRequest = document.signatureRequests?.find((request) =>
      request.signerRole === 'installer' && request.status === 'signed',
    );
    const attestationStatus = document.status === 'completed'
      ? 'completed'
      : document.status === 'partially_signed'
        ? 'partially_signed'
        : document.status === 'pending_signatures'
          ? 'pending_signature'
          : document.status || commissioning.attestationStatus;
    const next = {
      ...commissioning,
      attestationStatus,
      attestationSignedAt: signedRequest?.signedAt || commissioning.attestationSignedAt,
      attestationSignerName: signedRequest?.signerName || commissioning.attestationSignerName,
      attestationSignerEmail: signedRequest?.signerEmail || commissioning.attestationSignerEmail,
      attestationSignerTitle: signedRequest ? 'Installer / commissioning technician' : commissioning.attestationSignerTitle,
      attestationIpAddress: signedRequest?.ipAddress || commissioning.attestationIpAddress,
    };
    if (
      next.attestationStatus !== commissioning.attestationStatus ||
      next.attestationSignedAt !== commissioning.attestationSignedAt
    ) {
      await db.collection(COLLECTIONS.waterMitigationCommissioning).doc(`${ownerId}__${propertyId}`).set({
        attestationStatus: next.attestationStatus,
        attestationSignedAt: next.attestationSignedAt || '',
        attestationSignerName: next.attestationSignerName || '',
        attestationSignerEmail: next.attestationSignerEmail || '',
        attestationSignerTitle: next.attestationSignerTitle || '',
        attestationIpAddress: next.attestationIpAddress || '',
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
    return next;
  } catch (error) {
    console.warn('[Insurance] Could not synchronize installer attestation:', error.message);
    return commissioning;
  }
}

export async function buildInsurancePacketSnapshot({ ownerId, propertyId }) {
  if (!ownerId || !propertyId) {
    throw new Error('ownerId and propertyId are required');
  }

  const [owner, property, sensors, alerts, maintenanceRequests, installKit] = await Promise.all([
    getOwnerProfile(ownerId),
    getProperty(propertyId),
    getPropertySensors(propertyId),
    getPropertyAlerts(propertyId),
    getPropertyMaintenanceRequests(propertyId),
    getInstallKit(propertyId),
  ]);

  if (property.ownerId && property.ownerId !== ownerId) {
    throw new Error('Property does not belong to the provided owner');
  }

  let commissioning = {
    ...defaultCommissioningRecord(owner, property),
    ...((await getWaterMitigationCommissioning(ownerId, propertyId)) || {}),
  };
  commissioning = await syncInstallerAttestation(commissioning, ownerId, propertyId);
  const provisionedDevices = installKit?.provisionedDevices || [];
  if (!commissioning.componentInventory?.length && provisionedDevices.length) {
    commissioning.componentInventory = provisionedDevices.map((device) =>
      [device.name || device.model || device.type, device.location, device.deviceId].filter(Boolean).join(' | '),
    );
  }
  const verificationCode = commissioning.verificationCode || buildVerificationCode(propertyId);
  const monitoringEvidence = await getMonitoringEvidence(propertyId, sensors).catch((error) => {
    console.warn('[InsurancePacket] Monitoring evidence unavailable:', error.message);
    return {
      methodology: 'Monitoring evidence could not be loaded for this draft.',
      requestedLookbackDays: 30,
      firstObservedAt: null,
      lastObservedAt: null,
      observedPeriodHours: 0,
      observationCount: 0,
      observedHourlyIntervals: 0,
      telemetryContinuityPercent: null,
      devicesWithTelemetry: 0,
      enrolledDeviceCount: sensors.length,
      currentlyHealthyDeviceCount: sensors.filter((sensor) => sensor.online).length,
      alwaysOnDeviceCount: 0,
      alwaysOnDevicesOnline: 0,
      dataLimitReached: false,
      generatedAt: new Date().toISOString(),
    };
  });
  let annualCertification;
  try {
    annualCertification = await getWaterMitigationCertificationSummary({
      ownerId,
      propertyId,
      currentDevices: sensors,
    });
  } catch (error) {
    console.warn('[InsurancePacket] Annual certification summary unavailable:', error.message);
    annualCertification = {
      status: 'not_certified',
      packetEligible: false,
      latest: null,
      latestCertified: null,
      records: [],
      currentInventoryFingerprint: '',
      inventoryChanged: false,
      recertificationRequired: false,
      requiredReason: null,
      requiredAt: null,
      expiresAt: null,
      nextDueAt: null,
      daysUntilDue: null,
      protocolVersion: 'HY-WM-ANNUAL-1.0',
      validForDays: 365,
      latestAutomatedHealthCheck: null,
    };
  }

  const onlineSensors = sensors.filter((sensor) => sensor.online).length;
  const leakSensors = sensors.filter((sensor) => sensor.type === 'water_leak');
  const shutoffControllers = sensors.filter((sensor) => sensor.type === 'automatic_shutoff_controller');
  const floodAlerts = alerts.filter((alert) => alert.type === 'flood' || /water|flood/i.test(alert.message));
  const earliestInstalledDate = sensors
    .map((sensor) => sensor.installedDate)
    .filter(Boolean)
    .sort()[0] || null;
  const baseCommissioningStatus = computeCommissioningStatus(commissioning, sensors);
  const annualCertificationMissing = annualCertification.packetEligible ? [] : ['annualRecertification'];
  const commissioningStatus = {
    ...baseCommissioningStatus,
    readyForSubmission: baseCommissioningStatus.readyForSubmission && annualCertification.packetEligible,
    missingFields: [...baseCommissioningStatus.missingFields, ...annualCertificationMissing],
    requiredCount: baseCommissioningStatus.requiredCount + 1,
    completedCount: baseCommissioningStatus.completedCount + (annualCertification.packetEligible ? 1 : 0),
    completionPercent: baseCommissioningStatus.completionPercent + (annualCertification.packetEligible ? 10 : 0),
  };
  const generatedAt = new Date().toISOString();
  const propertyFacts = buildPropertyFacts(property);

  /*
   * The coverage fraction.
   *
   * The numerator counts only water sensors, deliberately narrower than
   * `monitoredLocationCount` below: a temperature sensor in a hallway is a
   * documented location but it is not water monitoring, and letting it into a
   * water-coverage ratio would overstate the thing the packet is claiming credit
   * for. The denominator comes from property records, not from the twin drawing.
   */
  const monitoredWetLocationCount = new Set(
    leakSensors
      .map((sensor) => sensor.location)
      .filter((location) => location && location !== 'Unknown'),
  ).size;
  const wetLocationCoverage = buildCoverageSummary(
    monitoredWetLocationCount,
    deriveWetLocations(propertyFacts),
  );

  const snapshot = {
    owner,
    property,
    generatedAt,
    verificationCode,
    insuredContact: {
      name: commissioning.insuredName || owner.name,
      email: commissioning.insuredEmail || owner.email,
      phone: commissioning.insuredPhone || owner.phone,
    },
    systemSummary: {
      totalSensors: sensors.length,
      onlineSensors,
      offlineSensors: Math.max(sensors.length - onlineSensors, 0),
      leakSensorCount: leakSensors.length,
      activeAlerts: alerts.filter((alert) => !alert.acknowledged).length,
      floodAlertCount: floodAlerts.length,
      lastAlertAt: alerts[0]?.timestamp || null,
      earliestInstalledDate,
      shutoffControllerCount: shutoffControllers.length,
      monitoredLocationCount: new Set(sensors.map((sensor) => sensor.location).filter((location) => location && location !== 'Unknown')).size,
      ...wetLocationCoverage,
    },
    sensors,
    alerts,
    maintenanceRequests,
    monitoringEvidence,
    annualCertification,
    installationOperations: {
      installKitStatus: installKit?.status || 'not_recorded',
      benchProvisionedDeviceCount: provisionedDevices.length,
      benchProvisionedAt: provisionedDevices
        .map((device) => device.provisionedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
      provisionedBy: [...new Set(provisionedDevices.map((device) => device.provisionedBy).filter(Boolean))],
      provisionedDeviceIds: provisionedDevices.map((device) => device.deviceId).filter(Boolean),
      enrolledDeviceIds: sensors.map((sensor) => sensor.deviceId).filter(Boolean),
      unreconciledProvisionedDeviceIds: provisionedDevices
        .map((device) => device.deviceId)
        .filter((deviceId) => deviceId && !sensors.some((sensor) => sensor.deviceId === deviceId)),
      disclosure: 'Bench provisioning records establish preparation history only. They do not replace site-installation photos, field commissioning, or technician attestation.',
    },
    coverageMap: sensors.map((sensor) => ({
      deviceId: sensor.deviceId,
      location: sensor.location,
      protectionRole: sensor.protectionRole,
      type: sensor.type,
      status: sensor.status,
    })),
    responseOperations: {
      serviceDescription: commissioning.responseServiceDescription || defaultCommissioningRecord(owner, property).responseServiceDescription,
      maintenanceRequestsRecorded: maintenanceRequests.length,
      completedMaintenanceRequests: maintenanceRequests.filter((request) =>
        ['completed', 'resolved', 'closed'].includes(request.status.toLowerCase()),
      ).length,
      openMaintenanceRequests: maintenanceRequests.filter((request) =>
        !['completed', 'resolved', 'closed', 'cancelled'].includes(request.status.toLowerCase()),
      ).length,
      dispatchGuaranteed: false,
      disclosure:
        'Contractor coordination is subject to owner authorization, vendor availability, service geography, and the applicable HouseYield service terms. It is not an emergency-service guarantee.',
    },
    commissioning: {
      ...commissioning,
      verificationCode,
    },
    commissioningStatus,
    propertyFacts,
    submissionChecklist: [],
    underwritingNarrative: {
      request:
        'HouseYield requests underwriting consideration or premium credit for this property based on active leak detection, automatic water shutoff, commissioning evidence, and ongoing monitoring.',
      mitigationStatement:
        commissioning.automaticShutoffEnabled && commissioning.unattendedShutoffVerified
          ? 'The documented system combines point-of-leak detection with a tested automatic main-water shutoff path intended to reduce the severity and duration of covered water-loss events.'
          : 'The property has enrolled water-loss monitoring equipment. Automatic shutoff should not be represented as commissioned until the functional test and installer attestation are complete.',
      keyControls: [
        commissioning.automaticLeakDetectionEnabled ? 'Automatic leak detection enabled' : 'Leak detection enrolled; automatic action not yet attested',
        commissioning.automaticShutoffEnabled && commissioning.unattendedShutoffVerified
          ? 'Automatic main-water shutoff commissioned and functionally tested'
          : 'Automatic shutoff commissioning evidence incomplete',
        'Real-time alerting to owner/manager',
        'Documented commissioning, signed attestation, and testing',
        'Property-specific evidence package with photos, screenshots, and supporting records',
        'Ongoing monitoring of device health and recent events',
      ],
      qualificationNotice:
        'Carrier acceptance, premium credits, subsidies, and policy eligibility are determined solely by the insurer and may vary by state, policy form, property, device model, installation method, and active program rules.',
    },
    documentStatus: 'draft',
    issuedAt: null,
    snapshotHash: null,
  };

  snapshot.submissionChecklist = buildSubmissionChecklist({
    propertyFacts,
    commissioning: snapshot.commissioning,
    commissioningStatus,
    systemSummary: snapshot.systemSummary,
    annualCertification,
  });

  return {
    ...snapshot,
    certificate: buildInstallationCertificate(snapshot),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((output, key) => {
        if (value[key] !== undefined) output[key] = canonicalize(value[key]);
        return output;
      }, {});
  }
  return value;
}

function collectPacketEvidenceUrls(snapshot) {
  const commissioning = snapshot.commissioning || {};
  const groups = [
    ['installation_photos', commissioning.evidencePhotoUrls],
    ['activation_captures', commissioning.appScreenshotUrls],
    ['invoices', commissioning.invoiceDocumentUrls],
    ['installer_attestations', commissioning.signedAttestationDocumentUrls],
    ['supporting', commissioning.supportingDocumentUrls],
    ['shelly_credentials', commissioning.shellyCredentialDocumentUrls],
    ['econet_credentials', commissioning.econetCredentialDocumentUrls],
  ];
  const latestCertification = snapshot.annualCertification?.latestCertified || snapshot.annualCertification?.latest;
  for (const step of latestCertification?.steps || []) {
    groups.push([`annual_test_${step.id}`, step.evidenceUrls]);
  }
  return groups.flatMap(([category, urls]) =>
    (Array.isArray(urls) ? urls : []).map((url) => ({ category, url: String(url || '').trim() })),
  ).filter((entry) => entry.url);
}

function isHouseYieldStorageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'firebasestorage.googleapis.com'
      || url.hostname === 'storage.googleapis.com'
      || url.hostname.endsWith('.firebasestorage.app')
    );
  } catch {
    return false;
  }
}

async function sealPacketEvidenceAssets(snapshot, packetId) {
  const references = collectPacketEvidenceUrls(snapshot);
  if (!references.length) return [];
  const bucket = getStorage().bucket();
  const manifest = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    if (!isHouseYieldStorageUrl(reference.url)) {
      throw new Error(`Evidence asset ${index + 1} is not a HouseYield Firebase Storage URL and cannot be sealed`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(reference.url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Evidence asset ${index + 1} could not be retrieved (${response.status})`);
    const contentType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    if (!(contentType.startsWith('image/') || contentType === 'application/pdf')) {
      throw new Error(`Evidence asset ${index + 1} has unsupported content type ${contentType}`);
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 15 * 1024 * 1024) throw new Error(`Evidence asset ${index + 1} exceeds 15 MB`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 15 * 1024 * 1024) throw new Error(`Evidence asset ${index + 1} exceeds 15 MB`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const extension = contentType === 'application/pdf'
      ? 'pdf'
      : contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    const storagePath = `insurance-packets-sealed/${packetId}/${String(index + 1).padStart(3, '0')}-${reference.category}.${extension}`;
    await bucket.file(storagePath).save(bytes, {
      resumable: false,
      metadata: {
        contentType,
        cacheControl: 'private, max-age=31536000, immutable',
        metadata: {
          packetId,
          sha256,
          sourceUrlSha256: createHash('sha256').update(reference.url).digest('hex'),
          evidenceCategory: reference.category,
          sealedAt: snapshot.issuedAt,
        },
      },
    });
    manifest.push({
      category: reference.category,
      storagePath,
      sha256,
      byteLength: bytes.byteLength,
      contentType,
    });
  }
  return manifest;
}

export async function issueInsurancePacket({ ownerId, propertyId }) {
  const draft = await buildInsurancePacketSnapshot({ ownerId, propertyId });
  if (!draft.commissioningStatus.readyForSubmission) {
    return {
      ...draft,
      issuanceBlocked: true,
    };
  }

  const issuedAt = new Date().toISOString();
  const packetId = `ip_${randomBytes(12).toString('hex')}`;
  const verificationCode = `HY-${randomBytes(8).toString('hex').toUpperCase()}`;
  const issuanceOwner = {
    id: draft.owner.id,
    name: draft.owner.name,
    email: draft.owner.email,
    phone: draft.owner.phone,
  };
  const issuanceProperty = {
    id: draft.property.id,
    ownerId: draft.property.ownerId,
    address: draft.property.address,
    createdAt: draft.property.createdAt,
    updatedAt: draft.property.updatedAt,
  };
  const issuanceBase = {
    ...draft,
    owner: issuanceOwner,
    property: issuanceProperty,
    generatedAt: issuedAt,
    issuedAt,
    packetId,
    verificationCode,
    documentStatus: 'issued',
    issuanceBlocked: false,
    certificate: {
      ...draft.certificate,
      id: packetId,
      generatedAt: issuedAt,
      verificationCode,
    },
    commissioning: {
      ...draft.commissioning,
      verificationCode,
    },
  };
  const evidenceAssetManifest = await sealPacketEvidenceAssets(issuanceBase, packetId);
  const issuedSnapshot = canonicalize({
    ...issuanceBase,
    evidenceAssetManifest,
  });
  const snapshotHash = createHash('sha256').update(JSON.stringify(issuedSnapshot)).digest('hex');
  const sealedSnapshot = {
    ...issuedSnapshot,
    snapshotHash,
  };

  await db.collection(COLLECTIONS.insurancePacketIssuances).doc(packetId).set({
    ownerId,
    propertyId,
    packetId,
    verificationCode,
    issuedAt,
    snapshotHash,
    status: 'active',
    snapshot: sealedSnapshot,
  });

  return sealedSnapshot;
}

export async function sealIssuedInsurancePacketPdf({ ownerId, packetId, pdfBytes }) {
  if (!ownerId || !packetId || !pdfBytes) throw new Error('ownerId, packetId, and pdfBytes are required');
  const reference = db.collection(COLLECTIONS.insurancePacketIssuances).doc(packetId);
  const issuanceSnapshot = await reference.get();
  if (!issuanceSnapshot.exists) throw new Error('Issued packet not found');
  const issuance = issuanceSnapshot.data() || {};
  if (issuance.ownerId !== ownerId) throw new Error('Issued packet owner mismatch');
  const pdfBuffer = Buffer.from(pdfBytes);
  const pdfSha256 = createHash('sha256').update(pdfBuffer).digest('hex');
  const pdfSealedAt = new Date().toISOString();
  await reference.set({
    pdfSha256,
    pdfByteLength: pdfBuffer.byteLength,
    pdfSealedAt,
    pdfSealAlgorithm: 'SHA-256',
  }, { merge: true });
  return { pdfSha256, pdfByteLength: pdfBuffer.byteLength, pdfSealedAt };
}

export async function getIssuedInsurancePacketByCode(verificationCode) {
  const snapshot = await db
    .collection(COLLECTIONS.insurancePacketIssuances)
    .where('verificationCode', '==', verificationCode)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const issuance = snapshot.docs[0].data() || {};
  const storedSnapshot = issuance.snapshot || null;
  if (!storedSnapshot) return null;
  const hashPayload = { ...storedSnapshot };
  delete hashPayload.snapshotHash;
  const currentHash = createHash('sha256').update(JSON.stringify(canonicalize(hashPayload))).digest('hex');
  return {
    ...issuance,
    snapshot: storedSnapshot,
    integrityVerified: currentHash === issuance.snapshotHash,
  };
}

export async function listInsuranceProperties(ownerId) {
  if (!ownerId) {
    return [];
  }

  const snapshot = await db.collection(COLLECTIONS.properties).where('ownerId', '==', ownerId).get();
  const properties = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const summaries = await Promise.all(
    properties.map(async (property) => {
      const propertyId = safeString(property.id, '');
      const [sensors, alerts, commissioning] = await Promise.all([
        getPropertySensors(propertyId),
        getPropertyAlerts(propertyId, 10),
        getWaterMitigationCommissioning(ownerId, propertyId),
      ]);
      const defaultRecord = defaultCommissioningRecord(
        { id: ownerId, name: '', email: '', phone: '' },
        { id: propertyId, address: safeString(property.address) },
      );
      const commissioningStatus = computeCommissioningStatus(
        { ...defaultRecord, ...(commissioning || {}) },
        sensors,
      );
      const annualCertification = await getWaterMitigationCertificationSummary({
        ownerId,
        propertyId,
        currentDevices: sensors,
      });
      const packetReady =
        commissioningStatus.readyForSubmission &&
        annualCertification.packetEligible;
      return {
        propertyId,
        address: safeString(property.address, propertyId),
        totalSensors: sensors.length,
        onlineSensors: sensors.filter((sensor) => sensor.online).length,
        leakSensorCount: sensors.filter((sensor) => sensor.type === 'water_leak').length,
        activeAlerts: alerts.filter((alert) => !alert.acknowledged).length,
        lastAlertAt: alerts[0]?.timestamp || null,
        commissioningCompleted: packetReady,
        commissioningPercent: commissioningStatus.completionPercent + (annualCertification.packetEligible ? 10 : 0),
        certificationStatus: annualCertification.status,
        certificationExpiresAt: annualCertification.expiresAt,
        verificationCode: commissioning?.verificationCode || buildVerificationCode(propertyId),
      };
    }),
  );

  return summaries.sort((a, b) => a.address.localeCompare(b.address));
}
