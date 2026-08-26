/**
 * Regional Market Analyzer
 * Analyzes regional economic data to determine market heat and investment viability
 * Uses FRED data for unemployment, income, housing prices, and other economic indicators
 */

import {
  RegionalMarketAnalysis,
  RegionalEconomicData,
  MarketDemandSignals,
  MarketHeatLevel,
  EconomicIndicator,
  AttomProperty
} from '../types/propertyAnalysis';

// ============================================================================
// CONSTANTS AND BENCHMARKS
// ============================================================================

// National benchmark averages (approximate 2024 values)
const NATIONAL_BENCHMARKS = {
  unemployment: 4.0, // 4% national average
  jobGrowth: 1.5, // 1.5% annual job growth
  medianIncome: 75000, // $75k median household income
  incomeGrowth: 3.0, // 3% annual income growth
  populationGrowth: 0.5, // 0.5% annual population growth
  vacancyRate: 6.5, // 6.5% rental vacancy rate
  rentGrowth: 3.5, // 3.5% annual rent growth
  homeValueGrowth: 4.0, // 4% annual home value appreciation
  daysOnMarket: 45, // 45 days average
  inventoryMonths: 4.0, // 4 months supply
};

// Weight factors for market heat calculation
const HEAT_WEIGHTS = {
  unemployment: 0.12, // Lower is better
  jobGrowth: 0.15, // Higher is better
  incomeGrowth: 0.10, // Higher is better
  populationGrowth: 0.12, // Higher is better
  vacancyRate: 0.15, // Lower is better for landlords
  rentGrowth: 0.12, // Higher is better
  homeValueGrowth: 0.10, // Higher is better
  daysOnMarket: 0.07, // Lower indicates hot market
  inventoryMonths: 0.07, // Lower indicates hot market
};

// ============================================================================
// MAIN ANALYSIS FUNCTION
// ============================================================================

/**
 * Analyze regional market conditions for a property
 * @param property - ATTOM property data with address info
 * @param regionalData - FRED API regional economic data
 * @returns Complete regional market analysis
 */
export function analyzeRegionalMarket(
  property: AttomProperty,
  regionalData: FREDRegionalData
): RegionalMarketAnalysis {
  console.log('[Regional Market] Starting analysis for', property.address);

  // Extract metro area and state from property
  const { metroArea, stateCode } = extractLocationInfo(property);
  
  // Process economic indicators
  const economicData = processEconomicData(regionalData);
  
  // Calculate market heat score (0-100)
  const marketHeatScore = calculateMarketHeatScore(economicData);
  
  // Determine market heat level
  const marketHeat = getMarketHeatLevel(marketHeatScore);
  
  // Calculate demand signals
  const demandSignals = calculateDemandSignals(economicData);
  
  // Calculate rental market strength
  const rentalMarketStrength = calculateRentalMarketStrength(economicData);
  
  // Calculate investment viability
  const investmentViability = calculateInvestmentViability(economicData, marketHeatScore);
  
  // Determine vacancy risk
  const vacancyRisk = determineVacancyRisk(economicData);
  
  // Determine market trend
  const marketTrend = determineMarketTrend(economicData);
  
  // Generate analysis summary
  const { summary, strengths, weaknesses, outlook } = generateMarketSummary(
    marketHeat,
    marketHeatScore,
    economicData,
    demandSignals
  );

  return {
    metroArea,
    stateCode,
    marketHeat,
    marketHeatScore,
    economicData,
    demandSignals,
    rentalMarketStrength,
    investmentViability,
    vacancyRisk,
    marketTrend,
    summary,
    strengths,
    weaknesses,
    outlook,
    confidenceLevel: determineConfidenceLevel(regionalData),
    dataSources: ['FRED Economic Data', 'BLS Employment Statistics', 'Census Bureau']
  };
}

// ============================================================================
// DATA PROCESSING FUNCTIONS
// ============================================================================

