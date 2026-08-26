/**
 * Firebase Admin SDK Setup for Server-Side Operations
 * 
 * This initializes Firebase Admin to access Firestore from the Express server.
 * Uses service account credentials or Application Default Credentials.
 */

import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import gcloudServiceAccountCredentialModule from './gcloud-service-account-credential.cjs';

const {
  assertGcloudServiceAccountCredentialsReady,
  isAuthorizedUserAdc,
  resolveTargetServiceAccount,
  shouldUseGcloudServiceAccount
} = gcloudServiceAccountCredentialModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '';
const hasServiceAccount = Boolean(serviceAccountPath) && existsSync(serviceAccountPath);

let initialized = false;
let firestoreConfigured = false;

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
    return join(cloudSdkConfig, 'application_default_credentials.json');
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (!homeDir) {
    return '';
  }

  return join(homeDir, '.config', 'gcloud', 'application_default_credentials.json');
}

function readCredentialType(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return typeof parsed?.type === 'string' ? parsed.type : null;
  } catch (error) {
    console.warn(`⚠️  [Firebase Admin] Could not inspect ADC file at ${filePath}: ${error.message}`);
    return null;
  }
}

function assertProductionCredentialSource() {
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
    console.warn('⚠️  [Firebase Admin] Production runtime is relying on ambient ADC. Prefer a Cloud Run runtime service account.');
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

function configureFirestoreDefaults() {
  if (firestoreConfigured) {
    return;
  }

  try {
    const firestore = admin.firestore();
    firestore.settings({ ignoreUndefinedProperties: true });
    firestoreConfigured = true;
    console.log('✅ [Firebase Admin] Firestore configured to ignore undefined properties');
  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('Firestore has already been initialized') || message.includes('Cannot call settings()')) {
      firestoreConfigured = true;
      console.warn('⚠️  [Firebase Admin] Firestore settings already initialized; reusing existing configuration');
      return;
    }
    throw error;
  }
}

/**
 * Initialize Firebase Admin SDK
 */
export function initializeFirebaseAdmin() {
  if (initialized) return admin;
  
  // Check if Firebase is already initialized by another module
  if (admin.apps && admin.apps.length > 0) {
    console.log('✅ [Firebase Admin] Using existing Firebase app');
    initialized = true;
    configureFirestoreDefaults();
    return admin;
  }
  
  try {
    const configuredProjectId = resolveProjectId();

    assertProductionCredentialSource();

    if (hasServiceAccount) {
      const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        ...buildInitOptions(configuredProjectId || serviceAccount.project_id)
      });
      console.log('✅ [Firebase Admin] Initialized with explicit service account');
    } else if (shouldUseGcloudServiceAccount()) {
      const targetServiceAccount = resolveTargetServiceAccount();
      const adcInfo = assertGcloudServiceAccountCredentialsReady();

      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        ...buildInitOptions(configuredProjectId)
      });
      console.log(`✅ [Firebase Admin] Initialized with gcloud service account credentials (${adcInfo.impersonatedServiceAccount || targetServiceAccount})`);
    } else {
      if (serviceAccountPath) {
        console.warn(`⚠️  [Firebase Admin] FIREBASE_SERVICE_ACCOUNT_PATH not found at ${serviceAccountPath}; using Application Default Credentials`);
      }

      if (isAuthorizedUserAdc()) {
        throw new Error(
          'Firebase Admin detected plain gcloud user ADC. Run npm run gcloud:houseyield:service-account so local development uses the backend runtime service account instead.'
        );
      }

      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        ...buildInitOptions(configuredProjectId)
      });
      console.log('✅ [Firebase Admin] Initialized with Application Default Credentials');
    }
    
    initialized = true;
    configureFirestoreDefaults();
    return admin;
  } catch (error) {
    if (error.code === 'app/duplicate-app' || error.code === 'app/invalid-app-options') {
      console.log('✅ [Firebase Admin] Already initialized elsewhere, reusing');
      initialized = true;
      configureFirestoreDefaults();
      return admin;
    }
    console.error('❌ [Firebase Admin] Initialization failed:', error.message);
    throw error;
  }
}

/**
 * Get Firestore instance
 */
export function getFirestore() {
  if (!initialized) {
    initializeFirebaseAdmin();
  }
  return admin.firestore();
}

/**
 * Get Auth instance
 */
export function getAuth() {
  if (!initialized) {
    initializeFirebaseAdmin();
  }
  return admin.auth();
}

/**
 * Get the configured Firebase Storage service.
 */
export function getStorage() {
  if (!initialized) {
    initializeFirebaseAdmin();
  }
  return admin.storage();
}

/**
 * Verify Firebase ID token
 */
export async function verifyIdToken(idToken) {
  const auth = getAuth();
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    return decodedToken;
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return null;
  }
}

/**
 * Middleware to verify Firebase auth token
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      ok: false, 
      error: 'unauthorized', 
      message: 'Missing or invalid authorization header' 
    });
  }
  
  const idToken = authHeader.split('Bearer ')[1];
  
  verifyIdToken(idToken)
    .then(decodedToken => {
      if (!decodedToken) {
        return res.status(401).json({ 
          ok: false, 
          error: 'invalid_token', 
          message: 'Invalid or expired token' 
        });
      }
      req.user = decodedToken;
      next();
    })
    .catch(error => {
      console.error('Auth middleware error:', error);
      res.status(401).json({ 
        ok: false, 
        error: 'auth_error', 
        message: error.message 
      });
    });
}

export default admin;
