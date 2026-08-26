// Pooling Detection Service - Phase 1
// Analyzes micro-topography to identify depressions where water pools during storms
// Uses USGS elevation data to create DEM (Digital Elevation Model) and detect low points

/**
 * Fetch elevation grid around a property
 * Creates a high-resolution DEM for flow analysis
 */
async function fetchElevationGrid(centerLat, centerLng, gridSize = 15, spacing = 0.0001) {
  console.log(`[Pooling] Fetching ${gridSize}x${gridSize} elevation grid centered at ${centerLat}, ${centerLng}`);
  
  const gridPoints = [];
  const halfGrid = Math.floor(gridSize / 2);
  
  // Create grid of points (spacing ~11m per 0.0001 degrees - HIGH RESOLUTION for accuracy)
  for (let i = -halfGrid; i <= halfGrid; i++) {
    for (let j = -halfGrid; j <= halfGrid; j++) {
      gridPoints.push({
        lat: centerLat + (i * spacing),
        lng: centerLng + (j * spacing),
        row: i + halfGrid,
        col: j + halfGrid
      });
    }
  }
  
  console.log(`[Pooling] Fetching elevation for ${gridPoints.length} points...`);
  
  // Fetch elevations in parallel (batched to avoid overwhelming API)
  const batchSize = 10; // Open-Elevation is faster, can handle larger batches
  const elevationGrid = [];
  
  for (let i = 0; i < gridPoints.length; i += batchSize) {
    const batch = gridPoints.slice(i, i + batchSize);
    console.log(`[Pooling] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(gridPoints.length/batchSize)}`);
    const batchPromises = batch.map(async (point) => {
      try {
        const url = `https://epqs.nationalmap.gov/v1/json?x=${point.lng}&y=${point.lat}&units=Meters&wkid=4326&includeDate=false&key=${process.env.VITE_USGS_API_KEY || ''}`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
        
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const elevation = data?.value || 0;
        
        return {
          lat: point.lat,
          lng: point.lng,
          elevation: elevation,
          row: point.row,
          col: point.col
        };
      } catch (error) {
        console.error(`[Pooling] Failed to fetch elevation for ${point.lat}, ${point.lng}:`, error.message);
        return {
          lat: point.lat,
          lng: point.lng,
          elevation: 0,
          row: point.row,
          col: point.col
        };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    elevationGrid.push(...batchResults);
    
    // Minimal delay with API key - much higher rate limits
    if (i + batchSize < gridPoints.length) {
      await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay with API key
    }
  }
  
  console.log(`[Pooling] Fetched ${elevationGrid.length} elevation points from USGS API`);
  
  // Convert to 2D array for easier processing
  const grid2D = Array(gridSize).fill(null).map(() => Array(gridSize).fill(null));
  elevationGrid.forEach(point => {
    grid2D[point.row][point.col] = point;
  });
  
  return { grid: grid2D, gridSize, spacing, centerLat, centerLng };
}

/**
 * Detect depressions (local minima) in elevation grid
 * These are areas where water will pool
 */
function detectDepressions(elevationData) {
  const { grid, gridSize, spacing, centerLat, centerLng } = elevationData;
  const depressions = [];
  
  console.log('[Pooling] Analyzing grid for depressions...');
  
  // Check each interior point (not edges)
  for (let row = 1; row < gridSize - 1; row++) {
    for (let col = 1; col < gridSize - 1; col++) {
      const center = grid[row][col];
      if (!center || center.elevation === 0) continue;
      
      // Get 8 surrounding neighbors
      const neighbors = [
        grid[row - 1][col - 1], grid[row - 1][col], grid[row - 1][col + 1],
        grid[row][col - 1],                          grid[row][col + 1],
        grid[row + 1][col - 1], grid[row + 1][col], grid[row + 1][col + 1]
      ].filter(n => n && n.elevation !== 0);
      
      if (neighbors.length === 0) continue;
      
      // Check if this point is lower than ALL neighbors (true depression)
      const isDepression = neighbors.every(n => center.elevation < n.elevation);
      
      if (isDepression) {
        // Calculate depth of depression (how much lower than average neighbor)
        const avgNeighborElevation = neighbors.reduce((sum, n) => sum + n.elevation, 0) / neighbors.length;
        const depth = avgNeighborElevation - center.elevation;
        
        // Only consider significant depressions (> 0.3m depth)
        if (depth > 0.3) {
          // Calculate radius based on depression depth
          // Deeper depressions typically have larger pooling areas
          const radiusMeters = Math.min(40, Math.max(12, depth * 15)); // 12m to 40m range
          
          depressions.push({
            lat: center.lat,
            lng: center.lng,
            elevation: center.elevation,
            depth: depth,
            risk: calculatePoolingRisk(depth, center.lat, center.lng, centerLat, centerLng),
            radiusMeters: radiusMeters // PHYSICAL RADIUS IN METERS
          });
        }
      }
    }
  }
  
  console.log(`[Pooling] Found ${depressions.length} depressions`);
  return depressions;
}

/**
 * Calculate slope and flow direction for each cell
 * Uses D8 algorithm (flow to steepest of 8 neighbors)
 */
function calculateFlowDirection(elevationData) {
  const { grid, gridSize } = elevationData;
  const flowGrid = Array(gridSize).fill(null).map(() => Array(gridSize).fill(null));
  
  console.log('[Pooling] Calculating flow directions...');
  
  // Direction codes: 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE
  const directions = [
    { dr: 0, dc: 1 },   // E
    { dr: 1, dc: 1 },   // SE
    { dr: 1, dc: 0 },   // S
    { dr: 1, dc: -1 },  // SW
    { dr: 0, dc: -1 },  // W
    { dr: -1, dc: -1 }, // NW
    { dr: -1, dc: 0 },  // N
    { dr: -1, dc: 1 }   // NE
  ];
  
  for (let row = 1; row < gridSize - 1; row++) {
    for (let col = 1; col < gridSize - 1; col++) {
      const center = grid[row][col];
      if (!center || center.elevation === 0) continue;
      
      let steepestSlope = 0;
      let flowDirection = -1; // No flow
      
      // Check all 8 directions
      directions.forEach((dir, idx) => {
        const neighborRow = row + dir.dr;
        const neighborCol = col + dir.dc;
        
        if (neighborRow >= 0 && neighborRow < gridSize && neighborCol >= 0 && neighborCol < gridSize) {
          const neighbor = grid[neighborRow][neighborCol];
          
          if (neighbor && neighbor.elevation !== 0) {
            const elevationDrop = center.elevation - neighbor.elevation;
            const distance = (dir.dr !== 0 && dir.dc !== 0) ? Math.sqrt(2) : 1; // Diagonal vs cardinal
            const slope = elevationDrop / distance;
            
            if (slope > steepestSlope) {
              steepestSlope = slope;
              flowDirection = idx;
            }
          }
        }
      });
      
      flowGrid[row][col] = {
        lat: center.lat,
        lng: center.lng,
        elevation: center.elevation,
        flowDirection: flowDirection,
        slope: steepestSlope
      };
    }
  }
  
  return flowGrid;
}

/**
 * Calculate flow accumulation - how much water flows TO each cell
 * Higher accumulation = more water converging (potential flooding)
 */
function calculateFlowAccumulation(flowGrid, gridSize, spacing) {
  const accumGrid = Array(gridSize).fill(null).map(() => Array(gridSize).fill(0));
  
  console.log('[Pooling] Calculating flow accumulation...');
  
  // Direction vectors for D8
  const directions = [
    { dr: 0, dc: 1 },   // E
    { dr: 1, dc: 1 },   // SE
    { dr: 1, dc: 0 },   // S
    { dr: 1, dc: -1 },  // SW
    { dr: 0, dc: -1 },  // W
    { dr: -1, dc: -1 }, // NW
    { dr: -1, dc: 0 },  // N
    { dr: -1, dc: 1 }   // NE
  ];
  
  // Process cells from highest to lowest elevation
  const cellsWithElevation = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      if (flowGrid[row][col]) {
        cellsWithElevation.push({ row, col, elevation: flowGrid[row][col].elevation });
      }
    }
  }
  
  // Sort by elevation (highest first)
  cellsWithElevation.sort((a, b) => b.elevation - a.elevation);
  
  // Calculate accumulation by flowing from high to low
  cellsWithElevation.forEach(cell => {
    const { row, col } = cell;
    const flowCell = flowGrid[row][col];
    
    if (!flowCell || flowCell.flowDirection === -1) return;
    
    // Add this cell's contribution (1 + accumulated flow)
    const contribution = 1 + accumGrid[row][col];
    
    // Flow to the steepest neighbor
    const dir = directions[flowCell.flowDirection];
    const targetRow = row + dir.dr;
    const targetCol = col + dir.dc;
    
    if (targetRow >= 0 && targetRow < gridSize && targetCol >= 0 && targetCol < gridSize) {
      accumGrid[targetRow][targetCol] += contribution;
    }
  });
  
  // Convert accumulation to pooling zones WITH PHYSICAL EXTENT CALCULATION
  // ========================================================================
  // CRITICAL: We calculate the actual physical radius in METERS for each
  // pooling zone. This enables zoom-independent visualization where zones
  // maintain their true size regardless of map zoom level. The radius is
  // based on flow accumulation (more flow = larger affected area).
  // ========================================================================
  const poolingZones = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      if (flowGrid[row][col] && accumGrid[row][col] > 5) { // Threshold: >5 cells flowing to this point
        const cell = flowGrid[row][col];
        const accumulation = accumGrid[row][col];
        
        // Calculate physical radius of pooling zone based on accumulation
        // More accumulation = larger affected area
        // Base radius on how many cells contribute (sqrt for area relationship)
        const baseRadiusMeters = Math.sqrt(accumulation) * 8; // ~8m per sqrt(cell)
        const radiusMeters = Math.min(50, Math.max(15, baseRadiusMeters)); // 15m to 50m range
        
        poolingZones.push({
          lat: cell.lat,
          lng: cell.lng,
          elevation: cell.elevation,
          accumulation: accumGrid[row][col],
          slope: cell.slope,
          risk: Math.min(100, accumGrid[row][col] * 10), // Scale to 0-100
          radiusMeters: radiusMeters // PHYSICAL RADIUS IN METERS
        });
      }
    }
  }
  
  console.log(`[Pooling] Found ${poolingZones.length} high-accumulation zones`);
  return poolingZones;
}

