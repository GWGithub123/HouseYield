// IoT Sensors and Insurance Integration API
import express from 'express';
import { randomUUID } from 'node:crypto';
import { insurers } from './data/insurers.js';
import { getFirestore, initializeFirebaseAdmin, requireAuth } from './firebase-admin.js';
import {
  buildInsurancePacketSnapshot,
  applyAutomatedPacketEvidence,
  getIssuedInsurancePacketByCode,
  getOwnerProfile,
  getWaterMitigationCommissioning,
  issueInsurancePacket,
  listInsuranceProperties,
  sealIssuedInsurancePacketPdf,
  upsertWaterMitigationCommissioning,
} from './services/insurancePacketService.js';
import {
  generateCombinedInsurancePacketPdf,
  generateInsuranceCertificatePdf,
  generateInsuranceOverviewPdf,
} from './services/insurancePacketPdf.js';
import { estimatePropertyInsurancePremium } from './services/insurancePremiumEstimator.js';
import {
  createCertificationSignatureRequest,
  createWaterMitigationCertification,
  listWaterMitigationCertifications,
  updateWaterMitigationCertification,
} from './services/waterMitigationCertificationService.js';

const router = express.Router();
initializeFirebaseAdmin();
const db = getFirestore();

// Import Shelly service (will gracefully handle if not configured)
let shellyService = null;
try {
  const shellyModule = await import('./services/shellyService.js');
  shellyService = shellyModule.default;
  console.log('✅ Shelly service imported');
} catch (error) {
  console.log('ℹ️  Shelly service not available (optional)');
}

// Mock data storage (in production, use a database)
const mockSensors = [
  {
    id: 'sensor-1',
    type: 'water_leak',
    name: 'Kitchen Leak Detector',
    location: 'Kitchen Sink',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: false },
    batteryLevel: 85,
    installedDate: '2025-01-15T00:00:00Z'
  },
  {
    id: 'sensor-2',
    type: 'water_leak',
    name: 'Basement Leak Detector',
    location: 'Basement Water Heater',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: false },
    batteryLevel: 92,
    installedDate: '2025-01-15T00:00:00Z'
  },
  {
    id: 'sensor-3',
    type: 'temperature',
    name: 'Basement Temperature',
    location: 'Basement',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: 68, unit: '°F' },
    batteryLevel: 78,
    installedDate: '2025-01-15T00:00:00Z'
  },
  {
    id: 'sensor-4',
    type: 'freeze',
    name: 'Pipe Freeze Monitor',
    location: 'Garage',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: false },
    batteryLevel: 88,
    installedDate: '2025-01-15T00:00:00Z'
  },
  {
    id: 'sensor-5',
    type: 'humidity',
    name: 'Basement Humidity',
    location: 'Basement',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: 45, unit: '%' },
    batteryLevel: 91,
    installedDate: '2025-01-15T00:00:00Z'
  },
  {
    id: 'sensor-6',
    type: 'door_window',
    name: 'Front Door Sensor',
    location: 'Front Door',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: false },
    batteryLevel: 95,
    installedDate: '2025-01-15T00:00:00Z'
  },
  {
    id: 'sensor-7',
    type: 'motion',
    name: 'Hallway Motion',
    location: 'Main Hallway',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: false },
    batteryLevel: 72,
    installedDate: '2025-01-15T00:00:00Z'
  },
  {
    id: 'sensor-8',
    type: 'smoke',
    name: 'Kitchen Smoke Detector',
    location: 'Kitchen',
    status: 'online',
    lastReading: { timestamp: new Date().toISOString(), value: false },
    batteryLevel: 88,
    installedDate: '2025-01-15T00:00:00Z'
  }
];

const mockAlerts = [];
function sendPdf(res, filename, pdfBytes) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(pdfBytes));
}

// IoT Endpoints

