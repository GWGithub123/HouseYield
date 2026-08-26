/**
 * AddToMarketplaceModal Component
 * 
 * Modal for creating a marketplace listing from a detected renovation.
 * Auto-fills renovation details, budget, timeline, and creates the listing.
 */

import { useState } from 'react';
import type { DetectedRenovation, RenovationPreview } from '../types/renovationDetection';
import type { MarketplaceListing } from '../types/contractorMarketplace';
import { createListing } from '../services/firebaseService';
import { getRenovationColor, getRenovationIcon } from '../types/renovationDetection';

// ============================================================================
// Types
// ============================================================================

interface AddToMarketplaceModalProps {
  renovation: DetectedRenovation;
  scanId: string;
  propertyAddress?: string;
  modelFiles?: {
    glb?: string;
    obj?: string;
    mtl?: string;
    texture?: string;
  };
  arPreview?: RenovationPreview;
  onClose: () => void;
  onSuccess: (listing: MarketplaceListing) => void;
  userId?: string;
}

interface FormData {
  propertyAddress: string;
  budgetAllocation: number;
  desiredStartDate: string;
  flexibleTimeline: boolean;
  additionalNotes: string;
  preferredContactMethod: 'email' | 'phone' | 'both';
  urgencyLevel: 'asap' | 'within_month' | 'flexible';
}

// ============================================================================
// Main Component
// ============================================================================

