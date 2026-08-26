import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { loadGoogleMaps as loadGoogleMapsUtil } from '../utils/googleMaps';
import MetroDetailModal from './MetroDetailModal';

/**
 * RegionalHeatMap – Google Maps heat map visualization showing FRED metric growth
 * across major US metros using a custom canvas overlay.
 */

interface HeatMapPoint {
  code: string;
  name: string;
  lat: number;
  lng: number;
  value: number;
  date: string;
  yoyGrowth: number | null;
}

interface HeatMapData {
  metric: string;
  metricLabel: string;
  points: HeatMapPoint[];
  stats: {
    count: number;
    valueRange: { min: number; max: number };
    growthRange: { min: number; max: number } | null;
    avgGrowth: number | null;
  };
}

interface ZipOverlayPoint {
  zipCode: string;
  label?: string;
  lat: number;
  lng: number;
  derived?: {
    medianAskingRent?: number | null;
    grossYieldPct?: number | null;
  };
}

interface MapViewportSnapshot {
  north: number;
  south: number;
  east: number;
  west: number;
  centerLat: number;
  centerLng: number;
}

interface SupportedMetroZipOverlayArea {
  code: string;
  name: string;
  lat: number;
  lng: number;
  zipCount: number;
}

const FALLBACK_SUPPORTED_METRO_AREAS: SupportedMetroZipOverlayArea[] = [
  { code: '12420', name: 'Austin, TX', lat: 30.2752, lng: -97.7438, zipCount: 5 },
  { code: '41860', name: 'San Francisco, CA', lat: 37.7923, lng: -122.3497, zipCount: 5 },
  { code: '35620', name: 'New York, NY', lat: 40.7289, lng: -74.0041, zipCount: 5 },
  { code: '31080', name: 'Los Angeles, CA', lat: 34.0518, lng: -118.3979, zipCount: 5 },
  { code: '16980', name: 'Chicago, IL', lat: 41.9488, lng: -87.6774, zipCount: 5 },
  { code: '47900', name: 'Washington, DC', lat: 38.8995, lng: -77.0537, zipCount: 5 },
  { code: '33100', name: 'Miami, FL', lat: 25.8822, lng: -80.1715, zipCount: 5 },
  { code: '42660', name: 'Seattle, WA', lat: 47.6568, lng: -122.2638, zipCount: 5 },
  { code: '19740', name: 'Denver, CO', lat: 39.6997, lng: -104.9214, zipCount: 5 },
  { code: '14460', name: 'Boston, MA', lat: 42.3463, lng: -71.0845, zipCount: 5 },
  { code: '38060', name: 'Phoenix, AZ', lat: 33.5468, lng: -111.9673, zipCount: 5 },
  { code: '19100', name: 'Dallas, TX', lat: 32.8612, lng: -96.8574, zipCount: 5 },
  { code: '12060', name: 'Atlanta, GA', lat: 33.8233, lng: -84.4157, zipCount: 5 },
  { code: '26420', name: 'Houston, TX', lat: 29.7708, lng: -95.515, zipCount: 5 },
  { code: '41740', name: 'San Diego, CA', lat: 32.8024, lng: -117.1811, zipCount: 5 },
  { code: '33460', name: 'Minneapolis, MN', lat: 44.9607, lng: -93.2783, zipCount: 5 },
  { code: '45300', name: 'Tampa, FL', lat: 27.9765, lng: -82.4578, zipCount: 5 },
  { code: '38900', name: 'Portland, OR', lat: 45.5233, lng: -122.6714, zipCount: 5 },
  { code: '41180', name: 'St. Louis, MO', lat: 38.6183, lng: -90.2572, zipCount: 5 },
  { code: '19820', name: 'Detroit, MI', lat: 42.3754, lng: -83.0662, zipCount: 5 },
  { code: '34980', name: 'Nashville, TN', lat: 36.1561, lng: -86.7933, zipCount: 5 },
  { code: '16740', name: 'Charlotte, NC', lat: 35.2372, lng: -80.815, zipCount: 5 },
  { code: '39580', name: 'Raleigh, NC', lat: 35.8401, lng: -78.6953, zipCount: 5 },
  { code: '29820', name: 'Las Vegas, NV', lat: 36.1525, lng: -115.2312, zipCount: 5 },
  { code: '36740', name: 'Orlando, FL', lat: 28.5304, lng: -81.3633, zipCount: 5 },
  { code: '41940', name: 'San Jose, CA', lat: 37.3248, lng: -121.9125, zipCount: 5 },
  { code: '40900', name: 'Sacramento, CA', lat: 38.548, lng: -121.4886, zipCount: 5 },
  { code: '41620', name: 'Salt Lake City, UT', lat: 40.7365, lng: -111.8732, zipCount: 5 },
  { code: '28140', name: 'Kansas City, MO', lat: 39.0496, lng: -94.5763, zipCount: 5 },
];

function getZipOverlaySessionKey(cbsaCode: string) {
  return `regional-heatmap:metro-zips:${cbsaCode}`;
}

function readZipOverlaySessionCache(cbsaCode: string): ZipOverlayPoint[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(getZipOverlaySessionKey(cbsaCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeZipOverlaySessionCache(cbsaCode: string, markets: ZipOverlayPoint[]) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(getZipOverlaySessionKey(cbsaCode), JSON.stringify(markets));
  } catch {
    // Ignore storage failures and fall back to in-memory cache only.
  }
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function getHeatMapSessionKey(metric: string) {
  return `regional-heatmap:metric:${metric}`;
}

function readHeatMapSessionCache(metric: string): HeatMapData | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(getHeatMapSessionKey(metric));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.points) ? parsed : null;
  } catch {
    return null;
  }
}

function writeHeatMapSessionCache(metric: string, data: HeatMapData) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(getHeatMapSessionKey(metric), JSON.stringify(data));
  } catch {
    // Ignore storage failures.
  }
}

/** Warm Maps JS + default heat-map payload before the Regional tab opens. */
export function preloadRegionalHeatMap(metric = 'housing') {
  void loadGoogleMapsUtil();

  if (readHeatMapSessionCache(metric)) return;

  fetch(`${API_BASE_URL}/api/fred/heat-map?metric=${encodeURIComponent(metric)}`)
    .then((res) => res.json())
    .then((json) => {
      if (json.ok && json.data) writeHeatMapSessionCache(metric, json.data);
    })
    .catch(() => {
      // Best-effort prefetch only.
    });
}

function isPointInViewport(point: { lat: number; lng: number }, viewport: MapViewportSnapshot | null) {
  if (!viewport) return false;

  const withinLat = point.lat <= viewport.north && point.lat >= viewport.south;
  const withinLng = viewport.west <= viewport.east
    ? point.lng >= viewport.west && point.lng <= viewport.east
    : point.lng >= viewport.west || point.lng <= viewport.east;

  return withinLat && withinLng;
}

function squaredDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
  return ((lat1 - lat2) ** 2) + ((lng1 - lng2) ** 2);
}

