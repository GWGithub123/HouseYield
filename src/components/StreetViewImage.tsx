/**
 * StreetViewImage Component
 * Displays Google Street View image for a property address
 */

import React, { useEffect, useState, useCallback } from 'react';
import { getDevApiBaseUrl } from '../utils/devApiBase';

interface StreetViewImageProps {
  address: string;
  className?: string;
  width?: number;
  height?: number;
  pitch?: number;
  fov?: number;
  objectPosition?: string;
  fill?: boolean;
}

/** Street View Static API free-tier max edge length. */
const STREET_VIEW_MAX_EDGE = 640;

function clampStreetViewSize(width: number, height: number) {
  const safeWidth = Math.max(1, Math.round(width || 400));
  const safeHeight = Math.max(1, Math.round(height || 300));
  const scale = Math.min(1, STREET_VIEW_MAX_EDGE / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

export const StreetViewImage: React.FC<StreetViewImageProps> = ({
  address,
  className = '',
  width = 400,
  height = 300,
  pitch,
  fov,
  objectPosition,
  fill = false,
}) => {
  const [imageUrl, setImageUrl] = useState<string>('');
  const [imageError, setImageError] = useState(false);
  // When callers pass h-full/w-full, fill the parent instead of capping at `width`.
  const shouldFill = fill || /\bh-full\b/.test(className) || /\bw-full\b/.test(className);

  useEffect(() => {
    if (!address || address === 'ADDRESS NOT SET' || address.trim() === '') {
      setImageError(true);
      return;
    }

    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      console.error('Google Maps API key not found');
      setImageError(true);
      return;
    }

    // Prefer a sharp request size for wide cards, but stay within API limits.
    const requestSize = clampStreetViewSize(
      shouldFill ? Math.max(width, 640) : width,
      shouldFill ? Math.max(height, 400) : height,
    );
    const params = new URLSearchParams({
      size: `${requestSize.width}x${requestSize.height}`,
      location: address,
      key: apiKey,
      source: 'outdoor',
    });
    if (pitch !== undefined) params.set('pitch', String(pitch));
    if (fov !== undefined) params.set('fov', String(fov));

    const url = `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;

    setImageUrl(url);
    setImageError(false);
  }, [address, width, height, pitch, fov, shouldFill]);

  const frameStyle: React.CSSProperties = shouldFill
    ? { width: '100%', height: '100%', minHeight: height || 200 }
    : { width: '100%', maxWidth: width, height };

  if (imageError || !address || address === 'ADDRESS NOT SET') {
    return (
      <div
        className={`bg-gray-100 flex items-center justify-center overflow-hidden ${className}`}
        style={frameStyle}
      >
        <div className="text-center text-gray-500 px-4">
          <svg className="w-16 h-16 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
          <p className="text-sm font-medium">Property Image</p>
          {address && address !== 'ADDRESS NOT SET' ? (
            <p className="text-xs mt-1">Street view not available</p>
          ) : (
            <p className="text-xs mt-1">Address not set</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`overflow-hidden ${className}`} style={frameStyle}>
      <img
        src={imageUrl}
        alt={`Street view of ${address}`}
        className="block h-full w-full object-cover"
        style={objectPosition ? { objectPosition } : undefined}
        onError={() => setImageError(true)}
        loading="lazy"
      />
    </div>
  );
};

/**
 * Multi-angle Street View capture for AI analysis
 * Fetches 4 street-level angles + 1 satellite overhead and converts to base64
 */
export interface StreetViewAngle {
  heading: number;
  label: string;
  imageBase64: string;
}

export interface MultiAngleCaptureResult {
  streetViews: StreetViewAngle[];
  satelliteView: string | null;
}

const CAPTURE_HEADINGS = [
  { heading: 0, label: 'North' },
  { heading: 90, label: 'East' },
  { heading: 180, label: 'South' },
  { heading: 270, label: 'West' },
];

async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.ok ? data.base64 : null;
  } catch {
    return null;
  }
}

export async function captureMultiAngleStreetView(
  address: string,
  width = 640,
  height = 480
): Promise<MultiAngleCaptureResult> {
  if (!address) {
    return { streetViews: [], satelliteView: null };
  }

  const baseUrl = import.meta.env.VITE_API_URL || getDevApiBaseUrl();
  const encodedAddress = encodeURIComponent(address);

  // Fetch all 4 street view angles + satellite via server proxy (avoids CORS)
  const streetViewPromises = CAPTURE_HEADINGS.map(async ({ heading, label }) => {
    const url = `${baseUrl}/api/streetview/capture?address=${encodedAddress}&heading=${heading}&width=${width}&height=${height}`;
    const base64 = await fetchImageAsBase64(url);
    return base64 ? { heading, label, imageBase64: base64 } : null;
  });

  const satellitePromise = (async () => {
    const url = `${baseUrl}/api/streetview/capture?address=${encodedAddress}&type=satellite&width=${width}&height=${height}`;
    return fetchImageAsBase64(url);
  })();

  const [streetResults, satelliteView] = await Promise.all([
    Promise.all(streetViewPromises),
    satellitePromise
  ]);

  return {
    streetViews: streetResults.filter((r): r is StreetViewAngle => r !== null),
    satelliteView
  };
}

/**
 * StreetViewMultiAngle - displays multi-angle views with capture button
 */
interface StreetViewMultiAngleProps {
  address: string;
  onCapture?: (result: MultiAngleCaptureResult) => void;
  compact?: boolean;
}

export const StreetViewMultiAngle: React.FC<StreetViewMultiAngleProps> = ({
  address,
  onCapture,
  compact = false,
}) => {
  const [capturing, setCapturing] = useState(false);
  const [result, setResult] = useState<MultiAngleCaptureResult | null>(null);
  const [selectedAngle, setSelectedAngle] = useState(0);

  const handleCapture = useCallback(async () => {
    setCapturing(true);
    try {
      const captureResult = await captureMultiAngleStreetView(address);
      setResult(captureResult);
      onCapture?.(captureResult);
    } catch (err) {
      console.error('[StreetViewMultiAngle] Capture failed:', err);
    } finally {
      setCapturing(false);
    }
  }, [address, onCapture]);

  if (!result) {
    return (
      <button
        onClick={handleCapture}
        disabled={capturing || !address}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 text-sm font-medium transition-colors"
      >
        {capturing ? (
          <>
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Capturing views...
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Capture Multi-Angle Views
          </>
        )}
      </button>
    );
  }

  const allViews = [
    ...result.streetViews.map(sv => ({ src: sv.imageBase64, label: `${sv.label} View` })),
    ...(result.satelliteView ? [{ src: result.satelliteView, label: 'Satellite Overhead' }] : [])
  ];

  if (compact) {
    return (
      <div className="flex gap-1 overflow-x-auto">
        {allViews.map((view, i) => (
          <div key={i} className="flex-shrink-0 w-20 h-16 rounded overflow-hidden border relative group">
            <img src={view.src} alt={view.label} className="w-full h-full object-cover" />
            <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[8px] text-center py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              {view.label}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Main selected view */}
      <div className="rounded-lg overflow-hidden border mb-2">
        <img
          src={allViews[selectedAngle]?.src}
          alt={allViews[selectedAngle]?.label}
          className="w-full h-48 object-cover"
        />
        <div className="bg-gray-50 px-3 py-1 text-xs text-gray-600 font-medium">
          {allViews[selectedAngle]?.label}
        </div>
      </div>
      {/* Thumbnails */}
      <div className="flex gap-1">
        {allViews.map((view, i) => (
          <button
            key={i}
            onClick={() => setSelectedAngle(i)}
            className={`flex-1 h-14 rounded overflow-hidden border-2 transition-colors ${
              i === selectedAngle ? 'border-blue-500' : 'border-transparent hover:border-gray-300'
            }`}
          >
            <img src={view.src} alt={view.label} className="w-full h-full object-cover" />
          </button>
        ))}
      </div>
      <button
        onClick={handleCapture}
        disabled={capturing}
        className="mt-2 text-xs text-blue-600 hover:text-blue-800"
      >
        {capturing ? 'Re-capturing...' : 'Re-capture views'}
      </button>
    </div>
  );
};
