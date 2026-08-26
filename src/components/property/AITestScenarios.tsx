import React, { useState, useCallback } from 'react';

interface FinancialInputs {
  monthlyRent: number;
  otherIncome: number;
  vacancyRate: number;
  taxAmount: number;
  insurance: number;
  utilities: number;
  hoa: number;
  repairsCapEx: number;
  managementPct: number;
  interestRate: number;
  loanTerm: number;
  downPayment: number;
  avm: number;
  rentGrowth: number;
  expenseInflation: number;
  taxGrowth: number;
  appreciationRate: number;
  isInterestOnly: boolean;
  extraPrincipal: number;
}

interface ScenarioEvent {
  year: number;
  type: 'refinance' | 'renovation' | 'rent_increase' | 'market_shift' | 'expense_change' | 'sell' | 'custom';
  label: string;
  description: string;
  impacts: {
    cashFlow?: number | null;
    propertyValue?: number | null;
    monthlyRent?: number | null;
    interestRate?: number | null;
    loanBalance?: number | null;
    expenses?: number | null;
  };
}

interface ScenarioResult {
  name: string;
  events: ScenarioEvent[];
  projectedCashFlow: number[];
  projectedEquity: number[];
  projectedPropertyValue: number[];
  projectedNOI: number[];
  projectedCoC: number[];
  finalLoanBalance: number;
  baselineTotalReturn: number;
  scenarioTotalReturn: number;
  irr: number;
  aiSummary: string;
  recommendations: string[];
}

export interface ScenarioProjections {
  cashFlow: number[];
  equity: number[];
  propertyValue: number[];
  noi: number[];
  coc: number[];
}

export interface ScenarioApplyChanges {
  monthlyRent?: number;
  interestRate?: number;
  appreciationRate?: number;
  projections?: ScenarioProjections;
  scenarioName?: string;
}

interface AITestScenariosProps {
  financialInputs: FinancialInputs | null;
  propertyDashboard: any;
  chartData: any;
  propertyImages?: Array<{ id: string; url: string; name: string }>;
  onScenarioApply?: (changes: ScenarioApplyChanges) => void;
}

const PRESET_SCENARIOS = [
  { id: 'cashout-refi-5yr', label: 'Cash-Out Refi (Yr 5)', icon: '💰', prompt: 'I plan to do a cash-out refinance in year 5, pulling out 75% LTV equity at market rates. Show the impact on my cash flow and equity projections.' },
  { id: 'kitchen-reno', label: 'Kitchen Renovation', icon: '🔨', prompt: 'I want to renovate the kitchen. Estimate the renovation cost, expected rent increase, and ROI timeline.' },
  { id: 'add-bedroom', label: 'Add Bedroom', icon: '🛏️', prompt: 'I want to convert a den or office into an additional bedroom to boost rental income. What is the impact?' },
  { id: 'rent-optimization', label: 'Rent Repricing', icon: '📈', prompt: 'Is my current rent optimally priced? Suggest an adjustment and show the multi-year cash flow impact.' },
  { id: 'market-downturn', label: 'Stress Test', icon: '📉', prompt: 'Stress test: market drops 15% in year 2 and recovers over 5 years. How does this affect my total return and IRR?' },
  { id: 'sensors', label: 'Smart Sensors', icon: '🔌', prompt: 'Smart home sensors reduce insurance and maintenance costs. Calculate the ROI over 10 years.' },
];

