/**
 * OpenAI API Integration
 * Parses Google Search results to extract renovation costs and pricing data
 */

import { RenovationCostEstimate } from '../types/propertyAnalysis';
import { GoogleSearchResult } from '../types/propertyAnalysis';
import { requestAiChatCompletion } from './aiChatProxy';

/**
 * Parse Google Search results to extract renovation cost estimates
 */
export async function parseRenovationCosts(
  renovationType: string,
  city: string,
  state: string,
  searchResults: GoogleSearchResult[],
  blsLaborMultiplier: number
): Promise<RenovationCostEstimate> {
  
  if (searchResults.length === 0) {
    return getFallbackEstimate(renovationType, city, state, blsLaborMultiplier);
  }
  
  try {
    // Prepare context from search results
    const searchContext = searchResults
      .map((result, i) => `[Source ${i + 1}]\nTitle: ${result.title}\nContent: ${result.snippet}\nURL: ${result.link}\n`)
      .join('\n');
    
    // Build prompt for GPT-4o
    const prompt = buildCostExtractionPrompt(renovationType, city, state, searchContext, blsLaborMultiplier);
    
    // Call OpenAI API
    const data = await requestAiChatCompletion({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a real estate renovation cost analyst. Extract pricing data from search results and provide structured cost estimates.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const content = data.choices[0].message.content;
    const parsed = JSON.parse(content);
    
    // Transform to our format
    const estimate: RenovationCostEstimate = {
      renovationType,
      baseCost: parsed.baseCost || parsed.totalCost || 0,
      laborCost: parsed.laborCost || parsed.totalCost * 0.5,
      materialCost: parsed.materialCost || parsed.totalCost * 0.5,
      totalCost: parsed.totalCost || 0,
      costRange: {
        low: parsed.costRange?.low || parsed.totalCost * 0.8,
        high: parsed.costRange?.high || parsed.totalCost * 1.2
      },
      breakdown: {
        labor: parsed.breakdown?.labor || parsed.laborPercentage || 50,
        materials: parsed.breakdown?.materials || parsed.materialPercentage || 40,
        permits: parsed.breakdown?.permits || 5,
        contingency: parsed.breakdown?.contingency || 10
      },
      regionalFactors: parsed.regionalFactors || [],
      dataSource: 'Google Search + OpenAI GPT-4o',
      confidence: determineConfidence(searchResults, parsed),
      lastUpdated: new Date()
    };
    
    return estimate;
    
  } catch (error) {
    console.error('Error parsing renovation costs with OpenAI:', error);
    return getFallbackEstimate(renovationType, city, state, blsLaborMultiplier);
  }
}

/**
 * Build prompt for cost extraction
 */
function buildCostExtractionPrompt(
  renovationType: string,
  city: string,
  state: string,
  searchContext: string,
  blsLaborMultiplier: number
): string {
  
  return `Analyze the following search results for "${renovationType}" costs in ${city}, ${state} and extract pricing information.

SEARCH RESULTS:
${searchContext}

BLS REGIONAL LABOR MULTIPLIER: ${blsLaborMultiplier.toFixed(2)}x (compared to national average)

TASK:
Extract and synthesize renovation cost data. Return a JSON object with this structure:
{
  "totalCost": number,     // Average total cost in USD
  "costRange": {           // Price range found
    "low": number,
    "high": number
  },
  "laborCost": number,     // Labor portion
  "materialCost": number,  // Material portion
  "breakdown": {           // Percentage breakdown
    "labor": number,       // % of total
    "materials": number,   // % of total
    "permits": number,     // % of total
    "contingency": number  // % of total
  },
  "laborPercentage": number,    // % labor (40-60 typical)
  "materialPercentage": number, // % materials
  "regionalFactors": [string],  // Regional considerations found
  "dataQuality": "high" | "medium" | "low",
  "sourcesUsed": number,        // How many sources had usable data
  "notes": string              // Key observations
}

GUIDELINES:
1. Extract specific dollar amounts mentioned in results
2. If ranges are given (e.g., "$30,000 - $50,000"), use the midpoint for totalCost
3. Apply the BLS labor multiplier to adjust labor costs for ${city}, ${state}
4. Typical labor/material splits: Kitchen (50/40), Bathroom (45/45), Roof (40/50), HVAC (30/60)
5. Note any regional factors (high demand, material costs, permit complexity)
6. If data is sparse or conflicting, indicate low dataQuality
7. Return ONLY valid JSON, no additional text

Provide the most accurate estimate possible based on the available data.`;
}

/**
 * Determine confidence level based on data quality
 */
function determineConfidence(
  searchResults: GoogleSearchResult[],
  parsedData: any
): 'high' | 'medium' | 'low' {
  
  const dataQuality = parsedData.dataQuality;
  const sourcesUsed = parsedData.sourcesUsed || 0;
  const resultsCount = searchResults.length;
  
  // High confidence: good data quality, multiple sources
  if (dataQuality === 'high' && sourcesUsed >= 3 && resultsCount >= 5) {
    return 'high';
  }
  
  // Medium confidence: decent data, some sources
  if (dataQuality !== 'low' && sourcesUsed >= 2 && resultsCount >= 3) {
    return 'medium';
  }
  
  // Low confidence: sparse or conflicting data
  return 'low';
}

/**
 * Fallback cost estimates when API fails or no data
 */
function getFallbackEstimate(
  renovationType: string,
  city: string,
  state: string,
  blsLaborMultiplier: number
): RenovationCostEstimate {
  
  // National average costs (baseline)
  const nationalAverages: { [key: string]: number } = {
    'kitchen remodel': 35000,
    'kitchen renovation': 35000,
    'bathroom remodel': 15000,
    'bathroom renovation': 15000,
    'master bathroom': 18000,
    'roof replacement': 10000,
    'hvac replacement': 8000,
    'flooring replacement': 6000,
    'paint interior': 3500,
    'window replacement': 8000,
    'siding replacement': 12000,
    'basement finish': 25000,
    'deck construction': 15000,
    'landscaping': 5000
  };
  
  const typeKey = renovationType.toLowerCase();
  let baseCost = 25000; // Default fallback
  
  // Find matching cost
  for (const [key, cost] of Object.entries(nationalAverages)) {
    if (typeKey.includes(key) || key.includes(typeKey)) {
      baseCost = cost;
      break;
    }
  }
  
  // Apply regional multiplier to labor portion (50% of cost)
  const laborPortion = baseCost * 0.5;
  const adjustedLaborCost = laborPortion * blsLaborMultiplier;
  const totalCost = adjustedLaborCost + (baseCost * 0.5); // labor + materials
  
  return {
    renovationType,
    baseCost,
    laborCost: adjustedLaborCost,
    materialCost: baseCost * 0.5,
    totalCost,
    costRange: {
      low: totalCost * 0.75,
      high: totalCost * 1.35
    },
    breakdown: {
      labor: 50,
      materials: 40,
      permits: 5,
      contingency: 10
    },
    regionalFactors: [`BLS labor multiplier: ${blsLaborMultiplier.toFixed(2)}x`],
    dataSource: 'National Average + BLS Regional Adjustment',
    confidence: 'low',
    lastUpdated: new Date()
  };
}

/**
 * Get multiple renovation cost estimates in parallel
 */
export async function getBulkRenovationCosts(
  renovations: Array<{ type: string; context?: string }>,
  city: string,
  state: string,
  searchResultsMap: Map<string, GoogleSearchResult[]>,
  blsLaborMultiplier: number
): Promise<Map<string, RenovationCostEstimate>> {
  
  const estimates = new Map<string, RenovationCostEstimate>();
  
  // Process each renovation type
  const promises = renovations.map(async (reno) => {
    const searchResults = searchResultsMap.get(reno.type) || [];
    const estimate = await parseRenovationCosts(
      reno.type,
      city,
      state,
      searchResults,
      blsLaborMultiplier
    );
    return { type: reno.type, estimate };
  });
  
  const results = await Promise.all(promises);
  
  results.forEach(({ type, estimate }) => {
    estimates.set(type, estimate);
  });
  
  return estimates;
}
