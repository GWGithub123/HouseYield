/**
 * Renovation Material Library
 * 
 * Defines available renovation materials with:
 * - Real-world dimensions for accurate scaling
 * - PBR properties (color, roughness, metalness)
 * - Pricing data for cost estimates
 * - ROI multipliers for investment analysis
 * - Procedural texture generation (no external assets needed)
 */

import * as THREE from 'three';

// ============================================================================
// Types
// ============================================================================

export type RenovationSurfaceType = 'flooring' | 'wall' | 'ceiling' | 'countertop';
export type MaterialCategory = 'budget' | 'mid-range' | 'premium' | 'luxury';

export interface RenovationMaterial {
  id: string;
  name: string;
  description: string;
  surfaceType: RenovationSurfaceType;
  category: MaterialCategory;
  
  // Real-world dimensions (in inches)
  textureSizeInches: number; // One texture repeat = this many inches
  
  // Visual properties
  color: number;
  roughness: number;
  metalness: number;
  
  // Optional pattern settings for procedural textures
  pattern?: {
    type: 'wood' | 'tile' | 'solid' | 'brick' | 'stone';
    grainDirection?: 'horizontal' | 'vertical';
    groutColor?: number;
    groutWidth?: number; // in inches
    plankWidth?: number; // in inches
    variation?: number; // 0-1, color variation amount
  };
  
  // Pricing (USD)
  pricePerSqFt: number; // Material cost
  laborPerSqFt: number; // Installation cost
  
  // Investment analysis
  roiMultiplier: number; // Expected value increase / cost
  durabilityYears: number;
}

// ============================================================================
// Flooring Materials
// ============================================================================

export const FLOORING_MATERIALS: RenovationMaterial[] = [
  // Budget Options
  {
    id: 'lvp-oak-natural',
    name: 'Luxury Vinyl Plank - Natural Oak',
    description: 'Waterproof, durable, and budget-friendly. Great for rentals.',
    surfaceType: 'flooring',
    category: 'budget',
    textureSizeInches: 48, // 4ft planks
    color: 0xC4A67C,
    roughness: 0.7,
    metalness: 0.0,
    pattern: {
      type: 'wood',
      grainDirection: 'horizontal',
      plankWidth: 7, // 7" wide planks
      variation: 0.15,
    },
    pricePerSqFt: 3.50,
    laborPerSqFt: 2.00,
    roiMultiplier: 2.5,
    durabilityYears: 15,
  },
  {
    id: 'lvp-gray-wash',
    name: 'Luxury Vinyl Plank - Gray Wash',
    description: 'Modern gray tone, waterproof. Popular for contemporary spaces.',
    surfaceType: 'flooring',
    category: 'budget',
    textureSizeInches: 48,
    color: 0x9E9E9E,
    roughness: 0.7,
    metalness: 0.0,
    pattern: {
      type: 'wood',
      grainDirection: 'horizontal',
      plankWidth: 7,
      variation: 0.1,
    },
    pricePerSqFt: 3.75,
    laborPerSqFt: 2.00,
    roiMultiplier: 2.3,
    durabilityYears: 15,
  },
  
  // Mid-Range Options
  {
    id: 'engineered-walnut',
    name: 'Engineered Hardwood - Walnut',
    description: 'Real wood veneer over plywood core. Rich, warm tones.',
    surfaceType: 'flooring',
    category: 'mid-range',
    textureSizeInches: 60, // 5ft planks
    color: 0x5D4037,
    roughness: 0.6,
    metalness: 0.0,
    pattern: {
      type: 'wood',
      grainDirection: 'horizontal',
      plankWidth: 5,
      variation: 0.2,
    },
    pricePerSqFt: 7.00,
    laborPerSqFt: 3.50,
    roiMultiplier: 2.0,
    durabilityYears: 25,
  },
  {
    id: 'porcelain-wood-look',
    name: 'Porcelain Tile - Wood Look',
    description: 'Tile that looks like hardwood. Waterproof and durable.',
    surfaceType: 'flooring',
    category: 'mid-range',
    textureSizeInches: 36, // 3ft tiles
    color: 0xA1887F,
    roughness: 0.65,
    metalness: 0.05,
    pattern: {
      type: 'wood',
      grainDirection: 'horizontal',
      plankWidth: 6,
      groutWidth: 0.125,
      groutColor: 0xD7CCC8,
      variation: 0.12,
    },
    pricePerSqFt: 5.50,
    laborPerSqFt: 6.00,
    roiMultiplier: 2.2,
    durabilityYears: 30,
  },
  
  // Premium Options
  {
    id: 'solid-oak-natural',
    name: 'Solid Hardwood - White Oak',
    description: 'Classic solid hardwood. Can be refinished multiple times.',
    surfaceType: 'flooring',
    category: 'premium',
    textureSizeInches: 48,
    color: 0xD4B896,
    roughness: 0.55,
    metalness: 0.0,
    pattern: {
      type: 'wood',
      grainDirection: 'horizontal',
      plankWidth: 4,
      variation: 0.18,
    },
    pricePerSqFt: 10.00,
    laborPerSqFt: 5.00,
    roiMultiplier: 1.8,
    durabilityYears: 50,
  },
  {
    id: 'marble-carrara',
    name: 'Marble Tile - Carrara',
    description: 'Italian marble with classic gray veining. Luxury look.',
    surfaceType: 'flooring',
    category: 'luxury',
    textureSizeInches: 24, // 24" tiles
    color: 0xF5F5F5,
    roughness: 0.3,
    metalness: 0.1,
    pattern: {
      type: 'stone',
      groutWidth: 0.125,
      groutColor: 0xEEEEEE,
      variation: 0.08,
    },
    pricePerSqFt: 15.00,
    laborPerSqFt: 12.00,
    roiMultiplier: 1.5,
    durabilityYears: 50,
  },
];

