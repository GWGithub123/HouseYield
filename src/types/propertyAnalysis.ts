/**
 * Property Investment Analysis System
 * Type Definitions
 */

import type { CanonicalPropertyProfile, CanonicalVisualEvidence } from './renovationPipeline';

// ============================================================================
// CORE PROPERTY TYPES
// ============================================================================

export interface AttomProperty {
  // Flattened from dashboard.summary
  address: string;
  year_built: number;
  property_type: string;
  lot_acres: number;
  attom_id: number;
  latitude: string;
  longitude: string;
  area_context?: {
    county: string;
    municipality: string;
    municipality_code: string;
    census_tract: string;
    census_block_group: string;
    tax_code_area: string;
    zoning: string;
  };
  baths: number;
  beds?: number;
  living_sqft: number;
  avm_value: number;
  avm_low: number;
  avm_high: number;
  rental_avm: number;
  rental_avm_low: number;
  rental_avm_high: number;
  mortgage?: AttomMortgage;
  owner: {
    is_corporate: boolean;
    owner1_name: string;
    owner3_name?: string;
    relationship_type?: string;
    absentee_status: string;
    mailing_address: string;
  };
  price_per_sqft: number;
  age: number;
  tax_history: TaxHistoryItem[];
  tax_meta: {
    count: number;
    cagr_full: number;
    cagr_5yr: number;
  };
  avm_history: AVMHistoryItem[];
  building_permits?: BuildingPermit[];
  schools?: School[];
  zip?: string;
  hoa_fee?: number;
  landlord_pays_utilities?: boolean;
  hazard_scores?: {
    flood: number;
    fire: number;
    earthquake?: number;
  };
}

export interface AttomMortgage {
  lender_name: string;
  lender_code: string;
  amount: number;
  date: string;
  loan_type: string; // FHA, VA, CNV, USDA
  deed_type: string;
  term_months: number;
  due_date: string;
  title_company?: string;
  estimated_interest_rate: number;
  estimated_monthly_payment_pi: number;
  estimated_total_interest: number;
  estimated_total_paid: number;
  assumability?: {
    assumable: string;
    confidence: string;
    reason: string;
    loanType: string;
    loanDate: string;
    estimatedRate: number;
    attractiveness: string;
    remainingBalance?: number;
    originalAmount?: number;
    monthsRemaining?: number;
    monthsElapsed?: number;
    principalPaid?: number;
    percentPaid?: number;
    nextSteps: string[];
    disclaimer: string;
  };
  payment_breakdown?: {
    principal_and_interest: number;
    property_tax: number;
    total_pi_plus_tax: number;
  };
}

export interface TaxHistoryItem {
  year: number;
  tax_amount: number;
  tax_amount_yoy_pct?: number;
}

export interface AVMHistoryItem {
  date: string;
  value: number;
  low: number;
  high: number;
}

export interface BuildingPermit {
  source: string;
  permit_number: string;
  status: string;
}

export interface School {
  name: string;
  level: string;
  grades: string;
  rating: string;
  distance: number;
  type: string;
  latitude: string;
  longitude: string;
  geoId: string;
}

// ============================================================================
// VISUAL AI CONDITION SCORING
// ============================================================================

export interface DetailedConditionScore {
  overallGrade: string; // A+, A, A-, B+, B, B-, C+, C, C-, D
  overallScore: number; // 0-100 composite score
  
  exterior: ExteriorScore;
  interior: InteriorScore;
  systems: SystemsScore;
  qualitativeFactors: QualitativeFactors;
  
  deferredMaintenance: DeferredMaintenanceItem[];
  totalDeferredCost: number;
  renovationPotential: number; // 0-1 scale
  
  // AI-identified renovation opportunities
  aiRenovationOpportunities?: AIRenovationOpportunity[];
}

export interface AIRenovationOpportunity {
  area: string;
  description: string;
  estimated_cost_range: string;
  value_add_potential: 'high' | 'medium' | 'low';
  rent_increase_potential: string;
  priority: 'immediate' | 'short-term' | 'long-term';
  roi_estimate: string;
}

export interface ExteriorScore {
  roof: ComponentScore;
  siding: ComponentScore;
  windows: ComponentScore;
  doors: ComponentScore;
  foundation: ComponentScore;
  driveway: ComponentScore;
  landscaping: ComponentScore;
  overallScore: number;
}

