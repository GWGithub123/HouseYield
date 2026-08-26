// NASA Environmental Data Integration
// Provides wildfire and drought risk data from NASA sources

import 'dotenv/config';

const NASA_FIRMS_KEY = process.env.NASA_FIRMS_KEY || '';

/**
 * Fetch active fires from NASA FIRMS within radius of location
 * @param {number} latitude 
 * @param {number} longitude 
 * @param {number} daysBack - How many days back to check (1-10)
 * @returns {Promise<object>} Fire data with risk assessment
 */
export async function getNASAActiveFires(latitude, longitude, daysBack = 30) {
  if (!NASA_FIRMS_KEY) {
    console.warn('[NASA FIRMS] No API key configured');
    return { 
      ok: false, 
      error: 'missing_api_key',
      activeFires: [],
      nearbyFireCount: 0,
      riskBoost: 0
    };
  }

  try {
    // FIRMS API returns CSV of fires within ~300km of point
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_FIRMS_KEY}/VIIRS_SNPP_NRT/${latitude},${longitude}/${daysBack}`;
    
    console.log('[NASA FIRMS] Fetching active fires:', { latitude, longitude, daysBack });
    
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.error('[NASA FIRMS] API error:', response.status, response.statusText);
      return { 
        ok: false, 
        error: `http_${response.status}`,
        activeFires: [],
        nearbyFireCount: 0,
        riskBoost: 0
      };
    }

    const csvData = await response.text();
    
    // Parse CSV (header + data rows)
    const lines = csvData.trim().split('\n');
    if (lines.length < 2) {
      console.log('[NASA FIRMS] No active fires detected');
      return {
        ok: true,
        activeFires: [],
        nearbyFireCount: 0,
        riskBoost: 0,
        message: 'No active fires detected in area'
      };
    }

    const headers = lines[0].split(',');
    const fires = lines.slice(1).map(line => {
      const values = line.split(',');
      const fire = {};
      headers.forEach((header, i) => {
        fire[header.trim()] = values[i]?.trim();
      });
      return fire;
    });

    // Calculate distance to each fire and filter nearby ones
    const nearbyFires = fires
      .map(fire => {
        const fireLat = parseFloat(fire.latitude);
        const fireLng = parseFloat(fire.longitude);
        const distance = calculateDistance(latitude, longitude, fireLat, fireLng);
        
        return {
          ...fire,
          distance_km: distance,
          brightness: parseFloat(fire.bright_ti4 || fire.brightness),
          confidence: fire.confidence,
          frp: parseFloat(fire.frp || 0) // Fire Radiative Power
        };
      })
      .filter(fire => fire.distance_km <= 50) // Within 50km
      .sort((a, b) => a.distance_km - b.distance_km);

    // Calculate risk boost based on nearby fires
    let riskBoost = 0;
    if (nearbyFires.length > 0) {
      // Base boost for any nearby fire
      riskBoost = 15;
      
      // Add more based on proximity and intensity
      nearbyFires.forEach(fire => {
        if (fire.distance_km < 10) {
          riskBoost += 15; // Very close fire
        } else if (fire.distance_km < 25) {
          riskBoost += 10; // Close fire
        } else {
          riskBoost += 5; // Nearby fire
        }
        
        // Intensity bonus (high FRP = more dangerous)
        if (fire.frp > 500) {
          riskBoost += 10;
        } else if (fire.frp > 200) {
          riskBoost += 5;
        }
      });
      
      // Cap the boost
      riskBoost = Math.min(riskBoost, 40);
    }

    console.log('[NASA FIRMS] Results:', {
      totalFires: fires.length,
      nearbyFires: nearbyFires.length,
      closestDistance: nearbyFires[0]?.distance_km,
      riskBoost
    });

    return {
      ok: true,
      activeFires: nearbyFires,
      nearbyFireCount: nearbyFires.length,
      totalFiresInRegion: fires.length,
      riskBoost,
      closestFire: nearbyFires[0] || null
    };

  } catch (error) {
    console.error('[NASA FIRMS] Error:', error.message);
    return {
      ok: false,
      error: error.message,
      activeFires: [],
      nearbyFireCount: 0,
      riskBoost: 0
    };
  }
}

/**
 * Fetch drought conditions from NASA POWER
 * Uses 90-day precipitation history as drought indicator
 * @param {number} latitude 
 * @param {number} longitude 
 * @returns {Promise<object>} Drought assessment
 */
export async function getNASADroughtData(latitude, longitude) {
  try {
    // Get last 90 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 90);
    
    const start = formatNASADate(startDate);
    const end = formatNASADate(endDate);
    
    // NASA POWER API - no key needed!
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,T2M,RH2M&community=RE&longitude=${longitude}&latitude=${latitude}&start=${start}&end=${end}&format=JSON`;
    
    console.log('[NASA POWER] Fetching 90-day climate data:', { latitude, longitude });
    
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      console.error('[NASA POWER] API error:', response.status);
      return {
        ok: false,
        error: `http_${response.status}`,
        droughtScore: 0,
        droughtLevel: 'unknown'
      };
    }

    const data = await response.json();
    
    // Extract precipitation data
    const precipData = data.properties?.parameter?.PRECTOTCORR;
    const tempData = data.properties?.parameter?.T2M;
    const humidityData = data.properties?.parameter?.RH2M;
    
    if (!precipData) {
      console.error('[NASA POWER] No precipitation data returned');
      return {
        ok: false,
        error: 'no_data',
        droughtScore: 0,
        droughtLevel: 'unknown'
      };
    }

    // Calculate total precipitation over 90 days
    const precipValues = Object.values(precipData).filter(v => v !== -999); // -999 = missing data
    const totalPrecip = precipValues.reduce((sum, val) => sum + val, 0);
    const avgDailyPrecip = totalPrecip / precipValues.length;
    
    // Calculate average temperature
    const tempValues = Object.values(tempData || {}).filter(v => v !== -999);
    const avgTemp = tempValues.length > 0 
      ? tempValues.reduce((sum, val) => sum + val, 0) / tempValues.length 
      : 20;

    // Drought assessment
    let droughtScore = 0;
    let droughtLevel = 'normal';
    
    if (avgDailyPrecip < 1.0) {
      droughtScore = 35; // Severe drought - very high fire risk
      droughtLevel = 'severe';
    } else if (avgDailyPrecip < 2.0) {
      droughtScore = 25; // Moderate drought
      droughtLevel = 'moderate';
    } else if (avgDailyPrecip < 3.0) {
      droughtScore = 15; // Mild drought
      droughtLevel = 'mild';
    } else if (avgDailyPrecip < 4.0) {
      droughtScore = 5; // Slight drought
      droughtLevel = 'slight';
    } else {
      droughtScore = 0; // Normal/wet
      droughtLevel = 'normal';
    }

    // Temperature adjustment - extreme heat increases drought impact
    if (avgTemp > 30 && droughtScore > 0) {
      droughtScore += 10;
    } else if (avgTemp > 35 && droughtScore > 0) {
      droughtScore += 15;
    }

    // Cap at 40
    droughtScore = Math.min(droughtScore, 40);

    console.log('[NASA POWER] Drought analysis:', {
      totalPrecip_90days: totalPrecip.toFixed(1),
      avgDailyPrecip: avgDailyPrecip.toFixed(2),
      avgTemp: avgTemp.toFixed(1),
      droughtLevel,
      droughtScore
    });

    return {
      ok: true,
      droughtScore,
      droughtLevel,
      precipitation90Day: totalPrecip,
      avgDailyPrecipitation: avgDailyPrecip,
      avgTemperature90Day: avgTemp,
      dataPoints: precipValues.length
    };

  } catch (error) {
    console.error('[NASA POWER] Error:', error.message);
    return {
      ok: false,
      error: error.message,
      droughtScore: 0,
      droughtLevel: 'unknown'
    };
  }
}

