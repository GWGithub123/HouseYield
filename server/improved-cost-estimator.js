/**
 * Improved Renovation Cost Estimator
 * 
 * Uses a multi-tiered approach:
 * 1. LOCAL DATABASE: Industry-standard costs with regional adjustments (PRIMARY)
 * 2. PROJECT TEMPLATES: Pre-calculated costs for common renovations
 * 3. WEB VALIDATION: Google search to validate/refine estimates (SECONDARY)
 * 4. CONTRACTOR MARKETPLACE: Use actual bid data for ground truth
 * 
 * This replaces the unreliable Google-search-first approach with
 * structured, accurate data that can be validated against web sources.
 */

import 'dotenv/config';
import {
  getRegionalMultiplier,
  getRegionalCostAdjustmentDetails,
  getLaborRate,
  getMaterialCost,
  getProjectCost,
  findProjectTemplate,
  PROJECT_TEMPLATES,
  LABOR_RATES,
  MATERIAL_COSTS
} from './cost-database.js';

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

/**
 * Main entry point: Get comprehensive cost estimate for a renovation project
 * 
 * @param {object} params - Project parameters
 * @param {string} params.projectType - Type of renovation (kitchen, bathroom, etc.)
 * @param {string} params.projectName - Specific name/description of project
 * @param {string} params.zipCode - 5-digit ZIP code
 * @param {object} params.scope - Size/scope parameters (sqft, linearFt, etc.)
 * @param {string} params.qualityLevel - budget, midRange, or luxury
 * @param {boolean} params.validateWithWeb - Whether to validate with Google search
 * @returns {Promise<object>} Comprehensive cost estimate
 */
