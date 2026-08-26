/**
 * Renovation Uplift Isolation Engine
 * 
 * Given a before/after property sale pair with detected renovations,
 * this engine isolates the TRUE renovation-attributed value uplift by
 * subtracting out:
 *   1. Natural market appreciation (zip-level MLS median price trends)
 *   2. Initial pricing inefficiency (was the first sale underpriced?)
 *   3. Tax-assessment validation (does the county agree value was added?)
 * 
 * Then allocates the remaining uplift across individual detected renovations
 * using a weighted model based on renovation scope, cost, and industry data.
 */

import snowflake from '../zillowApi.js';
import { fetchAttomAVM } from '../attom.js';

// ============================================================================
// 1. MARKET APPRECIATION SUBTRACTION
// ============================================================================

/**
 * Calculate the market appreciation between two dates for a specific zip/area.
 * Uses actual MLS median price trends from Snowflake (preferred) or falls back
 * to FRED/Case-Shiller-style hardcoded rates.
 * 
 * @param {Object} params
 * @param {string} params.zipCode
 * @param {string} params.state
 * @param {string} params.propertyType - SFH, CONDO, etc.
 * @param {Date} params.beforeDate - Date of first sale
 * @param {Date} params.afterDate - Date of second sale
 * @param {number} params.beforePrice - First sale price
 * @returns {{ appreciationAmount: number, appreciationPercent: number, source: string, yearlyRates: Object }}
 */
export async function calculateMarketAppreciation({
  zipCode,
  state,
  propertyType,
  beforeDate,
  afterDate,
  beforePrice
}) {
  const before = new Date(beforeDate);
  const after = new Date(afterDate);
  
  // Try to get market appreciation data from Zillow ZHVI / housing market
  try {
    const marketData = await snowflake.getMarketAppreciation({
      zip: zipCode,
      state,
      propertyType
    });
    
    if (marketData && marketData.length >= 2) {
      // Check if this is ZHVI data (has ZHVI_VALUES) for monthly precision
      const hasZHVI = marketData.some(r => r.ZHVI_VALUES && r.ZHVI_VALUES.length > 0);
      if (hasZHVI) {
        return calculateFromZHVIData(marketData, before, after, beforePrice);
      }
      return calculateFromMLSData(marketData, before, after, beforePrice);
    }
  } catch (err) {
    console.warn('[UpliftIsolation] Zillow market appreciation failed, using fallback:', err.message);
  }
  
  // Fallback: use regional hardcoded appreciation rates
  return calculateFromRegionalRates(state, before, after, beforePrice);
}

/**
 * Calculate appreciation from actual MLS median price data.
 * Interpolates between yearly data points for partial-year precision.
 */
function calculateFromMLSData(marketData, beforeDate, afterDate, beforePrice) {
  // Build year → median price map
  const yearPrices = {};
  for (const row of marketData) {
    const year = row.YEAR || row.year;
    const median = row.MEDIAN_CLOSE_PRICE || row.median_close_price || row.AVG_CLOSE_PRICE || row.avg_close_price;
    if (year && median) {
      yearPrices[year] = median;
    }
  }
  
  const beforeYear = beforeDate.getFullYear();
  const afterYear = afterDate.getFullYear();
  
  // Get the median price at (or near) each date
  const beforeMedian = interpolatePrice(yearPrices, beforeYear, beforeDate.getMonth());
  const afterMedian = interpolatePrice(yearPrices, afterYear, afterDate.getMonth());
  
  if (!beforeMedian || !afterMedian || beforeMedian <= 0) {
    return calculateFromRegionalRates('NATIONAL', beforeDate, afterDate, beforePrice);
  }
  
  // The market appreciation rate is how much the MEDIAN moved
  const marketAppreciationPercent = ((afterMedian - beforeMedian) / beforeMedian) * 100;
  const appreciationAmount = beforePrice * (marketAppreciationPercent / 100);
  
  // Also compute yearly rates for transparency
  const yearlyRates = {};
  const sortedYears = Object.keys(yearPrices).map(Number).sort();
  for (let i = 1; i < sortedYears.length; i++) {
    const prev = yearPrices[sortedYears[i - 1]];
    const curr = yearPrices[sortedYears[i]];
    if (prev > 0) {
      yearlyRates[sortedYears[i]] = ((curr - prev) / prev) * 100;
    }
  }
  
  return {
    appreciationAmount: Math.round(appreciationAmount),
    appreciationPercent: Math.round(marketAppreciationPercent * 100) / 100,
    source: 'zillow_mls_median',
    yearlyRates,
    beforeMedian: Math.round(beforeMedian),
    afterMedian: Math.round(afterMedian)
  };
}

/**
 * Calculate appreciation from Zillow ZHVI (Zillow Home Value Index) monthly data.
 * ZHVI is a smoothed, seasonally-adjusted index — more precise than yearly MLS medians.
 * Provides month-level interpolation for accurate before/after comparison.
 */
function calculateFromZHVIData(marketData, beforeDate, afterDate, beforePrice) {
  // Build a month-level index from ZHVI values
  // marketData is grouped by year, each entry has ZHVI_VALUES (array of monthly values)
  const monthlyValues = [];
  for (const row of marketData) {
    const year = row.YEAR || row.year;
    const zhviValues = row.ZHVI_VALUES || [];
    // ZHVI values are typically monthly, Jan-Dec
    for (let m = 0; m < zhviValues.length; m++) {
      if (zhviValues[m] && zhviValues[m] > 0) {
        monthlyValues.push({ year, month: m, value: zhviValues[m] });
      }
    }
  }

  if (monthlyValues.length < 2) {
    // Fall back to yearly if monthly data is sparse
    return calculateFromMLSData(marketData, beforeDate, afterDate, beforePrice);
  }

  // Interpolate ZHVI values at the target dates (linear interpolation between
  // the two nearest monthly data points) instead of nearest-neighbor,
  // which can introduce up to ±1 month of drift.
  const interpolateZHVI = (targetYear, targetMonth) => {
    const targetKey = targetYear * 12 + targetMonth;
    // Find the two closest data points on either side
    let before = null, after = null;
    for (const mv of monthlyValues) {
      const key = mv.year * 12 + mv.month;
      if (key <= targetKey) {
        if (!before || key > (before.year * 12 + before.month)) before = mv;
      }
      if (key >= targetKey) {
        if (!after || key < (after.year * 12 + after.month)) after = mv;
      }
    }
    if (before && after && before !== after) {
      const beforeKey = before.year * 12 + before.month;
      const afterKey = after.year * 12 + after.month;
      const t = (targetKey - beforeKey) / (afterKey - beforeKey);
      return { value: before.value + (after.value - before.value) * t, year: targetYear, month: targetMonth };
    }
    // Exact match or only one side — fall back to closest
    if (before && (before.year * 12 + before.month) === targetKey) return before;
    if (after && (after.year * 12 + after.month) === targetKey) return after;
    return before || after || null;
  };

  const beforeZHVI = interpolateZHVI(beforeDate.getFullYear(), beforeDate.getMonth());
  const afterZHVI = interpolateZHVI(afterDate.getFullYear(), afterDate.getMonth());

  if (!beforeZHVI || !afterZHVI || beforeZHVI.value <= 0) {
    return calculateFromRegionalRates('NATIONAL', beforeDate, afterDate, beforePrice);
  }

  // Detect when ZHVI data doesn't actually cover the target date range.
  // The interpolation will clamp to the earliest/latest available data point,
  // producing 0% appreciation when both targets fall outside the data range.
  // In that case, fall back to regional rates which cover 2015-2026.
  const minDataYear = Math.min(...monthlyValues.map(mv => mv.year));
  const maxDataYear = Math.max(...monthlyValues.map(mv => mv.year));
  const beforeTargetKey = beforeDate.getFullYear() * 12 + beforeDate.getMonth();
  const afterTargetKey = afterDate.getFullYear() * 12 + afterDate.getMonth();
  const minDataKey = minDataYear * 12 + Math.min(...monthlyValues.filter(mv => mv.year === minDataYear).map(mv => mv.month));
  const maxDataKey = maxDataYear * 12 + Math.max(...monthlyValues.filter(mv => mv.year === maxDataYear).map(mv => mv.month));

  // If either target date is more than 12 months outside the ZHVI data range,
  // the interpolated value is just the edge value — unreliable.
  if (beforeTargetKey < minDataKey - 12 || afterTargetKey > maxDataKey + 12) {
    console.log(`[UpliftIsolation] ZHVI data range (${minDataYear}-${maxDataYear}) doesn't cover sale dates (${beforeDate.getFullYear()}-${afterDate.getFullYear()}), falling back to regional rates`);
    // Extract state from the calling context — marketData may have it
    const fallbackState = marketData[0]?.STATE || 'NATIONAL';
    return calculateFromRegionalRates(fallbackState, beforeDate, afterDate, beforePrice);
  }

  // Also detect the degenerate case where both interpolations clamped to the
  // same data point (same year+month) — the appreciation is meaningless.
  const bKey = beforeZHVI.year * 12 + beforeZHVI.month;
  const aKey = afterZHVI.year * 12 + afterZHVI.month;
  if (bKey === aKey) {
    console.log(`[UpliftIsolation] ZHVI interpolation clamped both dates to same point (${beforeZHVI.year}-${beforeZHVI.month + 1}), falling back to regional rates`);
    const fallbackState = marketData[0]?.STATE || 'NATIONAL';
    return calculateFromRegionalRates(fallbackState, beforeDate, afterDate, beforePrice);
  }

  const marketAppreciationPercent = ((afterZHVI.value - beforeZHVI.value) / beforeZHVI.value) * 100;
  const appreciationAmount = beforePrice * (marketAppreciationPercent / 100);

  // Compute yearly rates for transparency
  const yearlyRates = {};
  const years = [...new Set(monthlyValues.map(m => m.year))].sort();
  for (let i = 1; i < years.length; i++) {
    const prevYearVals = monthlyValues.filter(m => m.year === years[i - 1]);
    const currYearVals = monthlyValues.filter(m => m.year === years[i]);
    if (prevYearVals.length > 0 && currYearVals.length > 0) {
      const prevAvg = prevYearVals.reduce((s, v) => s + v.value, 0) / prevYearVals.length;
      const currAvg = currYearVals.reduce((s, v) => s + v.value, 0) / currYearVals.length;
      if (prevAvg > 0) yearlyRates[years[i]] = Math.round(((currAvg - prevAvg) / prevAvg) * 10000) / 100;
    }
  }

  return {
    appreciationAmount: Math.round(appreciationAmount),
    appreciationPercent: Math.round(marketAppreciationPercent * 100) / 100,
    source: 'zillow_zhvi',
    yearlyRates,
    beforeMedian: Math.round(beforeZHVI.value),
    afterMedian: Math.round(afterZHVI.value),
    beforeMonth: `${beforeZHVI.year}-${String(beforeZHVI.month + 1).padStart(2, '0')}`,
    afterMonth: `${afterZHVI.year}-${String(afterZHVI.month + 1).padStart(2, '0')}`,
  };
}

