/**
 * Server-side Photo Comparison Service
 * Uses GPT-4o Vision to compare before/after property photos and detect renovations.
 * This is the Node.js counterpart of src/services/renovationPhotoComparisonService.ts
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';

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
9. affectedRooms: Array of room names this renovation touched, e.g. ["kitchen"], ["master_bathroom"], ["living_room", "dining_room", "hallway"]. Use snake_case. For whole-house renovations like flooring or paint, list ALL rooms you can see were affected.
10. estimatedAreaSqFt: Your best estimate of the total square footage affected by this renovation. Use visual cues: standard room sizes (kitchen ~120-200 sqft, bathroom ~50-80 sqft, bedroom ~120-180 sqft), count of rooms visible, and house proportions. For partial-room work (e.g. backsplash only), estimate just the affected surface area.
11. materials: Array of specific materials you can identify in the AFTER photos. For each material:
   - name: e.g. "quartz countertops", "LVP flooring", "subway tile backsplash", "shaker cabinets"
   - materialTier: "budget", "mid_grade", "high_end", or "luxury"
   - confidence: 0-1 how confident you are in the material identification
   Only include materials you can visually confirm. Common identifiable materials:
   - Countertops: laminate, butcher block, granite, quartz, quartzite, marble, concrete
   - Cabinets: thermofoil, painted MDF, shaker, raised panel, slab/flat-panel, custom
   - Flooring: carpet, sheet vinyl, LVP/LVT, laminate, engineered hardwood, solid hardwood, tile, natural stone
   - Backsplash: painted, peel-and-stick, ceramic tile, subway tile, glass mosaic, natural stone
   - Fixtures: builder-grade chrome, brushed nickel, matte black, brass/gold
   - Appliances: white, black, stainless steel, panel-ready/integrated

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
      "costRange": { "low": 12000, "high": 25000 },
      "affectedRooms": ["kitchen"],
      "estimatedAreaSqFt": 150,
      "materials": [
        { "name": "quartz countertops", "materialTier": "mid_grade", "confidence": 0.9 },
        { "name": "shaker cabinets (painted)", "materialTier": "mid_grade", "confidence": 0.85 },
        { "name": "stainless steel appliances", "materialTier": "mid_grade", "confidence": 0.95 }
      ]
    }
  ],
  "beforeCondition": {
    "overall": 5,
    "kitchen": 4,
    "bathrooms": 3,
    "flooring": 6,
    "exterior": 5,
    "systems": 7,
    "notes": "Dated kitchen with laminate counters, bathrooms showing wear, hardwood floors in fair shape"
  },
  "overallConfidence": 0.85,
  "notes": "Any additional observations about the renovations"
}

The "beforeCondition" field rates the property's BEFORE state on a 1-10 scale for each visible area:
  - 1-2: Severely distressed (major damage, safety concerns, uninhabitable)
  - 3-4: Poor (very dated/worn, needs full remodel, deferred maintenance)
  - 5-6: Fair (functional but dated, cosmetic wear, original from 20+ years ago)
  - 7-8: Good (well-maintained, recently refreshed, minor updates needed)
  - 9-10: Excellent (move-in ready, recently renovated, like-new condition)
Rate only areas visible in the BEFORE photos. The "overall" score is your best assessment of the entire property's pre-renovation condition.

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
- Systems: Visible HVAC units, water heater, electrical panel

IMPORTANT ACCURACY RULES:
1. Do NOT count staging changes (furniture, decor, curtains) as renovations.
2. Do NOT count seasonal differences (green vs bare trees) as landscaping renovations.
3. If photos show different rooms/angles and you cannot verify the SAME room changed, lower your confidence significantly.
4. Cost estimates should reflect REALISTIC contractor pricing, not retail material-only prices. Include labor (typically 40-60% of total cost).
5. If you see the same kitchen/bathroom but cannot identify specific structural changes (just different lighting or angle), set confidence below 0.3.
6. For scope classification: "cosmetic" requires NO structural changes, "refresh" requires at least counters/surfaces changed, "full_remodel" requires cabinet/fixture replacement, "gut_reno" requires layout changes or down-to-studs evidence.`;

// ─── helpers ───

function selectRepresentativePhotos(photos, maxCount) {
  if (!photos || photos.length === 0) return [];
  if (photos.length <= maxCount) return [...photos];
  // Evenly sample across the photo set
  const step = photos.length / maxCount;
  const selected = [];
  for (let i = 0; i < maxCount; i++) {
    selected.push(photos[Math.floor(i * step)]);
  }
  return selected;
}

function createEmptyResult(propertyId, beforeKey, afterKey, beforePhotos, afterPhotos) {
  return {
    propertyId,
    beforeListingKey: beforeKey,
    afterListingKey: afterKey,
    renovationsDetected: [],
    overallConfidence: 0,
    beforePhotoCount: beforePhotos?.length || 0,
    afterPhotoCount: afterPhotos?.length || 0,
    analysisDate: new Date().toISOString(),
    notes: 'No analysis performed'
  };
}

// ─── main comparison function ───

export async function comparePropertyPhotos(
  beforePhotos,
  afterPhotos,
  propertyId,
  beforeListingKey,
  afterListingKey
) {
  if (!OPENAI_API_KEY) {
    console.error('[PhotoComparisonServer] No OpenAI API key configured');
    return createEmptyResult(propertyId, beforeListingKey, afterListingKey, beforePhotos, afterPhotos);
  }

  const selectedBefore = selectRepresentativePhotos(beforePhotos, 6);
  const selectedAfter = selectRepresentativePhotos(afterPhotos, 6);

  if (selectedBefore.length === 0 || selectedAfter.length === 0) {
    console.warn('[PhotoComparisonServer] Insufficient photos for comparison');
    return createEmptyResult(propertyId, beforeListingKey, afterListingKey, beforePhotos, afterPhotos);
  }

  console.log(`[PhotoComparisonServer] Comparing ${selectedBefore.length} before → ${selectedAfter.length} after photos for ${propertyId}`);

  try {
    const messageContent = [
      { type: 'text', text: '=== BEFORE PHOTOS (Earlier Listing) ===' }
    ];
    for (const url of selectedBefore) {
      messageContent.push({ type: 'image_url', image_url: { url, detail: 'high' } });
    }
    messageContent.push({ type: 'text', text: '=== AFTER PHOTOS (Later Listing) ===' });
    for (const url of selectedAfter) {
      messageContent.push({ type: 'image_url', image_url: { url, detail: 'high' } });
    }
    messageContent.push({
      type: 'text',
      text: 'Now compare the BEFORE and AFTER photos and identify all renovations that were done. Return your analysis as JSON.'
    });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: RENOVATION_COMPARISON_PROMPT },
          { role: 'user', content: messageContent }
        ],
        max_tokens: 4000,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[PhotoComparisonServer] OpenAI error:', response.status, errText);
      return createEmptyResult(propertyId, beforeListingKey, afterListingKey, beforePhotos, afterPhotos);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Extract JSON from response (may be wrapped in markdown code fences)
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      console.error('[PhotoComparisonServer] Failed to parse GPT response as JSON');
      return createEmptyResult(propertyId, beforeListingKey, afterListingKey, beforePhotos, afterPhotos);
    }

    return {
      propertyId,
      beforeListingKey,
      afterListingKey,
      renovationsDetected: (parsed.renovationsDetected || []).map(r => ({
        category: validateCategory(r.category),
        scope: r.scope || 'cosmetic',
        description: r.description || '',
        confidence: r.confidence || 0.5,
        qualityLevel: r.qualityLevel || 'mid_grade',
        beforeDescription: r.beforeDescription || '',
        afterDescription: r.afterDescription || '',
        estimatedCost: r.estimatedCost || 0,
        costRange: r.costRange || { low: 0, high: 0 },
        affectedRooms: Array.isArray(r.affectedRooms) ? r.affectedRooms : [],
        estimatedAreaSqFt: r.estimatedAreaSqFt || 0,
        materials: (r.materials || []).map(m => ({
          name: m.name || '',
          materialTier: m.materialTier || 'mid_grade',
          confidence: m.confidence || 0.5
        })),
      })),
      // Derive overall material tier from all detected materials across renovations
      materialTierSummary: classifyOverallMaterialTier(parsed.renovationsDetected || []),
      beforeCondition: parsed.beforeCondition || null,
      overallConfidence: parsed.overallConfidence || 0,
      beforePhotoCount: beforePhotos.length,
      afterPhotoCount: afterPhotos.length,
      selectedBeforeCount: selectedBefore.length,
      selectedAfterCount: selectedAfter.length,
      analysisDate: new Date().toISOString(),
      notes: parsed.notes || '',
    };
  } catch (err) {
    console.error('[PhotoComparisonServer] Error during comparison:', err.message);
    return createEmptyResult(propertyId, beforeListingKey, afterListingKey, beforePhotos, afterPhotos);
  }
}

// ─── category validation ───

/**
 * Normalize GPT-4o's category output to valid RenovationCategory values.
 * GPT sometimes returns invalid categories like "interior", "exterior", "general",
 * "full_renovation", etc. This maps them to the closest valid category.
 */