function computeBaselineProjections(inputs: FinancialInputs, years = 10) {
  const cashFlow: number[] = [];
  const equity: number[] = [];
  const propertyValue: number[] = [];
  const noi: number[] = [];
  const coc: number[] = [];

  const loanAmount = Math.max(inputs.avm - inputs.downPayment, 0);
  const monthlyRate = (inputs.interestRate / 100) / 12;
  const numPayments = inputs.loanTerm;
  const monthlyPayment = monthlyRate > 0 && numPayments > 0
    ? (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1)
    : 0;
  const totalCashInvested = Math.max(inputs.downPayment, 1);
  let balance = loanAmount;

  for (let yr = 1; yr <= years; yr++) {
    const rentGrowth = Math.pow(1 + (inputs.rentGrowth || 3) / 100, yr - 1);
    const expGrowth = Math.pow(1 + (inputs.expenseInflation || 2) / 100, yr - 1);
    const taxGrowth = Math.pow(1 + (inputs.taxGrowth || 2) / 100, yr - 1);
    const appGrowth = Math.pow(1 + (inputs.appreciationRate || 3) / 100, yr);

    const annualRent = inputs.monthlyRent * rentGrowth * 12;
    const otherIncome = (inputs.otherIncome || 0) * rentGrowth * 12;
    const grossIncome = annualRent + otherIncome;
    const vacancyLoss = grossIncome * ((inputs.vacancyRate || 5) / 100);
    const effectiveIncome = grossIncome - vacancyLoss;

    const taxes = (inputs.taxAmount || 0) * taxGrowth;
    const ins = (inputs.insurance || 0) * expGrowth;
    const util = (inputs.utilities || 0) * expGrowth;
    const hoaFees = (inputs.hoa || 0) * expGrowth;
    const repairs = (inputs.repairsCapEx || 0) * expGrowth;
    const mgmt = effectiveIncome * ((inputs.managementPct || 0) / 100);
    const totalOpEx = taxes + ins + util + hoaFees + repairs + mgmt;

    const yearNOI = effectiveIncome - totalOpEx;
    const debtService = monthlyPayment * 12;
    const yearCashFlow = yearNOI - debtService;
    const propValue = inputs.avm * appGrowth;

    let yearPrincipal = 0;
    for (let m = 0; m < 12; m++) {
      const interest = balance * monthlyRate;
      const principal = monthlyPayment - interest;
      yearPrincipal += Math.max(principal, 0);
      balance = Math.max(balance - principal, 0);
    }

    cashFlow.push(yearCashFlow);
    propertyValue.push(propValue);
    equity.push(propValue - balance);
    noi.push(yearNOI);
    coc.push((yearCashFlow / totalCashInvested) * 100);
  }

  return { cashFlow, equity, propertyValue, noi, coc, finalLoanBalance: balance };
}

function applyScenarioEvents(
  baseline: ReturnType<typeof computeBaselineProjections>,
  events: ScenarioEvent[],
  inputs: FinancialInputs,
) {
  const result = {
    cashFlow: [...baseline.cashFlow],
    equity: [...baseline.equity],
    propertyValue: [...baseline.propertyValue],
    noi: [...baseline.noi],
    coc: [...baseline.coc],
    finalLoanBalance: baseline.finalLoanBalance,
  };

  for (const event of events) {
    const yearIdx = event.year - 1;
    if (yearIdx < 0 || yearIdx >= result.cashFlow.length) continue;

    for (let y = yearIdx; y < result.cashFlow.length; y++) {
      if (event.impacts.cashFlow) result.cashFlow[y] += event.impacts.cashFlow;
      if (event.impacts.propertyValue) result.propertyValue[y] *= (1 + (event.impacts.propertyValue as number) / 100);
      if (event.impacts.monthlyRent) {
        const rentBoost = (event.impacts.monthlyRent as number) * 12;
        result.noi[y] += rentBoost;
        result.cashFlow[y] += rentBoost;
      }
      if (event.impacts.expenses) result.cashFlow[y] -= (event.impacts.expenses as number);
    }
    // Recompute equity after property value changes
    for (let y = yearIdx; y < result.cashFlow.length; y++) {
      result.equity[y] = result.propertyValue[y] - result.finalLoanBalance;
    }
    // Recompute CoC
    const totalInvested = Math.max(inputs.downPayment, 1);
    for (let y = yearIdx; y < result.cashFlow.length; y++) {
      result.coc[y] = (result.cashFlow[y] / totalInvested) * 100;
    }
  }

  return result;
}

