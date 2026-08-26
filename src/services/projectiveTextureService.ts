/**
 * Projective Texture Service
 * 
 * Projects a 2D image onto a 3D mesh from the camera's viewpoint.
 * This is used to apply AI-renovated 2D images back onto the 3D mesh.
 * 
 * The technique:
 * 1. Capture the current view and send to AI for renovation
 * 2. Get back the renovated 2D image
 * 3. Project that image onto the mesh using the same camera parameters
 * 4. The texture appears correctly from the capture angle
 */

import * as THREE from 'three';

export interface ProjectionResult {
  material: THREE.ShaderMaterial;
  projectionMatrix: THREE.Matrix4;
  cleanup: () => void;
}

/**
 * Creates a projective texture material that projects an image onto geometry
 * from the camera's current viewpoint.
 */
export function createProjectiveTextureMaterial(
  texture: THREE.Texture,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  originalMaterial: THREE.Material | THREE.Material[]
): ProjectionResult {
  console.log('[ProjectiveTexture] Creating projective texture material...');
  
  // Get the camera's projection and view matrices
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  
  const projectionMatrix = new THREE.Matrix4();
  projectionMatrix.copy(camera.projectionMatrix);
  projectionMatrix.multiply(camera.matrixWorldInverse);
  
  // Create a shader material that blends the projected texture with the original
  const projectorShader = {
    uniforms: {
      projectedTexture: { value: texture },
      projectorMatrix: { value: projectionMatrix },
      originalMap: { value: null as THREE.Texture | null },
      blendFactor: { value: 1.0 }, // 1.0 = full projection, 0.0 = original
    },
    vertexShader: `
      uniform mat4 projectorMatrix;
      varying vec4 vProjectedCoord;
      varying vec2 vUv;
      
      void main() {
        vUv = uv;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vProjectedCoord = projectorMatrix * worldPosition;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D projectedTexture;
      uniform sampler2D originalMap;
      uniform float blendFactor;
      varying vec4 vProjectedCoord;
      varying vec2 vUv;
      
      void main() {
        // Convert from clip space to UV coordinates
        vec2 projectedUV = vProjectedCoord.xy / vProjectedCoord.w;
        projectedUV = projectedUV * 0.5 + 0.5;
        
        // Check if we're within the projected area
        bool inProjection = projectedUV.x >= 0.0 && projectedUV.x <= 1.0 &&
                           projectedUV.y >= 0.0 && projectedUV.y <= 1.0 &&
                           vProjectedCoord.w > 0.0;
        
        vec4 projectedColor = texture2D(projectedTexture, projectedUV);
        vec4 originalColor = texture2D(originalMap, vUv);
        
        if (inProjection) {
          // Blend between original and projected based on blend factor
          gl_FragColor = mix(originalColor, projectedColor, blendFactor);
        } else {
          // Outside projection area, use original
          gl_FragColor = originalColor;
        }
      }
    `,
  };
  
  // Get the original texture if available
  let originalTexture: THREE.Texture | null = null;
  if (originalMaterial instanceof THREE.MeshStandardMaterial || 
      originalMaterial instanceof THREE.MeshPhongMaterial ||
      originalMaterial instanceof THREE.MeshBasicMaterial) {
    originalTexture = originalMaterial.map;
  } else if (Array.isArray(originalMaterial) && originalMaterial.length > 0) {
    const firstMat = originalMaterial[0];
    if (firstMat instanceof THREE.MeshStandardMaterial || 
        firstMat instanceof THREE.MeshPhongMaterial ||
        firstMat instanceof THREE.MeshBasicMaterial) {
      originalTexture = firstMat.map;
    }
  }
  
  const shaderMaterial = new THREE.ShaderMaterial({
    uniforms: {
      projectedTexture: { value: texture },
      projectorMatrix: { value: projectionMatrix },
      originalMap: { value: originalTexture },
      blendFactor: { value: 1.0 },
    },
    vertexShader: projectorShader.vertexShader,
    fragmentShader: projectorShader.fragmentShader,
    side: THREE.DoubleSide,
  });
  
  console.log('[ProjectiveTexture] Shader material created');
  
  return {
    material: shaderMaterial,
    projectionMatrix,
    cleanup: () => {
      shaderMaterial.dispose();
      texture.dispose();
    },
  };
}

/**
 * Simpler approach: Replace the mesh texture entirely with the AI-renovated image.
 * The image is applied as a screen-space texture that covers the entire view.
 */
