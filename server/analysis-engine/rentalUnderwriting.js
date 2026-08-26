/**
 * rentalUnderwriting.js — rent estimation and auto-prefilled operating model.
 *
 * Rent estimate blends RentCast rent AVM, RentCast rental comps and the
 * ATTOM rental AVM. OpEx lines are prefilled from real data where available
 * (ATTOM taxes) and sensible heuristics elsewhere; everything stays
 * user-overridable downstream (assumption overrides re-run the projection).
 */

import { estimateVacancyForRentModel } from '../../src/utils/rentalVacancyModel.js';

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Blend available rent signals into one estimate with a confidence rating.
 */
export function estimateRent(bundle) {
  const { subject, rentAvm, zipMarket } = bundle;

  const rentcastRentAvm = num(rentAvm?.estimate);
  const attomRentalAvm = num(subject.rentalAvm);

  // Comp-implied rent: correlation-weighted comp rents
  const comps = rentAvm?.comparables || [];
  const usableComps = comps.filter((c) => Number.isFinite(num(c.price)) && num(c.price) > 100);
  let compImpliedRent = null;
  if (usableComps.length) {
    let weightedSum = 0;
    let weightTotal = 0;
    usableComps.forEach((c) => {
      const weight = Math.max(num(c.correlation) ?? 0.5, 0.1);
      weightedSum += num(c.price) * weight;
      weightTotal += weight;
    });
    compImpliedRent = weightTotal > 0 ? weightedSum / weightTotal : null;
  }

  // Zip rent-per-sqft fallback
  const zipRentPpsf = num(zipMarket?.rentalData?.medianPerSquareFoot);
  const zipImpliedRent = zipRentPpsf && num(subject.sqft) ? zipRentPpsf * num(subject.sqft) : null;

  const components = [
    { key: 'rentcastAvm', label: 'RentCast rent AVM', value: rentcastRentAvm, weight: 0.35 },
    { key: 'compImplied', label: `Rental comps (${usableComps.length})`, value: compImpliedRent, weight: 0.35 },
    { key: 'attomRentalAvm', label: 'ATTOM rental AVM', value: attomRentalAvm, weight: 0.20 },
    { key: 'zipImplied', label: 'Zip rent/sqft', value: zipImpliedRent, weight: 0.10 },
  ].filter((c) => Number.isFinite(c.value) && c.value > 100);

  let monthlyRent = null;
  if (components.length) {
    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    monthlyRent = round(components.reduce((sum, c) => sum + c.value * (c.weight / totalWeight), 0));
  }

  const spread = components.length >= 2 && monthlyRent
    ? ((Math.max(...components.map((c) => c.value)) - Math.min(...components.map((c) => c.value))) / monthlyRent) * 100
    : null;

  let confidence = 'low';
  if (components.length >= 3 && spread !== null && spread < 20) confidence = 'high';
  else if (components.length >= 2 && (spread === null || spread < 35)) confidence = 'medium';

  return {
    monthlyRent,
    confidence,
    spreadPct: spread !== null ? round(spread, 1) : null,
    components: components.map((c) => ({ key: c.key, label: c.label, value: round(c.value) })),
    range: {
      low: num(rentAvm?.estimateLow) ?? (monthlyRent ? round(monthlyRent * 0.9) : null),
      high: num(rentAvm?.estimateHigh) ?? (monthlyRent ? round(monthlyRent * 1.1) : null),
    },
    comps: usableComps.slice(0, 12).map((c) => ({
      address: c.formattedAddress,
      latitude: c.latitude,
      longitude: c.longitude,
      rent: c.price,
      bedrooms: c.bedrooms,
      bathrooms: c.bathrooms,
      squareFootage: c.squareFootage,
      distanceMiles: c.distance != null ? round(c.distance, 2) : null,
      correlation: c.correlation != null ? round(c.correlation, 2) : null,
      daysOnMarket: c.daysOnMarket,
    })),
  };
}

/**
 * Rental pricing-power curve derived from rental comps and zip stats:
 * benchmark rent, supported ceiling, market rejection point, and a vacancy
 * response estimate at a given asking rent.
 */
