#!/usr/bin/env node

const { GoogleAuth } = require('google-auth-library');
const {
  assertGcloudServiceAccountCredentialsReady,
  resolveTargetServiceAccount,
  shouldUseGcloudServiceAccount
} = require('../server/gcloud-service-account-credential.cjs');

function formatFailure(error) {
  const targetServiceAccount = resolveTargetServiceAccount();
  const message = error?.message || String(error);

  if (/invalid_rapt|invalid_grant|reauth related error/i.test(message)) {
    return [
      `Local gcloud service-account auth for ${targetServiceAccount} is stale.`,
      'Run npm run gcloud:houseyield:login to refresh the Workspace login and rebuild the impersonated credential file.',
      `Original error: ${message}`
    ].join(' ');
  }

  return message;
}

async function main() {
  if (!shouldUseGcloudServiceAccount()) {
    console.log('Skipping gcloud service-account auth check because local service-account impersonation is disabled.');
    return;
  }

  const adcInfo = assertGcloudServiceAccountCredentialsReady();
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  if (!token || (typeof token === 'object' && !token.token)) {
    throw new Error('Google Auth did not return an access token for the local impersonated service account.');
  }

  console.log(
    `✅ Local gcloud service-account auth is usable (${adcInfo.impersonatedServiceAccount || resolveTargetServiceAccount()})`
  );
}

main().catch((error) => {
  console.error(`❌ ${formatFailure(error)}`);
  process.exit(1);
});