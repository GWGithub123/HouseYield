const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const {
  assertGcloudServiceAccountCredentialsReady,
  isAuthorizedUserAdc,
  resolveTargetServiceAccount,
  shouldUseGcloudServiceAccount
} = require('../../server/gcloud-service-account-credential.cjs');

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE);
}

function resolveApplicationDefaultCredentialsPath() {
  const explicitPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  if (explicitPath) {
    return explicitPath;
  }

  const cloudSdkConfig = process.env.CLOUDSDK_CONFIG || '';
  if (cloudSdkConfig) {
    return path.join(cloudSdkConfig, 'application_default_credentials.json');
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (!homeDir) {
    return '';
  }

  return path.join(homeDir, '.config', 'gcloud', 'application_default_credentials.json');
}

function readCredentialType(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return typeof parsed?.type === 'string' ? parsed.type : null;
  } catch (error) {
    console.warn(`⚠️  [Firebase Config CJS] Could not inspect ADC file at ${filePath}: ${error.message}`);
    return null;
  }
}

function assertProductionCredentialSource(hasServiceAccount) {
  if (!isProductionRuntime() || process.env.ALLOW_AUTHORIZED_USER_ADC === '1') {
    return;
  }

  if (hasServiceAccount) {
    return;
  }

  if (shouldUseGcloudServiceAccount()) {
    assertGcloudServiceAccountCredentialsReady();
    return;
  }

  const adcPath = resolveApplicationDefaultCredentialsPath();
  const credentialType = readCredentialType(adcPath);

  if (credentialType === 'authorized_user') {
    throw new Error(
      'Production Firebase Admin cannot use authorized_user ADC. Attach a dedicated service account to the Cloud Run service instead of using gcloud user credentials.'
    );
  }

  if (!process.env.K_SERVICE && !credentialType) {
    console.warn('⚠️  [Firebase Config CJS] Production runtime is relying on ambient ADC. Prefer a Cloud Run runtime service account.');
  }
}

function resolveProjectId() {
  return process.env.FIREBASE_PROJECT_ID
    || process.env.VITE_FIREBASE_PROJECT_ID
    || process.env.GOOGLE_CLOUD_PROJECT
    || '';
}

function resolveStorageBucket() {
  return process.env.FIREBASE_STORAGE_BUCKET
    || process.env.VITE_FIREBASE_STORAGE_BUCKET
    || '';
}

function buildInitOptions(projectId) {
  const initOptions = {};
  const storageBucket = resolveStorageBucket();

  if (projectId) {
    initOptions.projectId = projectId;
  }

  if (storageBucket) {
    initOptions.storageBucket = storageBucket;
  }

  return initOptions;
}

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '';
const hasServiceAccount = Boolean(serviceAccountPath) && fs.existsSync(serviceAccountPath);

// Check if Firebase is already initialized
let db;
if (admin.apps && admin.apps.length > 0) {
  console.log('✅ [Firebase Config CJS] Using existing Firebase app');
  db = admin.firestore();
} else {
  // Initialize Firebase Admin SDK
  try {
    const configuredProjectId = resolveProjectId();

    assertProductionCredentialSource(hasServiceAccount);

    if (hasServiceAccount) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        ...buildInitOptions(configuredProjectId || serviceAccount.project_id)
      });
      console.log('✅ [Firebase Config CJS] Initialized with explicit service account');
    } else if (shouldUseGcloudServiceAccount()) {
      const targetServiceAccount = resolveTargetServiceAccount();
      const adcInfo = assertGcloudServiceAccountCredentialsReady();

      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        ...buildInitOptions(configuredProjectId)
      });
      console.log(`✅ [Firebase Config CJS] Initialized with gcloud service account credentials (${adcInfo.impersonatedServiceAccount || targetServiceAccount})`);
    } else {
      if (serviceAccountPath) {
        console.warn(`⚠️  [Firebase Config CJS] FIREBASE_SERVICE_ACCOUNT_PATH not found at ${serviceAccountPath}; using Application Default Credentials`);
      }

      if (isAuthorizedUserAdc()) {
        throw new Error(
          'Firebase Config CJS detected plain gcloud user ADC. Run npm run gcloud:houseyield:service-account so local development uses the backend runtime service account instead.'
        );
      }

      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        ...buildInitOptions(configuredProjectId)
      });
      console.log('✅ [Firebase Config CJS] Initialized with Application Default Credentials');
    }
  } catch (error) {
    if (error.code === 'app/duplicate-app' || error.code === 'app/invalid-app-options') {
      console.log('✅ [Firebase Config CJS] Already initialized elsewhere');
    } else {
      throw error;
    }
  }
  db = admin.firestore();
}

// Collection references
const collections = {
  customers: db.collection('customers'),
  properties: db.collection('properties'),
  sensors: db.collection('shelly_devices'),
  sensor_readings: db.collection('sensor_readings'),
  alerts: db.collection('alerts')
};

module.exports = {
  admin,
  db,
  collections
};
