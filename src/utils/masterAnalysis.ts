/**
 * Master Property Analysis Function
 * Orchestrates all analysis components and returns comprehensive investment analysis
 */

import {
  AttomProperty,
  SalesComparable,
  ComprehensivePropertyAnalysis,
  PropertySummary,
  ValuationImpactAnalysis,
  RentalOutcome,
  RenovationScenarioAnalysis,
  TransformationAnalysis,
  InvestmentStrategy,
  ActionStep,
  DataSourcesSummary,
  ConfidenceBreakdown,
  RenovationROI,
  RegionalMarketAnalysis
} from '../types/propertyAnalysis';
import type { CanonicalPropertyProfile, CanonicalVisualEvidence } from '../types/renovationPipeline';

import { calculateDetailedConditionScore } from './conditionScoring';
import { analyzePropertyValuation } from './valuationEngine';
import { analyzeRentalViability, generateFinancingScenarios, calculateBreakEvenPrice } from './rentalViabilityCalculator';
import { analyzeRenovationImpact } from './renovationAnalyzer';
import { detectWedgeOpportunities } from './wedgeDetector';
import { analyzeRegionalMarket, createFallbackRegionalAnalysis } from './regionalMarketAnalyzer';
import { fetchRegionalData, fetchCountyDataByCoords, transformFREDData } from '../services/regionalDataService';

interface ComprehensiveAnalysisContext {
  canonicalPropertyProfile?: CanonicalPropertyProfile;
  canonicalVisualEvidence?: CanonicalVisualEvidence;
}

// ============================================================================
// MAIN ORCHESTRATION FUNCTION
// ============================================================================

