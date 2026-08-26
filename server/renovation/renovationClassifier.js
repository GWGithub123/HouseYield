/**
 * Renovation Classifier — 3-Signal Detection Engine
 * 
 * Replaces GPT-4o Vision for STATISTICAL pair analysis (not individual property evaluation).
 * Detects renovations using three signals:
 *   A) MLS description keyword parsing (60+ regex patterns)
 *   B) Property features / yearBuilt age-mismatch detection
 *   C) Price history pattern analysis (holding period, jump magnitude, rental gap, $/sqft)
 * 
 * Combined score = keyword_score × 0.5 + price_pattern_score × 0.3 + feature_age_mismatch × 0.2
 * 
 * Threshold:
 *   > 0.7  → high confidence renovation
 *   0.4–0.7 → medium confidence
 *   < 0.4  → likely market appreciation only (exclude)
 */

// ============================================================================
// SIGNAL A: MLS DESCRIPTION KEYWORD PARSING
// ============================================================================

/**
 * Keyword patterns grouped by renovation category.
 * Each entry: [regex, displayName, subCategory, specificityWeight]
 * specificityWeight: 0.3 = vague ("updated"), 0.7 = specific ("quartz countertops"), 1.0 = definitive ("gut renovation")
 */
const KEYWORD_PATTERNS = {
  kitchen: [
    [/(?:new|remodel(?:ed)?|updated|renovated|modern)\s*kitchen/i, 'kitchen remodel', 'kitchen', 0.8],
    [/kitchen\s*(?:remodel|renovation|update|upgrade)/i, 'kitchen remodel', 'kitchen', 0.8],
    [/quartz\s*counter/i, 'quartz countertops', 'kitchen', 0.7],
    [/granite\s*counter/i, 'granite countertops', 'kitchen', 0.7],
    [/quartzite\s*counter/i, 'quartzite countertops', 'kitchen', 0.7],
    [/marble\s*counter/i, 'marble countertops', 'kitchen', 0.7],
    [/butcher\s*block\s*counter/i, 'butcher block counters', 'kitchen', 0.6],
    [/new\s*(?:stainless|ss)\s*(?:steel\s*)?appli/i, 'new stainless appliances', 'kitchen', 0.7],
    [/stainless\s*(?:steel\s*)?appli/i, 'stainless appliances', 'kitchen', 0.5],
    [/custom\s*cabinet/i, 'custom cabinets', 'kitchen', 0.7],
    [/shaker\s*cabinet/i, 'shaker cabinets', 'kitchen', 0.6],
    [/new\s*cabinet/i, 'new cabinets', 'kitchen', 0.7],
    [/soft[\s-]*close/i, 'soft-close cabinets', 'kitchen', 0.5],
    [/42[\s"]*(?:inch|in)?\s*(?:upper\s*)?cabinet/i, '42" cabinets', 'kitchen', 0.6],
    [/subway\s*tile/i, 'subway tile backsplash', 'kitchen', 0.5],
    [/(?:new|upgraded)\s*backsplash/i, 'new backsplash', 'kitchen', 0.6],
    [/under(?:mount|counter)\s*sink/i, 'undermount sink', 'kitchen', 0.5],
    [/farm(?:house)?\s*sink/i, 'farmhouse sink', 'kitchen', 0.5],
    [/waterfall\s*(?:island|counter|edge)/i, 'waterfall island', 'kitchen', 0.7],
    [/kitchen\s*island/i, 'kitchen island', 'kitchen', 0.4],
    [/pot\s*filler/i, 'pot filler faucet', 'kitchen', 0.6],
    [/wolf|sub[\s-]*zero|thermador|viking|miele|bosch/i, 'pro-grade appliances', 'kitchen', 0.7],
    [/panel[\s-]*ready\s*appli/i, 'panel-ready appliances', 'kitchen', 0.7],
  ],

  bathroom: [
    [/(?:new|remodel(?:ed)?|updated|renovated|modern)\s*bath/i, 'bathroom remodel', 'bathroom', 0.8],
    [/bath(?:room)?\s*(?:remodel|renovation|update|upgrade)/i, 'bathroom remodel', 'bathroom', 0.8],
    [/(?:new|updated)\s*vanit(?:y|ies)/i, 'new vanity', 'bathroom', 0.7],
    [/(?:new|updated)\s*(?:tile\s*)?shower/i, 'new shower', 'bathroom', 0.7],
    [/frameless\s*(?:glass\s*)?shower/i, 'frameless glass shower', 'bathroom', 0.7],
    [/rain(?:fall)?\s*shower/i, 'rainfall showerhead', 'bathroom', 0.6],
    [/free[\s-]*standing\s*(?:soak(?:ing)?\s*)?tub/i, 'freestanding tub', 'bathroom', 0.7],
    [/vessel\s*sink/i, 'vessel sink', 'bathroom', 0.5],
    [/dual\s*vanit/i, 'dual vanity', 'bathroom', 0.5],
    [/(?:new|updated)\s*(?:bath(?:room)?\s*)?(?:tile|tiling)/i, 'new bathroom tile', 'bathroom', 0.6],
    [/heated\s*(?:bath(?:room)?\s*)?floor/i, 'heated floors', 'bathroom', 0.6],
    [/master\s*(?:bath|suite)\s*(?:remodel|renovat|updat|upgrad)/i, 'master bath remodel', 'bathroom', 0.8],
    [/(?:new|updated)\s*(?:bath(?:room)?\s*)?fixture/i, 'new bath fixtures', 'bathroom', 0.5],
    [/matte\s*black\s*(?:fix|hard)/i, 'matte black fixtures', 'bathroom', 0.5],
    [/brushed\s*(?:nickel|gold)\s*(?:fix|hard)/i, 'brushed nickel/gold fixtures', 'bathroom', 0.5],
  ],

  flooring: [
    [/(?:new|refinish(?:ed)?)\s*hardwood/i, 'refinished hardwood', 'flooring', 0.7],
    [/solid\s*hardwood\s*floor/i, 'solid hardwood floors', 'flooring', 0.7],
    [/engineered\s*hardwood/i, 'engineered hardwood', 'flooring', 0.6],
    [/(?:lvp|luxury\s*vinyl\s*plank)/i, 'LVP flooring', 'flooring', 0.6],
    [/(?:lvt|luxury\s*vinyl\s*tile)/i, 'LVT flooring', 'flooring', 0.6],
    [/(?:new|updated)\s*(?:flooring|floors)/i, 'new flooring', 'flooring', 0.6],
    [/(?:new|updated)\s*carpet/i, 'new carpet', 'flooring', 0.5],
    [/porcelain\s*(?:tile\s*)?floor/i, 'porcelain tile flooring', 'flooring', 0.5],
    [/laminate\s*floor/i, 'laminate flooring', 'flooring', 0.4],
    [/travertine\s*floor/i, 'travertine flooring', 'flooring', 0.6],
    [/(?:tile|wood|plank)\s*(?:flooring|floors)\s*throughout/i, 'flooring throughout', 'flooring', 0.6],
    [/hardwood\s*(?:floors?|flooring)\s*throughout/i, 'hardwood throughout', 'flooring', 0.7],
  ],

  paint_cosmetic: [
    [/fresh(?:ly)?\s*paint/i, 'fresh paint', 'paint_interior', 0.5],
    [/(?:new|updated)\s*paint/i, 'new paint', 'paint_interior', 0.5],
    [/newly\s*painted/i, 'newly painted', 'paint_interior', 0.5],
    [/(?:new|updated)\s*(?:light\s*)?fixture/i, 'new fixtures', 'paint_interior', 0.4],
    [/(?:new|updated)\s*lighting/i, 'updated lighting', 'paint_interior', 0.4],
    [/recessed\s*light/i, 'recessed lighting', 'paint_interior', 0.4],
    [/(?:new|updated)\s*(?:door\s*)?hardware/i, 'new hardware', 'paint_interior', 0.3],
    [/crown\s*molding/i, 'crown molding', 'paint_interior', 0.4],
    [/(?:new|updated)\s*(?:base|trim)\s*(?:board|molding)/i, 'new trim/baseboards', 'paint_interior', 0.4],
    [/accent\s*wall/i, 'accent wall', 'paint_interior', 0.3],
    [/shiplap/i, 'shiplap', 'paint_interior', 0.5],
    [/wainscot/i, 'wainscoting', 'paint_interior', 0.4],
  ],

  roof_exterior: [
    [/new\s*roof/i, 'new roof', 'roof', 0.8],
    [/(?:new|replaced)\s*(?:asphalt\s*)?shingle/i, 'new shingles', 'roof', 0.7],
    [/standing\s*seam\s*(?:metal\s*)?roof/i, 'standing seam metal roof', 'roof', 0.7],
    [/architectural\s*shingle/i, 'architectural shingles', 'roof', 0.6],
    [/new\s*siding/i, 'new siding', 'siding', 0.7],
    [/(?:james\s*)?hardie|fiber\s*cement\s*siding/i, 'fiber cement siding', 'siding', 0.7],
    [/vinyl\s*siding/i, 'vinyl siding', 'siding', 0.5],
    [/new\s*(?:replacement\s*)?windows/i, 'new windows', 'windows', 0.7],
    [/(?:double|triple)[\s-]*pane\s*window/i, 'insulated windows', 'windows', 0.6],
    [/impact[\s-]*(?:resistant\s*)?window/i, 'impact windows', 'windows', 0.7],
    [/new\s*(?:exterior\s*)?(?:paint|stucco)/i, 'new exterior paint', 'paint_exterior', 0.5],
    [/new\s*(?:front\s*)?door/i, 'new front door', 'doors', 0.4],
    [/new\s*garage\s*door/i, 'new garage door', 'doors', 0.5],
    [/new\s*(?:concrete\s*)?driveway/i, 'new driveway', 'driveway', 0.5],
    [/new\s*fence/i, 'new fence', 'landscaping', 0.4],
    [/(?:new|updated)\s*landscap/i, 'new landscaping', 'landscaping', 0.4],
  ],

  mechanical: [
    [/new\s*hvac/i, 'new HVAC', 'hvac', 0.7],
    [/new\s*(?:a\/?c|air\s*condition)/i, 'new AC', 'hvac', 0.7],
    [/new\s*(?:furnace|heat(?:er|ing)\s*(?:system|unit))/i, 'new furnace/heater', 'hvac', 0.7],
    [/(?:tankless|on[\s-]*demand)\s*water\s*heater/i, 'tankless water heater', 'hvac', 0.6],
    [/new\s*water\s*heater/i, 'new water heater', 'plumbing', 0.5],
    [/(?:new|updated)\s*(?:electrical\s*)?(?:panel|wiring)/i, 'new electrical panel', 'electrical', 0.6],
    [/(?:new|updated)\s*plumbing/i, 'new plumbing', 'plumbing', 0.6],
    [/smart\s*thermostat/i, 'smart thermostat', 'smart_home', 0.4],
    [/(?:nest|ecobee)/i, 'smart thermostat', 'smart_home', 0.4],
    [/solar\s*panel/i, 'solar panels', 'solar', 0.6],
  ],

  major_scope: [
    [/(?:complete(?:ly)?|total(?:ly)?|full(?:y)?)\s*(?:renovated|remodel(?:ed)?|updated|rehabbed)/i, 'completely renovated', 'full_reno', 1.0],
    [/gut\s*(?:renovation|reno|rehab|remodel)/i, 'gut renovation', 'full_reno', 1.0],
    [/(?:down\s*to\s*(?:the\s*)?studs|studs[\s-]*out)/i, 'studs-out renovation', 'full_reno', 1.0],
    [/(?:everything|all)\s*(?:is\s*)?new/i, 'everything new', 'full_reno', 0.8],
    [/top[\s-]*to[\s-]*bottom\s*(?:renovati|remodel|updat|rehab)/i, 'top-to-bottom renovation', 'full_reno', 0.9],
    [/(?:beautifully|recently|newly)\s*(?:renovated|remodeled|updated)/i, 'recently renovated', 'full_reno', 0.4],
    [/move[\s-]*in\s*ready/i, 'move-in ready', 'cosmetic', 0.2],
    [/(?:new|added|finished)\s*(?:basement|bonus\s*room|addition)/i, 'finished basement/addition', 'basement', 0.7],
    [/(?:basement|lower\s*level)\s*(?:finish|remodel|convert)/i, 'basement finish', 'basement', 0.7],
    [/(?:addition|adu|in[\s-]*law\s*(?:suite|unit)|accessory\s*dwelling)/i, 'addition/ADU', 'addition', 0.7],
    [/(?:new|remodeled|updated)\s*(?:deck|patio|pergola)/i, 'new deck/patio', 'deck_patio', 0.5],
    [/(?:new|added|installed)\s*pool/i, 'new pool', 'pool', 0.7],
    [/(?:outdoor|covered)\s*kitchen/i, 'outdoor kitchen', 'deck_patio', 0.6],
  ],
};

/**
 * Parse MLS description text for renovation keywords.
 * Returns detected renovation categories with confidence scores.
 * 
 * @param {string} description - MLS listing description/remarks
 * @returns {{ categories: Object<string, { keywords: string[], confidence: number, specificity: number }>, overallScore: number }}
 */
export function parseDescriptionKeywords(description) {
  if (!description || typeof description !== 'string') {
    return { categories: {}, overallScore: 0, keywordCount: 0 };
  }

  const text = description.toLowerCase();
  const categoriesMap = {};
  let totalKeywords = 0;
  let totalSpecificity = 0;

  for (const [groupName, patterns] of Object.entries(KEYWORD_PATTERNS)) {
    for (const [regex, displayName, subCategory, specificity] of patterns) {
      if (regex.test(text)) {
        if (!categoriesMap[subCategory]) {
          categoriesMap[subCategory] = { keywords: [], confidence: 0, specificity: 0, matchCount: 0 };
        }
        categoriesMap[subCategory].keywords.push(displayName);
        categoriesMap[subCategory].matchCount++;
        categoriesMap[subCategory].specificity = Math.max(categoriesMap[subCategory].specificity, specificity);
        totalKeywords++;
        totalSpecificity += specificity;
      }
    }
  }

  // Compute per-category confidence from match count + max specificity
  for (const cat of Object.values(categoriesMap)) {
    // More matches + higher specificity = higher confidence
    cat.confidence = Math.min(1.0, cat.specificity * 0.6 + Math.min(cat.matchCount, 4) * 0.1);
  }

  // Overall keyword score: 0-1 based on total keyword hits and specificity
  const overallScore = totalKeywords === 0 ? 0 : Math.min(1.0,
    (totalSpecificity / Math.max(totalKeywords, 1)) * 0.5 +
    Math.min(totalKeywords, 10) * 0.05
  );

  return { categories: categoriesMap, overallScore, keywordCount: totalKeywords };
}


// ============================================================================
// SIGNAL B: PROPERTY FEATURES / AGE MISMATCH
// ============================================================================

/**
 * Modern features that strongly suggest renovation when found in older homes.
 * [featureKeyword, category, recencyThreshold (years since build date to count as mismatch)]
 */
const MODERN_FEATURE_INDICATORS = [
  ['tankless water heater', 'hvac', 20],
  ['smart thermostat', 'smart_home', 15],
  ['nest', 'smart_home', 15],
  ['ecobee', 'smart_home', 15],
  ['stainless steel', 'kitchen', 15],
  ['granite', 'kitchen', 25],
  ['quartz', 'kitchen', 20],
  ['quartzite', 'kitchen', 20],
  ['undermount sink', 'kitchen', 20],
  ['soft close', 'kitchen', 15],
  ['led', 'paint_interior', 10],
  ['recessed light', 'paint_interior', 15],
  ['luxury vinyl', 'flooring', 10],
  ['lvp', 'flooring', 10],
  ['engineered hardwood', 'flooring', 15],
  ['frameless shower', 'bathroom', 15],
  ['rain shower', 'bathroom', 15],
  ['dual flush', 'bathroom', 15],
  ['low-e', 'windows', 20],
  ['double pane', 'windows', 25],
  ['impact window', 'windows', 20],
  ['smart lock', 'smart_home', 10],
  ['ring', 'smart_home', 10],
  ['solar', 'solar', 10],
  ['ev charger', 'smart_home', 5],
  ['mini split', 'hvac', 15],
  ['heat pump', 'hvac', 20],
  ['spray foam', 'hvac', 15],
];

/**
 * Detect feature/age mismatches that indicate renovation.
 * A 1960 house with "tankless water heater" and "smart thermostat" has clearly been updated.
 * 
 * @param {Object} features - Zillow features dict from /custom_ad
 * @param {number} yearBuilt - Property year built
 * @param {string} description - MLS description (fallback if features is sparse)
 * @returns {{ mismatches: Array, score: number }}
 */
export function detectFeatureAgeMismatch(features, yearBuilt, description = '') {
  if (!yearBuilt) return { mismatches: [], score: 0 };

  const currentYear = new Date().getFullYear();
  const propertyAge = currentYear - yearBuilt;

  // Young homes (< 10 years old) are unlikely to have renovation mismatches
  if (propertyAge < 10) return { mismatches: [], score: 0 };

  // Build a searchable text from features dict + description
  let featureText = '';
  if (features && typeof features === 'object') {
    const flatten = (obj, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
          featureText += ` ${v}`;
        } else if (Array.isArray(v)) {
          featureText += ` ${v.join(' ')}`;
        } else if (typeof v === 'object' && v !== null) {
          flatten(v, `${prefix}${k}.`);
        }
      }
    };
    flatten(features);
  }
  featureText = (featureText + ' ' + (description || '')).toLowerCase();

  const mismatches = [];

  for (const [keyword, category, recencyThreshold] of MODERN_FEATURE_INDICATORS) {
    if (featureText.includes(keyword.toLowerCase()) && propertyAge >= recencyThreshold) {
      mismatches.push({
        feature: keyword,
        category,
        propertyAge,
        threshold: recencyThreshold,
        ageDelta: propertyAge - recencyThreshold,
      });
    }
  }

  // Score: more mismatches = higher confidence renovation occurred
  // Each mismatch contributes proportionally, capped at 1.0
  const score = Math.min(1.0, mismatches.length * 0.15 + (mismatches.length > 0 ? 0.2 : 0));

  return { mismatches, score };
}


