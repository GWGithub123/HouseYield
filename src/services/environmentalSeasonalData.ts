/**
 * Environmental Seasonal Data Service
 * Provides real regional-specific seasonal adjustments for environmental risk maps
 * Data sources: NOAA Climate Normals, EPA AQI Seasonal Patterns, FHWA Traffic Patterns
 */

export type Season = 'spring' | 'summer' | 'fall' | 'winter';
export type TimeOfDay = 'night' | 'morning-rush' | 'midday' | 'evening-rush' | 'late-evening';
export type StormIntensity = 0.5 | 1 | 2 | 3 | 4 | 6; // inches of rainfall

// US Climate Regions for regional-specific data
export type ClimateRegion = 
  | 'northeast' | 'southeast' | 'midwest' | 'southwest' 
  | 'west-coast' | 'mountain' | 'pacific-northwest' | 'florida';

/**
 * Determine climate region based on coordinates
 * Based on NOAA climate regions
 */
export function getClimateRegion(latitude: number, longitude: number): ClimateRegion {
  // Florida (special case - unique climate)
  if (latitude < 31 && longitude > -88 && longitude < -80) {
    return 'florida';
  }
  
  // Pacific Northwest (WA, OR, Northern CA coast)
  if (longitude < -120 && latitude > 42) {
    return 'pacific-northwest';
  }
  
  // West Coast (CA)
  if (longitude < -115 && latitude > 32 && latitude < 42) {
    return 'west-coast';
  }
  
  // Mountain West (Mountain states)
  if (longitude < -104 && longitude > -115 && latitude > 32 && latitude < 49) {
    return 'mountain';
  }
  
  // Southwest (AZ, NM, West TX)
  if (longitude < -104 && latitude < 37 && latitude > 25) {
    return 'southwest';
  }
  
  // Midwest (Great Plains and Great Lakes)
  if (longitude > -104 && longitude < -80 && latitude > 37) {
    return 'midwest';
  }
  
  // Southeast (SE states)
  if (latitude < 37 && longitude > -94 && longitude < -75) {
    return 'southeast';
  }
  
  // Northeast (NE states)
  if (latitude > 37 && longitude > -80) {
    return 'northeast';
  }
  
  // Default to midwest
  return 'midwest';
}

/**
 * Get current season based on date
 */
export function getCurrentSeason(): Season {
  const month = new Date().getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
}

/**
 * Get current approximate time of day period
 */
export function getCurrentTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 6) return 'night';
  if (hour >= 6 && hour < 10) return 'morning-rush';
  if (hour >= 10 && hour < 16) return 'midday';
  if (hour >= 16 && hour < 20) return 'evening-rush';
  return 'late-evening';
}

// ============================================
// WILDFIRE SEASONAL DATA
// Based on NIFC (National Interagency Fire Center) historical data
// ============================================

interface WildfireSeasonalFactors {
  riskMultiplier: number; // 0-2 multiplier on base risk
  temperatureAdjustment: number; // Degrees C adjustment
  humidityAdjustment: number; // Percentage points adjustment
  vegetationDryness: number; // 0-100 scale
  description: string;
}

