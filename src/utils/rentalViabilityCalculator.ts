/**
 * Rental Viability Calculator
 * Analyzes cash flow, investment metrics, and rental performance across multiple financing scenarios
 * Now integrates regional market data for more accurate vacancy and rent growth projections
 * Includes tenant quality analysis based on area economic indicators
 */

import {
  AttomProperty,
  DetailedConditionScore,
  FinancingScenario,
  IncomeAnalysis,
  OperatingExpenses,
  CashFlowAnalysis,
  InvestmentMetrics,
  RentalScenario,
  ViabilityStatus,
  RegionalMarketAnalysis,
  TenantQualityAnalysis
} from '../types/propertyAnalysis';
import { getConditionMultiplier } from './conditionScoring';

// ============================================================================
// TENANT QUALITY ANALYSIS
// ============================================================================

/**
 * Analyze likely tenant quality based on regional economic indicators
 * Factors in median income, unemployment, job growth, and affordability
 */
export function analyzeTenantQuality(
  property: AttomProperty,
  regionalMarket?: RegionalMarketAnalysis
): TenantQualityAnalysis {
  
  const monthlyRent = property.rental_avm || 0;
  
  // Default values if no regional data
  if (!regionalMarket || !regionalMarket.economicData) {
    console.log('[Tenant Quality] No regional data - using defaults');
    return createDefaultTenantQuality(monthlyRent);
  }
  
  const econ = regionalMarket.economicData;
  
  // =========================================================================
  // SCORE EACH ECONOMIC FACTOR (0-100)
  // =========================================================================
  
  // 1. Median Income Score
  // National median household income ~$75,000/year
  // Higher income = better ability to pay rent
  const medianIncome = econ.medianIncome?.value || 60000;
  const medianIncomeScore = Math.min(100, Math.max(0, 
    (medianIncome / 75000) * 70 + 15 // Scale: $50k=62, $75k=85, $100k=100
  ));
  
  // 2. Unemployment Score (lower is better)
  // National avg ~4%, below 3.5% is excellent, above 6% is concerning
  const unemploymentRate = econ.unemployment?.value || 4.5;
  const unemploymentScore = Math.min(100, Math.max(0,
    100 - (unemploymentRate * 12) // 3%=64, 4%=52, 5%=40, 6%=28
  ));
  
  // 3. Job Growth Score
  // 2%+ annual job growth is strong, negative is concerning
  const jobGrowthRate = econ.jobGrowth?.value || 1.0;
  const jobGrowthScore = Math.min(100, Math.max(0,
    50 + (jobGrowthRate * 20) // -1%=30, 0%=50, 2%=90, 3%=100
  ));
  
  // 4. Income Stability Score (based on income growth trend)
  const incomeGrowth = econ.incomeGrowth?.value || 2.0;
  const incomeStabilityScore = Math.min(100, Math.max(0,
    50 + (incomeGrowth * 15) // -2%=20, 0%=50, 3%=95
  ));
  
  // =========================================================================
  // CALCULATE RENT-TO-INCOME & AFFORDABILITY
  // =========================================================================
  
  // Monthly income from annual median
  const monthlyIncome = medianIncome / 12;
  
  // Area rent-to-income ratio (30% is standard healthy threshold)
  const areaRentToIncomeRatio = monthlyRent > 0 && monthlyIncome > 0
    ? (monthlyRent / monthlyIncome) * 100
    : 30;
  
  // Affordability score: 100 at 20% RTI, 70 at 30% RTI, 40 at 40% RTI, 0 at 50%+
  const affordabilityScore = Math.min(100, Math.max(0,
    100 - ((areaRentToIncomeRatio - 20) * 3)
  ));
  
  // =========================================================================
  // CALCULATE OVERALL SCORE & PAYMENT RELIABILITY
  // =========================================================================
  
  // Weight the factors
  const overallScore = (
    medianIncomeScore * 0.30 +      // Income most important
    unemploymentScore * 0.25 +       // Employment stability
    affordabilityScore * 0.25 +      // Can they afford the rent?
    jobGrowthScore * 0.12 +          // Future employment outlook
    incomeStabilityScore * 0.08      // Income trend
  );
  
  // Determine quality tier
  let qualityTier: 'excellent' | 'good' | 'average' | 'below_average' | 'high_risk';
  if (overallScore >= 80) qualityTier = 'excellent';
  else if (overallScore >= 65) qualityTier = 'good';
  else if (overallScore >= 50) qualityTier = 'average';
  else if (overallScore >= 35) qualityTier = 'below_average';
  else qualityTier = 'high_risk';
  
  // =========================================================================
  // PAYMENT RELIABILITY ESTIMATES
  // Based on research: payment delinquency correlates with unemployment & RTI
  // =========================================================================
  
  // Base on-time payment probability: 95% for excellent areas, down to 80% for high-risk
  const onTimePaymentProbability = Math.min(98, Math.max(75,
    75 + (overallScore * 0.23)
  ));
  
  // Missed payment risk (inverse of on-time)
  const missedPaymentRisk = 100 - onTimePaymentProbability;
  
  // Eviction risk level
  let evictionRiskLevel: 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
  if (overallScore >= 80 && areaRentToIncomeRatio < 28) evictionRiskLevel = 'very_low';
  else if (overallScore >= 65 && areaRentToIncomeRatio < 32) evictionRiskLevel = 'low';
  else if (overallScore >= 50 || areaRentToIncomeRatio < 38) evictionRiskLevel = 'moderate';
  else if (overallScore >= 35) evictionRiskLevel = 'high';
  else evictionRiskLevel = 'very_high';
  
  // =========================================================================
  // RISK ADJUSTMENTS FOR FINANCIAL CALCULATIONS
  // =========================================================================
  
  // Bad debt reserve: 0-3% of rent based on risk
  const badDebtPercent = Math.max(0, (100 - overallScore) * 0.03);
  const badDebtReserveRecommended = monthlyRent * (badDebtPercent / 100);
  
  // Additional vacancy for turnover (higher risk = more turnover)
  const effectiveVacancyAdjustment = qualityTier === 'excellent' ? 0 :
    qualityTier === 'good' ? 0.01 :
    qualityTier === 'average' ? 0.02 :
    qualityTier === 'below_average' ? 0.03 : 0.05;
  
  // =========================================================================
  // GENERATE STRENGTHS, RISKS, AND RECOMMENDATION
  // =========================================================================
  
  const strengths: string[] = [];
  const risks: string[] = [];
  
  // Analyze each factor
  if (medianIncomeScore >= 75) {
    strengths.push(`Strong median income ($${medianIncome.toLocaleString()}/yr)`);
  } else if (medianIncomeScore < 50) {
    risks.push(`Below-average median income ($${medianIncome.toLocaleString()}/yr)`);
  }
  
  if (unemploymentScore >= 60) {
    strengths.push(`Low unemployment (${unemploymentRate.toFixed(1)}%)`);
  } else if (unemploymentScore < 40) {
    risks.push(`Elevated unemployment (${unemploymentRate.toFixed(1)}%)`);
  }
  
  if (jobGrowthScore >= 70) {
    strengths.push(`Strong job growth (${jobGrowthRate.toFixed(1)}%)`);
  } else if (jobGrowthScore < 40) {
    risks.push(`Weak/negative job growth (${jobGrowthRate.toFixed(1)}%)`);
  }
  
  if (affordabilityScore >= 70) {
    strengths.push(`Affordable rent-to-income ratio (${areaRentToIncomeRatio.toFixed(0)}%)`);
  } else if (affordabilityScore < 40) {
    risks.push(`High rent burden for area (${areaRentToIncomeRatio.toFixed(0)}% of income)`);
  }
  
  if (incomeStabilityScore >= 70) {
    strengths.push(`Growing incomes (${incomeGrowth.toFixed(1)}% growth)`);
  } else if (incomeStabilityScore < 40) {
    risks.push(`Stagnant/declining incomes (${incomeGrowth.toFixed(1)}% growth)`);
  }
  
  // Generate recommendation
  let recommendation: string;
  switch (qualityTier) {
    case 'excellent':
      recommendation = `Excellent tenant pool. ${onTimePaymentProbability.toFixed(0)}% on-time payment likelihood. Strong income and employment in the area.`;
      break;
    case 'good':
      recommendation = `Good tenant quality expected. ${onTimePaymentProbability.toFixed(0)}% on-time payment likelihood. Standard screening should suffice.`;
      break;
    case 'average':
      recommendation = `Average tenant pool. ${onTimePaymentProbability.toFixed(0)}% on-time payment likelihood. Recommend thorough income verification and 3x rent income requirement.`;
      break;
    case 'below_average':
      recommendation = `Below-average tenant quality. ${onTimePaymentProbability.toFixed(0)}% on-time payment likelihood. Require larger security deposit, verified income 3.5x rent.`;
      break;
    case 'high_risk':
      recommendation = `High-risk tenant area. Only ${onTimePaymentProbability.toFixed(0)}% on-time payment likelihood. Consider Section 8 or guaranteed rent programs.`;
      break;
  }
  
  console.log('[Tenant Quality] Analysis complete:', {
    overallScore: Math.round(overallScore),
    qualityTier,
    medianIncome,
    unemploymentRate,
    rentToIncome: areaRentToIncomeRatio.toFixed(1) + '%',
    onTimePayment: onTimePaymentProbability.toFixed(0) + '%'
  });
  
  return {
    overallScore,
    qualityTier,
    medianIncomeScore,
    unemploymentScore,
    jobGrowthScore,
    incomeStabilityScore,
    onTimePaymentProbability,
    missedPaymentRisk,
    evictionRiskLevel,
    areaRentToIncomeRatio,
    affordabilityScore,
    badDebtReserveRecommended,
    effectiveVacancyAdjustment,
    strengths,
    risks,
    recommendation
  };
}