// ============================================================================
// SIGNAL C: PRICE HISTORY PATTERN ANALYSIS
// ============================================================================

/**
 * Analyze price history events between before/after sales to infer renovation.
 * 
 * @param {Object} params
 * @param {number} params.beforePrice - First sale price
 * @param {number} params.afterPrice - Second sale price
 * @param {number} params.daysBetweenSales - Days between sales
 * @param {number|null} params.beforePSF - Before price per sqft
 * @param {number|null} params.afterPSF - After price per sqft
 * @param {Array} params.priceHistory - Full price history events array
 * @param {number|null} params.beforeSaleToList - Before sale-to-list ratio
 * @param {number|null} params.afterSaleToList - After sale-to-list ratio
 * @returns {{ holdingProfile: string, jumpCategory: string, hasRentalGap: boolean, psfJumpPct: number|null, score: number }}
 */
export function analyzePriceHistoryPattern({
  beforePrice,
  afterPrice,
  daysBetweenSales,
  beforePSF = null,
  afterPSF = null,
  priceHistory = [],
  beforeSaleToList = null,
  afterSaleToList = null,
  marketAdjustedPriceIncreasePct = null, // Pre-computed: raw increase minus market appreciation
}) {
  const rawPriceIncreasePct = ((afterPrice - beforePrice) / beforePrice) * 100;
  // Use market-adjusted price increase for scoring when available,
  // so hot-market appreciation doesn't inflate renovation confidence.
  const priceIncreasePct = marketAdjustedPriceIncreasePct != null
    ? marketAdjustedPriceIncreasePct
    : rawPriceIncreasePct;
  const holdingMonths = daysBetweenSales / 30.44;

  // --- Holding period classification ---
  let holdingProfile = 'unknown';
  let holdingScore = 0;
  if (holdingMonths >= 2 && holdingMonths <= 8) {
    holdingProfile = 'quick_flip';
    holdingScore = 0.8; // Very likely intentional renovation for profit
  } else if (holdingMonths > 8 && holdingMonths <= 18) {
    holdingProfile = 'classic_flip';
    holdingScore = 0.9; // Classic renovation timeline
  } else if (holdingMonths > 18 && holdingMonths <= 36) {
    holdingProfile = 'extended_hold';
    holdingScore = 0.5; // Could be renovation or just market
  } else if (holdingMonths > 36) {
    holdingProfile = 'long_term_hold';
    holdingScore = 0.2; // More likely market appreciation + some updates
  }

  // --- Price jump magnitude classification ---
  let jumpCategory = 'minimal';
  let jumpScore = 0;
  if (priceIncreasePct >= 50) {
    jumpCategory = 'major_gut_reno';
    jumpScore = 0.9;
  } else if (priceIncreasePct >= 25) {
    jumpCategory = 'medium_renovation';
    jumpScore = 0.7;
  } else if (priceIncreasePct >= 15) {
    jumpCategory = 'light_renovation';
    jumpScore = 0.5;
  } else if (priceIncreasePct >= 5) {
    jumpCategory = 'cosmetic_refresh';
    jumpScore = 0.3;
  }

  // --- Rental gap detection ---
  // If "Listed for rent" events appear between the two sold events, the property
  // was held as a rental → different renovation profile than a flip
  let hasRentalGap = false;
  if (priceHistory && priceHistory.length > 0) {
    const rentalEvents = priceHistory.filter(e =>
      e.postingIsRental ||
      (e.event && /rent|lease/i.test(e.event))
    );
    // Check if any rental events fall between the two sale dates
    // (We use beforePrice/afterPrice as proxies - actual timestamps would be better)
    if (rentalEvents.length > 0) {
      hasRentalGap = true;
    }
  }

  // --- PSF jump analysis ---
  let psfJumpPct = null;
  let psfScore = 0;
  if (beforePSF && afterPSF && beforePSF > 0) {
    psfJumpPct = ((afterPSF - beforePSF) / beforePSF) * 100;
    // PSF jumps are more robust than raw price jumps (normalized for size)
    if (psfJumpPct >= 30) {
      psfScore = 0.8;
    } else if (psfJumpPct >= 15) {
      psfScore = 0.5;
    } else if (psfJumpPct >= 5) {
      psfScore = 0.3;
    }
  }

  // --- Combined price pattern score ---
  // Weighted combination: jump magnitude is most important, holding period second
  const score = Math.min(1.0,
    jumpScore * 0.45 +
    holdingScore * 0.30 +
    psfScore * 0.15 +
    (hasRentalGap ? -0.1 : 0.1) // Rental gap slightly reduces renovation confidence (rental management, not flip)
  );

  return {
    holdingProfile,
    holdingMonths: Math.round(holdingMonths),
    jumpCategory,
    priceIncreasePct: Math.round(priceIncreasePct * 10) / 10,
    rawPriceIncreasePct: Math.round(rawPriceIncreasePct * 10) / 10,
    hasRentalGap,
    psfJumpPct: psfJumpPct !== null ? Math.round(psfJumpPct * 10) / 10 : null,
    score: Math.max(0, Math.round(score * 100) / 100),
  };
}


