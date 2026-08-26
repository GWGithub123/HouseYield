/**
 * Goal Setup Modal Component
 * Wizard-style modal for creating savings goals with account selection
 */

import { useState } from 'react';
import {
  SavingsGoal,
  SavingsAccount,
  RenovationOpportunity,
  GoalSetupData,
} from '../types/savingsGoal';

interface GoalSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (goal: GoalSetupData, selectedAccountId: string) => void;
  userId: string;
  propertyId: string;
  accounts: SavingsAccount[];
  renovationOpportunities?: RenovationOpportunity[];
  existingGoals?: SavingsGoal[];
}

type ModalStep =
  | 'type-selection'
  | 'renovation-selection'
  | 'goal-details'
  | 'account-selection'
  | 'review';

export default function GoalSetupModal({
  isOpen,
  onClose,
  onSubmit,
  userId: _userId,
  propertyId: _propertyId,
  accounts,
  renovationOpportunities = [],
  existingGoals = [],
}: GoalSetupModalProps) {
  const [currentStep, setCurrentStep] = useState<ModalStep>('type-selection');
  const [goalType, setGoalType] = useState<
    'property-reserves' | 'renovation' | 'emergency-fund' | 'custom'
  >('property-reserves');
  const [selectedRenovation, setSelectedRenovation] =
    useState<RenovationOpportunity | null>(null);
  const [formData, setFormData] = useState<GoalSetupData>({
    type: 'property-reserves',
    name: '',
    description: '',
    targetAmount: 0,
    deadline: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year default
    priority: 'medium',
  });
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    accounts.find(a => a.isDefault)?.id || accounts[0]?.id || ''
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!isOpen) return null;

  const handleNext = () => {
    // Validate current step
    const newErrors: Record<string, string> = {};

    if (currentStep === 'type-selection') {
      setFormData(prev => ({ ...prev, type: goalType }));
      if (goalType === 'renovation' && !selectedRenovation) {
        setCurrentStep('renovation-selection');
        return;
      }
      if (goalType === 'renovation' && selectedRenovation) {
        setFormData(prev => ({
          ...prev,
          type: 'renovation',
          name: `Renovation: ${selectedRenovation.name}`,
          targetAmount: selectedRenovation.estimatedCost,
          renovation: selectedRenovation,
        }));
      }
      setCurrentStep('goal-details');
    } else if (currentStep === 'renovation-selection') {
      if (!selectedRenovation) {
        newErrors.renovation = 'Please select a renovation';
      } else {
        setFormData(prev => ({
          ...prev,
          type: 'renovation',
          name: `Renovation: ${selectedRenovation.name}`,
          targetAmount: selectedRenovation.estimatedCost,
          renovation: selectedRenovation,
        }));
        setCurrentStep('goal-details');
      }
    } else if (currentStep === 'goal-details') {
      if (!formData.name.trim()) {
        newErrors.name = 'Goal name is required';
      }
      if (formData.targetAmount <= 0) {
        newErrors.targetAmount = 'Target amount must be greater than 0';
      }
      if (formData.deadline <= new Date()) {
        newErrors.deadline = 'Deadline must be in the future';
      }

      if (Object.keys(newErrors).length === 0) {
        setCurrentStep('account-selection');
      }
    } else if (currentStep === 'account-selection') {
      if (!selectedAccountId) {
        newErrors.account = 'Please select an account';
      } else {
        setCurrentStep('review');
      }
    }

    setErrors(newErrors);
  };

  const handleSubmit = () => {
    console.log('[GoalSetupModal] Submitting goal:', formData, 'accountId:', selectedAccountId);
    onSubmit(formData, selectedAccountId);
    handleReset();
  };

  const handleReset = () => {
    setCurrentStep('type-selection');
    setGoalType('property-reserves');
    setSelectedRenovation(null);
    setFormData({
      type: 'property-reserves',
      name: '',
      description: '',
      targetAmount: 0,
      deadline: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      priority: 'medium',
    });
    setSelectedAccountId(accounts.find(a => a.isDefault)?.id || accounts[0]?.id || '');
    setErrors({});
    onClose();
  };

  const handleBack = () => {
    const stepOrder: ModalStep[] = (
      goalType === 'renovation' 
        ? ['type-selection', 'renovation-selection', 'goal-details', 'account-selection', 'review']
        : ['type-selection', 'goal-details', 'account-selection', 'review']
    ) as ModalStep[];

    const currentIdx = stepOrder.indexOf(currentStep);
    if (currentIdx > 0) {
      setCurrentStep(stepOrder[currentIdx - 1]);
    }
  };

  // Helper function to render step indicator
  const steps: ModalStep[] =
    goalType === 'renovation'
      ? ['type-selection', 'renovation-selection', 'goal-details', 'account-selection', 'review']
      : ['type-selection', 'goal-details', 'account-selection', 'review'];

  const currentStepIndex = steps.indexOf(currentStep);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-900">Create Savings Goal</h2>
          <button
            onClick={handleReset}
            className="text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        {/* Progress indicator */}
        <div className="px-6 py-3 border-b border-gray-200">
          <div className="flex justify-between items-center">
            {steps.map((step, idx) => (
              <div key={step} className="flex items-center flex-1">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
                    idx <= currentStepIndex
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-200 text-gray-600'
                  }`}
                >
                  {idx + 1}
                </div>
                {idx < steps.length - 1 && (
                  <div
                    className={`flex-1 h-1 mx-2 transition-all ${
                      idx < currentStepIndex ? 'bg-indigo-600' : 'bg-gray-200'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-6 min-h-[400px]">
          {/* Step 1: Type Selection */}
          {currentStep === 'type-selection' && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-gray-900">
                What type of goal would you like to create?
              </h3>

              <div className="space-y-3">
                {[
                  {
                    value: 'property-reserves' as const,
                    label: 'Property Reserves',
                    description: 'General savings for emergencies and maintenance',
                    icon: '🏠',
                  },
                  {
                    value: 'renovation' as const,
                    label: 'Renovation Project',
                    description: 'Save for a specific renovation to increase rental value',
                    icon: '🔨',
                  },
                  {
                    value: 'emergency-fund' as const,
                    label: 'Emergency Fund',
                    description: 'Dedicated emergency reserves for unexpected issues',
                    icon: '🚨',
                  },
                  {
                    value: 'custom' as const,
                    label: 'Custom Goal',
                    description: 'Create a custom savings goal',
                    icon: '⭐',
                  },
                ].map(option => (
                  <label
                    key={option.value}
                    className={`relative flex items-start p-4 border-2 rounded-lg cursor-pointer transition-all ${
                      goalType === option.value
                        ? 'border-indigo-600 bg-indigo-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="goalType"
                      value={option.value}
                      checked={goalType === option.value}
                      onChange={e =>
                        setGoalType(
                          e.target.value as
                            | 'property-reserves'
                            | 'renovation'
                            | 'emergency-fund'
                            | 'custom'
                        )
                      }
                      className="mt-1"
                    />
                    <div className="ml-3 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl">{option.icon}</span>
                        <div className="font-semibold text-gray-900">
                          {option.label}
                        </div>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        {option.description}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Renovation Selection */}
          {currentStep === 'renovation-selection' &&
            renovationOpportunities.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  Which renovation would you like to save for?
                </h3>

                <div className="space-y-3 max-h-[300px] overflow-y-auto">
                  {renovationOpportunities.map(reno => (
                    <label
                      key={reno.id}
                      className={`relative flex items-start p-4 border-2 rounded-lg cursor-pointer transition-all ${
                        selectedRenovation?.id === reno.id
                          ? 'border-indigo-600 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="renovation"
                        checked={selectedRenovation?.id === reno.id}
                        onChange={() => setSelectedRenovation(reno)}
                        className="mt-1"
                      />
                      <div className="ml-3 flex-1">
                        <div className="font-semibold text-gray-900">
                          {reno.name}
                        </div>
                        <div className="grid grid-cols-3 gap-2 mt-2 text-sm">
                          <div>
                            <span className="text-gray-600">Cost: </span>
                            <span className="font-semibold">
                              ${reno.estimatedCost.toLocaleString()}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-600">ROI: </span>
                            <span className="font-semibold text-emerald-600">
                              {reno.roi.toFixed(0)}%
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-600">Payback: </span>
                            <span className="font-semibold">
                              {reno.paybackMonths}mo
                            </span>
                          </div>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>

                {errors.renovation && (
                  <div className="p-3 bg-red-50 text-red-700 rounded">
                    {errors.renovation}
                  </div>
                )}
              </div>
            )}

          {/* Step 3: Goal Details */}
          {currentStep === 'goal-details' && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-gray-900">
                Set up your goal details
              </h3>

              {/* Goal name */}
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-2">
                  Goal Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e =>
                    setFormData(prev => ({ ...prev, name: e.target.value }))
                  }
                  className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none ${
                    errors.name ? 'border-red-500' : 'border-gray-300'
                  }`}
                  placeholder="e.g., Kitchen Renovation"
                />
                {errors.name && (
                  <p className="text-sm text-red-600 mt-1">{errors.name}</p>
                )}
              </div>

              {/* Target amount */}
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-2">
                  Target Amount ($)
                </label>
                <input
                  type="number"
                  value={formData.targetAmount || ''}
                  onChange={e =>
                    setFormData(prev => ({
                      ...prev,
                      targetAmount: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none ${
                    errors.targetAmount ? 'border-red-500' : 'border-gray-300'
                  }`}
                  placeholder="0"
                />
                {errors.targetAmount && (
                  <p className="text-sm text-red-600 mt-1">{errors.targetAmount}</p>
                )}
              </div>

              {/* Deadline */}
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-2">
                  Target Deadline
                </label>
                <input
                  type="date"
                  value={formData.deadline.toISOString().split('T')[0]}
                  onChange={e =>
                    setFormData(prev => ({
                      ...prev,
                      deadline: new Date(e.target.value),
                    }))
                  }
                  className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none ${
                    errors.deadline ? 'border-red-500' : 'border-gray-300'
                  }`}
                />
                {errors.deadline && (
                  <p className="text-sm text-red-600 mt-1">{errors.deadline}</p>
                )}
              </div>

              {/* Priority */}
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-2">
                  Priority Level
                </label>
                <select
                  value={formData.priority}
                  onChange={e =>
                    setFormData(prev => ({
                      ...prev,
                      priority: e.target.value as 'low' | 'medium' | 'high',
                    }))
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-2">
                  Description (Optional)
                </label>
                <textarea
                  value={formData.description || ''}
                  onChange={e =>
                    setFormData(prev => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                  placeholder="Add notes about this goal"
                  rows={3}
                />
              </div>
            </div>
          )}

          {/* Step 4: Account Selection */}
          {currentStep === 'account-selection' && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-gray-900">
                Which account should this goal use?
              </h3>
              <p className="text-sm text-gray-600">
                If you have multiple goals on the same account, we'll intelligently distribute
                the savings based on deadlines and priorities.
              </p>

              <div className="space-y-3">
                {accounts.map(account => {
                  const goalsOnAccount = existingGoals.filter(
                    g => g.accountId === account.id
                  );

                  return (
                    <label
                      key={account.id}
                      className={`relative flex items-start p-4 border-2 rounded-lg cursor-pointer transition-all ${
                        selectedAccountId === account.id
                          ? 'border-indigo-600 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="account"
                        value={account.id}
                        checked={selectedAccountId === account.id}
                        onChange={e => setSelectedAccountId(e.target.value)}
                        className="mt-1"
                      />
                      <div className="ml-3 flex-1">
                        <div className="font-semibold text-gray-900">
                          {account.name}
                          {account.isDefault && (
                            <span className="ml-2 inline-block px-2 py-0.5 text-xs bg-gray-200 text-gray-700 rounded">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-600 mt-1">
                          Balance: ${account.currentBalance.toLocaleString()}
                        </p>
                        {account.linkedBankAccount && (
                          <p className="text-xs text-gray-500 mt-1">
                            🔗 {account.linkedBankAccount.bankName} •••• {account.linkedBankAccount.last4}
                          </p>
                        )}
                        {goalsOnAccount.length > 0 && (
                          <p className="text-xs text-amber-600 mt-2">
                            ⚠️ This account has {goalsOnAccount.length} other goal
                            {goalsOnAccount.length !== 1 ? 's' : ''}. Savings will be
                            distributed intelligently.
                          </p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>

              {errors.account && (
                <div className="p-3 bg-red-50 text-red-700 rounded">
                  {errors.account}
                </div>
              )}
            </div>
          )}

          {/* Step 5: Review */}
          {currentStep === 'review' && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-gray-900">Review Your Goal</h3>

              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Goal Name:</span>
                  <span className="font-semibold text-gray-900">{formData.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Type:</span>
                  <span className="font-semibold text-gray-900">
                    {formData.type === 'property-reserves'
                      ? 'Property Reserves'
                      : formData.type === 'renovation'
                        ? 'Renovation'
                        : formData.type === 'emergency-fund'
                          ? 'Emergency Fund'
                          : 'Custom'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Target Amount:</span>
                  <span className="font-semibold text-gray-900">
                    ${formData.targetAmount.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Deadline:</span>
                  <span className="font-semibold text-gray-900">
                    {formData.deadline.toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Priority:</span>
                  <span className="font-semibold text-gray-900 capitalize">
                    {formData.priority}
                  </span>
                </div>
                <div className="border-t border-gray-200 pt-3 flex justify-between">
                  <span className="text-gray-600">Account:</span>
                  <span className="font-semibold text-gray-900">
                    {accounts.find(a => a.id === selectedAccountId)?.name}
                  </span>
                </div>
              </div>

              <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-700">
                ✓ Your goal is all set! Once created, we'll analyze feasibility and track
                your progress toward this target.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex justify-between gap-3">
          <button
            onClick={currentStepIndex === 0 ? handleReset : handleBack}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {currentStepIndex === 0 ? 'Cancel' : 'Back'}
          </button>

          {currentStep === 'review' ? (
            <button
              onClick={handleSubmit}
              className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
            >
              Create Goal
            </button>
          ) : (
            <button
              onClick={handleNext}
              className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