// ============================================================================
// Wall Materials (Paint)
// ============================================================================

export const WALL_MATERIALS: RenovationMaterial[] = [
  {
    id: 'paint-white-dove',
    name: 'Benjamin Moore - White Dove',
    description: 'Warm white, versatile. Best-selling interior paint color.',
    surfaceType: 'wall',
    category: 'mid-range',
    textureSizeInches: 24, // Subtle texture repeat
    color: 0xF3EFE0,
    roughness: 0.9,
    metalness: 0.0,
    pattern: { type: 'solid', variation: 0.02 },
    pricePerSqFt: 0.35,
    laborPerSqFt: 1.25,
    roiMultiplier: 4.0,
    durabilityYears: 7,
  },
  {
    id: 'paint-simply-white',
    name: 'Benjamin Moore - Simply White',
    description: 'Clean, crisp white. Makes spaces feel larger.',
    surfaceType: 'wall',
    category: 'mid-range',
    textureSizeInches: 24,
    color: 0xF8F6F0,
    roughness: 0.9,
    metalness: 0.0,
    pattern: { type: 'solid', variation: 0.01 },
    pricePerSqFt: 0.35,
    laborPerSqFt: 1.25,
    roiMultiplier: 4.2,
    durabilityYears: 7,
  },
  {
    id: 'paint-pale-oak',
    name: 'Benjamin Moore - Pale Oak',
    description: 'Warm greige (gray-beige). Works with any decor.',
    surfaceType: 'wall',
    category: 'mid-range',
    textureSizeInches: 24,
    color: 0xE5DDD3,
    roughness: 0.9,
    metalness: 0.0,
    pattern: { type: 'solid', variation: 0.02 },
    pricePerSqFt: 0.35,
    laborPerSqFt: 1.25,
    roiMultiplier: 3.8,
    durabilityYears: 7,
  },
  {
    id: 'paint-hale-navy',
    name: 'Benjamin Moore - Hale Navy',
    description: 'Deep, rich navy. Great for accent walls.',
    surfaceType: 'wall',
    category: 'mid-range',
    textureSizeInches: 24,
    color: 0x3C4858,
    roughness: 0.85,
    metalness: 0.0,
    pattern: { type: 'solid', variation: 0.02 },
    pricePerSqFt: 0.40,
    laborPerSqFt: 1.50,
    roiMultiplier: 3.0,
    durabilityYears: 7,
  },
  {
    id: 'paint-agreeable-gray',
    name: 'Sherwin Williams - Agreeable Gray',
    description: 'Most popular paint color. Neutral warm gray.',
    surfaceType: 'wall',
    category: 'mid-range',
    textureSizeInches: 24,
    color: 0xD1CBC0,
    roughness: 0.9,
    metalness: 0.0,
    pattern: { type: 'solid', variation: 0.02 },
    pricePerSqFt: 0.32,
    laborPerSqFt: 1.20,
    roiMultiplier: 4.0,
    durabilityYears: 7,
  },
];

// ============================================================================
// Ceiling Materials
// ============================================================================

