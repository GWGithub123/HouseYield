import {
  getAdditionalMacroData,
  getHousingMarketData,
  getRegionalMarketData,
  getTreasuryYields,
} from '../fred.js';
import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';
import { getIotFirestore } from '../iot-cloud-firestore.js';
import { getEconomicPredictions, getHousingMarketPredictions } from '../polymarket-simple.js';
import {
  ASSISTANT_EXPLICIT_USER_COLLECTIONS,
  ASSISTANT_USER_SCOPE_FIELDS,
  listAssistantAccessibleCollectionIds,
  shouldSkipAssistantDiscoveryCollection,
} from './assistantAccountScopeService.js';
import { mapAssistantSensorDevice } from './assistantSensorInventoryService.js';

initializeFirebaseAdmin();

const db = getFirestore();
const IOT_COLLECTIONS = new Set(['shelly_devices', 'alerts', 'sensor_readings']);

function collectionDb(collectionName) {
  return IOT_COLLECTIONS.has(collectionName) ? getIotFirestore() : db;
}
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || process.env.VITE_POLYGON_API_KEY || '';
const DEFAULT_SAMPLE_LIMIT = 5;
const USER_SUBCOLLECTION_LIMIT = 6;
const BOOKKEEPING_SUBCOLLECTION_LIMIT = 6;
const TOP_HOLDINGS_LIMIT = 6;
const TOP_HEADLINE_LIMIT = 6;
const DISCOVERED_COLLECTION_SAMPLE_LIMIT = 3;
const DISCOVERED_COLLECTION_INVENTORY_LIMIT = 24;
const GLOBAL_MARKET_CONTEXT_TTL_MS = 5 * 60 * 1000;

let cachedGlobalMarketContext = {
  expiresAt: 0,
  value: null,
};

const USER_LINKED_COLLECTIONS = ASSISTANT_EXPLICIT_USER_COLLECTIONS;
const DISCOVERED_LINK_FIELDS = ASSISTANT_USER_SCOPE_FIELDS;

const IGNORED_USER_DOC_FIELDS = new Set([
  'assistantMemory',
  'recentExchanges',
  'recentSessions',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clipText(value, maxLength = 140) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? clipText(value, 40) : parsed.toISOString();
  }

  if (typeof value?.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }

  if (typeof value === 'object' && typeof value.seconds === 'number') {
    const parsed = new Date(value.seconds * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return null;
}

function serializeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return clipText(value, depth === 0 ? 220 : 120);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  const isoValue = toIsoString(value);
  if (isoValue) {
    return isoValue;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => serializeValue(item, depth + 1));
  }

  if (!isPlainObject(value) || depth >= 2) {
    return clipText(JSON.stringify(value), 160);
  }

  const entries = Object.entries(value)
    .slice(0, 16)
    .map(([key, entryValue]) => [key, serializeValue(entryValue, depth + 1)]);

  return Object.fromEntries(entries);
}

function safeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function formatMoney(value) {
  const numeric = safeNumber(value);
  if (numeric === null) {
    return null;
  }

  return `$${Math.round(numeric).toLocaleString()}`;
}

function formatProbability(value) {
  const numeric = safeNumber(value);
  if (numeric === null) {
    return null;
  }

  const normalized = numeric > 1 ? numeric : numeric * 100;
  return `${normalized.toFixed(normalized >= 10 ? 0 : 1)}%`;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (entryValue === null || entryValue === undefined || entryValue === '') {
        return false;
      }

      if (Array.isArray(entryValue) && entryValue.length === 0) {
        return false;
      }

      if (isPlainObject(entryValue) && Object.keys(entryValue).length === 0) {
        return false;
      }

      return true;
    }),
  );
}

function firstStringArray(...candidates) {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const strings = candidate
      .map((item) => clipText(item, 90))
      .filter(Boolean);

    if (strings.length > 0) {
      return strings;
    }
  }

  return [];
}

function formatSummaryValue(value, includeSensitive = true) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return clipText(value, 90);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const isoValue = toIsoString(value);
  if (isoValue) {
    return isoValue;
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) {
      const preview = value
        .slice(0, 3)
        .map((item) => clipText(item, 40))
        .filter(Boolean);
      return preview.length > 0 ? preview.join(', ') : `${value.length} items`;
    }

    return `${value.length} items`;
  }

  if (!isPlainObject(value)) {
    return clipText(String(value), 80);
  }

  if (!includeSensitive) {
    return `${Object.keys(value).length} fields`;
  }

  if (typeof value.name === 'string') {
    return clipText(value.name, 60);
  }

  if (typeof value.title === 'string') {
    return clipText(value.title, 60);
  }

  if (typeof value.label === 'string') {
    return clipText(value.label, 60);
  }

  return Object.keys(value).slice(0, 5).join(', ');
}

function summarizeGenericRecord(data, includeSensitive = true) {
  const summaryKeys = [
    'name',
    'title',
    'label',
    'status',
    'type',
    'category',
    'address',
    'city',
    'state',
    'propertyId',
    'ownerId',
    'tenantId',
    'vendorName',
    'company',
    'updatedAt',
    'createdAt',
    'date',
    'dueDate',
    'source',
  ];

  if (includeSensitive) {
    summaryKeys.push('amount', 'balance', 'value', 'monthlyRent', 'netWorth');
  }

  const summary = {};
  for (const key of summaryKeys) {
    if (!(key in data)) {
      continue;
    }

    if (!includeSensitive && ['amount', 'balance', 'value', 'monthlyRent', 'netWorth'].includes(key)) {
      continue;
    }

    const formattedValue = formatSummaryValue(data[key], includeSensitive);
    if (formattedValue !== null && formattedValue !== undefined && formattedValue !== '') {
      summary[key] = formattedValue;
    }
  }

  if (Object.keys(summary).length === 0) {
    summary.keys = Object.keys(data).slice(0, 8);
  }

  return summary;
}

