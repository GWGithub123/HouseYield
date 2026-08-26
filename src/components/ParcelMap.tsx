/**
 * ParcelMap Component
 * Displays property with ATTOM parcel boundary tiles overlay using Google Maps
 * 
 * Uses ATTOM's Parcel Tiles API - a nationwide raster tile layer showing parcel boundaries
 * Overlays on Google Maps (satellite or roadmap)
 * 
 * Features:
 * - ATTOM parcel boundary tiles (zoom 14-18)
 * - Google Maps satellite or street view
 * - Property location marker
 * - Simple and efficient (no complex geometry fetching)
 */

import React, { useEffect, useRef, useState } from 'react';

interface ParcelMapProps {
  latitude: number;
  longitude: number;
  address?: string;
  attomId?: string;
  width?: string | number;
  height?: string | number;
  showParcelTiles?: boolean; // Show ATTOM parcel boundary overlay
  showSchoolZones?: boolean; // Show school attendance zones
}

export const ParcelMap: React.FC<ParcelMapProps> = ({
  latitude,
  longitude,
  address,
  attomId,
  width = '100%',
  height = 400,
  showParcelTiles = true,
  showSchoolZones = false
}) => {
  const [mapType, setMapType] = useState<'satellite' | 'roadmap'>('satellite');
  const [error, setError] = useState<string | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const parcelOverlayRef = useRef<any>(null);

  useEffect(() => {
    console.log('[ParcelMap] Component mounted/updated', { latitude, longitude, address, attomId });
    initializeMap();
  }, [latitude, longitude, address, attomId]);

  useEffect(() => {
    // Update map type when changed
    if (mapInstance.current) {
      mapInstance.current.setMapTypeId(mapType);
      // Apply lighter styling to roadmap for better parcel visibility
      if (mapType === 'roadmap') {
        mapInstance.current.setOptions({
          styles: [
            {
              featureType: 'all',
              elementType: 'geometry.fill',
              stylers: [{ lightness: 40 }]
            }
          ]
        });
      } else {
        mapInstance.current.setOptions({ styles: [] });
      }
    }
  }, [mapType]);

  useEffect(() => {
    // Toggle parcel tiles on/off
    if (mapInstance.current && parcelOverlayRef.current) {
      const overlays = mapInstance.current.overlayMapTypes;
      if (showParcelTiles) {
        // Add if not already present
        let found = false;
        overlays.forEach((overlay: any) => {
          if (overlay === parcelOverlayRef.current) found = true;
        });
        if (!found) {
          overlays.push(parcelOverlayRef.current);
        }
      } else {
        // Remove overlay
        for (let i = overlays.getLength() - 1; i >= 0; i--) {
          if (overlays.getAt(i) === parcelOverlayRef.current) {
            overlays.removeAt(i);
          }
        }
      }
    }
  }, [showParcelTiles]);

  const initializeMap = async () => {
    if (!mapContainerRef.current) {
      console.error('[ParcelMap] Map container ref not available');
      return;
    }

    console.log('[ParcelMap] Initializing map...', { latitude, longitude, address });

    try {
      // Load Google Maps if not already loaded
      if (!(window as any).google?.maps) {
        console.log('[ParcelMap] Loading Google Maps script...');
        const GOOGLE_MAPS_API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || '';
        if (!GOOGLE_MAPS_API_KEY) {
          console.error('[ParcelMap] VITE_GOOGLE_MAPS_API_KEY not configured in .env');
          return;
        }
        
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`;
          script.async = true;
          script.defer = true;
          script.onload = () => {
            console.log('[ParcelMap] Google Maps loaded successfully');
            resolve();
          };
          script.onerror = () => {
            console.error('[ParcelMap] Failed to load Google Maps script');
            reject(new Error("Failed to load Google Maps"));
          };
          document.head.appendChild(script);
        });
      } else {
        console.log('[ParcelMap] Google Maps already loaded');
      }

      const google = (window as any).google;
      if (!google || !google.maps) {
        console.error('[ParcelMap] Google Maps API not available');
        setError('Google Maps failed to load');
        return;
      }

      // Create map centered on property
      // Ensure lat/lng are numbers
      const lat = Number(latitude);
      const lng = Number(longitude);
      
      if (isNaN(lat) || isNaN(lng)) {
        setError('Invalid coordinates provided');
        return;
      }

      console.log('[ParcelMap] Creating map instance...');
      const map = new google.maps.Map(mapContainerRef.current, {
        center: { lat, lng },
        zoom: 16, // Fixed at zoom 16 for minimal tiles
        mapTypeId: mapType,
        mapTypeControl: false, // We'll use our custom toggle
        streetViewControl: false,
        fullscreenControl: false,
        zoomControl: false, // Disable zoom to prevent loading more tiles
        gestureHandling: 'none', // Disable all pan/zoom gestures
        styles: mapType === 'roadmap' ? [
          {
            featureType: 'all',
            elementType: 'geometry.fill',
            stylers: [{ lightness: 40 }]
          }
        ] : []
      });

      mapInstance.current = map;
      console.log('[ParcelMap] Map instance created successfully');

      // Add red marker at property location
      new google.maps.Marker({
        position: { lat, lng },
        map: map,
        title: address || 'Property Location',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#FF0000',
          fillOpacity: 1,
          strokeColor: '#FFFFFF',
          strokeWeight: 3
        }
      });
      console.log('[ParcelMap] Property marker added at', lat, lng);

      // Fetch and draw parcel geometry and school zones from ATTOM
      if (showParcelTiles || showSchoolZones) {
        console.log('[ParcelMap] Fetching parcel geometry and schools...');
        console.log('[ParcelMap] Address:', address, 'AttomId:', attomId);
        
        try {
          const baseUrl = (import.meta as any).env?.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
          const params = new URLSearchParams();
          if (address) params.set('address', address);
          if (attomId) params.set('attomId', attomId);
          
          const response = await fetch(`${baseUrl}/api/attom/parcel-geometry?${params}`);
          console.log('[ParcelMap] Fetch response status:', response.status, response.ok);
          
          if (response.ok) {
            const data = await response.json();
            console.log('[ParcelMap] Received data:', {
              ok: data.ok,
              hasGeometry: !!data.parcel_geometry,
              geometryType: data.parcel_geometry?.type,
              coordinatesLength: data.parcel_geometry?.coordinates?.length,
              schoolsCount: data.schools?.length || 0
            });
            
            // Draw parcel boundary
            if (showParcelTiles && data.parcel_geometry?.coordinates) {
              console.log('[ParcelMap] Drawing parcel boundary polygon...');
              console.log('[ParcelMap] Geometry data:', data.parcel_geometry);
              const coords = data.parcel_geometry.coordinates;
              
              // Convert ATTOM coordinates [lng, lat] to Google Maps format {lat, lng}
              let paths: any[] = [];
              if (data.parcel_geometry.type === 'Polygon' && Array.isArray(coords[0])) {
                paths = coords[0].map((coord: number[]) => ({
                  lat: coord[1],
                  lng: coord[0]
                }));
              }
              
              if (paths.length > 0 && map) {
                new google.maps.Polygon({
                  paths,
                  strokeColor: '#FF6B00',
                  strokeOpacity: 1.0,
                  strokeWeight: 3,
                  fillColor: '#FF6B00',
                  fillOpacity: 0.15,
                  map: map
                });
                console.log('[ParcelMap] Parcel polygon drawn with', paths.length, 'points');
              }
            } else if (showParcelTiles) {
              console.log('[ParcelMap] No parcel geometry, drawing fallback circle');
              if (map) {
                new google.maps.Circle({
                  strokeColor: '#FF6B00',
                  strokeOpacity: 1.0,
                  strokeWeight: 3,
                  fillColor: '#FF6B00',
                  fillOpacity: 0.15,
                  center: { lat, lng },
                  radius: 50,
                  map: map
                });
                console.log('[ParcelMap] Fallback circle drawn');
              }
            }
            
            // Draw school zones
            if (showSchoolZones && data.schools && data.schools.length > 0) {
              console.log(`[ParcelMap] Drawing ${data.schools.length} school zones...`);
              const colors = ['#4285F4', '#EA4335', '#FBBC04', '#34A853'];
              let drawnCount = 0;
              
              data.schools.forEach((school: any, idx: number) => {
                if (school.boundary?.coordinates) {
                  const coords = school.boundary.coordinates;
                  let paths: any[] = [];
                  
                  if (Array.isArray(coords[0])) {
                    paths = coords[0].map((coord: number[]) => ({
                      lat: coord[1],
                      lng: coord[0]
                    }));
                  }
                  
                  if (paths.length > 0 && map) {
                    new google.maps.Polygon({
                      paths,
                      strokeColor: colors[idx % colors.length],
                      strokeOpacity: 0.8,
                      strokeWeight: 2,
                      fillColor: colors[idx % colors.length],
                      fillOpacity: 0.1,
                      map: map
                    });
                    drawnCount++;
                  }
                }
              });
              console.log(`[ParcelMap] Drew ${drawnCount} school zone polygons`);
            } else {
              console.log('[ParcelMap] Drawing 0 school zones...');
            }
            
          } else {
            console.warn('[ParcelMap] Failed to fetch parcel data:', response.status);
            // Fallback: draw approximate boundary circle
            if (showParcelTiles && map) {
              new google.maps.Circle({
                strokeColor: '#FF6B00',
                strokeOpacity: 1.0,
                strokeWeight: 3,
                fillColor: '#FF6B00',
                fillOpacity: 0.15,
                center: { lat, lng },
                radius: 50,
                map: map
              });
            }
          }
        } catch (err) {
          console.error('[ParcelMap] Error fetching parcel data:', err);
          // Fallback: draw approximate boundary circle
          if (showParcelTiles && map) {
            new google.maps.Circle({
              strokeColor: '#FF6B00',
              strokeOpacity: 1.0,
              strokeWeight: 3,
              fillColor: '#FF6B00',
              fillOpacity: 0.15,
              center: { lat, lng },
              radius: 50,
              map: map
            });
          }
        }
        
        // Add tile load listener for debugging
        google.maps.event.addListener(map, 'tilesloaded', () => {
          console.log('[ParcelMap] Base map tiles loaded');
        });
      }

      // Add marker at property location
      const marker = new google.maps.Marker({
        position: { lat, lng },
        map: map,
        title: address || 'Property Location',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#ef4444',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        }
      });

      // Add info window
      if (address) {
        const infoWindow = new google.maps.InfoWindow({
          content: `<div style="padding: 8px;">
            <strong style="font-size: 14px;">${address}</strong><br>
            <span style="font-size: 12px; color: #666;">
              ${lat.toFixed(6)}, ${lng.toFixed(6)}
            </span>
          </div>`
        });

        marker.addListener('click', () => {
          infoWindow.open(map, marker);
        });
      }

    } catch (err: any) {
      console.error('[ParcelMap] Error initializing map:', err);
      setError(err.message || 'Failed to initialize map');
    }
  };

  if (error) {
    return (
      <div className="flex items-center justify-center bg-red-50 border border-red-200 rounded-lg" style={{ width, height }}>
        <div className="text-center p-4">
          <svg className="w-12 h-12 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
          </svg>
          <p className="text-sm text-red-600 font-medium">Map unavailable</p>
          <p className="text-xs text-red-500 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative" style={{ width }}>
      {/* Map Container */}
      <div className="relative rounded-lg overflow-hidden border border-gray-300" style={{ height }}>
        <div ref={mapContainerRef} className="w-full h-full" />

        {/* Map Type Toggle */}
        <div className="absolute top-2 right-2 bg-white rounded shadow-lg border border-gray-200">
          <button
            onClick={() => setMapType('satellite')}
            className={`px-3 py-1.5 text-xs font-medium ${
              mapType === 'satellite' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
            } rounded-l transition-colors`}
          >
            Satellite
          </button>
          <button
            onClick={() => setMapType('roadmap')}
            className={`px-3 py-1.5 text-xs font-medium ${
              mapType === 'roadmap' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
            } rounded-r transition-colors border-l border-gray-200`}
          >
            Street
          </button>
        </div>

        {/* Parcel boundary indicator */}
        {showParcelTiles && (
          <div className="absolute bottom-2 right-2 bg-white rounded shadow-lg border border-gray-200 px-2 py-1 text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 border-2 border-orange-500 bg-orange-500/20"></div>
              <span className="text-gray-700">Parcel Boundaries</span>
            </div>
          </div>
        )}
      </div>

      {/* Property Info */}
      {address && (
        <div className="mt-3 bg-gray-50 rounded p-3 text-sm">
          <div className="text-gray-500 text-xs font-medium">Property Location</div>
          <div className="text-gray-900 font-semibold mt-0.5">{address}</div>
          <div className="text-xs text-gray-500 mt-1">
            {Number(latitude).toFixed(6)}, {Number(longitude).toFixed(6)}
          </div>
        </div>
      )}
    </div>
  );
};

export default ParcelMap;
