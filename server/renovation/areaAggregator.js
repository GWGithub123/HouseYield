/**
 * Regional Renovation ROI Aggregator
 * 
 * Aggregates individual property uplift analyses into zip-code-level
 * renovation ROI statistics. This is the service that populates
 * the `bestROIRenovations` array in the area summary.
 * 
 * Takes 10-20+ uplift-isolated comparables per zip code and produces:
 *   - Per renovation type: avg/median value uplift, rent uplift, ROI, sample size
 *   - Stratified by: property type, price tier, year built bracket
 *   - Recency-weighted averages (recent comps count more)
 *   - Market timing signals (is ROI trending up or down?)
 *   - Confidence levels based on sample sizes
 */

import { buildSalesComparisonValuation } from './salesComparisonArvEngine.js';

// ============================================================================
// AGGREGATION
// ============================================================================

/**
 * Aggregate uplift results into per-renovation-type statistics for a zip code.
 * 
 * @param {string} zipCode
 * @param {Array} upliftResults - Array of isolateRenovationUplift() results
 * @param {Object} [options]
 * @param {Object} [options.capRateData] - Local cap rate from getLocalCapRate(). Used to
 *   derive rent impact from value uplift: rentIncrease = uplift × capRate / 12
 * @param {Object|null} [options.subjectProfile] - Optional subject as-completed profile
 *   for direct ARV/AR-rent underwriting output.
 * @returns {Object} - Complete area renovation summary
 */
