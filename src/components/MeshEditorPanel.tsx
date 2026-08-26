/**
 * Mesh Editor Panel
 * 
 * UI for mesh editing operations:
 * - Furniture removal
 * - Room reshaping (cut doorways, windows)
 * - Mesh smoothing
 */

import React, { useState, useCallback, useEffect } from 'react';
import * as THREE from 'three';
import {
  removeFurniture,
  cutOpening,
  cutPolygonHole,
  smoothMesh,
  fillHoles,
  MeshEditResult,
  PolygonPoint,
} from '../services/meshEditingService';
import {
  MeasuredHoleCutterPanel,
  useMeasuredHoleCutter,
  type HolePolygon,
  type MeasuredHoleCutterHook,
} from './MeasuredHoleCutter';
import type { CalibrationResult } from '../services/meshCalibrationService';

interface MeshEditorPanelProps {
  meshUrl: string | null;
  onMeshUpdated: (newMeshUrl: string) => void;
  onClose?: () => void;
  // Original scan ID for texture lookup when editing already-edited meshes
  originalScanId?: string;
  // New: For click-to-place functionality
  onStartPlacementMode?: (type: 'door' | 'window') => void;
  placedPosition?: THREE.Vector3 | null;
  placedNormal?: THREE.Vector3 | null;
  // Measured hole cutter props
  calibration?: CalibrationResult | null;
  meshGroup?: THREE.Group | null;
  onStartMeasuredHoleCutter?: () => void;
  measuredHoleCutter?: MeasuredHoleCutterHook;
}

