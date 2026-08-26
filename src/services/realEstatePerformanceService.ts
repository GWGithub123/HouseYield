/**
 * Real Estate Performance Service
 * 
 * Calculates historical IRR and performance metrics for real estate holdings
 * to enable comparison with stock portfolio and market indices.
 */

import { AVMHistory } from '../types/attom';

// ============================================================================
// Types
// ============================================================================

export interface RealEstateHolding {
  id: string;
  address: string;
  purchasePrice: number;
  purchaseDate: string;
  currentValue: number;
  downPayment: number;
  loanAmount: number; // Current loan balance
  originalLoanAmount?: number; // Original loan amount from portfolio
  interestRate: number;
  monthlyRent: number;
  monthlyExpenses: number; // Insurance, taxes, maintenance, etc.
  monthlyPayment?: number; // Actual monthly payment from portfolio
  avmHistory?: AVMHistory[];
  // Tenant payment history if available
  rentPayments?: { date: string; amount: number }[];
  operatingHistory?: RealEstateOperatingSnapshot[];
  operatingSummary?: RealEstateOperatingSummary | null;
}

export interface RealEstateOperatingSnapshot {
  date: string;
  revenue: number;
  expenses: number;
  netCashFlow: number;
  margin: number | null;
}

export interface RealEstateOperatingSummary {
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  margin: number | null;
}

export interface RealEstatePerformanceData {
  dates: string[];
  values: number[]; // Normalized to 100 at start (like stocks)
  returns: { date: string; percentChange: number }[];
  totalReturn: number;
  annualizedReturn: number;
  totalCashFlow: number;
  totalAppreciation: number;
  dataSource: 'modeled' | 'bookkeeping';
  bookkeepingPropertiesCovered: number;
  bookkeepingMonthsCovered: number;
  operatingSummary: {
    totalIncome: number;
    totalExpenses: number;
    netIncome: number;
    margin: number | null;
    latestIncome: number;
    latestExpenses: number;
    latestNetIncome: number;
    latestMargin: number | null;
  };
}

export type RealEstateReturnMode = 'appreciation-only' | 'with-income';

export const REAL_ESTATE_RETURN_MODES = [
  { key: 'appreciation-only', label: 'Equity Growth', description: 'Levered equity growth from appreciation and principal paydown, excluding rent' },
  { key: 'with-income', label: 'Ops + Appreciation', description: 'Levered return from equity growth plus month-to-month operating cash flow, using bookkeeping when available' },
] as const;

export type AssetMode = 'stocks-only' | 'real-estate-only' | 'combined';

export const ASSET_MODES = [
  { key: 'stocks-only', label: 'Stocks Only', icon: '📈', description: 'Compare only stock portfolio performance' },
  { key: 'real-estate-only', label: 'Real Estate Only', icon: '🏠', description: 'Compare only real estate holdings' },
  { key: 'combined', label: 'Combined Portfolio', icon: '💼', description: 'Compare stocks and real estate together' },
] as const;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate monthly mortgage payment
 */
