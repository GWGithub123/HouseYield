// Zillow RapidAPI Data Integration for Real Estate Property Search
// Replaces Snowflake as the primary data source
// Uses: private-zillow.p.rapidapi.com via RapidAPI
// Requires: Rapid_API_Key in .env
import 'dotenv/config';

// ============================================
// CONFIGURATION
// ============================================
const RAPIDAPI_KEY = process.env.Rapid_API_Key || '';
const RAPIDAPI_HOST = 'private-zillow.p.rapidapi.com';
const BASE_URL = `https://${RAPIDAPI_HOST}`;

const HEADERS = {
  'x-rapidapi-host': RAPIDAPI_HOST,
  'x-rapidapi-key': RAPIDAPI_KEY,
};

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 200; // 5 req/sec max to stay safe

// Quota tracking
let quotaExceeded = false;
let quotaExceededAt = 0;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown before retrying

export function isQuotaExceeded() {
  if (!quotaExceeded) return false;
  // Auto-reset after cooldown
  if (Date.now() - quotaExceededAt > QUOTA_COOLDOWN_MS) {
    quotaExceeded = false;
    return false;
  }
  return true;
}

// In-memory cache with TTL
const cache = new Map();
const CACHE_TTL = {
  propertyDetail: 24 * 60 * 60 * 1000,   // 24 hours
  priceHistory: 12 * 60 * 60 * 1000,     // 12 hours  
  search: 1 * 60 * 60 * 1000,            // 1 hour
  marketData: 6 * 60 * 60 * 1000,        // 6 hours
  comparables: 12 * 60 * 60 * 1000,      // 12 hours
};

function getCached(key, ttlCategory) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL[ttlCategory]) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlCategory) {
  // Cap cache at 5000 entries
  if (cache.size > 5000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < 1000; i++) cache.delete(oldest[i][0]);
  }
  cache.set(key, { data, timestamp: Date.now(), category: ttlCategory });
}

// ============================================
// HTTP CLIENT WITH RATE LIMITING
// ============================================
async function apiRequest(endpoint, params = {}) {
  // Check quota before making request
  if (isQuotaExceeded()) {
    throw new Error('QUOTA_EXCEEDED: Zillow API monthly request quota exceeded. Upgrade plan at RapidAPI or wait for quota reset.');
  }

  // Rate limiting
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();

  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const cacheKey = url.toString();
  
  try {
    const response = await fetch(url.toString(), { headers: HEADERS });
    
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 429) {
        quotaExceeded = true;
        quotaExceededAt = Date.now();
        console.error(`[ZillowAPI] ⚠️ Monthly API quota exceeded. Calls will be blocked for 1 hour.`);
        throw new Error('QUOTA_EXCEEDED: Zillow API monthly request quota exceeded. Upgrade plan at RapidAPI or wait for quota reset.');
      }
      throw new Error(`Zillow API ${response.status}: ${text}`);
    }
    
    const data = await response.json();
    
    if (data.message && data.message.startsWith('404')) {
      return null;
    }
    
    return data;
  } catch (error) {
    console.error(`[ZillowAPI] Error calling ${endpoint}:`, error.message);
    throw error;
  }
}

async function cachedApiRequest(endpoint, params, ttlCategory) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  const cacheKey = url.toString();
  
  const cached = getCached(cacheKey, ttlCategory);
  if (cached) return cached;

  const data = await apiRequest(endpoint, params);
  if (data) setCache(cacheKey, data, ttlCategory);
  return data;
}

// ============================================
// GEOCODING HELPER — ZIP to coordinates
// ============================================
const ZIP_COORDS_CACHE = new Map();

async function getZipCoordinates(zip) {
  if (ZIP_COORDS_CACHE.has(zip)) return ZIP_COORDS_CACHE.get(zip);
  
  // Use the autocomplete endpoint to resolve ZIP to coords
  try {
    const data = await apiRequest('autocomplete', { query: zip });
    if (data && data.results && data.results.length > 0) {
      const match = data.results.find(r => r.metaData?.lat) || data.results[0];
      if (match && match.metaData) {
        const coords = { lat: match.metaData.lat, lng: match.metaData.lng };
        ZIP_COORDS_CACHE.set(zip, coords);
        return coords;
      }
    }
  } catch (e) {
    console.warn(`[ZillowAPI] Could not resolve ZIP ${zip} to coordinates:`, e.message);
  }
  
  // Fallback: hardcoded major ZIP prefixes (approximate centroids)
  // This is just a safety net
  return null;
}

// ============================================
// ADDRESS RESOLVER — autocomplete-based zpid lookup
// This is the KEY discovery: autocomplete is the ONLY way to go
// from an address string to a zpid on this API tier.
// ============================================
const RESOLVE_CACHE = new Map();

async function resolveAddress(addressQuery) {
  if (!addressQuery) return null;
  const key = addressQuery.toString().trim().toLowerCase();
  if (RESOLVE_CACHE.has(key)) return RESOLVE_CACHE.get(key);

  const data = await apiRequest('autocomplete', { query: addressQuery });
  if (!data?.results?.length) return null;

  // Find the best address match
  const addressResult = data.results.find(r => r.resultType === 'Address') || data.results[0];
  if (!addressResult?.metaData?.zpid) return null;

  const meta = addressResult.metaData;
  const result = {
    zpid: meta.zpid,
    lat: meta.lat,
    lng: meta.lng,
    streetNumber: meta.streetNumber || '',
    streetName: meta.streetName || '',
    city: meta.city || '',
    state: meta.state || '',
    zipCode: meta.zipCode || '',
    display: addressResult.display || '',
  };

  RESOLVE_CACHE.set(key, result);
  return result;
}

/**
 * Convert a ZIP code to "City, ST" format for housing_market endpoint.
 * housing_market requires city name, not ZIP alone.
 */
async function zipToCityState(zip) {
  if (!zip) return zip;
  // If it already looks like "City, ST", return as-is
  if (/[a-zA-Z]/.test(zip) && zip.includes(',')) return zip;
  
  // Query autocomplete directly — it returns Region results for ZIP codes
  // which include city/state without needing a zpid
  try {
    const data = await apiRequest('autocomplete', { query: zip });
    if (data?.results?.length) {
      // Look for Region result first (ZIP→city mapping)
      const region = data.results.find(r => r.resultType === 'Region' && r.metaData?.city);
      if (region?.metaData?.city && region?.metaData?.state) {
        return `${region.metaData.city}, ${region.metaData.state}`;
      }
      // Fall back to any result with city info
      const withCity = data.results.find(r => r.metaData?.city && r.metaData?.state);
      if (withCity) {
        return `${withCity.metaData.city}, ${withCity.metaData.state}`;
      }
    }
  } catch (e) {
    console.warn(`[ZillowAPI] zipToCityState failed for ${zip}:`, e.message);
  }
  return zip; // fallback
}

