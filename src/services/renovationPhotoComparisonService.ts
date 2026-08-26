/**
 * Renovation Photo Comparison Service
 * Uses GPT-4 Vision to compare before/after property photos and detect renovations
 */

import type {
  DetectedRenovation,
  PhotoComparisonResult,
  RenovationCategory,
  RenovationScope
} from '../types/renovationROI';
import { requestAiChatCompletion } from './aiChatProxy';

// ============================================================================
// RENOVATION DETECTION PROMPT
// ============================================================================

const RENOVATION_COMPARISON_PROMPT = `You are an expert real estate renovation analyst. Compare these BEFORE and AFTER photos of the same property to identify what renovations were done.

BEFORE photos show the property at an earlier listing date.
AFTER photos show the same property at a later listing date.

Analyze carefully and identify ALL visible renovations between the two sets of photos.

For each renovation detected, provide:
1. category: One of: kitchen, bathroom_master, bathroom_secondary, flooring, paint_interior, paint_exterior, roof, windows, doors, siding, landscaping, driveway, hvac, electrical, plumbing, basement, attic, garage, deck_patio, pool, other
2. scope: One of:
   - "cosmetic" = Paint, hardware, light fixtures ($2k-$10k)
   - "refresh" = Counters, backsplash, appliances, some cabinets ($10k-$25k)
   - "full_remodel" = Full cabinet replacement, layout changes ($25k-$75k)
   - "gut_reno" = Down to studs, complete rebuild ($75k+)
3. description: Specific description of what was changed
4. confidence: 0-1 how confident you are this renovation occurred
5. qualityLevel: "budget", "mid_grade", "high_end", or "luxury"
6. beforeDescription: What it looked like before
7. afterDescription: What it looks like after
8. estimatedCost: Estimated cost in dollars

Return a JSON object with this structure:
{
  "renovationsDetected": [
    {
      "category": "kitchen",
      "scope": "refresh",
      "description": "Updated countertops to quartz, new stainless steel appliances, painted cabinets white",
      "confidence": 0.95,
      "qualityLevel": "mid_grade",
      "beforeDescription": "Laminate countertops, white appliances, oak cabinets",
      "afterDescription": "Quartz countertops, stainless appliances, white painted cabinets",
      "estimatedCost": 18000,
      "costRange": { "low": 12000, "high": 25000 }
    }
  ],
  "overallConfidence": 0.85,
  "notes": "Any additional observations about the renovations"
}

If you cannot detect any renovations or the photos are too different/unclear, return:
{
  "renovationsDetected": [],
  "overallConfidence": 0,
  "notes": "Reason why no renovations could be detected"
}

BE SPECIFIC about what changed. Look for:
- Kitchen: Countertops, cabinets, appliances, backsplash, flooring, lighting
- Bathrooms: Vanity, toilet, shower/tub, tile, fixtures
- Flooring: Type change (carpet to hardwood, etc.), refinishing
- Paint: Wall colors, trim, ceiling
- Exterior: Siding, roof, windows, doors, landscaping, driveway
- Systems: Visible HVAC units, water heater, electrical panel`;

// ============================================================================
// PHOTO COMPARISON FUNCTION
// ============================================================================

/**
 * Compare before and after photos to detect renovations
 * @param beforePhotos - Array of photo URLs from earlier listing
 * @param afterPhotos - Array of photo URLs from later listing
 * @param propertyId - Property identifier for tracking
 * @param beforeListingKey - Earlier listing key
 * @param afterListingKey - Later listing key
 * @returns Detected renovations and analysis
 */