// Get system status
router.get('/api/iot/system-status', (req, res) => {
  const onlineSensors = mockSensors.filter(s => s.status === 'online').length;
  const activeAlerts = mockAlerts.filter(a => !a.acknowledged).length;
  const criticalAlerts = mockAlerts.filter(a => !a.acknowledged && a.level === 'critical').length;

  res.json({
    allSystemsOnline: onlineSensors === mockSensors.length && criticalAlerts === 0,
    totalSensors: mockSensors.length,
    onlineSensors,
    activeAlerts,
    criticalAlerts,
    lastUpdated: new Date().toISOString()
  });
});

// Get all sensors
router.get('/api/iot/sensors', (req, res) => {
  res.json(mockSensors);
});

// Get all alerts
router.get('/api/iot/alerts', (req, res) => {
  res.json(mockAlerts);
});

// Acknowledge alert
router.post('/api/iot/alerts/:alertId/acknowledge', (req, res) => {
  const alert = mockAlerts.find(a => a.id === req.params.alertId);
  if (alert) {
    alert.acknowledged = true;
    alert.acknowledgedAt = new Date().toISOString();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Alert not found' });
  }
});

// ==================== SHELLY FLOOD GEN4 ENDPOINTS ====================

// Get all Shelly sensors
router.get('/api/iot/shelly/sensors', async (req, res) => {
  if (!shellyService) {
    return res.status(503).json({ 
      error: 'Shelly service not configured',
      message: 'Set SHELLY_CLOUD_AUTH_KEY in .env to enable'
    });
  }

  try {
    const devices = await shellyService.getAllDevicesStatus();
    res.json(devices);
  } catch (error) {
    console.error('Error fetching Shelly sensors:', error);
    res.status(500).json({ error: 'Failed to fetch sensors' });
  }
});