export function AddToMarketplaceModal({
  renovation,
  scanId,
  propertyAddress: initialAddress = '',
  modelFiles,
  arPreview,
  onClose,
  onSuccess,
  userId = 'user-1',
}: AddToMarketplaceModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'details' | 'budget' | 'timeline' | 'review'>('details');
  
  // Form state
  const [formData, setFormData] = useState<FormData>({
    propertyAddress: initialAddress,
    budgetAllocation: renovation.roi.estimatedCost,
    desiredStartDate: '',
    flexibleTimeline: true,
    additionalNotes: '',
    preferredContactMethod: 'both',
    urgencyLevel: renovation.analysis.urgency === 'immediate' ? 'asap' : 'flexible',
  });
  
  const color = getRenovationColor(renovation.zone.type);
  const icon = getRenovationIcon(renovation.zone.type);
  
  // Format currency
  const formatCurrency = (amount: number) => 
    new Intl.NumberFormat('en-US', { 
      style: 'currency', 
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  
  // Calculate suggested budget range
  const suggestedBudgetLow = renovation.roi.costRange.low;
  const suggestedBudgetHigh = renovation.roi.costRange.high;
  
  // Update form field
  const updateField = <K extends keyof FormData>(field: K, value: FormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setError(null);
  };
  
  // Validate current step
  const validateStep = (): boolean => {
    switch (step) {
      case 'details':
        if (!formData.propertyAddress.trim()) {
          setError('Please enter the property address');
          return false;
        }
        return true;
      case 'budget':
        if (formData.budgetAllocation < suggestedBudgetLow * 0.5) {
          setError('Budget is significantly below estimated cost. Consider adjusting.');
          return false;
        }
        return true;
      case 'timeline':
        return true;
      case 'review':
        return true;
      default:
        return true;
    }
  };
  
  // Handle step navigation
  const nextStep = () => {
    if (!validateStep()) return;
    
    const steps: typeof step[] = ['details', 'budget', 'timeline', 'review'];
    const currentIndex = steps.indexOf(step);
    if (currentIndex < steps.length - 1) {
      setStep(steps[currentIndex + 1]);
    }
  };
  
  const prevStep = () => {
    const steps: typeof step[] = ['details', 'budget', 'timeline', 'review'];
    const currentIndex = steps.indexOf(step);
    if (currentIndex > 0) {
      setStep(steps[currentIndex - 1]);
    }
  };
  
  // Submit listing
  const handleSubmit = async () => {
    if (!validateStep()) return;
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      // Create the marketplace listing
      const listingData = {
        propertyOwnerId: userId,
        propertyAddress: formData.propertyAddress,
        scanId,
        scanThumbnailUrl: `/api/room-scanner/scans/${scanId}/thumbnail`,
        renovationType: renovation.zone.name,
        renovationDescription: `${renovation.zone.description}\n\n${renovation.analysis.explanation}`,
        estimatedCostRange: {
          low: suggestedBudgetLow,
          high: formData.budgetAllocation > suggestedBudgetHigh 
            ? formData.budgetAllocation 
            : suggestedBudgetHigh,
        },
        desiredStartDate: formData.desiredStartDate || undefined,
        flexibleTimeline: formData.flexibleTimeline,
        highlightedAreas: [{
          id: renovation.zone.id,
          description: renovation.zone.name,
          coordinates: renovation.zone.markerPosition,
        }],
        modelFiles: modelFiles || {
          glb: `/api/room-scanner/scans/${scanId}/model/model.glb`,
        },
        processingResult: {
          numVertices: undefined, // Would come from scan metadata
          numFaces: undefined,
        },
        status: 'active' as const,
      };
      
      const result = await createListing(listingData);
      
      if (result.success && result.listing) {
        onSuccess(result.listing);
      } else {
        throw new Error(result.error || 'Failed to create listing');
      }
    } catch (err: any) {
      console.error('[AddToMarketplace] Error:', err);
      setError(err.message || 'Failed to create marketplace listing');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div 
        className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div 
          className="p-4 text-white"
          style={{ backgroundColor: color }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">{icon}</span>
              <div>
                <h2 className="text-lg font-bold">Add to Contractor Marketplace</h2>
                <p className="text-sm opacity-90">{renovation.zone.name}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-full hover:bg-white/20 transition-colors"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          {/* Step Indicator */}
          <div className="flex gap-2 mt-4">
            {(['details', 'budget', 'timeline', 'review'] as const).map((s, i) => (
              <div 
                key={s}
                className={`flex-1 h-1 rounded-full transition-colors ${
                  s === step ? 'bg-white' : 
                  ['details', 'budget', 'timeline', 'review'].indexOf(step) > i 
                    ? 'bg-white/60' 
                    : 'bg-white/20'
                }`}
              />
            ))}
          </div>
        </div>
        
        {/* Content */}
        <div className="p-4 overflow-y-auto max-h-[calc(90vh-200px)]">
          {/* Error Display */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}
          
          {/* Step: Details */}
          {step === 'details' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800 mb-2">Property Details</h3>
                <p className="text-sm text-gray-500 mb-4">
                  Confirm the property address where the renovation will take place.
                </p>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Property Address *
                </label>
                <input
                  type="text"
                  value={formData.propertyAddress}
                  onChange={(e) => updateField('propertyAddress', e.target.value)}
                  placeholder="123 Main St, City, State ZIP"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Preferred Contact Method
                </label>
                <select
                  value={formData.preferredContactMethod}
                  onChange={(e) => updateField('preferredContactMethod', e.target.value as FormData['preferredContactMethod'])}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="both">Email & Phone</option>
                  <option value="email">Email Only</option>
                  <option value="phone">Phone Only</option>
                </select>
              </div>
              
              {/* Pre-filled renovation info */}
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm font-medium text-gray-700 mb-2">Renovation Type</div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{icon}</span>
                  <div>
                    <div className="font-semibold text-gray-800">{renovation.zone.name}</div>
                    <div className="text-sm text-gray-500 capitalize">{renovation.zone.type}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {/* Step: Budget */}
          {step === 'budget' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800 mb-2">Budget Allocation</h3>
                <p className="text-sm text-gray-500 mb-4">
                  Set your budget for this renovation. Contractors will see this range.
                </p>
              </div>
              
              {/* Estimated Cost Display */}
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="text-sm font-medium text-blue-800">AI Estimated Cost</div>
                <div className="text-2xl font-bold text-blue-900 mt-1">
                  {formatCurrency(renovation.roi.estimatedCost)}
                </div>
                <div className="text-sm text-blue-700 mt-1">
                  Range: {formatCurrency(suggestedBudgetLow)} - {formatCurrency(suggestedBudgetHigh)}
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Your Maximum Budget
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    value={formData.budgetAllocation}
                    onChange={(e) => updateField('budgetAllocation', parseInt(e.target.value) || 0)}
                    className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Setting a competitive budget attracts more qualified contractors.
                </p>
              </div>
              
              {/* Budget comparison */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Budget vs. Estimate</span>
                  <span className={`font-medium ${
                    formData.budgetAllocation >= renovation.roi.estimatedCost 
                      ? 'text-green-600' 
                      : 'text-orange-600'
                  }`}>
                    {formData.budgetAllocation >= renovation.roi.estimatedCost ? '✓' : '⚠'}{' '}
                    {((formData.budgetAllocation / renovation.roi.estimatedCost) * 100).toFixed(0)}% of estimate
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all ${
                      formData.budgetAllocation >= renovation.roi.estimatedCost 
                        ? 'bg-green-500' 
                        : 'bg-orange-500'
                    }`}
                    style={{ 
                      width: `${Math.min((formData.budgetAllocation / suggestedBudgetHigh) * 100, 100)}%` 
                    }}
                  />
                </div>
              </div>
            </div>
          )}
          
          {/* Step: Timeline */}
          {step === 'timeline' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800 mb-2">Timeline Preferences</h3>
                <p className="text-sm text-gray-500 mb-4">
                  When would you like the renovation to start?
                </p>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Urgency Level
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'asap', label: 'ASAP', desc: 'Start immediately' },
                    { value: 'within_month', label: '1 Month', desc: 'Within 30 days' },
                    { value: 'flexible', label: 'Flexible', desc: 'No rush' },
                  ].map((option) => (
                    <button
                      key={option.value}
                      onClick={() => updateField('urgencyLevel', option.value as FormData['urgencyLevel'])}
                      className={`p-3 rounded-lg border-2 text-center transition-colors ${
                        formData.urgencyLevel === option.value
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="font-medium">{option.label}</div>
                      <div className="text-xs text-gray-500">{option.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Preferred Start Date (Optional)
                </label>
                <input
                  type="date"
                  value={formData.desiredStartDate}
                  onChange={(e) => updateField('desiredStartDate', e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="flexibleTimeline"
                  checked={formData.flexibleTimeline}
                  onChange={(e) => updateField('flexibleTimeline', e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="flexibleTimeline" className="text-sm text-gray-700">
                  I'm flexible on the exact start date
                </label>
              </div>
              
              {/* Estimated duration */}
              <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                <div className="text-sm font-medium text-purple-800">Estimated Duration</div>
                <div className="text-xl font-bold text-purple-900 mt-1">
                  {renovation.analysis.estimatedDuration}
                </div>
                <div className="text-sm text-purple-700 mt-1">
                  Based on scope: {renovation.analysis.complexity} complexity
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Additional Notes for Contractors
                </label>
                <textarea
                  value={formData.additionalNotes}
                  onChange={(e) => updateField('additionalNotes', e.target.value)}
                  placeholder="Any special requirements, access considerations, or preferences..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                />
              </div>
            </div>
          )}
          
          {/* Step: Review */}
          {step === 'review' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800 mb-2">Review & Submit</h3>
                <p className="text-sm text-gray-500 mb-4">
                  Confirm the details before posting to the marketplace.
                </p>
              </div>
              
              {/* Summary Cards */}
              <div className="space-y-3">
                <div className="p-3 bg-gray-50 rounded-lg">
                  <div className="text-xs text-gray-500 uppercase tracking-wide">Renovation</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xl">{icon}</span>
                    <span className="font-medium text-gray-800">{renovation.zone.name}</span>
                  </div>
                </div>
                
                <div className="p-3 bg-gray-50 rounded-lg">
                  <div className="text-xs text-gray-500 uppercase tracking-wide">Property</div>
                  <div className="font-medium text-gray-800 mt-1">{formData.propertyAddress}</div>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-green-50 rounded-lg">
                    <div className="text-xs text-green-600 uppercase tracking-wide">Your Budget</div>
                    <div className="font-bold text-green-800 mt-1">
                      {formatCurrency(formData.budgetAllocation)}
                    </div>
                  </div>
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <div className="text-xs text-blue-600 uppercase tracking-wide">Timeline</div>
                    <div className="font-bold text-blue-800 mt-1 capitalize">
                      {formData.urgencyLevel.replace('_', ' ')}
                    </div>
                  </div>
                </div>
                
                {/* Expected benefits */}
                <div className="p-3 bg-gradient-to-r from-green-50 to-blue-50 rounded-lg border border-green-100">
                  <div className="text-xs text-gray-600 uppercase tracking-wide mb-2">Expected Benefits</div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-gray-500">Value Increase:</span>
                      <span className="font-semibold text-green-700 ml-1">
                        +{formatCurrency(renovation.roi.valueIncrease)}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Rent Increase:</span>
                      <span className="font-semibold text-blue-700 ml-1">
                        +${renovation.roi.rentIncreaseMonthly}/mo
                      </span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-gray-500">Projected 5-Year ROI:</span>
                      <span className="font-bold text-purple-700 ml-1">
                        {renovation.roi.roi.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                </div>
                
                {/* 3D Model included */}
                <div className="flex items-center gap-2 p-3 bg-purple-50 rounded-lg">
                  <span className="text-xl">🏗️</span>
                  <div>
                    <div className="font-medium text-purple-800">3D Scan Included</div>
                    <div className="text-xs text-purple-600">
                      Contractors can view the interactive 3D model
                    </div>
                  </div>
                </div>
                
                {/* AR Preview if available */}
                {arPreview && (
                  <div className="flex items-center gap-2 p-3 bg-pink-50 rounded-lg">
                    <span className="text-xl">🔮</span>
                    <div>
                      <div className="font-medium text-pink-800">AR Preview Included</div>
                      <div className="text-xs text-pink-600">
                        Visualization of completed renovation
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        
        {/* Footer */}
        <div className="p-4 bg-gray-50 border-t flex gap-3">
          {step !== 'details' && (
            <button
              onClick={prevStep}
              disabled={isSubmitting}
              className="px-4 py-2 text-gray-700 font-medium hover:bg-gray-100 rounded-lg transition-colors"
            >
              Back
            </button>
          )}
          
          <div className="flex-1" />
          
          {step !== 'review' ? (
            <button
              onClick={nextStep}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="px-6 py-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700
                         text-white font-semibold rounded-lg transition-all shadow-lg shadow-green-500/25
                         disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Posting...</span>
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>Post to Marketplace</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddToMarketplaceModal;
