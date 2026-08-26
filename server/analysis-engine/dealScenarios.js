/**
 * dealScenarios.js — comparable deal scenarios built on projections.js.
 *
 * Every scenario answers the same three questions with identical metric rows:
 * what it costs (cash in), what it changes (price + rent), what it returns
 * (FCF / CoC / IRR). Also provides the sensitivity stress grid and the
 * "offer price to hit your buy box" solver.
 */

import { buildProjection, projectionToChartData } from './projections.js';

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function scenarioSummary(projection) {
  const m = projection.metrics;
  return {
    cashIn: round(projection.initialInvestment),
    loanAmount: round(projection.loanAmount),
    downPayment: round(projection.downPayment),
    monthlyMortgagePayment: round(projection.monthlyMortgagePayment),
    cashLeftInDeal: round(projection.cashLeftInDeal),
    refiCashOut: projection.refiEvent ? round(projection.refiEvent.cashOut) : null,
    monthlyCashFlowYear1: round(m.monthlyCashFlowYear1),
    postRefiMonthlyCashFlow: m.postRefiMonthlyCashFlow != null ? round(m.postRefiMonthlyCashFlow) : null,
    noiYear1: round(m.noiYear1),
    monthlyDebtServiceYear1: round(m.monthlyDebtServiceYear1),
    annualDebtServiceYear1: round(m.annualDebtServiceYear1),
    operatingExpensesYear1: round(m.operatingExpensesYear1),
    grossPotentialIncomeYear1: round(m.grossPotentialIncomeYear1),
    capRatePct: round(m.capRatePct, 2),
    cocYear1Pct: round(m.cocYear1Pct, 2),
    postRefiCocPct: Number.isFinite(m.postRefiCocPct) ? round(m.postRefiCocPct, 2) : (m.postRefiCocPct === Infinity ? 'infinite' : null),
    dscrYear1: m.dscrYear1 != null ? round(m.dscrYear1, 2) : null,
    breakEvenOccupancyPct: round(m.breakEvenOccupancyPct, 1),
    grm: m.grm != null ? round(m.grm, 2) : null,
    irr5yrPct: m.irr5yr != null ? round(m.irr5yr, 2) : null,
    irr10yrPct: m.irr10yr != null ? round(m.irr10yr, 2) : null,
    irrAtHoldPct: round(m.irrAtHold, 2),
    equityAtHold: round(m.equityAtHold),
    totalProfitWhenSold: round(m.totalProfitWhenSold),
  };
}

/**
 * Build the standard scenario set.
 *
 * @param {object} base — calculator-parity inputs WITHOUT renovation fields:
 *   { purchasePrice, downPaymentPercent, interestRate, loanTermYears,
 *     closingCost|closingCostPercent, propertyTax, insurance, hoaFee,
 *     maintenance, otherCosts, monthlyRent, vacancyRate, managementFee,
 *     valueAppreciation, holdingLengthYears, costToSell, ...increase rates }
 * @param {object|null} renovation — { repairCost, valueAfterRepairs, monthlyRentAfter }
 * @param {object} options — { refiAtYear, refiRate, refiLtvPercent, refiLoanTermYears, refiClosingCostPercent }
 */
