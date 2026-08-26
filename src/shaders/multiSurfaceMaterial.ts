/**
 * Multi-Surface Material Shader
 * 
 * Applies different materials to a single mesh based on surface normal direction.
 * PRESERVES original texture for surfaces not being renovated.
 * 
 * - Surfaces facing UP (Y > 0.5) → Floor texture (if enabled)
 * - Surfaces facing DOWN (Y < -0.5) → Ceiling texture (if enabled)
 * - Surfaces facing SIDEWAYS → Wall texture (if enabled)
 * - Other surfaces → Keep original texture
 */

import * as THREE from 'three';

// Vertex shader
const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

// Fragment shader that applies different colors/textures based on normal
const fragmentShader = `
  // Floor material
  uniform vec3 floorColor;
  uniform sampler2D floorTexture;
  uniform bool hasFloorTexture;
  uniform float floorTextureScale;
  uniform bool applyFloor;
  
  // Wall material
  uniform vec3 wallColor;
  uniform sampler2D wallTexture;
  uniform bool hasWallTexture;
  uniform float wallTextureScale;
  uniform bool applyWall;
  
  // Ceiling material
  uniform vec3 ceilingColor;
  uniform sampler2D ceilingTexture;
  uniform bool hasCeilingTexture;
  uniform float ceilingTextureScale;
  uniform bool applyCeiling;
  
  // Original material preservation
  uniform sampler2D originalMap;
  uniform bool hasOriginalMap;
  uniform vec3 originalColor;
  
  // Lighting
  uniform vec3 ambientLight;
  uniform vec3 lightDirection;
  uniform vec3 lightColor;
  
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  // Triplanar texture sampling for seamless projection
  vec3 triplanarSample(sampler2D tex, float scale, vec3 normal) {
    // Calculate UVs for each axis
    vec2 uvX = vWorldPosition.zy / scale;
    vec2 uvY = vWorldPosition.xz / scale;
    vec2 uvZ = vWorldPosition.xy / scale;
    
    // Calculate blend weights based on normal
    vec3 blend = abs(normal);
    blend = pow(blend, vec3(4.0));
    blend /= (blend.x + blend.y + blend.z + 0.001);
    
    // Sample from each projection
    vec3 texX = texture2D(tex, uvX).rgb;
    vec3 texY = texture2D(tex, uvY).rgb;
    vec3 texZ = texture2D(tex, uvZ).rgb;
    
    // Blend based on normal direction
    return texX * blend.x + texY * blend.y + texZ * blend.z;
  }
  
  void main() {
    vec3 normal = normalize(vWorldNormal);
    float upDot = normal.y;
    
    vec3 surfaceColor;
    bool renovationApplied = false;
    
    // Check surface type and apply renovation if enabled
    
    // Floor: normal pointing UP (Y > 0.5)
    if (upDot > 0.5 && applyFloor) {
      if (hasFloorTexture) {
        // Use triplanar projection for floor texture
        surfaceColor = triplanarSample(floorTexture, floorTextureScale, normal);
      } else {
        surfaceColor = floorColor;
      }
      renovationApplied = true;
    }
    // Ceiling: normal pointing DOWN (Y < -0.5)
    else if (upDot < -0.5 && applyCeiling) {
      if (hasCeilingTexture) {
        surfaceColor = triplanarSample(ceilingTexture, ceilingTextureScale, normal);
      } else {
        surfaceColor = ceilingColor;
      }
      renovationApplied = true;
    }
    // Wall: normal mostly horizontal (|Y| < 0.5)
    else if (abs(upDot) <= 0.5 && applyWall) {
      if (hasWallTexture) {
        surfaceColor = triplanarSample(wallTexture, wallTextureScale, normal);
      } else {
        surfaceColor = wallColor;
      }
      renovationApplied = true;
    }
    
    // If no renovation applied to this surface, use ORIGINAL texture
    if (!renovationApplied) {
      if (hasOriginalMap) {
        surfaceColor = texture2D(originalMap, vUv).rgb;
      } else {
        surfaceColor = originalColor;
      }
    }
    
    // Apply lighting
    float NdotL = max(dot(normal, normalize(lightDirection)), 0.0);
    vec3 diffuse = surfaceColor * lightColor * NdotL;
    vec3 ambient = surfaceColor * ambientLight;
    
    gl_FragColor = vec4(ambient + diffuse, 1.0);
  }
`;

