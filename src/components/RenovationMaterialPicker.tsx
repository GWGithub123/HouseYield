/**
 * RenovationMaterialPicker
 * 
 * UI panel for selecting renovation materials with:
 * - Visual color swatches
 * - Real-time cost preview based on calibrated measurements
 * - Material categories (budget, mid-range, premium)
 * - ROI indicators
 */

import { useState } from 'react';
import {
  RenovationMaterial,
  FLOORING_MATERIALS,
  WALL_MATERIALS,
  CEILING_MATERIALS,
} from '../data/renovationMaterials';
import type { RenovationSelection, RenovationCostSummary } from './RenovationTextureSystem';

// ============================================================================
// Types
// ============================================================================

// Captured viewpoint from manual capture
interface CapturedViewpoint {
  id: string;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fov: number;
  imageDataUrl: string;
  timestamp: number;
}

interface MaterialPickerProps {
  selectedMaterials: RenovationSelection;
  onSelectionChange: (selection: RenovationSelection) => void;
  costSummary: RenovationCostSummary | null;
  isCalibrated: boolean;
  onClose: () => void;
  onGenerateAITexture?: (surfaceType: 'flooring' | 'wall' | 'ceiling', materialName: string, materialDescription: string) => void;
  onAIRenovationPreview?: (renovationType: 'flooring' | 'paint', renovationOption: string) => void;
  onUVRenovation?: (surfaceType: 'floor' | 'wall' | 'ceiling' | 'counter', renovationType: string, renovationOption: string) => void;
  onProRenovation?: (surfaceType: 'floor' | 'wall' | 'ceiling', materialName: string) => void;
  onTriplanarRenovation?: (surfaceType: 'floor' | 'wall' | 'ceiling', materialName: string) => void;
  // NEW: Enhanced tile method with contextual floor generation
  onEnhancedTileRenovation?: (surfaceType: 'floor' | 'wall' | 'ceiling', materialName: string, materialOption: string, roomImageBase64?: string) => void;
  isGeneratingAI?: boolean;
  generatingAISurface?: 'flooring' | 'wall' | 'ceiling' | null;
  useUVMethod?: boolean;
  onToggleUVMethod?: (useUV: boolean) => void;
  renovationMethod?: 'triplanar' | 'pro' | 'uv' | 'tile';
  onSetRenovationMethod?: (method: 'triplanar' | 'pro' | 'uv' | 'tile') => void;
  meshSupportsUV?: boolean | null; // null = not checked, true = supports, false = doesn't support
  isRetexturing?: boolean;
  retexturingProgress?: { stage: string; progress: number } | null;
  // Viewpoint capture props
  capturedViewpoints?: CapturedViewpoint[];
  isCapturingViewpoints?: boolean;
  onStartViewpointCapture?: () => void;
  onCaptureViewpoint?: () => void;
  onFinishViewpointCapture?: () => void;
  onCancelViewpointCapture?: () => void;
  onRemoveViewpoint?: (id: string) => void;
  // Top-down room capture for enhanced tile method
  capturedRoomImage?: string | null;
  onCaptureRoomImage?: () => void;
  onClearRoomImage?: () => void;
}

// ============================================================================
// Material Card Component
// ============================================================================

interface MaterialCardProps {
  material: RenovationMaterial;
  isSelected: boolean;
  onSelect: () => void;
}