// ============================================
// CONNECTION TEST
// ============================================
export async function testConnection() {
  try {
    const data = await apiRequest('search/bycoordinates', {
      latitude: 33.749, longitude: -84.388, radius: 1, page: 1
    });
    return {
      connected: true,
      source: 'Zillow RapidAPI',
      resultsCount: data?.resultsCount?.totalMatchingCount || 0,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

// ============================================
// PROPERTY SEARCH FUNCTIONS
// ============================================

/**
 * Search properties by various filters
 * Replaces: searchMLSProperties, searchProperties, searchMLSPropertiesWithImages
 */
export async function searchMLSPropertiesWithImages(filters = {}) {
  const {
    city, state, zip, minPrice, maxPrice, minBeds, maxBeds,
    minBaths, maxBaths, propertyType, minSqft, maxSqft,
    minYearBuilt, maxYearBuilt, status, limit = 40, offset = 0,
  } = filters;

  const params = { page: Math.floor(offset / 200) + 1 };
  
  if (minPrice) params.minPrice = minPrice;
  if (maxPrice) params.maxPrice = maxPrice;
  if (minBeds) params.minBeds = minBeds;
  if (maxBeds) params.maxBeds = maxBeds;
  if (minBaths) params.minBaths = minBaths;
  if (maxBaths) params.maxBaths = maxBaths;
  if (propertyType) params.homeType = mapPropertyType(propertyType);
  if (status) params.status = status;
  
  let endpoint, searchParams;
  
  if (zip) {
    // Use address search with ZIP as location
    endpoint = 'search/byaddress';
    searchParams = { ...params, address: `${city || ''} ${state || ''} ${zip}`.trim() };
  } else if (city && state) {
    endpoint = 'search/byaddress';
    searchParams = { ...params, address: `${city}, ${state}` };
  } else {
    // Default to coordinates if available
    endpoint = 'search/bycoordinates';
    searchParams = { ...params, latitude: 33.749, longitude: -84.388, radius: 10 };
  }

  const data = await cachedApiRequest(endpoint, searchParams, 'search');
  if (!data || !data.searchResults) return [];

  return data.searchResults
    .filter(r => r.property)
    .slice(0, limit)
    .map(r => normalizeSearchResult(r.property));
}

/**
 * Search properties by geographic bounds
 * Replaces: searchPropertiesInBounds
 */
export async function searchPropertiesInBounds({ north, south, east, west, limit = 200 }) {
  const lat = (north + south) / 2;
  const lng = (east + west) / 2;
  // Estimate radius from bounds (rough: 1 degree ≈ 69 miles)
  const latSpan = Math.abs(north - south) * 69;
  const lngSpan = Math.abs(east - west) * 69 * Math.cos(lat * Math.PI / 180);
  const radius = Math.max(latSpan, lngSpan) / 2;

  const data = await cachedApiRequest('search/bycoordinates', {
    latitude: lat, longitude: lng, radius: Math.min(radius, 20), page: 1
  }, 'search');

  if (!data || !data.searchResults) return [];
  return data.searchResults
    .filter(r => r.property)
    .slice(0, limit)
    .map(r => normalizeSearchResult(r.property));
}

// ============================================
// PROPERTY DETAIL FUNCTIONS
// ============================================

/**
 * Get full property detail by zpid using custom_ad/byzpid endpoint.
 * Returns ALL MLS listing photos, real Zestimate, beds/baths/sqft/yearBuilt,
 * features, description, price history, and schools.
 */
export async function getPropertyDetail(zpid) {
  zpid = Number(zpid);
  const cacheKey = `custom_ad_${zpid}`;
  const cached = getCached(cacheKey, 'propertyDetail');
  if (cached) return cached;

  const data = await apiRequest('custom_ad/byzpid', { zpid });
  if (!data || data.message?.includes('404') || !data.propertyDetails) {
    console.warn(`[ZillowAPI] custom_ad/byzpid returned no data for zpid ${zpid}`);
    return null;
  }

  setCache(cacheKey, data, 'propertyDetail');
  return data;
}

/**
 * Get full property detail by zpid (or address string)
 * Replaces: getMLSPropertyWithImages, getMLSPropertyByKey, getMLSPropertyFullDetail
 * 
 * Uses custom_ad/byzpid endpoint which returns:
 * - All original MLS listing photos (originalPhotos[])
 * - Real Zestimate and Rent Zestimate
 * - Bedrooms, bathrooms, livingArea, yearBuilt
 * - Full features (heating, cooling, flooring, construction, etc.)
 * - Description, schools, price history
 */
export async function getMLSPropertyWithImages(zpidOrAddress) {
  let zpid = zpidOrAddress;
  let resolved = null;

  // If it looks like an address string instead of a zpid number
  if (typeof zpidOrAddress === 'string' && isNaN(zpidOrAddress)) {
    resolved = await resolveAddress(zpidOrAddress);
    if (!resolved) return null;
    zpid = resolved.zpid;
  } else {
    zpid = Number(zpid);
  }

  // Primary: use custom_ad/byzpid for full property detail + photos
  const detail = await getPropertyDetail(zpid);
  const pd = detail?.propertyDetails || {};
  const features = pd.features || {};

  // Extract all original listing photos
  const originalPhotos = pd.originalPhotos || [];
  const images = originalPhotos.map((photo, idx) => {
    // Get the highest-resolution JPEG
    const jpegs = photo?.mixedSources?.jpeg || [];
    const bestJpeg = jpegs[jpegs.length - 1]; // last = highest res
    return {
      MEDIAURL: bestJpeg?.url || '',
      MEDIACATEGORY: 'Photo',
      order: idx,
      caption: photo.caption || '',
      isComp: false,
      width: bestJpeg?.width || null,
      // Also keep all resolutions available
      allResolutions: jpegs.map(j => ({ url: j.url, width: j.width })),
    };
  }).filter(img => img.MEDIAURL);

  // Get price history for sale/listing events
  const history = pd.priceHistory || await getPriceHistory(zpid) || [];

  const latestListing = history?.find(h => h.event === 'Listed for sale');
  const latestSale = history?.find(h => h.event === 'Sold');

  // Get comparable homes for area context
  let comps = [];
  try {
    comps = await getComparableHomes(zpid);
  } catch (e) { /* optional, don't block */ }

  // Parse address from resolved or from custom_ad response
  if (!resolved) {
    const addrStr = pd.address_str || '';
    const parts = addrStr.split(',').map(s => s.trim());
    resolved = {
      zpid,
      streetNumber: '',
      streetName: parts[0] || '',
      city: parts[1] || '',
      state: (parts[2] || '').replace(/\s+\d{5}.*/, '').trim(),
      zipCode: (parts[2] || '').match(/\d{5}/)?.[0] || '',
      lat: null,
      lng: null,
      display: addrStr,
    };
  }

  return {
    ZPID: zpid,
    LISTINGKEY: String(zpid),
    LISTPRICE: pd.price || latestListing?.price || null,
    CLOSEPRICE: latestSale?.price || null,
    PROPERTYTYPE: pd.homeType || 'Residential',
    PROPERTYSUBTYPE: features.propertySubType?.[0] || null,
    STANDARDSTATUS: latestListing ? 'Active' : (latestSale ? 'Closed' : null),
    STREETNUMBER: resolved.streetNumber,
    STREETNAME: resolved.streetName,
    CITY: resolved.city,
    STATEORPROVINCE: resolved.state,
    POSTALCODE: resolved.zipCode,
    LATITUDE: resolved.lat,
    LONGITUDE: resolved.lng,
    BEDROOMSTOTAL: pd.bedrooms || features.bedrooms || null,
    BATHROOMSTOTALINTEGER: pd.bathrooms || features.bathrooms || null,
    LIVINGAREA: pd.livingArea || null,
    LOTSIZEAREA: pd.lotSize || null,
    YEARBUILT: pd.yearBuilt || features.yearBuilt || null,
    PRICEPERSQUAREFOOT: pd.pricePerSquareFoot || null,
    ZESTIMATE: pd.zestimate || null,
    RENTZESTIMATE: pd.rentZestimate || null,
    MONTHLYHOAFEE: pd.monthlyHoaFee || null,
    PUBLICREMARKS: pd.description || '',
    features: {
      heating: features.heating || [],
      cooling: features.cooling || [],
      appliances: features.appliances || [],
      flooring: features.flooring || [],
      interiorFeatures: features.interiorFeatures || [],
      exteriorFeatures: features.exteriorFeatures || [],
      construction: features.constructionMaterials || [],
      foundation: features.foundationDetails || [],
      roof: features.roofType || null,
      parking: features.parkingFeatures || [],
      parkingCapacity: features.parkingCapacity || null,
      levels: features.levels || null,
      stories: features.stories || null,
      fireplace: features.hasFireplace || false,
      sewer: features.sewer || [],
      waterSource: features.waterSource || [],
      utilities: features.utilities || [],
      listingTerms: features.listingTerms || null,
      zoning: features.zoning || null,
      subdivision: features.subdivisionName || null,
    },
    images,
    primaryImage: images[0]?.MEDIAURL || null,
    priceHistory: history,
    comparables: comps,
    schools: pd.schools || detail?.schools || [],
    address_str: resolved.display || pd.address_str || '',
    zillowURL: detail?.zillowURL || `https://www.zillow.com/homedetails/${zpid}_zpid/`,
  };
}

/**
 * Get property by address
 * Replaces: getPropertyByAddress
 * 
 * Uses autocomplete→zpid, then pricehistory for price data.
 */
export async function getPropertyByAddress(address, city, state) {
  const fullAddress = [address, city, state].filter(Boolean).join(', ');
  
  // Step 1: Resolve address → zpid
  const resolved = await resolveAddress(fullAddress);
  if (!resolved) {
    console.warn(`[ZillowAPI] Could not resolve address: ${fullAddress}`);
    return null;
  }

  // Step 2: Delegate to getMLSPropertyWithImages which assembles from pricehistory + comps
  // Pass the resolved zpid to avoid a duplicate autocomplete call
  const detail = await getMLSPropertyWithImages(resolved.zpid);
  if (!detail) return null;

  // Overlay the resolved address info (more accurate than what pricehistory gives)
  detail.STREETNUMBER = resolved.streetNumber;
  detail.STREETNAME = resolved.streetName;
  detail.CITY = resolved.city;
  detail.STATEORPROVINCE = resolved.state;
  detail.POSTALCODE = resolved.zipCode;
  detail.LATITUDE = resolved.lat;
  detail.LONGITUDE = resolved.lng;
  detail.address_str = resolved.display || fullAddress;

  return detail;
}

/**
 * Get property photos — returns ALL original MLS listing photos
 * Uses custom_ad/byzpid which provides originalPhotos[] with multiple resolutions
 */
export async function getPropertyMedia(zpid) {
  zpid = Number(zpid);
  
  // Use custom_ad/byzpid for actual listing photos
  const detail = await getPropertyDetail(zpid);
  const pd = detail?.propertyDetails || {};
  const originalPhotos = pd.originalPhotos || [];

  const photos = originalPhotos.map((photo, idx) => {
    const jpegs = photo?.mixedSources?.jpeg || [];
    const bestJpeg = jpegs[jpegs.length - 1]; // highest resolution
    return {
      MEDIAURL: bestJpeg?.url || '',
      MEDIACATEGORY: 'Photo',
      order: idx,
      caption: photo.caption || '',
      isComp: false,
      width: bestJpeg?.width || null,
    };
  }).filter(img => img.MEDIAURL);

  // If custom_ad returned no photos, fall back to comps as area reference
  if (photos.length === 0) {
    let comps = [];
    try {
      comps = await getComparableHomes(zpid);
    } catch (e) { /* graceful */ }
    if (comps.length === 0) {
      try { comps = await getSimilarProperties(zpid); } catch (e) {}
    }
    for (const comp of comps) {
      const cardPhotos = comp.miniCardPhotos || comp.photos || [];
      for (const p of cardPhotos) {
        const url = typeof p === 'string' ? p : p.url;
        if (url) {
          photos.push({
            MEDIAURL: url,
            MEDIACATEGORY: 'Photo',
            order: photos.length,
            caption: `Area comp: ${comp.address?.streetAddress || ''}`,
            isComp: true,
          });
        }
      }
    }
  }

  return photos;
}

/**
 * Get photos for multiple properties by zpid
 * Replaces: getPhotosForListings([beforeKey, afterKey])
 * Note: In Zillow API, we use zpids instead of listing keys
 */
export async function getPhotosForListings(zpids) {
  const result = {};
  
  // Fetch in parallel with concurrency limit
  const CONCURRENCY = 3;
  for (let i = 0; i < zpids.length; i += CONCURRENCY) {
    const batch = zpids.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (zpid) => {
      try {
        const photos = await getPropertyMedia(zpid);
        result[zpid] = photos.map(p => ({
          url: p.MEDIAURL,
          order: p.order,
          isPrimary: p.order === 0,
          description: p.caption,
        }));
      } catch (e) {
        console.warn(`[ZillowAPI] Failed to get photos for zpid ${zpid}:`, e.message);
        result[zpid] = [];
      }
    });
    await Promise.all(promises);
  }
  
  return result;
}

// ============================================
// PRICE HISTORY
// ============================================

/**
 * Get full price history for a property
 * Replaces: getPropertyPriceTimeline, getPropertyBusinessHistory
 */
export async function getPriceHistory(zpid) {
  const data = await cachedApiRequest('pricehistory', { byzpid: zpid }, 'priceHistory');
  if (!data || !data.priceHistory) return [];
  return data.priceHistory;
}

/**
 * Get price history for a property by address
 */
export async function getPriceHistoryByAddress(address) {
  const data = await cachedApiRequest('pricehistory', { byaddress: address }, 'priceHistory');
  if (!data || !data.priceHistory) return [];
  return data.priceHistory;
}

// ============================================
// COMPARABLE & SIMILAR PROPERTIES
// ============================================

/**
 * Get comparable homes (sold comps)
 * Replaces: getComparableMarketStats (partially)
 */
export async function getComparableHomes(zpid) {
  const data = await cachedApiRequest('comparable_homes', { byzpid: zpid }, 'comparables');
  if (!data || !data.comparable_homes) return [];
  return data.comparable_homes.map(c => c.property || c);
}

/**
 * Get similar properties
 */
export async function getSimilarProperties(zpid) {
  const data = await cachedApiRequest('similar', { byzpid: zpid }, 'comparables');
  if (!data || !data.similar_properties) return [];
  const details = data.similar_properties.propertyDetails || data.similar_properties;
  return Array.isArray(details) ? details : [];
}

/**
 * Get nearby properties
 */
export async function getNearbyProperties(zpid) {
  const data = await cachedApiRequest('nearby', { byzpid: zpid }, 'comparables');
  if (!data || !data.nearby_properties) return [];
  return data.nearby_properties;
}

// ============================================
// MARKET DATA
// ============================================

/**
 * Get housing market data (ZHVI time series) for a ZIP/city
 * Replaces: getMarketAppreciation  
 */
export async function getHousingMarket(searchQuery) {
  const data = await cachedApiRequest('housing_market', { search_query: searchQuery }, 'marketData');
  return data;
}

/**
 * Get rental market data for a ZIP/city
 */
export async function getRentalMarket(searchQuery) {
  const data = await cachedApiRequest('rental_market', { search_query: searchQuery }, 'marketData');
  return data;
}

// ============================================
// CLIMATE & WALKABILITY
// ============================================

export async function getClimateData(zpid) {
  return cachedApiRequest('climate', { byzpid: zpid }, 'propertyDetail');
}

export async function getWalkTransitBike(zpid) {
  return cachedApiRequest('walk_transit_bike', { byzpid: zpid }, 'propertyDetail');
}

// ============================================
// OFF-MARKET PROPERTIES
// ============================================

export async function searchOffMarket(zipCode) {
  const data = await apiRequest('search/offmarket', { zipCode });
  return data?.offMarketResults || [];
}

// ============================================
// RENOVATION PAIR DETECTION
// ============================================
// Uses nearby + similar + off-market properties to discover zpids in an area,
// then checks price history for repeat-sale pairs indicating renovation.

/**
 * Discover zpids in a ZIP code area using multiple strategies:
 * 1. Resolve ZIP → seed zpid via autocomplete
 * 2. Get off-market properties (largest pool — most renovated homes are off-market)
 * 3. Use seed (or best off-market SFH) for nearby + similar chaining
 * 4. Filter to same-metro ZIP prefix and residential types
 */
async function discoverZpidsInArea(zip) {
  // Early exit if quota is already exhausted — don't waste calls
  if (isQuotaExceeded()) {
    console.warn(`[ZillowAPI] discoverZpidsInArea('${zip}'): skipping — quota exceeded`);
    return [];
  }

  const seen = new Map(); // zpid → property info
  const RESIDENTIAL_TYPES = new Set([
    'SingleFamily', 'SINGLE_FAMILY', 'townhome', 'TOWNHOUSE', 'Townhouse',
    'condo', 'CONDO', 'Condo', 'Residential', 'RESIDENTIAL',
    'MultiFamily', 'MULTI_FAMILY', 'Duplex', 'Triplex', 'Quadruplex',
    'ManufacturedHome', 'MANUFACTURED',
  ]);

  // Strategy 1: resolve ZIP to a seed address via autocomplete
  const resolved = await resolveAddress(zip);
  let seedZpid = resolved?.zpid || null;

  if (!seedZpid) {
    console.warn(`[ZillowAPI] autocomplete('${zip}') returned no zpid (likely a Region result)`);
  }

  // Helpers to add properties from nearby/similar/offmarket responses
  function addFromNearby(props) {
    for (const p of (props || [])) {
      const zpid = p.zpid || p.property?.zpid;
      if (zpid && !seen.has(zpid)) {
        seen.set(zpid, {
          zpid,
          address: p.address || p.property?.address || { streetAddress: '', city: '', state: '', zipcode: zip },
          beds: p.bedrooms || p.property?.bedrooms || null,
          baths: p.bathrooms || p.property?.bathrooms || null,
          sqft: p.livingArea || p.property?.livingArea || null,
          yearBuilt: p.yearBuilt || p.property?.yearBuilt || null,
          propertyType: p.homeType || p.property?.homeType || 'SingleFamily',
        });
      }
    }
  }

  function addFromSimilar(props) {
    for (const p of (props || [])) {
      const zpid = p.zpid;
      if (zpid && !seen.has(zpid)) {
        seen.set(zpid, {
          zpid,
          address: p.address || { streetAddress: p.streetAddress || '', city: p.city || '', state: p.state || '', zipcode: p.zipcode || zip },
          beds: p.bedrooms || null,
          baths: p.bathrooms || null,
          sqft: p.livingArea || null,
          yearBuilt: p.yearBuilt || null,
          propertyType: p.homeType || 'SingleFamily',
        });
      }
    }
  }

  // ── Strategy 2: off-market (run FIRST — largest pool + provides seed zpids) ──
  // Off-market data has: address.streetAddress, address.city, address.state, address.zipcode
  // (NOT p.streetAddress or p.location.state)
  const offMarketSFH = [];  // Collect SFH zpids to use as seeds
  try {
    const offMarket = await searchOffMarket(zip);
    for (const p of (offMarket || []).slice(0, 400)) {
      if (!p.zpid || seen.has(p.zpid)) continue;
      const addr = p.address || {};
      const propType = p.propertyType || p.homeType || 'apartment';
      const entry = {
        zpid: p.zpid,
        address: {
          streetAddress: addr.streetAddress || p.streetAddress || '',
          city: addr.city || p.location?.city || '',
          state: addr.state || p.location?.state || '',
          zipcode: addr.zipcode || p.location?.zipcode || zip,
        },
        beds: p.bedrooms || null,
        baths: p.bathrooms || null,
        sqft: p.livingArea || null,
        yearBuilt: p.yearBuilt || null,
        propertyType: propType,
      };
      seen.set(p.zpid, entry);
      // Track residential properties as potential seeds for nearby/similar
      if (RESIDENTIAL_TYPES.has(propType) || propType === 'SINGLE_FAMILY' || propType === 'townhome') {
        offMarketSFH.push(entry);
      }
    }
    console.log(`[ZillowAPI] Off-market for ${zip}: ${seen.size} total, ${offMarketSFH.length} residential (potential seeds)`);
  } catch (e) {
    console.warn(`[ZillowAPI] Off-market search failed for ZIP ${zip}:`, e.message);
  }

  // ── Strategy 3: nearby + similar from best seed ──
  // If autocomplete gave no zpid, use the first off-market SFH as seed
  if (!seedZpid && offMarketSFH.length > 0) {
    seedZpid = offMarketSFH[0].zpid;
    console.log(`[ZillowAPI] Using off-market SFH zpid ${seedZpid} as seed for nearby/similar`);
  }

  if (seedZpid) {
    try {
      const [nearbyData, similarData] = await Promise.all([
        getNearbyProperties(seedZpid),
        getSimilarProperties(seedZpid),
      ]);
      addFromNearby(nearbyData);
      addFromSimilar(similarData);
    } catch (e) {
      console.warn(`[ZillowAPI] Failed to get nearby/similar for seed ${seedZpid}:`, e.message);
    }

    // ── Strategy 4: chain — use more SFH seeds for wider coverage ──
    // Pick up to 15 additional seeds: 6 from offmarket SFH + rest from nearby/similar results
    const additionalSeeds = [];
    // Add offmarket SFH seeds (diverse locations within ZIP)
    for (const s of offMarketSFH.slice(1, 7)) {
      if (s.zpid !== seedZpid) additionalSeeds.push(s.zpid);
    }
    // Add nearby/similar results as seeds too
    for (const [zpid, prop] of seen) {
      if (additionalSeeds.length >= 15) break;
      if (zpid === seedZpid || additionalSeeds.includes(zpid)) continue;
      if (RESIDENTIAL_TYPES.has(prop.propertyType)) additionalSeeds.push(zpid);
    }

    for (const chainZpid of additionalSeeds) {
      try {
        const [nearbyData, similarData] = await Promise.all([
          getNearbyProperties(chainZpid),
          getSimilarProperties(chainZpid),
        ]);
        addFromNearby(nearbyData);
        addFromSimilar(similarData);
      } catch (e) { /* non-critical */ }
    }
  }

  // ── Strategy 5: comparable_homes from top seeds — different pool than nearby/similar ──
  const compSeeds = [...seen.keys()].filter(z => z !== seedZpid).slice(0, 6);
  for (const compSeedZpid of compSeeds) {
    if (isQuotaExceeded()) break;
    try {
      const comps = await getComparableHomes(compSeedZpid);
      addFromNearby(comps); // same shape — zpid, address, bedrooms, etc.
    } catch (e) { /* non-critical */ }
  }

  // ── Strategy 6: coordinate-based search — catches active listings in ZIP radius ──
  try {
    const coords = await getZipCoordinates(zip);
    if (coords && !isQuotaExceeded()) {
      // Search at 10-mile radius with pagination (pages 1-2) for wider coverage
      let totalCoordAdded = 0;
      for (let page = 1; page <= 2; page++) {
        if (isQuotaExceeded()) break;
        const coordData = await apiRequest('search/bycoordinates', {
          latitude: coords.lat, longitude: coords.lng, radius: 10, page
        });
        const coordResults = coordData?.searchResults || [];
        if (coordResults.length === 0) break; // no more pages
        for (const r of coordResults) {
          const p = r.property || r;
          if (!p.zpid || seen.has(p.zpid)) continue;
          seen.set(p.zpid, {
            zpid: p.zpid,
            address: p.address || { streetAddress: '', city: '', state: '', zipcode: zip },
            beds: p.bedrooms || null,
            baths: p.bathrooms || null,
            sqft: p.livingArea || null,
            yearBuilt: p.yearBuilt || null,
            propertyType: p.homeType || 'SingleFamily',
          });
          totalCoordAdded++;
        }
      }
      console.log(`[ZillowAPI] Coordinate search added ${totalCoordAdded} results, total now ${seen.size}`);
    }
  } catch (e) {
    console.warn(`[ZillowAPI] Coordinate search failed for ${zip}:`, e.message);
  }

  // ── Filter: same-metro ZIP prefix + residential property types ──
  const zipPrefix = zip.slice(0, 3);
  const filtered = [...seen.values()].filter(p => {
    const pZip = p.address?.zipcode || '';
    if (pZip && !pZip.startsWith(zipPrefix)) return false;
    // Exclude non-residential property types (land, commercial, etc.)
    const pType = p.propertyType || '';
    if (pType && !RESIDENTIAL_TYPES.has(pType)) return false;
    // Exclude properties with unreasonable sqft (likely bad data or commercial)
    if (p.sqft && (p.sqft < 400 || p.sqft > 8000)) return false;
    return true;
  });

  const removed = seen.size - filtered.length;
  if (removed > 0) {
    console.log(`[ZillowAPI] Filtered out ${removed}/${seen.size} properties (ZIP prefix, property type, or sqft bounds)`);
  }
  console.log(`[ZillowAPI] discoverZpidsInArea('${zip}'): ${filtered.length} properties in area`);

  return filtered;
}

/**
 * Detect renovation pairs from a list of property zpids by checking price history.
 * Reusable by both findRenovationPairs and findRentalRenovationPairs.
 */
async function detectSalePairs(properties, limit) {
  const pairs = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < properties.length && pairs.length < limit * 5; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);
    
    const batchResults = await Promise.all(
      batch.map(async (prop) => {
        try {
          const history = await getPriceHistory(prop.zpid);
          return { prop, history };
        } catch (e) {
          return { prop, history: [] };
        }
      })
    );

    for (const { prop, history } of batchResults) {
      if (!history || history.length < 2) continue;

      const soldEvents = history
        .filter(h => h.event === 'Sold' && h.price > 50000)
        .sort((a, b) => a.time - b.time);

      if (soldEvents.length < 2) continue;

      for (let s = 0; s < soldEvents.length - 1; s++) {
        const before = soldEvents[s];
        const after = soldEvents[s + 1];
        
        const daysBetween = (after.time - before.time) / (1000 * 60 * 60 * 24);
        const priceIncreasePct = ((after.price - before.price) / before.price) * 100;
        const priceIncreaseAmt = after.price - before.price;
        
        // Hard filters: reasonable residential renovation scenario
        // - 60–2555 days (2 months to 7 years) between sales
        // - After-sale must be within last 10 years (ensures ZHVI coverage
        //   and relevant market conditions)
        // - 5–300% price increase (>300% is almost always bad data or lot split)
        // - Both prices between $50K and $3M (expanded for cheap/luxury markets)
        const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;
        const afterSaleRecent = (Date.now() - after.time) <= TEN_YEARS_MS;
        if (daysBetween >= 60 && daysBetween <= 2555 &&
            afterSaleRecent &&
            priceIncreasePct >= 5 && priceIncreasePct <= 300 &&
            before.price >= 50000 && before.price <= 3000000 &&
            after.price >= 50000 && after.price <= 3000000) {
          
          const beforeListings = history.filter(h => 
            h.event === 'Listed for sale' && 
            Math.abs(h.time - before.time) < 180 * 24 * 60 * 60 * 1000
          );
          const afterListings = history.filter(h => 
            h.event === 'Listed for sale' && 
            Math.abs(h.time - after.time) < 180 * 24 * 60 * 60 * 1000
          );

          const addr = prop.address || {};
          pairs.push({
            ZPID: prop.zpid,
            ADDRESS: `${addr.streetAddress || ''}, ${addr.city || ''}, ${addr.state || ''} ${addr.zipcode || ''}`.trim(),
            STREETNUMBER: extractStreetNumber(addr.streetAddress || ''),
            STREETNAME: extractStreetName(addr.streetAddress || ''),
            CITY: addr.city || '',
            STATE: addr.state || '',
            STATEORPROVINCE: addr.state || '',  // alias for processor compatibility
            POSTALCODE: addr.zipcode || '',
            BEFORE_LISTINGKEY: `${prop.zpid}_before_${before.time}`,
            AFTER_LISTINGKEY: `${prop.zpid}_after_${after.time}`,
            BEFORE_ZPID: prop.zpid,
            AFTER_ZPID: prop.zpid,
            BEFORE_PRICE: before.price,
            AFTER_PRICE: after.price,
            BEFORE_DATE: before.date,
            AFTER_DATE: after.date,
            BEFORE_PSF: before.pricePerSquareFoot || null,
            AFTER_PSF: after.pricePerSquareFoot || null,
            BEFORE_SQFT: prop.sqft || null,
            AFTER_SQFT: prop.sqft || null,
            BEFORE_BEDS: prop.beds,
            AFTER_BEDS: prop.beds,
            BEFORE_BATHS: prop.baths,
            AFTER_BATHS: prop.baths,
            BEFORE_YEARBUILT: prop.yearBuilt,
            AFTER_YEARBUILT: prop.yearBuilt,
            BEFORE_REMARKS: beforeListings[0]?.source || '',
            AFTER_REMARKS: afterListings[0]?.source || '',
            BEFORE_SOURCE: before.source || '',
            AFTER_SOURCE: after.source || '',
            PRICE_INCREASE_PCT: priceIncreasePct,
            PRICE_INCREASE_AMT: priceIncreaseAmt,
            DAYS_BETWEEN_SALES: Math.round(daysBetween),
            HOLDING_MONTHS: Math.round(daysBetween / 30.44),
            PROPERTY_TYPE: prop.propertyType || 'SingleFamily',
            PROPERTYTYPE: prop.propertyType || 'SingleFamily',  // alias for processor
            BEFORE_SALETOLIST: before.priceChangeRate != null ? (1 + before.priceChangeRate) : null,
            AFTER_SALETOLIST: after.priceChangeRate != null ? (1 + after.priceChangeRate) : null,
            BEFORE_BUYER_AGENT: before.buyerAgent?.name || null,
            BEFORE_SELLER_AGENT: before.sellerAgent?.name || null,
            AFTER_BUYER_AGENT: after.buyerAgent?.name || null,
            AFTER_SELLER_AGENT: after.sellerAgent?.name || null,
          });
        }
      }
    }
  }

  return pairs;
}

