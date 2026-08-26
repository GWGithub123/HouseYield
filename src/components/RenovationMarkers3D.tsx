/**
 * RenovationMarkers3D Component
 * 
 * Renders interactive 3D markers (flags/pins) on the photogrammetry mesh
 * for detected renovation opportunities. Clicking a marker shows details.
 */

import { useRef, useState, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { DetectedRenovation } from '../types/renovationDetection';
import { getRenovationColor, getRenovationIcon } from '../types/renovationDetection';

// ============================================================================
// Types
// ============================================================================

interface RenovationMarkers3DProps {
  renovations: DetectedRenovation[];
  selectedId: string | null;
  onSelect: (renovationId: string) => void;
  visible?: boolean;
  showLabels?: boolean;
}

interface SingleMarkerProps {
  renovation: DetectedRenovation;
  isSelected: boolean;
  onSelect: (id: string) => void;
  showLabel: boolean;
}

// ============================================================================
// Animated Flag Marker
// ============================================================================

function FlagMarker({ 
  renovation, 
  isSelected, 
  onSelect, 
  showLabel 
}: SingleMarkerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const flagRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  
  // Get color based on renovation type
  const color = useMemo(() => getRenovationColor(renovation.zone.type), [renovation.zone.type]);
  const icon = useMemo(() => getRenovationIcon(renovation.zone.type), [renovation.zone.type]);
  
  // Position from zone data
  const position = useMemo(() => {
    const pos = renovation.zone.markerPosition;
    return new THREE.Vector3(pos.x, pos.y, pos.z);
  }, [renovation.zone.markerPosition]);
  
  // Animate the flag
  useFrame((state) => {
    if (flagRef.current) {
      // Gentle wave animation
      const time = state.clock.elapsedTime;
      flagRef.current.rotation.y = Math.sin(time * 2 + position.x) * 0.1;
      
      // Pulse when selected or hovered
      if (isSelected || hovered) {
        const pulse = 1 + Math.sin(time * 4) * 0.1;
        flagRef.current.scale.setScalar(pulse);
      } else {
        flagRef.current.scale.setScalar(1);
      }
    }
    
    // Make label always face camera (billboarding is handled by Html)
  });
  
  // Priority indicator
  const priorityRing = useMemo(() => {
    if (renovation.analysis.urgency === 'immediate') return '#ef4444'; // red
    if (renovation.analysis.urgency === 'short-term') return '#f97316'; // orange
    return null;
  }, [renovation.analysis.urgency]);
  
  return (
    <group 
      ref={groupRef} 
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(renovation.id);
      }}
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
      <mesh position={[0, -0.25, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.5, 8]} />
        <meshStandardMaterial 
          color="#374151" 
          metalness={0.8}
          roughness={0.3}
        />
      </mesh>
      
      {/* Flag body */}
      <mesh ref={flagRef} position={[0.15, 0.1, 0]}>
        <boxGeometry args={[0.3, 0.2, 0.02]} />
        <meshStandardMaterial 
          color={color} 
          emissive={color}
          emissiveIntensity={isSelected ? 0.5 : hovered ? 0.3 : 0.1}
          transparent
          opacity={0.9}
        />
      </mesh>
      
      {/* Priority ring (for urgent items) */}
      {priorityRing && (
        <mesh position={[0, 0.35, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.12, 0.15, 16]} />
          <meshBasicMaterial 
            color={priorityRing} 
            transparent 
            opacity={0.8}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      
      {/* Selection indicator */}
      {isSelected && (
        <mesh position={[0, -0.55, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.15, 0.2, 32]} />
          <meshBasicMaterial 
            color={color} 
            transparent 
            opacity={0.6}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      
      {/* HTML Label */}
      {(showLabel || isSelected || hovered) && (
        <Html
          position={[0, 0.4, 0]}
          center
          distanceFactor={10}
          occlude={false}
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          <div 
            className={`
              px-2 py-1 rounded-lg text-white text-xs font-medium
              whitespace-nowrap shadow-lg
              ${isSelected ? 'ring-2 ring-white' : ''}
            `}
            style={{ backgroundColor: color }}
          >
            <span className="mr-1">{icon}</span>
            {renovation.zone.name}
            {renovation.analysis.urgency === 'immediate' && (
              <span className="ml-1 text-red-200">⚠️</span>
            )}
          </div>
        </Html>
      )}
      
      {/* ROI Badge */}
      {(isSelected || hovered) && (
        <Html
          position={[0.35, 0.1, 0]}
          center
          distanceFactor={10}
          occlude={false}
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          <div className="bg-green-600 text-white text-xs px-1.5 py-0.5 rounded font-bold">
            {renovation.roi.roi.toFixed(0)}% ROI
          </div>
        </Html>
      )}
    </group>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function RenovationMarkers3D({
  renovations,
  selectedId,
  onSelect,
  visible = true,
  showLabels = true,
}: RenovationMarkers3DProps) {
  if (!visible || renovations.length === 0) {
    return null;
  }
  
  return (
    <group name="renovation-markers">
      {renovations.map((renovation) => (
        <FlagMarker
          key={renovation.id}
          renovation={renovation}
          isSelected={selectedId === renovation.id}
          onSelect={onSelect}
          showLabel={showLabels}
        />
      ))}
    </group>
  );
}

// ============================================================================
// Zone Highlighter Component
// ============================================================================

interface RenovationZoneHighlighterProps {
  renovations: DetectedRenovation[];
  selectedId: string | null;
  visible?: boolean;
  opacity?: number;
}

/**
 * Renders semi-transparent bounding boxes to highlight renovation zones
 */
export function RenovationZoneHighlighter({
  renovations,
  selectedId,
  visible = true,
  opacity = 0.15,
}: RenovationZoneHighlighterProps) {
  if (!visible) return null;
  
  return (
    <group name="renovation-zones">
      {renovations.map((renovation) => {
        const { boundingBox } = renovation.zone;
        const color = getRenovationColor(renovation.zone.type);
        const isSelected = selectedId === renovation.id;
        
        // Calculate dimensions from bounding box
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
          <group key={renovation.id} position={center}>
            {/* Filled box */}
            <mesh>
              <boxGeometry args={[size.x, size.y, size.z]} />
              <meshBasicMaterial 
                color={color}
                transparent
                opacity={isSelected ? opacity * 2 : opacity}
                side={THREE.BackSide}
              />
            </mesh>
            
            {/* Wireframe outline */}
            <mesh>
              <boxGeometry args={[size.x, size.y, size.z]} />
              <meshBasicMaterial 
                color={color}
                wireframe
                transparent
                opacity={isSelected ? 0.8 : 0.4}
              />
            </mesh>
            
            {/* Selection glow effect */}
            {isSelected && (
              <mesh>
                <boxGeometry args={[size.x + 0.1, size.y + 0.1, size.z + 0.1]} />
                <meshBasicMaterial 
                  color={color}
                  transparent
                  opacity={0.1}
                  side={THREE.BackSide}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ============================================================================
// Combined Overlay Component
// ============================================================================

interface RenovationOverlayProps {
  renovations: DetectedRenovation[];
  selectedRenovationId: string | null;
  hoveredRenovationId?: string | null;
  onRenovationClick: (renovation: DetectedRenovation) => void;
  onRenovationHover?: (renovationId: string | null) => void;
  showMarkers?: boolean;
  showZones?: boolean;
  showLabels?: boolean;
}

export function RenovationOverlay({
  renovations,
  selectedRenovationId,
  hoveredRenovationId: _hoveredRenovationId,
  onRenovationClick,
  onRenovationHover: _onRenovationHover,
  showMarkers = true,
  showZones = true,
  showLabels = true,
}: RenovationOverlayProps) {
  // Handler to convert ID-based selection to full renovation object
  const handleSelect = (renovationId: string) => {
    const renovation = renovations.find(r => r.id === renovationId);
    if (renovation) {
      onRenovationClick(renovation);
    }
  };
  
  return (
    <>
      {showZones && (
        <RenovationZoneHighlighter
          renovations={renovations}
          selectedId={selectedRenovationId}
          visible={true}
        />
      )}
      {showMarkers && (
        <RenovationMarkers3D
          renovations={renovations}
          selectedId={selectedRenovationId}
          onSelect={handleSelect}
          showLabels={showLabels}
        />
      )}
    </>
  );
}

export default RenovationMarkers3D;
