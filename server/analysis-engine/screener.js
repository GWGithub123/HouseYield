/**
 * screener.js — Stage-1 regional deal screen over live RentCast sale listings.
 *
 * Zero ATTOM spend: uses listings + zip market aggregates + current mortgage
 * rate to desk-screen every listing against the investor's buy box, producing
 * preliminary scores and a funnel summary. Survivors can be deep-underwritten
 * via the full engine (screener/underwrite).
 */

import { searchSaleListings, getZipMarketData } from '../rentcast.js';
import { getHistoricalMortgageRate } from '../fred.js';
import { getMonthlyMortgagePayment } from './projections.js';

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

let cachedRate = null;
let cachedRateAt = 0;

async function getCurrentMortgageRate() {
  if (cachedRate && Date.now() - cachedRateAt < 1000 * 60 * 60 * 12) return cachedRate;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await getHistoricalMortgageRate(today);
    const rate = num(result?.rate ?? result);
    if (rate && rate > 2 && rate < 15) {
      cachedRate = rate;
      cachedRateAt = Date.now();
      return rate;
    }
  } catch (err) {
    console.warn('[Screener] FRED mortgage rate lookup failed:', err.message);
  }
  return 7.0;
}

async function getZipMarketsForListings(listings) {
  const zips = [...new Set(listings.map((l) => l.zipCode).filter(Boolean))].slice(0, 25);
  const results = await Promise.allSettled(zips.map((zip) => getZipMarketData(zip)));
  const map = new Map();
  zips.forEach((zip, i) => {
    if (results[i].status === 'fulfilled') map.set(zip, results[i].value);
  });
  return map;
}

