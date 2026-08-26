// IoT Sensor Types and Interfaces

export enum SensorType {
  WATER_LEAK = 'water_leak',
  TEMPERATURE = 'temperature',
  HUMIDITY = 'humidity',
  FREEZE = 'freeze',
  MOTION = 'motion',
  DOOR_WINDOW = 'door_window',
  SMOKE = 'smoke',
  CO = 'carbon_monoxide',
  TEMPERATURE_HUMIDITY = 'temperature_humidity'
}

/** How a sensor connects to our system */
export type ConnectionType = 'bluetooth' | 'wifi' | 'cloud' | 'bluetooth_gateway';

/** Connection preference for a device */
export type ConnectionPreference = 'bluetooth_preferred' | 'wifi_preferred' | 'cloud_only';

/** BLU Gateway status info */
export interface BluGatewayStatus {
  online: boolean;
  ip: string | null;
  connectedBleDevices: number;
  uptime: number;
  error?: string;
}

/** H&T Sensor reading with source tracking */
export interface HTReading {
  temperature: number | null;  // °C
  temperatureF: number | null; // °F
  humidity: number | null;     // %
  batteryPercent?: number;
  timestamp: Date;
  source: 'bluetooth_gateway' | 'direct_wifi' | 'cloud_api' | 'webhook';
  connectionType: ConnectionType;
}

export enum SensorStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  SLEEPING = 'sleeping',
  WARNING = 'warning',
  ALERT = 'alert'
}

export enum AlertLevel {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical'
}

export interface SensorReading {
  timestamp: string;
  value: number | boolean;
  unit?: string;
}

/** Time-series data point for continuous sensor readings (temp, humidity) */
export interface SensorTimeSeriesPoint {
  timestamp: Date;
  value: number;
  unit: string;
  deviceId: string;
  deviceName?: string;
  location?: string;
}

/** Aggregated sensor data for charting */
export interface SensorChartData {
  time: string;            // Formatted time label
  timestamp: number;       // Unix ms for sorting
  temperature?: number;    // °F
  temperatureC?: number;   // °C
  humidity?: number;       // %
  deviceId: string;
  deviceName: string;
}

/** Predictive maintenance risk assessment */
export interface PredictiveMaintenanceRisk {
  id: string;
  deviceId: string;
  deviceName: string;
  propertyId?: string;
  propertyAddress?: string;
  riskType: PredictiveRiskType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;       // 0-100%
  title: string;
  description: string;
  recommendation: string;
  detectedAt: Date;
  dataPoints: number;       // How many readings contributed
  thresholdValue?: number;  // The threshold that was exceeded
  currentValue?: number;    // Current sensor reading
  trendDirection?: 'rising' | 'falling' | 'stable';
  estimatedTimeToIssue?: string; // e.g. "2-5 days"
  dismissed: boolean;
}

export type PredictiveRiskType = 
  | 'mold_risk'              // Sustained high humidity
  | 'freeze_risk'            // Temperature dropping toward freezing
  | 'pipe_burst_risk'        // Extremely low temps + water pipes nearby
  | 'insulation_failure'     // One room much colder than others
  | 'hvac_malfunction'       // Unusual temp patterns despite HVAC
  | 'humidity_damage'        // Sustained humidity above safe range
  | 'rapid_temp_change'      // Temperature changing too quickly
  | 'ventilation_issue'      // Humidity not dissipating normally
  | 'power_outage_suspected'; // Mains-powered monitors went silent

/** Estimated property power state derived from mains-powered monitors */
export type PropertyPowerEstimation =
  | 'power_likely_on'
  | 'power_uncertain'
  | 'power_outage_suspected'
  | 'power_outage_likely';

export interface PropertyPowerSignal {
  propertyId: string;
  propertyAddress?: string;
  estimation: PropertyPowerEstimation;
  score: number;              // 0-100, higher = more likely power is on
  confidence: number;         // 0-100
  mainsDeviceCount: number;
  mainsOnlineCount: number;
  mainsOfflineCount: number;
  offlineMainsDevices: string[];
  utilityOutageReported?: boolean;
  utilityOutageDetail?: string;
  recommendation: string;
  detectedAt: Date;
}

