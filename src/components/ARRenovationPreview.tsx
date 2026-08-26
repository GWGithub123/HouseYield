/**
 * ARRenovationPreview Component
 * 
 * Displays an augmented reality preview of what a renovation would look like.
 * Shows a theoretical final product overlaid onto the existing 3D mesh with:
 * - Before/After comparison toggle
 * - Materials breakdown
 * - Interactive material selection
 */

import { useState, useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Html, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import type { 
  DetectedRenovation, 
  RenovationPreview, 
  MaterialItem 
} from '../types/renovationDetection';
import { getRenovationColor, getRenovationIcon } from '../types/renovationDetection';

// ============================================================================
// Types
// ============================================================================

interface ARRenovationPreviewProps {
  renovation: DetectedRenovation;
  meshUrl?: string;
  preview?: RenovationPreview;
  isGenerating?: boolean;
  onMaterialChange?: (area: string, material: string) => void;
  onClose?: () => void;
}

interface MaterialSelectorProps {
  materials: MaterialItem[];
  selectedQuality: 'budget' | 'mid-range' | 'premium' | 'luxury';
  onQualityChange: (quality: 'budget' | 'mid-range' | 'premium' | 'luxury') => void;
}

// ============================================================================
// Loading Component
// ============================================================================

function Loader() {
  const { progress } = useProgress();
  return (
    <Html center>
      <div className="flex flex-col items-center gap-2 text-white">
        <div className="w-48 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div 
            className="h-full bg-purple-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-sm">Loading preview... {progress.toFixed(0)}%</span>
      </div>
    </Html>
  );
}

// ============================================================================
// Preview Visualization (3D Scene)
// ============================================================================

interface PreviewSceneProps {
  renovation: DetectedRenovation;
  showAfter: boolean;
  materialQuality: 'budget' | 'mid-range' | 'premium' | 'luxury';
}

function PreviewScene({ renovation, showAfter, materialQuality }: PreviewSceneProps) {
  const color = getRenovationColor(renovation.zone.type);
  
  // Get material colors based on quality
  const getMaterialColor = useMemo(() => {
    const qualityColors = {
      budget: { primary: '#8B8B8B', accent: '#A0A0A0' },
      'mid-range': { primary: '#D4D4D4', accent: '#E8E8E8' },
      premium: { primary: '#F5F5DC', accent: '#FFFACD' },
      luxury: { primary: '#DAA520', accent: '#FFD700' },
    };
    return qualityColors[materialQuality];
  }, [materialQuality]);
  
  // Bounding box for visualization
  const boundingBox = renovation.zone.boundingBox;
  const size = new THREE.Vector3(
    boundingBox.max.x - boundingBox.min.x,
    boundingBox.max.y - boundingBox.min.y,
    boundingBox.max.z - boundingBox.min.z
  );
  const center = new THREE.Vector3(
    boundingBox.center.x,
    boundingBox.center.y,
    boundingBox.center.z
  );
  
  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 10, 5]} intensity={1} />
      <directionalLight position={[-5, 5, -5]} intensity={0.5} />
      
      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#f0f0f0" />
      </mesh>
      
      {/* Grid */}
      <gridHelper args={[20, 20, '#cccccc', '#e0e0e0']} />
      
      {/* "Before" state - wireframe/outline of area */}
      {!showAfter && (
        <group position={center}>
          <mesh>
            <boxGeometry args={[size.x, size.y, size.z]} />
            <meshBasicMaterial 
              color={color}
              wireframe
              transparent
              opacity={0.6}
            />
          </mesh>
          
          {/* Deterioration indicators */}
          <mesh position={[0, size.y / 4, size.z / 2 + 0.01]}>
            <planeGeometry args={[size.x * 0.6, size.y * 0.4]} />
            <meshBasicMaterial 
              color="#8B4513"
              transparent
              opacity={0.3}
            />
          </mesh>
          
          <Html position={[0, size.y / 2 + 0.5, 0]} center>
            <div className="bg-orange-500 text-white px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap">
              Current Condition: {renovation.analysis.currentCondition}
            </div>
          </Html>
        </group>
      )}
      
      {/* "After" state - rendered renovation preview */}
      {showAfter && (
        <group position={center}>
          {/* Main renovation visualization */}
          <mesh castShadow receiveShadow>
            <boxGeometry args={[size.x, size.y, size.z]} />
            <meshStandardMaterial 
              color={getMaterialColor.primary}
              metalness={materialQuality === 'luxury' ? 0.3 : 0.1}
              roughness={materialQuality === 'budget' ? 0.8 : 0.4}
            />
          </mesh>
          
          {/* Accent trim */}
          <mesh position={[0, size.y / 2 - 0.1, size.z / 2 + 0.02]}>
            <boxGeometry args={[size.x - 0.2, 0.15, 0.05]} />
            <meshStandardMaterial 
              color={getMaterialColor.accent}
              metalness={0.5}
              roughness={0.3}
            />
          </mesh>
          
          {/* Renovation type specific details */}
          {renovation.zone.type === 'kitchen' && (
            <>
              {/* Counter surface */}
              <mesh position={[0, size.y * 0.35, -size.z / 4]} castShadow>
                <boxGeometry args={[size.x - 0.2, 0.05, size.z / 2]} />
                <meshStandardMaterial 
                  color={materialQuality === 'luxury' ? '#FFFAF0' : '#E8E8E8'}
                  metalness={0.1}
                  roughness={0.2}
                />
              </mesh>
              
              {/* Cabinet doors simulation */}
              {[-1, 0, 1].map((offset) => (
                <mesh key={offset} position={[offset * size.x / 4, 0, size.z / 2 + 0.03]} castShadow>
                  <boxGeometry args={[size.x / 5, size.y * 0.5, 0.03]} />
                  <meshStandardMaterial color={getMaterialColor.primary} />
                </mesh>
              ))}
            </>
          )}
          
          {renovation.zone.type === 'bathroom' && (
            <>
              {/* Tile pattern simulation */}
              {Array.from({ length: 4 }).map((_, i) => (
                <mesh 
                  key={i} 
                  position={[-size.x / 4 + (i % 2) * size.x / 2, size.y / 4, size.z / 2 + 0.02]}
                  castShadow
                >
                  <boxGeometry args={[size.x / 3, size.y / 3, 0.02]} />
                  <meshStandardMaterial 
                    color={i % 2 === 0 ? getMaterialColor.primary : getMaterialColor.accent}
                  />
                </mesh>
              ))}
              
              {/* Vanity */}
              <mesh position={[0, -size.y / 4, 0]} castShadow>
                <boxGeometry args={[size.x * 0.6, size.y * 0.4, size.z * 0.4]} />
                <meshStandardMaterial color="#4A4A4A" />
              </mesh>
            </>
          )}
          
          {renovation.zone.type === 'flooring' && (
            <>
              {/* LVP/Hardwood plank pattern */}
              {Array.from({ length: 8 }).map((_, i) => (
                <mesh 
                  key={i} 
                  position={[-size.x / 2 + (i + 0.5) * size.x / 8, 0.02, 0]}
                  rotation={[Math.PI / 2, 0, 0]}
                >
                  <planeGeometry args={[size.x / 8.5, size.z]} />
                  <meshStandardMaterial 
                    color={i % 2 === 0 ? '#8B7355' : '#A08060'}
                  />
                </mesh>
              ))}
            </>
          )}
          
          <Html position={[0, size.y / 2 + 0.5, 0]} center>
            <div className="bg-green-500 text-white px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap">
              ✓ Renovated ({materialQuality})
            </div>
          </Html>
        </group>
      )}
      
      {/* Camera controls */}
      <OrbitControls 
        enablePan
        enableZoom
        enableRotate
        minDistance={2}
        maxDistance={20}
        target={center}
      />
    </>
  );
}

