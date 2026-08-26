/**
 * Intelligent Savings Distribution System
 * Allocates savings across multiple goals on shared accounts
 */

import {
  SavingsGoal,
  SavingsAccount,
  GoalAllocation,
} from '../types/savingsGoal';

interface DistributionStrategy {
  allocation: GoalAllocation[];
  totalAllocated: number;
  remainingUnallocated: number;
  strategy: 'priority-based' | 'deadline-based' | 'proportional' | 'equal';
  explanation: string;
}

/**
 * Calculate optimal distribution of savings across multiple goals on a shared account
 * Balances competing priorities intelligently
 */
export function calculateSavingsDistribution(
  account: SavingsAccount,
  goals: SavingsGoal[],
  monthlyIncome: number,
  monthlyExpenses: number
): DistributionStrategy {
  // Filter goals using this account
  const sharedAccountGoals = goals.filter(
    g => g.accountId === account.id && g.isActive
  );

  if (sharedAccountGoals.length === 0) {
    return {
      allocation: [],
      totalAllocated: 0,
      remainingUnallocated: account.currentBalance,
      strategy: 'proportional',
      explanation: 'No active goals for this account',
    };
  }

  if (sharedAccountGoals.length === 1) {
    // Single goal - allocate everything
    const allocation: GoalAllocation = {
      goalId: sharedAccountGoals[0].id,
      accountId: account.id,
      allocatedAmount: account.currentBalance,
      allocationPercentage: 100,
    };

    return {
      allocation: [allocation],
      totalAllocated: account.currentBalance,
      remainingUnallocated: 0,
      strategy: 'equal',
      explanation: 'Single goal - all available balance allocated',
    };
  }

  // Multiple goals - use intelligent distribution
  return distributeMultipleGoals(
    account,
    sharedAccountGoals,
    monthlyIncome,
    monthlyExpenses
  );
}

/**
 * Distribute savings across multiple goals on a shared account
 * Strategy: Priority-weighted deadline-based allocation
 */
