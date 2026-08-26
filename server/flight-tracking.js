// Flight Tracking Integration for Noise Map
// Uses OpenSky Network API (free, no API key required)
// Fetches real-time aircraft positions and filters by altitude

import 'dotenv/config';

// OpenSky Network API - free tier, no authentication required
// Rate limit: 100 requests per day for anonymous users
// Rate limit: 4000 requests per day for registered users (optional)
const OPENSKY_API_BASE = 'https://opensky-network.org/api';
const OPENSKY_USERNAME = process.env.OPENSKY_USERNAME || null;
const OPENSKY_PASSWORD = process.env.OPENSKY_PASSWORD || null;

// FlightAware (fallback option - requires API key)
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY || null;

/**
 * Fetch nearby aircraft from OpenSky Network
 * @param {number} latitude - Center latitude
 * @param {number} longitude - Center longitude
 * @param {number} radiusKm - Search radius in kilometers (default 10km)
 * @param {number} maxAltitudeFt - Maximum altitude in feet to include (default 8000ft)
 * @returns {Promise<object>} Aircraft data with positions, altitudes, and noise estimates
 */
export async function getNearbyAircraft(latitude, longitude, radiusKm = 10, maxAltitudeFt = 8000) {
  try {
    console.log('[Flight Tracking] Fetching aircraft near:', { latitude, longitude, radiusKm, maxAltitudeFt });
    
    // Convert radius to lat/lon bounds
    const latDelta = radiusKm / 111.0; // 1 degree lat ≈ 111km
    const lngDelta = radiusKm / (111.0 * Math.cos(latitude * Math.PI / 180));
    
    const minLat = latitude - latDelta;
    const maxLat = latitude + latDelta;
    const minLng = longitude - lngDelta;
    const maxLng = longitude + lngDelta;
    
    // OpenSky Network bounding box query
    // /states/all?lamin=minLat&lomin=minLng&lamax=maxLat&lomax=maxLng
    const url = `${OPENSKY_API_BASE}/states/all?lamin=${minLat}&lomin=${minLng}&lamax=${maxLat}&lomax=${maxLng}`;
    
    console.log('[Flight Tracking] OpenSky API URL:', url);
    
    // Add authentication if credentials provided (increases rate limit)
    const headers = {};
    if (OPENSKY_USERNAME && OPENSKY_PASSWORD) {
      const auth = Buffer.from(`${OPENSKY_USERNAME}:${OPENSKY_PASSWORD}`).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
      console.log('[Flight Tracking] Using authenticated request');
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new Error(`OpenSky API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Parse OpenSky response
    // states array format: [icao24, callsign, origin_country, time_position, last_contact, 
    //                       longitude, latitude, baro_altitude, on_ground, velocity, 
    //                       true_track, vertical_rate, sensors, geo_altitude, squawk, spi, position_source]
    const rawStates = data.states || [];
    
    console.log('[Flight Tracking] Total aircraft in bounds:', rawStates.length);
    
    const aircraft = [];
    let filteredByAltitude = 0;
    let filteredByGround = 0;
    let missingData = 0;
    
    for (const state of rawStates) {
      const icao24 = state[0];
      const callsign = state[1]?.trim() || 'Unknown';
      const longitude = state[5];
      const latitude = state[6];
      const baroAltitudeMeters = state[7]; // Barometric altitude in meters
      const onGround = state[8];
      const velocity = state[9]; // m/s
      const trueTrack = state[10]; // degrees
      const verticalRate = state[11]; // m/s
      const geoAltitudeMeters = state[13]; // Geometric altitude in meters
      
      // Skip aircraft on ground
      if (onGround) {
        filteredByGround++;
        continue;
      }
      
      // Skip if missing position or altitude data
      if (latitude == null || longitude == null || (baroAltitudeMeters == null && geoAltitudeMeters == null)) {
        missingData++;
        continue;
      }
      
      // Use barometric altitude if available, otherwise geometric altitude
      let altitudeMeters = baroAltitudeMeters != null ? baroAltitudeMeters : geoAltitudeMeters;
      
      // Handle negative altitudes (barometric reference issues or bad data)
      // Aircraft on approach can show negative baro altitude due to pressure settings
      // Use geometric altitude if barometric is negative/suspicious
      if (altitudeMeters < 0 && geoAltitudeMeters != null && geoAltitudeMeters >= 0) {
        altitudeMeters = geoAltitudeMeters;
        console.log(`[Flight Tracking] Aircraft ${icao24}: Using geo altitude (${geoAltitudeMeters}m) instead of negative baro (${baroAltitudeMeters}m)`);
      } else if (altitudeMeters < 0) {
        // Skip aircraft with invalid altitude data
        console.warn(`[Flight Tracking] Aircraft ${icao24}: Invalid altitude ${altitudeMeters}m, skipping`);
        missingData++;
        continue;
      }
      
      const altitudeFeet = altitudeMeters * 3.28084; // Convert meters to feet
      
      // Filter by altitude - only include aircraft audible from ground
      // Near airports: planes on approach/departure at 3000-8000 ft are very audible
      // Larger aircraft (737, A320, etc.) can generate 70-85 dBA even at 5000-8000 ft
      // Above 8000-10000 ft: noise typically drops below 60 dBA (ambient level)
      if (altitudeFeet > maxAltitudeFt) {
        filteredByAltitude++;
        continue;
      }
      
      // Calculate distance from center point
      const distance = calculateDistance(latitude, longitude, latitude, longitude);
      
      // Estimate noise level based on altitude and aircraft type
      const noiseLevel = estimateAircraftNoise(altitudeFeet, velocity, callsign);
      
      aircraft.push({
        icao24,
        callsign,
        latitude,
        longitude,
        altitudeFeet: Math.round(altitudeFeet),
        altitudeMeters: Math.round(altitudeMeters),
        velocity: velocity ? Math.round(velocity * 1.94384) : null, // Convert m/s to knots
        heading: trueTrack,
        verticalRate: verticalRate ? Math.round(verticalRate * 196.85) : null, // Convert m/s to ft/min
        distanceKm: distance,
        noiseLevel
      });
    }
    
    console.log('[Flight Tracking] Filtered results:', {
      total: rawStates.length,
      lowAltitude: aircraft.length,
      filteredByAltitude,
      filteredByGround,
      missingData
    });
    
    // Sort by altitude (lowest first - loudest)
    aircraft.sort((a, b) => a.altitudeFeet - b.altitudeFeet);
    
    return {
      ok: true,
      aircraft,
      count: aircraft.length,
      timestamp: data.time || Date.now(),
      filters: {
        radiusKm,
        maxAltitudeFt,
        filteredByAltitude,
        filteredByGround,
        missingData
      }
    };
    
  } catch (error) {
    console.error('[Flight Tracking] Error fetching aircraft:', error);
    return {
      ok: false,
      error: error.message,
      aircraft: [],
      count: 0
    };
  }
}

/**
 * Estimate aircraft noise level based on altitude and speed
 * Lower altitude = louder, faster = louder
 * @param {number} altitudeFeet - Altitude in feet AGL
 * @param {number} velocityMs - Velocity in m/s
 * @param {string} callsign - Aircraft callsign (to estimate type)
 * @returns {number} Estimated noise level in dBA
 */
function estimateAircraftNoise(altitudeFeet, velocityMs, callsign = '') {
  // Base noise levels:
  // - Small aircraft (Cessna, Piper): 70-75 dBA at 1000 ft
  // - Medium aircraft (regional jets): 75-80 dBA at 1000 ft
  // - Large aircraft (Boeing 737, Airbus A320): 80-90 dBA at 1000 ft
  // - Heavy aircraft (Boeing 747, 777): 85-95 dBA at 1000 ft
  
  // Estimate aircraft type from callsign
  let baseNoise = 80; // Default to medium aircraft
  
  const upper = callsign.toUpperCase();
  
  // Small aircraft patterns
  if (upper.match(/^N\d{1,3}[A-Z]{1,2}$/)) {
    baseNoise = 72; // General aviation registration
  }
  // Large/heavy aircraft patterns
  else if (upper.match(/^(UAL|DAL|AAL|SWA|BAW|AFR|DLH|UAE|QTR)/)) {
    baseNoise = 85; // Major airline (likely 737/A320 or larger)
  }
  // Cargo aircraft (often louder)
  else if (upper.match(/^(FDX|UPS|ABX|ATN|CKS)/)) {
    baseNoise = 88; // Cargo carriers (often older, louder engines)
  }
  
  // Altitude adjustment: Noise decreases ~6 dB per doubling of distance
  // Reference: 1000 ft altitude
  const altitudeRatio = altitudeFeet / 1000;
  const altitudeAttenuation = altitudeRatio > 0 ? 6 * Math.log2(altitudeRatio) : 0;
  
  // Speed adjustment: Faster = louder (engine thrust + aerodynamic noise)
  let speedBonus = 0;
  if (velocityMs) {
    const speedKnots = velocityMs * 1.94384;
    // Above 200 knots: +3 dB per 50 knots
    if (speedKnots > 200) {
      speedBonus = ((speedKnots - 200) / 50) * 3;
    }
  }
  
  // Calculate final noise level
  let noiseLevel = baseNoise - altitudeAttenuation + speedBonus;
  
  // Floor at 55 dB (very quiet background level)
  // Cap at 95 dB (extremely loud)
  noiseLevel = Math.max(55, Math.min(95, noiseLevel));
  
  return Math.round(noiseLevel);
}

/**
 * Calculate Haversine distance between two points in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return degrees * (Math.PI / 180);
}

export default {
  getNearbyAircraft
};
