/**
 * Environmental Data Caching Service
 * 
 * Caches environmental risk data (wildfire, flood, air quality, noise/OSM) in Firestore
 * to reduce API calls and improve performance
 */

import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { db } from '../config/firebase';

// Cache expiration times (in milliseconds)
const CACHE_EXPIRATION = {
  airQuality: 6 * 60 * 60 * 1000, // 6 hours - air quality changes throughout day
  noise: 7 * 24 * 60 * 60 * 1000, // 7 days - OSM road data is static
  flood: 30 * 24 * 60 * 60 * 1000, // 30 days - FEMA data rarely changes
  wildfire: 24 * 60 * 60 * 1000, // 24 hours - weather and NASA fire data changes daily
};

/**
 * Generate a cache key from coordinates
 * Rounds to 4 decimal places (~11m precision) to allow cache hits for nearby locations
 */
function generateCacheKey(lat: number, lng: number): string {
  const roundedLat = Math.round(lat * 10000) / 10000;
  const roundedLng = Math.round(lng * 10000) / 10000;
  return `${roundedLat}_${roundedLng}`;
}

interface CachedEnvironmentalData {
  data: any;
  timestamp: Timestamp;
  coordinates: {
    lat: number;
    lng: number;
  };
  expiresAt: Timestamp;
}

/**
 * Save air quality data to Firestore
 */
export async function cacheAirQualityData(
  lat: number,
  lng: number,
  data: any
): Promise<void> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `airquality_${cacheKey}`);
    
    const expiresAt = Timestamp.fromMillis(Date.now() + CACHE_EXPIRATION.airQuality);
    
    await setDoc(docRef, {
      data,
      timestamp: serverTimestamp(),
      coordinates: { lat, lng },
      expiresAt,
      type: 'airquality'
    });
    
    console.log('[EnvCache] Air quality data cached:', cacheKey);
  } catch (error) {
    console.error('[EnvCache] Failed to cache air quality data:', error);
  }
}

/**
 * Get cached air quality data from Firestore
 */
export async function getCachedAirQualityData(
  lat: number,
  lng: number
): Promise<any | null> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `airquality_${cacheKey}`);
    
    const docSnap = await getDoc(docRef);
    
    if (!docSnap.exists()) {
      console.log('[EnvCache] No cached air quality data found');
      return null;
    }
    
    const cached = docSnap.data() as CachedEnvironmentalData;
    
    // Check if expired
    if (cached.expiresAt.toMillis() < Date.now()) {
      console.log('[EnvCache] Cached air quality data expired');
      return null;
    }
    
    console.log('[EnvCache] Using cached air quality data');
    return cached.data;
  } catch (error) {
    console.error('[EnvCache] Failed to get cached air quality data:', error);
    return null;
  }
}

/**
 * Save noise/OSM road data to Firestore
 */
export async function cacheNoiseData(
  lat: number,
  lng: number,
  data: any
): Promise<void> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `noise_${cacheKey}`);
    
    const expiresAt = Timestamp.fromMillis(Date.now() + CACHE_EXPIRATION.noise);
    
    await setDoc(docRef, {
      data,
      timestamp: serverTimestamp(),
      coordinates: { lat, lng },
      expiresAt,
      type: 'noise'
    });
    
    console.log('[EnvCache] Noise data cached:', cacheKey, `(${data.roads?.length || 0} roads)`);
  } catch (error) {
    console.error('[EnvCache] Failed to cache noise data:', error);
  }
}

/**
 * Get cached noise/OSM data from Firestore
 */
export async function getCachedNoiseData(
  lat: number,
  lng: number
): Promise<any | null> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `noise_${cacheKey}`);
    
    const docSnap = await getDoc(docRef);
    
    if (!docSnap.exists()) {
      console.log('[EnvCache] No cached noise data found');
      return null;
    }
    
    const cached = docSnap.data() as CachedEnvironmentalData;
    
    // Check if expired
    if (cached.expiresAt.toMillis() < Date.now()) {
      console.log('[EnvCache] Cached noise data expired');
      return null;
    }
    
    console.log('[EnvCache] Using cached noise data:', `${cached.data.roads?.length || 0} roads`);
    return cached.data;
  } catch (error) {
    console.error('[EnvCache] Failed to get cached noise data:', error);
    return null;
  }
}

