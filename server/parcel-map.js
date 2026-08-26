/**
 * Parcel Map Service
 * Fetches parcel boundary geometry from ATTOM API and prepares it for mapping
 */

import 'dotenv/config';
import { fetchAttom } from './attom-usage-limiter.js';

const ATTOM_API_KEY = process.env.ATTOM_API_KEY || '';
const BASE_V1 = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const HEADERS = { 'accept': 'application/json', 'apikey': ATTOM_API_KEY };

/**
 * Fetch parcel boundary geometry from ATTOM
 * @param {string} address - Property address
 * @param {string} attomId - ATTOM property ID (alternative to address)
 * @returns {Object} Parcel geometry and metadata
 */
export async function getParcelGeometry(address, attomId = null) {
  try {
    if (!ATTOM_API_KEY) {
      return { ok: false, error: 'ATTOM API key not configured' };
    }

    // ATTOM property/detail endpoint includes lot geometry
    const url = new URL(`${BASE_V1}/property/detail`);
    if (attomId) {
      url.searchParams.set('id', attomId);
    } else if (address) {
      url.searchParams.set('address', address);
    } else {
      return { ok: false, error: 'Address or ATTOM ID required' };
    }

    console.log('[Parcel Map] Fetching geometry for:', address || attomId);

    const response = await fetchAttom(url.toString(), { headers: HEADERS });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Parcel Map] ATTOM API error:', errorText);
      return { ok: false, error: `ATTOM API failed: ${response.status}` };
    }

    const data = await response.json();
    const property = Array.isArray(data.property) ? data.property[0] : data.property;

    if (!property) {
      return { ok: false, error: 'Property not found' };
    }

    // Extract lot geometry (ATTOM provides GeoJSON format)
    const lot = property.lot || {};
    const geometry = lot.geometry || property.geometry;
    const location = property.location || {};
    const address_data = property.address || {};

    // Get property center coordinates
    const latitude = location.latitude || geometry?.centroid?.latitude;
    const longitude = location.longitude || geometry?.centroid?.longitude;

    // Extract parcel boundary polygon
    let parcelBoundary = null;
    if (geometry?.boundary) {
      parcelBoundary = geometry.boundary;
    } else if (geometry?.coordinates) {
      parcelBoundary = {
        type: geometry.type || 'Polygon',
        coordinates: geometry.coordinates
      };
    }

    // Get parcel metadata
    const parcelNumber = property.identifier?.parcelNumber || 
                        property.identifier?.apn || 
                        'Unknown';
    
    const lotSize = lot.lotSize1 || lot.lotsize || 0;
    const lotSizeUnit = lot.lotSize1Unit || 'sqft';

    return {
      ok: true,
      parcel: {
        parcelNumber,
        lotSize,
        lotSizeUnit,
        address: address_data.oneLine || address,
        attomId: property.identifier?.attomId
      },
      center: {
        latitude,
        longitude
      },
      boundary: parcelBoundary,
      // Additional property context
      zoning: lot.zoning || property.summary?.zoning,
      subdivisionName: lot.subdivisionName || property.area?.subdivisionName,
      legalDescription: lot.legalDescription,
      // Return raw geometry for advanced use cases
      rawGeometry: geometry
    };

  } catch (error) {
    console.error('[Parcel Map] Error:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Convert ATTOM geometry to standard GeoJSON format
 * ATTOM sometimes uses proprietary formats, this normalizes them
 */
export function normalizeGeometry(attomGeometry) {
  if (!attomGeometry) return null;

  // If already standard GeoJSON
  if (attomGeometry.type && attomGeometry.coordinates) {
    return attomGeometry;
  }

  // If it's a boundary object with a polygon
  if (attomGeometry.boundary) {
    return normalizeGeometry(attomGeometry.boundary);
  }

  // ATTOM sometimes provides polygon as array of lat/lng objects
  if (Array.isArray(attomGeometry.polygon)) {
    const coordinates = attomGeometry.polygon.map(point => [
      point.longitude || point.lng || point.lon,
      point.latitude || point.lat
    ]);
    
    // GeoJSON polygons must be closed (first point === last point)
    if (coordinates.length > 0) {
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coordinates.push([...first]);
      }
    }

    return {
      type: 'Polygon',
      coordinates: [coordinates] // Polygon coordinates are nested
    };
  }

  return null;
}

/**
 * Generate static map URL with parcel boundary overlay
 * Uses Mapbox Static Images API
 */
export function generateStaticMapURL(center, boundary, options = {}) {
  const {
    width = 800,
    height = 600,
    zoom = 17,
    style = 'satellite-streets-v12',
    mapboxToken = process.env.MAPBOX_ACCESS_TOKEN
  } = options;

  if (!mapboxToken) {
    console.warn('[Parcel Map] Mapbox token not configured, cannot generate static map');
    return null;
  }

  if (!center?.latitude || !center?.longitude) {
    return null;
  }

  // Create GeoJSON overlay for parcel boundary
  let overlayGeoJSON = null;
  if (boundary) {
    const normalized = normalizeGeometry(boundary);
    if (normalized) {
      overlayGeoJSON = {
        type: 'Feature',
        properties: {
          stroke: '#FF0000',
          'stroke-width': 3,
          'stroke-opacity': 1,
          fill: '#FF0000',
          'fill-opacity': 0.2
        },
        geometry: normalized
      };
    }
  }

  // Mapbox Static Images API with GeoJSON overlay
  // https://docs.mapbox.com/api/maps/static-images/
  const baseURL = `https://api.mapbox.com/styles/v1/mapbox/${style}/static`;
  
  let url = baseURL;
  
  if (overlayGeoJSON) {
    // Encode GeoJSON for URL
    const geoJSONStr = encodeURIComponent(JSON.stringify(overlayGeoJSON));
    url += `/geojson(${geoJSONStr})`;
  }
  
  url += `/${center.longitude},${center.latitude},${zoom}/${width}x${height}@2x?access_token=${mapboxToken}`;

  return url;
}

/**
 * Generate Leaflet/MapLibre configuration for interactive map
 */
export function generateMapConfig(parcelData) {
  if (!parcelData.ok || !parcelData.center) {
    return null;
  }

  const { center, boundary, parcel } = parcelData;
  
  const config = {
    center: [center.latitude, center.longitude],
    zoom: 18,
    maxZoom: 20,
    minZoom: 10,
    
    // Parcel boundary as GeoJSON
    parcelBoundary: boundary ? normalizeGeometry(boundary) : null,
    
    // Style for parcel overlay
    parcelStyle: {
      color: '#FF0000',
      weight: 3,
      opacity: 1,
      fillColor: '#FF0000',
      fillOpacity: 0.15
    },
    
    // Metadata
    metadata: {
      parcelNumber: parcel?.parcelNumber,
      lotSize: parcel?.lotSize,
      address: parcel?.address
    }
  };

  return config;
}

export default {
  getParcelGeometry,
  normalizeGeometry,
  generateStaticMapURL,
  generateMapConfig
};
