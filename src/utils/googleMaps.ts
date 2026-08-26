// Lightweight Google Maps loader using script tag (avoids extra deps)
export const GOOGLE_MAPS_API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || '';
if (!GOOGLE_MAPS_API_KEY) console.warn('[Google Maps] VITE_GOOGLE_MAPS_API_KEY not configured in .env');
export const GOOGLE_MAPS_MAP_ID = (import.meta as any).env?.VITE_GOOGLE_MAPS_MAP_ID || "";

export const MAPS_AUTH_FAILURE_MESSAGE =
  'Google Maps blocked this origin (often localhost:5175). Add http://localhost:5175/* to the API key HTTP referrer restrictions, or run maintenance mode on :5173.';

type AuthFailureListener = () => void;
const authFailureListeners = new Set<AuthFailureListener>();
let mapsAuthFailed = false;

/** Subscribe to Google’s gm_authFailure (RefererNotAllowed / UrlAuthenticationCommonError). */
export function onGoogleMapsAuthFailure(listener: AuthFailureListener): () => void {
  authFailureListeners.add(listener);
  if (mapsAuthFailed) {
    try { listener(); } catch { /* ignore */ }
  }
  return () => { authFailureListeners.delete(listener); };
}

export function didGoogleMapsAuthFail(): boolean {
  return mapsAuthFailed;
}

function installAuthFailureHook() {
  if (typeof window === 'undefined') return;
  const previous = (window as any).gm_authFailure;
  (window as any).gm_authFailure = () => {
    mapsAuthFailed = true;
    console.error(`[Google Maps] ✗ ${MAPS_AUTH_FAILURE_MESSAGE}`);
    authFailureListeners.forEach((listener) => {
      try { listener(); } catch { /* ignore */ }
    });
    if (typeof previous === 'function') {
      try { previous(); } catch { /* ignore */ }
    }
  };
}

installAuthFailureHook();

export const loadGoogleMaps = (() => {
  let promise: Promise<void> | null = null;
  return () => {
    if (mapsAuthFailed) {
      return Promise.reject(new Error(MAPS_AUTH_FAILURE_MESSAGE));
    }
    if ((window as any).google?.maps) {
      console.log('[Google Maps] Already loaded');
      return Promise.resolve();
    }
    if (promise) {
      console.log('[Google Maps] Loading in progress...');
      return promise;
    }
    
    console.log('[Google Maps] Starting to load script...');
    promise = new Promise<void>((resolve, reject) => {
      if (!GOOGLE_MAPS_API_KEY) {
        reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not configured'));
        promise = null;
        return;
      }

      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=marker,places&v=weekly&language=en&region=US`;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        console.log('[Google Maps] ✓ Script loaded successfully');
        // Give the API a moment to initialize
        setTimeout(() => {
          if (mapsAuthFailed) {
            promise = null;
            reject(new Error(MAPS_AUTH_FAILURE_MESSAGE));
            return;
          }
          if ((window as any).google?.maps) {
            console.log('[Google Maps] ✓ API fully initialized');
            resolve();
          } else {
            console.error('[Google Maps] ✗ Script loaded but API not available');
            promise = null;
            reject(new Error("Google Maps loaded but API not initialized"));
          }
        }, 100);
      };
      script.onerror = (err) => {
        console.error('[Google Maps] ✗ Script failed to load:', err);
        promise = null;
        reject(new Error("Failed to load Google Maps JS API"));
      };
      document.head.appendChild(script);
      console.log('[Google Maps] Script tag added to document');
    });
    return promise;
  };
})();
