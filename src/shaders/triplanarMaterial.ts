/**
 * Triplanar Texture Mapping Shader
 * 
 * Projects textures onto mesh surfaces based on world-space normals.
 * Uses calibration scale factor to ensure textures appear at real-world dimensions.
 * 
 * - Floors (normal pointing up) get XZ projection
 * - Walls (normal pointing sideways) get XY or ZY projection
 * - Ceilings (normal pointing down) get XZ projection
 */

import * as THREE from 'three';

// Vertex shader - passes world position and normal to fragment shader
export const triplanarVertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  void main() {
    // Calculate world position
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    
    // Calculate world normal
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    
    // Pass through UVs if available
    vUv = uv;
    
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

// Fragment shader - samples texture using triplanar projection
export const triplanarFragmentShader = `
  uniform sampler2D diffuseMap;
  uniform sampler2D normalMap;
  uniform sampler2D roughnessMap;
  uniform vec3 baseColor;
  uniform float roughness;
  uniform float metalness;
  uniform float textureScale; // Real-world scale: units per texture repeat
  uniform float blendSharpness;
  uniform bool hasTexture;
  uniform bool hasNormalMap;
  uniform bool hasRoughnessMap;
  
  // Lighting uniforms
  uniform vec3 ambientLight;
  uniform vec3 lightDirection;
  uniform vec3 lightColor;
  
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  
  // Triplanar blend weights based on normal direction
  vec3 getTriplanarBlend(vec3 normal) {
    vec3 blend = abs(normal);
    // Raise to power for sharper blending
    blend = pow(blend, vec3(blendSharpness));
    // Normalize so weights sum to 1
    blend /= (blend.x + blend.y + blend.z);
    return blend;
  }
  
  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 blend = getTriplanarBlend(normal);
    
    // Calculate UVs for each projection axis using world position
    // textureScale converts mesh units to texture repeats
    vec2 uvX = vWorldPosition.zy / textureScale;
    vec2 uvY = vWorldPosition.xz / textureScale;
    vec2 uvZ = vWorldPosition.xy / textureScale;
    
    vec3 finalColor;
    float finalRoughness = roughness;
    
    if (hasTexture) {
      // Sample texture from all three projections
      vec3 texX = texture2D(diffuseMap, uvX).rgb;
      vec3 texY = texture2D(diffuseMap, uvY).rgb;
      vec3 texZ = texture2D(diffuseMap, uvZ).rgb;
      
      // Blend based on normal direction
      finalColor = texX * blend.x + texY * blend.y + texZ * blend.z;
      finalColor *= baseColor; // Tint with base color
      
      // Sample roughness map if available
      if (hasRoughnessMap) {
        float roughX = texture2D(roughnessMap, uvX).r;
        float roughY = texture2D(roughnessMap, uvY).r;
        float roughZ = texture2D(roughnessMap, uvZ).r;
        finalRoughness = roughX * blend.x + roughY * blend.y + roughZ * blend.z;
      }
    } else {
      finalColor = baseColor;
    }
    
    // Simple lighting calculation
    float NdotL = max(dot(normal, normalize(lightDirection)), 0.0);
    vec3 diffuse = finalColor * lightColor * NdotL;
    vec3 ambient = finalColor * ambientLight;
    
    // Roughness affects specular (simplified)
    float specularStrength = (1.0 - finalRoughness) * 0.3;
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 reflectDir = reflect(-normalize(lightDirection), normal);
    float spec = pow(max(dot(viewDir, reflectDir), 0.0), 32.0) * specularStrength;
    
    vec3 finalLighting = ambient + diffuse + vec3(spec);
    
    gl_FragColor = vec4(finalLighting, 1.0);
  }
`;

/**
 * Create a triplanar material for renovation textures
 * 
 * @param options Material configuration
 * @param options.diffuseMap Optional diffuse texture
 * @param options.normalMap Optional normal map
 * @param options.roughnessMap Optional roughness map  
 * @param options.baseColor Base color (multiplied with texture)
 * @param options.roughness Base roughness value
 * @param options.metalness Metalness value
 * @param options.textureScaleInches Real-world size of one texture repeat in inches
 * @param options.calibrationScale Calibration factor (mesh units to inches)
 */
export interface TriplanarMaterialOptions {
  diffuseMap?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  baseColor?: THREE.Color | number;
  roughness?: number;
  metalness?: number;
  textureScaleInches: number; // e.g., 6 for 6-inch planks, 12 for 12-inch tiles
  calibrationScale: number; // mesh units to inches
  blendSharpness?: number;
}

export function createTriplanarMaterial(options: TriplanarMaterialOptions): THREE.ShaderMaterial {
  const {
    diffuseMap,
    normalMap,
    roughnessMap,
    baseColor = 0xffffff,
    roughness = 0.5,
    metalness = 0.0,
    textureScaleInches,
    calibrationScale,
    blendSharpness = 4.0,
  } = options;
  
  // Calculate texture scale in mesh units
  // If calibrationScale = 12 (1 unit = 12 inches) and textureScaleInches = 6 (6" planks)
  // Then textureScale = 6/12 = 0.5 mesh units per texture repeat
  const textureScale = textureScaleInches / calibrationScale;
  
  const color = baseColor instanceof THREE.Color ? baseColor : new THREE.Color(baseColor);
  
  // Configure texture wrapping
  if (diffuseMap) {
    diffuseMap.wrapS = THREE.RepeatWrapping;
    diffuseMap.wrapT = THREE.RepeatWrapping;
  }
  if (normalMap) {
    normalMap.wrapS = THREE.RepeatWrapping;
    normalMap.wrapT = THREE.RepeatWrapping;
  }
  if (roughnessMap) {
    roughnessMap.wrapS = THREE.RepeatWrapping;
    roughnessMap.wrapT = THREE.RepeatWrapping;
  }
  
  const material = new THREE.ShaderMaterial({
    vertexShader: triplanarVertexShader,
    fragmentShader: triplanarFragmentShader,
    uniforms: {
      diffuseMap: { value: diffuseMap || null },
      normalMap: { value: normalMap || null },
      roughnessMap: { value: roughnessMap || null },
      baseColor: { value: color },
      roughness: { value: roughness },
      metalness: { value: metalness },
      textureScale: { value: textureScale },
      blendSharpness: { value: blendSharpness },
      hasTexture: { value: !!diffuseMap },
      hasNormalMap: { value: !!normalMap },
      hasRoughnessMap: { value: !!roughnessMap },
      ambientLight: { value: new THREE.Vector3(0.4, 0.4, 0.4) },
      lightDirection: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
      lightColor: { value: new THREE.Vector3(1.0, 0.98, 0.95) },
    },
    side: THREE.DoubleSide,
  });
  
  return material;
}

/**
 * Update texture scale when calibration changes
 */
export function updateMaterialCalibration(
  material: THREE.ShaderMaterial, 
  textureScaleInches: number,
  calibrationScale: number
): void {
  const textureScale = textureScaleInches / calibrationScale;
  material.uniforms.textureScale.value = textureScale;
}
