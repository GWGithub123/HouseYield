/**
 * /api/v2 — Deal Analysis Engine routes.
 *
 *   POST /api/v2/analysis/property      — full individual DealReport (SSE or JSON)
 *   POST /api/v2/screener/search        — Stage 0+1: live listings + desk screen
 *   POST /api/v2/screener/underwrite    — Stage 2: deep underwrite selected listings
 *   GET  /api/v2/coverage               — searched-area map overlay data
 *   GET  /api/v2/coverage/:key          — cached results for one covered area
 *   POST /api/v2/flags                  — flag/unflag a property (star pins)
 *   GET  /api/v2/flags                  — list flagged properties
 *   GET  /api/v2/streetview             — metadata-checked Street View image URL
 *   GET  /api/v2/usage                  — RentCast budget snapshot
 */

import express from 'express';
import { analyzeProperty } from '../analysis-engine/index.js';
import { buildScenarios, buildRefiGrid, buildStressTest, solveOfferPrice } from '../analysis-engine/dealScenarios.js';
import { searchAndScreen } from '../analysis-engine/screener.js';
import { recordCoverage, listCoverage, getCoverage, setFlag, listFlags } from '../analysis-engine/coverageStore.js';
import { getRentcastUsageSnapshot, isRentcastLimitError } from '../rentcast-usage-limiter.js';
import { getCachedDoc, setCachedDoc, hashCacheKey } from '../firestore-doc-cache.js';

const router = express.Router();

const STREETVIEW_CACHE_COLLECTION = 'streetview_meta_cache';
const STREETVIEW_TTL_HOURS = 24 * 30;
const UNDERWRITE_CACHE_COLLECTION = 'deal_underwrite_report_cache';
const UNDERWRITE_TTL_HOURS = 24 * 14;

function stableNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : null;
}

function normalizeUnderwriteInputs({ assumptions = {}, buyBox = {} } = {}) {
  return {
    assumptions: Object.fromEntries(
      Object.entries(assumptions || {})
        .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, typeof value === 'number' || !Number.isNaN(parseFloat(value)) ? stableNumber(value) : value]),
    ),
    buyBox: Object.fromEntries(
      Object.entries(buyBox || {})
        .filter(([, value]) => value !== undefined && value !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, typeof value === 'number' || !Number.isNaN(parseFloat(value)) ? stableNumber(value) : value]),
    ),
  };
}

function underwriteCacheKey({ address, price, assumptions, buyBox }) {
  if (!address) return null;
  return hashCacheKey({
    version: 3,
    address: String(address).trim().toLowerCase(),
    price: stableNumber(price),
    ...normalizeUnderwriteInputs({ assumptions, buyBox }),
  });
}

async function getCachedUnderwriteReport({ address, price, assumptions, buyBox }) {
  const key = underwriteCacheKey({ address, price, assumptions, buyBox });
  if (!key) return null;
  const cached = await getCachedDoc(UNDERWRITE_CACHE_COLLECTION, key, UNDERWRITE_TTL_HOURS, 24 * 3);
  if (!cached?.data?.report) return null;
  return { key, report: cached.data.report, ageHours: cached.ageHours, isStale: cached.isStale };
}

async function setCachedUnderwriteReport({ address, price, assumptions, buyBox, report }) {
  const key = underwriteCacheKey({ address, price, assumptions, buyBox });
  if (!key || !report) return null;
  await setCachedDoc(UNDERWRITE_CACHE_COLLECTION, key, {
    report,
    address,
    price: stableNumber(price),
    cacheVersion: 3,
  }, {
    address,
    price: stableNumber(price),
  });
  return key;
}

function errorPayload(error) {
  if (isRentcastLimitError(error)) {
    return { status: 429, body: { ok: false, error: 'rentcast_monthly_limit', message: error.message } };
  }
  if (error?.code === 'ATTOM_MONTHLY_LIMIT_EXCEEDED') {
    return { status: 429, body: { ok: false, error: 'attom_monthly_limit', message: error.message } };
  }
  return { status: 500, body: { ok: false, error: error?.message || 'unknown_error' } };
}

// ---------------------------------------------------------------------------
// Individual property analysis (supports SSE progress streaming)
// ---------------------------------------------------------------------------

router.post('/analysis/property', async (req, res) => {
  const { address, listPrice, photos, assumptions, listingHints, stream } = req.body || {};

  if (!address || !String(address).trim()) {
    return res.status(400).json({ ok: false, error: 'missing_address' });
  }

  const useStream = stream === true || req.query.stream === '1';

  if (useStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const report = await analyzeProperty({
        address,
        listPrice,
        photos: photos || [],
        assumptions: assumptions || {},
        listingHints: listingHints || {},
        onProgress: (stage, detail) => send('progress', { stage, detail }),
      });
      send('report', report);
      send('done', { ok: true });
    } catch (error) {
      console.error('[v2/analysis] Failed:', error);
      send('error', errorPayload(error).body);
    } finally {
      res.end();
    }
    return;
  }

  try {
    const report = await analyzeProperty({
      address,
      listPrice,
      photos: photos || [],
      assumptions: assumptions || {},
      listingHints: listingHints || {},
    });
    res.json({ ok: true, report });
  } catch (error) {
    console.error('[v2/analysis] Failed:', error);
    const { status, body } = errorPayload(error);
    res.status(status).json(body);
  }
});

