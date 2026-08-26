/**
 * SavingsGoalTracker Component
 * Comprehensive multi-goal savings tracking with feasibility analysis
 */

import { useState, useEffect } from 'react';
import {
  SavingsGoal,
  SavingsAccount,
  GoalFeasibility,
  MultiGoalAnalysis,
} from '../types/savingsGoal';
import {
  analyzeGoalFeasibility,
  analyzeMultipleGoals,
  calculateSavingsProgress,
} from '../services/goalFeasibilityAnalyzer';
import {
  calculateSavingsDistribution,
  getAllocationVisualization,
} from '../services/savingsDistribution';

interface SavingsGoalTrackerProps {
  userId: string;
  propertyId: string;
  goals?: SavingsGoal[];
  accounts?: SavingsAccount[];
  monthlyIncome: number;
  monthlyExpenses: number;
  currentRent?: number;
  maxPotentialRent?: number;
  renovationOpportunities?: unknown[];
  onCreateGoal?: (goal: SavingsGoal) => void;
  onUpdateGoal?: (goal: SavingsGoal) => void;
  onDeleteGoal?: (goalId: string) => void;
}

export default function SavingsGoalTracker({
  userId: _userId,
  propertyId: _propertyId,
  goals = [],
  accounts = [],
  monthlyIncome,
  monthlyExpenses,
  currentRent: _currentRent = 0,
  maxPotentialRent: _maxPotentialRent = 0,
  renovationOpportunities: _renovationOpportunities = [],
  onCreateGoal: _onCreateGoal,
  onUpdateGoal: _onUpdateGoal,
  onDeleteGoal: _onDeleteGoal,
}: SavingsGoalTrackerProps) {
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [feasibilityAnalysis, setFeasibilityAnalysis] = useState<
    Record<string, GoalFeasibility>
  >({});
  const [multiGoalAnalysis, setMultiGoalAnalysis] =
    useState<MultiGoalAnalysis | null>(null);

  // Analyze goals on mount and when goals change
  useEffect(() => {
    console.log('[SavingsGoalTracker] Goals received:', goals);
    console.log('[SavingsGoalTracker] Accounts received:', accounts);
    
    if (goals.length === 0) return;

    // Analyze each individual goal
    const analysis: Record<string, GoalFeasibility> = {};
    for (const goal of goals) {
      const account = accounts.find(a => a.id === goal.accountId);
      console.log('[SavingsGoalTracker] Matching account for goal:', goal.id, account);
      if (account) {
        analysis[goal.id] = analyzeGoalFeasibility(
          goal,
          account,
          monthlyIncome,
          monthlyExpenses
        );
      }
    }
    setFeasibilityAnalysis(analysis);
    console.log('[SavingsGoalTracker] Feasibility analysis:', analysis);

    // Analyze all goals together
    const multi = analyzeMultipleGoals(
      goals,
      accounts,
      { income: monthlyIncome, expenses: monthlyExpenses }
    );
    setMultiGoalAnalysis(multi);
  }, [goals, accounts, monthlyIncome, monthlyExpenses]);

  if (goals.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-gray-300 p-8 text-center">
        <svg
          className="w-12 h-12 text-gray-400 mx-auto mb-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
        <h3 className="font-semibold text-gray-900 mb-1">No Savings Goals Yet</h3>
        <p className="text-sm text-gray-500">
          Create your first goal to track savings and plan for renovations
        </p>
      </div>
    );
  }

  // Render individual goal feasibility
  const renderGoalFeasibility = (goal: SavingsGoal) => {
    const analysis = feasibilityAnalysis[goal.id];
    if (!analysis) return null;

    const progress = calculateSavingsProgress(goal);

    return (
      <div
        key={goal.id}
        className={`rounded-lg border p-4 cursor-pointer transition-all ${
          selectedGoalId === goal.id
            ? 'border-indigo-500 bg-indigo-50'
            : 'border-gray-200 hover:border-indigo-300'
        }`}
        onClick={() =>
          setSelectedGoalId(selectedGoalId === goal.id ? null : goal.id)
        }
      >
        {/* Goal header */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <h4 className="font-semibold text-gray-900">{goal.name}</h4>
            {goal.renovation && (
              <p className="text-xs text-gray-500">
                Renovation: {goal.renovation.name}
              </p>
            )}
          </div>
          <span
            className={`text-xs font-semibold px-2 py-1 rounded ${
              analysis.isFeasible
                ? 'bg-emerald-100 text-emerald-700'
                : analysis.confidence > 0.5
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-red-100 text-red-700'
            }`}
          >
            {analysis.isFeasible
              ? '✓ Feasible'
              : analysis.confidence > 0.5
                ? '⚠ At Risk'
                : '✗ Infeasible'}
          </span>
        </div>

        {/* Progress bar */}
        <div className="mb-3">
          <div className="flex justify-between items-end mb-1">
            <div className="flex-1">
              <div className="text-sm font-medium text-gray-700">
                ${progress.amountSaved.toLocaleString()} of $
                {goal.targetAmount.toLocaleString()}
              </div>
              <div className="text-xs text-gray-500">
                {progress.percentageComplete.toFixed(0)}% complete
              </div>
            </div>
            <div className="text-right ml-4">
              <div className="text-sm font-semibold text-gray-700">
                ${analysis.monthlyRequired.toFixed(2)}/mo
              </div>
              <div className="text-xs text-gray-500">required</div>
              {/* Percentage of income needed */}
              <div className={`text-xs font-medium mt-0.5 ${
                (analysis.monthlyRequired / monthlyIncome) * 100 > 50 
                  ? 'text-red-600' 
                  : (analysis.monthlyRequired / monthlyIncome) * 100 > 25 
                    ? 'text-amber-600' 
                    : 'text-emerald-600'
              }`}>
                {monthlyIncome > 0 
                  ? `${((analysis.monthlyRequired / monthlyIncome) * 100).toFixed(1)}% of income`
                  : 'N/A'}
              </div>
            </div>
          </div>

          {/* Progress bar visual */}
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                analysis.isFeasible
                  ? 'bg-emerald-500'
                  : analysis.confidence > 0.5
                    ? 'bg-amber-500'
                    : 'bg-red-500'
              }`}
              style={{ width: `${Math.min(progress.percentageComplete, 100)}%` }}
            />
          </div>
        </div>

        {/* Deadline and timeline */}
        <div className="text-xs text-gray-500 mb-2">
          Due: {new Date(goal.deadline).toLocaleDateString()} •{' '}
          {progress.timeRemaining > 0
            ? `${Math.ceil(progress.timeRemaining / 30)} months remaining`
            : 'Deadline passed'}
        </div>

        {/* Expanded details */}
        {selectedGoalId === goal.id && (
          <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
            {/* Income percentage hero card */}
            {(() => {
              const incomePercentage = monthlyIncome > 0 
                ? (analysis.monthlyRequired / monthlyIncome) * 100 
                : 0;
              const availablePercentage = monthlyIncome > 0
                ? ((monthlyIncome - monthlyExpenses) / monthlyIncome) * 100
                : 0;
              return (
                <div className={`rounded-lg p-4 ${
                  incomePercentage > 50 
                    ? 'bg-gradient-to-r from-red-500 to-red-600' 
                    : incomePercentage > 25 
                      ? 'bg-gradient-to-r from-amber-500 to-orange-500'
                      : 'bg-gradient-to-r from-emerald-500 to-teal-500'
                }`}>
                  <div className="text-white/80 text-xs font-medium mb-1">
                    Income Commitment Required
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-white">
                      {incomePercentage.toFixed(1)}%
                    </span>
                    <span className="text-white/70 text-sm">of monthly income</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-white/90 text-xs">
                    <span>${analysis.monthlyRequired.toFixed(0)}</span>
                    <span className="text-white/50">of</span>
                    <span>${monthlyIncome.toLocaleString()}</span>
                    <span className="text-white/50">monthly income</span>
                  </div>
                  {incomePercentage > availablePercentage && (
                    <div className="mt-2 px-2 py-1 bg-white/20 rounded text-white text-xs">
                      ⚠️ Exceeds disposable income ({availablePercentage.toFixed(1)}% available after expenses)
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Feasibility details */}
            <div className="bg-white rounded p-3 space-y-2">
              <h5 className="font-medium text-gray-900 text-sm">
                Budget Breakdown
              </h5>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-gray-500">Monthly Income</div>
                  <div className="font-semibold text-gray-900">
                    ${monthlyIncome.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">Monthly Expenses</div>
                  <div className="font-semibold text-gray-900">
                    ${monthlyExpenses.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">Disposable</div>
                  <div className="font-semibold text-gray-900">
                    ${Math.max(0, monthlyIncome - monthlyExpenses).toLocaleString()}
                    <span className="text-gray-400 font-normal ml-1">
                      ({monthlyIncome > 0 
                        ? ((Math.max(0, monthlyIncome - monthlyExpenses) / monthlyIncome) * 100).toFixed(0) 
                        : 0}%)
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">Required Savings</div>
                  <div className="font-semibold text-gray-900">
                    ${analysis.monthlyRequired.toFixed(0)}/mo
                  </div>
                </div>
              </div>

              {!analysis.isFeasible && analysis.shortfallPerMonth && (
                <div className="p-2 bg-red-50 rounded text-xs text-red-700">
                  Monthly shortfall: ${analysis.shortfallPerMonth.toFixed(2)}
                </div>
              )}
            </div>

            {/* Recommendations */}
            {analysis.recommendations.length > 0 && (
              <div className="bg-white rounded p-3 space-y-2">
                <h5 className="font-medium text-gray-900 text-sm">
                  Recommendations
                </h5>
                <div className="space-y-2">
                  {analysis.recommendations.slice(0, 3).map((rec, idx) => (
                    <div
                      key={idx}
                      className={`p-2 rounded text-xs ${
                        rec.priority === 'critical'
                          ? 'bg-red-50 text-red-700'
                          : rec.priority === 'important'
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-gray-50 text-gray-700'
                      }`}
                    >
                      <div className="font-semibold mb-1">
                        {rec.type === 'cost-reduction' && '💰 Cut Costs'}
                        {rec.type === 'income-increase' && '📈 Boost Income'}
                        {rec.type === 'deadline-extension' && '📅 Extend Timeline'}
                        {rec.type === 'amount-reduction' && '🎯 Reduce Target'}
                      </div>
                      <div>{rec.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Calculate shared account allocations
  const getAccountAllocations = (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return [];

    const accountGoals = goals.filter(g => g.accountId === accountId);
    const distribution = calculateSavingsDistribution(
      account,
      accountGoals,
      monthlyIncome,
      monthlyExpenses
    );

    return getAllocationVisualization(distribution.allocation, accountGoals);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            Savings Goals
          </h3>
          <p className="text-sm text-gray-500">
            {goals.length} active goal
            {goals.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {multiGoalAnalysis && (
            <div
              className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                multiGoalAnalysis.overallFeasibility
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-red-100 text-red-700'
              }`}
            >
              {multiGoalAnalysis.overallFeasibility
                ? '✓ All Goals Feasible'
                : '⚠ Some Goals at Risk'}
            </div>
          )}
        </div>
      </div>

      {/* Multi-goal summary */}
      {multiGoalAnalysis && (
        <div className="space-y-4">
          {/* Income commitment hero card */}
          {(() => {
            const totalIncomePercentage = monthlyIncome > 0 
              ? (multiGoalAnalysis.totalMonthlyRequired / monthlyIncome) * 100 
              : 0;
            const disposableIncome = Math.max(0, monthlyIncome - monthlyExpenses);
            const utilizationPercentage = disposableIncome > 0
              ? (multiGoalAnalysis.totalMonthlyRequired / disposableIncome) * 100
              : 0;
              
            return (
              <div className={`rounded-xl p-5 ${
                totalIncomePercentage > 50 
                  ? 'bg-gradient-to-br from-red-500 via-red-600 to-pink-600' 
                  : totalIncomePercentage > 25 
                    ? 'bg-gradient-to-br from-amber-500 via-orange-500 to-yellow-500'
                    : 'bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-500'
              } text-white shadow-lg`}>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div>
                    <div className="text-white/80 text-sm font-medium mb-1">
                      Total Income Commitment for All Goals
                    </div>
                    <div className="flex items-baseline gap-3">
                      <span className="text-4xl md:text-5xl font-bold">
                        {totalIncomePercentage.toFixed(1)}%
                      </span>
                      <span className="text-white/70">of monthly income</span>
                    </div>
                    <div className="mt-2 text-white/90 text-sm">
                      ${multiGoalAnalysis.totalMonthlyRequired.toFixed(0)}/mo across {goals.filter(g => g.isActive).length} goal{goals.filter(g => g.isActive).length !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <div className="bg-white/20 backdrop-blur-sm rounded-lg p-4 min-w-[200px]">
                    <div className="text-white/80 text-xs mb-2">Disposable Income Usage</div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold">{utilizationPercentage.toFixed(0)}%</span>
                      <span className="text-white/60 text-xs">of discretionary</span>
                    </div>
                    <div className="mt-2 w-full bg-white/30 rounded-full h-2">
                      <div 
                        className={`h-2 rounded-full transition-all ${
                          utilizationPercentage > 100 ? 'bg-red-300' : 'bg-white'
                        }`}
                        style={{ width: `${Math.min(utilizationPercentage, 100)}%` }}
                      />
                    </div>
                    {utilizationPercentage > 100 && (
                      <div className="text-xs mt-1 text-white/90">
                        ⚠️ {(utilizationPercentage - 100).toFixed(0)}% over budget
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg border border-gray-200 p-4 bg-white">
              <div className="text-xs text-gray-500 mb-1">Total Target</div>
              <div className="text-2xl font-bold text-gray-900">
                ${multiGoalAnalysis.totalTargetAmount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 p-4 bg-white">
              <div className="text-xs text-gray-500 mb-1">Currently Saved</div>
              <div className="text-2xl font-bold text-emerald-600">
                ${multiGoalAnalysis.totalCurrentSaved.toLocaleString()}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {multiGoalAnalysis.totalTargetAmount > 0 
                  ? `${((multiGoalAnalysis.totalCurrentSaved / multiGoalAnalysis.totalTargetAmount) * 100).toFixed(1)}% complete`
                  : ''}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 p-4 bg-white">
              <div className="text-xs text-gray-500 mb-1">Monthly Required</div>
              <div className="text-2xl font-bold text-gray-900">
                ${multiGoalAnalysis.totalMonthlyRequired.toFixed(0)}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {monthlyIncome > 0 
                  ? `${((multiGoalAnalysis.totalMonthlyRequired / monthlyIncome) * 100).toFixed(1)}% of income`
                  : ''}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 p-4 bg-white">
              <div className="text-xs text-gray-500 mb-1">Monthly Available</div>
              <div
                className={`text-2xl font-bold ${
                  multiGoalAnalysis.totalMonthlyAvailable >=
                  multiGoalAnalysis.totalMonthlyRequired
                    ? 'text-emerald-600'
                    : 'text-red-600'
                }`}
              >
                ${multiGoalAnalysis.totalMonthlyAvailable.toFixed(0)}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {monthlyIncome > 0 
                  ? `${((multiGoalAnalysis.totalMonthlyAvailable / monthlyIncome) * 100).toFixed(1)}% of income`
                  : ''}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Goals list */}
      <div className="space-y-3">
        <h4 className="font-medium text-gray-900 text-sm">Individual Goals</h4>
        <div className="space-y-3">
          {goals.filter(g => g.isActive).map(goal => renderGoalFeasibility(goal))}
        </div>
      </div>

      {/* Account allocations for shared accounts */}
      {accounts.some(a => goals.filter(g => g.accountId === a.id).length > 1) && (
        <div className="rounded-lg border border-gray-200 p-4 bg-gray-50">
          <h4 className="font-medium text-gray-900 text-sm mb-4">
            Smart Allocation Strategy
          </h4>
          <div className="space-y-4">
            {accounts.map(account => {
              const accountGoals = goals.filter(g => g.accountId === account.id);
              if (accountGoals.length <= 1) return null;

              const allocations = getAccountAllocations(account.id);
              const distribution = calculateSavingsDistribution(
                account,
                accountGoals,
                monthlyIncome,
                monthlyExpenses
              );

              return (
                <div key={account.id} className="space-y-2">
                  <div className="text-sm font-medium text-gray-900">
                    {account.name} (${account.currentBalance.toLocaleString()})
                  </div>
                  <div className="flex gap-1">
                    {allocations.map(alloc => (
                      <div
                        key={alloc.goalId}
                        className="h-4 rounded transition-all hover:ring-2 hover:ring-offset-2"
                        style={{
                          backgroundColor: alloc.color,
                          width: `${alloc.percentage}%`,
                        }}
                        title={`${alloc.goalName}: ${alloc.percentage.toFixed(0)}% ($${alloc.amount.toFixed(2)})`}
                      />
                    ))}
                  </div>
                  <div className="text-xs text-gray-600">
                    {distribution.strategy}: {distribution.explanation}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Goals at risk */}
      {multiGoalAnalysis &&
        (multiGoalAnalysis.goalsStatus.atRisk.length > 0 ||
          multiGoalAnalysis.goalsStatus.infeasible.length > 0) && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <h4 className="font-medium text-amber-900 text-sm mb-2">⚠️ Goals at Risk</h4>
            <p className="text-xs text-amber-700 mb-3">
              {multiGoalAnalysis.goalsStatus.atRisk.length +
                multiGoalAnalysis.goalsStatus.infeasible.length}{' '}
              goal
              {multiGoalAnalysis.goalsStatus.atRisk.length +
                multiGoalAnalysis.goalsStatus.infeasible.length !==
              1
                ? 's'
                : ''}{' '}
              may need adjustment
            </p>
            <div className="space-y-2">
              {[
                ...multiGoalAnalysis.goalsStatus.atRisk,
                ...multiGoalAnalysis.goalsStatus.infeasible,
              ].map(goal => (
                <div
                  key={goal.id}
                  className="text-xs bg-white rounded p-2 flex justify-between items-center"
                >
                  <span className="text-gray-900">{goal.name}</span>
                  <button className="text-amber-600 hover:text-amber-700 font-medium">
                    Review
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

      {/* Key recommendations */}
      {multiGoalAnalysis && multiGoalAnalysis.recommendations.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <h4 className="font-medium text-blue-900 text-sm mb-3">
            💡 Recommendations
          </h4>
          <div className="space-y-2">
            {multiGoalAnalysis.recommendations.slice(0, 5).map((rec, idx) => (
              <div
                key={idx}
                className={`text-xs p-2 rounded ${
                  rec.priority === 'critical'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-white text-gray-700'
                }`}
              >
                <div className="font-semibold mb-1">{rec.description}</div>
                {rec.impact && (
                  <div className="text-xs opacity-80">
                    Potential impact: ${rec.impact.toFixed(2)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
