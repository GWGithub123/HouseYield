/**
 * Material Library
 * 
 * Pre-defined materials for renovation previews with real-world dimensions
 * for accurate UV scaling based on calibration.
 */

export interface Material {
  id: string;
  name: string;
  category: 'flooring' | 'paint' | 'countertop' | 'tile' | 'fixture';
  
  // Texture files (relative to /public/materials/)
  textureUrl?: string;
  normalMapUrl?: string;
  roughnessMapUrl?: string;
  
  // For solid colors (paint, etc.)
  color?: string;
  
  // Physical properties
  roughness: number;
  metalness: number;
  
  // Real-world texture size in inches (for UV scaling)
  textureRealSize?: { width: number; height: number };
  
  // Cost per unit (for estimates)
  pricePerSqFt: number;
  laborPerSqFt: number;
  
  // Display
  thumbnail: string;
  description: string;
}

// ============================================================================
// Flooring Materials
// ============================================================================

export const FLOORING_MATERIALS: Material[] = [
  {
    id: 'hardwood-oak-natural',
    name: 'Oak Hardwood (Natural)',
    category: 'flooring',
    textureUrl: '/materials/flooring/hardwood-oak.jpg',
    roughness: 0.6,
    metalness: 0,
    textureRealSize: { width: 5, height: 48 }, // 5" wide planks
    pricePerSqFt: 8,
    laborPerSqFt: 4,
    thumbnail: '/materials/thumbnails/hardwood-oak.jpg',
    description: 'Classic oak hardwood with natural grain patterns',
  },
  {
    id: 'hardwood-walnut-dark',
    name: 'Walnut Hardwood (Dark)',
    category: 'flooring',
    textureUrl: '/materials/flooring/hardwood-walnut.jpg',
    roughness: 0.55,
    metalness: 0,
    textureRealSize: { width: 5, height: 48 },
    pricePerSqFt: 12,
    laborPerSqFt: 4,
    thumbnail: '/materials/thumbnails/hardwood-walnut.jpg',
    description: 'Rich dark walnut hardwood flooring',
  },
  {
    id: 'lvp-gray-oak',
    name: 'Luxury Vinyl Plank (Gray Oak)',
    category: 'flooring',
    textureUrl: '/materials/flooring/lvp-gray.jpg',
    roughness: 0.7,
    metalness: 0,
    textureRealSize: { width: 7, height: 48 },
    pricePerSqFt: 5,
    laborPerSqFt: 2.5,
    thumbnail: '/materials/thumbnails/lvp-gray.jpg',
    description: 'Waterproof luxury vinyl plank in gray oak',
  },
  {
    id: 'tile-porcelain-white',
    name: 'Porcelain Tile (White)',
    category: 'flooring',
    textureUrl: '/materials/flooring/tile-white.jpg',
    roughness: 0.3,
    metalness: 0.1,
    textureRealSize: { width: 24, height: 24 }, // 24" x 24" tiles
    pricePerSqFt: 6,
    laborPerSqFt: 8,
    thumbnail: '/materials/thumbnails/tile-white.jpg',
    description: 'Large format white porcelain tile',
  },
  {
    id: 'tile-marble-carrara',
    name: 'Carrara Marble Tile',
    category: 'flooring',
    textureUrl: '/materials/flooring/marble-carrara.jpg',
    roughness: 0.2,
    metalness: 0.15,
    textureRealSize: { width: 12, height: 12 },
    pricePerSqFt: 15,
    laborPerSqFt: 10,
    thumbnail: '/materials/thumbnails/marble-carrara.jpg',
    description: 'Classic Carrara marble with gray veining',
  },
  {
    id: 'carpet-plush-gray',
    name: 'Plush Carpet (Gray)',
    category: 'flooring',
    textureUrl: '/materials/flooring/carpet-gray.jpg',
    roughness: 0.95,
    metalness: 0,
    textureRealSize: { width: 12, height: 12 },
    pricePerSqFt: 4,
    laborPerSqFt: 2,
    thumbnail: '/materials/thumbnails/carpet-gray.jpg',
    description: 'Soft plush carpet in neutral gray',
  },
];

// ============================================================================
// Paint Colors
// ============================================================================

