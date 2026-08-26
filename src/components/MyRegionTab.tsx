import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { loadGoogleMaps } from '../utils/googleMaps';
import MarketAIAnalysis from './MarketAIAnalysis';
import { Card, KpiStrip, SectionHeader } from '../design-system';
import { useAuth } from '../contexts/AuthContext';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/* ── tiny chart helpers (lightweight duplicates — MarketDataPage defines its own) ── */

function MiniLineChart({ data, xLabels, color = '#3b82f6', label = 'Value', isPercentage = false, isCurrency = true }: {
  data: number[]; xLabels?: string[]; color?: string; label?: string; isPercentage?: boolean; isCurrency?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = { t: 24, b: 28, l: 48, r: 12 };
    const pW = W - pad.l - pad.r, pH = H - pad.t - pad.b;
    const min = Math.min(...data), max = Math.max(...data);
    const range = max - min || 1;
    const pts = data.map((v, i) => ({
      x: pad.l + (i / Math.max(data.length - 1, 1)) * pW,
      y: pad.t + (1 - (v - min) / range) * pH,
    }));
    // grid
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5;
    for (let i = 0; i < 4; i++) {
      const y = pad.t + (i / 3) * pH;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pW, y); ctx.stroke();
      const val = max - (i / 3) * range;
      ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
      ctx.fillText(isCurrency ? `$${Math.round(val).toLocaleString()}` : isPercentage ? `${val.toFixed(1)}%` : val.toFixed(1), pad.l - 4, y + 3);
    }
    // x labels
    if (xLabels?.length) {
      ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      const step = Math.max(1, Math.floor(xLabels.length / 5));
      for (let i = 0; i < xLabels.length; i += step) {
        ctx.fillText(xLabels[i], pts[i].x, H - 4);
      }
    }
    // area
    ctx.beginPath(); ctx.moveTo(pts[0].x, pad.t + pH);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, pad.t + pH); ctx.closePath();
    ctx.fillStyle = color + '18'; ctx.fill();
    // line
    ctx.beginPath(); pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    // label
    ctx.fillStyle = '#475569'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(label, pad.l, 14);
  }, [data, xLabels, color, label, isPercentage, isCurrency]);
  return <canvas ref={canvasRef} width={420} height={180} className="w-full h-auto" />;
}

function MiniBarChart({ data, xLabels, color = '#3b82f6', label = 'Value', isCurrency = true }: {
  data: number[]; xLabels?: string[]; color?: string; label?: string; isCurrency?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = { t: 24, b: 32, l: 48, r: 12 };
    const pW = W - pad.l - pad.r, pH = H - pad.t - pad.b;
    const max = Math.max(...data, 1);
    const barW = (pW / data.length) * 0.7;
    const gap = (pW / data.length) * 0.3;
    data.forEach((v, i) => {
      const x = pad.l + i * (barW + gap) + gap / 2;
      const h = (v / max) * pH;
      ctx.fillStyle = color + 'cc';
      ctx.beginPath();
      const r = 3;
      ctx.moveTo(x + r, pad.t + pH - h);
      ctx.arcTo(x + barW, pad.t + pH - h, x + barW, pad.t + pH, r);
      ctx.arcTo(x + barW, pad.t + pH, x, pad.t + pH, 0);
      ctx.arcTo(x, pad.t + pH, x, pad.t + pH - h, 0);
      ctx.arcTo(x, pad.t + pH - h, x + barW, pad.t + pH - h, r);
      ctx.fill();
      // value label
      ctx.fillStyle = '#475569'; ctx.font = '8px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(isCurrency ? `$${Math.round(v).toLocaleString()}` : String(Math.round(v)), x + barW / 2, pad.t + pH - h - 4);
    });
    // x labels
    if (xLabels?.length) {
      ctx.fillStyle = '#64748b'; ctx.font = '8px system-ui'; ctx.textAlign = 'center';
      data.forEach((_, i) => {
        const x = pad.l + i * (barW + gap) + gap / 2 + barW / 2;
        const lbl = xLabels[i] || '';
        ctx.fillText(lbl.length > 10 ? lbl.slice(0, 9) + '…' : lbl, x, H - 6);
      });
    }
    // label
    ctx.fillStyle = '#475569'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(label, pad.l, 14);
  }, [data, xLabels, color, label, isCurrency]);
  return <canvas ref={canvasRef} width={420} height={180} className="w-full h-auto" />;
}

function GlassCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  // Card already owns padding — strip legacy p-* classes from call sites.
  const cleaned = className.replace(/\bp-\d+\b/g, '').replace(/\s+/g, ' ').trim();
  return (
    <Card surface="light" className={cleaned || undefined}>
      {children}
    </Card>
  );
}

function ChartCard({
  title,
  available,
  failureNote,
  children,
}: {
  title: string;
  available: boolean;
  failureNote?: string;
  children: React.ReactNode;
}) {
  if (!available) {
    return failureNote ? (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-500">
        {title}: {failureNote}
      </div>
    ) : null;
  }
  return (
    <Card surface="light">
      <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{title}</h4>
      {children}
    </Card>
  );
}

function extractZipFromAddress(address?: string | null): string | null {
  if (!address) return null;
  const match = String(address).match(/\b(\d{5})(?:-\d{4})?\b/);
  return match?.[1] || null;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string; icon?: string }) {
  return (
    <Card surface="light" compact>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-slate-500">{sub}</div> : null}
    </Card>
  );
}

/* ── Types ── */
interface LocationInfo {
  lat: number;
  lng: number;
  fips?: string;
  countyName?: string;
  state?: string;
  cbsaCode?: string;
  cbsaName?: string;
  zipCode?: string;
}