// Get specific sensor status
router.get('/api/iot/shelly/sensors/:deviceId', async (req, res) => {
  if (!shellyService) {
    return res.status(503).json({ error: 'Shelly service not configured' });
  }

  try {
    const device = await shellyService.getDeviceStatus(req.params.deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json(device);
  } catch (error) {
    console.error('Error fetching sensor:', error);
    res.status(500).json({ error: 'Failed to fetch sensor' });
  }
});

// Legacy flood webhook path (older device configs / ngrok URLs).
// Always delegate to the IoT cloud handler so query-param events like
// ?device_id=…&event=flood.alarm create alerts in the IoT Firestore project.
router.post('/api/iot/shelly/webhook', express.json(), async (req, res) => {
  try {
    const { handleShellyCloudWebhook } = await import('./services/shellyCloudWebhookHandler.js');
    return handleShellyCloudWebhook(req, res);
  } catch (error) {
    console.error('[iot-insurance] Legacy Shelly webhook failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Some Shelly firmware GETs the webhook URL for verification.
router.get('/api/iot/shelly/webhook', async (req, res) => {
  try {
    const { handleShellyCloudWebhook } = await import('./services/shellyCloudWebhookHandler.js');
    return handleShellyCloudWebhook(req, res);
  } catch (error) {
    console.error('[iot-insurance] Legacy Shelly webhook GET failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Register new sensor to property
router.post('/api/iot/shelly/register', express.json(), async (req, res) => {
  if (!shellyService) {
    return res.status(503).json({ error: 'Shelly service not configured' });
  }

  try {
    const { deviceId, propertyAddress, location, ownerEmail } = req.body;
    
    if (!deviceId || !propertyAddress || !location) {
      return res.status(400).json({ 
        error: 'Missing required fields: deviceId, propertyAddress, location' 
      });
    }
    
    const registration = await shellyService.registerDevice(
      deviceId,
      propertyAddress,
      location,
      ownerEmail
    );
    
    res.json(registration);
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// Get device history
router.get('/api/iot/shelly/sensors/:deviceId/history', async (req, res) => {
  if (!shellyService) {
    return res.status(503).json({ error: 'Shelly service not configured' });
  }

  try {
    const { startDate, endDate } = req.query;
    const history = await shellyService.getDeviceHistory(
      req.params.deviceId,
      startDate,
      endDate
    );
    res.json(history);
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Health check for Shelly service
router.get('/api/iot/shelly/health', async (req, res) => {
  if (!shellyService) {
    return res.json({
      status: 'not_configured',
      message: 'Shelly service not available. Set SHELLY_CLOUD_AUTH_KEY in .env',
      configured: false
    });
  }

  try {
    const health = await shellyService.healthCheck();
    res.json(health);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      configured: true
    });
  }
});

// ==================== END SHELLY ENDPOINTS ====================

// Insurance Endpoints

router.use('/api/insurance', (req, res, next) => {
  if (req.path.startsWith('/certificate/verify/')) return next();
  return requireAuth(req, res, () => {
    const suppliedOwnerId = String(req.query.ownerId || req.body?.ownerId || '').trim();
    if (suppliedOwnerId && suppliedOwnerId !== req.user.uid) {
      return res.status(403).json({ error: 'The requested owner account does not match the authenticated user' });
    }
    req.insuranceOwnerId = req.user.uid;
    return next();
  });
});

// Get all insurers
router.get('/api/insurance/insurers', (req, res) => {
  res.json(insurers);
});

router.get('/api/insurance/properties', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    if (!ownerId) {
      return res.status(400).json({ error: 'ownerId is required' });
    }
    const properties = await listInsuranceProperties(ownerId);
    res.json(properties);
  } catch (error) {
    console.error('[Insurance] Failed to list properties:', error);
    res.status(500).json({ error: error.message || 'Failed to load insurance properties' });
  }
});

// Get live user profile
router.get('/api/user/profile', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId || String(req.query.ownerId || '').trim();
    if (!ownerId) {
      return res.status(400).json({ error: 'ownerId is required' });
    }
    const profile = await getOwnerProfile(ownerId);
    res.json(profile);
  } catch (error) {
    console.error('[Insurance] Failed to load user profile:', error);
    res.status(500).json({ error: error.message || 'Failed to load user profile' });
  }
});

router.get('/api/insurance/commissioning', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const commissioning = await getWaterMitigationCommissioning(ownerId, propertyId);
    res.json({ commissioning });
  } catch (error) {
    console.error('[Insurance] Failed to load commissioning record:', error);
    res.status(500).json({ error: error.message || 'Failed to load commissioning record' });
  }
});

router.put('/api/insurance/commissioning', express.json(), async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.body.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const commissioning = await upsertWaterMitigationCommissioning({
      ownerId,
      propertyId,
      payload: req.body.commissioning || {},
    });
    res.json({ commissioning });
  } catch (error) {
    console.error('[Insurance] Failed to save commissioning record:', error);
    res.status(500).json({ error: error.message || 'Failed to save commissioning record' });
  }
});

router.post('/api/insurance/packet-checklist/auto-complete', express.json(), async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.body.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'propertyId is required' });
    }
    const result = await applyAutomatedPacketEvidence({ ownerId, propertyId });
    res.json(result);
  } catch (error) {
    console.error('[Insurance] Failed to apply automated packet evidence:', error);
    res.status(500).json({ error: error.message || 'Failed to apply automated packet evidence' });
  }
});