const WILDFIRE_SEASONAL_DATA: Record<ClimateRegion, Record<Season, WildfireSeasonalFactors>> = {
  'west-coast': {
    spring: { riskMultiplier: 0.6, temperatureAdjustment: -5, humidityAdjustment: 15, vegetationDryness: 30, description: 'Spring rains reduce fire risk' },
    summer: { riskMultiplier: 1.8, temperatureAdjustment: 15, humidityAdjustment: -30, vegetationDryness: 85, description: 'Peak fire season - extreme heat, no rain' },
    fall: { riskMultiplier: 2.0, temperatureAdjustment: 10, humidityAdjustment: -40, vegetationDryness: 95, description: 'Santa Ana/Diablo winds - highest risk' },
    winter: { riskMultiplier: 0.3, temperatureAdjustment: -10, humidityAdjustment: 30, vegetationDryness: 20, description: 'Rainy season - low fire risk' }
  },
  'pacific-northwest': {
    spring: { riskMultiplier: 0.4, temperatureAdjustment: -8, humidityAdjustment: 25, vegetationDryness: 25, description: 'Wet spring conditions' },
    summer: { riskMultiplier: 1.5, temperatureAdjustment: 12, humidityAdjustment: -20, vegetationDryness: 70, description: 'Dry season begins - elevated risk' },
    fall: { riskMultiplier: 1.2, temperatureAdjustment: 5, humidityAdjustment: -10, vegetationDryness: 60, description: 'Lingering dry conditions' },
    winter: { riskMultiplier: 0.2, temperatureAdjustment: -12, humidityAdjustment: 35, vegetationDryness: 15, description: 'Very wet - minimal fire risk' }
  },
  'mountain': {
    spring: { riskMultiplier: 0.7, temperatureAdjustment: -3, humidityAdjustment: 10, vegetationDryness: 40, description: 'Snowmelt period - moderate risk' },
    summer: { riskMultiplier: 1.6, temperatureAdjustment: 10, humidityAdjustment: -25, vegetationDryness: 80, description: 'Peak fire season in mountains' },
    fall: { riskMultiplier: 1.3, temperatureAdjustment: 5, humidityAdjustment: -15, vegetationDryness: 65, description: 'Dry conditions persist' },
    winter: { riskMultiplier: 0.2, temperatureAdjustment: -20, humidityAdjustment: 20, vegetationDryness: 10, description: 'Snow cover - very low risk' }
  },
  'southwest': {
    spring: { riskMultiplier: 1.4, temperatureAdjustment: 8, humidityAdjustment: -25, vegetationDryness: 75, description: 'Pre-monsoon dry period' },
    summer: { riskMultiplier: 1.0, temperatureAdjustment: 15, humidityAdjustment: 10, vegetationDryness: 50, description: 'Monsoon reduces risk despite heat' },
    fall: { riskMultiplier: 1.2, temperatureAdjustment: 5, humidityAdjustment: -20, vegetationDryness: 65, description: 'Post-monsoon dry period' },
    winter: { riskMultiplier: 0.5, temperatureAdjustment: -5, humidityAdjustment: 5, vegetationDryness: 35, description: 'Cool, occasional rain' }
  },
  'southeast': {
    spring: { riskMultiplier: 1.1, temperatureAdjustment: 5, humidityAdjustment: -10, vegetationDryness: 50, description: 'Spring dry period - moderate risk' },
    summer: { riskMultiplier: 0.7, temperatureAdjustment: 10, humidityAdjustment: 20, vegetationDryness: 30, description: 'High humidity reduces fire spread' },
    fall: { riskMultiplier: 1.0, temperatureAdjustment: 3, humidityAdjustment: -5, vegetationDryness: 45, description: 'Dry leaves increase risk' },
    winter: { riskMultiplier: 0.8, temperatureAdjustment: -8, humidityAdjustment: 5, vegetationDryness: 40, description: 'Cool and variable' }
  },
  'florida': {
    spring: { riskMultiplier: 1.4, temperatureAdjustment: 8, humidityAdjustment: -20, vegetationDryness: 65, description: 'Dry season - peak fire risk' },
    summer: { riskMultiplier: 0.5, temperatureAdjustment: 5, humidityAdjustment: 30, vegetationDryness: 20, description: 'Rainy season - low fire risk' },
    fall: { riskMultiplier: 0.7, temperatureAdjustment: 3, humidityAdjustment: 15, vegetationDryness: 35, description: 'Hurricane season moisture' },
    winter: { riskMultiplier: 1.2, temperatureAdjustment: -5, humidityAdjustment: -15, vegetationDryness: 55, description: 'Dry winter period' }
  },
  'midwest': {
    spring: { riskMultiplier: 0.9, temperatureAdjustment: 0, humidityAdjustment: 5, vegetationDryness: 40, description: 'Early season grass fires possible' },
    summer: { riskMultiplier: 0.8, temperatureAdjustment: 8, humidityAdjustment: 10, vegetationDryness: 35, description: 'Humid summer - moderate risk' },
    fall: { riskMultiplier: 1.1, temperatureAdjustment: 0, humidityAdjustment: -10, vegetationDryness: 55, description: 'Dry harvest season' },
    winter: { riskMultiplier: 0.3, temperatureAdjustment: -15, humidityAdjustment: 15, vegetationDryness: 15, description: 'Cold, often snow-covered' }
  },
  'northeast': {
    spring: { riskMultiplier: 0.8, temperatureAdjustment: -3, humidityAdjustment: 10, vegetationDryness: 35, description: 'Occasional brush fires before green-up' },
    summer: { riskMultiplier: 0.6, temperatureAdjustment: 8, humidityAdjustment: 15, vegetationDryness: 25, description: 'Green vegetation, humid' },
    fall: { riskMultiplier: 1.0, temperatureAdjustment: 0, humidityAdjustment: -5, vegetationDryness: 50, description: 'Dry leaf litter increases risk' },
    winter: { riskMultiplier: 0.2, temperatureAdjustment: -18, humidityAdjustment: 20, vegetationDryness: 10, description: 'Snow cover - minimal risk' }
  }
};