function MaterialCard({ material, isSelected, onSelect }: MaterialCardProps) {
  const colorHex = '#' + material.color.toString(16).padStart(6, '0');
  
  const categoryColors: Record<string, string> = {
    'budget': 'bg-green-500',
    'mid-range': 'bg-blue-500',
    'premium': 'bg-purple-500',
    'luxury': 'bg-amber-500',
  };
  
  return (
    <button
      onClick={onSelect}
      className={`
        relative p-3 rounded-lg border-2 transition-all text-left w-full
        ${isSelected 
          ? 'border-purple-500 bg-purple-500/10 shadow-lg shadow-purple-500/20' 
          : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
        }
      `}
    >
      {/* Color swatch */}
      <div className="flex items-start gap-3">
        <div 
          className="w-12 h-12 rounded-lg border border-gray-600 shadow-inner flex-shrink-0"
          style={{ backgroundColor: colorHex }}
        />
        
        <div className="flex-1 min-w-0">
          {/* Name and category */}
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-white text-sm truncate">
              {material.name}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full text-white ${categoryColors[material.category]}`}>
              {material.category}
            </span>
          </div>
          
          {/* Price */}
          <div className="text-xs text-gray-400">
            ${material.pricePerSqFt.toFixed(2)}/sq ft + ${material.laborPerSqFt.toFixed(2)} labor
          </div>
          
          {/* ROI */}
          <div className="flex items-center gap-1 mt-1">
            <span className="text-xs text-green-400">
              {material.roiMultiplier.toFixed(1)}x ROI
            </span>
            <span className="text-xs text-gray-500">
              • {material.durabilityYears} yr lifespan
            </span>
          </div>
        </div>
      </div>
      
      {/* Selected indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2 w-5 h-5 bg-purple-500 rounded-full flex items-center justify-center">
          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
      )}
    </button>
  );
}

// ============================================================================
// Section Component
// ============================================================================

interface MaterialSectionProps {
  title: string;
  icon: string;
  materials: RenovationMaterial[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onGenerateAI?: () => void;
  isGeneratingAI?: boolean;
}

function MaterialSection({ title, icon, materials, selectedId, onSelect, onGenerateAI, isGeneratingAI }: MaterialSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  
  return (
    <div className="border-b border-gray-700 pb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between py-2 text-white hover:text-purple-300 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          <span className="font-semibold">{title}</span>
          {selectedId && (
            <span className="text-xs bg-purple-500 px-2 py-0.5 rounded-full">
              Selected
            </span>
          )}
        </div>
        <svg 
          className={`w-5 h-5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} 
          fill="currentColor" 
          viewBox="0 0 20 20"
        >
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
      
      {isExpanded && (
        <div className="mt-2 space-y-2">
          {/* No change option and AI button */}
          <div className="flex gap-2">
            <button
              onClick={() => onSelect(null)}
              className={`
                flex-1 p-2 rounded-lg border-2 text-sm transition-all
                ${!selectedId 
                  ? 'border-gray-500 bg-gray-700/50 text-white' 
                  : 'border-gray-700 bg-gray-800/30 text-gray-400 hover:border-gray-600'
                }
              `}
            >
              Keep Original
            </button>
            
            {onGenerateAI && (
              <button
                onClick={onGenerateAI}
                disabled={isGeneratingAI}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white"
                title="Generate AI texture using Gemini Nano Banana"
              >
                {isGeneratingAI ? (
                  <span className="flex items-center gap-1">
                    <div className="animate-spin">⚙️</div>
                    AI
                  </span>
                ) : (
                  '🤖 AI'
                )}
              </button>
            )}
          </div>
          
          {/* Material options */}
          {materials.map((material) => (
            <MaterialCard
              key={material.id}
              material={material}
              isSelected={selectedId === material.id}
              onSelect={() => onSelect(material.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Cost Summary Component
// ============================================================================

interface CostSummaryPanelProps {
  summary: RenovationCostSummary | null;
  isCalibrated: boolean;
}

function CostSummaryPanel({ summary, isCalibrated }: CostSummaryPanelProps) {
  if (!summary || summary.items.length === 0) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-4 text-center text-gray-400">
        <p className="text-sm">Select materials to see cost estimates</p>
      </div>
    );
  }
  
  return (
    <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-400">Calibration</span>
        <span className={isCalibrated ? 'text-green-400' : 'text-yellow-400'}>
          {isCalibrated ? '✓ Accurate' : '⚠ Estimated'}
        </span>
      </div>
      
      {/* Line items */}
      {summary.items.map((item) => (
        <div key={item.material.id} className="flex items-center justify-between text-sm border-b border-gray-700 pb-2">
          <div>
            <div className="text-white">{item.material.name}</div>
            <div className="text-xs text-gray-500">{item.areaSqFt} sq ft</div>
          </div>
          <div className="text-right">
            <div className="text-white">${item.totalCost.toLocaleString()}</div>
            <div className="text-xs text-green-400">{item.roi.toFixed(1)}x ROI</div>
          </div>
        </div>
      ))}
      
      {/* Totals */}
      <div className="pt-2 space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Materials</span>
          <span className="text-white">${summary.totalMaterialCost.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Labor</span>
          <span className="text-white">${summary.totalLaborCost.toLocaleString()}</span>
        </div>
        <div className="flex justify-between font-bold text-lg pt-2 border-t border-gray-600">
          <span className="text-white">Total</span>
          <span className="text-purple-400">${summary.grandTotal.toLocaleString()}</span>
        </div>
      </div>
      
      {/* ROI Summary */}
      <div className="bg-green-900/30 rounded-lg p-3 mt-3">
        <div className="flex justify-between text-sm">
          <span className="text-green-300">Estimated Value Increase</span>
          <span className="text-green-400 font-bold">
            +${summary.estimatedValueIncrease.toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between text-sm mt-1">
          <span className="text-green-300">Overall ROI</span>
          <span className="text-green-400 font-bold">
            {summary.overallROI.toFixed(1)}x
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function RenovationMaterialPicker({
  selectedMaterials,
  onSelectionChange,
  costSummary,
  isCalibrated,
  onClose,
  onGenerateAITexture,
  onAIRenovationPreview,
  onUVRenovation,
  onProRenovation,
  onTriplanarRenovation,
  onEnhancedTileRenovation,
  isGeneratingAI = false,
  generatingAISurface = null,
  useUVMethod = true,
  onToggleUVMethod,
  renovationMethod = 'triplanar',
  onSetRenovationMethod,
  meshSupportsUV = null,
  isRetexturing = false,
  retexturingProgress = null,
  // Viewpoint capture props
  capturedViewpoints = [],
  isCapturingViewpoints = false,
  onStartViewpointCapture,
  onCaptureViewpoint,
  onFinishViewpointCapture,
  onCancelViewpointCapture,
  onRemoveViewpoint,
  // Top-down room capture
  capturedRoomImage = null,
  onCaptureRoomImage,
  onClearRoomImage,
}: MaterialPickerProps) {
  
  const handleFlooringChange = (id: string | null) => {
    onSelectionChange({ ...selectedMaterials, flooringId: id });
  };
  
  const handleWallChange = (id: string | null) => {
    onSelectionChange({ ...selectedMaterials, wallId: id });
  };
  
  const handleCeilingChange = (id: string | null) => {
    onSelectionChange({ ...selectedMaterials, ceilingId: id });
  };
  
  const handleGenerateAI = (surfaceType: 'flooring' | 'wall' | 'ceiling') => {
    if (!isGeneratingAI) {
      // Look up the selected material for this surface type
      let materialName = '';
      let materialDescription = '';
      
      if (surfaceType === 'flooring' && selectedMaterials.flooringId) {
        const material = FLOORING_MATERIALS.find(m => m.id === selectedMaterials.flooringId);
        if (material) {
          materialName = material.name;
          materialDescription = material.description;
        }
      } else if (surfaceType === 'wall' && selectedMaterials.wallId) {
        const material = WALL_MATERIALS.find(m => m.id === selectedMaterials.wallId);
        if (material) {
          materialName = material.name;
          materialDescription = material.description;
        }
      } else if (surfaceType === 'ceiling' && selectedMaterials.ceilingId) {
        const material = CEILING_MATERIALS.find(m => m.id === selectedMaterials.ceilingId);
        if (material) {
          materialName = material.name;
          materialDescription = material.description;
        }
      }
      
      // Default material names if none selected
      if (!materialName) {
        if (surfaceType === 'flooring') materialName = 'warm oak hardwood flooring';
        else if (surfaceType === 'wall') materialName = 'fresh neutral paint';
        else materialName = 'clean white ceiling';
      }
      
      // Determine renovation option from material name
      const renovationOption = materialName.toLowerCase().includes('walnut') ? 'walnut' :
                              materialName.toLowerCase().includes('oak') ? 'hardwood' :
                              materialName.toLowerCase().includes('tile') ? 'tile' :
                              materialName.toLowerCase().includes('marble') ? 'marble' :
                              materialName.toLowerCase().includes('vinyl') ? 'vinyl' :
                              materialName.toLowerCase().includes('white') ? 'white' :
                              materialName.toLowerCase().includes('gray') ? 'gray' :
                              materialName.toLowerCase().includes('beige') ? 'beige' :
                              'hardwood';
      
      // Use the selected renovation method
      if (renovationMethod === 'triplanar' && onTriplanarRenovation) {
        // ⚡ Triplanar: Real-time projection, correct from all angles (RECOMMENDED)
        const triplanarSurfaceType = surfaceType === 'flooring' ? 'floor' : surfaceType;
        onTriplanarRenovation(triplanarSurfaceType as 'floor' | 'wall' | 'ceiling', materialName);
      } else if (renovationMethod === 'pro' && onProRenovation) {
        // 🚀 Pro: Multi-view Gemini + OpenMVS retexturing (best quality)
        const proSurfaceType = surfaceType === 'flooring' ? 'floor' : surfaceType;
        onProRenovation(proSurfaceType as 'floor' | 'wall' | 'ceiling', materialName);
      } else if (renovationMethod === 'uv' && onUVRenovation) {
        // 🎨 UV: Fast texture atlas editing
        const uvSurfaceType = surfaceType === 'flooring' ? 'floor' : surfaceType;
        const renovationType = surfaceType === 'flooring' ? 'flooring' : 'paint';
        onUVRenovation(uvSurfaceType, renovationType, renovationOption);
      } else if (renovationMethod === 'tile' && onEnhancedTileRenovation) {
        // 🔄 Tile: Enhanced contextual floor generation with pattern extraction
        // Check if we have a captured room image
        if (!capturedRoomImage && surfaceType === 'flooring') {
          alert('📸 Please capture a top-down room image first!\n\nPosition your camera above the room looking down, then click "Capture Room View" before selecting a flooring material.');
          return;
        }
        const tileSurfaceType = surfaceType === 'flooring' ? 'floor' : surfaceType;
        onEnhancedTileRenovation(tileSurfaceType as 'floor' | 'wall' | 'ceiling', materialName, renovationOption, capturedRoomImage || undefined);
      } else if (renovationMethod === 'tile' && onGenerateAITexture) {
        // 🔄 Tile: Fallback to legacy tile generation
        onGenerateAITexture(surfaceType, materialName, materialDescription);
      } else if (onTriplanarRenovation) {
        // Fallback to triplanar if available (recommended)
        const triplanarSurfaceType = surfaceType === 'flooring' ? 'floor' : surfaceType;
        onTriplanarRenovation(triplanarSurfaceType as 'floor' | 'wall' | 'ceiling', materialName);
      } else if (onUVRenovation) {
        // Fallback to UV if Pro not available
        const uvSurfaceType = surfaceType === 'flooring' ? 'floor' : surfaceType;
        const renovationType = surfaceType === 'flooring' ? 'flooring' : 'paint';
        onUVRenovation(uvSurfaceType, renovationType, renovationOption);
      } else if (onGenerateAITexture) {
        // Fallback to tile
        onGenerateAITexture(surfaceType, materialName, materialDescription);
      } else if (onAIRenovationPreview) {
        // Fallback to screenshot-based preview if no texture handler
        const renovationType = surfaceType === 'flooring' ? 'flooring' : 'paint';
        onAIRenovationPreview(renovationType, materialName);
      }
    }
  };
  
  // Quick presets
  const applyPreset = (preset: 'budget' | 'midRange' | 'premium') => {
    const presets: Record<string, RenovationSelection> = {
      budget: {
        flooringId: 'lvp-oak-natural',
        wallId: 'paint-agreeable-gray',
        ceilingId: 'paint-ceiling-white',
      },
      midRange: {
        flooringId: 'engineered-walnut',
        wallId: 'paint-white-dove',
        ceilingId: 'paint-ceiling-white',
      },
      premium: {
        flooringId: 'solid-oak-natural',
        wallId: 'paint-simply-white',
        ceilingId: 'paint-ceiling-off-white',
      },
    };
    
    onSelectionChange(presets[preset]);
  };
  
  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-gray-900/95 border-l border-gray-700 shadow-2xl flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <div>
          <h2 className="text-lg font-bold text-white">Renovation Materials</h2>
          <p className="text-xs text-gray-400">Select materials for each surface</p>
        </div>
        <button
          onClick={onClose}
          className="p-2 text-gray-400 hover:text-white transition-colors"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
      
      {/* Quick Presets */}
      <div className="p-4 border-b border-gray-700">
        <div className="text-xs text-gray-400 mb-2">Quick Presets</div>
        <div className="flex gap-2">
          <button
            onClick={() => applyPreset('budget')}
            className="flex-1 px-3 py-2 bg-green-600/20 text-green-400 rounded-lg text-sm hover:bg-green-600/30 transition-colors border border-green-600/30"
          >
            💵 Budget
          </button>
          <button
            onClick={() => applyPreset('midRange')}
            className="flex-1 px-3 py-2 bg-blue-600/20 text-blue-400 rounded-lg text-sm hover:bg-blue-600/30 transition-colors border border-blue-600/30"
          >
            🏠 Mid-Range
          </button>
          <button
            onClick={() => applyPreset('premium')}
            className="flex-1 px-3 py-2 bg-purple-600/20 text-purple-400 rounded-lg text-sm hover:bg-purple-600/30 transition-colors border border-purple-600/30"
          >
            ✨ Premium
          </button>
        </div>
      </div>
      
      {/* AI Method Toggle - 4-way: Fast (Triplanar) / Pro / UV / Tile */}
      {(onUVRenovation || onGenerateAITexture || onProRenovation || onTriplanarRenovation) && (
        <div className="p-4 border-b border-gray-700 bg-gray-800/30">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">AI Renovation Method:</span>
            {onSetRenovationMethod && (
              <div className="flex bg-gray-700 rounded-lg p-0.5">
                <button
                  onClick={() => onSetRenovationMethod('triplanar')}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                    renovationMethod === 'triplanar'
                      ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white' 
                      : 'text-gray-400 hover:text-white'
                  }`}
                  title="Recommended - Real-time triplanar projection, works from all angles"
                >
                  ⚡ Fast
                </button>
                <button
                  onClick={() => onSetRenovationMethod('pro')}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                    renovationMethod === 'pro'
                      ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white' 
                      : 'text-gray-400 hover:text-white'
                  }`}
                  title="OpenMVS on GCP - may have artifacts"
                >
                  🚀 Pro
                </button>
                <button
                  onClick={() => meshSupportsUV !== false && onSetRenovationMethod('uv')}
                  disabled={meshSupportsUV === false}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                    meshSupportsUV === false 
                      ? 'text-gray-600 cursor-not-allowed'
                      : renovationMethod === 'uv' 
                        ? 'bg-purple-600 text-white' 
                        : 'text-gray-400 hover:text-white'
                  }`}
                  title={meshSupportsUV === false 
                    ? 'UV Edit not available - mesh has no faces or UVs (Gaussian splat?)'
                    : 'Fast - Edits texture atlas directly'}
                >
                  🎨 UV
                </button>
                <button
                  onClick={() => onSetRenovationMethod('tile')}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                    renovationMethod === 'tile' 
                      ? 'bg-blue-600 text-white' 
                      : 'text-gray-400 hover:text-white'
                  }`}
                  title="Legacy - Generates tileable textures"
                >
                  🔄 Tile
                </button>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500">
            {meshSupportsUV === false && renovationMethod === 'uv' ? (
              '⚠️ UV Edit unavailable - this is a Gaussian splat or point cloud'
            ) : renovationMethod === 'triplanar' ? (
              '⚡ Fast: Triplanar projection - real-time, correct from all angles (recommended)'
            ) : renovationMethod === 'pro' ? (
              '🚀 Pro: Multi-view Gemini + OpenMVS (may have artifacts)'
            ) : renovationMethod === 'uv' ? (
              '✨ UV Edit: Fast texture atlas editing (preserves lighting)'
            ) : (
              '🔄 AI Tile: Generate repeating texture patterns (legacy)'
            )}
          </p>
          
          {/* Room Image Capture for Tile Method */}
          {renovationMethod === 'tile' && onCaptureRoomImage && !isRetexturing && (
            <div className="mt-3 p-3 bg-blue-900/30 rounded-lg border border-blue-700/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-blue-300">📸 Top-Down Room Capture</span>
                {capturedRoomImage && (
                  <span className="text-xs text-green-400">✓ Captured</span>
                )}
              </div>
              <p className="text-xs text-gray-400 mb-2">
                Position your camera directly above the room looking straight down at the floor, then capture the view. This helps AI generate more realistic flooring.
              </p>
              
              {capturedRoomImage ? (
                <div className="space-y-2">
                  <div className="relative">
                    <img 
                      src={capturedRoomImage} 
                      alt="Captured room view"
                      className="w-full h-24 object-cover rounded border border-gray-600"
                    />
                    {onClearRoomImage && (
                      <button
                        onClick={onClearRoomImage}
                        className="absolute top-1 right-1 px-2 py-0.5 bg-red-600/90 hover:bg-red-700 rounded text-white text-xs"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-green-400">✓ Ready! Now select a flooring material below.</p>
                </div>
              ) : (
                <button
                  onClick={onCaptureRoomImage}
                  className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <span>📷</span>
                  Capture Room View
                </button>
              )}
            </div>
          )}
          
          {/* Retexturing Progress */}
          {isRetexturing && retexturingProgress && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                <span className="flex items-center gap-1">
                  <div className="animate-spin">⚙️</div>
                  {retexturingProgress.stage}
                </span>
                <span>{Math.round(retexturingProgress.progress * 100)}%</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div 
                  className="bg-gradient-to-r from-green-500 to-emerald-500 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${retexturingProgress.progress * 100}%` }}
                />
              </div>
            </div>
          )}
          
          {/* Viewpoint Capture for Pro Method */}
          {renovationMethod === 'pro' && onStartViewpointCapture && !isRetexturing && (
            <div className="mt-3 p-3 bg-blue-900/30 rounded-lg border border-blue-700/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-blue-300">📸 Custom Viewpoints</span>
                {capturedViewpoints.length > 0 && (
                  <span className="text-xs text-blue-400">{capturedViewpoints.length} captured</span>
                )}
              </div>
              <p className="text-xs text-gray-400 mb-2">
                Capture custom camera angles for better renovation results. Navigate the 3D model and capture views of the areas you want to renovate.
              </p>
              {isCapturingViewpoints ? (
                <div className="flex items-center gap-2 text-xs text-yellow-400">
                  <span className="animate-pulse">●</span>
                  Capturing mode active - use the capture overlay
                </div>
              ) : (
                <button
                  onClick={onStartViewpointCapture}
                  className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <span>📷</span>
                  {capturedViewpoints.length > 0 ? 'Add More Viewpoints' : 'Start Capturing Viewpoints'}
                </button>
              )}
              {/* Captured viewpoint thumbnails */}
              {capturedViewpoints.length > 0 && !isCapturingViewpoints && (
                <div className="mt-2 flex gap-1 flex-wrap">
                  {capturedViewpoints.slice(0, 6).map((vp, idx) => (
                    <div key={vp.id} className="relative">
                      <img 
                        src={vp.imageDataUrl} 
                        alt={`View ${idx + 1}`}
                        className="w-12 h-8 object-cover rounded border border-gray-600"
                      />
                      {onRemoveViewpoint && (
                        <button
                          onClick={() => onRemoveViewpoint(vp.id)}
                          className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 rounded-full text-white text-[8px] flex items-center justify-center hover:bg-red-700"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  {capturedViewpoints.length > 6 && (
                    <span className="text-xs text-gray-500 self-center">+{capturedViewpoints.length - 6} more</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      
      {/* Scrollable Materials Section */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <MaterialSection
          title="Flooring"
          icon="🏠"
          materials={FLOORING_MATERIALS}
          selectedId={selectedMaterials.flooringId}
          onSelect={handleFlooringChange}
          onGenerateAI={() => handleGenerateAI('flooring')}
          isGeneratingAI={isGeneratingAI && generatingAISurface === 'flooring'}
        />
        
        <MaterialSection
          title="Wall Paint"
          icon="🎨"
          materials={WALL_MATERIALS}
          selectedId={selectedMaterials.wallId}
          onSelect={handleWallChange}
          onGenerateAI={() => handleGenerateAI('wall')}
          isGeneratingAI={isGeneratingAI && generatingAISurface === 'wall'}
        />
        
        <MaterialSection
          title="Ceiling"
          icon="☁️"
          materials={CEILING_MATERIALS}
          selectedId={selectedMaterials.ceilingId}
          onSelect={handleCeilingChange}
          onGenerateAI={() => handleGenerateAI('ceiling')}
          isGeneratingAI={isGeneratingAI && generatingAISurface === 'ceiling'}
        />
      </div>
      
      {/* Cost Summary - Fixed at bottom */}
      <div className="p-4 border-t border-gray-700 bg-gray-900">
        <div className="text-sm font-medium text-white mb-2">Cost Estimate</div>
        <CostSummaryPanel summary={costSummary} isCalibrated={isCalibrated} />
      </div>
    </div>
  );
}

export default RenovationMaterialPicker;
