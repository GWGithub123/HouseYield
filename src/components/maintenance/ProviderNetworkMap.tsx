import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, MapPin } from 'lucide-react';
import ProviderAnalysisPanel from './ProviderAnalysisPanel';
import { fetchProviderNetwork, type NetworkProvider } from '../../services/providerNetworkApi';
import {
  GOOGLE_MAPS_MAP_ID,
  MAPS_AUTH_FAILURE_MESSAGE,
  loadGoogleMaps,
  onGoogleMapsAuthFailure,
} from '../../utils/googleMaps';

/** Pin color encodes the AI score so coverage quality reads at a glance. */
function pinColorForScore(score: number | null | undefined) {
  if (score === null || score === undefined) return { fill: '#94a3b8', stroke: '#64748b' };
  if (score >= 80) return { fill: '#10b981', stroke: '#047857' };
  if (score >= 60) return { fill: '#f59e0b', stroke: '#b45309' };
  return { fill: '#f43f5e', stroke: '#be123c' };
}

function buildPinSvg(score: number | null | undefined, isSelected: boolean) {
  const { fill, stroke } = pinColorForScore(score);
  const label = score === null || score === undefined ? '' : String(Math.round(Number(score)));
  const scale = isSelected ? 1.25 : 1;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${36 * scale}" height="${44 * scale}" viewBox="0 0 36 44">
      <path d="M18 1C9.7 1 3 7.7 3 16c0 10.5 15 27 15 27s15-16.5 15-27C33 7.7 26.3 1 18 1z"
            fill="${fill}" stroke="${stroke}" stroke-width="${isSelected ? 3 : 2}"/>
      <circle cx="18" cy="16" r="10" fill="white" fill-opacity="0.92"/>
      <text x="18" y="20.5" text-anchor="middle" font-family="system-ui, sans-serif"
            font-size="11" font-weight="700" fill="${stroke}">${label}</text>
    </svg>
  `)}`;
}

interface ProviderNetworkMapProps {
  /** Centers the map and scopes the query to providers near this property. */
  propertyAddress?: string;
  category?: string;
  radiusMiles?: number;
}

/**
 * The AI-analyzed provider network on a map, with the selected provider's analysis in
 * a right rail — the same split layout as the property digital twin.
 */
