/**
 * Spherical Panorama Viewer
 * 
 * Immersive Google Street View-style viewer with:
 * - Equirectangular panorama on inside-out sphere
 * - Depth-based parallax effects
 * - Smooth OrbitControls navigation
 * - Click-to-measure with depth-aware raycasting
 * - Room dimension overlays
 * - VR mode support
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomDimensions } from '../types/panoramaScanner';

interface DepthMetadata {
  minDepth: number;
  maxDepth: number;
  width: number;
  height: number;
  timestamp?: string;
}

interface SphericalPanoramaViewerProps {
  equirectangular: string;
  depthPanorama?: string;
  depthMetadata?: DepthMetadata;
  pointCloud?: Array<{ position: { x: number; y: number; z: number }; color: { r: number; g: number; b: number } }>;
  roomDimensions?: RoomDimensions;
  onClose?: () => void;
}

export const SphericalPanoramaViewer: React.FC<SphericalPanoramaViewerProps> = ({
  equirectangular,
  depthPanorama,
  depthMetadata,
  pointCloud,
  roomDimensions,
  onClose
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [_renderer, setRenderer] = useState<THREE.WebGLRenderer | null>(null);
  const [scene] = useState(() => new THREE.Scene());
  const [camera] = useState(() => new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
  const [controls, setControls] = useState<OrbitControls | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showInfo, setShowInfo] = useState(true);
  const animationFrameRef = useRef<number>();
  const [measurePoints, setMeasurePoints] = useState<THREE.Vector3[]>([]);
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const measureMarkersRef = useRef<THREE.Group>(new THREE.Group());
  const measureLineRef = useRef<THREE.Line | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string>('');
  
  // Depth-based measurement refs
  const depthCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const depthContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const [hasDepthData, setHasDepthData] = useState(false);

  // Debug: Show image info on screen
  useEffect(() => {
    const isDataURL = equirectangular.startsWith('data:');
    const depthStatus = depthPanorama && depthMetadata 
      ? `Depth: ${depthMetadata.minDepth.toFixed(1)}-${depthMetadata.maxDepth.toFixed(1)}m`
      : 'Depth: N/A';
    const info = `${isDataURL ? '✓' : '✗'} ${(equirectangular.length / 1024).toFixed(0)}KB | ${depthStatus}`;
    setDebugInfo(info);
    console.log('[Panorama Viewer] Debug:', info);
  }, [equirectangular, depthPanorama, depthMetadata]);

  // Load depth panorama for measurement
  useEffect(() => {
    if (!depthPanorama || !depthMetadata) {
      console.log('[Panorama Viewer] No depth data available for measurements');
      setHasDepthData(false);
      return;
    }

    console.log('[Panorama Viewer] Loading depth panorama for measurements...');
    
    // Create offscreen canvas to sample depth values
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        depthCanvasRef.current = canvas;
        depthContextRef.current = ctx;
        setHasDepthData(true);
        console.log('[Panorama Viewer] ✅ Depth panorama loaded:', img.width, 'x', img.height);
        console.log('[Panorama Viewer] Depth range:', depthMetadata.minDepth, '-', depthMetadata.maxDepth, 'meters');
      }
    };
    img.onerror = (e) => {
      console.error('[Panorama Viewer] Failed to load depth panorama:', e);
      setHasDepthData(false);
    };
    img.src = depthPanorama;
  }, [depthPanorama, depthMetadata]);

  /**
   * Sample depth from the depth panorama at given UV coordinates
   * Returns the actual depth in meters
   */
  const sampleDepthAtUV = useCallback((u: number, v: number): number | null => {
    if (!depthCanvasRef.current || !depthContextRef.current || !depthMetadata) {
      return null;
    }
    
    const canvas = depthCanvasRef.current;
    const ctx = depthContextRef.current;
    
    // Convert UV (0-1) to pixel coordinates
    const x = Math.floor(u * canvas.width);
    const y = Math.floor(v * canvas.height);
    
    // Clamp to valid range
    const clampedX = Math.max(0, Math.min(canvas.width - 1, x));
    const clampedY = Math.max(0, Math.min(canvas.height - 1, y));
    
    // Get pixel data (RGBA)
    const pixel = ctx.getImageData(clampedX, clampedY, 1, 1).data;
    
    // Depth is encoded in grayscale (R channel is sufficient)
    // Closer = darker (0), farther = brighter (255)
    const normalized = pixel[0] / 255;
    
    // Map normalized value to actual depth range
    const depth = depthMetadata.minDepth + normalized * (depthMetadata.maxDepth - depthMetadata.minDepth);
    
    return depth;
  }, [depthMetadata]);

  /**
   * Convert a direction vector to UV coordinates for equirectangular sampling
   */
  const directionToUV = useCallback((direction: THREE.Vector3): { u: number; v: number } => {
    // Normalize the direction
    const dir = direction.clone().normalize();
    
    // Convert to spherical coordinates
    // theta = azimuth angle (around Y axis), phi = polar angle (from Y axis)
    const theta = Math.atan2(dir.x, dir.z); // -PI to PI
    const phi = Math.acos(Math.max(-1, Math.min(1, dir.y))); // 0 to PI
    
    // Convert to UV coordinates
    // u: 0 at center-back, 0.5 at center-front, wraps around
    const u = (theta + Math.PI) / (2 * Math.PI);
    // v: 0 at top, 1 at bottom
    const v = phi / Math.PI;
    
    return { u, v };
  }, []);

  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;

    // Create renderer
    const r = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false
    });
    r.setPixelRatio(window.devicePixelRatio);
    r.setSize(container.clientWidth, container.clientHeight);
    setRenderer(r);

    // Camera setup - at exact center of sphere looking outward
    camera.position.set(0, 0, 0);
    
    // Add measurement markers group to scene
    scene.add(measureMarkersRef.current);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();

    // Controls - pure rotation around camera's position (no orbiting)
    const orbitControls = new OrbitControls(camera, canvas);
    orbitControls.target.set(0, 0, -1); // Point forward (into the sphere)
    orbitControls.enableZoom = false;
    orbitControls.enablePan = false;
    orbitControls.rotateSpeed = 0.5;
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.05;
    orbitControls.minDistance = 0.1; // Force camera to stay at center
    orbitControls.maxDistance = 0.1; // Force camera to stay at center
    // Don't call update() here - let the animation loop handle it
    setControls(orbitControls);

    // Load panorama texture
    const textureLoader = new THREE.TextureLoader();
    
    console.log('[Panorama Viewer] Loading texture from:', equirectangular?.substring(0, 100));
    
    textureLoader.load(
      equirectangular,
      (texture) => {
        console.log('[Panorama Viewer] Texture loaded successfully:', texture.image.width, 'x', texture.image.height);
        
        // Ensure texture is properly configured
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        
        // Create sphere geometry (standard resolution for now)
        const sphereGeometry = new THREE.SphereGeometry(500, 60, 40);
        sphereGeometry.scale(-1, -1, 1); // Flip inside-out and flip vertically to correct orientation
        
        // TODO: Depth displacement currently disabled - need to fix algorithm to prevent mesh tearing
        // Will re-enable once we have proper vertex interpolation
        const hasPointCloud = pointCloud && Array.isArray(pointCloud) && pointCloud.length > 1000;
        if (hasPointCloud && false) { // Disabled for now
          console.log('[Panorama Viewer] Depth displacement available but disabled (', pointCloud?.length || 0, 'points)');
        }

        const sphereMaterial = new THREE.MeshBasicMaterial({
          map: texture,
          side: THREE.BackSide, // Render inside of sphere
          toneMapped: false
        });

        const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
        scene.add(sphere);
        console.log('[Panorama Viewer] Panorama sphere added to scene with', scene.children.length, 'total children');

        setLoading(false);
      },
      undefined,
      (error) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Panorama Viewer] Error loading panorama:', error);
        setLoadError(`Failed to load panorama: ${errorMessage}`);
        setLoading(false);
      }
    );

    // Handle window resize
    const handleResize = () => {
      if (!containerRef.current) return;
      
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;

      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      r.setSize(width, height);
    };

    window.addEventListener('resize', handleResize);

    // Animation loop
    function animate() {
      animationFrameRef.current = requestAnimationFrame(animate);
      orbitControls.update();
      
      // Don't reset camera position - let OrbitControls handle rotation
      // Camera stays at (0,0,0) and OrbitControls rotates it to look around
      
      r.render(scene, camera);
    }
    
    // Log initial render state
    console.log('[Panorama Viewer] Starting animation loop');
    console.log('[Panorama Viewer] Camera position:', camera.position);
    console.log('[Panorama Viewer] Scene children:', scene.children.length);
    
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      orbitControls.dispose();
      r.dispose();
    };
  }, [equirectangular, scene, camera]);

  // Toggle measurement mode
  const toggleMeasureMode = useCallback(() => {
    setMeasureMode(prev => {
      const newMode = !prev;
      // Clear measurements when exiting measure mode
      if (!newMode) {
        setMeasurePoints([]);
        setMeasureDistance(null);
        // Clear visual markers
        measureMarkersRef.current.clear();
        if (measureLineRef.current) {
          scene.remove(measureLineRef.current);
          measureLineRef.current = null;
        }
      }
      return newMode;
    });
  }, [scene]);
  
  // Handle canvas clicks for measurement with depth-aware positioning
  const handleCanvasClick = useCallback((event: MouseEvent) => {
    if (!measureMode || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    
    // Convert mouse position to normalized device coordinates (-1 to +1)
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    
    // Raycast from camera through mouse position
    raycasterRef.current.setFromCamera(mouse, camera);
    
    // Find intersections with scene objects (sphere)
    const intersects = raycasterRef.current.intersectObjects(scene.children, true);
    
    if (intersects.length > 0) {
      // Get the direction from camera to the sphere intersection
      const direction = raycasterRef.current.ray.direction.clone().normalize();
      
      // Get depth at this direction using the depth panorama
      const { u, v } = directionToUV(direction);
      const depth = sampleDepthAtUV(u, v);
      
      let point: THREE.Vector3;
      let isDepthBased = false;
      
      if (depth !== null && hasDepthData) {
        // Use actual depth for accurate measurement
        point = direction.multiplyScalar(depth);
        isDepthBased = true;
        console.log('[Panorama Viewer] Depth-based point:', depth.toFixed(2), 'm at UV:', u.toFixed(3), v.toFixed(3));
      } else {
        // Fallback to sphere intersection (less accurate)
        point = intersects[0].point.clone();
        console.log('[Panorama Viewer] Sphere-based point (no depth)');
      }
      
      // Add measurement point
      setMeasurePoints(prev => {
        const newPoints = [...prev, point];
        
        // Only keep last 2 points for distance measurement
        if (newPoints.length > 2) {
          newPoints.shift();
        }
        
        // Update visual markers - scale marker size based on depth if available
        measureMarkersRef.current.clear();
        newPoints.forEach((p, i) => {
          // Scale marker size based on distance from camera for consistent visual size
          const distanceFromCamera = p.length();
          const markerSize = isDepthBased ? Math.max(0.03, distanceFromCamera * 0.015) : 0.05;
          
          const markerGeometry = new THREE.SphereGeometry(markerSize, 16, 16);
          const markerMaterial = new THREE.MeshBasicMaterial({ 
            color: i === 0 ? 0x00ff00 : 0xff0000 
          });
          const marker = new THREE.Mesh(markerGeometry, markerMaterial);
          marker.position.copy(p);
          measureMarkersRef.current.add(marker);
        });
        
        // Draw line between points if we have 2
        if (newPoints.length === 2) {
          // Remove old line
          if (measureLineRef.current) {
            scene.remove(measureLineRef.current);
          }
          
          // Create new line
          const lineGeometry = new THREE.BufferGeometry().setFromPoints(newPoints);
          const lineMaterial = new THREE.LineBasicMaterial({ 
            color: 0xffff00, 
            linewidth: 3 
          });
          const line = new THREE.Line(lineGeometry, lineMaterial);
          measureLineRef.current = line;
          scene.add(line);
          
          // Calculate distance in meters
          const distance = newPoints[0].distanceTo(newPoints[1]);
          setMeasureDistance(distance);
          
          console.log('[Panorama Viewer] Measured distance:', distance.toFixed(2), 'm', 
            '(', (distance * 3.28084).toFixed(2), 'ft)',
            isDepthBased ? '(depth-based ✓)' : '(sphere-based, approximate)');
        } else {
          setMeasureDistance(null);
        }
        
        return newPoints;
      });
    }
  }, [measureMode, camera, scene, hasDepthData, sampleDepthAtUV, directionToUV]);
  
  // Add click event listener
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    canvas.addEventListener('click', handleCanvasClick);
    
    return () => {
      canvas.removeEventListener('click', handleCanvasClick);
    };
  }, [handleCanvasClick]);

  // Toggle info overlay
  const toggleInfo = useCallback(() => {
    setShowInfo(prev => !prev);
  }, []);

  // Reset view
  const resetView = useCallback(() => {
    if (controls) {
      controls.reset();
      camera.position.set(0, 0, 0);
      camera.rotation.set(0, 0, 0);
      camera.updateProjectionMatrix();
    }
  }, [controls, camera]);

  return (
    <div ref={containerRef} className="fixed inset-0 z-50 bg-black">
      {/* Canvas */}
      <canvas ref={canvasRef} className="w-full h-full" />

      {/* Loading overlay */}
      {loading && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-white text-lg">Loading panorama...</p>
          </div>
        </div>
      )}
      
      {/* Error overlay */}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center max-w-md px-4">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-white text-lg font-semibold mb-2">Failed to Load Panorama</p>
            <p className="text-gray-400 text-sm mb-4">{loadError}</p>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Top controls */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent p-4">
        <div className="flex items-center justify-between">
          <button
            onClick={onClose}
            className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            title="Close"
          >
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="text-center">
            <h2 className="text-white font-semibold text-lg">360° Room View</h2>
            <p className="text-yellow-400 text-xs mt-1">{debugInfo}</p>
          </div>

          <button
            onClick={toggleInfo}
            className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            title="Toggle info"
          >
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Room dimensions overlay */}
      {showInfo && roomDimensions && roomDimensions.width > 0 && (
        <div className="absolute top-20 left-4 bg-black/80 backdrop-blur-sm rounded-lg p-4 text-white max-w-sm">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
            Room Dimensions
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-white/70">Width:</span>
              <span className="font-medium">{roomDimensions.width.toFixed(2)} m ({(roomDimensions.width * 3.281).toFixed(1)} ft)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Length:</span>
              <span className="font-medium">{roomDimensions.length.toFixed(2)} m ({(roomDimensions.length * 3.281).toFixed(1)} ft)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Height:</span>
              <span className="font-medium">{roomDimensions.height.toFixed(2)} m ({(roomDimensions.height * 3.281).toFixed(1)} ft)</span>
            </div>
            <div className="border-t border-white/20 pt-2 mt-2">
              <div className="flex justify-between">
                <span className="text-white/70">Floor Area:</span>
                <span className="font-medium">{roomDimensions.floorArea.toFixed(1)} m² ({(roomDimensions.floorArea * 10.764).toFixed(0)} ft²)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/70">Volume:</span>
                <span className="font-medium">{roomDimensions.volume.toFixed(1)} m³</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Controls help */}
      {showInfo && (
        <div className="absolute top-20 right-4 bg-black/80 backdrop-blur-sm rounded-lg p-4 text-white max-w-xs">
          <h3 className="font-semibold mb-3">Controls</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <span className="text-white/70 shrink-0">🖱️ Drag:</span>
              <span>Look around</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-white/70 shrink-0">🔍 Scroll:</span>
              <span>Zoom in/out</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-white/70 shrink-0">📱 Touch:</span>
              <span>Swipe to rotate, pinch to zoom</span>
            </div>
          </div>
        </div>
      )}

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/80 to-transparent p-6">
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={resetView}
            className="px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
            title="Reset view"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Reset View
          </button>

          <button
            onClick={toggleMeasureMode}
            className={`px-6 py-3 text-white rounded-lg font-medium transition-colors flex items-center gap-2 ${
              measureMode 
                ? 'bg-yellow-600 hover:bg-yellow-700' 
                : 'bg-white/10 hover:bg-white/20'
            }`}
            title={measureMode ? "Exit measure mode" : "Click to measure distances"}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            {measureMode ? '📏 Measuring...' : 'Measure'}
          </button>
        </div>
        
        {/* Measurement display */}
        {measureMode && (
          <div className="mt-4 text-center">
            <div className="inline-block bg-yellow-500/20 backdrop-blur-sm border-2 border-yellow-500 rounded-lg px-6 py-3">
              {measurePoints.length === 0 && (
                <p className="text-yellow-100 font-medium">Click anywhere to start measuring</p>
              )}
              {measurePoints.length === 1 && (
                <p className="text-yellow-100 font-medium">Click a second point to measure distance</p>
              )}
              {measurePoints.length === 2 && measureDistance !== null && (
                <div className="space-y-1">
                  <div className="flex items-center justify-center gap-2">
                    <p className="text-yellow-100 text-sm">Distance:</p>
                    {hasDepthData && (
                      <span className="px-2 py-0.5 bg-green-500/30 text-green-300 text-xs rounded-full">
                        ✓ Depth-accurate
                      </span>
                    )}
                  </div>
                  <p className="text-white text-2xl font-bold">{(measureDistance * 3.28084).toFixed(2)} ft</p>
                  <p className="text-yellow-200 text-sm">({measureDistance.toFixed(2)} meters)</p>
                  {!hasDepthData && (
                    <p className="text-orange-300/70 text-xs mt-1">⚠️ Approximate (no depth data)</p>
                  )}
                  <p className="text-yellow-100/70 text-xs mt-2">Click to measure again</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Instructions overlay (first time) */}
      {!loading && showInfo && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="text-center text-white/60 text-sm">
            <p className="mb-2">Drag to look around • Scroll to zoom</p>
            <p className="text-xs">Click info button to hide overlays</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default SphericalPanoramaViewer;
