/**
 * coverageStore.js — Firestore-backed memory of which areas have been
 * screened (recency-shaded map overlay) and which properties are flagged.
 */

import { initializeFirebaseAdmin } from '../firebase-admin.js';
import { hashCacheKey } from '../firestore-doc-cache.js';

const COVERAGE_COLLECTION = 'screener_coverage';
const FLAGS_COLLECTION = 'screener_flags';
const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

let db = null;

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
  } catch (err) {
    console.warn('[CoverageStore] Firestore unavailable:', err.message);
  }
  return db;
}

function coverageKey(search) {
  return hashCacheKey({
    geography: search.geography,
    city: search.city,
    state: search.state,
    zipCode: search.zipCode,
    latitude: search.latitude,
    longitude: search.longitude,
    radiusMiles: search.radiusMiles,
  });
}

async function resolveSearchBoundary(search = {}, criteria = {}) {
  const zipCode = search.zipCode || criteria.zipCode;
  const city = search.city || criteria.city;
  const state = search.state || criteria.state;
  if (!zipCode && !(city && state)) return null;

  const params = new URLSearchParams({
    format: 'geojson',
    polygon_geojson: '1',
    polygon_threshold: '0.0005',
    limit: '1',
    country: 'USA',
  });
  if (zipCode) {
    params.set('postalcode', String(zipCode).trim());
  } else {
    params.set('city', String(city).trim());
    params.set('state', String(state).trim());
  }

  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(`${NOMINATIM_ENDPOINT}?${params.toString()}`, {
      headers: {
        'User-Agent': 'HouseYield DealFinder coverage boundary cache',
        Accept: 'application/geo+json, application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`boundary_http_${response.status}`);
    const payload = await response.json();
    const feature = (payload.features || []).find((item) => {
      return item?.geometry?.type === 'Polygon' || item?.geometry?.type === 'MultiPolygon';
    });
    if (!feature) return null;
    return {
      type: 'Feature',
      properties: {
        label: zipCode ? String(zipCode) : `${city}, ${state}`,
        source: 'openstreetmap-nominatim',
        osmId: feature.properties?.osm_id ?? null,
        displayName: feature.properties?.display_name ?? null,
      },
      geometry: feature.geometry,
    };
  } catch (err) {
    if (timeout) clearTimeout(timeout);
    console.warn('[CoverageStore] Boundary lookup failed:', err.message);
    return null;
  }
}

/**
 * Record a screener run: area, criteria, results snapshot (light), counts.
 */
export async function recordCoverage({ search, criteria, funnel, listings, userId = null }) {
  const firestore = getDb();
  if (!firestore) return null;

  const key = coverageKey(search);
  const centroidLat = search.latitude
    ?? average(listings.map((l) => l.latitude));
  const centroidLng = search.longitude
    ?? average(listings.map((l) => l.longitude));
  const boundaryGeoJson = await resolveSearchBoundary(search, criteria);

  const doc = {
    key,
    userId,
    search,
    criteria: criteria || null,
    funnel,
    centroid: centroidLat != null && centroidLng != null ? { lat: centroidLat, lng: centroidLng } : null,
    boundaryGeoJson,
    boundarySource: boundaryGeoJson?.properties?.source || null,
    zipCodes: [...new Set(listings.map((l) => l.zipCode).filter(Boolean))],
    topListings: listings.slice(0, 60).map((l) => ({
      id: l.id,
      address: l.formattedAddress,
      zipCode: l.zipCode,
      latitude: l.latitude,
      longitude: l.longitude,
      price: l.price,
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
      squareFootage: l.squareFootage,
      yearBuilt: l.yearBuilt,
      daysOnMarket: l.daysOnMarket,
      propertyType: l.propertyType,
      screen: l.screen || null,
    })),
    updatedAt: new Date(),
  };

  try {
    await firestore.collection(COVERAGE_COLLECTION).doc(key).set(doc);
    return key;
  } catch (err) {
    console.error('[CoverageStore] Write failed:', err.message);
    return null;
  }
}

function average(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

/**
 * List coverage areas (most recent first) with recency buckets.
 */
export async function listCoverage({ userId = null, limit = 60 } = {}) {
  const firestore = getDb();
  if (!firestore) return [];

  try {
    let query = firestore.collection(COVERAGE_COLLECTION).orderBy('updatedAt', 'desc').limit(limit);
    const snapshot = await query.get();
    const now = Date.now();

    return snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const updatedAt = data.updatedAt?.toDate?.() || new Date(data.updatedAt || 0);
        const ageDays = (now - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
        return {
          key: data.key,
          search: data.search,
          criteria: data.criteria,
          funnel: data.funnel,
          centroid: data.centroid,
          boundaryGeoJson: data.boundaryGeoJson || null,
          boundarySource: data.boundarySource || null,
          zipCodes: data.zipCodes || [],
          topListings: data.topListings || [],
          listingCount: data.topListings?.length || 0,
          updatedAt: updatedAt.toISOString(),
          ageDays: Math.round(ageDays * 10) / 10,
          recency: ageDays < 1 ? 'fresh' : ageDays < 7 ? 'recent' : 'stale',
        };
      })
      .filter((c) => !userId || !c.userId || c.userId === userId);
  } catch (err) {
    console.error('[CoverageStore] List failed:', err.message);
    return [];
  }
}

/** Load a coverage area's cached listings (instant re-display, no API spend). */
export async function getCoverage(key) {
  const firestore = getDb();
  if (!firestore || !key) return null;

  try {
    const doc = await firestore.collection(COVERAGE_COLLECTION).doc(key).get();
    if (!doc.exists) return null;
    const data = doc.data();
    const updatedAt = data.updatedAt?.toDate?.() || new Date(data.updatedAt || 0);
    return {
      ...data,
      updatedAt: updatedAt.toISOString(),
      ageDays: Math.round(((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)) * 10) / 10,
    };
  } catch (err) {
    console.error('[CoverageStore] Get failed:', err.message);
    return null;
  }
}

/** Flag or unflag a property (persistent star pins). */
export async function setFlag({ address, latitude, longitude, price, dealScore = null, note = null, flagged = true, userId = null }) {
  const firestore = getDb();
  if (!firestore || !address) return null;

  const key = hashCacheKey({ address: String(address).toLowerCase().trim() });

  try {
    if (!flagged) {
      await firestore.collection(FLAGS_COLLECTION).doc(key).delete();
      return { key, flagged: false };
    }
    await firestore.collection(FLAGS_COLLECTION).doc(key).set({
      key,
      userId,
      address,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      price: price ?? null,
      dealScore,
      note,
      updatedAt: new Date(),
    });
    return { key, flagged: true };
  } catch (err) {
    console.error('[CoverageStore] Flag failed:', err.message);
    return null;
  }
}

export async function listFlags({ userId = null, limit = 200 } = {}) {
  const firestore = getDb();
  if (!firestore) return [];

  try {
    const snapshot = await firestore.collection(FLAGS_COLLECTION).orderBy('updatedAt', 'desc').limit(limit).get();
    return snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const updatedAt = data.updatedAt?.toDate?.() || new Date(data.updatedAt || 0);
        return { ...data, updatedAt: updatedAt.toISOString() };
      })
      .filter((f) => !userId || !f.userId || f.userId === userId);
  } catch (err) {
    console.error('[CoverageStore] List flags failed:', err.message);
    return [];
  }
}