function validateCategory(category) {
  const VALID_CATEGORIES = new Set([
    'kitchen', 'kitchen_full', 'kitchen_cosmetic',
    'bathroom_master', 'bathroom_secondary', 'bathroom_full', 'bathroom_cosmetic',
    'flooring', 'paint_interior', 'paint_exterior',
    'roof', 'windows', 'doors', 'siding',
    'landscaping', 'driveway', 'hvac', 'electrical', 'plumbing',
    'basement', 'basement_finish', 'attic', 'garage', 'deck_patio', 'pool',
    'addition', 'solar', 'smart_home', 'accessibility', 'other'
  ]);

  const raw = (category || '').toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');

  if (VALID_CATEGORIES.has(raw)) return raw;

  // Map common GPT variations to valid categories
  if (raw.includes('kitchen')) return 'kitchen';
  if (raw.includes('bath'))    return 'bathroom_master';
  if (raw.includes('floor') || raw.includes('carpet') || raw.includes('hardwood') || raw.includes('tile') || raw.includes('lvp') || raw.includes('vinyl')) return 'flooring';
  if (raw.includes('paint') && raw.includes('ext'))  return 'paint_exterior';
  if (raw.includes('paint') || raw.includes('wall'))  return 'paint_interior';
  if (raw.includes('roof'))    return 'roof';
  if (raw.includes('window'))  return 'windows';
  if (raw.includes('door'))    return 'doors';
  if (raw.includes('sid'))     return 'siding';
  if (raw.includes('land') || raw.includes('yard') || raw.includes('lawn')) return 'landscaping';
  if (raw.includes('drive'))   return 'driveway';
  if (raw.includes('hvac') || raw.includes('heat') || raw.includes('cool') || raw === 'ac' || raw === 'air_conditioning') return 'hvac';
  if (raw.includes('electr'))  return 'electrical';
  if (raw.includes('plumb'))   return 'plumbing';
  if (raw.includes('base'))    return 'basement';
  if (raw.includes('attic'))   return 'attic';
  if (raw.includes('garage'))  return 'garage';
  if (raw.includes('deck') || raw.includes('patio') || raw.includes('porch')) return 'deck_patio';
  if (raw.includes('pool'))    return 'pool';
  if (raw.includes('add'))     return 'addition';
  if (raw.includes('solar'))   return 'solar';

  // Catch-all invalid categories that GPT commonly returns:
  // "interior", "exterior", "general", "whole_house", "full_renovation"
  // These are too vague — try to infer from the description if available
  // For now, map to 'other' which the aggregator will handle
  return 'other';
}

