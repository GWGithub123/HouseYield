/**
 * AI Financial Planner Service
 * Communicates with the backend Claude AI endpoint for retirement planning advice
 */

import { getUserPreference, setUserPreference } from './userPreferencesService';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export interface FinancialPlannerProjectionPoint {
  year: number;
  yearsFromNow: number;
  costOfLiving: number;
  investmentIncome: number;
  accountValue: number;
  surplus: number;
  canRetire: boolean;
}

export interface FinancialPlannerProjectionSummary {
  currentYear: number;
  projectionYears: number;
  fiYear: number | null;
  currentAnnualCostOfLiving: number;
  currentAnnualInvestmentIncome: number;
  currentAnnualSurplus: number;
  plannedRetirementYear: number | null;
  plannedRetirementIncome?: number | null;
  plannedRetirementCostOfLiving?: number | null;
  plannedRetirementSurplus?: number | null;
}

export interface RetirementScenarioPortfolioReallocation {
  enabled: boolean;
  year: number;
  targetAssetName: string;
  targetTicker?: string;
  targetYield: number;
  targetGrowth: number;
  sellStocks: boolean;
  sellBonds: boolean;
  sellRealEstate: boolean;
  sellCash: boolean;
}

export interface FinancialContext {
  stockValue: number;
  bondValue: number;
  realEstateValue: number;
  cashValue: number;
  totalValue: number;
  stockCount: number;
  propertyCount: number;
  dividendIncome: number;
  bondIncome: number;
  rentalIncome: number;
  totalInvestmentIncome: number;
  monthlyCostOfLiving: number;
  spendingReduction: number;
  stockGrowth: number;
  dividendGrowth: number;
  dividendYield: number;
  bondYield: number;
  propertyAppreciation: number;
  rentGrowth: number;
  inflation: number;
  retirementYear: number | null;
  monthlyContribution: number;
  drip: boolean;
  fiYear: number | null;
  propertySale: boolean;
  propertySaleYear: number;
  propertyPurchase: boolean;
  expenseCategories?: { category: string; monthlyAverage: number }[];
  properties?: { name: string; value: number; monthlyRent?: number }[];
  projectionYears?: number;
  projectionSummary?: FinancialPlannerProjectionSummary | null;
  projectionPoints?: FinancialPlannerProjectionPoint[];
  cachedAt?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: AIAction[];
  timestamp: number;
}

export interface AIAction {
  type: 
    | 'setRetirementYear'
    | 'sellProperty'
    | 'buyProperty'
    | 'adjustSpending'
    | 'adjustContributions'
    | 'adjustGrowthAssumptions'
    | 'setMonthlyCostOfLiving'
    | 'bigPurchase'
    | 'reallocatePortfolio';
  [key: string]: any;
}

export interface RetirementScenarioTimelineHint {
  kind: 'retirement' | 'propertyPurchase' | 'propertySale' | 'bigPurchase' | 'scenario';
  year: number;
  label: string;
  title: string;
  description: string;
}

export interface RetirementScenarioBigPurchase {
  id: string;
  year: number;
  amount: number;
  description: string;
  ongoingMonthlyCost?: number;
}

export interface RetirementScenario {
  id: string;
  name: string;
  createdAt: number;
  summary?: string;
  notes?: string[];
  timelineHints?: RetirementScenarioTimelineHint[];
  parameters: {
    retirementYear: number | null;
    monthlyCostOfLiving: number;
    monthlyContribution: number;
    spendingReduction: number;
    drip: boolean;
    propertySale: boolean;
    propertySaleYear: number;
    propertySaleAllocation: { cash: number; stocks: number; bonds: number };
    propertyPurchase: boolean;
    propertyPurchaseYear: number;
    propertyPurchaseDetails: any;
    stockGrowth: number;
    dividendGrowth: number;
    dividendYield: number;
    bondYield: number;
    propertyAppreciation: number;
    rentGrowth: number;
    bigPurchases?: RetirementScenarioBigPurchase[];
    portfolioReallocation?: RetirementScenarioPortfolioReallocation;
  };
  fiYear: number | null;
  source: 'manual' | 'ai';
}

export interface FinancialPlannerDraftScenario {
  id: string;
  name: string;
  summary: string;
  notes: string[];
  timelineHints?: RetirementScenarioTimelineHint[];
  parameters?: Partial<RetirementScenario['parameters']>;
  fiYear?: number | null;
  saveRecommended?: boolean;
  updatedAt?: number;
}

export interface SendFinancialPlannerChatResult {
  message: string;
  actions: AIAction[];
  scenarioDrafts: FinancialPlannerDraftScenario[];
}

export async function sendChatMessage(
  messages: { role: string; content: string }[],
  financialContext: FinancialContext,
  idToken?: string | null,
): Promise<SendFinancialPlannerChatResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  const response = await fetch(`${API_BASE}/api/ai-financial-planner/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, financialContext }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `AI request failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'AI request failed');

  return {
    message: data.message,
    actions: data.actions || [],
    scenarioDrafts: data.scenarioDrafts || [],
  };
}

const SCENARIOS_STORAGE_KEY = 'houseyield_retirement_scenarios';
const SCENARIOS_FIELD = 'retirementScenarios';

export async function saveScenario(userId: string, scenario: RetirementScenario): Promise<RetirementScenario[]> {
  const scenarios = await getScenarios(userId);
  const existingIdx = scenarios.findIndex(s => s.id === scenario.id);
  if (existingIdx >= 0) {
    scenarios[existingIdx] = scenario;
  } else {
    scenarios.unshift(scenario);
  }
  if (scenarios.length > 20) scenarios.length = 20;

  const result = await setUserPreference(userId, SCENARIOS_FIELD, scenarios);
  if (!result.success) {
    throw new Error(result.error || 'Failed to save retirement scenario');
  }

  if (typeof window !== 'undefined') {
    localStorage.removeItem(SCENARIOS_STORAGE_KEY);
  }

  return scenarios;
}

export async function getScenarios(userId: string): Promise<RetirementScenario[]> {
  const scenarios = await getUserPreference<RetirementScenario[]>(userId, SCENARIOS_FIELD, []);

  if (typeof window !== 'undefined') {
    localStorage.removeItem(SCENARIOS_STORAGE_KEY);
  }

  return scenarios;
}

export async function deleteScenario(userId: string, id: string): Promise<RetirementScenario[]> {
  const scenarios = (await getScenarios(userId)).filter(s => s.id !== id);
  const result = await setUserPreference(userId, SCENARIOS_FIELD, scenarios);
  if (!result.success) {
    throw new Error(result.error || 'Failed to delete retirement scenario');
  }

  if (typeof window !== 'undefined') {
    localStorage.removeItem(SCENARIOS_STORAGE_KEY);
  }

  return scenarios;
}

export function generateScenarioId(): string {
  return `scenario_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