function calculateMonthlyPayment(principal: number, annualRate: number, termYears: number = 30): number {
  if (principal <= 0 || annualRate <= 0) return 0;
  
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = termYears * 12;
  
  if (monthlyRate === 0) return principal / numPayments;
  
  return (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / 
         (Math.pow(1 + monthlyRate, numPayments) - 1);
}

/**
 * Calculate remaining loan balance at a given month
 */
function calculateRemainingBalance(
  principal: number,
  annualRate: number,
  termYears: number,
  monthsElapsed: number
): number {
  if (principal <= 0) return 0;
  if (monthsElapsed <= 0) return principal;
  
  const monthlyRate = annualRate / 100 / 12;
  const monthlyPayment = calculateMonthlyPayment(principal, annualRate, termYears);
  
  if (monthlyRate === 0) {
    return principal - (monthlyPayment * monthsElapsed);
  }
  
  // Calculate remaining balance using amortization formula
  const balance = principal * Math.pow(1 + monthlyRate, monthsElapsed) -
                  monthlyPayment * ((Math.pow(1 + monthlyRate, monthsElapsed) - 1) / monthlyRate);
  
  return Math.max(balance, 0);
}

/**
 * Calculate cumulative principal paid at a given month
 * @internal Reserved for future use
 */
function _calculateCumulativePrincipalPaid(
  principal: number,
  annualRate: number,
  termYears: number,
  monthsElapsed: number
): number {
  const remainingBalance = calculateRemainingBalance(principal, annualRate, termYears, monthsElapsed);
  return principal - remainingBalance;
}

/**
 * Calculate monthly cash flow (rent - expenses - mortgage payment)
 */
function calculateMonthlyCashFlow(
  monthlyRent: number,
  monthlyExpenses: number,
  monthlyMortgage: number
): number {
  return monthlyRent - monthlyExpenses - monthlyMortgage;
}

function hasOperatingActivity(snapshot: RealEstateOperatingSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return Math.abs(snapshot.revenue || 0) > 0.005
    || Math.abs(snapshot.expenses || 0) > 0.005
    || Math.abs(snapshot.netCashFlow || 0) > 0.005;
}

function findLatestOperatingSnapshot(
  operatingHistory: RealEstateOperatingSnapshot[]
): RealEstateOperatingSnapshot | null {
  for (let index = operatingHistory.length - 1; index >= 0; index -= 1) {
    const snapshot = operatingHistory[index];
    if (hasOperatingActivity(snapshot)) {
      return snapshot;
    }
  }

  return operatingHistory[operatingHistory.length - 1] || null;
}

function buildOperatingSummary(
  operatingHistory: RealEstateOperatingSnapshot[],
  fallbackSummary: RealEstateOperatingSummary | null | undefined
): RealEstatePerformanceData['operatingSummary'] {
  const latestSnapshot = findLatestOperatingSnapshot(operatingHistory);
  const historyIncome = operatingHistory.reduce((sum, snapshot) => sum + (snapshot.revenue || 0), 0);
  const historyExpenses = operatingHistory.reduce((sum, snapshot) => sum + (snapshot.expenses || 0), 0);
  const historyNetIncome = operatingHistory.reduce((sum, snapshot) => sum + (snapshot.netCashFlow || 0), 0);

  const totalIncome = fallbackSummary && Math.abs(fallbackSummary.totalIncome || 0) > 0.005
    ? fallbackSummary.totalIncome
    : historyIncome;
  const totalExpenses = fallbackSummary && Math.abs(fallbackSummary.totalExpenses || 0) > 0.005
    ? fallbackSummary.totalExpenses
    : historyExpenses;
  const netIncome = fallbackSummary && (Math.abs(fallbackSummary.netIncome || 0) > 0.005 || Math.abs(fallbackSummary.totalIncome || 0) > 0.005 || Math.abs(fallbackSummary.totalExpenses || 0) > 0.005)
    ? fallbackSummary.netIncome
    : historyNetIncome;
  const margin = typeof fallbackSummary?.margin === 'number'
    ? fallbackSummary.margin
    : totalIncome > 0
      ? (netIncome / totalIncome) * 100
      : null;

  return {
    totalIncome,
    totalExpenses,
    netIncome,
    margin,
    latestIncome: latestSnapshot?.revenue || 0,
    latestExpenses: latestSnapshot?.expenses || 0,
    latestNetIncome: latestSnapshot?.netCashFlow || 0,
    latestMargin: latestSnapshot?.margin ?? null,
  };
}

/**
 * Interpolate property value from AVM history at a specific date
 */
function interpolatePropertyValue(
  avmHistory: AVMHistory[],
  targetDate: Date,
  fallbackValue: number
): number {
  if (!avmHistory || avmHistory.length === 0) return fallbackValue;
  
  // Sort by date
  const sortedHistory = [...avmHistory].sort((a, b) => 
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  
  const targetTime = targetDate.getTime();
  
  // Find surrounding data points
  let beforePoint: AVMHistory | null = null;
  let afterPoint: AVMHistory | null = null;
  
  for (const point of sortedHistory) {
    const pointTime = new Date(point.date).getTime();
    if (pointTime <= targetTime) {
      beforePoint = point;
    } else if (!afterPoint) {
      afterPoint = point;
    }
  }
  
  // If target date is before all data, use first value
  if (!beforePoint) {
    return sortedHistory[0].value || fallbackValue;
  }
  
  // If target date is after all data, use last value
  if (!afterPoint) {
    return beforePoint.value || fallbackValue;
  }
  
  // Linear interpolation between two points
  const beforeTime = new Date(beforePoint.date).getTime();
  const afterTime = new Date(afterPoint.date).getTime();
  const beforeValue = beforePoint.value || fallbackValue;
  const afterValue = afterPoint.value || fallbackValue;
  
  const ratio = (targetTime - beforeTime) / (afterTime - beforeTime);
  return beforeValue + (afterValue - beforeValue) * ratio;
}

/**
 * Align a lower-frequency return series to target dates using linear interpolation.
 */
export function alignReturnSeriesToDates(
  sourceReturns: { date: string; percentChange: number }[],
  targetDates: string[]
): { date: string; percentChange: number }[] {
  if (sourceReturns.length === 0 || targetDates.length === 0) return [];

  const sortedSource = [...sourceReturns].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  const firstSource = sortedSource[0];
  const lastSource = sortedSource[sortedSource.length - 1];
  let cursor = 0;

  return targetDates.map((date) => {
    const targetTime = new Date(date).getTime();

    if (targetTime <= new Date(firstSource.date).getTime()) {
      return { date, percentChange: firstSource.percentChange };
    }

    if (targetTime >= new Date(lastSource.date).getTime()) {
      return { date, percentChange: lastSource.percentChange };
    }

    while (
      cursor < sortedSource.length - 2 &&
      new Date(sortedSource[cursor + 1].date).getTime() < targetTime
    ) {
      cursor += 1;
    }

    const beforePoint = sortedSource[cursor];
    const afterPoint = sortedSource[cursor + 1];
    const beforeTime = new Date(beforePoint.date).getTime();
    const afterTime = new Date(afterPoint.date).getTime();

    if (afterTime <= beforeTime) {
      return { date, percentChange: beforePoint.percentChange };
    }

    const ratio = (targetTime - beforeTime) / (afterTime - beforeTime);
    return {
      date,
      percentChange: beforePoint.percentChange + (afterPoint.percentChange - beforePoint.percentChange) * ratio,
    };
  });
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Average national housing appreciation rate (annual) - used for theoretical analysis
 * Historical average is about 3-5% per year, we use 4% as a conservative estimate
 */
const DEFAULT_ANNUAL_APPRECIATION_RATE = 0.04;

/**
 * Calculate real estate performance for a single property
 * This is a THEORETICAL analysis showing how the current property would have performed
 * if held for the entire selected time period - similar to stocks "Current Holdings" mode.
 */
export function calculatePropertyPerformance(
  holding: RealEstateHolding,
  returnMode: RealEstateReturnMode,
  periodMonths: number = 12
): RealEstatePerformanceData | null {
  // For theoretical analysis, we always calculate the full period
  // regardless of when the property was actually purchased
  const monthsToCalculate = periodMonths;
  
  const dates: string[] = [];
  const values: number[] = [];
  const returns: { date: string; percentChange: number }[] = [];
  
  // Calculate monthly mortgage payment
  const monthlyMortgage = (holding.monthlyPayment && holding.monthlyPayment > 0)
    ? holding.monthlyPayment
    : calculateMonthlyPayment(
        holding.loanAmount,
        holding.interestRate,
        30 // Assume 30-year term
      );

  const normalizedOperatingHistory = (holding.operatingHistory || [])
    .filter((snapshot) => Boolean(snapshot?.date))
    .slice()
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
  const operatingByMonth = new Map<string, RealEstateOperatingSnapshot>();
  normalizedOperatingHistory.forEach((snapshot) => {
    operatingByMonth.set(String(snapshot.date).slice(0, 7), snapshot);
  });
  const bookkeepingMonthsCovered = normalizedOperatingHistory.filter((snapshot) => hasOperatingActivity(snapshot)).length;
  const dataSource: RealEstatePerformanceData['dataSource'] = bookkeepingMonthsCovered > 0 ? 'bookkeeping' : 'modeled';
  const operatingSummary = buildOperatingSummary(normalizedOperatingHistory, holding.operatingSummary);
  
  // Current equity is used as the "end point" for our theoretical analysis
  const currentEquity = holding.currentValue - (holding.loanAmount || 0);
  
  // Start date for calculation (going back from today)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsToCalculate);
  
  // Calculate property value at start of period
  // Use AVM history if available, otherwise estimate using appreciation rate
  let startPropertyValue: number;
  
  if (holding.avmHistory && holding.avmHistory.length > 0) {
    startPropertyValue = interpolatePropertyValue(holding.avmHistory, startDate, holding.currentValue);
  } else {
    // Estimate start value by reverse-compounding current value
    // If current value is V and appreciation is r per month, start value = V / (1 + r)^months
    const monthlyAppreciation = Math.pow(1 + DEFAULT_ANNUAL_APPRECIATION_RATE, 1/12) - 1;
    startPropertyValue = holding.currentValue / Math.pow(1 + monthlyAppreciation, monthsToCalculate);
  }
  
  // Calculate initial loan balance at start of theoretical period
  // We assume the current loan balance would have been higher at the start
  // Loan balance grows backwards: we need to find what balance would amortize to current balance
  const currentLoanBalance = holding.loanAmount || 0;
  
  // Estimate initial loan balance by working backwards
  // This is approximate - we add back the principal that would have been paid
  let estimatedInitialLoanBalance = currentLoanBalance;
  if (currentLoanBalance > 0 && holding.interestRate > 0) {
    const monthlyRate = holding.interestRate / 100 / 12;
    // For each month, the principal paid is: monthlyPayment - (balance * monthlyRate)
    // Work backwards to estimate initial balance
    let balance = currentLoanBalance;
    for (let i = 0; i < monthsToCalculate; i++) {
      const interestPortion = balance * monthlyRate;
      const principalPortion = monthlyMortgage - interestPortion;
      balance += principalPortion; // Add back the principal that would have been paid
    }
    estimatedInitialLoanBalance = balance;
  }
  
  // Initial equity at start of period
  const initialEquity = startPropertyValue - estimatedInitialLoanBalance;
  
  // Use initial equity as the "initial investment" for return calculations
  // This represents what your equity position was at the start of the period
  const initialInvestment = Math.max(initialEquity, holding.currentValue * 0.2); // At least 20% as a floor
  
  let cumulativeCashFlow = 0;
  
  for (let month = 0; month <= monthsToCalculate; month++) {
    const currentDate = new Date(startDate);
    currentDate.setMonth(currentDate.getMonth() + month);
    
    // Format date as YYYY-MM-DD
    const dateStr = currentDate.toISOString().split('T')[0];
    
    // Get property value at this date
    let propertyValue: number;
    if (holding.avmHistory && holding.avmHistory.length > 0) {
      propertyValue = interpolatePropertyValue(holding.avmHistory, currentDate, holding.currentValue);
    } else {
      // Interpolate using constant appreciation rate
      const monthlyAppreciation = Math.pow(1 + DEFAULT_ANNUAL_APPRECIATION_RATE, 1/12) - 1;
      propertyValue = startPropertyValue * Math.pow(1 + monthlyAppreciation, month);
    }
    
    // Calculate loan balance at this point (amortizing from estimated initial)
    const loanBalance = calculateRemainingBalance(
      estimatedInitialLoanBalance,
      holding.interestRate,
      30,
      month
    );
    const priorLoanBalance = month > 0
      ? calculateRemainingBalance(
          estimatedInitialLoanBalance,
          holding.interestRate,
          30,
          month - 1
        )
      : loanBalance;
    const principalPaidThisMonth = Math.max(priorLoanBalance - loanBalance, 0);
    
    // Current equity = property value - loan balance
    const currentEquityAtMonth = propertyValue - loanBalance;
    
    // Monthly cash flow (if including income)
    if (returnMode === 'with-income' && month > 0) {
      const operatingSnapshot = operatingByMonth.get(dateStr.slice(0, 7));
      const monthlyCashFlow = operatingSnapshot
        ? operatingSnapshot.netCashFlow - principalPaidThisMonth
        : calculateMonthlyCashFlow(
            holding.monthlyRent,
            holding.monthlyExpenses,
            monthlyMortgage
          );
      cumulativeCashFlow += monthlyCashFlow;
    }
    
    // Total value = equity + cumulative cash flow received
    let totalValue = currentEquityAtMonth;
    if (returnMode === 'with-income') {
      totalValue += cumulativeCashFlow;
    }
    
    dates.push(dateStr);
    values.push(totalValue);
    
    // Calculate percentage change from initial equity
    const percentChange = initialInvestment > 0 
      ? ((totalValue - initialInvestment) / initialInvestment) * 100
      : 0;
    
    returns.push({ date: dateStr, percentChange });
  }
  
  if (values.length < 2) {
    return null;
  }
  
  // Calculate total returns
  const firstValue = values[0];
  const lastValue = values[values.length - 1];
  const totalReturn = firstValue > 0 ? ((lastValue - firstValue) / firstValue) * 100 : 0;
  
  // Calculate annualized return (CAGR)
  const years = monthsToCalculate / 12;
  const annualizedReturn = years > 0 && firstValue > 0
    ? (Math.pow(lastValue / firstValue, 1 / years) - 1) * 100
    : 0;
  
  // Get appreciation separately - reuse startPropertyValue calculated above
  const endPropertyValue = holding.currentValue;
  const totalAppreciation = startPropertyValue > 0 
    ? ((endPropertyValue - startPropertyValue) / startPropertyValue) * 100 
    : 0;
  
  return {
    dates,
    values,
    returns,
    totalReturn,
    annualizedReturn,
    totalCashFlow: cumulativeCashFlow,
    totalAppreciation,
    dataSource,
    bookkeepingPropertiesCovered: bookkeepingMonthsCovered > 0 ? 1 : 0,
    bookkeepingMonthsCovered,
    operatingSummary,
  };
}

/**
 * Calculate weighted performance for multiple real estate holdings
 */
export function calculateRealEstatePortfolioPerformance(
  holdings: RealEstateHolding[],
  returnMode: RealEstateReturnMode,
  periodMonths: number = 12
): RealEstatePerformanceData | null {
  if (holdings.length === 0) return null;
  
  // Calculate performance for each holding
  const holdingPerformances = holdings
    .map(h => ({
      holding: h,
      performance: calculatePropertyPerformance(h, returnMode, periodMonths),
      equity: h.currentValue - (h.loanAmount || 0), // Use current equity as weight
    }))
    .filter(hp => hp.performance !== null);
  
  if (holdingPerformances.length === 0) return null;
  
  // Calculate total equity for weighting
  const totalEquity = holdingPerformances.reduce((sum, hp) => sum + hp.equity, 0);
  
  if (totalEquity <= 0) return null;
  
  // Find common dates (intersection of all date arrays)
  const dateSets = holdingPerformances.map(hp => new Set(hp.performance!.dates));
  let commonDates = Array.from(dateSets[0]);
  for (let i = 1; i < dateSets.length; i++) {
    commonDates = commonDates.filter(date => dateSets[i].has(date));
  }
  commonDates.sort();
  
  if (commonDates.length === 0) {
    // If no common dates, use the first property's dates
    commonDates = holdingPerformances[0].performance!.dates;
  }
  
  // Create lookup maps for each holding's returns
  const returnMaps = holdingPerformances.map(hp => {
    const map = new Map<string, number>();
    hp.performance!.returns.forEach(r => map.set(r.date, r.percentChange));
    return { map, weight: hp.equity / totalEquity };
  });
  
  // Calculate weighted portfolio returns for each date
  const returns: { date: string; percentChange: number }[] = [];
  const values: number[] = [];
  
  for (const date of commonDates) {
    let weightedReturn = 0;
    
    for (const { map, weight } of returnMaps) {
      const pctChange = map.get(date) || 0;
      weightedReturn += pctChange * weight;
    }
    
    returns.push({ date, percentChange: weightedReturn });
    // Normalize to 100 at start
    values.push(100 * (1 + weightedReturn / 100));
  }
  
  // Calculate aggregate stats
  const firstValue = values[0] || 100;
  const lastValue = values[values.length - 1] || 100;
  const totalReturn = ((lastValue - firstValue) / firstValue) * 100;
  
  const years = periodMonths / 12;
  const annualizedReturn = years > 0 && firstValue > 0
    ? (Math.pow(lastValue / firstValue, 1 / years) - 1) * 100
    : 0;
  
  const totalCashFlow = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.totalCashFlow || 0), 0
  );
  
  const weightedAppreciation = holdingPerformances.reduce(
    (sum, hp) => sum + hp.performance!.totalAppreciation * (hp.equity / totalEquity), 0
  );

  const bookkeepingPropertiesCovered = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.bookkeepingPropertiesCovered || 0),
    0,
  );
  const bookkeepingMonthsCovered = Math.max(
    ...holdingPerformances.map((hp) => hp.performance!.bookkeepingMonthsCovered || 0),
    0,
  );
  const totalIncome = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.operatingSummary.totalIncome || 0),
    0,
  );
  const totalExpenses = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.operatingSummary.totalExpenses || 0),
    0,
  );
  const totalNetIncome = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.operatingSummary.netIncome || 0),
    0,
  );
  const latestIncome = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.operatingSummary.latestIncome || 0),
    0,
  );
  const latestExpenses = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.operatingSummary.latestExpenses || 0),
    0,
  );
  const latestNetIncome = holdingPerformances.reduce(
    (sum, hp) => sum + (hp.performance!.operatingSummary.latestNetIncome || 0),
    0,
  );
  const dataSource: RealEstatePerformanceData['dataSource'] = bookkeepingPropertiesCovered > 0 ? 'bookkeeping' : 'modeled';
  
  return {
    dates: commonDates,
    values,
    returns,
    totalReturn,
    annualizedReturn,
    totalCashFlow,
    totalAppreciation: weightedAppreciation,
    dataSource,
    bookkeepingPropertiesCovered,
    bookkeepingMonthsCovered,
    operatingSummary: {
      totalIncome,
      totalExpenses,
      netIncome: totalNetIncome,
      margin: totalIncome > 0 ? (totalNetIncome / totalIncome) * 100 : null,
      latestIncome,
      latestExpenses,
      latestNetIncome,
      latestMargin: latestIncome > 0 ? (latestNetIncome / latestIncome) * 100 : null,
    },
  };
}