interface FREDRegionalData {
  current?: {
    housingIndex?: { value: string; date: string; yoy: string | null };
    unemployment?: { value: string; date: string; change: string | null };
    medianIncome?: { value: string; date: string; growth: string | null };
    averageWage?: { value: string; date: string; growth: string | null };
  };
  charts?: {
    housing?: Array<{ date: string; value: number }>;
    unemployment?: Array<{ date: string; value: number }>;
    wages?: Array<{ date: string; value: number }>;
    income?: Array<{ date: string; value: number }>;
  };
  // Additional data that might come from other sources
  vacancyRate?: number;
  rentGrowth?: number;
  populationGrowth?: number;
  daysOnMarket?: number;
  inventoryMonths?: number;
}

function extractLocationInfo(property: AttomProperty): { metroArea: string; stateCode: string } {
  const address = property.address || '';
  
  // Try to extract state code from address (format: "City, ST ZIP")
  const stateMatch = address.match(/,\s*([A-Z]{2})\s+\d{5}/);
  const stateCode = stateMatch ? stateMatch[1] : '';
  
  // Get metro area from area_context or derive from address
  const metroArea = property.area_context?.municipality || 
                    address.split(',')[0]?.trim() || 
                    'Unknown Metro';
  
  return { metroArea, stateCode };
}

function processEconomicData(data: FREDRegionalData): RegionalEconomicData {
  // Process unemployment
  const unemploymentValue = parseFloat(data.current?.unemployment?.value || '4.0');
  const unemploymentChange = parseFloat(data.current?.unemployment?.change || '0');
  
  // Process income data
  const medianIncomeValue = parseFloat(data.current?.medianIncome?.value || '75000');
  const incomeGrowth = parseFloat(data.current?.medianIncome?.growth || '3.0');
  
  // Process housing data
  const homeValueGrowth = parseFloat(data.current?.housingIndex?.yoy || '4.0');
  
  // Calculate trends from chart data
  const unemploymentTrend = calculateTrend(data.charts?.unemployment);
  const incomeTrend = calculateTrend(data.charts?.income);
  const housingTrend = calculateTrend(data.charts?.housing);
  
  // Use defaults or passed data for other metrics
  const vacancyRate = data.vacancyRate ?? 6.5;
  const rentGrowth = data.rentGrowth ?? estimateRentGrowth(homeValueGrowth, unemploymentValue);
  const populationGrowth = data.populationGrowth ?? estimatePopulationGrowth(unemploymentValue, incomeGrowth);
  const daysOnMarket = data.daysOnMarket ?? estimateDaysOnMarket(homeValueGrowth, vacancyRate);
  const inventoryMonths = data.inventoryMonths ?? estimateInventory(homeValueGrowth, daysOnMarket);
  
  // Calculate job growth from unemployment trend
  const jobGrowth = estimateJobGrowth(unemploymentValue, unemploymentChange, unemploymentTrend);

  return {
    unemployment: createIndicator(unemploymentValue, NATIONAL_BENCHMARKS.unemployment, unemploymentTrend, true),
    jobGrowth: createIndicator(jobGrowth, NATIONAL_BENCHMARKS.jobGrowth, unemploymentTrend === 'declining' ? 'improving' : unemploymentTrend),
    medianIncome: createIndicator(medianIncomeValue, NATIONAL_BENCHMARKS.medianIncome, incomeTrend),
    incomeGrowth: createIndicator(incomeGrowth, NATIONAL_BENCHMARKS.incomeGrowth, incomeTrend),
    populationGrowth: createIndicator(populationGrowth, NATIONAL_BENCHMARKS.populationGrowth, 'stable'),
    vacancyRate: createIndicator(vacancyRate, NATIONAL_BENCHMARKS.vacancyRate, 'stable', true),
    rentGrowth: createIndicator(rentGrowth, NATIONAL_BENCHMARKS.rentGrowth, housingTrend),
    homeValueGrowth: createIndicator(homeValueGrowth, NATIONAL_BENCHMARKS.homeValueGrowth, housingTrend),
    daysOnMarket: createIndicator(daysOnMarket, NATIONAL_BENCHMARKS.daysOnMarket, 'stable', true),
    inventoryMonths: createIndicator(inventoryMonths, NATIONAL_BENCHMARKS.inventoryMonths, 'stable', true),
  };
}