export async function getComprehensiveCostEstimate(params) {
  const {
    projectType,
    projectName,
    zipCode,
    locationContext = null,
    scope = {},
    qualityLevel = 'midRange',
    validateWithWeb = true,
    measurements = null  // NEW: Real measurements from photoMeasurementService
  } = params;

  console.log(`[Improved Estimator] Estimating: ${projectName} in ${zipCode}`);
  console.log(`[Improved Estimator] Quality: ${qualityLevel}, Scope:`, scope);
  if (measurements) {
    console.log(`[Improved Estimator] Using REAL measurements:`, JSON.stringify(measurements).substring(0, 200));
  }

  const regionalPricing = getRegionalCostAdjustmentDetails(locationContext || zipCode);

  const result = {
    projectName,
    projectType,
    zipCode,
    qualityLevel,
    scope,
    regionalPricing,
    timestamp: new Date().toISOString()
  };

  try {
    // STEP 1: Try to find a matching project template
    const templateKey = findProjectTemplate(projectName, projectType);
    
    if (templateKey) {
      console.log(`[Improved Estimator] Found template: ${templateKey}`);

      if (shouldBypassTemplateForScopedProject({ templateKey, projectName, projectType, scope })) {
        console.log(`[Improved Estimator] Skipping broad template ${templateKey} for narrower scoped project`);
      } else {
      
      // Use real measurements if available, then user-provided scope, then estimate from description
      const estimatedScope = measurements 
        ? scopeFromMeasurements(measurements, projectType)
        : (hasExplicitScope(scope) ? scope : estimateScopeFromDescription(projectName, projectType));
      
      const templateCost = getProjectCost(templateKey, locationContext || zipCode, estimatedScope, qualityLevel);
      
      if (templateCost) {
        // Template gives aggregate totals but NO itemized materials/labor arrays.
        // Run component build too so we always have itemized breakdowns for the UI.
        let itemizedBreakdown = null;
        try {
          const effectiveScopeForItems = measurements 
            ? scopeFromMeasurements(measurements, projectType)
            : scope;
          itemizedBreakdown = await buildComponentEstimate(projectName, projectType, locationContext || zipCode, effectiveScopeForItems, qualityLevel, measurements);
          if (itemizedBreakdown) {
            console.log(`[Improved Estimator] ✓ Got itemized breakdown: ${itemizedBreakdown.materials?.length || 0} materials, ${itemizedBreakdown.labor?.length || 0} labor tasks`);
            
            // ── SANITY CAP: Clamp component-build cost to template range ──
            // The component build (especially GPT-generated breakdowns) can produce
            // wildly inflated totals. Use the template's cost range as the guardrail.
            // Allow up to 30% above template high-end for measurements that genuinely
            // exceed typical scope, but never more than that.
            const templateHigh = templateCost.costRange?.high ?? (templateCost.totalCost * 1.25);
            const sanityCap = Math.round(templateHigh * 1.3);
            if (itemizedBreakdown.totalCost > sanityCap) {
              const ratio = sanityCap / itemizedBreakdown.totalCost;
              console.warn(`[Improved Estimator] ⚠️ Component cost $${itemizedBreakdown.totalCost} exceeds sanity cap $${sanityCap} (template high $${templateHigh}). Scaling down ${Math.round(ratio * 100)}%`);
              // Scale all line items proportionally so the breakdown stays consistent
              if (itemizedBreakdown.materials) {
                itemizedBreakdown.materials = itemizedBreakdown.materials.map(m => ({
                  ...m,
                  totalCost: Math.round((m.totalCost || 0) * ratio),
                  costRange: m.costRange ? { low: Math.round(m.costRange.low * ratio), high: Math.round(m.costRange.high * ratio) } : undefined,
                }));
              }
              if (itemizedBreakdown.labor) {
                itemizedBreakdown.labor = itemizedBreakdown.labor.map(l => ({
                  ...l,
                  totalCost: Math.round((l.totalCost || 0) * ratio),
                  rateRange: l.rateRange ? { low: Math.round(l.rateRange.low * ratio), high: Math.round(l.rateRange.high * ratio) } : undefined,
                }));
              }
              itemizedBreakdown.totalCost = sanityCap;
              itemizedBreakdown.materialCost = Math.round((itemizedBreakdown.materialCost || 0) * ratio);
              itemizedBreakdown.laborCost = Math.round((itemizedBreakdown.laborCost || 0) * ratio);
              itemizedBreakdown.costRange = {
                low: Math.round(sanityCap * 0.80),
                high: sanityCap,
              };
              itemizedBreakdown.sanityCapped = true;
            }
          }
        } catch (e) {
          console.warn(`[Improved Estimator] Could not get itemized breakdown (non-critical):`, e.message);
        }

        const useMeasuredComponentTotals = itemizedBreakdown?.breakdownSource === 'photo_measured';
        result.primaryEstimate = {
          method: 'PROJECT_TEMPLATE',
          templateKey: templateKey,
          ...templateCost,
          ...(useMeasuredComponentTotals ? {
            totalCost: itemizedBreakdown.totalCost,
            laborCost: itemizedBreakdown.laborCost,
            materialCost: itemizedBreakdown.materialCost,
            laborPercent: itemizedBreakdown.laborPercent,
            timeline: itemizedBreakdown.timeline || templateCost.timeline,
            costRange: itemizedBreakdown.costRange || templateCost.costRange,
            source: itemizedBreakdown.source,
            measurementUncertainty: itemizedBreakdown.measurementUncertainty,
            templateBaseline: {
              totalCost: templateCost.totalCost,
              laborCost: templateCost.laborCost,
              materialCost: templateCost.materialCost,
              costRange: templateCost.costRange,
              timeline: templateCost.timeline,
              source: templateCost.source,
            },
          } : null),
          // Merge itemized arrays from component build (template doesn't have these)
          materials: itemizedBreakdown?.materials || null,
          labor: itemizedBreakdown?.labor || null,
          breakdownSource: itemizedBreakdown?.breakdownSource || 'template_aggregate',
        };
      }
      }
    }

    // STEP 2: If no template, build from materials + labor
    if (!result.primaryEstimate) {
      console.log(`[Improved Estimator] No template match, building from components...`);
      
      const effectiveScope = measurements 
        ? scopeFromMeasurements(measurements, projectType)
        : scope;
      const componentEstimate = await buildComponentEstimate(projectName, projectType, locationContext || zipCode, effectiveScope, qualityLevel, measurements);
      
      if (componentEstimate) {
        // ── SANITY CAP for template-less estimates ──
        // Even when no template matched, use type-based max costs to prevent runaway estimates.
        // These are generous upper bounds (luxury + large scope + high-cost region).
        const TYPE_MAX_COSTS = {
          'kitchen': 80000, 'kitchen_update': 65000, 'kitchen_refresh': 50000,
          'bathroom': 45000, 'bathroom_update': 35000, 'bathroom_master': 45000,
          'flooring': 30000, 'paint': 15000, 'paint_interior': 12000, 'paint_exterior': 25000,
          'hvac': 25000, 'roof': 35000, 'windows': 25000, 'deck': 40000, 'landscaping': 25000,
          'basement': 60000, 'addition': 200000, 'siding': 25000,
        };
        const typeKey = (projectType || '').toLowerCase().replace(/[\s-]+/g, '_');
        const maxCost = TYPE_MAX_COSTS[typeKey] || TYPE_MAX_COSTS[typeKey.split('_')[0]] || 100000;
        const regionalMult = getRegionalMultiplier(locationContext || zipCode);
        const adjustedMax = Math.round(maxCost * regionalMult * 1.2);  // 20% buffer for regional extremes
        
        if (componentEstimate.totalCost > adjustedMax) {
          const ratio = adjustedMax / componentEstimate.totalCost;
          console.warn(`[Improved Estimator] ⚠️ Component cost $${componentEstimate.totalCost} exceeds type max $${adjustedMax} for "${typeKey}". Clamping.`);
          componentEstimate.totalCost = adjustedMax;
          componentEstimate.materialCost = Math.round((componentEstimate.materialCost || 0) * ratio);
          componentEstimate.laborCost = Math.round((componentEstimate.laborCost || 0) * ratio);
          if (componentEstimate.materials) {
            componentEstimate.materials = componentEstimate.materials.map(m => ({
              ...m,
              totalCost: Math.round((m.totalCost || 0) * ratio),
            }));
          }
          if (componentEstimate.labor) {
            componentEstimate.labor = componentEstimate.labor.map(l => ({
              ...l,
              totalCost: Math.round((l.totalCost || 0) * ratio),
            }));
          }
          componentEstimate.costRange = {
            low: Math.round(adjustedMax * 0.75),
            high: adjustedMax,
          };
          componentEstimate.sanityCapped = true;
        }
        
        result.primaryEstimate = {
          method: 'COMPONENT_BUILD',
          ...componentEstimate
        };
      }
    }

    // STEP 3: Validate with web search (optional)
    if (validateWithWeb && GOOGLE_API_KEY && GOOGLE_CSE_CX) {
      console.log(`[Improved Estimator] Validating with web search...`);
      
      const webValidation = await validateWithWebSearch(projectName, zipCode);
      
      if (webValidation.ok) {
        result.webValidation = webValidation;
        
        // Compare and adjust if there's a significant discrepancy
        if (result.primaryEstimate && webValidation.avgEstimate > 0) {
          const primaryCost = result.primaryEstimate.totalCost;
          const webCost = webValidation.avgEstimate;
          const discrepancy = Math.abs(primaryCost - webCost) / primaryCost;
          
          if (discrepancy > 0.40) {
            // More than 40% difference - take a weighted average
            const blendedCost = Math.round(primaryCost * 0.6 + webCost * 0.4);
            result.adjustedEstimate = {
              totalCost: blendedCost,
              reason: `Blended with web data (${Math.round(discrepancy * 100)}% discrepancy)`,
              originalCost: primaryCost,
              webCost: webCost
            };
            result.primaryEstimate.totalCost = blendedCost;
            result.primaryEstimate.costRange = {
              low: Math.round(blendedCost * 0.80),
              high: Math.round(blendedCost * 1.20)
            };
          }
          
          result.webValidation.discrepancyPercent = Math.round(discrepancy * 100);
        }
      }
    }

    // STEP 4: Add confidence scoring
    result.confidence = calculateConfidence(result);

    // STEP 5: Format final output
    if (result.primaryEstimate) {
      return {
        ok: true,
        ...result,
        summary: {
          totalCost: result.primaryEstimate.totalCost,
          costRange: result.primaryEstimate.costRange,
          laborCost: result.primaryEstimate.laborCost,
          materialCost: result.primaryEstimate.materialCost,
          timeline: result.primaryEstimate.timeline,
          confidence: result.confidence,
          regionalPricing: result.regionalPricing
        }
      };
    } else {
      return {
        ok: false,
        error: 'Could not generate estimate',
        ...result
      };
    }

  } catch (error) {
    console.error('[Improved Estimator] Error:', error);
    return {
      ok: false,
      error: error.message,
      ...result
    };
  }
}