export function aggregateAreaRenovationStats(zipCode, upliftResults, { capRateData = null, subjectProfile = null } = {}) {
  if (!upliftResults || upliftResults.length === 0) {
    return createEmptySummary(zipCode);
  }
  
  // Flatten all per-renovation breakdowns across all properties
  const allRenovationDataPoints = [];
  
  for (const result of upliftResults) {
    if (!result.renovationBreakdown) continue;
    
    for (const reno of result.renovationBreakdown) {
      allRenovationDataPoints.push({
        // Renovation info
        category: reno.category,
        scope: reno.scope,
        description: reno.description,
        confidence: reno.confidence || 0.5,
        allocatedUplift: reno.allocatedUplift || 0,
        
        // Property context (for stratification)
        propertyType: result.propertyType || 'SFH',
        priceTier: getPriceTier(result.beforeSalePrice),
        yearBuiltBracket: getYearBuiltBracket(result.yearBuilt),
        sqft: result.sqft,
        beds: result.beds,
        baths: result.baths,
        
        // Before condition (1-10 scale from photo analysis)
        beforeConditionScore: result.beforeCondition?.overall || null,
        beforeConditionBracket: getConditionBracket(result.beforeCondition?.overall),
        
        // Rent data (if available)
        rentIncrease: result.rentAnalysis?.rentIncrease || null,
        rentROI: result.rentAnalysis?.rentROI || null,
        
        // Timing (for recency weighting)
        afterSaleDate: result.afterSalePrice ? new Date(result.afterDate || result.analyzedAt) : new Date(),
        
        // Quality
        analysisConfidence: result.confidence?.score || 50,
        
        // Material tier (from photo + MLS enrichment)
        materialTier: result.materialTier || 'unknown',
        
        // Source property
        address: result.address,
        zipCode: result.zipCode,
        state: result.state
      });
    }
  }
  
  if (allRenovationDataPoints.length === 0) {
    return createEmptySummary(zipCode);
  }
  
  // Category alias map: normalize variants to canonical form for aggregation.
  // GPT-4o returns 'kitchen' but the renovationAnalyzer returns 'kitchen_full'.
  // For aggregation, we group these together under the GPT-4o canonical name.
  const CANONICAL_CATEGORY = {
    'kitchen_full': 'kitchen',
    'kitchen_cosmetic': 'kitchen',
    'bathroom_full': 'bathroom',
    'bathroom_cosmetic': 'bathroom',
    'bathroom_master': 'bathroom',    // Consolidate: master + secondary share sample pool
    'bathroom_secondary': 'bathroom', // so we reach MIN_SAMPLE_SIZE more reliably
    'basement_finish': 'basement',
  };

  // Try to re-classify vague categories ("interior", "exterior", "other", "general")
  // by scanning the renovation description for specific keywords.
  function inferCategoryFromDescription(desc) {
    if (!desc) return null;
    const d = desc.toLowerCase();
    if (d.includes('kitchen') || d.includes('cabinet') || d.includes('countertop') || d.includes('appliance') || d.includes('backsplash')) return 'kitchen';
    if (d.includes('bathroom') || d.includes('bath') || d.includes('vanity') || d.includes('shower') || d.includes('toilet') || d.includes('tub')) return 'bathroom_master';
    if (d.includes('floor') || d.includes('carpet') || d.includes('hardwood') || d.includes('lvp') || d.includes('tile') || d.includes('vinyl') || d.includes('laminate')) return 'flooring';
    if (d.includes('paint') && d.includes('exterior')) return 'paint_exterior';
    if (d.includes('paint') || d.includes('wall color') || d.includes('wall paint') || d.includes('fresh coat')) return 'paint_interior';
    if (d.includes('roof') || d.includes('shingle')) return 'roof';
    if (d.includes('window')) return 'windows';
    if (d.includes('door') && !d.includes('outdoor')) return 'doors';
    if (d.includes('siding') || d.includes('exterior clad')) return 'siding';
    if (d.includes('landscape') || d.includes('yard') || d.includes('lawn') || d.includes('garden')) return 'landscaping';
    if (d.includes('driveway') || d.includes('paving')) return 'driveway';
    if (d.includes('hvac') || d.includes('heat') || d.includes('furnace') || d.includes('air condition') || d.includes('a/c')) return 'hvac';
    if (d.includes('electr') || d.includes('wiring') || d.includes('panel')) return 'electrical';
    if (d.includes('plumb') || d.includes('pipe') || d.includes('water heater')) return 'plumbing';
    if (d.includes('basement')) return 'basement';
    if (d.includes('deck') || d.includes('patio') || d.includes('porch')) return 'deck_patio';
    if (d.includes('garage')) return 'garage';
    if (d.includes('attic')) return 'attic';
    if (d.includes('pool') || d.includes('spa')) return 'pool';
    if (d.includes('addition') || d.includes('expand') || d.includes('extension')) return 'addition';
    return null;
  }

  // Invalid/vague categories that should be reclassified from description
  const VAGUE_CATEGORIES = new Set(['interior', 'exterior', 'general', 'whole_house', 'full_renovation', 'other', 'unknown']);

  // Group by renovation category (normalizing aliases)
  const byCategory = {};
  let reclassifiedCount = 0;
  for (const dp of allRenovationDataPoints) {
    let cat = CANONICAL_CATEGORY[dp.category] || dp.category;

    // Try to reclassify vague categories using the description
    if (VAGUE_CATEGORIES.has(cat)) {
      const inferred = inferCategoryFromDescription(dp.description);
      if (inferred) {
        cat = inferred;
        reclassifiedCount++;
      }
    }

    if (!byCategory[cat]) {
      byCategory[cat] = [];
    }
    byCategory[cat].push(dp);
  }
  if (reclassifiedCount > 0) {
    console.log(`[AreaAggregator] Reclassified ${reclassifiedCount} vague renovation categories from descriptions`);
  }
  
  // Build per-category stats
  const renovationStats = [];
  
  for (const [category, dataPoints] of Object.entries(byCategory)) {
    const stats = computeCategoryStats(category, dataPoints, capRateData);
    renovationStats.push(stats);
  }
  
  // Sort by weighted average uplift (highest first) — uplift is the reliable signal,
  // not ROI (which depends on GPT's unreliable cost estimates for comp properties).
  renovationStats.sort((a, b) => b.weightedAvgValueUplift - a.weightedAvgValueUplift);
  
  // Build bestROIRenovations (the key output consumed by the frontend)
  // Exclude categories with fewer than 3 data points — a single comp can't
  // drive a recommendation. This prevents unreliable outliers from appearing
  // as actionable insights.
  const MIN_SAMPLE_SIZE = 3;
  const bestROIRenovations = renovationStats
    .filter(stat => stat.sampleSize >= MIN_SAMPLE_SIZE)
    .map(stat => ({
    renovationType: stat.category,
    scope: stat.dominantScope,
    avgROI: stat.weightedAvgValueROI,
    avgValueUplift: stat.avgValueUplift,
    medianValueUplift: stat.medianValueUplift,
    weightedAvgUplift: stat.weightedAvgValueUplift,
    avgRentIncrease: stat.avgRentIncrease,
    avgCost: stat.avgCost,
    medianROI: stat.medianValueROI,
    sampleSize: stat.sampleSize,
    confidenceLevel: stat.confidenceLevel,
    paybackMonths: stat.avgPaybackMonths,
    roiTrend: stat.roiTrend?.direction === 'increasing' ? 'rising'
      : stat.roiTrend?.direction === 'decreasing' ? 'falling'
      : 'stable',
    roiTrendDetail: stat.roiTrend,
    // Stratification summaries
    byPriceTier: stat.byPriceTier,
    byPropertyType: stat.byPropertyType,
    byYearBuilt: stat.byYearBuilt,
    byMaterialTier: stat.byMaterialTier,
    advisoryOnly: true,
    advisoryReason: 'Per-category comp uplift is explanatory only. Core underwriting uses sales-comparison ARV/AR-rent outputs.'
  }));
  
  // Categories below minimum sample size — available for transparency but not recommended
  const lowConfidenceRenovations = renovationStats
    .filter(stat => stat.sampleSize < MIN_SAMPLE_SIZE && stat.sampleSize > 0)
    .map(stat => ({
      renovationType: stat.category,
      sampleSize: stat.sampleSize,
      avgValueUplift: stat.avgValueUplift,
      confidenceLevel: 'insufficient',
      reason: `Only ${stat.sampleSize} comp(s) — need ${MIN_SAMPLE_SIZE}+ for a recommendation`,
    }));

  if (lowConfidenceRenovations.length > 0) {
    console.log(`[AreaAggregator] Excluded ${lowConfidenceRenovations.length} categories with < ${MIN_SAMPLE_SIZE} data points: ${lowConfidenceRenovations.map(r => r.renovationType).join(', ')}`);
  }

  // Market timing signals
  const marketSignals = generateMarketSignals(renovationStats);

  // Core underwriting valuation (primary output): ARV + AR rent via sales comparison.
  const coreValuation = buildSalesComparisonValuation({
    upliftResults,
    subjectProfile,
    capRateData
  });
  
  // Overall area stats
  const city = upliftResults[0]?.city || '';
  const state = upliftResults[0]?.state || '';
  
  return {
    zipCode,
    city,
    state,
    bestROIRenovations,
    lowConfidenceRenovations, // Categories below minimum sample size (transparency only)
    advisoryOnlyCategoryUplift: true,
    marketSignals,
    coreValuation,
    totalComparables: upliftResults.length,
    totalDataPoints: allRenovationDataPoints.length,
    avgConfidenceScore: Math.round(
      upliftResults.reduce((s, r) => s + (r.confidence?.score || 50), 0) / upliftResults.length
    ),
    lastUpdated: new Date(),
    version: '2.0'
  };
}

