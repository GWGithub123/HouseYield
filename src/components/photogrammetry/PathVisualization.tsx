/**
 * Path Visualization Component
 * 
 * Displays an overhead minimap showing:
 * - User's walked path
 * - Current position and orientation
 * - Photo capture locations
 */

import React, { useMemo } from 'react';
import { Vector3, PhotogrammetryPhoto } from '../../types/photogrammetry';

interface PathVisualizationProps {
  positionHistory: Vector3[];
  currentPosition: Vector3;
  currentYaw: number;
  photos: PhotogrammetryPhoto[];
  size?: number;
}

const PathVisualization: React.FC<PathVisualizationProps> = ({
  positionHistory,
  currentPosition,
  currentYaw,
  photos,
  size = 128,
}) => {
  // Calculate bounds and scale
  const { scale, offsetX, offsetY, bounds: _bounds } = useMemo(() => {
    if (positionHistory.length === 0) {
      return { scale: 1, offsetX: size / 2, offsetY: size / 2, bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 } };
    }
    
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    
    for (const pos of positionHistory) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }
    
    // Add current position
    minX = Math.min(minX, currentPosition.x);
    maxX = Math.max(maxX, currentPosition.x);
    minY = Math.min(minY, currentPosition.y);
    maxY = Math.max(maxY, currentPosition.y);
    
    // Add padding
    const padding = 0.5;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;
    
    // Ensure minimum size
    const width = Math.max(maxX - minX, 2);
    const height = Math.max(maxY - minY, 2);
    
    // Calculate scale to fit in view
    const scaleX = (size - 20) / width;
    const scaleY = (size - 20) / height;
    const scale = Math.min(scaleX, scaleY, 50); // Max 50 pixels per meter
    
    // Center offset
    const offsetX = size / 2 - ((minX + maxX) / 2) * scale;
    const offsetY = size / 2 - ((minY + maxY) / 2) * scale;
    
    return { scale, offsetX, offsetY, bounds: { minX, maxX, minY, maxY } };
  }, [positionHistory, currentPosition, size]);
  
  // Convert world position to screen position
  const worldToScreen = (pos: Vector3): { x: number; y: number } => {
    return {
      x: pos.x * scale + offsetX,
      y: size - (pos.y * scale + offsetY), // Flip Y for screen coordinates
    };
  };
  
  // Generate path SVG
  const pathD = useMemo(() => {
    if (positionHistory.length < 2) return '';
    
    const points = positionHistory.map(worldToScreen);
    let d = `M ${points[0].x} ${points[0].y}`;
    
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x} ${points[i].y}`;
    }
    
    return d;
  }, [positionHistory, scale, offsetX, offsetY, size]);
  
  // Current position on screen
  const currentScreen = worldToScreen(currentPosition);
  
  // Calculate direction arrow points
  const arrowLength = 12;
  const arrowAngle = (-currentYaw + 90) * (Math.PI / 180); // Convert to radians, adjust for screen
  const arrowTip = {
    x: currentScreen.x + Math.cos(arrowAngle) * arrowLength,
    y: currentScreen.y - Math.sin(arrowAngle) * arrowLength,
  };
  
  return (
    <div 
      className="bg-black/60 backdrop-blur-sm rounded-xl overflow-hidden border border-white/20"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="w-full h-full">
        {/* Grid lines */}
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        
        {/* Walked path */}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke="rgba(59, 130, 246, 0.8)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        
        {/* Photo locations */}
        {photos.map((photo, _index) => {
          const pos = worldToScreen(photo.estimatedPosition);
          return (
            <circle
              key={photo.id}
              cx={pos.x}
              cy={pos.y}
              r="3"
              fill="rgba(34, 197, 94, 0.8)"
              stroke="white"
              strokeWidth="1"
            />
          );
        })}
        
        {/* Current position and direction */}
        <g>
          {/* Direction arrow */}
          <line
            x1={currentScreen.x}
            y1={currentScreen.y}
            x2={arrowTip.x}
            y2={arrowTip.y}
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
          />
          
          {/* Position dot */}
          <circle
            cx={currentScreen.x}
            cy={currentScreen.y}
            r="6"
            fill="rgba(239, 68, 68, 1)"
            stroke="white"
            strokeWidth="2"
          />
        </g>
        
        {/* North indicator */}
        <text
          x={size / 2}
          y="12"
          textAnchor="middle"
          fill="rgba(255,255,255,0.5)"
          fontSize="10"
          fontWeight="bold"
        >
          N
        </text>
      </svg>
      
      {/* Scale indicator */}
      <div className="absolute bottom-1 left-1 text-white/50 text-[8px]">
        {(1 / scale).toFixed(1)}m
      </div>
    </div>
  );
};

export default PathVisualization;