export async function analyzePropertyComprehensive(
  property: AttomProperty,
  visualAIData: any, // Raw Visual AI data from photos
  listPrice?: number,
  salesComps?: SalesComparable[],
  downPaymentPercent: number = 20,
  context: ComprehensiveAnalysisContext = {}
): Promise<ComprehensivePropertyAnalysis> {
  
  console.log('Starting comprehensive property analysis...');
  
  // PHASE 1: Condition Analysis
  console.log('Phase 1: Analyzing condition...');
  const conditionScore = calculateDetailedConditionScore(visualAIData, property);
  
  // PHASE 1.5: Regional Market Analysis (needed for valuation)
  console.log('Phase 1.5: Fetching regional market conditions...');
  let regionalMarket: RegionalMarketAnalysis | undefined;
  
  try {
    // Fetch metro-level data by address (for housing prices, wages, etc.)
    const fredData = await fetchRegionalData(property.address);
    
    // Also fetch county-level data dynamically if we have coordinates
    // This gives us precise supply indicators for the exact county
    let countyData = null;
    if (property.latitude && property.longitude) {
      console.log('[Master Analysis] Fetching dynamic county data for:', property.latitude, property.longitude);
      countyData = await fetchCountyDataByCoords(property.latitude, property.longitude);
      if (countyData?.data) {
        console.log(`[Master Analysis] County data: ${countyData.data.countyName}, ${countyData.data.stateCode}`);
      }
    }
    
    if (fredData && fredData.data) {
      console.log('[Master Analysis] FRED data received for regional analysis');
      const transformedData = transformFREDData(fredData.data);
      
      // Merge county-level supply data if available (more precise than metro)
      if (countyData?.data?.supply) {
        console.log('[Master Analysis] Enhancing with county-level supply data');
        transformedData.supplyIndicators = {
          ...transformedData.supplyIndicators,
          // Use county data for listings (more precise)
          newListings: countyData.data.supply.newListings.available 
            ? { value: countyData.data.supply.newListings.value, yoy: countyData.data.supply.newListings.yoy }
            : transformedData.supplyIndicators?.newListings,
          activeListings: countyData.data.supply.activeListings.available
            ? { value: countyData.data.supply.activeListings.value, yoy: countyData.data.supply.activeListings.yoy }
            : transformedData.supplyIndicators?.activeListings,
          newListingsYoY: parseFloat(countyData.data.supply.newListings.yoy || '0') || transformedData.supplyIndicators?.newListingsYoY,
          activeListingsYoY: parseFloat(countyData.data.supply.activeListings.yoy || '0') || transformedData.supplyIndicators?.activeListingsYoY,
          countyFips: countyData.data.countyFips,
          countyName: countyData.data.countyName,
        };
        
        // Recalculate supply pipeline risk with county data
        const permitsYoY = parseFloat(countyData.data.supply.buildingPermits.yoy || '0') || transformedData.supplyIndicators?.permitsYoY || 0;
        const newListingsYoY = parseFloat(countyData.data.supply.newListings.yoy || '0');
        const activeListingsYoY = parseFloat(countyData.data.supply.activeListings.yoy || '0');
        const supplyGrowthAvg = (permitsYoY + newListingsYoY + activeListingsYoY) / 3;
        
        if (supplyGrowthAvg > 20) transformedData.supplyIndicators.supplyPipelineRisk = 'very_high';
        else if (supplyGrowthAvg > 10) transformedData.supplyIndicators.supplyPipelineRisk = 'high';
        else if (supplyGrowthAvg > -5) transformedData.supplyIndicators.supplyPipelineRisk = 'moderate';
        else if (supplyGrowthAvg > -15) transformedData.supplyIndicators.supplyPipelineRisk = 'low';
        else transformedData.supplyIndicators.supplyPipelineRisk = 'very_low';
      }
      
      regionalMarket = analyzeRegionalMarket(property, transformedData);
      console.log(`[Master Analysis] Market Heat: ${regionalMarket.marketHeat} (Score: ${regionalMarket.marketHeatScore}/100)`);
    } else {
      console.log('[Master Analysis] No FRED data available, using fallback analysis');
      regionalMarket = createFallbackRegionalAnalysis(property);
    }
  } catch (error) {
    console.error('[Master Analysis] Regional market analysis error:', error);
    regionalMarket = createFallbackRegionalAnalysis(property);
  }
  
  // PHASE 2: Valuation Analysis (now includes regional market data)
  console.log('Phase 2: Analyzing valuation...');
  const valuation = analyzePropertyValuation(
    property,
    conditionScore,
    listPrice,
    salesComps,
    regionalMarket
  );
  
  const purchasePrice = listPrice || valuation.indicatedValue;
  
  // PHASE 3: As-Is Rental Analysis
  console.log('Phase 3: Analyzing as-is rental viability...');
  
  // Transform mortgage data for financing scenarios
  const assumableLoanData = property.mortgage?.assumability ? {
    ...property.mortgage.assumability,
    loan_type: property.mortgage.loan_type,
    amount: property.mortgage.amount,
    date: property.mortgage.date
  } : undefined;
  
  console.log('[Master Analysis] Passing assumable loan data:', assumableLoanData);
  
  const asIsFinancing = generateFinancingScenarios(purchasePrice, assumableLoanData, downPaymentPercent);
  const asIsRental = analyzeRentalViability(
    property,
    conditionScore,
    purchasePrice,
    asIsFinancing,
    regionalMarket // Pass regional market data for vacancy and rent adjustments
  );
  
  // PHASE 4: Valuation Impact on Rental
  console.log('Phase 4: Analyzing valuation impact on rental...');
  const valuationImpact = analyzeValuationImpactOnRental(
    property,
    conditionScore,
    valuation.indicatedValue,
    listPrice,
    asIsRental,
    regionalMarket
  );
  
  // PHASE 5: Post-Renovation Analysis
  console.log('Phase 5: Analyzing renovation potential...');
  let postRenovation: RenovationScenarioAnalysis | undefined;
  let transformation: TransformationAnalysis | undefined;
  
  if (conditionScore.renovationPotential > 0.15) { // At least 15% room for improvement
    // Pass current cash flow for rental impact analysis
    const currentMonthlyCashFlow = asIsRental.cashFlow?.monthlyCashFlow || 0;
    
    const renovationAnalysis = await analyzeRenovationImpact(
      property,
      conditionScore,
      valuation.indicatedValue,
      asIsRental.income.finalMonthlyRent,
      purchasePrice,
      currentMonthlyCashFlow // NEW: Pass current cash flow for ROI analysis
    );
    
    // Log the rental portfolio analysis
    if ((renovationAnalysis as any).rentalPortfolioAnalysis) {
      const portfolio = (renovationAnalysis as any).rentalPortfolioAnalysis;
      console.log(`[Master Analysis] Renovation Portfolio: ${portfolio.positiveROIItems.length} high ROI, ${portfolio.marginalItems.length} marginal, ${portfolio.notRecommendedItems.length} not recommended`);
      console.log(`[Master Analysis] Cash Flow Impact: $${portfolio.cashFlowImpact.before}/mo → $${portfolio.cashFlowImpact.after}/mo (+$${portfolio.cashFlowImpact.improvement}/mo)`);
      if (portfolio.wedgePotential.createsWedge) {
        console.log(`[Master Analysis] Wedge Detected: ${portfolio.wedgePotential.wedgeType} - ${portfolio.wedgePotential.reason}`);
      }
    }
    
    // Analyze post-renovation rental viability
    const postRenoFinancing = generateFinancingScenarios(purchasePrice, assumableLoanData, downPaymentPercent);
    const postRenoCondition = {
      ...conditionScore,
      overallGrade: renovationAnalysis.renovationPlan.targetGrade,
      overallScore: Math.min(95, conditionScore.overallScore + 15)
    };
    
    const postRenoRental = analyzeRentalViability(
      property,
      postRenoCondition,
      purchasePrice,
      postRenoFinancing,
      regionalMarket // Pass regional market data for post-reno analysis too
    );
    
    // Calculate renovation ROI
    const renovationROI: RenovationROI = {
      renovationCost: renovationAnalysis.renovationPlan.totalCost,
      annualCashFlowGain: (postRenoRental.cashFlow.annualCashFlow - asIsRental.cashFlow.annualCashFlow),
      percentROI: ((renovationAnalysis.valuationImpact.forcedAppreciation / renovationAnalysis.renovationPlan.totalCost) * 100),
      paybackMonths: Math.ceil((renovationAnalysis.renovationPlan.totalCost / (postRenoRental.cashFlow.monthlyCashFlow - asIsRental.cashFlow.monthlyCashFlow))),
      forcedAppreciation: renovationAnalysis.valuationImpact.forcedAppreciation
    };
    
    postRenovation = {
      renovationPlan: renovationAnalysis.renovationPlan,
      condition: postRenoCondition,
      income: postRenoRental.income,
      expenses: postRenoRental.expenses,
      cashFlow: postRenoRental.cashFlow,
      metrics: postRenoRental.metrics,
      viability: postRenoRental.viability,
      brrrr: renovationAnalysis.brrrr,
      roi: renovationROI,
      recommendation: postRenoRental.recommendation
    };
    
    // Transformation analysis
    transformation = {
      rentIncrease: renovationAnalysis.rentalImpact.monthlyIncrease,
      rentIncreasePercent: (renovationAnalysis.rentalImpact.monthlyIncrease / asIsRental.income.finalMonthlyRent) * 100,
      opExReduction: 0, // Renovations don't typically reduce OpEx
      cashFlowImprovement: postRenoRental.cashFlow.monthlyCashFlow - asIsRental.cashFlow.monthlyCashFlow,
      viabilityChange: `${asIsRental.viability} → ${postRenoRental.viability}`,
      worthIt: renovationROI.percentROI > 60 && renovationROI.paybackMonths < 60,
      paybackMonths: renovationROI.paybackMonths
    };
  }
  
  // PHASE 6: Wedge Detection
  console.log('Phase 6: Detecting investment wedges...');
  const wedgeOpportunities = detectWedgeOpportunities(
    property,
    valuation,
    conditionScore,
    postRenovation ? {
      renovationPlan: postRenovation.renovationPlan,
      valuationImpact: {
        purchasePrice,
        renovationCost: postRenovation.renovationPlan.totalCost,
        afterRepairValue: valuation.indicatedValue + (postRenovation?.roi?.forcedAppreciation || 0),
        forcedAppreciation: postRenovation?.roi?.forcedAppreciation || 0,
        totalEquityCreated: (postRenovation?.roi?.forcedAppreciation || 0) - postRenovation.renovationPlan.totalCost
      },
      rentalImpact: {
        currentRent: asIsRental.income.finalMonthlyRent,
        postRenoRent: postRenovation.income.finalMonthlyRent,
        monthlyIncrease: postRenovation.income.finalMonthlyRent - asIsRental.income.finalMonthlyRent,
        annualIncrease: (postRenovation.income.finalMonthlyRent - asIsRental.income.finalMonthlyRent) * 12
      },
      brrrr: postRenovation.brrrr,
      confidence: 0.80,
      dataSources: {
        costs: 'Google Search + OpenAI + BLS',
        rents: 'ATTOM Rental AVM + Condition Adjustment',
        financing: 'Conventional 75% LTV Refinance'
      }
    } : undefined,
    postRenovation?.brrrr,
    listPrice
  );
  
  // PHASE 7: Determine Best Strategy
  console.log('Phase 7: Determining best investment strategy...');
  const bestStrategy = determineBestStrategy(
    asIsRental,
    postRenovation,
    wedgeOpportunities,
    valuation
  );
  
  // PHASE 8: Generate Action Plan
  const actionPlan = generateActionPlan(bestStrategy, wedgeOpportunities, valuation);
  
  // PHASE 9: Calculate Confidence Scores
  const confidenceScore = calculateOverallConfidence(
    valuation,
    conditionScore,
    asIsRental,
    postRenovation
  );
  
  const confidenceBreakdown: ConfidenceBreakdown = {
    overall: confidenceScore,
    valuation: valuation.confidence === 'high' ? 0.90 : valuation.confidence === 'medium' ? 0.75 : 0.60,
    condition: conditionScore.overallScore > 0 ? 0.85 : 0.50,
    renovationCosts: postRenovation ? (postRenovation.roi.percentROI > 0 ? 0.80 : 0.60) : 0.70,
    rentalViability: asIsRental.income.confidenceLevel === 'high' ? 0.85 : asIsRental.income.confidenceLevel === 'medium' ? 0.70 : 0.55,
    wedgeDetection: wedgeOpportunities.length > 0 ? 0.75 : 0.60
  };
  
  // Create property summary
  const propertySummary: PropertySummary = {
    address: property.address,
    listPrice,
    purchasePrice,
    currentValue: valuation.indicatedValue,
    condition: conditionScore.overallGrade,
    conditionScore: conditionScore.overallScore,
    beds: property.beds,
    baths: property.baths,
    sqft: property.living_sqft,
    yearBuilt: property.year_built,
    lotAcres: property.lot_acres
  };
  
  // Data sources summary
  const dataSources: DataSourcesSummary = {
    valuation: 'ATTOM AVM, Sales Comparables, Income Approach, Cost Approach',
    condition: 'Visual AI Photo Analysis',
    renovationCosts: 'Google Search + OpenAI GPT-4o + BLS Regional Labor Data',
    rentalRates: 'ATTOM Rental AVM + Condition Adjustment',
    financing: 'Conventional + FHA + Assumable Hybrid',
    expenses: 'ATTOM Tax Data + Industry Standards'
  };
  
  console.log('Analysis complete!');
  
  return {
    property: propertySummary,
    valuation,
    asIs: asIsRental,
    valuationImpactOnRental: valuationImpact,
    postRenovation,
    transformation,
    regionalMarket,
    wedgeOpportunities,
    bestStrategy,
    confidenceScore,
    actionPlan,
    dataSources,
    confidenceBreakdown,
    canonicalContext: {
      propertyProfile: context.canonicalPropertyProfile,
      visualEvidence: context.canonicalVisualEvidence,
    }
  };
}