function toNumber(value: any): number | null {
  if (value == null || value === '' || value === 'N/A') return null;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildLocationFromLookupResponse(json: any, fallback: Pick<LocationInfo, 'lat' | 'lng'>): LocationInfo {
  const lookupData = json?.data || {};

  return {
    lat: typeof json?.lat === 'number' ? json.lat : fallback.lat,
    lng: typeof json?.lng === 'number' ? json.lng : fallback.lng,
    fips: json?.fips || lookupData?.countyFips,
    countyName: json?.countyName || lookupData?.countyName,
    state: json?.state || lookupData?.stateName || json?.stateName,
    cbsaCode: json?.cbsaCode || lookupData?.cbsaCode,
    cbsaName: json?.cbsaName || lookupData?.cbsaName,
    zipCode: json?.zipCode || lookupData?.zipCode,
  };
}

interface MyRegionTabProps {
  showAiBrief?: boolean;
}

type PortfolioPositionRow = {
  id: string;
  address: string;
  bookedRent: number | null;
  label: string;
};

function medianValue(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildNeighborhoodClusters(comparables: any[]): Array<{
  key: string;
  lat: number;
  lng: number;
  count: number;
  medianRent: number | null;
  averageDaysOnMarket: number | null;
  sampleLabel: string;
}> {
  const buckets = new Map<string, {
    latSum: number;
    lngSum: number;
    count: number;
    rents: number[];
    daysOnMarket: number[];
    sampleLabel: string;
  }>();

  comparables.forEach((comp) => {
    const lat = toNumber(comp?.latitude);
    const lng = toNumber(comp?.longitude);
    if (lat == null || lng == null) return;

    const bucketLat = Math.round(lat * 120) / 120;
    const bucketLng = Math.round(lng * 120) / 120;
    const key = `${bucketLat}:${bucketLng}`;
    const existing = buckets.get(key) || {
      latSum: 0,
      lngSum: 0,
      count: 0,
      rents: [],
      daysOnMarket: [],
      sampleLabel: comp?.formattedAddress || 'Nearby rental cluster',
    };

    existing.latSum += lat;
    existing.lngSum += lng;
    existing.count += 1;

    const price = toNumber(comp?.price);
    if (price != null) existing.rents.push(price);

    const daysOnMarket = toNumber(comp?.daysOnMarket);
    if (daysOnMarket != null) existing.daysOnMarket.push(daysOnMarket);

    buckets.set(key, existing);
  });

  return Array.from(buckets.entries())
    .map(([key, bucket]) => ({
      key,
      lat: bucket.latSum / bucket.count,
      lng: bucket.lngSum / bucket.count,
      count: bucket.count,
      medianRent: medianValue(bucket.rents),
      averageDaysOnMarket: bucket.daysOnMarket.length
        ? bucket.daysOnMarket.reduce((sum, value) => sum + value, 0) / bucket.daysOnMarket.length
        : null,
      sampleLabel: bucket.sampleLabel,
    }))
    .sort((left, right) => right.count - left.count);
}

const MyRegionTab: React.FC<MyRegionTabProps> = ({ showAiBrief = true }) => {
  const { user } = useAuth();
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [locating, setLocating] = useState(true);
  const [locationSource, setLocationSource] = useState<'property' | 'geo' | 'manual' | null>(null);
  const [portfolioRows, setPortfolioRows] = useState<PortfolioPositionRow[]>([]);

  // Data states
  const [countyData, setCountyData] = useState<any>(null);
  const [cbsaData, setCbsaData] = useState<any>(null);
  const [zipMarketData, setZipMarketData] = useState<any>(null);
  const [nearbyZips, setNearbyZips] = useState<any>(null);
  const [rentalComps, setRentalComps] = useState<any>(null);
  const [attomData, setAttomData] = useState<any>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [failedSources, setFailedSources] = useState<string[]>([]);

  // Map
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const infoWindowRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const zipMarketMarkerRef = useRef<any>(null);
  const nearbyZipMarkersRef = useRef<any[]>([]);
  const neighborhoodMarkersRef = useRef<any[]>([]);

  // Manual ZIP entry
  const [manualZip, setManualZip] = useState('');
  const unsupportedOptionalEndpointsRef = useRef<{ zipRadius: boolean; rentalComps: boolean }>({
    zipRadius: false,
    rentalComps: false,
  });
  const locationBootstrappedRef = useRef(false);

  /* ── Step 1: Prefer owner property ZIP, then geolocation ── */
  useEffect(() => {
    if (locationBootstrappedRef.current) return;
    locationBootstrappedRef.current = true;
    let cancelled = false;

    const bootstrapLocation = async () => {
      if (user?.id) {
        try {
          const props = await ownerPropertiesClient.listDetailed(user.id, { withTenants: true });
          if (cancelled) return;
          const rows: PortfolioPositionRow[] = (props || []).slice(0, 8).map((p: any) => {
            const tenants = Array.isArray(p.tenants) ? p.tenants : [];
            const booked = tenants
              .map((t: any) => Number(t.monthlyRent))
              .filter((n: number) => Number.isFinite(n) && n > 0);
            const bookedRent = booked.length
              ? booked.reduce((a: number, b: number) => a + b, 0)
              : (Number(p.financials?.monthlyRent || p.financials?.rent) || null);
            return {
              id: p.id,
              address: p.address || 'Property',
              bookedRent: Number.isFinite(bookedRent as number) ? Number(bookedRent) : null,
              label: p.address || p.id,
            };
          });
          setPortfolioRows(rows);

          const zipFromProperty = (props || [])
            .map((p: any) => extractZipFromAddress(p.address))
            .find((z: string | null | undefined): z is string => Boolean(z));

          if (zipFromProperty) {
            const res = await fetch(`${API_BASE}/api/fred/county-by-coords?zipCode=${zipFromProperty}`);
            const json = await res.json();
            if (cancelled) return;
            if (json.ok) {
              setLocation(buildLocationFromLookupResponse(json, { lat: json.lat || 39, lng: json.lng || -97 }));
              setLocationSource('property');
              setLocating(false);
              return;
            }
          }
        } catch {
          // Fall through to geolocation
        }
      }

      if (!navigator.geolocation) {
        setGeoError('Location unavailable. Enter a ZIP code below.');
        setLocating(false);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          if (cancelled) return;
          const { latitude: lat, longitude: lng } = pos.coords;
          try {
            const res = await fetch(`${API_BASE}/api/fred/county-by-coords?lat=${lat}&lng=${lng}`);
            const json = await res.json();
            if (cancelled) return;
            if (json.ok) {
              setLocation(buildLocationFromLookupResponse(json, { lat, lng }));
            } else {
              setLocation({ lat, lng });
            }
            setLocationSource('geo');
          } catch {
            if (!cancelled) setLocation({ lat, lng });
          }
          if (!cancelled) setLocating(false);
        },
        (err) => {
          if (cancelled) return;
          setGeoError(err.code === 1
            ? 'Location access denied. Enter a ZIP from one of your properties below.'
            : 'Could not determine your location. Enter a ZIP code below.');
          setLocating(false);
        },
        { enableHighAccuracy: false, timeout: 10000 },
      );
    };

    void bootstrapLocation();
    return () => { cancelled = true; };
  }, [user?.id]);

  /* ── Step 2: Fetch all data in parallel once location is known ── */
  const fetchRegionData = useCallback(async (loc: LocationInfo) => {
    setDataLoading(true);
    setDataError(null);
    setFailedSources([]);
    setCountyData(null);
    setCbsaData(null);
    setZipMarketData(null);
    setNearbyZips(null);
    setRentalComps(null);
    setAttomData(null);

    const zip = loc.zipCode;
    const fips = loc.fips;
    const cbsa = loc.cbsaCode;

    const failures: string[] = [];
    const runFetch = async (
      label: string,
      url: string,
      onSuccess: (data: any) => void,
      options?: { allowNotOk?: boolean; optional?: boolean; endpointKey?: 'zipRadius' | 'rentalComps' }
    ) => {
      try {
        const response = await fetch(url);
        const json = await response.json();
        if (!response.ok) {
          if (options?.optional) {
            if (response.status === 404 && options.endpointKey) {
              unsupportedOptionalEndpointsRef.current[options.endpointKey] = true;
            }
            return;
          }
          failures.push(label);
          return;
        }
        if (json.ok === false && !options?.allowNotOk) {
          failures.push(label);
          return;
        }
        onSuccess(json.data ?? json);
      } catch {
        if (!options?.optional) failures.push(label);
      }
    };

    const fetches: Promise<void>[] = [];

    if (fips) {
      fetches.push(runFetch('County data', `${API_BASE}/api/fred/county/${fips}`, setCountyData));
    }
    if (cbsa) {
      fetches.push(runFetch('Regional data', `${API_BASE}/api/fred/regions/${cbsa}`, setCbsaData));
    }
    if (zip) {
      fetches.push(runFetch('ZIP market data', `${API_BASE}/api/rentcast/markets?zipCode=${zip}`, setZipMarketData));
    }
    if (!unsupportedOptionalEndpointsRef.current.zipRadius) {
      fetches.push(
        runFetch(
          'Nearby ZIP data',
          `${API_BASE}/api/rentcast/zip-radius?lat=${loc.lat}&lng=${loc.lng}&radiusMiles=10`,
          setNearbyZips,
          { optional: true, endpointKey: 'zipRadius' }
        )
      );
    }
    if (!unsupportedOptionalEndpointsRef.current.rentalComps) {
      fetches.push(
        runFetch(
          'Rental comps',
          `${API_BASE}/api/my-region/rental-comps?lat=${loc.lat}&lng=${loc.lng}${zip ? `&zipCode=${zip}` : ''}`,
          setRentalComps,
          { allowNotOk: true, optional: true, endpointKey: 'rentalComps' }
        )
      );
    }
    if (zip) {
      fetches.push(runFetch('ATTOM data', `${API_BASE}/api/my-region/attom?zipCode=${zip}`, setAttomData));
    }

    await Promise.allSettled(fetches);
    setFailedSources(failures);
    if (failures.length && !fips && !zip) {
      setDataError('Location lookup completed, but there was not enough county or ZIP detail to load local market data.');
    } else if (failures.length) {
      setDataError(`Partial data: ${failures.join(', ')} unavailable.`);
    }
    setDataLoading(false);
  }, []);

  useEffect(() => {
    if (location) fetchRegionData(location);
  }, [location, fetchRegionData]);

  /* ── Map initialization ── */
  useEffect(() => {
    if (locating || !location || !mapContainerRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        await loadGoogleMaps();
        if (cancelled || !mapContainerRef.current) return;
        const google = (window as any).google;
        if (!mapRef.current) {
          mapRef.current = new google.maps.Map(mapContainerRef.current, {
            center: { lat: location.lat, lng: location.lng },
            zoom: 12,
            disableDefaultUI: false,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
            zoomControl: true,
            gestureHandling: 'cooperative',
            styles: [
              { featureType: 'poi', stylers: [{ visibility: 'off' }] },
              { featureType: 'transit', stylers: [{ visibility: 'off' }] },
              { featureType: 'water', stylers: [{ color: '#dbeafe' }] },
              { featureType: 'landscape', stylers: [{ color: '#f1f5f9' }] },
            ],
          });
          infoWindowRef.current = new google.maps.InfoWindow();
        } else {
          mapRef.current.setCenter({ lat: location.lat, lng: location.lng });
        }

        // User location marker
        userMarkerRef.current?.setMap(null);
        userMarkerRef.current = new google.maps.Marker({
          position: { lat: location.lat, lng: location.lng },
          map: mapRef.current,
          title: 'Your Location',
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#3b82f6',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2.5,
          },
          zIndex: 100,
        });
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [location, locating]);

  /* ── Render primary ZIP market marker ── */
  useEffect(() => {
    const map = mapRef.current;
    const google = (window as any).google;
    if (!map || !google || !location || !zipMarketData) return;

    zipMarketMarkerRef.current?.setMap(null);

    const medianRentValue = zipMarketData?.derived?.medianAskingRent;
    const medianSaleValue = zipMarketData?.derived?.medianSalePrice;
    const grossYieldValue = zipMarketData?.derived?.grossYieldPct;

    const marker = new google.maps.Marker({
      position: { lat: location.lat, lng: location.lng },
      map,
      title: `ZIP ${location.zipCode || zipMarketData.zipCode} market`,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 13,
        fillColor: '#8b5cf6',
        fillOpacity: 0.18,
        strokeColor: '#7c3aed',
        strokeWeight: 3,
      },
      zIndex: 95,
    });

    marker.addListener('click', () => {
      infoWindowRef.current?.setContent(`
        <div style="font-family:system-ui;font-size:12px;max-width:240px">
          <div style="font-weight:700;margin-bottom:4px">ZIP ${location.zipCode || zipMarketData.zipCode} RentCast Market</div>
          <div style="color:#64748b;font-size:11px;margin-bottom:6px">ZIP-level aggregate around your location</div>
          ${medianRentValue != null ? `<div>Median Rent: <b>$${Math.round(medianRentValue).toLocaleString()}/mo</b></div>` : ''}
          ${medianSaleValue != null ? `<div>Median Sale: <b>$${Math.round(medianSaleValue).toLocaleString()}</b></div>` : ''}
          ${grossYieldValue != null ? `<div>Gross Yield: <b>${grossYieldValue.toFixed(1)}%</b></div>` : ''}
        </div>
      `);
      infoWindowRef.current?.open(map, marker);
    });

    zipMarketMarkerRef.current = marker;

    return () => {
      marker.setMap(null);
      if (zipMarketMarkerRef.current === marker) {
        zipMarketMarkerRef.current = null;
      }
    };
  }, [location, zipMarketData]);

  /* ── Update map markers when nearby ZIP data arrives ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !nearbyZips?.zips?.length) return;
    const google = (window as any).google;
    if (!google) return;

    nearbyZipMarkersRef.current.forEach((marker) => marker.setMap(null));
    nearbyZipMarkersRef.current = [];

    for (const z of nearbyZips.zips) {
      const yld = z.market?.derived?.grossYieldPct;
      const rent = z.market?.derived?.medianAskingRent;
      const price = z.market?.derived?.medianSalePrice;
      // Color by yield: green ≥ 8%, yellow ~5%, red ≤ 2%
      const t = yld != null ? Math.max(0, Math.min(1, (yld - 2) / 6)) : 0.5;
      const r = Math.round(239 - t * 200);
      const g = Math.round(68 + t * 130);
      const b = 68;
      const color = `rgb(${r},${g},${b})`;

      const marker = new google.maps.Marker({
        position: { lat: z.lat, lng: z.lng },
        map,
        title: `${z.label} (${z.zipCode})`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: color,
          fillOpacity: 0.85,
          strokeColor: '#fff',
          strokeWeight: 1.5,
        },
      });

      const infoContent = `
        <div style="font-family:system-ui;font-size:12px;max-width:220px">
          <div style="font-weight:700;margin-bottom:4px">${z.label} — ${z.zipCode}</div>
          <div style="color:#64748b;font-size:11px;margin-bottom:6px">${z.distanceMiles} mi away</div>
          ${rent != null ? `<div>Median Rent: <b>$${Math.round(rent).toLocaleString()}/mo</b></div>` : ''}
          ${price != null ? `<div>Median Sale: <b>$${Math.round(price).toLocaleString()}</b></div>` : ''}
          ${yld != null ? `<div>Gross Yield: <b>${yld.toFixed(1)}%</b></div>` : ''}
          ${z.market?.derived?.priceToRentRatio != null ? `<div>P/R Ratio: <b>${z.market.derived.priceToRentRatio.toFixed(1)}</b></div>` : ''}
        </div>
      `;
      marker.addListener('click', () => {
        infoWindowRef.current?.setContent(infoContent);
        infoWindowRef.current?.open(map, marker);
      });
      nearbyZipMarkersRef.current.push(marker);
    }

    return () => {
      nearbyZipMarkersRef.current.forEach((marker) => marker.setMap(null));
      nearbyZipMarkersRef.current = [];
    };
  }, [nearbyZips]);

  /* ── Render neighborhood-level RentCast clusters from rental comps ── */
  useEffect(() => {
    const map = mapRef.current;
    const google = (window as any).google;
    if (!map || !google) return;

    neighborhoodMarkersRef.current.forEach((marker) => marker.setMap(null));
    neighborhoodMarkersRef.current = [];

    const comparables = rentalComps?.comparables;
    if (!Array.isArray(comparables) || !comparables.length) return;

    const clusters = buildNeighborhoodClusters(comparables);
    const rents = clusters.map((cluster) => cluster.medianRent).filter((value): value is number => value != null);
    const minRentValue = rents.length ? Math.min(...rents) : 0;
    const maxRentValue = rents.length ? Math.max(...rents) : 1;

    clusters.forEach((cluster) => {
      const rent = cluster.medianRent;
      const t = rent != null ? Math.max(0, Math.min(1, (rent - minRentValue) / (maxRentValue - minRentValue || 1))) : 0.5;
      const color = `hsl(${190 - t * 150}, 80%, 46%)`;

      const marker = new google.maps.Marker({
        position: { lat: cluster.lat, lng: cluster.lng },
        map,
        title: `Neighborhood rent cluster (${cluster.count} listings)`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7 + Math.min(cluster.count, 6),
          fillColor: color,
          fillOpacity: 0.8,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        zIndex: 80,
      });

      marker.addListener('click', () => {
        infoWindowRef.current?.setContent(`
          <div style="font-family:system-ui;font-size:12px;max-width:240px">
            <div style="font-weight:700;margin-bottom:4px">Neighborhood Rent Signal</div>
            <div style="color:#64748b;font-size:11px;margin-bottom:6px">${cluster.count} RentCast listings grouped near ${cluster.sampleLabel}</div>
            ${cluster.medianRent != null ? `<div>Median Rent: <b>$${Math.round(cluster.medianRent).toLocaleString()}/mo</b></div>` : ''}
            ${cluster.averageDaysOnMarket != null ? `<div>Avg DOM: <b>${cluster.averageDaysOnMarket.toFixed(1)} days</b></div>` : ''}
            <div>Listings in cluster: <b>${cluster.count}</b></div>
          </div>
        `);
        infoWindowRef.current?.open(map, marker);
      });

      neighborhoodMarkersRef.current.push(marker);
    });

    return () => {
      neighborhoodMarkersRef.current.forEach((marker) => marker.setMap(null));
      neighborhoodMarkersRef.current = [];
    };
  }, [rentalComps]);

  /* ── Manual ZIP lookup ── */
  const handleManualZip = async () => {
    const zip = manualZip.trim();
    if (!/^\d{5}$/.test(zip)) return;
    setLocating(true);
    setGeoError(null);
    setDataError(null);
    try {
      const res = await fetch(`${API_BASE}/api/fred/county-by-coords?zipCode=${zip}`);
      const json = await res.json();
      if (json.ok) {
        setLocation(buildLocationFromLookupResponse(json, { lat: json.lat || 39, lng: json.lng || -97 }));
        setLocationSource('manual');
      } else {
        setGeoError('ZIP lookup failed. Enter another ZIP or enable location access.');
        setLocation({ lat: 39, lng: -97, zipCode: zip });
        setLocationSource('manual');
      }
    } catch {
      setGeoError('ZIP lookup failed. Enter another ZIP or enable location access.');
      setLocation({ lat: 39, lng: -97, zipCode: zip });
      setLocationSource('manual');
    }
    setLocating(false);
  };

  /* ── Derived data for display ── */
  const countyUnemployment = toNumber(countyData?.labor?.unemployment?.value);
  const countyListings = toNumber(countyData?.supply?.activeListings?.value);
  const countyNewListings = toNumber(countyData?.supply?.newListings?.value);
  const countyUnemploymentHistory = countyData?.charts?.unemployment || [];

  const medianRent = zipMarketData?.derived?.medianAskingRent;
  const medianSale = zipMarketData?.derived?.medianSalePrice;
  const grossYield = zipMarketData?.derived?.grossYieldPct;
  const priceToRent = zipMarketData?.derived?.priceToRentRatio;
  const rentalDOM = zipMarketData?.rentalData?.medianDaysOnMarket;
  const saleDOM = zipMarketData?.saleData?.medianDaysOnMarket;
  const rentalListings = zipMarketData?.derived?.rentalListings;
  const saleListings = zipMarketData?.derived?.saleListings;

  const appreciation = attomData?.appreciation;
  const salesTrend = attomData?.salesTrend;

  // CBSA-level data (from FRED regional detail)
  const cbsaHPI = cbsaData?.hpiHistory;
  const cbsaIncome = cbsaData?.medianIncome;

  // ATTOM trend chart data
  const attomChartData = salesTrend?.ok && Array.isArray(salesTrend.data)
    ? salesTrend.data.filter((d: any) => d.medianSalePrice)
    : [];

  // RentCast by-bedrooms data
  const rentByBedrooms = zipMarketData?.rentalData?.byBedrooms || [];
  const saleByBedrooms = zipMarketData?.saleData?.byBedrooms || [];

  // RentCast by-property-type
  const rentByType = zipMarketData?.rentalData?.byPropertyType || [];
  const saleByType = zipMarketData?.saleData?.byPropertyType || [];

  /* ── AI analysis payload ── */
  const aiPayload = {
    countyName: location?.countyName,
    cbsaName: location?.cbsaName,
    zipCode: location?.zipCode,
    neighborhoodName: location?.countyName ? `${location.countyName}, ${location.state}` : location?.zipCode,
    countyData: countyData ? {
      unemployment: countyData?.labor?.unemployment,
      activeListings: countyData?.supply?.activeListings,
      newListings: countyData?.supply?.newListings,
      unemploymentHistory: countyUnemploymentHistory.slice(-12),
    } : undefined,
    cbsaData: cbsaData ? {
      medianIncome: cbsaIncome,
      hpiLatest: cbsaHPI?.[cbsaHPI.length - 1]?.value,
    } : undefined,
    rentcastData: zipMarketData ? {
      medianAskingRent: medianRent,
      medianSalePrice: medianSale,
      grossYieldPct: grossYield,
      priceToRentRatio: priceToRent,
      rentalDOM,
      saleDOM,
      rentalListings,
      saleListings,
      rentByBedrooms: rentByBedrooms.slice(0, 5).map((b: any) => ({ bedrooms: b.label, medianRent: b.median })),
      rentByType: rentByType.slice(0, 5).map((t: any) => ({ type: t.label, medianRent: t.median })),
      saleByType: saleByType.slice(0, 5).map((t: any) => ({ type: t.label, medianPrice: t.median })),
    } : undefined,
    attomData: {
      appreciationRate: appreciation?.ok ? appreciation.appreciationPercent : undefined,
      latestMedianSale: attomChartData.length ? attomChartData[attomChartData.length - 1].medianSalePrice : undefined,
      trendMonths: attomChartData.length,
    },
  };

  /* ── Render ── */
  const marketMedian = medianRent != null ? Number(medianRent) : null;
  const portfolioPositionRows = portfolioRows.map((row) => {
    const gap = row.bookedRent != null && marketMedian != null ? row.bookedRent - marketMedian : null;
    const position = gap == null ? 'unknown' : gap < -25 ? 'under' : gap > 25 ? 'over' : 'at';
    return { ...row, gap, position, marketMedian };
  });

  if (locating && !location) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-slate-700 mb-4" />
        <p className="text-sm">Loading your property area...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Location header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            {location?.countyName
              ? `${location.countyName}, ${location.state}`
              : location?.zipCode
                ? `ZIP ${location.zipCode}`
                : 'My Region'}
          </h2>
          <p className="text-sm text-slate-500">
            {[location?.cbsaName, location?.zipCode && `ZIP ${location.zipCode}`, locationSource === 'property' ? 'from your properties' : locationSource === 'geo' ? 'from device location' : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Enter ZIP"
            value={manualZip}
            onChange={e => setManualZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onKeyDown={e => e.key === 'Enter' && handleManualZip()}
            className="w-28 px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          <button onClick={handleManualZip} className="px-3 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors">
            Go
          </button>
        </div>
      </div>

      {geoError && !location && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-800 text-sm">
          {geoError}
        </div>
      )}

      {dataError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {dataError}
        </div>
      )}

      {!dataLoading && location && (
        <KpiStrip
          columns={4}
          items={[
            { label: 'Median rent', value: medianRent != null ? `$${Math.round(medianRent).toLocaleString()}` : '—', sub: 'Asking / mo' },
            { label: 'Median sale', value: medianSale != null ? `$${Math.round(medianSale).toLocaleString()}` : '—' },
            { label: 'Gross yield', value: grossYield != null ? `${grossYield.toFixed(1)}%` : '—', tone: grossYield != null && grossYield >= 6 ? 'positive' : grossYield != null && grossYield < 4 ? 'negative' : 'default' },
            { label: 'Unemployment', value: countyUnemployment != null ? `${countyUnemployment}%` : '—', sub: countyListings != null ? `${countyListings.toLocaleString()} listings` : undefined },
          ]}
        />
      )}

      {/* Map */}
      {location && (
        <div className="space-y-2">
          <Card surface="light" flushBody className="overflow-hidden">
            <div ref={mapContainerRef} style={{ width: '100%', height: 420 }} />
          </Card>
          <div className="px-1 text-xs text-slate-500">
            Purple ring shows your ZIP-level RentCast aggregate. Colored neighborhood markers group nearby RentCast rental listings. Additional ZIP comparison markers appear when curated nearby ZIP market data is available.
          </div>
        </div>
      )}

      {dataLoading && (
        <div className="text-center py-8 text-slate-500">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-700 mx-auto mb-3" />
          <p className="text-sm">Loading local market data...</p>
        </div>
      )}

      {!dataLoading && location && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Price-to-Rent" value={priceToRent != null ? priceToRent.toFixed(1) : '—'} />
            <StatCard label="Active listings" value={countyListings != null ? countyListings.toLocaleString() : saleListings != null ? saleListings.toLocaleString() : '—'} sub="County/ZIP" />
            <StatCard
              label="ZIP appreciation"
              value={appreciation?.ok ? `${appreciation.appreciationPercent > 0 ? '+' : ''}${appreciation.appreciationPercent.toFixed(1)}%` : '—'}
              sub={appreciation?.ok ? `${appreciation.periodLabel}` : undefined}
            />
            <StatCard label="Rental DOM" value={rentalDOM != null ? `${rentalDOM} days` : '—'} />
          </div>

          <Card surface="light">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <SectionHeader
                  label="Portfolio rental positioning"
                  description="Booked rent vs local market median — open full Rental Pricing Power for the complete analysis."
                />
              </div>
              <Link
                to="/portfolio?tab=properties&workspace=rentalPricingPower"
                className="shrink-0 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Open Rental Pricing Power
              </Link>
            </div>
            {portfolioPositionRows.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Add properties to see booked rent versus this area&apos;s market median.</p>
            ) : (
              <div className="mt-3 divide-y divide-slate-100">
                {portfolioPositionRows.slice(0, 6).map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-900">{row.label}</div>
                      <div className="text-xs text-slate-500">
                        Booked {row.bookedRent != null ? `$${Math.round(row.bookedRent).toLocaleString()}` : '—'}
                        {row.marketMedian != null ? ` · Market $${Math.round(row.marketMedian).toLocaleString()}` : ''}
                      </div>
                    </div>
                    <div className={`shrink-0 text-xs font-semibold ${
                      row.position === 'under' ? 'text-emerald-700' : row.position === 'over' ? 'text-rose-700' : 'text-slate-600'
                    }`}>
                      {row.gap == null ? '—' : `${row.gap >= 0 ? '+' : ''}$${Math.round(row.gap).toLocaleString()}/mo`}
                      <span className="ml-1 font-medium text-slate-400">
                        {row.position === 'under' ? 'under' : row.position === 'over' ? 'over' : row.position === 'at' ? 'at market' : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ── Local Market Pulse (deterministic signals) ── */}
          {(grossYield != null || (rentalDOM != null && saleDOM != null) || appreciation?.ok) && (() => {
            const yieldSig = grossYield == null ? null
              : grossYield >= 8    ? { label: 'High Yield',         color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `${grossYield.toFixed(1)}% gross — strong cash flow potential` }
              : grossYield >= 6    ? { label: 'Positive Yield',     color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `${grossYield.toFixed(1)}% gross — above typical mortgage rate` }
              : grossYield >= 4    ? { label: 'Below Cost',         color: 'text-amber-600',   bg: 'bg-amber-50 border-amber-200',     dot: 'bg-amber-500',   note: `${grossYield.toFixed(1)}% gross — likely negative cash flow at 30Y rates` }
              :                     { label: 'Yield Compressed',    color: 'text-rose-600',    bg: 'bg-rose-50 border-rose-200',       dot: 'bg-rose-500',    note: `${grossYield.toFixed(1)}% gross — significant cash-flow deficit` };

            const domSig = rentalDOM == null || saleDOM == null ? null
              : rentalDOM < saleDOM * 0.85  ? { label: 'Rental > Sale Demand', color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `Rental DOM ${rentalDOM}d vs sale ${saleDOM}d — renters move fast` }
              : rentalDOM > saleDOM * 1.15  ? { label: 'Rental Softening',     color: 'text-amber-600',   bg: 'bg-amber-50 border-amber-200',     dot: 'bg-amber-500',   note: `Rental DOM ${rentalDOM}d vs sale ${saleDOM}d — rental market slower` }
              :                               { label: 'Balanced Demand',       color: 'text-slate-600',   bg: 'bg-slate-50 border-slate-200',     dot: 'bg-slate-400',   note: `Rental DOM ${rentalDOM}d ≈ sale ${saleDOM}d — parity` };

            const appSig = !appreciation?.ok ? null
              : appreciation.appreciationPercent > 10 ? { label: 'Rapid Appreciation', color: 'text-orange-600', bg: 'bg-orange-50 border-orange-200', dot: 'bg-orange-500', note: `+${appreciation.appreciationPercent.toFixed(1)}% — outpacing rent growth; yield erosion risk` }
              : appreciation.appreciationPercent >= 3  ? { label: 'Appreciating',       color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `+${appreciation.appreciationPercent.toFixed(1)}% — healthy capital gain trajectory` }
              : appreciation.appreciationPercent >= 0  ? { label: 'Flat',                color: 'text-amber-600',   bg: 'bg-amber-50 border-amber-200',     dot: 'bg-amber-500',   note: `+${appreciation.appreciationPercent.toFixed(1)}% — minimal capital appreciation` }
              :                                          { label: 'Depreciating',         color: 'text-indigo-600',  bg: 'bg-indigo-50 border-indigo-200',   dot: 'bg-indigo-500',  note: `${appreciation.appreciationPercent.toFixed(1)}% — price correction underway` };

            const pulses = [
              { title: 'Yield Environment', icon: '💹', sig: yieldSig },
              { title: 'Demand Balance',    icon: '⚡', sig: domSig },
              { title: 'Appreciation',      icon: '🏡', sig: appSig },
            ].filter(p => p.sig !== null);

            if (!pulses.length) return null;
            return (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {pulses.map(({ title, icon, sig }) => sig && (
                  <div key={title} className={`rounded-xl border p-4 ${sig.bg}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${sig.dot}`} />
                      <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">{title}</span>
                    </div>
                    <div className={`text-base font-bold ${sig.color} mb-0.5`}>{icon} {sig.label}</div>
                    <div className="text-xs text-slate-600 leading-snug">{sig.note}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <ChartCard title="CBSA Housing Price Index" available={Boolean(cbsaHPI?.length)} failureNote={failedSources.includes('Regional data') ? 'source failed' : 'not available for this area'}>
              <MiniLineChart data={(cbsaHPI || []).map((h: any) => h.value)} xLabels={(cbsaHPI || []).map((h: any) => h.date?.substring(0, 7))} color="#3b82f6" label="HPI" isCurrency={false} />
            </ChartCard>
            <ChartCard title="County Unemployment Trend" available={countyUnemploymentHistory.length > 0} failureNote={failedSources.includes('County data') ? 'source failed' : 'not available for this area'}>
              <MiniLineChart data={countyUnemploymentHistory.map((h: any) => h.value)} xLabels={countyUnemploymentHistory.map((h: any) => h.date?.substring(5))} color="#ef4444" label="Rate %" isCurrency={false} isPercentage={true} />
            </ChartCard>
            <ChartCard title="ZIP Median Sale Price Trend" available={attomChartData.length > 1} failureNote={failedSources.includes('ATTOM data') ? 'source failed' : 'not available for this ZIP'}>
              <MiniLineChart data={attomChartData.map((d: any) => d.medianSalePrice)} xLabels={attomChartData.map((d: any) => d.period?.substring(5, 7))} color="#10b981" label="Median Sale $" isCurrency={true} />
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <ChartCard title="Median Rent by Bedrooms" available={rentByBedrooms.length > 0} failureNote="not available for this ZIP">
              <MiniBarChart
                data={rentByBedrooms.slice(0, 5).map((b: any) => b.median || 0)}
                xLabels={rentByBedrooms.slice(0, 5).map((b: any) => b.label || `${b.bedrooms}BR`)}
                color="#10b981"
                label="Rent $/mo"
                isCurrency={true}
              />
            </ChartCard>
            <ChartCard title="Days on Market Comparison" available={rentalDOM != null || saleDOM != null} failureNote="not available for this ZIP">
              <MiniBarChart
                data={[rentalDOM ?? 0, saleDOM ?? 0]}
                xLabels={['Rental', 'Sale']}
                color="#64748b"
                label="Days"
                isCurrency={false}
              />
            </ChartCard>
            <ChartCard title="Yield by Property Type" available={Boolean(rentByType.length && saleByType.length)} failureNote="not available for this ZIP">
              <MiniBarChart
                data={rentByType.slice(0, 5).map((rt: any) => {
                  const saleMatch = saleByType.find((st: any) => st.label === rt.label);
                  if (!rt.median || !saleMatch?.median) return 0;
                  return parseFloat(((rt.median * 12 / saleMatch.median) * 100).toFixed(1));
                })}
                xLabels={rentByType.slice(0, 5).map((rt: any) => rt.label)}
                color="#f59e0b"
                label="Yield %"
                isCurrency={false}
              />
            </ChartCard>
          </div>

          {/* ── RentCast Detailed Tables ── */}
          {(rentByType.length > 0 || saleByType.length > 0) && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-bold text-slate-700 mb-4">RentCast Market Breakdown</h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* By Property Type */}
                {rentByType.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Rental by Property Type</h4>
                    <table className="w-full text-xs">
                      <thead><tr className="text-slate-400 border-b border-slate-100">
                        <th className="text-left py-1.5 font-medium">Type</th>
                        <th className="text-right py-1.5 font-medium">Median Rent</th>
                        <th className="text-right py-1.5 font-medium">Listings</th>
                        <th className="text-right py-1.5 font-medium">DOM</th>
                      </tr></thead>
                      <tbody>
                        {rentByType.slice(0, 6).map((item: any, i: number) => (
                          <tr key={i} className="border-b border-slate-50">
                            <td className="py-1.5 font-medium text-slate-700">{item.label}</td>
                            <td className="py-1.5 text-right text-slate-600">{item.median ? `$${Math.round(item.median).toLocaleString()}` : '—'}</td>
                            <td className="py-1.5 text-right text-slate-500">{item.totalListings ?? '—'}</td>
                            <td className="py-1.5 text-right text-slate-500">{item.medianDaysOnMarket ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Sale by Property Type */}
                {saleByType.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Sale by Property Type</h4>
                    <table className="w-full text-xs">
                      <thead><tr className="text-slate-400 border-b border-slate-100">
                        <th className="text-left py-1.5 font-medium">Type</th>
                        <th className="text-right py-1.5 font-medium">Median Price</th>
                        <th className="text-right py-1.5 font-medium">Listings</th>
                        <th className="text-right py-1.5 font-medium">DOM</th>
                      </tr></thead>
                      <tbody>
                        {saleByType.slice(0, 6).map((item: any, i: number) => (
                          <tr key={i} className="border-b border-slate-50">
                            <td className="py-1.5 font-medium text-slate-700">{item.label}</td>
                            <td className="py-1.5 text-right text-slate-600">{item.median ? `$${Math.round(item.median).toLocaleString()}` : '—'}</td>
                            <td className="py-1.5 text-right text-slate-500">{item.totalListings ?? '—'}</td>
                            <td className="py-1.5 text-right text-slate-500">{item.medianDaysOnMarket ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* By Bedrooms */}
              {rentByBedrooms.length > 0 && (
                <div className="mt-5">
                  <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Rental by Bedrooms</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                    {rentByBedrooms.slice(0, 5).map((item: any, i: number) => (
                      <div key={i} className="bg-slate-50 rounded-lg p-2.5 text-center">
                        <div className="text-xs text-slate-500">{item.label || `${item.bedrooms} BR`}</div>
                        <div className="text-sm font-bold text-slate-800 mt-0.5">
                          {item.median ? `$${Math.round(item.median).toLocaleString()}` : '—'}
                        </div>
                        <div className="text-[10px] text-slate-400">{item.totalListings ?? 0} listings</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </GlassCard>
          )}

          {/* ── ATTOM Sales Trend Table ── */}
          {attomChartData.length > 0 && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-bold text-slate-700 mb-3">ATTOM Sales Trend — ZIP {location?.zipCode}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-slate-400 border-b border-slate-100">
                    <th className="text-left py-1.5 font-medium">Period</th>
                    <th className="text-right py-1.5 font-medium">Median Sale</th>
                    <th className="text-right py-1.5 font-medium">Avg Sale</th>
                    <th className="text-right py-1.5 font-medium">Sales Count</th>
                  </tr></thead>
                  <tbody>
                    {attomChartData.slice(-12).map((row: any, i: number) => (
                      <tr key={i} className="border-b border-slate-50">
                        <td className="py-1.5 font-medium text-slate-700">{row.period}</td>
                        <td className="py-1.5 text-right text-slate-600">{row.medianSalePrice ? `$${Math.round(row.medianSalePrice).toLocaleString()}` : '—'}</td>
                        <td className="py-1.5 text-right text-slate-500">{row.avgSalePrice ? `$${Math.round(row.avgSalePrice).toLocaleString()}` : '—'}</td>
                        <td className="py-1.5 text-right text-slate-500">{row.salesCount ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {appreciation?.ok && (
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <span className={`font-bold ${appreciation.appreciationPercent >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {appreciation.appreciationPercent >= 0 ? '↑' : '↓'} {Math.abs(appreciation.appreciationPercent).toFixed(1)}%
                  </span>
                  <span className="text-slate-400">appreciation over {appreciation.periodLabel}</span>
                </div>
              )}
            </GlassCard>
          )}

          {/* ── Rental Comps Preview ── */}
          {rentalComps?.comparables?.length > 0 && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-bold text-slate-700 mb-1">Nearby Rental Comparables</h3>
              <p className="text-xs text-slate-400 mb-3">
                {rentalComps.matchedCount} listings found · median ${rentalComps.summary?.medianRent?.toLocaleString()}/mo
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {rentalComps.comparables.slice(0, 6).map((comp: any, i: number) => (
                  <div key={i} className="bg-slate-50 rounded-lg p-3 text-xs">
                    <div className="font-medium text-slate-700 truncate">{comp.formattedAddress}</div>
                    <div className="flex items-center gap-2 mt-1 text-slate-500">
                      <span className="font-bold text-emerald-600">${comp.price?.toLocaleString()}/mo</span>
                      {comp.bedrooms && <span>{comp.bedrooms}bd</span>}
                      {comp.bathrooms && <span>{comp.bathrooms}ba</span>}
                      {comp.squareFootage && <span>{comp.squareFootage.toLocaleString()} sqft</span>}
                    </div>
                    {comp.distanceMiles != null && (
                      <div className="text-[10px] text-slate-400 mt-0.5">{comp.distanceMiles} mi · {comp.daysOnMarket} DOM</div>
                    )}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {/* ── Nearby ZIP Comparison ── */}
          {nearbyZips?.zips?.length > 0 && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-bold text-slate-700 mb-3">Nearby ZIP Comparison</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-slate-400 border-b border-slate-100">
                    <th className="text-left py-1.5 font-medium">ZIP</th>
                    <th className="text-left py-1.5 font-medium">Area</th>
                    <th className="text-right py-1.5 font-medium">Dist</th>
                    <th className="text-right py-1.5 font-medium">Rent</th>
                    <th className="text-right py-1.5 font-medium">Sale Price</th>
                    <th className="text-right py-1.5 font-medium">Yield</th>
                    <th className="text-right py-1.5 font-medium">P/R</th>
                  </tr></thead>
                  <tbody>
                    {nearbyZips.zips.map((z: any, i: number) => (
                      <tr key={i} className="border-b border-slate-50">
                        <td className="py-1.5 font-medium text-slate-700">{z.zipCode}</td>
                        <td className="py-1.5 text-slate-600">{z.label}</td>
                        <td className="py-1.5 text-right text-slate-500">{z.distanceMiles} mi</td>
                        <td className="py-1.5 text-right text-slate-600">{z.market?.derived?.medianAskingRent ? `$${Math.round(z.market.derived.medianAskingRent).toLocaleString()}` : '—'}</td>
                        <td className="py-1.5 text-right text-slate-600">{z.market?.derived?.medianSalePrice ? `$${Math.round(z.market.derived.medianSalePrice).toLocaleString()}` : '—'}</td>
                        <td className="py-1.5 text-right font-medium text-emerald-600">{z.market?.derived?.grossYieldPct ? `${z.market.derived.grossYieldPct.toFixed(1)}%` : '—'}</td>
                        <td className="py-1.5 text-right text-slate-500">{z.market?.derived?.priceToRentRatio?.toFixed(1) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {nearbyZips.summary && (
                <div className="mt-3 flex items-center gap-4 text-xs text-slate-400">
                  <span>Avg Yield: <b className="text-emerald-600">{nearbyZips.summary.avgGrossYieldPct?.toFixed(1)}%</b></span>
                  <span>Avg Rent: <b className="text-slate-600">${nearbyZips.summary.avgMedianAskingRent?.toLocaleString()}</b></span>
                  <span>Avg Price: <b className="text-slate-600">${nearbyZips.summary.avgMedianSalePrice?.toLocaleString()}</b></span>
                </div>
              )}
            </GlassCard>
          )}

          {showAiBrief && !dataLoading && (zipMarketData || countyData || attomData) && (
            <MarketAIAnalysis
              surface="light"
              endpoint="/api/my-region/ai-analysis"
              payload={aiPayload}
              title="Local market brief"
              subtitle={`What local conditions mean for ${location?.countyName || location?.zipCode || 'your area'}`}
              icon="AI"
              autoRun={false}
              cacheKey={`my-region-ai-${location?.zipCode || location?.fips || 'local'}`}
              cacheMode="local"
              manualRefreshOnly={true}
              collapsible={true}
              defaultExpanded={true}
              compact={true}
            />
          )}
        </>
      )}
    </div>
  );
};

export default MyRegionTab;