function screenListing(listing, zipMarket, mortgageRate, buyBox, assumptions = {}) {
  const price = num(listing.price);
  const sqft = num(listing.squareFootage);
  const sale = zipMarket?.saleData;
  const rental = zipMarket?.rentalData;
  const derived = zipMarket?.derived;

  // Valuation edge: listing $/sqft vs zip median $/sqft
  const zipPpsf = num(sale?.medianPerSquareFoot);
  const listingPpsf = price && sqft ? price / sqft : null;
  let valuationEdgePct = null;
  if (zipPpsf && listingPpsf) {
    valuationEdgePct = round(((zipPpsf - listingPpsf) / zipPpsf) * 100, 1);
  }

  // Rent estimate: prefer bedroom/property market rents and use rent/sqft only
  // as a bounded signal. Large SFR rents do not scale linearly with square
  // footage, so uncapped $/sf math creates false-positive luxury deals.
  const zipRentPpsf = num(rental?.medianPerSquareFoot);
  const sqftRent = zipRentPpsf && sqft ? zipRentPpsf * sqft : null;
  const bedBreakdown = (rental?.byBedrooms || []).find((b) => b.bedrooms === listing.bedrooms);
  const typeBreakdown = (rental?.byPropertyType || []).find((b) => {
    return String(b.propertyType || b.label || '').toLowerCase() === String(listing.propertyType || '').toLowerCase();
  });
  const bedRent = num(bedBreakdown?.median);
  const typeRent = num(typeBreakdown?.median);
  const marketMedianRent = num(rental?.median);
  const rentAnchors = [bedRent, typeRent, marketMedianRent].filter((v) => Number.isFinite(v));
  const anchorRent = rentAnchors.length
    ? rentAnchors.reduce((sum, value) => sum + value, 0) / rentAnchors.length
    : null;

  let estRent = null;
  let estRentSource = null;
  if (sqftRent && anchorRent) {
    const sqftPremium = sqft && num(rental?.medianSquareFootage)
      ? Math.min(Math.max((sqft - num(rental.medianSquareFootage)) / Math.max(num(rental.medianSquareFootage), 1), 0), 1)
      : 0;
    const sqftWeight = sqftPremium > 0.35 ? 0.25 : 0.4;
    const blended = anchorRent * (1 - sqftWeight) + sqftRent * sqftWeight;
    estRent = Math.min(blended, anchorRent * 1.65);
    estRentSource = 'bounded_market_blend';
  } else if (anchorRent) {
    estRent = anchorRent;
    estRentSource = 'market_anchor';
  } else if (sqftRent) {
    estRent = marketMedianRent ? Math.min(sqftRent, marketMedianRent * 1.75) : sqftRent;
    estRentSource = 'bounded_sqft';
  }
  estRent = estRent ? round(estRent) : null;

  const downPaymentPercent = num(assumptions.downPaymentPercent) ?? 20;
  const interestRate = num(assumptions.interestRate) ?? mortgageRate;
  const loanTermYears = num(assumptions.loanTermYears) ?? 30;
  const closingCostPercent = num(assumptions.closingCostPercent) ?? 3;
  const propertyTaxPercent = num(assumptions.propertyTaxPercent) ?? 1.1;
  const insurancePercent = num(assumptions.insurancePercent) ?? 0.5;
  const maintenancePercent = num(assumptions.maintenancePercent) ?? 0.8;
  const otherCostsPercent = num(assumptions.otherCostsPercent) ?? 0.5;
  const vacancyRate = num(assumptions.vacancyRate) ?? 7;
  const managementFee = num(assumptions.managementFee) ?? 8;
  const useLoan = assumptions.useLoan !== false;

  // Stage-1 screen mirrors the calculator structure: income, vacancy, OpEx,
  // NOI, debt service, then FCF. It is still market-level and API-light.
  let estMonthlyCashFlow = null;
  let estPiti = null;
  let estMonthlyNoi = null;
  let estMonthlyOperatingExpenses = null;
  let estCashIn = null;
  let estCocPct = null;
  let estDscr = null;
  let estCapRatePct = null;
  let breakEvenRent = null;
  let cashFlowStatus = 'unknown';
  if (price && estRent) {
    const loan = useLoan ? price * (1 - Math.min(Math.max(downPaymentPercent, 0), 100) / 100) : 0;
    const pi = useLoan ? getMonthlyMortgagePayment(loan, interestRate, loanTermYears * 12) : 0;
    const vacancyLoss = estRent * (vacancyRate / 100);
    const effectiveIncome = estRent - vacancyLoss;
    const taxes = (price * (propertyTaxPercent / 100)) / 12;
    const insurance = (price * (insurancePercent / 100)) / 12;
    const maintenance = (price * (maintenancePercent / 100)) / 12;
    const otherCosts = (price * (otherCostsPercent / 100)) / 12;
    const management = effectiveIncome * (managementFee / 100);
    estMonthlyOperatingExpenses = taxes + insurance + maintenance + otherCosts + management;
    estMonthlyNoi = effectiveIncome - estMonthlyOperatingExpenses;
    estPiti = round(pi);
    estMonthlyCashFlow = round(estMonthlyNoi - pi);
    estCashIn = useLoan ? price * (downPaymentPercent / 100) + price * (closingCostPercent / 100) : price + price * (closingCostPercent / 100);
    estCocPct = estCashIn > 0 ? round(((estMonthlyCashFlow * 12) / estCashIn) * 100, 2) : null;
    estDscr = pi > 0 ? round(estMonthlyNoi / pi, 2) : null;
    estCapRatePct = round(((estMonthlyNoi * 12) / price) * 100, 2);
    const fixedMonthlyCosts = pi + taxes + insurance + maintenance + otherCosts;
    const incomeRetainedAfterVacancyAndManagement = (1 - vacancyRate / 100) * (1 - managementFee / 100);
    breakEvenRent = incomeRetainedAfterVacancyAndManagement > 0
      ? round(fixedMonthlyCosts / incomeRetainedAfterVacancyAndManagement)
      : null;
    cashFlowStatus = estMonthlyCashFlow > 0
      ? 'positive'
      : estMonthlyCashFlow >= -100 ? 'near_break_even' : 'negative';
  }

  const grossYieldPct = price && estRent ? round((estRent * 12 / price) * 100, 2) : null;
  const priceToRent = price && estRent ? round(price / (estRent * 12), 2) : null;

  // Days-on-market negotiation signal
  const zipDom = num(sale?.medianDaysOnMarket);
  const domSignal = num(listing.daysOnMarket) != null && zipDom
    ? (listing.daysOnMarket > zipDom * 1.5 ? 'stale' : listing.daysOnMarket < zipDom * 0.5 ? 'fresh' : 'normal')
    : null;

  // Preliminary score
  let score = 50;
  if (valuationEdgePct != null) score += Math.max(Math.min(valuationEdgePct * 1.6, 24), -24);
  if (estMonthlyCashFlow != null) score += Math.max(Math.min(estMonthlyCashFlow / 25, 16), -16);
  if (grossYieldPct != null) score += Math.max(Math.min((grossYieldPct - 6) * 2, 8), -8);
  if (domSignal === 'stale') score += 2;
  score = Math.round(Math.max(Math.min(score, 99), 1));

  // Buy box check
  const reasons = [];
  const minCf = num(buyBox?.minMonthlyCashFlow);
  const minCoc = num(buyBox?.minCocPct);
  const minDscr = num(buyBox?.minDscr);
  const maxPtr = num(buyBox?.maxPriceToRent);
  const minEdge = num(buyBox?.minValuationEdgePct);
  if (minCf != null && estMonthlyCashFlow != null && estMonthlyCashFlow < minCf) reasons.push(`cash flow $${estMonthlyCashFlow} < $${minCf}`);
  if (minCoc != null && estCocPct != null && estCocPct < minCoc) reasons.push(`CoC ${estCocPct}% < ${minCoc}%`);
  if (minDscr != null && estDscr != null && estDscr < minDscr) reasons.push(`DSCR ${estDscr} < ${minDscr}`);
  if (maxPtr != null && priceToRent != null && priceToRent > maxPtr) reasons.push(`price-to-rent ${priceToRent} > ${maxPtr}`);
  if (minEdge != null && valuationEdgePct != null && valuationEdgePct < minEdge) reasons.push(`valuation edge ${valuationEdgePct}% < ${minEdge}%`);
  const dataMissing = estRent == null || valuationEdgePct == null;
  const passes = reasons.length === 0 && !dataMissing;

  return {
    ...listing,
    screen: {
      score,
      passes,
      failReasons: reasons,
      dataMissing,
      valuationEdgePct,
      estRent,
      estRentSource,
      estPiti,
      estMonthlyCashFlow,
      estMonthlyNoi: round(estMonthlyNoi),
      estMonthlyOperatingExpenses: round(estMonthlyOperatingExpenses),
      estCashIn: round(estCashIn),
      estCocPct,
      estDscr,
      estCapRatePct,
      breakEvenRent,
      cashFlowStatus,
      positiveCashFlow: estMonthlyCashFlow != null ? estMonthlyCashFlow > 0 : false,
      grossYieldPct,
      priceToRent,
      assumptions: {
        downPaymentPercent,
        interestRate,
        loanTermYears,
        vacancyRate,
        managementFee,
      },
      domSignal,
      zipMedianPricePerSqft: zipPpsf,
      zipMedianRent: num(rental?.median),
      zipGrossYieldPct: num(derived?.grossYieldPct),
    },
  };
}