/**
 * Smooth flow paths to follow terrain contours more naturally
 * Instead of straight lines, create curved paths that follow the steepest descent
 * @param {Array} flowPatterns - Original flow segments
 * @param {Array} flowGrid - 2D grid with flow directions
 * @param {number} gridSize - Size of the grid
 * @param {Array} directions - Direction vectors for D8 algorithm
 * @returns {Array} Smoothed flow segments with intermediate points
 */
function smoothFlowPaths(flowPatterns, flowGrid, gridSize, directions) {
  const smoothedPatterns = [];
  
  // Track which flow segments we've already traced to avoid duplicates
  const tracedFlows = new Set();
  
  // Group flow patterns by their source cell to trace complete flow paths
  const flowsBySource = new Map();
  flowPatterns.forEach(flow => {
    const key = `${flow.fromLat.toFixed(6)},${flow.fromLng.toFixed(6)}`;
    if (!flowsBySource.has(key)) {
      flowsBySource.set(key, []);
    }
    flowsBySource.get(key).push(flow);
  });
  
  // Trace flow paths from high-accumulation points (major streams)
  flowPatterns
    .filter(f => f.accumulation > 2) // Focus on significant flows
    .sort((a, b) => b.accumulation - a.accumulation) // Highest accumulation first
    .forEach(startFlow => {
      const startKey = `${startFlow.fromLat.toFixed(6)},${startFlow.fromLng.toFixed(6)}`;
      
      if (tracedFlows.has(startKey)) return; // Already traced this path
      
      // Trace the flow path downstream, collecting segments
      const pathSegments = [];
      let currentFlow = startFlow;
      let iterations = 0;
      const maxIterations = gridSize * 2; // Prevent infinite loops
      
      while (currentFlow && iterations < maxIterations) {
        const currentKey = `${currentFlow.fromLat.toFixed(6)},${currentFlow.fromLng.toFixed(6)}`;
        tracedFlows.add(currentKey);
        
        pathSegments.push(currentFlow);
        
        // Find the next segment in the flow path
        const nextKey = `${currentFlow.toLat.toFixed(6)},${currentFlow.toLng.toFixed(6)}`;
        const nextFlows = flowsBySource.get(nextKey);
        
        if (!nextFlows || nextFlows.length === 0) break; // End of flow path
        
        // Continue with the flow that has the highest accumulation
        currentFlow = nextFlows.sort((a, b) => b.accumulation - a.accumulation)[0];
        iterations++;
      }
      
      // If we have a path with multiple segments, create smoothed intermediate points
      if (pathSegments.length >= 2) {
        // Build a continuous path through all segments
        const pathPoints = [];
        pathSegments.forEach(seg => {
          if (pathPoints.length === 0) {
            pathPoints.push({ lat: seg.fromLat, lng: seg.fromLng });
          }
          pathPoints.push({ lat: seg.toLat, lng: seg.toLng });
        });
        
        // Create curved path using bezier-like curves between points
        for (let i = 0; i < pathPoints.length - 1; i++) {
          const p0 = pathPoints[Math.max(0, i - 1)];
          const p1 = pathPoints[i];
          const p2 = pathPoints[i + 1];
          const p3 = pathPoints[Math.min(pathPoints.length - 1, i + 2)];
          
          const current = pathSegments[Math.min(i, pathSegments.length - 1)];
          
          // Create 5 intermediate points for smooth Catmull-Rom curve
          const steps = 5;
          for (let step = 0; step < steps; step++) {
            const t = step / steps;
            const t2 = t * t;
            const t3 = t2 * t;
            
            // Catmull-Rom spline coefficients for smoother curves
            const lat1 = p1.lat + (p2.lat - p1.lat) * t + 
                        ((p2.lat - p0.lat) - (p3.lat - p1.lat)) * t2 * 0.3 +
                        ((p3.lat - p1.lat) - 2 * (p2.lat - p1.lat) + (p2.lat - p0.lat)) * t3 * 0.2;
            const lng1 = p1.lng + (p2.lng - p1.lng) * t + 
                        ((p2.lng - p0.lng) - (p3.lng - p1.lng)) * t2 * 0.3 +
                        ((p3.lng - p1.lng) - 2 * (p2.lng - p1.lng) + (p2.lng - p0.lng)) * t3 * 0.2;
            
            const lat2 = p1.lat + (p2.lat - p1.lat) * ((step + 1) / steps) + 
                        ((p2.lat - p0.lat) - (p3.lat - p1.lat)) * ((step + 1) / steps) * ((step + 1) / steps) * 0.3 +
                        ((p3.lat - p1.lat) - 2 * (p2.lat - p1.lat) + (p2.lat - p0.lat)) * ((step + 1) / steps) * ((step + 1) / steps) * ((step + 1) / steps) * 0.2;
            const lng2 = p1.lng + (p2.lng - p1.lng) * ((step + 1) / steps) + 
                        ((p2.lng - p0.lng) - (p3.lng - p1.lng)) * ((step + 1) / steps) * ((step + 1) / steps) * 0.3 +
                        ((p3.lng - p1.lng) - 2 * (p2.lng - p1.lng) + (p2.lng - p0.lng)) * ((step + 1) / steps) * ((step + 1) / steps) * ((step + 1) / steps) * 0.2;
            
            smoothedPatterns.push({
              fromLat: lat1,
              fromLng: lng1,
              toLat: lat2,
              toLng: lng2,
              elevation: current.elevation,
              accumulation: current.accumulation,
              intensity: current.intensity,
              isSmoothed: true
            });
          }
        }
      }
    });
  
  // For lower-accumulation flows that weren't traced, add bezier curves
  flowPatterns.forEach(flow => {
    const key = `${flow.fromLat.toFixed(6)},${flow.fromLng.toFixed(6)}`;
    if (!tracedFlows.has(key) && flow.accumulation <= 2) {
      // Create a curved path instead of straight line
      // Add control points offset perpendicular to the flow direction
      const dLat = flow.toLat - flow.fromLat;
      const dLng = flow.toLng - flow.fromLng;
      const length = Math.sqrt(dLat * dLat + dLng * dLng);
      
      if (length > 0) {
        // Perpendicular offset (to create natural meandering)
        const perpLat = -dLng / length;
        const perpLng = dLat / length;
        
        // Offset magnitude increases with flow length for natural curves
        const offsetMagnitude = length * 0.15; // 15% of flow length
        
        // Control points for quadratic bezier curve
        const midLat = (flow.fromLat + flow.toLat) / 2;
        const midLng = (flow.fromLng + flow.toLng) / 2;
        const controlLat = midLat + perpLat * offsetMagnitude;
        const controlLng = midLng + perpLng * offsetMagnitude;
        
        // Create smooth curve with 4 segments
        const curveSteps = 4;
        for (let step = 0; step < curveSteps; step++) {
          const t1 = step / curveSteps;
          const t2 = (step + 1) / curveSteps;
          
          // Quadratic bezier interpolation
          const lat1 = (1 - t1) * (1 - t1) * flow.fromLat + 
                       2 * (1 - t1) * t1 * controlLat + 
                       t1 * t1 * flow.toLat;
          const lng1 = (1 - t1) * (1 - t1) * flow.fromLng + 
                       2 * (1 - t1) * t1 * controlLng + 
                       t1 * t1 * flow.toLng;
          
          const lat2 = (1 - t2) * (1 - t2) * flow.fromLat + 
                       2 * (1 - t2) * t2 * controlLat + 
                       t2 * t2 * flow.toLat;
          const lng2 = (1 - t2) * (1 - t2) * flow.fromLng + 
                       2 * (1 - t2) * t2 * controlLng + 
                       t2 * t2 * flow.toLng;
          
          smoothedPatterns.push({
            fromLat: lat1,
            fromLng: lng1,
            toLat: lat2,
            toLng: lng2,
            elevation: flow.elevation,
            accumulation: flow.accumulation,
            intensity: flow.intensity,
            isSmoothed: true
          });
        }
      } else {
        // Keep very short segments as-is
        smoothedPatterns.push(flow);
      }
    }
  });
  
  return smoothedPatterns.length > 0 ? smoothedPatterns : flowPatterns;
}