export default function ProviderNetworkMap({
  propertyAddress,
  category,
  radiusMiles = 50,
}: ProviderNetworkMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());
  const propertyMarkerRef = useRef<any>(null);

  const [providers, setProviders] = useState<NetworkProvider[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapsBlocked, setMapsBlocked] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState(category || '');

  useEffect(() => onGoogleMapsAuthFailure(() => setMapsBlocked(true)), []);

  // Geocode the property so the map can center and the query can scope by radius.
  useEffect(() => {
    if (!propertyAddress) {
      setOrigin(null);
      return;
    }

    let cancelled = false;

    loadGoogleMaps()
      .then(() => new Promise<void>((resolve) => {
        const geocoder = new (window as any).google.maps.Geocoder();
        geocoder.geocode({ address: propertyAddress }, (results: any, status: string) => {
          if (!cancelled && status === 'OK' && results?.[0]?.geometry?.location) {
            const location = results[0].geometry.location;
            setOrigin({ lat: location.lat(), lng: location.lng() });
          }
          resolve();
        });
      }))
      .catch(() => { /* handled by the auth-failure hook and the map effect */ });

    return () => { cancelled = true; };
  }, [propertyAddress]);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchProviderNetwork({
        category: categoryFilter || undefined,
        lat: origin?.lat ?? null,
        lng: origin?.lng ?? null,
        radiusMiles: origin ? radiusMiles : null,
        limit: 200,
      });
      setProviders(result.providers || []);
      setError(null);
    } catch (loadError: any) {
      setError(loadError.message || 'Failed to load the provider network.');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, origin, radiusMiles]);

  useEffect(() => { void loadProviders(); }, [loadProviders]);

  const mappableProviders = useMemo(
    () => providers.filter((provider) => provider.lat !== null && provider.lng !== null),
    [providers],
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    providers.forEach((provider) => (provider.categories || []).forEach((entry) => set.add(entry)));
    return [...set].sort();
  }, [providers]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedId) || null,
    [providers, selectedId],
  );

  // Initialize the map once.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapContainerRef.current) return;
        const google = (window as any).google;

        mapRef.current = new google.maps.Map(mapContainerRef.current, {
          center: origin || { lat: 39.8283, lng: -98.5795 },
          zoom: origin ? 10 : 4,
          mapId: GOOGLE_MAPS_MAP_ID || undefined,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'greedy',
          styles: GOOGLE_MAPS_MAP_ID ? undefined : [
            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          ],
        });
        setMapReady(true);
      })
      .catch((mapError: any) => {
        if (!cancelled) {
          setError(mapError?.message || 'Failed to load Google Maps.');
        }
      });

    return () => { cancelled = true; };
  }, [origin]);

  // Recenter when the property resolves after the map was created.
  useEffect(() => {
    if (!mapRef.current || !origin) return;
    mapRef.current.setCenter(origin);
    mapRef.current.setZoom(10);
  }, [origin]);

  // Property pin, so operators can see coverage relative to the home.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !origin) return;
    const google = (window as any).google;

    propertyMarkerRef.current?.setMap?.(null);
    propertyMarkerRef.current = new google.maps.Marker({
      map: mapRef.current,
      position: origin,
      zIndex: 999,
      title: propertyAddress,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: '#0f172a',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 3,
      },
    });

    return () => { propertyMarkerRef.current?.setMap?.(null); };
  }, [mapReady, origin, propertyAddress]);

  // Sync provider pins.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const google = (window as any).google;

    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current.clear();

    const bounds = new google.maps.LatLngBounds();

    mappableProviders.forEach((provider) => {
      const marker = new google.maps.Marker({
        map: mapRef.current,
        position: { lat: provider.lat as number, lng: provider.lng as number },
        title: provider.name,
        icon: {
          url: buildPinSvg(provider.aiScore, provider.id === selectedId),
          scaledSize: new google.maps.Size(provider.id === selectedId ? 45 : 36, provider.id === selectedId ? 55 : 44),
          anchor: new google.maps.Point(provider.id === selectedId ? 22 : 18, provider.id === selectedId ? 55 : 44),
        },
        zIndex: provider.id === selectedId ? 500 : Math.round(Number(provider.aiScore) || 0),
      });

      marker.addListener('click', () => setSelectedId(provider.id));
      markersRef.current.set(provider.id, marker);
      bounds.extend(marker.getPosition());
    });

    if (origin) bounds.extend(origin);

    // Only auto-fit on the first render of a pin set, never while browsing.
    if (mappableProviders.length > 0 && !selectedId) {
      mapRef.current.fitBounds(bounds, 48);
    }
  }, [mapReady, mappableProviders, selectedId, origin]);

  const withoutCoordinates = providers.length - mappableProviders.length;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">Provider network</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {loading
              ? 'Loading providers…'
              : `${providers.length} provider${providers.length === 1 ? '' : 's'} analyzed`}
            {origin ? ` within ${radiusMiles} miles` : ''}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 text-[10px] font-medium text-slate-500 sm:flex">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> 80+
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-amber-500" /> 60–79
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-slate-400" /> Unscored
            </span>
          </div>

          {categories.length > 1 && (
            <select
              value={categoryFilter}
              onChange={(event) => {
                setCategoryFilter(event.target.value);
                setSelectedId('');
              }}
              className="ds-focus-ring rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              <option value="">All categories</option>
              {categories.map((entry) => (
                <option key={entry} value={entry}>{entry}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{mapsBlocked ? MAPS_AUTH_FAILURE_MESSAGE : error}</span>
        </div>
      )}

      <div className="grid xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="relative min-h-[420px]">
          <div ref={mapContainerRef} className="absolute inset-0" />

          {(!mapReady || loading) && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {mapReady ? 'Loading providers…' : 'Loading map…'}
              </div>
            </div>
          )}

          {mapReady && !loading && providers.length === 0 && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/90 px-6 text-center">
              <MapPin className="h-8 w-8 text-slate-300" />
              <div className="mt-3 text-sm font-medium text-slate-700">No providers mapped yet</div>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
                Submit a maintenance ticket and the AI provider search will start populating this network with
                ranked, review-analyzed contractors near your properties.
              </p>
            </div>
          )}

          {withoutCoordinates > 0 && (
            <div className="absolute bottom-3 left-3 rounded-lg bg-white/95 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 shadow-sm">
              {withoutCoordinates} provider{withoutCoordinates === 1 ? '' : 's'} missing coordinates
            </div>
          )}
        </div>

        <div className="max-h-[560px] border-t border-slate-200 bg-slate-50 xl:border-l xl:border-t-0">
          <ProviderAnalysisPanel provider={selectedProvider} providerCount={providers.length} />
        </div>
      </div>

      {providers.length > 0 && (
        <div className="max-h-48 divide-y divide-slate-100 overflow-y-auto border-t border-slate-200">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => setSelectedId(provider.id)}
              className={`ds-focus-ring flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition ${
                selectedId === provider.id ? 'bg-emerald-50' : 'hover:bg-slate-50'
              }`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">{provider.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-slate-500">
                  {provider.networkStats?.jobsCompleted
                    ? <span>{provider.networkStats.jobsCompleted} job{provider.networkStats.jobsCompleted === 1 ? '' : 's'}</span>
                    : <span>Not used yet</span>}
                  {provider.distanceMiles !== null && provider.distanceMiles !== undefined && (
                    <span>{provider.distanceMiles} mi</span>
                  )}
                </div>
              </div>
              {provider.aiScore !== null && provider.aiScore !== undefined && (
                <span className="shrink-0 text-sm font-semibold text-slate-700">
                  {Math.round(Number(provider.aiScore))}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