/**
 * Build a cost estimate from individual components (materials + labor).
 * 
 * When real measurements are available (from photoMeasurementService),
 * we use the pre-calculated material/labor items DIRECTLY instead of
 * relying on GPT-4o-mini to guess quantities. This produces accurate,
 * measurement-backed breakdowns.
 */
async function buildComponentEstimate(projectName, projectType, zipCode, scope, qualityLevel, measurements = null, budgetGuidance = null) {
  let materialsList = [];
  let laborList = [];
  let estimatedTimeline = 'TBD';
  let breakdownSource = 'gpt_estimated';

  // PRIORITY: Use measured materials/labor directly when available
  if (measurements?.measuredMaterials?.length > 0 || measurements?.measuredLabor?.length > 0) {
    console.log(`[Improved Estimator] Using MEASURED breakdown: ${measurements.measuredMaterials?.length || 0} materials, ${measurements.measuredLabor?.length || 0} labor tasks`);
    materialsList = (measurements.measuredMaterials || []).map(m => ({
      item: m.item,
      quantity: m.quantity,
      unit: m.unit,
      category: m.category,
      dbKey: m.dbKey,
      fallbackCost: m.fallbackCost,
      wastePercent: m.wastePercent,
      coverageSqFt: m.coverageSqFt,
      room: m.room,
    }));
    laborList = (measurements.measuredLabor || []).map(l => ({
      task: l.task,
      tradeType: l.tradeType || l.rateKey,
      estimatedHours: l.estimatedHours,
      rateKey: l.rateKey,
      room: l.room,
    }));
    breakdownSource = 'photo_measured';

    // Estimate timeline from labor hours
    const totalHours = laborList.reduce((s, l) => s + (l.estimatedHours || 0), 0);
    const workDays = Math.ceil(totalHours / 8);
    estimatedTimeline = workDays <= 2 ? `${workDays} day${workDays > 1 ? 's' : ''}` : workDays <= 10 ? `${Math.ceil(workDays / 5)} week${workDays > 5 ? 's' : ''}` : `${Math.ceil(workDays / 5)} weeks`;
  } else {
    // Fallback: Use GPT-4o-mini to break down the project
    const breakdown = await generateProjectBreakdown(projectName, projectType, scope, measurements);
    if (!breakdown.ok) return null;
    materialsList = breakdown.materials || [];
    laborList = breakdown.laborItems || [];
    estimatedTimeline = breakdown.estimatedTimeline || 'TBD';
  }

  let totalMaterialCost = 0;
  let totalLaborCost = 0;
  const materialDetails = [];
  const laborDetails = [];

  // Price each material from our database
  for (const material of materialsList) {
    const priced = priceMaterialFromDatabase(material, zipCode, qualityLevel);
    if (priced) {
      totalMaterialCost += priced.totalCost;
      materialDetails.push(priced);
    }
  }

  // Price each labor item from our database
  for (const labor of laborList) {
    const priced = priceLaborFromDatabase(labor, zipCode);
    if (priced) {
      totalLaborCost += priced.totalCost;
      laborDetails.push(priced);
    }
  }

  const totalCost = totalMaterialCost + totalLaborCost;

  // Uncertainty-aware range widening for room-envelope measurements.
  // When measurement confidence is lower, we widen the low/high envelope.
  const measuredUncertainty = Math.max(0, Math.min(0.45, Number(measurements?.uncertainty?.percent || 0)));
  const measuredConfidence = measurements?.confidence || null;

  const materialLow = materialDetails.reduce((s, m) => s + (m.costRange?.low ?? Math.round((m.totalCost || 0) * 0.85)), 0);
  const materialHigh = materialDetails.reduce((s, m) => s + (m.costRange?.high ?? Math.round((m.totalCost || 0) * 1.15)), 0);
  const laborLow = laborDetails.reduce((s, l) => s + (l.rateRange?.low ?? Math.round((l.totalCost || 0) * 0.85)), 0);
  const laborHigh = laborDetails.reduce((s, l) => s + (l.rateRange?.high ?? Math.round((l.totalCost || 0) * 1.15)), 0);

  let lowMult = 0.85;
  let highMult = 1.15;
  if (measuredConfidence === 'low') {
    lowMult = 0.72;
    highMult = 1.32;
  } else if (measuredConfidence === 'medium') {
    lowMult = 0.80;
    highMult = 1.22;
  }

  const uncertaintyLowAdj = Math.max(0.5, lowMult - measuredUncertainty * 0.35);
  const uncertaintyHighAdj = highMult + measuredUncertainty * 0.55;
  const rangeLow = Math.round((materialLow + laborLow) * uncertaintyLowAdj / 0.85);
  const rangeHigh = Math.round((materialHigh + laborHigh) * uncertaintyHighAdj / 1.15);

  return {
    totalCost: Math.round(totalCost),
    laborCost: Math.round(totalLaborCost),
    materialCost: Math.round(totalMaterialCost),
    laborPercent: totalCost > 0 ? Math.round((totalLaborCost / totalCost) * 100) : 0,
    materials: materialDetails,
    labor: laborDetails,
    timeline: estimatedTimeline,
    costRange: {
      low: Math.max(0, rangeLow || Math.round(totalCost * 0.85)),
      high: Math.max(0, rangeHigh || Math.round(totalCost * 1.15))
    },
    source: breakdownSource === 'photo_measured' ? 'HouseYield Measured Breakdown' : 'HouseYield Component Database',
    breakdownSource,
    measurementUncertainty: measuredUncertainty,
  };
}

