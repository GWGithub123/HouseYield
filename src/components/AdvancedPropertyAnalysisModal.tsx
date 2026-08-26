/**
 * Advanced Property Analysis Modal
 * Comprehensive investment analysis with valuation, rental viability, renovation scenarios, and wedge opportunities
 * Integrates ATTOM data, Visual AI condition scoring, BLS regional costs, and assumable mortgage analysis
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { analyzePropertyComprehensive } from '../utils/masterAnalysis';
import { analyzePropertyPhotos } from '../services/visualAIService';
import { createEmptyCanonicalVisualEvidence } from '../services/visualEvidenceService';
import type { ComprehensivePropertyAnalysis, AttomProperty } from '../types/propertyAnalysis';
import { buildCanonicalPropertyProfile } from '../utils/canonicalPropertyProfile';
import * as d3 from 'd3';
import { AdditionalAnalyticsBarChart as ProfessionalBarChart } from './charts/AdditionalAnalyticsBarChart';
import { AdditionalAnalyticsChartCard as ChartCard } from './charts/AdditionalAnalyticsChartCard';

// ============================================================================
// FINANCIAL TYPES AND HELPER FUNCTIONS (from App.tsx)
// ============================================================================

type FinancialInputs = {
  avm: number;
  taxAmount: number;
  originalLoanAmount?: number;
  currentLoanBalance?: number;
  remainingLoanTermMonths?: number;
  loanOriginationDate?: string;
  monthlyDebtService?: number;
  monthlyRent: number;
  otherIncome: number;
  vacancyRate: number;
  rentGrowth: number;
  insurance: number;
  utilities: number;
  hoa: number;
  repairsCapEx: number;
  managementPct: number;
  expenseInflation: number;
  taxGrowth: number;
  interestRate: number;
  loanTerm: number;
  isInterestOnly: boolean;
  extraPrincipal: number;
  downPayment: number;
  closingCosts: number;
  initialRehab: number;
  appreciationRate: number;
};

// Format currency values based on magnitude
const formatCurrency = (value: number): string => {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(2)}MM`;
  } else if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(2)}k`;
  } else {
    return `${sign}$${absValue.toFixed(2)}`;
  }
};

const formatPercentage = (value: number): string => {
  return `${value.toFixed(1)}%`;
};

const generateYearLabels = (count: number, isQuarterly: boolean = false, startYear?: number): string[] => {
  const baseYear = startYear ?? new Date().getFullYear();
  const labels: string[] = [];
  if (isQuarterly) {
    for (let i = 0; i < count; i++) {
      const q = (i % 4) + 1;
      const y = baseYear + Math.floor(i / 4);
      labels.push(`${q}Q${y}`);
    }
  } else {
    for (let i = 0; i < count; i++) labels.push(`${baseYear + i}`);
  }
  return labels;
};

// Derive FinancialInputs from ComprehensivePropertyAnalysis
function deriveFinancialInputsFromAnalysis(
  analysis: ComprehensivePropertyAnalysis,
  listPrice: number,
  downPaymentPercent: number
): FinancialInputs {
  const purchasePrice = listPrice || analysis.valuation.listPrice;
  const downPayment = purchasePrice * (downPaymentPercent / 100);
  const financing = analysis.asIs?.financingOptions?.[0];
  
  // Get expenses from analysis (convert monthly to annual)
  const expenses = analysis.asIs?.expenses;
  const annualPropertyTax = (expenses?.propertyTax || 0) * 12;
  const annualInsurance = (expenses?.insurance || 0) * 12;
  const annualMaintenance = (expenses?.maintenance || 0) * 12;
  const annualCapex = (expenses?.capex || 0) * 12;
  const annualUtilities = (expenses?.utilities || 0) * 12;
  const annualHOA = (expenses?.hoa || 0) * 12;
  
  // Determine interest rate
  let interestRate = 7.0;
  if (financing?.assumedLoan) {
    const assumedBalance = financing.assumedLoan.balance;
    const assumedRate = financing.assumedLoan.rate;
    const gapAmount = financing.newLoan?.amount || 0;
    const gapRate = financing.newLoan?.rate || 7.5;
    const totalLoan = assumedBalance + gapAmount;
    interestRate = totalLoan > 0 
      ? ((assumedBalance * assumedRate) + (gapAmount * gapRate)) / totalLoan
      : assumedRate;
  } else if (financing?.newLoan?.rate) {
    interestRate = financing.newLoan.rate;
  }
  
  return {
    avm: purchasePrice,
    taxAmount: annualPropertyTax,
    monthlyRent: analysis.asIs?.income?.finalMonthlyRent || analysis.asIs?.income?.adjustedMarketRent || 0,
    otherIncome: 0,
    vacancyRate: 5,
    rentGrowth: 3,
    insurance: annualInsurance,
    utilities: annualUtilities,
    hoa: annualHOA,
    repairsCapEx: annualMaintenance + annualCapex,
    managementPct: 8,
    expenseInflation: 2.5,
    taxGrowth: 2,
    interestRate: interestRate,
    loanTerm: 360,
    isInterestOnly: false,
    extraPrincipal: 0,
    downPayment: downPayment,
    closingCosts: purchasePrice * 0.03,
    initialRehab: analysis.postRenovation?.renovationPlan?.totalCost || 0,
    appreciationRate: 3,
  };
}

// Calculate annual cash flow for each year (returns array of values for 9 years)
function calculateCashFlow(inputs: FinancialInputs): number[] {
  const years = 9;
  const results: number[] = [];
  
  for (let t = 0; t < years; t++) {
    const Rt = inputs.monthlyRent * Math.pow(1 + inputs.rentGrowth / 100, t);
    const Ot = inputs.otherIncome * Math.pow(1 + inputs.rentGrowth / 100, t);
    const EGIt = 12 * (Rt + Ot) * (1 - inputs.vacancyRate / 100);
    
    const ge = inputs.expenseInflation / 100;
    const Inst = inputs.insurance * Math.pow(1 + ge, t);
    const Ut = inputs.utilities * Math.pow(1 + ge, t);
    const Ht = inputs.hoa * Math.pow(1 + ge, t);
    const Capt = inputs.repairsCapEx * Math.pow(1 + ge, t);
    const Taxt = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, t);
    const Mgmtt = (inputs.managementPct / 100) * EGIt;
    const OpExt = Taxt + Inst + Ut + Ht + Capt + Mgmtt;
    const NOIt = EGIt - OpExt;
    
    let DSt = 0;
    // Use the same loan projection basis as App.tsx: prefer actual mortgage data when available
    const L0 = inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
    const loanTermMonths = inputs.remainingLoanTermMonths ?? inputs.loanTerm;
    
    if (inputs.monthlyDebtService != null && inputs.monthlyDebtService > 0) {
      DSt = inputs.monthlyDebtService * 12;
    } else if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const rm = inputs.interestRate / 100 / 12;
      const M = (rm * L0) / (1 - Math.pow(1 + rm, -loanTermMonths));
      DSt = 12 * M;
    } else if (inputs.isInterestOnly && inputs.interestRate > 0) {
      const rm = inputs.interestRate / 100 / 12;
      DSt = 12 * rm * L0;
    }
    
    const CFt = NOIt - DSt;
    results.push(CFt / 1000);
  }
  
  return results;
}

// Calculate Income - Expenses with full expense breakdown
function calculateIncomeExpenses(inputs: FinancialInputs): { 
  income: number[]; 
  expenses: number[];
  expenseBreakdown: {
    taxes: number[];
    insurance: number[];
    utilities: number[];
    hoa: number[];
    repairs: number[];
    management: number[];
    debtService: number[];
  }
} {
  const years = 9;
  const income: number[] = [];
  const expenses: number[] = [];
  const expenseBreakdown = {
    taxes: [] as number[],
    insurance: [] as number[],
    utilities: [] as number[],
    hoa: [] as number[],
    repairs: [] as number[],
    management: [] as number[],
    debtService: [] as number[],
  };
  
  for (let t = 0; t < years; t++) {
    const Rt = inputs.monthlyRent * Math.pow(1 + inputs.rentGrowth / 100, t);
    const Ot = inputs.otherIncome * Math.pow(1 + inputs.rentGrowth / 100, t);
    const EGIt = 12 * (Rt + Ot) * (1 - inputs.vacancyRate / 100);
    
    const ge = inputs.expenseInflation / 100;
    const Inst = inputs.insurance * Math.pow(1 + ge, t);
    const Ut = inputs.utilities * Math.pow(1 + ge, t);
    const Ht = inputs.hoa * Math.pow(1 + ge, t);
    const Capt = inputs.repairsCapEx * Math.pow(1 + ge, t);
    const Taxt = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, t);
    const Mgmtt = (inputs.managementPct / 100) * EGIt;
    const OpExt = Taxt + Inst + Ut + Ht + Capt + Mgmtt;
    
    let DSt = 0;
    const L0 = inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
    const loanTermMonths = inputs.remainingLoanTermMonths ?? inputs.loanTerm;
    
    if (inputs.monthlyDebtService != null && inputs.monthlyDebtService > 0) {
      DSt = inputs.monthlyDebtService * 12;
    } else if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const rm = inputs.interestRate / 100 / 12;
      const M = (rm * L0) / (1 - Math.pow(1 + rm, -loanTermMonths));
      DSt = 12 * M;
    } else if (inputs.isInterestOnly && inputs.interestRate > 0) {
      const rm = inputs.interestRate / 100 / 12;
      DSt = 12 * rm * L0;
    }
    
    income.push(EGIt / 1000);
    expenses.push((OpExt + DSt) / 1000);
    
    // Store breakdown (in thousands)
    expenseBreakdown.taxes.push(Taxt / 1000);
    expenseBreakdown.insurance.push(Inst / 1000);
    expenseBreakdown.utilities.push(Ut / 1000);
    expenseBreakdown.hoa.push(Ht / 1000);
    expenseBreakdown.repairs.push(Capt / 1000);
    expenseBreakdown.management.push(Mgmtt / 1000);
    expenseBreakdown.debtService.push(DSt / 1000);
  }
  
  return { income, expenses, expenseBreakdown };
}

// Calculate Cash-on-Cash Return
function calculateCoCReturn(inputs: FinancialInputs): number[] {
  const years = 9;
  const results: number[] = [];
  const cashFlows = calculateCashFlow(inputs);
  const CashIn0 = inputs.downPayment + inputs.closingCosts + inputs.initialRehab;
  
  for (let t = 0; t < years; t++) {
    const CFt = cashFlows[t] * 1000;
    const CoC = CashIn0 > 0 ? (CFt / CashIn0) * 100 : 0;
    results.push(CoC);
  }
  
  return results;
}

// Calculate NOI
function calculateNOI(inputs: FinancialInputs): number[] {
  const years = 9;
  const results: number[] = [];
  
  for (let t = 0; t < years; t++) {
    const Rt = inputs.monthlyRent * Math.pow(1 + inputs.rentGrowth / 100, t);
    const Ot = inputs.otherIncome * Math.pow(1 + inputs.rentGrowth / 100, t);
    const EGIt = 12 * (Rt + Ot) * (1 - inputs.vacancyRate / 100);
    
    const ge = inputs.expenseInflation / 100;
    const Inst = inputs.insurance * Math.pow(1 + ge, t);
    const Ut = inputs.utilities * Math.pow(1 + ge, t);
    const Ht = inputs.hoa * Math.pow(1 + ge, t);
    const Capt = inputs.repairsCapEx * Math.pow(1 + ge, t);
    const Taxt = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, t);
    const Mgmtt = (inputs.managementPct / 100) * EGIt;
    const OpExt = Taxt + Inst + Ut + Ht + Capt + Mgmtt;
    const NOIt = EGIt - OpExt;
    
    results.push(NOIt / 1000);
  }
  
  return results;
}

// Calculate Mortgage Amortization - Loan Balance with principal/interest breakdown
function calculateMortgageAmortization(inputs: FinancialInputs, years: number = 9): { principal: number[]; interest: number[]; loanBalance: number[] } {
  const principal: number[] = [];
  const interest: number[] = [];
  const loanBalance: number[] = [];
  
  const L0 = inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
  const rm = inputs.interestRate / 100 / 12;
  const n = inputs.remainingLoanTermMonths ?? inputs.loanTerm;
  
  if (inputs.interestRate === 0) {
    for (let t = 0; t < years; t++) {
      principal.push(0);
      interest.push(0);
      loanBalance.push(L0 / 1000);
    }
    return { principal, interest, loanBalance };
  }
  
  if (inputs.isInterestOnly) {
    for (let t = 0; t < years; t++) {
      principal.push(0);
      interest.push((12 * rm * L0) / 1000);
      loanBalance.push(L0 / 1000);
    }
    return { principal, interest, loanBalance };
  }
  
  const M = (rm * L0) / (1 - Math.pow(1 + rm, -n));
  
  for (let t = 0; t < years; t++) {
    let annualPrincipal = 0;
    let annualInterest = 0;
    
    const startMonth = t * 12;
    const endMonth = (t + 1) * 12;
    
    for (let k = startMonth + 1; k <= endMonth; k++) {
      const Bk_prev = k === 1 ? L0 : L0 * Math.pow(1 + rm, k - 1) - M * ((Math.pow(1 + rm, k - 1) - 1) / rm);
      const Ik = rm * Bk_prev;
      const Pk = M - Ik;
      
      annualPrincipal += Pk;
      annualInterest += Ik;
    }
    
    principal.push(annualPrincipal / 1000);
    interest.push(annualInterest / 1000);
    
    // Calculate loan balance at END of year t
    const k = (t + 1) * 12;
    const Bk = L0 * Math.pow(1 + rm, k) - M * ((Math.pow(1 + rm, k) - 1) / rm);
    loanBalance.push(Bk / 1000);
  }
  
  return { principal, interest, loanBalance };
}

// Calculate Property Appreciation - Equity - Loan Balance (stacked chart data)
function calculatePropertyAppreciation(inputs: FinancialInputs): { value: number[]; equity: number[]; loan: number[] } {
  const years = 9;
  const value: number[] = [];
  const equity: number[] = [];
  const loan: number[] = [];
  
  const L0 = inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
  const rm = inputs.interestRate / 100 / 12;
  const n = inputs.remainingLoanTermMonths ?? inputs.loanTerm;
  const M = inputs.interestRate > 0 && !inputs.isInterestOnly ? (rm * L0) / (1 - Math.pow(1 + rm, -n)) : 0;
  
  for (let t = 0; t < years; t++) {
    // Property value
    const Vt = inputs.avm * Math.pow(1 + inputs.appreciationRate / 100, t);
    
    // Loan balance
    let Bt = L0;
    if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const k = (t + 1) * 12;
      Bt = L0 * Math.pow(1 + rm, k) - M * ((Math.pow(1 + rm, k) - 1) / rm);
    }
    
    // Equity
    const Eqt = Math.max(Vt - Bt, 0);
    
    value.push(Vt / 1000);
    equity.push(Eqt / 1000);
    loan.push(Bt / 1000);
  }
  
  return { value, equity, loan };
}

// Calculate Total Return (cumulative cash flow + equity + appreciation)
function calculateTotalReturn(inputs: FinancialInputs): { cumulative: number[]; annualPercent: number[] } {
  const cashFlows = calculateCashFlow(inputs);
  const appreciation = calculatePropertyAppreciation(inputs);
  
  const cumulative: number[] = [];
  const annualPercent: number[] = [];
  let cumulativeCF = 0;
  
  const initialInvestment = inputs.downPayment + inputs.closingCosts + inputs.initialRehab;
  const initialEquity = (appreciation.equity[0] || 0) * 1000;
  
  for (let t = 0; t < 9; t++) {
    const cf = cashFlows[t] * 1000;
    cumulativeCF += cf;
    
    const currentEquity = (appreciation.equity[t] || 0) * 1000;
    const equityGain = currentEquity - initialEquity;
    const totalReturn = cumulativeCF + equityGain;
    
    cumulative.push(totalReturn / 1000);
    
    // Annual return as percentage
    if (initialInvestment > 0) {
      annualPercent.push((totalReturn / initialInvestment) * 100);
    } else {
      annualPercent.push(0);
    }
  }
  
  return { cumulative, annualPercent };
}

// ============================================================================
// ============================================================================
// RENTAL SANKEY DIAGRAM COMPONENT (from App.tsx)
// ============================================================================

export const RentalSankeyDiagram = ({ inputs }: { inputs: FinancialInputs | null }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [hoveredLink, setHoveredLink] = useState<any>(null);
  const [selectedYear, setSelectedYear] = useState<number>(1);

  useEffect(() => {
    const width = 1200;
    const height = 600;
    const margin = { top: 50, right: 180, bottom: 30, left: 180 };

    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3.select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .style("background", "linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)")
      .style("border-radius", "12px");

    let grossIncome, vacancyLoss, effectiveGrossIncome, propertyTax, insurance, utilities, hoaFees, repairs, management, totalOpEx, noi, debtService, netIncome;
    
    if (inputs) {
      const rentGrowthFactor = Math.pow(1 + (inputs.rentGrowth || 0) / 100, selectedYear - 1);
      const expenseInflationFactor = Math.pow(1 + (inputs.expenseInflation || 0) / 100, selectedYear - 1);
      const taxGrowthFactor = Math.pow(1 + (inputs.taxGrowth || 0) / 100, selectedYear - 1);
      
      const monthlyRent = inputs.monthlyRent * rentGrowthFactor;
      const otherMonthlyIncome = inputs.otherIncome * rentGrowthFactor;
      const monthlyIncome = monthlyRent + otherMonthlyIncome;
      grossIncome = monthlyIncome * 12;
      vacancyLoss = grossIncome * (inputs.vacancyRate / 100);
      effectiveGrossIncome = grossIncome - vacancyLoss;
      
      propertyTax = (inputs.taxAmount || 0) * taxGrowthFactor;
      insurance = (inputs.insurance || 0) * expenseInflationFactor;
      utilities = (inputs.utilities || 0) * expenseInflationFactor;
      hoaFees = (inputs.hoa || 0) * expenseInflationFactor;
      repairs = (inputs.repairsCapEx || 0) * expenseInflationFactor;
      management = (effectiveGrossIncome * (inputs.managementPct / 100)) || 0;
      totalOpEx = propertyTax + insurance + utilities + hoaFees + repairs + management;
      
      noi = effectiveGrossIncome - totalOpEx;
      
      // Use the same loan projection basis as calculateCashFlow:
      // prefer currentLoanBalance/remainingLoanTermMonths when available (from ATTOM data)
      const loanAmount = (inputs as any).currentLoanBalance ?? (inputs as any).originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
      const monthlyRate = (inputs.interestRate / 100) / 12;
      const numPayments = (inputs as any).remainingLoanTermMonths ?? inputs.loanTerm;
      
      if ((inputs as any).monthlyDebtService != null && (inputs as any).monthlyDebtService > 0) {
        // Use known monthly debt service directly (most accurate)
        debtService = (inputs as any).monthlyDebtService * 12;
      } else if (inputs.isInterestOnly) {
        debtService = (loanAmount * (inputs.interestRate / 100)) + (inputs.extraPrincipal * 12);
      } else if (monthlyRate > 0 && numPayments > 0) {
        const monthlyPayment = (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / 
                               (Math.pow(1 + monthlyRate, numPayments) - 1);
        debtService = (monthlyPayment + inputs.extraPrincipal) * 12;
      } else {
        debtService = 0;
      }
      
      netIncome = noi - debtService;
    } else {
      grossIncome = 42000;
      vacancyLoss = 2100;
      effectiveGrossIncome = grossIncome - vacancyLoss;
      propertyTax = 8876;
      insurance = 3000;
      utilities = 2400;
      hoaFees = 1200;
      repairs = 4200;
      management = 3000;
      totalOpEx = propertyTax + insurance + utilities + hoaFees + repairs + management;
      noi = effectiveGrossIncome - totalOpEx;
      debtService = 18000;
      netIncome = noi - debtService;
    }

    const nodes: any[] = [
      { id: 0, name: "Gross Rental Income", value: grossIncome, x: 0, order: 0, color: "#3b82f6" },
      ...(vacancyLoss > 0 ? [{ id: 1, name: "Vacancy Loss", value: vacancyLoss, x: 1, order: 0, color: "#dc2626" }] : []),
      { id: 2, name: "Effective Gross Rental Income", value: effectiveGrossIncome, x: 1, order: vacancyLoss > 0 ? 1 : 0, color: "#10b981" },
      { id: 9, name: noi >= 0 ? "NOI" : "NOI (Negative)", value: Math.abs(noi), x: 2, order: 0, color: noi >= 0 ? "#8b5cf6" : "#dc2626" },
      { id: 12, name: "Operating Expenses", value: totalOpEx, x: 2, order: 1, color: "#ef4444" },
      { id: 11, name: netIncome >= 0 ? "Free Cash Flow" : `Free Cash Flow (-$${Math.abs(netIncome).toLocaleString()})`, value: Math.abs(netIncome), x: 3, order: 0, color: netIncome >= 0 ? "#06b6d4" : "#dc2626" },
      { id: 10, name: "Debt Service", value: debtService, x: 3, order: 1, color: "#dc2626" },
      { id: 3, name: "Property Tax", value: propertyTax, x: 3, order: 2, color: "#ef4444" },
      { id: 4, name: "Insurance", value: insurance, x: 3, order: 3, color: "#f97316" },
      { id: 5, name: "Utilities", value: utilities, x: 3, order: 4, color: "#f59e0b" },
      { id: 6, name: "HOA Fees", value: hoaFees, x: 3, order: 5, color: "#eab308" },
      { id: 7, name: "Repairs & CapEx", value: repairs, x: 3, order: 6, color: "#84cc16" },
      { id: 8, name: "Management", value: management, x: 3, order: 7, color: "#22c55e" }
    ];

    const links = [
      ...(vacancyLoss > 0 ? [{ source: 0, target: 1, value: vacancyLoss }] : []),
      { source: 0, target: 2, value: effectiveGrossIncome },
      { source: 2, target: 9, value: Math.abs(noi) },
      { source: 2, target: 12, value: totalOpEx },
      { source: 12, target: 3, value: propertyTax },
      { source: 12, target: 4, value: insurance },
      { source: 12, target: 5, value: utilities },
      { source: 12, target: 6, value: hoaFees },
      { source: 12, target: 7, value: repairs },
      { source: 12, target: 8, value: management },
      ...(netIncome >= 0 
        ? [{ source: 9, target: 11, value: netIncome }, { source: 9, target: 10, value: debtService }]
        : [{ source: 9, target: 10, value: Math.abs(noi) }]
      )
    ];

    const nodeWidth = 24;
    const nodePadding = 10;
    const columnWidth = (width - margin.left - margin.right - nodeWidth * 4) / 3;

    const maxValuePerColumn = d3.max(d3.rollup(nodes, (v: any) => d3.sum(v, (d: any) => d.value), (d: any) => d.x).values());
    const availableHeight = height - margin.top - margin.bottom;
    const scale = availableHeight / ((maxValuePerColumn || 0) * 1.15);

    nodes.forEach((node: any) => {
      node.x0 = margin.left + node.x * columnWidth + node.x * nodeWidth;
      node.x1 = node.x0 + nodeWidth;
      node.height = node.value * scale;
    });

    const columns = d3.group(nodes, (d: any) => d.x);
    columns.forEach((columnNodes: any) => {
      columnNodes.sort((a: any, b: any) => a.order - b.order);
      const totalHeight = d3.sum(columnNodes, (d: any) => d.height);
      const padding = (columnNodes.length - 1) * nodePadding;
      const startY = margin.top + (availableHeight - totalHeight - padding) / 2;
      
      let currentY = startY;
      columnNodes.forEach((node: any) => {
        node.y0 = currentY;
        node.y1 = currentY + node.height;
        currentY = node.y1 + nodePadding;
      });
    });

    nodes.forEach((node: any) => {
      node.sourceY = node.y0;
      node.targetY = node.y0;
    });

    const linkData = links.map(link => {
      const source = nodes.find(n => n.id === link.source)!;
      const target = nodes.find(n => n.id === link.target)!;
      const linkHeight = link.value * scale;
      
      const sourceY = source.sourceY;
      const targetY = target.targetY;
      
      source.sourceY += linkHeight;
      target.targetY += linkHeight;
      
      return { ...link, source, target, width: linkHeight, sy0: sourceY, sy1: sourceY + linkHeight, ty0: targetY, ty1: targetY + linkHeight };
    });

    const defs = svg.append("defs");
    linkData.forEach((link, i) => {
      const gradient = defs.append("linearGradient")
        .attr("id", `gradient-modal-${i}`)
        .attr("gradientUnits", "userSpaceOnUse")
        .attr("x1", link.source.x1)
        .attr("x2", link.target.x0);
      gradient.append("stop").attr("offset", "0%").attr("stop-color", link.source.color).attr("stop-opacity", 0.5);
      gradient.append("stop").attr("offset", "100%").attr("stop-color", link.target.color).attr("stop-opacity", 0.5);
    });

    const generateLinkPath = (d: any) => {
      const sourceX = d.source.x1;
      const targetX = d.target.x0;
      const curvature = 0.5;
      const xi = d3.interpolateNumber(sourceX, targetX);
      const x2 = xi(curvature);
      const x3 = xi(1 - curvature);
      return `M ${sourceX},${d.sy0} C ${x2},${d.sy0} ${x3},${d.ty0} ${targetX},${d.ty0} L ${targetX},${d.ty1} C ${x3},${d.ty1} ${x2},${d.sy1} ${sourceX},${d.sy1} Z`;
    };

    svg.append("g").selectAll("path").data(linkData).join("path")
      .attr("d", generateLinkPath)
      .attr("fill", (_d: any, i: number) => `url(#gradient-modal-${i})`)
      .attr("stroke", "none")
      .attr("opacity", 0.5)
      .on("mouseover", function(_event: any, d: any) { setHoveredLink(d); d3.select(this as any).attr("opacity", 0.8); })
      .on("mouseout", function() { setHoveredLink(null); d3.select(this as any).attr("opacity", 0.5); });

    svg.append("g").selectAll("rect").data(nodes).join("rect")
      .attr("x", (d: any) => d.x0)
      .attr("y", (d: any) => d.y0)
      .attr("height", (d: any) => d.y1 - d.y0)
      .attr("width", (d: any) => d.x1 - d.x0)
      .attr("fill", (d: any) => d.color)
      .attr("opacity", 0.95)
      .attr("rx", 3)
      .style("cursor", "pointer")
      .on("mouseover", function(_event: any, d: any) { setHoveredNode(d); d3.select(this as any).attr("opacity", 1); })
      .on("mouseout", function() { setHoveredNode(null); d3.select(this as any).attr("opacity", 0.95); });

    // Calculate label font sizes based on available space per column
    const labelGroups = d3.group(nodes, (d: any) => d.x);
    const getLabelFontSize = (node: any): number => {
      const colNodes = labelGroups.get(node.x) || [];
      if (colNodes.length <= 3) return 12;
      if (colNodes.length <= 5) return 11;
      return 10;
    };

    const getValueFontSize = (node: any): number => {
      const colNodes = labelGroups.get(node.x) || [];
      if (colNodes.length <= 3) return 11;
      if (colNodes.length <= 5) return 10;
      return 9;
    };

    // Truncate long names for crowded columns
    const getTruncatedName = (node: any): string => {
      const colNodes = labelGroups.get(node.x) || [];
      const maxLen = colNodes.length > 4 ? 18 : colNodes.length > 2 ? 26 : 40;
      return node.name.length > maxLen ? node.name.slice(0, maxLen - 1) + '…' : node.name;
    };

    // Compute label positions with collision avoidance
    const computeLabelPositions = (columnNodes: any[]): Map<number, number> => {
      const positions = new Map<number, number>();
      const sorted = [...columnNodes].sort((a: any, b: any) => a.y0 - b.y0);
      const minGap = columnNodes.length > 4 ? 22 : 28;

      // Initial positions at node center
      sorted.forEach((n: any) => {
        positions.set(n.id, (n.y0 + n.y1) / 2);
      });

      // Push overlapping labels apart (2 passes)
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < sorted.length; i++) {
          const prevY = positions.get(sorted[i - 1].id)!;
          const currY = positions.get(sorted[i].id)!;
          if (currY - prevY < minGap) {
            const shift = (minGap - (currY - prevY)) / 2;
            positions.set(sorted[i - 1].id, prevY - shift);
            positions.set(sorted[i].id, currY + shift);
          }
        }
      }
      return positions;
    };

    const labelPositionsByColumn = new Map<number, Map<number, number>>();
    labelGroups.forEach((colNodes: any, colIdx: number) => {
      labelPositionsByColumn.set(colIdx, computeLabelPositions(colNodes));
    });

    const getLabelY = (node: any): number => {
      return labelPositionsByColumn.get(node.x)?.get(node.id) ?? ((node.y0 + node.y1) / 2);
    };

    svg.append("g").selectAll("text").data(nodes).join("text")
      .attr("x", (d: any) => d.x === 0 ? d.x0 - 10 : d.x1 + 10)
      .attr("y", (d: any) => getLabelY(d))
      .attr("dy", "-0.35em")
      .attr("text-anchor", (d: any) => d.x === 0 ? "end" : "start")
      .attr("fill", "#1e293b")
      .attr("font-size", (d: any) => `${getLabelFontSize(d)}px`)
      .attr("font-weight", "600")
      .text((d: any) => getTruncatedName(d));

    svg.append("g").selectAll("text").data(nodes).join("text")
      .attr("x", (d: any) => d.x === 0 ? d.x0 - 10 : d.x1 + 10)
      .attr("y", (d: any) => getLabelY(d) + 12)
      .attr("dy", "0.35em")
      .attr("text-anchor", (d: any) => d.x === 0 ? "end" : "start")
      .attr("fill", "#64748b")
      .attr("font-size", (d: any) => `${getValueFontSize(d)}px`)
      .attr("font-weight", "500")
      .text((d: any) => `$${d.value.toLocaleString()}`);

    svg.append("text")
      .attr("x", width / 2)
      .attr("y", 25)
      .attr("text-anchor", "middle")
      .attr("fill", "#0f172a")
      .attr("font-size", "18px")
      .attr("font-weight", "700")
      .text(`Rental Property Cash Flow - Year ${selectedYear}`);

  }, [inputs, selectedYear]);

  return (
    <div className="w-full rounded-xl border bg-white p-4 overflow-hidden">
      <div className="relative w-full" style={{ height: '600px' }}>
        <div className="absolute top-2 right-2 z-20">
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(Number(e.target.value))}
            className="px-3 py-1.5 border border-slate-300 rounded-lg shadow-sm bg-white text-slate-700 font-semibold cursor-pointer hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map((year) => (
              <option key={year} value={year}>Year {year}</option>
            ))}
          </select>
        </div>
        
        <svg ref={svgRef} className="w-full h-full"></svg>
        
        {hoveredNode && (
          <div className="absolute top-16 right-2 bg-white text-slate-800 p-4 rounded-xl shadow-2xl border border-slate-200 z-10">
            <div className="font-bold text-base mb-1" style={{ color: hoveredNode.color }}>{hoveredNode.name}</div>
            <div className="text-2xl font-bold text-slate-900">${hoveredNode.value.toLocaleString()}</div>
          </div>
        )}

        {hoveredLink && (
          <div className="absolute top-16 right-2 bg-white text-slate-800 p-4 rounded-xl shadow-2xl border border-slate-200 z-10">
            <div className="text-sm text-slate-500 mb-1">Flow</div>
            <div className="font-semibold text-slate-900 mb-1">{hoveredLink.source.name} → {hoveredLink.target.name}</div>
            <div className="text-xl font-bold" style={{ color: hoveredLink.target.color }}>${hoveredLink.value.toLocaleString()}</div>
          </div>
        )}
        
        <div className="absolute bottom-2 left-2 bg-white text-slate-800 p-3 rounded-xl shadow-lg border border-slate-200 z-10">
          <div className="text-xs font-semibold text-slate-500 mb-2 tracking-wide">LEGEND</div>
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-green-500"></div>
              <span className="text-slate-700">Income</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-red-500"></div>
              <span className="text-slate-700">Expenses</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// ITEMIZED INCOME-EXPENSES CHART COMPONENT (from App.tsx)
// ============================================================================

interface ItemizedIncomeExpensesChartProps {
  income: number[];
  expenseBreakdown: {
    taxes: number[];
    insurance: number[];
    utilities: number[];
    hoa: number[];
    repairs: number[];
    management: number[];
    debtService: number[];
  };
  dataInThousands?: boolean;
  xLabels?: string[];
}

const ItemizedIncomeExpensesChart: React.FC<ItemizedIncomeExpensesChartProps> = ({
  income,
  expenseBreakdown,
  dataInThousands = false,
  xLabels
}) => {
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  
  const years = income.length;
  const labels = xLabels || generateYearLabels(years);
  
  // Calculate total expenses for each year
  const totalExpenses = income.map((_, i) => 
    expenseBreakdown.taxes[i] +
    expenseBreakdown.insurance[i] +
    expenseBreakdown.utilities[i] +
    expenseBreakdown.hoa[i] +
    expenseBreakdown.repairs[i] +
    expenseBreakdown.management[i] +
    expenseBreakdown.debtService[i]
  );
  
  // Find max value for scaling
  const allValues = [...income, ...totalExpenses];
  const maxVal = Math.max(...allValues, 0);
  const niceMax = (() => {
    if (maxVal <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(maxVal)));
    const steps = [1, 2, 2.5, 5, 7.5, 10];
    for (const s of steps) {
      const n = s * mag;
      if (n >= maxVal * 1.05) return n;
    }
    return maxVal * 1.1;
  })();
  
  const chartW = 400, chartH = 200;
  const padL = 40, padR = 10, padT = 20, padB = 30;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;
  
  const barGap = 8;
  const pairGap = 16;
  const groupCount = years;
  const groupWidth = (innerW - (groupCount - 1) * barGap) / groupCount;
  const barWidth = Math.max((groupWidth - pairGap) / 2, 5);
  
  const tickCount = 6;
  const tickVals: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    tickVals.push((niceMax * i) / (tickCount - 1));
  }
  
  const formatMoney = (v: number) => {
    const val = dataInThousands ? v : v / 1000;
    return `$${val.toFixed(0)}k`;
  };
  
  const expenseColors = {
    taxes: '#fbbf24',
    insurance: '#f472b6',
    utilities: '#a78bfa',
    hoa: '#fb923c',
    repairs: '#ef4444',
    management: '#06b6d4',
    debtService: '#b45309',
  };
  
  return (
    <div className="h-full relative">
      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-full">
        {/* Gradient definitions */}
        <defs>
          <linearGradient id="incomeGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#10b981" stopOpacity="1" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.7" />
          </linearGradient>
          <filter id="incExpShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodOpacity="0.1"/>
          </filter>
        </defs>
        
        {/* Grid lines - softer dashed style */}
        {tickVals.map(tv => {
          const y = padT + innerH - (tv / niceMax) * innerH;
          return <line key={tv} x1={padL} x2={padL + innerW} y1={y} y2={y} stroke="#f0f0f0" strokeWidth={1} strokeDasharray="4 4" />;
        })}
        
        {/* Y-axis labels - improved typography */}
        {tickVals.map(tv => {
          const y = padT + innerH - (tv / niceMax) * innerH;
          return (
            <text key={`ytick-${tv}`} x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#6b7280" fontWeight="500" fontFamily="Inter, system-ui, sans-serif">
              {tv === 0 ? '$0' : formatMoney(tv)}
            </text>
          );
        })}
        
        {/* Bars for each year */}
        {income.map((incVal, i) => {
          const groupX = padL + i * (groupWidth + barGap);
          const incomeX = groupX;
          const expenseX = groupX + barWidth + pairGap;
          
          const incH = (incVal / niceMax) * innerH;
          const incY = padT + innerH - incH;
          
          let stackY = padT + innerH;
          const expenseCategories: Array<keyof typeof expenseBreakdown> = [
            'debtService', 'taxes', 'repairs', 'management', 'insurance', 'utilities', 'hoa'
          ];
          const isHovered = hoveredIndex === i;
          
          return (
            <g key={i} onMouseEnter={() => setHoveredIndex(i)} onMouseLeave={() => setHoveredIndex(null)} style={{ cursor: 'pointer' }}>
              {/* Income bar with gradient */}
              <rect
                x={incomeX}
                y={incY}
                width={barWidth}
                height={incH}
                rx={4}
                ry={4}
                fill="url(#incomeGradient)"
                opacity={isHovered ? 1 : 0.85}
                filter={isHovered ? 'url(#incExpShadow)' : undefined}
                style={{ transition: 'all 0.15s ease-out' }}
              />
              
              {/* Stacked expense bars with improved styling */}
              {expenseCategories.map(category => {
                const categoryVal = expenseBreakdown[category][i];
                const catH = (categoryVal / niceMax) * innerH;
                stackY -= catH;
                
                return (
                  <rect
                    key={category}
                    x={expenseX}
                    y={stackY}
                    width={barWidth}
                    height={catH}
                    rx={2}
                    ry={2}
                    fill={expenseColors[category]}
                    opacity={isHovered ? 1 : 0.85}
                    filter={isHovered ? 'url(#incExpShadow)' : undefined}
                    style={{ transition: 'all 0.15s ease-out' }}
                  />
                );
              })}
              
              {/* Year label - improved styling */}
              <text
                x={groupX + groupWidth / 2}
                y={chartH - 8}
                textAnchor="end"
                fontSize={9}
                fill="#6b7280"
                fontWeight="500"
                fontFamily="Inter, system-ui, sans-serif"
                transform={`rotate(-45 ${groupX + groupWidth / 2} ${chartH - 8})`}
              >
                {labels[i]}
              </text>
            </g>
          );
        })}
        
        {/* Improved Legend with rounded rectangles */}
        <g transform={`translate(${padL}, ${padT - 12})`}>
          <rect x={0} y={-1} width={10} height={8} rx={2} fill="#10b981" />
          <text x={12} y={6} fontSize={8} fill="#6b7280" fontFamily="Inter, system-ui, sans-serif" fontWeight="500">Income</text>
          
          <rect x={50} y={-1} width={10} height={8} rx={2} fill="#b45309" />
          <text x={62} y={6} fontSize={8} fill="#6b7280" fontFamily="Inter, system-ui, sans-serif" fontWeight="500">Debt</text>
          
          <rect x={90} y={-1} width={10} height={8} rx={2} fill="#fbbf24" />
          <text x={102} y={6} fontSize={8} fill="#6b7280" fontFamily="Inter, system-ui, sans-serif" fontWeight="500">Tax</text>
          
          <rect x={125} y={-1} width={10} height={8} rx={2} fill="#ef4444" />
          <text x={137} y={6} fontSize={8} fill="#6b7280" fontFamily="Inter, system-ui, sans-serif" fontWeight="500">Repairs</text>
          
          <rect x={175} y={-1} width={10} height={8} rx={2} fill="#06b6d4" />
          <text x={187} y={6} fontSize={8} fill="#6b7280" fontFamily="Inter, system-ui, sans-serif" fontWeight="500">Mgmt</text>
          
          <rect x={220} y={-1} width={10} height={8} rx={2} fill="#f472b6" />
          <text x={232} y={6} fontSize={8} fill="#6b7280" fontFamily="Inter, system-ui, sans-serif" fontWeight="500">Ins</text>
        </g>
      </svg>
      
      {/* Enhanced Tooltip */}
      {hoveredIndex !== null && (
        <div 
          className="absolute z-50 bg-gray-900/95 backdrop-blur-sm text-white px-4 py-3 rounded-xl shadow-xl text-xs pointer-events-none border border-gray-700/50"
          style={{ left: '50%', top: '20px', transform: 'translateX(-50%)' }}
        >
          <div className="font-semibold mb-2 text-gray-100">{labels[hoveredIndex]}</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: '#10b981' }}></div>
              <span className="text-gray-300">Income:</span>
              <span className="font-medium">{formatMoney(income[hoveredIndex])}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: '#b45309' }}></div>
              <span className="text-gray-300">Debt:</span>
              <span className="font-medium">{formatMoney(expenseBreakdown.debtService[hoveredIndex])}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: '#fbbf24' }}></div>
              <span className="text-gray-300">Tax:</span>
              <span className="font-medium">{formatMoney(expenseBreakdown.taxes[hoveredIndex])}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: '#ef4444' }}></div>
              <span className="text-gray-300">Repairs:</span>
              <span className="font-medium">{formatMoney(expenseBreakdown.repairs[hoveredIndex])}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// ANALYTICS CHARTS SECTION COMPONENT