export function getWildfireSeasonalFactors(latitude: number, longitude: number, season: Season): WildfireSeasonalFactors {
  const region = getClimateRegion(latitude, longitude);
  return WILDFIRE_SEASONAL_DATA[region][season];
}

// ============================================
// FLOOD/STORM INTENSITY DATA
// Based on NOAA precipitation data and FEMA flood modeling
// ============================================

interface FloodStormFactors {
  rainfallMultiplier: number; // Multiplier on base flood risk
  waterFlowIntensity: number; // 0-100 scale for flow visualization
  poolingDepthFactor: number; // Multiplier on water pooling depth
  description: string;
  category: string;
}

const STORM_INTENSITY_DATA: Record<StormIntensity, FloodStormFactors> = {
  0.5: {
    rainfallMultiplier: 0.3,
    waterFlowIntensity: 15,
    poolingDepthFactor: 0.2,
    description: 'Light rain - minimal impact',
    category: 'Light Rain'
  },
  1: {
    rainfallMultiplier: 0.5,
    waterFlowIntensity: 30,
    poolingDepthFactor: 0.4,
    description: 'Moderate rain - minor street flooding',
    category: 'Moderate Rain'
  },
  2: {
    rainfallMultiplier: 0.8,
    waterFlowIntensity: 50,
    poolingDepthFactor: 0.7,
    description: 'Heavy rain - localized flooding likely',
    category: 'Heavy Rain'
  },
  3: {
    rainfallMultiplier: 1.2,
    waterFlowIntensity: 70,
    poolingDepthFactor: 1.0,
    description: 'Very heavy rain - widespread flooding',
    category: 'Very Heavy'
  },
  4: {
    rainfallMultiplier: 1.6,
    waterFlowIntensity: 85,
    poolingDepthFactor: 1.4,
    description: 'Extreme rain - flash flooding',
    category: 'Extreme'
  },
  6: {
    rainfallMultiplier: 2.5,
    waterFlowIntensity: 100,
    poolingDepthFactor: 2.0,
    description: 'Catastrophic - major flood event',
    category: 'Catastrophic'
  }
};

interface FloodSeasonalFactors {
  baselineRisk: number; // 0-100 baseline flood risk
  groundSaturation: number; // 0-100 how saturated the ground is
  snowmeltFactor: number; // Additional risk from snowmelt
  hurricaneSeasonBonus: number; // Extra risk during hurricane season
  description: string;
}

