/**
 * Comprehensive Renovation Cost Database
 * 
 * Industry-standard baseline costs based on:
 * - RSMeans Construction Cost Data 2024-2025
 * - National Association of Home Builders (NAHB) Cost Survey
 * - Bureau of Labor Statistics (BLS) Occupational Employment and Wages
 * - Home improvement retailer pricing (Home Depot, Lowe's)
 * 
 * All costs are in 2025 dollars, adjusted for national average.
 * Use getRegionalMultiplier() to adjust for specific ZIP codes.
 */

import 'dotenv/config';

// ============================================================================
// REGIONAL COST MULTIPLIERS
// Based on BLS Regional Price Parities and RSMeans City Cost Index
// National average = 1.00
// ============================================================================
export const REGIONAL_MULTIPLIERS = {
  // West Coast (High Cost)
  '94': 1.42, // San Francisco Bay Area
  '90': 1.28, // Los Angeles area  
  '91': 1.25, // Pasadena/Glendale
  '92': 1.22, // Orange County
  '93': 1.15, // Central Coast CA
  '95': 1.35, // San Jose/Silicon Valley
  '96': 1.18, // Sacramento area
  '97': 1.12, // Oregon
  '98': 1.18, // Seattle/Western WA
  '99': 1.08, // Eastern WA

  // Northeast (High Cost)
  '10': 1.45, // Manhattan
  '11': 1.32, // Brooklyn/Queens
  '06': 1.28, // Connecticut
  '02': 1.25, // Boston area
  '07': 1.22, // Northern NJ
  '08': 1.18, // Southern NJ
  '19': 1.15, // Philadelphia
  '20': 1.22, // Washington DC
  '21': 1.12, // Baltimore/Maryland

  // Mountain West
  '80': 1.08, // Colorado
  '84': 1.02, // Utah
  '85': 0.98, // Phoenix area
  '87': 0.95, // New Mexico
  '89': 1.05, // Las Vegas

  // Midwest (Lower Cost)
  '60': 1.12, // Chicago area
  '43': 0.92, // Columbus OH
  '44': 0.88, // Cleveland
  '48': 0.95, // Detroit area
  '55': 0.98, // Minneapolis
  '63': 0.88, // St. Louis
  '46': 0.85, // Indianapolis

  // South (Lower Cost)
  '30': 0.92, // Atlanta area
  '32': 0.95, // Florida
  '33': 1.02, // Miami/Ft Lauderdale
  '37': 0.88, // Nashville area
  '38': 0.85, // Memphis
  '75': 0.92, // Dallas area
  '77': 0.95, // Houston area
  '78': 0.90, // San Antonio/Austin

  // Default for unlisted prefixes
  'default': 1.00
};

// More specific cost premiums layered on top of the ZIP-prefix baseline.
// These focus on well-known high-cost pockets where labor especially runs above
// the broader state or ZIP-prefix average.
export const LOCATION_COST_ADJUSTMENTS = {
  state: {
    'ca': { labor: 1.06, materials: 1.04, label: 'California' },
    'dc': { labor: 1.08, materials: 1.04, label: 'District of Columbia' },
    'ma': { labor: 1.05, materials: 1.03, label: 'Massachusetts' },
    'md': { labor: 1.04, materials: 1.02, label: 'Maryland' },
    'nj': { labor: 1.05, materials: 1.03, label: 'New Jersey' },
    'ny': { labor: 1.07, materials: 1.04, label: 'New York' },
    'va': { labor: 1.03, materials: 1.02, label: 'Virginia' },
    'ky': { labor: 0.90, materials: 0.96, label: 'Kentucky' },
    'tn': { labor: 0.92, materials: 0.97, label: 'Tennessee' },
    'in': { labor: 0.91, materials: 0.96, label: 'Indiana' },
    'oh': { labor: 0.93, materials: 0.97, label: 'Ohio' },
  },
  county: {
    'montgomery county, md': { labor: 1.12, materials: 1.04, label: 'Montgomery County, MD' },
    'fairfax county, va': { labor: 1.10, materials: 1.04, label: 'Fairfax County, VA' },
    'arlington county, va': { labor: 1.11, materials: 1.04, label: 'Arlington County, VA' },
    'new york county, ny': { labor: 1.18, materials: 1.06, label: 'New York County, NY' },
    'san francisco county, ca': { labor: 1.18, materials: 1.08, label: 'San Francisco County, CA' },
    'los angeles county, ca': { labor: 1.10, materials: 1.05, label: 'Los Angeles County, CA' },
    'jefferson county, ky': { labor: 0.94, materials: 0.98, label: 'Jefferson County, KY' },
    'fayette county, ky': { labor: 0.93, materials: 0.97, label: 'Fayette County, KY' },
  },
  city: {
    'potomac, md': { labor: 1.16, materials: 1.05, label: 'Potomac, MD' },
    'bethesda, md': { labor: 1.15, materials: 1.05, label: 'Bethesda, MD' },
    'chevy chase, md': { labor: 1.15, materials: 1.05, label: 'Chevy Chase, MD' },
    'rockville, md': { labor: 1.10, materials: 1.04, label: 'Rockville, MD' },
    'washington, dc': { labor: 1.14, materials: 1.05, label: 'Washington, DC' },
    'arlington, va': { labor: 1.12, materials: 1.04, label: 'Arlington, VA' },
    'alexandria, va': { labor: 1.10, materials: 1.04, label: 'Alexandria, VA' },
    'san francisco, ca': { labor: 1.20, materials: 1.08, label: 'San Francisco, CA' },
    'san jose, ca': { labor: 1.17, materials: 1.07, label: 'San Jose, CA' },
    'manhattan, ny': { labor: 1.20, materials: 1.08, label: 'Manhattan, NY' },
    'brooklyn, ny': { labor: 1.12, materials: 1.05, label: 'Brooklyn, NY' },
    'lexington, ky': { labor: 0.93, materials: 0.98, label: 'Lexington, KY' },
    'louisville, ky': { labor: 0.94, materials: 0.98, label: 'Louisville, KY' },
    'bowling green, ky': { labor: 0.90, materials: 0.96, label: 'Bowling Green, KY' },
  },
  metro: {
    'washington-arlington-alexandria': { labor: 1.10, materials: 1.04, label: 'Washington-Arlington-Alexandria Metro' },
    'san francisco-oakland-berkeley': { labor: 1.16, materials: 1.07, label: 'San Francisco-Oakland-Berkeley Metro' },
    'san jose-sunnyvale-santa clara': { labor: 1.15, materials: 1.07, label: 'San Jose-Sunnyvale-Santa Clara Metro' },
    'new york-newark-jersey city': { labor: 1.14, materials: 1.05, label: 'New York-Newark-Jersey City Metro' },
    'los angeles-long beach-anaheim': { labor: 1.08, materials: 1.04, label: 'Los Angeles-Long Beach-Anaheim Metro' },
    'boston-cambridge-newton': { labor: 1.08, materials: 1.04, label: 'Boston-Cambridge-Newton Metro' },
    'louisville-jefferson county': { labor: 0.95, materials: 0.98, label: 'Louisville-Jefferson County Metro' },
  }
};

