import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';
import { getZipMarketData, getMetroZipMarketData, getSupportedMetroZipProfilesSummary } from '../rentcast.js';
import { fetchZipSalesTrend, calculateZipAppreciation } from '../attom.js';
import { getCachedFredData, setCachedFredData } from '../fred-cache.js';
import { getCachedAttomData } from '../attom-firestore-cache.js';
import { sendSecureGmail } from '../gmail-oauth2-secure.js';
import { runGoogleCustomSearch } from './googleCustomSearchService.js';
import {
  buildManagementActivityDigest,
  buildPropertyValueDigest,
  buildFinancialWeekDigest,
  buildLeaseTenantDigest,
  buildTaxDigest,
  buildListingsWatchDigest,
  buildPricingPowerDigest,
  buildMacroDigest,
} from './assistantWeeklyDigestSections.js';
import { generateWeeklyDigestNarrative } from './assistantWeeklyDigestNarrative.js';

const DIGEST_LOG_COLLECTION = 'assistant_weekly_digests';
const DEFAULT_PROPERTY_LIMIT = 6;
const DEFAULT_REGION_LIMIT = 3;
const DEFAULT_METRO_LIMIT = 2;
const DEFAULT_WEB_QUERY_LIMIT = 2;
const DIGEST_PREFERENCES_FIELD = 'assistantWeeklyDigestPreferences';
const DEFAULT_DIGEST_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
const DEFAULT_DIGEST_SCHEDULER_WINDOW_MINUTES = 15;
const DIGEST_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DEFAULT_WEEKLY_DIGEST_PREFERENCES = Object.freeze({
  enabled: false,
  recipientEmail: '',
  includeFinancialDetails: true,
  includeGlobalContext: true,
  includeWebSearch: false,
  includeAiNarrative: true,
  includeManagementActivity: true,
  includeTaxUpdates: true,
  includeListingsWatch: true,
  watchedTickers: Object.freeze([]),
  watchedZipCodes: Object.freeze([]),
  schedule: Object.freeze({
    weekday: 'sunday',
    localHour: 7,
    localMinute: 0,
    timeZone: DEFAULT_DIGEST_TIME_ZONE,
  }),
  lastSentAt: null,
  lastSentLocalDate: null,
  lastAttemptAt: null,
  lastError: null,
  updatedAt: null,
});

function getAdmin() {
  return initializeFirebaseAdmin();
}