router.post('/api/insurance/attestation-request', express.json(), async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.body.propertyId || '').trim();
    const signerName = String(req.body.signerName || '').trim();
    const signerEmail = String(req.body.signerEmail || '').trim();
    if (!ownerId || !propertyId || !signerName || !signerEmail) {
      return res.status(400).json({ error: 'propertyId, signerName, and signerEmail are required' });
    }

    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    const consentText = String(
      req.body.consentText ||
      'I attest that I installed or inspected the listed water-loss mitigation equipment, completed the recorded functional tests, and that the installation and test results in this record are accurate to the best of my knowledge.',
    ).trim();
    const inventory = snapshot.sensors
      .map((sensor) => `${sensor.manufacturer || ''} ${sensor.model || sensor.name} | ${sensor.location} | ${sensor.deviceId || sensor.id}`)
      .join('\n');
    const content = `HOUSEYIELD WATER MITIGATION INSTALLER ATTESTATION

Property: ${snapshot.property.address}
Property ID: ${propertyId}
Installation date: ${snapshot.commissioning.installDate || 'Not documented'}
Installer / company: ${[snapshot.commissioning.installerName, snapshot.commissioning.installerCompany].filter(Boolean).join(' / ') || signerName}
Valve hardware: ${snapshot.commissioning.hardwareModel || 'Not documented'}
Valve serial: ${snapshot.commissioning.shutoffSerialNumber || 'Not documented'}
Relay serial: ${snapshot.commissioning.relaySerialNumber || 'Not documented'}

RECORDED FUNCTIONAL RESULTS
Automatic leak detection enabled: ${snapshot.commissioning.automaticLeakDetectionEnabled ? 'Yes' : 'No'}
Automatic shutoff enabled: ${snapshot.commissioning.automaticShutoffEnabled ? 'Yes' : 'No'}
Unattended shutoff verified: ${snapshot.commissioning.unattendedShutoffVerified ? 'Yes' : 'No'}
Water flow stopped during test: ${snapshot.commissioning.waterFlowStoppedVerified ? 'Yes' : 'No'}
Water service restored after test: ${snapshot.commissioning.waterServiceRestoredVerified ? 'Yes' : 'No'}
Manual override verified: ${snapshot.commissioning.manualOverrideVerified ? 'Yes' : 'No'}
Latest successful test: ${snapshot.commissioning.latestSuccessfulTestDate || 'Not documented'}
Test method: ${snapshot.commissioning.testMethod || 'Not documented'}

ENROLLED EQUIPMENT
${inventory || 'No enrolled equipment was returned.'}

ATTESTATION
${consentText}`;
    const documentService = await import('./document-service.js');
    const document = await documentService.createDocument({
      ownerId,
      propertyId,
      documentType: 'water_mitigation_installer_attestation',
      title: `Water Mitigation Installer Attestation - ${snapshot.property.address}`,
      content,
      metadata: {
        insurancePacket: true,
        propertyAddress: snapshot.property.address,
        commissioningUpdatedAt: snapshot.commissioning.updatedAt || null,
      },
    });
    const signatureResult = await documentService.createSignatureRequest({
      documentId: document.id,
      signers: [{
        id: `installer-${signerEmail.toLowerCase()}`,
        email: signerEmail,
        name: signerName,
        role: 'installer',
      }],
    });
    if (!signatureResult.success) {
      return res.status(500).json({ error: signatureResult.error || 'Failed to create installer signature request' });
    }
    const signingUrl = signatureResult.signingLinks?.[0]?.signingUrl || '';
    const commissioning = await upsertWaterMitigationCommissioning({
      ownerId,
      propertyId,
      payload: {
        attestationDocumentId: document.id,
        attestationStatus: 'pending_signature',
        attestationSigningUrl: signingUrl,
        attestationSignerName: signerName,
        attestationSignerEmail: signerEmail,
        attestationSignerTitle: 'Installer / commissioning technician',
        attestationConsentText: consentText,
      },
    });
    res.json({ documentId: document.id, signingUrl, commissioning });
  } catch (error) {
    console.error('[Insurance] Failed to create installer attestation request:', error);
    res.status(500).json({ error: error.message || 'Failed to create installer attestation request' });
  }
});

router.get('/api/insurance/certifications', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!propertyId) return res.status(400).json({ error: 'propertyId is required' });
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    res.json({
      summary: snapshot.annualCertification,
      certifications: snapshot.annualCertification.records,
    });
  } catch (error) {
    console.error('[Insurance] Failed to load recertifications:', error);
    res.status(500).json({ error: error.message || 'Failed to load recertifications' });
  }
});

router.post('/api/insurance/certifications', express.json(), async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.body.propertyId || '').trim();
    if (!propertyId) return res.status(400).json({ error: 'propertyId is required' });
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    const existingInProgress = (await listWaterMitigationCertifications(ownerId, propertyId, 20))
      .find((record) => ['in_progress', 'failed', 'pending_signature'].includes(record.status));
    if (existingInProgress && req.body.forceNew !== true) {
      return res.json({ certification: existingInProgress, reused: true });
    }
    const certification = await createWaterMitigationCertification({
      ownerId,
      propertyId,
      type: String(req.body.type || 'annual_full'),
      reason: String(req.body.reason || 'annual_due'),
      technician: req.body.technician || {},
      propertyAddress: snapshot.property.address,
      devices: snapshot.sensors,
      monitoringEvidence: snapshot.monitoringEvidence,
    });
    res.status(201).json({ certification, reused: false });
  } catch (error) {
    console.error('[Insurance] Failed to start recertification:', error);
    res.status(500).json({ error: error.message || 'Failed to start recertification' });
  }
});

