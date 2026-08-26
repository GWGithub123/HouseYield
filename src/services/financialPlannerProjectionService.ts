import type {
  FinancialPlannerProjectionPoint,
  FinancialPlannerProjectionSummary,
  RetirementScenarioBigPurchase,
  RetirementScenarioPortfolioReallocation,
} from './aiFinancialPlannerService';

interface FinancialPlannerProjectionAsset {
  id?: string;
  name: string;
  value: number;
}

interface FinancialPlannerProjectionLiability {
  linkedAssetId?: string;
  name: string;
  balance: number;
}

interface FinancialPlannerPropertyPurchaseDetails {
  purchasePrice: number;
  downPaymentPercent: number;
  downPaymentSource: 'stocks' | 'bonds' | 'mixed';
  downPaymentMixStocks: number;
  interestRate: number;
  mortgageTerm: number;
  expectedRent: number;
  monthlyExpenses: number;
  expectedAppreciation: number;
}

export interface FinancialPlannerProjectionInput {
  yearsToProject: number;
  currentStockValue: number;
  currentBondValue: number;
  currentRealEstateValue: number;
  currentCashValue: number;
  currentAnnualDividendIncome: number;
  currentAnnualBondIncome: number;
  currentAnnualRentalIncome: number;
  monthlyCostOfLiving: number;
  spendingReduction: number;
  costOfLivingInflation: number;
  planPropertySale: boolean;
  propertySaleYear: number;
  realEstateAssets: FinancialPlannerProjectionAsset[];
  effectiveLiabilities: FinancialPlannerProjectionLiability[];
  propertySaleAllocation: { cash: number; stocks: number; bonds: number };
  planPropertyPurchase: boolean;
  propertyPurchaseYear: number;
  propertyPurchaseDetails: FinancialPlannerPropertyPurchaseDetails;
  taxAdvantaged: boolean;
  taxAdvantagedPercentage: number;
  effectiveTaxRate: number;
  plannedRetirementYear: number | null;
  retirementMonthlyContribution: number;
  expectedStockGrowth: number;
  retirementDRIP: boolean;
  expectedDividendYield: number;
  expectedBondYield: number;
  expectedPropertyAppreciation: number;
  expectedRentGrowth: number;
  expectedDividendGrowth: number;
  bigPurchases?: RetirementScenarioBigPurchase[];
  portfolioReallocation?: RetirementScenarioPortfolioReallocation;
}

export interface FinancialPlannerProjectionResult {
  points: FinancialPlannerProjectionPoint[];
  summary: FinancialPlannerProjectionSummary;
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const nextValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(nextValue) ? nextValue : fallback;
}

function normalizeScenarioFraction(value: unknown, fallback: number) {
  const nextValue = toFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(nextValue)) {
    return fallback;
  }
  return nextValue > 1 ? nextValue / 100 : nextValue;
}

function normalizeScenarioYear(value: unknown, currentYear: number) {
  const nextValue = toFiniteNumber(value, currentYear);
  if (nextValue >= 1900) {
    return Math.round(nextValue);
  }
  return currentYear + Math.max(0, Math.round(nextValue));
}

// Event years can arrive either as an absolute calendar year (e.g. 2036) or as
// an offset from today (e.g. 10). Always reduce to a non-negative offset.
function normalizeScenarioOffset(value: unknown, currentYear: number, fallback = 0) {
  const nextValue = toFiniteNumber(value, fallback);
  if (nextValue >= 1900) {
    return Math.max(0, Math.round(nextValue) - currentYear);
  }
  return Math.max(0, Math.round(nextValue));
}

