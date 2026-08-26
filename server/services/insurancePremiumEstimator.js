/**
 * Property insurance premium estimator + HouseYield mitigation savings calculator.
 *
 * Premium estimates and discount sensitivity scenarios are not binding quotes.
 */

import { insurers } from '../data/insurers.js';

const DEFAULT_MONITORING_MONTHLY = 22;

/** Annual premium as % of insured value, relative to 0.55% national landlord baseline */
const STATE_LANDLORD_RATE_MULTIPLIERS = {
  AL: 1.15, AK: 0.95, AZ: 1.05, AR: 1.1, CA: 1.08, CO: 1.12, CT: 1.05, DE: 1.0,
  FL: 1.48, GA: 1.12, HI: 0.92, ID: 0.78, IL: 1.08, IN: 0.95, IA: 0.88, KS: 1.05,
  KY: 1.02, LA: 1.38, ME: 0.9, MD: 1.02, MA: 1.05, MI: 1.0, MN: 0.92, MS: 1.18,
  MO: 1.05, MT: 0.85, NE: 0.95, NV: 1.0, NH: 0.88, NJ: 1.1, NM: 1.05, NY: 1.15,
  NC: 1.08, ND: 0.82, OH: 0.95, OK: 1.22, OR: 0.88, PA: 1.0, RI: 1.05, SC: 1.12,
  SD: 0.85, TN: 1.08, TX: 1.28, UT: 0.82, VT: 0.75, VA: 0.98, WA: 0.9, WV: 0.95,
  WI: 0.9, WY: 0.8, DC: 1.05,
};

const OCCUPANCY_BASE_RATE = {
  absentee_rental: 0.0055,
  second_home: 0.0048,
  owner_occupied: 0.0035,
};

const PROPERTY_TYPE_MULTIPLIERS = {
  SFR: 1.0,
  CONDO: 0.82,
  MFR: 1.18,
  APARTMENT: 1.25,
  COMMERCIAL: 1.35,
  LAND: 0.35,
};

function roundCurrency(value) {
  return Math.round(Number(value) || 0);
}

function parseDiscountPercent(label) {
  if (!label || typeof label !== 'string') return null;
  if (/varies/i.test(label)) return null;
  const match = label.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function normalizeState(state) {
  return String(state || '').trim().toUpperCase().slice(0, 2);
}

function normalizePropertyType(propertyType) {
  const raw = String(propertyType || 'SFR').toUpperCase();
  if (raw.includes('CONDO') || raw.includes('TOWN')) return 'CONDO';
  if (raw.includes('MULTI') || raw.includes('MFR') || raw.includes('DUPLEX') || raw.includes('TRIPLEX')) return 'MFR';
  if (raw.includes('APART')) return 'APARTMENT';
  if (raw.includes('COMM')) return 'COMMERCIAL';
  if (raw.includes('LAND') || raw.includes('VACANT')) return 'LAND';
  return 'SFR';
}

function resolveInsuredValue({ propertyValue, assessedValue, marketValue }) {
  const candidates = [propertyValue, marketValue, assessedValue]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) return 350000;
  return Math.max(...candidates);
}

function buildSavingsTier(annualPremium, discountPercent) {
  const annualSavings = roundCurrency(annualPremium * (discountPercent / 100));
  return {
    discountPercent,
    annualSavings,
    monthlySavings: roundCurrency(annualSavings / 12),
  };
}

/**
 * @param {Object} input
 * @param {number} [input.propertyValue]
 * @param {number} [input.assessedValue]
 * @param {number} [input.marketValue]
 * @param {string} [input.state]
 * @param {string} [input.propertyType]
 * @param {'absentee_rental'|'second_home'|'owner_occupied'} [input.occupancyType]
 * @param {string} [input.insurerId]
 * @param {number} [input.actualAnnualPremium] - overrides model if owner knows their premium
 * @param {number} [input.monitoringMonthlyCost]
 * @param {boolean} [input.hasAutoShutoff] - full HouseYield system assumed true by default
 */
