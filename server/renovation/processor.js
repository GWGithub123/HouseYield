/**
 * Renovation ROI Background Processor — v3 (Zillow API)
 * 
 * Processes renovation candidates from Zillow API data:
 * 1. Finds properties with 2+ sales (potential renovations) in a zip code via Zillow price history
 * 2. Classifies renovations using 3-signal detection (keywords + features + price patterns)
 * 3. Runs the Uplift Isolation Engine to subtract market appreciation + mispricing
 * 4. Allocates uplift across individual renovations
 * 5. Aggregates 10-20 results into per-zip per-renovation-type ROI stats
 * 6. Stores results in Firestore for real-time lookup
 */

import snowflake from '../zillowApi.js';
import { initializeFirebaseAdmin, getFirestore } from '../firebase-admin.js';
import { isolateRenovationUplift, calculateFromRegionalRates } from './upliftIsolationEngine.js';
import { aggregateAreaRenovationStats, aggregateRentalUpliftStats } from './areaAggregator.js';
import { classifyRenovation } from './renovationClassifier.js';

// Photo comparison is still available for individual property evaluation (Phase 3 user flow)
// but no longer used for statistical pair analysis
let comparePropertyPhotos;
let batchCompareRenovations;

// Initialize Firebase Admin
let db = null;
let firebaseAdmin = null;
try {
  firebaseAdmin = initializeFirebaseAdmin();
  db = getFirestore();
  console.log('[RenovationProcessor] ✅ Firestore connected');
} catch (error) {
  console.warn('[RenovationProcessor] ⚠️ Firestore unavailable:', error.message);
}

// Processing configuration
const CONFIG = {
  // Temporary toggle: disable area/rental summary cache docs in Firestore.
  // When true, summaries are computed live from renovation_uplift_results.
  DISABLE_FIRESTORE_CACHE: true,

  // Processing limits
  BATCH_SIZE: 30,                    // Properties to process per zip code (target 20-30)
  MAX_PHOTOS_PER_COMPARISON: 8,      // Max photos to send to GPT-4 Vision per side
  RATE_LIMIT_DELAY: 1500,            // ms between API calls (respect OpenAI limits)
  
  // Filtering criteria for candidate selection
  MIN_BEFORE_PRICE: 25000,           // Exclude rental/lease listings (typically $1k-$5k/mo)
  MAX_PRICE_INCREASE_PERCENT: 500,   // Cap absurd increases (likely data errors)
  MIN_PRICE_INCREASE_PERCENT: 5,     // Minimum meaningful price increase
  MAX_PRICE_DECREASE_PERCENT: -10,   // Allow some price decreases (market decline cases)
  MIN_HOLDING_MONTHS: 3,             // Min gap between sales
  MAX_HOLDING_MONTHS: 84,            // 7 years — catches pre-COVID purchases sold recently
  MIN_PHOTOS_PER_LISTING: 0,         // Don't filter by photo count in metadata (photos may exist even if count is 0)
  
  // Collection names
  COLLECTION_COMPARABLES: 'renovation_comparables_v2',
  COLLECTION_UPLIFT_RESULTS: 'renovation_uplift_results',
  COLLECTION_AREA_SUMMARIES: 'renovation_area_summaries_v2',
  COLLECTION_RENTAL_SUMMARIES: 'renovation_rental_summaries',
  COLLECTION_PROCESSING_LOG: 'renovation_processing_log_v2',
  
  // OpenAI rate limits
  MAX_REQUESTS_PER_MINUTE: 50,
  CONCURRENT_PHOTO_COMPARISONS: 2,

  // Freshness controls for stored uplift docs
  MAX_RESULT_AGE_DAYS: 180
};

