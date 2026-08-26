/**
 * Cubemap Room Viewer
 * 
 * Simple 6-sided cube panorama viewer with optional depth-based 3D effect.
 * User captures 6 photos (front, back, left, right, up, down)
 * and we display them on an inside-out cube for 360° viewing.
 * 
 * When depth maps are available, uses displacement mapping for parallax effect.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';

export interface CubemapFaces {
  front: string;   // What you see first
  back: string;    // Behind you
  left: string;    // To your left
  right: string;   // To your right
  up: string;      // Ceiling
  down: string;    // Floor
}

export interface DepthMaps {
  front?: string;
  back?: string;
  left?: string;
  right?: string;
  up?: string;
  down?: string;
}

interface CubemapViewerProps {
  faces: CubemapFaces;
  depthMaps?: DepthMaps;
  roomName?: string;
  onClose?: () => void;
  enableGyroscope?: boolean;
  enableDepth?: boolean;
  onRequestDepth?: () => void;
}

const CubemapViewer: React.FC<CubemapViewerProps> = ({
  faces,
  depthMaps,
  roomName = 'Room View',
  onClose,
  enableGyroscope = true,
  enableDepth = false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onRequestDepth
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const meshesRef = useRef<THREE.Mesh[]>([]);
  const animationFrameRef = useRef<number>(0);
  
  // Interaction state
  const isDraggingRef = useRef(false);
  const previousMouseRef = useRef({ x: 0, y: 0 });
  const rotationRef = useRef({ lon: 0, lat: 0 });
  const targetRotationRef = useRef({ lon: 0, lat: 0 });
  
  const [isLoading, setIsLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [isGyroActive, setIsGyroActive] = useState(false);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);

  // Custom shader for depth displacement
  const depthVertexShader = `
    uniform sampler2D depthMap;
    uniform float displacementScale;
    uniform float hasDepth;
    
    varying vec2 vUv;
    varying float vDepth;
    
    void main() {
      vUv = uv;
      
      vec3 newPosition = position;
      
      if (hasDepth > 0.5) {
        // Sample depth - depth maps are grayscale where white = far, black = near
        float depth = texture2D(depthMap, uv).r;
        vDepth = depth;
        
        // Displace along normal (inward for backside rendering)
        // Invert because we're inside the cube looking out
        newPosition -= normal * depth * displacementScale;
      }
      
      gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
    }
  `;
  
  const depthFragmentShader = `
    uniform sampler2D colorMap;
    uniform float hasDepth;
    
    varying vec2 vUv;
    varying float vDepth;
    
    void main() {
      vec4 color = texture2D(colorMap, vUv);
      
      // Optional: subtle depth-based darkening for more 3D feel
      if (hasDepth > 0.5) {
        float shadow = mix(0.85, 1.0, vDepth);
        color.rgb *= shadow;
      }
      
      gl_FragColor = color;
    }
  `;

  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current) return;
    
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Create scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    
    // Create camera
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 0, 0);
    cameraRef.current = camera;
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    
    // Load textures and create faces
    const textureLoader = new THREE.TextureLoader();
    const loadedTextures: THREE.Texture[] = [];
    const loadedDepthTextures: THREE.Texture[] = [];
    let loadedCount = 0;
    const totalToLoad = 6 + (depthMaps ? Object.keys(depthMaps).filter(k => depthMaps[k as keyof DepthMaps]).length : 0);
    
    // Face configurations: position, rotation, and data key
    // Using DoubleSide rendering with simpler rotations
    const faceConfigs: Array<{
      key: keyof CubemapFaces;
      position: [number, number, number];
      rotation: [number, number, number];
    }> = [
      { key: 'right', position: [50, 0, 0], rotation: [0, -Math.PI / 2, 0] },
      { key: 'left', position: [-50, 0, 0], rotation: [0, Math.PI / 2, 0] },
      { key: 'up', position: [0, 50, 0], rotation: [Math.PI / 2, 0, 0] },
      { key: 'down', position: [0, -50, 0], rotation: [-Math.PI / 2, 0, 0] },
      { key: 'front', position: [0, 0, 50], rotation: [0, 0, 0] },
      { key: 'back', position: [0, 0, -50], rotation: [0, Math.PI, 0] }
    ];

    const meshes: THREE.Mesh[] = [];
    
    faceConfigs.forEach((config) => {
      const faceData = faces[config.key];
      const depthData = depthMaps?.[config.key];
      
      console.log(`[CubemapViewer] Loading face: ${config.key}`);
      console.log(`[CubemapViewer] Face data exists: ${!!faceData}`);
      console.log(`[CubemapViewer] Face data length: ${faceData?.length || 0}`);
      console.log(`[CubemapViewer] Starts with data:: ${faceData?.startsWith('data:')}`);
      console.log(`[CubemapViewer] First 100 chars: ${faceData?.substring(0, 100)}`);
      
      if (!faceData || faceData.length < 100) {
        console.error(`[CubemapViewer] ❌ SKIPPING ${config.key} - Invalid or missing face data`);
        setLoadErrors(prev => [...prev, `${config.key} (no data)`]);
        loadedCount++;
        if (loadedCount >= 6) {
          setIsLoading(false);
        }
        return;
      }
      
      // Ensure we have proper data URI format
      let imageUrl = faceData;
      if (!faceData.startsWith('data:')) {
        // If it's just base64 without data URI prefix, add it
        imageUrl = `data:image/jpeg;base64,${faceData}`;
      }
      
      // Load color texture
      const colorTexture = textureLoader.load(
        imageUrl,
        (texture) => {
          console.log(`[CubemapViewer] ✅ Loaded face ${config.key} successfully`);
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / Math.max(totalToLoad, 6)) * 100));
          if (loadedCount >= 6) {
            setIsLoading(false);
          }
        },
        undefined,
        (err) => {
          console.error(`[CubemapViewer] ❌ Failed to load face ${config.key}:`, err);
          console.error(`[CubemapViewer] Image URL was: ${imageUrl.substring(0, 100)}...`);
          
          setLoadErrors(prev => [...prev, config.key]);
          
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / Math.max(totalToLoad, 6)) * 100));
          
          // Still mark as loaded to prevent infinite loading
          if (loadedCount >= 6) {
            setIsLoading(false);
          }
        }
      );
      colorTexture.colorSpace = THREE.SRGBColorSpace;
      loadedTextures.push(colorTexture);
      
      // Load depth texture if available
      let depthTexture: THREE.Texture | null = null;
      if (depthData) {
        depthTexture = textureLoader.load(
          depthData.startsWith('data:') ? depthData : depthData.startsWith('http') ? depthData : `data:image/png;base64,${depthData}`,
          () => {
            loadedCount++;
            setLoadProgress(Math.round((loadedCount / totalToLoad) * 100));
          }
        );
        loadedDepthTextures.push(depthTexture);
      }
      
      // Create high-poly plane geometry for displacement
      // More segments = smoother depth displacement
      const segments = enableDepth && depthData ? 64 : 1;
      const geometry = new THREE.PlaneGeometry(100, 100, segments, segments);
      
      // Create material based on whether we have depth
      let material: THREE.Material;
      
      if (enableDepth && depthTexture) {
        material = new THREE.ShaderMaterial({
          uniforms: {
            colorMap: { value: colorTexture },
            depthMap: { value: depthTexture },
            displacementScale: { value: 15.0 }, // Adjust for more/less 3D effect
            hasDepth: { value: 1.0 }
          },
          vertexShader: depthVertexShader,
          fragmentShader: depthFragmentShader,
          side: THREE.DoubleSide
        });
      } else {
        material = new THREE.MeshBasicMaterial({
          map: colorTexture,
          side: THREE.DoubleSide
        });
      }
      
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...config.position);
      mesh.rotation.set(...config.rotation);
      mesh.name = config.key; // Add name for debugging
      
      scene.add(mesh);
      meshes.push(mesh);
      
      console.log(`[CubemapViewer] Added mesh for ${config.key} at position:`, config.position, 'rotation:', config.rotation);
    });
    
    meshesRef.current = meshes;
    
    // Animation loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      
      // Smooth interpolation
      rotationRef.current.lon += (targetRotationRef.current.lon - rotationRef.current.lon) * 0.1;
      rotationRef.current.lat += (targetRotationRef.current.lat - rotationRef.current.lat) * 0.1;
      
      // Convert to camera look direction
      const phi = THREE.MathUtils.degToRad(90 - rotationRef.current.lat);
      const theta = THREE.MathUtils.degToRad(rotationRef.current.lon);
      
      const target = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      );
      
      camera.lookAt(target);
      renderer.render(scene, camera);
    };
    
    animate();
    
    // Handle resize
    const handleResize = () => {
      if (!containerRef.current || !cameraRef.current || !rendererRef.current) return;
      
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(width, height);
    };
    
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameRef.current);
      
      if (rendererRef.current && containerRef.current) {
        containerRef.current.removeChild(rendererRef.current.domElement);
        rendererRef.current.dispose();
      }
      
      // Dispose textures and meshes
      loadedTextures.forEach(t => t.dispose());
      loadedDepthTextures.forEach(t => t.dispose());
      meshes.forEach(m => {
        m.geometry.dispose();
        if (Array.isArray(m.material)) {
          m.material.forEach(mat => mat.dispose());
        } else {
          m.material.dispose();
        }
      });
    };
  }, [faces, depthMaps, enableDepth, depthVertexShader, depthFragmentShader]);

  // Mouse/touch interaction
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isDraggingRef.current = true;
    previousMouseRef.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    
    const deltaX = e.clientX - previousMouseRef.current.x;
    const deltaY = e.clientY - previousMouseRef.current.y;
    
    targetRotationRef.current.lon -= deltaX * 0.3;
    targetRotationRef.current.lat = Math.max(-85, Math.min(85, 
      targetRotationRef.current.lat + deltaY * 0.3
    ));
    
    previousMouseRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    isDraggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  // Zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!cameraRef.current) return;
    const fov = cameraRef.current.fov + e.deltaY * 0.05;
    cameraRef.current.fov = Math.max(30, Math.min(100, fov));
    cameraRef.current.updateProjectionMatrix();
  }, []);

  // Gyroscope
  useEffect(() => {
    if (!enableGyroscope || !isGyroActive) return;
    
    const handleOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha !== null && e.beta !== null) {
        targetRotationRef.current.lon = e.alpha;
        targetRotationRef.current.lat = Math.max(-85, Math.min(85, e.beta - 90));
      }
    };
    
    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, [enableGyroscope, isGyroActive]);

  const toggleGyroscope = useCallback(async () => {
    if (!isGyroActive) {
      if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
        try {
          const permission = await (DeviceOrientationEvent as any).requestPermission();
          if (permission === 'granted') {
            setIsGyroActive(true);
          }
        } catch {
          console.error('Gyroscope permission denied');
        }
      } else {
        setIsGyroActive(true);
      }
    } else {
      setIsGyroActive(false);
    }
  }, [isGyroActive]);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            >
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div>
              <h2 className="text-white font-semibold">{roomName}</h2>
              <p className="text-white/60 text-sm">360° Room View</p>
            </div>
          </div>
          
          {enableGyroscope && !isLoading && (
            <button
              onClick={toggleGyroscope}
              className={`p-2 rounded-full transition-colors ${
                isGyroActive ? 'bg-blue-500' : 'bg-white/10 hover:bg-white/20'
              }`}
            >
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </button>
          )}
        </div>
      </div>
      
      {/* Main viewer */}
      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
      />
      
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90">
          <div className="text-center">
            <div className="relative w-20 h-20 mx-auto mb-6">
              <svg className="w-20 h-20 transform -rotate-90" viewBox="0 0 100 100">
                <circle
                  className="text-white/10"
                  strokeWidth="8"
                  stroke="currentColor"
                  fill="transparent"
                  r="42"
                  cx="50"
                  cy="50"
                />
                <circle
                  className="text-blue-500 transition-all duration-300"
                  strokeWidth="8"
                  strokeLinecap="round"
                  stroke="currentColor"
                  fill="transparent"
                  r="42"
                  cx="50"
                  cy="50"
                  strokeDasharray={`${loadProgress * 2.64} 264`}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-white font-medium">
                {loadProgress}%
              </span>
            </div>
            <p className="text-white text-lg font-medium">Loading 360° View...</p>
            <p className="text-white/60 text-sm mt-2">{roomName}</p>
          </div>
        </div>
      )}
      
      {/* Error indicator */}
      {loadErrors.length > 0 && !isLoading && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 bg-red-500/90 text-white px-4 py-2 rounded-lg text-sm z-10">
          ⚠️ {loadErrors.length} face(s) failed to load: {loadErrors.join(', ')}
        </div>
      )}
      
      {/* Instructions */}
      {!isLoading && (
        <div className="absolute bottom-4 left-4 right-4 text-center">
          <p className="text-white/60 text-sm">
            Drag to look around • Scroll to zoom
          </p>
        </div>
      )}
    </div>
  );
};

export default CubemapViewer;