/**
 * Price a material item using our database.
 * When items come from the measurement service, they include a `dbKey` 
 * for direct database lookup and `fallbackCost` for items not in the DB.
 */
function priceMaterialFromDatabase(material, zipCode, qualityLevel = 'midRange') {
  const { item, quantity, unit, category, dbKey, fallbackCost } = material;
  const normalizedItem = item.toLowerCase().replace(/\s+/g, '_');
  const normalizedCategory = category?.toLowerCase() || guessCategory(item);
  const multiplier = getRegionalMultiplier(zipCode, 'material');
  const qualityMult = qualityLevel === 'budget' ? 0.7 : qualityLevel === 'luxury' ? 1.5 : 1.0;
  
  // PRIORITY 1: Direct dbKey lookup (from measurement service)
  if (dbKey) {
    const categoryData = MATERIAL_COSTS[normalizedCategory];
    if (categoryData && categoryData[dbKey]) {
      const match = categoryData[dbKey];
      const unitCost = (match.avg || 0) * multiplier * qualityMult;
      return {
        item,
        quantity,
        unit,
        unitCost: Math.round(unitCost * 100) / 100,
        totalCost: Math.round(unitCost * quantity),
        matchedTo: dbKey,
        matchScore: 100,
        source: 'HouseYield Database (direct match)',
        confidence: 'high',
        room: material.room,
        costRange: {
          low: Math.round(match.low * multiplier * quantity),
          high: Math.round(match.high * multiplier * quantity),
        },
      };
    }
    // Try searching all categories for the dbKey
    for (const [cat, catData] of Object.entries(MATERIAL_COSTS)) {
      if (catData[dbKey]) {
        const match = catData[dbKey];
        const unitCost = (match.avg || 0) * multiplier * qualityMult;
        return {
          item, quantity, unit,
          unitCost: Math.round(unitCost * 100) / 100,
          totalCost: Math.round(unitCost * quantity),
          matchedTo: dbKey,
          matchScore: 95,
          source: 'HouseYield Database (cross-category)',
          confidence: 'high',
          room: material.room,
          costRange: {
            low: Math.round(match.low * multiplier * quantity),
            high: Math.round(match.high * multiplier * quantity),
          },
        };
      }
    }
  }

  // PRIORITY 2: Fuzzy match by item name
  const categoryData = MATERIAL_COSTS[normalizedCategory];
  if (categoryData) {
    let bestMatch = null;
    let bestScore = 0;
    
    for (const [key, value] of Object.entries(categoryData)) {
      const score = calculateMatchScore(normalizedItem, key);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { key, ...value };
      }
    }
    
    if (bestMatch && bestScore > 0.3) {
      const unitCost = (bestMatch.avg || 0) * multiplier * qualityMult;
      return {
        item, quantity, unit,
        unitCost: Math.round(unitCost * 100) / 100,
        totalCost: Math.round(unitCost * quantity),
        matchedTo: bestMatch.key,
        matchScore: Math.round(bestScore * 100),
        source: 'HouseYield Database',
        confidence: bestScore > 0.7 ? 'high' : bestScore > 0.5 ? 'medium' : 'low',
        room: material.room,
        costRange: {
          low: Math.round(bestMatch.low * multiplier * quantity),
          high: Math.round(bestMatch.high * multiplier * quantity),
        },
      };
    }
  }
  
  // PRIORITY 3: Use measurement-provided fallback cost
  if (fallbackCost && fallbackCost > 0) {
    const adjustedCost = fallbackCost * multiplier;
    return {
      item, quantity, unit,
      unitCost: Math.round(adjustedCost * 100) / 100,
      totalCost: Math.round(adjustedCost * quantity),
      source: 'Measurement Service Estimate',
      confidence: 'medium',
      room: material.room,
    };
  }
  
  // PRIORITY 4: Generic fallback
  const genericCost = estimateFallbackMaterialCost(item, unit, zipCode);
  return {
    item, quantity, unit,
    unitCost: genericCost,
    totalCost: Math.round(genericCost * quantity),
    source: 'Industry Average Estimate',
    confidence: 'low',
    room: material.room,
  };
}

