/**
 * FinancialReservesAnalytics - Comprehensive financial analytics dashboard
 * Uses data passed from parent (App.tsx) - no API calls needed
 * Includes:
 * - Monthly Reserves Donut Chart (budget vs spent)
 * - Total Property Reserves with threshold marker
 * - Weekly spending comparison
 * - AI-powered expense category breakdown
 */

import { useState, useEffect, useMemo } from 'react';
import SavingsGoalTracker from './SavingsGoalTracker';
import GoalSetupModal from './GoalSetupModal';
import { SavingsGoal, SavingsAccount, RenovationOpportunity, GoalSetupData } from '../types/savingsGoal';

interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
  category?: string;
  status?: string;
}

interface Summary {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  margin?: number;
}

interface Category {
  name: string;
  amount: number;
  type?: 'income' | 'expense';
}

interface ExpenseCategory {
  name: string;
  amount: number;
  percentage: number;
  color: string;
}

interface FinancialReservesAnalyticsProps {
  userId: string;
  propertyId?: string;
  // Data passed from parent
  transactions?: Transaction[];
  summary?: Summary | null;
  categories?: Category[];
  monthlyBudget?: number;
  onRefresh?: () => void;
  accountBalance?: number | null; // Balance from connected bank account
  // Savings goals data
  savingsGoals?: SavingsGoal[];
  savingsAccounts?: SavingsAccount[];
  renovationOpportunities?: RenovationOpportunity[];
  onCreateGoal?: (goal: SavingsGoal) => void;
  onUpdateGoal?: (goal: SavingsGoal) => void;
  onDeleteGoal?: (goalId: string) => void;
}