function createIndicator(
  value: number,
  benchmark: number,
  trend: 'improving' | 'stable' | 'declining',
  lowerIsBetter: boolean = false
): EconomicIndicator {
  // Calculate score (0-100)
  let score: number;
  const ratio = value / benchmark;
  
  if (lowerIsBetter) {
    // For metrics where lower is better (unemployment, vacancy, DOM, inventory)
    if (ratio <= 0.5) score = 100;
    else if (ratio >= 2.0) score = 0;
    else score = 100 - ((ratio - 0.5) / 1.5) * 100;
  } else {
    // For metrics where higher is better (job growth, income, rent growth)
    if (ratio >= 2.0) score = 100;
    else if (ratio <= 0.5) score = 0;
    else score = ((ratio - 0.5) / 1.5) * 100;
  }
  
  score = Math.max(0, Math.min(100, score));
  
  // Determine national comparison
  let nationalComparison: 'above_average' | 'average' | 'below_average';
  if (lowerIsBetter) {
    nationalComparison = ratio < 0.9 ? 'above_average' : ratio > 1.1 ? 'below_average' : 'average';
  } else {
    nationalComparison = ratio > 1.1 ? 'above_average' : ratio < 0.9 ? 'below_average' : 'average';
  }
  
  return {
    value,
    trend,
    percentChange: ((value - benchmark) / benchmark) * 100,
    nationalComparison,
    score
  };
}

function calculateTrend(chartData?: Array<{ date: string; value: number }>): 'improving' | 'stable' | 'declining' {
  if (!chartData || chartData.length < 3) return 'stable';
  
  // Get recent values (last 6 data points)
  const recentData = chartData.slice(-6);
  const oldAvg = recentData.slice(0, 3).reduce((sum, d) => sum + d.value, 0) / 3;
  const newAvg = recentData.slice(-3).reduce((sum, d) => sum + d.value, 0) / 3;
  
  const changePercent = ((newAvg - oldAvg) / oldAvg) * 100;
  
  if (changePercent > 2) return 'improving';
  if (changePercent < -2) return 'declining';
  return 'stable';
}

// ============================================================================
// ESTIMATION FUNCTIONS (when real data not available)
// ============================================================================

function estimateRentGrowth(homeValueGrowth: number, unemployment: number): number {
  // Rent growth typically tracks home value growth but more muted
  // Higher unemployment = lower rent growth
  const baseRentGrowth = homeValueGrowth * 0.7;
  const unemploymentFactor = unemployment < 4 ? 1.1 : unemployment > 6 ? 0.8 : 1.0;
  return Math.max(-2, Math.min(10, baseRentGrowth * unemploymentFactor));
}

function estimatePopulationGrowth(unemployment: number, incomeGrowth: number): number {
  // Low unemployment + high income growth = population inflow
  const baseGrowth = 0.5;
  const unemploymentBonus = (4 - unemployment) * 0.2;
  const incomeBonus = (incomeGrowth - 3) * 0.1;
  return Math.max(-1, Math.min(3, baseGrowth + unemploymentBonus + incomeBonus));
}

function estimateJobGrowth(unemployment: number, change: number, trend: string): number {
  // Inverse of unemployment trend
  let baseJobGrowth = 1.5;
  if (trend === 'declining') baseJobGrowth = 2.5; // Declining unemployment = job growth
  if (trend === 'improving') baseJobGrowth = 0.5; // Rising unemployment = slow job growth
  
  // Adjust based on unemployment level
  const levelAdjust = (NATIONAL_BENCHMARKS.unemployment - unemployment) * 0.3;
  
  return Math.max(-1, Math.min(5, baseJobGrowth + levelAdjust - change * 0.5));
}