/**
 * Save flood risk data to Firestore
 */
export async function cacheFloodData(
  lat: number,
  lng: number,
  data: any
): Promise<void> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `flood_${cacheKey}`);
    
    const expiresAt = Timestamp.fromMillis(Date.now() + CACHE_EXPIRATION.flood);
    
    await setDoc(docRef, {
      data,
      timestamp: serverTimestamp(),
      coordinates: { lat, lng },
      expiresAt,
      type: 'flood'
    });
    
    console.log('[EnvCache] Flood data cached:', cacheKey);
  } catch (error) {
    console.error('[EnvCache] Failed to cache flood data:', error);
  }
}

/**
 * Get cached flood data from Firestore
 */
export async function getCachedFloodData(
  lat: number,
  lng: number
): Promise<any | null> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `flood_${cacheKey}`);
    
    const docSnap = await getDoc(docRef);
    
    if (!docSnap.exists()) {
      console.log('[EnvCache] No cached flood data found');
      return null;
    }
    
    const cached = docSnap.data() as CachedEnvironmentalData;
    
    // Check if expired
    if (cached.expiresAt.toMillis() < Date.now()) {
      console.log('[EnvCache] Cached flood data expired');
      return null;
    }
    
    console.log('[EnvCache] Using cached flood data:', {
      hasFloodGridData: !!cached.data?.floodGridData,
      floodGridDataLength: cached.data?.floodGridData?.length || 0,
      keys: Object.keys(cached.data || {})
    });
    return cached.data;
  } catch (error) {
    console.error('[EnvCache] Failed to get cached flood data:', error);
    return null;
  }
}

/**
 * Save wildfire risk data to Firestore
 */
export async function cacheWildfireData(
  lat: number,
  lng: number,
  data: any
): Promise<void> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `wildfire_${cacheKey}`);
    
    const expiresAt = Timestamp.fromMillis(Date.now() + CACHE_EXPIRATION.wildfire);
    
    await setDoc(docRef, {
      data,
      timestamp: serverTimestamp(),
      coordinates: { lat, lng },
      expiresAt,
      type: 'wildfire'
    });
    
    console.log('[EnvCache] Wildfire data cached:', cacheKey);
  } catch (error) {
    console.error('[EnvCache] Failed to cache wildfire data:', error);
  }
}

/**
 * Get cached wildfire data from Firestore
 */
export async function getCachedWildfireData(
  lat: number,
  lng: number
): Promise<any | null> {
  try {
    const cacheKey = generateCacheKey(lat, lng);
    const docRef = doc(db, 'environmental_cache', `wildfire_${cacheKey}`);
    
    const docSnap = await getDoc(docRef);
    
    if (!docSnap.exists()) {
      console.log('[EnvCache] No cached wildfire data found');
      return null;
    }
    
    const cached = docSnap.data() as CachedEnvironmentalData;
    
    // Check if expired
    if (cached.expiresAt.toMillis() < Date.now()) {
      console.log('[EnvCache] Cached wildfire data expired');
      return null;
    }
    
    console.log('[EnvCache] Using cached wildfire data');
    return cached.data;
  } catch (error) {
    console.error('[EnvCache] Failed to get cached wildfire data:', error);
    return null;
  }
}

/**
 * Clear all environmental cache data for a specific location
 */
export async function clearEnvironmentalCache(
  lat: number,
  lng: number
): Promise<{ success: boolean; cleared: string[] }> {
  const cacheKey = generateCacheKey(lat, lng);
  const cleared: string[] = [];
  
  const cacheTypes = ['airquality', 'noise', 'flood', 'wildfire'];
  
  for (const type of cacheTypes) {
    try {
      const docRef = doc(db, 'environmental_cache', `${type}_${cacheKey}`);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        await deleteDoc(docRef);
        cleared.push(type);
        console.log(`[EnvCache] Cleared ${type} cache for ${cacheKey}`);
      }
    } catch (error) {
      console.error(`[EnvCache] Failed to clear ${type} cache:`, error);
    }
  }
  
  console.log(`[EnvCache] Cleared ${cleared.length} cache entries for ${cacheKey}:`, cleared);
  return { success: true, cleared };
}