// ============================================================================
// PER-CATEGORY STATISTICS
// ============================================================================

function computeCategoryStats(category, dataPoints, capRateData = null) {
  const n = dataPoints.length;
  
  // === Outlier filtering: remove extreme uplift values (IQR method) ===
  // This prevents one flipped property with an extreme uplift from skewing the average.
  const rawUplifts = dataPoints.map(d => d.allocatedUplift).filter(v => v != null && isFinite(v));
  let outlierThresholds = { low: -Infinity, high: Infinity };
  if (rawUplifts.length >= 5) {
    const sorted = [...rawUplifts].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    outlierThresholds = {
      low: q1 - 2.0 * iqr,   // 2x IQR (generous, only removes extreme outliers)
      high: q3 + 2.0 * iqr
    };
  }
  const isOutlier = (uplift) => uplift != null && isFinite(uplift) && (uplift < outlierThresholds.low || uplift > outlierThresholds.high);
  const cleanDataPoints = dataPoints.filter(d => !isOutlier(d.allocatedUplift));
  const outlierCount = n - cleanDataPoints.length;
  if (outlierCount > 0) {
    console.log(`[AreaAggregator] ${category}: removed ${outlierCount} outlier(s) (ROI range [${outlierThresholds.low.toFixed(0)}, ${outlierThresholds.high.toFixed(0)}])`);
  }
  
  // === Value uplift stats (from clean data) ===
  const uplifts = cleanDataPoints.map(d => d.allocatedUplift).filter(v => v != null);
  
  const avgValueUplift = mean(uplifts);
  const medianValueUplift = median(uplifts);
  
  // === Recency+confidence weighted uplift (PRIMARY signal — reliable) ===
  let weightedUpliftSum = 0;
  let upliftTotalWeight = 0;
  for (const dp of cleanDataPoints) {
    if (dp.allocatedUplift == null) continue;
    const confWeight = (dp.analysisConfidence || 50) / 100;
    const recWeight = recencyWeight(dp.afterSaleDate);
    const w = confWeight * recWeight;
    weightedUpliftSum += dp.allocatedUplift * w;
    upliftTotalWeight += w;
  }
  const weightedAvgValueUplift = upliftTotalWeight > 0 ? Math.round(weightedUpliftSum / upliftTotalWeight) : Math.round(avgValueUplift);

  // === Recency-weighted ROI — removed (relied on fabricated comp costs) ===

  // === Rent stats ===
  // Priority 1: actual lease-pair data from address matching
  // Priority 2: derive from value uplift using local cap rate from MLS lease+sale data
  const rentDataPoints = dataPoints.filter(d => d.rentIncrease != null && d.rentIncrease > 0);
  let avgRentIncrease, avgRentROI, avgPaybackMonths;
  let rentSource = 'none';

  if (rentDataPoints.length > 0) {
    avgRentIncrease = Math.round(mean(rentDataPoints.map(d => d.rentIncrease)));
    avgRentROI = null; // Removed: relied on fabricated comp costs
    avgPaybackMonths = null; // Removed: relied on fabricated comp costs
    rentSource = 'lease_pairs';
  } else if (capRateData && avgValueUplift > 0) {
    // Derive rent increase from value uplift using real local cap rate.
    // Cap rate = annual_rent / property_value, so:
    //   monthly_rent_increase = value_uplift × cap_rate / 12
    //
    // Try bed-specific cap rate first (most accurate), fall back to overall.
    const representativeBeds = dataPoints[0]?.beds || null;
    const capRate = (representativeBeds && capRateData.byBeds?.[representativeBeds])
      || capRateData.overall
      || null;

    if (capRate && capRate > 0) {
      avgRentIncrease = Math.round(avgValueUplift * capRate / 12);
      avgRentROI = null; // Removed: relied on fabricated comp costs
      avgPaybackMonths = null; // Removed: relied on fabricated comp costs
      rentSource = 'cap_rate_derived';
      console.log(`[AreaAggregator] ${category}: rent derived from cap rate ${(capRate * 100).toFixed(1)}% → $${avgRentIncrease}/mo from $${Math.round(avgValueUplift)} uplift`);
    } else {
      avgRentIncrease = null;
      avgRentROI = null;
      avgPaybackMonths = null;
    }
  } else {
    avgRentIncrease = null;
    avgRentROI = null;
    avgPaybackMonths = null;
  }
  
  // === Dominant scope ===
  const scopeCounts = {};
  for (const dp of dataPoints) {
    scopeCounts[dp.scope] = (scopeCounts[dp.scope] || 0) + 1;
  }
  const dominantScope = Object.entries(scopeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'refresh';
  
  // === Confidence ===
  const confidenceLevel = n >= 10 ? 'high' : n >= 5 ? 'medium' : 'low';
  
  // === ROI Trend (year over year) ===
  const roiTrend = computeROITrend(dataPoints);
  
  // === Stratification ===
  const byPriceTier = stratifyBy(dataPoints, 'priceTier');
  const byPropertyType = stratifyBy(dataPoints, 'propertyType');
  const byYearBuilt = stratifyBy(dataPoints, 'yearBuiltBracket');
  // Before-condition stratification: shows how uplift varies by starting condition.
  // A "poor" condition property typically sees higher uplift than a "good" one.
  const byBeforeCondition = stratifyBy(dataPoints, 'beforeConditionBracket');
  // Material tier stratification: shows how uplift differs across budget/mid/high/luxury materials.
  const byMaterialTier = stratifyBy(dataPoints, 'materialTier');
  
  return {
    category,
    sampleSize: n,
    dominantScope,
    avgValueUplift: Math.round(avgValueUplift),
    medianValueUplift: Math.round(medianValueUplift),
    weightedAvgValueUplift,
    avgCost: null,      // Removed: comp costs were fabricated, not real data
    medianCost: null,
    avgValueROI: null,
    medianValueROI: null,
    weightedAvgValueROI: null,
    stdDevROI: null,
    avgRentIncrease,
    avgRentROI,
    avgPaybackMonths,
    rentSource,
    rentCapRate: capRateData?.overall || null,
    confidenceLevel,
    roiTrend,
    byPriceTier,
    byPropertyType,
    byYearBuilt,
    byBeforeCondition,
    byMaterialTier
  };
}


// ============================================================================
// ROI TREND DETECTION
// ============================================================================

function computeROITrend(dataPoints) {
  // Group data points by year of after-sale — uses allocatedUplift (real signal)
  const byYear = {};
  for (const dp of dataPoints) {
    const year = dp.afterSaleDate?.getFullYear?.() || new Date().getFullYear();
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(dp.allocatedUplift);
  }
  
  const years = Object.keys(byYear).map(Number).sort();
  if (years.length < 2) {
    return { direction: 'stable', percentChange: 0, years: {} };
  }
  
  // Calculate avg ROI per year
  const yearAvgs = {};
  for (const year of years) {
    yearAvgs[year] = mean(byYear[year].filter(v => v != null && isFinite(v)));
  }
  
  // Compare most recent two years
  const latest = yearAvgs[years[years.length - 1]];
  const previous = yearAvgs[years[years.length - 2]];
  
  let direction = 'stable';
  let percentChange = 0;
  
  if (previous > 0) {
    percentChange = ((latest - previous) / previous) * 100;
    if (percentChange > 10) direction = 'increasing';
    else if (percentChange < -10) direction = 'decreasing';
    else direction = 'stable';
  }
  
  return {
    direction,
    percentChange: Math.round(percentChange),
    yearAvgs
  };
}


// ============================================================================
// STRATIFICATION
// ============================================================================

function stratifyBy(dataPoints, field) {
  const groups = {};
  for (const dp of dataPoints) {
    const key = dp[field] || 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(dp);
  }
  
  const result = {};
  for (const [key, points] of Object.entries(groups)) {
    const rois = []; // Removed: valueROI relied on fabricated comp costs
    const uplifts = points.map(p => p.allocatedUplift).filter(v => v != null);
    
    // Confidence+recency weighted average uplift (primary signal)
    let weightedUplift = null;
    if (uplifts.length > 0) {
      let wSum = 0, wTotal = 0;
      for (const p of points) {
        if (p.allocatedUplift == null) continue;
        const confWeight = (p.analysisConfidence || 50) / 100;
        const recWeight = recencyWeight(p.afterSaleDate);
        const w = confWeight * recWeight;
        wSum += p.allocatedUplift * w;
        wTotal += w;
      }
      weightedUplift = wTotal > 0 ? Math.round(wSum / wTotal) : Math.round(mean(uplifts));
    }
    
    result[key] = {
      sampleSize: points.length,
      avgROI: null,          // Removed: relied on fabricated comp costs
      weightedAvgROI: null,
      avgUplift: uplifts.length > 0 ? Math.round(mean(uplifts)) : null,
      medianUplift: uplifts.length > 0 ? Math.round(median(uplifts)) : null,
      weightedAvgUplift: weightedUplift,
      avgCost: null          // Removed: relied on fabricated comp costs
    };
  }
  
  return result;
}


// ============================================================================
// MARKET SIGNALS
// ============================================================================

function generateMarketSignals(renovationStats) {
  const saturatedRenovations = [];
  const highOpportunityRenovations = [];
  const warnings = [];
  
  for (const stat of renovationStats) {
    // Declining ROI = market getting saturated with that renovation type
    if (stat.roiTrend.direction === 'decreasing' && stat.roiTrend.percentChange < -15) {
      saturatedRenovations.push(stat.category);
    }
    
    // Increasing ROI = growing opportunity
    if (stat.roiTrend.direction === 'increasing' && stat.roiTrend.percentChange > 15) {
      highOpportunityRenovations.push(stat.category);
    }
    
    // Low sample warnings
    if (stat.sampleSize < 3) {
      warnings.push(`${stat.category}: only ${stat.sampleSize} data points — interpret with caution`);
    }
  }
  
  // Overall health — based on average uplift across categories (not ROI, which requires cost data)
  const avgUplift = renovationStats.length > 0
    ? mean(renovationStats.map(s => s.weightedAvgValueUplift).filter(v => v != null))
    : 0;
  
  // Classify health based on absolute uplift dollar value
  const overallHealth = avgUplift > 25000 ? 'strong' : avgUplift > 10000 ? 'moderate' : 'weak';
  
  return {
    overallHealth,
    saturatedRenovations,
    highOpportunityRenovations,
    warnings,
    avgAreaROI: null // Removed: ROI relied on fabricated comp costs
  };
}


// ============================================================================
// RENTAL RATE ANALYSIS
// ============================================================================

/**
 * Aggregate rental rate uplift data separately.
 * This looks specifically at rent changes post-renovation across the area.
 * 
 * @param {Array} upliftResults - Array of isolateRenovationUplift() results (those with rent data)
 * @returns {Object} - Per-renovation-type rent uplift stats
 */
export function aggregateRentalUpliftStats(upliftResults) {
  const withRent = upliftResults.filter(r => r.rentAnalysis && r.rentAnalysis.rentIncrease > 0);
  
  if (withRent.length === 0) {
    return { available: false, sampleSize: 0, byRenovationType: {} };
  }
  
  // For rental analysis we need to estimate per-renovation rent contribution.
  // Unlike value uplift (which we can precisely allocate), rent increase is a
  // single number for the whole property. We approximate by distributing the
  // total rent increase proportionally to each renovation's value uplift share.
  const rentalDataPoints = [];
  
  for (const result of withRent) {
    const totalUplift = result.renovationAttributedUplift || 1;
    const totalRentIncrease = result.rentAnalysis.rentIncrease;
    
    for (const reno of (result.renovationBreakdown || [])) {
      const upliftShare = totalUplift > 0 ? (reno.allocatedUplift || 0) / totalUplift : 0;
      const estimatedRentContribution = totalRentIncrease * upliftShare;
      
      rentalDataPoints.push({
        category: reno.category,
        rentContribution: Math.round(estimatedRentContribution),
        propertyType: result.propertyType,
        priceTier: getPriceTier(result.beforeSalePrice)
      });
    }
  }
  
  // Group by category
  const byCategory = {};
  for (const dp of rentalDataPoints) {
    if (!byCategory[dp.category]) byCategory[dp.category] = [];
    byCategory[dp.category].push(dp);
  }
  
  const byRenovationType = {};
  for (const [cat, points] of Object.entries(byCategory)) {
    const rents = points.map(p => p.rentContribution).filter(v => v > 0);
    const avgRent = rents.length > 0 ? mean(rents) : 0;
    
    byRenovationType[cat] = {
      avgMonthlyRentIncrease: Math.round(avgRent),
      medianMonthlyRentIncrease: Math.round(median(rents.length > 0 ? rents : [0])),
      avgCost: null,       // Removed: relied on fabricated comp costs
      rentROI: null,       // Removed: relied on fabricated comp costs
      paybackMonths: null, // Removed: relied on fabricated comp costs
      sampleSize: points.length
    };
  }
  
  return {
    available: true,
    sampleSize: withRent.length,
    totalRentalDataPoints: rentalDataPoints.length,
    byRenovationType
  };
}


// ============================================================================
// HELPERS
// ============================================================================

function getPriceTier(price) {
  if (!price) return 'unknown';
  if (price < 200000) return 'under_200k';
  if (price < 350000) return '200k_350k';
  if (price < 500000) return '350k_500k';
  if (price < 750000) return '500k_750k';
  if (price < 1000000) return '750k_1m';
  return 'over_1m';
}

function getYearBuiltBracket(year) {
  if (!year) return 'unknown';
  if (year < 1950) return 'pre_1950';
  if (year < 1970) return '1950_1970';
  if (year < 1990) return '1970_1990';
  if (year < 2005) return '1990_2005';
  if (year < 2015) return '2005_2015';
  return 'post_2015';
}

/**
 * Convert a 1-10 before-condition score into a bracket for stratification.
 * Properties in similar starting condition will have more comparable ROI outcomes.
 */
function getConditionBracket(score) {
  if (!score || typeof score !== 'number') return 'unknown';
  if (score <= 3) return 'poor';        // 1-3: severely distressed / poor
  if (score <= 5) return 'fair';         // 4-5: dated, deferred maintenance
  if (score <= 7) return 'good';         // 6-7: functional, some updates needed
  return 'excellent';                     // 8-10: well-maintained, minor work
}

function recencyWeight(date) {
  if (!date) return 0.5;
  const now = new Date();
  const yearsAgo = (now.getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24 * 365);
  return Math.exp(-0.3 * yearsAgo);
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const avg = mean(arr);
  const squaredDiffs = arr.map(v => (v - avg) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}

function createEmptySummary(zipCode) {
  return {
    zipCode,
    city: '',
    state: '',
    bestROIRenovations: [],
    advisoryOnlyCategoryUplift: true,
    marketSignals: {
      overallHealth: 'weak',
      saturatedRenovations: [],
      highOpportunityRenovations: [],
      warnings: ['No renovation comparables available for this area'],
      avgAreaROI: 0
    },
    coreValuation: {
      primaryMethod: 'sales_comparison',
      available: false,
      reason: 'no_comp_sales'
    },
    totalComparables: 0,
    totalDataPoints: 0,
    avgConfidenceScore: 0,
    lastUpdated: new Date(),
    version: '2.0'
  };
}

export default {
  aggregateAreaRenovationStats,
  aggregateRentalUpliftStats
};