function estimateDaysOnMarket(homeValueGrowth: number, vacancyRate: number): number {
  // Higher appreciation = faster sales
  const baseDays = 45;
  const appreciationFactor = Math.max(0.5, 1 - homeValueGrowth * 0.05);
  const vacancyFactor = vacancyRate / 6.5;
  return Math.max(10, Math.min(120, baseDays * appreciationFactor * vacancyFactor));
}

function estimateInventory(homeValueGrowth: number, daysOnMarket: number): number {
  // Hot market = low inventory
  const baseInventory = 4.0;
  const appreciationFactor = Math.max(0.3, 1 - homeValueGrowth * 0.08);
  const domFactor = daysOnMarket / 45;
  return Math.max(1, Math.min(12, baseInventory * appreciationFactor * domFactor));
}

// ============================================================================
// MARKET HEAT CALCULATION
// ============================================================================

function calculateMarketHeatScore(data: RegionalEconomicData): number {
  let weightedScore = 0;
  
  // Apply weights (adjusting for metrics where lower is better)
  weightedScore += data.unemployment.score * HEAT_WEIGHTS.unemployment;
  weightedScore += data.jobGrowth.score * HEAT_WEIGHTS.jobGrowth;
  weightedScore += data.incomeGrowth.score * HEAT_WEIGHTS.incomeGrowth;
  weightedScore += data.populationGrowth.score * HEAT_WEIGHTS.populationGrowth;
  weightedScore += data.vacancyRate.score * HEAT_WEIGHTS.vacancyRate;
  weightedScore += data.rentGrowth.score * HEAT_WEIGHTS.rentGrowth;
  weightedScore += data.homeValueGrowth.score * HEAT_WEIGHTS.homeValueGrowth;
  weightedScore += data.daysOnMarket.score * HEAT_WEIGHTS.daysOnMarket;
  weightedScore += data.inventoryMonths.score * HEAT_WEIGHTS.inventoryMonths;
  
  // Normalize to 0-100
  const totalWeight = Object.values(HEAT_WEIGHTS).reduce((a, b) => a + b, 0);
  return Math.round(weightedScore / totalWeight);
}

function getMarketHeatLevel(score: number): MarketHeatLevel {
  if (score >= 85) return 'very_hot';
  if (score >= 70) return 'hot';
  if (score >= 55) return 'warm';
  if (score >= 45) return 'neutral';
  if (score >= 30) return 'cool';
  if (score >= 15) return 'cold';
  return 'very_cold';
}

// ============================================================================
// DEMAND SIGNALS CALCULATION
// ============================================================================

function calculateDemandSignals(data: RegionalEconomicData): MarketDemandSignals {
  // Rental demand based on vacancy rate, rent growth, population growth
  const rentalDemandScore = (
    data.vacancyRate.score * 0.4 +
    data.rentGrowth.score * 0.3 +
    data.populationGrowth.score * 0.3
  );
  
  // Purchase demand based on DOM, inventory, home value growth
  const purchaseDemandScore = (
    data.daysOnMarket.score * 0.35 +
    data.inventoryMonths.score * 0.35 +
    data.homeValueGrowth.score * 0.3
  );
  
  // Investor activity based on rent growth vs price growth spread
  const yieldSpread = data.rentGrowth.value - data.homeValueGrowth.value;
  const investorScore = 50 + yieldSpread * 10;
  
  // Supply constraint based on inventory and DOM
  const supplyScore = (data.inventoryMonths.score + data.daysOnMarket.score) / 2;

  return {
    rentalDemand: getDemandLevel(rentalDemandScore),
    purchaseDemand: getDemandLevel(purchaseDemandScore),
    investorActivity: getDemandLevel(Math.max(0, Math.min(100, investorScore))),
    supplyConstraint: getSupplyLevel(supplyScore)
  };
}