/**
 * Calculate pooling risk score based on depth and proximity to property center
 */
function calculatePoolingRisk(depth, lat, lng, centerLat, centerLng) {
  // Base risk from depth (0-50 points)
  let risk = Math.min(50, depth * 10);
  
  // Distance penalty - closer depressions are riskier (0-50 points)
  const latDiff = Math.abs(lat - centerLat);
  const lngDiff = Math.abs(lng - centerLng);
  const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
  
  // Within 0.0003 degrees (~30m) is very concerning
  if (distance < 0.0001) risk += 50; // Within 10m
  else if (distance < 0.0002) risk += 40; // Within 20m
  else if (distance < 0.0003) risk += 30; // Within 30m
  else if (distance < 0.0005) risk += 20; // Within 50m
  else risk += 10; // Further away
  
  return Math.min(100, risk);
}

/**
 * Main analysis function - analyzes pooling risk for a property
 */
export async function analyzePoolingRisk(latitude, longitude) {
  try {
    console.log(`[Pooling] Starting pooling analysis for ${latitude}, ${longitude}`);
    
    const startTime = Date.now();
    
    // Step 0: Fetch precipitation data to factor into risk assessment
    let rainfallMultiplier = 1.0; // Default multiplier
    let precipitationData = null;
    
    try {
      console.log('[Pooling] Fetching precipitation data from NASA POWER...');
      // Import and call the NASA drought function directly (avoid HTTP call to self)
      const { getNASADroughtData } = await import('./nasa-environmental.js');
      const precipData = await getNASADroughtData(latitude, longitude);
      precipitationData = precipData;
        
      if (precipData.ok && precipData.avgDailyPrecipitation) {
        const avgDaily = precipData.avgDailyPrecipitation;
        console.log(`[Pooling] Average daily precipitation: ${avgDaily.toFixed(2)}mm`);
        
        // Adjust risk based on rainfall levels
        // More rainfall = higher pooling risk and greater flow intensity
        if (avgDaily > 8.0) {
          rainfallMultiplier = 1.8; // Extreme rainfall - very high pooling risk
          console.log('[Pooling] EXTREME rainfall detected - 1.8x risk multiplier');
        } else if (avgDaily > 6.0) {
          rainfallMultiplier = 1.5; // Heavy rainfall
          console.log('[Pooling] Heavy rainfall detected - 1.5x risk multiplier');
        } else if (avgDaily > 4.0) {
          rainfallMultiplier = 1.3; // Moderate-high rainfall
          console.log('[Pooling] Moderate-high rainfall - 1.3x risk multiplier');
        } else if (avgDaily > 2.0) {
          rainfallMultiplier = 1.1; // Normal rainfall
          console.log('[Pooling] Normal rainfall - 1.1x risk multiplier');
        } else {
          rainfallMultiplier = 0.7; // Low rainfall - reduced pooling risk
          console.log('[Pooling] Low rainfall - 0.7x risk multiplier (drought conditions)');
        }
      }
    } catch (precipError) {
      console.warn('[Pooling] Could not fetch precipitation data, using default risk:', precipError.message);
    }
    
    // Step 1: Fetch elevation grid (9x9 grid, ~100m x 100m area - BALANCED accuracy and speed)
    const elevationData = await fetchElevationGrid(latitude, longitude, 9, 0.0001);
    
    // Step 2: Detect depressions (local minima)
    const depressions = detectDepressions(elevationData);
    
    // Step 3: Calculate flow directions
    const flowGrid = calculateFlowDirection(elevationData);
    
    // Step 4: Calculate flow accumulation (convergence zones) with spacing for radius calculation
    const poolingZones = calculateFlowAccumulation(flowGrid, elevationData.gridSize, elevationData.spacing);
    
    const duration = Date.now() - startTime;
    console.log(`[Pooling] Analysis complete in ${duration}ms`);
    
    // Combine depressions and high-accumulation zones
    const allPoolingZones = [...depressions, ...poolingZones];
    
    // Remove duplicates (same location might appear in both lists)
    const uniqueZones = [];
    const seen = new Set();
    
    allPoolingZones.forEach(zone => {
      const key = `${zone.lat.toFixed(6)},${zone.lng.toFixed(6)}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Apply rainfall multiplier to risk scores
        uniqueZones.push({
          ...zone,
          risk: Math.min(100, Math.round(zone.risk * rainfallMultiplier)),
          baseRisk: zone.risk // Keep original for reference
        });
      }
    });
    
    // Sort by risk (highest first)
    uniqueZones.sort((a, b) => b.risk - a.risk);
    
    // Calculate overall property risk
    const maxRisk = uniqueZones.length > 0 ? Math.max(...uniqueZones.map(z => z.risk)) : 0;
    const avgRisk = uniqueZones.length > 0 
      ? uniqueZones.reduce((sum, z) => sum + z.risk, 0) / uniqueZones.length 
      : 0;
    
    // Extract flow patterns for visualization - BUILD COMPLETE FLOW PATHS
    const flowPatterns = [];
    const { gridSize } = elevationData;
    
    console.log(`[Pooling] Building flow accumulation paths from ${gridSize}x${gridSize} grid...`);
    
    // Create a map of accumulation values for visualization intensity
    const accumGrid = Array(gridSize).fill(null).map(() => Array(gridSize).fill(0));
    
    // Calculate accumulation by flowing from high to low
    const cellsWithElevation = [];
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        if (flowGrid[row][col]) {
          cellsWithElevation.push({ 
            row, 
            col, 
            elevation: flowGrid[row][col].elevation,
            cell: flowGrid[row][col]
          });
        }
      }
    }
    
    // Sort by elevation (highest first) to flow downstream
    cellsWithElevation.sort((a, b) => b.elevation - a.elevation);
    
    // Direction vectors
    const directions = [
      { dr: 0, dc: 1 },   // E
      { dr: 1, dc: 1 },   // SE
      { dr: 1, dc: 0 },   // S
      { dr: 1, dc: -1 },  // SW
      { dr: 0, dc: -1 },  // W
      { dr: -1, dc: -1 }, // NW
      { dr: -1, dc: 0 },  // N
      { dr: -1, dc: 1 }   // NE
    ];
    
    // Build accumulation grid
    cellsWithElevation.forEach(item => {
      const { row, col, cell } = item;
      
      if (cell.flowDirection === -1) return;
      
      const contribution = 1 + accumGrid[row][col];
      
      const dir = directions[cell.flowDirection];
      const targetRow = row + dir.dr;
      const targetCol = col + dir.dc;
      
      if (targetRow >= 0 && targetRow < gridSize && targetCol >= 0 && targetCol < gridSize) {
        accumGrid[targetRow][targetCol] += contribution;
      }
    });
    
    // Now extract flow patterns with accumulation-based intensity
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const cell = flowGrid[row][col];
        if (!cell || cell.flowDirection === -1) continue;
        
        // Use accumulation to determine intensity (more water = wider stream)
        const accumulation = accumGrid[row][col];
        const baseIntensity = Math.min(100, Math.max(10, accumulation * 15)); // Scale by accumulation
        const adjustedIntensity = Math.min(100, baseIntensity * rainfallMultiplier);
        
        // Calculate endpoint for this flow segment
        const dir = directions[cell.flowDirection];
        const nextRow = row + dir.dr;
        const nextCol = col + dir.dc;
        
        if (nextRow >= 0 && nextRow < gridSize && nextCol >= 0 && nextCol < gridSize) {
          const nextCell = flowGrid[nextRow][nextCol];
          if (nextCell) {
            flowPatterns.push({
              fromLat: cell.lat,
              fromLng: cell.lng,
              toLat: nextCell.lat,
              toLng: nextCell.lng,
              elevation: cell.elevation,
              direction: cell.flowDirection,
              slope: cell.slope,
              accumulation: accumulation, // How much water flows through this cell
              intensity: adjustedIntensity,
              baseIntensity: baseIntensity
            });
          }
        }
      }
    }
    
    console.log(`[Pooling] Extracted ${flowPatterns.length} flow segments with accumulation data`);
    console.log(`[Pooling] Max accumulation:`, Math.max(...flowPatterns.map(f => f.accumulation || 0)));
    console.log(`[Pooling] Sample high-flow segments:`, flowPatterns
      .filter(f => f.accumulation > 3)
      .slice(0, 3)
      .map(f => ({
        from: `${f.fromLat.toFixed(6)},${f.fromLng.toFixed(6)}`,
        to: `${f.toLat.toFixed(6)},${f.toLng.toFixed(6)}`,
        accumulation: f.accumulation,
        intensity: f.intensity.toFixed(1)
      })));
    
    // Smooth flow paths to follow terrain contours more naturally
    const smoothedFlowPatterns = smoothFlowPaths(flowPatterns, flowGrid, gridSize, directions);
    console.log(`[Pooling] Smoothed flow patterns: ${flowPatterns.length} → ${smoothedFlowPatterns.length} segments`);
    
    // Extract elevation grid for heatmap visualization
    const elevationGrid = [];
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const cell = flowGrid[row][col];
        if (cell) {
          // Calculate accumulation-based risk for this cell
          const accumulation = accumGrid[row][col] || 0;
          const cellRisk = Math.min(100, accumulation * 10);
          
          elevationGrid.push({
            lat: cell.lat,
            lng: cell.lng,
            elevation: cell.elevation,
            accumulation: accumulation,
            risk: cellRisk,
            slope: cell.slope
          });
        }
      }
    }
    
    console.log(`[Pooling] Extracted ${elevationGrid.length} elevation grid points for heatmap`);
    
    const result = {
      ok: true,
      propertyRisk: {
        max: Math.round(maxRisk),
        average: Math.round(avgRisk),
        hasPoolingZones: uniqueZones.length > 0,
        zoneCount: uniqueZones.length
      },
      poolingZones: uniqueZones.slice(0, 20), // Limit to top 20 zones
      elevationGrid: elevationGrid, // Full elevation grid for detailed heatmap
      flowPatterns: smoothedFlowPatterns, // Smoothed flow paths that follow terrain contours
      rainfallContext: precipitationData ? {
        avgDailyPrecipitation: precipitationData.avgDailyPrecipitation,
        precipitation90Day: precipitationData.precipitation90Day,
        riskMultiplier: rainfallMultiplier,
        condition: rainfallMultiplier > 1.4 ? 'wet' : rainfallMultiplier < 0.9 ? 'dry' : 'normal'
      } : null,
      analysis: {
        gridSize: elevationData.gridSize,
        areaMeters: Math.round(elevationData.gridSize * 11), // Approximate area (~11m spacing)
        depressionsFound: depressions.length,
        convergenceZonesFound: poolingZones.length,
        flowVectorsFound: flowPatterns.length,
        rainfallAdjusted: rainfallMultiplier !== 1.0,
        processingTimeMs: duration
      }
    };
    
    return result;
    
  } catch (error) {
    console.error('[Pooling] Analysis failed:', error);
    return {
      ok: false,
      error: error.message || 'pooling_analysis_failed',
      propertyRisk: { max: 0, average: 0, hasPoolingZones: false, zoneCount: 0 },
      poolingZones: [],
      flowPatterns: [],
      rainfallContext: null
    };
  }
}
