/**
 * FBI Crime Data API integration with Firestore caching.
 *
 * Uses the free FBI Crime Data Explorer API (api.usa.gov/crime/fbi/sapi/)
 * to fetch county-level crime statistics by FIPS code.
 *
 * Requires env FBI_CRIME_API_KEY (free from https://api.data.gov/signup/).
 * Data is cached to Firestore for 90 days to minimize API calls.
 *
 * Collection: community_crime_cache
 *   Document ID = fips_{countyFIPS}
 *   Fields: fips, state_code, county, data, cachedAt, ttlDays
 */

import 'dotenv/config';
import { initializeFirebaseAdmin } from './firebase-admin.js';

const FBI_API_KEY = process.env.FBI_CRIME_API_KEY || process.env['API.Data.Gov_API_Key'] || '';
const FBI_BASE = 'https://api.usa.gov/crime/fbi/cde';
const COLLECTION = 'community_crime_cache';
const TTL_DAYS = 90;

let db = null;

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
  } catch (err) {
    console.warn('[Crime] Firestore unavailable:', err.message);
  }
  return db;
}

function docId(fips, stateCode) {
  if (fips) return `fips_${String(fips).replace(/[^0-9]/g, '')}`;
  if (stateCode) return `state_${String(stateCode).toUpperCase()}`;
  return null;
}

/**
 * Get cached crime data from Firestore.
 * Returns { data, stale } or null.
 */
async function getCachedCrimeData(key) {
  const firestore = getDb();
  if (!firestore || !key) return null;
  try {
    const doc = await firestore.collection(COLLECTION).doc(key).get();
    if (!doc.exists) return null;
    const record = doc.data();
    const cachedAt = record.cachedAt?.toDate?.() || new Date(record.cachedAt);
    const ageDays = (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60 * 24);
    return {
      data: record.data,
      stale: ageDays > TTL_DAYS,
      ageDays: Math.round(ageDays),
    };
  } catch (err) {
    console.error('[Crime] Cache read error:', err.message);
    return null;
  }
}

/**
 * Cache crime data to Firestore.
 */
async function cacheCrimeData(key, data, meta = {}) {
  const firestore = getDb();
  if (!firestore || !key) return;
  try {
    const admin = initializeFirebaseAdmin();
    await firestore.collection(COLLECTION).doc(key).set({
      ...meta,
      data,
      cachedAt: admin.firestore.FieldValue.serverTimestamp(),
      ttlDays: TTL_DAYS,
    });
    console.log(`[Crime] Cached data for key ${key}`);
  } catch (err) {
    console.error('[Crime] Cache write error:', err.message);
  }
}

/**
 * Fetch state crime stats from the FBI Crime Data Explorer (CDE) API.
 * Uses the /cde/summarized/state endpoint with MM-YYYY date format.
 *
 * @param {string} fips - 5-digit county FIPS code (optional)
 * @param {string} stateCode - 2-letter state code (e.g. "MD")
 * @returns {object|null} Crime statistics object
 */
async function fetchFBICrimeData(fips, stateCode) {
  if (!FBI_API_KEY) {
    console.warn('[Crime] FBI_CRIME_API_KEY not set — skipping crime data fetch');
    return null;
  }
  if (!stateCode) return null;

  const stateAbbr = stateCode.toUpperCase();

  try {
    const currentYear = new Date().getFullYear();
    const toYear = currentYear - 1; // FBI data lags ~1-2 years
    const fromYear = toYear - 4;

    // CDE API uses MM-YYYY date format
    const from = `01-${fromYear}`;
    const to = `12-${toYear}`;

    // Fetch violent-crime and property-crime in parallel
    const categories = ['violent-crime', 'property-crime'];
    const results = await Promise.allSettled(
      categories.map(async (category) => {
        const url = `${FBI_BASE}/summarized/state/${stateAbbr}/${category}?from=${from}&to=${to}&API_KEY=${FBI_API_KEY}`;
        console.log(`[Crime] Fetching: ${url.replace(FBI_API_KEY, '***')}`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { category, data: await resp.json() };
      })
    );

    const crimeData = { source: 'FBI Crime Data Explorer', state: stateAbbr, fips };

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { category, data } = result.value;

      // CDE response format: { offenses: { rates: { "State Offenses": { "MM-YYYY": rate, ... } } } }
      const ratesObj = data?.offenses?.rates;
      if (!ratesObj) continue;

      // Get the first key (e.g. "Maryland Offenses")
      const stateKey = Object.keys(ratesObj)[0];
      if (!stateKey) continue;

      const monthlyRates = ratesObj[stateKey]; // { "01-2019": 36.32, "02-2019": 33.1, ... }
      if (!monthlyRates || typeof monthlyRates !== 'object') continue;

      // Group monthly rates by year and compute annual average
      const yearMap = {};
      for (const [dateKey, rate] of Object.entries(monthlyRates)) {
        if (rate == null) continue;
        const year = parseInt(dateKey.split('-')[1], 10);
        if (!yearMap[year]) yearMap[year] = [];
        yearMap[year].push(Number(rate));
      }

      // Find the most recent year with data
      const years = Object.keys(yearMap).map(Number).sort((a, b) => b - a);
      const latestYear = years[0];
      if (!latestYear) continue;

      const latestRates = yearMap[latestYear];
      const avgRate = latestRates.reduce((s, v) => s + v, 0) / latestRates.length;

      if (category === 'violent-crime') {
        crimeData.violent_crime = {
          rate_per_100k: Math.round(avgRate * 10) / 10,
          year: latestYear,
          months_sampled: latestRates.length,
        };
        crimeData.year = latestYear;
      } else if (category === 'property-crime') {
        crimeData.property_crime = {
          rate_per_100k: Math.round(avgRate * 10) / 10,
          year: latestYear,
          months_sampled: latestRates.length,
        };
      }
    }

    if (crimeData.violent_crime || crimeData.property_crime) {
      console.log(`[Crime] ✅ FBI data for ${stateAbbr}:`, JSON.stringify(crimeData));
      return crimeData;
    }

    console.warn(`[Crime] No data returned from CDE for ${stateAbbr}`);
    return null;
  } catch (err) {
    console.error('[Crime] FBI API fetch failed:', err.message);
    return null;
  }
}

/**
 * Get crime data for a FIPS code, with Firestore caching.
 * Returns cached data if fresh, fetches from FBI API otherwise.
 */
export async function getCrimeDataForFips(fips, stateCode, county) {
  if (!stateCode) return null;

  const cacheKey = docId(fips, stateCode);

  // Check cache first
  if (cacheKey) {
    const cached = await getCachedCrimeData(cacheKey);
    if (cached && !cached.stale) {
      console.log(`[Crime] ✅ Cache hit for ${cacheKey} (${cached.ageDays}d old)`);
      return cached.data;
    }

    // Cache miss or stale — fetch fresh
    const freshData = await fetchFBICrimeData(fips, stateCode);

    if (freshData) {
      await cacheCrimeData(cacheKey, freshData, { state_code: stateCode, county: county || '', fips: fips || '' });
      return freshData;
    }

    // If fetch failed but we have stale cache, return it
    if (cached?.data) {
      console.log(`[Crime] ⚠️ Using stale cache for ${cacheKey} (${cached.ageDays}d old)`);
      return cached.data;
    }
  } else {
    // No cache key possible — fetch directly
    return await fetchFBICrimeData(fips, stateCode);
  }

  return null;
}
