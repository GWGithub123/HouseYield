/**
 * analysis-engine/index.js — orchestrator producing the unified DealReport
 * used by both the individual analyzer and the regional screener underwrite.
 */

import { aggregatePropertyData } from './dataAggregator.js';
import { computeValuation } from './valuation.js';
import { estimateRent, buildPricingPower, buildOperatingModel } from './rentalUnderwriting.js';
import { buildScenarios, buildRefiGrid, buildStressTest, solveOfferPrice } from './dealScenarios.js';
import { computeDealScore } from './dealScore.js';
import { analyzeRenovationOpportunities, estimateMarketLevelRenovation } from './renovationAdapter.js';
import { DEFAULT_ASSUMPTIONS } from './projections.js';

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildMarketContext(bundle) {
  const { zipMarket, fredCounty, subject } = bundle;
  const derived = zipMarket?.derived || {};

  return {
    zipCode: subject.zipCode,
    medianSalePrice: derived.medianSalePrice ?? null,
    medianAskingRent: derived.medianAskingRent ?? null,
    grossYieldPct: derived.grossYieldPct ?? null,
    priceToRentRatio: derived.priceToRentRatio ?? null,
    saleMedianDaysOnMarket: zipMarket?.saleData?.medianDaysOnMarket ?? null,
    rentalMedianDaysOnMarket: zipMarket?.rentalData?.medianDaysOnMarket ?? null,
    saleListings: derived.saleListings ?? null,
    rentalListings: derived.rentalListings ?? null,
    county: fredCounty ? {
      name: fredCounty.countyName || fredCounty.name || null,
      unemploymentRate: fredCounty.unemploymentRate ?? fredCounty.unemployment?.value ?? null,
      newListings: fredCounty.newListings?.value ?? null,
      medianDaysOnMarket: fredCounty.medianDaysOnMarket?.value ?? null,
      raw: fredCounty,
    } : null,
  };
}

/**
 * Full property analysis -> DealReport.
 *
 * @param {object} options
 *   address       — required
 *   listPrice     — asking price (falls back to fair value for off-market)
 *   photos        — optional array of base64/data-url/remote-url photos
 *   assumptions   — calculator-parity overrides (downPaymentPercent, interestRate, ...)
 *   listingHints  — partial facts from a screener listing
 *   include       — aggregator source toggles
 *   onProgress    — optional callback(stage, detail) for streaming progress
 */