/**
 * Price a labor item using our database.
 * When items come from the measurement service, they include a `rateKey`
 * for direct lookup in LABOR_RATES.
 */
function priceLaborFromDatabase(labor, zipCode) {
  const { task, tradeType, estimatedHours, rateKey } = labor;
  const lookupKey = (rateKey || tradeType || 'general_labor').toLowerCase().replace(/\s+/g, '_');
  
  const trade = LABOR_RATES[lookupKey] || LABOR_RATES[tradeType?.toLowerCase().replace(/\s+/g, '_')] || LABOR_RATES['general_labor'];
  const multiplier = getRegionalMultiplier(zipCode, 'labor');
  const hourlyRate = Math.round(trade.avg * multiplier);
  
  return {
    task,
    tradeType: lookupKey,
    hours: estimatedHours,
    hourlyRate,
    totalCost: Math.round(hourlyRate * estimatedHours),
    source: 'HouseYield Labor Database',
    confidence: LABOR_RATES[lookupKey] ? 'high' : 'medium',
    room: labor.room,
    rateRange: {
      low: Math.round(trade.low * multiplier * estimatedHours),
      high: Math.round(trade.high * multiplier * estimatedHours),
    },
  };
}

/**
 * Use GPT to break down a project into materials and labor
 */
async function generateProjectBreakdown(projectName, projectType, scope, measurements = null) {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'OpenAI API not configured' };
  }

  // Build measurement context if we have real measurements from photos
  let measurementContext = '';
  if (measurements) {
    const dims = measurements.roomDimensions;
    const matQ = measurements.materialQuantities;
    const objs = measurements.objectMeasurements;
    
    if (dims) {
      measurementContext += `\n\nREAL ROOM MEASUREMENTS (from photo analysis — use these exact dimensions):\n`;
      measurementContext += `- Room size: ${dims.widthFt}' × ${dims.lengthFt}' (${dims.floorAreaSqFt} sq ft floor)\n`;
      measurementContext += `- Wall area: ${dims.wallAreaSqFt} sq ft\n`;
      measurementContext += `- Perimeter: ${dims.perimeterFt} linear ft\n`;
      measurementContext += `- Ceiling height: ${dims.heightFt}'\n`;
    }
    if (matQ && Object.keys(matQ).length > 0) {
      measurementContext += `\nPRE-CALCULATED MATERIAL QUANTITIES (use these exact quantities):\n`;
      for (const [key, val] of Object.entries(matQ)) {
        measurementContext += `- ${val.label || key}: ${val.quantity} ${val.unit}\n`;
      }
    }
    if (objs && objs.length > 0) {
      measurementContext += `\nMEASURED OBJECTS:\n`;
      for (const obj of objs) {
        measurementContext += `- ${obj.description || obj.type}: ${obj.dimensions?.widthInches}"W × ${obj.dimensions?.heightInches}"H\n`;
        if (obj.applianceFit) {
          measurementContext += `  → Recommended size: ${obj.applianceFit.recommendedSize}" (${obj.applianceFit.note})\n`;
        }
      }
    }
    measurementContext += `\nIMPORTANT: Use the measured dimensions above for all quantity calculations. Do NOT estimate room size — it has been measured from photos.`;
  }

  const prompt = `Break down this renovation project into specific materials and labor tasks.

Project: ${projectName}
Type: ${projectType}
Scope: ${JSON.stringify(scope)}${measurementContext}

Return a JSON object with:
{
  "materials": [
    {
      "item": "Specific material name (e.g., 'LVP flooring 7mm')",
      "quantity": number,
      "unit": "sq_ft | linear_ft | each | gallon | bag",
      "category": "flooring | countertops | cabinets | appliances | plumbing | tile | paint | lighting | windows | roofing | hvac | landscaping | electrical | insulation"
    }
  ],
  "laborItems": [
    {
      "task": "Description of task",
      "tradeType": "carpenter | plumber | electrician | painter | tile_setter | flooring_installer | hvac_technician | roofer | landscaper | general_labor | cabinet_installer | countertop_installer",
      "estimatedHours": number
    }
  ],
  "estimatedTimeline": "X days/weeks"
}

Be specific with quantities. Add 10% waste factor for materials.`;

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
            content: 'You are a construction estimator. Return only valid JSON with material and labor breakdowns.' 
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1500,
        temperature: 0.2
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
 * Validate our estimate against web search results
 */