/**
 * Find renovation candidate pairs in a ZIP code
 * Replaces: snowflake.findRenovationPairs({ zip, limit })
 * 
 * Strategy: Use nearby+similar+offmarket to discover zpids → fetch price histories →
 * detect pairs where same property sold twice with 5-500% price increase.
 */
export async function findRenovationPairs({ zip, limit = 20 }) {
  console.log(`[ZillowAPI] Finding renovation pairs for ZIP ${zip}...`);
  
  // Step 1: Discover properties in this area
  const allProperties = await discoverZpidsInArea(zip);
  console.log(`[ZillowAPI] Discovered ${allProperties.length} properties in ZIP ${zip}`);

  // Step 2: Check price histories for renovation pairs
  const pairs = await detectSalePairs(allProperties, limit);

  // Sort by price increase % descending (best renovation candidates first)
  pairs.sort((a, b) => b.PRICE_INCREASE_PCT - a.PRICE_INCREASE_PCT);

  console.log(`[ZillowAPI] Found ${pairs.length} renovation pairs for ZIP ${zip}`);
  return pairs.slice(0, limit);
}

/**
 * Find rental renovation pairs — detect rent increases at same property
 * Replaces: snowflake.findRentalRenovationPairs({ zip, limit })
 * 
 * Strategy: Discover zpids via nearby+similar+offmarket, check price history
 * for rental listing events with significant rent increases.
 */
