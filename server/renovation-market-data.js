/**
 * Renovation Market Data Service
 * Combines ATTOM property data with Google Search contractor costs
 * to generate accurate renovation cost, ROI, and value lift estimates
 */

import 'dotenv/config';
import { fetchRenovationMarketDashboard, RENOVATION_MARKET_ENDPOINT_COUNT } from './attom.js';
import {
  getCachedAttomData,
  getCachedAttomDataById,
  cacheAttomData,
  isUsableAttomDashboardData,
  scoreAttomDashboardData,
} from './attom-firestore-cache.js';

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function round(value, precision = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const factor = 10 ** precision;
  return Math.round(numeric * factor) / factor;
}

function toNullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildCanonicalSourceReference(source, reference, note = null) {
  if (!source || !reference) {
    return null;
  }

  return {
    source,
    reference,
    ...(note ? { note } : {}),
  };
}

function buildCanonicalPropertyProfile(dashboard, address = '') {
  const summary = dashboard?.summary || {};
  const taxHistory = Array.isArray(dashboard?.tax_history?.rows)
    ? dashboard.tax_history.rows
    : Array.isArray(dashboard?.tax_history)
      ? dashboard.tax_history
      : [];
  const latestTax = taxHistory[0] || null;
  const rawAttomFacts = dashboard?.raw || summary || null;
  const normalizedAddress = summary.address || address || '';

  return {
    address: normalizedAddress,
    zip: extractZipCode(normalizedAddress),
    latitude: toNullableNumber(summary.latitude ?? dashboard?.location?.latitude),
    longitude: toNullableNumber(summary.longitude ?? dashboard?.location?.longitude),
    yearBuilt: toNullableNumber(summary.year_built),
    beds: toNullableNumber(summary.beds),
    baths: toNullableNumber(summary.baths),
    livingSqft: toNullableNumber(summary.living_sqft ?? summary.building_sqft),
    propertyType: summary.property_type || null,
    rawAttomFacts: rawAttomFacts && typeof rawAttomFacts === 'object' ? rawAttomFacts : null,
    livingAreaContext: {
      sqft: toNullableNumber(summary.living_sqft ?? summary.building_sqft),
      source: summary.living_sqft ? 'attom.summary.living_sqft' : summary.building_sqft ? 'attom.summary.building_sqft' : 'attom.summary',
    },
    lotContext: {
      acres: toNullableNumber(summary.lot_acres),
      sqft: toNullableNumber(summary.lot_sqft)
        || (typeof summary.lot_acres === 'number' ? Math.round(summary.lot_acres * 43560) : null),
      source: summary.lot_sqft ? 'attom.summary.lot_sqft' : summary.lot_acres ? 'attom.summary.lot_acres' : 'attom.summary',
    },
    ageContext: {
      actualAge: toNullableNumber(summary.age),
      effectiveAge: toNullableNumber(summary.age),
      source: 'attom.summary.age',
    },
    hazardContext: {
      flood: toNullableNumber(dashboard?.environmental?.flood?.score ?? dashboard?.hazard_scores?.flood),
      fire: toNullableNumber(dashboard?.environmental?.fire?.score ?? dashboard?.hazard_scores?.fire),
      earthquake: toNullableNumber(dashboard?.environmental?.earthquake?.score ?? dashboard?.hazard_scores?.earthquake),
      source: 'attom.environmental',
    },
    taxContext: {
      assessedValue: toNullableNumber(summary.assessed_value),
      latestTaxAmount: toNullableNumber(latestTax?.tax_amount),
      taxHistoryYears: taxHistory.length,
      source: 'attom.tax_history',
    },
    avmContext: {
      avmValue: toNullableNumber(dashboard?.avm?.amount ?? summary.avm_value),
      avmLow: toNullableNumber(summary.avm_low),
      avmHigh: toNullableNumber(summary.avm_high),
      source: dashboard?.avm?.amount ? 'attom.avm.amount' : 'attom.summary.avm_*',
    },
    marketContextReferences: [
      buildCanonicalSourceReference('attom_dashboard', normalizedAddress, 'Cache-first ATTOM property dashboard context.'),
    ].filter(Boolean),
    existingRentBaselineReferences: [
      dashboard?.avm?.rental_avm
        ? buildCanonicalSourceReference('attom_avm', 'rental_avm', 'ATTOM rental AVM baseline used when available.')
        : null,
    ].filter(Boolean),
  };
}

/**
 * Get local market comparables and price trends from ATTOM
 */
function normalizeMarketDataLookup(propertyLookup) {
  if (typeof propertyLookup === 'string') {
    return {
      address: propertyLookup.trim(),
      attomId: '',
    };
  }

  const embeddedPropertyData = propertyLookup?.propertyData || propertyLookup?.property_data || null;
  return {
    address: String(
      propertyLookup?.address
      || embeddedPropertyData?.summary?.address
      || ''
    ).trim(),
    attomId: String(
      propertyLookup?.attomId
      || propertyLookup?.attom_id
      || propertyLookup?.summary?.attom_id
      || embeddedPropertyData?.summary?.attom_id
      || ''
    ).trim(),
  };
}

function isTruthyFlag(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value || '').toLowerCase());
}

function summarizeCacheRecord(cacheRecord, keySource) {
  if (!cacheRecord) {
    return {
      hit: false,
      usable: false,
      keySource,
      ageDays: null,
      stale: null,
    };
  }

  return {
    hit: true,
    usable: isUsableAttomDashboardData(cacheRecord.data),
    keySource,
    ageDays: cacheRecord.ageDays ?? null,
    stale: Boolean(cacheRecord.stale),
  };
}

