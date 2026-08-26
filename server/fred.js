import 'dotenv/config';
import CBSA_CATALOG from './cbsa-catalog.js';
import { CITY_PREFIX_MAP, STATE_FIPS } from './city-prefix-map.js';

const FRED_API_KEY = process.env.FRED_API_KEY;
const FRED_BASE_URL = 'https://api.stlouisfed.org/fred';
const FED_RSS_URL = 'https://www.federalreserve.gov/feeds/press_all.xml';
const FCC_CENSUS_API = 'https://geo.fcc.gov/api/census/area';

// ── In-memory caches to prevent FRED API rate-limit / IP bans ──
const _fredCache = new Map();          // key → { data, ts }
const FRED_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Heat-map result cache (metric → { data, ts })
const _heatMapCache = new Map();
const HEATMAP_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

// ── Token-bucket rate limiter: max ~90 req/min (1 request per 670ms) ──
// FRED allows 120/min but we leave headroom for fallbacks + other endpoints
const _rlInterval = 670;          // ms between requests
let _rlLastSent = 0;
let _rlQueue = Promise.resolve();

function enqueue(fn) {
  _rlQueue = _rlQueue
    .then(async () => {
      const now = Date.now();
      const wait = Math.max(0, _rlInterval - (now - _rlLastSent));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      _rlLastSent = Date.now();
      return fn();
    })
    .catch(async (err) => {
      // still enforce spacing even on error paths
      _rlLastSent = Date.now();
      return fn();
    });
  return _rlQueue;
}

/**
 * Get county FIPS code from latitude/longitude using FCC Census API
 * @param {number} latitude - Latitude
 * @param {number} longitude - Longitude
 * @returns {Promise<{countyFips: string, countyName: string, stateFips: string, stateCode: string} | null>}
 */
export async function getCountyFipsFromCoords(latitude, longitude) {
  try {
    const url = `${FCC_CENSUS_API}?lat=${latitude}&lon=${longitude}&format=json`;
    console.log('[FRED] Looking up county FIPS for:', latitude, longitude);
    
    const response = await fetch(url);
    if (!response.ok) {
      console.error('[FRED] FCC API error:', response.status);
      return null;
    }
    
    const data = await response.json();
    const result = data.results?.[0];
    
    if (!result) {
      console.log('[FRED] No census data found for coordinates');
      return null;
    }
    
    return {
      countyFips: result.county_fips,
      countyName: result.county_name,
      stateFips: result.state_fips,
      stateCode: result.state_code,
      stateName: result.state_name
    };
  } catch (error) {
    console.error('[FRED] Error getting county FIPS:', error);
    return null;
  }
}

/**
 * Get county-level economic data dynamically by FIPS code
 * No hardcoding needed - constructs series IDs from FIPS
 * @param {string} countyFips - 5-digit county FIPS code (e.g., '06075' for San Francisco)
 * @param {string} countyName - County name for logging
 * @returns {Promise<object>} - County economic data
 */
export async function getCountyData(countyFips, countyName = 'Unknown') {
  try {
    console.log(`[FRED] Fetching county data for ${countyName} (FIPS: ${countyFips})`);
    
    // FRED series patterns for county-level data:
    // - New listings: NEWLISCOU{FIPS} (monthly)
    // - Active listings: ACTLISCOU{FIPS} (monthly)
    // - Building permits: BPPRIV{FIPS} (monthly, may not exist for all counties)
    // - Unemployment: {stFIPS}{coFIPS}URN (monthly)
    
    const [newListings, activeListings, buildingPermits, unemployment] = await Promise.all([
      trySeriesWithFallback([`NEWLISCOU${countyFips}`], { limit: 24, sort_order: 'desc' })
        .catch(() => ({ observations: [] })),
      trySeriesWithFallback([`ACTLISCOU${countyFips}`], { limit: 24, sort_order: 'desc' })
        .catch(() => ({ observations: [] })),
      trySeriesWithFallback([`BPPRIV${countyFips}`], { limit: 24, sort_order: 'desc' })
        .catch(() => ({ observations: [] })),
      trySeriesWithFallback([`${countyFips}URN`], { limit: 24, sort_order: 'desc' })
        .catch(() => ({ observations: [] }))
    ]);
    
    // Helper to calculate YoY change
    const calcYoY = (obs) => {
      if (!obs || obs.length < 13) return null;
      const current = parseFloat(obs[0]?.value);
      const yearAgo = parseFloat(obs[12]?.value);
      if (isNaN(current) || isNaN(yearAgo) || yearAgo === 0) return null;
      return ((current - yearAgo) / yearAgo * 100).toFixed(1);
    };
    
    const newListingsObs = newListings.observations || [];
    const activeListingsObs = activeListings.observations || [];
    const permitsObs = buildingPermits.observations || [];
    const unemploymentObs = unemployment.observations || [];
    
    return {
      countyFips,
      countyName,
      supply: {
        newListings: {
          value: newListingsObs[0]?.value || null,
          date: newListingsObs[0]?.date || null,
          yoy: calcYoY(newListingsObs),
          series: `NEWLISCOU${countyFips}`,
          available: newListingsObs.length > 0
        },
        activeListings: {
          value: activeListingsObs[0]?.value || null,
          date: activeListingsObs[0]?.date || null,
          yoy: calcYoY(activeListingsObs),
          series: `ACTLISCOU${countyFips}`,
          available: activeListingsObs.length > 0
        },
        buildingPermits: {
          value: permitsObs[0]?.value || null,
          date: permitsObs[0]?.date || null,
          yoy: calcYoY(permitsObs),
          series: `BPPRIV${countyFips}`,
          available: permitsObs.length > 0
        }
      },
      labor: {
        unemployment: {
          value: unemploymentObs[0]?.value || null,
          date: unemploymentObs[0]?.date || null,
          change: unemploymentObs.length >= 2 
            ? (parseFloat(unemploymentObs[0]?.value) - parseFloat(unemploymentObs[1]?.value)).toFixed(1)
            : null,
          series: `${countyFips}URN`,
          available: unemploymentObs.length > 0
        }
      },
      charts: {
        newListings: newListingsObs.slice().reverse().map(o => ({ date: o.date, value: parseFloat(o.value) })),
        activeListings: activeListingsObs.slice().reverse().map(o => ({ date: o.date, value: parseFloat(o.value) })),
        buildingPermits: permitsObs.slice().reverse().map(o => ({ date: o.date, value: parseFloat(o.value) })),
        unemployment: unemploymentObs.slice().reverse().map(o => ({ date: o.date, value: parseFloat(o.value) }))
      }
    };
  } catch (error) {
    console.error('[FRED] Error fetching county data:', error);
    throw error;
  }
}

/**
 * Generic FRED API request handler
 * @param {string} endpoint - FRED API endpoint (e.g., 'series/observations')
 * @param {object} params - Query parameters
 * @returns {Promise<object>} - API response
 */
async function fredRequest(endpoint, params = {}) {
  const url = new URL(`${FRED_BASE_URL}/${endpoint}`);
  url.searchParams.append('api_key', FRED_API_KEY);
  url.searchParams.append('file_type', 'json');
  
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, value.toString());
    }
  });

  // ── Check cache first ──
  const cacheKey = url.toString().replace(FRED_API_KEY, '');
  const cached = _fredCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FRED_CACHE_TTL) {
    return cached.data;
  }

  console.log('[FRED] Request URL:', url.toString().replace(FRED_API_KEY, 'API_KEY_HIDDEN'));

  // ── Queue the actual HTTP call so we never burst ──
  const doFetch = async () => {
    // Re-check cache (another queued call may have filled it)
    const c2 = _fredCache.get(cacheKey);
    if (c2 && Date.now() - c2.ts < FRED_CACHE_TTL) return c2.data;

    // Retry with exponential back-off for 429 rate-limit errors
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url.toString());
      
      if (response.status === 429) {
        if (attempt < MAX_RETRIES) {
          const backoff = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          console.warn(`[FRED] 429 rate-limited, retry ${attempt + 1}/${MAX_RETRIES} after ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        // Final attempt still 429 — throw
        const errorText = await response.text();
        console.error('[FRED] Error response (after retries):', errorText);
        throw new Error(`FRED API error: 429 Too Many Requests (after ${MAX_RETRIES} retries)`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[FRED] Error response:', errorText);
        throw new Error(`FRED API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      _fredCache.set(cacheKey, { data, ts: Date.now() });
      return data;
    }
  };

  try {
    return await enqueue(doFetch);
  } catch (error) {
    console.error('[FRED] Request failed:', error);
    throw error;
  }
}

/**
 * Parse XML feed (simple parser for RSS)
 */