router.put('/api/insurance/certifications/:certificationId', express.json(), async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.body.propertyId || '').trim();
    if (!propertyId) return res.status(400).json({ error: 'propertyId is required' });
    const certification = await updateWaterMitigationCertification({
      ownerId,
      propertyId,
      certificationId: req.params.certificationId,
      payload: req.body.certification || {},
    });
    res.json({ certification });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    res.status(status).json({ error: error.message || 'Failed to update recertification' });
  }
});

router.post('/api/insurance/certifications/:certificationId/signature-request', express.json(), async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.body.propertyId || '').trim();
    if (!propertyId) return res.status(400).json({ error: 'propertyId is required' });
    const certification = await createCertificationSignatureRequest({
      ownerId,
      propertyId,
      certificationId: req.params.certificationId,
    });
    res.json({ certification, signingUrl: certification.attestationSigningUrl });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    res.status(status).json({ error: error.message || 'Failed to create recertification signature request' });
  }
});

router.get('/api/insurance/packet-snapshot', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    res.json(snapshot);
  } catch (error) {
    console.error('[Insurance] Failed to build packet snapshot:', error);
    res.status(500).json({ error: error.message || 'Failed to build packet snapshot' });
  }
});

// Generate installation certificate JSON
router.get('/api/insurance/certificate/generate', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    res.json(snapshot.certificate);
  } catch (error) {
    console.error('[Insurance] Failed to generate certificate:', error);
    res.status(500).json({ error: error.message || 'Failed to generate certificate' });
  }
});

router.get('/api/insurance/program-packet/generate', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    res.json({
      title: 'HouseYield Water Damage Mitigation Overview',
      generatedAt: snapshot.generatedAt,
      verificationCode: snapshot.verificationCode,
      propertyAddress: snapshot.property.address,
      systemSummary: snapshot.systemSummary,
      commissioning: snapshot.commissioning,
      readiness: snapshot.commissioningStatus,
    });
  } catch (error) {
    console.error('[Insurance] Failed to generate program packet model:', error);
    res.status(500).json({ error: error.message || 'Failed to generate program packet model' });
  }
});

router.get('/api/insurance/certificate/download', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    const pdfBytes = await generateInsuranceCertificatePdf(snapshot);
    sendPdf(
      res,
      `HouseYield-Water-Shutoff-Commissioning-Certificate-${propertyId}.pdf`,
      pdfBytes,
    );
  } catch (error) {
    console.error('[Insurance] Failed to download certificate PDF:', error);
    res.status(500).json({ error: error.message || 'Failed to generate certificate PDF' });
  }
});

// Backward-compatible legacy route
router.get('/api/insurance/certificate/:certId/download', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    const pdfBytes = await generateInsuranceCertificatePdf(snapshot);
    sendPdf(
      res,
      `HouseYield-Water-Shutoff-Commissioning-Certificate-${req.params.certId || propertyId}.pdf`,
      pdfBytes,
    );
  } catch (error) {
    console.error('[Insurance] Failed to download legacy certificate PDF:', error);
    res.status(500).json({ error: error.message || 'Failed to generate certificate PDF' });
  }
});

router.get('/api/insurance/system-overview/download', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const snapshot = await buildInsurancePacketSnapshot({ ownerId, propertyId });
    const pdfBytes = await generateInsuranceOverviewPdf(snapshot);
    sendPdf(res, 'HouseYield-Water-Damage-Mitigation-Overview.pdf', pdfBytes);
  } catch (error) {
    console.error('[Insurance] Failed to download program packet PDF:', error);
    res.status(500).json({ error: error.message || 'Failed to generate program packet PDF' });
  }
});

