/**
 * Weekly Digest Sections
 *
 * Data collectors for the AI weekly report email. Each builder is defensive:
 * it returns a normalized section object and never throws, so a single broken
 * data source cannot block the Sunday send.
 */

import { getFirestore } from '../firebase-admin.js';
import { getTaxCalendar } from '../tax-engine-firestore.js';
import { searchSaleListings } from '../rentcast.js';

// tenant-activity-service initializes Firebase Admin at module load, so we
// import it lazily to keep this module (and the CLI batch runner) import-safe
// until credentials are actually needed.
let tenantActivityModulePromise = null;
function loadTenantActivityService() {
  if (!tenantActivityModulePromise) {
    tenantActivityModulePromise = import('../tenant-activity-service.js');
  }
  return tenantActivityModulePromise;
}

const WEEKLY_LISTINGS_DAYS_OLD = 8;
const WEEKLY_LISTINGS_PER_REGION = 4;
const MAX_LISTING_REGIONS = 4;
const MAX_ACTIVITY_ITEMS = 8;
const MAX_TAX_DEADLINES = 3;
const MAX_NEW_DOCUMENTS = 5;

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

function toDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isWithinWindow(value, weekWindow) {
  const date = toDate(value);
  if (!date) return false;
  return date >= weekWindow.start && date <= weekWindow.end;
}

// ─── Property management activity ────────────────────────────────────────────

export async function buildManagementActivityDigest({ userId, weekWindow }) {
  const {
    getOwnerMaintenanceRequests,
    getOwnerMessages,
    getOwnerPaymentHistory,
  } = await loadTenantActivityService();

  const [maintenanceResult, messagesResult, paymentsResult] = await Promise.allSettled([
    getOwnerMaintenanceRequests(userId),
    getOwnerMessages(userId),
    getOwnerPaymentHistory(userId),
  ]);

  const maintenance = maintenanceResult.status === 'fulfilled' && maintenanceResult.value?.ok
    ? maintenanceResult.value
    : { requests: [], totalPending: 0 };
  const messages = messagesResult.status === 'fulfilled' && messagesResult.value?.ok
    ? messagesResult.value
    : { messages: [], totalUnread: 0 };
  const payments = paymentsResult.status === 'fulfilled' && paymentsResult.value?.ok
    ? paymentsResult.value
    : { payments: [], totalCollected: 0 };

  const newMaintenance = (maintenance.requests || [])
    .filter((request) => isWithinWindow(request.createdAt, weekWindow))
    .slice(0, MAX_ACTIVITY_ITEMS)
    .map((request) => ({
      id: request.id,
      title: clipText(request.title || request.issue || request.description || 'Maintenance request', 110),
      status: clipText(request.status || 'pending', 30),
      tenantName: clipText(request.tenantName || request.tenantEmail || '', 60) || null,
      unit: clipText(request.unit || '', 30) || null,
      createdAt: toDate(request.createdAt)?.toISOString() || null,
    }));

  const openMaintenance = (maintenance.requests || [])
    .filter((request) => !['completed', 'closed', 'resolved', 'cancelled'].includes(String(request.status || '').toLowerCase()));

  const weekPayments = (payments.payments || [])
    .filter((payment) => isWithinWindow(payment.paymentDate || payment.createdAt, weekWindow));
  const weekCollected = weekPayments
    .filter((payment) => String(payment.status || '').toLowerCase() === 'completed')
    .reduce((sum, payment) => sum + (safeNumber(payment.amount) || 0), 0);

  const newMessages = (messages.messages || [])
    .filter((message) => isWithinWindow(message.createdAt, weekWindow))
    .slice(0, MAX_ACTIVITY_ITEMS)
    .map((message) => ({
      id: message.id,
      preview: clipText(message.subject || message.message || message.body || 'Tenant message', 120),
      tenantName: clipText(message.tenantName || message.tenantEmail || '', 60) || null,
      status: clipText(message.status || '', 20) || null,
    }));

  return {
    ok: true,
    newMaintenanceRequests: newMaintenance,
    openMaintenanceCount: openMaintenance.length,
    pendingMaintenanceCount: maintenance.totalPending || 0,
    newMessages,
    unreadMessageCount: messages.totalUnread || 0,
    paymentsThisWeek: weekPayments.slice(0, MAX_ACTIVITY_ITEMS).map((payment) => ({
      id: payment.id,
      amount: safeNumber(payment.amount),
      status: clipText(payment.status || '', 20) || null,
      tenantName: clipText(payment.tenantName || payment.tenantEmail || '', 60) || null,
      paymentDate: toDate(payment.paymentDate || payment.createdAt)?.toISOString() || null,
    })),
    collectedThisWeek: weekCollected,
    hasActivity: newMaintenance.length > 0
      || newMessages.length > 0
      || weekPayments.length > 0
      || openMaintenance.length > 0,
  };
}