const FLOOD_SEASONAL_DATA: Record<ClimateRegion, Record<Season, FloodSeasonalFactors>> = {
  'northeast': {
    spring: { baselineRisk: 60, groundSaturation: 85, snowmeltFactor: 30, hurricaneSeasonBonus: 0, description: 'Snowmelt + spring rains' },
    summer: { baselineRisk: 35, groundSaturation: 50, snowmeltFactor: 0, hurricaneSeasonBonus: 15, description: 'Thunderstorms, occasional tropical' },
    fall: { baselineRisk: 45, groundSaturation: 55, snowmeltFactor: 0, hurricaneSeasonBonus: 25, description: 'Hurricane remnants possible' },
    winter: { baselineRisk: 25, groundSaturation: 40, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Frozen ground, snow storage' }
  },
  'southeast': {
    spring: { baselineRisk: 55, groundSaturation: 70, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Spring thunderstorms' },
    summer: { baselineRisk: 65, groundSaturation: 80, snowmeltFactor: 0, hurricaneSeasonBonus: 40, description: 'Peak hurricane season + daily storms' },
    fall: { baselineRisk: 50, groundSaturation: 60, snowmeltFactor: 0, hurricaneSeasonBonus: 30, description: 'Late hurricane season' },
    winter: { baselineRisk: 30, groundSaturation: 45, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Drier, occasional frontal rain' }
  },
  'florida': {
    spring: { baselineRisk: 35, groundSaturation: 45, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Dry season ending' },
    summer: { baselineRisk: 75, groundSaturation: 90, snowmeltFactor: 0, hurricaneSeasonBonus: 50, description: 'Daily storms + peak hurricane' },
    fall: { baselineRisk: 60, groundSaturation: 75, snowmeltFactor: 0, hurricaneSeasonBonus: 35, description: 'Hurricane season continues' },
    winter: { baselineRisk: 25, groundSaturation: 35, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Dry season' }
  },
  'midwest': {
    spring: { baselineRisk: 70, groundSaturation: 90, snowmeltFactor: 25, hurricaneSeasonBonus: 0, description: 'Major flood season - snowmelt + rain' },
    summer: { baselineRisk: 45, groundSaturation: 55, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Thunderstorm flooding' },
    fall: { baselineRisk: 30, groundSaturation: 40, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Drying conditions' },
    winter: { baselineRisk: 20, groundSaturation: 30, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Frozen, snow storage' }
  },
  'southwest': {
    spring: { baselineRisk: 25, groundSaturation: 20, snowmeltFactor: 10, hurricaneSeasonBonus: 0, description: 'Dry with mountain snowmelt' },
    summer: { baselineRisk: 55, groundSaturation: 30, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Monsoon flash floods' },
    fall: { baselineRisk: 35, groundSaturation: 25, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Post-monsoon drying' },
    winter: { baselineRisk: 20, groundSaturation: 20, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Generally dry' }
  },
  'mountain': {
    spring: { baselineRisk: 75, groundSaturation: 95, snowmeltFactor: 50, hurricaneSeasonBonus: 0, description: 'Peak snowmelt flooding' },
    summer: { baselineRisk: 40, groundSaturation: 45, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Afternoon thunderstorms' },
    fall: { baselineRisk: 25, groundSaturation: 35, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Dry conditions' },
    winter: { baselineRisk: 15, groundSaturation: 25, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Snow accumulation' }
  },
  'west-coast': {
    spring: { baselineRisk: 45, groundSaturation: 70, snowmeltFactor: 15, hurricaneSeasonBonus: 0, description: 'Late rain season + Sierra melt' },
    summer: { baselineRisk: 10, groundSaturation: 15, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Very dry - minimal flood risk' },
    fall: { baselineRisk: 30, groundSaturation: 25, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'First rains on dry ground' },
    winter: { baselineRisk: 65, groundSaturation: 85, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Atmospheric rivers - major flooding' }
  },
  'pacific-northwest': {
    spring: { baselineRisk: 55, groundSaturation: 80, snowmeltFactor: 20, hurricaneSeasonBonus: 0, description: 'Snowmelt + spring rain' },
    summer: { baselineRisk: 15, groundSaturation: 30, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Dry season - low risk' },
    fall: { baselineRisk: 50, groundSaturation: 65, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Rain returns, rivers rise' },
    winter: { baselineRisk: 70, groundSaturation: 95, snowmeltFactor: 0, hurricaneSeasonBonus: 0, description: 'Peak rain + atmospheric rivers' }
  }
};

export function getFloodSeasonalFactors(latitude: number, longitude: number, season: Season): FloodSeasonalFactors {
  const region = getClimateRegion(latitude, longitude);
  return FLOOD_SEASONAL_DATA[region][season];
}

export function getStormIntensityFactors(intensity: StormIntensity): FloodStormFactors {
  return STORM_INTENSITY_DATA[intensity];
}

/**
 * Calculate combined flood risk adjustment
 */
export function calculateFloodRiskAdjustment(
  baseRisk: number,
  latitude: number,
  longitude: number,
  season: Season,
  stormIntensity: StormIntensity
): { adjustedRisk: number; description: string; waterFlowIntensity: number } {
  const seasonalFactors = getFloodSeasonalFactors(latitude, longitude, season);
  const stormFactors = getStormIntensityFactors(stormIntensity);
  
  // Combine factors
  const seasonalAdjustment = (seasonalFactors.baselineRisk / 50) * 0.5; // Normalize to 0.3-1.4 range
  const saturationBonus = (seasonalFactors.groundSaturation / 100) * 0.3;
  const snowmeltBonus = seasonalFactors.snowmeltFactor / 100;
  const hurricaneBonus = seasonalFactors.hurricaneSeasonBonus / 100;
  
  const totalSeasonalMultiplier = 1 + seasonalAdjustment + saturationBonus + snowmeltBonus + hurricaneBonus - 0.5;
  const combinedMultiplier = totalSeasonalMultiplier * stormFactors.rainfallMultiplier;
  
  const adjustedRisk = Math.min(100, Math.max(0, baseRisk * combinedMultiplier));
  
  return {
    adjustedRisk,
    description: `${seasonalFactors.description}. ${stormFactors.description}`,
    waterFlowIntensity: stormFactors.waterFlowIntensity * (seasonalFactors.groundSaturation / 50)
  };
}

// ============================================
// AIR QUALITY SEASONAL DATA
// Based on EPA Air Quality Trends data
// ============================================

interface AirQualitySeasonalFactors {
  aqiMultiplier: number; // Multiplier on base AQI
  ozoneRisk: 'low' | 'moderate' | 'high'; // Ground-level ozone formation potential
  particulateRisk: 'low' | 'moderate' | 'high'; // PM2.5/PM10 risk
  pollenLevel: 'none' | 'low' | 'moderate' | 'high' | 'very-high';
  description: string;
}

const AIR_QUALITY_SEASONAL_DATA: Record<ClimateRegion, Record<Season, AirQualitySeasonalFactors>> = {
  'west-coast': {
    spring: { aqiMultiplier: 0.9, ozoneRisk: 'moderate', particulateRisk: 'low', pollenLevel: 'high', description: 'Mild, some pollen' },
    summer: { aqiMultiplier: 1.3, ozoneRisk: 'high', particulateRisk: 'moderate', pollenLevel: 'moderate', description: 'Ozone alerts, occasional smoke' },
    fall: { aqiMultiplier: 1.8, ozoneRisk: 'moderate', particulateRisk: 'high', pollenLevel: 'low', description: 'Wildfire smoke season peak' },
    winter: { aqiMultiplier: 0.7, ozoneRisk: 'low', particulateRisk: 'low', pollenLevel: 'none', description: 'Clean air from winter rains' }
  },
  'pacific-northwest': {
    spring: { aqiMultiplier: 0.8, ozoneRisk: 'low', particulateRisk: 'low', pollenLevel: 'moderate', description: 'Rain keeps air clean' },
    summer: { aqiMultiplier: 1.4, ozoneRisk: 'moderate', particulateRisk: 'high', pollenLevel: 'low', description: 'Wildfire smoke from CA/OR' },
    fall: { aqiMultiplier: 1.2, ozoneRisk: 'low', particulateRisk: 'moderate', pollenLevel: 'low', description: 'Lingering smoke possible' },
    winter: { aqiMultiplier: 0.7, ozoneRisk: 'low', particulateRisk: 'low', pollenLevel: 'none', description: 'Very clean air' }
  },
  'mountain': {
    spring: { aqiMultiplier: 0.9, ozoneRisk: 'moderate', particulateRisk: 'low', pollenLevel: 'low', description: 'Clean mountain air' },
    summer: { aqiMultiplier: 1.3, ozoneRisk: 'high', particulateRisk: 'moderate', pollenLevel: 'moderate', description: 'High altitude ozone + smoke' },
    fall: { aqiMultiplier: 1.1, ozoneRisk: 'moderate', particulateRisk: 'moderate', pollenLevel: 'low', description: 'Some wildfire smoke' },
    winter: { aqiMultiplier: 1.2, ozoneRisk: 'low', particulateRisk: 'moderate', pollenLevel: 'none', description: 'Inversions trap pollution' }
  },
  'southwest': {
    spring: { aqiMultiplier: 1.1, ozoneRisk: 'high', particulateRisk: 'high', pollenLevel: 'high', description: 'Dust storms + pollen' },
    summer: { aqiMultiplier: 1.4, ozoneRisk: 'high', particulateRisk: 'moderate', pollenLevel: 'moderate', description: 'Extreme heat = high ozone' },
    fall: { aqiMultiplier: 1.0, ozoneRisk: 'moderate', particulateRisk: 'moderate', pollenLevel: 'moderate', description: 'Improving conditions' },
    winter: { aqiMultiplier: 0.8, ozoneRisk: 'low', particulateRisk: 'moderate', pollenLevel: 'low', description: 'Cool, dust possible' }
  },
  'southeast': {
    spring: { aqiMultiplier: 1.1, ozoneRisk: 'moderate', particulateRisk: 'low', pollenLevel: 'very-high', description: 'Pollen explosion (pine, oak)' },
    summer: { aqiMultiplier: 1.3, ozoneRisk: 'high', particulateRisk: 'moderate', pollenLevel: 'moderate', description: 'Hot, humid = ozone alerts' },
    fall: { aqiMultiplier: 0.9, ozoneRisk: 'moderate', particulateRisk: 'low', pollenLevel: 'moderate', description: 'Ragweed, otherwise improving' },
    winter: { aqiMultiplier: 0.8, ozoneRisk: 'low', particulateRisk: 'low', pollenLevel: 'low', description: 'Generally good air quality' }
  },
  'florida': {
    spring: { aqiMultiplier: 1.0, ozoneRisk: 'moderate', particulateRisk: 'moderate', pollenLevel: 'high', description: 'Pollen + African dust' },
    summer: { aqiMultiplier: 1.2, ozoneRisk: 'high', particulateRisk: 'moderate', pollenLevel: 'low', description: 'Heat, humidity, Saharan dust' },
    fall: { aqiMultiplier: 0.9, ozoneRisk: 'moderate', particulateRisk: 'low', pollenLevel: 'moderate', description: 'Improving air quality' },
    winter: { aqiMultiplier: 0.7, ozoneRisk: 'low', particulateRisk: 'low', pollenLevel: 'low', description: 'Best air quality season' }
  },
  'midwest': {
    spring: { aqiMultiplier: 1.0, ozoneRisk: 'moderate', particulateRisk: 'low', pollenLevel: 'high', description: 'Tree pollen peak' },
    summer: { aqiMultiplier: 1.2, ozoneRisk: 'high', particulateRisk: 'moderate', pollenLevel: 'moderate', description: 'Hot days = ozone buildup' },
    fall: { aqiMultiplier: 1.0, ozoneRisk: 'moderate', particulateRisk: 'moderate', pollenLevel: 'high', description: 'Harvest dust + ragweed' },
    winter: { aqiMultiplier: 0.9, ozoneRisk: 'low', particulateRisk: 'low', pollenLevel: 'none', description: 'Cold keeps air clean' }
  },
  'northeast': {
    spring: { aqiMultiplier: 1.0, ozoneRisk: 'moderate', particulateRisk: 'low', pollenLevel: 'high', description: 'Pollen from trees' },
    summer: { aqiMultiplier: 1.3, ozoneRisk: 'high', particulateRisk: 'moderate', pollenLevel: 'moderate', description: 'Heat waves = ozone alerts' },
    fall: { aqiMultiplier: 0.9, ozoneRisk: 'low', particulateRisk: 'low', pollenLevel: 'moderate', description: 'Ragweed, cleaner air' },
    winter: { aqiMultiplier: 0.9, ozoneRisk: 'low', particulateRisk: 'moderate', pollenLevel: 'none', description: 'Inversions in valleys' }
  }
};

export function getAirQualitySeasonalFactors(latitude: number, longitude: number, season: Season): AirQualitySeasonalFactors {
  const region = getClimateRegion(latitude, longitude);
  return AIR_QUALITY_SEASONAL_DATA[region][season];
}

// ============================================
// NOISE TIME-OF-DAY DATA
// Based on FHWA Traffic Patterns and urban noise studies
// ============================================

interface NoiseTimeFactors {
  trafficMultiplier: number; // Multiplier on road traffic noise
  railMultiplier: number; // Multiplier on rail noise
  airTrafficMultiplier: number; // Multiplier on aircraft noise
  backgroundNoise: number; // Base ambient noise level (dB)
  description: string;
  peakHours?: string;
}

const NOISE_TIME_DATA: Record<TimeOfDay, NoiseTimeFactors> = {
  'night': {
    trafficMultiplier: 0.25,
    railMultiplier: 0.5, // Freight trains still run at night
    airTrafficMultiplier: 0.2, // Red-eye flights only
    backgroundNoise: 35,
    description: 'Quiet night hours - minimal traffic',
    peakHours: '12am - 6am'
  },
  'morning-rush': {
    trafficMultiplier: 1.3,
    railMultiplier: 1.2,
    airTrafficMultiplier: 1.1,
    backgroundNoise: 50,
    description: 'Morning commute - heavy traffic',
    peakHours: '6am - 10am'
  },
  'midday': {
    trafficMultiplier: 0.8,
    railMultiplier: 0.9,
    airTrafficMultiplier: 1.0,
    backgroundNoise: 45,
    description: 'Midday lull - moderate traffic',
    peakHours: '10am - 4pm'
  },
  'evening-rush': {
    trafficMultiplier: 1.4,
    railMultiplier: 1.3,
    airTrafficMultiplier: 1.2,
    backgroundNoise: 52,
    description: 'Evening commute - peak traffic',
    peakHours: '4pm - 8pm'
  },
  'late-evening': {
    trafficMultiplier: 0.5,
    railMultiplier: 0.7,
    airTrafficMultiplier: 0.6,
    backgroundNoise: 40,
    description: 'Evening wind-down - light traffic',
    peakHours: '8pm - 12am'
  }
};

export function getNoiseTimeFactors(timeOfDay: TimeOfDay): NoiseTimeFactors {
  return NOISE_TIME_DATA[timeOfDay];
}

/**
 * Calculate adjusted noise level based on time of day
 */
export function calculateTimeAdjustedNoise(
  baseNoise: number,
  noiseSource: 'road' | 'rail' | 'air',
  timeOfDay: TimeOfDay
): number {
  const factors = getNoiseTimeFactors(timeOfDay);
  
  let multiplier = 1;
  switch (noiseSource) {
    case 'road':
      multiplier = factors.trafficMultiplier;
      break;
    case 'rail':
      multiplier = factors.railMultiplier;
      break;
    case 'air':
      multiplier = factors.airTrafficMultiplier;
      break;
  }
  
  // Apply multiplier but don't go below background noise
  return Math.max(factors.backgroundNoise, baseNoise * multiplier);
}

// ============================================
// UI HELPER DATA
// ============================================

export const SEASON_OPTIONS: { value: Season; label: string; icon: string }[] = [
  { value: 'spring', label: 'Spring', icon: '🌸' },
  { value: 'summer', label: 'Summer', icon: '☀️' },
  { value: 'fall', label: 'Fall', icon: '🍂' },
  { value: 'winter', label: 'Winter', icon: '❄️' }
];

export const STORM_INTENSITY_OPTIONS: { value: StormIntensity; label: string; description: string }[] = [
  { value: 0.5, label: '0.5"', description: 'Light rain' },
  { value: 1, label: '1"', description: 'Moderate' },
  { value: 2, label: '2"', description: 'Heavy' },
  { value: 3, label: '3"', description: 'Very Heavy' },
  { value: 4, label: '4"', description: 'Extreme' },
  { value: 6, label: '6"', description: 'Catastrophic' }
];

export const TIME_OF_DAY_OPTIONS: { value: TimeOfDay; label: string; icon: string; hours: string }[] = [
  { value: 'night', label: 'Night', icon: '🌙', hours: '12am-6am' },
  { value: 'morning-rush', label: 'Morning Rush', icon: '🌅', hours: '6am-10am' },
  { value: 'midday', label: 'Midday', icon: '☀️', hours: '10am-4pm' },
  { value: 'evening-rush', label: 'Evening Rush', icon: '🌆', hours: '4pm-8pm' },
  { value: 'late-evening', label: 'Evening', icon: '🌃', hours: '8pm-12am' }
];