export function buildScenarios(base, renovation = null, options = {}) {
  const scenarios = [];

  // 1. Buy & Hold as-is
  const buyHold = buildProjection({ ...base, repairCost: 0, valueAfterRepairs: 0 });
  scenarios.push({
    key: 'buyHold',
    label: 'Buy & Hold',
    description: 'Purchase as-is, rent at market, hold long-term.',
    projection: buyHold,
    summary: scenarioSummary(buyHold),
    chartData: projectionToChartData(buyHold),
  });

  const hasReno = renovation && num(renovation.repairCost) > 0 && num(renovation.valueAfterRepairs) > 0;

  if (hasReno) {
    const renoBase = {
      ...base,
      repairCost: num(renovation.repairCost),
      valueAfterRepairs: num(renovation.valueAfterRepairs),
      monthlyRent: num(renovation.monthlyRentAfter) || base.monthlyRent,
    };

    // 2. Renovate & Hold (no refi)
    const renoHold = buildProjection(renoBase);
    scenarios.push({
      key: 'renovateHold',
      label: 'Renovate & Hold',
      description: 'Renovate after purchase, rent at the improved rate, keep original financing.',
      projection: renoHold,
      summary: scenarioSummary(renoHold),
      chartData: projectionToChartData(renoHold),
    });

    // 3. BRRRR: renovate then cash-out refi using editable deal assumptions
    const refiRate = num(options.refiRate) ?? num(base.refiRate) ?? (num(base.interestRate) != null ? num(base.interestRate) + 0.25 : 7.25);
    const refiAtYear = num(options.refiAtYear) ?? num(base.refiAtYear) ?? 2;
    const refiLtvPercent = num(options.refiLtvPercent) ?? num(base.refiLtvPercent) ?? 75;
    const refiLoanTermYears = num(options.refiLoanTermYears) ?? num(base.refiLoanTermYears) ?? 30;
    const refiClosingCostPercent = num(options.refiClosingCostPercent) ?? num(base.refiClosingCostPercent) ?? 1.5;
    const brrrr = buildProjection({
      ...renoBase,
      refinance: {
        atYear: refiAtYear,
        ltvPercent: refiLtvPercent,
        interestRate: refiRate,
        loanTermYears: refiLoanTermYears,
        closingCostPercent: refiClosingCostPercent,
      },
    });
    scenarios.push({
      key: 'brrrr',
      label: 'BRRRR',
      description: 'Buy, renovate, rent, cash-out refinance at 75% LTV after year 1, repeat.',
      projection: brrrr,
      summary: scenarioSummary(brrrr),
      chartData: projectionToChartData(brrrr),
    });
  }

  return scenarios;
}

/**
 * Refi rate-sensitivity grid for the BRRRR scenario (rate x LTV).
 */
export function buildRefiGrid(base, renovation, { rates, ltvs, refiAtYear } = {}) {
  if (!renovation || !num(renovation.repairCost) || !num(renovation.valueAfterRepairs)) return null;

  const rateList = rates || [6.0, 6.5, 7.0, 7.5, 8.0];
  const ltvList = ltvs || [70, 75, 80];

  const renoBase = {
    ...base,
    repairCost: num(renovation.repairCost),
    valueAfterRepairs: num(renovation.valueAfterRepairs),
    monthlyRent: num(renovation.monthlyRentAfter) || base.monthlyRent,
  };

  return {
    rates: rateList,
    ltvs: ltvList,
    cells: ltvList.map((ltv) => rateList.map((rate) => {
      const projection = buildProjection({
        ...renoBase,
        refinance: {
          atYear: num(refiAtYear) ?? num(base.refiAtYear) ?? 2,
          ltvPercent: ltv,
          interestRate: rate,
          loanTermYears: num(base.refiLoanTermYears) ?? 30,
          closingCostPercent: num(base.refiClosingCostPercent) ?? 1.5,
        },
      });
      return {
        ltv,
        rate,
        cashOut: projection.refiEvent ? round(projection.refiEvent.cashOut) : 0,
        cashLeftInDeal: round(projection.cashLeftInDeal),
        postRefiMonthlyCashFlow: projection.metrics.postRefiMonthlyCashFlow != null ? round(projection.metrics.postRefiMonthlyCashFlow) : null,
        irr10yrPct: projection.metrics.irr10yr != null ? round(projection.metrics.irr10yr, 2) : null,
      };
    })),
  };
}

/**
 * Sensitivity stress grid: how the deal holds up when key assumptions move
 * against you. Pure recomputation — zero API cost.
 */
