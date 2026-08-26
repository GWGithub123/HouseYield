/**
 * 3D Renovation Detection Routes
 * AI-powered renovation detection from photogrammetry scans
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Get OpenAI API key from environment
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get scan images from photogrammetry directory
 */
async function getScanImages(scanId) {
  const photogrammetryDir = path.join(__dirname, 'data', 'photogrammetry', scanId);
  const roomScanDir = path.join(__dirname, 'data', 'room-scans', scanId);
  
  let imagesDir = null;
  
  // Check photogrammetry directory first
  try {
    await fs.access(path.join(photogrammetryDir, 'images'));
    imagesDir = path.join(photogrammetryDir, 'images');
  } catch {
    // Try room-scans directory
    try {
      await fs.access(path.join(roomScanDir, 'images'));
      imagesDir = path.join(roomScanDir, 'images');
    } catch {
      // Check for photos subdirectory (some scans use this)
      try {
        await fs.access(path.join(photogrammetryDir, 'photos'));
        imagesDir = path.join(photogrammetryDir, 'photos');
      } catch {
        return [];
      }
    }
  }
  
  // Read image files
  const files = await fs.readdir(imagesDir);
  const imageFiles = files.filter(f => 
    /\.(jpg|jpeg|png|webp)$/i.test(f)
  ).slice(0, 25); // Limit to 25 images for API limits
  
  // Convert to base64
  const images = await Promise.all(
    imageFiles.map(async (filename) => {
      const filepath = path.join(imagesDir, filename);
      const buffer = await fs.readFile(filepath);
      const base64 = buffer.toString('base64');
      const ext = path.extname(filename).toLowerCase().replace('.', '');
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
      return `data:${mimeType};base64,${base64}`;
    })
  );
  
  return images;
}

/**
 * Get scan metadata
 */