// ─── material tier classification ───

/**
 * Classify the overall material tier from all detected renovations.
 * Weighted by confidence and cost contribution.
 */
function classifyOverallMaterialTier(renovations) {
  if (!renovations || renovations.length === 0) return 'unknown';
  
  const TIER_SCORES = { 'budget': 1, 'mid_grade': 2, 'high_end': 3, 'luxury': 4 };
  const TIER_NAMES = ['unknown', 'budget', 'mid_grade', 'high_end', 'luxury'];
  
  let weightedSum = 0;
  let totalWeight = 0;
  
  for (const reno of renovations) {
    // Use explicit materials if available
    if (reno.materials && reno.materials.length > 0) {
      for (const mat of reno.materials) {
        const score = TIER_SCORES[mat.materialTier] || 2;
        const weight = (mat.confidence || 0.5) * (reno.estimatedCost || 10000);
        weightedSum += score * weight;
        totalWeight += weight;
      }
    } else {
      // Fall back to qualityLevel as proxy for material tier
      const score = TIER_SCORES[reno.qualityLevel] || 2;
      const weight = (reno.confidence || 0.5) * (reno.estimatedCost || 10000);
      weightedSum += score * weight;
      totalWeight += weight;
    }
  }
  
  if (totalWeight === 0) return 'unknown';
  const avgScore = weightedSum / totalWeight;
  const roundedIndex = Math.round(avgScore);
  return TIER_NAMES[Math.min(roundedIndex, TIER_NAMES.length - 1)];
}

// ─── batch comparison ───

export async function batchCompareRenovations(pairs, concurrency = 2) {
  const results = [];
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(p =>
        comparePropertyPhotos(
          p.beforePhotos,
          p.afterPhotos,
          p.propertyId,
          p.beforeListingKey,
          p.afterListingKey
        )
      )
    );
    results.push(...batchResults);

    // Rate limit: small delay between batches
    if (i + concurrency < pairs.length) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  return results;
}