/** Thresholds for predictive maintenance alerts */
export interface PredictiveThresholds {
  moldHumidityPercent: number;           // Default: 60%
  moldSustainedMinutes: number;          // Default: 240 (4 hours)
  freezeWarningTempF: number;            // Default: 38°F
  freezeCriticalTempF: number;           // Default: 32°F
  pipeBurstTempF: number;               // Default: 20°F
  insulationDiffTempF: number;          // Default: 15°F (diff from average)
  rapidTempChangePerHourF: number;      // Default: 10°F per hour
  highHumidityPercent: number;           // Default: 70%
  lowHumidityPercent: number;            // Default: 25%
  ventilationHumidityMinutes: number;    // Default: 120 (2 hours)
}

/**
 * Research-based risk thresholds documentation:
 * 
 * MOLD GROWTH (EPA & ASHRAE guidelines):
 *   - Mold spores begin germinating at >60% RH sustained for 24-48 hours
 *   - Active growth occurs above 70% RH within 24-48 hours on most surfaces
 *   - At 80%+ RH, mold can grow within 24 hours on organic materials
 *   - Wood, drywall, carpet are most susceptible substrates
 *   - Temperature range 77-86°F (25-30°C) is optimal for most mold species
 *   - We alert early at 60% sustained 4hrs for preventive action
 * 
 * PIPE FREEZE / BURST (IBHS & plumbing industry data):
 *   - Water freezes at 32°F (0°C) in still conditions
 *   - Pipes at risk when ambient temp drops below 20°F (-6.7°C)
 *   - Most pipe bursts occur at 20°F or below due to expansion pressure
 *   - Wind chill can accelerate freezing of exterior/crawlspace pipes
 *   - Recommendation: Keep interior above 55°F when away
 * 
 * INSULATION FAILURE:
 *   - A room 15°F+ colder than other rooms suggests thermal bridge/gap
 *   - Can indicate: missing insulation, air infiltration, duct disconnect
 *   - 25°F+ differential is critical and wastes significant energy
 *   - Multi-sensor comparison enables this detection automatically
 * 
 * ENERGY EFFICIENCY:
 *   - 15°F+ room-to-room differential = ~25-40% higher heating costs for that zone
 *   - Sustained high humidity increases perceived temperature and AC load
 *   - Rapid temp changes (>10°F/hr) suggest drafts or HVAC short-cycling
 */

export interface Sensor {
  id: string;
  deviceId?: string;
  canonicalKey?: string;
  type: SensorType | string;
  name: string;
  location: string;
  status: SensorStatus;
  lastReading: SensorReading;
  batteryLevel?: number;
  installedDate: string;
  propertyId?: string;
  model?: string;
  firmware?: string;
  mac?: string;
  lastSeen?: string | null;
  online?: boolean;
  connectionType?: ConnectionType;
  connectionPreference?: ConnectionPreference;
  bleAddress?: string;
  capabilities?: string[];  // e.g. ['temperature', 'humidity', 'battery']
  manufacturer?: string;
  protectionRole?: string;
  enrolled?: boolean;
}

export interface SensorAlert {
  id: string;
  sensorId: string;
  sensorName: string;
  sensorLocation: string;
  level: AlertLevel;
  message: string;
  timestamp: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  resolvedAt?: string;
}

export interface SystemStatus {
  allSystemsOnline: boolean;
  totalSensors: number;
  onlineSensors: number;
  activeAlerts: number;
  criticalAlerts: number;
  lastUpdated: string;
}

// Insurance Discount Types

export interface Insurer {
  id: string;
  name: string;
  logo?: string;
  discountProgramName?: string;
  discountPercentage?: string;
  submissionEmail?: string;
  submissionPortalUrl?: string;
  requiresProof: boolean;
  acceptedProofTypes: string[];
  sourceUrl?: string;
  programNotes?: string;
}