async function validateWithWebSearch(projectName, zipCode) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
    return { ok: false, error: 'Google Search not configured' };
  }

  const searchQuery = `"${projectName}" cost ${zipCode} 2025 average price`;
  
  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_CX);
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('num', 5);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return { ok: false, error: 'No search results' };
    }

    // Extract costs from snippets using GPT
    const snippets = data.items.map(r => `${r.title}\n${r.snippet}`).join('\n\n');
    
    const extractPrompt = `Extract cost estimates from these search results for: ${projectName}

${snippets}

Return JSON:
{
  "lowEstimate": number or 0 if not found,
  "avgEstimate": number or 0 if not found,
  "highEstimate": number or 0 if not found,
  "confidence": "high" | "medium" | "low" | "none",
  "sources": ["source1", "source2"]
}`;

    const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Extract cost data from search results. Return only JSON.' },
          { role: 'user', content: extractPrompt }
        ],
        max_tokens: 300,
        temperature: 0.1
      })
    });

    const gptResult = await gptResponse.json();
    const content = gptResult.choices?.[0]?.message?.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const costData = JSON.parse(jsonMatch[0]);
      return {
        ok: true,
        ...costData,
        searchQuery,
        resultCount: data.items.length
      };
    }

    return { ok: false, error: 'Failed to extract costs' };

  } catch (error) {
    console.error('[Web Validation] Error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Estimate scope from project description
 */
/**
 * Convert photo measurements into scope parameters for the cost estimator.
 * This replaces guessing with real measured values.
 */
function scopeFromMeasurements(measurements, projectType) {
  const dims = measurements.roomDimensions;
  const matQ = measurements.materialQuantities;
  
  if (!dims) {
    return { sqft: 100 }; // fallback
  }

  const scope = {
    sqft: dims.floorAreaSqFt,
    wallSqft: dims.wallAreaSqFt,
    linearFt: dims.perimeterFt,
    ceilingHeight: dims.heightFt,
    measured: true,  // Flag that these are real measurements
  };

  // Add specific material quantities if pre-calculated
  if (matQ) {
    for (const [key, val] of Object.entries(matQ)) {
      scope[`qty_${key}`] = val.quantity;
    }
  }

  // Add object measurements if available
  if (measurements.objectMeasurements) {
    scope.objectMeasurements = measurements.objectMeasurements;
  }

  console.log(`[Improved Estimator] Scope from measurements: ${dims.floorAreaSqFt} sq ft, ${dims.wallAreaSqFt} wall sq ft, ${dims.perimeterFt} linear ft`);
  return scope;
}

function hasExplicitScope(scope) {
  if (!scope || typeof scope !== 'object') {
    return false;
  }

  return Object.values(scope).some((value) => {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0;
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    if (value && typeof value === 'object') {
      return Object.keys(value).length > 0;
    }

    return Boolean(value);
  });
}

function getScopeLabel(scope) {
  if (!scope) return null;
  if (typeof scope === 'string') return scope.toLowerCase();
  if (typeof scope === 'object') {
    const label = scope.label || scope.requestedScope || scope.scopeLabel || null;
    return typeof label === 'string' ? label.toLowerCase() : null;
  }
  return null;
}

function shouldBypassTemplateForScopedProject({ templateKey, projectName, projectType, scope }) {
  if (!['bathroom_full_remodel', 'kitchen_full_remodel'].includes(templateKey)) {
    return false;
  }

  const scopeLabel = getScopeLabel(scope);
  if (scopeLabel && ['full_remodel', 'gut_reno'].includes(scopeLabel)) {
    return false;
  }
  if (scopeLabel && ['cosmetic', 'refresh'].includes(scopeLabel)) {
    return true;
  }

  const text = `${projectName || ''} ${projectType || ''}`.toLowerCase();
  const strongRemodelSignals = ['full remodel', 'full renovation', 'gut reno', 'gut renovation', 'complete bath', 'complete kitchen'];
  const narrowScopeSignals = ['vanity', 'mirror', 'toilet', 'faucet', 'sink', 'fixture', 'lighting', 'light', 'exhaust', 'countertop', 'backsplash', 'window', 'door'];

  return narrowScopeSignals.some((signal) => text.includes(signal))
    && !strongRemodelSignals.some((signal) => text.includes(signal));
}

function estimateScopeFromDescription(projectName, projectType) {
  const name = projectName.toLowerCase();
  
  // Try to extract numbers from the description
  const sqftMatch = name.match(/(\d+)\s*(?:sq\s*ft|square\s*feet)/);
  const lfMatch = name.match(/(\d+)\s*(?:linear\s*feet|lf|lin\s*ft)/);
  const countMatch = name.match(/(\d+)\s*(?:window|door|room|toilet)/);
  
  if (sqftMatch) {
    return { sqft: parseInt(sqftMatch[1]) };
  }
  if (lfMatch) {
    return { linearFt: parseInt(lfMatch[1]) };
  }
  if (countMatch) {
    return { count: parseInt(countMatch[1]) };
  }
  
  // Default estimates by project type
  const defaultScopes = {
    'kitchen': { sqft: 120 },
    'bathroom': { sqft: 50 },
    'flooring': { sqft: 400 },
    'paint': { sqft: 200 },
    'deck': { sqft: 250 },
    'fence': { linearFt: 150 },
    'roof': { sqft: 2000 },
    'window': { windows: 8 }
  };
  
  const type = projectType?.toLowerCase() || '';
  for (const [key, scope] of Object.entries(defaultScopes)) {
    if (type.includes(key) || name.includes(key)) {
      return scope;
    }
  }
  
  return { sqft: 100 };
}

/**
 * Guess material category from item name
 */
function guessCategory(itemName) {
  const name = itemName.toLowerCase();
  const categoryKeywords = {
    'flooring': ['floor', 'lvp', 'hardwood', 'laminate', 'carpet', 'tile floor'],
    'countertops': ['counter', 'granite', 'quartz', 'marble', 'butcher block'],
    'cabinets': ['cabinet', 'drawer', 'cupboard'],
    'appliances': ['refrigerator', 'fridge', 'range', 'stove', 'oven', 'dishwasher', 'microwave', 'washer', 'dryer'],
    'plumbing': ['sink', 'faucet', 'toilet', 'tub', 'shower', 'water heater'],
    'tile': ['tile', 'backsplash', 'subway', 'mosaic'],
    'paint': ['paint', 'primer', 'drywall', 'wallpaper'],
    'lighting': ['light', 'fixture', 'chandelier', 'fan', 'switch', 'outlet'],
    'windows': ['window', 'door', 'glass'],
    'roofing': ['shingle', 'roof', 'underlayment', 'flashing'],
    'hvac': ['furnace', 'ac', 'air condition', 'heat pump', 'thermostat'],
    'landscaping': ['sod', 'mulch', 'gravel', 'paver', 'deck', 'fence']
  };
  
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some(kw => name.includes(kw))) {
      return category;
    }
  }
  
  return 'general';
}

