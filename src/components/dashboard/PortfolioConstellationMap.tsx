import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapPinned } from 'lucide-react';
import { GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_MAP_ID, loadGoogleMaps } from '../../utils/googleMaps';
import { StreetViewImage } from '../StreetViewImage';

export type ConstellationHealth = 'healthy' | 'attention' | 'critical' | 'unknown';

export type ConstellationProperty = {
  id: string;
  address: string;
  latitude?: number | null;
  longitude?: number | null;
  marketValue: number | null;
  monthlyRent: number | null;
  health: ConstellationHealth;
  healthDetail: string;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  yearBuilt?: number | null;
  equity?: number | null;
  tenantCount?: number | null;
  devicesOnline?: number;
  devicesTotal?: number;
  openAlerts?: Array<{ severity: 'critical' | 'warning'; message: string }>;
};

function formatCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function healthColor(health: ConstellationHealth): string {
  switch (health) {
    case 'critical':
      return '#e11d48';
    case 'attention':
      return '#d97706';
    case 'healthy':
      return '#2563eb';
    default:
      return '#94a3b8';
  }
}

function healthLabel(health: ConstellationHealth): string {
  switch (health) {
    case 'critical':
      return 'Needs action';
    case 'attention':
      return 'Watch';
    case 'healthy':
      return 'Clear';
    default:
      return 'Unknown';
  }
}

function streetLine(address: string): string {
  return address.split(',')[0]?.trim() || address;
}

function clearMarker(marker: any) {
  if (!marker) return;
  if (typeof marker.setMap === 'function') {
    marker.setMap(null);
    return;
  }
  if ('map' in marker) {
    marker.map = null;
  }
}

function hasCoordinates(property: ConstellationProperty): property is ConstellationProperty & { latitude: number; longitude: number } {
  return typeof property.latitude === 'number'
    && Number.isFinite(property.latitude)
    && typeof property.longitude === 'number'
    && Number.isFinite(property.longitude);
}

/**
 * Portfolio holdings on Google Maps — Live Property Twin shell:
 * map canvas + clickable side rail for the selected property.
 */
