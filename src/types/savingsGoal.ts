/**
 * Savings Goal Types
 * Types for intelligent multi-goal savings tracking and distribution
 */

/**
 * Account type for savings goals
 */
export type SavingsAccountType = 
  | 'primary'           // Main property operations account
  | 'renovations'       // Dedicated renovations savings account
  | 'emergency'         // Emergency reserves account
  | 'custom';           // Custom user-created account

/**
 * Goal type categories
 */
export type SavingsGoalType = 
  | 'property-reserves'  // General property reserves goal
  | 'renovation'         // Specific renovation savings goal
  | 'emergency-fund'     // Emergency fund goal
  | 'custom';            // Custom goal

/**
 * Renovation opportunity from pricing power system
 */
export interface RenovationOpportunity {
  id: string;
  type: string;
  name: string;
  estimatedCost: number;
  roi: number;           // Return on investment percentage
  potentialRentIncrease: number;
  paybackMonths: number;
  estimatedImpact: {
    rentIncrease: number;
    timeToPayback: number;
  };
}

/**
 * Individual savings goal
 */
export interface SavingsGoal {
  id: string;
  userId: string;
  propertyId: string;
  
  // Goal basics
  name: string;
  description?: string;
  type: SavingsGoalType;
  
  // Financial targets
  targetAmount: number;           // Amount to save
  currentSaved: number;           // Currently saved towards this goal
  deadline: Date;                 // When goal should be achieved by
  priority: 'low' | 'medium' | 'high';
  
  // Account information
  accountId: string;              // Which account to pull from
  accountType: SavingsAccountType;
  accountBalance?: number;        // Real-time balance if dedicated account
  
  // Renovation-specific (optional)
  renovationId?: string;
  renovation?: RenovationOpportunity;
  
  // Progress tracking
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  
  // Metadata
  isActive: boolean;
  notes?: string;
  tags?: string[];
}

/**
 * Goal allocation for shared accounts
 */
export interface GoalAllocation {
  goalId: string;
  accountId: string;
  allocatedAmount: number;      // Amount from shared account allocated to this goal
  allocationPercentage: number;  // Percentage of shared account dedicated to this goal
  isManual?: boolean;            // If true, user manually set the allocation
}

/**
 * Feasibility analysis for a goal
 */
export interface GoalFeasibility {
  goalId: string;
  isFeasible: boolean;
  monthlyRequired: number;       // Monthly savings needed
  monthlyAvailable: number;      // Monthly available (income - expenses)
  timeframeMonths: number;
  shortfallPerMonth?: number;    // If not feasible, how much short each month
  confidence: number;            // 0-1 confidence score
  recommendations: FeasibilityRecommendation[];
}

/**
 * Recommendation to make goal feasible
 */
export interface FeasibilityRecommendation {
  type: 'cost-reduction' | 'income-increase' | 'deadline-extension' | 'amount-reduction';
  category?: string;             // For cost reduction (e.g., "Maintenance", "Utilities")
  currentAmount?: number;        // Current spend/income for this category
  potentialSavings?: number;     // Amount that could be saved
  suggestedNewAmount?: number;   // Suggested new target
  description: string;
  impact: number;                // How much this would help (in dollars or months)
  priority: 'critical' | 'important' | 'nice-to-have';
}

/**
 * Account information for savings goals
 */
export interface SavingsAccount {
  id: string;
  userId: string;
  propertyId: string;
  
  name: string;
  type: SavingsAccountType;
  
  currentBalance: number;
  totalIncome: number;           // Monthly or period income into account
  totalExpenses: number;         // Monthly or period expenses from account
  
  linkedBankAccount?: {
    name: string;
    last4: string;
    bankName: string;
    routingNumber?: string;
  };
  
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Multi-goal savings analysis
 */
export interface MultiGoalAnalysis {
  totalSavingsGoals: number;
  totalTargetAmount: number;
  totalCurrentSaved: number;
  totalMonthlyRequired: number;
  totalMonthlyAvailable: number;
  overallFeasibility: boolean;
  
  goalsStatus: {
    feasible: SavingsGoal[];
    atRisk: SavingsGoal[];
    infeasible: SavingsGoal[];
  };
  
  accountSummary: {
    accountId: string;
    accountName: string;
    balance: number;
    allocatedGoals: SavingsGoal[];
    remainingUnallocated: number;
  }[];
  
  recommendations: FeasibilityRecommendation[];
}

/**
 * Savings progress tracking
 */
export interface SavingsProgress {
  goalId: string;
  
  // Current progress
  amountSaved: number;
  percentageComplete: number;
  
  // Timeline
  timeElapsed: number;           // Days since goal creation
  timeRemaining: number;         // Days until deadline
  
  // Velocity
  averageSavingsPerMonth: number;
  projectedCompletionDate: Date;
  isOnTrack: boolean;
  
  // Milestone tracking
  milestones: {
    percentage: number;
    amount: number;
    achievedAt?: Date;
  }[];
}

/**
 * Goal setup wizard data
 */
export interface GoalSetupData {
  type: SavingsGoalType;
  name: string;
  description?: string;
  targetAmount: number;
  deadline: Date;
  priority: 'low' | 'medium' | 'high';
  accountId?: string;
  renovation?: RenovationOpportunity;
}