// ============================================================================
// SCOPE INFERENCE FROM PRICE JUMP + KEYWORDS
// ============================================================================

/**
 * Infer renovation scope from price jump magnitude and keyword intensity.
 * Maps to the same scope values used by the existing uplift allocation model.
 */
function inferScope(priceIncreasePct, keywordCount, hasFullRenoKeyword) {
  if (hasFullRenoKeyword || priceIncreasePct >= 60) return 'gut_reno';
  if (priceIncreasePct >= 35 || keywordCount >= 8) return 'full_remodel';
  if (priceIncreasePct >= 15 || keywordCount >= 4) return 'refresh';
  return 'cosmetic';
}

/**
 * Estimate renovation cost for a category + scope using regional cost-per-sqft models.
 * Same cost estimation approach as the existing processor.
 * Now with property-value awareness: renovation costs correlate with home value
 * because materials, finishes, and contractor expectations scale with area norms.
 *
 * @param {string} category - Renovation category
 * @param {string} scope - cosmetic | refresh | full_remodel | gut_reno
 * @param {number} sqft - Property square footage
 * @param {number} [propertyValue=0] - Before-sale price for scaling
 * @returns {number} Estimated cost in dollars
 */
function estimateCostForCategory(category, scope, sqft, propertyValue = 0) {
  // Base cost per category — calibrated to a $375K, 1800-sqft home (US median).
  // These represent realistic contractor-bid midpoints from NAR Cost vs Value 2024.
  const BASE_COSTS = {
    kitchen: 22000,         // Minor remodel; was 25000
    bathroom: 10000,
    bathroom_master: 13000, // was 15000
    bathroom_secondary: 7000,
    flooring: 7000,
    paint_interior: 3500,
    paint_exterior: 4500,
    roof: 11000,
    siding: 14000,
    windows: 9000,
    doors: 2500,
    hvac: 7500,
    electrical: 5500,
    plumbing: 4500,
    smart_home: 2500,
    solar: 16000,
    basement: 25000,       // was 30000
    addition: 50000,       // was 60000
    deck_patio: 10000,
    pool: 35000,
    landscaping: 4500,
    driveway: 4500,
    full_reno: 65000,      // was 80000
    other: 8000,
  };

  const SCOPE_MULTIPLIERS = {
    'cosmetic': 0.4,
    'refresh': 1.0,
    'full_remodel': 1.8,   // was 2.0 — the compounding with area and value was producing inflated numbers
    'gut_reno': 3.0,       // was 3.5 — gut reno at 3.5× already had $87.5K for kitchen alone
  };

  const baseCost = BASE_COSTS[category] || 8000;
  const scopeMult = SCOPE_MULTIPLIERS[scope] || 1.0;

  // Light area adjustment for whole-house categories
  let areaMult = 1.0;
  if (sqft && ['flooring', 'paint_interior', 'full_reno'].includes(category)) {
    areaMult = Math.max(0.6, Math.min(1.8, sqft / 1800)); // Normalize to 1800 sqft baseline
  }

  // Property-value scaling: a reno on a $180K home costs less than on a $500K home
  // (different material expectations, contractor market, scope norms).
  // Scale factor is dampened (square root) to prevent extreme swings.
  // Baseline: $375K home = 1.0×
  let valueMult = 1.0;
  if (propertyValue > 0) {
    const rawRatio = propertyValue / 375000;
    valueMult = Math.max(0.6, Math.min(1.6, Math.sqrt(rawRatio)));
  }

  return Math.round(baseCost * scopeMult * areaMult * valueMult);
}


