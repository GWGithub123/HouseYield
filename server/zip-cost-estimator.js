/**
 * Zip Code-Specific Cost Estimation Service
 * Uses Google Custom Search + GPT-5 to find highly precise, location-specific cost estimates
 */

import 'dotenv/config';

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

/**
 * Get cost estimate for a specific project type in a specific zip code
 * 
 * @param {string} projectType - Type of project (e.g., "kitchen remodel", "roof replacement")
 * @param {string} zipCode - 5-digit zip code
 * @param {object} options - Optional parameters (projectSize, materials, etc.)
 * @returns {Promise<object>} Cost estimate with ranges and confidence
 */
export async function getZipCodeCostEstimate(projectType, zipCode, options = {}) {
  console.log(`[Zip Cost Estimator] Estimating cost for: ${projectType} in ${zipCode}`);

  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
    return { ok: false, error: 'Google Search API not configured' };
  }

  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'OpenAI API not configured' };
  }

  try {
    // Step 1: Generate optimized search query
    const searchQuery = await generateSearchQuery(projectType, zipCode, options);
    console.log(`[Zip Cost Estimator] Search query: "${searchQuery}"`);

    // Step 2: Search Google for cost data
    const searchResults = await searchGoogleForCosts(searchQuery);
    
    if (!searchResults.ok) {
      return { ok: false, error: searchResults.error };
    }

    // Step 3: Extract cost data from search results
    const costData = await extractCostData(searchResults.items, projectType, zipCode);

    if (!costData) {
      return { ok: false, error: 'Failed to extract cost data from search results' };
    }

    // Step 4: Return formatted response
    return {
      ok: true,
      projectType,
      zipCode,
      location: costData.location || extractLocationFromZip(zipCode),
      searchQuery,
      costRange: {
        low: costData.lowEstimate || 0,
        average: costData.avgEstimate || 0,
        high: costData.highEstimate || 0
      },
      confidence: costData.confidence || 'medium',
      sources: searchResults.items.map(item => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet
      })),
      sourcesCount: searchResults.items.length,
      costFactors: costData.costFactors || [],
      notes: costData.notes || '',
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('[Zip Cost Estimator] Error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get DETAILED cost estimate with material breakdown, quantities, and labor
 * This is the precision version for exact renovation planning
 * 
 * @param {object} projectDetails - Detailed project specifications
 * @returns {Promise<object>} Detailed cost breakdown
 */
export async function getDetailedCostEstimate(projectDetails) {
  const { projectType, zipCode, specifications } = projectDetails;
  
  console.log(`[Detailed Cost Estimator] Analyzing: ${projectType} in ${zipCode}`);
  console.log(`[Detailed Cost Estimator] Specs:`, JSON.stringify(specifications, null, 2));

  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX || !OPENAI_API_KEY) {
    return { ok: false, error: 'APIs not configured' };
  }

  try {
    // Step 1: Generate AI breakdown of materials and labor needed
    const projectBreakdown = await generateProjectBreakdown(projectType, specifications, zipCode);
    
    if (!projectBreakdown.ok) {
      return projectBreakdown;
    }

    console.log(`[Detailed Cost Estimator] Generated ${projectBreakdown.materials.length} material items`);
    console.log(`[Detailed Cost Estimator] Generated ${projectBreakdown.laborItems.length} labor items`);

    // Step 2: Search for material costs (parallel searches for efficiency)
    const materialCosts = await searchMaterialCosts(projectBreakdown.materials, zipCode);

    // Step 3: Search for labor costs
    const laborCosts = await searchLaborCosts(projectBreakdown.laborItems, zipCode);

    // Step 4: Calculate totals and build detailed breakdown
    const materialTotal = materialCosts.reduce((sum, item) => sum + (item.totalCost || 0), 0);
    const laborTotal = laborCosts.reduce((sum, item) => sum + (item.totalCost || 0), 0);
    const grandTotal = materialTotal + laborTotal;

    return {
      ok: true,
      projectType,
      zipCode,
      location: projectBreakdown.location,
      specifications,
      
      summary: {
        materialsTotal: Math.round(materialTotal),
        laborTotal: Math.round(laborTotal),
        grandTotal: Math.round(grandTotal),
        lowEstimate: Math.round(grandTotal * 0.85),
        highEstimate: Math.round(grandTotal * 1.15)
      },

      materials: materialCosts.map(m => ({
        item: m.item,
        quantity: m.quantity,
        unit: m.unit,
        unitCost: m.unitCost,
        totalCost: Math.round(m.totalCost || 0),
        source: m.source,
        confidence: m.confidence
      })),

      labor: laborCosts.map(l => ({
        task: l.task,
        hours: l.hours,
        hourlyRate: l.hourlyRate,
        totalCost: Math.round(l.totalCost || 0),
        tradeType: l.tradeType,
        source: l.source,
        confidence: l.confidence
      })),

      additionalCosts: projectBreakdown.additionalCosts || [],
      
      timeline: projectBreakdown.estimatedTimeline || 'Not estimated',
      
      confidence: calculateOverallConfidence(materialCosts, laborCosts),
      
      notes: projectBreakdown.notes || '',
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('[Detailed Cost Estimator] Error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Generate an optimized Google search query for cost data
 */
async function generateSearchQuery(projectType, zipCode, options) {
  // Simplify - just use the project type + location + cost keywords
  // Remove overly restrictive site: operators that limit results
  const basicQuery = `${projectType} cost ${zipCode} 2025 contractor estimate`;
  
  console.log(`[Search Query] Using basic query: "${basicQuery}"`);
  return basicQuery;
}

/**
 * Search Google Custom Search API for cost data
 */
async function searchGoogleForCosts(searchQuery) {
  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_CX);
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('num', 8); // Get 8 results for better data

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return { ok: false, error: 'No search results found' };
    }

    return {
      ok: true,
      items: data.items,
      searchInfo: data.searchInformation
    };

  } catch (error) {
    console.error('[Google Search] Error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Extract structured cost data from search results using GPT-4o
 */
async function extractCostData(searchResults, projectType, zipCode) {
  const snippets = searchResults.map((r, idx) => 
    `[${idx + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`
  ).join('\n\n');

  console.log(`[Cost Extraction] Processing ${searchResults.length} search results for ${projectType}`);

  const extractionPrompt = `Extract cost estimates from these search results for: ${projectType} in zip code ${zipCode}

Search Results:
${snippets}

Analyze these results and extract:
1. Low estimate (minimum realistic cost from any source)
2. Average estimate (typical/median cost across sources)  
3. High estimate (maximum typical cost from any source)
4. Cost factors mentioned (materials, labor, size, permits, etc.)
5. Location details if mentioned
6. Confidence level based on:
   - Number of sources with cost data
   - Agreement between sources (±15% = high, ±25% = medium, >25% = low)
   - Recency of data (2024-2025 = better)
   - Source quality (HomeAdvisor, Angi, Fixr = trusted)

IMPORTANT: Extract ANY dollar amounts you find, even if approximate. Look for patterns like:
- "$X to $Y"
- "$X-$Y"
- "costs around $X"
- "$X on average"
- "starting at $X"

If NO dollar amounts are found in the search results, set all estimates to 0 and confidence to "none".

Return as JSON:
{
  "lowEstimate": number,
  "avgEstimate": number,
  "highEstimate": number,
  "costFactors": ["factor1", "factor2"],
  "location": "city, state",
  "confidence": "high" | "medium" | "low",
  "notes": "brief summary of findings, mention source count and variance"
}

If NO cost data is found in the results, return estimates as 0 and confidence as "none".`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: 'You extract numerical cost estimates from web search results. Analyze all sources, calculate ranges, and assess confidence. Return only valid JSON.' 
          },
          { role: 'user', content: extractionPrompt }
        ],
        max_tokens: 600,
        temperature: 0.2
      })
    });

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    
    console.log(`[Cost Extraction] GPT Response: ${content?.substring(0, 200)}...`);
    
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[Cost Extraction] Extracted: $${parsed.avgEstimate} (${parsed.confidence} confidence)`);
      
      // If we got 0, log the snippets for debugging
      if (parsed.avgEstimate === 0) {
        console.log(`[Cost Extraction] ⚠️ Got $0 estimate. First snippet: ${snippets.substring(0, 300)}...`);
      }
      
      return parsed;
    }

    console.log(`[Cost Extraction] ⚠️ Failed to parse JSON from GPT response`);
    return null;

  } catch (error) {
    console.error('[Cost Extraction] Error:', error);
    return null;
  }
}

/**
 * Generate detailed project breakdown with materials and labor
 * Now supports actual room measurements from Metric3D for precise quantities
 */
async function generateProjectBreakdown(projectType, specifications, zipCode) {
  // Handle missing specifications gracefully
  const specs = specifications || {};
  
  // Build measurement context if actual measurements are provided
  let measurementContext = '';
  if (specs.actualMeasurements) {
    const m = specs.actualMeasurements;
    if (m.room) {
      const lengthFt = (m.room.length * 3.28084).toFixed(1);
      const widthFt = (m.room.width * 3.28084).toFixed(1);
      const heightFt = (m.room.height * 3.28084).toFixed(1);
      const floorSqFt = (lengthFt * widthFt).toFixed(0);
      const wallSqFt = (2 * (parseFloat(lengthFt) + parseFloat(widthFt)) * parseFloat(heightFt)).toFixed(0);
      const linearFt = (2 * (parseFloat(lengthFt) + parseFloat(widthFt))).toFixed(1);
      
      measurementContext = `