// assistantCanonicalContextService initializes Firebase Admin at module load,
// so it is imported lazily to keep this module import-safe for CLI tooling.
let canonicalContextModulePromise = null;
async function loadCanonicalContextBuilder() {
  if (!canonicalContextModulePromise) {
    canonicalContextModulePromise = import('./assistantCanonicalContextService.js');
  }
  const { buildAssistantCanonicalContext } = await canonicalContextModulePromise;
  return buildAssistantCanonicalContext;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clipText(value, maxLength = 160) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCurrency(value) {
  const parsed = safeNumber(value);
  if (parsed === null) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(parsed);
}

function formatPercent(value, fractionDigits = 2) {
  const parsed = safeNumber(value);
  if (parsed === null) return null;
  return `${parsed.toFixed(fractionDigits)}%`;
}

function formatDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getNested(obj, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), obj);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function extractZipFromText(value) {
  const matches = String(value || '').match(/\b(\d{5})(?:-\d{4})?\b/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const lastMatch = matches[matches.length - 1];
  const zipMatch = lastMatch.match(/\b(\d{5})/);
  return zipMatch ? zipMatch[1] : null;
}

function buildWeekWindow(now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 7);

  return {
    start,
    end,
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
    label: `Week ending ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
  };
}

function buildAttomTrendWindow(endDate) {
  const end = new Date(endDate || new Date());
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 2);

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function normalizeWeekday(value, fallback = DEFAULT_WEEKLY_DIGEST_PREFERENCES.schedule.weekday) {
  const normalized = String(value || '').trim().toLowerCase();
  return DIGEST_WEEKDAYS.includes(normalized) ? normalized : fallback;
}

function normalizeIsoString(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeStringArray(value, { limit = 12, maxLength = 40, transform = null } = {}) {
  const values = Array.isArray(value) ? value : [];
  const normalized = values
    .map((item) => clipText(item, maxLength))
    .map((item) => (typeof transform === 'function' ? transform(item) : item))
    .filter(Boolean);

  return dedupeBy(normalized, (item) => item).slice(0, limit);
}

function resolveDigestTimeZone(value, fallback = DEFAULT_DIGEST_TIME_ZONE) {
  const candidate = String(value || '').trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function getUserTimeZoneFallback(userRecord = {}) {
  return resolveDigestTimeZone(
    getNested(userRecord, ['timeZone', 'timezone', 'profile.timeZone', 'profile.timezone']) || DEFAULT_DIGEST_TIME_ZONE,
    DEFAULT_DIGEST_TIME_ZONE,
  );
}

function mergeWeeklyDigestPreferences(existingPreferences, updates = {}) {
  const definedUpdates = Object.fromEntries(
    Object.entries(updates || {}).filter(([, value]) => value !== undefined),
  );
  const nextScheduleUpdates = definedUpdates?.schedule && typeof definedUpdates.schedule === 'object' ? definedUpdates.schedule : {};

  return {
    ...existingPreferences,
    ...definedUpdates,
    schedule: {
      ...(existingPreferences?.schedule || DEFAULT_WEEKLY_DIGEST_PREFERENCES.schedule),
      ...nextScheduleUpdates,
      ...(definedUpdates?.weekday !== undefined ? { weekday: definedUpdates.weekday } : null),
      ...(definedUpdates?.localHour !== undefined ? { localHour: definedUpdates.localHour } : null),
      ...(definedUpdates?.localMinute !== undefined ? { localMinute: definedUpdates.localMinute } : null),
      ...(definedUpdates?.timeZone !== undefined ? { timeZone: definedUpdates.timeZone } : null),
    },
  };
}

function normalizeWeeklyDigestPreferences(rawPreferences = {}, { fallbackTimeZone = DEFAULT_DIGEST_TIME_ZONE, now = new Date() } = {}) {
  const defaultTimeZone = resolveDigestTimeZone(fallbackTimeZone, DEFAULT_DIGEST_TIME_ZONE);
  const schedule = rawPreferences?.schedule && typeof rawPreferences.schedule === 'object'
    ? rawPreferences.schedule
    : {};

  return {
    enabled: normalizeBoolean(rawPreferences?.enabled, DEFAULT_WEEKLY_DIGEST_PREFERENCES.enabled),
    recipientEmail: clipText(rawPreferences?.recipientEmail || '', 160),
    includeFinancialDetails: normalizeBoolean(
      rawPreferences?.includeFinancialDetails,
      DEFAULT_WEEKLY_DIGEST_PREFERENCES.includeFinancialDetails,
    ),
    includeGlobalContext: normalizeBoolean(
      rawPreferences?.includeGlobalContext,
      DEFAULT_WEEKLY_DIGEST_PREFERENCES.includeGlobalContext,
    ),
    includeWebSearch: normalizeBoolean(rawPreferences?.includeWebSearch, DEFAULT_WEEKLY_DIGEST_PREFERENCES.includeWebSearch),
    includeAiNarrative: normalizeBoolean(rawPreferences?.includeAiNarrative, DEFAULT_WEEKLY_DIGEST_PREFERENCES.includeAiNarrative),
    includeManagementActivity: normalizeBoolean(
      rawPreferences?.includeManagementActivity,
      DEFAULT_WEEKLY_DIGEST_PREFERENCES.includeManagementActivity,
    ),
    includeTaxUpdates: normalizeBoolean(rawPreferences?.includeTaxUpdates, DEFAULT_WEEKLY_DIGEST_PREFERENCES.includeTaxUpdates),
    includeListingsWatch: normalizeBoolean(
      rawPreferences?.includeListingsWatch,
      DEFAULT_WEEKLY_DIGEST_PREFERENCES.includeListingsWatch,
    ),
    watchedTickers: normalizeStringArray(rawPreferences?.watchedTickers, {
      limit: 12,
      maxLength: 10,
      transform: (item) => String(item || '').trim().toUpperCase(),
    }),
    watchedZipCodes: normalizeStringArray(rawPreferences?.watchedZipCodes, {
      limit: 12,
      maxLength: 12,
      transform: (item) => extractZipFromText(item),
    }),
    schedule: {
      weekday: normalizeWeekday(schedule?.weekday ?? rawPreferences?.weekday),
      localHour: normalizeInteger(
        schedule?.localHour ?? rawPreferences?.localHour,
        0,
        23,
        DEFAULT_WEEKLY_DIGEST_PREFERENCES.schedule.localHour,
      ),
      localMinute: normalizeInteger(
        schedule?.localMinute ?? rawPreferences?.localMinute,
        0,
        59,
        DEFAULT_WEEKLY_DIGEST_PREFERENCES.schedule.localMinute,
      ),
      timeZone: resolveDigestTimeZone(schedule?.timeZone ?? rawPreferences?.timeZone, defaultTimeZone),
    },
    lastSentAt: normalizeIsoString(rawPreferences?.lastSentAt),
    lastSentLocalDate: /^\d{4}-\d{2}-\d{2}$/.test(String(rawPreferences?.lastSentLocalDate || ''))
      ? String(rawPreferences.lastSentLocalDate)
      : null,
    lastAttemptAt: normalizeIsoString(rawPreferences?.lastAttemptAt),
    lastError: clipText(rawPreferences?.lastError || '', 240) || null,
    updatedAt: normalizeIsoString(rawPreferences?.updatedAt) || now.toISOString(),
  };
}

function getLocalScheduleSnapshot(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: String(parts.weekday || '').trim().toLowerCase(),
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localHour: Number.parseInt(parts.hour || '0', 10),
    localMinute: Number.parseInt(parts.minute || '0', 10),
  };
}

function isWeeklyDigestDue(preferences, now = new Date(), scheduleWindowMinutes = DEFAULT_DIGEST_SCHEDULER_WINDOW_MINUTES) {
  const snapshot = getLocalScheduleSnapshot(now, preferences.schedule.timeZone);
  const currentMinutes = (snapshot.localHour * 60) + snapshot.localMinute;
  const scheduledMinutes = (preferences.schedule.localHour * 60) + preferences.schedule.localMinute;
  const weekdayMatches = snapshot.weekday === preferences.schedule.weekday;
  const withinWindow = currentMinutes >= scheduledMinutes && currentMinutes < (scheduledMinutes + scheduleWindowMinutes);
  const alreadySentToday = preferences.lastSentLocalDate === snapshot.localDate;

  return {
    due: weekdayMatches && withinWindow && !alreadySentToday,
    weekdayMatches,
    withinWindow,
    alreadySentToday,
    snapshot,
  };
}

function getUserDisplayName(userRecord, fallbackEmail = '') {
  return clipText(
    getNested(userRecord, ['displayName', 'fullName', 'name', 'profile.displayName'])
      || (fallbackEmail ? fallbackEmail.split('@')[0] : '')
      || 'there',
    60,
  );
}

function normalizePropertyRecord(record) {
  const address = clipText(
    getNested(record, ['address', 'formattedAddress', 'summary.address', 'property_data.summary.address', 'propertyData.summary.address']) || '',
    140,
  );
  const financials = getNested(record, ['financials']) || {};
  const zipCode = extractZipFromText(
    getNested(record, [
      'zipCode',
      'zip',
      'postalCode',
      'address.zipCode',
      'address.postalCode',
      'summary.postal_code',
      'property_data.summary.postal_code',
      'propertyData.summary.postal_code',
      'address',
    ]) || '',
  );

  return {
    id: String(record?.id || address || zipCode || '').trim(),
    address,
    zipCode,
    monthlyRent: safeNumber(getNested(financials, ['monthlyRent']) || getNested(record, ['monthlyRent'])),
    propertyValue: safeNumber(
      getNested(financials, ['currentValue', 'propertyValue'])
      || getNested(record, ['currentValue', 'propertyValue'])
      || getNested(record, ['property_data.summary.avm_value', 'propertyData.summary.avm_value']),
    ),
    occupancyStatus: clipText(getNested(record, ['status', 'occupancyStatus', 'summary.status']) || '', 40) || null,
  };
}

async function loadUserRecord(userId) {
  const db = getFirestore();
  const snapshot = await db.collection('users').doc(userId).get();
  return snapshot.exists ? { id: snapshot.id, ...(snapshot.data() || {}) } : { id: userId };
}

async function loadOwnerProperties(userId) {
  const db = getFirestore();
  const querySpecs = [
    ['ownerId', '==', userId],
    ['userId', '==', userId],
  ];

  const settled = await Promise.allSettled(
    querySpecs.map(([field, op, value]) => db.collection('properties').where(field, op, value).limit(25).get())
  );

  const properties = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      continue;
    }
    for (const doc of result.value.docs) {
      properties.push({ id: doc.id, ...(doc.data() || {}) });
    }
  }

  return dedupeBy(properties, (property) => property.id);
}

async function loadCachedAttomRegionalDigest(zipCode, { startDate, endDate }) {
  const attomWindow = buildAttomTrendWindow(endDate || startDate || new Date());
  const cacheKey = `my-region-attom:${String(zipCode).trim()}:${attomWindow.startDate}:${attomWindow.endDate}`;

  const deriveAppreciationFromTrend = (trendPoints = []) => {
    if (!Array.isArray(trendPoints) || trendPoints.length === 0) {
      return { ok: false, error: 'No trend data' };
    }

    const startTarget = new Date(attomWindow.startDate);
    const endTarget = new Date(attomWindow.endDate);

    const findClosest = (targetDate) => {
      let closest = trendPoints[0];
      let closestDiff = Infinity;

      for (const point of trendPoints) {
        const pointDate = new Date(point.year, (point.month || 1) - 1, 15);
        const diff = Math.abs(pointDate.getTime() - targetDate.getTime());
        if (diff < closestDiff) {
          closest = point;
          closestDiff = diff;
        }
      }

      return closest;
    };

    const startPoint = findClosest(startTarget);
    const endPoint = findClosest(endTarget);
    const startPrice = safeNumber(startPoint?.medianSalePrice || startPoint?.avgSalePrice);
    const endPrice = safeNumber(endPoint?.medianSalePrice || endPoint?.avgSalePrice);

    if (startPrice === null || endPrice === null || startPrice === 0) {
      return { ok: false, error: 'Could not extract price data from trend' };
    }

    const appreciationPercent = ((endPrice - startPrice) / startPrice) * 100;
    const monthsAnalyzed = 24;

    return {
      ok: true,
      appreciationPercent,
      annualizedRate: (appreciationPercent / monthsAnalyzed) * 12,
      startPrice,
      endPrice,
      startDate: `${startPoint.year}-${String(startPoint.month || 1).padStart(2, '0')}`,
      endDate: `${endPoint.year}-${String(endPoint.month || 1).padStart(2, '0')}`,
      confidence: 0.75,
      dataSource: 'ATTOM ZIP Sales Trend',
      granularity: 'zip-code',
      zipCode,
      monthsAnalyzed,
      dataPointCount: trendPoints.length,
    };
  };

  const loadFresh = async () => {
    const trendResult = await fetchZipSalesTrend(zipCode, attomWindow.startDate, attomWindow.endDate);
    const appreciationResult = trendResult?.ok
      ? deriveAppreciationFromTrend(trendResult?.data?.trendPoints || [])
      : { ok: false, error: trendResult?.error || 'fetch_failed' };

    return {
      ok: true,
      zipCode,
      salesTrend: trendResult,
      appreciation: appreciationResult,
    };
  };

  const cached = await getCachedFredData(cacheKey).catch(() => null);
  if (cached && !cached.stale) {
    return { ...(cached.data || {}), cached: true, stale: false, cachedAt: cached.updatedAt };
  }

  if (cached?.data) {
    try {
      const fresh = await loadFresh();
      setCachedFredData(cacheKey, fresh).catch((error) => console.warn(`[WeeklyDigest] ATTOM cache write failed for ${cacheKey}:`, error.message));
      return { ...fresh, refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt };
    } catch (error) {
      console.warn(`[WeeklyDigest] ATTOM sync refresh failed for ${cacheKey}:`, error.message);
      return { ...(cached.data || {}), cached: true, stale: true, cachedAt: cached.updatedAt };
    }
  }

  const fresh = await loadFresh();
  setCachedFredData(cacheKey, fresh).catch((error) => console.warn(`[WeeklyDigest] ATTOM cache write failed for ${cacheKey}:`, error.message));
  return fresh;
}

function matchSearchMarkets(searchMemory = []) {
  const profiles = getSupportedMetroZipProfilesSummary();
  const normalizedSearchMemory = Array.isArray(searchMemory) ? searchMemory : [];

  const matches = [];
  for (const entry of normalizedSearchMemory) {
    const text = String(entry || '').toLowerCase();
    const profile = profiles.find((candidate) => {
      const keyPhrase = candidate.key.replace(/-/g, ' ');
      return text.includes(candidate.name.toLowerCase()) || text.includes(keyPhrase);
    });
    if (profile) {
      matches.push(profile);
    }
  }

  return dedupeBy(matches, (profile) => profile.key);
}

function buildWebSearchQueries({ metroMatches }) {
  const queries = [];

  if (metroMatches.length > 0) {
    queries.push(`${metroMatches[0].name} real estate market rent sale price latest week`);
  }

  if (queries.length === 0) {
    queries.push('Federal Reserve mortgage rates housing market latest week');
  }

  return queries.slice(0, DEFAULT_WEB_QUERY_LIMIT);
}

async function buildRegionalDigest({ properties, searchMemory, weekWindow, includeWebSearch, watchedZipCodes = [] }) {
  const normalizedProperties = properties
    .map((property) => normalizePropertyRecord(property))
    .filter((property) => property.id);
  const propertyZips = dedupeBy(
    [
      ...normalizeStringArray(watchedZipCodes, {
        limit: DEFAULT_REGION_LIMIT,
        maxLength: 12,
        transform: (item) => extractZipFromText(item),
      }),
      ...normalizedProperties
        .map((property) => property.zipCode)
        .filter(Boolean),
    ]
      .slice(0, DEFAULT_REGION_LIMIT),
    (zipCode) => zipCode,
  );

  const [zipRegions, metroMatches] = await Promise.all([
    Promise.all(propertyZips.map(async (zipCode) => {
      const [rentcast, attom] = await Promise.allSettled([
        getZipMarketData(zipCode),
        loadCachedAttomRegionalDigest(zipCode, weekWindow),
      ]);

      return {
        zipCode,
        rentcast: rentcast.status === 'fulfilled' ? rentcast.value : null,
        attom: attom.status === 'fulfilled' ? attom.value : null,
      };
    })),
    Promise.resolve(matchSearchMarkets(searchMemory).slice(0, DEFAULT_METRO_LIMIT)),
  ]);

  const metroRegions = await Promise.all(
    metroMatches.map(async (match) => {
      try {
        return {
          ...match,
          data: await getMetroZipMarketData(match.key),
        };
      } catch (error) {
        return {
          ...match,
          error: error.message || 'metro_market_failed',
        };
      }
    })
  );

  const webQueries = includeWebSearch ? buildWebSearchQueries({ metroMatches }) : [];
  const webBriefs = await Promise.all(
    webQueries.map(async (query) => {
      try {
        const result = await runGoogleCustomSearch(query, 3);
        return {
          query,
          results: result.results || [],
        };
      } catch (error) {
        return {
          query,
          error: error.message || 'google_search_failed',
          results: [],
        };
      }
    })
  );

  return {
    propertyZips,
    searchMemory: Array.isArray(searchMemory) ? searchMemory.slice(0, 5) : [],
    zipRegions,
    metroRegions,
    webBriefs,
  };
}

function renderHtmlList(items, formatter) {
  const filtered = items.filter(Boolean);
  if (filtered.length === 0) {
    return '<li>No notable updates this week.</li>';
  }

  return filtered.map((item) => `<li>${formatter(item)}</li>`).join('');
}

function renderSectionInsight(text) {
  if (!text) return '';
  return `<p style="margin: 0 0 10px; color: #374151; font-style: italic;">${escapeHtml(text)}</p>`;
}

function renderNarrativeHtml(narrative) {
  if (!narrative) return '';

  const actionItems = (narrative.actionItems || []).length > 0
    ? `
      <div style="margin-top: 14px;">
        <div style="font-weight: 600; margin-bottom: 6px;">This week's action items</div>
        <ul style="padding-left: 18px; margin: 0;">
          ${narrative.actionItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
    `
    : '';

  return `
    <section style="margin: 0 0 24px; padding: 16px 18px; background: #f3f4f6; border-radius: 10px; border-left: 4px solid #2563eb;">
      <div style="font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #2563eb; margin-bottom: 8px;">Your AI Weekly Briefing</div>
      <p style="margin: 0;">${escapeHtml(narrative.executiveSummary)}</p>
      ${narrative.personalNote ? `<p style="margin: 10px 0 0; color: #4b5563;">${escapeHtml(narrative.personalNote)}</p>` : ''}
      ${actionItems}
    </section>
  `;
}

export function renderWeeklyDigestHtml(digest) {
  const { recipient, draft, properties, regional, memory, macro, narrative } = digest;
  const greetingName = escapeHtml(recipient.displayName || 'there');
  const propertyItems = properties || [];
  const zipRegions = regional?.zipRegions || [];
  const metroRegions = regional?.metroRegions || [];
  const webBriefs = regional?.webBriefs || [];
  const topHeadlines = macro?.headlines || [];
  const insights = narrative?.sectionInsights || {};
  const financialWeek = digest.financialWeek?.available ? digest.financialWeek : null;
  const propertyValue = digest.propertyValue?.available ? digest.propertyValue : null;
  const leases = digest.leases?.ok ? digest.leases : null;
  const activity = digest.managementActivity?.ok ? digest.managementActivity : null;
  const pricingPowerItems = digest.pricingPower?.properties || [];
  const listingRegions = (digest.listingsWatch?.regions || []).filter((region) => region.ok && region.newListingCount > 0);
  const tax = digest.tax?.ok ? digest.tax : null;

  const financialWeekSection = financialWeek ? `
      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Money This Week</h2>
        ${renderSectionInsight(insights.financialWeek)}
        <ul style="padding-left: 18px; margin: 0;">
          <li>Rent collected: <strong>${escapeHtml(formatCurrency(financialWeek.rentCollected) || '$0')}</strong>${financialWeek.expectedMonthlyRent ? ` (expected ${escapeHtml(formatCurrency(financialWeek.expectedMonthlyRent) || '')} per month across your leases)` : ''}.</li>
          ${financialWeek.otherIncome > 0 ? `<li>Other income: ${escapeHtml(formatCurrency(financialWeek.otherIncome) || '')}.</li>` : ''}
          <li>Expenses posted: <strong>${escapeHtml(formatCurrency(financialWeek.totalExpenses) || '$0')}</strong>${financialWeek.topExpenseCategories.length > 0 ? ` — top categories: ${financialWeek.topExpenseCategories.map((entry) => `${escapeHtml(entry.category)} ${escapeHtml(formatCurrency(entry.amount) || '')}`).join(', ')}` : ''}.</li>
          <li>Net cash flow this week: <strong style="color: ${financialWeek.netCashFlow >= 0 ? '#059669' : '#dc2626'};">${escapeHtml(formatCurrency(financialWeek.netCashFlow) || '$0')}</strong>.</li>
        </ul>
      </section>
  ` : '';

  const propertyValueSection = propertyValue ? `
      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Property Value</h2>
        ${renderSectionInsight(insights.propertyValue)}
        <ul style="padding-left: 18px; margin: 0;">
          <li><strong>${escapeHtml(formatCurrency(propertyValue.propertyValue) || '—')}</strong>${propertyValue.weekChange != null ? ` • ${propertyValue.weekChange >= 0 ? 'up' : 'down'} ${escapeHtml(formatCurrency(Math.abs(propertyValue.weekChange)) || '')}${propertyValue.weekChangePercent != null ? ` (${escapeHtml(formatPercent(Math.abs(propertyValue.weekChangePercent)) || '')})` : ''} this week` : ''}.</li>
        </ul>
      </section>
  ` : '';

  const leasesSection = leases && (leases.hasUpdates || leases.tenantCount > 0) ? `
      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Leases &amp; Tenants</h2>
        ${renderSectionInsight(insights.leases)}
        <ul style="padding-left: 18px; margin: 0;">
          ${renderHtmlList([
            ...leases.expiringLeases.map((lease) => `Lease expiring in <strong>${lease.daysUntil} day${lease.daysUntil === 1 ? '' : 's'}</strong>: ${escapeHtml(lease.tenantName)}${lease.address ? ` at ${escapeHtml(lease.address)}` : ''}${lease.monthlyRent != null ? ` (${escapeHtml(formatCurrency(lease.monthlyRent) || '')}/mo)` : ''}.`),
            ...leases.newLeases.map((lease) => `New lease started: ${escapeHtml(lease.tenantName)}${lease.address ? ` at ${escapeHtml(lease.address)}` : ''}${lease.monthlyRent != null ? ` (${escapeHtml(formatCurrency(lease.monthlyRent) || '')}/mo)` : ''}.`),
            leases.tenantCount > 0 && !leases.hasUpdates
              ? `${leases.tenantCount} tenant${leases.tenantCount === 1 ? '' : 's'} on file • expected rent ${escapeHtml(formatCurrency(leases.expectedMonthlyRent) || '')}/mo. No lease changes this week.`
              : null,
          ].filter(Boolean), (line) => line)}
        </ul>
      </section>
  ` : '';

  const activitySection = activity ? `
      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Property Management Activity</h2>
        ${renderSectionInsight(insights.managementActivity)}
        <ul style="padding-left: 18px; margin: 0;">
          ${renderHtmlList([
            ...activity.newMaintenanceRequests.map((request) => `New maintenance request: <strong>${escapeHtml(request.title)}</strong>${request.tenantName ? ` from ${escapeHtml(request.tenantName)}` : ''} • status ${escapeHtml(request.status)}.`),
            activity.openMaintenanceCount > 0 && activity.newMaintenanceRequests.length === 0
              ? `${activity.openMaintenanceCount} maintenance request${activity.openMaintenanceCount === 1 ? '' : 's'} still open.`
              : null,
            ...activity.newMessages.map((message) => `Tenant message${message.tenantName ? ` from ${escapeHtml(message.tenantName)}` : ''}: ${escapeHtml(message.preview)}`),
            activity.collectedThisWeek > 0
              ? `Rent collected this week: <strong>${escapeHtml(formatCurrency(activity.collectedThisWeek) || '')}</strong> across ${activity.paymentsThisWeek.length} payment${activity.paymentsThisWeek.length === 1 ? '' : 's'}.`
              : null,
            activity.unreadMessageCount > 0 ? `${activity.unreadMessageCount} unread tenant message${activity.unreadMessageCount === 1 ? '' : 's'} awaiting reply.` : null,
          ].filter(Boolean), (line) => line)}
        </ul>
      </section>
  ` : '';

  const pricingPowerSection = pricingPowerItems.length > 0 ? `
      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Rental Pricing Power</h2>
        ${renderSectionInsight(insights.pricingPower)}
        <ul style="padding-left: 18px; margin: 0;">
          ${renderHtmlList(pricingPowerItems, (entry) => {
            const positionLabel = entry.position === 'below_market'
              ? `<span style="color: #059669; font-weight: 600;">below market</span>`
              : entry.position === 'above_market'
                ? `<span style="color: #d97706; font-weight: 600;">above market</span>`
                : 'at market';
            const headroom = entry.position === 'below_market'
              ? ` Potential headroom ${escapeHtml(formatCurrency(entry.pricingPowerDollar) || '')}/mo (${escapeHtml(formatPercent(entry.pricingPowerPercent, 1) || '')}).`
              : '';
            return `<strong>${escapeHtml(entry.address || `ZIP ${entry.zipCode}`)}</strong> • rent ${escapeHtml(formatCurrency(entry.currentRent) || '')}/mo vs ZIP median ${escapeHtml(formatCurrency(entry.marketMedianRent) || '')}/mo • ${positionLabel}.${headroom}`;
          })}
        </ul>
      </section>
  ` : '';

  const listingsSection = listingRegions.length > 0 ? `
      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">New Listings in Your Regions of Interest</h2>
        ${renderSectionInsight(insights.listingsWatch)}
        ${listingRegions.map((region) => `
          <div style="margin-bottom: 12px;">
            <div style="font-weight: 600; margin-bottom: 4px;">ZIP ${escapeHtml(region.zipCode)} • ${region.newListingCount} new listing${region.newListingCount === 1 ? '' : 's'} this week</div>
            <ul style="padding-left: 18px; margin: 0;">
              ${renderHtmlList(region.listings || [], (listing) => {
                const parts = [
                  `<strong>${escapeHtml(listing.address || 'New listing')}</strong>`,
                  listing.price != null ? escapeHtml(formatCurrency(listing.price) || '') : null,
                  listing.bedrooms != null ? `${listing.bedrooms} bd` : null,
                  listing.bathrooms != null ? `${listing.bathrooms} ba` : null,
                  listing.squareFootage != null ? `${listing.squareFootage.toLocaleString('en-US')} sqft` : null,
                ].filter(Boolean);
                return `${parts.join(' • ')}.`;
              })}
            </ul>
          </div>
        `).join('')}
      </section>
  ` : '';

  const taxSection = tax && (tax.upcomingDeadlines.length > 0 || tax.newDocuments.length > 0 || tax.estimatedPaymentsRecorded.length > 0 || tax.journalEntriesThisWeek > 0) ? `
      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Tax &amp; Bookkeeping</h2>
        ${renderSectionInsight(insights.tax)}
        <ul style="padding-left: 18px; margin: 0;">
          ${renderHtmlList([
            ...tax.upcomingDeadlines.map((deadline) => `<strong>${escapeHtml(deadline.name)}</strong> due ${escapeHtml(formatDate(deadline.date) || deadline.date)} (${deadline.daysUntil} day${deadline.daysUntil === 1 ? '' : 's'} away${deadline.status === 'urgent' ? ', urgent' : ''}).`),
            ...tax.newDocuments.map((document) => `New document ready: <strong>${escapeHtml(document.name)}</strong>${document.type ? ` (${escapeHtml(document.type)})` : ''}.`),
            ...tax.estimatedPaymentsRecorded.map((payment) => `Estimated tax payment recorded: ${escapeHtml(payment.description)}${payment.amount != null ? ` • ${escapeHtml(formatCurrency(payment.amount) || '')}` : ''}.`),
            tax.journalEntriesThisWeek > 0 ? `${tax.journalEntriesThisWeek} bookkeeping entr${tax.journalEntriesThisWeek === 1 ? 'y' : 'ies'} recorded this week.` : null,
          ].filter(Boolean), (line) => line)}
        </ul>
      </section>
  ` : '';

  const macroRateLines = macro?.available ? [
    macro.fedFundsRate != null ? `Fed funds rate ${escapeHtml(String(macro.fedFundsRate))}${String(macro.fedFundsRate).includes('%') ? '' : '%'}.` : null,
    macro.mortgageRate != null ? `Mortgage rate ${escapeHtml(String(macro.mortgageRate))}${String(macro.mortgageRate).includes('%') ? '' : '%'}.` : null,
    macro.inflationRate != null ? `Inflation ${escapeHtml(String(macro.inflationRate))}${String(macro.inflationRate).includes('%') ? '' : '%'}.` : null,
    macro.unemploymentRate != null ? `Unemployment ${escapeHtml(String(macro.unemploymentRate))}${String(macro.unemploymentRate).includes('%') ? '' : '%'}.` : null,
    macro.yieldCurve ? `Yield curve ${escapeHtml(String(macro.yieldCurve))}${macro.rateEnvironment ? ` • environment ${escapeHtml(String(macro.rateEnvironment).toLowerCase())}` : ''}.` : null,
    macro.medianHomePrice != null ? `National median home price ${escapeHtml(formatCurrency(macro.medianHomePrice) || String(macro.medianHomePrice))}.` : null,
  ].filter(Boolean) : [];

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; line-height: 1.55; max-width: 760px; margin: 0 auto; padding: 24px;">
      <h1 style="margin: 0 0 8px; font-size: 28px;">${escapeHtml(draft.subject)}</h1>
      <p style="margin: 0 0 20px; color: #4b5563;">Hi ${greetingName}, here is your HouseYield weekly recap for ${escapeHtml(digest.window.label)}.</p>

      ${renderNarrativeHtml(narrative)}
      ${financialWeekSection}
      ${propertyValueSection}
      ${leasesSection}

      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Properties</h2>
        ${renderSectionInsight(insights.properties)}
        <ul style="padding-left: 18px; margin: 0;">
          ${renderHtmlList(propertyItems, (property) => {
            const parts = [
              `<strong>${escapeHtml(property.address || property.id)}</strong>`,
              property.monthlyRent != null ? `rent ${escapeHtml(formatCurrency(property.monthlyRent) || '')}/mo` : null,
              property.propertyValue != null ? `estimated value ${escapeHtml(formatCurrency(property.propertyValue) || '')}` : null,
              property.cachedAttom?.summary?.rental_avm ? `ATTOM rental AVM ${escapeHtml(formatCurrency(property.cachedAttom.summary.rental_avm) || '')}/mo` : null,
              property.occupancyStatus ? `status ${escapeHtml(property.occupancyStatus)}` : null,
            ].filter(Boolean);
            return `${parts.join(' • ')}.`;
          })}
        </ul>
      </section>

      ${activitySection}
      ${pricingPowerSection}

      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Regional Market Snapshot</h2>
        ${renderSectionInsight(insights.regionalMarkets)}
        <ul style="padding-left: 18px; margin: 0;">
          ${renderHtmlList(zipRegions, (region) => {
            const rentcast = region.rentcast?.derived || {};
            const attom = region.attom || {};
            const appreciation = attom?.appreciation?.appreciationPercent;
            const latestMedianSale = attom?.appreciation?.endPrice || attom?.salesTrend?.data?.trendPoints?.slice(-1)?.[0]?.medianSalePrice;
            const parts = [
              `<strong>ZIP ${escapeHtml(region.zipCode)}</strong>`,
              rentcast?.medianAskingRent != null ? `median asking rent ${escapeHtml(formatCurrency(rentcast.medianAskingRent) || '')}` : null,
              rentcast?.grossYieldPct != null ? `gross yield ${escapeHtml(formatPercent(rentcast.grossYieldPct) || '')}` : null,
              latestMedianSale != null ? `ATTOM median sale ${escapeHtml(formatCurrency(latestMedianSale) || '')}` : null,
              appreciation != null ? `ATTOM appreciation ${escapeHtml(formatPercent(appreciation) || '')}` : null,
            ].filter(Boolean);
            return `${parts.join(' • ')}.`;
          })}
          ${renderHtmlList(metroRegions, (metro) => {
            const summary = metro?.data?.summary || {};
            const parts = [
              `<strong>${escapeHtml(metro.name)}</strong>`,
              summary.avgMedianAskingRent != null ? `avg median asking rent ${escapeHtml(formatCurrency(summary.avgMedianAskingRent) || '')}` : null,
              summary.avgMedianSalePrice != null ? `avg median sale ${escapeHtml(formatCurrency(summary.avgMedianSalePrice) || '')}` : null,
              summary.avgGrossYieldPct != null ? `avg gross yield ${escapeHtml(formatPercent(summary.avgGrossYieldPct) || '')}` : null,
            ].filter(Boolean);
            return `${parts.join(' • ')}.`;
          })}
        </ul>
      </section>

      ${listingsSection}

      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">Macro and Market Context</h2>
        ${renderSectionInsight(insights.macro)}
        <ul style="padding-left: 18px; margin: 0;">
          ${macroRateLines.map((line) => `<li>${line}</li>`).join('')}
          ${renderHtmlList(topHeadlines.slice(0, 4), (headline) => `${escapeHtml(headline.title || '')}${headline.topic ? ` (${escapeHtml(headline.topic)})` : ''}.`)}
        </ul>
      </section>

      ${taxSection}

      <section style="margin: 0 0 22px;">
        <h2 style="font-size: 18px; margin: 0 0 10px;">What HouseYield Learned About Your Focus</h2>
        <ul style="padding-left: 18px; margin: 0;">
          ${renderHtmlList(memory?.searchMemory || [], (item) => escapeHtml(item))}
          ${renderHtmlList(memory?.recentSessions || [], (session) => escapeHtml(session.summary || 'Recent assistant session saved.'))}
        </ul>
      </section>

      ${webBriefs.length > 0 ? `
        <section style="margin: 0 0 22px;">
          <h2 style="font-size: 18px; margin: 0 0 10px;">Additional Web Signals</h2>
          ${webBriefs.map((brief) => `
            <div style="margin-bottom: 12px;">
              <div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(brief.query)}</div>
              <ul style="padding-left: 18px; margin: 0;">
                ${renderHtmlList(brief.results || [], (result) => `${escapeHtml(result.title)}${result.displayLink ? ` — ${escapeHtml(result.displayLink)}` : ''}`)}
              </ul>
            </div>
          `).join('')}
        </section>
      ` : ''}
    </div>
  `;
}

export function renderWeeklyDigestText(digest) {
  const lines = [
    digest.draft.subject,
    '',
    `Hi ${digest.recipient.displayName || 'there'},`,
    `Here is your HouseYield weekly recap for ${digest.window.label}.`,
  ];

  if (digest.narrative) {
    lines.push('', 'Your AI weekly briefing:', digest.narrative.executiveSummary);
    if (digest.narrative.personalNote) {
      lines.push(digest.narrative.personalNote);
    }
    if (digest.narrative.actionItems?.length > 0) {
      lines.push('', 'Action items:');
      for (const item of digest.narrative.actionItems) {
        lines.push(`- ${item}`);
      }
    }
  }

  if (digest.financialWeek?.available) {
    const financialWeek = digest.financialWeek;
    lines.push('', 'Money this week:');
    lines.push(`- Rent collected: ${formatCurrency(financialWeek.rentCollected)}${financialWeek.expectedMonthlyRent ? ` (expected ${formatCurrency(financialWeek.expectedMonthlyRent)}/mo across leases)` : ''}`);
    if (financialWeek.otherIncome > 0) {
      lines.push(`- Other income: ${formatCurrency(financialWeek.otherIncome)}`);
    }
    lines.push(`- Expenses posted: ${formatCurrency(financialWeek.totalExpenses)}`);
    for (const entry of financialWeek.topExpenseCategories) {
      lines.push(`  • ${entry.category}: ${formatCurrency(entry.amount)}`);
    }
    lines.push(`- Net cash flow: ${formatCurrency(financialWeek.netCashFlow)}`);
  }

  if (digest.propertyValue?.available) {
    const propertyValue = digest.propertyValue;
    const changeText = propertyValue.weekChange != null
      ? ` (${propertyValue.weekChange >= 0 ? '+' : '-'}${formatCurrency(Math.abs(propertyValue.weekChange))} this week)`
      : '';
    lines.push('', `Property value: ${formatCurrency(propertyValue.propertyValue)}${changeText}`);
  }

  if (digest.leases?.ok && digest.leases.hasUpdates) {
    lines.push('', 'Leases & tenants:');
    for (const lease of digest.leases.expiringLeases) {
      lines.push(`- Lease expiring in ${lease.daysUntil} day${lease.daysUntil === 1 ? '' : 's'}: ${lease.tenantName}${lease.address ? ` at ${lease.address}` : ''}${lease.monthlyRent != null ? ` (${formatCurrency(lease.monthlyRent)}/mo)` : ''}`);
    }
    for (const lease of digest.leases.newLeases) {
      lines.push(`- New lease started: ${lease.tenantName}${lease.address ? ` at ${lease.address}` : ''}`);
    }
  }

  lines.push('', 'Properties:');
  for (const property of digest.properties) {
    const parts = [
      property.address || property.id,
      property.monthlyRent != null ? `rent ${formatCurrency(property.monthlyRent)}/mo` : null,
      property.propertyValue != null ? `value ${formatCurrency(property.propertyValue)}` : null,
      property.cachedAttom?.summary?.rental_avm ? `ATTOM rental AVM ${formatCurrency(property.cachedAttom.summary.rental_avm)}/mo` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(' • ')}`);
  }

  if (digest.managementActivity?.ok && digest.managementActivity.hasActivity) {
    const activity = digest.managementActivity;
    lines.push('', 'Property management activity:');
    for (const request of activity.newMaintenanceRequests) {
      lines.push(`- New maintenance request: ${request.title}${request.tenantName ? ` from ${request.tenantName}` : ''} (${request.status})`);
    }
    for (const message of activity.newMessages) {
      lines.push(`- Tenant message${message.tenantName ? ` from ${message.tenantName}` : ''}: ${message.preview}`);
    }
    if (activity.collectedThisWeek > 0) {
      lines.push(`- Rent collected this week: ${formatCurrency(activity.collectedThisWeek)} (${activity.paymentsThisWeek.length} payment${activity.paymentsThisWeek.length === 1 ? '' : 's'})`);
    }
    if (activity.openMaintenanceCount > 0) {
      lines.push(`- Open maintenance requests: ${activity.openMaintenanceCount}`);
    }
    if (activity.unreadMessageCount > 0) {
      lines.push(`- Unread tenant messages: ${activity.unreadMessageCount}`);
    }
  }

  if (digest.pricingPower?.properties?.length > 0) {
    lines.push('', 'Rental pricing power:');
    for (const entry of digest.pricingPower.properties) {
      const positionText = entry.position === 'below_market'
        ? `below market — headroom ${formatCurrency(entry.pricingPowerDollar)}/mo (${formatPercent(entry.pricingPowerPercent, 1)})`
        : entry.position === 'above_market'
          ? 'above market'
          : 'at market';
      lines.push(`- ${entry.address || `ZIP ${entry.zipCode}`}: rent ${formatCurrency(entry.currentRent)}/mo vs ZIP median ${formatCurrency(entry.marketMedianRent)}/mo — ${positionText}`);
    }
  }

  lines.push('', 'Regional market snapshot:');
  for (const region of digest.regional.zipRegions) {
    const parts = [
      `ZIP ${region.zipCode}`,
      region.rentcast?.derived?.medianAskingRent != null ? `median rent ${formatCurrency(region.rentcast.derived.medianAskingRent)}` : null,
      region.rentcast?.derived?.grossYieldPct != null ? `gross yield ${formatPercent(region.rentcast.derived.grossYieldPct)}` : null,
      region.attom?.appreciation?.appreciationPercent != null ? `ATTOM appreciation ${formatPercent(region.attom.appreciation.appreciationPercent)}` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(' • ')}`);
  }

  const listingRegions = (digest.listingsWatch?.regions || []).filter((region) => region.ok && region.newListingCount > 0);
  if (listingRegions.length > 0) {
    lines.push('', 'New listings in your regions of interest:');
    for (const region of listingRegions) {
      lines.push(`- ZIP ${region.zipCode}: ${region.newListingCount} new listing${region.newListingCount === 1 ? '' : 's'} this week`);
      for (const listing of region.listings || []) {
        lines.push(`  • ${listing.address || 'New listing'}${listing.price != null ? ` — ${formatCurrency(listing.price)}` : ''}${listing.bedrooms != null ? ` — ${listing.bedrooms} bd` : ''}${listing.bathrooms != null ? `/${listing.bathrooms} ba` : ''}`);
      }
    }
  }

  if (digest.macro?.available) {
    lines.push('', 'Macro and market context:');
    if (digest.macro.fedFundsRate != null) lines.push(`- Fed funds rate: ${digest.macro.fedFundsRate}`);
    if (digest.macro.mortgageRate != null) lines.push(`- Mortgage rate: ${digest.macro.mortgageRate}`);
    if (digest.macro.inflationRate != null) lines.push(`- Inflation: ${digest.macro.inflationRate}`);
    for (const headline of (digest.macro.headlines || []).slice(0, 4)) {
      lines.push(`- ${headline.title}`);
    }
  }

  if (digest.tax?.ok) {
    const taxLines = [
      ...digest.tax.upcomingDeadlines.map((deadline) => `- ${deadline.name}: due ${deadline.date} (${deadline.daysUntil} days away)`),
      ...digest.tax.newDocuments.map((document) => `- New document ready: ${document.name}`),
      ...digest.tax.estimatedPaymentsRecorded.map((payment) => `- Estimated tax payment recorded: ${payment.description}${payment.amount != null ? ` (${formatCurrency(payment.amount)})` : ''}`),
    ];
    if (digest.tax.journalEntriesThisWeek > 0) {
      taxLines.push(`- Bookkeeping entries recorded this week: ${digest.tax.journalEntriesThisWeek}`);
    }
    if (taxLines.length > 0) {
      lines.push('', 'Tax and bookkeeping:', ...taxLines);
    }
  }

  if (digest.memory.searchMemory.length > 0) {
    lines.push('', 'Search and preference memory:');
    for (const item of digest.memory.searchMemory) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join('\n');
}

async function logWeeklyDigestEvent(entry) {
  try {
    const db = getFirestore();
    const admin = getAdmin();
    await db.collection(DIGEST_LOG_COLLECTION).add({
      ...entry,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.warn('[WeeklyDigest] Failed to log digest event:', error.message);
  }
}

export async function getAssistantWeeklyDigestPreferences({ userId, userRecord, now = new Date() } = {}) {
  const resolvedUserRecord = userRecord || await loadUserRecord(userId);
  const fallbackTimeZone = getUserTimeZoneFallback(resolvedUserRecord);
  return normalizeWeeklyDigestPreferences(resolvedUserRecord?.[DIGEST_PREFERENCES_FIELD], {
    fallbackTimeZone,
    now,
  });
}

export async function updateAssistantWeeklyDigestPreferences({ userId, updates = {}, now = new Date() } = {}) {
  if (!userId) {
    throw new Error('weekly_digest_user_required');
  }

  const db = getFirestore();
  const docRef = db.collection('users').doc(userId);
  const snapshot = await docRef.get();
  const userRecord = snapshot.exists ? { id: snapshot.id, ...(snapshot.data() || {}) } : { id: userId };
  const existingPreferences = await getAssistantWeeklyDigestPreferences({ userRecord, now });
  const mergedPreferences = normalizeWeeklyDigestPreferences(
    mergeWeeklyDigestPreferences(existingPreferences, updates),
    {
      fallbackTimeZone: getUserTimeZoneFallback(userRecord),
      now,
    },
  );

  await docRef.set({
    [DIGEST_PREFERENCES_FIELD]: mergedPreferences,
  }, { merge: true });

  return mergedPreferences;
}

export async function buildAssistantWeeklyDigest({
  userId,
  fallbackRecipientEmail = '',
  includeFinancialDetails,
  includeGlobalContext,
  includeWebSearch,
  preferencesOverride = null,
  now = new Date(),
} = {}) {
  if (!userId) {
    throw new Error('weekly_digest_user_required');
  }

  const weekWindow = buildWeekWindow(now);
  const [userRecord, propertyRecords] = await Promise.all([
    loadUserRecord(userId),
    loadOwnerProperties(userId).catch(() => []),
  ]);

  const storedPreferences = await getAssistantWeeklyDigestPreferences({ userRecord, now });
  const effectivePreferences = preferencesOverride
    ? normalizeWeeklyDigestPreferences(
      mergeWeeklyDigestPreferences(storedPreferences, preferencesOverride),
      {
        fallbackTimeZone: getUserTimeZoneFallback(userRecord),
        now,
      },
    )
    : storedPreferences;
  const resolvedIncludeFinancialDetails = includeFinancialDetails === undefined
    ? effectivePreferences.includeFinancialDetails
    : includeFinancialDetails;
  const resolvedIncludeGlobalContext = includeGlobalContext === undefined
    ? effectivePreferences.includeGlobalContext
    : includeGlobalContext;
  const resolvedIncludeWebSearch = includeWebSearch === undefined
    ? effectivePreferences.includeWebSearch
    : includeWebSearch;
  const buildAssistantCanonicalContext = await loadCanonicalContextBuilder();
  const canonicalContext = await buildAssistantCanonicalContext({
    userId,
    includeFinancialDetails: resolvedIncludeFinancialDetails,
    includeGlobalContext: resolvedIncludeGlobalContext,
  });

  const recipientEmail = String(
    getNested(userRecord, ['email', 'contact.email', 'profile.email'])
    || fallbackRecipientEmail
    || '',
  ).trim();
  const displayName = getUserDisplayName(userRecord, recipientEmail);
  const assistantMemoryProfile = userRecord?.assistantMemoryProfile || {};
  const searchMemory = Array.isArray(assistantMemoryProfile?.realEstateSearchMemory)
    ? assistantMemoryProfile.realEstateSearchMemory.map((item) => clipText(item, 120)).filter(Boolean)
    : [];
  const recentSessions = Array.isArray(userRecord?.assistantMemoryRecentSessions)
    ? userRecord.assistantMemoryRecentSessions.slice(0, 4)
    : [];

  const normalizedProperties = dedupeBy(
    propertyRecords.map((property) => normalizePropertyRecord(property)).filter((property) => property.id),
    (property) => property.id,
  ).slice(0, DEFAULT_PROPERTY_LIMIT);

  const propertyAttomCache = await Promise.all(normalizedProperties.map(async (property) => ({
    propertyId: property.id,
    cachedAttom: property.address ? await getCachedAttomData(property.address).catch(() => null) : null,
  })));

  const propertyCacheById = new Map(propertyAttomCache.map((entry) => [entry.propertyId, entry.cachedAttom]));
  const properties = normalizedProperties.map((property) => ({
    ...property,
    cachedAttom: propertyCacheById.get(property.id)?.data || null,
  }));

  const regional = await buildRegionalDigest({
    properties: propertyRecords,
    searchMemory,
    weekWindow,
    includeWebSearch: resolvedIncludeWebSearch,
    watchedZipCodes: effectivePreferences.watchedZipCodes,
  });

  if (resolvedIncludeWebSearch && regional.webBriefs.length === 0) {
    const fallbackQueries = buildWebSearchQueries({ metroMatches: [] });
    regional.webBriefs = await Promise.all(fallbackQueries.map(async (query) => {
      try {
        const result = await runGoogleCustomSearch(query, 3);
        return { query, results: result.results || [] };
      } catch (error) {
        return { query, error: error.message || 'google_search_failed', results: [] };
      }
    }));
  }

  const macro = buildMacroDigest(canonicalContext);
  const pricingPower = buildPricingPowerDigest({
    properties,
    zipRegions: regional.zipRegions,
  });
  const listingZips = dedupeBy(
    [...effectivePreferences.watchedZipCodes, ...regional.propertyZips],
    (zipCode) => zipCode,
  );

  const leases = buildLeaseTenantDigest({ propertyRecords, weekWindow, now });

  const [managementActivity, propertyValue, financialWeek, tax, listingsWatch] = await Promise.all([
    effectivePreferences.includeManagementActivity
      ? buildManagementActivityDigest({ userId, weekWindow }).catch((error) => ({ ok: false, error: error.message }))
      : Promise.resolve(null),
    buildPropertyValueDigest({ userId, now }).catch((error) => ({ ok: false, available: false, error: error.message })),
    buildFinancialWeekDigest({ userId, weekWindow, expectedMonthlyRent: leases.expectedMonthlyRent })
      .catch((error) => ({ ok: false, available: false, error: error.message })),
    effectivePreferences.includeTaxUpdates
      ? buildTaxDigest({ userId, weekWindow, now }).catch((error) => ({ ok: false, error: error.message }))
      : Promise.resolve(null),
    effectivePreferences.includeListingsWatch
      ? buildListingsWatchDigest({ zipCodes: listingZips }).catch((error) => ({ ok: false, regions: [], error: error.message }))
      : Promise.resolve(null),
  ]);

  const subject = `HouseYield Weekly Recap • ${displayName} • ${weekWindow.label}`;
  const digest = {
    generatedAt: now.toISOString(),
    window: {
      startDate: weekWindow.startDate,
      endDate: weekWindow.endDate,
      label: weekWindow.label,
    },
    recipient: {
      userId,
      displayName,
      email: recipientEmail || null,
    },
    preferences: effectivePreferences,
    canonicalContext,
    memory: {
      userPreferences: Array.isArray(assistantMemoryProfile?.userPreferences) ? assistantMemoryProfile.userPreferences.slice(0, 4) : [],
      searchMemory,
      recentSessions,
    },
    properties,
    regional,
    macro,
    pricingPower,
    managementActivity,
    financialWeek,
    propertyValue,
    leases,
    tax,
    listingsWatch,
    narrative: null,
    draft: {
      subject,
    },
  };

  if (effectivePreferences.includeAiNarrative) {
    const narrativeResult = await generateWeeklyDigestNarrative(digest);
    if (narrativeResult.ok && narrativeResult.narrative) {
      digest.narrative = narrativeResult.narrative;
      if (narrativeResult.narrative.subject) {
        digest.draft.subject = narrativeResult.narrative.subject;
      }
    } else {
      digest.narrativeError = narrativeResult.error || 'narrative_unavailable';
      console.warn(`[WeeklyDigest] AI narrative unavailable for ${userId}:`, digest.narrativeError);
    }
  }

  digest.draft.html = renderWeeklyDigestHtml(digest);
  digest.draft.text = renderWeeklyDigestText(digest);
  digest.draft.preview = clipText(digest.draft.text, 400);

  return digest;
}

/**
 * Strip server-only bulk (canonical context, full email bodies) before sending
 * digest JSON to the dashboard recap card or other lightweight clients.
 */
export function sanitizeDigestForClient(digest) {
  if (!digest || typeof digest !== 'object') {
    return digest;
  }

  const { canonicalContext: _canonicalContext, ...rest } = digest;
  return {
    ...rest,
    draft: digest.draft
      ? {
        subject: digest.draft.subject,
        preview: digest.draft.preview,
      }
      : digest.draft,
  };
}

export async function sendAssistantWeeklyDigest({
  userId,
  to,
  fallbackRecipientEmail = '',
  includeFinancialDetails,
  includeGlobalContext,
  includeWebSearch,
  preferencesOverride = null,
  now = new Date(),
} = {}) {
  const digest = await buildAssistantWeeklyDigest({
    userId,
    fallbackRecipientEmail,
    includeFinancialDetails,
    includeGlobalContext,
    includeWebSearch,
    preferencesOverride,
    now,
  });

  const recipient = String(to || digest.preferences?.recipientEmail || digest.recipient.email || '').trim();
  if (!recipient) {
    throw new Error('weekly_digest_recipient_required');
  }

  const sendResult = await sendSecureGmail({
    to: recipient,
    subject: digest.draft.subject,
    html: digest.draft.html,
    // Match the platform-wide sender fallback used by email-service.js.
    from: process.env.GMAIL_SENDER_EMAIL || process.env.HOUSEYIELD_EMAIL_ADDRESS || undefined,
  });

  await logWeeklyDigestEvent({
    userId,
    recipient,
    subject: digest.draft.subject,
    includeFinancialDetails,
    includeGlobalContext,
    includeWebSearch,
    ok: sendResult?.ok === true,
    error: sendResult?.ok === true ? null : (sendResult?.error || 'weekly_digest_send_failed'),
    draftPreview: digest.draft.preview,
    sourceSummary: {
      propertyCount: digest.properties.length,
      zipRegionCount: digest.regional.zipRegions.length,
      metroRegionCount: digest.regional.metroRegions.length,
      webBriefCount: digest.regional.webBriefs.length,
      aiNarrative: Boolean(digest.narrative),
      narrativeModel: digest.narrative?.model || null,
      narrativeError: digest.narrativeError || null,
      managementActivity: digest.managementActivity?.ok === true,
      financialWeekAvailable: digest.financialWeek?.available === true,
      propertyValueAvailable: digest.propertyValue?.available === true,
      leaseUpdates: digest.leases?.hasUpdates === true,
      taxUpdates: digest.tax?.ok === true,
      newListingCount: digest.listingsWatch?.totalNewListings || 0,
    },
  });

  return {
    ok: sendResult?.ok === true,
    sendResult,
    digest,
  };
}

export async function runAssistantWeeklyDigestBatch({
  userId,
  now = new Date(),
  dryRun = false,
  force = false,
  limit = 100,
  reason = 'manual',
} = {}) {
  const db = getFirestore();
  const users = [];

  if (userId) {
    users.push(await loadUserRecord(userId));
  } else {
    const snapshot = await db
      .collection('users')
      .where(`${DIGEST_PREFERENCES_FIELD}.enabled`, '==', true)
      .limit(Math.max(1, limit))
      .get();
    users.push(...snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })));
  }

  const summary = {
    ok: true,
    reason,
    dryRun,
    force,
    scanned: users.length,
    eligible: 0,
    matched: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    results: [],
  };

  for (const userRecord of users) {
    const preferences = await getAssistantWeeklyDigestPreferences({ userRecord, now });
    const dueState = force
      ? {
        due: true,
        weekdayMatches: true,
        withinWindow: true,
        alreadySentToday: false,
        snapshot: getLocalScheduleSnapshot(now, preferences.schedule.timeZone),
      }
      : isWeeklyDigestDue(preferences, now);
    const enabled = preferences.enabled || force;

    if (!enabled) {
      summary.results.push({
        userId: userRecord.id,
        status: 'skipped',
        reason: 'disabled',
      });
      continue;
    }

    summary.eligible += 1;
    if (!dueState.due) {
      summary.results.push({
        userId: userRecord.id,
        status: 'skipped',
        reason: dueState.alreadySentToday ? 'already_sent_today' : 'not_due',
        localDate: dueState.snapshot.localDate,
        localTime: `${String(dueState.snapshot.localHour).padStart(2, '0')}:${String(dueState.snapshot.localMinute).padStart(2, '0')}`,
        timeZone: preferences.schedule.timeZone,
      });
      continue;
    }

    summary.matched += 1;
    const recipient = String(preferences.recipientEmail || userRecord?.email || '').trim() || null;

    if (dryRun) {
      summary.results.push({
        userId: userRecord.id,
        status: 'dry_run',
        recipient,
        localDate: dueState.snapshot.localDate,
        localTime: `${String(dueState.snapshot.localHour).padStart(2, '0')}:${String(dueState.snapshot.localMinute).padStart(2, '0')}`,
        timeZone: preferences.schedule.timeZone,
      });
      continue;
    }

    summary.attempted += 1;
    try {
      const result = await sendAssistantWeeklyDigest({
        userId: userRecord.id,
        to: recipient || '',
        fallbackRecipientEmail: userRecord?.email || '',
        includeFinancialDetails: preferences.includeFinancialDetails,
        includeGlobalContext: preferences.includeGlobalContext,
        includeWebSearch: preferences.includeWebSearch,
        preferencesOverride: preferences,
        now,
      });

      if (result.ok) {
        summary.sent += 1;
        await updateAssistantWeeklyDigestPreferences({
          userId: userRecord.id,
          updates: {
            lastAttemptAt: now.toISOString(),
            lastSentAt: now.toISOString(),
            lastSentLocalDate: dueState.snapshot.localDate,
            lastError: null,
          },
          now,
        });
        summary.results.push({
          userId: userRecord.id,
          status: 'sent',
          recipient,
          localDate: dueState.snapshot.localDate,
          timeZone: preferences.schedule.timeZone,
        });
      } else {
        summary.failed += 1;
        await updateAssistantWeeklyDigestPreferences({
          userId: userRecord.id,
          updates: {
            lastAttemptAt: now.toISOString(),
            lastError: result.sendResult?.error || 'weekly_digest_send_failed',
          },
          now,
        });
        summary.results.push({
          userId: userRecord.id,
          status: 'failed',
          recipient,
          error: result.sendResult?.error || 'weekly_digest_send_failed',
        });
      }
    } catch (error) {
      summary.failed += 1;
      await updateAssistantWeeklyDigestPreferences({
        userId: userRecord.id,
        updates: {
          lastAttemptAt: now.toISOString(),
          lastError: error.message || 'weekly_digest_send_failed',
        },
        now,
      });
      summary.results.push({
        userId: userRecord.id,
        status: 'failed',
        recipient,
        error: error.message || 'weekly_digest_send_failed',
      });
    }
  }

  summary.ok = summary.failed === 0;
  return summary;
}