export async function findRentalRenovationPairs({ zip, limit = 50 }) {
  console.log(`[ZillowAPI] Finding rental renovation pairs for ZIP ${zip}...`);
  
  // Discover properties using the multi-strategy approach
  const allProperties = await discoverZpidsInArea(zip);

  const rentalPairs = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < allProperties.length && rentalPairs.length < limit; i += BATCH_SIZE) {
    const batch = allProperties.slice(i, i + BATCH_SIZE);
    
    const batchResults = await Promise.all(
      batch.map(async (prop) => {
        try {
          const history = await getPriceHistory(prop.zpid);
          return { prop, history };
        } catch (e) {
          return { prop, history: [] };
        }
      })
    );

    for (const { prop, history } of batchResults) {
      if (!history || history.length < 2) continue;

      const rentalEvents = history
        .filter(h => h.postingIsRental && h.price > 300 && h.price < 20000)
        .sort((a, b) => a.time - b.time);

      if (rentalEvents.length < 2) continue;

      for (let r = 0; r < rentalEvents.length - 1; r++) {
        const before = rentalEvents[r];
        const after = rentalEvents[r + 1];
        
        const daysBetween = (after.time - before.time) / (1000 * 60 * 60 * 24);
        const rentChangePct = ((after.price - before.price) / before.price) * 100;

        if (daysBetween >= 60 && daysBetween <= 1825 &&
            rentChangePct >= -20 && rentChangePct <= 200) {
          const addr = prop.address || {};
          rentalPairs.push({
            ZPID: prop.zpid,
            ADDRESS: `${addr.streetAddress || ''}, ${addr.city || ''}, ${addr.state || ''}`,
            POSTALCODE: addr.zipcode || '',
            BEFORE_LISTINGKEY: `${prop.zpid}_rental_before_${before.time}`,
            AFTER_LISTINGKEY: `${prop.zpid}_rental_after_${after.time}`,
            BEFORE_RENT: before.price,
            AFTER_RENT: after.price,
            RENT_INCREASE_PCT: rentChangePct,
            RENT_INCREASE_AMT: after.price - before.price,
            DAYS_BETWEEN_LISTINGS: Math.round(daysBetween),
            BEFORE_DATE: before.date,
            AFTER_DATE: after.date,
            BEFORE_BEDS: prop.beds,
            AFTER_BEDS: prop.beds,
            BEFORE_BATHS: prop.baths,
            AFTER_BATHS: prop.baths,
            PROPERTY_TYPE: prop.propertyType,
          });
        }
      }
    }
  }

  console.log(`[ZillowAPI] Found ${rentalPairs.length} rental pairs for ZIP ${zip}`);
  return rentalPairs.slice(0, limit);
}