function normalizeLocationKey(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractParsedAddress(address = '') {
  const parsed = {
    address,
    zipCode: '',
    city: '',
    state: '',
  };

  if (!address || typeof address !== 'string') {
    return parsed;
  }

  const zipMatch = address.match(/\b\d{5}(?:-\d{4})?\b/);
  if (zipMatch) {
    parsed.zipCode = zipMatch[0].substring(0, 5);
  }

  const parts = address.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    parsed.city = parts[parts.length - 2] || '';
    const stateZipPart = parts[parts.length - 1] || '';
    const stateMatch = stateZipPart.match(/\b([A-Z]{2})\b/i);
    if (stateMatch) {
      parsed.state = stateMatch[1].toUpperCase();
    }
  }

  return parsed;
}

function normalizeLocationInput(locationInput) {
  if (!locationInput) {
    return {
      zipCode: '',
      city: '',
      state: '',
      county: '',
      metro: '',
      address: '',
    };
  }

  if (typeof locationInput === 'string') {
    if (/^\d{5}$/.test(locationInput)) {
      return {
        zipCode: locationInput,
        city: '',
        state: '',
        county: '',
        metro: '',
        address: '',
      };
    }

    const parsed = extractParsedAddress(locationInput);
    return {
      zipCode: parsed.zipCode,
      city: parsed.city,
      state: parsed.state,
      county: '',
      metro: '',
      address: locationInput,
    };
  }

  const address = locationInput.address || locationInput.location || '';
  const parsed = extractParsedAddress(address);

  return {
    zipCode: String(locationInput.zipCode || parsed.zipCode || '').substring(0, 5),
    city: locationInput.city || parsed.city || '',
    state: (locationInput.state || parsed.state || '').toUpperCase(),
    county: locationInput.county || '',
    metro: locationInput.metro || locationInput.metroArea || '',
    address,
  };
}

function getBaseRegionalMultiplier(zipCode) {
  if (!zipCode || zipCode.length < 2) return 1.00;
  const prefix = zipCode.substring(0, 2);
  return REGIONAL_MULTIPLIERS[prefix] || REGIONAL_MULTIPLIERS['default'];
}

function getSpecificLocationAdjustment(context) {
  const stateKey = normalizeLocationKey(context.state);
  const cityKey = normalizeLocationKey(
    context.city && context.state ? `${context.city}, ${context.state}` : context.city
  );
  const countyKey = normalizeLocationKey(
    context.county && context.state ? `${context.county}, ${context.state}` : context.county
  );
  const metroKey = normalizeLocationKey(context.metro)
    .replace(/ msa| metro area| metropolitan area/g, '');

  const candidates = [
    { scope: 'city', key: cityKey, match: LOCATION_COST_ADJUSTMENTS.city[cityKey] },
    { scope: 'county', key: countyKey, match: LOCATION_COST_ADJUSTMENTS.county[countyKey] },
    { scope: 'metro', key: metroKey, match: LOCATION_COST_ADJUSTMENTS.metro[metroKey] },
    { scope: 'state', key: stateKey.toLowerCase(), match: LOCATION_COST_ADJUSTMENTS.state[stateKey.toLowerCase()] },
  ];

  const match = candidates.find(candidate => candidate.key && candidate.match);
  if (match) {
    return {
      labor: match.match.labor,
      materials: match.match.materials,
      source: match.scope,
      label: match.match.label,
    };
  }

  return {
    labor: 1.0,
    materials: 1.0,
    source: 'zip',
    label: context.zipCode ? `ZIP ${context.zipCode}` : 'National Average',
  };
}

export function getRegionalCostAdjustmentDetails(locationInput) {
  const context = normalizeLocationInput(locationInput);
  const zipMultiplier = getBaseRegionalMultiplier(context.zipCode);
  const specificAdjustment = getSpecificLocationAdjustment(context);
  const laborMultiplier = Math.round(zipMultiplier * specificAdjustment.labor * 1000) / 1000;
  const materialMultiplier = Math.round(zipMultiplier * specificAdjustment.materials * 1000) / 1000;
  const overallMultiplier = Math.round(zipMultiplier * ((specificAdjustment.labor + specificAdjustment.materials) / 2) * 1000) / 1000;

  return {
    zipMultiplier,
    laborMultiplier,
    materialMultiplier,
    overallMultiplier,
    source: specificAdjustment.source,
    label: specificAdjustment.label,
    context,
  };
}

/**
 * Get the regional cost multiplier for a ZIP code
 */
export function getRegionalMultiplier(locationInput, costType = 'overall') {
  const details = getRegionalCostAdjustmentDetails(locationInput);

  if (costType === 'labor') {
    return details.laborMultiplier;
  }

  if (costType === 'material') {
    return details.materialMultiplier;
  }

  return details.overallMultiplier;
}