router.get('/api/insurance/property-packet/download', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    if (!ownerId || !propertyId) {
      return res.status(400).json({ error: 'ownerId and propertyId are required' });
    }
    const snapshot = await issueInsurancePacket({ ownerId, propertyId });
    const pdfBytes = await generateCombinedInsurancePacketPdf(snapshot);
    if (!snapshot.issuanceBlocked && snapshot.packetId) {
      await sealIssuedInsurancePacketPdf({ ownerId, packetId: snapshot.packetId, pdfBytes });
    }
    sendPdf(res, `HouseYield-Property-Insurance-Packet-${propertyId}.pdf`, pdfBytes);
  } catch (error) {
    console.error('[Insurance] Failed to download combined property packet PDF:', error);
    res.status(500).json({ error: error.message || 'Failed to generate combined packet PDF' });
  }
});

// Create insurance submission
router.post('/api/insurance/submissions', express.json(), async (req, res) => {
  const submission = {
    id: `sub-${randomUUID()}`,
    userId: req.insuranceOwnerId,
    propertyId: req.body.propertyId || null,
    insurerId: req.body.insurerId,
    policyNumber: req.body.policyNumber,
    submittedAt: new Date().toISOString(),
    status: 'prepared',
    certificateId: req.body.certificateId,
    proofTypes: Array.isArray(req.body.proofTypes) ? req.body.proofTypes : ['program-overview', 'property-certificate'],
  };
  await db.collection('insurance_submissions').doc(submission.id).set(submission);
  res.json(submission);
});

router.get('/api/insurance/submissions', async (req, res) => {
  try {
    const ownerId = req.insuranceOwnerId;
    const propertyId = String(req.query.propertyId || '').trim();
    const snapshot = await db.collection('insurance_submissions').where('userId', '==', ownerId).get();
    const submissions = snapshot.docs
      .map((doc) => doc.data())
      .filter((submission) => !propertyId || submission.propertyId === propertyId)
      .sort((a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime());
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to list insurance submissions' });
  }
});

router.patch('/api/insurance/submissions/:submissionId', express.json(), async (req, res) => {
  try {
    const reference = db.collection('insurance_submissions').doc(req.params.submissionId);
    const snapshot = await reference.get();
    if (!snapshot.exists || snapshot.data()?.userId !== req.insuranceOwnerId) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    const allowedStatuses = new Set([
      'prepared',
      'submitted',
      'under_review',
      'more_information_requested',
      'approved_credit',
      'denied',
      'no_response',
      'withdrawn',
    ]);
    const status = String(req.body.status || '').trim();
    if (!allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid submission status' });
    const isDecision = ['approved_credit', 'denied'].includes(status);
    const update = {
      status,
      updatedAt: new Date().toISOString(),
      carrierReference: String(req.body.carrierReference || '').trim() || null,
      carrierResponseNotes: String(req.body.carrierResponseNotes || '').trim() || null,
      approvedCreditPercent: status === 'approved_credit' && Number.isFinite(Number(req.body.approvedCreditPercent))
        ? Number(req.body.approvedCreditPercent)
        : null,
      approvedAnnualSavings: status === 'approved_credit' && Number.isFinite(Number(req.body.approvedAnnualSavings))
        ? Number(req.body.approvedAnnualSavings)
        : null,
      responseReceivedAt: isDecision || status === 'more_information_requested'
        ? String(req.body.responseReceivedAt || new Date().toISOString())
        : null,
    };
    await reference.set(update, { merge: true });
    res.json({ ...snapshot.data(), ...update });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update insurance submission' });
  }
});

// Set follow-up reminder
router.post('/api/insurance/submissions/set-reminder', express.json(), async (req, res) => {
  const reminderId = `reminder-${randomUUID()}`;
  const reminder = {
    id: reminderId,
    ownerId: req.insuranceOwnerId,
    propertyId: req.body.propertyId || null,
    followUpDate: req.body.followUpDate,
    createdAt: new Date().toISOString(),
    status: 'scheduled',
  };
  await db.collection('insurance_submission_reminders').doc(reminderId).set(reminder);
  res.json({
    success: true,
    ...reminder,
  });
});

// Estimate property insurance premium + HouseYield mitigation savings
router.get('/api/insurance/premium-estimate', (req, res) => {
  try {
    const propertyValue = req.query.propertyValue ? Number(req.query.propertyValue) : null;
    const assessedValue = req.query.assessedValue ? Number(req.query.assessedValue) : null;
    const marketValue = req.query.marketValue ? Number(req.query.marketValue) : null;
    const actualAnnualPremium = req.query.actualAnnualPremium
      ? Number(req.query.actualAnnualPremium)
      : null;

    const estimate = estimatePropertyInsurancePremium({
      propertyValue,
      assessedValue,
      marketValue,
      actualAnnualPremium: Number.isFinite(actualAnnualPremium) ? actualAnnualPremium : null,
      state: req.query.state || req.query.propertyState || '',
      propertyType: req.query.propertyType || 'SFR',
      occupancyType: req.query.occupancyType || 'absentee_rental',
      insurerId: req.query.insurerId || null,
      monitoringMonthlyCost: req.query.monitoringMonthly
        ? Number(req.query.monitoringMonthly)
        : undefined,
      hasAutoShutoff: req.query.hasAutoShutoff !== 'false',
    });

    res.json({ ok: true, estimate });
  } catch (error) {
    console.error('[Insurance] Premium estimate failed:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to estimate premium' });
  }
});

router.post('/api/insurance/premium-estimate', express.json(), (req, res) => {
  try {
    const estimate = estimatePropertyInsurancePremium(req.body || {});
    res.json({ ok: true, estimate });
  } catch (error) {
    console.error('[Insurance] Premium estimate failed:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to estimate premium' });
  }
});