export async function getLocalMarketData(propertyLookup, options = {}) {
  try {
    const { address, attomId } = normalizeMarketDataLookup(propertyLookup);
    const skipCacheRead = isTruthyFlag(options.skipCacheRead);
    const diagnostics = {
      request: {
        address: address || null,
        attomId: attomId || null,
      },
      source: 'unavailable',
      cache: {
        lookupByAddress: Boolean(address),
        lookupByAttomId: Boolean(attomId),
        selected: null,
        address: summarizeCacheRecord(null, 'address'),
        attomId: summarizeCacheRecord(null, 'attomId'),
        partialFallbackUsed: false,
        skipCacheRead,
      },
      liveFetch: {
        attempted: false,
        succeeded: false,
        endpointCount: RENOVATION_MARKET_ENDPOINT_COUNT,
        writeThroughAttempted: false,
        writeThroughAddress: null,
        writeThroughAttomId: null,
      },
      cacheOnlyMode: false,
      errors: [],
    };
    const cacheOnlyMode = ['1', 'true', 'yes'].includes(String(process.env.ATTOM_CACHE_ONLY || '').toLowerCase());
    diagnostics.cacheOnlyMode = cacheOnlyMode;
    let cached = null;

    if (!skipCacheRead && address) {
      cached = await getCachedAttomData(address);
      diagnostics.cache.address = summarizeCacheRecord(cached, 'address');
    }

    if (!skipCacheRead && !isUsableAttomDashboardData(cached?.data) && attomId) {
      const attomIdCache = await getCachedAttomDataById(attomId);
      diagnostics.cache.attomId = summarizeCacheRecord(attomIdCache, 'attomId');
      cached = attomIdCache || cached;
    }

    let dashboard = null;

    // Cache-first to minimize ATTOM quota usage.
    if (cached?.data && isUsableAttomDashboardData(cached.data)) {
      console.log(`[Market Data] Using cached ATTOM dashboard for renovation analysis (${cached.ageDays}d old)`);
      dashboard = cached.data;
      diagnostics.source = diagnostics.cache.attomId.hit && diagnostics.cache.attomId.usable && (!diagnostics.cache.address.usable)
        ? 'attom_id_cache'
        : 'address_cache';
      diagnostics.cache.selected = diagnostics.source;
    }

    if (!dashboard && !cacheOnlyMode) {
      diagnostics.liveFetch.attempted = true;
      try {
        dashboard = await fetchRenovationMarketDashboard({
          address: address || undefined,
          attomId: attomId || undefined,
        });
        diagnostics.liveFetch.succeeded = Boolean(dashboard?.summary);
        diagnostics.source = diagnostics.liveFetch.succeeded ? 'live_attom' : diagnostics.source;

        const cacheAddress = address || dashboard?.summary?.address || '';
        const cacheAttomId = dashboard?.summary?.attom_id || attomId || null;
        if (dashboard && cacheAddress) {
          diagnostics.liveFetch.writeThroughAttempted = true;
          diagnostics.liveFetch.writeThroughAddress = cacheAddress;
          diagnostics.liveFetch.writeThroughAttomId = cacheAttomId;
          await cacheAttomData(cacheAddress, dashboard, cacheAttomId);
        }
      } catch (attomErr) {
        console.warn('[Market Data] ATTOM live fetch failed:', attomErr.message);
        diagnostics.errors.push(`live_fetch:${attomErr.message}`);
      }
    }

    // In cache-only mode (or when ATTOM fails), use any cached record we have,
    // even if partial. This keeps renovation analysis functional.
    if (!dashboard && cached?.data) {
      console.warn(`[Market Data] Falling back to partial cached ATTOM data (score ${scoreAttomDashboardData(cached.data)})`);
      dashboard = cached.data;
      diagnostics.cache.partialFallbackUsed = true;
      diagnostics.source = diagnostics.cache.attomId.hit && diagnostics.cache.attomId.keySource === 'attomId' && (!diagnostics.cache.address.hit || !diagnostics.cache.address.usable)
        ? 'attom_id_partial_cache'
        : 'address_partial_cache';
      diagnostics.cache.selected = diagnostics.source;
    }

    console.log(
      `[Market Data] Diagnostics source=${diagnostics.source} addressCache=${diagnostics.cache.address.hit ? (diagnostics.cache.address.usable ? 'usable' : 'partial') : 'miss'} ` +
      `attomIdCache=${diagnostics.cache.attomId.hit ? (diagnostics.cache.attomId.usable ? 'usable' : 'partial') : 'miss'} ` +
      `liveAttempted=${diagnostics.liveFetch.attempted} liveSucceeded=${diagnostics.liveFetch.succeeded} ` +
      `endpointCount=${diagnostics.liveFetch.endpointCount} writeThrough=${diagnostics.liveFetch.writeThroughAttempted}`
    );
    
    if (!dashboard || !dashboard.summary) {
      return { ok: false, error: 'Failed to fetch property data', diagnostics };
    }

    const summary = dashboard.summary;
    const taxHistory = Array.isArray(dashboard.tax_history)
      ? dashboard.tax_history
      : (dashboard.tax_history?.rows || []);
    const salesHistory = dashboard.sales_history || [];
    const avm = dashboard.avm;
    const canonicalPropertyProfile = buildCanonicalPropertyProfile(dashboard, address);
    
    // Calculate market appreciation trends
    const recentTaxes = taxHistory.slice(0, 5);
    const avgTaxGrowth = recentTaxes.length
      ? recentTaxes.reduce((sum, row) => sum + (row.tax_amount_yoy_pct || 0), 0) / recentTaxes.length
      : 0;

    // Extract market appreciation from sales history
    const marketAppreciation = calculateAppreciationRate(salesHistory);
    
    // Extract zip code from address for location-specific calculations
    const zipCode = extractZipCode(address || summary.address || '');
    const parsedAddress = extractCityState(address || summary.address || '');
    const areaContext = summary.area_context || {};
    const lotSize = summary.lot_sqft || 0;
    const city = summary.city || areaContext.city || parsedAddress.city || '';
    const state = (summary.state || areaContext.state || parsedAddress.state || '').toUpperCase();
    const county = areaContext.county || summary.county || '';
    const metro = areaContext.metro || areaContext.cbsa_name || areaContext.market_name || '';
    
    return {
      ok: true,
      propertyValue: avm?.amount || summary.avm_value || 0,
      estimatedRent: avm?.rental_avm || summary.rental_avm || 0,
      location: summary.address || address,
      neighborhood: summary.neighborhood || extractNeighborhood(address || summary.address || ''),
      propertyType: summary.property_type || 'single_family',
      yearBuilt: summary.year_built,
      beds: summary.beds,
      baths: summary.baths,
      sqft: summary.living_sqft || summary.building_sqft,
      lotSize: lotSize,
      zipCode: zipCode,
      city,
      state,
      county,
      metro,
      marketAppreciationRate: marketAppreciation,
      avgTaxGrowthRate: avgTaxGrowth,
      taxHistory: recentTaxes,
      salesHistory: salesHistory,
      comparableValueRange: {
        low: avm?.amount ? avm.amount * 0.9 : 0,
        high: avm?.amount ? avm.amount * 1.1 : 0
      },
      attomDashboard: dashboard,
      diagnostics,
      canonicalPropertyProfile,
      locationContext: {
        address: summary.address || address,
        zipCode,
        city,
        state,
        county,
        metro,
      }
    };
  } catch (error) {
    console.error('[Market Data] Error:', error);
    return {
      ok: false,
      error: error.message,
      diagnostics: {
        source: 'exception',
        errors: [error.message],
        liveFetch: {
          attempted: false,
          succeeded: false,
          endpointCount: RENOVATION_MARKET_ENDPOINT_COUNT,
          writeThroughAttempted: false,
          writeThroughAddress: null,
          writeThroughAttomId: null,
        },
      },
    };
  }
}

/**
 * Search for contractor renovation costs using Google Custom Search
 */