// ============================================================================
// COMBINED RENOVATION CLASSIFICATION
// ============================================================================

/**
 * Main entry point: classify a renovation pair using all 3 signals.
 * 
 * @param {Object} params
 * @param {string} params.description - MLS listing description (after listing)
 * @param {Object|null} params.features - Zillow features dict from /custom_ad
 * @param {number} params.yearBuilt
 * @param {number} params.sqft
 * @param {number} params.beforePrice
 * @param {number} params.afterPrice
 * @param {number} params.daysBetweenSales
 * @param {number|null} params.beforePSF
 * @param {number|null} params.afterPSF
 * @param {Array} params.priceHistory - Full price history events
 * @param {number|null} params.beforeSaleToList
 * @param {number|null} params.afterSaleToList
 * @param {string} params.beforeDescription - Before listing description (if available)
 * @returns {{ renovationScore: number, confidence: string, detectedRenovations: Array, signals: Object, scope: string }}
 */
export function classifyRenovation({
  description = '',
  beforeDescription = '',
  features = null,
  yearBuilt = null,
  sqft = 0,
  beds = 0,
  baths = 0,
  beforePrice,
  afterPrice,
  daysBetweenSales,
  beforePSF = null,
  afterPSF = null,
  priceHistory = [],
  beforeSaleToList = null,
  afterSaleToList = null,
  marketAdjustedPriceIncreasePct = null, // Pre-computed: raw increase minus market appreciation
}) {
  // --- Run all 3 signals ---
  const keywordResult = parseDescriptionKeywords(description);
  const featureResult = detectFeatureAgeMismatch(features, yearBuilt, description);
  const priceResult = analyzePriceHistoryPattern({
    beforePrice,
    afterPrice,
    daysBetweenSales,
    beforePSF,
    afterPSF,
    priceHistory,
    beforeSaleToList,
    afterSaleToList,
    marketAdjustedPriceIncreasePct, // Pass through market-adjusted increase
  });

  // --- Combined score ---
  // When no description is available (common for sold listings, especially multi-family),
  // the keyword signal is dead weight. Redistribute its weight to price-pattern and
  // feature-age signals so strong flip indicators can still pass the 0.4 threshold.
  const hasDescription = description && description.trim().length > 20;
  const kw = hasDescription ? 0.50 : 0.05; // near-zero when no description
  const pw = hasDescription ? 0.30 : 0.65; // price pattern becomes primary signal
  const fw = hasDescription ? 0.20 : 0.30; // feature-age gets a boost too

  const renovationScore =
    keywordResult.overallScore * kw +
    priceResult.score * pw +
    featureResult.score * fw;

  // --- Confidence level ---
  let confidence = 'low';
  if (renovationScore > 0.7) confidence = 'high';
  else if (renovationScore >= 0.4) confidence = 'medium';

  // --- Check for full-reno keywords ---
  // Require high specificity (>= 0.7) to activate full-reno scope.
  // Marketing phrases like 'recently renovated' (0.4) or 'move-in ready' (0.2)
  // should not force gut_reno scope.
  const fullRenoCat = keywordResult.categories['full_reno'];
  const hasFullRenoKeyword = !!(fullRenoCat && fullRenoCat.specificity >= 0.7);

  // --- Infer scope using market-adjusted price increase when available ---
  // This prevents hot-market appreciation from inflating the inferred renovation scope.
  const rawPriceIncreasePct = ((afterPrice - beforePrice) / beforePrice) * 100;
  const priceIncreasePct = marketAdjustedPriceIncreasePct != null
    ? marketAdjustedPriceIncreasePct
    : rawPriceIncreasePct;
  const scope = inferScope(priceIncreasePct, keywordResult.keywordCount, hasFullRenoKeyword);

  // --- Build detected renovations array (same format as photo comparison output) ---
  const detectedRenovations = [];

  if (hasFullRenoKeyword) {
    // Full renovation: single entry covering the whole property
    detectedRenovations.push({
      category: 'full_reno',
      scope: scope,
      description: keywordResult.categories['full_reno']?.keywords?.join(', ') || 'Full renovation',
      confidence: Math.min(1.0, renovationScore + 0.1),
      estimatedCost: null, // Removed: comp costs are not real data — cost estimation belongs on the subject property only
      costRange: null,
      qualityLevel: null,
      beforeDescription: beforeDescription ? 'Pre-renovation condition' : null,
      afterDescription: description ? description.substring(0, 200) : null,
      materials: [],
      affectedRooms: Object.keys(keywordResult.categories),
      estimatedAreaSqFt: sqft || 1500,
      propertySqft: sqft || 0,
      propertyBeds: beds || 0,
      propertyBaths: baths || 0,
      source: 'keyword_classifier',
    });

    // ── ALSO emit individual category renovations found in the description ──
    // A full-reno listing like "gut renovation with new kitchen, quartz counters,
    // new bathrooms, hardwood floors throughout" should contribute data points to
    // kitchen, bathroom, flooring, etc. — not ONLY to the aggregate full_reno bucket.
    // Without this, flip-heavy markets (Baltimore, Philly, Detroit) produce ONLY
    // full_reno data and no per-category uplift stats.
    for (const [cat, data] of Object.entries(keywordResult.categories)) {
      if (cat === 'full_reno') continue; // already added above
      const mappedCategory = mapToStandardCategory(cat);
      detectedRenovations.push({
        category: mappedCategory,
        scope: inferCategoryScope(priceIncreasePct, data.matchCount, data.specificity),
        description: data.keywords.join(', '),
        confidence: Math.min(data.confidence, 0.7), // slightly lower than full_reno — inferred component
        estimatedCost: null,
        costRange: null,
        qualityLevel: inferQualityFromKeywords(data.keywords),
        beforeDescription: null,
        afterDescription: data.keywords.join(', '),
        materials: data.keywords.filter(k =>
          /counter|cabinet|floor|tile|shingle|siding|window|vinyl|hardwood|lvp|lvt|marble|granite|quartz/i.test(k)
        ).map(k => ({ name: k, category: mappedCategory, materialTier: 'mid_grade', confidence: 0.6, source: 'keyword_classifier' })),
        affectedRooms: [],
        estimatedAreaSqFt: 0,
        propertySqft: sqft || 0,
        propertyBeds: beds || 0,
        propertyBaths: baths || 0,
        source: 'keyword_classifier_decomposed',
      });
    }

    // If the description is generic ("completely renovated" with no specific room mentions),
    // infer that a gut reno likely included kitchen + bathroom + flooring + paint.
    // This ensures even sparse descriptions contribute to per-category stats.
    const emittedCategories = new Set(detectedRenovations.map(r => r.category));
    const IMPLIED_GUT_RENO_CATEGORIES = ['kitchen', 'bathroom', 'flooring', 'paint_interior'];
    if (scope === 'gut_reno' || scope === 'full_remodel') {
      for (const impliedCat of IMPLIED_GUT_RENO_CATEGORIES) {
        if (!emittedCategories.has(impliedCat)) {
          emittedCategories.add(impliedCat);
          detectedRenovations.push({
            category: impliedCat,
            scope: scope === 'gut_reno' ? 'full_remodel' : 'refresh',
            description: `Implied by ${scope} — likely included in full renovation`,
            confidence: 0.45, // lower — inferred, not explicitly mentioned
            estimatedCost: null,
            costRange: null,
            qualityLevel: null,
            beforeDescription: null,
            afterDescription: `Part of ${scope}`,
            materials: [],
            affectedRooms: [],
            estimatedAreaSqFt: 0,
            propertySqft: sqft || 0,
            propertyBeds: beds || 0,
            propertyBaths: baths || 0,
            source: 'keyword_classifier_implied',
          });
        }
      }
    }
  } else {
    // Individual category renovations
    for (const [cat, data] of Object.entries(keywordResult.categories)) {
      // Map sub-categories to the standard renovation category names
      const mappedCategory = mapToStandardCategory(cat);
      detectedRenovations.push({
        category: mappedCategory,
        scope: inferCategoryScope(priceIncreasePct, data.matchCount, data.specificity),
        description: data.keywords.join(', '),
        confidence: data.confidence,
        estimatedCost: null, // Removed: comp costs are not real data
        costRange: null,
        qualityLevel: inferQualityFromKeywords(data.keywords),
        beforeDescription: null,
        afterDescription: data.keywords.join(', '),
        materials: data.keywords.filter(k =>
          /counter|cabinet|floor|tile|shingle|siding|window|vinyl|hardwood|lvp|lvt|marble|granite|quartz/i.test(k)
        ).map(k => ({ name: k, category: mappedCategory, materialTier: 'mid_grade', confidence: 0.6, source: 'keyword_classifier' })),
        affectedRooms: [],
        estimatedAreaSqFt: 0, // Will use property-scaled default in allocation
        propertySqft: sqft || 0,
        propertyBeds: beds || 0,
        propertyBaths: baths || 0,
        source: 'keyword_classifier',
      });
    }

    // Also add feature-mismatch detections that weren't already covered by keywords
    const coveredCategories = new Set(detectedRenovations.map(r => r.category));
    for (const mismatch of featureResult.mismatches) {
      const mappedCat = mapToStandardCategory(mismatch.category);
      if (!coveredCategories.has(mappedCat)) {
        coveredCategories.add(mappedCat);
        detectedRenovations.push({
          category: mappedCat,
          scope: 'refresh',
          description: `Modern feature detected: ${mismatch.feature} (${mismatch.propertyAge}-year-old home)`,
          confidence: 0.4, // Lower confidence — inferred from feature, not explicit keywords
          estimatedCost: null, // Removed: comp costs are not real data
          costRange: null,
          qualityLevel: null,
          beforeDescription: null,
          afterDescription: `${mismatch.feature} in ${yearBuilt} home`,
          materials: [],
          affectedRooms: [],
          estimatedAreaSqFt: 0,
          propertySqft: sqft || 0,
          propertyBeds: beds || 0,
          propertyBaths: baths || 0,
          source: 'feature_age_mismatch',
        });
      }
    }
  }

  // --- Price-pattern-inferred renovations (no description available) ---
  // When no listing description is available (very common for sold MF properties),
  // and the price pattern strongly indicates a flip, infer renovation categories
  // from the price pattern alone. A property bought for $200K and sold for $350K
  // after 8 months was almost certainly renovated.
  if (!hasDescription && detectedRenovations.length === 0 && priceResult.score >= 0.5) {
    // Strong price-pattern signal with no keyword data → infer from flip profile
    const inferredScope = scope; // already computed from price increase
    const isLikelyFlip = priceResult.holdingProfile === 'quick_flip' || priceResult.holdingProfile === 'classic_flip';
    const isStrongJump = priceResult.jumpCategory === 'major_gut_reno' || priceResult.jumpCategory === 'medium_renovation';

    if (isLikelyFlip || isStrongJump) {
      // For major price jumps (≥25% market-adjusted), assume full interior renovation
      const PRICE_INFERRED_CATEGORIES = isStrongJump
        ? ['kitchen', 'bathroom', 'flooring', 'paint_interior']
        : ['flooring', 'paint_interior']; // lighter renovation for smaller jumps

      for (const cat of PRICE_INFERRED_CATEGORIES) {
        detectedRenovations.push({
          category: cat,
          scope: inferredScope,
          description: `Inferred from price pattern: ${priceResult.holdingProfile}, ${priceResult.jumpCategory} (${priceResult.priceIncreasePct}% increase)`,
          confidence: Math.min(0.55, priceResult.score * 0.6), // capped — inferred, not observed
          estimatedCost: null,
          costRange: null,
          qualityLevel: null,
          beforeDescription: null,
          afterDescription: `Price-pattern-inferred renovation (${priceResult.priceIncreasePct}% over ${priceResult.holdingMonths}mo)`,
          materials: [],
          affectedRooms: [],
          estimatedAreaSqFt: 0,
          propertySqft: sqft || 0,
          propertyBeds: beds || 0,
          propertyBaths: baths || 0,
          source: 'price_pattern_inferred',
        });
      }
    }
  }

  return {
    renovationScore: Math.round(renovationScore * 100) / 100,
    confidence,
    scope,
    detectedRenovations,
    hasDescription,
    signals: {
      keyword: {
        score: keywordResult.overallScore,
        keywordCount: keywordResult.keywordCount,
        categories: Object.keys(keywordResult.categories),
        weight: kw,
      },
      pricePattern: {
        score: priceResult.score,
        holdingProfile: priceResult.holdingProfile,
        holdingMonths: priceResult.holdingMonths,
        jumpCategory: priceResult.jumpCategory,
        priceIncreasePct: priceResult.priceIncreasePct,
        hasRentalGap: priceResult.hasRentalGap,
        psfJumpPct: priceResult.psfJumpPct,
        weight: pw,
      },
      featureAge: {
        score: featureResult.score,
        mismatchCount: featureResult.mismatches.length,
        mismatches: featureResult.mismatches.map(m => m.feature),
        weight: fw,
      },
    },
  };
}