// ---------------------------------------------------------------------------
// Pure-math recompute — live assumption edits / renovation toggles / rent
// slider. No external API calls; instant.
// ---------------------------------------------------------------------------

router.post('/analysis/recompute', (req, res) => {
  try {
    const { assumptions, renovation, buyBox } = req.body || {};
    if (!assumptions || !Number.isFinite(parseFloat(assumptions.purchasePrice))) {
      return res.status(400).json({ ok: false, error: 'missing_assumptions' });
    }

    const renovationInputs = renovation && parseFloat(renovation.repairCost) > 0 ? {
      repairCost: parseFloat(renovation.repairCost),
      valueAfterRepairs: parseFloat(renovation.valueAfterRepairs),
      monthlyRentAfter: parseFloat(renovation.monthlyRentAfter) || undefined,
    } : null;

    const scenarios = buildScenarios(assumptions, renovationInputs, {
      refiAtYear: parseFloat(assumptions.refiAtYear) || undefined,
      refiRate: parseFloat(assumptions.refiRate) || undefined,
      refiLtvPercent: parseFloat(assumptions.refiLtvPercent) || undefined,
      refiLoanTermYears: parseFloat(assumptions.refiLoanTermYears) || undefined,
      refiClosingCostPercent: parseFloat(assumptions.refiClosingCostPercent) || undefined,
    });

    res.json({
      ok: true,
      scenarios: scenarios.map((s) => ({
        key: s.key,
        label: s.label,
        description: s.description,
        summary: s.summary,
        chartData: s.chartData,
        refiEvent: s.projection.refiEvent,
        financing: {
          inputs: s.projection.inputs,
          loanAmount: s.projection.loanAmount,
          downPayment: s.projection.downPayment,
          monthlyMortgagePayment: s.projection.monthlyMortgagePayment,
          cashLeftInDeal: s.projection.cashLeftInDeal,
        },
        holdingRows: s.projection.holdingRows,
      })),
      refiGrid: buildRefiGrid(assumptions, renovationInputs, { refiAtYear: parseFloat(assumptions.refiAtYear) || undefined }),
      stressTest: buildStressTest(assumptions, renovationInputs),
      offerSolver: solveOfferPrice(assumptions, buyBox || {}, renovationInputs),
    });
  } catch (error) {
    console.error('[v2/analysis/recompute] Failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Regional screener
// ---------------------------------------------------------------------------

router.post('/screener/search', async (req, res) => {
  try {
    const criteria = req.body || {};
    const result = await searchAndScreen(criteria);

    const coverageKey = await recordCoverage({
      search: result.search,
      criteria: { ...criteria, buyBox: result.buyBox },
      funnel: result.funnel,
      listings: result.listings,
      userId: criteria.userId || null,
    }).catch(() => null);
    result.coverageKey = coverageKey;

    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[v2/screener/search] Failed:', error);
    const { status, body } = errorPayload(error);
    res.status(status).json(body);
  }
});

router.post('/screener/underwrite', async (req, res) => {
  try {
    const { listings, assumptions, buyBox, maxCount } = req.body || {};
    if (!Array.isArray(listings) || !listings.length) {
      return res.status(400).json({ ok: false, error: 'missing_listings' });
    }

    const limit = Math.min(Math.max(parseInt(maxCount, 10) || 15, 1), 25);
    const targets = listings.slice(0, limit);

    // Bounded concurrency to respect API budgets
    const concurrency = 3;
    const reports = [];
    const errors = [];
    let cacheHits = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        const target = targets[index];
        const address = target.address || target.formattedAddress;
        if (!address) {
          errors.push({ index, error: 'missing_address' });
          continue;
        }
        try {
          const cached = await getCachedUnderwriteReport({
            address,
            price: target.price ?? target.listPrice ?? null,
            assumptions: assumptions || {},
            buyBox: buyBox || {},
          });
          if (cached?.report) {
            cacheHits += 1;
            reports.push({ index, address, report: { ...cached.report, fromUnderwriteCache: true, underwriteCacheAgeHours: cached.ageHours } });
            continue;
          }

          const report = await analyzeProperty({
            address,
            listPrice: target.price ?? target.listPrice ?? null,
            photos: [],
            assumptions: { ...(assumptions || {}), buyBox: buyBox || undefined },
            listingHints: {
              latitude: target.latitude,
              longitude: target.longitude,
              zipCode: target.zipCode,
              city: target.city,
              state: target.state,
              bedrooms: target.bedrooms,
              bathrooms: target.bathrooms,
              squareFootage: target.squareFootage,
              yearBuilt: target.yearBuilt,
              propertyType: target.propertyType,
            },
          });
          await setCachedUnderwriteReport({
            address,
            price: target.price ?? target.listPrice ?? null,
            assumptions: assumptions || {},
            buyBox: buyBox || {},
            report,
          });
          reports.push({ index, address, report });
        } catch (error) {
          console.warn(`[v2/screener/underwrite] ${address} failed:`, error.message);
          errors.push({ index, address, error: error.message, code: error.code || null });
          if (error?.code === 'ATTOM_MONTHLY_LIMIT_EXCEEDED' || isRentcastLimitError(error)) {
            cursor = targets.length; // stop burning budget
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

    reports.sort((a, b) => (b.report?.dealScore?.score ?? 0) - (a.report?.dealScore?.score ?? 0));

    res.json({
      ok: true,
      underwritten: reports.length,
      requested: targets.length,
      cacheHits,
      reports: reports.map((r) => r.report),
      errors,
    });
  } catch (error) {
    console.error('[v2/screener/underwrite] Failed:', error);
    const { status, body } = errorPayload(error);
    res.status(status).json(body);
  }
});

// ---------------------------------------------------------------------------
// Coverage + flags (searched-areas map layer)
// ---------------------------------------------------------------------------

router.get('/coverage', async (req, res) => {
  try {
    const coverage = await listCoverage({ userId: req.query.userId || null });
    res.json({ ok: true, coverage });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/coverage/:key', async (req, res) => {
  try {
    const area = await getCoverage(req.params.key);
    if (!area) return res.status(404).json({ ok: false, error: 'coverage_not_found' });
    const assumptions = area.criteria?.assumptions || {};
    const buyBox = area.criteria?.buyBox || {};
    const cachedReports = {};
    const cachedReportSummaries = {};
    await Promise.all((area.topListings || []).slice(0, 60).map(async (listing) => {
      const address = listing.address || listing.formattedAddress;
      if (!address) return;
      const cached = await getCachedUnderwriteReport({
        address,
        price: listing.price ?? null,
        assumptions,
        buyBox,
      });
      if (!cached?.report) return;
      cachedReports[address] = { ...cached.report, fromUnderwriteCache: true, underwriteCacheAgeHours: cached.ageHours };
      cachedReportSummaries[address] = {
        score: cached.report.dealScore?.score ?? null,
        grade: cached.report.dealScore?.grade ?? null,
        monthlyCashFlow: cached.report.scenarios?.[0]?.summary?.monthlyCashFlowYear1 ?? null,
        cachedAgeHours: cached.ageHours,
      };
    }));
    area.cachedReports = cachedReports;
    area.cachedReportSummaries = cachedReportSummaries;
    res.json({ ok: true, area });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/flags', async (req, res) => {
  try {
    const result = await setFlag(req.body || {});
    if (!result) return res.status(400).json({ ok: false, error: 'flag_failed' });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/flags', async (req, res) => {
  try {
    const flags = await listFlags({ userId: req.query.userId || null });
    res.json({ ok: true, flags });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Street View (metadata-checked, cached) — both flows use this for imagery
// ---------------------------------------------------------------------------

router.get('/streetview', async (req, res) => {
  try {
    const address = (req.query.address || '').toString().trim();
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const size = (req.query.size || '640x420').toString().replace(/[^0-9x]/g, '') || '640x420';

    if (!address && !(Number.isFinite(lat) && Number.isFinite(lng))) {
      return res.status(400).json({ ok: false, error: 'missing_location' });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '';
    if (!apiKey) return res.status(503).json({ ok: false, error: 'maps_key_missing' });

    const location = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : address;
    const cacheKey = hashCacheKey({ v: 1, location });

    const cached = await getCachedDoc(STREETVIEW_CACHE_COLLECTION, cacheKey, STREETVIEW_TTL_HOURS);
    let meta = cached?.data || null;

    if (!meta) {
      const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(location)}&source=outdoor&key=${apiKey}`;
      const metaResponse = await fetch(metaUrl);
      const metaJson = await metaResponse.json().catch(() => ({}));
      meta = {
        status: metaJson.status || 'UNKNOWN',
        panoLat: metaJson.location?.lat ?? null,
        panoLng: metaJson.location?.lng ?? null,
      };
      setCachedDoc(STREETVIEW_CACHE_COLLECTION, cacheKey, meta, { location }).catch(() => {});
    }

    if (meta.status !== 'OK') {
      return res.json({ ok: true, available: false, status: meta.status, imageUrl: null });
    }

    const imageUrl = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${encodeURIComponent(location)}&pitch=2&fov=80&source=outdoor&key=${apiKey}`;
    res.json({ ok: true, available: true, status: 'OK', imageUrl });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Budget snapshot
// ---------------------------------------------------------------------------

router.get('/usage', async (req, res) => {
  try {
    const rentcast = await getRentcastUsageSnapshot();
    res.json({ ok: true, rentcast });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