export interface InsuranceSubmission {
  id: string;
  userId: string;
  insurerId: string;
  policyNumber?: string;
  submittedAt: string;
  status: 'pending' | 'submitted' | 'approved' | 'denied';
  certificateId: string;
  followUpDate?: string;
  notes?: string;
}

export interface InstallationCertificate {
  id: string;
  userId: string;
  propertyId?: string;
  userInfo: {
    name: string;
    email: string;
    phone: string;
    address: string;
  };
  propertyInfo?: {
    propertyId: string;
    address: string;
    ownerId: string;
  };
  systemInfo: {
    installationDate: string;
    sensors: Sensor[];
    totalSensors: number;
    onlineSensors?: number;
    leakSensors?: number;
    valveModel?: string;
    valveLocation?: string;
    automaticShutoffEnabled?: boolean;
    batteryBackupInstalled?: boolean;
    latestSuccessfulTestDate?: string;
    commissioningReady?: boolean;
    commissioningStatus?: {
      readyForSubmission: boolean;
      missingFields: string[];
      completionPercent: number;
    };
  };
  generatedAt: string;
  verificationCode: string;
}

export interface InsuranceEmailTemplate {
  insurerId: string;
  subject: string;
  body: string;
  attachments: string[];
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  insurerInfo?: {
    insurerId: string;
    policyNumber: string;
  };
}

export interface InsurancePropertySummary {
  propertyId: string;
  address: string;
  totalSensors: number;
  onlineSensors: number;
  leakSensorCount: number;
  activeAlerts: number;
  lastAlertAt: string | null;
  commissioningCompleted: boolean;
  commissioningPercent: number;
  verificationCode: string;
  certificationStatus?: WaterMitigationCertificationStatus;
  certificationExpiresAt?: string | null;
}

export type WaterMitigationCertificationStatus =
  | 'not_certified'
  | 'in_progress'
  | 'pending_signature'
  | 'certified'
  | 'expiring_soon'
  | 'expired'
  | 'retest_required'
  | 'failed'
  | 'integrity_failed'
  | 'superseded';

export type WaterMitigationTestResult = 'pending' | 'passed' | 'failed' | 'not_applicable';

export interface WaterMitigationTestStep {
  id: string;
  label: string;
  description: string;
  required: boolean;
  allowNotApplicable: boolean;
  result: WaterMitigationTestResult;
  testedAt: string | null;
  testedBy: string;
  notes: string;
  evidenceUrls: string[];
  sourceEventIds: string[];
  measurements: Record<string, string | number | boolean | null>;
}

export interface WaterMitigationCertification {
  id: string;
  ownerId: string;
  propertyId: string;
  propertyAddress: string;
  type: string;
  reason: string;
  status: WaterMitigationCertificationStatus;
  protocolVersion: string;
  validForDays: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  certifiedAt: string | null;
  expiresAt: string | null;
  nextDueAt: string | null;
  technician: {
    name: string;
    company: string;
    email: string;
    phone: string;
    licenseNumber: string;
  };
  inventorySnapshot: Array<Record<string, unknown>>;
  inventoryFingerprint: string;
  monitoringSnapshot: Record<string, unknown> | null;
  steps: WaterMitigationTestStep[];
  testSummary: {
    readyForSignature: boolean;
    failedStepIds: string[];
    incompleteStepIds: string[];
    completionPercent: number;
  };
  deficiencies: string[];
  correctiveActions: string[];
  generalNotes: string;
  attestationDocumentId: string | null;
  attestationSigningUrl: string | null;
  signatureStatus: string;
  signerAssurance: string;
  sealedDocumentHash: string | null;
  documentIntegrityStatus: string | null;
  renewalReminderTaskId?: string | null;
  renewalReminderAt?: string | null;
}

