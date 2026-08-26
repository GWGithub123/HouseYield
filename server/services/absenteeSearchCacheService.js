/**
 * Cache ATTOM absentee search responses and processed leads to reduce API calls.
 */

import { getCachedDoc, setCachedDoc, hashCacheKey } from '../firestore-doc-cache.js';

const SEARCH_CACHE_COLLECTION = 'attom_absentee_search_cache';
const LEAD_CACHE_COLLECTION = 'attom_absentee_lead_cache';
const SEARCH_TTL_HOURS = 24 * 7;
const LEAD_TTL_HOURS = 24 * 30;
const CACHE_VERSION = 5;

function buildGeoSearchKey(options = {}) {
  const {
    zipCode,
    county,
    latitude,
    longitude,
    radius = 5,
    page = 1,
    pageSize = 100,
    propertyType = 'ALL',
  } = options;

  return hashCacheKey({
    v: CACHE_VERSION,
    zipCode: zipCode || null,
    county: county || null,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
    radius,
    page,
    pageSize,
    propertyType: propertyType || 'ALL',
  });
}

function getAttomId(prop) {
  return prop?.identifier?.attomId
    || prop?.identifier?.Id
    || prop?.identifier?.id
    || null;
}

export async function getCachedAbsenteeSearch(options = {}) {
  const key = buildGeoSearchKey(options);
  const cached = await getCachedDoc(SEARCH_CACHE_COLLECTION, key, SEARCH_TTL_HOURS);
  if (!cached?.data) return null;
  return {
    ...cached.data,
    fromCache: true,
    cacheAgeHours: cached.ageHours,
    cacheKey: key,
  };
}

export async function setCachedAbsenteeSearch(options = {}, payload = {}) {
  const key = buildGeoSearchKey(options);
  await setCachedDoc(SEARCH_CACHE_COLLECTION, key, {
    ...payload,
    cachedAt: new Date().toISOString(),
    geo: {
      zipCode: options.zipCode || null,
      county: options.county || null,
      latitude: options.latitude ?? null,
      longitude: options.longitude ?? null,
      radius: options.radius ?? null,
      page: options.page ?? 1,
      pageSize: options.pageSize ?? 100,
      propertyType: options.propertyType || 'ALL',
    },
  }, { kind: 'absentee_search' });
  return key;
}

export async function getCachedProcessedLead(attomId) {
  if (!attomId) return null;
  const key = hashCacheKey({ v: CACHE_VERSION, attomId: String(attomId) });
  const cached = await getCachedDoc(LEAD_CACHE_COLLECTION, key, LEAD_TTL_HOURS);
  if (!cached?.data) return null;
  return {
    ...cached.data,
    fromCache: true,
    cacheAgeHours: cached.ageHours,
  };
}

export async function setCachedProcessedLead(attomId, lead) {
  if (!attomId || !lead) return;
  const key = hashCacheKey({ v: CACHE_VERSION, attomId: String(attomId) });
  await setCachedDoc(LEAD_CACHE_COLLECTION, key, {
    ...lead,
    cachedAt: new Date().toISOString(),
  }, { kind: 'absentee_lead', attomId: String(attomId) });
}

export function splitCachedAndFreshProperties(properties = []) {
  const cachedLeads = [];
  const freshProps = [];

  for (const prop of properties) {
    const attomId = getAttomId(prop);
    if (prop.__cachedLead) {
      cachedLeads.push(prop.__cachedLead);
      continue;
    }
    freshProps.push(prop);
  }

  return { cachedLeads, freshProps };
}

export async function hydrateCachedLeadsForRawProperties(properties = []) {
  const hydrated = [];
  let cacheHits = 0;

  for (const prop of properties) {
    const attomId = getAttomId(prop);
    if (!attomId) {
      hydrated.push(prop);
      continue;
    }

    const cachedLead = await getCachedProcessedLead(attomId);
    if (cachedLead) {
      cacheHits += 1;
      hydrated.push({ ...prop, __cachedLead: cachedLead });
    } else {
      hydrated.push(prop);
    }
  }

  return { properties: hydrated, cacheHits };
}