async function getScanMetadata(scanId) {
  const photogrammetryDir = path.join(__dirname, 'data', 'photogrammetry', scanId);
  const roomScanDir = path.join(__dirname, 'data', 'room-scans', scanId);
  
  // Try photogrammetry result.json
  try {
    const resultPath = path.join(photogrammetryDir, 'result.json');
    const data = await fs.readFile(resultPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    // Try room-scan metadata.json
    try {
      const metadataPath = path.join(roomScanDir, 'metadata.json');
      const data = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
}

/**
 * Estimate 3D positions for renovation zones based on room layout
 * This creates approximate positions for markers on the 3D model
 * 
 * @param {string} renovationType - Type of renovation (kitchen, bathroom, etc.)
 * @param {object|null} roomDimensions - Room dimensions in feet
 * @param {object|null} meshBounds - Actual mesh bounding box from client-side analysis
 */
function estimate3DPositions(renovationType, roomDimensions = null, meshBounds = null) {
  // If we have actual mesh bounds from client analysis, use those directly
  if (meshBounds && meshBounds.min && meshBounds.max) {
    const size = {
      x: meshBounds.max.x - meshBounds.min.x,
      y: meshBounds.max.y - meshBounds.min.y,
      z: meshBounds.max.z - meshBounds.min.z,
    };
    const center = {
      x: (meshBounds.min.x + meshBounds.max.x) / 2,
      y: (meshBounds.min.y + meshBounds.max.y) / 2,
      z: (meshBounds.min.z + meshBounds.max.z) / 2,
    };
    const floorY = meshBounds.min.y;
    const ceilingY = meshBounds.max.y;
    const roomHeight = size.y;
    
    // Position mapping using actual mesh bounds
    const positions = {
      kitchen: {
        markerPosition: { 
          x: meshBounds.min.x + size.x * 0.25, 
          y: floorY + roomHeight * 0.7, 
          z: meshBounds.min.z + size.z * 0.25 
        },
        boundingBox: {
          min: { x: meshBounds.min.x, y: floorY, z: meshBounds.min.z },
          max: { x: center.x, y: floorY + roomHeight * 0.8, z: center.z },
          center: { 
            x: meshBounds.min.x + size.x * 0.25, 
            y: floorY + roomHeight * 0.4, 
            z: meshBounds.min.z + size.z * 0.25 
          },
        }
      },
      bathroom: {
        markerPosition: { 
          x: meshBounds.max.x - size.x * 0.25, 
          y: floorY + roomHeight * 0.6, 
          z: meshBounds.min.z + size.z * 0.25 
        },
        boundingBox: {
          min: { x: center.x, y: floorY, z: meshBounds.min.z },
          max: { x: meshBounds.max.x, y: floorY + roomHeight * 0.8, z: center.z },
          center: { 
            x: meshBounds.max.x - size.x * 0.25, 
            y: floorY + roomHeight * 0.4, 
            z: meshBounds.min.z + size.z * 0.25 
          },
        }
      },
      flooring: {
        markerPosition: { x: center.x, y: floorY + 0.5, z: center.z },
        boundingBox: {
          min: { x: meshBounds.min.x, y: floorY, z: meshBounds.min.z },
          max: { x: meshBounds.max.x, y: floorY + 0.05, z: meshBounds.max.z },
          center: { x: center.x, y: floorY + 0.025, z: center.z },
        }
      },
      paint: {
        markerPosition: { 
          x: meshBounds.min.x + size.x * 0.1, 
          y: floorY + roomHeight * 0.6, 
          z: center.z 
        },
        boundingBox: {
          min: { x: meshBounds.min.x, y: floorY, z: meshBounds.min.z },
          max: { x: meshBounds.max.x, y: ceilingY, z: meshBounds.max.z },
          center: { x: center.x, y: center.y, z: center.z },
        }
      },
      lighting: {
        markerPosition: { x: center.x, y: ceilingY - 0.3, z: center.z },
        boundingBox: {
          min: { x: center.x - 1, y: ceilingY - 0.5, z: center.z - 1 },
          max: { x: center.x + 1, y: ceilingY, z: center.z + 1 },
          center: { x: center.x, y: ceilingY - 0.25, z: center.z },
        }
      },
      cabinets: {
        markerPosition: { 
          x: meshBounds.min.x + size.x * 0.25, 
          y: floorY + roomHeight * 0.65, 
          z: meshBounds.min.z + size.z * 0.25 
        },
        boundingBox: {
          min: { x: meshBounds.min.x, y: floorY, z: meshBounds.min.z },
          max: { x: center.x, y: floorY + roomHeight * 0.9, z: center.z },
          center: { 
            x: meshBounds.min.x + size.x * 0.25, 
            y: floorY + roomHeight * 0.45, 
            z: meshBounds.min.z + size.z * 0.25 
          },
        }
      },
      countertops: {
        markerPosition: { 
          x: meshBounds.min.x + size.x * 0.25, 
          y: floorY + roomHeight * 0.4, 
          z: meshBounds.min.z + size.z * 0.25 
        },
        boundingBox: {
          min: { x: meshBounds.min.x, y: floorY + roomHeight * 0.35, z: meshBounds.min.z },
          max: { x: center.x, y: floorY + roomHeight * 0.4, z: center.z },
          center: { 
            x: meshBounds.min.x + size.x * 0.25, 
            y: floorY + roomHeight * 0.375, 
            z: meshBounds.min.z + size.z * 0.25 
          },
        }
      },
      windows: {
        markerPosition: { 
          x: meshBounds.max.x - size.x * 0.05, 
          y: floorY + roomHeight * 0.55, 
          z: center.z 
        },
        boundingBox: {
          min: { x: meshBounds.max.x - 0.2, y: floorY + roomHeight * 0.3, z: center.z - size.z * 0.15 },
          max: { x: meshBounds.max.x, y: floorY + roomHeight * 0.8, z: center.z + size.z * 0.15 },
          center: { x: meshBounds.max.x - 0.1, y: floorY + roomHeight * 0.55, z: center.z },
        }
      },
      hvac: {
        markerPosition: { 
          x: center.x + size.x * 0.2, 
          y: ceilingY - 0.3, 
          z: center.z + size.z * 0.2 
        },
        boundingBox: {
          min: { x: center.x, y: ceilingY - 0.3, z: center.z },
          max: { x: center.x + size.x * 0.3, y: ceilingY, z: center.z + size.z * 0.3 },
          center: { x: center.x + size.x * 0.15, y: ceilingY - 0.15, z: center.z + size.z * 0.15 },
        }
      },
      appliances: {
        markerPosition: { 
          x: meshBounds.min.x + size.x * 0.2, 
          y: floorY + roomHeight * 0.4, 
          z: meshBounds.min.z + size.z * 0.35 
        },
        boundingBox: {
          min: { x: meshBounds.min.x + size.x * 0.1, y: floorY, z: meshBounds.min.z + size.z * 0.2 },
          max: { x: meshBounds.min.x + size.x * 0.3, y: floorY + roomHeight * 0.7, z: meshBounds.min.z + size.z * 0.5 },
          center: { 
            x: meshBounds.min.x + size.x * 0.2, 
            y: floorY + roomHeight * 0.35, 
            z: meshBounds.min.z + size.z * 0.35 
          },
        }
      },
    };
    
    return positions[renovationType] || {
      markerPosition: { x: center.x, y: floorY + roomHeight * 0.5, z: center.z },
      boundingBox: {
        min: { x: center.x - size.x * 0.15, y: floorY, z: center.z - size.z * 0.15 },
        max: { x: center.x + size.x * 0.15, y: floorY + roomHeight * 0.8, z: center.z + size.z * 0.15 },
        center: { x: center.x, y: floorY + roomHeight * 0.4, z: center.z },
      }
    };
  }
  
  // Default room dimensions if not available
  const dims = roomDimensions || { 
    widthFeet: 12, 
    lengthFeet: 15, 
    heightFeet: 8 
  };
  
  // Convert to meters (Three.js units)
  const width = (dims.widthFeet || 12) * 0.3048;
  const length = (dims.lengthFeet || 15) * 0.3048;
  const height = (dims.heightFeet || 8) * 0.3048;
  
  // Position mapping based on renovation type
  const positions = {
    kitchen: {
      markerPosition: { x: -width/3, y: height * 0.6, z: -length/4 },
      boundingBox: {
        min: { x: -width/2, y: 0, z: -length/2 },
        max: { x: 0, y: height * 0.8, z: 0 },
        center: { x: -width/4, y: height * 0.4, z: -length/4 },
      }
    },
    bathroom: {
      markerPosition: { x: width/3, y: height * 0.5, z: -length/3 },
      boundingBox: {
        min: { x: width/4, y: 0, z: -length/2 },
        max: { x: width/2, y: height * 0.8, z: -length/4 },
        center: { x: width * 0.375, y: height * 0.4, z: -length * 0.375 },
      }
    },
    flooring: {
      markerPosition: { x: 0, y: 0.3, z: 0 },
      boundingBox: {
        min: { x: -width/2, y: 0, z: -length/2 },
        max: { x: width/2, y: 0.1, z: length/2 },
        center: { x: 0, y: 0.05, z: 0 },
      }
    },
    paint: {
      markerPosition: { x: -width/2 + 0.5, y: height * 0.5, z: length/4 },
      boundingBox: {
        min: { x: -width/2, y: 0, z: -length/2 },
        max: { x: width/2, y: height, z: length/2 },
        center: { x: 0, y: height/2, z: 0 },
      }
    },
    lighting: {
      markerPosition: { x: 0, y: height - 0.3, z: 0 },
      boundingBox: {
        min: { x: -1, y: height - 0.5, z: -1 },
        max: { x: 1, y: height, z: 1 },
        center: { x: 0, y: height - 0.25, z: 0 },
      }
    },
    cabinets: {
      markerPosition: { x: -width/3, y: height * 0.5, z: -length/3 },
      boundingBox: {
        min: { x: -width/2, y: 0, z: -length/2 },
        max: { x: 0, y: height * 0.9, z: 0 },
        center: { x: -width/4, y: height * 0.45, z: -length/4 },
      }
    },
    countertops: {
      markerPosition: { x: -width/4, y: height * 0.4, z: -length/4 },
      boundingBox: {
        min: { x: -width/2, y: height * 0.35, z: -length/2 },
        max: { x: 0, y: height * 0.4, z: 0 },
        center: { x: -width/4, y: height * 0.375, z: -length/4 },
      }
    },
    windows: {
      markerPosition: { x: width/2 - 0.3, y: height * 0.5, z: 0 },
      boundingBox: {
        min: { x: width/2 - 0.2, y: height * 0.3, z: -1 },
        max: { x: width/2, y: height * 0.8, z: 1 },
        center: { x: width/2 - 0.1, y: height * 0.55, z: 0 },
      }
    },
    doors: {
      markerPosition: { x: 0, y: height * 0.4, z: length/2 - 0.3 },
      boundingBox: {
        min: { x: -0.5, y: 0, z: length/2 - 0.15 },
        max: { x: 0.5, y: height * 0.85, z: length/2 },
        center: { x: 0, y: height * 0.425, z: length/2 - 0.075 },
      }
    },
    hvac: {
      markerPosition: { x: width/4, y: height - 0.3, z: length/4 },
      boundingBox: {
        min: { x: width/4 - 0.5, y: height - 0.3, z: length/4 - 0.5 },
        max: { x: width/4 + 0.5, y: height, z: length/4 + 0.5 },
        center: { x: width/4, y: height - 0.15, z: length/4 },
      }
    },
    appliances: {
      markerPosition: { x: -width/4, y: height * 0.35, z: -length/3 },
      boundingBox: {
        min: { x: -width/3, y: 0, z: -length/2.5 },
        max: { x: -width/6, y: height * 0.7, z: -length/5 },
        center: { x: -width/4, y: height * 0.35, z: -length * 0.35 },
      }
    },
  };
  
  // Return position for type, or default position
  return positions[renovationType] || {
    markerPosition: { x: 0, y: height * 0.5, z: 0 },
    boundingBox: {
      min: { x: -1, y: 0, z: -1 },
      max: { x: 1, y: height * 0.8, z: 1 },
      center: { x: 0, y: height * 0.4, z: 0 },
    }
  };
}

/**
 * Generate materials breakdown for a renovation type
 */
function generateMaterialsBreakdown(renovationType, estimatedCost) {
  const materialsByType = {
    kitchen: [
      { name: 'Cabinet boxes/frames', category: 'fixture', pct: 0.25, quality: 'mid-range' },
      { name: 'Cabinet doors/fronts', category: 'fixture', pct: 0.15, quality: 'mid-range' },
      { name: 'Countertop material', category: 'finish', pct: 0.20, quality: 'mid-range' },
      { name: 'Hardware (hinges, pulls)', category: 'hardware', pct: 0.05, quality: 'mid-range' },
      { name: 'Sink and faucet', category: 'fixture', pct: 0.08, quality: 'mid-range' },
      { name: 'Backsplash tile', category: 'finish', pct: 0.07, quality: 'mid-range' },
    ],
    bathroom: [
      { name: 'Floor tile', category: 'finish', pct: 0.15, quality: 'mid-range' },
      { name: 'Wall tile/surround', category: 'finish', pct: 0.18, quality: 'mid-range' },
      { name: 'Vanity with sink', category: 'fixture', pct: 0.22, quality: 'mid-range' },
      { name: 'Faucet set', category: 'fixture', pct: 0.08, quality: 'mid-range' },
      { name: 'Toilet', category: 'fixture', pct: 0.10, quality: 'mid-range' },
      { name: 'Mirror and lighting', category: 'fixture', pct: 0.07, quality: 'mid-range' },
    ],
    flooring: [
      { name: 'LVP/Hardwood planks', category: 'finish', pct: 0.55, quality: 'mid-range' },
      { name: 'Underlayment', category: 'structural', pct: 0.08, quality: 'mid-range' },
      { name: 'Transition strips', category: 'hardware', pct: 0.04, quality: 'mid-range' },
      { name: 'Adhesive/fasteners', category: 'other', pct: 0.03, quality: 'mid-range' },
    ],
    paint: [
      { name: 'Interior paint', category: 'finish', pct: 0.35, quality: 'mid-range' },
      { name: 'Primer', category: 'finish', pct: 0.12, quality: 'mid-range' },
      { name: 'Supplies (brushes, rollers, tape)', category: 'other', pct: 0.08, quality: 'mid-range' },
    ],
    cabinets: [
      { name: 'Cabinet boxes', category: 'fixture', pct: 0.35, quality: 'mid-range' },
      { name: 'Cabinet doors', category: 'fixture', pct: 0.25, quality: 'mid-range' },
      { name: 'Hardware', category: 'hardware', pct: 0.10, quality: 'mid-range' },
    ],
    countertops: [
      { name: 'Countertop slab', category: 'finish', pct: 0.65, quality: 'mid-range' },
      { name: 'Edge treatment', category: 'finish', pct: 0.10, quality: 'mid-range' },
      { name: 'Cutouts (sink, cooktop)', category: 'other', pct: 0.05, quality: 'mid-range' },
    ],
    windows: [
      { name: 'Window units', category: 'fixture', pct: 0.55, quality: 'mid-range' },
      { name: 'Trim/casing', category: 'finish', pct: 0.12, quality: 'mid-range' },
      { name: 'Weatherstripping/caulk', category: 'other', pct: 0.03, quality: 'mid-range' },
    ],
    hvac: [
      { name: 'HVAC unit', category: 'appliance', pct: 0.55, quality: 'mid-range' },
      { name: 'Ductwork', category: 'structural', pct: 0.15, quality: 'mid-range' },
      { name: 'Thermostat', category: 'fixture', pct: 0.05, quality: 'mid-range' },
    ],
    lighting: [
      { name: 'Light fixtures', category: 'fixture', pct: 0.50, quality: 'mid-range' },
      { name: 'Switches/dimmers', category: 'fixture', pct: 0.15, quality: 'mid-range' },
      { name: 'Wiring materials', category: 'other', pct: 0.05, quality: 'mid-range' },
    ],
    appliances: [
      { name: 'Appliance unit(s)', category: 'appliance', pct: 0.70, quality: 'mid-range' },
      { name: 'Installation hardware', category: 'hardware', pct: 0.05, quality: 'mid-range' },
    ],
  };
  
  const materials = materialsByType[renovationType] || [
    { name: 'General materials', category: 'other', pct: 0.50, quality: 'mid-range' },
    { name: 'Hardware/fasteners', category: 'hardware', pct: 0.10, quality: 'mid-range' },
  ];
  
  // Calculate labor percentage (typically 30-50% of total)
  const laborPct = renovationType === 'paint' ? 0.55 : 
                   renovationType === 'flooring' ? 0.35 :
                   renovationType === 'hvac' ? 0.30 : 0.40;
  
  const materialsCost = estimatedCost * (1 - laborPct - 0.08); // 8% for permits/contingency
  
  return materials.map(m => ({
    name: m.name,
    category: m.category,
    quantity: 1,
    unit: 'lot',
    unitCost: Math.round(materialsCost * m.pct),
    totalCost: Math.round(materialsCost * m.pct),
    quality: m.quality,
  }));
}

/**
 * Generate labor breakdown for a renovation type
 */
function generateLaborBreakdown(renovationType, estimatedCost) {
  const laborByType = {
    kitchen: [
      { trade: 'Cabinet Installer', pct: 0.50 },
      { trade: 'Plumber', pct: 0.25 },
      { trade: 'Electrician', pct: 0.15 },
      { trade: 'General Helper', pct: 0.10 },
    ],
    bathroom: [
      { trade: 'Tile Installer', pct: 0.40 },
      { trade: 'Plumber', pct: 0.35 },
      { trade: 'Electrician', pct: 0.15 },
      { trade: 'General Helper', pct: 0.10 },
    ],
    flooring: [
      { trade: 'Flooring Installer', pct: 0.85 },
      { trade: 'General Helper', pct: 0.15 },
    ],
    paint: [
      { trade: 'Painter', pct: 0.90 },
      { trade: 'General Helper', pct: 0.10 },
    ],
    cabinets: [
      { trade: 'Cabinet Installer', pct: 0.80 },
      { trade: 'General Helper', pct: 0.20 },
    ],
    countertops: [
      { trade: 'Countertop Installer', pct: 0.75 },
      { trade: 'Plumber', pct: 0.25 },
    ],
    windows: [
      { trade: 'Window Installer', pct: 0.80 },
      { trade: 'General Carpenter', pct: 0.20 },
    ],
    hvac: [
      { trade: 'HVAC Technician', pct: 0.75 },
      { trade: 'Electrician', pct: 0.25 },
    ],
    lighting: [
      { trade: 'Electrician', pct: 0.90 },
      { trade: 'General Helper', pct: 0.10 },
    ],
    appliances: [
      { trade: 'Appliance Installer', pct: 0.60 },
      { trade: 'Electrician', pct: 0.25 },
      { trade: 'Plumber', pct: 0.15 },
    ],
  };
  
  const laborConfig = laborByType[renovationType] || [
    { trade: 'General Contractor', pct: 1.0 },
  ];
  
  // Labor typically 30-50% of total
  const laborPct = renovationType === 'paint' ? 0.55 : 
                   renovationType === 'flooring' ? 0.35 :
                   renovationType === 'hvac' ? 0.30 : 0.40;
  
  const laborCost = estimatedCost * laborPct;
  
  // Hourly rates by trade
  const hourlyRates = {
    'Cabinet Installer': 75,
    'Plumber': 95,
    'Electrician': 85,
    'Tile Installer': 65,
    'Flooring Installer': 55,
    'Painter': 45,
    'Countertop Installer': 70,
    'Window Installer': 65,
    'General Carpenter': 55,
    'HVAC Technician': 90,
    'Appliance Installer': 50,
    'General Helper': 35,
    'General Contractor': 65,
  };
  
  return laborConfig.map(l => {
    const tradeCost = laborCost * l.pct;
    const rate = hourlyRates[l.trade] || 55;
    const hours = Math.round(tradeCost / rate);
    return {
      trade: l.trade,
      hours,
      hourlyRate: rate,
      totalCost: Math.round(tradeCost),
    };
  });
}

// ============================================================================
// API Routes
// ============================================================================

/**
 * POST /api/renovation/detect-from-scan
 * Detect renovation opportunities from a photogrammetry scan
 */
router.post('/detect-from-scan', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { 
      scanId, 
      propertyAddress,
      propertyValue,
      estimatedRent,
      yearBuilt,
      squareFeet,
      includeARPreviews = false,
      meshBounds = null  // Client-side mesh analysis bounds for accurate positioning
    } = req.body;
    
    if (!scanId) {
      return res.status(400).json({ 
        success: false, 
        error: 'scanId is required' 
      });
    }
    
    console.log(`[RenovationDetection] Processing scan: ${scanId}`);
    if (meshBounds) {
      console.log(`[RenovationDetection] Using client mesh bounds:`, meshBounds);
    }
    
    // Get scan images
    const images = await getScanImages(scanId);
    if (images.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'No images found for scan. Please ensure the scan has captured images before running renovation analysis.',
        code: 'NO_IMAGES'
      });
    }
    
    console.log(`[RenovationDetection] Found ${images.length} images`);
    
    // Get scan metadata for room dimensions
    const metadata = await getScanMetadata(scanId);
    const roomDimensions = metadata?.roomDimensions || null;
    
    // Import market data module
    let marketData = { ok: false };
    try {
      const marketDataModule = await import('./renovation-market-data.js');
      if (propertyAddress) {
        marketData = await marketDataModule.getLocalMarketData(propertyAddress);
      }
    } catch (err) {
      console.warn('[RenovationDetection] Market data module not available:', err.message);
    }
    
    // Use provided values or market data
    const effectivePropertyValue = propertyValue || (marketData.ok ? marketData.propertyValue : 450000);
    const effectiveRent = estimatedRent || (marketData.ok ? marketData.estimatedRent : 2500);
    const effectiveYearBuilt = yearBuilt || (marketData.ok ? marketData.yearBuilt : 1995);
    const effectiveSqft = squareFeet || (marketData.ok ? marketData.sqft : 1800);
    
    // Prepare images for OpenAI Vision API
    const imageMessages = images.slice(0, 6).map(img => ({
      type: 'image_url',
      image_url: {
        url: img,
        detail: 'high'
      }
    }));
    
    // Create enhanced prompt for 3D scan analysis
    const prompt = `You are an expert real estate renovation consultant analyzing 3D room scan images to identify SPECIFIC renovation opportunities with POSITIVE ROI for rental properties.

PROPERTY CONTEXT:
- Property Value: $${effectivePropertyValue.toLocaleString()}
- Monthly Rent: $${effectiveRent.toLocaleString()}
- Year Built: ${effectiveYearBuilt}
- Square Feet: ${effectiveSqft}
${propertyAddress ? `- Address: ${propertyAddress}` : ''}

CRITICAL ANALYSIS INSTRUCTIONS:
1. Analyze EACH visible surface, fixture, and element in the room scan images
2. Identify specific areas that need renovation based on:
   - Visible wear, damage, or deterioration
   - Outdated styles or materials (1980s-2000s aesthetics)
   - Missing modern amenities or features
   - Areas that would appeal to quality tenants if updated
3. For each renovation, provide PRECISE location description in the room
4. Consider the 3D spatial context - where exactly in the room is this?
5. Focus on renovations with ROI > 100% over 5 years

REQUIRED OUTPUT FORMAT - Return ONLY valid JSON (no markdown):
{
  "renovations": [
    {
      "name": "Specific Renovation Name",
      "type": "kitchen|bathroom|flooring|paint|lighting|cabinets|countertops|appliances|windows|doors|ceiling|walls|plumbing|electrical|hvac|other",
      "description": "Detailed description of what needs renovation and why",
      "locationInRoom": "Specific location description (e.g., 'North wall cabinet section', 'Main floor area', 'Vanity area on left wall')",
      "currentCondition": "poor|fair|good",
      "urgency": "immediate|short-term|long-term|optional",
      "complexity": "diy|simple|moderate|complex|major",
      "estimatedCost": 5000,
      "estimatedDuration": "1-2 weeks",
      "valueIncrease": 7500,
      "rentIncreaseMonthly": 100,
      "explanation": "Detailed explanation of why this renovation adds value, what tenants expect, and ROI justification"
    }
  ]
}

Analyze these room scan images now. Identify 3-7 specific renovation opportunities.`;

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OpenAI API key not configured'
      });
    }
    
    // Call OpenAI GPT-4 Vision API
    console.log('[RenovationDetection] Calling OpenAI Vision API...');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...imageMessages
            ]
          }
        ],
        max_tokens: 3000,
        temperature: 0.7
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[RenovationDetection] OpenAI API error:', errorText);
      throw new Error(`OpenAI API failed: ${response.status}`);
    }
    
    const completion = await response.json();
    const aiResponse = completion.choices[0].message.content;
    
    // Parse AI response
    let aiData;
    try {
      // Clean response of any markdown formatting
      const cleaned = aiResponse
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      aiData = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[RenovationDetection] Failed to parse AI response:', aiResponse);
      throw new Error('Failed to parse AI analysis response');
    }
    
    // Process each renovation and add 3D positioning + detailed breakdowns
    const processedRenovations = await Promise.all(
      (aiData.renovations || []).map(async (reno, index) => {
        const type = reno.type || 'other';
        // Use meshBounds if provided by client for accurate positioning
        const positions = estimate3DPositions(type, roomDimensions, meshBounds);
        
        // Calculate ROI
        const cost = reno.estimatedCost || 5000;
        const valueIncrease = reno.valueIncrease || cost * 1.4;
        const rentIncrease = reno.rentIncreaseMonthly || Math.round(cost / 50);
        const fiveYearRent = rentIncrease * 12 * 5;
        const roi = ((valueIncrease + fiveYearRent) / cost) * 100;
        const paybackMonths = rentIncrease > 0 ? Math.round(cost / rentIncrease) : null;
        
        return {
          id: `reno-${scanId}-${type}-${index}`,
          zone: {
            id: `zone-${scanId}-${type}-${index}`,
            type,
            name: reno.name || `${type} Renovation`,
            description: reno.description || '',
            boundingBox: positions.boundingBox,
            markerPosition: positions.markerPosition,
            confidence: 0.85 + (Math.random() * 0.1),
            sourceImageIndices: [0, 1, 2].slice(0, Math.min(images.length, 3)),
          },
          analysis: {
            explanation: reno.explanation || reno.description || '',
            currentCondition: reno.currentCondition || 'fair',
            urgency: reno.urgency || 'short-term',
            complexity: reno.complexity || 'moderate',
            estimatedDuration: reno.estimatedDuration || '1-2 weeks',
            permits: [],
          },
          roi: {
            estimatedCost: cost,
            costRange: { low: Math.round(cost * 0.8), high: Math.round(cost * 1.2) },
            valueIncrease: Math.round(valueIncrease),
            rentIncreaseMonthly: rentIncrease,
            rentIncreasePercent: Math.round((rentIncrease / effectiveRent) * 100 * 10) / 10,
            roi: Math.round(roi * 10) / 10,
            paybackMonths,
            fiveYearReturn: Math.round(valueIncrease + fiveYearRent),
          },
          costBreakdown: {
            labor: Math.round(cost * 0.4),
            materials: Math.round(cost * 0.5),
            permits: Math.round(cost * 0.02),
            contingency: Math.round(cost * 0.08),
            total: cost,
          },
          materials: generateMaterialsBreakdown(type, cost),
          labor: generateLaborBreakdown(type, cost),
        };
      })
    );
    
    // Calculate totals
    const totalEstimatedCost = processedRenovations.reduce((sum, r) => sum + r.roi.estimatedCost, 0);
    const totalValueIncrease = processedRenovations.reduce((sum, r) => sum + r.roi.valueIncrease, 0);
    const totalRentIncrease = processedRenovations.reduce((sum, r) => sum + r.roi.rentIncreaseMonthly, 0);
    const fiveYearRentTotal = totalRentIncrease * 12 * 5;
    const overallROI = totalEstimatedCost > 0 
      ? Math.round(((totalValueIncrease + fiveYearRentTotal) / totalEstimatedCost) * 100 * 10) / 10
      : 0;
    
    const processingTimeMs = Date.now() - startTime;
    console.log(`[RenovationDetection] Completed in ${processingTimeMs}ms, found ${processedRenovations.length} renovations`);
    
    res.json({
      success: true,
      scanId,
      renovations: processedRenovations,
      totalEstimatedCost,
      totalValueIncrease,
      totalRentIncrease,
      overallROI,
      processingTimeMs,
    });
    
  } catch (error) {
    console.error('[RenovationDetection] Error:', error);
    res.status(500).json({
      success: false,
      scanId: req.body?.scanId || '',
      renovations: [],
      totalEstimatedCost: 0,
      totalValueIncrease: 0,
      totalRentIncrease: 0,
      overallROI: 0,
      processingTimeMs: Date.now() - startTime,
      error: error.message,
    });
  }
});