/**
 * Create default tenant quality analysis when no regional data available
 */
function createDefaultTenantQuality(monthlyRent: number): TenantQualityAnalysis {
  return {
    overallScore: 60,
    qualityTier: 'average',
    medianIncomeScore: 60,
    unemploymentScore: 55,
    jobGrowthScore: 55,
    incomeStabilityScore: 60,
    onTimePaymentProbability: 90,
    missedPaymentRisk: 10,
    evictionRiskLevel: 'moderate',
    areaRentToIncomeRatio: 30,
    affordabilityScore: 60,
    badDebtReserveRecommended: monthlyRent * 0.01,
    effectiveVacancyAdjustment: 0.02,
    strengths: ['Insufficient data - using conservative estimates'],
    risks: ['Regional economic data not available'],
    recommendation: 'Average tenant quality assumed. Recommend standard screening with income verification at 3x rent.'
  };
}

// ============================================================================
// REGIONAL MARKET ADJUSTMENTS
// ============================================================================

/**
 * Get vacancy rate adjustment based on regional market heat AND supply pipeline
 * Hot markets have lower vacancy, cold markets have higher vacancy
 * High building permits/listings YoY growth suggests future vacancy pressure
 */
function getRegionalVacancyRate(regionalMarket?: RegionalMarketAnalysis): number {
  const baseVacancyRate = 0.05; // 5% base vacancy
  
  if (!regionalMarket) return baseVacancyRate;
  
  // Start with market heat based vacancy
  let vacancyRate: number;
  switch (regionalMarket.marketHeat) {
    case 'Very Hot':
      vacancyRate = 0.02; // 2% vacancy in very hot markets
      break;
    case 'Hot':
      vacancyRate = 0.03; // 3% vacancy in hot markets
      break;
    case 'Warm':
      vacancyRate = 0.04; // 4% vacancy in warm markets
      break;
    case 'Neutral':
      vacancyRate = 0.05; // 5% baseline
      break;
    case 'Cool':
      vacancyRate = 0.06; // 6% vacancy in cool markets
      break;
    case 'Cold':
      vacancyRate = 0.08; // 8% vacancy in cold markets
      break;
    case 'Very Cold':
      vacancyRate = 0.10; // 10% vacancy in very cold markets
      break;
    default:
      vacancyRate = baseVacancyRate;
  }
  
  // Adjust for supply pipeline risk (building permits, new listings growth)
  // High supply growth = higher future vacancy risk
  const supplyPipelineRisk = regionalMarket.demandSignals?.supplyPipelineRisk;
  if (supplyPipelineRisk) {
    switch (supplyPipelineRisk) {
      case 'very_high':
        vacancyRate += 0.03; // +3% vacancy adjustment for very high supply pipeline
        console.log('[Vacancy] Supply pipeline VERY HIGH - adding 3% vacancy adjustment');
        break;
      case 'high':
        vacancyRate += 0.02; // +2% vacancy adjustment
        console.log('[Vacancy] Supply pipeline HIGH - adding 2% vacancy adjustment');
        break;
      case 'moderate':
        // No adjustment
        break;
      case 'low':
        vacancyRate -= 0.01; // -1% vacancy (supply constrained)
        console.log('[Vacancy] Supply pipeline LOW - reducing vacancy by 1%');
        break;
      case 'very_low':
        vacancyRate -= 0.015; // -1.5% vacancy (severely supply constrained)
        console.log('[Vacancy] Supply pipeline VERY LOW - reducing vacancy by 1.5%');
        break;
    }
  }
  
  // Also consider specific building permits YoY if available
  const permitsYoY = regionalMarket.demandSignals?.buildingPermitsYoY;
  if (permitsYoY !== undefined && permitsYoY !== null) {
    // High permits growth (>15%) suggests more supply coming in 12-18 months
    if (permitsYoY > 25) {
      vacancyRate += 0.01;
      console.log(`[Vacancy] Building permits YoY ${permitsYoY}% - adding 1% future vacancy risk`);
    } else if (permitsYoY < -15) {
      vacancyRate -= 0.01;
      console.log(`[Vacancy] Building permits YoY ${permitsYoY}% - reducing vacancy by 1% (supply drying up)`);
    }
  }
  
  // Clamp to reasonable range
  return Math.max(0.02, Math.min(0.15, vacancyRate));
}

