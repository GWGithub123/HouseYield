// Lightweight ATTOM Data API integration (JS port of provided Python utility)
// Exposes a single function fetchPropertyDashboard(address) returning normalized summary + tax history.
// Requires env ATTOM_API_KEY.
import 'dotenv/config';
import { getHistoricalMortgageRate, calculateMonthlyPayment } from './fred.js';
import { fetchMunicipalityPermits, parseAddress } from './municipality-permits.js';
import { getEnhancedWildfireRisk, getNASAActiveFires, getNASADroughtData } from './nasa-environmental.js';
import { fetchAttom } from './attom-usage-limiter.js';
import { estimatePropertyInsurancePremium } from './services/insurancePremiumEstimator.js';
import {
  getCachedAbsenteeSearch,
  setCachedAbsenteeSearch,
  getCachedProcessedLead,
  setCachedProcessedLead,
  hydrateCachedLeadsForRawProperties,
} from './services/absenteeSearchCacheService.js';

const ATTOM_API_KEY = process.env.ATTOM_API_KEY || '';
const BASE_V1 = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const HEADERS = { 'accept': 'application/json', 'apikey': ATTOM_API_KEY };
const TIMEOUT_MS = parseInt(process.env.ATTOM_TIMEOUT_SECONDS || '20000', 10);

/**
 * Calculate remaining mortgage balance using amortization formula
 */
function calculateRemainingBalance(originalAmount, annualRate, termMonths, loanDate) {
  if (!originalAmount || !annualRate || !termMonths || !loanDate) {
    return { remainingBalance: null, monthsElapsed: null, monthsRemaining: null };
  }

  const monthlyRate = annualRate / 100 / 12;
  const loanStart = new Date(loanDate);
  const now = new Date();
  
  // Calculate months elapsed since loan origination
  const monthsElapsed = Math.floor((now - loanStart) / (1000 * 60 * 60 * 24 * 30.44));
  
  if (monthsElapsed <= 0) {
    return { 
      remainingBalance: originalAmount, 
      monthsElapsed: 0, 
      monthsRemaining: termMonths,
      paymentsMade: 0,
      principalPaid: 0,
      percentPaid: 0
    };
  }

  if (monthsElapsed >= termMonths) {
    return { 
      remainingBalance: 0, 
      monthsElapsed: termMonths, 
      monthsRemaining: 0,
      paymentsMade: termMonths,
      principalPaid: originalAmount,
      percentPaid: 100
    };
  }

  // Amortization formula for remaining balance
  const onePlusR = 1 + monthlyRate;
  const powerN = Math.pow(onePlusR, termMonths);
  const powerP = Math.pow(onePlusR, monthsElapsed);
  
  const remainingBalance = originalAmount * ((powerN - powerP) / (powerN - 1));
  const monthsRemaining = termMonths - monthsElapsed;
  const principalPaid = originalAmount - remainingBalance;

  return {
    remainingBalance: Math.max(0, remainingBalance),
    monthsElapsed,
    monthsRemaining,
    paymentsMade: monthsElapsed,
    principalPaid,
    percentPaid: (principalPaid / originalAmount) * 100
  };
}

/**
 * Analyze mortgage assumability based on loan type and date
 */
async function analyzeMortgageAssumability(mortgage) {
  if (!mortgage) {
    return { assumable: 'unknown', confidence: 'none', reason: 'No mortgage data available' };
  }

  // Handle both normalized (from dashboard) and raw ATTOM field names
  const loanType = (mortgage.loan_type || mortgage.loanTypeCode || mortgage.loantypecode || '').toUpperCase();
  const loanDateStr = mortgage.date || mortgage.loanRecordingDate || mortgage.recordingdate;
  const loanDate = loanDateStr ? new Date(loanDateStr) : null;
  let estimatedRate = mortgage.estimated_interest_rate || mortgage.interestRate || mortgage.interestrate;
  const loanAmount = mortgage.amount || mortgage.loanAmount || mortgage.loanamount;
  // ATTOM uses 'term' in months (e.g., 360, 361)
  const termMonths = mortgage.term_months || mortgage.termMonths || mortgage.term || 360;
  
  // If no rate provided, estimate from historical FRED data based on loan date
  let rateEstimated = false;
  if (!estimatedRate && loanDateStr) {
    try {
      const historicalRate = await getHistoricalMortgageRate(loanDateStr);
      if (historicalRate && historicalRate > 0) {
        estimatedRate = historicalRate;
        rateEstimated = true;
        console.log('[Assumability] Estimated rate from FRED historical data:', estimatedRate, 'for date:', loanDateStr);
      }
    } catch (err) {
      console.log('[Assumability] Could not fetch historical rate:', err.message);
    }
  }
  
  console.log('[Assumability] Analyzing mortgage:', {
    loanType,
    loanDateStr,
    estimatedRate,
    rateEstimated,
    loanAmount,
    termMonths,
    rawLoantypecode: mortgage.loantypecode
  });
  
  // Calculate remaining balance
  const balanceInfo = calculateRemainingBalance(loanAmount, estimatedRate, termMonths, loanDateStr);
  
  let assumable = 'unknown';
  let confidence = 'low';
  let reason = '';
  let nextSteps = [];
  let attractiveness = 'unknown';

  // Analyze by loan type - ATTOM loan type codes:
  // FHA = FHA, VA = VA, USDA/RHS = USDA, CNV = Conventional, 
  // ARM = Adjustable Rate Mortgage (usually conventional), 
  // SCB = Seller Carryback, PMM = Purchase Money Mortgage
  if (loanType === 'FHA') {
    assumable = 'likely';
    confidence = 'high';
    reason = 'FHA loans are assumable by qualified buyers';
    nextSteps = ['Contact lender for assumption package', 'Buyer must qualify with FHA standards', 'Expect 45-90 day approval'];
  } else if (loanType === 'VA') {
    assumable = 'likely';
    confidence = 'high';
    reason = 'VA loans are assumable (buyer does not need to be veteran)';
    nextSteps = ['Contact lender for assumption package', 'Buyer must qualify with VA standards', 'Funding fee may apply'];
  } else if (loanType === 'USDA' || loanType === 'RHS') {
    assumable = 'likely';
    confidence = 'medium';
    reason = 'USDA loans are typically assumable';
    nextSteps = ['Verify buyer meets USDA income limits', 'Contact lender for assumption package'];
  } else if (loanType === 'CNV' || loanType === 'CONVENTIONAL' || loanType === 'ARM') {
    if (loanDate && loanDate < new Date('1982-10-15')) {
      assumable = 'possible';
      confidence = 'medium';
      reason = 'Pre-1982 conventional loan may be assumable';
      nextSteps = ['Review loan documents for due-on-sale clause', 'Most still have restrictions'];
    } else {
      assumable = 'unlikely';
      confidence = 'high';
      reason = loanType === 'ARM' 
        ? 'Adjustable rate mortgages are typically conventional and have due-on-sale clauses'
        : 'Conventional loans typically have due-on-sale clauses';
      nextSteps = ['Request loan documents to confirm', 'Consider conventional financing instead'];
    }
  } else if (loanType === 'SCB' || loanType === 'PMM') {
    assumable = 'possible';
    confidence = 'medium';
    reason = 'Seller carryback/private mortgages may be assumable - check loan documents';
    nextSteps = ['Review loan agreement terms', 'Negotiate directly with note holder'];
  } else if (!loanType || loanType === 'UNKNOWN' || loanType === '') {
    assumable = 'unknown';
    confidence = 'none';
    reason = 'No loan type data available';
    nextSteps = ['Request loan documents', 'Contact lender directly'];
  } else {
    assumable = 'unknown';
    confidence = 'low';
    reason = `Unknown loan type: ${loanType}`;
    nextSteps = ['Review loan documents', 'Contact lender directly'];
  }

  // Calculate financial attractiveness
  let rateSavings = 0;
  const currentRate = 6.5; // Could fetch dynamically from FRED
  if (estimatedRate && estimatedRate > 0) {
    const rateDiff = currentRate - estimatedRate;
    rateSavings = rateDiff > 0 ? rateDiff : 0;
    
    if (rateDiff >= 1.5) {
      attractiveness = 'very_attractive';
    } else if (rateDiff >= 0.75) {
      attractiveness = 'attractive';
    } else if (rateDiff >= 0.25) {
      attractiveness = 'somewhat_attractive';
    } else {
      attractiveness = 'not_attractive';
    }
  }

  console.log('[Assumability Analysis] Calculated remaining balance:', {
    originalAmount: loanAmount,
    remainingBalance: balanceInfo.remainingBalance,
    monthsElapsed: balanceInfo.monthsElapsed,
    monthsRemaining: balanceInfo.monthsRemaining,
    percentPaid: balanceInfo.percentPaid
  });

  return {
    assumable,
    confidence,
    reason,
    loanType,
    loanDate: mortgage.date,
    estimatedRate,
    currentRate,
    rateSavings,
    attractiveness,
    remainingBalance: balanceInfo.remainingBalance,
    originalAmount: loanAmount,
    monthsRemaining: balanceInfo.monthsRemaining,
    monthsElapsed: balanceInfo.monthsElapsed,
    principalPaid: balanceInfo.principalPaid,
    percentPaid: balanceInfo.percentPaid,
    rateEstimated,
    nextSteps,
    disclaimer: rateEstimated 
      ? 'Rate estimated from historical FRED data for loan origination date. Confirm by reviewing mortgage documents.'
      : 'Estimate based on loan type. Confirm by reviewing mortgage documents.'
  };
}

async function attomGet(url, params = {}) {
  if (!ATTOM_API_KEY) return { ok:false, status:0, error:'missing_api_key' };
  const u = new URL(url);
  Object.entries(params).forEach(([k,v])=>{ if(v!==undefined && v!==null) u.searchParams.set(k, v); });
  const ctrl = new AbortController();
  const to = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchAttom(u.toString(), { headers: HEADERS, signal: ctrl.signal });
    const status = resp.status;
    let data = null; let text = null;
    try { data = await resp.json(); } catch { text = await resp.text(); }
    if (status === 200 && data) return { ok:true, status, data };
    return { ok:false, status, error: text ? text.slice(0,500) : JSON.stringify(data || {}).slice(0,500) };
  } catch (e) {
    return { ok:false, status:0, error: e.message };
  } finally { clearTimeout(to); }
}

// Normalize tax history similar to Python version
function normalizeTaxHistory(component) {
  if (!component || !component.ok) return { rows:[], meta:{ cagr_full:null, cagr_5yr:null } };
  const data = component.data || {};
  const entries = [];
  const props = data.property;
  let propObj = null;
  if (Array.isArray(props) && props.length) propObj = props[0]; else if (props && typeof props === 'object') propObj = props;
  if (propObj && Array.isArray(propObj.assessmenthistory)) {
    for (const row of propObj.assessmenthistory) {
      if (!row || typeof row !== 'object') continue;
      const tax = row.tax || {};
      const assessed = row.assessed || {};
      const calculations = row.calculations || {};
      const year = tax.taxYear || tax.taxYearAssessed || tax.assessorYear;
      if (year) entries.push({
        year: Number(year),
        tax_amount: tax.taxAmt,
        // ATTOM mixes casings: assdTtlValue / assdttlvalue / assdTotalValue
        assessed_total: assessed.assdTtlValue
          || assessed.assdttlvalue
          || assessed.assdTotalValue
          || assessed.assessedValueTotal
          || calculations.calcTtlValue
          || calculations.calcttlvalue
          || null,
        land_value: assessed.assdLandValue || assessed.landValue || assessed.assdlandvalue,
        improvement_value: assessed.assdImprValue || assessed.improvementValue || assessed.assdimprvalue,
      });
    }
  }
  // Deduplicate latest per year & sort newest->oldest
  const dedup = new Map();
  for (const e of entries) {
    if (!Number.isInteger(e.year)) continue;
    const prev = dedup.get(e.year);
    if (!prev || (typeof e.tax_amount==='number' && e.tax_amount > (prev.tax_amount||0))) dedup.set(e.year, e);
  }
  const rows = Array.from(dedup.values()).sort((a,b)=>b.year-a.year).slice(0,15);
  rows.forEach((r,i)=>{ if (i+1<rows.length) { const prev = rows[i+1]; if (typeof r.tax_amount==='number' && typeof prev.tax_amount==='number' && prev.tax_amount!==0) r.tax_amount_yoy_pct = (r.tax_amount - prev.tax_amount)/prev.tax_amount; } });
  const cagr = (series) => { if (series.length<2) return null; const latest=series[0].tax_amount; const oldest=series[series.length-1].tax_amount; const years = series[0].year - series[series.length-1].year; if (!(years>0) || !(latest>0) || !(oldest>0)) return null; try { return Math.pow(latest/oldest, 1/years)-1; } catch { return null; } };
  const cagr_full = cagr(rows);
  const last5 = rows.filter(r => rows[0].year - r.year <= 4);
  const cagr_5yr = last5.length>=2 ? cagr(last5) : null;
  return { rows, meta:{ cagr_full, cagr_5yr } };
}

function normalizeSalesHistory(component) {
  if (!component || !component.ok) return [];

  const data = component.data || {};
  const prop = firstProp(data);
  const sales = data.salehistory?.sales
    || data.sales
    || prop?.salehistory?.sales
    || prop?.salehistory
    || prop?.sales
    || [];

  if (!Array.isArray(sales)) return [];

  return sales
    .map((sale) => {
      if (!sale || typeof sale !== 'object') return null;

      const sale_date = sale.saleTransDate || sale.saleDate || sale.date || sale.recordingDate || null;
      const sale_price = toFiniteNumber(sale.saleAmt ?? sale.salePrice ?? sale.amount ?? sale.price ?? sale.saleAmount);

      if (!sale_date || sale_price === null) return null;

      return {
        sale_date,
        sale_price,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date)));
}

// Comprehensive endpoint list - all available ATTOM endpoints
/**
 * Lightweight single-endpoint ATTOM AVM fetch.
 * Only calls attomavm_detail (1 API call) instead of the full 19-endpoint dashboard.
 * Used by the renovation pipeline for Signal D mispricing detection on comps.
 */
export async function fetchAttomAVM({ address, skipCache = false } = {}) {
  if (!ATTOM_API_KEY) throw new Error('ATTOM_API_KEY missing on server');
  if (!address) throw new Error('Address required for ATTOM AVM lookup');

  const { getCachedDoc, setCachedDoc, hashCacheKey } = await import('./firestore-doc-cache.js');
  const cacheKey = hashCacheKey({ v: 1, kind: 'attom_avm', address: String(address).toLowerCase() });
  if (!skipCache) {
    const cached = await getCachedDoc('attom_avm_cache', cacheKey, 24 * 14);
    if (cached?.data?.value) {
      return { ...cached.data, fromCache: true };
    }
  }

  const resp = await attomGet(`${BASE_V1}/attomavm/detail`, { address });
  if (!resp.ok) return null;
  const prop = firstProp(resp.data);
  if (!prop) return null;
  const avm = prop.avm || {};
  const result = {
    value: avm.amount?.value || null,
    low: avm.amount?.low || null,
    high: avm.amount?.high || null,
    date: avm.eventDate || null,
  };
  if (result.value) {
    setCachedDoc('attom_avm_cache', cacheKey, result, {
      kind: 'attom_avm',
      address,
    }).catch(() => {});
  }
  return result;
}

const DASH_ENDPOINTS = [
  // Core property data
  ['expandedprofile', `${BASE_V1}/property/expandedprofile`],
  ['detail', `${BASE_V1}/property/detail`],
  ['basicprofile', `${BASE_V1}/property/basicprofile`],
  
  // Tax & valuation data
  ['assessment_detail', `${BASE_V1}/assessment/detail`],
  ['assessmenthistory_detail', `${BASE_V1}/assessmenthistory/detail`],
  ['attomavm_detail', `${BASE_V1}/attomavm/detail`],
  ['avmhistory_detail', `${BASE_V1}/avmhistory/detail`],
  ['rentalavm', `${BASE_V1}/valuation/rentalavm`],
  
  // Sales & ownership history
  ['saleshistory_detail', `${BASE_V1}/saleshistory/detail`],
  ['detailmortgage', `${BASE_V1}/property/detailmortgage`],
  ['detailmortgageowner', `${BASE_V1}/property/detailmortgageowner`],
  ['ownerhistory', `${BASE_V1}/ownerhistory/detail`],
  ['deedhistory', `${BASE_V1}/deedhistory/detail`],
  
  // Environmental & risk data
  ['hazard_detail', `${BASE_V1}/hazard/detail`],
  ['transportationnoise', `https://api.gateway.attomdata.com/hazard/v1/transportationnoise`],
  
  // Building & location data
  ['buildingpermits', `${BASE_V1}/property/buildingpermits`],
  ['detailwithschools', `${BASE_V1}/property/detailwithschools`],
  ['boundary', `${BASE_V1}/area/full`],
  
  // Foreclosure data
  ['foreclosure', `${BASE_V1}/foreclosure/detail`],
];

const RENOVATION_MARKET_ENDPOINTS = [
  ['expandedprofile', `${BASE_V1}/property/expandedprofile`],
  ['detail', `${BASE_V1}/property/detail`],
  ['assessmenthistory_detail', `${BASE_V1}/assessmenthistory/detail`],
  ['attomavm_detail', `${BASE_V1}/attomavm/detail`],
  ['rentalavm', `${BASE_V1}/valuation/rentalavm`],
  ['saleshistory_detail', `${BASE_V1}/saleshistory/detail`],
];