ACTUAL ROOM MEASUREMENTS (from 3D scan):
- Room Length: ${lengthFt} feet
- Room Width: ${widthFt} feet  
- Ceiling Height: ${heightFt} feet
- Floor Area: ${floorSqFt} sq ft
- Wall Area: ${wallSqFt} sq ft
- Perimeter: ${linearFt} linear feet
- Measurement Confidence: ${((m.room.confidence || 0.8) * 100).toFixed(0)}%
`;
    }
    if (m.objects && m.objects.length > 0) {
      measurementContext += '\nMEASURED OBJECTS:\n';
      m.objects.forEach(obj => {
        const wFt = (obj.dimensions.width * 3.28084).toFixed(1);
        const hFt = (obj.dimensions.height * 3.28084).toFixed(1);
        const dFt = obj.dimensions.depth ? (obj.dimensions.depth * 3.28084).toFixed(1) : 'N/A';
        measurementContext += `- ${obj.objectType}: ${wFt}' W x ${hFt}' H x ${dFt}' D\n`;
      });
    }
  }

  const breakdownPrompt = `You are a construction estimator. Break down this renovation project into EXACT materials and labor needed.

Project Type: ${projectType}
Location Zip Code: ${zipCode}
${measurementContext}
Specifications:
${JSON.stringify(specifications, null, 2)}

${measurementContext ? 'IMPORTANT: Use the ACTUAL MEASUREMENTS provided above for all quantity calculations. These are real measurements from a 3D room scan, not estimates.' : ''}

Provide a detailed breakdown as JSON:
{
  "location": "City, State from zip",
  "materials": [
    {
      "item": "Specific material name",
      "quantity": number,
      "unit": "sq ft | linear ft | each | gallon | etc",
      "category": "flooring | cabinetry | countertop | appliance | plumbing | electrical | etc"
    }
  ],
  "laborItems": [
    {
      "task": "Specific task description",
      "tradeType": "carpenter | plumber | electrician | painter | general labor | etc",
      "estimatedHours": number
    }
  ],
  "additionalCosts": [
    {
      "item": "permits | waste disposal | etc",
      "estimatedCost": number
    }
  ],
  "estimatedTimeline": "X days/weeks",
  "notes": "Important considerations or assumptions"
}

Be SPECIFIC with quantities. For example:
- Kitchen: "24 linear feet cabinets", "36 sq ft granite countertop", "1 sink faucet"
- Bathroom: "75 sq ft tile flooring", "1 toilet", "1 vanity 36-inch"
- Paint: "Calculate sq ft of walls based on room size"
${measurementContext ? '- Use the actual measured dimensions to calculate exact quantities (add 10% waste factor for materials)' : ''}`;

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
          { 
            role: 'system', 
            content: 'You are an expert construction estimator who creates detailed, accurate material and labor breakdowns. You know standard quantities and industry practices.' 
          },
          { role: 'user', content: breakdownPrompt }
        ],
        max_tokens: 2000,
        temperature: 0.3
      })
    });

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const breakdown = JSON.parse(jsonMatch[0]);
      return { ok: true, ...breakdown };
    }

    return { ok: false, error: 'Failed to parse breakdown' };

  } catch (error) {
    console.error('[Project Breakdown] Error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Search for material costs - does multiple parallel searches
 */
async function searchMaterialCosts(materials, zipCode) {
  const costs = [];

  // Group materials by category to optimize searches
  const categories = {};
  materials.forEach(mat => {
    const cat = mat.category || 'general';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(mat);
  });

  // Search for each material
  for (const material of materials) {
    const cost = await searchSingleMaterialCost(material, zipCode);
    costs.push(cost);
  }

  return costs;
}

/**
 * Search for a single material cost - IMPROVED with fallback strategy
 */
async function searchSingleMaterialCost(material, zipCode) {
  // Strategy 1: Specific site search
  let searchQuery;
  if (material.unit === 'each') {
    searchQuery = `"${material.item}" price cost 2025 site:homedepot.com OR site:lowes.com OR site:build.com`;
  } else {
    searchQuery = `"${material.item}" cost per ${material.unit} 2025 site:homedepot.com OR site:lowes.com OR site:homeadvisor.com`;
  }
  
  console.log(`[Material Search] ${material.item}: "${searchQuery}"`);
  
  try {
    let data = await executeGoogleSearch(searchQuery);

    // Strategy 2: If no results, try broader search
    if (!data.items || data.items.length === 0) {
      console.log(`[Material Search] No results, trying broader search...`);
      searchQuery = `${material.item} price cost 2025`;
      data = await executeGoogleSearch(searchQuery);
    }

    // Strategy 3: If still no results, try without year
    if (!data.items || data.items.length === 0) {
      console.log(`[Material Search] Still no results, trying without year filter...`);
      searchQuery = `${material.item} average cost price`;
      data = await executeGoogleSearch(searchQuery);
    }

    if (!data.items || data.items.length === 0) {
      console.log(`[Material Search] No results for ${material.item}, using fallback`);
      return {
        ...material,
        unitCost: 0,
        totalCost: 0,
        source: 'no results',
        confidence: 'low'
      };
    }

    // Extract price using GPT
    const priceData = await extractMaterialPrice(data.items, material);
    
    console.log(`[Material Cost] ${material.item}: $${priceData.unitCost}/${material.unit} (${priceData.confidence})`);
    
    return {
      ...material,
      unitCost: priceData.unitCost || 0,
      totalCost: (priceData.unitCost || 0) * material.quantity,
      source: priceData.source || 'search',
      confidence: priceData.confidence || 'medium'
    };

  } catch (error) {
    console.error(`[Material Cost] Error for ${material.item}:`, error);
    return {
      ...material,
      unitCost: 0,
      totalCost: 0,
      source: 'error',
      confidence: 'none'
    };
  }
}

/**
 * Helper: Execute Google Custom Search
 */
async function executeGoogleSearch(query, numResults = 5) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', GOOGLE_API_KEY);
  url.searchParams.set('cx', GOOGLE_CSE_CX);
  url.searchParams.set('q', query);
  url.searchParams.set('num', numResults);

  const response = await fetch(url.toString());
  return await response.json();
}

/**
 * Extract material price from search results
 */
async function extractMaterialPrice(searchResults, material) {
  const snippets = searchResults.map((r, idx) => 
    `[${idx+1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`
  ).join('\n\n');

  const prompt = `Extract the price for "${material.item}" from these search results.

Material Details:
- Item: ${material.item}
- Quantity needed: ${material.quantity} ${material.unit}
- Category: ${material.category}

Search Results:
${snippets}

Instructions:
1. Find the UNIT PRICE (price per ${material.unit})
2. Look for numbers near: $, USD, price, cost
3. If results show "each" price and we need "${material.unit}", estimate conversion
4. If no exact match, find similar items and estimate
5. HomeDepot/Lowes are most reliable sources
6. Use 2024-2025 prices if available

Return JSON:
{
  "unitCost": number (price per ${material.unit}, NOT total),
  "source": "specific source name",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation of how you found this price"
}

Example: If a granite countertop is $50/sq ft and we need 36 sq ft:
- unitCost: 50 (not 1800)
- The total will be calculated separately

If NO price found, estimate based on typical market rates or return unitCost: 0 with confidence: "none".`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a pricing expert who extracts accurate unit costs from search results. Be precise about units. Return only JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
        temperature: 0.1
      })
    });

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`   → Found: $${parsed.unitCost}/${material.unit} from ${parsed.source} (${parsed.confidence})`);
      return parsed;
    }

    return { unitCost: 0, source: 'parse error', confidence: 'none', reasoning: 'Failed to parse response' };

  } catch (error) {
    console.error(`   → Error extracting price:`, error.message);
    return { unitCost: 0, source: 'error', confidence: 'none', reasoning: error.message };
  }
}