export const CEILING_MATERIALS: RenovationMaterial[] = [
  {
    id: 'paint-ceiling-white',
    name: 'Flat White Ceiling Paint',
    description: 'Standard flat white. Hides imperfections.',
    surfaceType: 'ceiling',
    category: 'budget',
    textureSizeInches: 24,
    color: 0xFFFFFF,
    roughness: 1.0,
    metalness: 0.0,
    pattern: { type: 'solid', variation: 0.01 },
    pricePerSqFt: 0.25,
    laborPerSqFt: 1.50,
    roiMultiplier: 2.5,
    durabilityYears: 10,
  },
  {
    id: 'paint-ceiling-off-white',
    name: 'Ceiling Paint - Soft White',
    description: 'Slight warmth to complement white walls.',
    surfaceType: 'ceiling',
    category: 'budget',
    textureSizeInches: 24,
    color: 0xFAF8F5,
    roughness: 1.0,
    metalness: 0.0,
    pattern: { type: 'solid', variation: 0.01 },
    pricePerSqFt: 0.28,
    laborPerSqFt: 1.50,
    roiMultiplier: 2.5,
    durabilityYears: 10,
  },
];

// ============================================================================
// Countertop Materials
// ============================================================================

export const COUNTERTOP_MATERIALS: RenovationMaterial[] = [
  {
    id: 'laminate-white',
    name: 'Laminate - White',
    description: 'Budget-friendly, easy to clean. Good for rentals.',
    surfaceType: 'countertop',
    category: 'budget',
    textureSizeInches: 48,
    color: 0xF5F5F5,
    roughness: 0.4,
    metalness: 0.1,
    pattern: { type: 'solid', variation: 0.02 },
    pricePerSqFt: 15.00,
    laborPerSqFt: 25.00,
    roiMultiplier: 1.5,
    durabilityYears: 10,
  },
  {
    id: 'quartz-white',
    name: 'Quartz - Calacatta',
    description: 'Engineered stone with marble look. Durable and stain-resistant.',
    surfaceType: 'countertop',
    category: 'mid-range',
    textureSizeInches: 48,
    color: 0xFAFAFA,
    roughness: 0.25,
    metalness: 0.15,
    pattern: { type: 'stone', variation: 0.05 },
    pricePerSqFt: 65.00,
    laborPerSqFt: 35.00,
    roiMultiplier: 1.8,
    durabilityYears: 25,
  },
  {
    id: 'granite-black',
    name: 'Granite - Absolute Black',
    description: 'Classic black granite. Timeless and durable.',
    surfaceType: 'countertop',
    category: 'mid-range',
    textureSizeInches: 48,
    color: 0x1A1A1A,
    roughness: 0.2,
    metalness: 0.2,
    pattern: { type: 'stone', variation: 0.08 },
    pricePerSqFt: 55.00,
    laborPerSqFt: 35.00,
    roiMultiplier: 1.7,
    durabilityYears: 30,
  },
  {
    id: 'butcher-block',
    name: 'Butcher Block - Maple',
    description: 'Warm wood surface. Requires maintenance but adds character.',
    surfaceType: 'countertop',
    category: 'mid-range',
    textureSizeInches: 24,
    color: 0xDEB887,
    roughness: 0.6,
    metalness: 0.0,
    pattern: { type: 'wood', variation: 0.15 },
    pricePerSqFt: 45.00,
    laborPerSqFt: 30.00,
    roiMultiplier: 1.6,
    durabilityYears: 20,
  },
];

// ============================================================================
// Combined Material Library
// ============================================================================

export const ALL_MATERIALS: RenovationMaterial[] = [
  ...FLOORING_MATERIALS,
  ...WALL_MATERIALS,
  ...CEILING_MATERIALS,
  ...COUNTERTOP_MATERIALS,
];

export function getMaterialById(id: string): RenovationMaterial | undefined {
  return ALL_MATERIALS.find(m => m.id === id);
}

export function getMaterialsBySurfaceType(surfaceType: RenovationSurfaceType): RenovationMaterial[] {
  return ALL_MATERIALS.filter(m => m.surfaceType === surfaceType);
}

export function getMaterialsByCategory(category: MaterialCategory): RenovationMaterial[] {
  return ALL_MATERIALS.filter(m => m.category === category);
}

// ============================================================================
// Procedural Texture Generation
// ============================================================================

/**
 * Generate a procedural texture for a material
 * This allows realistic textures without external image assets
 */