export const RENOVATION_MARKET_ENDPOINT_COUNT = RENOVATION_MARKET_ENDPOINTS.length;


function firstProp(blob) {
  if (!blob || typeof blob !== 'object') return null;
  const p = blob.property;
  if (Array.isArray(p) && p.length) return p[0];
  if (p && typeof p==='object') return p;
  return null;
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractNumberFromPaths(obj, candidatePaths = []) {
  if (!obj || typeof obj !== 'object') return null;

  for (const path of candidatePaths) {
    const segments = Array.isArray(path) ? path : [path];
    let current = obj;

    for (const segment of segments) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = current[segment];
    }

    const numericValue = toFiniteNumber(current);
    if (numericValue !== null) return numericValue;
  }

  return null;
}

const ATTOM_SOURCE_COMPONENTS = [
  'expandedprofile',
  'detail',
  'basicprofile',
  'assessment_detail',
  'assessmenthistory_detail',
  'attomavm_detail',
  'avmhistory_detail',
  'rentalavm',
  'saleshistory_detail',
  'detailmortgage',
  'detailmortgageowner',
  'hazard_detail',
  'transportationnoise',
  'buildingpermits',
  'detailwithschools',
  'boundary',
];

function buildAttomSource(components) {
  if (!components || typeof components !== 'object') return null;

  const source = {};
  for (const key of ATTOM_SOURCE_COMPONENTS) {
    const component = components[key];
    if (!component?.ok || !component.data) continue;
    try {
      source[key] = JSON.parse(JSON.stringify(component.data));
    } catch {
      // Skip non-serializable component payloads.
    }
  }

  return Object.keys(source).length > 0 ? source : null;
}

export function decorateDashboardPayload(dashboard, components) {
  if (!dashboard || typeof dashboard !== 'object') return dashboard;

  const summary = dashboard.summary && typeof dashboard.summary === 'object'
    ? dashboard.summary
    : {};
  dashboard.summary = summary;

  const sqftValue = summary.living_sqft ?? summary.building_sqft ?? summary.sqft ?? null;
  if (sqftValue !== null) {
    if (summary.living_sqft == null) summary.living_sqft = sqftValue;
    if (summary.building_sqft == null) summary.building_sqft = sqftValue;
    if (summary.sqft == null) summary.sqft = sqftValue;
  }

  const latestTax = Array.isArray(dashboard.tax_history) && dashboard.tax_history.length > 0
    ? dashboard.tax_history[0]
    : null;
  if (latestTax?.tax_amount != null && summary.tax_current == null) {
    summary.tax_current = latestTax.tax_amount;
  }
  if (summary.assessed_value == null && latestTax?.assessed_total != null) {
    summary.assessed_value = latestTax.assessed_total;
  }
  if (dashboard.school_district && summary.school_district == null) {
    summary.school_district = dashboard.school_district;
  }

  if (dashboard.beds == null && summary.beds != null) dashboard.beds = summary.beds;
  if (dashboard.baths == null && summary.baths != null) dashboard.baths = summary.baths;
  if (dashboard.sqft == null && sqftValue != null) dashboard.sqft = sqftValue;
  if (dashboard.yearBuilt == null && summary.year_built != null) dashboard.yearBuilt = summary.year_built;
  if (dashboard.propertyType == null && summary.property_type != null) dashboard.propertyType = summary.property_type;

  if (dashboard.hazard_scores == null && dashboard.environmental) {
    const hazardScores = {};
    const floodScore = extractNumberFromPaths(dashboard.environmental.flood, [
      ['score'],
      ['riskScore'],
      ['risk'],
      ['totalRisk'],
      ['rating'],
      ['index'],
      ['value'],
    ]);
    const fireScore = extractNumberFromPaths(dashboard.environmental.fire, [
      ['score'],
      ['riskScore'],
      ['risk'],
      ['totalRisk'],
      ['rating'],
      ['index'],
      ['value'],
      ['nasa_enhancement', 'totalRisk'],
    ]);
    const earthquakeScore = extractNumberFromPaths(dashboard.environmental.earthquake, [
      ['score'],
      ['riskScore'],
      ['risk'],
      ['totalRisk'],
      ['rating'],
      ['index'],
      ['value'],
    ]);

    if (floodScore !== null) hazardScores.flood = floodScore;
    if (fireScore !== null) hazardScores.fire = fireScore;
    if (earthquakeScore !== null) hazardScores.earthquake = earthquakeScore;

    if (Object.keys(hazardScores).length > 0) {
      dashboard.hazard_scores = hazardScores;
    }
  }

  if (dashboard.noiseLevel == null && dashboard.transportation_noise) {
    const noiseLevel = extractNumberFromPaths(dashboard.transportation_noise, [
      ['noiseLevel'],
      ['db'],
      ['dB'],
      ['decibels'],
      ['overallDb'],
      ['overallNoiseDb'],
      ['averageDb'],
      ['airport', 'noiseLevel'],
      ['airport', 'db'],
      ['highway', 'noiseLevel'],
      ['highway', 'db'],
      ['railway', 'noiseLevel'],
      ['railway', 'db'],
    ]);
    if (noiseLevel !== null) {
      dashboard.noiseLevel = noiseLevel;
    }
  }

  if (dashboard.attom_source == null && components) {
    const attomSource = buildAttomSource(components);
    if (attomSource) {
      dashboard.attom_source = attomSource;
    }
  }

  return dashboard;
}

async function extractSummary(components) {
  let primary = null;
  // Check all property detail endpoints for the most complete data
  for (const key of ['expandedprofile','detail','basicprofile']) {
    if (components[key]?.ok) { 
      primary = firstProp(components[key].data); 
      if (primary) break;
    }
  }
  const summary = {};
  if (primary) {
    const addr = primary.address || {};
    summary.address = addr.oneLine || addr.line1;
    summary.year_built = primary.summary?.yearBuilt;
    summary.property_type = primary.summary?.propertyType;
    summary.lot_acres = primary.lot?.lotSize1;
    summary.attom_id = primary.identifier?.attomId;
    
    // Extract latitude and longitude
    const location = primary.location || {};
    summary.latitude = location.latitude;
    summary.longitude = location.longitude;
    
    // Extract area/neighborhood context data
    const area = primary.area || {};
    const identifier = primary.identifier || {};
    summary.area_context = {
      county: area.countrySecSubd || area.countrysecsubd,
      municipality: area.munName || area.munname,
      municipality_code: area.munCode || area.muncode,
      census_tract: area.censusTractIdent || area.censustractident,
      census_block_group: area.censusBlockGroup || area.censusblockgroup,
      tax_code_area: area.taxCodeArea || area.taxcodearea,
      zoning: primary.lot?.zoningType || primary.lot?.zoning,
      fips: identifier.fips,
      state_code: addr.countrySubd,
    };
    
    // Clean up undefined values
    Object.keys(summary.area_context).forEach(key => {
      if (summary.area_context[key] === undefined) {
        delete summary.area_context[key];
      }
    });
    if (Object.keys(summary.area_context).length === 0) {
      delete summary.area_context;
    }
  }
  const fallbackPaths = {
    beds:[['building','rooms','beds'],['rooms','beds'],['summary','beds'],['building','rooms','bedrooms'],['rooms','bedrooms']],
    baths:[['building','rooms','baths'],['rooms','bathstotal'],['building','rooms','bathstotal'],['summary','bathstotal'],['summary','baths'],['building','bathstotal'],['rooms','baths']],
    living_sqft:[['building','size','livingsize'],['building','size','livingSqFt'],['building','size','bldgsize'],['building','size','universalSize'],['building','size','grosssize'],['building','size','buildingArea'],['building','size','finishedsize'],['building','size','finishedSize'],['interior','bsmtsize']],
  };
  const extractPath = (obj, path)=>path.reduce((cur,seg)=> (cur && typeof cur==='object') ? cur[seg] : undefined, obj);
  const iterateProps = (blob)=> {
    if (!blob || typeof blob!=='object') return [];
    const out=[]; 
    if (blob.property) { 
      const val=blob.property; 
      if (Array.isArray(val)) out.push(...val.filter(v=>v&&typeof v==='object')); 
      else if (val && typeof val==='object') out.push(val); 
    }
    // Add the blob itself if it has relevant data
    if (blob.building||blob.summary||blob.avm||blob.rooms||blob.interior) out.push(blob);
    return out;
  };
  for (const [field, paths] of Object.entries(fallbackPaths)) {
    if (summary[field]) continue;
    for (const [compName, comp] of Object.entries(components)) {
      if (!comp.ok) continue; const data = comp.data; if (!data) continue;
      for (const prop of iterateProps(data)) {
        for (const p of paths) { 
          const val = extractPath(prop, p); 
          if (val !== undefined && val !== null && val !== '') { 
            console.log(`[ATTOM] Found ${field} = ${val} at path ${p.join('.')} in component ${compName}`);
            summary[field] = val; 
            break; 
          } 
        }
        if (summary[field]) break;
      }
      if (summary[field]) break;
    }
  }
  if (!('avm_value' in summary)) {
    // Check all AVM endpoints for valuation data
    for (const key of ['expandedprofile','attomavm_detail','detail']) {
      const comp = components[key]; if (comp?.ok) { const p = firstProp(comp.data); const avm = p?.avm?.amount || {}; if (avm && typeof avm==='object') { summary.avm_value = avm.value; summary.avm_low = avm.low; summary.avm_high = avm.high; break; } }
    }
  }
  // Additional AVM fallbacks: look for nested structures or alternative keys if still missing
  if (!summary.avm_value) {
    for (const [name, comp] of Object.entries(components)) {
      if (!comp?.ok) continue; const p = firstProp(comp.data); if (!p) continue;
      // Common alternative patterns
      const candidates = [
        p?.avm?.estimate, // sometimes { value, low, high }
        p?.avm?.estimatedValue,
        p?.valuation?.avm,
        p?.valuation?.market,
        p?.attomavm,
      ].filter(Boolean);
      for (const c of candidates) {
        if (c && typeof c === 'object') {
          const val = c.value || c.amount || c.avmValue || c.estimate;
            if (typeof val === 'number') {
              summary.avm_value = val;
              summary.avm_low = summary.avm_low || c.low || c.min || c.rangeLow;
              summary.avm_high = summary.avm_high || c.high || c.max || c.rangeHigh;
              break;
            }
        }
      }
      if (summary.avm_value) break;
    }
  }
  // Explicit direct path extraction for attomavm_detail (observed schema: property[0].avm.amount.value)
  if (!summary.avm_value && components.attomavm_detail?.ok) {
    try {
      const p = firstProp(components.attomavm_detail.data);
      const amt = p?.avm?.amount;
      if (amt && typeof amt.value === 'number') {
        summary.avm_value = amt.value;
        summary.avm_low = summary.avm_low || amt.low;
        summary.avm_high = summary.avm_high || amt.high;
      }
    } catch {}
  }
  if (!('rental_avm' in summary) && components.rentalavm?.ok) {
    const p = firstProp(components.rentalavm.data); 
    // Debug logging to see actual structure
    console.log('[ATTOM] Rental AVM raw firstProp:', JSON.stringify(p, null, 2));
    
    // Handle the actual ATTOM API structure: rentalAvm.estimatedRentalValue (camelCase!)
    const rentalAvm = p?.rentalAvm || p?.rentalAVM || p?.RentalAvm || p?.rentalavm || p?.avm?.rental || p?.avm || p?.rental || {};
    
    // Extract rental values with proper field names
    summary.rental_avm = rentalAvm?.estimatedRentalValue || rentalAvm?.value || rentalAvm?.rentalValue || rentalAvm?.amount;
    summary.rental_avm_low = rentalAvm?.estimatedMinRentalValue || rentalAvm?.low || rentalAvm?.minLow || rentalAvm?.rangeLow || rentalAvm?.lowValue;
    summary.rental_avm_high = rentalAvm?.estimatedMaxRentalValue || rentalAvm?.high || rentalAvm?.maxHigh || rentalAvm?.rangeHigh || rentalAvm?.highValue;
    
    console.log('[ATTOM] Extracted rental values:', { 
      rental_avm: summary.rental_avm, 
      low: summary.rental_avm_low, 
      high: summary.rental_avm_high,
      rentalAvmObject: rentalAvm 
    });
  }
  // Check both assessment_detail and expandedprofile for assessed value
  if (!summary.assessed_value) {
    const pickAssessed = (p) => {
      const assessment = p?.assessment || {};
      const assessed = assessment.assessed || {};
      const tax = assessment.tax || {};
      const calculations = assessment.calculations || {};
      return assessed.assdTtlValue
        || assessed.assdttlvalue
        || assessed.assdTotalValue
        || assessed.assessedValueTotal
        || assessment.assdTtlValue
        || assessment.assdTotalValue
        || calculations.calcTtlValue
        || calculations.calcttlvalue
        || tax.assessedValueTotal
        || tax.assdTotalValue
        || tax.assdTtlValue
        || null;
    };
    if (components.assessment_detail?.ok) {
      summary.assessed_value = pickAssessed(firstProp(components.assessment_detail.data));
    } else if (components.expandedprofile?.ok) {
      summary.assessed_value = pickAssessed(firstProp(components.expandedprofile.data));
    }
  }
  if (components.saleshistory_detail?.ok) {
    console.log('[ATTOM] saleshistory_detail endpoint response:', { ok: true, status: components.saleshistory_detail.status });
    const data = components.saleshistory_detail.data || {};
    console.log('[ATTOM] saleshistory_detail data structure:', JSON.stringify(data, null, 2).substring(0, 500));
    
    const sales = data.salehistory?.sales;
    console.log('[ATTOM] Sales array found:', Array.isArray(sales), 'Length:', sales?.length);
    
    if (Array.isArray(sales)) {
      const dated = [];
      for (const s of sales) { 
        if (s && typeof s==='object') { 
          let dt = s.saleTransDate || s.saleDate; 
          if (dt && dt.length===10) dated.push([dt, s.saleAmt || s.salePrice]); 
        } 
      }
      dated.sort((a,b)=> b[0].localeCompare(a[0])); 
      if (dated.length) { 
        summary.last_sale_date = dated[0][0]; 
        summary.last_sale_price = dated[0][1]; 
        console.log('[ATTOM] Sale history extracted:', { date: dated[0][0], price: dated[0][1] });
      } else {
        console.log('[ATTOM] No valid sale dates found in sales array');
      }
    }
  } else {
    console.log('[ATTOM] saleshistory_detail endpoint failed:', components.saleshistory_detail?.error);
  }
  // Extract mortgage data from both endpoints (detailmortgage and detailmortgageowner)
  if (components.detailmortgage?.ok || components.detailmortgageowner?.ok) {
    const comp = components.detailmortgageowner || components.detailmortgage;
    const p = firstProp(comp.data);
    const mortgage = p?.mortgage;
    if (mortgage && typeof mortgage === 'object') {
      summary.mortgage = {
        lender_name: mortgage.lender?.lastname || mortgage.lender?.companyname,
        lender_code: mortgage.lender?.companycode,
        amount: mortgage.amount,
        date: mortgage.date,
        loan_type: mortgage.loantypecode,
        deed_type: mortgage.deedtype,
        term_months: mortgage.term,
        due_date: mortgage.duedate,
        title_company: mortgage.title?.companyname
      };
      
      // Estimate interest rate using historical FRED data
      if (mortgage.date && mortgage.amount && mortgage.term) {
        try {
          const estimatedRate = await getHistoricalMortgageRate(mortgage.date);
          if (estimatedRate) {
            summary.mortgage.estimated_interest_rate = estimatedRate;
            
            // Calculate monthly payment and total interest
            const monthlyPayment = calculateMonthlyPayment(mortgage.amount, estimatedRate, mortgage.term);
            const totalPaid = monthlyPayment * mortgage.term;
            const totalInterest = totalPaid - mortgage.amount;
            
            summary.mortgage.estimated_monthly_payment_pi = monthlyPayment; // Principal + Interest only
            summary.mortgage.estimated_total_interest = totalInterest;
            summary.mortgage.estimated_total_paid = totalPaid;
            
            console.log('[ATTOM] Estimated mortgage rate:', estimatedRate + '%', 'for date', mortgage.date);
          }
        } catch (err) {
          console.error('[ATTOM] Error estimating interest rate:', err);
        }
      }
    }
  }
  // Extract owner data if available
  if (components.detailmortgageowner?.ok) {
    const p = firstProp(components.detailmortgageowner.data);
    const owner = p?.owner;
    if (owner && typeof owner === 'object') {
      summary.owner = {
        is_corporate: owner.corporateindicator === 'Y',
        owner1_name: owner.owner1?.fullname,
        owner2_name: owner.owner2?.fullname,
        owner3_name: owner.owner3?.fullname,
        owner4_name: owner.owner4?.fullname,
        relationship_type: owner.ownerrelationshiptype,
        absentee_status: owner.absenteeownerstatus,
        mailing_address: owner.mailingaddressoneline
      };
    }
  }
  if (summary.avm_value && summary.living_sqft && typeof summary.avm_value==='number' && typeof summary.living_sqft==='number' && summary.living_sqft>0) summary.price_per_sqft = summary.avm_value / summary.living_sqft;
  if (summary.year_built && Number.isInteger(summary.year_built) && summary.year_built>1800) summary.age = new Date().getFullYear() - summary.year_built;
  return summary;
}

