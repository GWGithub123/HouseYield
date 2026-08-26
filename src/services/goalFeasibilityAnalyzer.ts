/**
 * Goal Feasibility Analyzer
 * Analyzes if savings goals are achievable and provides recommendations
 */

import {
  SavingsGoal,
  GoalFeasibility,
  FeasibilityRecommendation,
  MultiGoalAnalysis,
  SavingsProgress,
  SavingsAccount,
} from '../types/savingsGoal';

/**
 * Analyze if a single goal is feasible based on account income/expenses
 */
export function analyzeGoalFeasibility(
  goal: SavingsGoal,
  _account: SavingsAccount,
  monthlyIncome: number,
  monthlyExpenses: number
): GoalFeasibility {
  const now = new Date();
  const deadlineDate = new Date(goal.deadline);
  const timeframeMonths = Math.max(1, Math.ceil(
    (deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 30)
  ));

  // Calculate monthly required savings
  const amountToSave = goal.targetAmount - goal.currentSaved;
  const monthlyRequired = amountToSave / timeframeMonths;

  // Calculate monthly available for savings
  const monthlyNetCashFlow = monthlyIncome - monthlyExpenses;
  const monthlyAvailable = Math.max(0, monthlyNetCashFlow);

  // Determine feasibility
  const isFeasible = monthlyAvailable >= monthlyRequired;
  const shortfallPerMonth = !isFeasible ? monthlyRequired - monthlyAvailable : 0;

  // Generate recommendations
  const recommendations = generateRecommendations(
    goal,
    monthlyRequired,
    monthlyAvailable,
    monthlyIncome,
    monthlyExpenses,
    isFeasible,
    shortfallPerMonth,
    timeframeMonths
  );

  // Calculate confidence score
  const confidence = isFeasible
    ? Math.min(1, monthlyAvailable / monthlyRequired)
    : Math.max(0, monthlyAvailable / monthlyRequired);

  return {
    goalId: goal.id,
    isFeasible,
    monthlyRequired,
    monthlyAvailable,
    timeframeMonths,
    shortfallPerMonth: shortfallPerMonth > 0 ? shortfallPerMonth : undefined,
    confidence,
    recommendations,
  };
}

/**
 * Generate recommendations to make a goal feasible
 */