/**
 * Interpolate median price for a fractional year (month precision)
 */
function interpolatePrice(yearPrices, year, month) {
  const fraction = month / 12;
  const thisYear = yearPrices[year];
  const nextYear = yearPrices[year + 1];
  const prevYear = yearPrices[year - 1];
  
  if (thisYear && nextYear) {
    return thisYear + (nextYear - thisYear) * fraction;
  }
  if (thisYear) {
    return thisYear;
  }
  if (prevYear && nextYear) {
    return prevYear + (nextYear - prevYear) * ((12 + month) / 24);
  }
  // Find nearest available year
  const years = Object.keys(yearPrices).map(Number).sort();
  if (years.length === 0) return null;
  const nearest = years.reduce((a, b) => Math.abs(b - year) < Math.abs(a - year) ? b : a);
  return yearPrices[nearest];
}

/**
 * Fallback: hardcoded regional appreciation rates (from Case-Shiller / FRED)
 * Exported so processor.js can compute a quick market appreciation estimate
 * before the classifier runs.
 */
export const REGIONAL_APPRECIATION = {
  'NATIONAL': { 2015: 5.3, 2016: 5.6, 2017: 6.2, 2018: 5.2, 2019: 4.1, 2020: 7.5, 2021: 18.8, 2022: 10.2, 2023: 5.8, 2024: 4.5, 2025: 3.8, 2026: 3.5 },
  // Original 10 states
  'TX': { 2015: 7.5, 2016: 6.8, 2017: 6.5, 2018: 6.1, 2019: 4.8, 2020: 8.2, 2021: 20.5, 2022: 12.1, 2023: 4.2, 2024: 3.8, 2025: 4.1, 2026: 3.8 },
  'CA': { 2015: 6.8, 2016: 6.2, 2017: 7.5, 2018: 5.5, 2019: 3.2, 2020: 9.1, 2021: 22.3, 2022: 8.5, 2023: 2.1, 2024: 4.8, 2025: 5.2, 2026: 4.5 },
  'FL': { 2015: 7.0, 2016: 7.8, 2017: 7.2, 2018: 6.8, 2019: 5.2, 2020: 10.5, 2021: 25.1, 2022: 15.2, 2023: 6.5, 2024: 4.2, 2025: 3.5, 2026: 3.2 },
  'AZ': { 2015: 6.5, 2016: 7.2, 2017: 8.0, 2018: 7.2, 2019: 6.5, 2020: 12.1, 2021: 28.5, 2022: 18.2, 2023: -2.5, 2024: 2.8, 2025: 4.5, 2026: 4.2 },
  'GA': { 2015: 6.0, 2016: 6.5, 2017: 6.8, 2018: 6.0, 2019: 5.5, 2020: 8.8, 2021: 19.2, 2022: 11.8, 2023: 5.5, 2024: 4.0, 2025: 3.8, 2026: 3.5 },
  'NC': { 2015: 5.5, 2016: 5.8, 2017: 6.0, 2018: 5.8, 2019: 5.0, 2020: 9.2, 2021: 20.8, 2022: 13.5, 2023: 5.0, 2024: 4.2, 2025: 4.0, 2026: 3.8 },
  'TN': { 2015: 6.0, 2016: 6.5, 2017: 6.8, 2018: 6.2, 2019: 5.5, 2020: 9.5, 2021: 21.5, 2022: 14.0, 2023: 4.5, 2024: 3.8, 2025: 3.5, 2026: 3.2 },
  'OH': { 2015: 3.5, 2016: 4.0, 2017: 4.5, 2018: 4.2, 2019: 3.8, 2020: 7.0, 2021: 15.5, 2022: 9.5, 2023: 4.0, 2024: 3.2, 2025: 3.0, 2026: 2.8 },
  'CO': { 2015: 10.5, 2016: 9.0, 2017: 8.5, 2018: 6.8, 2019: 3.5, 2020: 8.0, 2021: 18.2, 2022: 7.5, 2023: 1.5, 2024: 3.0, 2025: 4.0, 2026: 3.8 },
  'WA': { 2015: 8.5, 2016: 10.0, 2017: 12.5, 2018: 6.5, 2019: 2.8, 2020: 8.5, 2021: 20.5, 2022: 8.0, 2023: 1.8, 2024: 4.5, 2025: 5.0, 2026: 4.2 },
  // Expanded: 20 additional high-activity states (Case-Shiller / FRED / Zillow ZHVI derived)
  'MD': { 2015: 2.8, 2016: 3.2, 2017: 3.5, 2018: 3.8, 2019: 3.5, 2020: 7.2, 2021: 14.5, 2022: 8.8, 2023: 4.2, 2024: 4.0, 2025: 3.5, 2026: 3.2 },
  'VA': { 2015: 2.5, 2016: 3.0, 2017: 3.2, 2018: 3.5, 2019: 3.8, 2020: 7.5, 2021: 13.8, 2022: 8.5, 2023: 3.8, 2024: 3.5, 2025: 3.2, 2026: 3.0 },
  'DC': { 2015: 3.0, 2016: 4.5, 2017: 3.8, 2018: 4.2, 2019: 3.5, 2020: 6.8, 2021: 11.2, 2022: 5.5, 2023: 2.0, 2024: 3.5, 2025: 3.8, 2026: 3.5 },
  'NJ': { 2015: 2.0, 2016: 3.2, 2017: 3.5, 2018: 3.0, 2019: 3.5, 2020: 8.5, 2021: 16.2, 2022: 10.5, 2023: 5.5, 2024: 5.0, 2025: 4.2, 2026: 3.8 },
  'MA': { 2015: 4.5, 2016: 4.8, 2017: 5.5, 2018: 5.0, 2019: 3.8, 2020: 8.2, 2021: 17.5, 2022: 9.8, 2023: 5.0, 2024: 5.5, 2025: 4.5, 2026: 4.0 },
  'CT': { 2015: -0.5, 2016: 0.5, 2017: 1.2, 2018: 1.5, 2019: 1.8, 2020: 8.0, 2021: 15.8, 2022: 10.2, 2023: 6.5, 2024: 5.8, 2025: 4.5, 2026: 3.8 },
  'PA': { 2015: 2.2, 2016: 3.0, 2017: 3.5, 2018: 3.8, 2019: 3.5, 2020: 7.8, 2021: 16.5, 2022: 9.2, 2023: 4.5, 2024: 4.0, 2025: 3.5, 2026: 3.2 },
  'NY': { 2015: 2.5, 2016: 3.5, 2017: 4.0, 2018: 3.2, 2019: 2.5, 2020: 5.5, 2021: 14.2, 2022: 8.0, 2023: 3.5, 2024: 4.2, 2025: 4.0, 2026: 3.5 },
  'SC': { 2015: 5.0, 2016: 5.5, 2017: 5.8, 2018: 5.5, 2019: 5.0, 2020: 9.8, 2021: 21.5, 2022: 14.8, 2023: 5.2, 2024: 4.0, 2025: 3.5, 2026: 3.2 },
  'NV': { 2015: 6.0, 2016: 6.5, 2017: 8.5, 2018: 10.2, 2019: 4.8, 2020: 6.5, 2021: 25.8, 2022: 15.5, 2023: -3.5, 2024: 3.0, 2025: 4.8, 2026: 4.2 },
  'UT': { 2015: 7.0, 2016: 8.2, 2017: 9.5, 2018: 8.0, 2019: 5.5, 2020: 10.5, 2021: 28.2, 2022: 12.5, 2023: -1.5, 2024: 3.5, 2025: 4.5, 2026: 4.0 },
  'ID': { 2015: 7.5, 2016: 8.5, 2017: 10.0, 2018: 11.5, 2019: 8.0, 2020: 15.0, 2021: 32.5, 2022: 15.0, 2023: -4.0, 2024: 2.5, 2025: 4.0, 2026: 3.8 },
  'OR': { 2015: 8.0, 2016: 10.5, 2017: 8.5, 2018: 6.0, 2019: 3.0, 2020: 9.5, 2021: 18.5, 2022: 7.5, 2023: 0.5, 2024: 3.5, 2025: 4.2, 2026: 3.8 },
  'IL': { 2015: 1.5, 2016: 3.0, 2017: 3.5, 2018: 2.8, 2019: 2.5, 2020: 6.5, 2021: 12.8, 2022: 8.0, 2023: 4.5, 2024: 4.0, 2025: 3.5, 2026: 3.2 },
  'MI': { 2015: 5.5, 2016: 6.0, 2017: 6.5, 2018: 5.5, 2019: 4.0, 2020: 8.0, 2021: 16.5, 2022: 10.0, 2023: 3.5, 2024: 3.0, 2025: 3.0, 2026: 2.8 },
  'MN': { 2015: 4.5, 2016: 5.0, 2017: 5.5, 2018: 5.2, 2019: 4.5, 2020: 7.5, 2021: 14.8, 2022: 7.5, 2023: 3.0, 2024: 3.5, 2025: 3.5, 2026: 3.2 },
  'IN': { 2015: 4.0, 2016: 4.5, 2017: 5.0, 2018: 5.2, 2019: 4.5, 2020: 7.8, 2021: 16.0, 2022: 10.5, 2023: 4.8, 2024: 3.8, 2025: 3.5, 2026: 3.2 },
  'MO': { 2015: 3.5, 2016: 4.0, 2017: 4.5, 2018: 4.5, 2019: 4.0, 2020: 7.5, 2021: 15.2, 2022: 9.0, 2023: 3.5, 2024: 3.2, 2025: 3.0, 2026: 2.8 },
  'AL': { 2015: 2.5, 2016: 3.5, 2017: 4.0, 2018: 4.5, 2019: 4.0, 2020: 8.0, 2021: 16.8, 2022: 12.0, 2023: 4.0, 2024: 3.2, 2025: 3.0, 2026: 2.8 },
  'LA': { 2015: 2.0, 2016: 2.5, 2017: 2.0, 2018: 2.5, 2019: 2.8, 2020: 5.5, 2021: 12.0, 2022: 8.5, 2023: 3.0, 2024: 2.5, 2025: 2.5, 2026: 2.5 },
  'WI': { 2015: 3.5, 2016: 4.0, 2017: 4.5, 2018: 4.5, 2019: 4.0, 2020: 8.0, 2021: 14.5, 2022: 8.5, 2023: 4.0, 2024: 3.5, 2025: 3.2, 2026: 3.0 },
};

