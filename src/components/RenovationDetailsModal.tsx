/**
 * RenovationDetailsModal Component
 * 
 * Displays detailed information about a detected renovation including:
 * - Explanation of the renovation
 * - ROI estimate and breakdown
 * - Cost breakdown (labor, materials, permits, contingency)
 * - Value lift figure
 * - Materials list with costs
 * - Labor requirements
 * - "Add Renovation to Marketplace" button
 */

import { useState } from 'react';
import type { DetectedRenovation } from '../types/renovationDetection';
import { getRenovationColor, getRenovationIcon } from '../types/renovationDetection';

// ============================================================================
// Types
// ============================================================================

interface RenovationDetailsModalProps {
  renovation: DetectedRenovation;
  onClose: () => void;
  onAddToMarketplace: (renovation: DetectedRenovation) => void;
  onGenerateARPreview?: (renovation: DetectedRenovation) => void;
  isGeneratingAR?: boolean;
}

// ============================================================================
// Helper Components
// ============================================================================

function MetricCard({ 
  label, 
  value, 
  subValue, 
  color = 'blue',
  icon 
}: { 
  label: string; 
  value: string; 
  subValue?: string;
  color?: 'blue' | 'green' | 'orange' | 'purple';
  icon?: string;
}) {
  const colorClasses = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
  };
  
  return (
    <div className={`p-3 rounded-lg border ${colorClasses[color]}`}>
      <div className="flex items-center gap-2">
        {icon && <span className="text-lg">{icon}</span>}
        <span className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</span>
      </div>
      <div className="text-xl font-bold mt-1">{value}</div>
      {subValue && <div className="text-xs opacity-70 mt-0.5">{subValue}</div>}
    </div>
  );
}