/**
 * Get rent growth projection based on regional market data AND supply pipeline
 * High supply growth dampens rent growth, low supply allows higher growth
 */
function getRegionalRentGrowth(regionalMarket?: RegionalMarketAnalysis): number {
  const baseRentGrowth = 0.02; // 2% base rent growth
  
  if (!regionalMarket) return baseRentGrowth;
  
  let rentGrowth = baseRentGrowth;
  
  // Use demand signals if available
  if (regionalMarket.demandSignals) {
    const demand = regionalMarket.demandSignals;
    
    // Combine population growth, jobs growth, and income growth
    const populationGrowthFactor = (demand.populationChange && demand.populationChange >= 1.5) ? 0.01 : 
                                    (demand.populationChange && demand.populationChange >= 0.5) ? 0.005 : 0;
    const jobsGrowthFactor = (demand.jobsGrowthRate && demand.jobsGrowthRate >= 2) ? 0.01 :
                              (demand.jobsGrowthRate && demand.jobsGrowthRate >= 1) ? 0.005 : 0;
    const incomeGrowthFactor = (demand.medianIncomeGrowth && demand.medianIncomeGrowth >= 3) ? 0.01 :
                                (demand.medianIncomeGrowth && demand.medianIncomeGrowth >= 1.5) ? 0.005 : 0;
    
    rentGrowth = baseRentGrowth + populationGrowthFactor + jobsGrowthFactor + incomeGrowthFactor;
    
    // Adjust for supply pipeline - high supply dampens rent growth
    const supplyPipelineRisk = demand.supplyPipelineRisk;
    if (supplyPipelineRisk) {
      switch (supplyPipelineRisk) {
        case 'very_high':
          rentGrowth -= 0.02; // -2% rent growth dampening
          console.log('[Rent Growth] Supply pipeline VERY HIGH - reducing rent growth by 2%');
          break;
        case 'high':
          rentGrowth -= 0.01; // -1% rent growth dampening
          console.log('[Rent Growth] Supply pipeline HIGH - reducing rent growth by 1%');
          break;
        case 'moderate':
          // No adjustment
          break;
        case 'low':
          rentGrowth += 0.01; // +1% rent growth boost (supply constrained)
          console.log('[Rent Growth] Supply pipeline LOW - boosting rent growth by 1%');
          break;
        case 'very_low':
          rentGrowth += 0.015; // +1.5% rent growth boost (severely supply constrained)
          console.log('[Rent Growth] Supply pipeline VERY LOW - boosting rent growth by 1.5%');
          break;
      }
    }
    
    return Math.max(0.005, Math.min(0.08, rentGrowth));
  }
  
  // Fall back to market heat level
  switch (regionalMarket.marketHeat) {
    case 'Very Hot':
      rentGrowth = 0.05; // 5% rent growth in very hot markets
      break;
    case 'Hot':
      rentGrowth = 0.04; // 4% rent growth
      break;
    case 'Warm':
      rentGrowth = 0.03; // 3% rent growth
      break;
    case 'Neutral':
      rentGrowth = 0.02; // 2% baseline
      break;
    case 'Cool':
      rentGrowth = 0.015; // 1.5% rent growth
      break;
    case 'Cold':
      rentGrowth = 0.01; // 1% rent growth
      break;
    case 'Very Cold':
      rentGrowth = 0.005; // 0.5% rent growth in very cold markets
      break;
    default:
      rentGrowth = baseRentGrowth;
  }
  
  return rentGrowth;
}

