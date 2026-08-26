/**
 * Live Product Search Service
 * 
 * Real-time product search for renovation materials from major retailers:
 * - Home Depot
 * - Lowe's
 * - Amazon
 * - Wayfair
 * - Build.com
 * - Ferguson
 * 
 * Uses Google Custom Search API with shopping-focused queries to get:
 * - Live product pricing
 * - Direct purchase links
 * - Product specifications
 * - Local store availability info
 */

import 'dotenv/config';

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_CX || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Major home improvement retailers to prioritize
const PRIORITY_RETAILERS = [
  { name: 'Home Depot', domain: 'homedepot.com', storeLocator: 'https://www.homedepot.com/l/search' },
  { name: 'Lowe\'s', domain: 'lowes.com', storeLocator: 'https://www.lowes.com/store' },
  { name: 'Amazon', domain: 'amazon.com', storeLocator: null },
  { name: 'Wayfair', domain: 'wayfair.com', storeLocator: null },
  { name: 'Build.com', domain: 'build.com', storeLocator: null },
  { name: 'Ferguson', domain: 'ferguson.com', storeLocator: 'https://www.ferguson.com/locations' },
  { name: 'Menards', domain: 'menards.com', storeLocator: 'https://www.menards.com/store-locator' },
  { name: 'Ace Hardware', domain: 'acehardware.com', storeLocator: 'https://www.acehardware.com/store-locator' }
];