// ============================================================================
// VALUATION IMPACT ON RENTAL
// ============================================================================

function analyzeValuationImpactOnRental(
  property: AttomProperty,
  conditionScore: any,
  fairValue: number,
  listPrice: number | undefined,
  asIsRental: any,
  regionalMarket?: RegionalMarketAnalysis
): ValuationImpactAnalysis {
  
  // Transform mortgage data for financing scenarios
  const assumableLoanData = property.mortgage?.assumability ? {
    ...property.mortgage.assumability,
    loan_type: property.mortgage.loan_type,
    amount: property.mortgage.amount,
    date: property.mortgage.date
  } : undefined;
  
  const createOutcome = (price: number): RentalOutcome => {
    const financing = generateFinancingScenarios(price, assumableLoanData)[0];
    const rental = analyzeRentalViability(property, conditionScore, price, [financing], regionalMarket);
    
    return {
      purchasePrice: price,
      monthlyRent: rental.income.finalMonthlyRent,
      monthlyExpenses: rental.expenses.total,
      monthlyDebtService: financing.totalMonthlyDebtService,
      monthlyCashFlow: rental.cashFlow.monthlyCashFlow,
      cashOnCash: rental.metrics.cashOnCash,
      capRate: rental.metrics.capRate,
      viable: rental.viability === 'excellent' || rental.viability === 'good'
    };
  };
  
  const breakEvenPrice = calculateBreakEvenPrice(
    asIsRental.income,
    asIsRental.expenses,
    0, // Break-even (zero cash flow)
    0.20,
    7.0
  );
  
  const recommendedMaxOffer = Math.min(fairValue, breakEvenPrice * 1.10); // 10% buffer
  
  return {
    ifPurchaseAtListPrice: listPrice ? createOutcome(listPrice) : createOutcome(fairValue),
    ifPurchaseAtFairValue: createOutcome(fairValue),
    ifPurchaseAtNegotiatedPrice: createOutcome(fairValue * 0.90),
    breakEvenPurchasePrice: breakEvenPrice,
    recommendedMaxOffer
  };
}

