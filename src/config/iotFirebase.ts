import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import app, { auth as mainAuth, db as mainDb } from './firebase';
import { resolveIotFirebaseProjectId } from '../utils/iotProjectConfig';

function resolveMainFirebaseProjectId(): string {
  return import.meta.env.VITE_FIREBASE_PROJECT_ID || 'houseyield';
}

function buildIotFirebaseConfig() {
  const projectId = resolveIotFirebaseProjectId();
  const iotApiKey = import.meta.env.VITE_IOT_FIREBASE_API_KEY
    || import.meta.env.VITE_FIREBASE_API_KEY;

  if (!iotApiKey) {
    console.warn(
      '[iotFirebase] VITE_IOT_FIREBASE_API_KEY is missing. '
      + 'Sensor listeners may read the wrong Firebase project.',
    );
  }

  return {
    apiKey: iotApiKey
      || 'AIzaSyDemo-placeholder',
    authDomain: import.meta.env.VITE_IOT_FIREBASE_AUTH_DOMAIN
      || import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
      || `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: import.meta.env.VITE_IOT_FIREBASE_STORAGE_BUCKET
      || import.meta.env.VITE_FIREBASE_STORAGE_BUCKET
      || `${projectId}.firebasestorage.app`,
    messagingSenderId: import.meta.env.VITE_IOT_FIREBASE_MESSAGING_SENDER_ID
      || import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID
      || '',
    appId: import.meta.env.VITE_IOT_FIREBASE_APP_ID
      || import.meta.env.VITE_FIREBASE_APP_ID
      || '',
  };
}

let iotApp: FirebaseApp | null = null;
let iotDb: Firestore | null = null;
let iotAuth: Auth | null = null;

function usesMainFirebaseProject(): boolean {
  return resolveIotFirebaseProjectId() === resolveMainFirebaseProjectId();
}

export function getIotFirestore(): Firestore {
  if (usesMainFirebaseProject()) {
    return mainDb;
  }

  if (iotDb) {
    return iotDb;
  }

  const existing = getApps().find((candidate) => candidate.name === 'iot-cloud');
  iotApp = existing || initializeApp(buildIotFirebaseConfig(), 'iot-cloud');
  iotDb = getFirestore(iotApp);
  return iotDb;
}

export function getIotAuth(): Auth {
  if (usesMainFirebaseProject()) {
    return mainAuth;
  }

  if (!iotApp) {
    getIotFirestore();
  }

  if (!iotAuth && iotApp) {
    iotAuth = getAuth(iotApp);
  }

  return iotAuth || mainAuth;
}

export function getIotProjectId(): string {
  return resolveIotFirebaseProjectId();
}

export { usesMainFirebaseProject };