export async function fetchPropertyDashboard({ address, attomId, includeComponents=false, debugRaw=false }) {
  if (!ATTOM_API_KEY) throw new Error('ATTOM_API_KEY missing on server');
  if (!address && !attomId) throw new Error('Provide address or attomId');
  const params = {}; if (address) params.address = address; if (attomId) params.id = attomId;
  const results = await Promise.all(DASH_ENDPOINTS.map(async ([name, url]) => {
    const resp = await attomGet(url, params); 
    if (name === 'rentalavm') {
      console.log('[ATTOM] rentalavm endpoint response:', { ok: resp.ok, status: resp.status, hasData: !!resp.data });
      if (resp.ok && resp.data) {
        console.log('[ATTOM] rentalavm full data:', JSON.stringify(resp.data, null, 2));
      } else if (!resp.ok) {
        console.log('[ATTOM] rentalavm error:', resp.error);
      }
    }
    if (name === 'hazard_detail') {
      console.log('[ATTOM] hazard_detail endpoint response:', { ok: resp.ok, status: resp.status, hasData: !!resp.data });
      if (resp.ok && resp.data) {
        console.log('[ATTOM] hazard_detail full data:', JSON.stringify(resp.data, null, 2));
      } else if (!resp.ok) {
        console.log('[ATTOM] hazard_detail error:', resp.error);
      }
    }
    if (name === 'avmhistory_detail') {
      console.log('[ATTOM] avmhistory_detail endpoint response:', { ok: resp.ok, status: resp.status, hasData: !!resp.data });
      if (resp.ok && resp.data) {
        console.log('[ATTOM] avmhistory_detail full data:', JSON.stringify(resp.data, null, 2));
      } else if (!resp.ok) {
        console.log('[ATTOM] avmhistory_detail error:', resp.error);
      }
    }
    return [name, resp];
  }));
  const components = Object.fromEntries(results);
  const taxHistRaw = components['assessmenthistory_detail'];
  const { rows: tax_history, meta: tax_meta_raw } = normalizeTaxHistory(taxHistRaw);
  const summary = await extractSummary(components);
  console.log('[ATTOM] Final summary object:', JSON.stringify({ 
    beds: summary.beds, 
    baths: summary.baths, 
    rental_avm: summary.rental_avm,
    rental_avm_low: summary.rental_avm_low,
    rental_avm_high: summary.rental_avm_high,
    living_sqft: summary.living_sqft,
    avm_value: summary.avm_value
  }, null, 2));
  // AVM history normalization (simple chronological list). Schema guess: property[0].avmhistory or avmHistory array.
  let avm_history = [];
  try {
    const comp = components['avmhistory_detail'];
    console.log('[ATTOM] avmhistory_detail endpoint response:', { ok: comp?.ok, status: comp?.status, hasData: !!comp?.data });
    
    if (comp?.ok && comp.data) {
      console.log('[ATTOM] ========== AVM HISTORY FULL RESPONSE ==========');
      console.log(JSON.stringify(comp.data, null, 2));
      console.log('[ATTOM] ================================================');
      
      // Check all possible top-level keys
      console.log('[ATTOM] Top-level keys in response:', Object.keys(comp.data));
      
      const p = firstProp(comp.data);
      console.log('[ATTOM] firstProp result:', p ? 'Found' : 'Null');
      if (p) {
        console.log('[ATTOM] firstProp keys:', Object.keys(p));
      }
      
      // Try multiple possible paths to find the AVM history array
      let series = null;
      
      // Path 1: property[0].avmhistory or property[0].avmHistory
      if (p && (p.avmhistory || p.avmHistory)) {
        series = p.avmhistory || p.avmHistory;
        console.log('[ATTOM] Found series at property level (avmhistory/avmHistory):', Array.isArray(series), series?.length);
      }
      
      // Path 2: Direct in comp.data.avmhistory
      if (!series && (comp.data.avmhistory || comp.data.avmHistory)) {
        series = comp.data.avmhistory || comp.data.avmHistory;
        console.log('[ATTOM] Found series at data level (avmhistory/avmHistory):', Array.isArray(series), series?.length);
      }
      
      // Path 3: Check for property[0].avm array structure
      if (!series && p && Array.isArray(p.avm)) {
        series = p.avm;
        console.log('[ATTOM] Found series at property.avm:', Array.isArray(series), series?.length);
      }
      
      // Path 4: Check property[0].history
      if (!series && p && (p.history || p.History)) {
        series = p.history || p.History;
        console.log('[ATTOM] Found series at property.history:', Array.isArray(series), series?.length);
      }
      
      // Path 5: Check for property[0].assessment (some endpoints use this)
      if (!series && p && Array.isArray(p.assessment)) {
        series = p.assessment;
        console.log('[ATTOM] Found series at property.assessment:', Array.isArray(series), series?.length);
      }
      
      // Path 6: Check comp.data.avmHistory (case-sensitive variation)
      if (!series && comp.data.avmHistory) {
        series = comp.data.avmHistory;
        console.log('[ATTOM] Found series at data.avmHistory (case variation):', Array.isArray(series), series?.length);
      }
      
      console.log('[ATTOM] Final series check:', { 
        found: !!series, 
        isArray: Array.isArray(series), 
        length: series?.length,
        type: typeof series
      });
      
      if (Array.isArray(series) && series.length > 0) {
        console.log('[ATTOM] ========== SAMPLE ROW FROM SERIES ==========');
        console.log(JSON.stringify(series[0], null, 2));
        console.log('[ATTOM] ===========================================');
        
        avm_history = series.map(row => {
          if (!row || typeof row !== 'object') return null;
          
          // Try to extract date from multiple possible fields
          const date = row.eventDate || row.avmDate || row.date || row.pubDate || row.assessmentDate || row.calculationDate;
          
          // Try to extract value - check if it's directly a number or nested in an object
          let value = null;
          let low = null;
          let high = null;
          
          // If row has direct numeric value
          if (typeof row.value === 'number') {
            value = row.value;
          } else if (typeof row.amount === 'number') {
            value = row.amount;
          } else if (typeof row.estimate === 'number') {
            value = row.estimate;
          }
          
          // If value is in a nested object (amount, avm, estimate, value object)
          if (!value) {
            const avm = row.amount || row.avm || row.estimate || row.value || {};
            if (typeof avm === 'object' && avm !== null) {
              value = avm.value || avm.amount || avm.estimate;
              low = avm.low || avm.minLow || avm.rangeLow || avm.lowValue;
              high = avm.high || avm.maxHigh || avm.rangeHigh || avm.highValue;
            } else if (typeof avm === 'number') {
              value = avm;
            }
          }
          
          // Also check for low/high at row level
          if (!low && row.low !== undefined) low = row.low;
          if (!high && row.high !== undefined) high = row.high;
          if (!low && row.lowValue !== undefined) low = row.lowValue;
          if (!high && row.highValue !== undefined) high = row.highValue;
          
          if (!date) {
            console.log('[ATTOM] Row missing date, skipping:', Object.keys(row));
            return null;
          }
          
          if (!value || value === 0) {
            console.log('[ATTOM] Row missing value, skipping. Date:', date, 'Row keys:', Object.keys(row));
            return null;
          }
          
          return { date, value, low, high };
        }).filter(Boolean);
        
        // Sort ascending by date (YYYY-MM-DD lexicographic works)
        avm_history.sort((a,b)=> a.date.localeCompare(b.date));
        console.log('[ATTOM] ✓ AVM history extracted:', avm_history.length, 'records');
        if (avm_history.length > 0) {
          console.log('[ATTOM] First record:', avm_history[0]);
          console.log('[ATTOM] Last record:', avm_history[avm_history.length - 1]);
        }
      } else {
        console.log('[ATTOM] ✗ No AVM history array found in response, or array is empty');
      }
    } else if (!comp?.ok) {
      console.log('[ATTOM] ✗ avmhistory_detail endpoint failed:', comp?.error);
    } else {
      console.log('[ATTOM] ✗ avmhistory_detail returned OK but no data');
    }
  } catch (e) {
    console.error('[ATTOM] ✗ Error extracting AVM history:', e.message, e.stack);
  }
  
  // Fallback: If no AVM history, try to build from sales history
  if (avm_history.length === 0) {
    console.log('[ATTOM] No AVM history available, attempting to use sales history as fallback...');
    const salesComp = components['saleshistory_detail'];
    if (salesComp?.ok && salesComp.data) {
      console.log('[ATTOM] Sales history component data:', JSON.stringify(salesComp.data, null, 2));
      
      // Try multiple paths for sales data
      const p = firstProp(salesComp.data);
      const salesData = salesComp.data.salehistory?.sales 
        || salesComp.data.sales 
        || p?.salehistory?.sales 
        || p?.sales
        || (Array.isArray(salesComp.data.property?.[0]?.salehistory) ? salesComp.data.property[0].salehistory : null);
      
      console.log('[ATTOM] Sales data found:', Array.isArray(salesData), 'Length:', salesData?.length);
      
      if (Array.isArray(salesData) && salesData.length > 0) {
        console.log('[ATTOM] Sample sale record:', JSON.stringify(salesData[0], null, 2));
        
        avm_history = salesData
          .map(sale => {
            const date = sale.saleTransDate || sale.saleDate || sale.date || sale.recordingDate;
            const value = sale.saleAmt || sale.salePrice || sale.amount || sale.price || sale.saleAmount;
            
            // Be more lenient with date format
            if (date && value && value > 0) {
              return { date, value, low: null, high: null };
            }
            return null;
          })
          .filter(Boolean)
          .sort((a, b) => a.date.localeCompare(b.date));
        
        if (avm_history.length > 0) {
          console.log('[ATTOM] Using sales history as price history:', avm_history.length, 'records');
          console.log('[ATTOM] Sales history sample (first):', avm_history[0]);
          console.log('[ATTOM] Sales history sample (last):', avm_history[avm_history.length - 1]);
        } else {
          console.log('[ATTOM] No valid sales records with both date and value');
        }
      } else {
        console.log('[ATTOM] No sales data array found in sales history response');
      }
    } else {
      console.log('[ATTOM] Sales history component not available or failed');
    }
  }
  
  // Extract environmental hazard data
  let environmental = null;
  try {
    const hazardComp = components['hazard_detail'];
    if (hazardComp?.ok && hazardComp.data) {
      const p = firstProp(hazardComp.data);
      if (p) {
        environmental = {
          flood: p.flood || {},
          earthquake: p.earthquake || {},
          fire: p.fire || {},
          wind: p.wind || {},
          hail: p.hail || {},
          tornado: p.tornado || {},
          hurricane: p.hurricane || {},
          airQuality: p.airquality || p.airQuality || {}
        };
        console.log('[ATTOM] Environmental hazard data extracted:', JSON.stringify(environmental, null, 2));
        
        // Enhance wildfire risk with NASA data if we have coordinates
        if (summary.latitude && summary.longitude) {
          console.log('[ATTOM] Enhancing wildfire risk with NASA data...');
          try {
            const nasaEnhancement = await getEnhancedWildfireRisk(
              summary.latitude, 
              summary.longitude, 
              environmental.fire
            );
            
            // Add NASA data to environmental object
            environmental.fire.nasa_enhancement = nasaEnhancement;
            console.log('[ATTOM] NASA wildfire enhancement:', {
              totalRisk: nasaEnhancement.totalRisk,
              baseRisk: nasaEnhancement.baseRisk,
              activeFires: nasaEnhancement.nearbyFireCount,
              droughtLevel: nasaEnhancement.droughtLevel
            });
          } catch (nasaError) {
            console.error('[ATTOM] NASA enhancement failed:', nasaError.message);
            // Continue without NASA data
          }
        }
      }
    }
  } catch (e) {
    console.error('[ATTOM] Error extracting environmental data:', e.message);
  }
  
  // Extract building permits data
  let building_permits = [];
  try {
    const permitsComp = components['buildingpermits'];
    console.log('[ATTOM] buildingpermits endpoint response:', { ok: permitsComp?.ok, status: permitsComp?.status, hasData: !!permitsComp?.data });
    if (permitsComp?.ok && permitsComp.data) {
      console.log('[ATTOM] buildingpermits raw data structure:', JSON.stringify(permitsComp.data, null, 2).substring(0, 1000));
      const p = firstProp(permitsComp.data);
      console.log('[ATTOM] Property object keys:', Object.keys(p || {}));
      console.log('[ATTOM] Looking for buildingpermits array...');
      
      // Try multiple possible field names
      const permitsArray = p?.buildingpermits || p?.buildingPermits || p?.permits || p?.permit;
      
      if (permitsArray && Array.isArray(permitsArray)) {
        console.log('[ATTOM] Found permits array with', permitsArray.length, 'items');
        building_permits = permitsArray.map(permit => ({
          source: 'ATTOM Data',
          permit_number: permit.permitNumber || permit.permitNum,
          permit_type: permit.permitType,
          permit_type_description: permit.permitTypeDescription || permit.description,
          issue_date: permit.issueDate || permit.permitDate,
          work_description: permit.workDescription || permit.description,
          contractor_name: permit.contractorName,
          contractor_company: permit.contractorCompanyName || permit.company,
          estimated_cost: permit.estimatedCost || permit.cost,
          status: permit.status,
          square_feet: permit.squareFeet || permit.sqft
        }));
        
        // Sort by date, newest first (permits without dates go to end)
        building_permits.sort((a, b) => {
          if (!a.issue_date) return 1;
          if (!b.issue_date) return -1;
          return b.issue_date.localeCompare(a.issue_date);
        });
        
        console.log('[ATTOM] Building permits extracted:', building_permits.length);
        console.log('[ATTOM] Building permits sample:', JSON.stringify(building_permits.slice(0, 2), null, 2));
      } else {
        console.log('[ATTOM] No buildingpermits array found. Checked fields: buildingpermits, buildingPermits, permits, permit');
        console.log('[ATTOM] Property object has these keys:', Object.keys(p || {}).join(', '));
      }
    } else if (!permitsComp?.ok) {
      console.log('[ATTOM] buildingpermits endpoint failed:', permitsComp?.error);
    }
  } catch (e) {
    console.error('[ATTOM] Error extracting building permits:', e.message);
  }
  
  // Fetch permits from municipality open data APIs
  let municipality_permits = [];
  try {
    const addressParts = parseAddress(address);
    if (addressParts.city && addressParts.state) {
      console.log('[Municipality Permits] Fetching from city open data...');
      municipality_permits = await fetchMunicipalityPermits({
        address: addressParts.address,
        city: addressParts.city,
        state: addressParts.state,
        zip: addressParts.zip,
        latitude: summary.latitude,
        longitude: summary.longitude
      });
      console.log('[Municipality Permits] Found:', municipality_permits.length);
    } else {
      console.log('[Municipality Permits] Skipping - insufficient address info');
    }
  } catch (e) {
    console.error('[Municipality Permits] Error:', e.message);
  }
  
  // Combine ATTOM and municipality permits, remove duplicates
  const allPermits = [...building_permits, ...municipality_permits];
  const uniquePermits = [];
  const seen = new Set();
  
  for (const permit of allPermits) {
    // Create unique key from permit number or combination of available fields
    let key;
    if (permit.permit_number) {
      key = `num:${permit.permit_number}`;
    } else {
      // Fallback to combination of multiple fields for permits without permit numbers
      key = `${permit.issue_date || 'nodate'}-${permit.permit_type || 'notype'}-${permit.estimated_cost || 0}-${permit.work_description?.substring(0, 20) || 'nodesc'}`;
    }
    
    if (!seen.has(key)) {
      seen.add(key);
      uniquePermits.push(permit);
    }
  }
  
  // Sort by date, newest first (permits without dates go to end)
  building_permits = uniquePermits.sort((a, b) => {
    if (!a.issue_date) return 1;
    if (!b.issue_date) return -1;
    return b.issue_date.localeCompare(a.issue_date);
  });
  
  console.log('[Permits] Total unique permits:', building_permits.length, 
    `(${municipality_permits.length} from municipality, ${building_permits.length - municipality_permits.length} from ATTOM)`);
  
  // Log detailed final permit information
  if (building_permits.length > 0) {
    console.log('\n========== FINAL PERMITS FOR DASHBOARD ==========');
    building_permits.forEach((permit, index) => {
      console.log(`\n--- Permit ${index + 1} ---`);
      console.log('Source:', permit.source);
      console.log('Permit Number:', permit.permit_number);
      console.log('Type:', permit.permit_type);
      console.log('Description:', permit.permit_type_description || permit.work_description);
      console.log('Issue Date:', permit.issue_date);
      console.log('Status:', permit.status);
      console.log('Estimated Cost:', permit.estimated_cost);
      console.log('Contractor:', permit.contractor_name);
      console.log('Address:', permit.address);
    });
    console.log('\n=================================================\n');
  }
  
  const dashboard = { summary, tax_history, tax_meta: { count: tax_history.length, ...tax_meta_raw } };
  if (avm_history.length) dashboard.avm_history = avm_history;
  if (environmental) dashboard.environmental = environmental;
  if (building_permits.length) dashboard.building_permits = building_permits;
  
  // Add location at top level for easy access
  if (summary.latitude && summary.longitude) {
    dashboard.location = {
      latitude: summary.latitude,
      longitude: summary.longitude
    };
  }
  
  // Extract parcel geometry for map display
  let parcel_geometry = null;
  try {
    // First try the dedicated boundary endpoint
    const boundaryComp = components['boundary'];
    if (boundaryComp?.ok && boundaryComp.data) {
      console.log('[ATTOM] Checking boundary endpoint response...');
      const area = boundaryComp.data.area;
      if (area && Array.isArray(area) && area.length > 0) {
        const geom = area[0].geometry;
        if (geom && geom.coordinates) {
          parcel_geometry = {
            type: geom.type || 'Polygon',
            coordinates: geom.coordinates,
            centroid: { lat: summary.latitude, lng: summary.longitude }
          };
          console.log('[ATTOM] Parcel geometry extracted from boundary endpoint');
        }
      }
    }
    
    // Fallback to detail endpoint
    if (!parcel_geometry) {
      const detailComp = components['detail'];
      if (detailComp?.ok && detailComp.data) {
        const p = firstProp(detailComp.data);
        if (p?.lot?.geometry || p?.geometry) {
          const geom = p.lot?.geometry || p.geometry;
          parcel_geometry = {
            type: geom.type || 'Polygon',
            coordinates: geom.coordinates || geom.boundary?.coordinates,
            centroid: geom.centroid || { lat: summary.latitude, lng: summary.longitude }
          };
          console.log('[ATTOM] Parcel geometry extracted from detail endpoint');
        }
      }
    }
    
    if (!parcel_geometry) {
      console.warn('[ATTOM] No parcel geometry found in boundary or detail endpoints');
    }
  } catch (e) {
    console.error('[ATTOM] Error extracting parcel geometry:', e.message);
  }
  if (parcel_geometry) dashboard.parcel_geometry = parcel_geometry;
  
  // Extract school zones
  let schools = [];
  let school_district = null;
  try {
    const schoolComp = components['detailwithschools'];
    console.log('[ATTOM] detailwithschools endpoint response:', { ok: schoolComp?.ok, status: schoolComp?.status, hasData: !!schoolComp?.data });
    if (schoolComp?.ok && schoolComp.data) {
      const p = firstProp(schoolComp.data);
      
      // Extract school district information
      if (p?.schoolDistrict) {
        const sd = p.schoolDistrict;
        school_district = {
          name: sd.name || sd.districtName,
          code: sd.code || sd.districtCode,
          nces_id: sd.ncesId || sd.NCESId,
          type: sd.type,
          total_schools: sd.totalSchools || sd.schoolCount,
          enrollment: sd.enrollment || sd.studentCount,
          pupil_teacher_ratio: sd.pupilTeacherRatio,
          spending_per_student: sd.spendingPerStudent,
          graduation_rate: sd.graduationRate,
          rating: sd.rating || sd.districtRating,
        };
        
        // Clean up undefined values
        Object.keys(school_district).forEach(key => {
          if (school_district[key] === undefined) {
            delete school_district[key];
          }
        });
        
        if (Object.keys(school_district).length > 0) {
          console.log('[ATTOM] School district data:', JSON.stringify(school_district, null, 2));
        } else {
          school_district = null;
        }
      }
      
      // ATTOM API returns school data as p.school (array)
      const schoolData = p?.school || p?.schools || p?.schoolData || schoolComp.data.school || schoolComp.data.schools;
      
      if (schoolData) {
        const schoolArray = Array.isArray(schoolData) ? schoolData : [schoolData];
        schools = schoolArray.map(s => {
          // Determine school level from grade range
          let level = s.educationLevel || s.level;
          if (!level) {
            const lowGrade = s.lowAssignedGrade || s.gradelevel1lotext || '';
            const highGrade = s.highAssignedGrade || s.gradelevel1hitext || '';
            if (lowGrade.includes('KG') || lowGrade.includes('K') || (parseInt(lowGrade) <= 5 && parseInt(highGrade) <= 5)) {
              level = 'Elementary';
            } else if (parseInt(lowGrade) >= 6 && parseInt(highGrade) <= 8) {
              level = 'Middle';
            } else if (parseInt(lowGrade) >= 9 && parseInt(highGrade) <= 12) {
              level = 'High';
            }
          }
          
          return {
            name: s.InstitutionName || s.institutionName || s.name || s.schoolName,
            district: p?.schoolDistrict?.name || p?.schoolDistrict?.districtName || s.districtName || s.district || s.schoolDistrict,
            level: level,
            grades: `${s.lowAssignedGrade || s.gradelevel1lotext || ''}-${s.highAssignedGrade || s.gradelevel1hitext || ''}`.trim(),
            rating: s.schoolRating || s.greatSchoolsRating || s.rating || s.gsRating || s.GSTestRating,
            distance: s.distance || s.distanceMiles,
            type: s.Filetypetext || s.fileTypeText || s.type || s.schoolType, // Public, Private, Charter
            latitude: s.geocodinglatitude || s.latitude,
            longitude: s.geocodinglongitude || s.longitude,
            geoId: s.geoIdV4 || s.geoId,
          };
        }).filter(s => s.name);
        console.log(`[ATTOM] Extracted ${schools.length} schools:`, JSON.stringify(schools, null, 2));
      } else {
        console.log('[ATTOM] No school data found in property object. Available keys:', Object.keys(p || {}));
      }
    } else if (!schoolComp?.ok) {
      console.log('[ATTOM] detailwithschools endpoint failed:', schoolComp?.error);
    }
  } catch (e) {
    console.error('[ATTOM] Error extracting schools:', e.message);
  }
  if (schools.length) dashboard.schools = schools;
  if (school_district) dashboard.school_district = school_district;
  
  // Extract transportation noise data
  let transportation_noise = null;
  try {
    const noiseComp = components['transportationnoise'];
    if (noiseComp?.ok && noiseComp.data) {
      const p = firstProp(noiseComp.data);
      if (p) {
        transportation_noise = {
          airport: p.airport || {},
          highway: p.highway || {},
          railway: p.railway || {},
          overall_score: p.overallScore || p.score,
          description: p.description
        };
        console.log('[ATTOM] Transportation noise data extracted');
      }
    }
  } catch (e) {
    console.error('[ATTOM] Error extracting noise data:', e.message);
  }
  if (transportation_noise) dashboard.transportation_noise = transportation_noise;

  
  // Add assumability analysis if mortgage data exists
  if (dashboard.summary?.mortgage) {
    dashboard.summary.mortgage.assumability = await analyzeMortgageAssumability(dashboard.summary.mortgage);
    
    // Calculate full PITI payment if we have both mortgage and tax data
    if (dashboard.summary.mortgage.estimated_monthly_payment_pi && tax_history?.length > 0) {
      const latestTax = tax_history[0];
      const monthlyTax = latestTax.tax_amount ? latestTax.tax_amount / 12 : 0;
      
      dashboard.summary.mortgage.payment_breakdown = {
        principal_and_interest: dashboard.summary.mortgage.estimated_monthly_payment_pi,
        property_tax: monthlyTax,
        total_pi_plus_tax: dashboard.summary.mortgage.estimated_monthly_payment_pi + monthlyTax
      };
    }
  }

  decorateDashboardPayload(dashboard, components);
  
  if (includeComponents) {
    dashboard.components = Object.fromEntries(Object.entries(components).map(([k,v])=>[k,{ ok:v.ok, status:v.status, error:v.ok?undefined:v.error }]));
    if (debugRaw) {
  const pick = ['attomavm_detail','avmhistory_detail','expandedprofile','detail'];
      dashboard.raw = {};
      for (const key of pick) {
        const comp = components[key];
        if (comp?.ok && comp.data) {
          try {
            // Shallow clone & truncate large arrays/strings to keep response small
            const clone = JSON.parse(JSON.stringify(comp.data, (k,v)=>{
              if (Array.isArray(v) && v.length>5) return v.slice(0,5);
              if (typeof v === 'string' && v.length>400) return v.slice(0,400)+'…';
              return v;
            }));
            dashboard.raw[key] = clone;
          } catch {}
        }
      }
    }
  }
  return dashboard;
}