export interface WaterMitigationCertificationSummary {
  status: WaterMitigationCertificationStatus;
  packetEligible: boolean;
  latest: WaterMitigationCertification | null;
  latestCertified: WaterMitigationCertification | null;
  records: WaterMitigationCertification[];
  currentInventoryFingerprint: string;
  inventoryChanged: boolean;
  recertificationRequired: boolean;
  requiredReason: string | null;
  requiredAt: string | null;
  expiresAt: string | null;
  nextDueAt: string | null;
  daysUntilDue: number | null;
  protocolVersion: string;
  validForDays: number;
  latestAutomatedHealthCheck: {
    id: string;
    checkedAt: string;
    checkType: 'automated_non_disruptive';
    status: 'healthy' | 'warning';
    deviceCount: number;
    healthyDeviceCount: number;
    unhealthyDeviceIds: string[];
    lowBatteryDeviceIds: string[];
    relayControllerCount: number;
    limitation: string;
  } | null;
}

export interface InsurancePropertyFacts {
  attomId?: string | null;
  yearBuilt?: number | null;
  propertyType?: string | null;
  occupancyType?: string | null;
  livingAreaSqFt?: number | null;
  lotAreaSqFt?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  stories?: number | null;
  foundationType?: string | null;
  constructionType?: string | null;
  plumbingPermitCount?: number;
  mostRecentPlumbingPermitDate?: string | null;
}

export interface InsuranceSubmissionChecklistItem {
  id: string;
  label: string;
  status: 'complete' | 'missing' | 'recommended';
  detail?: string;
}