export interface InteriorScore {
  kitchen: RoomScore;
  bathrooms: {
    master: RoomScore;
    secondary: RoomScore[];
    avgScore: number;
  };
  livingRoom: RoomScore;
  bedrooms: {
    master: RoomScore;
    secondary: RoomScore[];
    avgScore: number;
  };
  flooring: ComponentScore;
  paint: ComponentScore;
  lighting: ComponentScore;
  overallScore: number;
}

export interface SystemsScore {
  hvac: SystemScore;
  electrical: SystemScore;
  plumbing: SystemScore;
  waterHeater: SystemScore;
  overallScore: number;
}

export interface ComponentScore {
  score: number; // 0-100
  condition: 'excellent' | 'good' | 'average' | 'fair' | 'poor';
  age?: number;
  remainingLife?: number;
  replacementCost: number;
  urgency: 'immediate' | 'soon' | 'monitor' | 'none';
  notes: string;
}

export interface RoomScore {
  score: number; // 0-100
  components: {
    [key: string]: number;
  };
  materialQuality: 'luxury' | 'high' | 'mid' | 'builder' | 'low';
  modernization: number; // 0-100
  functionality: number; // 0-100
  renovationNeeded: boolean;
  estimatedRenovationCost: number;
}

export interface SystemScore {
  score: number; // 0-100
  type: string;
  age?: number;
  expectedLife: number;
  efficiency: number; // 0-100
  lastService?: Date;
  replacementCost: number;
  operatingProperly: boolean;
}

export interface QualitativeFactors {
  layoutFlow: number; // 0-100
  naturalLight: number;
  ceilingHeight: number;
  storageSpace: number;
  modernization: number;
  curbAppeal: number;
  avgScore: number;
}

export interface DeferredMaintenanceItem {
  category: string;
  item: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  cost: number;
  urgency: 'immediate' | '1-6 months' | '6-12 months' | '1-2 years';
  impactOnValue: number;
  impactOnRent: number;
}

// ============================================================================
// VALUATION ANALYSIS
// ============================================================================

export interface ValuationAnalysis {
  listPrice: number;
  indicatedValue: number;
  methods: ValuationMethods;
  comparableAnalysis: ComparableAnalysis;
  visualAIAdjustment: ConditionAdjustment;
  regionalMarketAdjustment?: RegionalMarketAdjustment;
  environmentalAdjustment?: EnvironmentalAdjustment;
  status: 'undervalued' | 'fair_valued' | 'overvalued';
  valuationGap: number;
  valuationGapPercent: number;
  confidence: 'high' | 'medium' | 'low';
  recommendation: string;
}

export interface RegionalMarketAdjustment {
  marketHeat: MarketHeatLevel;
  heatScore: number;
  multiplier: number;
  valueImpact: number;
}

export interface EnvironmentalAdjustment {
  multiplier: number;
  schoolBonus: number;
  floodPenalty: number;
  firePenalty: number;
  breakdown: string;
  valueImpact: number;
}

export interface ValuationMethods {
  attomAVM: MethodResult;
  salesComparison: MethodResult;
  weightedAverage: number;
  marketAdjustedAverage?: number;
  environmentAdjustedAverage?: number;
}

export interface MethodResult {
  value: number;
  weight: number;
  confidence: number;
  details: any;
}

export interface ComparableAnalysis {
  salesComps: SalesComparable[];
  adjustedValues: number[];
  weightedAverage: number;
  pricePerSqftRange: {
    low: number;
    median: number;
    high: number;
  };
  confidence: 'high' | 'medium' | 'low';
}

export interface SalesComparable {
  address: string;
  sale_price: number;
  sale_date: Date | string;
  living_sqft: number;
  beds: number;
  baths: number;
  year_built: number;
  lot_acres: number;
  condition_score?: number;
  distance_miles?: number;
  adjustedPrice?: number;
  similarity?: number;
  recency?: number;
  weight?: number;
}

export interface ConditionAdjustment {
  baseValue: number;
  conditionMultiplier: number;
  adjustedValue: number;
  deferredMaintenance: number;
  finalAdjustedValue: number;
  roomByRoomImpact: {
    kitchen: { score: number; impact: number };
    bathrooms: { score: number; impact: number };
    overall: { score: number; impact: number };
  };
}

// ============================================================================
// RENOVATION ANALYSIS
// ============================================================================