export async function analyzeProperty({
  address,
  listPrice = null,
  photos = [],
  assumptions = {},
  listingHints = {},
  include = {},
  onProgress = () => {},
}) {
  if (!address || !String(address).trim()) throw new Error('missing_address');

  // 1. Data aggregation
  onProgress('data', 'Fetching property, market, and macro data');
  const bundle = await aggregatePropertyData({ address: String(address).trim(), listingHints, include });

  // 2. Valuation
  onProgress('valuation', 'Computing blended fair value');
  const valuation = computeValuation(bundle, listPrice);

  // 3. Rent underwriting
  onProgress('rental', 'Underwriting rental income');
  const rent = estimateRent(bundle);
  const pricingPower = buildPricingPower(bundle, rent);

  // 4. Renovation (photos when available, market-level otherwise)
  onProgress('renovation', photos?.length ? `Analyzing ${photos.length} photos for renovation opportunities` : 'Modeling market-level renovation potential');
  let renovation = null;
  try {
    renovation = photos?.length
      ? await analyzeRenovationOpportunities({ photos, subject: bundle.subject, valuation })
      : estimateMarketLevelRenovation(bundle.subject, valuation);
  } catch (err) {
    console.warn('[Engine] Renovation analysis failed:', err.message);
    renovation = estimateMarketLevelRenovation(bundle.subject, valuation);
  }

  // 5. Underwriting inputs (calculator parity, auto-prefilled, user-overridable)
  onProgress('underwrite', 'Building deal scenarios and projections');
  const effectivePrice = num(listPrice) ?? valuation.fairValue;
  if (!effectivePrice) throw new Error('no_price_basis');

  const operating = buildOperatingModel(bundle, rent, { purchasePrice: effectivePrice });

  const baseInputs = {
    ...DEFAULT_ASSUMPTIONS,
    purchasePrice: effectivePrice,
    monthlyRent: operating.monthlyRent,
    otherMonthlyIncome: operating.otherMonthlyIncome,
    vacancyRate: operating.vacancyRate,
    managementFee: operating.managementFee,
    propertyTax: operating.propertyTax,
    insurance: operating.insurance,
    hoaFee: operating.hoaFee,
    maintenance: operating.maintenance,
    otherCosts: operating.otherCosts,
    ...assumptions,
  };

  const renovationInputs = renovation && renovation.totals?.cost > 0 ? {
    repairCost: renovation.totals.cost,
    valueAfterRepairs: renovation.arv ?? (valuation.fairValue ?? effectivePrice) + renovation.totals.valueUplift,
    monthlyRentAfter: (operating.monthlyRent || 0) + (renovation.totals.rentUpliftMonthly || 0),
  } : null;

  // 6. Scenarios + edges
  const scenarios = buildScenarios(baseInputs, renovationInputs, {
    refiAtYear: num(assumptions.refiAtYear),
    refiRate: num(assumptions.refiRate),
    refiLtvPercent: num(assumptions.refiLtvPercent),
    refiLoanTermYears: num(assumptions.refiLoanTermYears),
    refiClosingCostPercent: num(assumptions.refiClosingCostPercent),
  });
  const refiGrid = buildRefiGrid(baseInputs, renovationInputs, { refiAtYear: num(assumptions.refiAtYear) });
  const stressTest = buildStressTest(baseInputs, renovationInputs);
  const offerSolver = num(listPrice)
    ? solveOfferPrice(baseInputs, assumptions.buyBox || {}, renovationInputs)
    : null;

  // 7. Environmental snapshot from ATTOM hazard data (already in dashboard)
  const hazardScores = bundle.dashboard?.hazard_scores || null;
  const noiseLevel = num(bundle.dashboard?.noiseLevel);
  let environmentalRiskScore = num(assumptions.environmentalRiskScore);
  if (environmentalRiskScore == null && hazardScores) {
    const values = ['flood', 'fire', 'earthquake']
      .map((k) => num(hazardScores[k]))
      .filter((v) => v != null);
    if (values.length) {
      // ATTOM hazard scores ~0-100 where higher = riskier
      environmentalRiskScore = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
    }
  }
  const environmental = (hazardScores || noiseLevel != null) ? {
    combinedRiskScore: environmentalRiskScore,
    hazards: hazardScores,
    noiseLevelDb: noiseLevel,
    source: 'attom',
  } : null;

  // 8. Score
  onProgress('score', 'Scoring the deal');
  const marketContext = buildMarketContext(bundle);
  const dealScore = computeDealScore({
    valuation,
    scenarios,
    marketContext,
    environmentalRiskScore,
    confidence: bundle.confidence,
  });

  onProgress('done', 'Analysis complete');

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    address: bundle.address,
    subject: bundle.subject,
    sources: bundle.sources,
    confidence: bundle.confidence,
    dealScore,
    valuation,
    rent,
    pricingPower,
    renovation,
    operating,
    assumptions: baseInputs,
    scenarios: scenarios.map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      summary: s.summary,
      chartData: s.chartData,
      refiEvent: s.projection.refiEvent,
      financing: {
        inputs: s.projection.inputs,
        loanAmount: s.projection.loanAmount,
        downPayment: s.projection.downPayment,
        monthlyMortgagePayment: s.projection.monthlyMortgagePayment,
        cashLeftInDeal: s.projection.cashLeftInDeal,
      },
      holdingRows: s.projection.holdingRows,
    })),
    refiGrid,
    stressTest,
    offerSolver,
    marketContext,
    environmental,
    avmHistory: bundle.dashboard?.avm_history || null,
    priceHistory: bundle.dashboard?.sales_history || bundle.dashboard?.sale_history || null,
    taxHistory: bundle.dashboard?.tax_history || null,
  };
}

export { aggregatePropertyData } from './dataAggregator.js';
export { computeValuation } from './valuation.js';
export { estimateRent, buildPricingPower, buildOperatingModel } from './rentalUnderwriting.js';
export { buildScenarios, buildRefiGrid, buildStressTest, solveOfferPrice } from './dealScenarios.js';
export { computeDealScore } from './dealScore.js';
export { buildProjection, projectionToChartData, DEFAULT_ASSUMPTIONS } from './projections.js';