export function estimatePropertyInsurancePremium(input = {}) {
  const state = normalizeState(input.state);
  const propertyTypeKey = normalizePropertyType(input.propertyType);
  const occupancyType = input.occupancyType || 'absentee_rental';
  const insuredValue = resolveInsuredValue(input);
  const monitoringMonthlyCost = Number(input.monitoringMonthlyCost) || DEFAULT_MONITORING_MONTHLY;
  const monitoringAnnualCost = roundCurrency(monitoringMonthlyCost * 12);

  const stateMultiplier = STATE_LANDLORD_RATE_MULTIPLIERS[state] || 1.0;
  const occupancyRate = OCCUPANCY_BASE_RATE[occupancyType] || OCCUPANCY_BASE_RATE.absentee_rental;
  const propertyMultiplier = PROPERTY_TYPE_MULTIPLIERS[propertyTypeKey] || 1.0;

  const modeledAnnual = roundCurrency(
    insuredValue * occupancyRate * stateMultiplier * propertyMultiplier,
  );
  const minimumAnnual = occupancyType === 'owner_occupied' ? 700 : 900;
  const estimatedAnnualPremium = roundCurrency(
    Math.max(input.actualAnnualPremium || modeledAnnual, minimumAnnual),
  );
  const estimatedMonthlyPremium = roundCurrency(estimatedAnnualPremium / 12);

  const lowAnnual = roundCurrency(estimatedAnnualPremium * 0.88);
  const highAnnual = roundCurrency(estimatedAnnualPremium * 1.12);

  const insurer = input.insurerId
    ? insurers.find((entry) => entry.id === input.insurerId)
    : null;
  const insurerMaxDiscount = parseDiscountPercent(insurer?.discountPercentage);
  const optimisticPercent = insurerMaxDiscount || 15;
  const midpointPercent = insurerMaxDiscount ? Math.min(insurerMaxDiscount, 12) : 10;
  const conservativePercent = insurerMaxDiscount
    ? Math.max(5, Math.round(insurerMaxDiscount * 0.5))
    : 5;

  const mitigationCredit = {
    conservative: buildSavingsTier(estimatedAnnualPremium, conservativePercent),
    typical: buildSavingsTier(estimatedAnnualPremium, midpointPercent),
    optimistic: buildSavingsTier(estimatedAnnualPremium, optimisticPercent),
  };

  const midpointScenario = mitigationCredit.typical;
  const netAnnualBenefitTypical = roundCurrency(midpointScenario.annualSavings - monitoringAnnualCost);
  const netMonthlyBenefitTypical = roundCurrency(midpointScenario.monthlySavings - monitoringMonthlyCost);
  const paybackMonthsTypical = midpointScenario.monthlySavings > 0
    ? roundCurrency((649 + 149) / midpointScenario.monthlySavings) // kit + commissioning rough
    : null;

  return {
    insuredValue,
    state: state || null,
    propertyType: propertyTypeKey,
    occupancyType,
    estimatedAnnualPremium,
    estimatedMonthlyPremium,
    premiumRange: {
      low: lowAnnual,
      high: highAnnual,
      lowMonthly: roundCurrency(lowAnnual / 12),
      highMonthly: roundCurrency(highAnnual / 12),
    },
    mitigationCredit,
    recommendedPitch: {
      headlineMonthlySavings: midpointScenario.monthlySavings,
      headlineAnnualSavings: midpointScenario.annualSavings,
      netMonthlyAfterMonitoring: netMonthlyBenefitTypical,
      netAnnualAfterMonitoring: netAnnualBenefitTypical,
    },
    houseYieldCosts: {
      monitoringMonthly: monitoringMonthlyCost,
      monitoringAnnual: monitoringAnnualCost,
      estimatedKitAndCommissioning: 798,
    },
    paybackMonthsOnPremiumSavings: paybackMonthsTypical,
    insurer: insurer
      ? {
          id: insurer.id,
          name: insurer.name,
          programName: insurer.discountProgramName,
          publishedDiscount: insurer.discountPercentage,
          parsedMaxDiscountPercent: insurerMaxDiscount,
          estimatedTypicalSavings: midpointScenario,
        }
      : null,
    methodology: [
      `Insured value basis: $${insuredValue.toLocaleString()} (${input.actualAnnualPremium ? 'owner-provided premium' : 'ATTOM/value model'}).`,
      `Landlord premium model uses ${(occupancyRate * 100).toFixed(2)}% of value × state factor ${stateMultiplier.toFixed(2)} × property type factor ${propertyMultiplier.toFixed(2)}.`,
      insurerMaxDiscount
        ? `The selected carrier label includes a numeric value; verify that value and its coverage basis before relying on this scenario.`
        : 'The 5%, 10%, and 15% outputs are sensitivity scenarios only. They are not represented as a typical or expected carrier credit.',
    ],
    disclaimer:
      'Premium figures are planning estimates. Mitigation savings are illustrative sensitivity scenarios, not a forecast or promise. Actual credits depend on carrier, state, policy form, covered peril, property, device eligibility, installation evidence, claims history, and underwriting review.',
  };
}

export default estimatePropertyInsurancePremium;