function getViewportAnalysisKey(viewport: MapViewportSnapshot | null, zoom: number) {
  if (!viewport) return null;
  return [
    zoom,
    viewport.north.toFixed(2),
    viewport.south.toFixed(2),
    viewport.east.toFixed(2),
    viewport.west.toFixed(2),
    viewport.centerLat.toFixed(2),
    viewport.centerLng.toFixed(2),
  ].join(':');
}

function buildMetroFocusPoint(area: SupportedMetroZipOverlayArea, heatMapPoints: HeatMapPoint[]): HeatMapPoint {
  const existingPoint = heatMapPoints.find((point) => point.code === area.code);
  if (existingPoint) return existingPoint;

  return {
    code: area.code,
    name: area.name,
    lat: area.lat,
    lng: area.lng,
    value: 0,
    date: '',
    yoyGrowth: null,
  };
}

function getUnsupportedMetroSessionKey(cbsaCode: string) {
  return `regional-heatmap:metro-zips-unsupported:${cbsaCode}`;
}

function readUnsupportedMetroSessionCache(cbsaCode: string) {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(getUnsupportedMetroSessionKey(cbsaCode)) === '1';
}

function writeUnsupportedMetroSessionCache(cbsaCode: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(getUnsupportedMetroSessionKey(cbsaCode), '1');
  } catch {
    // Ignore storage failures and fall back to in-memory unsupported cache only.
  }
}

type MetricOption = 'housing' | 'unemployment' | 'income' | 'wages' | 'permits' | 'listings' | 'daysOnMarket' | 'newListings' | 'listingPrice' | 'priceReduced' | 'rentPrice' | 'rentalVacancy' | 'rentToPrice' | 'priceToRent' | 'inventoryVelocity' | 'gdp';

const METRIC_OPTIONS: { id: MetricOption; label: string; icon: string; description: string; invertColor?: boolean; landlordDefault?: boolean; landlordHint?: string }[] = [
  { id: 'housing',      label: 'Housing Price Index',   icon: '🏠', description: 'Case-Shiller / FHFA housing price indexes', landlordDefault: true, landlordHint: 'Tracks home-value appreciation that affects equity and refinance room.' },
  { id: 'rentToPrice',    label: 'Rent-to-Price Ratio',   icon: '📈', description: 'Rent parity ÷ listing price — higher = better rental yield potential', invertColor: true, landlordDefault: true, landlordHint: 'Higher ratios usually mean stronger cash-flow potential relative to purchase price.' },
  { id: 'unemployment', label: 'Unemployment Rate',     icon: '📊', description: 'BLS monthly unemployment rate', landlordDefault: true, landlordHint: 'Local job strength drives tenant demand and rent collection risk.' },
  { id: 'listings',     label: 'Active Listings',       icon: '📋', description: 'Monthly active listing inventory', landlordDefault: true, landlordHint: 'More inventory often means softer sale competition and longer days on market.' },
  { id: 'daysOnMarket', label: 'Days on Market',         icon: '⏱️', description: 'Median days on market — market velocity', landlordDefault: true, landlordHint: 'Slower turnover can signal weaker demand or overpriced listings.' },
  { id: 'income',       label: 'Per Capita Income',     icon: '💰', description: 'BEA per capita personal income by metro', invertColor: true },
  { id: 'wages',        label: 'Average Weekly Wage',   icon: '💵', description: 'BLS average weekly wages — total private', invertColor: true },
  { id: 'permits',      label: 'Building Permits',      icon: '🏗️', description: 'New private housing unit permits' },
  { id: 'gdp',          label: 'Metro GDP',             icon: '📊', description: 'Real GDP by metropolitan area (millions $)', invertColor: true },
  { id: 'newListings',  label: 'New Listings',           icon: '🆕', description: 'Monthly new listing count — supply pipeline' },
  { id: 'listingPrice', label: 'Median Listing Price',   icon: '💲', description: 'Median listing price by metro', invertColor: true },
  { id: 'priceReduced', label: 'Price Reductions',       icon: '📉', description: 'Price reduced listing count — seller capitulation signal' },
  { id: 'rentPrice',    label: 'Rent Price Parity',      icon: '🏘️', description: 'Regional rent price parity index (100 = national average)', invertColor: true },
  { id: 'rentalVacancy', label: 'Rental Vacancy Rate',   icon: '🏚️', description: 'Rental vacancy rate — state level (no metro-level data on FRED)' },
  { id: 'priceToRent',    label: 'Price-to-Rent Ratio',   icon: '🏷️', description: 'Listing price ÷ rent parity — lower = more affordable to invest' },
  { id: 'inventoryVelocity', label: 'Inventory Turnover', icon: '🔄', description: 'Active listings ÷ new listings — lower = faster-moving market' },
];

const DEFAULT_LANDLORD_METRICS = METRIC_OPTIONS.filter((m) => m.landlordDefault);

function growthColor(value: number | null, min: number, max: number, invertColor = false): string {
  if (value === null) return '#94a3b8';
  const range = max - min || 1;
  let t = (value - min) / range;
  if (invertColor) t = 1 - t;
  if (t < 0.5) {
    const p = t * 2;
    const r = Math.round(34 + p * (234 - 34));
    const g = Math.round(197 + p * (179 - 197));
    const b = Math.round(94 + p * (8 - 94));
    return `rgb(${r},${g},${b})`;
  } else {
    const p = (t - 0.5) * 2;
    const r = Math.round(234 + p * (239 - 234));
    const g = Math.round(179 + p * (68 - 179));
    const b = Math.round(8 + p * (68 - 8));
    return `rgb(${r},${g},${b})`;
  }
}

function formatMetricValue(value: number, metric: MetricOption): string {
  switch (metric) {
    case 'unemployment':
      return `${value.toFixed(1)}%`;
    case 'income':
      return `$${(value / 1000).toFixed(1)}k`;
    case 'wages':
      return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    case 'permits':
    case 'listings':
    case 'newListings':
    case 'priceReduced':
      return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    case 'daysOnMarket':
      return `${Math.round(value)} days`;
    case 'listingPrice':
      return value >= 1000000
        ? `$${(value / 1000000).toFixed(2)}M`
        : `$${(value / 1000).toFixed(0)}k`;
    case 'rentPrice':
      return value.toFixed(1);
    case 'rentalVacancy':
      return `${value.toFixed(1)}%`;
    case 'rentToPrice':
      return value.toFixed(2);
    case 'priceToRent':
      return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    case 'inventoryVelocity':
      return `${value.toFixed(1)}×`;
    case 'gdp':
      return value >= 1000000
        ? `$${(value / 1000000).toFixed(1)}T`
        : value >= 1000
          ? `$${(value / 1000).toFixed(1)}B`
          : `$${value.toFixed(0)}M`;
    case 'housing':
    default:
      return value.toFixed(1);
  }
}

interface RegionalHeatMapProps {
  loadGoogleMaps?: () => Promise<void>;
}