export async function searchContractorCosts(renovationType, location) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
    return { ok: false, error: 'Google Search not configured' };
  }

  try {
    // Generate smart search query using GPT-4o
    const queryPrompt = `Generate a Google search query to find 2024-2025 contractor cost estimates for this renovation:

Renovation: ${renovationType}
Location: ${location}

Focus on:
- Cost estimator websites (HomeAdvisor, Angi, Fixr, HomeGuide, etc.)
- Local contractor average pricing
- Recent cost guides and articles
- Include location for regional pricing

Output ONLY the search query, no explanation.`;

    const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You create precise Google search queries for finding contractor renovation cost data. Output only the search query.' },
          { role: 'user', content: queryPrompt }
        ],
        max_tokens: 100,
        temperature: 0.3
      })
    });

    const gptResult = await gptResponse.json();
    const searchQuery = gptResult.choices?.[0]?.message?.content?.trim() || 
                       `${renovationType} cost estimate ${location} 2025 contractor prices`;

    console.log('[Contractor Costs] Search query:', searchQuery);

    // Execute Google Custom Search
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_CX);
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('num', 5);

    const searchResponse = await fetch(url.toString());
    const searchResults = await searchResponse.json();

    if (!searchResults.items || searchResults.items.length === 0) {
      return { ok: false, error: 'No search results found' };
    }

    // Extract cost information from search results
    const costData = await extractCostData(searchResults.items, renovationType);

    return {
      ok: true,
      query: searchQuery,
      sources: searchResults.items.map(item => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet
      })),
      costData
    };

  } catch (error) {
    console.error('[Contractor Costs] Error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Use GPT-4o to extract structured cost data from search results
 */
async function extractCostData(searchResults, renovationType) {
  const snippets = searchResults.map(r => `${r.title}\n${r.snippet}`).join('\n\n');

  const extractionPrompt = `Extract renovation cost estimates from these search results for: ${renovationType}

Search Results:
${snippets}

Extract:
1. Low estimate (minimum realistic cost)
2. Average estimate (typical cost)
3. High estimate (maximum typical cost)
4. Cost factors mentioned (materials, labor, size, etc.)
5. Regional adjustments mentioned

Return as JSON:
{
  "lowEstimate": number,
  "avgEstimate": number,
  "highEstimate": number,
  "costFactors": ["factor1", "factor2"],
  "confidence": "high" | "medium" | "low",
  "notes": "brief summary of findings"
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You extract numerical cost estimates from web search results. Return only valid JSON.' },
          { role: 'user', content: extractionPrompt }
        ],
        max_tokens: 500,
        temperature: 0.2
      })
    });

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return {
      lowEstimate: 0,
      avgEstimate: 0,
      highEstimate: 0,
      confidence: 'low',
      notes: 'Failed to extract cost data'
    };

  } catch (error) {
    console.error('[Cost Extraction] Error:', error);
    return null;
  }
}

/**
 * Calculate comprehensive renovation metrics combining market data and contractor costs
 */
export async function calculateRenovationMetrics(renovation, marketData, contractorCosts, externalContext = {}) {
  try {
    // Safety check: ensure we have valid inputs
    if (!renovation || typeof renovation !== 'object') {
      throw new Error('Invalid renovation object');
    }
    
    // Ensure marketData exists with defaults
    const safeMarketData = {
      propertyValue: 450000,
      estimatedRent: 2500,
      yearBuilt: 1995,
      propertyType: 'single_family',
      marketAppreciationRate: 0.03,
      sqft: 1800,
      lotSize: 6000,
      zipCode: '',
      location: '',
      neighborhood: '',
      canonicalPropertyProfile: null,
      ...marketData // Override with actual data if provided
    };

    const rentcastContext = deriveRentcastMarketContext(externalContext.rentcastData, safeMarketData);
    const macroContext = deriveMacroMarketContext(externalContext.macroData);

    if ((!safeMarketData.estimatedRent || safeMarketData.estimatedRent <= 0) && rentcastContext.marketRentBenchmark) {
      safeMarketData.estimatedRent = rentcastContext.marketRentBenchmark;
    }

    if ((!safeMarketData.comparableValueRange?.high || safeMarketData.comparableValueRange.high <= 0) && rentcastContext.marketSaleBenchmark) {
      safeMarketData.comparableValueRange = {
        low: Math.round(rentcastContext.marketSaleBenchmark * 0.92),
        high: Math.round(rentcastContext.marketSaleBenchmark * 1.08),
      };
    }
    
    // Use the average contractor cost as base
    const renovationCost = contractorCosts.costData?.avgEstimate || renovation.estimatedCost || 0;
    const analysisContext = buildRenovationAnalysisContext(renovation, safeMarketData, renovationCost);
    analysisContext.rentcastContext = rentcastContext;
    analysisContext.macroContext = macroContext;
    analysisContext.canonicalPropertyProfile = externalContext.canonicalPropertyProfile || safeMarketData.canonicalPropertyProfile || null;
    
    // Calculate value lift based on market data with location awareness
    const valueAnalysis = calculateValueLift(
      renovation.type,
      renovationCost,
      safeMarketData,
      renovation.materialQuality || 'mid-range',
      renovation.details || '',
      analysisContext
    );
    const valueLift = valueAnalysis.valueLift;

    // Calculate rent lift based on market and renovation type with location awareness
    const rentAnalysis = calculateRentLift(
      renovation.type,
      safeMarketData,
      renovationCost,
      renovation.materialQuality || 'mid-range',
      analysisContext
    );
    const rentLift = rentAnalysis.rentLift;

    console.log(`[Rent Lift] ${renovation.type}: Current rent $${safeMarketData.estimatedRent} + $${rentLift}/mo (${safeMarketData.estimatedRent > 0 ? ((rentLift / safeMarketData.estimatedRent) * 100).toFixed(1) : 0}%)`);

    // Calculate ROI for RENTAL/INVESTMENT properties
    // For rental properties, ROI must include rental income over hold period, not just resale value
    const annualRentIncrease = rentLift * 12;
    const holdPeriodYears = 5; // Typical hold period for rental properties
    const totalRentalIncome = annualRentIncrease * holdPeriodYears;
    const totalReturn = valueLift + totalRentalIncome;
    const roi = (totalReturn / renovationCost) * 100;
    
    console.log(`[ROI Calculation] ${renovation.type}: Value +$${Math.round(valueLift)}, Rent +$${Math.round(totalRentalIncome)} (${holdPeriodYears}yr), Total ROI: ${roi.toFixed(1)}%`);

    // Calculate payback period in months
    const paybackMonths = rentLift > 0 ? Math.round(renovationCost / rentLift) : null;

    // Ensure all numeric values are valid numbers (not null/undefined/NaN)
    const safeNumber = (val, defaultVal = 0) => {
      const num = Number(val);
      return isNaN(num) ? defaultVal : num;
    };

    return {
      cost: Math.round(safeNumber(renovationCost)),
      costRange: {
        low: Math.round(safeNumber(contractorCosts.costData?.lowEstimate, renovationCost * 0.8)),
        high: Math.round(safeNumber(contractorCosts.costData?.highEstimate, renovationCost * 1.2))
      },
      valueIncrease: Math.round(safeNumber(valueLift)),
      rentIncreaseDollar: Math.round(safeNumber(rentLift)),
      rentIncreasePercent: safeMarketData.estimatedRent > 0 ? 
        Number(((rentLift / safeMarketData.estimatedRent) * 100).toFixed(1)) : 0,
      roi: Math.round(safeNumber(roi) * 10) / 10,
      paybackMonths,
      confidence: contractorCosts.costData?.confidence || 'medium',
      costSources: contractorCosts.sources?.length || 0,
      marketAppreciationRate: safeNumber(safeMarketData.marketAppreciationRate, 0.03),
      currentRent: safeNumber(safeMarketData.estimatedRent),
      maxPostRenovationRent: safeNumber(safeMarketData.estimatedRent) + Math.round(safeNumber(rentLift)),
      afterRepairValue: Math.round(safeNumber(safeMarketData.propertyValue) + safeNumber(valueLift)),
      marketRentBenchmark: safeNumber(rentcastContext.marketRentBenchmark, safeMarketData.estimatedRent),
      marketSaleBenchmark: safeNumber(rentcastContext.marketSaleBenchmark, safeMarketData.propertyValue),
      analysisContext,
      valueModel: valueAnalysis,
      rentModel: rentAnalysis,
      rentcastModel: rentcastContext,
      macroModel: macroContext,
      regionalCostFactors: safeMarketData.locationContext || null,
      canonicalPropertyProfile: analysisContext.canonicalPropertyProfile,
    };

  } catch (error) {
    console.error('[Metrics Calculation] Error:', error);
    return null;
  }
}

/**
 * Calculate property value lift from renovation using market data + baseline multipliers
 * NOW WITH LOCATION AWARENESS: Considers climate, urban/suburban context, neighborhood momentum, and regional preferences
 */
function calculateValueLift(renovationType, cost, marketData, materialQuality = 'mid-range', renovationDetails = '', analysisContext = {}) {
  // Safety check: ensure marketData exists
  if (!marketData || typeof marketData !== 'object') {
    console.warn('[Value Lift] Invalid marketData, using defaults');
    marketData = {};
  }

  const factors = [];
  
  const currentYear = new Date().getFullYear();
  const age = marketData.yearBuilt ? currentYear - marketData.yearBuilt : 30;
  const currentValue = marketData.propertyValue || 450000; // Default if missing
  const propertyType = marketData.propertyType || 'single_family';
  const normalizedQuality = normalizeQualityLevel(materialQuality || analysisContext.qualityLevel);

  // Baseline value recovery multipliers based on 2024-2025 Cost vs. Value Report + rental market data
  // These represent immediate resale value recovery, not investment ROI
  const baseMultipliers = {
    // HIGH VALUE (55-75% recovery) - Major aesthetic improvements
    'kitchen': 0.70,      // Full kitchen remodel - high impact
    'bathroom': 0.67,     // Full bathroom remodel - strong ROI
    'basement': 0.65,     // Basement finish - adds living space
    
    // GOOD VALUE (40-55% recovery) - Significant improvements
    'cabinets': 0.52,     // Kitchen cabinet replacement
    'deck': 0.48,         // Composite deck addition
    'countertops': 0.45,  // Countertop upgrade
    'landscaping': 0.42,  // Front yard landscaping
    'siding': 0.40,       // Vinyl siding replacement
    
    // MODERATE VALUE (30-40% recovery) - Functional improvements
    'flooring': 0.38,     // Hardwood/LVP flooring
    'windows': 0.35,      // Window replacement
    'tile': 0.33,         // Tile work
    'door': 0.32,         // Entry door replacement
    'paint': 0.30,        // Interior/exterior paint
    'appliances': 0.28,   // Appliance upgrades
    
    // MAINTENANCE (15-25% recovery) - Necessary but low immediate value
    'hvac': 0.25,         // HVAC replacement - necessary but hidden
    'roof': 0.22,         // Roof replacement - expected maintenance
    'plumbing': 0.18,     // Plumbing repairs
    'electrical': 0.15,   // Electrical upgrades
    'insulation': 0.12    // Insulation - hidden improvement
  };

  // Find base multiplier
  let baseMultiplier = 0.30;
  const lowerType = renovationType.toLowerCase();
  let bestMatch = '';
  for (const [key, value] of Object.entries(baseMultipliers)) {
    if (lowerType.includes(key) && key.length > bestMatch.length) {
      baseMultiplier = value;
      bestMatch = key;
    }
  }

  factors.push({
    name: 'base_recovery_rate',
    multiplier: baseMultiplier,
    reason: bestMatch || 'general renovation',
  });
  
  console.log(`[Value Lift Debug] Renovation: ${renovationType}, Cost: $${cost}, Base multiplier: ${baseMultiplier}, Best match: ${bestMatch}`);

  // STEP 1: Age adjustment (non-linear)
  const ageImpact = Math.min(0.20, (age / 100) * 0.35);
  let adjustedMultiplier = baseMultiplier + ageImpact;
  factors.push({ name: 'property_age', multiplier: Math.round((1 + ageImpact / Math.max(baseMultiplier, 0.01)) * 1000) / 1000, reason: `${age} years old` });

  // STEP 2: Property value tier
  const valuePercentile = currentValue > 1200000 ? 'luxury' : 
                          currentValue > 800000 ? 'upper' :
                          currentValue > 400000 ? 'mid' : 'entry';
  
  if (valuePercentile === 'luxury') {
    adjustedMultiplier *= 0.85;
    factors.push({ name: 'price_tier', multiplier: 0.85, reason: 'Luxury market buyers do not fully recover remodel spend' });
  } else if (valuePercentile === 'upper') {
    adjustedMultiplier *= 0.92;
    factors.push({ name: 'price_tier', multiplier: 0.92, reason: 'Upper-tier market' });
  } else if (valuePercentile === 'entry') {
    adjustedMultiplier += 0.05;
    factors.push({ name: 'price_tier', multiplier: 1.05, reason: 'Entry-tier improvements recover more value' });
  }

  // STEP 3: Over-improvement penalty (type-specific thresholds)
  const overImprovementThresholds = {
    'kitchen': 12, 'bathroom': 10, 'paint': 20, 'hvac': 25,
    'roof': 25, 'flooring': 15, 'basement': 18, 'deck': 20,
    'landscaping': 22
  };
  const threshold = overImprovementThresholds[bestMatch] || 15;
  const costAsPercentOfValue = (cost / currentValue) * 100;
  
  if (costAsPercentOfValue > threshold) {
    const overImprovementPenalty = 0.10 * (costAsPercentOfValue / threshold);
    adjustedMultiplier *= (1 - overImprovementPenalty);
    factors.push({ name: 'over_improvement', multiplier: Math.round((1 - overImprovementPenalty) * 1000) / 1000, reason: `${costAsPercentOfValue.toFixed(1)}% of property value` });
  } else if (costAsPercentOfValue < 3) {
    adjustedMultiplier += 0.08;
    factors.push({ name: 'light_refresh_bonus', multiplier: 1.08, reason: 'Low-cost refresh can punch above its weight' });
  }

  // STEP 4: Property type adjustment
  const propertyTypeMultipliers = {
    'single_family': 1.0,
    'townhouse': 0.95,
    'multi_family': 0.92,
    'condo': 0.88
  };
  adjustedMultiplier *= (propertyTypeMultipliers[propertyType] || 1.0);
  factors.push({ name: 'property_type', multiplier: propertyTypeMultipliers[propertyType] || 1.0, reason: propertyType });

  // STEP 5: Material quality adjustment
  const qualityMultipliers = {
    'budget': 0.85,
    'mid-range': 1.0,
    'luxury': 1.12
  };
  adjustedMultiplier *= (qualityMultipliers[normalizedQuality] || 1.0);
  factors.push({ name: 'finish_quality', multiplier: qualityMultipliers[normalizedQuality] || 1.0, reason: normalizedQuality });

  const conditionOpportunity = getConditionOpportunityMultiplier(analysisContext.preRenovationCondition);
  const scopeIntensity = getScopeIntensityMultiplier(analysisContext.renovationScope, cost, currentValue);
  const conditionScopeMultiplier = 1 + ((conditionOpportunity - 1) * scopeIntensity);
  adjustedMultiplier *= conditionScopeMultiplier;
  factors.push({
    name: 'condition_scope',
    multiplier: Math.round(conditionScopeMultiplier * 1000) / 1000,
    reason: `${analysisContext.preRenovationCondition || 'unknown'} before / ${analysisContext.renovationScope || 'refresh'} scope`,
  });

  const marketFitMultiplier = getMarketFitMultiplier(analysisContext.marketFit);
  adjustedMultiplier *= marketFitMultiplier;
  factors.push({
    name: 'market_fit',
    multiplier: marketFitMultiplier,
    reason: analysisContext.marketFit || 'neutral',
  });

  const functionalUtilityMultiplier = getFunctionalUtilityMultiplier(lowerType, analysisContext.renovationScope);
  adjustedMultiplier *= functionalUtilityMultiplier;
  factors.push({
    name: 'functional_utility',
    multiplier: functionalUtilityMultiplier,
    reason: bestMatch || lowerType,
  });

  const rentcastValueMultiplier = getRentcastValueMultiplier(analysisContext.rentcastContext, currentValue, lowerType);
  adjustedMultiplier *= rentcastValueMultiplier;
  if (rentcastValueMultiplier !== 1.0) {
    factors.push({
      name: 'zip_market_sale_context',
      multiplier: rentcastValueMultiplier,
      reason: analysisContext.rentcastContext?.summary || 'ZIP sale/rent benchmark context',
    });
  }

  const macroValueMultiplier = getMacroValueMultiplier(analysisContext.macroContext, lowerType);
  adjustedMultiplier *= macroValueMultiplier;
  if (macroValueMultiplier !== 1.0) {
    factors.push({
      name: 'macro_backdrop',
      multiplier: macroValueMultiplier,
      reason: analysisContext.macroContext?.summary || 'macro conditions',
    });
  }

  // STEP 6: Market velocity adjustment
  const marketRate = marketData.marketAppreciationRate || 0.03;
  if (marketRate > 0.05) {
    adjustedMultiplier *= 1.10; // Hot market
    factors.push({ name: 'market_velocity', multiplier: 1.10, reason: 'Above-average local appreciation' });
  } else if (marketRate < 0) {
    adjustedMultiplier *= 0.85; // Declining market
    factors.push({ name: 'market_velocity', multiplier: 0.85, reason: 'Declining local market' });
  }

  // STEP 7: Location climate adjustments
  const zipCode = marketData.zipCode || '';
  const zipPrefix = zipCode.substring(0, 2);
  const climateAdjustment = getClimateAdjustment(zipPrefix, lowerType);
  adjustedMultiplier *= climateAdjustment;
  if (climateAdjustment !== 1.0) {
    factors.push({ name: 'climate', multiplier: climateAdjustment, reason: zipPrefix || 'unknown climate zone' });
  }

  // STEP 8: Urban vs suburban context
  const urbanContext = isUrbanProperty(marketData);
  const urbanSuburbanAdj = getUrbanSuburbanAdjustment(urbanContext, lowerType);
  adjustedMultiplier *= urbanSuburbanAdj;
  if (urbanSuburbanAdj !== 1.0) {
    factors.push({ name: 'urban_context', multiplier: urbanSuburbanAdj, reason: urbanContext ? 'urban' : 'suburban' });
  }

  // STEP 9: Neighborhood momentum (gentrifying vs declining)
  if (marketRate > 0.07) {
    // Hot/gentrifying neighborhood
    if (lowerType.includes('kitchen') || lowerType.includes('bathroom')) {
      adjustedMultiplier *= 1.12;
    }
    if (materialQuality === 'luxury') {
      adjustedMultiplier *= 1.10;
    }
    if (age > 30) {
      adjustedMultiplier += 0.05;
    }
  } else if (marketRate < 0.03) {
    // Declining/stable neighborhood
    adjustedMultiplier *= 0.92;
    if (materialQuality === 'luxury') {
      adjustedMultiplier *= 0.85;
    }
  }

  // STEP 10: Metro style preferences
  const metroStyleAdj = getMetroStyleAdjustment(marketData.location || '', renovationDetails);
  adjustedMultiplier *= metroStyleAdj;
  if (metroStyleAdj !== 1.0) {
    factors.push({ name: 'style_fit', multiplier: metroStyleAdj, reason: marketData.location || 'local style preference' });
  }

  // STEP 11: Renovation-specific bonuses
  if (lowerType.includes('kitchen') && age > 30) {
    adjustedMultiplier += 0.10;
  }
  if (lowerType.includes('bathroom') && age > 30) {
    adjustedMultiplier += 0.08;
  }

  // STEP 12: Use ATTOM comparable sales data to validate value lift estimate
  // This grounds our estimate in actual market data rather than just multipliers
  if (marketData.comparableSales && marketData.comparableSales.length > 0) {
    const renovatedComps = marketData.comparableSales.filter(comp => 
      comp.renovationQuality === 'high' || comp.renovationQuality === 'recent'
    );
    const nonRenovatedComps = marketData.comparableSales.filter(comp => 
      comp.renovationQuality === 'low' || comp.renovationQuality === 'original'
    );
    
    if (renovatedComps.length > 0 && nonRenovatedComps.length > 0) {
      const avgRenovatedPrice = renovatedComps.reduce((sum, c) => sum + c.salePrice, 0) / renovatedComps.length;
      const avgNonRenovatedPrice = nonRenovatedComps.reduce((sum, c) => sum + c.salePrice, 0) / nonRenovatedComps.length;
      const marketValueLift = avgRenovatedPrice - avgNonRenovatedPrice;
      const marketMultiplier = marketValueLift / cost;
      
      // Blend our calculated multiplier with actual market data (70% market, 30% calculated)
      adjustedMultiplier = (marketMultiplier * 0.70) + (adjustedMultiplier * 0.30);
      factors.push({ name: 'comparable_sales_blend', multiplier: Math.round(marketMultiplier * 1000) / 1000, reason: 'Blended with renovated vs original comp spread' });
      console.log(`[Value Lift] Using comparable sales data: ${renovatedComps.length} renovated vs ${nonRenovatedComps.length} non-renovated, market multiplier: ${marketMultiplier.toFixed(2)}`);
    }
  }
  
  // STEP 13: Use property-specific appreciation rate if available
  // Properties in rapidly appreciating areas get more value from renovations
  if (marketData.propertyAppreciationRate && marketData.propertyAppreciationRate > marketData.marketAppreciationRate) {
    const appreciationBonus = Math.min(0.15, (marketData.propertyAppreciationRate - marketData.marketAppreciationRate) * 2);
    adjustedMultiplier *= (1 + appreciationBonus);
    factors.push({ name: 'subject_appreciation_bonus', multiplier: Math.round((1 + appreciationBonus) * 1000) / 1000, reason: 'Subject appreciating faster than market' });
    console.log(`[Value Lift] Property appreciating faster than market (+${(appreciationBonus * 100).toFixed(1)}% bonus)`);
  }

  adjustedMultiplier = Math.min(Math.max(adjustedMultiplier, 0.08), 1.65);
  adjustedMultiplier = Math.round(adjustedMultiplier * 100) / 100;
  let valueLift = cost * adjustedMultiplier;
  const unconstrainedValueLift = valueLift;

  const arvScopeBuffer = analysisContext.renovationScope === 'gut_reno'
    ? 1.08
    : analysisContext.renovationScope === 'full_remodel'
      ? 1.05
      : 1.02;
  const arvCeiling = marketData.comparableValueRange?.high
    ? marketData.comparableValueRange.high * arvScopeBuffer
    : currentValue * 1.30;

  if (currentValue + valueLift > arvCeiling) {
    valueLift = Math.max(0, arvCeiling - currentValue);
    factors.push({
      name: 'arv_ceiling',
      multiplier: valueLift > 0 ? Math.round((valueLift / Math.max(unconstrainedValueLift, 1)) * 1000) / 1000 : 0,
      reason: 'Constrained by local post-renovation value ceiling',
    });
  }
  
  console.log(`[Value Lift] ${renovationType}: $${cost} × ${adjustedMultiplier} = $${Math.round(valueLift)} (Age: ${age}, Location-aware)`);
  
  // Cap value lift at reasonable maximum (renovation shouldn't add more than 30% of property value)
  const maxValueLift = currentValue * 0.30;
  if (valueLift > maxValueLift) {
    console.log(`[Value Lift] Capping value lift from $${Math.round(valueLift)} to $${Math.round(maxValueLift)} (30% of property value)`);
    valueLift = maxValueLift;
  }

  return {
    valueLift,
    adjustedMultiplier,
    unconstrainedValueLift: Math.round(unconstrainedValueLift),
    afterRepairValue: Math.round(currentValue + valueLift),
    arvCeiling: Math.round(arvCeiling),
    factors,
  };
}

/**
 * Calculate monthly rent lift from renovation using market data
 * NOW WITH LOCATION AWARENESS: Considers high-rent markets, urban premiums, and location-specific factors
 */
function calculateRentLift(renovationType, marketData, cost, materialQuality = 'mid-range', analysisContext = {}) {
  // Safety check: ensure marketData exists
  if (!marketData || typeof marketData !== 'object') {
    console.warn('[Rent Lift] Invalid marketData, using defaults');
    marketData = {};
  }

  const factors = [];
  
  const currentRent = marketData.estimatedRent || 0;
  const propertyType = marketData.propertyType || 'single_family';
  
  // Base rent lift percentages by renovation type
  const rentLiftRates = {
    'kitchen': 0.08, 'bathroom': 0.07, 'flooring': 0.04, 'paint': 0.02,
    'landscaping': 0.035, 'hvac': 0.03, 'appliances': 0.04, 'countertops': 0.05,
    'cabinets': 0.06, 'tile': 0.045, 'windows': 0.03, 'deck': 0.04,
    'basement': 0.07
  };

  // Find base lift rate
  let liftRate = 0.03;
  const lowerType = renovationType.toLowerCase();
  let bestMatch = '';
  for (const [key, value] of Object.entries(rentLiftRates)) {
    if (lowerType.includes(key) && key.length > bestMatch.length) {
      liftRate = value;
      bestMatch = key;
    }
  }

  factors.push({ name: 'base_rent_lift', multiplier: liftRate, reason: bestMatch || 'general renovation' });

  let effectiveRent = currentRent;
  let baselineSource = 'market_input';
  if (effectiveRent === 0) {
    effectiveRent = 1500;
    baselineSource = 'fallback_estimate';
    console.warn('[Rent Lift] No current rent provided, using estimated baseline');
  }

  // Calculate base rent increase
  let rentIncrease = effectiveRent * liftRate;

  const conditionOpportunity = getConditionOpportunityMultiplier(analysisContext.preRenovationCondition);
  const scopeIntensity = Math.min(1, getScopeIntensityMultiplier(analysisContext.renovationScope, cost, marketData.propertyValue || 0));
  const conditionScopeMultiplier = 1 + ((conditionOpportunity - 1) * scopeIntensity * 0.8);
  rentIncrease *= conditionScopeMultiplier;
  factors.push({ name: 'condition_scope', multiplier: Math.round(conditionScopeMultiplier * 1000) / 1000, reason: `${analysisContext.preRenovationCondition || 'unknown'} before / ${analysisContext.renovationScope || 'refresh'} scope` });

  const marketFitMultiplier = getMarketFitMultiplier(analysisContext.marketFit);
  rentIncrease *= marketFitMultiplier;
  factors.push({ name: 'market_fit', multiplier: marketFitMultiplier, reason: analysisContext.marketFit || 'neutral' });

  const rentcastRentMultiplier = getRentcastRentMultiplier(analysisContext.rentcastContext, effectiveRent, lowerType);
  rentIncrease *= rentcastRentMultiplier;
  if (rentcastRentMultiplier !== 1.0) {
    factors.push({
      name: 'zip_rental_trend',
      multiplier: rentcastRentMultiplier,
      reason: analysisContext.rentcastContext?.summary || 'ZIP rental benchmark context',
    });
  }

  const macroRentMultiplier = getMacroRentMultiplier(analysisContext.macroContext, lowerType);
  rentIncrease *= macroRentMultiplier;
  if (macroRentMultiplier !== 1.0) {
    factors.push({
      name: 'macro_rent_backdrop',
      multiplier: macroRentMultiplier,
      reason: analysisContext.macroContext?.summary || 'macro demand/supply context',
    });
  }

  // LOCATION ADJUSTMENTS
  
  // High-rent market adjustment
  if (effectiveRent > 2500) {
    if (lowerType.includes('kitchen') || lowerType.includes('bathroom')) {
      rentIncrease *= 1.15;
      factors.push({ name: 'high_rent_market', multiplier: 1.15, reason: 'Premium markets reward kitchen/bath quality more' });
    }
    if (materialQuality === 'luxury') {
      rentIncrease *= 1.12;
    }
  } else if (effectiveRent < 1200) {
    if (lowerType.includes('kitchen') || lowerType.includes('bathroom')) {
      rentIncrease *= 0.90;
    }
    if (materialQuality === 'luxury') {
      rentIncrease *= 0.80;
    }
    if (lowerType.includes('hvac') || lowerType.includes('roof') || lowerType.includes('plumbing')) {
      rentIncrease *= 1.05;
    }
  }

  // Urban vs suburban rent premiums
  const urbanContext = isUrbanProperty(marketData);
  if (urbanContext) {
    // Urban: kitchen quality matters more
    if (lowerType.includes('kitchen')) {
      rentIncrease *= 1.20;
      factors.push({ name: 'urban_kitchen_bonus', multiplier: 1.20, reason: 'Urban renters pay more for kitchen upgrades' });
    }
    // Add flat bonus for in-unit laundry
    if (lowerType.includes('washer') || lowerType.includes('dryer') || lowerType.includes('laundry')) {
      rentIncrease += 125; // Flat $125/month bonus
    }
    // Parking premium in urban areas
    if (lowerType.includes('parking') || lowerType.includes('garage')) {
      rentIncrease += 150; // Flat $150/month bonus
    }
  } else {
    // Suburban: yard and space matter more
    if (lowerType.includes('yard') || lowerType.includes('landscaping')) {
      rentIncrease *= 1.12;
      factors.push({ name: 'suburban_outdoor_bonus', multiplier: 1.12, reason: 'Outdoor appeal matters more in suburban rentals' });
    }
    if (lowerType.includes('bedroom')) {
      rentIncrease *= 1.15;
    }
  }

  // Payback constraints
  const minPayback = cost / 36;
  const maxPayback = cost / 18;
  
  if (rentIncrease < minPayback) {
    rentIncrease = minPayback;
  }
  
  if (rentIncrease > maxPayback) {
    rentIncrease = maxPayback;
  }

  // Property type adjustment
  const propertyTypeMultipliers = {
    'single_family': 1.0,
    'townhouse': 0.95,
    'multi_family': 0.90,
    'condo': 0.85
  };
  rentIncrease *= (propertyTypeMultipliers[propertyType] || 1.0);

  const functionalUtilityMultiplier = getFunctionalUtilityMultiplier(lowerType, analysisContext.renovationScope);
  rentIncrease *= functionalUtilityMultiplier;
  factors.push({ name: 'functional_utility', multiplier: functionalUtilityMultiplier, reason: bestMatch || lowerType });

  const rentCeilingMultiplier = analysisContext.renovationScope === 'gut_reno'
    ? 1.35
    : analysisContext.renovationScope === 'full_remodel'
      ? 1.28
      : 1.20;
  const marketMaxRent = effectiveRent * rentCeilingMultiplier;
  if (effectiveRent + rentIncrease > marketMaxRent) {
    rentIncrease = marketMaxRent - effectiveRent;
    factors.push({ name: 'rent_ceiling', multiplier: Math.round(rentCeilingMultiplier * 1000) / 1000, reason: 'Capped to local post-renovation rent ceiling' });
  }

  return {
    rentLift: Math.round(rentIncrease),
    marketMaxRent: Math.round(marketMaxRent),
    baselineRentUsed: Math.round(effectiveRent),
    baselineSource,
    factors,
  };
}

function buildRenovationAnalysisContext(renovation, marketData, renovationCost) {
  return {
    preRenovationCondition: renovation.preRenovationCondition || inferConditionFromDetails(renovation.details || ''),
    renovationScope: renovation.scope || renovation.scopeLevel || inferScopeFromCost(renovationCost, marketData.propertyValue),
    qualityLevel: normalizeQualityLevel(renovation.materialQuality || renovation.qualityLevel),
    marketFit: renovation.marketFit || inferMarketFitFromDetails(renovation.details || ''),
  };
}

function deriveRentcastMarketContext(rentcastData, marketData) {
  const rentalData = rentcastData?.rentalData || rentcastData?.rental || null;
  const saleData = rentcastData?.saleData || rentcastData?.sale || null;
  const bedrooms = marketData?.beds ?? null;
  const bedroomMatch = (rentalData?.byBedrooms || []).find(item => item.bedrooms === bedrooms);
  const marketRentBenchmark = bedroomMatch?.median || rentalData?.median || rentcastData?.derived?.medianAskingRent || null;
  const marketSaleBenchmark = saleData?.median || rentcastData?.derived?.medianSalePrice || null;
  const rentGapPercent = marketRentBenchmark && marketData?.estimatedRent
    ? ((marketRentBenchmark - marketData.estimatedRent) / marketData.estimatedRent) * 100
    : null;
  const medianDom = rentalData?.medianDaysOnMarket ?? null;
  const tightnessScore = medianDom === null
    ? null
    : medianDom <= 21
      ? 'tight'
      : medianDom <= 38
        ? 'balanced'
        : 'soft';

  return {
    marketRentBenchmark,
    marketSaleBenchmark,
    rentPerSquareFoot: bedroomMatch?.medianPerSquareFoot || rentalData?.medianPerSquareFoot || null,
    grossYieldPct: rentcastData?.derived?.grossYieldPct || null,
    priceToRentRatio: rentcastData?.derived?.priceToRentRatio || null,
    rentalDaysOnMarket: medianDom,
    rentalListings: rentalData?.totalListings || rentcastData?.derived?.rentalListings || null,
    saleListings: saleData?.totalListings || rentcastData?.derived?.saleListings || null,
    rentGapPercent: rentGapPercent !== null ? round(rentGapPercent, 1) : null,
    tightnessScore,
    summary: marketRentBenchmark
      ? `ZIP market median rent ${Math.round(marketRentBenchmark)}/mo${tightnessScore ? `, ${tightnessScore} rental market` : ''}`
      : 'ZIP rental market context unavailable',
    lastUpdated: rentalData?.lastUpdatedDate || saleData?.lastUpdatedDate || null,
  };
}

function deriveMacroMarketContext(macroData) {
  if (!macroData || typeof macroData !== 'object') {
    return {
      summary: 'Macro context unavailable',
    };
  }

  const mortgage15 = parseFloat(macroData.mortgage15?.value || '');
  const rentalVacancy = parseFloat(macroData.rentalVacancy?.value || '');
  const consumerSentiment = parseFloat(macroData.consumerSentiment?.value || '');
  const constructionPPI = parseFloat(macroData.constructionPPI?.yoy || '');
  const joblessClaims = parseFloat(String(macroData.joblessClaims?.value || '').replace(/,/g, ''));
  const breakeven10Y = parseFloat(macroData.breakeven10Y?.value || '');

  return {
    mortgage15: Number.isFinite(mortgage15) ? mortgage15 : null,
    rentalVacancy: Number.isFinite(rentalVacancy) ? rentalVacancy : null,
    consumerSentiment: Number.isFinite(consumerSentiment) ? consumerSentiment : null,
    constructionPpiYoY: Number.isFinite(constructionPPI) ? constructionPPI : null,
    joblessClaims: Number.isFinite(joblessClaims) ? joblessClaims : null,
    breakeven10Y: Number.isFinite(breakeven10Y) ? breakeven10Y : null,
    summary: `15Y mortgage ${macroData.mortgage15?.value || 'n/a'}%, vacancy ${macroData.rentalVacancy?.value || 'n/a'}%, sentiment ${macroData.consumerSentiment?.value || 'n/a'}`,
    lastUpdated: macroData.lastUpdated || null,
  };
}

function normalizeQualityLevel(quality = 'mid-range') {
  const normalized = String(quality).toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'mid-grade') return 'mid-range';
  if (normalized === 'high-end') return 'luxury';
  return normalized;
}

function inferConditionFromDetails(details = '') {
  const text = details.toLowerCase();
  if (/distress|damage|deferred maintenance|severely dated|unsafe|water damage/.test(text)) return 'distressed';
  if (/dated|original|worn|builder-grade|outdated/.test(text)) return 'dated';
  if (/well-maintained|updated|modern|move-in ready/.test(text)) return 'good';
  return 'average';
}

function inferScopeFromCost(cost = 0, propertyValue = 0) {
  const costRatio = propertyValue > 0 ? cost / propertyValue : 0;
  if (cost >= 75000 || costRatio >= 0.18) return 'gut_reno';
  if (cost >= 25000 || costRatio >= 0.08) return 'full_remodel';
  if (cost >= 8000 || costRatio >= 0.025) return 'refresh';
  return 'cosmetic';
}

function inferMarketFitFromDetails(details = '') {
  const text = details.toLowerCase();
  if (/luxury vinyl|quartz|stainless|modern|premium|high-end/.test(text)) return 'good';
  if (/diy|cheap|mismatch|over-improvement|wrong style/.test(text)) return 'poor';
  return 'neutral';
}

function getConditionOpportunityMultiplier(condition = 'average') {
  const normalized = String(condition).toLowerCase();
  if (['distressed', 'poor', 'severely_dated'].includes(normalized)) return 1.28;
  if (['dated', 'below_average', 'fair'].includes(normalized)) return 1.14;
  if (['average', 'functional'].includes(normalized)) return 1.0;
  if (['good', 'updated'].includes(normalized)) return 0.92;
  if (['excellent', 'renovated'].includes(normalized)) return 0.84;
  return 1.0;
}

function getScopeIntensityMultiplier(scope = 'refresh', cost = 0, propertyValue = 0) {
  const normalized = String(scope).toLowerCase();
  if (normalized === 'gut_reno') return 1.0;
  if (normalized === 'full_remodel') return 0.82;
  if (normalized === 'refresh') return 0.58;
  if (normalized === 'cosmetic') return 0.35;
  return inferScopeFromCost(cost, propertyValue) === 'gut_reno' ? 1.0 : 0.58;
}

function getMarketFitMultiplier(marketFit = 'neutral') {
  const normalized = String(marketFit).toLowerCase();
  if (normalized === 'excellent') return 1.12;
  if (normalized === 'good') return 1.06;
  if (normalized === 'poor') return 0.84;
  return 1.0;
}

function getFunctionalUtilityMultiplier(renovationType = '', scope = 'refresh') {
  const scopeBonus = scope === 'gut_reno' ? 1.08 : scope === 'full_remodel' ? 1.05 : 1.0;
  if (/kitchen|bathroom|basement|bedroom/.test(renovationType)) {
    return scopeBonus;
  }
  if (/flooring|paint|windows|landscaping/.test(renovationType)) {
    return scope === 'cosmetic' ? 1.0 : 1.02;
  }
  return 1.0;
}

function getRentcastValueMultiplier(rentcastContext, currentValue, renovationType = '') {
  if (!rentcastContext) return 1.0;

  let multiplier = 1.0;
  if (rentcastContext.marketSaleBenchmark && currentValue) {
    const ratio = currentValue / rentcastContext.marketSaleBenchmark;
    if (ratio < 0.92 && /kitchen|bathroom|flooring|paint/.test(renovationType)) {
      multiplier *= 1.05;
    } else if (ratio > 1.08 && /luxury|kitchen|bathroom/.test(renovationType)) {
      multiplier *= 0.95;
    }
  }
  if (rentcastContext.grossYieldPct && rentcastContext.grossYieldPct >= 7) {
    multiplier *= 1.03;
  }
  if (rentcastContext.priceToRentRatio && rentcastContext.priceToRentRatio >= 28) {
    multiplier *= 0.97;
  }

  return round(Math.min(Math.max(multiplier, 0.9), 1.1), 3) || 1.0;
}

function getRentcastRentMultiplier(rentcastContext, currentRent, renovationType = '') {
  if (!rentcastContext) return 1.0;

  let multiplier = 1.0;
  if (rentcastContext.tightnessScore === 'tight') multiplier *= 1.08;
  else if (rentcastContext.tightnessScore === 'soft') multiplier *= 0.93;

  if (rentcastContext.rentGapPercent !== null) {
    if (rentcastContext.rentGapPercent > 10) multiplier *= 1.07;
    else if (rentcastContext.rentGapPercent < -8) multiplier *= 0.95;
  }

  if (rentcastContext.marketRentBenchmark && currentRent && rentcastContext.marketRentBenchmark > currentRent * 1.1) {
    multiplier *= 1.04;
  }

  if (/kitchen|bathroom|laundry|parking/.test(renovationType) && rentcastContext.rentPerSquareFoot && rentcastContext.rentPerSquareFoot > 2.2) {
    multiplier *= 1.03;
  }

  return round(Math.min(Math.max(multiplier, 0.88), 1.15), 3) || 1.0;
}

function getMacroValueMultiplier(macroContext, renovationType = '') {
  if (!macroContext) return 1.0;

  let multiplier = 1.0;
  if (macroContext.mortgage15 !== null) {
    if (macroContext.mortgage15 >= 6.2) multiplier *= 0.97;
    else if (macroContext.mortgage15 <= 4.8) multiplier *= 1.03;
  }
  if (macroContext.consumerSentiment !== null) {
    if (macroContext.consumerSentiment >= 80) multiplier *= 1.03;
    else if (macroContext.consumerSentiment <= 60) multiplier *= 0.97;
  }
  if (macroContext.joblessClaims !== null) {
    if (macroContext.joblessClaims >= 280000) multiplier *= 0.97;
    else if (macroContext.joblessClaims <= 220000) multiplier *= 1.02;
  }
  if (macroContext.breakeven10Y !== null && /energy|hvac|window|insulation/.test(renovationType)) {
    if (macroContext.breakeven10Y >= 2.5) multiplier *= 1.03;
  }

  return round(Math.min(Math.max(multiplier, 0.9), 1.1), 3) || 1.0;
}

function getMacroRentMultiplier(macroContext, renovationType = '') {
  if (!macroContext) return 1.0;

  let multiplier = 1.0;
  if (macroContext.mortgage15 !== null) {
    if (macroContext.mortgage15 >= 6.2) multiplier *= 1.04;
    else if (macroContext.mortgage15 <= 4.8) multiplier *= 0.97;
  }
  if (macroContext.rentalVacancy !== null) {
    if (macroContext.rentalVacancy <= 5.5) multiplier *= 1.05;
    else if (macroContext.rentalVacancy >= 7.5) multiplier *= 0.93;
  }
  if (macroContext.consumerSentiment !== null) {
    if (macroContext.consumerSentiment <= 60) multiplier *= 0.97;
  }
  if (macroContext.joblessClaims !== null) {
    if (macroContext.joblessClaims >= 280000) multiplier *= 0.95;
  }
  if (macroContext.constructionPpiYoY !== null && macroContext.constructionPpiYoY >= 4 && /energy|hvac|window|insulation/.test(renovationType)) {
    multiplier *= 1.02;
  }

  return round(Math.min(Math.max(multiplier, 0.88), 1.12), 3) || 1.0;
}

/**
 * Calculate market appreciation rate from sales history
 */
function calculateAppreciationRate(salesHistory) {
  if (!salesHistory || salesHistory.length < 2) {
    return 0.03; // Default 3% annual appreciation
  }

  const sorted = [...salesHistory].sort((a, b) => {
    const dateA = new Date(a.sale_date || a.saleDate);
    const dateB = new Date(b.sale_date || b.saleDate);
    return dateB - dateA;
  });

  const latest = sorted[0];
  const previous = sorted[1];

  if (!latest?.sale_price || !previous?.sale_price) {
    return 0.03;
  }

  const yearsDiff = (new Date(latest.sale_date) - new Date(previous.sale_date)) / (1000 * 60 * 60 * 24 * 365);
  
  if (yearsDiff <= 0) return 0.03;

  const totalAppreciation = (latest.sale_price - previous.sale_price) / previous.sale_price;
  const annualRate = Math.pow(1 + totalAppreciation, 1 / yearsDiff) - 1;

  // Cap at reasonable bounds
  return Math.min(Math.max(annualRate, -0.05), 0.15);
}

/**
 * Extract neighborhood from address
 */
function extractNeighborhood(address) {
  const parts = address.split(',');
  if (parts.length >= 2) {
    return parts[1].trim();
  }
  return address.split(' ').slice(1, 3).join(' ');
}

function extractCityState(address) {
  const parts = address.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return { city: '', state: '' };
  }

  const city = parts[parts.length - 2] || '';
  const stateMatch = (parts[parts.length - 1] || '').match(/\b([A-Z]{2})\b/i);

  return {
    city,
    state: stateMatch ? stateMatch[1].toUpperCase() : '',
  };
}

/**
 * Extract zip code from address string
 */
function extractZipCode(address) {
  const zipMatch = address.match(/\b\d{5}(?:-\d{4})?\b/);
  return zipMatch ? zipMatch[0].substring(0, 5) : '';
}

/**
 * Determine if property is in urban context based on characteristics
 */
function isUrbanProperty(marketData) {
  if (!marketData || typeof marketData !== 'object') {
    return false; // Default to suburban if no data
  }
  
  const valuePerSqft = (marketData.propertyValue || 0) / (marketData.sqft || 1);
  const lotSize = marketData.lotSize || 0;
  
  // Urban indicators: high $/sqft OR small lot
  return valuePerSqft > 300 || (lotSize > 0 && lotSize < 4000);
}

/**
 * Get climate-based adjustment for renovation types
 */
function getClimateAdjustment(zipPrefix, renovationType) {
  // Extreme heat states (TX, AZ, NM, NV, Southern CA)
  const extremeHeatZips = ['75','76','77','78','79','85','86','87','88','89','90','91','92','93'];
  
  // Northeast (basements valuable)
  const northeastZips = ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15'];
  
  // South (basements rare)
  const southZips = ['30','31','32','33','34','35','36','37','38','39','70','71','72','73','74','75','76','77','78','79'];
  
  if (extremeHeatZips.includes(zipPrefix)) {
    if (renovationType.includes('hvac') || renovationType.includes('window')) {
      return 1.25; // Energy efficiency critical
    }
    if (renovationType.includes('pool') || renovationType.includes('deck')) {
      return 1.20; // Outdoor living valued
    }
    if (renovationType.includes('landscaping')) {
      return 1.25; // Xeriscaping premium
    }
  }
  
  if (northeastZips.includes(zipPrefix)) {
    if (renovationType.includes('basement')) {
      return 1.15; // Basements common and valuable
    }
  }
  
  if (southZips.includes(zipPrefix)) {
    if (renovationType.includes('basement')) {
      return 0.75; // Basements rare
    }
  }
  
  return 1.0; // No adjustment
}

/**
 * Get urban vs suburban adjustment
 */
function getUrbanSuburbanAdjustment(isUrban, renovationType) {
  if (isUrban) {
    // Urban: interior quality matters more
    if (renovationType.includes('landscaping') || renovationType.includes('curb') || renovationType.includes('siding')) {
      return 0.85; // Less important
    }
    if (renovationType.includes('kitchen') || renovationType.includes('bathroom') || renovationType.includes('flooring')) {
      return 1.10; // More important
    }
    if (renovationType.includes('garage') || renovationType.includes('parking')) {
      return 1.15; // Premium amenity
    }
  } else {
    // Suburban: curb appeal and outdoor space matter
    if (renovationType.includes('landscaping') || renovationType.includes('curb') || renovationType.includes('siding')) {
      return 1.15; // Very important
    }
    if (renovationType.includes('deck') || renovationType.includes('patio') || renovationType.includes('yard')) {
      return 1.12; // Outdoor living valued
    }
  }
  
  return 1.0;
}

/**
 * Get metro-specific style preference adjustment
 */
function getMetroStyleAdjustment(location, renovationDetails) {
  const locationLower = location.toLowerCase();
  const detailsLower = renovationDetails.toLowerCase();
  
  // Identify if renovation is modern/contemporary vs traditional
  const isModern = detailsLower.includes('contemporary') || detailsLower.includes('modern') || detailsLower.includes('industrial');
  const isTraditional = detailsLower.includes('traditional') || detailsLower.includes('classic') || detailsLower.includes('colonial');
  
  // Modern-preferring metros
  const modernMetros = ['san francisco', 'new york', 'seattle', 'austin', 'portland', 'denver', 'los angeles'];
  
  // Traditional-preferring metros
  const traditionalMetros = ['charleston', 'savannah', 'new orleans', 'boston'];
  
  for (const metro of modernMetros) {
    if (locationLower.includes(metro)) {
      if (isModern) return 1.15;
      if (isTraditional) return 0.95;
    }
  }
  
  for (const metro of traditionalMetros) {
    if (locationLower.includes(metro)) {
      if (isTraditional) return 1.18;
      if (isModern) return 0.92;
    }
  }
  
  return 1.0;
}

export default {
  getLocalMarketData,
  searchContractorCosts,
  calculateRenovationMetrics
};
