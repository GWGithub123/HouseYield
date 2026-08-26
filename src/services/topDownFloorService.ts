/**
 * Top-Down Floor Renovation Service
 * 
 * This service implements a smart approach to AI floor renovation:
 * 1. Automatically positions camera for a top-down orthographic view
 * 2. Captures the mesh from directly above
 * 3. Sends to Gemini to generate renovated flooring
 * 4. Projects the result back onto the mesh as a decal/texture from above
 * 
 * This approach works because floors are horizontal - a top-down capture
 * and projection gives the most accurate and least distorted result.
 */

import * as THREE from 'three';

export interface TopDownCaptureResult {
  imageDataUrl: string;
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    width: number;
    depth: number;
    centerX: number;
    centerZ: number;
    floorY: number;
  };
  originalCameraState: {
    position: THREE.Vector3;
    target: THREE.Vector3;
    zoom: number;
  };
}

/**
 * Captures the mesh from a top-down view.
 * Returns the captured image and the bounds for projection.
 */
export function captureTopDownView(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  meshGroup: THREE.Group,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: any, // OrbitControls
  resolution: number = 1024
): TopDownCaptureResult {
  console.log('[TopDownFloor] Capturing top-down view...');
  
  // Save original camera state
  const originalCameraState = {
    position: camera.position.clone(),
    target: controls.target.clone(),
    zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : 1,
  };
  
  // Calculate mesh bounds
  const box = new THREE.Box3().setFromObject(meshGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  
  console.log('[TopDownFloor] Mesh bounds:', {
    center: center.toArray().map(v => v.toFixed(2)),
    size: size.toArray().map(v => v.toFixed(2)),
  });
  
  // Create a temporary orthographic camera for the capture
  const viewSize = Math.max(size.x, size.z) * 1.1; // Add 10% margin
  
  const orthoCamera = new THREE.OrthographicCamera(
    -viewSize / 2,
    viewSize / 2,
    viewSize / 2,
    -viewSize / 2,
    0.1,
    size.y * 3
  );
  
  // Position camera directly above, looking down
  orthoCamera.position.set(center.x, box.max.y + size.y, center.z);
  orthoCamera.lookAt(center.x, box.min.y, center.z);
  orthoCamera.updateProjectionMatrix();
  
  console.log('[TopDownFloor] Ortho camera positioned at:', orthoCamera.position.toArray().map(v => v.toFixed(2)));
  
  // Create a render target for the capture
  const renderTarget = new THREE.WebGLRenderTarget(resolution, resolution, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
  });
  
  // Store original render target and size
  const originalRenderTarget = renderer.getRenderTarget();
  const originalSize = new THREE.Vector2();
  renderer.getSize(originalSize);
  
  // Render to our target
  renderer.setRenderTarget(renderTarget);
  renderer.setSize(resolution, resolution);
  renderer.render(scene, orthoCamera);
  
  // Read pixels
  const pixels = new Uint8Array(resolution * resolution * 4);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, resolution, resolution, pixels);
  
  // Restore renderer state
  renderer.setRenderTarget(originalRenderTarget);
  renderer.setSize(originalSize.x, originalSize.y);
  
  // Convert to canvas and data URL
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d')!;
  
  // WebGL renders upside down, so we need to flip
  const imageData = ctx.createImageData(resolution, resolution);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const srcIdx = ((resolution - 1 - y) * resolution + x) * 4;
      const dstIdx = (y * resolution + x) * 4;
      imageData.data[dstIdx] = pixels[srcIdx];
      imageData.data[dstIdx + 1] = pixels[srcIdx + 1];
      imageData.data[dstIdx + 2] = pixels[srcIdx + 2];
      imageData.data[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }
  ctx.putImageData(imageData, 0, 0);
  
  const imageDataUrl = canvas.toDataURL('image/jpeg', 0.9);
  
  // Cleanup
  renderTarget.dispose();
  
  console.log('[TopDownFloor] Captured top-down image, size:', imageDataUrl.length);
  
  return {
    imageDataUrl,
    bounds: {
      minX: box.min.x,
      maxX: box.max.x,
      minZ: box.min.z,
      maxZ: box.max.z,
      width: size.x,
      depth: size.z,
      centerX: center.x,
      centerZ: center.z,
      floorY: box.min.y,
    },
    originalCameraState,
  };
}

/**
 * Creates a floor overlay plane and applies the AI-generated texture.
 * The texture is projected from above onto a flat plane at floor level.
 */
export function createFloorPlaneWithTexture(
  texture: THREE.Texture,
  bounds: TopDownCaptureResult['bounds'],
  yOffset: number = 0.01
): THREE.Mesh {
  console.log('[TopDownFloor] Creating floor plane with AI texture...');
  
  // Create a plane geometry that covers the floor area
  const geometry = new THREE.PlaneGeometry(bounds.width, bounds.depth);
  
  // Configure texture
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  
  // Create material
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 1.0,
    depthWrite: true,
    depthTest: true,
  });
  
  // Create mesh
  const floorPlane = new THREE.Mesh(geometry, material);
  floorPlane.name = 'AI_Floor_Plane';
  
  // Position at floor level, rotated to be horizontal (XZ plane)
  floorPlane.rotation.x = -Math.PI / 2; // Rotate to horizontal
  floorPlane.position.set(bounds.centerX, bounds.floorY + yOffset, bounds.centerZ);
  
  // Set render order to be on top of existing geometry
  floorPlane.renderOrder = 10;
  
  console.log('[TopDownFloor] Floor plane created at Y =', bounds.floorY + yOffset);
  
  return floorPlane;
}

/**
 * Animates camera to top-down view
 */
export function animateCameraToTopDown(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: any,
  meshGroup: THREE.Group,
  duration: number = 1000
): Promise<void> {
  return new Promise((resolve) => {
    const box = new THREE.Box3().setFromObject(meshGroup);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    
    const endPosition = new THREE.Vector3(center.x, box.max.y + size.y * 1.5, center.z);
    const endTarget = new THREE.Vector3(center.x, box.min.y, center.z);
    
    const startTime = Date.now();
    
    function animate() {
      const elapsed = Date.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      
      // Ease out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      
      camera.position.lerpVectors(startPosition, endPosition, ease);
      controls.target.lerpVectors(startTarget, endTarget, ease);
      controls.update();
      
      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        resolve();
      }
    }
    
    animate();
  });
}

/**
 * Removes any existing floor plane overlay
 */
export function removeFloorPlane(meshGroup: THREE.Group): void {
  const toRemove: THREE.Object3D[] = [];
  
  meshGroup.traverse((child) => {
    if (child.name === 'AI_Floor_Plane') {
      toRemove.push(child);
    }
  });
  
  for (const obj of toRemove) {
    obj.parent?.remove(obj);
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      if (obj.material instanceof THREE.Material) {
        obj.material.dispose();
      }
    }
  }
  
  if (toRemove.length > 0) {
    console.log('[TopDownFloor] Removed', toRemove.length, 'existing floor plane(s)');
  }
}