/**
 * Calculate combined portfolio performance (stocks + real estate)
 */
export function calculateCombinedPortfolioPerformance(
  stocksData: { dates: string[]; values: number[] } | null,
  realEstateData: RealEstatePerformanceData | null,
  stocksWeight: number, // As decimal 0-1
  realEstateWeight: number // As decimal 0-1
): { dates: string[]; values: number[]; returns: { date: string; percentChange: number }[] } | null {
  // Ensure weights sum to 1
  const totalWeight = stocksWeight + realEstateWeight;
  if (totalWeight <= 0) return null;
  
  const normStocksWeight = stocksWeight / totalWeight;
  const normRealEstateWeight = realEstateWeight / totalWeight;
  
  // Handle case where only one asset class has data
  if (!stocksData && !realEstateData) return null;
  
  if (!stocksData) {
    return {
      dates: realEstateData!.dates,
      values: realEstateData!.values,
      returns: realEstateData!.returns,
    };
  }
  
  if (!realEstateData) {
    // Normalize stock values to 100
    const firstStockValue = stocksData.values[0] || 100;
    const normalizedValues = stocksData.values.map(v => (v / firstStockValue) * 100);
    const returns = normalizedValues.map((v, i) => ({
      date: stocksData.dates[i],
      percentChange: ((v - 100) / 100) * 100,
    }));
    return {
      dates: stocksData.dates,
      values: normalizedValues,
      returns,
    };
  }

  const commonDates = stocksData.dates;

  // Create lookup maps
  const stocksMap = new Map<string, number>();
  stocksData.dates.forEach((d, i) => stocksMap.set(d, stocksData.values[i]));

  const alignedRealEstateReturns = alignReturnSeriesToDates(realEstateData.returns, commonDates);
  const realEstateMap = new Map<string, number>();
  alignedRealEstateReturns.forEach((point) => realEstateMap.set(point.date, point.percentChange));

  // Normalize stocks to percentage returns from start
  const stocksStartValue = stocksMap.get(commonDates[0]) || 100;
  
  const values: number[] = [];
  const returns: { date: string; percentChange: number }[] = [];
  
  for (const date of commonDates) {
    const stockValue = stocksMap.get(date) || stocksStartValue;
    const stockReturn = ((stockValue - stocksStartValue) / stocksStartValue) * 100;
    
    const realEstateReturn = realEstateMap.get(date) || 0;
    
    // Weighted average return
    const combinedReturn = stockReturn * normStocksWeight + realEstateReturn * normRealEstateWeight;
    
    values.push(100 * (1 + combinedReturn / 100));
    returns.push({ date, percentChange: combinedReturn });
  }
  
  return { dates: commonDates, values, returns };
}