export async function comparePropertyPhotos(
  beforePhotos: string[],
  afterPhotos: string[],
  propertyId: string,
  beforeListingKey: string,
  afterListingKey: string
): Promise<PhotoComparisonResult> {
  
  // Select representative photos (first 6 from each set to stay within token limits)
  const selectedBefore = selectRepresentativePhotos(beforePhotos, 6);
  const selectedAfter = selectRepresentativePhotos(afterPhotos, 6);
  
  if (selectedBefore.length === 0 || selectedAfter.length === 0) {
    console.warn('[RenovationComparison] Insufficient photos for comparison');
    return createEmptyResult(propertyId, beforeListingKey, afterListingKey, beforePhotos, afterPhotos);
  }
  
  console.log(`[RenovationComparison] Comparing ${selectedBefore.length} before photos with ${selectedAfter.length} after photos`);
  
  try {
    // Build the message content with before and after photo sections
    const messageContent: any[] = [
      {
        type: 'text',
        text: '=== BEFORE PHOTOS (Earlier Listing) ==='
      }
    ];
    
    // Add before photos
    for (const url of selectedBefore) {
      messageContent.push({
        type: 'image_url',
        image_url: {
          url: url,
          detail: 'high'
        }
      });
    }
    
    messageContent.push({
      type: 'text',
      text: '=== AFTER PHOTOS (Later Listing) ==='
    });
    
    // Add after photos
    for (const url of selectedAfter) {
      messageContent.push({
        type: 'image_url',
        image_url: {
          url: url,
          detail: 'high'
        }
      });
    }
    
    messageContent.push({
      type: 'text',
      text: 'Now compare the BEFORE and AFTER photos and identify all renovations that were done. Return your analysis as JSON.'
    });
    
    const data = await requestAiChatCompletion({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: RENOVATION_COMPARISON_PROMPT
        },
        {
          role: 'user',
          content: messageContent
        }
      ],
      max_tokens: 4000,
      temperature: 0.3
    });

    const content = data.choices?.[0]?.message?.content || '';
    
    // Parse the JSON response
    const parsed = parseRenovationResponse(content);
    
    // Calculate total estimated cost
    const totalEstimatedCost = parsed.renovationsDetected.reduce(
      (sum, reno) => sum + (reno.estimatedCost || 0), 
      0
    );
    
    console.log(`[RenovationComparison] Detected ${parsed.renovationsDetected.length} renovations, total cost: $${totalEstimatedCost}`);
    
    return {
      propertyId,
      beforeListingKey,
      afterListingKey,
      beforePhotos: selectedBefore,
      afterPhotos: selectedAfter,
      renovationsDetected: parsed.renovationsDetected,
      totalEstimatedCost,
      overallConfidence: parsed.overallConfidence,
      analysisTimestamp: new Date(),
      rawAIResponse: content
    };
    
  } catch (error) {
    console.error('[RenovationComparison] Error comparing photos:', error);
    return createEmptyResult(propertyId, beforeListingKey, afterListingKey, beforePhotos, afterPhotos);
  }
}

/**
 * Select representative photos, prioritizing variety
 */
function selectRepresentativePhotos(photos: string[], maxCount: number): string[] {
  if (photos.length <= maxCount) {
    return photos;
  }
  
  // Take evenly distributed photos
  const selected: string[] = [];
  const step = photos.length / maxCount;
  
  for (let i = 0; i < maxCount; i++) {
    const index = Math.floor(i * step);
    if (photos[index]) {
      selected.push(photos[index]);
    }
  }
  
  return selected;
}

/**
 * Parse the AI response into structured renovation data
 */