function MiniChart({ baseline, scenario, labels, title, color, eventYears }: {
  baseline: number[]; scenario: number[]; labels: string[]; title: string; color: string; eventYears: number[];
}) {
  const w = 280;
  const h = 110;
  const pL = 38;
  const pR = 8;
  const pT = 6;
  const pB = 20;
  const iW = w - pL - pR;
  const iH = h - pT - pB;
  const all = [...baseline, ...scenario];
  const maxV = Math.max(...all, 1);
  const minV = Math.min(...all, 0);
  const range = maxV - minV || 1;
  const xS = (i: number) => pL + (i / Math.max(baseline.length - 1, 1)) * iW;
  const yS = (v: number) => pT + iH - ((v - minV) / range) * iH;
  const fmt = (v: number) => {
    const abs = Math.abs(v);
    const s = v < 0 ? '-' : '';
    if (abs >= 1_000_000) return `${s}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${s}$${(abs / 1_000).toFixed(0)}k`;
    return `${s}$${abs.toFixed(0)}`;
  };
  const yTick = (minV + maxV) / 2;

  return (
    <div>
      <div className="text-[11px] font-semibold text-slate-600 mb-1">{title}</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 90 }}>
        <line x1={pL} x2={pL + iW} y1={pT + iH} y2={pT + iH} stroke="#e2e8f0" strokeWidth={1} />
        <text x={pL - 3} y={yS(yTick) + 4} textAnchor="end" fontSize={8} fill="#94a3b8">{fmt(yTick)}</text>
        <path d={baseline.map((v, i) => `${i === 0 ? 'M' : 'L'}${xS(i)},${yS(v)}`).join(' ')} fill="none" stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="4 3" />
        <path d={scenario.map((v, i) => `${i === 0 ? 'M' : 'L'}${xS(i)},${yS(v)}`).join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
        {eventYears.map((yr) => (
          <line key={yr} x1={xS(yr - 1)} x2={xS(yr - 1)} y1={pT} y2={pT + iH} stroke="#f97316" strokeWidth={1.5} strokeDasharray="3 2" opacity={0.7} />
        ))}
        {labels.filter((_, i) => i % 3 === 0 || i === labels.length - 1).map((label) => {
          const origIdx = labels.indexOf(label);
          return <text key={origIdx} x={xS(origIdx)} y={h - 4} textAnchor="middle" fontSize={8} fill="#94a3b8">{label}</text>;
        })}
      </svg>
    </div>
  );
}