export interface RenovationAnalysis {
  renovationPlan: RenovationPlan;
  valuationImpact: ValuationImpact;
  rentalImpact: RentalImpact;
  brrrr: BRRRRAnalysis;
  confidence: number;
  dataSources: {
    costs: string;
    rents: string;
    financing: string;
  };
}

export interface RenovationPlan {
  scope: RenovationItem[];
  totalCost: number;
  timeline: number; // months
  targetGrade: string;
  expectedRentIncrease: number;
}

export interface RenovationItem {
  category: string;
  item: string;
  cost: number;
  costRange?: {
    low: number;
    high: number;
  };
  impact: 'high' | 'medium' | 'low';
  rentImpact: number;
  valueImpact: number;
  dataSource?: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface RenovationCostEstimate {
  renovationType: string;
  baseCost: number;
  laborCost: number;
  materialCost: number;
  totalCost: number;
  costRange: {
    low: number;
    high: number;
  };
  breakdown: {
    labor: number;
    materials: number;
    permits: number;
    contingency: number;
  };
  regionalFactors: string[];
  dataSource: string;
  confidence: 'high' | 'medium' | 'low';
  lastUpdated: Date;
}

export interface ValuationImpact {
  purchasePrice: number;
  renovationCost: number;
  afterRepairValue: number;
  forcedAppreciation: number;
  totalEquityCreated: number;
}

export interface RentalImpact {
  currentRent: number;
  postRenoRent: number;
  monthlyIncrease: number;
  annualIncrease: number;
}

export interface BRRRRAnalysis {
  strategy: 'BRRRR' | 'Traditional Hold';
  
  // Investment
  purchasePrice: number;
  renovationCost: number;
  totalInvestment: number;
  initialCashRequired: number;
  
  // After Repair
  afterRepairValue: number;
  forcedAppreciation: number;
  
  // Refinance
  refinanceAmount: number;
  refinanceRate: number;
  newMonthlyDebtService: number;
  
  // Cash Recovery
  originalLoan: number;
  cashRecovered: number;
  cashLeftInDeal: number;
  capitalRecoveryPercent: number;
  
  // Post-Refinance Performance
  postRefinanceCashFlow: number;
  infiniteReturn: boolean;
  finalCashOnCash: number;
  
  // Recommendation
  viable: boolean;
  recommendation: string;
}

// ============================================================================
// FINANCING
// ============================================================================

export interface FinancingScenario {
  name: string;
  purchasePrice: number;
  downPaymentAmount: number;
  downPaymentPercent: number;
  
  assumedLoan?: {
    balance: number;
    rate: number;
    monthlyPayment: number;
    remainingMonths: number;
    assumptionFee: number;
    loanType?: string;
  };
  
  newLoan?: {
    amount: number;
    rate: number;
    term: number;
    monthlyPayment: number;
  };
  
  totalLoanAmount: number;
  totalMonthlyDebtService: number;
  effectiveInterestRate: number;
  totalCashRequired: number;
  closingCosts: number;
  monthlySavingsVsConventional: number;
  assumabilityDetails?: any;
}

// ============================================================================
// RENTAL VIABILITY
// ============================================================================

export interface RentalAnalysis {
  asIs: RentalScenario;
  postRenovation?: RentalScenario;
  brrrr?: BRRRRAnalysis;
  breakEvenPurchasePrice: number;
  requiredDiscount: number;
}

export interface TenantQualityAnalysis {
  // Overall tenant quality score (0-100)
  overallScore: number;
  qualityTier: 'excellent' | 'good' | 'average' | 'below_average' | 'high_risk';
  
  // Economic factors
  medianIncomeScore: number; // 0-100 based on area median income
  unemploymentScore: number; // 0-100 (lower unemployment = higher score)
  jobGrowthScore: number; // 0-100 based on local job growth
  incomeStabilityScore: number; // 0-100 based on income growth trends
  
  // Payment reliability estimates
  onTimePaymentProbability: number; // 0-100%
  missedPaymentRisk: number; // 0-100% (lower is better)
  evictionRiskLevel: 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
  
  // Rent-to-income analysis
  areaRentToIncomeRatio: number; // Expected % of income going to rent
  affordabilityScore: number; // 0-100 (higher = more affordable for tenants)
  
  // Risk adjustments for financial calculations
  badDebtReserveRecommended: number; // Monthly $ to reserve for bad debt
  effectiveVacancyAdjustment: number; // Additional vacancy % to account for turnover
  
