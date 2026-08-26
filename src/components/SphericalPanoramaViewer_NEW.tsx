/**
 * Spherical Panorama Viewer - REBUILT VERSION
 * 
 * Displays equirectangular panoramas in an immersive 360° viewer
 * with depth-aware click-to-measure functionality
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadPointCloud, PointCloudData, PointCloudLoadProgress } from '../services/pointCloudService';

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
  pointCloud?: any[];
  pointCloudFile?: string;  // Filename for chunked loading
  roomDimensions?: any;
  onClose: () => void;
}

export const SphericalPanoramaViewer: React.FC<SphericalPanoramaViewerProps> = ({
  equirectangular,
  depthPanorama,
  depthMetadata,
  pointCloud,
  pointCloudFile,
  roomDimensions,
  onClose
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationIdRef = useRef<number | null>(null);
  const sphereRef = useRef<THREE.Mesh | null>(null);
  const pointCloudRef = useRef<THREE.Points | null>(null);
  
  // Depth-based measurement refs
  const depthCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const depthContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const [hasDepthData, setHasDepthData] = useState(false);
  
  const [isLoading, setIsLoading] = useState(true);
  const [showDimensions, setShowDimensions] = useState(true); // Show dimensions by default
  const [showPointCloud, setShowPointCloud] = useState(false); // HIDE point cloud so panorama is visible
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<THREE.Vector3[]>([]);
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);
  
  // Point cloud loading state
  const [loadedPointCloud, setLoadedPointCloud] = useState<PointCloudData | null>(null);
  const [pointCloudLoadProgress, setPointCloudLoadProgress] = useState<PointCloudLoadProgress | null>(null);
  const [isLoadingPointCloud, setIsLoadingPointCloud] = useState(false);

  // Load point cloud from file in background
  useEffect(() => {
    if (!pointCloudFile || loadedPointCloud) return;
    
    console.log('[Viewer] Starting chunked point cloud load:', pointCloudFile);
    setIsLoadingPointCloud(true);
    
    loadPointCloud(pointCloudFile, (progress) => {
      setPointCloudLoadProgress(progress);
    })
      .then((data) => {
        console.log(`[Viewer] Point cloud loaded: ${data.loaded.toLocaleString()} points`);
        setLoadedPointCloud(data);
        setIsLoadingPointCloud(false);
      })
      .catch((error) => {
        console.error('[Viewer] Failed to load point cloud:', error);
        setIsLoadingPointCloud(false);
      });
  }, [pointCloudFile, loadedPointCloud]);

  // Add loaded point cloud to scene when it finishes loading
  useEffect(() => {
    if (!loadedPointCloud || !sceneRef.current) return;
    
    console.log('[Viewer] Rendering loaded point cloud:', loadedPointCloud.loaded.toLocaleString(), 'points');
    
    // Remove existing point cloud if any
    if (pointCloudRef.current) {
      sceneRef.current.remove(pointCloudRef.current);
      pointCloudRef.current.geometry.dispose();
      (pointCloudRef.current.material as THREE.PointsMaterial).dispose();
    }
    
    const points = loadedPointCloud.points;
    const colors = loadedPointCloud.colors;
    
    // Limit to 5M points for GPU rendering (downsample larger clouds)
    // WebGL can handle ~5M points efficiently with instanced rendering
    const maxPoints = 5000000;
    const step = points.length > maxPoints ? Math.ceil(points.length / maxPoints) : 1;
    const actualPoints = step > 1 ? Math.floor(points.length / step) : points.length;
    
    console.log(`[Viewer] Rendering ${actualPoints.toLocaleString()} points (step=${step})`);
    
    const positions = new Float32Array(actualPoints * 3);
    const colorData = new Float32Array(actualPoints * 3);
    
    for (let i = 0, j = 0; i < points.length && j < actualPoints; i += step, j++) {
      const p = points[i];
      positions[j * 3] = p[0];
      positions[j * 3 + 1] = p[1];
      positions[j * 3 + 2] = p[2];
      
      if (colors[i]) {
        colorData[j * 3] = colors[i][0];
        colorData[j * 3 + 1] = colors[i][1];
        colorData[j * 3 + 2] = colors[i][2];
      } else {
        colorData[j * 3] = 1;
        colorData[j * 3 + 1] = 1;
        colorData[j * 3 + 2] = 1;
      }
    }
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorData, 3));
    
    const material = new THREE.PointsMaterial({
      size: 0.02,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9
    });
    
    const pointsObject = new THREE.Points(geometry, material);
    pointsObject.visible = showPointCloud;
    pointCloudRef.current = pointsObject;
    sceneRef.current.add(pointsObject);
    
    console.log('[Viewer] ✅ Loaded point cloud added to scene');
  }, [loadedPointCloud, showPointCloud]);

  // Load depth panorama for measurement
  useEffect(() => {
    if (!depthPanorama || !depthMetadata) {
      console.log('[Viewer] No depth data available for measurements');
      setHasDepthData(false);
      return;
    }

    console.log('[Viewer] Loading depth panorama for measurements...');
    
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
        console.log('[Viewer] ✅ Depth panorama loaded:', img.width, 'x', img.height);
        console.log('[Viewer] Depth range:', depthMetadata.minDepth, '-', depthMetadata.maxDepth, 'meters');
      }
    };
    img.onerror = (e) => {
      console.error('[Viewer] Failed to load depth panorama:', e);
      setHasDepthData(false);
    };
    img.src = depthPanorama;
  }, [depthPanorama, depthMetadata]);

  /**
   * Sample depth from the depth panorama at given UV coordinates
   */
  const sampleDepthAtUV = useCallback((u: number, v: number): number | null => {
    if (!depthCanvasRef.current || !depthContextRef.current || !depthMetadata) {
      return null;
    }
    
    const canvas = depthCanvasRef.current;
    const ctx = depthContextRef.current;
    
    const x = Math.floor(u * canvas.width);
    const y = Math.floor(v * canvas.height);
    const clampedX = Math.max(0, Math.min(canvas.width - 1, x));
    const clampedY = Math.max(0, Math.min(canvas.height - 1, y));
    
    const pixel = ctx.getImageData(clampedX, clampedY, 1, 1).data;
    const normalized = pixel[0] / 255;
    const depth = depthMetadata.minDepth + normalized * (depthMetadata.maxDepth - depthMetadata.minDepth);
    
    return depth;
  }, [depthMetadata]);

  /**
   * Convert direction vector to UV coordinates for equirectangular sampling
   */
  const directionToUV = useCallback((direction: THREE.Vector3): { u: number; v: number } => {
    const dir = direction.clone().normalize();
    const theta = Math.atan2(dir.x, dir.z);
    const phi = Math.acos(Math.max(-1, Math.min(1, dir.y)));
    
    const u = (theta + Math.PI) / (2 * Math.PI);
    const v = phi / Math.PI;
    
    return { u, v };
  }, []);

  // Initialize Three.js
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) {
      console.error('[Viewer] Missing container or canvas');
      return;
    }

    console.log('[Viewer] 🚀 INITIALIZING');
    console.log('[Viewer] Equirectangular length:', equirectangular?.length);
    console.log('[Viewer] First 100 chars:', equirectangular?.substring(0, 100));

    const container = containerRef.current;
    const canvas = canvasRef.current;

    // Create scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    sceneRef.current = scene;
    console.log('[Viewer] ✅ Scene created');

    // Create camera
    const camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      2000
    );
    camera.position.set(0, 0, 0.1);
    cameraRef.current = camera;
    console.log('[Viewer] ✅ Camera created at:', camera.position.toArray());

    // Create renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendererRef.current = renderer;
    console.log('[Viewer] ✅ Renderer created:', container.clientWidth, 'x', container.clientHeight);

    // Create controls
    const controls = new OrbitControls(camera, canvas);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.rotateSpeed = -0.3;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance = 0.1;
    controls.maxDistance = 0.1;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;
    console.log('[Viewer] ✅ Controls created');

    // Load texture
    const loader = new THREE.TextureLoader();
    console.log('[Viewer] 📥 Loading texture...');
    
    loader.load(
      equirectangular,
      // Success
      (texture) => {
        console.log('[Viewer] ✅ TEXTURE LOADED:', texture.image.width, 'x', texture.image.height);
        
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;

        // Create sphere
        const geometry = new THREE.SphereGeometry(500, 64, 64);
        geometry.scale(-1, -1, 1); // Flip inside-out and flip vertically to correct ceiling/floor orientation
        
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          side: THREE.BackSide, // BackSide because we're inside the sphere
          toneMapped: false
        });
        
        const sphere = new THREE.Mesh(geometry, material);
        sphereRef.current = sphere;
        scene.add(sphere);
        
        console.log('[Viewer] ✅ SPHERE ADDED TO SCENE');
        console.log('[Viewer] Scene children:', scene.children.length);
        console.log('[Viewer] Scene children:', scene.children.map((c: any) => c.type));
        
        // Add point cloud if available (from props or loaded from file)
        const pcData = pointCloud && pointCloud.length > 0 ? pointCloud : null;
        
        if (pcData) {
          console.log('[Viewer] Adding point cloud with', pcData.length, 'points');
          
          const positions = new Float32Array(pcData.length * 3);
          const colors = new Float32Array(pcData.length * 3);
          
          pcData.forEach((point: any, i: number) => {
            // Position
            positions[i * 3] = point.x || 0;
            positions[i * 3 + 1] = point.y || 0;
            positions[i * 3 + 2] = point.z || 0;
            
            // Color (from RGB or default white)
            colors[i * 3] = (point.r || 255) / 255;
            colors[i * 3 + 1] = (point.g || 255) / 255;
            colors[i * 3 + 2] = (point.b || 255) / 255;
          });
          
          const pointGeometry = new THREE.BufferGeometry();
          pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          pointGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          
          const pointMaterial = new THREE.PointsMaterial({
            size: 0.05,
            vertexColors: true,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.8
          });
          
          const points = new THREE.Points(pointGeometry, pointMaterial);
          pointCloudRef.current = points;
          scene.add(points);
          
          console.log('[Viewer] ✅ POINT CLOUD ADDED TO SCENE');
        } else {
          console.log('[Viewer] No point cloud data available (will load from file if available)');
        }
        
        setIsLoading(false);
      },
      // Progress
      (progress) => {
        const percent = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
        console.log('[Viewer] Loading progress:', percent, '%');
      },
      // Error
      (error) => {
        console.error('[Viewer] ❌ TEXTURE LOAD ERROR:', error);
        setIsLoading(false);
      }
    );

    // Animation loop
    let frameCount = 0;
    function animate() {
      animationIdRef.current = requestAnimationFrame(animate);
      
      controls.update();
      renderer.render(scene, camera);
      
      if (frameCount % 120 === 0) {
        console.log('[Viewer] 🔄 Frame', frameCount, '- Camera:', camera.position.toArray().map(n => n.toFixed(2)));
      }
      frameCount++;
    }

    console.log('[Viewer] 🎬 STARTING ANIMATION LOOP');
    animate();

    // Resize handler
    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      
      console.log('[Viewer] Resized:', width, 'x', height);
    };

    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      console.log('[Viewer] 🧹 Cleaning up');
      
      window.removeEventListener('resize', handleResize);
      
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
      
      controls.dispose();
      renderer.dispose();
      
      if (sphereRef.current) {
        sphereRef.current.geometry.dispose();
        if (sphereRef.current.material instanceof THREE.Material) {
          sphereRef.current.material.dispose();
        }
      }
    };
  }, [equirectangular]);

  /**
   * Find the nearest point in the loaded point cloud to a ray direction
   * Uses angular distance for more accurate matching on spherical projection
   */
  const findNearestPointOnRay = useCallback((direction: THREE.Vector3): { point: THREE.Vector3; distance: number } | null => {
    if (!loadedPointCloud || loadedPointCloud.points.length === 0) return null;
    
    const points = loadedPointCloud.points;
    let bestPoint: THREE.Vector3 | null = null;
    let bestAngularDist = Infinity;
    let bestDepth = 0;
    
    // Normalize direction
    const dirNorm = direction.clone().normalize();
    
    // For very large point clouds, sample for performance
    const sampleStep = points.length > 5000000 ? Math.ceil(points.length / 5000000) : 1;
    
    for (let i = 0; i < points.length; i += sampleStep) {
      const p = points[i];
      const px = p[0], py = p[1], pz = p[2];
      
      // Calculate point direction from origin
      const pointDist = Math.sqrt(px*px + py*py + pz*pz);
      if (pointDist < 0.01) continue; // Skip points too close to origin
      
      // Normalize point direction
      const pdx = px / pointDist;
      const pdy = py / pointDist;
      const pdz = pz / pointDist;
      
      // Angular distance (dot product = cos(angle))
      const dot = dirNorm.x * pdx + dirNorm.y * pdy + dirNorm.z * pdz;
      const angularDist = Math.acos(Math.min(1, Math.max(-1, dot))); // In radians
      
      // Within ~2 degrees cone (0.035 radians)
      if (angularDist < 0.035 && angularDist < bestAngularDist) {
        bestAngularDist = angularDist;
        bestPoint = new THREE.Vector3(px, py, pz);
        bestDepth = pointDist;
      }
    }
    
    if (bestPoint) {
      console.log(`[Viewer] Found point cloud hit: ${bestDepth.toFixed(2)}m, angular dist: ${(bestAngularDist * 180 / Math.PI).toFixed(2)}°`);
      return { point: bestPoint, distance: bestDepth };
    }
    
    return null;
  }, [loadedPointCloud]);

  // Measurement functionality with depth-aware positioning
  const handleCanvasClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!measureMode || !canvasRef.current || !cameraRef.current || !sceneRef.current) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, cameraRef.current);
    
    // Get ray direction for depth sampling
    const direction = raycaster.ray.direction.clone().normalize();
    
    let point: THREE.Vector3;
    let measureSource = 'sphere';
    
    // Priority 1: Try loaded point cloud (most accurate with 27M points)
    const pcHit = findNearestPointOnRay(direction);
    if (pcHit) {
      point = pcHit.point;
      measureSource = 'pointcloud';
      console.log('[Viewer] ✓ Point cloud hit:', pcHit.distance.toFixed(2), 'm');
    } else {
      // Priority 2: Try depth panorama
      const { u, v } = directionToUV(direction);
      const depth = sampleDepthAtUV(u, v);
      
      if (depth !== null && hasDepthData) {
        point = direction.clone().multiplyScalar(depth);
        measureSource = 'depth';
        console.log('[Viewer] ✓ Depth-based point:', depth.toFixed(2), 'm at UV:', u.toFixed(3), v.toFixed(3));
      } else {
        // Priority 3: Fall back to sphere mesh raycasting
        const intersects = raycaster.intersectObjects(sceneRef.current.children);
        
        if (intersects.length > 0) {
          point = intersects[0].point.clone();
          measureSource = 'sphere';
          console.log('[Viewer] Sphere-based point (no depth/pointcloud data)');
        } else {
          return; // No intersection found
        }
      }
    }
    
    console.log('[Viewer] Clicked point:', point.toArray().map(n => n.toFixed(2)), `(source: ${measureSource})`);
      
    setMeasurePoints(prev => {
      const newPoints = [...prev, point];
        
      if (newPoints.length === 2) {
        const distance = newPoints[0].distanceTo(newPoints[1]);
        setMeasureDistance(distance);
        const sourceLabel = measureSource === 'pointcloud' ? '(point cloud ✓✓)' : 
                           measureSource === 'depth' ? '(depth-based ✓)' : '(approximate)';
        console.log('[Viewer] Measured distance:', distance.toFixed(2), 'm',
          '(', (distance * 3.28084).toFixed(2), 'ft)', sourceLabel);
      }
        
      if (newPoints.length > 2) {
        setMeasureDistance(null);
        return [point];
      }
        
      return newPoints;
    });
  }, [measureMode, hasDepthData, sampleDepthAtUV, directionToUV, findNearestPointOnRay]);
  
  // Toggle point cloud visibility
  useEffect(() => {
    if (pointCloudRef.current) {
      pointCloudRef.current.visible = showPointCloud;
      console.log('[Viewer] Point cloud visibility:', showPointCloud);
    }
  }, [showPointCloud]);

  return (
    <div ref={containerRef} className="fixed inset-0 bg-black z-50">
      {/* Canvas */}
      <canvas 
        ref={canvasRef} 
        className="w-full h-full"
        onClick={handleCanvasClick}
        style={{ cursor: measureMode ? 'crosshair' : 'grab' }}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center text-white">
            <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-lg font-medium">Loading Panorama...</p>
            <p className="text-sm text-gray-400 mt-2">Processing {(equirectangular?.length / 1024).toFixed(0)} KB</p>
          </div>
        </div>
      )}

      {/* Controls */}
      {!isLoading && (
        <div className="absolute top-4 right-4 flex flex-col gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white/90 hover:bg-white text-gray-900 rounded-lg font-medium shadow-lg transition-colors flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Close
          </button>
          
          <button
            onClick={() => setMeasureMode(!measureMode)}
            className={`px-4 py-2 rounded-lg font-medium shadow-lg transition-colors flex items-center gap-2 ${
              measureMode 
                ? 'bg-blue-600 text-white' 
                : 'bg-white/90 hover:bg-white text-gray-900'
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            {measureMode ? 'Measuring...' : 'Measure'}
          </button>

          {(pointCloud && pointCloud.length > 0) || loadedPointCloud ? (
            <button
              onClick={() => setShowPointCloud(!showPointCloud)}
              className={`px-4 py-2 rounded-lg font-medium shadow-lg transition-colors flex items-center gap-2 ${
                showPointCloud 
                  ? 'bg-purple-600 text-white' 
                  : 'bg-white/90 hover:bg-white text-gray-900'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
              </svg>
              3D Depth {loadedPointCloud ? `(${(loadedPointCloud.loaded / 1000000).toFixed(1)}M pts)` : ''}
            </button>
          ) : isLoadingPointCloud ? (
            <div className="px-4 py-2 bg-white/90 text-gray-700 rounded-lg font-medium shadow-lg flex items-center gap-2">
              <div className="animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full" />
              Loading 3D... {pointCloudLoadProgress?.percentage || 0}%
            </div>
          ) : null}
          
          {roomDimensions && (
            <button
              onClick={() => setShowDimensions(!showDimensions)}
              className="px-4 py-2 bg-white/90 hover:bg-white text-gray-900 rounded-lg font-medium shadow-lg transition-colors flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              Dimensions
            </button>
          )}
        </div>
      )}

      {/* Measurement display */}
      {measureDistance !== null && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 px-6 py-3 bg-white/95 text-gray-900 rounded-lg font-medium shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-gray-600 text-sm">Distance:</span>
            {hasDepthData && (
              <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-medium">
                ✓ Depth-accurate
              </span>
            )}
            {!hasDepthData && (
              <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full font-medium">
                ⚠ Approximate
              </span>
            )}
          </div>
          <div className="text-center">
            <span className="text-2xl font-bold">{(measureDistance * 3.28084).toFixed(2)} ft</span>
            <span className="text-gray-500 text-sm ml-2">({measureDistance.toFixed(2)} m)</span>
          </div>
        </div>
      )}

      {/* Room dimensions */}
      {showDimensions && roomDimensions && (
        <div className="absolute bottom-4 left-4 bg-white/95 rounded-lg p-4 shadow-xl max-w-sm backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <h3 className="font-bold text-gray-900">Room Dimensions</h3>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-600">Width:</span>
              <span className="font-semibold text-gray-900">
                {roomDimensions.width?.toFixed(2)} m ({(roomDimensions.width * 3.28084)?.toFixed(1)} ft)
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-600">Length:</span>
              <span className="font-semibold text-gray-900">
                {roomDimensions.length?.toFixed(2)} m ({(roomDimensions.length * 3.28084)?.toFixed(1)} ft)
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-600">Height:</span>
              <span className="font-semibold text-gray-900">
                {roomDimensions.height?.toFixed(2)} m ({(roomDimensions.height * 3.28084)?.toFixed(1)} ft)
              </span>
            </div>
            <div className="border-t border-gray-200 pt-2 mt-2">
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-600">Floor Area:</span>
                <span className="font-semibold text-gray-900">
                  {roomDimensions.floorArea?.toFixed(1)} m² ({(roomDimensions.floorArea * 10.764)?.toFixed(0)} sq ft)
                </span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-600">Volume:</span>
                <span className="font-semibold text-gray-900">
                  {roomDimensions.volume?.toFixed(1)} m³ ({(roomDimensions.volume * 35.315)?.toFixed(0)} cu ft)
                </span>
              </div>
            </div>
            {roomDimensions.confidence && (
              <div className="mt-2 pt-2 border-t border-gray-200">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-500">Confidence:</span>
                  <div className="flex-1 bg-gray-200 rounded-full h-2 overflow-hidden">
                    <div 
                      className="h-full bg-green-500 rounded-full transition-all"
                      style={{ width: `${roomDimensions.confidence * 100}%` }}
                    />
                  </div>
                  <span className="text-gray-700 font-medium">{(roomDimensions.confidence * 100).toFixed(0)}%</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Instructions */}
      {!isLoading && measurePoints.length === 0 && (
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 text-center text-white/80 text-sm">
          {measureMode 
            ? (
              <div className="flex flex-col items-center gap-1">
                <span>Click two points to measure distance</span>
                {loadedPointCloud && (
                  <span className="text-green-400 text-xs font-medium">
                    ✓ Using {(loadedPointCloud.loaded / 1000000).toFixed(1)}M point cloud for accuracy
                  </span>
                )}
              </div>
            )
            : 'Drag to look around • Pinch to zoom on mobile'
          }
        </div>
      )}
    </div>
  );
};

export default SphericalPanoramaViewer;