// ============================================================================
// LABOR RATES BY TRADE TYPE
// Based on BLS Occupational Employment and Wages, May 2024
// Includes 30% overhead/profit margin typical for contractors
// ============================================================================
export const LABOR_RATES = {
  // General/Unskilled Labor
  'general_labor': { low: 25, avg: 35, high: 50, description: 'General helper, cleanup, demo' },
  'handyman': { low: 35, avg: 50, high: 75, description: 'Multi-trade handyman work' },
  
  // Skilled Trades
  'carpenter': { low: 45, avg: 65, high: 95, description: 'Finish carpentry, framing, trim' },
  'finish_carpenter': { low: 55, avg: 80, high: 120, description: 'Custom cabinetry, millwork' },
  'cabinet_installer': { low: 50, avg: 70, high: 100, description: 'Cabinet installation' },
  
  // Flooring
  'flooring_installer': { low: 40, avg: 60, high: 85, description: 'Hardwood, LVP, tile floors' },
  'tile_setter': { low: 50, avg: 75, high: 110, description: 'Tile installation, backsplash' },
  'carpet_installer': { low: 35, avg: 50, high: 70, description: 'Carpet installation' },
  
  // Painting
  'painter': { low: 35, avg: 55, high: 80, description: 'Interior/exterior painting' },
  'drywall_finisher': { low: 45, avg: 65, high: 90, description: 'Drywall finishing, texturing' },
  
  // MEP Trades (Mechanical, Electrical, Plumbing)
  'plumber': { low: 75, avg: 110, high: 160, description: 'Licensed plumber' },
  'electrician': { low: 75, avg: 105, high: 150, description: 'Licensed electrician' },
  'hvac_technician': { low: 70, avg: 100, high: 145, description: 'HVAC installation/repair' },
  
  // Specialty Trades
  'countertop_installer': { low: 55, avg: 80, high: 120, description: 'Countertop fabrication/install' },
  'appliance_installer': { low: 50, avg: 75, high: 100, description: 'Appliance hookup' },
  'roofer': { low: 45, avg: 65, high: 95, description: 'Roofing installation' },
  'siding_installer': { low: 45, avg: 60, high: 85, description: 'Siding installation' },
  'window_installer': { low: 50, avg: 70, high: 100, description: 'Window replacement' },
  'landscaper': { low: 35, avg: 55, high: 80, description: 'Landscaping, hardscape' },
  'mason': { low: 55, avg: 80, high: 120, description: 'Brick, stone, concrete' },
  'insulation_installer': { low: 40, avg: 55, high: 75, description: 'Insulation installation' },
  'gutter_installer': { low: 40, avg: 55, high: 75, description: 'Gutter installation' },
  'demolition': { low: 30, avg: 45, high: 65, description: 'Demolition and hauling' }
};

/**
 * Get labor rate for a trade type, adjusted for region
 */
export function getLaborRate(tradeType, zipCode, level = 'avg') {
  const normalizedTrade = tradeType.toLowerCase().replace(/\s+/g, '_');
  const trade = LABOR_RATES[normalizedTrade] || LABOR_RATES['general_labor'];
  const multiplier = getRegionalMultiplier(zipCode, 'labor');
  
  const rate = trade[level] || trade.avg;
  return Math.round(rate * multiplier);
}

