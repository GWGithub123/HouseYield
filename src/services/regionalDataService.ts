/**
 * Regional Economic Data Service
 * Fetches regional market data from FRED API for market heat analysis
 */

export interface FREDRegionalResponse {
  ok: boolean;
  data?: {
    name: string;
    code?: string;
    countyFips?: string;
    overview?: {
      housingPrice?: { value: string; date: string; yoy: string | null };
      unemployment?: { value: string; date: string; change: string | null };
      medianIncome?: { value: string; date: string; growth: string | null };
      averageWage?: { value: string; date: string; growth: string | null };
      // Supply indicators
      buildingPermits?: { value: string; date: string; yoy: string | null; description?: string };
      newListings?: { value: string; date: string; yoy: string | null; description?: string };
      activeListings?: { value: string; date: string; yoy: string | null; description?: string };
    };
    charts?: {
      housing?: Array<{ date: string; value: number }>;
      unemployment?: Array<{ date: string; value: number }>;
      wages?: Array<{ date: string; value: number }>;
      income?: Array<{ date: string; value: number }>;
      // Supply indicator charts
      buildingPermits?: Array<{ date: string; value: number }>;
      newListings?: Array<{ date: string; value: number }>;
      activeListings?: Array<{ date: string; value: number }>;
    };
  };
  error?: string;
}

// Metro area to FRED region code mapping
const METRO_TO_REGION: Record<string, string> = {
  // California
  'san francisco': 'san-francisco',
  'san jose': 'san-francisco',
  'oakland': 'san-francisco',
  'los angeles': 'los-angeles',
  'long beach': 'los-angeles',
  'anaheim': 'los-angeles',
  'san diego': 'san-diego',
  'sacramento': 'sacramento',
  'riverside': 'los-angeles',
  
  // Texas
  'austin': 'austin',
  'round rock': 'austin',
  'dallas': 'dallas',
  'fort worth': 'dallas',
  'houston': 'houston',
  'san antonio': 'san-antonio',
  
  // Florida
  'miami': 'miami',
  'fort lauderdale': 'miami',
  'west palm beach': 'miami',
  'tampa': 'tampa',
  'orlando': 'orlando',
  'jacksonville': 'jacksonville',
  
  // Arizona
  'phoenix': 'phoenix',
  'scottsdale': 'phoenix',
  'mesa': 'phoenix',
  'tucson': 'tucson',
  
  // Other major metros
  'new york': 'new-york',
  'brooklyn': 'new-york',
  'manhattan': 'new-york',
  'queens': 'new-york',
  'chicago': 'chicago',
  'seattle': 'seattle',
  'tacoma': 'seattle',
  'denver': 'denver',
  'atlanta': 'atlanta',
  'boston': 'boston',
  'washington': 'washington-dc',
  'dc': 'washington-dc',
  'philadelphia': 'philadelphia',
  'minneapolis': 'minneapolis',
  'portland': 'portland',
  'las vegas': 'las-vegas',
  'detroit': 'detroit',
  'charlotte': 'charlotte',
  'raleigh': 'raleigh',
  'nashville': 'nashville',
  'salt lake city': 'salt-lake-city',
  'kansas city': 'kansas-city',
  'columbus': 'columbus',
  'indianapolis': 'indianapolis',
  'cincinnati': 'cincinnati',
  'cleveland': 'cleveland',
  'pittsburgh': 'pittsburgh',
  'st louis': 'st-louis',
  'baltimore': 'baltimore',
};

// State fallback to nearest major metro
const STATE_FALLBACK: Record<string, string> = {
  'CA': 'los-angeles',
  'TX': 'dallas',
  'FL': 'miami',
  'AZ': 'phoenix',
  'NY': 'new-york',
  'IL': 'chicago',
  'WA': 'seattle',
  'CO': 'denver',
  'GA': 'atlanta',
  'MA': 'boston',
  'PA': 'philadelphia',
  'NC': 'charlotte',
  'TN': 'nashville',
  'NV': 'las-vegas',
  'MI': 'detroit',
  'OH': 'columbus',
  'MN': 'minneapolis',
  'OR': 'portland',
  'UT': 'salt-lake-city',
  'MO': 'kansas-city',
  'IN': 'indianapolis',
  'MD': 'baltimore',
  'VA': 'washington-dc',
  'NJ': 'new-york',
  'CT': 'new-york',
};