export default function AITestScenarios({ financialInputs, propertyDashboard, chartData, propertyImages, onScenarioApply }: AITestScenariosProps) {
  const [userPrompt, setUserPrompt] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [activeScenario, setActiveScenario] = useState<ScenarioResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [savedScenarios, setSavedScenarios] = useState<ScenarioResult[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  const yearLabels = Array.from({ length: 10 }, (_, i) => `Y${i + 1}`);

  const formatCurrency = (v: number) => {
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
    return `${sign}$${abs.toFixed(0)}`;
  };

  const analyzeScenario = useCallback(async (prompt: string) => {
    if (!financialInputs) {
      setError('Load property data first.');
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setActiveScenario(null);
    setApplied(false);

    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;

      const baseline = computeBaselineProjections(financialInputs, 10);

      // Per-year cash flows for AI context
      const annualCashFlows = baseline.cashFlow.map(v => Math.round(v));

      const systemPrompt = `You are a real estate investment analyst. Analyze the user's scenario for this specific property.

Property data:
- Address: ${propertyDashboard?.summary?.address || 'N/A'}
- AVM (current value): $${financialInputs.avm?.toLocaleString()}
- Monthly rent: $${financialInputs.monthlyRent?.toLocaleString()}
- Down payment: $${financialInputs.downPayment?.toLocaleString()}
- Interest rate: ${financialInputs.interestRate}%
- Annual property tax: $${financialInputs.taxAmount?.toLocaleString()}
- Annual insurance: $${financialInputs.insurance?.toLocaleString()}
- Beds/Baths: ${propertyDashboard?.summary?.beds}bd/${propertyDashboard?.summary?.baths}ba
- Sqft: ${propertyDashboard?.summary?.living_sqft?.toLocaleString()}
- Year built: ${propertyDashboard?.summary?.year_built}
- Appreciation rate: ${financialInputs.appreciationRate}%/yr
- Baseline 10-yr annual cash flows ($): ${JSON.stringify(annualCashFlows)}
- Year 10 baseline property value: $${Math.round(baseline.propertyValue[9]).toLocaleString()}
- Images available: ${(propertyImages?.length || 0) > 0}

Return ONLY valid JSON (no markdown) exactly matching this schema:
{
  "name": "short scenario name",
  "events": [{
    "year": 1,
    "type": "refinance|renovation|rent_increase|market_shift|expense_change|sell|custom",
    "label": "short label",
    "description": "1-2 sentence description",
    "impacts": {
      "cashFlow": annual_dollar_impact_number_or_null,
      "propertyValue": percent_change_number_or_null,
      "monthlyRent": additional_monthly_dollars_or_null,
      "interestRate": new_rate_if_refi_else_null,
      "expenses": additional_annual_cost_or_null
    }
  }],
  "aiSummary": "2-sentence realistic analysis",
  "recommendations": ["actionable suggestion 1", "actionable suggestion 2", "actionable suggestion 3"]
}

All impact dollar amounts must be reasonable for this specific property. cashFlow is the NET annual change in dollars (positive = better, negative = worse). Renovation costs should appear as negative cashFlow or expenses in the event year only.`;

      const url = useProxy
        ? '/api/ai/chat'
        : (() => { const u = new URL(baseEnv || 'http://127.0.0.1:3001'); u.pathname = '/api/ai/chat'; return u.toString(); })();

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          model: 'gpt-4o',
          temperature: 0.3,
          response_format: { type: 'json_object' },
        }),
      });

      if (!resp.ok) throw new Error(`AI request failed: ${resp.status}`);

      const aiResp = await resp.json();
      const content = aiResp.choices?.[0]?.message?.content || aiResp.content || aiResp.response;

      let parsed: any;
      try {
        parsed = typeof content === 'string' ? JSON.parse(content) : content;
      } catch {
        throw new Error('Failed to parse AI response');
      }

      const events: ScenarioEvent[] = (parsed.events || []).map((e: any) => ({
        year: Math.max(1, Math.min(10, Number(e.year) || 1)),
        type: e.type || 'custom',
        label: e.label || 'Event',
        description: e.description || '',
        impacts: {
          cashFlow: e.impacts?.cashFlow ?? null,
          propertyValue: e.impacts?.propertyValue ?? null,
          monthlyRent: e.impacts?.monthlyRent ?? null,
          interestRate: e.impacts?.interestRate ?? null,
          loanBalance: null,
          expenses: e.impacts?.expenses ?? null,
        },
      }));

      const scenarioProjections = applyScenarioEvents(baseline, events, financialInputs);

      // Total return = cumulative cash flow + appreciation gain over purchase price
      const baselineTotalReturn =
        baseline.cashFlow.reduce((s, v) => s + v, 0) +
        (baseline.propertyValue[9] - financialInputs.avm);

      const scenarioTotalReturn =
        scenarioProjections.cashFlow.reduce((s, v) => s + v, 0) +
        (scenarioProjections.propertyValue[9] - financialInputs.avm);

      // IRR: CAGR of final equity vs initial investment
      const finalEquity = scenarioProjections.propertyValue[9] - scenarioProjections.finalLoanBalance +
        scenarioProjections.cashFlow.reduce((s, v) => s + v, 0);
      const initialInvestment = Math.max(financialInputs.downPayment, 1);
      const irr = finalEquity > 0 ? (Math.pow(finalEquity / initialInvestment, 1 / 10) - 1) * 100 : 0;

      setActiveScenario({
        name: parsed.name || 'Scenario',
        events,
        projectedCashFlow: scenarioProjections.cashFlow,
        projectedEquity: scenarioProjections.equity,
        projectedPropertyValue: scenarioProjections.propertyValue,
        projectedNOI: scenarioProjections.noi,
        projectedCoC: scenarioProjections.coc,
        finalLoanBalance: scenarioProjections.finalLoanBalance,
        baselineTotalReturn,
        scenarioTotalReturn,
        irr,
        aiSummary: parsed.aiSummary || '',
        recommendations: parsed.recommendations || [],
      });
    } catch (err: any) {
      console.error('[AIScenarios]', err);
      setError(err.message || 'Analysis failed');
    } finally {
      setIsAnalyzing(false);
    }
  }, [financialInputs, propertyDashboard, propertyImages]);

  const handleApplyToCharts = () => {
    if (!activeScenario || !financialInputs || !onScenarioApply) return;
    const changes: ScenarioApplyChanges = {};
    let totalMonthlyRentDelta = 0;
    let newInterestRate: number | undefined;
    let newAppreciationRate: number | undefined;
    for (const event of activeScenario.events) {
      if (event.impacts.monthlyRent) totalMonthlyRentDelta += event.impacts.monthlyRent as number;
      if (event.type === 'refinance' && event.impacts.interestRate) newInterestRate = event.impacts.interestRate as number;
      if (event.type === 'market_shift' && event.impacts.propertyValue) {
        const annualImpact = (event.impacts.propertyValue as number) / 10;
        newAppreciationRate = financialInputs.appreciationRate + annualImpact;
      }
    }
    if (totalMonthlyRentDelta !== 0) changes.monthlyRent = financialInputs.monthlyRent + totalMonthlyRentDelta;
    if (newInterestRate !== undefined) changes.interestRate = newInterestRate;
    if (newAppreciationRate !== undefined) changes.appreciationRate = newAppreciationRate;
    changes.projections = {
      cashFlow: activeScenario.projectedCashFlow,
      equity: activeScenario.projectedEquity,
      propertyValue: activeScenario.projectedPropertyValue,
      noi: activeScenario.projectedNOI,
      coc: activeScenario.projectedCoC,
    };
    changes.scenarioName = activeScenario.name;
    onScenarioApply(changes);
    setApplied(true);
  };

  const handleSaveScenario = () => {
    if (!activeScenario) return;
    setSavedScenarios((prev) => {
      const exists = prev.some((s) => s.name === activeScenario.name);
      if (exists) return prev.map((s) => s.name === activeScenario.name ? activeScenario : s);
      return [...prev, activeScenario];
    });
  };

  const handleApplySaved = (scenario: ScenarioResult) => {
    if (!financialInputs || !onScenarioApply) return;
    const changes: ScenarioApplyChanges = {
      projections: {
        cashFlow: scenario.projectedCashFlow,
        equity: scenario.projectedEquity,
        propertyValue: scenario.projectedPropertyValue,
        noi: scenario.projectedNOI,
        coc: scenario.projectedCoC,
      },
      scenarioName: scenario.name,
    };
    let totalMonthlyRentDelta = 0;
    let newInterestRate: number | undefined;
    let newAppreciationRate: number | undefined;
    for (const event of scenario.events) {
      if (event.impacts.monthlyRent) totalMonthlyRentDelta += event.impacts.monthlyRent as number;
      if (event.type === 'refinance' && event.impacts.interestRate) newInterestRate = event.impacts.interestRate as number;
      if (event.type === 'market_shift' && event.impacts.propertyValue) {
        const annualImpact = (event.impacts.propertyValue as number) / 10;
        newAppreciationRate = financialInputs.appreciationRate + annualImpact;
      }
    }
    if (totalMonthlyRentDelta !== 0) changes.monthlyRent = financialInputs.monthlyRent + totalMonthlyRentDelta;
    if (newInterestRate !== undefined) changes.interestRate = newInterestRate;
    if (newAppreciationRate !== undefined) changes.appreciationRate = newAppreciationRate;
    onScenarioApply(changes);
    setActiveScenario(scenario);
    setApplied(true);
  };

  const handleDeleteSaved = (name: string) => {
    setSavedScenarios((prev) => prev.filter((s) => s.name !== name));
  };

  const baseline = financialInputs ? computeBaselineProjections(financialInputs, 10) : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
            <svg className="h-3.5 w-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-bold text-slate-900">AI Scenario Analysis</div>
            <div className="text-[11px] text-slate-500">Test investment scenarios and see projected impact</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {savedScenarios.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSaved((v) => !v)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${showSaved ? 'border-purple-300 bg-purple-100 text-purple-700' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              Saved ({savedScenarios.length})
            </button>
          )}
          {isAnalyzing && (
            <div className="flex items-center gap-1.5 text-xs text-purple-600 font-medium">
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Analyzing...
            </div>
          )}
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Quick scenario chips */}
        <div className="flex flex-wrap gap-1.5">
          {PRESET_SCENARIOS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => { setUserPrompt(preset.prompt); analyzeScenario(preset.prompt); }}
              disabled={isAnalyzing || !financialInputs}
              className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] font-medium text-slate-600 transition-all hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>{preset.icon}</span>
              <span>{preset.label}</span>
            </button>
          ))}
        </div>

        {/* Custom input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && userPrompt.trim()) analyzeScenario(userPrompt); }}
            placeholder="Describe a custom scenario... e.g., 'What if I refinance and renovate in year 3?'"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-100"
          />
          <button
            type="button"
            onClick={() => userPrompt.trim() && analyzeScenario(userPrompt)}
            disabled={isAnalyzing || !userPrompt.trim() || !financialInputs}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Analyze
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        )}

        {/* Saved Scenarios Panel */}
        {showSaved && savedScenarios.length > 0 && (
          <div className="rounded-xl border border-purple-200 bg-purple-50/60 p-4 space-y-2">
            <div className="text-[10px] font-semibold text-purple-600 uppercase tracking-wider mb-3">Saved Scenarios</div>
            {savedScenarios.map((scenario) => {
              const cfDiff = scenario.scenarioTotalReturn - scenario.baselineTotalReturn;
              return (
                <div key={scenario.name} className="flex items-center gap-3 rounded-lg border border-purple-100 bg-white px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-800 truncate">{scenario.name}</div>
                    <div className={`text-[11px] font-medium ${cfDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {cfDiff >= 0 ? '+' : ''}{formatCurrency(cfDiff)} vs baseline · IRR {scenario.irr > 0 ? `${scenario.irr.toFixed(1)}%` : 'N/A'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setActiveScenario(scenario); setApplied(false); setShowSaved(false); }}
                      className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-slate-600 border border-slate-200 hover:bg-slate-100"
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApplySaved(scenario)}
                      disabled={!onScenarioApply}
                      className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 disabled:opacity-40"
                    >
                      Apply to Charts
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteSaved(scenario.name)}
                      className="rounded-md p-1 text-slate-400 hover:text-red-500 hover:bg-red-50"
                      title="Delete"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Results */}
        {activeScenario && baseline && (
          <div className="border-t border-slate-100 pt-4 space-y-4">
            {/* Scenario name + summary */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-[11px] font-bold text-purple-700">{activeScenario.name}</span>
                  {applied && <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-[11px] font-bold text-green-700">Applied to Charts</span>}
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">{activeScenario.aiSummary}</p>
              </div>
              <button
                type="button"
                onClick={() => { setActiveScenario(null); setApplied(false); }}
                className="flex-shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Impact metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(() => {
                const baselineCF = baseline.cashFlow.reduce((s, v) => s + v, 0);
                const scenarioCF = activeScenario.projectedCashFlow.reduce((s, v) => s + v, 0);
                const cfDiff = scenarioCF - baselineCF;
                const returnDiff = activeScenario.scenarioTotalReturn - activeScenario.baselineTotalReturn;
                return (
                  <>
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">10yr Cash Flow</div>
                      <div className="text-base font-bold text-slate-900">{formatCurrency(scenarioCF)}</div>
                      <div className={`text-[11px] font-semibold ${cfDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {cfDiff >= 0 ? '+' : ''}{formatCurrency(cfDiff)} vs baseline
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Yr 10 Value</div>
                      <div className="text-base font-bold text-slate-900">{formatCurrency(activeScenario.projectedPropertyValue[9] || 0)}</div>
                      <div className={`text-[11px] font-semibold ${(activeScenario.projectedPropertyValue[9] || 0) >= (baseline.propertyValue[9] || 0) ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency((activeScenario.projectedPropertyValue[9] || 0) - (baseline.propertyValue[9] || 0))} vs baseline
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Return Delta</div>
                      <div className={`text-base font-bold ${returnDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {returnDiff >= 0 ? '+' : ''}{formatCurrency(returnDiff)}
                      </div>
                      <div className="text-[11px] text-slate-500">vs baseline 10yr total</div>
                    </div>
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Est. IRR</div>
                      <div className="text-base font-bold text-slate-900">{activeScenario.irr > 0 ? `${activeScenario.irr.toFixed(1)}%` : 'N/A'}</div>
                      <div className="text-[11px] text-slate-500">Annualized CAGR</div>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Mini comparison charts - 2x2 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <MiniChart baseline={baseline.cashFlow} scenario={activeScenario.projectedCashFlow} labels={yearLabels} title="Annual Cash Flow" color="#3b82f6" eventYears={activeScenario.events.map(e => e.year)} />
              <MiniChart baseline={baseline.propertyValue} scenario={activeScenario.projectedPropertyValue} labels={yearLabels} title="Property Value" color="#10b981" eventYears={activeScenario.events.map(e => e.year)} />
              <MiniChart baseline={baseline.equity} scenario={activeScenario.projectedEquity} labels={yearLabels} title="Equity" color="#8b5cf6" eventYears={activeScenario.events.map(e => e.year)} />
              <MiniChart baseline={baseline.coc} scenario={activeScenario.projectedCoC} labels={yearLabels} title="CoC Return %" color="#f97316" eventYears={activeScenario.events.map(e => e.year)} />
            </div>

            {/* Legend + event list + actions row */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
              {/* Legend */}
              <div className="flex items-center gap-4 text-[11px] text-slate-500">
                <div className="flex items-center gap-1.5">
                  <div className="w-6 border-t-[1.5px] border-dashed border-slate-400" />
                  <span>Baseline</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-6 border-t-2 border-blue-500 rounded" />
                  <span>Scenario</span>
                </div>
                {activeScenario.events.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-4 border-t-[1.5px] border-dashed border-orange-400" />
                    <span>Event</span>
                  </div>
                )}
              </div>

              {/* Apply button */}
              {onScenarioApply && !applied && (
                <button
                  type="button"
                  onClick={handleApplyToCharts}
                  className="rounded-lg border border-purple-200 bg-gradient-to-r from-purple-50 to-blue-50 px-4 py-2 text-xs font-semibold text-purple-700 transition-all hover:from-purple-100 hover:to-blue-100"
                >
                  Apply to Main Charts →
                </button>
              )}
              <button
                type="button"
                onClick={handleSaveScenario}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 flex items-center gap-1.5"
                title="Save this scenario"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                Save
              </button>
            </div>

            {/* Events */}
            {activeScenario.events.length > 0 && (
              <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Scenario Events</div>
                <div className="space-y-2">
                  {activeScenario.events.map((event, idx) => (
                    <div key={idx} className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-orange-100 text-[10px] font-bold text-orange-700">
                        Y{event.year}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-slate-800">{event.label}</div>
                        <div className="text-[11px] text-slate-500">{event.description}</div>
                      </div>
                      <div className="flex-shrink-0 text-right text-[11px]">
                        {event.impacts.monthlyRent != null && event.impacts.monthlyRent !== 0 && (
                          <div className={`font-semibold ${(event.impacts.monthlyRent as number) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {(event.impacts.monthlyRent as number) > 0 ? '+' : ''}${event.impacts.monthlyRent}/mo
                          </div>
                        )}
                        {event.impacts.propertyValue != null && event.impacts.propertyValue !== 0 && (
                          <div className={`font-semibold ${(event.impacts.propertyValue as number) > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                            {(event.impacts.propertyValue as number) > 0 ? '+' : ''}{(event.impacts.propertyValue as number).toFixed(1)}% value
                          </div>
                        )}
                        {event.impacts.cashFlow != null && event.impacts.cashFlow !== 0 && (
                          <div className={`font-semibold ${(event.impacts.cashFlow as number) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {(event.impacts.cashFlow as number) > 0 ? '+' : ''}{formatCurrency(event.impacts.cashFlow as number)}/yr
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* AI Recommendations */}
            {activeScenario.recommendations.length > 0 && (
              <div className="rounded-xl border border-purple-100 bg-gradient-to-br from-purple-50/60 to-blue-50/60 px-4 py-3">
                <div className="text-[10px] font-semibold text-purple-600 uppercase tracking-wider mb-2">AI Recommendations</div>
                <ul className="space-y-1">
                  {activeScenario.recommendations.map((rec, idx) => (
                    <li key={idx} className="flex items-start gap-1.5 text-xs text-slate-700">
                      <span className="text-purple-500 font-bold mt-0.5">›</span>
                      <span>{rec}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
