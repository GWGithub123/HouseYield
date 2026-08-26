/**
 * AI Renovation Suggestion Markers Component
 * 
 * Renders interactive 3D markers (flags) on the photogrammetry mesh
 * for AI-detected renovation suggestions. When a marker is clicked,
 * it captures the view and generates a renovation preview using Gemini.
 */

import { useRef, useState, useMemo, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { 
  RenovationSuggestion 
} from '../services/aiInteriorScanService';
import { getSuggestionTypeInfo } from '../services/aiInteriorScanService';

// ============================================================================
// Types
// ============================================================================

interface AISuggestionMarkersProps {
  suggestions: RenovationSuggestion[];
  selectedSuggestionId: string | null;
  onSuggestionSelect: (suggestion: RenovationSuggestion) => void;
  onGeneratePreview: (suggestion: RenovationSuggestion) => void;
  visible?: boolean;
  showLabels?: boolean;
}

interface SingleSuggestionMarkerProps {
  suggestion: RenovationSuggestion;
  isSelected: boolean;
  onSelect: (suggestion: RenovationSuggestion) => void;
  onGeneratePreview: (suggestion: RenovationSuggestion) => void;
  showLabel: boolean;
}

// ============================================================================
// Single Marker Component
// ============================================================================

function SuggestionFlagMarker({
  suggestion,
  isSelected,
  onSelect,
  onGeneratePreview,
  showLabel,
}: SingleSuggestionMarkerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const flagRef = useRef<THREE.Mesh>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  
  // Get styling for this suggestion type
  const typeInfo = useMemo(() => getSuggestionTypeInfo(suggestion.type), [suggestion.type]);
  const color = useMemo(() => new THREE.Color(typeInfo.color), [typeInfo.color]);
  
  // Priority colors for the ring indicator
  const priorityColor = useMemo(() => {
    switch (suggestion.priority) {
      case 'high': return '#ef4444'; // red
      case 'medium': return '#f97316'; // orange
      case 'low': return '#22c55e'; // green
      default: return '#9ca3af'; // gray
    }
  }, [suggestion.priority]);
  
  // Animation
  useFrame((state) => {
    if (groupRef.current) {
      // Always face camera (billboard effect for the flag group)
      // The flag should be visible from all angles
    }
    
    if (flagRef.current) {
      // Gentle wave animation for the flag
      const time = state.clock.elapsedTime;
      flagRef.current.rotation.y = Math.sin(time * 2 + suggestion.markerPosition.x) * 0.1;
      
      // Pulse when selected or hovered
      if (isSelected || hovered) {
        const pulse = 1 + Math.sin(time * 4) * 0.15;
        flagRef.current.scale.setScalar(pulse);
      } else {
        flagRef.current.scale.setScalar(1);
      }
    }
    
    // Animate the pulse ring for selected markers
    if (pulseRef.current && isSelected) {
      const time = state.clock.elapsedTime;
      const scale = 1 + Math.sin(time * 3) * 0.2;
      pulseRef.current.scale.setScalar(scale);
    }
  });
  
  const handleClick = useCallback((e: any) => {
    e.stopPropagation();
    console.log('[AISuggestionMarkers] Marker clicked:', suggestion.title);
    onSelect(suggestion);
    // Generate preview on single click
    setTimeout(() => onGeneratePreview(suggestion), 100);
  }, [suggestion, onSelect, onGeneratePreview]);
  
  const handleDoubleClick = useCallback((e: any) => {
    e.stopPropagation();
    onGeneratePreview(suggestion);
  }, [suggestion, onGeneratePreview]);
  
  // Convert Vector3 to array format for position prop
  const positionArray: [number, number, number] = useMemo(() => {
    const pos = suggestion.markerPosition;
    if (pos && typeof pos === 'object') {
      if ('x' in pos && 'y' in pos && 'z' in pos) {
        return [pos.x, pos.y, pos.z];
      } else if (Array.isArray(pos)) {
        return pos as [number, number, number];
      }
    }
    console.warn('[AISuggestionMarkers] Invalid marker position:', pos);
    return [0, 0, 0];
  }, [suggestion.markerPosition]);
  
  return (
    <group
      ref={groupRef}
      position={positionArray}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = 'auto';
      }}
    >
      {/* Flag pole */}
      <mesh position={[0, -0.3, 0]}>
        <cylinderGeometry args={[0.015, 0.02, 0.6, 8]} />
        <meshStandardMaterial
          color="#374151"
          metalness={0.9}
          roughness={0.2}
        />
      </mesh>
      
      {/* Flag body */}
      <mesh ref={flagRef} position={[0.12, 0.05, 0]}>
        <boxGeometry args={[0.24, 0.16, 0.015]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={isSelected ? 0.6 : hovered ? 0.4 : 0.15}
          transparent
          opacity={0.95}
        />
      </mesh>
      
      {/* AI indicator sparkle on the flag */}
      <mesh position={[0.18, 0.05, 0.02]}>
        <sphereGeometry args={[0.025, 8, 8]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#a855f7"
          emissiveIntensity={0.8}
          transparent
          opacity={0.9}
        />
      </mesh>
      
      {/* Priority ring around the base */}
      <mesh position={[0, -0.58, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.08, 0.12, 16]} />
        <meshBasicMaterial
          color={priorityColor}
          transparent
          opacity={0.8}
          side={THREE.DoubleSide}
        />
      </mesh>
      
      {/* Pulsing selection indicator */}
      {isSelected && (
        <mesh ref={pulseRef} position={[0, -0.58, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.15, 0.18, 32]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.5}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      
      {/* Preview loading indicator */}
      {suggestion.previewGenerating && (
        <Html
          position={[0, 0.3, 0]}
          center
          distanceFactor={8}
          style={{ pointerEvents: 'none' }}
        >
          <div className="bg-purple-600 text-white text-xs px-2 py-1 rounded animate-pulse">
            🔄 Generating preview...
          </div>
        </Html>
      )}
      
      {/* Label tooltip */}
      {(showLabel || isSelected || hovered) && !suggestion.previewGenerating && (
        <Html
          position={[0, 0.35, 0]}
          center
          distanceFactor={10}
          occlude={false}
          style={{
            pointerEvents: isSelected ? 'auto' : 'none',
            userSelect: 'none',
          }}
        >
          <div
            className={`
              px-3 py-2 rounded-lg text-white text-xs font-medium
              whitespace-nowrap shadow-xl backdrop-blur-sm
              ${isSelected ? 'ring-2 ring-white ring-opacity-50' : ''}
            `}
            style={{ 
              backgroundColor: typeInfo.color,
              minWidth: isSelected ? '180px' : 'auto',
            }}
          >
            <div className="flex items-center gap-1.5">
              <span>{typeInfo.icon}</span>
              <span className="font-semibold">{suggestion.title}</span>
              {suggestion.priority === 'high' && <span>⚠️</span>}
            </div>
            
            {isSelected && (
              <>
                <p className="text-xs opacity-90 mt-1 leading-tight">
                  {suggestion.description}
                </p>
                
                {suggestion.suggestedRenovation.estimatedCost && (
                  <div className="mt-1.5 text-xs opacity-80">
                    💰 Est. ${suggestion.suggestedRenovation.estimatedCost.low.toLocaleString()} - ${suggestion.suggestedRenovation.estimatedCost.high.toLocaleString()}
                  </div>
                )}
                
                {suggestion.suggestedRenovation.roiEstimate && (
                  <div className="text-xs text-green-200">
                    📈 {suggestion.suggestedRenovation.roiEstimate}% ROI
                  </div>
                )}
                
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onGeneratePreview(suggestion);
                  }}
                  disabled={suggestion.previewGenerating}
                  className="mt-2 w-full bg-white/20 hover:bg-white/30 text-white text-xs py-1.5 px-2 rounded transition-colors disabled:opacity-50"
                >
                  {suggestion.previewImageBase64 ? '🔄 Regenerate Preview' : '✨ Generate AI Preview'}
                </button>
              </>
            )}
          </div>
        </Html>
      )}
      
      {/* Preview available indicator */}
      {suggestion.previewImageBase64 && !isSelected && (
        <mesh position={[0.22, 0.15, 0]}>
          <sphereGeometry args={[0.03, 8, 8]} />
          <meshBasicMaterial color="#22c55e" />
        </mesh>
      )}
    </group>
  );
}

// ============================================================================
// Main Markers Container
// ============================================================================

export function AISuggestionMarkers({
  suggestions,
  selectedSuggestionId,
  onSuggestionSelect,
  onGeneratePreview,
  visible = true,
  showLabels = false,
}: AISuggestionMarkersProps) {
  if (!visible || suggestions.length === 0) {
    return null;
  }
  
  return (
    <group name="ai-suggestion-markers">
      {suggestions.map((suggestion) => (
        <SuggestionFlagMarker
          key={suggestion.id}
          suggestion={suggestion}
          isSelected={selectedSuggestionId === suggestion.id}
          onSelect={onSuggestionSelect}
          onGeneratePreview={onGeneratePreview}
          showLabel={showLabels}
        />
      ))}
    </group>
  );
}

// ============================================================================
// Preview Modal Component (2D overlay)
// ============================================================================

interface RenovationPreviewModalProps {
  suggestion: RenovationSuggestion | null;
  onClose: () => void;
  onRegeneratePreview: (suggestion: RenovationSuggestion, option: string) => void;
  renovationOptions: string[];
}

export function RenovationPreviewModal({
  suggestion,
  onClose,
  onRegeneratePreview,
  renovationOptions,
}: RenovationPreviewModalProps) {
  const [selectedOption, setSelectedOption] = useState<string>('');
  
  if (!suggestion) return null;
  
  const typeInfo = getSuggestionTypeInfo(suggestion.type);
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 rounded-xl shadow-2xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{typeInfo.icon}</span>
            <div>
              <h2 className="text-lg font-semibold text-white">{suggestion.title}</h2>
              <p className="text-sm text-gray-400">{suggestion.description}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors p-2"
          >
            ✕
          </button>
        </div>
        
        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
          {/* Before/After comparison */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            {/* Original view */}
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-2">Current State</h3>
              {suggestion.capturedImageBase64 ? (
                <img
                  src={suggestion.capturedImageBase64}
                  alt="Current state"
                  className="w-full rounded-lg border border-gray-700"
                />
              ) : (
                <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500">
                  No image captured
                </div>
              )}
            </div>
            
            {/* Preview */}
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-2">
                After Renovation {suggestion.previewGenerating && '(Generating...)'}
              </h3>
              {suggestion.previewImageBase64 ? (
                <img
                  src={suggestion.previewImageBase64}
                  alt="Renovation preview"
                  className="w-full rounded-lg border border-green-600/50"
                />
              ) : suggestion.previewGenerating ? (
                <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center">
                  <div className="text-center">
                    <div className="animate-spin text-4xl mb-2">🔄</div>
                    <p className="text-purple-400 text-sm">AI generating preview...</p>
                  </div>
                </div>
              ) : (
                <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500">
                  Click "Generate Preview" below
                </div>
              )}
            </div>
          </div>
          
          {/* Renovation options */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-300 mb-3">Renovation Options</h3>
            <div className="flex flex-wrap gap-2">
              {renovationOptions.map((option) => (
                <button
                  key={option}
                  onClick={() => setSelectedOption(option)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    selectedOption === option
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          
          {/* Cost & ROI info */}
          {suggestion.suggestedRenovation.estimatedCost && (
            <div className="bg-gray-800 rounded-lg p-4 mb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-400">Estimated Cost</p>
                  <p className="text-xl font-semibold text-white">
                    ${suggestion.suggestedRenovation.estimatedCost.low.toLocaleString()} - ${suggestion.suggestedRenovation.estimatedCost.high.toLocaleString()}
                  </p>
                </div>
                {suggestion.suggestedRenovation.roiEstimate && (
                  <div>
                    <p className="text-sm text-gray-400">Estimated ROI</p>
                    <p className="text-xl font-semibold text-green-400">
                      {suggestion.suggestedRenovation.roiEstimate}%
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => onRegeneratePreview(suggestion, selectedOption || suggestion.suggestedRenovation.renovationOption)}
            disabled={suggestion.previewGenerating}
            className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg hover:from-purple-500 hover:to-pink-500 transition-colors disabled:opacity-50"
          >
            {suggestion.previewGenerating ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin">⚙️</span>
                Generating...
              </span>
            ) : (
              '✨ Generate AI Preview'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AISuggestionMarkers;
