/**
 * Coverage Map Component
 * 
 * Displays a visual overlay showing which directions have been photographed.
 * Uses a compass-style display with coverage indicated by color intensity.
 */

import React, { useMemo } from 'react';
import { CoverageReport } from '../../types/photogrammetry';

interface CoverageMapProps {
  coverageReport: CoverageReport;
  currentYaw: number;
  currentPitch: number;
}

const CoverageMap: React.FC<CoverageMapProps> = ({
  coverageReport,
  currentYaw,
  currentPitch: _currentPitch,
}) => {
  // Generate coverage segments for compass ring
  const coverageSegments = useMemo(() => {
    const segments: Array<{
      startAngle: number;
      endAngle: number;
      coverage: number;
      triangulatable: boolean;
    }> = [];
    
    const cellSize = coverageReport.grid.cellSize;
    const numCells = 360 / cellSize;
    
    // Get horizon-level coverage (elevation ~0)
    for (let i = 0; i < numCells; i++) {
      const azIndex = i;
      const elIndex = Math.floor(90 / cellSize); // Horizon
      
      const cell = coverageReport.grid.cells[azIndex]?.[elIndex];
      if (!cell) continue;
      
      segments.push({
        startAngle: i * cellSize,
        endAngle: (i + 1) * cellSize,
        coverage: Math.min(1, cell.viewCount / 3), // Normalize to 0-1
        triangulatable: cell.triangulatable,
      });
    }
    
    return segments;
  }, [coverageReport]);
  
  // Missing regions for indicators
  const criticalMissing = coverageReport.missingRegions.filter(r => r.severity === 'critical');
  
  return (
    <div className="absolute top-20 left-4 right-4 pointer-events-none">
      {/* Compass ring */}
      <div className="relative w-full max-w-[200px] mx-auto">
        <svg viewBox="0 0 200 200" className="w-full h-auto">
          {/* Background circle */}
          <circle
            cx="100"
            cy="100"
            r="80"
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="20"
          />
          
          {/* Coverage segments */}
          {coverageSegments.map((segment, index) => {
            // Convert to SVG arc coordinates
            const startRad = ((segment.startAngle - 90 - currentYaw) * Math.PI) / 180;
            const endRad = ((segment.endAngle - 90 - currentYaw) * Math.PI) / 180;
            
            const x1 = 100 + 80 * Math.cos(startRad);
            const y1 = 100 + 80 * Math.sin(startRad);
            const x2 = 100 + 80 * Math.cos(endRad);
            const y2 = 100 + 80 * Math.sin(endRad);
            
            const largeArc = segment.endAngle - segment.startAngle > 180 ? 1 : 0;
            
            // Color based on coverage
            let color: string;
            if (segment.triangulatable) {
              color = `rgba(34, 197, 94, ${0.3 + segment.coverage * 0.7})`; // Green
            } else if (segment.coverage > 0) {
              color = `rgba(234, 179, 8, ${0.3 + segment.coverage * 0.7})`; // Yellow
            } else {
              color = 'rgba(239, 68, 68, 0.3)'; // Red (missing)
            }
            
            return (
              <path
                key={index}
                d={`M ${x1} ${y1} A 80 80 0 ${largeArc} 1 ${x2} ${y2}`}
                fill="none"
                stroke={color}
                strokeWidth="16"
                strokeLinecap="butt"
              />
            );
          })}
          
          {/* Current direction indicator */}
          <path
            d="M 100 30 L 95 50 L 105 50 Z"
            fill="white"
          />
          
          {/* Cardinal directions */}
          <text x="100" y="15" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">N</text>
          <text x="185" y="104" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="10">E</text>
          <text x="100" y="195" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="10">S</text>
          <text x="15" y="104" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="10">W</text>
          
          {/* Center stats */}
          <text x="100" y="95" textAnchor="middle" fill="white" fontSize="24" fontWeight="bold">
            {coverageReport.overallCoverage.toFixed(0)}%
          </text>
          <text x="100" y="115" textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize="10">
            coverage
          </text>
        </svg>
      </div>
      
      {/* Critical missing region alert */}
      {criticalMissing.length > 0 && (
        <div className="mt-2 flex justify-center">
          <div className="bg-red-900/50 border border-red-500/50 rounded-lg px-3 py-1.5">
            <p className="text-red-300 text-xs text-center">
              ⚠️ {criticalMissing.length} area{criticalMissing.length > 1 ? 's' : ''} need coverage
            </p>
          </div>
        </div>
      )}
      
      {/* Legend */}
      <div className="mt-2 flex justify-center gap-4 text-[10px]">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-white/60">Good</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded-full bg-yellow-500" />
          <span className="text-white/60">Partial</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span className="text-white/60">Missing</span>
        </div>
      </div>
    </div>
  );
};

export default CoverageMap;