// Product categories with search optimization keywords
const PRODUCT_CATEGORIES = {
  // Bathroom
  vanity: {
    keywords: ['bathroom vanity', 'vanity cabinet', 'sink vanity'],
    specs: ['width', 'finish', 'sink included', 'faucet holes'],
    priceRange: { budget: [200, 500], midRange: [500, 1500], luxury: [1500, 5000] }
  },
  toilet: {
    keywords: ['toilet', 'commode', 'water closet'],
    specs: ['gpf', 'height', 'elongated/round', 'one-piece/two-piece'],
    priceRange: { budget: [100, 250], midRange: [250, 500], luxury: [500, 2000] }
  },
  bathtub: {
    keywords: ['bathtub', 'soaking tub', 'alcove tub', 'freestanding tub'],
    specs: ['length', 'material', 'drain location', 'soaking depth'],
    priceRange: { budget: [200, 500], midRange: [500, 1500], luxury: [1500, 8000] }
  },
  shower: {
    keywords: ['shower kit', 'shower enclosure', 'shower door', 'shower pan'],
    specs: ['size', 'door type', 'glass thickness'],
    priceRange: { budget: [300, 800], midRange: [800, 2000], luxury: [2000, 6000] }
  },
  bathroom_faucet: {
    keywords: ['bathroom faucet', 'lavatory faucet', 'sink faucet'],
    specs: ['finish', 'handle type', 'spout height'],
    priceRange: { budget: [30, 100], midRange: [100, 300], luxury: [300, 800] }
  },
  bathroom_sink: {
    keywords: ['bathroom sink', 'vessel sink', 'undermount sink', 'drop-in sink'],
    specs: ['size', 'material', 'mount type'],
    priceRange: { budget: [50, 150], midRange: [150, 400], luxury: [400, 1500] }
  },
  bathroom_mirror: {
    keywords: ['bathroom mirror', 'framed bathroom mirror', 'vanity mirror'],
    specs: ['width', 'height', 'frame finish'],
    priceRange: { budget: [60, 150], midRange: [150, 350], luxury: [350, 1200] }
  },
  vanity_light: {
    keywords: ['bathroom vanity light', 'bath light bar', 'vanity light fixture'],
    specs: ['width', 'finish', 'bulb count'],
    priceRange: { budget: [50, 140], midRange: [140, 320], luxury: [320, 900] }
  },
  exhaust_fan: {
    keywords: ['bathroom exhaust fan', 'bath fan', 'quiet exhaust fan'],
    specs: ['cfm', 'sone rating', 'light included'],
    priceRange: { budget: [60, 120], midRange: [120, 260], luxury: [260, 700] }
  },
  
  // Kitchen
  kitchen_sink: {
    keywords: ['kitchen sink', 'farmhouse sink', 'undermount kitchen sink', 'stainless steel sink'],
    specs: ['size', 'material', 'bowl configuration', 'gauge'],
    priceRange: { budget: [100, 300], midRange: [300, 700], luxury: [700, 2000] }
  },
  kitchen_faucet: {
    keywords: ['kitchen faucet', 'pull-down faucet', 'touchless faucet'],
    specs: ['finish', 'spray type', 'handle type'],
    priceRange: { budget: [50, 150], midRange: [150, 400], luxury: [400, 1000] }
  },
  garbage_disposal: {
    keywords: ['garbage disposal', 'food waste disposer', 'insinkerator'],
    specs: ['horsepower', 'noise level', 'warranty'],
    priceRange: { budget: [80, 150], midRange: [150, 300], luxury: [300, 600] }
  },
  range_hood: {
    keywords: ['range hood', 'vent hood', 'exhaust hood', 'over range microwave'],
    specs: ['cfm', 'width', 'ducted/ductless'],
    priceRange: { budget: [100, 300], midRange: [300, 700], luxury: [700, 2500] }
  },
  
  // Flooring
  hardwood_flooring: {
    keywords: ['hardwood flooring', 'engineered hardwood', 'solid hardwood floor'],
    specs: ['species', 'width', 'finish', 'sqft per box'],
    priceRange: { budget: [2, 5], midRange: [5, 10], luxury: [10, 20] }, // per sqft
    unit: 'sqft'
  },
  laminate_flooring: {
    keywords: ['laminate flooring', 'laminate plank flooring'],
    specs: ['thickness', 'AC rating', 'sqft per box'],
    priceRange: { budget: [1, 2], midRange: [2, 4], luxury: [4, 7] },
    unit: 'sqft'
  },
  lvp_flooring: {
    keywords: ['luxury vinyl plank', 'LVP flooring', 'vinyl plank flooring'],
    specs: ['thickness', 'wear layer', 'waterproof'],
    priceRange: { budget: [1.50, 3], midRange: [3, 5], luxury: [5, 9] },
    unit: 'sqft'
  },
  tile_flooring: {
    keywords: ['floor tile', 'porcelain tile', 'ceramic tile'],
    specs: ['size', 'material', 'sqft per box', 'pei rating'],
    priceRange: { budget: [1, 3], midRange: [3, 8], luxury: [8, 25] },
    unit: 'sqft'
  },
  
  // Countertops
  countertop: {
    keywords: ['countertop', 'kitchen countertop', 'quartz countertop', 'granite countertop'],
    specs: ['material', 'edge profile', 'thickness'],
    priceRange: { budget: [20, 50], midRange: [50, 100], luxury: [100, 200] },
    unit: 'sqft'
  },
  
  // Cabinets
  kitchen_cabinet: {
    keywords: ['kitchen cabinet', 'base cabinet', 'wall cabinet', 'RTA cabinet'],
    specs: ['size', 'style', 'finish', 'soft-close'],
    priceRange: { budget: [100, 300], midRange: [300, 600], luxury: [600, 1500] }
  },
  
  // Lighting
  ceiling_fan: {
    keywords: ['ceiling fan', 'ceiling fan with light'],
    specs: ['blade span', 'remote included', 'indoor/outdoor'],
    priceRange: { budget: [50, 150], midRange: [150, 350], luxury: [350, 800] }
  },
  recessed_light: {
    keywords: ['recessed light', 'can light', 'LED recessed lighting'],
    specs: ['size', 'LED included', 'IC rated'],
    priceRange: { budget: [10, 25], midRange: [25, 60], luxury: [60, 150] }
  },
  pendant_light: {
    keywords: ['pendant light', 'hanging light', 'island pendant'],
    specs: ['size', 'style', 'bulb type'],
    priceRange: { budget: [30, 80], midRange: [80, 200], luxury: [200, 600] }
  },
  
  // HVAC
  water_heater: {
    keywords: ['water heater', 'tankless water heater', 'electric water heater', 'gas water heater'],
    specs: ['capacity', 'fuel type', 'first hour rating'],
    priceRange: { budget: [400, 800], midRange: [800, 1500], luxury: [1500, 4000] }
  },
  thermostat: {
    keywords: ['smart thermostat', 'programmable thermostat', 'wifi thermostat'],
    specs: ['smart home compatible', 'touchscreen', 'learning'],
    priceRange: { budget: [25, 80], midRange: [80, 200], luxury: [200, 400] }
  },
  
  // Doors & Windows
  interior_door: {
    keywords: ['interior door', 'prehung door', 'slab door', 'hollow core door'],
    specs: ['size', 'style', 'prehung/slab'],
    priceRange: { budget: [50, 150], midRange: [150, 350], luxury: [350, 800] }
  },
  exterior_door: {
    keywords: ['exterior door', 'entry door', 'front door', 'steel door', 'fiberglass door'],
    specs: ['size', 'material', 'glass', 'security'],
    priceRange: { budget: [200, 500], midRange: [500, 1500], luxury: [1500, 5000] }
  },
  window: {
    keywords: ['replacement window', 'vinyl window', 'double hung window'],
    specs: ['size', 'frame material', 'glass type', 'U-factor'],
    priceRange: { budget: [150, 300], midRange: [300, 600], luxury: [600, 1500] }
  },
  
  // Appliances
  refrigerator: {
    keywords: ['refrigerator', 'french door refrigerator', 'side by side refrigerator'],
    specs: ['capacity', 'style', 'ice maker', 'smart features'],
    priceRange: { budget: [500, 1000], midRange: [1000, 2500], luxury: [2500, 6000] }
  },
  dishwasher: {
    keywords: ['dishwasher', 'built-in dishwasher', 'quiet dishwasher'],
    specs: ['decibel level', 'cycles', 'third rack'],
    priceRange: { budget: [300, 500], midRange: [500, 900], luxury: [900, 2000] }
  },
  range: {
    keywords: ['range', 'gas range', 'electric range', 'stove'],
    specs: ['fuel type', 'burners', 'oven capacity', 'convection'],
    priceRange: { budget: [400, 800], midRange: [800, 1800], luxury: [1800, 5000] }
  },
  washer: {
    keywords: ['washing machine', 'washer', 'front load washer', 'top load washer'],
    specs: ['capacity', 'load type', 'steam'],
    priceRange: { budget: [400, 700], midRange: [700, 1200], luxury: [1200, 2000] }
  },
  dryer: {
    keywords: ['dryer', 'electric dryer', 'gas dryer'],
    specs: ['capacity', 'fuel type', 'steam'],
    priceRange: { budget: [400, 700], midRange: [700, 1200], luxury: [1200, 2000] }
  }
};