// ============================================
// MARKET APPRECIATION (Replaces Snowflake getMarketAppreciation)
// ============================================

/**
 * Get market appreciation data for a ZIP code
 * Replaces: snowflake.getMarketAppreciation({ zip, state, propertyType })
 * Uses Zillow ZHVI time series from housing_market endpoint
 * 
 * Returns data in the same format as Snowflake: array of yearly stats
 */
export async function getMarketAppreciation({ zip, state, city, propertyType }) {
  // housing_market needs "City, ST" format — ZIP alone often fails
  let searchQuery = city ? `${city}, ${state || ''}`.trim() : null;
  if (!searchQuery && zip) {
    searchQuery = await zipToCityState(zip);
  }
  if (!searchQuery) searchQuery = state || '';
  if (!searchQuery) return [];
  
  const data = await getHousingMarket(searchQuery);
  if (!data || !data.market_analytics || !data.market_analytics.zhviRange) return [];

  const zhvi = data.market_analytics.zhviRange;
  
  // Group ZHVI by year and compute yearly stats
  const yearlyData = {};
  for (const point of zhvi) {
    const date = new Date(point.timePeriodEnd);
    const year = date.getFullYear();
    if (!yearlyData[year]) yearlyData[year] = [];
    yearlyData[year].push(point.dataValue);
  }

  const result = Object.entries(yearlyData)
    .map(([year, values]) => {
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const sorted = [...values].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return {
        YEAR: parseInt(year),
        SALES_COUNT: null, // Not available from ZHVI
        AVG_CLOSE_PRICE: Math.round(avg),
        MEDIAN_CLOSE_PRICE: Math.round(median),
        AVG_PRICE_PER_SQFT: null, // Not directly available at market level
        AVG_DOM: null,
        AVG_SALE_TO_LIST_PCT: null,
        // Additional Zillow data
        ZHVI_VALUES: values,
      };
    })
    .sort((a, b) => a.YEAR - b.YEAR);

  return result;
}

