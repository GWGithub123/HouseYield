/**
 * DealFinderMap — full-bleed Google map with deal-score pins, coverage
 * overlay (recency-shaded searched areas), and flagged-property star pins.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { loadGoogleMaps, GOOGLE_MAPS_MAP_ID } from '../../utils/googleMaps';
import type { ScreenedListing, CoverageArea, PropertyFlag } from '../../services/dealEngineClient';

interface DealFinderMapProps {
  listings: ScreenedListing[];
  coverage: CoverageArea[];
  flags: PropertyFlag[];
  showCoverage: boolean;
  selectedAddress: string | null;
  centerQuery: string | null;
  onListingClick: (listing: ScreenedListing) => void;
  onCoverageClick: (area: CoverageArea) => void;
}

function scoreColor(score: number, passes: boolean, monthlyCashFlow: number | null | undefined): string {
  if (Number.isFinite(monthlyCashFlow) && Number(monthlyCashFlow) > 0) return '#059669';
  if (Number.isFinite(monthlyCashFlow) && Number(monthlyCashFlow) >= -100) return '#d97706';
  if (!passes) return '#94a3b8';
  if (score >= 75) return '#059669';
  if (score >= 60) return '#65a30d';
  if (score >= 45) return '#d97706';
  return '#dc2626';
}

function formatPrice(price: number | null): string {
  if (!price) return '—';
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(2)}M`;
  return `$${Math.round(price / 1000)}k`;
}

export const DealFinderMap: React.FC<DealFinderMapProps> = ({
  listings,
  coverage,
  flags,
  showCoverage,
  selectedAddress,
  centerQuery,
  onListingClick,
  onCoverageClick,
}) => {
  const mapRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<any[]>([]);
  const coverageShapesRef = useRef<any[]>([]);
  const flagMarkersRef = useRef<any[]>([]);

  useEffect(() => {
    const init = async () => {
      if (mapRef.current || !containerRef.current) return;
      await loadGoogleMaps();
      const g = (window as any).google;
      mapRef.current = new g.maps.Map(containerRef.current, {
        center: { lat: 39.5, lng: -98.35 },
        zoom: 4,
        mapTypeId: 'hybrid',
        streetViewControl: false,
        mapTypeControl: true,
        mapTypeControlOptions: { position: 3 },
        fullscreenControl: true,
        ...(GOOGLE_MAPS_MAP_ID ? { mapId: GOOGLE_MAPS_MAP_ID } : {}),
      });
    };
    init();
  }, []);

  // Center on text query (city/zip geocode)
  useEffect(() => {
    const run = async () => {
      if (!centerQuery || !mapRef.current) return;
      await loadGoogleMaps();
      const g = (window as any).google;
      const geocoder = new g.maps.Geocoder();
      geocoder.geocode({ address: centerQuery }, (results: any, status: string) => {
        if (status === 'OK' && results?.[0]) {
          mapRef.current.fitBounds(results[0].geometry.viewport || results[0].geometry.bounds);
        }
      });
    };
    run();
  }, [centerQuery]);

  const clearMarkers = useCallback((ref: React.MutableRefObject<any[]>) => {
    ref.current.forEach((m) => {
      if (m.setMap) m.setMap(null);
      else if (m.map !== undefined) m.map = null;
    });
    ref.current = [];
  }, []);

  // Deal pins
  useEffect(() => {
    const render = async () => {
      if (!mapRef.current) return;
      await loadGoogleMaps();
      const g = (window as any).google;
      clearMarkers(markersRef);

      const withCoords = listings.filter((l) => Number.isFinite(l.latitude) && Number.isFinite(l.longitude));
      if (!withCoords.length) return;

      const bounds = new g.maps.LatLngBounds();
      const canUseAdvanced = !!(GOOGLE_MAPS_MAP_ID && g.maps?.marker?.AdvancedMarkerElement);

      withCoords.forEach((listing) => {
        const position = { lat: listing.latitude!, lng: listing.longitude! };
        bounds.extend(position);
        const color = scoreColor(listing.screen?.score ?? 0, listing.screen?.passes ?? false, listing.screen?.estMonthlyCashFlow);
        const isSelected = selectedAddress != null && listing.formattedAddress === selectedAddress;

        if (canUseAdvanced) {
          const el = document.createElement('div');
          el.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:9999px;background:${color};color:#fff;font:600 11px/1.2 system-ui;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer;border:2px solid ${isSelected ? '#fff' : 'transparent'};transform:scale(${isSelected ? 1.15 : 1});white-space:nowrap;`;
          el.textContent = `${formatPrice(listing.price)}${listing.screen?.positiveCashFlow ? ' · +FCF' : listing.screen?.passes ? ` · ${listing.screen.score}` : ''}`;
          el.onclick = () => onListingClick(listing);
          const marker = new g.maps.marker.AdvancedMarkerElement({
            map: mapRef.current,
            position,
            content: el,
            zIndex: isSelected ? 2000 : (listing.screen?.passes ? 1200 : 1000),
          });
          markersRef.current.push(marker);
        } else {
          const marker = new g.maps.Marker({
            map: mapRef.current,
            position,
            title: `${listing.formattedAddress} — ${formatPrice(listing.price)}`,
            icon: {
              path: g.maps.SymbolPath.CIRCLE,
              fillColor: color,
              fillOpacity: 0.95,
              strokeColor: '#ffffff',
              strokeWeight: 2,
              scale: isSelected ? 11 : 8,
            },
          });
          marker.addListener('click', () => onListingClick(listing));
          markersRef.current.push(marker);
        }
      });

      if (!selectedAddress && withCoords.length > 1) {
        mapRef.current.fitBounds(bounds, 80);
      } else if (withCoords.length === 1) {
        mapRef.current.setCenter({ lat: withCoords[0].latitude!, lng: withCoords[0].longitude! });
        mapRef.current.setZoom(14);
      }
    };
    render();
  }, [listings, selectedAddress, onListingClick, clearMarkers]);

  // Coverage overlay (exact boundary when cached; circle fallback otherwise)
  useEffect(() => {
    const render = async () => {
      if (!mapRef.current) return;
      await loadGoogleMaps();
      const g = (window as any).google;
      coverageShapesRef.current.forEach((s) => s.setMap(null));
      coverageShapesRef.current = [];
      if (!showCoverage) return;

      coverage.forEach((area) => {
        if (!area.centroid) return;
        const color = area.recency === 'fresh' ? '#10b981' : area.recency === 'recent' ? '#f59e0b' : '#94a3b8';
        if (area.boundaryGeoJson) {
          const dataLayer = new g.maps.Data({ map: mapRef.current });
          dataLayer.addGeoJson(area.boundaryGeoJson);
          dataLayer.setStyle({
            fillColor: color,
            fillOpacity: 0.12,
            strokeColor: color,
            strokeOpacity: 0.85,
            strokeWeight: 2,
            clickable: true,
            zIndex: 10,
          });
          dataLayer.addListener('click', () => onCoverageClick(area));
          coverageShapesRef.current.push(dataLayer);
        } else {
          const radiusMeters = (area.search?.radiusMiles ? area.search.radiusMiles : 5) * 1609;
          const circle = new g.maps.Circle({
            map: mapRef.current,
            center: { lat: area.centroid.lat, lng: area.centroid.lng },
            radius: radiusMeters,
            fillColor: color,
            fillOpacity: 0.10,
            strokeColor: color,
            strokeOpacity: 0.55,
            strokeWeight: 1.5,
            clickable: true,
            zIndex: 10,
          });
          circle.addListener('click', () => onCoverageClick(area));
          coverageShapesRef.current.push(circle);
        }

        // Badge label
        const canUseAdvanced = !!(GOOGLE_MAPS_MAP_ID && g.maps?.marker?.AdvancedMarkerElement);
        if (canUseAdvanced) {
          const el = document.createElement('div');
          el.style.cssText = `padding:2px 8px;border-radius:9999px;background:rgba(255,255,255,.92);color:#0f172a;font:600 10px/1.4 system-ui;border:1.5px solid ${color};cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap;`;
          const label = area.search?.city || area.search?.zipCode || 'Area';
          el.textContent = `${label} · ${area.funnel?.passing ?? 0}/${area.funnel?.totalListings ?? 0} · ${area.ageDays < 1 ? 'today' : `${Math.round(area.ageDays)}d ago`}`;
          el.onclick = () => onCoverageClick(area);
          const marker = new g.maps.marker.AdvancedMarkerElement({
            map: mapRef.current,
            position: { lat: area.centroid.lat, lng: area.centroid.lng },
            content: el,
            zIndex: 500,
          });
          coverageShapesRef.current.push({ setMap: (m: any) => { (marker as any).map = m; } });
        }
      });
    };
    render();
  }, [coverage, showCoverage, onCoverageClick]);

  // Flag star pins
  useEffect(() => {
    const render = async () => {
      if (!mapRef.current) return;
      await loadGoogleMaps();
      const g = (window as any).google;
      clearMarkers(flagMarkersRef);

      flags.forEach((flag) => {
        if (!Number.isFinite(flag.latitude) || !Number.isFinite(flag.longitude)) return;
        const canUseAdvanced = !!(GOOGLE_MAPS_MAP_ID && g.maps?.marker?.AdvancedMarkerElement);
        if (canUseAdvanced) {
          const el = document.createElement('div');
          el.style.cssText = 'font-size:18px;cursor:pointer;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));';
          el.textContent = '⭐';
          el.title = `${flag.address}${flag.dealScore ? ` — score ${flag.dealScore}` : ''}`;
          const marker = new g.maps.marker.AdvancedMarkerElement({
            map: mapRef.current,
            position: { lat: flag.latitude!, lng: flag.longitude! },
            content: el,
            zIndex: 1800,
          });
          flagMarkersRef.current.push(marker);
        } else {
          const marker = new g.maps.Marker({
            map: mapRef.current,
            position: { lat: flag.latitude!, lng: flag.longitude! },
            title: flag.address,
            label: { text: '★', color: '#f59e0b', fontSize: '18px' },
            icon: { path: g.maps.SymbolPath.CIRCLE, scale: 0, fillOpacity: 0 },
          });
          flagMarkersRef.current.push(marker);
        }
      });
    };
    render();
  }, [flags, clearMarkers]);

  return <div ref={containerRef} className="w-full h-full rounded-xl border overflow-hidden" />;
};