// ============================================================================
// BEST STRATEGY DETERMINATION
// ============================================================================

function determineBestStrategy(
  asIsRental: any,
  postRenovation: RenovationScenarioAnalysis | undefined,
  wedges: any[],
  _valuation: any
): InvestmentStrategy {
  
  // Check BRRRR viability first
  if (postRenovation?.brrrr?.viable && postRenovation.brrrr.infiniteReturn) {
    return 'value_add_brrrr';
  }
  
  // Check for strong flip opportunity
  const flipWedge = wedges.find(w => w.type === 'flip');
  if (flipWedge && flipWedge.confidence > 0.75 && flipWedge.details.roi > 0.50) {
    return 'flip';
  }
  
  // Check as-is rental viability
  if (asIsRental.viability === 'excellent' || asIsRental.viability === 'good') {
    return 'as_is_rental';
  }
  
  // Check value-add BRRRR
  if (postRenovation?.brrrr?.viable) {
    return 'value_add_brrrr';
  }
  
  // Check if any strong wedge exists
  const strongWedge = wedges.find(w => w.confidence > 0.80 && w.potentialProfit > 30000);
  if (strongWedge) {
    if (strongWedge.type === 'brrrr') return 'value_add_brrrr';
    if (strongWedge.type === 'flip' || strongWedge.type === 'value_add') return 'flip';
  }
  
  // Default: avoid
  return 'avoid';
}