export function buildPricingPower(bundle, rentEstimate) {
  const { zipMarket } = bundle;
  const monthlyRent = num(rentEstimate?.monthlyRent);
  if (!monthlyRent) return null;

  const compRents = (rentEstimate.comps || []).map((c) => num(c.rent)).filter((r) => Number.isFinite(r));
  const benchmark = compRents.length
    ? compRents.sort((a, b) => a - b)[Math.floor(compRents.length / 2)]
    : num(zipMarket?.rentalData?.median) ?? monthlyRent;

  const maxComp = compRents.length ? Math.max(...compRents) : monthlyRent * 1.15;
  const supportedCeiling = round(Math.max(monthlyRent, Math.min(maxComp, benchmark * 1.25)));
  const rejectionPoint = round(supportedCeiling * 1.18);

  const reportedVacancy = num(zipMarket?.rentalData?.vacancyRate)
    ?? num(zipMarket?.rentalData?.rentalVacancyRate);
  const medianDom = num(zipMarket?.rentalData?.medianDaysOnMarket);
  const baseVacancyPct = round(Math.min(Math.max(
    (reportedVacancy ?? 6)
      + (medianDom != null ? (medianDom >= 60 ? 1 : medianDom <= 21 ? -0.5 : 0) : 0),
    2,
  ), 12), 1);
  const vacancyModel = {
    anchorRent: benchmark,
    baseVacancyRate: baseVacancyPct,
    compP25Rent: round(benchmark * 0.94),
    compMedianRent: benchmark,
    compP75Rent: round(benchmark * 1.04),
    compP90Rent: round(benchmark * 1.08),
    supportedCeilingRent: supportedCeiling,
    rentAtFullVacancy: rejectionPoint,
    minVacancyRate: Math.max(1.5, baseVacancyPct - 1),
    maxVacancyRate: 100,
  };

  const vacancyAtRent = (askingRent) => {
    return estimateVacancyForRentModel(askingRent, vacancyModel, {
      baseVacancyRate: baseVacancyPct,
    }) ?? baseVacancyPct;
  };

  // Build the sweep curve for the interactive rent slider
  const sweepMin = round(benchmark * 0.6);
  const sweepMax = rejectionPoint;
  const steps = 25;
  const curve = Array.from({ length: steps + 1 }, (_, i) => {
    const rent = round(sweepMin + ((sweepMax - sweepMin) * i) / steps);
    const vacancyPct = vacancyAtRent(rent);
    return {
      rent,
      vacancyPct,
      effectiveAnnualIncome: round(rent * 12 * (1 - vacancyPct / 100)),
    };
  });

  // Recommended rent maximizes effective income within the supported band
  const recommended = curve
    .filter((p) => p.rent <= supportedCeiling)
    .reduce((best, p) => (p.effectiveAnnualIncome > (best?.effectiveAnnualIncome ?? -1) ? p : best), null);

  return {
    benchmarkRent: round(benchmark),
    estimatedRent: monthlyRent,
    recommendedRent: recommended?.rent ?? monthlyRent,
    recommendedVacancyPct: recommended?.vacancyPct ?? baseVacancyPct,
    supportedCeiling,
    marketRejectionPoint: rejectionPoint,
    baseVacancyPct: round(baseVacancyPct, 1),
    curve,
  };
}

/**
 * Build the operating expense model, auto-prefilled from real data.
 * Returns the calculator-parity input block (without purchase/financing).
 */
export function buildOperatingModel(bundle, rentEstimate, { purchasePrice } = {}) {
  const { subject, zipMarket } = bundle;
  const monthlyRent = num(rentEstimate?.monthlyRent) || 0;
  const valueBasis = num(purchasePrice) || num(subject.avmValue) || (monthlyRent * 12 * 15);

  // Property tax: real ATTOM amount, else ~1.1% of value
  const propertyTax = num(subject.taxAmount) || round(valueBasis * 0.011);
  const taxSource = num(subject.taxAmount) ? 'attom' : 'estimated';

  // Insurance: ~0.5% of value, floored
  const insurance = round(Math.max(valueBasis * 0.005, 800));

  // Maintenance: 1% of value per year (age-adjusted)
  const age = num(subject.age) ?? (num(subject.yearBuilt) ? new Date().getFullYear() - num(subject.yearBuilt) : 30);
  const maintenanceRate = age > 50 ? 0.014 : age > 25 ? 0.011 : 0.008;
  const maintenance = round(valueBasis * maintenanceRate);

  // CapEx reserve folded into otherCosts (~0.5% of value)
  const otherCosts = round(valueBasis * 0.005);

  // Vacancy from market days-on-market signal
  const domDays = num(zipMarket?.rentalData?.medianDaysOnMarket);
  const vacancyRate = domDays ? round(Math.min(Math.max((domDays / 365) * 100 * 1.4, 4), 15), 1) : 7;

  return {
    monthlyRent,
    otherMonthlyIncome: 0,
    vacancyRate,
    managementFee: 8,
    propertyTax,
    insurance,
    hoaFee: 0,
    maintenance,
    otherCosts,
    prefillSources: {
      propertyTax: taxSource,
      insurance: 'estimated',
      maintenance: `estimated (age ${age})`,
      otherCosts: 'capex reserve estimate',
      vacancyRate: domDays ? 'market days-on-market' : 'default',
      managementFee: 'default 8%',
    },
  };
}