/**
 * Get rent premium/discount based on regional market conditions
 * Hot markets may command higher rents, cold markets may need discounts
 */
function getRegionalRentMultiplier(regionalMarket?: RegionalMarketAnalysis): number {
  if (!regionalMarket) return 1.0;
  
  // Use rental demand indicator if available
  if (regionalMarket.demandSignals?.rentalDemandIndicator) {
    const rentalDemand = regionalMarket.demandSignals.rentalDemandIndicator;
    // Scale: 0-100 where 50 is neutral
    const demandFactor = (rentalDemand - 50) / 500; // +/- 10% max
    return 1.0 + demandFactor;
  }
  
  // Fall back to market heat
  switch (regionalMarket.marketHeat) {
    case 'Very Hot':
      return 1.05; // 5% rent premium in very hot markets
    case 'Hot':
      return 1.03; // 3% premium
    case 'Warm':
      return 1.01; // 1% premium
    case 'Neutral':
      return 1.0;
    case 'Cool':
      return 0.99; // 1% discount to fill units faster
    case 'Cold':
      return 0.97; // 3% discount
    case 'Very Cold':
      return 0.95; // 5% discount in very cold markets
    default:
      return 1.0;
  }
}

// ============================================================================
// MAIN RENTAL ANALYSIS
// ============================================================================

export function analyzeRentalViability(
  property: AttomProperty,
  conditionScore: DetailedConditionScore,
  purchasePrice: number,
  financingScenarios: FinancingScenario[],
  regionalMarket?: RegionalMarketAnalysis
): RentalScenario {
  
  // Analyze tenant quality based on regional economic indicators
  const tenantQuality = analyzeTenantQuality(property, regionalMarket);
  
  const income = calculateIncome(property, conditionScore, regionalMarket);
  
  // Calculate base expenses, then adjust for tenant quality risks
  const baseExpenses = calculateOperatingExpenses(property, purchasePrice, regionalMarket);
  
  // Apply tenant quality adjustments to expenses
  const expenses = applyTenantQualityToExpenses(baseExpenses, tenantQuality, income.finalMonthlyRent);
  
  // Analyze each financing scenario
  const cashFlowResults = financingScenarios.map(scenario => 
    calculateCashFlow(income, expenses, scenario)
  );
  
  // Use best cash flow scenario for metrics
  const bestCashFlow = cashFlowResults.reduce((best, current) => 
    current.monthlyCashFlow > best.monthlyCashFlow ? current : best
  );
  
  const metrics = calculateInvestmentMetrics(
    income,
    expenses,
    bestCashFlow,
    purchasePrice,
    financingScenarios[0] // Use first scenario for calculations
  );
  
  const viability = determineViability(bestCashFlow, metrics);
  const recommendation = generateRentalRecommendation(viability, bestCashFlow, metrics, conditionScore, tenantQuality);
  
  return {
    condition: conditionScore,
    income,
    expenses,
    financingOptions: financingScenarios,
    cashFlow: bestCashFlow,
    metrics,
    viability,
    tenantQuality,
    recommendation
  };
}

/**
 * Apply tenant quality risk adjustments to operating expenses
 * Higher risk areas need more reserves for bad debt and turnover
 */
function applyTenantQualityToExpenses(
  baseExpenses: OperatingExpenses,
  tenantQuality: TenantQualityAnalysis,
  monthlyRent: number
): OperatingExpenses {
  
  // Add bad debt reserve based on tenant quality
  const badDebtReserve = tenantQuality.badDebtReserveRecommended;
  
  // Adjust vacancy for tenant quality (turnover risk)
  const additionalVacancy = monthlyRent * tenantQuality.effectiveVacancyAdjustment;
  const adjustedVacancy = baseExpenses.vacancy + additionalVacancy;
  const adjustedVacancyRate = baseExpenses.vacancyRate + tenantQuality.effectiveVacancyAdjustment;
  
  // Update totals
  const adjustedTotalVariable = baseExpenses.totalVariable + badDebtReserve + additionalVacancy;
  const adjustedTotal = baseExpenses.totalFixed + adjustedTotalVariable;
  
  console.log('[Expenses] Tenant quality adjustments:', {
    qualityTier: tenantQuality.qualityTier,
    badDebtReserve: badDebtReserve.toFixed(0),
    additionalVacancy: additionalVacancy.toFixed(0),
    originalTotal: baseExpenses.total.toFixed(0),
    adjustedTotal: adjustedTotal.toFixed(0)
  });
  
  return {
    ...baseExpenses,
    vacancy: adjustedVacancy,
    vacancyRate: adjustedVacancyRate,
    totalVariable: adjustedTotalVariable,
    total: adjustedTotal,
    expenseRatio: monthlyRent > 0 ? adjustedTotal / monthlyRent : 0
  };
}

// ============================================================================
// INCOME ANALYSIS
// ============================================================================