export function applyRenovatedTextureToMesh(
  meshGroup: THREE.Group,
  renovatedTexture: THREE.Texture,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
): { restore: () => void } {
  console.log('[ProjectiveTexture] Applying renovated texture to mesh...');
  console.log('[ProjectiveTexture] Camera type:', camera.type);
  console.log('[ProjectiveTexture] Camera position:', camera.position.toArray());
  console.log('[ProjectiveTexture] Texture:', renovatedTexture.image ? 'loaded' : 'NOT loaded');
  
  // Store original materials for restoration
  const originalMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]> = new Map();
  
  // Get camera matrices
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  
  // For orthographic cameras, we need a different approach
  // We'll project the texture as a simple top-down overlay
  const isOrtho = camera instanceof THREE.OrthographicCamera;
  
  // Get the camera's view-projection matrix
  const projectorMatrix = new THREE.Matrix4();
  projectorMatrix.copy(camera.projectionMatrix);
  projectorMatrix.multiply(camera.matrixWorldInverse);
  
  console.log('[ProjectiveTexture] Is orthographic:', isOrtho);
  
  // Apply projective texture to all meshes
  meshGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      // Store original
      originalMaterials.set(child, child.material);
      
      // Get original texture
      let originalMap: THREE.Texture | null = null;
      if (child.material instanceof THREE.MeshStandardMaterial ||
          child.material instanceof THREE.MeshPhongMaterial ||
          child.material instanceof THREE.MeshBasicMaterial) {
        originalMap = child.material.map;
      }
      
      console.log('[ProjectiveTexture] Original map exists:', !!originalMap);
      
      // Get the mesh's bounding box to determine floor Y level
      const meshBox = new THREE.Box3().setFromObject(child);
      const floorY = meshBox.min.y;
      const meshHeight = meshBox.max.y - meshBox.min.y;
      // Floor threshold: consider surfaces within 10% of the mesh height from the bottom as floor
      const floorThreshold = floorY + meshHeight * 0.15;
      
      console.log('[ProjectiveTexture] Floor Y:', floorY.toFixed(2), 'Threshold:', floorThreshold.toFixed(2));
      
      // Create projective shader material that ONLY affects floor surfaces
      const shaderMaterial = new THREE.ShaderMaterial({
        uniforms: {
          projectedTexture: { value: renovatedTexture },
          projectorMatrix: { value: projectorMatrix.clone() },
          originalMap: { value: originalMap },
          hasOriginalMap: { value: originalMap !== null },
          blendFactor: { value: 1.0 },
          floorThreshold: { value: floorThreshold }, // Y level below which is floor
        },
        vertexShader: `
          uniform mat4 projectorMatrix;
          varying vec4 vProjectedCoord;
          varying vec2 vUv;
          varying vec3 vWorldPosition;
          varying vec3 vWorldNormal;
          
          void main() {
            vUv = uv;
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            
            // Transform normal to world space
            vWorldNormal = normalize(mat3(modelMatrix) * normal);
            
            vProjectedCoord = projectorMatrix * worldPosition;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D projectedTexture;
          uniform sampler2D originalMap;
          uniform bool hasOriginalMap;
          uniform float blendFactor;
          uniform float floorThreshold;
          varying vec4 vProjectedCoord;
          varying vec2 vUv;
          varying vec3 vWorldPosition;
          varying vec3 vWorldNormal;
          
          void main() {
            // Get original color first
            vec4 originalColor = hasOriginalMap 
              ? texture2D(originalMap, vUv) 
              : vec4(0.7, 0.7, 0.7, 1.0);
            
            // Check if this is a FLOOR surface:
            // 1. Normal is pointing UP (Y component > 0.7 means mostly horizontal)
            // 2. Position is at floor level (Y below threshold)
            bool isFloorSurface = vWorldNormal.y > 0.7 && vWorldPosition.y < floorThreshold;
            
            if (!isFloorSurface) {
              // Not floor - show original texture unchanged
              gl_FragColor = originalColor;
              return;
            }
            
            // This IS a floor surface - apply projection
            float w = max(vProjectedCoord.w, 0.001);
            vec2 projectedUV = vProjectedCoord.xy / w;
            projectedUV = projectedUV * 0.5 + 0.5;
            projectedUV.y = 1.0 - projectedUV.y;
            
            // Check if we're within the projected area
            bool inProjection = projectedUV.x >= 0.0 && projectedUV.x <= 1.0 &&
                               projectedUV.y >= 0.0 && projectedUV.y <= 1.0;
            
            if (inProjection) {
              vec4 projectedColor = texture2D(projectedTexture, projectedUV);
              gl_FragColor = mix(originalColor, projectedColor, blendFactor);
            } else {
              gl_FragColor = originalColor;
            }
          }
        `,
        side: THREE.DoubleSide,
      });
      
      child.material = shaderMaterial;
    }
  });
  
  console.log('[ProjectiveTexture] Applied to', originalMaterials.size, 'meshes');
  
  // Return a restore function
  return {
    restore: () => {
      console.log('[ProjectiveTexture] Restoring original materials...');
      originalMaterials.forEach((originalMaterial, mesh) => {
        // Dispose shader material
        if (mesh.material instanceof THREE.ShaderMaterial) {
          mesh.material.dispose();
        }
        mesh.material = originalMaterial;
      });
      renovatedTexture.dispose();
      console.log('[ProjectiveTexture] Original materials restored');
    },
  };
}

/**
 * Remove any projective texture and restore original materials
 */
export function removeProjectiveTexture(meshGroup: THREE.Group): void {
  meshGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      // Check if it has stored original material
      const userData = child.userData;
      if (userData.originalMaterial) {
        if (child.material instanceof THREE.ShaderMaterial) {
          child.material.dispose();
        }
        child.material = userData.originalMaterial;
        delete userData.originalMaterial;
      }
    }
  });
}
