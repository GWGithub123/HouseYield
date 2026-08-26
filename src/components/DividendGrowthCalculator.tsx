/**
 * Dividend Growth Calculator
 * 
 * Features:
 * - Manual entry calculator with customizable parameters
 * - Stock discovery by growth vs starting yield categories
 * - Blended portfolio projections with multiple stocks
 * - Interactive line charts with DRIP vs non-DRIP comparison
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  getDividends,
  getStockQuote,
  getCompanyDetails,
  getFinancials,
  getAssets,
  Asset,
} from '../services/portfolioService';
import { searchTickers } from '../services/polygonService';
import { useAuth } from '../contexts/AuthContext';

// ============================================================================
// Types
// ============================================================================

interface CalculatorInputs {
  startingPrincipal: number;
  initialDividendYield: number;
  annualContribution: number;
  expectedDividendGrowth: number;
  expectedPriceAppreciation: number;
  yearsInvested: number;
  distributionFrequency: 'monthly' | 'quarterly' | 'annually';
  drip: boolean;
  dividendTaxRate: number;
  taxExemptAmount: number;
}

interface YearlyProjection {
  year: number;
  portfolioValue: number;
  portfolioValueNoDrip: number;
  annualDividends: number;
  annualDividendsNoDrip: number;
  cumulativeDividends: number;
  cumulativeDividendsNoDrip: number;
  effectiveYield: number;
  contributions: number;
  sharePrice: number;
}

interface StockInfo {
  ticker: string;
  name: string;
  currentPrice: number;
  dividendYield: number;
  fiveYearDividendGrowth: number;
  dividendFrequency: number;
  annualDividend: number;
  logoUrl?: string;
  category: 'high-growth-low-yield' | 'balanced' | 'high-yield-low-growth' | 'dividend-etf';
}

interface PortfolioStock extends StockInfo {
  weight: number;
}

interface CompoundInterestInputs {
  initialInvestment: number;
  monthlyContribution: number;
  yearsToInvest: number;
  annualInterestRate: number;
  rateVarianceRange: number;
  compoundFrequency: 'annually' | 'semiannually' | 'quarterly' | 'monthly' | 'daily';
}

interface CompoundInterestResult {
  month: number;
  year: number;
  balance: number;
  interestEarned: number;
  contributions: number;
}

interface DCFInputs {
  method: 'eps' | 'fcf';
  currentEPS?: number;
  epsGrowthRate?: number;
  peRatio?: number;
  currentFCFPerShare?: number;
  fcfGrowthRate?: number;
  fcfMultiple?: number;
  riskFreeRate?: number;
  equityRiskPremium?: number;
  wacc?: number;
  marginOfErrorPercent: number;
}

interface DCFProjection {
  year: number;
  eps?: number;
  fcfPerShare?: number;
  stockPrice: number;
  downside?: number;
  upside?: number;
  annualReturn?: number;
}

// ============================================================================
// Pre-defined dividend stocks database (curated list with typical characteristics)
// ============================================================================

const DIVIDEND_STOCKS_DATABASE: Array<{
  ticker: string;
  name: string;
  typicalYield: number;
  typicalGrowth: number;
  category: StockInfo['category'];
  description: string;
}> = [
  // High Growth, Lower Yield
  { ticker: 'V', name: 'Visa Inc.', typicalYield: 0.8, typicalGrowth: 16, category: 'high-growth-low-yield', description: 'Payment technology leader' },
  { ticker: 'MA', name: 'Mastercard Inc.', typicalYield: 0.6, typicalGrowth: 18, category: 'high-growth-low-yield', description: 'Global payments network' },
  { ticker: 'MSFT', name: 'Microsoft Corp.', typicalYield: 0.7, typicalGrowth: 10, category: 'high-growth-low-yield', description: 'Tech giant with cloud growth' },
  { ticker: 'AAPL', name: 'Apple Inc.', typicalYield: 0.5, typicalGrowth: 7, category: 'high-growth-low-yield', description: 'Consumer tech ecosystem' },
  { ticker: 'HD', name: 'Home Depot', typicalYield: 2.3, typicalGrowth: 12, category: 'high-growth-low-yield', description: 'Home improvement retail' },
  { ticker: 'COST', name: 'Costco Wholesale', typicalYield: 0.6, typicalGrowth: 13, category: 'high-growth-low-yield', description: 'Warehouse retail club' },
  { ticker: 'UNH', name: 'UnitedHealth Group', typicalYield: 1.3, typicalGrowth: 14, category: 'high-growth-low-yield', description: 'Healthcare services' },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway', typicalYield: 0, typicalGrowth: 0, category: 'high-growth-low-yield', description: 'Diversified holding company' },
  
  // Balanced - Moderate Yield, Moderate Growth
  { ticker: 'JNJ', name: 'Johnson & Johnson', typicalYield: 2.9, typicalGrowth: 5, category: 'balanced', description: 'Healthcare conglomerate' },
  { ticker: 'PG', name: 'Procter & Gamble', typicalYield: 2.4, typicalGrowth: 6, category: 'balanced', description: 'Consumer products giant' },
  { ticker: 'PEP', name: 'PepsiCo Inc.', typicalYield: 2.7, typicalGrowth: 7, category: 'balanced', description: 'Beverages and snacks' },
  { ticker: 'MCD', name: "McDonald's Corp.", typicalYield: 2.1, typicalGrowth: 8, category: 'balanced', description: 'Fast food leader' },
  { ticker: 'ABT', name: 'Abbott Laboratories', typicalYield: 1.8, typicalGrowth: 9, category: 'balanced', description: 'Medical devices & diagnostics' },
  { ticker: 'TXN', name: 'Texas Instruments', typicalYield: 2.8, typicalGrowth: 11, category: 'balanced', description: 'Semiconductor manufacturer' },
  { ticker: 'AVGO', name: 'Broadcom Inc.', typicalYield: 1.6, typicalGrowth: 14, category: 'balanced', description: 'Semiconductor & software' },
  { ticker: 'LMT', name: 'Lockheed Martin', typicalYield: 2.5, typicalGrowth: 7, category: 'balanced', description: 'Defense & aerospace' },
  
  // High Yield, Lower Growth
  { ticker: 'KO', name: 'Coca-Cola Co.', typicalYield: 3.0, typicalGrowth: 4, category: 'high-yield-low-growth', description: 'Beverage king, 60+ years of increases' },
  { ticker: 'VZ', name: 'Verizon Communications', typicalYield: 6.5, typicalGrowth: 2, category: 'high-yield-low-growth', description: 'Telecom leader' },
  { ticker: 'T', name: 'AT&T Inc.', typicalYield: 5.8, typicalGrowth: 1, category: 'high-yield-low-growth', description: 'Telecom & media' },
  { ticker: 'IBM', name: 'IBM Corp.', typicalYield: 4.5, typicalGrowth: 1, category: 'high-yield-low-growth', description: 'Enterprise tech & AI' },
  { ticker: 'MMM', name: '3M Company', typicalYield: 5.8, typicalGrowth: 1, category: 'high-yield-low-growth', description: 'Diversified industrial' },
  { ticker: 'O', name: 'Realty Income', typicalYield: 5.5, typicalGrowth: 4, category: 'high-yield-low-growth', description: 'Monthly dividend REIT' },
  { ticker: 'XOM', name: 'Exxon Mobil', typicalYield: 3.3, typicalGrowth: 3, category: 'high-yield-low-growth', description: 'Oil & gas major' },
  { ticker: 'CVX', name: 'Chevron Corp.', typicalYield: 4.1, typicalGrowth: 5, category: 'high-yield-low-growth', description: 'Integrated energy' },
  
  // Dividend ETFs
  { ticker: 'SCHD', name: 'Schwab US Dividend Equity', typicalYield: 3.5, typicalGrowth: 12, category: 'dividend-etf', description: 'High-quality dividend growth ETF' },
  { ticker: 'VIG', name: 'Vanguard Dividend Appreciation', typicalYield: 1.8, typicalGrowth: 10, category: 'dividend-etf', description: 'Dividend growers ETF' },
  { ticker: 'DGRO', name: 'iShares Core Dividend Growth', typicalYield: 2.2, typicalGrowth: 9, category: 'dividend-etf', description: 'Dividend growth focused' },
  { ticker: 'VYM', name: 'Vanguard High Dividend Yield', typicalYield: 3.0, typicalGrowth: 6, category: 'dividend-etf', description: 'High yield equity ETF' },
  { ticker: 'HDV', name: 'iShares Core High Dividend', typicalYield: 3.8, typicalGrowth: 4, category: 'dividend-etf', description: 'High dividend with quality' },
  { ticker: 'NOBL', name: 'ProShares S&P 500 Dividend Aristocrats', typicalYield: 2.0, typicalGrowth: 8, category: 'dividend-etf', description: '25+ year dividend increasers' },
  { ticker: 'SDY', name: 'SPDR S&P Dividend', typicalYield: 2.5, typicalGrowth: 6, category: 'dividend-etf', description: '20+ year dividend increasers' },
  { ticker: 'DIVO', name: 'Amplify CWP Enhanced Dividend', typicalYield: 4.5, typicalGrowth: 5, category: 'dividend-etf', description: 'Dividend with covered calls' },
];

// ============================================================================
// Helper Functions
// ============================================================================

const formatCurrency = (value: number): string => {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
};

const formatCurrencyFull = (value: number): string => {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
};

const calculateProjections = (inputs: CalculatorInputs): YearlyProjection[] => {
  const projections: YearlyProjection[] = [];
  
  let portfolioValue = inputs.startingPrincipal;
  let portfolioValueNoDrip = inputs.startingPrincipal;
  let sharePrice = 100; // Normalized starting price
  let shares = portfolioValue / sharePrice;
  let sharesNoDrip = portfolioValueNoDrip / sharePrice;
  let cumulativeDividends = 0;
  let cumulativeDividendsNoDrip = 0;
  let currentDividendRate = inputs.initialDividendYield / 100;
  
  const distributionMultiplier = inputs.distributionFrequency === 'monthly' ? 12 : 
                                  inputs.distributionFrequency === 'quarterly' ? 4 : 1;
  
  for (let year = 0; year <= inputs.yearsInvested; year++) {
    // Calculate dividends for this year
    const annualDividendPerShare = sharePrice * currentDividendRate;
    const annualDividends = shares * annualDividendPerShare;
    const annualDividendsNoDrip = sharesNoDrip * annualDividendPerShare;
    
    // Apply tax
    const afterTaxDividends = annualDividends * (1 - inputs.dividendTaxRate / 100);
    const afterTaxDividendsNoDrip = annualDividendsNoDrip * (1 - inputs.dividendTaxRate / 100);
    
    cumulativeDividends += afterTaxDividends;
    cumulativeDividendsNoDrip += afterTaxDividendsNoDrip;
    
    projections.push({
      year,
      portfolioValue,
      portfolioValueNoDrip,
      annualDividends: afterTaxDividends,
      annualDividendsNoDrip: afterTaxDividendsNoDrip,
      cumulativeDividends,
      cumulativeDividendsNoDrip,
      effectiveYield: portfolioValue > 0 ? (afterTaxDividends / portfolioValue) * 100 : 0,
      contributions: year * inputs.annualContribution,
      sharePrice,
    });
    
    if (year < inputs.yearsInvested) {
      // Price appreciation
      sharePrice *= (1 + inputs.expectedPriceAppreciation / 100);
      
      // Dividend growth
      currentDividendRate *= (1 + inputs.expectedDividendGrowth / 100);
      
      // Add annual contribution (spread across the year)
      const newSharesFromContribution = inputs.annualContribution / sharePrice;
      shares += newSharesFromContribution;
      sharesNoDrip += newSharesFromContribution;
      
      // DRIP: reinvest dividends
      if (inputs.drip) {
        const dividendPerPeriod = afterTaxDividends / distributionMultiplier;
        for (let period = 0; period < distributionMultiplier; period++) {
          const periodPrice = sharePrice; // Simplified: use end-of-year price
          shares += dividendPerPeriod / periodPrice;
        }
      }
      
      // Update portfolio values
      portfolioValue = shares * sharePrice;
      portfolioValueNoDrip = sharesNoDrip * sharePrice;
    }
  }
  
  return projections;
};

const calculateBlendedProjections = (
  stocks: PortfolioStock[],
  startingPrincipal: number,
  annualContribution: number,
  yearsInvested: number,
  drip: boolean,
  taxRate: number
): YearlyProjection[] => {
  // Calculate blended metrics
  const blendedYield = stocks.reduce((sum, s) => sum + s.dividendYield * s.weight, 0);
  const blendedGrowth = stocks.reduce((sum, s) => sum + s.fiveYearDividendGrowth * s.weight, 0);
  // Assume price appreciation roughly equals dividend growth for dividend stocks
  const blendedPriceGrowth = blendedGrowth * 0.8;
  
  const inputs: CalculatorInputs = {
    startingPrincipal,
    initialDividendYield: blendedYield,
    annualContribution,
    expectedDividendGrowth: blendedGrowth,
    expectedPriceAppreciation: blendedPriceGrowth,
    yearsInvested,
    distributionFrequency: 'quarterly',
    drip,
    dividendTaxRate: taxRate,
    taxExemptAmount: 0,
  };
  
  return calculateProjections(inputs);
};

// ============================================================================
// Compound Interest Calculator
// ============================================================================

const calculateCompoundInterest = (inputs: CompoundInterestInputs): CompoundInterestResult[] => {
  const results: CompoundInterestResult[] = [];
  
  const compoundPeriodsPerYear = 
    inputs.compoundFrequency === 'annually' ? 1 :
    inputs.compoundFrequency === 'semiannually' ? 2 :
    inputs.compoundFrequency === 'quarterly' ? 4 :
    inputs.compoundFrequency === 'monthly' ? 12 : 365;
  
  const periodsPerMonth = compoundPeriodsPerYear / 12;
  const rate = inputs.annualInterestRate / 100 / compoundPeriodsPerYear;
  
  let balance = inputs.initialInvestment;
  let totalContributions = inputs.initialInvestment;
  let month = 0;
  
  for (let year = 0; year <= inputs.yearsToInvest; year++) {
    for (let m = 0; m < 12; m++) {
      // Apply interest for compound periods
      for (let p = 0; p < Math.ceil(periodsPerMonth); p++) {
        balance *= (1 + rate);
      }
      
      // Add monthly contribution
      balance += inputs.monthlyContribution;
      totalContributions += inputs.monthlyContribution;
      
      if (month % 12 === 0) {
        results.push({
          month: month,
          year: Math.floor(month / 12),
          balance,
          interestEarned: balance - totalContributions,
          contributions: totalContributions,
        });
      }
      
      month++;
    }
  }
  
  return results;
};

// ============================================================================
// DCF Calculator
// ============================================================================

const calculateDCF = (inputs: DCFInputs, years: number = 10, currentStockPrice?: number): DCFProjection[] => {
  const projections: DCFProjection[] = [];
  const marginOfError = (inputs.marginOfErrorPercent || 20) / 100;
  
  if (inputs.method === 'eps' && inputs.currentEPS && inputs.epsGrowthRate !== undefined && inputs.peRatio) {
    const currentEPS = inputs.currentEPS;
    const growthRate = inputs.epsGrowthRate / 100;
    const peRatio = inputs.peRatio;
    
    for (let year = 1; year <= years; year++) {
      const projectedEPS = currentEPS * Math.pow(1 + growthRate, year);
      const stockPrice = projectedEPS * peRatio;
      
      // Sensitivity analysis - PE ratio variance (user-configurable)
      const pesensitivity = peRatio * marginOfError;
      const upside = projectedEPS * (peRatio + pesensitivity);
      const downside = projectedEPS * (peRatio - pesensitivity);
      
      // Calculate annualized return from current price to projected price
      let annualReturn: number | undefined;
      if (currentStockPrice && currentStockPrice > 0) {
        annualReturn = (Math.pow(stockPrice / currentStockPrice, 1 / year) - 1) * 100;
      }
      
      projections.push({
        year,
        eps: projectedEPS,
        stockPrice,
        upside,
        downside,
        annualReturn,
      });
    }
  } else if (inputs.method === 'fcf' && inputs.currentFCFPerShare && inputs.fcfGrowthRate !== undefined && inputs.fcfMultiple) {
    const currentFCF = inputs.currentFCFPerShare;
    const growthRate = inputs.fcfGrowthRate / 100;
    const fcfMultiple = inputs.fcfMultiple;
    
    for (let year = 1; year <= years; year++) {
      const projectedFCF = currentFCF * Math.pow(1 + growthRate, year);
      const stockPrice = projectedFCF * fcfMultiple;
      
      // Sensitivity analysis - FCF multiple variance (user-configurable)
      const multipleSensitivity = fcfMultiple * marginOfError;
      const upside = projectedFCF * (fcfMultiple + multipleSensitivity);
      const downside = projectedFCF * (fcfMultiple - multipleSensitivity);
      
      // Calculate annualized return from current price to projected price
      let annualReturn: number | undefined;
      if (currentStockPrice && currentStockPrice > 0) {
        annualReturn = (Math.pow(stockPrice / currentStockPrice, 1 / year) - 1) * 100;
      }
      
      projections.push({
        year,
        fcfPerShare: projectedFCF,
        stockPrice,
        upside,
        downside,
        annualReturn,
      });
    }
  }
  
  return projections;
};

// Calculate required purchase price for a desired annual return
const calculateRequiredPurchasePrice = (
  targetPrice: number,
  desiredAnnualReturn: number,
  years: number
): number => {
  if (desiredAnnualReturn <= -100 || years <= 0) return 0;
  const growthFactor = Math.pow(1 + desiredAnnualReturn / 100, years);
  return targetPrice / growthFactor;
};

// ============================================================================
// Chart Component with Liquid Glass Styling
// ============================================================================

interface ChartProps {
  projections: YearlyProjection[];
  showDrip: boolean;
  showNoDrip: boolean;
  metric: 'portfolioValue' | 'annualDividends' | 'cumulativeDividends';
  title: string;
}

const DividendChart: React.FC<ChartProps> = ({ projections, showDrip, showNoDrip, metric, title }) => {
  const [hoveredPoint, setHoveredPoint] = useState<{ x: number; y: number; data: YearlyProjection; isDrip: boolean } | null>(null);
  
  const W = 700, H = 350;
  const LP = 70, RP = 30, TP = 40, BP = 50;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;
  
  // Get data based on metric
  const dripValues = projections.map(p => 
    metric === 'portfolioValue' ? p.portfolioValue :
    metric === 'annualDividends' ? p.annualDividends : p.cumulativeDividends
  );
  const noDripValues = projections.map(p => 
    metric === 'portfolioValue' ? p.portfolioValueNoDrip :
    metric === 'annualDividends' ? p.annualDividendsNoDrip : p.cumulativeDividendsNoDrip
  );
  
  const allValues = [...(showDrip ? dripValues : []), ...(showNoDrip ? noDripValues : [])];
  const maxValue = Math.max(...allValues, 1);
  const minValue = 0;
  
  const xScale = (i: number) => LP + (i / (projections.length - 1)) * innerW;
  const yScale = (v: number) => TP + innerH - ((v - minValue) / (maxValue - minValue)) * innerH;
  
  // Generate y-axis ticks
  const tickCount = 5;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => minValue + (i * (maxValue - minValue)) / tickCount);
  
  // Create path
  const createPath = (values: number[]) => {
    return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i)},${yScale(v)}`).join(' ');
  };
  
  // Create area path
  const createAreaPath = (values: number[]) => {
    const linePath = createPath(values);
    return `${linePath} L${xScale(values.length - 1)},${yScale(0)} L${xScale(0)},${yScale(0)} Z`;
  };
  
  return (
    <div 
      className="relative rounded-2xl overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
      }}
    >
      {/* Glass border effect */}
      <div 
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.3) 100%)',
          padding: '1px',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'xor',
          WebkitMaskComposite: 'xor',
        }}
      />
      
      <div className="p-4">
        <h3 className="text-lg font-semibold text-gray-800 mb-2">{title}</h3>
        
        <div className="flex gap-4 mb-3">
          {showDrip && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-emerald-500" />
              <span className="text-sm text-gray-600">With DRIP</span>
            </div>
          )}
          {showNoDrip && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-blue-500" />
              <span className="text-sm text-gray-600">Without DRIP</span>
            </div>
          )}
        </div>
        
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          <defs>
            <linearGradient id="dripGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="noDripGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="2" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          
          {/* Grid lines */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={LP}
                x2={W - RP}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke="#e5e7eb"
                strokeWidth={1}
                strokeDasharray={i === 0 ? "0" : "4,4"}
              />
              <text
                x={LP - 10}
                y={yScale(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="#6b7280"
              >
                {formatCurrency(tick)}
              </text>
            </g>
          ))}
          
          {/* X-axis labels */}
          {projections.filter((_, i) => i % Math.ceil(projections.length / 10) === 0 || i === projections.length - 1).map((p, i) => {
            const idx = projections.indexOf(p);
            return (
              <text
                key={i}
                x={xScale(idx)}
                y={H - 20}
                textAnchor="middle"
                fontSize={11}
                fill="#6b7280"
              >
                Year {p.year}
              </text>
            );
          })}
          
          {/* Areas */}
          {showNoDrip && (
            <path d={createAreaPath(noDripValues)} fill="url(#noDripGradient)" />
          )}
          {showDrip && (
            <path d={createAreaPath(dripValues)} fill="url(#dripGradient)" />
          )}
          
          {/* Lines */}
          {showNoDrip && (
            <path
              d={createPath(noDripValues)}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {showDrip && (
            <path
              d={createPath(dripValues)}
              fill="none"
              stroke="#10b981"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              filter="url(#glow)"
            />
          )}
          
          {/* Interactive points */}
          {projections.map((p, i) => (
            <g key={i}>
              {showDrip && (
                <circle
                  cx={xScale(i)}
                  cy={yScale(dripValues[i])}
                  r={4}
                  fill="#10b981"
                  stroke="white"
                  strokeWidth={2}
                  className="cursor-pointer hover:r-6 transition-all"
                  onMouseEnter={() => setHoveredPoint({ x: xScale(i), y: yScale(dripValues[i]), data: p, isDrip: true })}
                  onMouseLeave={() => setHoveredPoint(null)}
                />
              )}
              {showNoDrip && (
                <circle
                  cx={xScale(i)}
                  cy={yScale(noDripValues[i])}
                  r={4}
                  fill="#3b82f6"
                  stroke="white"
                  strokeWidth={2}
                  className="cursor-pointer hover:r-6 transition-all"
                  onMouseEnter={() => setHoveredPoint({ x: xScale(i), y: yScale(noDripValues[i]), data: p, isDrip: false })}
                  onMouseLeave={() => setHoveredPoint(null)}
                />
              )}
            </g>
          ))}
          
          {/* Tooltip */}
          {hoveredPoint && (
            <g>
              <rect
                x={hoveredPoint.x - 80}
                y={hoveredPoint.y - 70}
                width={160}
                height={60}
                rx={8}
                fill="white"
                stroke="#e5e7eb"
                filter="drop-shadow(0 4px 6px rgba(0,0,0,0.1))"
              />
              <text x={hoveredPoint.x} y={hoveredPoint.y - 50} textAnchor="middle" fontSize={12} fontWeight="600" fill="#1f2937">
                Year {hoveredPoint.data.year}
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 32} textAnchor="middle" fontSize={11} fill="#6b7280">
                {hoveredPoint.isDrip ? 'With DRIP' : 'No DRIP'}
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 16} textAnchor="middle" fontSize={13} fontWeight="600" fill={hoveredPoint.isDrip ? '#10b981' : '#3b82f6'}>
                {formatCurrencyFull(
                  metric === 'portfolioValue' 
                    ? (hoveredPoint.isDrip ? hoveredPoint.data.portfolioValue : hoveredPoint.data.portfolioValueNoDrip)
                    : metric === 'annualDividends'
                    ? (hoveredPoint.isDrip ? hoveredPoint.data.annualDividends : hoveredPoint.data.annualDividendsNoDrip)
                    : (hoveredPoint.isDrip ? hoveredPoint.data.cumulativeDividends : hoveredPoint.data.cumulativeDividendsNoDrip)
                )}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
};

// ============================================================================
// Compound Interest Chart Component
// ============================================================================

interface CompoundInterestChartProps {
  results: CompoundInterestResult[];
  title: string;
}

const CompoundInterestChart: React.FC<CompoundInterestChartProps> = ({ results, title }) => {
  const [hoveredPoint, setHoveredPoint] = useState<{ x: number; y: number; data: CompoundInterestResult } | null>(null);
  
  const W = 700, H = 350;
  const LP = 70, RP = 30, TP = 40, BP = 50;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;
  
  const balances = results.map(r => r.balance);
  const _interests = results.map(r => r.interestEarned);
  
  const maxBalance = Math.max(...balances, 1);
  const minValue = 0;
  
  const xScale = (i: number) => LP + (i / (results.length - 1)) * innerW;
  const yScale = (v: number) => TP + innerH - ((v - minValue) / (maxBalance - minValue)) * innerH;
  
  const yTicks = Array.from({ length: 6 }, (_, i) => minValue + (i * (maxBalance - minValue)) / 5);
  
  const createPath = (values: number[]) => {
    return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i)},${yScale(v)}`).join(' ');
  };
  
  const createAreaPath = (values: number[]) => {
    const linePath = createPath(values);
    return `${linePath} L${xScale(values.length - 1)},${yScale(0)} L${xScale(0)},${yScale(0)} Z`;
  };
  
  const finalBalance = results[results.length - 1]?.balance || 0;
  const _initialInvestment = results[0]?.contributions || 0;
  const totalInterest = finalBalance - (results[results.length - 1]?.contributions || 0);
  
  return (
    <div 
      className="relative rounded-2xl overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
      }}
    >
      <div 
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.3) 100%)',
          padding: '1px',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'xor',
          WebkitMaskComposite: 'xor',
        }}
      />
      
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">{title}</h3>
            <div className="flex gap-6 mt-2">
              <div>
                <div className="text-xs text-gray-500">Final Balance</div>
                <div className="text-xl font-bold text-blue-600">{formatCurrencyFull(finalBalance)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Interest Earned</div>
                <div className="text-xl font-bold text-emerald-600">+{formatCurrencyFull(totalInterest)}</div>
              </div>
            </div>
          </div>
        </div>
        
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          <defs>
            <linearGradient id="compoundGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
            </linearGradient>
            <filter id="glowBlue">
              <feGaussianBlur stdDeviation="2" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          
          {/* Grid lines */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={LP}
                x2={W - RP}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke="#e5e7eb"
                strokeWidth={1}
                strokeDasharray={i === 0 ? "0" : "4,4"}
              />
              <text
                x={LP - 10}
                y={yScale(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="#6b7280"
              >
                {formatCurrency(tick)}
              </text>
            </g>
          ))}
          
          {/* X-axis labels */}
          {results.filter((_, i) => i % Math.ceil(results.length / 8) === 0 || i === results.length - 1).map((r, idx) => {
            const arrayIdx = results.indexOf(r);
            return (
              <text
                key={idx}
                x={xScale(arrayIdx)}
                y={H - 20}
                textAnchor="middle"
                fontSize={11}
                fill="#6b7280"
              >
                Year {r.year}
              </text>
            );
          })}
          
          {/* Area */}
          <path d={createAreaPath(balances)} fill="url(#compoundGradient)" />
          
          {/* Line */}
          <path
            d={createPath(balances)}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            filter="url(#glowBlue)"
          />
          
          {/* Interactive points */}
          {results.map((r, i) => (
            <circle
              key={i}
              cx={xScale(i)}
              cy={yScale(r.balance)}
              r={4}
              fill="#3b82f6"
              stroke="white"
              strokeWidth={2}
              className="cursor-pointer hover:r-6 transition-all"
              onMouseEnter={() => setHoveredPoint({ x: xScale(i), y: yScale(r.balance), data: r })}
              onMouseLeave={() => setHoveredPoint(null)}
            />
          ))}
          
          {/* Tooltip */}
          {hoveredPoint && (
            <g>
              <rect
                x={hoveredPoint.x - 90}
                y={hoveredPoint.y - 90}
                width={180}
                height={80}
                rx={8}
                fill="white"
                stroke="#e5e7eb"
                filter="drop-shadow(0 4px 6px rgba(0,0,0,0.1))"
              />
              <text x={hoveredPoint.x} y={hoveredPoint.y - 70} textAnchor="middle" fontSize={12} fontWeight="600" fill="#1f2937">
                Year {hoveredPoint.data.year}
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 50} textAnchor="middle" fontSize={11} fill="#6b7280">
                Balance
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 32} textAnchor="middle" fontSize={13} fontWeight="600" fill="#3b82f6">
                {formatCurrencyFull(hoveredPoint.data.balance)}
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 10} textAnchor="middle" fontSize={10} fill="#6b7280">
                Interest: {formatCurrencyFull(hoveredPoint.data.interestEarned)}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
};

// ============================================================================
// DCF Chart Component
// ============================================================================

interface DCFChartProps {
  projections: DCFProjection[];
  title: string;
  method: 'eps' | 'fcf';
}

const DCFChart: React.FC<DCFChartProps> = ({ projections, title, method: _method }) => {
  const [hoveredPoint, setHoveredPoint] = useState<{ x: number; y: number; data: DCFProjection } | null>(null);
  
  const W = 700, H = 350;
  const LP = 70, RP = 30, TP = 40, BP = 50;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;
  
  const prices = projections.map(p => p.stockPrice);
  const maxPrice = Math.max(...prices, 1);
  const minPrice = 0;
  
  const xScale = (i: number) => LP + (i / (projections.length - 1)) * innerW;
  const yScale = (v: number) => TP + innerH - ((v - minPrice) / (maxPrice - minPrice)) * innerH;
  
  const yTicks = Array.from({ length: 6 }, (_, i) => minPrice + (i * (maxPrice - minPrice)) / 5);
  
  const createPath = (values: number[]) => {
    return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i)},${yScale(v)}`).join(' ');
  };
  
  const createAreaPath = (values: number[]) => {
    const linePath = createPath(values);
    return `${linePath} L${xScale(values.length - 1)},${yScale(0)} L${xScale(0)},${yScale(0)} Z`;
  };
  
  const _currentPrice = projections[0]?.stockPrice || 0;
  const targetPrice = projections[projections.length - 1]?.stockPrice || 0;
  const upside = projections[projections.length - 1]?.upside || 0;
  const downside = projections[projections.length - 1]?.downside || 0;
  
  return (
    <div 
      className="relative rounded-2xl overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
      }}
    >
      <div 
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.3) 100%)',
          padding: '1px',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'xor',
          WebkitMaskComposite: 'xor',
        }}
      />
      
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">{title}</h3>
            <div className="flex gap-6 mt-2">
              <div>
                <div className="text-xs text-gray-500">Year {projections[projections.length - 1]?.year} Target</div>
                <div className="text-xl font-bold text-blue-600">${targetPrice.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Upside Case</div>
                <div className="text-xl font-bold text-emerald-600">${upside.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Downside Case</div>
                <div className="text-xl font-bold text-red-600">${downside.toFixed(2)}</div>
              </div>
            </div>
          </div>
        </div>
        
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          <defs>
            <linearGradient id="dcfGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.02" />
            </linearGradient>
            <filter id="glowPurple">
              <feGaussianBlur stdDeviation="2" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          
          {/* Grid lines */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={LP}
                x2={W - RP}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke="#e5e7eb"
                strokeWidth={1}
                strokeDasharray={i === 0 ? "0" : "4,4"}
              />
              <text
                x={LP - 10}
                y={yScale(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="#6b7280"
              >
                ${tick.toFixed(0)}
              </text>
            </g>
          ))}
          
          {/* X-axis labels */}
          {projections.map((p, i) => (
            <text
              key={i}
              x={xScale(i)}
              y={H - 20}
              textAnchor="middle"
              fontSize={11}
              fill="#6b7280"
            >
              Year {p.year}
            </text>
          ))}
          
          {/* Area */}
          <path d={createAreaPath(prices)} fill="url(#dcfGradient)" />
          
          {/* Line */}
          <path
            d={createPath(prices)}
            fill="none"
            stroke="#8b5cf6"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            filter="url(#glowPurple)"
          />
          
          {/* Interactive points */}
          {projections.map((p, i) => (
            <circle
              key={i}
              cx={xScale(i)}
              cy={yScale(p.stockPrice)}
              r={4}
              fill="#8b5cf6"
              stroke="white"
              strokeWidth={2}
              className="cursor-pointer hover:r-6 transition-all"
              onMouseEnter={() => setHoveredPoint({ x: xScale(i), y: yScale(p.stockPrice), data: p })}
              onMouseLeave={() => setHoveredPoint(null)}
            />
          ))}
          
          {/* Tooltip */}
          {hoveredPoint && (
            <g>
              <rect
                x={hoveredPoint.x - 100}
                y={hoveredPoint.y - 100}
                width={200}
                height={100}
                rx={8}
                fill="white"
                stroke="#e5e7eb"
                filter="drop-shadow(0 4px 6px rgba(0,0,0,0.1))"
              />
              <text x={hoveredPoint.x} y={hoveredPoint.y - 78} textAnchor="middle" fontSize={12} fontWeight="600" fill="#1f2937">
                Year {hoveredPoint.data.year}
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 58} textAnchor="middle" fontSize={11} fill="#6b7280">
                Base Case
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 40} textAnchor="middle" fontSize={13} fontWeight="600" fill="#8b5cf6">
                ${hoveredPoint.data.stockPrice.toFixed(2)}
              </text>
              <text x={hoveredPoint.x} y={hoveredPoint.y - 18} textAnchor="middle" fontSize={10} fill="#6b7280">
                Range: ${hoveredPoint.data.downside?.toFixed(2)} - ${hoveredPoint.data.upside?.toFixed(2)}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
};

// ============================================================================
// Stock Card Component
// ============================================================================

interface StockCardProps {
  stock: typeof DIVIDEND_STOCKS_DATABASE[0];
  isSelected: boolean;
  onToggle: (ticker: string) => void;
  loading?: boolean;
  liveData?: StockInfo | null;
}

const StockCard: React.FC<StockCardProps> = ({ stock, isSelected, onToggle, loading, liveData }) => {
  const displayYield = liveData?.dividendYield ?? stock.typicalYield;
  const displayGrowth = liveData?.fiveYearDividendGrowth ?? stock.typicalGrowth;
  
  return (
    <div
      onClick={() => onToggle(stock.ticker)}
      className={`
        relative p-4 rounded-xl cursor-pointer transition-all duration-200
        ${isSelected 
          ? 'bg-gradient-to-br from-emerald-50 to-teal-50 border-2 border-emerald-400 shadow-lg' 
          : 'bg-white border border-gray-200 hover:border-gray-300 hover:shadow-md'
        }
      `}
    >
      {isSelected && (
        <div className="absolute top-2 right-2">
          <svg className="w-5 h-5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        </div>
      )}
      
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center text-sm font-bold text-blue-700">
          {stock.ticker.slice(0, 2)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900">{stock.ticker}</span>
            {loading && (
              <div className="animate-spin h-3 w-3 border-2 border-emerald-500 border-t-transparent rounded-full" />
            )}
          </div>
          <p className="text-sm text-gray-500 truncate">{stock.name}</p>
        </div>
      </div>
      
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="bg-gray-50 rounded-lg px-2 py-1.5">
          <div className="text-xs text-gray-500">Yield</div>
          <div className="font-semibold text-gray-900">{displayYield.toFixed(1)}%</div>
        </div>
        <div className="bg-gray-50 rounded-lg px-2 py-1.5">
          <div className="text-xs text-gray-500">Div Growth</div>
          <div className="font-semibold text-emerald-600">+{displayGrowth.toFixed(0)}%</div>
        </div>
      </div>
      
      <p className="mt-2 text-xs text-gray-400">{stock.description}</p>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const DividendGrowthCalculator: React.FC = () => {
  const { user } = useAuth();
  
  // Tab state
  const [activeTab, setActiveTab] = useState<'manual' | 'discover' | 'blended' | 'compound' | 'dcf'>('manual');
  
  // Manual calculator inputs
  const [inputs, setInputs] = useState<CalculatorInputs>({
    startingPrincipal: 100000,
    initialDividendYield: 5,
    annualContribution: 20000,
    expectedDividendGrowth: 3,
    expectedPriceAppreciation: 3,
    yearsInvested: 20,
    distributionFrequency: 'annually',
    drip: true,
    dividendTaxRate: 15,
    taxExemptAmount: 0,
  });
  
  // Stock discovery state
  const [selectedCategory, setSelectedCategory] = useState<StockInfo['category'] | 'all'>('all');
  const [selectedStocks, setSelectedStocks] = useState<string[]>(['SCHD', 'KO', 'MA']);
  const [stockSearch, setStockSearch] = useState('');
  const [liveStockData, setLiveStockData] = useState<Record<string, StockInfo>>({});
  const [loadingStocks, setLoadingStocks] = useState<string[]>([]);
  
  // Blended portfolio state
  const [portfolioStocks, setPortfolioStocks] = useState<PortfolioStock[]>([]);
  const [blendedDrip, setBlendedDrip] = useState(true);
  
  // Compound interest inputs
  const [compoundInputs, setCompoundInputs] = useState<CompoundInterestInputs>({
    initialInvestment: 10000,
    monthlyContribution: 500,
    yearsToInvest: 20,
    annualInterestRate: 7,
    rateVarianceRange: 2,
    compoundFrequency: 'monthly',
  });
  
  // User accounts for compound interest pre-fill
  const [userAccounts, setUserAccounts] = useState<Asset[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  
  // DCF inputs
  const [dcfInputs, setDCFInputs] = useState<DCFInputs>({
    method: 'eps',
    currentEPS: 5.0,
    epsGrowthRate: 10,
    peRatio: 25,
    currentFCFPerShare: 8.0,
    fcfGrowthRate: 12,
    fcfMultiple: 15,
    marginOfErrorPercent: 20,
  });
  
  // DCF stock search
  const [dcfTickerSearch, setDCFTickerSearch] = useState('');
  const [dcfSearchResults, setDCFSearchResults] = useState<Array<{ ticker: string; name: string }>>([]);
  const [dcfSelectedTicker, setDCFSelectedTicker] = useState<string | null>(null);
  const [dcfLoadingStock, setDCFLoadingStock] = useState(false);
  const [dcfStockInfo, setDCFStockInfo] = useState<{ 
    name: string; 
    price: number; 
    ttmEPS: number; 
    ttmFCFPerShare: number;
    sharesOutstanding: number;
  } | null>(null);
  
  const [dcfYears, setDCFYears] = useState<5 | 10>(10);
  
  // Desired annual return calculator
  const [desiredAnnualReturn, setDesiredAnnualReturn] = useState<number>(15);
  
  // Chart display state
  const [chartMetric, setChartMetric] = useState<'portfolioValue' | 'annualDividends' | 'cumulativeDividends'>('portfolioValue');
  const [showDrip, setShowDrip] = useState(true);
  const [showNoDrip, setShowNoDrip] = useState(true);
  
  // Load user accounts for compound interest
  useEffect(() => {
    const loadUserAccounts = async () => {
      if (!user?.id) return;
      setLoadingAccounts(true);
      try {
        const assets = await getAssets(user.id);
        const allAccounts = [
          ...assets.cash,
          ...assets.stocks,
          ...assets.bonds,
          ...assets.alternatives,
        ];
        setUserAccounts(allAccounts);
      } catch (error) {
        console.error('Error loading user accounts:', error);
      } finally {
        setLoadingAccounts(false);
      }
    };
    loadUserAccounts();
  }, [user?.id]);
  
  // Search tickers for DCF
  useEffect(() => {
    const searchTimeout = setTimeout(async () => {
      if (dcfTickerSearch.length >= 1) {
        try {
          const results = await searchTickers(dcfTickerSearch);
          setDCFSearchResults(results.slice(0, 8).map(r => ({ ticker: r.ticker, name: r.name })));
        } catch (error) {
          console.error('Error searching tickers:', error);
        }
      } else {
        setDCFSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(searchTimeout);
  }, [dcfTickerSearch]);
  
  // Load stock data for DCF when ticker is selected
  const loadDCFStockData = async (ticker: string) => {
    setDCFLoadingStock(true);
    setDCFSelectedTicker(ticker);
    setDCFTickerSearch('');
    setDCFSearchResults([]);
    
    try {
      const [quote, financials, company] = await Promise.all([
        getStockQuote(ticker),
        getFinancials(ticker),
        getCompanyDetails(ticker),
      ]);
      
      if (quote && financials.length > 0) {
        // Calculate TTM EPS (sum of last 4 quarters)
        const ttmEPS = financials.slice(0, 4).reduce((sum, f) => sum + (f.earningsPerShare || 0), 0);
        
        // Calculate TTM FCF per share (need shares outstanding)
        const ttmFCF = financials.slice(0, 4).reduce((sum, f) => sum + (f.freeCashFlow || 0), 0);
        const sharesOutstanding = company?.marketCap && quote.currentPrice 
          ? company.marketCap / quote.currentPrice 
          : 1000000000; // Default to 1B shares
        const ttmFCFPerShare = ttmFCF / sharesOutstanding;
        
        // Calculate implied PE ratio
        const impliedPE = ttmEPS > 0 ? quote.currentPrice / ttmEPS : 25;
        const impliedFCFMultiple = ttmFCFPerShare > 0 ? quote.currentPrice / ttmFCFPerShare : 15;
        
        setDCFStockInfo({
          name: company?.name || ticker,
          price: quote.currentPrice,
          ttmEPS,
          ttmFCFPerShare,
          sharesOutstanding,
        });
        
        // Update DCF inputs with real data
        setDCFInputs(prev => ({
          ...prev,
          currentEPS: Math.max(0.01, ttmEPS),
          peRatio: Math.max(5, Math.min(100, impliedPE)),
          currentFCFPerShare: Math.max(0.01, ttmFCFPerShare),
          fcfMultiple: Math.max(5, Math.min(50, impliedFCFMultiple)),
        }));
      }
    } catch (error) {
      console.error('Error loading DCF stock data:', error);
    } finally {
      setDCFLoadingStock(false);
    }
  };
  
  // Pre-fill compound interest from account
  const loadAccountForCompound = (account: Asset) => {
    setCompoundInputs(prev => ({
      ...prev,
      initialInvestment: account.value,
    }));
  };
  
  // Calculate projections
  const projections = useMemo(() => calculateProjections(inputs), [inputs]);
  
  // Calculate blended projections
  const blendedProjections = useMemo(() => {
    if (portfolioStocks.length === 0) return [];
    return calculateBlendedProjections(
      portfolioStocks,
      inputs.startingPrincipal,
      inputs.annualContribution,
      inputs.yearsInvested,
      blendedDrip,
      inputs.dividendTaxRate
    );
  }, [portfolioStocks, inputs.startingPrincipal, inputs.annualContribution, inputs.yearsInvested, blendedDrip, inputs.dividendTaxRate]);
  
  // Calculate compound interest results
  const compoundResults = useMemo(() => calculateCompoundInterest(compoundInputs), [compoundInputs]);
  
  // Calculate DCF projections (pass current stock price for annual return calc)
  const dcfProjections = useMemo(
    () => calculateDCF(dcfInputs, dcfYears, dcfStockInfo?.price), 
    [dcfInputs, dcfYears, dcfStockInfo?.price]
  );
  
  // Calculate required purchase price for desired return
  const requiredPurchasePrice = useMemo(() => {
    if (dcfProjections.length === 0) return 0;
    const targetPrice = dcfProjections[dcfProjections.length - 1]?.stockPrice || 0;
    return calculateRequiredPurchasePrice(targetPrice, desiredAnnualReturn, dcfYears);
  }, [dcfProjections, desiredAnnualReturn, dcfYears]);
  
  // Filter stocks by category and search
  const filteredStocks = useMemo(() => {
    return DIVIDEND_STOCKS_DATABASE.filter(stock => {
      const matchesCategory = selectedCategory === 'all' || stock.category === selectedCategory;
      const matchesSearch = stockSearch === '' || 
        stock.ticker.toLowerCase().includes(stockSearch.toLowerCase()) ||
        stock.name.toLowerCase().includes(stockSearch.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [selectedCategory, stockSearch]);
  
  // Fetch live data for selected stocks
  useEffect(() => {
    const fetchStockData = async (ticker: string) => {
      if (liveStockData[ticker] || loadingStocks.includes(ticker)) return;
      
      setLoadingStocks(prev => [...prev, ticker]);
      
      try {
        const [quote, dividends, company] = await Promise.all([
          getStockQuote(ticker),
          getDividends(ticker),
          getCompanyDetails(ticker),
        ]);
        
        if (quote && dividends.length > 0) {
          const latestDividend = dividends[0];
          const annualDividend = latestDividend.cashAmount * (latestDividend.frequency || 4);
          const dividendYield = (annualDividend / quote.currentPrice) * 100;
          
          // Estimate 5-year growth from dividend history
          let fiveYearGrowth = 8; // Default
          if (dividends.length >= 8) {
            const oldDiv = dividends[Math.min(dividends.length - 1, 16)];
            const growthRate = Math.pow(latestDividend.cashAmount / (oldDiv?.cashAmount || latestDividend.cashAmount), 1/4) - 1;
            fiveYearGrowth = growthRate * 100;
          }
          
          setLiveStockData(prev => ({
            ...prev,
            [ticker]: {
              ticker,
              name: company?.name || ticker,
              currentPrice: quote.currentPrice,
              dividendYield,
              fiveYearDividendGrowth: Math.max(0, fiveYearGrowth),
              dividendFrequency: latestDividend.frequency || 4,
              annualDividend,
              logoUrl: company?.logoUrl,
              category: DIVIDEND_STOCKS_DATABASE.find(s => s.ticker === ticker)?.category || 'balanced',
            },
          }));
        }
      } catch (error) {
        console.error(`Error fetching data for ${ticker}:`, error);
      } finally {
        setLoadingStocks(prev => prev.filter(t => t !== ticker));
      }
    };
    
    selectedStocks.forEach(ticker => {
      fetchStockData(ticker);
    });
  }, [selectedStocks]);
  
  // Update portfolio stocks when selection changes
  useEffect(() => {
    const equalWeight = selectedStocks.length > 0 ? 1 / selectedStocks.length : 0;
    
    setPortfolioStocks(
      selectedStocks.map(ticker => {
        const dbStock = DIVIDEND_STOCKS_DATABASE.find(s => s.ticker === ticker);
        const liveData = liveStockData[ticker];
        
        return {
          ticker,
          name: liveData?.name || dbStock?.name || ticker,
          currentPrice: liveData?.currentPrice || 100,
          dividendYield: liveData?.dividendYield || dbStock?.typicalYield || 3,
          fiveYearDividendGrowth: liveData?.fiveYearDividendGrowth || dbStock?.typicalGrowth || 6,
          dividendFrequency: liveData?.dividendFrequency || 4,
          annualDividend: liveData?.annualDividend || 0,
          logoUrl: liveData?.logoUrl,
          category: dbStock?.category || 'balanced',
          weight: equalWeight,
        };
      })
    );
  }, [selectedStocks, liveStockData]);
  
  const toggleStock = (ticker: string) => {
    setSelectedStocks(prev => 
      prev.includes(ticker) 
        ? prev.filter(t => t !== ticker)
        : [...prev, ticker]
    );
  };
  
  const updateStockWeight = (ticker: string, weight: number) => {
    setPortfolioStocks(prev => prev.map(s => 
      s.ticker === ticker ? { ...s, weight } : s
    ));
  };
  
  const normalizeWeights = () => {
    const total = portfolioStocks.reduce((sum, s) => sum + s.weight, 0);
    if (total > 0) {
      setPortfolioStocks(prev => prev.map(s => ({ ...s, weight: s.weight / total })));
    }
  };
  
  // Calculate summary stats
  const finalProjection = projections[projections.length - 1];
  const totalContributed = inputs.startingPrincipal + (inputs.yearsInvested * inputs.annualContribution);
  const totalGrowth = finalProjection ? ((finalProjection.portfolioValue - totalContributed) / totalContributed) * 100 : 0;
  
  // Blended stats
  const blendedYield = portfolioStocks.reduce((sum, s) => sum + s.dividendYield * s.weight, 0);
  const blendedGrowth = portfolioStocks.reduce((sum, s) => sum + s.fiveYearDividendGrowth * s.weight, 0);
  const finalBlendedProjection = blendedProjections[blendedProjections.length - 1];
  
  return (
    <div className="flex-1 h-screen overflow-y-auto bg-gradient-to-br from-slate-50 via-blue-50/30 to-slate-100 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <span className="text-3xl">📈</span>
            Dividend Growth Calculator
          </h1>
          <p className="text-gray-500 mt-2">
            Project your dividend income and portfolio growth over time
          </p>
        </div>
        
        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 p-1 bg-white/60 backdrop-blur-sm rounded-xl border border-gray-200/60 w-fit flex-wrap">
          {[
            { id: 'manual', label: 'Dividend Calculator', icon: '🧮' },
            { id: 'discover', label: 'Stock Discovery', icon: '🔍' },
            { id: 'blended', label: 'Blended Portfolio', icon: '📊' },
            { id: 'compound', label: 'Compound Interest', icon: '💹' },
            { id: 'dcf', label: 'DCF Calculator', icon: '📈' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2
                ${activeTab === tab.id 
                  ? 'bg-white text-gray-900 shadow-sm' 
                  : 'text-gray-600 hover:text-gray-900 hover:bg-white/50'
                }
              `}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
        
        {/* Manual Calculator Tab */}
        {activeTab === 'manual' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Input Panel */}
            <div 
              className="lg:col-span-1 rounded-2xl p-6"
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.95) 100%)',
                backdropFilter: 'blur(20px)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
              }}
            >
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Investment Parameters</h2>
              
              <div className="space-y-4">
                {/* Starting Principal */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Starting Principal</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                    <input
                      type="number"
                      value={inputs.startingPrincipal}
                      onChange={e => setInputs(prev => ({ ...prev, startingPrincipal: Number(e.target.value) }))}
                      className="w-full pl-7 pr-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                    />
                  </div>
                </div>
                
                {/* Initial Dividend Yield */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Initial Dividend Yield</label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      value={inputs.initialDividendYield}
                      onChange={e => setInputs(prev => ({ ...prev, initialDividendYield: Number(e.target.value) }))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                </div>
                
                {/* Annual Contribution */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Annual Contribution</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                    <input
                      type="number"
                      value={inputs.annualContribution}
                      onChange={e => setInputs(prev => ({ ...prev, annualContribution: Number(e.target.value) }))}
                      className="w-full pl-7 pr-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                    />
                  </div>
                </div>
                
                {/* Expected Dividend Growth */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expected Annual Dividend Growth
                    <span className="ml-1 text-gray-400 text-xs">(per year)</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.5"
                      value={inputs.expectedDividendGrowth}
                      onChange={e => setInputs(prev => ({ ...prev, expectedDividendGrowth: Number(e.target.value) }))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                </div>
                
                {/* Expected Price Appreciation */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expected Share Price Appreciation
                    <span className="ml-1 text-gray-400 text-xs">(per year)</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.5"
                      value={inputs.expectedPriceAppreciation}
                      onChange={e => setInputs(prev => ({ ...prev, expectedPriceAppreciation: Number(e.target.value) }))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                </div>
                
                {/* Dividend Tax Rate */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Dividend Tax Rate</label>
                  <div className="relative">
                    <input
                      type="number"
                      step="1"
                      value={inputs.dividendTaxRate}
                      onChange={e => setInputs(prev => ({ ...prev, dividendTaxRate: Number(e.target.value) }))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                </div>
                
                {/* Years Invested */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Years Invested</label>
                  <input
                    type="number"
                    value={inputs.yearsInvested}
                    onChange={e => setInputs(prev => ({ ...prev, yearsInvested: Number(e.target.value) }))}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                  />
                </div>
                
                {/* Distribution Frequency */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Distribution Frequency</label>
                  <select
                    value={inputs.distributionFrequency}
                    onChange={e => setInputs(prev => ({ ...prev, distributionFrequency: e.target.value as any }))}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                  >
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annually">Annually</option>
                  </select>
                </div>
                
                {/* DRIP Toggle */}
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                  <div>
                    <div className="font-medium text-gray-900">DRIP</div>
                    <div className="text-xs text-gray-500">Dividend Reinvestment Plan</div>
                  </div>
                  <button
                    onClick={() => setInputs(prev => ({ ...prev, drip: !prev.drip }))}
                    className={`
                      relative w-12 h-6 rounded-full transition-colors
                      ${inputs.drip ? 'bg-emerald-500' : 'bg-gray-300'}
                    `}
                  >
                    <div className={`
                      absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform
                      ${inputs.drip ? 'translate-x-7' : 'translate-x-1'}
                    `} />
                  </button>
                </div>
              </div>
            </div>
            
            {/* Results Panel */}
            <div className="lg:col-span-2 space-y-6">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { 
                    label: 'Final Portfolio Value', 
                    value: formatCurrencyFull(finalProjection?.portfolioValue || 0),
                    color: 'emerald',
                    icon: '💰'
                  },
                  { 
                    label: 'Annual Dividend Income', 
                    value: formatCurrencyFull(finalProjection?.annualDividends || 0),
                    color: 'blue',
                    icon: '📅'
                  },
                  { 
                    label: 'Monthly Dividend', 
                    value: formatCurrencyFull((finalProjection?.annualDividends || 0) / 12),
                    color: 'purple',
                    icon: '📆'
                  },
                  { 
                    label: 'Total Growth', 
                    value: `${totalGrowth.toFixed(0)}%`,
                    color: 'amber',
                    icon: '📈'
                  },
                ].map((stat, i) => (
                  <div 
                    key={i}
                    className="p-4 rounded-xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm"
                  >
                    <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
                      <span>{stat.icon}</span>
                      {stat.label}
                    </div>
                    <div className={`text-xl font-bold text-${stat.color}-600`}>
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Chart Controls */}
              <div className="flex flex-wrap items-center gap-4 p-4 bg-white/60 backdrop-blur-sm rounded-xl border border-gray-100">
                <div className="flex gap-2">
                  {[
                    { id: 'portfolioValue', label: 'Portfolio Value' },
                    { id: 'annualDividends', label: 'Annual Dividends' },
                    { id: 'cumulativeDividends', label: 'Cumulative Dividends' },
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setChartMetric(opt.id as typeof chartMetric)}
                      className={`
                        px-3 py-1.5 rounded-lg text-sm font-medium transition-all
                        ${chartMetric === opt.id 
                          ? 'bg-emerald-100 text-emerald-700' 
                          : 'text-gray-600 hover:bg-gray-100'
                        }
                      `}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                
                <div className="h-6 w-px bg-gray-200" />
                
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showDrip}
                      onChange={e => setShowDrip(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-emerald-500 focus:ring-emerald-500"
                    />
                    <span className="text-sm text-gray-700">With DRIP</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showNoDrip}
                      onChange={e => setShowNoDrip(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">Without DRIP</span>
                  </label>
                </div>
              </div>
              
              {/* Chart */}
              <DividendChart
                projections={projections}
                showDrip={showDrip && inputs.drip}
                showNoDrip={showNoDrip}
                metric={chartMetric}
                title={
                  chartMetric === 'portfolioValue' ? 'Portfolio Value Over Time' :
                  chartMetric === 'annualDividends' ? 'Annual Dividend Income' :
                  'Cumulative Dividends Received'
                }
              />
              
              {/* Projection Table */}
              <div 
                className="rounded-2xl overflow-hidden"
                style={{
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
                  backdropFilter: 'blur(20px)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
                }}
              >
                <div className="p-4 border-b border-gray-100">
                  <h3 className="font-semibold text-gray-900">Year-by-Year Projection</h3>
                </div>
                <div className="overflow-x-auto max-h-[400px]">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr>
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">Year</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Portfolio Value</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Annual Dividend</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Monthly Dividend</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Yield on Cost</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Cumulative Dividends</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projections.map((p, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                          <td className="py-3 px-4 font-medium text-gray-900">Year {p.year}</td>
                          <td className="py-3 px-4 text-right text-gray-900">{formatCurrencyFull(p.portfolioValue)}</td>
                          <td className="py-3 px-4 text-right text-emerald-600 font-medium">{formatCurrencyFull(p.annualDividends)}</td>
                          <td className="py-3 px-4 text-right text-blue-600">{formatCurrencyFull(p.annualDividends / 12)}</td>
                          <td className="py-3 px-4 text-right text-purple-600">{p.effectiveYield.toFixed(2)}%</td>
                          <td className="py-3 px-4 text-right text-gray-600">{formatCurrencyFull(p.cumulativeDividends)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Stock Discovery Tab */}
        {activeTab === 'discover' && (
          <div className="space-y-6">
            {/* Category Filter */}
            <div 
              className="p-4 rounded-2xl"
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
                backdropFilter: 'blur(20px)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
              }}
            >
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-[200px]">
                  <input
                    type="text"
                    placeholder="Search stocks by ticker or name..."
                    value={stockSearch}
                    onChange={e => setStockSearch(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all"
                  />
                </div>
                
                <div className="flex gap-2 flex-wrap">
                  {[
                    { id: 'all', label: 'All Stocks', color: 'gray' },
                    { id: 'high-growth-low-yield', label: '🚀 High Growth', color: 'purple' },
                    { id: 'balanced', label: '⚖️ Balanced', color: 'blue' },
                    { id: 'high-yield-low-growth', label: '💵 High Yield', color: 'emerald' },
                    { id: 'dividend-etf', label: '📦 ETFs', color: 'amber' },
                  ].map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => setSelectedCategory(cat.id as typeof selectedCategory)}
                      className={`
                        px-4 py-2 rounded-lg text-sm font-medium transition-all
                        ${selectedCategory === cat.id 
                          ? `bg-${cat.color}-100 text-${cat.color}-700 border border-${cat.color}-200` 
                          : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                        }
                      `}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>
              
              {selectedStocks.length > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <div className="text-sm text-gray-600 mb-2">
                    <span className="font-medium">{selectedStocks.length}</span> stocks selected for portfolio analysis
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedStocks.map(ticker => (
                      <span 
                        key={ticker}
                        className="inline-flex items-center gap-1 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-sm"
                      >
                        {ticker}
                        <button
                          onClick={() => toggleStock(ticker)}
                          className="hover:text-emerald-900"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <button
                      onClick={() => setActiveTab('blended')}
                      className="px-4 py-1 bg-emerald-500 text-white rounded-full text-sm font-medium hover:bg-emerald-600 transition-colors"
                    >
                      View Blended Analysis →
                    </button>
                  </div>
                </div>
              )}
            </div>
            
            {/* Stock Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredStocks.map(stock => (
                <StockCard
                  key={stock.ticker}
                  stock={stock}
                  isSelected={selectedStocks.includes(stock.ticker)}
                  onToggle={toggleStock}
                  loading={loadingStocks.includes(stock.ticker)}
                  liveData={liveStockData[stock.ticker] || null}
                />
              ))}
            </div>
            
            {filteredStocks.length === 0 && (
              <div className="text-center py-12 text-gray-500">
                No stocks match your search criteria
              </div>
            )}
          </div>
        )}
        
        {/* Blended Portfolio Tab */}
        {activeTab === 'blended' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Portfolio Composition */}
            <div 
              className="lg:col-span-1 rounded-2xl p-6"
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.95) 100%)',
                backdropFilter: 'blur(20px)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
              }}
            >
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Portfolio Composition</h2>
              
              {portfolioStocks.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">📊</div>
                  <p className="text-gray-500 mb-4">No stocks selected</p>
                  <button
                    onClick={() => setActiveTab('discover')}
                    className="px-4 py-2 bg-emerald-500 text-white rounded-lg font-medium hover:bg-emerald-600 transition-colors"
                  >
                    Select Stocks →
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {portfolioStocks.map(stock => (
                    <div 
                      key={stock.ticker}
                      className="p-4 rounded-xl border border-gray-100 bg-gray-50/50"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center text-xs font-bold text-blue-700">
                            {stock.ticker.slice(0, 2)}
                          </div>
                          <div>
                            <div className="font-semibold text-gray-900">{stock.ticker}</div>
                            <div className="text-xs text-gray-500">{stock.name}</div>
                          </div>
                        </div>
                        <button
                          onClick={() => toggleStock(stock.ticker)}
                          className="text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-2 mb-3 text-sm">
                        <div>
                          <span className="text-gray-500">Yield:</span>
                          <span className="ml-1 font-medium text-gray-900">{stock.dividendYield.toFixed(1)}%</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Growth:</span>
                          <span className="ml-1 font-medium text-emerald-600">+{stock.fiveYearDividendGrowth.toFixed(0)}%</span>
                        </div>
                      </div>
                      
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Weight: {(stock.weight * 100).toFixed(0)}%</label>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={stock.weight}
                          onChange={e => updateStockWeight(stock.ticker, Number(e.target.value))}
                          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                  ))}
                  
                  <button
                    onClick={normalizeWeights}
                    className="w-full py-2 text-sm text-emerald-600 hover:text-emerald-700 font-medium"
                  >
                    Normalize Weights to 100%
                  </button>
                  
                  <div className="border-t border-gray-200 pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-gray-600">Blended Yield</span>
                      <span className="font-semibold text-gray-900">{blendedYield.toFixed(2)}%</span>
                    </div>
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-sm text-gray-600">Blended Growth</span>
                      <span className="font-semibold text-emerald-600">+{blendedGrowth.toFixed(1)}%</span>
                    </div>
                    
                    {/* DRIP Toggle */}
                    <div className="flex items-center justify-between p-3 bg-gray-100 rounded-xl">
                      <div>
                        <div className="font-medium text-gray-900 text-sm">DRIP</div>
                        <div className="text-xs text-gray-500">Reinvest Dividends</div>
                      </div>
                      <button
                        onClick={() => setBlendedDrip(!blendedDrip)}
                        className={`
                          relative w-12 h-6 rounded-full transition-colors
                          ${blendedDrip ? 'bg-emerald-500' : 'bg-gray-300'}
                        `}
                      >
                        <div className={`
                          absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform
                          ${blendedDrip ? 'translate-x-7' : 'translate-x-1'}
                        `} />
                      </button>
                    </div>
                  </div>
                  
                  <button
                    onClick={() => setActiveTab('discover')}
                    className="w-full py-2.5 border border-gray-200 rounded-xl text-gray-600 hover:bg-gray-50 transition-colors text-sm font-medium"
                  >
                    + Add More Stocks
                  </button>
                </div>
              )}
            </div>
            
            {/* Blended Results */}
            <div className="lg:col-span-2 space-y-6">
              {portfolioStocks.length > 0 ? (
                <>
                  {/* Summary Stats */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                      { 
                        label: 'Final Portfolio Value', 
                        value: formatCurrencyFull(finalBlendedProjection?.portfolioValue || 0),
                        icon: '💰'
                      },
                      { 
                        label: 'Annual Dividend (Year 20)', 
                        value: formatCurrencyFull(finalBlendedProjection?.annualDividends || 0),
                        icon: '📅'
                      },
                      { 
                        label: 'Monthly Dividend', 
                        value: formatCurrencyFull((finalBlendedProjection?.annualDividends || 0) / 12),
                        icon: '📆'
                      },
                      { 
                        label: 'Total Dividends Received', 
                        value: formatCurrencyFull(finalBlendedProjection?.cumulativeDividends || 0),
                        icon: '💵'
                      },
                    ].map((stat, i) => (
                      <div 
                        key={i}
                        className="p-4 rounded-xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm"
                      >
                        <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
                          <span>{stat.icon}</span>
                          {stat.label}
                        </div>
                        <div className="text-xl font-bold text-gray-900">
                          {stat.value}
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  {/* Blended Chart */}
                  <DividendChart
                    projections={blendedProjections}
                    showDrip={blendedDrip}
                    showNoDrip={!blendedDrip}
                    metric={chartMetric}
                    title={`Blended Portfolio: ${portfolioStocks.map(s => s.ticker).join(' + ')}`}
                  />
                  
                  {/* Comparison */}
                  <div 
                    className="rounded-2xl p-6"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
                      backdropFilter: 'blur(20px)',
                      boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
                    }}
                  >
                    <h3 className="font-semibold text-gray-900 mb-4">Individual Stock Projections</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-gray-200">
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">Stock</th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Yield</th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Growth</th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Weight</th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Y20 Dividend</th>
                          </tr>
                        </thead>
                        <tbody>
                          {portfolioStocks.map(stock => {
                            const stockProjections = calculateProjections({
                              ...inputs,
                              startingPrincipal: inputs.startingPrincipal * stock.weight,
                              annualContribution: inputs.annualContribution * stock.weight,
                              initialDividendYield: stock.dividendYield,
                              expectedDividendGrowth: stock.fiveYearDividendGrowth,
                              expectedPriceAppreciation: stock.fiveYearDividendGrowth * 0.8,
                              drip: blendedDrip,
                            });
                            const finalStock = stockProjections[stockProjections.length - 1];
                            
                            return (
                              <tr key={stock.ticker} className="border-b border-gray-50 hover:bg-gray-50/50">
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2">
                                    <div className="w-6 h-6 rounded bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center text-xs font-bold text-blue-700">
                                      {stock.ticker.slice(0, 1)}
                                    </div>
                                    <span className="font-medium text-gray-900">{stock.ticker}</span>
                                  </div>
                                </td>
                                <td className="py-3 px-4 text-right text-gray-900">{stock.dividendYield.toFixed(1)}%</td>
                                <td className="py-3 px-4 text-right text-emerald-600">+{stock.fiveYearDividendGrowth.toFixed(0)}%</td>
                                <td className="py-3 px-4 text-right text-gray-600">{(stock.weight * 100).toFixed(0)}%</td>
                                <td className="py-3 px-4 text-right font-medium text-blue-600">{formatCurrencyFull(finalStock?.annualDividends || 0)}</td>
                              </tr>
                            );
                          })}
                          <tr className="bg-emerald-50">
                            <td className="py-3 px-4 font-semibold text-gray-900">Blended Total</td>
                            <td className="py-3 px-4 text-right font-semibold text-gray-900">{blendedYield.toFixed(1)}%</td>
                            <td className="py-3 px-4 text-right font-semibold text-emerald-600">+{blendedGrowth.toFixed(0)}%</td>
                            <td className="py-3 px-4 text-right font-semibold text-gray-600">100%</td>
                            <td className="py-3 px-4 text-right font-bold text-emerald-600">{formatCurrencyFull(finalBlendedProjection?.annualDividends || 0)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <div 
                  className="rounded-2xl p-12 text-center"
                  style={{
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
                    backdropFilter: 'blur(20px)',
                    boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
                  }}
                >
                  <div className="text-6xl mb-4">📊</div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">Build Your Dividend Portfolio</h3>
                  <p className="text-gray-500 mb-6 max-w-md mx-auto">
                    Select multiple stocks to see how they blend together for dividend income and growth projections.
                  </p>
                  <button
                    onClick={() => setActiveTab('discover')}
                    className="px-6 py-3 bg-emerald-500 text-white rounded-xl font-medium hover:bg-emerald-600 transition-colors"
                  >
                    Browse Dividend Stocks →
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        
        {/* Compound Interest Tab */}
        {activeTab === 'compound' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Input Panel */}
            <div 
              className="lg:col-span-1 rounded-2xl p-6"
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.95) 100%)',
                backdropFilter: 'blur(20px)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
              }}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">Compound Interest</h2>
              </div>
              
              {/* Load from Accounts */}
              {userAccounts.length > 0 && (
                <div className="mb-6 p-4 bg-blue-50 rounded-xl border border-blue-100">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-blue-800">Quick Load from Accounts</span>
                    {loadingAccounts && (
                      <div className="animate-spin h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full" />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {userAccounts.slice(0, 6).map((account, idx) => (
                      <button
                        key={account.id || idx}
                        onClick={() => loadAccountForCompound(account)}
                        className="px-3 py-1.5 bg-white text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-100 transition-colors border border-blue-200"
                      >
                        {account.name}: {formatCurrencyFull(account.value)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="space-y-4">
                {/* Step 1: Initial Investment */}
                <div className="bg-gradient-to-r from-teal-600 to-teal-700 text-white px-3 py-2 rounded-lg text-sm font-medium">
                  Step 1: Initial Investment
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Initial Investment <span className="text-red-500">*</span>
                  </label>
                  <p className="text-xs text-gray-500 mb-2">Amount of money that you have available to invest initially.</p>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                    <input
                      type="number"
                      value={compoundInputs.initialInvestment}
                      onChange={e => setCompoundInputs(prev => ({ ...prev, initialInvestment: Number(e.target.value) }))}
                      className="w-full pl-7 pr-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                    />
                  </div>
                </div>
                
                {/* Step 2: Contribute */}
                <div className="bg-gradient-to-r from-teal-600 to-teal-700 text-white px-3 py-2 rounded-lg text-sm font-medium">
                  Step 2: Contribute
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Monthly Contribution</label>
                  <p className="text-xs text-gray-500 mb-2">Amount that you plan to add to the principal every month, or a negative number to withdraw.</p>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                    <input
                      type="number"
                      value={compoundInputs.monthlyContribution}
                      onChange={e => setCompoundInputs(prev => ({ ...prev, monthlyContribution: Number(e.target.value) }))}
                      className="w-full pl-7 pr-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Length of Time in Years <span className="text-red-500">*</span>
                  </label>
                  <p className="text-xs text-gray-500 mb-2">Length of time, in years, that you plan to save.</p>
                  <input
                    type="number"
                    value={compoundInputs.yearsToInvest}
                    onChange={e => setCompoundInputs(prev => ({ ...prev, yearsToInvest: Number(e.target.value) }))}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                  />
                </div>
                
                {/* Step 3: Interest Rate */}
                <div className="bg-gradient-to-r from-teal-600 to-teal-700 text-white px-3 py-2 rounded-lg text-sm font-medium">
                  Step 3: Interest Rate
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Estimated Interest Rate <span className="text-red-500">*</span>
                  </label>
                  <p className="text-xs text-gray-500 mb-2">Your estimated annual interest rate.</p>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      value={compoundInputs.annualInterestRate}
                      onChange={e => setCompoundInputs(prev => ({ ...prev, annualInterestRate: Number(e.target.value) }))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Interest Rate Variance Range</label>
                  <p className="text-xs text-gray-500 mb-2">Range of interest rates (above and below) to see results for.</p>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.5"
                      value={compoundInputs.rateVarianceRange}
                      onChange={e => setCompoundInputs(prev => ({ ...prev, rateVarianceRange: Number(e.target.value) }))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                </div>
                
                {/* Step 4: Compound It */}
                <div className="bg-gradient-to-r from-teal-600 to-teal-700 text-white px-3 py-2 rounded-lg text-sm font-medium">
                  Step 4: Compound It
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Compound Frequency</label>
                  <p className="text-xs text-gray-500 mb-2">Times per year that interest will be compounded.</p>
                  <select
                    value={compoundInputs.compoundFrequency}
                    onChange={e => setCompoundInputs(prev => ({ ...prev, compoundFrequency: e.target.value as CompoundInterestInputs['compoundFrequency'] }))}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                  >
                    <option value="annually">Annually</option>
                    <option value="semiannually">Semiannually</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="monthly">Monthly</option>
                    <option value="daily">Daily</option>
                  </select>
                </div>
              </div>
            </div>
            
            {/* Results Panel */}
            <div className="lg:col-span-2 space-y-6">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { 
                    label: 'Final Balance', 
                    value: formatCurrencyFull(compoundResults[compoundResults.length - 1]?.balance || 0),
                    icon: '💰'
                  },
                  { 
                    label: 'Total Interest Earned', 
                    value: formatCurrencyFull(compoundResults[compoundResults.length - 1]?.interestEarned || 0),
                    icon: '📈'
                  },
                  { 
                    label: 'Total Contributions', 
                    value: formatCurrencyFull(compoundResults[compoundResults.length - 1]?.contributions || 0),
                    icon: '💵'
                  },
                  { 
                    label: 'Interest %', 
                    value: `${(((compoundResults[compoundResults.length - 1]?.interestEarned || 0) / (compoundResults[compoundResults.length - 1]?.contributions || 1)) * 100).toFixed(0)}%`,
                    icon: '📊'
                  },
                ].map((stat, i) => (
                  <div 
                    key={i}
                    className="p-4 rounded-xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm"
                  >
                    <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
                      <span>{stat.icon}</span>
                      {stat.label}
                    </div>
                    <div className="text-xl font-bold text-gray-900">
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Chart */}
              {compoundResults.length > 0 && (
                <CompoundInterestChart
                  results={compoundResults}
                  title="Compound Growth Over Time"
                />
              )}
              
              {/* Projection Table */}
              <div 
                className="rounded-2xl overflow-hidden"
                style={{
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
                  backdropFilter: 'blur(20px)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
                }}
              >
                <div className="p-4 border-b border-gray-100">
                  <h3 className="font-semibold text-gray-900">Year-by-Year Projection</h3>
                </div>
                <div className="overflow-x-auto max-h-[400px]">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr>
                        <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">Year</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Balance</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Interest Earned</th>
                        <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Total Contributions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compoundResults.map((r, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                          <td className="py-3 px-4 font-medium text-gray-900">Year {r.year}</td>
                          <td className="py-3 px-4 text-right text-blue-600 font-medium">{formatCurrencyFull(r.balance)}</td>
                          <td className="py-3 px-4 text-right text-emerald-600">+{formatCurrencyFull(r.interestEarned)}</td>
                          <td className="py-3 px-4 text-right text-gray-600">{formatCurrencyFull(r.contributions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* DCF Calculator Tab */}
        {activeTab === 'dcf' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Input Panel */}
            <div 
              className="lg:col-span-1 rounded-2xl p-6"
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.95) 100%)',
                backdropFilter: 'blur(20px)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
              }}
            >
              <h2 className="text-lg font-semibold text-gray-900 mb-4">DCF Stock Valuation</h2>
              
              {/* Stock Ticker Search */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Load Stock Data</label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Search by ticker or company name..."
                    value={dcfTickerSearch}
                    onChange={e => setDCFTickerSearch(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                  />
                  {dcfLoadingStock && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full" />
                    </div>
                  )}
                  
                  {/* Search Results Dropdown */}
                  {dcfSearchResults.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 max-h-60 overflow-y-auto">
                      {dcfSearchResults.map((result, idx) => (
                        <button
                          key={idx}
                          onClick={() => loadDCFStockData(result.ticker)}
                          className="w-full px-4 py-2.5 text-left hover:bg-purple-50 transition-colors flex items-center justify-between"
                        >
                          <span className="font-medium text-gray-900">{result.ticker}</span>
                          <span className="text-sm text-gray-500 truncate ml-2">{result.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                
                {/* Selected Stock Info */}
                {dcfSelectedTicker && dcfStockInfo && (
                  <div className="mt-3 p-3 bg-purple-50 rounded-xl border border-purple-100">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-semibold text-purple-900">{dcfSelectedTicker}</span>
                        <span className="text-sm text-purple-600 ml-2">{dcfStockInfo.name}</span>
                      </div>
                      <span className="text-lg font-bold text-purple-700">${dcfStockInfo.price.toFixed(2)}</span>
                    </div>
                    <div className="flex gap-4 mt-2 text-sm">
                      <span className="text-purple-700">TTM EPS: ${dcfStockInfo.ttmEPS.toFixed(2)}</span>
                      <span className="text-purple-700">TTM FCF/Share: ${dcfStockInfo.ttmFCFPerShare.toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Method Toggle */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Valuation Method</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDCFInputs(prev => ({ ...prev, method: 'eps' }))}
                    className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                      dcfInputs.method === 'eps' 
                        ? 'bg-purple-600 text-white' 
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    EPS Based
                  </button>
                  <button
                    onClick={() => setDCFInputs(prev => ({ ...prev, method: 'fcf' }))}
                    className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                      dcfInputs.method === 'fcf' 
                        ? 'bg-purple-600 text-white' 
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    FCF Based
                  </button>
                </div>
              </div>
              
              {/* Years Toggle */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Projection Period</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDCFYears(5)}
                    className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                      dcfYears === 5 
                        ? 'bg-purple-600 text-white' 
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    5 Years
                  </button>
                  <button
                    onClick={() => setDCFYears(10)}
                    className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                      dcfYears === 10 
                        ? 'bg-purple-600 text-white' 
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    10 Years
                  </button>
                </div>
              </div>
              
              <div className="space-y-4">
                {dcfInputs.method === 'eps' ? (
                  <>
                    {/* EPS Based Inputs */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Current EPS (TTM)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                        <input
                          type="number"
                          step="0.01"
                          value={dcfInputs.currentEPS}
                          onChange={e => setDCFInputs(prev => ({ ...prev, currentEPS: Number(e.target.value) }))}
                          className="w-full pl-7 pr-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                        />
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Expected EPS Growth Rate (Annual)</label>
                      <div className="relative">
                        <input
                          type="number"
                          step="0.5"
                          value={dcfInputs.epsGrowthRate}
                          onChange={e => setDCFInputs(prev => ({ ...prev, epsGrowthRate: Number(e.target.value) }))}
                          className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">P/E Ratio Multiple</label>
                      <input
                        type="number"
                        step="0.5"
                        value={dcfInputs.peRatio}
                        onChange={e => setDCFInputs(prev => ({ ...prev, peRatio: Number(e.target.value) }))}
                        className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    {/* FCF Based Inputs */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">TTM FCF Per Share</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                        <input
                          type="number"
                          step="0.01"
                          value={dcfInputs.currentFCFPerShare}
                          onChange={e => setDCFInputs(prev => ({ ...prev, currentFCFPerShare: Number(e.target.value) }))}
                          className="w-full pl-7 pr-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                        />
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Expected FCF Growth Rate (Annual)</label>
                      <div className="relative">
                        <input
                          type="number"
                          step="0.5"
                          value={dcfInputs.fcfGrowthRate}
                          onChange={e => setDCFInputs(prev => ({ ...prev, fcfGrowthRate: Number(e.target.value) }))}
                          className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">FCF Multiple</label>
                      <input
                        type="number"
                        step="0.5"
                        value={dcfInputs.fcfMultiple}
                        onChange={e => setDCFInputs(prev => ({ ...prev, fcfMultiple: Number(e.target.value) }))}
                        className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                      />
                    </div>
                  </>
                )}
                
                {/* Margin of Error - applies to both methods */}
                <div className="pt-4 border-t border-gray-200">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Margin of Error (±%)
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Variance % for upside/downside scenarios
                  </p>
                  <div className="relative">
                    <input
                      type="number"
                      step="5"
                      min="0"
                      max="100"
                      value={dcfInputs.marginOfErrorPercent}
                      onChange={e => setDCFInputs(prev => ({ ...prev, marginOfErrorPercent: Number(e.target.value) }))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                </div>
                
                {/* Desired Return Calculator */}
                <div className="pt-4 border-t border-gray-200">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Desired Annual Return
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Calculate what price you need to buy at
                  </p>
                  <div className="relative">
                    <input
                      type="number"
                      step="1"
                      value={desiredAnnualReturn}
                      onChange={e => setDesiredAnnualReturn(Number(e.target.value))}
                      className="w-full pr-8 pl-4 py-2.5 rounded-xl border border-gray-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
                  </div>
                  
                  {requiredPurchasePrice > 0 && (
                    <div className="mt-3 p-3 bg-gradient-to-r from-purple-50 to-indigo-50 rounded-xl border border-purple-100">
                      <div className="text-xs text-purple-600 mb-1">Required Purchase Price</div>
                      <div className="text-lg font-bold text-purple-700">
                        ${requiredPurchasePrice.toFixed(2)}
                      </div>
                      <div className="text-xs text-purple-500 mt-1">
                        to achieve {desiredAnnualReturn}% annual return over {dcfYears} years
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            {/* Results Panel */}
            <div className="lg:col-span-2 space-y-6">
              {/* Summary Stats */}
              {dcfProjections.length > 0 && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                    {[
                      { 
                        label: `Year ${dcfYears} Target`, 
                        value: `$${(dcfProjections[dcfProjections.length - 1]?.stockPrice || 0).toFixed(2)}`,
                        icon: '🎯',
                        color: 'text-purple-600'
                      },
                      { 
                        label: `Upside (+${dcfInputs.marginOfErrorPercent}%)`, 
                        value: `$${(dcfProjections[dcfProjections.length - 1]?.upside || 0).toFixed(2)}`,
                        icon: '📈',
                        color: 'text-emerald-600'
                      },
                      { 
                        label: `Downside (-${dcfInputs.marginOfErrorPercent}%)`, 
                        value: `$${(dcfProjections[dcfProjections.length - 1]?.downside || 0).toFixed(2)}`,
                        icon: '📉',
                        color: 'text-red-600'
                      },
                      { 
                        label: dcfInputs.method === 'eps' ? `Y${dcfYears} EPS` : `Y${dcfYears} FCF/Share`,
                        value: dcfInputs.method === 'eps' 
                          ? `$${(dcfProjections[dcfProjections.length - 1]?.eps || 0).toFixed(2)}`
                          : `$${(dcfProjections[dcfProjections.length - 1]?.fcfPerShare || 0).toFixed(2)}`,
                        icon: '💵',
                        color: 'text-purple-600'
                      },
                      ...(dcfStockInfo ? [
                        { 
                          label: 'Current Price', 
                          value: `$${dcfStockInfo.price.toFixed(2)}`,
                          icon: '💰',
                          color: 'text-gray-700'
                        },
                        { 
                          label: `Annual Return`, 
                          value: `${(dcfProjections[dcfProjections.length - 1]?.annualReturn || 0).toFixed(1)}%`,
                          icon: '📊',
                          color: (dcfProjections[dcfProjections.length - 1]?.annualReturn || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'
                        },
                      ] : []),
                    ].map((stat, i) => (
                      <div 
                        key={i}
                        className="p-4 rounded-xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm"
                      >
                        <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
                          <span>{stat.icon}</span>
                          {stat.label}
                        </div>
                        <div className={`text-xl font-bold ${stat.color}`}>
                          {stat.value}
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  {/* Required Purchase Price Card */}
                  {requiredPurchasePrice > 0 && dcfStockInfo && (
                    <div 
                      className="p-4 rounded-xl border-2 border-purple-200"
                      style={{
                        background: 'linear-gradient(135deg, rgba(147, 51, 234, 0.05) 0%, rgba(99, 102, 241, 0.05) 100%)',
                      }}
                    >
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                          <h4 className="font-semibold text-purple-800">Target Entry Price Analysis</h4>
                          <p className="text-sm text-purple-600 mt-1">
                            To achieve <span className="font-bold">{desiredAnnualReturn}%</span> annual return over {dcfYears} years
                          </p>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="text-center">
                            <div className="text-xs text-gray-500">Required Price</div>
                            <div className="text-2xl font-bold text-purple-700">${requiredPurchasePrice.toFixed(2)}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs text-gray-500">Current Price</div>
                            <div className="text-2xl font-bold text-gray-700">${dcfStockInfo.price.toFixed(2)}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs text-gray-500">Discount Needed</div>
                            <div className={`text-2xl font-bold ${requiredPurchasePrice <= dcfStockInfo.price ? 'text-red-600' : 'text-emerald-600'}`}>
                              {requiredPurchasePrice <= dcfStockInfo.price 
                                ? `-${(((dcfStockInfo.price - requiredPurchasePrice) / dcfStockInfo.price) * 100).toFixed(1)}%`
                                : `✓ +${(((requiredPurchasePrice - dcfStockInfo.price) / dcfStockInfo.price) * 100).toFixed(1)}%`
                              }
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {/* Chart */}
                  <DCFChart
                    projections={dcfProjections}
                    title={`${dcfSelectedTicker || 'Stock'} - ${dcfInputs.method === 'eps' ? 'EPS' : 'FCF'} Based Valuation`}
                    method={dcfInputs.method}
                  />
                  
                  {/* Projection Table */}
                  <div 
                    className="rounded-2xl overflow-hidden"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
                      backdropFilter: 'blur(20px)',
                      boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
                    }}
                  >
                    <div className="p-4 border-b border-gray-100">
                      <h3 className="font-semibold text-gray-900">Year-by-Year Projection</h3>
                      <p className="text-xs text-gray-500 mt-1">
                        Upside/Downside based on ±{dcfInputs.marginOfErrorPercent}% margin of error
                      </p>
                    </div>
                    <div className="overflow-x-auto max-h-[400px]">
                      <table className="w-full">
                        <thead className="sticky top-0 bg-gray-50">
                          <tr>
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">Year</th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">
                              {dcfInputs.method === 'eps' ? 'EPS' : 'FCF/Share'}
                            </th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Stock Price</th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Upside (+{dcfInputs.marginOfErrorPercent}%)</th>
                            <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Downside (-{dcfInputs.marginOfErrorPercent}%)</th>
                            {dcfStockInfo && (
                              <th className="text-right py-3 px-4 text-sm font-medium text-gray-600">Annual Return</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {dcfProjections.map((p, i) => (
                            <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                              <td className="py-3 px-4 font-medium text-gray-900">Year {p.year}</td>
                              <td className="py-3 px-4 text-right text-gray-600">
                                ${(dcfInputs.method === 'eps' ? p.eps : p.fcfPerShare)?.toFixed(2)}
                              </td>
                              <td className="py-3 px-4 text-right font-medium text-purple-600">${p.stockPrice.toFixed(2)}</td>
                              <td className="py-3 px-4 text-right text-emerald-600">${p.upside?.toFixed(2)}</td>
                              <td className="py-3 px-4 text-right text-red-600">${p.downside?.toFixed(2)}</td>
                              {dcfStockInfo && (
                                <td className={`py-3 px-4 text-right font-medium ${(p.annualReturn || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {p.annualReturn !== undefined ? `${p.annualReturn.toFixed(1)}%` : '-'}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
              
              {dcfProjections.length === 0 && (
                <div 
                  className="rounded-2xl p-12 text-center"
                  style={{
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%)',
                    backdropFilter: 'blur(20px)',
                    boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
                  }}
                >
                  <div className="text-6xl mb-4">📈</div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">Enter Stock Data</h3>
                  <p className="text-gray-500 mb-6 max-w-md mx-auto">
                    Search for a stock to auto-load EPS and FCF data, or manually enter the values to project future stock prices.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DividendGrowthCalculator;