// Verify certificate (for insurers)
router.get('/api/insurance/certificate/verify/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const issuance = await getIssuedInsurancePacketByCode(code);
    if (!issuance) {
      return res.status(404).json({ verified: false, message: 'Verification code not found' });
    }
    const packetSnapshot = issuance.snapshot;

    res.json({
      verified: issuance.integrityVerified === true && issuance.status === 'active',
      integrityVerified: issuance.integrityVerified === true,
      documentStatus: issuance.status || 'unknown',
      systemName: 'HouseYield Water Damage Mitigation System',
      packetId: issuance.packetId,
      issuedAt: issuance.issuedAt,
      snapshotHash: issuance.snapshotHash,
      pdfSha256: issuance.pdfSha256 || null,
      pdfByteLength: issuance.pdfByteLength || null,
      pdfSealedAt: issuance.pdfSealedAt || null,
      installationDate: packetSnapshot.commissioning.installDate || null,
      propertyAddress: packetSnapshot.property.address,
      enrolledDevices: packetSnapshot.systemSummary.totalSensors,
      leakSensors: packetSnapshot.systemSummary.leakSensorCount,
      automaticShutoffCommissioned:
        packetSnapshot.commissioning.automaticShutoffEnabled === true &&
        packetSnapshot.commissioning.unattendedShutoffVerified === true,
      monitoringEvidence: {
        firstObservedAt: packetSnapshot.monitoringEvidence?.firstObservedAt || null,
        lastObservedAt: packetSnapshot.monitoringEvidence?.lastObservedAt || null,
        telemetryContinuityPercent: packetSnapshot.monitoringEvidence?.telemetryContinuityPercent ?? null,
      },
      annualCertification: {
        status: packetSnapshot.annualCertification?.status || 'not_certified',
        certifiedAt: packetSnapshot.annualCertification?.latestCertified?.certifiedAt || null,
        expiresAt: packetSnapshot.annualCertification?.expiresAt || null,
        protocolVersion: packetSnapshot.annualCertification?.protocolVersion || null,
      },
      monitoredRisks: [
        'Water leaks and flooding',
        'Freeze-risk environmental conditions',
        'Device health monitoring',
        'Real-time owner/manager alerting',
      ],
    });
  } catch (error) {
    console.error('[Insurance] Failed to verify certificate:', error);
    res.status(500).json({ verified: false, error: error.message || 'Failed to verify certificate' });
  }
});

export default router;