export function buildStressTest(base, renovation = null) {
  const applyReno = (inputs) => (renovation && num(renovation.repairCost) > 0
    ? { ...inputs, repairCost: num(renovation.repairCost), valueAfterRepairs: num(renovation.valueAfterRepairs), monthlyRent: num(renovation.monthlyRentAfter) || inputs.monthlyRent }
    : inputs);

  const baselineInputs = applyReno({ ...base });
  const baseline = buildProjection(baselineInputs);

  const shocks = [
    { key: 'rentDown10', label: 'Rent -10%', mutate: (i) => ({ ...i, monthlyRent: i.monthlyRent * 0.9 }) },
    { key: 'vacancyUp5', label: 'Vacancy +5pts', mutate: (i) => ({ ...i, vacancyRate: (i.vacancyRate || 7) + 5 }) },
    { key: 'rateUp1', label: 'Rate +1%', mutate: (i) => ({ ...i, interestRate: (i.interestRate || 7) + 1 }) },
    { key: 'rehabUp10', label: 'Rehab +10%', mutate: (i) => (i.repairCost > 0 ? { ...i, repairCost: i.repairCost * 1.1 } : null) },
    { key: 'taxUp15', label: 'Taxes +15%', mutate: (i) => ({ ...i, propertyTax: (i.propertyTax || 0) * 1.15 }) },
    { key: 'allAdverse', label: 'All adverse', mutate: (i) => ({
        ...i,
        monthlyRent: i.monthlyRent * 0.9,
        vacancyRate: (i.vacancyRate || 7) + 5,
        interestRate: (i.interestRate || 7) + 1,
        repairCost: i.repairCost > 0 ? i.repairCost * 1.1 : 0,
      }) },
  ];

  const rows = shocks
    .map((shock) => {
      const mutated = shock.mutate(baselineInputs);
      if (!mutated) return null;
      const projection = buildProjection(mutated);
      return {
        key: shock.key,
        label: shock.label,
        monthlyCashFlow: round(projection.metrics.monthlyCashFlowYear1),
        cocPct: round(projection.metrics.cocYear1Pct, 2),
        dscr: projection.metrics.dscrYear1 != null ? round(projection.metrics.dscrYear1, 2) : null,
        deltaMonthlyCashFlow: round(projection.metrics.monthlyCashFlowYear1 - baseline.metrics.monthlyCashFlowYear1),
        stillPositive: projection.metrics.monthlyCashFlowYear1 > 0,
      };
    })
    .filter(Boolean);

  return {
    baseline: {
      monthlyCashFlow: round(baseline.metrics.monthlyCashFlowYear1),
      cocPct: round(baseline.metrics.cocYear1Pct, 2),
      dscr: baseline.metrics.dscrYear1 != null ? round(baseline.metrics.dscrYear1, 2) : null,
    },
    rows,
    survivesAllAdverse: rows.find((r) => r.key === 'allAdverse')?.stillPositive ?? null,
  };
}

/**
 * Offer price solver: the maximum purchase price that still satisfies the
 * buy box (min monthly cash flow and/or min CoC). Binary search over price.
 */
export function solveOfferPrice(base, buyBox = {}, renovation = null) {
  const minMonthlyCashFlow = num(buyBox.minMonthlyCashFlow) ?? 100;
  const minCocPct = num(buyBox.minCocPct) ?? 6;

  const meetsBox = (price) => {
    let inputs = { ...base, purchasePrice: price };
    if (!Number.isFinite(base.closingCost)) {
      inputs.closingCost = price * ((base.closingCostPercent ?? 3) / 100);
    } else {
      // scale closing cost proportionally with price
      inputs.closingCost = base.closingCost * (price / base.purchasePrice);
    }
    if (renovation && num(renovation.repairCost) > 0) {
      inputs = {
        ...inputs,
        repairCost: num(renovation.repairCost),
        valueAfterRepairs: num(renovation.valueAfterRepairs),
        monthlyRent: num(renovation.monthlyRentAfter) || inputs.monthlyRent,
      };
    }
    const projection = buildProjection(inputs);
    return {
      ok: projection.metrics.monthlyCashFlowYear1 >= minMonthlyCashFlow
        && projection.metrics.cocYear1Pct >= minCocPct,
      projection,
    };
  };

  const askingPrice = num(base.purchasePrice);
  if (!askingPrice) return null;

  // Quick check: does asking price already meet the box?
  const atAsking = meetsBox(askingPrice);

  let low = askingPrice * 0.4;
  let high = askingPrice * (atAsking.ok ? 1.5 : 1.0);

  // If even the floor fails, no offer makes it work
  if (!meetsBox(low).ok) {
    return {
      meetsBoxAtAsking: atAsking.ok,
      maxOfferPrice: null,
      discountFromAskingPct: null,
      buyBox: { minMonthlyCashFlow, minCocPct },
      note: 'No realistic price meets the buy box with these assumptions.',
    };
  }

  for (let i = 0; i < 28; i += 1) {
    const mid = (low + high) / 2;
    if (meetsBox(mid).ok) low = mid;
    else high = mid;
  }

  const maxOffer = round(low / 1000) * 1000;
  return {
    meetsBoxAtAsking: atAsking.ok,
    maxOfferPrice: maxOffer,
    discountFromAskingPct: round(((askingPrice - maxOffer) / askingPrice) * 100, 1),
    buyBox: { minMonthlyCashFlow, minCocPct },
    atAskingMetrics: {
      monthlyCashFlow: round(atAsking.projection.metrics.monthlyCashFlowYear1),
      cocPct: round(atAsking.projection.metrics.cocYear1Pct, 2),
    },
  };
}
