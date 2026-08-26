/**
 * projections.js — single source of truth for acquisition financial math.
 *
 * Mirrors the Rental Property Calculator model (src/components/market/
 * RentalPropertyCalculatorModal.tsx) so server analyses and the calculator
 * produce identical numbers: amortization schedules, year-by-year projection
 * rows, IRR via Newton's-method NPV solve, CoC, cap rate, GRM, DSCR,
 * break-even occupancy, equity buildup, and sale proceeds.
 *
 * All functions are pure — no I/O.
 */

export function solveIRR(cashFlows) {
  let irr = 0.1;
  const maxIterations = 100;
  const tolerance = 1e-7;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let npv = 0;
    let dnpv = 0;

    for (let period = 0; period < cashFlows.length; period += 1) {
      const divisor = Math.pow(1 + irr, period);
      npv += cashFlows[period] / divisor;
      dnpv += (-period * cashFlows[period]) / Math.pow(1 + irr, period + 1);
    }

    if (!Number.isFinite(dnpv) || Math.abs(dnpv) < 1e-9) break;

    const nextIrr = irr - npv / dnpv;
    if (!Number.isFinite(nextIrr)) break;
    if (Math.abs(nextIrr - irr) < tolerance) return nextIrr * 100;
    irr = nextIrr;
  }

  return Number.isFinite(irr) ? irr * 100 : 0;
}

export function getMonthlyMortgagePayment(loanAmount, annualRatePercent, termMonths) {
  if (loanAmount <= 0 || termMonths <= 0) return 0;
  if (annualRatePercent <= 0) return loanAmount / termMonths;
  const monthlyRate = annualRatePercent / 100 / 12;
  return (monthlyRate * loanAmount) / (1 - Math.pow(1 + monthlyRate, -termMonths));
}

export function buildAnnualMortgageSchedule(loanAmount, annualRatePercent, termMonths, years) {
  const schedule = [];
  let balance = Math.max(loanAmount, 0);
  const monthlyPayment = getMonthlyMortgagePayment(loanAmount, annualRatePercent, termMonths);
  const monthlyRate = annualRatePercent / 100 / 12;
  const totalMonths = Math.max(termMonths, 0);

  for (let year = 0; year < years; year += 1) {
    let principalPaid = 0;
    let interestPaid = 0;

    for (let month = 0; month < 12; month += 1) {
      const absoluteMonth = year * 12 + month;
      if (absoluteMonth >= totalMonths || balance <= 0) break;

      if (annualRatePercent <= 0) {
        const principalPortion = Math.min(monthlyPayment, balance);
        principalPaid += principalPortion;
        balance -= principalPortion;
        continue;
      }

      const interestPortion = balance * monthlyRate;
      const principalPortion = Math.min(monthlyPayment - interestPortion, balance);
      interestPaid += interestPortion;
      principalPaid += principalPortion;
      balance = Math.max(balance - principalPortion, 0);
    }

    schedule.push({
      principalPaid: num(principalPaid),
      interestPaid: num(interestPaid),
      endingBalance: num(balance),
    });
  }

  return schedule;
}

