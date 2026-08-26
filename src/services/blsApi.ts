/**
 * BLS (Bureau of Labor Statistics) API Integration
 * Fetches regional construction wages and labor cost indexes
 */

import { BLSWageData } from '../types/propertyAnalysis';

const BACKEND_URL = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';

// BLS Series IDs for Construction Wages by Metro Area
// Format: OEUM[METRO_CODE]000000232012 (Construction and Extraction Occupations)
const METRO_SERIES_MAP: { [key: string]: string } = {
  // Major metros
  'Washington-Arlington-Alexandria DC-VA-MD-WV': 'OEUM47900000000232012',
  'New York-Newark-Jersey City NY-NJ-PA': 'OEUM35620000000232012',
  'Los Angeles-Long Beach-Anaheim CA': 'OEUM31080000000232012',
  'Chicago-Naperville-Elgin IL-IN-WI': 'OEUM16980000000232012',
  'Dallas-Fort Worth-Arlington TX': 'OEUM19100000000232012',
  'Houston-The Woodlands-Sugar Land TX': 'OEUM26420000000232012',
  'Philadelphia-Camden-Wilmington PA-NJ-DE-MD': 'OEUM37980000000232012',
  'Atlanta-Sandy Springs-Roswell GA': 'OEUM12060000000232012',
  'Miami-Fort Lauderdale-West Palm Beach FL': 'OEUM33100000000232012',
  'Phoenix-Mesa-Scottsdale AZ': 'OEUM38060000000232012',
  'Boston-Cambridge-Newton MA-NH': 'OEUM14460000000232012',
  'San Francisco-Oakland-Hayward CA': 'OEUM41860000000232012',
  'Riverside-San Bernardino-Ontario CA': 'OEUM40140000000232012',
  'Detroit-Warren-Dearborn MI': 'OEUM19820000000232012',
  'Seattle-Tacoma-Bellevue WA': 'OEUM42660000000232012',
  'Minneapolis-St. Paul-Bloomington MN-WI': 'OEUM33460000000232012',
  'San Diego-Carlsbad CA': 'OEUM41740000000232012',
  'Tampa-St. Petersburg-Clearwater FL': 'OEUM45300000000232012',
  'Denver-Aurora-Lakewood CO': 'OEUM19740000000232012',
  'St. Louis MO-IL': 'OEUM41180000000232012',
  'Baltimore-Columbia-Towson MD': 'OEUM12580000000232012',
};

// National average series ID
const NATIONAL_SERIES_ID = 'OEUN000000000000232012';

/**
 * Fetch construction wage data from BLS for a given metro area
 */
export async function getBLSConstructionWage(
  metroArea: string,
  city?: string,
  state?: string
): Promise<BLSWageData | null> {
  
  try {
    // Try to match metro area
    let seriesId = METRO_SERIES_MAP[metroArea] || NATIONAL_SERIES_ID;
    
    // If not found, try to find by city/state
    if (seriesId === NATIONAL_SERIES_ID && city && state) {
      const matchedMetro = findMetroByCity(city, state);
      if (matchedMetro) {
        seriesId = METRO_SERIES_MAP[matchedMetro];
      }
    }
    
    // Fetch latest data via backend proxy to avoid CORS
    const endYear = new Date().getFullYear();
    const startYear = endYear - 1;
    
    const response = await fetch(
      `${BACKEND_URL}/api/bls/wage?seriesId=${seriesId}&startYear=${startYear}&endYear=${endYear}`
    );
    
    if (!response.ok) {
      console.warn(`BLS API returned ${response.status}`);
      return null;
    }
    
    const result = await response.json();
    
    if (!result.ok || !result.data) {
      console.warn('BLS API request failed or no data returned');
      return null;
    }
    
    const data = result.data;
    
    if (data.status !== 'REQUEST_SUCCEEDED' || !data.Results?.series?.[0]?.data) {
      console.warn('BLS API request failed or no data returned');
      return null;
    }
    
    // Get most recent data point
    const latestData = data.Results.series[0].data[0];
    
    // Validate data has required fields
    if (!latestData || !latestData.value) {
      console.warn('BLS API returned data without value field');
      return null;
    }
    
    return {
      metroArea: metroArea || 'National Average',
      hourlyWage: parseFloat(latestData.value),
      year: parseInt(latestData.year),
      month: latestData.periodName === 'Annual' ? 0 : parseInt(latestData.period.substring(1))
    };
    
  } catch (error) {
    console.error('Error fetching BLS wage data:', error);
    return null;
  }
}

/**
 * Calculate regional labor cost multiplier compared to national average
 */
export async function getRegionalLaborMultiplier(
  city: string,
  state: string
): Promise<number> {
  
  try {
    // Fetch national average
    const nationalData = await getBLSConstructionWage('National Average');
    
    // Fetch regional data
    const metroArea = findMetroByCity(city, state);
    const regionalData = metroArea 
      ? await getBLSConstructionWage(metroArea)
      : null;
    
    if (!nationalData) {
      console.warn('Could not fetch national wage data, using default multiplier');
      return getDefaultRegionalMultiplier(state);
    }
    
    if (!regionalData) {
      console.warn(`Could not fetch regional wage data for ${city}, ${state}`);
      return getDefaultRegionalMultiplier(state);
    }
    
    // Calculate multiplier
    const multiplier = regionalData.hourlyWage / nationalData.hourlyWage;
    
    return multiplier;
    
  } catch (error) {
    console.error('Error calculating regional labor multiplier:', error);
    return getDefaultRegionalMultiplier(state);
  }
}