/**
 * Search for labor costs
 */
async function searchLaborCosts(laborItems, zipCode) {
  const costs = [];

  for (const labor of laborItems) {
    const cost = await searchSingleLaborCost(labor, zipCode);
    costs.push(cost);
  }

  return costs;
}

/**
 * Search for a single labor cost - IMPROVED with fallback strategy
 */
async function searchSingleLaborCost(labor, zipCode) {
  // Strategy 1: Location-specific search
  let searchQuery = `"${labor.tradeType}" hourly rate ${zipCode} 2025 contractor cost site:homeadvisor.com OR site:angi.com OR site:thumbtack.com`;
  
  console.log(`[Labor Search] ${labor.tradeType}: "${searchQuery}"`);
  
  try {
    let data = await executeGoogleSearch(searchQuery);

    // Strategy 2: Broader location search (remove zip, use city/state)
    if (!data.items || data.items.length === 0) {
      console.log(`[Labor Search] No zip-specific results, trying broader search...`);
      searchQuery = `${labor.tradeType} hourly rate contractor cost 2025`;
      data = await executeGoogleSearch(searchQuery);
    }

    // Strategy 3: Generic search
    if (!data.items || data.items.length === 0) {
      console.log(`[Labor Search] Still no results, trying generic search...`);
      searchQuery = `${labor.tradeType} hourly rate average cost`;
      data = await executeGoogleSearch(searchQuery);
    }

    if (!data.items || data.items.length === 0) {
      console.log(`[Labor Search] No results for ${labor.tradeType}, using fallback`);
      return {
        ...labor,
        hours: labor.estimatedHours,
        hourlyRate: 0,
        totalCost: 0,
        source: 'no results',
        confidence: 'low'
      };
    }

    // Extract hourly rate using GPT
    const rateData = await extractLaborRate(data.items, labor.tradeType, zipCode);
    
    console.log(`[Labor Cost] ${labor.tradeType}: $${rateData.hourlyRate}/hr × ${labor.estimatedHours}hrs = $${(rateData.hourlyRate || 0) * labor.estimatedHours} (${rateData.confidence})`);
    
    return {
      ...labor,
      hours: labor.estimatedHours,
      hourlyRate: rateData.hourlyRate || 0,
      totalCost: (rateData.hourlyRate || 0) * labor.estimatedHours,
      source: rateData.source || 'search',
      confidence: rateData.confidence || 'medium'
    };

  } catch (error) {
    console.error(`[Labor Cost] Error for ${labor.task}:`, error);
    return {
      ...labor,
      hours: labor.estimatedHours,
      hourlyRate: 0,
      totalCost: 0,
      source: 'error',
      confidence: 'none'
    };
  }
}

