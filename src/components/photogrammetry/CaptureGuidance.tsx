/**
 * Capture Guidance Component
 * 
 * Displays visual guidance for the user showing:
 * - Arrows pointing to uncovered areas
 * - Text instructions
 * - Suggestions for improving coverage
 */

import React from 'react';
import { CaptureRecommendation, normalizeAngle, angularDistance } from '../../types/photogrammetry';
import { ArrowUp, ArrowLeft, ArrowRight, Move, CheckCircle } from 'lucide-react';

interface CaptureGuidanceProps {
  recommendations: CaptureRecommendation[];
  currentYaw: number;
}

const CaptureGuidance: React.FC<CaptureGuidanceProps> = ({
  recommendations,
  currentYaw,
}) => {
  // Get the top recommendation
  const topRec = recommendations[0];
  
  if (!topRec) {
    return null;
  }
  
  // Calculate direction to turn for rotate recommendations
  const getRotationDirection = (targetAzimuth: number): 'left' | 'right' | 'aligned' => {
    const diff = normalizeAngle(targetAzimuth - currentYaw);
    if (diff < 15 || diff > 345) return 'aligned';
    return diff < 180 ? 'right' : 'left';
  };
  
  const getRotationAngle = (targetAzimuth: number): number => {
    return angularDistance(currentYaw, targetAzimuth);
  };
  
  // Render guidance based on recommendation type
  const renderGuidance = () => {
    if (topRec.type === 'complete') {
      return (
        <div className="flex items-center gap-2 px-4 py-3 bg-green-600/20 border border-green-500/50 rounded-xl">
          <CheckCircle className="w-6 h-6 text-green-400 flex-shrink-0" />
          <span className="text-green-200 text-sm font-medium">{topRec.message}</span>
        </div>
      );
    }
    
    if (topRec.type === 'move') {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="p-3 bg-blue-600/30 rounded-full animate-pulse">
            <Move className="w-8 h-8 text-blue-400" />
          </div>
          <div className="px-4 py-2 bg-black/60 rounded-lg">
            <p className="text-white text-sm text-center">{topRec.message}</p>
          </div>
        </div>
      );
    }
    
    if (topRec.type === 'rotate' && topRec.targetAzimuth !== undefined) {
      const direction = getRotationDirection(topRec.targetAzimuth);
      const angle = getRotationAngle(topRec.targetAzimuth);
      
      if (direction === 'aligned') {
        return (
          <div className="flex flex-col items-center gap-2">
            <div className="p-3 bg-green-600/30 rounded-full">
              <ArrowUp className="w-8 h-8 text-green-400" />
            </div>
            <div className="px-4 py-2 bg-black/60 rounded-lg">
              <p className="text-green-200 text-sm text-center">Aligned! Capture this area</p>
            </div>
          </div>
        );
      }
      
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-4">
            {direction === 'left' && (
              <div className="p-3 bg-yellow-600/30 rounded-full animate-bounce-x-left">
                <ArrowLeft className="w-8 h-8 text-yellow-400" />
              </div>
            )}
            
            <div className="text-center">
              <span className="text-yellow-400 text-2xl font-bold">{Math.round(angle)}°</span>
            </div>
            
            {direction === 'right' && (
              <div className="p-3 bg-yellow-600/30 rounded-full animate-bounce-x-right">
                <ArrowRight className="w-8 h-8 text-yellow-400" />
              </div>
            )}
          </div>
          
          <div className="px-4 py-2 bg-black/60 rounded-lg max-w-xs">
            <p className="text-white text-sm text-center">{topRec.message}</p>
          </div>
        </div>
      );
    }
    
    if (topRec.type === 'detail') {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="px-4 py-2 bg-purple-600/20 border border-purple-500/50 rounded-lg">
            <p className="text-purple-200 text-sm text-center">{topRec.message}</p>
          </div>
        </div>
      );
    }
    
    return null;
  };
  
  return (
    <div className="absolute inset-x-0 bottom-48 flex justify-center pointer-events-none">
      {renderGuidance()}
      
      {/* Additional recommendations shown as pills */}
      {recommendations.length > 1 && (
        <div className="absolute -bottom-10 left-0 right-0 flex justify-center gap-2">
          {recommendations.slice(1, 3).map((rec, index) => (
            <div
              key={index}
              className={`px-3 py-1 rounded-full text-xs ${
                rec.priority === 'high' 
                  ? 'bg-red-600/30 text-red-300'
                  : rec.priority === 'medium'
                  ? 'bg-yellow-600/30 text-yellow-300'
                  : 'bg-gray-600/30 text-gray-300'
              }`}
            >
              {rec.message.length > 30 ? rec.message.slice(0, 30) + '...' : rec.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CaptureGuidance;

// Add custom animation keyframes via CSS-in-JS or Tailwind config
// For Tailwind, add to tailwind.config.js:
// animation: {
//   'bounce-x-left': 'bounce-x-left 1s ease-in-out infinite',
//   'bounce-x-right': 'bounce-x-right 1s ease-in-out infinite',
// },
// keyframes: {
//   'bounce-x-left': {
//     '0%, 100%': { transform: 'translateX(0)' },
//     '50%': { transform: 'translateX(-10px)' },
//   },
//   'bounce-x-right': {
//     '0%, 100%': { transform: 'translateX(0)' },
//     '50%': { transform: 'translateX(10px)' },
//   },
// },