export function calculateIncome(
  property: AttomProperty,
  conditionScore: DetailedConditionScore,
  regionalMarket?: RegionalMarketAnalysis
): IncomeAnalysis {
  
  const attomRentalAVM = property.rental_avm;
  
  console.log('[Rental Income] ATTOM Rental AVM:', attomRentalAVM);
  console.log('[Rental Income] Property rental fields:', {
    rental_avm: property.rental_avm,
    rental_avm_low: property.rental_avm_low,
    rental_avm_high: property.rental_avm_high
  });
  console.log('[Rental Income] Regional market data:', {
    marketHeat: regionalMarket?.marketHeat || 'unknown',
    rentMultiplier: getRegionalRentMultiplier(regionalMarket)
  });
  
  if (!attomRentalAVM || attomRentalAVM === 0) {
    return {
      attomRentalAVM: 0,
      adjustedMarketRent: 0,
      conditionAdjustment: 0,
      finalMonthlyRent: 0,
      confidenceLevel: 'low',
      rentRange: { low: 0, high: 0 }
    };
  }
  
  // ATTOM Rental AVM already includes regional rates
  // Apply condition adjustment multiplier
  const conditionMultiplier = getConditionMultiplier(conditionScore.overallGrade);
  const adjustedMarketRent = attomRentalAVM * conditionMultiplier;
  
  console.log('[Rental Income] Condition adjustment:', {
    overallGrade: conditionScore.overallGrade,
    overallScore: conditionScore.overallScore,
    conditionMultiplier,
    adjustedMarketRent
  });
  
  // Additional adjustments for specific features
  let finalMonthlyRent = adjustedMarketRent;
  
  // Only apply deferred maintenance impact if we have Visual AI data
  // Without photos, we shouldn't penalize based on hypothetical deferred maintenance
  const hasActualConditionData = conditionScore.overallScore !== 75; // 75 is our default floor
  
  if (hasActualConditionData && conditionScore.deferredMaintenance.length > 0) {
    // Deferred maintenance reduces rent - but cap the impact
    const deferredImpact = conditionScore.deferredMaintenance
      .reduce((sum, item) => sum + item.impactOnRent, 0);
    
    console.log('[Rental Income] Deferred maintenance items:', conditionScore.deferredMaintenance.map(item => ({
      item: item.item,
      impactOnRent: item.impactOnRent
    })));
    console.log('[Rental Income] Total deferred impact:', deferredImpact);
    
    // Cap deferred impact at 10% of rent
    const cappedDeferredImpact = Math.max(deferredImpact, -adjustedMarketRent * 0.10);
    finalMonthlyRent += cappedDeferredImpact;
    
    console.log('[Rental Income] After deferred cap:', {
      uncappedImpact: deferredImpact,
      cappedImpact: cappedDeferredImpact,
      rentAfterDeferred: finalMonthlyRent
    });
  } else {
    console.log('[Rental Income] No Visual AI data - skipping deferred maintenance penalties');
  }
  
  // Quality adjustments - only apply if we have actual condition data
  if (hasActualConditionData) {
    if (conditionScore.interior.kitchen.score >= 85) {
      finalMonthlyRent *= 1.05; // Premium kitchen +5%
    } else if (conditionScore.interior.kitchen.score < 50) {
      finalMonthlyRent *= 0.97; // Very dated kitchen -3%
    }
  }
  
  // Apply regional market rent multiplier
  // Hot markets can command higher rents, cold markets may need discounts
  const regionalRentMultiplier = getRegionalRentMultiplier(regionalMarket);
  finalMonthlyRent *= regionalRentMultiplier;
  
  console.log('[Rental Income] Regional rent adjustment:', {
    marketHeat: regionalMarket?.marketHeat || 'unknown',
    multiplier: regionalRentMultiplier,
    rentAfterRegional: finalMonthlyRent
  });
  
  // Confidence level
  const rentalRange = property.rental_avm_high - property.rental_avm_low;
  const rangePercent = (rentalRange / attomRentalAVM) * 100;
  
  let confidenceLevel: 'high' | 'medium' | 'low' = 'medium';
  if (rangePercent < 15 && conditionScore.overallScore > 70) {
    confidenceLevel = 'high';
  } else if (rangePercent > 25 || conditionScore.overallScore < 50) {
    confidenceLevel = 'low';
  }
  
  const rentRange = {
    low: finalMonthlyRent * 0.90,
    high: finalMonthlyRent * 1.10
  };
  
  return {
    attomRentalAVM,
    adjustedMarketRent,
    conditionAdjustment: conditionMultiplier - 1,
    finalMonthlyRent,
    confidenceLevel,
    rentRange
  };
}

// ============================================================================
// OPERATING EXPENSES
// ============================================================================

export function calculateOperatingExpenses(
  property: AttomProperty,
  purchasePrice: number,
  regionalMarket?: RegionalMarketAnalysis
): OperatingExpenses {
  
  // Property Tax (use actual from ATTOM - tax_amount is ANNUAL)
  // ATTOM returns annual property tax, so divide by 12 for monthly
  const annualPropertyTax = property.tax_history?.[0]?.tax_amount || (purchasePrice * 0.01); // 1% annual default
  const propertyTax = annualPropertyTax / 12;
  
  // Insurance (0.35% of purchase price annually - industry standard)
  const insurance = (purchasePrice * 0.0035) / 12;
  
  // HOA (from property data)
  const hoa = property.hoa_fee || 0;
  
  // Maintenance + CapEx combined (varies by age)
  // Industry standard: 1% of property value annually for maintenance
  // Or 8-12% of monthly rent for maintenance + capex combined
  const age = property.age || new Date().getFullYear() - (property.year_built || 2000);
  let maintenanceRate = 0.08; // 8% of rent default (includes minor repairs)
  
  if (age < 10) maintenanceRate = 0.05;      // Newer homes need less
  else if (age < 20) maintenanceRate = 0.07;
  else if (age < 40) maintenanceRate = 0.08;
  else maintenanceRate = 0.10;               // Older homes need more
  
  const maintenance = (property.rental_avm || 0) * maintenanceRate;
  
  // Capital Expenditures (major replacements - roof, HVAC, etc.)
  // Only add separately for older properties, otherwise included in maintenance
  const capexRate = age > 30 ? 0.03 : 0.02; // 2-3% of rent for capex
  const capex = (property.rental_avm || 0) * capexRate;
  
  // Vacancy - use regional market data for more accurate projection
  // Hot markets have lower vacancy, cold markets have higher vacancy
  const vacancyRate = getRegionalVacancyRate(regionalMarket);
  const vacancy = (property.rental_avm || 0) * vacancyRate;
  
  console.log('[Rental Expenses] Regional vacancy adjustment:', {
    marketHeat: regionalMarket?.marketHeat || 'unknown',
    vacancyRate: (vacancyRate * 100).toFixed(1) + '%',
    monthlyVacancyCost: vacancy.toFixed(0)
  });
  
  // Property Management - flat $15/mo for self-management overhead
  const managementRate = 0;
  const propertyManagement = 15;
  
  // Utilities (if landlord pays)
  const utilities = property.landlord_pays_utilities ? 150 : 0;
  
  const totalFixed = propertyTax + insurance + hoa;
  const totalVariable = maintenance + capex + vacancy + propertyManagement + utilities;
  const total = totalFixed + totalVariable;
  
  const expenseRatio = property.rental_avm ? (total / property.rental_avm) : 0;
  
  return {
    propertyTax,
    insurance,
    hoa,
    maintenance,
    maintenanceRate,
    capex,
    capexRate,
    vacancy,
    vacancyRate,
    propertyManagement,
    managementRate,
    utilities,
    totalFixed,
    totalVariable,
    total,
    expenseRatio
  };
}