// ─── Property value trajectory ────────────────────────────────────────────────

export async function buildPropertyValueDigest({ userId, now = new Date() }) {
  try {
    const db = getFirestore();

    // Prefer summing real-estate AVMs from owner properties — never total portfolio
    // snapshots that blend stocks and other personal-finance assets.
    const propertyQueries = await Promise.allSettled([
      db.collection('properties').where('ownerId', '==', userId).limit(25).get(),
      db.collection('properties').where('userId', '==', userId).limit(25).get(),
    ]);

    const propertyDocs = [];
    for (const result of propertyQueries) {
      if (result.status !== 'fulfilled') continue;
      for (const doc of result.value.docs) {
        propertyDocs.push({ id: doc.id, ...(doc.data() || {}) });
      }
    }

    const dedupedProperties = [...new Map(propertyDocs.map((property) => [property.id, property])).values()];
    if (dedupedProperties.length > 0) {
      const totalValue = dedupedProperties.reduce((sum, property) => {
        const financials = property.financials || property.financial_data || {};
        const summary = property.propertyData?.summary || property.property_data?.summary || property.summary || {};
        const value = safeNumber(financials.currentValue)
          ?? safeNumber(financials.propertyValue)
          ?? safeNumber(summary.avm_value)
          ?? safeNumber(summary.market_value);
        return sum + (value || 0);
      }, 0);

      if (totalValue > 0) {
        return {
          ok: true,
          available: true,
          asOf: now.toISOString(),
          propertyValue: Math.round(totalValue),
          weekChange: null,
          weekChangePercent: null,
          source: 'owner_properties_avm',
        };
      }
    }

    const snapshot = await db
      .collection('portfolios')
      .doc(userId)
      .collection('snapshots')
      .orderBy('date', 'desc')
      .limit(60)
      .get();

    const snapshots = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    const resolvePropertyValue = (entry) => safeNumber(entry?.assets?.realEstate);

    const latest = snapshots.find((entry) => resolvePropertyValue(entry) !== null);
    if (!latest) {
      return { ok: true, available: false };
    }

    const latestDate = toDate(latest.date) || now;
    const weekAgoTarget = new Date(latestDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const priorWeek = snapshots.find((entry) => {
      const entryDate = toDate(entry.date);
      return entryDate && entryDate <= weekAgoTarget && resolvePropertyValue(entry) !== null;
    }) || null;

    const latestValue = resolvePropertyValue(latest);
    const priorValue = priorWeek && priorWeek.id !== latest.id ? resolvePropertyValue(priorWeek) : null;
    const change = priorValue !== null ? latestValue - priorValue : null;
    const changePercent = priorValue ? (change / Math.abs(priorValue)) * 100 : null;

    return {
      ok: true,
      available: true,
      asOf: latestDate.toISOString(),
      propertyValue: latestValue,
      totalLiabilities: safeNumber(latest.totalLiabilities),
      weekChange: change,
      weekChangePercent: changePercent,
      source: 'portfolio_snapshots_real_estate_only',
    };
  } catch (error) {
    return { ok: false, available: false, error: error.message || 'property_value_unavailable' };
  }
}

// ─── Money this week (bookkeeping ledger) ─────────────────────────────────────

const RENT_PATTERN = /rent(?!al pricing)/i;
const MAX_EXPENSE_CATEGORIES = 5;

function classifyJournalEntry(entry) {
  const explicitType = String(entry?.type || '').toLowerCase();
  if (explicitType === 'income' || explicitType === 'expense') {
    return explicitType;
  }
  const amount = safeNumber(entry?.amount ?? entry?.total);
  const text = `${entry?.category || ''} ${entry?.description || ''} ${entry?.memo || ''}`;
  if (RENT_PATTERN.test(text) || /income|deposit|payment received/i.test(text)) {
    return 'income';
  }
  if (amount !== null && amount < 0) {
    return 'expense';
  }
  return 'expense';
}

export async function buildFinancialWeekDigest({ userId, weekWindow, expectedMonthlyRent = null }) {
  try {
    const db = getFirestore();
    const entriesSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('bookkeeping')
      .doc('data')
      .collection('journalEntries')
      .limit(500)
      .get();

    const entries = entriesSnapshot.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
      .filter((entry) => isWithinWindow(entry.date || entry.createdAt, weekWindow));

    let rentCollected = 0;
    let otherIncome = 0;
    let totalExpenses = 0;
    const expenseByCategory = new Map();

    for (const entry of entries) {
      const amount = Math.abs(safeNumber(entry.amount ?? entry.total) ?? 0);
      if (amount === 0) continue;
      const kind = classifyJournalEntry(entry);
      const text = `${entry.category || ''} ${entry.description || ''} ${entry.memo || ''}`;

      if (kind === 'income') {
        if (RENT_PATTERN.test(text)) {
          rentCollected += amount;
        } else {
          otherIncome += amount;
        }
      } else {
        totalExpenses += amount;
        const category = clipText(entry.category || entry.description || 'Uncategorized', 60) || 'Uncategorized';
        expenseByCategory.set(category, (expenseByCategory.get(category) || 0) + amount);
      }
    }

    const topExpenseCategories = [...expenseByCategory.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_EXPENSE_CATEGORIES)
      .map(([category, amount]) => ({ category, amount: Math.round(amount) }));

    return {
      ok: true,
      available: entries.length > 0,
      entryCount: entries.length,
      rentCollected: Math.round(rentCollected),
      expectedMonthlyRent: safeNumber(expectedMonthlyRent),
      otherIncome: Math.round(otherIncome),
      totalExpenses: Math.round(totalExpenses),
      topExpenseCategories,
      netCashFlow: Math.round(rentCollected + otherIncome - totalExpenses),
    };
  } catch (error) {
    return { ok: false, available: false, error: error.message || 'financial_week_unavailable' };
  }
}

// ─── Leases & tenants ─────────────────────────────────────────────────────────

const LEASE_EXPIRY_HORIZON_DAYS = 60;

export function buildLeaseTenantDigest({ propertyRecords = [], weekWindow, now = new Date() }) {
  const horizon = new Date(now.getTime() + LEASE_EXPIRY_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const expiringLeases = [];
  const newLeases = [];
  let tenantCount = 0;
  let expectedMonthlyRent = 0;

  for (const property of propertyRecords) {
    const address = clipText(
      property?.address || property?.formattedAddress || property?.summary?.address || '',
      120,
    ) || null;
    const tenants = Array.isArray(property?.tenants) ? property.tenants : [];
    for (const tenant of tenants) {
      tenantCount += 1;
      const monthlyRent = safeNumber(tenant?.monthlyRent ?? tenant?.rent);
      if (monthlyRent !== null && monthlyRent > 0) {
        expectedMonthlyRent += monthlyRent;
      }

      const tenantName = clipText(tenant?.name || tenant?.fullName || tenant?.email || 'Tenant', 60);
      const leaseEnd = toDate(tenant?.leaseEnd);
      if (leaseEnd && leaseEnd >= now && leaseEnd <= horizon) {
        expiringLeases.push({
          tenantName,
          address,
          leaseEnd: leaseEnd.toISOString(),
          daysUntil: Math.round((leaseEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
          monthlyRent,
        });
      }

      const leaseStart = toDate(tenant?.leaseStart);
      if (leaseStart && weekWindow && isWithinWindow(leaseStart, weekWindow)) {
        newLeases.push({ tenantName, address, leaseStart: leaseStart.toISOString(), monthlyRent });
      }
    }
  }

  expiringLeases.sort((left, right) => left.daysUntil - right.daysUntil);

  return {
    ok: true,
    tenantCount,
    expectedMonthlyRent: Math.round(expectedMonthlyRent),
    expiringLeases: expiringLeases.slice(0, MAX_ACTIVITY_ITEMS),
    newLeases: newLeases.slice(0, MAX_ACTIVITY_ITEMS),
    hasUpdates: expiringLeases.length > 0 || newLeases.length > 0,
  };
}

// ─── Tax & compliance ─────────────────────────────────────────────────────────

function collectUpcomingDeadlines(taxYears, now) {
  const deadlines = [];
  for (const taxYear of taxYears) {
    try {
      const calendar = getTaxCalendar(taxYear);
      for (const deadline of calendar?.deadlines || []) {
        if (deadline.status !== 'past') {
          deadlines.push({ ...deadline, taxYear });
        }
      }
    } catch {
      // Calendar for an unsupported year — skip silently.
    }
  }

  return deadlines
    .filter((deadline) => Number.isFinite(deadline.daysUntil) && deadline.daysUntil >= 0 && deadline.daysUntil <= 120)
    .sort((left, right) => left.daysUntil - right.daysUntil)
    .slice(0, MAX_TAX_DEADLINES)
    .map((deadline) => ({
      name: clipText(deadline.name || deadline.label || 'Tax deadline', 110),
      date: deadline.date,
      daysUntil: deadline.daysUntil,
      status: deadline.status,
      taxYear: deadline.taxYear,
      description: clipText(deadline.description || '', 160) || null,
    }));
}

export async function buildTaxDigest({ userId, weekWindow, now = new Date() }) {
  const currentYear = now.getFullYear();
  const upcomingDeadlines = collectUpcomingDeadlines([currentYear - 1, currentYear], now);

  let newDocuments = [];
  let journalEntriesThisWeek = 0;
  let estimatedPaymentsRecorded = [];

  try {
    const db = getFirestore();
    const dataRef = db.collection('users').doc(userId).collection('bookkeeping').doc('data');

    const [documentsSnapshot, entriesSnapshot] = await Promise.allSettled([
      dataRef.collection('financeDocuments').limit(80).get(),
      dataRef.collection('journalEntries').limit(300).get(),
    ]);

    if (documentsSnapshot.status === 'fulfilled') {
      newDocuments = documentsSnapshot.value.docs
        .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
        .filter((document) => isWithinWindow(document.createdAt || document.uploadedAt || document.updatedAt, weekWindow))
        .slice(0, MAX_NEW_DOCUMENTS)
        .map((document) => ({
          id: document.id,
          name: clipText(document.name || document.fileName || document.title || 'Finance document', 110),
          type: clipText(document.type || document.category || '', 50) || null,
        }));
    }

    if (entriesSnapshot.status === 'fulfilled') {
      const entries = entriesSnapshot.value.docs.map((doc) => doc.data() || {});
      journalEntriesThisWeek = entries
        .filter((entry) => isWithinWindow(entry.date || entry.createdAt, weekWindow))
        .length;
      estimatedPaymentsRecorded = entries
        .filter((entry) => /estimated.*tax|tax.*estimate|quarterly.*tax/i.test(String(entry.description || entry.memo || entry.category || '')))
        .filter((entry) => isWithinWindow(entry.date || entry.createdAt, weekWindow))
        .slice(0, 3)
        .map((entry) => ({
          description: clipText(entry.description || entry.memo || 'Estimated tax payment', 110),
          amount: safeNumber(entry.amount ?? entry.total),
          date: toDate(entry.date || entry.createdAt)?.toISOString() || null,
        }));
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'tax_digest_unavailable',
      upcomingDeadlines,
      newDocuments: [],
      journalEntriesThisWeek: 0,
      estimatedPaymentsRecorded: [],
    };
  }

  return {
    ok: true,
    upcomingDeadlines,
    newDocuments,
    journalEntriesThisWeek,
    estimatedPaymentsRecorded,
    hasUpdates: upcomingDeadlines.length > 0 || newDocuments.length > 0 || estimatedPaymentsRecorded.length > 0,
  };
}

// ─── New listings in regions of interest ─────────────────────────────────────

export async function buildListingsWatchDigest({ zipCodes = [] }) {
  const regions = [...new Set(zipCodes.filter(Boolean))].slice(0, MAX_LISTING_REGIONS);
  if (regions.length === 0) {
    return { ok: true, regions: [], totalNewListings: 0 };
  }

  const results = await Promise.all(regions.map(async (zipCode) => {
    try {
      const search = await searchSaleListings({
        zipCode,
        daysOld: WEEKLY_LISTINGS_DAYS_OLD,
        limit: 50,
      });
      const listings = (search?.listings || [])
        .slice()
        .sort((left, right) => (safeNumber(left.price) || 0) - (safeNumber(right.price) || 0))
        .slice(0, WEEKLY_LISTINGS_PER_REGION)
        .map((listing) => ({
          address: clipText(listing.formattedAddress || listing.address || '', 120) || null,
          price: safeNumber(listing.price),
          bedrooms: safeNumber(listing.bedrooms),
          bathrooms: safeNumber(listing.bathrooms),
          squareFootage: safeNumber(listing.squareFootage),
          daysOnMarket: safeNumber(listing.daysOnMarket),
          listedDate: listing.listedDate || null,
        }));

      return {
        zipCode,
        ok: true,
        newListingCount: (search?.listings || []).length,
        listings,
      };
    } catch (error) {
      return {
        zipCode,
        ok: false,
        error: error.message || 'listing_search_failed',
        newListingCount: 0,
        listings: [],
      };
    }
  }));

  return {
    ok: true,
    regions: results,
    totalNewListings: results.reduce((sum, region) => sum + (region.newListingCount || 0), 0),
  };
}

// ─── Pricing power vs. local market ──────────────────────────────────────────

export function buildPricingPowerDigest({ properties = [], zipRegions = [] }) {
  const medianRentByZip = new Map();
  for (const region of zipRegions) {
    const medianRent = safeNumber(region?.rentcast?.derived?.medianAskingRent);
    if (region?.zipCode && medianRent !== null) {
      medianRentByZip.set(String(region.zipCode), medianRent);
    }
  }

  const propertyAnalyses = properties
    .filter((property) => property.zipCode && safeNumber(property.monthlyRent) !== null)
    .map((property) => {
      const medianRent = medianRentByZip.get(String(property.zipCode));
      if (medianRent === null || medianRent === undefined || medianRent <= 0) {
        return null;
      }

      const currentRent = safeNumber(property.monthlyRent);
      const gapDollar = medianRent - currentRent;
      const gapPercent = (gapDollar / medianRent) * 100;
      let position = 'at_market';
      if (gapPercent >= 5) position = 'below_market';
      else if (gapPercent <= -5) position = 'above_market';

      return {
        propertyId: property.id,
        address: property.address || null,
        zipCode: property.zipCode,
        currentRent,
        marketMedianRent: medianRent,
        pricingPowerDollar: Math.round(gapDollar),
        pricingPowerPercent: Math.round(gapPercent * 10) / 10,
        position,
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    properties: propertyAnalyses,
    belowMarketCount: propertyAnalyses.filter((entry) => entry.position === 'below_market').length,
    aboveMarketCount: propertyAnalyses.filter((entry) => entry.position === 'above_market').length,
  };
}

// ─── Macro / economic context ─────────────────────────────────────────────────

export function buildMacroDigest(canonicalContext) {
  const globalMarket = canonicalContext?.sections?.globalMarket || canonicalContext?.globalMarketSummary || {};
  if (!globalMarket || globalMarket.ok === false) {
    return { ok: false, available: false };
  }

  const macro = globalMarket.macro || {};
  const treasury = globalMarket.treasury?.summary || {};
  const housing = globalMarket.housing?.overview || {};

  return {
    ok: true,
    available: true,
    fedFundsRate: macro.fedFundsRate?.value ?? null,
    inflationRate: macro.inflationRate?.value ?? macro.cpi?.value ?? null,
    unemploymentRate: macro.unemploymentRate?.value ?? null,
    mortgageRate: treasury.mortgageRate ?? housing.mortgageRate?.value ?? null,
    keyTreasuryRate: treasury.keyRate ?? null,
    yieldCurve: treasury.yieldCurve ?? null,
    rateEnvironment: treasury.environment ?? null,
    medianHomePrice: housing.medianPrice?.value ?? null,
    headlines: (Array.isArray(globalMarket.headlines) ? globalMarket.headlines : [])
      .slice(0, 6)
      .map((headline) => ({
        title: clipText(headline.title || '', 150),
        topic: clipText(headline.topic || '', 40) || null,
        ticker: clipText(headline.ticker || '', 12) || null,
      }))
      .filter((headline) => headline.title),
  };
}
