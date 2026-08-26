#!/usr/bin/env node
/**
 * Migrate Shelly IoT Firestore data from silken-slice-480417-e0 to houseyield.
 *
 * Export (uses default gcloud / houseyield@gmail.com access to silken):
 *   node scripts/migrate-iot-firestore-to-houseyield.cjs export
 *
 * Import essential device/alert data (admin@myhouseyield.com ADC):
 *   node scripts/migrate-iot-firestore-to-houseyield.cjs import
 *
 * Import all collections including historical readings/webhooks:
 *   node scripts/migrate-iot-firestore-to-houseyield.cjs import --all
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const admin = require('firebase-admin');

const SOURCE_PROJECT = process.env.IOT_MIGRATION_SOURCE_PROJECT || 'silken-slice-480417-e0';
const TARGET_PROJECT = process.env.IOT_MIGRATION_TARGET_PROJECT || 'houseyield';
const EXPORT_DIR = path.join(__dirname, '.iot-migration-export');
const DEFAULT_GCLOUD_ADC = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
const HOUSEYIELD_GCLOUD_ADC = path.join(os.homedir(), '.config', 'gcloud-myhouseyield', 'application_default_credentials.json');

const COLLECTIONS = [
  'shelly_devices',
  'sensor_readings',
  'alerts',
  'sensor_events',
  'sensor_webhooks',
  'app_config',
];

const ESSENTIAL_COLLECTIONS = ['shelly_devices', 'alerts'];

function serializeValue(value) {
  if (value == null) return value;
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]));
  }
  return value;
}

function deserializeValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deserializeValue);
  if (value.__type === 'timestamp') {
    return new admin.firestore.Timestamp(value.seconds, value.nanoseconds);
  }
  if (value.__type === 'geopoint') {
    return new admin.firestore.GeoPoint(value.latitude, value.longitude);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deserializeValue(entry)]));
}

function resolveAdcCredential(adcPath) {
  const parsed = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
  if (parsed.type === 'service_account') {
    return admin.credential.cert(parsed);
  }
  return admin.credential.applicationDefault();
}

async function initAppWithAdc(name, projectId, adcPath) {
  const existing = admin.apps.find((app) => app?.name === name);
  if (existing) return existing;

  if (!adcPath || !fs.existsSync(adcPath)) {
    throw new Error(`ADC file not found: ${adcPath || '(not set)'}`);
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  return admin.initializeApp({
    projectId,
    credential: resolveAdcCredential(adcPath),
  }, name);
}

async function exportCollection(db, collectionName) {
  const snapshot = await db.collection(collectionName).get();
  const docs = snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    data: serializeValue(docSnap.data()),
  }));
  console.log(`  exported ${docs.length} docs from ${collectionName}`);
  return docs;
}

async function runExport() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const adcPath = process.env.IOT_MIGRATION_SOURCE_ADC || DEFAULT_GCLOUD_ADC;
  const app = await initAppWithAdc('iot-export', SOURCE_PROJECT, adcPath);
  const db = app.firestore();

  console.log(`Exporting IoT Firestore from ${SOURCE_PROJECT}...`);
  const payload = {
    sourceProject: SOURCE_PROJECT,
    exportedAt: new Date().toISOString(),
    collections: {},
  };

  for (const collectionName of COLLECTIONS) {
    payload.collections[collectionName] = await exportCollection(db, collectionName);
  }

  const outFile = path.join(EXPORT_DIR, 'iot-firestore-export.json');
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outFile}`);
}

async function importCollection(db, collectionName, docs, batchSize = 400) {
  let written = 0;
  for (let index = 0; index < docs.length; index += batchSize) {
    const batch = db.batch();
    const chunk = docs.slice(index, index + batchSize);
    chunk.forEach((docEntry) => {
      batch.set(
        db.collection(collectionName).doc(docEntry.id),
        deserializeValue(docEntry.data),
        { merge: true },
      );
    });
    await batch.commit();
    written += chunk.length;
  }
  console.log(`  imported ${written} docs into ${collectionName}`);
}

async function runImport(includeAll = false) {
  const inFile = path.join(EXPORT_DIR, 'iot-firestore-export.json');
  if (!fs.existsSync(inFile)) {
    throw new Error(`Missing export file: ${inFile}. Run export first.`);
  }

  const payload = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const adcPath = process.env.IOT_MIGRATION_TARGET_ADC || HOUSEYIELD_GCLOUD_ADC;
  const app = await initAppWithAdc('iot-import', TARGET_PROJECT, adcPath);
  const db = app.firestore();
  const targetCollections = includeAll ? COLLECTIONS : ESSENTIAL_COLLECTIONS;

  console.log(`Importing IoT Firestore into ${TARGET_PROJECT} (${includeAll ? 'all collections' : 'essential only'})...`);
  for (const collectionName of targetCollections) {
    const docs = payload.collections?.[collectionName] || [];
    if (docs.length === 0) {
      console.log(`  skipped empty collection ${collectionName}`);
      continue;
    }
    await importCollection(db, collectionName, docs);
  }
  console.log('Import complete.');
}

async function main() {
  const mode = process.argv[2];
  const includeAll = process.argv.includes('--all');
  if (mode === 'export') {
    await runExport();
    return;
  }
  if (mode === 'import') {
    await runImport(includeAll);
    return;
  }

  console.error('Usage: node scripts/migrate-iot-firestore-to-houseyield.cjs <export|import> [--all]');
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