function getDemandLevel(score: number): 'very_high' | 'high' | 'moderate' | 'low' | 'very_low' {
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'very_low';
}

function getSupplyLevel(score: number): 'severe' | 'moderate' | 'balanced' | 'oversupply' {
  if (score >= 75) return 'severe'; // Low inventory = severe constraint
  if (score >= 50) return 'moderate';
  if (score >= 30) return 'balanced';
  return 'oversupply';
}

// ============================================================================
// ADDITIONAL METRICS
// ============================================================================

function calculateRentalMarketStrength(data: RegionalEconomicData): number {
  // Weight factors for rental market
  const score = (
    data.vacancyRate.score * 0.30 +
    data.rentGrowth.score * 0.25 +
    data.populationGrowth.score * 0.15 +
    data.jobGrowth.score * 0.15 +
    data.incomeGrowth.score * 0.15
  );
  return Math.round(score);
}

function calculateInvestmentViability(data: RegionalEconomicData, heatScore: number): number {
  // For investors, we want strong rental demand but not overheated purchase prices
  // Sweet spot is warm-to-hot markets, not very_hot (overpriced)
  
  const rentalStrength = calculateRentalMarketStrength(data);
  
  // Penalty for extremely hot markets (may be overpriced)
  const pricingPenalty = heatScore > 85 ? (heatScore - 85) * 2 : 0;
  
  // Bonus for strong fundamentals
  const fundamentalsBonus = (
    data.jobGrowth.score * 0.3 +
    data.incomeGrowth.score * 0.3 +
    data.populationGrowth.score * 0.4
  ) / 10;
  
  return Math.round(Math.max(0, Math.min(100, rentalStrength - pricingPenalty + fundamentalsBonus)));
}

function determineVacancyRisk(data: RegionalEconomicData): 'very_low' | 'low' | 'moderate' | 'high' | 'very_high' {
  const vacancyScore = data.vacancyRate.score;
  const demandScore = (data.populationGrowth.score + data.jobGrowth.score) / 2;
  const combinedScore = vacancyScore * 0.6 + demandScore * 0.4;
  
  if (combinedScore >= 80) return 'very_low';
  if (combinedScore >= 60) return 'low';
  if (combinedScore >= 40) return 'moderate';
  if (combinedScore >= 20) return 'high';
  return 'very_high';
}

function determineMarketTrend(data: RegionalEconomicData): 'accelerating' | 'growing' | 'stable' | 'slowing' | 'declining' {
  // Count improving vs declining indicators
  const indicators = [
    data.unemployment,
    data.jobGrowth,
    data.incomeGrowth,
    data.rentGrowth,
    data.homeValueGrowth
  ];
  
  const improving = indicators.filter(i => i.trend === 'improving').length;
  const declining = indicators.filter(i => i.trend === 'declining').length;
  
  if (improving >= 4) return 'accelerating';
  if (improving >= 2 && declining === 0) return 'growing';
  if (declining >= 4) return 'declining';
  if (declining >= 2) return 'slowing';
  return 'stable';
}

function determineConfidenceLevel(data: FREDRegionalData): 'high' | 'medium' | 'low' {
  // Check how much real data we have
  let dataPoints = 0;
  
  if (data.current?.unemployment?.value) dataPoints++;
  if (data.current?.medianIncome?.value) dataPoints++;
  if (data.current?.housingIndex?.value) dataPoints++;
  if (data.charts?.housing?.length && data.charts.housing.length > 5) dataPoints++;
  if (data.charts?.unemployment?.length && data.charts.unemployment.length > 5) dataPoints++;
  if (data.vacancyRate !== undefined) dataPoints++;
  if (data.rentGrowth !== undefined) dataPoints++;
  
  if (dataPoints >= 5) return 'high';
  if (dataPoints >= 3) return 'medium';
  return 'low';
}