export default function FinancialReservesAnalytics({ 
  userId,
  propertyId = '',
  transactions = [],
  summary: _summary = null,
  categories = [],
  monthlyBudget = 5000,
  onRefresh,
  accountBalance: propAccountBalance,
  savingsGoals = [],
  savingsAccounts = [],
  renovationOpportunities = [],
  onCreateGoal,
  onUpdateGoal,
  onDeleteGoal,
}: FinancialReservesAnalyticsProps) {
  const [reserveThreshold, setReserveThreshold] = useState<number>(10000);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budget, setBudget] = useState(monthlyBudget);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [accountBalance, setAccountBalance] = useState<number | null>(propAccountBalance ?? null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [showGoalModal, setShowGoalModal] = useState(false);
  
  // Local state for goals - use prop if provided, otherwise manage internally
  const [localGoals, setLocalGoals] = useState<SavingsGoal[]>(savingsGoals);
  
  // Sync local goals with props when they change
  useEffect(() => {
    if (savingsGoals.length > 0) {
      setLocalGoals(savingsGoals);
    }
  }, [savingsGoals]);
  
  // Use local goals for rendering
  const activeGoals = localGoals.length > 0 ? localGoals : savingsGoals;

  const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  // Fetch account balance from Stripe Financial Connections
  const fetchAccountBalance = async () => {
    if (!userId || userId === 'demo-user') return;
    
    setBalanceLoading(true);
    try {
      const response = await fetch(`${baseUrl}/api/stripe-connect/financial-connections-balance/${userId}`);
      const data = await response.json();
      console.log('[FinancialReserves] Balance API response:', data);
      
      if (data.ok && data.totals) {
        // Backend already returns in dollars, not cents
        const balance = data.totals.available ?? data.totals.current ?? 0;
        console.log('[FinancialReserves] Setting balance to:', balance);
        setAccountBalance(balance);
      } else {
        console.warn('[FinancialReserves] No balance data:', data);
      }
    } catch (err) {
      console.error('[FinancialReserves] Error fetching account balance:', err);
    } finally {
      setBalanceLoading(false);
    }
  };

  // Handle goal creation from modal
  const handleCreateGoal = (goalData: GoalSetupData, accountId: string) => {
    console.log('[FinancialReserves] Creating goal:', goalData, 'accountId:', accountId);
    
    const newGoal: SavingsGoal = {
      id: `goal-${Date.now()}`,
      userId,
      propertyId,
      name: goalData.name,
      description: goalData.description,
      type: goalData.type,
      targetAmount: goalData.targetAmount,
      currentSaved: accountBalance ?? 0, // Start with current account balance as "saved"
      deadline: goalData.deadline,
      priority: goalData.priority,
      accountId,
      accountType: 'primary',
      renovationId: goalData.renovation?.id,
      renovation: goalData.renovation,
      createdAt: new Date(),
      updatedAt: new Date(),
      isActive: true,
    };
    
    console.log('[FinancialReserves] New goal created:', newGoal);
    
    // Add to local state
    setLocalGoals(prev => {
      const updated = [...prev, newGoal];
      console.log('[FinancialReserves] Updated goals list:', updated);
      return updated;
    });
    
    // Also call external handler if provided
    onCreateGoal?.(newGoal);
    setShowGoalModal(false);
  };
  
  // Handle goal update
  const handleUpdateGoal = (updatedGoal: SavingsGoal) => {
    setLocalGoals(prev => prev.map(g => g.id === updatedGoal.id ? updatedGoal : g));
    onUpdateGoal?.(updatedGoal);
  };
  
  // Handle goal deletion
  const handleDeleteGoal = (goalId: string) => {
    setLocalGoals(prev => prev.filter(g => g.id !== goalId));
    onDeleteGoal?.(goalId);
  };

  // Fetch balance on mount
  useEffect(() => {
    if (propAccountBalance === undefined) {
      fetchAccountBalance();
    }
  }, [userId]);

  // Calculate totals from the most recent month that has data
  // If the current month has transactions, use it; otherwise find the latest month
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const { activeMonth, activeYear } = useMemo(() => {
    // First try the current month
    const currentMonthHasData = transactions.some(t => {
      const d = new Date(t.date);
      return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    });
    if (currentMonthHasData) return { activeMonth: currentMonth, activeYear: currentYear };

    // Find the most recent month with transactions
    let latestDate: Date | null = null;
    for (const t of transactions) {
      const d = new Date(t.date);
      if (!latestDate || d > latestDate) latestDate = d;
    }
    if (latestDate) return { activeMonth: latestDate.getMonth(), activeYear: latestDate.getFullYear() };
    return { activeMonth: currentMonth, activeYear: currentYear };
  }, [transactions, currentMonth, currentYear]);

  const currentMonthTransactions = transactions.filter(t => {
    const d = new Date(t.date);
    return d.getMonth() === activeMonth && d.getFullYear() === activeYear;
  });
  
  const currentMonthIncome = currentMonthTransactions
    .filter(t => t.type === 'income' || t.amount > 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
  const currentMonthExpenses = currentMonthTransactions
    .filter(t => t.type === 'expense' || t.amount < 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  // Create demo savings accounts from account balance
  const demoSavingsAccounts: SavingsAccount[] = savingsAccounts.length > 0 ? savingsAccounts : [
    {
      id: 'primary-account',
      userId,
      propertyId,
      name: 'Primary Operations Account',
      type: 'primary',
      currentBalance: accountBalance ?? 0,
      totalIncome: currentMonthIncome,
      totalExpenses: currentMonthExpenses,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  // Demo renovation opportunities if none provided
  const demoRenovationOpportunities: RenovationOpportunity[] = renovationOpportunities.length > 0 ? renovationOpportunities : [
    {
      id: 'washer-dryer',
      type: 'appliance',
      name: 'Washer/Dryer In-Unit',
      estimatedCost: 3000,
      roi: 40,
      potentialRentIncrease: 100,
      paybackMonths: 30,
      estimatedImpact: { rentIncrease: 100, timeToPayback: 30 },
    },
    {
      id: 'smart-home',
      type: 'technology',
      name: 'Smart Home Features',
      estimatedCost: 2500,
      roi: 24,
      potentialRentIncrease: 50,
      paybackMonths: 50,
      estimatedImpact: { rentIncrease: 50, timeToPayback: 50 },
    },
    {
      id: 'kitchen-upgrade',
      type: 'kitchen',
      name: 'Kitchen Upgrade',
      estimatedCost: 15000,
      roi: 20,
      potentialRentIncrease: 250,
      paybackMonths: 60,
      estimatedImpact: { rentIncrease: 250, timeToPayback: 60 },
    },
  ];

  // Use current month values for the donut chart
  const totalIncome = currentMonthIncome;
  const totalExpenses = currentMonthExpenses;
  const netCashFlow = currentMonthIncome - currentMonthExpenses;
  
  // Use actual bank balance if available, otherwise fall back to net cash flow
  const totalReserves = accountBalance !== null ? accountBalance : Math.max(0, netCashFlow);

  // Calculate spending percentage - spent is the portion of budget used
  const spentAmount = totalExpenses; // Always positive now
  const spentPercentage = budget > 0 ? Math.min((spentAmount / budget) * 100, 100) : 0;
  const remainingPercentage = Math.max(0, 100 - spentPercentage);
  const remainingBudget = Math.max(0, budget - spentAmount);

  // Always derive expense categories from the active month's transactions
  // (the parent `categories` prop spans all time, which causes percentage mismatches)
  const derivedCategories: ExpenseCategory[] = (() => {
    const catMap: Record<string, number> = {};
    currentMonthTransactions
      .filter(t => t.type === 'expense' || t.amount < 0)
      .forEach(t => {
        const cat = t.category || 'Other Expenses';
        catMap[cat] = (catMap[cat] || 0) + Math.abs(t.amount);
      });

    return Object.entries(catMap)
      .map(([name, amount], idx) => ({
        name,
        amount,
        percentage: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0,
        color: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'][idx % 8]
      }))
      .sort((a, b) => b.amount - a.amount);
  })();

  // Calculate weekly spending from transactions
  const getWeeklySpending = () => {
    const currentDay = activeMonth === now.getMonth() && activeYear === now.getFullYear()
      ? now.getDate()
      : new Date(activeYear, activeMonth + 1, 0).getDate(); // last day of active month
    const currentWeek = Math.ceil(currentDay / 7);

    // Get this month and last month transactions
    const thisMonthTxns = transactions.filter(t => {
      const d = new Date(t.date);
      return d.getMonth() === activeMonth && d.getFullYear() === activeYear && (t.type === 'expense' || t.amount < 0);
    });

    const lastMonth = activeMonth === 0 ? 11 : activeMonth - 1;
    const lastMonthYear = activeMonth === 0 ? activeYear - 1 : activeYear;
    const lastMonthTxns = transactions.filter(t => {
      const d = new Date(t.date);
      return d.getMonth() === lastMonth && d.getFullYear() === lastMonthYear && (t.type === 'expense' || t.amount < 0);
    });

    // Aggregate by week
    const thisMonthByWeek: number[] = [0, 0, 0, 0];
    const lastMonthByWeek: number[] = [0, 0, 0, 0];

    thisMonthTxns.forEach(t => {
      const day = new Date(t.date).getDate();
      const week = Math.min(Math.ceil(day / 7), 4) - 1;
      thisMonthByWeek[week] += Math.abs(t.amount);
    });

    lastMonthTxns.forEach(t => {
      const day = new Date(t.date).getDate();
      const week = Math.min(Math.ceil(day / 7), 4) - 1;
      lastMonthByWeek[week] += Math.abs(t.amount);
    });

    return { thisMonthByWeek, lastMonthByWeek, currentWeek };
  };

  const { thisMonthByWeek, lastMonthByWeek, currentWeek } = getWeeklySpending();

  // Generate AI analysis
  useEffect(() => {
    if (derivedCategories.length > 0 || totalExpenses > 0) {
      generateFallbackAnalysis();
    }
  }, [derivedCategories, totalExpenses, totalReserves, reserveThreshold]);

  const generateFallbackAnalysis = () => {
    const topCategory = derivedCategories[0];
    
    let analysis = `**Cost Optimization Insights:**\n\n`;
    
    if (topCategory) {
      analysis += `📊 **Top Expense:** ${topCategory.name} at $${topCategory.amount.toLocaleString()} (${topCategory.percentage.toFixed(1)}% of spending)\n\n`;
    }
    
    if (spentPercentage > 80) {
      analysis += `⚠️ **Budget Alert:** You've used ${spentPercentage.toFixed(0)}% of your monthly budget. Consider reducing discretionary spending.\n\n`;
    } else if (spentPercentage > 50) {
      analysis += `💰 **On Track:** You've used ${spentPercentage.toFixed(0)}% of your budget with ${remainingPercentage.toFixed(0)}% remaining.\n\n`;
    } else {
      analysis += `✅ **Great Progress:** Only ${spentPercentage.toFixed(0)}% of budget used. You're managing expenses well!\n\n`;
    }
    
    analysis += `💡 **Recommendations:**\n`;
    analysis += `• Review your largest expense category for potential savings\n`;
    analysis += `• Consider preventive maintenance to reduce emergency costs\n`;
    
    if (totalReserves < reserveThreshold) {
      analysis += `\n⚠️ **Reserve Alert:** Your reserves ($${totalReserves.toLocaleString()}) are below target ($${reserveThreshold.toLocaleString()}).`;
    } else {
      analysis += `\n✅ **Reserves Healthy:** Meeting your target threshold.`;
    }
    
    setAiAnalysis(analysis);
  };

  // Donut chart component
  const DonutChart = ({ 
    percentage, 
    size = 180, 
    strokeWidth = 20,
    remaining
  }: { 
    percentage: number; 
    size?: number; 
    strokeWidth?: number;
    remaining: number;
  }) => {
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;
    const center = size / 2;

    return (
      <div className="relative flex items-center justify-center">
        <svg width={size} height={size} className="transform -rotate-90">
          {/* Background circle */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth={strokeWidth}
          />
          {/* Progress circle */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={percentage > 90 ? '#ef4444' : percentage > 70 ? '#f59e0b' : '#10b981'}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        </svg>
        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className={`text-3xl font-bold ${
            percentage > 90 ? 'text-red-600' : percentage > 70 ? 'text-amber-600' : 'text-emerald-600'
          }`}>
            {(100 - percentage).toFixed(0)}%
          </div>
          <div className="text-xs text-gray-500">remaining</div>
          <div className="text-sm font-semibold text-gray-700 mt-1">
            ${remaining.toLocaleString()}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* Main Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          Financial Reserves Analytics
        </h3>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="text-sm text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        )}
      </div>

      {/* ===== SECTION 1: TOTAL PROPERTY RESERVES ===== */}
      <div className="space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h4 className="text-lg font-semibold text-gray-800">Property Reserves & Savings Goals</h4>
          </div>
          <button
            onClick={() => setShowGoalModal(true)}
            className="px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Goal
          </button>
        </div>

        {/* Total Property Reserves with Threshold - Full Width */}
        <div className="rounded-xl border bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="font-semibold text-gray-900">Total Property Reserves</h4>
              <p className="text-xs text-gray-500">Capital for renovations & emergencies</p>
            </div>
            <div className="text-right">
              {editingThreshold ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Target:</span>
                  <input
                    type="number"
                    value={reserveThreshold}
                    onChange={(e) => setReserveThreshold(Number(e.target.value))}
                    className="w-24 text-sm border rounded px-2 py-1"
                    onBlur={() => setEditingThreshold(false)}
                    autoFocus
                  />
                </div>
              ) : (
                <button
                  onClick={() => setEditingThreshold(true)}
                  className="text-xs text-gray-500 hover:text-indigo-600"
                >
                  Target: ${reserveThreshold.toLocaleString()} ✏️
                </button>
              )}
            </div>
          </div>

          {/* Gauge visualization */}
          <div className="relative h-40 flex flex-col items-center justify-center">
            {/* Current value */}
            {balanceLoading ? (
              <div className="text-2xl text-gray-400 animate-pulse">Loading balance...</div>
            ) : (
              <>
                <div className={`text-4xl font-bold ${
                  totalReserves >= reserveThreshold ? 'text-emerald-600' : 'text-amber-600'
                }`}>
                  ${totalReserves.toLocaleString()}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {accountBalance !== null ? '🔗 Connected Account' : '📊 Calculated'}
                </div>
              </>
            )}
            <div className="text-sm text-gray-500 mt-1 mb-4">
              {totalReserves >= reserveThreshold ? (
                <span className="text-emerald-600">✓ Above target</span>
              ) : (
                <span className="text-amber-600">
                  ${(reserveThreshold - totalReserves).toLocaleString()} below target
                </span>
              )}
            </div>

            {/* Progress bar */}
            <div className="w-full h-8 bg-gray-100 rounded-lg overflow-hidden relative">
              <div 
                className={`absolute left-0 top-0 h-full transition-all duration-700 ${
                  totalReserves >= reserveThreshold 
                    ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' 
                    : 'bg-gradient-to-r from-amber-500 to-amber-400'
                }`}
                style={{ width: `${Math.min((totalReserves / reserveThreshold) * 100, 100)}%` }}
              />
              {/* Threshold marker */}
              <div 
                className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
                style={{ left: '100%', transform: 'translateX(-2px)' }}
              />
            </div>

            {/* Labels */}
            <div className="w-full flex justify-between text-xs text-gray-400 mt-2">
              <span>$0</span>
              <span className="text-red-500 font-medium">${reserveThreshold.toLocaleString()}</span>
            </div>
          </div>

          {/* Income/Expenses breakdown */}
          <div className="mt-4 pt-3 border-t grid grid-cols-2 gap-4 text-center">
            <div>
              <div className="text-lg font-bold text-emerald-600">${totalIncome.toLocaleString()}</div>
              <div className="text-xs text-gray-500">Income</div>
            </div>
            <div>
              <div className="text-lg font-bold text-red-500">${totalExpenses.toLocaleString()}</div>
              <div className="text-xs text-gray-500">Expenses</div>
            </div>
          </div>

          {/* Monthly savings rate */}
          <div className="mt-3 pt-3 border-t">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Monthly Savings Rate:</span>
              <span className={`font-semibold ${netCashFlow >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {netCashFlow >= 0 ? '+' : ''}${netCashFlow.toLocaleString()}/mo
              </span>
            </div>
            {netCashFlow > 0 && (
              <div className="text-xs text-gray-500 mt-1">
                At this rate, you'll reach your ${reserveThreshold.toLocaleString()} target in{' '}
                {Math.ceil((reserveThreshold - totalReserves) / netCashFlow)} months
              </div>
            )}
          </div>
        </div>

        {/* Savings Goals Tracker */}
        <div className="rounded-xl border bg-white p-5">
          <SavingsGoalTracker
            userId={userId}
            propertyId={propertyId}
            goals={activeGoals}
            accounts={demoSavingsAccounts}
            monthlyIncome={totalIncome}
            monthlyExpenses={totalExpenses}
            currentRent={totalIncome}
            maxPotentialRent={totalIncome * 1.15}
            renovationOpportunities={demoRenovationOpportunities}
            onCreateGoal={handleCreateGoal as unknown as ((goal: SavingsGoal) => void)}
            onUpdateGoal={handleUpdateGoal}
            onDeleteGoal={handleDeleteGoal}
          />
        </div>
      </div>

      {/* Goal Setup Modal */}
      <GoalSetupModal
        isOpen={showGoalModal}
        onClose={() => setShowGoalModal(false)}
        onSubmit={handleCreateGoal}
        userId={userId}
        propertyId={propertyId}
        accounts={demoSavingsAccounts}
        renovationOpportunities={demoRenovationOpportunities}
        existingGoals={activeGoals}
      />

      {/* ===== SECTION 2: SPENDING & BUDGET ANALYTICS ===== */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-gray-200">
          <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <h4 className="text-lg font-semibold text-gray-800">Spending & Budget Analytics</h4>
        </div>

        {/* Row 1: Monthly Spending Donut + Expense Categories */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Monthly Spending Reserves - Donut Chart */}
          <div className="rounded-xl border bg-white p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="font-semibold text-gray-900">Monthly Spending</h4>
                <p className="text-xs text-gray-500">{new Date(activeYear, activeMonth).toLocaleString('default', { month: 'long', year: 'numeric' })} — Budget vs actual</p>
              </div>
              <div className="text-right">
                {editingBudget ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Budget:</span>
                    <input
                      type="number"
                      value={budget}
                      onChange={(e) => setBudget(Number(e.target.value))}
                      className="w-24 text-sm border rounded px-2 py-1"
                      onBlur={() => setEditingBudget(false)}
                      autoFocus
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setEditingBudget(true)}
                    className="text-xs text-gray-500 hover:text-indigo-600"
                  >
                    Budget: ${budget.toLocaleString()} ✏️
                  </button>
                )}
              </div>
            </div>
            
            {/* Donut Chart */}
            <div className="flex items-center justify-center py-4">
              <DonutChart 
                percentage={spentPercentage}
                remaining={remainingBudget}
              />
            </div>
            
            {/* Stats below donut */}
            <div className="mt-4 pt-3 border-t grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-lg font-bold text-gray-900">${spentAmount.toLocaleString()}</div>
                <div className="text-xs text-gray-500">Spent</div>
              </div>
              <div>
                <div className="text-lg font-bold text-emerald-600">${remainingBudget.toLocaleString()}</div>
                <div className="text-xs text-gray-500">Remaining</div>
              </div>
            </div>
          </div>

          {/* Expense Categories Breakdown */}
          <div className="rounded-xl border bg-white p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="font-semibold text-gray-900">Expense Categories</h4>
                <p className="text-xs text-gray-500">Where your money is going this month</p>
              </div>
            </div>

            {derivedCategories.length > 0 ? (
              <div className="space-y-2">
                {derivedCategories.slice(0, 6).map((category, index) => {
                  const categoryIcons: Record<string, string> = {
                    // Schedule E categories
                    'Rent Income': '🏠', 'Rental Income': '🏠', 'Other Rental Income': '💵',
                    'Advertising': '📢', 'Auto & Travel': '🚗',
                    'Cleaning & Maintenance': '🧹', 'Cleaning': '🧹',
                    'Commissions': '💼', 'Insurance': '🛡️',
                    'Legal & Professional': '⚖️', 'Management Fees': '📋', 'Property Management': '📋',
                    'Mortgage Interest': '🏦', 'Other Interest': '💳',
                    'Repairs': '🔧', 'Repairs & Maintenance': '🔧',
                    'Supplies': '📦', 'Property Taxes': '🏛️', 'Property Tax': '🏛️',
                    'Utilities': '💡', 'Depreciation': '📉',
                    'HOA Fees': '🏢', 'Pest Control': '🐜', 'Landscaping': '🌿',
                    'Other Expenses': '📋', 'Uncategorized': '📋',
                  };
                  const icon = categoryIcons[category.name] || '📋';
                  return (
                    <div key={index} className="relative flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors cursor-pointer overflow-hidden">
                      {/* Percentage background bar */}
                      <div
                        className="absolute inset-y-1 left-1 rounded-2xl transition-all duration-500"
                        style={{
                          width: `${Math.max(category.percentage, 4)}%`,
                          background: `linear-gradient(90deg, ${category.color}40, ${category.color}20)`,
                        }}
                      />
                      {/* Icon with color ring */}
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0 relative z-10"
                        style={{ backgroundColor: `${category.color}15`, border: `2px solid ${category.color}` }}
                      >
                        {icon}
                      </div>
                      {/* Name and percentage */}
                      <div className="flex-1 min-w-0 relative z-10">
                        <span className="text-sm font-medium text-gray-800 truncate block">{category.name}</span>
                        <span className="text-xs text-gray-400">{category.percentage.toFixed(0)}% of expenses</span>
                      </div>
                      {/* Amount */}
                      <div className="text-sm font-semibold text-gray-900 relative z-10">${category.amount.toLocaleString()}</div>
                      {/* Expand arrow */}
                      <svg className="w-4 h-4 text-gray-400 relative z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">
                <p>No expense data for this period</p>
                <p className="text-xs mt-1">Add transactions in your bookkeeping system</p>
              </div>
            )}

            {derivedCategories.length > 6 && (
              <button className="mt-3 text-xs text-indigo-600 hover:text-indigo-700">
                View all {derivedCategories.length} categories →
              </button>
            )}
          </div>
        </div>

        {/* Row 2: Spending Comparison - Full Width */}
        <div className="rounded-xl border bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="font-semibold text-gray-900">Spending Comparison</h4>
              <p className="text-xs text-gray-500">Last month vs this month (weekly)</p>
            </div>
          </div>

          {/* Line Chart Visualization */}
          <div className="h-48 relative">
            <svg viewBox="0 0 400 160" className="w-full h-full">
              {/* Grid lines */}
              {[0, 1, 2, 3, 4].map(i => (
                <line 
                  key={i}
                  x1="50" x2="380" 
                  y1={20 + i * 30} y2={20 + i * 30}
                  stroke="#e5e7eb" strokeWidth="1"
                />
              ))}

              {(() => {
                const allValues = [...thisMonthByWeek, ...lastMonthByWeek];
                const maxVal = Math.max(...allValues, 1);

                // Last Month Line (dashed - all 4 weeks)
                const lastMonthPoints = lastMonthByWeek.map((v, i) => {
                  const x = 50 + (i / 3) * 330;
                  const y = 140 - (v / maxVal) * 110;
                  return `${x},${y}`;
                });

                // This Month Line (solid - only up to current week)
                const thisMonthPoints = thisMonthByWeek
                  .slice(0, currentWeek)
                  .map((v, i) => {
                    const x = 50 + (i / 3) * 330;
                    const y = 140 - (v / maxVal) * 110;
                    return `${x},${y}`;
                  });

                return (
                  <>
                    {/* Last Month Line */}
                    <path
                      d={`M${lastMonthPoints.join(' L')}`}
                      fill="none"
                      stroke="#9ca3af"
                      strokeWidth="2"
                      strokeDasharray="6,4"
                    />
                    
                    {/* Last Month Points */}
                    {lastMonthByWeek.map((v, i) => {
                      const x = 50 + (i / 3) * 330;
                      const y = 140 - (v / maxVal) * 110;
                      return <circle key={`last-${i}`} cx={x} cy={y} r="4" fill="#9ca3af" />;
                    })}

                    {/* This Month Line */}
                    {thisMonthPoints.length > 1 && (
                      <path
                        d={`M${thisMonthPoints.join(' L')}`}
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="2.5"
                      />
                    )}
                    
                    {/* This Month Points */}
                    {thisMonthByWeek.slice(0, currentWeek).map((v, i) => {
                      const x = 50 + (i / 3) * 330;
                      const y = 140 - (v / maxVal) * 110;
                      return <circle key={`this-${i}`} cx={x} cy={y} r="5" fill="#3b82f6" />;
                    })}

                    {/* X-axis labels */}
                    {[1, 2, 3, 4].map((week, i) => {
                      const x = 50 + (i / 3) * 330;
                      return (
                        <text key={`label-${i}`} x={x} y={155} textAnchor="middle" fontSize="10" fill="#6b7280">
                          Week {week}
                        </text>
                      );
                    })}
                  </>
                );
              })()}
            </svg>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-6 text-xs mt-2 pt-2 border-t">
            <span className="flex items-center gap-2">
              <span className="w-6 h-0.5 bg-gray-400" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #9ca3af, #9ca3af 4px, transparent 4px, transparent 8px)' }}></span>
              Last Month: ${lastMonthByWeek.reduce((a, b) => a + b, 0).toLocaleString()}
            </span>
            <span className="flex items-center gap-2">
              <span className="w-6 h-0.5 bg-blue-500"></span>
              This Month: ${thisMonthByWeek.slice(0, currentWeek).reduce((a, b) => a + b, 0).toLocaleString()}
            </span>
          </div>
        </div>

        {/* AI Cost Analysis */}
        <div className="rounded-xl border bg-gradient-to-br from-indigo-50 to-purple-50 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900">AI Cost Optimization</h4>
                <p className="text-xs text-gray-500">Personalized recommendations</p>
              </div>
            </div>
          </div>

          {aiAnalysis ? (
            <div className="prose prose-sm max-w-none text-gray-700">
              {aiAnalysis.split('\n').map((line, i) => (
                <p key={i} className="mb-2" dangerouslySetInnerHTML={{ 
                  __html: line
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    .replace(/•/g, '&bull;')
                }} />
              ))}
            </div>
          ) : (
            <div className="text-gray-500 text-sm">
              Add transactions to receive AI-powered insights.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