export interface MultiSurfaceMaterialOptions {
  floorColor?: THREE.Color | number;
  floorTexture?: THREE.Texture;
  floorTextureScale?: number;
  applyFloor?: boolean;
  
  wallColor?: THREE.Color | number;
  wallTexture?: THREE.Texture;
  wallTextureScale?: number;
  applyWall?: boolean;
  
  ceilingColor?: THREE.Color | number;
  ceilingTexture?: THREE.Texture;
  ceilingTextureScale?: number;
  applyCeiling?: boolean;
  
  // Original material to preserve for non-renovated surfaces
  originalMap?: THREE.Texture | null;
  originalColor?: THREE.Color | number;
  
  calibrationScale?: number;
}

export function createMultiSurfaceMaterial(options: MultiSurfaceMaterialOptions): THREE.ShaderMaterial {
  const calibrationScale = options.calibrationScale || 12; // Default 1 unit = 12 inches
  
  const toColor = (c: THREE.Color | number | undefined, def: number) => {
    if (!c) return new THREE.Color(def);
    return c instanceof THREE.Color ? c : new THREE.Color(c);
  };
  
  // Configure textures for repeat wrapping
  const configTexture = (tex?: THREE.Texture) => {
    if (tex) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
    }
    return tex || null;
  };
  
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      // Floor
      floorColor: { value: toColor(options.floorColor, 0xC4A484) },
      floorTexture: { value: configTexture(options.floorTexture) },
      hasFloorTexture: { value: !!options.floorTexture },
      floorTextureScale: { value: (options.floorTextureScale || 48) / calibrationScale },
      applyFloor: { value: options.applyFloor ?? false },
      
      // Wall
      wallColor: { value: toColor(options.wallColor, 0xF5F5F5) },
      wallTexture: { value: configTexture(options.wallTexture) },
      hasWallTexture: { value: !!options.wallTexture },
      wallTextureScale: { value: (options.wallTextureScale || 24) / calibrationScale },
      applyWall: { value: options.applyWall ?? false },
      
      // Ceiling
      ceilingColor: { value: toColor(options.ceilingColor, 0xFFFFFF) },
      ceilingTexture: { value: configTexture(options.ceilingTexture) },
      hasCeilingTexture: { value: !!options.ceilingTexture },
      ceilingTextureScale: { value: (options.ceilingTextureScale || 24) / calibrationScale },
      applyCeiling: { value: options.applyCeiling ?? false },
      
      // Original material preservation
      originalMap: { value: options.originalMap || null },
      hasOriginalMap: { value: !!options.originalMap },
      originalColor: { value: toColor(options.originalColor, 0x888888) },
      
      // Lighting
      ambientLight: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      lightDirection: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
      lightColor: { value: new THREE.Vector3(1.0, 0.98, 0.95) },
    },
    side: THREE.DoubleSide,
  });
  
  return material;
}

export function updateMultiSurfaceMaterial(
  material: THREE.ShaderMaterial,
  options: Partial<MultiSurfaceMaterialOptions>
): void {
  const toColor = (c: THREE.Color | number) => {
    return c instanceof THREE.Color ? c : new THREE.Color(c);
  };
  
  if (options.floorColor !== undefined) {
    material.uniforms.floorColor.value = toColor(options.floorColor);
  }
  if (options.applyFloor !== undefined) {
    material.uniforms.applyFloor.value = options.applyFloor;
  }
  if (options.wallColor !== undefined) {
    material.uniforms.wallColor.value = toColor(options.wallColor);
  }
  if (options.applyWall !== undefined) {
    material.uniforms.applyWall.value = options.applyWall;
  }
  if (options.ceilingColor !== undefined) {
    material.uniforms.ceilingColor.value = toColor(options.ceilingColor);
  }
  if (options.applyCeiling !== undefined) {
    material.uniforms.applyCeiling.value = options.applyCeiling;
  }
  
  material.needsUpdate = true;
}