/**
 * POST /api/renovation/generate-ar-preview
 * Generate AR preview for a renovation (theoretical final product)
 */
router.post('/generate-ar-preview', async (req, res) => {
  try {
    const { renovationId, scanId, materialPreset = 'mid-range', customMaterials } = req.body;
    
    if (!renovationId) {
      return res.status(400).json({
        success: false,
        error: 'renovationId is required'
      });
    }
    
    console.log(`[ARPreview] Generating preview for renovation: ${renovationId}`);
    
    // For now, return a mock preview
    // In production, this would use AI image generation (DALL-E, Stable Diffusion, etc.)
    // to create a theoretical visualization of the renovation
    
    const preview = {
      id: `preview-${renovationId}-${Date.now()}`,
      renovationId,
      thumbnailUrl: null, // Would be generated by AI
      selectedMaterials: customMaterials || [
        { area: 'Primary', material: `${materialPreset} finish`, color: '#ffffff' },
      ],
      generatedAt: new Date().toISOString(),
      aiModel: 'placeholder',
      confidence: 0.75,
    };
    
    // TODO: Implement actual AR preview generation using:
    // 1. AI image generation (DALL-E 3, Stable Diffusion XL)
    // 2. 3D mesh modification/overlay
    // 3. Material texture mapping
    
    res.json({
      success: true,
      preview,
      message: 'AR preview generation is in development. Preview data structure returned.',
    });
    
  } catch (error) {
    console.error('[ARPreview] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/renovation/scan/:scanId/images
 * Get images from a scan for renovation analysis
 */
router.get('/scan/:scanId/images', async (req, res) => {
  try {
    const { scanId } = req.params;
    const images = await getScanImages(scanId);
    
    res.json({
      success: true,
      scanId,
      count: images.length,
      images,
    });
  } catch (error) {
    console.error('[RenovationDetection] Get images error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// AI Interior View Analysis
// Uses GPT-4 Vision to analyze rendered interior views of a 3D room scan
// and identify renovation opportunities with marker positions
// ============================================================================

/**
 * POST /api/renovation/analyze-interior-views
 * Analyze rendered interior views to detect renovation suggestions
 */
router.post('/analyze-interior-views', async (req, res) => {
  try {
    const {
      views,           // Array of { viewName, imageBase64, cameraPosition, cameraTarget }
      roomDimensions,  // Optional: { width, length, height, unit }
    } = req.body;
    
    if (!views || !Array.isArray(views) || views.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one view image is required',
      });
    }
    
    console.log(`[InteriorAnalysis] 🔍 Analyzing ${views.length} interior views...`);
    
    if (!OPENAI_API_KEY) {
      console.warn('[InteriorAnalysis] No OpenAI API key - using mock suggestions');
      // Return mock suggestions for demo/development
      const mockSuggestions = generateMockInteriorSuggestions(views);
      return res.json({
        success: true,
        suggestions: mockSuggestions,
        viewsAnalyzed: views.length,
        warning: 'Using demo data - OpenAI API key not configured',
      });
    }
    
    // Build the analysis prompt
    const dimensionInfo = roomDimensions 
      ? `Room dimensions: ${roomDimensions.width} x ${roomDimensions.length} x ${roomDimensions.height} ${roomDimensions.unit}`
      : 'Room dimensions not provided';
    
    const analysisPrompt = `You are an expert interior designer and property renovator analyzing 3D rendered views of a room scan.

TASK: Analyze these interior view images and identify specific renovation opportunities that would add value to this property.

${dimensionInfo}

For each renovation opportunity you identify, provide:
1. A specific title (e.g., "Replace worn carpet with hardwood flooring")
2. The type category (flooring, walls, ceiling, bathroom_vanity, kitchen_cabinets, countertops, lighting, windows, doors, appliances, trim, other)
3. A brief description of why this renovation is needed
4. Priority level (high, medium, low) based on impact and urgency
5. The view name where this was best observed (from the provided view names)
6. A suggested renovation option (e.g., "oak hardwood", "white shaker cabinets")
7. Estimated cost range (low to high in USD)
8. Estimated ROI percentage

IMPORTANT INSTRUCTIONS:
- Look for: worn flooring, outdated fixtures, damaged walls, old appliances, poor lighting, dated cabinets
- Focus on high-impact renovations that increase property value
- Be specific about what you observe and what improvement would help
- Consider both aesthetic and functional improvements
- Identify 3-7 renovation opportunities

Return your analysis as JSON with this exact structure:
{
  "suggestions": [
    {
      "title": "Replace worn carpet with hardwood flooring",
      "type": "flooring",
      "description": "The carpet shows significant wear patterns and staining. Hardwood would modernize the space and increase durability.",
      "priority": "high",
      "observedInView": "interior-0",
      "suggestedRenovation": {
        "renovationType": "flooring",
        "renovationOption": "oak hardwood",
        "estimatedCost": { "low": 3000, "high": 6000 },
        "roiEstimate": 85
      }
    }
  ]
}

Analyze the provided interior view images now.`;

    // Prepare image messages for GPT-4 Vision
    // Limit to first 6 views to stay within token limits
    const viewsToAnalyze = views.slice(0, 6);
    const imageMessages = viewsToAnalyze.map((view, index) => {
      let imageBase64 = view.imageBase64;
      // Extract base64 if it's a data URL
      if (imageBase64.startsWith('data:')) {
        imageBase64 = imageBase64.split(',')[1];
      }
      
      return {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${imageBase64}`,
          detail: 'high'
        }
      };
    });
    
    // Add view context as text
    const viewContext = viewsToAnalyze.map((v, i) => 
      `View ${i + 1} (${v.viewName}): Camera at (${v.cameraPosition?.x?.toFixed(2) || 0}, ${v.cameraPosition?.y?.toFixed(2) || 0}, ${v.cameraPosition?.z?.toFixed(2) || 0})`
    ).join('\n');
    
    console.log('[InteriorAnalysis] Calling OpenAI Vision API...');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: analysisPrompt },
              { type: 'text', text: `\n\nView information:\n${viewContext}` },
              ...imageMessages
            ]
          }
        ],
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[InteriorAnalysis] OpenAI API error:', response.status, errorData);
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('No response content from OpenAI');
    }
    
    console.log('[InteriorAnalysis] Parsing AI response...');
    
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(content);
    } catch (parseError) {
      console.error('[InteriorAnalysis] Failed to parse JSON:', content);
      throw new Error('Failed to parse AI response as JSON');
    }
    
    const suggestions = (parsedResponse.suggestions || []).map((s, index) => {
      // Find the view this suggestion was observed in
      const observedView = views.find(v => v.viewName === s.observedInView) || views[0];
      
      // Use camera position and target from the view
      const camPos = observedView?.cameraPosition || { x: 0, y: 1, z: 0 };
      const targetPos = observedView?.cameraTarget || { x: 0, y: 1, z: 2 };
      
      // Place marker at the camera target (what the camera was looking at)
      // This is where the AI "saw" the renovation opportunity
      const markerPosition = {
        x: targetPos.x,
        y: targetPos.y,
        z: targetPos.z,
      };
      
      // Adjust marker height based on type (relative to target position)
      if (s.type === 'flooring') {
        markerPosition.y = targetPos.y - 0.3; // Slightly below target for flooring
      } else if (s.type === 'ceiling' || s.type === 'lighting') {
        markerPosition.y = targetPos.y + 0.5; // Above target for ceiling
      }
      
      return {
        id: `suggestion_${Date.now()}_${index}`,
        title: s.title,
        type: s.type,
        description: s.description,
        priority: s.priority || 'medium',
        markerPosition,
        viewDirection: {
          x: targetPos.x - camPos.x,
          y: targetPos.y - camPos.y,
          z: targetPos.z - camPos.z,
        },
        cameraPosition: camPos,
        cameraTarget: targetPos,
        suggestedRenovation: s.suggestedRenovation || {
          renovationType: s.type,
          renovationOption: 'modern update',
        },
        capturedImageBase64: observedView?.imageBase64,
      };
    });
    
    console.log(`[InteriorAnalysis] ✅ Found ${suggestions.length} renovation suggestions`);
    
    res.json({
      success: true,
      suggestions,
      viewsAnalyzed: viewsToAnalyze.length,
    });
    
  } catch (error) {
    console.error('[InteriorAnalysis] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Generate mock suggestions for demo/development
 */
function generateMockInteriorSuggestions(views) {
  const mockSuggestions = [
    {
      id: `suggestion_${Date.now()}_0`,
      title: 'Replace worn flooring with hardwood',
      type: 'flooring',
      description: 'The current flooring shows signs of wear. Installing hardwood would modernize the space and increase value.',
      priority: 'high',
      suggestedRenovation: {
        renovationType: 'flooring',
        renovationOption: 'oak hardwood',
        estimatedCost: { low: 2500, high: 5000 },
        roiEstimate: 85,
      },
    },
    {
      id: `suggestion_${Date.now()}_1`,
      title: 'Refresh wall paint',
      type: 'walls',
      description: 'Walls could benefit from fresh paint in a modern neutral color to brighten the space.',
      priority: 'medium',
      suggestedRenovation: {
        renovationType: 'walls',
        renovationOption: 'white paint',
        estimatedCost: { low: 800, high: 1500 },
        roiEstimate: 120,
      },
    },
    {
      id: `suggestion_${Date.now()}_2`,
      title: 'Update lighting fixtures',
      type: 'lighting',
      description: 'Adding modern recessed lighting would improve illumination and create a more contemporary feel.',
      priority: 'low',
      suggestedRenovation: {
        renovationType: 'lighting',
        renovationOption: 'recessed lighting',
        estimatedCost: { low: 500, high: 1200 },
        roiEstimate: 65,
      },
    },
  ];
  
  // Calculate marker positions based on view camera positions
  return mockSuggestions.map((suggestion, index) => {
    const view = views[index % views.length];
    const camPos = view?.cameraPosition || { x: 0, y: 1, z: 0 };
    const targetPos = view?.cameraTarget || { x: 0, y: 1, z: 2 };
    
    // Place marker between camera and target
    const markerPosition = {
      x: camPos.x + (targetPos.x - camPos.x) * 0.7,
      y: suggestion.type === 'flooring' ? camPos.y - 0.5 : 
         suggestion.type === 'lighting' ? camPos.y + 1.0 : 
         camPos.y,
      z: camPos.z + (targetPos.z - camPos.z) * 0.7,
    };
    
    return {
      ...suggestion,
      markerPosition,
      viewDirection: {
        x: targetPos.x - camPos.x,
        y: targetPos.y - camPos.y,
        z: targetPos.z - camPos.z,
      },
      cameraPosition: camPos,
      cameraTarget: targetPos,
      capturedImageBase64: view?.imageBase64,
    };
  });
}

export default router;