// ============================================
// COMPARABLE MARKET STATS (Replaces Snowflake getComparableMarketStats)
// ============================================

/**
 * Get comparable market statistics
 * Replaces: snowflake.getComparableMarketStats({ zip, state, propertyType, beds, baths, sqft, yearBuilt, saleYear })
 * 
 * Uses comparable_homes endpoint on a reference property + housing market data
 */
export async function getComparableMarketStats({ zip, state, propertyType, beds, baths, sqft, yearBuilt, saleYear }) {
  // Strategy: Search for properties in the ZIP, find one similar to our criteria,
  // then get its comps. Also use housing_market for broader stats.
  
  const searchData = await cachedApiRequest('search/byaddress', {
    address: zip,
    page: 1,
    ...(beds ? { minBeds: beds, maxBeds: beds + 1 } : {}),
    ...(baths ? { minBaths: baths } : {}),
  }, 'search');

  // Find a reference property close to our criteria
  let referenceZpid = null;
  let compProperties = [];
  
  if (searchData?.searchResults) {
    const candidates = searchData.searchResults
      .map(r => r.property)
      .filter(p => p && p.zpid);

    // Score each candidate by similarity
    const scored = candidates.map(p => {
      let score = 0;
      if (beds && p.bedrooms === beds) score += 3;
      if (beds && Math.abs((p.bedrooms || 0) - beds) <= 1) score += 1;
      if (baths && Math.abs((p.bathrooms || 0) - baths) <= 1) score += 1;
      if (sqft && p.livingArea && Math.abs(p.livingArea - sqft) / sqft < 0.3) score += 2;
      if (yearBuilt && p.yearBuilt && Math.abs(p.yearBuilt - yearBuilt) <= 15) score += 1;
      return { ...p, score };
    }).sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      referenceZpid = scored[0].zpid;
    }
  }

  // Get comparable homes for the reference property
  if (referenceZpid) {
    try {
      const comps = await getComparableHomes(referenceZpid);
      compProperties = comps;
    } catch (e) {
      console.warn(`[ZillowAPI] Failed to get comps for reference zpid ${referenceZpid}:`, e.message);
    }
  }

  // Calculate stats from comps
  if (compProperties.length === 0) {
    // Fallback: use market-level data (convert ZIP to city name)
    const cityQuery = zip ? await zipToCityState(zip) : zip;
    const marketData = await getHousingMarket(cityQuery);
    if (marketData?.market_overview) {
      return {
        medianPSF: null,
        avgPSF: null,
        medianPrice: marketData.market_overview.median_sale_price || marketData.market_overview.typical_home_values,
        avgPrice: marketData.market_overview.typical_home_values,
        avgDOM: null,
        avgSaleToListPct: null,
        sampleSize: 0,
        filters: { zip, beds, baths, sqft, yearBuilt, saleYear },
        source: 'zillow_market_overview',
      };
    }
    return null;
  }

  // Calculate PSF stats from comps
  const pricesPerSqft = compProperties
    .filter(c => c.price && c.livingAreaValue)
    .map(c => {
      const price = typeof c.price === 'object' ? c.price.value : c.price;
      return price / c.livingAreaValue;
    })
    .filter(v => v > 0 && isFinite(v));

  const prices = compProperties
    .map(c => typeof c.price === 'object' ? c.price?.value : c.price)
    .filter(v => v > 0);

  const medianPSF = pricesPerSqft.length > 0 
    ? pricesPerSqft.sort((a, b) => a - b)[Math.floor(pricesPerSqft.length / 2)]
    : null;
  const avgPSF = pricesPerSqft.length > 0
    ? pricesPerSqft.reduce((s, v) => s + v, 0) / pricesPerSqft.length
    : null;
  const medianPrice = prices.length > 0
    ? prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)]
    : null;
  const avgPrice = prices.length > 0
    ? prices.reduce((s, v) => s + v, 0) / prices.length
    : null;

  return {
    medianPSF: medianPSF ? Math.round(medianPSF) : null,
    avgPSF: avgPSF ? Math.round(avgPSF) : null,
    medianPrice: medianPrice ? Math.round(medianPrice) : null,
    avgPrice: avgPrice ? Math.round(avgPrice) : null,
    avgDOM: null, // Not directly available from comps
    avgSaleToListPct: null,
    sampleSize: compProperties.length,
    filters: { zip, beds, baths, sqft, yearBuilt, saleYear },
    source: 'zillow_comparable_homes',
  };
}

// ============================================
// LOCAL CAP RATE (Replaces Snowflake getLocalCapRate)
// ============================================

/**
 * Estimate local cap rate from Zillow market data
 * Replaces: snowflake.getLocalCapRate({ zip })
 * 
 * Uses: housing_market (ZHVI) + rental_market (median rent) to derive cap rate
 * Cap rate = (Annual Rent) / Home Value
 */
export async function getLocalCapRate({ zip, since }) {
  // housing_market needs "City, ST" — convert ZIP to city name
  const cityQuery = zip ? await zipToCityState(zip) : zip;
  
  const [housingData, rentalData] = await Promise.all([
    getHousingMarket(cityQuery),
    getRentalMarket(zip), // rental_market works fine with ZIP
  ]);

  if (!housingData?.market_overview || !rentalData?.rental_market_trends?.summary) {
    return null;
  }

  const homeValue = housingData.market_overview.typical_home_values;
  const medianRent = rentalData.rental_market_trends.summary.medianRent;

  if (!homeValue || !medianRent || homeValue <= 0) return null;

  const annualRent = medianRent * 12;
  const overallCapRate = annualRent / homeValue;

  // Try to get rent by bedroom count from the histogram
  const byBeds = {};
  // Rental market doesn't break down by bed count directly via this endpoint
  // but we can estimate from typical ratios
  // For now, return overall rate
  
  return {
    zipCode: zip,
    overall: overallCapRate,
    byBeds,
    sampleSizes: { 
      overall: { rentals: rentalData.rental_market_trends.summary.availableRentals || 0 }
    },
    computedAt: new Date().toISOString(),
    source: 'zillow_market_data',
    homeValue,
    medianRent,
  };
}