// ============================================================================
// ACTION PLAN GENERATION
// ============================================================================

function generateActionPlan(
  strategy: InvestmentStrategy,
  wedges: any[],
  valuation: any
): ActionStep[] {
  
  const steps: ActionStep[] = [];
  
  switch (strategy) {
    case 'as_is_rental':
      steps.push(
        { step: 1, action: 'Make Offer', detail: `Offer at or below $${valuation.indicatedValue.toFixed(0)} (fair value)`, timeline: 'Immediate' },
        { step: 2, action: 'Due Diligence', detail: 'Professional inspection, verify rents, review financials', timeline: '10-14 days' },
        { step: 3, action: 'Close Purchase', detail: 'Conventional financing, 20% down', timeline: '30-45 days' },
        { step: 4, action: 'Tenant Placement', detail: 'Market property, screen tenants, execute lease', timeline: '30-60 days' },
        { step: 5, action: 'Hold Long-Term', detail: 'Collect rent, maintain property, build equity', timeline: 'Ongoing' }
      );
      break;
      
    case 'value_add_brrrr':
      steps.push(
        { step: 1, action: 'Make Offer', detail: 'Negotiate purchase price accounting for renovation costs', timeline: 'Immediate' },
        { step: 2, action: 'Close Purchase', detail: 'Conventional or hard money financing', timeline: '30-45 days' },
        { step: 3, action: 'Execute Renovations', detail: 'Complete renovation scope per plan', timeline: '2-4 months' },
        { step: 4, action: 'Tenant Placement', detail: 'Market at higher rent, place quality tenant', timeline: '1-2 months' },
        { step: 5, action: 'Cash-Out Refinance', detail: 'Refinance at 75% LTV, recover capital', timeline: '6-12 months seasoning' },
        { step: 6, action: 'Hold Long-Term', detail: 'Collect rent, maintain property, infinite return', timeline: 'Ongoing' }
      );
      break;
      
    case 'flip':
      steps.push(
        { step: 1, action: 'Make Offer', detail: 'Offer based on ARV minus renovations minus profit', timeline: 'Immediate' },
        { step: 2, action: 'Close Purchase', detail: 'Hard money or cash', timeline: '14-30 days' },
        { step: 3, action: 'Execute Renovations', detail: 'Complete renovation scope quickly', timeline: '2-3 months' },
        { step: 4, action: 'List for Sale', detail: 'Professional photos, aggressive marketing', timeline: 'Immediately after reno' },
        { step: 5, action: 'Close Sale', detail: 'Accept best offer, close transaction', timeline: '30-60 days' }
      );
      break;
      
    case 'avoid':
      const bestWedge = wedges.length > 0 ? wedges[0] : null;
      if (bestWedge) {
        steps.push(
          { step: 1, action: 'Alternative Strategy', detail: `Consider ${bestWedge.type} wedge: ${bestWedge.strategy}`, timeline: 'Evaluate' },
          { step: 2, action: 'Reassess Numbers', detail: 'Negotiate better price or terms to improve viability', timeline: 'Ongoing' }
        );
      } else {
        steps.push(
          { step: 1, action: 'Pass on Deal', detail: 'Property does not meet investment criteria', timeline: 'Immediate' },
          { step: 2, action: 'Continue Search', detail: 'Find better opportunities with stronger fundamentals', timeline: 'Ongoing' }
        );
      }
      break;
  }
  
  return steps;
}

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

function calculateOverallConfidence(
  valuation: any,
  conditionScore: any,
  asIsRental: any,
  postRenovation?: RenovationScenarioAnalysis
): number {
  
  const valuationConf = valuation.confidence === 'high' ? 0.90 : valuation.confidence === 'medium' ? 0.75 : 0.60;
  const conditionConf = conditionScore.overallScore > 0 ? 0.85 : 0.50;
  const rentalConf = asIsRental.income.confidenceLevel === 'high' ? 0.85 : asIsRental.income.confidenceLevel === 'medium' ? 0.70 : 0.55;
  const renovationConf = postRenovation ? 0.75 : 0.80; // Slightly lower confidence with renovations
  
  // Weighted average
  const overall = (
    valuationConf * 0.30 +
    conditionConf * 0.25 +
    rentalConf * 0.25 +
    renovationConf * 0.20
  );
  
  return Math.round(overall * 100) / 100;
}