/**
 * Calculate match score between two strings
 */
function calculateMatchScore(str1, str2) {
  const words1 = str1.split(/[_\s]+/);
  const words2 = str2.split(/[_\s]+/);
  
  let matches = 0;
  for (const w1 of words1) {
    for (const w2 of words2) {
      if (w1.includes(w2) || w2.includes(w1)) {
        matches++;
      }
    }
  }
  
  return matches / Math.max(words1.length, words2.length);
}

/**
 * Fallback material cost estimation
 */
function estimateFallbackMaterialCost(item, unit, zipCode) {
  const multiplier = getRegionalMultiplier(zipCode, 'material');
  
  // Generic cost estimates by unit
  const unitDefaults = {
    'sq_ft': 5,
    'linear_ft': 10,
    'each': 50,
    'gallon': 40,
    'bag': 25,
    'sheet': 15,
    'roll': 40
  };
  
  return Math.round((unitDefaults[unit] || 20) * multiplier);
}

/**
 * Calculate overall confidence score
 */
function calculateConfidence(result) {
  let score = 50; // Base score
  
  if (result.primaryEstimate?.method === 'PROJECT_TEMPLATE') {
    score += 30; // Template match is high confidence
  } else if (result.primaryEstimate?.method === 'COMPONENT_BUILD') {
    score += 15;
    // Photo-measured breakdowns are higher confidence than GPT-estimated
    if (result.primaryEstimate.breakdownSource === 'photo_measured') {
      score += 20; // Measured quantities → direct DB pricing = high confidence
    }
  }
  
  if (result.webValidation?.ok) {
    score += 10;
    if (result.webValidation.discrepancyPercent < 20) {
      score += 15; // Web validates our estimate
    } else if (result.webValidation.discrepancyPercent > 40) {
      score -= 10; // Significant discrepancy
    }
  }
  
  return {
    score: Math.min(100, Math.max(0, score)),
    level: score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low'
  };
}