export function calculateFromRegionalRates(state, beforeDate, afterDate, beforePrice) {
  const rates = REGIONAL_APPRECIATION[state] || REGIONAL_APPRECIATION['NATIONAL'];
  
  const startYear = beforeDate.getFullYear();
  const endYear = afterDate.getFullYear();
  
  let cumulativeRate = 1.0;
  const yearlyRates = {};
  
  for (let year = startYear; year <= endYear; year++) {
    const annualRate = rates[year] || 4.0; // Default 4%
    
    let yearFraction = 1.0;
    if (startYear === endYear) {
      // Same year: fraction is just the months between the two dates
      yearFraction = (afterDate.getMonth() - beforeDate.getMonth() + 1) / 12;
    } else if (year === startYear) {
      yearFraction = (12 - beforeDate.getMonth()) / 12;
    } else if (year === endYear) {
      yearFraction = (afterDate.getMonth() + 1) / 12;
    }
    
    // Compound interest: (1 + rate)^fraction — more accurate than simple interest
    // for multi-year periods where appreciation compounds.
    cumulativeRate *= Math.pow(1 + annualRate / 100, yearFraction);
    yearlyRates[year] = annualRate;
  }
  
  const appreciationPercent = (cumulativeRate - 1) * 100;
  const appreciationAmount = beforePrice * (appreciationPercent / 100);
  
  return {
    appreciationAmount: Math.round(appreciationAmount),
    appreciationPercent: Math.round(appreciationPercent * 100) / 100,
    source: 'regional_case_shiller_fallback',
    yearlyRates,
    beforeMedian: null,
    afterMedian: null
  };
}


// ============================================================================
// 2. PRICING INEFFICIENCY DETECTION
// ============================================================================

/**
 * Detect if the first sale was mispriced (sold significantly below fair value).
 * Uses three signals:
 *   a) Sale-to-list ratio (if sold way below ask, likely distressed)
 *   b) Days on market (if sold very fast, may have been underpriced)
 *   c) Comparable sales at the time (was it below area median $/sqft?)
 * 
 * Returns a conservative estimate of the mispricing amount (errs on the side
 * of attributing MORE to renovations, not less).
 * 
 * @param {Object} params
 * @returns {{ mispricingAmount: number, mispricingPercent: number, confidence: string, signals: Object }}
 */