// ============================================================================
// MATERIAL COSTS DATABASE
// Based on Home Depot, Lowe's, and distributor pricing (2024-2025)
// Prices are per unit as specified
// ============================================================================
export const MATERIAL_COSTS = {
  // FLOORING
  'flooring': {
    'lvp_luxury_vinyl_plank': { unit: 'sq_ft', low: 2.50, avg: 4.00, high: 7.00 },
    'lvp_mid_grade': { unit: 'sq_ft', low: 2.00, avg: 3.00, high: 4.50 },
    'lvp_budget': { unit: 'sq_ft', low: 1.50, avg: 2.25, high: 3.00 },
    'hardwood_oak': { unit: 'sq_ft', low: 5.00, avg: 8.00, high: 14.00 },
    'hardwood_prefinished': { unit: 'sq_ft', low: 4.00, avg: 6.50, high: 10.00 },
    'engineered_hardwood': { unit: 'sq_ft', low: 3.50, avg: 5.50, high: 9.00 },
    'laminate': { unit: 'sq_ft', low: 1.00, avg: 2.00, high: 4.00 },
    'tile_ceramic': { unit: 'sq_ft', low: 1.50, avg: 4.00, high: 8.00 },
    'tile_porcelain': { unit: 'sq_ft', low: 3.00, avg: 6.00, high: 15.00 },
    'carpet': { unit: 'sq_ft', low: 2.00, avg: 4.00, high: 8.00 },
    'underlayment': { unit: 'sq_ft', low: 0.25, avg: 0.50, high: 1.00 },
    'floor_transition': { unit: 'each', low: 15, avg: 30, high: 60 }
  },

  // COUNTERTOPS
  'countertops': {
    'granite': { unit: 'sq_ft', low: 40, avg: 60, high: 100 },
    'quartz': { unit: 'sq_ft', low: 50, avg: 75, high: 150 },
    'marble': { unit: 'sq_ft', low: 75, avg: 100, high: 200 },
    'quartzite': { unit: 'sq_ft', low: 80, avg: 120, high: 200 },
    'butcher_block': { unit: 'sq_ft', low: 40, avg: 65, high: 100 },
    'laminate': { unit: 'sq_ft', low: 10, avg: 25, high: 50 },
    'solid_surface_corian': { unit: 'sq_ft', low: 40, avg: 60, high: 100 },
    'concrete': { unit: 'sq_ft', low: 65, avg: 100, high: 150 }
  },

  // CABINETS
  'cabinets': {
    'stock_base': { unit: 'linear_ft', low: 80, avg: 150, high: 250 },
    'stock_upper': { unit: 'linear_ft', low: 60, avg: 120, high: 200 },
    'semi_custom_base': { unit: 'linear_ft', low: 150, avg: 275, high: 400 },
    'semi_custom_upper': { unit: 'linear_ft', low: 120, avg: 225, high: 350 },
    'custom_base': { unit: 'linear_ft', low: 400, avg: 650, high: 1200 },
    'custom_upper': { unit: 'linear_ft', low: 350, avg: 550, high: 1000 },
    'cabinet_hardware': { unit: 'each', low: 3, avg: 8, high: 25 },
    'soft_close_hinges': { unit: 'each', low: 2, avg: 5, high: 12 }
  },

  // APPLIANCES
  'appliances': {
    'refrigerator_basic': { unit: 'each', low: 800, avg: 1200, high: 2000 },
    'refrigerator_french_door': { unit: 'each', low: 1500, avg: 2500, high: 4500 },
    'range_gas': { unit: 'each', low: 500, avg: 900, high: 2000 },
    'range_electric': { unit: 'each', low: 450, avg: 750, high: 1500 },
    'range_induction': { unit: 'each', low: 1200, avg: 2000, high: 4000 },
    'dishwasher': { unit: 'each', low: 400, avg: 700, high: 1200 },
    'microwave_over_range': { unit: 'each', low: 200, avg: 400, high: 800 },
    'garbage_disposal': { unit: 'each', low: 100, avg: 200, high: 400 },
    'range_hood': { unit: 'each', low: 150, avg: 400, high: 1200 },
    'washer': { unit: 'each', low: 500, avg: 800, high: 1500 },
    'dryer': { unit: 'each', low: 500, avg: 800, high: 1400 }
  },

  // PLUMBING FIXTURES
  'plumbing': {
    'kitchen_sink_stainless': { unit: 'each', low: 150, avg: 350, high: 800 },
    'kitchen_sink_farmhouse': { unit: 'each', low: 300, avg: 600, high: 1500 },
    'kitchen_faucet': { unit: 'each', low: 100, avg: 250, high: 600 },
    'bathroom_sink_vanity': { unit: 'each', low: 60, avg: 150, high: 400 },
    'bathroom_faucet': { unit: 'each', low: 50, avg: 150, high: 400 },
    'toilet_standard': { unit: 'each', low: 150, avg: 300, high: 600 },
    'toilet_dual_flush': { unit: 'each', low: 250, avg: 400, high: 700 },
    'bathtub_standard': { unit: 'each', low: 300, avg: 600, high: 1500 },
    'bathtub_freestanding': { unit: 'each', low: 800, avg: 1800, high: 5000 },
    'shower_base': { unit: 'each', low: 200, avg: 400, high: 800 },
    'shower_door_frameless': { unit: 'each', low: 600, avg: 1200, high: 2500 },
    'shower_door_framed': { unit: 'each', low: 200, avg: 450, high: 800 }
  },

  // BATHROOM VANITIES
  'vanity': {
    'vanity_24inch': { unit: 'each', low: 150, avg: 350, high: 700 },
    'vanity_36inch': { unit: 'each', low: 250, avg: 500, high: 1000 },
    'vanity_48inch': { unit: 'each', low: 350, avg: 700, high: 1400 },
    'vanity_60inch': { unit: 'each', low: 450, avg: 900, high: 1800 },
    'vanity_72inch_double': { unit: 'each', low: 600, avg: 1200, high: 2500 },
    'medicine_cabinet': { unit: 'each', low: 80, avg: 200, high: 500 },
    'bathroom_mirror': { unit: 'each', low: 50, avg: 150, high: 400 }
  },

  // TILE & BACKSPLASH
  'tile': {
    'subway_tile': { unit: 'sq_ft', low: 2, avg: 5, high: 15 },
    'mosaic_tile': { unit: 'sq_ft', low: 8, avg: 18, high: 40 },
    'large_format_tile': { unit: 'sq_ft', low: 4, avg: 8, high: 20 },
    'natural_stone_tile': { unit: 'sq_ft', low: 10, avg: 25, high: 60 },
    'tile_adhesive_thinset': { unit: 'bag', low: 15, avg: 25, high: 40 },
    'tile_grout': { unit: 'bag', low: 12, avg: 20, high: 35 },
    'tile_trim_bullnose': { unit: 'linear_ft', low: 3, avg: 8, high: 20 }
  },

  // PAINT & WALL FINISHES
  'paint': {
    'interior_paint_gallon': { unit: 'gallon', low: 25, avg: 45, high: 75 },
    'exterior_paint_gallon': { unit: 'gallon', low: 35, avg: 55, high: 85 },
    'primer_gallon': { unit: 'gallon', low: 20, avg: 30, high: 45 },
    'paint_supplies': { unit: 'room', low: 30, avg: 50, high: 100 },
    'wallpaper': { unit: 'roll', low: 25, avg: 60, high: 150 },
    'drywall_sheet': { unit: 'sheet', low: 12, avg: 18, high: 30 },
    'drywall_compound': { unit: 'bucket', low: 15, avg: 25, high: 40 }
  },

  // LIGHTING
  'lighting': {
    'recessed_light': { unit: 'each', low: 20, avg: 50, high: 150 },
    'pendant_light': { unit: 'each', low: 50, avg: 150, high: 500 },
    'chandelier': { unit: 'each', low: 150, avg: 400, high: 1500 },
    'ceiling_fan': { unit: 'each', low: 100, avg: 250, high: 600 },
    'vanity_light': { unit: 'each', low: 50, avg: 150, high: 400 },
    'under_cabinet_light': { unit: 'linear_ft', low: 15, avg: 30, high: 60 },
    'dimmer_switch': { unit: 'each', low: 15, avg: 35, high: 80 },
    'outlet_gfci': { unit: 'each', low: 15, avg: 25, high: 40 }
  },

  // WINDOWS & DOORS
  'windows': {
    'window_vinyl_double_hung': { unit: 'each', low: 250, avg: 450, high: 800 },
    'window_wood': { unit: 'each', low: 500, avg: 800, high: 1500 },
    'window_egress': { unit: 'each', low: 600, avg: 1000, high: 1800 },
    'sliding_glass_door': { unit: 'each', low: 800, avg: 1500, high: 3500 },
    'entry_door_steel': { unit: 'each', low: 400, avg: 800, high: 1500 },
    'entry_door_fiberglass': { unit: 'each', low: 600, avg: 1200, high: 2500 },
    'interior_door_hollow': { unit: 'each', low: 50, avg: 100, high: 180 },
    'interior_door_solid': { unit: 'each', low: 150, avg: 300, high: 600 },
    'door_hardware': { unit: 'each', low: 25, avg: 60, high: 150 }
  },

  // ROOFING
  'roofing': {
    'asphalt_shingles': { unit: 'sq_ft', low: 1.00, avg: 1.75, high: 3.00 },
    'architectural_shingles': { unit: 'sq_ft', low: 1.50, avg: 2.25, high: 3.50 },
    'metal_roofing': { unit: 'sq_ft', low: 3.50, avg: 6.00, high: 12.00 },
    'underlayment_felt': { unit: 'sq_ft', low: 0.10, avg: 0.20, high: 0.35 },
    'underlayment_synthetic': { unit: 'sq_ft', low: 0.20, avg: 0.35, high: 0.60 },
    'roof_vent': { unit: 'each', low: 20, avg: 50, high: 120 },
    'ridge_cap': { unit: 'linear_ft', low: 2, avg: 4, high: 8 }
  },

  // HVAC
  'hvac': {
    'furnace_gas': { unit: 'each', low: 2000, avg: 3500, high: 6000 },
    'furnace_electric': { unit: 'each', low: 1500, avg: 2500, high: 4500 },
    'ac_unit_central': { unit: 'each', low: 3000, avg: 5000, high: 9000 },
    'heat_pump': { unit: 'each', low: 4000, avg: 7000, high: 12000 },
    'mini_split': { unit: 'each', low: 1500, avg: 3000, high: 6000 },
    'water_heater_tank': { unit: 'each', low: 600, avg: 1000, high: 1800 },
    'water_heater_tankless': { unit: 'each', low: 1200, avg: 2200, high: 4000 },
    'thermostat_smart': { unit: 'each', low: 100, avg: 200, high: 350 }
  },

  // LANDSCAPING
  'landscaping': {
    'sod': { unit: 'sq_ft', low: 0.30, avg: 0.60, high: 1.00 },
    'mulch': { unit: 'cubic_yd', low: 30, avg: 50, high: 80 },
    'gravel': { unit: 'cubic_yd', low: 35, avg: 55, high: 90 },
    'pavers': { unit: 'sq_ft', low: 3, avg: 8, high: 20 },
    'concrete_patio': { unit: 'sq_ft', low: 6, avg: 12, high: 25 },
    'retaining_wall': { unit: 'sq_ft', low: 15, avg: 35, high: 75 },
    'fence_wood': { unit: 'linear_ft', low: 15, avg: 30, high: 60 },
    'fence_vinyl': { unit: 'linear_ft', low: 20, avg: 40, high: 80 },
    'sprinkler_zone': { unit: 'each', low: 200, avg: 400, high: 700 },
    'outdoor_lighting': { unit: 'each', low: 50, avg: 150, high: 400 },
    'deck_composite': { unit: 'sq_ft', low: 8, avg: 15, high: 30 },
    'deck_wood_treated': { unit: 'sq_ft', low: 5, avg: 10, high: 18 }
  },

  // ELECTRICAL
  'electrical': {
    'circuit_breaker': { unit: 'each', low: 15, avg: 30, high: 60 },
    'panel_upgrade_200amp': { unit: 'each', low: 1500, avg: 2500, high: 4000 },
    'outlet_standard': { unit: 'each', low: 3, avg: 6, high: 12 },
    'switch_standard': { unit: 'each', low: 3, avg: 6, high: 12 },
    'wire_romex_12_2': { unit: 'linear_ft', low: 0.40, avg: 0.60, high: 1.00 },
    'wire_romex_14_2': { unit: 'linear_ft', low: 0.30, avg: 0.50, high: 0.80 },
    'junction_box': { unit: 'each', low: 2, avg: 5, high: 12 }
  },

  // INSULATION
  'insulation': {
    'fiberglass_batt': { unit: 'sq_ft', low: 0.50, avg: 1.00, high: 1.80 },
    'blown_in_cellulose': { unit: 'sq_ft', low: 0.80, avg: 1.50, high: 2.50 },
    'spray_foam_open': { unit: 'sq_ft', low: 1.00, avg: 1.75, high: 2.50 },
    'spray_foam_closed': { unit: 'sq_ft', low: 1.50, avg: 2.50, high: 4.00 },
    'rigid_foam': { unit: 'sq_ft', low: 0.75, avg: 1.25, high: 2.00 }
  }
};