export async function fetchRenovationMarketDashboard({ address, attomId }) {
  if (!ATTOM_API_KEY) throw new Error('ATTOM_API_KEY missing on server');
  if (!address && !attomId) throw new Error('Provide address or attomId');

  const params = {};
  if (address) params.address = address;
  if (attomId) params.id = attomId;

  const results = await Promise.all(RENOVATION_MARKET_ENDPOINTS.map(async ([name, url]) => [
    name,
    await attomGet(url, params),
  ]));

  const components = Object.fromEntries(results);
  const { rows: tax_history, meta: tax_meta_raw } = normalizeTaxHistory(components.assessmenthistory_detail);
  const summary = await extractSummary(components);
  const sales_history = normalizeSalesHistory(components.saleshistory_detail);

  if (!summary?.address && address) {
    summary.address = address;
  }

  const avm = {
    amount: toFiniteNumber(summary?.avm_value),
    low: toFiniteNumber(summary?.avm_low),
    high: toFiniteNumber(summary?.avm_high),
    rental_avm: toFiniteNumber(summary?.rental_avm),
    rental_avm_low: toFiniteNumber(summary?.rental_avm_low),
    rental_avm_high: toFiniteNumber(summary?.rental_avm_high),
  };

  const dashboard = {
    summary,
    tax_history,
    tax_meta: { count: tax_history.length, ...tax_meta_raw },
  };

  if (sales_history.length) dashboard.sales_history = sales_history;
  if (Object.values(avm).some(value => value !== null)) dashboard.avm = avm;
  if (summary?.latitude && summary?.longitude) {
    dashboard.location = {
      latitude: summary.latitude,
      longitude: summary.longitude,
    };
  }

  decorateDashboardPayload(dashboard, components);
  return dashboard;
}

/**
 * Fetch sales comparables using snapshot + parallel AVM batch requests
 * Step 1: Get 50-100 nearby properties from expandedprofile (has building data)
 * Step 2: Filter by size/age similarity
 * Step 3: Fetch AVMs in parallel batches of 20
 */