/**
 * Stage-0 + Stage-1: search live listings then desk-screen each one.
 */
export async function searchAndScreen(criteria = {}) {
  const { buyBox = {}, assumptions = {}, ...searchCriteria } = criteria;

  const searchResult = await searchSaleListings(searchCriteria);
  const listings = searchResult.listings || [];

  const [zipMarkets, mortgageRate] = await Promise.all([
    getZipMarketsForListings(listings),
    getCurrentMortgageRate(),
  ]);

  const screened = listings
    .map((listing) => screenListing(listing, zipMarkets.get(listing.zipCode), mortgageRate, buyBox, assumptions))
    .sort((a, b) => b.screen.score - a.screen.score);

  const passing = screened.filter((l) => l.screen.passes);

  return {
    search: searchResult.search,
    fromCache: searchResult.fromCache,
    fetchedAt: searchResult.fetchedAt,
    mortgageRate,
    assumptions: {
      interestRate: num(assumptions.interestRate) ?? mortgageRate,
      downPaymentPercent: num(assumptions.downPaymentPercent) ?? 20,
      loanTermYears: num(assumptions.loanTermYears) ?? 30,
      closingCostPercent: num(assumptions.closingCostPercent) ?? 3,
      vacancyRate: num(assumptions.vacancyRate) ?? 7,
      managementFee: num(assumptions.managementFee) ?? 8,
    },
    funnel: {
      totalListings: screened.length,
      screened: screened.filter((l) => !l.screen.dataMissing).length,
      positiveCashFlow: screened.filter((l) => l.screen.positiveCashFlow).length,
      nearBreakEven: screened.filter((l) => l.screen.cashFlowStatus === 'near_break_even').length,
      passing: passing.length,
    },
    buyBox,
    listings: screened,
  };
}