export const PAINT_MATERIALS: Material[] = [
  {
    id: 'paint-white-pure',
    name: 'Pure White',
    category: 'paint',
    color: '#FFFFFF',
    roughness: 0.9,
    metalness: 0,
    pricePerSqFt: 0.50,
    laborPerSqFt: 1.5,
    thumbnail: '/materials/thumbnails/paint-white.jpg',
    description: 'Clean bright white for modern spaces',
  },
  {
    id: 'paint-gray-light',
    name: 'Light Gray',
    category: 'paint',
    color: '#D3D3D3',
    roughness: 0.9,
    metalness: 0,
    pricePerSqFt: 0.50,
    laborPerSqFt: 1.5,
    thumbnail: '/materials/thumbnails/paint-gray.jpg',
    description: 'Versatile light gray for any room',
  },
  {
    id: 'paint-greige',
    name: 'Greige',
    category: 'paint',
    color: '#B8A99A',
    roughness: 0.9,
    metalness: 0,
    pricePerSqFt: 0.55,
    laborPerSqFt: 1.5,
    thumbnail: '/materials/thumbnails/paint-greige.jpg',
    description: 'Warm gray-beige blend',
  },
  {
    id: 'paint-navy',
    name: 'Navy Blue',
    category: 'paint',
    color: '#1E3A5F',
    roughness: 0.85,
    metalness: 0,
    pricePerSqFt: 0.60,
    laborPerSqFt: 1.75,
    thumbnail: '/materials/thumbnails/paint-navy.jpg',
    description: 'Sophisticated navy blue accent',
  },
  {
    id: 'paint-sage',
    name: 'Sage Green',
    category: 'paint',
    color: '#9CAF88',
    roughness: 0.9,
    metalness: 0,
    pricePerSqFt: 0.55,
    laborPerSqFt: 1.5,
    thumbnail: '/materials/thumbnails/paint-sage.jpg',
    description: 'Calming sage green',
  },
];

// ============================================================================
// Countertop Materials
// ============================================================================

export const COUNTERTOP_MATERIALS: Material[] = [
  {
    id: 'counter-quartz-white',
    name: 'White Quartz',
    category: 'countertop',
    textureUrl: '/materials/countertop/quartz-white.jpg',
    roughness: 0.2,
    metalness: 0.05,
    textureRealSize: { width: 48, height: 48 },
    pricePerSqFt: 75,
    laborPerSqFt: 40,
    thumbnail: '/materials/thumbnails/quartz-white.jpg',
    description: 'Clean white quartz with subtle veining',
  },
  {
    id: 'counter-granite-black',
    name: 'Black Granite',
    category: 'countertop',
    textureUrl: '/materials/countertop/granite-black.jpg',
    roughness: 0.25,
    metalness: 0.1,
    textureRealSize: { width: 48, height: 48 },
    pricePerSqFt: 60,
    laborPerSqFt: 40,
    thumbnail: '/materials/thumbnails/granite-black.jpg',
    description: 'Elegant black granite with speckles',
  },
  {
    id: 'counter-marble-carrara',
    name: 'Carrara Marble',
    category: 'countertop',
    textureUrl: '/materials/countertop/marble-carrara.jpg',
    roughness: 0.15,
    metalness: 0.1,
    textureRealSize: { width: 48, height: 48 },
    pricePerSqFt: 100,
    laborPerSqFt: 50,
    thumbnail: '/materials/thumbnails/marble-carrara.jpg',
    description: 'Luxurious Carrara marble',
  },
  {
    id: 'counter-butcher-block',
    name: 'Butcher Block',
    category: 'countertop',
    textureUrl: '/materials/countertop/butcher-block.jpg',
    roughness: 0.7,
    metalness: 0,
    textureRealSize: { width: 24, height: 24 },
    pricePerSqFt: 45,
    laborPerSqFt: 25,
    thumbnail: '/materials/thumbnails/butcher-block.jpg',
    description: 'Warm maple butcher block',
  },
  {
    id: 'counter-laminate-white',
    name: 'White Laminate',
    category: 'countertop',
    textureUrl: '/materials/countertop/laminate-white.jpg',
    roughness: 0.4,
    metalness: 0,
    textureRealSize: { width: 48, height: 48 },
    pricePerSqFt: 15,
    laborPerSqFt: 15,
    thumbnail: '/materials/thumbnails/laminate-white.jpg',
    description: 'Budget-friendly white laminate',
  },
];

// ============================================================================
// Tile Materials (Backsplash, Shower, etc.)
// ============================================================================

