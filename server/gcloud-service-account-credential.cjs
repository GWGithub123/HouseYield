const { existsSync } = require('fs');
const { readFileSync } = require('fs');

const DEFAULT_PROJECT_ID = 'houseyield';
const DEFAULT_SERVICE_ACCOUNT_NAME = 'houseyield-backend-runtime';

function resolveApplicationDefaultCredentialsPath(env = process.env) {
  const explicitPath = env.GOOGLE_APPLICATION_CREDENTIALS || '';
  if (explicitPath) {
    return explicitPath;
  }

  const cloudSdkConfig = env.CLOUDSDK_CONFIG || '';
  if (cloudSdkConfig) {
    return `${cloudSdkConfig}/application_default_credentials.json`;
  }

  const homeDir = env.HOME || env.USERPROFILE || '';
  if (!homeDir) {
    return '';
  }

  return `${homeDir}/.config/gcloud/application_default_credentials.json`;
}

function resolveProjectId(env = process.env) {
  return env.BACKEND_GCP_PROJECT
    || env.FIREBASE_PROJECT_ID
    || env.GOOGLE_CLOUD_PROJECT
    || env.VITE_FIREBASE_PROJECT_ID
    || env.HOUSEYIELD_GCLOUD_PROJECT
    || DEFAULT_PROJECT_ID;
}

function resolveTargetServiceAccount(env = process.env) {
  const explicitServiceAccount = env.FIREBASE_IMPERSONATE_SERVICE_ACCOUNT || env.BACKEND_GCP_SERVICE_ACCOUNT || '';
  if (explicitServiceAccount) {
    return explicitServiceAccount;
  }

  const projectId = resolveProjectId(env);
  const serviceAccountName = env.BACKEND_GCP_SERVICE_ACCOUNT_NAME || DEFAULT_SERVICE_ACCOUNT_NAME;
  return projectId ? `${serviceAccountName}@${projectId}.iam.gserviceaccount.com` : '';
}

function shouldUseGcloudServiceAccount(env = process.env) {
  if (env.K_SERVICE) {
    return false;
  }

  if (env.FIREBASE_USE_GCLOUD_SERVICE_ACCOUNT === '0') {
    return false;
  }

  return Boolean(resolveTargetServiceAccount(env));
}

function inspectApplicationDefaultCredentials(env = process.env) {
  const filePath = resolveApplicationDefaultCredentialsPath(env);
  if (!filePath || !existsSync(filePath)) {
    return {
      filePath,
      type: null,
      impersonatedServiceAccount: '',
      isServiceAccountImpersonation: false
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const impersonationUrl = typeof parsed?.service_account_impersonation_url === 'string'
      ? parsed.service_account_impersonation_url
      : '';
    const matchedServiceAccount = /serviceAccounts\/([^:]+):(generateAccessToken|generateIdToken)$/.exec(impersonationUrl)?.[1] || '';

    return {
      filePath,
      type: typeof parsed?.type === 'string' ? parsed.type : null,
      impersonatedServiceAccount: matchedServiceAccount,
      isServiceAccountImpersonation: Boolean(matchedServiceAccount)
    };
  } catch (error) {
    return {
      filePath,
      type: null,
      impersonatedServiceAccount: '',
      isServiceAccountImpersonation: false,
      parseError: error.message
    };
  }
}

function assertGcloudServiceAccountCredentialsReady(env = process.env) {
  const targetServiceAccount = resolveTargetServiceAccount(env);
  const adcInfo = inspectApplicationDefaultCredentials(env);

  if (!adcInfo.filePath || !existsSync(adcInfo.filePath)) {
    throw new Error(
      `gcloud service-account credentials are required at ${adcInfo.filePath || '<unknown>'}. Run npm run gcloud:houseyield:service-account to create a credential for ${targetServiceAccount}.`
    );
  }

  if (adcInfo.parseError) {
    throw new Error(`Could not parse gcloud credential file at ${adcInfo.filePath}: ${adcInfo.parseError}`);
  }

  if (!adcInfo.isServiceAccountImpersonation) {
    throw new Error(
      `gcloud credential file at ${adcInfo.filePath} is not impersonating ${targetServiceAccount}. Run npm run gcloud:houseyield:service-account to refresh the backend runtime service-account credential.`
    );
  }

  if (targetServiceAccount && adcInfo.impersonatedServiceAccount && adcInfo.impersonatedServiceAccount !== targetServiceAccount) {
    throw new Error(
      `gcloud credential file at ${adcInfo.filePath} is impersonating ${adcInfo.impersonatedServiceAccount}, but this backend expects ${targetServiceAccount}. Run npm run gcloud:houseyield:service-account to refresh it.`
    );
  }

  return adcInfo;
}

function isAuthorizedUserAdc(env = process.env) {
  const adcInfo = inspectApplicationDefaultCredentials(env);
  return adcInfo.type === 'authorized_user' && !adcInfo.isServiceAccountImpersonation;
}

module.exports = {
  assertGcloudServiceAccountCredentialsReady,
  inspectApplicationDefaultCredentials,
  isAuthorizedUserAdc,
  resolveApplicationDefaultCredentialsPath,
  resolveTargetServiceAccount,
  shouldUseGcloudServiceAccount
};