// ============================================
// RENOVATION AREA STATS
// ============================================

/**
 * Get area-level renovation statistics  
 * Replaces: snowflake.getRenovationAreaStats({ city, state, zipCode })
 */
export async function getRenovationAreaStats({ city, state, zipCode }) {
  const pairs = await findRenovationPairs({ zip: zipCode || city, limit: 50 });
  
  if (!pairs || pairs.length === 0) return null;

  const priceIncreases = pairs.map(p => p.PRICE_INCREASE_AMT);
  const pctIncreases = pairs.map(p => p.PRICE_INCREASE_PCT);
  const holdingMonths = pairs.map(p => p.HOLDING_MONTHS);

  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const median = arr => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return {
    TOTAL_RENOVATION_PAIRS: pairs.length,
    AVG_PRICE_INCREASE: Math.round(avg(priceIncreases)),
    AVG_PRICE_INCREASE_PCT: Math.round(avg(pctIncreases) * 10) / 10,
    MEDIAN_PRICE_INCREASE: Math.round(median(priceIncreases)),
    MEDIAN_PRICE_INCREASE_PCT: Math.round(median(pctIncreases) * 10) / 10,
    MIN_PRICE_INCREASE: Math.min(...priceIncreases),
    MAX_PRICE_INCREASE: Math.max(...priceIncreases),
    AVG_HOLDING_MONTHS: Math.round(avg(holdingMonths) * 10) / 10,
    ZIP_CODE: zipCode,
    CITY: city,
    STATE: state,
    source: 'zillow_price_history',
  };
}

// ============================================
// FIND SIMILAR RENOVATIONS
// ============================================

/**
 * Replaces: snowflake.findSimilarRenovations
 */
export async function findSimilarRenovations({ zipCode, minPriceIncreasePct, maxPriceIncreasePct, minSqft, maxSqft, propertyType, limit = 20 }) {
  const pairs = await findRenovationPairs({ zip: zipCode, limit: limit * 3 });
  
  return pairs.filter(p => {
    if (minPriceIncreasePct && p.PRICE_INCREASE_PCT < minPriceIncreasePct) return false;
    if (maxPriceIncreasePct && p.PRICE_INCREASE_PCT > maxPriceIncreasePct) return false;
    if (minSqft && p.BEFORE_SQFT && p.BEFORE_SQFT < minSqft) return false;
    if (maxSqft && p.BEFORE_SQFT && p.BEFORE_SQFT > maxSqft) return false;
    if (propertyType && p.PROPERTY_TYPE !== propertyType) return false;
    return true;
  }).slice(0, limit);
}

// ============================================
// RENOVATION CANDIDATE WITH PHOTOS
// ============================================

/**
 * Get a renovation candidate pair with full photo sets
 * Replaces: snowflake.getRenovationCandidateWithPhotos(beforeKey, afterKey)
 * 
 * Since Zillow uses zpid (same property), we just fetch the property details
 */
export async function getRenovationCandidateWithPhotos(zpid) {
  const [detail, history] = await Promise.all([
    getMLSPropertyWithImages(zpid),
    getPriceHistory(zpid),
  ]);

  if (!detail) return null;

  // Get sold events from history
  const soldEvents = (history || [])
    .filter(h => h.event === 'Sold' && h.price > 50000)
    .sort((a, b) => a.time - b.time);

  const photos = detail.images || [];

  return {
    address: detail.ADDRESS || detail.address_str,
    city: detail.CITY,
    state: detail.STATE,
    zpid: detail.ZPID || zpid,
    detail,
    // Current photos (most recent listing)
    photos: photos.map(p => ({
      url: typeof p === 'string' ? p : p.MEDIAURL || extractBestPhotoUrl(p),
      order: p.order || 0,
    })),
    priceHistory: soldEvents,
    metrics: soldEvents.length >= 2 ? {
      beforePrice: soldEvents[soldEvents.length - 2].price,
      afterPrice: soldEvents[soldEvents.length - 1].price,
      priceIncrease: soldEvents[soldEvents.length - 1].price - soldEvents[soldEvents.length - 2].price,
      priceIncreasePercent: ((soldEvents[soldEvents.length - 1].price - soldEvents[soldEvents.length - 2].price) / soldEvents[soldEvents.length - 2].price * 100).toFixed(1),
      holdingMonths: Math.round((soldEvents[soldEvents.length - 1].time - soldEvents[soldEvents.length - 2].time) / (1000 * 60 * 60 * 24 * 30.44)),
    } : null,
  };
}

// ============================================
// LISTING HISTORY (Address-based)
// ============================================

/**
 * Get listing history for an address
 * Replaces: snowflake.getAddressListingHistory
 */
export async function getAddressListingHistory({ streetNumber, streetName, city, state, postalCode }) {
  const address = `${streetNumber || ''} ${streetName || ''}, ${city || ''}, ${state || ''} ${postalCode || ''}`.trim();
  const history = await getPriceHistoryByAddress(address);
  return history.map((h, idx) => ({
    LISTINGKEY: `${address}_${h.time}`,
    EVENT: h.event,
    PRICE: h.price,
    DATE: h.date,
    SOURCE: h.source,
    PRICE_PER_SQFT: h.pricePerSquareFoot,
    POSTING_IS_RENTAL: h.postingIsRental,
    BUYER_AGENT: h.buyerAgent?.name,
    SELLER_AGENT: h.sellerAgent?.name,
    order: idx,
  }));
}

// ============================================
// STUB FUNCTIONS (Snowflake-specific, no direct Zillow equivalent)
// ============================================

export async function connect() {
  console.log('[ZillowAPI] Using Zillow RapidAPI — no persistent connection needed');
  return true;
}

export async function disconnect() {
  console.log('[ZillowAPI] Disconnected (cache cleared)');
  cache.clear();
}

export async function listTables() {
  // Return a mock list representing available Zillow data
  return [
    { name: 'properties', kind: 'search' },
    { name: 'property_details', kind: 'detail' },
    { name: 'price_history', kind: 'history' },
    { name: 'comparable_homes', kind: 'comps' },
    { name: 'housing_market', kind: 'market' },
    { name: 'rental_market', kind: 'market' },
  ];
}

export async function describeTable(tableName) {
  return [{ info: `Zillow API endpoint: ${tableName}`, source: 'zillow_rapidapi' }];
}

export async function executeQuery(sql) {
  console.warn('[ZillowAPI] executeQuery called with raw SQL — this is a Snowflake-specific function. Returning empty results.');
  console.warn('[ZillowAPI] SQL was:', sql?.substring(0, 200));
  return [];
}

// Additional aliases for backward compatibility
export const searchProperties = searchMLSPropertiesWithImages;
export const searchPropertiesByLocation = searchMLSPropertiesWithImages;
export const searchPropertiesByPrice = searchMLSPropertiesWithImages;
export const getPropertyById = getMLSPropertyWithImages;
export const getMLSPropertyByKey = getMLSPropertyWithImages;
export const getMLSPropertyFullDetail = getMLSPropertyWithImages;
export const getPropertyCount = async () => 0;
export const getPropertyOpenHouses = async () => [];
export const getPropertyRooms = async () => [];
export const getPropertyUnitTypes = async () => [];
export const getPropertyBusinessHistory = getPriceHistory;
export const getAvailableMarkets = async () => [];
export const getPropertySubtypes = async () => [];
export const getAvailableStates = async () => [];
export const getHistoricalListingImages = getPhotosForListings;
export const findRenovationCandidates = async (filters) => findRenovationPairs({ zip: filters.zipCode, limit: filters.limit });
export const getPropertyPriceTimeline = getPriceHistory;
export const getAddressPriceTimeline = async ({ streetNumber, streetName, city, state }) => {
  const address = `${streetNumber || ''} ${streetName || ''}, ${city || ''}, ${state || ''}`.trim();
  return getPriceHistoryByAddress(address);
};
export const searchHistoricalListings = searchMLSPropertiesWithImages;
export const searchMLSProperties = searchMLSPropertiesWithImages;
export const getMLSPropertyWithImagesAndHistory = getMLSPropertyWithImages;

// ============================================
// NORMALIZATION HELPERS
// ============================================