// ============================================================================
// CASH FLOW ANALYSIS
// ============================================================================

export function calculateCashFlow(
  income: IncomeAnalysis,
  expenses: OperatingExpenses,
  financing: FinancingScenario
): CashFlowAnalysis {
  
  const monthlyIncome = income.finalMonthlyRent;
  const monthlyExpenses = expenses.total;
  const monthlyDebtService = financing.totalMonthlyDebtService;
  
  const monthlyCashFlow = monthlyIncome - monthlyExpenses - monthlyDebtService;
  const annualCashFlow = monthlyCashFlow * 12;
  
  // Gross Operating Income (before debt service)
  const grossOperatingIncome = monthlyIncome * 12;
  
  // Net Operating Income (after operating expenses, before debt)
  const netOperatingIncome = grossOperatingIncome - (monthlyExpenses * 12);
  
  return {
    monthlyIncome,
    monthlyExpenses,
    monthlyDebtService,
    monthlyCashFlow,
    annualCashFlow,
    grossOperatingIncome,
    netOperatingIncome
  };
}

// ============================================================================
// INVESTMENT METRICS
// ============================================================================

export function calculateInvestmentMetrics(
  income: IncomeAnalysis,
  expenses: OperatingExpenses,
  cashFlow: CashFlowAnalysis,
  purchasePrice: number,
  financing: FinancingScenario
): InvestmentMetrics {
  
  // Cap Rate (NOI / Purchase Price)
  const capRate = (cashFlow.netOperatingIncome / purchasePrice) * 100;
  
  // Cash on Cash Return (Annual Cash Flow / Cash Invested)
  const cashInvested = financing.totalCashRequired;
  const cashOnCash = cashInvested > 0 
    ? (cashFlow.annualCashFlow / cashInvested) * 100
    : 0;
  
  // Debt Service Coverage Ratio (NOI / Annual Debt Service)
  const annualDebtService = financing.totalMonthlyDebtService * 12;
  const dscr = annualDebtService > 0
    ? cashFlow.netOperatingIncome / annualDebtService
    : 999;
  
  // Gross Rent Multiplier (Purchase Price / Annual Rent)
  const annualRent = income.finalMonthlyRent * 12;
  const grm = annualRent > 0 ? purchasePrice / annualRent : 0;
  
  // Break-even Occupancy
  const totalOperatingExpenses = expenses.total * 12;
  const breakEvenOccupancy = annualRent > 0
    ? ((totalOperatingExpenses + annualDebtService) / annualRent) * 100
    : 100;
  
  // Cash Flow Break-even Rent
  const cashFlowBreakEvenRent = (expenses.total + financing.totalMonthlyDebtService);
  
  // Positive Flow Rent (50% CoC target = 4.17% monthly on cash invested)
  const targetMonthlyCashFlow = cashInvested * 0.0042; // ~50% annual / 12
  const positiveFlowRent = expenses.total + financing.totalMonthlyDebtService + targetMonthlyCashFlow;
  
  // 5-Year ROI (simplified: cash flow + appreciation)
  const annualAppreciation = purchasePrice * 0.04; // 4% annual
  const fiveYearAppreciation = annualAppreciation * 5;
  const fiveYearCashFlow = cashFlow.annualCashFlow * 5;
  const roi5Year = cashInvested > 0
    ? ((fiveYearCashFlow + fiveYearAppreciation) / cashInvested) * 100
    : 0;
  
  return {
    capRate,
    cashOnCash,
    dscr,
    grm,
    breakEvenOccupancy,
    cashFlowBreakEvenRent,
    positiveFlowRent,
    roi5Year
  };
}

// ============================================================================
// VIABILITY ASSESSMENT
// ============================================================================

function determineViability(
  cashFlow: CashFlowAnalysis,
  metrics: InvestmentMetrics
): ViabilityStatus {
  
  const monthlyCashFlow = cashFlow.monthlyCashFlow;
  const cashOnCash = metrics.cashOnCash;
  const dscr = metrics.dscr;
  
  // Excellent: >$500/mo, >20% CoC, DSCR >1.4
  if (monthlyCashFlow > 500 && cashOnCash > 20 && dscr > 1.4) {
    return 'excellent';
  }
  
  // Good: >$300/mo, >15% CoC, DSCR >1.25
  if (monthlyCashFlow > 300 && cashOnCash > 15 && dscr > 1.25) {
    return 'good';
  }
  
  // Marginal: >$100/mo, >8% CoC, DSCR >1.15
  if (monthlyCashFlow > 100 && cashOnCash > 8 && dscr > 1.15) {
    return 'marginal';
  }
  
  // Breakeven: -$50 to +$100/mo
  if (monthlyCashFlow > -50 && monthlyCashFlow <= 100) {
    return 'breakeven';
  }
  
  // Negative: <-$50/mo
  if (monthlyCashFlow > -500) {
    return 'negative';
  }
  
  // Avoid: <-$500/mo
  return 'avoid';
}

