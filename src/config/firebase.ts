/**
 * Firebase Configuration
 * 
 * This file initializes Firebase for the frontend.
 * Get your config from: Firebase Console > Project Settings > Your Apps > Web App
 */

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';

// Firebase configuration - Replace with your actual config from Firebase Console
// Go to: https://console.firebase.google.com/project/YOUR_PROJECT/settings/general
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDemo-placeholder",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "houseyield.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "houseyield",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "houseyield.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ""
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication
export const auth = getAuth(app);

// Initialize Firestore
export const db = getFirestore(app);

// Initialize Storage
export const storage = getStorage(app);

// Connect to emulators in development (optional)
if (import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://localhost:9099');
  connectFirestoreEmulator(db, 'localhost', 8080);
  connectStorageEmulator(storage, 'localhost', 9199);
}

export default app;