function summarizePropertyRecord(data, includeSensitive = true) {
  const financials = isPlainObject(data.financials) ? data.financials : {};
  const propertyData = isPlainObject(data.propertyData) ? data.propertyData : {};
  const estimatedValue = safeNumber(
    financials.value
      ?? financials.marketValue
      ?? propertyData.marketValue
      ?? propertyData.avm?.amount?.value
      ?? propertyData.estimatedValue,
  );

  return compactObject({
    address: includeSensitive ? clipText(data.address, 120) : undefined,
    propertyId: data.id || null,
    tenantCount: Array.isArray(data.tenantIds) ? data.tenantIds.length : (data.tenantId ? 1 : 0),
    updatedAt: toIsoString(data.updatedAt),
    estimatedValue: includeSensitive ? estimatedValue : undefined,
    monthlyRent: includeSensitive ? safeNumber(financials.monthlyRent ?? financials.rent ?? financials.currentRent) : undefined,
  });
}

function summarizeTenantRecord(data, includeSensitive = true) {
  return compactObject({
    name: includeSensitive ? clipText(data.name || data.fullName, 90) : undefined,
    status: clipText(data.status || data.leaseStatus, 40),
    propertyId: includeSensitive ? (data.propertyId || null) : undefined,
    monthlyRent: includeSensitive ? safeNumber(data.monthlyRent ?? data.rent) : undefined,
    updatedAt: toIsoString(data.updatedAt || data.createdAt),
  });
}

function summarizeShellyDeviceRecord(data, includeSensitive = true) {
  const mapped = mapAssistantSensorDevice({ id: data.id, data: () => data });
  return compactObject({
    name: mapped.name,
    type: mapped.kindLabel,
    status: mapped.status,
    reading: includeSensitive ? mapped.readingLabel : undefined,
    temperatureF: includeSensitive ? mapped.temperatureF : undefined,
    humidityPercent: includeSensitive ? mapped.humidityPercent : undefined,
    valveState: includeSensitive ? mapped.valveState : undefined,
    flooded: mapped.flooded || undefined,
    propertyId: includeSensitive ? mapped.propertyId : undefined,
    lastSeen: mapped.lastSeen,
  });
}

function summarizeAlertRecord(data, includeSensitive = true) {
  return compactObject({
    type: clipText(data.alertType || data.type, 40),
    severity: clipText(data.severity, 30),
    message: clipText(data.message, 120),
    acknowledged: Boolean(data.acknowledged),
    propertyId: includeSensitive ? (data.propertyId || null) : undefined,
    timestamp: toIsoString(data.timestamp || data.createdAt),
  });
}

const COLLECTION_SUMMARIZERS = {
  properties: summarizePropertyRecord,
  tenants: summarizeTenantRecord,
  shelly_devices: summarizeShellyDeviceRecord,
  alerts: summarizeAlertRecord,
};

async function getQueryCount(queryRef, sampleLimit = DEFAULT_SAMPLE_LIMIT) {
  try {
    if (typeof queryRef.count === 'function') {
      const snapshot = await queryRef.count().get();
      const count = snapshot?.data?.().count;
      if (typeof count === 'number') {
        return count;
      }
    }
  } catch {
    // Fall through to sample-size fallback.
  }

  const snapshot = await queryRef.limit(sampleLimit + 1).get();
  return snapshot.size > sampleLimit ? `${sampleLimit}+` : snapshot.size;
}

async function loadQuerySummary({ queryRef, collectionName, sampleLimit = DEFAULT_SAMPLE_LIMIT, includeSensitive = true }) {
  const summarizer = COLLECTION_SUMMARIZERS[collectionName] || summarizeGenericRecord;
  const [sampleSnapshot, count] = await Promise.all([
    queryRef.limit(sampleLimit).get(),
    getQueryCount(queryRef, sampleLimit),
  ]);

  return {
    count,
    samples: sampleSnapshot.docs.map((docSnapshot) => {
      const data = serializeValue(docSnapshot.data());
      return summarizer({ id: docSnapshot.id, ...data }, includeSensitive);
    }),
  };
}