/**
 * Extract city and state from an address
 */
function parseAddress(address: string): { city: string; state: string } {
  // Format: "123 Main St, City, ST 12345" or "City, ST 12345"
  const parts = address.split(',').map(p => p.trim());
  
  let city = '';
  let state = '';
  
  if (parts.length >= 2) {
    // Try to get city (usually second to last part or first part if no street)
    city = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    
    // Get state from last part
    const stateZip = parts[parts.length - 1];
    const stateMatch = stateZip.match(/([A-Z]{2})\s*\d{5}/);
    state = stateMatch ? stateMatch[1] : '';
  }
  
  return { city: city.toLowerCase(), state };
}

/**
 * Find the best matching FRED region code for an address
 */
function findRegionCode(address: string): string | null {
  const { city, state } = parseAddress(address);
  
  // Try exact city match first
  for (const [metroName, regionCode] of Object.entries(METRO_TO_REGION)) {
    if (city.includes(metroName) || metroName.includes(city)) {
      return regionCode;
    }
  }
  
  // Fallback to state-based metro
  if (state && STATE_FALLBACK[state]) {
    return STATE_FALLBACK[state];
  }
  
  return null;
}

/**
 * Fetch regional economic data from FRED API
 */
export async function fetchRegionalData(address: string): Promise<FREDRegionalResponse | null> {
  try {
    const regionCode = findRegionCode(address);
    
    if (!regionCode) {
      console.log('[Regional Data] No matching region found for:', address);
      return null;
    }
    
    console.log('[Regional Data] Fetching data for region:', regionCode);
    
    const response = await fetch(`/api/fred/regions/${regionCode}`);
    
    if (!response.ok) {
      console.error('[Regional Data] API error:', response.status);
      return null;
    }
    
    const data: FREDRegionalResponse = await response.json();
    
    if (!data.ok) {
      console.error('[Regional Data] API returned error:', data.error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('[Regional Data] Fetch error:', error);
    return null;
  }
}

/**
 * Fetch national housing market data for comparison
 */
export async function fetchNationalHousingData(): Promise<any | null> {
  try {
    const response = await fetch('/api/fred/housing-market');
    
    if (!response.ok) {
      console.error('[National Data] API error:', response.status);
      return null;
    }
    
    const data = await response.json();
    return data.ok ? data.data : null;
  } catch (error) {
    console.error('[National Data] Fetch error:', error);
    return null;
  }
}

/**
 * County data response from dynamic FIPS lookup
 */
export interface CountyDataResponse {
  ok: boolean;
  data?: {
    countyFips: string;
    countyName: string;
    stateCode?: string;
    stateName?: string;
    supply: {
      newListings: { value: string | null; date: string | null; yoy: string | null; available: boolean };
      activeListings: { value: string | null; date: string | null; yoy: string | null; available: boolean };
      buildingPermits: { value: string | null; date: string | null; yoy: string | null; available: boolean };
    };
    labor: {
      unemployment: { value: string | null; date: string | null; change: string | null; available: boolean };
    };
    charts: {
      newListings: Array<{ date: string; value: number }>;
      activeListings: Array<{ date: string; value: number }>;
      buildingPermits: Array<{ date: string; value: number }>;
      unemployment: Array<{ date: string; value: number }>;
    };
  };
  error?: string;
}

/**
 * Fetch county-level economic data dynamically using lat/lng coordinates
 * This is the new dynamic approach - no hardcoding needed!
 * 
 * @param latitude - Property latitude
 * @param longitude - Property longitude
 * @returns County-level supply and labor market data
 */
export async function fetchCountyDataByCoords(
  latitude: number, 
  longitude: number
): Promise<CountyDataResponse | null> {
  try {
    console.log('[County Data] Fetching for coords:', latitude, longitude);
    
    const response = await fetch(
      `/api/fred/county-by-coords?lat=${latitude}&lng=${longitude}`
    );
    
    if (!response.ok) {
      console.error('[County Data] API error:', response.status);
      return null;
    }
    
    const data: CountyDataResponse = await response.json();
    
    if (!data.ok) {
      console.error('[County Data] API returned error:', data.error);
      return null;
    }
    
    console.log('[County Data] Success for:', data.data?.countyName, data.data?.stateCode);
    return data;
  } catch (error) {
    console.error('[County Data] Fetch error:', error);
    return null;
  }
}

/**
 * Fetch county-level economic data by FIPS code directly
 * Use this when you already have the FIPS code
 * 
 * @param fips - 5-digit county FIPS code
 * @param countyName - Optional county name for logging
 */
export async function fetchCountyDataByFips(
  fips: string, 
  countyName?: string
): Promise<CountyDataResponse | null> {
  try {
    console.log('[County Data] Fetching for FIPS:', fips);
    
    const url = countyName 
      ? `/api/fred/county/${fips}?name=${encodeURIComponent(countyName)}`
      : `/api/fred/county/${fips}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error('[County Data] API error:', response.status);
      return null;
    }
    
    const data: CountyDataResponse = await response.json();
    
    if (!data.ok) {
      console.error('[County Data] API returned error:', data.error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('[County Data] Fetch error:', error);
    return null;
  }
}

/**
 * Transform FRED API response to the format expected by regionalMarketAnalyzer
 */
export function transformFREDData(fredData: FREDRegionalResponse['data']): any {
  if (!fredData) return {};
  
  // Calculate supply pipeline risk based on building permits and listings YoY
  const permitsYoY = parseFloat(fredData.overview?.buildingPermits?.yoy || '0');
  const newListingsYoY = parseFloat(fredData.overview?.newListings?.yoy || '0');
  const activeListingsYoY = parseFloat(fredData.overview?.activeListings?.yoy || '0');
  
  // High permits growth + high listings growth = potential oversupply risk
  // Negative growth = supply constrained
  let supplyPipelineRisk: 'very_high' | 'high' | 'moderate' | 'low' | 'very_low' = 'moderate';
  const supplyGrowthAvg = (permitsYoY + newListingsYoY + activeListingsYoY) / 3;
  
  if (supplyGrowthAvg > 20) supplyPipelineRisk = 'very_high';
  else if (supplyGrowthAvg > 10) supplyPipelineRisk = 'high';
  else if (supplyGrowthAvg > -5) supplyPipelineRisk = 'moderate';
  else if (supplyGrowthAvg > -15) supplyPipelineRisk = 'low';
  else supplyPipelineRisk = 'very_low';
  
  // Map the FRED API response structure to what the analyzer expects
  return {
    current: {
      housingIndex: fredData.overview?.housingPrice,
      unemployment: fredData.overview?.unemployment,
      medianIncome: fredData.overview?.medianIncome,
      averageWage: fredData.overview?.averageWage,
    },
    // Supply indicators (new)
    supplyIndicators: {
      buildingPermits: fredData.overview?.buildingPermits,
      newListings: fredData.overview?.newListings,
      activeListings: fredData.overview?.activeListings,
      permitsYoY,
      newListingsYoY,
      activeListingsYoY,
      supplyPipelineRisk,
    },
    charts: fredData.charts,
    countyFips: fredData.countyFips,
    // These would need to come from additional sources or be estimated
    vacancyRate: undefined,
    rentGrowth: undefined,
    populationGrowth: undefined,
    daysOnMarket: undefined,
    inventoryMonths: undefined,
  };
}

/**
 * Get state code from an address
 */
export function extractStateCode(address: string): string {
  const { state } = parseAddress(address);
  return state;
}

/**
 * Get a human-readable metro area name from address
 */
export function getMetroAreaName(address: string): string {
  const regionCode = findRegionCode(address);
  
  if (regionCode) {
    // Convert region code to readable name
    return regionCode
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  
  // Fallback to city from address
  const { city } = parseAddress(address);
  return city.split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