export async function detectPricingInefficiency({
  beforeSalePrice,
  beforeListPrice,
  beforeDaysOnMarket,
  beforeDate,
  zipCode,
  state,
  sqft,
  propertyType,
  beds,
  baths,
  yearBuilt,
  address
}) {
  const signals = {
    saleToList: null,
    daysOnMarket: null,
    comparablePSF: null,
    attomAVM: null
  };
  
  let totalMispricingEstimate = 0;
  let signalCount = 0;
  let strongSignals = 0;
  
  // ---- Signal A: Sale-to-list ratio ----
  if (beforeSalePrice && beforeListPrice && beforeListPrice > 0) {
    const saleToListRatio = beforeSalePrice / beforeListPrice;
    signals.saleToList = {
      ratio: Math.round(saleToListRatio * 1000) / 1000,
      listPrice: beforeListPrice,
      salePrice: beforeSalePrice
    };
    
    // If sold more than 8% below list, likely some distress / inefficiency
    if (saleToListRatio < 0.92) {
      // Conservative: attribute half the list-to-sale gap as mispricing
      // (the other half might be genuine overpricing by seller)
      const gap = beforeListPrice - beforeSalePrice;
      const mispricingFromSaleToList = gap * 0.5;
      totalMispricingEstimate += mispricingFromSaleToList;
      strongSignals++;
      signals.saleToList.mispricing = Math.round(mispricingFromSaleToList);
      signals.saleToList.flag = 'underpriced_sale';
    } else if (saleToListRatio < 0.95) {
      const gap = beforeListPrice - beforeSalePrice;
      const mispricingFromSaleToList = gap * 0.3;
      totalMispricingEstimate += mispricingFromSaleToList;
      signals.saleToList.mispricing = Math.round(mispricingFromSaleToList);
      signals.saleToList.flag = 'mild_discount';
    } else {
      signals.saleToList.flag = 'normal';
    }
    signalCount++;
  }
  
  // ---- Signal B: Days on market ----
  if (typeof beforeDaysOnMarket === 'number') {
    signals.daysOnMarket = {
      days: beforeDaysOnMarket
    };
    
    // Very fast sale (under 7 days) suggests underpricing
    if (beforeDaysOnMarket <= 7) {
      // Estimate ~3-5% underpricing for ultra-fast sales
      const fastSaleAdjustment = beforeSalePrice * 0.03;
      totalMispricingEstimate += fastSaleAdjustment;
      strongSignals++;
      signals.daysOnMarket.mispricing = Math.round(fastSaleAdjustment);
      signals.daysOnMarket.flag = 'very_fast_sale';
    } else if (beforeDaysOnMarket <= 14) {
      const fastSaleAdjustment = beforeSalePrice * 0.015;
      totalMispricingEstimate += fastSaleAdjustment;
      signals.daysOnMarket.mispricing = Math.round(fastSaleAdjustment);
      signals.daysOnMarket.flag = 'fast_sale';
    } else {
      signals.daysOnMarket.flag = 'normal';
    }
    signalCount++;
  }
  
  // ---- Signal C: Comparable price per sqft (scoped to similar properties) ----
  // Uses true comps: same zip, property type, ±1 bed/bath, ±30% sqft, ±15 years age
  if (sqft && sqft > 0 && beforeSalePrice) {
    const propertyPSF = beforeSalePrice / sqft;
    
    try {
      const beforeYear = new Date(beforeDate).getFullYear();
      const compStats = await snowflake.getComparableMarketStats({
        zip: zipCode,
        state,
        propertyType,
        beds,
        baths,
        sqft,
        yearBuilt: yearBuilt || null,
        saleYear: beforeYear
      });
      
      const compPSF = compStats?.medianPSF || compStats?.avgPSF;
      
      if (compPSF && compPSF > 0 && compStats.sampleSize >= 3) {
        const psfRatio = propertyPSF / compPSF;
        signals.comparablePSF = {
          propertyPSF: Math.round(propertyPSF),
          compPSF: Math.round(compPSF),
          compSampleSize: compStats.sampleSize,
          compFilters: compStats.filters,
          ratio: Math.round(psfRatio * 100) / 100
        };
        
        // If property sold >15% below comparable median $/sqft, that's meaningful
        if (psfRatio < 0.85) {
          const psfGap = (compPSF - propertyPSF) * sqft;
          // Conservative: attribute 40% of the gap to mispricing
          const psfMispricing = psfGap * 0.4;
          totalMispricingEstimate += psfMispricing;
          strongSignals++;
          signals.comparablePSF.mispricing = Math.round(psfMispricing);
          signals.comparablePSF.flag = 'below_comp_psf';
        } else if (psfRatio < 0.92) {
          const psfGap = (compPSF - propertyPSF) * sqft;
          const psfMispricing = psfGap * 0.25;
          totalMispricingEstimate += psfMispricing;
          signals.comparablePSF.mispricing = Math.round(psfMispricing);
          signals.comparablePSF.flag = 'slightly_below_comp';
        } else {
          signals.comparablePSF.flag = 'normal';
        }
        signalCount++;
        console.log(`[UpliftIsolation] Comp PSF: $${Math.round(propertyPSF)}/sqft vs $${Math.round(compPSF)}/sqft median (${compStats.sampleSize} comps, ratio=${psfRatio.toFixed(2)})`);
      } else {
        console.log(`[UpliftIsolation] Insufficient comps for PSF signal (${compStats?.sampleSize || 0} found)`);
      }
    } catch (err) {
      console.warn('[UpliftIsolation] Could not fetch comparable PSF data:', err.message);
    }
  }
  
  // ---- Signal D: Zestimate cross-validation ----
  // If Zillow's Zestimate valued the property higher than the before-sale price,
  // the gap represents a likely buying-below-market discount (distressed seller,
  // off-market deal, etc.), not renovation uplift.
  // Falls back to ATTOM AVM if Zestimate is unavailable.
  //
  // IMPORTANT: Only valid when the before-sale is within ~3 years of today.
  // A current Zestimate tells us nothing about whether a 2017 sale was fair —
  // the gap is just cumulative appreciation, not mispricing.
  const saleAgeYears = beforeDate ? (Date.now() - new Date(beforeDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25) : 999;
  const avmRelevant = saleAgeYears <= 3;
  if (beforeSalePrice && address && avmRelevant) {
    try {
      // Try Zestimate first (free — already in Zillow property detail response)
      let avmValue = null;
      let avmSource = null;
      let avmLow = null;
      let avmHigh = null;

      try {
        const zillowDetail = await snowflake.getPropertyByAddress(
          address.split(',')[0]?.trim(),
          address.split(',')[1]?.trim(),
          address.split(',')[2]?.trim()?.split(/\s+/)[0]
        );
        if (zillowDetail?.ZESTIMATE && zillowDetail.ZESTIMATE > 0) {
          avmValue = zillowDetail.ZESTIMATE;
          avmSource = 'zillow_zestimate';
        }
      } catch (zErr) {
        console.warn('[UpliftIsolation] Zestimate lookup failed:', zErr.message);
      }

      // Fall back to ATTOM AVM if Zestimate unavailable (single endpoint — 1 API call)
      if (!avmValue) {
        try {
          const attomAvm = await fetchAttomAVM({ address });
          if (attomAvm?.value) {
            avmValue = attomAvm.value;
            avmSource = 'attom_avm';
            avmLow = attomAvm.low || null;
            avmHigh = attomAvm.high || null;
          }
        } catch (aErr) {
          console.warn('[UpliftIsolation] ATTOM AVM fallback failed:', aErr.message);
        }
      }

      if (avmValue && avmValue > 0) {
        const avmToSaleRatio = beforeSalePrice / avmValue;
        signals.attomAVM = {
          avmValue: Math.round(avmValue),
          salePrice: beforeSalePrice,
          ratio: Math.round(avmToSaleRatio * 1000) / 1000,
          avmLow,
          avmHigh,
          source: avmSource
        };
        
        // If sale price is >12% below AVM/Zestimate, strong mispricing signal
        if (avmToSaleRatio < 0.88) {
          const avmGap = avmValue - beforeSalePrice;
          const avmMispricing = avmGap * 0.35;
          totalMispricingEstimate += avmMispricing;
          strongSignals++;
          signals.attomAVM.mispricing = Math.round(avmMispricing);
          signals.attomAVM.flag = 'significantly_below_avm';
        } else if (avmToSaleRatio < 0.94) {
          const avmGap = avmValue - beforeSalePrice;
          const avmMispricing = avmGap * 0.20;
          totalMispricingEstimate += avmMispricing;
          signals.attomAVM.mispricing = Math.round(avmMispricing);
          signals.attomAVM.flag = 'moderately_below_avm';
        } else {
          signals.attomAVM.flag = 'normal';
        }
        signalCount++;
        console.log(`[UpliftIsolation] AVM (${avmSource}): $${Math.round(avmValue)} vs sale $${beforeSalePrice} (ratio=${avmToSaleRatio.toFixed(3)})`);
      }
    } catch (err) {
      console.warn('[UpliftIsolation] Could not fetch AVM for mispricing signal:', err.message);
    }
  }
  
  // ---- Aggregate: Sum signals and apply confidence weighting ----
  // Each signal measures a different mispricing dimension (listing gap, speed, comp gap).
  // We sum them (since they're already individually conservative) then apply a confidence
  // discount based on how many signals agree.
  let finalMispricing = 0;
  let confidence = 'low';
  
  if (signalCount === 0) {
    finalMispricing = 0;
    confidence = 'none';
  } else if (strongSignals >= 2) {
    // Multiple strong signals agree — use sum of individual estimates (already conservative)
    finalMispricing = totalMispricingEstimate;
    confidence = 'high';
  } else if (strongSignals === 1) {
    // One strong signal — use sum but discount by 30%
    finalMispricing = totalMispricingEstimate * 0.7;
    confidence = 'medium';
  } else {
    // Only weak signals — use sum but discount by 50%
    finalMispricing = totalMispricingEstimate * 0.5;
    confidence = 'low';
  }
  
  // Hard cap: mispricing can't exceed 20% of sale price (beyond that it's not mispricing,
  // it's a fundamentally different property situation)
  const maxMispricing = beforeSalePrice * 0.20;
  finalMispricing = Math.min(finalMispricing, maxMispricing);
  
  const mispricingPercent = beforeSalePrice > 0 ? (finalMispricing / beforeSalePrice) * 100 : 0;
  
  console.log(`[UpliftIsolation] Pricing inefficiency: $${Math.round(finalMispricing)} (${mispricingPercent.toFixed(1)}%) - confidence: ${confidence}, signals: ${signalCount}, strong: ${strongSignals}`);
  
  return {
    mispricingAmount: Math.round(finalMispricing),
    mispricingPercent: Math.round(mispricingPercent * 100) / 100,
    confidence,
    signals,
    signalCount,
    strongSignals
  };
}


// ============================================================================
// 2b. SEASONAL SALE PRICE ADJUSTMENT
// ============================================================================

/**
 * Seasonal price index by month (January = index 0).
 * Spring/summer sales command 3-8% premiums over fall/winter on average.
 * Based on NAR / CoreLogic seasonal research. Index of 1.0 = annual average.
 */
const SEASONAL_PRICE_INDEX = [
  0.965,  // January   — winter trough
  0.972,  // February  — early spring buyers emerging
  0.995,  // March     — spring market starts
  1.020,  // April     — strong spring market
  1.040,  // May       — peak season begins
  1.048,  // June      — peak season
  1.038,  // July      — still strong, slight cool-off
  1.022,  // August    — back-to-school slowdown
  0.998,  // September — fall transition
  0.978,  // October   — cooling market
  0.960,  // November  — pre-holiday lull
  0.955,  // December  — holiday trough
];

/**
 * Calculate the seasonal adjustment between two sale dates.
 * If "before" sold in winter and "after" sold in summer, part of the
 * price increase is seasonal, not renovation-driven.
 * 
 * @param {Date} beforeDate
 * @param {Date} afterDate
 * @param {number} beforeSalePrice
 * @returns {{ seasonalAdjustment: number, beforeIndex: number, afterIndex: number, adjustmentPercent: number }}
 */
function calculateSeasonalAdjustment(beforeDate, afterDate, beforeSalePrice) {
  const before = new Date(beforeDate);
  const after = new Date(afterDate);
  
  const beforeIndex = SEASONAL_PRICE_INDEX[before.getMonth()];
  const afterIndex = SEASONAL_PRICE_INDEX[after.getMonth()];
  
  // If after-sale month has a higher seasonal index, the price was seasonally
  // inflated relative to the before-sale. We subtract this seasonal premium.
  // Conversely, if before-sale was in summer and after in winter, this is
  // negative (seasonal headwind) and we'd add back, revealing more true uplift.
  const seasonalRatio = (afterIndex / beforeIndex) - 1;
  const seasonalAdjustment = beforeSalePrice * seasonalRatio;
  
  return {
    seasonalAdjustment: Math.round(seasonalAdjustment),
    adjustmentPercent: Math.round(seasonalRatio * 10000) / 100,
    beforeMonth: before.getMonth(),
    afterMonth: after.getMonth(),
    beforeIndex,
    afterIndex
  };
}


// ============================================================================
// 3. RENOVATION UPLIFT ALLOCATION
// ============================================================================

/**
 * Industry-standard relative value contribution weights.
 * These represent how much of total value uplift each renovation type
 * typically contributes, independent of cost. Used as priors when
 * allocating total uplift across multiple detected renovations.
 */
const VALUE_CONTRIBUTION_WEIGHTS = {
  'kitchen':              1.00,   // Highest impact — the benchmark
  'kitchen_full':         1.00,   // Alias for kitchen (full remodel)
  'kitchen_cosmetic':     0.60,   // Alias for kitchen (cosmetic refresh)
  'bathroom_master':      0.70,
  'bathroom_secondary':   0.45,
  'bathroom_full':        0.70,   // Alias for bathroom (full remodel)
  'bathroom_cosmetic':    0.40,   // Alias for bathroom (cosmetic)
  'basement':             0.65,
  'basement_finish':      0.65,   // Alias for basement
  'flooring':             0.50,
  'paint_interior':       0.25,
  'paint_exterior':       0.35,
  'roof':                 0.40,   // Necessary but hidden value
  'windows':              0.40,
  'doors':                0.20,
  'siding':               0.45,
  'landscaping':          0.30,
  'driveway':             0.20,
  'hvac':                 0.30,
  'electrical':           0.20,
  'plumbing':             0.20,
  'attic':                0.35,
  'garage':               0.35,
  'deck_patio':           0.40,
  'pool':                 0.45,
  'addition':             0.75,
  'solar':                0.30,
  'smart_home':           0.15,
  'accessibility':        0.15,
  'other':                0.25
};

/**
 * Scope multipliers — a gut reno contributes more uplift than a cosmetic refresh
 */
const SCOPE_MULTIPLIERS = {
  'cosmetic':     0.4,
  'refresh':      1.0,
  'full_remodel': 2.2,
  'gut_reno':     3.5
};

/**
 * Maximum realistic uplift per renovation category and scope.
 * These are absolute dollar caps derived from industry data (NAR, Remodeling Magazine
 * Cost vs. Value 2024-2025) for median-priced US homes ($350-400K).
 * Prevents proportional allocation from assigning e.g. $60K uplift to an interior paint job.
 *
 * When the property value is known, these caps are scaled proportionally:
 *   cap = base_cap × (propertyValue / 375000)
 */
const CATEGORY_UPLIFT_CAPS = {
  // Major structural / high-impact
  'kitchen':              { cosmetic: 25000, refresh: 50000, full_remodel: 85000, gut_reno: 120000 },
  'kitchen_full':         { cosmetic: 25000, refresh: 50000, full_remodel: 85000, gut_reno: 120000 },
  'kitchen_cosmetic':     { cosmetic: 15000, refresh: 25000, full_remodel: 40000, gut_reno: 50000 },
  'bathroom_master':      { cosmetic: 12000, refresh: 25000, full_remodel: 45000, gut_reno: 60000 },
  'bathroom_secondary':   { cosmetic: 8000,  refresh: 15000, full_remodel: 25000, gut_reno: 35000 },
  'bathroom_full':        { cosmetic: 12000, refresh: 25000, full_remodel: 45000, gut_reno: 60000 },
  'bathroom_cosmetic':    { cosmetic: 8000,  refresh: 12000, full_remodel: 20000, gut_reno: 25000 },
  'basement':             { cosmetic: 10000, refresh: 25000, full_remodel: 50000, gut_reno: 70000 },
  'basement_finish':      { cosmetic: 10000, refresh: 25000, full_remodel: 50000, gut_reno: 70000 },
  'addition':             { cosmetic: 30000, refresh: 60000, full_remodel: 100000, gut_reno: 150000 },

  // Moderate impact
  'flooring':             { cosmetic: 8000,  refresh: 18000, full_remodel: 30000, gut_reno: 40000 },
  'windows':              { cosmetic: 5000,  refresh: 12000, full_remodel: 20000, gut_reno: 30000 },
  'roof':                 { cosmetic: 5000,  refresh: 12000, full_remodel: 20000, gut_reno: 25000 },
  'siding':               { cosmetic: 5000,  refresh: 12000, full_remodel: 20000, gut_reno: 25000 },
  'deck_patio':           { cosmetic: 5000,  refresh: 12000, full_remodel: 25000, gut_reno: 35000 },
  'pool':                 { cosmetic: 5000,  refresh: 15000, full_remodel: 30000, gut_reno: 50000 },
  'garage':               { cosmetic: 5000,  refresh: 12000, full_remodel: 20000, gut_reno: 30000 },

  // Cosmetic / low-max-impact
  'paint_interior':       { cosmetic: 5000,  refresh: 10000, full_remodel: 18000, gut_reno: 25000 },
  'paint_exterior':       { cosmetic: 5000,  refresh: 12000, full_remodel: 20000, gut_reno: 30000 },
  'landscaping':          { cosmetic: 5000,  refresh: 12000, full_remodel: 20000, gut_reno: 30000 },
  'hvac':                 { cosmetic: 3000,  refresh: 8000,  full_remodel: 15000, gut_reno: 20000 },
  'electrical':           { cosmetic: 2000,  refresh: 6000,  full_remodel: 12000, gut_reno: 15000 },
  'plumbing':             { cosmetic: 2000,  refresh: 6000,  full_remodel: 12000, gut_reno: 15000 },
  'smart_home':           { cosmetic: 2000,  refresh: 5000,  full_remodel: 8000,  gut_reno: 10000 },
  'driveway':             { cosmetic: 2000,  refresh: 5000,  full_remodel: 10000, gut_reno: 12000 },
  'doors':                { cosmetic: 2000,  refresh: 5000,  full_remodel: 8000,  gut_reno: 10000 },
  'accessibility':        { cosmetic: 2000,  refresh: 5000,  full_remodel: 8000,  gut_reno: 10000 },
  'solar':                { cosmetic: 5000,  refresh: 10000, full_remodel: 20000, gut_reno: 25000 },
  'attic':                { cosmetic: 5000,  refresh: 10000, full_remodel: 20000, gut_reno: 30000 },
  'other':                { cosmetic: 5000,  refresh: 10000, full_remodel: 20000, gut_reno: 30000 },
};

/**
 * Consensus-based expected value uplift per renovation category and scope.
 * Derived from NAR Remodeling Impact Report 2024, Remodeling Magazine Cost vs. Value 2024-2025,
 * and Zillow renovation value surveys. Values are for a ~$375K median-priced US home.
 *
 * These serve as Bayesian priors and are blended with comp-derived uplift data.
 * When propertyValue differs from $375K, values scale by pvScale (propertyValue / 375000).
 */
const CONSENSUS_UPLIFT = {
  // Major structural / high-impact
  'kitchen':              { cosmetic: 12000, refresh: 25000, full_remodel: 45000, gut_reno: 70000 },
  'kitchen_full':         { cosmetic: 12000, refresh: 25000, full_remodel: 45000, gut_reno: 70000 },
  'kitchen_cosmetic':     { cosmetic: 8000,  refresh: 15000, full_remodel: 25000, gut_reno: 35000 },
  'bathroom_master':      { cosmetic: 6000,  refresh: 14000, full_remodel: 25000, gut_reno: 35000 },
  'bathroom_secondary':   { cosmetic: 3500,  refresh: 8000,  full_remodel: 15000, gut_reno: 20000 },
  'bathroom_full':        { cosmetic: 6000,  refresh: 14000, full_remodel: 25000, gut_reno: 35000 },
  'bathroom_cosmetic':    { cosmetic: 3500,  refresh: 7000,  full_remodel: 12000, gut_reno: 16000 },
  'basement':             { cosmetic: 5000,  refresh: 15000, full_remodel: 30000, gut_reno: 45000 },
  'basement_finish':      { cosmetic: 5000,  refresh: 15000, full_remodel: 30000, gut_reno: 45000 },
  'addition':             { cosmetic: 20000, refresh: 40000, full_remodel: 70000, gut_reno: 100000 },

  // Moderate impact
  'flooring':             { cosmetic: 4000,  refresh: 10000, full_remodel: 18000, gut_reno: 25000 },
  'windows':              { cosmetic: 3000,  refresh: 8000,  full_remodel: 15000, gut_reno: 20000 },
  'roof':                 { cosmetic: 3000,  refresh: 8000,  full_remodel: 15000, gut_reno: 18000 },
  'siding':               { cosmetic: 3000,  refresh: 8000,  full_remodel: 14000, gut_reno: 18000 },
  'deck_patio':           { cosmetic: 3000,  refresh: 8000,  full_remodel: 16000, gut_reno: 22000 },
  'pool':                 { cosmetic: 3000,  refresh: 10000, full_remodel: 20000, gut_reno: 35000 },
  'garage':               { cosmetic: 3000,  refresh: 8000,  full_remodel: 14000, gut_reno: 20000 },

  // Cosmetic / low-max-impact
  'paint_interior':       { cosmetic: 2000,  refresh: 5000,  full_remodel: 8000,  gut_reno: 12000 },
  'paint_exterior':       { cosmetic: 2500,  refresh: 7000,  full_remodel: 12000, gut_reno: 18000 },
  'landscaping':          { cosmetic: 2500,  refresh: 7000,  full_remodel: 12000, gut_reno: 18000 },
  'hvac':                 { cosmetic: 2000,  refresh: 5000,  full_remodel: 10000, gut_reno: 14000 },
  'electrical':           { cosmetic: 1500,  refresh: 4000,  full_remodel: 8000,  gut_reno: 10000 },
  'plumbing':             { cosmetic: 1500,  refresh: 4000,  full_remodel: 8000,  gut_reno: 10000 },
  'smart_home':           { cosmetic: 1000,  refresh: 3000,  full_remodel: 5000,  gut_reno: 7000 },
  'driveway':             { cosmetic: 1500,  refresh: 3000,  full_remodel: 6000,  gut_reno: 8000 },
  'doors':                { cosmetic: 1500,  refresh: 3000,  full_remodel: 5000,  gut_reno: 7000 },
  'accessibility':        { cosmetic: 1000,  refresh: 3000,  full_remodel: 5000,  gut_reno: 7000 },
  'solar':                { cosmetic: 3000,  refresh: 7000,  full_remodel: 14000, gut_reno: 18000 },
  'attic':                { cosmetic: 3000,  refresh: 7000,  full_remodel: 14000, gut_reno: 20000 },
  'other':                { cosmetic: 2000,  refresh: 5000,  full_remodel: 10000, gut_reno: 15000 },
};

/**
 * Allocate the total renovation-attributed value uplift across individual renovations
 * using a Bayesian-blend of comp-derived uplift and consensus industry data.
 *
 * For each renovation category:
 *   consensusUplift = CONSENSUS_UPLIFT[cat][scope] × pvScale
 *   compUplift      = proportional share of totalUplift (by category weight × scope × confidence × area)
 *   finalUplift     = compWeight × compUplift + (1 - compWeight) × consensusUplift
 *
 * compWeight is quality-dependent: ZHVI appreciation → higher comp trust (65%),
 * regional fallback → lower comp trust (35%). Short holding periods add trust,
 * long ones reduce it. Per-renovation confidence further modulates the blend.
 *
 * @param {number} totalUplift - Total renovation-attributed value increase ($)
 * @param {Array} renovations - Detected renovations from photo comparison
 * @param {number} propertyValue - Property value for pvScale (default 0 → scale=1)
 * @param {Object} qualityMeta - Quality signals for blend weighting
 * @param {string} qualityMeta.appreciationSource - 'zhvi' | 'regional' | 'fallback' | 'unknown'
 * @param {number} qualityMeta.holdingYears - Years between before and after sale
 * @returns {Array} - Renovations with allocated uplift amounts
 */
export function allocateUpliftAcrossRenovations(totalUplift, renovations, propertyValue = 0, qualityMeta = {}) {
  if (!renovations || renovations.length === 0) {
    return [];
  }
  
  // Property-value scaling factor: consensus values are baselined to a ~$375K home.
  const pvScale = propertyValue > 0 ? Math.max(0.5, Math.min(3.0, propertyValue / 375000)) : 1.0;

  // ── Quality-dependent blend weight ──
  // Determines how much to trust comp-derived uplift vs consensus.
  const { appreciationSource = 'unknown', holdingYears = 3 } = qualityMeta;
  
  let baseCompWeight = 0.50;
  
  // Appreciation source quality
  if (appreciationSource === 'zhvi') {
    baseCompWeight += 0.15;  // ZHVI is reliable — trust comp data more
  } else if (appreciationSource === 'regional' || appreciationSource === 'fallback') {
    baseCompWeight -= 0.15;  // Regional is a rough estimate — lean on consensus
  }
  
  // Shorter holding = less noise from appreciation estimation
  if (holdingYears <= 2) {
    baseCompWeight += 0.10;
  } else if (holdingYears >= 5) {
    baseCompWeight -= 0.10;
  }
  
  // Zero/negative uplift from comp → 100% consensus (no comp signal)
  if (totalUplift <= 0) {
    baseCompWeight = 0;
  }
  
  baseCompWeight = Math.max(0.0, Math.min(0.80, baseCompWeight));
  
  console.log(`[UpliftAlloc] Blend: comp=${(baseCompWeight * 100).toFixed(0)}% consensus=${((1 - baseCompWeight) * 100).toFixed(0)}% (src=${appreciationSource}, hold=${holdingYears?.toFixed(1)}yr, pvScale=${pvScale.toFixed(2)})`);

  // Helper: get consensus uplift for a category+scope, scaled by property value
  function getConsensusUplift(category, scope) {
    const catData = CONSENSUS_UPLIFT[category] || CONSENSUS_UPLIFT['other'];
    const baseUplift = catData[scope] || catData['refresh'] || 5000;
    return Math.round(baseUplift * pvScale);
  }

  // Sanity cap: 2.5× consensus value — absolute ceiling to catch extreme outliers
  function getSanityCap(category, scope) {
    return Math.round(getConsensusUplift(category, scope) * 2.5);
  }
  
  // ── Single renovation: blend consensus + total comp uplift ──
  if (renovations.length === 1) {
    const reno = renovations[0];
    const consensusVal = getConsensusUplift(reno.category, reno.scope);
    const confidenceAdj = Math.max(0.3, Math.min(1.0, reno.confidence || 0.5));
    const compVal = totalUplift;
    
    // Per-reno confidence modulates blend: low confidence → lean consensus
    const effCompW = baseCompWeight * confidenceAdj;
    const blended = effCompW * compVal + (1 - effCompW) * consensusVal;
    const sanityCap = getSanityCap(reno.category, reno.scope);
    const final = Math.min(Math.max(0, blended), sanityCap);
    
    console.log(`[UpliftAlloc] Single "${reno.category}": comp=$${Math.round(compVal)} consensus=$${consensusVal} → blended=$${Math.round(final)} (compW=${(effCompW * 100).toFixed(0)}%)`);
    
    return [{
      ...reno,
      allocatedUplift: Math.round(final),
      upliftPercent: 100,
      allocationWeight: 1.0,
      compDerivedUplift: Math.round(compVal),
      consensusUplift: consensusVal,
      blendCompWeight: Math.round(effCompW * 100) / 100,
      upliftCapped: final >= sanityCap,
    }];
  }
  
  // ── Multiple renovations ──
  // Step 1: Compute proportional weight for comp-derived allocation
  const weighted = renovations.map(reno => {
    const categoryWeight = VALUE_CONTRIBUTION_WEIGHTS[reno.category] || 0.25;
    const scopeMultiplier = SCOPE_MULTIPLIERS[reno.scope] || 1.0;
    const confidence = reno.confidence || 0.5;
    const area = reno.estimatedAreaSqFt || estimateAreaFromScope(
      reno.category, reno.scope,
      reno.propertySqft || 0,
      reno.propertyBeds || 0,
      reno.propertyBaths || 0
    );
    const areaWeight = Math.log10(Math.max(area, 30));
    const rawWeight = categoryWeight * scopeMultiplier * confidence * areaWeight;
    const consensusVal = getConsensusUplift(reno.category, reno.scope);
    const sanityCap = getSanityCap(reno.category, reno.scope);
    
    return { ...reno, rawWeight, categoryWeight, scopeMultiplier, areaUsed: area, consensusVal, sanityCap };
  });
  
  // Step 2: Proportional allocation of total comp uplift
  const totalWeight = weighted.reduce((sum, r) => sum + r.rawWeight, 0);
  const allocated = weighted.map(reno => {
    const normalizedWeight = totalWeight > 0 ? reno.rawWeight / totalWeight : 1 / weighted.length;
    const compAllocation = totalUplift * normalizedWeight;
    return { ...reno, normalizedWeight, compAllocation };
  });
  
  // Step 3: Blend comp allocation with consensus for each renovation
  const results = allocated.map(reno => {
    const confidenceAdj = Math.max(0.3, Math.min(1.0, reno.confidence || 0.5));
    const effCompW = baseCompWeight * confidenceAdj;
    
    const blended = effCompW * reno.compAllocation + (1 - effCompW) * reno.consensusVal;
    const final = Math.min(Math.max(0, blended), reno.sanityCap);
    
    return { ...reno, blendedUplift: blended, finalUplift: final, effCompW, capped: final >= reno.sanityCap };
  });
  
  // Log blend details
  console.log(`[UpliftAlloc] ${results.length} renovations blended:`);
  results.forEach(r => {
    console.log(`  ${r.category}(${r.scope}): comp=$${Math.round(r.compAllocation)} consensus=$${r.consensusVal} → $${Math.round(r.finalUplift)} (compW=${(r.effCompW * 100).toFixed(0)}%)${r.capped ? ' CAPPED' : ''}`);
  });
  
  return results.map(reno => ({
    category: reno.category,
    scope: reno.scope,
    description: reno.description,
    confidence: reno.confidence,
    estimatedCost: reno.estimatedCost,
    costRange: reno.costRange,
    qualityLevel: reno.qualityLevel,
    beforeDescription: reno.beforeDescription,
    afterDescription: reno.afterDescription,
    materials: reno.materials || [],
    affectedRooms: reno.affectedRooms || [],
    estimatedAreaSqFt: reno.estimatedAreaSqFt || reno.areaUsed || 0,
    // Allocation results — blended comp + consensus
    allocatedUplift: Math.round(reno.finalUplift),
    upliftPercent: Math.round(reno.normalizedWeight * 100),
    allocationWeight: Math.round(reno.normalizedWeight * 1000) / 1000,
    compDerivedUplift: Math.round(reno.compAllocation),
    consensusUplift: reno.consensusVal,
    blendCompWeight: Math.round(reno.effCompW * 100) / 100,
    upliftCapped: !!reno.capped,
    // Per-renovation ROI: null because comp costs are fabricated.
    // Real ROI is computed on the subject property using measured/template costs.
    valueROI: null
  }));
}

function estimateCostFromScope(scope) {
  switch (scope) {
    case 'cosmetic': return 5000;
    case 'refresh': return 15000;
    case 'full_remodel': return 45000;
    case 'gut_reno': return 100000;
    default: return 15000;
  }
}

/**
 * Estimate affected area (sqft) based on renovation category, scope, and
 * actual property characteristics.  When the comp's sqft / beds / baths are
 * available we scale the area to reflect the real property instead of using a
 * one-size-fits-all constant.
 *
 * Reference home = 1,800 sqft, 3 bed / 2 bath (the implied "average" behind
 * the old hardcoded base areas).  Actual comp data shifts the estimate
 * proportionally.
 */
function estimateAreaFromScope(category, scope, propertySqft, beds, baths) {
  // ── Reference house the base areas assume ──
  const REF_SQFT  = 1800;
  const REF_BEDS  = 3;
  const REF_BATHS = 2;

  // Base area by category (typical room sqft for a 1,800 sqft 3/2 home)
  const BASE_AREA = {
    kitchen: 150,
    bathroom_master: 80,
    bathroom_secondary: 50,
    bathroom: 70,          // consolidated canonical category
    flooring: 800,         // multiple rooms
    paint_interior: 1200,  // whole house
    paint_exterior: 1500,  // exterior surface area
    roof: 1500,
    windows: 200,          // aggregate window area
    doors: 50,
    siding: 1200,
    landscaping: 2000,
    driveway: 400,
    hvac: 100,             // equipment footprint
    electrical: 100,
    plumbing: 60,
    basement: 600,
    attic: 400,
    garage: 400,
    deck_patio: 250,
    pool: 500,
    other: 150,
  };

  // Scope multiplier: cosmetic touches less area than gut reno
  const SCOPE_AREA_MULT = {
    cosmetic: 0.5,
    refresh: 1.0,
    full_remodel: 1.2,
    gut_reno: 1.5,
  };

  const base = BASE_AREA[category] || 150;
  const mult = SCOPE_AREA_MULT[scope] || 1.0;

  // ── Property-specific scaling ──
  // Choose the most relevant scalar for the category.
  //   • Whole-house types (paint, flooring, roof, siding, etc.): scale by sqft
  //   • Bathroom: scale by bath count
  //   • Kitchen: scale gently by total sqft (bigger house → bigger kitchen)
  //   • Else: scale by sqft
  let propertyScale = 1.0;
  const sqft  = propertySqft && propertySqft > 0 ? propertySqft : 0;
  const nBeds  = beds  && beds  > 0 ? beds  : 0;
  const nBaths = baths && baths > 0 ? baths : 0;

  const WHOLE_HOUSE = /paint|flooring|roof|siding|electrical|plumbing|hvac|windows|doors/;
  const BATHROOM    = /bathroom/;
  const KITCHEN     = /kitchen/;

  if (WHOLE_HOUSE.test(category) && sqft > 0) {
    // Linear scale by total sqft.  A 2,700 sqft home has ~1.5× the
    // paint/flooring area of a 1,800 sqft reference home.
    propertyScale = sqft / REF_SQFT;
  } else if (BATHROOM.test(category) && nBaths > 0) {
    // More bathrooms → larger total bathroom area.
    // Dampen a bit (sqrt) because multiple bathrooms avg smaller per unit.
    propertyScale = Math.sqrt(nBaths / REF_BATHS);
  } else if (KITCHEN.test(category) && sqft > 0) {
    // Kitchen grows sublinearly with house size — sqrt scaling.
    propertyScale = Math.sqrt(sqft / REF_SQFT);
  } else if (sqft > 0) {
    // Generic fallback: gentle sqft scaling
    propertyScale = Math.sqrt(sqft / REF_SQFT);
  }

  // Clamp so a 600 sqft condo doesn't zero-out and a 6,000 sqft
  // mansion doesn't completely dominate the weight.
  propertyScale = Math.max(0.4, Math.min(propertyScale, 2.5));

  return Math.round(base * mult * propertyScale);
}


// ============================================================================
// 4. FULL UPLIFT ISOLATION PIPELINE
// ============================================================================

/**
 * Run the complete uplift isolation pipeline on a single before/after property pair.
 * 
 * @param {Object} propertyPair - From Snowflake findRenovationCandidates
 * @param {Array} detectedRenovations - From photo comparison service
 * @returns {Object} - Complete uplift analysis with per-renovation allocations
 */
export async function isolateRenovationUplift({
  // Property info
  address,
  zipCode,
  state,
  propertyType,
  sqft,
  beds,
  baths,
  yearBuilt,
  // Before sale
  beforeSalePrice,
  beforeListPrice,
  beforeDate,
  beforeDaysOnMarket,
  // After sale
  afterSalePrice,
  afterListPrice,
  afterDate,
  afterDaysOnMarket,
  // Detected renovations
  renovations,
  // Optional: rent data
  rentBefore,
  rentAfter
}) {
  console.log(`[UpliftIsolation] Analyzing: ${address}`);
  console.log(`[UpliftIsolation] Before: $${beforeSalePrice} (${new Date(beforeDate).toLocaleDateString()}) → After: $${afterSalePrice} (${new Date(afterDate).toLocaleDateString()})`);
  
  // Raw price increase
  const rawPriceIncrease = afterSalePrice - beforeSalePrice;
  const rawPriceIncreasePercent = (rawPriceIncrease / beforeSalePrice) * 100;
  
  // Step 1: Subtract market appreciation
  const appreciation = await calculateMarketAppreciation({
    zipCode,
    state,
    propertyType,
    beforeDate,
    afterDate,
    beforePrice: beforeSalePrice
  });
  
  console.log(`[UpliftIsolation] Market appreciation: $${appreciation.appreciationAmount} (${appreciation.appreciationPercent}%) via ${appreciation.source}`);
  
  // Step 2: Detect pricing inefficiency
  const mispricing = await detectPricingInefficiency({
    beforeSalePrice,
    beforeListPrice,
    beforeDaysOnMarket,
    beforeDate,
    zipCode,
    state,
    sqft,
    propertyType,
    beds,
    baths,
    yearBuilt,
    address
  });
  
  console.log(`[UpliftIsolation] Pricing inefficiency: $${mispricing.mispricingAmount} (${mispricing.mispricingPercent}%) confidence: ${mispricing.confidence}`);
  
  // Step 2b: Seasonal sale price adjustment
  // If the "after" sale happened in a peak season (spring/summer) and the
  // "before" sale in an off-season (fall/winter), some of the price difference
  // is seasonal, not renovation-driven. We subtract this out.
  const seasonal = calculateSeasonalAdjustment(beforeDate, afterDate, beforeSalePrice);
  
  if (seasonal.seasonalAdjustment !== 0) {
    console.log(`[UpliftIsolation] Seasonal adjustment: $${seasonal.seasonalAdjustment} (${seasonal.adjustmentPercent}%) — before month ${seasonal.beforeMonth + 1} (idx ${seasonal.beforeIndex}) → after month ${seasonal.afterMonth + 1} (idx ${seasonal.afterIndex})`);
  }
  
  // Step 3: Calculate renovation-attributed uplift
  let renovationUplift = rawPriceIncrease - appreciation.appreciationAmount - mispricing.mispricingAmount - seasonal.seasonalAdjustment;
  
  // Floor at 0 — if market + mispricing explains everything, renovation uplift is 0
  if (renovationUplift < 0) {
    console.log(`[UpliftIsolation] Renovation uplift negative ($${renovationUplift}), flooring at 0`);
    renovationUplift = 0;
  }
  
  console.log(`[UpliftIsolation] Renovation-attributed uplift: $${renovationUplift}`);
  console.log(`[UpliftIsolation]   Raw: $${rawPriceIncrease} - Market: $${appreciation.appreciationAmount} - Mispricing: $${mispricing.mispricingAmount} - Seasonal: $${seasonal.seasonalAdjustment} = $${renovationUplift}`);
  
  // Step 3b: Tax assessment validation REMOVED from comp pipeline.
  // Previously called fetchPropertyDashboard (19 ATTOM API calls) per comp just to
  // get tax history for a marginal 0.75-1.0× adjustment. The consensus+comp blend
  // in Fix 4 already handles accuracy. Tax validation remains available for the
  // subject property dashboard where fetchPropertyDashboard is already called.
  const taxValidation = null;
  
  // Step 4: Total renovation cost — no longer computed from fabricated comp costs.
  // Real cost estimation lives in improved-cost-estimator.js for the subject property.
  const totalRenovationCost = 0;
  
  // Step 5: Allocate uplift across individual renovations
  // Blend comp-derived uplift with consensus industry data, weighted by data quality
  const holdingYears = (new Date(afterDate).getTime() - new Date(beforeDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  const allocatedRenovations = allocateUpliftAcrossRenovations(renovationUplift, renovations, beforeSalePrice, {
    appreciationSource: appreciation.source,
    holdingYears,
  });
  
  // Step 6: Overall value ROI — not computed here (comp costs are fabricated).
  // Real ROI is computed on the subject property with real cost estimates.
  const overallValueROI = null;
  
  // Step 7: Rent uplift (if rental data available)
  // IMPORTANT: Subtract natural rent inflation to isolate renovation-attributed rent increase.
  // Without this, we'd be crediting general market rent growth to the renovations.
  let rentAnalysis = null;
  if (rentBefore && rentAfter && rentBefore > 0) {
    const rawRentIncrease = rentAfter - rentBefore;
    
    // Estimate natural rent inflation over the holding period.
    // National avg rent inflation ~3-5%/year; use market appreciation % as proxy
    // (rent growth tracks value growth, usually at 60-80% of the pace).
    const holdingYears = Math.max(
      (new Date(afterDate).getTime() - new Date(beforeDate).getTime()) / (1000 * 60 * 60 * 24 * 365),
      0.25
    );
    const annualRentInflation = Math.min(appreciation.appreciationPercent / Math.max(holdingYears, 0.5), 8) * 0.65;
    const naturalRentIncrease = rentBefore * (annualRentInflation / 100) * holdingYears;
    
    // Renovation-attributed rent increase = raw increase minus natural inflation
    const renovationRentIncrease = Math.max(0, rawRentIncrease - naturalRentIncrease);
    
    const rentIncreasePercent = (renovationRentIncrease / rentBefore) * 100;
    const annualRentIncrease = renovationRentIncrease * 12;
    // rentROI and paybackMonths omitted — they relied on fabricated comp costs.
    // These are computed at the subject-property level with real cost estimates.
    const rentROI = null;
    const paybackMonths = null;
    
    rentAnalysis = {
      rentBefore,
      rentAfter,
      rawRentIncrease: Math.round(rawRentIncrease),
      naturalRentInflation: Math.round(naturalRentIncrease),
      rentIncrease: Math.round(renovationRentIncrease),
      rentIncreasePercent: Math.round(rentIncreasePercent * 10) / 10,
      annualRentIncrease: Math.round(annualRentIncrease),
      rentROI,
      paybackMonths
    };
  }
  
  // Step 8: Confidence scoring
  const confidence = calculateUpliftConfidence({
    renovationCount: renovations.length,
    avgRenoConfidence: renovations.reduce((s, r) => s + (r.confidence || 0), 0) / Math.max(renovations.length, 1),
    rawPriceIncreasePercent,
    overallValueROI,
    appreciationSource: appreciation.source,
    mispricingConfidence: mispricing.confidence,
    mispricingPercent: mispricing.mispricingPercent,
    hasRentData: !!rentAnalysis,
    taxValidationLevel: taxValidation?.validationLevel || null,
    hasSeasonalAdjustment: seasonal.seasonalAdjustment !== 0
  });
  
  const holdingMonths = Math.round(
    (new Date(afterDate).getTime() - new Date(beforeDate).getTime()) / (1000 * 60 * 60 * 24 * 30)
  );
  
  return {
    // Property
    address,
    zipCode,
    state,
    propertyType,
    sqft,
    beds,
    baths,
    yearBuilt,
    holdingMonths,
    
    // Raw numbers
    beforeSalePrice,
    afterSalePrice,
    rawPriceIncrease,
    rawPriceIncreasePercent: Math.round(rawPriceIncreasePercent * 100) / 100,
    
    // Subtractions
    marketAppreciation: appreciation,
    pricingInefficiency: mispricing,
    seasonalAdjustment: seasonal,
    taxValidation,
    
    // Result: renovation uplift
    renovationAttributedUplift: Math.round(renovationUplift),
    totalRenovationCost: null, // No longer computed from fabricated comp costs
    overallValueROI: null,     // Computed at subject-property level with real cost estimates
    
    // Per-renovation breakdown
    renovationBreakdown: allocatedRenovations,
    
    // Rent analysis
    rentAnalysis,
    
    // Quality
    confidence,
    
    // Metadata
    analyzedAt: new Date(),
    version: '2.0'
  };
}


/**
 * Confidence scoring for the uplift isolation result
 */
function calculateUpliftConfidence({
  renovationCount,
  avgRenoConfidence,
  rawPriceIncreasePercent,
  overallValueROI,
  appreciationSource,
  mispricingConfidence,
  mispricingPercent,
  hasRentData,
  taxValidationLevel,
  hasSeasonalAdjustment
}) {
  let score = 40; // Base
  
  // Photo detection confidence
  score += avgRenoConfidence * 20; // Up to +20
  
  // Multiple renovations increase confidence
  if (renovationCount >= 2) score += 5;
  if (renovationCount >= 4) score += 3;
  
  // Reasonable price increase range
  if (rawPriceIncreasePercent >= 5 && rawPriceIncreasePercent <= 60) {
    score += 8;
  } else if (rawPriceIncreasePercent > 80) {
    score -= 10; // Suspiciously high
  }
  
  // Reasonable ROI range (skip if no comp cost data available)
  if (overallValueROI != null && overallValueROI >= 40 && overallValueROI <= 300) {
    score += 8;
  } else if (overallValueROI != null && (overallValueROI > 500 || overallValueROI < 0)) {
    score -= 10;
  }
  
  // Better appreciation data = more confidence
  if (appreciationSource === 'zillow_zhvi') {
    score += 10; // ZHVI is a professional smoothed index
  } else if (appreciationSource === 'zillow_mls_median') {
    score += 8;
  } else {
    score += 3; // Fallback data
  }
  
  // Low mispricing = cleaner signal
  if (mispricingPercent < 3) {
    score += 5;
  } else if (mispricingPercent > 15) {
    score -= 5; // High mispricing makes uplift less reliable
  }
  
  // Rent data validates the result
  if (hasRentData) {
    score += 5;
  }
  
  // Tax assessment cross-validation
  if (taxValidationLevel === 'strong') {
    score += 8; // County assessor agrees — big confidence boost
  } else if (taxValidationLevel === 'moderate') {
    score += 3;
  } else if (taxValidationLevel === 'weak') {
    score -= 5; // County doesn't see improvements — concerning
  }
  
  // Seasonal adjustment was applied — pipeline is more thorough
  if (hasSeasonalAdjustment) {
    score += 2;
  }
  
  score = Math.max(0, Math.min(100, score));
  
  const level = score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low';
  
  return { score, level };
}

export default {
  calculateMarketAppreciation,
  detectPricingInefficiency,
  allocateUpliftAcrossRenovations,
  isolateRenovationUplift
};