function ProgressBar({ 
  value, 
  max, 
  color,
  label 
}: { 
  value: number; 
  max: number; 
  color: string;
  label: string;
}) {
  const percentage = Math.min((value / max) * 100, 100);
  
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs text-gray-600 mb-1">
        <span>{label}</span>
        <span>${value.toLocaleString()}</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div 
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${percentage}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function RenovationDetailsModal({
  renovation,
  onClose,
  onAddToMarketplace,
  onGenerateARPreview,
  isGeneratingAR = false,
}: RenovationDetailsModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'materials' | 'labor'>('overview');
  
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
  
  // Calculate payback display
  const paybackDisplay = renovation.roi.paybackMonths 
    ? `${renovation.roi.paybackMonths} months`
    : 'N/A';
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div 
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div 
          className="p-4 text-white"
          style={{ backgroundColor: color }}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">{icon}</span>
              <div>
                <h2 className="text-xl font-bold">{renovation.zone.name}</h2>
                <div className="flex items-center gap-2 mt-1 text-sm opacity-90">
                  <span className="capitalize">{renovation.zone.type}</span>
                  <span>•</span>
                  <span className="capitalize">{renovation.analysis.urgency}</span>
                  <span>•</span>
                  <span className="capitalize">{renovation.analysis.complexity}</span>
                </div>
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
          
          {/* ROI Banner */}
          <div className="mt-4 grid grid-cols-4 gap-2">
            <div className="bg-white/20 rounded-lg p-2 text-center">
              <div className="text-2xl font-bold">{renovation.roi.roi.toFixed(0)}%</div>
              <div className="text-xs opacity-80">5-Year ROI</div>
            </div>
            <div className="bg-white/20 rounded-lg p-2 text-center">
              <div className="text-2xl font-bold">{formatCurrency(renovation.roi.estimatedCost)}</div>
              <div className="text-xs opacity-80">Est. Cost</div>
            </div>
            <div className="bg-white/20 rounded-lg p-2 text-center">
              <div className="text-2xl font-bold">+{formatCurrency(renovation.roi.valueIncrease)}</div>
              <div className="text-xs opacity-80">Value Lift</div>
            </div>
            <div className="bg-white/20 rounded-lg p-2 text-center">
              <div className="text-2xl font-bold">+${renovation.roi.rentIncreaseMonthly}/mo</div>
              <div className="text-xs opacity-80">Rent Increase</div>
            </div>
          </div>
        </div>
        
        {/* Tabs */}
        <div className="flex border-b">
          {(['overview', 'materials', 'labor'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        
        {/* Content */}
        <div className="p-4 overflow-y-auto max-h-[calc(90vh-300px)]">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Explanation */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Analysis</h3>
                <p className="text-gray-600 text-sm leading-relaxed">
                  {renovation.analysis.explanation || renovation.zone.description}
                </p>
              </div>
              
              {/* Condition & Timeline */}
              <div className="grid grid-cols-2 gap-4">
                <MetricCard
                  label="Current Condition"
                  value={renovation.analysis.currentCondition.charAt(0).toUpperCase() + 
                         renovation.analysis.currentCondition.slice(1)}
                  icon="🔍"
                  color="orange"
                />
                <MetricCard
                  label="Est. Duration"
                  value={renovation.analysis.estimatedDuration}
                  icon="⏱️"
                  color="purple"
                />
              </div>
              
              {/* Financial Metrics */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Financial Analysis</h3>
                <div className="grid grid-cols-2 gap-4">
                  <MetricCard
                    label="Total ROI (5-Year)"
                    value={`${renovation.roi.roi.toFixed(1)}%`}
                    subValue={`${formatCurrency(renovation.roi.fiveYearReturn)} return`}
                    icon="📈"
                    color="green"
                  />
                  <MetricCard
                    label="Payback Period"
                    value={paybackDisplay}
                    subValue="from rent increase"
                    icon="⏳"
                    color="blue"
                  />
                </div>
              </div>
              
              {/* Cost Breakdown */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Cost Breakdown</h3>
                <div className="bg-gray-50 rounded-lg p-4">
                  <ProgressBar
                    value={renovation.costBreakdown.materials}
                    max={renovation.costBreakdown.total}
                    color="#3b82f6"
                    label="Materials"
                  />
                  <ProgressBar
                    value={renovation.costBreakdown.labor}
                    max={renovation.costBreakdown.total}
                    color="#10b981"
                    label="Labor"
                  />
                  <ProgressBar
                    value={renovation.costBreakdown.permits}
                    max={renovation.costBreakdown.total}
                    color="#f59e0b"
                    label="Permits"
                  />
                  <ProgressBar
                    value={renovation.costBreakdown.contingency}
                    max={renovation.costBreakdown.total}
                    color="#8b5cf6"
                    label="Contingency"
                  />
                  <div className="flex justify-between pt-3 mt-3 border-t border-gray-200">
                    <span className="font-semibold text-gray-700">Total Estimated</span>
                    <span className="font-bold text-gray-900">
                      {formatCurrency(renovation.costBreakdown.total)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm text-gray-500 mt-1">
                    <span>Range</span>
                    <span>
                      {formatCurrency(renovation.roi.costRange.low)} - {formatCurrency(renovation.roi.costRange.high)}
                    </span>
                  </div>
                </div>
              </div>
              
              {/* Confidence Score */}
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span>AI Confidence:</span>
                <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-500 rounded-full"
                    style={{ width: `${renovation.zone.confidence * 100}%` }}
                  />
                </div>
                <span className="font-medium">{(renovation.zone.confidence * 100).toFixed(0)}%</span>
              </div>
            </div>
          )}
          
          {activeTab === 'materials' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Estimated materials needed for this renovation:
              </p>
              
              <div className="space-y-2">
                {renovation.materials.map((material, index) => (
                  <div 
                    key={index}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <div className="font-medium text-gray-800">{material.name}</div>
                      <div className="text-xs text-gray-500">
                        {material.quantity} {material.unit} • {material.category} • {material.quality}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-gray-800">
                        {formatCurrency(material.totalCost)}
                      </div>
                      <div className="text-xs text-gray-500">
                        {formatCurrency(material.unitCost)}/{material.unit}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="flex justify-between pt-3 border-t">
                <span className="font-semibold">Total Materials Cost</span>
                <span className="font-bold text-blue-600">
                  {formatCurrency(renovation.materials.reduce((sum, m) => sum + m.totalCost, 0))}
                </span>
              </div>
              
              {/* Material alternatives note */}
              {renovation.materials.some(m => m.alternatives && m.alternatives.length > 0) && (
                <div className="mt-4 p-3 bg-blue-50 rounded-lg text-sm">
                  <span className="font-medium text-blue-800">💡 Tip:</span>{' '}
                  <span className="text-blue-700">
                    Alternative material options are available. Costs can vary 20-40% based on quality level.
                  </span>
                </div>
              )}
            </div>
          )}
          
          {activeTab === 'labor' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Professional labor requirements:
              </p>
              
              <div className="space-y-2">
                {renovation.labor.map((labor, index) => (
                  <div 
                    key={index}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <div className="font-medium text-gray-800">{labor.trade}</div>
                      <div className="text-xs text-gray-500">
                        {labor.hours} hours @ {formatCurrency(labor.hourlyRate)}/hr
                      </div>
                    </div>
                    <div className="font-semibold text-gray-800">
                      {formatCurrency(labor.totalCost)}
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="flex justify-between pt-3 border-t">
                <span className="font-semibold">Total Labor Cost</span>
                <span className="font-bold text-green-600">
                  {formatCurrency(renovation.labor.reduce((sum, l) => sum + l.totalCost, 0))}
                </span>
              </div>
              
              {/* Permits note */}
              {renovation.analysis.permits && renovation.analysis.permits.length > 0 && (
                <div className="mt-4 p-3 bg-yellow-50 rounded-lg text-sm">
                  <span className="font-medium text-yellow-800">📋 Permits Required:</span>
                  <ul className="mt-1 text-yellow-700 list-disc list-inside">
                    {renovation.analysis.permits.map((permit, i) => (
                      <li key={i}>{permit}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        
        {/* Footer Actions */}
        <div className="p-4 bg-gray-50 border-t space-y-3">
          {/* AR Preview Button */}
          {onGenerateARPreview && (
            <button
              onClick={() => onGenerateARPreview(renovation)}
              disabled={isGeneratingAR}
              className="w-full py-3 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 
                         text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {isGeneratingAR ? (
                <>
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Generating AR Preview...</span>
                </>
              ) : (
                <>
                  <span>🔮</span>
                  <span>Preview Final Result (AR)</span>
                </>
              )}
            </button>
          )}
          
          {/* Add to Marketplace Button */}
          <button
            onClick={() => onAddToMarketplace(renovation)}
            className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800
                       text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/25
                       flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                    d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span>Add Renovation to Marketplace</span>
          </button>
          
          <p className="text-xs text-center text-gray-500">
            List this renovation for contractor bids and get competitive quotes
          </p>
        </div>
      </div>
    </div>
  );
}

export default RenovationDetailsModal;