const RegionalHeatMap: React.FC<RegionalHeatMapProps> = ({ loadGoogleMaps = loadGoogleMapsUtil }) => {
  const [selectedMetric, setSelectedMetric] = useState<MetricOption>('housing');
  const [colorBy, setColorBy] = useState<'growth' | 'value'>('growth');
  const [data, setData] = useState<HeatMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMoreMetrics, setShowMoreMetrics] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const heatMapAbortRef = useRef<AbortController | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<HeatMapPoint | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [selectedMetroForModal, setSelectedMetroForModal] = useState<HeatMapPoint | null>(null);
  const [focusedMetroForZips, setFocusedMetroForZips] = useState<HeatMapPoint | null>(null);
  const [selectedZipCodeForModal, setSelectedZipCodeForModal] = useState<string | null>(null);
  const [zipOverlayPoints, setZipOverlayPoints] = useState<ZipOverlayPoint[]>([]);
  const [zipOverlayLoading, setZipOverlayLoading] = useState(false);
  const [zipOverlayError, setZipOverlayError] = useState<string | null>(null);
  const [mapZoom, setMapZoom] = useState(4);
  const [viewport, setViewport] = useState<MapViewportSnapshot | null>(null);
  const [supportedMetroAreas] = useState<SupportedMetroZipOverlayArea[]>(FALLBACK_SUPPORTED_METRO_AREAS);
  const [lastAnalyzedViewportKey, setLastAnalyzedViewportKey] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const zipMarkersRef = useRef<any[]>([]);
  const infoWindowRef = useRef<any>(null);
  const zipOverlayCacheRef = useRef<Map<string, ZipOverlayPoint[]>>(new Map());
  const unsupportedZipOverlayMetrosRef = useRef<Set<string>>(new Set());
  const zipOverlayRequestRef = useRef<{ metroCode: string | null; requestId: number }>({ metroCode: null, requestId: 0 });
  const viewportAnalysisKey = useMemo(() => getViewportAnalysisKey(viewport, mapZoom), [viewport, mapZoom]);

  // Preload Maps JS in parallel with heat-map data fetch
  useEffect(() => {
    void loadGoogleMaps();
  }, [loadGoogleMaps]);

  // ── Fetch FRED heat map data (abort stale + never flash wrong metric) ──
  useEffect(() => {
    heatMapAbortRef.current?.abort();
    const controller = new AbortController();
    heatMapAbortRef.current = controller;

    const cached = readHeatMapSessionCache(selectedMetric);
    // Clear previous metric immediately so UI never shows stale points
    setData(cached);
    setLoading(true);
    setError(null);
    setHoveredPoint(null);

    const fetchData = async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/fred/heat-map?metric=${encodeURIComponent(selectedMetric)}`,
          { signal: controller.signal },
        );
        const json = await res.json();
        if (controller.signal.aborted) return;
        if (!json.ok) throw new Error(json.error || 'Failed to fetch heat map data');
        setData(json.data);
        writeHeatMapSessionCache(selectedMetric, json.data);
        setError(null);
      } catch (err: any) {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        console.error('[RegionalHeatMap] Fetch error:', err);
        setData(null);
        setError(err.message || 'Failed to load heat map');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void fetchData();
    return () => {
      controller.abort();
    };
  }, [selectedMetric, retryToken]);

  // ── Initialize Google Map (uses callback ref so it fires when div mounts) ──
  const initMap = useCallback(async (container: HTMLDivElement | null) => {
    mapContainerRef.current = container;
    if (!container) return;

    const existingMap = mapInstanceRef.current;
    if (existingMap?.getDiv?.() === container) return;

    if (existingMap) {
      mapInstanceRef.current = null;
      overlayRef.current = null;
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
    }

    setMapReady(false);

    try {
      await loadGoogleMaps();
      if (!(window as any).google?.maps || !mapContainerRef.current) return;

      const google = (window as any).google;
      const mapInstance = new google.maps.Map(mapContainerRef.current, {
        center: { lat: 39.0, lng: -98.0 },
        zoom: 4,
        mapTypeId: 'roadmap',
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          { featureType: 'water', stylers: [{ color: '#e0e8f0' }] },
          { featureType: 'landscape', stylers: [{ color: '#f8fafc' }] },
          { featureType: 'road', stylers: [{ visibility: 'simplified' }] },
          { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
          { featureType: 'administrative.province', elementType: 'geometry.stroke', stylers: [{ color: '#cbd5e1', weight: 1 }] },
        ],
      });

      mapInstanceRef.current = mapInstance;
      infoWindowRef.current = new google.maps.InfoWindow();
      setMapZoom(mapInstance.getZoom() || 4);
      mapInstance.addListener('zoom_changed', () => {
        setMapZoom(mapInstance.getZoom() || 4);
      });
      mapInstance.addListener('idle', () => {
        const bounds = mapInstance.getBounds();
        const center = mapInstance.getCenter();
        if (!bounds || !center) return;
        const northEast = bounds.getNorthEast();
        const southWest = bounds.getSouthWest();
        setViewport({
          north: northEast.lat(),
          south: southWest.lat(),
          east: northEast.lng(),
          west: southWest.lng(),
          centerLat: center.lat(),
          centerLng: center.lng(),
        });
      });
      requestAnimationFrame(() => {
        if (!mapInstanceRef.current) return;
        google.maps.event.trigger(mapInstanceRef.current, 'resize');
        setMapReady(true);
      });
      console.log('[RegionalHeatMap] ✅ Google Map initialised');
    } catch (err) {
      console.error('[RegionalHeatMap] Google Maps init error:', err);
    }
  }, [loadGoogleMaps]);

  useEffect(() => {
    if (!focusedMetroForZips?.code) {
      setZipOverlayPoints([]);
      setZipOverlayError(null);
      setZipOverlayLoading(false);
      return;
    }

    const metroCode = focusedMetroForZips.code;
    const isSupportedMetro = supportedMetroAreas.some((area) => area.code === metroCode);
    if (!isSupportedMetro || unsupportedZipOverlayMetrosRef.current.has(metroCode) || readUnsupportedMetroSessionCache(metroCode)) {
      unsupportedZipOverlayMetrosRef.current.add(metroCode);
      setZipOverlayPoints([]);
      setZipOverlayLoading(false);
      setZipOverlayError('ZIP overlay not available for this metro yet.');
      return;
    }

    const memoryCached = zipOverlayCacheRef.current.get(metroCode);
    if (memoryCached) {
      setZipOverlayPoints(memoryCached);
      setZipOverlayError(null);
      setZipOverlayLoading(false);
      return;
    }

    const sessionCached = readZipOverlaySessionCache(metroCode);
    if (sessionCached?.length) {
      zipOverlayCacheRef.current.set(metroCode, sessionCached);
      setZipOverlayPoints(sessionCached);
      setZipOverlayError(null);
      setZipOverlayLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = zipOverlayRequestRef.current.requestId + 1;
    zipOverlayRequestRef.current = { metroCode, requestId };
    setZipOverlayLoading(true);
    setZipOverlayError(null);

    fetch(`${API_BASE_URL}/api/rentcast/metro-zips?metro=${encodeURIComponent(metroCode)}`)
      .then(res => res.json().then((json) => ({ ok: res.ok, json })))
      .then(({ ok, json }) => {
        if (!ok || !json.ok) throw new Error(json.error || 'Failed to load ZIP overlay data');
        if (cancelled) return;
        if (zipOverlayRequestRef.current.metroCode !== metroCode || zipOverlayRequestRef.current.requestId !== requestId) return;
        const markets = json.data?.markets || [];
        zipOverlayCacheRef.current.set(metroCode, markets);
        writeZipOverlaySessionCache(metroCode, markets);
        setZipOverlayPoints(markets);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (zipOverlayRequestRef.current.metroCode !== metroCode || zipOverlayRequestRef.current.requestId !== requestId) return;
        if (err.message === 'metro_zip_market_not_supported') {
          unsupportedZipOverlayMetrosRef.current.add(metroCode);
          writeUnsupportedMetroSessionCache(metroCode);
          setZipOverlayError('ZIP overlay not available for this metro yet.');
          setZipOverlayPoints([]);
          return;
        }
        setZipOverlayPoints([]);
        setZipOverlayError(err.message);
      })
      .finally(() => {
        if (!cancelled) {
          setZipOverlayLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [focusedMetroForZips?.code, supportedMetroAreas]);

  useEffect(() => {
    if (!lastAnalyzedViewportKey || !viewportAnalysisKey) return;
    if (lastAnalyzedViewportKey === viewportAnalysisKey) return;

    setFocusedMetroForZips(null);
    setZipOverlayPoints([]);
    setZipOverlayLoading(false);
    setZipOverlayError(null);
    setLastAnalyzedViewportKey(null);
  }, [lastAnalyzedViewportKey, viewportAnalysisKey]);

  const analyzeCurrentArea = useCallback(() => {
    if (!viewport || mapZoom < 7) {
      setZipOverlayError('Zoom to level 7 or tighter before analyzing this area.');
      setFocusedMetroForZips(null);
      setZipOverlayPoints([]);
      return;
    }

    const visibleMetros = supportedMetroAreas.filter((point) => {
      if (unsupportedZipOverlayMetrosRef.current.has(point.code)) return false;
      if (readUnsupportedMetroSessionCache(point.code)) return false;
      return isPointInViewport(point, viewport);
    });

    if (!visibleMetros.length) {
      setFocusedMetroForZips(null);
      setZipOverlayPoints([]);
      setZipOverlayError('RentCast ZIP overlay is not available for the area currently in view.');
      setLastAnalyzedViewportKey(viewportAnalysisKey);
      return;
    }

    const nextMetroArea = visibleMetros.reduce((best, point) => {
      if (!best) return point;
      const bestDistance = squaredDistance(best.lat, best.lng, viewport.centerLat, viewport.centerLng);
      const pointDistance = squaredDistance(point.lat, point.lng, viewport.centerLat, viewport.centerLng);
      return pointDistance < bestDistance ? point : best;
    }, null as SupportedMetroZipOverlayArea | null);

    if (!nextMetroArea) {
      setZipOverlayError('Unable to resolve a supported metro for the current map area.');
      return;
    }

    setFocusedMetroForZips(buildMetroFocusPoint(nextMetroArea, data?.points || []));
    setZipOverlayError(null);
    setLastAnalyzedViewportKey(viewportAnalysisKey);
  }, [data?.points, mapZoom, supportedMetroAreas, viewport, viewportAnalysisKey]);

  const openMetroModal = useCallback((point: HeatMapPoint, zipCode: string | null = null) => {
    setFocusedMetroForZips(point);
    setSelectedZipCodeForModal(zipCode);
    setSelectedMetroForModal(point);

    const map = mapInstanceRef.current;
    if (map) {
      map.panTo({ lat: point.lat, lng: point.lng });
      if ((map.getZoom() || 4) < 7) {
        map.setZoom(7);
      }
    }
  }, []);

  // ── High-resolution US boundary polygon for smooth clipping ──
  const US_BOUNDARY: [number, number][] = useMemo(() => [
    // Pacific NW coast (WA → OR → CA) – detailed coastline
    [48.99, -124.71], [48.78, -124.70], [48.50, -124.66], [48.38, -124.64],
    [48.22, -124.61], [47.90, -124.63], [47.60, -124.54], [47.30, -124.46],
    [47.00, -124.38], [46.73, -124.20], [46.50, -124.08], [46.27, -124.06],
    [46.00, -123.95], [45.80, -123.97], [45.50, -123.98], [45.10, -124.02],
    [44.70, -124.10], [44.30, -124.20], [43.80, -124.30], [43.37, -124.35],
    [43.00, -124.38], [42.70, -124.40], [42.40, -124.38], [42.00, -124.30],
    [41.75, -124.25], [41.50, -124.20], [41.20, -124.22], [40.90, -124.35],
    [40.60, -124.38], [40.43, -124.40], [40.20, -124.35], [39.95, -124.08],
    [39.70, -123.85], [39.40, -123.80], [39.10, -123.72], [38.95, -123.70],
    [38.70, -123.50], [38.35, -123.10], [38.10, -122.90], [37.90, -122.68],
    [37.78, -122.50], [37.60, -122.38], [37.30, -122.20], [37.05, -122.10],
    [36.80, -121.80], [36.55, -121.95], [36.30, -121.90], [36.00, -121.55],
    [35.70, -121.30], [35.57, -121.10], [35.35, -120.90], [35.10, -120.65],
    [34.85, -120.60], [34.60, -120.48], [34.45, -120.50], [34.30, -120.00],
    [34.05, -119.50], [34.00, -118.95], [33.95, -118.60], [33.85, -118.40],
    [33.72, -118.10], [33.55, -117.90], [33.40, -117.60], [33.20, -117.40],
    [33.00, -117.30], [32.80, -117.25], [32.53, -117.13],
    // US-Mexico border (CA → AZ → NM → TX)
    [32.62, -116.10], [32.72, -115.50], [32.68, -115.00], [32.49, -114.80],
    [32.20, -114.50], [31.90, -113.80], [31.70, -113.00], [31.50, -112.00],
    [31.33, -111.10], [31.33, -110.50], [31.33, -109.50], [31.33, -108.20],
    [31.50, -108.00], [31.78, -107.60], [31.78, -106.50], [31.40, -106.20],
    [30.90, -105.50], [30.30, -104.90], [29.76, -104.40], [29.55, -103.80],
    [29.38, -103.20], [29.10, -103.00], [28.95, -102.80], [29.00, -102.10],
    [29.00, -101.40], [28.50, -100.40], [28.00, -99.90], [27.50, -99.50],
    [27.00, -98.60], [26.50, -97.80], [26.00, -97.20],
    // Texas Gulf coast – tight to Padre Island / Galveston coastline
    [26.07, -97.18], [26.20, -97.15], [26.60, -97.17], [26.80, -97.30],
    [27.30, -97.32], [27.60, -97.22], [27.80, -97.10], [28.00, -96.85],
    [28.30, -96.40], [28.55, -96.00], [28.70, -95.70], [28.85, -95.40],
    [29.00, -95.15], [29.10, -95.00], [29.30, -94.90], [29.35, -94.75],
    [29.50, -94.70], [29.55, -94.50], [29.60, -94.10],
    // Louisiana coast – follows bayous and barrier islands tightly
    [29.72, -93.85], [29.77, -93.40], [29.78, -93.10], [29.77, -92.80],
    [29.70, -92.50], [29.58, -92.20], [29.55, -91.90], [29.50, -91.60],
    [29.40, -91.40], [29.30, -91.20], [29.18, -91.05], [29.10, -90.80],
    [29.05, -90.50], [29.00, -90.20], [28.95, -90.00], [29.00, -89.80],
    [29.05, -89.60], [29.10, -89.40], [29.15, -89.25], [29.20, -89.10],
    [29.25, -89.00], [29.40, -88.95], [29.60, -88.90], [30.00, -88.85],
    [30.15, -88.75], [30.22, -88.65],
    // Gulf coast: MS → AL → FL panhandle
    [30.22, -88.30], [30.24, -87.80], [30.24, -87.50], [30.28, -87.20],
    [30.28, -86.80], [30.32, -86.50], [30.38, -86.10], [30.35, -85.80],
    [30.25, -85.50], [30.15, -85.30], [30.00, -85.00], [29.92, -84.80],
    [29.80, -84.50], [29.60, -84.20], [29.40, -83.90], [29.30, -83.70],
    [29.10, -83.30], [28.95, -83.00], [28.85, -82.85], [28.80, -82.80],
    // Florida peninsula (west coast → tip → east coast)
    [28.60, -82.75], [28.40, -82.72], [28.20, -82.75], [28.00, -82.72],
    [27.80, -82.72], [27.60, -82.65], [27.40, -82.58], [27.20, -82.50],
    [27.00, -82.45], [26.80, -82.30], [26.50, -82.15], [26.30, -82.00],
    [26.00, -81.90], [25.80, -81.70], [25.60, -81.50], [25.40, -81.30],
    [25.20, -81.10], [25.00, -81.15], [24.80, -81.30], [24.60, -81.65],
    [24.52, -81.80], [24.55, -81.50], [24.60, -81.20], [24.80, -80.90],
    [25.00, -80.50], [25.10, -80.25], [25.30, -80.15], [25.60, -80.12],
    [25.80, -80.10], [26.10, -80.08], [26.40, -80.06], [26.70, -80.05],
    [26.90, -80.05], [27.10, -80.12], [27.30, -80.18], [27.60, -80.25],
    [27.90, -80.38], [28.20, -80.45], [28.50, -80.52], [28.75, -80.58],
    [29.00, -80.90], [29.10, -81.00], [29.40, -81.12], [29.70, -81.22],
    [30.00, -81.35], [30.30, -81.42],
    // Atlantic coast: GA → SC → NC → VA → MD → DE → NJ → NY → New England
    [30.70, -81.35], [31.00, -81.20], [31.40, -81.10], [31.80, -81.00],
    [32.00, -80.90], [32.40, -80.60], [32.80, -79.90], [33.20, -79.30],
    [33.50, -78.90], [33.80, -78.60], [34.00, -78.10], [34.20, -77.80],
    [34.50, -77.50], [34.80, -76.60], [35.00, -76.00], [35.20, -75.50],
    [35.50, -75.45], [35.80, -75.50], [36.00, -75.50], [36.30, -75.80],
    [36.55, -75.90], [36.90, -76.00], [36.95, -76.15], [37.00, -76.30],
    [37.10, -76.25], [37.20, -76.00], [37.35, -75.90], [37.60, -75.60],
    [37.80, -75.50], [38.00, -75.30], [38.30, -75.10], [38.50, -75.05],
    [38.70, -75.05], [38.90, -75.00], [39.10, -74.85], [39.30, -74.50],
    [39.50, -74.20], [39.75, -74.10], [40.00, -74.00], [40.25, -73.95],
    [40.50, -74.00], [40.55, -73.75], [40.65, -73.70], [40.70, -73.60],
    [40.85, -73.40], [40.95, -73.10], [41.05, -72.50], [41.10, -72.00],
    [41.20, -71.85], [41.30, -71.80], [41.50, -71.40], [41.65, -70.70],
    [41.70, -70.00], [41.90, -69.95], [42.00, -70.00], [42.10, -70.20],
    [42.30, -70.60], [42.50, -70.65], [42.70, -70.70], [42.90, -70.60],
    [43.10, -70.50], [43.30, -70.35], [43.60, -70.20], [43.80, -69.80],
    [44.00, -69.30], [44.20, -68.60], [44.30, -68.20], [44.50, -67.80],
    [44.80, -67.00], [45.10, -67.10], [45.50, -67.30], [47.00, -67.80],
    [47.30, -68.30], [47.35, -68.38],
    // Northern border: ME → VT/NH → NY → Great Lakes → MN → ND → MT → WA
    [46.50, -69.20], [46.00, -70.00], [45.50, -70.50], [45.30, -71.00],
    [45.00, -71.50], [45.00, -72.00], [45.00, -73.00], [45.00, -74.00],
    [45.00, -74.70], [44.50, -75.00], [44.20, -75.80], [43.80, -76.30],
    [43.60, -76.80], [43.45, -77.50], [43.30, -78.30], [43.20, -79.00],
    [43.00, -79.05], [42.80, -79.40], [42.50, -79.80], [42.30, -80.10],
    [42.10, -80.30], [42.00, -80.50], [41.85, -81.20], [41.75, -82.00],
    [41.70, -82.70], [41.70, -83.10], [41.73, -83.50], [41.90, -83.30],
    [42.00, -83.10], [42.30, -82.90], [42.60, -82.60], [43.00, -82.40],
    [43.40, -82.40], [43.80, -82.50], [44.20, -83.00], [44.60, -83.50],
    [44.80, -83.80], [45.20, -84.30], [45.50, -84.80], [45.80, -84.70],
    [46.00, -84.50], [46.25, -84.40], [46.50, -84.40], [46.50, -84.80],
    [46.50, -85.00], [46.60, -85.50], [46.70, -86.00], [46.80, -86.50],
    [46.85, -87.00], [46.90, -87.50], [46.75, -88.00], [46.60, -88.50],
    [46.50, -88.80], [46.60, -89.20], [46.70, -89.60], [46.80, -90.00],
    [46.80, -90.40], [46.80, -90.80], [46.90, -91.10], [47.10, -91.40],
    [47.30, -91.50], [47.60, -91.00], [47.80, -90.40], [48.00, -89.50],
    [48.20, -88.80], [48.30, -88.50], [48.40, -89.00], [48.50, -89.50],
    [48.60, -89.80], [48.60, -90.50], [48.60, -91.00], [48.60, -91.50],
    [48.60, -92.00], [48.65, -92.50], [48.70, -93.50], [48.70, -94.00],
    [48.70, -94.70], [49.00, -95.10],
    // 49th parallel → Pacific coast
    [49.00, -96.00], [49.00, -97.00], [49.00, -98.00], [49.00, -99.00],
    [49.00, -100.00], [49.00, -101.00], [49.00, -102.00], [49.00, -103.00],
    [49.00, -104.00], [49.00, -105.00], [49.00, -106.00], [49.00, -107.00],
    [49.00, -108.00], [49.00, -109.00], [49.00, -110.00], [49.00, -111.00],
    [49.00, -112.00], [49.00, -113.00], [49.00, -114.00], [49.00, -115.00],
    [49.00, -116.00], [49.00, -117.00], [49.00, -118.00], [49.00, -119.00],
    [49.00, -120.00], [49.00, -121.00], [49.00, -122.00], [49.00, -123.00],
    [48.99, -124.71], // close polygon
  ], []);

  // ── Distance from point to nearest polygon edge (in degrees, approx) ──
  const distToPolygonEdge = useCallback((lat: number, lng: number): number => {
    const poly = US_BOUNDARY;
    let minDist = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ay = poly[j][0], ax = poly[j][1];
      const by = poly[i][0], bx = poly[i][1];
      // Project point onto segment
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((lng - ax) * dx + (lat - ay) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy;
      const ex = lng - px, ey = lat - py;
      const dist = Math.sqrt(ex * ex + ey * ey);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }, [US_BOUNDARY]);

  // ── Update IDW canvas overlay + markers when data / colorBy changes ──
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapReady || !data?.points?.length || !(window as any).google?.maps) return;

    const google = (window as any).google;
    const metricCfg = METRIC_OPTIONS.find(m => m.id === selectedMetric)!;
    const invert = (metricCfg.invertColor && colorBy === 'growth') || false;

    // Compute color range
    let min: number, max: number;
    if (colorBy === 'growth') {
      const growths = data.points.map(p => p.yoyGrowth).filter((v): v is number => v !== null);
      min = growths.length ? Math.min(...growths) : 0;
      max = growths.length ? Math.max(...growths) : 1;
    } else {
      min = data.stats.valueRange.min;
      max = data.stats.valueRange.max;
    }

    // Clear previous
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];
    if (overlayRef.current) {
      overlayRef.current.setMap(null);
      overlayRef.current = null;
    }

    // ── IDW color function: returns [r, g, b] for a normalised t (0‒1) ──
    // green (low) → yellow (mid) → red (high)
    const heatRGB = (t: number): [number, number, number] => {
      const tc = invert ? 1 - t : t;
      if (tc < 0.5) {
        const p = tc * 2;
        return [Math.round(34 + p * 200), Math.round(197 - p * 17), Math.round(94 - p * 86)];
      }
      const p = (tc - 0.5) * 2;
      return [Math.round(234 + p * 5), Math.round(179 - p * 111), Math.round(8 + p * 60)];
    };

    // Prepare point data for IDW
    const pts = data.points
      .map(p => ({
        lat: p.lat,
        lng: p.lng,
        val: colorBy === 'growth' ? p.yoyGrowth : p.value,
      }))
      .filter(p => p.val !== null) as { lat: number; lng: number; val: number }[];

    // ── Custom OverlayView with canvas-based IDW interpolation ──
    const IDWOverlay = class extends google.maps.OverlayView {
      canvas: HTMLCanvasElement | null = null;
      onAdd() {
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.pointerEvents = 'none';
        const pane = this.getPanes()?.overlayLayer;
        if (pane) pane.appendChild(this.canvas);
      }
      draw() {
        if (!this.canvas) return;
        const proj = this.getProjection();
        if (!proj) return;

        const bounds = map.getBounds();
        if (!bounds) return;
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();

        const topLeft = proj.fromLatLngToDivPixel(new google.maps.LatLng(ne.lat(), sw.lng()));
        const bottomRight = proj.fromLatLngToDivPixel(new google.maps.LatLng(sw.lat(), ne.lng()));
        if (!topLeft || !bottomRight) return;

        const width = bottomRight.x - topLeft.x;
        const height = bottomRight.y - topLeft.y;

        // Position canvas
        this.canvas.style.left = topLeft.x + 'px';
        this.canvas.style.top = topLeft.y + 'px';
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';

        // Render at lower resolution for performance, then scale up
        const SCALE = 3; // every 3rd pixel
        const cw = Math.ceil(width / SCALE);
        const ch = Math.ceil(height / SCALE);
        this.canvas.width = cw;
        this.canvas.height = ch;

        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;
        const imgData = ctx.createImageData(cw, ch);
        const d = imgData.data;

        // Ray-casting point-in-polygon test
        const insideUS = (lat: number, lng: number): boolean => {
          // Quick bounding-box reject
          if (lat < 24 || lat > 50 || lng < -125 || lng > -66) return false;
          const poly = US_BOUNDARY;
          let inside = false;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const yi = poly[i][0], xi = poly[i][1];
            const yj = poly[j][0], xj = poly[j][1];
            if (((yi > lat) !== (yj > lat)) &&
                (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
              inside = !inside;
            }
          }
          return inside;
        };

        // Edge feather width in degrees – provides smooth fade at boundary
        const FEATHER_DEG = 0.18;

        // IDW power parameter — higher = more localised
        const power = 2.5;
        // Max influence distance in degrees (~radius of influence)
        const maxDist = 12;
        const maxDist2 = maxDist * maxDist;

        for (let py = 0; py < ch; py++) {
          for (let px = 0; px < cw; px++) {
            // Convert pixel → latlng
            const divPt = new google.maps.Point(
              topLeft.x + px * SCALE,
              topLeft.y + py * SCALE
            );
            const ll = proj.fromDivPixelToLatLng(divPt);
            if (!ll) continue;
            const lat = ll.lat();
            const lng = ll.lng();

            // Skip if outside US polygon boundary
            if (!insideUS(lat, lng)) continue;

            // Compute edge feather factor (smooth fade near boundary)
            const edgeDist = distToPolygonEdge(lat, lng);
            const edgeFade = Math.min(1, edgeDist / FEATHER_DEG);
            // Smooth-step for a nicer falloff
            const edgeAlpha = edgeFade * edgeFade * (3 - 2 * edgeFade);

            // IDW interpolation
            let weightedSum = 0;
            let weightSum = 0;
            for (const p of pts) {
              const dlat = lat - p.lat;
              const dlng = (lng - p.lng) * Math.cos(lat * Math.PI / 180); // longitude correction
              const dist2 = dlat * dlat + dlng * dlng;
              if (dist2 < 0.001) {
                // Essentially on the point
                weightedSum = p.val;
                weightSum = 1;
                break;
              }
              if (dist2 > maxDist2) continue; // too far
              const w = 1 / Math.pow(Math.sqrt(dist2), power);
              weightedSum += w * p.val;
              weightSum += w;
            }

            if (weightSum === 0) continue; // no nearby points

            const interpolated = weightedSum / weightSum;
            const t = Math.max(0, Math.min(1, (interpolated - min) / (max - min || 1)));
            const [r, g, b] = heatRGB(t);

            // Fade opacity near edges of influence and near boundary
            const alpha = Math.min(weightSum * 50, 1) * 0.55 * edgeAlpha;

            const idx = (py * cw + px) * 4;
            d[idx] = r;
            d[idx + 1] = g;
            d[idx + 2] = b;
            d[idx + 3] = Math.round(alpha * 255);
          }
        }

        ctx.putImageData(imgData, 0, 0);
      }
      onRemove() {
        if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
      }
    };

    const overlay = new IDWOverlay();
    overlay.setMap(map);
    overlayRef.current = overlay;

    // ── Dot markers on top ──
    data.points.forEach((point) => {
      const val = colorBy === 'growth' ? point.yoyGrowth : point.value;
      const color = growthColor(val, min, max, invert);

      const marker = new google.maps.Marker({
        position: { lat: point.lat, lng: point.lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 5,
          fillColor: '#ffffff',
          fillOpacity: 0.9,
          strokeColor: color,
          strokeWeight: 2,
        },
        title: point.name,
        zIndex: 10,
      });

      marker.addListener('click', () => {
        openMetroModal(point);
      });

      marker.addListener('mouseover', () => {
        marker.setIcon({ ...marker.getIcon(), scale: 7, strokeWeight: 3 });
        setHoveredPoint(point);
      });
      marker.addListener('mouseout', () => {
        marker.setIcon({ ...marker.getIcon(), scale: 5, strokeWeight: 2 });
        setHoveredPoint(null);
      });

      markersRef.current.push(marker);
    });

    return () => {
      if (overlayRef.current) {
        overlayRef.current.setMap(null);
        overlayRef.current = null;
      }
    };
  }, [data, colorBy, selectedMetric, mapReady, US_BOUNDARY, distToPolygonEdge, openMetroModal]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !(window as any).google?.maps) return;

    zipMarkersRef.current.forEach((marker) => marker.setMap(null));
    zipMarkersRef.current = [];

    if (!focusedMetroForZips || mapZoom < 7 || !zipOverlayPoints.length) {
      return;
    }

    const google = (window as any).google;

    zipOverlayPoints.forEach((zipPoint) => {
      const marker = new google.maps.Marker({
        position: { lat: zipPoint.lat, lng: zipPoint.lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: '#10b981',
          fillOpacity: 0.85,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        title: `${zipPoint.zipCode}${zipPoint.label ? ` · ${zipPoint.label}` : ''}`,
        zIndex: 20,
      });

      marker.addListener('click', () => {
        openMetroModal(focusedMetroForZips, zipPoint.zipCode);
      });

      marker.addListener('mouseover', () => {
        const rentText = zipPoint.derived?.medianAskingRent
          ? `$${Math.round(zipPoint.derived.medianAskingRent).toLocaleString()}`
          : 'N/A';
        const yieldText = zipPoint.derived?.grossYieldPct !== null && zipPoint.derived?.grossYieldPct !== undefined
          ? `${zipPoint.derived.grossYieldPct}%`
          : 'N/A';
        infoWindowRef.current?.setContent(`
          <div style="padding: 8px 10px; min-width: 180px; font-family: system-ui;">
            <div style="font-weight: 700; color: #0f172a; margin-bottom: 4px;">ZIP ${zipPoint.zipCode}</div>
            <div style="font-size: 12px; color: #64748b; margin-bottom: 8px;">${zipPoint.label || focusedMetroForZips.name}</div>
            <div style="font-size: 12px; color: #0f172a;">Median asking rent: <strong>${rentText}</strong></div>
            <div style="font-size: 12px; color: #0f172a;">Gross yield proxy: <strong>${yieldText}</strong></div>
            <div style="font-size: 11px; color: #64748b; margin-top: 6px;">Click to open ZIP drilldown in the metro modal.</div>
          </div>
        `);
        infoWindowRef.current?.open(map, marker);
      });

      marker.addListener('mouseout', () => {
        infoWindowRef.current?.close();
      });

      zipMarkersRef.current.push(marker);
    });

    return () => {
      zipMarkersRef.current.forEach((marker) => marker.setMap(null));
      zipMarkersRef.current = [];
    };
  }, [focusedMetroForZips, mapZoom, openMetroModal, zipOverlayPoints]);

  const metricConfig = METRIC_OPTIONS.find(m => m.id === selectedMetric)!;
  const invertColor = metricConfig.invertColor || false;
  const canAnalyzeArea = Boolean(viewport && mapZoom >= 7 && supportedMetroAreas.length);
  const areaAnalysisPending = canAnalyzeArea && viewportAnalysisKey !== lastAnalyzedViewportKey;

  // Sorted for table
  const sortedPoints = useMemo(() => {
    if (!data?.points) return [];
    return [...data.points].sort((a, b) => {
      if (colorBy === 'growth') return (b.yoyGrowth ?? -Infinity) - (a.yoyGrowth ?? -Infinity);
      return b.value - a.value;
    });
  }, [data, colorBy]);

  const { min, max } = useMemo(() => {
    if (!data?.points?.length) return { min: 0, max: 1 };
    if (colorBy === 'growth') {
      const growths = data.points.map(p => p.yoyGrowth).filter((v): v is number => v !== null);
      if (!growths.length) return { min: 0, max: 1 };
      return { min: Math.min(...growths), max: Math.max(...growths) };
    }
    return { min: data.stats.valueRange.min, max: data.stats.valueRange.max };
  }, [data, colorBy]);

  return (
    <div className="space-y-4">
      {/* Metric selector — landlord defaults + more metrics expander */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Heat map metric
        </label>
        <select
          value={selectedMetric}
          onChange={(e) => setSelectedMetric(e.target.value as MetricOption)}
          className="w-full max-w-md rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300"
        >
          <optgroup label="Landlord essentials">
            {DEFAULT_LANDLORD_METRICS.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </optgroup>
          {showMoreMetrics && (
            <optgroup label="More FRED metrics">
              {METRIC_OPTIONS.filter((m) => !m.landlordDefault).map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </optgroup>
          )}
        </select>
        {!showMoreMetrics && (
          <button
            type="button"
            onClick={() => setShowMoreMetrics(true)}
            className="text-xs font-semibold text-slate-600 underline-offset-2 hover:underline"
          >
            More metrics
          </button>
        )}
        {metricConfig.landlordHint || metricConfig.description ? (
          <p className="text-sm text-slate-600 leading-relaxed">
            {metricConfig.landlordHint || metricConfig.description}
          </p>
        ) : null}
      </div>

      {/* Color-by toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-slate-500">Color by:</span>
        <button
          onClick={() => setColorBy('growth')}
          className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
            colorBy === 'growth' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          YoY Growth %
        </button>
        <button
          onClick={() => setColorBy('value')}
          className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
            colorBy === 'value' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          Current Value
        </button>
      </div>

      {error && !data && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-700">
          <span className="font-medium">Error:</span> {error}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setData(null);
              setRetryToken((t) => t + 1);
            }}
            className="ml-3 text-sm underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Google Maps Container – always in DOM so the map initialises early */}
      <div className="relative rounded-2xl border border-slate-200 overflow-hidden shadow-sm" style={{ height: 500 }}>
        <div ref={initMap} className="w-full h-full" />

        {/* Loading overlay — always when fetching so stale map never looks current */}
        {(loading || !mapReady) && (
          <div className="absolute inset-0 bg-white/85 flex flex-col items-center justify-center gap-2 z-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-700" />
            <span className="text-sm text-slate-500">
              {!mapReady ? 'Loading map...' : `Loading ${metricConfig.label}...`}
            </span>
          </div>
        )}

        {/* Hover tooltip */}
        {hoveredPoint && !loading && (
          <div className="absolute top-3 left-3 bg-white/95 backdrop-blur-sm rounded-lg p-3 shadow-lg border border-slate-200 z-10 min-w-[200px]">
            <div className="font-bold text-slate-900 text-sm">{hoveredPoint.name.split(',')[0]}</div>
            <div className="text-xs text-slate-500 mb-2">{hoveredPoint.name.includes(',') ? hoveredPoint.name.split(',').slice(1).join(',').trim() : ''}</div>
            <div className="flex gap-4 text-xs">
              <div>
                <span className="text-slate-500">Value: </span>
                <span className="font-semibold">{formatMetricValue(hoveredPoint.value, selectedMetric)}</span>
              </div>
              <div>
                <span className="text-slate-500">YoY: </span>
                <span className={`font-semibold ${
                  hoveredPoint.yoyGrowth === null ? 'text-slate-400'
                    : hoveredPoint.yoyGrowth >= 0 ? 'text-emerald-600' : 'text-rose-600'
                }`}>
                  {hoveredPoint.yoyGrowth !== null
                    ? `${hoveredPoint.yoyGrowth >= 0 ? '+' : ''}${hoveredPoint.yoyGrowth}%`
                    : 'N/A'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Legend overlay – top-right to avoid covering Google Maps zoom controls */}
        <div className="absolute top-3 right-3 bg-white/95 backdrop-blur-sm rounded-lg p-3 shadow-lg border border-slate-200 text-xs z-10">
          <div className="font-semibold text-slate-700 mb-1.5">
            {colorBy === 'growth' ? 'YoY Growth' : metricConfig.label}
          </div>
          <div className="flex items-center gap-1">
            <div className="w-20 h-2.5 rounded" style={{
              background: invertColor && colorBy === 'growth'
                ? 'linear-gradient(to right, #ef4444, #eab308, #22c55e)'
                : 'linear-gradient(to right, #22c55e, #eab308, #ef4444)',
            }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5 w-20">
            <span>Low</span>
            <span>High</span>
          </div>
        </div>
      </div>

      {data && !loading && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                Zoom to level 7 or tighter, frame the area you want to inspect, then click Analyze Area to load ZIP-level RentCast markers for that map view.
                {focusedMetroForZips && !areaAnalysisPending && <span className="ml-2 font-medium text-slate-900">Current ZIP focus: {focusedMetroForZips.name}</span>}
                {areaAnalysisPending && <span className="ml-2 text-amber-700">Map moved. Click Analyze Area to load ZIP markers for the new view.</span>}
                {!areaAnalysisPending && zipOverlayLoading && <span className="ml-2 text-emerald-700">Loading ZIP markers...</span>}
                {!zipOverlayLoading && zipOverlayError && <span className="ml-2 text-rose-600">{zipOverlayError}</span>}
              </div>

              <button
                onClick={analyzeCurrentArea}
                disabled={!canAnalyzeArea || zipOverlayLoading}
                className={`shrink-0 rounded-lg px-4 py-2 font-medium transition-all ${
                  !canAnalyzeArea || zipOverlayLoading
                    ? 'cursor-not-allowed bg-slate-100 text-slate-400 border border-slate-200'
                    : 'bg-slate-900 text-white hover:bg-slate-800 shadow-sm'
                }`}
              >
                {zipOverlayLoading ? 'Analyzing...' : 'Analyze Area'}
              </button>
            </div>
          </div>

          {/* Summary Bar */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xs text-slate-500">Metros Tracked</div>
              <div className="text-xl font-bold text-slate-900">{data.stats.count}</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xs text-slate-500">Avg YoY Growth</div>
              <div className={`text-xl font-bold ${(data.stats.avgGrowth ?? 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {data.stats.avgGrowth !== null ? `${data.stats.avgGrowth >= 0 ? '+' : ''}${data.stats.avgGrowth}%` : 'N/A'}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-xs text-slate-500">Growth Range</div>
              <div className="text-sm font-semibold text-slate-700">
                {data.stats.growthRange
                  ? `${data.stats.growthRange.min >= 0 ? '+' : ''}${data.stats.growthRange.min}% to +${data.stats.growthRange.max}%`
                  : 'N/A'}
              </div>
            </div>
          </div>

          {/* Metro Rankings Table */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50">
              <h4 className="font-semibold text-slate-900">
                {metricConfig.icon} {metricConfig.label} — Metro Rankings
              </h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/30">
                    <th className="text-left py-2.5 px-4 font-semibold text-slate-600">Rank</th>
                    <th className="text-left py-2.5 px-4 font-semibold text-slate-600">Metro Area</th>
                    <th className="text-right py-2.5 px-4 font-semibold text-slate-600">Current Value</th>
                    <th className="text-right py-2.5 px-4 font-semibold text-slate-600">YoY Growth</th>
                    <th className="text-right py-2.5 px-4 font-semibold text-slate-600">As Of</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedPoints.map((point, idx) => {
                    const val = colorBy === 'growth' ? point.yoyGrowth : point.value;
                    const bgColor = growthColor(val, min, max, invertColor && colorBy === 'growth');
                    return (
                      <tr
                        key={point.code}
                        className={`hover:bg-slate-50/50 transition-colors cursor-pointer ${hoveredPoint?.code === point.code ? 'bg-blue-50/50' : ''}`}
                        onClick={() => openMetroModal(point)}
                        onMouseEnter={() => setHoveredPoint(point)}
                        onMouseLeave={() => setHoveredPoint(null)}
                      >
                        <td className="py-2.5 px-4 text-slate-400 font-medium">{idx + 1}</td>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: bgColor }} />
                            <span className="font-medium text-slate-900">{point.name.split(',')[0]}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-right font-medium text-slate-700">
                          {formatMetricValue(point.value, selectedMetric)}
                        </td>
                        <td className={`py-2.5 px-4 text-right font-semibold ${
                          point.yoyGrowth === null ? 'text-slate-400'
                            : point.yoyGrowth >= 0 ? 'text-emerald-600' : 'text-rose-600'
                        }`}>
                          {point.yoyGrowth !== null
                            ? `${point.yoyGrowth >= 0 ? '+' : ''}${point.yoyGrowth}%`
                            : 'N/A'}
                        </td>
                        <td className="py-2.5 px-4 text-right text-slate-500 text-xs">{point.date}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>

      )}

      {/* Metro Detail Modal */}
      <MetroDetailModal
        isOpen={!!selectedMetroForModal}
        onClose={() => {
          setSelectedMetroForModal(null);
          setSelectedZipCodeForModal(null);
        }}
        cbsaCode={selectedMetroForModal?.code || ''}
        metroName={selectedMetroForModal?.name || ''}
        initialZipCode={selectedZipCodeForModal}
      />
    </div>
  );
};

export default RegionalHeatMap;