function generateRentalRecommendation(
  viability: ViabilityStatus,
  cashFlow: CashFlowAnalysis,
  metrics: InvestmentMetrics,
  conditionScore: DetailedConditionScore,
  tenantQuality?: TenantQualityAnalysis
): string {
  
  const cf = cashFlow.monthlyCashFlow;
  const coc = metrics.cashOnCash;
  
  // Build tenant quality context
  const tenantContext = tenantQuality 
    ? ` Tenant quality: ${tenantQuality.qualityTier} (${tenantQuality.onTimePaymentProbability.toFixed(0)}% on-time payment likelihood).`
    : '';
  
  // Add tenant risk warning if applicable
  const tenantWarning = tenantQuality && tenantQuality.qualityTier === 'high_risk'
    ? ' ⚠️ High-risk tenant area - factor in additional reserves.'
    : tenantQuality && tenantQuality.qualityTier === 'below_average'
    ? ' ⚠️ Below-average tenant pool - use strict screening.'
    : '';
  
  switch (viability) {
    case 'excellent':
      return `Excellent rental opportunity! ${cf > 0 ? '+' : ''}$${cf.toFixed(0)}/mo cash flow, ${coc.toFixed(1)}% CoC return.${tenantContext} Strong investment.`;
    
    case 'good':
      return `Good rental property. ${cf > 0 ? '+' : ''}$${cf.toFixed(0)}/mo cash flow, ${coc.toFixed(1)}% CoC.${tenantContext} Solid long-term hold.${tenantWarning}`;
    
    case 'marginal':
      return `Marginal cash flow. ${cf > 0 ? '+' : ''}$${cf.toFixed(0)}/mo, ${coc.toFixed(1)}% CoC.${tenantContext} Consider value-add or negotiate lower price.${tenantWarning}`;
    
    case 'breakeven':
      return `Near break-even. ${cf > 0 ? '+' : ''}$${cf.toFixed(0)}/mo.${tenantContext} Only viable if banking on appreciation or have value-add plan.${tenantWarning}`;
    
    case 'negative':
      if (conditionScore.renovationPotential > 0.3) {
        return `Negative cash flow (${cf.toFixed(0)}/mo), but has ${(conditionScore.renovationPotential * 100).toFixed(0)}% renovation potential.${tenantContext} Consider BRRRR strategy.${tenantWarning}`;
      }
      return `Negative cash flow (${cf.toFixed(0)}/mo).${tenantContext} Not viable as rental without significant renovation or price reduction.${tenantWarning}`;
    
    case 'avoid':
      return `Avoid as rental. Severely negative cash flow (${cf.toFixed(0)}/mo).${tenantContext} Would require major changes to viability.`;
    
    default:
      return 'Unable to determine rental viability.';
  }
}

// ============================================================================
// FINANCING SCENARIOS
// ============================================================================

export function generateFinancingScenarios(
  purchasePrice: number,
  assumableLoan?: any,
  userDownPaymentPercent: number = 20
): FinancingScenario[] {
  
  const scenarios: FinancingScenario[] = [];
  
  console.log('[Financing Scenarios] User down payment:', userDownPaymentPercent + '%');
  console.log('[Financing Scenarios] Assumable loan available:', !!assumableLoan);
  if (assumableLoan) {
    console.log('[Financing Scenarios] Assumable loan details:', {
      assumable: assumableLoan.assumable,
      loanType: assumableLoan.loanType,
      remainingBalance: assumableLoan.remainingBalance,
      estimatedRate: assumableLoan.estimatedRate
    });
  }
  
  // PRIMARY SCENARIO: User's specified down payment
  // Check if there's an assumable loan first
  const hasAssumableLoan = assumableLoan && 
                           (assumableLoan.assumable === 'Yes' || assumableLoan.assumable === 'likely') &&
                           (assumableLoan.loanType === 'FHA' || assumableLoan.loanType === 'VA' || 
                            assumableLoan.loan_type === 'FHA' || assumableLoan.loan_type === 'VA');
  
  if (hasAssumableLoan) {
    // Show assumable mortgage scenario with user's down payment
    console.log('[Financing] Creating hybrid assumable scenario');
    const assumableScenario = generateHybridAssumableScenario(purchasePrice, assumableLoan, userDownPaymentPercent / 100);
    
    // Add house-hack note if FHA
    if (assumableLoan.loanType === 'FHA' || assumableLoan.loan_type === 'FHA') {
      assumableScenario.name = `Your Financing: Assumable FHA @ ${assumableLoan.estimatedRate?.toFixed(2)}% (${userDownPaymentPercent}% Down)`;
    } else {
      assumableScenario.name = `Your Financing: Assumable VA @ ${assumableLoan.estimatedRate?.toFixed(2)}% (${userDownPaymentPercent}% Down)`;
    }
    
    scenarios.push(assumableScenario);
  } else {
    // No assumable loan - show conventional scenario
    console.log('[Financing] No assumable loan, showing conventional');
    scenarios.push({
      ...generateConventionalScenario(purchasePrice, userDownPaymentPercent / 100),
      name: `Your Financing: Conventional (${userDownPaymentPercent}% Down)`
    });
  }
  
  // Calculate savings (none for single scenario, but keep structure)
  scenarios.forEach(scenario => {
    scenario.monthlySavingsVsConventional = 0;
  });
  
  return scenarios;
}