/**
 * Quick estimate using just the project template
 * For cases where we need fast results without web validation
 */
export function getQuickEstimate(projectName, projectType, zipCode, qualityLevel = 'midRange') {
  const templateKey = findProjectTemplate(projectName, projectType);
  
  if (templateKey) {
    const scope = estimateScopeFromDescription(projectName, projectType);
    const estimate = getProjectCost(templateKey, zipCode, scope, qualityLevel);
    
    if (estimate) {
      return {
        ok: true,
        ...estimate,
        method: 'QUICK_TEMPLATE',
        confidence: 'high'
      };
    }
  }
  
  // Fallback: rough estimate
  const multiplier = getRegionalMultiplier(zipCode);
  const baseEstimates = {
    'kitchen': 35000,
    'bathroom': 15000,
    'flooring': 5000,
    'paint': 2000,
    'roof': 12000,
    'hvac': 8000,
    'window': 5000,
    'landscaping': 8000
  };
  
  const type = projectType?.toLowerCase() || '';
  for (const [key, baseCost] of Object.entries(baseEstimates)) {
    if (type.includes(key) || projectName.toLowerCase().includes(key)) {
      const adjustedCost = Math.round(baseCost * multiplier);
      return {
        ok: true,
        totalCost: adjustedCost,
        costRange: {
          low: Math.round(adjustedCost * 0.7),
          high: Math.round(adjustedCost * 1.3)
        },
        method: 'ROUGH_ESTIMATE',
        confidence: 'low'
      };
    }
  }
  
  return {
    ok: false,
    error: 'Could not generate estimate'
  };
}

export default {
  getComprehensiveCostEstimate,
  getQuickEstimate
};