/**
 * Get material cost adjusted for region
 */
export function getMaterialCost(category, itemKey, zipCode, level = 'avg') {
  const categoryData = MATERIAL_COSTS[category];
  if (!categoryData) {
    console.warn(`[Cost DB] Category not found: ${category}`);
    return null;
  }
  
  const item = categoryData[itemKey];
  if (!item) {
    console.warn(`[Cost DB] Item not found: ${category}/${itemKey}`);
    return null;
  }
  
  const multiplier = getRegionalMultiplier(zipCode, 'material');
  const baseCost = item[level] || item.avg;
  
  return {
    unitCost: Math.round(baseCost * multiplier * 100) / 100,
    unit: item.unit,
    baseCost: baseCost,
    multiplier: multiplier,
    source: 'HouseYield Cost Database 2025'
  };
}

// ============================================================================
// COMPLETE PROJECT COST TEMPLATES
// Pre-calculated costs for common renovation projects
// Includes materials, labor, and typical scope
// ============================================================================
export const PROJECT_TEMPLATES = {
  // KITCHEN PROJECTS
  'kitchen_full_remodel': {
    name: 'Full Kitchen Remodel',
    description: 'Complete gut renovation with new cabinets, counters, appliances, flooring',
    scope: { sqft: { min: 80, max: 200 } },
    costs: {
      budget: { min: 15000, max: 30000 },
      midRange: { min: 30000, max: 60000 },
      luxury: { min: 60000, max: 150000 }
    },
    laborPercent: 35,
    timeline: '4-8 weeks'
  },
  'kitchen_cabinet_reface': {
    name: 'Cabinet Refacing',
    description: 'Keep cabinet boxes, replace doors/drawer fronts, add new hardware',
    scope: { linearFt: { min: 15, max: 30 } },
    costs: {
      budget: { min: 4000, max: 8000 },
      midRange: { min: 8000, max: 15000 },
      luxury: { min: 15000, max: 25000 }
    },
    laborPercent: 40,
    timeline: '3-5 days'
  },
  'kitchen_countertop_replace': {
    name: 'Countertop Replacement',
    description: 'New countertops with undermount sink, faucet upgrade',
    scope: { sqft: { min: 25, max: 60 } },
    costs: {
      budget: { min: 2000, max: 4000 },
      midRange: { min: 4000, max: 8000 },
      luxury: { min: 8000, max: 20000 }
    },
    laborPercent: 25,
    timeline: '1-2 days'
  },
  'kitchen_appliance_package': {
    name: 'Appliance Package Upgrade',
    description: 'New refrigerator, range, dishwasher, microwave',
    scope: { appliances: 4 },
    costs: {
      budget: { min: 2500, max: 4000 },
      midRange: { min: 4000, max: 8000 },
      luxury: { min: 8000, max: 20000 }
    },
    laborPercent: 10,
    timeline: '1 day'
  },
  'kitchen_backsplash': {
    name: 'Backsplash Installation',
    description: 'New tile backsplash with grout',
    scope: { sqft: { min: 20, max: 50 } },
    costs: {
      budget: { min: 400, max: 800 },
      midRange: { min: 800, max: 2000 },
      luxury: { min: 2000, max: 5000 }
    },
    laborPercent: 50,
    timeline: '1-2 days'
  },

  // BATHROOM PROJECTS
  'bathroom_full_remodel': {
    name: 'Full Bathroom Remodel',
    description: 'Complete renovation with new fixtures, tile, vanity, lighting',
    scope: { sqft: { min: 35, max: 80 } },
    costs: {
      budget: { min: 8000, max: 15000 },
      midRange: { min: 15000, max: 30000 },
      luxury: { min: 30000, max: 75000 }
    },
    laborPercent: 40,
    timeline: '2-4 weeks'
  },
  'bathroom_vanity_replace': {
    name: 'Vanity Replacement',
    description: 'New vanity with sink, faucet, mirror, light fixture',
    scope: { inches: { min: 24, max: 72 } },
    costs: {
      budget: { min: 800, max: 1500 },
      midRange: { min: 1500, max: 3500 },
      luxury: { min: 3500, max: 8000 }
    },
    laborPercent: 30,
    timeline: '1 day'
  },
  'bathroom_tile_shower': {
    name: 'Tile Shower Installation',
    description: 'Remove old shower, install new tile surround with fixtures',
    scope: { sqft: { min: 40, max: 100 } },
    costs: {
      budget: { min: 3000, max: 5000 },
      midRange: { min: 5000, max: 10000 },
      luxury: { min: 10000, max: 25000 }
    },
    laborPercent: 55,
    timeline: '1-2 weeks'
  },
  'bathroom_toilet_replace': {
    name: 'Toilet Replacement',
    description: 'New toilet with installation and wax ring',
    scope: { toilets: 1 },
    costs: {
      budget: { min: 250, max: 400 },
      midRange: { min: 400, max: 700 },
      luxury: { min: 700, max: 1500 }
    },
    laborPercent: 35,
    timeline: '2 hours'
  },

  // FLOORING PROJECTS
  'flooring_lvp_install': {
    name: 'LVP/Laminate Flooring',
    description: 'Remove old flooring, install LVP with underlayment and transitions',
    scope: { sqft: { min: 200, max: 2000 } },
    costPerSqFt: {
      budget: { min: 4, max: 6 },
      midRange: { min: 6, max: 10 },
      luxury: { min: 10, max: 18 }
    },
    laborPercent: 45,
    timeline: '1-5 days'
  },
  'flooring_hardwood_install': {
    name: 'Hardwood Flooring',
    description: 'Install prefinished or site-finished hardwood flooring',
    scope: { sqft: { min: 200, max: 2000 } },
    costPerSqFt: {
      budget: { min: 8, max: 12 },
      midRange: { min: 12, max: 18 },
      luxury: { min: 18, max: 30 }
    },
    laborPercent: 50,
    timeline: '3-10 days'
  },
  'flooring_tile_install': {
    name: 'Tile Flooring',
    description: 'Install ceramic or porcelain tile with grout',
    scope: { sqft: { min: 50, max: 500 } },
    costPerSqFt: {
      budget: { min: 8, max: 12 },
      midRange: { min: 12, max: 20 },
      luxury: { min: 20, max: 40 }
    },
    laborPercent: 55,
    timeline: '2-7 days'
  },
  'flooring_carpet_install': {
    name: 'Carpet Installation',
    description: 'New carpet with pad and installation',
    scope: { sqft: { min: 200, max: 2000 } },
    costPerSqFt: {
      budget: { min: 3, max: 5 },
      midRange: { min: 5, max: 8 },
      luxury: { min: 8, max: 15 }
    },
    laborPercent: 35,
    timeline: '1-3 days'
  },

  // PAINT PROJECTS
  'paint_interior_room': {
    name: 'Interior Room Paint',
    description: 'Paint walls and ceiling, prep work included',
    scope: { sqft: { min: 100, max: 300 } },
    costs: {
      budget: { min: 250, max: 400 },
      midRange: { min: 400, max: 700 },
      luxury: { min: 700, max: 1200 }
    },
    laborPercent: 70,
    timeline: '1-2 days'
  },
  'paint_interior_whole_house': {
    name: 'Whole House Interior Paint',
    description: 'Complete interior repaint, all rooms',
    scope: { sqft: { min: 1000, max: 3000 } },
    // Cost per wall sqft — paint pricing is driven by surface area, not floor area.
    // Budget: basic latex, 1 coat. Mid: quality latex, 2 coats + primer. Luxury: designer, trim, ceilings.
    costPerWallSqFt: {
      budget: { min: 1.5, max: 2.5 },
      midRange: { min: 2.5, max: 4.5 },
      luxury: { min: 4.5, max: 8.0 }
    },
    // Fallback flat costs when wall area is unknown
    costs: {
      budget: { min: 3000, max: 5000 },
      midRange: { min: 5000, max: 10000 },
      luxury: { min: 10000, max: 20000 }
    },
    laborPercent: 75,
    timeline: '3-7 days'
  },
  'paint_exterior': {
    name: 'Exterior House Paint',
    description: 'Complete exterior repaint, power wash, prep, paint',
    scope: { sqft: { min: 1500, max: 4000 } },
    costs: {
      budget: { min: 3000, max: 6000 },
      midRange: { min: 6000, max: 12000 },
      luxury: { min: 12000, max: 25000 }
    },
    laborPercent: 70,
    timeline: '3-7 days'
  },

  // MAJOR SYSTEMS
  'hvac_furnace_replace': {
    name: 'Furnace Replacement',
    description: 'New gas or electric furnace with installation',
    scope: { btu: { min: 60000, max: 120000 } },
    costs: {
      budget: { min: 3000, max: 5000 },
      midRange: { min: 5000, max: 8000 },
      luxury: { min: 8000, max: 15000 }
    },
    laborPercent: 40,
    timeline: '1 day'
  },
  'hvac_ac_replace': {
    name: 'AC Unit Replacement',
    description: 'New central AC condenser and evaporator coil',
    scope: { tons: { min: 2, max: 5 } },
    costs: {
      budget: { min: 4000, max: 6000 },
      midRange: { min: 6000, max: 10000 },
      luxury: { min: 10000, max: 18000 }
    },
    laborPercent: 35,
    timeline: '1 day'
  },
  'hvac_complete_system': {
    name: 'Complete HVAC System',
    description: 'New furnace, AC, thermostat, ductwork modifications',
    scope: { sqft: { min: 1500, max: 3000 } },
    costs: {
      budget: { min: 8000, max: 12000 },
      midRange: { min: 12000, max: 20000 },
      luxury: { min: 20000, max: 35000 }
    },
    laborPercent: 40,
    timeline: '2-3 days'
  },
  'water_heater_replace': {
    name: 'Water Heater Replacement',
    description: 'New tank or tankless water heater with installation',
    scope: { gallons: { min: 40, max: 80 } },
    costs: {
      budget: { min: 1000, max: 1500 },
      midRange: { min: 1500, max: 3000 },
      luxury: { min: 3000, max: 6000 }
    },
    laborPercent: 35,
    timeline: '4-6 hours'
  },

  // ROOFING
  'roof_asphalt_shingle': {
    name: 'Asphalt Shingle Roof',
    description: 'Complete tear-off and replacement with architectural shingles',
    scope: { sqft: { min: 1500, max: 3500 } },
    costPerSqFt: {
      budget: { min: 4, max: 6 },
      midRange: { min: 6, max: 9 },
      luxury: { min: 9, max: 14 }
    },
    laborPercent: 55,
    timeline: '1-3 days'
  },
  'roof_metal': {
    name: 'Metal Roof',
    description: 'Standing seam or panel metal roofing',
    scope: { sqft: { min: 1500, max: 3500 } },
    costPerSqFt: {
      budget: { min: 9, max: 12 },
      midRange: { min: 12, max: 18 },
      luxury: { min: 18, max: 30 }
    },
    laborPercent: 50,
    timeline: '2-5 days'
  },

  // WINDOWS & DOORS
  'windows_replace_standard': {
    name: 'Window Replacement',
    description: 'Replace existing windows, vinyl or wood',
    scope: { windows: { min: 5, max: 20 } },
    costPerWindow: {
      budget: { min: 400, max: 600 },
      midRange: { min: 600, max: 1000 },
      luxury: { min: 1000, max: 2000 }
    },
    laborPercent: 30,
    timeline: '1-3 days'
  },
  'entry_door_replace': {
    name: 'Entry Door Replacement',
    description: 'New front entry door with hardware',
    scope: { doors: 1 },
    costs: {
      budget: { min: 800, max: 1500 },
      midRange: { min: 1500, max: 3500 },
      luxury: { min: 3500, max: 8000 }
    },
    laborPercent: 25,
    timeline: '4-8 hours'
  },

  // LANDSCAPING
  'deck_composite': {
    name: 'Composite Deck',
    description: 'New composite deck with railing',
    scope: { sqft: { min: 150, max: 500 } },
    costPerSqFt: {
      budget: { min: 30, max: 45 },
      midRange: { min: 45, max: 75 },
      luxury: { min: 75, max: 120 }
    },
    laborPercent: 50,
    timeline: '1-3 weeks'
  },
  'fence_wood': {
    name: 'Wood Privacy Fence',
    description: '6ft wood privacy fence with posts and gates',
    scope: { linearFt: { min: 100, max: 400 } },
    costPerLinearFt: {
      budget: { min: 20, max: 30 },
      midRange: { min: 30, max: 50 },
      luxury: { min: 50, max: 80 }
    },
    laborPercent: 45,
    timeline: '2-5 days'
  },
  'patio_concrete': {
    name: 'Concrete Patio',
    description: 'Poured concrete patio with finish',
    scope: { sqft: { min: 150, max: 600 } },
    costPerSqFt: {
      budget: { min: 8, max: 12 },
      midRange: { min: 12, max: 20 },
      luxury: { min: 20, max: 35 }
    },
    laborPercent: 60,
    timeline: '2-5 days'
  },
  'landscaping_full': {
    name: 'Full Landscaping Package',
    description: 'New plantings, mulch, sod, irrigation',
    scope: { sqft: { min: 500, max: 3000 } },
    costs: {
      budget: { min: 3000, max: 6000 },
      midRange: { min: 6000, max: 15000 },
      luxury: { min: 15000, max: 40000 }
    },
    laborPercent: 50,
    timeline: '1-2 weeks'
  }
};