function parseRenovationResponse(content: string): {
  renovationsDetected: DetectedRenovation[];
  overallConfidence: number;
  notes?: string;
} {
  try {
    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = content;
    
    // Check for markdown code block
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }
    
    const parsed = JSON.parse(jsonStr);
    
    // Validate and normalize the renovations
    const renovationsDetected: DetectedRenovation[] = (parsed.renovationsDetected || []).map((reno: any) => ({
      category: validateCategory(reno.category),
      scope: validateScope(reno.scope),
      description: reno.description || 'Unknown renovation',
      confidence: Math.min(1, Math.max(0, reno.confidence || 0.5)),
      estimatedCost: reno.estimatedCost || estimateCostFromScope(reno.scope),
      costRange: reno.costRange || getCostRangeFromScope(reno.scope),
      beforeDescription: reno.beforeDescription,
      afterDescription: reno.afterDescription,
      qualityLevel: validateQualityLevel(reno.qualityLevel)
    }));
    
    return {
      renovationsDetected,
      overallConfidence: parsed.overallConfidence || 0.5,
      notes: parsed.notes
    };
    
  } catch (error) {
    console.error('[RenovationComparison] Failed to parse AI response:', error);
    return {
      renovationsDetected: [],
      overallConfidence: 0,
      notes: 'Failed to parse AI response'
    };
  }
}

/**
 * Validate renovation category
 */
function validateCategory(category: string): RenovationCategory {
  const validCategories: RenovationCategory[] = [
    'kitchen', 'bathroom_master', 'bathroom_secondary', 'flooring',
    'paint_interior', 'paint_exterior', 'roof', 'windows', 'doors',
    'siding', 'landscaping', 'driveway', 'hvac', 'electrical',
    'plumbing', 'basement', 'attic', 'garage', 'deck_patio', 'pool', 'other'
  ];
  
  const normalized = (category || '').toLowerCase().replace(/\s+/g, '_');
  
  if (validCategories.includes(normalized as RenovationCategory)) {
    return normalized as RenovationCategory;
  }
  
  // Map common variations
  if (normalized.includes('kitchen')) return 'kitchen';
  if (normalized.includes('bath')) return 'bathroom_master';
  if (normalized.includes('floor') || normalized.includes('carpet') || normalized.includes('hardwood')) return 'flooring';
  if (normalized.includes('paint') && normalized.includes('ext')) return 'paint_exterior';
  if (normalized.includes('paint')) return 'paint_interior';
  if (normalized.includes('roof')) return 'roof';
  if (normalized.includes('window')) return 'windows';
  if (normalized.includes('land') || normalized.includes('yard')) return 'landscaping';
  if (normalized.includes('deck') || normalized.includes('patio')) return 'deck_patio';
  
  return 'other';
}

/**
 * Validate renovation scope
 */
function validateScope(scope: string): RenovationScope {
  const normalized = (scope || '').toLowerCase().replace(/\s+/g, '_');
  
  if (normalized === 'cosmetic') return 'cosmetic';
  if (normalized === 'refresh') return 'refresh';
  if (normalized === 'full_remodel' || normalized === 'full' || normalized === 'remodel') return 'full_remodel';
  if (normalized === 'gut_reno' || normalized === 'gut' || normalized === 'complete') return 'gut_reno';
  
  return 'refresh'; // Default to refresh
}

/**
 * Validate quality level
 */
function validateQualityLevel(level: string): 'budget' | 'mid_grade' | 'high_end' | 'luxury' {
  const normalized = (level || '').toLowerCase();
  
  if (normalized.includes('budget') || normalized.includes('low')) return 'budget';
  if (normalized.includes('mid') || normalized.includes('standard')) return 'mid_grade';
  if (normalized.includes('high')) return 'high_end';
  if (normalized.includes('luxury') || normalized.includes('premium')) return 'luxury';
  
  return 'mid_grade';
}

/**
 * Estimate cost from scope if not provided
 */
function estimateCostFromScope(scope: string): number {
  switch (validateScope(scope)) {
    case 'cosmetic': return 5000;
    case 'refresh': return 15000;
    case 'full_remodel': return 45000;
    case 'gut_reno': return 100000;
    default: return 15000;
  }
}

/**
 * Get cost range from scope
 */
function getCostRangeFromScope(scope: string): { low: number; high: number } {
  switch (validateScope(scope)) {
    case 'cosmetic': return { low: 2000, high: 10000 };
    case 'refresh': return { low: 10000, high: 25000 };
    case 'full_remodel': return { low: 25000, high: 75000 };
    case 'gut_reno': return { low: 75000, high: 150000 };
    default: return { low: 10000, high: 25000 };
  }
}