async function summarizeUserLinkedCollection(spec, userId, includeSensitive) {
  let lastError = null;
  const sourceDb = collectionDb(spec.id);

  for (const field of spec.fields) {
    try {
      const summary = await loadQuerySummary({
        queryRef: sourceDb.collection(spec.id).where(field, '==', userId),
        collectionName: spec.id,
        sampleLimit: spec.sampleLimit,
        includeSensitive,
      });

      if (summary.count !== 0 || summary.samples.length > 0) {
        return {
          ok: true,
          collection: spec.id,
          linkField: field,
          source: IOT_COLLECTIONS.has(spec.id) ? 'iot' : 'main',
          ...summary,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    return {
      ok: false,
      collection: spec.id,
      count: 0,
      samples: [],
      error: lastError.message,
    };
  }

  return {
    ok: true,
    collection: spec.id,
    count: 0,
    samples: [],
  };
}

async function summarizeUserDocument(userId, includeSensitive) {
  const snapshot = await db.collection('users').doc(userId).get();
  if (!snapshot.exists) {
    return {
      ok: true,
      exists: false,
      profile: {},
      trackedMarkets: [],
      fieldNames: [],
      sample: {},
    };
  }

  const data = serializeValue(snapshot.data());
  const trackedMarkets = firstStringArray(
    data.targetMarkets,
    data.markets,
    data.savedMarkets,
    data.realEstateSearchMemory,
  ).slice(0, 5);

  const profile = compactObject({
    name: clipText(data.displayName || data.name || data.fullName || data.firstName, 90),
    role: clipText(data.role || data.userType, 40),
    plan: clipText(data.subscription?.plan || data.plan || data.subscriptionPlan, 40),
    city: clipText(data.city || data.location?.city, 60),
    state: clipText(data.state || data.location?.state, 20),
    propertyAddressCount: Array.isArray(data.properties) ? data.properties.length : undefined,
    savedPropertyCount: Array.isArray(data.savedProperties) ? data.savedProperties.length : undefined,
  });

  const sample = compactObject({
    preferences: Array.isArray(data.preferences) ? data.preferences.length : undefined,
    workflows: Array.isArray(data.favoriteWorkflows) ? data.favoriteWorkflows.length : undefined,
    goals: Array.isArray(data.recurringGoals) ? data.recurringGoals.length : undefined,
    riskProfile: clipText(data.riskProfile, 40),
    subscriptionStatus: clipText(data.subscription?.status || data.subscriptionStatus, 30),
    cashReserveTarget: includeSensitive ? safeNumber(data.cashReserveTarget) : undefined,
  });

  return {
    ok: true,
    exists: true,
    profile,
    trackedMarkets,
    fieldNames: Object.keys(data)
      .filter((fieldName) => !IGNORED_USER_DOC_FIELDS.has(fieldName))
      .slice(0, 24),
    sample,
  };
}

async function summarizePortfolio(userId, includeSensitive) {
  try {
    const portfolioRef = db.collection('portfolios').doc(userId);
    const [assetsSnapshot, liabilitiesSnapshot, snapshotsSnapshot] = await Promise.all([
      portfolioRef.collection('assets').limit(250).get(),
      portfolioRef.collection('liabilities').limit(250).get(),
      portfolioRef.collection('snapshots').limit(40).get(),
    ]);

    const assets = assetsSnapshot.docs.map((docSnapshot) => ({
      id: docSnapshot.id,
      ...serializeValue(docSnapshot.data()),
    }));
    const liabilities = liabilitiesSnapshot.docs.map((docSnapshot) => ({
      id: docSnapshot.id,
      ...serializeValue(docSnapshot.data()),
    }));
    const snapshots = snapshotsSnapshot.docs.map((docSnapshot) => ({
      id: docSnapshot.id,
      ...serializeValue(docSnapshot.data()),
    }));

    const assetGroups = ['realEstate', 'stocks', 'cash', 'bonds', 'alternatives']
      .map((type) => {
        const groupAssets = assets.filter((asset) => asset.type === type);
        const totalValue = groupAssets.reduce((sum, asset) => sum + (safeNumber(asset.value) || 0), 0);
        return {
          key: type,
          label: type,
          count: groupAssets.length,
          totalValue,
        };
      })
      .filter((group) => group.count > 0);

    const topAssets = assets
      .slice()
      .sort((left, right) => (safeNumber(right.value) || 0) - (safeNumber(left.value) || 0))
      .slice(0, TOP_HOLDINGS_LIMIT)
      .map((asset) => compactObject({
        type: asset.type || null,
        label: clipText(asset.name || asset.displayName || asset.companyName || asset.address || asset.ticker || asset.id, 90),
        ticker: asset.ticker || null,
        value: includeSensitive ? safeNumber(asset.value) : undefined,
      }));

    const totalLiabilities = liabilities.reduce((sum, liability) => sum + (safeNumber(liability.balance) || 0), 0);
    const latestSnapshot = snapshots
      .slice()
      .sort((left, right) => {
        const leftDate = new Date(left.date || left.createdAt || 0).getTime();
        const rightDate = new Date(right.date || right.createdAt || 0).getTime();
        return rightDate - leftDate;
      })[0] || null;

    return {
      ok: true,
      assetCount: assets.length,
      liabilityCount: liabilities.length,
      totalLiabilities: includeSensitive ? totalLiabilities : undefined,
      assetGroups,
      topAssets,
      latestSnapshot: latestSnapshot
        ? compactObject({
            date: latestSnapshot.date || latestSnapshot.createdAt || null,
            totalValue: includeSensitive ? safeNumber(latestSnapshot.totalValue) : undefined,
            netWorth: includeSensitive ? safeNumber(latestSnapshot.netWorth) : undefined,
          })
        : null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      assetCount: 0,
      liabilityCount: 0,
      assetGroups: [],
      topAssets: [],
      latestSnapshot: null,
    };
  }
}

async function summarizeUserSubcollections(userId, includeSensitive) {
  try {
    const collections = await db.collection('users').doc(userId).listCollections();
    const visibleCollections = collections.filter((collectionRef) => collectionRef.id !== 'bookkeeping');
    const summaries = await Promise.all(
      visibleCollections.slice(0, USER_SUBCOLLECTION_LIMIT).map(async (collectionRef) => {
        const summary = await loadQuerySummary({
          queryRef: collectionRef,
          collectionName: collectionRef.id,
          includeSensitive,
        });

        return {
          id: collectionRef.id,
          ...summary,
        };
      }),
    );

    return {
      ok: true,
      collectionCount: visibleCollections.length,
      collections: summaries,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      collectionCount: 0,
      collections: [],
    };
  }
}

function shouldSkipDiscoveredCollection(collectionId) {
  return shouldSkipAssistantDiscoveryCollection(collectionId, USER_LINKED_COLLECTIONS);
}

async function summarizeDiscoveredLinkedCollections(userId, includeSensitive) {
  try {
    const collectionRefs = await db.listCollections();
    const accessibleInventory = await listAssistantAccessibleCollectionIds(userId, {
      limit: DISCOVERED_COLLECTION_INVENTORY_LIMIT,
    });
    const candidateCollections = collectionRefs
      .filter((collectionRef) => !shouldSkipDiscoveredCollection(collectionRef.id))
      .sort((left, right) => left.id.localeCompare(right.id));

    const collections = [];

    for (const collectionRef of candidateCollections) {
      let summary = null;

      try {
        const directSnapshot = await collectionRef.doc(userId).get();
        if (directSnapshot.exists) {
          const data = serializeValue(directSnapshot.data());
          const summarizer = COLLECTION_SUMMARIZERS[collectionRef.id] || summarizeGenericRecord;
          summary = {
            ok: true,
            collection: collectionRef.id,
            linkField: 'documentId',
            count: 1,
            samples: [summarizer({ id: directSnapshot.id, ...data }, includeSensitive)],
          };
        }
      } catch {
        // Ignore direct document probe failures and fall through to field-based discovery.
      }

      if (!summary) {
        for (const linkSpec of DISCOVERED_LINK_FIELDS) {
          try {
            const querySummary = await loadQuerySummary({
              queryRef: collectionRef.where(linkSpec.field, linkSpec.operator, userId),
              collectionName: collectionRef.id,
              sampleLimit: DISCOVERED_COLLECTION_SAMPLE_LIMIT,
              includeSensitive,
            });

            if (querySummary.count !== 0 || querySummary.samples.length > 0) {
              summary = {
                ok: true,
                collection: collectionRef.id,
                linkField: linkSpec.field,
                operator: linkSpec.operator,
                ...querySummary,
              };
              break;
            }
          } catch {
            // Ignore unsupported or non-indexed probes and continue discovery.
          }
        }
      }

      if (summary) {
        collections.push(summary);
      }
    }

    return {
      ok: true,
      totalTopLevelCollections: accessibleInventory.totalMatchedCollections,
      scannedCollectionCount: candidateCollections.length,
      matchedCollectionCount: collections.length,
      inventory: accessibleInventory.collections,
      inventoryTruncated: accessibleInventory.truncated,
      collections,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      totalTopLevelCollections: 0,
      scannedCollectionCount: 0,
      matchedCollectionCount: 0,
      inventory: [],
      inventoryTruncated: false,
      collections: [],
    };
  }
}

async function summarizeBookkeepingData(userId, includeSensitive) {
  try {
    const bookkeepingDataRef = db.doc(`users/${userId}/bookkeeping/data`);
    const subcollections = await bookkeepingDataRef.listCollections();
    const summaries = await Promise.all(
      subcollections.slice(0, BOOKKEEPING_SUBCOLLECTION_LIMIT).map(async (collectionRef) => {
        const summary = await loadQuerySummary({
          queryRef: collectionRef,
          collectionName: collectionRef.id,
          includeSensitive,
        });

        return {
          id: collectionRef.id,
          ...summary,
        };
      }),
    );

    return {
      ok: true,
      subcollectionCount: subcollections.length,
      subcollections: summaries,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      subcollectionCount: 0,
      subcollections: [],
    };
  }
}

function dedupeHeadlines(items, limit = TOP_HEADLINE_LIMIT) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const normalizedTitle = clipText(item?.title, 160).toLowerCase();
    if (!normalizedTitle || seen.has(normalizedTitle)) {
      continue;
    }

    seen.add(normalizedTitle);
    deduped.push(item);
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

async function fetchPolygonMarketHeadlines() {
  if (!POLYGON_API_KEY) {
    return [];
  }

  const targets = [
    { topic: 'Macro', ticker: 'SPY' },
    { topic: 'Rates', ticker: 'TLT' },
    { topic: 'Mortgages', ticker: 'MBB' },
    { topic: 'Housing', ticker: 'XHB' },
    { topic: 'Real Estate', ticker: 'VNQ' },
    { topic: 'Banks', ticker: 'KRE' },
  ];

  const responses = await Promise.allSettled(
    targets.map(async ({ topic, ticker }) => {
      const url = `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(ticker)}&limit=2&order=desc&sort=published_utc&apiKey=${POLYGON_API_KEY}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HouseYield/1.0' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`polygon_news_failed:${ticker}`);
      }

      const payload = await response.json();
      const item = Array.isArray(payload?.results) ? payload.results[0] : null;
      if (!item?.title) {
        return null;
      }

      return {
        topic,
        ticker,
        title: clipText(item.title, 160),
        publisher: clipText(item.publisher?.name || 'Polygon', 60),
        publishedUtc: item.published_utc || null,
      };
    }),
  );

  return dedupeHeadlines(
    responses
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value),
  );
}

async function loadGlobalMarketContext() {
  if (cachedGlobalMarketContext.value && cachedGlobalMarketContext.expiresAt > Date.now()) {
    return cachedGlobalMarketContext.value;
  }

  const [housingResult, regionalResult, treasuryResult, macroResult, polymarketPredictionsResult, polymarketEconomicResult, headlinesResult] = await Promise.allSettled([
    getHousingMarketData(),
    getRegionalMarketData(),
    getTreasuryYields({ days: 365 }),
    getAdditionalMacroData(),
    getHousingMarketPredictions(),
    getEconomicPredictions(),
    fetchPolygonMarketHeadlines(),
  ]);

  const sourceStatus = {
    housing: housingResult.status === 'fulfilled' && housingResult.value?.ok !== false
      ? { ok: true }
      : { ok: false, error: housingResult.status === 'fulfilled' ? (housingResult.value?.error || 'housing_context_unavailable') : (housingResult.reason?.message || 'housing_context_unavailable') },
    regional: regionalResult.status === 'fulfilled' && regionalResult.value?.ok !== false
      ? { ok: true, metros: Array.isArray(regionalResult.value?.metros) ? regionalResult.value.metros.length : 0 }
      : { ok: false, error: regionalResult.status === 'fulfilled' ? (regionalResult.value?.error || 'regional_market_context_unavailable') : (regionalResult.reason?.message || 'regional_market_context_unavailable') },
    treasury: treasuryResult.status === 'fulfilled' && treasuryResult.value?.ok !== false
      ? { ok: true, trend: treasuryResult.value?.summary?.trend || null }
      : { ok: false, error: treasuryResult.status === 'fulfilled' ? (treasuryResult.value?.error || 'treasury_context_unavailable') : (treasuryResult.reason?.message || 'treasury_context_unavailable') },
    macro: macroResult.status === 'fulfilled' && macroResult.value?.ok !== false
      ? { ok: true }
      : { ok: false, error: macroResult.status === 'fulfilled' ? (macroResult.value?.error || 'macro_context_unavailable') : (macroResult.reason?.message || 'macro_context_unavailable') },
    polymarketPredictions: polymarketPredictionsResult.status === 'fulfilled' && polymarketPredictionsResult.value?.ok !== false
      ? { ok: true, markets: Array.isArray(polymarketPredictionsResult.value?.predictions?.markets) ? polymarketPredictionsResult.value.predictions.markets.length : 0 }
      : { ok: false, error: polymarketPredictionsResult.status === 'fulfilled' ? (polymarketPredictionsResult.value?.error || 'polymarket_predictions_unavailable') : (polymarketPredictionsResult.reason?.message || 'polymarket_predictions_unavailable') },
    polymarketEconomic: polymarketEconomicResult.status === 'fulfilled' && polymarketEconomicResult.value?.ok !== false
      ? { ok: true, total: polymarketEconomicResult.value?.total || 0 }
      : { ok: false, error: polymarketEconomicResult.status === 'fulfilled' ? (polymarketEconomicResult.value?.error || 'polymarket_economic_unavailable') : (polymarketEconomicResult.reason?.message || 'polymarket_economic_unavailable') },
    headlines: headlinesResult.status === 'fulfilled'
      ? { ok: true, count: headlinesResult.value.length }
      : { ok: false, error: headlinesResult.reason?.message || 'market_headlines_unavailable' },
  };

  const summary = {
    ok: Object.values(sourceStatus).some((status) => status.ok),
    housing: housingResult.status === 'fulfilled' ? housingResult.value : null,
    regional: regionalResult.status === 'fulfilled' ? regionalResult.value : null,
    treasury: treasuryResult.status === 'fulfilled' ? treasuryResult.value : null,
    macro: macroResult.status === 'fulfilled' ? macroResult.value : null,
    polymarketPredictions: polymarketPredictionsResult.status === 'fulfilled' ? polymarketPredictionsResult.value : null,
    polymarketEconomic: polymarketEconomicResult.status === 'fulfilled' ? polymarketEconomicResult.value : null,
    headlines: headlinesResult.status === 'fulfilled' ? headlinesResult.value : [],
    sourceStatus,
  };

  cachedGlobalMarketContext = {
    value: summary,
    expiresAt: Date.now() + GLOBAL_MARKET_CONTEXT_TTL_MS,
  };

  return summary;
}

function buildAccountPromptLines(userSummary) {
  const lines = ['ACCOUNT PROFILE:'];

  if (!userSummary.exists) {
    lines.push('- No users/{uid} profile document was found.');
    return lines;
  }

  const profileParts = [];
  if (userSummary.profile.name) {
    profileParts.push(`name ${userSummary.profile.name}`);
  }
  if (userSummary.profile.role) {
    profileParts.push(`role ${userSummary.profile.role}`);
  }
  if (userSummary.profile.plan) {
    profileParts.push(`plan ${userSummary.profile.plan}`);
  }
  if (userSummary.profile.city || userSummary.profile.state) {
    profileParts.push(`location ${[userSummary.profile.city, userSummary.profile.state].filter(Boolean).join(', ')}`);
  }
  if (typeof userSummary.profile.propertyAddressCount === 'number') {
    profileParts.push(`profile properties ${userSummary.profile.propertyAddressCount}`);
  }
  if (typeof userSummary.profile.savedPropertyCount === 'number') {
    profileParts.push(`saved properties ${userSummary.profile.savedPropertyCount}`);
  }
  lines.push(`- ${profileParts.join('; ') || 'Profile loaded.'}`);

  if (userSummary.trackedMarkets.length > 0) {
    lines.push(`- Tracked markets: ${userSummary.trackedMarkets.join(', ')}.`);
  }

  if (Object.keys(userSummary.sample).length > 0) {
    const sampleParts = Object.entries(userSummary.sample)
      .map(([key, value]) => `${key} ${value}`)
      .slice(0, 6);
    lines.push(`- Additional profile signals: ${sampleParts.join('; ')}.`);
  }

  if (userSummary.fieldNames.length > 0) {
    lines.push(`- Users doc fields present: ${userSummary.fieldNames.join(', ')}.`);
  }

  return lines;
}

function buildPortfolioPromptLines(portfolioSummary, includeSensitive) {
  const lines = ['PORTFOLIO & FINANCE FIRESTORE:'];

  if (!portfolioSummary.ok) {
    lines.push(`- Unavailable: ${portfolioSummary.error}.`);
    return lines;
  }

  if (portfolioSummary.assetCount === 0 && portfolioSummary.liabilityCount === 0 && !portfolioSummary.latestSnapshot) {
    lines.push('- No portfolio assets, liabilities, or snapshots were found.');
    return lines;
  }

  const assetGroupText = portfolioSummary.assetGroups
    .map((group) => includeSensitive
      ? `${group.label} ${group.count} (${formatMoney(group.totalValue) || '$0'})`
      : `${group.label} ${group.count}`)
    .join(', ');

  lines.push(`- Assets: ${portfolioSummary.assetCount} total${assetGroupText ? `; ${assetGroupText}` : ''}.`);

  if (portfolioSummary.liabilityCount > 0) {
    lines.push(includeSensitive && portfolioSummary.totalLiabilities !== undefined
      ? `- Liabilities: ${portfolioSummary.liabilityCount} total; outstanding balance ${formatMoney(portfolioSummary.totalLiabilities) || '$0'}.`
      : `- Liabilities: ${portfolioSummary.liabilityCount} total.`);
  }

  if (portfolioSummary.latestSnapshot) {
    const snapshotParts = [`latest snapshot ${clipText(portfolioSummary.latestSnapshot.date, 40)}`];
    if (includeSensitive && portfolioSummary.latestSnapshot.netWorth !== undefined) {
      snapshotParts.push(`net worth ${formatMoney(portfolioSummary.latestSnapshot.netWorth)}`);
    }
    if (includeSensitive && portfolioSummary.latestSnapshot.totalValue !== undefined) {
      snapshotParts.push(`gross assets ${formatMoney(portfolioSummary.latestSnapshot.totalValue)}`);
    }
    lines.push(`- ${snapshotParts.join('; ')}.`);
  }

  if (includeSensitive && portfolioSummary.topAssets.length > 0) {
    const holdingsText = portfolioSummary.topAssets
      .map((asset) => asset.value !== undefined
        ? `${asset.label}${asset.ticker ? ` (${asset.ticker})` : ''} ${formatMoney(asset.value)}`
        : `${asset.label}${asset.ticker ? ` (${asset.ticker})` : ''}`)
      .join('; ');
    lines.push(`- Largest holdings: ${holdingsText}.`);
  }

  if (!includeSensitive && portfolioSummary.assetCount > 0) {
    lines.push('- Financial values, addresses, and holdings are redacted until financial voice access is unlocked.');
  }

  return lines;
}

function buildLinkedCollectionPromptLines(linkedCollections, includeSensitive) {
  const lines = ['PROPERTY OPERATIONS & FIRESTORE COLLECTIONS:'];

  for (const summary of linkedCollections) {
    if (!summary.ok) {
      lines.push(`- ${summary.collection}: unavailable (${summary.error}).`);
      continue;
    }

    if (summary.count === 0) {
      lines.push(`- ${summary.collection}: no linked documents found.`);
      continue;
    }

    const sampleText = summary.samples
      .slice(0, 3)
      .map((sample) => Object.entries(sample).map(([key, value]) => `${key} ${value}`).join(', '))
      .filter(Boolean)
      .join(' | ');

    lines.push(`- ${summary.collection}: ${summary.count} linked docs${sampleText ? `; samples ${sampleText}` : ''}.`);
    if (!includeSensitive && ['properties', 'tenants'].includes(summary.collection)) {
      lines.push(`- ${summary.collection}: identifying addresses, tenant names, and financial amounts remain redacted until unlock.`);
    }
  }

  return lines;
}

function buildDiscoveredCollectionPromptLines(discoveredCollections, includeSensitive) {
  const lines = ['BROADER FIRESTORE DISCOVERY:'];

  if (!discoveredCollections.ok) {
    lines.push(`- Unavailable: ${discoveredCollections.error}.`);
    return lines;
  }

  if (discoveredCollections.inventory.length > 0) {
    lines.push(`- Account-scoped Firestore collections available to this user (${discoveredCollections.totalTopLevelCollections}): ${discoveredCollections.inventory.join(', ')}${discoveredCollections.inventoryTruncated ? ', ...' : ''}.`);
  }

  if (discoveredCollections.collections.length === 0) {
    lines.push('- No additional user-linked top-level collections were discovered outside the explicit registry.');
    return lines;
  }

  for (const summary of discoveredCollections.collections.slice(0, 8)) {
    const sampleText = summary.samples
      .slice(0, 2)
      .map((sample) => Object.entries(sample).map(([key, value]) => `${key} ${value}`).join(', '))
      .filter(Boolean)
      .join(' | ');
    lines.push(`- ${summary.collection}: ${summary.count} linked docs via ${summary.linkField}${sampleText ? `; samples ${sampleText}` : ''}.`);
    if (!includeSensitive && ['properties', 'tenants'].includes(summary.collection)) {
      lines.push(`- ${summary.collection}: identifying fields and financial amounts remain redacted until unlock.`);
    }
  }

  return lines;
}

function buildSubcollectionPromptLines(title, summaries, key) {
  const lines = [title];

  if (!summaries.ok) {
    lines.push(`- Unavailable: ${summaries.error}.`);
    return lines;
  }

  if (!Array.isArray(summaries[key]) || summaries[key].length === 0) {
    lines.push('- No nested collections found.');
    return lines;
  }

  for (const summary of summaries[key]) {
    const sampleText = summary.samples
      .slice(0, 2)
      .map((sample) => Object.entries(sample).map(([entryKey, entryValue]) => `${entryKey} ${entryValue}`).join(', '))
      .filter(Boolean)
      .join(' | ');
    lines.push(`- ${summary.id}: ${summary.count} docs${sampleText ? `; samples ${sampleText}` : ''}.`);
  }

  return lines;
}

function buildGlobalMarketPromptLines(globalMarketSummary) {
  const lines = ['GLOBAL MARKET, MACRO, AND NEWS CONTEXT:'];

  if (!globalMarketSummary.ok) {
    lines.push('- Global market context is currently unavailable.');
    return lines;
  }

  const housing = globalMarketSummary.housing?.overview || null;
  if (housing) {
    const housingParts = [];
    if (housing.medianPrice?.value) {
      housingParts.push(`median US home price ${housing.medianPrice.value}`);
    }
    if (housing.medianPrice?.yoy) {
      housingParts.push(`home price YoY ${housing.medianPrice.yoy}%`);
    }
    if (housing.inventory?.value) {
      housingParts.push(`inventory ${housing.inventory.value}`);
    }
    if (housing.mortgageRate?.value) {
      housingParts.push(`30Y mortgage ${housing.mortgageRate.value}%`);
    }
    if (housing.mortgageRate?.date) {
      housingParts.push(`mortgage as of ${housing.mortgageRate.date}`);
    }
    if (housingParts.length > 0) {
      lines.push(`- Housing market: ${housingParts.join('; ')}.`);
    }
  }

  const macro = globalMarketSummary.macro || null;
  if (macro) {
    const macroParts = [];
    if (macro.fedFundsRate?.value) {
      macroParts.push(`Fed funds ${macro.fedFundsRate.value}%`);
    }
    if (macro.unemployment?.value) {
      macroParts.push(`unemployment ${macro.unemployment.value}%`);
    }
    if (macro.corePCE?.value) {
      macroParts.push(`core PCE ${macro.corePCE.value}`);
    }
    if (macro.corePCE?.yoy) {
      macroParts.push(`core PCE YoY ${macro.corePCE.yoy}%`);
    }
    if (macro.joblessClaims?.value) {
      macroParts.push(`jobless claims ${macro.joblessClaims.value}`);
    }
    if (macro.consumerSentiment?.value) {
      macroParts.push(`consumer sentiment ${macro.consumerSentiment.value}`);
    }
    if (macro.oilPrice?.value) {
      macroParts.push(`WTI oil ${macro.oilPrice.value}`);
    }
    if (macro.newHomeSales?.value) {
      macroParts.push(`new home sales ${macro.newHomeSales.value}`);
    }
    if (macroParts.length > 0) {
      lines.push(`- Macro indicators: ${macroParts.join('; ')}.`);
    }

    if (macro.beveridgeCurve?.latest) {
      const beveridgeParts = [
        `national unemployment ${macro.beveridgeCurve.latest.unemployment}%`,
        `job openings rate ${macro.beveridgeCurve.latest.vacancyRate}%`,
        `direction ${macro.beveridgeCurve.direction}`,
      ];

      if (macro.beveridgeCurve.yearAgo) {
        beveridgeParts.push(`year-ago unemployment ${macro.beveridgeCurve.yearAgo.unemployment}%`);
        beveridgeParts.push(`year-ago job openings rate ${macro.beveridgeCurve.yearAgo.vacancyRate}%`);
      }

      lines.push(`- Beveridge curve: ${beveridgeParts.join('; ')}.`);

      const regionalText = Object.entries(macro.beveridgeCurve.regions || {})
        .filter(([key]) => key !== 'national')
        .slice(0, 4)
        .map(([, region]) => `${region.label} vacancy ${region.latest.vacancyRate}% vs unemployment ${region.latest.unemployment}% (${region.direction})`)
        .join(' | ');

      if (regionalText) {
        lines.push(`- Beveridge regions: ${regionalText}.`);
      }
    }

    const latestPriceVsRent = Array.isArray(macro.investorRatios?.priceVsRent) && macro.investorRatios.priceVsRent.length > 0
      ? macro.investorRatios.priceVsRent[macro.investorRatios.priceVsRent.length - 1]
      : null;
    const latestCapRateSpread = Array.isArray(macro.investorRatios?.capRateSpread) && macro.investorRatios.capRateSpread.length > 0
      ? macro.investorRatios.capRateSpread[macro.investorRatios.capRateSpread.length - 1]
      : null;
    const investorRatioParts = [];

    if (latestPriceVsRent) {
      investorRatioParts.push(`price vs rent ${latestPriceVsRent.date} home index ${latestPriceVsRent.homePriceIndex} rent index ${latestPriceVsRent.rentIndex}`);
    }
    if (latestCapRateSpread) {
      investorRatioParts.push(`cap-rate spread ${latestCapRateSpread.date} ${latestCapRateSpread.spread}%`);
    }

    if (investorRatioParts.length > 0) {
      lines.push(`- Investor ratio charts: ${investorRatioParts.join('; ')}.`);
    }
  }

  if (globalMarketSummary.treasury?.summary) {
    const treasuryParts = [];
    if (globalMarketSummary.treasury.summary.keyRate) {
      treasuryParts.push(globalMarketSummary.treasury.summary.keyRate);
    }
    if (globalMarketSummary.treasury.summary.mortgageRate) {
      treasuryParts.push(`mortgage ${globalMarketSummary.treasury.summary.mortgageRate}`);
    }
    if (globalMarketSummary.treasury.summary.yieldCurve) {
      treasuryParts.push(`yield curve ${globalMarketSummary.treasury.summary.yieldCurve}`);
    }
    if (globalMarketSummary.treasury.summary.environment) {
      treasuryParts.push(`environment ${String(globalMarketSummary.treasury.summary.environment).toLowerCase()}`);
    }
    if (globalMarketSummary.treasury.summary.trend) {
      treasuryParts.push(`trend ${globalMarketSummary.treasury.summary.trend}`);
    }
    if (treasuryParts.length > 0) {
      lines.push(`- Treasury yields: ${treasuryParts.join('; ')}.`);
    }
  }

  if (Array.isArray(globalMarketSummary.regional?.metros) && globalMarketSummary.regional.metros.length > 0) {
    const metroText = globalMarketSummary.regional.metros
      .slice(0, 4)
      .map((metro) => {
        const parts = [clipText(metro.name, 60)];
        if (safeNumber(metro.price) !== null) {
          parts.push(`price ${formatMoney(metro.price)}`);
        }
        if (metro.yoy && metro.yoy !== 'N/A') {
          parts.push(`YoY ${metro.yoy}%`);
        }
        if (metro.inventory && metro.inventory !== 'N/A') {
          parts.push(`inventory ${metro.inventory}`);
        }
        return parts.join(' ');
      })
      .join(' | ');

    if (metroText) {
      lines.push(`- Regional market snapshot: ${metroText}.`);
    }
  }

  const predictions = globalMarketSummary.polymarketPredictions?.predictions || null;
  if (predictions) {
    const predictionParts = [];

    if (predictions.fedRateCut?.question) {
      predictionParts.push(`Fed ${clipText(predictions.fedRateCut.question, 110)}${formatProbability(predictions.fedRateCut.probability) ? ` (${formatProbability(predictions.fedRateCut.probability)})` : ''}`);
    }
    if (predictions.mortgageRate?.question) {
      predictionParts.push(`mortgage ${clipText(predictions.mortgageRate.question, 110)}${formatProbability(predictions.mortgageRate.probability) ? ` (${formatProbability(predictions.mortgageRate.probability)})` : ''}`);
    }
    if (predictions.recession?.question) {
      predictionParts.push(`recession ${clipText(predictions.recession.question, 110)}${formatProbability(predictions.recession.probability) ? ` (${formatProbability(predictions.recession.probability)})` : ''}`);
    }
    if (predictions.inflation?.question) {
      predictionParts.push(`inflation ${clipText(predictions.inflation.question, 110)}${formatProbability(predictions.inflation.probability) ? ` (${formatProbability(predictions.inflation.probability)})` : ''}`);
    }

    if (predictionParts.length > 0) {
      lines.push(`- Polymarket predictions: ${predictionParts.join(' | ')}.`);
    }
  }

  const economicMarkets = globalMarketSummary.polymarketEconomic || null;
  if (economicMarkets?.ok) {
    const economicParts = [];
    if (economicMarkets.total) {
      economicParts.push(`total markets ${economicMarkets.total}`);
    }
    if (economicMarkets.fedRate?.count) {
      economicParts.push(`Fed ${economicMarkets.fedRate.count}`);
    }
    if (economicMarkets.mortgage?.count) {
      economicParts.push(`mortgage ${economicMarkets.mortgage.count}`);
    }
    if (economicMarkets.recession?.count) {
      economicParts.push(`recession ${economicMarkets.recession.count}`);
    }
    if (economicMarkets.inflation?.count) {
      economicParts.push(`inflation ${economicMarkets.inflation.count}`);
    }
    if (economicMarkets.unemployment?.count) {
      economicParts.push(`unemployment ${economicMarkets.unemployment.count}`);
    }
    if (economicParts.length > 0) {
      lines.push(`- Polymarket economic market coverage: ${economicParts.join('; ')}.`);
    }
  }

  if (Array.isArray(globalMarketSummary.headlines) && globalMarketSummary.headlines.length > 0) {
    const headlineText = globalMarketSummary.headlines
      .map((headline) => `[${headline.topic}/${headline.ticker}] ${headline.title}`)
      .join(' | ');
    lines.push(`- Market headlines: ${headlineText}.`);
  }

  return lines;
}

function buildCoveragePromptLines({ includeSensitive, userSummary, linkedCollections, discoveredCollections, bookkeepingSummary, userSubcollectionsSummary, globalMarketSummary }) {
  const lines = ['DATA COVERAGE & GUARDRAILS:'];
  const loadedSources = ['users/{uid}'];

  if (linkedCollections.some((summary) => summary.ok && summary.count !== 0)) {
    loadedSources.push('top-level owner-linked Firestore collections');
  }
  if (discoveredCollections.ok) {
    loadedSources.push('top-level Firestore inventory');
  }
  if (discoveredCollections.ok && discoveredCollections.matchedCollectionCount > 0) {
    loadedSources.push('discovered user-linked top-level Firestore collections');
  }
  if (bookkeepingSummary.ok && bookkeepingSummary.subcollectionCount > 0) {
    loadedSources.push('users/{uid}/bookkeeping/data/*');
  }
  if (userSubcollectionsSummary.ok && userSubcollectionsSummary.collectionCount > 0) {
    loadedSources.push('users/{uid}/*');
  }
  if (globalMarketSummary.ok) {
    loadedSources.push('FRED housing/regional/treasury/macro', 'Polymarket predictions', 'Polygon news');
  }

  lines.push(`- Loaded sources: ${loadedSources.join(', ')}.`);
  if (discoveredCollections.ok) {
    lines.push(`- Firestore breadth: ${discoveredCollections.totalTopLevelCollections} account-scoped collections detected; ${discoveredCollections.scannedCollectionCount} eligible collections scanned for user linkage; ${discoveredCollections.matchedCollectionCount} additional collections matched this user.`);
  }
  lines.push(`- Financial detail access: ${includeSensitive ? 'available for this authenticated account; use exact values when relevant.' : 'summarized in this context; call scoped tools for exact values instead of deflecting.'}`);
  if (!userSummary.exists) {
    lines.push('- Missing users/{uid} doc means profile facts may be incomplete even if other collections exist.');
  }
  return lines;
}

function buildPromptContext({
  userId,
  includeSensitive,
  userSummary,
  portfolioSummary,
  linkedCollections,
  discoveredCollections,
  userSubcollectionsSummary,
  bookkeepingSummary,
  globalMarketSummary,
}) {
  const sections = [
    'CANONICAL HOUSEYIELD PLATFORM CONTEXT:',
    `- Authenticated user ${userId}.`,
    `- Generated at ${new Date().toISOString()}.`,
    ...buildAccountPromptLines(userSummary),
    ...buildPortfolioPromptLines(portfolioSummary, includeSensitive),
    ...buildLinkedCollectionPromptLines(linkedCollections, includeSensitive),
    ...buildDiscoveredCollectionPromptLines(discoveredCollections, includeSensitive),
    ...buildSubcollectionPromptLines('USER SUBCOLLECTIONS:', userSubcollectionsSummary, 'collections'),
    ...buildSubcollectionPromptLines('BOOKKEEPING FIRESTORE:', bookkeepingSummary, 'subcollections'),
    ...buildGlobalMarketPromptLines(globalMarketSummary),
    ...buildCoveragePromptLines({
      includeSensitive,
      userSummary,
      linkedCollections,
      discoveredCollections,
      bookkeepingSummary,
      userSubcollectionsSummary,
      globalMarketSummary,
    }),
  ];

  return sections.join('\n');
}

export async function buildAssistantCanonicalContext({
  userId,
  includeFinancialDetails = false,
  includeGlobalContext = true,
} = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const [userSummary, portfolioSummary, linkedCollections, discoveredCollections, userSubcollectionsSummary, bookkeepingSummary, globalMarketSummary] = await Promise.all([
    summarizeUserDocument(userId, includeFinancialDetails),
    summarizePortfolio(userId, includeFinancialDetails),
    Promise.all(USER_LINKED_COLLECTIONS.map((spec) => summarizeUserLinkedCollection(spec, userId, includeFinancialDetails))),
    summarizeDiscoveredLinkedCollections(userId, includeFinancialDetails),
    summarizeUserSubcollections(userId, includeFinancialDetails),
    summarizeBookkeepingData(userId, includeFinancialDetails),
    includeGlobalContext
      ? loadGlobalMarketContext()
      : Promise.resolve({ ok: false, housing: null, regional: null, treasury: null, macro: null, polymarketPredictions: null, polymarketEconomic: null, headlines: [], sourceStatus: {} }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    promptContext: buildPromptContext({
      userId,
      includeSensitive: includeFinancialDetails,
      userSummary,
      portfolioSummary,
      linkedCollections,
      discoveredCollections,
      userSubcollectionsSummary,
      bookkeepingSummary,
      globalMarketSummary,
    }),
    sections: {
      user: userSummary,
      portfolio: portfolioSummary,
      linkedCollections,
      discoveredCollections,
      userSubcollections: userSubcollectionsSummary,
      bookkeeping: bookkeepingSummary,
      globalMarket: globalMarketSummary,
    },
    sourceStatus: {
      user: { ok: userSummary.ok, exists: userSummary.exists },
      portfolio: { ok: portfolioSummary.ok },
      linkedCollections: Object.fromEntries(linkedCollections.map((summary) => [summary.collection, { ok: summary.ok, count: summary.count, error: summary.error || null }])),
      discoveredCollections: { ok: discoveredCollections.ok, count: discoveredCollections.matchedCollectionCount, scanned: discoveredCollections.scannedCollectionCount, error: discoveredCollections.error || null },
      userSubcollections: { ok: userSubcollectionsSummary.ok, count: userSubcollectionsSummary.collectionCount, error: userSubcollectionsSummary.error || null },
      bookkeeping: { ok: bookkeepingSummary.ok, count: bookkeepingSummary.subcollectionCount, error: bookkeepingSummary.error || null },
      globalMarket: globalMarketSummary.sourceStatus,
    },
  };
}