export interface WaterMitigationCommissioning {
  ownerId: string;
  propertyId: string;
  insuredName: string;
  insuredEmail: string;
  insuredPhone: string;
  insurerName: string;
  policyNumber: string;
  installDate: string;
  installerName: string;
  installerCompany: string;
  installationMethod: string;
  installerLicenseNumber: string;
  installerEmail: string;
  installerPhone: string;
  hardwareModel: string;
  shutoffSerialNumber: string;
  relaySerialNumber: string;
  componentInventory: string[];
  valveLocation: string;
  primaryWaterLineLocation: string;
  batteryBackupInstalled: boolean;
  automaticLeakDetectionEnabled: boolean;
  automaticShutoffEnabled: boolean;
  unattendedShutoffVerified: boolean;
  manualOverrideVerified: boolean;
  waterFlowStoppedVerified: boolean;
  waterServiceRestoredVerified: boolean;
  valveTravelSeconds: number | null;
  testMethod: string;
  testPerformedBy: string;
  installationStandardized: boolean;
  maintenanceDocumented: boolean;
  wifiValidated: boolean;
  monitoringActive: boolean;
  latestSuccessfulTestDate: string;
  remoteCommandVerifiedAt: string;
  leakAlertVerifiedAt: string;
  commandPathDescription: string;
  alertPathDescription: string;
  installationPhotoCaptured: boolean;
  valvePhotoCaptured: boolean;
  sensorPhotoCaptured: boolean;
  modelLabelPhotosCaptured: boolean;
  notes: string;
  evidencePhotoUrls: string[];
  appScreenshotUrls: string[];
  invoiceDocumentUrls: string[];
  signedAttestationDocumentUrls: string[];
  supportingDocumentUrls: string[];
  attestationSignedAt: string;
  attestationSignerName: string;
  attestationSignerTitle: string;
  attestationSignerEmail: string;
  attestationConsentText: string;
  attestationIpAddress: string;
  attestationDocumentId: string;
  attestationStatus: string;
  attestationSigningUrl: string;
  shellyPartnerStatus: string;
  shellyCredentialId: string;
  shellyCredentialDocumentUrls: string[];
  econetPartnerStatus: string;
  econetCredentialId: string;
  econetCredentialDocumentUrls: string[];
  monitoringServiceLevel: string;
  responseServiceDescription: string;
  verificationCode: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface InsurancePacketSnapshot {
  owner: {
    id: string;
    name: string;
    email: string;
    phone: string;
    properties: string[];
  };
  property: {
    id: string;
    ownerId: string;
    address: string;
    createdAt: string | null;
    updatedAt: string | null;
    propertyData: Record<string, unknown>;
    image: string | null;
  };
  generatedAt: string;
  verificationCode: string;
  insuredContact: {
    name: string;
    email: string;
    phone: string;
  };
  systemSummary: {
    totalSensors: number;
    onlineSensors: number;
    offlineSensors: number;
    leakSensorCount: number;
    activeAlerts: number;
    floodAlertCount: number;
    lastAlertAt: string | null;
    earliestInstalledDate: string | null;
    shutoffControllerCount: number;
    monitoredLocationCount: number;
  };
  sensors: Sensor[];
  alerts: SensorAlert[];
  maintenanceRequests: Array<{
    id: string;
    category: string;
    priority: string;
    status: string;
    description: string;
    createdAt: string | null;
  }>;
  monitoringEvidence: {
    methodology: string;
    requestedLookbackDays: number;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    observedPeriodHours: number;
    observationCount: number;
    observedHourlyIntervals: number;
    telemetryContinuityPercent: number | null;
    devicesWithTelemetry: number;
    enrolledDeviceCount: number;
    currentlyHealthyDeviceCount: number;
    alwaysOnDeviceCount: number;
    alwaysOnDevicesOnline: number;
    dataLimitReached: boolean;
    generatedAt: string;
  };
  annualCertification: WaterMitigationCertificationSummary;
  installationOperations: {
    installKitStatus: string;
    benchProvisionedDeviceCount: number;
    benchProvisionedAt: string | null;
    provisionedBy: string[];
    provisionedDeviceIds: string[];
    enrolledDeviceIds: string[];
    unreconciledProvisionedDeviceIds: string[];
    disclosure: string;
  };
  coverageMap: Array<{
    deviceId: string;
    location: string;
    protectionRole: string;
    type: string;
    status: string;
  }>;
  responseOperations: {
    serviceDescription: string;
    maintenanceRequestsRecorded: number;
    completedMaintenanceRequests: number;
    openMaintenanceRequests: number;
    dispatchGuaranteed: boolean;
    disclosure: string;
  };
  commissioning: WaterMitigationCommissioning;
  commissioningStatus: {
    readyForSubmission: boolean;
    missingFields: string[];
    completionPercent: number;
    requiredCount?: number;
    completedCount?: number;
  };
  propertyFacts: InsurancePropertyFacts;
  submissionChecklist: InsuranceSubmissionChecklistItem[];
  underwritingNarrative: {
    request: string;
    mitigationStatement: string;
    keyControls: string[];
    qualificationNotice: string;
  };
  documentStatus: 'draft' | 'issued';
  issuedAt: string | null;
  packetId?: string;
  snapshotHash: string | null;
  evidenceAssetManifest?: Array<{
    category: string;
    storagePath: string;
    sha256: string;
    byteLength: number;
    contentType: string;
  }>;
  issuanceBlocked?: boolean;
  certificate: InstallationCertificate;
}

export interface InsuranceMitigationSavingsTier {
  discountPercent: number;
  annualSavings: number;
  monthlySavings: number;
}

export interface InsurancePremiumEstimate {
  insuredValue: number;
  state: string | null;
  propertyType: string;
  occupancyType: string;
  estimatedAnnualPremium: number;
  estimatedMonthlyPremium: number;
  premiumRange: {
    low: number;
    high: number;
    lowMonthly: number;
    highMonthly: number;
  };
  mitigationCredit: {
    conservative: InsuranceMitigationSavingsTier;
    typical: InsuranceMitigationSavingsTier;
    optimistic: InsuranceMitigationSavingsTier;
  };
  recommendedPitch: {
    headlineMonthlySavings: number;
    headlineAnnualSavings: number;
    netMonthlyAfterMonitoring: number;
    netAnnualAfterMonitoring: number;
  };
  houseYieldCosts: {
    monitoringMonthly: number;
    monitoringAnnual: number;
    estimatedKitAndCommissioning: number;
  };
  paybackMonthsOnPremiumSavings: number | null;
  insurer?: {
    id: string;
    name: string;
    programName: string;
    publishedDiscount: string;
    parsedMaxDiscountPercent: number | null;
    estimatedTypicalSavings: InsuranceMitigationSavingsTier;
  } | null;
  methodology: string[];
  disclaimer: string;
}
