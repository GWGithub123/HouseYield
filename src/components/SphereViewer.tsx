/**
 * Sphere Panorama Viewer with Depth Mapping
 * 
 * Maps individual photos on sphere segments with depth displacement for 3D effect.
 * Uses ZoeDepth for actual geometry displacement.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';

interface Photo {
  angle: number;
  imageData: string;
  type: 'horizontal' | 'up' | 'down';
  depthData?: string;
}

interface SphereViewerProps {
  photos: Photo[]; // Individual photos to map on sphere
  roomName?: string;
  onClose?: () => void;
  enableGyroscope?: boolean;
  enableDepth?: boolean;
}

const SphereViewer: React.FC<SphereViewerProps> = ({
  photos,
  roomName = 'Room View',
  onClose,
  enableGyroscope = true,
  enableDepth = true
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sphereRef = useRef<THREE.Mesh | null>(null);
  const animationFrameRef = useRef<number>(0);
  
  // Interaction state
  const isDraggingRef = useRef(false);
  const previousMouseRef = useRef({ x: 0, y: 0 });
  const rotationRef = useRef({ lon: 0, lat: 0 });
  const targetRotationRef = useRef({ lon: 0, lat: 0 });
  
  const [isLoading, setIsLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [isGyroActive, setIsGyroActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current) return;
    
    console.log('[SphereViewer] Initializing with photos:', photos.length, photos);
    
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Create scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    sceneRef.current = scene;
    
    // Create camera
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 0, 0.1);
    cameraRef.current = camera;
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    
    // Add a test white sphere to verify rendering is working
    const testGeometry = new THREE.SphereGeometry(100, 16, 16);
    const testMaterial = new THREE.MeshBasicMaterial({ 
      color: 0xffffff, 
      wireframe: true,
      side: THREE.DoubleSide
    });
    const testSphere = new THREE.Mesh(testGeometry, testMaterial);
    scene.add(testSphere);
    console.log('[SphereViewer] Added test sphere');
    
    // Load and map photos onto sphere segments
    const textureLoader = new THREE.TextureLoader();
    const horizontalPhotos = photos.filter(p => p.type === 'horizontal').sort((a, b) => a.angle - b.angle);
    const upPhoto = photos.find(p => p.type === 'up');
    const downPhoto = photos.find(p => p.type === 'down');
    
    let loadedCount = 0;
    const totalPhotos = photos.length;
    const meshes: THREE.Mesh[] = [];
    
    console.log(`[SphereViewer] Loading ${horizontalPhotos.length} horizontal + ${upPhoto ? 1 : 0} up + ${downPhoto ? 1 : 0} down`);
    console.log('[SphereViewer] Sample horizontal photo:', horizontalPhotos[0]);
    console.log('[SphereViewer] Up photo:', upPhoto);
    console.log('[SphereViewer] Down photo:', downPhoto);
    
    if (horizontalPhotos.length === 0) {
      console.error('[SphereViewer] ❌ No horizontal photos found!');
      setIsLoading(false);
      return;
    }
    
    // Create sphere segments for horizontal photos
    const radius = 500;
    const segmentHeight = 300;
    
    horizontalPhotos.forEach((photo, i) => {
      console.log(`[SphereViewer] Starting to load horizontal photo ${i + 1} at angle ${photo.angle}°`);
      console.log(`[SphereViewer] Photo ${i + 1} imageData length:`, photo.imageData?.length);
      console.log(`[SphereViewer] Photo ${i + 1} imageData preview:`, photo.imageData?.substring(0, 50));
      
      textureLoader.load(
        photo.imageData,
        (colorTexture) => {
          console.log(`[SphereViewer] ✅ Texture loaded for horizontal ${i + 1}`);
          colorTexture.colorSpace = THREE.SRGBColorSpace;
          
          // High-resolution geometry for smooth depth displacement
          const widthSegments = 48;
          const heightSegments = 48;
          const arcWidth = (radius * Math.PI * 2) / horizontalPhotos.length;
          const geometry = new THREE.PlaneGeometry(
            arcWidth * 1.05, // Slight overlap to prevent seams
            segmentHeight,
            widthSegments,
            heightSegments
          );
          
          const material = new THREE.MeshBasicMaterial({
            map: colorTexture,
            side: THREE.DoubleSide,
            transparent: false
          });
          
          const mesh = new THREE.Mesh(geometry, material);
          
          // Position in circle
          const angleRad = THREE.MathUtils.degToRad(photo.angle);
          mesh.position.x = Math.sin(angleRad) * radius;
          mesh.position.z = Math.cos(angleRad) * radius;
          mesh.position.y = 0;
          
          // Rotate to face center
          mesh.rotation.y = -angleRad;
          
          scene.add(mesh);
          meshes.push(mesh);
          
          // Apply depth displacement if available
          if (photo.depthData && enableDepth) {
            const depthImg = new Image();
            depthImg.crossOrigin = 'anonymous';
            depthImg.onload = () => {
              try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                
                canvas.width = widthSegments + 1;
                canvas.height = heightSegments + 1;
                ctx.drawImage(depthImg, 0, 0, canvas.width, canvas.height);
                
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const positions = geometry.attributes.position;
                
                // Displace vertices based on depth
                for (let y = 0; y <= heightSegments; y++) {
                  for (let x = 0; x <= widthSegments; x++) {
                    const vertexIndex = y * (widthSegments + 1) + x;
                    const pixelIdx = (y * canvas.width + x) * 4;
                    
                    // Get depth value (0-255, where darker = closer)
                    const depth = imageData.data[pixelIdx] / 255;
                    
                    // Displace vertex backward (away from camera) based on depth
                    // Darker = closer = less displacement
                    // Lighter = farther = more displacement
                    const displacementScale = 30;
                    const displacement = depth * displacementScale;
                    
                    // Get current Z position and adjust
                    const currentZ = positions.getZ(vertexIndex);
                    positions.setZ(vertexIndex, currentZ - displacement);
                  }
                }
                
                positions.needsUpdate = true;
                geometry.computeVertexNormals();
                console.log(`[SphereViewer] ✅ Applied depth to horizontal ${i + 1}`);
              } catch (err) {
                console.warn(`[SphereViewer] Failed to apply depth to horizontal ${i + 1}:`, err);
              }
            };
            depthImg.onerror = (err) => {
              console.warn(`[SphereViewer] Failed to load depth map ${i + 1}:`, err);
            };
            depthImg.src = photo.depthData;
          }
          
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / totalPhotos) * 100));
          
          if (loadedCount === totalPhotos) {
            setIsLoading(false);
          }
          
          console.log(`[SphereViewer] ✅ Loaded horizontal ${i + 1}/${horizontalPhotos.length} ${photo.depthData ? 'with depth' : ''}`);
        },
        undefined,
        (err) => {
          console.error(`[SphereViewer] Failed to load photo ${i}:`, err);
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / totalPhotos) * 100));
          if (loadedCount === totalPhotos) setIsLoading(false);
        }
      );
    });
    
    // Add ceiling with depth
    if (upPhoto) {
      textureLoader.load(
        upPhoto.imageData,
        (colorTexture) => {
          colorTexture.colorSpace = THREE.SRGBColorSpace;
          
          const segments = 48;
          const geometry = new THREE.CircleGeometry(radius * 0.9, segments);
          
          const material = new THREE.MeshBasicMaterial({
            map: colorTexture,
            side: THREE.DoubleSide
          });
          
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.y = segmentHeight / 2;
          mesh.rotation.x = Math.PI / 2;
          
          scene.add(mesh);
          meshes.push(mesh);
          
          // Apply depth displacement if available
          if (upPhoto.depthData && enableDepth) {
            const depthImg = new Image();
            depthImg.crossOrigin = 'anonymous';
            depthImg.onload = () => {
              try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                
                canvas.width = segments;
                canvas.height = segments;
                ctx.drawImage(depthImg, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const positions = geometry.attributes.position;
                
                for (let i = 0; i < positions.count; i++) {
                  const x = positions.getX(i);
                  const z = positions.getZ(i);
                  
                  // Map to texture coordinates (center of circle = 0.5, 0.5)
                  const u = Math.max(0, Math.min(1, (x / (radius * 0.9) + 1) / 2));
                  const v = Math.max(0, Math.min(1, (z / (radius * 0.9) + 1) / 2));
                  
                  const px = Math.floor(u * (canvas.width - 1));
                  const py = Math.floor(v * (canvas.height - 1));
                  const pixelIdx = (py * canvas.width + px) * 4;
                  
                  const depth = imageData.data[pixelIdx] / 255;
                  const displacement = depth * 25;
                  
                  // Displace downward (away from camera below)
                  positions.setY(i, positions.getY(i) - displacement);
                }
                
                positions.needsUpdate = true;
                geometry.computeVertexNormals();
                console.log('[SphereViewer] ✅ Applied depth to ceiling');
              } catch (err) {
                console.warn('[SphereViewer] Failed to apply depth to ceiling:', err);
              }
            };
            depthImg.src = upPhoto.depthData;
          }
          
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / totalPhotos) * 100));
          if (loadedCount === totalPhotos) setIsLoading(false);
          
          console.log(`[SphereViewer] ✅ Loaded ceiling ${upPhoto.depthData ? 'with depth' : ''}`);
        },
        undefined,
        (err) => {
          console.error('[SphereViewer] Failed to load ceiling:', err);
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / totalPhotos) * 100));
          if (loadedCount === totalPhotos) setIsLoading(false);
        }
      );
    }
    
    // Add floor with depth
    if (downPhoto) {
      textureLoader.load(
        downPhoto.imageData,
        (colorTexture) => {
          colorTexture.colorSpace = THREE.SRGBColorSpace;
          
          const segments = 48;
          const geometry = new THREE.CircleGeometry(radius * 0.9, segments);
          
          const material = new THREE.MeshBasicMaterial({
            map: colorTexture,
            side: THREE.DoubleSide
          });
          
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.y = -segmentHeight / 2;
          mesh.rotation.x = -Math.PI / 2;
          
          scene.add(mesh);
          meshes.push(mesh);
          
          // Apply depth displacement if available
          if (downPhoto.depthData && enableDepth) {
            const depthImg = new Image();
            depthImg.crossOrigin = 'anonymous';
            depthImg.onload = () => {
              try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                
                canvas.width = segments;
                canvas.height = segments;
                ctx.drawImage(depthImg, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const positions = geometry.attributes.position;
                
                for (let i = 0; i < positions.count; i++) {
                  const x = positions.getX(i);
                  const z = positions.getZ(i);
                  
                  // Map to texture coordinates
                  const u = Math.max(0, Math.min(1, (x / (radius * 0.9) + 1) / 2));
                  const v = Math.max(0, Math.min(1, (z / (radius * 0.9) + 1) / 2));
                  
                  const px = Math.floor(u * (canvas.width - 1));
                  const py = Math.floor(v * (canvas.height - 1));
                  const pixelIdx = (py * canvas.width + px) * 4;
                  
                  const depth = imageData.data[pixelIdx] / 255;
                  const displacement = depth * 25;
                  
                  // Displace upward (away from camera above)
                  positions.setY(i, positions.getY(i) + displacement);
                }
                
                positions.needsUpdate = true;
                geometry.computeVertexNormals();
                console.log('[SphereViewer] ✅ Applied depth to floor');
              } catch (err) {
                console.warn('[SphereViewer] Failed to apply depth to floor:', err);
              }
            };
            depthImg.src = downPhoto.depthData;
          }
          
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / totalPhotos) * 100));
          if (loadedCount === totalPhotos) setIsLoading(false);
          
          console.log(`[SphereViewer] ✅ Loaded floor ${downPhoto.depthData ? 'with depth' : ''}`);
        },
        undefined,
        (err) => {
          console.error('[SphereViewer] Failed to load floor:', err);
          loadedCount++;
          setLoadProgress(Math.round((loadedCount / totalPhotos) * 100));
          if (loadedCount === totalPhotos) setIsLoading(false);
        }
      );
    }
    
    sphereRef.current = meshes[0]; // Store reference
    
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
      
      // Dispose geometry and material
      if (sphereRef.current) {
        sphereRef.current.geometry.dispose();
        if (sphereRef.current.material instanceof THREE.Material) {
          sphereRef.current.material.dispose();
        }
      }
    };
  }, [photos, enableDepth]);

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
              <p className="text-white/60 text-sm">360° Panorama</p>
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
            <p className="text-white text-lg font-medium">Loading Panorama...</p>
            <p className="text-white/60 text-sm mt-2">{roomName}</p>
          </div>
        </div>
      )}
      
      {/* Error indicator */}
      {error && !isLoading && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 bg-red-500/90 text-white px-4 py-2 rounded-lg text-sm z-10">
          ⚠️ {error}
        </div>
      )}
      
      {/* Instructions */}
      {!isLoading && !error && (
        <div className="absolute bottom-4 left-4 right-4 text-center">
          <p className="text-white/60 text-sm">
            Drag to look around • Scroll to zoom
          </p>
        </div>
      )}
    </div>
  );
};

export default SphereViewer;