// ============================================================================
// Material Selector Panel
// ============================================================================

function MaterialSelector({ 
  materials, 
  selectedQuality, 
  onQualityChange 
}: MaterialSelectorProps) {
  const qualityOptions: Array<{ value: 'budget' | 'mid-range' | 'premium' | 'luxury'; label: string; priceMultiplier: number }> = [
    { value: 'budget', label: 'Budget', priceMultiplier: 0.7 },
    { value: 'mid-range', label: 'Mid-Range', priceMultiplier: 1.0 },
    { value: 'premium', label: 'Premium', priceMultiplier: 1.4 },
    { value: 'luxury', label: 'Luxury', priceMultiplier: 2.0 },
  ];
  
  const baseCost = materials.reduce((sum, m) => sum + m.totalCost, 0);
  const adjustedCost = baseCost * (qualityOptions.find(q => q.value === selectedQuality)?.priceMultiplier || 1);
  
  return (
    <div className="p-4 bg-white rounded-lg shadow-lg">
      <h4 className="font-semibold text-gray-800 mb-3">Material Quality</h4>
      
      <div className="grid grid-cols-4 gap-2 mb-4">
        {qualityOptions.map((option) => (
          <button
            key={option.value}
            onClick={() => onQualityChange(option.value)}
            className={`p-2 rounded-lg text-center text-sm transition-all ${
              selectedQuality === option.value
                ? 'bg-purple-600 text-white ring-2 ring-purple-300'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <div className="font-medium">{option.label}</div>
            <div className="text-xs opacity-80">{option.priceMultiplier}x</div>
          </button>
        ))}
      </div>
      
      <div className="text-sm space-y-2">
        <div className="flex justify-between">
          <span className="text-gray-600">Estimated Materials Cost:</span>
          <span className="font-semibold text-gray-800">
            ${adjustedCost.toLocaleString()}
          </span>
        </div>
        
        <div className="border-t pt-2 mt-2">
          <div className="text-xs text-gray-500 mb-2">Key Materials:</div>
          <div className="space-y-1">
            {materials.slice(0, 4).map((material, i) => (
              <div key={i} className="flex justify-between text-xs">
                <span className="text-gray-600 truncate flex-1 mr-2">{material.name}</span>
                <span className="text-gray-800 font-medium">
                  ${Math.round(material.totalCost * (qualityOptions.find(q => q.value === selectedQuality)?.priceMultiplier || 1)).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function ARRenovationPreview({
  renovation,
  meshUrl: _meshUrl,
  preview: _preview,
  isGenerating = false,
  onMaterialChange: _onMaterialChange,
  onClose,
}: ARRenovationPreviewProps) {
  const [showAfter, setShowAfter] = useState(true);
  const [materialQuality, setMaterialQuality] = useState<'budget' | 'mid-range' | 'premium' | 'luxury'>('mid-range');
  const [showMaterialPanel, setShowMaterialPanel] = useState(true);
  
  const icon = getRenovationIcon(renovation.zone.type);
  
  // Calculate adjusted costs based on material quality
  const qualityMultiplier = {
    budget: 0.7,
    'mid-range': 1.0,
    premium: 1.4,
    luxury: 2.0,
  }[materialQuality];
  
  const adjustedCost = Math.round(renovation.roi.estimatedCost * qualityMultiplier);
  const adjustedROI = Math.round(renovation.roi.roi / qualityMultiplier);
  
  return (
    <div className="fixed inset-0 z-50 bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-gray-800 text-white">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{icon}</span>
          <div>
            <h2 className="font-bold">AR Renovation Preview</h2>
            <p className="text-sm text-gray-300">{renovation.zone.name}</p>
          </div>
        </div>
        
        {/* Before/After Toggle */}
        <div className="flex items-center gap-2 bg-gray-700 rounded-lg p-1">
          <button
            onClick={() => setShowAfter(false)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              !showAfter ? 'bg-orange-500 text-white' : 'text-gray-300 hover:text-white'
            }`}
          >
            Before
          </button>
          <button
            onClick={() => setShowAfter(true)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              showAfter ? 'bg-green-500 text-white' : 'text-gray-300 hover:text-white'
            }`}
          >
            After
          </button>
        </div>
        
        {onClose && (
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-gray-700 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      
      {/* Main Content */}
      <div className="flex-1 flex">
        {/* 3D Preview Canvas */}
        <div className="flex-1 relative">
          {isGenerating ? (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
              <div className="text-center text-white">
                <div className="w-16 h-16 border-4 border-purple-500/30 border-t-purple-500 rounded-full animate-spin mx-auto mb-4" />
                <p className="font-medium">Generating AR Preview...</p>
                <p className="text-sm text-gray-400 mt-1">This may take a few moments</p>
              </div>
            </div>
          ) : (
            <Canvas
              camera={{ position: [5, 5, 5], fov: 60 }}
              shadows
            >
              <Suspense fallback={<Loader />}>
                <PreviewScene 
                  renovation={renovation}
                  showAfter={showAfter}
                  materialQuality={materialQuality}
                />
              </Suspense>
            </Canvas>
          )}
          
          {/* Controls help */}
          <div className="absolute bottom-4 left-4 bg-black/50 text-white text-xs p-2 rounded-lg">
            <div>🖱️ Drag to rotate • Scroll to zoom • Shift+drag to pan</div>
          </div>
          
          {/* Cost comparison overlay */}
          <div className="absolute top-4 right-4 bg-black/70 text-white p-3 rounded-lg text-sm">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-3 h-3 rounded-full ${showAfter ? 'bg-green-500' : 'bg-orange-500'}`} />
              <span className="font-medium">{showAfter ? 'After Renovation' : 'Before Renovation'}</span>
            </div>
            {showAfter && (
              <>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-300">Cost:</span>
                  <span className="font-bold">${adjustedCost.toLocaleString()}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-300">Est. ROI:</span>
                  <span className="font-bold text-green-400">{adjustedROI}%</span>
                </div>
              </>
            )}
          </div>
        </div>
        
        {/* Side Panel */}
        {showMaterialPanel && (
          <div className="w-80 bg-gray-100 p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800">Materials & Options</h3>
              <button
                onClick={() => setShowMaterialPanel(false)}
                className="p-1 text-gray-500 hover:text-gray-700"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            {/* Material Quality Selector */}
            <MaterialSelector
              materials={renovation.materials}
              selectedQuality={materialQuality}
              onQualityChange={setMaterialQuality}
            />
            
            {/* Labor Breakdown */}
            <div className="mt-4 p-4 bg-white rounded-lg shadow-lg">
              <h4 className="font-semibold text-gray-800 mb-3">Labor Requirements</h4>
              <div className="space-y-2">
                {renovation.labor.map((labor, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-600">{labor.trade}</span>
                    <span className="text-gray-800">{labor.hours}hrs</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between pt-2 mt-2 border-t text-sm font-semibold">
                <span>Total Labor:</span>
                <span>${renovation.labor.reduce((sum, l) => sum + l.totalCost, 0).toLocaleString()}</span>
              </div>
            </div>
            
            {/* Timeline */}
            <div className="mt-4 p-4 bg-white rounded-lg shadow-lg">
              <h4 className="font-semibold text-gray-800 mb-2">Estimated Timeline</h4>
              <div className="text-2xl font-bold text-purple-600">
                {renovation.analysis.estimatedDuration}
              </div>
              <div className="text-sm text-gray-500 mt-1 capitalize">
                Complexity: {renovation.analysis.complexity}
              </div>
            </div>
            
            {/* Value Impact */}
            <div className="mt-4 p-4 bg-gradient-to-r from-green-500 to-emerald-600 rounded-lg shadow-lg text-white">
              <h4 className="font-semibold mb-3">Value Impact</h4>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="opacity-80">Property Value:</span>
                  <span className="font-bold">+${renovation.roi.valueIncrease.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="opacity-80">Monthly Rent:</span>
                  <span className="font-bold">+${renovation.roi.rentIncreaseMonthly}/mo</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-white/20">
                  <span className="opacity-80">5-Year ROI:</span>
                  <span className="font-bold text-xl">{adjustedROI}%</span>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Toggle side panel button when hidden */}
        {!showMaterialPanel && (
          <button
            onClick={() => setShowMaterialPanel(true)}
            className="absolute top-1/2 right-0 transform -translate-y-1/2 bg-purple-600 text-white p-2 rounded-l-lg shadow-lg"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export default ARRenovationPreview;