// ============================================================================
// HELPERS
// ============================================================================

/**
 * Map sub-category names to standard renovation category names
 * used by the uplift allocation model.
 */
function mapToStandardCategory(subCategory) {
  const MAP = {
    'kitchen': 'kitchen',
    'bathroom': 'bathroom_master',
    'bathroom_master': 'bathroom_master',
    'bathroom_secondary': 'bathroom_secondary',
    'flooring': 'flooring',
    'paint_interior': 'paint_interior',
    'paint_exterior': 'paint_exterior',
    'roof': 'roof',
    'siding': 'siding',
    'windows': 'windows',
    'doors': 'doors',
    'hvac': 'hvac',
    'electrical': 'electrical',
    'plumbing': 'plumbing',
    'smart_home': 'smart_home',
    'solar': 'solar',
    'basement': 'basement',
    'addition': 'addition',
    'deck_patio': 'deck_patio',
    'pool': 'pool',
    'landscaping': 'landscaping',
    'driveway': 'driveway',
    'full_reno': 'other', // full_reno handled separately
    'other': 'other',
  };
  return MAP[subCategory] || 'other';
}

/**
 * Infer per-category scope from price increase and keyword specificity
 */
function inferCategoryScope(priceIncreasePct, matchCount, specificity) {
  if (specificity >= 0.8 && matchCount >= 3) return 'full_remodel';
  if (specificity >= 0.6 || matchCount >= 2) return 'refresh';
  return 'cosmetic';
}

/**
 * Infer quality level from detected keyword names
 */
function inferQualityFromKeywords(keywords) {
  const text = keywords.join(' ').toLowerCase();
  if (/quartzite|marble|custom|pro[\s-]*grade|wolf|sub[\s-]*zero|thermador|viking|miele|luxury|high[\s-]*end/i.test(text)) return 'luxury';
  if (/granite|solid\s*hardwood|frameless|standing\s*seam|hardie|architectural|engineered/i.test(text)) return 'high_end';
  if (/quartz|stainless|lvp|shaker|subway|porcelain|undermount|brushed\s*nickel/i.test(text)) return 'mid_grade';
  if (/laminate|vinyl|carpet|3[\s-]*tab|thermofoil|peel/i.test(text)) return 'budget';
  return null;
}


// ============================================================================
// EXPORTS
// ============================================================================

export default {
  parseDescriptionKeywords,
  detectFeatureAgeMismatch,
  analyzePriceHistoryPattern,
  classifyRenovation,
};