/**
 * Get project template cost adjusted for region and scope
 */
export function getProjectCost(projectKey, zipCode, scope, qualityLevel = 'midRange') {
  const template = PROJECT_TEMPLATES[projectKey];
  if (!template) {
    console.warn(`[Cost DB] Project template not found: ${projectKey}`);
    return null;
  }
  
  const multiplier = getRegionalMultiplier(zipCode);
  let baseCost = 0;
  
  // Calculate based on project type
  // Priority: use per-unit rates when measurements are available, fall back to flat costs
  if (template.costPerWallSqFt && scope?.wallSqft > 0) {
    // Paint projects: use wall surface area when measured by DAv3
    const costRange = template.costPerWallSqFt[qualityLevel] || template.costPerWallSqFt.midRange;
    const avgCostPerWallSqFt = (costRange.min + costRange.max) / 2;
    baseCost = avgCostPerWallSqFt * scope.wallSqft;
    console.log(`[Cost DB] Using wall area: ${scope.wallSqft} sqft × $${avgCostPerWallSqFt}/sqft = $${Math.round(baseCost)}`);
  } else if (template.costs) {
    const costRange = template.costs[qualityLevel] || template.costs.midRange;
    baseCost = (costRange.min + costRange.max) / 2;
  } else if (template.costPerSqFt && scope?.sqft) {
    const costRange = template.costPerSqFt[qualityLevel] || template.costPerSqFt.midRange;
    const avgCostPerSqFt = (costRange.min + costRange.max) / 2;
    baseCost = avgCostPerSqFt * scope.sqft;
  } else if (template.costPerLinearFt && scope?.linearFt) {
    const costRange = template.costPerLinearFt[qualityLevel] || template.costPerLinearFt.midRange;
    const avgCostPerLf = (costRange.min + costRange.max) / 2;
    baseCost = avgCostPerLf * scope.linearFt;
  } else if (template.costPerWindow && scope?.windows) {
    const costRange = template.costPerWindow[qualityLevel] || template.costPerWindow.midRange;
    const avgCostPerWindow = (costRange.min + costRange.max) / 2;
    baseCost = avgCostPerWindow * scope.windows;
  }
  
  const adjustedCost = baseCost * multiplier;
  const laborCost = adjustedCost * (template.laborPercent / 100);
  const materialCost = adjustedCost - laborCost;
  
  return {
    projectName: template.name,
    description: template.description,
    totalCost: Math.round(adjustedCost),
    laborCost: Math.round(laborCost),
    materialCost: Math.round(materialCost),
    laborPercent: template.laborPercent,
    timeline: template.timeline,
    qualityLevel: qualityLevel,
    regionalMultiplier: multiplier,
    scope: scope,
    costRange: {
      low: Math.round(adjustedCost * 0.75),
      high: Math.round(adjustedCost * 1.25)
    },
    source: 'HouseYield Project Database 2025'
  };
}