export default function PortfolioConstellationMap({
  properties,
  onOpenProperty,
}: {
  properties: ConstellationProperty[];
  onOpenProperty?: (propertyId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mapped = useMemo(() => properties.filter(hasCoordinates), [properties]);
  const unmappedCount = properties.length - mapped.length;
  const selected = properties.find((property) => property.id === selectedId) || null;

  const healthCounts = useMemo(() => {
    const counts = { healthy: 0, attention: 0, critical: 0, unknown: 0 };
    properties.forEach((property) => {
      counts[property.health] += 1;
    });
    return counts;
  }, [properties]);

  const totalValue = properties.reduce((sum, property) => sum + (property.marketValue || 0), 0);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    containerRef.current = containerEl;
  }, [containerEl]);

  useEffect(() => {
    if (!containerEl) return undefined;

    let cancelled = false;

    const initMap = async () => {
      if (mapRef.current) return;
      if (!GOOGLE_MAPS_API_KEY) {
        setLoadError('Google Maps is not configured for this workspace.');
        return;
      }

      try {
        await loadGoogleMaps();
        if (cancelled || !containerRef.current || mapRef.current) return;

        const g = (window as any).google;
        const hasMapId = Boolean(GOOGLE_MAPS_MAP_ID);
        mapRef.current = new g.maps.Map(containerRef.current, {
          center: { lat: 39.5, lng: -98.35 },
          zoom: 4,
          mapTypeId: 'roadmap',
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          zoomControl: true,
          gestureHandling: 'greedy',
          ...(hasMapId
            ? { mapId: GOOGLE_MAPS_MAP_ID }
            : {
                styles: [
                  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
                  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
                  { elementType: 'geometry', stylers: [{ color: '#f1f5f9' }] },
                  { elementType: 'labels.text.fill', stylers: [{ color: '#475569' }] },
                  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#dbeafe' }] },
                  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
                  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e2e8f0' }] },
                  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#cbd5e1' }] },
                ],
              }),
        });

        // Force a resize after layout — zero-size init leaves a blank map.
        g.maps.event.addListenerOnce(mapRef.current, 'idle', () => {
          if (cancelled || !mapRef.current) return;
          g.maps.event.trigger(mapRef.current, 'resize');
        });

        setMapReady(true);
        setLoadError(null);
      } catch (error: any) {
        console.error('[PortfolioConstellationMap] Failed to initialize Google Maps', error);
        if (!cancelled) {
          setLoadError(error?.message || 'Unable to load Google Maps.');
        }
      }
    };

    void initMap();

    return () => {
      cancelled = true;
      markersRef.current.forEach(clearMarker);
      markersRef.current = [];
      mapRef.current = null;
      setMapReady(false);
    };
  }, [containerEl]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const g = (window as any).google;
    markersRef.current.forEach(clearMarker);
    markersRef.current = [];

    if (mapped.length === 0) {
      mapRef.current.setCenter({ lat: 39.5, lng: -98.35 });
      mapRef.current.setZoom(4);
      return;
    }

    const bounds = new g.maps.LatLngBounds();

    mapped.forEach((property, index) => {
      bounds.extend({ lat: property.latitude, lng: property.longitude });
      const isSelected = property.id === selectedId;
      const color = healthColor(property.health);
      let marker: any;

      const handleClick = () => {
        setSelectedId(property.id);
        mapRef.current.panTo({ lat: property.latitude, lng: property.longitude });
        const currentZoom = Number(mapRef.current.getZoom?.() || 0);
        if (currentZoom < 12) {
          mapRef.current.setZoom(12);
        }
      };

      if (GOOGLE_MAPS_MAP_ID && g.maps?.marker?.AdvancedMarkerElement && g.maps?.marker?.PinElement) {
        const pinElement = new g.maps.marker.PinElement({
          background: isSelected ? '#0f172a' : color,
          borderColor: '#ffffff',
          glyphColor: '#ffffff',
          glyph: `${index + 1}`,
          scale: isSelected ? 1.2 : 1,
        });

        marker = new g.maps.marker.AdvancedMarkerElement({
          map: mapRef.current,
          position: { lat: property.latitude, lng: property.longitude },
          title: property.address,
          content: pinElement.element,
          zIndex: isSelected ? 1300 : 1000,
        });

        if (typeof marker.addListener === 'function') {
          marker.addListener('click', handleClick);
        } else {
          pinElement.element.addEventListener('click', handleClick);
        }
      } else {
        marker = new g.maps.Marker({
          map: mapRef.current,
          position: { lat: property.latitude, lng: property.longitude },
          title: property.address,
          label: { text: `${index + 1}`, color: '#ffffff', fontWeight: '700', fontSize: '11px' },
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: isSelected ? 14 : 11,
            fillColor: isSelected ? '#0f172a' : color,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2.5,
          },
          zIndex: isSelected ? 1300 : 1000,
        });
        marker.addListener('click', handleClick);
      }

      markersRef.current.push(marker);
    });

    if (!selectedId) {
      mapRef.current.fitBounds(bounds, 64);
      const zoom = Number(mapRef.current.getZoom?.() || 0);
      if (zoom > 14) mapRef.current.setZoom(14);
      if (mapped.length === 1) mapRef.current.setZoom(13);
    }

    // Layout can settle after pins land — nudge Maps to paint.
    requestAnimationFrame(() => {
      if (mapRef.current) {
        g.maps.event.trigger(mapRef.current, 'resize');
      }
    });
  }, [mapReady, mapped, selectedId]);

  const selectProperty = (propertyId: string) => {
    setSelectedId(propertyId);
    const property = properties.find((entry) => entry.id === propertyId);
    if (property && hasCoordinates(property) && mapRef.current) {
      mapRef.current.panTo({ lat: property.latitude, lng: property.longitude });
      const currentZoom = Number(mapRef.current.getZoom?.() || 0);
      if (currentZoom < 12) mapRef.current.setZoom(12);
    }
  };

  return (
    <section className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-3xl border border-blue-200 bg-[radial-gradient(circle_at_50%_0%,rgba(224,242,254,0.9),transparent_48%),linear-gradient(160deg,#f8fbff_0%,#eef6ff_55%,#f8fafc_100%)] p-4 sm:p-5">
      <header className="flex flex-col gap-3 border-b border-blue-100 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-blue-700">
            <MapPinned size={16} />
            <span className="text-[11px] font-bold uppercase tracking-[0.18em]">Portfolio map</span>
          </div>
          <h2 className="mt-0.5 text-lg font-bold text-slate-950">Your holdings</h2>
          <p className="mt-1 max-w-xl text-sm text-slate-600">
            Click a pin for value, rent, and health — same side-rail pattern as Live Property Twin.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
          <span className="rounded-full border border-blue-100 bg-white px-2.5 py-1 text-blue-700">
            {properties.length} holding{properties.length === 1 ? '' : 's'}
          </span>
          <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-700">
            {formatCompact(totalValue)} value
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-white px-2.5 py-1 text-blue-700">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
            {healthCounts.healthy} clear
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-100 bg-white px-2.5 py-1 text-amber-700">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            {healthCounts.attention} watch
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-100 bg-white px-2.5 py-1 text-rose-700">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            {healthCounts.critical} action
          </span>
        </div>
      </header>

      <div className="mt-3 grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="relative min-h-[320px] overflow-hidden rounded-2xl border border-blue-100/80 bg-white/60">
          {/* Always mount the map host so init can run once the DOM node exists. */}
          <div ref={setContainerEl} className="absolute inset-0 h-full w-full" />

          {loadError ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-sky-50/90 px-6 text-center text-sm text-slate-500">
              {loadError}
            </div>
          ) : properties.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/85 px-6 text-center text-sm text-slate-500">
              Add properties to see them on the portfolio map.
            </div>
          ) : !mapReady ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-sky-50/80 text-sm font-medium text-slate-500">
              Loading map…
            </div>
          ) : mapped.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/85 px-6 text-center text-sm text-slate-500">
              No map coordinates on file yet. Properties still appear in the side list.
            </div>
          ) : null}
        </div>

        <aside className="flex min-h-[280px] flex-col overflow-hidden rounded-2xl border border-blue-100 bg-white/95">
          {selected ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="relative h-[110px] shrink-0 overflow-hidden bg-slate-100">
                <StreetViewImage address={selected.address} className="h-full w-full object-cover" width={560} height={220} fill />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/85 via-slate-950/35 to-transparent px-3 pb-2 pt-6">
                  <div className="truncate text-sm font-bold text-white">{streetLine(selected.address)}</div>
                  <div className="truncate text-[10px] font-medium text-slate-200">
                    {selected.address.split(',').slice(1).join(',').trim()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="absolute right-2 top-2 rounded-lg bg-slate-950/60 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur hover:bg-slate-950/80"
                >
                  Close
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold"
                    style={{ color: healthColor(selected.health), background: `${healthColor(selected.health)}14` }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: healthColor(selected.health) }} />
                    {healthLabel(selected.health)}
                  </span>
                  {[
                    selected.beds ? `${selected.beds} bd` : null,
                    selected.baths ? `${selected.baths} ba` : null,
                    selected.sqft ? `${Math.round(selected.sqft).toLocaleString()} sqft` : null,
                    selected.yearBuilt ? `Built ${selected.yearBuilt}` : null,
                  ]
                    .filter(Boolean)
                    .map((chip) => (
                      <span key={chip as string} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                        {chip}
                      </span>
                    ))}
                </div>

                <p className="mt-2 text-[11px] leading-snug text-slate-600">{selected.healthDetail}</p>

                <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                  <div className="rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Value</div>
                    <div className="text-sm font-bold tabular-nums text-slate-950">{formatCompact(selected.marketValue)}</div>
                  </div>
                  <div className="rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Equity</div>
                    <div className="text-sm font-bold tabular-nums text-slate-950">{formatCompact(selected.equity ?? null)}</div>
                  </div>
                  <div className="rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Rent</div>
                    <div className="text-sm font-bold tabular-nums text-slate-950">
                      {selected.monthlyRent !== null ? `${formatCompact(selected.monthlyRent)}/mo` : '—'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Gross yield</div>
                    <div className="text-sm font-bold tabular-nums text-slate-950">
                      {selected.monthlyRent && selected.marketValue
                        ? `${(((selected.monthlyRent * 12) / selected.marketValue) * 100).toFixed(1)}%`
                        : '—'}
                    </div>
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <div className={`rounded-xl border px-2.5 py-1.5 ${(selected.tenantCount || 0) > 0 ? 'border-emerald-100 bg-emerald-50/70' : 'border-amber-100 bg-amber-50/70'}`}>
                    <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Occupancy</div>
                    <div className={`text-xs font-bold ${(selected.tenantCount || 0) > 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {(selected.tenantCount || 0) > 0
                        ? `${selected.tenantCount} tenant${selected.tenantCount === 1 ? '' : 's'}`
                        : 'Vacant'}
                    </div>
                  </div>
                  <div className={`rounded-xl border px-2.5 py-1.5 ${(selected.devicesTotal || 0) > 0 ? 'border-blue-100 bg-blue-50/70' : 'border-slate-100 bg-slate-50'}`}>
                    <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Protection</div>
                    <div className={`text-xs font-bold ${(selected.devicesTotal || 0) > 0 ? 'text-blue-700' : 'text-slate-500'}`}>
                      {(selected.devicesTotal || 0) > 0
                        ? `${selected.devicesOnline}/${selected.devicesTotal} sensors live`
                        : 'No sensors'}
                    </div>
                  </div>
                </div>

                {selected.openAlerts && selected.openAlerts.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {selected.openAlerts.map((alert, index) => (
                      <div
                        key={index}
                        className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${alert.severity === 'critical' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}
                      >
                        {alert.message}
                      </div>
                    ))}
                  </div>
                ) : null}

                {!hasCoordinates(selected) ? (
                  <p className="mt-2 text-[10px] text-amber-700">No map coordinates for this property yet.</p>
                ) : null}

                <div className="mt-auto pt-3">
                  <button
                    type="button"
                    onClick={() => onOpenProperty?.(selected.id)}
                    className="w-full rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
                  >
                    Open in Properties
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col p-3.5">
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Network health</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-blue-100 bg-blue-50/80 px-2.5 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-600">On map</div>
                  <div className="mt-0.5 text-lg font-bold tabular-nums text-slate-950">{mapped.length}</div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Need watch</div>
                  <div className="mt-0.5 text-lg font-bold tabular-nums text-amber-700">
                    {healthCounts.attention + healthCounts.critical}
                  </div>
                </div>
              </div>

              {unmappedCount > 0 ? (
                <p className="mt-2 text-[11px] text-slate-500">
                  {unmappedCount} holding{unmappedCount === 1 ? '' : 's'} missing map coordinates.
                </p>
              ) : null}

              <div className="mt-3 max-h-[220px] flex-1 space-y-1.5 overflow-y-auto pr-1">
                {properties.map((property, index) => {
                  const color = healthColor(property.health);
                  return (
                    <button
                      key={property.id}
                      type="button"
                      onClick={() => selectProperty(property.id)}
                      className="flex w-full items-start gap-2.5 rounded-xl border border-slate-100 bg-white px-2.5 py-2 text-left transition hover:border-blue-200 hover:bg-blue-50/40"
                    >
                      <span
                        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                        style={{ background: color }}
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-slate-900">{streetLine(property.address)}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                          {formatCompact(property.marketValue)}
                          {property.monthlyRent !== null ? ` · ${formatCompact(property.monthlyRent)}/mo` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-[10px] font-semibold text-slate-500">
                <div className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> Clear</div>
                <div className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Vacant or attention</div>
                <div className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> Critical alert</div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
