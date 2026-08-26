/**
 * Measured Hole Cutter Tool
 * 
 * A precision tool for cutting measured polygon holes in 3D meshes.
 * 
 * Features:
 * - Click to set anchor point on wall
 * - Real-time distance measurement as cursor moves
 * - Multi-point polygon creation (3+ sides)
 * - Displays measurement for each side
 * - Calibration-aware measurements (feet/inches)
 * - Visual preview of the hole before cutting
 */

import React, { useState, useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { CalibrationResult } from '../services/meshCalibrationService';
import { getCalibratedDistance } from '../services/meshCalibrationService';

// ============================================================================
// Types
// ============================================================================

export interface HolePoint {
  id: string;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  timestamp: number;
}

export interface HoleSide {
  from: HolePoint;
  to: HolePoint;
  meshDistance: number;
  calibratedDistance: { value: number; unit: string };
}

export interface HolePolygon {
  points: HolePoint[];
  sides: HoleSide[];
  isClosed: boolean;
  surfaceNormal: THREE.Vector3;
  center: THREE.Vector3;
}

export interface MeasuredHoleCutterProps {
  isActive: boolean;
  calibration: CalibrationResult | null;
  meshGroup: THREE.Group | null;
  onComplete: (polygon: HolePolygon) => void;
  onCancel: () => void;
  onPointAdded?: (point: HolePoint) => void;
}

interface MeasuredHoleCutterOverlayProps {
  isActive: boolean;
  calibration: CalibrationResult | null;
  polygon: HolePolygon | null;
  currentMousePosition: THREE.Vector3 | null;
  previewDistance: { mesh: number; calibrated: { value: number; unit: string } } | null;
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatDistance(calibrated: { value: number; unit: string }): string {
  if (calibrated.unit === 'ft') {
    const feet = Math.floor(calibrated.value);
    const inches = (calibrated.value - feet) * 12;
    if (feet === 0) {
      return `${inches.toFixed(1)}"`;
    }
    return `${feet}'${inches.toFixed(1)}"`;
  }
  return `${calibrated.value.toFixed(2)} ${calibrated.unit}`;
}

function calculatePolygonCenter(points: HolePoint[]): THREE.Vector3 {
  if (points.length === 0) return new THREE.Vector3();
  
  const center = new THREE.Vector3();
  points.forEach(p => center.add(p.position));
  center.divideScalar(points.length);
  return center;
}

function calculateAverageSurfaceNormal(points: HolePoint[]): THREE.Vector3 {
  if (points.length === 0) return new THREE.Vector3(0, 0, 1);
  
  const avgNormal = new THREE.Vector3();
  points.forEach(p => avgNormal.add(p.normal));
  avgNormal.divideScalar(points.length);
  avgNormal.normalize();
  return avgNormal;
}

// ============================================================================
// Hook: useMeasuredHoleCutter
// ============================================================================

export function useMeasuredHoleCutter(
  calibration: CalibrationResult | null,
  _meshGroup: THREE.Group | null  // Reserved for future use (e.g., mesh bounds validation)
) {
  const [isActive, setIsActive] = useState(false);
  const [points, setPoints] = useState<HolePoint[]>([]);
  const [polygon, setPolygon] = useState<HolePolygon | null>(null);
  const [currentMousePosition, setCurrentMousePosition] = useState<THREE.Vector3 | null>(null);
  const [currentNormal, setCurrentNormal] = useState<THREE.Vector3 | null>(null);
  const [previewDistance, setPreviewDistance] = useState<{
    mesh: number;
    calibrated: { value: number; unit: string };
  } | null>(null);
  const [minPointsReached, setMinPointsReached] = useState(false);
  
  // Calculate distance from last point to current mouse position
  useEffect(() => {
    if (!isActive || points.length === 0 || !currentMousePosition) {
      setPreviewDistance(null);
      return;
    }
    
    const lastPoint = points[points.length - 1];
    const meshDistance = lastPoint.position.distanceTo(currentMousePosition);
    
    let calibrated = { value: meshDistance, unit: 'm' };
    if (calibration && calibration.success) {
      calibrated = getCalibratedDistance(meshDistance, calibration, 'feet');
    }
    
    setPreviewDistance({ mesh: meshDistance, calibrated });
  }, [isActive, points, currentMousePosition, calibration]);
  
  // Update polygon when points change
  useEffect(() => {
    if (points.length < 2) {
      setPolygon(null);
      setMinPointsReached(false);
      return;
    }
    
    setMinPointsReached(points.length >= 3);
    
    // Build sides array
    const sides: HoleSide[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];
      const meshDistance = from.position.distanceTo(to.position);
      
      let calibrated = { value: meshDistance, unit: 'm' };
      if (calibration && calibration.success) {
        calibrated = getCalibratedDistance(meshDistance, calibration, 'feet');
      }
      
      sides.push({ from, to, meshDistance, calibratedDistance: calibrated });
    }
    
    setPolygon({
      points,
      sides,
      isClosed: false,
      surfaceNormal: calculateAverageSurfaceNormal(points),
      center: calculatePolygonCenter(points),
    });
  }, [points, calibration]);
  
  const startCutting = useCallback(() => {
    setIsActive(true);
    setPoints([]);
    setPolygon(null);
    setMinPointsReached(false);
  }, []);
  
  const addPoint = useCallback((position: THREE.Vector3, normal: THREE.Vector3) => {
    const newPoint: HolePoint = {
      id: `point-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      position: position.clone(),
      normal: normal.clone(),
      timestamp: Date.now(),
    };
    setPoints(prev => [...prev, newPoint]);
    return newPoint;
  }, []);
  
  const updateMousePosition = useCallback((position: THREE.Vector3 | null, normal?: THREE.Vector3) => {
    setCurrentMousePosition(position);
    if (normal) setCurrentNormal(normal);
  }, []);
  
  const closePolygon = useCallback((): HolePolygon | null => {
    if (points.length < 3) {
      console.warn('[MeasuredHoleCutter] Need at least 3 points to close polygon');
      return null;
    }
    
    // Add final side from last point back to first
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    // Note: meshDistance is used for display in the sides array below
    lastPoint.position.distanceTo(firstPoint.position);
    
    const sides: HoleSide[] = [];
    for (let i = 0; i < points.length; i++) {
      const from = points[i];
      const to = points[(i + 1) % points.length];
      const dist = from.position.distanceTo(to.position);
      
      let cal = { value: dist, unit: 'm' };
      if (calibration && calibration.success) {
        cal = getCalibratedDistance(dist, calibration, 'feet');
      }
      
      sides.push({ from, to, meshDistance: dist, calibratedDistance: cal });
    }
    
    const closedPolygon: HolePolygon = {
      points,
      sides,
      isClosed: true,
      surfaceNormal: calculateAverageSurfaceNormal(points),
      center: calculatePolygonCenter(points),
    };
    
    setPolygon(closedPolygon);
    return closedPolygon;
  }, [points, calibration]);
  
  const undoLastPoint = useCallback(() => {
    setPoints(prev => prev.slice(0, -1));
  }, []);
  
  const reset = useCallback(() => {
    setPoints([]);
    setPolygon(null);
    setMinPointsReached(false);
    setCurrentMousePosition(null);
    setPreviewDistance(null);
  }, []);
  
  const cancel = useCallback(() => {
    reset();
    setIsActive(false);
  }, [reset]);
  
  return {
    isActive,
    points,
    polygon,
    currentMousePosition,
    currentNormal,
    previewDistance,
    minPointsReached,
    startCutting,
    addPoint,
    updateMousePosition,
    closePolygon,
    undoLastPoint,
    reset,
    cancel,
    setIsActive,
  };
}

// Export the return type of the hook for use in other components
export type MeasuredHoleCutterHook = ReturnType<typeof useMeasuredHoleCutter>;

// ============================================================================
// Component: MeasuredHoleCutterOverlay (3D Overlay in Canvas)
// ============================================================================

export function MeasuredHoleCutterOverlay({
  isActive,
  calibration: _calibration,  // Reserved for future calibration-based adjustments
  polygon,
  currentMousePosition,
  previewDistance,
}: MeasuredHoleCutterOverlayProps) {
  if (!isActive) return null;
  
  return (
    <group>
      {/* Render existing points */}
      {polygon?.points.map((point, index) => (
        <group key={point.id} position={point.position}>
          {/* Point marker */}
          <mesh>
            <sphereGeometry args={[0.03, 16, 16]} />
            <meshBasicMaterial color={index === 0 ? '#22c55e' : '#3b82f6'} />
          </mesh>
          
          {/* Point number label */}
          <Html center distanceFactor={5}>
            <div className="bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-lg border border-gray-700 whitespace-nowrap">
              {index + 1}
            </div>
          </Html>
        </group>
      ))}
      
      {/* Render sides with measurements */}
      {polygon?.sides.map((side, index) => {
        const midpoint = new THREE.Vector3()
          .addVectors(side.from.position, side.to.position)
          .multiplyScalar(0.5);
        
        return (
          <group key={`side-${index}`}>
            {/* Line segment */}
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([
                    side.from.position.x, side.from.position.y, side.from.position.z,
                    side.to.position.x, side.to.position.y, side.to.position.z,
                  ])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#3b82f6" linewidth={2} />
            </line>
            
            {/* Measurement label at midpoint */}
            <group position={midpoint}>
              <Html center distanceFactor={5}>
                <div className="bg-blue-600 text-white text-xs px-2 py-1 rounded shadow-lg font-mono whitespace-nowrap">
                  {formatDistance(side.calibratedDistance)}
                </div>
              </Html>
            </group>
          </group>
        );
      })}
      
      {/* Preview line from last point to cursor */}
      {polygon && polygon.points.length > 0 && currentMousePosition && (
        <group>
          {/* Dashed preview line */}
          <line>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                count={2}
                array={new Float32Array([
                  polygon.points[polygon.points.length - 1].position.x,
                  polygon.points[polygon.points.length - 1].position.y,
                  polygon.points[polygon.points.length - 1].position.z,
                  currentMousePosition.x,
                  currentMousePosition.y,
                  currentMousePosition.z,
                ])}
                itemSize={3}
              />
            </bufferGeometry>
            <lineDashedMaterial color="#fbbf24" dashSize={0.05} gapSize={0.03} linewidth={2} />
          </line>
          
          {/* Cursor position marker */}
          <mesh position={currentMousePosition}>
            <sphereGeometry args={[0.025, 16, 16]} />
            <meshBasicMaterial color="#fbbf24" />
          </mesh>
          
          {/* Preview distance label */}
          {previewDistance && (
            <group position={new THREE.Vector3()
              .addVectors(polygon.points[polygon.points.length - 1].position, currentMousePosition)
              .multiplyScalar(0.5)
            }>
              <Html center distanceFactor={5}>
                <div className="bg-yellow-500 text-black text-xs px-2 py-1 rounded shadow-lg font-mono whitespace-nowrap animate-pulse">
                  {formatDistance(previewDistance.calibrated)}
                </div>
              </Html>
            </group>
          )}
        </group>
      )}
      
      {/* Close polygon preview (line from last point to first) */}
      {polygon && polygon.points.length >= 3 && currentMousePosition && (
        <group>
          {/* Dashed line to first point */}
          <line>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                count={2}
                array={new Float32Array([
                  currentMousePosition.x, currentMousePosition.y, currentMousePosition.z,
                  polygon.points[0].position.x, polygon.points[0].position.y, polygon.points[0].position.z,
                ])}
                itemSize={3}
              />
            </bufferGeometry>
            <lineDashedMaterial color="#22c55e" dashSize={0.05} gapSize={0.03} linewidth={1} opacity={0.5} transparent />
          </line>
        </group>
      )}
    </group>
  );
}

// ============================================================================
// Component: MeasuredHoleCutterPanel (UI Panel)
// ============================================================================

interface MeasuredHoleCutterPanelProps {
  isActive: boolean;
  points: HolePoint[];
  polygon: HolePolygon | null;
  previewDistance: { mesh: number; calibrated: { value: number; unit: string } } | null;
  minPointsReached: boolean;
  calibration: CalibrationResult | null;
  onStartCutting: () => void;
  onClosePolygon: () => HolePolygon | null;
  onUndoLastPoint: () => void;
  onReset: () => void;
  onCancel: () => void;
  onCutHole: (polygon: HolePolygon) => void;
}

export const MeasuredHoleCutterPanel: React.FC<MeasuredHoleCutterPanelProps> = ({
  isActive,
  points,
  polygon,
  previewDistance,
  minPointsReached,
  calibration,
  onStartCutting,
  onClosePolygon,
  onUndoLastPoint,
  onReset,
  onCancel,
  onCutHole,
}) => {
  const [isCutting, setIsCutting] = useState(false);
  
  const handleCloseAndCut = useCallback(async () => {
    const closedPolygon = onClosePolygon();
    if (!closedPolygon) return;
    
    setIsCutting(true);
    try {
      await onCutHole(closedPolygon);
    } finally {
      setIsCutting(false);
    }
  }, [onClosePolygon, onCutHole]);
  
  // Calculate total perimeter
  const totalPerimeter = polygon?.sides.reduce((sum, side) => sum + side.calibratedDistance.value, 0) || 0;
  
  return (
    <div className="bg-gray-900/95 text-white p-4 rounded-lg shadow-xl border border-gray-700">
      <div className="flex justify-between items-center mb-3">
        <h4 className="font-bold flex items-center gap-2">
          📐 Measured Hole Cutter
        </h4>
        {isActive && (
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-white text-sm"
          >
            ✕ Cancel
          </button>
        )}
      </div>
      
      {!isActive ? (
        <>
          <p className="text-sm text-gray-400 mb-3">
            Create precision holes with measured dimensions.
            {!calibration?.success && (
              <span className="block text-yellow-500 mt-1">
                ⚠️ Calibrate first for accurate measurements
              </span>
            )}
          </p>
          <button
            onClick={onStartCutting}
            className="w-full py-2 px-4 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors"
          >
            ✂️ Start Measured Cut
          </button>
        </>
      ) : (
        <div className="space-y-3">
          {/* Instructions */}
          <div className="text-sm bg-blue-900/50 p-2 rounded">
            {points.length === 0 ? (
              <span>👆 Click on the wall to set first anchor point</span>
            ) : points.length < 3 ? (
              <span>👆 Click to add point {points.length + 1} (need {3 - points.length} more)</span>
            ) : (
              <span>👆 Add more points or close the polygon</span>
            )}
          </div>
          
          {/* Current distance preview */}
          {previewDistance && (
            <div className="text-sm bg-yellow-900/50 p-2 rounded flex justify-between items-center">
              <span>Distance to cursor:</span>
              <span className="font-mono font-bold">
                {formatDistance(previewDistance.calibrated)}
              </span>
            </div>
          )}
          
          {/* Points list */}
          {points.length > 0 && (
            <div className="text-xs space-y-1 max-h-32 overflow-y-auto">
              <div className="text-gray-400 font-medium">Points ({points.length}):</div>
              {polygon?.sides.map((side, index) => (
                <div key={index} className="flex justify-between bg-gray-800 px-2 py-1 rounded">
                  <span>Side {index + 1}:</span>
                  <span className="font-mono">{formatDistance(side.calibratedDistance)}</span>
                </div>
              ))}
              {polygon && polygon.points.length > 0 && !polygon.isClosed && (
                <div className="text-gray-500 italic">
                  + closing side (click "Close" to complete)
                </div>
              )}
            </div>
          )}
          
          {/* Total perimeter */}
          {totalPerimeter > 0 && (
            <div className="text-sm bg-gray-800 p-2 rounded flex justify-between items-center">
              <span>Total perimeter:</span>
              <span className="font-mono font-bold">
                {formatDistance({ value: totalPerimeter, unit: polygon?.sides[0]?.calibratedDistance.unit || 'ft' })}
              </span>
            </div>
          )}
          
          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={onUndoLastPoint}
              disabled={points.length === 0}
              className="flex-1 py-2 px-3 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 rounded text-sm font-medium transition-colors"
            >
              ↩️ Undo
            </button>
            <button
              onClick={onReset}
              disabled={points.length === 0}
              className="flex-1 py-2 px-3 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 rounded text-sm font-medium transition-colors"
            >
              🔄 Reset
            </button>
          </div>
          
          {/* Close and Cut button */}
          <button
            onClick={handleCloseAndCut}
            disabled={!minPointsReached || isCutting}
            className={`w-full py-3 px-4 rounded font-bold transition-colors ${
              minPointsReached && !isCutting
                ? 'bg-green-600 hover:bg-green-500 text-white'
                : 'bg-gray-700 text-gray-400 cursor-not-allowed'
            }`}
          >
            {isCutting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="animate-spin">⏳</span>
                Cutting hole...
              </span>
            ) : minPointsReached ? (
              `✂️ Close & Cut Hole (${points.length} points)`
            ) : (
              `Need ${3 - points.length} more points`
            )}
          </button>
          
          {/* Presets */}
          <div className="pt-2 border-t border-gray-700">
            <div className="text-xs text-gray-400 mb-2">Quick presets:</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                onClick={() => {/* Will implement preset rectangles */}}
                className="py-1 px-2 bg-gray-800 hover:bg-gray-700 rounded"
                disabled={points.length > 0}
              >
                🚪 Standard Door (36"×80")
              </button>
              <button
                onClick={() => {/* Will implement preset rectangles */}}
                className="py-1 px-2 bg-gray-800 hover:bg-gray-700 rounded"
                disabled={points.length > 0}
              >
                🪟 Standard Window (36"×48")
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MeasuredHoleCutterPanel;