async function fetchSalesComparables(address, options = {}) {
  console.log(`[ATTOM Comps] Function called with address: "${address}"`);
  
  const {
    radius = 2.0,
    maxResults = 10
  } = options;

  try {
    // Get subject property details
    console.log(`[ATTOM Comps] Step 1: Fetching subject property...`);
    const subjectDash = await fetchPropertyDashboard({ address, includeComponents: false, debugRaw: false });
    
    const lat = subjectDash.summary.latitude;
    const lon = subjectDash.summary.longitude;
    const subjectSqft = subjectDash.summary.square_footage || 2000;
    const subjectYearBuilt = subjectDash.summary.year_built || 1980;
    
    if (!lat || !lon) {
      return { ok: false, error: 'No coordinates available' };
    }

    console.log(`[ATTOM Comps] Subject: ${subjectSqft}sqft, built ${subjectYearBuilt}`);

    // Get bulk property data with building characteristics
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      radius: radius.toString(),
      pagesize: '100',
      orderby: 'distance'
    });

    const expandedUrl = `${BASE_V1}/property/expandedprofile?${params.toString()}`;
    console.log(`[ATTOM Comps] Step 2: Fetching 100 properties in bulk...`);

    const response = await fetchAttom(expandedUrl, {
      headers: {
        'Accept': 'application/json',
        'apikey': process.env.ATTOM_API_KEY
      }
    });

    if (!response.ok) {
      return { ok: false, error: `API returned ${response.status}` };
    }

    const data = await response.json();
    const properties = data.property || [];
    
    console.log(`[ATTOM Comps] ✅ Received ${properties.length} properties`);
    
    if (properties.length === 0) {
      return { ok: true, comparables: [] };
    }

    // Filter by size and age BEFORE fetching AVMs
    const sqftRangeLow = subjectSqft * 0.7;
    const sqftRangeHigh = subjectSqft * 1.3;
    const ageRangeLow = subjectYearBuilt - 20;
    const ageRangeHigh = subjectYearBuilt + 20;
    
    console.log(`[ATTOM Comps] Step 3: Filtering by similarity...`);
    console.log(`  Size: ${Math.round(sqftRangeLow)}-${Math.round(sqftRangeHigh)} sqft`);
    console.log(`  Age: ${ageRangeLow}-${ageRangeHigh}`);

    const filtered = properties
      .map(prop => {
        const propAddress = prop.address?.oneLine;
        if (!propAddress) return null;

        const building = prop.building || {};
        const summary = building.summary || {};
        const size = building.size || {};
        const location = prop.location || {};
        
        const sqft = size.livingSize || 0;
        const yearBuilt = summary.yearBuilt || 0;
        
        // Skip subject property
        const subjectStreet = address.toLowerCase().split(',')[0].trim();
        if (propAddress.toLowerCase().includes(subjectStreet)) return null;
        
        // Must have location
        if (!location.latitude || !location.longitude) return null;

        // Calculate distance
        const distanceMiles = calculateDistance(
          parseFloat(lat), parseFloat(lon),
          parseFloat(location.latitude), parseFloat(location.longitude)
        );
        if (distanceMiles > radius) return null;

        // Filter by size (within 30%)
        if (sqft > 0 && (sqft < sqftRangeLow || sqft > sqftRangeHigh)) return null;

        // Filter by age (within 20 years)
        if (yearBuilt > 0 && (yearBuilt < ageRangeLow || yearBuilt > ageRangeHigh)) return null;

        return {
          address: propAddress,
          building, summary, size, location,
          sqft, yearBuilt, distanceMiles
        };
      })
      .filter(p => p !== null)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .slice(0, maxResults * 3); // Get 3x for buffer

    console.log(`[ATTOM Comps] ✅ Filtered to ${filtered.length} matching properties`);

    if (filtered.length === 0) {
      return { ok: true, comparables: [] };
    }

    // Fetch AVM + building details in parallel for each property
    console.log(`[ATTOM Comps] Step 4: Fetching AVM + details for ${filtered.length} properties in parallel...`);
    
    const detailPromises = filtered.map(async (prop) => {
      try {
        // Make BOTH API calls in parallel for each property
        const [avmResponse, basicResponse] = await Promise.all([
          fetchAttom(`${BASE_V1}/attomavm/detail?address=${encodeURIComponent(prop.address)}`, {
            headers: { 'Accept': 'application/json', 'apikey': process.env.ATTOM_API_KEY }
          }),
          fetchAttom(`${BASE_V1}/property/basicprofile?address=${encodeURIComponent(prop.address)}`, {
            headers: { 'Accept': 'application/json', 'apikey': process.env.ATTOM_API_KEY }
          })
        ]);

        if (!avmResponse.ok) return null;

        const avmData = await avmResponse.json();
        const avmProp = avmData.property?.[0] || avmData.property || {};
        const avmValue = avmProp.avm?.amount?.value || 0;

        if (avmValue < 10000) return null;

        // Get building details from basicprofile (has beds, baths, yearBuilt)
        let beds = 0, baths = 0, sqft = prop.sqft, yearBuilt = 0;
        
        if (basicResponse.ok) {
          const basicData = await basicResponse.json();
          const basicProp = basicData.property?.[0] || {};
          const building = basicProp.building || {};
          const rooms = building.rooms || {};
          const size = building.size || {};
          const summary = basicProp.summary || {};
          
          beds = rooms.beds || 0;
          baths = rooms.bathsTotal || rooms.bathsFull || 0;
          sqft = size.livingSize || prop.sqft || 0;
          yearBuilt = summary.yearBuilt || 0;
        }

        return {
          address: prop.address,
          sale_date: new Date().toISOString().split('T')[0],
          sale_price: avmValue,
          beds,
          baths,
          living_sqft: sqft,
          lot_acres: prop.building.lot?.lotSize1 || 0,
          year_built: yearBuilt,
          property_type: prop.summary.propertyType || 'Unknown',
          latitude: prop.location.latitude,
          longitude: prop.location.longitude,
          distance_miles: prop.distanceMiles,
          condition_score: 75,
          data_source: 'ATTOM AVM'
        };
      } catch (error) {
        return null;
      }
    });

    const results = await Promise.all(detailPromises);
    const comparables = results
      .filter(comp => comp !== null)
      .slice(0, maxResults);

    console.log(`[ATTOM Comps] ✅ Successfully fetched ${comparables.length} comparables with AVMs`);
    
    if (comparables.length > 0) {
      console.log('[ATTOM Comps] Top 3:');
      comparables.slice(0, 3).forEach((comp, i) => {
        console.log(`  ${i+1}. ${comp.address}`);
        console.log(`     $${comp.sale_price.toLocaleString()} | ${comp.beds}bd/${comp.baths}ba | ${comp.living_sqft}sqft | ${comp.year_built} | ${comp.distance_miles.toFixed(2)}mi`);
      });
    }

    return { ok: true, comparables };

  } catch (error) {
    console.error('[ATTOM Comps] Error:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================================
// ABSENTEE OWNER SEARCH - Find off-market investment opportunities
// ============================================================================

/**
 * Search for properties with absentee owners in a geographic area
 * Uses ATTOM's property/snapshot endpoint with owner filters
 * 
 * @param {Object} options - Search options
 * @param {string} options.zipCode - ZIP code to search (e.g., "20854")
 * @param {string} options.county - County FIPS code (alternative to ZIP)
 * @param {number} options.latitude - Center latitude for radius search
 * @param {number} options.longitude - Center longitude for radius search
 * @param {number} options.radius - Radius in miles (default 5)
 * @param {number} options.minValue - Minimum property value
 * @param {number} options.maxValue - Maximum property value
 * @param {number} options.minSqft - Minimum square footage
 * @param {number} options.maxSqft - Maximum square footage
 * @param {number} options.minYearsOwned - Minimum years of ownership (long-term = motivated)
 * @param {boolean} options.corporateOnly - Only corporate owners
 * @param {boolean} options.individualsOnly - Exclude LLC/corp/institutional owners (mom-and-pop)
 * @param {boolean} options.freeAndClear - Only properties without mortgages
 * @param {number} options.pageSize - Results per page (max 1000)
 * @param {number} options.page - Page number
 */
// Hard corporate / institutional names.
const CORPORATE_OWNER_NAME_RE = /\b(LLC|L\.?L\.?C\.?|INC\.?|INCORPORATED|CORP\.?|CORPORATION|LP|L\.?P\.?|LLP|LTD|LIMITED|TRUSTEE|HOLDINGS|PROPERTIES|INVESTMENTS?|PARTNERS(?:HIP)?|ASSOCIATION|HOA|CONDOMINIUM|BANK|N\.?A\.?|CREDIT UNION|MANAGEMENT|APARTMENTS?|REALTY|REAL ESTATE|REIT|FUND|CAPITAL|EQUITIES|UNIVERSITY|COLLEGE|HOUSING AUTHORITY|DEPARTMENT OF|CITY OF|COUNTY OF|STATE OF|SUN\s*TRUST|WELLS\s*FARGO|CHASE|NATIONSTAR|FREEDOM\s*MORTGAGE)\b/i;
// Mom-and-pop estate vehicles only — do NOT match bare "TRUST" (banks like SunTrust).
const FAMILY_TRUST_RE = /\b(REVOCABLE|LIVING|FAMILY|IRREVOCABLE)\s+TRUST\b/i;

function isLikelyCorporateOwner(owner = {}, ownerName = '') {
  const name = String(
    ownerName
    || owner.owner1?.fullname
    || owner.corporatename
    || owner.ownername
    || owner.name
    || ''
  ).trim();

  // Family revocable/living trusts are mom-and-pop even when ATTOM marks corporateindicator=Y.
  if (name && FAMILY_TRUST_RE.test(name)) {
    return false;
  }

  if (owner.corporateindicator === 'Y' || owner.corporateIndicator === 'Y' || owner.isCorporate === true) {
    return true;
  }
  if (!name) return false;
  // Bare "TRUST" without family/revocable/living usually means bank/REO/institutional.
  if (/\bTRUST\b/i.test(name)) return true;
  return CORPORATE_OWNER_NAME_RE.test(name);
}

/**
 * ATTOM often labels SFRs as propclass "Single Family Residence / Townhouse".
 * Prefer summary.propertyType ("SINGLE FAMILY RESIDENCE") when available.
 */
function getPropertyTypeLabels(propOrClass) {
  if (propOrClass && typeof propOrClass === 'object') {
    const summary = propOrClass.summary || propOrClass;
    return {
      propertyType: String(summary.propertyType || propOrClass.propertyType || '').toUpperCase(),
      propclass: String(summary.propclass || summary.propType || propOrClass.propertyType || '').toUpperCase(),
    };
  }
  return {
    propertyType: '',
    propclass: String(propOrClass || '').toUpperCase(),
  };
}

function matchesPropertyTypeFilter(propOrClass, propertyType) {
  if (!propertyType || propertyType === 'ALL') return true;

  const { propertyType: attomPropertyType, propclass } = getPropertyTypeLabels(propOrClass);
  const combined = `${attomPropertyType} | ${propclass}`.trim();
  if (combined === '|') return propertyType === 'SFR';

  if (propertyType === 'SFR') {
    // True multifamily / condo / commercial — exclude.
    // IMPORTANT: do NOT ban bare "TOWNHOUSE" here. ATTOM's SFR bucket is often
    // "Single Family Residence / Townhouse", which previously zeroed all UMD leads.
    if (/\b(APARTMENT|APARTMENTS|MULTI[\s-]?FAMILY|\bMFR\b|CONDOMINIUM|\bCONDO\b|DUPLEX|TRIPLEX|QUADPLEX|COMMERCIAL|MOBILE HOME|MANUFACTURED|CO-?OP|COOPERATIVE|HIGH[\s-]?RISE)\b/.test(combined)) {
      return false;
    }
    // Prefer ATTOM's clean propertyType field, then propclass containing SINGLE FAMILY / SFR.
    if (/SINGLE\s*FAMILY|\bSFR\b|DETACHED/.test(combined)) return true;
    // Standalone townhomes are acceptable for remote-protection mom-and-pop campaigns.
    if (/TOWN\s?HOUSE|TOWNHOME/.test(combined)) return true;
    return false;
  }

  const typeMap = {
    CONDO: ['CONDO', 'CONDOMINIUM'],
    MFR: ['MFR', 'MULTI', 'DUPLEX', 'TRIPLEX', 'QUAD'],
    APARTMENT: ['APARTMENT', 'APARTMENTS'],
    LAND: ['LAND', 'VACANT'],
    COMMERCIAL: ['COMMERCIAL', 'OFFICE', 'RETAIL', 'INDUSTRIAL'],
  };
  const validTypes = typeMap[propertyType] || [propertyType];
  return validTypes.some((token) => combined.includes(String(token).toUpperCase()));
}

async function searchAbsenteeOwners(options = {}) {
  if (!ATTOM_API_KEY) throw new Error('ATTOM_API_KEY missing on server');
  
  const {
    zipCode,
    county,
    latitude,
    longitude,
    radius = 5,
    minValue,
    maxValue,
    minSqft,
    maxSqft,
    minYearsOwned,
    corporateOnly = false,
    individualsOnly = false,
    freeAndClear = false,
    outOfStateOnly = false,
    propertyType = null, // SFR, CONDO, MFR, etc. null/ALL = no type filter
    pageSize = 100,
    page = 1,
    skipCache = false,
  } = options;

  // Build query parameters
  const params = new URLSearchParams();
  
  // Geographic filter (required: one of these)
  if (zipCode) {
    params.set('postalcode', zipCode);
  } else if (county) {
    params.set('countyfips', county);
  } else if (latitude && longitude) {
    params.set('latitude', latitude.toString());
    params.set('longitude', longitude.toString());
    params.set('radius', radius.toString());
  } else {
    throw new Error('Must provide zipCode, county, or lat/lng coordinates');
  }

  // CRITICAL: Filter for absentee owners only
  params.set('absenteeInd', 'Y');
  
  // Property type filter
  if (propertyType && propertyType !== 'ALL') {
    params.set('propertytype', propertyType);
  }

  // Value filters
  if (minValue) params.set('minAssdTotalValue', minValue.toString());
  if (maxValue) params.set('maxAssdTotalValue', maxValue.toString());
  
  // Size filters
  if (minSqft) params.set('minUniversalSize', minSqft.toString());
  if (maxSqft) params.set('maxUniversalSize', maxSqft.toString());
  
  // Corporate owner filter (ATTOM supports include; individuals-only is post-filtered)
  if (corporateOnly && !individualsOnly) {
    params.set('corporateIndicator', 'Y');
  }

  // Pagination
  params.set('pagesize', Math.min(pageSize, 1000).toString());
  params.set('page', page.toString());

  // Order by assessed value descending (highest value first)
  params.set('orderby', 'assdtotalvalue desc');

  try {
    console.log(`[ATTOM Absentee] Searching for absentee owners...`);
    console.log(`[ATTOM Absentee] Params:`, Object.fromEntries(params.entries()));

    // Include propertyType in cache key so SFR searches don't reuse apartment-heavy pages.
    const geoCacheOptions = {
      zipCode,
      county,
      latitude,
      longitude,
      radius,
      page,
      pageSize,
      propertyType: propertyType || 'ALL',
    };
    let properties = [];
    let cacheMeta = { searchCacheHit: false, processedLeadCacheHits: 0 };

    if (!skipCache) {
      const cachedSearch = await getCachedAbsenteeSearch(geoCacheOptions);
      if (cachedSearch?.properties?.length) {
        properties = cachedSearch.properties;
        cacheMeta.searchCacheHit = true;
        cacheMeta.cacheAgeHours = cachedSearch.cacheAgeHours;
        console.log(`[ATTOM Absentee] Search cache HIT (${properties.length} raw properties, age ${cachedSearch.cacheAgeHours?.toFixed?.(1) || '?'}h)`);
      }
    }

    if (!properties.length) {
      // Use /property/detailmortgageowner endpoint which includes owner AND mortgage data
      // This enables assumability analysis alongside absentee owner filtering
      
      let url;
      let searchParams = new URLSearchParams();
      
      if (zipCode) {
        // Use address-based search with ZIP
        searchParams.set('postalcode', zipCode);
        searchParams.set('pagesize', Math.min(pageSize, 100).toString());
        searchParams.set('page', page.toString());
        url = `${BASE_V1}/property/detailmortgageowner?${searchParams.toString()}`;
      } else if (latitude && longitude) {
        // Use radius search
        searchParams.set('latitude', latitude.toString());
        searchParams.set('longitude', longitude.toString());
        searchParams.set('radius', radius.toString());
        searchParams.set('pagesize', Math.min(pageSize, 100).toString());
        searchParams.set('orderby', 'distance');
        url = `${BASE_V1}/property/detailmortgageowner?${searchParams.toString()}`;
      } else if (county) {
        // County-based search
        searchParams.set('countyfips', county);
        searchParams.set('pagesize', Math.min(pageSize, 100).toString());
        searchParams.set('page', page.toString());
        url = `${BASE_V1}/property/detailmortgageowner?${searchParams.toString()}`;
      } else {
        return { ok: false, error: 'Must provide zipCode, county, or lat/lng coordinates', properties: [] };
      }

      // Ask ATTOM for the target property class when possible (SFR etc.) so campus
      // apartment inventory does not fill the entire page before we can filter.
      if (propertyType && propertyType !== 'ALL') {
        searchParams.set('propertytype', propertyType);
        url = url.split('?')[0] + '?' + searchParams.toString();
      }
      if (corporateOnly && !individualsOnly) {
        searchParams.set('corporateIndicator', 'Y');
        url = url.split('?')[0] + '?' + searchParams.toString();
      }
      
      console.log(`[ATTOM Absentee] Fetching from: ${url}`);
      
      const response = await fetchAttom(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ATTOM Absentee] API error ${response.status}:`, errorText.substring(0, 500));
        return { ok: false, error: `ATTOM API returned ${response.status}: ${errorText.substring(0, 100)}`, properties: [] };
      }

      const data = await response.json();
      properties = data.property || [];
      
      console.log(`[ATTOM Absentee] Received ${properties.length} properties from ATTOM`);

      if (properties.length > 0) {
        await setCachedAbsenteeSearch(geoCacheOptions, {
          properties,
          sourceUrl: url,
        });
        console.log(`[ATTOM Absentee] Cached raw search result (${properties.length} properties)`);
      }
    }
    
    // DEBUG: Log first property structure to understand ATTOM's response
    if (properties.length > 0) {
      console.log('[ATTOM Absentee] DEBUG - First property keys:', Object.keys(properties[0]));
    }
    
    if (properties.length === 0) {
      return { ok: true, properties: [], totalFound: 0, totalQualified: 0, page, pageSize, cache: cacheMeta };
    }

    const hydrated = await hydrateCachedLeadsForRawProperties(properties);
    properties = hydrated.properties;
    cacheMeta.processedLeadCacheHits = hydrated.cacheHits;
    if (hydrated.cacheHits > 0) {
      console.log(`[ATTOM Absentee] Processed-lead cache HIT for ${hydrated.cacheHits} properties`);
    }

    // Process and filter for absentee owners
    const enrichedProperties = [];
    let absenteeCount = 0;
    
    for (const prop of properties) {
      try {
        if (prop.__cachedLead) {
          const processed = prop.__cachedLead;
          absenteeCount += 1;

          if (!matchesPropertyTypeFilter({
            propertyType: processed.attomPropertyType || processed.propertyType,
            propclass: processed.propertyType,
          }, propertyType)) {
            continue;
          }
          if (minValue && processed.assessedValue < minValue) continue;
          if (maxValue && processed.assessedValue > maxValue) continue;
          if (minSqft && processed.sqft < minSqft) continue;
          if (maxSqft && processed.sqft > maxSqft) continue;
          if (corporateOnly && !processed.owner?.isCorporate) continue;
          if (individualsOnly && (processed.owner?.isCorporate || isLikelyCorporateOwner({}, processed.owner?.name))) {
            continue;
          }

          enrichedProperties.push(processed);
          continue;
        }

        const owner = prop.owner || {};
        
        // Check absentee status - ATTOM uses various field names
        const absenteeStatus = owner.absenteeownerstatus || owner.absenteeOwnerStatus || owner.absenteeInd;
        const isAbsentee = absenteeStatus === 'Y' || absenteeStatus === 'A' || absenteeStatus === 'Absentee Owner';
        
        // Also check if mailing address differs from property address (backup method)
        const propertyAddress = prop.address?.oneLine || '';
        const mailingAddress = owner.mailingaddressoneline || owner.mailingAddressOneLine || '';
        const addressDiffers = mailingAddress && propertyAddress && 
          !mailingAddress.toLowerCase().includes(propertyAddress.split(',')[0].toLowerCase().trim());
        
        if (!isAbsentee && !addressDiffers) {
          continue; // Skip owner-occupied properties
        }
        
        absenteeCount++;
        
        // Apply property type filter — pass full summary so we can use ATTOM's
        // propertyType ("SINGLE FAMILY RESIDENCE") not just propclass
        // ("Single Family Residence / Townhouse").
        const summary = prop.summary || {};
        if (!matchesPropertyTypeFilter(summary, propertyType)) {
          continue;
        }
        
        // Apply value filters
        const assessment = prop.assessment || {};
        const assessedValue = assessment.assdTotalValue || assessment.assessed?.assdTotalValue || 0;
        if (minValue && assessedValue < minValue) continue;
        if (maxValue && assessedValue > maxValue) continue;
        
        // Apply size filter
        const building = prop.building || {};
        const sqft = building.size?.livingSize || building.size?.universalSize || 0;
        if (minSqft && sqft < minSqft) continue;
        if (maxSqft && sqft > maxSqft) continue;
        
        // Apply corporate / individuals filters
        const ownerName = owner.owner1?.fullname || owner.corporatename || owner.ownername || '';
        const isCorporate = isLikelyCorporateOwner(owner, ownerName);
        if (corporateOnly && !isCorporate) continue;
        if (individualsOnly && isCorporate) continue;
        
        // Process the property
        const processed = await processAbsenteeProperty(prop, { minYearsOwned, freeAndClear });
        if (processed) {
          enrichedProperties.push(processed);
          if (processed.attomId) {
            setCachedProcessedLead(processed.attomId, processed).catch(() => {});
          }
        }
      } catch (e) {
        console.error('[ATTOM Absentee] Error processing property:', e.message);
      }
    }

    // Filter by years owned and free/clear if specified (post-processing)
    let results = enrichedProperties;
    
    // Filter by years owned if specified
    if (minYearsOwned) {
      results = results.filter(p => p.ownershipYears >= minYearsOwned);
    }
    
    // Filter by mortgage status if specified
    if (freeAndClear) {
      results = results.filter(p => p.likelyFreeAndClear);
    }

    if (outOfStateOnly) {
      results = results.filter(p => p.isOutOfState);
    }

    // Sort by motivation score (highest first)
    results.sort((a, b) => b.motivationScore - a.motivationScore);
    results = annotateOwnerPortfolio(results);
    results.sort((a, b) => b.motivationScore - a.motivationScore);

    console.log(`[ATTOM Absentee] Found ${absenteeCount} absentee owners, returning ${results.length} qualified leads`);

    return {
      ok: true,
      properties: results,
      totalFound: absenteeCount,
      totalQualified: results.length,
      totalScanned: properties.length,
      page,
      pageSize,
      searchCriteria: {
        zipCode,
        county,
        propertyType,
        minValue,
        maxValue,
        minSqft,
        maxSqft,
        corporateOnly,
        individualsOnly,
        freeAndClear,
        outOfStateOnly,
        minYearsOwned
      },
      cache: cacheMeta,
    };

  } catch (error) {
    console.error('[ATTOM Absentee] Search error:', error.message, error.stack);
    return { ok: false, error: error.message, properties: [] };
  }
}

/**
 * Process a single absentee property and calculate motivation score
 */
async function processAbsenteeProperty(prop, filters = {}) {
  const identifier = prop.identifier || {};
  const address = prop.address || {};
  const building = prop.building || {};
  const summary = prop.summary || {};
  const lot = prop.lot || {};
  const owner = prop.owner || {};
  const assessment = prop.assessment || {};
  const sale = prop.sale || {};
  const mortgage = prop.mortgage || {};
  const rooms = building.rooms || {};
  const size = building.size || {};
  
  // Mortgage payload can be large — avoid logging it on every lead (stalls/crashes multi-ZIP searches).
  // ATTOM detailmortgageowner often uses lowercase keys (yearbuilt, livingsize, bathstotal).
  const saleDate = sale.saleTransDate || sale.saleAmountInfo?.saleTransDate || sale.saledate || sale.saleDate || null;
  let ownershipYears = 0;
  if (saleDate) {
    const purchaseDate = new Date(saleDate);
    const now = new Date();
    ownershipYears = Math.floor((now - purchaseDate) / (1000 * 60 * 60 * 24 * 365.25));
  }
  
  // Determine if likely free and clear (no recent mortgage or very old mortgage)
  const mortgageDate = mortgage.date || mortgage.loanDate || mortgage.loanRecordingDate;
  const mortgageAmount = mortgage.amount || mortgage.loanAmount || 0;
  let likelyFreeAndClear = false;
  let estimatedEquityPercent = 0;
  
  if (!mortgageAmount || mortgageAmount === 0) {
    likelyFreeAndClear = true;
    estimatedEquityPercent = 100;
  } else if (mortgageDate) {
    const mortgageAge = new Date() - new Date(mortgageDate);
    const mortgageYears = mortgageAge / (1000 * 60 * 60 * 24 * 365.25);
    // If mortgage is 15+ years old with 30-year term, likely 50%+ paid off
    if (mortgageYears >= 25) {
      likelyFreeAndClear = true;
      estimatedEquityPercent = 90;
    } else if (mortgageYears >= 15) {
      estimatedEquityPercent = 60;
    } else if (mortgageYears >= 10) {
      estimatedEquityPercent = 40;
    } else {
      estimatedEquityPercent = Math.min(30, mortgageYears * 3);
    }
  }

  // Calculate motivation score (0-100)
  let motivationScore = 0;
  const motivationFactors = [];

  // Factor 1: Long ownership (tired landlord syndrome)
  if (ownershipYears >= 20) {
    motivationScore += 25;
    motivationFactors.push(`${ownershipYears}+ years ownership (very long-term)`);
  } else if (ownershipYears >= 15) {
    motivationScore += 20;
    motivationFactors.push(`${ownershipYears} years ownership (long-term)`);
  } else if (ownershipYears >= 10) {
    motivationScore += 15;
    motivationFactors.push(`${ownershipYears} years ownership`);
  } else if (ownershipYears >= 5) {
    motivationScore += 10;
    motivationFactors.push(`${ownershipYears} years ownership`);
  }

  // Factor 2: High equity = flexible on price
  if (likelyFreeAndClear) {
    motivationScore += 20;
    motivationFactors.push('Likely owns free and clear');
  } else if (estimatedEquityPercent >= 60) {
    motivationScore += 15;
    motivationFactors.push(`~${estimatedEquityPercent}% estimated equity`);
  } else if (estimatedEquityPercent >= 40) {
    motivationScore += 10;
    motivationFactors.push(`~${estimatedEquityPercent}% estimated equity`);
  }

  // Factor 3: Corporate owner (may be liquidating) — usually excluded for mom-and-pop campaigns
  const ownerNameForCorp = owner.owner1?.fullname || owner.corporatename || owner.ownername || '';
  const isCorporate = isLikelyCorporateOwner(owner, ownerNameForCorp);
  if (isCorporate) {
    motivationScore += 15;
    motivationFactors.push('Corporate owner (potential portfolio sale)');
  }

  // Factor 4: Out-of-state owner (mailing address analysis)
  const propertyState = address.countrySubd || '';
  const mailingState = owner.mailingaddressstate || owner.absenteeOwnerMailingState || '';
  const isOutOfState = mailingState && propertyState && 
    mailingState.toUpperCase() !== propertyState.toUpperCase();
  if (isOutOfState) {
    motivationScore += 15;
    motivationFactors.push(`Out-of-state owner (lives in ${mailingState})`);
  }

  // Factor 5: Older property (may need work = opportunity)
  const yearBuilt = Number(
    summary.yearBuilt
    || summary.yearbuilt
    || building.yearBuilt
    || building.yearbuilt
    || 0
  ) || 0;
  const propertyAge = yearBuilt ? (new Date().getFullYear() - yearBuilt) : 0;
  if (propertyAge >= 50) {
    motivationScore += 10;
    motivationFactors.push(`${propertyAge} year old property (renovation opportunity)`);
  } else if (propertyAge >= 30) {
    motivationScore += 5;
    motivationFactors.push(`${propertyAge} year old property`);
  }

  // Factor 6: Large lot (subdivision potential)
  const lotSizeAcres = Number(lot.lotsize1 || lot.lotSize1 || lot.lotsizeacres || lot.lotSizeAcres || 0) || 0;
  if (lotSizeAcres >= 1) {
    motivationScore += 10;
    motivationFactors.push(`${lotSizeAcres.toFixed(2)} acre lot (development potential)`);
  }

  // Build owner contact info
  const ownerInfo = {
    name: owner.owner1?.fullname || owner.corporatename || owner.ownername || 'Unknown',
    name2: owner.owner2?.fullname || null,
    isCorporate,
    mailingAddress: owner.mailingaddressoneline || formatMailingAddress(owner),
    mailingCity: owner.mailingaddresscity || '',
    mailingState: owner.mailingaddressstate || mailingState || '',
    mailingZip: owner.mailingaddresszip || ''
  };

  // Get assessed and market values (detailmortgageowner sometimes omits assessment)
  const assessedValue = Number(
    assessment.assdTotalValue
    || assessment.assessed?.assdTotalValue
    || assessment.assessed?.value
    || prop.assessment?.assdttlvalue
    || 0
  ) || 0;
  const marketValue = Number(
    assessment.mktTotalValue
    || assessment.market?.mktTotalValue
    || assessment.market?.value
    || assessedValue
  ) || 0;

  // Analyze mortgage assumability
  const assumability = await analyzeMortgageAssumability(mortgage);
  
  const propertyTypeClass = summary.propertyType || summary.propclass || summary.propType || summary.proptype || 'SFR';
  const insuranceEstimate = estimatePropertyInsurancePremium({
    assessedValue,
    marketValue,
    state: address.countrySubd || '',
    propertyType: propertyTypeClass,
    occupancyType: isOutOfState ? 'absentee_rental' : 'second_home',
  });

  // Add assumability bonus to motivation score
  if (assumability.assumable === 'likely' && assumability.attractiveness === 'very_attractive') {
    motivationScore += 25;
    motivationFactors.push(`🔥 ASSUMABLE ${assumability.loanType} @ ${assumability.estimatedRate}% (${assumability.rateSavings.toFixed(2)}% below market!)`);
  } else if (assumability.assumable === 'likely' && assumability.attractiveness === 'attractive') {
    motivationScore += 20;
    motivationFactors.push(`✅ Assumable ${assumability.loanType} @ ${assumability.estimatedRate}% (${assumability.rateSavings.toFixed(2)}% savings)`);
  } else if (assumability.assumable === 'likely') {
    motivationScore += 10;
    motivationFactors.push(`✅ Assumable ${assumability.loanType} mortgage`);
  }

  const beds = Number(rooms.beds || rooms.bedsTotal || rooms.bedrooms || rooms.bedRooms || 0) || 0;
  const baths = Number(
    rooms.bathsTotal
    || rooms.bathstotal
    || rooms.bathsFull
    || rooms.bathsfull
    || rooms.baths
    || 0
  ) || 0;
  const sqft = Number(
    size.livingSize
    || size.livingsize
    || size.universalSize
    || size.universalsize
    || size.bldgsize
    || size.grosssize
    || 0
  ) || 0;

  return {
    // Identification
    attomId: identifier.attomId || identifier.id,
    apn: identifier.apn,
    fips: identifier.fips,
    
    // Address
    address: address.oneLine || formatAddress(address),
    streetAddress: address.line1 || `${address.houseNumber || ''} ${address.streetName || ''}`.trim(),
    city: address.locality || '',
    state: address.countrySubd || '',
    zipCode: address.postal1 || '',
    county: address.countrySecSubd || '',
    
    // Property details — prefer ATTOM propertyType ("SINGLE FAMILY RESIDENCE")
    // over propclass ("Single Family Residence / Townhouse") for display/filtering.
    propertyType: summary.propertyType || summary.propclass || summary.propType || summary.proptype || 'Unknown',
    attomPropertyType: summary.propertyType || null,
    attomPropClass: summary.propclass || summary.propType || summary.proptype || null,
    beds,
    baths,
    sqft,
    lotSizeAcres,
    yearBuilt,
    propertyAge,
    
    // Values
    assessedValue,
    marketValue,
    lastSalePrice: sale.saleAmt || sale.amount || sale.saleAmountInfo?.saleAmt || 0,
    lastSaleDate: saleDate,
    
    // Owner & motivation analysis
    owner: ownerInfo,
    ownershipYears,
    likelyFreeAndClear,
    estimatedEquityPercent,
    motivationScore,
    motivationFactors,
    isOutOfState,
    insuranceEstimate,
    
    // Mortgage & Assumability
    mortgage: mortgageAmount ? {
      lender: mortgage.lenderName || (typeof mortgage.lender === 'object' ? (mortgage.lender?.lastname || mortgage.lender?.companyname || mortgage.lender?.companycode || 'Unknown') : mortgage.lender) || 'Unknown',
      amount: mortgageAmount,
      date: mortgageDate,
      loanType: mortgage.loantypecode || mortgage.loanTypeCode || 'unknown',
      interestRate: assumability.estimatedRate || mortgage.interestrate || mortgage.interestRate,
      termMonths: mortgage.term || mortgage.termMonths || 360,
      rateEstimated: assumability.rateEstimated || false
    } : null,
    // Always include assumability if we have useful data (balance, rate info) even for unknown loan types
    assumability: (assumability.remainingBalance || assumability.estimatedRate) ? assumability : null,
    
    // Location for mapping
    latitude: prop.location?.latitude || address.latitude,
    longitude: prop.location?.longitude || address.longitude
  };
}

/**
 * Format mailing address from owner object
 */
function formatMailingAddress(owner) {
  const parts = [
    owner.mailingaddress1 || owner.mailingaddressline1,
    owner.mailingaddresscity,
    owner.mailingaddressstate,
    owner.mailingaddresszip
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Normalize owner identity for portfolio counting within a search batch.
 * ATTOM does not expose a stable owner ID on detailmortgageowner — name+mailing is the best proxy.
 */
function normalizeOwnerPortfolioKey(owner = {}) {
  const name = String(owner.name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const mailingZip = String(owner.mailingZip || '')
    .replace(/\D/g, '')
    .slice(0, 5);
  const mailing = String(owner.mailingAddress || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name === 'UNKNOWN') return null;
  return `${name}|${mailingZip || mailing || 'NOMAIL'}`;
}

function portfolioBand(count) {
  const n = Number(count) || 0;
  if (n <= 0) return 'unknown';
  if (n === 1) return '1';
  if (n <= 15) return '2-15';
  return '16+';
}

/**
 * Annotate leads with owner portfolio size counted within the current search result set.
 * Sweet spot for mom-and-pop outreach: 2–15 properties.
 */
function annotateOwnerPortfolio(leads = []) {
  const counts = new Map();
  for (const lead of leads) {
    const key = normalizeOwnerPortfolioKey(lead.owner);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return leads.map((lead) => {
    const key = normalizeOwnerPortfolioKey(lead.owner);
    const ownerPortfolioCount = key ? (counts.get(key) || 1) : null;
    const ownerPortfolioBand = portfolioBand(ownerPortfolioCount);

    // Strip prior portfolio motivation lines so re-annotation after batch merge stays accurate.
    const motivationFactors = (lead.motivationFactors || []).filter(
      (f) => !/portfolio in this search|Single property in this search/i.test(f),
    );
    let motivationScore = Number(lead.motivationScore) || 0;
    // Remove prior portfolio score deltas if present on cached leads (best-effort via factor text).
    // Fresh leads won't have portfolio factors yet; cached ones may — recompute from band only.
    const hadSweetSpot = (lead.motivationFactors || []).some((f) => /mom-and-pop sweet spot/i.test(f));
    const hadPro = (lead.motivationFactors || []).some((f) => /likely professional/i.test(f));
    if (hadSweetSpot) motivationScore -= 12;
    if (hadPro) motivationScore += 8;

    if (ownerPortfolioCount != null) {
      if (ownerPortfolioBand === '2-15') {
        motivationScore += 12;
        motivationFactors.push(
          `${ownerPortfolioCount}-property portfolio in this search (mom-and-pop sweet spot)`,
        );
      } else if (ownerPortfolioBand === '1') {
        motivationFactors.push('Single property in this search (possible accidental landlord)');
      } else if (ownerPortfolioBand === '16+') {
        motivationScore -= 8;
        motivationFactors.push(
          `${ownerPortfolioCount}-property portfolio in this search (likely professional — deprioritize)`,
        );
      }
    }

    return {
      ...lead,
      ownerPortfolioCount,
      ownerPortfolioBand,
      ownerPortfolioKey: key,
      motivationScore,
      motivationFactors,
    };
  });
}

/**
 * Format property address from address object
 */
function formatAddress(address) {
  const parts = [
    address.line1 || `${address.houseNumber || ''} ${address.streetName || ''}`.trim(),
    address.locality,
    address.countrySubd,
    address.postal1
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Get detailed analysis for a single absentee owner property
 * Fetches full dashboard data and combines with motivation analysis
 */
async function getAbsenteePropertyDetails(addressOrId) {
  try {
    // Fetch full property dashboard
    const dashboard = await fetchPropertyDashboard({ 
      address: addressOrId,
      includeComponents: false 
    });
    
    if (!dashboard || !dashboard.summary) {
      return { ok: false, error: 'Property not found' };
    }

    const summary = dashboard.summary;
    const owner = summary.owner || {};
    
    // Check if actually absentee
    const isAbsentee = owner.absentee_status === 'Absentee Owner' || 
                       owner.absentee_status === 'A' ||
                       owner.absenteeownerstatus === 'Y';
    
    // Calculate ownership duration from sale history
    let ownershipYears = 0;
    if (dashboard.sales_history && dashboard.sales_history.length > 0) {
      const lastSale = dashboard.sales_history[0];
      if (lastSale.sale_date) {
        const purchaseDate = new Date(lastSale.sale_date);
        ownershipYears = Math.floor((new Date() - purchaseDate) / (1000 * 60 * 60 * 24 * 365.25));
      }
    }

    // Calculate motivation score
    let motivationScore = 0;
    const motivationFactors = [];

    if (isAbsentee) {
      motivationScore += 20;
      motivationFactors.push('Absentee owner');
    }

    if (ownershipYears >= 15) {
      motivationScore += 25;
      motivationFactors.push(`${ownershipYears}+ years ownership`);
    } else if (ownershipYears >= 10) {
      motivationScore += 15;
      motivationFactors.push(`${ownershipYears} years ownership`);
    }

    if (owner.is_corporate) {
      motivationScore += 15;
      motivationFactors.push('Corporate owner');
    }

    // High equity check
    const mortgage = summary.mortgage;
    let likelyFreeAndClear = false;
    if (!mortgage || !mortgage.amount) {
      likelyFreeAndClear = true;
      motivationScore += 20;
      motivationFactors.push('Likely owns free and clear');
    }

    // Property age
    if (summary.age >= 40) {
      motivationScore += 10;
      motivationFactors.push(`${summary.age} year old property`);
    }

    return {
      ok: true,
      property: {
        ...dashboard,
        absenteeAnalysis: {
          isAbsentee,
          ownershipYears,
          likelyFreeAndClear,
          motivationScore,
          motivationFactors,
          ownerContact: {
            name: owner.owner1_name,
            name2: owner.owner2_name,
            isCorporate: owner.is_corporate,
            mailingAddress: owner.mailing_address
          },
          outreachRecommendation: getOutreachRecommendation(motivationScore, motivationFactors)
        }
      }
    };
  } catch (error) {
    console.error('[ATTOM Absentee] Detail error:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Generate outreach recommendation based on motivation score
 */
function getOutreachRecommendation(score, factors) {
  if (score >= 70) {
    return {
      priority: 'HIGH',
      approach: 'Direct mail + phone call follow-up',
      timing: 'Immediate',
      message: 'Strong seller motivation indicators. Multiple factors suggest willingness to sell at discount.',
      suggestedOffer: '75-85% of market value'
    };
  } else if (score >= 50) {
    return {
      priority: 'MEDIUM',
      approach: 'Direct mail campaign (3-touch)',
      timing: 'Within 2 weeks',
      message: 'Moderate seller motivation. Worth pursuing with persistent, professional outreach.',
      suggestedOffer: '80-90% of market value'
    };
  } else if (score >= 30) {
    return {
      priority: 'LOW',
      approach: 'Add to drip campaign',
      timing: 'Monthly touches',
      message: 'Lower motivation but still absentee. Long-term nurture opportunity.',
      suggestedOffer: '85-95% of market value'
    };
  } else {
    return {
      priority: 'MONITOR',
      approach: 'Database only',
      timing: 'Quarterly review',
      message: 'Limited motivation signals. Keep in database for future opportunities.',
      suggestedOffer: 'Market value'
    };
  }
}

// ==================== ATTOM SALES TREND / ZIP APPRECIATION ====================

/**
 * Fetch ZIP-level sales trends from ATTOM for appreciation calculation
 * This provides more granular data than FRED metro-level HPI
 * 
 * @param {string} zipCode - 5-digit ZIP code
 * @param {string} startDate - Start date (YYYY-MM-DD or ISO format)
 * @param {string} endDate - End date (YYYY-MM-DD or ISO format)
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
async function fetchZipSalesTrend(zipCode, startDate = null, endDate = null) {
  try {
    if (!ATTOM_API_KEY) {
      return { ok: false, error: 'ATTOM_API_KEY not configured' };
    }
    
    // ATTOM Sales Trend endpoint - v4 API
    const url = new URL('https://api.gateway.attomdata.com/v4/transaction/salestrend');
    url.searchParams.set('postalcode', zipCode);
    
    // Default to last 24 months if no dates specified
    if (startDate) {
      const d = new Date(startDate);
      url.searchParams.set('startyear', d.getFullYear().toString());
      url.searchParams.set('startmonth', (d.getMonth() + 1).toString().padStart(2, '0'));
    }
    if (endDate) {
      const d = new Date(endDate);
      url.searchParams.set('endyear', d.getFullYear().toString());
      url.searchParams.set('endmonth', (d.getMonth() + 1).toString().padStart(2, '0'));
    }
    
    console.log(`[ATTOM SalesTrend] Fetching ZIP ${zipCode} appreciation data...`);
    console.log(`[ATTOM SalesTrend] URL: ${url.toString()}`);
    
    const response = await fetchAttom(url.toString(), {
      headers: { ...HEADERS },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    
    if (!response.ok) {
      console.log(`[ATTOM SalesTrend] API error: ${response.status}`);
      return { ok: false, error: `ATTOM API error: ${response.status}` };
    }
    
    const data = await response.json();
    console.log(`[ATTOM SalesTrend] Response received, processing...`);
    
    // Extract the sales trend data
    const salesTrend = data.salesTrend || data.SalesTrend || data.saleTrend || [];
    
    if (!Array.isArray(salesTrend) || salesTrend.length === 0) {
      console.log('[ATTOM SalesTrend] No trend data in response');
      return { ok: false, error: 'No sales trend data available for this ZIP' };
    }
    
    // Normalize the data points
    const trendPoints = salesTrend.map(point => ({
      year: point.year || point.Year,
      month: point.month || point.Month,
      medianSalePrice: point.medianSalePrice || point.MedianSalePrice || point.mediansaleprice,
      avgSalePrice: point.avgSalePrice || point.AvgSalePrice || point.avgsaleprice,
      salesCount: point.salesCount || point.SalesCount || point.salescount,
      medianPricePerSqFt: point.medianPricePerSqFt || point.MedianPricePerSqFt,
      avgDOM: point.avgDOM || point.AvgDOM
    })).filter(p => p.medianSalePrice || p.avgSalePrice);
    
    return { 
      ok: true, 
      data: {
        zipCode,
        trendPoints,
        dataPointCount: trendPoints.length
      }
    };
    
  } catch (error) {
    console.error('[ATTOM SalesTrend] Error:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Calculate appreciation from ATTOM AVM history for a specific property
 * Most accurate method - uses property-specific valuation history
 * 
 * @param {string} attomId - ATTOM property ID
 * @param {Date|string} startDate - Before date
 * @param {Date|string} endDate - After date
 * @returns {Promise<{appreciationPercent: number, confidence: number, dataSource: string, ...}>}
 */
async function calculatePropertyAVMAppreciation(attomId, startDate, endDate) {
  try {
    if (!ATTOM_API_KEY || !attomId) {
      return { ok: false, error: 'ATTOM_API_KEY or attomId not provided' };
    }
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Fetch AVM history for the property
    const url = new URL(`${BASE_V1}/avmhistory/detail`);
    url.searchParams.set('attomId', attomId);
    
    console.log(`[ATTOM AVM History] Fetching for property ${attomId}...`);
    
    const response = await fetchAttom(url.toString(), {
      headers: { ...HEADERS },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    
    if (!response.ok) {
      return { ok: false, error: `ATTOM API error: ${response.status}` };
    }
    
    const data = await response.json();
    const property = firstProp(data);
    
    if (!property) {
      return { ok: false, error: 'No property data returned' };
    }
    
    // Extract AVM history
    const avmHistory = property.avmhistory || property.avmHistory || property.avm || [];
    
    if (!Array.isArray(avmHistory) || avmHistory.length < 2) {
      return { ok: false, error: 'Insufficient AVM history data' };
    }
    
    // Find values closest to our dates
    const findClosest = (targetDate, history) => {
      let closest = history[0];
      let closestDiff = Math.abs(new Date(history[0].date || history[0].eventDate) - targetDate);
      
      for (const h of history) {
        const date = new Date(h.date || h.eventDate || h.avmDate);
        const diff = Math.abs(date - targetDate);
        if (diff < closestDiff) {
          closest = h;
          closestDiff = diff;
        }
      }
      return { entry: closest, daysDiff: closestDiff / (24 * 60 * 60 * 1000) };
    };
    
    const startMatch = findClosest(start, avmHistory);
    const endMatch = findClosest(end, avmHistory);
    
    // Extract values (handle nested structures)
    const getValue = (entry) => {
      if (typeof entry.value === 'number') return entry.value;
      if (typeof entry.amount === 'number') return entry.amount;
      if (entry.avm?.value) return entry.avm.value;
      if (entry.amount?.value) return entry.amount.value;
      return null;
    };
    
    const startValue = getValue(startMatch.entry);
    const endValue = getValue(endMatch.entry);
    
    if (!startValue || !endValue) {
      return { ok: false, error: 'Could not extract AVM values' };
    }
    
    const appreciationPercent = ((endValue - startValue) / startValue) * 100;
    const monthsHeld = (end - start) / (30.44 * 24 * 60 * 60 * 1000);
    const annualizedRate = monthsHeld > 0 ? (appreciationPercent / monthsHeld) * 12 : appreciationPercent;
    
    // Confidence based on how close the data points are to actual dates
    const avgDaysDiff = (startMatch.daysDiff + endMatch.daysDiff) / 2;
    const confidence = Math.max(0.5, Math.min(1.0, 1 - (avgDaysDiff / 180)));
    
    return {
      ok: true,
      appreciationPercent,
      annualizedRate,
      startValue,
      endValue,
      confidence,
      dataSource: 'ATTOM Property AVM History',
      granularity: 'property-specific',
      monthsAnalyzed: monthsHeld
    };
    
  } catch (error) {
    console.error('[ATTOM AVM History] Error:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Calculate ZIP-level appreciation from ATTOM sales trends
 * More granular than metro-level FRED data
 * 
 * @param {string} zipCode - 5-digit ZIP code
 * @param {Date|string} startDate - Before date
 * @param {Date|string} endDate - After date
 * @returns {Promise<{appreciationPercent: number, confidence: number, dataSource: string, ...}>}
 */
async function calculateZipAppreciation(zipCode, startDate, endDate) {
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    const trendResult = await fetchZipSalesTrend(zipCode, startDate, endDate);
    
    if (!trendResult.ok || !trendResult.data?.trendPoints?.length) {
      return { ok: false, error: trendResult.error || 'No trend data' };
    }
    
    const points = trendResult.data.trendPoints;
    
    // Find the trend points closest to our dates
    const findClosest = (targetDate, trendPoints) => {
      let closest = trendPoints[0];
      let closestDiff = Infinity;
      
      for (const p of trendPoints) {
        // Construct date from year/month
        const pointDate = new Date(p.year, (p.month || 1) - 1, 15); // Mid-month
        const diff = Math.abs(pointDate - targetDate);
        if (diff < closestDiff) {
          closest = p;
          closestDiff = diff;
        }
      }
      return { point: closest, daysDiff: closestDiff / (24 * 60 * 60 * 1000) };
    };
    
    const startMatch = findClosest(start, points);
    const endMatch = findClosest(end, points);
    
    // Use median sale price as primary metric
    const startPrice = startMatch.point.medianSalePrice || startMatch.point.avgSalePrice;
    const endPrice = endMatch.point.medianSalePrice || endMatch.point.avgSalePrice;
    
    if (!startPrice || !endPrice) {
      return { ok: false, error: 'Could not extract price data from trend' };
    }
    
    const appreciationPercent = ((endPrice - startPrice) / startPrice) * 100;
    const monthsHeld = (end - start) / (30.44 * 24 * 60 * 60 * 1000);
    const annualizedRate = monthsHeld > 0 ? (appreciationPercent / monthsHeld) * 12 : appreciationPercent;
    
    // Confidence based on data quality
    const avgDaysDiff = (startMatch.daysDiff + endMatch.daysDiff) / 2;
    const pointCount = points.length;
    const baseConfidence = Math.max(0.4, Math.min(0.9, 1 - (avgDaysDiff / 90)));
    const countBonus = Math.min(0.1, pointCount / 100);
    const confidence = Math.min(0.95, baseConfidence + countBonus);
    
    console.log(`[ATTOM ZIP Appreciation] ZIP ${zipCode}: ${appreciationPercent.toFixed(2)}% over ${monthsHeld.toFixed(1)} months`);
    
    return {
      ok: true,
      appreciationPercent,
      annualizedRate,
      startPrice,
      endPrice,
      startDate: `${startMatch.point.year}-${String(startMatch.point.month || 1).padStart(2, '0')}`,
      endDate: `${endMatch.point.year}-${String(endMatch.point.month || 1).padStart(2, '0')}`,
      confidence,
      dataSource: 'ATTOM ZIP Sales Trend',
      granularity: 'zip-code',
      zipCode,
      monthsAnalyzed: monthsHeld,
      dataPointCount: pointCount
    };
    
  } catch (error) {
    console.error('[ATTOM ZIP Appreciation] Error:', error.message);
    return { ok: false, error: error.message };
  }
}

// ============================================================================
// ASSUMABLE MORTGAGE SCANNER
// Bulk scan ZIP codes for FHA/VA/USDA assumable mortgages on any property type
// Prioritizes multifamily (2-4 units) with government-backed low-rate loans
// ============================================================================

/**
 * Deal tier classification for assumable mortgages
 * Tier 1: VA multifamily — no MI, anyone can assume
 * Tier 2: FHA multifamily — has MIP but very common, house-hack play
 * Tier 3: VA single-family — no MI, must occupy 12 months
 * Tier 4: FHA single-family — MIP for life, must occupy 12 months
 * Tier 5: USDA — rare on multifamily, income-restricted
 */
function calculateDealTier(loanType, propertyClass, rateSavings, remainingBalance) {
  const isMultifamily = /MFR|MULTI|DUPLEX|TRIPLEX|FOURPLEX|2-4/i.test(propertyClass || '');
  const hasGoodRate = (rateSavings || 0) >= 1.0;
  const hasGreatRate = (rateSavings || 0) >= 2.0;
  const hasSubstantialBalance = (remainingBalance || 0) >= 100000;

  if (loanType === 'VA' && isMultifamily && hasGreatRate && hasSubstantialBalance) {
    return { tier: 1, label: '🏆 UNICORN', color: 'purple', description: 'VA Multifamily — No MI, massive rate savings' };
  }
  if (loanType === 'VA' && isMultifamily && hasGoodRate) {
    return { tier: 1, label: '🏆 TIER 1', color: 'purple', description: 'VA Multifamily — No MI, assumable by anyone' };
  }
  if (loanType === 'FHA' && isMultifamily && hasGreatRate && hasSubstantialBalance) {
    return { tier: 2, label: '🔥 TIER 2', color: 'red', description: 'FHA Multifamily — House-hack with locked rate' };
  }
  if (loanType === 'FHA' && isMultifamily && hasGoodRate) {
    return { tier: 2, label: '🔥 TIER 2', color: 'red', description: 'FHA Multifamily — House-hack play' };
  }
  if (loanType === 'VA' && hasGreatRate && hasSubstantialBalance) {
    return { tier: 3, label: '⭐ TIER 3', color: 'gold', description: 'VA SFR — No MI, 12-month occupancy' };
  }
  if (loanType === 'VA' && hasGoodRate) {
    return { tier: 3, label: '⭐ TIER 3', color: 'gold', description: 'VA SFR — No MI, must occupy' };
  }
  if (loanType === 'FHA' && hasGreatRate && hasSubstantialBalance) {
    return { tier: 4, label: '✅ TIER 4', color: 'green', description: 'FHA SFR — Rate lock with MIP' };
  }
  if (loanType === 'FHA' && hasGoodRate) {
    return { tier: 4, label: '✅ TIER 4', color: 'green', description: 'FHA SFR — Assumable with MIP' };
  }
  if ((loanType === 'USDA' || loanType === 'RHS') && hasGoodRate) {
    return { tier: 5, label: '🌾 TIER 5', color: 'green', description: 'USDA — Income-restricted, rural' };
  }
  // Assumable but weak rate savings
  if (['FHA', 'VA', 'USDA', 'RHS'].includes(loanType)) {
    return { tier: 6, label: '📋 LOW PRIORITY', color: 'gray', description: `${loanType} — Assumable but minimal rate advantage` };
  }
  return null; // Not assumable
}

/**
 * Scan a geographic area for properties with assumable mortgages.
 * Auto-paginates through ATTOM's detailmortgageowner endpoint (100/page).
 * Filters for FHA/VA/USDA loans and ranks by deal quality.
 *
 * @param {Object} options
 * @param {string} options.zipCode - ZIP code to scan
 * @param {string} options.county - County FIPS code (alternative)
 * @param {number} options.latitude - Lat for radius search
 * @param {number} options.longitude - Lng for radius search
 * @param {number} options.radius - Radius in miles (default 5)
 * @param {string[]} options.propertyTypes - ['SFR','MFR'] etc. Default: ['SFR','MFR']
 * @param {number} options.minRateSavings - Minimum rate savings vs current (default 0.5)
 * @param {number} options.minBalance - Minimum remaining balance (default 50000)
 * @param {number} options.maxPages - Max pages to scan (default 5 = 500 properties)
 * @param {string} options.originatedAfter - Only loans after this date (default '2019-01-01')
 * @param {string} options.originatedBefore - Only loans before this date (default '2024-01-01')
 */
async function scanAssumableMortgages(options = {}) {
  if (!ATTOM_API_KEY) throw new Error('ATTOM_API_KEY missing on server');

  const {
    zipCode,
    county,
    latitude,
    longitude,
    radius = 5,
    propertyTypes = ['SFR', 'MFR'],
    minRateSavings = 0.5,
    minBalance = 50000,
    maxPages = 5,
    originatedAfter = '2019-01-01',
    originatedBefore = '2024-01-01',
    sortBy = 'tier' // 'tier', 'rateSavings', 'balance', 'monthlySavings'
  } = options;

  const startTime = Date.now();
  const allAssumableDeals = [];
  let totalScanned = 0;
  let totalWithMortgage = 0;
  let totalAssumable = 0;
  const loanTypeBreakdown = { FHA: 0, VA: 0, USDA: 0, CNV: 0, ARM: 0, OTHER: 0, UNKNOWN: 0 };

  console.log(`[Assumable Scanner] Starting scan — ZIP: ${zipCode || 'N/A'}, County: ${county || 'N/A'}, Types: ${propertyTypes.join(',')}, MaxPages: ${maxPages}`);

  try {
    // Scan each property type separately (ATTOM doesn't support multi-type in one call)
    for (const propType of propertyTypes) {
      let currentPage = 1;
      let hasMore = true;

      while (hasMore && currentPage <= maxPages) {
        // Build request URL
        const searchParams = new URLSearchParams();
        
        if (zipCode) {
          searchParams.set('postalcode', zipCode);
        } else if (latitude && longitude) {
          searchParams.set('latitude', latitude.toString());
          searchParams.set('longitude', longitude.toString());
          searchParams.set('radius', radius.toString());
          searchParams.set('orderby', 'distance');
        } else if (county) {
          searchParams.set('countyfips', county);
        } else {
          return { ok: false, error: 'Must provide zipCode, county, or lat/lng coordinates' };
        }

        searchParams.set('pagesize', '100');
        searchParams.set('page', currentPage.toString());

        const url = `${BASE_V1}/property/detailmortgageowner?${searchParams.toString()}`;
        console.log(`[Assumable Scanner] Fetching page ${currentPage} for ${propType}...`);

        const response = await fetchAttom(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[Assumable Scanner] API error ${response.status} on page ${currentPage}:`, errorText.substring(0, 300));
          // If 404 or no results, stop pagination for this type
          if (response.status === 404 || response.status === 400) break;
          // On rate limit, wait and retry
          if (response.status === 429) {
            console.log('[Assumable Scanner] Rate limited, waiting 2s...');
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          break;
        }

        const data = await response.json();
        const properties = data.property || [];
        
        console.log(`[Assumable Scanner] Page ${currentPage}/${propType}: ${properties.length} properties`);
        
        if (properties.length === 0) {
          hasMore = false;
          break;
        }

        // Process each property
        for (const prop of properties) {
          totalScanned++;
          
          const mortgage = prop.mortgage || {};
          const summary = prop.summary || {};
          const address = prop.address || {};
          const building = prop.building || {};
          const owner = prop.owner || {};
          const sale = prop.sale || {};
          const assessment = prop.assessment || {};
          const identifier = prop.identifier || {};
          const lot = prop.lot || {};

          // Check property type match (loose match)
          const propClass = (summary.propclass || summary.propType || '').toUpperCase();
          const isMultifamily = /MFR|MULTI|DUPLEX|TRIPLEX|FOURPLEX|2-4/i.test(propClass);
          const isSFR = /SFR|SINGLE|RESIDENTIAL/i.test(propClass);
          
          if (propType === 'MFR' && !isMultifamily) continue;
          if (propType === 'SFR' && !isSFR && !isMultifamily) continue;

          // Must have mortgage data
          const mortgageAmount = mortgage.amount || mortgage.loanamount || 0;
          if (!mortgageAmount || mortgageAmount <= 0) continue;
          totalWithMortgage++;

          // Get loan type
          const loanType = (mortgage.loantypecode || mortgage.loanTypeCode || mortgage.loan_type || '').toUpperCase();
          
          // Track breakdown
          if (loanType === 'FHA') loanTypeBreakdown.FHA++;
          else if (loanType === 'VA') loanTypeBreakdown.VA++;
          else if (loanType === 'USDA' || loanType === 'RHS') loanTypeBreakdown.USDA++;
          else if (loanType === 'CNV' || loanType === 'CONVENTIONAL') loanTypeBreakdown.CNV++;
          else if (loanType === 'ARM') loanTypeBreakdown.ARM++;
          else if (loanType) loanTypeBreakdown.OTHER++;
          else loanTypeBreakdown.UNKNOWN++;

          // Only process assumable types
          const isAssumableType = ['FHA', 'VA', 'USDA', 'RHS'].includes(loanType);
          if (!isAssumableType) continue;

          // Check origination date
          const loanDateStr = mortgage.date || mortgage.loanRecordingDate || mortgage.recordingdate;
          if (!loanDateStr) continue;
          
          const loanDate = new Date(loanDateStr);
          if (originatedAfter && loanDate < new Date(originatedAfter)) continue;
          if (originatedBefore && loanDate > new Date(originatedBefore)) continue;

          // Analyze assumability (includes FRED rate estimation)
          const assumability = await analyzeMortgageAssumability(mortgage);
          
          if (!assumability || assumability.assumable !== 'likely') continue;
          
          // Apply minimum rate savings filter
          const rateSavings = assumability.rateSavings || 0;
          if (rateSavings < minRateSavings) continue;

          // Apply minimum balance filter
          const remainingBalance = assumability.remainingBalance || 0;
          if (remainingBalance < minBalance) continue;

          totalAssumable++;

          // Calculate deal tier
          const dealTier = calculateDealTier(loanType, propClass, rateSavings, remainingBalance);
          if (!dealTier) continue;

          // Calculate monthly payment comparison
          const currentRate = assumability.currentRate || 6.5;
          const assumedRate = assumability.estimatedRate || 0;
          const monthsRemaining = assumability.monthsRemaining || 300;
          
          // Monthly payment on remaining balance at assumed rate
          const monthlyRateAssumed = assumedRate / 100 / 12;
          const assumedPayment = monthlyRateAssumed > 0 
            ? remainingBalance * (monthlyRateAssumed * Math.pow(1 + monthlyRateAssumed, monthsRemaining)) / (Math.pow(1 + monthlyRateAssumed, monthsRemaining) - 1)
            : 0;
          
          // Monthly payment if buying at market rate for same balance
          const monthlyRateMarket = currentRate / 100 / 12;
          const marketPayment = monthlyRateMarket > 0
            ? remainingBalance * (monthlyRateMarket * Math.pow(1 + monthlyRateMarket, monthsRemaining)) / (Math.pow(1 + monthlyRateMarket, monthsRemaining) - 1)
            : 0;
          
          const monthlySavings = marketPayment - assumedPayment;
          const annualSavings = monthlySavings * 12;
          const lifetimeSavings = monthlySavings * monthsRemaining;

          // Property value and gap payment
          const marketValue = assessment.mktTotalValue || assessment.market?.mktTotalValue || 
                             assessment.assdTotalValue || assessment.assessed?.assdTotalValue || 0;
          const gapPayment = Math.max(0, marketValue - remainingBalance);

          // Ownership info
          const saleDate = sale.saleTransDate || sale.saledate;
          let ownershipYears = 0;
          if (saleDate) {
            ownershipYears = Math.floor((new Date() - new Date(saleDate)) / (1000 * 60 * 60 * 24 * 365.25));
          }

          // Build the deal object
          allAssumableDeals.push({
            // Deal classification
            dealTier,
            
            // Property ID
            attomId: identifier.attomId || identifier.id,
            apn: identifier.apn,
            fips: identifier.fips,
            
            // Address
            address: address.oneLine || formatAddress(address),
            streetAddress: address.line1 || `${address.houseNumber || ''} ${address.streetName || ''}`.trim(),
            city: address.locality || '',
            state: address.countrySubd || '',
            zipCode: address.postal1 || '',
            county: address.countrySecSubd || '',
            
            // Property
            propertyType: propClass || propType,
            isMultifamily,
            beds: building.rooms?.beds || 0,
            baths: building.rooms?.bathsTotal || building.rooms?.bathsFull || 0,
            sqft: building.size?.livingSize || building.size?.universalSize || 0,
            lotSizeAcres: lot.lotsize1 || lot.lotsizeacres || 0,
            yearBuilt: summary.yearBuilt || building.yearBuilt || 0,
            units: isMultifamily ? (building.rooms?.roomsTotal ? Math.ceil(building.rooms.roomsTotal / 4) : 2) : 1,
            
            // Values
            marketValue,
            assessedValue: assessment.assdTotalValue || assessment.assessed?.assdTotalValue || 0,
            lastSalePrice: sale.saleAmt || sale.amount || 0,
            lastSaleDate: saleDate,
            
            // Mortgage — the gold
            loanType,
            originalAmount: assumability.originalAmount || mortgageAmount,
            remainingBalance,
            estimatedRate: assumability.estimatedRate,
            rateEstimated: assumability.rateEstimated || false,
            currentMarketRate: currentRate,
            rateSavings,
            loanDate: loanDateStr,
            termMonths: mortgage.term || mortgage.termMonths || 360,
            monthsRemaining: assumability.monthsRemaining,
            percentPaid: assumability.percentPaid,
            lender: mortgage.lenderName || (typeof mortgage.lender === 'object' ? (mortgage.lender?.lastname || mortgage.lender?.companyname || mortgage.lender?.companycode || 'Unknown') : mortgage.lender) || 'Unknown',
            
            // Financial analysis
            assumedPayment: Math.round(assumedPayment),
            marketPayment: Math.round(marketPayment),
            monthlySavings: Math.round(monthlySavings),
            annualSavings: Math.round(annualSavings),
            lifetimeSavings: Math.round(lifetimeSavings),
            gapPayment: Math.round(gapPayment),
            
            // For MIP calculation on FHA
            estimatedMIP: loanType === 'FHA' ? Math.round(remainingBalance * 0.0055 / 12) : 0,
            effectiveMonthlySavings: loanType === 'FHA' 
              ? Math.round(monthlySavings - (remainingBalance * 0.0055 / 12)) 
              : Math.round(monthlySavings),
            
            // Owner info
            owner: {
              name: owner.owner1?.fullname || owner.corporatename || owner.ownername || 'Unknown',
              name2: owner.owner2?.fullname || null,
              isCorporate: owner.corporateindicator === 'Y' || owner.corporateIndicator === 'Y',
              mailingAddress: owner.mailingaddressoneline || formatMailingAddress(owner),
              isAbsentee: (owner.absenteeownerstatus === 'Y' || owner.absenteeOwnerStatus === 'A')
            },
            ownershipYears,
            
            // Location
            latitude: prop.location?.latitude || address.latitude,
            longitude: prop.location?.longitude || address.longitude,
            
            // Assumability detail
            assumability: {
              assumable: assumability.assumable,
              confidence: assumability.confidence,
              reason: assumability.reason,
              attractiveness: assumability.attractiveness,
              nextSteps: assumability.nextSteps,
              disclaimer: assumability.disclaimer
            }
          });
        }

        // If less than 100 results, no more pages
        if (properties.length < 100) {
          hasMore = false;
        } else {
          currentPage++;
          // Small delay between pages to be respectful of rate limits
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }

    // Sort results
    allAssumableDeals.sort((a, b) => {
      if (sortBy === 'rateSavings') return b.rateSavings - a.rateSavings;
      if (sortBy === 'balance') return b.remainingBalance - a.remainingBalance;
      if (sortBy === 'monthlySavings') return b.effectiveMonthlySavings - a.effectiveMonthlySavings;
      // Default: sort by tier (1=best), then by effective monthly savings
      if (a.dealTier.tier !== b.dealTier.tier) return a.dealTier.tier - b.dealTier.tier;
      return b.effectiveMonthlySavings - a.effectiveMonthlySavings;
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`[Assumable Scanner] ✅ Complete in ${elapsed}s — Scanned: ${totalScanned}, With Mortgage: ${totalWithMortgage}, Assumable Deals: ${totalAssumable}`);
    console.log(`[Assumable Scanner] Loan Type Breakdown:`, loanTypeBreakdown);

    return {
      ok: true,
      deals: allAssumableDeals,
      stats: {
        totalScanned,
        totalWithMortgage,
        totalAssumable,
        loanTypeBreakdown,
        elapsedSeconds: parseFloat(elapsed),
        pagesScanned: Math.min(maxPages, Math.ceil(totalScanned / 100)),
        searchCriteria: {
          zipCode, county, latitude, longitude, radius,
          propertyTypes, minRateSavings, minBalance,
          originatedAfter, originatedBefore, sortBy
        }
      }
    };

  } catch (error) {
    console.error('[Assumable Scanner] Error:', error.message, error.stack);
    return { ok: false, error: error.message, deals: [], stats: { totalScanned, totalAssumable } };
  }
}

/**
 * Run absentee search across multiple geographic plans and merge results.
 */
async function searchAbsenteeOwnersBatch(searchPlans = [], baseOptions = {}) {
  const merged = new Map();
  let totalFound = 0;
  let totalQualified = 0;
  let totalScanned = 0;
  const errors = [];
  const cache = {
    searchCacheHits: 0,
    processedLeadCacheHits: 0,
  };

  for (const plan of searchPlans) {
    try {
      const result = await searchAbsenteeOwners({ ...baseOptions, ...plan });
      if (!result.ok) {
        errors.push(result.error || 'search_failed');
        continue;
      }

      totalFound += result.totalFound || 0;
      totalQualified += result.totalQualified || 0;
      totalScanned += result.totalScanned || 0;
      if (result.cache?.searchCacheHit) cache.searchCacheHits += 1;
      cache.processedLeadCacheHits += result.cache?.processedLeadCacheHits || 0;

      for (const property of result.properties || []) {
        const key = property.attomId || property.address;
        if (!key || merged.has(key)) continue;
        merged.set(key, property);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  const properties = annotateOwnerPortfolio([...merged.values()])
    .sort((a, b) => b.motivationScore - a.motivationScore);

  return {
    ok: true,
    properties,
    totalFound,
    totalQualified: properties.length,
    totalScanned,
    page: 1,
    pageSize: properties.length,
    searchPlans: searchPlans.length,
    errors: errors.length ? errors : undefined,
    cache,
  };
}

/**
 * Extract a portfolio key from a raw ATTOM detailmortgageowner property.
 */
function ownerKeyFromRawProp(prop) {
  const owner = prop?.owner || {};
  return normalizeOwnerPortfolioKey({
    name: owner.owner1?.fullname || owner.corporatename || owner.ownername || '',
    mailingZip: owner.mailingaddresszip || '',
    mailingAddress: owner.mailingaddressoneline || formatMailingAddress(owner),
  });
}

function applyPortfolioAnnotation(lead, count, { approximate = true, scope = null } = {}) {
  const ownerPortfolioCount = Number(count) > 0 ? Number(count) : 1;
  const ownerPortfolioBand = portfolioBand(ownerPortfolioCount);
  const motivationFactors = (lead.motivationFactors || []).filter(
    (f) => !/portfolio in this search|Single property in this search|portfolio \(approx/i.test(f),
  );
  let motivationScore = Number(lead.motivationScore) || 0;

  if (ownerPortfolioBand === '2-15') {
    motivationScore += 12;
    motivationFactors.push(
      approximate
        ? `${ownerPortfolioCount}-property portfolio (approx. in scanned ZIPs — mom-and-pop sweet spot)`
        : `${ownerPortfolioCount}-property portfolio in this search (mom-and-pop sweet spot)`,
    );
  } else if (ownerPortfolioBand === '1') {
    motivationFactors.push(
      approximate
        ? 'Single property found in scanned ZIPs (possible accidental landlord)'
        : 'Single property in this search (possible accidental landlord)',
    );
  } else if (ownerPortfolioBand === '16+') {
    motivationScore -= 8;
    motivationFactors.push(
      approximate
        ? `${ownerPortfolioCount}-property portfolio (approx. — likely professional)`
        : `${ownerPortfolioCount}-property portfolio in this search (likely professional — deprioritize)`,
    );
  }

  return {
    ...lead,
    ownerPortfolioCount,
    ownerPortfolioBand,
    ownerPortfolioKey: normalizeOwnerPortfolioKey(lead.owner),
    ownerPortfolioApproximate: approximate,
    ownerPortfolioScope: scope,
    motivationScore,
    motivationFactors,
  };
}

/**
 * Look up one property address as an absentee/rental lead:
 * owner identity + motivation, optional ZIP-scoped portfolio estimate.
 * Does not require absentee status (vacant rentals may still show owner-occupied).
 */
async function lookupAbsenteeLeadByAddress(address, options = {}) {
  if (!ATTOM_API_KEY) throw new Error('ATTOM_API_KEY missing on server');

  const trimmed = String(address || '').trim();
  if (!trimmed) return { ok: false, error: 'missing_address' };

  const {
    includePortfolioEstimate = true,
    portfolioPageSize = 100,
  } = options;

  console.log(`[ATTOM LeadLookup] Looking up address: ${trimmed}`);
  const resp = await attomGet(`${BASE_V1}/property/detailmortgageowner`, { address: trimmed });
  if (!resp.ok) {
    return {
      ok: false,
      error: resp.status === 404 ? 'Property not found' : (resp.error || `ATTOM returned ${resp.status}`),
    };
  }

  const prop = firstProp(resp.data);
  if (!prop) return { ok: false, error: 'Property not found' };

  let lead = await processAbsenteeProperty(prop, {});
  if (!lead) return { ok: false, error: 'Failed to process property' };

  const owner = prop.owner || {};
  const absenteeStatus = owner.absenteeownerstatus || owner.absenteeOwnerStatus || owner.absenteeInd;
  const isAbsentee = absenteeStatus === 'Y' || absenteeStatus === 'A' || absenteeStatus === 'Absentee Owner';
  lead = {
    ...lead,
    isAbsentee: Boolean(isAbsentee || lead.isOutOfState),
    absenteeStatus: absenteeStatus || null,
  };

  const portfolioMeta = {
    approximate: true,
    zipsScanned: [],
    sampleAddresses: [],
    scannedPropertyCount: 0,
    matchedCount: 1,
    note: null,
  };

  if (includePortfolioEstimate) {
    const ownerKey = normalizeOwnerPortfolioKey(lead.owner);
    const zips = [...new Set(
      [lead.zipCode, lead.owner?.mailingZip]
        .map((z) => String(z || '').replace(/\D/g, '').slice(0, 5))
        .filter((z) => z.length === 5),
    )];
    portfolioMeta.zipsScanned = zips;

    const matched = new Map();
    if (lead.attomId) matched.set(String(lead.attomId), lead.address);
    else if (lead.address) matched.set(lead.address.toLowerCase(), lead.address);

    const pageSize = Math.min(Math.max(Number(portfolioPageSize) || 100, 20), 100);

    for (const zip of zips) {
      try {
        const url = `${BASE_V1}/property/detailmortgageowner?postalcode=${encodeURIComponent(zip)}&pagesize=${pageSize}&page=1`;
        const response = await fetchAttom(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          console.warn(`[ATTOM LeadLookup] Portfolio ZIP ${zip} returned ${response.status}`);
          continue;
        }
        const data = await response.json();
        const properties = Array.isArray(data.property) ? data.property : [];
        portfolioMeta.scannedPropertyCount += properties.length;

        for (const candidate of properties) {
          if (!ownerKey) break;
          const candidateKey = ownerKeyFromRawProp(candidate);
          if (!candidateKey || candidateKey !== ownerKey) continue;

          const id = candidate.identifier?.attomId || candidate.identifier?.id;
          const addr = candidate.address?.oneLine || formatAddress(candidate.address || {});
          const mapKey = id ? String(id) : (addr || '').toLowerCase();
          if (mapKey) matched.set(mapKey, addr || mapKey);
        }
      } catch (error) {
        console.warn(`[ATTOM LeadLookup] Portfolio ZIP ${zip} failed:`, error.message);
      }
    }

    const count = Math.max(matched.size, 1);
    portfolioMeta.matchedCount = count;
    portfolioMeta.sampleAddresses = [...matched.values()].filter(Boolean).slice(0, 12);
    portfolioMeta.note = ownerKey
      ? `Approximate count from matching owner name + mailing within ZIP(s) ${zips.join(', ') || 'n/a'} (up to ${pageSize} properties per ZIP). Not a nationwide portfolio.`
      : 'Could not build an owner identity key — portfolio estimate unavailable.';

    const scope = portfolioMeta.note;
    lead = applyPortfolioAnnotation(lead, ownerKey ? count : 1, {
      approximate: true,
      scope,
    });
    if (!ownerKey) {
      lead.ownerPortfolioCount = null;
      lead.ownerPortfolioBand = 'unknown';
    }
  }

  return {
    ok: true,
    lead,
    portfolio: portfolioMeta,
  };
}

export { 
  fetchSalesComparables, 
  searchAbsenteeOwners,
  searchAbsenteeOwnersBatch,
  getAbsenteePropertyDetails,
  lookupAbsenteeLeadByAddress,
  fetchZipSalesTrend,
  calculatePropertyAVMAppreciation,
  calculateZipAppreciation,
  scanAssumableMortgages,
  matchesPropertyTypeFilter,
  isLikelyCorporateOwner,
};