// ============================================================================
// SUMMARY GENERATION
// ============================================================================

function generateMarketSummary(
  heat: MarketHeatLevel,
  score: number,
  data: RegionalEconomicData,
  demand: MarketDemandSignals
): { summary: string; strengths: string[]; weaknesses: string[]; outlook: string } {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  
  // Analyze strengths
  if (data.unemployment.score >= 70) {
    strengths.push(`Low unemployment (${data.unemployment.value.toFixed(1)}%) signals strong job market`);
  }
  if (data.jobGrowth.score >= 70) {
    strengths.push(`Strong job growth (${data.jobGrowth.value.toFixed(1)}%) attracting new residents`);
  }
  if (data.rentGrowth.score >= 70) {
    strengths.push(`Healthy rent growth (${data.rentGrowth.value.toFixed(1)}%) indicates rental demand`);
  }
  if (data.vacancyRate.score >= 70) {
    strengths.push(`Low vacancy rate (${data.vacancyRate.value.toFixed(1)}%) reduces tenant finding risk`);
  }
  if (data.populationGrowth.score >= 70) {
    strengths.push(`Strong population growth (${data.populationGrowth.value.toFixed(1)}%) expanding tenant pool`);
  }
  if (data.incomeGrowth.score >= 70) {
    strengths.push(`Rising incomes (${data.incomeGrowth.value.toFixed(1)}% growth) support rent increases`);
  }
  if (demand.supplyConstraint === 'severe' || demand.supplyConstraint === 'moderate') {
    strengths.push('Limited housing supply supports property values');
  }

  // Analyze weaknesses
  if (data.unemployment.score < 40) {
    weaknesses.push(`Elevated unemployment (${data.unemployment.value.toFixed(1)}%) may affect tenant quality`);
  }
  if (data.jobGrowth.score < 40) {
    weaknesses.push('Weak job growth may limit tenant demand');
  }
  if (data.vacancyRate.score < 40) {
    weaknesses.push(`High vacancy rate (${data.vacancyRate.value.toFixed(1)}%) increases lease-up risk`);
  }
  if (data.populationGrowth.score < 40) {
    weaknesses.push('Stagnant or declining population may reduce long-term demand');
  }
  if (data.homeValueGrowth.score >= 85 && data.rentGrowth.score < 60) {
    weaknesses.push('Home prices rising faster than rents may compress yields');
  }
  if (demand.supplyConstraint === 'oversupply') {
    weaknesses.push('Oversupply in market may pressure rents and increase competition');
  }
  if (data.daysOnMarket.score < 40) {
    weaknesses.push('Slow market (high days on market) may affect exit timing');
  }

  // Generate summary
  let summary: string;
  if (heat === 'very_hot' || heat === 'hot') {
    summary = `This is a ${heat.replace('_', ' ')} market (score: ${score}/100) with strong fundamentals. ` +
      `High demand and limited supply create favorable conditions for rental property investment, ` +
      `though valuations may be elevated.`;
  } else if (heat === 'warm') {
    summary = `This is a warm market (score: ${score}/100) with solid fundamentals. ` +
      `Balanced supply and demand create stable conditions for rental investment with ` +
      `reasonable entry points and growth potential.`;
  } else if (heat === 'neutral') {
    summary = `This is a neutral market (score: ${score}/100). ` +
      `Market conditions are balanced without strong directional momentum. ` +
      `Investment success will depend more on property-specific factors.`;
  } else if (heat === 'cool') {
    summary = `This is a cool market (score: ${score}/100). ` +
      `Some headwinds exist that may affect rental demand or property values. ` +
      `Careful due diligence on tenant demand and employment trends is recommended.`;
  } else {
    summary = `This is a cold market (score: ${score}/100) with challenging fundamentals. ` +
      `Economic headwinds may increase vacancy risk and limit rent growth. ` +
      `Consider whether strong property-level factors can offset market conditions.`;
  }

  // Generate outlook
  let outlook: string;
  const trend = data.jobGrowth.trend;
  if (trend === 'improving' && score >= 50) {
    outlook = 'Market fundamentals are strengthening. Expect continued demand growth and potential for rent increases.';
  } else if (trend === 'improving' && score < 50) {
    outlook = 'Market is recovering from weakness. Monitor employment trends for signs of sustained improvement.';
  } else if (trend === 'declining' && score >= 60) {
    outlook = 'Strong market showing some cooling signs. Watch for potential normalization of rent growth.';
  } else if (trend === 'declining') {
    outlook = 'Market facing headwinds. Exercise caution and consider building in larger reserves for potential vacancy.';
  } else {
    outlook = 'Market conditions are stable. Expect steady performance aligned with property-level factors.';
  }

  return { summary, strengths, weaknesses, outlook };
}