export const MeshEditorPanel: React.FC<MeshEditorPanelProps> = ({
  meshUrl,
  onMeshUpdated,
  onClose,
  originalScanId,
  onStartPlacementMode,
  placedPosition,
  placedNormal,
  calibration,
  meshGroup,
  onStartMeasuredHoleCutter,
  measuredHoleCutter: externalMeasuredHoleCutter,
}) => {
  const [activeTab, setActiveTab] = useState<'furniture' | 'reshape' | 'measured' | 'repair'>('furniture');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<MeshEditResult | null>(null);
  const [isPlacementMode, setIsPlacementMode] = useState(false);
  
  // Furniture removal options
  const [aggressive, setAggressive] = useState(false);
  const [floorHeight, setFloorHeight] = useState(0);
  const [autoDetectFloor, setAutoDetectFloor] = useState(true);
  
  // Opening options
  const [openingType, setOpeningType] = useState<'door' | 'window'>('door');
  const [openingPosition, setOpeningPosition] = useState({ x: 0, y: 0, z: 0 });
  // Note: Size is in viewer units. The Python script will scale these appropriately.
  // Using larger depth (2.0) to ensure it intersects walls of any thickness
  const [openingSize, setOpeningSize] = useState({ w: 0.9, h: 2.1, d: 2.0 }); // Standard door
  
  // Smoothing options
  const [smoothIterations, setSmoothIterations] = useState(3);
  
  // Update position when user clicks in 3D view
  useEffect(() => {
    if (placedPosition && isPlacementMode) {
      setOpeningPosition({
        x: Math.round(placedPosition.x * 100) / 100,
        y: Math.round(placedPosition.y * 100) / 100,
        z: Math.round(placedPosition.z * 100) / 100,
      });
      setIsPlacementMode(false);
      
      // Include normal direction in the message if available
      const normalInfo = placedNormal 
        ? ` | Normal: (${placedNormal.x.toFixed(2)}, ${placedNormal.y.toFixed(2)}, ${placedNormal.z.toFixed(2)})`
        : '';
      setProgress(`📍 Position set: (${placedPosition.x.toFixed(2)}, ${placedPosition.y.toFixed(2)}, ${placedPosition.z.toFixed(2)})${normalInfo}`);
    }
  }, [placedPosition, placedNormal, isPlacementMode]);
  
  // ============================================================================
  // Handlers
  // ============================================================================
  
  const handleRemoveFurniture = useCallback(async () => {
    if (!meshUrl) return;
    
    setIsProcessing(true);
    setProgress('Detecting and removing furniture...');
    setResult(null);
    
    try {
      const result = await removeFurniture(meshUrl, { 
        floorHeight: autoDetectFloor ? undefined : floorHeight, 
        aggressive 
      });
      
      if (result.success && result.outputUrl) {
        setResult(result);
        onMeshUpdated(result.outputUrl);
        const stats = result.stats;
        setProgress(`✅ Removed ${stats?.removedFaces || 0} furniture faces!\n` +
                    `Floor detected at Y=${(stats as any)?.floor_height?.toFixed(2) || '?'}`);
      } else {
        setProgress(`❌ Failed: ${result.error}`);
      }
    } catch (error: any) {
      setProgress(`❌ Error: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [meshUrl, floorHeight, autoDetectFloor, aggressive, onMeshUpdated]);
  
  const handleCutOpening = useCallback(async () => {
    if (!meshUrl) return;
    
    setIsProcessing(true);
    setProgress(`Cutting ${openingType}...`);
    setResult(null);
    
    try {
      // Pass viewer coordinates directly - the Python script will transform them
      // to mesh coordinates using the mesh's bounding box
      console.log('[MeshEditor] Cutting at viewer coords:', openingPosition);
      console.log('[MeshEditor] Size:', openingSize);
      
      const result = await cutOpening(
        meshUrl,
        openingType,
        [openingPosition.x, openingPosition.y, openingPosition.z],
        [openingSize.w, openingSize.h, openingSize.d]
      );
      
      if (result.success && result.outputUrl) {
        setResult(result);
        onMeshUpdated(result.outputUrl);
        const removedFaces = (result as any).removed_faces || (result.stats as any)?.removedFaces || 0;
        if (removedFaces === 0) {
          setProgress(`⚠️ ${openingType} cut completed but no faces were removed. Try clicking directly on a wall.`);
        } else {
          setProgress(`✅ ${openingType} cut successfully! Removed ${removedFaces} faces.`);
        }
      } else {
        setProgress(`❌ Failed: ${result.error}`);
      }
    } catch (error: any) {
      setProgress(`❌ Error: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [meshUrl, openingType, openingPosition, openingSize, onMeshUpdated]);
  
  // Measured Hole Cutter hook - use external hook if provided, otherwise create local one
  const localMeasuredHoleCutter = useMeasuredHoleCutter(calibration || null, meshGroup || null);
  const measuredHoleCutter = externalMeasuredHoleCutter || localMeasuredHoleCutter;
  
  // Handle polygon hole cut
  const handleCutPolygonHole = useCallback(async (polygon: HolePolygon) => {
    if (!meshUrl) return;
    
    setIsProcessing(true);
    setProgress(`Cutting ${polygon.points.length}-sided hole...`);
    setResult(null);
    
    try {
      // Get the scale factor from the mesh group
      // The viewer scales down large meshes to fit in the scene (maxDim > 20 gets scaled)
      // The scale is applied to the 'obj' object which is a child of the meshGroup
      let viewerScale = 1;
      if (meshGroup) {
        // First check the meshGroup's own scale
        if (meshGroup.scale.x !== 1) {
          viewerScale = meshGroup.scale.x;
          console.log('[MeshEditor] Found scale on meshGroup:', viewerScale);
        } else {
          // Traverse children to find the scaled object (the 'obj' that holds the mesh)
          meshGroup.traverse((child) => {
            if (child.scale && child.scale.x !== 1 && child.scale.x > 0) {
              viewerScale = child.scale.x;
              console.log('[MeshEditor] Found scale on child object:', viewerScale, child.type);
            }
          });
        }
        console.log('[MeshEditor] Final detected viewer scale:', viewerScale);
      }
      
      // Convert polygon points to the format expected by the API
      const points: PolygonPoint[] = polygon.points.map(p => ({
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        normalX: p.normal.x,
        normalY: p.normal.y,
        normalZ: p.normal.z,
      }));
      
      console.log('[MeshEditor] Cutting polygon hole with points:', points);
      console.log('[MeshEditor] Using viewer scale:', viewerScale);
      console.log('[MeshEditor] Original scan ID:', originalScanId);
      
      const result = await cutPolygonHole(meshUrl, points, {
        extrudeDepth: 0.5, // Extrude along surface normal
        smoothEdges: true,
        viewerScale: viewerScale,
        originalScanId: originalScanId,  // Pass for texture lookup on edited meshes
      });
      
      if (result.success && result.outputUrl) {
        setResult(result);
        onMeshUpdated(result.outputUrl);
        measuredHoleCutter.reset();
        measuredHoleCutter.setIsActive(false);
        const removedFaces = result.stats?.removedFaces || 0;
        setProgress(`✅ Polygon hole cut successfully! Removed ${removedFaces} faces.`);
      } else {
        setProgress(`❌ Failed: ${result.error}`);
      }
    } catch (error: any) {
      setProgress(`❌ Error: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [meshUrl, onMeshUpdated, measuredHoleCutter]);
  
  const handleSmooth = useCallback(async () => {
    if (!meshUrl) return;
    
    setIsProcessing(true);
    setProgress('Smoothing mesh...');
    setResult(null);
    
    try {
      const result = await smoothMesh(meshUrl, smoothIterations);
      
      if (result.success && result.outputUrl) {
        setResult(result);
        onMeshUpdated(result.outputUrl);
        setProgress('✅ Mesh smoothed!');
      } else {
        setProgress(`❌ Failed: ${result.error}`);
      }
    } catch (error: any) {
      setProgress(`❌ Error: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [meshUrl, smoothIterations, onMeshUpdated]);
  
  const handleFillHoles = useCallback(async () => {
    if (!meshUrl) return;
    
    setIsProcessing(true);
    setProgress('Filling holes...');
    setResult(null);
    
    try {
      const result = await fillHoles(meshUrl);
      
      if (result.success && result.outputUrl) {
        setResult(result);
        onMeshUpdated(result.outputUrl);
        setProgress('✅ Holes filled!');
      } else {
        setProgress(`❌ Failed: ${result.error}`);
      }
    } catch (error: any) {
      setProgress(`❌ Error: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [meshUrl, onMeshUpdated]);
  
  // ============================================================================
  // Render
  // ============================================================================
  
  return (
    <div className="bg-gray-900 text-white p-4 rounded-lg shadow-xl max-w-sm">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold flex items-center gap-2">
          ✏️ Mesh Editor
        </h3>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
          >
            ✕
          </button>
        )}
      </div>
      
      {/* Tab Navigation */}
      <div className="flex gap-1 mb-4 flex-wrap">
        <button
          onClick={() => setActiveTab('furniture')}
          className={`flex-1 py-2 px-2 rounded text-xs font-medium transition-colors ${
            activeTab === 'furniture'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          🪑 Furniture
        </button>
        <button
          onClick={() => setActiveTab('reshape')}
          className={`flex-1 py-2 px-2 rounded text-xs font-medium transition-colors ${
            activeTab === 'reshape'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          🚪 Quick
        </button>
        <button
          onClick={() => setActiveTab('measured')}
          className={`flex-1 py-2 px-2 rounded text-xs font-medium transition-colors ${
            activeTab === 'measured'
              ? 'bg-orange-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          📐 Measured
        </button>
        <button
          onClick={() => setActiveTab('repair')}
          className={`flex-1 py-2 px-2 rounded text-xs font-medium transition-colors ${
            activeTab === 'repair'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          🔧 Repair
        </button>
      </div>
      
      {/* Tab Content */}
      <div className="space-y-4">
        {/* Furniture Removal Tab */}
        {activeTab === 'furniture' && (
          <>
            <p className="text-sm text-gray-400">
              Remove furniture to see the full floor and wall surfaces.
            </p>
            
            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={aggressive}
                    onChange={(e) => setAggressive(e.target.checked)}
                    className="rounded"
                  />
                  Aggressive mode (removes more)
                </label>
              </div>
              
              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={autoDetectFloor}
                    onChange={(e) => setAutoDetectFloor(e.target.checked)}
                    className="rounded"
                  />
                  Auto-detect floor level
                </label>
              </div>
              
              {!autoDetectFloor && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    Floor Height (Y): {floorHeight}
                  </label>
                  <input
                    type="range"
                    min="-5"
                    max="5"
                    step="0.1"
                    value={floorHeight}
                    onChange={(e) => setFloorHeight(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}
              
              <button
                onClick={handleRemoveFurniture}
                disabled={isProcessing || !meshUrl}
                className="w-full py-2 px-4 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 rounded font-medium transition-colors"
              >
                {isProcessing ? '⏳ Processing...' : '🪑 Remove Furniture'}
              </button>
            </div>
          </>
        )}
        
        {/* Room Reshaping Tab */}
        {activeTab === 'reshape' && (
          <>
            <p className="text-sm text-gray-400">
              Cut doorways, windows, or other openings in walls.
            </p>
            
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Opening Type</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setOpeningType('door');
                      setOpeningSize({ w: 0.9, h: 2.1, d: 0.3 });
                    }}
                    className={`flex-1 py-2 px-3 rounded text-sm ${
                      openingType === 'door' ? 'bg-blue-600' : 'bg-gray-700'
                    }`}
                  >
                    🚪 Door
                  </button>
                  <button
                    onClick={() => {
                      setOpeningType('window');
                      setOpeningSize({ w: 1.2, h: 1.0, d: 0.3 });
                    }}
                    className={`flex-1 py-2 px-3 rounded text-sm ${
                      openingType === 'window' ? 'bg-blue-600' : 'bg-gray-700'
                    }`}
                  >
                    🪟 Window
                  </button>
                </div>
              </div>
              
              <div>
                <label className="block text-sm text-gray-400 mb-1">Position (X, Y, Z)</label>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <input
                    type="number"
                    step="0.1"
                    value={openingPosition.x}
                    onChange={(e) => setOpeningPosition(p => ({ ...p, x: parseFloat(e.target.value) || 0 }))}
                    className="bg-gray-800 rounded px-2 py-1 text-sm"
                    placeholder="X"
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={openingPosition.y}
                    onChange={(e) => setOpeningPosition(p => ({ ...p, y: parseFloat(e.target.value) || 0 }))}
                    className="bg-gray-800 rounded px-2 py-1 text-sm"
                    placeholder="Y"
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={openingPosition.z}
                    onChange={(e) => setOpeningPosition(p => ({ ...p, z: parseFloat(e.target.value) || 0 }))}
                    className="bg-gray-800 rounded px-2 py-1 text-sm"
                    placeholder="Z"
                  />
                </div>
                {onStartPlacementMode && (
                  <button
                    onClick={() => {
                      setIsPlacementMode(true);
                      onStartPlacementMode(openingType);
                      setProgress('🎯 Click on a wall to place the opening...');
                    }}
                    className={`w-full py-2 px-3 rounded text-sm font-medium transition-colors ${
                      isPlacementMode
                        ? 'bg-yellow-600 text-white animate-pulse'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {isPlacementMode ? '👆 Click on wall...' : '🎯 Click to Place'}
                  </button>
                )}
              </div>
              
              <div>
                <label className="block text-sm text-gray-400 mb-1">Size (W × H × D)</label>
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="number"
                    step="0.1"
                    value={openingSize.w}
                    onChange={(e) => setOpeningSize(s => ({ ...s, w: parseFloat(e.target.value) }))}
                    className="bg-gray-800 rounded px-2 py-1 text-sm"
                    placeholder="Width"
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={openingSize.h}
                    onChange={(e) => setOpeningSize(s => ({ ...s, h: parseFloat(e.target.value) }))}
                    className="bg-gray-800 rounded px-2 py-1 text-sm"
                    placeholder="Height"
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={openingSize.d}
                    onChange={(e) => setOpeningSize(s => ({ ...s, d: parseFloat(e.target.value) }))}
                    className="bg-gray-800 rounded px-2 py-1 text-sm"
                    placeholder="Depth"
                  />
                </div>
              </div>
              
              <button
                onClick={handleCutOpening}
                disabled={isProcessing || !meshUrl}
                className="w-full py-2 px-4 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 rounded font-medium transition-colors"
              >
                {isProcessing ? '⏳ Processing...' : `✂️ Cut ${openingType}`}
              </button>
              
              <p className="text-xs text-gray-500">
                💡 Tip: Click on a wall in the 3D view to set the position automatically.
              </p>
            </div>
          </>
        )}
        
        {/* Measured Hole Cutter Tab */}
        {activeTab === 'measured' && (
          <MeasuredHoleCutterPanel
            isActive={measuredHoleCutter.isActive}
            points={measuredHoleCutter.points}
            polygon={measuredHoleCutter.polygon}
            previewDistance={measuredHoleCutter.previewDistance}
            minPointsReached={measuredHoleCutter.minPointsReached}
            calibration={calibration || null}
            onStartCutting={() => {
              measuredHoleCutter.startCutting();
              onStartMeasuredHoleCutter?.();
            }}
            onClosePolygon={measuredHoleCutter.closePolygon}
            onUndoLastPoint={measuredHoleCutter.undoLastPoint}
            onReset={measuredHoleCutter.reset}
            onCancel={measuredHoleCutter.cancel}
            onCutHole={handleCutPolygonHole}
          />
        )}
        
        {/* Repair Tab */}
        {activeTab === 'repair' && (
          <>
            <p className="text-sm text-gray-400">
              Fix mesh artifacts, smooth rough edges, fill holes.
            </p>
            
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  Smooth Iterations: {smoothIterations}
                </label>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={smoothIterations}
                  onChange={(e) => setSmoothIterations(parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleSmooth}
                  disabled={isProcessing || !meshUrl}
                  className="py-2 px-4 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 rounded font-medium transition-colors text-sm"
                >
                  ✨ Smooth
                </button>
                <button
                  onClick={handleFillHoles}
                  disabled={isProcessing || !meshUrl}
                  className="py-2 px-4 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded font-medium transition-colors text-sm"
                >
                  🔧 Fill Holes
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      
      {/* Progress/Result */}
      {progress && (
        <div className={`mt-4 p-3 rounded text-sm ${
          progress.includes('✅') ? 'bg-green-900/50' :
          progress.includes('❌') ? 'bg-red-900/50' :
          'bg-blue-900/50'
        }`}>
          {progress}
        </div>
      )}
      
      {result?.stats && (
        <div className="mt-2 text-xs text-gray-400">
          Original: {result.stats.originalFaces} faces →
          Remaining: {result.stats.remainingFaces} faces
        </div>
      )}
      
      {/* Help */}
      <div className="mt-4 pt-4 border-t border-gray-700">
        <p className="text-xs text-gray-500">
          Processing happens on GPU server for best performance.
          Large meshes may take a few seconds.
        </p>
      </div>
    </div>
  );
};

// Export the measured hole cutter hook for use in parent components
export { useMeasuredHoleCutter };
export type { HolePolygon, HolePoint, HoleSide } from './MeasuredHoleCutter';

export default MeshEditorPanel;