function toDateSafe(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    try { return value.toDate(); } catch { return null; }
  }
  try {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function isFreshResult(docData, maxAgeDays = CONFIG.MAX_RESULT_AGE_DAYS) {
  const analyzedAt = toDateSafe(docData?.analyzedAt);
  if (!analyzedAt) return false;
  const ageMs = Date.now() - analyzedAt.getTime();
  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Initialize ES module imports (photo comparison service)
 * Photo comparison is optional — only needed for individual property evaluation,
 * not for statistical pair analysis which now uses the 3-signal classifier.
 */
async function initializeModules() {
  if (!comparePropertyPhotos) {
    try {
      const photoModule = await import('./photoComparisonServer.js');
      comparePropertyPhotos = photoModule.comparePropertyPhotos;
      batchCompareRenovations = photoModule.batchCompareRenovations;
    } catch {
      try {
        const photoModule = await import('../../src/services/renovationPhotoComparisonService.js');
        comparePropertyPhotos = photoModule.comparePropertyPhotos;
        batchCompareRenovations = photoModule.batchCompareRenovations;
      } catch (err) {
        console.warn('[RenovationProcessor] Photo comparison service unavailable (not needed for pair analysis):', err.message);
      }
    }
  }
}

/**
 * Process renovation candidates for a specific zip code.
 * This is the main entry point: find pairs → classify renovations → isolate uplift → aggregate.
 * 
 * Uses Zillow API price history for pair detection and 3-signal classifier
 * (keywords + features + price patterns) for renovation detection.
 */
export async function processAreaRenovations(options = {}) {
  const {
    zipCode,
    city,
    state,
    subjectPropertyType = null,
    subjectProfile = null,
    limit = CONFIG.BATCH_SIZE,
    skipProcessed = true,
    forceReprocess = false,
    maxResultAgeDays = CONFIG.MAX_RESULT_AGE_DAYS
  } = options;

  const shouldSkipProcessed = skipProcessed && !forceReprocess;
  
  await initializeModules();
  
  const areaLabel = zipCode || `${city}, ${state}` || 'unknown';
  console.log(`[RenovationProcessor] ====== Starting processing for: ${areaLabel} ======`);
  
  const startTime = Date.now();
  const results = {
    processed: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    rentalPairsLoaded: 0,
    rentalMatchesUsed: 0,
    upliftResults: [],
    errors: []
  };
  
  try {
    // ---------------------------------------------------------------
    // STEP 1: Find renovation candidate pairs (Zillow price history)
    //   - Search properties in ZIP → fetch price histories
    //   - Detect repeat sales with 5-500% price increase, 60-1825 days apart
    //   - Both prices > $50k
    //   - Returns ready-to-use before/after pairs
    // ---------------------------------------------------------------
    console.log(`[RenovationProcessor] Step 1: Finding renovation candidate pairs...`);
    
    const pairs = await snowflake.findRenovationPairs({
      zip: zipCode,
      limit: Math.max(limit * 4, 50) // fetch extras — wider net for more reno types
    });
    
    // If primary ZIP has too few candidates, try neighboring ZIPs for more data.
    // The spec says "neighboring zips if data is thin."
    // Skip neighbor expansion if quota is already exhausted to avoid wasting calls.
    if (pairs.length < 20 && zipCode && !snowflake.isQuotaExceeded()) {
      console.log(`[RenovationProcessor] Only ${pairs.length} pairs in ${zipCode} (< 20), trying neighboring ZIPs...`);
      const neighborZips = getNeighborZips(zipCode);
      for (const nZip of neighborZips) {
        if (pairs.length >= limit * 2) break;
        if (snowflake.isQuotaExceeded()) {
          console.warn(`[RenovationProcessor] Quota exceeded, stopping neighbor expansion`);
          break;
        }
        try {
          const neighborPairs = await snowflake.findRenovationPairs({
            zip: nZip,
            limit: Math.max(limit, 15)
          });
          console.log(`[RenovationProcessor] Neighbor ${nZip}: ${neighborPairs.length} pairs`);
          pairs.push(...neighborPairs);
        } catch (e) {
          // Ignore errors for neighbor zips
        }
      }
      console.log(`[RenovationProcessor] Total pairs after neighbor expansion: ${pairs.length}`);
    }
    
    if (pairs.length === 0) {
      console.log(`[RenovationProcessor] No candidate pairs found for ${areaLabel}`);
      return results;
    }
    
    // Map SQL rows to candidate objects (simple field rename, no filtering)
    let filteredCandidates = pairs.slice(0, limit * 2).map(row => {
      const unitStr = row.UNITNUMBER ? ` #${row.UNITNUMBER}` : '';
      const streetNum = row.STREETNUMBER || '';
      const streetName = row.STREETNAME || '';
      const streetSuffix = row.STREETSUFFIX || '';
      const city = row.CITY || '';
      const rowState = row.STATEORPROVINCE || row.STATE || state || '';
      const rowZip = row.POSTALCODE || zipCode || '';
      const address = `${streetNum} ${streetName} ${streetSuffix}`.trim()
        + `${unitStr}, ${city}, ${rowState} ${rowZip}`.trim();
      return {
        address,
        streetNumber: row.STREETNUMBER || '',
        streetName: row.STREETNAME || '',
        streetSuffix: row.STREETSUFFIX || '',
        unitNumber: row.UNITNUMBER || '',
        beforeKey: row.BEFORE_LISTINGKEY,
        afterKey: row.AFTER_LISTINGKEY,
        beforePrice: row.BEFORE_PRICE,
        afterPrice: row.AFTER_PRICE,
        beforeListPrice: row.BEFORE_LISTPRICE,
        afterListPrice: row.AFTER_LISTPRICE,
        beforeDate: row.BEFORE_DATE,
        afterDate: row.AFTER_DATE,
        beforeDaysOnMarket: row.BEFORE_DOM,
        afterDaysOnMarket: row.AFTER_DOM,
        pricePct: row.PRICE_INCREASE_PCT,
        holdingMonths: Math.round((row.DAYS_BETWEEN_SALES || 365) / 30),
        // Always use the queried analysis ZIP, not the property's actual ZIP.
        // discoverZpidsInArea returns properties from neighboring areas (and
        // sometimes the 'similar' endpoint returns distant markets). The
        // Firestore grouping key must be the ANALYSIS area so that Step 5
        // queries (where zipCode == analysisZip) find these docs.
        zip: zipCode || row.POSTALCODE,
        state: row.STATEORPROVINCE || row.STATE || state,
        propertyType: row.PROPERTYTYPE || row.PROPERTY_TYPE || 'Residential',
        sqft: row.SQFT || row.BEFORE_SQFT || 0,
        beds: row.BEDS || row.BEFORE_BEDS || 0,
        baths: row.BATHS || row.BEFORE_BATHS || 0,
        yearBuilt: row.YEARBUILT || row.BEFORE_YEARBUILT || 1990,
        zpid: row.ZPID || row.BEFORE_ZPID || null,
        beforeRemarks: row.BEFORE_REMARKS || '',
        afterRemarks: row.AFTER_REMARKS || '',
      };
    });
    
    // Property type does NOT gate comp selection. Renovation costs and ROI for
    // kitchen, bathroom, flooring, paint, etc. are driven by property size, price
    // point, and location — not whether the comp is SF vs MF. A 1,500 sqft duplex
    // unit and a 1,500 sqft single-family home have nearly identical renovation
    // economics. Keeping all property types in the pool is especially important
    // for multi-family subjects where MF flip pairs are scarce.
    // Candidates are already sorted by price-increase % from detectSalePairs.

    results.candidatePairsFound = pairs.length;

    const norm = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
    const stripSuffix = (street = '') => {
      const tokens = norm(street).split(' ').filter(Boolean);
      const suffixes = new Set(['RD', 'ROAD', 'ST', 'STREET', 'AVE', 'AVENUE', 'BLVD', 'BOULEVARD', 'DR', 'DRIVE', 'LN', 'LANE', 'CT', 'COURT', 'PL', 'PLACE', 'PKWY', 'PARKWAY', 'TER', 'TERRACE', 'WAY', 'CIR', 'CIRCLE']);
      while (tokens.length > 0 && suffixes.has(tokens[tokens.length - 1])) {
        tokens.pop();
      }
      return tokens.join(' ');
    };
    const streetBase = (streetName, streetSuffix) => {
      const merged = `${streetName || ''} ${streetSuffix || ''}`;
      const stripped = stripSuffix(merged);
      return stripped || stripSuffix(streetName || '') || norm(streetName || '');
    };
    const keyOf = (sn, st, suf, un) => `${norm(sn)}|${streetBase(st, suf)}|${norm(un)}`;
    const keyVariants = (sn, st, suf, un) => {
      const out = new Set();
      out.add(keyOf(sn, st, suf, un));
      out.add(keyOf(sn, st, '', un));
      out.add(keyOf(sn, st, suf, ''));
      out.add(keyOf(sn, st, '', ''));
      out.add(`${norm(sn)}|${norm(st)}|${norm(un)}`);
      out.add(`${norm(sn)}|${norm(st)}|`);
      return [...out].filter(Boolean);
    };

    // ── Fix 5: Deduplicate candidates by address ──
    // The same property can appear in multiple sale pairs (e.g. sold 2016→2018 AND 2018→2021).
    // Keep only the most recent after-sale pair per address to avoid contradictory uplift values.
    {
      const beforeDedup = filteredCandidates.length;
      const seen = new Map();
      for (const c of filteredCandidates) {
        const key = keyOf(c.streetNumber, c.streetName, c.streetSuffix, c.unitNumber);
        const existing = seen.get(key);
        const cAfter = c.afterDate ? new Date(c.afterDate).getTime() : 0;
        const eAfter = existing?.afterDate ? new Date(existing.afterDate).getTime() : 0;
        if (!existing || cAfter > eAfter) {
          seen.set(key, c);
        }
      }
      filteredCandidates = [...seen.values()];
      const removed = beforeDedup - filteredCandidates.length;
      if (removed > 0) {
        console.log(`[RenovationProcessor] Deduped: ${beforeDedup} → ${filteredCandidates.length} candidates (${removed} duplicate addresses removed)`);
      }
    }

    console.log(`[RenovationProcessor] ${pairs.length} pairs found, processing ${filteredCandidates.length} unique candidates...`);

    // Load lease/rental before-after pairs for this ZIP (used to estimate rent uplift from comps)
    let rentalPairByAddress = new Map();
    let rentalPairsAll = [];
    try {
      if (zipCode) {
        const rentalPairs = await snowflake.findRentalRenovationPairs({
          zip: zipCode,
          limit: Math.max(limit * 10, 120)
        });

        rentalPairsAll = rentalPairs || [];

        for (const rp of rentalPairs) {
          const keys = keyVariants(rp.STREETNUMBER, rp.STREETNAME, rp.STREETSUFFIX, rp.UNITNUMBER);
          for (const key of keys) {
            const existing = rentalPairByAddress.get(key);
            // Keep pair with latest AFTER_DATE
            const existingDate = existing?.AFTER_DATE ? new Date(existing.AFTER_DATE).getTime() : 0;
            const newDate = rp.AFTER_DATE ? new Date(rp.AFTER_DATE).getTime() : 0;
            if (!existing || newDate >= existingDate) {
              rentalPairByAddress.set(key, rp);
            }
          }
        }

        console.log(`[RenovationProcessor] Loaded ${rentalPairByAddress.size} address-level rental pairs for rent uplift matching`);
        results.rentalPairsLoaded = rentalPairByAddress.size;
      }
    } catch (e) {
      console.warn(`[RenovationProcessor] Rental pair preload failed: ${e.message}`);
    }

    const pickBestFuzzyRentalMatch = (candidate, pairs = []) => {
      if (!candidate || pairs.length === 0) return null;
      const targetSqft = candidate.sqft || 0;
      const targetBeds = candidate.beds || 0;
      const targetBaths = candidate.baths || 0;

      const filtered = pairs.filter(p => {
        const sqft = p.SQFT || 0;
        const beds = p.BEDS || 0;
        const baths = p.BATHS || 0;
        if (targetSqft > 0 && sqft > 0) {
          const ratio = Math.min(targetSqft, sqft) / Math.max(targetSqft, sqft);
          if (ratio < 0.7) return false;
        }
        if (targetBeds > 0 && Math.abs(beds - targetBeds) > 1) return false;
        if (targetBaths > 0 && Math.abs(baths - targetBaths) > 1) return false;
        return true;
      });

      if (filtered.length === 0) return null;

      const score = (p) => {
        const sqft = p.SQFT || 0;
        const beds = p.BEDS || 0;
        const baths = p.BATHS || 0;
        const sqftScore = targetSqft && sqft ? Math.abs(sqft - targetSqft) / targetSqft : 0.5;
        const bedScore = targetBeds ? Math.abs(beds - targetBeds) * 0.15 : 0.2;
        const bathScore = targetBaths ? Math.abs(baths - targetBaths) * 0.15 : 0.2;
        const dateScore = p.AFTER_DATE ? (Date.now() - new Date(p.AFTER_DATE).getTime()) / (1000 * 60 * 60 * 24 * 365) * 0.02 : 0.1;
        return sqftScore + bedScore + bathScore + dateScore;
      };

      return filtered.sort((a, b) => score(a) - score(b))[0] || null;
    };
    
    // ---------------------------------------------------------------
    // STEP 2-4: For each candidate → classify renovation → isolate uplift
    // Uses 3-signal classifier (keywords + features + price patterns)
    // instead of GPT-4o Vision photo comparison for statistical analysis.
    // ---------------------------------------------------------------
    for (const candidate of filteredCandidates) {
      const address = candidate.address;
      
      try {
        // Check if already processed
        if (shouldSkipProcessed && db) {
          const docId = `${candidate.zip}_${candidate.beforeKey}_${candidate.afterKey}`;
          const existingDoc = await db
            .collection(CONFIG.COLLECTION_UPLIFT_RESULTS)
            .doc(docId)
            .get();
          
          if (existingDoc.exists) {
            const existingData = existingDoc.data() || {};
            if (isFreshResult(existingData, maxResultAgeDays)) {
              console.log(`[RenovationProcessor] Skipping already processed (fresh): ${address}`);
              results.skipped++;
              continue;
            }
            console.log(`[RenovationProcessor] Reprocessing stale result: ${address}`);
          }
        }
        
        const beforeKey = candidate.beforeKey;
        const afterKey = candidate.afterKey;
        
        if (!beforeKey || !afterKey) {
          console.log(`[RenovationProcessor] Missing listing keys for: ${address}`);
          results.skipped++;
          continue;
        }
        
        // ---- STEP 2: Fetch property detail for description + features ----
        // Use Zillow /custom_ad to get MLS description and features dict
        let propertyDetail = null;
        let propertyFeatures = null;
        let afterDescription = candidate.afterRemarks || '';
        try {
          const zpid = candidate.zpid || (beforeKey || '').split('_')[0];
          if (zpid && !isNaN(zpid)) {
            propertyDetail = await snowflake.getMLSPropertyWithImages(zpid);
            if (propertyDetail) {
              afterDescription = propertyDetail.PUBLICREMARKS || propertyDetail.description || afterDescription;
              propertyFeatures = propertyDetail.features || null;
            }
          }
        } catch (e) {
          console.warn(`[RenovationProcessor] Could not fetch property detail for ${address}: ${e.message}`);
        }
        
        // Rate limit between API calls
        await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY));
        
        // ---- STEP 2b: Compute quick market appreciation estimate ----
        // This lets the classifier use market-adjusted price increase for scope inference
        // and price pattern scoring, avoiding inflated renovation scores from hot markets.
        let marketAdjustedPriceIncreasePct = null;
        try {
          const candState = candidate.state || state || 'NATIONAL';
          const bDate = candidate.beforeDate ? new Date(candidate.beforeDate) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
          const aDate = candidate.afterDate ? new Date(candidate.afterDate) : new Date();
          if (!isNaN(bDate.getTime()) && !isNaN(aDate.getTime())) {
            const appreciation = calculateFromRegionalRates(candState, bDate, aDate, candidate.beforePrice);
            const rawIncreasePct = ((candidate.afterPrice - candidate.beforePrice) / candidate.beforePrice) * 100;
            marketAdjustedPriceIncreasePct = Math.max(0, rawIncreasePct - appreciation.appreciationPercent);
          }
        } catch (e) {
          // Fallback: classifier will use raw price increase
        }
        
        // ---- STEP 2c: Run 3-signal renovation classifier ----
        console.log(`[RenovationProcessor] Classifying renovation for: ${address}`);
        
        const classification = classifyRenovation({
          description: afterDescription,
          beforeDescription: candidate.beforeRemarks || '',
          features: propertyFeatures,
          yearBuilt: candidate.yearBuilt,
          sqft: candidate.sqft,
          beds: candidate.beds,
          baths: candidate.baths,
          beforePrice: candidate.beforePrice,
          afterPrice: candidate.afterPrice,
          daysBetweenSales: (candidate.holdingMonths || 12) * 30,
          beforePSF: candidate.beforePrice && candidate.sqft ? candidate.beforePrice / candidate.sqft : null,
          afterPSF: candidate.afterPrice && candidate.sqft ? candidate.afterPrice / candidate.sqft : null,
          priceHistory: [], // Already processed in pair detection
          beforeSaleToList: candidate.beforeListPrice ? candidate.beforePrice / candidate.beforeListPrice : null,
          afterSaleToList: candidate.afterListPrice ? candidate.afterPrice / candidate.afterListPrice : null,
          marketAdjustedPriceIncreasePct, // Pre-computed appreciation-adjusted price increase
        });
        
        // Filter out low-confidence pairs (likely market appreciation only)
        if (classification.renovationScore < 0.4) {
          console.log(`[RenovationProcessor] ⏭️ Low renovation score (${classification.renovationScore}) for: ${address} — likely market appreciation`);
          results.skipped++;
          continue;
        }
        
        if (classification.detectedRenovations.length === 0) {
          console.log(`[RenovationProcessor] No renovations detected for: ${address}`);
          results.skipped++;
          continue;
        }
        
        console.log(`[RenovationProcessor] Detected ${classification.detectedRenovations.length} renovations (score: ${classification.renovationScore}, ${classification.confidence}) for: ${address}`);
        
        // Enrich with MLS material parsing (reuse existing function)
        const mlsMaterials = parseMaterialsFromRemarks(afterDescription);
        const enrichedRenovations = enrichRenovationsWithMLSMaterials(
          classification.detectedRenovations,
          mlsMaterials
        );
        
        // Classify overall material tier
        const materialTier = classifyMaterialTier(enrichedRenovations);
        
        // ---- STEP 3-4: Run Uplift Isolation Engine ----
        const candZip = candidate.zip || zipCode;
        const candState = candidate.state || state;
        const candidateKeys = keyVariants(candidate.streetNumber, candidate.streetName, candidate.streetSuffix, candidate.unitNumber);
        let rentalMatch = candidateKeys.map(k => rentalPairByAddress.get(k)).find(Boolean) || null;
        if (!rentalMatch && rentalPairsAll.length > 0) {
          rentalMatch = pickBestFuzzyRentalMatch(candidate, rentalPairsAll);
          if (rentalMatch) {
            results.rentalMatchesFuzzy = (results.rentalMatchesFuzzy || 0) + 1;
          }
        }
        if (rentalMatch) results.rentalMatchesUsed++;
        
        const upliftResult = await isolateRenovationUplift({
          address,
          zipCode: candZip,
          state: candState,
          propertyType: candidate.propertyType,
          sqft: candidate.sqft,
          beds: candidate.beds,
          baths: candidate.baths,
          yearBuilt: candidate.yearBuilt,
          // Before sale
          beforeSalePrice: candidate.beforePrice,
          beforeListPrice: candidate.beforeListPrice,
          beforeDate: candidate.beforeDate,
          beforeDaysOnMarket: candidate.beforeDaysOnMarket ?? null,
          // After sale
          afterSalePrice: candidate.afterPrice,
          afterListPrice: candidate.afterListPrice,
          afterDate: candidate.afterDate,
          afterDaysOnMarket: candidate.afterDaysOnMarket ?? null,
          // Detected renovations from 3-signal classifier
          renovations: enrichedRenovations,
          // Rent data
          rentBefore: rentalMatch?.BEFORE_RENT || null,
          rentAfter: rentalMatch?.AFTER_RENT || null
        });
        
        console.log(`[RenovationProcessor] ✅ Uplift isolated for ${address}: $${upliftResult.renovationAttributedUplift} attributed, ${upliftResult.renovationBreakdown?.length || 0} renovation(s)`);
        
        // Quality gate: skip properties where renovation uplift is $0 or confidence is very low.
        if (upliftResult.renovationAttributedUplift <= 0) {
          console.log(`[RenovationProcessor] ⏭️ Skipping ${address}: uplift is $0 after subtracting market appreciation + mispricing`);
          results.skipped++;
          continue;
        }
        if (upliftResult.confidence?.score < 25) {
          console.log(`[RenovationProcessor] ⏭️ Skipping ${address}: confidence too low (${upliftResult.confidence.score}/100)`);
          results.skipped++;
          continue;
        }
        
        // Save individual uplift result to Firestore
        if (db) {
          try {
            const docId = `${candidate.zip}_${beforeKey}_${afterKey}`;
            await db.collection(CONFIG.COLLECTION_UPLIFT_RESULTS).doc(docId).set({
              ...upliftResult,
              // Material tier classification (budget/mid_grade/high_end/luxury)
              materialTier: materialTier,
              // Flatten dates for Firestore
              analyzedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
              beforeDate: upliftResult.beforeDate ? firebaseAdmin.firestore.Timestamp.fromDate(new Date(upliftResult.beforeDate)) : null,
              afterDate: upliftResult.afterDate ? firebaseAdmin.firestore.Timestamp.fromDate(new Date(upliftResult.afterDate)) : null,
              // 3-signal classification metadata (replaces photoComparison)
              renovationClassification: {
                renovationScore: classification.renovationScore,
                confidence: classification.confidence,
                scope: classification.scope,
                signals: classification.signals,
                renovationCount: classification.detectedRenovations.length,
                detectionMethod: 'keyword_feature_price_classifier_v1'
              }
            });
            console.log(`[RenovationProcessor] 💾 Saved uplift result: ${docId}`);
          } catch (fsErr) {
            console.warn(`[RenovationProcessor] Firestore write failed (result still in memory): ${fsErr.message}`);
          }
        }
        
        results.upliftResults.push(upliftResult);
        results.processed++;
        results.successful++;
        
      } catch (error) {
        console.error(`[RenovationProcessor] ❌ Error processing ${address}:`, error.message);
        results.failed++;
        results.errors.push({ address, error: error.message });
      }
    }
    
    // ---------------------------------------------------------------
    // STEP 5: Aggregate area-level statistics
    // ---------------------------------------------------------------
    // Fetch local cap rate from MLS lease + sale data for rent derivation
    let capRateData = null;
    if (zipCode) {
      try {
        capRateData = await snowflake.getLocalCapRate({ zip: zipCode });
        console.log(`[RenovationProcessor] 📊 Local cap rate for ${zipCode}: ${(capRateData?.overall * 100)?.toFixed(1) || 'N/A'}%`);
      } catch (e) {
        console.warn(`[RenovationProcessor] Failed to fetch cap rate for ${zipCode}: ${e.message}`);
      }
    }

    if (results.upliftResults.length > 0) {
      console.log(`[RenovationProcessor] Step 5: Aggregating ${results.upliftResults.length} newly processed results for ${areaLabel}...`);

      // IMPORTANT: Build area summary from ALL stored uplift docs for this ZIP,
      // not just this run. Otherwise a small test run (e.g. limit=2) can
      // overwrite a rich summary with a 1-comparable summary.
      let summaryInput = results.upliftResults;
      if (db && zipCode) {
        try {
          const allZipDocs = await db
            .collection(CONFIG.COLLECTION_UPLIFT_RESULTS)
            .where('zipCode', '==', zipCode)
            .get();

          const allZipResults = allZipDocs.docs
            .map(doc => doc.data())
            .filter(d => d && Array.isArray(d.renovationBreakdown) && d.renovationBreakdown.length > 0)
            .filter(d => isFreshResult(d, maxResultAgeDays));

          if (allZipResults.length > 0) {
            summaryInput = allZipResults;
            console.log(`[RenovationProcessor] Using ${allZipResults.length} total stored uplift results for ${zipCode} summary aggregation`);
          }
        } catch (e) {
          console.warn(`[RenovationProcessor] Failed to load all ZIP uplift docs for aggregation: ${e.message}`);
        }
      }
      
      const areaSummary = aggregateAreaRenovationStats(
        zipCode || areaLabel,
        summaryInput,
        { capRateData, subjectProfile }
      );
      
      // Also aggregate rental data
      const rentalSummary = aggregateRentalUpliftStats(summaryInput);
      
      // Save area summary to Firestore (disabled in live mode)
      if (db && zipCode && !CONFIG.DISABLE_FIRESTORE_CACHE) {
        await db.collection(CONFIG.COLLECTION_AREA_SUMMARIES).doc(zipCode).set({
          ...areaSummary,
          lastUpdated: firebaseAdmin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`[RenovationProcessor] 💾 Saved area summary for ${zipCode}: ${areaSummary.bestROIRenovations.length} renovation types, ${areaSummary.totalComparables} comparables`);
        
        if (rentalSummary.available) {
          await db.collection(CONFIG.COLLECTION_RENTAL_SUMMARIES).doc(zipCode).set({
            zipCode,
            ...rentalSummary,
            lastUpdated: firebaseAdmin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`[RenovationProcessor] 💾 Saved rental summary for ${zipCode}: ${rentalSummary.sampleSize} properties with rent data`);
        }
      }
      
      results.areaSummary = areaSummary;
      results.rentalSummary = rentalSummary;
      results.coreValuation = areaSummary?.coreValuation || null;
    }
    
    // If nothing was processed in this run, still return a live summary from stored uplift docs.
    if (!results.areaSummary && db && zipCode) {
      try {
        const allZipDocs = await db
          .collection(CONFIG.COLLECTION_UPLIFT_RESULTS)
          .where('zipCode', '==', zipCode)
          .get();

        const allZipResults = allZipDocs.docs
          .map(doc => doc.data())
          .filter(d => d && Array.isArray(d.renovationBreakdown) && d.renovationBreakdown.length > 0)
          .filter(d => isFreshResult(d, maxResultAgeDays));

        if (allZipResults.length > 0) {
          results.areaSummary = aggregateAreaRenovationStats(zipCode, allZipResults, { capRateData, subjectProfile });
          results.rentalSummary = aggregateRentalUpliftStats(allZipResults);
          results.coreValuation = results.areaSummary?.coreValuation || null;
          console.log(`[RenovationProcessor] 📦 Built live area summary for ${zipCode}: ${results.areaSummary.totalComparables || 0} comps, ${results.areaSummary.bestROIRenovations?.length || 0} reno types`);
        }
      } catch (e) {
        console.warn(`[RenovationProcessor] Firestore summary fallback failed: ${e.message}`);
      }
    }
    
    // Log processing run
    if (db) {
      try {
        await db.collection(CONFIG.COLLECTION_PROCESSING_LOG).add({
          area: zipCode || city || state,
          startTime: firebaseAdmin.firestore.Timestamp.fromMillis(startTime),
          endTime: firebaseAdmin.firestore.Timestamp.now(),
          durationMs: Date.now() - startTime,
          candidatesFound: pairs.length,
          processed: results.processed,
          successful: results.successful,
          failed: results.failed,
          skipped: results.skipped,
          renovationTypesFound: results.areaSummary?.bestROIRenovations?.length || 0
        });
      } catch (e) {
        console.warn(`[RenovationProcessor] Failed to log processing run: ${e.message}`);
      }
    }
    
    console.log(`[RenovationProcessor] ====== Completed ${areaLabel}: ${results.successful}/${results.processed} successful, ${results.skipped} skipped, ${results.rentalMatchesUsed}/${results.processed || 1} rent matches ======`);
    
    return results;
    
  } catch (error) {
    console.error('[RenovationProcessor] Fatal error:', error);
    throw error;
  }
}

/**
 * Get area summary — from Firestore cache or process on demand
 */
export async function getAreaSummary(zipCode, { maxAge = 7 * 24 * 60 * 60 * 1000, processIfMissing = false } = {}) {
  if (!db) {
    console.warn('[RenovationProcessor] Firestore not available');
    return null;
  }

  // Live mode: bypass summary cache docs and aggregate from uplift result docs.
  if (CONFIG.DISABLE_FIRESTORE_CACHE) {
    const allZipDocs = await db
      .collection(CONFIG.COLLECTION_UPLIFT_RESULTS)
      .where('zipCode', '==', zipCode)
      .get();

    const allZipResults = allZipDocs.docs
      .map(doc => doc.data())
      .filter(d => d && Array.isArray(d.renovationBreakdown) && d.renovationBreakdown.length > 0)
      .filter(d => isFreshResult(d, CONFIG.MAX_RESULT_AGE_DAYS));

    if (allZipResults.length > 0) {
      // Fetch local cap rate for rent derivation
      let capRateData = null;
      try {
        capRateData = await snowflake.getLocalCapRate({ zip: zipCode });
        console.log(`[RenovationProcessor] 📊 Cap rate for ${zipCode}: ${(capRateData?.overall * 100)?.toFixed(1) || 'N/A'}%`);
      } catch (e) {
        console.warn(`[RenovationProcessor] Failed to fetch cap rate: ${e.message}`);
      }
      const summary = aggregateAreaRenovationStats(zipCode, allZipResults, { capRateData });
      console.log(`[RenovationProcessor] Live summary for ${zipCode} (${summary.totalComparables} comps, ${summary.bestROIRenovations?.length || 0} reno types)`);
      return summary;
    }

    if (processIfMissing) {
      // Validate the ZIP looks reasonable before burning API quota
      if (!zipCode || !/^\d{5}$/.test(zipCode)) {
        console.warn(`[RenovationProcessor] Invalid ZIP '${zipCode}', skipping processIfMissing`);
        return null;
      }
      console.log(`[RenovationProcessor] No live uplift docs for ${zipCode}, processing...`);
      const result = await processAreaRenovations({ zipCode, limit: CONFIG.BATCH_SIZE });
      return result.areaSummary || null;
    }

    return null;
  }
  
  // Try cached summary
  const doc = await db.collection(CONFIG.COLLECTION_AREA_SUMMARIES).doc(zipCode).get();
  
  if (doc.exists) {
    const data = doc.data();
    const lastUpdated = data.lastUpdated?.toDate?.() || data.lastUpdated;
    
    if (lastUpdated && (Date.now() - new Date(lastUpdated).getTime()) < maxAge) {
      console.log(`[RenovationProcessor] Cache hit for ${zipCode} (${data.totalComparables} comps, ${data.bestROIRenovations?.length || 0} reno types)`);
      return data;
    }
  }
  
  // Optionally trigger processing if cache is stale
  if (processIfMissing) {
    console.log(`[RenovationProcessor] Cache miss for ${zipCode}, processing...`);
    const result = await processAreaRenovations({ zipCode, limit: CONFIG.BATCH_SIZE });
    return result.areaSummary || null;
  }
  
  return doc.exists ? doc.data() : null;
}

/**
 * Get rental uplift summary for a zip code
 */
export async function getRentalSummary(zipCode) {
  if (!db) return null;

  if (CONFIG.DISABLE_FIRESTORE_CACHE) {
    const allZipDocs = await db
      .collection(CONFIG.COLLECTION_UPLIFT_RESULTS)
      .where('zipCode', '==', zipCode)
      .get();

    const allZipResults = allZipDocs.docs
      .map(doc => doc.data())
      .filter(d => d && Array.isArray(d.renovationBreakdown) && d.renovationBreakdown.length > 0)
      .filter(d => isFreshResult(d, CONFIG.MAX_RESULT_AGE_DAYS));

    if (allZipResults.length === 0) return null;
    return {
      zipCode,
      ...aggregateRentalUpliftStats(allZipResults)
    };
  }
  
  const doc = await db.collection(CONFIG.COLLECTION_RENTAL_SUMMARIES).doc(zipCode).get();
  return doc.exists ? doc.data() : null;
}

/**
 * Get comparable properties used in regional uplift analysis for a ZIP.
 * Returns normalized, UI-friendly comparable rows with renovation breakdown.
 */
export async function getAreaComparables(zipCode, { limit = 20 } = {}) {
  if (!db) return [];

  const toISO = (value) => {
    if (!value) return null;
    if (typeof value?.toDate === 'function') {
      try { return value.toDate().toISOString(); } catch { return null; }
    }
    try {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d.toISOString();
    } catch {
      return null;
    }
  };

  const snap = await db
    .collection(CONFIG.COLLECTION_UPLIFT_RESULTS)
    .where('zipCode', '==', zipCode)
    .get();

  const rows = snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(d => d && Array.isArray(d.renovationBreakdown) && d.renovationBreakdown.length > 0)
    .filter(d => isFreshResult(d, CONFIG.MAX_RESULT_AGE_DAYS))
    .sort((a, b) => {
      const aTs = a.analyzedAt?.seconds || a.analyzedAt?._seconds || new Date(a.analyzedAt || 0).getTime() / 1000 || 0;
      const bTs = b.analyzedAt?.seconds || b.analyzedAt?._seconds || new Date(b.analyzedAt || 0).getTime() / 1000 || 0;
      return bTs - aTs;
    })
    .slice(0, Math.max(1, limit))
    .map(d => ({
      id: d.id,
      address: d.address,
      zipCode: d.zipCode,
      state: d.state,
      propertyType: d.propertyType,
      sqft: d.sqft,
      beds: d.beds,
      baths: d.baths,
      yearBuilt: d.yearBuilt,
      holdingMonths: d.holdingMonths,
      beforeSalePrice: d.beforeSalePrice,
      afterSalePrice: d.afterSalePrice,
      beforeDate: toISO(d.beforeDate),
      afterDate: toISO(d.afterDate),
      rawPriceIncreasePercent: d.rawPriceIncreasePercent,
      renovationAttributedUplift: d.renovationAttributedUplift,
      totalRenovationCost: d.totalRenovationCost,
      overallValueROI: d.overallValueROI,
      rentAnalysis: {
        rentBefore: d.rentAnalysis?.rentBefore ?? null,
        rentAfter: d.rentAnalysis?.rentAfter ?? null,
        rentIncrease: d.rentAnalysis?.rentIncrease ?? null,
        rentIncreasePercent: d.rentAnalysis?.rentIncreasePercent ?? null,
      },
      confidence: {
        score: d.confidence?.score ?? null,
        level: d.confidence?.level ?? 'unknown'
      },
      photoComparison: d.photoComparison ? {
        beforePhotos: d.photoComparison?.beforePhotos || [],
        afterPhotos: d.photoComparison?.afterPhotos || [],
        renovationCount: d.photoComparison?.renovationCount || (d.renovationBreakdown || []).length || 0,
        overallConfidence: d.photoComparison?.overallConfidence ?? null
      } : null,
      // 3-signal classifier metadata (v3+)
      renovationClassification: d.renovationClassification || null,
      // Before-condition scores (legacy photo analysis or null)
      beforeCondition: d.beforeCondition || d.photoComparison?.beforeCondition || null,
      renovations: (d.renovationBreakdown || []).map(r => ({
        category: r.category,
        scope: r.scope,
        description: r.description,
        qualityLevel: r.qualityLevel || null,
        beforeDescription: r.beforeDescription || null,
        afterDescription: r.afterDescription || null,
        confidence: r.confidence,
        allocatedUplift: r.allocatedUplift,
        warning: r.warning || null
      }))
    }));

  return rows;
}

/**
 * Bulk process multiple ZIP codes
 */
export async function bulkProcessAreas(zipCodes, options = {}) {
  const results = {
    total: zipCodes.length,
    completed: 0,
    failed: 0,
    details: []
  };
  
  for (const zipCode of zipCodes) {
    try {
      console.log(`[RenovationProcessor] Processing ${results.completed + 1}/${zipCodes.length}: ${zipCode}`);
      
      const areaResult = await processAreaRenovations({
        zipCode,
        ...options
      });
      
      results.completed++;
      results.details.push({
        zipCode,
        status: 'success',
        processed: areaResult.processed,
        successful: areaResult.successful,
        renovationTypes: areaResult.areaSummary?.bestROIRenovations?.length || 0
      });
      
    } catch (error) {
      console.error(`[RenovationProcessor] Failed to process ${zipCode}:`, error);
      results.failed++;
      results.details.push({
        zipCode,
        status: 'failed',
        error: error.message
      });
    }
    
    // Rate limiting between areas
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  return results;
}

/**
 * Scheduled processing — processes a batch of active market zip codes
 */
export async function scheduledProcessing() {
  console.log('[RenovationProcessor] Starting scheduled processing run');
  
  const activeMarkets = [
    // Texas metros
    '75001', '75002', '75006', '75007', '75201', '75204', '75205',
    '77001', '77002', '77003', '77004', '77005', '77006', '77007',
    '78201', '78202', '78203', '78204', '78205', '78209', '78212',
    '78701', '78702', '78703', '78704', '78705', '78721', '78741',
    // Florida metros
    '33101', '33109', '33125', '33129', '33130', '33131', '33133',
    '32801', '32803', '32806', '32807', '32808', '32809', '32811',
    '33401', '33403', '33405', '33407', '33409', '33410', '33411',
    // Arizona
    '85001', '85003', '85004', '85006', '85007', '85008', '85012',
    '85201', '85202', '85203', '85204', '85205', '85206', '85207',
    '85251', '85253', '85254', '85255', '85256', '85257', '85258',
    // Georgia
    '30301', '30303', '30305', '30306', '30307', '30308', '30309',
    // North Carolina
    '28201', '28202', '28203', '28204', '28205', '28206', '28207',
    // Tennessee
    '37201', '37203', '37204', '37205', '37206', '37207', '37208',
    // Ohio
    '43201', '43202', '43203', '43204', '43205', '43206', '43207',
  ];
  
  // Round-robin: process 10 zips per run
  const batchSize = 10;
  const dayIndex = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const offset = (dayIndex % Math.ceil(activeMarkets.length / batchSize)) * batchSize;
  const batch = activeMarkets.slice(offset, offset + batchSize);
  
  console.log(`[RenovationProcessor] Processing batch: ${batch.join(', ')}`);
  
  return await bulkProcessAreas(batch, {
    limit: CONFIG.BATCH_SIZE,
    skipProcessed: true
  });
}

/**
 * Parse materials from MLS PUBLICREMARKS text.
 * Looks for common material keywords and classifies them by renovation category and tier.
 */
function parseMaterialsFromRemarks(remarks) {
  if (!remarks || typeof remarks !== 'string') return [];
  
  const text = remarks.toLowerCase();
  const found = [];
  
  // Material patterns: [regex, name, category, tier]
  const MATERIAL_PATTERNS = [
    // Countertops
    [/quartzite\s*counter/i,       'quartzite countertops',      'kitchen', 'luxury'],
    [/marble\s*counter/i,          'marble countertops',         'kitchen', 'luxury'],
    [/granite\s*counter/i,         'granite countertops',        'kitchen', 'high_end'],
    [/quartz\s*counter/i,          'quartz countertops',         'kitchen', 'mid_grade'],
    [/butcher\s*block/i,           'butcher block countertops',  'kitchen', 'mid_grade'],
    [/concrete\s*counter/i,        'concrete countertops',       'kitchen', 'mid_grade'],
    [/laminate\s*counter/i,        'laminate countertops',       'kitchen', 'budget'],
    [/corian/i,                    'Corian countertops',         'kitchen', 'mid_grade'],
    
    // Cabinets
    [/custom\s*cabinet/i,          'custom cabinets',            'kitchen', 'luxury'],
    [/shaker\s*cabinet/i,          'shaker cabinets',            'kitchen', 'mid_grade'],
    [/raised\s*panel/i,            'raised panel cabinets',      'kitchen', 'high_end'],
    [/flat[\s-]*panel\s*cabinet/i, 'flat-panel cabinets',        'kitchen', 'mid_grade'],
    [/slab\s*cabinet/i,            'slab cabinets',              'kitchen', 'high_end'],
    [/thermofoil/i,                'thermofoil cabinets',        'kitchen', 'budget'],
    [/42[\s"]*inch\s*cabinet/i,    '42-inch cabinets',           'kitchen', 'high_end'],
    [/soft[\s-]*close/i,           'soft-close cabinets',        'kitchen', 'mid_grade'],
    
    // Flooring
    [/solid\s*hardwood/i,          'solid hardwood flooring',    'flooring', 'high_end'],
    [/engineered\s*hardwood/i,     'engineered hardwood',        'flooring', 'mid_grade'],
    [/(?:lvp|luxury\s*vinyl\s*plank)/i, 'LVP flooring',         'flooring', 'mid_grade'],
    [/(?:lvt|luxury\s*vinyl\s*tile)/i,  'LVT flooring',         'flooring', 'mid_grade'],
    [/laminate\s*floor/i,          'laminate flooring',          'flooring', 'budget'],
    [/sheet\s*vinyl/i,             'sheet vinyl flooring',       'flooring', 'budget'],
    [/porcelain\s*tile/i,          'porcelain tile',             'flooring', 'mid_grade'],
    [/ceramic\s*tile/i,            'ceramic tile',               'flooring', 'budget'],
    [/natural\s*stone\s*floor/i,   'natural stone flooring',     'flooring', 'luxury'],
    [/travertine/i,                'travertine flooring',        'flooring', 'high_end'],
    [/slate\s*floor/i,             'slate flooring',             'flooring', 'high_end'],
    [/carpet/i,                    'carpet',                     'flooring', 'budget'],
    
    // Backsplash
    [/glass\s*mosaic/i,            'glass mosaic backsplash',    'kitchen', 'high_end'],
    [/subway\s*tile/i,             'subway tile backsplash',     'kitchen', 'mid_grade'],
    [/marble\s*backsplash/i,       'marble backsplash',          'kitchen', 'luxury'],
    [/herringbone/i,               'herringbone tile',           'kitchen', 'high_end'],
    [/peel[\s-]*and[\s-]*stick/i,  'peel-and-stick backsplash',  'kitchen', 'budget'],
    
    // Fixtures & Appliances
    [/panel[\s-]*ready/i,          'panel-ready appliances',     'kitchen', 'luxury'],
    [/wolf|sub[\s-]*zero|thermador|viking|miele/i, 'pro-grade appliances', 'kitchen', 'luxury'],
    [/stainless\s*(?:steel\s*)?appli/i, 'stainless appliances',  'kitchen', 'mid_grade'],
    [/matte\s*black\s*(?:fix|hard)/i,   'matte black fixtures',  'bathroom_master', 'mid_grade'],
    [/brushed\s*(?:nickel|gold)/i, 'brushed nickel/gold fixtures','bathroom_master', 'high_end'],
    
    // Bathroom
    [/frameless\s*(?:glass\s*)?shower/i, 'frameless glass shower','bathroom_master', 'high_end'],
    [/rain\s*(?:fall\s*)?shower/i, 'rainfall showerhead',        'bathroom_master', 'high_end'],
    [/free[\s-]*standing\s*tub/i,  'freestanding tub',           'bathroom_master', 'high_end'],
    [/vessel\s*sink/i,             'vessel sink',                'bathroom_master', 'mid_grade'],
    [/undermount\s*sink/i,         'undermount sink',            'kitchen', 'mid_grade'],
    [/farm(?:house)?\s*sink/i,     'farmhouse sink',             'kitchen', 'mid_grade'],
    
    // Exterior
    [/james\s*hardie|fiber\s*cement\s*siding/i, 'fiber cement siding', 'siding', 'high_end'],
    [/vinyl\s*siding/i,            'vinyl siding',               'siding', 'budget'],
    [/standing\s*seam\s*(?:metal\s*)?roof/i, 'standing seam metal roof', 'roof', 'high_end'],
    [/architectural\s*shingle/i,   'architectural shingles',     'roof', 'mid_grade'],
    [/3[\s-]*tab\s*shingle/i,      '3-tab shingles',             'roof', 'budget'],
    
    // Windows
    [/double[\s-]*pane|insulated\s*glass/i, 'double-pane windows', 'windows', 'mid_grade'],
    [/triple[\s-]*pane/i,          'triple-pane windows',        'windows', 'high_end'],
    [/impact[\s-]*(?:resistant\s*)?window/i, 'impact-resistant windows', 'windows', 'high_end'],
  ];
  
  for (const [pattern, name, category, tier] of MATERIAL_PATTERNS) {
    if (pattern.test(text)) {
      found.push({ name, category, materialTier: tier, confidence: 0.7, source: 'mls_remarks' });
    }
  }
  
  return found;
}

/**
 * Enrich photo-detected renovations with materials found in MLS remarks.
 * If GPT-4o detected a kitchen reno but didn't identify materials, and the
 * MLS remarks say "quartz countertops, LVP flooring", we add those materials
 * to the kitchen renovation.
 */
function enrichRenovationsWithMLSMaterials(renovations, mlsMaterials) {
  if (!mlsMaterials || mlsMaterials.length === 0) return renovations;
  
  // Map MLS categories to photo comparison categories
  const CATEGORY_MATCH = {
    'kitchen': ['kitchen'],
    'bathroom_master': ['bathroom_master', 'bathroom_secondary'],
    'bathroom_secondary': ['bathroom_master', 'bathroom_secondary'],
    'flooring': ['flooring'],
    'siding': ['siding', 'paint_exterior'],
    'roof': ['roof'],
    'windows': ['windows'],
  };
  
  return renovations.map(reno => {
    // Find MLS materials that match this renovation's category
    const matchingMLSMaterials = mlsMaterials.filter(m => {
      const matchCategories = CATEGORY_MATCH[m.category] || [m.category];
      return matchCategories.includes(reno.category);
    });
    
    if (matchingMLSMaterials.length === 0) return reno;
    
    // Merge: keep photo-detected materials, add MLS materials that aren't duplicates
    const existingNames = new Set((reno.materials || []).map(m => m.name.toLowerCase()));
    const newMaterials = matchingMLSMaterials.filter(m => !existingNames.has(m.name.toLowerCase()));
    
    return {
      ...reno,
      materials: [...(reno.materials || []), ...newMaterials]
    };
  });
}

/**
 * Classify overall material tier from enriched renovations.
 * Weighted by cost × confidence.
 */
function classifyMaterialTier(renovations) {
  if (!renovations || renovations.length === 0) return 'unknown';
  
  const TIER_SCORES = { 'budget': 1, 'mid_grade': 2, 'high_end': 3, 'luxury': 4 };
  const TIER_NAMES = ['unknown', 'budget', 'mid_grade', 'high_end', 'luxury'];
  
  let weightedSum = 0;
  let totalWeight = 0;
  
  for (const reno of renovations) {
    const materials = reno.materials || [];
    if (materials.length > 0) {
      for (const mat of materials) {
        const score = TIER_SCORES[mat.materialTier] || 2;
        const weight = (mat.confidence || 0.5);
        weightedSum += score * weight;
        totalWeight += weight;
      }
    } else {
      const score = TIER_SCORES[reno.qualityLevel] || 2;
      const weight = (reno.confidence || 0.5);
      weightedSum += score * weight;
      totalWeight += weight;
    }
  }
  
  if (totalWeight === 0) return 'unknown';
  const avgScore = weightedSum / totalWeight;
  return TIER_NAMES[Math.min(Math.round(avgScore), TIER_NAMES.length - 1)];
}

/**
 * Get neighboring ZIP codes for data expansion when a single ZIP has thin data.
 * Uses ZIP+1/ZIP-1 heuristic (adjacent ZIPs are often geographically close).
 * Returns up to 4 neighbors.
 */
function getNeighborZips(zip) {
  const zipNum = parseInt(zip, 10);
  if (isNaN(zipNum)) return [];
  return [
    String(zipNum - 1).padStart(5, '0'),
    String(zipNum + 1).padStart(5, '0'),
    String(zipNum - 2).padStart(5, '0'),
    String(zipNum + 2).padStart(5, '0'),
  ].filter(z => z !== zip && parseInt(z, 10) > 0 && parseInt(z, 10) <= 99999);
}

// Export for use in API routes and scheduled jobs
export default {
  processAreaRenovations,
  getAreaSummary,
  getRentalSummary,
  getAreaComparables,
  bulkProcessAreas,
  scheduledProcessing,
  CONFIG
};