// ============================================================================
// FALLBACK ANALYSIS (when no FRED data available)
// ============================================================================

export function createFallbackRegionalAnalysis(property: AttomProperty): RegionalMarketAnalysis {
  const { metroArea, stateCode } = extractLocationInfo(property);
  
  // Use state-based defaults
  const stateHeatMap: Record<string, number> = {
    'TX': 68, 'FL': 65, 'AZ': 63, 'NC': 62, 'GA': 60,
    'TN': 58, 'SC': 55, 'CO': 70, 'WA': 67, 'UT': 72,
    'ID': 65, 'NV': 60, 'CA': 55, 'NY': 50, 'IL': 45,
    'OH': 48, 'PA': 47, 'MI': 46, 'WV': 35, 'LA': 40,
  };
  
  const baseScore = stateHeatMap[stateCode] || 50;
  
  // Create synthetic economic data
  const economicData: RegionalEconomicData = {
    unemployment: createIndicator(4.0, NATIONAL_BENCHMARKS.unemployment, 'stable', true),
    jobGrowth: createIndicator(1.5, NATIONAL_BENCHMARKS.jobGrowth, 'stable'),
    medianIncome: createIndicator(75000, NATIONAL_BENCHMARKS.medianIncome, 'stable'),
    incomeGrowth: createIndicator(3.0, NATIONAL_BENCHMARKS.incomeGrowth, 'stable'),
    populationGrowth: createIndicator(0.5, NATIONAL_BENCHMARKS.populationGrowth, 'stable'),
    vacancyRate: createIndicator(6.5, NATIONAL_BENCHMARKS.vacancyRate, 'stable', true),
    rentGrowth: createIndicator(3.5, NATIONAL_BENCHMARKS.rentGrowth, 'stable'),
    homeValueGrowth: createIndicator(4.0, NATIONAL_BENCHMARKS.homeValueGrowth, 'stable'),
    daysOnMarket: createIndicator(45, NATIONAL_BENCHMARKS.daysOnMarket, 'stable', true),
    inventoryMonths: createIndicator(4.0, NATIONAL_BENCHMARKS.inventoryMonths, 'stable', true),
  };

  return {
    metroArea,
    stateCode,
    marketHeat: getMarketHeatLevel(baseScore),
    marketHeatScore: baseScore,
    economicData,
    demandSignals: {
      rentalDemand: 'moderate',
      purchaseDemand: 'moderate',
      investorActivity: 'moderate',
      supplyConstraint: 'balanced'
    },
    rentalMarketStrength: 50,
    investmentViability: 50,
    vacancyRisk: 'moderate',
    marketTrend: 'stable',
    summary: `Market analysis based on limited data for ${metroArea}, ${stateCode}. ` +
      `State-level indicators suggest average market conditions. ` +
      `Consider obtaining local market data for more accurate analysis.`,
    strengths: ['State has diversified economy'],
    weaknesses: ['Limited local market data available'],
    outlook: 'Neutral outlook based on state-level data. Local conditions may vary.',
    confidenceLevel: 'low',
    dataSources: ['State-level estimates']
  };
}