/**
 * Calculate Haversine distance between two points
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

/**
 * Format date for NASA POWER API (YYYYMMDD)
 */
function formatNASADate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Get comprehensive wildfire risk assessment
 * Combines ATTOM data, NASA active fires, and NASA drought data
 */
export async function getEnhancedWildfireRisk(latitude, longitude, attomFireData = null) {
  console.log('[NASA Environmental] Getting enhanced wildfire risk');
  
  const [activeFires, droughtData] = await Promise.all([
    getNASAActiveFires(latitude, longitude, 30),
    getNASADroughtData(latitude, longitude)
  ]);

  // Base risk from ATTOM (if available)
  let baseRisk = 0;
  if (attomFireData?.riskScore) {
    baseRisk = attomFireData.riskScore;
  }

  // Add NASA boosts
  const fireRiskBoost = activeFires.riskBoost || 0;
  const droughtRiskBoost = droughtData.droughtScore || 0;
  
  const totalRisk = Math.min(baseRisk + fireRiskBoost + droughtRiskBoost, 100);

  return {
    totalRisk,
    baseRisk,
    fireRiskBoost,
    droughtRiskBoost,
    activeFires: activeFires.activeFires || [],
    nearbyFireCount: activeFires.nearbyFireCount || 0,
    droughtLevel: droughtData.droughtLevel || 'unknown',
    sources: {
      attom: !!attomFireData,
      nasa_firms: activeFires.ok,
      nasa_power: droughtData.ok
    }
  };
}