function distributeMultipleGoals(
  account: SavingsAccount,
  goals: SavingsGoal[],
  monthlyIncome: number,
  monthlyExpenses: number
): DistributionStrategy {
  // Calculate each goal's urgency and importance
  const goalMetrics = goals.map(goal => {
    const now = new Date();
    const deadline = new Date(goal.deadline);
    const daysToDeadline = Math.max(1, (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const monthsToDeadline = daysToDeadline / 30;

    const amountToSave = goal.targetAmount - goal.currentSaved;
    const monthlyRequired = amountToSave / monthsToDeadline;
    const monthlyAvailable = monthlyIncome - monthlyExpenses;

    // Urgency score: higher = more urgent
    const urgencyScore = monthsToDeadline < 6 ? 1 : monthsToDeadline < 12 ? 0.7 : 0.4;

    // Feasibility score: higher = more feasible without current allocation
    const feasibilityScore = monthlyAvailable >= monthlyRequired ? 1 : 0.5;

    // Priority score: convert priority to number
    const priorityScore = goal.priority === 'high' ? 1 : goal.priority === 'medium' ? 0.7 : 0.4;

    // Combined weight (urgency is most important)
    const weight = urgencyScore * 0.5 + priorityScore * 0.3 + (1 - feasibilityScore) * 0.2;

    return {
      goal,
      urgencyScore,
      priorityScore,
      feasibilityScore,
      weight,
      monthsToDeadline,
      monthlyRequired,
      amountToSave,
    };
  });

  // Sort by weight descending
  goalMetrics.sort((a, b) => b.weight - a.weight);

  // Calculate allocations
  const allocations: GoalAllocation[] = [];
  let remainingBalance = account.currentBalance;
  let totalAllocated = 0;

  for (let i = 0; i < goalMetrics.length; i++) {
    const metric = goalMetrics[i];
    const isLastGoal = i === goalMetrics.length - 1;

    let allocatedAmount: number;

    if (isLastGoal) {
      // Last goal gets remaining balance
      allocatedAmount = remainingBalance;
    } else {
      // Allocate proportional to weight
      const weightPortion = metric.weight / goalMetrics.slice(i).reduce((sum, m) => sum + m.weight, 0);
      allocatedAmount = remainingBalance * (weightPortion * 0.7); // Use 70% of remaining
    }

    allocatedAmount = Math.max(0, Math.round(allocatedAmount * 100) / 100); // Round to cents

    if (allocatedAmount > 0) {
      allocations.push({
        goalId: metric.goal.id,
        accountId: account.id,
        allocatedAmount,
        allocationPercentage: (allocatedAmount / account.currentBalance) * 100,
      });

      totalAllocated += allocatedAmount;
      remainingBalance -= allocatedAmount;
    }
  }

  const explanation = `Allocation strategy prioritizes goals by: (1) deadline urgency (${goalMetrics[0].goal.deadline.toLocaleDateString()} is closest), (2) priority level, and (3) feasibility gap. Most critical goal "${goalMetrics[0].goal.name}" receives ${allocations[0]?.allocationPercentage.toFixed(0)}% of available balance.`;

  return {
    allocation: allocations,
    totalAllocated,
    remainingUnallocated: remainingBalance,
    strategy: 'priority-based',
    explanation,
  };
}

/**
 * Allocate new savings to goals on a shared account
 * Distributes incremental savings according to the same strategy
 */
export function allocateIncrementalSavings(
  account: SavingsAccount,
  goals: SavingsGoal[],
  newSavingsAmount: number,
  monthlyIncome: number,
  monthlyExpenses: number
): GoalAllocation[] {
  const distribution = calculateSavingsDistribution(
    account,
    goals,
    monthlyIncome,
    monthlyExpenses
  );

  // Allocate new savings proportionally to existing allocation percentages
  const incrementalAllocations: GoalAllocation[] = [];

  for (const alloc of distribution.allocation) {
    const goal = goals.find(g => g.id === alloc.goalId);
    if (!goal) continue;

    const allocationPercentage = alloc.allocationPercentage / 100;
    const incrementalAmount = newSavingsAmount * allocationPercentage;

    incrementalAllocations.push({
      goalId: alloc.goalId,
      accountId: account.id,
      allocatedAmount: incrementalAmount,
      allocationPercentage: allocationPercentage * 100,
    });
  }

  return incrementalAllocations;
}

/**
 * Recalculate allocations when a goal is added/removed
 */
export function rebalanceAllocations(
  account: SavingsAccount,
  goals: SavingsGoal[],
  monthlyIncome: number,
  monthlyExpenses: number
): DistributionStrategy {
  return calculateSavingsDistribution(
    account,
    goals,
    monthlyIncome,
    monthlyExpenses
  );
}

/**
 * Find or create dedicated account for a goal
 */
export function recommendAccountForGoal(
  goal: SavingsGoal,
  existingAccounts: SavingsAccount[]
): SavingsAccount | null {
  // If goal is a renovation, look for renovation account
  if (goal.type === 'renovation') {
    return (
      existingAccounts.find(
        a => a.type === 'renovations' && a.propertyId === goal.propertyId
      ) || null
    );
  }

  // For emergency fund, look for emergency account
  if (goal.type === 'emergency-fund') {
    return (
      existingAccounts.find(
        a => a.type === 'emergency' && a.propertyId === goal.propertyId
      ) || null
    );
  }

  // Default to primary account
  return (
    existingAccounts.find(
      a => a.type === 'primary' && a.propertyId === goal.propertyId && a.isDefault
    ) || null
  );
}

/**
 * Check if a goal should have its own dedicated account
 */
export function shouldHaveDedicatedAccount(goal: SavingsGoal): boolean {
  // Renovation goals with high costs should have dedicated accounts
  if (goal.type === 'renovation' && goal.targetAmount > 5000) {
    return true;
  }

  // Emergency funds should always have dedicated accounts
  if (goal.type === 'emergency-fund') {
    return true;
  }

  // Very large property reserve goals
  if (goal.type === 'property-reserves' && goal.targetAmount > 20000) {
    return true;
  }

  return false;
}

/**
 * Calculate percentage of shared account balance to allocate to a specific goal
 * when multiple goals are competing for the same account
 */
export function calculateGoalAllocationPercentage(
  goal: SavingsGoal,
  allGoalsOnAccount: SavingsGoal[],
  monthlyIncome: number,
  monthlyExpenses: number
): number {
  const account: SavingsAccount = {
    id: 'temp',
    userId: goal.userId,
    propertyId: goal.propertyId,
    name: 'Shared Account',
    type: 'primary',
    currentBalance: 1000, // Placeholder - only used for percentage calculation
    totalIncome: monthlyIncome,
    totalExpenses: monthlyExpenses,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const distribution = calculateSavingsDistribution(
    account,
    allGoalsOnAccount,
    monthlyIncome,
    monthlyExpenses
  );

  const allocation = distribution.allocation.find(a => a.goalId === goal.id);
  return allocation?.allocationPercentage || 0;
}

/**
 * Get visual representation of allocation across goals
 */
export function getAllocationVisualization(
  allocations: GoalAllocation[],
  goals: SavingsGoal[]
): Array<{
  goalId: string;
  goalName: string;
  percentage: number;
  amount: number;
  color: string;
}> {
  const colors = [
    '#10b981',
    '#3b82f6',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#06b6d4',
  ];

  return allocations.map((alloc, idx) => {
    const goal = goals.find(g => g.id === alloc.goalId);
    return {
      goalId: alloc.goalId,
      goalName: goal?.name || 'Unknown Goal',
      percentage: alloc.allocationPercentage,
      amount: alloc.allocatedAmount,
      color: colors[idx % colors.length],
    };
  });
}