  // Summary
  strengths: string[];
  risks: string[];
  recommendation: string;
}

export interface RentalScenario {
  condition: DetailedConditionScore;
  income: IncomeAnalysis;
  expenses: OperatingExpenses;
  financingOptions: FinancingScenario[];
  cashFlow: CashFlowAnalysis;
  metrics: InvestmentMetrics;
  viability: ViabilityStatus;
  tenantQuality?: TenantQualityAnalysis;
  recommendation: string;
}

export interface IncomeAnalysis {
  attomRentalAVM: number;
  comparableRents?: any[];
  adjustedMarketRent: number;
  conditionAdjustment: number;
  finalMonthlyRent: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  rentRange: { low: number; high: number };
}

export interface OperatingExpenses {
  propertyTax: number;
  insurance: number;
  hoa: number;
  maintenance: number;
  maintenanceRate: number;
  capex: number;
  capexRate: number;
  vacancy: number;
  vacancyRate: number;
  propertyManagement: number;
  managementRate: number;
  utilities: number;
  totalFixed: number;
  totalVariable: number;
  total: number;
  expenseRatio: number;
}

export interface CashFlowAnalysis {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyDebtService: number;
  monthlyCashFlow: number;
  annualCashFlow: number;
  grossOperatingIncome: number;
  netOperatingIncome: number;
}

export interface InvestmentMetrics {
  capRate: number;
  cashOnCash: number;
  dscr: number;
  grm: number;
  breakEvenOccupancy: number;
  cashFlowBreakEvenRent: number;
  positiveFlowRent: number;
  roi5Year: number;
}

export type ViabilityStatus = 'excellent' | 'good' | 'marginal' | 'breakeven' | 'negative' | 'avoid';

// ============================================================================
// WEDGE OPPORTUNITIES
// ============================================================================

export enum WedgeType {
  VALUATION_GAP = 'valuation_gap',
  DISTRESSED_SELLER = 'distressed_seller',
  VALUE_ADD = 'value_add',
  VALUE_ADD_RENTAL = 'value_add_rental',
  OFF_MARKET = 'off_market',
  ASSUMABLE_LOAN = 'assumable_loan',
  HOUSE_HACK = 'house_hack',
  TAX_APPEAL = 'tax_appeal',
  BRRRR = 'brrrr',
  FLIP = 'flip'
}

export interface WedgeOpportunity {
  type: WedgeType;
  confidence: number;
  potentialProfit: number;
  timeframe: string;
  capitalRequired: number;
  risk: 'low' | 'medium' | 'high';
  strategy: string;
  barriers: string[];
  details?: any;
  signals?: string[];
}

// ============================================================================
// REGIONAL MARKET ANALYSIS
// ============================================================================

export type MarketHeatLevel = 'very_hot' | 'hot' | 'warm' | 'neutral' | 'cool' | 'cold' | 'very_cold';

export interface EconomicIndicator {
  value: number;
  trend: 'improving' | 'stable' | 'declining';
  percentChange?: number;
  date?: string;
  nationalComparison?: 'above_average' | 'average' | 'below_average';
  score: number; // 0-100 normalized score
}

export interface RegionalEconomicData {
  unemployment: EconomicIndicator;
  jobGrowth: EconomicIndicator;
  medianIncome: EconomicIndicator;
  incomeGrowth: EconomicIndicator;
  populationGrowth: EconomicIndicator;
  vacancyRate: EconomicIndicator;
  rentGrowth: EconomicIndicator;
  homeValueGrowth: EconomicIndicator;
  daysOnMarket: EconomicIndicator;
  inventoryMonths: EconomicIndicator;
  // Housing supply indicators (leading indicators)
  housingStarts?: EconomicIndicator; // New housing units under construction
  buildingPermits?: EconomicIndicator; // Permits issued (12-18 month forward supply indicator)
}

export interface MarketDemandSignals {
  rentalDemand: 'very_high' | 'high' | 'moderate' | 'low' | 'very_low';
  purchaseDemand: 'very_high' | 'high' | 'moderate' | 'low' | 'very_low';
  investorActivity: 'very_high' | 'high' | 'moderate' | 'low' | 'very_low';
  supplyConstraint: 'severe' | 'moderate' | 'balanced' | 'oversupply';
  // Numeric indicators (0-100)
  rentalDemandIndicator?: number; // 0-100, 50 = neutral
  populationChange?: number; // Annual % change
  jobsGrowthRate?: number; // Annual % change
  medianIncomeGrowth?: number; // Annual % change
  // Supply pipeline indicators (leading indicators for future vacancy/rent)
  housingStartsYoY?: number; // Year-over-year % change in housing starts
  buildingPermitsYoY?: number; // Year-over-year % change in building permits
  supplyPipelineRisk?: 'very_high' | 'high' | 'moderate' | 'low' | 'very_low'; // Risk of future oversupply
}

export interface RegionalMarketAnalysis {
  metroArea: string;
  stateCode: string;
  marketHeat: MarketHeatLevel;
  marketHeatScore: number; // 0-100 (0 = very cold, 100 = very hot)
  economicData: RegionalEconomicData;
  demandSignals: MarketDemandSignals;
  rentalMarketStrength: number; // 0-100
  investmentViability: number; // 0-100
  vacancyRisk: 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
  marketTrend: 'accelerating' | 'growing' | 'stable' | 'slowing' | 'declining';
  summary: string;
  strengths: string[];
  weaknesses: string[];
  outlook: string;
  confidenceLevel: 'high' | 'medium' | 'low';
  dataSources: string[];
}

// ============================================================================
// COMPLETE ANALYSIS OUTPUT
// ============================================================================

export interface ComprehensivePropertyAnalysis {
  property: PropertySummary;
  valuation: ValuationAnalysis;
  asIs: RentalScenario;
  valuationImpactOnRental: ValuationImpactAnalysis;
  postRenovation?: RenovationScenarioAnalysis;
  transformation?: TransformationAnalysis;
  regionalMarket?: RegionalMarketAnalysis;
  wedgeOpportunities: WedgeOpportunity[];
  bestStrategy: InvestmentStrategy;
  confidenceScore: number;
  actionPlan: ActionStep[];
  dataSources: DataSourcesSummary;
  confidenceBreakdown: ConfidenceBreakdown;
  canonicalContext?: {
    propertyProfile?: CanonicalPropertyProfile;
    visualEvidence?: CanonicalVisualEvidence;
  };
}

export interface PropertySummary {
  address: string;
  listPrice?: number;
  purchasePrice?: number;
  currentValue: number;
  condition: string;
  conditionScore?: number;
  beds?: number;
  baths: number;
  sqft: number;
  yearBuilt: number;
  lotAcres: number;
}

export interface ValuationImpactAnalysis {
  ifPurchaseAtListPrice: RentalOutcome;
  ifPurchaseAtFairValue: RentalOutcome;
  ifPurchaseAtNegotiatedPrice: RentalOutcome;
  breakEvenPurchasePrice: number;
  recommendedMaxOffer: number;
}

export interface RentalOutcome {
  purchasePrice: number;
  monthlyRent: number;
  monthlyExpenses: number;
  monthlyDebtService: number;
  monthlyCashFlow: number;
  cashOnCash: number;
  capRate: number;
  viable: boolean;
}

export interface RenovationScenarioAnalysis {
  renovationPlan: RenovationPlan;
  condition: DetailedConditionScore;
  income: IncomeAnalysis;
  expenses: OperatingExpenses;
  cashFlow: CashFlowAnalysis;
  metrics: InvestmentMetrics;
  viability: ViabilityStatus;
  brrrr: BRRRRAnalysis;
  roi: RenovationROI;
  recommendation: string;
}

export interface RenovationROI {
  renovationCost: number;
  annualCashFlowGain: number;
  percentROI: number;
  paybackMonths: number;
  forcedAppreciation: number;
}

export interface TransformationAnalysis {
  rentIncrease: number;
  rentIncreasePercent: number;
  opExReduction: number;
  cashFlowImprovement: number;
  viabilityChange: string;
  worthIt: boolean;
  paybackMonths: number;
}

export type InvestmentStrategy = 'as_is_rental' | 'value_add_brrrr' | 'flip' | 'avoid';

export interface ActionStep {
  step: number;
  action: string;
  detail: string;
  timeline: string;
}

export interface DataSourcesSummary {
  valuation: string;
  condition: string;
  renovationCosts: string;
  rentalRates: string;
  financing: string;
  expenses: string;
}

export interface ConfidenceBreakdown {
  overall: number;
  valuation: number;
  condition: number;
  renovationCosts: number;
  rentalViability: number;
  wedgeDetection: number;
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface GoogleSearchResult {
  title: string;
  snippet: string;
  link: string;
  displayLink: string;
}

export interface BLSWageData {
  metroArea: string;
  hourlyWage: number;
  year: number;
  month: number;
}