export const TILE_MATERIALS: Material[] = [
  {
    id: 'tile-subway-white',
    name: 'White Subway Tile',
    category: 'tile',
    textureUrl: '/materials/tile/subway-white.jpg',
    roughness: 0.3,
    metalness: 0.05,
    textureRealSize: { width: 3, height: 6 }, // 3" x 6" tiles
    pricePerSqFt: 8,
    laborPerSqFt: 15,
    thumbnail: '/materials/thumbnails/subway-white.jpg',
    description: 'Classic white subway tile',
  },
  {
    id: 'tile-hexagon-white',
    name: 'White Hexagon Tile',
    category: 'tile',
    textureUrl: '/materials/tile/hexagon-white.jpg',
    roughness: 0.35,
    metalness: 0.05,
    textureRealSize: { width: 2, height: 2 },
    pricePerSqFt: 12,
    laborPerSqFt: 18,
    thumbnail: '/materials/thumbnails/hexagon-white.jpg',
    description: 'Trendy hexagon mosaic tile',
  },
  {
    id: 'tile-glass-blue',
    name: 'Blue Glass Mosaic',
    category: 'tile',
    textureUrl: '/materials/tile/glass-blue.jpg',
    roughness: 0.1,
    metalness: 0.2,
    textureRealSize: { width: 1, height: 1 },
    pricePerSqFt: 25,
    laborPerSqFt: 20,
    thumbnail: '/materials/thumbnails/glass-blue.jpg',
    description: 'Stunning blue glass mosaic',
  },
];

// ============================================================================
// All Materials
// ============================================================================

export const ALL_MATERIALS: Material[] = [
  ...FLOORING_MATERIALS,
  ...PAINT_MATERIALS,
  ...COUNTERTOP_MATERIALS,
  ...TILE_MATERIALS,
];

export function getMaterialById(id: string): Material | undefined {
  return ALL_MATERIALS.find(m => m.id === id);
}

export function getMaterialsByCategory(category: Material['category']): Material[] {
  return ALL_MATERIALS.filter(m => m.category === category);
}

// ============================================================================
// Fixture Library (3D Models)
// ============================================================================

export interface Fixture {
  id: string;
  name: string;
  category: 'vanity' | 'toilet' | 'bathtub' | 'sink' | 'faucet' | 'lighting' | 'appliance';
  
  // 3D model file (GLB format)
  modelUrl: string;
  
  // Real-world dimensions in inches
  dimensions: {
    width: number;
    height: number;
    depth: number;
  };
  
  // Pricing
  productPrice: number;
  installationPrice: number;
  
  // Display
  thumbnail: string;
  description: string;
  brand?: string;
  model?: string;
}

export const FIXTURES: Fixture[] = [
  {
    id: 'vanity-modern-36',
    name: 'Modern Floating Vanity 36"',
    category: 'vanity',
    modelUrl: '/models/fixtures/vanity-modern-36.glb',
    dimensions: { width: 36, height: 20, depth: 22 },
    productPrice: 650,
    installationPrice: 250,
    thumbnail: '/materials/thumbnails/vanity-modern.jpg',
    description: 'Modern floating vanity with soft-close drawers',
    brand: 'Generic',
  },
  {
    id: 'vanity-modern-48',
    name: 'Modern Floating Vanity 48"',
    category: 'vanity',
    modelUrl: '/models/fixtures/vanity-modern-48.glb',
    dimensions: { width: 48, height: 20, depth: 22 },
    productPrice: 850,
    installationPrice: 300,
    thumbnail: '/materials/thumbnails/vanity-modern-48.jpg',
    description: 'Double-sink modern floating vanity',
    brand: 'Generic',
  },
  {
    id: 'toilet-comfort-height',
    name: 'Comfort Height Toilet',
    category: 'toilet',
    modelUrl: '/models/fixtures/toilet-comfort.glb',
    dimensions: { width: 14.5, height: 17, depth: 28 },
    productPrice: 350,
    installationPrice: 200,
    thumbnail: '/materials/thumbnails/toilet-comfort.jpg',
    description: 'ADA-compliant comfort height elongated toilet',
    brand: 'Generic',
  },
  {
    id: 'faucet-modern-chrome',
    name: 'Modern Chrome Faucet',
    category: 'faucet',
    modelUrl: '/models/fixtures/faucet-chrome.glb',
    dimensions: { width: 5, height: 8, depth: 6 },
    productPrice: 180,
    installationPrice: 75,
    thumbnail: '/materials/thumbnails/faucet-chrome.jpg',
    description: 'Single-handle modern chrome faucet',
    brand: 'Generic',
  },
];

export function getFixtureById(id: string): Fixture | undefined {
  return FIXTURES.find(f => f.id === id);
}

export function getFixturesByCategory(category: Fixture['category']): Fixture[] {
  return FIXTURES.filter(f => f.category === category);
}
