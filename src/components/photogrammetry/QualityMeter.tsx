/**
 * Quality Meter Component
 * 
 * Real-time quality overlay for camera preview during photogrammetry capture.
 * Shows:
 * - Sharpness indicator (blur detection)
 * - Feature count (texture/detail level)
 * - Stability indicator (motion)
 * - Warning messages
 */

import React from 'react';
import { AlertCircle, CheckCircle2, Eye, Move, Zap } from 'lucide-react';
import type { QualityMetrics } from '../../services/imageQualityService';

// =============================================================================
// TYPES
// =============================================================================

interface QualityMeterProps {
  /** Current quality metrics from analysis */
  metrics: QualityMetrics | null;
  
  /** Motion stability score 0-1 */
  stability: number;
  
  /** Whether to show compact or expanded view */
  compact?: boolean;
  
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// HELPER COMPONENTS
// =============================================================================

interface MeterBarProps {
  value: number;  // 0-1
  label: string;
  icon: React.ReactNode;
  thresholds?: { low: number; medium: number };
}

const MeterBar: React.FC<MeterBarProps> = ({ 
  value, 
  label, 
  icon,
  thresholds = { low: 0.3, medium: 0.6 }
}) => {
  const percent = Math.round(value * 100);
  
  // Determine color based on value
  let colorClass = 'bg-green-500';
  if (value < thresholds.low) {
    colorClass = 'bg-red-500';
  } else if (value < thresholds.medium) {
    colorClass = 'bg-yellow-500';
  }
  
  return (
    <div className="flex items-center gap-2">
      <div className="text-gray-400 w-5">{icon}</div>
      <div className="flex-1">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-gray-300">{label}</span>
          <span className="text-white font-medium">{percent}%</span>
        </div>
        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div 
            className={`h-full ${colorClass} transition-all duration-200`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
};

const FeatureCounter: React.FC<{ count: number; min: number; good: number }> = ({ 
  count, 
  min,
  good 
}) => {
  let colorClass = 'text-green-400';
  let bgClass = 'bg-green-500/20';
  
  if (count < min) {
    colorClass = 'text-red-400';
    bgClass = 'bg-red-500/20';
  } else if (count < good) {
    colorClass = 'text-yellow-400';
    bgClass = 'bg-yellow-500/20';
  }
  
  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded ${bgClass}`}>
      <Eye className="w-4 h-4 text-gray-400" />
      <span className={`text-sm font-medium ${colorClass}`}>
        {count.toLocaleString()} features
      </span>
    </div>
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const QualityMeter: React.FC<QualityMeterProps> = ({
  metrics,
  stability,
  compact = false,
  className = '',
}) => {
  // Debug: Show more info when metrics is null
  if (!metrics) {
    return (
      <div className={`bg-black/60 backdrop-blur-sm rounded-lg p-3 ${className}`}>
        <div className="text-gray-400 text-sm flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
          Analyzing...
        </div>
        <div className="text-xs text-gray-500 mt-1">
          Waiting for video feed...
        </div>
      </div>
    );
  }
  
  const { sharpness, featureCount, isUsable, warning, overallScore } = metrics;
  
  // Compact view for minimal UI footprint
  if (compact) {
    return (
      <div className={`bg-black/60 backdrop-blur-sm rounded-lg px-3 py-2 ${className}`}>
        <div className="flex items-center gap-3">
          {/* Overall score badge */}
          <div className={`
            flex items-center gap-1.5 px-2 py-1 rounded-full text-sm font-bold
            ${isUsable ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}
          `}>
            {isUsable ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
            {overallScore}
          </div>
          
          {/* Warning message */}
          {warning && (
            <span className="text-yellow-400 text-xs truncate">
              {warning}
            </span>
          )}
        </div>
      </div>
    );
  }
  
  // Full view with detailed meters
  return (
    <div className={`bg-black/70 backdrop-blur-sm rounded-lg p-4 ${className}`}>
      {/* Header with overall score */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-white font-medium">Capture Quality</span>
        <div className={`
          flex items-center gap-1.5 px-2 py-1 rounded-full text-sm font-bold
          ${isUsable ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}
        `}>
          {isUsable ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          {overallScore}/100
        </div>
      </div>
      
      {/* Metric bars */}
      <div className="space-y-3">
        <MeterBar
          value={sharpness}
          label="Sharpness"
          icon={<Zap className="w-4 h-4" />}
          thresholds={{ low: 0.25, medium: 0.5 }}
        />
        
        <MeterBar
          value={stability}
          label="Stability"
          icon={<Move className="w-4 h-4" />}
          thresholds={{ low: 0.5, medium: 0.7 }}
        />
        
        <FeatureCounter 
          count={featureCount} 
          min={150} 
          good={500} 
        />
      </div>
      
      {/* Warning message */}
      {warning && (
        <div className="mt-3 flex items-start gap-2 text-yellow-400 bg-yellow-500/10 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span className="text-sm">{warning}</span>
        </div>
      )}
      
      {/* Ready indicator */}
      {isUsable && stability >= 0.7 && (
        <div className="mt-3 flex items-center gap-2 text-green-400 bg-green-500/10 rounded-lg px-3 py-2">
          <CheckCircle2 className="w-4 h-4" />
          <span className="text-sm font-medium">Ready to capture!</span>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// MINI QUALITY INDICATOR (for corner overlay)
// =============================================================================

interface MiniQualityIndicatorProps {
  isUsable: boolean;
  score: number;
  className?: string;
}

export const MiniQualityIndicator: React.FC<MiniQualityIndicatorProps> = ({
  isUsable,
  score,
  className = '',
}) => {
  return (
    <div className={`
      flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-bold
      ${isUsable ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}
      ${className}
    `}>
      {isUsable ? (
        <CheckCircle2 className="w-3 h-3" />
      ) : (
        <AlertCircle className="w-3 h-3" />
      )}
      {score}
    </div>
  );
};

// =============================================================================
// CAPTURE READINESS RING (circular indicator around capture button)
// =============================================================================

interface CaptureReadinessRingProps {
  /** Quality score 0-100 */
  quality: number;
  /** Stability score 0-1 */
  stability: number;
  /** Size in pixels */
  size?: number;
  /** Stroke width */
  strokeWidth?: number;
  className?: string;
}

export const CaptureReadinessRing: React.FC<CaptureReadinessRingProps> = ({
  quality,
  stability,
  size = 80,
  strokeWidth = 4,
  className = '',
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  
  // Combined readiness (quality + stability)
  const readiness = (quality / 100 + stability) / 2;
  const strokeDashoffset = circumference * (1 - readiness);
  
  // Color based on readiness
  let strokeColor = '#22c55e'; // green
  if (readiness < 0.3) {
    strokeColor = '#ef4444'; // red
  } else if (readiness < 0.6) {
    strokeColor = '#eab308'; // yellow
  }
  
  return (
    <svg
      width={size}
      height={size}
      className={`transform -rotate-90 ${className}`}
    >
      {/* Background ring */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth={strokeWidth}
      />
      
      {/* Progress ring */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        style={{ transition: 'stroke-dashoffset 0.2s ease, stroke 0.2s ease' }}
      />
    </svg>
  );
};

export default QualityMeter;