export function buildFinancialPlannerProjection(
  input: FinancialPlannerProjectionInput,
): FinancialPlannerProjectionResult {
  const currentYear = new Date().getFullYear();
  const yearsToProject = Math.max(0, Math.round(toFiniteNumber(input.yearsToProject, 30)));
  const currentStockValue = toFiniteNumber(input.currentStockValue);
  const currentBondValue = toFiniteNumber(input.currentBondValue);
  const currentRealEstateValue = toFiniteNumber(input.currentRealEstateValue);
  const currentCashValue = toFiniteNumber(input.currentCashValue);
  const currentAnnualDividendIncome = toFiniteNumber(input.currentAnnualDividendIncome);
  const currentAnnualBondIncome = toFiniteNumber(input.currentAnnualBondIncome);
  const currentAnnualRentalIncome = toFiniteNumber(input.currentAnnualRentalIncome);
  const adjustedMonthlyCost = toFiniteNumber(input.monthlyCostOfLiving) * (1 - toFiniteNumber(input.spendingReduction));
  const normalizedPortfolioReallocation = input.portfolioReallocation
    ? {
        enabled: Boolean(input.portfolioReallocation.enabled),
        year: normalizeScenarioOffset(input.portfolioReallocation.year, currentYear),
        targetAssetName: typeof input.portfolioReallocation.targetAssetName === 'string' && input.portfolioReallocation.targetAssetName.trim()
          ? input.portfolioReallocation.targetAssetName.trim()
          : 'Income asset',
        targetTicker: typeof input.portfolioReallocation.targetTicker === 'string' && input.portfolioReallocation.targetTicker.trim()
          ? input.portfolioReallocation.targetTicker.trim().toUpperCase()
          : '',
        targetYield: normalizeScenarioFraction(input.portfolioReallocation.targetYield, toFiniteNumber(input.expectedDividendYield, 0.025)),
        targetGrowth: normalizeScenarioFraction(input.portfolioReallocation.targetGrowth, toFiniteNumber(input.expectedDividendGrowth, 0.06)),
        sellStocks: input.portfolioReallocation.sellStocks !== false,
        sellBonds: input.portfolioReallocation.sellBonds !== false,
        sellRealEstate: input.portfolioReallocation.sellRealEstate !== false,
        sellCash: input.portfolioReallocation.sellCash !== false,
      }
    : null;
  const normalizedBigPurchases = (input.bigPurchases || [])
    .map((purchase, index) => ({
      id: typeof purchase.id === 'string' && purchase.id.trim()
        ? purchase.id.trim()
        : `big-purchase-${index}`,
      year: normalizeScenarioYear(purchase.year, currentYear),
      amount: Math.max(0, toFiniteNumber(purchase.amount)),
      description: typeof purchase.description === 'string' && purchase.description.trim()
        ? purchase.description.trim()
        : 'Major purchase',
      ongoingMonthlyCost: purchase.ongoingMonthlyCost !== undefined
        ? Math.max(0, toFiniteNumber(purchase.ongoingMonthlyCost))
        : 0,
    }))
    .filter((purchase) => purchase.amount > 0 || purchase.ongoingMonthlyCost > 0)
    .sort((left, right) => left.year - right.year);

  let runningStockValue = currentStockValue;
  let runningBondValue = currentBondValue;
  let runningRealEstateValue = currentRealEstateValue;
  let runningCashValue = currentCashValue;
  let runningDividendIncome = currentAnnualDividendIncome;
  let runningBondIncome = currentAnnualBondIncome;
  let runningRentalIncome = currentAnnualRentalIncome;
  let runningPortfolioReallocationValue = 0;
  let runningPortfolioReallocationIncome = 0;
  let runningRecurringBigPurchaseCosts = 0;
  let fiYear: number | null = null;

  const points: FinancialPlannerProjectionPoint[] = [];

  const estimateRemainingRealEstateDebt = (yearsOfPayments: number) => {
    let totalDebt = 0;

    input.realEstateAssets.forEach((property) => {
      const matchingLiability = input.effectiveLiabilities.find((liability) => (
        (liability.linkedAssetId && property.id && liability.linkedAssetId === property.id)
        || (property.name && liability.name.toLowerCase().includes(property.name.toLowerCase().split(',')[0]))
      ));

      if (matchingLiability) {
        const originalBalance = toFiniteNumber(matchingLiability.balance);
        const estimatedPaydown = originalBalance * 0.02 * yearsOfPayments;
        totalDebt += Math.max(0, originalBalance - estimatedPaydown);
      }
    });

    return totalDebt;
  };

  const spendFromLiquidAssets = (amount: number) => {
    let remaining = Math.max(0, amount);

    const cashDraw = Math.min(runningCashValue, remaining);
    runningCashValue -= cashDraw;
    remaining -= cashDraw;

    const bondDraw = Math.min(runningBondValue, remaining);
    if (bondDraw > 0) {
      const previousBondValue = runningBondValue;
      runningBondValue -= bondDraw;
      runningBondIncome = previousBondValue > 0
        ? runningBondIncome * (runningBondValue / previousBondValue)
        : 0;
      remaining -= bondDraw;
    }

    const stockDraw = Math.min(runningStockValue, remaining);
    if (stockDraw > 0) {
      const previousStockValue = runningStockValue;
      runningStockValue -= stockDraw;
      runningDividendIncome = previousStockValue > 0
        ? runningDividendIncome * (runningStockValue / previousStockValue)
        : 0;
      remaining -= stockDraw;
    }

    const reallocationDraw = Math.min(runningPortfolioReallocationValue, remaining);
    if (reallocationDraw > 0) {
      runningPortfolioReallocationValue -= reallocationDraw;
      runningPortfolioReallocationIncome = normalizedPortfolioReallocation
        ? runningPortfolioReallocationValue * normalizedPortfolioReallocation.targetYield
        : 0;
      remaining -= reallocationDraw;
    }

    if (remaining > 0) {
      runningCashValue -= remaining;
    }
  };

  for (let i = 0; i <= yearsToProject; i += 1) {
    const year = currentYear + i;
    const baseAnnualCostOfLiving = adjustedMonthlyCost * 12 * Math.pow(1 + toFiniteNumber(input.costOfLivingInflation, 0.03), i);

    if (input.planPropertySale && i === normalizeScenarioOffset(input.propertySaleYear, currentYear)) {
      const saleEquity = Math.max(0, runningRealEstateValue - estimateRemainingRealEstateDebt(i));
      const cashAllocation = saleEquity * (toFiniteNumber(input.propertySaleAllocation.cash) / 100);
      const stockAllocation = saleEquity * (toFiniteNumber(input.propertySaleAllocation.stocks) / 100);
      const bondAllocation = saleEquity * (toFiniteNumber(input.propertySaleAllocation.bonds) / 100);

      runningCashValue += cashAllocation;
      runningStockValue += stockAllocation;
      runningBondValue += bondAllocation;
      runningRealEstateValue = 0;
      runningRentalIncome = 0;
      runningDividendIncome += stockAllocation * toFiniteNumber(input.expectedDividendYield, 0.025);
      runningBondIncome += bondAllocation * toFiniteNumber(input.expectedBondYield, 0.045);
    }

    if (input.planPropertyPurchase && i === normalizeScenarioOffset(input.propertyPurchaseYear, currentYear)) {
      const purchasePrice = toFiniteNumber(input.propertyPurchaseDetails.purchasePrice);
      const downPayment = purchasePrice * (toFiniteNumber(input.propertyPurchaseDetails.downPaymentPercent) / 100);
      const loanAmount = purchasePrice - downPayment;
      const monthlyRate = toFiniteNumber(input.propertyPurchaseDetails.interestRate) / 100 / 12;
      const numPayments = Math.max(1, toFiniteNumber(input.propertyPurchaseDetails.mortgageTerm, 30) * 12);
      const monthlyMortgage = monthlyRate > 0
        ? loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1)
        : loanAmount / numPayments;

      if (input.propertyPurchaseDetails.downPaymentSource === 'stocks') {
        runningStockValue -= downPayment;
        const lostYield = downPayment / Math.max(1, runningStockValue + downPayment) * runningDividendIncome;
        runningDividendIncome -= lostYield;
      } else if (input.propertyPurchaseDetails.downPaymentSource === 'bonds') {
        runningBondValue -= downPayment;
        const lostYield = downPayment / Math.max(1, runningBondValue + downPayment) * runningBondIncome;
        runningBondIncome -= lostYield;
      } else {
        const stockPortion = downPayment * (toFiniteNumber(input.propertyPurchaseDetails.downPaymentMixStocks) / 100);
        const bondPortion = downPayment - stockPortion;
        runningStockValue -= stockPortion;
        runningBondValue -= bondPortion;
        const lostDivYield = runningStockValue > 0 ? stockPortion / (runningStockValue + stockPortion) * runningDividendIncome : 0;
        const lostBondYield = runningBondValue > 0 ? bondPortion / (runningBondValue + bondPortion) * runningBondIncome : 0;
        runningDividendIncome -= lostDivYield;
        runningBondIncome -= lostBondYield;
      }

      runningRealEstateValue += purchasePrice;
      const totalMonthlyExpenses = monthlyMortgage + toFiniteNumber(input.propertyPurchaseDetails.monthlyExpenses);
      const monthlyCashFlow = toFiniteNumber(input.propertyPurchaseDetails.expectedRent) - totalMonthlyExpenses;
      runningRentalIncome += monthlyCashFlow * 12;
    }

    if (normalizedPortfolioReallocation?.enabled && i === normalizedPortfolioReallocation.year) {
      const reallocatedRealEstateCapital = normalizedPortfolioReallocation.sellRealEstate
        ? Math.max(0, runningRealEstateValue - estimateRemainingRealEstateDebt(i))
        : 0;
      const reallocatedCapital =
        (normalizedPortfolioReallocation.sellStocks ? runningStockValue : 0)
        + (normalizedPortfolioReallocation.sellBonds ? runningBondValue : 0)
        + (normalizedPortfolioReallocation.sellCash ? runningCashValue : 0)
        + reallocatedRealEstateCapital;

      if (reallocatedCapital > 0) {
        if (normalizedPortfolioReallocation.sellStocks) {
          runningStockValue = 0;
          runningDividendIncome = 0;
        }
        if (normalizedPortfolioReallocation.sellBonds) {
          runningBondValue = 0;
          runningBondIncome = 0;
        }
        if (normalizedPortfolioReallocation.sellCash) {
          runningCashValue = 0;
        }
        if (normalizedPortfolioReallocation.sellRealEstate) {
          runningRealEstateValue = 0;
          runningRentalIncome = 0;
        }

        runningPortfolioReallocationValue += reallocatedCapital;
        runningPortfolioReallocationIncome = runningPortfolioReallocationValue * normalizedPortfolioReallocation.targetYield;
      }
    }

    const bigPurchasesThisYear = normalizedBigPurchases.filter((purchase) => purchase.year === year);
    let annualOneTimeBigPurchaseCost = 0;
    bigPurchasesThisYear.forEach((purchase) => {
      annualOneTimeBigPurchaseCost += purchase.amount;
      if (purchase.amount > 0) {
        spendFromLiquidAssets(purchase.amount);
      }
      if (purchase.ongoingMonthlyCost > 0) {
        runningRecurringBigPurchaseCosts += purchase.ongoingMonthlyCost * 12;
      }
    });

    const annualCostOfLiving = baseAnnualCostOfLiving + runningRecurringBigPurchaseCosts + annualOneTimeBigPurchaseCost;

    const dividendLikeIncome = runningDividendIncome + runningPortfolioReallocationIncome;
    const investmentIncome = dividendLikeIncome + runningBondIncome + runningRentalIncome;
    let afterTaxIncome = investmentIncome;

    if (input.taxAdvantaged) {
      const taxablePortionDividends = (dividendLikeIncome + runningBondIncome) * (1 - toFiniteNumber(input.taxAdvantagedPercentage) / 100);
      const taxFreePortionDividends = (dividendLikeIncome + runningBondIncome) * (toFiniteNumber(input.taxAdvantagedPercentage) / 100);
      afterTaxIncome = taxFreePortionDividends + taxablePortionDividends * (1 - toFiniteNumber(input.effectiveTaxRate, 0.22)) + runningRentalIncome * 0.85;
    } else {
      afterTaxIncome = (dividendLikeIncome + runningBondIncome) * (1 - toFiniteNumber(input.effectiveTaxRate, 0.22) * 0.5) + runningRentalIncome * 0.85;
    }

    const surplus = afterTaxIncome - annualCostOfLiving;
    const canRetire = afterTaxIncome >= annualCostOfLiving;

    if (canRetire && fiYear === null) {
      fiYear = year;
    }

    points.push({
      year,
      yearsFromNow: i,
      costOfLiving: annualCostOfLiving,
      investmentIncome: afterTaxIncome,
      accountValue: runningStockValue + runningBondValue + runningRealEstateValue + runningCashValue + runningPortfolioReallocationValue,
      surplus,
      canRetire,
    });

    if (i < yearsToProject) {
      const nextYear = currentYear + i + 1;
      const willBeRetired = input.plannedRetirementYear !== null && nextYear >= input.plannedRetirementYear;
      const portfolioReallocationActive = Boolean(normalizedPortfolioReallocation?.enabled && i >= normalizedPortfolioReallocation.year);

      runningStockValue *= (1 + toFiniteNumber(input.expectedStockGrowth, 0.07));
      if (input.retirementDRIP && !willBeRetired) {
        runningStockValue += runningDividendIncome;
      }
      if (!willBeRetired && !portfolioReallocationActive) {
        runningStockValue += toFiniteNumber(input.retirementMonthlyContribution) * 12 * 0.7;
      }

      runningBondValue *= (1 + toFiniteNumber(input.expectedBondYield, 0.045) * 0.3);
      if (input.retirementDRIP && !willBeRetired) {
        runningBondValue += runningBondIncome;
      }
      if (!willBeRetired && !portfolioReallocationActive) {
        runningBondValue += toFiniteNumber(input.retirementMonthlyContribution) * 12 * 0.3;
      }

      if (portfolioReallocationActive && normalizedPortfolioReallocation) {
        runningPortfolioReallocationValue *= (1 + normalizedPortfolioReallocation.targetGrowth);
        if (input.retirementDRIP && !willBeRetired) {
          runningPortfolioReallocationValue += runningPortfolioReallocationIncome;
        }
        if (!willBeRetired) {
          runningPortfolioReallocationValue += toFiniteNumber(input.retirementMonthlyContribution) * 12;
        }
        runningPortfolioReallocationIncome = runningPortfolioReallocationValue * normalizedPortfolioReallocation.targetYield;
      }

      if (runningRealEstateValue > 0) {
        const boughtNewProperty = input.planPropertyPurchase && i >= normalizeScenarioOffset(input.propertyPurchaseYear, currentYear);
        const appreciationRate = boughtNewProperty
          ? (toFiniteNumber(input.propertyPurchaseDetails.expectedAppreciation, 3.5) / 100)
          : toFiniteNumber(input.expectedPropertyAppreciation, 0.035);
        runningRealEstateValue *= (1 + appreciationRate);
        runningRentalIncome *= (1 + toFiniteNumber(input.expectedRentGrowth, 0.03));
      }

      runningDividendIncome *= (1 + toFiniteNumber(input.expectedDividendGrowth, 0.06));

      if (input.retirementDRIP && !willBeRetired && runningStockValue > 0 && currentStockValue > 0) {
        const originalYield = currentAnnualDividendIncome / currentStockValue;
        const dripSharesValue = runningStockValue - (currentStockValue * Math.pow(1 + toFiniteNumber(input.expectedStockGrowth, 0.07), i + 1) + toFiniteNumber(input.retirementMonthlyContribution) * 12 * 0.7 * (i + 1));
        if (dripSharesValue > 0) {
          runningDividendIncome += dripSharesValue * originalYield * Math.pow(1 + toFiniteNumber(input.expectedDividendGrowth, 0.06), i + 1) * 0.1;
        }
      }

      runningBondIncome = runningBondValue * toFiniteNumber(input.expectedBondYield, 0.045);
    }
  }

  const currentPoint = points[0] || null;
  const plannedRetirementPoint = input.plannedRetirementYear !== null
    ? points.find((point) => point.year === input.plannedRetirementYear) || null
    : null;

  return {
    points,
    summary: {
      currentYear,
      projectionYears: yearsToProject,
      fiYear,
      currentAnnualCostOfLiving: currentPoint?.costOfLiving || 0,
      currentAnnualInvestmentIncome: currentPoint?.investmentIncome || 0,
      currentAnnualSurplus: currentPoint?.surplus || 0,
      plannedRetirementYear: input.plannedRetirementYear,
      plannedRetirementIncome: plannedRetirementPoint?.investmentIncome ?? null,
      plannedRetirementCostOfLiving: plannedRetirementPoint?.costOfLiving ?? null,
      plannedRetirementSurplus: plannedRetirementPoint?.surplus ?? null,
    },
  };
}