export function generateRecommendations(
  goal: SavingsGoal,
  monthlyRequired: number,
  monthlyAvailable: number,
  monthlyIncome: number,
  monthlyExpenses: number,
  isFeasible: boolean,
  shortfallPerMonth: number,
  timeframeMonths: number
): FeasibilityRecommendation[] {
  const recommendations: FeasibilityRecommendation[] = [];
  const amountToSave = goal.targetAmount - goal.currentSaved;
  if (isFeasible) {
    // Goal is feasible - provide optimization suggestions
    recommendations.push({
      type: 'cost-reduction',
      category: 'General',
      description: 'You can afford this goal. Consider accelerating savings by cutting discretionary expenses.',
      impact: monthlyAvailable - monthlyRequired,
      priority: 'nice-to-have',
    });
  } else {
    // Goal is not feasible - provide specific remedies

    // 1. Cost reduction opportunities
    // Typical expense categories and optimization potential
    const expenseOpportunities = [
      {
        category: 'Maintenance',
        typical: monthlyExpenses * 0.15,
        reduction: 0.20,
        description: 'Reduce non-emergency maintenance by 20%',
      },
      {
        category: 'Utilities',
        typical: monthlyExpenses * 0.10,
        reduction: 0.15,
        description: 'Reduce utilities through energy efficiency',
      },
      {
        category: 'Insurance',
        typical: monthlyExpenses * 0.10,
        reduction: 0.10,
        description: 'Shop for better insurance rates',
      },
      {
        category: 'Services',
        typical: monthlyExpenses * 0.08,
        reduction: 0.30,
        description: 'Reduce service contracts or negotiate rates',
      },
      {
        category: 'Supplies',
        typical: monthlyExpenses * 0.12,
        reduction: 0.25,
        description: 'Reduce supply costs through bulk purchasing',
      },
    ];

    let totalReductionPossible = 0;
    const reductionRecommendations: FeasibilityRecommendation[] = [];

    for (const opp of expenseOpportunities) {
      const currentAmount = opp.typical;
      const potentialSavings = currentAmount * opp.reduction;
      totalReductionPossible += potentialSavings;

      reductionRecommendations.push({
        type: 'cost-reduction',
        category: opp.category,
        currentAmount,
        potentialSavings,
        suggestedNewAmount: currentAmount - potentialSavings,
        description: opp.description,
        impact: potentialSavings,
        priority: totalReductionPossible < shortfallPerMonth ? 'important' : 'nice-to-have',
      });
    }

    // Add cost reductions sorted by priority
    recommendations.push(...reductionRecommendations.sort((a, b) => {
      const priorityOrder = { critical: 0, important: 1, 'nice-to-have': 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }));

    // 2. Income increase recommendation (if shortfall still exists)
    const remainingShortfall = Math.max(0, shortfallPerMonth - totalReductionPossible);
    if (remainingShortfall > 0) {
      const rentIncreaseNeeded = remainingShortfall;
      const rentIncreasePercent = (rentIncreaseNeeded / monthlyIncome) * 100;

      recommendations.push({
        type: 'income-increase',
        description: `Increase rental income by $${rentIncreaseNeeded.toFixed(2)}/month (${rentIncreasePercent.toFixed(1)}%)`,
        impact: rentIncreaseNeeded,
        priority: 'important',
      });
    }

    // 3. Deadline extension recommendation
    const idealMonths = amountToSave / monthlyAvailable;
    if (idealMonths > timeframeMonths) {
      recommendations.push({
        type: 'deadline-extension',
        description: `Extend deadline by ${Math.ceil(idealMonths - timeframeMonths)} months to make goal feasible`,
        impact: idealMonths - timeframeMonths,
        priority: 'critical',
      });
    }

    // 4. Amount reduction recommendation
    const achievableAmount = monthlyAvailable * timeframeMonths;
    if (achievableAmount < goal.targetAmount) {
      recommendations.push({
        type: 'amount-reduction',
        suggestedNewAmount: achievableAmount,
        description: `Reduce target from $${goal.targetAmount.toFixed(2)} to $${achievableAmount.toFixed(2)} to make feasible by deadline`,
        impact: goal.targetAmount - achievableAmount,
        priority: 'critical',
      });
    }
  }

  return recommendations;
}

/**
 * Calculate savings progress for a goal
 */
export function calculateSavingsProgress(
  goal: SavingsGoal,
  _historicalSavings?: { date: Date; amount: number }[]
): SavingsProgress {
  const now = new Date();
  const createdDate = new Date(goal.createdAt);
  const deadlineDate = new Date(goal.deadline);

  const timeElapsed = Math.floor(
    (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  const timeRemaining = Math.floor(
    (deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  const totalTimeframe = Math.floor(
    (deadlineDate.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  const percentageComplete =
    goal.targetAmount > 0 ? (goal.currentSaved / goal.targetAmount) * 100 : 0;

  // Calculate average savings per month
  const monthsElapsed = Math.max(1, timeElapsed / 30);
  const averageSavingsPerMonth = goal.currentSaved / monthsElapsed;

  // Project completion date
  const remainingAmount = goal.targetAmount - goal.currentSaved;
  const monthsToCompletion = averageSavingsPerMonth > 0 
    ? remainingAmount / averageSavingsPerMonth 
    : Infinity;

  const projectedCompletionDate = new Date(
    now.getTime() + monthsToCompletion * 30 * 24 * 60 * 60 * 1000
  );

  // Check if on track
  const expectedProgressByNow =
    (timeElapsed / totalTimeframe) * goal.targetAmount;
  const isOnTrack = goal.currentSaved >= expectedProgressByNow * 0.9; // Allow 10% buffer

  // Create milestones
  const milestones = [
    { percentage: 25, amount: goal.targetAmount * 0.25 },
    { percentage: 50, amount: goal.targetAmount * 0.5 },
    { percentage: 75, amount: goal.targetAmount * 0.75 },
    { percentage: 100, amount: goal.targetAmount },
  ].map(milestone => ({
    ...milestone,
    achievedAt: goal.currentSaved >= milestone.amount ? now : undefined,
  }));

  return {
    goalId: goal.id,
    amountSaved: goal.currentSaved,
    percentageComplete,
    timeElapsed,
    timeRemaining,
    averageSavingsPerMonth,
    projectedCompletionDate,
    isOnTrack,
    milestones,
  };
}

/**
 * Analyze multiple goals on shared and dedicated accounts
 */
export function analyzeMultipleGoals(
  goals: SavingsGoal[],
  accounts: SavingsAccount[],
  monthlyData: { income: number; expenses: number }
): MultiGoalAnalysis {
  const feasibilityAnalysis = goals.map(goal => {
    const account = accounts.find(a => a.id === goal.accountId);
    if (!account) return null;

    return analyzeGoalFeasibility(goal, account, monthlyData.income, monthlyData.expenses);
  }).filter(Boolean) as GoalFeasibility[];

  const feasibleGoals = goals.filter(g =>
    feasibilityAnalysis.find(fa => fa.goalId === g.id && fa.isFeasible)
  );

  const atRiskGoals = goals.filter(g => {
    const analysis = feasibilityAnalysis.find(fa => fa.goalId === g.id);
    return analysis && !analysis.isFeasible && analysis.confidence > 0.5;
  });

  const infeasibleGoals = goals.filter(g => {
    const analysis = feasibilityAnalysis.find(fa => fa.goalId === g.id);
    return analysis && !analysis.isFeasible && analysis.confidence <= 0.5;
  });

  const totalTargetAmount = goals.reduce((sum, g) => sum + g.targetAmount, 0);
  const totalCurrentSaved = goals.reduce((sum, g) => sum + g.currentSaved, 0);
  const totalMonthlyRequired = feasibilityAnalysis.reduce(
    (sum, fa) => sum + fa.monthlyRequired,
    0
  );
  const totalMonthlyAvailable = monthlyData.income - monthlyData.expenses;

  const overallFeasibility = totalMonthlyAvailable >= totalMonthlyRequired;

  // Account-level summary
  const accountSummary = accounts
    .filter(a => a.isDefault || goals.some(g => g.accountId === a.id))
    .map(account => {
      const accountGoals = goals.filter(g => g.accountId === account.id);
      const allocatedAmount = accountGoals.reduce((sum, g) => sum + g.currentSaved, 0);

      return {
        accountId: account.id,
        accountName: account.name,
        balance: account.currentBalance,
        allocatedGoals: accountGoals,
        remainingUnallocated: account.currentBalance - allocatedAmount,
      };
    });

  // Collect all recommendations
  const allRecommendations = feasibilityAnalysis.flatMap(fa => fa.recommendations);
  const uniqueRecommendations = deduplicateRecommendations(allRecommendations);

  return {
    totalSavingsGoals: goals.length,
    totalTargetAmount,
    totalCurrentSaved,
    totalMonthlyRequired,
    totalMonthlyAvailable,
    overallFeasibility,
    goalsStatus: {
      feasible: feasibleGoals,
      atRisk: atRiskGoals,
      infeasible: infeasibleGoals,
    },
    accountSummary,
    recommendations: uniqueRecommendations,
  };
}

/**
 * Deduplicate similar recommendations
 */
function deduplicateRecommendations(
  recommendations: FeasibilityRecommendation[]
): FeasibilityRecommendation[] {
  const seen = new Map<string, FeasibilityRecommendation>();

  for (const rec of recommendations) {
    const key = `${rec.type}-${rec.category || 'general'}`;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, rec);
    } else if (rec.impact && (!existing.impact || rec.impact > existing.impact)) {
      seen.set(key, rec);
    }
  }

  return Array.from(seen.values()).sort((a, b) => {
    const priorityOrder = { critical: 0, important: 1, 'nice-to-have': 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

/**
 * Get recommended rental rate increase to achieve feasibility
 * Uses rental pricing data to determine if increase is possible
 */
export function calculateRequiredRentIncrease(
  goal: SavingsGoal,
  monthlyExpenses: number,
  currentRent: number,
  maxPotentialRent: number
): {
  requiredIncrease: number;
  requiredPercentage: number;
  isPossible: boolean;
  recommendedNewRent: number;
} {
  const now = new Date();
  const deadlineDate = new Date(goal.deadline);
  const timeframeMonths = Math.max(1, Math.ceil(
    (deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 30)
  ));

  const amountToSave = goal.targetAmount - goal.currentSaved;
  const requiredMonthlyIncome = (amountToSave / timeframeMonths) + monthlyExpenses;
  const requiredIncrease = requiredMonthlyIncome - (currentRent + monthlyExpenses);
  const requiredPercentage = (requiredIncrease / currentRent) * 100;
  const recommendedNewRent = currentRent + requiredIncrease;

  const isPossible = recommendedNewRent <= maxPotentialRent;

  return {
    requiredIncrease,
    requiredPercentage,
    isPossible,
    recommendedNewRent,
  };
}