/**
 * Find metro area by city and state
 */
function findMetroByCity(city: string, state: string): string | null {
  const cityLower = city.toLowerCase();
  const stateLower = state.toLowerCase();
  
  // Direct city matches
  const cityMatches: { [key: string]: string } = {
    'washington': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'arlington': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'alexandria': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'bethesda': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'potomac': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'rockville': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'new york': 'New York-Newark-Jersey City NY-NJ-PA',
    'brooklyn': 'New York-Newark-Jersey City NY-NJ-PA',
    'manhattan': 'New York-Newark-Jersey City NY-NJ-PA',
    'queens': 'New York-Newark-Jersey City NY-NJ-PA',
    'newark': 'New York-Newark-Jersey City NY-NJ-PA',
    'jersey city': 'New York-Newark-Jersey City NY-NJ-PA',
    'los angeles': 'Los Angeles-Long Beach-Anaheim CA',
    'long beach': 'Los Angeles-Long Beach-Anaheim CA',
    'anaheim': 'Los Angeles-Long Beach-Anaheim CA',
    'santa monica': 'Los Angeles-Long Beach-Anaheim CA',
    'chicago': 'Chicago-Naperville-Elgin IL-IN-WI',
    'naperville': 'Chicago-Naperville-Elgin IL-IN-WI',
    'dallas': 'Dallas-Fort Worth-Arlington TX',
    'fort worth': 'Dallas-Fort Worth-Arlington TX',
    'houston': 'Houston-The Woodlands-Sugar Land TX',
    'philadelphia': 'Philadelphia-Camden-Wilmington PA-NJ-DE-MD',
    'atlanta': 'Atlanta-Sandy Springs-Roswell GA',
    'miami': 'Miami-Fort Lauderdale-West Palm Beach FL',
    'fort lauderdale': 'Miami-Fort Lauderdale-West Palm Beach FL',
    'phoenix': 'Phoenix-Mesa-Scottsdale AZ',
    'boston': 'Boston-Cambridge-Newton MA-NH',
    'cambridge': 'Boston-Cambridge-Newton MA-NH',
    'san francisco': 'San Francisco-Oakland-Hayward CA',
    'oakland': 'San Francisco-Oakland-Hayward CA',
    'detroit': 'Detroit-Warren-Dearborn MI',
    'seattle': 'Seattle-Tacoma-Bellevue WA',
    'tacoma': 'Seattle-Tacoma-Bellevue WA',
    'minneapolis': 'Minneapolis-St. Paul-Bloomington MN-WI',
    'san diego': 'San Diego-Carlsbad CA',
    'tampa': 'Tampa-St. Petersburg-Clearwater FL',
    'denver': 'Denver-Aurora-Lakewood CO',
    'baltimore': 'Baltimore-Columbia-Towson MD',
  };
  
  if (cityMatches[cityLower]) {
    return cityMatches[cityLower];
  }
  
  // State-based fallback
  const stateMatches: { [key: string]: string } = {
    'dc': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'maryland': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
    'virginia': 'Washington-Arlington-Alexandria DC-VA-MD-WV',
  };
  
  if (stateMatches[stateLower]) {
    return stateMatches[stateLower];
  }
  
  return null;
}

/**
 * Default regional multipliers by state (fallback)
 */
function getDefaultRegionalMultiplier(state: string): number {
  const stateLower = state.toLowerCase();
  
  const stateMultipliers: { [key: string]: number } = {
    // High cost states
    'california': 1.30,
    'new york': 1.25,
    'massachusetts': 1.20,
    'washington': 1.20,
    'hawaii': 1.35,
    'alaska': 1.30,
    'connecticut': 1.15,
    'new jersey': 1.20,
    'maryland': 1.15,
    'dc': 1.20,
    // Medium cost states
    'illinois': 1.10,
    'colorado': 1.10,
    'oregon': 1.10,
    'pennsylvania': 1.05,
    'virginia': 1.08,
    'minnesota': 1.08,
    'rhode island': 1.10,
    'nevada': 1.05,
    // Low cost states
    'texas': 0.95,
    'florida': 0.95,
    'georgia': 0.90,
    'arizona': 0.95,
    'north carolina': 0.90,
    'tennessee': 0.85,
    'ohio': 0.90,
    'michigan': 0.95,
    'indiana': 0.85,
    'missouri': 0.85,
    'wisconsin': 0.95,
    'alabama': 0.80,
    'mississippi': 0.75,
    'arkansas': 0.80,
    'oklahoma': 0.85,
    'kentucky': 0.85,
    'louisiana': 0.85,
    'iowa': 0.90,
    'kansas': 0.85,
    'nebraska': 0.90,
    'west virginia': 0.85,
    'new mexico': 0.85,
    'idaho': 0.90,
    'montana': 0.95,
    'wyoming': 0.95,
    'south dakota': 0.90,
    'north dakota': 1.00,
  };
  
  return stateMultipliers[stateLower] || 1.00;
}

/**
 * Estimate total labor cost for a renovation project
 */
export async function estimateLaborCost(
  baseProjectCost: number,
  laborPercentage: number, // Typical: 0.40-0.60 (40-60% labor)
  city: string,
  state: string
): Promise<number> {
  
  const regionalMultiplier = await getRegionalLaborMultiplier(city, state);
  const baseLaborCost = baseProjectCost * laborPercentage;
  const adjustedLaborCost = baseLaborCost * regionalMultiplier;
  
  return adjustedLaborCost;
}