function normalizeSearchResult(prop) {
  const price = typeof prop.price === 'object' ? prop.price?.value : prop.price;
  const psf = typeof prop.price === 'object' ? prop.price?.pricePerSquareFoot : null;
  
  return {
    ZPID: prop.zpid,
    LISTINGKEY: String(prop.zpid), // Use zpid as listing key
    LISTPRICE: price || null,
    CLOSEPRICE: prop.hdpView?.listingStatus === 'sold' ? price : null,
    PROPERTYTYPE: mapPropertyTypeReverse(prop.propertyType),
    PROPERTYSUBTYPE: prop.propertyType,
    STANDARDSTATUS: prop.listing?.listingStatus || 'Active',
    STREETNUMBER: extractStreetNumber(prop.address?.streetAddress),
    STREETNAME: extractStreetName(prop.address?.streetAddress),
    CITY: prop.address?.city,
    STATEORPROVINCE: prop.address?.state,
    POSTALCODE: prop.address?.zipcode,
    LATITUDE: prop.location?.latitude,
    LONGITUDE: prop.location?.longitude,
    BEDROOMSTOTAL: prop.bedrooms,
    BATHROOMSTOTALINTEGER: prop.bathrooms,
    LIVINGAREA: prop.livingArea,
    LOTSIZEAREA: prop.lotSizeWithUnit?.lotSize || null,
    YEARBUILT: prop.yearBuilt,
    DAYSONMARKET: prop.daysOnZillow,
    PRICEPERSQUAREFOOT: psf,
    ZESTIMATE: prop.estimates?.zestimate,
    RENTZESTIMATE: prop.estimates?.rentZestimate,
    TAX_ASSESSED_VALUE: prop.taxAssessment?.taxAssessedValue,
    TAX_YEAR: prop.taxAssessment?.taxAssessmentYear,
    // Photo
    primaryImage: prop.media?.propertyPhotoLinks?.highResolutionLink || 
                  prop.media?.propertyPhotoLinks?.mediumSizeLink || null,
    images: (prop.media?.allPropertyPhotos?.medium || []).map((url, i) => ({
      MEDIAURL: url,
      order: i,
    })),
  };
}

function normalizePropertyDetail(pd, zillowURL) {
  const address = parseAddressString(pd.address_str);
  
  // Extract photo URLs
  const photos = (pd.originalPhotos || []).map((photo, idx) => ({
    MEDIAURL: extractBestPhotoUrl(photo),
    order: idx,
    caption: photo.caption || '',
  }));

  return {
    ZPID: pd.zpid,
    LISTINGKEY: String(pd.zpid),
    LISTPRICE: pd.price,
    CLOSEPRICE: null, // Would come from price history
    PROPERTYTYPE: mapPropertyTypeReverse(pd.homeType),
    PROPERTYSUBTYPE: pd.homeType,
    STANDARDSTATUS: null,
    STREETNUMBER: extractStreetNumber(address.streetAddress),
    STREETNAME: extractStreetName(address.streetAddress),
    CITY: address.city,
    STATEORPROVINCE: address.state,
    POSTALCODE: address.zipcode,
    BEDROOMSTOTAL: pd.bedrooms,
    BATHROOMSTOTALINTEGER: pd.bathrooms,
    LIVINGAREA: pd.livingArea,
    LOTSIZEAREA: pd.lotSize,
    YEARBUILT: pd.yearBuilt,
    PRICEPERSQUAREFOOT: pd.pricePerSquareFoot,
    ZESTIMATE: pd.zestimate,
    RENTZESTIMATE: pd.rentZestimate,
    MONTHLYHOAFEE: pd.monthlyHoaFee,
    PUBLICREMARKS: pd.description || '',
    // Features
    features: pd.features || {},
    // Photos
    images: photos,
    primaryImage: photos[0]?.MEDIAURL || null,
    // Price history (inline)
    priceHistory: pd.priceHistory || [],
    // Schools
    schools: pd.schools || [],
    // URL
    zillowURL: zillowURL || null,
    // Original address string
    address_str: pd.address_str,
  };
}

function extractBestPhotoUrl(photo) {
  if (typeof photo === 'string') return photo;
  if (!photo || !photo.mixedSources) return null;
  
  const jpegs = photo.mixedSources.jpeg || [];
  // Get the highest resolution
  if (jpegs.length === 0) return null;
  const largest = jpegs.reduce((best, j) => (j.width > (best?.width || 0)) ? j : best, null);
  return largest?.url || jpegs[0]?.url || null;
}

function parseAddressString(addressStr) {
  if (!addressStr) return { streetAddress: '', city: '', state: '', zipcode: '' };
  
  // Format: "123 Main St, Atlanta, GA 30307"
  const parts = addressStr.split(',').map(s => s.trim());
  const streetAddress = parts[0] || '';
  const city = parts[1] || '';
  
  // Last part: "GA 30307" or "GA"
  const stateZip = (parts[2] || '').trim().split(/\s+/);
  const state = stateZip[0] || '';
  const zipcode = stateZip[1] || '';
  
  return { streetAddress, city, state, zipcode };
}

function extractStreetNumber(streetAddress) {
  if (!streetAddress) return '';
  const match = streetAddress.match(/^(\d+)/);
  return match ? match[1] : '';
}

function extractStreetName(streetAddress) {
  if (!streetAddress) return '';
  return streetAddress.replace(/^\d+\s*/, '').trim();
}

function mapPropertyType(type) {
  if (!type) return undefined;
  const map = {
    'Residential': 'SingleFamily',
    'Single Family': 'SingleFamily',
    'SFR': 'SingleFamily',
    'Condo': 'Condo',
    'Condominium': 'Condo',
    'Townhouse': 'Townhouse',
    'Multi-Family': 'MultiFamily',
    'MultiFamily': 'MultiFamily',
    'Apartment': 'Apartment',
    'Land': 'LotsLand',
    'Mobile': 'Manufactured',
  };
  return map[type] || type;
}

function mapPropertyTypeReverse(zillowType) {
  if (!zillowType) return 'Residential';
  const map = {
    'SingleFamily': 'Residential',
    'Condo': 'Condominium',
    'Townhouse': 'Townhouse',
    'MultiFamily': 'Multi-Family',
    'Apartment': 'Apartment',
    'LotsLand': 'Land',
    'Manufactured': 'Mobile/Manufactured',
  };
  return map[zillowType] || zillowType;
}

// ============================================
// DEFAULT EXPORT (backward compatible with `import snowflake from './snowflake.js'`)
// ============================================

export default {
  // Connection
  connect,
  disconnect,
  testConnection,
  executeQuery,
  listTables,
  describeTable,
  
  // Search
  searchProperties,
  searchPropertiesByLocation,
  searchPropertiesByPrice,
  searchMLSProperties,
  searchMLSPropertiesWithImages,
  searchPropertiesInBounds,
  searchHistoricalListings,
  
  // Property Detail
  getPropertyDetail,
  getMLSPropertyByKey,
  getMLSPropertyWithImages,
  getMLSPropertyFullDetail,
  getPropertyByAddress,
  getPropertyById,
  getPropertyCount,
  
  // Media
  getPropertyMedia,
  getPhotosForListings,
  getHistoricalListingImages,
  
  // Property sub-details
  getPropertyRooms,
  getPropertyOpenHouses,
  getPropertyUnitTypes,
  getPropertyBusinessHistory,
  
  // Price History
  getPriceHistory,
  getPriceHistoryByAddress,
  getPropertyPriceTimeline,
  getAddressPriceTimeline,
  getAddressListingHistory,
  
  // Comparables
  getComparableHomes,
  getSimilarProperties,
  getNearbyProperties,
  getComparableMarketStats,
  
  // Market Data
  getMarketAppreciation,
  getHousingMarket,
  getRentalMarket,
  getLocalCapRate,
  
  // Renovation
  findRenovationPairs,
  findRentalRenovationPairs,
  findRenovationCandidates,
  findSimilarRenovations,
  getRenovationAreaStats,
  getRenovationCandidateWithPhotos,
  
  // Climate & Walkability
  getClimateData,
  getWalkTransitBike,
  
  // Off-Market
  searchOffMarket,
  
  // Market meta
  getAvailableMarkets,
  getAvailableStates,
  getPropertySubtypes,
};