const PRODUCT_CONTEXT_RULES = {
  vanity: {
    objectKeywords: ['vanity', 'sink'],
    materialCategories: ['vanity'],
    materialKeywords: ['vanity cabinet', 'integrated top', 'vanity'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  toilet: {
    objectKeywords: ['toilet'],
    materialCategories: ['plumbing'],
    materialKeywords: ['toilet'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  bathtub: {
    objectKeywords: ['bathtub', 'tub'],
    materialCategories: ['plumbing'],
    materialKeywords: ['bathtub', 'tub'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  shower: {
    objectKeywords: ['shower'],
    materialCategories: ['tile', 'plumbing'],
    materialKeywords: ['shower', 'tile'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  bathroom_faucet: {
    objectKeywords: ['faucet', 'sink', 'vanity'],
    materialCategories: ['plumbing'],
    materialKeywords: ['faucet'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  bathroom_sink: {
    objectKeywords: ['sink', 'vanity'],
    materialCategories: ['vanity', 'plumbing'],
    materialKeywords: ['sink', 'basin'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  bathroom_mirror: {
    objectKeywords: ['mirror'],
    materialCategories: ['vanity', 'bathroom'],
    materialKeywords: ['mirror'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  vanity_light: {
    objectKeywords: ['light', 'mirror', 'vanity'],
    materialCategories: ['lighting', 'electrical'],
    materialKeywords: ['vanity light', 'light fixture'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  exhaust_fan: {
    objectKeywords: ['fan', 'exhaust'],
    materialCategories: ['electrical'],
    materialKeywords: ['exhaust fan', 'fan'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  kitchen_sink: {
    objectKeywords: ['sink'],
    materialCategories: ['plumbing'],
    materialKeywords: ['sink'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  kitchen_faucet: {
    objectKeywords: ['faucet', 'sink'],
    materialCategories: ['plumbing'],
    materialKeywords: ['faucet'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  garbage_disposal: {
    materialCategories: ['appliances', 'plumbing'],
    materialKeywords: ['garbage disposal', 'disposal'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  range_hood: {
    materialCategories: ['appliances', 'lighting'],
    materialKeywords: ['microwave', 'range hood'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  hardwood_flooring: {
    materialCategories: ['flooring'],
    materialKeywords: ['hardwood'],
    defaultUnit: 'sqft',
  },
  laminate_flooring: {
    materialCategories: ['flooring'],
    materialKeywords: ['laminate'],
    defaultUnit: 'sqft',
  },
  lvp_flooring: {
    materialCategories: ['flooring'],
    materialKeywords: ['lvp', 'luxury vinyl plank', 'vinyl plank'],
    defaultUnit: 'sqft',
  },
  tile_flooring: {
    materialCategories: ['tile', 'flooring'],
    materialKeywords: ['tile'],
    defaultUnit: 'sqft',
  },
  countertop: {
    materialCategories: ['countertops'],
    materialKeywords: ['countertop', 'quartz vanity top', 'quartz'],
    defaultUnit: 'sqft',
  },
  kitchen_cabinet: {
    materialCategories: ['cabinets'],
    materialKeywords: ['cabinet'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  ceiling_fan: {
    objectKeywords: ['fan'],
    materialCategories: ['lighting'],
    materialKeywords: ['ceiling fan'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  recessed_light: {
    objectKeywords: ['light'],
    materialCategories: ['lighting'],
    materialKeywords: ['recessed', 'can light'],
    defaultUnit: 'each',
    defaultQuantityFromArea: (floorAreaSqFt) => Math.max(4, Math.round(floorAreaSqFt / 25)),
  },
  pendant_light: {
    objectKeywords: ['light'],
    materialCategories: ['lighting'],
    materialKeywords: ['pendant', 'light fixture'],
    defaultQuantity: 1,
    defaultUnit: 'each',
  },
  window: {
    objectKeywords: ['window'],
    materialCategories: ['windows'],
    materialKeywords: ['window'],
    defaultUnit: 'each',
    defaultQuantityFromPerimeter: (perimeterFt) => Math.max(1, Math.round(perimeterFt / 10)),
  },
  refrigerator: { defaultQuantity: 1, defaultUnit: 'each' },
  dishwasher: { defaultQuantity: 1, defaultUnit: 'each' },
  range: { defaultQuantity: 1, defaultUnit: 'each' },
  washer: { defaultQuantity: 1, defaultUnit: 'each' },
  dryer: { defaultQuantity: 1, defaultUnit: 'each' },
  water_heater: { defaultQuantity: 1, defaultUnit: 'each' },
  thermostat: { defaultQuantity: 1, defaultUnit: 'each' },
};

function toSearchText(value) {
  return String(value || '').toLowerCase();
}

function roundDimensionInches(value, increment = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(increment, Math.round(numeric / increment) * increment);
}

function formatRoomLabel(room) {
  return String(room || '').replace(/\+/g, ' + ').replace(/_/g, ' ').trim();
}

function extractStyleHints(text) {
  const searchable = toSearchText(text);
  const hintCatalog = [
    'shaker',
    'quartz',
    'granite',
    'marble',
    'oak',
    'walnut',
    'white',
    'black',
    'gray',
    'grey',
    'chrome',
    'brushed nickel',
    'matte black',
    'porcelain',
    'waterproof',
    'soft close',
    'frameless',
  ];

  return hintCatalog.filter((hint) => searchable.includes(hint)).slice(0, 3).join(' ');
}

function extractDimensionHint(query) {
  const searchable = String(query || '');
  const match = searchable.match(/(\d+\s*x\s*\d+\s*inch|\d+\s*inch|\d+\s*sq\s*ft)/i);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function findMatchingObject(productType, objectMeasurements = []) {
  const rule = PRODUCT_CONTEXT_RULES[productType];
  if (!rule?.objectKeywords?.length) return null;

  return objectMeasurements
    .map((objectMeasurement) => {
      const searchable = toSearchText(`${objectMeasurement?.type || ''} ${objectMeasurement?.description || ''}`);
      const score = rule.objectKeywords.reduce((sum, keyword) => sum + (searchable.includes(keyword) ? 1 : 0), 0);
      return { objectMeasurement, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.objectMeasurement || null;
}

function findMatchingMaterial(productType, materialBreakdown = []) {
  const rule = PRODUCT_CONTEXT_RULES[productType] || {};

  return materialBreakdown
    .map((material) => {
      const searchable = toSearchText(`${material?.item || ''} ${material?.category || ''} ${material?.matchedTo || ''}`);
      let score = 0;

      if (rule.materialCategories?.includes(String(material?.category || '').toLowerCase())) {
        score += 3;
      }
      for (const keyword of rule.materialKeywords || []) {
        if (searchable.includes(keyword)) score += 2;
      }
      if (rule.objectKeywords) {
        for (const keyword of rule.objectKeywords) {
          if (searchable.includes(keyword)) score += 1;
        }
      }

      return { material, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.material || null;
}

function deriveQuantityEstimate(productType, context, matchedMaterial) {
  const rule = PRODUCT_CONTEXT_RULES[productType] || {};
  const roomDimensions = context.measurements?.roomDimensions || {};
  const measuredQuantity = Number(matchedMaterial?.quantity);

  if (Number.isFinite(measuredQuantity) && measuredQuantity > 0) {
    return {
      quantity: measuredQuantity,
      unit: matchedMaterial.unit || rule.defaultUnit || 'each',
      basis: matchedMaterial.item || 'measured material takeoff',
    };
  }

  if (typeof rule.defaultQuantityFromArea === 'function' && Number(roomDimensions.floorAreaSqFt) > 0) {
    return {
      quantity: rule.defaultQuantityFromArea(Number(roomDimensions.floorAreaSqFt)),
      unit: rule.defaultUnit || 'each',
      basis: 'measured room area',
    };
  }

  if (typeof rule.defaultQuantityFromPerimeter === 'function' && Number(roomDimensions.perimeterFt) > 0) {
    return {
      quantity: rule.defaultQuantityFromPerimeter(Number(roomDimensions.perimeterFt)),
      unit: rule.defaultUnit || 'each',
      basis: 'measured perimeter',
    };
  }

  if (rule.defaultUnit === 'sqft' && Number(roomDimensions.floorAreaSqFt) > 0) {
    return {
      quantity: Math.round(Number(roomDimensions.floorAreaSqFt)),
      unit: 'sqft',
      basis: 'measured floor area',
    };
  }

  return {
    quantity: rule.defaultQuantity || 1,
    unit: rule.defaultUnit || 'each',
    basis: 'default scope assumption',
  };
}

function buildFitSummary(productType, matchedObject, quantityEstimate, measurements) {
  const roomLabel = formatRoomLabel(measurements?.roomType);
  const width = roundDimensionInches(matchedObject?.dimensions?.widthInches);
  const height = roundDimensionInches(matchedObject?.dimensions?.heightInches);

  if (width && height && ['bathroom_mirror', 'window'].includes(productType)) {
    return `Matched to a measured ${matchedObject.description || matchedObject.type} at about ${width} x ${height} inches${roomLabel ? ` in the ${roomLabel}` : ''}.`;
  }

  if (width && ['vanity', 'toilet', 'bathtub', 'shower', 'countertop'].includes(productType)) {
    return `Matched to a measured ${matchedObject.description || matchedObject.type} width around ${width} inches${roomLabel ? ` in the ${roomLabel}` : ''}.`;
  }

  if (quantityEstimate?.quantity > 1) {
    return `Quantity sized from ${quantityEstimate.basis} at about ${Math.round(quantityEstimate.quantity)} ${String(quantityEstimate.unit || '').replace(/_/g, ' ')}${roomLabel ? ` in the ${roomLabel}` : ''}.`;
  }

  if (roomLabel) {
    return `Scoped to the measured ${roomLabel}.`;
  }

  return null;
}

function buildScopedQuery(productType, category, context, matchedObject, quantityEstimate) {
  const parts = [];
  const baseKeyword = category?.keywords?.[0] || productType.replace(/_/g, ' ');
  const width = roundDimensionInches(matchedObject?.dimensions?.widthInches);
  const height = roundDimensionInches(matchedObject?.dimensions?.heightInches);
  const roomLabel = formatRoomLabel(context.measurements?.roomType || context.room);
  const styleHints = extractStyleHints(context.suggestionName || context.projectName || '');

  parts.push(baseKeyword);

  if (width && height && ['bathroom_mirror', 'window'].includes(productType)) {
    parts.push(`${width} x ${height} inch`);
  } else if (width && ['vanity', 'toilet', 'bathtub', 'shower', 'countertop'].includes(productType)) {
    parts.push(`${width} inch`);
  }

  if (quantityEstimate?.unit === 'sqft' && quantityEstimate?.quantity > 1) {
    parts.push(`${Math.round(quantityEstimate.quantity)} sq ft`);
  }

  if (roomLabel) {
    parts.push(roomLabel);
  }

  if (styleHints) {
    parts.push(styleHints);
  }

  return parts.filter(Boolean).join(' ');
}

function buildProductSearchContext({ productType, measurements, materialBreakdown, suggestionName, projectName, room }) {
  const matchedObject = findMatchingObject(productType, measurements?.objectMeasurements || []);
  const matchedMaterial = findMatchingMaterial(productType, materialBreakdown || []);
  const quantityEstimate = deriveQuantityEstimate(productType, { measurements, room }, matchedMaterial);
  const query = buildScopedQuery(productType, PRODUCT_CATEGORIES[productType], { measurements, suggestionName, projectName, room }, matchedObject, quantityEstimate);

  return {
    query,
    quantityEstimate,
    fitSummary: buildFitSummary(productType, matchedObject, quantityEstimate, measurements),
    matchedObject: matchedObject ? {
      type: matchedObject.type,
      description: matchedObject.description,
      dimensions: matchedObject.dimensions,
    } : null,
    matchedMaterial: matchedMaterial ? {
      item: matchedMaterial.item,
      quantity: matchedMaterial.quantity,
      unit: matchedMaterial.unit,
      category: matchedMaterial.category,
    } : null,
    roomLabel: formatRoomLabel(measurements?.roomType || room),
  };
}

/**
 * Search for products with live pricing from major retailers
 */
export async function searchProducts({
  productType,
  query,
  qualityLevel = 'midRange',
  zipCode,
  limit = 10
}) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
    return { ok: false, error: 'Google Search API not configured' };
  }

  try {
    // Get category info for optimized search
    const category = PRODUCT_CATEGORIES[productType] || null;
    const searchKeywords = category?.keywords?.[0] || productType;
    
    // Build optimized search query
    let searchQuery = query || searchKeywords;
    
    // Add price range filters based on quality level
    if (category?.priceRange) {
      const priceRange = category.priceRange[qualityLevel] || category.priceRange.midRange;
      if (priceRange) {
        searchQuery += ` $${priceRange[0]}-$${priceRange[1]}`;
      }
    }
    
    // Add retailer focus
    searchQuery += ' site:homedepot.com OR site:lowes.com OR site:amazon.com OR site:wayfair.com';
    
    console.log(`[Product Search] Query: "${searchQuery}"`);

    // Execute Google Custom Search
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', GOOGLE_API_KEY);
    url.searchParams.set('cx', GOOGLE_CSE_CX);
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('num', Math.min(limit, 10));

    const searchResponse = await fetch(url.toString());
    const searchResults = await searchResponse.json();

    if (!searchResults.items || searchResults.items.length === 0) {
      // Try simpler search without site restrictions
      console.log('[Product Search] No results, trying broader search...');
      url.searchParams.set('q', query || searchKeywords);
      const retryResponse = await fetch(url.toString());
      const retryResults = await retryResponse.json();
      
      if (!retryResults.items || retryResults.items.length === 0) {
        const dimensionHint = extractDimensionHint(query);
        const fallbackQueries = [
          dimensionHint ? `${searchKeywords} ${dimensionHint}` : '',
          searchKeywords,
        ].filter(Boolean);

        let relaxedResults = null;
        for (const fallbackQuery of fallbackQueries) {
          console.log(`[Product Search] Retrying with relaxed query: "${fallbackQuery}"`);
          url.searchParams.set('q', fallbackQuery);
          const relaxedResponse = await fetch(url.toString());
          const relaxedPayload = await relaxedResponse.json();
          if (relaxedPayload.items?.length) {
            relaxedResults = relaxedPayload;
            break;
          }
        }

        if (!relaxedResults?.items?.length) {
          return { ok: false, error: 'No products found', products: [] };
        }

        searchResults.items = relaxedResults.items;
      } else {
        searchResults.items = retryResults.items;
      }
    }

    // Extract product data using GPT-4o
    const products = await extractProductData(searchResults.items, productType, category);
    
    // Add local store info if zip code provided
    if (zipCode) {
      for (const product of products) {
        product.localStores = getLocalStoreInfo(product.retailer, zipCode);
      }
    }

    return {
      ok: true,
      query: searchQuery,
      productType,
      qualityLevel,
      category: category ? {
        name: productType,
        specs: category.specs,
        expectedPriceRange: category.priceRange[qualityLevel],
        unit: category.unit || 'each'
      } : null,
      products,
      localStoreLinks: zipCode ? getStoreLocatorLinks(zipCode) : null,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('[Product Search] Error:', error);
    return { ok: false, error: error.message, products: [] };
  }
}

/**
 * Extract structured product data from search results using GPT-4o
 */
async function extractProductData(searchItems, productType, category) {
  const products = [];
  
  // First, try to extract basic info without API call
  for (const item of searchItems) {
    const product = {
      title: item.title?.replace(/ - .*$/, '').trim() || 'Unknown Product',
      url: item.link,
      retailer: identifyRetailer(item.link),
      snippet: item.snippet,
      image: item.pagemap?.cse_image?.[0]?.src || item.pagemap?.product?.[0]?.image || null,
      price: null,
      specs: {},
      inStock: null
    };
    
    // Try to extract price from snippet or metatags
    const priceMatch = item.snippet?.match(/\$[\d,]+(?:\.\d{2})?/) || 
                      item.pagemap?.metatags?.[0]?.['product:price:amount'];
    if (priceMatch) {
      const priceStr = typeof priceMatch === 'string' ? priceMatch : priceMatch[0];
      product.price = parseFloat(priceStr.replace(/[$,]/g, ''));
    }
    
    // Extract from structured data if available
    if (item.pagemap?.product?.[0]) {
      const productData = item.pagemap.product[0];
      if (productData.price && !product.price) {
        product.price = parseFloat(productData.price.replace(/[$,]/g, ''));
      }
      if (productData.name) {
        product.title = productData.name;
      }
    }
    
    // Get rating if available
    if (item.pagemap?.aggregaterating?.[0]) {
      product.rating = {
        value: parseFloat(item.pagemap.aggregaterating[0].ratingvalue) || null,
        count: parseInt(item.pagemap.aggregaterating[0].ratingcount) || null
      };
    }
    
    products.push(product);
  }
  
  // Use GPT to enhance product data and extract prices we couldn't get
  if (OPENAI_API_KEY && products.some(p => !p.price)) {
    try {
      const enrichedProducts = await enrichWithGPT(products, productType, category);
      return enrichedProducts;
    } catch (error) {
      console.warn('[Product Search] GPT enrichment failed:', error.message);
    }
  }
  
  return products;
}

/**
 * Use GPT-4o-mini to extract product details from snippets
 */
async function enrichWithGPT(products, productType, category) {
  const prompt = `Extract product information from these search results for "${productType}".

For each product, provide:
- price (numeric, in USD)
- modelNumber (if visible)
- keySpecs (relevant specifications)
- estimatedPrice (your best estimate if price not shown, based on product type)

Products to analyze:
${products.map((p, i) => `${i + 1}. ${p.title}
   URL: ${p.url}
   Snippet: ${p.snippet}
   Current price: ${p.price || 'unknown'}`).join('\n\n')}

${category ? `Expected specs for ${productType}: ${category.specs.join(', ')}` : ''}

Return JSON array matching the order above:
[{"price": 299.99, "modelNumber": "ABC123", "keySpecs": {"size": "30 inch", "finish": "chrome"}, "estimatedPrice": 299.99}, ...]`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You extract product pricing and specifications from search snippets. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.3
    })
  });

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  
  if (!content) return products;
  
  try {
    // Parse JSON from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return products;
    
    const enrichedData = JSON.parse(jsonMatch[0]);
    
    // Merge enriched data with products
    products.forEach((product, i) => {
      if (enrichedData[i]) {
        if (!product.price && enrichedData[i].price) {
          product.price = enrichedData[i].price;
        }
        if (!product.price && enrichedData[i].estimatedPrice) {
          product.price = enrichedData[i].estimatedPrice;
          product.priceEstimated = true;
        }
        if (enrichedData[i].modelNumber) {
          product.modelNumber = enrichedData[i].modelNumber;
        }
        if (enrichedData[i].keySpecs) {
          product.specs = { ...product.specs, ...enrichedData[i].keySpecs };
        }
      }
    });
  } catch (e) {
    console.warn('[Product Search] Failed to parse GPT response:', e.message);
  }
  
  return products;
}

/**
 * Identify retailer from URL
 */
function identifyRetailer(url) {
  for (const retailer of PRIORITY_RETAILERS) {
    if (url.includes(retailer.domain)) {
      return {
        name: retailer.name,
        domain: retailer.domain,
        hasLocalStores: !!retailer.storeLocator
      };
    }
  }
  
  // Try to extract domain name
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return {
      name: domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1),
      domain: domain,
      hasLocalStores: false
    };
  } catch {
    return { name: 'Unknown', domain: null, hasLocalStores: false };
  }
}

/**
 * Get local store info for a retailer
 */
function getLocalStoreInfo(retailer, zipCode) {
  const storeInfo = PRIORITY_RETAILERS.find(r => r.name === retailer?.name);
  
  if (!storeInfo?.storeLocator) {
    return null;
  }
  
  return {
    storeLocatorUrl: `${storeInfo.storeLocator}?zipCode=${zipCode}`,
    checkAvailabilityTip: `Visit ${storeInfo.name} website and enter your ZIP code (${zipCode}) to check local stock`
  };
}

/**
 * Get store locator links for all major retailers
 */
function getStoreLocatorLinks(zipCode) {
  return PRIORITY_RETAILERS
    .filter(r => r.storeLocator)
    .map(r => ({
      retailer: r.name,
      storeLocatorUrl: `${r.storeLocator}?zipCode=${zipCode}`,
      domain: r.domain
    }));
}

function buildRetailerSearchLinks(query) {
  const encoded = encodeURIComponent(query || '');
  return [
    { retailer: 'Home Depot', url: `https://www.homedepot.com/s/${encoded}` },
    { retailer: 'Lowe\'s', url: `https://www.lowes.com/search?searchTerm=${encoded}` },
    { retailer: 'Amazon', url: `https://www.amazon.com/s?k=${encoded}` },
    { retailer: 'Wayfair', url: `https://www.wayfair.com/keyword.php?keyword=${encoded}` },
  ];
}

/**
 * Search for specific product by model number or exact name
 */
export async function searchExactProduct(modelNumber, retailer = null) {
  let query = modelNumber;
  
  if (retailer) {
    const retailerInfo = PRIORITY_RETAILERS.find(
      r => r.name.toLowerCase() === retailer.toLowerCase()
    );
    if (retailerInfo) {
      query += ` site:${retailerInfo.domain}`;
    }
  }
  
  return searchProducts({
    productType: 'exact',
    query: query,
    limit: 5
  });
}

/**
 * Get product recommendations for a renovation project
 */
export async function getProductRecommendations({
  projectType,
  qualityLevel = 'midRange',
  zipCode,
  room,
  measurements = null,
  materialBreakdown = [],
  suggestionName = '',
  projectName = ''
}) {
  // Map project types to required products
  const projectProducts = {
    bathroom_full_remodel: ['vanity', 'toilet', 'bathtub', 'shower', 'bathroom_faucet', 'bathroom_sink', 'bathroom_mirror', 'vanity_light', 'exhaust_fan'],
    bathroom_vanity_replace: ['vanity', 'bathroom_faucet', 'bathroom_mirror', 'vanity_light'],
    bathroom_refresh: ['bathroom_faucet', 'toilet', 'bathroom_sink', 'bathroom_mirror', 'vanity_light'],
    bathroom_toilet_replace: ['toilet'],
    bathroom_faucet_replace: ['bathroom_faucet'],
    bathroom_mirror_replace: ['bathroom_mirror'],
    bathroom_lighting_update: ['vanity_light'],
    bathroom_exhaust_update: ['exhaust_fan'],
    bathroom_shower_update: ['shower'],
    bathroom_tub_replace: ['bathtub'],
    bathroom_countertop_replace: ['countertop', 'bathroom_faucet', 'bathroom_sink'],
    kitchen_full_remodel: ['kitchen_sink', 'kitchen_faucet', 'range_hood', 'garbage_disposal', 'dishwasher', 'range', 'refrigerator'],
    kitchen_countertop_replace: ['countertop'],
    kitchen_cabinet_replace: ['kitchen_cabinet'],
    kitchen_sink_replace: ['kitchen_sink'],
    kitchen_faucet_replace: ['kitchen_faucet'],
    flooring_hardwood: ['hardwood_flooring'],
    flooring_lvp: ['lvp_flooring'],
    flooring_tile: ['tile_flooring'],
    hvac_update: ['water_heater', 'thermostat'],
    lighting_update: ['ceiling_fan', 'recessed_light', 'pendant_light', 'vanity_light'],
    window_replace: ['window'],
  };
  
  const requiredProducts = projectProducts[projectType] || [];
  
  if (requiredProducts.length === 0) {
    return { ok: false, error: `Unknown project type: ${projectType}` };
  }
  
  // Search for each product type in parallel
  const productSearches = await Promise.all(
    requiredProducts.map(async (productType) => {
      const searchContext = buildProductSearchContext({
        productType,
        measurements,
        materialBreakdown,
        suggestionName,
        projectName,
        room,
      });

      const search = await searchProducts({
        productType,
        query: searchContext.query,
        qualityLevel,
        zipCode,
        limit: 3,
      });

      return {
        productType,
        search,
        searchContext,
      };
    })
  );
  
  // Compile results
  const recommendations = {};
  let totalEstimate = 0;
  
  requiredProducts.forEach((productType, i) => {
    const { search, searchContext } = productSearches[i];
    const categoryMeta = search.category || (PRODUCT_CATEGORIES[productType]
      ? {
          name: productType,
          specs: PRODUCT_CATEGORIES[productType].specs,
          expectedPriceRange: PRODUCT_CATEGORIES[productType].priceRange[qualityLevel],
          unit: PRODUCT_CATEGORIES[productType].unit || 'each',
        }
      : null);
    const quantity = Math.max(1, Number(searchContext.quantityEstimate?.quantity || 1));

    if (search.ok && search.products.length > 0) {
      recommendations[productType] = {
        category: categoryMeta,
        products: search.products,
        bestValue: search.products.find(p => p.price) || search.products[0],
        quantityEstimate: searchContext.quantityEstimate,
        fitSummary: searchContext.fitSummary,
        matchedObject: searchContext.matchedObject,
        matchedMaterial: searchContext.matchedMaterial,
        searchQuery: search.query,
        retailerSearchLinks: buildRetailerSearchLinks(searchContext.query),
        liveResult: true,
        priceRange: {
          low: Math.min(...search.products.filter(p => p.price).map(p => p.price)) || null,
          high: Math.max(...search.products.filter(p => p.price).map(p => p.price)) || null
        }
      };
      
      // Add to total estimate
      const avgPrice = recommendations[productType].priceRange.low && recommendations[productType].priceRange.high
        ? (recommendations[productType].priceRange.low + recommendations[productType].priceRange.high) / 2
        : categoryMeta?.expectedPriceRange?.[1] || 0;
      recommendations[productType].estimatedTotal = Math.round(avgPrice * quantity);
      totalEstimate += avgPrice * quantity;
    } else {
      const expectedRange = categoryMeta?.expectedPriceRange || null;
      const avgPrice = expectedRange ? (expectedRange[0] + expectedRange[1]) / 2 : 0;
      recommendations[productType] = {
        category: categoryMeta,
        products: [],
        bestValue: null,
        quantityEstimate: searchContext.quantityEstimate,
        fitSummary: searchContext.fitSummary,
        matchedObject: searchContext.matchedObject,
        matchedMaterial: searchContext.matchedMaterial,
        searchQuery: searchContext.query,
        retailerSearchLinks: buildRetailerSearchLinks(searchContext.query),
        liveResult: false,
        priceRange: expectedRange ? {
          low: expectedRange[0],
          high: expectedRange[1],
        } : {
          low: null,
          high: null,
        },
        estimatedTotal: Math.round(avgPrice * quantity),
      };
      totalEstimate += avgPrice * quantity;
    }
  });
  
  return {
    ok: true,
    projectType,
    qualityLevel,
    zipCode,
    recommendations,
    totalMaterialEstimate: Math.round(totalEstimate),
    localStoreLinks: zipCode ? getStoreLocatorLinks(zipCode) : null,
    scopeNote: 'Queries and totals are scoped to measured room quantities and fixture dimensions when available. Verify final field dimensions before ordering.',
    timestamp: new Date().toISOString()
  };
}

/**
 * Compare prices across retailers for a specific product
 */
export async function compareProductPrices({
  productName,
  productType,
  zipCode
}) {
  // Search each major retailer
  const retailers = ['Home Depot', 'Lowe\'s', 'Amazon', 'Wayfair'];
  
  const searches = await Promise.all(
    retailers.map(async retailer => {
      const retailerInfo = PRIORITY_RETAILERS.find(r => r.name === retailer);
      if (!retailerInfo) return null;
      
      const query = `${productName} site:${retailerInfo.domain}`;
      
      try {
        const url = new URL('https://www.googleapis.com/customsearch/v1');
        url.searchParams.set('key', GOOGLE_API_KEY);
        url.searchParams.set('cx', GOOGLE_CSE_CX);
        url.searchParams.set('q', query);
        url.searchParams.set('num', 3);
        
        const response = await fetch(url.toString());
        const results = await response.json();
        
        if (!results.items?.length) return null;
        
        const products = await extractProductData(results.items, productType, null);
        
        return {
          retailer,
          products: products.filter(p => p.price),
          lowestPrice: Math.min(...products.filter(p => p.price).map(p => p.price)) || null,
          hasLocalStore: !!retailerInfo.storeLocator,
          storeLocatorUrl: retailerInfo.storeLocator ? `${retailerInfo.storeLocator}?zipCode=${zipCode}` : null
        };
      } catch (error) {
        console.warn(`[Price Compare] ${retailer} search failed:`, error.message);
        return null;
      }
    })
  );
  
  const validResults = searches.filter(Boolean);
  
  // Find best price
  const allPrices = validResults.flatMap(r => r.products.map(p => ({ ...p, retailer: r.retailer })));
  const bestDeal = allPrices.sort((a, b) => (a.price || Infinity) - (b.price || Infinity))[0];
  
  return {
    ok: true,
    productName,
    comparison: validResults,
    bestDeal: bestDeal ? {
      retailer: bestDeal.retailer,
      price: bestDeal.price,
      title: bestDeal.title,
      url: bestDeal.url
    } : null,
    priceRange: {
      low: Math.min(...allPrices.filter(p => p.price).map(p => p.price)) || null,
      high: Math.max(...allPrices.filter(p => p.price).map(p => p.price)) || null
    },
    timestamp: new Date().toISOString()
  };
}

// Export product categories for reference
export { PRODUCT_CATEGORIES, PRIORITY_RETAILERS };

export default {
  searchProducts,
  searchExactProduct,
  getProductRecommendations,
  compareProductPrices,
  PRODUCT_CATEGORIES,
  PRIORITY_RETAILERS
};