/** Remaining loan balance after a number of months of payments. */
export function remainingBalanceAfterMonths(loanAmount, annualRatePercent, termMonths, monthsElapsed) {
  if (loanAmount <= 0 || termMonths <= 0) return 0;
  const monthlyRate = annualRatePercent / 100 / 12;
  const payment = getMonthlyMortgagePayment(loanAmount, annualRatePercent, termMonths);
  let balance = loanAmount;
  const months = Math.min(Math.max(Math.round(monthsElapsed), 0), termMonths);
  for (let m = 0; m < months && balance > 0; m += 1) {
    const interest = annualRatePercent <= 0 ? 0 : balance * monthlyRate;
    balance = Math.max(balance - (payment - interest), 0);
  }
  return num(balance);
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export const DEFAULT_ASSUMPTIONS = {
  useLoan: true,
  downPaymentPercent: 20,
  interestRate: 7,
  loanTermYears: 30,
  closingCostPercent: 3,
  refiAtYear: 2,
  refiLtvPercent: 75,
  refiRate: 7.25,
  refiLoanTermYears: 30,
  refiClosingCostPercent: 1.5,
  propertyTaxIncrease: 3,
  insuranceIncrease: 3,
  hoaIncrease: 3,
  maintenanceIncrease: 3,
  otherCostsIncrease: 3,
  monthlyRentIncrease: 3,
  otherMonthlyIncomeIncrease: 3,
  vacancyRate: 7,
  managementFee: 8,
  valueAppreciation: 3,
  holdingLengthYears: 10,
  costToSell: 7,
};

/**
 * Build a full multi-year projection from underwriting inputs.
 * Input model matches the Rental Property Calculator exactly:
 * {
 *   purchasePrice, useLoan, downPaymentPercent, interestRate, loanTermYears,
 *   closingCost, repairCost, valueAfterRepairs,
 *   propertyTax, propertyTaxIncrease, insurance, insuranceIncrease,
 *   hoaFee, hoaIncrease, maintenance, maintenanceIncrease,
 *   otherCosts, otherCostsIncrease,
 *   monthlyRent, monthlyRentIncrease, otherMonthlyIncome, otherMonthlyIncomeIncrease,
 *   vacancyRate, managementFee,
 *   valueAppreciation, holdingLengthYears, costToSell
 * }
 *
 * Optional refinance event: { refinance: { atYear, ltvPercent, interestRate, loanTermYears, closingCost } }
 * — models BRRRR: at end of `atYear`, old loan is paid off from a new loan at
 * ltvPercent of the then-current property value; cash-out goes back to the investor.
 */
export function buildProjection(rawInputs) {
  const inputs = { ...DEFAULT_ASSUMPTIONS, ...rawInputs };

  const holdingLength = Math.max(1, Math.round(inputs.holdingLengthYears || 0));
  const projectionYears = Math.max(30, holdingLength);
  const purchasePrice = num(inputs.purchasePrice);
  const repairCost = num(inputs.repairCost);
  const repairedValue = repairCost > 0
    ? Math.max(num(inputs.valueAfterRepairs), purchasePrice)
    : purchasePrice;
  const closingCost = Number.isFinite(inputs.closingCost)
    ? num(inputs.closingCost)
    : purchasePrice * (num(inputs.closingCostPercent) / 100);

  const useLoan = inputs.useLoan !== false;
  const loanAmount = useLoan
    ? purchasePrice * (1 - clamp(num(inputs.downPaymentPercent), 0, 100) / 100)
    : 0;
  const downPayment = useLoan ? purchasePrice - loanAmount : purchasePrice;
  const initialTermMonths = Math.round(num(inputs.loanTermYears) * 12) || 360;
  const monthlyMortgagePayment = useLoan
    ? getMonthlyMortgagePayment(loanAmount, inputs.interestRate, initialTermMonths)
    : 0;

  const refinance = rawInputs.refinance && rawInputs.refinance.atYear >= 1 ? {
    atYear: Math.round(rawInputs.refinance.atYear),
    ltvPercent: clamp(num(rawInputs.refinance.ltvPercent) || 75, 1, 100),
    interestRate: num(rawInputs.refinance.interestRate) || num(inputs.interestRate),
    loanTermYears: Math.round(num(rawInputs.refinance.loanTermYears) || 30),
    closingCostPercent: num(rawInputs.refinance.closingCostPercent) || 1.5,
  } : null;

  const initialInvestment = num(downPayment + closingCost + repairCost);
  const annualGrowthRate = num(inputs.valueAppreciation) / 100;

  // Pre-build initial loan schedule for full horizon
  let mortgageYears = useLoan
    ? buildAnnualMortgageSchedule(loanAmount, inputs.interestRate, initialTermMonths, projectionYears)
    : Array.from({ length: projectionYears }, () => ({ principalPaid: 0, interestPaid: 0, endingBalance: 0 }));

  let refiEvent = null;

  const projectionRows = [];
  const annualCashFlows = [];

  for (let year = 1; year <= projectionYears; year += 1) {
    const rentGrowthFactor = Math.pow(1 + num(inputs.monthlyRentIncrease) / 100, year - 1);
    const otherIncomeGrowthFactor = Math.pow(1 + num(inputs.otherMonthlyIncomeIncrease) / 100, year - 1);
    const annualRent = num(inputs.monthlyRent) * rentGrowthFactor * 12;
    const annualOtherIncome = num(inputs.otherMonthlyIncome) * otherIncomeGrowthFactor * 12;
    const grossPotentialIncome = annualRent + annualOtherIncome;
    const vacancyLoss = grossPotentialIncome * (num(inputs.vacancyRate) / 100);
    const annualIncome = grossPotentialIncome - vacancyLoss;

    const propertyTax = num(inputs.propertyTax) * Math.pow(1 + num(inputs.propertyTaxIncrease) / 100, year - 1);
    const insurance = num(inputs.insurance) * Math.pow(1 + num(inputs.insuranceIncrease) / 100, year - 1);
    const hoaFee = num(inputs.hoaFee) * Math.pow(1 + num(inputs.hoaIncrease) / 100, year - 1);
    const maintenance = num(inputs.maintenance) * Math.pow(1 + num(inputs.maintenanceIncrease) / 100, year - 1);
    const otherCosts = num(inputs.otherCosts) * Math.pow(1 + num(inputs.otherCostsIncrease) / 100, year - 1);
    const management = annualIncome * (num(inputs.managementFee) / 100);
    const operatingExpenses = propertyTax + insurance + hoaFee + maintenance + otherCosts + management;

    const scheduleRow = mortgageYears[year - 1] || { principalPaid: 0, interestPaid: 0, endingBalance: 0 };
    const mortgage = scheduleRow.principalPaid + scheduleRow.interestPaid;
    const netOperatingIncome = annualIncome - operatingExpenses;
    const operatingCashFlow = netOperatingIncome - mortgage;
    let cashFlow = operatingCashFlow;

    const propertyValue = repairedValue * Math.pow(1 + annualGrowthRate, year);
    let loanBalance = scheduleRow.endingBalance;

    // Refinance event at end of this year
    let refiCashOut = 0;
    if (refinance && year === refinance.atYear && useLoan) {
      const newLoanAmount = propertyValue * (refinance.ltvPercent / 100);
      const refiClosing = newLoanAmount * (refinance.closingCostPercent / 100);
      refiCashOut = Math.max(newLoanAmount - loanBalance - refiClosing, 0);
      cashFlow += refiCashOut;

      // Rebuild remaining years' schedule on the new loan
      const newTermMonths = refinance.loanTermYears * 12;
      const newSchedule = buildAnnualMortgageSchedule(newLoanAmount, refinance.interestRate, newTermMonths, projectionYears - year);
      for (let future = year; future < projectionYears; future += 1) {
        mortgageYears[future] = newSchedule[future - year] || { principalPaid: 0, interestPaid: 0, endingBalance: 0 };
      }
      loanBalance = newLoanAmount;
      refiEvent = {
        year,
        newLoanAmount: num(newLoanAmount),
        priorBalance: num(scheduleRow.endingBalance),
        closingCost: num(refiClosing),
        cashOut: num(refiCashOut),
        newMonthlyPayment: num(getMonthlyMortgagePayment(newLoanAmount, refinance.interestRate, newTermMonths)),
      };
    }

    annualCashFlows.push(cashFlow);

    const costToSellPct = num(inputs.costToSell) / 100;
    const cashToReceive = propertyValue - loanBalance - propertyValue * costToSellPct;

    // IRR if sold at end of this year (matches calculator semantics)
    const flowsThroughYear = annualCashFlows.slice(0, year);
    const irr = solveIRR([
      -initialInvestment,
      ...flowsThroughYear.slice(0, -1),
      (flowsThroughYear[flowsThroughYear.length - 1] || 0) + cashToReceive,
    ]);

    projectionRows.push({
      year,
      annualIncome: num(annualIncome),
      grossPotentialIncome: num(grossPotentialIncome),
      vacancyLoss: num(vacancyLoss),
      mortgage: num(mortgage),
      propertyTax: num(propertyTax),
      insurance: num(insurance),
      hoaFee: num(hoaFee),
      maintenance: num(maintenance),
      otherCosts: num(otherCosts),
      management: num(management),
      operatingExpenses: num(operatingExpenses),
      operatingCashFlow: num(operatingCashFlow),
      cashFlow: num(cashFlow),
      refiCashOut: num(refiCashOut),
      cashOnCashReturn: initialInvestment > 0 ? (operatingCashFlow / initialInvestment) * 100 : 0,
      equityAccumulated: num(propertyValue - loanBalance),
      cashToReceive: num(cashToReceive),
      irr: Number.isFinite(irr) ? irr : 0,
      netOperatingIncome: num(netOperatingIncome),
      propertyValue: num(propertyValue),
      loanBalance: num(loanBalance),
      capRatePct: propertyValue > 0 ? (netOperatingIncome / propertyValue) * 100 : 0,
      dscr: mortgage > 0 ? netOperatingIncome / mortgage : null,
    });
  }

  const holdingRows = projectionRows.slice(0, holdingLength);
  const firstYear = holdingRows[0];
  const finalYear = holdingRows[holdingRows.length - 1];
  const totalCashFlow = holdingRows.reduce((sum, row) => sum + row.cashFlow, 0);
  const totalOperatingCashFlow = holdingRows.reduce((sum, row) => sum + row.operatingCashFlow, 0);
  const totalProfitWhenSold = totalCashFlow + finalYear.cashToReceive - initialInvestment;
  const capRateBasis = repairCost > 0 ? repairedValue : purchasePrice;
  const firstYearGrossIncome = firstYear.grossPotentialIncome;
  const breakEvenOccupancy = firstYearGrossIncome > 0
    ? clamp(((firstYear.operatingExpenses + firstYear.mortgage) / firstYearGrossIncome) * 100, 0, 100)
    : 0;

  // BRRRR-specific: cash left in the deal after a refi (if modeled)
  const cashLeftInDeal = refiEvent
    ? Math.max(initialInvestment - refiEvent.cashOut, 0)
    : initialInvestment;
  const postRefiYearRow = refiEvent ? projectionRows[refiEvent.year] || null : null;

  return {
    inputs: {
      ...inputs,
      closingCost: num(closingCost),
      repairCost,
      repairedValue,
      refinance,
    },
    initialInvestment,
    purchaseBasis: purchasePrice,
    loanAmount: num(loanAmount),
    downPayment: num(downPayment),
    monthlyMortgagePayment: num(monthlyMortgagePayment),
    mortgageYears,
    refiEvent,
    cashLeftInDeal: num(cashLeftInDeal),
    projectionRows,
    holdingRows,
    metrics: {
      // Operating cash flow only — refi cash-out events are reported separately
      monthlyCashFlowYear1: num(firstYear.operatingCashFlow / 12),
      annualCashFlowYear1: num(firstYear.operatingCashFlow),
      noiYear1: num(firstYear.netOperatingIncome),
      capRatePct: capRateBasis > 0 ? num((firstYear.netOperatingIncome / capRateBasis) * 100) : 0,
      cocYear1Pct: initialInvestment > 0 ? num((firstYear.operatingCashFlow / initialInvestment) * 100) : 0,
      postRefiMonthlyCashFlow: postRefiYearRow ? num(postRefiYearRow.operatingCashFlow / 12) : null,
      postRefiCocPct: refiEvent && cashLeftInDeal > 0 && postRefiYearRow
        ? num((postRefiYearRow.operatingCashFlow / cashLeftInDeal) * 100)
        : (refiEvent && postRefiYearRow ? Infinity : null),
      monthlyDebtServiceYear1: num(firstYear.mortgage / 12),
      annualDebtServiceYear1: num(firstYear.mortgage),
      operatingExpensesYear1: num(firstYear.operatingExpenses),
      grossPotentialIncomeYear1: num(firstYear.grossPotentialIncome),
      dscrYear1: firstYear.mortgage > 0 ? num(firstYear.netOperatingIncome / firstYear.mortgage) : null,
      breakEvenOccupancyPct: num(breakEvenOccupancy),
      grm: firstYearGrossIncome > 0 ? num(purchasePrice / firstYearGrossIncome) : null,
      irrAtHold: num(finalYear.irr),
      irr5yr: projectionRows[4] ? num(projectionRows[4].irr) : null,
      irr10yr: projectionRows[9] ? num(projectionRows[9].irr) : null,
      totalProfitWhenSold: num(totalProfitWhenSold),
      totalCashFlowDuringHold: num(totalCashFlow),
      totalOperatingCashFlowDuringHold: num(totalOperatingCashFlow),
      equityAtHold: num(finalYear.equityAccumulated),
    },
  };
}

/**
 * Map a projection into the PropertyAnalyticsChartData shape consumed by
 * AdditionalAnalyticsChartsGrid (PropertyAnalyticsGraphs.tsx).
 */
export function projectionToChartData(projection, startYear = new Date().getFullYear()) {
  const rows = projection.projectionRows;
  const mortgageYears = projection.mortgageYears;
  const initialInvestment = projection.initialInvestment;

  const labels = rows.map((row) => `${startYear + row.year - 1}`);
  const totalReturnSeries = rows.map((row, index) => {
    const cumulativeCashFlow = rows.slice(0, index + 1).reduce((sum, entry) => sum + entry.cashFlow, 0);
    return (cumulativeCashFlow + row.cashToReceive - initialInvestment) / 1000;
  });

  return {
    projectionLabels: labels,
    mortgageLabels: labels,
    cashFlow: rows.map((row) => row.operatingCashFlow / 1000),
    annualIncome: {
      gross: rows.map((row) => row.grossPotentialIncome / 1000),
      collected: rows.map((row) => row.annualIncome / 1000),
    },
    incomeExpenses: {
      income: rows.map((row) => row.annualIncome / 1000),
      expenseBreakdown: {
        taxes: rows.map((row) => row.propertyTax / 1000),
        insurance: rows.map((row) => row.insurance / 1000),
        utilities: rows.map(() => 0),
        hoa: rows.map((row) => row.hoaFee / 1000),
        repairs: rows.map((row) => (row.maintenance + row.otherCosts) / 1000),
        management: rows.map((row) => row.management / 1000),
        debtService: rows.map((row) => row.mortgage / 1000),
      },
    },
    cocReturn: rows.map((row) => row.cashOnCashReturn),
    capRate: rows.map((row) => row.capRatePct),
    noi: rows.map((row) => row.netOperatingIncome / 1000),
    dscr: rows.map((row) => row.dscr ?? 0),
    mortgageAmortization: {
      principal: mortgageYears.map((row) => row.principalPaid / 1000),
      interest: mortgageYears.map((row) => row.interestPaid / 1000),
      loanBalance: mortgageYears.map((row) => row.endingBalance / 1000),
    },
    propertyAppreciation: {
      loan: rows.map((row) => row.loanBalance / 1000),
      equity: rows.map((row) => row.equityAccumulated / 1000),
      value: rows.map((row) => row.propertyValue / 1000),
    },
    totalReturn: { cumulative: totalReturnSeries },
    rollingIrr: rows.map((row) => row.irr),
    irr: projection.metrics.irrAtHold,
    breakEvenOccupancy: projection.metrics.breakEvenOccupancyPct,
    grm: projection.metrics.grm ?? 0,
  };
}