function parseXMLFeed(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const item = match[1];
    const title = (item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim();
    const link = (item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
    const description = (item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .trim();
    const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
    
    items.push({ title, link, description, pubDate });
  }
  
  return items;
}

/**
 * Get housing market data including median prices, inventory, and mortgage rates
 * Uses the most frequently-updated FRED series to minimize data staleness:
 *   - ASPUS (monthly avg sales price, ~2 month lag) over MSPUS (quarterly, ~3 month lag)
 *   - MORTGAGE30US (weekly, near-realtime)
 *   - ACTLISCOUUS (monthly active listings, ~1 month lag)
 *   - MSACSR (monthly supply, ~1 month lag)
 *   - CSUSHPISA (monthly Case-Shiller, ~2 month lag)
 *   - CUUR0000SEHA (monthly CPI shelter, ~1 month lag)
 *   - HOUST5F (monthly housing starts, ~1 month lag)
 * Also fetches MSPUS as fallback and for quarterly cross-check.
 */
export async function getHousingMarketData() {
  try {
    // Fetch multiple housing-related series in parallel with extended history
    const [medianPrice, avgSalesPrice, inventory, daysOnMarket, mortgageRate, singleFamily, condos, multiFamily] = await Promise.all([
      // MSPUS: Median Sales Price - quarterly, used as fallback
      fredRequest('series/observations', { 
        series_id: 'MSPUS', 
        limit: 80, 
        sort_order: 'desc' 
      }),
      // ASPUS: Average Sales Price of Houses Sold (monthly, more frequent than MSPUS)
      fredRequest('series/observations', { 
        series_id: 'ASPUS', 
        limit: 180, 
        sort_order: 'desc' 
      }).catch(() => ({ observations: [] })),
      // MSACSR: Monthly Supply of Houses in the United States
      fredRequest('series/observations', { 
        series_id: 'MSACSR', 
        limit: 180, 
        sort_order: 'desc' 
      }),
      // ACTLISCOUUS: Active Listing Count (monthly, ~1 month lag)
      fredRequest('series/observations', { 
        series_id: 'ACTLISCOUUS', 
        limit: 180, 
        sort_order: 'desc' 
      }),
      // MORTGAGE30US: 30-Year Fixed Rate Mortgage Average (weekly, near-realtime)
      fredRequest('series/observations', { 
        series_id: 'MORTGAGE30US', 
        limit: 520, 
        sort_order: 'desc' 
      }),
      // Single family home price index (Case-Shiller, monthly, ~2 month lag)
      fredRequest('series/observations', { 
        series_id: 'CSUSHPISA', 
        limit: 180, 
        sort_order: 'desc' 
      }),
      // Condo price index approximation (CPI Shelter, monthly)
      fredRequest('series/observations', { 
        series_id: 'CUUR0000SEHA', 
        limit: 180, 
        sort_order: 'desc' 
      }),
      // Multi-family housing starts (monthly, ~1 month lag)
      fredRequest('series/observations', { 
        series_id: 'HOUST5F', 
        limit: 180, 
        sort_order: 'desc' 
      })
    ]);

    // Use ASPUS (monthly) if available and more recent than MSPUS (quarterly)
    const aspusLatestDate = avgSalesPrice.observations?.[0]?.date || '';
    const mspusLatestDate = medianPrice.observations?.[0]?.date || '';
    const priceSource = aspusLatestDate > mspusLatestDate && avgSalesPrice.observations?.length > 0
      ? avgSalesPrice
      : medianPrice;
    const priceSourceLabel = priceSource === avgSalesPrice ? 'ASPUS (monthly)' : 'MSPUS (quarterly)';
    console.log(`[FRED] Using price source: ${priceSourceLabel}, latest date: ${priceSource.observations?.[0]?.date}`);

    /**
     * Calculate true Year-over-Year change by finding the observation closest to 12 months ago.
     * For weekly data, look ~52 entries back; for monthly ~12; for quarterly ~4.
     */
    const calculateYoY = (data) => {
      if (!data.observations || data.observations.length < 2) return null;
      const latest = data.observations[0];
      const latestDate = new Date(latest.date);
      const targetDate = new Date(latestDate);
      targetDate.setFullYear(targetDate.getFullYear() - 1);
      
      // Find closest observation to 1 year ago
      let bestMatch = null;
      let bestDiff = Infinity;
      for (const obs of data.observations) {
        const obsDate = new Date(obs.date);
        const diff = Math.abs(obsDate - targetDate);
        if (diff < bestDiff && obs.value !== '.') {
          bestDiff = diff;
          bestMatch = obs;
        }
      }
      
      if (!bestMatch || bestDiff > 90 * 24 * 60 * 60 * 1000) return null; // Skip if >90 days off
      const current = parseFloat(latest.value);
      const previous = parseFloat(bestMatch.value);
      if (isNaN(current) || isNaN(previous) || previous === 0) return null;
      return ((current - previous) / previous * 100).toFixed(1);
    };

    return {
      overview: {
        medianPrice: {
          value: priceSource.observations?.[0]?.value || 'N/A',
          date: priceSource.observations?.[0]?.date || 'N/A',
          yoy: calculateYoY(priceSource),
          source: priceSourceLabel
        },
        inventory: {
          value: inventory.observations?.[0]?.value || 'N/A',
          date: inventory.observations?.[0]?.date || 'N/A',
          yoy: calculateYoY(inventory)
        },
        daysOnMarket: {
          value: daysOnMarket.observations?.[0]?.value || 'N/A',
          date: daysOnMarket.observations?.[0]?.date || 'N/A',
          yoy: calculateYoY(daysOnMarket)
        },
        mortgageRate: {
          value: mortgageRate.observations?.[0]?.value || 'N/A',
          date: mortgageRate.observations?.[0]?.date || 'N/A',
          change: mortgageRate.observations?.length > 1 ? 
            (parseFloat(mortgageRate.observations[0].value) - parseFloat(mortgageRate.observations[1].value)).toFixed(2) : 
            null
        }
      },
      trends: {
        singleFamily: {
          value: singleFamily.observations?.[0]?.value || 'N/A',
          yoy: calculateYoY(singleFamily)
        },
        condos: {
          value: condos.observations?.[0]?.value || 'N/A',
          yoy: calculateYoY(condos)
        },
        multiFamily: {
          value: multiFamily.observations?.[0]?.value || 'N/A',
          yoy: calculateYoY(multiFamily)
        }
      },
      charts: {
        // Use whichever price source is fresher for the main chart
        medianPrice: (priceSource.observations || [])
          .filter(obs => obs.value !== '.')
          .slice()
          .reverse()
          .map(obs => ({
            date: obs.date,
            value: parseFloat(obs.value)
          })),
        inventory: (inventory.observations || [])
          .filter(obs => obs.value !== '.')
          .slice()
          .reverse()
          .map(obs => ({
            date: obs.date,
            value: parseFloat(obs.value)
          })),
        mortgageRate: (mortgageRate.observations || [])
          .filter(obs => obs.value !== '.')
          .slice()
          .reverse()
          .map(obs => ({
            date: obs.date,
            value: parseFloat(obs.value)
          })),
        singleFamily: (singleFamily.observations || [])
          .filter(obs => obs.value !== '.')
          .slice()
          .reverse()
          .map(obs => ({
            date: obs.date,
            value: parseFloat(obs.value)
          })),
        condos: (condos.observations || [])
          .filter(obs => obs.value !== '.')
          .slice()
          .reverse()
          .map(obs => ({
            date: obs.date,
            value: parseFloat(obs.value)
          })),
        multiFamily: (multiFamily.observations || [])
          .filter(obs => obs.value !== '.')
          .slice()
          .reverse()
          .map(obs => ({
            date: obs.date,
            value: parseFloat(obs.value)
          }))
      },
      // Data freshness metadata so the UI can show "as of" dates
      freshness: {
        medianPrice: { date: priceSource.observations?.[0]?.date, source: priceSourceLabel },
        inventory: { date: inventory.observations?.[0]?.date, source: 'MSACSR (monthly)' },
        activeListings: { date: daysOnMarket.observations?.[0]?.date, source: 'ACTLISCOUUS (monthly)' },
        mortgageRate: { date: mortgageRate.observations?.[0]?.date, source: 'MORTGAGE30US (weekly)' },
        singleFamily: { date: singleFamily.observations?.[0]?.date, source: 'CSUSHPISA (monthly)' },
        condos: { date: condos.observations?.[0]?.date, source: 'CUUR0000SEHA (monthly)' },
        multiFamily: { date: multiFamily.observations?.[0]?.date, source: 'HOUST5F (monthly)' }
      }
    };
  } catch (error) {
    console.error('[FRED] Error fetching housing market data:', error);
    throw error;
  }
}

/**
 * Regional codes mapping for major metros
 * Using multiple series with fallbacks for better data coverage
 * Series types: housing price index, Zillow HVI, unemployment rate, per capita income, median household income
 */
const METRO_CODES = {
    'san-francisco': {
    name: 'San Francisco-Oakland-Hayward, CA',
    housing: ['SFXRSA', 'ATNHPIUS41884Q'], // All-Transactions House Price Index
    unemployment: ['SANF006URN', 'CAUR', 'UNRATE'], // Metro unemployment -> State -> National
    income: ['MHICA41884', 'MEHOINUSCAA672N', 'MEPAINUSA672N'], // Metro median household income -> State -> National
    wages: ['SMU06418000500000011SA', 'CES0500000003', 'AHETPI'], // Average hourly earnings
    zillow: 'SFXRSA', // Zillow Home Value Index if available
    // Supply indicators (leading indicators for future vacancy/rent pressure)
    buildingPermits: ['SANF806BPPRIVSA', 'SANF806BPPRIV'], // MSA building permits (monthly)
    countyFips: '06075', // San Francisco County for county-level data
    newListings: 'NEWLISCOU6075', // Monthly new listings
    activeListings: 'ACTLISCOU6075', // Monthly active inventory
    // Demand indicators
    population: 'SFCPOP' // MSA resident population (annual)
  },
  'austin': {
    name: 'Austin-Round Rock, TX',
    housing: ['ATNHPIUS12420Q'],
    unemployment: ['AUST648URN', 'TXUR', 'UNRATE'],
    income: ['MHITX12420', 'MEHOINUSTXA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU48124000500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'ATNHPIUS12420Q',
    buildingPermits: ['AUST448BPPRIVSA', 'AUST448BPPRIV'],
    countyFips: '48453', // Travis County
    newListings: 'NEWLISCOU48453',
    activeListings: 'ACTLISCOU48453',
    population: 'AUSPOP'
  },
  'phoenix': {
    name: 'Phoenix-Mesa-Scottsdale, AZ',
    housing: ['PHXRNSA', 'ATNHPIUS38060Q'],
    unemployment: ['PHOE004URN', 'AZUR', 'UNRATE'],
    income: ['MHIAZ38060', 'MEHOINUSAZA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU04380000500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'PHXRNSA',
    buildingPermits: ['PHOE004BPPRIVSA', 'PHOE004BPPRIV'],
    countyFips: '04013', // Maricopa County
    newListings: 'NEWLISCOU4013',
    activeListings: 'ACTLISCOU4013',
    population: 'PHXPOP'
  },
  'miami': {
    name: 'Miami-Fort Lauderdale-West Palm Beach, FL',
    housing: ['MIXRNSA', 'ATNHPIUS33100Q'],
    unemployment: ['MIAM112URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL33100', 'MEHOINUSFLA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU12336600500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'MIXRNSA',
    buildingPermits: ['MIAM112BPPRIVSA', 'MIAM112BPPRIV'],
    countyFips: '12086', // Miami-Dade County
    newListings: 'NEWLISCOU12086',
    activeListings: 'ACTLISCOU12086',
    population: 'MIMPOP'
  },
  'new-york': {
    name: 'New York-Newark-Jersey City, NY-NJ-PA',
    housing: ['NYXRSA', 'ATNHPIUS35620Q'],
    unemployment: ['NEWY636URN', 'NYUR', 'UNRATE'],
    income: ['MHINY35620', 'MEHOINUSNYA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU36356200500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'NYXRSA',
    buildingPermits: ['NEWY636BPPRIVSA', 'NEWY636BPPRIV'],
    countyFips: '36061', // New York County (Manhattan)
    newListings: 'NEWLISCOU36061',
    activeListings: 'ACTLISCOU36061',
    population: 'NYTPOP'
  },
  'los-angeles': {
    name: 'Los Angeles-Long Beach-Anaheim, CA',
    housing: ['LXXRSA', 'ATNHPIUS31080Q'],
    unemployment: ['LOSA606URN', 'CAUR', 'UNRATE'],
    income: ['MHICA31080', 'MEHOINUSCAA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU06310800500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'LXXRSA',
    buildingPermits: ['LOSA106BPPRIVSA', 'LOSA106BPPRIV'],
    countyFips: '06037', // Los Angeles County
    newListings: 'NEWLISCOU6037',
    activeListings: 'ACTLISCOU6037',
    population: 'LNAPOP'
  },
  'chicago': {
    name: 'Chicago-Naperville-Elgin, IL-IN-WI',
    housing: ['CHXRSA', 'ATNHPIUS16980Q'],
    unemployment: ['CHIC176URN', 'ILUR', 'UNRATE'],
    income: ['MHIIL16980', 'MEHOINUSILA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU17169800500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'CHXRSA',
    buildingPermits: ['CHIC917BPPRIVSA', 'CHIC917BPPRIV'],
    countyFips: '17031', // Cook County
    newListings: 'NEWLISCOU17031',
    activeListings: 'ACTLISCOU17031'
  },
  'dallas': {
    name: 'Dallas-Fort Worth-Arlington, TX',
    housing: ['DAXRSA', 'ATNHPIUS19100Q'],
    unemployment: ['DALL122URN', 'TXUR', 'UNRATE'],
    income: ['MHITX19100', 'MEHOINUSTXA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU48194000500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'DAXRSA',
    buildingPermits: ['DALL148BPPRIVSA', 'DALL148BPPRIV'],
    countyFips: '48113', // Dallas County
    newListings: 'NEWLISCOU48113',
    activeListings: 'ACTLISCOU48113'
  },
  'houston': {
    name: 'Houston-The Woodlands-Sugar Land, TX',
    housing: ['HOXRSA', 'ATNHPIUS26420Q'],
    unemployment: ['HOUS448URN', 'TXUR', 'UNRATE'],
    income: ['MHITX26420', 'MEHOINUSTXA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU48262600500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'HOXRSA',
    buildingPermits: ['HOUS448BPPRIVSA', 'HOUS448BPPRIV'],
    countyFips: '48201', // Harris County
    newListings: 'NEWLISCOU48201',
    activeListings: 'ACTLISCOU48201'
  },
  'seattle': {
    name: 'Seattle-Tacoma-Bellevue, WA',
    housing: ['SEXRNSA', 'ATNHPIUS42660Q'],
    unemployment: ['SEAT553URN', 'WAUR', 'UNRATE'],
    income: ['MHIWA42660', 'MEHOINUSWAA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU53426600500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'SEXRNSA',
    buildingPermits: ['SEAT653BPPRIVSA', 'SEAT653BPPRIV'],
    countyFips: '53033', // King County
    newListings: 'NEWLISCOU53033',
    activeListings: 'ACTLISCOU53033'
  },
  'denver': {
    name: 'Denver-Aurora-Lakewood, CO',
    housing: ['DNXRSA', 'ATNHPIUS19740Q'],
    unemployment: ['DENV108URN', 'COUR', 'UNRATE'],
    income: ['MHICO19740', 'MEHOINUSCOA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU08199000500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'DNXRSA',
    buildingPermits: ['DENV708BPPRIVSA', 'DENV708BPPRIV'],
    countyFips: '08031', // Denver County
    newListings: 'NEWLISCOU8031',
    activeListings: 'ACTLISCOU8031'
  },
  'atlanta': {
    name: 'Atlanta-Sandy Springs-Roswell, GA',
    housing: ['ATXRNSA', 'ATNHPIUS12060Q'],
    unemployment: ['ATLA018URN', 'GAUR', 'UNRATE'],
    income: ['MHIGA12060', 'MEHOINUSGAS672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU13120600500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'ATXRNSA',
    buildingPermits: ['ATLA013BPPRIVSA', 'ATLA013BPPRIV'],
    countyFips: '13121', // Fulton County
    newListings: 'NEWLISCOU13121',
    activeListings: 'ACTLISCOU13121'
  },
  'washington-dc': {
    name: 'Washington-Arlington-Alexandria, DC-VA-MD-WV',
    housing: ['WAXRNSA', 'ATNHPIUS47900Q'],
    unemployment: ['WASH488URN', 'DCUR', 'UNRATE'],
    income: ['MHIDC47900', 'MEHOINUSDCA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU11479000500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'WAXRNSA',
    buildingPermits: ['WASH911BPPRIVSA', 'WASH911BPPRIV'],
    countyFips: '11001', // District of Columbia
    newListings: 'NEWLISCOU11001',
    activeListings: 'ACTLISCOU11001'
  },
  'dc': {
    name: 'Washington-Arlington-Alexandria, DC-VA-MD-WV',
    housing: ['WAXRNSA', 'ATNHPIUS47900Q'],
    unemployment: ['WASH488URN', 'DCUR', 'UNRATE'],
    income: ['MHIDC47900', 'MEHOINUSDCA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU11479000500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'WAXRNSA',
    buildingPermits: ['WASH911BPPRIVSA', 'WASH911BPPRIV'],
    countyFips: '11001',
    newListings: 'NEWLISCOU11001',
    activeListings: 'ACTLISCOU11001'
  },
  'boston': {
    name: 'Boston-Cambridge-Newton, MA-NH',
    housing: ['BOXRSA', 'ATNHPIUS14460Q'],
    unemployment: ['BOST125URN', 'MAUR', 'UNRATE'],
    income: ['MHIMA14460', 'MEHOINUSMAA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU25714600500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'BOXRSA',
    buildingPermits: ['BOST625BPPRIVSA', 'BOST625BPPRIV'],
    countyFips: '25025', // Suffolk County (Boston)
    newListings: 'NEWLISCOU25025',
    activeListings: 'ACTLISCOU25025'
  },
  'portland': {
    name: 'Portland-Vancouver-Hillsboro, OR-WA',
    housing: ['ATNHPIUS38900Q', 'POXRSA'], // Portland MSA HPI
    unemployment: ['PORT741URN', 'ORUR', 'UNRATE'],
    income: ['MHIOR38900', 'MEHOINUSORA672N', 'MEPAINUSA672N'],
    wages: ['SMU41389000500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '41051', // Multnomah County
    newListings: 'NEWLISCOU41051',
    activeListings: 'ACTLISCOU41051'
  },
  'las-vegas': {
    name: 'Las Vegas-Henderson-Paradise, NV',
    housing: ['LVXRNSA', 'ATNHPIUS29820Q'], // Las Vegas HPI
    unemployment: ['LASV632URN', 'NVUR', 'UNRATE'],
    income: ['MHINV29820', 'MEHOINUSNVA672N', 'MEPAINUSA672N'],
    wages: ['SMU32298200500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '32003', // Clark County
    newListings: 'NEWLISCOU32003',
    activeListings: 'ACTLISCOU32003'
  },
  'salt-lake-city': {
    name: 'Salt Lake City, UT',
    housing: ['ATNHPIUS41620Q'], // Salt Lake City MSA HPI
    unemployment: ['SALT741URN', 'UTUR', 'UNRATE'],
    income: ['MHIUT41620', 'MEHOINUSUTA672N', 'MEPAINUSA672N'],
    wages: ['SMU49416200500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '49035', // Salt Lake County
    newListings: 'NEWLISCOU49035',
    activeListings: 'ACTLISCOU49035'
  },
  'minneapolis': {
    name: 'Minneapolis-St. Paul-Bloomington, MN-WI',
    housing: ['ATNHPIUS33460Q'], // Minneapolis MSA HPI
    unemployment: ['MINN527URN', 'MNUR', 'UNRATE'],
    income: ['MHIMN33460', 'MEHOINUSMNA672N', 'MEPAINUSA672N'],
    wages: ['SMU27334600500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '27053', // Hennepin County
    newListings: 'NEWLISCOU27053',
    activeListings: 'ACTLISCOU27053'
  },
  'detroit': {
    name: 'Detroit-Warren-Dearborn, MI',
    housing: ['DEXRSA', 'ATNHPIUS19820Q'], // Detroit HPI
    unemployment: ['DETR326URN', 'MIUR', 'UNRATE'],
    income: ['MHIMI19820', 'MEHOINUSMIA672N', 'MEPAINUSA672N'],
    wages: ['SMU26198200500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '26163', // Wayne County
    newListings: 'NEWLISCOU26163',
    activeListings: 'ACTLISCOU26163'
  },
  'nashville': {
    name: 'Nashville-Davidson--Murfreesboro--Franklin, TN',
    housing: ['ATNHPIUS34980Q'], // Nashville MSA HPI
    unemployment: ['NASH447URN', 'TNUR', 'UNRATE'],
    income: ['MHITN34980', 'MEHOINUSTNA672N', 'MEPAINUSA672N'],
    wages: ['SMU47349800500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '47037', // Davidson County
    newListings: 'NEWLISCOU47037',
    activeListings: 'ACTLISCOU47037'
  },
  'charlotte': {
    name: 'Charlotte-Concord-Gastonia, NC-SC',
    housing: ['ATNHPIUS16740Q'], // Charlotte MSA HPI
    unemployment: ['CHAR316URN', 'NCUR', 'UNRATE'],
    income: ['MHINC16740', 'MEHOINUSNCA672N', 'MEPAINUSA672N'],
    wages: ['SMU37167400500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '37119', // Mecklenburg County
    newListings: 'NEWLISCOU37119',
    activeListings: 'ACTLISCOU37119'
  },
  'columbus': {
    name: 'Columbus, OH',
    housing: ['ATNHPIUS18140Q'], // Columbus MSA HPI
    unemployment: ['COLU539URN', 'OHUR', 'UNRATE'],
    income: ['MHIOH18140', 'MEHOINUSOHA672N', 'MEPAINUSA672N'],
    wages: ['SMU39181400500000011SA', 'CES0500000003', 'AHETPI'],
    countyFips: '39049', // Franklin County
    newListings: 'NEWLISCOU39049',
    activeListings: 'ACTLISCOU39049'
  },
  'philadelphia': {
    name: 'Philadelphia-Camden-Wilmington, PA-NJ-DE-MD',
    housing: ['PAXRNSA', 'ATNHPIUS37980Q'],
    unemployment: ['PHIL162URN', 'PAUR', 'UNRATE'],
    income: ['MHIPA37980', 'MEHOINUSPAA672N', 'MEPAINUSA672N'], // Metro -> State -> National
    wages: ['SMU42379004500000011SA', 'CES0500000003', 'AHETPI'],
    zillow: 'PAXRNSA',
    buildingPermits: ['PHIL942BPPRIVSA', 'PHIL942BPPRIV'],
    countyFips: '42101', // Philadelphia County
    newListings: 'NEWLISCOU42101',
    activeListings: 'ACTLISCOU42101'
  },

  // ── Expanded metros for better heat map coverage ──
  'san-diego': {
    name: 'San Diego-Carlsbad, CA',
    housing: ['SDXRSA', 'ATNHPIUS41740Q'],
    unemployment: ['SAND706URN', 'CAUR', 'UNRATE'],
    income: ['MHICA41740', 'MEHOINUSCAA672N', 'MEPAINUSA672N'],
    wages: ['SMU06417400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'san-antonio': {
    name: 'San Antonio-New Braunfels, TX',
    housing: ['ATNHPIUS41700Q'],
    unemployment: ['SANA548URN', 'TXUR', 'UNRATE'],
    income: ['MHITX41700', 'MEHOINUSTXA672N', 'MEPAINUSA672N'],
    wages: ['SMU48417000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'tampa': {
    name: 'Tampa-St. Petersburg-Clearwater, FL',
    housing: ['TPXRSA', 'ATNHPIUS45300Q'],
    unemployment: ['TAMP412URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL45300', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12453000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'orlando': {
    name: 'Orlando-Kissimmee-Sanford, FL',
    housing: ['ATNHPIUS36740Q'],
    unemployment: ['ORLA712URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL36740', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12367400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'jacksonville': {
    name: 'Jacksonville, FL',
    housing: ['ATNHPIUS27260Q'],
    unemployment: ['JACK412URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL27260', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12272600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'san-jose': {
    name: 'San Jose-Sunnyvale-Santa Clara, CA',
    housing: ['ATNHPIUS41940Q'],
    unemployment: ['SANX606URN', 'CAUR', 'UNRATE'],
    income: ['MHICA41940', 'MEHOINUSCAA672N', 'MEPAINUSA672N'],
    wages: ['SMU06419400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'sacramento': {
    name: 'Sacramento-Roseville-Arden-Arcade, CA',
    housing: ['ATNHPIUS40900Q'],
    unemployment: ['SACR706URN', 'CAUR', 'UNRATE'],
    income: ['MHICA40900', 'MEHOINUSCAA672N', 'MEPAINUSA672N'],
    wages: ['SMU06409000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'riverside': {
    name: 'Riverside-San Bernardino-Ontario, CA',
    housing: ['ATNHPIUS40140Q'],
    unemployment: ['RIVE506URN', 'CAUR', 'UNRATE'],
    income: ['MHICA40140', 'MEHOINUSCAA672N', 'MEPAINUSA672N'],
    wages: ['SMU06401400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'pittsburgh': {
    name: 'Pittsburgh, PA',
    housing: ['ATNHPIUS38300Q'],
    unemployment: ['PITT142URN', 'PAUR', 'UNRATE'],
    income: ['MHIPA38300', 'MEHOINUSPAA672N', 'MEPAINUSA672N'],
    wages: ['SMU42383000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'st-louis': {
    name: 'St. Louis, MO-IL',
    housing: ['SLXRSA', 'ATNHPIUS41180Q'],
    unemployment: ['STLO529URN', 'MOUR', 'UNRATE'],
    income: ['MHIMO41180', 'MEHOINUSMOA672N', 'MEPAINUSA672N'],
    wages: ['SMU29411800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'kansas-city': {
    name: 'Kansas City, MO-KS',
    housing: ['ATNHPIUS28140Q'],
    unemployment: ['KANS429URN', 'MOUR', 'UNRATE'],
    income: ['MHIMO28140', 'MEHOINUSMOA672N', 'MEPAINUSA672N'],
    wages: ['SMU29281400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'indianapolis': {
    name: 'Indianapolis-Carmel-Anderson, IN',
    housing: ['ATNHPIUS26900Q'],
    unemployment: ['INDI518URN', 'INUR', 'UNRATE'],
    income: ['MHIIN26900', 'MEHOINUSINA672N', 'MEPAINUSA672N'],
    wages: ['SMU18269000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'cincinnati': {
    name: 'Cincinnati, OH-KY-IN',
    housing: ['ATNHPIUS17140Q'],
    unemployment: ['CINC139URN', 'OHUR', 'UNRATE'],
    income: ['MHIOH17140', 'MEHOINUSOHA672N', 'MEPAINUSA672N'],
    wages: ['SMU39171400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'cleveland': {
    name: 'Cleveland-Elyria, OH',
    housing: ['ATNHPIUS17460Q'],
    unemployment: ['CLEV139URN', 'OHUR', 'UNRATE'],
    income: ['MHIOH17460', 'MEHOINUSOHA672N', 'MEPAINUSA672N'],
    wages: ['SMU39174600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'milwaukee': {
    name: 'Milwaukee-Waukesha-West Allis, WI',
    housing: ['ATNHPIUS33340Q'],
    unemployment: ['MILW555URN', 'WIUR', 'UNRATE'],
    income: ['MHIWI33340', 'MEHOINUSWIA672N', 'MEPAINUSA672N'],
    wages: ['SMU55333400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'raleigh': {
    name: 'Raleigh, NC',
    housing: ['ATNHPIUS39580Q'],
    unemployment: ['RALE337URN', 'NCUR', 'UNRATE'],
    income: ['MHINC39580', 'MEHOINUSNCA672N', 'MEPAINUSA672N'],
    wages: ['SMU37395800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'richmond': {
    name: 'Richmond, VA',
    housing: ['ATNHPIUS40060Q'],
    unemployment: ['RICH549URN', 'VAUR', 'UNRATE'],
    income: ['MHIVA40060', 'MEHOINUSVAA672N', 'MEPAINUSA672N'],
    wages: ['SMU51400600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'virginia-beach': {
    name: 'Virginia Beach-Norfolk-Newport News, VA-NC',
    housing: ['ATNHPIUS47260Q'],
    unemployment: ['VIRG549URN', 'VAUR', 'UNRATE'],
    income: ['MHIVA47260', 'MEHOINUSVAA672N', 'MEPAINUSA672N'],
    wages: ['SMU51472600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'baltimore': {
    name: 'Baltimore-Columbia-Towson, MD',
    housing: ['ATNHPIUS12580Q'],
    unemployment: ['BALT224URN', 'MDUR', 'UNRATE'],
    income: ['MHIMD12580', 'MEHOINUSMDA672N', 'MEPAINUSA672N'],
    wages: ['SMU24125800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'hartford': {
    name: 'Hartford-West Hartford-East Hartford, CT',
    housing: ['ATNHPIUS25540Q'],
    unemployment: ['HART609URN', 'CTUR', 'UNRATE'],
    income: ['MHICT25540', 'MEHOINUSCTA672N', 'MEPAINUSA672N'],
    wages: ['SMU09255400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'new-orleans': {
    name: 'New Orleans-Metairie, LA',
    housing: ['ATNHPIUS35380Q'],
    unemployment: ['NEWO322URN', 'LAUR', 'UNRATE'],
    income: ['MHILA35380', 'MEHOINUSLAA672N', 'MEPAINUSA672N'],
    wages: ['SMU22353800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'memphis': {
    name: 'Memphis, TN-MS-AR',
    housing: ['ATNHPIUS32820Q'],
    unemployment: ['MEMP247URN', 'TNUR', 'UNRATE'],
    income: ['MHITN32820', 'MEHOINUSTNA672N', 'MEPAINUSA672N'],
    wages: ['SMU47328200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'louisville': {
    name: 'Louisville/Jefferson County, KY-IN',
    housing: ['ATNHPIUS31140Q'],
    unemployment: ['LOUI221URN', 'KYUR', 'UNRATE'],
    income: ['MHIKY31140', 'MEHOINUSJYA672N', 'MEPAINUSA672N'],
    wages: ['SMU21311400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'oklahoma-city': {
    name: 'Oklahoma City, OK',
    housing: ['ATNHPIUS36420Q'],
    unemployment: ['OKLA540URN', 'OKUR', 'UNRATE'],
    income: ['MHIOK36420', 'MEHOINUSOKA672N', 'MEPAINUSA672N'],
    wages: ['SMU40364200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'birmingham': {
    name: 'Birmingham-Hoover, AL',
    housing: ['ATNHPIUS13820Q'],
    unemployment: ['BIRM101URN', 'ALUR', 'UNRATE'],
    income: ['MHIAL13820', 'MEHOINUSALA672N', 'MEPAINUSA672N'],
    wages: ['SMU01138200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'buffalo': {
    name: 'Buffalo-Cheektowaga-Niagara Falls, NY',
    housing: ['ATNHPIUS15380Q'],
    unemployment: ['BUFF336URN', 'NYUR', 'UNRATE'],
    income: ['MHINY15380', 'MEHOINUSNYA672N', 'MEPAINUSA672N'],
    wages: ['SMU36153800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'providence': {
    name: 'Providence-Warwick, RI-MA',
    housing: ['ATNHPIUS39300Q'],
    unemployment: ['PROV744URN', 'RIUR', 'UNRATE'],
    income: ['MHIRI39300', 'MEHOINUSRIA672N', 'MEPAINUSA672N'],
    wages: ['SMU44393000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'tucson': {
    name: 'Tucson, AZ',
    housing: ['ATNHPIUS46060Q'],
    unemployment: ['TUCS004URN', 'AZUR', 'UNRATE'],
    income: ['MHIAZ46060', 'MEHOINUSAZA672N', 'MEPAINUSA672N'],
    wages: ['SMU04460600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'el-paso': {
    name: 'El Paso, TX',
    housing: ['ATNHPIUS21340Q'],
    unemployment: ['ELPA548URN', 'TXUR', 'UNRATE'],
    income: ['MHITX21340', 'MEHOINUSTXA672N', 'MEPAINUSA672N'],
    wages: ['SMU48213400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'albuquerque': {
    name: 'Albuquerque, NM',
    housing: ['ATNHPIUS10740Q'],
    unemployment: ['ALBU535URN', 'NMUR', 'UNRATE'],
    income: ['MHINM10740', 'MEHOINUSNMA672N', 'MEPAINUSA672N'],
    wages: ['SMU35107400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'boise': {
    name: 'Boise City, ID',
    housing: ['ATNHPIUS14260Q'],
    unemployment: ['BOIS316URN', 'IDUR', 'UNRATE'],
    income: ['MHIID14260', 'MEHOINUSIDA672N', 'MEPAINUSA672N'],
    wages: ['SMU16142600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'honolulu': {
    name: 'Urban Honolulu, HI',
    housing: ['ATNHPIUS46520Q'],
    unemployment: ['HONO215URN', 'HIUR', 'UNRATE'],
    income: ['MHIHI46520', 'MEHOINUSHIA672N', 'MEPAINUSA672N'],
    wages: ['SMU15465200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'anchorage': {
    name: 'Anchorage, AK',
    housing: ['ATNHPIUS11260Q'],
    unemployment: ['ANCH302URN', 'AKUR', 'UNRATE'],
    income: ['MHIAK11260', 'MEHOINUSAKA672N', 'MEPAINUSA672N'],
    wages: ['SMU02112600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'charleston': {
    name: 'Charleston-North Charleston, SC',
    housing: ['ATNHPIUS16700Q'],
    unemployment: ['CHAR745URN', 'SCUR', 'UNRATE'],
    income: ['MHISC16700', 'MEHOINUSSCA672N', 'MEPAINUSA672N'],
    wages: ['SMU45167000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'columbia-sc': {
    name: 'Columbia, SC',
    housing: ['ATNHPIUS17900Q'],
    unemployment: ['COLU745URN', 'SCUR', 'UNRATE'],
    income: ['MHISC17900', 'MEHOINUSSCA672N', 'MEPAINUSA672N'],
    wages: ['SMU45179000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'knoxville': {
    name: 'Knoxville, TN',
    housing: ['ATNHPIUS28940Q'],
    unemployment: ['KNOX447URN', 'TNUR', 'UNRATE'],
    income: ['MHITN28940', 'MEHOINUSTNA672N', 'MEPAINUSA672N'],
    wages: ['SMU47289400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'des-moines': {
    name: 'Des Moines-West Des Moines, IA',
    housing: ['ATNHPIUS19780Q'],
    unemployment: ['DESM519URN', 'IAUR', 'UNRATE'],
    income: ['MHIIA19780', 'MEHOINUSIA672N', 'MEPAINUSA672N'],
    wages: ['SMU19197800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'omaha': {
    name: 'Omaha-Council Bluffs, NE-IA',
    housing: ['ATNHPIUS36540Q'],
    unemployment: ['OMAH531URN', 'NEUR', 'UNRATE'],
    income: ['MHINE36540', 'MEHOINUSNEA672N', 'MEPAINUSA672N'],
    wages: ['SMU31365400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'tulsa': {
    name: 'Tulsa, OK',
    housing: ['ATNHPIUS46140Q'],
    unemployment: ['TULS540URN', 'OKUR', 'UNRATE'],
    income: ['MHIOK46140', 'MEHOINUSOKA672N', 'MEPAINUSA672N'],
    wages: ['SMU40461400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'little-rock': {
    name: 'Little Rock-North Little Rock-Conway, AR',
    housing: ['ATNHPIUS30780Q'],
    unemployment: ['LITT505URN', 'ARUR', 'UNRATE'],
    income: ['MHIAR30780', 'MEHOINUSARA672N', 'MEPAINUSA672N'],
    wages: ['SMU05307800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'spokane': {
    name: 'Spokane-Spokane Valley, WA',
    housing: ['ATNHPIUS44060Q'],
    unemployment: ['SPOK753URN', 'WAUR', 'UNRATE'],
    income: ['MHIWA44060', 'MEHOINUSWAA672N', 'MEPAINUSA672N'],
    wages: ['SMU53440600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'colorado-springs': {
    name: 'Colorado Springs, CO',
    housing: ['ATNHPIUS17820Q'],
    unemployment: ['COLO808URN', 'COUR', 'UNRATE'],
    income: ['MHICO17820', 'MEHOINUSCOA672N', 'MEPAINUSA672N'],
    wages: ['SMU08178200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'dayton': {
    name: 'Dayton, OH',
    housing: ['ATNHPIUS19380Q'],
    unemployment: ['DAYT339URN', 'OHUR', 'UNRATE'],
    income: ['MHIOH19380', 'MEHOINUSOHA672N', 'MEPAINUSA672N'],
    wages: ['SMU39193800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'grand-rapids': {
    name: 'Grand Rapids-Wyoming, MI',
    housing: ['ATNHPIUS24340Q'],
    unemployment: ['GRAN326URN', 'MIUR', 'UNRATE'],
    income: ['MHIMI24340', 'MEHOINUSMIA672N', 'MEPAINUSA672N'],
    wages: ['SMU26243400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'greenville-sc': {
    name: 'Greenville-Anderson-Mauldin, SC',
    housing: ['ATNHPIUS24860Q'],
    unemployment: ['GREE745URN', 'SCUR', 'UNRATE'],
    income: ['MHISC24860', 'MEHOINUSSCA672N', 'MEPAINUSA672N'],
    wages: ['SMU45248600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'madison': {
    name: 'Madison, WI',
    housing: ['ATNHPIUS31540Q'],
    unemployment: ['MADI555URN', 'WIUR', 'UNRATE'],
    income: ['MHIWI31540', 'MEHOINUSWIA672N', 'MEPAINUSA672N'],
    wages: ['SMU55315400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'provo': {
    name: 'Provo-Orem, UT',
    housing: ['ATNHPIUS39340Q'],
    unemployment: ['PROV849URN', 'UTUR', 'UNRATE'],
    income: ['MHIUT39340', 'MEHOINUSUTA672N', 'MEPAINUSA672N'],
    wages: ['SMU49393400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'ogden': {
    name: 'Ogden-Clearfield, UT',
    housing: ['ATNHPIUS36260Q'],
    unemployment: ['OGDE549URN', 'UTUR', 'UNRATE'],
    income: ['MHIUT36260', 'MEHOINUSUTA672N', 'MEPAINUSA672N'],
    wages: ['SMU49362600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'savannah': {
    name: 'Savannah, GA',
    housing: ['ATNHPIUS42340Q'],
    unemployment: ['SAVA213URN', 'GAUR', 'UNRATE'],
    income: ['MHIGA42340', 'MEHOINUSGAS672N', 'MEPAINUSA672N'],
    wages: ['SMU13423400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'chattanooga': {
    name: 'Chattanooga, TN-GA',
    housing: ['ATNHPIUS16860Q'],
    unemployment: ['CHAT447URN', 'TNUR', 'UNRATE'],
    income: ['MHITN16860', 'MEHOINUSTNA672N', 'MEPAINUSA672N'],
    wages: ['SMU47168600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  // ── Additional metros for denser heat map coverage ──
  'fresno': {
    name: 'Fresno, CA',
    housing: ['ATNHPIUS23420Q'],
    unemployment: ['FRES606URN', 'CAUR', 'UNRATE'],
    income: ['MHICA23420', 'MEHOINUSCAA672N', 'MEPAINUSA672N'],
    wages: ['SMU06234200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'bakersfield': {
    name: 'Bakersfield, CA',
    housing: ['ATNHPIUS12540Q'],
    unemployment: ['BAKE606URN', 'CAUR', 'UNRATE'],
    income: ['MHICA12540', 'MEHOINUSCAA672N', 'MEPAINUSA672N'],
    wages: ['SMU06125400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'stockton': {
    name: 'Stockton-Lodi, CA',
    housing: ['ATNHPIUS44700Q'],
    unemployment: ['STOC706URN', 'CAUR', 'UNRATE'],
    income: ['MHICA44700', 'MEHOINUSCAA672N', 'MEPAINUSA672N'],
    wages: ['SMU06447000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'cape-coral': {
    name: 'Cape Coral-Fort Myers, FL',
    housing: ['ATNHPIUS15980Q'],
    unemployment: ['CAPE112URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL15980', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12159800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'lakeland': {
    name: 'Lakeland-Winter Haven, FL',
    housing: ['ATNHPIUS29460Q'],
    unemployment: ['LAKE412URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL29460', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12294600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'deltona': {
    name: 'Deltona-Daytona Beach-Ormond Beach, FL',
    housing: ['ATNHPIUS19660Q'],
    unemployment: ['DELT612URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL19660', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12196600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'north-port': {
    name: 'North Port-Sarasota-Bradenton, FL',
    housing: ['ATNHPIUS35840Q'],
    unemployment: ['PORT912URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL35840', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12358400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'palm-bay': {
    name: 'Palm Bay-Melbourne-Titusville, FL',
    housing: ['ATNHPIUS37340Q'],
    unemployment: ['PALM312URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL37340', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12373400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'pensacola': {
    name: 'Pensacola-Ferry Pass-Brent, FL',
    housing: ['ATNHPIUS37860Q'],
    unemployment: ['PENS812URN', 'FLUR', 'UNRATE'],
    income: ['MHIFL37860', 'MEHOINUSFLA672N', 'MEPAINUSA672N'],
    wages: ['SMU12378600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'mcallen': {
    name: 'McAllen-Edinburg-Mission, TX',
    housing: ['ATNHPIUS32580Q'],
    unemployment: ['MCAL548URN', 'TXUR', 'UNRATE'],
    income: ['MHITX32580', 'MEHOINUSTXA672N', 'MEPAINUSA672N'],
    wages: ['SMU48325800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'waco': {
    name: 'Waco, TX',
    housing: ['ATNHPIUS47380Q'],
    unemployment: ['WACO548URN', 'TXUR', 'UNRATE'],
    income: ['MHITX47380', 'MEHOINUSTXA672N', 'MEPAINUSA672N'],
    wages: ['SMU48473800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'lexington': {
    name: 'Lexington-Fayette, KY',
    housing: ['ATNHPIUS30460Q'],
    unemployment: ['LEXI521URN', 'KYUR', 'UNRATE'],
    income: ['MHIKY30460', 'MEHOINUSJYA672N', 'MEPAINUSA672N'],
    wages: ['SMU21304600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'wichita': {
    name: 'Wichita, KS',
    housing: ['ATNHPIUS48620Q'],
    unemployment: ['WICH220URN', 'KSUR', 'UNRATE'],
    income: ['MHIKS48620', 'MEHOINUSKSA672N', 'MEPAINUSA672N'],
    wages: ['SMU20486200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'akron': {
    name: 'Akron, OH',
    housing: ['ATNHPIUS10420Q'],
    unemployment: ['AKRO339URN', 'OHUR', 'UNRATE'],
    income: ['MHIOH10420', 'MEHOINUSOHA672N', 'MEPAINUSA672N'],
    wages: ['SMU39104200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'toledo': {
    name: 'Toledo, OH',
    housing: ['ATNHPIUS45780Q'],
    unemployment: ['TOLE539URN', 'OHUR', 'UNRATE'],
    income: ['MHIOH45780', 'MEHOINUSOHA672N', 'MEPAINUSA672N'],
    wages: ['SMU39457800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'greensboro': {
    name: 'Greensboro-High Point, NC',
    housing: ['ATNHPIUS24660Q'],
    unemployment: ['GREE537URN', 'NCUR', 'UNRATE'],
    income: ['MHINC24660', 'MEHOINUSNCA672N', 'MEPAINUSA672N'],
    wages: ['SMU37246600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'durham': {
    name: 'Durham-Chapel Hill, NC',
    housing: ['ATNHPIUS20500Q'],
    unemployment: ['DURH537URN', 'NCUR', 'UNRATE'],
    income: ['MHINC20500', 'MEHOINUSNCA672N', 'MEPAINUSA672N'],
    wages: ['SMU37205000500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'winston-salem': {
    name: 'Winston-Salem, NC',
    housing: ['ATNHPIUS49180Q'],
    unemployment: ['WINS537URN', 'NCUR', 'UNRATE'],
    income: ['MHINC49180', 'MEHOINUSNCA672N', 'MEPAINUSA672N'],
    wages: ['SMU37491800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'huntsville': {
    name: 'Huntsville, AL',
    housing: ['ATNHPIUS26620Q'],
    unemployment: ['HUNT101URN', 'ALUR', 'UNRATE'],
    income: ['MHIAL26620', 'MEHOINUSALA672N', 'MEPAINUSA672N'],
    wages: ['SMU01266200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'augusta': {
    name: 'Augusta-Richmond County, GA-SC',
    housing: ['ATNHPIUS12260Q'],
    unemployment: ['AUGU213URN', 'GAUR', 'UNRATE'],
    income: ['MHIGA12260', 'MEHOINUSGAS672N', 'MEPAINUSA672N'],
    wages: ['SMU13122600500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'baton-rouge': {
    name: 'Baton Rouge, LA',
    housing: ['ATNHPIUS12940Q'],
    unemployment: ['BATO522URN', 'LAUR', 'UNRATE'],
    income: ['MHILA12940', 'MEHOINUSLAA672N', 'MEPAINUSA672N'],
    wages: ['SMU22129400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'fayetteville-ar': {
    name: 'Fayetteville-Springdale-Rogers, AR',
    housing: ['ATNHPIUS22220Q'],
    unemployment: ['FAYE505URN', 'ARUR', 'UNRATE'],
    income: ['MHIAR22220', 'MEHOINUSARA672N', 'MEPAINUSA672N'],
    wages: ['SMU05222200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'rochester': {
    name: 'Rochester, NY',
    housing: ['ATNHPIUS40380Q'],
    unemployment: ['ROCH536URN', 'NYUR', 'UNRATE'],
    income: ['MHINY40380', 'MEHOINUSNYA672N', 'MEPAINUSA672N'],
    wages: ['SMU36403800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'scranton': {
    name: 'Scranton--Wilkes-Barre--Hazleton, PA',
    housing: ['ATNHPIUS42540Q'],
    unemployment: ['SCRA542URN', 'PAUR', 'UNRATE'],
    income: ['MHIPA42540', 'MEHOINUSPAA672N', 'MEPAINUSA672N'],
    wages: ['SMU42425400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'worcester': {
    name: 'Worcester, MA-CT',
    housing: ['ATNHPIUS49340Q'],
    unemployment: ['WORC625URN', 'MAUR', 'UNRATE'],
    income: ['MHIMA49340', 'MEHOINUSMAA672N', 'MEPAINUSA672N'],
    wages: ['SMU25493400500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'harrisburg': {
    name: 'Harrisburg-Carlisle, PA',
    housing: ['ATNHPIUS25420Q'],
    unemployment: ['HARR542URN', 'PAUR', 'UNRATE'],
    income: ['MHIPA25420', 'MEHOINUSPAA672N', 'MEPAINUSA672N'],
    wages: ['SMU42254200500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'springfield-mo': {
    name: 'Springfield, MO',
    housing: ['ATNHPIUS44180Q'],
    unemployment: ['SPRI529URN', 'MOUR', 'UNRATE'],
    income: ['MHIMO44180', 'MEHOINUSMOA672N', 'MEPAINUSA672N'],
    wages: ['SMU29441800500000011SA', 'CES0500000003', 'AHETPI'],
  },
  'reno': {
    name: 'Reno, NV',
    housing: ['ATNHPIUS39900Q'],
    unemployment: ['RENO532URN', 'NVUR', 'UNRATE'],
    income: ['MHINV39900', 'MEHOINUSNVA672N', 'MEPAINUSA672N'],
    wages: ['SMU32399000500000011SA', 'CES0500000003', 'AHETPI'],
  }
};

/**
 * Get regional housing market data for top metro areas
 */
export async function getRegionalMarketData() {
  try {
    // Fetch data for major metro areas
    const [sanFrancisco, austin, phoenix, miami] = await Promise.all([
      // San Francisco-Oakland-Hayward, CA (SFXRSA)
      fredRequest('series/observations', { 
        series_id: 'SFXRSA', 
        limit: 2, 
        sort_order: 'desc' 
      }),
      // Austin-Round Rock, TX (ATNHPIUS12420Q)
      fredRequest('series/observations', { 
        series_id: 'ATNHPIUS12420Q', 
        limit: 2, 
        sort_order: 'desc' 
      }),
      // Phoenix-Mesa-Scottsdale, AZ (PHXRNSA)
      fredRequest('series/observations', { 
        series_id: 'PHXRNSA', 
        limit: 2, 
        sort_order: 'desc' 
      }),
      // Miami-Fort Lauderdale-West Palm Beach, FL (MIXRNSA)
      fredRequest('series/observations', { 
        series_id: 'MIXRNSA', 
        limit: 2, 
        sort_order: 'desc' 
      })
    ]);

    const processMetroData = (data, basePrice = 500000) => {
      if (!data.observations || data.observations.length < 2) {
        return { price: 'N/A', yoy: 'N/A', inventory: 'N/A' };
      }
      const current = parseFloat(data.observations[0].value);
      const previous = parseFloat(data.observations[1].value);
      const yoy = ((current - previous) / previous * 100).toFixed(1);
      // Estimate price based on index (base 100 = basePrice)
      const price = Math.round((current / 100) * basePrice);
      return { 
        price, 
        yoy,
        inventory: (2 + Math.random() * 2).toFixed(1) // Placeholder - FRED doesn't have metro-specific inventory easily
      };
    };

    return {
      metros: [
        {
          name: 'San Francisco, CA',
          ...processMetroData(sanFrancisco, 1285000)
        },
        {
          name: 'Austin, TX',
          ...processMetroData(austin, 565000)
        },
        {
          name: 'Phoenix, AZ',
          ...processMetroData(phoenix, 445000)
        },
        {
          name: 'Miami, FL',
          ...processMetroData(miami, 525000)
        }
      ]
    };
  } catch (error) {
    console.error('[FRED] Error fetching regional market data:', error);
    throw error;
  }
}

/**
 * Search for available regions
 * @param {string} query - Search query for region name
 */
export async function searchRegions(query) {
  console.log('[FRED] Search query received:', query);
  const searchQuery = query.toLowerCase().trim();
  const matches = [];
  
  for (const [code, data] of Object.entries(METRO_CODES)) {
    // Check if query matches the code or any part of the name
    if (code.includes(searchQuery) || 
        data.name.toLowerCase().includes(searchQuery) ||
        code.replace(/-/g, ' ').includes(searchQuery)) {
      matches.push({
        code,
        name: data.name
      });
    }
  }
  
  console.log('[FRED] Search results:', matches.length, 'matches found');
  return matches;
}

/**
 * Try multiple series IDs with fallback.
 * FRESHNESS-AWARE: Picks the series whose latest observation is most recent,
 * rather than blindly returning the first non-empty result.  This prevents
 * stale metro-specific series (e.g. SMU data last updated 2022) from
 * shadowing a fresh national fallback (e.g. CES/AHETPI updated monthly).
 *
 * @param {string[]} seriesIds - Series IDs ordered by specificity (metro → state → national)
 * @param {object} params - FRED API query params
 * @param {object} options - { freshnessFirst: bool } - default true
 */
async function trySeriesWithFallback(seriesIds, params = {}, options = {}) {
  const ids = Array.isArray(seriesIds) ? seriesIds : [seriesIds];
  const freshnessFirst = options.freshnessFirst !== false;
  
  if (!freshnessFirst) {
    // Legacy behaviour: first non-empty wins
    for (const seriesId of ids) {
      try {
        const result = await fredRequest('series/observations', { 
          series_id: seriesId, 
          ...params 
        });
        if (result.observations && result.observations.length > 0) {
          return result;
        }
      } catch (error) {
        continue;
      }
    }
    return { observations: [] };
  }

  // Freshness-first: fetch all sequentially (the queue + cache in fredRequest
  // handle dedup, but we avoid Promise.all to prevent burst rate-limit issues)
  const results = [];
  for (const seriesId of ids) {
    try {
      const result = await fredRequest('series/observations', { 
        series_id: seriesId, 
        ...params 
      });
      if (result.observations && result.observations.length > 0) {
        const latestValid = result.observations.find(o => o.value !== '.');
        results.push({ seriesId, result, latestDate: latestValid?.date || '1900-01-01' });
      }
    } catch (error) {
      // skip this series
    }
  }
  
  // Filter valid results
  const validResults = results.filter(Boolean);
  if (validResults.length === 0) return { observations: [] };
  
  // Sort by latest date descending, pick freshest
  validResults.sort((a, b) => b.latestDate.localeCompare(a.latestDate));
  
  const chosen = validResults[0];
  
  // Log if we skipped a more-specific series due to staleness
  if (validResults.length > 1 && chosen.seriesId !== ids[0]) {
    const skipped = validResults.find(r => r.seriesId === ids[0]);
    if (skipped) {
      console.log(`[FRED] Freshness fallback: skipped ${ids[0]} (latest: ${skipped.latestDate}) → using ${chosen.seriesId} (latest: ${chosen.latestDate})`);
    }
  }
  
  return chosen.result;
}

/**
 * Get detailed regional data including housing, population, wages, employment, and supply indicators
 * @param {string} regionCode - Metro code (e.g., 'san-francisco', 'austin')
 */
export async function getRegionalDetail(regionCode) {
  try {
    const metro = METRO_CODES[regionCode.toLowerCase()];
    if (!metro) {
      throw new Error(`Unknown region: ${regionCode}`);
    }

    // Fetch all data in parallel with fallback series
    // Increase limit to 60 for better historical charts and accurate YoY
    // Include supply indicators: building permits, new listings, active listings
    const [housingData, unemploymentData, incomeData, wagesData, permitsData, newListingsData, activeListingsData] = await Promise.all([
      trySeriesWithFallback(metro.housing, { limit: 60, sort_order: 'desc' }),
      trySeriesWithFallback(metro.unemployment, { limit: 60, sort_order: 'desc' }),
      trySeriesWithFallback(metro.income, { limit: 10, sort_order: 'desc' }),
      trySeriesWithFallback(metro.wages, { limit: 60, sort_order: 'desc' }),
      // Supply indicators - may not exist for all metros, so use fallback
      metro.buildingPermits ? trySeriesWithFallback(metro.buildingPermits, { limit: 24, sort_order: 'desc' }) : Promise.resolve({ observations: [] }),
      metro.newListings ? trySeriesWithFallback([metro.newListings], { limit: 24, sort_order: 'desc' }) : Promise.resolve({ observations: [] }),
      metro.activeListings ? trySeriesWithFallback([metro.activeListings], { limit: 24, sort_order: 'desc' }) : Promise.resolve({ observations: [] })
    ]);

    // Helper: find observation closest to a target date
    const findClosestObs = (observations, targetDate, maxDiffDays = 90) => {
      let best = null, bestDiff = Infinity;
      for (const obs of observations) {
        if (obs.value === '.') continue;
        const diff = Math.abs(new Date(obs.date) - targetDate);
        if (diff < bestDiff) { bestDiff = diff; best = obs; }
      }
      return bestDiff <= maxDiffDays * 86400000 ? best : null;
    };

    // Helper: true YoY by comparing to 12 months ago
    const trueYoY = (observations) => {
      if (!observations || observations.length < 2) return null;
      const latest = observations.find(o => o.value !== '.');
      if (!latest) return null;
      const targetDate = new Date(latest.date);
      targetDate.setFullYear(targetDate.getFullYear() - 1);
      const yearAgo = findClosestObs(observations, targetDate);
      if (!yearAgo) return null;
      const curr = parseFloat(latest.value), prev = parseFloat(yearAgo.value);
      if (isNaN(curr) || isNaN(prev) || prev === 0) return null;
      return ((curr - prev) / prev * 100).toFixed(1);
    };

    // Process housing price data
    const housingObs = housingData.observations || [];
    const latestHousing = housingObs.find(o => o.value !== '.');
    const housingYoY = trueYoY(housingObs);

    // Process unemployment data
    const unemploymentObs = unemploymentData.observations || [];
    const latestUnemployment = unemploymentObs.find(o => o.value !== '.');
    const previousUnemployment = unemploymentObs[1];
    const unemploymentChange = previousUnemployment ?
      (parseFloat(latestUnemployment?.value) - parseFloat(previousUnemployment.value)).toFixed(1) :
      null;

    // Process income data
    const incomeObs = incomeData.observations || [];
    const latestIncome = incomeObs.find(o => o.value !== '.');
    const incomeGrowth = trueYoY(incomeObs);

    // Process wage data
    const wageObs = wagesData.observations || [];
    const latestWage = wageObs.find(o => o.value !== '.');
    const wageGrowth = trueYoY(wageObs);

    // Process building permits data (supply indicator)
    const permitsObs = permitsData.observations || [];
    const latestPermits = permitsObs[0];
    // Calculate YoY for permits (compare to 12 months ago if available)
    const permitsYoYObs = permitsObs.length >= 13 ? permitsObs[12] : null;
    const permitsYoY = permitsYoYObs ? 
      ((parseFloat(latestPermits?.value) - parseFloat(permitsYoYObs.value)) / parseFloat(permitsYoYObs.value) * 100).toFixed(1) : 
      null;

    // Process new listings data (monthly supply indicator)
    const newListingsObs = newListingsData.observations || [];
    const latestNewListings = newListingsObs[0];
    const newListingsYoYObs = newListingsObs.length >= 13 ? newListingsObs[12] : null;
    const newListingsYoY = newListingsYoYObs ? 
      ((parseFloat(latestNewListings?.value) - parseFloat(newListingsYoYObs.value)) / parseFloat(newListingsYoYObs.value) * 100).toFixed(1) : 
      null;

    // Process active listings data (inventory level)
    const activeListingsObs = activeListingsData.observations || [];
    const latestActiveListings = activeListingsObs[0];
    const activeListingsYoYObs = activeListingsObs.length >= 13 ? activeListingsObs[12] : null;
    const activeListingsYoY = activeListingsYoYObs ? 
      ((parseFloat(latestActiveListings?.value) - parseFloat(activeListingsYoYObs.value)) / parseFloat(activeListingsYoYObs.value) * 100).toFixed(1) : 
      null;

    return {
      name: metro.name,
      code: regionCode,
      countyFips: metro.countyFips || null,
      overview: {
        housingPrice: {
          value: latestHousing?.value || 'N/A',
          date: latestHousing?.date || 'N/A',
          yoy: housingYoY
        },
        unemployment: {
          value: latestUnemployment?.value || 'N/A',
          date: latestUnemployment?.date || 'N/A',
          change: unemploymentChange
        },
        medianIncome: {
          value: latestIncome?.value || 'N/A',
          date: latestIncome?.date || 'N/A',
          growth: incomeGrowth
        },
        averageWage: {
          value: latestWage?.value || 'N/A',
          date: latestWage?.date || 'N/A',
          growth: wageGrowth
        },
        // Supply indicators - leading indicators for future vacancy/rent pressure
        buildingPermits: {
          value: latestPermits?.value || 'N/A',
          date: latestPermits?.date || 'N/A',
          yoy: permitsYoY,
          description: 'New private housing permits (MSA level, monthly)'
        },
        newListings: {
          value: latestNewListings?.value || 'N/A',
          date: latestNewListings?.date || 'N/A',
          yoy: newListingsYoY,
          description: 'New listings added to market (county level, monthly)'
        },
        activeListings: {
          value: latestActiveListings?.value || 'N/A',
          date: latestActiveListings?.date || 'N/A',
          yoy: activeListingsYoY,
          description: 'Active listings on market (county level, monthly)'
        }
      },
      charts: {
        housing: housingObs.reverse().map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        })),
        wages: wageObs.reverse().map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        })),
        unemployment: unemploymentObs.reverse().map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        })),
        income: incomeObs.reverse().map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        })),
        // Supply indicator charts
        buildingPermits: permitsObs.reverse().map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        })),
        newListings: newListingsObs.reverse().map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        })),
        activeListings: activeListingsObs.reverse().map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        }))
      }
    };
  } catch (error) {
    console.error('[FRED] Error fetching regional detail:', error);
    throw error;
  }
}

/**
 * Generic FRED series search
 * @param {string} searchText - Search query
 * @param {number} limit - Max results
 */
export async function searchSeries(searchText, limit = 10) {
  try {
    return await fredRequest('series/search', { 
      search_text: searchText,
      limit 
    });
  } catch (error) {
    console.error('[FRED] Error searching series:', error);
    throw error;
  }
}

/**
 * Get observations for a specific series
 * @param {string} seriesId - FRED series ID
 * @param {number} limit - Max observations to return
 */
export async function getSeriesObservations(seriesId, limit = 100) {
  try {
    return await fredRequest('series/observations', { 
      series_id: seriesId,
      limit,
      sort_order: 'desc'
    });
  } catch (error) {
    console.error('[FRED] Error fetching series observations:', error);
    throw error;
  }
}

/**
 * Get series metadata
 * @param {string} seriesId - FRED series ID
 */
export async function getSeriesInfo(seriesId) {
  try {
    return await fredRequest('series', { 
      series_id: seriesId
    });
  } catch (error) {
    console.error('[FRED] Error fetching series info:', error);
    throw error;
  }
}

/**
 * Get all releases
 */
export async function getReleases() {
  try {
    return await fredRequest('releases', { limit: 100 });
  } catch (error) {
    console.error('[FRED] Error fetching releases:', error);
    throw error;
  }
}

/**
 * Get category information
 * @param {number} categoryId - FRED category ID
 */
export async function getCategory(categoryId = 0) {
  try {
    return await fredRequest('category', { category_id: categoryId });
  } catch (error) {
    console.error('[FRED] Error fetching category:', error);
    throw error;
  }
}

/**
 * Get series in a category
 * @param {number} categoryId - FRED category ID
 */
export async function getCategorySeries(categoryId) {
  try {
    return await fredRequest('category/series', { 
      category_id: categoryId,
      limit: 100
    });
  } catch (error) {
    console.error('[FRED] Error fetching category series:', error);
    throw error;
  }
}

/**
 * Get Treasury Yields data optimized for real estate investors
 * Includes the most relevant yields that impact real estate financing and market conditions
 * @param {object} options - Configuration options
 * @param {number} options.days - Number of days of historical data (default: 365, max: 3650 for 10 years)
 * @param {string} options.startDate - Start date in YYYY-MM-DD format (optional, overrides days)
 * @param {string} options.endDate - End date in YYYY-MM-DD format (optional, defaults to today)
 */
export async function getTreasuryYields(options = {}) {
  try {
    // Default to 1 year of data, max 10 years
    const days = Math.min(options.days || 365, 3650);
    const limit = Math.ceil(days * 1.5); // Add buffer for weekends/holidays
    
    // Calculate date range if not provided
    let startDate = options.startDate;
    let endDate = options.endDate;
    
    if (!startDate && days) {
      const start = new Date();
      start.setDate(start.getDate() - days);
      startDate = start.toISOString().split('T')[0];
    }
    
    if (!endDate) {
      endDate = new Date().toISOString().split('T')[0];
    }

    // Fetch key treasury yields in parallel with extended historical data
    const [
      twoYear,
      fiveYear,
      tenYear,
      thirtyYear,
      yieldSpread,
      mortgageRate
    ] = await Promise.all([
      // 2-Year Treasury - Short-term rates, ARM pricing
      fredRequest('series/observations', { 
        series_id: 'DGS2', 
        observation_start: startDate,
        observation_end: endDate,
        sort_order: 'desc' 
      }),
      // 5-Year Treasury - Intermediate financing, commercial loans
      fredRequest('series/observations', { 
        series_id: 'DGS5', 
        observation_start: startDate,
        observation_end: endDate,
        sort_order: 'desc' 
      }),
      // 10-Year Treasury - Primary mortgage rate benchmark
      fredRequest('series/observations', { 
        series_id: 'DGS10', 
        observation_start: startDate,
        observation_end: endDate,
        sort_order: 'desc' 
      }),
      // 30-Year Treasury - Long-term fixed mortgage correlation
      fredRequest('series/observations', { 
        series_id: 'DGS30', 
        observation_start: startDate,
        observation_end: endDate,
        sort_order: 'desc' 
      }),
      // 10Y-2Y Spread - Recession indicator (inverted = recession warning)
      fredRequest('series/observations', { 
        series_id: 'T10Y2Y', 
        observation_start: startDate,
        observation_end: endDate,
        sort_order: 'desc' 
      }),
      // 30-Year Fixed Mortgage Rate for comparison
      fredRequest('series/observations', { 
        series_id: 'MORTGAGE30US', 
        observation_start: startDate,
        observation_end: endDate,
        sort_order: 'desc' 
      })
    ]);

    // Helper function to extract current value and calculate comprehensive trends
    const processYield = (data, name) => {
      if (!data.observations || data.observations.length === 0) {
        return { name, current: null, changes: {}, trend: null, history: [], stats: {} };
      }

      const validObs = data.observations.filter(obs => obs.value !== '.');
      if (validObs.length === 0) {
        return { name, current: null, changes: {}, trend: null, history: [], stats: {} };
      }

      const current = parseFloat(validObs[0].value);
      
      // Calculate changes over multiple time periods
      const changes = {};
      const timeframes = {
        '1week': 5,    // ~5 business days
        '1month': 20,   // ~20 business days
        '3months': 60,  // ~60 business days
        '6months': 125, // ~125 business days
        '1year': 250,   // ~250 business days
        '2years': 500,  // ~500 business days
        '5years': 1250  // ~1250 business days
      };

      for (const [period, daysBack] of Object.entries(timeframes)) {
        if (validObs.length > daysBack) {
          const pastValue = parseFloat(validObs[daysBack].value);
          const change = current - pastValue;
          const percentChange = (change / pastValue * 100).toFixed(2);
          changes[period] = {
            absolute: change.toFixed(2),
            percent: percentChange,
            from: pastValue.toFixed(2),
            date: validObs[daysBack].date
          };
        }
      }

      // Determine overall trend based on 1-month change
      const monthChange = changes['1month']?.absolute || 0;
      const trend = Math.abs(monthChange) < 0.05 ? 'stable' : monthChange > 0 ? 'rising' : 'falling';

      // Get full history for charting (reversed to be chronological)
      const history = validObs.reverse().map(obs => ({
        date: obs.date,
        value: parseFloat(obs.value)
      }));

      // Calculate statistics
      const values = history.map(h => h.value);
      const stats = {
        current: current.toFixed(2),
        high: Math.max(...values).toFixed(2),
        low: Math.min(...values).toFixed(2),
        average: (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
        highDate: history.find(h => h.value === Math.max(...values))?.date,
        lowDate: history.find(h => h.value === Math.min(...values))?.date,
        volatility: calculateVolatility(values)
      };

      return {
        name,
        current: current.toFixed(2),
        changes,
        trend,
        date: validObs[validObs.length - 1].date, // Most recent date (after reverse)
        history,
        stats
      };
    };

    // Helper function to calculate volatility (standard deviation)
    const calculateVolatility = (values) => {
      if (values.length < 2) return 0;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
      return Math.sqrt(variance).toFixed(2);
    };

    const yields = {
      twoYear: processYield(twoYear, '2-Year Treasury'),
      fiveYear: processYield(fiveYear, '5-Year Treasury'),
      tenYear: processYield(tenYear, '10-Year Treasury'),
      thirtyYear: processYield(thirtyYear, '30-Year Treasury'),
      mortgageRate: processYield(mortgageRate, '30-Year Mortgage'),
    };

    // Process yield spread separately (can be negative) with full historical analysis
    const spreadData = yieldSpread.observations?.filter(obs => obs.value !== '.') || [];
    if (spreadData.length > 0) {
      const currentSpread = parseFloat(spreadData[0].value);
      
      // Calculate spread changes over time
      const spreadChanges = {};
      const timeframes = {
        '1week': 5,
        '1month': 20,
        '3months': 60,
        '6months': 125,
        '1year': 250
      };

      for (const [period, daysBack] of Object.entries(timeframes)) {
        if (spreadData.length > daysBack) {
          const pastValue = parseFloat(spreadData[daysBack].value);
          spreadChanges[period] = {
            absolute: (currentSpread - pastValue).toFixed(2),
            from: pastValue.toFixed(2),
            date: spreadData[daysBack].date
          };
        }
      }

      // Analyze inversion periods
      const spreadHistory = spreadData.reverse().map(obs => ({
        date: obs.date,
        value: parseFloat(obs.value),
        isInverted: parseFloat(obs.value) < 0
      }));

      const inversionPeriods = [];
      let inversionStart = null;
      let inversionDays = 0;

      for (let i = 0; i < spreadHistory.length; i++) {
        if (spreadHistory[i].isInverted) {
          if (!inversionStart) inversionStart = spreadHistory[i].date;
          inversionDays++;
        } else {
          if (inversionStart) {
            inversionPeriods.push({
              start: inversionStart,
              end: spreadHistory[i - 1].date,
              days: inversionDays
            });
            inversionStart = null;
            inversionDays = 0;
          }
        }
      }

      // If currently in inversion
      if (inversionStart) {
        inversionPeriods.push({
          start: inversionStart,
          end: 'Present',
          days: inversionDays,
          ongoing: true
        });
      }

      const monthChange = spreadChanges['1month']?.absolute || 0;
      
      yields.yieldSpread = {
        name: '10Y-2Y Spread',
        current: currentSpread.toFixed(2),
        changes: spreadChanges,
        trend: Math.abs(monthChange) < 0.05 ? 'stable' : monthChange > 0 ? 'steepening' : 'flattening',
        date: spreadData[spreadData.length - 1].date,
        isInverted: currentSpread < 0,
        recessionWarning: currentSpread < 0,
        history: spreadHistory,
        inversionAnalysis: {
          currentlyInverted: currentSpread < 0,
          inversionPeriods,
          totalInversionDays: inversionPeriods.reduce((sum, p) => sum + p.days, 0),
          lastInversion: inversionPeriods.length > 0 ? inversionPeriods[inversionPeriods.length - 1] : null
        }
      };
    } else {
      yields.yieldSpread = {
        name: '10Y-2Y Spread',
        current: null,
        changes: {},
        trend: null,
        history: []
      };
    }

    // Calculate mortgage rate spread over 10-year (typical is 1.5-2%)
    const mortgageSpread = yields.mortgageRate.current && yields.tenYear.current
      ? (parseFloat(yields.mortgageRate.current) - parseFloat(yields.tenYear.current)).toFixed(2)
      : null;

    // Calculate historical trends and patterns
    const currentSpread = yields.yieldSpread.current ? parseFloat(yields.yieldSpread.current) : 0;
    const tenYearCurrent = parseFloat(yields.tenYear.current);
    const mortgageCurrent = parseFloat(yields.mortgageRate.current);

    // Real estate investment insights with historical context
    const insights = {
      financingEnvironment: currentSpread > 0.5 ? 'favorable' : currentSpread > 0 ? 'neutral' : 'challenging',
      recessionRisk: currentSpread < 0 ? 'elevated' : currentSpread < 0.5 ? 'moderate' : 'low',
      mortgageSpread: mortgageSpread,
      mortgageSpreadNormal: mortgageSpread ? (parseFloat(mortgageSpread) >= 1.5 && parseFloat(mortgageSpread) <= 2.5) : null,
      
      // Historical context
      rateDirection: {
        tenYear: yields.tenYear.trend,
        mortgage: yields.mortgageRate.trend,
        overall: yields.tenYear.trend === 'rising' && yields.mortgageRate.trend === 'rising' ? 'Rates Rising' : 
                 yields.tenYear.trend === 'falling' && yields.mortgageRate.trend === 'falling' ? 'Rates Falling' : 'Mixed'
      },
      
      // Compare to historical ranges
      tenYearContext: {
        vsAverage: (tenYearCurrent - parseFloat(yields.tenYear.stats.average)).toFixed(2),
        percentile: tenYearCurrent > parseFloat(yields.tenYear.stats.average) ? 'above average' : 'below average',
        nearHigh: Math.abs(tenYearCurrent - parseFloat(yields.tenYear.stats.high)) < 0.5,
        nearLow: Math.abs(tenYearCurrent - parseFloat(yields.tenYear.stats.low)) < 0.5
      },
      
      mortgageContext: {
        vsAverage: (mortgageCurrent - parseFloat(yields.mortgageRate.stats.average)).toFixed(2),
        percentile: mortgageCurrent > parseFloat(yields.mortgageRate.stats.average) ? 'above average' : 'below average',
        nearHigh: Math.abs(mortgageCurrent - parseFloat(yields.mortgageRate.stats.high)) < 0.5,
        nearLow: Math.abs(mortgageCurrent - parseFloat(yields.mortgageRate.stats.low)) < 0.5
      },

      // Investment timing recommendations
      recommendation: currentSpread < 0 
        ? `⚠️ CAUTION: Yield curve inverted for ${yields.yieldSpread.inversionAnalysis.lastInversion?.days || 0} days. Historical recession indicator. Consider delaying major acquisitions.`
        : mortgageCurrent > 7 && yields.mortgageRate.trend === 'rising'
        ? `📈 Rising Rate Environment: Rates trending up. Focus on cash flow properties, value-add opportunities, and shorter-term holds. Consider rate locks on active deals.`
        : mortgageCurrent > 7 && yields.mortgageRate.trend === 'falling'
        ? `📉 Rates Declining from Peak: Good time to lock in purchases before further rate drops increase competition. Consider refinance strategies.`
        : mortgageCurrent < 5 && yields.mortgageRate.trend === 'rising'
        ? `⏰ Window Closing: Rates rising from historic lows. Act on deals with long-term fixed-rate financing before rates increase further.`
        : `✅ Favorable Conditions: Stable rate environment. Good time for traditional acquisitions with long-term fixed-rate financing. Normal market dynamics.`,

      // Volatility warning
      volatilityWarning: parseFloat(yields.tenYear.stats.volatility) > 0.5 ? 
        'High rate volatility detected. Consider rate lock strategies and shorter due diligence periods.' : null
    };

    return {
      yields,
      insights,
      dateRange: {
        start: startDate,
        end: endDate,
        days: days
      },
      lastUpdated: yields.tenYear.date,
      summary: {
        keyRate: `${yields.tenYear.current}% (10Y Treasury)`,
        mortgageRate: `${yields.mortgageRate.current}%`,
        yieldCurve: yields.yieldSpread.isInverted ? 'INVERTED ⚠️' : 'Normal',
        environment: insights.financingEnvironment.toUpperCase(),
        trend: insights.rateDirection.overall
      }
    };

  } catch (error) {
    console.error('[FRED] Error fetching treasury yields:', error);
    throw error;
  }
}

/**
 * Fetch additional macroeconomic indicators for real estate investors.
 * Series fetched:
 *   - ICSA: Initial Jobless Claims (weekly) — earliest recession signal
 *   - UMCSENT: University of Michigan Consumer Sentiment (monthly)
 *   - T10YIE: 10-Year Breakeven Inflation Rate (daily) — market-implied inflation expectation
 *   - PCEPILFE: Core PCE Price Index ex Food & Energy (monthly) — the Fed's preferred inflation gauge
 *   - MORTGAGE15US: 15-Year Fixed Mortgage Rate (weekly)
 *   - HSN1F: New One-Family Houses Sold (monthly)
 *   - RHORUSQ156N: Homeownership Rate (quarterly)
 *   - RRVRUSQ156N: Rental Vacancy Rate (quarterly)
 *   - WPUSI012011: PPI Construction Materials (monthly) — construction cost pressure
 */
export async function getAdditionalMacroData() {
  try {
    const [
      joblessClaims,
      consumerSentiment,
      breakeven10Y,
      corePCE,
      fedFundsRate,
      unemployment,
      gdpGrowth,
      jobOpenings,
      oilPrice,
      mortgage15,
      newHomeSales,
      homeownershipRate,
      rentalVacancy,
      constructionPPI
    ] = await Promise.all([
      fredRequest('series/observations', { series_id: 'ICSA', limit: 520, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'UMCSENT', limit: 120, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'T10YIE', limit: 1260, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'PCEPILFE', limit: 120, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'DFEDTARU', limit: 36, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'UNRATE', limit: 36, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'A191RL1Q225SBEA', limit: 20, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'JTSJOL', limit: 36, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'WTISPLC', limit: 36, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'MORTGAGE15US', limit: 260, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'HSN1F', limit: 120, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'RHORUSQ156N', limit: 40, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'RRVRUSQ156N', limit: 40, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'WPUSI012011', limit: 120, sort_order: 'desc' })
    ]);

    /**
     * Helper – extract the latest valid observation, compute month-over-month
     * and year-over-year changes, and build a chart-ready history array.
     */
    const process = (raw, label, opts = {}) => {
      const obs = (raw.observations || []).filter(o => o.value !== '.');
      if (obs.length === 0) return { label, value: null, date: null, mom: null, yoy: null, history: [] };

      const current = parseFloat(obs[0].value);
      const prevMonth = obs.length > 1 ? parseFloat(obs[1].value) : null;

      // Year-over-year: find observation ~12 months back
      let yoy = null;
      const latestDate = new Date(obs[0].date);
      const targetDate = new Date(latestDate);
      targetDate.setFullYear(targetDate.getFullYear() - 1);
      let bestMatch = null;
      let bestDiff = Infinity;
      for (const o of obs) {
        const d = new Date(o.date);
        const diff = Math.abs(d - targetDate);
        if (diff < bestDiff) { bestDiff = diff; bestMatch = o; }
      }
      if (bestMatch && bestDiff < 120 * 86400000) { // within 120 days
        const prev = parseFloat(bestMatch.value);
        if (!isNaN(prev) && prev !== 0) {
          yoy = opts.isAbsolute
            ? (current - prev).toFixed(2)
            : ((current - prev) / prev * 100).toFixed(1);
        }
      }

      // Month-over-month change
      let mom = null;
      if (prevMonth !== null && !isNaN(prevMonth) && prevMonth !== 0) {
        mom = opts.isAbsolute
          ? (current - prevMonth).toFixed(2)
          : ((current - prevMonth) / prevMonth * 100).toFixed(1);
      }

      // History for charting (chronological order)
      const history = obs.slice().reverse().map(o => ({ date: o.date, value: parseFloat(o.value) }));

      return {
        label,
        value: opts.isRate ? current.toFixed(2) : opts.isInteger ? Math.round(current).toLocaleString() : current.toFixed(1),
        date: obs[0].date,
        mom,
        yoy,
        history
      };
    };

    // ── Beveridge Curve data (Job Openings Rate vs Unemployment Rate) ──
    // Fetch national + 4 Census regions with enough history to show the curve trajectory
    const beveridgeRegionDefs = [
      { key: 'national', label: 'National', jorId: 'JTSJOR', urId: 'UNRATE' },
      { key: 'northeast', label: 'Northeast', jorId: 'JTS00NEJOR', urId: 'CNERUR' },
      { key: 'south', label: 'South', jorId: 'JTS00SOJOR', urId: 'CSOUUR' },
      { key: 'midwest', label: 'Midwest', jorId: 'JTS00MWJOR', urId: 'CMWRUR' },
      { key: 'west', label: 'West', jorId: 'JTS00WEJOR', urId: 'CWSTUR' }
    ];

    let beveridgeCurve = null;
    try {
      // Fetch all 10 series in parallel (5 regions × 2 series each)
      const allFetches = beveridgeRegionDefs.flatMap(r => [
        fredRequest('series/observations', { series_id: r.jorId, limit: 120, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: r.urId, limit: 120, sort_order: 'desc' })
      ]);
      const allResults = await Promise.all(allFetches);

      // Helper: build a Beveridge curve from a pair of raw results
      const buildCurve = (vacancyRaw, unrateRaw) => {
        const vacancyMap = new Map();
        for (const o of (vacancyRaw.observations || [])) {
          if (o.value !== '.') vacancyMap.set(o.date.substring(0, 7), parseFloat(o.value));
        }
        const unrateMap = new Map();
        for (const o of (unrateRaw.observations || [])) {
          if (o.value !== '.') unrateMap.set(o.date.substring(0, 7), parseFloat(o.value));
        }
        const points = [];
        for (const [month, vacancy] of vacancyMap) {
          const urate = unrateMap.get(month);
          if (urate !== undefined) {
            points.push({ date: month, unemployment: urate, vacancyRate: vacancy });
          }
        }
        points.sort((a, b) => a.date.localeCompare(b.date));

        if (points.length < 6) return null;
        const latest = points[points.length - 1];
        const yearAgo = points.length > 12 ? points[points.length - 13] : points[0];
        return {
          points,
          latest,
          yearAgo,
          direction: latest.unemployment < yearAgo.unemployment && latest.vacancyRate > yearAgo.vacancyRate
            ? 'tightening'
            : latest.unemployment > yearAgo.unemployment && latest.vacancyRate < yearAgo.vacancyRate
            ? 'loosening'
            : 'shifting'
        };
      };

      // Build curves for each region (results come in pairs: JOR, UR)
      const regions = {};
      beveridgeRegionDefs.forEach((r, i) => {
        const curve = buildCurve(allResults[i * 2], allResults[i * 2 + 1]);
        if (curve) regions[r.key] = { ...curve, label: r.label };
      });

      // Keep backward-compatible top-level national curve + add regions
      beveridgeCurve = regions.national
        ? { ...regions.national, regions }
        : null;
    } catch (e) {
      console.warn('[FRED] Beveridge Curve fetch failed (non-fatal):', e.message);
    }

    // ── Additional RE Investor Scatter Ratios ──
    let investorRatios = null;
    try {
      const [
        mspusRaw,        // Median Sales Price of Houses Sold (quarterly)
        cpiRentRaw,      // CPI: Rent of Primary Residence (monthly)
        mortgage30Raw,   // 30-Year Mortgage Rate (weekly, use as monthly proxy)
        houstRaw,        // Housing Starts (monthly)
        permitRaw,       // Building Permits (monthly)
        rentalVacRaw,    // Rental Vacancy Rate (quarterly)
        homeownerVacRaw, // Homeowner Vacancy Rate (quarterly)
        csushpiRaw,      // Case-Shiller Home Price Index (monthly)
        dgs10Raw         // 10-Year Treasury Yield (daily → monthly proxy for cap rate)
      ] = await Promise.all([
        fredRequest('series/observations', { series_id: 'MSPUS', limit: 80, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'CUSR0000SEHA', limit: 120, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'MORTGAGE30US', limit: 120, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'HOUST', limit: 120, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'PERMIT', limit: 120, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'RRVRUSQ156N', limit: 80, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'RHVRUSQ156N', limit: 80, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'CSUSHPISA', limit: 120, sort_order: 'desc' }),
        fredRequest('series/observations', { series_id: 'DGS10', limit: 250, sort_order: 'desc' })
      ]);

      // Helper: raw obs → Map<YYYY-MM, number>
      const toMonthMap = (raw) => {
        const m = new Map();
        for (const o of (raw.observations || [])) {
          if (o.value !== '.') {
            const key = o.date.substring(0, 7);
            if (!m.has(key)) m.set(key, parseFloat(o.value)); // keep first (latest) per month
          }
        }
        return m;
      };

      // Helper: raw obs → Map<YYYY-QN, number> (quarters)
      const toQuarterMap = (raw) => {
        const m = new Map();
        for (const o of (raw.observations || [])) {
          if (o.value !== '.') {
            const d = new Date(o.date);
            const q = `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
            if (!m.has(q)) m.set(q, parseFloat(o.value));
          }
        }
        return m;
      };

      // ① Mortgage Rate vs Home Price Scatter
      // Shows how rate changes impact median home prices
      const mortgageMap = toMonthMap(mortgage30Raw);
      const priceQuarterMap = toQuarterMap(mspusRaw);
      const rateVsPrice = [];
      for (const [q, price] of priceQuarterMap) {
        // Average mortgage rate for the quarter's months
        const [yr, qn] = q.split('-Q');
        const months = [1, 2, 3].map(i => `${yr}-${String((parseInt(qn) - 1) * 3 + i).padStart(2, '0')}`);
        const rates = months.map(m => mortgageMap.get(m)).filter(v => v !== undefined);
        if (rates.length > 0) {
          const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
          rateVsPrice.push({ date: q, mortgageRate: parseFloat(avgRate.toFixed(2)), medianPrice: price });
        }
      }
      rateVsPrice.sort((a, b) => a.date.localeCompare(b.date));

      // ② Housing Starts vs Building Permits (Supply Pipeline)
      const houstMap = toMonthMap(houstRaw);
      const permitMap = toMonthMap(permitRaw);
      const startsVsPermits = [];
      for (const [month, starts] of houstMap) {
        const permits = permitMap.get(month);
        if (permits !== undefined) {
          startsVsPermits.push({ date: month, starts, permits });
        }
      }
      startsVsPermits.sort((a, b) => a.date.localeCompare(b.date));

      // ③ Home Price Index vs Rent CPI (Price-to-Rent trajectory)
      const hpiMap = toMonthMap(csushpiRaw);
      const rentMap = toMonthMap(cpiRentRaw);
      const priceVsRent = [];
      for (const [month, hpi] of hpiMap) {
        const rent = rentMap.get(month);
        if (rent !== undefined) {
          priceVsRent.push({ date: month, homePriceIndex: hpi, rentIndex: rent });
        }
      }
      priceVsRent.sort((a, b) => a.date.localeCompare(b.date));

      // ④ Cap Rate Spread (Gross Rent Yield proxy vs Treasury Yield)
      // Rent CPI change (annualized) minus 10Y Treasury = RE premium over risk-free
      const dgs10Map = toMonthMap(dgs10Raw);
      const capRateSpread = [];
      const rentArr = Array.from(rentMap).sort((a, b) => a[0].localeCompare(b[0]));
      for (let i = 12; i < rentArr.length; i++) {
        const [month, rentNow] = rentArr[i];
        const rentYearAgo = rentArr[i - 12][1];
        const rentGrowth = ((rentNow - rentYearAgo) / rentYearAgo) * 100; // annualized %
        const treasury = dgs10Map.get(month);
        if (treasury !== undefined) {
          capRateSpread.push({
            date: month,
            rentGrowthYoY: parseFloat(rentGrowth.toFixed(2)),
            treasury10Y: treasury,
            spread: parseFloat((rentGrowth - treasury).toFixed(2))
          });
        }
      }
      capRateSpread.sort((a, b) => a.date.localeCompare(b.date));

      // ⑤ Vacancy Rate vs Home Price (Supply Pressure)
      const vacQuarterMap = toQuarterMap(rentalVacRaw);
      const homeVacMap = toQuarterMap(homeownerVacRaw);
      const vacancyVsPrice = [];
      for (const [q, rentalVac] of vacQuarterMap) {
        const homeVac = homeVacMap.get(q);
        const price = priceQuarterMap.get(q);
        if (homeVac !== undefined && price !== undefined) {
          vacancyVsPrice.push({ date: q, rentalVacancy: rentalVac, homeownerVacancy: homeVac, medianPrice: price });
        }
      }
      vacancyVsPrice.sort((a, b) => a.date.localeCompare(b.date));

      investorRatios = {
        rateVsPrice: rateVsPrice.length >= 6 ? rateVsPrice : null,
        startsVsPermits: startsVsPermits.length >= 6 ? startsVsPermits : null,
        priceVsRent: priceVsRent.length >= 6 ? priceVsRent : null,
        capRateSpread: capRateSpread.length >= 6 ? capRateSpread : null,
        vacancyVsPrice: vacancyVsPrice.length >= 6 ? vacancyVsPrice : null
      };
    } catch (e) {
      console.warn('[FRED] Investor ratios fetch failed (non-fatal):', e.message);
    }

    return {
      joblessClaims: process(joblessClaims, 'Initial Jobless Claims', { isInteger: true }),
      consumerSentiment: process(consumerSentiment, 'Consumer Sentiment'),
      breakeven10Y: process(breakeven10Y, '10Y Breakeven Inflation', { isRate: true, isAbsolute: true }),
      corePCE: process(corePCE, 'Core PCE Price Index'),
      fedFundsRate: process(fedFundsRate, 'Federal Funds Rate', { isRate: true, isAbsolute: true }),
      unemployment: process(unemployment, 'Unemployment Rate', { isRate: true, isAbsolute: true }),
      gdpGrowth: process(gdpGrowth, 'Real GDP Growth', { isRate: true, isAbsolute: true }),
      jobOpenings: process(jobOpenings, 'Job Openings', { isInteger: true }),
      oilPrice: process(oilPrice, 'WTI Crude Oil Spot Price'),
      mortgage15: process(mortgage15, '15-Year Mortgage Rate', { isRate: true, isAbsolute: true }),
      newHomeSales: process(newHomeSales, 'New Home Sales (000s)', { isInteger: true }),
      homeownershipRate: process(homeownershipRate, 'Homeownership Rate', { isRate: true, isAbsolute: true }),
      rentalVacancy: process(rentalVacancy, 'Rental Vacancy Rate', { isRate: true, isAbsolute: true }),
      constructionPPI: process(constructionPPI, 'Construction Cost Index'),
      beveridgeCurve,
      investorRatios,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    console.error('[FRED] Error fetching additional macro data:', error);
    throw error;
  }
}

/**
 * Fetch and extract full FOMC statement text from Fed website
 */
async function fetchFOMCStatementText(url) {
  try {
    const response = await fetch(url);
    const html = await response.text();
    
    // Extract main content between common Fed press release patterns
    // Fed statements are typically in <div class="col-xs-12 col-sm-8 col-md-8">
    const contentMatch = html.match(/<div class="col-xs-12 col-sm-8 col-md-8"[^>]*>([\s\S]*?)<\/div>/i);
    if (!contentMatch) {
      // Try alternative pattern
      const altMatch = html.match(/<div[^>]*?id="article"[^>]*>([\s\S]*?)<\/div>/i);
      if (altMatch) {
        return cleanHTMLText(altMatch[1]);
      }
      return null;
    }
    
    return cleanHTMLText(contentMatch[1]);
  } catch (error) {
    console.error('[FRED] Error fetching FOMC statement:', error.message);
    return null;
  }
}

/**
 * Clean HTML and extract readable text
 */
function cleanHTMLText(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Use OpenAI to summarize FOMC statement
 */
async function summarizeFOMCStatement(statementText, economicContext) {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      console.log('[FRED] OpenAI API key not configured, skipping AI summary');
      return null;
    }

    const prompt = `You are an expert financial analyst specializing in Federal Reserve policy and real estate markets.

Summarize this FOMC statement for real estate investors. Focus on:
1. Key decisions made (rate changes, policy stance)
2. Economic outlook discussed (inflation, employment, growth)
3. Housing market mentions or implications
4. Future policy direction (dot plot, forward guidance)
5. What this means for mortgage rates and real estate investing

Economic Context:
- Current Fed Funds Rate: ${economicContext.fedFundsRate}%
- Inflation (CPI): ${economicContext.inflation}% YoY
- Unemployment: ${economicContext.unemployment}%
- 30-Year Mortgage: ${economicContext.mortgageRate}%

FOMC Statement:
${statementText.substring(0, 4000)}

Provide a concise 3-paragraph summary (max 250 words) that a real estate investor can quickly understand.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a financial analyst expert in Federal Reserve policy and real estate markets.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      console.error('[FRED] OpenAI API error:', response.status);
      return null;
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || null;
  } catch (error) {
    console.error('[FRED] Error summarizing FOMC statement:', error.message);
    return null;
  }
}

/**
 * Get Federal Reserve Meeting Summary
 * Fetches latest FOMC statements, key economic indicators, and generates insights
 * @returns {Promise<object>} Comprehensive Fed meeting summary with focus on rates and housing
 */
export async function getFedMeetingSummary() {
  try {
    console.log('[FRED] Fetching Federal Reserve meeting summary...');
    
    // Fetch Fed press releases and statements
    const feedResponse = await fetch(FED_RSS_URL);
    const feedXML = await feedResponse.text();
    const feedItems = parseXMLFeed(feedXML);
    
    // Filter for FOMC-related items, prioritizing statements over minutes
    const fomcItems = feedItems.filter(item => 
      item.title.toLowerCase().includes('fomc') || 
      item.title.toLowerCase().includes('federal open market committee') ||
      item.title.toLowerCase().includes('monetary policy') ||
      item.title.toLowerCase().includes('federal reserve issues')
    );
    
    // Separate statements (same day) from minutes (3 weeks later)
    const statements = fomcItems.filter(item => 
      item.title.toLowerCase().includes('statement') ||
      item.title.toLowerCase().includes('federal reserve issues fomc')
    );
    const minutes = fomcItems.filter(item => 
      item.title.toLowerCase().includes('minutes')
    );
    
    // Prioritize: Use most recent statement, fallback to most recent minutes
    const prioritizedItems = [
      ...statements.slice(0, 1),  // Most recent statement (immediate)
      ...minutes.slice(0, 1),     // Most recent minutes (detailed, 3 weeks later)
      ...fomcItems.slice(0, 5)    // Other FOMC items as fallback
    ];
    
    // Remove duplicates by link
    const uniqueItems = Array.from(new Map(prioritizedItems.map(item => [item.link, item])).values()).slice(0, 5);
    
    // Fetch key economic indicators
    const [
      fedFundsRate,      // DFEDTARU: Federal Funds Target Range - Upper Limit
      fedFundsEffective, // FEDFUNDS: Effective Federal Funds Rate
      cpi,               // CPIAUCSL: Consumer Price Index
      pce,               // PCEPI: Personal Consumption Expenditures Price Index
      unemployment,      // UNRATE: Unemployment Rate
      gdp,               // GDP: Gross Domestic Product
      mortgageRate,      // MORTGAGE30US: 30-Year Fixed Rate Mortgage
      housingStarts,     // HOUST: Housing Starts
      homeSales          // EXHOSLUSM495S: Existing Home Sales
    ] = await Promise.all([
      fredRequest('series/observations', { series_id: 'DFEDTARU', limit: 18, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'FEDFUNDS', limit: 18, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'CPIAUCSL', limit: 18, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'PCEPI', limit: 18, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'UNRATE', limit: 18, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'GDP', limit: 10, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'MORTGAGE30US', limit: 18, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'HOUST', limit: 18, sort_order: 'desc' }),
      fredRequest('series/observations', { series_id: 'EXHOSLUSM495S', limit: 18, sort_order: 'desc' })
    ]);
    
    // Helper function to calculate year-over-year change
    const calculateYoY = (observations, monthsBack = 12) => {
      if (!observations || observations.length <= monthsBack) {
        console.log(`[FRED] Not enough observations for YoY calculation: ${observations?.length || 0} vs needed ${monthsBack + 1}`);
        return 'N/A';
      }
      const current = parseFloat(observations[0].value);
      const previous = parseFloat(observations[monthsBack].value);
      if (isNaN(current) || isNaN(previous)) {
        console.log(`[FRED] Invalid values for YoY: current=${current}, previous=${previous}`);
        return 'N/A';
      }
      return ((current - previous) / previous * 100).toFixed(2);
    };
    
    // Helper function to get trend
    const getTrend = (observations, periods = 3) => {
      if (!observations || observations.length < periods) return 'stable';
      const recent = observations.slice(0, periods).map(o => parseFloat(o.value));
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const older = parseFloat(observations[periods].value);
      const change = ((avg - older) / older * 100);
      
      if (change > 1) return 'rising';
      if (change < -1) return 'falling';
      return 'stable';
    };
    
    // Process the data
    const latestFedFundsTarget = parseFloat(fedFundsRate.observations[0]?.value || 0);
    const latestFedFundsEffective = parseFloat(fedFundsEffective.observations[0]?.value || 0);
    const latestCPI = parseFloat(cpi.observations[0]?.value || 0);
    const latestPCE = parseFloat(pce.observations[0]?.value || 0);
    const latestUnemployment = parseFloat(unemployment.observations[0]?.value || 0);
    const latestGDP = parseFloat(gdp.observations[0]?.value || 0);
    const latestMortgage = parseFloat(mortgageRate.observations[0]?.value || 0);
    const latestHousingStarts = parseFloat(housingStarts.observations[0]?.value || 0);
    const latestHomeSales = parseFloat(homeSales.observations[0]?.value || 0);
    
    // Calculate inflation rate (YoY)
    const cpiYoY = calculateYoY(cpi.observations);
    const pceYoY = calculateYoY(pce.observations);
    
    // Determine rate stance
    const ratesTrend = getTrend(fedFundsRate.observations, 3);
    const inflationTrend = getTrend(cpi.observations, 3);
    
    // Generate insights
    const economicOutlook = {
      overall: latestUnemployment < 4.5 && cpiYoY !== 'N/A' && parseFloat(cpiYoY) < 3 
        ? 'Strong - Low unemployment with moderating inflation'
        : latestUnemployment > 5.5 || (cpiYoY !== 'N/A' && parseFloat(cpiYoY) > 4)
        ? 'Challenged - Elevated unemployment or inflation concerns'
        : 'Moderate - Balanced growth with some headwinds',
      
      growth: latestGDP > 20000 && calculateYoY(gdp.observations, 4) !== 'N/A' && parseFloat(calculateYoY(gdp.observations, 4)) > 2
        ? 'Expanding'
        : 'Slowing',
      
      laborMarket: latestUnemployment < 4 
        ? 'Tight - Very low unemployment'
        : latestUnemployment < 5
        ? 'Healthy - Near full employment'
        : 'Loosening - Rising unemployment',
      
      inflation: cpiYoY !== 'N/A' && parseFloat(cpiYoY) < 2.5
        ? 'Under control - Near Fed target'
        : cpiYoY !== 'N/A' && parseFloat(cpiYoY) < 4
        ? 'Elevated - Above target but moderating'
        : 'Concerning - Well above target'
    };
    
    const interestRateOutlook = {
      currentTarget: `${latestFedFundsTarget}%`,
      effectiveRate: `${latestFedFundsEffective}%`,
      trend: ratesTrend,
      stance: ratesTrend === 'rising'
        ? 'Hawkish - Tightening monetary policy to combat inflation'
        : ratesTrend === 'falling'
        ? 'Dovish - Easing policy to support growth'
        : 'Neutral - Holding rates steady',
      
      outlook: ratesTrend === 'rising' && cpiYoY !== 'N/A' && parseFloat(cpiYoY) > 3
        ? 'Likely to continue raising rates until inflation cools'
        : ratesTrend === 'stable' && cpiYoY !== 'N/A' && parseFloat(cpiYoY) < 3
        ? 'Likely to hold rates at current level'
        : ratesTrend === 'falling'
        ? 'Rate cuts likely to continue to support economy'
        : 'Data-dependent - Watching inflation and employment closely',
      
      nextMeetingExpectation: ratesTrend === 'rising'
        ? 'Potential 25-50 bps increase if inflation remains elevated'
        : ratesTrend === 'falling'
        ? 'Potential 25 bps cut if economic data supports'
        : 'Likely to hold steady, monitoring data'
    };
    
    const housingMarketOutlook = {
      mortgageRate: {
        current: `${latestMortgage}%`,
        trend: getTrend(mortgageRate.observations, 4),
        impact: latestMortgage > 7
          ? 'Very restrictive - Significantly limiting affordability'
          : latestMortgage > 6
          ? 'Restrictive - Reducing buyer demand'
          : latestMortgage > 5
          ? 'Moderate - Normalizing from historic lows'
          : 'Favorable - Supporting housing demand'
      },
      
      activity: {
        housingStarts: {
          value: `${(latestHousingStarts / 1000).toFixed(1)}M`,
          trend: getTrend(housingStarts.observations, 3),
          yoy: `${calculateYoY(housingStarts.observations)}%`
        },
        existingSales: {
          value: `${(latestHomeSales / 1000).toFixed(2)}M`,
          trend: getTrend(homeSales.observations, 3),
          yoy: `${calculateYoY(homeSales.observations)}%`
        }
      },
      
      outlook: latestMortgage > 7 && getTrend(mortgageRate.observations, 3) === 'rising'
        ? '⚠️ Challenging - High rates dampening demand, expect slower sales and potential price corrections'
        : latestMortgage > 6 && ratesTrend === 'stable'
        ? '⚖️ Stabilizing - Rates elevated but steady, market adjusting to new normal'
        : latestMortgage < 6 && getTrend(mortgageRate.observations, 3) === 'falling'
        ? '📈 Improving - Falling rates likely to boost activity and support prices'
        : '✅ Balanced - Moderate rates supporting steady activity',
      
      investorImplications: latestMortgage > 7
        ? 'Focus on cash purchases, value-add opportunities, and markets with strong fundamentals. Consider waiting for rate stabilization.'
        : latestMortgage > 6
        ? 'Good time for cash-flow positive acquisitions. Lock in long-term fixed financing before potential rate increases.'
        : 'Favorable financing environment. Good opportunity for leveraged acquisitions and refinancing.'
    };
    
    // Latest FOMC statement details
    const latestMeeting = uniqueItems.length > 0 ? {
      title: uniqueItems[0].title,
      date: uniqueItems[0].pubDate,
      link: uniqueItems[0].link,
      summary: uniqueItems[0].description,
      keyTopics: [
        parseFloat(cpiYoY) > 2 ? 'Inflation monitoring' : 'Price stability',
        'Employment maximum',
        ratesTrend === 'rising' ? 'Rate increases' : ratesTrend === 'falling' ? 'Rate cuts' : 'Rate stability',
        'Economic outlook'
      ],
      isStatement: uniqueItems[0].title.toLowerCase().includes('statement'),
      isMinutes: uniqueItems[0].title.toLowerCase().includes('minutes'),
      publishDelay: uniqueItems[0].title.toLowerCase().includes('minutes') ? '3 weeks after meeting' : 'Same day as meeting'
    } : null;
    
    // Fetch and summarize the actual FOMC statement if available
    let statementSummary = null;
    let fullStatementText = null;
    
    if (latestMeeting && latestMeeting.link) {
      console.log('[FRED] Fetching full FOMC statement text...');
      const cleanLink = latestMeeting.link.replace(/\<\!\[CDATA\[|\]\]\>/g, '');
      fullStatementText = await fetchFOMCStatementText(cleanLink);
      
      if (fullStatementText && fullStatementText.length > 100) {
        console.log('[FRED] Statement text fetched, generating AI summary...');
        statementSummary = await summarizeFOMCStatement(fullStatementText, {
          fedFundsRate: latestFedFundsTarget,
          inflation: cpiYoY,
          unemployment: latestUnemployment,
          mortgageRate: latestMortgage
        });
        
        if (statementSummary) {
          console.log('[FRED] AI summary generated successfully');
        }
      }
    }
    
    return {
      success: true,
      generatedAt: new Date().toISOString(),
      
      latestMeeting: latestMeeting ? {
        ...latestMeeting,
        aiSummary: statementSummary,
        fullText: fullStatementText ? fullStatementText.substring(0, 2000) : null,
        hasFullText: !!fullStatementText
      } : null,
      recentAnnouncements: uniqueItems.map(item => ({
        title: item.title,
        date: item.pubDate,
        link: item.link,
        preview: item.description.substring(0, 200) + '...',
        type: item.title.toLowerCase().includes('statement') ? 'Statement (Same Day)' : 
              item.title.toLowerCase().includes('minutes') ? 'Minutes (3 weeks later)' : 
              'Other'
      })),
      
      economicIndicators: {
        interestRates: {
          federalFundsTarget: latestFedFundsTarget,
          federalFundsEffective: latestFedFundsEffective,
          trend: ratesTrend,
          date: fedFundsRate.observations[0]?.date
        },
        inflation: {
          cpi: {
            current: latestCPI,
            yoy: `${cpiYoY}%`,
            trend: inflationTrend,
            date: cpi.observations[0]?.date
          },
          pce: {
            current: latestPCE,
            yoy: `${pceYoY}%`,
            trend: getTrend(pce.observations, 3),
            date: pce.observations[0]?.date
          }
        },
        employment: {
          unemploymentRate: latestUnemployment,
          trend: getTrend(unemployment.observations, 3),
          date: unemployment.observations[0]?.date
        },
        gdp: {
          current: latestGDP,
          yoy: `${calculateYoY(gdp.observations, 4)}%`,
          date: gdp.observations[0]?.date
        },
        housing: {
          mortgageRate: latestMortgage,
          housingStarts: latestHousingStarts,
          existingHomeSales: latestHomeSales
        }
      },
      
      outlook: {
        economy: economicOutlook,
        interestRates: interestRateOutlook,
        housingMarket: housingMarketOutlook
      },
      
      summary: {
        headline: ratesTrend === 'rising'
          ? `🔴 Fed Raising Rates - Target: ${latestFedFundsTarget}% | Inflation: ${cpiYoY}% YoY`
          : ratesTrend === 'falling'
          ? `🟢 Fed Cutting Rates - Target: ${latestFedFundsTarget}% | Supporting Growth`
          : `🟡 Fed Holding Steady - Target: ${latestFedFundsTarget}% | Monitoring Data`,
        
        keyTakeaway: economicOutlook.overall,
        
        housingImpact: housingMarketOutlook.outlook,
        
        actionableInsight: housingMarketOutlook.investorImplications
      }
    };
    
  } catch (error) {
    console.error('[FRED] Error fetching Fed meeting summary:', error);
    throw error;
  }
}

/**
 * Get historical mortgage rate for a specific date
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<number|null>} - Mortgage rate percentage or null if not found
 */
export async function getHistoricalMortgageRate(date) {
  try {
    // Try exact date first
    const exactData = await fredRequest('series/observations', {
      series_id: 'MORTGAGE30US',
      observation_start: date,
      observation_end: date,
      sort_order: 'desc'
    });
    
    if (exactData.observations && exactData.observations.length > 0) {
      const value = parseFloat(exactData.observations[0].value);
      if (!isNaN(value)) return value;
    }
    
    // If exact date not available, get closest prior date (within 14 days)
    const priorDate = new Date(date);
    priorDate.setDate(priorDate.getDate() - 14);
    const priorDateStr = priorDate.toISOString().split('T')[0];
    
    const priorData = await fredRequest('series/observations', {
      series_id: 'MORTGAGE30US',
      observation_start: priorDateStr,
      observation_end: date,
      sort_order: 'desc',
      limit: 1
    });
    
    if (priorData.observations && priorData.observations.length > 0) {
      const value = parseFloat(priorData.observations[0].value);
      if (!isNaN(value)) return value;
    }
    
    return null;
  } catch (error) {
    console.error('[FRED] Error fetching historical mortgage rate:', error);
    return null;
  }
}

/**
 * Calculate monthly mortgage payment
 * @param {number} principal - Loan amount
 * @param {number} annualRate - Annual interest rate percentage
 * @param {number} termMonths - Loan term in months
 * @returns {number} - Monthly payment amount
 */
export function calculateMonthlyPayment(principal, annualRate, termMonths) {
  const monthlyRate = annualRate / 100 / 12;
  const monthlyPayment = principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / 
                         (Math.pow(1 + monthlyRate, termMonths) - 1);
  return monthlyPayment;
}

// ==================== HPI APPRECIATION CALCULATION ====================

/**
 * State to FRED metro code mapping (uses nearest major metro for HPI)
 */
const STATE_TO_METRO_HPI = {
  'OR': 'portland',
  'WA': 'seattle', 
  'CA': 'los-angeles',
  'TX': 'dallas',
  'FL': 'miami',
  'AZ': 'phoenix',
  'CO': 'denver',
  'GA': 'atlanta',
  'IL': 'chicago',
  'NY': 'new-york',
  'MA': 'boston',
  'PA': 'philadelphia',
  'NC': 'charlotte',
  'TN': 'nashville',
  'OH': 'columbus',
  'MI': 'detroit',
  'MN': 'minneapolis',
  'NV': 'las-vegas',
  'UT': 'salt-lake-city',
  'VA': 'washington-dc',
  'MD': 'washington-dc',
  'NJ': 'new-york',
  'CT': 'new-york'
};

/**
 * Get the best HPI series for a location
 * @param {string} state - State code (e.g., 'OR', 'CA')
 * @param {string} city - City name (optional)
 * @returns {object} - { seriesIds: string[], metroName: string, metroCode: string }
 */
function getHPISeriesForLocation(state, city = null) {
  // Try to match city to metro first
  if (city) {
    const cityLower = city.toLowerCase();
    for (const [metroKey, metro] of Object.entries(METRO_CODES)) {
      if (metro.name.toLowerCase().includes(cityLower) || metroKey.includes(cityLower)) {
        return {
          seriesIds: metro.housing,
          metroName: metro.name,
          metroCode: metroKey
        };
      }
    }
  }
  
  // Fallback to state mapping
  const metroCode = STATE_TO_METRO_HPI[state];
  if (metroCode && METRO_CODES[metroCode]) {
    return {
      seriesIds: METRO_CODES[metroCode].housing,
      metroName: METRO_CODES[metroCode].name,
      metroCode: metroCode
    };
  }
  
  // Ultimate fallback: national index
  return {
    seriesIds: ['CSUSHPISA', 'USSTHPI'], // Case-Shiller National, FHFA National
    metroName: 'National Average',
    metroCode: 'national'
  };
}

/**
 * Calculate natural market appreciation between two dates using FRED HPI data
 * This replaces hardcoded appreciation rates with real market data
 * 
 * @param {string} state - State code (e.g., 'OR', 'CA')
 * @param {Date|string} startDate - Before sale date
 * @param {Date|string} endDate - After sale date
 * @param {string} city - Optional city name for metro-specific data
 * @param {string} propertyType - Optional: 'single_family', 'condo', 'multi_family'
 * @returns {Promise<{
 *   appreciationPercent: number,
 *   annualizedRate: number,
 *   dataSource: string,
 *   metroName: string,
 *   confidence: number,
 *   startIndex: number,
 *   endIndex: number,
 *   error?: string
 * }>}
 */
export async function calculateMarketAppreciation(state, startDate, endDate, city = null, propertyType = 'single_family') {
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Calculate the date range for FRED query
    // HPI data is typically quarterly, so we need to fetch enough history
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];
    
    // Get appropriate HPI series for location
    const { seriesIds, metroName, metroCode } = getHPISeriesForLocation(state, city);
    
    console.log(`[FRED HPI] Fetching appreciation data for ${metroName} (${metroCode})`);
    console.log(`[FRED HPI] Date range: ${startStr} to ${endStr}`);
    console.log(`[FRED HPI] Series IDs: ${seriesIds.join(', ')}`);
    
    // Fetch HPI data covering the entire date range
    const hpiData = await trySeriesWithFallback(seriesIds, {
      observation_start: startStr,
      observation_end: endStr,
      sort_order: 'asc'
    });
    
    const observations = hpiData.observations || [];
    
    if (observations.length < 2) {
      console.log('[FRED HPI] Insufficient data, using fallback estimation');
      // Fallback: estimate based on national average (~4% annual)
      const monthsHeld = Math.max(1, (end - start) / (30.44 * 24 * 60 * 60 * 1000));
      const estimatedRate = 4.0; // National average fallback
      const appreciationPercent = estimatedRate * (monthsHeld / 12);
      
      return {
        appreciationPercent: appreciationPercent,
        annualizedRate: estimatedRate,
        dataSource: 'estimated (insufficient FRED data)',
        metroName: metroName,
        confidence: 0.3,
        startIndex: null,
        endIndex: null,
        error: 'Insufficient historical data for date range'
      };
    }
    
    // Find the closest observations to our start and end dates
    const findClosestObservation = (targetDate, obs) => {
      let closest = obs[0];
      let closestDiff = Math.abs(new Date(obs[0].date) - targetDate);
      
      for (const o of obs) {
        const diff = Math.abs(new Date(o.date) - targetDate);
        if (diff < closestDiff) {
          closest = o;
          closestDiff = diff;
        }
      }
      return closest;
    };
    
    const startObs = findClosestObservation(start, observations);
    const endObs = findClosestObservation(end, observations);
    
    const startIndex = parseFloat(startObs.value);
    const endIndex = parseFloat(endObs.value);
    
    if (isNaN(startIndex) || isNaN(endIndex) || startIndex === 0) {
      throw new Error('Invalid HPI values');
    }
    
    // Calculate appreciation
    const appreciationPercent = ((endIndex - startIndex) / startIndex) * 100;
    
    // Calculate annualized rate
    const actualMonths = (new Date(endObs.date) - new Date(startObs.date)) / (30.44 * 24 * 60 * 60 * 1000);
    const annualizedRate = actualMonths > 0 ? (appreciationPercent / actualMonths) * 12 : appreciationPercent;
    
    // Confidence based on data quality
    const daysDiffStart = Math.abs(start - new Date(startObs.date)) / (24 * 60 * 60 * 1000);
    const daysDiffEnd = Math.abs(end - new Date(endObs.date)) / (24 * 60 * 60 * 1000);
    const avgDaysDiff = (daysDiffStart + daysDiffEnd) / 2;
    
    // Higher confidence if observations are closer to actual dates
    // 0 days diff = 1.0 confidence, 90 days diff = 0.5 confidence
    const confidence = Math.max(0.5, 1 - (avgDaysDiff / 180));
    
    console.log(`[FRED HPI] Result: ${appreciationPercent.toFixed(2)}% appreciation over ${actualMonths.toFixed(1)} months`);
    console.log(`[FRED HPI] Annualized rate: ${annualizedRate.toFixed(2)}%`);
    console.log(`[FRED HPI] Data points: ${startObs.date} (${startIndex}) -> ${endObs.date} (${endIndex})`);
    
    return {
      appreciationPercent: appreciationPercent,
      annualizedRate: annualizedRate,
      dataSource: `FRED HPI (${seriesIds[0]})`,
      metroName: metroName,
      metroCode: metroCode,
      confidence: confidence,
      startIndex: startIndex,
      startDate: startObs.date,
      endIndex: endIndex,
      endDate: endObs.date,
      monthsAnalyzed: actualMonths
    };
    
  } catch (error) {
    console.error('[FRED HPI] Error calculating appreciation:', error);
    
    // Fallback calculation
    const start = new Date(startDate);
    const end = new Date(endDate);
    const monthsHeld = Math.max(1, (end - start) / (30.44 * 24 * 60 * 60 * 1000));
    const fallbackRate = 4.0;
    
    return {
      appreciationPercent: fallbackRate * (monthsHeld / 12),
      annualizedRate: fallbackRate,
      dataSource: 'fallback estimate',
      metroName: 'National Average (fallback)',
      confidence: 0.2,
      startIndex: null,
      endIndex: null,
      error: error.message
    };
  }
}

/**
 * HYBRID APPRECIATION CALCULATOR
 * 
 * Calculates market appreciation using the best available data source:
 * 1. ATTOM Property AVM History (property-specific) - Most accurate
 * 2. ATTOM ZIP Sales Trend (ZIP code level) - More granular than metro
 * 3. FRED HPI (metro/MSA level) - Broad market fallback
 * 
 * @param {object} options - Appreciation calculation options
 * @param {string} options.state - State code (e.g., 'OR', 'CA')
 * @param {string} options.city - City name (optional)
 * @param {string} options.zipCode - 5-digit ZIP code (recommended for best accuracy)
 * @param {string} options.attomId - ATTOM property ID (for property-specific data)
 * @param {Date|string} options.startDate - Before sale/valuation date
 * @param {Date|string} options.endDate - After sale/valuation date
 * @param {string} options.propertyType - 'single_family', 'condo', etc.
 * @returns {Promise<{
 *   appreciationPercent: number,
 *   annualizedRate: number,
 *   dataSource: string,
 *   granularity: 'property' | 'zip' | 'metro' | 'national',
 *   confidence: number,
 *   methodsAttempted: string[],
 *   ...
 * }>}
 */
export async function calculateHybridAppreciation(options) {
  const {
    state,
    city = null,
    zipCode = null,
    attomId = null,
    startDate,
    endDate,
    propertyType = 'single_family'
  } = options;
  
  const methodsAttempted = [];
  let result = null;
  
  console.log('[Hybrid Appreciation] Starting with options:', {
    state, city, zipCode, attomId: attomId ? 'provided' : 'none',
    startDate, endDate
  });
  
  // Method 1: Try ATTOM Property AVM History (most granular)
  if (attomId) {
    try {
      methodsAttempted.push('ATTOM Property AVM');
      
      // Dynamic import to avoid circular dependencies
      const { calculatePropertyAVMAppreciation } = await import('./attom.js');
      const avmResult = await calculatePropertyAVMAppreciation(attomId, startDate, endDate);
      
      if (avmResult.ok && avmResult.confidence >= 0.5) {
        console.log('[Hybrid Appreciation] Using ATTOM Property AVM data');
        result = {
          ...avmResult,
          methodsAttempted,
          selectedMethod: 'ATTOM Property AVM',
          granularity: 'property'
        };
        return result;
      }
      console.log('[Hybrid Appreciation] ATTOM Property AVM failed or low confidence:', avmResult.error);
    } catch (err) {
      console.log('[Hybrid Appreciation] ATTOM Property AVM error:', err.message);
    }
  }
  
  // Method 2: Try ATTOM ZIP Sales Trend (ZIP-code level)
  if (zipCode) {
    try {
      methodsAttempted.push('ATTOM ZIP Trend');
      
      const { calculateZipAppreciation } = await import('./attom.js');
      const zipResult = await calculateZipAppreciation(zipCode, startDate, endDate);
      
      if (zipResult.ok && zipResult.confidence >= 0.4) {
        console.log('[Hybrid Appreciation] Using ATTOM ZIP Sales Trend data');
        result = {
          ...zipResult,
          methodsAttempted,
          selectedMethod: 'ATTOM ZIP Trend',
          granularity: 'zip'
        };
        return result;
      }
      console.log('[Hybrid Appreciation] ATTOM ZIP Trend failed or low confidence:', zipResult.error);
    } catch (err) {
      console.log('[Hybrid Appreciation] ATTOM ZIP error:', err.message);
    }
  }
  
  // Method 3: Fall back to FRED HPI (metro level)
  try {
    methodsAttempted.push('FRED Metro HPI');
    
    const fredResult = await calculateMarketAppreciation(state, startDate, endDate, city, propertyType);
    
    console.log('[Hybrid Appreciation] Using FRED Metro HPI data');
    result = {
      ...fredResult,
      methodsAttempted,
      selectedMethod: 'FRED Metro HPI',
      granularity: fredResult.metroCode === 'national' ? 'national' : 'metro'
    };
    return result;
    
  } catch (err) {
    console.log('[Hybrid Appreciation] FRED HPI error:', err.message);
    methodsAttempted.push('Fallback Estimate');
    
    // Ultimate fallback: use national average estimate
    const start = new Date(startDate);
    const end = new Date(endDate);
    const monthsHeld = Math.max(1, (end - start) / (30.44 * 24 * 60 * 60 * 1000));
    const fallbackRate = 4.0;
    
    return {
      appreciationPercent: fallbackRate * (monthsHeld / 12),
      annualizedRate: fallbackRate,
      dataSource: 'National Average Estimate',
      granularity: 'national',
      confidence: 0.2,
      methodsAttempted,
      selectedMethod: 'Fallback Estimate',
      error: 'All data sources failed, using national average'
    };
  }
}

/**
 * Metro area coordinates for heat map rendering
 */
const METRO_COORDS = {
  // ── Original 24 metros ──
  'san-francisco':   { lat: 37.7749, lng: -122.4194 },
  'austin':          { lat: 30.2672, lng: -97.7431 },
  'phoenix':         { lat: 33.4484, lng: -112.0740 },
  'miami':           { lat: 25.7617, lng: -80.1918 },
  'new-york':        { lat: 40.7128, lng: -74.0060 },
  'los-angeles':     { lat: 34.0522, lng: -118.2437 },
  'chicago':         { lat: 41.8781, lng: -87.6298 },
  'dallas':          { lat: 32.7767, lng: -96.7970 },
  'houston':         { lat: 29.7604, lng: -95.3698 },
  'seattle':         { lat: 47.6062, lng: -122.3321 },
  'denver':          { lat: 39.7392, lng: -104.9903 },
  'atlanta':         { lat: 33.7490, lng: -84.3880 },
  'washington-dc':   { lat: 38.9072, lng: -77.0369 },
  'dc':              { lat: 38.9072, lng: -77.0369 },
  'boston':           { lat: 42.3601, lng: -71.0589 },
  'portland':        { lat: 45.5152, lng: -122.6784 },
  'las-vegas':       { lat: 36.1699, lng: -115.1398 },
  'salt-lake-city':  { lat: 40.7608, lng: -111.8910 },
  'minneapolis':     { lat: 44.9778, lng: -93.2650 },
  'detroit':         { lat: 42.3314, lng: -83.0458 },
  'nashville':       { lat: 36.1627, lng: -86.7816 },
  'charlotte':       { lat: 35.2271, lng: -80.8431 },
  'columbus':        { lat: 39.9612, lng: -82.9988 },
  'philadelphia':    { lat: 39.9526, lng: -75.1652 },
  // ── Expanded metros (30+ additional) ──
  'san-diego':       { lat: 32.7157, lng: -117.1611 },
  'san-antonio':     { lat: 29.4241, lng: -98.4936 },
  'tampa':           { lat: 27.9506, lng: -82.4572 },
  'orlando':         { lat: 28.5383, lng: -81.3792 },
  'jacksonville':    { lat: 30.3322, lng: -81.6557 },
  'san-jose':        { lat: 37.3382, lng: -121.8863 },
  'sacramento':      { lat: 38.5816, lng: -121.4944 },
  'riverside':       { lat: 33.9533, lng: -117.3962 },
  'pittsburgh':      { lat: 40.4406, lng: -79.9959 },
  'st-louis':        { lat: 38.6270, lng: -90.1994 },
  'kansas-city':     { lat: 39.0997, lng: -94.5786 },
  'indianapolis':    { lat: 39.7684, lng: -86.1581 },
  'cincinnati':      { lat: 39.1031, lng: -84.5120 },
  'cleveland':       { lat: 41.4993, lng: -81.6944 },
  'milwaukee':       { lat: 43.0389, lng: -87.9065 },
  'raleigh':         { lat: 35.7796, lng: -78.6382 },
  'richmond':        { lat: 37.5407, lng: -77.4360 },
  'virginia-beach':  { lat: 36.8529, lng: -75.9780 },
  'baltimore':       { lat: 39.2904, lng: -76.6122 },
  'hartford':        { lat: 41.7658, lng: -72.6734 },
  'new-orleans':     { lat: 29.9511, lng: -90.0715 },
  'memphis':         { lat: 35.1495, lng: -90.0490 },
  'louisville':      { lat: 38.2527, lng: -85.7585 },
  'oklahoma-city':   { lat: 35.4676, lng: -97.5164 },
  'birmingham':      { lat: 33.5186, lng: -86.8104 },
  'buffalo':         { lat: 42.8864, lng: -78.8784 },
  'providence':      { lat: 41.8240, lng: -71.4128 },
  'tucson':          { lat: 32.2226, lng: -110.9747 },
  'el-paso':         { lat: 31.7619, lng: -106.4850 },
  'albuquerque':     { lat: 35.0844, lng: -106.6504 },
  'boise':           { lat: 43.6150, lng: -116.2023 },
  'honolulu':        { lat: 21.3069, lng: -157.8583 },
  'anchorage':       { lat: 61.2181, lng: -149.9003 },
  'charleston':      { lat: 32.7765, lng: -79.9311 },
  'columbia-sc':     { lat: 34.0007, lng: -81.0348 },
  'knoxville':       { lat: 35.9606, lng: -83.9207 },
  'des-moines':      { lat: 41.5868, lng: -93.6250 },
  'omaha':           { lat: 41.2565, lng: -95.9345 },
  'tulsa':           { lat: 36.1540, lng: -95.9928 },
  'little-rock':     { lat: 34.7465, lng: -92.2896 },
  'spokane':         { lat: 47.6588, lng: -117.4260 },
  'colorado-springs': { lat: 38.8339, lng: -104.8214 },
  'dayton':          { lat: 39.7589, lng: -84.1916 },
  'grand-rapids':    { lat: 42.9634, lng: -85.6681 },
  'greenville-sc':   { lat: 34.8526, lng: -82.3940 },
  'madison':         { lat: 43.0731, lng: -89.4012 },
  'provo':           { lat: 40.2338, lng: -111.6585 },
  'ogden':           { lat: 41.2230, lng: -111.9738 },
  'savannah':        { lat: 32.0809, lng: -81.0912 },
  'chattanooga':     { lat: 35.0456, lng: -85.3097 },
  // ── Additional metros ──
  'fresno':          { lat: 36.7378, lng: -119.7871 },
  'bakersfield':     { lat: 35.3733, lng: -119.0187 },
  'stockton':        { lat: 37.9577, lng: -121.2908 },
  'cape-coral':      { lat: 26.5629, lng: -81.9495 },
  'lakeland':        { lat: 28.0395, lng: -81.9498 },
  'deltona':         { lat: 28.9005, lng: -81.2637 },
  'north-port':      { lat: 27.0442, lng: -82.2362 },
  'palm-bay':        { lat: 28.0345, lng: -80.5887 },
  'pensacola':       { lat: 30.4213, lng: -87.2169 },
  'mcallen':         { lat: 26.2034, lng: -98.2300 },
  'waco':            { lat: 31.5493, lng: -97.1467 },
  'lexington':       { lat: 38.0406, lng: -84.5037 },
  'wichita':         { lat: 37.6872, lng: -97.3301 },
  'akron':           { lat: 41.0814, lng: -81.5190 },
  'toledo':          { lat: 41.6528, lng: -83.5379 },
  'greensboro':      { lat: 36.0726, lng: -79.7920 },
  'durham':          { lat: 35.9940, lng: -78.8986 },
  'winston-salem':   { lat: 36.0999, lng: -80.2442 },
  'huntsville':      { lat: 34.7304, lng: -86.5861 },
  'augusta':         { lat: 33.4735, lng: -82.0105 },
  'baton-rouge':     { lat: 30.4515, lng: -91.1871 },
  'fayetteville-ar': { lat: 36.0626, lng: -94.1574 },
  'rochester':       { lat: 43.1566, lng: -77.6088 },
  'scranton':        { lat: 41.4090, lng: -75.6624 },
  'worcester':       { lat: 42.2626, lng: -71.8023 },
  'harrisburg':      { lat: 40.2732, lng: -76.8867 },
  'springfield-mo':  { lat: 37.2090, lng: -93.2923 },
  'reno':            { lat: 39.5296, lng: -119.8138 },
};

/**
 * Get heat map data across all metros for a selected metric.
 * Returns lat/lng + metric value + YoY growth for each metro.
 * 
 * For CBSA-based metrics (listings, listing price, days on market, etc.),
 * uses the full CBSA_CATALOG (372 MSAs) for maximum geographic coverage.
 * For legacy metrics (housing, unemployment, income, wages) that require
 * metro-specific series IDs, uses METRO_CODES (~101 metros).
 * Composite metrics (rent-to-price, affordability) fetch two series per metro
 * and compute ratios.
 * 
 * @param {string} metric - Metric key
 * @returns {Promise<Object>} Heat map data with points, stats, and metadata
 */

// ── In-memory cache for metro history ──
const _metroHistoryCache = new Map();
const METRO_HISTORY_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

/**
 * Get historical time-series data for a specific metro (CBSA code) across
 * multiple economic metrics. Used by the metro detail modal.
 *
 * @param {string} cbsaCode - 5-digit CBSA code (e.g. "12060")
 * @returns {Promise<Object>} Historical series data for the metro
 */
export async function getMetroHistory(cbsaCode) {
  if (!cbsaCode) throw new Error('cbsaCode is required');

  const cacheKey = `metro-history:${cbsaCode}`;
  const cached = _metroHistoryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < METRO_HISTORY_CACHE_TTL) {
    console.log(`[FRED] Metro history cache HIT for ${cbsaCode}`);
    return cached.data;
  }

  const info = CBSA_CATALOG[cbsaCode];
  if (!info) throw new Error(`Unknown CBSA code: ${cbsaCode}`);

  console.log(`[FRED] Fetching metro history for ${cbsaCode} (${info.n})`);

  // Build series IDs for each metric using the same patterns as getHeatMapData
  const prefix = CITY_PREFIX_MAP[cbsaCode] || '';
  const stFips = STATE_FIPS[info.st] || '';
  const cbsaPadded = cbsaCode.padEnd(7, '0');

  const seriesMap = {
    housing:      [`ATNHPIUS${cbsaCode}Q`],
    listings:     [`ACTLISCOU${cbsaCode}`],
    listingPrice: [`MEDLISPRI${cbsaCode}`],
    daysOnMarket: [`MEDDAYONMAR${cbsaCode}`],
    newListings:  [`NEWLISCOU${cbsaCode}`],
    priceReduced: [`PRIREDCOU${cbsaCode}`],
    unemployment: prefix ? [`${prefix}URN`, `${prefix}UR`] : [],
    income:       prefix ? [`${prefix}PCPI`] : [],
    permits:      prefix ? [`${prefix}BPPRIVSA`] : [],
    wages:        stFips ? [`SMU${stFips}${cbsaPadded}0500000003SA`] : [],
    gdp:          [`RGMP${cbsaCode}`],
    rentPrice:    [`RPPSERVERENT${cbsaCode}`],
  };

  // Fetch all metrics in parallel (each with up to 120 observations for ~10 yr history)
  const metricKeys = Object.keys(seriesMap);
  const fetchPromises = metricKeys.map(async (key) => {
    const ids = seriesMap[key];
    if (!ids.length) return { key, observations: [] };
    try {
      const result = await trySeriesWithFallback(ids, { limit: 120, sort_order: 'desc' }, { freshnessFirst: false });
      const obs = (result.observations || [])
        .filter(o => o.value !== '.')
        .map(o => ({ date: o.date, value: parseFloat(o.value) }))
        .filter(o => !isNaN(o.value))
        .reverse(); // chronological order (oldest first)
      return { key, observations: obs };
    } catch {
      return { key, observations: [] };
    }
  });

  const results = await Promise.all(fetchPromises);

  // Format labels for the frontend
  const metricLabels = {
    housing:      'Housing Price Index',
    listings:     'Active Listings',
    listingPrice: 'Median Listing Price',
    daysOnMarket: 'Median Days on Market',
    newListings:  'New Listings',
    priceReduced: 'Price Reductions',
    unemployment: 'Unemployment Rate',
    income:       'Per Capita Income',
    permits:      'Building Permits',
    wages:        'Avg Weekly Wage',
    gdp:          'Real GDP (Millions $)',
    rentPrice:    'Rent Price Parity',
  };

  const metricUnits = {
    housing:      'index',
    listings:     'count',
    listingPrice: 'usd',
    daysOnMarket: 'days',
    newListings:  'count',
    priceReduced: 'count',
    unemployment: 'percent',
    income:       'usd',
    permits:      'count',
    wages:        'usd',
    gdp:          'millions',
    rentPrice:    'index',
  };

  const series = {};
  for (const { key, observations } of results) {
    if (observations.length === 0) continue;
    const latest = observations[observations.length - 1];
    const earliest = observations[0];
    // Calculate YoY for the latest value
    let yoyGrowth = null;
    const latestDate = new Date(latest.date);
    const targetDate = new Date(latestDate);
    targetDate.setFullYear(targetDate.getFullYear() - 1);
    let bestDiff = Infinity, yearAgoVal = null;
    for (const o of observations) {
      const diff = Math.abs(new Date(o.date) - targetDate);
      if (diff < bestDiff) { bestDiff = diff; yearAgoVal = o.value; }
    }
    if (yearAgoVal && bestDiff < 120 * 86400000 && yearAgoVal !== 0) {
      yoyGrowth = parseFloat(((latest.value - yearAgoVal) / yearAgoVal * 100).toFixed(1));
    }

    series[key] = {
      label: metricLabels[key] || key,
      unit: metricUnits[key] || 'value',
      observations,
      latest: latest.value,
      latestDate: latest.date,
      earliest: earliest.value,
      earliestDate: earliest.date,
      yoyGrowth,
      count: observations.length,
    };
  }

  const data = {
    cbsa: cbsaCode,
    name: info.n,
    state: info.st,
    lat: info.lat,
    lng: info.lng,
    series,
    fetchedAt: new Date().toISOString(),
  };

  _metroHistoryCache.set(cacheKey, { data, ts: Date.now() });
  console.log(`[FRED] Metro history cached for ${cbsaCode}: ${Object.keys(series).length} metrics`);
  return data;
}

export async function getHeatMapData(metric = 'housing') {
  // Return cached result if still fresh
  const cached = _heatMapCache.get(metric);
  if (cached && Date.now() - cached.ts < HEATMAP_CACHE_TTL) {
    console.log(`[FRED] Heat map cache HIT for ${metric} (age: ${Math.round((Date.now() - cached.ts) / 1000)}s)`);
    return cached.data;
  }

  try {
    console.log(`[FRED] Fetching heat map data for metric: ${metric}`);
    
    // Extract CBSA code from a metro's housing series (e.g. 'ATNHPIUS12060Q' → '12060')
    const extractCbsaCode = (metro) => {
      for (const sid of (metro.housing || [])) {
        const m = sid.match(/ATNHPIUS(\d+)Q/);
        if (m) return m[1];
      }
      return null;
    };

    // MSA-level building permit series (city-prefix naming convention, not CBSA)
    const PERMIT_SERIES = {
      '12060': 'ATLA013BPPRIVSA',   // Atlanta
      '12420': 'AUST448BPPRIVSA',   // Austin
      '12580': 'BALT524BPPRIVSA',   // Baltimore
      '13820': 'BIRM801BPPRIVSA',   // Birmingham
      '14260': 'BOIS216BPPRIVSA',   // Boise
      '14460': 'BOST625BPPRIVSA',   // Boston
      '15980': 'CAPE912BPPRIVSA',   // Cape Coral
      '16700': 'CHAR745BPPRIVSA',   // Charleston SC
      '16740': 'CHAR737BPPRIVSA',   // Charlotte
      '16980': 'CHIC917BPPRIVSA',   // Chicago
      '17140': 'CINC139BPPRIVSA',   // Cincinnati
      '17460': 'CLEV439BPPRIVSA',   // Cleveland
      '17820': 'COLO808BPPRIVSA',   // Colorado Springs
      '18140': 'COLU139BPPRIVSA',   // Columbus
      '19100': 'DALL148BPPRIVSA',   // Dallas
      '19660': 'DELT612BPPRIVSA',   // Deltona
      '19740': 'DENV708BPPRIVSA',   // Denver
      '19780': 'DESM719BPPRIVSA',   // Des Moines
      '19820': 'DETR826BPPRIVSA',   // Detroit
      '20500': 'DURH537BPPRIVSA',   // Durham
      '24340': 'GRAN326BPPRIVSA',   // Grand Rapids
      '24660': 'GREE537BPPRIVSA',   // Greensboro
      '24860': 'GREE845BPPRIVSA',   // Greenville SC
      '25420': 'HARR551BPPRIVSA',   // Harrisburg
      '26420': 'HOUS448BPPRIVSA',   // Houston
      '26900': 'INDI918BPPRIVSA',   // Indianapolis
      '27260': 'JACK212BPPRIVSA',   // Jacksonville
      '28140': 'KANS129BPPRIVSA',   // Kansas City
      '29460': 'LAKE412BPPRIVSA',   // Lakeland
      '29820': 'LASV832BPPRIVSA',   // Las Vegas
      '31080': 'LOSA106BPPRIVSA',   // Los Angeles
      '31540': 'MADI555BPPRIVSA',   // Madison
      '32580': 'MCAL548BPPRIVSA',   // McAllen
      '33100': 'MIAM112BPPRIVSA',   // Miami
      '33340': 'MILW355BPPRIVSA',   // Milwaukee
      '33460': 'MINN427BPPRIVSA',   // Minneapolis
      '34980': 'NASH947BPPRIVSA',   // Nashville
      '35380': 'NEWO322BPPRIVSA',   // New Orleans
      '35620': 'NEWY636BPPRIVSA',   // New York
      '36420': 'OKLA440BPPRIVSA',   // Oklahoma City
      '36540': 'OMAH531BPPRIVSA',   // Omaha
      '36740': 'ORLA712BPPRIVSA',   // Orlando
      '37340': 'PALM312BPPRIVSA',   // Palm Bay
      '37860': 'PENS812BPPRIVSA',   // Pensacola
      '37980': 'PHIL942BPPRIVSA',   // Philadelphia
      '38060': 'PHOE004BPPRIVSA',   // Phoenix
      '38300': 'PITT342BPPRIVSA',   // Pittsburgh
      '38900': 'PORT941BPPRIVSA',   // Portland
      '39580': 'RALE537BPPRIVSA',   // Raleigh
      '39900': 'RENO932BPPRIVSA',   // Reno
      '40060': 'RICH051BPPRIVSA',   // Richmond
      '40140': 'RIVE106BPPRIVSA',   // Riverside
      '40900': 'SACR906BPPRIVSA',   // Sacramento (alias SARA212)
      '41620': 'SALT649BPPRIVSA',   // Salt Lake City
      '41700': 'SANA748BPPRIVSA',   // San Antonio
      '41740': 'SAND706BPPRIVSA',   // San Diego
      '41860': 'SANF806BPPRIVSA',   // San Francisco
      '41940': 'SANJ906BPPRIVSA',   // San Jose
      '42660': 'SEAT653BPPRIVSA',   // Seattle
      '45300': 'TAMP312BPPRIVSA',   // Tampa
      '46060': 'TUCS004BPPRIVSA',   // Tucson
      '46140': 'TULS140BPPRIVSA',   // Tulsa
      '47260': 'VIRG251BPPRIVSA',   // Virginia Beach
      '47900': 'WASH911BPPRIVSA',   // Washington DC
      '46520': 'HONO115BPPRIVSA',   // Honolulu
      '10740': 'ALBU735BPPRIVSA',   // Albuquerque
      '35840': 'SARA212BPPRIVSA',   // North Port-Sarasota-Bradenton
      '44700': 'STOC706BPPRIVSA',   // Stockton
    };

    // ── Metrics that can use the full CBSA_CATALOG (372 MSAs) ──
    // These use simple CBSA-code-based FRED series ID patterns
    const CBSA_METRICS = {
      listings:      cbsa => [`ACTLISCOU${cbsa}`],
      daysOnMarket:  cbsa => [`MEDDAYONMAR${cbsa}`],
      newListings:   cbsa => [`NEWLISCOU${cbsa}`],
      listingPrice:  cbsa => [`MEDLISPRI${cbsa}`],
      priceReduced:  cbsa => [`PRIREDCOU${cbsa}`],
      rentPrice:     cbsa => [`RPPSERVERENT${cbsa}`],
      housing:       cbsa => [`ATNHPIUS${cbsa}Q`],
      gdp:           cbsa => [`RGMP${cbsa}`],  // Real GDP by MSA (DISCONTINUED but data available)
      // City-prefix metrics: use CITY_PREFIX_MAP for the {PREFIX} part
      unemployment:  cbsa => {
        const p = CITY_PREFIX_MAP[cbsa];
        return p ? [`${p}URN`, `${p}UR`] : [];  // NSA monthly, SA monthly fallback
      },
      income:        cbsa => {
        const p = CITY_PREFIX_MAP[cbsa];
        return p ? [`${p}PCPI`] : [];  // Per Capita Personal Income (annual, DISCONTINUED)
      },
      permits:       cbsa => {
        const p = CITY_PREFIX_MAP[cbsa];
        return p ? [`${p}BPPRIVSA`] : [];  // Building Permits SA monthly
      },
      wages:         cbsa => {
        // BLS wages use SMU{stFIPS}{cbsa_padded}{industry}{dataType}SA
        // stFIPS comes from CBSA_CATALOG state → STATE_FIPS lookup
        const info = CBSA_CATALOG[cbsa];
        if (!info) return [];
        const stFips = STATE_FIPS[info.st];
        if (!stFips) return [];
        const cbsaPadded = cbsa.padEnd(7, '0');
        // Total Private (0500000), Avg Weekly Wages (03), SA
        return [`SMU${stFips}${cbsaPadded}0500000003SA`, `SMU${stFips}${cbsaPadded}0500000011SA`];
      },
    };
    
    // ── Composite ratio metrics: fetch two series and compute a ratio ──
    const COMPOSITE_METRICS = {
      // Rent-to-Price Ratio: annual rent parity / median listing price × scaling factor
      // Higher = rents are expensive relative to home prices (better for landlords)
      rentToPrice: {
        seriesA: cbsa => `RPPSERVERENT${cbsa}`,  // Rent parity index (100 = national avg)
        seriesB: cbsa => `MEDLISPRI${cbsa}`,      // Median listing price ($)
        compute: (rentIdx, price) => price > 0 ? (rentIdx / price) * 10000 : null,
        label: 'Rent-to-Price Ratio',
        description: 'Rent parity ÷ listing price — higher = better rental yield potential',
      },
      // Price-to-Rent: inverse — shows how many "rent units" to buy
      // Lower = more affordable for investors
      priceToRent: {
        seriesA: cbsa => `MEDLISPRI${cbsa}`,      // Median listing price ($)
        seriesB: cbsa => `RPPSERVERENT${cbsa}`,    // Rent parity index
        compute: (price, rentIdx) => rentIdx > 0 ? price / rentIdx : null,
        label: 'Price-to-Rent Ratio',
        description: 'Listing price ÷ rent parity — lower = more affordable to invest',
      },
      // Inventory Velocity: active listings / new listings per month
      // Lower = faster market (less supply relative to new additions)
      inventoryVelocity: {
        seriesA: cbsa => `ACTLISCOU${cbsa}`,      // Active listings
        seriesB: cbsa => `NEWLISCOU${cbsa}`,       // New listings
        compute: (active, newL) => newL > 0 ? active / newL : null,
        label: 'Inventory Turnover',
        description: 'Active listings ÷ new listings — lower = faster-moving market',
      },
    };

    const isCbsaMetric = metric in CBSA_METRICS;
    const isComposite = metric in COMPOSITE_METRICS;
    const isLegacyMetric = false; // All metrics now use CBSA_CATALOG via CITY_PREFIX_MAP
    // rentalVacancy is state-level, still uses CBSA_CATALOG for metro locations
    const isStateLevel = metric === 'rentalVacancy';

    // ── Build the metro list to iterate ──
    let metroList;
    
    if (isCbsaMetric || isComposite || isStateLevel) {
      // Use full CBSA_CATALOG (372 MSAs) for CBSA-based metrics
      metroList = Object.entries(CBSA_CATALOG).map(([cbsa, info]) => ({
        code: cbsa,
        cbsa,
        name: info.n,
        lat: info.lat,
        lng: info.lng,
        state: info.st,
      }));
      console.log(`[FRED] Using CBSA_CATALOG: ${metroList.length} MSAs for metric "${metric}"`);
    } else {
      // Legacy metrics: use METRO_CODES (~101 metros) which have specific series IDs
      const seen = new Set();
      metroList = [];
      for (const [code, data] of Object.entries(METRO_CODES)) {
        const key = data.name;
        if (seen.has(key)) continue;
        seen.add(key);
        if (METRO_COORDS[code]) {
          const cbsa = extractCbsaCode(data);
          metroList.push({
            code,
            cbsa,
            name: data.name,
            lat: METRO_COORDS[code].lat,
            lng: METRO_COORDS[code].lng,
            state: null,
            _metroData: data, // carry full METRO_CODES data for legacy lookups
          });
        }
      }
      console.log(`[FRED] Using METRO_CODES: ${metroList.length} metros for metric "${metric}"`);
    }

    // ── Resolve series IDs for each metro ──
    const getSeriesIds = (metro) => {
      if (isCbsaMetric) {
        return CBSA_METRICS[metric](metro.cbsa);
      }
      if (isStateLevel) {
        const st = metro.state || CBSA_CATALOG[metro.cbsa]?.st;
        return st ? [`${st}RVAC`] : [];
      }
      // Legacy metrics
      const data = metro._metroData;
      if (!data) return [];
      switch (metric) {
        case 'unemployment': return data.unemployment;
        case 'income':       return data.income;
        case 'wages':        return data.wages;
        case 'permits': {
          const cbsa = metro.cbsa;
          return cbsa && PERMIT_SERIES[cbsa] ? [PERMIT_SERIES[cbsa]] : (data.buildingPermits || []);
        }
        default: return data.housing;
      }
    };

    // ── Shared observation → result transform ──
    const obsToResult = (metro, obs) => {
      const latest = obs[0];
      const latestVal = parseFloat(latest.value);
      
      // Calculate YoY growth
      const latestDate = new Date(latest.date);
      const targetDate = new Date(latestDate);
      targetDate.setFullYear(targetDate.getFullYear() - 1);
      
      let yearAgo = null, bestDiff = Infinity;
      for (const o of obs) {
        const diff = Math.abs(new Date(o.date) - targetDate);
        if (diff < bestDiff) { bestDiff = diff; yearAgo = o; }
      }
      
      let yoyGrowth = null;
      if (yearAgo && bestDiff < 120 * 86400000) {
        const prevVal = parseFloat(yearAgo.value);
        if (!isNaN(prevVal) && prevVal !== 0) {
          yoyGrowth = ((latestVal - prevVal) / prevVal * 100);
        }
      }
      
      return {
        code: metro.code,
        name: metro.name,
        lat: metro.lat,
        lng: metro.lng,
        value: latestVal,
        date: latest.date,
        yoyGrowth: yoyGrowth !== null ? parseFloat(yoyGrowth.toFixed(1)) : null,
      };
    };

    // ── Fetch data in batches ──
    const batchSize = 5;
    const results = [];
    
    for (let i = 0; i < metroList.length; i += batchSize) {
      const batch = metroList.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(metroList.length / batchSize);
      if (batchNum % 15 === 1 || batchNum === totalBatches) {
        console.log(`[FRED] Heat map batch ${batchNum}/${totalBatches} (${results.filter(Boolean).length} found so far)`);
      }
      
      const batchResults = await Promise.all(
        batch.map(async (metro) => {
          try {
            // ── Composite metric: fetch two series, compute ratio ──
            if (isComposite) {
              const comp = COMPOSITE_METRICS[metric];
              const idA = comp.seriesA(metro.cbsa);
              const idB = comp.seriesB(metro.cbsa);
              const [dataA, dataB] = await Promise.all([
                trySeriesWithFallback([idA], { limit: 5, sort_order: 'desc' }, { freshnessFirst: false }).catch(() => null),
                trySeriesWithFallback([idB], { limit: 5, sort_order: 'desc' }, { freshnessFirst: false }).catch(() => null),
              ]);
              const obsA = (dataA?.observations || []).filter(o => o.value !== '.');
              const obsB = (dataB?.observations || []).filter(o => o.value !== '.');
              if (!obsA.length || !obsB.length) return null;
              
              const valA = parseFloat(obsA[0].value);
              const valB = parseFloat(obsB[0].value);
              const computed = comp.compute(valA, valB);
              if (computed === null || isNaN(computed)) return null;
              
              return {
                code: metro.code,
                name: metro.name,
                lat: metro.lat,
                lng: metro.lng,
                value: parseFloat(computed.toFixed(2)),
                date: obsA[0].date,
                yoyGrowth: null, // Composite ratios don't have simple YoY
              };
            }
            
            // ── Standard single-series metric ──
            const seriesIds = getSeriesIds(metro);
            if (!seriesIds || seriesIds.length === 0) return null;
            
            const data = await trySeriesWithFallback(seriesIds, { limit: 30, sort_order: 'desc' }, { freshnessFirst: false });
            const obs = (data.observations || []).filter(o => o.value !== '.');
            if (obs.length === 0) return null;
            
            return obsToResult(metro, obs);
          } catch (err) {
            // Silently skip failed metros (many small MSAs may not have all series)
            return null;
          }
        })
      );
      results.push(...batchResults);
      // Wait between batches (queue handles per-request spacing,
      // but we add a short pause so we don't overload the queue)
      if (i + batchSize < metroList.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const validResults = results.filter(Boolean);
    
    // Calculate min/max for normalization in the UI
    const values = validResults.map(r => r.value).filter(v => !isNaN(v));
    const growths = validResults.map(r => r.yoyGrowth).filter(v => v !== null);
    
    const metricLabels = {
      housing: 'Housing Price Index',
      unemployment: 'Unemployment Rate',
      income: 'Per Capita Personal Income',
      wages: 'Average Weekly Wage',
      permits: 'Building Permits',
      listings: 'Active Listings',
      daysOnMarket: 'Median Days on Market',
      newListings: 'New Listing Count',
      listingPrice: 'Median Listing Price',
      priceReduced: 'Price Reduced Count',
      rentPrice: 'Rent Price Parity Index',
      rentalVacancy: 'Rental Vacancy Rate',
      gdp: 'Real GDP (Millions $)',
    };
    // Add composite metric labels
    for (const [key, comp] of Object.entries(COMPOSITE_METRICS)) {
      metricLabels[key] = comp.label;
    }
    
    const result = {
      metric,
      metricLabel: metricLabels[metric] || metric,
      points: validResults,
      stats: {
        count: validResults.length,
        valueRange: values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: 0, max: 0 },
        growthRange: growths.length > 0 
          ? { min: Math.min(...growths), max: Math.max(...growths) }
          : null,
        avgGrowth: growths.length > 0 
          ? parseFloat((growths.reduce((a, b) => a + b, 0) / growths.length).toFixed(1))
          : null
      }
    };

    // Cache the result
    _heatMapCache.set(metric, { data: result, ts: Date.now() });
    console.log(`[FRED] Heat map cached for ${metric}: ${validResults.length} metros`);
    return result;
  } catch (error) {
    console.error('[FRED] Error fetching heat map data:', error);
    throw error;
  }
}

/** Clear in-memory heat-map cache for a single metric or all. */
export function clearHeatMapMemoryCache(metric) {
  if (metric) {
    _heatMapCache.delete(metric);
  } else {
    _heatMapCache.clear();
  }
}

/**
 * FOMC Meeting Calendar
 * Returns the upcoming Federal Reserve meeting schedule with days-until
 * calculations and minutes publication dates.
 */
export function getFomcCalendar() {
  // Official FOMC meeting end dates (statements released on final day ~2 PM ET)
  const meetings = [
    // 2025
    { start: '2025-01-28', end: '2025-01-29', label: 'January 2025' },
    { start: '2025-03-18', end: '2025-03-19', label: 'March 2025' },
    { start: '2025-04-29', end: '2025-04-30', label: 'April 2025' },
    { start: '2025-06-17', end: '2025-06-18', label: 'June 2025' },
    { start: '2025-07-29', end: '2025-07-30', label: 'July 2025' },
    { start: '2025-09-16', end: '2025-09-17', label: 'September 2025' },
    { start: '2025-10-28', end: '2025-10-29', label: 'October 2025' },
    { start: '2025-12-09', end: '2025-12-10', label: 'December 2025' },
    // 2026
    { start: '2026-01-27', end: '2026-01-28', label: 'January 2026' },
    { start: '2026-03-17', end: '2026-03-18', label: 'March 2026' },
    { start: '2026-05-05', end: '2026-05-06', label: 'May 2026' },
    { start: '2026-06-16', end: '2026-06-17', label: 'June 2026' },
    { start: '2026-07-28', end: '2026-07-29', label: 'July 2026' },
    { start: '2026-09-15', end: '2026-09-16', label: 'September 2026' },
    { start: '2026-10-27', end: '2026-10-28', label: 'October 2026' },
    { start: '2026-12-08', end: '2026-12-09', label: 'December 2026' },
  ];

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // A meeting is "upcoming" if its end date is today or in the future
  const upcoming = meetings.filter(m => m.end >= todayStr);
  const past = meetings.filter(m => m.end < todayStr);

  const next = upcoming[0] || null;
  const lastMeeting = past.length > 0 ? past[past.length - 1] : null;

  let daysUntilNext = null;
  let minutesReleaseDate = null;

  if (next) {
    const startDate = new Date(next.start + 'T00:00:00');
    daysUntilNext = Math.ceil((startDate - now) / (1000 * 60 * 60 * 24));
    // FOMC minutes are released approximately 3 weeks (21 days) after the meeting end date
    const mDate = new Date(next.end + 'T00:00:00');
    mDate.setDate(mDate.getDate() + 21);
    minutesReleaseDate = mDate.toISOString().split('T')[0];
  }

  return {
    next,
    daysUntilNext,
    minutesReleaseDate,
    upcoming: upcoming.slice(0, 5),
    lastMeeting,
    source: 'Federal Reserve (federalreserve.gov)',
    note: 'Dates are official FOMC scheduled meetings. Unscheduled emergency meetings may occur.'
  };
}
