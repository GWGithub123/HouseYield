/**
 * Maintenance provider network.
 *
 * Provider data used to be discarded after each search — only the single winning
 * provider survived as a flat snapshot on the ticket. This module persists every
 * provider we discover into a `maintenanceProviders` collection keyed by Google
 * `placeId`, accumulating AI review analysis and HouseYield-specific outcome stats so
 * the network map and the provider quality dataset can compound over time.
 */

import crypto from 'crypto';
import { getFirestore } from '../firebase-admin.js';

const PROVIDERS_COLLECTION = 'maintenanceProviders';
const SERVICE_RECORDS_COLLECTION = 'serviceRecords';

function db() {
  return getFirestore();
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stable id for providers Google did not give us a placeId for. */
function deriveProviderId(provider) {
  if (provider?.placeId) return `place_${provider.placeId}`;

  const seed = [provider?.name, provider?.phone, provider?.address]
    .map((part) => String(part || '').trim().toLowerCase())
    .join('|');

  if (!seed.replace(/\|/g, '')) return '';

  return `prov_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

function normalizeAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;

  return {
    overallScore: toNumberOrNull(analysis.overallScore),
    recommendationLevel: String(analysis.recommendationLevel || ''),
    expertiseMatch: analysis.expertiseMatch ?? null,
    responsiveness: analysis.responsiveness ?? null,
    qualityOfWork: analysis.qualityOfWork ?? null,
    professionalism: analysis.professionalism ?? null,
    pricingFairness: analysis.pricingFairness ?? null,
    strengths: Array.isArray(analysis.strengths) ? analysis.strengths.slice(0, 6).map(String) : [],
    redFlags: Array.isArray(analysis.redFlags) ? analysis.redFlags.slice(0, 6).map(String) : [],
    summary: String(analysis.summary || ''),
    suggestedQuestions: Array.isArray(analysis.suggestedQuestions)
      ? analysis.suggestedQuestions.slice(0, 6).map(String)
      : [],
    analyzedAt: analysis.analyzedAt || new Date().toISOString(),
  };
}

function buildDefaultNetworkStats() {
  return {
    jobsCompleted: 0,
    totalSpend: 0,
    avgCost: null,
    avgResponseHours: null,
    repeatIssueCount: 0,
    repeatIssueRate: null,
    firstVisitResolutionRate: null,
    ratingSum: 0,
    ratingCount: 0,
    avgOwnerRating: null,
    lastUsedAt: null,
  };
}

/**
 * Upsert a batch of providers discovered during a search. Existing documents keep
 * their accumulated HouseYield stats; only the directory fields and AI analysis
 * refresh.
 */
export async function upsertProvidersFromSearch({
  providers = [],
  category = '',
  serviceType = '',
  propertyAddress = '',
} = {}) {
  if (!Array.isArray(providers) || !providers.length) {
    return { ok: true, saved: 0, providerIds: [] };
  }

  try {
    const firestore = db();
    const batch = firestore.batch();
    const now = new Date().toISOString();
    const providerIds = [];

    for (const provider of providers) {
      const providerId = deriveProviderId(provider);
      if (!providerId || !provider?.name) continue;

      const docRef = firestore.collection(PROVIDERS_COLLECTION).doc(providerId);
      const existing = await docRef.get().catch(() => null);
      const existingData = existing?.exists ? existing.data() || {} : {};

      const categories = new Set(
        Array.isArray(existingData.categories) ? existingData.categories.filter(Boolean) : [],
      );
      if (category) categories.add(category);
      if (serviceType) categories.add(serviceType);

      const servedAddresses = new Set(
        Array.isArray(existingData.servedAddresses) ? existingData.servedAddresses.filter(Boolean) : [],
      );
      if (propertyAddress) servedAddresses.add(propertyAddress);

      const record = {
        id: providerId,
        placeId: provider.placeId || existingData.placeId || '',
        name: provider.name,
        phone: provider.phone || existingData.phone || '',
        address: provider.address || existingData.address || '',
        website: provider.website || existingData.website || '',
        googleMapsUrl: provider.googleMapsUrl || existingData.googleMapsUrl || '',
        lat: toNumberOrNull(provider.lat) ?? toNumberOrNull(existingData.lat),
        lng: toNumberOrNull(provider.lng) ?? toNumberOrNull(existingData.lng),
        rating: toNumberOrNull(provider.rating) ?? toNumberOrNull(existingData.rating),
        reviewCount: toNumberOrNull(provider.reviewCount) ?? toNumberOrNull(existingData.reviewCount),
        aiScore: toNumberOrNull(provider.aiScore)
          ?? toNumberOrNull(provider.reviewAnalysis?.overallScore)
          ?? toNumberOrNull(existingData.aiScore),
        aiAnalysis: normalizeAnalysis(provider.reviewAnalysis) || existingData.aiAnalysis || null,
        categories: [...categories],
        servedAddresses: [...servedAddresses].slice(-25),
        status: existingData.status || 'network',
        networkStats: existingData.networkStats || buildDefaultNetworkStats(),
        timesShortlisted: (toNumberOrNull(existingData.timesShortlisted) || 0) + 1,
        firstSeenAt: existingData.firstSeenAt || now,
        updatedAt: now,
      };

      batch.set(docRef, record, { merge: true });
      providerIds.push(providerId);
    }

    if (!providerIds.length) {
      return { ok: true, saved: 0, providerIds: [] };
    }

    await batch.commit();
    return { ok: true, saved: providerIds.length, providerIds };
  } catch (error) {
    console.error('[ProviderNetwork] Upsert failed:', error.message);
    return { ok: false, error: error.message, saved: 0, providerIds: [] };
  }
}

/**
 * Adds coordinates discovered after the original provider record was saved.
 * Kept deliberately narrow so a map backfill cannot overwrite ranking, review
 * analysis, or accumulated provider statistics.
 */
export async function updateProviderCoordinates(providerId, { lat, lng } = {}) {
  const normalizedLat = toNumberOrNull(lat);
  const normalizedLng = toNumberOrNull(lng);

  if (!providerId || normalizedLat === null || normalizedLng === null) {
    return { ok: false, error: 'Provider id and both coordinates are required' };
  }

  try {
    await db().collection(PROVIDERS_COLLECTION).doc(providerId).set({
      lat: normalizedLat,
      lng: normalizedLng,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return { ok: true };
  } catch (error) {
    console.error('[ProviderNetwork] Coordinate update failed:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * List the provider network, optionally narrowed to a category and to providers
 * within `radiusMiles` of a point (so the map can scope to one property).
 */
export async function listProviders({
  category = null,
  status = null,
  lat = null,
  lng = null,
  radiusMiles = null,
  limit = 200,
} = {}) {
  try {
    const snapshot = await db().collection(PROVIDERS_COLLECTION).get();
    let providers = [];
    snapshot.forEach((doc) => providers.push({ id: doc.id, ...doc.data() }));

    if (category) {
      const wanted = String(category).toLowerCase();
      providers = providers.filter((provider) => (
        (provider.categories || []).some((entry) => String(entry).toLowerCase() === wanted)
      ));
    }

    if (status) {
      providers = providers.filter((provider) => provider.status === status);
    }

    const originLat = toNumberOrNull(lat);
    const originLng = toNumberOrNull(lng);
    const radius = toNumberOrNull(radiusMiles);

    if (originLat !== null && originLng !== null) {
      providers = providers
        .map((provider) => ({
          ...provider,
          distanceMiles: haversineMiles(originLat, originLng, provider.lat, provider.lng),
        }))
        .filter((provider) => (
          radius === null || provider.distanceMiles === null || provider.distanceMiles <= radius
        ))
        .sort((a, b) => {
          if (a.distanceMiles === null) return 1;
          if (b.distanceMiles === null) return -1;
          return a.distanceMiles - b.distanceMiles;
        });
    } else {
      providers.sort((a, b) => (Number(b.aiScore) || 0) - (Number(a.aiScore) || 0));
    }

    const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 200;

    return { ok: true, providers: providers.slice(0, cap), total: providers.length };
  } catch (error) {
    console.error('[ProviderNetwork] List failed:', error.message);
    return { ok: false, error: error.message, providers: [] };
  }
}

export function haversineMiles(lat1, lng1, lat2, lng2) {
  const a = toNumberOrNull(lat1);
  const b = toNumberOrNull(lng1);
  const c = toNumberOrNull(lat2);
  const d = toNumberOrNull(lng2);
  if (a === null || b === null || c === null || d === null) return null;

  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;

  const dLat = toRad(c - a);
  const dLng = toRad(d - b);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * earthRadiusMiles * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/**
 * Record a completed job against a provider and roll their network stats forward.
 * Also writes a flat `serviceRecords` document for per-property and per-provider
 * analytics that does not require loading every ticket.
 */
export async function recordProviderJob({
  requestId,
  ownerId = '',
  propertyId = '',
  propertyAddress = '',
  category = '',
  serviceType = '',
  provider = null,
  serviceRecord = null,
  outcome = null,
  reportedAt = null,
} = {}) {
  if (!requestId || !serviceRecord) {
    return { ok: false, error: 'requestId and serviceRecord are required' };
  }

  const firestore = db();
  const now = new Date().toISOString();
  const providerId = serviceRecord.providerId || deriveProviderId(provider || { name: serviceRecord.providerName });

  try {
    // Flat analytics record, one per completed visit.
    await firestore.collection(SERVICE_RECORDS_COLLECTION).doc(requestId).set({
      requestId,
      ownerId,
      propertyId,
      propertyAddress,
      category,
      serviceType,
      providerId,
      providerName: serviceRecord.providerName || provider?.name || '',
      completedAt: serviceRecord.completedAt || now,
      diagnosis: serviceRecord.diagnosis || '',
      workPerformed: serviceRecord.workPerformed || '',
      parts: serviceRecord.parts || [],
      labor: serviceRecord.labor || null,
      totals: serviceRecord.totals || null,
      warranty: serviceRecord.warranty || null,
      outcome: outcome || null,
      reportedAt: reportedAt || null,
      responseHours: computeResponseHours(reportedAt, serviceRecord.completedAt || now),
      updatedAt: now,
    }, { merge: true });

    if (!providerId) {
      return { ok: true, providerId: '', networkStats: null };
    }

    // Recompute stats from all of this provider's records so repeated writes for the
    // same ticket cannot double-count.
    const recordsSnapshot = await firestore
      .collection(SERVICE_RECORDS_COLLECTION)
      .where('providerId', '==', providerId)
      .get();

    const stats = buildDefaultNetworkStats();
    let responseHoursSum = 0;
    let responseHoursCount = 0;
    let firstVisitResolvedCount = 0;
    let firstVisitKnownCount = 0;

    recordsSnapshot.forEach((doc) => {
      const data = doc.data() || {};
      stats.jobsCompleted += 1;

      const total = toNumberOrNull(data.totals?.total);
      if (total !== null) stats.totalSpend += total;

      const responseHours = toNumberOrNull(data.responseHours);
      if (responseHours !== null) {
        responseHoursSum += responseHours;
        responseHoursCount += 1;
      }

      if (data.outcome?.repeatIssue) stats.repeatIssueCount += 1;

      if (data.outcome?.resolvedFirstVisit !== null && data.outcome?.resolvedFirstVisit !== undefined) {
        firstVisitKnownCount += 1;
        if (data.outcome.resolvedFirstVisit) firstVisitResolvedCount += 1;
      }

      const rating = toNumberOrNull(data.outcome?.ownerRating);
      if (rating !== null) {
        stats.ratingSum += rating;
        stats.ratingCount += 1;
      }

      if (!stats.lastUsedAt || String(data.completedAt || '') > stats.lastUsedAt) {
        stats.lastUsedAt = data.completedAt || stats.lastUsedAt;
      }
    });

    const round = (value) => Math.round(value * 10) / 10;

    stats.totalSpend = Math.round(stats.totalSpend * 100) / 100;
    stats.avgCost = stats.jobsCompleted ? Math.round((stats.totalSpend / stats.jobsCompleted) * 100) / 100 : null;
    stats.avgResponseHours = responseHoursCount ? round(responseHoursSum / responseHoursCount) : null;
    stats.repeatIssueRate = stats.jobsCompleted ? round((stats.repeatIssueCount / stats.jobsCompleted) * 100) : null;
    stats.firstVisitResolutionRate = firstVisitKnownCount
      ? round((firstVisitResolvedCount / firstVisitKnownCount) * 100)
      : null;
    stats.avgOwnerRating = stats.ratingCount ? round(stats.ratingSum / stats.ratingCount) : null;

    await firestore.collection(PROVIDERS_COLLECTION).doc(providerId).set({
      id: providerId,
      name: serviceRecord.providerName || provider?.name || '',
      networkStats: stats,
      status: 'network',
      updatedAt: now,
    }, { merge: true });

    return { ok: true, providerId, networkStats: stats };
  } catch (error) {
    console.error('[ProviderNetwork] recordProviderJob failed:', error.message);
    return { ok: false, error: error.message };
  }
}

function computeResponseHours(reportedAt, completedAt) {
  if (!reportedAt || !completedAt) return null;
  const start = new Date(reportedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round(((end - start) / 3600000) * 10) / 10;
}

/** Per-property maintenance history, for the property-level data layer. */
export async function getPropertyServiceHistory(propertyId, { limit = 100 } = {}) {
  if (!propertyId) return { ok: false, error: 'propertyId is required', records: [] };

  try {
    const snapshot = await db()
      .collection(SERVICE_RECORDS_COLLECTION)
      .where('propertyId', '==', propertyId)
      .get();

    const records = [];
    snapshot.forEach((doc) => records.push({ id: doc.id, ...doc.data() }));
    records.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));

    const totalSpend = records.reduce((sum, record) => sum + (toNumberOrNull(record.totals?.total) || 0), 0);

    return {
      ok: true,
      records: records.slice(0, limit),
      summary: {
        visits: records.length,
        totalSpend: Math.round(totalSpend * 100) / 100,
        categories: [...new Set(records.map((record) => record.category).filter(Boolean))],
      },
    };
  } catch (error) {
    console.error('[ProviderNetwork] getPropertyServiceHistory failed:', error.message);
    return { ok: false, error: error.message, records: [] };
  }
}

export { PROVIDERS_COLLECTION, SERVICE_RECORDS_COLLECTION, deriveProviderId, buildDefaultNetworkStats };