function generateConventionalScenario(
  purchasePrice: number,
  downPaymentPercent: number,
  rateAdjustment: number = 0
): FinancingScenario {
  
  const downPaymentAmount = purchasePrice * downPaymentPercent;
  const loanAmount = purchasePrice - downPaymentAmount;
  const rate = 7.0 + rateAdjustment; // Current market rate ~7%
  const term = 360; // 30 years
  
  const monthlyPayment = calculateMonthlyPayment(loanAmount, rate, term);
  
  return {
    name: `Conventional ${(downPaymentPercent * 100).toFixed(0)}% Down`,
    purchasePrice,
    downPaymentAmount,
    downPaymentPercent: downPaymentPercent * 100,
    newLoan: {
      amount: loanAmount,
      rate,
      term,
      monthlyPayment
    },
    totalLoanAmount: loanAmount,
    totalMonthlyDebtService: monthlyPayment,
    effectiveInterestRate: rate,
    totalCashRequired: downPaymentAmount + purchasePrice * 0.025, // + closing costs
    closingCosts: purchasePrice * 0.025,
    monthlySavingsVsConventional: 0
  };
}

function generateHybridAssumableScenario(
  purchasePrice: number,
  assumableLoan: any,
  downPaymentPercent: number = 0.20
): FinancingScenario {
  
  const loanType = assumableLoan.loanType || assumableLoan.loan_type;
  const isVA = loanType === 'VA';
  
  // Use remainingBalance from assumability analysis (calculated from amortization)
  const assumedBalance = assumableLoan.remainingBalance || assumableLoan.balance || assumableLoan.amount;
  const assumedRate = assumableLoan.estimatedRate || assumableLoan.estimated_interest_rate;
  
  // Calculate assumed monthly payment based on remaining balance
  const remainingMonths = assumableLoan.monthsRemaining || 300;
  const assumedPayment = calculateMonthlyPayment(assumedBalance, assumedRate, remainingMonths);
  
  console.log('[Assumable Loan] Details:', {
    loanType,
    originalAmount: assumableLoan.originalAmount || assumableLoan.amount,
    remainingBalance: assumedBalance,
    monthsElapsed: assumableLoan.monthsElapsed,
    monthsRemaining: remainingMonths,
    estimatedRate: assumedRate,
    monthlyPayment: assumedPayment,
    percentPaid: assumableLoan.percentPaid
  });
  
  // User's down payment on purchase price
  const downPaymentAmount = purchasePrice * downPaymentPercent;
  
  // Gap: what's left after down payment and assumed loan
  const gap = purchasePrice - downPaymentAmount - assumedBalance;
  
  console.log('[Assumable Loan] Financial breakdown:', {
    purchasePrice,
    downPaymentPercent: (downPaymentPercent * 100).toFixed(1) + '%',
    downPayment: downPaymentAmount,
    assumedBalance,
    gap,
    needsNewLoan: gap > 0
  });
  
  let newLoan;
  if (gap > 0) {
    // Need new loan to cover gap
    const newLoanRate = 7.0; // Current market rate
    const newLoanPayment = calculateMonthlyPayment(gap, newLoanRate, 360);
    
    newLoan = {
      amount: gap,
      rate: newLoanRate,
      term: 360,
      monthlyPayment: newLoanPayment
    };
  }
  
  const totalDebtService = assumedPayment + (newLoan?.monthlyPayment || 0);
  const totalLoan = assumedBalance + (newLoan?.amount || 0);
  const effectiveRate = (assumedBalance * assumedRate + (newLoan?.amount || 0) * (newLoan?.rate || 0)) / totalLoan;
  
  const assumptionFee = isVA ? 500 : 1000; // VA cheaper, FHA higher
  const closingCosts = purchasePrice * 0.015 + assumptionFee; // Lower closing costs
  
  const downPaymentPercentDisplay = (downPaymentPercent * 100).toFixed(1);
  const scenarioName = isVA 
    ? `Hybrid Assumable VA Loan (${downPaymentPercentDisplay}% Down) + New Loan`
    : `Hybrid Assumable FHA Loan (${downPaymentPercentDisplay}% Down) + New Loan`;
  
  return {
    name: scenarioName,
    purchasePrice,
    downPaymentAmount,
    downPaymentPercent: downPaymentPercent * 100,
    assumedLoan: {
      balance: assumedBalance,
      rate: assumedRate,
      monthlyPayment: assumedPayment,
      remainingMonths,
      assumptionFee,
      loanType: assumableLoan.loanType || assumableLoan.loan_type
    },
    newLoan,
    totalLoanAmount: totalLoan,
    totalMonthlyDebtService: totalDebtService,
    effectiveInterestRate: effectiveRate,
    totalCashRequired: downPaymentAmount + closingCosts,
    closingCosts,
    monthlySavingsVsConventional: 0,
    assumabilityDetails: assumableLoan
  };
}

function calculateMonthlyPayment(
  principal: number,
  annualRate: number,
  months: number
): number {
  
  const monthlyRate = annualRate / 100 / 12;
  
  if (monthlyRate === 0) return principal / months;
  
  const payment = principal * (
    monthlyRate * Math.pow(1 + monthlyRate, months)
  ) / (
    Math.pow(1 + monthlyRate, months) - 1
  );
  
  return payment;
}

// ============================================================================
// BREAK-EVEN ANALYSIS
// ============================================================================

export function calculateBreakEvenPrice(
  income: IncomeAnalysis,
  expenses: OperatingExpenses,
  targetCashFlow: number = 0, // Break-even by default
  downPaymentPercent: number = 0.20,
  interestRate: number = 7.0
): number {
  
  const monthlyIncome = income.finalMonthlyRent;
  const monthlyExpenses = expenses.total;
  
  // Monthly debt service that results in target cash flow
  const maxDebtService = monthlyIncome - monthlyExpenses - targetCashFlow;
  
  if (maxDebtService <= 0) return 0; // Can't support any debt
  
  // Calculate maximum loan amount that results in this payment
  const monthlyRate = interestRate / 100 / 12;
  const months = 360;
  
  const maxLoan = maxDebtService * (
    Math.pow(1 + monthlyRate, months) - 1
  ) / (
    monthlyRate * Math.pow(1 + monthlyRate, months)
  );
  
  // Maximum purchase price
  const maxPrice = maxLoan / (1 - downPaymentPercent);
  
  return maxPrice;
}
