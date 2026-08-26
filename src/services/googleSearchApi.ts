/**
 * Google Search API Integration
 * Fetches real-time regional renovation costs via Google Custom Search
 * Uses backend proxy to keep API keys secure
 */

import { GoogleSearchResult } from '../types/propertyAnalysis';

const BACKEND_URL = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';

/**
 * Search Google for renovation costs in a specific location
 */
export async function searchRenovationCosts(
  renovationType: string,
  city: string,
  state: string,
  additionalContext?: string
): Promise<GoogleSearchResult[]> {
  
  try {
    // Build targeted search query
    const query = buildRenovationSearchQuery(renovationType, city, state, additionalContext);
    
    // Execute search via backend proxy
    const url = `${BACKEND_URL}/api/google-search?q=${encodeURIComponent(query)}&num=10`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.warn(`[GoogleSearch] Backend error: ${response.status} - Analysis will continue with BLS data only`);
      return [];
    }
    
    const data = await response.json();
    
    if (!data.ok || !data.items || data.items.length === 0) {
      console.warn(`[GoogleSearch] No results for: ${query}`);
      return [];
    }
    
    // Transform to our format
    const results: GoogleSearchResult[] = data.items.map((item: any) => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      displayLink: item.displayLink
    }));
    
    return results;
    
  } catch (error) {
    console.warn('[GoogleSearch] Error (non-blocking):', error);
    return [];
  }
}

/**
 * Build optimized search query for renovation costs
 */
function buildRenovationSearchQuery(
  renovationType: string,
  city: string,
  state: string,
  additionalContext?: string
): string {
  
  // Target high-quality cost estimation sources
  const queries = [
    `${renovationType} cost ${city} ${state} 2024 2025`,
    `how much does ${renovationType} cost in ${city} ${state}`,
    `${renovationType} contractor prices ${city} ${state}`,
    `${renovationType} average cost ${city} ${state} area`,
  ];
  
  if (additionalContext) {
    queries[0] = `${renovationType} ${additionalContext} cost ${city} ${state} 2024 2025`;
  }
  
  // Prefer specific sources (HomeAdvisor, Angi, Thumbtack, local contractors)
  const query = queries[0] + ' site:homeadvisor.com OR site:angi.com OR site:thumbtack.com OR contractor';
  
  return query;
}

/**
 * Conduct comprehensive renovation cost research
 * Runs 5 targeted searches for a renovation type
 */
export async function conductComprehensiveRenovationResearch(
  renovationType: string,
  city: string,
  state: string,
  sqft?: number
): Promise<GoogleSearchResult[]> {
  
  const allResults: GoogleSearchResult[] = [];
  
  // Query 1: General cost
  const query1 = await searchRenovationCosts(renovationType, city, state);
  allResults.push(...query1.slice(0, 3)); // Top 3 results
  
  // Query 2: With square footage context (if provided)
  if (sqft) {
    const query2 = await searchRenovationCosts(
      renovationType,
      city,
      state,
      `${sqft} square feet`
    );
    allResults.push(...query2.slice(0, 2));
  }
  
  // Query 3: Local contractors
  const query3 = await searchRenovationCosts(
    renovationType,
    city,
    state,
      'contractor estimate'
  );
  allResults.push(...query3.slice(0, 2));
  
  // Query 4: Recent pricing (2024/2025)
  const query4 = await searchRenovationCosts(
    `${renovationType} 2024 2025 updated`,
    city,
    state
  );
  allResults.push(...query4.slice(0, 2));
  
  // Query 5: Range/average
  const query5 = await searchRenovationCosts(
    `${renovationType} average price range`,
    city,
    state
  );
  allResults.push(...query5.slice(0, 1));
  
  // Deduplicate by link
  const uniqueResults = Array.from(
    new Map(allResults.map(item => [item.link, item])).values()
  );
  
  return uniqueResults;
}

/**
 * Search for specific renovation component costs
 */
export async function searchComponentCost(
  component: string,
  city: string,
  state: string
): Promise<GoogleSearchResult[]> {
  
  const query = `${component} installation cost ${city} ${state} 2024`;
  
  try {
    const url = `${BACKEND_URL}/api/google-search?q=${encodeURIComponent(query)}&num=5`;
    
    const response = await fetch(url);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    
    if (!data.ok || !data.items) return [];
    
    return data.items.map((item: any) => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      displayLink: item.displayLink
    }));
    
  } catch (error) {
    console.error('Error searching component cost:', error);
    return [];
  }
}

/**
 * Search for contractor availability and pricing trends
 */
export async function searchContractorPricing(
  renovationType: string,
  city: string,
  state: string
): Promise<GoogleSearchResult[]> {
  
  const query = `${renovationType} contractor average hourly rate ${city} ${state}`;
  
  try {
    const url = `${BACKEND_URL}/api/google-search?q=${encodeURIComponent(query)}&num=5`;
    
    const response = await fetch(url);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    
    if (!data.ok || !data.items) return [];
    
    return data.items.map((item: any) => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      displayLink: item.displayLink
    }));
    
  } catch (error) {
    console.error('Error searching contractor pricing:', error);
    return [];
  }
}