/**
 * Extract labor hourly rate from search results
 */
async function extractLaborRate(searchResults, tradeType, zipCode) {
  const snippets = searchResults.map((r, idx) => 
    `[${idx+1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`
  ).join('\n\n');

  const prompt = `Extract the hourly rate for "${tradeType}" in zip code ${zipCode} from these search results:

Search Results:
${snippets}

Instructions:
1. Look for hourly rates ($/hr, per hour, hourly)
2. Prefer rates specific to this location/zip code
3. If multiple rates, use the average
4. Contractor rates are typically higher than handyman rates
5. 2024-2025 rates are most accurate

Return JSON:
{
  "hourlyRate": number (dollars per hour),
  "source": "specific source name",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation"
}

Typical industry ranges for reference:
- General labor: $25-45/hr
- Painter: $35-65/hr  
- Carpenter: $45-85/hr
- Plumber: $75-150/hr
- Electrician: $75-150/hr
- Flooring installer: $40-70/hr
- Countertop installer: $50-90/hr

If NO rate found in results, use industry average for this trade type with confidence: "low".`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a labor cost expert who extracts accurate hourly rates from search results. Use industry standards when data is unclear. Return only JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
        temperature: 0.1
      })
    });

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`   → Found: $${parsed.hourlyRate}/hr from ${parsed.source} (${parsed.confidence})`);
      return parsed;
    }

    return { hourlyRate: 0, source: 'parse error', confidence: 'none', reasoning: 'Failed to parse response' };

  } catch (error) {
    console.error(`   → Error extracting rate:`, error.message);
    return { hourlyRate: 0, source: 'error', confidence: 'none', reasoning: error.message };
  }
}

/**
 * Calculate overall confidence based on material and labor confidence
 */
function calculateOverallConfidence(materialCosts, laborCosts) {
  const allItems = [...materialCosts, ...laborCosts];
  const confidenceScores = { high: 3, medium: 2, low: 1, none: 0 };
  
  const avgScore = allItems.reduce((sum, item) => {
    return sum + (confidenceScores[item.confidence] || 0);
  }, 0) / allItems.length;

  if (avgScore >= 2.5) return 'high';
  if (avgScore >= 1.5) return 'medium';
  return 'low';
}

/**
 * Helper: Extract location name from zip code (basic fallback)
 */
function extractLocationFromZip(zipCode) {
  // This is a simple fallback - in production you might use a zip code database
  return `Zip Code ${zipCode}`;
}

export default {
  getZipCodeCostEstimate,
  getDetailedCostEstimate
};