/**
 * Find matching project template from renovation description
 */
export function findProjectTemplate(renovationName, renovationType) {
  const searchTerms = `${renovationName} ${renovationType}`.toLowerCase();
  
  const templateMatches = [
    // Kitchen — match modernization, update, upgrade, refresh, renovation + bare "kitchen" as type
    { keywords: ['full kitchen', 'kitchen remodel', 'gut kitchen', 'complete kitchen', 'kitchen modernization', 'kitchen update', 'kitchen upgrade', 'kitchen refresh', 'kitchen renovation'], template: 'kitchen_full_remodel' },
    { keywords: ['cabinet reface', 'reface cabinet'], template: 'kitchen_cabinet_reface' },
    { keywords: ['countertop', 'counter top', 'granite', 'quartz counters'], template: 'kitchen_countertop_replace' },
    { keywords: ['appliance', 'refrigerator', 'stove', 'range', 'dishwasher'], template: 'kitchen_appliance_package' },
    { keywords: ['backsplash', 'back splash'], template: 'kitchen_backsplash' },
    
    // Bathroom — match modernization, update, upgrade, refresh, renovation, tile + fixture
    { keywords: ['full bathroom', 'bathroom remodel', 'bath remodel', 'complete bath', 'bathroom modernization', 'bathroom update', 'bathroom upgrade', 'bathroom refresh', 'bathroom renovation', 'bathroom tile', 'tile and fixture'], template: 'bathroom_full_remodel' },
    { keywords: ['vanity', 'sink vanity', 'bathroom sink'], template: 'bathroom_vanity_replace' },
    { keywords: ['shower tile', 'tile shower', 'shower surround'], template: 'bathroom_tile_shower' },
    { keywords: ['toilet'], template: 'bathroom_toilet_replace' },
    
    // Flooring — match replacement, carpet replacement, carpet to hardwood
    { keywords: ['lvp', 'vinyl plank', 'laminate floor'], template: 'flooring_lvp_install' },
    { keywords: ['hardwood', 'wood floor', 'carpet replacement with hardwood', 'carpet to hardwood'], template: 'flooring_hardwood_install' },
    { keywords: ['tile floor', 'ceramic floor', 'porcelain floor'], template: 'flooring_tile_install' },
    { keywords: ['carpet install', 'new carpet', 'carpet replacement'], template: 'flooring_carpet_install' },
    
    // Paint — match update, refresh, interior update
    { keywords: ['paint room', 'room paint', 'interior paint room', 'paint and lighting', 'lighting update'], template: 'paint_interior_room' },
    { keywords: ['whole house paint', 'full house paint', 'entire house paint', 'interior paint', 'paint interior'], template: 'paint_interior_whole_house' },
    { keywords: ['exterior paint', 'outside paint', 'house exterior', 'paint exterior'], template: 'paint_exterior' },
    
    { keywords: ['furnace', 'heating system'], template: 'hvac_furnace_replace' },
    { keywords: ['air condition', 'ac replace', 'a/c', 'central air'], template: 'hvac_ac_replace' },
    { keywords: ['hvac', 'heating cooling', 'complete hvac', 'hvac update', 'hvac upgrade'], template: 'hvac_complete_system' },
    { keywords: ['water heater'], template: 'water_heater_replace' },
    
    { keywords: ['shingle roof', 'asphalt roof', 'roof replace', 'roof replacement'], template: 'roof_asphalt_shingle' },
    { keywords: ['metal roof', 'standing seam'], template: 'roof_metal' },
    
    { keywords: ['window replace', 'new window', 'window replacement'], template: 'windows_replace_standard' },
    { keywords: ['entry door', 'front door'], template: 'entry_door_replace' },
    
    { keywords: ['composite deck', 'trex deck'], template: 'deck_composite' },
    { keywords: ['wood fence', 'privacy fence', 'fence install'], template: 'fence_wood' },
    { keywords: ['concrete patio', 'patio pour'], template: 'patio_concrete' },
    { keywords: ['landscaping', 'landscape', 'yard work', 'front yard', 'back yard', 'curb appeal'], template: 'landscaping_full' }
  ];

  // First: try direct keyword match
  for (const match of templateMatches) {
    if (match.keywords.some(kw => searchTerms.includes(kw))) {
      return match.template;
    }
  }

  // Second: fall back to PROJECT TYPE matching when name didn't match any keyword.
  // This ensures "Kitchen Modernization" still hits kitchen_full_remodel via the
  // "kitchen" type, "Bathroom Tile and Fixture Upgrade" hits bathroom_full_remodel, etc.
  const typeToTemplate = {
    'kitchen': 'kitchen_full_remodel',
    'kitchen_update': 'kitchen_full_remodel',
    'kitchen_refresh': 'kitchen_full_remodel',
    'bathroom': 'bathroom_full_remodel',
    'bathroom_update': 'bathroom_full_remodel',
    'bathroom_master': 'bathroom_full_remodel',
    'bathroom_secondary': 'bathroom_full_remodel',
    'flooring': 'flooring_lvp_install',
    'flooring_update': 'flooring_lvp_install',
    'paint': 'paint_interior_room',
    'paint_interior': 'paint_interior_whole_house',
    'paint_exterior': 'paint_exterior',
    'hvac': 'hvac_complete_system',
    'hvac_update': 'hvac_complete_system',
    'roof': 'roof_asphalt_shingle',
    'roofing': 'roof_asphalt_shingle',
    'windows': 'windows_replace_standard',
    'landscaping': 'landscaping_full',
    'deck': 'deck_composite',
    'deck_patio': 'deck_composite',
  };
  const normalizedType = (renovationType || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (typeToTemplate[normalizedType]) {
    return typeToTemplate[normalizedType];
  }
  
  return null;
}

export default {
  REGIONAL_MULTIPLIERS,
  LABOR_RATES,
  MATERIAL_COSTS,
  PROJECT_TEMPLATES,
  getRegionalMultiplier,
  getLaborRate,
  getMaterialCost,
  getProjectCost,
  findProjectTemplate
};