/**
 * Create empty result for error cases
 */
function createEmptyResult(
  propertyId: string,
  beforeListingKey: string,
  afterListingKey: string,
  beforePhotos: string[],
  afterPhotos: string[]
): PhotoComparisonResult {
  return {
    propertyId,
    beforeListingKey,
    afterListingKey,
    beforePhotos,
    afterPhotos,
    renovationsDetected: [],
    totalEstimatedCost: 0,
    overallConfidence: 0,
    analysisTimestamp: new Date()
  };
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

/**
 * Process multiple renovation candidates in batch
 * @param candidates - Array of candidates with before/after photos
 * @param concurrency - Number of parallel requests (default 2 to respect rate limits)
 * @returns Array of comparison results
 */
export async function batchCompareRenovations(
  candidates: Array<{
    propertyId: string;
    beforeListingKey: string;
    afterListingKey: string;
    beforePhotos: string[];
    afterPhotos: string[];
  }>,
  concurrency: number = 2
): Promise<PhotoComparisonResult[]> {
  
  const results: PhotoComparisonResult[] = [];
  
  // Process in batches
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    
    const batchResults = await Promise.all(
      batch.map(candidate => 
        comparePropertyPhotos(
          candidate.beforePhotos,
          candidate.afterPhotos,
          candidate.propertyId,
          candidate.beforeListingKey,
          candidate.afterListingKey
        )
      )
    );
    
    results.push(...batchResults);
    
    // Rate limit delay between batches
    if (i + concurrency < candidates.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
}

// ============================================================================
// COST ESTIMATION HELPERS
// ============================================================================

/**
 * Get estimated renovation cost based on category, scope, and quality
 * Uses national averages with optional regional multiplier
 */
export function getEstimatedRenovationCost(
  category: RenovationCategory,
  scope: RenovationScope,
  qualityLevel: 'budget' | 'mid_grade' | 'high_end' | 'luxury' = 'mid_grade',
  sqft?: number,
  regionalMultiplier: number = 1.0
): { estimate: number; low: number; high: number } {
  
  // Base costs by category (mid_grade, refresh scope)
  const baseCosts: Record<RenovationCategory, number> = {
    kitchen: 25000,
    bathroom_master: 18000,
    bathroom_secondary: 12000,
    flooring: 8000,        // Will be multiplied by sqft if available
    paint_interior: 4000,
    paint_exterior: 6000,
    roof: 12000,
    windows: 15000,
    doors: 3000,
    siding: 18000,
    landscaping: 8000,
    driveway: 6000,
    hvac: 8000,
    electrical: 5000,
    plumbing: 4000,
    basement: 35000,
    attic: 15000,
    garage: 12000,
    deck_patio: 10000,
    pool: 45000,
    other: 10000
  };
  
  // Scope multipliers
  const scopeMultipliers: Record<RenovationScope, number> = {
    cosmetic: 0.3,
    refresh: 1.0,
    full_remodel: 2.5,
    gut_reno: 4.0
  };
  
  // Quality multipliers
  const qualityMultipliers = {
    budget: 0.6,
    mid_grade: 1.0,
    high_end: 1.8,
    luxury: 3.0
  };
  
  let baseCost = baseCosts[category] || 10000;
  
  // For flooring, adjust by sqft
  if (category === 'flooring' && sqft) {
    baseCost = sqft * 5; // $5/sqft base for mid-grade flooring
  }
  
  const estimate = Math.round(
    baseCost * 
    scopeMultipliers[scope] * 
    qualityMultipliers[qualityLevel] * 
    regionalMultiplier
  );
  
  return {
    estimate,
    low: Math.round(estimate * 0.7),
    high: Math.round(estimate * 1.4)
  };
}