export function generateProceduralTexture(
  material: RenovationMaterial,
  resolution: number = 512
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d')!;
  
  const baseColor = new THREE.Color(material.color);
  const baseHex = '#' + baseColor.getHexString();
  
  // Fill with base color
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, resolution, resolution);
  
  const pattern = material.pattern;
  if (!pattern) {
    return new THREE.CanvasTexture(canvas);
  }
  
  const variation = pattern.variation || 0.1;
  
  switch (pattern.type) {
    case 'wood':
      generateWoodPattern(ctx, resolution, baseColor, pattern, variation);
      break;
    case 'tile':
    case 'stone':
      generateStonePattern(ctx, resolution, baseColor, pattern, variation);
      break;
    case 'solid':
      generateSolidVariation(ctx, resolution, baseColor, variation);
      break;
  }
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function generateWoodPattern(
  ctx: CanvasRenderingContext2D,
  resolution: number,
  baseColor: THREE.Color,
  pattern: RenovationMaterial['pattern'],
  variation: number
): void {
  const isHorizontal = pattern?.grainDirection !== 'vertical';
  const plankWidthRatio = (pattern?.plankWidth || 6) / 48;
  const plankWidth = Math.max(resolution * plankWidthRatio * 8, 60); // Minimum 60px planks
  
  // Darker and lighter variants for realistic wood
  const darkR = Math.floor(baseColor.r * 255 * 0.6);
  const darkG = Math.floor(baseColor.g * 255 * 0.6);
  const darkB = Math.floor(baseColor.b * 255 * 0.6);
  const lightR = Math.min(255, Math.floor(baseColor.r * 255 * 1.2));
  const lightG = Math.min(255, Math.floor(baseColor.g * 255 * 1.15));
  const lightB = Math.min(255, Math.floor(baseColor.b * 255 * 1.1));
  
  // Draw each plank with individual color variation
  const numPlanks = Math.ceil(resolution / plankWidth) + 1;
  
  for (let p = 0; p < numPlanks; p++) {
    const plankStart = p * plankWidth;
    const plankColorShift = (Math.random() - 0.5) * variation * 80;
    
    // Base plank color with variation
    const pr = Math.max(0, Math.min(255, baseColor.r * 255 + plankColorShift));
    const pg = Math.max(0, Math.min(255, baseColor.g * 255 + plankColorShift * 0.8));
    const pb = Math.max(0, Math.min(255, baseColor.b * 255 + plankColorShift * 0.6));
    
    ctx.fillStyle = `rgb(${pr}, ${pg}, ${pb})`;
    if (isHorizontal) {
      ctx.fillRect(0, plankStart, resolution, plankWidth);
    } else {
      ctx.fillRect(plankStart, 0, plankWidth, resolution);
    }
    
    // Dense wood grain lines within plank
    const grainCount = 15 + Math.floor(Math.random() * 10);
    for (let i = 0; i < grainCount; i++) {
      const grainOffset = plankStart + (i / grainCount) * plankWidth;
      const grainDarkness = 0.85 + Math.random() * 0.15;
      
      ctx.strokeStyle = `rgba(${darkR}, ${darkG}, ${darkB}, ${0.15 + Math.random() * 0.25})`;
      ctx.lineWidth = 0.5 + Math.random() * 1.5;
      
      ctx.beginPath();
      if (isHorizontal) {
        ctx.moveTo(0, grainOffset);
        for (let x = 0; x < resolution; x += 10 + Math.random() * 15) {
          ctx.lineTo(x, grainOffset + (Math.random() - 0.5) * 2);
        }
        ctx.lineTo(resolution, grainOffset);
      } else {
        ctx.moveTo(grainOffset, 0);
        for (let y = 0; y < resolution; y += 10 + Math.random() * 15) {
          ctx.lineTo(grainOffset + (Math.random() - 0.5) * 2, y);
        }
        ctx.lineTo(grainOffset, resolution);
      }
      ctx.stroke();
    }
    
    // Wood knots (occasional darker spots)
    if (Math.random() > 0.7) {
      const knotX = Math.random() * resolution;
      const knotY = plankStart + plankWidth * 0.3 + Math.random() * plankWidth * 0.4;
      const knotSize = 3 + Math.random() * 8;
      
      const gradient = ctx.createRadialGradient(knotX, knotY, 0, knotX, knotY, knotSize);
      gradient.addColorStop(0, `rgba(${darkR * 0.5}, ${darkG * 0.5}, ${darkB * 0.5}, 0.7)`);
      gradient.addColorStop(0.5, `rgba(${darkR * 0.7}, ${darkG * 0.7}, ${darkB * 0.7}, 0.4)`);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.ellipse(knotX, knotY, knotSize, knotSize * 0.6, isHorizontal ? 0 : Math.PI/2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  // Draw plank separations (beveled grooves)
  for (let i = 1; i < numPlanks; i++) {
    const pos = i * plankWidth;
    
    // Dark line (shadow)
    ctx.strokeStyle = `rgba(0, 0, 0, 0.35)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (isHorizontal) {
      ctx.moveTo(0, pos);
      ctx.lineTo(resolution, pos);
    } else {
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, resolution);
    }
    ctx.stroke();
    
    // Light highlight line
    ctx.strokeStyle = `rgba(${lightR}, ${lightG}, ${lightB}, 0.3)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (isHorizontal) {
      ctx.moveTo(0, pos + 2);
      ctx.lineTo(resolution, pos + 2);
    } else {
      ctx.moveTo(pos + 2, 0);
      ctx.lineTo(pos + 2, resolution);
    }
    ctx.stroke();
  }
  
  // Add subtle noise for texture
  const imageData = ctx.getImageData(0, 0, resolution, resolution);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 8;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);
}

function generateStonePattern(
  ctx: CanvasRenderingContext2D,
  resolution: number,
  baseColor: THREE.Color,
  pattern: RenovationMaterial['pattern'],
  _variation: number
): void {
  // Add subtle veining/variation based on variation parameter
  const veinIntensity = 0.1 + _variation * 0.3;
  const veins = 5 + Math.floor(Math.random() * 10);
  
  for (let i = 0; i < veins; i++) {
    const startX = Math.random() * resolution;
    const startY = Math.random() * resolution;
    
    ctx.strokeStyle = `rgba(${Math.floor(baseColor.r * 200)}, ${Math.floor(baseColor.g * 200)}, ${Math.floor(baseColor.b * 200)}, ${veinIntensity + Math.random() * 0.1})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    
    let x = startX;
    let y = startY;
    const steps = 10 + Math.floor(Math.random() * 20);
    
    for (let j = 0; j < steps; j++) {
      x += (Math.random() - 0.5) * 50;
      y += (Math.random() - 0.5) * 50;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  
  // Add grout lines if specified
  if (pattern?.groutWidth && pattern.groutColor !== undefined) {
    const groutColor = new THREE.Color(pattern.groutColor);
    
    ctx.strokeStyle = '#' + groutColor.getHexString();
    ctx.lineWidth = 4;
    
    // Draw grout border
    ctx.strokeRect(1, 1, resolution - 2, resolution - 2);
  }
}

function generateSolidVariation(
  ctx: CanvasRenderingContext2D,
  resolution: number,
  _baseColor: THREE.Color,
  variation: number
): void {
  // Add very subtle noise for paint texture
  const imageData = ctx.getImageData(0, 0, resolution, resolution);
  const data = imageData.data;
  
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * variation * 20;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  
  ctx.putImageData(imageData, 0, 0);
}

// ============================================================================
// Cost Calculation Helpers
// ============================================================================

export interface RenovationCostEstimate {
  material: RenovationMaterial;
  areaSqFt: number;
  materialCost: number;
  laborCost: number;
  totalCost: number;
  estimatedValueIncrease: number;
  roi: number;
}

export function calculateRenovationCost(
  material: RenovationMaterial,
  areaInMeshUnits: number,
  calibrationScale: number // mesh units to inches
): RenovationCostEstimate {
  // Convert mesh area to square feet
  // areaInMeshUnits * (calibrationScale^2) = area in sq inches
  // area in sq inches / 144 = area in sq feet
  const areaSqFt = (areaInMeshUnits * calibrationScale * calibrationScale) / 144;
  
  const materialCost = areaSqFt * material.pricePerSqFt;
  const laborCost = areaSqFt * material.laborPerSqFt;
  const totalCost = materialCost + laborCost;
  const estimatedValueIncrease = totalCost * material.roiMultiplier;
  const roi = material.roiMultiplier;
  
  return {
    material,
    areaSqFt: Math.round(areaSqFt),
    materialCost: Math.round(materialCost),
    laborCost: Math.round(laborCost),
    totalCost: Math.round(totalCost),
    estimatedValueIncrease: Math.round(estimatedValueIncrease),
    roi,
  };
}