/**
 * Convert owner properties from API to RealEstateHolding format
 */
export function convertToRealEstateHoldings(
  ownerProperties: any[],
  _portfolioAssets?: { realEstate: any[] } // Reserved for future use to merge with portfolio data
): RealEstateHolding[] {
  const holdings: RealEstateHolding[] = [];
  
  for (const property of ownerProperties) {
    // Try to extract financial data from property
    const financials = property.financials || {};
    const propertyData = property.propertyData || {};
    
    // Get AVM history if available
    const avmHistory = propertyData.avm_history || [];
    
    // Get current value from AVM or summary
    const currentValue = propertyData.summary?.avm_value || 
                        financials.currentValue ||
                        financials.purchasePrice || 
                        0;
    
    // Get purchase info
    const purchasePrice = financials.purchasePrice || currentValue;
    const purchaseDate = financials.purchaseDate || property.createdAt || new Date().toISOString();
    
    // Get financing info
    const downPayment = financials.downPayment || purchasePrice * 0.2; // Assume 20% down
    const loanAmount = financials.loanAmount || (purchasePrice - downPayment);
    const interestRate = financials.interestRate || 7.0; // Default to current average
    
    // Get rental income
    const monthlyRent = financials.monthlyRent || 
                       propertyData.summary?.rental_avm ||
                       0;

    const propertyTax = financials.propertyTax ||
               propertyData.summary?.tax_current ||
               propertyData.tax_history?.[0]?.tax_amount ||
               0;
    
    // Get monthly expenses (or estimate from available data)
    const monthlyExpenses = financials.monthlyExpenses ||
                           (financials.insurance || 0) / 12 +
                 propertyTax / 12 +
                           (financials.maintenance || monthlyRent * 0.1); // 10% maintenance reserve
    
    if (currentValue > 0) {
      holdings.push({
        id: property.id,
        address: property.address,
        purchasePrice,
        purchaseDate,
        currentValue,
        downPayment,
        loanAmount,
        interestRate,
        monthlyRent,
        monthlyExpenses,
        avmHistory,
      });
    }
  }
  
  return holdings;
}

/**
 * Get real estate portfolio weight relative to total portfolio
 */
export function calculateAssetWeights(
  stocksValue: number,
  realEstateEquity: number
): { stocksWeight: number; realEstateWeight: number } {
  const total = stocksValue + realEstateEquity;
  
  if (total <= 0) {
    return { stocksWeight: 0.5, realEstateWeight: 0.5 };
  }
  
  return {
    stocksWeight: stocksValue / total,
    realEstateWeight: realEstateEquity / total,
  };
}