// ============================================================================

interface AnalyticsChartsSectionProps {
  analysis: ComprehensivePropertyAnalysis;
  listPrice: number;
  downPaymentPercent: number;
}

const AnalyticsChartsSection: React.FC<AnalyticsChartsSectionProps> = ({ analysis, listPrice, downPaymentPercent }) => {
  const financialInputs = useMemo(() => 
    deriveFinancialInputsFromAnalysis(analysis, listPrice, downPaymentPercent),
    [analysis, listPrice, downPaymentPercent]
  );
  
  const cashFlowData = useMemo(() => calculateCashFlow(financialInputs), [financialInputs]);
  const incomeExpenseData = useMemo(() => calculateIncomeExpenses(financialInputs), [financialInputs]);
  const cocData = useMemo(() => calculateCoCReturn(financialInputs), [financialInputs]);
  const noiData = useMemo(() => calculateNOI(financialInputs), [financialInputs]);
  const propertyAppreciation = useMemo(() => calculatePropertyAppreciation(financialInputs), [financialInputs]);
  const mortgageData = useMemo(() => calculateMortgageAmortization(financialInputs), [financialInputs]);
  const totalReturnData = useMemo(() => calculateTotalReturn(financialInputs), [financialInputs]);

  // Period toggle buttons component
  const PeriodToggle = ({ 
    options, 
    selected, 
    onChange 
  }: { 
    options: string[]; 
    selected: string; 
    onChange: (val: string) => void;
  }) => (
    <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-all duration-200 ${
            selected === opt 
              ? 'bg-cyan-500 text-white shadow-sm' 
              : 'text-gray-600 hover:text-gray-800'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
  
  return (
    <div className="space-y-6">
      {/* Additional Analytics Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold text-gray-900">Additional Analytics</h3>
        <PeriodToggle 
          options={['Quarterly', 'Quarterly (TTM)', 'Annually']} 
          selected="Quarterly" 
          onChange={() => {}} 
        />
      </div>
      
      {/* Row 1: Price History, Cash Flow, Income-Expenses */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <ChartCard 
          title="Price History (AVM)" 
          badge="AVM"
          badgeColor="purple"
          rightContent={
            <div className="flex items-center gap-1 text-xs mr-2">
              <button className="bg-blue-500 text-white px-2.5 py-1 rounded-md font-medium hover:bg-blue-600 transition-colors">Qtr</button>
              <button className="text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md hover:bg-gray-100 transition-colors">Yr</button>
              <select className="border border-gray-300 rounded-md px-2 py-1 text-gray-600 bg-white cursor-pointer hover:border-gray-400 transition-colors ml-1">
                <option>3Y</option>
                <option>5Y</option>
                <option>10Y</option>
              </select>
            </div>
          }
        >
          <div className="h-full flex items-center justify-center text-gray-400 text-sm bg-gradient-to-br from-gray-50 to-gray-100 rounded-lg">
            <div className="text-center">
              <svg className="w-8 h-8 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
              </svg>
              <span>No historical data</span>
            </div>
          </div>
        </ChartCard>
        
        <ChartCard title="Cash Flow" badgeColor="blue">
          <ProfessionalBarChart
            data={cashFlowData}
            color="#3b82f6"
            allowNegative={true}
            dataLabel="Cash Flow"
            dataInThousands={true}
          />
        </ChartCard>
        
        <ChartCard 
          title="Income - Expenses" 
          badge="KPI"
          badgeColor="green"
        >
          <ItemizedIncomeExpensesChart
            income={incomeExpenseData.income}
            expenseBreakdown={incomeExpenseData.expenseBreakdown}
            dataInThousands={true}
          />
        </ChartCard>
      </div>
      
      {/* Row 2: Tax History, Cash on Cash, Mortgage Amortization */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <ChartCard 
          title="Tax History" 
          rightContent={
            <select className="text-xs border border-gray-300 rounded-md px-2 py-1 text-gray-600 bg-white cursor-pointer hover:border-gray-400 transition-colors mr-2">
              <option>All</option>
              <option>5 Years</option>
              <option>3 Years</option>
            </select>
          }
        >
          <div className="h-full flex items-center justify-center text-gray-400 text-sm bg-gradient-to-br from-gray-50 to-gray-100 rounded-lg">
            <div className="text-center">
              <svg className="w-8 h-8 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <span>No tax data</span>
            </div>
          </div>
        </ChartCard>
        
        <ChartCard 
          title="Cash on Cash Return" 
          subtitle="Annual % Return"
          badge="ROI"
          badgeColor="orange"
        >
          <ProfessionalBarChart
            data={cocData}
            color="#f97316"
            isPercentage={true}
            isCurrency={false}
            allowNegative={true}
            dataLabel="CoC Return"
          />
        </ChartCard>
        
        <ChartCard 
          title="Mortgage Amortization" 
          subtitle="Loan Balance"
          rightContent={
            <select className="text-xs border border-gray-300 rounded-md px-2 py-1 text-gray-600 bg-white cursor-pointer hover:border-gray-400 transition-colors mr-2">
              <option>10 Years</option>
              <option>15 Years</option>
              <option>30 Years</option>
            </select>
          }
        >
          <ProfessionalBarChart
            data={mortgageData.principal}
            secondaryData={mortgageData.interest}
            color="#06b6d4"
            secondaryColor="#0891b2"
            dataLabel="Principal"
            secondaryLabel="Interest"
            dataInThousands={true}
          />
        </ChartCard>
      </div>
      
      {/* Row 3: NOI, Equity Accumulated, Total Return */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <ChartCard 
          title="Net Operating Income" 
          badge="NOI"
          badgeColor="green"
        >
          <ProfessionalBarChart
            data={noiData}
            color="#10b981"
            allowNegative={noiData.some(v => v < 0)}
            dataLabel="NOI"
            dataInThousands={true}
          />
        </ChartCard>
        
        <ChartCard 
          title="Equity & Appreciation" 
          badge="Wealth"
          badgeColor="purple"
        >
          <ProfessionalBarChart
            data={propertyAppreciation.equity}
            secondaryData={propertyAppreciation.loan}
            color="#10b981"
            secondaryColor="#94a3b8"
            dataLabel="Equity"
            secondaryLabel="Loan Balance"
            dataInThousands={true}
          />
        </ChartCard>
        
        <ChartCard 
          title="Total Return" 
          subtitle="Cumulative"
          badge="IRR"
          badgeColor="cyan"
        >
          <ProfessionalBarChart
            data={totalReturnData.cumulative}
            color="#0ea5e9"
            dataLabel="Total Return"
            dataInThousands={true}
            allowNegative={true}
          />
        </ChartCard>
      </div>
      
      {/* Sankey Diagram */}
      <div className="mt-6">
        <RentalSankeyDiagram inputs={financialInputs} />
      </div>
    </div>
  );
};

interface AdvancedPropertyAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Region filter types
interface RegionFilters {
  city: string;
  state: string;
  zip: string;
  minPrice: string;
  maxPrice: string;
  minBeds: string;
  maxBeds: string;
  minBaths: string;
  maxBaths: string;
  minSqft: string;
  maxSqft: string;
  minYear: string;
  maxYear: string;
  propertyType: string;
  status: string;
}

interface MLSProperty {
  LISTINGKEY: string;
  LISTINGID: string;
  LISTPRICE: number;
  STREETNUMBER: string;
  STREETNAME: string;
  STREETSUFFIX: string;
  CITY: string;
  STATEORPROVINCE: string;
  POSTALCODE: string;
  COUNTYORPARISH: string;
  BEDROOMSTOTAL: number;
  BATHROOMSTOTALINTEGER: number;
  BATHROOMSFULL: number;
  BATHROOMSHALF: number;
  LIVINGAREA: number;
  LOTSIZEAREA: number;
  LOTSIZEUNITS: string;
  YEARBUILT: number;
  PROPERTYTYPE: string;
  PROPERTYSUBTYPE: string;
  STANDARDSTATUS: string;
  ARCHITECTURALSTYLE: string;
  LATITUDE: number;
  LONGITUDE: number;
  PUBLICREMARKS: string;
  PHOTOSCOUNT: number;
  DAYSONMARKET: number;
  MODIFICATIONTIMESTAMP: string;
  primaryImage?: string;
}

interface SnowflakeStats {
  cities: { city: string; state: string; count: number }[];
  statuses: { status: string; count: number }[];
  propertyTypes: { type: string; count: number }[];
}

export const AdvancedPropertyAnalysisModal: React.FC<AdvancedPropertyAnalysisModalProps> = ({
  isOpen,
  onClose
}) => {
  // Analysis mode: 'individual' or 'region'
  const [analysisMode, setAnalysisMode] = useState<'individual' | 'region'>('individual');
  
  // Individual property analysis state
  const [address, setAddress] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [downPaymentPercent, setDownPaymentPercent] = useState('20');
  const [photos, setPhotos] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ComprehensivePropertyAnalysis | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'valuation' | 'rental' | 'market' | 'renovation' | 'wedges' | 'action'>('overview');

  // Region analysis state
  const [regionFilters, setRegionFilters] = useState<RegionFilters>({
    city: '',
    state: '',
    zip: '',
    minPrice: '',
    maxPrice: '',
    minBeds: '',
    maxBeds: '',
    minBaths: '',
    maxBaths: '',
    minSqft: '',
    maxSqft: '',
    minYear: '',
    maxYear: '',
    propertyType: '',
    status: 'Active'
  });
  const [snowflakeStats, setSnowflakeStats] = useState<SnowflakeStats | null>(null);
  const [regionProperties, setRegionProperties] = useState<MLSProperty[]>([]);
  const [regionLoading, setRegionLoading] = useState(false);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<MLSProperty | null>(null);
  const [analyzingProperty, setAnalyzingProperty] = useState<string | null>(null);
  const [regionAnalyses, setRegionAnalyses] = useState<Map<string, ComprehensivePropertyAnalysis>>(new Map());

  // Fetch Snowflake stats on mount
  useEffect(() => {
    if (isOpen && analysisMode === 'region' && !snowflakeStats) {
      fetchSnowflakeStats();
    }
  }, [isOpen, analysisMode]);

  const fetchSnowflakeStats = async () => {
    try {
      // Use the same endpoint structure as MLSDataExplorerModal
      const response = await fetch('/api/mls/markets');
      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.markets) {
          // Transform markets to match expected format
          const cities = data.markets.map((m: any) => ({
            city: m.city,
            state: m.state,
            count: 0 // Not available from this endpoint
          }));
          setSnowflakeStats({ cities, statuses: [], propertyTypes: [] });
        }
      }
    } catch (err) {
      console.error('Failed to fetch Snowflake stats:', err);
    }
  };

  const handleRegionSearch = async () => {
    console.log('[RegionSearch] Starting search with filters:', regionFilters);
    setRegionError(null);
    setRegionLoading(true);
    setRegionProperties([]);

    try {
      const params = new URLSearchParams();
      
      if (regionFilters.city) params.set('city', regionFilters.city);
      if (regionFilters.state) params.set('state', regionFilters.state);
      if (regionFilters.zip) params.set('zip', regionFilters.zip);
      if (regionFilters.minPrice) params.set('minPrice', regionFilters.minPrice);
      if (regionFilters.maxPrice) params.set('maxPrice', regionFilters.maxPrice);
      if (regionFilters.minBeds) params.set('minBeds', regionFilters.minBeds);
      if (regionFilters.maxBeds) params.set('maxBeds', regionFilters.maxBeds);
      if (regionFilters.minBaths) params.set('minBaths', regionFilters.minBaths);
      if (regionFilters.maxBaths) params.set('maxBaths', regionFilters.maxBaths);
      if (regionFilters.status) params.set('status', regionFilters.status);
      params.set('limit', '100');

      // Use the same endpoint as MLSDataExplorerModal (which has working images)
      const url = `/api/mls/search?${params.toString()}`;
      console.log('[RegionSearch] Fetching:', url);
      
      const response = await fetch(url);
      const data = await response.json();
      console.log('[RegionSearch] Response:', data);

      if (data.ok) {
        console.log('[RegionSearch] Found', data.properties?.length || 0, 'properties');
        // Filter by sqft and year on client side (not in Snowflake query)
        let filtered = data.properties || [];
        if (regionFilters.minSqft) {
          filtered = filtered.filter((p: MLSProperty) => p.LIVINGAREA >= parseInt(regionFilters.minSqft));
        }
        if (regionFilters.maxSqft) {
          filtered = filtered.filter((p: MLSProperty) => p.LIVINGAREA <= parseInt(regionFilters.maxSqft));
        }
        if (regionFilters.minYear) {
          filtered = filtered.filter((p: MLSProperty) => p.YEARBUILT >= parseInt(regionFilters.minYear));
        }
        if (regionFilters.maxYear) {
          filtered = filtered.filter((p: MLSProperty) => p.YEARBUILT <= parseInt(regionFilters.maxYear));
        }
        // Filter by property type on client side
        if (regionFilters.propertyType) {
          filtered = filtered.filter((p: MLSProperty) => 
            p.PROPERTYTYPE?.toLowerCase().includes(regionFilters.propertyType.toLowerCase()) ||
            p.PROPERTYSUBTYPE?.toLowerCase().includes(regionFilters.propertyType.toLowerCase())
          );
        }
        console.log('[RegionSearch] After filtering:', filtered.length, 'properties');
        setRegionProperties(filtered);
      } else {
        console.error('[RegionSearch] Error:', data.error);
        setRegionError(data.error || 'Search failed');
      }
    } catch (err) {
      console.error('[RegionSearch] Fetch error:', err);
      setRegionError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setRegionLoading(false);
    }
  };

  const analyzeRegionProperty = async (property: MLSProperty) => {
    setAnalyzingProperty(property.LISTINGKEY);
    
    try {
      const fullAddress = `${property.STREETNUMBER} ${property.STREETNAME} ${property.STREETSUFFIX || ''}, ${property.CITY}, ${property.STATEORPROVINCE} ${property.POSTALCODE}`.trim();
      const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
      
      // Fetch ATTOM data
      const attomResponse = await fetch(`${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(fullAddress)}`);
      
      if (!attomResponse.ok) {
        throw new Error('Failed to fetch ATTOM data');
      }

      const attomData = await attomResponse.json();
      
      if (!attomData.ok || !attomData.data) {
        throw new Error('Property not found in ATTOM');
      }

      // Transform for analysis
      const dashboard = attomData.data;
      const canonicalPropertyProfile = buildCanonicalPropertyProfile(dashboard);
      const canonicalVisualEvidence = createEmptyCanonicalVisualEvidence(
        0,
        'unavailable',
        'Region batch analysis did not include listing photos for canonical visual evidence extraction.'
      );
      const transformedProperty = {
        ...dashboard.summary,
        tax_history: dashboard.tax_history || [],
        tax_meta: dashboard.tax_meta || { count: 0, cagr_full: 0, cagr_5yr: 0 },
        avm_history: dashboard.avm_history || [],
        building_permits: dashboard.building_permits,
        schools: dashboard.schools,
        environmental: dashboard.environmental,
        parcel_geometry: dashboard.parcel_geometry,
        school_district: dashboard.school_district,
        transportation_noise: dashboard.transportation_noise
      };

      // Run comprehensive analysis
      const result = await analyzePropertyComprehensive(
        transformedProperty,
        null, // No photos for batch analysis
        property.LISTPRICE,
        undefined,
        20, // Default 20% down
        {
          canonicalPropertyProfile,
          canonicalVisualEvidence,
        }
      );

      // Store analysis result
      setRegionAnalyses(prev => new Map(prev).set(property.LISTINGKEY, result));
      
    } catch (err) {
      console.error('Failed to analyze property:', err);
    } finally {
      setAnalyzingProperty(null);
    }
  };

  const analyzeAllProperties = async () => {
    for (const property of regionProperties) {
      if (!regionAnalyses.has(property.LISTINGKEY)) {
        await analyzeRegionProperty(property);
        // Small delay to not overwhelm the API
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!address.trim()) {
      setError('Please enter a property address');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      // Step 1: Fetch ATTOM property data
      const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
      
      console.log('[AdvancedAnalysis] Fetching ATTOM data for:', address);
      const attomResponse = await fetch(`${baseUrl}/api/attom/dashboard?address=${encodeURIComponent(address)}`);
      
      if (!attomResponse.ok) {
        throw new Error('Failed to fetch property data from ATTOM');
      }

      const attomData = await attomResponse.json();
      console.log('[AdvancedAnalysis] ATTOM response:', attomData);
      
      if (!attomData.ok || !attomData.data) {
        throw new Error(attomData.error || 'Property not found in ATTOM database. Please verify the address is correct and try again.');
      }

      // Step 2: Process uploaded photos with Visual AI
      let visualAIData = null;
      let canonicalVisualEvidence = createEmptyCanonicalVisualEvidence(
        0,
        'unavailable',
        'No photos were uploaded for canonical visual evidence extraction.'
      );
      if (photos.length > 0) {
        // Convert uploaded photos to base64
        console.log('[AdvancedAnalysis] Processing', photos.length, 'uploaded photos...');
        const photoPromises = photos.map(file => {
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
        });
        const base64Photos = await Promise.all(photoPromises);
        
        // Analyze photos with GPT-4 Vision
        console.log('[AdvancedAnalysis] Analyzing photos with GPT-4 Vision...');
        visualAIData = await analyzePropertyPhotos(base64Photos);
        canonicalVisualEvidence = visualAIData?.canonicalEvidence || createEmptyCanonicalVisualEvidence(
          base64Photos.length,
          'partial',
          'Legacy visual analysis completed without canonical visual evidence payload.'
        );
        console.log('[AdvancedAnalysis] Visual AI analysis complete');
        console.log('[AdvancedAnalysis] Visual AI renovation_opportunities:', visualAIData?.renovation_opportunities);
      } else {
        console.log('[AdvancedAnalysis] No photos provided, using default condition estimates');
      }

      // Step 3: Run comprehensive analysis
      console.log('[AdvancedAnalysis] Running comprehensive analysis...');
      
      // Parse listing price if provided
      const parsedListPrice = listPrice ? parseFloat(listPrice.replace(/,/g, '')) : undefined;
      console.log('[AdvancedAnalysis] List price:', parsedListPrice || 'Not provided');
      
      // Transform dashboard structure to AttomProperty format
      // Backend returns { summary: {...}, tax_history: [...], ... }
      // But AttomProperty expects flat structure with summary fields at top level
      const dashboard = attomData.data;
      const canonicalPropertyProfile = buildCanonicalPropertyProfile(dashboard);
      const transformedProperty: AttomProperty = {
        ...dashboard.summary,
        tax_history: dashboard.tax_history || [],
        tax_meta: dashboard.tax_meta || { count: 0, cagr_full: 0, cagr_5yr: 0 },
        avm_history: dashboard.avm_history || [],
        building_permits: dashboard.building_permits,
        schools: dashboard.schools,
        hazard_scores: dashboard.hazard_scores,
        noiseLevel: dashboard.noiseLevel,
        environmental: dashboard.environmental,
        parcel_geometry: dashboard.parcel_geometry,
        school_district: dashboard.school_district,
        transportation_noise: dashboard.transportation_noise
      };
      
      console.log('[AdvancedAnalysis] Transformed property data:', {
        avm_value: transformedProperty.avm_value,
        avm_range: `$${transformedProperty.avm_low?.toLocaleString()} - $${transformedProperty.avm_high?.toLocaleString()}`,
        beds: transformedProperty.beds,
        baths: transformedProperty.baths,
        living_sqft: transformedProperty.living_sqft,
        rental_avm: transformedProperty.rental_avm,
        rental_range: `$${transformedProperty.rental_avm_low} - $${transformedProperty.rental_avm_high}`,
        has_mortgage: !!transformedProperty.mortgage,
        mortgage: transformedProperty.mortgage ? {
          lender: transformedProperty.mortgage.lender_name,
          amount: transformedProperty.mortgage.amount,
          rate: transformedProperty.mortgage.estimated_interest_rate,
          loan_type: transformedProperty.mortgage.loan_type,
          date: transformedProperty.mortgage.date,
          assumable: transformedProperty.mortgage.assumability?.assumable,
          remainingBalance: transformedProperty.mortgage.assumability?.remainingBalance,
          monthsRemaining: transformedProperty.mortgage.assumability?.monthsRemaining
        } : 'No mortgage data'
      });
      
      console.log('[AdvancedAnalysis] Full mortgage object:', transformedProperty.mortgage);
      
      const parsedDownPayment = parseFloat(downPaymentPercent) || 20;
      console.log('[AdvancedAnalysis] Down payment:', parsedDownPayment + '%');
      
      // Fetch sales comparables
      console.log('[AdvancedAnalysis] Fetching sales comparables...');
      let salesComps = undefined;
      try {
        const compsResponse = await fetch(
          `/api/attom/comparables?address=${encodeURIComponent(address)}&radius=1.0&maxResults=10` +
          `&minBeds=${Math.max(1, (transformedProperty.beds || 3) - 1)}` +
          `&maxBeds=${(transformedProperty.beds || 3) + 1}` +
          `&minSqft=${Math.round((transformedProperty.living_sqft || 1500) * 0.7)}` +
          `&maxSqft=${Math.round((transformedProperty.living_sqft || 1500) * 1.3)}` +
          `&minYearBuilt=${Math.max(1900, (transformedProperty.year_built || 1980) - 20)}` +
          `&maxYearBuilt=${(transformedProperty.year_built || 1980) + 20}`
        );
        
        if (compsResponse.ok) {
          const compsData = await compsResponse.json();
          salesComps = compsData.data;
          console.log(`[AdvancedAnalysis] Found ${salesComps?.length || 0} sales comparables`);
        } else {
          console.log('[AdvancedAnalysis] Failed to fetch comparables:', compsResponse.status);
        }
      } catch (compsError) {
        console.error('[AdvancedAnalysis] Error fetching comparables:', compsError);
      }
      
      const result = await analyzePropertyComprehensive(
        transformedProperty,
        visualAIData,
        parsedListPrice,
        salesComps, // Now passing actual sales comps!
        parsedDownPayment,
        {
          canonicalPropertyProfile,
          canonicalVisualEvidence,
        }
      );

      console.log('[AdvancedAnalysis] Analysis result:', result);
      console.log('[AdvancedAnalysis] Valuation:', result.valuation);
      console.log('[AdvancedAnalysis] As-Is Rental:', result.asIs);
      console.log('[AdvancedAnalysis] Rental Income breakdown:', {
        attomRentalAVM: result.asIs?.income?.attomRentalAVM,
        adjustedMarketRent: result.asIs?.income?.adjustedMarketRent,
        finalMonthlyRent: result.asIs?.income?.finalMonthlyRent,
        conditionAdjustment: result.asIs?.income?.conditionAdjustment
      });
      console.log('[AdvancedAnalysis] Condition Score:', {
        overallGrade: result.asIs?.condition?.overallGrade,
        overallScore: result.asIs?.condition?.overallScore,
        aiRenovationOpportunities: result.asIs?.condition?.aiRenovationOpportunities?.length || 0
      });
      console.log('[AdvancedAnalysis] Renovation Plan:', result.postRenovation?.renovationPlan);
      console.log('[AdvancedAnalysis] Wedge Opportunities:', result.wedgeOpportunities);

      setAnalysis(result);
      setActiveTab('overview');

    } catch (err) {
      console.error('[AdvancedAnalysis] Error:', err);
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setAddress('');
    setListPrice('');
    setPhotos([]);
    setImagePreviews([]);
    setAnalysis(null);
    setError(null);
    setActiveTab('overview');
    // Reset region state
    setRegionProperties([]);
    setRegionError(null);
    setSelectedProperty(null);
    setRegionAnalyses(new Map());
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files).filter(file => {
        // Accept all common image formats
        return file.type.startsWith('image/') || 
               /\.(jpg|jpeg|png|gif|bmp|webp|svg|heic|heif)$/i.test(file.name);
      });
      if (newFiles.length > 0) {
        setPhotos(prev => [...prev, ...newFiles]);
        
        // Generate previews
        newFiles.forEach(file => {
          const reader = new FileReader();
          reader.onloadend = () => {
            setImagePreviews(prev => [...prev, reader.result as string]);
          };
          reader.readAsDataURL(file);
        });
      }
    }
  };

  const removePhoto = (index: number) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
    setImagePreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files).filter(file => {
      // Accept all common image formats
      return file.type.startsWith('image/') || 
             /\.(jpg|jpeg|png|gif|bmp|webp|svg|heic|heif)$/i.test(file.name);
    });
    
    if (files.length > 0) {
      setPhotos(prev => [...prev, ...files]);
      
      // Generate previews
      files.forEach(file => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setImagePreviews(prev => [...prev, reader.result as string]);
        };
        reader.readAsDataURL(file);
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl max-w-6xl w-full max-h-[95vh] overflow-hidden flex flex-col my-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-xl font-semibold text-gray-900">
            {!analysis && regionProperties.length === 0 ? 'Property Analysis' : 'Investment Analysis Report'}
          </h2>
          <button
            onClick={() => {
              resetForm();
              onClose();
            }}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            disabled={loading || regionLoading}
          >
            <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Mode Tabs - Only show when not viewing results */}
        {!analysis && regionProperties.length === 0 && (
          <div className="flex border-b px-6">
            <button
              onClick={() => setAnalysisMode('individual')}
              className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
                analysisMode === 'individual'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              🏠 Analyze Individual Property
            </button>
            <button
              onClick={() => setAnalysisMode('region')}
              className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
                analysisMode === 'region'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              🗺️ Analyze Region
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Region Analysis Mode */}
          {analysisMode === 'region' && !analysis && regionProperties.length === 0 ? (
            <div className="p-6">
              {/* Available Markets Banner */}
              {snowflakeStats && (
                <div className="mb-6 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-100">
                  <h3 className="text-sm font-semibold text-blue-800 mb-2">📊 Available MLS Markets</h3>
                  <div className="flex flex-wrap gap-2">
                    {snowflakeStats.cities.slice(0, 10).map((c, i) => (
                      <button
                        key={i}
                        onClick={() => setRegionFilters(prev => ({ ...prev, city: c.city, state: c.state }))}
                        className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                          regionFilters.city === c.city 
                            ? 'bg-blue-600 text-white' 
                            : 'bg-white text-blue-700 hover:bg-blue-100 border border-blue-200'
                        }`}
                      >
                        {c.city}, {c.state} ({c.count})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Region Filters */}
              <div className="space-y-4">
                {/* Location Row */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
                    <input
                      type="text"
                      value={regionFilters.city}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, city: e.target.value }))}
                      placeholder="e.g., Portland"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">State</label>
                    <input
                      type="text"
                      value={regionFilters.state}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, state: e.target.value }))}
                      placeholder="e.g., OR"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">ZIP Code</label>
                    <input
                      type="text"
                      value={regionFilters.zip}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, zip: e.target.value }))}
                      placeholder="e.g., 97201"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Price Range */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Min Price</label>
                    <input
                      type="text"
                      value={regionFilters.minPrice}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, minPrice: e.target.value.replace(/[^0-9]/g, '') }))}
                      placeholder="$200,000"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Max Price</label>
                    <input
                      type="text"
                      value={regionFilters.maxPrice}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, maxPrice: e.target.value.replace(/[^0-9]/g, '') }))}
                      placeholder="$500,000"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Beds & Baths */}
                <div className="grid grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Min Beds</label>
                    <select
                      value={regionFilters.minBeds}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, minBeds: e.target.value }))}
                      className="w-full px-4 py-2.5 bg-gray-900 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Any</option>
                      {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}+</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Max Beds</label>
                    <select
                      value={regionFilters.maxBeds}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, maxBeds: e.target.value }))}
                      className="w-full px-4 py-2.5 bg-gray-900 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Any</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Min Baths</label>
                    <select
                      value={regionFilters.minBaths}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, minBaths: e.target.value }))}
                      className="w-full px-4 py-2.5 bg-gray-900 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Any</option>
                      {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}+</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Max Baths</label>
                    <select
                      value={regionFilters.maxBaths}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, maxBaths: e.target.value }))}
                      className="w-full px-4 py-2.5 bg-gray-900 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Any</option>
                      {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>

                {/* Square Footage & Year Built */}
                <div className="grid grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Min Sqft</label>
                    <input
                      type="text"
                      value={regionFilters.minSqft}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, minSqft: e.target.value.replace(/[^0-9]/g, '') }))}
                      placeholder="1,000"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Max Sqft</label>
                    <input
                      type="text"
                      value={regionFilters.maxSqft}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, maxSqft: e.target.value.replace(/[^0-9]/g, '') }))}
                      placeholder="3,000"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Year Built (Min)</label>
                    <input
                      type="text"
                      value={regionFilters.minYear}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, minYear: e.target.value.replace(/[^0-9]/g, '') }))}
                      placeholder="1950"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Year Built (Max)</label>
                    <input
                      type="text"
                      value={regionFilters.maxYear}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, maxYear: e.target.value.replace(/[^0-9]/g, '') }))}
                      placeholder="2024"
                      className="w-full px-4 py-2.5 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Property Type & Status */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Property Type</label>
                    <select
                      value={regionFilters.propertyType}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, propertyType: e.target.value }))}
                      className="w-full px-4 py-2.5 bg-gray-900 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">All Types</option>
                      <option value="Residential">Single Family</option>
                      <option value="Condo">Condo</option>
                      <option value="Townhouse">Townhouse</option>
                      <option value="Multi-Family">Multi-Family / Duplex</option>
                      <option value="Land">Land</option>
                      <option value="Commercial">Commercial</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Listing Status</label>
                    <select
                      value={regionFilters.status}
                      onChange={(e) => setRegionFilters(prev => ({ ...prev, status: e.target.value }))}
                      className="w-full px-4 py-2.5 bg-gray-900 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">All Statuses</option>
                      <option value="Active">Active</option>
                      <option value="Pending">Pending</option>
                      <option value="Coming Soon">Coming Soon</option>
                      <option value="Active Under Contract">Active Under Contract</option>
                    </select>
                  </div>
                </div>

                {/* Error Message */}
                {regionError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                    {regionError}
                  </div>
                )}

                {/* Search Button */}
                <button
                  type="button"
                  onClick={handleRegionSearch}
                  disabled={regionLoading || (!regionFilters.city && !regionFilters.state && !regionFilters.zip)}
                  className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {regionLoading ? (
                    <>
                      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Searching MLS Data...
                    </>
                  ) : (
                    <>
                      🔍 Search Properties
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : regionProperties.length > 0 && !analysis ? (
            /* Region Search Results */
            <div className="p-6">
              {/* Results Header */}
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {regionProperties.length} Properties Found
                  </h3>
                  <p className="text-sm text-gray-500">
                    {regionFilters.city && `${regionFilters.city}, `}{regionFilters.state} {regionFilters.zip}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRegionProperties([])}
                    className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    ← Modify Search
                  </button>
                  <button
                    onClick={analyzeAllProperties}
                    disabled={analyzingProperty !== null}
                    className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-green-600 to-emerald-600 rounded-lg hover:from-green-700 hover:to-emerald-700 disabled:opacity-50"
                  >
                    {analyzingProperty ? 'Analyzing...' : '🚀 Analyze All'}
                  </button>
                </div>
              </div>

              {/* Property Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[60vh] overflow-y-auto">
                {regionProperties.map((property) => {
                  const propertyAnalysis = regionAnalyses.get(property.LISTINGKEY);
                  const isAnalyzing = analyzingProperty === property.LISTINGKEY;
                  
                  return (
                    <div
                      key={property.LISTINGKEY}
                      className="bg-white border rounded-xl overflow-hidden hover:shadow-lg transition-shadow"
                    >
                      {/* Property Image */}
                      <div className="relative h-40 bg-gray-100">
                        {property.primaryImage ? (
                          <img
                            src={property.primaryImage}
                            alt={`${property.STREETNUMBER} ${property.STREETNAME}`}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                          </div>
                        )}
                        {/* Status Badge */}
                        <div className={`absolute top-2 left-2 px-2 py-1 text-xs font-semibold rounded ${
                          property.STANDARDSTATUS === 'Active' ? 'bg-green-500 text-white' :
                          property.STANDARDSTATUS === 'Pending' ? 'bg-yellow-500 text-white' :
                          'bg-gray-500 text-white'
                        }`}>
                          {property.STANDARDSTATUS}
                        </div>
                        {/* Price */}
                        <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 text-white text-sm font-bold rounded">
                          ${property.LISTPRICE?.toLocaleString()}
                        </div>
                      </div>

                      {/* Property Info */}
                      <div className="p-3">
                        <h4 className="font-semibold text-gray-900 text-sm truncate">
                          {property.STREETNUMBER} {property.STREETNAME} {property.STREETSUFFIX || ''}
                        </h4>
                        <p className="text-xs text-gray-500 mb-2">
                          {property.CITY}, {property.STATEORPROVINCE} {property.POSTALCODE}
                        </p>
                        
                        {/* Property Details */}
                        <div className="flex items-center gap-3 text-xs text-gray-600 mb-3">
                          <span>{property.BEDROOMSTOTAL} bed</span>
                          <span>{property.BATHROOMSTOTALINTEGER} bath</span>
                          <span>{property.LIVINGAREA?.toLocaleString()} sqft</span>
                          <span>{property.YEARBUILT}</span>
                        </div>

                        {/* Analysis Status / Action */}
                        {propertyAnalysis ? (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-gray-500">Cap Rate</span>
                              <span className="font-semibold text-green-600">
                                {propertyAnalysis.asIs?.capRate?.toFixed(1)}%
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-gray-500">Cash Flow</span>
                              <span className={`font-semibold ${(propertyAnalysis.asIs?.cashFlow?.annual || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                ${propertyAnalysis.asIs?.cashFlow?.annual?.toLocaleString()}/yr
                              </span>
                            </div>
                            <button
                              onClick={() => {
                                setAnalysis(propertyAnalysis);
                                setActiveTab('overview');
                              }}
                              className="w-full mt-2 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50"
                            >
                              View Full Analysis →
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => analyzeRegionProperty(property)}
                            disabled={isAnalyzing}
                            className="w-full py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1"
                          >
                            {isAnalyzing ? (
                              <>
                                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                Analyzing...
                              </>
                            ) : (
                              '📊 Analyze Property'
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : !analysis ? (
            // Input Form - Simplified Layout matching wireframe
            <div className="p-6">
              <form onSubmit={handleAnalyze} className="space-y-4">
                {/* Row 1: Address and Current Listing Price */}
                <div className="flex gap-4">
                  {/* Address Input */}
                  <div className="flex-1">
                    <input
                      type="text"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="Address"
                      className="w-full px-4 py-3 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                      required
                      disabled={loading}
                    />
                  </div>

                  {/* Current Listing Price Input */}
                  <div className="w-48">
                    <input
                      type="text"
                      value={listPrice}
                      onChange={(e) => {
                        const value = e.target.value.replace(/[^0-9]/g, '');
                        setListPrice(value ? parseInt(value).toLocaleString() : '');
                      }}
                      placeholder="Current Listing Price"
                      className="w-full px-4 py-3 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                      required
                      disabled={loading}
                    />
                  </div>
                </div>

                {/* Row 2: Down Payment */}
                <div>
                  <input
                    type="text"
                    value={downPaymentPercent}
                    onChange={(e) => setDownPaymentPercent(e.target.value)}
                    placeholder="Down Payment $ or %"
                    className="w-full px-4 py-3 bg-gray-900 text-white placeholder-gray-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                    disabled={loading}
                  />
                </div>

                {/* Photo Upload Area */}
                <div 
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-all ${
                    isDragging 
                      ? 'border-blue-500 bg-blue-50' 
                      : 'border-gray-300 hover:border-gray-400 bg-gray-50'
                  } cursor-pointer`}
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('photo-upload')?.click()}
                >
                  <input
                    type="file"
                    accept="image/*,.png,.jpg,.jpeg,.gif,.bmp,.webp,.svg,.heic,.heif"
                    multiple
                    onChange={handlePhotoUpload}
                    className="hidden"
                    id="photo-upload"
                    disabled={loading}
                  />
                  {isDragging ? (
                    <p className="text-lg font-medium text-blue-600">
                      Drop images here!
                    </p>
                  ) : (
                    <>
                      <p className="text-lg font-medium text-gray-700">
                        {photos.length === 0 ? '+ Add Property Photos' : `${photos.length} photos added`}
                      </p>
                      <p className="text-sm text-gray-500 mt-1">
                        (25-30 Recommended)
                      </p>
                    </>
                  )}
                </div>
                
                {/* Photo Previews */}
                {imagePreviews.length > 0 && (
                  <div className="grid grid-cols-6 gap-2 max-h-48 overflow-y-auto">
                    {imagePreviews.map((preview, index) => (
                      <div key={index} className="relative group">
                        <img
                          src={preview}
                          alt={`Property ${index + 1}`}
                          className="w-full h-16 object-cover rounded-lg border border-gray-200"
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removePhoto(index);
                          }}
                          className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          disabled={loading}
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Error Message */}
                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <p className="text-sm text-red-800">{error}</p>
                  </div>
                )}

                {/* Analyze Button */}
                <button
                  type="submit"
                  disabled={loading || !address}
                  className="w-full bg-gray-900 text-white font-semibold py-4 rounded-lg hover:bg-gray-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></div>
                      Analyzing...
                    </span>
                  ) : (
                    'Analyze'
                  )}
                </button>
              </form>
            </div>
          ) : null}

          {/* Results Display - Overview (when analysis exists and activeTab is overview) */}
          {analysis && activeTab === 'overview' && (
            <div className="flex flex-col h-full overflow-y-auto">
              {/* Main Content Grid */}
              <div className="p-6 space-y-4">
                
                {/* TOP ROW: Property Image | Price History | Valuation */}
                <div className="grid grid-cols-3 gap-4">
                  {/* Property Image */}
                  <div className="bg-gray-100 rounded-lg border-2 border-gray-300 aspect-[4/3] flex items-center justify-center">
                    {imagePreviews.length > 0 ? (
                      <img 
                        src={imagePreviews[0]} 
                        alt="Property" 
                        className="w-full h-full object-cover rounded-lg"
                      />
                    ) : (
                      <div className="text-center text-gray-400">
                        <svg className="w-12 h-12 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <p className="text-sm">Property Image</p>
                      </div>
                    )}
                  </div>

                  {/* Price History Chart */}
                  <div className="bg-white rounded-lg border-2 border-gray-300 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-semibold text-gray-700">Price History</h4>
                      <span className="text-xs bg-gray-100 px-2 py-1 rounded">5 Yrs</span>
                    </div>
                    <div className="h-24 flex items-end justify-between gap-1">
                      {/* Simple bar chart visualization */}
                      {[65, 70, 72, 78, 85, 90, 100].map((height, i) => (
                        <div 
                          key={i} 
                          className="flex-1 bg-blue-500 rounded-t"
                          style={{ height: `${height}%` }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Valuation Box */}
                  <div className="bg-white rounded-lg border-2 border-gray-300 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-semibold text-gray-700">Valuation</h4>
                      <button className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200">
                        View More
                      </button>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-600">List Price:</span>
                        <span className="font-semibold">${analysis.valuation.listPrice.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">HouseYield Valuation:</span>
                        <span className="font-semibold">${analysis.valuation.indicatedValue.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Amount Variance:</span>
                        <span className={`font-semibold ${analysis.valuation.valuationGap < 0 ? 'text-green-600' : 'text-red-600'}`}>
                          ${Math.abs(analysis.valuation.valuationGap).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">% Variance:</span>
                        <span className={`font-semibold ${analysis.valuation.valuationGapPercent < 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {analysis.valuation.valuationGapPercent > 0 ? '+' : ''}{analysis.valuation.valuationGapPercent.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                    <div className={`mt-3 pt-2 border-t text-center font-bold ${
                      analysis.valuation.status === 'undervalued' ? 'text-green-600' : 
                      analysis.valuation.status === 'overvalued' ? 'text-red-600' : 'text-yellow-600'
                    }`}>
                      Signal: {analysis.valuation.status === 'undervalued' ? 'Undervalued - Buy' : 
                               analysis.valuation.status === 'overvalued' ? 'Overvalued - Pass' : 'Fair Value'}
                    </div>
                  </div>
                </div>

                {/* MIDDLE ROW: Property Details | Condition | Mortgage | Rental Viability */}
                <div className="grid grid-cols-4 gap-4">
                  {/* Property Details */}
                  <div className="text-sm space-y-1">
                    <div className="font-semibold text-gray-900">{address}</div>
                    <div className="text-gray-600">
                      {analysis.property.beds || 'N/A'} Bed / {analysis.property.baths} Bath
                    </div>
                    <div className="text-gray-600">
                      Sqft: {analysis.property.sqft?.toLocaleString() || 'N/A'}
                    </div>
                    <div className="text-gray-600">
                      Year: {analysis.property.yearBuilt || 'N/A'}
                    </div>
                    <div className="text-gray-600">
                      Age: {analysis.property.yearBuilt ? new Date().getFullYear() - analysis.property.yearBuilt : 'N/A'}
                    </div>
                  </div>

                  {/* Property Condition Box */}
                  <div className="bg-white rounded-lg border-2 border-gray-300 p-3">
                    <h4 className="text-xs font-semibold text-gray-500 mb-2">Property Condition</h4>
                    <div className="text-2xl font-bold text-gray-900 mb-1">
                      {analysis.asIs?.condition?.overallGrade || 'B'}
                    </div>
                    <div className="text-sm">
                      <span className="text-gray-600">Rental Viability: </span>
                      <span className={`font-semibold ${
                        analysis.asIs?.viability === 'excellent' || analysis.asIs?.viability === 'good' 
                          ? 'text-green-600' : 'text-yellow-600'
                      }`}>
                        {analysis.asIs?.viability === 'excellent' ? 'High' :
                         analysis.asIs?.viability === 'good' ? 'High' :
                         analysis.asIs?.viability === 'marginal' ? 'Medium' : 'Low'}
                      </span>
                    </div>
                  </div>

                  {/* Mortgage Box */}
                  <div className="bg-white rounded-lg border-2 border-gray-300 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <h4 className="text-xs font-semibold text-gray-500">Mortgage</h4>
                      {analysis.asIs?.financingOptions?.[0]?.assumedLoan && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">
                          Assumable
                        </span>
                      )}
                    </div>
                    {analysis.asIs?.financingOptions?.[0]?.assumedLoan ? (
                      <div className="text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className="text-gray-600">Assumable Balance:</span>
                          <span className="font-semibold">${analysis.asIs.financingOptions[0].assumedLoan.balance.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Assumable IR:</span>
                          <span className="font-semibold text-green-600">{analysis.asIs.financingOptions[0].assumedLoan.rate.toFixed(2)}%</span>
                        </div>
                        {analysis.asIs.financingOptions[0].newLoan && (
                          <>
                            <div className="flex justify-between">
                              <span className="text-gray-600">+ Additional Financing:</span>
                              <span className="font-semibold">${analysis.asIs.financingOptions[0].newLoan.amount.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-600">Interest Rate:</span>
                              <span className="font-semibold">{analysis.asIs.financingOptions[0].newLoan.rate}%</span>
                            </div>
                          </>
                        )}
                        <div className="flex justify-between pt-1 border-t">
                          <span className="text-gray-600">Total Monthly Payment:</span>
                          <span className="font-bold">${analysis.asIs.financingOptions[0].totalMonthlyDebtService.toLocaleString()}/m</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className="text-gray-600">Loan Amount:</span>
                          <span className="font-semibold">${(analysis.asIs?.financingOptions?.[0]?.newLoan?.amount || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Interest Rate:</span>
                          <span className="font-semibold">{analysis.asIs?.financingOptions?.[0]?.newLoan?.rate || 7}%</span>
                        </div>
                        <div className="flex justify-between pt-1 border-t">
                          <span className="text-gray-600">Monthly P&I:</span>
                          <span className="font-bold">${(analysis.asIs?.financingOptions?.[0]?.totalMonthlyDebtService || 0).toLocaleString()}/m</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Rental Viability Box */}
                  <div className="bg-white rounded-lg border-2 border-gray-300 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-gray-500">Rental Viability</h4>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                        analysis.asIs?.viability === 'excellent' || analysis.asIs?.viability === 'good'
                          ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                      }`}>
                        {analysis.asIs?.viability === 'excellent' ? '✓' : 
                         analysis.asIs?.viability === 'good' ? '✓' : '!'}
                      </span>
                    </div>
                    <div className="text-xs space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-600">Rental Income:</span>
                        <span className="font-semibold text-green-600">${analysis.asIs?.income?.finalMonthlyRent?.toLocaleString() || 0}/month</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Op Ex:</span>
                        <span className="font-semibold text-red-600">-${Math.round(analysis.asIs?.expenses?.total || 0).toLocaleString()}/month</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Mortgage:</span>
                        <span className="font-semibold text-red-600">-${(analysis.asIs?.financingOptions?.[0]?.totalMonthlyDebtService || 0).toLocaleString()}/month</span>
                      </div>
                      <div className="flex justify-between pt-1 border-t">
                        <span className="text-gray-700 font-medium">Cash Flow:</span>
                        <span className={`font-bold ${(analysis.asIs?.cashFlow?.monthlyCashFlow || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          ${analysis.asIs?.cashFlow?.monthlyCashFlow?.toLocaleString() || 0}/month
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* MARKET HEAT ROW: Regional Market Analysis */}
                {analysis.regionalMarket && (
                  <div className="bg-gradient-to-r from-gray-50 to-white rounded-lg border-2 border-gray-300 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <h4 className="text-sm font-semibold text-gray-700">Regional Market Heat</h4>
                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                          analysis.regionalMarket.marketHeat === 'very_hot' ? 'bg-red-500 text-white' :
                          analysis.regionalMarket.marketHeat === 'hot' ? 'bg-orange-500 text-white' :
                          analysis.regionalMarket.marketHeat === 'warm' ? 'bg-yellow-500 text-white' :
                          analysis.regionalMarket.marketHeat === 'neutral' ? 'bg-gray-400 text-white' :
                          analysis.regionalMarket.marketHeat === 'cool' ? 'bg-blue-400 text-white' :
                          analysis.regionalMarket.marketHeat === 'cold' ? 'bg-blue-600 text-white' :
                          'bg-blue-800 text-white'
                        }`}>
                          {analysis.regionalMarket.marketHeat.replace('_', ' ').toUpperCase()} MARKET
                        </span>
                        <span className="text-sm text-gray-500">
                          {analysis.regionalMarket.metroArea}, {analysis.regionalMarket.stateCode}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Market Score</span>
                        <div className="flex items-center gap-1">
                          <div className="w-24 h-3 bg-gray-200 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${
                                analysis.regionalMarket.marketHeatScore >= 70 ? 'bg-gradient-to-r from-orange-400 to-red-500' :
                                analysis.regionalMarket.marketHeatScore >= 50 ? 'bg-gradient-to-r from-yellow-400 to-orange-400' :
                                'bg-gradient-to-r from-blue-400 to-blue-600'
                              }`}
                              style={{ width: `${analysis.regionalMarket.marketHeatScore}%` }}
                            />
                          </div>
                          <span className="text-sm font-bold text-gray-700">{analysis.regionalMarket.marketHeatScore}</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-5 gap-4">
                      {/* Key Indicators */}
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Employment</div>
                        <div className="flex items-center gap-2">
                          <span className={`text-lg font-bold ${
                            analysis.regionalMarket.economicData.unemployment.score >= 70 ? 'text-green-600' :
                            analysis.regionalMarket.economicData.unemployment.score >= 40 ? 'text-yellow-600' : 'text-red-600'
                          }`}>
                            {analysis.regionalMarket.economicData.unemployment.value.toFixed(1)}%
                          </span>
                          <span className="text-xs text-gray-500">unemp.</span>
                        </div>
                        <div className="text-xs text-gray-600">
                          {analysis.regionalMarket.economicData.unemployment.nationalComparison === 'above_average' ? '✓ Below natl avg' :
                           analysis.regionalMarket.economicData.unemployment.nationalComparison === 'below_average' ? '⚠ Above natl avg' : 
                           '• At natl avg'}
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Job Growth</div>
                        <div className="flex items-center gap-2">
                          <span className={`text-lg font-bold ${
                            analysis.regionalMarket.economicData.jobGrowth.value >= 2 ? 'text-green-600' :
                            analysis.regionalMarket.economicData.jobGrowth.value >= 1 ? 'text-yellow-600' : 'text-red-600'
                          }`}>
                            {analysis.regionalMarket.economicData.jobGrowth.value >= 0 ? '+' : ''}{analysis.regionalMarket.economicData.jobGrowth.value.toFixed(1)}%
                          </span>
                        </div>
                        <div className="text-xs text-gray-600">
                          {analysis.regionalMarket.economicData.jobGrowth.trend === 'improving' ? '↗ Growing' :
                           analysis.regionalMarket.economicData.jobGrowth.trend === 'declining' ? '↘ Slowing' : '→ Stable'}
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Vacancy Risk</div>
                        <div className={`text-lg font-bold ${
                          analysis.regionalMarket.vacancyRisk === 'very_low' || analysis.regionalMarket.vacancyRisk === 'low' ? 'text-green-600' :
                          analysis.regionalMarket.vacancyRisk === 'moderate' ? 'text-yellow-600' : 'text-red-600'
                        }`}>
                          {analysis.regionalMarket.vacancyRisk.replace('_', ' ').charAt(0).toUpperCase() + analysis.regionalMarket.vacancyRisk.replace('_', ' ').slice(1)}
                        </div>
                        <div className="text-xs text-gray-600">
                          {analysis.regionalMarket.economicData.vacancyRate.value.toFixed(1)}% vacancy rate
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Rental Demand</div>
                        <div className={`text-lg font-bold ${
                          analysis.regionalMarket.demandSignals.rentalDemand === 'very_high' || analysis.regionalMarket.demandSignals.rentalDemand === 'high' ? 'text-green-600' :
                          analysis.regionalMarket.demandSignals.rentalDemand === 'moderate' ? 'text-yellow-600' : 'text-red-600'
                        }`}>
                          {analysis.regionalMarket.demandSignals.rentalDemand.replace('_', ' ').charAt(0).toUpperCase() + analysis.regionalMarket.demandSignals.rentalDemand.replace('_', ' ').slice(1)}
                        </div>
                        <div className="text-xs text-gray-600">
                          Rent growth: {analysis.regionalMarket.economicData.rentGrowth.value >= 0 ? '+' : ''}{analysis.regionalMarket.economicData.rentGrowth.value.toFixed(1)}%
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Investment Score</div>
                        <div className="flex items-center gap-2">
                          <span className={`text-lg font-bold ${
                            analysis.regionalMarket.investmentViability >= 70 ? 'text-green-600' :
                            analysis.regionalMarket.investmentViability >= 50 ? 'text-yellow-600' : 'text-red-600'
                          }`}>
                            {analysis.regionalMarket.investmentViability}
                          </span>
                          <span className="text-xs text-gray-500">/ 100</span>
                        </div>
                        <div className="text-xs text-gray-600">
                          {analysis.regionalMarket.investmentViability >= 70 ? '✓ Favorable' :
                           analysis.regionalMarket.investmentViability >= 50 ? '• Moderate' : '⚠ Challenging'}
                        </div>
                      </div>
                    </div>
                    
                    {/* Market Summary */}
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <p className="text-xs text-gray-600 leading-relaxed">
                        {analysis.regionalMarket.summary}
                      </p>
                    </div>
                  </div>
                )}

                {/* BOTTOM ROW: Wedge Deal Scenarios | Rental Analysis | Valuation Analysis */}
                <div className="border-t-2 border-gray-300 pt-4">
                  <div className="grid grid-cols-3 gap-4">
                    
                    {/* Wedge Deal Scenarios */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 mb-3 border-b pb-2">Wedge Deal Scenarios</h4>
                      <div className="space-y-3">
                        {analysis.postRenovation?.renovationPlan?.scope?.slice(0, 3).map((item: { item: string; cost: number }, i: number) => (
                          <div key={i} className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold">
                              {i + 1}
                            </div>
                            <div className="flex-1">
                              <div className="text-sm font-medium text-gray-900">Renovate {item.item}</div>
                              <div className="text-xs text-gray-500 mt-1">
                                {imagePreviews.length > i + 1 && (
                                  <img 
                                    src={imagePreviews[i + 1]} 
                                    alt={item.item}
                                    className="w-16 h-12 object-cover rounded border mt-1"
                                  />
                                )}
                                <span className="italic">Highlight renovation area in image</span>
                              </div>
                            </div>
                          </div>
                        )) || (
                          <div className="text-sm text-gray-500 italic">
                            Upload photos to identify renovation opportunities
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Rental Analysis */}
                    <div className="border-l-2 border-gray-300 pl-4">
                      <h4 className="text-sm font-semibold text-gray-700 mb-3 border-b pb-2">Rental Analysis</h4>
                      {analysis.postRenovation?.renovationPlan?.scope?.[0] && (
                        <div className="bg-gray-50 rounded-lg p-3">
                          <div className="text-sm font-medium text-gray-900 mb-2">
                            Run Scenario 1
                          </div>
                          <div className="text-xs space-y-1">
                            <div className="flex justify-between">
                              <span className="text-gray-600">Cost:</span>
                              <span className="font-semibold">${analysis.postRenovation.renovationPlan.scope[0].cost.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-600">Value Lift:</span>
                              <span className="font-semibold text-green-600">
                                ${(analysis.postRenovation.roi?.forcedAppreciation || 0).toLocaleString()} 
                                <span className="text-gray-500 ml-1">
                                  (+{((analysis.postRenovation.roi?.forcedAppreciation || 0) / analysis.valuation.listPrice * 100).toFixed(0)}%)
                                </span>
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-600">Post-Reno Rent:</span>
                              <span className="font-semibold">
                                ${analysis.postRenovation.income?.finalMonthlyRent?.toLocaleString() || 'N/A'}
                                <span className="text-green-600 ml-1">
                                  (+{analysis.transformation?.rentIncreasePercent?.toFixed(0) || 0}%)
                                </span>
                              </span>
                            </div>
                            <div className="flex justify-between pt-1 border-t">
                              <span className="text-gray-600">ROI:</span>
                              <span className="font-bold text-green-600">{analysis.postRenovation.roi?.percentROI?.toFixed(0) || 0}%</span>
                            </div>
                          </div>
                        </div>
                      ) || (
                        <div className="text-sm text-gray-500 italic">
                          No renovation scenarios available
                        </div>
                      )}
                    </div>

                    {/* Valuation Analysis */}
                    <div className="border-l-2 border-gray-300 pl-4">
                      <h4 className="text-sm font-semibold text-gray-700 mb-3 border-b pb-2">Valuation Analysis</h4>
                      <div className="space-y-3">
                        {analysis.postRenovation?.renovationPlan?.scope?.slice(0, 2).map((item: { item: string; cost: number }, i: number) => (
                          <div key={i} className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">
                              {i + 1}
                            </div>
                            <div className="flex-1">
                              <div className="text-sm font-medium text-gray-900">{item.item}</div>
                              {imagePreviews.length > i + 2 && (
                                <img 
                                  src={imagePreviews[i + 2]} 
                                  alt={item.item}
                                  className="w-16 h-12 object-cover rounded border mt-1"
                                />
                              )}
                            </div>
                            <button className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                              <span>View Scenario</span>
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </button>
                          </div>
                        )) || (
                          <div className="text-sm text-gray-500 italic">
                            No valuation scenarios available
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Analytics Charts Section */}
                <div className="border-t-2 border-gray-300 pt-4 mt-4">
                  <AnalyticsChartsSection 
                    analysis={analysis}
                    listPrice={parseFloat(listPrice.replace(/,/g, '')) || analysis.valuation.listPrice}
                    downPaymentPercent={parseFloat(downPaymentPercent) || 20}
                  />
                </div>

              </div>

              {/* Footer Actions */}
              <div className="border-t bg-gray-50 px-6 py-3 flex items-center justify-between mt-auto">
                <button
                  onClick={resetForm}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg font-medium hover:bg-gray-100 transition-colors"
                >
                  ← Analyze Another
                </button>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setActiveTab('valuation')}
                    className="px-4 py-2 text-sm border border-blue-600 text-blue-600 rounded-lg font-medium hover:bg-blue-50 transition-colors"
                  >
                    Full Report
                  </button>
                  <button className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 transition-colors">
                    Save Analysis
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Full Report View (when analysis exists and activeTab is not 'overview') */}
          {analysis && activeTab !== 'overview' && (
            <div className="flex flex-col h-full">
              {/* Tabs */}
              <div className="flex border-b bg-gray-50 px-6 gap-1 overflow-x-auto">
                <button
                  onClick={() => setActiveTab('overview')}
                  className="px-4 py-3 font-medium text-sm whitespace-nowrap transition-colors border-b-2 border-transparent text-gray-600 hover:text-gray-900"
                >
                  ← Back to Overview
                </button>
                <button
                  onClick={() => setActiveTab('valuation')}
                  className={`px-4 py-3 font-medium text-sm whitespace-nowrap transition-colors border-b-2 ${
                    activeTab === 'valuation'
                      ? 'border-blue-600 text-blue-600 bg-white'
                      : 'border-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  📊 Valuation
                </button>
                <button
                  onClick={() => setActiveTab('rental')}
                  className={`px-4 py-3 font-medium text-sm whitespace-nowrap transition-colors border-b-2 ${
                    activeTab === 'rental'
                      ? 'border-blue-600 text-blue-600 bg-white'
                      : 'border-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  💰 Rental
                </button>
                <button
                  onClick={() => setActiveTab('market')}
                  className={`px-4 py-3 font-medium text-sm whitespace-nowrap transition-colors border-b-2 ${
                    activeTab === 'market'
                      ? 'border-blue-600 text-blue-600 bg-white'
                      : 'border-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  🔥 Market
                </button>
                <button
                  onClick={() => setActiveTab('renovation')}
                  className={`px-4 py-3 font-medium text-sm whitespace-nowrap transition-colors border-b-2 ${
                    activeTab === 'renovation'
                      ? 'border-blue-600 text-blue-600 bg-white'
                      : 'border-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  🔨 Renovation
                </button>
                <button
                  onClick={() => setActiveTab('wedges')}
                  className={`px-4 py-3 font-medium text-sm whitespace-nowrap transition-colors border-b-2 relative ${
                    activeTab === 'wedges'
                      ? 'border-blue-600 text-blue-600 bg-white'
                      : 'border-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  💎 Wedges
                  {analysis.wedgeOpportunities.length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center">
                      {analysis.wedgeOpportunities.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab('action')}
                  className={`px-4 py-3 font-medium text-sm whitespace-nowrap transition-colors border-b-2 ${
                    activeTab === 'action'
                      ? 'border-blue-600 text-blue-600 bg-white'
                      : 'border-transparent text-gray-600 hover:text-gray-900'
                  }`}
                >
                  🎯 Action Plan
                </button>
              </div>

              {/* Tab Content */}
              <div className="flex-1 overflow-y-auto p-6">
                {activeTab === 'valuation' && <ValuationReport analysis={analysis} />}
                {activeTab === 'rental' && <RentalViabilityReport analysis={analysis} />}
                {activeTab === 'market' && <RegionalMarketReport analysis={analysis} />}
                {activeTab === 'renovation' && <RenovationReport analysis={analysis} />}
                {activeTab === 'wedges' && <WedgeOpportunitiesReport analysis={analysis} />}
                {activeTab === 'action' && <ActionPlanReport analysis={analysis} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// VALUATION REPORT COMPONENT - ENHANCED
// ============================================================================

const ValuationReport: React.FC<{ analysis: ComprehensivePropertyAnalysis }> = ({ analysis }) => {
  const val = analysis.valuation;
  const confMap = { high: 0.90, medium: 0.75, low: 0.60 };
  const condition = analysis.asIs?.condition;
  
  return (
    <div className="space-y-6">
      {/* Overall Assessment */}
      <div className={`rounded-xl p-6 border-2 ${
        val.status === 'undervalued' 
          ? 'bg-green-50 border-green-300'
          : val.status === 'overvalued'
          ? 'bg-red-50 border-red-300'
          : 'bg-yellow-50 border-yellow-300'
      }`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-2xl font-bold text-gray-900">
              {val.status === 'undervalued' ? '✅ Undervalued' : val.status === 'overvalued' ? '⚠️ Overvalued' : '📊 Fair Valued'}
            </h3>
            <p className="text-gray-700 mt-1">
              {val.recommendation}
            </p>
          </div>
          <div className="text-right">
            <div className="text-sm font-medium text-gray-600">Confidence</div>
            <div className="text-3xl font-bold text-gray-900">{(confMap[val.confidence] * 100).toFixed(0)}%</div>
          </div>
        </div>
        
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-lg p-4 border">
            <div className="text-sm font-medium text-gray-600">Estimated Value</div>
            <div className="text-2xl font-bold text-gray-900">${val.indicatedValue.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-lg p-4 border">
            <div className="text-sm font-medium text-gray-600">List Price</div>
            <div className="text-2xl font-bold text-gray-900">${val.listPrice.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-lg p-4 border">
            <div className="text-sm font-medium text-gray-600">Variance</div>
            <div className={`text-2xl font-bold ${val.valuationGapPercent > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {val.valuationGapPercent > 0 ? '+' : ''}{val.valuationGapPercent.toFixed(1)}%
            </div>
          </div>
        </div>
      </div>

      {/* 2-Method Breakdown - Enhanced with Visual AI */}
      <div className="bg-white rounded-xl border-2 p-6">
        <h4 className="text-lg font-bold text-gray-900 mb-4">2-Method Valuation Breakdown</h4>
        <div className="space-y-4">
          {[
            { name: 'ATTOM AVM', icon: '📊', description: 'Automated Valuation Model from ATTOM Data (35% weight)', ...val.methods.attomAVM },
            { name: 'Sales Comparison + Visual AI', icon: '🏠🤖', description: 'Comparable sales with AI condition adjustments (65% weight)', ...val.methods.salesComparison }
          ].filter(method => method.value != null).map((method) => (
            <div key={method.name} className="border rounded-lg p-4 hover:bg-gray-50 transition-colors">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{method.icon}</span>
                      <span className="font-semibold text-gray-900">{method.name}</span>
                    </div>
                    <span className="text-sm text-gray-600">Weight: {((method.weight || 0) * 100).toFixed(0)}%</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">{method.description}</p>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${(method.weight || 0) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="text-right min-w-[140px]">
                  <div className="font-bold text-gray-900 text-lg">${(method.value || 0).toLocaleString()}</div>
                  <div className={`text-xs font-medium ${
                    (method.confidence || 0) >= 0.8 ? 'text-green-600' :
                    (method.confidence || 0) >= 0.6 ? 'text-yellow-600' : 'text-red-600'
                  }`}>
                    {(method.confidence || 0) >= 0.8 ? '🟢' : (method.confidence || 0) >= 0.6 ? '🟡' : '🔴'} {((method.confidence || 0) * 100).toFixed(0)}% confidence
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        
        {/* Weighted Average Calculation */}
        <div className="mt-4 pt-4 border-t-2 border-blue-200 bg-blue-50 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <div>
              <span className="font-bold text-gray-900">Weighted Average Value</span>
              <p className="text-xs text-gray-600">Calculated from all methods based on confidence weights</p>
            </div>
            <span className="text-2xl font-bold text-blue-700">${val.methods.weightedAverage?.toLocaleString() || val.indicatedValue.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Visual AI Condition Adjustment */}
      {val.visualAIAdjustment && (
        <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl border-2 border-purple-200 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>🤖</span> Visual AI Condition Adjustment
          </h4>
          
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-700">Base Value:</span>
                <span className="font-semibold">${val.visualAIAdjustment.baseValue.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-700">Condition Multiplier:</span>
                <span className={`font-bold ${val.visualAIAdjustment.conditionMultiplier >= 1 ? 'text-green-600' : 'text-red-600'}`}>
                  {(val.visualAIAdjustment.conditionMultiplier * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-700">Deferred Maintenance:</span>
                <span className="font-semibold text-red-600">-${val.visualAIAdjustment.deferredMaintenance.toLocaleString()}</span>
              </div>
              <div className="border-t pt-2 flex justify-between items-center">
                <span className="font-bold text-gray-900">Adjusted Value:</span>
                <span className="font-bold text-lg text-purple-700">${val.visualAIAdjustment.finalAdjustedValue.toLocaleString()}</span>
              </div>
            </div>
            
            <div className="space-y-3">
              <h5 className="font-semibold text-gray-800 text-sm">Room-by-Room Impact</h5>
              <div className="space-y-2">
                <div className="flex justify-between items-center bg-white rounded px-3 py-2">
                  <span className="text-sm text-gray-700">🍳 Kitchen:</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                      val.visualAIAdjustment.roomByRoomImpact.kitchen.score >= 80 ? 'bg-green-100 text-green-700' :
                      val.visualAIAdjustment.roomByRoomImpact.kitchen.score >= 60 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {val.visualAIAdjustment.roomByRoomImpact.kitchen.score}
                    </div>
                    <span className={`text-sm font-semibold ${val.visualAIAdjustment.roomByRoomImpact.kitchen.impact >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {val.visualAIAdjustment.roomByRoomImpact.kitchen.impact >= 0 ? '+' : ''}${val.visualAIAdjustment.roomByRoomImpact.kitchen.impact.toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center bg-white rounded px-3 py-2">
                  <span className="text-sm text-gray-700">🚿 Bathrooms:</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                      val.visualAIAdjustment.roomByRoomImpact.bathrooms.score >= 80 ? 'bg-green-100 text-green-700' :
                      val.visualAIAdjustment.roomByRoomImpact.bathrooms.score >= 60 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {val.visualAIAdjustment.roomByRoomImpact.bathrooms.score}
                    </div>
                    <span className={`text-sm font-semibold ${val.visualAIAdjustment.roomByRoomImpact.bathrooms.impact >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {val.visualAIAdjustment.roomByRoomImpact.bathrooms.impact >= 0 ? '+' : ''}${val.visualAIAdjustment.roomByRoomImpact.bathrooms.impact.toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center bg-white rounded px-3 py-2">
                  <span className="text-sm text-gray-700">🏠 Overall:</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                      val.visualAIAdjustment.roomByRoomImpact.overall.score >= 80 ? 'bg-green-100 text-green-700' :
                      val.visualAIAdjustment.roomByRoomImpact.overall.score >= 60 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {val.visualAIAdjustment.roomByRoomImpact.overall.score}
                    </div>
                    <span className={`text-sm font-semibold ${val.visualAIAdjustment.roomByRoomImpact.overall.impact >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {val.visualAIAdjustment.roomByRoomImpact.overall.impact >= 0 ? '+' : ''}${val.visualAIAdjustment.roomByRoomImpact.overall.impact.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Comparable Sales Analysis */}
      {val.comparableAnalysis && val.comparableAnalysis.salesComps && val.comparableAnalysis.salesComps.length > 0 && (
        <div className="bg-white rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>🏘️</span> Sales Comparables Analysis
          </h4>
          
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-sm text-gray-600">Low $/sqft</div>
              <div className="font-bold text-lg">${val.comparableAnalysis.pricePerSqftRange?.low?.toFixed(0) || 'N/A'}</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center border-2 border-blue-200">
              <div className="text-sm text-gray-600">Median $/sqft</div>
              <div className="font-bold text-lg text-blue-700">${val.comparableAnalysis.pricePerSqftRange?.median?.toFixed(0) || 'N/A'}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-sm text-gray-600">High $/sqft</div>
              <div className="font-bold text-lg">${val.comparableAnalysis.pricePerSqftRange?.high?.toFixed(0) || 'N/A'}</div>
            </div>
          </div>
          
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {val.comparableAnalysis.salesComps.slice(0, 5).map((comp, i) => (
              <div key={i} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                <div className="flex-1">
                  <div className="font-medium text-gray-900 text-sm">{comp.address}</div>
                  <div className="text-xs text-gray-500">
                    {comp.beds}bd/{comp.baths}ba • {comp.living_sqft?.toLocaleString()} sqft • {comp.year_built}
                    {comp.distance_miles && ` • ${comp.distance_miles.toFixed(2)} mi away`}
                  </div>
                </div>
                <div className="text-right ml-4">
                  <div className="font-bold text-gray-900">${comp.sale_price?.toLocaleString()}</div>
                  {comp.adjustedPrice && comp.adjustedPrice !== comp.sale_price && (
                    <div className="text-xs text-blue-600">Adj: ${comp.adjustedPrice.toLocaleString()}</div>
                  )}
                  {comp.similarity !== undefined && (
                    <div className="text-xs text-gray-500">{(comp.similarity * 100).toFixed(0)}% similar</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          
          <div className="mt-3 pt-3 border-t text-center">
            <span className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${
              val.comparableAnalysis.confidence === 'high' ? 'bg-green-100 text-green-700' :
              val.comparableAnalysis.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              {val.comparableAnalysis.confidence?.toUpperCase()} Confidence ({val.comparableAnalysis.salesComps.length} comps)
            </span>
          </div>
        </div>
      )}

      {/* Condition Score Summary */}
      {condition && (
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border-2 border-amber-200 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>📋</span> Property Condition Assessment
          </h4>
          
          <div className="grid grid-cols-4 gap-4 mb-4">
            <div className="bg-white rounded-lg p-4 text-center border">
              <div className="text-3xl font-bold text-amber-700">{condition.overallGrade}</div>
              <div className="text-sm text-gray-600">Overall Grade</div>
            </div>
            <div className="bg-white rounded-lg p-4 text-center border">
              <div className="text-3xl font-bold text-gray-900">{Math.round(condition.overallScore)}</div>
              <div className="text-sm text-gray-600">Score (0-100)</div>
            </div>
            <div className="bg-white rounded-lg p-4 text-center border">
              <div className="text-3xl font-bold text-red-600">${condition.totalDeferredCost.toLocaleString()}</div>
              <div className="text-sm text-gray-600">Deferred Maintenance</div>
            </div>
            <div className="bg-white rounded-lg p-4 text-center border">
              <div className="text-3xl font-bold text-green-600">{(condition.renovationPotential * 100).toFixed(0)}%</div>
              <div className="text-sm text-gray-600">Reno Potential</div>
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">🏠 Exterior</span>
                <span className={`font-bold ${condition.exterior.overallScore >= 70 ? 'text-green-600' : condition.exterior.overallScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {Math.round(condition.exterior.overallScore)}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${condition.exterior.overallScore >= 70 ? 'bg-green-500' : condition.exterior.overallScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${condition.exterior.overallScore}%` }}
                />
              </div>
            </div>
            <div className="bg-white rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">🛋️ Interior</span>
                <span className={`font-bold ${condition.interior.overallScore >= 70 ? 'text-green-600' : condition.interior.overallScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {Math.round(condition.interior.overallScore)}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${condition.interior.overallScore >= 70 ? 'bg-green-500' : condition.interior.overallScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${condition.interior.overallScore}%` }}
                />
              </div>
            </div>
            <div className="bg-white rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">⚙️ Systems</span>
                <span className={`font-bold ${condition.systems.overallScore >= 70 ? 'text-green-600' : condition.systems.overallScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {Math.round(condition.systems.overallScore)}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${condition.systems.overallScore >= 70 ? 'bg-green-500' : condition.systems.overallScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${condition.systems.overallScore}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Data Sources */}
      <div className="bg-gray-50 rounded-xl border p-6">
        <h4 className="text-sm font-semibold text-gray-700 mb-3">Data Sources</h4>
        <div className="flex flex-wrap gap-2">
          <span className="px-3 py-1 bg-white border rounded-full text-xs font-medium text-gray-700">ATTOM AVM</span>
          <span className="px-3 py-1 bg-white border rounded-full text-xs font-medium text-gray-700">Sales Comparables</span>
          <span className="px-3 py-1 bg-white border rounded-full text-xs font-medium text-gray-700">Visual AI Condition</span>
          <span className="px-3 py-1 bg-white border rounded-full text-xs font-medium text-gray-700">ATTOM AVM, Sales Comparables, Income Approach, Cost Approach</span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// RENTAL VIABILITY REPORT COMPONENT
// ============================================================================

const RentalViabilityReport: React.FC<{ analysis: ComprehensivePropertyAnalysis }> = ({ analysis }) => {
  const rental = analysis.asIs;
  if (!rental) {
    return (
      <div className="text-center py-12 text-gray-500">
        Rental analysis not available for this property
      </div>
    );
  }

  const isViable = rental.viability === 'excellent' || rental.viability === 'good';
  const monthlyCashFlow = rental.cashFlow.monthlyCashFlow;
  const capRate = rental.metrics.capRate;
  const cashOnCash = rental.metrics.cashOnCash;

  return (
    <div className="space-y-6">
      {/* Overall Viability */}
      <div className={`rounded-xl p-6 border-2 ${
        isViable 
          ? 'bg-green-50 border-green-300'
          : 'bg-red-50 border-red-300'
      }`}>
        <h3 className="text-2xl font-bold text-gray-900 mb-2">
          {isViable ? '✅ Viable Rental Property' : '❌ Not Viable as Rental'}
        </h3>
        <p className="text-gray-700">{rental.recommendation}</p>
      </div>

      {/* Cash Flow Metrics */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Monthly Cash Flow</div>
          <div className={`text-2xl font-bold ${monthlyCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            ${monthlyCashFlow.toLocaleString()}
          </div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Cap Rate</div>
          <div className="text-2xl font-bold text-gray-900">{capRate.toFixed(2)}%</div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Cash-on-Cash</div>
          <div className="text-2xl font-bold text-gray-900">{cashOnCash.toFixed(2)}%</div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Monthly Rent</div>
          <div className="text-2xl font-bold text-gray-900">${rental.income.finalMonthlyRent.toLocaleString()}</div>
        </div>
      </div>

      {/* Financing Scenarios */}
      {rental.financingOptions && rental.financingOptions.length > 0 && (
        <div className="bg-white rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4">Your Financing Scenario</h4>
          
          {rental.financingOptions.map((scenario, i) => (
            <div key={i} className="space-y-4">
              {/* Scenario Header */}
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-lg border-2 border-blue-200">
                <h5 className="text-xl font-bold text-gray-900 mb-2">{scenario.name}</h5>
                {scenario.assumedLoan && (
                  <div className="flex items-center gap-2 text-green-700 font-semibold">
                    <span className="text-2xl">🏦</span>
                    <span>Assumable Mortgage Available!</span>
                  </div>
                )}
              </div>

              {/* Key Metrics */}
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600 mb-1">Down Payment</div>
                  <div className="text-xl font-bold text-gray-900">${scenario.downPaymentAmount.toLocaleString()}</div>
                  <div className="text-xs text-gray-500">{scenario.downPaymentPercent.toFixed(1)}% of purchase</div>
                </div>
                
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600 mb-1">Monthly P&I</div>
                  <div className="text-xl font-bold text-gray-900">${scenario.totalMonthlyDebtService.toLocaleString()}</div>
                  <div className="text-xs text-gray-500">Principal & Interest</div>
                </div>
                
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600 mb-1">Total Cash Needed</div>
                  <div className="text-xl font-bold text-gray-900">${scenario.totalCashRequired.toLocaleString()}</div>
                  <div className="text-xs text-gray-500">Down + Closing Costs</div>
                </div>
                
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600 mb-1">Effective Rate</div>
                  <div className="text-xl font-bold text-gray-900">{scenario.effectiveInterestRate.toFixed(3)}%</div>
                  <div className="text-xs text-gray-500">Blended rate</div>
                </div>
              </div>

              {/* Assumable Mortgage Breakdown */}
              {scenario.assumedLoan && (
                <div className="bg-green-50 border-2 border-green-300 rounded-lg p-5">
                  <h6 className="font-bold text-green-900 text-lg mb-4 flex items-center gap-2">
                    <span>💰</span> Assumable Mortgage Breakdown
                  </h6>
                  
                  <div className="grid grid-cols-2 gap-6">
                    {/* Left Column - Assumed Loan */}
                    <div className="space-y-3">
                      <div className="font-semibold text-green-900 text-base mb-2">✅ Loan You're Assuming</div>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-gray-700">Loan Type:</span>
                          <span className="font-semibold text-gray-900">{scenario.assumedLoan.loanType}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-700">Remaining Balance:</span>
                          <span className="font-bold text-green-700">${scenario.assumedLoan.balance.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-700">Interest Rate:</span>
                          <span className="font-bold text-green-700">{scenario.assumedLoan.rate.toFixed(3)}%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-700">Months Remaining:</span>
                          <span className="font-semibold text-gray-900">{scenario.assumedLoan.remainingMonths}</span>
                        </div>
                        <div className="flex justify-between border-t pt-2">
                          <span className="text-gray-700">Monthly Payment:</span>
                          <span className="font-bold text-gray-900">${scenario.assumedLoan.monthlyPayment.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-700">Assumption Fee:</span>
                          <span className="font-semibold text-gray-900">${scenario.assumedLoan.assumptionFee?.toLocaleString() || 'N/A'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Right Column - New Loan (if needed) */}
                    {scenario.newLoan ? (
                      <div className="space-y-3">
                        <div className="font-semibold text-blue-900 text-base mb-2">➕ Additional Financing Needed</div>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-gray-700">Gap Amount:</span>
                            <span className="font-bold text-blue-700">${scenario.newLoan.amount.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-700">Interest Rate:</span>
                            <span className="font-bold text-blue-700">{scenario.newLoan.rate}%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-700">Term:</span>
                            <span className="font-semibold text-gray-900">30 years</span>
                          </div>
                          <div className="flex justify-between border-t pt-2">
                            <span className="text-gray-700">Monthly Payment:</span>
                            <span className="font-bold text-gray-900">${scenario.newLoan.monthlyPayment.toLocaleString()}</span>
                          </div>
                        </div>
                        
                        <div className="mt-3 pt-3 border-t-2 border-green-400">
                          <div className="flex justify-between items-center">
                            <span className="font-semibold text-gray-900">Total Combined P&I:</span>
                            <span className="font-bold text-xl text-gray-900">${scenario.totalMonthlyDebtService.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center text-green-700">
                        <div className="text-center">
                          <div className="text-4xl mb-2">🎉</div>
                          <div className="font-semibold">No Additional Loan Needed!</div>
                          <div className="text-sm mt-1">Your down payment + assumable balance covers the full purchase price</div>
                        </div>
                      </div>
                    )}
                  </div>

                  {scenario.assumabilityDetails && (
                    <div className="mt-4 pt-4 border-t border-green-300">
                      <div className="text-sm text-green-800">
                        <strong>Note:</strong> {scenario.assumabilityDetails.reason}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Cash Flow Comparison - Assumable vs Conventional */}
              {scenario.assumedLoan && (() => {
                // Calculate cash flow with assumable mortgage
                const grossRent = rental.income.finalMonthlyRent;
                const operatingExpenses = rental.expenses.total; // Does NOT include debt service
                const debtServiceAssumed = scenario.totalMonthlyDebtService;
                const cashFlowAssumed = grossRent - operatingExpenses - debtServiceAssumed;
                
                // Calculate what conventional mortgage would cost
                const conventionalLoanAmount = scenario.purchasePrice - scenario.downPaymentAmount;
                const conventionalRate = 7.0;
                const conventionalMonthlyPayment = (conventionalLoanAmount * (conventionalRate / 100 / 12) * Math.pow(1 + conventionalRate / 100 / 12, 360)) / (Math.pow(1 + conventionalRate / 100 / 12, 360) - 1);
                const cashFlowConventional = grossRent - operatingExpenses - conventionalMonthlyPayment;
                
                const monthlySavings = cashFlowAssumed - cashFlowConventional;
                const annualSavings = monthlySavings * 12;
                
                return (
                  <div className="bg-gradient-to-r from-purple-50 to-pink-50 border-2 border-purple-300 rounded-lg p-6 mt-4">
                    <h6 className="font-bold text-purple-900 text-lg mb-4 flex items-center gap-2">
                      <span>📊</span> Cash Flow Comparison
                    </h6>
                    
                    <div className="grid grid-cols-2 gap-6">
                      {/* Assumable Scenario */}
                      <div className="bg-white rounded-lg p-4 border-2 border-green-400">
                        <div className="text-center mb-3">
                          <div className="text-sm font-semibold text-green-700 mb-1">WITH Assumable Mortgage</div>
                          <div className="text-xs text-gray-600">({scenario.assumedLoan.loanType} @ {scenario.assumedLoan.rate.toFixed(2)}%{scenario.newLoan ? ` + Gap @ ${scenario.newLoan.rate}%` : ''})</div>
                        </div>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-gray-600">Gross Rent:</span>
                            <span className="font-semibold text-gray-900">${grossRent.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600">Operating Expenses:</span>
                            <span className="font-semibold text-red-600">-${Math.round(operatingExpenses).toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600">Debt Service (P&I):</span>
                            <span className="font-semibold text-red-600">-${Math.round(debtServiceAssumed).toLocaleString()}</span>
                          </div>
                          <div className="border-t-2 border-green-400 pt-2 mt-2 flex justify-between items-center">
                            <span className="font-bold text-gray-900">Monthly Cash Flow:</span>
                            <span className={`font-bold text-xl ${cashFlowAssumed >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              ${cashFlowAssumed.toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Conventional Scenario */}
                      <div className="bg-white rounded-lg p-4 border-2 border-gray-300">
                        <div className="text-center mb-3">
                          <div className="text-sm font-semibold text-gray-700 mb-1">WITHOUT Assumable (Conventional)</div>
                          <div className="text-xs text-gray-600">(New Loan @ {conventionalRate}%)</div>
                        </div>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-gray-600">Gross Rent:</span>
                            <span className="font-semibold text-gray-900">${grossRent.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600">Operating Expenses:</span>
                            <span className="font-semibold text-red-600">-${Math.round(operatingExpenses).toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600">Debt Service (P&I):</span>
                            <span className="font-semibold text-red-600">-${Math.round(conventionalMonthlyPayment).toLocaleString()}</span>
                          </div>
                          <div className="border-t-2 border-gray-400 pt-2 mt-2 flex justify-between items-center">
                            <span className="font-bold text-gray-900">Monthly Cash Flow:</span>
                            <span className={`font-bold text-xl ${cashFlowConventional >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              ${Math.round(cashFlowConventional).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Savings Summary */}
                    <div className="mt-4 bg-gradient-to-r from-green-100 to-emerald-100 rounded-lg p-4 border border-green-400">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-semibold text-gray-700">Monthly Savings with Assumable:</div>
                          <div className="text-xs text-gray-600 mt-1">Compared to conventional financing</div>
                        </div>
                        <div className="text-right">
                          <div className={`text-2xl font-bold ${monthlySavings >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {monthlySavings >= 0 ? '+' : ''}${Math.round(monthlySavings).toLocaleString()}/mo
                          </div>
                          <div className="text-sm text-gray-600">
                            ${Math.round(annualSavings).toLocaleString()}/year
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Regular Loan (No Assumable) */}
              {!scenario.assumedLoan && scenario.newLoan && (
                <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-5">
                  <h6 className="font-bold text-blue-900 text-lg mb-4">📋 Standard Mortgage Details</h6>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-700">Loan Amount:</span>
                      <span className="font-bold text-gray-900">${scenario.newLoan.amount.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-700">Interest Rate:</span>
                      <span className="font-bold text-gray-900">{scenario.newLoan.rate}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-700">Term:</span>
                      <span className="font-semibold text-gray-900">30 years</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-700">Monthly P&I:</span>
                      <span className="font-bold text-gray-900">${scenario.newLoan.monthlyPayment.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-gray-600">
                    💡 This property does not have an assumable mortgage, or it's a conventional loan with a due-on-sale clause.
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Income & Expenses Breakdown */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4">Monthly Income</h4>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-700">Gross Rent</span>
              <span className="font-semibold text-gray-900">${rental.income.finalMonthlyRent.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">Vacancy Loss ({(rental.expenses.vacancyRate * 100).toFixed(1)}%)</span>
              <span className="font-semibold text-red-600">-${rental.expenses.vacancy.toLocaleString()}</span>
            </div>
            <div className="border-t-2 pt-2 flex justify-between">
              <span className="font-bold text-gray-900">Effective Income</span>
              <span className="font-bold text-gray-900">${(rental.income.finalMonthlyRent - rental.expenses.vacancy).toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4">Monthly Expenses</h4>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-700">Mortgage P&I</span>
              <span className="font-semibold text-gray-900">${Math.round(rental.cashFlow.monthlyDebtService).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">Property Tax</span>
              <span className="font-semibold text-gray-900">${Math.round(rental.expenses.propertyTax).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">Insurance</span>
              <span className="font-semibold text-gray-900">${Math.round(rental.expenses.insurance).toLocaleString()}</span>
            </div>
            {rental.expenses.hoa > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-700">HOA</span>
                <span className="font-semibold text-gray-900">${Math.round(rental.expenses.hoa).toLocaleString()}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-700">Maintenance ({(rental.expenses.maintenanceRate * 100).toFixed(0)}%)</span>
              <span className="font-semibold text-gray-900">${Math.round(rental.expenses.maintenance).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">CapEx ({(rental.expenses.capexRate * 100).toFixed(0)}%)</span>
              <span className="font-semibold text-gray-900">${Math.round(rental.expenses.capex).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">Vacancy ({(rental.expenses.vacancyRate * 100).toFixed(0)}%)</span>
              <span className="font-semibold text-gray-900">${Math.round(rental.expenses.vacancy).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">Management ({(rental.expenses.managementRate * 100).toFixed(0)}%)</span>
              <span className="font-semibold text-gray-900">${Math.round(rental.expenses.propertyManagement).toLocaleString()}</span>
            </div>
            <div className="border-t-2 pt-2 flex justify-between">
              <span className="font-bold text-gray-900">Total Monthly Expenses</span>
              <span className="font-bold text-gray-900">${Math.round(rental.cashFlow.monthlyDebtService + rental.expenses.total).toLocaleString()}</span>
            </div>
            <div className="text-xs text-gray-500 mt-2">
              OpEx: ${Math.round(rental.expenses.total).toLocaleString()} + Mortgage: ${Math.round(rental.cashFlow.monthlyDebtService).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Enhanced Investment Metrics */}
      <div className="bg-gradient-to-br from-indigo-50 to-blue-50 rounded-xl border-2 border-indigo-200 p-6">
        <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
          <span>📈</span> Investment Performance Metrics
        </h4>
        
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="bg-white rounded-lg p-4 border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-600">DSCR</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                rental.metrics.dscr >= 1.25 ? 'bg-green-100 text-green-700' :
                rental.metrics.dscr >= 1.0 ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-700'
              }`}>
                {rental.metrics.dscr >= 1.25 ? 'Strong' : rental.metrics.dscr >= 1.0 ? 'Marginal' : 'Weak'}
              </span>
            </div>
            <div className="text-2xl font-bold text-gray-900">{rental.metrics.dscr.toFixed(2)}x</div>
            <div className="text-xs text-gray-500 mt-1">Debt Service Coverage Ratio</div>
          </div>
          
          <div className="bg-white rounded-lg p-4 border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-600">GRM</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                rental.metrics.grm <= 10 ? 'bg-green-100 text-green-700' :
                rental.metrics.grm <= 15 ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-700'
              }`}>
                {rental.metrics.grm <= 10 ? 'Excellent' : rental.metrics.grm <= 15 ? 'Fair' : 'High'}
              </span>
            </div>
            <div className="text-2xl font-bold text-gray-900">{rental.metrics.grm.toFixed(1)}</div>
            <div className="text-xs text-gray-500 mt-1">Gross Rent Multiplier</div>
          </div>
          
          <div className="bg-white rounded-lg p-4 border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-600">5-Year ROI</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                rental.metrics.roi5Year >= 50 ? 'bg-green-100 text-green-700' :
                rental.metrics.roi5Year >= 25 ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-700'
              }`}>
                {rental.metrics.roi5Year >= 50 ? 'Strong' : rental.metrics.roi5Year >= 25 ? 'Average' : 'Low'}
              </span>
            </div>
            <div className="text-2xl font-bold text-gray-900">{rental.metrics.roi5Year.toFixed(1)}%</div>
            <div className="text-xs text-gray-500 mt-1">Projected 5-Year Return</div>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white rounded-lg p-4 border">
            <div className="text-sm text-gray-600 mb-1">Break-Even Occupancy</div>
            <div className="flex items-center gap-3">
              <div className="text-xl font-bold text-gray-900">{(rental.metrics.breakEvenOccupancy * 100).toFixed(1)}%</div>
              <div className="flex-1 bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${rental.metrics.breakEvenOccupancy <= 0.85 ? 'bg-green-500' : rental.metrics.breakEvenOccupancy <= 0.95 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.min(rental.metrics.breakEvenOccupancy * 100, 100)}%` }}
                />
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-1">Minimum occupancy to cover expenses</div>
          </div>
          
          <div className="bg-white rounded-lg p-4 border">
            <div className="text-sm text-gray-600 mb-1">Break-Even Rent</div>
            <div className="text-xl font-bold text-gray-900">${rental.metrics.cashFlowBreakEvenRent.toFixed(0)}/mo</div>
            <div className="text-xs text-gray-500 mt-1">
              {rental.income.finalMonthlyRent >= rental.metrics.cashFlowBreakEvenRent 
                ? `✅ Current rent is $${(rental.income.finalMonthlyRent - rental.metrics.cashFlowBreakEvenRent).toFixed(0)} above break-even`
                : `⚠️ Need $${(rental.metrics.cashFlowBreakEvenRent - rental.income.finalMonthlyRent).toFixed(0)} more to break even`
              }
            </div>
          </div>
        </div>
      </div>

      {/* Expense Ratio Analysis */}
      <div className="bg-white rounded-xl border-2 p-6">
        <h4 className="text-lg font-bold text-gray-900 mb-4">Operating Expense Ratio</h4>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="flex justify-between mb-2">
              <span className="text-sm text-gray-600">Expense Ratio</span>
              <span className={`font-bold ${
                rental.expenses.expenseRatio <= 0.40 ? 'text-green-600' :
                rental.expenses.expenseRatio <= 0.50 ? 'text-yellow-600' :
                'text-red-600'
              }`}>
                {(rental.expenses.expenseRatio * 100).toFixed(1)}%
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div 
                className={`h-3 rounded-full ${
                  rental.expenses.expenseRatio <= 0.40 ? 'bg-green-500' :
                  rental.expenses.expenseRatio <= 0.50 ? 'bg-yellow-500' :
                  'bg-red-500'
                }`}
                style={{ width: `${Math.min(rental.expenses.expenseRatio * 100, 100)}%` }}
              />
            </div>
            <div className="flex justify-between mt-1 text-xs text-gray-500">
              <span>Excellent (&lt;40%)</span>
              <span>Average (40-50%)</span>
              <span>High (&gt;50%)</span>
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-gray-600">Fixed Expenses</div>
            <div className="font-bold text-gray-900">${rental.expenses.totalFixed.toFixed(0)}/mo</div>
            <div className="text-xs text-gray-500">Tax + Insurance + HOA</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-gray-600">Variable Expenses</div>
            <div className="font-bold text-gray-900">${rental.expenses.totalVariable.toFixed(0)}/mo</div>
            <div className="text-xs text-gray-500">Maint + Mgmt + Vacancy + CapEx</div>
          </div>
        </div>
      </div>

      {/* Valuation Impact on Rental - NEW SECTION */}
      {analysis.valuationImpactOnRental && (
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border-2 border-amber-200 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>💰</span> How Purchase Price Affects Your Returns
          </h4>
          
          <div className="grid grid-cols-3 gap-4 mb-6">
            {/* At List Price */}
            <div className={`bg-white rounded-lg p-4 border-2 ${
              analysis.valuationImpactOnRental.ifPurchaseAtListPrice.viable 
                ? 'border-green-300' : 'border-red-300'
            }`}>
              <div className="text-sm font-semibold text-gray-700 mb-2">At List Price</div>
              <div className="text-lg font-bold text-gray-900">
                ${analysis.valuationImpactOnRental.ifPurchaseAtListPrice.purchasePrice.toLocaleString()}
              </div>
              <div className="space-y-1 mt-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Cash Flow:</span>
                  <span className={`font-semibold ${analysis.valuationImpactOnRental.ifPurchaseAtListPrice.monthlyCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${analysis.valuationImpactOnRental.ifPurchaseAtListPrice.monthlyCashFlow.toLocaleString()}/mo
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">CoC:</span>
                  <span className="font-semibold">{analysis.valuationImpactOnRental.ifPurchaseAtListPrice.cashOnCash.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Cap Rate:</span>
                  <span className="font-semibold">{(analysis.valuationImpactOnRental.ifPurchaseAtListPrice.capRate * 100).toFixed(1)}%</span>
                </div>
              </div>
              <div className={`mt-3 text-center py-1 rounded text-xs font-bold ${
                analysis.valuationImpactOnRental.ifPurchaseAtListPrice.viable 
                  ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}>
                {analysis.valuationImpactOnRental.ifPurchaseAtListPrice.viable ? '✅ VIABLE' : '❌ NOT VIABLE'}
              </div>
            </div>

            {/* At Fair Value */}
            <div className={`bg-white rounded-lg p-4 border-2 ${
              analysis.valuationImpactOnRental.ifPurchaseAtFairValue.viable 
                ? 'border-green-300' : 'border-red-300'
            }`}>
              <div className="text-sm font-semibold text-blue-700 mb-2">At Fair Value</div>
              <div className="text-lg font-bold text-gray-900">
                ${analysis.valuationImpactOnRental.ifPurchaseAtFairValue.purchasePrice.toLocaleString()}
              </div>
              <div className="space-y-1 mt-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Cash Flow:</span>
                  <span className={`font-semibold ${analysis.valuationImpactOnRental.ifPurchaseAtFairValue.monthlyCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${analysis.valuationImpactOnRental.ifPurchaseAtFairValue.monthlyCashFlow.toLocaleString()}/mo
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">CoC:</span>
                  <span className="font-semibold">{analysis.valuationImpactOnRental.ifPurchaseAtFairValue.cashOnCash.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Cap Rate:</span>
                  <span className="font-semibold">{(analysis.valuationImpactOnRental.ifPurchaseAtFairValue.capRate * 100).toFixed(1)}%</span>
                </div>
              </div>
              <div className={`mt-3 text-center py-1 rounded text-xs font-bold ${
                analysis.valuationImpactOnRental.ifPurchaseAtFairValue.viable 
                  ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}>
                {analysis.valuationImpactOnRental.ifPurchaseAtFairValue.viable ? '✅ VIABLE' : '❌ NOT VIABLE'}
              </div>
            </div>

            {/* At Negotiated Price (10% below fair value) */}
            <div className={`bg-white rounded-lg p-4 border-2 ${
              analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.viable 
                ? 'border-green-300' : 'border-red-300'
            }`}>
              <div className="text-sm font-semibold text-purple-700 mb-2">Negotiated (-10%)</div>
              <div className="text-lg font-bold text-gray-900">
                ${analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.purchasePrice.toLocaleString()}
              </div>
              <div className="space-y-1 mt-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Cash Flow:</span>
                  <span className={`font-semibold ${analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.monthlyCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.monthlyCashFlow.toLocaleString()}/mo
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">CoC:</span>
                  <span className="font-semibold">{analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.cashOnCash.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Cap Rate:</span>
                  <span className="font-semibold">{(analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.capRate * 100).toFixed(1)}%</span>
                </div>
              </div>
              <div className={`mt-3 text-center py-1 rounded text-xs font-bold ${
                analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.viable 
                  ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}>
                {analysis.valuationImpactOnRental.ifPurchaseAtNegotiatedPrice.viable ? '✅ VIABLE' : '❌ NOT VIABLE'}
              </div>
            </div>
          </div>

          {/* Key Price Insights */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-lg p-4 border">
              <div className="text-sm text-gray-600 mb-1">Break-Even Purchase Price</div>
              <div className="text-xl font-bold text-amber-600">
                ${analysis.valuationImpactOnRental.breakEvenPurchasePrice.toLocaleString()}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Maximum price where cash flow hits $0/month
              </div>
            </div>
            <div className="bg-white rounded-lg p-4 border border-green-300">
              <div className="text-sm text-gray-600 mb-1">Recommended Max Offer</div>
              <div className="text-xl font-bold text-green-600">
                ${analysis.valuationImpactOnRental.recommendedMaxOffer.toLocaleString()}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Includes 10% buffer below break-even
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// REGIONAL MARKET REPORT COMPONENT
// ============================================================================

const RegionalMarketReport: React.FC<{ analysis: ComprehensivePropertyAnalysis }> = ({ analysis }) => {
  const market = analysis.regionalMarket;
  
  if (!market) {
    return (
      <div className="text-center py-12 text-gray-500">
        Regional market analysis not available. Try refreshing the analysis.
      </div>
    );
  }

  const getHeatColor = (heat: string) => {
    switch (heat) {
      case 'very_hot': return 'bg-red-500';
      case 'hot': return 'bg-orange-500';
      case 'warm': return 'bg-yellow-500';
      case 'neutral': return 'bg-gray-400';
      case 'cool': return 'bg-blue-400';
      case 'cold': return 'bg-blue-600';
      case 'very_cold': return 'bg-blue-800';
      default: return 'bg-gray-400';
    }
  };

  const getHeatGradient = (score: number) => {
    if (score >= 70) return 'from-orange-400 to-red-500';
    if (score >= 50) return 'from-yellow-400 to-orange-400';
    return 'from-blue-400 to-blue-600';
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return 'text-green-600';
    if (score >= 50) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'improving': return '↗';
      case 'declining': return '↘';
      default: return '→';
    }
  };

  return (
    <div className="space-y-6">
      {/* Market Heat Overview */}
      <div className={`rounded-xl p-6 border-2 ${
        market.marketHeatScore >= 60 
          ? 'bg-gradient-to-r from-orange-50 to-red-50 border-orange-300'
          : market.marketHeatScore >= 40
          ? 'bg-gradient-to-r from-yellow-50 to-orange-50 border-yellow-300'
          : 'bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-300'
      }`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-2xl font-bold text-gray-900 mb-1">
              {market.marketHeat.replace('_', ' ').toUpperCase()} MARKET
            </h3>
            <p className="text-gray-600">{market.metroArea}, {market.stateCode}</p>
          </div>
          <div className="text-right">
            <div className="text-4xl font-bold text-gray-900">{market.marketHeatScore}</div>
            <div className="text-sm text-gray-500">Market Heat Score</div>
          </div>
        </div>
        
        {/* Heat Score Bar */}
        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Very Cold</span>
            <span>Cold</span>
            <span>Cool</span>
            <span>Neutral</span>
            <span>Warm</span>
            <span>Hot</span>
            <span>Very Hot</span>
          </div>
          <div className="relative h-4 bg-gradient-to-r from-blue-800 via-blue-400 via-gray-400 via-yellow-400 to-red-500 rounded-full">
            <div 
              className="absolute top-0 w-3 h-4 bg-white border-2 border-gray-800 rounded-full transform -translate-x-1/2"
              style={{ left: `${market.marketHeatScore}%` }}
            />
          </div>
        </div>
        
        <p className="text-gray-700">{market.summary}</p>
      </div>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Rental Market Strength</div>
          <div className={`text-3xl font-bold ${getScoreColor(market.rentalMarketStrength)}`}>
            {market.rentalMarketStrength}
          </div>
          <div className="text-xs text-gray-500 mt-1">out of 100</div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Investment Viability</div>
          <div className={`text-3xl font-bold ${getScoreColor(market.investmentViability)}`}>
            {market.investmentViability}
          </div>
          <div className="text-xs text-gray-500 mt-1">out of 100</div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Vacancy Risk</div>
          <div className={`text-2xl font-bold ${
            market.vacancyRisk === 'very_low' || market.vacancyRisk === 'low' ? 'text-green-600' :
            market.vacancyRisk === 'moderate' ? 'text-yellow-600' : 'text-red-600'
          }`}>
            {market.vacancyRisk.replace('_', ' ').charAt(0).toUpperCase() + market.vacancyRisk.replace('_', ' ').slice(1)}
          </div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6">
          <div className="text-sm font-medium text-gray-600 mb-1">Market Trend</div>
          <div className={`text-2xl font-bold ${
            market.marketTrend === 'accelerating' || market.marketTrend === 'growing' ? 'text-green-600' :
            market.marketTrend === 'stable' ? 'text-yellow-600' : 'text-red-600'
          }`}>
            {market.marketTrend.charAt(0).toUpperCase() + market.marketTrend.slice(1)}
          </div>
        </div>
      </div>

      {/* Economic Indicators */}
      <div className="bg-white rounded-xl border-2 p-6">
        <h4 className="text-lg font-bold text-gray-900 mb-4">Economic Indicators</h4>
        <div className="grid grid-cols-2 gap-6">
          {/* Employment Section */}
          <div>
            <h5 className="text-sm font-semibold text-gray-700 mb-3 pb-2 border-b">Employment & Income</h5>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-gray-600">Unemployment Rate</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {getTrendIcon(market.economicData.unemployment.trend)}
                  </span>
                </div>
                <div className="text-right">
                  <span className={`font-bold ${getScoreColor(market.economicData.unemployment.score)}`}>
                    {market.economicData.unemployment.value.toFixed(1)}%
                  </span>
                  <span className="text-xs text-gray-400 ml-2">
                    ({market.economicData.unemployment.nationalComparison?.replace('_', ' ') || 'N/A'})
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-gray-600">Job Growth</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {getTrendIcon(market.economicData.jobGrowth.trend)}
                  </span>
                </div>
                <span className={`font-bold ${getScoreColor(market.economicData.jobGrowth.score)}`}>
                  {market.economicData.jobGrowth.value >= 0 ? '+' : ''}{market.economicData.jobGrowth.value.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Median Income</span>
                <span className="font-bold text-gray-900">
                  ${market.economicData.medianIncome.value.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Income Growth</span>
                <span className={`font-bold ${getScoreColor(market.economicData.incomeGrowth.score)}`}>
                  {market.economicData.incomeGrowth.value >= 0 ? '+' : ''}{market.economicData.incomeGrowth.value.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Population Growth</span>
                <span className={`font-bold ${getScoreColor(market.economicData.populationGrowth.score)}`}>
                  {market.economicData.populationGrowth.value >= 0 ? '+' : ''}{market.economicData.populationGrowth.value.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
          
          {/* Housing Section */}
          <div>
            <h5 className="text-sm font-semibold text-gray-700 mb-3 pb-2 border-b">Housing Market</h5>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Vacancy Rate</span>
                <span className={`font-bold ${getScoreColor(market.economicData.vacancyRate.score)}`}>
                  {market.economicData.vacancyRate.value.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-gray-600">Rent Growth</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {getTrendIcon(market.economicData.rentGrowth.trend)}
                  </span>
                </div>
                <span className={`font-bold ${getScoreColor(market.economicData.rentGrowth.score)}`}>
                  {market.economicData.rentGrowth.value >= 0 ? '+' : ''}{market.economicData.rentGrowth.value.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-gray-600">Home Value Growth</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {getTrendIcon(market.economicData.homeValueGrowth.trend)}
                  </span>
                </div>
                <span className={`font-bold ${getScoreColor(market.economicData.homeValueGrowth.score)}`}>
                  {market.economicData.homeValueGrowth.value >= 0 ? '+' : ''}{market.economicData.homeValueGrowth.value.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Days on Market</span>
                <span className={`font-bold ${getScoreColor(market.economicData.daysOnMarket.score)}`}>
                  {Math.round(market.economicData.daysOnMarket.value)} days
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Inventory (Months)</span>
                <span className={`font-bold ${getScoreColor(market.economicData.inventoryMonths.score)}`}>
                  {market.economicData.inventoryMonths.value.toFixed(1)} mo
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Demand Signals */}
      <div className="bg-white rounded-xl border-2 p-6">
        <h4 className="text-lg font-bold text-gray-900 mb-4">Demand Signals</h4>
        <div className="grid grid-cols-4 gap-4">
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <div className="text-sm font-medium text-gray-600 mb-2">Rental Demand</div>
            <div className={`text-xl font-bold ${
              market.demandSignals.rentalDemand === 'very_high' || market.demandSignals.rentalDemand === 'high' ? 'text-green-600' :
              market.demandSignals.rentalDemand === 'moderate' ? 'text-yellow-600' : 'text-red-600'
            }`}>
              {market.demandSignals.rentalDemand.replace('_', ' ').toUpperCase()}
            </div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <div className="text-sm font-medium text-gray-600 mb-2">Purchase Demand</div>
            <div className={`text-xl font-bold ${
              market.demandSignals.purchaseDemand === 'very_high' || market.demandSignals.purchaseDemand === 'high' ? 'text-green-600' :
              market.demandSignals.purchaseDemand === 'moderate' ? 'text-yellow-600' : 'text-red-600'
            }`}>
              {market.demandSignals.purchaseDemand.replace('_', ' ').toUpperCase()}
            </div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <div className="text-sm font-medium text-gray-600 mb-2">Investor Activity</div>
            <div className={`text-xl font-bold ${
              market.demandSignals.investorActivity === 'very_high' || market.demandSignals.investorActivity === 'high' ? 'text-green-600' :
              market.demandSignals.investorActivity === 'moderate' ? 'text-yellow-600' : 'text-red-600'
            }`}>
              {market.demandSignals.investorActivity.replace('_', ' ').toUpperCase()}
            </div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <div className="text-sm font-medium text-gray-600 mb-2">Supply Constraint</div>
            <div className={`text-xl font-bold ${
              market.demandSignals.supplyConstraint === 'severe' || market.demandSignals.supplyConstraint === 'moderate' ? 'text-green-600' :
              market.demandSignals.supplyConstraint === 'balanced' ? 'text-yellow-600' : 'text-red-600'
            }`}>
              {market.demandSignals.supplyConstraint.toUpperCase()}
            </div>
          </div>
        </div>
      </div>

      {/* Strengths and Weaknesses */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-green-50 rounded-xl border-2 border-green-200 p-6">
          <h4 className="text-lg font-bold text-green-800 mb-4">✅ Market Strengths</h4>
          {market.strengths.length > 0 ? (
            <ul className="space-y-2">
              {market.strengths.map((strength, i) => (
                <li key={i} className="flex items-start gap-2 text-green-700">
                  <span className="text-green-500 mt-1">•</span>
                  <span>{strength}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-green-600 italic">No significant strengths identified</p>
          )}
        </div>
        <div className="bg-red-50 rounded-xl border-2 border-red-200 p-6">
          <h4 className="text-lg font-bold text-red-800 mb-4">⚠️ Market Weaknesses</h4>
          {market.weaknesses.length > 0 ? (
            <ul className="space-y-2">
              {market.weaknesses.map((weakness, i) => (
                <li key={i} className="flex items-start gap-2 text-red-700">
                  <span className="text-red-500 mt-1">•</span>
                  <span>{weakness}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-red-600 italic">No significant weaknesses identified</p>
          )}
        </div>
      </div>

      {/* Market Outlook */}
      <div className="bg-blue-50 rounded-xl border-2 border-blue-200 p-6">
        <h4 className="text-lg font-bold text-blue-800 mb-2">📈 Market Outlook</h4>
        <p className="text-blue-700">{market.outlook}</p>
      </div>

      {/* Confidence & Data Sources */}
      <div className="bg-gray-50 rounded-xl border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">Analysis Confidence:</span>
            <span className={`px-3 py-1 rounded-full text-xs font-bold ${
              market.confidenceLevel === 'high' ? 'bg-green-100 text-green-700' :
              market.confidenceLevel === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
            }`}>
              {market.confidenceLevel.toUpperCase()}
            </span>
          </div>
          <div className="text-sm text-gray-500">
            Sources: {market.dataSources.join(', ')}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// RENOVATION REPORT COMPONENT - ENHANCED
// ============================================================================

const RenovationReport: React.FC<{ analysis: ComprehensivePropertyAnalysis }> = ({ analysis }) => {
  const renovation = analysis.postRenovation;
  const condition = analysis.asIs?.condition;
  
  // Show condition analysis even if no renovation plan
  if (!renovation && !condition) {
    return (
      <div className="text-center py-12 text-gray-500">
        Renovation analysis not available for this property
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* BRRRR Opportunity */}
      {renovation?.brrrr && (
        <div className={`rounded-xl p-6 border-2 ${
          renovation.brrrr.infiniteReturn
            ? 'bg-purple-50 border-purple-300'
            : 'bg-blue-50 border-blue-300'
        }`}>
          <h3 className="text-2xl font-bold text-gray-900 mb-2">
            {renovation.brrrr.infiniteReturn ? '🚀 Infinite Return Opportunity!' : '💡 BRRRR Strategy Analysis'}
          </h3>
          <p className="text-gray-700 mb-4">{renovation.recommendation}</p>
          
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white rounded-lg p-4 border">
              <div className="text-sm font-medium text-gray-600">Total Investment</div>
              <div className="text-xl font-bold text-gray-900">${renovation.brrrr.totalInvestment.toLocaleString()}</div>
            </div>
            <div className="bg-white rounded-lg p-4 border">
              <div className="text-sm font-medium text-gray-600">After Repair Value</div>
              <div className="text-xl font-bold text-gray-900">${renovation.brrrr.afterRepairValue.toLocaleString()}</div>
            </div>
            <div className="bg-white rounded-lg p-4 border">
              <div className="text-sm font-medium text-gray-600">Capital Recovered</div>
              <div className={`text-xl font-bold ${renovation.brrrr.cashRecovered >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                ${renovation.brrrr.cashRecovered.toLocaleString()}
              </div>
            </div>
            <div className="bg-white rounded-lg p-4 border">
              <div className="text-sm font-medium text-gray-600">Left In Deal</div>
              <div className="text-xl font-bold text-gray-900">${renovation.brrrr.cashLeftInDeal.toLocaleString()}</div>
            </div>
          </div>
          
          {/* BRRRR Details */}
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">Capital Recovery</div>
              <div className="font-bold text-lg">{(renovation.brrrr.capitalRecoveryPercent * 100).toFixed(0)}%</div>
            </div>
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">Post-Refi Cash Flow</div>
              <div className={`font-bold text-lg ${renovation.brrrr.postRefinanceCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                ${renovation.brrrr.postRefinanceCashFlow.toLocaleString()}/mo
              </div>
            </div>
            <div className="bg-white rounded-lg p-3 border">
              <div className="text-xs text-gray-500">Final Cash-on-Cash</div>
              <div className="font-bold text-lg">{renovation.brrrr.finalCashOnCash.toFixed(1)}%</div>
            </div>
          </div>
        </div>
      )}

      {/* Detailed Condition Breakdown */}
      {condition && (
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border-2 border-amber-200 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>🔍</span> Detailed Condition Analysis
          </h4>
          
          {/* Exterior Components */}
          <div className="mb-6">
            <h5 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <span>🏠</span> Exterior ({Math.round(condition.exterior.overallScore)}/100)
            </h5>
            <div className="grid grid-cols-4 gap-3">
              {[
                { name: 'Roof', data: condition.exterior.roof, icon: '🏚️' },
                { name: 'Siding', data: condition.exterior.siding, icon: '🧱' },
                { name: 'Windows', data: condition.exterior.windows, icon: '🪟' },
                { name: 'Foundation', data: condition.exterior.foundation, icon: '🏗️' }
              ].map((comp, i) => (
                <div key={i} className="bg-white rounded-lg p-3 border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">{comp.icon} {comp.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                      comp.data.score >= 80 ? 'bg-green-100 text-green-700' :
                      comp.data.score >= 60 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {Math.round(comp.data.score)}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div 
                      className={`h-1.5 rounded-full ${
                        comp.data.score >= 80 ? 'bg-green-500' :
                        comp.data.score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${comp.data.score}%` }}
                    />
                  </div>
                  {comp.data.urgency !== 'none' && (
                    <div className={`text-xs mt-1 ${
                      comp.data.urgency === 'immediate' ? 'text-red-600' :
                      comp.data.urgency === 'soon' ? 'text-yellow-600' : 'text-gray-500'
                    }`}>
                      {comp.data.urgency === 'immediate' ? '⚠️ Immediate' : 
                       comp.data.urgency === 'soon' ? '⏰ Soon' : '👁️ Monitor'}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          
          {/* Interior Components */}
          <div className="mb-6">
            <h5 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <span>🛋️</span> Interior ({Math.round(condition.interior.overallScore)}/100)
            </h5>
            <div className="grid grid-cols-4 gap-3">
              {[
                { name: 'Kitchen', score: condition.interior.kitchen.score, icon: '🍳' },
                { name: 'Bathrooms', score: condition.interior.bathrooms.avgScore, icon: '🚿' },
                { name: 'Flooring', score: condition.interior.flooring.score, icon: '🪵' },
                { name: 'Paint', score: condition.interior.paint.score, icon: '🎨' }
              ].map((comp, i) => (
                <div key={i} className="bg-white rounded-lg p-3 border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">{comp.icon} {comp.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                      comp.score >= 80 ? 'bg-green-100 text-green-700' :
                      comp.score >= 60 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {Math.round(comp.score)}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div 
                      className={`h-1.5 rounded-full ${
                        comp.score >= 80 ? 'bg-green-500' :
                        comp.score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${comp.score}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Systems */}
          <div>
            <h5 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <span>⚙️</span> Systems ({Math.round(condition.systems.overallScore)}/100)
            </h5>
            <div className="grid grid-cols-4 gap-3">
              {[
                { name: 'HVAC', data: condition.systems.hvac, icon: '❄️' },
                { name: 'Electrical', data: condition.systems.electrical, icon: '⚡' },
                { name: 'Plumbing', data: condition.systems.plumbing, icon: '🚰' },
                { name: 'Water Heater', data: condition.systems.waterHeater, icon: '🔥' }
              ].map((comp, i) => (
                <div key={i} className="bg-white rounded-lg p-3 border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">{comp.icon} {comp.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                      comp.data.score >= 80 ? 'bg-green-100 text-green-700' :
                      comp.data.score >= 60 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {Math.round(comp.data.score)}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div 
                      className={`h-1.5 rounded-full ${
                        comp.data.score >= 80 ? 'bg-green-500' :
                        comp.data.score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${comp.data.score}%` }}
                    />
                  </div>
                  {comp.data.expectedLife && (
                    <div className="text-xs text-gray-500 mt-1">
                      Expected life: {comp.data.expectedLife} yrs
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* AI-Identified Renovation Opportunities */}
      {condition?.aiRenovationOpportunities && condition.aiRenovationOpportunities.length > 0 && (
        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border-2 border-blue-200 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>🤖</span> AI-Identified Renovation Opportunities
          </h4>
          <div className="space-y-3">
            {condition.aiRenovationOpportunities.map((opp, i) => (
              <div key={i} className="bg-white rounded-lg p-4 border hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h5 className="font-semibold text-gray-900">{opp.area}</h5>
                    <p className="text-sm text-gray-600 mt-1">{opp.description}</p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                        opp.value_add_potential === 'high' ? 'bg-green-100 text-green-700' :
                        opp.value_add_potential === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {opp.value_add_potential.toUpperCase()} Value Add
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                        opp.priority === 'immediate' ? 'bg-red-100 text-red-700' :
                        opp.priority === 'short-term' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-blue-100 text-blue-700'
                      }`}>
                        {opp.priority.replace('-', ' ').toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <div className="text-right ml-4">
                    <div className="text-sm font-bold text-gray-900">{opp.estimated_cost_range}</div>
                    <div className="text-xs text-green-600">+{opp.rent_increase_potential} rent</div>
                    <div className="text-xs text-blue-600">{opp.roi_estimate} ROI</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deferred Maintenance */}
      {condition?.deferredMaintenance && condition.deferredMaintenance.length > 0 && (
        <div className="bg-gradient-to-br from-red-50 to-orange-50 rounded-xl border-2 border-red-200 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>⚠️</span> Deferred Maintenance Items
            <span className="ml-auto text-sm font-normal text-red-700">
              Total: ${condition.totalDeferredCost.toLocaleString()}
            </span>
          </h4>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {condition.deferredMaintenance.map((item, i) => (
              <div key={i} className={`flex items-center justify-between p-3 rounded-lg ${
                item.severity === 'critical' ? 'bg-red-100' :
                item.severity === 'high' ? 'bg-orange-100' :
                item.severity === 'medium' ? 'bg-yellow-100' : 'bg-gray-100'
              }`}>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${
                      item.severity === 'critical' ? 'bg-red-500' :
                      item.severity === 'high' ? 'bg-orange-500' :
                      item.severity === 'medium' ? 'bg-yellow-500' : 'bg-gray-500'
                    }`} />
                    <span className="font-medium text-gray-900">{item.category}: {item.item}</span>
                  </div>
                  <div className="text-xs text-gray-600 ml-4 mt-1">
                    Urgency: {item.urgency} • Impact on value: -${item.impactOnValue.toLocaleString()}
                    {item.impactOnRent !== 0 && ` • Impact on rent: $${item.impactOnRent}/mo`}
                  </div>
                </div>
                <div className="font-bold text-gray-900">${item.cost.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ENHANCED Renovation Plan with ROI & Payback Analysis */}
      {renovation?.renovationPlan && renovation.renovationPlan.scope && renovation.renovationPlan.scope.length > 0 && (
        <div className="bg-white rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-2">📈 Positive ROI Renovations Only</h4>
          <p className="text-sm text-gray-600 mb-4">
            Only renovations with positive 5-year ROI and reasonable payback periods are shown.
          </p>
          
          {/* Portfolio Summary */}
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg p-4 mb-6 border border-green-200">
            <div className="grid grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-xs text-gray-600">Total Cost</div>
                <div className="text-xl font-bold text-gray-900">${(renovation.renovationPlan.totalCost || 0).toLocaleString()}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-600">Monthly Rent Increase</div>
                <div className="text-xl font-bold text-green-600">+${renovation.renovationPlan.expectedRentIncrease}/mo</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-600">Portfolio Payback</div>
                <div className="text-xl font-bold text-blue-600">
                  {renovation.renovationPlan.expectedRentIncrease > 0 
                    ? `${Math.ceil((renovation.renovationPlan.totalCost || 0) / renovation.renovationPlan.expectedRentIncrease)} mo`
                    : 'N/A'}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-600">5-Year ROI</div>
                <div className="text-xl font-bold text-purple-600">
                  {renovation.renovationPlan.totalCost > 0 
                    ? `${(((renovation.renovationPlan.expectedRentIncrease * 12 * 5) / renovation.renovationPlan.totalCost) * 100).toFixed(0)}%`
                    : 'N/A'}
                </div>
              </div>
            </div>
          </div>
          
          {/* Individual Renovations with ROI */}
          <div className="space-y-4">
            {renovation.renovationPlan.scope.map((item, i) => {
              const paybackMonths = item.rentImpact > 0 ? Math.ceil(item.cost / item.rentImpact) : 999;
              const fiveYearROI = item.cost > 0 ? ((item.rentImpact * 12 * 5) / item.cost * 100) : 0;
              const isHighROI = paybackMonths <= 36 && fiveYearROI >= 100;
              
              return (
                <div key={i} className={`rounded-lg p-4 border-2 ${
                  isHighROI ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200'
                }`}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {isHighROI && <span className="text-lg">⭐</span>}
                        <h5 className="font-semibold text-gray-900">{item.category} - {item.item}</h5>
                      </div>
                      {isHighROI && (
                        <span className="inline-block mt-1 px-2 py-0.5 text-xs font-bold bg-green-100 text-green-700 rounded-full">
                          HIGH ROI RENOVATION
                        </span>
                      )}
                    </div>
                    <div className="text-right ml-4">
                      <div className="font-bold text-gray-900">${item.cost.toLocaleString()}</div>
                      {item.costRange && (
                        <div className="text-xs text-gray-500">
                          ${item.costRange.low.toLocaleString()} - ${item.costRange.high.toLocaleString()}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* ROI Metrics Row */}
                  <div className="grid grid-cols-4 gap-3 mt-3 pt-3 border-t border-gray-200">
                    <div className="text-center bg-white rounded p-2 border">
                      <div className="text-xs text-gray-500">Rent Increase</div>
                      <div className="font-bold text-green-600">+${item.rentImpact || 0}/mo</div>
                    </div>
                    <div className="text-center bg-white rounded p-2 border">
                      <div className="text-xs text-gray-500">Payback</div>
                      <div className={`font-bold ${paybackMonths <= 24 ? 'text-green-600' : paybackMonths <= 48 ? 'text-yellow-600' : 'text-red-600'}`}>
                        {paybackMonths < 999 ? `${paybackMonths} mo` : 'N/A'}
                      </div>
                    </div>
                    <div className="text-center bg-white rounded p-2 border">
                      <div className="text-xs text-gray-500">5-Year ROI</div>
                      <div className={`font-bold ${fiveYearROI >= 150 ? 'text-green-600' : fiveYearROI >= 100 ? 'text-blue-600' : 'text-yellow-600'}`}>
                        {fiveYearROI.toFixed(0)}%
                      </div>
                    </div>
                    <div className="text-center bg-white rounded p-2 border">
                      <div className="text-xs text-gray-500">5-Year Return</div>
                      <div className="font-bold text-purple-600">${((item.rentImpact || 0) * 12 * 5).toLocaleString()}</div>
                    </div>
                  </div>
                  
                  {/* Tags */}
                  <div className="flex items-center gap-2 mt-3">
                    <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${
                      item.impact === 'high' ? 'bg-red-100 text-red-700' :
                      item.impact === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-green-100 text-green-700'
                    }`}>
                      {item.impact?.toUpperCase() || 'MEDIUM'} IMPACT
                    </span>
                    {item.confidence && (
                      <span className={`px-2 py-0.5 text-xs rounded ${
                        item.confidence === 'high' ? 'bg-green-100 text-green-700' :
                        item.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {item.confidence} confidence
                      </span>
                    )}
                    {item.dataSource && (
                      <span className="text-xs text-gray-500">
                        Source: {item.dataSource}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          
          {/* Cash Flow Transformation Summary */}
          {analysis.asIs?.cashFlow && (
            <div className="mt-6 pt-6 border-t-2 border-dashed">
              <h5 className="font-semibold text-gray-900 mb-3">💰 Cash Flow Transformation</h5>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-red-50 rounded-lg p-3 border border-red-200">
                  <div className="text-xs text-red-700">Current Cash Flow</div>
                  <div className={`text-xl font-bold ${analysis.asIs.cashFlow.monthlyCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${analysis.asIs.cashFlow.monthlyCashFlow.toLocaleString()}/mo
                  </div>
                </div>
                <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
                  <div className="text-xs text-blue-700">After Renovations</div>
                  <div className={`text-xl font-bold ${(analysis.asIs.cashFlow.monthlyCashFlow + renovation.renovationPlan.expectedRentIncrease) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${(analysis.asIs.cashFlow.monthlyCashFlow + renovation.renovationPlan.expectedRentIncrease).toLocaleString()}/mo
                  </div>
                </div>
                <div className="bg-green-50 rounded-lg p-3 border border-green-200">
                  <div className="text-xs text-green-700">Improvement</div>
                  <div className="text-xl font-bold text-green-600">
                    +${renovation.renovationPlan.expectedRentIncrease}/mo
                  </div>
                </div>
              </div>
              
              {/* Check if turns cash flow positive */}
              {analysis.asIs.cashFlow.monthlyCashFlow < 0 && 
               (analysis.asIs.cashFlow.monthlyCashFlow + renovation.renovationPlan.expectedRentIncrease) >= 0 && (
                <div className="mt-4 bg-gradient-to-r from-green-100 to-emerald-100 rounded-lg p-4 border-2 border-green-400">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🎯</span>
                    <div>
                      <div className="font-bold text-green-800">CASH FLOW TURNAROUND OPPORTUNITY</div>
                      <div className="text-sm text-green-700">
                        These renovations transform negative cash flow into positive cash flow!
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          
          <div className="mt-6 pt-4 border-t">
            <div className="flex justify-between items-center">
              <span className="text-lg font-bold text-gray-900">Total Renovation Cost</span>
              <span className="text-2xl font-bold text-gray-900">${renovation.renovationPlan.totalCost?.toLocaleString() || 0}</span>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              Timeline: {renovation.renovationPlan.timeline} months • Only positive ROI renovations included
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// WEDGE OPPORTUNITIES REPORT COMPONENT - ENHANCED
// ============================================================================

const wedgeTypeInfo: { [key: string]: { icon: string; color: string; bgColor: string } } = {
  'valuation_gap': { icon: '📊', color: 'text-blue-700', bgColor: 'bg-blue-50 border-blue-200' },
  'distressed_seller': { icon: '🏚️', color: 'text-orange-700', bgColor: 'bg-orange-50 border-orange-200' },
  'value_add': { icon: '🔨', color: 'text-purple-700', bgColor: 'bg-purple-50 border-purple-200' },
  'value_add_rental': { icon: '🏠', color: 'text-teal-700', bgColor: 'bg-teal-50 border-teal-200' },
  'off_market': { icon: '🔒', color: 'text-gray-700', bgColor: 'bg-gray-50 border-gray-200' },
  'assumable_loan': { icon: '🏦', color: 'text-green-700', bgColor: 'bg-green-50 border-green-200' },
  'house_hack': { icon: '🏡', color: 'text-indigo-700', bgColor: 'bg-indigo-50 border-indigo-200' },
  'tax_appeal': { icon: '📝', color: 'text-amber-700', bgColor: 'bg-amber-50 border-amber-200' },
  'brrrr': { icon: '🚀', color: 'text-violet-700', bgColor: 'bg-violet-50 border-violet-200' },
  'flip': { icon: '💰', color: 'text-emerald-700', bgColor: 'bg-emerald-50 border-emerald-200' }
};

const WedgeOpportunitiesReport: React.FC<{ analysis: ComprehensivePropertyAnalysis }> = ({ analysis }) => {
  if (!analysis.wedgeOpportunities || analysis.wedgeOpportunities.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 mb-4">
          <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-700">No Investment Wedges Detected</h3>
        <p className="text-gray-500 mt-2">This property doesn't currently show strong wedge opportunities</p>
      </div>
    );
  }

  // Calculate totals
  const totalPotentialProfit = analysis.wedgeOpportunities.reduce((sum, w) => sum + w.potentialProfit, 0);
  const avgConfidence = analysis.wedgeOpportunities.reduce((sum, w) => sum + w.confidence, 0) / analysis.wedgeOpportunities.length;

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl p-6 border-2 border-purple-200">
        <h3 className="text-xl font-bold text-gray-900 mb-2">
          💎 {analysis.wedgeOpportunities.length} Investment {analysis.wedgeOpportunities.length === 1 ? 'Opportunity' : 'Opportunities'} Found
        </h3>
        <p className="text-gray-700 mb-4">
          These are potential investment advantages that could yield outsized returns
        </p>
        
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-lg p-3 border">
            <div className="text-sm text-gray-600">Total Profit Potential</div>
            <div className="text-2xl font-bold text-green-600">${totalPotentialProfit.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-lg p-3 border">
            <div className="text-sm text-gray-600">Avg Confidence</div>
            <div className="text-2xl font-bold text-blue-600">{(avgConfidence * 100).toFixed(0)}%</div>
          </div>
          <div className="bg-white rounded-lg p-3 border">
            <div className="text-sm text-gray-600">Wedge Types</div>
            <div className="text-2xl font-bold text-purple-600">{new Set(analysis.wedgeOpportunities.map(w => w.type)).size}</div>
          </div>
        </div>
      </div>

      {/* Wedge Cards */}
      {analysis.wedgeOpportunities.map((wedge, i: number) => {
        const typeInfo = wedgeTypeInfo[wedge.type] || { icon: '💡', color: 'text-gray-700', bgColor: 'bg-gray-50 border-gray-200' };
        const roi = wedge.capitalRequired > 0 ? ((wedge.potentialProfit / wedge.capitalRequired) * 100) : 0;
        
        // Check if this is a VALUE_ADD_RENTAL wedge with cash flow analysis
        const isValueAddRental = wedge.type === 'value_add_rental';
        const cashFlowAnalysis = wedge.details?.cashFlowAnalysis;
        const renovationBreakdown = wedge.details?.renovationBreakdown;
        
        return (
          <div key={i} className={`rounded-xl border-2 p-6 hover:shadow-lg transition-shadow ${typeInfo.bgColor}`}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-3xl">{typeInfo.icon}</span>
                  <h4 className={`text-xl font-bold ${typeInfo.color}`}>
                    {wedge.type.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
                  </h4>
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                    wedge.risk === 'low' ? 'bg-green-100 text-green-700' :
                    wedge.risk === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {wedge.risk.toUpperCase()} RISK
                  </span>
                  <span className="px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                    {(wedge.confidence * 100).toFixed(0)}% Confidence
                  </span>
                </div>
                <p className="text-gray-700 mb-3">{wedge.strategy}</p>
              </div>
              <div className="text-right ml-6">
                <div className="text-sm font-medium text-gray-600">Profit Potential</div>
                <div className="text-3xl font-bold text-green-600">${wedge.potentialProfit.toLocaleString()}</div>
                <div className="text-xs text-gray-500 mt-1">{wedge.timeframe}</div>
              </div>
            </div>

            {/* ENHANCED: Cash Flow Analysis for Value-Add Rental Wedges */}
            {isValueAddRental && cashFlowAnalysis && (
              <div className="mb-4 bg-white rounded-lg p-4 border-2 border-teal-300">
                <h5 className="text-sm font-bold text-teal-800 mb-3">📊 Cash Flow Impact Analysis</h5>
                <div className="grid grid-cols-4 gap-3">
                  <div className="text-center p-2 bg-red-50 rounded border">
                    <div className="text-xs text-red-600">Before</div>
                    <div className={`font-bold ${cashFlowAnalysis.before >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      ${cashFlowAnalysis.before}/mo
                    </div>
                  </div>
                  <div className="text-center p-2 bg-green-50 rounded border">
                    <div className="text-xs text-green-600">After</div>
                    <div className={`font-bold ${cashFlowAnalysis.after >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      ${cashFlowAnalysis.after}/mo
                    </div>
                  </div>
                  <div className="text-center p-2 bg-blue-50 rounded border">
                    <div className="text-xs text-blue-600">Improvement</div>
                    <div className="font-bold text-blue-600">+${cashFlowAnalysis.improvement}/mo</div>
                  </div>
                  <div className="text-center p-2 bg-purple-50 rounded border">
                    <div className="text-xs text-purple-600">5-Year ROI</div>
                    <div className="font-bold text-purple-600">{wedge.details?.fiveYearROI?.toFixed(0) || 0}%</div>
                  </div>
                </div>
                
                {/* Cash Flow Turnaround Highlight */}
                {cashFlowAnalysis.turnsCashFlowPositive && (
                  <div className="mt-3 bg-gradient-to-r from-green-100 to-emerald-100 rounded-lg p-3 border border-green-400">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">🎯</span>
                      <span className="font-bold text-green-800">TURNS CASH FLOW POSITIVE!</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            {/* ENHANCED: Individual Renovation ROI Breakdown for Value-Add Rental */}
            {isValueAddRental && renovationBreakdown && renovationBreakdown.length > 0 && (
              <div className="mb-4 bg-white/80 rounded-lg p-4 border">
                <h5 className="text-sm font-bold text-gray-700 mb-3">🔧 Renovation ROI Breakdown</h5>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {renovationBreakdown.slice(0, 5).map((reno: any, j: number) => (
                    <div key={j} className={`flex items-center justify-between p-2 rounded ${
                      reno.isHighROI ? 'bg-green-50 border border-green-200' : 'bg-gray-50'
                    }`}>
                      <div className="flex items-center gap-2">
                        {reno.isHighROI && <span>⭐</span>}
                        <span className="text-sm font-medium text-gray-800">{reno.item}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-gray-600">${reno.cost?.toLocaleString()}</span>
                        <span className="text-green-600 font-bold">+${reno.rentImpact}/mo</span>
                        <span className={`font-bold ${
                          reno.paybackMonths <= 24 ? 'text-green-600' : 
                          reno.paybackMonths <= 48 ? 'text-yellow-600' : 'text-red-600'
                        }`}>
                          {reno.paybackMonths}mo
                        </span>
                        <span className="text-purple-600 font-bold">{reno.fiveYearROI?.toFixed(0)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
                {renovationBreakdown.length > 5 && (
                  <div className="text-xs text-gray-500 mt-2 text-center">
                    + {renovationBreakdown.length - 5} more renovations
                  </div>
                )}
              </div>
            )}

            {/* Key Signals */}
            {wedge.signals && wedge.signals.length > 0 && (
              <div className="mb-4">
                <h5 className="text-sm font-semibold text-gray-700 mb-2">Key Signals:</h5>
                <div className="flex flex-wrap gap-2">
                  {wedge.signals.map((signal: string, j: number) => (
                    <span key={j} className="px-3 py-1 bg-white border rounded-lg text-sm text-gray-700">
                      {signal}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Barriers */}
            {wedge.barriers && wedge.barriers.length > 0 && (
              <div className="bg-white/70 border border-orange-200 rounded-lg p-3 mb-4">
                <h5 className="text-sm font-semibold text-gray-700 mb-2">⚠️ Barriers to Consider:</h5>
                <ul className="space-y-1">
                  {wedge.barriers.map((barrier: string, j: number) => (
                    <li key={j} className="text-sm text-gray-700 flex items-start gap-2">
                      <span className="text-orange-500 mt-0.5">•</span>
                      <span>{barrier}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Bottom Stats */}
            <div className="mt-4 pt-4 border-t border-gray-300 grid grid-cols-3 gap-4">
              <div className="text-center">
                <div className="text-xs text-gray-500">Capital Required</div>
                <div className="font-bold text-gray-900">${wedge.capitalRequired.toLocaleString()}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500">ROI</div>
                <div className={`font-bold ${roi >= 100 ? 'text-green-600' : roi >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {roi.toFixed(0)}%
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500">Risk/Reward</div>
                <div className="font-bold text-gray-900">
                  {wedge.risk === 'low' && roi >= 50 ? '⭐⭐⭐' :
                   wedge.risk === 'medium' && roi >= 75 ? '⭐⭐' :
                   wedge.risk === 'high' && roi >= 100 ? '⭐' : '—'}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ============================================================================
// ACTION PLAN REPORT COMPONENT
// ============================================================================

const ActionPlanReport: React.FC<{ analysis: ComprehensivePropertyAnalysis }> = ({ analysis }) => {
  return (
    <div className="space-y-6">
      {/* Best Strategy */}
      <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl p-6 border-2 border-green-300">
        <h3 className="text-2xl font-bold text-gray-900 mb-2">🎯 Recommended Strategy</h3>
        <p className="text-lg text-gray-700 mb-4">{analysis.bestStrategy}</p>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-600">Confidence:</span>
          <div className="flex-1 bg-white rounded-full h-3 overflow-hidden border">
            <div 
              className="bg-gradient-to-r from-green-500 to-emerald-500 h-full rounded-full"
              style={{ width: `${analysis.confidenceScore * 100}%` }}
            />
          </div>
          <span className="text-sm font-bold text-gray-900">{(analysis.confidenceScore * 100).toFixed(0)}%</span>
        </div>
      </div>

      {/* Confidence Breakdown */}
      <div className="bg-white rounded-xl border-2 p-6">
        <h4 className="text-lg font-bold text-gray-900 mb-4">Confidence Breakdown</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-3 bg-blue-50 rounded-lg border border-blue-200">
            <div className="text-sm text-blue-700 font-medium mb-1">Valuation Data</div>
            <div className={`text-xl font-bold ${
              analysis.valuation.methods?.attomAVM && analysis.valuation.methods?.salesComparison
                ? 'text-green-600' : 'text-yellow-600'
            }`}>
              {[analysis.valuation.methods?.attomAVM, analysis.valuation.methods?.salesComparison]
                .filter(Boolean).length}/2 Methods
            </div>
          </div>
          <div className="text-center p-3 bg-purple-50 rounded-lg border border-purple-200">
            <div className="text-sm text-purple-700 font-medium mb-1">Condition Data</div>
            <div className={`text-xl font-bold ${
              analysis.asIs?.condition?.overallScore ? 'text-green-600' : 'text-yellow-600'
            }`}>
              {analysis.asIs?.condition?.overallScore ? `${Math.round(analysis.asIs.condition.overallScore / 10)}/10` : 'Pending'}
            </div>
          </div>
          <div className="text-center p-3 bg-teal-50 rounded-lg border border-teal-200">
            <div className="text-sm text-teal-700 font-medium mb-1">Rental Data</div>
            <div className={`text-xl font-bold ${
              analysis.asIs?.income?.finalMonthlyRent ? 'text-green-600' : 'text-yellow-600'
            }`}>
              {analysis.asIs?.income?.finalMonthlyRent 
                ? `$${analysis.asIs.income.finalMonthlyRent.toLocaleString()}/mo` 
                : 'Pending'}
            </div>
          </div>
          <div className="text-center p-3 bg-amber-50 rounded-lg border border-amber-200">
            <div className="text-sm text-amber-700 font-medium mb-1">Wedge Signals</div>
            <div className={`text-xl font-bold ${
              analysis.wedgeOpportunities.length > 0 ? 'text-green-600' : 'text-gray-600'
            }`}>
              {analysis.wedgeOpportunities.length} Found
            </div>
          </div>
        </div>
      </div>

      {/* Investment Transformation Summary */}
      {analysis.asIs && analysis.postRenovation && (
        <div className="bg-gradient-to-r from-slate-50 to-gray-50 rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4">📈 Investment Transformation</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-lg border">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Property Value</div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-gray-600">
                  ${(analysis.valuation.listPrice || 0).toLocaleString()}
                </span>
                <span className="text-gray-400">→</span>
                <span className="text-lg font-bold text-green-600">
                  ${(analysis.postRenovation.brrrr?.afterRepairValue || analysis.valuation.listPrice || 0).toLocaleString()}
                </span>
              </div>
              <div className="text-xs text-green-600 mt-1">
                +${((analysis.postRenovation.brrrr?.afterRepairValue || analysis.valuation.listPrice || 0) - (analysis.valuation.listPrice || 0)).toLocaleString()}
              </div>
            </div>
            <div className="bg-white p-4 rounded-lg border">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Monthly Rent</div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-gray-600">
                  ${(analysis.asIs.income?.finalMonthlyRent || 0).toLocaleString()}
                </span>
                <span className="text-gray-400">→</span>
                <span className="text-lg font-bold text-green-600">
                  ${(analysis.postRenovation.income?.finalMonthlyRent || 0).toLocaleString()}
                </span>
              </div>
              <div className="text-xs text-green-600 mt-1">
                +${((analysis.postRenovation.income?.finalMonthlyRent || 0) - (analysis.asIs.income?.finalMonthlyRent || 0)).toLocaleString()}/mo
              </div>
            </div>
            <div className="bg-white p-4 rounded-lg border">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Cash Flow</div>
              <div className="flex items-center gap-2">
                <span className={`text-lg font-bold ${(analysis.asIs.cashFlow?.monthlyCashFlow || 0) >= 0 ? 'text-gray-600' : 'text-red-600'}`}>
                  ${(analysis.asIs.cashFlow?.monthlyCashFlow || 0).toLocaleString()}
                </span>
                <span className="text-gray-400">→</span>
                <span className={`text-lg font-bold ${(analysis.postRenovation.cashFlow?.monthlyCashFlow || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  ${(analysis.postRenovation.cashFlow?.monthlyCashFlow || 0).toLocaleString()}
                </span>
              </div>
              <div className="text-xs text-green-600 mt-1">
                +${((analysis.postRenovation.cashFlow?.monthlyCashFlow || 0) - (analysis.asIs.cashFlow?.monthlyCashFlow || 0)).toLocaleString()}/mo
              </div>
            </div>
            <div className="bg-white p-4 rounded-lg border">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Cap Rate</div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-gray-600">
                  {((analysis.asIs.metrics?.capRate || 0) * 100).toFixed(1)}%
                </span>
                <span className="text-gray-400">→</span>
                <span className="text-lg font-bold text-green-600">
                  {((analysis.postRenovation.metrics?.capRate || 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="text-xs text-green-600 mt-1">
                +{(((analysis.postRenovation.metrics?.capRate || 0) - (analysis.asIs.metrics?.capRate || 0)) * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Action Steps */}
      {analysis.actionPlan && analysis.actionPlan.length > 0 && (
        <div className="bg-white rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4">Step-by-Step Action Plan</h4>
          <div className="space-y-4">
            {analysis.actionPlan.map((step, i: number) => (
              <div key={i} className="flex gap-4 group">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center group-hover:bg-blue-700 transition-colors">
                  {i + 1}
                </div>
                <div className="flex-1 bg-gray-50 rounded-lg p-4 group-hover:bg-blue-50 transition-colors">
                  <h5 className="font-semibold text-gray-900 mb-1">{step.action}</h5>
                  {step.detail && <p className="text-sm text-gray-600">{step.detail}</p>}
                  <div className="flex items-center gap-3 mt-2">
                    {step.timeline && (
                      <span className="inline-block px-2 py-1 bg-white text-xs font-medium text-gray-700 rounded border">
                        ⏱️ {step.timeline}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border-2 p-6 text-center">
          <div className="text-sm font-medium text-gray-600 mb-1">Estimated Timeline</div>
          <div className="text-2xl font-bold text-gray-900">
            {analysis.postRenovation?.brrrr?.viable ? '6-12 mo' : '3-6 mo'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {analysis.postRenovation?.brrrr?.viable ? 'BRRRR Strategy' : 'Buy & Hold'}
          </div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6 text-center">
          <div className="text-sm font-medium text-gray-600 mb-1">Total Investment</div>
          <div className="text-2xl font-bold text-gray-900">
            ${((analysis.valuation.listPrice * 0.20) + (analysis.postRenovation?.renovationPlan.totalCost || 0)).toLocaleString()}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Down Payment + Renovation
          </div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6 text-center">
          <div className="text-sm font-medium text-gray-600 mb-1">Potential Returns</div>
          <div className="text-2xl font-bold text-green-600">
            ${analysis.wedgeOpportunities.reduce((sum: number, w) => sum + w.potentialProfit, 0).toLocaleString()}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            From {analysis.wedgeOpportunities.length} Wedge{analysis.wedgeOpportunities.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="bg-white rounded-xl border-2 p-6 text-center">
          <div className="text-sm font-medium text-gray-600 mb-1">Risk Level</div>
          <div className={`text-2xl font-bold ${
            analysis.wedgeOpportunities.filter((w) => w.risk === 'low').length > analysis.wedgeOpportunities.length / 2
              ? 'text-green-600' 
              : analysis.wedgeOpportunities.filter((w) => w.risk === 'high').length > analysis.wedgeOpportunities.length / 2
                ? 'text-red-600'
                : 'text-yellow-600'
          }`}>
            {analysis.wedgeOpportunities.filter((w) => w.risk === 'low').length > analysis.wedgeOpportunities.length / 2
              ? 'LOW' 
              : analysis.wedgeOpportunities.filter((w) => w.risk === 'high').length > analysis.wedgeOpportunities.length / 2
                ? 'HIGH'
                : 'MODERATE'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Overall Assessment
          </div>
        </div>
      </div>

      {/* Detailed Confidence Breakdown */}
      {analysis.confidenceBreakdown && (
        <div className="bg-gradient-to-br from-slate-50 to-gray-100 rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>🎯</span> Analysis Confidence Breakdown
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-lg p-4 border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Valuation</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  analysis.confidenceBreakdown.valuation >= 0.80 ? 'bg-green-100 text-green-700' :
                  analysis.confidenceBreakdown.valuation >= 0.60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {analysis.confidenceBreakdown.valuation >= 0.80 ? 'High' : analysis.confidenceBreakdown.valuation >= 0.60 ? 'Medium' : 'Low'}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${analysis.confidenceBreakdown.valuation >= 0.80 ? 'bg-green-500' : analysis.confidenceBreakdown.valuation >= 0.60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${analysis.confidenceBreakdown.valuation * 100}%` }}
                />
              </div>
              <div className="text-right text-xs text-gray-500 mt-1">{(analysis.confidenceBreakdown.valuation * 100).toFixed(0)}%</div>
            </div>
            
            <div className="bg-white rounded-lg p-4 border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Condition</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  analysis.confidenceBreakdown.condition >= 0.80 ? 'bg-green-100 text-green-700' :
                  analysis.confidenceBreakdown.condition >= 0.60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {analysis.confidenceBreakdown.condition >= 0.80 ? 'High' : analysis.confidenceBreakdown.condition >= 0.60 ? 'Medium' : 'Low'}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${analysis.confidenceBreakdown.condition >= 0.80 ? 'bg-green-500' : analysis.confidenceBreakdown.condition >= 0.60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${analysis.confidenceBreakdown.condition * 100}%` }}
                />
              </div>
              <div className="text-right text-xs text-gray-500 mt-1">{(analysis.confidenceBreakdown.condition * 100).toFixed(0)}%</div>
            </div>
            
            <div className="bg-white rounded-lg p-4 border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Renovation Costs</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  analysis.confidenceBreakdown.renovationCosts >= 0.80 ? 'bg-green-100 text-green-700' :
                  analysis.confidenceBreakdown.renovationCosts >= 0.60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {analysis.confidenceBreakdown.renovationCosts >= 0.80 ? 'High' : analysis.confidenceBreakdown.renovationCosts >= 0.60 ? 'Medium' : 'Low'}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${analysis.confidenceBreakdown.renovationCosts >= 0.80 ? 'bg-green-500' : analysis.confidenceBreakdown.renovationCosts >= 0.60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${analysis.confidenceBreakdown.renovationCosts * 100}%` }}
                />
              </div>
              <div className="text-right text-xs text-gray-500 mt-1">{(analysis.confidenceBreakdown.renovationCosts * 100).toFixed(0)}%</div>
            </div>
            
            <div className="bg-white rounded-lg p-4 border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Rental Viability</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  analysis.confidenceBreakdown.rentalViability >= 0.80 ? 'bg-green-100 text-green-700' :
                  analysis.confidenceBreakdown.rentalViability >= 0.60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {analysis.confidenceBreakdown.rentalViability >= 0.80 ? 'High' : analysis.confidenceBreakdown.rentalViability >= 0.60 ? 'Medium' : 'Low'}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${analysis.confidenceBreakdown.rentalViability >= 0.80 ? 'bg-green-500' : analysis.confidenceBreakdown.rentalViability >= 0.60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${analysis.confidenceBreakdown.rentalViability * 100}%` }}
                />
              </div>
              <div className="text-right text-xs text-gray-500 mt-1">{(analysis.confidenceBreakdown.rentalViability * 100).toFixed(0)}%</div>
            </div>
            
            <div className="bg-white rounded-lg p-4 border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Wedge Detection</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  analysis.confidenceBreakdown.wedgeDetection >= 0.80 ? 'bg-green-100 text-green-700' :
                  analysis.confidenceBreakdown.wedgeDetection >= 0.60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {analysis.confidenceBreakdown.wedgeDetection >= 0.80 ? 'High' : analysis.confidenceBreakdown.wedgeDetection >= 0.60 ? 'Medium' : 'Low'}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className={`h-2 rounded-full ${analysis.confidenceBreakdown.wedgeDetection >= 0.80 ? 'bg-green-500' : analysis.confidenceBreakdown.wedgeDetection >= 0.60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${analysis.confidenceBreakdown.wedgeDetection * 100}%` }}
                />
              </div>
              <div className="text-right text-xs text-gray-500 mt-1">{(analysis.confidenceBreakdown.wedgeDetection * 100).toFixed(0)}%</div>
            </div>
            
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-4 border-2 border-blue-300">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-blue-800">Overall</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  analysis.confidenceBreakdown.overall >= 0.80 ? 'bg-green-100 text-green-700' :
                  analysis.confidenceBreakdown.overall >= 0.60 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {analysis.confidenceBreakdown.overall >= 0.80 ? 'High' : analysis.confidenceBreakdown.overall >= 0.60 ? 'Medium' : 'Low'}
                </span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-2">
                <div 
                  className="h-2 rounded-full bg-blue-600"
                  style={{ width: `${analysis.confidenceBreakdown.overall * 100}%` }}
                />
              </div>
              <div className="text-right text-xs font-bold text-blue-700 mt-1">{(analysis.confidenceBreakdown.overall * 100).toFixed(0)}%</div>
            </div>
          </div>
        </div>
      )}

      {/* Data Sources */}
      {analysis.dataSources && (
        <div className="bg-white rounded-xl border-2 p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <span>📚</span> Data Sources
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="font-semibold text-gray-700 mb-1">Valuation</div>
              <div className="text-gray-600">{analysis.dataSources.valuation}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="font-semibold text-gray-700 mb-1">Condition</div>
              <div className="text-gray-600">{analysis.dataSources.condition}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="font-semibold text-gray-700 mb-1">Renovation Costs</div>
              <div className="text-gray-600">{analysis.dataSources.renovationCosts}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="font-semibold text-gray-700 mb-1">Rental Rates</div>
              <div className="text-gray-600">{analysis.dataSources.rentalRates}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="font-semibold text-gray-700 mb-1">Financing</div>
              <div className="text-gray-600">{analysis.dataSources.financing}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="font-semibold text-gray-700 mb-1">Expenses</div>
              <div className="text-gray-600">{analysis.dataSources.expenses}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
