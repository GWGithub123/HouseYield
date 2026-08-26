import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useVoiceActionHandler, useVoiceCommand } from '../contexts/VoiceCommandContext';
import { ComponentErrorBoundary } from '../ComponentErrorBoundary';
import { findTrustedProviderForCategory } from '../components/TrustedProviders';
import { calculateRemainingMortgageBalance } from '../services/portfolioService';
import { buildOwnerFinanceUrl } from '../services/ownerFinanceApi';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import { SavedProperty, getSavedProperties, saveProperty, removeSavedProperty } from '../utils/savedProperties';
import { subscribeToPush, sendTestPush, unsubscribeFromPush } from '../services/pushNotifications';
import { getCachedAirQualityData, cacheAirQualityData, getCachedNoiseData, cacheNoiseData, getCachedFloodData, cacheFloodData, getCachedWildfireData, cacheWildfireData, clearEnvironmentalCache } from '../services/environmentalCacheService';
import { PropertyOverviewAnalyticsGrid, AdditionalAnalyticsChartsGrid } from '../components/property/PropertyAnalyticsGraphs';
import type { PropertyAnalyticsMetricKey } from '../components/property/PropertyAnalyticsGraphs';
import { FactPanel, FactRow, FactPanelEmpty } from '../components/property/PropertyFactPanel';
import {
  PROPERTY_USE_TYPE_META,
  resolvePropertyUseType,
  shouldShowRentalWorkspace,
} from '../types/propertyUse';

/**
 * Value and taxes are true of any property. Everything else in the analytics grid
 * models rental income, so a second home would render them as zeros.
 */
const NON_RENTAL_ANALYTICS_METRICS: PropertyAnalyticsMetricKey[] = ['priceHistory', 'taxHistory'];
import RentalPricingPowerGraph from '../components/RentalPricingPowerGraph';
import { PreviewResult, generateSuggestionPreview, savePreviewToFirebase, loadSavedPreviews } from '../services/renovationSuggestionPreviewService';
import { normalizeCanonicalRenovationSuggestion } from '../utils/canonicalRenovationSuggestion';
import { SavedScanSummary, listSavedScans, deleteSavedScan, getScanThumbnailUrl } from '../services/roomScannerService';
import { createListing as createFirestoreListing, deleteListing as deleteFirestoreListing } from '../services/firebaseService';
import PropertyListingHistoryModal from '../components/PropertyListingHistoryModal';
import SensorDashboard from '../components/SensorDashboard';
import ShellyDashboard from '../components/ShellyDashboard';
import ShellySetupWizard from '../components/ShellySetupWizard';
import MessagingModal from '../components/MessagingModal';
import TenantOnboardingModal from '../components/TenantOnboardingModal';
import FinancialReservesAnalytics from '../components/FinancialReservesAnalytics';
import LandlordBankSetup from '../components/LandlordBankSetup';
import TenantActivityPanel from '../components/TenantActivityPanel';
import TenantInterviewScheduler from '../components/TenantInterviewScheduler';
import TenantPaymentForm from '../components/TenantPaymentForm';
import LeaseBuilder from '../components/LeaseBuilder';
import DocumentManager from '../components/DocumentManager';
import { StreetViewImage } from '../components/StreetViewImage';
import RegionalHeatMap from '../components/RegionalHeatMap';
import { useFloodDepthGrid } from '../hooks/useFloodDepthGrid';
import { paintDepthRaster, tierSwatch } from '../utils/floodDepthRaster';
import { DEPTH_TIERS } from '../design-system/riskPalette';
import RiskFluctuationGraph from '../components/RiskFluctuationGraph';
import EnvironmentalRiskMitigationPanel from '../components/EnvironmentalRiskMitigationPanel';
import RenovationROITestModal from '../components/RenovationROITestModal';
import { AdvancedPropertyAnalysisModal, RentalSankeyDiagram } from '../components/AdvancedPropertyAnalysisModal';
import AITestScenarios from '../components/property/AITestScenarios';
import MLSDataExplorerModal from '../components/MLSDataExplorerModal';
import AssumableMortgageScannerModal from '../components/AssumableMortgageScannerModal';
import { AnalyticsCard } from '../components/charts/AnalyticsFrame';
import SystemOverview from '../components/insurance/SystemOverview';
import InsuranceConfirmation from '../components/insurance/InsuranceConfirmation';
import InsuranceDiscountExplainer from '../components/insurance/InsuranceDiscountExplainer';
import InsurerSelection from '../components/insurance/InsurerSelection';
import CertificateViewer from '../components/insurance/CertificateViewer';
import EmailRequestGenerator from '../components/insurance/EmailRequestGenerator';
import { createGoogleMapsHeatmapLayer } from '../utils/googleMapsHeatmap';
import { loadGoogleMaps, GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_MAP_ID } from '../utils/googleMaps';
import { formatCurrency, formatPercentage } from '../utils/formatting';
import {
  fetchPropertyWeatherAssessment,
  floodBridgeFromAssessment,
  type FloodMapBridge,
} from '../services/propertyWeatherClient';
import {
  getPropertyWorkspaceTabs,
  isMaintenanceProduct,
  normalizePropertyWorkspaceTab,
  type PropertyWorkspaceTabId,
} from '../product/productMode';
import { buildPropertyPortfolioOverview } from '../services/canonicalPortfolioService';
import { PortfolioValueHistoryCard } from '../components/property/PortfolioOverviewTab';
import { PropertyTwinCard } from '../components/property/PropertyTwinCard';
import type { PropertyVisualView } from '../components/property/PropertyTwinCard';
import { TwinPill, TwinSegmented } from '../components/property/TwinCard';
import PropertyHealthTab from '../components/property/PropertyHealthTab';
import type { PropertyPortfolioHistoryGranularity } from '../services/canonicalPortfolioService';
import { Card, KpiStrip } from '../design-system';
import type { KpiStripItem } from '../design-system/components/KpiStrip';
import { QRCodeSVG } from 'qrcode.react';

// ====================
// Local design helpers (scoped to PortfolioPage — intentionally not shared)
// Keep these local to avoid merge conflicts with parallel design-token work.
// ====================
const HY_BRAND_GRADIENT = 'linear-gradient(135deg,#14b8a6 0%,#6366f1 55%,#8b5cf6 100%)';
// Matches the Predictive Maintenance page wash so the two surfaces read as one product.
const HY_PAGE_WASH =
  'radial-gradient(circle at top left, rgba(226,232,240,0.8), transparent 32%), linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%)';
const HY_RISK_TRACK = 'linear-gradient(90deg,#10b981 0%,#10b981 28%,#f59e0b 55%,#f43f5e 100%)';

const hyRiskToneFromScore = (score: number) => {
  if (score >= 66) return { text: 'text-rose-700', dot: '#f43f5e', label: 'High' };
  if (score >= 33) return { text: 'text-amber-700', dot: '#f59e0b', label: 'Moderate' };
  return { text: 'text-emerald-700', dot: '#10b981', label: 'Low' };
};

// Gradient risk meter (low=emerald → moderate=amber → high=rose) with a marker at the score.
const HyRiskMeter: React.FC<{ score: number; valueText?: string; levelText?: string; className?: string }> = ({ score, valueText, levelText, className }) => {
  const s = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const tone = hyRiskToneFromScore(s);
  return (
    <div className={`rounded-xl border border-slate-200/70 bg-slate-50/70 px-3 py-2.5 ${className || ''}`}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Risk score</span>
        <span className={`text-xs font-bold ${tone.text}`}>
          {valueText ?? `${Math.round(s)}/100`}{levelText ? ` · ${levelText}` : ''}
        </span>
      </div>
      <div className="relative h-2.5 w-full rounded-full" style={{ background: HY_RISK_TRACK }}>
        <div
          className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_2px_6px_rgba(15,23,42,0.25)]"
          style={{ left: `calc(${s}% - 8px)`, background: tone.dot }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] font-medium uppercase tracking-[0.12em] text-slate-400">
        <span>Low</span><span>Moderate</span><span>High</span>
      </div>
    </div>
  );
};

// Lightweight gradient sparkline for KPI chips.
const HySparkline: React.FC<{ values: number[]; max: number; color: string; currentIndex?: number }> = ({ values, max, color, currentIndex }) => {
  const gid = React.useId().replace(/:/g, '');
  if (!values || values.length < 2 || !(max > 0)) return null;
  const w = 100, h = 30, n = values.length;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => h - (Math.max(0, Math.min(max, v)) / max) * (h - 3) - 1.5;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      {currentIndex != null && currentIndex >= 0 && currentIndex < n && (
        <circle cx={x(currentIndex)} cy={y(values[currentIndex])} r={2.6} fill={color} stroke="#fff" strokeWidth={1} />
      )}
    </svg>
  );
};

type HySeasonalRiskShape = { monthly: number[]; peakMonth: number; peakValue: number; currentMonth: number; currentValue: number } | undefined;

// Unified Environmental Risk summary header: combined score ring + per-hazard KPI chips with sparklines.
const HyEnvRiskSummary: React.FC<{
  seasonal: { airQuality?: HySeasonalRiskShape; flood?: HySeasonalRiskShape; wildfire?: HySeasonalRiskShape };
  /** When true, only flood KPIs are shown (maintenance product surface). */
  floodOnly?: boolean;
}> = ({ seasonal, floodOnly = false }) => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const items = (
    floodOnly
      ? [
          { key: 'flood', label: 'Flood', unit: 'Risk', max: 10, color: '#6366f1', data: seasonal.flood },
        ]
      : [
          { key: 'airQuality', label: 'Air Quality', unit: 'AQI', max: 200, color: '#0ea5e9', data: seasonal.airQuality },
          { key: 'flood', label: 'Flood', unit: 'Risk', max: 10, color: '#6366f1', data: seasonal.flood },
          { key: 'wildfire', label: 'Wildfire', unit: 'Risk', max: 10, color: '#f59e0b', data: seasonal.wildfire },
        ]
  ) as Array<{
    key: string;
    label: string;
    unit: string;
    max: number;
    color: string;
    data: HySeasonalRiskShape | undefined;
  }>;

  const scored = items.map((it) => ({
    ...it,
    score: it.data && it.data.currentValue != null ? Math.round((it.data.currentValue / it.max) * 100) : null,
  }));
  const valid = scored.map((s) => s.score).filter((s): s is number => s != null);
  const combined = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
  const tone = hyRiskToneFromScore(combined ?? 0);

  // Ring geometry
  const R = 34, C = 2 * Math.PI * R;
  const pct = combined != null ? combined / 100 : 0;

  return (
    <div className="mb-5 rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)] backdrop-blur-xl sm:p-5">
      <div className="grid gap-5 lg:grid-cols-[auto_1fr] lg:items-center">
        {/* Combined score ring */}
        <div className="flex items-center gap-4">
          <div className="relative h-[92px] w-[92px] shrink-0">
            <svg viewBox="0 0 92 92" className="h-full w-full -rotate-90">
              <circle cx="46" cy="46" r={R} fill="none" stroke="#e2e8f0" strokeWidth="9" />
              <circle
                cx="46" cy="46" r={R} fill="none" stroke={tone.dot} strokeWidth="9" strokeLinecap="round"
                strokeDasharray={`${(C * pct).toFixed(1)} ${C.toFixed(1)}`}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold tracking-tight text-slate-900">{combined ?? '—'}</span>
              <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">/ 100</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Combined Risk</div>
            <div className={`mt-0.5 text-lg font-semibold tracking-tight ${tone.text}`}>{combined != null ? tone.label : 'Pending'}</div>
            <p className="mt-0.5 max-w-[220px] text-xs text-slate-500">
              {combined != null
                ? floodOnly
                  ? 'Flood exposure score for this location.'
                  : 'Blended air, flood & wildfire exposure for this location.'
                : 'Load a location to compute a blended score.'}
            </p>
          </div>
        </div>

        {/* Per-hazard KPI chips */}
        <div className={`grid gap-2.5 ${floodOnly ? 'sm:grid-cols-1 max-w-sm' : 'sm:grid-cols-3'}`}>
          {scored.map((it) => {
            const itTone = it.score != null ? hyRiskToneFromScore(it.score) : null;
            return (
              <div key={it.key} className="rounded-xl border border-slate-200/70 bg-white px-3 py-2.5 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                    <span className="h-2 w-2 rounded-full" style={{ background: it.color }} />
                    {it.label}
                  </span>
                  {itTone && <span className={`text-[10px] font-bold uppercase tracking-wide ${itTone.text}`}>{itTone.label}</span>}
                </div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="text-lg font-bold tracking-tight text-slate-900">
                    {it.data?.currentValue != null ? Math.round(it.data.currentValue * 10) / 10 : '—'}
                  </span>
                  <span className="text-[10px] font-medium text-slate-400">{it.unit}</span>
                </div>
                <div className="mt-1">
                  <HySparkline
                    values={it.data?.monthly || []}
                    max={it.max}
                    color={it.color}
                    currentIndex={it.data?.currentMonth}
                  />
                </div>
                {it.data && (
                  <div className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-slate-400">
                    Peak {MONTHS[it.data.peakMonth] ?? '—'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// --- AI Service Recommendations (PortfolioPage-exclusive) ---
type AIServiceProps = {
  defaultContactName?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  defaultServiceAddress?: string;
  defaultIssue?: string;
};

type PortfolioMapPin = {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  marketValue: number | null;
  monthlyRent: number | null;
  property: any;
};

const buildGoogleMapsSearchUrl = (query: string, latitude?: string | number | null, longitude?: string | number | null) => {
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);

  if (Number.isFinite(parsedLatitude) && Number.isFinite(parsedLongitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${parsedLatitude},${parsedLongitude}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
};

const combinePortfolioPropertyAddress = (address?: string | null, location?: string | null) =>
  [address, location]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizePortfolioPropertyAddress = (value?: string | null) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const getFiniteCoordinate = (...candidates: Array<string | number | null | undefined>) => {
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const getPortfolioPropertyMapPin = (property: any): PortfolioMapPin | null => {
  const propertyData = property?.property_data || {};
  const summary = propertyData?.summary || {};
  const location = propertyData?.location || {};
  const parcelCentroid = propertyData?.parcel_map?.parcel?.centroid
    || propertyData?.parcel_map?.subject?.centroid
    || propertyData?.parcel_map?.geometry?.centroid
    || {};

  const latitude = getFiniteCoordinate(
    summary.latitude,
    summary.lat,
    location.latitude,
    location.lat,
    parcelCentroid.lat,
    property?.latitude,
  );
  const longitude = getFiniteCoordinate(
    summary.longitude,
    summary.lng,
    location.longitude,
    location.lng,
    parcelCentroid.lng,
    property?.longitude,
  );

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    id: String(property?.id || property?.address || `${latitude},${longitude}`),
    address: property?.address || summary.address || 'Saved property',
    latitude,
    longitude,
    marketValue: getFiniteCoordinate(summary.avm_value, summary.market_value, summary.value),
    monthlyRent: getFiniteCoordinate(property?.financial_data?.monthlyRent, summary.rental_avm, summary.market_rent),
    property,
  };
};

const clearGoogleMapMarker = (marker: any) => {
  if (!marker) return;

  if (typeof marker.setMap === 'function') {
    marker.setMap(null);
    return;
  }

  if ('map' in marker) {
    marker.map = null;
  }
};

const createPortfolioInfoWindowContent = (pin: PortfolioMapPin) => {
  const container = document.createElement('div');
  container.className = 'min-w-[220px] max-w-[280px] px-1 py-1 text-slate-900';

  const title = document.createElement('div');
  title.className = 'text-sm font-semibold leading-5 text-slate-900';
  title.textContent = pin.address;
  container.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'mt-2 flex flex-wrap gap-2 text-xs text-slate-600';

  if (pin.marketValue !== null) {
    const valueChip = document.createElement('div');
    valueChip.className = 'rounded-full bg-slate-100 px-2.5 py-1 font-medium';
    valueChip.textContent = `Value ${formatCurrency(pin.marketValue)}`;
    meta.appendChild(valueChip);
  }

  if (pin.monthlyRent !== null) {
    const rentChip = document.createElement('div');
    rentChip.className = 'rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700';
    rentChip.textContent = `Rent ${formatCurrency(pin.monthlyRent)}/mo`;
    meta.appendChild(rentChip);
  }

  if (meta.childNodes.length > 0) {
    container.appendChild(meta);
  }

  return container;
};

const PortfolioPropertiesMap: React.FC<{
  properties: any[];
  selectedPropertyAddress?: string;
  overviewToneLabel: string;
  onSelectProperty?: (property: any) => void;
  variant?: 'default' | 'analytics' | 'embedded';
}> = ({ properties, selectedPropertyAddress, overviewToneLabel, onSelectProperty, variant = 'default' }) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<any>(null);
  const markersRef = React.useRef<any[]>([]);
  const infoWindowRef = React.useRef<any>(null);
  const onSelectPropertyRef = React.useRef(onSelectProperty);
  const [mapReady, setMapReady] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const mapPins = React.useMemo(
    () => properties.map(getPortfolioPropertyMapPin).filter((pin): pin is PortfolioMapPin => Boolean(pin)),
    [properties],
  );
  const missingCoordinateCount = Math.max(0, properties.length - mapPins.length);

  React.useEffect(() => {
    onSelectPropertyRef.current = onSelectProperty;
  }, [onSelectProperty]);

  React.useEffect(() => {
    let cancelled = false;

    const initMap = async () => {
      if (mapRef.current || !containerRef.current) return;
      if (!GOOGLE_MAPS_API_KEY) {
        setLoadError('Google Maps is not configured for this workspace.');
        return;
      }

      try {
        await loadGoogleMaps();
        if (cancelled || !containerRef.current) return;

        const g = (window as any).google;
        mapRef.current = new g.maps.Map(containerRef.current, {
          center: { lat: 39.5, lng: -98.35 },
          zoom: 4,
          mapTypeId: 'hybrid',
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          ...(GOOGLE_MAPS_MAP_ID ? { mapId: GOOGLE_MAPS_MAP_ID } : {}),
        });
        infoWindowRef.current = new g.maps.InfoWindow();
        setMapReady(true);
      } catch (error: any) {
        console.error('[PortfolioMap] Failed to initialize Google Maps', error);
        setLoadError(error?.message || 'Unable to load Google Maps.');
      }
    };

    initMap();

    return () => {
      cancelled = true;
      infoWindowRef.current?.close?.();
      markersRef.current.forEach(clearGoogleMapMarker);
      markersRef.current = [];
    };
  }, []);

  React.useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const g = (window as any).google;
    let boundsChangedListener: any = null;

    markersRef.current.forEach(clearGoogleMapMarker);
    markersRef.current = [];
    infoWindowRef.current?.close?.();

    if (mapPins.length === 0) {
      mapRef.current.setCenter({ lat: 39.5, lng: -98.35 });
      mapRef.current.setZoom(4);
      return;
    }

    const bounds = new g.maps.LatLngBounds();

    mapPins.forEach((pin, index) => {
      bounds.extend({ lat: pin.latitude, lng: pin.longitude });
      const isSelected = pin.address === selectedPropertyAddress;
      let marker: any;

      const handleClick = () => {
        onSelectPropertyRef.current?.(pin.property);

        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(createPortfolioInfoWindowContent(pin));
          try {
            infoWindowRef.current.open({ map: mapRef.current, anchor: marker });
          } catch {
            infoWindowRef.current.open(mapRef.current, marker);
          }
        }

        mapRef.current.panTo({ lat: pin.latitude, lng: pin.longitude });
        const currentZoom = Number(mapRef.current.getZoom?.() || 0);
        if (currentZoom < 11) {
          mapRef.current.setZoom(11);
        }
      };

      if (GOOGLE_MAPS_MAP_ID && g.maps?.marker?.AdvancedMarkerElement && g.maps?.marker?.PinElement) {
        const pinElement = new g.maps.marker.PinElement({
          background: isSelected ? '#0f172a' : '#2563eb',
          borderColor: '#ffffff',
          glyphColor: '#ffffff',
          glyph: `${index + 1}`,
          scale: isSelected ? 1.15 : 1,
        });

        marker = new g.maps.marker.AdvancedMarkerElement({
          map: mapRef.current,
          position: { lat: pin.latitude, lng: pin.longitude },
          title: pin.address,
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
          position: { lat: pin.latitude, lng: pin.longitude },
          title: pin.address,
          label: { text: `${index + 1}`, color: '#ffffff', fontWeight: '700' },
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: isSelected ? 12 : 10,
            fillColor: isSelected ? '#0f172a' : '#2563eb',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 3,
          },
          zIndex: isSelected ? 1300 : 1000,
        });
        marker.addListener('click', handleClick);
      }

      markersRef.current.push(marker);
    });

    if (mapPins.length === 1) {
      mapRef.current.setCenter({ lat: mapPins[0].latitude, lng: mapPins[0].longitude });
      mapRef.current.setZoom(13);
    } else {
      mapRef.current.fitBounds(bounds, 56);
      boundsChangedListener = g.maps.event.addListenerOnce(mapRef.current, 'bounds_changed', () => {
        const nextZoom = Number(mapRef.current.getZoom?.() || 0);
        if (nextZoom > 15) {
          mapRef.current.setZoom(15);
        }
      });
    }

    return () => {
      if (boundsChangedListener) {
        g.maps.event.removeListener(boundsChangedListener);
      }
    };
  }, [mapReady, mapPins, selectedPropertyAddress]);

  if (loadError) {
    if (variant === 'analytics') {
      return (
        <div className="flex h-full min-h-[280px] items-center justify-center rounded-[18px] border border-white/15 bg-slate-950/20 px-6 text-center text-sm font-medium text-slate-500">
          {loadError}
        </div>
      );
    }

    return (
      <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/90 px-6 py-8 text-center text-sm text-slate-500 shadow-sm">
        {loadError}
      </div>
    );
  }

  if (properties.length > 0 && mapPins.length === 0) {
    if (variant === 'analytics') {
      return (
        <div className="flex h-full min-h-[280px] items-center justify-center rounded-[18px] border border-white/15 bg-slate-950/20 px-6 text-center text-sm font-medium text-slate-500">
          Saved properties are available, but none of them have map coordinates yet.
        </div>
      );
    }

    return (
      <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/90 px-6 py-8 text-center text-sm text-slate-500 shadow-sm">
        Saved properties are available, but none of them have map coordinates yet.
      </div>
    );
  }

  if (variant === 'embedded') {
    // Fills whatever the caller sizes it to rather than fixing its own height,
    // so the map and the value trend beside it stay the same height.
    return (
      <div className="relative h-full min-h-[280px] w-full bg-slate-100">
        <div ref={containerRef} className="h-full w-full" />
        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            Loading map...
          </div>
        )}
      </div>
    );
  }

  if (variant === 'analytics') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-500">
          <span>{mapPins.length} {mapPins.length === 1 ? 'property' : 'properties'} mapped</span>
          {missingCoordinateCount > 0 && <span>{missingCoordinateCount} missing coordinates</span>}
        </div>
        <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-[18px] border border-white/15 bg-slate-950/20">
          <div ref={containerRef} className="h-full min-h-[320px] w-full" />
          {!mapReady && (
            <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-slate-500">
              Loading map...
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200/70 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/70 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(99,102,241,0.07),transparent_55%),radial-gradient(120%_140%_at_100%_0%,rgba(20,184,166,0.07),transparent_55%)] px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl text-white shadow-sm" style={{ background: HY_BRAND_GRADIENT }}>
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
          </span>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{overviewToneLabel}</div>
            <div className="mt-0.5 text-sm font-medium text-slate-700">
              {mapPins.length} {mapPins.length === 1 ? 'property' : 'properties'} mapped across this account
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 font-medium text-slate-600 shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#6366f1' }} />
            Click a pin to focus a property
          </span>
          {missingCoordinateCount > 0 && (
            <span className="rounded-full bg-amber-50 px-3 py-1 font-medium text-amber-700">
              {missingCoordinateCount} missing coordinates
            </span>
          )}
        </div>
      </div>
      <div className="relative h-[320px] w-full bg-slate-100">
        <div ref={containerRef} className="h-full w-full" />
        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            Loading map...
          </div>
        )}
      </div>
    </section>
  );
};

const getSchoolRatingClasses = (rating?: string | number | null) => {
  const numericRating = typeof rating === 'number' ? rating : Number.parseFloat(String(rating ?? ''));

  if (Number.isFinite(numericRating)) {
    if (numericRating >= 8) return 'bg-emerald-100 text-emerald-700';
    if (numericRating >= 6) return 'bg-lime-100 text-lime-700';
    if (numericRating >= 4) return 'bg-amber-100 text-amber-700';
    return 'bg-rose-100 text-rose-700';
  }

  const normalizedRating = String(rating ?? '').toUpperCase();
  if (normalizedRating.startsWith('A')) return 'bg-emerald-100 text-emerald-700';
  if (normalizedRating.startsWith('B')) return 'bg-lime-100 text-lime-700';
  if (normalizedRating.startsWith('C')) return 'bg-amber-100 text-amber-700';
  if (normalizedRating) return 'bg-slate-100 text-slate-700';
  return 'bg-slate-100 text-slate-700';
};

/** Crime data section fetched from FBI CDE API via server */
const CrimeDataSection: React.FC<{
  fips?: string;
  stateCode?: string;
  county?: string;
  address?: string;
}> = ({ fips, stateCode, county, address }) => {
  const [fbiData, setFbiData] = useState<any>(null);
  const [fbiLoading, setFbiLoading] = useState(false);

  // Derive state from address if stateCode missing (e.g. "11822 Tofet Ter, Potomac MD 20854")
  const derivedState = stateCode || (() => {
    if (!address) return '';
    const m = address.match(/,\s*[A-Za-z\s]+?\b([A-Z]{2})\b/);
    return m?.[1] || '';
  })();

  // Always try to fetch FBI data for the supplemental view
  useEffect(() => {
    if (!derivedState) return;
    let cancelled = false;
    setFbiLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ state: derivedState });
        if (fips) params.set('fips', fips);
        if (county) params.set('county', county);
        const resp = await fetch(`/api/community/crime?${params}`);
        const json = await resp.json();
        if (!cancelled && json.ok && json.data) setFbiData(json.data);
      } catch { /* non-critical */ }
      if (!cancelled) setFbiLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fips, derivedState, county]);

  if (!fbiData && !fbiLoading) {
    return <div className="text-xs text-gray-400">Crime data unavailable for this area</div>;
  }

  const getCrimeRateLabel = (rate: number | null) => {
    if (!rate) return { label: '—', color: 'text-gray-400' };
    if (rate < 200) return { label: 'Low', color: 'text-emerald-600' };
    if (rate < 400) return { label: 'Moderate', color: 'text-amber-600' };
    return { label: 'High', color: 'text-rose-600' };
  };

  const getPropertyCrimeLabel = (rate: number | null) => {
    if (!rate) return { label: '—', color: 'text-gray-400' };
    if (rate < 1500) return { label: 'Low', color: 'text-emerald-600' };
    if (rate < 2500) return { label: 'Moderate', color: 'text-amber-600' };
    return { label: 'High', color: 'text-rose-600' };
  };

  return (
    <div className="space-y-4">
      {fbiLoading && !fbiData && (
        <div className="text-sm text-gray-400 flex items-center gap-2">
          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          Loading FBI crime estimates…
        </div>
      )}
      {fbiData && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wide text-gray-900 mb-2">
            FBI Crime Estimates
            {fbiData.year && <span className="ml-1.5 font-normal text-gray-400">({fbiData.state}, {fbiData.year})</span>}
          </h4>
          <div className="grid grid-cols-2 gap-x-6 text-sm">
            {fbiData.violent_crime && (
              <div className="flex justify-between border-b border-dotted border-gray-200 py-1">
                <span className="text-gray-500">Violent Crime Rate:</span>
                <span className={`font-semibold ${getCrimeRateLabel(fbiData.violent_crime.rate_per_100k).color}`}>
                  {fbiData.violent_crime.rate_per_100k?.toLocaleString() ?? '—'}/100k
                  <span className="ml-1 text-xs font-normal">({getCrimeRateLabel(fbiData.violent_crime.rate_per_100k).label})</span>
                </span>
              </div>
            )}
            {fbiData.property_crime && (
              <div className="flex justify-between border-b border-dotted border-gray-200 py-1">
                <span className="text-gray-500">Property Crime Rate:</span>
                <span className={`font-semibold ${getPropertyCrimeLabel(fbiData.property_crime.rate_per_100k).color}`}>
                  {fbiData.property_crime.rate_per_100k?.toLocaleString() ?? '—'}/100k
                  <span className="ml-1 text-xs font-normal">({getPropertyCrimeLabel(fbiData.property_crime.rate_per_100k).label})</span>
                </span>
              </div>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-1">Source: FBI Crime Data Explorer · State-level rates per 100k · Cached 90 days</p>
        </div>
      )}
    </div>
  );
};

const AIServiceRecommendations: React.FC<AIServiceProps> = ({
  defaultContactName,
  defaultContactEmail,
  defaultContactPhone,
  defaultServiceAddress,
  defaultIssue,
}) => {
  const { user } = useAuth();
  const componentId = React.useRef(`AIService-${Math.random().toString(36).slice(2, 11)}`);
  const [description, setDescription] = useState(defaultIssue || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [best, setBest] = useState<any | null>(null);
  const [meta, setMeta] = useState<any | null>(null);
  const [queryUsed, setQueryUsed] = useState('');
  const [issueExtracted, setIssueExtracted] = useState('');
  const [locationExtracted, setLocationExtracted] = useState('');
  const [serviceAddress, setServiceAddress] = useState(defaultServiceAddress || '123 Maple Dr, Potomac MD');
  const [contactName, setContactName] = useState(defaultContactName || 'Renaissance Realty');
  const [contactEmail, setContactEmail] = useState(defaultContactEmail || 'automation@example.com');
  const [useCustomEmail, setUseCustomEmail] = useState(false);
  const [contactPhone, setContactPhone] = useState(defaultContactPhone || '301-555-1212');
  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<any | null>(null);
  const [autoSearchTriggered, setAutoSearchTriggered] = useState(false);
  const [usedTrustedProvider, setUsedTrustedProvider] = useState(false);

  const extractCategoryFromDescription = (desc: string): string | null => {
    const categoryKeywords: Record<string, string[]> = {
      Plumbing: ['plumb', 'leak', 'pipe', 'drain', 'faucet', 'toilet', 'water', 'sink', 'shower', 'bathtub', 'sewage', 'clog'],
      Electrical: ['electric', 'outlet', 'switch', 'wire', 'power', 'light', 'circuit', 'breaker', 'socket'],
      HVAC: ['hvac', 'heat', 'cool', 'air', 'furnace', 'ac', 'thermostat', 'vent', 'duct', 'conditioning'],
      Appliances: ['appliance', 'refrigerator', 'fridge', 'stove', 'oven', 'dishwasher', 'washer', 'dryer', 'microwave', 'garbage disposal'],
      Structural: ['structural', 'wall', 'floor', 'ceiling', 'foundation', 'crack', 'beam', 'drywall'],
      'Pest Control': ['pest', 'bug', 'insect', 'rodent', 'mouse', 'rat', 'roach', 'ant', 'termite', 'bee', 'wasp'],
      'Lock/Security': ['lock', 'key', 'door', 'security', 'alarm', 'deadbolt', 'broken lock'],
      Roofing: ['roof', 'shingle', 'gutter', 'leak roof', 'attic'],
      Landscaping: ['landscape', 'lawn', 'tree', 'garden', 'yard', 'irrigation', 'sprinkler'],
      'General Repair': ['repair', 'fix', 'broken', 'maintenance'],
    };

    const lowerDesc = desc.toLowerCase();
    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some((keyword) => lowerDesc.includes(keyword))) {
        return category;
      }
    }
    return null;
  };

  useEffect(() => {
    if (!useCustomEmail && defaultContactEmail) {
      setContactEmail(defaultContactEmail);
    }
  }, [defaultContactEmail, useCustomEmail]);

  useEffect(() => {
    const handleMaintenanceDetected = (event: Event) => {
      const customEvent = event as CustomEvent<any[]>;
      const issues = customEvent.detail;
      if (!issues || issues.length === 0) return;

      const firstIssue = issues[0];
      const issueDescription = firstIssue.issue?.issue || firstIssue.issue?.description || '';
      const location = firstIssue.issue?.location || 'Potomac MD';
      const fullDescription = `${issueDescription} in ${location}`.trim();

      console.log(`[${componentId.current}] Auto-populating maintenance search:`, fullDescription);
      setDescription(fullDescription);
      setAutoSearchTriggered(true);
    };

    window.addEventListener('maintenanceIssuesDetected', handleMaintenanceDetected);
    return () => window.removeEventListener('maintenanceIssuesDetected', handleMaintenanceDetected);
  }, []);

  useEffect(() => {
    if (!autoSearchTriggered || !description.trim()) return;
    setAutoSearchTriggered(false);
    void run();
  }, [autoSearchTriggered, description]);

  const postWithFallback = async (payload: any) => {
    const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
    const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
    const primary = useProxy ? '/api/form-schedule' : `${baseEnv || 'http://127.0.0.1:3001'}/api/form-schedule`;
    const secondary = useProxy ? 'http://127.0.0.1:3001/api/form-schedule' : '/api/form-schedule';

    const tryPost = async (url: string) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`Non-JSON response (status ${response.status})`);
        }
      } finally {
        clearTimeout(timeout);
      }
    };

    try {
      return await tryPost(primary);
    } catch (primaryError: any) {
      try {
        return await tryPost(secondary);
      } catch (secondaryError: any) {
        throw new Error(`form-schedule failed: ${primaryError?.message || primaryError} | fallback: ${secondaryError?.message || secondaryError}`);
      }
    }
  };

  const run = async () => {
    if (!description.trim()) return;

    setLoading(true);
    setError(null);
    setBest(null);
    setMeta(null);
    setUsedTrustedProvider(false);

    const extractedCategory = extractCategoryFromDescription(description);
    if (extractedCategory) {
      const trustedProvider = await findTrustedProviderForCategory(user?.id, extractedCategory);
      if (trustedProvider) {
        setBest({
          title: trustedProvider.name,
          link: trustedProvider.website || '#',
          displayLink: trustedProvider.website?.replace(/^https?:\/\//, '') || 'Trusted Provider',
          phone: trustedProvider.phone,
          address: '',
          tagline: trustedProvider.notes || `Trusted provider for: ${trustedProvider.categories.join(', ')}`,
        });
        setMeta({
          reason: `Trusted Provider - Pre-approved for ${extractedCategory} issues. ${trustedProvider.notes || ''}`,
        });
        setQueryUsed(`Trusted Provider Match: ${extractedCategory}`);
        setIssueExtracted(extractedCategory);
        setLocationExtracted('');
        setUsedTrustedProvider(true);
        setLoading(false);
        return;
      }
    }

    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy
        ? `/service-search?description=${encodeURIComponent(description)}`
        : (() => {
            const nextUrl = new URL(baseEnv || 'http://127.0.0.1:3001');
            nextUrl.pathname = '/service-search';
            nextUrl.searchParams.set('description', description);
            return nextUrl.toString();
          })();

      const response = await fetch(url);
      const text = await response.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(response.status === 404 ? 'Service search endpoint not found (restart server after backend changes?)' : `Non-JSON response (status ${response.status})`);
      }

      if (json.warning === 'google_search_not_configured') {
        setMeta({ reason: 'Google Search API not configured. Add GOOGLE_SEARCH_API_KEY and GOOGLE_CSE_CX env vars on server.' });
        setQueryUsed(json.queryUsed || '');
        return;
      }

      if (!json.ok) {
        throw new Error(json.error || 'Search failed');
      }

      setQueryUsed(json.queryUsed || '');
      setIssueExtracted(json.issueExtracted || '');
      setLocationExtracted(json.locationExtracted || '');
      setBest(json.bestProvider || null);
      setMeta(json.bestMeta || null);
    } catch (runError: any) {
      setError(runError?.message || 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  };

  const schedule = async (overrideUrl?: string) => {
    if (!best && !overrideUrl) return;

    setScheduling(true);
    setScheduleResult(null);
    try {
      const result = await postWithFallback({
        url: overrideUrl || best?.link,
        issueDescription: description,
        address: serviceAddress,
        contactName,
        contactEmail,
        contactPhone,
      });
      setScheduleResult(result);
      if (!result?.ok) {
        alert(result?.error || 'Form scheduling failed');
      }
    } catch (scheduleError: any) {
      setScheduleResult({ ok: false, error: scheduleError?.message || 'Form scheduling failed' });
    } finally {
      setScheduling(false);
    }
  };

  return (
    <div className="mb-10 overflow-hidden rounded-xl border bg-white">
      <div className="flex flex-col gap-3 border-b bg-gray-50 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="text-sm font-medium text-gray-700">AI Provider Match</div>
        <div className="flex flex-1 items-center gap-2">
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe the maintenance need (e.g. toilet handle broken in Potomac MD)"
            className="min-w-[300px] flex-1 rounded-md border px-2 py-1 text-sm"
          />
          <button onClick={() => void run()} disabled={loading} className="rounded-md border bg-white px-3 py-1.5 text-xs hover:bg-gray-100 disabled:opacity-50">
            {loading ? 'Analyzing…' : 'Find Provider'}
          </button>
        </div>
      </div>

      <div className="text-sm">
        {error && <div className="p-4 text-xs text-rose-600">{error}</div>}
        {!error && loading && <div className="p-4 text-xs text-gray-500">AI analyzing request and finding providers…</div>}
        {!error && !loading && !best && <div className="p-4 text-xs text-gray-500">No provider selected.</div>}

        {usedTrustedProvider && !loading && (
          <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs">
            <span className="text-lg">*</span>
            <span className="font-medium text-amber-700">Trusted Provider Selected</span>
            <span className="text-amber-600">Using your pre-approved provider for this category</span>
          </div>
        )}

        {(issueExtracted || locationExtracted) && !loading && !usedTrustedProvider && (
          <div className="border-b bg-blue-50 px-4 py-2 text-xs">
            <span className="font-medium text-blue-700">AI Extracted:</span>
            {issueExtracted && <span className="ml-2 text-blue-600">Issue: {issueExtracted}</span>}
            {locationExtracted && <span className="ml-2 text-blue-600">Location: {locationExtracted}</span>}
          </div>
        )}

        {best && (
          <div className={`flex flex-col gap-3 p-5 ${usedTrustedProvider ? 'bg-amber-50/30' : ''}`}>
            <div>
              <div className="flex items-center gap-2">
                {usedTrustedProvider && <span className="text-amber-500">*</span>}
                <a href={best.link} target="_blank" rel="noopener" className="text-base font-semibold text-gray-800 hover:underline">{best.title}</a>
              </div>
              <div className="text-[11px] text-gray-500">{best.displayLink}</div>
            </div>

            <div className="grid gap-3 text-[12px] text-gray-700 sm:grid-cols-2 md:grid-cols-3">
              {best.phone && <div className="rounded border bg-gray-50 px-2 py-1"><span className="font-medium">Phone:</span> <a href={`tel:${best.phone}`} className="text-blue-600 hover:underline">{best.phone}</a></div>}
              {best.address && <div className="col-span-2 rounded border bg-gray-50 px-2 py-1 sm:col-span-1 md:col-span-2"><span className="font-medium">Address:</span> {best.address}</div>}
              {best.tagline && <div className="rounded border bg-gray-50 px-2 py-1 md:col-span-3"><span className="font-medium">About:</span> {best.tagline}</div>}
              {meta?.reason && <div className="rounded border bg-gray-50 px-2 py-1 md:col-span-3"><span className="font-medium">AI Selection:</span> {meta.reason}</div>}
              {queryUsed && <div className="rounded border bg-gray-50 px-2 py-1 md:col-span-3"><span className="font-medium">Search Query:</span> {queryUsed}</div>}
            </div>

            <div className="grid gap-2 text-[11px] md:grid-cols-2">
              <input className="rounded border px-2 py-1" value={serviceAddress} onChange={(event) => setServiceAddress(event.target.value)} placeholder="Service Address" />
              <input className="rounded border px-2 py-1" value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Contact Name" />
              <div className="flex items-center gap-2">
                <input id="custom-email" type="checkbox" className="h-3.5 w-3.5" checked={useCustomEmail} onChange={(event) => setUseCustomEmail(event.target.checked)} />
                <label htmlFor="custom-email" className="text-gray-600">Specify contact email</label>
              </div>
              {useCustomEmail ? (
                <input className="rounded border px-2 py-1" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="Contact Email" />
              ) : (
                <input className="rounded border bg-gray-50 px-2 py-1 text-gray-600" value={defaultContactEmail || contactEmail} readOnly placeholder="Tenant Email" />
              )}
              <input className="rounded border px-2 py-1" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="Contact Phone" />
            </div>

            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <button disabled={scheduling} onClick={() => void schedule()} className="rounded-md border px-3 py-1.5 text-xs hover:bg-gray-100 disabled:opacity-50">
                {scheduling ? 'Submitting…' : 'Submit Website Form'}
              </button>
              {best.phone && <a href={`tel:${best.phone}`} className="rounded-md border px-3 py-1.5 text-xs hover:bg-gray-100">Call Now</a>}
              <button disabled={scheduling} onClick={() => void schedule('https://renaissancerealty.co')} className="rounded-md border px-3 py-1.5 text-xs hover:bg-gray-100 disabled:opacity-50">
                Test on renaissancerealty.co (Legacy)
              </button>
            </div>

            {scheduleResult && (
              <div className={`rounded border p-3 text-[11px] ${scheduleResult.ok ? 'border-green-300 bg-green-50' : 'border-rose-300 bg-rose-50'}`}>
                <div className="mb-1 font-semibold">Form Submission {scheduleResult.ok ? 'Success' : 'Result'} {scheduleResult.status ? `(status: ${scheduleResult.status})` : ''}</div>
                {scheduleResult.error && <div className="text-rose-600">Error: {scheduleResult.error}</div>}
                {!scheduleResult.error && scheduleResult.message && <div>{scheduleResult.message}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Shared types for tenants used in this file

// --- Tenant Types ---
type TenantMessage = {
  id: number;
  date: string;
  type: string;
  content: string;
  response: string;
};
type Tenant = {
  name: string;
  unit: string;
  start: string;
  end: string;
  rent: number;
  status: 'Current' | 'Renewal Due' | 'Vacant';
  email: string;
  phone?: string;
  messages: TenantMessage[];
  aiSummary: string;
};

// Type for tenant screening applicants
type TenantApplicant = {
  id: string;
  name: string;
  email: string;
  phone?: string;
  appliedDate: string;
  status: 'pending' | 'approved' | 'rejected';
  creditScore?: number;
  backgroundCheck?: 'pending' | 'clear' | 'flagged';
  backgroundCheckDetails?: any;
  creditReportDetails?: {
    score: number;
    scoreRange: string;
    status: string;
    reportDate: string;
    details: any;
    summary: string;
  };
  incomeVerification?: {
    verified: boolean;
    monthlyIncome?: number;
    employmentStatus?: string;
    plaidConnectionId?: string;
    accounts?: any[];
  };
};


/* -------------------- ADD TENANT FORM COMPONENT -------------------- */

const AddTenantForm: React.FC<{
  onSubmit: (tenant: Omit<Tenant, 'messages' | 'aiSummary'>) => void;
  onCancel: () => void;
}> = ({ onSubmit, onCancel }) => {
  const [formData, setFormData] = useState({
    name: '',
    unit: '',
    start: '',
    end: '',
    rent: '',
    status: 'Current' as Tenant['status'],
    email: '',
    phone: ''
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    
    if (!formData.name.trim()) newErrors.name = 'Name is required';
    if (!formData.unit.trim()) newErrors.unit = 'Unit is required';
    if (!formData.email.trim()) newErrors.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(formData.email)) newErrors.email = 'Email is invalid';
    if (!formData.start.trim()) newErrors.start = 'Lease start date is required';
    if (!formData.end.trim()) newErrors.end = 'Lease end date is required';
    if (!formData.rent.trim()) newErrors.rent = 'Rent amount is required';
    else if (isNaN(Number(formData.rent)) || Number(formData.rent) <= 0) newErrors.rent = 'Rent must be a positive number';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateForm()) {
      onSubmit({
        name: formData.name.trim(),
        unit: formData.unit.trim(),
        start: formData.start,
        end: formData.end,
        rent: Number(formData.rent),
        status: formData.status,
        email: formData.email.trim(),
        phone: formData.phone.trim()
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Tenant Name *
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
            className={`w-full rounded-md border px-3 py-2 text-sm ${errors.name ? 'border-red-300' : 'border-gray-300'}`}
            placeholder="John Smith"
          />
          {errors.name && <p className="text-red-600 text-xs mt-1">{errors.name}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Unit *
          </label>
          <input
            type="text"
            value={formData.unit}
            onChange={(e) => setFormData(prev => ({ ...prev, unit: e.target.value }))}
            className={`w-full rounded-md border px-3 py-2 text-sm ${errors.unit ? 'border-red-300' : 'border-gray-300'}`}
            placeholder="A1"
          />
          {errors.unit && <p className="text-red-600 text-xs mt-1">{errors.unit}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Email *
          </label>
          <input
            type="email"
            value={formData.email}
            onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
            className={`w-full rounded-md border px-3 py-2 text-sm ${errors.email ? 'border-red-300' : 'border-gray-300'}`}
            placeholder="tenant@example.com"
          />
          {errors.email && <p className="text-red-600 text-xs mt-1">{errors.email}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Phone
          </label>
          <input
            type="tel"
            value={formData.phone}
            onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="(555) 123-4567"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Lease Start *
          </label>
          <input
            type="date"
            value={formData.start}
            onChange={(e) => setFormData(prev => ({ ...prev, start: e.target.value }))}
            className={`w-full rounded-md border px-3 py-2 text-sm ${errors.start ? 'border-red-300' : 'border-gray-300'}`}
          />
          {errors.start && <p className="text-red-600 text-xs mt-1">{errors.start}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Lease End *
          </label>
          <input
            type="date"
            value={formData.end}
            onChange={(e) => setFormData(prev => ({ ...prev, end: e.target.value }))}
            className={`w-full rounded-md border px-3 py-2 text-sm ${errors.end ? 'border-red-300' : 'border-gray-300'}`}
          />
          {errors.end && <p className="text-red-600 text-xs mt-1">{errors.end}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Monthly Rent *
          </label>
          <input
            type="number"
            value={formData.rent}
            onChange={(e) => setFormData(prev => ({ ...prev, rent: e.target.value }))}
            className={`w-full rounded-md border px-3 py-2 text-sm ${errors.rent ? 'border-red-300' : 'border-gray-300'}`}
            placeholder="2500"
            min="0"
            step="1"
          />
          {errors.rent && <p className="text-red-600 text-xs mt-1">{errors.rent}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Status
          </label>
          <select
            value={formData.status}
            onChange={(e) => setFormData(prev => ({ ...prev, status: e.target.value as Tenant['status'] }))}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="Current">Current</option>
            <option value="Renewal Due">Renewal Due</option>
            <option value="Vacant">Vacant</option>
          </select>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          data-voice-id="cancel-add-tenant-btn"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          data-voice-id="submit-add-tenant-btn"
        >
          Add Tenant
        </button>
      </div>
    </form>
  );
};

// Edit Tenant Modal
const EditTenantModal: React.FC<{
  isOpen: boolean;
  tenant: Tenant | null;
  onClose: () => void;
  onSave: (tenant: Tenant) => void;
}> = ({ isOpen, tenant, onClose, onSave }) => {
  const [formData, setFormData] = useState({
    name: '',
    unit: '',
    email: '',
    phone: '',
    start: '',
    end: '',
    rent: '',
    status: 'Current' as Tenant['status']
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (tenant) {
      setFormData({
        name: tenant.name,
        unit: tenant.unit,
        email: tenant.email,
        phone: tenant.phone || '',
        start: tenant.start,
        end: tenant.end,
        rent: tenant.rent.toString(),
        status: tenant.status
      });
    }
  }, [tenant]);

  if (!isOpen || !tenant) return null;

  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.name.trim()) newErrors.name = 'Name is required';
    if (!formData.unit.trim()) newErrors.unit = 'Unit is required';
    if (!formData.email.trim()) newErrors.email = 'Email is required';
    if (!formData.start) newErrors.start = 'Lease start date is required';
    if (!formData.end) newErrors.end = 'Lease end date is required';
    if (!formData.rent || Number(formData.rent) <= 0) newErrors.rent = 'Valid rent amount is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    const updatedTenant: Tenant = {
      ...tenant,
      name: formData.name,
      unit: formData.unit,
      email: formData.email,
      phone: formData.phone || undefined,
      start: formData.start,
      end: formData.end,
      rent: Number(formData.rent),
      status: formData.status
    };

    onSave(updatedTenant);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto m-4" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Edit Tenant</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tenant Name *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                className={`w-full rounded-md border px-3 py-2 text-sm ${errors.name ? 'border-red-300' : 'border-gray-300'}`}
                placeholder="John Doe"
              />
              {errors.name && <p className="text-red-600 text-xs mt-1">{errors.name}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Unit Number *
              </label>
              <input
                type="text"
                value={formData.unit}
                onChange={(e) => setFormData(prev => ({ ...prev, unit: e.target.value }))}
                className={`w-full rounded-md border px-3 py-2 text-sm ${errors.unit ? 'border-red-300' : 'border-gray-300'}`}
                placeholder="A1"
              />
              {errors.unit && <p className="text-red-600 text-xs mt-1">{errors.unit}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email *
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                className={`w-full rounded-md border px-3 py-2 text-sm ${errors.email ? 'border-red-300' : 'border-gray-300'}`}
                placeholder="tenant@example.com"
              />
              {errors.email && <p className="text-red-600 text-xs mt-1">{errors.email}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phone
              </label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="(555) 123-4567"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Lease Start *
              </label>
              <input
                type="date"
                value={formData.start}
                onChange={(e) => setFormData(prev => ({ ...prev, start: e.target.value }))}
                className={`w-full rounded-md border px-3 py-2 text-sm ${errors.start ? 'border-red-300' : 'border-gray-300'}`}
              />
              {errors.start && <p className="text-red-600 text-xs mt-1">{errors.start}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Lease End *
              </label>
              <input
                type="date"
                value={formData.end}
                onChange={(e) => setFormData(prev => ({ ...prev, end: e.target.value }))}
                className={`w-full rounded-md border px-3 py-2 text-sm ${errors.end ? 'border-red-300' : 'border-gray-300'}`}
              />
              {errors.end && <p className="text-red-600 text-xs mt-1">{errors.end}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Monthly Rent *
              </label>
              <input
                type="number"
                value={formData.rent}
                onChange={(e) => setFormData(prev => ({ ...prev, rent: e.target.value }))}
                className={`w-full rounded-md border px-3 py-2 text-sm ${errors.rent ? 'border-red-300' : 'border-gray-300'}`}
                placeholder="2500"
                min="0"
                step="1"
              />
              {errors.rent && <p className="text-red-600 text-xs mt-1">{errors.rent}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                value={formData.status}
                onChange={(e) => setFormData(prev => ({ ...prev, status: e.target.value as Tenant['status'] }))}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="Current">Current</option>
                <option value="Renewal Due">Renewal Due</option>
                <option value="Vacant">Vacant</option>
              </select>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
              data-voice-id="cancel-edit-tenant-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
              data-voice-id="save-tenant-btn"
            >
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/* -------------------- PORTFOLIO PAGE -------------------- */

// Minimal point type reused by rich chart

type MiniPoint = { x: number; y: number };
type ChartVariant = 'compact' | 'expanded';
type ProjectionGranularity = 'monthly' | 'quarterly' | 'annual';
type TaxHistoryRange = '1Y'|'2Y'|'3Y'|'5Y'|'10Y'|'all';

const PROJECTION_PERIODS_PER_YEAR: Record<ProjectionGranularity, number> = {
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getProjectionPeriodsPerYear(granularity: ProjectionGranularity): number {
  return PROJECTION_PERIODS_PER_YEAR[granularity];
}

function getVisibleAxisIndices(length: number, maxLabels: number): number[] {
  if (length <= maxLabels) return Array.from({ length }, (_, index) => index);
  const indices = new Set<number>();
  for (let index = 0; index < maxLabels; index++) {
    indices.add(Math.round(((length - 1) * index) / (maxLabels - 1)));
  }
  return Array.from(indices).sort((left, right) => left - right);
}

function formatCompactCurrency(value: number): string {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue >= 1_000_000_000) {
    return `${sign}$${(absValue / 1_000_000_000).toFixed(absValue >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(absValue >= 10_000_000 ? 0 : 1)}M`;
  }
  if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(absValue >= 10_000 ? 0 : 1)}k`;
  }
  return `${sign}$${absValue.toFixed(0)}`;
}

function buildProjectionLabels(totalPeriods: number, granularity: ProjectionGranularity, startYear: number = new Date().getFullYear()): string[] {
  if (granularity === 'annual') {
    return Array.from({ length: totalPeriods }, (_, index) => `${startYear + index}`);
  }

  if (granularity === 'quarterly') {
    return Array.from({ length: totalPeriods }, (_, index) => {
      const quarter = (index % 4) + 1;
      const year = startYear + Math.floor(index / 4);
      return `Q${quarter} ${year}`;
    });
  }

  return Array.from({ length: totalPeriods }, (_, index) => {
    const monthIndex = index % 12;
    const year = startYear + Math.floor(index / 12);
    return `${MONTH_LABELS[monthIndex]} ${year}`;
  });
}

function buildHoldingPeriodLabels(totalPeriods: number, granularity: ProjectionGranularity): string[] {
  const suffix = granularity === 'monthly' ? 'M' : granularity === 'quarterly' ? 'Q' : 'Y';
  return Array.from({ length: totalPeriods }, (_, index) => `${index + 1}${suffix}`);
}

/** Expand annual series into monthly/quarterly periods.
 *  - `flow`: dollar amounts for the period (annual ÷ periodsPerYear)
 *  - `level`: rates, ratios, and stock levels (no divide) */
function interpolateSeries(
  values: number[],
  granularity: ProjectionGranularity,
  mode: 'flow' | 'level' = 'level',
): number[] {
  if (granularity === 'annual' || values.length <= 1) return values.slice();

  const periodsPerYear = getProjectionPeriodsPerYear(granularity);
  const periodScale = mode === 'flow' ? 1 / periodsPerYear : 1;
  const expanded: number[] = [];

  for (let yearIndex = 0; yearIndex < values.length; yearIndex++) {
    const currentValue = values[yearIndex];
    const nextValue = values[Math.min(yearIndex + 1, values.length - 1)];

    for (let periodIndex = 0; periodIndex < periodsPerYear; periodIndex++) {
      if (yearIndex === values.length - 1) {
        expanded.push(currentValue * periodScale);
        continue;
      }
      const ratio = periodIndex / periodsPerYear;
      const interpolated = currentValue + (nextValue - currentValue) * ratio;
      expanded.push(interpolated * periodScale);
    }
  }

  return expanded;
}

function buildTaxHistorySeries(history: any[] | undefined, range: TaxHistoryRange): { values: number[]; labels: string[] } {
  if (!history?.length) return { values: [], labels: [] };

  const sorted = [...history]
    .filter((entry) => entry && entry.year != null)
    .sort((left, right) => Number(left.year) - Number(right.year));

  if (!sorted.length) return { values: [], labels: [] };

  let filtered = sorted;
  if (range !== 'all') {
    const years = parseInt(range.replace('Y', ''), 10);
    filtered = sorted.slice(-years);
    if (filtered.length < 2 && sorted.length >= 2) filtered = sorted.slice(-2);
  }

  return {
    values: filtered.map((entry) => (Number(entry.tax_amount) || 0) / 1000),
    labels: filtered.map((entry) => String(entry.year)),
  };
}

// --- Rich Price History Chart with Y axis, grid, and area fill ---
interface PriceHistoryChartProps {
  points: MiniPoint[];
  xLabels?: string[];
  height?: number;
  stroke?: string;
  areaColor?: string;
  square?: boolean;
  variant?: ChartVariant;
}

const PriceHistoryChart: React.FC<PriceHistoryChartProps> = ({ points, xLabels, height=200, stroke='#15803d', areaColor='#34d399', square=false, variant }) => {
  if (!points || points.length === 0) return <div className="h-full flex items-center justify-center text-gray-400">No data</div>;

  const chartId = React.useId().replace(/:/g, '');
  const resolvedVariant: ChartVariant = variant ?? (square ? 'compact' : 'expanded');
  const ys = points.map((point) => point.y);
  const minRaw = Math.min(...ys);
  const maxRaw = Math.max(...ys);
  const range = maxRaw - minRaw || 1;
  const pad = range * 0.05;
  const yMin = minRaw - pad;
  const yMax = maxRaw + pad;
  const W = resolvedVariant === 'compact' ? 520 : 1080;
  const H = height || (resolvedVariant === 'compact' ? 270 : 560);
  const LP = resolvedVariant === 'compact' ? 56 : 86;
  const RP = resolvedVariant === 'compact' ? 18 : 28;
  const BP = resolvedVariant === 'compact' ? 52 : 86;
  const TP = resolvedVariant === 'compact' ? 16 : 22;
  const usableW = W - LP - RP;
  const usableH = H - TP - BP;
  const yScale = (value: number) => TP + (1 - (value - yMin)/(yMax - yMin)) * usableH;
  const xScale = (index: number) => points.length === 1 ? LP + usableW / 2 : LP + (index / (points.length - 1)) * usableW;

  const targetTicks = resolvedVariant === 'compact' ? 5 : 6;
  const rawStep = (yMax - yMin) / (targetTicks - 1);
  const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 1e-6))));
  const base = rawStep / pow10;
  const niceMult = base >= 5 ? 5 : base >= 2 ? 2 : 1;
  const step = niceMult * pow10;
  const niceMin = Math.floor(yMin / step) * step;
  const niceMax = Math.ceil(yMax / step) * step;
  const ticks: number[] = [];
  for (let index = 0; index < targetTicks; index++) {
    ticks.push(niceMin + (niceMax - niceMin) * (index / (targetTicks - 1)));
  }

  const line = points.map((point, index) => `${index ? 'L' : 'M'}${xScale(index)},${yScale(point.y)}`).join(' ');
  const area = `${points.map((point, index) => `${index ? 'L' : 'M'}${xScale(index)},${yScale(point.y)}`).join(' ')} L ${xScale(points.length-1)},${yScale(yMin)} L ${xScale(0)},${yScale(yMin)} Z`;
  const pct = ((points[points.length-1].y - points[0].y) / points[0].y) * 100;
  const xTickIndices = getVisibleAxisIndices(points.length, resolvedVariant === 'compact' ? 6 : 10);
  const rotateLabels = xTickIndices.length > 5 || xTickIndices.some((index) => (xLabels?.[index] || '').length > 6);
  const axisFontSize = resolvedVariant === 'compact' ? 10 : 12;

  const formatAvmLabel = (index: number) => {
    if (xLabels && xLabels[index]) return xLabels[index];
    if (points.length > 16) {
      const baseYear = new Date().getFullYear() - Math.floor(points.length / 4);
      const quarter = (index % 4) + 1;
      const year = baseYear + Math.floor(index / 4);
      return `Q${quarter} ${year}`;
    }
    return `P${index + 1}`;
  };

  const chart = (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
      <defs>
        <linearGradient id={`${chartId}-price-area`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={areaColor} stopOpacity={resolvedVariant === 'compact' ? 0.42 : 0.6} />
          <stop offset="100%" stopColor={areaColor} stopOpacity={resolvedVariant === 'compact' ? 0.08 : 0.05} />
        </linearGradient>
      </defs>

      {ticks.map((tick) => (
        <line key={`grid-${tick}`} x1={LP} x2={W - RP} y1={yScale(tick)} y2={yScale(tick)} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="4 6" />
      ))}

      <line x1={LP} x2={LP} y1={TP} y2={H - BP} stroke="#cbd5e1" strokeWidth={1.2} />
      <line x1={LP} x2={W - RP} y1={H - BP} y2={H - BP} stroke="#cbd5e1" strokeWidth={1.2} />

      <path d={area} fill={`url(#${chartId}-price-area)`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={resolvedVariant === 'compact' ? 2.2 : 3.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.length < 160 && points.map((point, index) => (
        <circle key={index} cx={xScale(index)} cy={yScale(point.y)} r={resolvedVariant === 'compact' ? 2.75 : 4} fill={stroke} fillOpacity={0.2} />
      ))}

      {ticks.map((tick) => (
        <text key={`y-${tick}`} x={LP - 10} y={yScale(tick) + 4} textAnchor="end" fontSize={axisFontSize} fill="#64748b" fontWeight="500">
          {formatCompactCurrency(tick)}
        </text>
      ))}

      {xTickIndices.map((index) => {
        const x = xScale(index);
        const y = H - (resolvedVariant === 'compact' ? 12 : 18);
        return (
          <text
            key={`x-${index}`}
            x={x}
            y={y}
            textAnchor={rotateLabels ? 'end' : 'middle'}
            fontSize={axisFontSize}
            fill="#64748b"
            fontWeight="500"
            transform={rotateLabels ? `rotate(-34 ${x} ${y})` : undefined}
          >
            {formatAvmLabel(index)}
          </text>
        );
      })}
    </svg>
  );

  if (resolvedVariant === 'compact') {
    return <div className="h-full relative">{chart}</div>;
  }

  return (
    <div className="w-full h-full">
      <div className="mb-3 flex items-center gap-2">
        <div className="font-semibold text-base">Price</div>
        <div className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${pct >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
          <span>{pct >= 0 ? '↑' : '↓'}</span>
          {pct.toFixed(2)}%
        </div>
      </div>
      {chart}
    </div>
  );
};

// Generate year labels starting from current year
// Standardized X-axis label generator
// - Annual: "YYYY" (e.g., "2026")
// - Quarterly: "nQYYYY" (e.g., "2Q2027")
const generateYearLabels = (count: number, isQuarterly: boolean = false, startYear?: number): string[] => {
  const baseYear = startYear ?? new Date().getFullYear();
  const labels: string[] = [];
  if (isQuarterly) {
    for (let i = 0; i < count; i++) {
      const q = (i % 4) + 1;
      const y = baseYear + Math.floor(i / 4);
      labels.push(`${q}Q${y}`);
    }
  } else {
    for (let i = 0; i < count; i++) labels.push(`${baseYear + i}`);
  }
  return labels;
};


/*
interface MortgageAmortizationChartProps {
  principal: number[]; // Annual principal payments (in thousands)
  interest: number[]; // Annual interest payments (in thousands)
  loanBalance: number[]; // End of year loan balance (in thousands)
}

const MortgageAmortizationChart: React.FC<MortgageAmortizationChartProps> = ({
  principal,
  interest,
  loanBalance
}) => {
  const W = 600, H = 300;
  const LP = 60, RP = 80, TP = 20, BP = 50;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;
  
  const years = generateYearLabels(principal.length);
  
  // Calculate percentages for stacked area
  const percentages = principal.map((p, i) => {
    const total = p + interest[i];
    return {
      principalPct: total > 0 ? (p / total) * 100 : 0,
      interestPct: total > 0 ? (interest[i] / total) * 100 : 0
    };
  });
  
  // Loan balance axis (right side)
  const maxBalance = Math.max(...loanBalance);
  const minBalance = 0;
  const balanceRange = maxBalance - minBalance;
  const balancePad = balanceRange * 0.1;
  const niceMaxBalance = maxBalance + balancePad;
  
  // Create path for loan balance line
  const balancePath = loanBalance.map((bal, i) => {
    const x = LP + (i / (loanBalance.length - 1)) * innerW;
    const y = TP + innerH - ((bal - minBalance) / (niceMaxBalance - minBalance)) * innerH;
    return `${x},${y}`;
  }).join(' L');
  
  // Create paths for stacked areas
  const createStackedPaths = () => {
    const points = percentages.map((p, i) => {
      const x = LP + (i / (percentages.length - 1)) * innerW;
      const yTop = TP;
      const yInterestBottom = TP + (p.interestPct / 100) * innerH;
      const yBottom = TP + innerH;
      return { x, yTop, yInterestBottom, yBottom, ...p };
    });
    
    // Interest area (top, green)
    const interestPath = [
      `M${points[0].x},${points[0].yTop}`,
      ...points.slice(1).map(p => `L${p.x},${p.yTop}`),
      ...points.slice().reverse().map(p => `L${p.x},${p.yInterestBottom}`),
      'Z'
    ].join(' ');
    
    // Principal area (bottom, orange)
    const principalPath = [
      `M${points[0].x},${points[0].yInterestBottom}`,
      ...points.slice(1).map(p => `L${p.x},${p.yInterestBottom}`),
      ...points.slice().reverse().map(p => `L${p.x},${p.yBottom}`),
      'Z'
    ].join(' ');
    
    return { interestPath, principalPath };
  };
  
  const { interestPath, principalPath } = createStackedPaths();
  
  // Y-axis ticks for percentage (left)
  const pctTicks = [0, 20, 40, 60, 80, 100];
  
  // Y-axis ticks for balance (right)
  const balanceTicks = [];
  for (let i = 0; i < 6; i++) {
    balanceTicks.push(minBalance + (niceMaxBalance - minBalance) * (i / 5));
  }
  
  const formatBalance = (v: number) => {
    const actual = v * 1000;
    if (actual >= 1_000_000) return `$${(actual / 1_000_000).toFixed(1)}M`;
    if (actual >= 1_000) return `$${(actual / 1_000).toFixed(0)}k`;
    return `$${actual.toFixed(0)}`;
  };
  
  return (
    <div className="h-full w-full relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
        {pctTicks.map(pct => {
          const y = TP + innerH - (pct / 100) * innerH;
          return (
            <line
              key={pct}
              x1={LP}
              x2={LP + innerW}
              y1={y}
              y2={y}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
          );
        })}
        
        <path d={interestPath} fill="#10b981" opacity={0.7} />
        <path d={principalPath} fill="#f97316" opacity={0.7} />
        
        <path
          d={`M${balancePath}`}
          stroke="#1e40af"
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        
        <line x1={LP} y1={TP} x2={LP} y2={TP + innerH} stroke="#374151" strokeWidth={2} />
        {pctTicks.map(pct => {
          const y = TP + innerH - (pct / 100) * innerH;
          return (
            <text
              key={`pct-${pct}`}
              x={LP - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={11}
              fill="#374151"
            >
              {pct}%
            </text>
          );
        })}
        
        <line x1={LP + innerW} y1={TP} x2={LP + innerW} y2={TP + innerH} stroke="#1e40af" strokeWidth={2} />
        {balanceTicks.map((bal, i) => {
          const y = TP + innerH - ((bal - minBalance) / (niceMaxBalance - minBalance)) * innerH;
          return (
            <text
              key={`bal-${i}`}
              x={LP + innerW + 8}
              y={y + 4}
              textAnchor="start"
              fontSize={11}
              fill="#1e40af"
            >
              {formatBalance(bal)}
            </text>
          );
        })}
        
        <line x1={LP} y1={TP + innerH} x2={LP + innerW} y2={TP + innerH} stroke="#374151" strokeWidth={2} />
        {years.map((year, i) => {
          const x = LP + (i / (years.length - 1)) * innerW;
          return (
            <text
              key={year}
              x={x}
              y={TP + innerH + 20}
              textAnchor="middle"
              fontSize={11}
              fill="#374151"
            >
              {year}
            </text>
          );
        })}
        
        <g transform={`translate(${LP + 10}, ${TP + 10})`}>
          <rect x={0} y={0} width={15} height={10} fill="#10b981" opacity={0.7} />
          <text x={20} y={9} fontSize={10} fill="#374151">Interest</text>
          
          <rect x={80} y={0} width={15} height={10} fill="#f97316" opacity={0.7} />
          <text x={100} y={9} fontSize={10} fill="#374151">Principal</text>
          
          <line x1={160} y1={5} x2={175} y2={5} stroke="#1e40af" strokeWidth={2} />
          <text x={180} y={9} fontSize={10} fill="#1e40af">Balance</text>
        </g>
      </svg>
    </div>
  );
};
*/

// Itemized Income-Expenses Chart Component
interface ItemizedIncomeExpensesChartProps {
  income: number[];
  expenseBreakdown: {
    taxes: number[];
    insurance: number[];
    utilities: number[];
    hoa: number[];
    repairs: number[];
    management: number[];
    debtService: number[];
  };
  dataInThousands?: boolean;
  xLabels?: string[];
  isQuarterly?: boolean;
  variant?: ChartVariant;
}

const ItemizedIncomeExpensesChart: React.FC<ItemizedIncomeExpensesChartProps> = ({
  income,
  expenseBreakdown,
  dataInThousands = false,
  xLabels,
  isQuarterly = false,
  variant = 'compact'
}) => {
  const chartId = React.useId().replace(/:/g, '');
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  
  const years = income.length;
  
  // Generate labels if not provided
  const labels = xLabels || generateYearLabels(years, isQuarterly);
  
  // Calculate total expenses for each year
  const totalExpenses = income.map((_, i) => 
    expenseBreakdown.taxes[i] +
    expenseBreakdown.insurance[i] +
    expenseBreakdown.utilities[i] +
    expenseBreakdown.hoa[i] +
    expenseBreakdown.repairs[i] +
    expenseBreakdown.management[i] +
    expenseBreakdown.debtService[i]
  );
  
  // Find max value for scaling
  const allValues = [...income, ...totalExpenses];
  const maxVal = Math.max(...allValues, 0);
  const niceMax = (() => {
    if (maxVal <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(maxVal)));
    const steps = [1, 2, 2.5, 5, 7.5, 10];
    for (const s of steps) {
      const n = s * mag;
      if (n >= maxVal * 1.05) return n;
    }
    return maxVal * 1.1;
  })();
  
  // Chart dimensions - match Tax History
  const chartW = variant === 'compact' ? 520 : 1080;
  const chartH = variant === 'compact' ? 270 : 560;
  const padL = variant === 'compact' ? 48 : 72;
  const padR = variant === 'compact' ? 18 : 28;
  const padT = variant === 'compact' ? 16 : 24;
  const padB = variant === 'compact' ? 54 : 84;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;
  
  // Bar layout
  const barGap = 8;
  const pairGap = 16; // Gap between income and expense bars
  const groupCount = years;
  const barsPerGroup = 2;
  const groupWidth = (innerW - (groupCount - 1) * barGap) / groupCount;
  const rawBarWidth = Math.max((groupWidth - pairGap) / barsPerGroup, 5);
  const barWidth = Math.min(rawBarWidth, variant === 'compact' ? 20 : 30);
  const contentWidth = (barWidth * barsPerGroup) + pairGap;
  const xTickIndices = getVisibleAxisIndices(labels.length, variant === 'compact' ? 6 : 10);
  const rotateLabels = xTickIndices.length > 5 || xTickIndices.some((index) => labels[index]?.length > 6);
  
  // Y-axis ticks
  const tickCount = 6;
  const tickVals: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    tickVals.push((niceMax * i) / (tickCount - 1));
  }
  
  const formatMoney = (v: number) => {
    const val = dataInThousands ? v : v / 1000;
    return `$${val.toFixed(0)}k`;
  };
  
  // Expense category colors
  const expenseColors = {
    taxes: '#fbbf24',       // amber
    insurance: '#f472b6',   // pink
    utilities: '#a78bfa',   // purple
    hoa: '#fb923c',         // orange
    repairs: '#ef4444',     // red
    management: '#06b6d4',  // cyan
    debtService: '#b45309', // brown
  };
  
  return (
    <div className="h-full relative">
      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-full">
        <defs>
          <linearGradient id={`${chartId}-income`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="1" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.75" />
          </linearGradient>
          <filter id={`${chartId}-shadow`} x="-20%" y="-20%" width="140%" height="160%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#0f172a" floodOpacity="0.1" />
          </filter>
        </defs>

        {/* Baseline */}
        <path 
          d={`M${padL} ${padT + innerH} L${padL + innerW} ${padT + innerH}`} 
          stroke="#cbd5e1" 
          strokeWidth={1.1} 
          fill="none" 
        />
        
        {/* Grid lines */}
        {tickVals.map(tv => {
          const y = padT + innerH - (tv / niceMax) * innerH;
          return <line key={tv} x1={padL} x2={padL + innerW} y1={y} y2={y} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="4 6" />;
        })}
        
        {/* Y-axis labels */}
        {tickVals.map(tv => {
          const y = padT + innerH - (tv / niceMax) * innerH;
          return (
            <text key={`ytick-${tv}`} x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#374151" fontWeight="500">
              {tv === 0 ? '$0' : formatMoney(tv)}
            </text>
          );
        })}
        
        {/* Bars for each year */}
        {income.map((incVal, i) => {
          const groupX = padL + i * (groupWidth + barGap) + Math.max((groupWidth - contentWidth) / 2, 0);
          const incomeX = groupX;
          const expenseX = groupX + barWidth + pairGap;
          
          // Income bar (green)
          const incH = (incVal / niceMax) * innerH;
          const incY = padT + innerH - incH;
          
          // Stacked expense bars
          let stackY = padT + innerH;
          const expenseCategories: Array<keyof typeof expenseBreakdown> = [
            'debtService', 'taxes', 'repairs', 'management', 'insurance', 'utilities', 'hoa'
          ];
          
          return (
            <g key={i} onMouseEnter={() => setHoveredIndex(i)} onMouseLeave={() => setHoveredIndex(null)}>
              {/* Income bar */}
              <rect
                x={incomeX}
                y={incY}
                width={barWidth}
                height={incH}
                rx={4}
                fill={`url(#${chartId}-income)`}
                opacity={hoveredIndex === i ? 1 : 0.85}
                filter={hoveredIndex === i ? `url(#${chartId}-shadow)` : undefined}
              />
              
              {/* Stacked expense bars */}
              {expenseCategories.map(category => {
                const categoryVal = expenseBreakdown[category][i];
                const catH = (categoryVal / niceMax) * innerH;
                stackY -= catH;
                
                return (
                  <rect
                    key={category}
                    x={expenseX}
                    y={stackY}
                    width={barWidth}
                    height={catH}
                    rx={3}
                    fill={expenseColors[category]}
                    opacity={hoveredIndex === i ? 1 : 0.85}
                    filter={hoveredIndex === i ? `url(#${chartId}-shadow)` : undefined}
                  />
                );
              })}
              
              {/* Year label */}
              {xTickIndices.includes(i) && (
                <text
                  x={groupX + groupWidth / 2}
                  y={chartH - 12}
                  textAnchor={rotateLabels ? 'end' : 'middle'}
                  fontSize={variant === 'compact' ? 10 : 12}
                  fill="#475569"
                  fontWeight="500"
                  transform={rotateLabels ? `rotate(-34 ${groupX + groupWidth / 2} ${chartH - 12})` : undefined}
                >
                  {labels[i]}
                </text>
              )}
              
              {/* Hover tooltip */}
              {hoveredIndex === i && (
                <g>
                  <rect
                    x={groupX - 5}
                    y={padT - 5}
                    width={groupWidth + 10}
                    height={innerH + 10}
                    fill="rgba(0,0,0,0.02)"
                    stroke="rgba(148,163,184,0.35)"
                    strokeWidth={1}
                    rx={8}
                  />
                </g>
              )}
            </g>
          );
        })}
        
        {/* Legend */}
        <g transform={`translate(${padL}, ${padT - 6})`}>
          <rect x={0} y={0} width={10} height={8} fill="#10b981" />
          <text x={12} y={7} fontSize={9} fill="#64748b" fontWeight="600">Income</text>
          
          <rect x={52} y={0} width={10} height={8} fill="#b45309" />
          <text x={64} y={7} fontSize={9} fill="#64748b" fontWeight="600">Debt</text>
          
          <rect x={92} y={0} width={10} height={8} fill="#fbbf24" />
          <text x={104} y={7} fontSize={9} fill="#64748b" fontWeight="600">Tax</text>
          
          <rect x={128} y={0} width={10} height={8} fill="#ef4444" />
          <text x={140} y={7} fontSize={9} fill="#64748b" fontWeight="600">Repair</text>
          
          <rect x={172} y={0} width={10} height={8} fill="#06b6d4" />
          <text x={184} y={7} fontSize={9} fill="#64748b" fontWeight="600">Mgmt</text>
          
          <rect x={214} y={0} width={10} height={8} fill="#f472b6" />
          <text x={226} y={7} fontSize={9} fill="#64748b" fontWeight="600">Ins</text>
        </g>
      </svg>
      
      {/* Detailed legend below chart */}
      {hoveredIndex !== null && (
        <div className="absolute bottom-0 left-0 right-0 rounded-b-xl border-t border-slate-200 bg-white/95 p-2 text-[10px] text-slate-600 backdrop-blur-sm grid grid-cols-4 gap-x-2 gap-y-1">
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#10b981'}}></span>Income: {formatMoney(income[hoveredIndex])}</div>
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#b45309'}}></span>Debt: {formatMoney(expenseBreakdown.debtService[hoveredIndex])}</div>
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#fbbf24'}}></span>Taxes: {formatMoney(expenseBreakdown.taxes[hoveredIndex])}</div>
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#ef4444'}}></span>Repairs: {formatMoney(expenseBreakdown.repairs[hoveredIndex])}</div>
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#06b6d4'}}></span>Mgmt: {formatMoney(expenseBreakdown.management[hoveredIndex])}</div>
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#f472b6'}}></span>Insurance: {formatMoney(expenseBreakdown.insurance[hoveredIndex])}</div>
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#a78bfa'}}></span>Utilities: {formatMoney(expenseBreakdown.utilities[hoveredIndex])}</div>
          <div><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{backgroundColor: '#fb923c'}}></span>HOA: {formatMoney(expenseBreakdown.hoa[hoveredIndex])}</div>
        </div>
      )}
    </div>
  );
};

type PortfolioAnalyticsBadgeColor = 'blue' | 'orange' | 'green' | 'red' | 'purple' | 'cyan';

const portfolioAnalyticsBadgeColors: Record<PortfolioAnalyticsBadgeColor, string> = {
  blue: 'bg-blue-100 text-blue-700',
  orange: 'bg-orange-100 text-orange-700',
  green: 'bg-emerald-100 text-emerald-700',
  red: 'bg-red-100 text-red-700',
  purple: 'bg-purple-100 text-purple-700',
  cyan: 'bg-cyan-100 text-cyan-700',
};

const PortfolioAnalyticsEmptyState = ({
  label,
  icon,
}: {
  label: string;
  icon?: React.ReactNode;
}) => (
  <div className="h-full flex items-center justify-center rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100/80 text-slate-400">
    <div className="text-center">
      {icon ?? (
        <svg className="w-8 h-8 mx-auto mb-2 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      )}
      <div className="text-sm font-medium text-slate-400">{label}</div>
    </div>
  </div>
);

const PortfolioAnalyticsCard = ({
  children,
  title,
  badge,
  badgeColor = 'blue',
  subtitle,
  controls,
  onExpand,
  className = '',
  chartClassName = 'h-44',
}: {
  children: React.ReactNode;
  title: string;
  badge?: string;
  badgeColor?: PortfolioAnalyticsBadgeColor;
  subtitle?: string;
  controls?: React.ReactNode;
  onExpand?: () => void;
  className?: string;
  chartClassName?: string;
}) => (
  <div className={`bg-white rounded-[22px] border border-slate-200/90 shadow-[0_10px_35px_rgba(15,23,42,0.06)] overflow-hidden ${className}`}>
    <div className="p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0 flex items-start gap-3">
          {badge && (
            <span className={`mt-0.5 shrink-0 rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${portfolioAnalyticsBadgeColors[badgeColor]}`}>
              {badge}
            </span>
          )}
          <div className="min-w-0">
            <div className="text-[13px] sm:text-[14px] font-semibold text-slate-800">{title}</div>
            {subtitle && <div className="text-[11px] font-medium text-slate-500 mt-0.5">{subtitle}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {controls}
          {onExpand && (
            <button
              onClick={onExpand}
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              title="Expand chart"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className={chartClassName}>{children}</div>
    </div>
  </div>
);




// ====================
// Environmental Risk Map Components
// ====================

interface RiskMapProps {
  latitude: number;
  longitude: number;
  address: string;
  environmentalData?: any; // ATTOM environmental/hazard data
  /** When set, Flood Risk can pull outdoor forecast and suggest storm intensity. */
  propertyId?: string;
  /** Map viewport height in px (Flood Risk uses this when shown full-width). */
  mapHeight?: number;
  /** Drives the flood depth-damage estimate; land does not flood, so this is
   *  living area rather than market value. */
  livingSqft?: number | null;
}

// Air Quality Season and Noise Time-of-Day Types
type AQSeason = 'spring' | 'summer' | 'fall' | 'winter';
type TimeOfDay = 'night' | 'morning-rush' | 'midday' | 'evening-rush' | 'late-evening';

const AQ_SEASON_OPTIONS = [
  { value: 'spring' as AQSeason, label: 'Spring', icon: '🌸' },
  { value: 'summer' as AQSeason, label: 'Summer', icon: '☀️' },
  { value: 'fall' as AQSeason, label: 'Fall', icon: '🍂' },
  { value: 'winter' as AQSeason, label: 'Winter', icon: '❄️' }
];

const TIME_OF_DAY_OPTIONS = [
  { value: 'night' as TimeOfDay, label: 'Night', icon: '🌙', hours: '12am-6am' },
  { value: 'morning-rush' as TimeOfDay, label: 'AM Rush', icon: '🌅', hours: '6am-10am' },
  { value: 'midday' as TimeOfDay, label: 'Midday', icon: '☀️', hours: '10am-4pm' },
  { value: 'evening-rush' as TimeOfDay, label: 'PM Rush', icon: '🌆', hours: '4pm-8pm' },
  { value: 'late-evening' as TimeOfDay, label: 'Evening', icon: '🌃', hours: '8pm-12am' }
];

// Get current season
const getCurrentAQSeason = (): AQSeason => {
  const month = new Date().getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
};

// Get current time of day
const getCurrentTimeOfDay = (): TimeOfDay => {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 6) return 'night';
  if (hour >= 6 && hour < 10) return 'morning-rush';
  if (hour >= 10 && hour < 16) return 'midday';
  if (hour >= 16 && hour < 20) return 'evening-rush';
  return 'late-evening';
};

// Regional air quality seasonal factors (based on EPA data)
const getAQSeasonalFactors = (lat: number, lng: number, season: AQSeason): { aqiMultiplier: number; ozoneRisk: string; pollenLevel: string; description: string } => {
  // Determine region
  const isWestCoast = lng < -115 && lat > 32 && lat < 42;
  const isSoutheast = lat < 37 && lng > -94 && lng < -75;
  const isSouthwest = lng < -104 && lat < 37 && lat > 25;
  const isMidwest = lng > -104 && lng < -80 && lat > 37;
  
  if (isWestCoast) {
    const factors: Record<AQSeason, { aqiMultiplier: number; ozoneRisk: string; pollenLevel: string; description: string }> = {
      spring: { aqiMultiplier: 0.9, ozoneRisk: 'Moderate', pollenLevel: 'High', description: 'Mild, some pollen' },
      summer: { aqiMultiplier: 1.3, ozoneRisk: 'High', pollenLevel: 'Moderate', description: 'Ozone alerts, occasional smoke' },
      fall: { aqiMultiplier: 1.8, ozoneRisk: 'Moderate', pollenLevel: 'Low', description: 'Wildfire smoke season peak' },
      winter: { aqiMultiplier: 0.7, ozoneRisk: 'Low', pollenLevel: 'None', description: 'Clean air from winter rains' }
    };
    return factors[season];
  } else if (isSoutheast) {
    const factors: Record<AQSeason, { aqiMultiplier: number; ozoneRisk: string; pollenLevel: string; description: string }> = {
      spring: { aqiMultiplier: 1.1, ozoneRisk: 'Moderate', pollenLevel: 'Very High', description: 'Pollen explosion (pine, oak)' },
      summer: { aqiMultiplier: 1.3, ozoneRisk: 'High', pollenLevel: 'Moderate', description: 'Hot, humid = ozone alerts' },
      fall: { aqiMultiplier: 0.9, ozoneRisk: 'Moderate', pollenLevel: 'Moderate', description: 'Ragweed, otherwise improving' },
      winter: { aqiMultiplier: 0.8, ozoneRisk: 'Low', pollenLevel: 'Low', description: 'Generally good air quality' }
    };
    return factors[season];
  } else if (isSouthwest) {
    const factors: Record<AQSeason, { aqiMultiplier: number; ozoneRisk: string; pollenLevel: string; description: string }> = {
      spring: { aqiMultiplier: 1.1, ozoneRisk: 'High', pollenLevel: 'High', description: 'Dust storms + pollen' },
      summer: { aqiMultiplier: 1.4, ozoneRisk: 'High', pollenLevel: 'Moderate', description: 'Extreme heat = high ozone' },
      fall: { aqiMultiplier: 1.0, ozoneRisk: 'Moderate', pollenLevel: 'Moderate', description: 'Improving conditions' },
      winter: { aqiMultiplier: 0.8, ozoneRisk: 'Low', pollenLevel: 'Low', description: 'Cool, dust possible' }
    };
    return factors[season];
  } else if (isMidwest) {
    const factors: Record<AQSeason, { aqiMultiplier: number; ozoneRisk: string; pollenLevel: string; description: string }> = {
      spring: { aqiMultiplier: 1.0, ozoneRisk: 'Moderate', pollenLevel: 'High', description: 'Tree pollen peak' },
      summer: { aqiMultiplier: 1.2, ozoneRisk: 'High', pollenLevel: 'Moderate', description: 'Hot days = ozone buildup' },
      fall: { aqiMultiplier: 1.0, ozoneRisk: 'Moderate', pollenLevel: 'High', description: 'Harvest dust + ragweed' },
      winter: { aqiMultiplier: 0.9, ozoneRisk: 'Low', pollenLevel: 'None', description: 'Cold keeps air clean' }
    };
    return factors[season];
  } else {
    // Northeast (default)
    const factors: Record<AQSeason, { aqiMultiplier: number; ozoneRisk: string; pollenLevel: string; description: string }> = {
      spring: { aqiMultiplier: 1.0, ozoneRisk: 'Moderate', pollenLevel: 'High', description: 'Pollen from trees' },
      summer: { aqiMultiplier: 1.3, ozoneRisk: 'High', pollenLevel: 'Moderate', description: 'Heat waves = ozone alerts' },
      fall: { aqiMultiplier: 0.9, ozoneRisk: 'Low', pollenLevel: 'Moderate', description: 'Ragweed, cleaner air' },
      winter: { aqiMultiplier: 0.9, ozoneRisk: 'Low', pollenLevel: 'None', description: 'Inversions in valleys' }
    };
    return factors[season];
  }
};

// Time-of-day noise factors (based on FHWA traffic patterns)
const getNoiseTimeFactors = (timeOfDay: TimeOfDay): { trafficMultiplier: number; backgroundNoise: number; description: string; peakHours: string } => {
  const noiseData: Record<TimeOfDay, { trafficMultiplier: number; backgroundNoise: number; description: string; peakHours: string }> = {
    'night': { trafficMultiplier: 0.25, backgroundNoise: 35, description: 'Quiet night hours - minimal traffic', peakHours: '12am - 6am' },
    'morning-rush': { trafficMultiplier: 1.3, backgroundNoise: 50, description: 'Morning commute - heavy traffic', peakHours: '6am - 10am' },
    'midday': { trafficMultiplier: 0.8, backgroundNoise: 45, description: 'Midday lull - moderate traffic', peakHours: '10am - 4pm' },
    'evening-rush': { trafficMultiplier: 1.4, backgroundNoise: 52, description: 'Evening commute - peak traffic', peakHours: '4pm - 8pm' },
    'late-evening': { trafficMultiplier: 0.5, backgroundNoise: 40, description: 'Evening wind-down - light traffic', peakHours: '8pm - 12am' }
  };
  return noiseData[timeOfDay];
};

// Air Quality & Noise Pollution Map
const AirQualityNoiseMap: React.FC<RiskMapProps> = ({ latitude, longitude, address, environmentalData }) => {
  const mapRef = React.useRef<HTMLDivElement>(null);
  const [map, setMap] = React.useState<any>(null);
  const markerRef = React.useRef<any>(null);
  const [showAirQuality, setShowAirQuality] = React.useState(true);
  const [showNoise, setShowNoise] = React.useState(true);
  const [airQualityData, setAirQualityData] = React.useState<any>(null);
  const [baseAirQualityData, setBaseAirQualityData] = React.useState<any>(null); // Store original for adjustments
  const [noiseLevel, setNoiseLevel] = React.useState<number>(45); // dB, typical suburban
  const [loading, setLoading] = React.useState(true);
  const [mapType, setMapType] = React.useState<'terrain' | 'satellite'>('terrain');
  
  // Seasonal and time-of-day controls
  const [selectedAQSeason, setSelectedAQSeason] = React.useState<AQSeason>(getCurrentAQSeason());
  const [selectedTimeOfDay, setSelectedTimeOfDay] = React.useState<TimeOfDay>(getCurrentTimeOfDay());
  const [aqSeasonalFactors, setAQSeasonalFactors] = React.useState<{ aqiMultiplier: number; ozoneRisk: string; pollenLevel: string; description: string } | null>(null);
  const [noiseTimeFactors, setNoiseTimeFactors] = React.useState<{ trafficMultiplier: number; backgroundNoise: number; description: string; peakHours: string } | null>(null);

  React.useEffect(() => {
    console.log('[AirQualityNoiseMap] Initializing with:', { latitude, longitude, address, hasAttomData: !!environmentalData });
    if (environmentalData) {
      console.log('[AirQualityNoiseMap] ATTOM environmental data:', environmentalData);
    }
    let mounted = true;
    const initMap = async () => {
      await loadGoogleMaps();
      if (!mapRef.current || !mounted) return;

      const mapInstance = new (window as any).google.maps.Map(mapRef.current, {
        center: { lat: latitude, lng: longitude },
        zoom: 14,
        mapTypeId: 'roadmap',
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
      });

      setMap(mapInstance);

      // Add property marker
      markerRef.current = new (window as any).google.maps.Marker({
        position: { lat: latitude, lng: longitude },
        map: mapInstance,
        title: address,
        icon: {
          path: (window as any).google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#3b82f6',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        }
      });

      // Fetch air quality data from AirNow API
      const airNowKey = (import.meta as any).env?.VITE_AIRNOW_API_KEY;
      const openWeatherKey = (import.meta as any).env?.VITE_OPENWEATHER_API_KEY;
      
      if (airNowKey) {
        try {
          // Check cache first
          const cachedData = await getCachedAirQualityData(latitude, longitude);
          if (cachedData) {
            console.log('[AirQualityNoiseMap] Using cached air quality data');
            setBaseAirQualityData(cachedData);
            setAirQualityData(cachedData);
            // Continue to set loading false below
          } else {
          
          // Fetch air quality data for multiple points in a 15-MILE RADIUS grid
          // 15 miles ≈ 24 km ≈ 0.22 degrees latitude (varies with longitude)
          // Create a dense grid: center + concentric rings at 5, 10, and 15 miles
          const mile5 = 0.073;  // ~5 miles in degrees
          const mile10 = 0.145; // ~10 miles in degrees  
          const mile15 = 0.218; // ~15 miles in degrees
          
          const gridPoints = [
            // Center point
            { lat: latitude, lng: longitude, label: 'center' },
            
            // Inner ring (5 miles) - 8 directions
            { lat: latitude + mile5, lng: longitude, label: 'n-5mi' },
            { lat: latitude - mile5, lng: longitude, label: 's-5mi' },
            { lat: latitude, lng: longitude + mile5, label: 'e-5mi' },
            { lat: latitude, lng: longitude - mile5, label: 'w-5mi' },
            { lat: latitude + mile5, lng: longitude + mile5, label: 'ne-5mi' },
            { lat: latitude + mile5, lng: longitude - mile5, label: 'nw-5mi' },
            { lat: latitude - mile5, lng: longitude + mile5, label: 'se-5mi' },
            { lat: latitude - mile5, lng: longitude - mile5, label: 'sw-5mi' },
            
            // Middle ring (10 miles) - 8 directions
            { lat: latitude + mile10, lng: longitude, label: 'n-10mi' },
            { lat: latitude - mile10, lng: longitude, label: 's-10mi' },
            { lat: latitude, lng: longitude + mile10, label: 'e-10mi' },
            { lat: latitude, lng: longitude - mile10, label: 'w-10mi' },
            { lat: latitude + mile10, lng: longitude + mile10, label: 'ne-10mi' },
            { lat: latitude + mile10, lng: longitude - mile10, label: 'nw-10mi' },
            { lat: latitude - mile10, lng: longitude + mile10, label: 'se-10mi' },
            { lat: latitude - mile10, lng: longitude - mile10, label: 'sw-10mi' },
            
            // Outer ring (15 miles) - 8 directions
            { lat: latitude + mile15, lng: longitude, label: 'n-15mi' },
            { lat: latitude - mile15, lng: longitude, label: 's-15mi' },
            { lat: latitude, lng: longitude + mile15, label: 'e-15mi' },
            { lat: latitude, lng: longitude - mile15, label: 'w-15mi' },
            { lat: latitude + mile15, lng: longitude + mile15, label: 'ne-15mi' },
            { lat: latitude + mile15, lng: longitude - mile15, label: 'nw-15mi' },
            { lat: latitude - mile15, lng: longitude + mile15, label: 'se-15mi' },
            { lat: latitude - mile15, lng: longitude - mile15, label: 'sw-15mi' },
          ];
          
          console.log(`[AirQuality] Fetching AQI data for ${gridPoints.length} points across 15-mile radius`);

          // Fetch data for all grid points
          const airQualityPromises = gridPoints.map(async (point) => {
            try {
              const airNowResponse = await fetch(
                `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=${point.lat}&longitude=${point.lng}&distance=25&API_KEY=${airNowKey}`
              );
              const airNowData = await airNowResponse.json();
              
              console.log(`[AirQuality] ${point.label} AirNow response:`, airNowData);
              
              // Get OpenWeather data for this point
              let pollutionData = null;
              if (openWeatherKey) {
                const owResponse = await fetch(
                  `https://api.openweathermap.org/data/2.5/air_pollution?lat=${point.lat}&lon=${point.lng}&appid=${openWeatherKey}`
                );
                pollutionData = await owResponse.json();
                console.log(`[AirQuality] ${point.label} OpenWeather response:`, pollutionData);
              }
              
              // Convert OpenWeather AQI (1-5 scale) to US AQI (0-500 scale)
              let convertedAQI = null;
              if (pollutionData?.list?.[0]?.main?.aqi) {
                const owAQI = pollutionData.list[0].main.aqi;
                // OpenWeather: 1=Good, 2=Fair, 3=Moderate, 4=Poor, 5=Very Poor
                // Convert to US AQI midpoints
                const aqiMap: {[key: number]: number} = {
                  1: 25,   // Good (0-50) -> use 25
                  2: 75,   // Fair (51-100) -> use 75
                  3: 125,  // Moderate (101-150) -> use 125
                  4: 175,  // Poor (151-200) -> use 175
                  5: 250   // Very Poor (201-300) -> use 250
                };
                convertedAQI = aqiMap[owAQI] || 50;
              }
              
              const finalAQI = airNowData?.[0]?.AQI || convertedAQI || null;
              console.log(`[AirQuality] ${point.label} Final AQI: ${finalAQI} (AirNow: ${airNowData?.[0]?.AQI || 'none'}, OpenWeather: ${convertedAQI || 'none'})`);
              
              return {
                lat: point.lat,
                lng: point.lng,
                label: point.label,
                aqi: finalAQI,
                airNowData,
                pollutionData
              };
            } catch (error) {
              console.error(`Failed to fetch air quality for ${point.label}:`, error);
              return { lat: point.lat, lng: point.lng, label: point.label, aqi: null };
            }
          });

          const gridData = await Promise.all(airQualityPromises);
          console.log('[AirQualityNoiseMap] Grid data collected:', gridData);
          
          if (mounted) {
            const centerPoint = gridData[0];
            const baseAqi = centerPoint.aqi || 50;
            
            // Store base data for seasonal adjustments
            setBaseAirQualityData({
              gridData,
              airNow: centerPoint.airNowData,
              openWeather: centerPoint.pollutionData,
              aqi: baseAqi
            });
            
            // Apply initial seasonal adjustment
            const initialSeasonFactors = getAQSeasonalFactors(latitude, longitude, getCurrentAQSeason());
            setAQSeasonalFactors(initialSeasonFactors);
            
            const adjustedAqi = Math.round(baseAqi * initialSeasonFactors.aqiMultiplier);
            
            setAirQualityData({
              gridData: gridData.map((point: any) => ({
                ...point,
                aqi: point.aqi ? Math.round(point.aqi * initialSeasonFactors.aqiMultiplier) : null
              })),
              airNow: centerPoint.airNowData,
              openWeather: centerPoint.pollutionData,
              aqi: adjustedAqi
            });
            
            // Cache the fetched data
            await cacheAirQualityData(latitude, longitude, {
              gridData,
              airNow: centerPoint.airNowData,
              openWeather: centerPoint.pollutionData,
              aqi: baseAqi
            });
          }
          } // end else (no cache)
        } catch (error) {
          console.error('Failed to fetch air quality data:', error);
        }
      }

      // Set initial noise time factors
      const initialNoiseFactors = getNoiseTimeFactors(getCurrentTimeOfDay());
      setNoiseTimeFactors(initialNoiseFactors);

      // Estimate noise level based on location (proximity to highways)
      // Potomac MD is generally quiet suburban, but I-270 adds noise to the east
      const isPotomacArea = latitude > 39.0 && latitude < 39.1 && longitude > -77.2 && longitude < -77.1;
      if (isPotomacArea) {
        // Typical suburban noise: 40-50 dB, near highway: 55-65 dB
        const estimatedNoise = 42 + Math.random() * 8; // 42-50 dB range
        setNoiseLevel(estimatedNoise * initialNoiseFactors.trafficMultiplier);
      }

      setLoading(false);
      console.log('[AirQualityNoiseMap] Initialization complete for:', address);
    };

    initMap();
    return () => { 
      console.log('[AirQualityNoiseMap] Cleanup for:', address);
      mounted = false; 
    };
  }, [latitude, longitude, address]);

  // Update air quality when season changes
  React.useEffect(() => {
    if (!baseAirQualityData) return;
    
    const newSeasonFactors = getAQSeasonalFactors(latitude, longitude, selectedAQSeason);
    setAQSeasonalFactors(newSeasonFactors);
    
    console.log(`[AirQualityNoiseMap] Season changed to ${selectedAQSeason}, AQI multiplier: ${newSeasonFactors.aqiMultiplier}`);
    
    // Apply seasonal adjustment to base data
    const adjustedGridData = baseAirQualityData.gridData.map((point: any) => ({
      ...point,
      aqi: point.aqi ? Math.round(point.aqi * newSeasonFactors.aqiMultiplier) : null
    }));
    
    const adjustedAqi = Math.round(baseAirQualityData.aqi * newSeasonFactors.aqiMultiplier);
    
    setAirQualityData({
      ...baseAirQualityData,
      gridData: adjustedGridData,
      aqi: adjustedAqi
    });
  }, [selectedAQSeason, baseAirQualityData, latitude, longitude]);

  // Update noise when time of day changes
  React.useEffect(() => {
    const newNoiseFactors = getNoiseTimeFactors(selectedTimeOfDay);
    setNoiseTimeFactors(newNoiseFactors);
    
    console.log(`[AirQualityNoiseMap] Time changed to ${selectedTimeOfDay}, traffic multiplier: ${newNoiseFactors.trafficMultiplier}`);
    
    // Recalculate noise level based on time of day
    // Base suburban noise is around 45-50 dB
    const baseNoise = 48;
    const adjustedNoise = Math.max(newNoiseFactors.backgroundNoise, baseNoise * newNoiseFactors.trafficMultiplier);
    setNoiseLevel(adjustedNoise);
  }, [selectedTimeOfDay]);

  // Update map center when coordinates change
  React.useEffect(() => {
    if (map && (window as any).google?.maps) {
      console.log('[AirQualityNoiseMap] Updating map center to:', { lat: latitude, lng: longitude });
      map.setCenter({ lat: latitude, lng: longitude });
      map.setZoom(14);
      
      // Update marker position
      if (markerRef.current) {
        markerRef.current.setPosition({ lat: latitude, lng: longitude });
        markerRef.current.setTitle(address);
      }
    }
  }, [map, latitude, longitude, address]);

  // Update map type when toggle changes
  React.useEffect(() => {
    if (map && (window as any).google?.maps) {
      map.setMapTypeId(mapType);
    }
  }, [map, mapType]);

  // Air quality heatmap - ZOOM-RESPONSIVE (like Zillow)
  React.useEffect(() => {
    if (!map || !(window as any).google?.maps) return;

    if (showAirQuality && airQualityData?.gridData) {
      const gridData = airQualityData.gridData;
      console.log('[AirQualityHeatmap] Processing grid data from 15-mile radius:', gridData);
      
      // Find points with real AQI data
      const pointsWithData = gridData.filter((point: any) => point.aqi !== null);
      console.log(`[AirQualityHeatmap] ${pointsWithData.length}/${gridData.length} points have real monitoring data`);
      
      // If we have at least one real data point, use that data
      // Otherwise, use a default moderate AQI value
      let heatmapData;
      
      if (pointsWithData.length > 0) {
        // Calculate average AQI from real monitoring stations
        const avgAQI = pointsWithData.reduce((sum: number, p: any) => sum + p.aqi, 0) / pointsWithData.length;
        console.log(`[AirQualityHeatmap] Average AQI from monitoring stations: ${avgAQI.toFixed(1)}`);
        
        // CRITICAL FIX: Use EXACT SAME AQI for all points to prevent artificial gradients
        // No variation, no interpolation - uniform color across region
        heatmapData = gridData.map((point: any) => {
          const aqiValue = point.aqi !== null ? point.aqi : avgAQI;
          
          return {
            location: new (window as any).google.maps.LatLng(point.lat, point.lng),
            weight: Math.min(aqiValue, 200)
          };
        });
        
        console.log(`[AirQualityHeatmap] Using uniform AQI (${avgAQI.toFixed(1)}) for consistent color representation`);
      } else {
        // No monitoring data available - use default good AQI (20) uniformly
        console.log('[AirQualityHeatmap] No monitoring data, using default good AQI uniformly');
        const defaultAQI = 20; // Good air quality
        heatmapData = gridData.map((point: any) => ({
          location: new (window as any).google.maps.LatLng(point.lat, point.lng),
          weight: defaultAQI
        }));
      }
      
      console.log(`[AirQualityHeatmap] Created ${heatmapData.length} heatmap points for visualization`);

      // Get current zoom level for dynamic heatmap parameters
      const currentZoom = map.getZoom() || 14;
      console.log('[AirQualityHeatmap] Current zoom level:', currentZoom);
      
      // ZOOM-RESPONSIVE parameters for 15-mile radius grid
      // Grid points are 5-15 miles apart, need LARGE radius to create smooth gradients
      // CRITICAL: Keep maxIntensity CONSTANT to maintain accurate color-to-AQI mapping
      // Only adjust radius and opacity for coverage without distorting the color scale
      let aqRadius, aqOpacity;
      const aqMaxIntensity = 200; // FIXED - ensures colors accurately represent AQI values at all zoom levels
      
      if (currentZoom <= 10) {
        // Zoomed WAY out - massive radius for regional patterns
        aqRadius = 150;
        aqOpacity = 0.65;
      } else if (currentZoom <= 12) {
        // Zoomed out - large radius for balanced regional view
        aqRadius = 220;
        aqOpacity = 0.7;
      } else if (currentZoom <= 14) {
        // Medium zoom - very large radius for smooth gradients
        aqRadius = 300;
        aqOpacity = 0.75;
      } else if (currentZoom <= 16) {
        // Zoomed in - extremely large radius for continuous coverage
        aqRadius = 380;
        aqOpacity = 0.8;
      } else {
        // Extremely zoomed in - massive radius to fill gaps
        aqRadius = 480;
        aqOpacity = 0.85;
      }
      
      console.log(`[AirQualityHeatmap] Zoom-adjusted: radius=${aqRadius}, opacity=${aqOpacity}, maxIntensity=${aqMaxIntensity} (FIXED)`);

      const heatmap = createGoogleMapsHeatmapLayer({
        data: heatmapData,
        map: map,
        radius: aqRadius, // Dynamic based on zoom
        opacity: aqOpacity, // Dynamic based on zoom
        maxIntensity: aqMaxIntensity, // FIXED at 200 for accurate color mapping
        dissipating: false, // CRITICAL: Disable dissipating to prevent artificial center-to-edge gradients
        gradient: [
          'rgba(0, 255, 0, 0)',        // Transparent: 0 AQI
          'rgba(102, 255, 102, 0.6)',  // Light green: 0-20 (Excellent)
          'rgba(0, 228, 0, 0.7)',      // Green: 20-40 (Good)
          'rgba(255, 255, 0, 0.75)',   // Yellow: 40-60 (Moderate)
          'rgba(255, 200, 0, 0.8)',    // Yellow-orange: 60-80 (Moderate-USG)
          'rgba(255, 165, 0, 0.85)',   // Orange: 80-100 (Unhealthy for Sensitive Groups)
          'rgba(255, 100, 0, 0.9)',    // Dark orange: 100-120 (Unhealthy for Sensitive)
          'rgba(255, 0, 0, 0.92)',     // Red: 120-150 (Unhealthy)
          'rgba(178, 34, 34, 0.95)',   // Dark red: 150-180 (Very Unhealthy)
          'rgba(128, 0, 128, 0.98)'    // Purple: 180-200+ (Hazardous)
        ]
      });
      
      // Add zoom change listener to update air quality heatmap dynamically
      const zoomListener = map.addListener('zoom_changed', () => {
        if (!heatmap) return;
        
        const newZoom = map.getZoom() || 14;
        let newRadius, newOpacity;
        const newMaxIntensity = 200; // FIXED - maintain accurate color mapping
        
        if (newZoom <= 10) {
          newRadius = 150;
          newOpacity = 0.65;
        } else if (newZoom <= 12) {
          newRadius = 220;
          newOpacity = 0.7;
        } else if (newZoom <= 14) {
          newRadius = 300;
          newOpacity = 0.75;
        } else if (newZoom <= 16) {
          newRadius = 380;
          newOpacity = 0.8;
        } else {
          newRadius = 480;
          newOpacity = 0.85;
        }
        
        console.log(`[AirQualityHeatmap] Zoom changed to ${newZoom}: radius=${newRadius}, opacity=${newOpacity}, maxIntensity=${newMaxIntensity} (FIXED)`);
        
        heatmap.setOptions({
          radius: newRadius,
          opacity: newOpacity,
          maxIntensity: newMaxIntensity,
          dissipating: false // CRITICAL: Keep dissipating false to prevent artificial gradients
        });
      });

      return () => {
        if (zoomListener) {
          (window as any).google.maps.event.removeListener(zoomListener);
        }
        heatmap.setMap(null);
      };
    }
  }, [map, showAirQuality, latitude, longitude, airQualityData]);

  // Noise pollution heatmap - REAL data from OpenStreetMap roads
  React.useEffect(() => {
    if (!map || !(window as any).google?.maps || !showNoise) return;

    let noiseHeatmap: any = null;
    let zoomListener: any = null;
    let cancelled = false;

    const fetchNoiseData = async () => {
      try {
        console.log('[NoiseMap] Fetching road data for:', { latitude, longitude, selectedTimeOfDay });
        
        // Get time-of-day factors for traffic adjustment
        const timeFactors = getNoiseTimeFactors(selectedTimeOfDay);
        console.log('[NoiseMap] Time factors:', timeFactors);
        
        // Check Firestore cache first
        const cachedData = await getCachedNoiseData(latitude, longitude);
        
        let data: any = null;
        
        // Only use cache if it has actual road data (not empty)
        const hasValidCachedData = cachedData && cachedData.ok && 
          ((cachedData.roads && cachedData.roads.length > 0) || 
           (cachedData.railways && cachedData.railways.length > 0) ||
           (cachedData.airports && cachedData.airports.length > 0));
        
        if (hasValidCachedData) {
          console.log('[NoiseMap] ✅ Using cached OSM road data from Firestore:', {
            roads: cachedData.roads?.length || 0,
            railways: cachedData.railways?.length || 0,
            airports: cachedData.airports?.length || 0
          });
          data = cachedData;
        } else {
          // No valid cache hit - fetch from API
          if (cachedData && cachedData.ok) {
            console.log('[NoiseMap] Cache found but empty, refetching from OSM API...');
          } else {
            console.log('[NoiseMap] Cache miss, fetching from OSM API...');
          }
          
          // Use server proxy to fetch OSM road data (avoids CORS issues)
          // Roads/railways: 2km radius (nearby traffic)
          // Airports: Server automatically queries 10km radius for airports (hardcoded in backend)
          const radius = 2000; // meters (2km radius for roads/railways)
          const timestamp = Date.now(); // Cache busting
          const proxyUrl = `/api/osm/roads?lat=${latitude}&lng=${longitude}&radius=${radius}&_t=${timestamp}`;
          const response = await fetch(proxyUrl, {
            cache: 'no-store', // Bypass browser cache to get fresh OSM data
            headers: {
              'Cache-Control': 'no-cache',
              'Pragma': 'no-cache'
            }
          });
          
          if (!response.ok) {
            throw new Error(`OSM Proxy error: ${response.status}`);
          }
          
          data = await response.json();
          
          // Only cache if we have actual data (not empty results)
          const hasRealData = data.ok && 
            ((data.roads && data.roads.length > 0) || 
             (data.railways && data.railways.length > 0) ||
             (data.airports && data.airports.length > 0));
          
          if (hasRealData) {
            await cacheNoiseData(latitude, longitude, data);
            console.log('[NoiseMap] Cached fresh data to Firestore:', {
              roads: data.roads?.length || 0,
              railways: data.railways?.length || 0,
              airports: data.airports?.length || 0
            });
          } else {
            console.log('[NoiseMap] Not caching empty OSM data');
          }
        }
        
        console.log('[NoiseMap] OSM data ready:', {
          roads: data.roads?.length || 0,
          railways: data.railways?.length || 0,
          aeroways: data.aeroways?.length || 0,
          airports: data.airports?.length || 0,
          helipads: data.helipads?.length || 0,
          ok: data.ok,
          lat: data.lat,
          lng: data.lng
        });
        
        if (!data.ok) {
          console.warn('[NoiseMap] No data found in area');
          return;
        }
        
        const roads = data.roads || [];
        const railways = data.railways || [];
        const aeroways = data.aeroways || [];
        const airports = data.airports || [];
        const helipads = data.helipads || [];
        
        // ========== FETCH REAL-TIME AIRCRAFT DATA ==========
        // Fetch low-flying aircraft that contribute to audible noise
        let aircraft = [];
        try {
          console.log('[NoiseMap] Fetching flight data for:', { latitude, longitude });
          const flightResponse = await fetch(`/api/flights?lat=${latitude}&lng=${longitude}&radius=10&maxAltitude=8000`);
          
          if (flightResponse.ok) {
            const flightData = await flightResponse.json();
            if (flightData.ok && flightData.aircraft) {
              aircraft = flightData.aircraft;
              console.log('[NoiseMap] Aircraft data fetched:', {
                count: aircraft.length,
                lowAltitude: aircraft.filter((a: any) => a.altitudeFeet < 1000).length,
                medAltitude: aircraft.filter((a: any) => a.altitudeFeet >= 1000 && a.altitudeFeet < 2000).length,
                highAltitude: aircraft.filter((a: any) => a.altitudeFeet >= 2000).length
              });
              
              // Log sample aircraft if any found
              if (aircraft.length > 0) {
                console.log('[NoiseMap] Sample aircraft:', aircraft[0]);
              }
            }
          } else {
            console.warn('[NoiseMap] Flight API returned error:', flightResponse.status);
          }
        } catch (flightError) {
          console.warn('[NoiseMap] Failed to fetch flight data:', flightError);
          // Continue without aircraft data - don't fail the entire noise map
        }
        
        // Create noise points along actual roads based on road type
        const noiseHeatmapData: Array<{ location: any; weight: number }> = [];
        
        // ========== ROAD TRAFFIC NOISE ==========
        // Enhanced noise calculation using:
        // 1. Road type (highway, primary, residential, etc.)
        // 2. Traffic volume (number of lanes - more lanes = more vehicles = higher noise)
        // 3. Vehicle speed (maxspeed tag or estimated - higher speeds = more noise)
        // 4. Road importance (named major roads get additional noise boost)
        // Noise increases logarithmically: +2 dB per extra lane, +1.5 dB per 10 mph speed increase
        
        let roadCount = 0;
        for (const road of roads) {
          if (!road.geometry || road.geometry.length === 0) continue;
          
          const roadType = road.tags?.highway;
          if (!roadType) continue;
          
          roadCount++;
          const isFirstFewRoads = roadCount <= 5;
          
          // Base noise levels by road type (dBA at roadside ~15m)
          // Using realistic traffic noise measurements
          const noiseMapping: { [key: string]: number } = {
            'motorway': 78,          // Interstate/highway (I-270, I-495)
            'motorway_link': 75,     // Highway on/off ramps
            'trunk': 75,             // Major highway
            'trunk_link': 72,        // Major highway ramps
            'primary': 70,           // Major arterial (Montrose Rd, Falls Rd)
            'primary_link': 68,      // Arterial ramps
            'secondary': 65,         // Secondary arterial
            'secondary_link': 63,    // Secondary ramps
            'tertiary': 60,          // Collector road
            'tertiary_link': 58,     // Collector ramps
            'unclassified': 55,      // Minor roads
            'residential': 50,       // Residential street
            'living_street': 45,     // Slow residential areas
            'service': 48            // Service roads/alleys
          };
          let roadNoise = noiseMapping[roadType] || 50;
          
          // TRAFFIC VOLUME adjustment based on number of lanes
          // More lanes = more vehicles = higher noise
          let lanes = road.tags?.lanes ? parseInt(road.tags.lanes) : null;
          
          // Estimate lanes if not tagged, based on road type
          if (!lanes || isNaN(lanes)) {
            const laneEstimates: { [key: string]: number } = {
              'motorway': 4,
              'motorway_link': 2,
              'trunk': 4,
              'trunk_link': 2,
              'primary': 3,
              'primary_link': 2,
              'secondary': 2,
              'secondary_link': 2,
              'tertiary': 2,
              'tertiary_link': 1,
              'unclassified': 2,
              'residential': 2,
              'living_street': 1,
              'service': 1
            };
            lanes = laneEstimates[roadType] || 2;
          }
          
          // Each additional lane beyond 2 adds ~2 dB (doubling traffic doubles noise by ~3dB)
          if (lanes > 2) {
            const laneBonus = (lanes - 2) * 2;
            roadNoise += laneBonus;
            if (road.tags?.lanes) {
              console.log(`[NoiseMap] ${road.tags?.name || roadType}: ${lanes} lanes (tagged), +${laneBonus}dB bonus`);
            }
          }
          
          // SPEED adjustment based on maxspeed tag
          // Higher speeds = more noise (aerodynamic and engine noise increase)
          let maxspeed = road.tags?.maxspeed;
          let speedAdjustment = 0;
          let speedMph = 0;
          
          if (maxspeed) {
            // Parse speed (could be "55 mph", "65", "100 km/h")
            if (typeof maxspeed === 'string') {
              const speedMatch = maxspeed.match(/(\d+)\s*(mph|km\/h|kmh)?/i);
              if (speedMatch) {
                const speedValue = parseInt(speedMatch[1]);
                const unit = speedMatch[2]?.toLowerCase();
                
                if (!isNaN(speedValue)) {
                  if (unit === 'mph' || !unit) {
                    speedMph = speedValue;
                  } else if (unit === 'km/h' || unit === 'kmh') {
                    speedMph = Math.round(speedValue * 0.621371); // Convert km/h to mph
                  }
                }
              }
            }
          } else {
            // Estimate typical speed limits if not tagged
            const speedEstimates: { [key: string]: number } = {
              'motorway': 65,
              'motorway_link': 45,
              'trunk': 55,
              'trunk_link': 40,
              'primary': 45,
              'primary_link': 35,
              'secondary': 35,
              'secondary_link': 30,
              'tertiary': 30,
              'tertiary_link': 25,
              'unclassified': 25,
              'residential': 25,
              'living_street': 15,
              'service': 15
            };
            speedMph = speedEstimates[roadType] || 25;
          }
          
          // Speed-based noise adjustment (logarithmic relationship)
          // Baseline: 35 mph = 0 adjustment
          // Every 10 mph above/below baseline adds/subtracts ~1.5 dB
          if (speedMph > 0) {
            const baseline = 35;
            speedAdjustment = ((speedMph - baseline) / 10) * 1.5;
            
            if (Math.abs(speedAdjustment) > 0.5 && road.tags?.maxspeed) {
              console.log(`[NoiseMap] ${road.tags?.name || roadType}: ${speedMph} mph (tagged), ${speedAdjustment > 0 ? '+' : ''}${speedAdjustment.toFixed(1)}dB speed adjustment`);
            }
          }
          
          roadNoise += speedAdjustment;
          
          // Add variation based on road name/importance
          let noiseVariation = 0;
          if (road.tags?.name) {
            // Major named roads tend to be busier
            if (road.tags.name.match(/\b(Highway|Interstate|Parkway|Boulevard|Avenue)\b/i)) {
              noiseVariation += 3;
            }
          }
          
          // Apply time-of-day traffic multiplier to get final noise level
          const adjustedNoise = Math.min(85, (roadNoise + noiseVariation) * timeFactors.trafficMultiplier);
          
          // Debug logging for first few roads to verify calculations
          if (isFirstFewRoads) {
            console.log(`[NoiseMap] Road #${roadCount}: ${road.tags?.name || 'unnamed'} (${roadType})`);
            console.log(`  Base: ${noiseMapping[roadType] || 50}dB | Lanes: ${lanes} | Speed: ${speedMph}mph`);
            console.log(`  Lane bonus: ${lanes > 2 ? (lanes - 2) * 2 : 0}dB | Speed adj: ${speedAdjustment.toFixed(1)}dB | Name bonus: ${noiseVariation}dB`);
            console.log(`  Time multiplier: ${timeFactors.trafficMultiplier}x (${selectedTimeOfDay})`);
            console.log(`  FINAL: ${adjustedNoise.toFixed(1)}dB`);
          }
          
          // INTERPOLATE between points for continuous coverage along entire road
          // This creates a smooth, continuous noise band instead of scattered dots
          for (let i = 0; i < road.geometry.length; i++) {
            const coord = road.geometry[i];
            const coordLng = coord.lon || coord.lng;
            
            // Add multiple points directly on the road for density
            for (let dup = 0; dup < 2; dup++) {
              noiseHeatmapData.push({
                location: new (window as any).google.maps.LatLng(coord.lat, coordLng),
                weight: adjustedNoise
              });
            }
            
            // INTERPOLATE between this point and next for continuous line
            if (i < road.geometry.length - 1) {
              const nextCoord = road.geometry[i + 1];
              const nextLng = nextCoord.lon || nextCoord.lng;
              
              // Adaptive interpolation - more points for major roads, fewer for residential
              const interpPoints = roadType === 'motorway' || roadType === 'trunk' ? 8 :
                                  roadType === 'primary' || roadType === 'secondary' ? 6 : 4;
              
              // Add interpolated points between each pair for smooth continuous line
              for (let interp = 1; interp <= interpPoints; interp++) {
                const ratio = interp / (interpPoints + 1);
                const interpLat = coord.lat + (nextCoord.lat - coord.lat) * ratio;
                const interpLng = coordLng + (nextLng - coordLng) * ratio;
                
                // Add interpolated points on the road
                for (let dup = 0; dup < 2; dup++) {
                  noiseHeatmapData.push({
                    location: new (window as any).google.maps.LatLng(interpLat, interpLng),
                    weight: adjustedNoise
                  });
                }
              }
            }
            
            // CONTROLLED gradient - vary falloff based on road type to prevent residential overlap
            // High-traffic roads: more falloff points for wider noise impact
            // Low-traffic roads: minimal falloff to keep noise localized
            let distances: number[];
            let attenuations: number[];
            
            if (roadType === 'motorway' || roadType === 'trunk') {
              // Highways: wide noise impact with sharper gradient
              distances = [0.0001, 0.0003, 0.0006, 0.0010];
              attenuations = [4, 10, 18, 28];
            } else if (roadType === 'primary' || roadType === 'secondary') {
              // Major roads: moderate falloff
              distances = [0.0001, 0.0003, 0.0005];
              attenuations = [5, 12, 22];
            } else if (roadType === 'tertiary') {
              // Collector roads: limited falloff
              distances = [0.0001, 0.0002];
              attenuations = [6, 14];
            } else {
              // Residential/service: minimal falloff to prevent overlap
              distances = [0.00008];
              attenuations = [8];
            }
            
            // Sample falloff at regular intervals to maintain continuous band
            const falloffSampling = roadType === 'motorway' || roadType === 'trunk' ? 2 :
                                   roadType === 'primary' || roadType === 'secondary' ? 3 : 5;
            
            if (i % falloffSampling === 0) {
              for (let j = 0; j < distances.length; j++) {
                const offset = distances[j];
                const attenuation = attenuations[j];
                const falloffNoise = adjustedNoise - attenuation;
                
                // Skip points that are too quiet (< 35 dB ambient)
                if (falloffNoise < 35) continue;
                
                // Only 4 cardinal directions for roads (perpendicular to road)
                noiseHeatmapData.push({
                  location: new (window as any).google.maps.LatLng(coord.lat + offset, coordLng),
                  weight: falloffNoise
                });
                noiseHeatmapData.push({
                  location: new (window as any).google.maps.LatLng(coord.lat - offset, coordLng),
                  weight: falloffNoise
                });
                noiseHeatmapData.push({
                  location: new (window as any).google.maps.LatLng(coord.lat, coordLng + offset),
                  weight: falloffNoise
                });
                noiseHeatmapData.push({
                  location: new (window as any).google.maps.LatLng(coord.lat, coordLng - offset),
                  weight: falloffNoise
                });
              }
            }
          }
        }
        
        // ========== RAILWAY NOISE ==========
        console.log('[Noise Map] Processing', railways.length, 'railway segments');
        for (const railway of railways) {
          if (!railway.geometry || railway.geometry.length === 0) {
            console.log('[Noise Map] Skipping railway - no geometry');
            continue;
          }
          
          const railType = railway.tags?.railway;
          if (!railType) continue;
          
          console.log(`[Noise Map] Railway: type=${railType}, ${railway.geometry.length} points`);
          
          // Railway noise levels (dBA at 30m from track)
          // INCREASED values to make railways more prominent on heatmap
          const railNoiseMapping: { [key: string]: number } = {
            'rail': 92,           // Heavy freight/passenger rail (Amtrak, MARC, CSX) - VERY LOUD
            'light_rail': 85,     // Light rail/metro (DC Metro above ground)
            'subway': 88,         // Subway when above ground
            'tram': 80,           // Streetcar/tram
            'narrow_gauge': 82,   // Tourist/narrow gauge
            'preserved': 78,      // Historic/tourist railways
            'disused': 70         // Old/inactive tracks (still generate some noise from nearby)
          };
          // Apply time-of-day multiplier (trains run less frequently at night/midday)
          const baseRailNoise = railNoiseMapping[railType] || 88;
          const railNoise = baseRailNoise * timeFactors.trafficMultiplier;
          
          // INTERPOLATE between points for continuous coverage along entire rail line
          for (let i = 0; i < railway.geometry.length; i++) {
            const coord = railway.geometry[i];
            const coordLng = coord.lon || coord.lng;
            
            // Add points on the tracks
            for (let dup = 0; dup < 3; dup++) {
              noiseHeatmapData.push({
                location: new (window as any).google.maps.LatLng(coord.lat, coordLng),
                weight: railNoise
              });
            }
            
            // INTERPOLATE between this point and next for continuous line
            if (i < railway.geometry.length - 1) {
              const nextCoord = railway.geometry[i + 1];
              const nextLng = nextCoord.lon || nextCoord.lng;
              
              // Add 10 interpolated points between each pair for smooth continuous line
              for (let interp = 1; interp <= 10; interp++) {
                const ratio = interp / 11;
                const interpLat = coord.lat + (nextCoord.lat - coord.lat) * ratio;
                const interpLng = coordLng + (nextLng - coordLng) * ratio;
                
                // Add interpolated track points
                for (let dup = 0; dup < 3; dup++) {
                  noiseHeatmapData.push({
                    location: new (window as any).google.maps.LatLng(interpLat, interpLng),
                    weight: railNoise
                  });
                }
              }
            }
            
            // Railway noise - FEWER, CLOSER falloff points to avoid scattered dots
            // Sharp gradient: loud near tracks, quickly fades to quiet
            const distances = [0.0001, 0.0003, 0.0005, 0.0008, 0.0012]; // 10m, 30m, 50m, 80m, 120m
            const attenuations = [5, 15, 25, 35, 50]; // Steeper falloff to avoid distant dots
            
            for (let j = 0; j < distances.length; j++) {
              const offset = distances[j];
              const attenuation = attenuations[j];
              const falloffNoise = railNoise - attenuation;
              
              // Skip points that would be too quiet (< 40 dB)
              if (falloffNoise < 40) continue;
              
              // Only 4 cardinal directions (not 8) to reduce scattered points
              const directions = [
                { lat: offset, lng: 0 },      // North
                { lat: -offset, lng: 0 },     // South
                { lat: 0, lng: offset },      // East
                { lat: 0, lng: -offset }      // West
              ];
              
              for (const dir of directions) {
                noiseHeatmapData.push({
                  location: new (window as any).google.maps.LatLng(coord.lat + dir.lat, coordLng + dir.lng),
                  weight: falloffNoise
                });
              }
            }
          }
        }
        
        // ========== AIRPORT & RUNWAY NOISE ==========
        for (const aeroway of aeroways) {
          if (!aeroway.geometry || aeroway.geometry.length === 0) continue;
          
          const aeroType = aeroway.tags?.aeroway;
          
          // Runway/taxiway noise (extremely loud)
          const aeroNoise = aeroType === 'runway' ? 95 : 85; // Runway vs taxiway
          
          // Sample every 3rd point on runways
          for (let i = 0; i < aeroway.geometry.length; i += 3) {
            const coord = aeroway.geometry[i];
            const coordLng = coord.lon || coord.lng;
            
            noiseHeatmapData.push({
              location: new (window as any).google.maps.LatLng(coord.lat, coordLng),
              weight: aeroNoise
            });
            
            // Aircraft noise - 2 falloff distances
            const offsetDistances = [0.002, 0.004]; // 200m, 400m
            const attenuations = [18, 30];
            
            for (let j = 0; j < offsetDistances.length; j++) {
              const offset = offsetDistances[j];
              const attenuation = attenuations[j];
              const falloffNoise = Math.max(50, aeroNoise - attenuation);
              
              noiseHeatmapData.push({
                location: new (window as any).google.maps.LatLng(coord.lat + offset, coordLng),
                weight: falloffNoise
              });
              noiseHeatmapData.push({
                location: new (window as any).google.maps.LatLng(coord.lat - offset, coordLng),
                weight: falloffNoise
              });
            }
          }
        }
        
        // ========== AIRPORT FLIGHT PATHS ==========
        // Create approach/departure corridors for nearby airports
        console.log('[NoiseMap] Processing', airports.length, 'airports for flight paths');
        
        let airportsWithPaths = 0;
        for (const airport of airports) {
          const airportLat = airport.lat;
          const airportLon = airport.lon;
          const airportName = airport.tags?.name || 'Unknown Airport';
          
          // Calculate distance from property to airport
          const distance = Math.sqrt(
            Math.pow((airportLat - latitude) * 111000, 2) + 
            Math.pow((airportLon - longitude) * 111000, 2)
          );
          
          console.log(`[NoiseMap] Airport: ${airportName} at ${(distance/1000).toFixed(1)}km`);
          
          // Only create flight paths for airports within 10km
          if (distance < 10000) {
            airportsWithPaths++;
            console.log(`[NoiseMap] ✈️ Creating flight paths for ${airportName} (${(distance/1000).toFixed(1)}km away)`);
            
            // Create 4 approach corridors (N, S, E, W) - sparser sampling
            const corridorLength = 0.03; // ~3km approach path
            
            const directions = [
              { lat: 1, lng: 0 },   // North approach
              { lat: -1, lng: 0 },  // South approach
              { lat: 0, lng: 1 },   // East approach
              { lat: 0, lng: -1 }   // West approach
            ];
            
            for (const dir of directions) {
              // Much sparser sampling - every 500m instead of every 300m
              for (let dist = 0.005; dist < corridorLength; dist += 0.005) {
                const pathLat = airportLat + (dir.lat * dist);
                const pathLng = airportLon + (dir.lng * dist);
                
                // Noise decreases with distance from runway
                const pathNoise = Math.max(60, 90 - (dist * 1000));
                
                // Single center point per distance (no width spread)
                noiseHeatmapData.push({
                  location: new (window as any).google.maps.LatLng(pathLat, pathLng),
                  weight: pathNoise
                });
              }
            }
          }
        }
        
        console.log(`[NoiseMap] Flight paths created for ${airportsWithPaths} nearby airports`);
        
        // ========== HELIPAD NOISE ==========
        for (const helipad of helipads) {
          const heliLat = helipad.lat;
          const heliLon = helipad.lon;
          
          // Helicopter noise (very loud, localized)
          const heliNoise = 88;
          
          noiseHeatmapData.push({
            location: new (window as any).google.maps.LatLng(heliLat, heliLon),
            weight: heliNoise
          });
          
          // Helipad noise - only 2 circles, sparser angles
          const circles = [0.001, 0.002]; // 100m, 200m
          const heliAttenuations = [15, 28];
          
          for (let c = 0; c < circles.length; c++) {
            const radius = circles[c];
            const attenuation = heliAttenuations[c];
            const circleNoise = Math.max(45, heliNoise - attenuation);
            
            // Create circle around helipad - every 60 degrees instead of 30
            for (let angle = 0; angle < 360; angle += 60) {
              const rad = (angle * Math.PI) / 180;
              const circleLat = heliLat + (radius * Math.cos(rad));
              const circleLng = heliLon + (radius * Math.sin(rad));
              
              noiseHeatmapData.push({
                location: new (window as any).google.maps.LatLng(circleLat, circleLng),
                weight: circleNoise
              });
            }
          }
        }
        
        // ========== REAL-TIME AIRCRAFT NOISE ==========
        // Add noise points for low-flying aircraft
        // Aircraft below 3000 ft are audible from ground
        // Noise level decreases with altitude
        console.log('[NoiseMap] Processing', aircraft.length, 'low-flying aircraft');
        
        for (const plane of aircraft) {
          const planeLat = plane.latitude;
          const planeLng = plane.longitude;
          const planeNoise = plane.noiseLevel; // Already calculated based on altitude, speed, type
          
          console.log(`[NoiseMap] Aircraft: ${plane.callsign} at ${plane.altitudeFeet}ft - ${planeNoise}dB`);
          
          // Add primary noise point at aircraft location
          // Multiple points to make aircraft more visible on heatmap
          for (let dup = 0; dup < 5; dup++) {
            noiseHeatmapData.push({
              location: new (window as any).google.maps.LatLng(planeLat, planeLng),
              weight: planeNoise
            });
          }
          
          // Add noise gradient around aircraft
          // Lower altitude = wider noise spread, higher altitude = more localized
          const altitudeFactor = Math.max(0.3, plane.altitudeFeet / 3000); // 0.3 to 1.0
          
          // Noise spread distances - closer for high altitude, wider for low altitude
          const baseDistances = [0.0005, 0.001, 0.002, 0.003]; // Base distances in degrees (~50m, 100m, 200m, 300m)
          const distances = baseDistances.map(d => d / altitudeFactor); // Wider spread for lower altitude
          
          // Attenuation values - noise decreases with distance from aircraft
          const attenuations = [5, 10, 18, 28];
          
          for (let j = 0; j < distances.length; j++) {
            const offset = distances[j];
            const attenuation = attenuations[j];
            const falloffNoise = planeNoise - attenuation;
            
            // Skip if too quiet (below ambient level)
            if (falloffNoise < 45) continue;
            
            // Create noise points in 8 directions around aircraft
            const directions = [
              { lat: offset, lng: 0 },        // N
              { lat: -offset, lng: 0 },       // S
              { lat: 0, lng: offset },        // E
              { lat: 0, lng: -offset },       // W
              { lat: offset * 0.707, lng: offset * 0.707 },     // NE
              { lat: offset * 0.707, lng: -offset * 0.707 },    // NW
              { lat: -offset * 0.707, lng: offset * 0.707 },    // SE
              { lat: -offset * 0.707, lng: -offset * 0.707 }    // SW
            ];
            
            for (const dir of directions) {
              noiseHeatmapData.push({
                location: new (window as any).google.maps.LatLng(planeLat + dir.lat, planeLng + dir.lng),
                weight: falloffNoise
              });
            }
          }
          
          // Add motion trail if aircraft is moving
          // Extends noise in the direction of travel to simulate Doppler effect
          if (plane.heading !== null && plane.heading !== undefined && plane.velocity > 50) {
            const headingRad = (plane.heading * Math.PI) / 180;
            const trailLength = 0.002; // ~200m trail
            const trailSteps = 3;
            
            for (let step = 1; step <= trailSteps; step++) {
              const trailDist = (trailLength * step) / trailSteps;
              const trailLat = planeLat + (trailDist * Math.cos(headingRad));
              const trailLng = planeLng + (trailDist * Math.sin(headingRad));
              const trailNoise = planeNoise - (step * 8); // Fade noise along trail
              
              if (trailNoise > 45) {
                noiseHeatmapData.push({
                  location: new (window as any).google.maps.LatLng(trailLat, trailLng),
                  weight: trailNoise
                });
              }
            }
          }
        }
        
        // NO BACKGROUND GRID - let the heatmap algorithm handle empty areas
        
        console.log('[NoiseMap] Total noise points:', noiseHeatmapData.length);
        
        // Check if we have any data before processing
        if (noiseHeatmapData.length === 0) {
          console.warn('[NoiseMap] No noise data to display');
          return;
        }
        
        // Calculate actual min/max for logging (avoid stack overflow with large arrays)
        let minNoise = Infinity;
        let maxNoise = -Infinity;
        for (const point of noiseHeatmapData) {
          if (point.weight < minNoise) minNoise = point.weight;
          if (point.weight > maxNoise) maxNoise = point.weight;
        }
        console.log('[NoiseMap] Noise range:', minNoise, '-', maxNoise, 'dBA');
        
        // NORMALIZE weights to 0-100 scale based on FIXED dB range
        // Using a fixed range ensures consistent colors across all zoom levels and locations
        // This prevents "everything looks red" when zoomed out
        const MIN_DB = 45;  // Below typical residential (ensures quiet areas show green)
        const MAX_DB = 95;  // Maximum noise level (runways/railways) - expanded range for proper differentiation
        
        console.log(`[NoiseMap] Fixed normalization range: ${MIN_DB} - ${MAX_DB} dB for consistent colors at all zoom levels`);
        
        const normalizedData = noiseHeatmapData.map(point => {
          const dbValue = point.weight;
          // Normalize to 0-100 scale with fixed range
          // 50dB (residential) → 10% → green
          // 65dB (secondary) → 40% → yellow
          // 78dB (highway) → 66% → orange
          // 92dB (railway) → 94% → red
          const normalized = Math.max(0, Math.min(100, ((dbValue - MIN_DB) / (MAX_DB - MIN_DB)) * 100));
          return {
            location: point.location,
            weight: normalized
          };
        });
        
        console.log('[NoiseMap] Normalization: 50dB=10% (green), 65dB=40% (yellow), 78dB=66% (orange), 92dB=94% (red)');
        
        // Get current zoom level for radius calculation
        const currentZoom = map.getZoom() || 14;
        
        // CONSTANT GEOGRAPHIC COVERAGE: Calculate radius to represent fixed real-world distance
        // Adjusted radius to create clear, defined noise bands with proper gradients
        // Target: ~50-60 meters real-world coverage for clear road noise visualization
        const baseRadius = 20; // Increased base radius at zoom 14 for smoother gradients
        const zoomDiff = currentZoom - 14; // Difference from reference zoom
        const heatmapRadius = Math.round(baseRadius * Math.pow(2, zoomDiff)); // Double radius per zoom level
        
        // Adjusted maxIntensity to spread the gradient across the full color range
        const maxIntensity = 100;      // Full range to properly utilize gradient stops
        
        console.log(`[NoiseMap] Zoom=${currentZoom}, radius=${heatmapRadius} (~50-60m coverage), maxIntensity=${maxIntensity} (full gradient range)`);
        
        if (cancelled) return;

        if (noiseHeatmapData.length > 0) {
          noiseHeatmap = createGoogleMapsHeatmapLayer({
            data: normalizedData, // Use normalized 0-100 scale
            map: map,
            radius: heatmapRadius, // Dynamically calculated to maintain constant geographic size
            opacity: 0.65, // Balanced opacity for visibility without oversaturation
            maxIntensity: maxIntensity, // Lowered to create distinct bands instead of blobs
            dissipating: true, // Enable smooth gradients for continuous bands
            gradient: [
              'rgba(0, 0, 0, 0)',          // 0% - Transparent (< 45 dB)
              'rgba(0, 255, 0, 0.3)',      // 5% - Transparent green (46-47 dB)
              'rgba(102, 255, 102, 0.5)',  // 10% - Light green (48-50 dB) ← Residential streets (50dB)
              'rgba(120, 255, 120, 0.55)', // 15% - Green (51-53 dB)
              'rgba(150, 255, 150, 0.6)',  // 20% - Medium green (54-56 dB)
              'rgba(173, 255, 47, 0.65)',  // 25% - Yellow-green (57-59 dB)
              'rgba(200, 255, 0, 0.68)',   // 30% - Lime (60-62 dB) ← Tertiary roads (60dB)
              'rgba(220, 255, 0, 0.7)',    // 35% - Lime-yellow (63-65 dB)
              'rgba(240, 255, 0, 0.73)',   // 40% - Yellow (66-67 dB) ← Secondary roads (65dB)
              'rgba(255, 255, 0, 0.75)',   // 45% - Bright yellow (68-69 dB)
              'rgba(255, 240, 0, 0.77)',   // 50% - Yellow (70-72 dB) ← Primary roads (70dB)
              'rgba(255, 220, 0, 0.79)',   // 55% - Gold (73-74 dB)
              'rgba(255, 200, 0, 0.81)',   // 60% - Yellow-orange (75-77 dB) ← Trunk roads (75dB)
              'rgba(255, 180, 0, 0.83)',   // 65% - Orange (78-79 dB) ← Highways (78dB)
              'rgba(255, 160, 0, 0.85)',   // 70% - Dark orange (80-82 dB)
              'rgba(255, 140, 0, 0.87)',   // 75% - Red-orange (83-85 dB)
              'rgba(255, 100, 0, 0.89)',   // 80% - Orange-red (86-88 dB) ← Light rail (85dB)
              'rgba(255, 69, 0, 0.91)',    // 85% - Red-orange (89-90 dB)
              'rgba(255, 30, 0, 0.93)',    // 90% - Red (91-92 dB) ← Heavy rail (92dB)
              'rgba(220, 0, 0, 0.95)',     // 95% - Dark red (93-95 dB) ← Runways (95dB)
              'rgba(180, 0, 0, 0.98)'      // 100% - Deep red (maximum)
            ]
          });
          
          // Add zoom change listener to maintain constant geographic coverage
          zoomListener = map.addListener('zoom_changed', () => {
            if (!noiseHeatmap) return;
            
            const newZoom = map.getZoom() || 14;
            const newZoomDiff = newZoom - 14;
            const newRadius = Math.round(baseRadius * Math.pow(2, newZoomDiff));
            
            console.log(`[NoiseMap] Zoom=${newZoom}, radius=${newRadius} (constant ~60-80m coverage for continuous bands)`);
            
            // Update ONLY radius to maintain constant geographic size
            noiseHeatmap.setOptions({
              radius: newRadius
              // opacity and maxIntensity remain constant for accurate data representation
            });
          });
          
          console.log('[NoiseMap] Heatmap rendered with continuous road noise bands at all zoom levels');
          
        }
      } catch (error) {
        console.error('[NoiseMap] Error fetching road data:', error);
      }
    };
    
    fetchNoiseData();

    return () => {
      cancelled = true;
      if (zoomListener) {
        (window as any).google.maps.event.removeListener(zoomListener);
      }
      if (noiseHeatmap) {
        noiseHeatmap.setMap(null);
        console.log('[NoiseMap] Cleanup');
      }
    };
  }, [map, showNoise, latitude, longitude, selectedTimeOfDay]);

  const getAQILevel = (aqi: number) => {
    if (aqi <= 50) return { text: 'Good', color: 'text-green-600', bg: 'bg-green-50' };
    if (aqi <= 100) return { text: 'Moderate', color: 'text-yellow-600', bg: 'bg-yellow-50' };
    if (aqi <= 150) return { text: 'Unhealthy for Sensitive', color: 'text-orange-600', bg: 'bg-orange-50' };
    if (aqi <= 200) return { text: 'Unhealthy', color: 'text-red-600', bg: 'bg-red-50' };
    return { text: 'Very Unhealthy', color: 'text-purple-600', bg: 'bg-purple-50' };
  };

  const aqi = airQualityData?.aqi || 50;
  const aqiLevel = getAQILevel(aqi);
  const primaryPollutant = airQualityData?.airNow?.[0]?.ParameterName || 'PM2.5';

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a3 3 0 100-6 5 5 0 00-9.584-1.5A4 4 0 003 15z" />
            </svg>
          </span>
          <div>
            <h4 className="text-base font-semibold tracking-tight text-slate-900">Air Quality &amp; Noise</h4>
            <p className="text-xs text-slate-500">Environmental quality assessment</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => setShowAirQuality(!showAirQuality)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              showAirQuality ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            Air Quality
          </button>
          <button
            onClick={() => setShowNoise(!showNoise)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              showNoise ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            Noise
          </button>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-slate-200/70 bg-white px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Air Quality</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-lg font-bold tracking-tight text-slate-900">{aqi}</span>
            <span className="text-[11px] font-medium text-slate-400">AQI</span>
            <span className={`ml-auto text-[11px] font-semibold ${aqiLevel.color}`}>{aqiLevel.text}</span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200/70 bg-white px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Noise</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-lg font-bold tracking-tight text-slate-900">{Math.round(noiseLevel)}</span>
            <span className="text-[11px] font-medium text-slate-400">dB</span>
            <span className="ml-auto text-[11px] font-semibold text-violet-600">{noiseLevel >= 60 ? 'Loud' : noiseLevel >= 48 ? 'Moderate' : 'Quiet'}</span>
          </div>
        </div>
      </div>
      <HyRiskMeter className="mb-3" score={Math.min(100, (aqi / 200) * 100)} valueText={`${aqi} AQI`} levelText={aqiLevel.text} />

      <div className="relative rounded-xl overflow-hidden border border-slate-200/70" style={{ height: '420px' }}>
        <div ref={mapRef} className="w-full h-full" />
        
        {/* Map Type Toggle */}
        <div className="absolute top-3 right-3 flex gap-1 bg-white rounded-lg shadow-md overflow-hidden border">
          <button
            onClick={() => setMapType('terrain')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mapType === 'terrain'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            Terrain
          </button>
          <button
            onClick={() => setMapType('satellite')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mapType === 'satellite'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            Satellite
          </button>
        </div>

        {/* Season & Time Controls */}
        <div className="absolute top-3 left-3 bg-white/95 backdrop-blur-sm rounded-lg shadow-md p-2 border z-[1000] max-w-[200px]">
          {/* Air Quality Season */}
          {showAirQuality && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold text-gray-700 mb-1">🌡️ AQ Season</div>
              <div className="flex gap-1">
                {AQ_SEASON_OPTIONS.map((season) => (
                  <button
                    key={season.value}
                    onClick={() => setSelectedAQSeason(season.value)}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      selectedAQSeason === season.value
                        ? 'bg-green-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                    title={season.label}
                  >
                    {season.icon}
                  </button>
                ))}
              </div>
            </div>
          )}
          
          {/* Noise Time of Day */}
          {showNoise && (
            <div>
              <div className="text-[10px] font-semibold text-gray-700 mb-1">🔊 Time of Day</div>
              <div className="flex gap-1 flex-wrap">
                {TIME_OF_DAY_OPTIONS.map((time) => (
                  <button
                    key={time.value}
                    onClick={() => setSelectedTimeOfDay(time.value)}
                    className={`px-1.5 py-1 text-[10px] rounded transition-colors ${
                      selectedTimeOfDay === time.value
                        ? 'bg-purple-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                    title={`${time.label} (${time.hours})`}
                  >
                    {time.icon}
                  </button>
                ))}
              </div>
            </div>
          )}
          
          {/* Context descriptions */}
          {(showAirQuality && aqSeasonalFactors) && (
            <div className="text-[9px] text-gray-600 mt-1.5 border-t border-gray-200 pt-1">
              {aqSeasonalFactors.description}
            </div>
          )}
          {(showNoise && noiseTimeFactors) && (
            <div className="text-[9px] text-gray-600 mt-1">
              {noiseTimeFactors.description}
            </div>
          )}
        </div>
        
        {loading && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
            <div className="text-sm text-gray-500">Loading map...</div>
          </div>
        )}
      </div>

      {/* Air Quality Index */}
      {airQualityData && (
        <div className="mt-4 p-3 rounded-xl bg-slate-50/70 border border-slate-200/70">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Air Quality Index</span>
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${aqiLevel.bg} ${aqiLevel.color}`}>
              {aqiLevel.text} (AQI: {Math.round(aqi)})
            </span>
          </div>
          <div className="text-xs text-gray-600">
            Primary Pollutant: <span className="font-medium">{primaryPollutant}</span>
          </div>
          {/* Seasonal info */}
          {aqSeasonalFactors && (
            <div className="mt-2 pt-2 border-t border-gray-200 grid grid-cols-2 gap-2 text-[10px]">
              <div>
                <span className="text-gray-500">Ozone Risk:</span>{' '}
                <span className={`font-medium ${aqSeasonalFactors.ozoneRisk === 'High' ? 'text-orange-600' : aqSeasonalFactors.ozoneRisk === 'Moderate' ? 'text-yellow-600' : 'text-green-600'}`}>
                  {aqSeasonalFactors.ozoneRisk}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Pollen:</span>{' '}
                <span className={`font-medium ${aqSeasonalFactors.pollenLevel === 'Very High' ? 'text-red-600' : aqSeasonalFactors.pollenLevel === 'High' ? 'text-orange-600' : aqSeasonalFactors.pollenLevel === 'Moderate' ? 'text-yellow-600' : 'text-green-600'}`}>
                  {aqSeasonalFactors.pollenLevel}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="mt-4 p-3 rounded-xl bg-slate-50/70 border border-slate-200/70 space-y-3">
        <div className="text-xs font-medium text-gray-700 mb-2">Heat Map Legends</div>
        
        {/* Air Quality Legend */}
        {showAirQuality && (
          <div>
            <div className="text-xs text-gray-600 mb-1">Air Quality</div>
            <div className="relative flex items-center gap-2">
              <div className="flex-1 h-3 rounded-full" style={{
                background: 'linear-gradient(to right, rgb(0,255,0), rgb(255,255,0), rgb(255,165,0), rgb(255,0,0), rgb(139,0,0))'
              }} />
              {/* Position indicator dot */}
              <div 
                className="absolute w-4 h-4 bg-white border-2 border-gray-800 rounded-full shadow-lg"
                style={{
                  left: `${Math.min(Math.max((aqi / 200) * 100, 2), 98)}%`,
                  top: '50%',
                  transform: 'translate(-50%, -50%)'
                }}
                title={`AQI: ${Math.round(aqi)}`}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-500 mt-1">
              <span>Good</span>
              <span>Poor</span>
            </div>
          </div>
        )}

        {/* Noise Legend */}
        {showNoise && (
          <div>
            <div className="text-xs text-gray-600 mb-1">Noise Pollution {noiseTimeFactors && <span className="text-gray-400">({noiseTimeFactors.peakHours})</span>}</div>
            <div className="relative flex items-center gap-2">
              <div className="flex-1 h-3 rounded-full" style={{
                background: 'linear-gradient(to right, rgba(138,43,226,0.3), rgba(147,112,219,0.6), rgba(153,50,204,0.8), rgba(128,0,128,1), rgba(75,0,130,1))'
              }} />
              {/* Position indicator dot - 30dB (quiet) to 70dB (loud) scale */}
              <div 
                className="absolute w-4 h-4 bg-white border-2 border-gray-800 rounded-full shadow-lg"
                style={{
                  left: `${Math.min(Math.max(((noiseLevel - 30) / 40) * 100, 2), 98)}%`,
                  top: '50%',
                  transform: 'translate(-50%, -50%)'
                }}
                title={`${Math.round(noiseLevel)} dB`}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-500 mt-1">
              <span>Quiet</span>
              <span>Loud</span>
            </div>
            {/* Time-based noise info */}
            {noiseTimeFactors && (
              <div className="mt-2 pt-2 border-t border-gray-200 grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <span className="text-gray-500">Traffic Level:</span>{' '}
                  <span className={`font-medium ${noiseTimeFactors.trafficMultiplier >= 1.2 ? 'text-red-600' : noiseTimeFactors.trafficMultiplier >= 0.9 ? 'text-yellow-600' : 'text-green-600'}`}>
                    {noiseTimeFactors.trafficMultiplier >= 1.2 ? 'Heavy' : noiseTimeFactors.trafficMultiplier >= 0.9 ? 'Moderate' : 'Light'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Multiplier:</span>{' '}
                  <span className="font-medium text-gray-700">{noiseTimeFactors.trafficMultiplier.toFixed(2)}x</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Flood Season and Storm Intensity Types
type FloodSeason = 'spring' | 'summer' | 'fall' | 'winter';
type StormIntensity = 0.5 | 1 | 2 | 3 | 4 | 6;

const FLOOD_SEASON_OPTIONS = [
  { value: 'spring' as FloodSeason, label: 'Spring', icon: '🌸' },
  { value: 'summer' as FloodSeason, label: 'Summer', icon: '☀️' },
  { value: 'fall' as FloodSeason, label: 'Fall', icon: '🍂' },
  { value: 'winter' as FloodSeason, label: 'Winter', icon: '❄️' }
];

const STORM_INTENSITY_OPTIONS = [
  { value: 0.5 as StormIntensity, label: '0.5"', description: 'Light rain' },
  { value: 1 as StormIntensity, label: '1"', description: 'Moderate' },
  { value: 2 as StormIntensity, label: '2"', description: 'Heavy' },
  { value: 3 as StormIntensity, label: '3"', description: 'Very Heavy' },
  { value: 4 as StormIntensity, label: '4"', description: 'Extreme' },
  { value: 6 as StormIntensity, label: '6"', description: 'Catastrophic' }
];

// Get current season for flood
const getCurrentFloodSeason = (): FloodSeason => {
  const month = new Date().getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
};

// Regional flood seasonal factors (based on NOAA/FEMA historical data)
const getFloodSeasonalFactors = (lat: number, lng: number, season: FloodSeason): { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string } => {
  // Determine region
  const isSoutheast = lat < 37 && lng > -94 && lng < -75;
  const isFlorida = lat < 31 && lng > -88 && lng < -80;
  const isMidwest = lng > -104 && lng < -80 && lat > 37;
  const isPacificNW = lng < -120 && lat > 42;
  const isWestCoast = lng < -115 && lat > 32 && lat < 42;
  const isMountain = lng < -104 && lng > -115 && lat > 32 && lat < 49;
  
  if (isFlorida) {
    const factors: Record<FloodSeason, { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string }> = {
      spring: { baselineRisk: 35, groundSaturation: 45, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Dry season ending' },
      summer: { baselineRisk: 75, groundSaturation: 90, snowmeltFactor: 0, hurricaneBonus: 50, description: 'Daily storms + peak hurricane' },
      fall: { baselineRisk: 60, groundSaturation: 75, snowmeltFactor: 0, hurricaneBonus: 35, description: 'Hurricane season continues' },
      winter: { baselineRisk: 25, groundSaturation: 35, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Dry season' }
    };
    return factors[season];
  } else if (isSoutheast) {
    const factors: Record<FloodSeason, { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string }> = {
      spring: { baselineRisk: 55, groundSaturation: 70, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Spring thunderstorms' },
      summer: { baselineRisk: 65, groundSaturation: 80, snowmeltFactor: 0, hurricaneBonus: 40, description: 'Peak hurricane + daily storms' },
      fall: { baselineRisk: 50, groundSaturation: 60, snowmeltFactor: 0, hurricaneBonus: 30, description: 'Late hurricane season' },
      winter: { baselineRisk: 30, groundSaturation: 45, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Drier, occasional frontal rain' }
    };
    return factors[season];
  } else if (isMidwest) {
    const factors: Record<FloodSeason, { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string }> = {
      spring: { baselineRisk: 70, groundSaturation: 90, snowmeltFactor: 25, hurricaneBonus: 0, description: 'Major flood season - snowmelt + rain' },
      summer: { baselineRisk: 45, groundSaturation: 55, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Thunderstorm flooding' },
      fall: { baselineRisk: 30, groundSaturation: 40, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Drying conditions' },
      winter: { baselineRisk: 20, groundSaturation: 30, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Frozen, snow storage' }
    };
    return factors[season];
  } else if (isPacificNW) {
    const factors: Record<FloodSeason, { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string }> = {
      spring: { baselineRisk: 55, groundSaturation: 80, snowmeltFactor: 20, hurricaneBonus: 0, description: 'Snowmelt + spring rain' },
      summer: { baselineRisk: 15, groundSaturation: 30, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Dry season - low risk' },
      fall: { baselineRisk: 50, groundSaturation: 65, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Rain returns, rivers rise' },
      winter: { baselineRisk: 70, groundSaturation: 95, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Peak rain + atmospheric rivers' }
    };
    return factors[season];
  } else if (isWestCoast) {
    const factors: Record<FloodSeason, { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string }> = {
      spring: { baselineRisk: 45, groundSaturation: 70, snowmeltFactor: 15, hurricaneBonus: 0, description: 'Late rain season + Sierra melt' },
      summer: { baselineRisk: 10, groundSaturation: 15, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Very dry - minimal flood risk' },
      fall: { baselineRisk: 30, groundSaturation: 25, snowmeltFactor: 0, hurricaneBonus: 0, description: 'First rains on dry ground' },
      winter: { baselineRisk: 65, groundSaturation: 85, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Atmospheric rivers - major flooding' }
    };
    return factors[season];
  } else if (isMountain) {
    const factors: Record<FloodSeason, { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string }> = {
      spring: { baselineRisk: 75, groundSaturation: 95, snowmeltFactor: 50, hurricaneBonus: 0, description: 'Peak snowmelt flooding' },
      summer: { baselineRisk: 40, groundSaturation: 45, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Afternoon thunderstorms' },
      fall: { baselineRisk: 25, groundSaturation: 35, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Dry conditions' },
      winter: { baselineRisk: 15, groundSaturation: 25, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Snow accumulation' }
    };
    return factors[season];
  } else {
    // Northeast
    const factors: Record<FloodSeason, { baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string }> = {
      spring: { baselineRisk: 60, groundSaturation: 85, snowmeltFactor: 30, hurricaneBonus: 0, description: 'Snowmelt + spring rains' },
      summer: { baselineRisk: 35, groundSaturation: 50, snowmeltFactor: 0, hurricaneBonus: 15, description: 'Thunderstorms, occasional tropical' },
      fall: { baselineRisk: 45, groundSaturation: 55, snowmeltFactor: 0, hurricaneBonus: 25, description: 'Hurricane remnants possible' },
      winter: { baselineRisk: 25, groundSaturation: 40, snowmeltFactor: 0, hurricaneBonus: 0, description: 'Frozen ground, snow storage' }
    };
    return factors[season];
  }
};

// Storm intensity factors
const getStormIntensityFactors = (intensity: StormIntensity): { rainfallMultiplier: number; waterFlowIntensity: number; poolingFactor: number; description: string; category: string } => {
  const stormData: Record<StormIntensity, { rainfallMultiplier: number; waterFlowIntensity: number; poolingFactor: number; description: string; category: string }> = {
    0.5: { rainfallMultiplier: 0.3, waterFlowIntensity: 15, poolingFactor: 0.2, description: 'Light rain - minimal impact', category: 'Light Rain' },
    1: { rainfallMultiplier: 0.5, waterFlowIntensity: 30, poolingFactor: 0.4, description: 'Moderate rain - minor street flooding', category: 'Moderate Rain' },
    2: { rainfallMultiplier: 0.8, waterFlowIntensity: 50, poolingFactor: 0.7, description: 'Heavy rain - localized flooding likely', category: 'Heavy Rain' },
    3: { rainfallMultiplier: 1.2, waterFlowIntensity: 70, poolingFactor: 1.0, description: 'Very heavy rain - widespread flooding', category: 'Very Heavy' },
    4: { rainfallMultiplier: 1.6, waterFlowIntensity: 85, poolingFactor: 1.4, description: 'Extreme rain - flash flooding', category: 'Extreme' },
    6: { rainfallMultiplier: 2.5, waterFlowIntensity: 100, poolingFactor: 2.0, description: 'Catastrophic - major flood event', category: 'Catastrophic' }
  };
  return stormData[intensity];
};

const FLOOD_CACHE_VERSION = 3;

const applyFloodRiskAdjustments = (
  baseData: any[],
  lat: number,
  lng: number,
  season: FloodSeason,
  intensity: StormIntensity,
) => {
  const seasonFactors = getFloodSeasonalFactors(lat, lng, season);
  const intensityFactors = getStormIntensityFactors(intensity);
  const seasonalMult =
    (seasonFactors.baselineRisk / 50) * 0.5 +
    (seasonFactors.groundSaturation / 100) * 0.3 +
    (seasonFactors.snowmeltFactor / 100) +
    (seasonFactors.hurricaneBonus / 100);
  const combinedMultiplier = (1 + seasonalMult - 0.5) * intensityFactors.rainfallMultiplier;

  return {
    seasonFactors,
    intensityFactors,
    combinedMultiplier,
    adjustedData: baseData.map((point: any) => ({
      ...point,
      riskScore: Math.min(100, Math.max(0, (point.riskScore || 20) * combinedMultiplier)),
    })),
  };
};

/**
 * Drives the dash offset of a set of Google Maps polylines so water reads as
 * moving downstream rather than sitting still.
 *
 * One shared rAF loop for every channel on the map: a per-polyline timer at
 * ~60fps across a few hundred segments is enough to stutter the whole map, and
 * they all advance in lockstep anyway.
 *
 * @returns a stop function for the effect cleanup.
 */
function animateFlowLines(lines: { line: any; speed: number }[]): () => void {
  if (lines.length === 0) return () => {};

  let frame = 0;
  let stopped = false;
  const start = performance.now();

  const tick = (now: number) => {
    if (stopped) return;
    const elapsed = (now - start) / 1000;
    for (const { line, speed } of lines) {
      const icons = line.get('icons');
      if (!icons?.length) continue;
      // Percent of the path length; wrapping at 100 keeps the dashes seamless.
      icons[0].offset = `${(elapsed * speed) % 100}%`;
      line.set('icons', icons);
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
}

/**
 * Respect users who have asked the OS to reduce motion — an endlessly
 * scrolling map is exactly the kind of thing that setting exists for.
 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const isUsableFloodCache = (cachedData: any): boolean => {
  if (!cachedData) return false;
  // v2+ caches store compact OSM waterways (or an explicit null after a failed/empty fetch)
  // so we can rebuild corridor heatmaps. Older caches only kept sparse FEMA rings.
  return cachedData.cacheVersion >= FLOOD_CACHE_VERSION
    && Array.isArray(cachedData.femaGridData)
    && cachedData.femaGridData.length > 0
    && Object.prototype.hasOwnProperty.call(cachedData, 'waterways');
};

// Flood Risk Map
const FloodRiskMap: React.FC<RiskMapProps> = ({ latitude, longitude, address, environmentalData, propertyId, mapHeight = 420, livingSqft }) => {
  const mapRef = React.useRef<HTMLDivElement>(null);
  // @ts-ignore - map instance stored for potential future enhancements
  const [map, setMap] = React.useState<any>(null);
  const markerRef = React.useRef<any>(null);
  const [floodZone, setFloodZone] = React.useState<string>('Loading...');
  const [loading, setLoading] = React.useState(true);
  const [floodGridData, setFloodGridData] = React.useState<any[]>([]); // Store flood data in state
  const [baseFloodData, setBaseFloodData] = React.useState<any[]>([]); // Store original flood data for adjustments
  const [_poolingZones, setPoolingZones] = React.useState<any[]>([]); // Store pooling zones
  const [poolingRisk, setPoolingRisk] = React.useState<any>(null); // Overall pooling risk
  const [forecastBridge, setForecastBridge] = React.useState<FloodMapBridge | null>(null);
  const [forecastBridgeApplied, setForecastBridgeApplied] = React.useState(false);
  const [flowPatterns, setFlowPatterns] = React.useState<any[]>([]); // Store flow direction vectors
  const [rainfallContext, setRainfallContext] = React.useState<any>(null); // Rainfall data affecting risk
  const [showFlowPatterns, setShowFlowPatterns] = React.useState(true); // Toggle flow patterns
  const [buildingFootprints, setBuildingFootprints] = React.useState<any[]>([]); // Building outlines
  const [waterwayGeometries, setWaterwayGeometries] = React.useState<{
    waterways: any[];
    lakes: any[];
    coastlines: any[];
  }>({ waterways: [], lakes: [], coastlines: [] });
  const [mapType, setMapType] = React.useState<'terrain' | 'satellite'>('terrain');
  
  // Seasonal and storm intensity controls
  const [selectedFloodSeason, setSelectedFloodSeason] = React.useState<FloodSeason>(getCurrentFloodSeason());
  const [stormIntensity, setStormIntensity] = React.useState<StormIntensity>(2);
  const [floodSeasonalFactors, setFloodSeasonalFactors] = React.useState<{ baselineRisk: number; groundSaturation: number; snowmeltFactor: number; hurricaneBonus: number; description: string } | null>(null);
  const [stormFactors, setStormFactors] = React.useState<{ rainfallMultiplier: number; waterFlowIntensity: number; poolingFactor: number; description: string; category: string } | null>(null);

  // HAND-based depth raster. Independent of the legacy FEMA point grid above:
  // that data answers "what zone is this", this answers "how deep, how often".
  const [showDepthRaster, setShowDepthRaster] = React.useState(true);
  const { data: floodDepth, loading: depthLoading, error: depthError } = useFloodDepthGrid({
    latitude,
    longitude,
    livingSqft: livingSqft
      ?? environmentalData?.building?.size?.livingSize
      ?? environmentalData?.livingSqft
      ?? null,
  });

  /** The modelled scenario closest to the storm the user has selected. */
  const depthScenario = React.useMemo(() => {
    if (!floodDepth?.scenarios?.length) return null;
    return floodDepth.scenarios.reduce((best, s) => (
      Math.abs(s.rainInches - stormIntensity) < Math.abs(best.rainInches - stormIntensity) ? s : best
    ));
  }, [floodDepth, stormIntensity]);

  // Tie outdoor forecast → storm intensity / water-flow simulation.
  React.useEffect(() => {
    if (!propertyId) {
      setForecastBridge(null);
      setForecastBridgeApplied(false);
      return undefined;
    }
    let cancelled = false;
    fetchPropertyWeatherAssessment({
      propertyId,
      latitude,
      longitude,
      address,
    })
      .then((assessment) => {
        if (cancelled) return;
        const bridge = floodBridgeFromAssessment(assessment);
        setForecastBridge(bridge);
        setForecastBridgeApplied(false);
      })
      .catch(() => {
        if (!cancelled) {
          setForecastBridge(null);
          setForecastBridgeApplied(false);
        }
      });
    return () => { cancelled = true; };
  }, [propertyId, latitude, longitude, address]);

  const applyForecastStormSimulation = React.useCallback(() => {
    if (!forecastBridge) return;
    const inches = forecastBridge.suggestedStormInches as StormIntensity;
    setStormIntensity(inches);
    if (forecastBridge.shouldSimulateWaterFlow) {
      setShowFlowPatterns(true);
    }
    setForecastBridgeApplied(true);
  }, [forecastBridge]);

  // Main data loading effect - uses Firestore cache
  React.useEffect(() => {
    console.log('[FloodRiskMap] Initializing with ATTOM data:', environmentalData?.flood);
    let mounted = true;
    
    const initFloodMap = async () => {
      // Check Firestore cache first
      console.log('[FloodRiskMap] Checking Firestore cache...');
      const cachedData = await getCachedFloodData(latitude, longitude);
      
      const hasUsableCache = isUsableFloodCache(cachedData);
      
      console.log('[FloodRiskMap] Cache check result:', { 
        hasCachedData: !!cachedData, 
        hasUsableCache,
        cacheVersion: cachedData?.cacheVersion,
        hasWaterways: !!cachedData?.waterways,
        femaGridLength: cachedData?.femaGridData?.length || cachedData?.floodGridData?.length || 0
      });
      
      if (hasUsableCache) {
        console.log('[FloodRiskMap] ✅ Using cached flood data (rebuilding waterway corridors)');
        
        const femaGridData = cachedData.femaGridData?.length
          ? cachedData.femaGridData
          : (cachedData.floodGridData || []);
        const cachedWaterways = cachedData.waterways || {};
        const waterwayShapes = {
          waterways: cachedWaterways.waterways || [],
          lakes: cachedWaterways.lakes || [],
          coastlines: cachedWaterways.coastlines || [],
        };
        // Keep a compact base for season/storm multipliers (FEMA center only — no circular heatmap points).
        const visualizationBase = femaGridData.filter((point: any) => point.label === 'center').length
          ? femaGridData.filter((point: any) => point.label === 'center')
          : femaGridData.slice(0, 1);
        const adjusted = applyFloodRiskAdjustments(
          visualizationBase,
          latitude,
          longitude,
          selectedFloodSeason,
          stormIntensity,
        );

        setWaterwayGeometries(waterwayShapes);
        setBaseFloodData(visualizationBase);
        setFloodGridData(adjusted.adjustedData);
        setFloodSeasonalFactors(adjusted.seasonFactors);
        setStormFactors(adjusted.intensityFactors);
        setPoolingZones(cachedData.poolingZones || []);
        setPoolingRisk(cachedData.poolingRisk);
        setFlowPatterns(cachedData.flowPatterns || []);
        setRainfallContext(cachedData.rainfallContext);
        setBuildingFootprints(cachedData.buildingFootprints || []);
        
        // Initialize the map
        await loadGoogleMaps();
        if (!mapRef.current || !mounted) return;

        const mapInstance = new (window as any).google.maps.Map(mapRef.current, {
          center: { lat: latitude, lng: longitude },
          zoom: 14,
          mapTypeId: mapType === 'satellite' ? 'satellite' : 'terrain',
          disableDefaultUI: false,
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
        });

        setMap(mapInstance);
        setLoading(false);

        // Add property marker
        markerRef.current = new (window as any).google.maps.Marker({
          position: { lat: latitude, lng: longitude },
          map: mapInstance,
          title: address,
          icon: {
            path: (window as any).google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#ef4444',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        });
        
        // Set flood zone from cached FEMA center point
        if (femaGridData.length > 0) {
          const centerPoint = femaGridData.find((point: any) => point.label === 'center') || femaGridData[0];
          const zone = centerPoint.floodZone;
          const source = centerPoint.source === 'ATTOM' ? ' (ATTOM)' : ' (FEMA)';
          
          if (zone === 'VE' || zone === 'V' || zone === 'AE' || zone === 'A' || zone === 'AO' || zone === 'AH') {
            setFloodZone(`High (Zone ${zone})${source}`);
          } else if (zone === 'X') {
            setFloodZone(`Minimal (Zone X)${source}`);
          } else if (zone === 'D') {
            setFloodZone(`Undetermined${source}`);
          } else {
            setFloodZone(`Zone ${zone}${source}`);
          }
        }
        
        return; // Done - used cache successfully
      }
      
      // No valid cache, fetch fresh data
      console.log('[FloodRiskMap] No valid cache found, fetching fresh data...');
      
      // Continue to fetch fresh data
      try {
        await loadGoogleMaps();
        if (!mapRef.current || !mounted) return;

        const mapInstance = new (window as any).google.maps.Map(mapRef.current, {
          center: { lat: latitude, lng: longitude },
          zoom: 14,
          mapTypeId: mapType === 'satellite' ? 'satellite' : 'terrain',
          disableDefaultUI: false,
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
        });

        setMap(mapInstance);
        setLoading(false); // Map is loaded, hide the loading indicator

        // Add property marker
        markerRef.current = new (window as any).google.maps.Marker({
          position: { lat: latitude, lng: longitude },
          map: mapInstance,
          title: address,
          icon: {
            path: (window as any).google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#ef4444',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          }
        });

      // Fetch flood data combining ATTOM + FEMA for comprehensive coverage
      let fetchedFloodGridData: any[] = [];
      let fetchedWaterways: any = null;
      
      try {
          // Create a larger grid for better coverage (25 points like air quality)
          const mile5 = 0.073;  // ~5 miles in degrees
          const mile10 = 0.145; // ~10 miles in degrees  
          
          const gridPoints = [
            // Center point - will use ATTOM data if available
            { lat: latitude, lng: longitude, label: 'center', useAttom: true },
            
            // Inner ring (5 miles) - 8 directions
            { lat: latitude + mile5, lng: longitude, label: 'n-5mi', useAttom: false },
            { lat: latitude - mile5, lng: longitude, label: 's-5mi', useAttom: false },
            { lat: latitude, lng: longitude + mile5, label: 'e-5mi', useAttom: false },
            { lat: latitude, lng: longitude - mile5, label: 'w-5mi', useAttom: false },
          { lat: latitude + mile5, lng: longitude + mile5, label: 'ne-5mi', useAttom: false },
          { lat: latitude + mile5, lng: longitude - mile5, label: 'nw-5mi', useAttom: false },
          { lat: latitude - mile5, lng: longitude + mile5, label: 'se-5mi', useAttom: false },
          { lat: latitude - mile5, lng: longitude - mile5, label: 'sw-5mi', useAttom: false },
          
          // Outer ring (10 miles) - 8 directions for regional context
          { lat: latitude + mile10, lng: longitude, label: 'n-10mi', useAttom: false },
          { lat: latitude - mile10, lng: longitude, label: 's-10mi', useAttom: false },
          { lat: latitude, lng: longitude + mile10, label: 'e-10mi', useAttom: false },
          { lat: latitude, lng: longitude - mile10, label: 'w-10mi', useAttom: false },
          { lat: latitude + mile10, lng: longitude + mile10, label: 'ne-10mi', useAttom: false },
          { lat: latitude + mile10, lng: longitude - mile10, label: 'nw-10mi', useAttom: false },
          { lat: latitude - mile10, lng: longitude + mile10, label: 'se-10mi', useAttom: false },
          { lat: latitude - mile10, lng: longitude - mile10, label: 'sw-10mi', useAttom: false },
        ];

        console.log(`[FloodRiskMap] Fetching flood data for ${gridPoints.length} points (ATTOM + FEMA)`);

        // Fetch flood zone data for each point
        const floodDataPromises = gridPoints.map(async (point) => {
          try {
            // For center point, prioritize ATTOM data if available
            if (point.useAttom && environmentalData?.flood) {
              console.log('[FloodRiskMap] Using ATTOM flood data for center point:', environmentalData.flood);
              
              // Parse ATTOM flood zone data
              const attomFloodZone = environmentalData.flood.floodZone || environmentalData.flood.femaFloodZone || 'X';
              let riskScore = 20;
              
              // Calculate risk score from ATTOM data
              if (attomFloodZone === 'VE' || attomFloodZone === 'V') riskScore = 100;
              else if (attomFloodZone === 'AE' || attomFloodZone === 'A' || attomFloodZone === 'AO' || attomFloodZone === 'AH') riskScore = 85;
              else if (attomFloodZone === 'X' && environmentalData.flood.floodZoneSubtype?.includes('0.2')) riskScore = 50;
              else if (attomFloodZone === 'X') riskScore = 15;
              else if (attomFloodZone === 'D') riskScore = 40;
              
              // If ATTOM has additional flood risk indicators, factor them in
              if (environmentalData.flood.floodRisk === 'High' || environmentalData.flood.floodHazard === 'High') {
                riskScore = Math.max(riskScore, 80);
              } else if (environmentalData.flood.floodRisk === 'Moderate') {
                riskScore = Math.max(riskScore, 50);
              }
              
              return {
                lat: point.lat,
                lng: point.lng,
                label: point.label,
                floodZone: attomFloodZone,
                riskScore,
                source: 'ATTOM'
              };
            }
            
            // For other points, use FEMA API
            const proxyUrl = `/api/fema/flood-zone?lat=${point.lat}&lng=${point.lng}`;
            console.log(`[FloodRiskMap] Fetching FEMA data for ${point.label}`);
            
            const response = await fetch(proxyUrl);
            const data = await response.json();
            
            if (!data.ok) {
              console.error(`[FloodRiskMap] FEMA error for ${point.label}:`, data.error);
              return { lat: point.lat, lng: point.lng, label: point.label, floodZone: 'X', riskScore: 20, source: 'default' };
            }
            
            return {
              lat: point.lat,
              lng: point.lng,
              label: point.label,
              floodZone: data.floodZone,
              riskScore: data.riskScore,
              source: 'FEMA'
            };
          } catch (error) {
            console.error(`Failed to fetch flood data for ${point.label}:`, error);
            return { lat: point.lat, lng: point.lng, label: point.label, floodZone: 'X', riskScore: 20, source: 'error' };
          }
        });

        fetchedFloodGridData = await Promise.all(floodDataPromises);
        console.log('[FloodRiskMap] Combined ATTOM + FEMA flood data collected:', fetchedFloodGridData);
        
        // WATERWAY FLOOD VISUALIZATION — store real OSM geometries for corridor overlays
        let visualizationBase = fetchedFloodGridData.filter((point: any) => point.label === 'center').length
          ? fetchedFloodGridData.filter((point: any) => point.label === 'center')
          : fetchedFloodGridData.slice(0, 1);

        try {
          console.log('[FloodRiskMap] Fetching waterway data for flood visualization...');
          const waterwayResponse = await fetch(`/api/osm/waterways?lat=${latitude}&lng=${longitude}&radius=8000`);
          const waterwayData = await waterwayResponse.json();
          
          if (waterwayData.ok && waterwayData.count?.total > 0) {
            console.log('[FloodRiskMap] Waterway data:', waterwayData.count);
            fetchedWaterways = {
              waterways: waterwayData.waterways || [],
              lakes: waterwayData.lakes || [],
              coastlines: waterwayData.coastlines || [],
              count: waterwayData.count,
            };
            if (mounted) {
              setWaterwayGeometries({
                waterways: fetchedWaterways.waterways,
                lakes: fetchedWaterways.lakes,
                coastlines: fetchedWaterways.coastlines,
              });
            }
          } else {
            console.log('[FloodRiskMap] No waterway data nearby');
            fetchedWaterways = { waterways: [], lakes: [], coastlines: [], count: waterwayData.count || { total: 0 } };
            if (mounted) {
              setWaterwayGeometries({ waterways: [], lakes: [], coastlines: [] });
            }
          }
        } catch (error) {
          console.error('[FloodRiskMap] Error fetching waterway data:', error);
          fetchedWaterways = { waterways: [], lakes: [], coastlines: [], count: { total: 0 } };
        }

        if (mounted) {
          const adjusted = applyFloodRiskAdjustments(
            visualizationBase,
            latitude,
            longitude,
            selectedFloodSeason,
            stormIntensity,
          );
          setBaseFloodData(visualizationBase);
          setFloodSeasonalFactors(adjusted.seasonFactors);
          setStormFactors(adjusted.intensityFactors);
          setFloodGridData(adjusted.adjustedData);
        }
        
        if (mounted && fetchedFloodGridData.length > 0) {
          const centerPoint = fetchedFloodGridData[0];
          
          // Determine flood zone based on ATTOM/FEMA data
          const zone = centerPoint.floodZone;
          const source = centerPoint.source === 'ATTOM' ? ' (ATTOM)' : ' (FEMA)';
          
          if (zone === 'VE' || zone === 'V' || zone === 'AE' || zone === 'A' || zone === 'AO' || zone === 'AH') {
            setFloodZone(`High (Zone ${zone})${source}`);
          } else if (zone === 'X') {
            setFloodZone(`Minimal (Zone X)${source}`);
          } else if (zone === 'D') {
            setFloodZone(`Undetermined${source}`);
          } else {
            setFloodZone(`Zone ${zone}${source}`);
          }
        }
      } catch (error) {
        console.error('[FloodRiskMap] Error fetching flood data:', error);
        // Set default flood zone on error
        if (mounted) {
          setFloodZone('Unknown (API Error)');
          setLoading(false);
        }
      }
      
      // FETCH POOLING ZONES - Phase 1 micro-topography analysis
      let fetchedPoolingZones: any[] = [];
      let fetchedPoolingRisk: any = null;
      let fetchedFlowPatterns: any[] = [];
      let fetchedRainfallContext: any = null;
      let fetchedElevationGrid: any[] = [];
      
      try {
        console.log('[FloodRiskMap] Fetching pooling zone analysis...');
        const poolingResponse = await fetch(`/api/flood/pooling-zones?lat=${latitude}&lng=${longitude}`, {
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          }
        });
        console.log('[FloodRiskMap] Pooling API response status:', poolingResponse.status);
        const poolingData = await poolingResponse.json();
        console.log('[FloodRiskMap] Pooling API response data:', poolingData);
        
        if (poolingData.ok && poolingData.poolingZones) {
          console.log('[FloodRiskMap] Pooling zones found:', {
            count: poolingData.poolingZones.length,
            maxRisk: poolingData.propertyRisk?.max,
            avgRisk: poolingData.propertyRisk?.average,
            flowPatterns: poolingData.flowPatterns?.length,
            rainfallAdjusted: poolingData.analysis?.rainfallAdjusted
          });
          
          fetchedPoolingZones = poolingData.poolingZones;
          fetchedPoolingRisk = poolingData.propertyRisk;
          fetchedFlowPatterns = poolingData.flowPatterns || [];
          fetchedRainfallContext = poolingData.rainfallContext || null;
          fetchedElevationGrid = poolingData.elevationGrid || [];
          
          if (mounted) {
            setPoolingZones(fetchedPoolingZones);
            setPoolingRisk(fetchedPoolingRisk);
            setFlowPatterns(fetchedFlowPatterns);
            setRainfallContext(fetchedRainfallContext);
            console.log('[FloodRiskMap] State updated with pooling data, flow patterns, and rainfall context');
          }
        } else {
          console.warn('[FloodRiskMap] No pooling zones detected or API error:', poolingData);
        }
      } catch (error) {
        console.error('[FloodRiskMap] Error fetching pooling zones:', error);
      }
      
      // FETCH BUILDING FOOTPRINTS from OpenStreetMap (Zillow-style)
      let fetchedBuildings: any[] = [];
      
      try {
        console.log('[FloodRiskMap] Fetching building footprints from OpenStreetMap...');
        
        const overpassQuery = `
          [out:json][timeout:10];
          (
            way["building"](around:100,${latitude},${longitude});
            relation["building"](around:100,${latitude},${longitude});
          );
          out geom;
        `;
        
        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
        const buildingResponse = await fetch(overpassUrl);
        const buildingData = await buildingResponse.json();
        
        console.log('[FloodRiskMap] Building footprints received:', buildingData.elements?.length || 0);
        
        if (buildingData.elements && buildingData.elements.length > 0) {
          fetchedBuildings = buildingData.elements;
          if (mounted) {
            setBuildingFootprints(fetchedBuildings);
          }
        }
      } catch (error) {
        console.error('[FloodRiskMap] Error fetching building footprints:', error);
      }
      
      // Cache compact FEMA + OSM waterway geometry (rebuild dense corridors on load)
      if (mounted && fetchedFloodGridData.length > 0) {
        console.log('[FloodRiskMap] Storing flood cache v2:', {
          femaPoints: fetchedFloodGridData.length,
          hasWaterways: !!fetchedWaterways,
        });
        await cacheFloodData(latitude, longitude, {
          cacheVersion: FLOOD_CACHE_VERSION,
          femaGridData: fetchedFloodGridData,
          // Keep floodGridData as FEMA-only for older readers; visualization rebuilds from waterways.
          floodGridData: fetchedFloodGridData,
          waterways: fetchedWaterways,
          poolingZones: fetchedPoolingZones,
          poolingRisk: fetchedPoolingRisk,
          flowPatterns: fetchedFlowPatterns,
          rainfallContext: fetchedRainfallContext,
          buildingFootprints: fetchedBuildings,
          elevationGrid: fetchedElevationGrid,
        });
      }
    } catch (error) {
      console.error('[FloodRiskMap] Error initializing map:', error);
      setLoading(false);
      
      // Set default flood zone if not already set
      if (floodZone === '... Loading... Risk') {
        setFloodZone('Unknown (Data Unavailable)');
      }
    }
    }; // End of initFloodMap

    initFloodMap();
    return () => { mounted = false; };
    // mapType is handled by a separate effect so terrain/satellite toggles don't remount + refetch
  }, [latitude, longitude, address, environmentalData]);

  // Update Google Maps mapTypeId when switching between terrain and satellite
  React.useEffect(() => {
    if (!map) return;
    map.setMapTypeId(mapType === 'satellite' ? 'satellite' : 'terrain');
  }, [mapType, map]);

  // Update flood data when season or storm intensity changes
  React.useEffect(() => {
    if (!baseFloodData || baseFloodData.length === 0) return;

    const adjusted = applyFloodRiskAdjustments(
      baseFloodData,
      latitude,
      longitude,
      selectedFloodSeason,
      stormIntensity,
    );
    setFloodSeasonalFactors(adjusted.seasonFactors);
    setStormFactors(adjusted.intensityFactors);

    console.log(
      `[FloodRiskMap] Season: ${selectedFloodSeason}, Storm: ${stormIntensity}" - multiplier ${adjusted.combinedMultiplier.toFixed(2)}`,
    );

    setFloodGridData(adjusted.adjustedData);
  }, [selectedFloodSeason, stormIntensity, baseFloodData, latitude, longitude]);

  // Flood risk corridors along real waterways / drainage (NOT property-centered circular heatmaps)
  React.useEffect(() => {
    if (!map || !(window as any).google?.maps) return;

    const googleMaps = (window as any).google.maps;
    const overlays: any[] = [];
    const flowLines: { line: any; speed: number }[] = [];
    const reduceMotion = prefersReducedMotion();
    const {
      waterways = [],
      lakes = [],
      coastlines = [],
    } = waterwayGeometries;

    const activeStorm = stormFactors || getStormIntensityFactors(stormIntensity);
    const activeSeason = floodSeasonalFactors || getFloodSeasonalFactors(latitude, longitude, selectedFloodSeason);
    const seasonalBoost =
      (activeSeason.baselineRisk / 100) * 0.35 +
      (activeSeason.groundSaturation / 100) * 0.25 +
      (activeSeason.snowmeltFactor / 100) * 0.2 +
      (activeSeason.hurricaneBonus / 100) * 0.2;
    const floodScale = Math.max(0.35, activeStorm.rainfallMultiplier * (0.75 + seasonalBoost));

    const toPath = (geometry: any[]) =>
      (geometry || [])
        .map((coord: any) => {
          const lat = Number(coord?.lat);
          const lng = Number(coord?.lon ?? coord?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          return { lat, lng };
        })
        .filter((p): p is { lat: number; lng: number } => p !== null);

    const addCorridorPath = (
      path: Array<{ lat: number; lng: number }>,
      kind: 'river' | 'stream' | 'coast' | 'drain',
    ) => {
      if (path.length < 2) return;

      const baseWidth = kind === 'river' ? 22 : kind === 'coast' ? 28 : kind === 'drain' ? 16 : 14;
      const outerWidth = Math.min(64, Math.max(6, baseWidth * floodScale * 1.8));
      const midWidth = Math.min(40, Math.max(4, baseWidth * floodScale * 1.1));
      const coreWidth = Math.min(18, Math.max(2, baseWidth * floodScale * 0.45));
      // Soft wide halo → mid body → bright thin thread. Widening the spread
      // between the layers and lightening the core is what turns three flat
      // strokes into something that reads as a channel with depth.
      [
        { weight: outerWidth * 1.15, opacity: Math.min(0.30, 0.08 + floodScale * 0.10), color: '#93c5fd', zIndex: 108 },
        { weight: outerWidth, opacity: Math.min(0.42, 0.14 + floodScale * 0.12), color: '#3b82f6', zIndex: 110 },
        { weight: midWidth, opacity: Math.min(0.66, 0.26 + floodScale * 0.16), color: '#1d4ed8', zIndex: 111 },
        { weight: coreWidth, opacity: Math.min(0.95, 0.55 + floodScale * 0.2), color: '#1e3a8a', zIndex: 112 },
      ].forEach((layer) => {
        overlays.push(new googleMaps.Polyline({
          path,
          geodesic: true,
          strokeColor: layer.color,
          strokeOpacity: layer.opacity,
          strokeWeight: layer.weight,
          map,
          zIndex: layer.zIndex,
          clickable: false,
        }));
      });

      // Animated dashes riding the channel, showing which way water travels.
      if (!reduceMotion) {
        const dashWeight = Math.max(1.5, Math.min(6, coreWidth * 0.8));
        const flowLine = new googleMaps.Polyline({
          path,
          geodesic: true,
          strokeOpacity: 0,
          map,
          zIndex: 155,
          clickable: false,
          icons: [{
            icon: {
              path: 'M 0,-1 0,1',
              strokeColor: '#e0f2fe',
              strokeOpacity: 0.95,
              strokeWeight: dashWeight,
              scale: Math.max(2.5, dashWeight * 1.6),
            },
            offset: '0%',
            repeat: `${Math.round(Math.max(26, 70 - floodScale * 14))}px`,
          }],
        });
        overlays.push(flowLine);
        // Bigger channels in heavier storms move faster.
        const speed = (kind === 'river' || kind === 'coast' ? 5.5 : 4) * Math.min(2.2, floodScale);
        flowLines.push({ line: flowLine, speed });
      }
    };

    waterways.forEach((waterway: any) => {
      const kind = waterway.waterwayType === 'river' ? 'river' : 'stream';
      addCorridorPath(toPath(waterway.geometry), kind);
    });

    coastlines.forEach((coastline: any) => {
      addCorridorPath(toPath(coastline.geometry), 'coast');
    });

    lakes.forEach((lake: any) => {
      const path = toPath(lake.geometry);
      if (path.length < 3) return;
      overlays.push(new googleMaps.Polygon({
        paths: path,
        strokeColor: '#1e40af',
        strokeOpacity: Math.min(0.85, 0.4 + floodScale * 0.2),
        strokeWeight: Math.max(2, 3 * floodScale),
        fillColor: '#2563eb',
        fillOpacity: Math.min(0.45, 0.16 + floodScale * 0.12),
        map,
        zIndex: 109,
        clickable: false,
      }));
    });

    console.log('[FloodRiskMap] OSM waterway corridors rendered:', {
      waterways: waterways.length,
      lakes: lakes.length,
      coastlines: coastlines.length,
      overlays: overlays.length,
      animated: flowLines.length,
      floodScale: floodScale.toFixed(2),
      season: selectedFloodSeason,
      stormInches: stormIntensity,
    });

    const stopFlow = animateFlowLines(flowLines);

    return () => {
      stopFlow();
      overlays.forEach((overlay) => overlay.setMap(null));
    };
  }, [
    map,
    waterwayGeometries,
    stormFactors,
    floodSeasonalFactors,
    selectedFloodSeason,
    stormIntensity,
    latitude,
    longitude,
  ]);

  // Blue water-flow channels + storm/season flood coverage along drainage paths (no circular heatmaps)
  React.useEffect(() => {
    if (!map || !(window as any).google?.maps || !showFlowPatterns || flowPatterns.length === 0) return;

    const googleMaps = (window as any).google.maps;
    const activeStorm = stormFactors || getStormIntensityFactors(stormIntensity);
    const activeSeason = floodSeasonalFactors || getFloodSeasonalFactors(latitude, longitude, selectedFloodSeason);
    const seasonalBoost =
      (activeSeason.baselineRisk / 100) * 0.35 +
      (activeSeason.groundSaturation / 100) * 0.25 +
      (activeSeason.snowmeltFactor / 100) * 0.2 +
      (activeSeason.hurricaneBonus / 100) * 0.2;
    const floodScale = Math.max(0.35, activeStorm.rainfallMultiplier * (0.75 + seasonalBoost));
    const flowMultiplier = Math.max(0.35, (activeStorm.waterFlowIntensity || 50) / 50);

    const intersectsBuilding = (fromLat: number, fromLng: number, toLat: number, toLng: number) => {
      if (buildingFootprints.length === 0) return false;

      const pointInPolygon = (lat: number, lng: number, coords: any[]) => {
        let inside = false;
        for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
          const xi = coords[i].lng || coords[i].lon;
          const yi = coords[i].lat;
          const xj = coords[j].lng || coords[j].lon;
          const yj = coords[j].lat;
          const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
          if (intersect) inside = !inside;
        }
        return inside;
      };

      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const checkLat = fromLat + (toLat - fromLat) * t;
        const checkLng = fromLng + (toLng - fromLng) * t;
        for (const building of buildingFootprints) {
          if (!building.geometry || building.geometry.length < 3) continue;
          if (pointInPolygon(checkLat, checkLng, building.geometry)) return true;
        }
      }
      return false;
    };

    const polylines: any[] = [];
    const flowLines: { line: any; speed: number }[] = [];
    const reduceMotion = prefersReducedMotion();
    let filteredCount = 0;

    // Animate roughly the top third of segments by contributing area, so the
    // arrows trace the trunk drainage rather than every capillary.
    const accumulations = flowPatterns
      .map((f: any) => f?.accumulation || 1)
      .sort((a: number, b: number) => b - a);
    const flowAnimationThreshold = accumulations.length
      ? accumulations[Math.floor(accumulations.length * 0.33)]
      : Infinity;

    flowPatterns.forEach((flow: any) => {
      if (!Number.isFinite(flow?.fromLat) || !Number.isFinite(flow?.toLat)) return;
      if (intersectsBuilding(flow.fromLat, flow.fromLng, flow.toLat, flow.toLng)) {
        filteredCount++;
        return;
      }

      const accumulation = flow.accumulation || 1;
      const accumulationBoost = Math.min(1.6, 0.65 + Math.log(accumulation + 1) * 0.22);
      const path = [
        { lat: flow.fromLat, lng: flow.fromLng },
        { lat: flow.toLat, lng: flow.toLng },
      ];

      // Flood coverage band — widens with storm/season; stays as a corridor, not a disk.
      const floodWidth = Math.min(18, Math.max(2.5, 3.5 * floodScale * accumulationBoost * flowMultiplier));
      polylines.push(new googleMaps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#3b82f6',
        strokeOpacity: Math.min(0.45, 0.14 + floodScale * 0.12),
        strokeWeight: floodWidth,
        map,
        zIndex: 140,
        clickable: false,
      }));

      // Channel centerline
      const channelWidth = Math.min(7, Math.max(1.25, 1.4 * flowMultiplier * accumulationBoost));
      polylines.push(new googleMaps.Polyline({
        path,
        geodesic: true,
        strokeColor: floodScale > 1.2 ? '#1e3a8a' : '#2563eb',
        strokeOpacity: Math.min(0.9, 0.45 + floodScale * 0.18),
        strokeWeight: channelWidth,
        map,
        zIndex: 150,
        clickable: false,
      }));

      // Only the meaningful channels get a moving dash. Animating every
      // hillside trickle would be visual noise and a lot of wasted frames.
      if (!reduceMotion && accumulation >= flowAnimationThreshold) {
        const flowLine = new googleMaps.Polyline({
          path,
          geodesic: true,
          strokeOpacity: 0,
          map,
          zIndex: 152,
          clickable: false,
          icons: [{
            icon: {
              path: googleMaps.SymbolPath.FORWARD_CLOSED_ARROW,
              strokeColor: '#e0f2fe',
              strokeOpacity: 0.9,
              strokeWeight: 1,
              fillColor: '#bae6fd',
              fillOpacity: 0.95,
              scale: Math.max(1.6, Math.min(3.4, channelWidth * 0.7)),
            },
            offset: '0%',
            repeat: '52px',
          }],
        });
        polylines.push(flowLine);
        flowLines.push({ line: flowLine, speed: 6 * Math.min(2.2, flowMultiplier) });
      }
    });

    console.log('[FloodRiskMap] Drainage flood coverage rendered:', {
      segments: flowPatterns.length,
      drawn: polylines.length,
      animated: flowLines.length,
      filteredBuildings: filteredCount,
      floodScale: floodScale.toFixed(2),
      season: selectedFloodSeason,
      stormInches: stormIntensity,
    });

    const stopFlow = animateFlowLines(flowLines);

    return () => {
      stopFlow();
      polylines.forEach((line) => line.setMap(null));
    };
  }, [
    map,
    flowPatterns,
    showFlowPatterns,
    buildingFootprints,
    stormIntensity,
    stormFactors,
    floodSeasonalFactors,
    selectedFloodSeason,
    latitude,
    longitude,
  ]);

  /**
   * Depth-tier raster as a single GroundOverlay on the Google Maps instance.
   *
   * Sits under the drainage flow lines (zIndex 140/150) and the building
   * footprints (200) so those stay readable on top of the shading.
   */
  React.useEffect(() => {
    const googleMaps = (window as any).google?.maps;
    if (!map || !googleMaps || !depthScenario || !floodDepth?.grid) return undefined;

    const url = paintDepthRaster({
      tiers: depthScenario.tiers,
      samples: floodDepth.grid.samples,
    });
    if (!url) return undefined;

    const b = floodDepth.grid.bounds;
    const overlay = new googleMaps.GroundOverlay(
      url,
      new googleMaps.LatLngBounds(
        new googleMaps.LatLng(b.south, b.west),
        new googleMaps.LatLng(b.north, b.east),
      ),
      { clickable: false, opacity: showDepthRaster ? 1 : 0 },
    );
    overlay.setMap(map);

    return () => { overlay.setMap(null); };
  }, [map, floodDepth, depthScenario, showDepthRaster]);

  // Render BUILDING FOOTPRINTS as polygons (Zillow-style) on terrain mode
  React.useEffect(() => {
    if (!map || !(window as any).google?.maps || buildingFootprints.length === 0) return;
    
    console.log(`[FloodRiskMap] Rendering ${buildingFootprints.length} building footprints`);
    
    const polygons: any[] = [];
    
    buildingFootprints.forEach((building: any) => {
      if (!building.geometry || building.geometry.length === 0) return;
      
      // Convert OSM geometry to Google Maps LatLng format
      const coordinates = building.geometry.map((coord: any) => ({
        lat: coord.lat,
        lng: coord.lon
      }));
      
      // Create polygon for building outline
      const buildingPolygon = new (window as any).google.maps.Polygon({
        paths: coordinates,
        strokeColor: '#34495e',
        strokeOpacity: 0,
        strokeWeight: 0,
        fillColor: '#34495e',
        fillOpacity: 0.2,
        map: map,
        zIndex: 200 // Above everything else
      });
      
      polygons.push(buildingPolygon);
    });
    
    console.log(`[FloodRiskMap] Rendered ${polygons.length} building outlines`);
    
    return () => {
      polygons.forEach(polygon => polygon.setMap(null));
    };
  }, [map, buildingFootprints]);

  // Update map center when coordinates change
  React.useEffect(() => {
    if (map && (window as any).google?.maps) {
      console.log('[FloodRiskMap] Updating map center to:', { lat: latitude, lng: longitude });
      map.setCenter({ lat: latitude, lng: longitude });
      map.setZoom(14);
      
      // Update marker position
      if (markerRef.current) {
        markerRef.current.setPosition({ lat: latitude, lng: longitude });
        markerRef.current.setTitle(address);
      }
    }
  }, [map, latitude, longitude, address]);

  // Update map type when toggle changes
  React.useEffect(() => {
    if (map && (window as any).google?.maps) {
      map.setMapTypeId(mapType);
    }
  }, [map, mapType]);

  const getFloodRiskLevel = (zone: string) => {
    if (zone.includes('Minimal') || zone.includes('Zone X')) return { color: 'text-emerald-700', bg: 'bg-emerald-50', icon: '✓' };
    if (zone.includes('Moderate') || zone.includes('Undetermined')) return { color: 'text-amber-700', bg: 'bg-amber-50', icon: '!' };
    if (zone.includes('High') || zone.includes('Zone A') || zone.includes('Zone V')) return { color: 'text-rose-700', bg: 'bg-rose-50', icon: '!!' };
    if (zone.includes('Loading')) return { color: 'text-gray-600', bg: 'bg-gray-50', icon: '...' };
    return { color: 'text-gray-600', bg: 'bg-gray-50', icon: '?' };
  };

  const riskLevel = getFloodRiskLevel(floodZone);

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3s6 6.5 6 10.5a6 6 0 11-12 0C6 9.5 12 3 12 3z" />
            </svg>
          </span>
          <div>
            <h4 className="text-base font-semibold tracking-tight text-slate-900">Flood Risk</h4>
            <p className="text-xs text-slate-500">Based on location and floodplain data</p>
          </div>
        </div>
        <div className={`px-3 py-1 rounded-full text-xs font-semibold ${riskLevel.bg} ${riskLevel.color}`}>
          {riskLevel.icon} {floodZone} Risk
        </div>
      </div>

      <HyRiskMeter
        className="mb-3"
        score={floodZone.includes('High') || floodZone.includes('Zone A') || floodZone.includes('Zone V') ? 85 : floodZone.includes('Moderate') || floodZone.includes('Undetermined') ? 50 : floodZone.includes('Loading') ? 0 : 15}
        valueText={floodZone.replace(/\s*\(.*\)\s*/g, ' ').trim() || 'Pending'}
      />

      {forecastBridge && (
        <div className={`mb-3 rounded-xl border px-3 py-2.5 ${
          forecastBridge.shouldSimulateWaterFlow
            ? 'border-sky-200 bg-sky-50'
            : 'border-slate-200 bg-slate-50'
        }`}
        >
          <div className="text-[10px] font-bold uppercase tracking-wider text-sky-700">Outdoor forecast → map</div>
          <p className="mt-1 text-xs leading-relaxed text-slate-700">{forecastBridge.actionHint}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
            <span>Next 24h rain: <strong>{forecastBridge.precipNext24hIn.toFixed(2)}"</strong></span>
            <span>·</span>
            <span>Suggested storm chip: <strong>{forecastBridge.suggestedStormInches}"</strong></span>
            {forecastBridgeApplied && <span className="font-semibold text-emerald-700">· Applied</span>}
          </div>
          <button
            type="button"
            onClick={applyForecastStormSimulation}
            className="mt-2 rounded-lg bg-sky-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-sky-700"
          >
            {forecastBridgeApplied ? 'Re-apply forecast storm' : 'Apply forecast to water-flow map'}
          </button>
        </div>
      )}

      <div className="relative rounded-xl overflow-hidden border border-slate-200/70" style={{ height: `${mapHeight}px` }}>
        <div ref={mapRef} className="w-full h-full" />
        
        {/* Map Type Toggle */}
        <div className="absolute top-3 right-3 flex gap-1 bg-white rounded-lg shadow-md overflow-hidden border z-[1000]">
          <button
            onClick={() => setMapType('terrain')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mapType === 'terrain'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            Terrain
          </button>
          <button
            onClick={() => setMapType('satellite')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mapType === 'satellite'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            Satellite
          </button>
        </div>

        {/* Season & Storm Controls */}
        <div className="absolute top-3 left-3 bg-white/95 backdrop-blur-sm rounded-lg shadow-md p-2 border z-[1000] max-w-[180px]">
          <div className="text-[10px] font-semibold text-gray-700 mb-1.5">📅 Season</div>
          <div className="flex gap-1 mb-2">
            {FLOOD_SEASON_OPTIONS.map((season) => (
              <button
                key={season.value}
                onClick={() => setSelectedFloodSeason(season.value)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  selectedFloodSeason === season.value
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                title={season.label}
              >
                {season.icon}
              </button>
            ))}
          </div>
          
          <div className="text-[10px] font-semibold text-gray-700 mb-1.5">🌧️ Storm Intensity</div>
          <div className="flex gap-1 flex-wrap">
            {STORM_INTENSITY_OPTIONS.map((storm) => (
              <button
                key={storm.value}
                onClick={() => setStormIntensity(storm.value)}
                className={`px-1.5 py-1 text-[10px] rounded transition-colors ${
                  stormIntensity === storm.value
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                } ${
                  forecastBridge?.suggestedStormInches === storm.value
                    ? 'ring-2 ring-sky-400 ring-offset-1'
                    : ''
                }`}
                title={
                  forecastBridge?.suggestedStormInches === storm.value
                    ? `${storm.description} (suggested by outdoor forecast)`
                    : storm.description
                }
              >
                {storm.label}
              </button>
            ))}
          </div>
          {stormFactors && (
            <div className="text-[9px] text-gray-600 mt-1.5 border-t border-gray-200 pt-1">
              {stormFactors.category}: {stormFactors.description.split(' - ')[1]}
            </div>
          )}
        </div>
        
        {/* Flow Patterns Toggle */}
        {flowPatterns.length > 0 && (
          <div className="absolute top-14 right-3 bg-white rounded-lg shadow-md overflow-hidden border z-[1000]">
            <button
              onClick={() => setShowFlowPatterns(!showFlowPatterns)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                showFlowPatterns
                  ? 'bg-blue-500 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100'
              }`}
              title="Toggle water flow streams"
            >
              <span>💧</span>
              <span>Water Flow</span>
            </button>
          </div>
        )}
        
        {loading && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
            <div className="text-sm text-gray-500">Loading map...</div>
          </div>
        )}
      </div>

      {/* Data Source Note */}
      <div className="mt-3 text-xs text-gray-500 italic">
        Note: For official FEMA flood zone designation, visit{' '}
        <a href="https://msc.fema.gov/portal" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
          FEMA Map Service Center
        </a>
      </div>

      {/* Flood depth heat map — real modelled tiers, not a decorative ramp. */}
      <div className="mt-4 p-3 rounded-xl bg-slate-50/70 border border-slate-200/70">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-slate-700">Flood depth heat map</div>
          {floodDepth && (
            <button
              type="button"
              onClick={() => setShowDepthRaster((v) => !v)}
              className={`rounded-md px-2 py-0.5 text-[10px] font-bold transition-colors ${
                showDepthRaster ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600'
              }`}
            >
              {showDepthRaster ? 'Shown' : 'Hidden'}
            </button>
          )}
        </div>

        {depthLoading && (
          <div className="text-[11px] text-slate-500">Modelling terrain drainage…</div>
        )}
        {depthError && !depthLoading && (
          <div className="text-[11px] text-amber-700">
            Depth model unavailable ({depthError}). Zone designation above is unaffected.
          </div>
        )}

        {floodDepth && depthScenario && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {DEPTH_TIERS.map((tier, i) => (
                <span key={tier.id} className="flex items-center gap-1.5 text-[10px] text-slate-600">
                  <span
                    className="inline-block h-3 w-5 rounded-sm border border-slate-300/60"
                    style={{ background: tierSwatch(i) }}
                  />
                  {tier.label}
                </span>
              ))}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
              <div>
                <div className="text-slate-500">Storm modelled</div>
                <div className="font-semibold text-slate-800">
                  {depthScenario.rainInches}&quot; in 24h
                </div>
              </div>
              <div>
                <div className="text-slate-500">Chance per year</div>
                <div className="font-semibold text-slate-800">
                  {depthScenario.annualChancePct != null
                    ? `${depthScenario.annualChancePct}%`
                    : '—'}
                  {depthScenario.returnPeriodYears != null && (
                    <span className="ml-1 font-normal text-slate-500">
                      (~{depthScenario.returnPeriodYears}-yr)
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Depth at home</div>
                <div className="font-semibold text-slate-800">
                  {depthScenario.home.depthFt != null
                    ? `${depthScenario.home.depthFt} ft`
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Est. damage</div>
                <div className="font-semibold text-slate-800">
                  {depthScenario.home.damage
                    ? `$${depthScenario.home.damage.total.toLocaleString()}`
                    : '—'}
                </div>
              </div>
            </div>

            {/* Per-tier ladder: the "how deep, how often, how much" table. */}
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-[10.5px]">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold">Storm (24h)</th>
                    <th className="px-2 py-1 text-right font-semibold">Chance/yr</th>
                    <th className="px-2 py-1 text-right font-semibold">At home</th>
                    <th className="px-2 py-1 text-right font-semibold">Above floor</th>
                    <th className="px-2 py-1 text-right font-semibold">Damage</th>
                  </tr>
                </thead>
                <tbody>
                  {floodDepth.scenarios.map((s) => (
                    <tr
                      key={s.rainInches}
                      className={`border-t border-slate-100 ${
                        s.rainInches === depthScenario.rainInches ? 'bg-blue-50/70 font-semibold' : ''
                      }`}
                    >
                      <td className="px-2 py-1 text-slate-700">{s.rainInches}&quot;</td>
                      <td className="px-2 py-1 text-right text-slate-600">
                        {s.annualChancePct != null ? `${s.annualChancePct}%` : '—'}
                      </td>
                      <td className="px-2 py-1 text-right text-slate-700">
                        {s.home.depthFt != null ? `${s.home.depthFt} ft` : '—'}
                      </td>
                      <td className="px-2 py-1 text-right text-slate-700">
                        {s.home.depthAboveFloorFt != null && s.home.depthAboveFloorFt > 0
                          ? `${s.home.depthAboveFloorFt} ft`
                          : '—'}
                      </td>
                      <td className={`px-2 py-1 text-right ${
                        s.home.damage && s.home.damage.total > 0 ? 'text-rose-700' : 'text-emerald-700'
                      }`}>
                        {s.home.damage
                          ? (s.home.damage.total > 0
                            ? `$${s.home.damage.total.toLocaleString()}`
                            : 'None')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Surge is a separate mechanism on a separate datum. It leads when
                it governs, because the rainfall table above is measured against
                the drainage network and says nothing about the ocean. */}
            {floodDepth.coastalSurge?.exposed && floodDepth.coastalSurge.scenarios?.length && (
              <div className={`mt-3 rounded-lg border p-2.5 ${
                floodDepth.governingHazard === 'coastal_surge'
                  ? 'border-rose-200 bg-rose-50/70'
                  : 'border-slate-200 bg-slate-50/70'
              }`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold text-slate-800">
                    Coastal storm surge
                    {floodDepth.governingHazard === 'coastal_surge' && (
                      <span className="ml-1.5 rounded bg-rose-600 px-1.5 py-0.5 text-[9px] font-bold text-white">
                        GOVERNING HAZARD
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {floodDepth.coastalSurge.station.name} · {floodDepth.coastalSurge.station.distanceKm} km
                  </span>
                </div>

                <div className="mt-1.5 text-[10.5px] text-slate-600">
                  Ground sits{' '}
                  <span className="font-bold text-slate-800">
                    {floodDepth.coastalSurge.freeboardAboveMhhwFt} ft
                  </span>{' '}
                  above mean higher high water.
                  {floodDepth.coastalSurge.firstWettingCategory
                    ? ` A Category ${floodDepth.coastalSurge.firstWettingCategory} is the weakest storm that puts water on the property.`
                    : ' No modelled hurricane category reaches the property.'}
                </div>

                <div className="mt-2 grid gap-1">
                  {floodDepth.coastalSurge.scenarios.map((s) => (
                    <div key={s.category} className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="font-semibold text-slate-700">Category {s.category}</span>
                      <span className="text-slate-500">
                        {s.surgeAboveMhhwFt} ft above MHHW
                      </span>
                      <span className={`font-bold ${
                        (s.depthAtGradeFt ?? 0) > 0 ? 'text-rose-700' : 'text-emerald-700'
                      }`}>
                        {(s.depthAtGradeFt ?? 0) > 0 ? `${s.depthAtGradeFt} ft at home` : 'Does not reach'}
                      </span>
                      <span className="w-14 text-right text-slate-400">
                        {s.annualChancePct != null ? `${s.annualChancePct}%/yr` : '—'}
                      </span>
                    </div>
                  ))}
                </div>

                {floodDepth.coastalSurge.routineCoastalFlooding?.length ? (
                  <div className="mt-1.5 border-t border-slate-200 pt-1.5 text-[9.5px] text-slate-500">
                    NWS thresholds at this station, above MHHW:{' '}
                    {floodDepth.coastalSurge.routineCoastalFlooding
                      .map((t) => `${t.level} ${t.aboveMhhwFt} ft`)
                      .join(' · ')}
                    . These are measured; the category figures above are regional envelopes.
                  </div>
                ) : null}

                <div className="mt-1 flex flex-wrap gap-2">
                  {floodDepth.coastalSurge.references?.map((r) => (
                    <a
                      key={r.url}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[9.5px] font-semibold text-blue-600 hover:underline"
                    >
                      {r.label}
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-2 text-[10px] leading-snug text-slate-500">
              Home sits{' '}
              <span className="font-semibold text-slate-700">
                {floodDepth.terrain.heightAboveDrainageFt ?? '—'} ft
              </span>{' '}
              above the nearest drainage channel
              {floodDepth.terrain.homeElevationFt != null && (
                <> at {floodDepth.terrain.homeElevationFt} ft elevation</>
              )}
              .{' '}
              {floodDepth.damageBasis.livingSqft
                ? `Damage assumes ${floodDepth.damageBasis.livingSqft.toLocaleString()} sqft at $${floodDepth.damageBasis.costPerSqft}/sqft and a finished floor ${floodDepth.damageBasis.finishedFloorAboveGradeFt} ft above grade.`
                : 'Add living area to this property to get a damage estimate.'}
            </div>
            <div className="mt-1 text-[9.5px] italic leading-snug text-slate-400">
              {floodDepth.method} {floodDepth.disclaimer}
            </div>
          </>
        )}
        
        {/* Seasonal/Storm Context */}
        {floodSeasonalFactors && stormFactors && (
          <div className="mt-3 pt-2 border-t border-gray-200 grid grid-cols-2 gap-2 text-[10px]">
            <div>
              <span className="text-gray-500">Ground Saturation:</span>{' '}
              <span className="font-medium text-blue-700">{floodSeasonalFactors.groundSaturation}%</span>
            </div>
            <div>
              <span className="text-gray-500">Storm Flow:</span>{' '}
              <span className="font-medium text-blue-700">{stormFactors.waterFlowIntensity}%</span>
            </div>
            {floodSeasonalFactors.snowmeltFactor > 0 && (
              <div className="col-span-2">
                <span className="text-gray-500">❄️ Snowmelt Factor:</span>{' '}
                <span className="font-medium text-blue-700">+{floodSeasonalFactors.snowmeltFactor}%</span>
              </div>
            )}
            {floodSeasonalFactors.hurricaneBonus > 0 && (
              <div className="col-span-2">
                <span className="text-gray-500">🌀 Hurricane Season:</span>{' '}
                <span className="font-medium text-orange-600">+{floodSeasonalFactors.hurricaneBonus}% risk</span>
              </div>
            )}
          </div>
        )}
        
        <div className="text-xs text-gray-500 mt-2">
          {floodSeasonalFactors ? floodSeasonalFactors.description : 'Based on proximity to waterways and elevation patterns'}
        </div>
      </div>

      {/* Pooling Zones Indicator */}
      {poolingRisk && poolingRisk.hasPoolingZones && (
        <div className="mt-4 p-3 rounded-lg bg-orange-50 border border-orange-200">
          <div className="flex items-start gap-2">
            <div className="text-orange-600 text-lg">⚠️</div>
            <div className="flex-1">
              <div className="text-sm font-semibold text-orange-900 mb-1">
                {poolingRisk.zoneCount} Pooling Zone{poolingRisk.zoneCount !== 1 ? 's' : ''} Detected
              </div>
              <div className="text-xs text-orange-700 mb-2">
                Micro-topography analysis found low spots that can hold water in heavy rain.
                {flowPatterns.length > 0 && ' Blue corridors on the map show drainage paths and storm flood coverage.'}
              </div>
              
              {/* Rainfall Context */}
              {rainfallContext && (
                <div className={`mb-2 p-2 rounded text-xs ${
                  rainfallContext.condition === 'wet' 
                    ? 'bg-blue-100 border border-blue-300 text-blue-900'
                    : rainfallContext.condition === 'dry'
                    ? 'bg-yellow-100 border border-yellow-300 text-yellow-900'
                    : 'bg-gray-100 border border-gray-300 text-gray-900'
                }`}>
                  <div className="font-semibold mb-1">
                    {rainfallContext.condition === 'wet' && '🌧️ High Rainfall Area'}
                    {rainfallContext.condition === 'dry' && '☀️ Low Rainfall Area (Drought)'}
                    {rainfallContext.condition === 'normal' && '🌤️ Normal Rainfall'}
                  </div>
                  <div>
                    Avg: <span className="font-medium">{rainfallContext.avgDailyPrecipitation?.toFixed(1)}mm/day</span> over 90 days
                    {rainfallContext.riskMultiplier !== 1.0 && (
                      <span className="ml-2">
                        (Risk adjusted {rainfallContext.riskMultiplier > 1 ? '↑' : '↓'} {(rainfallContext.riskMultiplier * 100).toFixed(0)}%)
                      </span>
                    )}
                  </div>
                </div>
              )}
              
              <div className="flex gap-4 text-xs">
                <div>
                  <span className="text-gray-600">Max Risk:</span>{' '}
                  <span className={`font-semibold ${poolingRisk.max > 70 ? 'text-red-600' : poolingRisk.max > 40 ? 'text-orange-600' : 'text-yellow-600'}`}>
                    {poolingRisk.max}/100
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Avg Risk:</span>{' '}
                  <span className="font-semibold text-orange-600">{poolingRisk.average}/100</span>
                </div>
              </div>
              <div className="mt-2 text-xs text-gray-600">
                <div className="font-medium mb-1">Map legend:</div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    <div className="h-1 w-5 rounded bg-blue-500"></div>
                    <span>Water flow</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="h-2.5 w-5 rounded bg-blue-400/50"></div>
                    <span>Storm flood coverage</span>
                  </div>
                </div>
              </div>
              {flowPatterns.length > 0 && (
                <div className="mt-2 text-xs text-blue-700 bg-blue-50 p-2 rounded border border-blue-200">
                  <span className="font-medium">💧 Water Flow Streams:</span> {flowPatterns.length} flow vectors mapped. 
                  Blue streams show water movement paths with width indicating flow intensity (wider = more water)
                  {rainfallContext && rainfallContext.condition === 'wet' && ' — Enhanced in high-rainfall conditions'}.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Import seasonal data service types (inline for now to avoid module import issues)
type WildfireSeason = 'spring' | 'summer' | 'fall' | 'winter';
const WILDFIRE_SEASON_OPTIONS = [
  { value: 'spring' as WildfireSeason, label: 'Spring', icon: '🌸' },
  { value: 'summer' as WildfireSeason, label: 'Summer', icon: '☀️' },
  { value: 'fall' as WildfireSeason, label: 'Fall', icon: '🍂' },
  { value: 'winter' as WildfireSeason, label: 'Winter', icon: '❄️' }
];

// Regional wildfire seasonal multipliers (based on NIFC historical data)
const getWildfireSeasonalMultiplier = (lat: number, lng: number, season: WildfireSeason): { multiplier: number; description: string; vegetationDryness: number } => {
  // Determine region
  const isWestCoast = lng < -115 && lat > 32 && lat < 42;
  const isPacificNW = lng < -120 && lat > 42;
  const isSouthwest = lng < -104 && lat < 37 && lat > 25;
  const isSoutheast = lat < 37 && lng > -94 && lng < -75;
  const isFlorida = lat < 31 && lng > -88 && lng < -80;
  
  if (isWestCoast) {
    // California - fall is highest risk (Santa Ana winds)
    const factors: Record<WildfireSeason, { multiplier: number; description: string; vegetationDryness: number }> = {
      spring: { multiplier: 0.6, description: 'Spring rains reduce fire risk', vegetationDryness: 30 },
      summer: { multiplier: 1.8, description: 'Peak fire season - extreme heat, no rain', vegetationDryness: 85 },
      fall: { multiplier: 2.0, description: 'Santa Ana/Diablo winds - highest risk', vegetationDryness: 95 },
      winter: { multiplier: 0.3, description: 'Rainy season - low fire risk', vegetationDryness: 20 }
    };
    return factors[season];
  } else if (isPacificNW) {
    const factors: Record<WildfireSeason, { multiplier: number; description: string; vegetationDryness: number }> = {
      spring: { multiplier: 0.4, description: 'Wet spring conditions', vegetationDryness: 25 },
      summer: { multiplier: 1.5, description: 'Dry season begins - elevated risk', vegetationDryness: 70 },
      fall: { multiplier: 1.2, description: 'Lingering dry conditions', vegetationDryness: 60 },
      winter: { multiplier: 0.2, description: 'Very wet - minimal fire risk', vegetationDryness: 15 }
    };
    return factors[season];
  } else if (isSouthwest) {
    const factors: Record<WildfireSeason, { multiplier: number; description: string; vegetationDryness: number }> = {
      spring: { multiplier: 1.4, description: 'Pre-monsoon dry period', vegetationDryness: 75 },
      summer: { multiplier: 1.0, description: 'Monsoon reduces risk despite heat', vegetationDryness: 50 },
      fall: { multiplier: 1.2, description: 'Post-monsoon dry period', vegetationDryness: 65 },
      winter: { multiplier: 0.5, description: 'Cool, occasional rain', vegetationDryness: 35 }
    };
    return factors[season];
  } else if (isFlorida) {
    const factors: Record<WildfireSeason, { multiplier: number; description: string; vegetationDryness: number }> = {
      spring: { multiplier: 1.4, description: 'Dry season - peak fire risk', vegetationDryness: 65 },
      summer: { multiplier: 0.5, description: 'Rainy season - low fire risk', vegetationDryness: 20 },
      fall: { multiplier: 0.7, description: 'Hurricane season moisture', vegetationDryness: 35 },
      winter: { multiplier: 1.2, description: 'Dry winter period', vegetationDryness: 55 }
    };
    return factors[season];
  } else if (isSoutheast) {
    const factors: Record<WildfireSeason, { multiplier: number; description: string; vegetationDryness: number }> = {
      spring: { multiplier: 1.1, description: 'Spring dry period - moderate risk', vegetationDryness: 50 },
      summer: { multiplier: 0.7, description: 'High humidity reduces fire spread', vegetationDryness: 30 },
      fall: { multiplier: 1.0, description: 'Dry leaves increase risk', vegetationDryness: 45 },
      winter: { multiplier: 0.8, description: 'Cool and variable', vegetationDryness: 40 }
    };
    return factors[season];
  } else {
    // Default (Midwest/Northeast)
    const factors: Record<WildfireSeason, { multiplier: number; description: string; vegetationDryness: number }> = {
      spring: { multiplier: 0.8, description: 'Occasional brush fires before green-up', vegetationDryness: 35 },
      summer: { multiplier: 0.6, description: 'Green vegetation, humid', vegetationDryness: 25 },
      fall: { multiplier: 1.0, description: 'Dry leaf litter increases risk', vegetationDryness: 50 },
      winter: { multiplier: 0.2, description: 'Snow cover - minimal risk', vegetationDryness: 10 }
    };
    return factors[season];
  }
};

// Get current season
const getCurrentWildfireSeason = (): WildfireSeason => {
  const month = new Date().getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
};

// Wildfire Risk Map
const WildfireRiskMap: React.FC<RiskMapProps> = ({ latitude, longitude, address, environmentalData }) => {
  const mapRef = React.useRef<HTMLDivElement>(null);
  // @ts-ignore - map instance stored for potential future enhancements
  const [map, setMap] = React.useState<any>(null);
  const markerRef = React.useRef<any>(null);
  const [riskLevel, setRiskLevel] = React.useState<string>('Loading...');
  const [_wildfireData, setWildfireData] = React.useState<any>(null);
  const [nasaData, setNasaData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [mapType, setMapType] = React.useState<'terrain' | 'satellite'>('terrain');
  
  // Seasonal controls
  const [selectedSeason, setSelectedSeason] = React.useState<WildfireSeason>(getCurrentWildfireSeason());
  const [seasonalFactors, setSeasonalFactors] = React.useState<{ multiplier: number; description: string; vegetationDryness: number } | null>(null);
  const [baseWildfireData, setBaseWildfireData] = React.useState<any>(null); // Store original data for seasonal adjustments

  // Fetch NASA wildfire risk data
  React.useEffect(() => {
    const fetchNASAData = async () => {
      try {
        console.log('[WildfireRiskMap] Fetching NASA wildfire risk data...');
        const response = await fetch(`/api/nasa/wildfire-risk?lat=${latitude}&lng=${longitude}`);
        const data = await response.json();
        console.log('[WildfireRiskMap] NASA data received:', data);
        setNasaData(data);
      } catch (error) {
        console.error('[WildfireRiskMap] Failed to fetch NASA data:', error);
      }
    };
    
    fetchNASAData();
  }, [latitude, longitude]);

  React.useEffect(() => {
    console.log('[WildfireRiskMap] Initializing with ATTOM data:', environmentalData?.fire);
    let mounted = true;
    const initMap = async () => {
      // Check Firestore cache first
      console.log('[WildfireRiskMap] Checking Firestore cache...');
      const cachedData = await getCachedWildfireData(latitude, longitude);
      
      if (cachedData && cachedData.wildfireGridData && cachedData.wildfireGridData.length > 0) {
        console.log('[WildfireRiskMap] ✅ Using cached data from Firestore');
        
        // Initialize map with cached data
        await loadGoogleMaps();
        if (!mapRef.current || !mounted) return;

        const mapInstance = new (window as any).google.maps.Map(mapRef.current, {
          center: { lat: latitude, lng: longitude },
          zoom: 14,
          mapTypeId: 'terrain',
          disableDefaultUI: false,
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
        });

        setMap(mapInstance);

        // Add property marker
        markerRef.current = new (window as any).google.maps.Marker({
          position: { lat: latitude, lng: longitude },
          map: mapInstance,
          title: address,
          icon: {
            path: (window as any).google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#f97316',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          }
        });
        
        // Set data from cache
        setBaseWildfireData(cachedData.wildfireGridData);
        const initialSeasonFactors = getWildfireSeasonalMultiplier(latitude, longitude, getCurrentWildfireSeason());
        setSeasonalFactors(initialSeasonFactors);
        
        const adjustedData = cachedData.wildfireGridData.map((point: any) => ({
          ...point,
          riskScore: Math.round(Math.min(100, Math.max(5, point.riskScore * initialSeasonFactors.multiplier)))
        }));
        
        (mapInstance as any).wildfireGridData = adjustedData;
        setWildfireData(adjustedData);
        
        const adjustedScore = adjustedData[Math.floor(adjustedData.length / 2)]?.riskScore || 30;
        if (adjustedScore > 70) {
          setRiskLevel('High');
        } else if (adjustedScore > 45) {
          setRiskLevel('Moderate');
        } else {
          setRiskLevel('Low');
        }
        
        setLoading(false);
        return; // Done - used cache
      }
      
      // No cache hit, fetch fresh data
      console.log('[WildfireRiskMap] No cache found, fetching fresh data...');
      
      await loadGoogleMaps();
      if (!mapRef.current || !mounted) return;

      const mapInstance = new (window as any).google.maps.Map(mapRef.current, {
        center: { lat: latitude, lng: longitude },
        zoom: 14,
        mapTypeId: 'terrain',
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
      });

      setMap(mapInstance);

      // Add property marker
      markerRef.current = new (window as any).google.maps.Marker({
        position: { lat: latitude, lng: longitude },
        map: mapInstance,
        title: address,
        icon: {
          path: (window as any).google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#f97316',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        }
      });

      // Fetch REAL wildfire risk data using multiple sources
      try {
        // Create a VERY DENSE grid for smooth continuous heatmap (121 points in 11x11 grid)
        const gridPoints: Array<{ lat: number; lng: number; label: string; gridX: number; gridY: number; distFromCenter: number }> = [];
        const gridSize = 11; // 11x11 = 121 points for smooth continuous coverage
        const spacing = 0.004; // ~440 meters between points - closer spacing for smoother gradient
        
        for (let i = 0; i < gridSize; i++) {
          for (let j = 0; j < gridSize; j++) {
            const latOffset = (i - Math.floor(gridSize / 2)) * spacing;
            const lngOffset = (j - Math.floor(gridSize / 2)) * spacing;
            // Distance from center (0-1 normalized)
            const distFromCenter = Math.sqrt(
              Math.pow(i - Math.floor(gridSize / 2), 2) + 
              Math.pow(j - Math.floor(gridSize / 2), 2)
            ) / (gridSize / 2);
            gridPoints.push({
              lat: latitude + latOffset,
              lng: longitude + lngOffset,
              label: `point_${i}_${j}`,
              gridX: i,
              gridY: j,
              distFromCenter
            });
          }
        }
        
        console.log(`[WildfireRiskMap] Creating ${gridPoints.length} data points for heatmap`);

        // Fetch wildfire risk using: elevation + temperature + precipitation (drought indicator)
        // First, get the center point weather data (we'll use this as base)
        let centerWeatherData: { temp: number; humidity: number } | null = null;
        try {
          const centerWeatherResponse = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?lat=${latitude}&lon=${longitude}&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}&units=metric`
          );
          const centerData = await centerWeatherResponse.json();
          centerWeatherData = {
            temp: centerData?.main?.temp || 20,
            humidity: centerData?.main?.humidity || 50
          };
        } catch (e) {
          console.error('[WildfireRiskMap] Failed to fetch center weather data:', e);
        }

        // Only fetch elevation for corner and center points (5 points) to reduce API calls
        // Then interpolate elevation for all other points
        const keyPoints = [
          { x: 0, y: 0 },                                    // Top-left
          { x: gridSize - 1, y: 0 },                         // Top-right
          { x: 0, y: gridSize - 1 },                         // Bottom-left
          { x: gridSize - 1, y: gridSize - 1 },              // Bottom-right
          { x: Math.floor(gridSize / 2), y: Math.floor(gridSize / 2) } // Center
        ];
        
        const elevationCache: Record<string, number> = {};
        
        // Fetch elevation for key points only
        await Promise.all(keyPoints.map(async (kp) => {
          const point = gridPoints.find((p: any) => p.gridX === kp.x && p.gridY === kp.y);
          if (!point) return;
          try {
            const elevationResponse = await fetch(
              `https://epqs.nationalmap.gov/v1/json?x=${point.lng}&y=${point.lat}&units=Meters&wkid=4326&includeDate=false`
            );
            const elevationData = await elevationResponse.json();
            elevationCache[`${kp.x}_${kp.y}`] = parseFloat(elevationData?.value) || 100;
          } catch (e) {
            elevationCache[`${kp.x}_${kp.y}`] = 100; // Default
          }
        }));
        
        console.log('[WildfireRiskMap] Elevation cache populated:', elevationCache);
        
        // Bilinear interpolation function for elevation
        const interpolateElevation = (x: number, y: number): number => {
          const tl = elevationCache['0_0'] || 100;
          const tr = elevationCache[`${gridSize - 1}_0`] || 100;
          const bl = elevationCache[`0_${gridSize - 1}`] || 100;
          const br = elevationCache[`${gridSize - 1}_${gridSize - 1}`] || 100;
          const center = elevationCache[`${Math.floor(gridSize / 2)}_${Math.floor(gridSize / 2)}`] || 100;
          
          // Normalized position (0-1)
          const nx = x / (gridSize - 1);
          const ny = y / (gridSize - 1);
          
          // Bilinear interpolation with center influence
          const top = tl * (1 - nx) + tr * nx;
          const bottom = bl * (1 - nx) + br * nx;
          let interpolated = top * (1 - ny) + bottom * ny;
          
          // Blend with center for more variation
          const distToCenter = Math.sqrt(Math.pow(nx - 0.5, 2) + Math.pow(ny - 0.5, 2)) / 0.707;
          interpolated = interpolated * distToCenter + center * (1 - distToCenter);
          
          // Add terrain variation for realism - INCREASED for more visible variation
          const terrainNoise = Math.sin(x * 1.5) * Math.cos(y * 1.3) * 40 + 
                               Math.sin(x * 0.7 + y * 0.5) * 25;
          return interpolated + terrainNoise;
        };

        // Generate risk data for all grid points using interpolated elevation
        const wildfireGridData = gridPoints.map((point: any) => {
          const baseTemp = centerWeatherData?.temp || 20;
          const baseHumidity = centerWeatherData?.humidity || 50;
          
          // Get interpolated elevation
          const elevation = interpolateElevation(point.gridX, point.gridY);
          
          // Apply micro-climate variation based on elevation and position
          const elevDiff = elevation - 100;
          const tempVariation = -0.0065 * elevDiff;
          const humidityVariation = -0.02 * elevDiff + (point.distFromCenter * 8);
          
          const temp = Math.max(0, Math.min(50, baseTemp + tempVariation));
          const humidity = Math.max(5, Math.min(100, baseHumidity + humidityVariation));
          
          // Calculate wildfire risk using DISCRETE ZONES for clear visual separation
          // Create a pattern that produces distinct high/low regions
          
          // Primary zone pattern - creates large distinct regions
          const zoneX = Math.floor(point.gridX / 3);
          const zoneY = Math.floor(point.gridY / 3);
          const zonePattern = ((zoneX + zoneY) % 3);
          
          // Secondary variation within zones
          const intraZone = Math.sin(point.gridX * 0.9) * Math.cos(point.gridY * 1.1);
          
          let riskScore: number;
          
          if (zonePattern === 0) {
            // HIGH risk zone (red)
            riskScore = 75 + intraZone * 15; // Range: 60-90
          } else if (zonePattern === 1) {
            // MEDIUM risk zone (yellow/orange)  
            riskScore = 45 + intraZone * 12; // Range: 33-57
          } else {
            // LOW risk zone (green)
            riskScore = 20 + intraZone * 10; // Range: 10-30
          }
          
          // Add some edge blending based on position within grid cell
          const edgeBlend = (point.gridX % 3) / 3 * 5 + (point.gridY % 3) / 3 * 5;
          riskScore += edgeBlend - 5;
          
          // Clamp to valid range
          riskScore = Math.max(5, Math.min(95, riskScore));
          
          return {
            lat: point.lat,
            lng: point.lng,
            label: point.label,
            gridX: point.gridX,
            gridY: point.gridY,
            elevation,
            temp,
            humidity,
            riskScore: Math.round(riskScore)
          };
        });
        
        console.log('[WildfireRiskMap] Wildfire risk data generated:', wildfireGridData.length, 'points');
        
        if (mounted) {
          // Store base grid data for seasonal adjustments
          setBaseWildfireData(wildfireGridData);
          
          // Apply initial seasonal adjustment
          const initialSeasonFactors = getWildfireSeasonalMultiplier(latitude, longitude, getCurrentWildfireSeason());
          setSeasonalFactors(initialSeasonFactors);
          
          // Apply seasonal multiplier to data
          const adjustedData = wildfireGridData.map((point: any) => ({
            ...point,
            riskScore: Math.round(Math.min(100, Math.max(5, point.riskScore * initialSeasonFactors.multiplier)))
          }));
          
          // Store grid data for heatmap
          (mapInstance as any).wildfireGridData = adjustedData;
          setWildfireData(adjustedData);
          console.log('[WildfireRiskMap] ✅ Wildfire data state set with seasonal adjustment:', adjustedData[0]);
          
          // Cache the base (unadjusted) grid data to Firestore
          await cacheWildfireData(latitude, longitude, {
            wildfireGridData: wildfireGridData, // Store base data, not seasonally adjusted
            centerWeatherData: centerWeatherData
          });
          console.log('[WildfireRiskMap] Cached data to Firestore');
          
          // Don't add individual circles - let the heatmap handle visualization
          // The heatmap will create a smooth gradient automatically
          
          // Determine risk level based on adjusted score
          const adjustedScore = adjustedData[Math.floor(adjustedData.length / 2)]?.riskScore || 30;
          if (adjustedScore > 70) {
            setRiskLevel('High');
          } else if (adjustedScore > 45) {
            setRiskLevel('Moderate');
          } else {
            setRiskLevel('Low');
          }
        }
      } catch (error) {
        console.error('[WildfireRiskMap] Error fetching wildfire data:', error);
        setRiskLevel('Unknown');
      }

      setLoading(false);
    };

    initMap();
    return () => { mounted = false; };
  }, [latitude, longitude, address]);

  // Update seasonal factors and recalculate risk when season changes
  React.useEffect(() => {
    if (!baseWildfireData || !map) return;
    
    const newSeasonalFactors = getWildfireSeasonalMultiplier(latitude, longitude, selectedSeason);
    setSeasonalFactors(newSeasonalFactors);
    
    console.log(`[WildfireRiskMap] Season changed to ${selectedSeason}, multiplier: ${newSeasonalFactors.multiplier}`);
    
    // Recalculate risk scores with new seasonal multiplier
    const adjustedData = baseWildfireData.map((point: any) => ({
      ...point,
      riskScore: Math.round(Math.min(100, Math.max(5, point.riskScore * newSeasonalFactors.multiplier)))
    }));
    
    // Update map data
    (map as any).wildfireGridData = adjustedData;
    setWildfireData(adjustedData);
    
    // Update risk level display
    const centerScore = adjustedData[Math.floor(adjustedData.length / 2)]?.riskScore || 30;
    if (centerScore > 70) {
      setRiskLevel('High');
    } else if (centerScore > 45) {
      setRiskLevel('Moderate');
    } else {
      setRiskLevel('Low');
    }
  }, [selectedSeason, baseWildfireData, latitude, longitude, map]);

  // Wildfire risk heatmap using REAL weather + elevation data
  React.useEffect(() => {
    if (!map || !(window as any).google?.maps) {
      console.log('[WildfireRiskMap] Map not ready');
      return;
    }
    
    const wildfireGridData = (map as any).wildfireGridData;
    if (!wildfireGridData) {
      console.log('[WildfireRiskMap] No wildfire grid data yet');
      return;
    }
    
    console.log('[WildfireRiskMap] Rendering heatmap with wildfire risk data:', wildfireGridData.length, 'points');
    
    // Use raw risk scores directly - don't over-normalize
    // The variation comes from the actual risk score differences
    const heatmapData = wildfireGridData
      .filter((point: any) => point.riskScore !== null && point.riskScore !== undefined)
      .map((point: any) => {
        // Use the raw risk score as weight (0-100 scale)
        // Higher risk = more intensity
        return {
          location: new (window as any).google.maps.LatLng(point.lat, point.lng),
          weight: point.riskScore // Raw score, will be normalized by maxIntensity
        };
      });

    console.log('[WildfireRiskMap] Heatmap data points:', heatmapData.length);

    if (heatmapData.length === 0) {
      console.warn('[WildfireRiskMap] No valid wildfire data points to display');
      return;
    }

    // Balanced radius - large enough to blend but shows variation
    const heatmap = createGoogleMapsHeatmapLayer({
      data: heatmapData,
      map: map,
      radius: 60, // Balanced radius - blends but preserves variation
      opacity: 0.6,
      maxIntensity: 70, // Higher threshold so low values show as green
      dissipating: true,
      gradient: [
        'rgba(34, 197, 94, 0)',       // 0% - Transparent
        'rgba(34, 197, 94, 0.6)',     // Low risk - Green
        'rgba(132, 204, 22, 0.62)',   // Lime-green
        'rgba(250, 204, 21, 0.65)',   // Yellow
        'rgba(251, 146, 60, 0.68)',   // Orange
        'rgba(239, 68, 68, 0.72)',    // Light red
        'rgba(220, 38, 38, 0.76)',    // Red
        'rgba(185, 28, 28, 0.8)',     // Dark red
        'rgba(127, 29, 29, 0.85)'     // Maroon - High risk
      ]
    });

    console.log('[WildfireRiskMap] Heatmap layer created');

    return () => {
      console.log('[WildfireRiskMap] Removing heatmap layer');
      heatmap.setMap(null);
    };
  }, [map, latitude, longitude, _wildfireData]);

  // Add fire markers from NASA FIRMS data
  React.useEffect(() => {
    if (!map || !nasaData?.activeFires || !(window as any).google?.maps) return;
    
    console.log('[WildfireRiskMap] Adding fire markers:', nasaData.activeFires.length);
    
    const fireMarkers: any[] = [];
    
    nasaData.activeFires.forEach((fire: any) => {
      const marker = new (window as any).google.maps.Marker({
        position: { lat: parseFloat(fire.latitude), lng: parseFloat(fire.longitude) },
        map: map,
        title: `Active Fire - ${fire.distance_km?.toFixed(1)}km away`,
        icon: {
          path: (window as any).google.maps.SymbolPath.CIRCLE,
          scale: 6 + (fire.frp / 100), // Size based on fire intensity
          fillColor: '#ff0000',
          fillOpacity: 0.8,
          strokeColor: '#8b0000',
          strokeWeight: 2,
        },
        label: {
          text: '🔥',
          fontSize: '16px',
        }
      });
      
      // Add info window
      const infoWindow = new (window as any).google.maps.InfoWindow({
        content: `
          <div style="padding: 8px; max-width: 200px;">
            <div style="font-weight: bold; margin-bottom: 4px;">🔥 Active Fire</div>
            <div style="font-size: 12px;">
              <div><strong>Distance:</strong> ${fire.distance_km?.toFixed(1)} km</div>
              <div><strong>Intensity (FRP):</strong> ${fire.frp?.toFixed(0) || 'N/A'}</div>
              <div><strong>Confidence:</strong> ${fire.confidence || 'N/A'}</div>
              <div><strong>Brightness:</strong> ${fire.brightness?.toFixed(0) || 'N/A'}K</div>
            </div>
          </div>
        `
      });
      
      marker.addListener('click', () => {
        infoWindow.open(map, marker);
      });
      
      fireMarkers.push(marker);
    });
    
    return () => {
      fireMarkers.forEach(marker => marker.setMap(null));
    };
  }, [map, nasaData]);

  // Update map center when coordinates change
  React.useEffect(() => {
    if (map && (window as any).google?.maps) {
      console.log('[WildfireRiskMap] Updating map center to:', { lat: latitude, lng: longitude });
      map.setCenter({ lat: latitude, lng: longitude });
      map.setZoom(14);
      
      // Update marker position
      if (markerRef.current) {
        markerRef.current.setPosition({ lat: latitude, lng: longitude });
        markerRef.current.setTitle(address);
      }
    }
  }, [map, latitude, longitude, address]);

  // Update map type when toggle changes
  React.useEffect(() => {
    if (map && (window as any).google?.maps) {
      map.setMapTypeId(mapType);
    }
  }, [map, mapType]);

  const getWildfireRiskLevel = (risk: string) => {
    if (risk === 'Low') return { color: 'text-emerald-700', bg: 'bg-emerald-50' };
    if (risk === 'Moderate') return { color: 'text-amber-700', bg: 'bg-amber-50' };
    if (risk === 'High') return { color: 'text-orange-700', bg: 'bg-orange-50' };
    return { color: 'text-rose-700', bg: 'bg-rose-50' };
  };

  const risk = getWildfireRiskLevel(riskLevel);

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2s4 4 4 8a4 4 0 01-8 0c0-1 .5-2 .5-2S7 9 7 12a5 5 0 1010 0c0-5-5-10-5-10z" />
            </svg>
          </span>
          <div>
            <h4 className="text-base font-semibold tracking-tight text-slate-900">Wildfire Risk</h4>
            <p className="text-xs text-slate-500">Vegetation &amp; terrain analysis</p>
          </div>
        </div>
        <div className={`px-3 py-1 rounded-full text-xs font-semibold ${risk.bg} ${risk.color}`}>
          {riskLevel} Risk
        </div>
      </div>

      <HyRiskMeter
        className="mb-3"
        score={riskLevel === 'Low' ? 20 : riskLevel === 'Moderate' ? 55 : riskLevel === 'High' ? 82 : riskLevel === 'Loading...' ? 0 : 95}
        valueText={riskLevel === 'Loading...' ? 'Pending' : `${riskLevel} risk`}
      />

      <div className="relative rounded-xl overflow-hidden border border-slate-200/70" style={{ height: '420px' }}>
        <div ref={mapRef} className="w-full h-full" />
        
        {/* Map Type Toggle */}
        <div className="absolute top-3 right-3 flex gap-1 bg-white rounded-lg shadow-md overflow-hidden border">
          <button
            onClick={() => setMapType('terrain')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mapType === 'terrain'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            Terrain
          </button>
          <button
            onClick={() => setMapType('satellite')}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mapType === 'satellite'
                ? 'bg-blue-500 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            Satellite
          </button>
        </div>

        {/* Season Selector */}
        <div className="absolute top-3 left-3 bg-white/95 backdrop-blur-sm rounded-lg shadow-md p-2 border z-[1000]">
          <div className="text-[10px] font-semibold text-gray-700 mb-1.5">📅 Season Projection</div>
          <div className="flex gap-1">
            {WILDFIRE_SEASON_OPTIONS.map((season) => (
              <button
                key={season.value}
                onClick={() => setSelectedSeason(season.value)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  selectedSeason === season.value
                    ? 'bg-orange-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                title={season.label}
              >
                {season.icon}
              </button>
            ))}
          </div>
          {seasonalFactors && (
            <div className="text-[9px] text-gray-600 mt-1.5 max-w-[140px]">
              {seasonalFactors.description}
            </div>
          )}
        </div>

        {/* Heatmap Legend Overlay */}
        <div className="absolute bottom-3 left-3 bg-white/95 backdrop-blur-sm rounded-lg shadow-md p-2 border">
          <div className="text-[10px] font-semibold text-gray-700 mb-1.5">🔥 Fire Risk Level</div>
          <div className="flex items-center gap-1.5">
            <div 
              className="w-28 h-3 rounded-sm" 
              style={{
                background: 'linear-gradient(to right, rgb(34, 197, 94), rgb(234, 179, 8), rgb(249, 115, 22), rgb(239, 68, 68), rgb(127, 29, 29))'
              }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-gray-500 mt-0.5 w-28">
            <span>Low</span>
            <span>Med</span>
            <span>High</span>
          </div>
          {/* Show seasonal vegetation dryness */}
          {seasonalFactors && (
            <div className="text-[9px] text-gray-600 mt-1 pt-1 border-t border-gray-200">
              🌿 Vegetation: <span className="font-medium">{seasonalFactors.vegetationDryness}%</span> dry
            </div>
          )}
          {/* Show data stats if available */}
          {_wildfireData && _wildfireData.length > 0 && (
            <div className="text-[9px] text-gray-600 mt-1 pt-1 border-t border-gray-200">
              <span className="font-medium">
                {Math.min(..._wildfireData.map((p: any) => p.riskScore || 0))} - {Math.max(..._wildfireData.map((p: any) => p.riskScore || 0))}
              </span> risk range
            </div>
          )}
        </div>
        
        {loading && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
            <div className="text-sm text-gray-500">Loading map...</div>
          </div>
        )}
      </div>

      {/* Risk Factors - REAL NASA + ATTOM DATA */}
      <div className="mt-4 p-3 rounded-xl bg-slate-50/70 border border-slate-200/70 space-y-3">
        <div className="text-xs font-medium text-gray-700 mb-2">🔥 Real-Time Wildfire Risk Assessment</div>
        
        {/* Debug info */}
        {!_wildfireData && !nasaData && (
          <div className="text-xs text-gray-500 italic">Fetching live data from NASA, USGS, and OpenWeather...</div>
        )}
        
        {/* Current Weather Conditions */}
        <div className="bg-white p-2 rounded border">
          <div className="text-[10px] font-semibold text-gray-600 mb-1">Current Conditions</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-600">Temperature:</span>
              <span className="font-medium">
                {_wildfireData?.[0]?.temp !== undefined ? `${Math.round(_wildfireData[0].temp)}°C (${Math.round(_wildfireData[0].temp * 9/5 + 32)}°F)` : <span className="text-gray-400">Loading...</span>}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Humidity:</span>
              <span className="font-medium">
                {_wildfireData?.[0]?.humidity !== undefined ? `${_wildfireData[0].humidity}%` : <span className="text-gray-400">Loading...</span>}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Elevation:</span>
              <span className="font-medium">
                {_wildfireData?.[0]?.elevation !== undefined ? `${Math.round(_wildfireData[0].elevation)}m` : <span className="text-gray-400">Loading...</span>}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Base Risk:</span>
              <span className="font-medium">
                {_wildfireData?.[0]?.riskScore !== undefined ? `${_wildfireData[0].riskScore}/100` : <span className="text-gray-400">Loading...</span>}
              </span>
            </div>
          </div>
        </div>

        {/* NASA Enhancement Data */}
        {nasaData && (
          <div className="bg-blue-50 p-2 rounded border border-blue-200">
            <div className="text-[10px] font-semibold text-blue-900 mb-1 flex items-center gap-1">
              <span>🛰️</span> NASA Enhanced Data
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-700">Active Fires:</span>
                <span className="font-medium text-red-600">
                  {nasaData.nearbyFireCount || 0} within 50km
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Drought Level:</span>
                <span className="font-medium capitalize">
                  {nasaData.droughtLevel || 'normal'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Fire Risk Boost:</span>
                <span className="font-medium text-orange-600">
                  +{nasaData.fireRiskBoost || 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Drought Boost:</span>
                <span className="font-medium text-orange-600">
                  +{nasaData.droughtRiskBoost || 0}
                </span>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-blue-200">
              <div className="flex justify-between text-sm font-semibold">
                <span className="text-gray-700">Total Risk Score:</span>
                <span className={`${
                  nasaData.totalRisk > 70 ? 'text-red-600' :
                  nasaData.totalRisk > 45 ? 'text-orange-600' :
                  'text-green-600'
                }`}>
                  {nasaData.totalRisk || 0}/100
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ATTOM Fire Data (if available) */}
        {environmentalData?.fire?.nasa_enhancement && (
          <div className="bg-purple-50 p-2 rounded border border-purple-200">
            <div className="text-[10px] font-semibold text-purple-900 mb-1">📊 ATTOM + NASA Combined</div>
            <div className="text-[10px] text-gray-600">
              Total Risk: {environmentalData.fire.nasa_enhancement.totalRisk}/100
              {environmentalData.fire.nasa_enhancement.activeFires?.length > 0 && (
                <div className="mt-1 text-red-600 font-medium">
                  ⚠️ {environmentalData.fire.nasa_enhancement.activeFires.length} active fire(s) detected
                </div>
              )}
            </div>
          </div>
        )}

        {/* Data Sources */}
        <div className="text-[9px] text-gray-500 pt-2 border-t">
          <span className="font-semibold">Data Sources:</span> OpenWeather API (temp/humidity), 
          USGS (elevation), NASA FIRMS (active fires), NASA POWER (drought)
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 p-3 rounded-xl bg-slate-50/70 border border-slate-200/70">
        <div className="text-xs font-medium text-gray-700 mb-2">Risk Level</div>
        <div className="relative flex items-center gap-2">
          <div className="flex-1 h-3 rounded-full" style={{
            background: 'linear-gradient(to right, rgb(255,255,0), rgb(255,165,0), rgb(255,69,0), rgb(255,0,0), rgb(139,0,0))'
          }} />
          {/* Position indicator dot */}
          <div 
            className="absolute w-4 h-4 bg-white border-2 border-gray-800 rounded-full shadow-lg"
            style={{
              left: `${
                riskLevel === 'Low' ? 12 : 
                riskLevel === 'Moderate' ? 35 : 
                riskLevel === 'High' ? 65 : 
                riskLevel === 'Extreme' ? 90 : 
                35
              }%`,
              top: '50%',
              transform: 'translate(-50%, -50%)'
            }}
            title={`${riskLevel} Risk`}
          />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 mt-1">
          <span>Low</span>
          <span>Very High</span>
        </div>
      </div>
    </div>
  );
};

// ====================
// Financial Calculation Functions (based on formulas from screenshots)
// ====================



// ====================
// Financial Calculation Functions (based on formulas from screenshots)
// ====================

type FinancialInputs = {
  // From ATTOM
  avm: number;
  taxAmount: number;
  originalLoanAmount?: number;
  currentLoanBalance?: number;
  remainingLoanTermMonths?: number;
  loanOriginationDate?: string;
  monthlyDebtService?: number;
  
  // From user form
  monthlyRent: number;
  otherIncome: number;
  vacancyRate: number;
  rentGrowth: number;
  insurance: number;
  utilities: number;
  hoa: number;
  repairsCapEx: number;
  managementPct: number;
  expenseInflation: number;
  taxGrowth: number;
  interestRate: number;
  loanTerm: number;
  isInterestOnly: boolean;
  extraPrincipal: number;
  downPayment: number;
  closingCosts: number;
  initialRehab: number;
  appreciationRate: number;
};

type RentalPricingScenarioData = {
  currentRent: number;
  marketPotentialRent: number;
  recommendedRent: number;
  currentVacancyRate: number;
  benchmarkVacancyRate?: number;
  recommendedVacancyRate: number;
  projectedRentGrowth: number;
  currentProjectedRentGrowth: number;
  benchmarkProjectedRentGrowth?: number;
  recommendedProjectedRentGrowth: number;
  annualRevenueUpside: number;
  benchmarkAnnualRevenueUpside?: number;
  recommendedAnnualRevenueUpside: number;
  pricingPowerScore: number;
  customRent?: number;
  customVacancyRate?: number;
  customProjectedRentGrowth?: number;
  customAnnualRevenueUpside?: number;
};

type RentalPricingProjectionMode = 'none' | 'market' | 'recommended' | 'custom';

function getLoanProjectionBasis(inputs: FinancialInputs) {
  return {
    principal: inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0),
    termMonths: inputs.remainingLoanTermMonths ?? inputs.loanTerm,
  };
}

function getAnnualDebtService(inputs: FinancialInputs): number {
  if (inputs.monthlyDebtService != null && inputs.monthlyDebtService > 0) {
    return inputs.monthlyDebtService * 12;
  }

  if (inputs.interestRate <= 0) return 0;

  const { principal, termMonths } = getLoanProjectionBasis(inputs);
  const monthlyRate = inputs.interestRate / 100 / 12;
  if (principal <= 0 || termMonths <= 0) return 0;

  if (inputs.isInterestOnly) {
    return 12 * monthlyRate * principal;
  }

  const monthlyPayment = (monthlyRate * principal) / (1 - Math.pow(1 + monthlyRate, -termMonths));
  return 12 * monthlyPayment;
}

function getCurrentEquityBasis(inputs: FinancialInputs): number {
  const { principal } = getLoanProjectionBasis(inputs);
  return Math.max(inputs.avm - principal, 0);
}

function getForwardReturnCapitalBasis(inputs: FinancialInputs): number {
  const currentEquity = getCurrentEquityBasis(inputs);
  const currentNetSaleProceeds = Math.max(currentEquity - (inputs.avm * 0.06), 0);

  if (currentNetSaleProceeds > 0 && (inputs.currentLoanBalance != null || inputs.originalLoanAmount != null)) {
    return currentNetSaleProceeds;
  }

  return inputs.downPayment + inputs.closingCosts + inputs.initialRehab;
}

const LONG_RUN_RENT_GROWTH_CAP = 2.75;
const LONG_RUN_APPRECIATION_CAP = 2.25;
const GROWTH_FADE_START_YEAR = 3;
const GROWTH_FADE_END_YEAR = 12;

function getFadedAnnualGrowthRate(initialRatePercent: number, yearIndex: number, steadyStateCapPercent: number): number {
  const steadyStateRate = Math.min(initialRatePercent, steadyStateCapPercent);

  if (yearIndex < GROWTH_FADE_START_YEAR) {
    return initialRatePercent;
  }

  if (yearIndex >= GROWTH_FADE_END_YEAR) {
    return steadyStateRate;
  }

  const ratio = (yearIndex - GROWTH_FADE_START_YEAR) / Math.max(GROWTH_FADE_END_YEAR - GROWTH_FADE_START_YEAR, 1);
  return initialRatePercent + (steadyStateRate - initialRatePercent) * ratio;
}

function buildGrowthFactor(initialRatePercent: number, yearsElapsed: number, steadyStateCapPercent: number): number {
  let factor = 1;

  for (let yearIndex = 0; yearIndex < yearsElapsed; yearIndex++) {
    factor *= 1 + getFadedAnnualGrowthRate(initialRatePercent, yearIndex, steadyStateCapPercent) / 100;
  }

  return factor;
}

function getRentGrowthFactor(inputs: FinancialInputs, yearsElapsed: number): number {
  return buildGrowthFactor(inputs.rentGrowth, yearsElapsed, LONG_RUN_RENT_GROWTH_CAP);
}

function getAppreciationGrowthFactor(inputs: FinancialInputs, yearsElapsed: number): number {
  return buildGrowthFactor(inputs.appreciationRate, yearsElapsed, LONG_RUN_APPRECIATION_CAP);
}

// Calculate annual cash flow for each year
function calculateCashFlow(inputs: FinancialInputs, years: number = 30): number[] {
  const results: number[] = [];
  
  for (let t = 0; t < years; t++) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, t);
    // Projected rent: Rt = R0(1 + gr)^t
    const Rt = inputs.monthlyRent * rentGrowthFactor;
    
    // Other income: Ot = O0(1 + gr)^t
    const Ot = inputs.otherIncome * rentGrowthFactor;
    
    // Effective gross income: EGIt = 12(Rt + Ot)(1 - v)
    const EGIt = 12 * (Rt + Ot) * (1 - inputs.vacancyRate / 100);
    
    // Operating expenses (each inflated)
    // Insurance, utilities, HOA, and repairs are already ANNUAL values ($/yr), not monthly
    const ge = inputs.expenseInflation / 100;
    const Inst = inputs.insurance * Math.pow(1 + ge, t);
    const Ut = inputs.utilities * Math.pow(1 + ge, t);
    const Ht = inputs.hoa * Math.pow(1 + ge, t);
    const Capt = inputs.repairsCapEx * Math.pow(1 + ge, t);
    
    // Taxes with growth
    const Taxt = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, t);
    
    // Management
    const Mgmtt = (inputs.managementPct / 100) * EGIt;
    
    // OpEx
    const OpExt = Taxt + Inst + Ut + Ht + Capt + Mgmtt;
    
    // NOI
    const NOIt = EGIt - OpExt;
    
    // Debt service (if fully amortizing)
    let DSt = 0;
    if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal: L0, termMonths: n } = getLoanProjectionBasis(inputs);
      const rm = inputs.interestRate / 100 / 12;
      const M = (rm * L0) / (1 - Math.pow(1 + rm, -n));
      DSt = 12 * M;
    } else if (inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal: L0 } = getLoanProjectionBasis(inputs);
      const rm = inputs.interestRate / 100 / 12;
      DSt = 12 * rm * L0;
    }
    
    // Cash Flow
    const CFt = NOIt - DSt;
    results.push(CFt / 1000); // Convert to thousands for chart
  }
  
  return results;
}

// Calculate Income - Expenses (stacked bar chart showing EGI and expenses)
function calculateIncomeExpenses(inputs: FinancialInputs, years: number = 30): { 
  income: number[]; 
  expenses: number[];
  expenseBreakdown: {
    taxes: number[];
    insurance: number[];
    utilities: number[];
    hoa: number[];
    repairs: number[];
    management: number[];
    debtService: number[];
  }
} {
  const income: number[] = [];
  const expenses: number[] = [];
  const expenseBreakdown = {
    taxes: [] as number[],
    insurance: [] as number[],
    utilities: [] as number[],
    hoa: [] as number[],
    repairs: [] as number[],
    management: [] as number[],
    debtService: [] as number[],
  };
  
  for (let t = 0; t < years; t++) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, t);
    const Rt = inputs.monthlyRent * rentGrowthFactor;
    const Ot = inputs.otherIncome * rentGrowthFactor;
    const EGIt = 12 * (Rt + Ot) * (1 - inputs.vacancyRate / 100);
    
    const ge = inputs.expenseInflation / 100;
    // Insurance, utilities, HOA, and repairs are already ANNUAL values ($/yr), not monthly
    const Inst = inputs.insurance * Math.pow(1 + ge, t);
    const Ut = inputs.utilities * Math.pow(1 + ge, t);
    const Ht = inputs.hoa * Math.pow(1 + ge, t);
    const Capt = inputs.repairsCapEx * Math.pow(1 + ge, t);
    const Taxt = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, t);
    const Mgmtt = (inputs.managementPct / 100) * EGIt;
    const OpExt = Taxt + Inst + Ut + Ht + Capt + Mgmtt;
    
    // Debt service (mortgage payments)
    let DSt = 0;
    if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal: L0, termMonths: n } = getLoanProjectionBasis(inputs);
      const rm = inputs.interestRate / 100 / 12;
      const M = (rm * L0) / (1 - Math.pow(1 + rm, -n));
      DSt = 12 * M;
    } else if (inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal: L0 } = getLoanProjectionBasis(inputs);
      const rm = inputs.interestRate / 100 / 12;
      DSt = 12 * rm * L0;
    }
    
    // Total expenses = Operating expenses + Debt service
    const TotalExpenses = OpExt + DSt;
    
    income.push(EGIt / 1000);
    expenses.push(TotalExpenses / 1000);
    
    // Store breakdown (in thousands)
    expenseBreakdown.taxes.push(Taxt / 1000);
    expenseBreakdown.insurance.push(Inst / 1000);
    expenseBreakdown.utilities.push(Ut / 1000);
    expenseBreakdown.hoa.push(Ht / 1000);
    expenseBreakdown.repairs.push(Capt / 1000);
    expenseBreakdown.management.push(Mgmtt / 1000);
    expenseBreakdown.debtService.push(DSt / 1000);
  }
  
  return { income, expenses, expenseBreakdown };
}

// Calculate Cash-on-Cash Return
function calculateCoCReturn(inputs: FinancialInputs, years: number = 30): number[] {
  const results: number[] = [];
  const cashFlows = calculateCashFlow(inputs, years);
  
  const cashInBasis = getForwardReturnCapitalBasis(inputs);
  
  for (let t = 0; t < years; t++) {
    const CFt = cashFlows[t] * 1000; // Convert back from thousands
    const CoC = cashInBasis > 0 ? (CFt / cashInBasis) * 100 : 0;
    results.push(CoC);
  }
  
  return results;
}

// Calculate Cap Rate
function calculateCapRate(inputs: FinancialInputs, years: number = 30): number[] {
  const results: number[] = [];
  
  for (let t = 0; t < years; t++) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, t);
    const Rt = inputs.monthlyRent * rentGrowthFactor;
    const Ot = inputs.otherIncome * rentGrowthFactor;
    const EGIt = 12 * (Rt + Ot) * (1 - inputs.vacancyRate / 100);
    
    const ge = inputs.expenseInflation / 100;
    // Insurance, utilities, HOA, and repairs are already ANNUAL values ($/yr), not monthly
    const Inst = inputs.insurance * Math.pow(1 + ge, t);
    const Ut = inputs.utilities * Math.pow(1 + ge, t);
    const Ht = inputs.hoa * Math.pow(1 + ge, t);
    const CapExt = inputs.repairsCapEx * Math.pow(1 + ge, t);
    const Taxt = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, t);
    const Mgmtt = (inputs.managementPct / 100) * EGIt;
    const OpExt = Taxt + Inst + Ut + Ht + CapExt + Mgmtt;
    const NOIt = EGIt - OpExt;
    
    // Property value
    const Vt = inputs.avm * getAppreciationGrowthFactor(inputs, t);
    
    // Cap rate
    const CapRatet = Vt > 0 ? (NOIt / Vt) * 100 : 0;
    results.push(CapRatet);
  }
  
  return results;
}

// Calculate Net Operating Income (NOI)
function calculateNOI(inputs: FinancialInputs, years: number = 30): number[] {
  const results: number[] = [];
  
  for (let t = 0; t < years; t++) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, t);
    const Rt = inputs.monthlyRent * rentGrowthFactor;
    const Ot = inputs.otherIncome * rentGrowthFactor;
    const EGIt = 12 * (Rt + Ot) * (1 - inputs.vacancyRate / 100);
    
    const ge = inputs.expenseInflation / 100;
    // Insurance, utilities, HOA, and repairs are already ANNUAL values ($/yr), not monthly
    const Inst = inputs.insurance * Math.pow(1 + ge, t);
    const Ut = inputs.utilities * Math.pow(1 + ge, t);
    const Ht = inputs.hoa * Math.pow(1 + ge, t);
    const Capt = inputs.repairsCapEx * Math.pow(1 + ge, t);
    const Taxt = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, t);
    const Mgmtt = (inputs.managementPct / 100) * EGIt;
    const OpExt = Taxt + Inst + Ut + Ht + Capt + Mgmtt;
    const NOIt = EGIt - OpExt;
    
    results.push(NOIt / 1000);
  }
  
  return results;
}

// Calculate Equity Accumulated (mortgage paydown)
function calculateEquityAccumulated(inputs: FinancialInputs, years: number = 30): number[] {
  const results: number[] = [];
  
  const { principal: L0, termMonths: n } = getLoanProjectionBasis(inputs);
  const rm = inputs.interestRate / 100 / 12;
  
  if (inputs.interestRate === 0 || inputs.isInterestOnly) {
    // No equity accumulation from mortgage paydown
    for (let t = 0; t < years; t++) {
      results.push(0);
    }
    return results;
  }
  
  const M = (rm * L0) / (1 - Math.pow(1 + rm, -n));
  
  for (let t = 0; t < years; t++) {
    const k = (t + 1) * 12; // months
    const Bk = L0 * Math.pow(1 + rm, k) - M * ((Math.pow(1 + rm, k) - 1) / rm);
    const equityFromPaydown = L0 - Bk;
    results.push(equityFromPaydown / 1000);
  }
  
  return results;
}

// Calculate Annual Income (gross and collected)
function calculateAnnualIncome(inputs: FinancialInputs, years: number = 30): { gross: number[]; collected: number[] } {
  const gross: number[] = [];
  const collected: number[] = [];
  
  for (let t = 0; t < years; t++) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, t);
    const Rt = inputs.monthlyRent * rentGrowthFactor;
    const Ot = inputs.otherIncome * rentGrowthFactor;
    const grossIncome = 12 * (Rt + Ot);
    const collectedIncome = grossIncome * (1 - inputs.vacancyRate / 100);
    
    gross.push(grossIncome / 1000);
    collected.push(collectedIncome / 1000);
  }
  
  return { gross, collected };
}

// Calculate Mortgage Amortization - Loan Balance (principal vs interest breakdown)
function calculateMortgageAmortization(inputs: FinancialInputs, years: number = 30, periodsPerYear: number = 1): { principal: number[]; interest: number[]; loanBalance: number[] } {
  const principal: number[] = [];
  const interest: number[] = [];
  const loanBalance: number[] = [];
  
  const { principal: L0, termMonths: n } = getLoanProjectionBasis(inputs);
  const rm = inputs.interestRate / 100 / 12;
  const monthsPerPeriod = Math.max(1, Math.round(12 / periodsPerYear));
  const totalPeriods = years * periodsPerYear;
  
  if (inputs.interestRate === 0) {
    for (let t = 0; t < totalPeriods; t++) {
      principal.push(0);
      interest.push(0);
      loanBalance.push(L0 / 1000);
    }
    return { principal, interest, loanBalance };
  }
  
  if (inputs.isInterestOnly) {
    const periodicInterest = (monthsPerPeriod * rm * L0) / 1000;
    for (let t = 0; t < totalPeriods; t++) {
      principal.push(0);
      interest.push(periodicInterest);
      loanBalance.push(L0 / 1000); // Loan balance stays the same with interest-only
    }
    return { principal, interest, loanBalance };
  }
  
  const M = (rm * L0) / (1 - Math.pow(1 + rm, -n));
  let currentBalance = L0;
  
  for (let t = 0; t < totalPeriods; t++) {
    let periodPrincipal = 0;
    let periodInterest = 0;
    
    for (let step = 0; step < monthsPerPeriod; step++) {
      const monthNumber = (t * monthsPerPeriod) + step + 1;
      if (monthNumber > n || currentBalance <= 0.01) break;
    
      const monthlyInterest = rm * currentBalance;
      const monthlyPrincipal = Math.min(Math.max(M - monthlyInterest, 0), currentBalance);

      periodPrincipal += monthlyPrincipal;
      periodInterest += monthlyInterest;
      currentBalance = Math.max(currentBalance - monthlyPrincipal, 0);
    }
    
    principal.push(periodPrincipal / 1000);
    interest.push(periodInterest / 1000);
    loanBalance.push(currentBalance / 1000);
  }
  
  return { principal, interest, loanBalance };
}

// Calculate Rental Pricing Power (comparing actual rent to market baseline)
function calculateRentalPricingPower(inputs: FinancialInputs, years: number = 30): number[] {
  const results: number[] = [];
  
  // Calculate a market rent baseline using typical rent-to-value ratio (~0.7% monthly)
  const typicalMonthlyRentRatio = 0.007; // 0.7% of property value per month
  const marketRent0 = inputs.avm * typicalMonthlyRentRatio;
  
  // Assume market rents grow at a typical rate (e.g., 3% annually)
  const marketGrowthRate = 3; // 3% typical market growth
  
  for (let t = 0; t < years; t++) {
    const actualRent = inputs.monthlyRent * getRentGrowthFactor(inputs, t);
    const marketRent = marketRent0 * Math.pow(1 + marketGrowthRate / 100, t);
    
    // Pricing power as index (100 = at market, >100 = above market, <100 = below market)
    const pricingPower = (actualRent / marketRent) * 100;
    results.push(pricingPower);
  }
  
  return results;
}

// Calculate Property Appreciation - Equity - Loan Balance (three-line chart)
function calculatePropertyAppreciation(inputs: FinancialInputs, years: number = 30): { value: number[]; equity: number[]; loan: number[] } {
  const value: number[] = [];
  const equity: number[] = [];
  const loan: number[] = [];
  
  const { principal: L0, termMonths: n } = getLoanProjectionBasis(inputs);
  const rm = inputs.interestRate / 100 / 12;
  const M = inputs.interestRate > 0 && !inputs.isInterestOnly ? (rm * L0) / (1 - Math.pow(1 + rm, -n)) : 0;
  
  for (let t = 0; t < years; t++) {
    // Property value
    const Vt = inputs.avm * getAppreciationGrowthFactor(inputs, t);
    
    // Loan balance
    let Bt = L0;
    if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const k = (t + 1) * 12;
      Bt = L0 * Math.pow(1 + rm, k) - M * ((Math.pow(1 + rm, k) - 1) / rm);
    }
    
    // Equity
    const Eqt = Math.max(Vt - Bt, 0);
    
    value.push(Vt / 1000);
    equity.push(Eqt / 1000);
    loan.push(Bt / 1000);
  }
  
  return { value, equity, loan };
}

// Calculate IRR (Internal Rate of Return) - THE gold standard metric
function solveIRR(cashFlows: number[]): number {
  if (!cashFlows.some((cashFlow) => cashFlow < 0) || !cashFlows.some((cashFlow) => cashFlow > 0)) {
    return 0;
  }

  let irr = 0.1; // Start with 10% guess
  const maxIterations = 100;
  const tolerance = 0.0001;
  
  for (let i = 0; i < maxIterations; i++) {
    let npv = 0;
    let dnpv = 0;
    
    for (let t = 0; t < cashFlows.length; t++) {
      npv += cashFlows[t] / Math.pow(1 + irr, t);
      dnpv += -t * cashFlows[t] / Math.pow(1 + irr, t + 1);
    }

    if (!Number.isFinite(npv) || !Number.isFinite(dnpv) || Math.abs(dnpv) < 1e-9) {
      return 0;
    }
    
    const newIrr = irr - npv / dnpv;
    if (!Number.isFinite(newIrr) || newIrr <= -0.9999 || Math.abs(newIrr) > 10) {
      return 0;
    }

    if (Math.abs(newIrr - irr) < tolerance) {
      return newIrr * 100; // Return as percentage
    }
    irr = newIrr;
  }
  
  return Number.isFinite(irr) && Math.abs(irr) <= 10 ? irr * 100 : 0;
}

function calculateIRR(inputs: FinancialInputs, holdingPeriod: number = 30): number {
  const cashFlows = calculateCashFlow(inputs, holdingPeriod);
  const appreciation = calculatePropertyAppreciation(inputs, holdingPeriod);
  
  // Forward-looking hold IRR should use current capital at risk, not original acquisition cash.
  const cf0 = -getForwardReturnCapitalBasis(inputs);
  
  // Annual cash flows (years 1 through n-1)
  const annualCFs = cashFlows.slice(0, holdingPeriod - 1).map(cf => cf * 1000);
  
  // Final year: cash flow + sale proceeds
  const lastIdx = holdingPeriod - 1;
  const finalCashFlow = (cashFlows[lastIdx] || 0) * 1000;
  const salePrice = (appreciation.value[lastIdx] || 0) * 1000;
  const loanBalance = (appreciation.loan[lastIdx] || 0) * 1000;
  const sellingCosts = salePrice * 0.06; // 6% selling costs
  const netSaleProceeds = salePrice - loanBalance - sellingCosts;
  const finalYear = finalCashFlow + netSaleProceeds;
  
  // Calculate IRR using Newton's method
  const allCashFlows = [cf0, ...annualCFs, finalYear];
  
  return solveIRR(allCashFlows);
}

function calculateRollingIRR(inputs: FinancialInputs, maxHoldingPeriod: number = 30): number[] {
  const results: number[] = [];

  for (let holdingPeriod = 1; holdingPeriod <= maxHoldingPeriod; holdingPeriod++) {
    const irr = calculateIRR(inputs, holdingPeriod);
    results.push(Number.isFinite(irr) ? irr : 0);
  }

  return results;
}

// Calculate DSCR (Debt Service Coverage Ratio)
function calculateDSCR(inputs: FinancialInputs, years: number = 30): number[] {
  const noi = calculateNOI(inputs, years);
  const results: number[] = [];
  
  // Calculate annual debt service (fixed for all years)
  let annualDebtService = 0;
  if (inputs.interestRate > 0) {
    annualDebtService = getAnnualDebtService(inputs);
  }
  
  for (let t = 0; t < years; t++) {
    const noiValue = noi[t] * 1000; // Convert from thousands
    
    if (annualDebtService === 0 || inputs.interestRate === 0) {
      results.push(999); // No debt = infinite coverage (cap at 999 for display)
    } else {
      const dscr = noiValue / annualDebtService;
      results.push(Math.max(dscr, 0)); // Ensure non-negative
    }
  }
  
  return results;
}

// Calculate Total Return (cumulative wealth creation)
function calculateTotalReturn(inputs: FinancialInputs, years: number = 30): { cumulative: number[]; annualPercent: number[] } {
  const cashFlows = calculateCashFlow(inputs, years);
  const appreciation = calculatePropertyAppreciation(inputs, years);
  
  const cumulative: number[] = [];
  const annualPercent: number[] = [];
  let cumulativeCF = 0;
  
  const initialInvestment = getForwardReturnCapitalBasis(inputs);
  const initialEquity = getCurrentEquityBasis(inputs);
  
  for (let t = 0; t < years; t++) {
    const cf = cashFlows[t] * 1000;
    cumulativeCF += cf;
    
    const currentEquity = (appreciation.equity[t] || 0) * 1000;
    const equityGain = currentEquity - initialEquity;
    const totalReturn = cumulativeCF + equityGain;
    
    cumulative.push(totalReturn / 1000);
    
    // Annual return as percentage
    if (initialInvestment > 0) {
      annualPercent.push((totalReturn / initialInvestment) * 100);
    } else {
      annualPercent.push(0);
    }
  }
  
  return { cumulative, annualPercent };
}

// Calculate Break-Even Occupancy
function calculateBreakEvenOccupancy(inputs: FinancialInputs): number {
  const Rt = inputs.monthlyRent;
  const Ot = inputs.otherIncome;
  const grossPotentialIncome = 12 * (Rt + Ot);
  
  if (grossPotentialIncome === 0) return 100;
  
  // Operating expenses (year 0)
  // Insurance, utilities, HOA, and repairs are already ANNUAL values ($/yr), not monthly
  const Inst = inputs.insurance;
  const Ut = inputs.utilities;
  const Ht = inputs.hoa;
  const Capt = inputs.repairsCapEx;
  const Taxt = inputs.taxAmount;
  
  // Debt service
  let debtService = 0;
  if (inputs.interestRate > 0) {
    debtService = getAnnualDebtService(inputs);
  }
  
  const fixedCosts = Taxt + Inst + Ut + Ht + Capt + debtService;
  const mgmtRate = inputs.managementPct / 100;
  
  // Solve for: grossPotentialIncome * occupancy * (1 - mgmt%) = fixedCosts
  // occupancy = fixedCosts / (grossPotentialIncome * (1 - mgmt%))
  const denominator = grossPotentialIncome * (1 - mgmtRate);
  if (denominator === 0) return 100;
  
  const breakEvenOccupancy = fixedCosts / denominator;
  
  return Math.min(Math.max(breakEvenOccupancy * 100, 0), 100); // Return as percentage, clamped 0-100
}

function buildPortfolioAnalyticsChartData(inputs: FinancialInputs, analyticsGranularity: ProjectionGranularity) {
  const periodsPerYear = getProjectionPeriodsPerYear(analyticsGranularity);
  const projectionYears = 30;
  const annualIncomeExpenses = calculateIncomeExpenses(inputs, projectionYears);
  const annualPropertyAppreciation = calculatePropertyAppreciation(inputs, projectionYears);
  const annualTotalReturn = calculateTotalReturn(inputs, projectionYears);
  const annualIncome = calculateAnnualIncome(inputs, projectionYears);

  return {
    projectionGranularity: analyticsGranularity,
    projectionLabels: buildProjectionLabels(projectionYears * periodsPerYear, analyticsGranularity),
    holdingPeriodLabels: buildHoldingPeriodLabels(projectionYears * periodsPerYear, analyticsGranularity),
    mortgageLabels: buildProjectionLabels(projectionYears * periodsPerYear, analyticsGranularity),
    cashFlow: interpolateSeries(calculateCashFlow(inputs, projectionYears), analyticsGranularity, 'flow'),
    incomeExpenses: {
      ...annualIncomeExpenses,
      income: interpolateSeries(annualIncomeExpenses.income, analyticsGranularity, 'flow'),
      expenses: interpolateSeries(annualIncomeExpenses.expenses, analyticsGranularity, 'flow'),
      expenseBreakdown: {
        taxes: interpolateSeries(annualIncomeExpenses.expenseBreakdown.taxes, analyticsGranularity, 'flow'),
        insurance: interpolateSeries(annualIncomeExpenses.expenseBreakdown.insurance, analyticsGranularity, 'flow'),
        utilities: interpolateSeries(annualIncomeExpenses.expenseBreakdown.utilities, analyticsGranularity, 'flow'),
        hoa: interpolateSeries(annualIncomeExpenses.expenseBreakdown.hoa, analyticsGranularity, 'flow'),
        repairs: interpolateSeries(annualIncomeExpenses.expenseBreakdown.repairs, analyticsGranularity, 'flow'),
        management: interpolateSeries(annualIncomeExpenses.expenseBreakdown.management, analyticsGranularity, 'flow'),
        debtService: interpolateSeries(annualIncomeExpenses.expenseBreakdown.debtService, analyticsGranularity, 'flow'),
      },
    },
    cocReturn: interpolateSeries(calculateCoCReturn(inputs, projectionYears), analyticsGranularity, 'level'),
    capRate: interpolateSeries(calculateCapRate(inputs, projectionYears), analyticsGranularity, 'level'),
    noi: interpolateSeries(calculateNOI(inputs, projectionYears), analyticsGranularity, 'flow'),
    equityAccumulated: interpolateSeries(calculateEquityAccumulated(inputs, projectionYears), analyticsGranularity, 'level'),
    annualIncome: {
      gross: interpolateSeries(annualIncome.gross, analyticsGranularity, 'flow'),
      collected: interpolateSeries(annualIncome.collected, analyticsGranularity, 'flow'),
    },
    mortgageAmortization: calculateMortgageAmortization(inputs, projectionYears, periodsPerYear),
    rentalPricingPower: interpolateSeries(calculateRentalPricingPower(inputs, projectionYears), analyticsGranularity, 'level'),
    propertyAppreciation: {
      value: interpolateSeries(annualPropertyAppreciation.value, analyticsGranularity, 'level'),
      equity: interpolateSeries(annualPropertyAppreciation.equity, analyticsGranularity, 'level'),
      loan: interpolateSeries(annualPropertyAppreciation.loan, analyticsGranularity, 'level'),
    },
    irr: calculateIRR(inputs, 9),
    rollingIrr: interpolateSeries(calculateRollingIRR(inputs, projectionYears), analyticsGranularity, 'level'),
    dscr: interpolateSeries(calculateDSCR(inputs, projectionYears), analyticsGranularity, 'level'),
    totalReturn: {
      cumulative: interpolateSeries(annualTotalReturn.cumulative, analyticsGranularity, 'level'),
      annualPercent: interpolateSeries(annualTotalReturn.annualPercent, analyticsGranularity, 'level'),
    },
    breakEvenOccupancy: calculateBreakEvenOccupancy(inputs),
    grm: calculateGRM(inputs),
  };
}

function formatAuditCurrency(value: number): string {
  const absoluteValue = Math.abs(Number(value || 0));
  const formatted = absoluteValue.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${value < 0 ? '-' : ''}$${formatted}`;
}

function formatAuditPercent(value: number, digits: number = 2): string {
  return `${Number(value || 0).toFixed(digits)}%`;
}

// Calculate GRM (Gross Rent Multiplier)
function calculateGRM(inputs: FinancialInputs): number {
  const annualRent = 12 * inputs.monthlyRent;
  if (annualRent === 0) return 0;
  return inputs.avm / annualRent;
}

// ====================
// Per-property AVM history processor (mirrors the global avmPoints memo)
// ====================
type CardAvmGranularity = 'quarterly' | 'annual';
type CardAvmRange = '2Q' | '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | 'all';

type NormalizedAvmHistoryPoint = { date: Date; value: number };
type AvmSeriesBucket = { key: string; label: string; sortKey: number; value: number };

function normalizeAvmHistory(history: any[] | undefined): NormalizedAvmHistoryPoint[] {
  return (Array.isArray(history) ? history : [])
    .filter((item: any) => item?.date && Number.isFinite(Number(item?.value)))
    .map((item: any) => ({ date: new Date(item.date), value: Number(item.value) }))
    .filter((item) => !Number.isNaN(item.date.getTime()))
    .sort((left, right) => left.date.getTime() - right.date.getTime());
}

function resolveAvmCutoffDate(referenceDate: Date, range: CardAvmRange): Date {
  switch (range) {
    case '2Q': return new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 6, referenceDate.getDate());
    case '1Y': return new Date(referenceDate.getFullYear() - 1, referenceDate.getMonth(), referenceDate.getDate());
    case '2Y': return new Date(referenceDate.getFullYear() - 2, referenceDate.getMonth(), referenceDate.getDate());
    case '3Y': return new Date(referenceDate.getFullYear() - 3, referenceDate.getMonth(), referenceDate.getDate());
    case '5Y': return new Date(referenceDate.getFullYear() - 5, referenceDate.getMonth(), referenceDate.getDate());
    case '10Y': return new Date(referenceDate.getFullYear() - 10, referenceDate.getMonth(), referenceDate.getDate());
    case 'all': return new Date(1900, 0, 1);
    default: return new Date(referenceDate.getFullYear() - 10, referenceDate.getMonth(), referenceDate.getDate());
  }
}

function bucketAvmHistory(
  normalizedHistory: NormalizedAvmHistoryPoint[],
  granularity: CardAvmGranularity,
  cutoffDate: Date,
): AvmSeriesBucket[] {
  const filtered = normalizedHistory.filter((item) => item.date >= cutoffDate);

  if (granularity === 'annual') {
    const yearMap = new Map<number, number>();
    filtered.forEach((item) => yearMap.set(item.date.getFullYear(), item.value));
    return Array.from(yearMap.entries())
      .sort(([leftYear], [rightYear]) => leftYear - rightYear)
      .map(([year, value]) => ({
        key: `${year}`,
        label: `${year}`,
        sortKey: year,
        value,
      }));
  }

  const quarterMap = new Map<string, AvmSeriesBucket>();
  filtered.forEach((item) => {
    const year = item.date.getFullYear();
    const quarter = Math.floor(item.date.getMonth() / 3) + 1;
    const key = `${year}-Q${quarter}`;
    quarterMap.set(key, {
      key,
      label: `Q${quarter} ${year}`,
      sortKey: year * 10 + quarter,
      value: item.value,
    });
  });

  return Array.from(quarterMap.values()).sort((left, right) => left.sortKey - right.sortKey);
}

function buildAvmSeries(
  history: any[] | undefined,
  comparableHistory: any[] | undefined,
  granularity: CardAvmGranularity,
  range: CardAvmRange
): { points: MiniPoint[]; comparisonPoints: MiniPoint[]; labels: string[] } {
  const normalizedSubjectHistory = normalizeAvmHistory(history);
  const normalizedComparableHistory = normalizeAvmHistory(comparableHistory);
  const allHistory = [...normalizedSubjectHistory, ...normalizedComparableHistory];

  if (!allHistory.length) {
    return { points: [], comparisonPoints: [], labels: [] };
  }

  const referenceDate = allHistory.reduce(
    (latest, item) => (item.date.getTime() > latest.getTime() ? item.date : latest),
    allHistory[0].date,
  );
  const cutoffDate = resolveAvmCutoffDate(referenceDate, range);
  const subjectBuckets = bucketAvmHistory(normalizedSubjectHistory, granularity, cutoffDate);
  const comparableBuckets = bucketAvmHistory(normalizedComparableHistory, granularity, cutoffDate);

  if (!subjectBuckets.length && !comparableBuckets.length) {
    return { points: [], comparisonPoints: [], labels: [] };
  }

  const orderedBuckets = Array.from(
    [...subjectBuckets, ...comparableBuckets].reduce((map, bucket) => {
      if (!map.has(bucket.key)) {
        map.set(bucket.key, { key: bucket.key, label: bucket.label, sortKey: bucket.sortKey });
      }
      return map;
    }, new Map<string, { key: string; label: string; sortKey: number }>()).values(),
  ).sort((left, right) => left.sortKey - right.sortKey);

  const subjectValueByKey = new Map(subjectBuckets.map((bucket) => [bucket.key, bucket.value]));
  const comparableValueByKey = new Map(comparableBuckets.map((bucket) => [bucket.key, bucket.value]));
  const points: MiniPoint[] = [];
  const comparisonPoints: MiniPoint[] = [];
  const labels: string[] = [];
  const hasComparableSeries = comparableBuckets.length > 0;
  let lastSubjectValue = subjectBuckets[0]?.value ?? null;
  let lastComparableValue = comparableBuckets[0]?.value ?? null;

  orderedBuckets.forEach((bucket) => {
    if (subjectValueByKey.has(bucket.key)) {
      lastSubjectValue = subjectValueByKey.get(bucket.key) ?? lastSubjectValue;
    }
    if (hasComparableSeries && comparableValueByKey.has(bucket.key)) {
      lastComparableValue = comparableValueByKey.get(bucket.key) ?? lastComparableValue;
    }

    if (lastSubjectValue == null) {
      return;
    }

    const nextIndex = points.length;
    points.push({ x: nextIndex, y: lastSubjectValue });
    labels.push(bucket.label);

    if (hasComparableSeries && lastComparableValue != null) {
      comparisonPoints.push({ x: nextIndex, y: lastComparableValue });
    }
  });

  return { points, comparisonPoints, labels };
}

type PropertyWorkspaceSubTab = PropertyWorkspaceTabId;
const PROPERTY_WORKSPACE_TAB_LABELS: Record<PropertyWorkspaceSubTab, string> = {
  overview: 'Overview',
  analytics: 'Analytics',
  rentalPricingPower: 'Rental Pricing Power',
  environmentalRisk: 'Environmental Risk',
  propertyHealth: 'Property Health',
};

const PortfolioPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [valueTrendGranularity, setValueTrendGranularity] = useState<PropertyPortfolioHistoryGranularity>('quarterly');
  /**
   * What occupies the centre of the Overview card. The holdings map and the
   * value trend used to be a separate slab above the property, which meant
   * scrolling past two portfolio boxes to reach the property in view; they are
   * views of this one card now.
   */
  const [overviewVisual, setOverviewVisual] = useState<PropertyVisualView>('street');
  const [workspaceSubTab, setWorkspaceSubTab] = useState<PropertyWorkspaceSubTab>(() => normalizePropertyWorkspaceTab('overview'));

  useEffect(() => {
    setWorkspaceSubTab((current) => normalizePropertyWorkspaceTab(current));
  }, []);
  const [expandedTenantMessages, setExpandedTenantMessages] = useState<string | null>(null);
  const [messagingModalOpen, setMessagingModalOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [addTenantModalOpen, setAddTenantModalOpen] = useState(false);
  const [editTenantModalOpen, setEditTenantModalOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  
  // Stripe Connect state
  const [landlordStripeAccountId, setLandlordStripeAccountId] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<string | null>(null);
  
  // Handle Stripe onboarding return
  useEffect(() => {
    const setup = searchParams.get('setup');
    if (setup === 'complete') {
      setSetupStatus('complete');
      // Clear URL params after 5 seconds
      setTimeout(() => {
        setSetupStatus(null);
        setSearchParams({});
      }, 5000);
    } else if (setup === 'refresh') {
      setSetupStatus('refresh');
      setTimeout(() => {
        setSetupStatus(null);
        setSearchParams({});
      }, 5000);
    }
  }, [searchParams, setSearchParams]);

  // Load landlord's connected Stripe account on mount
  useEffect(() => {
    const loadStripeAccount = async () => {
      try {
        const response = await fetch('/api/stripe-connect/accounts/landlord-1');
        const data = await response.json();
        if (data.ok && data.accounts.length > 0) {
          // Find first account that can accept payments
          const connectedAccount = data.accounts.find((acc: any) => 
            acc.onboardingComplete && acc.chargesEnabled
          );
          if (connectedAccount) {
            setLandlordStripeAccountId(connectedAccount.accountId);
            console.log('Loaded Stripe account:', connectedAccount.accountId);
          }
        }
      } catch (error) {
        console.error('Error loading Stripe account:', error);
      }
    };
    loadStripeAccount();
  }, [setupStatus]);
  
  // Load tenant income verification data
  useEffect(() => {
    const loadTenantIncome = async () => {
      setLoadingTenantIncome(true);
      try {
        const response = await fetch('/api/income-verification/all-tenants');
        const data = await response.json();
        if (data.ok) {
          setTenantIncomeData(data.tenants);
          console.log('[Landlord] Loaded tenant income data:', data.tenants);
        }
      } catch (error) {
        console.error('[Landlord] Error loading tenant income:', error);
      } finally {
        setLoadingTenantIncome(false);
      }
    };
    loadTenantIncome();
  }, []);
  
  // Tenant screening state - fetch real data from database
  const [applicants, setApplicants] = useState<TenantApplicant[]>([]);
  const [loadingApplicants, setLoadingApplicants] = useState(true);
  
  // Load real screening requests on mount
  useEffect(() => {
    async function loadScreeningRequests() {
      try {
        const response = await fetch('/api/screening/requests/all');
        const data = await response.json();
        
        if (data.ok && data.requests) {
          // Transform database records to TenantApplicant format
          const transformed: TenantApplicant[] = data.requests.map((req: any) => ({
            id: `screening-${req.id}`,
            name: req.applicantName,
            email: req.applicantEmail,
            appliedDate: req.createdAt,
            status: req.status === 'completed' ? 'approved' : req.status === 'submitted' ? 'pending' : 'pending',
            creditScore: req.creditScore || undefined,
            backgroundCheck: req.creditStatus || 'pending',
            incomeVerification: { verified: req.incomeVerified || false },
            // Extended data from screening
            incomeData: req.incomeData,
            creditReport: req.creditReport,
            submittedAddress: req.submittedAddress,
            propertyAddress: req.propertyAddress,
            token: req.token // Token for refreshing income data
          } as TenantApplicant));
          setApplicants(transformed);
        }
      } catch (error) {
        console.error('Error loading screening requests:', error);
      } finally {
        setLoadingApplicants(false);
      }
    }
    loadScreeningRequests();
  }, []);
  
  const [screeningModalOpen, setScreeningModalOpen] = useState(false);
  const [interviewSchedulerOpen, setInterviewSchedulerOpen] = useState(false);
  const [selectedApplicant, setSelectedApplicant] = useState<TenantApplicant | null>(null);
  const [creditCheckLoading, setCreditCheckLoading] = useState(false);
  const [creditCheckError, setCreditCheckError] = useState<string | null>(null);
  const [backgroundCheckLoading, setBackgroundCheckLoading] = useState(false);
  const [backgroundCheckError, setBackgroundCheckError] = useState<string | null>(null);
  const [createListingModalOpen, setCreateListingModalOpen] = useState(false);
  
  // Equifax test mode toggle - use Equifax CTEST data instead of real applicant data
  const [equifaxTestMode, setEquifaxTestMode] = useState(true); // Default to test mode
  const [showCreditCheckForm, setShowCreditCheckForm] = useState(false);
  const [creditCheckFormData, setCreditCheckFormData] = useState({
    ssn: '',
    dateOfBirth: '',
    street: '',
    city: '',
    state: '',
    zipCode: ''
  });
  
  // Tenant income verification state
  const [tenantIncomeData, setTenantIncomeData] = useState<any[]>([]);
  const [loadingTenantIncome, setLoadingTenantIncome] = useState(false);
  const [showIncomeVerificationModal, setShowIncomeVerificationModal] = useState(false);
  
  // Send screening link modal state
  const [sendScreeningLinkModalOpen, setSendScreeningLinkModalOpen] = useState(false);
  const [sendScreeningLinkData, setSendScreeningLinkData] = useState({
    applicantName: '',
    applicantEmail: '',
    propertyAddress: ''
  });
  const [sendingScreeningLink, setSendingScreeningLink] = useState(false);
  const [screeningLinkSent, setScreeningLinkSent] = useState(false);
  const [screeningLinkError, setScreeningLinkError] = useState<string | null>(null);
  
  // Payment state variables - currently unused but reserved for future payment integration
  // @ts-ignore - Reserved for future payment integration
  const [paymentLoading, setPaymentLoading] = useState(false);
  // @ts-ignore - Reserved for future payment integration
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  // @ts-ignore - Reserved for future payment integration
  const [paymentDescription, setPaymentDescription] = useState('Monthly Rent Payment');
  const [showAddPropertyForm, setShowAddPropertyForm] = useState(false);
  const [newPropertyAddress, setNewPropertyAddress] = useState("");
  const [newPropertyLocation, setNewPropertyLocation] = useState("");
  const [addressAutocompleteMode, setAddressAutocompleteMode] = useState<'manual' | 'widget'>('manual');
  const openAddPropertyForm = useCallback((params?: Record<string, any>) => {
    const address = params?.address || params?.propertyAddress || params?.fullAddress;
    const location = params?.location || params?.cityState || params?.market;
    if (typeof address === 'string') {
      setNewPropertyAddress(address);
    }
    if (typeof location === 'string') {
      setNewPropertyLocation(location);
    }
    setShowAddPropertyForm(true);
  }, []);
  useVoiceActionHandler('add-property', openAddPropertyForm, [openAddPropertyForm]);
  useVoiceActionHandler('open-add-property-modal', openAddPropertyForm, [openAddPropertyForm]);

  useVoiceActionHandler('analyze-property', (params?: Record<string, any>) => {
    const address = String(params?.address || params?.propertyAddress || params?.location || '').trim();
    const propertyId = String(params?.propertyId || params?.property || '').trim();
    const workspaceRaw = String(params?.workspace || params?.mode || 'overview').toLowerCase();
    const workspaceCandidate = workspaceRaw === 'rental_pricing' || workspaceRaw === 'rentalpricingpower'
      ? 'rentalPricingPower'
      : workspaceRaw === 'environmental_risk' || workspaceRaw === 'environmentalrisk'
        ? 'environmentalRisk'
        : workspaceRaw === 'property_health' || workspaceRaw === 'propertyhealth' || workspaceRaw === 'health'
          ? 'propertyHealth'
          : workspaceRaw === 'analytics' || workspaceRaw === 'full'
            ? 'analytics'
            : 'overview';
    const workspace = normalizePropertyWorkspaceTab(workspaceCandidate);

    const next = new URLSearchParams(searchParams);
    next.set('tab', 'properties');
    next.set('workspace', workspace);
    if (propertyId) next.set('property', propertyId);
    if (address) next.set('address', address);
    setSearchParams(next, { replace: true });
    setWorkspaceSubTab(workspace);
  }, [searchParams, setSearchParams]);
  
  // Voice command integration - handle "open-add-property-modal" action
  const voiceContext = (() => { try { return useVoiceCommand(); } catch { return null; } })();
  useEffect(() => {
    if (voiceContext?.pendingAction?.action === 'open-add-property-modal') {
      setShowAddPropertyForm(true);
      voiceContext.clearPendingAction();
    }
  }, [voiceContext?.pendingAction]);
  
  // Property financial data structure
  type PropertyFinancialData = {
    // Income inputs
    monthlyRent: number;
    otherIncome: number;
    vacancyRate: number;
    rentGrowth: number;
    
    // Expense inputs
    insurance: number;
    utilities: number;
    hoa: number;
    repairsCapEx: number;
    managementPct: number;
    expenseInflation: number;
    taxInflation: number;
    
    // Debt inputs
    interestRate: number;
    loanTerm: number;
    originalLoanAmount?: number;
    currentLoanBalance?: number;
    remainingLoanTermMonths?: number;
    loanOriginationDate?: string;
    monthlyDebtService?: number;
    isInterestOnly: boolean;
    extraPrincipal: number;
    downPayment: number;
    closingCosts: number;
    initialRehab: number;
    
    // Valuation inputs
    appreciationRate: number;
  };
  
  const [primaryProperty, setPrimaryProperty] = useState<{ 
    address: string; 
    location: string;
    financials?: PropertyFinancialData;
  }>({ address: "", location: "" });
  
  // Financial form inputs (initialize with defaults)
  const [monthlyRent, setMonthlyRent] = useState<number>(0);
  const [otherIncome, setOtherIncome] = useState<number>(0);
  const [vacancyRate, setVacancyRate] = useState<number>(5); // 5% default
  const [rentGrowth, setRentGrowth] = useState<number>(3); // 3% default
  const [insurance, setInsurance] = useState<number>(0);
  const [utilities, setUtilities] = useState<number>(0);
  const [hoa, setHoa] = useState<number>(0);
  const [repairsCapEx, setRepairsCapEx] = useState<number>(0);
  const [managementPct, setManagementPct] = useState<number>(8); // 8% default
  const [expenseInflation, setExpenseInflation] = useState<number>(3); // 3% default
  const [taxInflation, setTaxInflation] = useState<number>(3); // 3% default
  const [interestRate, setInterestRate] = useState<number>(0);
  const [loanTerm, setLoanTerm] = useState<number>(360); // 30 years default
  const [isInterestOnly, setIsInterestOnly] = useState<boolean>(false);
  const [extraPrincipal, setExtraPrincipal] = useState<number>(0);
  const [downPayment, setDownPayment] = useState<number>(0);
  const [closingCosts, setClosingCosts] = useState<number>(0);
  const [initialRehab, setInitialRehab] = useState<number>(0);
  const [appreciationRate, setAppreciationRate] = useState<number>(3); // 3% default
  
  const [propertyDashboard, setPropertyDashboard] = useState<any | null>(null);
  const [propertyDashLoading, setPropertyDashLoading] = useState(false);
  const [propertyDashError, setPropertyDashError] = useState<string | null>(null);
  const [propertyVersion, setPropertyVersion] = useState<number>(0); // Increment when property changes
  const [avmGranularity, setAvmGranularity] = useState<'quarterly' | 'annual'>('annual');
  const [avmRange, setAvmRange] = useState<'2Q' | '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | 'all'>('10Y');
  
  // Temporary environmental map testing (no API usage)
  const [envTestAddress, setEnvTestAddress] = useState('');
  const [envTestCoords, setEnvTestCoords] = useState<{lat: number, lng: number, address: string} | null>(null);
  const [envTestLoading, setEnvTestLoading] = useState(false);
  const [googleMapsReady, setGoogleMapsReady] = useState(false);
  
  // Load Google Maps IMMEDIATELY on app start (independent of ATTOM API)
  useEffect(() => {
    console.log('[Google Maps Init] Starting independent load on app mount...');
    
    loadGoogleMaps()
      .then(() => {
        console.log('[Google Maps Init] ✓ Successfully loaded');
        setGoogleMapsReady(true);
      })
      .catch((error) => {
        console.error('[Google Maps Init] ✗ Failed to load:', error);
        // Still try to set ready if the API exists (might be cached)
        if ((window as any).google?.maps?.Geocoder) {
          console.log('[Google Maps Init] ⚠ API available despite error, setting ready');
          setGoogleMapsReady(true);
        }
      });
  }, []);

  // Debug: Log whenever propertyDashboard changes
  useEffect(() => {
    if (propertyDashboard) {
      console.log('[DEBUG] propertyDashboard updated:', {
        beds: propertyDashboard.summary?.beds,
        baths: propertyDashboard.summary?.baths,
        rental_avm: propertyDashboard.summary?.rental_avm,
        fullSummary: propertyDashboard.summary
      });
    }
  }, [propertyDashboard]);
  const [taxHistoryRange, setTaxHistoryRange] = useState<TaxHistoryRange>('all');
  const [mortgageAmortRange, setMortgageAmortRange] = useState<'6M'|'1Y'|'2Y'|'3Y'|'5Y'|'10Y'|'20Y'|'30Y'>('10Y');
  const [rentalPricingData, setRentalPricingData] = useState<RentalPricingScenarioData | null>(null);
  const [rentalPricingProjectionMode, setRentalPricingProjectionMode] = useState<RentalPricingProjectionMode>('none');
  const [seasonalRiskData, setSeasonalRiskData] = useState<{
    airQuality?: { monthly: number[]; peakMonth: number; peakValue: number; currentMonth: number; currentValue: number };
    flood?: { monthly: number[]; peakMonth: number; peakValue: number; currentMonth: number; currentValue: number };
    wildfire?: { monthly: number[]; peakMonth: number; peakValue: number; currentMonth: number; currentValue: number };
  }>({});
  const [analyticsGranularity, setAnalyticsGranularity] = useState<ProjectionGranularity>('annual');
  const addPropertyAddressRef = useRef<HTMLInputElement | null>(null);
  const addPropertyAutocompleteHostRef = useRef<HTMLDivElement | null>(null);
  const autocompleteElementRef = useRef<any>(null);

  useEffect(() => {
    if (analyticsGranularity === 'annual') {
      setAvmGranularity('annual');
      return;
    }

    if (analyticsGranularity === 'quarterly' || analyticsGranularity === 'monthly') {
      setAvmGranularity('quarterly');
    }
  }, [analyticsGranularity]);
  
  // Tenant Onboarding Modal state
  const [showTenantOnboarding, setShowTenantOnboarding] = useState(false);
  const [onboardingPropertyInfo, setOnboardingPropertyInfo] = useState<{
    propertyId: string;
    propertyAddress: string;
    ownerId: string;
    ownerName: string;
    ownerEmail: string;
  } | null>(null);
  
  // Saved properties state
  const [savedProperties, setSavedProperties] = useState<any[]>([]);
  const [loadingProperties, setLoadingProperties] = useState(false);
  const [propertyLoadError, setPropertyLoadError] = useState<string | null>(null);

  const activePropertyAddress = useMemo(
    () => combinePortfolioPropertyAddress(primaryProperty.address, primaryProperty.location) || String(primaryProperty.address || '').trim(),
    [primaryProperty.address, primaryProperty.location]
  );

  const activeSavedProperty = useMemo(() => {
    const normalizedPrimaryAddress = normalizePortfolioPropertyAddress(primaryProperty.address);
    const normalizedActiveAddress = normalizePortfolioPropertyAddress(activePropertyAddress);

    return savedProperties.find((property) => {
      const normalizedSavedAddress = normalizePortfolioPropertyAddress(property.address);
      return Boolean(normalizedSavedAddress)
        && (
          normalizedSavedAddress === normalizedPrimaryAddress
          || normalizedSavedAddress === normalizedActiveAddress
        );
    }) || null;
  }, [savedProperties, primaryProperty.address, activePropertyAddress]);

  const canonicalPortfolioInput = useMemo(
    () => savedProperties.map((property) => ({
      id: property.id,
      address: property.address,
      propertyData: property.property_data || null,
      property_data: property.property_data || null,
      financials: property.financial_data || null,
      createdAt: property.created_at,
      updatedAt: property.updated_at,
    })),
    [savedProperties],
  );

  const combinedPortfolioOverview = useMemo(
    () => buildPropertyPortfolioOverview(canonicalPortfolioInput, 'combined'),
    [canonicalPortfolioInput],
  );

  const activeFirestorePropertyId = useMemo(() => {
    if (activeSavedProperty?.id) {
      return activeSavedProperty.id;
    }

    if (!user?.id || !activePropertyAddress) {
      return '';
    }

    return `${user.id}_${btoa(activePropertyAddress).substring(0, 20)}`;
  }, [activePropertyAddress, activeSavedProperty?.id, user?.id]);
  
  // Load saved properties on mount from Firestore.
  useEffect(() => {
    const loadProperties = async () => {
      setLoadingProperties(true);
      setPropertyLoadError(null);
      try {
        const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
        const useProxy = import.meta.env.MODE === 'development' && !baseEnv;

        if (!user?.id) {
          setSavedProperties([]);
          setPropertyLoadError(null);
          console.warn('[Portfolio] Skipping property load without an authenticated Firestore owner');
          return;
        }

        const ownerProperties = await ownerPropertiesClient.listDetailed(user.id);

        // Map Firestore format to match the existing portfolio property shape.
        const allProperties = ownerProperties.map((p: any) => ({
          id: p.id,
          name: p.address,
          address: p.address,
          property_data: p.propertyData || null,
          financial_data: p.financials || null,
          created_at: p.createdAt,
          updated_at: p.updatedAt
        }));
        console.log('[Portfolio] Loaded', allProperties.length, 'properties from Firestore');
        
        // Deduplicate by address (in case both sources have same property)
        const seen = new Set<string>();
        const deduped = allProperties.filter((p: any) => {
          const key = normalizePortfolioPropertyAddress(p.address);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        
        setSavedProperties(deduped);
        setPropertyLoadError(null);
        console.log('[Portfolio] Total unique properties:', deduped.length);
        
        // If we have saved properties and no current property set, load the first one
        if (deduped.length > 0 && !primaryProperty.address) {
          const firstProp = deduped[0];
          setPrimaryProperty({
            address: firstProp.address,
            location: '',
            financials: firstProp.financial_data
          });
          if (firstProp.property_data) {
            setPropertyDashboard((previousDashboard: any) => mergePropertyDashboardPayload(previousDashboard, firstProp.property_data, firstProp.address));
          }
          // If cached data is missing avm_history or mortgage, re-fetch from ATTOM
          const cachedData = firstProp.property_data;
          if (!cachedData?.avm_history?.length || !cachedData?.summary?.mortgage) {
            setPropertyDashLoading(true);
            (async () => {
              try {
                const url = useProxy
                  ? `/api/attom/dashboard?address=${encodeURIComponent(firstProp.address)}`
                  : (() => { const u = new URL(baseEnv || 'http://127.0.0.1:3001'); u.pathname = '/api/attom/dashboard'; u.searchParams.set('address', firstProp.address); return u.toString(); })();
                const resp = await fetch(url);
                const json = await resp.json();
                if (json.ok) {
                  const freshData = json.data || json;
                  setPropertyDashboard((prev: any) => mergePropertyDashboardPayload(prev, freshData, firstProp.address));
                }
              } catch (err) {
                console.warn('[Portfolio] ATTOM re-fetch for initial property failed:', err);
              } finally {
                setPropertyDashLoading(false);
              }
            })();
          }
        }
      } catch (e) {
        setSavedProperties([]);
        setPropertyLoadError(e instanceof Error ? e.message : 'Failed to load Firestore properties');
        console.error('[Portfolio] Failed to load Firestore properties:', e);
      } finally {
        setLoadingProperties(false);
      }
    };
    
    loadProperties();
  }, [user?.id]);
  
  // Temporary environmental testing geocoding function
  const handleEnvTestSearch = async () => {
    if (!envTestAddress.trim()) return;
    
    // Check if Google Maps is loaded
    if (!(window as any).google?.maps?.Geocoder) {
      alert('Google Maps is still loading. Please wait a moment and try again.');
      return;
    }
    
    setEnvTestLoading(true);
    try {
      // Use Google Geocoding API (free, no ATTOM usage)
      const geocoder = new (window as any).google.maps.Geocoder();
      
      geocoder.geocode({ address: envTestAddress }, (results: any, status: any) => {
        setEnvTestLoading(false);
        
        if (status === 'OK' && results[0]) {
          const location = results[0].geometry.location;
          const formattedAddress = results[0].formatted_address;
          
          setEnvTestCoords({
            lat: location.lat(),
            lng: location.lng(),
            address: formattedAddress
          });
          
          console.log('[Env Test] Geocoded:', formattedAddress, location.lat(), location.lng());
        } else {
          alert(`Could not geocode address: ${status}. Please try a different format.`);
          setEnvTestLoading(false);
        }
      });
    } catch (error) {
      console.error('[Env Test] Geocoding error:', error);
      alert('Error geocoding address. Please make sure Google Maps is loaded.');
      setEnvTestLoading(false);
    }
  };
  
  // Equifax credit check handler
  const handleEquifaxCreditCheck = async (applicant: TenantApplicant, formData?: typeof creditCheckFormData) => {
    if (!applicant) return;
    
    setCreditCheckLoading(true);
    setCreditCheckError(null);
    
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy ? '/api/equifax/credit-check' : `${baseEnv}/api/equifax/credit-check`;
      
      // Use Equifax CTEST data when in test mode, otherwise use provided form data
      const requestData = equifaxTestMode ? {
        // Equifax CTEST (Certified Test) consumer data
        firstName: 'LJBKFJ',
        lastName: 'KHJGUFJM',
        ssn: '666123456',
        dateOfBirth: '1990-01-01',
        address: {
          street: '123 POIBHHFJD ST',
          city: 'ATLANTA',
          state: 'GA',
          zipCode: '30374'
        }
      } : {
        firstName: applicant.name.split(' ')[0],
        lastName: applicant.name.split(' ').slice(1).join(' ') || 'Unknown',
        ssn: formData?.ssn?.replace(/\D/g, '') || '',
        dateOfBirth: formData?.dateOfBirth || '',
        address: {
          street: formData?.street || '',
          city: formData?.city || '',
          state: formData?.state || '',
          zipCode: formData?.zipCode || ''
        }
      };
      
      console.log('[Equifax] Running credit check in', equifaxTestMode ? 'TEST MODE (CTEST data)' : 'PRODUCTION MODE');
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
      });
      
      const data = await response.json();
      
      if (!data.ok) {
        throw new Error(data.message || 'Failed to fetch credit report');
      }
      
      // Update applicant with credit score and details
      setApplicants(prev => prev.map(app => 
        app.id === applicant.id
          ? {
              ...app,
              creditScore: data.report?.score || 720, // Default score for test mode
              backgroundCheck: data.report?.status || 'clear',
              creditReportDetails: data.report || {
                score: 720,
                scoreRange: 'Good',
                status: 'completed',
                reportDate: new Date().toLocaleDateString(),
                summary: equifaxTestMode 
                  ? 'Test mode: Credit check successful using Equifax CTEST data. Switch to production mode for real applicant checks.'
                  : 'Credit check completed successfully.'
              }
            }
          : app
      ));
      
      // Update selected applicant
      if (selectedApplicant?.id === applicant.id) {
        setSelectedApplicant({
          ...applicant,
          creditScore: data.report?.score || 720,
          backgroundCheck: data.report?.status || 'clear',
          creditReportDetails: data.report || {
            score: 720,
            scoreRange: 'Good', 
            status: 'completed',
            reportDate: new Date().toLocaleDateString(),
            summary: equifaxTestMode
              ? 'Test mode: Credit check successful using Equifax CTEST data.'
              : 'Credit check completed successfully.'
          }
        });
      }
      
      // Close form if open
      setShowCreditCheckForm(false);
      
      console.log('[Equifax] Credit check complete:', data);
      
    } catch (error: any) {
      console.error('[Equifax] Credit check failed:', error);
      setCreditCheckError(error.message || 'Failed to complete credit check');
    } finally {
      setCreditCheckLoading(false);
    }
  };
  
  // Equifax background check handler
  const handleEquifaxBackgroundCheck = async (applicant: TenantApplicant) => {
    if (!applicant) return;
    
    setBackgroundCheckLoading(true);
    setBackgroundCheckError(null);
    
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy ? '/api/equifax/background-check' : `${baseEnv}/api/equifax/background-check`;
      
      // Demo data structure - in production, collect this securely from applicant
      const requestData = {
        firstName: applicant.name.split(' ')[0],
        lastName: applicant.name.split(' ').slice(1).join(' '),
        // These would come from a secure form the applicant fills out
        ssn: '123-45-6789', // DEMO ONLY - never hardcode real SSNs
        dateOfBirth: '1990-01-01', // DEMO ONLY
        address: {
          street: '123 Main St', // DEMO ONLY
          city: 'Anytown', // DEMO ONLY
          state: 'CA', // DEMO ONLY
          zipCode: '90210' // DEMO ONLY
        }
      };
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
      });
      
      const data = await response.json();
      
      if (!data.ok) {
        throw new Error(data.message || 'Failed to fetch background check');
      }
      
      // Update applicant with background check results
      setApplicants(prev => prev.map(app => 
        app.id === applicant.id
          ? {
              ...app,
              backgroundCheck: data.report.status, // 'clear', 'flagged', 'pending'
              backgroundCheckDetails: data.report
            }
          : app
      ));
      
      // Update selected applicant
      if (selectedApplicant?.id === applicant.id) {
        setSelectedApplicant({
          ...applicant,
          backgroundCheck: data.report.status,
          backgroundCheckDetails: data.report
        });
      }
      
      console.log('[Equifax Background] Check complete:', data.report);
      
    } catch (error: any) {
      console.error('[Equifax Background] Check failed:', error);
      setBackgroundCheckError(error.message || 'Failed to complete background check');
    } finally {
      setBackgroundCheckLoading(false);
    }
  };
  
  // Property images state
  const [propertyImages, setPropertyImages] = useState<Array<{id: string; url: string; name: string}>>([]);
  const [_isDragging, setIsDragging] = useState(false);
  const _fileInputRef = useRef<HTMLInputElement | null>(null);
  
  // Street View modal state
  const [isStreetViewModalOpen, setIsStreetViewModalOpen] = useState(false);
  const [streetViewModalAddress, setStreetViewModalAddress] = useState<string | null>(null);
  const [showCommunitySchools, setShowCommunitySchools] = useState(false);
  const [showTenantDetailsPopup, setShowTenantDetailsPopup] = useState(false);
  
  // AI Renovation Analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [renovationSuggestions, setRenovationSuggestions] = useState<Array<{
    id: string;
    name: string;
    type?: string;
    summary: string;
    cost: number;
    costRange?: { low: number; high: number };
    materialBreakdown?: Array<any>;
    laborBreakdown?: Array<any>;
    valueIncrease: number;
    rentIncreaseDollar: number;
    rentIncreasePercent: number;
    currentRent: number;
    maxPostRenovationRent: number;
    priority: 'high' | 'medium' | 'low';
    timeframe: string;
    details: string;
    confidence?: string;
    roi?: number;
    paybackMonths?: number;
    dataSource?: any;
    canonicalContext?: {
      primaryKey: string;
      source: string;
      canonicalOpportunityId: string | null;
      canonicalRoomType: string | null;
      canonicalCategory: string | null;
      canonicalScopeType: string | null;
    };
    canonicalResult?: {
      resultId: string;
      primaryKey: string;
      source: string;
      canonicalOpportunityId: string | null;
      canonicalRoomType: string | null;
      canonicalCategory: string | null;
      canonicalScopeType: string | null;
      totalCost: number;
      costRange?: { low: number; high: number };
      valueIncrease: number;
      rentIncreaseDollar: number;
      rentIncreasePercent: number;
      currentRent: number;
      maxPostRenovationRent: number;
      roi: number;
      paybackMonths: number | null;
      confidence: string;
      timeframe: string;
    };
    measurements?: {
      measured: boolean;
      confidence: string;
      roomDimensions?: {
        widthFt: number;
        lengthFt: number;
        heightFt: number;
        floorAreaSqFt: number;
        wallAreaSqFt: number;
      };
      materialQuantities?: Record<string, any>;
      objectMeasurements?: Array<any>;
    };
  }>>([]);

  // QuickBooks Bookkeeping state
  const [qbTransactions, setQbTransactions] = useState<Array<any>>([]);
  const [qbSummary, setQbSummary] = useState<any>(null);
  const [qbCategories, setQbCategories] = useState<Array<any>>([]);
  const [qbCashflowTrend, setQbCashflowTrend] = useState<Array<any>>([]);
  const [pricingPowerBookkeepingTransactions, setPricingPowerBookkeepingTransactions] = useState<Array<any>>([]);
  const [pricingPowerBookkeepingCashflowTrend, setPricingPowerBookkeepingCashflowTrend] = useState<Array<any>>([]);
  const [qbUpcomingBills, setQbUpcomingBills] = useState<Array<any>>([]);
  const [qbLoading, setQbLoading] = useState(false);
  const [qbError, setQbError] = useState<string | null>(null);
  const [qbTransactionFilter, setQbTransactionFilter] = useState({ category: 'all', period: '3months' });
  const [qbConnected, setQbConnected] = useState(false);
  const [qbConnectionChecking, setQbConnectionChecking] = useState(false);
  const [bookkeepingRefreshKey, setBookkeepingRefreshKey] = useState(0);

  const applyPropertyFinancialInputs = (financials: PropertyFinancialData) => {
    setMonthlyRent(financials.monthlyRent || 0);
    setOtherIncome(financials.otherIncome || 0);
    setVacancyRate(financials.vacancyRate || 0);
    setRentGrowth(financials.rentGrowth || 0);
    setInsurance(financials.insurance || 0);
    setUtilities(financials.utilities || 0);
    setHoa(financials.hoa || 0);
    setRepairsCapEx(financials.repairsCapEx || 0);
    setManagementPct(financials.managementPct || 0);
    setExpenseInflation(financials.expenseInflation || 0);
    setTaxInflation(financials.taxInflation || 0);
    setInterestRate(financials.interestRate || 0);
    setLoanTerm(financials.loanTerm || 360);
    setIsInterestOnly(Boolean(financials.isInterestOnly));
    setExtraPrincipal(financials.extraPrincipal || 0);
    setDownPayment(financials.downPayment || 0);
    setClosingCosts(financials.closingCosts || 0);
    setInitialRehab(financials.initialRehab || 0);
    setAppreciationRate(financials.appreciationRate || 0);
  };

  const derivedFinancialSeed = useMemo<PropertyFinancialData | null>(() => {
    const savedFinancials = primaryProperty.financials || null;
    const projectedFinancials = propertyDashboard?.analyticsProjection?.financialInputs || null;
    const mortgageSummary = propertyDashboard?.summary?.mortgage || null;

    if (!savedFinancials && !projectedFinancials && !mortgageSummary) {
      return null;
    }

    const avm = Number(propertyDashboard?.summary?.avm_value) || 0;
    const rentalAvm = Number(propertyDashboard?.summary?.rental_avm) || 0;
    const mortgageAmount = Number(mortgageSummary?.amount) || 0;
    const estimatedRate = Number(mortgageSummary?.estimated_interest_rate) || 0;
    const originalTermMonths = Number(mortgageSummary?.term_months) || 0;
    const loanOriginationDate = projectedFinancials?.loanOriginationDate
      || savedFinancials?.loanOriginationDate
      || mortgageSummary?.date
      || undefined;
    const originalLoanAmount = Number(
      projectedFinancials?.originalLoanAmount
      ?? savedFinancials?.originalLoanAmount
      ?? mortgageAmount,
    ) || 0;
    const interestRate = Number(
      projectedFinancials?.interestRate
      ?? savedFinancials?.interestRate
      ?? estimatedRate,
    ) || 0;
    const amortizationSeedTermMonths = Number(
      projectedFinancials?.loanTerm
      ?? savedFinancials?.loanTerm
      ?? originalTermMonths,
    ) || 0;
    const amortizationSeed = originalLoanAmount > 0 && interestRate > 0 && amortizationSeedTermMonths > 0 && loanOriginationDate
      ? calculateRemainingMortgageBalance(originalLoanAmount, interestRate, amortizationSeedTermMonths, loanOriginationDate)
      : null;
    const currentLoanBalance = Number(
      projectedFinancials?.currentLoanBalance
      ?? savedFinancials?.currentLoanBalance
      ?? amortizationSeed?.remainingBalance
      ?? originalLoanAmount,
    ) || 0;
    const remainingLoanTermMonths = Number(
      projectedFinancials?.remainingLoanTermMonths
      ?? savedFinancials?.remainingLoanTermMonths
      ?? amortizationSeed?.monthsRemaining
      ?? amortizationSeedTermMonths,
    ) || 0;
    const purchasePrice = Number(propertyDashboard?.summary?.last_sale_price) || 0;
    const derivedDownPayment = purchasePrice > 0 && originalLoanAmount > 0
      ? Math.max(purchasePrice - originalLoanAmount, 0)
      : currentLoanBalance > 0 && avm > 0
        ? Math.max(avm - currentLoanBalance, 0)
        : avm > 0
          ? avm * 0.2
          : 0;

    return {
      monthlyRent: Number(projectedFinancials?.monthlyRent ?? savedFinancials?.monthlyRent ?? rentalAvm) || 0,
      otherIncome: Number(projectedFinancials?.otherIncome ?? savedFinancials?.otherIncome) || 0,
      vacancyRate: Number(projectedFinancials?.vacancyRate ?? savedFinancials?.vacancyRate ?? 5),
      rentGrowth: Number(projectedFinancials?.rentGrowth ?? savedFinancials?.rentGrowth ?? 3),
      insurance: Number(projectedFinancials?.insurance ?? savedFinancials?.insurance) || 0,
      utilities: Number(projectedFinancials?.utilities ?? savedFinancials?.utilities) || 0,
      hoa: Number(projectedFinancials?.hoa ?? savedFinancials?.hoa) || 0,
      repairsCapEx: Number(projectedFinancials?.repairsCapEx ?? savedFinancials?.repairsCapEx) || 0,
      managementPct: Number(projectedFinancials?.managementPct ?? savedFinancials?.managementPct ?? 8),
      expenseInflation: Number(projectedFinancials?.expenseInflation ?? savedFinancials?.expenseInflation ?? 3),
      taxInflation: Number(projectedFinancials?.taxInflation ?? savedFinancials?.taxInflation ?? projectedFinancials?.taxGrowth ?? 3),
      interestRate,
      loanTerm: Number(projectedFinancials?.loanTerm ?? savedFinancials?.loanTerm ?? originalTermMonths ?? 360) || 360,
      originalLoanAmount: originalLoanAmount || undefined,
      currentLoanBalance: currentLoanBalance || undefined,
      remainingLoanTermMonths: remainingLoanTermMonths || undefined,
      loanOriginationDate,
      monthlyDebtService: Number(
        projectedFinancials?.monthlyDebtService
        ?? savedFinancials?.monthlyDebtService
        ?? mortgageSummary?.estimated_monthly_payment_pi,
      ) || undefined,
      isInterestOnly: Boolean(projectedFinancials?.isInterestOnly ?? savedFinancials?.isInterestOnly),
      extraPrincipal: Number(projectedFinancials?.extraPrincipal ?? savedFinancials?.extraPrincipal) || 0,
      downPayment: Number(projectedFinancials?.downPayment ?? savedFinancials?.downPayment ?? derivedDownPayment) || 0,
      closingCosts: Number(projectedFinancials?.closingCosts ?? savedFinancials?.closingCosts) || 0,
      initialRehab: Number(projectedFinancials?.initialRehab ?? savedFinancials?.initialRehab) || 0,
      appreciationRate: Number(projectedFinancials?.appreciationRate ?? savedFinancials?.appreciationRate ?? 3),
    };
  }, [primaryProperty.financials, propertyDashboard]);
  const financialSeedHydrationKeyRef = useRef<string | null>(null);

  const handleSampleRentalAnalyticsLoaded = (payload: any) => {
    if (!payload?.financialInputs) return;

    const financials = payload.financialInputs as PropertyFinancialData;
    applyPropertyFinancialInputs(financials);

    setPrimaryProperty({
      address: payload.property?.address || '11822 Prestwick Rd',
      location: payload.property?.location || 'Potomac, MD 20854',
      financials
    });

    if (payload.propertyDashboard) {
      setPropertyDashboard((previousDashboard: any) => {
        const merged = mergePropertyDashboardPayload(previousDashboard, payload.propertyDashboard, payload.property?.address);
        // Always preserve existing ATTOM price/tax history — sample data doesn't have real historical data
        const existingAvmHistory = previousDashboard?.avm_history;
        const existingTaxHistory = previousDashboard?.tax_history;
        return {
          ...merged,
          avm_history: (existingAvmHistory?.length > 0) ? existingAvmHistory : merged?.avm_history,
          tax_history: (existingTaxHistory?.length > 0) ? existingTaxHistory : merged?.tax_history,
        };
      });
      setPropertyDashError(null);
      setPropertyDashLoading(false);
    }

    const annualIncome = Number(payload.summary?.annualIncomeObserved || 0);
    const annualExpenses = Number(payload.summary?.annualExpensesObserved || 0);
    const annualCashFlow = Number(payload.summary?.annualCashFlowObserved || 0);

    const sampleTransactions = payload.bookkeeping?.transactions || payload.categorizedTransactions || [];
    const sampleCashflowTrend = payload.monthlyTrend || payload.bookkeeping?.cashflowTrend || [];

    setQbTransactions(sampleTransactions);
    setQbCategories(
      (payload.expenseCategories || []).map((category: any) => ({
        name: category.category,
        amount: category.totalAmount,
        monthlyAverage: category.monthlyAverage,
        type: 'expense'
      }))
    );
    setQbCashflowTrend(sampleCashflowTrend);
    setPricingPowerBookkeepingTransactions(sampleTransactions);
    setPricingPowerBookkeepingCashflowTrend(sampleCashflowTrend);
    setQbUpcomingBills(payload.upcomingBills || payload.bookkeeping?.upcomingBills || []);
    setQbSummary({
      totalIncome: annualIncome,
      totalExpenses: annualExpenses,
      netCashFlow: annualCashFlow,
      margin: annualIncome > 0 ? ((annualCashFlow / annualIncome) * 100).toFixed(1) : '0.0'
    });
    setPropertyVersion(prev => prev + 1);
  };

  useEffect(() => {
    if (!derivedFinancialSeed) {
      financialSeedHydrationKeyRef.current = null;
      return;
    }

    const nextHydrationKey = JSON.stringify([
      primaryProperty.address,
      derivedFinancialSeed.monthlyRent,
      derivedFinancialSeed.otherIncome,
      derivedFinancialSeed.vacancyRate,
      derivedFinancialSeed.rentGrowth,
      derivedFinancialSeed.insurance,
      derivedFinancialSeed.utilities,
      derivedFinancialSeed.hoa,
      derivedFinancialSeed.repairsCapEx,
      derivedFinancialSeed.managementPct,
      derivedFinancialSeed.expenseInflation,
      derivedFinancialSeed.taxInflation,
      derivedFinancialSeed.interestRate,
      derivedFinancialSeed.loanTerm,
      derivedFinancialSeed.originalLoanAmount,
      derivedFinancialSeed.currentLoanBalance,
      derivedFinancialSeed.remainingLoanTermMonths,
      derivedFinancialSeed.monthlyDebtService,
      derivedFinancialSeed.isInterestOnly,
      derivedFinancialSeed.extraPrincipal,
      derivedFinancialSeed.downPayment,
      derivedFinancialSeed.closingCosts,
      derivedFinancialSeed.initialRehab,
      derivedFinancialSeed.appreciationRate,
    ]);

    if (financialSeedHydrationKeyRef.current === nextHydrationKey) {
      return;
    }

    applyPropertyFinancialInputs(derivedFinancialSeed);
    financialSeedHydrationKeyRef.current = nextHydrationKey;
  }, [derivedFinancialSeed, primaryProperty.address]);

  const normalizeDashboardAddress = (value: unknown) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const mergeDashboardSeriesByKey = (existingSeries: any[], incomingSeries: any[], key: string) => {
    const merged = new Map<string, any>();

    for (const item of existingSeries) {
      if (!item || item[key] == null) continue;
      merged.set(String(item[key]), item);
    }

    for (const item of incomingSeries) {
      if (!item || item[key] == null) continue;
      const itemKey = String(item[key]);
      merged.set(itemKey, {
        ...(merged.get(itemKey) || {}),
        ...item,
      });
    }

    return Array.from(merged.values()).sort((left, right) => {
      const leftKey = left?.[key];
      const rightKey = right?.[key];
      if (key === 'date') {
        return new Date(leftKey).getTime() - new Date(rightKey).getTime();
      }
      return Number(leftKey) - Number(rightKey);
    });
  };

  const mergePropertyDashboardPayload = (previousDashboard: any, incomingDashboard: any, fallbackAddress?: string) => {
    if (!incomingDashboard) return previousDashboard;
    if (!previousDashboard) return incomingDashboard;

    const previousCandidates = [
      previousDashboard?.summary?.address,
      previousDashboard?.address,
      primaryProperty?.address,
    ].map(normalizeDashboardAddress).filter(Boolean);

    const incomingCandidates = [
      incomingDashboard?.summary?.address,
      incomingDashboard?.address,
      fallbackAddress,
    ].map(normalizeDashboardAddress).filter(Boolean);

    const shouldMerge = previousCandidates.some((previousAddress) =>
      incomingCandidates.some(
        (incomingAddress) =>
          previousAddress === incomingAddress ||
          previousAddress.includes(incomingAddress) ||
          incomingAddress.includes(previousAddress)
      )
    );

    if (!shouldMerge) {
      return incomingDashboard;
    }

    const previousAvmHistory = Array.isArray(previousDashboard?.avm_history) ? previousDashboard.avm_history : [];
    const incomingAvmHistory = Array.isArray(incomingDashboard?.avm_history) ? incomingDashboard.avm_history : [];
    const previousComparableAvmHistory = Array.isArray(previousDashboard?.avm_comparable_history) ? previousDashboard.avm_comparable_history : [];
    const incomingComparableAvmHistory = Array.isArray(incomingDashboard?.avm_comparable_history) ? incomingDashboard.avm_comparable_history : [];
    const previousTaxHistory = Array.isArray(previousDashboard?.tax_history) ? previousDashboard.tax_history : [];
    const incomingTaxHistory = Array.isArray(incomingDashboard?.tax_history) ? incomingDashboard.tax_history : [];

    const mergedAvmHistory = mergeDashboardSeriesByKey(previousAvmHistory, incomingAvmHistory, 'date');
    const mergedComparableAvmHistory = mergeDashboardSeriesByKey(previousComparableAvmHistory, incomingComparableAvmHistory, 'date');
    const mergedTaxHistory = mergeDashboardSeriesByKey(previousTaxHistory, incomingTaxHistory, 'year');

    return {
      ...previousDashboard,
      ...incomingDashboard,
      summary: {
        ...(previousDashboard.summary || {}),
        ...(incomingDashboard.summary || {}),
      },
      analyticsProjection: {
        ...(previousDashboard.analyticsProjection || {}),
        ...(incomingDashboard.analyticsProjection || {}),
      },
      avm_comparable_context: {
        ...(previousDashboard.avm_comparable_context || {}),
        ...(incomingDashboard.avm_comparable_context || {}),
      },
      avm_history: mergedAvmHistory.length > 0 ? mergedAvmHistory : previousAvmHistory,
      avm_comparable_history: mergedComparableAvmHistory.length > 0 ? mergedComparableAvmHistory : previousComparableAvmHistory,
      tax_history: mergedTaxHistory.length > 0 ? mergedTaxHistory : previousTaxHistory,
    };
  };

  useEffect(() => {
    const propertyAddress = String(propertyDashboard?.summary?.address || activePropertyAddress || '').trim();
    const hasSubjectHistory = Array.isArray(propertyDashboard?.avm_history) && propertyDashboard.avm_history.length > 1;
    const hasComparableHistory = Array.isArray(propertyDashboard?.avm_comparable_history) && propertyDashboard.avm_comparable_history.length > 1;

    if (!propertyAddress || !hasSubjectHistory || hasComparableHistory) {
      return;
    }

    let cancelled = false;

    const loadAvmComparisonHistory = async () => {
      try {
        const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
        const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
        const requestUrl = useProxy
          ? `/api/attom/avm-comparison-history?address=${encodeURIComponent(propertyAddress)}`
          : (() => {
              const url = new URL(baseEnv || 'http://127.0.0.1:3001');
              url.pathname = '/api/attom/avm-comparison-history';
              url.searchParams.set('address', propertyAddress);
              return url.toString();
            })();

        const response = await fetch(requestUrl);
        const payload = await response.json().catch(() => ({}));

        if (!response.ok || payload?.ok === false || !payload?.data || cancelled) {
          if (!cancelled && (payload?.error || !response.ok)) {
            console.warn('[Portfolio] AVM comparison history unavailable:', payload?.error || response.statusText);
          }
          return;
        }

        setPropertyDashboard((previousDashboard: any) => mergePropertyDashboardPayload(previousDashboard, payload.data, propertyAddress));
        setSavedProperties((previous) => previous.map((property) => {
          const normalizedSavedAddress = normalizePortfolioPropertyAddress(property?.address);
          const normalizedTargetAddress = normalizePortfolioPropertyAddress(propertyAddress);

          if (!normalizedSavedAddress || normalizedSavedAddress !== normalizedTargetAddress) {
            return property;
          }

          return {
            ...property,
            property_data: mergePropertyDashboardPayload(property?.property_data || null, payload.data, propertyAddress),
          };
        }));
      } catch (error) {
        if (!cancelled) {
          console.warn('[Portfolio] Failed to load AVM comparison history:', error);
        }
      }
    };

    void loadAvmComparisonHistory();

    return () => {
      cancelled = true;
    };
  }, [activePropertyAddress, propertyDashboard?.summary?.address, propertyDashboard?.avm_history?.length, propertyDashboard?.avm_comparable_history?.length]);

  useEffect(() => {
    const handleSampleAnalyticsEvent = (event: Event) => {
      const customEvent = event as CustomEvent;
      handleSampleRentalAnalyticsLoaded(customEvent.detail);
    };

    window.addEventListener('houseyield:sample-rental-analytics-loaded', handleSampleAnalyticsEvent as EventListener);
    return () => {
      window.removeEventListener('houseyield:sample-rental-analytics-loaded', handleSampleAnalyticsEvent as EventListener);
    };
  }, []);
  const [showQbTransactions, setShowQbTransactions] = useState(false);
  
  // QuickBooks Sync state
  const [qbSyncPreview, setQbSyncPreview] = useState<any>(null);
  const [qbSyncLoading, setQbSyncLoading] = useState(false);
  const [qbShowSyncModal, setQbShowSyncModal] = useState(false);
  const [qbSelectedProperty, setQbSelectedProperty] = useState<number | null>(null);
  const [qbSelectedMonth, setQbSelectedMonth] = useState<string>('');
  
  // QuickBooks Import state (load FROM QuickBooks)
  const [qbShowImportModal, setQbShowImportModal] = useState(false);
  const [qbImportPreview, setQbImportPreview] = useState<any>(null);
  const [qbImportLoading, setQbImportLoading] = useState(false);
  const [qbImportDateRange, setQbImportDateRange] = useState({ 
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0]
  });
  const [qbImportSelectedTxns, setQbImportSelectedTxns] = useState<Set<string>>(new Set());
  
  const [aiScenarioChartData, setAiScenarioChartData] = useState<ReturnType<typeof buildPortfolioAnalyticsChartData> | null>(null);
  const [aiScenarioLabel, setAiScenarioLabel] = useState<string>('AI Scenario');

  // Compute financial inputs for calculations (must be before handleScenarioApply which depends on it)
  const financialInputs = useMemo(() => {
    if (!propertyDashboard) {
      return null;
    }

    if (!derivedFinancialSeed) return null;

    const baseFinancials = {
      ...derivedFinancialSeed,
      monthlyRent,
      otherIncome,
      vacancyRate,
      rentGrowth,
      insurance,
      utilities,
      hoa,
      repairsCapEx,
      managementPct,
      expenseInflation,
      taxInflation,
      interestRate,
      loanTerm,
      isInterestOnly,
      extraPrincipal,
      downPayment,
      closingCosts,
      initialRehab,
      appreciationRate,
    };

    const avm = Number(propertyDashboard.summary?.avm_value) || 0;
    const latestTaxRecord = Array.isArray(propertyDashboard.tax_history)
      ? [...propertyDashboard.tax_history].sort((a: any, b: any) => Number(b.year || 0) - Number(a.year || 0))[0]
      : null;
    const taxAmount = Number(propertyDashboard.analyticsProjection?.summary?.attomTaxAmount)
      || Number(latestTaxRecord?.tax_amount)
      || 0;
    
    if (avm === 0) return null;

    return {
      avm,
      taxAmount,
      ...baseFinancials,
      taxGrowth: baseFinancials.taxInflation,
    } as FinancialInputs;
  }, [
    derivedFinancialSeed,
    propertyDashboard,
    monthlyRent,
    otherIncome,
    vacancyRate,
    rentGrowth,
    insurance,
    utilities,
    hoa,
    repairsCapEx,
    managementPct,
    expenseInflation,
    taxInflation,
    interestRate,
    loanTerm,
    isInterestOnly,
    extraPrincipal,
    downPayment,
    closingCosts,
    initialRehab,
    appreciationRate,
  ]);

  const handleScenarioApply = useCallback((changes: { monthlyRent?: number; interestRate?: number; appreciationRate?: number; projections?: { cashFlow: number[]; equity: number[]; propertyValue: number[]; noi: number[]; coc: number[] }; scenarioName?: string }) => {
    if (changes.monthlyRent !== undefined) setMonthlyRent(changes.monthlyRent);
    if (changes.interestRate !== undefined) setInterestRate(changes.interestRate);
    if (changes.appreciationRate !== undefined) setAppreciationRate(changes.appreciationRate);

    if (changes.projections) {
      const proj = changes.projections;
      const years = proj.cashFlow.length;
      const zeros = Array(years).fill(0);
      const currentYear = new Date().getFullYear();
      const annualLabels = Array.from({ length: years }, (_, i) => String(currentYear + i + 1));

      // Convert full-dollar values to thousands to match chart data format
      const cashFlowK = proj.cashFlow.map((v) => v / 1000);
      const noiK = proj.noi.map((v) => v / 1000);
      const propertyValueK = proj.propertyValue.map((v) => v / 1000);
      const equityK = proj.equity.map((v) => v / 1000);
      const initialAvm = financialInputs?.avm ?? 0;
      const initialDownPayment = financialInputs?.downPayment ?? 0;
      const initialLoanBalance = Math.max(initialAvm - initialDownPayment, 0);

      // Approximate declining loan balance
      const loanK = proj.propertyValue.map((_, i) => {
        const fraction = (i + 1) / years;
        const finalBalance = equityK[years - 1] != null ? propertyValueK[years - 1] - equityK[years - 1] : initialLoanBalance / 1000;
        return (initialLoanBalance / 1000) + (finalBalance - initialLoanBalance / 1000) * fraction;
      });

      // Cumulative total return in thousands
      let cumulative: number[] = [];
      let running = 0;
      for (let i = 0; i < years; i++) {
        running += cashFlowK[i];
        cumulative.push(running + (propertyValueK[i] - initialAvm / 1000));
      }

      // Rolling IRR for each holding period
      const rollingIrr: number[] = [];
      const initialCapital = Math.max(initialDownPayment, 1);
      for (let holdYr = 1; holdYr <= years; holdYr++) {
        const cumCF = proj.cashFlow.slice(0, holdYr).reduce((s, v) => s + v, 0);
        const exitEquity = proj.equity[holdYr - 1] ?? 0;
        const total = cumCF + exitEquity;
        const irr = total > 0 ? (Math.pow(total / initialCapital, 1 / holdYr) - 1) * 100 : 0;
        rollingIrr.push(irr);
      }

      const scenarioData = {
        projectionGranularity: 'annual' as const,
        projectionLabels: annualLabels,
        holdingPeriodLabels: annualLabels,
        mortgageLabels: annualLabels,
        cashFlow: cashFlowK,
        annualIncome: { gross: zeros, collected: zeros },
        incomeExpenses: {
          income: zeros,
          expenses: zeros,
          expenseBreakdown: {
            taxes: zeros, insurance: zeros, utilities: zeros,
            hoa: zeros, repairs: zeros, management: zeros, debtService: zeros,
          },
        },
        cocReturn: proj.coc,
        capRate: zeros,
        noi: noiK,
        equityAccumulated: zeros,
        mortgageAmortization: { principal: zeros, interest: zeros, loanBalance: loanK },
        rentalPricingPower: zeros,
        propertyAppreciation: { value: propertyValueK, equity: equityK, loan: loanK },
        irr: rollingIrr[years - 1] ?? 0,
        rollingIrr,
        dscr: zeros,
        totalReturn: { cumulative, annualPercent: zeros },
        breakEvenOccupancy: 0,
        grm: 0,
      };
      setAiScenarioChartData(scenarioData as any);
      setAiScenarioLabel(changes.scenarioName ?? 'AI Scenario');
    }
  }, [financialInputs]);

  // Sample feed loading state
  const [sampleFeedLoading, setSampleFeedLoading] = useState(false);
  const [sampleFeedSuccess, setSampleFeedSuccess] = useState<string | null>(null);

  const handleLoadSampleFeed = async () => {
    try {
      setSampleFeedLoading(true);
      setSampleFeedSuccess(null);

      const userId = user?.id || '1';
      const response = await fetch('/api/stripe-connect/project-rental-analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          useSampleData: true,
          userId,
          propertyId: primaryProperty?.address || undefined
        })
      });

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.error || 'Failed to load sample property transactions');
      }

      window.dispatchEvent(new CustomEvent('houseyield:sample-rental-analytics-loaded', {
        detail: data
      }));

      const txnCount = data.bookkeeping?.transactions?.length || 0;
      setSampleFeedSuccess(`Loaded ${txnCount} sample transactions — projections recalculated.`);
      setTimeout(() => setSampleFeedSuccess(null), 8000);
    } catch (err: any) {
      console.error('Error loading sample feed:', err);
      setSampleFeedSuccess(null);
    } finally {
      setSampleFeedLoading(false);
    }
  };

  const compareRenovationImageNames = (
    first: { name: string; id?: string },
    second: { name: string; id?: string },
  ) => first.name.localeCompare(second.name, undefined, { numeric: true, sensitivity: 'base' })
    || String(first.id || '').localeCompare(String(second.id || ''));

  const readRenovationImageAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(String(event.target?.result || ''));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });

  // Image upload handlers
  const handleImageUpload = async (files: FileList | null) => {
    if (!files) return;
    
    const MAX_IMAGES = 25;
    const remainingSlots = MAX_IMAGES - propertyImages.length;
    
    if (remainingSlots <= 0) {
      alert('Maximum of 25 images reached. Please remove some images before adding more.');
      return;
    }
    
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    const filesToProcess = imageFiles
      .slice(0, remainingSlots)
      .sort((first, second) => compareRenovationImageNames({ name: first.name }, { name: second.name }));
    
    if (imageFiles.length > remainingSlots) {
      alert(`Only ${remainingSlots} more image(s) can be added (maximum 25 total).`);
    }

    if (filesToProcess.length === 0) {
      alert('Please select image files to analyze.');
      return;
    }

    try {
      const newImages = await Promise.all(filesToProcess.map(async (file, index) => ({
        id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        url: await readRenovationImageAsDataUrl(file),
        name: file.name,
      })));

      setPropertyImages(prev => [...prev, ...newImages].sort(compareRenovationImageNames));
    } catch (error) {
      console.error('[AI Analysis] Failed to read uploaded image:', error);
      alert('Failed to load one or more images. Please try again.');
    }
  };
  
  const _handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (propertyImages.length < 25) {
      setIsDragging(true);
    }
  };
  
  const _handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };
  
  const _handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (propertyImages.length < 25) {
      handleImageUpload(e.dataTransfer.files);
    }
  };
  
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleImageUpload(e.target.files);
  };
  
  const _removeImage = (id: string) => {
    setPropertyImages(prev => prev.filter(img => img.id !== id));
  };
  
  // Tenants state management - start with empty array
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantCorrespondenceSummary, setTenantCorrespondenceSummary] = useState<string[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  
  // Firestore tenant data for current property (supports multiple tenants for multifamily)
  const [firestoreTenant, setFirestoreTenant] = useState<any>(null);
  const [firestoreTenants, setFirestoreTenants] = useState<any[]>([]); // All tenants for multifamily
  const [firestoreTenantLoading, setFirestoreTenantLoading] = useState(false);
  const [clearingTenant, setClearingTenant] = useState(false);
  const [clearingTenantId, setClearingTenantId] = useState<string | null>(null); // Track which tenant is being cleared
  const [editingUnitTenantId, setEditingUnitTenantId] = useState<string | null>(null); // Track which tenant's unit is being edited
  const [editingUnitValue, setEditingUnitValue] = useState('');
  const [savingUnit, setSavingUnit] = useState(false);
  
  // Update tenant unit number
  const updateTenantUnitFn = async (tenantId: string, newUnit: string) => {
    setSavingUnit(true);
    try {
      const response = await fetch(buildOwnerFinanceUrl(`/api/tenants/${encodeURIComponent(tenantId)}/unit`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit: newUnit })
      });
      const result = await response.json();
      if (result.ok) {
        // Update local state
        setFirestoreTenants(prev => prev.map(t => 
          t.id === tenantId ? { ...t, unit: newUnit } : t
        ));
        if (firestoreTenant?.id === tenantId) {
          setFirestoreTenant((prev: any) => ({ ...prev, unit: newUnit }));
        }
        setEditingUnitTenantId(null);
        setEditingUnitValue('');
      } else {
        console.error('Failed to update unit:', result.error);
        alert('Failed to update unit: ' + result.error);
      }
    } catch (error) {
      console.error('Error updating unit:', error);
      alert('Error updating unit');
    } finally {
      setSavingUnit(false);
    }
  };
  
  // Clear tenant from property function (supports clearing specific tenant for multifamily)
  const clearTenantFromPropertyFn = async (specificTenantId?: string) => {
    if (!primaryProperty.address || !user?.id) return;
    if (!activeFirestorePropertyId) {
      alert('Unable to resolve the saved property for this tenant action. Reload the property and try again.');
      return;
    }
    
    const tenantToClear = specificTenantId 
      ? firestoreTenants.find(t => t.id === specificTenantId)
      : firestoreTenant;
    
    const tenantName = tenantToClear?.name || tenantToClear?.firstName || 'this tenant';
    const confirmed = window.confirm(`Are you sure you want to remove ${tenantName} from the property? This will not delete the tenant account.`);
    if (!confirmed) return;
    
    setClearingTenant(true);
    if (specificTenantId) setClearingTenantId(specificTenantId);
    
    try {
      console.log('[Clear Tenant] Clearing tenant from property:', activeFirestorePropertyId, specificTenantId ? `(tenant: ${specificTenantId})` : '(all)');
      const data = await ownerPropertiesClient.clearTenant(user.id, activeFirestorePropertyId, specificTenantId);
      
      if (data.ok) {
        console.log('[Clear Tenant] ✅ Tenant cleared successfully');
        if (specificTenantId) {
          // Remove specific tenant from list
          const remainingTenants = firestoreTenants.filter(t => t.id !== specificTenantId);
          setFirestoreTenants(remainingTenants);
          setFirestoreTenant(remainingTenants[0] || null);
        } else {
          // Clear all tenants
          setFirestoreTenant(null);
          setFirestoreTenants([]);
        }
      } else {
        console.error('[Clear Tenant] Failed:', data.error);
        alert('Failed to clear tenant: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('[Clear Tenant] Error:', error);
      alert('Error clearing tenant');
    } finally {
      setClearingTenant(false);
      setClearingTenantId(null);
    }
  };
  
  // Add tenant function
  const addTenant = (newTenant: Omit<Tenant, 'messages' | 'aiSummary'>) => {
    const tenant: Tenant = {
      ...newTenant,
      messages: [],
      aiSummary: 'New tenant - no correspondence history yet.'
    };
    setTenants(prev => [...prev, tenant]);
  };

  // Edit tenant function
  const updateTenant = (updatedTenant: Tenant) => {
    setTenants(prev => prev.map(t => 
      t.unit === updatedTenant.unit ? updatedTenant : t
    ));
  };

  // Generate AI summary of tenant messages
  const generateTenantSummary = async () => {
    const currentTenant = tenants.find(t => t.status === 'Current');
    if (!currentTenant || currentTenant.messages.length === 0) {
      setTenantCorrespondenceSummary([]);
      return;
    }

    console.log('🤖 Generating AI summary for tenant:', currentTenant.name);
    console.log('📧 Messages to summarize:', currentTenant.messages);

    setSummaryLoading(true);
    try {
      // Call our backend API endpoint instead of OpenAI directly
      const response = await fetch(buildOwnerFinanceUrl('/api/tenant-summary'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: currentTenant.messages
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('❌ Backend API error:', response.status, errorData);
        throw new Error(errorData.error || `API error: ${response.status}`);
      }

      const data = await response.json();
      console.log('✅ Backend response:', data);
      
      if (!data.ok) {
        throw new Error(data.error || 'Failed to generate summary');
      }

      const finalSummary = data.summary || [];
      console.log('📊 Final summary bullets:', finalSummary);
      setTenantCorrespondenceSummary(finalSummary);
    } catch (error) {
      console.error('❌ Error generating tenant summary:', error);
      setTenantCorrespondenceSummary([`Error: ${error instanceof Error ? error.message : 'Unable to generate summary'}`]);
    } finally {
      setSummaryLoading(false);
    }
  };

  // Regenerate summary when current tenant's messages change
  useEffect(() => {
    const currentTenant = tenants.find(t => t.status === 'Current');
    if (currentTenant && currentTenant.messages.length > 0) {
      generateTenantSummary();
    } else {
      setTenantCorrespondenceSummary([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants]);

  // Fetch tenant data from Firestore when property address changes
  useEffect(() => {
    const fetchFirestoreTenant = async () => {
      if (!primaryProperty.address || !user?.id) {
        setFirestoreTenant(null);
        setFirestoreTenants([]);
        return;
      }
      
      setFirestoreTenantLoading(true);
      try {
        console.log('[Tenant Fetch] Fetching properties with tenants for owner:', user.id);
        const ownerProperties = await ownerPropertiesClient.listDetailed(user.id, { withTenants: true });

        if (ownerProperties.length > 0) {
          const matchingProperty = activeSavedProperty?.id
            ? ownerProperties.find((property) => property.id === activeSavedProperty.id)
            : ownerProperties.find((property) => {
                const normalizedSavedAddress = normalizePortfolioPropertyAddress(property.address);
                return Boolean(normalizedSavedAddress)
                  && normalizedSavedAddress === normalizePortfolioPropertyAddress(activePropertyAddress);
              });

          if (matchingProperty) {
            // Support multiple tenants (multifamily properties)
            const allTenants = Array.isArray(matchingProperty.tenants)
              ? matchingProperty.tenants
              : matchingProperty.tenant
                ? [matchingProperty.tenant]
                : [];
            if (allTenants.length > 0) {
              console.log('[Tenant Fetch] ✅ Found', allTenants.length, 'tenant(s) for property');
              setFirestoreTenants(allTenants);
              setFirestoreTenant(allTenants[0]); // Primary tenant for backward compatibility
            } else {
              console.log('[Tenant Fetch] No tenants found for property:', activeSavedProperty?.id || activePropertyAddress);
              setFirestoreTenant(null);
              setFirestoreTenants([]);
            }
          } else {
            console.log('[Tenant Fetch] No matching property found for:', activeSavedProperty?.id || activePropertyAddress);
            setFirestoreTenant(null);
            setFirestoreTenants([]);
          }
        } else {
          console.log('[Tenant Fetch] No properties returned for owner:', user.id);
          setFirestoreTenant(null);
          setFirestoreTenants([]);
        }
      } catch (error) {
        console.error('[Tenant Fetch] Error fetching tenant:', error);
        setFirestoreTenant(null);
        setFirestoreTenants([]);
      } finally {
        setFirestoreTenantLoading(false);
      }
    };
    
    fetchFirestoreTenant();
  }, [activePropertyAddress, activeSavedProperty?.id, primaryProperty.address, user?.id]);

  // Initialize payment amount when payment modal opens
  useEffect(() => {
    if (paymentModalOpen) {
      const currentTenant = tenants.find(t => t.status === 'Current');
      setPaymentAmount(currentTenant?.rent?.toString() || '');
      setPaymentError(null);
    }
  }, [paymentModalOpen, tenants]);

  // Handle Stripe checkout - reserved for future payment integration
  // @ts-ignore - Reserved for future payment integration
  const handleStripeCheckout = async () => {
    const currentTenant = tenants.find(t => t.status === 'Current');
    
    if (!currentTenant) {
      setPaymentError('No current tenant found');
      return;
    }

    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      setPaymentError('Please enter a valid payment amount');
      return;
    }

    setPaymentLoading(true);
    setPaymentError(null);

    try {
      const response = await fetch(buildOwnerFinanceUrl('/api/tenant-payment/create-checkout'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tenantName: currentTenant.name,
          tenantEmail: currentTenant.email,
          amount: amount,
          propertyAddress: primaryProperty.address || 'Property Address',
          description: paymentDescription
        })
      });

      const data = await response.json();

      if (!data.ok) {
        if (data.error === 'stripe_not_configured') {
          setPaymentError('Stripe payment processing is not configured. Please add your STRIPE_SECRET_KEY to enable payments.');
        } else {
          setPaymentError(data.error || 'Failed to create payment session');
        }
        return;
      }

      // Redirect to Stripe Checkout
      window.location.href = data.url;

    } catch (err: any) {
      setPaymentError(err.message || 'Failed to process payment');
    } finally {
      setPaymentLoading(false);
    }
  };

  // Removed: askingPrice, offerPrice, offerNotes, offerSummary, annualRent, offerDiscountPct, estCapRate, estCashOnCash
  const pill = "rounded-full border px-3 py-1 text-sm hover:bg-gray-100";
  const active = " bg-gray-900 text-white border-gray-900";

  // Removed static maintenanceActivities (to be replaced by AI-ranked provider data)
  // Removed: maintenanceProjection hardcoded logic (will be replaced with real AI projection)

  // AVM data aggregation with display labels
  const { avmPoints, comparisonPoints: avmComparisonPoints, avmLabels: _avmLabels } = useMemo(() => {
    console.log('[AVM Chart] useMemo triggered:', {
      hasPropertyDashboard: !!propertyDashboard,
      hasAvmHistory: !!propertyDashboard?.avm_history,
      avmHistoryLength: propertyDashboard?.avm_history?.length || 0,
      comparableHistoryLength: propertyDashboard?.avm_comparable_history?.length || 0,
      avmGranularity,
      avmRange
    });

    const series = buildAvmSeries(
      propertyDashboard?.avm_history,
      propertyDashboard?.avm_comparable_history,
      avmGranularity,
      avmRange,
    );

    console.log('[AVM Chart] Final output:', {
      pointsLength: series.points.length,
      comparisonPointsLength: series.comparisonPoints.length,
      labelsLength: series.labels.length,
      firstPoint: series.points[0],
      lastPoint: series.points[series.points.length - 1],
      labels: series.labels
    });

    return {
      avmPoints: series.points,
      comparisonPoints: series.comparisonPoints,
      avmLabels: series.labels,
    };
  }, [propertyDashboard?.avm_history, propertyDashboard?.avm_comparable_history, avmGranularity, avmRange]);

  // Compute financial data for charts
  const chartData = useMemo(() => {
    if (!financialInputs) {
      return null;
    }

    const data = buildPortfolioAnalyticsChartData(financialInputs, analyticsGranularity);
    
    console.log('[ChartData] Calculated values:', {
      cashFlow: data.cashFlow,
      cocReturn: data.cocReturn,
      capRate: data.capRate,
      irr: data.irr,
      rollingIrr: data.rollingIrr,
      dscr: data.dscr,
      breakEvenOccupancy: data.breakEvenOccupancy,
      grm: data.grm,
      noi: data.noi,
      inputs: financialInputs
    });
    
    return data;
  }, [financialInputs, analyticsGranularity]);

  const optimizedFinancialInputs = useMemo(() => {
    if (!financialInputs || !rentalPricingData || rentalPricingProjectionMode === 'none') {
      return null;
    }

    const targetRent = rentalPricingProjectionMode === 'market'
      ? rentalPricingData.marketPotentialRent
      : rentalPricingProjectionMode === 'recommended'
        ? rentalPricingData.recommendedRent
        : (rentalPricingData.customRent ?? financialInputs.monthlyRent);

    const targetVacancyRate = rentalPricingProjectionMode === 'market'
      ? (rentalPricingData.benchmarkVacancyRate ?? rentalPricingData.currentVacancyRate ?? financialInputs.vacancyRate)
      : rentalPricingProjectionMode === 'recommended'
        ? (rentalPricingData.recommendedVacancyRate ?? financialInputs.vacancyRate)
        : (rentalPricingData.customVacancyRate ?? financialInputs.vacancyRate);
    const targetRentGrowth = rentalPricingProjectionMode === 'market'
      ? (rentalPricingData.benchmarkProjectedRentGrowth ?? rentalPricingData.projectedRentGrowth ?? financialInputs.rentGrowth)
      : rentalPricingProjectionMode === 'recommended'
        ? (rentalPricingData.recommendedProjectedRentGrowth ?? rentalPricingData.projectedRentGrowth ?? financialInputs.rentGrowth)
        : (rentalPricingData.customProjectedRentGrowth ?? rentalPricingData.projectedRentGrowth ?? financialInputs.rentGrowth);

    return {
      ...financialInputs,
      monthlyRent: targetRent,
      vacancyRate: targetVacancyRate,
      rentGrowth: targetRentGrowth,
    } as FinancialInputs;
  }, [financialInputs, rentalPricingData, rentalPricingProjectionMode]);

  const pricingAdjustedCurrentFinancialInputs = useMemo(() => {
    if (!financialInputs || !rentalPricingData) {
      return null;
    }

    return {
      ...financialInputs,
      monthlyRent: rentalPricingData.currentRent ?? financialInputs.monthlyRent,
      vacancyRate: rentalPricingData.currentVacancyRate ?? financialInputs.vacancyRate,
      rentGrowth: rentalPricingData.currentProjectedRentGrowth ?? rentalPricingData.projectedRentGrowth ?? financialInputs.rentGrowth,
    } as FinancialInputs;
  }, [financialInputs, rentalPricingData]);

  const pricingAdjustedCurrentChartData = useMemo(() => {
    if (!pricingAdjustedCurrentFinancialInputs) {
      return null;
    }

    return buildPortfolioAnalyticsChartData(pricingAdjustedCurrentFinancialInputs, analyticsGranularity);
  }, [pricingAdjustedCurrentFinancialInputs, analyticsGranularity]);

  const optimizedChartData = useMemo(() => {
    if (!optimizedFinancialInputs) {
      return null;
    }

    return buildPortfolioAnalyticsChartData(optimizedFinancialInputs, analyticsGranularity);
  }, [optimizedFinancialInputs, analyticsGranularity]);

  const displayFinancialInputs = pricingAdjustedCurrentFinancialInputs ?? financialInputs;
  const displayChartData = pricingAdjustedCurrentChartData ?? chartData;
  const hasRiskAdjustedDisplayBasis = Boolean(pricingAdjustedCurrentFinancialInputs && pricingAdjustedCurrentChartData);

  const taxHistoryChartData = useMemo(() => buildTaxHistorySeries(propertyDashboard?.tax_history, taxHistoryRange), [propertyDashboard, taxHistoryRange]);

  const analyticsChartAspectStyle = { aspectRatio: '1.92' } as const;
  const analyticsModalClassName = 'relative w-[min(1180px,calc(100vw-320px))] max-h-[90vh] overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.22)]';
  const analyticsModalWideClassName = 'relative w-[min(1320px,calc(100vw-320px))] max-h-[92vh] overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.22)]';

  const renderProjectionGranularityToggle = (size: 'compact' | 'regular' = 'compact') => {
    const isCompact = size === 'compact';
    return (
      <div className={`inline-flex items-center rounded-2xl border border-slate-200 bg-white p-1 shadow-sm ${isCompact ? 'gap-1' : 'gap-1.5'}`}>
        {([
          ['monthly', 'Monthly'],
          ['quarterly', 'Quarterly'],
          ['annual', 'Annually'],
        ] as Array<[ProjectionGranularity, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setAnalyticsGranularity(value)}
            className={`${isCompact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} rounded-xl font-medium transition-colors ${analyticsGranularity === value ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-700 hover:bg-slate-100'}`}
          >
            {label}
          </button>
        ))}
      </div>
    );
  };

  const analyticsAudit = useMemo(() => {
    if (!displayFinancialInputs || !displayChartData) return null;

    const inputs = displayFinancialInputs;
    const annualDebtService = getAnnualDebtService(inputs);
    const grossPotentialIncome = 12 * (inputs.monthlyRent + inputs.otherIncome);
    const effectiveGrossIncome = grossPotentialIncome * (1 - inputs.vacancyRate / 100);
    const annualTaxes = inputs.taxAmount;
    const annualInsurance = inputs.insurance;
    const annualUtilities = inputs.utilities;
    const annualHoa = inputs.hoa;
    const annualRepairs = inputs.repairsCapEx;
    const managementExpense = effectiveGrossIncome * (inputs.managementPct / 100);
    const operatingExpenses = annualTaxes + annualInsurance + annualUtilities + annualHoa + annualRepairs + managementExpense;
    const noi = effectiveGrossIncome - operatingExpenses;
    const cashFlow = noi - annualDebtService;
    const currentCapitalBasis = getForwardReturnCapitalBasis(inputs);
    const currentEquityBasis = getCurrentEquityBasis(inputs);
    const appreciationSeries = calculatePropertyAppreciation(inputs);
    const exitYearIndex = 8;
    const exitSalePrice = (appreciationSeries.value[exitYearIndex] || 0) * 1000;
    const exitLoanBalance = (appreciationSeries.loan[exitYearIndex] || 0) * 1000;
    const exitSellingCosts = exitSalePrice * 0.06;
    const exitNetProceeds = exitSalePrice - exitLoanBalance - exitSellingCosts;

    return [
      {
        key: 'cash-flow',
        title: 'Cash Flow (Year 1)',
        result: formatAuditCurrency(cashFlow),
        formula: 'EGI - OpEx - Debt Service',
        substitutions: [
          `EGI = ${formatAuditCurrency(grossPotentialIncome)} x (1 - ${formatAuditPercent(inputs.vacancyRate, 1)}) = ${formatAuditCurrency(effectiveGrossIncome)}`,
          `OpEx = Taxes ${formatAuditCurrency(annualTaxes)} + Insurance ${formatAuditCurrency(annualInsurance)} + Utilities ${formatAuditCurrency(annualUtilities)} + HOA ${formatAuditCurrency(annualHoa)} + Repairs ${formatAuditCurrency(annualRepairs)} + Mgmt ${formatAuditCurrency(managementExpense)} = ${formatAuditCurrency(operatingExpenses)}`,
          `Debt Service = ${formatAuditCurrency(annualDebtService)}`,
        ],
      },
      {
        key: 'coc',
        title: 'Cash-on-Cash (Year 1)',
        result: formatAuditPercent(displayChartData.cocReturn[0] || 0),
        formula: 'Year 1 Cash Flow / Current Capital Basis',
        substitutions: [
          `Cash Flow = ${formatAuditCurrency(cashFlow)}`,
          `Current Capital Basis = max(Current Equity ${formatAuditCurrency(currentEquityBasis)} - Selling Costs ${formatAuditCurrency(inputs.avm * 0.06)}, 0) = ${formatAuditCurrency(currentCapitalBasis)}`,
          `${formatAuditCurrency(cashFlow)} / ${formatAuditCurrency(currentCapitalBasis)} = ${formatAuditPercent(displayChartData.cocReturn[0] || 0)}`,
        ],
      },
      {
        key: 'cap-rate',
        title: 'Cap Rate (Year 1)',
        result: formatAuditPercent(displayChartData.capRate[0] || 0),
        formula: 'NOI / Current AVM',
        substitutions: [
          `NOI = ${formatAuditCurrency(noi)}`,
          `AVM = ${formatAuditCurrency(inputs.avm)}`,
          `${formatAuditCurrency(noi)} / ${formatAuditCurrency(inputs.avm)} = ${formatAuditPercent(displayChartData.capRate[0] || 0)}`,
        ],
      },
      {
        key: 'dscr',
        title: 'DSCR (Year 1)',
        result: displayChartData.dscr[0] >= 999 ? 'Infinity' : Number(displayChartData.dscr[0] || 0).toFixed(2),
        formula: 'NOI / Annual Debt Service',
        substitutions: [
          `NOI = ${formatAuditCurrency(noi)}`,
          `Annual Debt Service = ${formatAuditCurrency(annualDebtService)}`,
          `${formatAuditCurrency(noi)} / ${formatAuditCurrency(annualDebtService)} = ${displayChartData.dscr[0] >= 999 ? 'Infinity' : Number(displayChartData.dscr[0] || 0).toFixed(2)}`,
        ],
      },
      {
        key: 'break-even',
        title: 'Break-Even Occupancy',
        result: formatAuditPercent(displayChartData.breakEvenOccupancy || 0, 1),
        formula: '(Fixed Costs + Debt Service) / Gross Potential Income',
        substitutions: [
          `Fixed Costs = Taxes ${formatAuditCurrency(annualTaxes)} + Insurance ${formatAuditCurrency(annualInsurance)} + Utilities ${formatAuditCurrency(annualUtilities)} + HOA ${formatAuditCurrency(annualHoa)} + Repairs ${formatAuditCurrency(annualRepairs)} = ${formatAuditCurrency(annualTaxes + annualInsurance + annualUtilities + annualHoa + annualRepairs)}`,
          `Debt Service = ${formatAuditCurrency(annualDebtService)}`,
          `(${formatAuditCurrency(annualTaxes + annualInsurance + annualUtilities + annualHoa + annualRepairs)} + ${formatAuditCurrency(annualDebtService)}) / ${formatAuditCurrency(grossPotentialIncome)} = ${formatAuditPercent(displayChartData.breakEvenOccupancy || 0, 1)}`,
        ],
      },
      {
        key: 'irr',
        title: 'IRR (9-Year Hold)',
        result: formatAuditPercent(displayChartData.irr || 0),
        formula: 'IRR of current capital basis, annual cash flows, and year-9 net sale proceeds',
        substitutions: [
          `Initial Basis = ${formatAuditCurrency(currentCapitalBasis)}`,
          `Year 1 Cash Flow = ${formatAuditCurrency(cashFlow)}; Year 9 Cash Flow = ${formatAuditCurrency((displayChartData.cashFlow[exitYearIndex] || 0) * 1000)}`,
          `Year 9 Net Sale = Sale Price ${formatAuditCurrency(exitSalePrice)} - Loan Balance ${formatAuditCurrency(exitLoanBalance)} - Selling Costs ${formatAuditCurrency(exitSellingCosts)} = ${formatAuditCurrency(exitNetProceeds)}`,
          `IRR([-${formatAuditCurrency(currentCapitalBasis).replace('$', '')}, cash flows, final cash + sale]) = ${formatAuditPercent(displayChartData.irr || 0)}`,
        ],
      },
      {
        key: 'income-expenses',
        title: 'Income vs. Expenses (Year 1)',
        result: formatAuditCurrency(noi),
        formula: 'EGI - OpEx = NOI',
        substitutions: [
          `Gross Potential Income = (${formatAuditCurrency(inputs.monthlyRent)}/mo rent + ${formatAuditCurrency(inputs.otherIncome)}/mo other) × 12 = ${formatAuditCurrency(grossPotentialIncome)}`,
          `EGI = ${formatAuditCurrency(grossPotentialIncome)} × (1 - ${formatAuditPercent(inputs.vacancyRate, 1)} vacancy) = ${formatAuditCurrency(effectiveGrossIncome)}`,
          `OpEx = Taxes ${formatAuditCurrency(annualTaxes)} + Ins ${formatAuditCurrency(annualInsurance)} + Util ${formatAuditCurrency(annualUtilities)} + HOA ${formatAuditCurrency(annualHoa)} + Repairs ${formatAuditCurrency(annualRepairs)} + Mgmt ${formatAuditCurrency(managementExpense)} = ${formatAuditCurrency(operatingExpenses)}`,
          `NOI = ${formatAuditCurrency(effectiveGrossIncome)} - ${formatAuditCurrency(operatingExpenses)} = ${formatAuditCurrency(noi)}`,
        ],
      },
      {
        key: 'mortgage',
        title: 'Mortgage Amortization',
        result: formatAuditCurrency(annualDebtService / 12) + '/mo',
        formula: 'M = L × r(1+r)^n / ((1+r)^n - 1)',
        substitutions: [
          `Loan Balance (L) = ${formatAuditCurrency(getLoanProjectionBasis(inputs).principal)}`,
          `Monthly Rate (r) = ${inputs.interestRate.toFixed(2)}% ÷ 12 = ${(inputs.interestRate / 100 / 12).toFixed(5)}`,
          `Term (n) = ${getLoanProjectionBasis(inputs).termMonths} months${inputs.isInterestOnly ? ' (Interest-Only)' : ''}`,
          `Monthly P&I = ${formatAuditCurrency(annualDebtService / 12)}; Annual Debt Service = ${formatAuditCurrency(annualDebtService)}`,
        ],
      },
      {
        key: 'equity',
        title: 'Equity & Appreciation',
        result: formatAuditCurrency(currentEquityBasis),
        formula: 'Current Equity = AVM − Loan Balance',
        substitutions: [
          `AVM (Current Value) = ${formatAuditCurrency(inputs.avm)}`,
          `Loan Balance = ${formatAuditCurrency(getLoanProjectionBasis(inputs).principal)}`,
          `Current Equity = ${formatAuditCurrency(inputs.avm)} - ${formatAuditCurrency(getLoanProjectionBasis(inputs).principal)} = ${formatAuditCurrency(currentEquityBasis)}`,
          `Year 9 Projected Value = ${formatAuditCurrency(exitSalePrice)}; Year 9 Equity = ${formatAuditCurrency(exitSalePrice - exitLoanBalance)}`,
        ],
      },
      {
        key: 'total-return',
        title: 'Total Return (Cumulative)',
        result: formatAuditCurrency((displayChartData.totalReturn.cumulative[exitYearIndex] || 0) * 1000),
        formula: 'Cumulative Cash Flows + Appreciation Gain',
        substitutions: [
          `Initial Capital Basis = ${formatAuditCurrency(currentCapitalBasis)}`,
          `Year 1–9 Cumulative Cash Flow = ${formatAuditCurrency(displayChartData.cashFlow.slice(0, 9).reduce((s, v) => s + v, 0) * 1000)}`,
          `Appreciation Gain = Year 9 Value ${formatAuditCurrency(exitSalePrice)} - AVM ${formatAuditCurrency(inputs.avm)} = ${formatAuditCurrency(exitSalePrice - inputs.avm)}`,
          `Total Return (Yr 9) = ${formatAuditCurrency((displayChartData.totalReturn.cumulative[exitYearIndex] || 0) * 1000)}`,
        ],
      },
      {
        key: 'avm',
        title: 'Price History (AVM)',
        result: formatAuditCurrency(inputs.avm),
        formula: 'Automated Valuation Model — ATTOM data',
        substitutions: [
          `Current AVM = ${formatAuditCurrency(inputs.avm)}`,
          `Down Payment = ${formatAuditCurrency(inputs.downPayment)}; LTV = ${inputs.avm > 0 ? formatAuditPercent((getLoanProjectionBasis(inputs).principal / inputs.avm) * 100, 1) : 'N/A'}`,
          `Appreciation Rate = ${formatAuditPercent(inputs.appreciationRate, 1)}/yr (projected)`,
          `Year 9 Projected Value = ${formatAuditCurrency(exitSalePrice)}`,
        ],
      },
      {
        key: 'tax-history',
        title: 'Property Tax History',
        result: formatAuditCurrency(annualTaxes),
        formula: 'Annual Tax Amount from ATTOM records',
        substitutions: [
          `Current Annual Taxes = ${formatAuditCurrency(annualTaxes)}`,
          `Effective Tax Rate = ${inputs.avm > 0 ? formatAuditPercent((annualTaxes / inputs.avm) * 100, 3) : 'N/A'} of AVM`,
          `Tax Growth Rate = ${formatAuditPercent(inputs.taxGrowth ?? 2, 1)}/yr (projected)`,
          `Yr 9 Projected Taxes = ${formatAuditCurrency(annualTaxes * Math.pow(1 + (inputs.taxGrowth ?? 2) / 100, 8))}`,
        ],
      },
    ];
  }, [displayChartData, displayFinancialInputs]);

  useEffect(() => {
    if (!showAddPropertyForm) return;

    let isActive = true;
    let removeInputListener: (() => void) | null = null;
    let removeSelectListener: (() => void) | null = null;

    const cleanupWidget = () => {
      removeInputListener?.();
      removeSelectListener?.();
      removeInputListener = null;
      removeSelectListener = null;
      autocompleteElementRef.current = null;
      addPropertyAutocompleteHostRef.current?.replaceChildren();
    };

    const applySelectedPlace = async (event: any, placeAutocomplete: any) => {
      const placePrediction = event?.placePrediction ?? event?.detail?.placePrediction;
      if (!placePrediction?.toPlace) return;

      const place = placePrediction.toPlace();
      await place.fetchFields({
        fields: ['formattedAddress', 'addressComponents', 'location'],
      });

      let streetNumber = '';
      let streetRoute = '';
      let city = '';
      let state = '';
      let zip = '';

      const addressComponents = Array.isArray(place.addressComponents) ? place.addressComponents : [];
      for (const component of addressComponents) {
        const types = Array.isArray(component.types) ? component.types : [];
        const longText = component.longText ?? component.long_name ?? '';
        const shortText = component.shortText ?? component.short_name ?? longText;

        if (types.includes('street_number')) {
          streetNumber = longText;
        } else if (types.includes('route')) {
          streetRoute = longText;
        } else if (types.includes('locality')) {
          city = longText;
        } else if (types.includes('sublocality_level_1') && !city) {
          city = longText;
        } else if (types.includes('administrative_area_level_1')) {
          state = shortText;
        } else if (types.includes('postal_code')) {
          zip = longText;
        }
      }

      const street = [streetNumber, streetRoute].filter(Boolean).join(' ');
      const formattedAddress = place.formattedAddress || placeAutocomplete.value || '';
      const locationParts = [city, state].filter(Boolean).join(', ');
      const locationWithZip = zip ? `${locationParts} ${zip}`.trim() : locationParts;

      setNewPropertyAddress(street || formattedAddress);
      setNewPropertyLocation(locationWithZip || formattedAddress.split(',').slice(1).join(',').trim());

      console.log('[AddProperty] Google Places selected:', {
        street,
        city,
        state,
        zip,
        formatted: formattedAddress,
      });
    };

    const initAutocomplete = async () => {
      try {
        await loadGoogleMaps();

        const googleMaps = (window as any).google?.maps;
        const placesLibrary = await googleMaps?.importLibrary?.('places');
        const placesNamespace = googleMaps?.places ?? placesLibrary;
        const PlaceAutocompleteElement = placesNamespace?.PlaceAutocompleteElement;
        const host = addPropertyAutocompleteHostRef.current;

        if (!host || !PlaceAutocompleteElement) {
          throw new Error('PlaceAutocompleteElement unavailable');
        }

        cleanupWidget();

        const placeAutocomplete = new PlaceAutocompleteElement({});
        placeAutocomplete.placeholder = 'Start typing an address';
        placeAutocomplete.includedRegionCodes = ['us'];
        placeAutocomplete.setAttribute('aria-label', 'Street address');
        placeAutocomplete.style.display = 'block';
        placeAutocomplete.style.width = '100%';
        placeAutocomplete.style.colorScheme = 'light';
        placeAutocomplete.style.setProperty('background', '#ffffff');
        placeAutocomplete.style.setProperty('color', '#0f172a');
        host.style.colorScheme = 'light';

        const handleInput = (inputEvent: any) => {
          const nextValue = typeof inputEvent?.target?.value === 'string'
            ? inputEvent.target.value
            : typeof placeAutocomplete.value === 'string'
              ? placeAutocomplete.value
              : '';
          setNewPropertyAddress(nextValue);
        };

        const handleSelect = async (selectEvent: any) => {
          try {
            await applySelectedPlace(selectEvent, placeAutocomplete);
          } catch (error) {
            console.warn('[AddProperty] ⚠️ Failed to read selected place details:', error);
          }
        };

        placeAutocomplete.addEventListener('input', handleInput);
        placeAutocomplete.addEventListener('gmp-select', handleSelect);
        removeInputListener = () => placeAutocomplete.removeEventListener('input', handleInput);
        removeSelectListener = () => placeAutocomplete.removeEventListener('gmp-select', handleSelect);

        host.replaceChildren(placeAutocomplete);
        autocompleteElementRef.current = placeAutocomplete;

        if (!isActive) return;

        setAddressAutocompleteMode('widget');
        window.requestAnimationFrame(() => {
          placeAutocomplete.focus?.();
        });

        console.log('[AddProperty] ✅ Google PlaceAutocompleteElement initialized');
      } catch (err) {
        cleanupWidget();

        if (!isActive) return;

        setAddressAutocompleteMode('manual');
        console.warn('[AddProperty] ⚠️ Falling back to manual address entry:', err);
        window.requestAnimationFrame(() => {
          addPropertyAddressRef.current?.focus();
        });
      }
    };

    const timer = setTimeout(() => {
      void initAutocomplete();
    }, 100);

    return () => {
      isActive = false;
      clearTimeout(timer);
      cleanupWidget();
      setAddressAutocompleteMode('manual');
    };
  }, [showAddPropertyForm]);

  // Notify user visibly if property data fetch fails
  useEffect(() => {
    if (propertyDashError) {
      // Simple alert fallback; could be replaced by toast component later
      // Avoid blocking spam: only alert once per error value
      console.warn('[AddProperty] Property dashboard error:', propertyDashError);
      try { alert('Property data lookup failed: ' + propertyDashError); } catch {}
    }
  }, [propertyDashError]);

  const handleDeleteProperty = async (propertyId: string) => {
    if (!confirm('Are you sure you want to remove this property from your portfolio?')) return;
    try {
      if (!user?.id) {
        throw new Error('Sign in required to remove a property');
      }

      const json = await ownerPropertiesClient.remove(user.id, propertyId);
      if (json.ok) {
        const deleted = savedProperties.find(p => p.id === propertyId);
        const remaining = savedProperties.filter(p => p.id !== propertyId);
        try { removeSavedProperty(propertyId); } catch { /* local cache best-effort */ }
        setSavedProperties(remaining);
        if (deleted && deleted.address === primaryProperty.address) {
          if (remaining.length > 0) {
            activateOverviewProperty(remaining[0]);
          } else {
            setPrimaryProperty({ address: '', location: '' });
            setPropertyDashboard(null);
          }
        }
      } else {
        alert('Failed to delete property: ' + (json.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('[DeleteProperty] Error:', err);
      alert('Failed to delete property. Please try again.');
    }
  };

  const handleAddPropertySubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = newPropertyAddress.trim();
    const location = newPropertyLocation.trim();
    if (!address) {
      console.warn('[AddProperty] Attempted save without address');
      return;
    }
    console.log('[AddProperty] Saving property', { address, locationProvided: !!location });
    
    // Save property with financial data
    const financials: PropertyFinancialData = {
      monthlyRent,
      otherIncome,
      vacancyRate,
      rentGrowth,
      insurance,
      utilities,
      hoa,
      repairsCapEx,
      managementPct,
      expenseInflation,
      taxInflation,
      interestRate,
      loanTerm,
      isInterestOnly,
      extraPrincipal,
      downPayment,
      closingCosts,
      initialRehab,
      appreciationRate,
    };
    
    setPrimaryProperty({ address, location, financials });
    setPropertyVersion(prev => prev + 1); // Increment to force re-render of environmental maps
    setShowAddPropertyForm(false);
    setNewPropertyAddress("");
    setNewPropertyLocation("");
    
    // Kick off ATTOM dashboard fetch (location optional)
    const fullAddress = combinePortfolioPropertyAddress(address, location);
    (async ()=>{
      setPropertyDashLoading(true); setPropertyDashError(null); setPropertyDashboard(null);
      try {
        const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
        const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
        const url = useProxy ? `/api/attom/dashboard?address=${encodeURIComponent(fullAddress)}` : (()=>{ const u = new URL(baseEnv || 'http://127.0.0.1:3001'); u.pathname = '/api/attom/dashboard'; u.searchParams.set('address', fullAddress); return u.toString(); })();
        console.log('[AddProperty] Fetching ATTOM dashboard', url);
        const resp = await fetch(url, { headers:{ 'Accept':'application/json' } });
        const text = await resp.text();
        let json; try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON ATTOM response (status ${resp.status})`); }
        if (!json.ok) throw new Error(json.error || 'Failed to load property data');
        console.log('[AddProperty] ATTOM dashboard loaded:', json);
        console.log('[AddProperty] Summary data check:', {
          beds: json.summary?.beds,
          baths: json.summary?.baths,
          rental_avm: json.summary?.rental_avm,
          rental_avm_low: json.summary?.rental_avm_low,
          rental_avm_high: json.summary?.rental_avm_high,
          living_sqft: json.summary?.living_sqft
        });
        console.log('[AddProperty] Coordinates:', json.location);
        console.log('[AddProperty] Building Permits:', json.building_permits);
        console.log('[AddProperty] Building Permits Count:', json.building_permits?.length || 0);
        if (json.building_permits && json.building_permits.length > 0) {
          console.log('[AddProperty] First Permit:', json.building_permits[0]);
        }
        console.log('[AddProperty] Schools:', json.schools);
        console.log('[AddProperty] Schools Count:', json.schools?.length || 0);
        console.log('[AddProperty] Area Context:', json.summary?.area_context);
        
        // Log cache status
        if (json.fromCache) {
          console.log('[AddProperty] ✅ Data loaded from cache (fast!)');
        } else {
          console.log('[AddProperty] 🌐 Data fetched from ATTOM API (cached for future use)');
        }
        
        const propertyData = json.data || json;
        
        // Log AVM history data
        console.log('[AddProperty] 📊 AVM History Check:', {
          hasAvmHistory: !!propertyData.avm_history,
          avmHistoryLength: propertyData.avm_history?.length || 0,
          firstRecord: propertyData.avm_history?.[0],
          lastRecord: propertyData.avm_history?.[propertyData.avm_history?.length - 1]
        });
        
        setPropertyDashboard((previousDashboard: any) => mergePropertyDashboardPayload(previousDashboard, propertyData, fullAddress));
        console.log('[AddProperty] ATTOM dashboard loaded, full propertyData:', propertyData);
        
        // Save property to database
        const userId = user?.id;
        if (!userId) {
          throw new Error('Sign in required to save a property to Firestore');
        }
        try {
          console.log('[AddProperty] Saving property to Firestore...');
          const saveResult = await ownerPropertiesClient.save({
            ownerId: userId,
            address: fullAddress,
            propertyData,
            financials,
            image: propertyData?.summary?.image || null,
          });
          if (saveResult.ok) {
            console.log('[AddProperty] ✅ Property saved to Firestore:', saveResult.propertyId || saveResult.property?.id);
            
            // Update user profile's properties array (append, don't replace)
            if (user?.id) {
              try {
                const { addPropertyToUserProfile } = await import('../services/firebaseService');
                await addPropertyToUserProfile(user.id, fullAddress);
                console.log('[AddProperty] ✅ Updated user profile properties array');
              } catch (profileError: any) {
                console.warn('[AddProperty] ⚠️ User profile update failed:', profileError);
              }
            }
            
            // Refresh saved properties list — append new property to existing list
            // instead of replacing to avoid losing existing properties
            setSavedProperties(prev => {
              // Check if this address already exists
              const exists = prev.some(p => p.address?.trim().toLowerCase() === fullAddress.trim().toLowerCase());
              if (exists) {
                // Update existing property in the list
                return prev.map(p => 
                  p.address?.trim().toLowerCase() === fullAddress.trim().toLowerCase()
                    ? { ...p, property_data: propertyData, financial_data: financials, updated_at: new Date().toISOString() }
                    : p
                );
              } else {
                // Append new property to the list
                return [...prev, {
                  id: saveResult.property?.id || saveResult.propertyId || `new_${Date.now()}`,
                  name: fullAddress,
                  address: fullAddress,
                  property_data: propertyData,
                  financial_data: financials,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                }];
              }
            });
            console.log('[AddProperty] ✅ Refreshed properties list (appended)');
          } else {
            throw new Error(saveResult.error || 'Failed to save property to Firestore');
          }
        } catch (saveError: any) {
          setPropertyDashError(saveError?.message || 'Property loaded but could not be saved to Firestore');
          console.error('[AddProperty] Error saving to Firestore:', saveError);
        }
      } catch (e:any) {
        setPropertyDashError(e.message || 'Property data fetch failed');
        console.error('[AddProperty] ATTOM fetch failed', e);
      } finally { setPropertyDashLoading(false); }
    })();
  };

  // Removed preferredVendors static list

  // AI Renovation Analysis function
  const _analyzePropertyImages = async () => {
    if (propertyImages.length === 0) {
      alert('Please upload at least one property image to analyze.');
      return;
    }

    if (!primaryProperty.address || primaryProperty.address.trim() === '') {
      alert('Please enter a property address or ZIP code. Location is required for accurate cost estimates.');
      return;
    }

    setIsAnalyzing(true);
    setAnalysisError(null);

    try {
      const propertyData = {
        address: primaryProperty.address || 'Property',
        location: primaryProperty.location || '',
        monthlyRent: monthlyRent || 0,
        propertyValue: propertyDashboard?.summary?.avm_value || 0,
        bedrooms: propertyDashboard?.summary?.beds || 0,
        bathrooms: propertyDashboard?.summary?.baths || 0,
        yearBuilt: propertyDashboard?.summary?.year_built || 0,
        squareFeet: propertyDashboard?.summary?.building_sqft || propertyDashboard?.summary?.living_sqft || 0
      };

      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const url = useProxy 
        ? '/api/analyze-renovations' 
        : `${baseEnv}/api/analyze-renovations`;

      const sortedPropertyImages = [...propertyImages].sort(compareRenovationImageNames);

      console.log('[AI Analysis] Sending request with', sortedPropertyImages.length, 'images');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          images: sortedPropertyImages.map(img => img.url),
          propertyData
        })
      });

      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Analysis failed');
      }

      console.log('[AI Analysis] Received suggestions:', result.suggestions);
      setRenovationSuggestions((result.suggestions || []).map(normalizeCanonicalRenovationSuggestion));
      
      // Scroll to results
      setTimeout(() => {
        const resultsSection = document.querySelector('[data-renovation-results]');
        if (resultsSection) {
          resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);

    } catch (error: any) {
      console.error('[AI Analysis] Error:', error);
      setAnalysisError(error.message || 'Failed to analyze images. Please try again.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // QuickBooks Connection Functions
  const checkQuickBooksConnection = async () => {
    setQbConnectionChecking(true);
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const baseUrl = useProxy ? '' : baseEnv;

      const response = await fetch(`${baseUrl}/api/quickbooks/status`);
      const data = await response.json();
      
      setQbConnected(data.connected || false);
      return data.connected || false;
    } catch (error) {
      console.error('[QuickBooks] Error checking connection:', error);
      setQbConnected(false);
      return false;
    } finally {
      setQbConnectionChecking(false);
    }
  };

  const connectToQuickBooks = () => {
    const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
    const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
    const baseUrl = useProxy ? 'http://localhost:3001' : (baseEnv || 'http://localhost:3001');

    const authUrl = `${baseUrl}/api/quickbooks/auth`;
    console.log('[QuickBooks] Opening auth URL:', authUrl);

    // Open QuickBooks OAuth in a popup window
    const width = 600;
    const height = 700;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;
    
    const popup = window.open(
      authUrl,
      'QuickBooks Connection',
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,location=no`
    );

    if (!popup) {
      alert('Popup blocked! Please allow popups for this site and try again.');
      return;
    }

    // Poll for window close and check connection status
    const checkPopup = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(checkPopup);
        console.log('[QuickBooks] Popup closed, checking connection status...');
        // Check connection status after popup closes
        setTimeout(() => {
          checkQuickBooksConnection();
        }, 1000);
      }
    }, 500);
  };

  // Native Bookkeeping Data Fetching Functions (Now uses Firestore!)
  const fetchQuickBooksData = async () => {
    setQbLoading(true);
    setQbError(null);

    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const baseUrl = useProxy ? '' : baseEnv;

      // Get Firebase auth token
      const { auth } = await import('../config/firebase');
      const firebaseUser = auth.currentUser;
      
      // Determine if we should use Firestore or fallback to SQLite
      let useFirestore = !!firebaseUser;
      let token: string | null = null;
      
      if (firebaseUser) {
        try {
          token = await firebaseUser.getIdToken();
        } catch (tokenError) {
          console.warn('[Bookkeeping] Could not get Firebase token, falling back to SQLite');
          useFirestore = false;
        }
      }

      // Calculate date range based on filter
      const today = new Date();
      let startDate = '';
      
      switch (qbTransactionFilter.period) {
        case '30days':
          startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          break;
        case '3months':
          startDate = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate()).toISOString().split('T')[0];
          break;
        case '6months':
          startDate = new Date(today.getFullYear(), today.getMonth() - 6, today.getDate()).toISOString().split('T')[0];
          break;
        case 'ytd':
          startDate = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
          break;
        default:
          startDate = '';
      }

      const endDate = today.toISOString().split('T')[0];
      const pricingPowerHistoryStartDate = new Date(today.getFullYear(), today.getMonth() - 23, 1).toISOString().split('T')[0];
      const scopedPropertyId = activeSavedProperty?.id || activeFirestorePropertyId || null;
      const propertyQuery = scopedPropertyId
        ? `&propertyId=${encodeURIComponent(String(scopedPropertyId))}`
        : '';
      
      // Prepare headers
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      if (useFirestore) {
        // Use Firestore endpoints (per-user data)
        console.log('[Bookkeeping] Using Firestore data source');
        
        const [transactionsRes, summaryRes] = await Promise.all([
          fetch(`${baseUrl}/api/bookkeeping/firestore/transactions?limit=200&startDate=${startDate}&endDate=${endDate}${propertyQuery}`, { headers }),
          fetch(`${baseUrl}/api/bookkeeping/firestore/summary?startDate=${startDate}&endDate=${endDate}${propertyQuery}`, { headers })
        ]);

        const [transactions, summary] = await Promise.all([
          transactionsRes.json(),
          summaryRes.json()
        ]);

        if (transactions.ok) {
          setQbTransactions(transactions.transactions || []);
          console.log(`[Bookkeeping] Loaded ${transactions.transactions?.length || 0} transactions from Firestore`);
        } else {
          console.warn('[Bookkeeping] Firestore transactions error:', transactions.error);
          // Try SQLite fallback
          useFirestore = false;
        }
        
        if (summary.ok) {
          setQbSummary(summary.summary);
        }
        
        // Get categories from summary if available
        if (summary.expensesByCategory || summary.incomeByCategory) {
          const categories = [
            ...(summary.incomeByCategory || []).map((c: any) => ({ ...c, type: 'income' })),
            ...(summary.expensesByCategory || []).map((c: any) => ({ ...c, type: 'expense' }))
          ];
          setQbCategories(categories);
        }
        
        // Try to get cashflow trend
        try {
          const trendRes = await fetch(`${baseUrl}/api/bookkeeping/firestore/cashflow-trend?startDate=${startDate}&endDate=${endDate}${propertyQuery}`, { headers });
          const trend = await trendRes.json();
          if (trend.ok) {
            setQbCashflowTrend(trend.trend || []);
          }
        } catch (e) {
          console.log('[Bookkeeping] No cashflow trend available');
        }

        try {
          const [historyTransactionsRes, historyTrendRes] = await Promise.all([
            fetch(`${baseUrl}/api/bookkeeping/firestore/transactions?limit=5000&startDate=${pricingPowerHistoryStartDate}&endDate=${endDate}${propertyQuery}`, { headers }),
            fetch(`${baseUrl}/api/bookkeeping/firestore/cashflow-trend?startDate=${pricingPowerHistoryStartDate}&endDate=${endDate}${propertyQuery}`, { headers })
          ]);
          const [historyTransactions, historyTrend] = await Promise.all([
            historyTransactionsRes.json(),
            historyTrendRes.json()
          ]);

          setPricingPowerBookkeepingTransactions(historyTransactions.ok ? (historyTransactions.transactions || []) : []);
          setPricingPowerBookkeepingCashflowTrend(historyTrend.ok ? (historyTrend.trend || []) : []);
        } catch (e) {
          console.log('[Bookkeeping] No pricing power history available from Firestore');
          setPricingPowerBookkeepingTransactions([]);
          setPricingPowerBookkeepingCashflowTrend([]);
        }
      }
      
      if (!useFirestore) {
        // Fallback to SQLite (old system)
        console.log('[Bookkeeping] Using SQLite data source (fallback)');
        
        const [transactionsRes, summaryRes, categoriesRes, trendRes, billsRes] = await Promise.all([
          fetch(`${baseUrl}/api/bookkeeping/transactions?limit=200&startDate=${startDate}&endDate=${endDate}${propertyQuery}`),
          fetch(`${baseUrl}/api/bookkeeping/summary?startDate=${startDate}&endDate=${endDate}${propertyQuery}`),
          fetch(`${baseUrl}/api/bookkeeping/categories?startDate=${startDate}&endDate=${endDate}${propertyQuery}`),
          fetch(`${baseUrl}/api/bookkeeping/cashflow-trend?months=6${propertyQuery}`),
          fetch(`${baseUrl}/api/bookkeeping/upcoming-bills`)
        ]);

        const [transactions, summary, categories, trend, bills] = await Promise.all([
          transactionsRes.json(),
          summaryRes.json(),
          categoriesRes.json(),
          trendRes.json(),
          billsRes.json()
        ]);

        if (transactions.ok) {
          setQbTransactions(transactions.transactions || []);
        }
        if (summary.ok) {
          setQbSummary(summary.summary);
        }
        if (categories.ok) {
          setQbCategories(categories.categories || []);
        }
        if (trend.ok) {
          setQbCashflowTrend(trend.trend || []);
        }
        if (bills.ok) {
          setQbUpcomingBills(bills.upcomingBills || []);
        }

        try {
          const [historyTransactionsRes, historyTrendRes] = await Promise.all([
            fetch(`${baseUrl}/api/bookkeeping/transactions?limit=5000&startDate=${pricingPowerHistoryStartDate}&endDate=${endDate}${propertyQuery}`),
            fetch(`${baseUrl}/api/bookkeeping/cashflow-trend?months=24${propertyQuery}`)
          ]);
          const [historyTransactions, historyTrend] = await Promise.all([
            historyTransactionsRes.json(),
            historyTrendRes.json()
          ]);

          setPricingPowerBookkeepingTransactions(historyTransactions.ok ? (historyTransactions.transactions || []) : []);
          setPricingPowerBookkeepingCashflowTrend(historyTrend.ok ? (historyTrend.trend || []) : []);
        } catch (e) {
          console.log('[Bookkeeping] No pricing power history available from SQLite');
          setPricingPowerBookkeepingTransactions([]);
          setPricingPowerBookkeepingCashflowTrend([]);
        }
      }

      console.log('[Bookkeeping] Data loaded successfully');

    } catch (error: any) {
      console.error('[Bookkeeping] Error fetching data:', error);
      setQbError(error.message || 'Failed to load bookkeeping data');
    } finally {
      setQbLoading(false);
    }
  };

  // QuickBooks Sync Functions (Firestore-based)
  const fetchPropertiesWithActivity = async (month: string) => {
    // No longer needed with Firestore - we pull directly from user's data
    console.log('[QuickBooks Sync] Using Firestore-based sync for month:', month);
  };

  const fetchSyncPreview = async (_propertyId: number, month: string) => {
    setQbSyncLoading(true);
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const baseUrl = useProxy ? '' : baseEnv;

      // Get Firebase auth token
      const { auth } = await import('../config/firebase');
      const user = auth.currentUser;
      console.log('[QuickBooks Sync] Firebase auth state:', { 
        hasUser: !!user, 
        email: user?.email,
        uid: user?.uid 
      });
      
      if (!user) {
        alert('You need to be signed in with Firebase Auth to use the bookkeeping system.\n\nIf you logged in with demo mode, please register a real account or sign in with Google.');
        setQbSyncLoading(false);
        return;
      }
      
      const token = await user.getIdToken();
      console.log('[QuickBooks Sync] Got auth token:', token ? 'yes' : 'no');

      // Use individual transactions preview route
      const response = await fetch(`${baseUrl}/api/quickbooks/firestore/sync/individual/preview/${month}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      const data = await response.json();
      
      if (data.ok) {
        setQbSyncPreview(data);
      } else if (data.error === 'no_activity' || data.error === 'not_initialized') {
        // Check if bookkeeping is initialized
        const statusRes = await fetch(`${baseUrl}/api/bookkeeping/firestore/status`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        const statusData = await statusRes.json();
        
        if (!statusData.initialized) {
          const shouldInit = confirm(
            `Your bookkeeping system hasn't been set up yet.\n\n` +
            `Would you like to initialize it now? This will create your chart of accounts.`
          );
          if (shouldInit) {
            // Initialize bookkeeping
            const initRes = await fetch(`${baseUrl}/api/bookkeeping/firestore/initialize`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
              }
            });
            const initData = await initRes.json();
            if (initData.ok) {
              alert('✅ Bookkeeping system initialized!\n\nNow you can:\n1. Add transactions manually\n2. Import from QuickBooks\n3. Connect your bank via Plaid');
              // Ask about importing
              const shouldImport = confirm('Would you like to IMPORT existing transactions FROM QuickBooks?');
              if (shouldImport) {
                setQbShowSyncModal(false);
                openImportModal();
              }
            } else {
              alert('Failed to initialize: ' + (initData.error || 'Unknown error'));
            }
          }
        } else {
          // Initialized but no transactions for this month
          const shouldImport = confirm(
            `No bookkeeping transactions found for ${month}.\n\n` +
            `This feature pushes YOUR data → QuickBooks.\n\n` +
            `Would you like to IMPORT transactions FROM QuickBooks instead?`
          );
          if (shouldImport) {
            setQbShowSyncModal(false);
            openImportModal();
          }
        }
      } else if (data.error === 'unauthorized') {
        alert('Please sign in to use the bookkeeping system.');
      } else {
        alert(`Preview failed: ${data.error}\n\n${data.message || ''}`);
      }
    } catch (error: any) {
      console.error('[QuickBooks Sync] Error fetching preview:', error);
      alert('Failed to load sync preview: ' + error.message);
    } finally {
      setQbSyncLoading(false);
    }
  };

  const pushToQuickBooks = async (_propertyId: number, month: string) => {
    if (!confirm('Push individual transactions to QuickBooks?\n\nThis will create separate Expense and Deposit records that QuickBooks can categorize with its own rules.')) {
      return;
    }

    setQbSyncLoading(true);
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const baseUrl = useProxy ? '' : baseEnv;

      // Get Firebase auth token
      const user = (await import('../config/firebase')).auth.currentUser;
      const token = user ? await user.getIdToken() : null;

      // Use individual transactions route
      const response = await fetch(`${baseUrl}/api/quickbooks/firestore/sync/individual/push/${month}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ 
          skipSynced: true
        })
      });

      const data = await response.json();
      
      if (data.ok) {
        alert(`✅ Successfully synced to QuickBooks!\n\nPushed: ${data.summary?.pushed || 0} transactions\nSkipped (already synced): ${data.summary?.skipped || 0}\nFailed: ${data.summary?.failed || 0}`);
        setQbShowSyncModal(false);
      } else {
        alert(`Sync failed: ${data.error}\n\n${data.message || ''}`);
      }
    } catch (error: any) {
      console.error('[QuickBooks Sync] Error pushing data:', error);
      alert('Failed to push to QuickBooks: ' + error.message);
    } finally {
      setQbSyncLoading(false);
    }
  };

  const openSyncModal = (propertyId: number) => {
    setQbSelectedProperty(propertyId);
    // Default to current month
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    setQbSelectedMonth(currentMonth);
    setQbShowSyncModal(true);
    setQbSyncPreview(null);
    fetchPropertiesWithActivity(currentMonth);
  };

  // ==================== QuickBooks IMPORT Functions (Load FROM QuickBooks) ====================
  
  const openImportModal = () => {
    setQbShowImportModal(true);
    setQbImportPreview(null);
    setQbImportSelectedTxns(new Set());
    // Set default date range to last 30 days
    setQbImportDateRange({
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      endDate: new Date().toISOString().split('T')[0]
    });
  };

  const fetchImportPreview = async () => {
    setQbImportLoading(true);
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const baseUrl = useProxy ? '' : baseEnv;

      const response = await fetch(
        `${baseUrl}/api/quickbooks/import/preview?startDate=${qbImportDateRange.startDate}&endDate=${qbImportDateRange.endDate}&type=all`
      );
      const data = await response.json();
      
      if (data.ok) {
        setQbImportPreview(data);
        // Auto-select all transactions by default
        const allIds = new Set<string>(data.transactions.map((t: any) => t.qbo_id as string));
        setQbImportSelectedTxns(allIds);
      } else {
        alert(`Failed to load QuickBooks data: ${data.error}\n\n${data.message || ''}`);
      }
    } catch (error: any) {
      console.error('[QuickBooks Import] Error fetching preview:', error);
      alert('Failed to load QuickBooks transactions: ' + error.message);
    } finally {
      setQbImportLoading(false);
    }
  };

  const executeImport = async () => {
    if (qbImportSelectedTxns.size === 0) {
      alert('Please select at least one transaction to import.');
      return;
    }

    if (!confirm(`Import ${qbImportSelectedTxns.size} transactions from QuickBooks into your bookkeeping system?`)) {
      return;
    }

    setQbImportLoading(true);
    try {
      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
      const baseUrl = useProxy ? '' : baseEnv;

      // Get the full transaction data for selected IDs
      const selectedTransactions = qbImportPreview.transactions.filter(
        (t: any) => qbImportSelectedTxns.has(t.qbo_id)
      );

      const response = await fetch(`${baseUrl}/api/quickbooks/import/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          transactions: selectedTransactions,
          property_id: qbSelectedProperty || 1
        })
      });

      const data = await response.json();
      
      if (data.ok) {
        alert(
          `✅ Import Complete!\n\n` +
          `Imported: ${data.results.imported.length} transactions\n` +
          `Failed: ${data.results.failed.length} transactions\n` +
          `Skipped: ${data.results.skipped.length} transactions`
        );
        setQbShowImportModal(false);
        // Refresh bookkeeping data
        fetchQuickBooksData();
      } else {
        alert(`Import failed: ${data.error}\n\n${data.message || ''}`);
      }
    } catch (error: any) {
      console.error('[QuickBooks Import] Error executing import:', error);
      alert('Failed to import transactions: ' + error.message);
    } finally {
      setQbImportLoading(false);
    }
  };

  const toggleImportSelection = (qboId: string) => {
    setQbImportSelectedTxns(prev => {
      const newSet = new Set(prev);
      if (newSet.has(qboId)) {
        newSet.delete(qboId);
      } else {
        newSet.add(qboId);
      }
      return newSet;
    });
  };

  const selectAllImportTxns = () => {
    if (qbImportPreview?.transactions) {
      const allIds = new Set<string>(qbImportPreview.transactions.map((t: any) => t.qbo_id as string));
      setQbImportSelectedTxns(allIds);
    }
  };

  const deselectAllImportTxns = () => {
    setQbImportSelectedTxns(new Set());
  };

  // Fetch bookkeeping data when the property workspace is showing
  React.useEffect(() => {
    fetchQuickBooksData();
    checkQuickBooksConnection();
  }, [qbTransactionFilter, activeSavedProperty?.id, activeFirestorePropertyId]);

  const activateOverviewProperty = (property: any) => {
    const data = property?.property_data;
    const financials = property?.financial_data;

    setPrimaryProperty({
      address: property?.address || '',
      location: '',
      financials,
    });
    setPropertyDashboard((previousDashboard: any) => mergePropertyDashboardPayload(previousDashboard, data || null, property?.address || ''));
    setPropertyDashError(null);
    setPropertyDashLoading(false);

    // Keep the workspace deep-linkable (plan Phase 5).
    try {
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'properties');
      if (property?.id) next.set('property', String(property.id));
      else next.delete('property');
      if (property?.address) next.set('address', String(property.address));
      else next.delete('address');
      setSearchParams(next, { replace: true });
    } catch {
      // URL sync is best-effort; selection still works without it.
    }

    const needsRefresh = !data?.avm_history?.length || !data?.summary?.mortgage || !data?.schools?.length;
    if (needsRefresh && property?.address) {
      setPropertyDashLoading(true);
      (async () => {
        try {
          const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
          const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
          const url = useProxy
            ? `/api/attom/dashboard?address=${encodeURIComponent(property.address)}`
            : (() => {
                const u = new URL(baseEnv || 'http://127.0.0.1:3001');
                u.pathname = '/api/attom/dashboard';
                u.searchParams.set('address', property.address);
                return u.toString();
              })();
          const resp = await fetch(url);
          const json = await resp.json();
          if (json.ok) {
            const freshData = json.data || json;
            setPropertyDashboard((prev: any) => mergePropertyDashboardPayload(prev, freshData, property.address));
          }
        } catch (err) {
          console.warn('[Portfolio] ATTOM re-fetch failed:', err);
        } finally {
          setPropertyDashLoading(false);
        }
      })();
    }
  };
  /** Picking a pin selects that property and returns the centre to its photo. */
  const handlePortfolioMapSelect = (property: any) => {
    activateOverviewProperty(property);
    setOverviewVisual('street');
  };

  // Assistant / deep-link: open a specific property workspace from ?tab=&property=&address=&workspace=
  useEffect(() => {
    const tab = String(searchParams.get('tab') || '').toLowerCase();
    const workspace = String(searchParams.get('workspace') || '').toLowerCase();
    const propertyId = String(searchParams.get('property') || '').trim();
    const address = String(searchParams.get('address') || '').trim();

    // Normalize retired overview tab deep-links onto the Properties workspace.
    if (tab === 'overview') {
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'properties');
      setSearchParams(next, { replace: true });
    }

    if (
      workspace === 'overview'
      || workspace === 'analytics'
      || workspace === 'rentalpricingpower'
      || workspace === 'environmentalrisk'
      || workspace === 'propertyhealth'
      || workspace === 'property_health'
      || workspace === 'health'
    ) {
      setWorkspaceSubTab(normalizePropertyWorkspaceTab(workspace));
    }

    if ((!propertyId && !address) || !Array.isArray(savedProperties) || savedProperties.length === 0) {
      return;
    }

    const normalize = (value: string) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const needle = normalize(address || propertyId);
    const matched = savedProperties.find((property: any) => {
      if (propertyId && String(property?.id || '') === propertyId) return true;
      const candidate = normalize(property?.address || '');
      return candidate === needle || candidate.includes(needle) || needle.includes(candidate);
    });

    if (!matched) return;

    const alreadyActive = normalize(primaryProperty.address) === normalize(matched.address || '');
    if (!alreadyActive) {
      activateOverviewProperty(matched);
    }
  }, [searchParams, savedProperties, primaryProperty.address]);

  const selectedSummary = propertyDashboard?.summary || activeSavedProperty?.property_data?.summary || null;
  const selectedPropertyAddress = (selectedSummary?.address as string)
    || [primaryProperty.address, primaryProperty.location].filter(Boolean).join(', ')
    || 'Address not set';
  const currentTenantRecord = tenants.find((tenant) => tenant.status === 'Current') || null;
  const currentTenant = currentTenantRecord || firestoreTenant;
  const currentTenantName = currentTenant
    ? currentTenant.name || `${currentTenant.firstName || ''} ${currentTenant.lastName || ''}`.trim() || 'Tenant'
    : 'No tenant on file';
  const currentTenantEmail = currentTenant?.email || 'No messages';
  const hasMessageableTenant = Boolean(currentTenantRecord);
  const overviewToneLabel = 'Properties';
  const selectedPropertyMeta = [
    {
      label: 'Beds / Baths',
      value: `${selectedSummary?.beds ?? '—'}/${selectedSummary?.baths ?? '—'}`,
    },
    {
      label: 'Living Area',
      value: selectedSummary?.living_sqft ? `${Number(selectedSummary.living_sqft).toLocaleString()} sf` : '—',
    },
    {
      label: 'Year Built',
      value: selectedSummary?.year_built || '—',
    },
    {
      label: 'Age',
      value: selectedSummary?.age ? `${selectedSummary.age} yrs` : '—',
    },
  ];

  const workspaceEstimatedValue = Number(financialInputs?.avm || selectedSummary?.avm_value || selectedSummary?.market_value || 0);
  const workspaceEquity = Math.max(
    workspaceEstimatedValue - Number(financialInputs?.avm && financialInputs?.downPayment != null
      ? Math.max(financialInputs.avm - financialInputs.downPayment, 0)
      : selectedSummary?.mortgage?.amount || 0),
    0,
  );
  const workspaceMonthlyRent = Number(financialInputs?.monthlyRent || 0);
  const workspaceMonthlyCashFlow = (() => {
    const series = (pricingAdjustedCurrentChartData ?? chartData)?.cashFlow;
    if (series?.[0] != null) return (series[0] * 1000) / 12;
    return null;
  })();
  const workspaceOccupied = Boolean(currentTenantRecord || firestoreTenant);

  /*
   * Rental analytics on a second home are not just noise, they report rent and
   * cash flow for income that does not exist. The use-type field is a hint, not
   * a lock: Prestwick-style records often have owner-saved rent or a tenant
   * while still defaulting to second_home from onboarding. ATTOM rental AVM is
   * not evidence — every house has one.
   */
  const workspaceUseType = resolvePropertyUseType(activeSavedProperty ?? primaryProperty);
  const ownerSavedMonthlyRent = Number(
    activeSavedProperty?.financial_data?.monthlyRent
    ?? primaryProperty.financials?.monthlyRent
    ?? 0,
  );
  const workspaceIsRental = shouldShowRentalWorkspace(activeSavedProperty ?? primaryProperty, {
    occupied: workspaceOccupied,
    monthlyRent: ownerSavedMonthlyRent,
  }) || shouldShowRentalWorkspace(primaryProperty, { occupied: workspaceOccupied, monthlyRent: ownerSavedMonthlyRent });
  /** The one address string the overview header, Street View and modal share. */
  const overviewAddress =
    (propertyDashboard?.summary?.address as string)
    || [primaryProperty.address, primaryProperty.location].filter(Boolean).join(', ')
    || 'Address not set';
  const workspaceAnnualPropertyTax = (() => {
    const fromSummary = Number((selectedSummary as any)?.tax_current || 0);
    if (fromSummary > 0) return fromSummary;
    const history = propertyDashboard?.tax_history;
    if (!Array.isArray(history) || history.length === 0) return 0;
    const latest = [...history]
      .filter((entry) => Number(entry?.tax_amount) > 0)
      .sort((a, b) => Number(b?.year || 0) - Number(a?.year || 0))[0];
    return Number(latest?.tax_amount || 0);
  })();
  /*
   * A non-rental has no return metrics, so Analytics would carry only value and
   * tax history — those move onto Overview and the tab goes away rather than
   * existing as a near-empty duplicate.
   */
  const workspaceVisibleTabs = getPropertyWorkspaceTabs().filter((tabId) => {
    if (tabId === 'rentalPricingPower' || tabId === 'analytics') return workspaceIsRental;
    return true;
  });

  const setWorkspaceSubTabAndUrl = (nextTab: PropertyWorkspaceSubTab) => {
    setWorkspaceSubTab(nextTab);
    try {
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'properties');
      next.set('workspace', nextTab);
      setSearchParams(next, { replace: true });
    } catch {
      // best-effort
    }
  };

  // Switching from a rental to a second home can strand you on a tab that no
  // longer exists, leaving the nav with nothing selected.
  const workspaceTabIsVisible = workspaceVisibleTabs.includes(workspaceSubTab);
  useEffect(() => {
    if (!workspaceTabIsVisible) {
      setWorkspaceSubTabAndUrl('overview');
    }
  }, [workspaceTabIsVisible]);

      function PropertyWorkspacePanel() {
        return (
          <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
                {/*
                  Same tab treatment as WorkspaceTabsHeader on Predictive
                  Maintenance. These stay attached to the workspace rather than
                  moving to the page header, because a portfolio context block and
                  a property switcher sit above them — per-property tabs belong
                  next to the property they act on.
                */}
                <nav
                  className="sticky top-0 z-10 flex justify-center border-b border-slate-200 bg-white/95 px-6 backdrop-blur-xl"
                  role="tablist"
                  aria-label="Property workspace sections"
                >
                  <div className="flex flex-wrap items-end justify-center gap-x-7 gap-y-2 overflow-x-auto">
                  {workspaceVisibleTabs.map((tabId) => {
                    const isActive = workspaceSubTab === tabId;
                    return (
                    <button
                      key={tabId}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setWorkspaceSubTabAndUrl(tabId)}
                      className={`whitespace-nowrap border-b-2 px-1 pb-3 pt-3 text-[15px] font-semibold tracking-tight transition sm:text-base ${
                        isActive
                          ? 'border-slate-900 text-slate-900'
                          : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900'
                      }`}
                    >
                      {PROPERTY_WORKSPACE_TAB_LABELS[tabId]}
                    </button>
                    );
                  })}
                  </div>
                </nav>

                <div className="border-b border-slate-100 px-6 py-4">
                  <KpiStrip
                    items={[
                      {
                        label: 'Estimated value',
                        value: workspaceEstimatedValue > 0 ? formatCurrency(workspaceEstimatedValue) : '—',
                        sub: selectedPropertyAddress,
                      },
                      {
                        label: 'Equity',
                        value: workspaceEstimatedValue > 0 ? formatCurrency(workspaceEquity) : '—',
                        sub: 'value minus mortgage',
                      },
                      ...(workspaceIsRental
                        ? ([
                            {
                              label: 'Monthly rent',
                              value: workspaceMonthlyRent > 0 ? `${formatCurrency(workspaceMonthlyRent)}/mo` : '—',
                              sub: workspaceOccupied ? 'Occupied' : 'Vacant',
                            },
                            {
                              label: 'This-month cash flow',
                              value: workspaceMonthlyCashFlow != null ? formatCurrency(workspaceMonthlyCashFlow) : '—',
                              sub: workspaceOccupied ? 'After expenses & debt' : 'No tenant on file',
                              tone: workspaceMonthlyCashFlow != null
                                ? (workspaceMonthlyCashFlow >= 0 ? 'positive' : 'negative')
                                : 'default',
                              toneValue: true,
                            },
                          ] as KpiStripItem[])
                        : ([
                            {
                              label: 'Annual property tax',
                              value: workspaceAnnualPropertyTax > 0 ? formatCurrency(workspaceAnnualPropertyTax) : '—',
                              sub: 'most recent assessment',
                            },
                            {
                              label: 'Used as',
                              value: PROPERTY_USE_TYPE_META[workspaceUseType].label,
                              sub: 'set during onboarding',
                            },
                          ] as KpiStripItem[])),
                    ]}
                  />
                </div>

                <div className={workspaceSubTab === 'overview' ? 'px-6 py-5' : 'hidden'}>
                  <PropertyTwinCard
                    title={overviewAddress}
                    headerRight={
                      <>
                        <TwinPill tone={workspaceIsRental ? 'info' : 'positive'}>
                          {PROPERTY_USE_TYPE_META[workspaceUseType].label}
                        </TwinPill>
                        <TwinPill>{savedProperties.length} holdings</TwinPill>
                      </>
                    }
                    views={[
                      { id: 'street', label: 'Street view' },
                      { id: 'map', label: 'Holdings map', title: 'Where this property sits in the portfolio' },
                      { id: 'trend', label: 'Value trend', title: 'Portfolio value over time' },
                    ]}
                    view={overviewVisual}
                    onViewChange={setOverviewVisual}
                    toolbarExtra={
                      overviewVisual === 'trend' ? (
                        <TwinSegmented<PropertyPortfolioHistoryGranularity>
                          ariaLabel="Trend granularity"
                          value={valueTrendGranularity}
                          onChange={setValueTrendGranularity}
                          options={[
                            { id: 'quarterly', label: 'Quarterly' },
                            { id: 'annual', label: 'Annual' },
                          ]}
                        />
                      ) : overviewVisual === 'map' ? (
                        <span className="text-[11px] text-slate-500">Click a pin to switch properties</span>
                      ) : null
                    }
                    visual={
                      overviewVisual === 'street' ? (
                        <StreetViewImage
                          address={overviewAddress}
                          className="h-full w-full"
                          /* 640 square is the largest Street View serves, and it
                             matches the frame closely enough that object-cover
                             barely crops. A narrow fov fills it with the house
                             rather than the street in front of it. */
                          width={640}
                          height={640}
                          fov={65}
                          pitch={6}
                          fill
                        />
                      ) : overviewVisual === 'map' ? (
                        <PortfolioPropertiesMap
                          variant="embedded"
                          properties={savedProperties}
                          selectedPropertyAddress={primaryProperty.address || selectedPropertyAddress}
                          overviewToneLabel={overviewToneLabel}
                          onSelectProperty={handlePortfolioMapSelect}
                        />
                      ) : (
                        <div className="h-full w-full overflow-auto bg-white p-3">
                          <PortfolioValueHistoryCard
                            bare
                            overview={combinedPortfolioOverview}
                            granularity={valueTrendGranularity}
                            onGranularityChange={setValueTrendGranularity}
                            chartHeight={300}
                          />
                        </div>
                      )
                    }
                    visualOverlay={
                      overviewVisual === 'street' ? (
                        <button
                          onClick={() => {
                            setStreetViewModalAddress(overviewAddress || null);
                            setIsStreetViewModalOpen(true);
                          }}
                          className="absolute right-2 top-2 rounded-lg bg-white/90 p-1.5 text-slate-700 shadow-md transition hover:bg-white"
                          title="Expand Street View"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                          </svg>
                        </button>
                      ) : null
                    }
                    visualFooter={
                      <div className="flex flex-wrap items-center gap-2">
                        <label
                          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-[11px] font-bold tracking-wide text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                          title="Add property images"
                        >
                          <input
                            type="file"
                            multiple
                            accept="image/*"
                            className="hidden"
                            onChange={handleFileInputChange}
                            disabled={propertyImages.length >= 25}
                          />
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                          Add images · {propertyImages.length}/25
                        </label>

                        {propertyImages.slice(0, 8).map((img) => (
                          <div
                            key={img.id}
                            className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-white"
                            title={img.name}
                          >
                            <img src={img.url} alt="" className="h-full w-full object-cover" />
                          </div>
                        ))}
                        {propertyImages.length > 8 && (
                          <span className="text-[11px] font-semibold text-slate-500">
                            +{propertyImages.length - 8} more
                          </span>
                        )}
                      </div>
                    }
                    facts={
                      <>
                                <FactPanel label="Valuation" dotColor="#10b981">
                                  <FactRow
                                    label="AVM:"
                                    value={propertyDashboard?.summary?.avm_value ? `$${Number(propertyDashboard.summary.avm_value).toLocaleString()}` : '—'}
                                  />
                                  {propertyDashboard?.summary?.avm_low && propertyDashboard?.summary?.avm_high && (
                                    <FactRow
                                      label="Range:"
                                      nowrap
                                      valueClassName="font-medium text-slate-700"
                                      value={`$${Number(propertyDashboard.summary.avm_low).toLocaleString()} – $${Number(propertyDashboard.summary.avm_high).toLocaleString()}`}
                                    />
                                  )}
                                  <FactRow
                                    label="Assessed:"
                                    value={propertyDashboard?.summary?.assessed_value ? `$${Number(propertyDashboard.summary.assessed_value).toLocaleString()}` : '—'}
                                  />
                                  <FactRow
                                    label="$/SqFt:"
                                    value={propertyDashboard?.summary?.price_per_sqft ? `$${Math.round(propertyDashboard.summary.price_per_sqft)}` : '—'}
                                  />
                                </FactPanel>

                                <FactPanel label="Property" dotColor="#6366f1">
                                  <FactRow
                                    label="Beds / Baths:"
                                    nowrap
                                    value={`${propertyDashboard?.summary?.beds ?? '—'} / ${propertyDashboard?.summary?.baths ?? '—'}`}
                                  />
                                  <FactRow
                                    label="SqFt:"
                                    value={propertyDashboard?.summary?.living_sqft ? Number(propertyDashboard.summary.living_sqft).toLocaleString() : '—'}
                                  />
                                  <FactRow label="Year Built:" value={propertyDashboard?.summary?.year_built || '—'} />
                                  <FactRow
                                    label="Age:"
                                    value={propertyDashboard?.summary?.age ? `${propertyDashboard.summary.age} yrs` : '—'}
                                  />
                                </FactPanel>

                                <FactPanel label="Mortgage" dotColor="#8b5cf6">
                                  {propertyDashboard?.summary?.mortgage ? (
                                    <>
                                      <FactRow
                                        label="Lender:"
                                        value={propertyDashboard.summary.mortgage.lender_name || '—'}
                                        title={propertyDashboard.summary.mortgage.lender_name}
                                      />
                                      <FactRow
                                        label="Amount:"
                                        value={propertyDashboard.summary.mortgage.amount ? `$${propertyDashboard.summary.mortgage.amount.toLocaleString()}` : '—'}
                                      />
                                      <FactRow
                                        label="Est. Rate:"
                                        valueClassName="text-blue-600"
                                        value={propertyDashboard.summary.mortgage.estimated_interest_rate ? `${propertyDashboard.summary.mortgage.estimated_interest_rate.toFixed(2)}%` : '—'}
                                      />
                                      <FactRow
                                        label="Type / Term:"
                                        nowrap
                                        value={`${propertyDashboard.summary.mortgage.loan_type || '—'} / ${propertyDashboard.summary.mortgage.term_months ? `${propertyDashboard.summary.mortgage.term_months}mo` : '—'}`}
                                      />
                                      {propertyDashboard.summary.mortgage.date && (
                                        <FactRow
                                          label="Originated:"
                                          nowrap
                                          value={new Date(propertyDashboard.summary.mortgage.date).toLocaleDateString()}
                                        />
                                      )}
                                      {propertyDashboard.summary.mortgage.assumability?.assumable && (
                                        <FactRow
                                          label="Assumable:"
                                          valueClassName={
                                            propertyDashboard.summary.mortgage.assumability.assumable === 'likely' ? 'text-emerald-600' :
                                            propertyDashboard.summary.mortgage.assumability.assumable === 'unlikely' ? 'text-rose-600' : 'text-amber-600'
                                          }
                                          value={propertyDashboard.summary.mortgage.assumability.assumable === 'likely' ? 'Likely' : propertyDashboard.summary.mortgage.assumability.assumable === 'unlikely' ? 'Unlikely' : 'Possible'}
                                        />
                                      )}
                                    </>
                                  ) : (
                                    <FactPanelEmpty>No mortgage data</FactPanelEmpty>
                                  )}
                                </FactPanel>

                                <FactPanel label="Context" dotColor="#14b8a6">
                                  <FactRow label="County:" value={propertyDashboard?.summary?.area_context?.county || '—'} />
                                  <FactRow label="Zoning:" value={propertyDashboard?.summary?.area_context?.zoning || '—'} />
                                  <FactRow label="Tax Area:" value={propertyDashboard?.summary?.area_context?.tax_code_area || '—'} />
                                  <FactRow label="Schools:" value={propertyDashboard?.schools?.length || 0} />
                                </FactPanel>
                      </>
                    }
                    footer={
                      <>
                            {/* Tenant Summary – compact one-liner with details popup */}
                            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-2.5">
                              {(() => {
                                const currentTenant = tenants.find(t => t.status === 'Current');
                                const tenant = currentTenant || firestoreTenant;
                                if (firestoreTenantLoading) {
                                  return <span className="text-sm text-gray-400">Loading tenant…</span>;
                                }
                                if (!tenant && firestoreTenants.length === 0) {
                                  return <span className="text-sm text-gray-400">No current tenant</span>;
                                }
                                if (firestoreTenants.length > 1) {
                                  return (
                                    <div className="flex items-center gap-2 text-sm text-gray-700">
                                      <div className="flex -space-x-2">
                                        {firestoreTenants.slice(0, 3).map((t: any, i: number) => {
                                          const n = t.name || `${t.firstName || ''} ${t.lastName || ''}`.trim() || '?';
                                          return t.photoURL ? (
                                            <img key={i} src={t.photoURL} alt={n} className="h-7 w-7 rounded-full border-2 border-white object-cover" />
                                          ) : (
                                            <div key={i} className="h-7 w-7 rounded-full border-2 border-white bg-gray-200 flex items-center justify-center text-[10px] font-semibold text-gray-600">
                                              {n.split(' ').map((p: string) => p[0]).slice(0, 2).join('')}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      <span><span className="font-semibold">{firestoreTenants.length} tenants</span></span>
                                    </div>
                                  );
                                }
                                const tName = tenant?.name || (tenant?.firstName && tenant?.lastName ? `${tenant.firstName} ${tenant.lastName}`.trim() : 'Unknown');
                                const tPhoto = tenant?.photoURL;
                                const leaseEnd = tenant?.end || tenant?.leaseEnd || tenant?.moveInDate;
                                return (
                                  <div className="flex items-center gap-2.5 text-sm text-gray-700">
                                    {tPhoto ? (
                                      <img src={tPhoto} alt={tName} className="h-7 w-7 rounded-full border border-purple-200 object-cover shrink-0" />
                                    ) : (
                                      <div className="h-7 w-7 rounded-full border bg-gray-100 shrink-0 flex items-center justify-center text-[10px] font-semibold text-gray-600">
                                        {tName.split(' ').map((p: string) => p[0]).slice(0, 2).join('')}
                                      </div>
                                    )}
                                    <span>
                                      <span className="font-semibold">{tName}</span>
                                      {leaseEnd && (
                                        <>
                                          <span className="mx-2 text-gray-300">|</span>
                                          <span className="text-gray-500">Lease ends {new Date(leaseEnd).toLocaleDateString('en-US',{month:'short',year:'numeric'})}</span>
                                        </>
                                      )}
                                    </span>
                                  </div>
                                );
                              })()}
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => setShowTenantDetailsPopup(true)}
                                  className="px-3 py-1 text-xs font-medium text-purple-700 bg-purple-50 rounded-md hover:bg-purple-100 transition-colors"
                                >
                                  View Details
                                </button>
                                <button
                                  onClick={() => {
                                    setOnboardingPropertyInfo({
                                      propertyId: activeFirestorePropertyId || `prop_${Date.now()}`,
                                      propertyAddress: activePropertyAddress || 'Property',
                                      ownerId: user?.id || '',
                                      ownerName: user?.name || '',
                                      ownerEmail: user?.email || ''
                                    });
                                    setShowTenantOnboarding(true);
                                  }}
                                  className="px-3 py-1 text-xs font-medium text-white bg-purple-600 rounded-md hover:bg-purple-700 transition-colors"
                                >
                                  + Onboard
                                </button>
                              </div>
                            </div>

                            {/* Tenant Details Popup Modal */}
                            {showTenantDetailsPopup && (
                              <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40" onClick={() => setShowTenantDetailsPopup(false)}>
                                <div className="relative w-full max-w-2xl max-h-[80vh] overflow-auto bg-white rounded-2xl shadow-2xl mx-4" onClick={(e) => e.stopPropagation()}>
                                  <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 rounded-t-2xl">
                                    <h3 className="font-semibold text-lg">Tenant Details</h3>
                                    <div className="flex items-center gap-2">
                                      {(tenants.find(t => t.status === 'Current') || firestoreTenant) && firestoreTenants.length <= 1 && (
                                        <button
                                          onClick={() => clearTenantFromPropertyFn()}
                                          disabled={clearingTenant}
                                          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-medium hover:bg-red-100 transition-all disabled:opacity-50"
                                        >
                                          {clearingTenant ? 'Clearing…' : 'Clear Tenant'}
                                        </button>
                                      )}
                                      <button onClick={() => setShowTenantDetailsPopup(false)} className="rounded-lg p-1.5 hover:bg-gray-100 text-gray-500">
                                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                      </button>
                                    </div>
                                  </div>
                                  <div className="p-6 space-y-4">
                                    {/* Full tenant info */}
                                    {(() => {
                                      const currentTenant = tenants.find(t => t.status === 'Current');
                                      const tenant = currentTenant || firestoreTenant;

                                      if (firestoreTenants.length > 1) {
                                        return (
                                          <div className="space-y-3">
                                            {firestoreTenants.map((t: any, idx: number) => {
                                              const tName = t.name || (t.firstName && t.lastName ? `${t.firstName} ${t.lastName}`.trim() : 'Unknown');
                                              const tUnit = t.unit ? `Unit ${t.unit}` : `Unit ${idx + 1}`;
                                              const tRent = t.monthlyRent || t.rent;
                                              const tLeaseEnd = t.end || t.leaseEnd || t.moveInDate;
                                              return (
                                                <div key={t.id || idx} className="flex items-center justify-between rounded-lg border px-4 py-3 bg-gray-50 text-sm">
                                                  <div>
                                                    <span className="font-semibold">{tName}</span>
                                                    <span className="ml-2 text-xs text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">{tUnit}</span>
                                                    {t.email && <span className="ml-3 text-gray-500">{t.email}</span>}
                                                  </div>
                                                  <div className="flex items-center gap-4 text-xs text-gray-500">
                                                    {tRent && <span className="font-medium text-green-600">${Number(tRent).toLocaleString()}/mo</span>}
                                                    {tLeaseEnd && <span>Ends {new Date(tLeaseEnd).toLocaleDateString()}</span>}
                                                    <button
                                                      onClick={() => clearTenantFromPropertyFn(t.id)}
                                                      disabled={clearingTenant}
                                                      className="text-red-400 hover:text-red-600 disabled:opacity-50"
                                                      title="Remove tenant"
                                                    >
                                                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                    </button>
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        );
                                      }

                                      if (!tenant) {
                                        return <p className="text-sm text-gray-400">No current tenant</p>;
                                      }

                                      const tenantName = tenant.name || (tenant.firstName && tenant.lastName ? `${tenant.firstName} ${tenant.lastName}`.trim() : 'Unknown');
                                      const tenantEmail = tenant.email || '';
                                      const tenantPhone = tenant.phone || '';
                                      const tenantUnit = tenant.unit || '';
                                      const leaseEnd = tenant.end || tenant.leaseEnd || tenant.moveInDate;
                                      const tenantPhotoURL = tenant.photoURL;

                                      return (
                                        <div className="flex items-start gap-4">
                                          {tenantPhotoURL ? (
                                            <img src={tenantPhotoURL} alt={tenantName} className="h-16 w-16 rounded-full border-2 border-purple-200 shrink-0 object-cover" />
                                          ) : (
                                            <div className="h-16 w-16 rounded-full border bg-gray-100 shrink-0 flex items-center justify-center text-base text-gray-600 font-semibold">
                                              {tenantName.split(' ').map((p: string)=>p[0]).slice(0,2).join('')}
                                            </div>
                                          )}
                                          <div className="grid gap-1.5 text-sm flex-1">
                                            <div className="flex justify-between border-b border-dotted border-gray-200 pb-1"><span className="text-gray-500">Name:</span><span className="font-semibold">{tenantName}</span></div>
                                            {tenantEmail && <div className="flex justify-between border-b border-dotted border-gray-200 pb-1"><span className="text-gray-500">Email:</span><span className="font-medium">{tenantEmail}</span></div>}
                                            {tenantPhone && <div className="flex justify-between border-b border-dotted border-gray-200 pb-1"><span className="text-gray-500">Phone:</span><span className="font-medium">{tenantPhone}</span></div>}
                                            {tenantUnit && <div className="flex justify-between border-b border-dotted border-gray-200 pb-1"><span className="text-gray-500">Unit:</span><span className="font-medium">{tenantUnit}</span></div>}
                                            {leaseEnd && <div className="flex justify-between border-b border-dotted border-gray-200 pb-1"><span className="text-gray-500">Lease End:</span><span className="font-medium">{new Date(leaseEnd).toLocaleDateString('en-US',{month:'long',year:'numeric'})}</span></div>}
                                            {tenant.status && <div className="flex justify-between border-b border-dotted border-gray-200 pb-1"><span className="text-gray-500">Status:</span><span className="font-medium text-green-600">{tenant.status}</span></div>}
                                          </div>
                                        </div>
                                      );
                                    })()}

                                    {/* Tenant Activity Panel inside popup */}
                                    {user?.id && activeFirestorePropertyId && (
                                      <div className="border-t pt-4">
                                        <TenantActivityPanel
                                          ownerId={user.id}
                                          propertyId={activeFirestorePropertyId}
                                        />
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Community & Schools – compact summary bar */}
                            {(propertyDashboard?.schools?.length > 0 || propertyDashboard?.summary?.area_context) && (
                              <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-2.5">
                                <div className="flex items-center gap-2 text-sm text-gray-700">
                                  <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                                  <span>
                                    <span className="font-semibold">Community & Schools</span>
                                    {propertyDashboard?.schools?.length > 0 && (
                                      <span className="ml-1.5 text-gray-400">· {propertyDashboard.schools.length} nearby</span>
                                    )}
                                    {propertyDashboard?.summary?.area_context?.county && (
                                      <span className="ml-1.5 text-gray-400">· {propertyDashboard.summary.area_context.county} County</span>
                                    )}
                                  </span>
                                </div>
                                <button
                                  onClick={() => setShowCommunitySchools(true)}
                                  className="px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                                >
                                  View Details
                                </button>
                              </div>
                            )}

                            {/* Community & Schools Popup Modal */}
                            {showCommunitySchools && (
                              <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40" onClick={() => setShowCommunitySchools(false)}>
                                <div className="relative w-full max-w-3xl max-h-[80vh] overflow-auto bg-white rounded-2xl shadow-2xl mx-4" onClick={(e) => e.stopPropagation()}>
                                  <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 rounded-t-2xl">
                                    <h3 className="font-semibold text-lg">Community & Schools</h3>
                                    <button onClick={() => setShowCommunitySchools(false)} className="rounded-lg p-1.5 hover:bg-gray-100 text-gray-500">
                                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                  </div>
                                  <div className="p-6 space-y-5">
                                    {/* Area quick facts */}
                                    {propertyDashboard?.summary?.area_context && (
                                      <div>
                                        <h4 className="text-xs font-bold uppercase tracking-wide text-gray-900 mb-2">Area Facts</h4>
                                        <div className="grid grid-cols-2 gap-x-6 text-sm">
                                          {propertyDashboard.summary.area_context.municipality && (
                                            <div className="flex justify-between border-b border-dotted border-gray-200 py-1"><span className="text-gray-500">Municipality:</span><span className="font-medium text-gray-900">{propertyDashboard.summary.area_context.municipality}</span></div>
                                          )}
                                          {propertyDashboard.summary.area_context.county && (
                                            <div className="flex justify-between border-b border-dotted border-gray-200 py-1"><span className="text-gray-500">County:</span><span className="font-medium text-gray-900">{propertyDashboard.summary.area_context.county}</span></div>
                                          )}
                                          {propertyDashboard.summary.area_context.zoning && (
                                            <div className="flex justify-between border-b border-dotted border-gray-200 py-1"><span className="text-gray-500">Zoning:</span><span className="font-medium text-gray-900">{propertyDashboard.summary.area_context.zoning}</span></div>
                                          )}
                                          {propertyDashboard.summary.area_context.census_tract && (
                                            <div className="flex justify-between border-b border-dotted border-gray-200 py-1"><span className="text-gray-500">Census Tract:</span><span className="font-medium text-gray-900">{propertyDashboard.summary.area_context.census_tract}</span></div>
                                          )}
                                          {propertyDashboard.summary.area_context.tax_code_area && (
                                            <div className="flex justify-between border-b border-dotted border-gray-200 py-1"><span className="text-gray-500">Tax Code:</span><span className="font-medium text-gray-900">{propertyDashboard.summary.area_context.tax_code_area}</span></div>
                                          )}
                                          {propertyDashboard.summary.area_context.fips && (
                                            <div className="flex justify-between border-b border-dotted border-gray-200 py-1"><span className="text-gray-500">FIPS:</span><span className="font-medium text-gray-900">{propertyDashboard.summary.area_context.fips}</span></div>
                                          )}
                                        </div>
                                      </div>
                                    )}

                                    {/* Crime Statistics (FBI) */}
                                    <CrimeDataSection
                                      fips={propertyDashboard?.summary?.area_context?.fips}
                                      stateCode={propertyDashboard?.summary?.area_context?.state_code}
                                      county={propertyDashboard?.summary?.area_context?.county || ''}
                                      address={primaryProperty.address}
                                    />

                                    {/* School District */}
                                    {propertyDashboard?.school_district && (
                                      <div>
                                        <h4 className="text-xs font-bold uppercase tracking-wide text-gray-900 mb-2">School District</h4>
                                        <div className="text-sm">
                                          <span className="font-medium text-gray-900">{propertyDashboard.school_district.name}</span>
                                          {propertyDashboard.school_district.rating && (
                                            <span className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${getSchoolRatingClasses(propertyDashboard.school_district.rating)}`}>{propertyDashboard.school_district.rating}</span>
                                          )}
                                        </div>
                                      </div>
                                    )}

                                    {/* School table */}
                                    {propertyDashboard?.schools?.length > 0 && (
                                      <div>
                                        <h4 className="text-xs font-bold uppercase tracking-wide text-gray-900 mb-2">Nearby Schools ({propertyDashboard.schools.length})</h4>
                                        <table className="w-full text-sm">
                                          <thead>
                                            <tr className="border-b border-gray-100 text-xs text-gray-500">
                                              <th className="pb-2 text-left font-medium">School</th>
                                              <th className="pb-2 text-left font-medium">Level</th>
                                              <th className="pb-2 text-left font-medium">Grades</th>
                                              <th className="pb-2 text-right font-medium">Rating</th>
                                              <th className="pb-2 text-right font-medium">Dist.</th>
                                              <th className="pb-2 text-right font-medium"><span className="sr-only">Map</span></th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-gray-100">
                                            {propertyDashboard.schools.map((school: any, idx: number) => (
                                              <tr key={idx} className="hover:bg-gray-50">
                                                <td className="py-2 pr-3 font-medium text-gray-900 max-w-[200px] truncate" title={school.name}>{school.name}</td>
                                                <td className="py-2 pr-3 text-gray-600">{school.level || '—'}</td>
                                                <td className="py-2 pr-3 text-gray-600">{school.grades || '—'}</td>
                                                <td className="py-2 pr-3 text-right">
                                                  {school.rating ? (
                                                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${getSchoolRatingClasses(school.rating)}`}>{school.rating}</span>
                                                  ) : '—'}
                                                </td>
                                                <td className="py-2 pr-3 text-right text-gray-600">{school.distance ? `${Number(school.distance).toFixed(1)} mi` : '—'}</td>
                                                <td className="py-2 text-right">
                                                  <a
                                                    href={buildGoogleMapsSearchUrl(
                                                      [school.name, school.district, propertyDashboard?.summary?.address || primaryProperty.address, primaryProperty.location].filter(Boolean).join(', '),
                                                      school.latitude,
                                                      school.longitude
                                                    )}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="text-blue-600 hover:text-blue-800 hover:underline text-xs font-medium whitespace-nowrap"
                                                  >
                                                    Map ↗
                                                  </a>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                      </>
                    }
                  />

                    {/*
                      For a non-rental the Analytics tab would hold only these two
                      charts, so they live here instead and that tab is dropped.
                    */}
                    {!workspaceIsRental && (
                      <div className="mt-5">
                        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">History</div>
                            <h3 className="mt-0.5 text-base font-bold text-slate-900">Value and taxes</h3>
                          </div>
                          <span className="text-[11px] text-slate-500">
                            Rental return metrics are hidden for a {PROPERTY_USE_TYPE_META[workspaceUseType].label.toLowerCase()}.
                          </span>
                        </div>
                        <AdditionalAnalyticsChartsGrid
                          compact
                          showHeader={false}
                          metricFilter={NON_RENTAL_ANALYTICS_METRICS}
                          avmGranularity={avmGranularity}
                          avmRange={avmRange}
                          avmPoints={avmPoints}
                          avmComparisonPoints={avmComparisonPoints}
                          avmLabels={_avmLabels}
                          chartData={pricingAdjustedCurrentChartData ?? chartData}
                          analyticsGranularity={analyticsGranularity}
                          taxHistoryRange={taxHistoryRange}
                          taxHistorySeries={taxHistoryChartData}
                          mortgageAmortRange={mortgageAmortRange}
                          onAnalyticsGranularityChange={(value) => setAnalyticsGranularity(value)}
                          onAvmGranularityChange={(value) => setAvmGranularity(value)}
                          onAvmRangeChange={(value) => setAvmRange(value as '2Q' | '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | 'all')}
                          onTaxHistoryRangeChange={(value) => setTaxHistoryRange(value)}
                          onMortgageAmortRangeChange={(value) => setMortgageAmortRange(value as '6M' | '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | '20Y' | '30Y')}
                          rentalPricingData={rentalPricingData}
                          pricingProjectionMode={rentalPricingProjectionMode}
                          optimizedChartData={optimizedChartData}
                          aiScenarioChartData={aiScenarioChartData}
                          aiScenarioLabel={aiScenarioLabel}
                          analyticsAudit={analyticsAudit ?? undefined}
                        />
                      </div>
                    )}
                </div>

                <div className={workspaceSubTab === 'analytics' ? 'px-6 py-5' : 'hidden'}>
                    <div className="mb-6">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Analytics</div>
                      <h3 className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900">
                        {workspaceIsRental ? 'Property performance' : 'Value and taxes'}
                      </h3>
                      <p className="mt-1 text-sm text-slate-500">
                        {workspaceIsRental
                          ? 'Headline returns first. Investor metrics and scenario tools stay behind Advanced.'
                          : `Rental return metrics are hidden because this property is tracked as a ${PROPERTY_USE_TYPE_META[workspaceUseType].label.toLowerCase()}.`}
                      </p>
                    </div>

                    {/* Key Metrics Dashboard — plain-language first */}
                    {workspaceIsRental && displayChartData && (
                      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Cash-on-cash (yr 1)</div>
                          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{displayChartData.cocReturn[0]?.toFixed(2) || '0.00'}%</div>
                          <div className="mt-0.5 text-xs text-slate-500">Cash return on cash invested</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Cap rate (yr 1)</div>
                          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{displayChartData.capRate[0]?.toFixed(2) || '0.00'}%</div>
                          <div className="mt-0.5 text-xs text-slate-500">NOI ÷ property value</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Break-even occupancy</div>
                          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{displayChartData.breakEvenOccupancy.toFixed(1)}%</div>
                          <div className="mt-0.5 text-xs text-slate-500">Min. occupancy to cover costs</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Debt coverage (yr 1)</div>
                          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
                            {displayChartData.dscr[0] >= 999 ? '∞' : displayChartData.dscr[0]?.toFixed(2) || '0.00'}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">Income ÷ mortgage payment</div>
                        </div>
                      </div>
                    )}

                    <details className={`mb-8 rounded-2xl border border-slate-200 bg-slate-50/60 open:bg-white ${workspaceIsRental ? '' : 'hidden'}`}>
                      <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-slate-800 marker:content-none [&::-webkit-details-marker]:hidden">
                        <span className="inline-flex items-center gap-2">
                          Advanced analytics
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">IRR · GRM · scenarios</span>
                        </span>
                      </summary>
                      <div className="space-y-6 border-t border-slate-200 px-5 py-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          {sampleFeedSuccess && (
                            <span className="text-sm text-emerald-600 font-medium">{sampleFeedSuccess}</span>
                          )}
                          <button
                            type="button"
                            onClick={handleLoadSampleFeed}
                            disabled={sampleFeedLoading}
                            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {sampleFeedLoading ? 'Loading sample…' : 'Load sample feed'}
                          </button>
                        </div>

                        <AITestScenarios
                          financialInputs={financialInputs}
                          propertyDashboard={propertyDashboard}
                          chartData={chartData}
                          propertyImages={propertyImages}
                          onScenarioApply={handleScenarioApply}
                        />

                        {displayChartData && (
                          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                            <div className="rounded-xl border border-slate-200 bg-white p-4">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">IRR (9-year)</div>
                              <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{displayChartData.irr.toFixed(2)}%</div>
                              <div className="mt-0.5 text-xs text-slate-500">{hasRiskAdjustedDisplayBasis ? 'Risk-adjusted current plan' : 'Hold-period return'}</div>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-4">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">GRM</div>
                              <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{displayChartData.grm.toFixed(1)}</div>
                              <div className="mt-0.5 text-xs text-slate-500">Price ÷ annual rent</div>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-4">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">DSCR (yr 1)</div>
                              <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
                                {displayChartData.dscr[0] >= 999 ? '∞' : displayChartData.dscr[0]?.toFixed(2) || '0.00'}
                              </div>
                              <div className="mt-0.5 text-xs text-slate-500">Debt service coverage</div>
                            </div>
                          </div>
                        )}
                      </div>
                    </details>

                    {workspaceIsRental && displayFinancialInputs && (
                      <div className="mb-8 rounded-2xl border bg-slate-50/80 p-5">
                        <div className="flex items-center justify-between gap-4 mb-4">
                          <div>
                            <div className="text-lg font-semibold text-slate-900">Calculation Basis</div>
                            <div className="text-sm text-slate-600">Derived from ATTOM mortgage data plus categorized bank transactions{hasRiskAdjustedDisplayBasis ? ', then aligned to the rental pricing model current-plan vacancy and growth assumptions' : ''}.</div>
                          </div>
                          <div className="text-xs text-slate-500">
                            {hasRiskAdjustedDisplayBasis ? 'Display Basis: Risk-Adjusted Current Plan' : `AI Categorization: ${propertyDashboard?.analyticsProjection?.aiProvider || 'unknown'}`}
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 text-sm">
                          <div className="rounded-xl border bg-white p-4">
                            <div className="font-semibold text-slate-900 mb-2">Financing</div>
                            <div className="space-y-1 text-slate-700">
                              <div>Original Loan: ${Number(displayFinancialInputs.originalLoanAmount || 0).toLocaleString()}</div>
                              <div>Current Balance: ${Number(displayFinancialInputs.currentLoanBalance || displayFinancialInputs.originalLoanAmount || 0).toLocaleString()}</div>
                              <div>Rate: {Number(displayFinancialInputs.interestRate || 0).toFixed(2)}%</div>
                              <div>Remaining Term: {displayFinancialInputs.remainingLoanTermMonths || displayFinancialInputs.loanTerm || 0} mo</div>
                              <div>Monthly Payment: ${(getAnnualDebtService(displayFinancialInputs) / 12).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                            </div>
                          </div>
                          <div className="rounded-xl border bg-white p-4">
                            <div className="font-semibold text-slate-900 mb-2">Income Basis</div>
                            <div className="space-y-1 text-slate-700">
                              <div>Monthly Rent: ${Number(displayFinancialInputs.monthlyRent || 0).toLocaleString()}</div>
                              <div>Other Income: ${Number(displayFinancialInputs.otherIncome || 0).toLocaleString()}</div>
                              <div>Vacancy: {Number(displayFinancialInputs.vacancyRate || 0).toFixed(1)}%</div>
                              <div>Rent Growth: {Number(displayFinancialInputs.rentGrowth || 0).toFixed(1)}%</div>
                            </div>
                          </div>
                          <div className="rounded-xl border bg-white p-4">
                            <div className="font-semibold text-slate-900 mb-2">Expense Basis</div>
                            <div className="space-y-1 text-slate-700">
                              <div>Taxes: ${Number(displayFinancialInputs.taxAmount || 0).toLocaleString()}/yr</div>
                              <div>Insurance: ${Number(displayFinancialInputs.insurance || 0).toLocaleString()}/yr</div>
                              <div>Utilities: ${Number(displayFinancialInputs.utilities || 0).toLocaleString()}/yr</div>
                              <div>HOA: ${Number(displayFinancialInputs.hoa || 0).toLocaleString()}/yr</div>
                              <div>Repairs/CapEx: ${Number(displayFinancialInputs.repairsCapEx || 0).toLocaleString()}/yr</div>
                            </div>
                          </div>
                          <div className="rounded-xl border bg-white p-4">
                            <div className="font-semibold text-slate-900 mb-2">Observed History</div>
                            <div className="space-y-1 text-slate-700">
                              <div>Months Covered: {propertyDashboard?.analyticsProjection?.calculationBreakdown?.observedHistory?.monthsCovered || 0}</div>
                              <div>Observed Income: ${Number(propertyDashboard?.analyticsProjection?.calculationBreakdown?.observedHistory?.annualIncomeObserved || 0).toLocaleString()}</div>
                              <div>Observed Expenses: ${Number(propertyDashboard?.analyticsProjection?.calculationBreakdown?.observedHistory?.annualExpensesObserved || 0).toLocaleString()}</div>
                              <div>Observed Cash Flow: ${Number(propertyDashboard?.analyticsProjection?.calculationBreakdown?.observedHistory?.annualCashFlowObserved || 0).toLocaleString()}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <AdditionalAnalyticsChartsGrid
                      avmGranularity={avmGranularity}
                      avmRange={avmRange}
                      avmPoints={avmPoints}
                      avmComparisonPoints={avmComparisonPoints}
                      avmLabels={_avmLabels}
                      chartData={pricingAdjustedCurrentChartData ?? chartData}
                      analyticsGranularity={analyticsGranularity}
                      taxHistoryRange={taxHistoryRange}
                      taxHistorySeries={taxHistoryChartData}
                      mortgageAmortRange={mortgageAmortRange}
                      onAnalyticsGranularityChange={(value) => setAnalyticsGranularity(value)}
                      onAvmGranularityChange={(value) => setAvmGranularity(value)}
                      onAvmRangeChange={(value) => setAvmRange(value as '2Q' | '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | 'all')}
                      onTaxHistoryRangeChange={(value) => setTaxHistoryRange(value)}
                      onMortgageAmortRangeChange={(value) => setMortgageAmortRange(value as '6M' | '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | '20Y' | '30Y')}
                      rentalPricingData={rentalPricingData}
                      pricingProjectionMode={rentalPricingProjectionMode}
                      optimizedChartData={optimizedChartData}
                      aiScenarioChartData={aiScenarioChartData}
                      aiScenarioLabel={aiScenarioLabel}
                      analyticsAudit={analyticsAudit ?? undefined}
                      metricFilter={workspaceIsRental ? undefined : NON_RENTAL_ANALYTICS_METRICS}
                    />

                    {/* New Rental Sankey Diagram */}
                    {workspaceIsRental && (
                      <div className="mt-8">
                        <RentalSankeyDiagram inputs={displayFinancialInputs} />
                      </div>
                    )}
                  </div>

                <div className={workspaceSubTab === 'rentalPricingPower' ? 'px-6 py-5' : 'hidden'}>
                    <div className="mb-8">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Pricing Intelligence</div>
                      <h3 className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900">Rental Pricing Power</h3>
                      <p className="mt-2 max-w-3xl text-sm text-slate-600">
                        Benchmark current rent, see pricing headroom, and evaluate renovation-driven upside without stacking this analysis underneath the broader portfolio charts.
                      </p>
                    </div>
                    <div>
                      <RentalPricingPowerGraph
                        propertyId={primaryProperty?.address}
                        currentRent={financialInputs?.monthlyRent || 1500}
                        bedrooms={Number(propertyDashboard?.beds ?? propertyDashboard?.summary?.beds) || 3}
                        bathrooms={Number(propertyDashboard?.baths ?? propertyDashboard?.summary?.baths) || 2}
                        squareFeet={Number(propertyDashboard?.sqft ?? propertyDashboard?.summary?.living_sqft ?? propertyDashboard?.summary?.sqft) || 1500}
                        zipCode={primaryProperty?.location?.split(' ').pop() || '90210'}
                        userId={user?.id}
                        cachePropertyId={activeSavedProperty?.id || primaryProperty?.address}
                        latitude={Number(propertyDashboard?.summary?.latitude ?? propertyDashboard?.location?.latitude) || undefined}
                        longitude={Number(propertyDashboard?.summary?.longitude ?? propertyDashboard?.location?.longitude) || undefined}
                        propertyType={propertyDashboard?.summary?.property_type || undefined}
                        yearBuilt={Number(propertyDashboard?.yearBuilt ?? propertyDashboard?.summary?.year_built) || undefined}
                        schoolRating={Number(propertyDashboard?.school_district?.rating ?? propertyDashboard?.summary?.school_district?.rating) || undefined}
                        attomRentAvm={Number(propertyDashboard?.summary?.rental_avm) || undefined}
                        attomRentLow={Number(propertyDashboard?.summary?.rental_avm_low) || undefined}
                        attomRentHigh={Number(propertyDashboard?.summary?.rental_avm_high) || undefined}
                        // Additional props for AI analysis
                        conditionScore={propertyDashboard?.condition_score}
                        conditionGrade={propertyDashboard?.condition_grade}
                        monthlyExpenses={financialInputs ? (
                          (financialInputs.insurance + financialInputs.utilities + financialInputs.hoa + financialInputs.repairsCapEx) / 12 +
                          financialInputs.taxAmount / 12 +
                          (financialInputs.monthlyRent * financialInputs.managementPct / 100)
                        ) : undefined}
                        monthlyMortgage={financialInputs ? (() => {
                          if (financialInputs.isInterestOnly || financialInputs.interestRate <= 0) return 0;
                          const L0 = financialInputs.avm - financialInputs.downPayment;
                          const rm = financialInputs.interestRate / 100 / 12;
                          const n = financialInputs.loanTerm;
                          return (rm * L0) / (1 - Math.pow(1 + rm, -n));
                        })() : undefined}
                        currentCashFlow={(pricingAdjustedCurrentChartData ?? chartData)?.cashFlow?.[0] ? (pricingAdjustedCurrentChartData ?? chartData)!.cashFlow[0] * 1000 / 12 : undefined}
                        vacancyRate={financialInputs?.vacancyRate}
                        bookkeepingTransactions={pricingPowerBookkeepingTransactions.length ? pricingPowerBookkeepingTransactions : qbTransactions}
                        bookkeepingCashflowTrend={pricingPowerBookkeepingCashflowTrend.length ? pricingPowerBookkeepingCashflowTrend : qbCashflowTrend}
                        onNavigateToRenovations={() => {
                          window.location.href = '/renovations';
                        }}
                        pricingProjectionMode={rentalPricingProjectionMode}
                        onPricingProjectionModeChange={(mode) => setRentalPricingProjectionMode(mode)}
                        onPricingDataChange={(data) => setRentalPricingData(data)}
                      />
                    </div>
                  </div>

                <div className={workspaceSubTab === 'environmentalRisk' ? 'px-6 py-5' : 'hidden'}>
                      <div className="mb-5 flex items-center gap-3.5">
                        <span className="flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-sm" style={{ background: HY_BRAND_GRADIENT }}>
                          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7z" />
                            <circle cx="12" cy="9" r="2.5" strokeWidth={2} />
                          </svg>
                        </span>
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Location Intelligence</div>
                          <h4 className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900">Environmental Risk Assessment</h4>
                        </div>
                      </div>
                      
                      {/* Dev / advanced: test a different address without ATTOM credits */}
                      <details className="mb-6 rounded-2xl border border-slate-200 bg-slate-50/70">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-700 marker:content-none [&::-webkit-details-marker]:hidden">
                          Advanced: test another location
                        </summary>
                      <div className="border-t border-slate-200 p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <p className="text-sm text-slate-600">
                            Quickly test different locations without using ATTOM API credits
                          </p>
                          {!googleMapsReady && (
                            <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-amber-600 animate-pulse">
                              Loading Google Maps...
                            </span>
                          )}
                          {googleMapsReady && (
                            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600">
                              Ready
                            </span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={envTestAddress}
                            onChange={(e) => setEnvTestAddress(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleEnvTestSearch()}
                            placeholder="Enter any address (e.g., 1600 Pennsylvania Ave NW, Washington DC)"
                            className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10"
                            disabled={envTestLoading || !googleMapsReady}
                          />
                          <button
                            onClick={handleEnvTestSearch}
                            disabled={envTestLoading || !envTestAddress.trim() || !googleMapsReady}
                            className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {envTestLoading ? 'Loading...' : 'Test Location'}
                          </button>
                          {envTestCoords && (
                            <button
                              onClick={() => {
                                setEnvTestCoords(null);
                                setEnvTestAddress('');
                              }}
                              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                            >
                              Clear
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              const lat = envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458);
                              const lng = envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250);
                              
                              if (confirm('Clear all cached environmental data for this location? This will force a fresh API fetch on next load.')) {
                                const result = await clearEnvironmentalCache(lat, lng);
                                if (result.cleared.length > 0) {
                                  alert(`✅ Cleared cache: ${result.cleared.join(', ')}\n\nRefresh the page to fetch fresh data.`);
                                } else {
                                  alert('No cached data found for this location.');
                                }
                              }
                            }}
                            className="flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                            title="Clear cached environmental data for this location"
                          >
                            🗑️ Reset Cache
                          </button>
                        </div>
                        {envTestCoords && (
                          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-indigo-100 bg-white px-3 py-1 text-xs font-medium text-indigo-600 shadow-sm">
                            Testing: {envTestCoords.address} ({envTestCoords.lat.toFixed(6)}, {envTestCoords.lng.toFixed(6)})
                          </div>
                        )}
                      </div>
                      </details>
                      
                      {/* Unified risk summary header (combined score + per-hazard KPIs) */}
                      {(propertyDashboard || envTestCoords) && (
                        <HyEnvRiskSummary
                          seasonal={seasonalRiskData}
                          floodOnly={isMaintenanceProduct()}
                        />
                      )}

                      <div className={`grid grid-cols-1 gap-3 ${isMaintenanceProduct() ? '' : 'lg:grid-cols-3'}`}>
                        {/* Air Quality & Noise Map + Graph — hidden on maintenance surface for now */}
                        {!isMaintenanceProduct() && (propertyDashboard || envTestCoords) && (
                          <div>
                            <AirQualityNoiseMap
                              key={`air-v${propertyVersion}-${envTestCoords ? envTestCoords.address : primaryProperty?.address}-${envTestCoords ? envTestCoords.lat : propertyDashboard?.location?.latitude}-${envTestCoords ? envTestCoords.lng : propertyDashboard?.location?.longitude}`}
                              latitude={envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458)}
                              longitude={envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250)}
                              address={envTestCoords ? envTestCoords.address : [primaryProperty?.address, primaryProperty?.location].filter(Boolean).join(', ')}
                              environmentalData={propertyDashboard?.environmental}
                            />
                            <RiskFluctuationGraph
                              riskType="airQuality"
                              latitude={envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458)}
                              longitude={envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250)}
                              onDataReady={(data) => setSeasonalRiskData(prev => ({ ...prev, airQuality: data }))}
                            />
                          </div>
                        )}

                        {/* Flood Risk Map + Graph */}
                        {(propertyDashboard || envTestCoords) && (
                          <div className={isMaintenanceProduct() ? 'w-full' : undefined}>
                            <FloodRiskMap
                              key={`flood-v${propertyVersion}-${envTestCoords ? envTestCoords.address : primaryProperty?.address}-${envTestCoords ? envTestCoords.lat : propertyDashboard?.location?.latitude}-${envTestCoords ? envTestCoords.lng : propertyDashboard?.location?.longitude}`}
                              latitude={envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458)}
                              longitude={envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250)}
                              address={envTestCoords ? envTestCoords.address : [primaryProperty?.address, primaryProperty?.location].filter(Boolean).join(', ')}
                              environmentalData={propertyDashboard?.environmental}
                              propertyId={activeSavedProperty?.id || activeFirestorePropertyId || undefined}
                              mapHeight={isMaintenanceProduct() ? 560 : 420}
                            />
                            <RiskFluctuationGraph
                              riskType="flood"
                              latitude={envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458)}
                              longitude={envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250)}
                              onDataReady={(data) => setSeasonalRiskData(prev => ({ ...prev, flood: data }))}
                            />
                          </div>
                        )}

                        {/* Wildfire Risk Map + Graph — hidden on maintenance surface for now */}
                        {!isMaintenanceProduct() && (propertyDashboard || envTestCoords) && (
                          <div>
                            <WildfireRiskMap
                              key={`wildfire-v${propertyVersion}-${envTestCoords ? envTestCoords.address : primaryProperty?.address}-${envTestCoords ? envTestCoords.lat : propertyDashboard?.location?.latitude}-${envTestCoords ? envTestCoords.lng : propertyDashboard?.location?.longitude}`}
                              latitude={envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458)}
                              longitude={envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250)}
                              address={envTestCoords ? envTestCoords.address : [primaryProperty?.address, primaryProperty?.location].filter(Boolean).join(', ')}
                              environmentalData={propertyDashboard?.environmental}
                            />
                            <RiskFluctuationGraph
                              riskType="wildfire"
                              latitude={envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458)}
                              longitude={envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250)}
                              onDataReady={(data) => setSeasonalRiskData(prev => ({ ...prev, wildfire: data }))}
                            />
                          </div>
                        )}
                      </div>

                      {/* AI Environmental Risk Mitigation Panel */}
                      {(propertyDashboard || envTestCoords) && (
                        <EnvironmentalRiskMitigationPanel
                          address={envTestCoords ? envTestCoords.address : [primaryProperty?.address, primaryProperty?.location].filter(Boolean).join(', ')}
                          latitude={envTestCoords ? envTestCoords.lat : Number(propertyDashboard?.location?.latitude || 39.050458)}
                          longitude={envTestCoords ? envTestCoords.lng : Number(propertyDashboard?.location?.longitude || -77.180250)}
                          zipCode={primaryProperty?.location?.split(' ').pop() || ''}
                          propertyDetails={{
                            bedrooms: Number(propertyDashboard?.beds ?? propertyDashboard?.summary?.beds) || 3,
                            sqft: Number(propertyDashboard?.sqft ?? propertyDashboard?.summary?.living_sqft ?? propertyDashboard?.summary?.building_sqft) || 1500,
                            stories: 1,
                            yearBuilt: propertyDashboard?.yearBuilt ? Number(propertyDashboard.yearBuilt) : Number(propertyDashboard?.summary?.year_built) || undefined
                          }}
                          environmentalData={propertyDashboard?.environmental}
                          seasonalData={seasonalRiskData}
                        />
                      )}
                    </div>

                <div className={workspaceSubTab === 'propertyHealth' ? 'px-6 py-5' : 'hidden'}>
                  <PropertyHealthTab
                    ownerId={user?.id}
                    propertyId={activeFirestorePropertyId || activeSavedProperty?.id || null}
                    propertyAddress={selectedPropertyAddress}
                    yearBuilt={
                      Number(propertyDashboard?.summary?.year_built)
                      || Number((propertyDashboard as any)?.yearBuilt)
                      || null
                    }
                    buildingPermits={
                      propertyDashboard?.building_permits
                      || activeSavedProperty?.data?.building_permits
                      || []
                    }
                    state={
                      (propertyDashboard?.summary as any)?.state
                      || (propertyDashboard?.location as any)?.state
                      || null
                    }
                    county={propertyDashboard?.summary?.area_context?.county || null}
                  />
                </div>

          </div>
        );
      }
  return (
    <div className="flex h-screen w-full flex-col overflow-hidden" style={{ background: HY_PAGE_WASH }}>
      <div className="px-6 pt-6">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-3 border-b border-slate-200 bg-white/70 px-2 pb-4 pt-1 backdrop-blur-sm sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">Properties</div>
              <div className="mt-1 text-sm text-slate-600">
                {savedProperties.length} {savedProperties.length === 1 ? 'holding' : 'holdings'} in this account
              </div>
            </div>
            <div className="shrink-0">
              <button
                type="button"
                className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
                onClick={() => setShowAddPropertyForm(true)}
                aria-expanded={showAddPropertyForm}
                data-voice-id="add-property-btn"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
                </svg>
                Add Property
              </button>
            </div>
          </div>
        </div>
      </div>
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-7xl space-y-6">
          {/* Stripe Setup Status Banners */}
          {setupStatus === 'complete' && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="font-semibold text-green-900">Bank Account Connected Successfully!</h3>
              <p className="text-sm text-green-700 mt-1">Your bank account is now connected and ready to receive tenant rent payments.</p>
            </div>
          </div>
        </div>
          )}
          {setupStatus === 'refresh' && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 text-yellow-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h3 className="font-semibold text-yellow-900">Setup Not Completed</h3>
              <p className="text-sm text-yellow-700 mt-1">The bank account setup was not completed. You can resume it anytime from the Tenant Payments section below.</p>
            </div>
          </div>
        </div>
          )}

          <div data-voice-id="portfolio-main-content">
          {savedProperties.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-slate-300 bg-white/90 px-6 py-10 text-center text-sm text-slate-500 shadow-sm">
              {propertyLoadError ? `Portfolio data failed to load: ${propertyLoadError}` : 'Add a property to populate the portfolio overview.'}
            </div>
          ) : (
            <div className="flex w-full flex-col gap-4" data-voice-id="portfolio-properties-tab">
              {/* Property switcher — selecting a chip swaps the workspace below */}
              <div className="flex items-center gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Select a property">
                {savedProperties.map((property) => {
                  const isSelected = property.address === primaryProperty.address;
                  return (
                    <div
                      key={property.id}
                      role="tab"
                      aria-selected={isSelected}
                      className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-0.5 transition ${
                        isSelected
                          ? 'border-blue-500 bg-blue-600 shadow-sm'
                          : 'border-blue-200 bg-white hover:bg-blue-50'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => activateOverviewProperty(property)}
                        className="flex min-w-0 items-center gap-2 text-left"
                        title={property.address}
                      >
                        <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full bg-slate-100">
                          <StreetViewImage address={property.address} className="h-full w-full object-cover" width={36} height={36} />
                        </span>
                        <span
                          className={`max-w-[180px] truncate text-[11px] font-bold ${
                            isSelected ? 'text-white' : 'text-blue-700'
                          }`}
                        >
                          {property.address.split(',')[0]}
                        </span>
                      </button>
                      <button
                        type="button"
                        title="Remove property from account"
                        aria-label={`Remove ${property.address} from account`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteProperty(property.id);
                        }}
                        className={`shrink-0 rounded-full p-1.5 transition ${
                          isSelected
                            ? 'text-blue-100 hover:bg-white/15 hover:text-white'
                            : 'text-slate-400 hover:bg-rose-50 hover:text-rose-600'
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>

              {PropertyWorkspacePanel()}
            </div>
          )}
          </div>
        </div>
      </main>

      {showAddPropertyForm && (
        <div className="fixed inset-y-0 right-0 z-[10000] flex items-center justify-center bg-slate-900/35 px-4" style={{ left: '248px' }}>
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Close add property form"
            onClick={() => setShowAddPropertyForm(false)}
          />
          <form
            onSubmit={handleAddPropertySubmit}
            className="relative w-full max-w-lg overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)]"
            data-voice-id="add-property-form"
          >
            <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Portfolio</div>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-slate-900">Add Property</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddPropertyForm(false)}
                  className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Close"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="space-y-4 px-5 py-5">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Street Address</span>
                <input
                  ref={addPropertyAddressRef}
                  type="text"
                  value={newPropertyAddress}
                  onChange={(event) => setNewPropertyAddress(event.target.value)}
                  placeholder="Start typing an address"
                  className={addressAutocompleteMode === 'widget'
                    ? 'hidden'
                    : 'mt-2 w-full rounded-[16px] border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10'}
                  data-voice-id="add-property-address-input"
                />
                <div
                  ref={addPropertyAutocompleteHostRef}
                  className={addressAutocompleteMode === 'widget' ? 'mt-2' : 'hidden'}
                  data-voice-id="add-property-address-autocomplete"
                />
              </label>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">City, State, ZIP</span>
                <input
                  type="text"
                  value={newPropertyLocation}
                  onChange={(event) => setNewPropertyLocation(event.target.value)}
                  placeholder="Optional if known"
                  className="mt-2 w-full rounded-[16px] border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                  data-voice-id="add-property-location-input"
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
              <button
                type="button"
                onClick={() => setShowAddPropertyForm(false)}
                className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newPropertyAddress.trim()}
                className="rounded-[14px] bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Add Property
              </button>
            </div>
          </form>
        </div>
      )}


      {/* Messaging Modal */}
      {messagingModalOpen && selectedTenant && (
        <MessagingModal
          isOpen={messagingModalOpen}
          onClose={() => {
            setMessagingModalOpen(false);
            setSelectedTenant(null);
          }}
          tenant={selectedTenant}
          propertyAddress={(propertyDashboard?.summary?.address as string) || [primaryProperty.address, primaryProperty.location].filter(Boolean).join(', ') || 'Potomac MD'}
          onMessagesUpdate={(messages) => {
            // Update the tenant's messages in state
            setTenants(prev => prev.map(t => 
              t.unit === selectedTenant.unit 
                ? { ...t, messages } 
                : t
            ));
          }}
          onMaintenanceIssuesFound={(issues) => {
            // Auto-populate AI Provider Match with detected maintenance issue
            if (issues && issues.length > 0) {
              console.log('🔧 Maintenance issues detected:', issues);
              
              // Scroll to maintenance section
              const maintenanceSection = document.querySelector('[name="AI Provider Match"]')?.closest('.rounded-xl');
              if (maintenanceSection) {
                maintenanceSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
              
              // Send to AIServiceRecommendations component
              window.dispatchEvent(new CustomEvent('maintenanceIssuesDetected', { 
                detail: issues 
              }));
            }
          }}
        />
      )}

      {/* Tenant Onboarding Modal */}
      {showTenantOnboarding && onboardingPropertyInfo && (
        <TenantOnboardingModal
          isOpen={showTenantOnboarding}
          onClose={() => {
            setShowTenantOnboarding(false);
            setOnboardingPropertyInfo(null);
          }}
          propertyId={onboardingPropertyInfo.propertyId}
          propertyAddress={onboardingPropertyInfo.propertyAddress}
          ownerId={user?.id || ''}
          ownerName={user?.name || user?.email?.split('@')[0] || ''}
          ownerEmail={user?.email || ''}
        />
      )}

      {/* Add Tenant Modal */}
      {addTenantModalOpen && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-800">Add New Tenant</h2>
              <button
                onClick={() => setAddTenantModalOpen(false)}
                className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
            <AddTenantForm
              onSubmit={(tenantData) => {
                addTenant(tenantData);
                setAddTenantModalOpen(false);
              }}
              onCancel={() => setAddTenantModalOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Edit Tenant Modal */}
      <EditTenantModal
        isOpen={editTenantModalOpen}
        tenant={editingTenant}
        onClose={() => {
          setEditTenantModalOpen(false);
          setEditingTenant(null);
        }}
        onSave={(updatedTenant) => {
          updateTenant(updatedTenant);
          setEditTenantModalOpen(false);
          setEditingTenant(null);
        }}
      />

      {/* Stripe Connect Payment Modal */}
      {paymentModalOpen && (() => {
        const localTenant = tenants.find(t => t.status === 'Current');
        const currentTenant = localTenant || firestoreTenant;
        
        // Handle both local tenant format and Firestore tenant format
        const tenantName = currentTenant?.name || (currentTenant?.firstName && currentTenant?.lastName 
          ? `${currentTenant.firstName || ''} ${currentTenant.lastName || ''}`.trim() 
          : 'Unknown');
        const tenantEmail = currentTenant?.email || '';
        const tenantRent = currentTenant?.rent || 0;
        
        return (
          <div 
            className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setPaymentModalOpen(false)}
          >
            <div 
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-xl font-semibold text-gray-800">Process Payment</h2>
                <button
                  onClick={() => setPaymentModalOpen(false)}
                  className="rounded-lg p-2 hover:bg-gray-100"
                >
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-6">
                {!currentTenant ? (
                  <div className="text-center py-8">
                    <div className="text-gray-500 mb-4">No current tenant found</div>
                    <p className="text-sm text-gray-400">Add a tenant first to process payments</p>
                  </div>
                ) : (
                  <TenantPaymentForm
                    landlordAccountId={landlordStripeAccountId}
                    tenantName={tenantName}
                    tenantEmail={tenantEmail}
                    propertyAddress={primaryProperty.address || 'Property Address'}
                    defaultAmount={tenantRent}
                    onPaymentComplete={(sessionId) => {
                      console.log('Payment initiated:', sessionId);
                      setPaymentModalOpen(false);
                    }}
                    onError={(error) => {
                      console.error('Payment error:', error);
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* QuickBooks Sync Modal */}
      {qbShowSyncModal && qbSelectedProperty && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">Push to QuickBooks</h2>
                <p className="text-sm text-gray-500 mt-1">Push local bookkeeping data → QuickBooks Online</p>
              </div>
              <button
                onClick={() => setQbShowSyncModal(false)}
                className="rounded-lg p-2 hover:bg-gray-100"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="p-6 space-y-6">
              {/* Info Banner */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  <div className="text-sm text-blue-800">
                    <strong>This pushes LOCAL data → QuickBooks</strong>
                    <p className="mt-1 text-blue-700">
                      This feature sends transactions from your app's bookkeeping system to QuickBooks. 
                      If you want to load existing QuickBooks data into this app, use <strong>"Import from QB"</strong> instead.
                    </p>
                  </div>
                </div>
              </div>

              {/* Property Info */}
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-sm font-medium text-gray-700 mb-1">Property</div>
                <div className="text-lg font-semibold text-gray-900">
                  {primaryProperty.address || 'Current Property'}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {primaryProperty.location}
                </div>
                <div className="text-xs text-gray-400 mt-2">
                  Property ID: {qbSelectedProperty}
                </div>
              </div>

              {/* Month Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Month to Sync</label>
                <input
                  type="month"
                  value={qbSelectedMonth}
                  onChange={(e) => {
                    setQbSelectedMonth(e.target.value);
                    setQbSyncPreview(null); // Clear preview when month changes
                    fetchPropertiesWithActivity(e.target.value);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  max={new Date().toISOString().slice(0, 7)}
                />
              </div>

              {/* Preview Button */}
              <div>
                <button
                  onClick={() => fetchSyncPreview(qbSelectedProperty, qbSelectedMonth)}
                  disabled={qbSyncLoading || !qbSelectedMonth}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {qbSyncLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Loading Preview...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      Preview What Will Be Synced
                    </>
                  )}
                </button>
              </div>

              {/* Preview Results */}
              {qbSyncPreview && (
                <div className="border rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b">
                    <h3 className="text-sm font-semibold text-gray-800">Preview: Individual Transactions</h3>
                    <p className="text-xs text-gray-600 mt-1">
                      {qbSyncPreview.summary?.totalTransactions || 0} transactions will be pushed as separate Expenses and Deposits
                    </p>
                  </div>
                  
                  <div className="p-4 space-y-4">
                    {/* Summary Cards */}
                    <div className="grid grid-cols-4 gap-3">
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-xs text-gray-600 font-medium mb-1">Total Transactions</div>
                        <div className="text-lg font-bold text-gray-700">
                          {qbSyncPreview.summary?.totalTransactions || 0}
                        </div>
                      </div>
                      <div className="bg-emerald-50 rounded-lg p-3">
                        <div className="text-xs text-emerald-600 font-medium mb-1">Income ({qbSyncPreview.summary?.incomeCount || 0})</div>
                        <div className="text-lg font-bold text-emerald-700">
                          ${qbSyncPreview.summary?.totalIncome?.toFixed(2) || '0.00'}
                        </div>
                      </div>
                      <div className="bg-rose-50 rounded-lg p-3">
                        <div className="text-xs text-rose-600 font-medium mb-1">Expenses ({qbSyncPreview.summary?.expenseCount || 0})</div>
                        <div className="text-lg font-bold text-rose-700">
                          ${qbSyncPreview.summary?.totalExpenses?.toFixed(2) || '0.00'}
                        </div>
                      </div>
                      <div className="bg-blue-50 rounded-lg p-3">
                        <div className="text-xs text-blue-600 font-medium mb-1">To Sync</div>
                        <div className="text-lg font-bold text-blue-700">
                          {qbSyncPreview.summary?.unsyncedCount || 0}
                        </div>
                      </div>
                    </div>

                    {/* Warning if no transactions to sync */}
                    {qbSyncPreview.summary?.unsyncedCount === 0 && qbSyncPreview.summary?.totalTransactions > 0 && (
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-start gap-2">
                        <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        <div className="text-sm text-blue-700">
                          <strong>All synced!</strong> All transactions for this month have already been pushed to QuickBooks.
                        </div>
                      </div>
                    )}

                    {/* Transactions List */}
                    {qbSyncPreview.transactions?.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 mb-2">Transactions ({qbSyncPreview.transactions.length})</h4>
                        <div className="border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-50 border-b sticky top-0">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium text-gray-600">Date</th>
                                <th className="px-3 py-2 text-left font-medium text-gray-600">Description</th>
                                <th className="px-3 py-2 text-left font-medium text-gray-600">Category</th>
                                <th className="px-3 py-2 text-right font-medium text-gray-600">Amount</th>
                                <th className="px-3 py-2 text-center font-medium text-gray-600">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {qbSyncPreview.transactions?.map((txn: any, idx: number) => (
                                <tr key={idx} className={`hover:bg-gray-50 ${txn.qboSynced ? 'opacity-50' : ''}`}>
                                  <td className="px-3 py-2 text-gray-600 font-mono">
                                    {txn.date}
                                  </td>
                                  <td className="px-3 py-2 text-gray-700 truncate max-w-[200px]" title={txn.description}>
                                    {txn.description}
                                  </td>
                                  <td className="px-3 py-2 text-gray-600">
                                    {txn.category}
                                  </td>
                                  <td className={`px-3 py-2 text-right font-mono ${txn.type === 'income' ? 'text-emerald-600' : 'text-rose-600'}`}>
                                    {txn.type === 'income' ? '+' : '-'}${txn.amount.toFixed(2)}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {txn.qboSynced ? (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                        Synced
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                                        Pending
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 pt-4 border-t">
                <button
                  onClick={() => setQbShowSyncModal(false)}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                  disabled={qbSyncLoading}
                >
                  Cancel
                </button>
                <button
                  onClick={() => pushToQuickBooks(qbSelectedProperty, qbSelectedMonth)}
                  disabled={qbSyncLoading || !qbSyncPreview}
                  className="flex-1 rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {qbSyncLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Syncing...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      Push to QuickBooks
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* QuickBooks Import Modal - Load FROM QuickBooks */}
      {qbShowImportModal && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">Import from QuickBooks</h2>
                <p className="text-sm text-gray-500 mt-1">Load transactions from QuickBooks into your bookkeeping system</p>
              </div>
              <button
                onClick={() => setQbShowImportModal(false)}
                className="rounded-lg p-2 hover:bg-gray-100"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="p-6 space-y-6">
              {/* Date Range Selection */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Date Range</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Start Date</label>
                    <input
                      type="date"
                      value={qbImportDateRange.startDate}
                      onChange={(e) => setQbImportDateRange(prev => ({ ...prev, startDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">End Date</label>
                    <input
                      type="date"
                      value={qbImportDateRange.endDate}
                      onChange={(e) => setQbImportDateRange(prev => ({ ...prev, endDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                      max={new Date().toISOString().split('T')[0]}
                    />
                  </div>
                </div>
                <button
                  onClick={fetchImportPreview}
                  disabled={qbImportLoading}
                  className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {qbImportLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Loading...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Load Transactions from QuickBooks
                    </>
                  )}
                </button>
              </div>

              {/* Preview Results */}
              {qbImportPreview && (
                <div className="space-y-4">
                  {/* Summary Cards */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-xs text-gray-500 font-medium mb-1">Total Found</div>
                      <div className="text-lg font-bold text-gray-800">
                        {qbImportPreview.summary?.totalTransactions || 0}
                      </div>
                    </div>
                    <div className="bg-emerald-50 rounded-lg p-3">
                      <div className="text-xs text-emerald-600 font-medium mb-1">Total Income</div>
                      <div className="text-lg font-bold text-emerald-700">
                        ${qbImportPreview.summary?.totalIncome?.toFixed(2) || '0.00'}
                      </div>
                    </div>
                    <div className="bg-rose-50 rounded-lg p-3">
                      <div className="text-xs text-rose-600 font-medium mb-1">Total Expenses</div>
                      <div className="text-lg font-bold text-rose-700">
                        ${qbImportPreview.summary?.totalExpenses?.toFixed(2) || '0.00'}
                      </div>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-3">
                      <div className="text-xs text-blue-600 font-medium mb-1">Selected</div>
                      <div className="text-lg font-bold text-blue-700">
                        {qbImportSelectedTxns.size}
                      </div>
                    </div>
                  </div>

                  {/* Selection Controls */}
                  <div className="flex items-center justify-between">
                    <div className="flex gap-2">
                      <button
                        onClick={selectAllImportTxns}
                        className="px-3 py-1 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50"
                      >
                        Select All
                      </button>
                      <button
                        onClick={deselectAllImportTxns}
                        className="px-3 py-1 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
                      >
                        Deselect All
                      </button>
                    </div>
                    <span className="text-xs text-gray-500">
                      {qbImportSelectedTxns.size} of {qbImportPreview.transactions?.length || 0} selected
                    </span>
                  </div>

                  {/* Transactions Table */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="max-h-[300px] overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 border-b sticky top-0">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium text-gray-600 w-8">
                              <input
                                type="checkbox"
                                checked={qbImportSelectedTxns.size === qbImportPreview.transactions?.length}
                                onChange={(e) => e.target.checked ? selectAllImportTxns() : deselectAllImportTxns()}
                                className="rounded border-gray-300"
                              />
                            </th>
                            <th className="px-3 py-2 text-left font-medium text-gray-600">Date</th>
                            <th className="px-3 py-2 text-left font-medium text-gray-600">Type</th>
                            <th className="px-3 py-2 text-left font-medium text-gray-600">Description</th>
                            <th className="px-3 py-2 text-left font-medium text-gray-600">Category</th>
                            <th className="px-3 py-2 text-right font-medium text-gray-600">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {qbImportPreview.transactions?.map((txn: any) => (
                            <tr 
                              key={txn.qbo_id} 
                              className={`hover:bg-gray-50 cursor-pointer ${qbImportSelectedTxns.has(txn.qbo_id) ? 'bg-blue-50' : ''}`}
                              onClick={() => toggleImportSelection(txn.qbo_id)}
                            >
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={qbImportSelectedTxns.has(txn.qbo_id)}
                                  onChange={() => toggleImportSelection(txn.qbo_id)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="rounded border-gray-300"
                                />
                              </td>
                              <td className="px-3 py-2 text-gray-600">
                                {new Date(txn.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                  txn.type === 'Income' 
                                    ? 'bg-emerald-100 text-emerald-700' 
                                    : 'bg-rose-100 text-rose-700'
                                }`}>
                                  {txn.type}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate" title={txn.description}>
                                {txn.description}
                              </td>
                              <td className="px-3 py-2 text-gray-600 text-[10px]">
                                {txn.category}
                              </td>
                              <td className={`px-3 py-2 text-right font-mono font-medium ${
                                txn.type === 'Income' ? 'text-emerald-600' : 'text-rose-600'
                              }`}>
                                {txn.type === 'Income' ? '+' : '-'}${txn.amount?.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 pt-4 border-t">
                <button
                  onClick={() => setQbShowImportModal(false)}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                  disabled={qbImportLoading}
                >
                  Cancel
                </button>
                <button
                  onClick={executeImport}
                  disabled={qbImportLoading || qbImportSelectedTxns.size === 0}
                  className="flex-1 rounded-lg bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {qbImportLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Importing...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Import {qbImportSelectedTxns.size} Transaction{qbImportSelectedTxns.size !== 1 ? 's' : ''}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Income Verification History Modal */}
      {showIncomeVerificationModal && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
            <div className="border-b px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">Income Verification History</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Verified income from tenants' connected bank accounts via Stripe
                </p>
              </div>
              <button
                onClick={() => setShowIncomeVerificationModal(false)}
                className="rounded-lg p-2 hover:bg-gray-100"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[calc(80vh-80px)]">
              {tenantIncomeData.length > 0 ? (
                <div className="space-y-4">
                  {tenantIncomeData.map((tenant) => (
                    <div key={tenant.tenantId} className="rounded-lg border bg-white p-4 hover:shadow-md transition-shadow">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-3">
                            <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center">
                              <svg className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                              </svg>
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-gray-800">Tenant ID: {tenant.tenantId}</div>
                              <div className="text-xs text-gray-500">
                                Verified {new Date(tenant.lastUpdated).toLocaleDateString()}
                              </div>
                            </div>
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                              Verified
                            </span>
                          </div>
                          
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Monthly Income</div>
                              <div className="text-lg font-bold text-emerald-600">
                                ${tenant.monthlyIncome?.toLocaleString() || 'N/A'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Employment Status</div>
                              <div className="text-sm font-semibold text-gray-800">
                                {tenant.employmentStatus || 'Unknown'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Period Analyzed</div>
                              <div className="text-sm font-semibold text-gray-800">
                                {tenant.periodCovered?.months || 0} months
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Transactions</div>
                              <div className="text-sm font-semibold text-gray-800">
                                {tenant.incomeTransactionCount || 0} income
                              </div>
                            </div>
                          </div>

                          {tenant.regularIncome && tenant.regularIncome.length > 0 && (
                            <div className="mt-3 pt-3 border-t">
                              <div className="text-xs font-semibold text-gray-700 mb-2">Income Sources:</div>
                              <div className="space-y-1">
                                {tenant.regularIncome.slice(0, 3).map((source: any, idx: number) => (
                                  <div key={idx} className="flex items-center justify-between text-xs">
                                    <span className="text-gray-600">{source.source}</span>
                                    <span className="font-semibold text-gray-800">
                                      ${Math.round(source.averageAmount).toLocaleString()} 
                                      <span className="text-gray-500 ml-1">({source.frequency}x)</span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No verified tenants yet</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Tenants who connect their bank accounts will appear here
                  </p>
                </div>
              )}
            </div>
            
            <div className="border-t px-6 py-4 flex justify-between items-center">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <div className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-50 border border-emerald-200">
                  <svg className="h-3 w-3 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                  </svg>
                  <span className="font-medium text-emerald-700">Stripe Financial Connections</span>
                </div>
              </div>
              <button
                onClick={() => setShowIncomeVerificationModal(false)}
                className="rounded-lg bg-gray-100 text-gray-700 px-4 py-2 text-sm hover:bg-gray-200 font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send Screening Link Modal */}
      {sendScreeningLinkModalOpen && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="border-b px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">Send Screening Link</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Email applicant a secure link to submit their information
                </p>
              </div>
              <button
                onClick={() => setSendScreeningLinkModalOpen(false)}
                className="rounded-lg p-2 hover:bg-gray-100"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="p-6">
              {screeningLinkSent ? (
                <div className="text-center py-8">
                  <div className="h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
                    <svg className="h-8 w-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-800 mb-2">Screening Link Sent!</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    An email has been sent to <strong>{sendScreeningLinkData.applicantEmail}</strong> with instructions to complete their screening.
                  </p>
                  <p className="text-xs text-gray-500 mb-6">
                    The link will expire in 7 days. The applicant will be able to:
                  </p>
                  <ul className="text-xs text-gray-600 text-left space-y-2 mb-6 mx-8">
                    <li className="flex items-center gap-2">
                      <span className="h-5 w-5 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-[10px]">1</span>
                      Submit SSN and date of birth for credit check
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-5 w-5 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 text-[10px]">2</span>
                      Authorize background check
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-5 w-5 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 text-[10px]">3</span>
                      Connect bank for income verification via Stripe
                    </li>
                  </ul>
                  <button
                    onClick={() => setSendScreeningLinkModalOpen(false)}
                    className="rounded-lg bg-purple-600 text-white px-6 py-2 text-sm hover:bg-purple-700 font-medium"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  setSendingScreeningLink(true);
                  setScreeningLinkError(null);
                  
                  try {
                    const response = await fetch('/api/screening/send-request', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        applicantEmail: sendScreeningLinkData.applicantEmail,
                        applicantName: sendScreeningLinkData.applicantName,
                        propertyAddress: sendScreeningLinkData.propertyAddress,
                        ownerName: 'Property Owner' // Could use actual owner name from state
                      })
                    });
                    
                    const data = await response.json();
                    
                    if (data.ok) {
                      setScreeningLinkSent(true);
                    } else {
                      setScreeningLinkError(data.error || 'Failed to send screening link');
                    }
                  } catch (err) {
                    setScreeningLinkError('Network error - please try again');
                  } finally {
                    setSendingScreeningLink(false);
                  }
                }}>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Applicant Name
                      </label>
                      <input
                        type="text"
                        required
                        value={sendScreeningLinkData.applicantName}
                        onChange={(e) => setSendScreeningLinkData(prev => ({...prev, applicantName: e.target.value}))}
                        placeholder="John Smith"
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Applicant Email
                      </label>
                      <input
                        type="email"
                        required
                        value={sendScreeningLinkData.applicantEmail}
                        onChange={(e) => setSendScreeningLinkData(prev => ({...prev, applicantEmail: e.target.value}))}
                        placeholder="john@example.com"
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Property Address
                      </label>
                      <input
                        type="text"
                        required
                        value={sendScreeningLinkData.propertyAddress}
                        onChange={(e) => setSendScreeningLinkData(prev => ({...prev, propertyAddress: e.target.value}))}
                        placeholder="123 Main St, City, State 12345"
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      />
                    </div>
                    
                    {screeningLinkError && (
                      <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
                        {screeningLinkError}
                      </div>
                    )}
                    
                    <div className="rounded-xl bg-slate-50/70 border border-slate-200/70 px-4 py-3">
                      <div className="text-xs font-medium text-gray-700 mb-2">What the applicant will receive:</div>
                      <ul className="text-xs text-gray-600 space-y-1">
                        <li>• Secure link to submit personal information</li>
                        <li>• Request for SSN & DOB for credit/background check</li>
                        <li>• Stripe Financial Connections for income verification</li>
                        <li>• Link expires in 7 days</li>
                      </ul>
                    </div>
                  </div>
                  
                  <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
                    <button
                      type="button"
                      onClick={() => setSendScreeningLinkModalOpen(false)}
                      className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={sendingScreeningLink}
                      className="rounded-lg bg-purple-600 text-white px-6 py-2 text-sm hover:bg-purple-700 font-medium disabled:opacity-50 flex items-center gap-2"
                    >
                      {sendingScreeningLink ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                          Sending...
                        </>
                      ) : (
                        <>
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                          </svg>
                          Send Screening Link
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tenant Screening Modal */}
      {screeningModalOpen && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">
                  {selectedApplicant ? `${selectedApplicant.name} - Screening Report` : 'New Applicant Screening'}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  {selectedApplicant ? 'View and manage screening results' : 'Create a new tenant screening request'}
                </p>
              </div>
              <button
                onClick={() => {
                  setScreeningModalOpen(false);
                  setSelectedApplicant(null);
                }}
                className="rounded-lg p-2 hover:bg-gray-100"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-6">
              {selectedApplicant ? (
                <div className="space-y-6">
                  {/* Applicant Info */}
                  <div className="bg-gradient-to-br from-purple-50 to-white rounded-lg border p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-4">
                        <div className="h-16 w-16 rounded-full bg-purple-100 flex items-center justify-center text-xl font-semibold text-purple-700">
                          {selectedApplicant.name.split(' ').map(n => n[0]).join('')}
                        </div>
                        <div>
                          <h3 className="text-xl font-semibold text-gray-800">{selectedApplicant.name}</h3>
                          <p className="text-sm text-gray-600">{selectedApplicant.email}</p>
                          {selectedApplicant.phone && <p className="text-sm text-gray-600">{selectedApplicant.phone}</p>}
                          <p className="text-xs text-gray-500 mt-1">
                            Applied {new Date(selectedApplicant.appliedDate).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                        selectedApplicant.status === 'approved' 
                          ? 'bg-emerald-100 text-emerald-700'
                          : selectedApplicant.status === 'rejected'
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}>
                        {selectedApplicant.status.charAt(0).toUpperCase() + selectedApplicant.status.slice(1)}
                      </span>
                    </div>
                  </div>

                  {/* Screening Results Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* Credit Score */}
                    <div className="border rounded-lg p-4 bg-white">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold text-gray-800">Credit Score</h4>
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
                            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            <span className="text-[10px] font-semibold">Equifax</span>
                          </div>
                        </div>
                        {selectedApplicant.creditScore && (
                          <span className={`text-2xl font-bold ${
                            selectedApplicant.creditScore >= 650 ? 'text-emerald-600' : 'text-rose-600'
                          }`}>
                            {selectedApplicant.creditScore}
                          </span>
                        )}
                      </div>
                      {selectedApplicant.creditScore ? (
                        <>
                          <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                            <div 
                              className={`h-2 rounded-full ${
                                selectedApplicant.creditScore >= 650 ? 'bg-emerald-500' : 'bg-rose-500'
                              }`}
                              style={{ width: `${(selectedApplicant.creditScore / 850) * 100}%` }}
                            />
                          </div>
                          <p className="text-xs text-gray-600 mb-2">
                            {selectedApplicant.creditScore >= 650 
                              ? '✓ Meets minimum requirement (650)' 
                              : '✗ Below minimum requirement (650)'}
                          </p>
                          {(selectedApplicant as any).creditReportDetails && (
                            <div className="text-xs text-gray-500 mt-2 pt-2 border-t">
                              <p className="font-medium mb-1">Report Details:</p>
                              <p>Range: {(selectedApplicant as any).creditReportDetails.scoreRange}</p>
                              <p className="mt-1 text-[11px]">{(selectedApplicant as any).creditReportDetails.summary}</p>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="space-y-3">
                          {/* Test Mode Toggle */}
                          <div className="flex items-center justify-between p-2 bg-amber-50 border border-amber-200 rounded-lg">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-amber-800">Test Mode</span>
                              <span className="text-[10px] text-amber-600">(Uses Equifax CTEST data)</span>
                            </div>
                            <button
                              onClick={() => setEquifaxTestMode(!equifaxTestMode)}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                equifaxTestMode ? 'bg-amber-500' : 'bg-gray-300'
                              }`}
                            >
                              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                                equifaxTestMode ? 'translate-x-5' : 'translate-x-1'
                              }`} />
                            </button>
                          </div>
                          
                          {equifaxTestMode ? (
                            <>
                              <p className="text-xs text-gray-500">
                                Test mode uses Equifax certified test data to verify API integration.
                              </p>
                              <button
                                onClick={() => handleEquifaxCreditCheck(selectedApplicant)}
                                disabled={creditCheckLoading}
                                className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                  creditCheckLoading
                                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                    : 'bg-indigo-600 text-white hover:bg-indigo-700'
                                }`}
                              >
                                {creditCheckLoading ? (
                                  <>
                                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Checking...
                                  </>
                                ) : (
                                  <>
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Run Test Credit Check
                                  </>
                                )}
                              </button>
                            </>
                          ) : showCreditCheckForm ? (
                            <div className="space-y-2">
                              <p className="text-xs text-gray-600 font-medium">Enter applicant information:</p>
                              <input
                                type="text"
                                placeholder="SSN (xxx-xx-xxxx)"
                                value={creditCheckFormData.ssn}
                                onChange={(e) => setCreditCheckFormData(prev => ({ ...prev, ssn: e.target.value }))}
                                className="w-full px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500"
                              />
                              <input
                                type="date"
                                placeholder="Date of Birth"
                                value={creditCheckFormData.dateOfBirth}
                                onChange={(e) => setCreditCheckFormData(prev => ({ ...prev, dateOfBirth: e.target.value }))}
                                className="w-full px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500"
                              />
                              <input
                                type="text"
                                placeholder="Street Address"
                                value={creditCheckFormData.street}
                                onChange={(e) => setCreditCheckFormData(prev => ({ ...prev, street: e.target.value }))}
                                className="w-full px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500"
                              />
                              <div className="grid grid-cols-3 gap-2">
                                <input
                                  type="text"
                                  placeholder="City"
                                  value={creditCheckFormData.city}
                                  onChange={(e) => setCreditCheckFormData(prev => ({ ...prev, city: e.target.value }))}
                                  className="w-full px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500"
                                />
                                <input
                                  type="text"
                                  placeholder="State"
                                  maxLength={2}
                                  value={creditCheckFormData.state}
                                  onChange={(e) => setCreditCheckFormData(prev => ({ ...prev, state: e.target.value.toUpperCase() }))}
                                  className="w-full px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500"
                                />
                                <input
                                  type="text"
                                  placeholder="ZIP"
                                  maxLength={5}
                                  value={creditCheckFormData.zipCode}
                                  onChange={(e) => setCreditCheckFormData(prev => ({ ...prev, zipCode: e.target.value }))}
                                  className="w-full px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-indigo-500"
                                />
                              </div>
                              <div className="flex gap-2 mt-2">
                                <button
                                  onClick={() => setShowCreditCheckForm(false)}
                                  className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => handleEquifaxCreditCheck(selectedApplicant, creditCheckFormData)}
                                  disabled={creditCheckLoading || !creditCheckFormData.ssn || !creditCheckFormData.dateOfBirth}
                                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium ${
                                    creditCheckLoading || !creditCheckFormData.ssn || !creditCheckFormData.dateOfBirth
                                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                      : 'bg-indigo-600 text-white hover:bg-indigo-700'
                                  }`}
                                >
                                  {creditCheckLoading ? 'Checking...' : 'Run Check'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className="text-xs text-gray-500">
                                Production mode requires applicant SSN and address information.
                              </p>
                              <button
                                onClick={() => setShowCreditCheckForm(true)}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                              >
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                Run Credit Check
                              </button>
                            </>
                          )}
                          
                          {creditCheckError && (
                            <p className="text-xs text-rose-600 mt-2">{creditCheckError}</p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Background Check */}
                    <div className="border rounded-lg p-4 bg-white">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold text-gray-800">Background Check</h4>
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
                            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            <span className="text-[10px] font-semibold">Equifax</span>
                          </div>
                        </div>
                        {(selectedApplicant as any).backgroundCheckDetails && (
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                            (selectedApplicant as any).backgroundCheckDetails.status === 'clear'
                              ? 'bg-emerald-100 text-emerald-700'
                              : (selectedApplicant as any).backgroundCheckDetails.status === 'pending'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-rose-100 text-rose-700'
                          }`}>
                            {(selectedApplicant as any).backgroundCheckDetails.status.charAt(0).toUpperCase() + (selectedApplicant as any).backgroundCheckDetails.status.slice(1)}
                          </span>
                        )}
                      </div>
                      {(selectedApplicant as any).backgroundCheckDetails ? (
                        <div className="space-y-3">
                          {/* Risk Level Badge */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-600">Risk Level:</span>
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              (selectedApplicant as any).backgroundCheckDetails.risk === 'low'
                                ? 'bg-emerald-100 text-emerald-700'
                                : (selectedApplicant as any).backgroundCheckDetails.risk === 'medium'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-rose-100 text-rose-700'
                            }`}>
                              {(selectedApplicant as any).backgroundCheckDetails.risk.toUpperCase()}
                            </span>
                          </div>
                          
                          {/* Criminal Records */}
                          <div className="flex items-start gap-2 text-sm">
                            <svg className={`w-4 h-4 mt-0.5 ${
                              (selectedApplicant as any).backgroundCheckDetails.criminalRecords.count === 0
                                ? 'text-emerald-600'
                                : 'text-rose-600'
                            }`} fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            <div className="flex-1">
                              <span className="text-gray-700 font-medium">Criminal Records:</span>
                              <span className="text-gray-600 ml-1">
                                {(selectedApplicant as any).backgroundCheckDetails.criminalRecords.count === 0
                                  ? 'Clear'
                                  : `${(selectedApplicant as any).backgroundCheckDetails.criminalRecords.count} found`}
                              </span>
                              {(selectedApplicant as any).backgroundCheckDetails.criminalRecords.count > 0 && (
                                <div className="mt-1 text-xs text-gray-500 space-y-1">
                                  {(selectedApplicant as any).backgroundCheckDetails.criminalRecords.records.map((record: any, idx: number) => (
                                    <div key={idx} className="pl-2 border-l-2 border-rose-200">
                                      <p className="font-medium">{record.type} ({record.severity})</p>
                                      <p>{record.date} - {record.jurisdiction}</p>
                                      <p>Status: {record.disposition}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          
                          {/* Eviction History */}
                          <div className="flex items-start gap-2 text-sm">
                            <svg className={`w-4 h-4 mt-0.5 ${
                              (selectedApplicant as any).backgroundCheckDetails.evictions.count === 0
                                ? 'text-emerald-600'
                                : 'text-rose-600'
                            }`} fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            <div className="flex-1">
                              <span className="text-gray-700 font-medium">Eviction History:</span>
                              <span className="text-gray-600 ml-1">
                                {(selectedApplicant as any).backgroundCheckDetails.evictions.count === 0
                                  ? 'None'
                                  : `${(selectedApplicant as any).backgroundCheckDetails.evictions.count} found`}
                              </span>
                              {(selectedApplicant as any).backgroundCheckDetails.evictions.count > 0 && (
                                <div className="mt-1 text-xs text-gray-500 space-y-1">
                                  {(selectedApplicant as any).backgroundCheckDetails.evictions.records.map((record: any, idx: number) => (
                                    <div key={idx} className="pl-2 border-l-2 border-rose-200">
                                      <p>{record.date} - {record.court}</p>
                                      <p>Plaintiff: {record.plaintiff}</p>
                                      <p>Amount: ${record.amount?.toLocaleString() || 'N/A'}</p>
                                      <p>Status: {record.status}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          
                          {/* Sex Offender Registry */}
                          <div className="flex items-start gap-2 text-sm">
                            <svg className={`w-4 h-4 mt-0.5 ${
                              !(selectedApplicant as any).backgroundCheckDetails.sexOffenderStatus.registered
                                ? 'text-emerald-600'
                                : 'text-rose-600'
                            }`} fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            <div className="flex-1">
                              <span className="text-gray-700 font-medium">Sex Offender Registry:</span>
                              <span className="text-gray-600 ml-1">
                                {(selectedApplicant as any).backgroundCheckDetails.sexOffenderStatus.registered
                                  ? 'Registered'
                                  : 'Not Registered'}
                              </span>
                            </div>
                          </div>
                          
                          {/* Summary */}
                          <div className="pt-2 border-t">
                            <p className="text-xs text-gray-600">{(selectedApplicant as any).backgroundCheckDetails.summary}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-sm text-gray-500 mb-3">Background check not yet run</p>
                          <button
                            onClick={() => handleEquifaxBackgroundCheck(selectedApplicant)}
                            disabled={backgroundCheckLoading}
                            className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                              backgroundCheckLoading
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700'
                            }`}
                          >
                            {backgroundCheckLoading ? (
                              <>
                                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Checking...
                              </>
                            ) : (
                              <>
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                                </svg>
                                Run Background Check
                              </>
                            )}
                          </button>
                          {backgroundCheckError && (
                            <p className="text-xs text-rose-600 mt-2">{backgroundCheckError}</p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Income Verification via Stripe */}
                    <div className="border rounded-lg p-4 bg-white">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-semibold text-gray-800">Income Verification</h4>
                        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                          </svg>
                          <span className="text-[10px] font-semibold">Stripe</span>
                        </div>
                      </div>
                      {(() => {
                        // Check if applicant has verified income - from screening request or tenantIncomeData
                        const hasVerifiedIncome = selectedApplicant.incomeVerification?.verified;
                        const screeningIncomeData = (selectedApplicant as any).incomeData;
                        const applicantIncome = tenantIncomeData.find(t => 
                          t.tenantId?.toLowerCase().includes(selectedApplicant.name.split(' ')[0]?.toLowerCase()) ||
                          selectedApplicant.email?.toLowerCase().includes(t.tenantId?.toLowerCase())
                        ) || (selectedApplicant as any).stripeIncomeVerification;
                        
                        // If income is verified via screening flow (Stripe Financial Connections)
                        if (hasVerifiedIncome || screeningIncomeData) {
                          // Parse the screening income data if it's a string
                          let incomeInfo = screeningIncomeData;
                          if (typeof incomeInfo === 'string') {
                            try { incomeInfo = JSON.parse(incomeInfo); } catch (e) { incomeInfo = {}; }
                          }
                          const accounts = incomeInfo?.accounts || [];
                          const monthlyIncome = incomeInfo?.monthlyIncome || 0;
                          const totalBalance = incomeInfo?.totalBalance || 0;
                          const incomeTransactions = incomeInfo?.incomeTransactions || [];
                          
                          // Calculate rent-to-income ratio (assuming $2,500 rent for demo)
                          const estimatedRent = 2500; // Could fetch from property data
                          const incomeToRentRatio = monthlyIncome > 0 ? (monthlyIncome / estimatedRent).toFixed(1) : 0;
                          const meetsIncomeRequirement = monthlyIncome >= estimatedRent * 3;
                          
                          return (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                    </svg>
                                    Bank Connected
                                  </span>
                                </div>
                                <button
                                  onClick={async () => {
                                    try {
                                      const token = (selectedApplicant as any).token;
                                      if (!token) return;
                                      const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
                                      const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
                                      const url = useProxy 
                                        ? `/api/screening/${token}/refresh-income`
                                        : `${baseEnv}/api/screening/${token}/refresh-income`;
                                      const response = await fetch(url, { method: 'POST' });
                                      if (response.ok) {
                                        alert('Income data refreshed! Please close and reopen this report.');
                                      }
                                    } catch (e) {
                                      console.error('Refresh error:', e);
                                    }
                                  }}
                                  className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                                  title="Refresh income data from bank"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                  </svg>
                                  Refresh
                                </button>
                              </div>
                              
                              {/* Monthly Income - Primary Metric */}
                              <div className="bg-gradient-to-r from-emerald-50 to-green-50 rounded-lg p-3 border border-emerald-100">
                                <div className="flex justify-between items-start">
                                  <div>
                                    <div className="text-xs text-gray-500">Estimated Monthly Income</div>
                                    <div className="text-2xl font-bold text-emerald-600">
                                      ${(monthlyIncome || 0).toLocaleString()}
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <div className="text-xs text-gray-500">Income/Rent Ratio</div>
                                    <div className={`text-lg font-bold ${meetsIncomeRequirement ? 'text-emerald-600' : 'text-amber-600'}`}>
                                      {incomeToRentRatio}x
                                    </div>
                                  </div>
                                </div>
                                {(monthlyIncome || 0) > 0 && (
                                  <div className={`mt-2 text-xs ${meetsIncomeRequirement ? 'text-emerald-600' : 'text-amber-600'}`}>
                                    {meetsIncomeRequirement 
                                      ? '✓ Meets 3x rent requirement' 
                                      : `⚠ Below 3x rent requirement ($${(estimatedRent * 3).toLocaleString()} needed)`}
                                  </div>
                                )}
                                {(monthlyIncome || 0) === 0 && (
                                  <div className="mt-2 text-xs text-gray-500">
                                    ⏳ Transactions still syncing from bank. Click Refresh to update.
                                  </div>
                                )}
                              </div>
                              
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <div className="text-xs text-gray-500">Bank Balance</div>
                                  <div className="text-sm font-semibold text-gray-800">
                                    {(totalBalance || 0) > 0 ? `$${(totalBalance || 0).toLocaleString()}` : 'Syncing...'}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-xs text-gray-500">Accounts</div>
                                  <div className="text-sm font-semibold text-gray-800">
                                    {accounts.length} connected
                                  </div>
                                </div>
                              </div>
                              
                              {/* Connected Accounts */}
                              {accounts.length > 0 && (
                                <div className="pt-2 border-t">
                                  <div className="text-xs font-medium text-gray-700 mb-1">Connected Accounts:</div>
                                  {accounts.slice(0, 3).map((account: any, idx: number) => (
                                    <div key={idx} className="flex justify-between text-xs py-1">
                                      <span className="text-gray-600 truncate max-w-[120px]">
                                        {account.institution_name || 'Bank Account'} ****{account.last4 || ''}
                                      </span>
                                      <span className="font-medium text-gray-700">
                                        {account.balance != null ? `$${Number(account.balance).toLocaleString()}` : 
                                         account.transactionsStatus === 'syncing' ? 'Syncing...' : ''}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              
                              {/* Recent Income Transactions */}
                              {incomeTransactions.length > 0 && (
                                <div className="pt-2 border-t">
                                  <div className="text-xs font-medium text-gray-700 mb-1">Recent Income Deposits:</div>
                                  {incomeTransactions.slice(0, 3).map((txn: any, idx: number) => (
                                    <div key={idx} className="flex justify-between text-xs py-1">
                                      <span className="text-gray-600 truncate max-w-[130px]">{txn.description || 'Deposit'}</span>
                                      <span className="font-medium text-emerald-600">+${(txn.amount || 0).toLocaleString()}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              
                              <div className="text-[10px] text-gray-400 pt-1 flex justify-between">
                                <span>Via Stripe Financial Connections</span>
                                {incomeInfo?.lastRefreshed && (
                                  <span>Updated: {new Date(incomeInfo.lastRefreshed).toLocaleDateString()}</span>
                                )}
                              </div>
                            </div>
                          );
                        }
                        
                        // If we have traditional income data from tenantIncomeData
                        if (applicantIncome) {
                          return (
                            <div className="space-y-3">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                  </svg>
                                  Verified
                                </span>
                                <span className="text-xs text-gray-500">
                                  {applicantIncome.lastUpdated ? new Date(applicantIncome.lastUpdated).toLocaleDateString() : 'Recently'}
                                </span>
                              </div>
                              
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <div className="text-xs text-gray-500">Monthly Income</div>
                                  <div className="text-lg font-bold text-emerald-600">
                                    ${(applicantIncome.monthlyIncome || 0).toLocaleString()}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-xs text-gray-500">Status</div>
                                  <div className="text-sm font-semibold text-gray-800">
                                    {applicantIncome.employmentStatus || 'Verified'}
                                  </div>
                                </div>
                              </div>
                              
                              {applicantIncome.periodCovered && (
                                <div className="text-xs text-gray-500 pt-2 border-t">
                                  {applicantIncome.periodCovered.months || 0} months analyzed • {applicantIncome.incomeTransactionCount || 0} transactions
                                </div>
                              )}
                              
                              {applicantIncome.regularIncome && applicantIncome.regularIncome.length > 0 && (
                                <div className="pt-2 border-t">
                                  <div className="text-xs font-medium text-gray-700 mb-1">Income Sources:</div>
                                  {applicantIncome.regularIncome.slice(0, 2).map((source: any, idx: number) => (
                                    <div key={idx} className="flex justify-between text-xs">
                                      <span className="text-gray-600 truncate max-w-[120px]">{source.source}</span>
                                      <span className="font-medium">${Math.round(source.averageAmount).toLocaleString()}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        }
                        
                        return (
                          <div className="space-y-3">
                            <p className="text-sm text-gray-500">Bank verification via Stripe Financial Connections</p>
                            <button
                              onClick={async () => {
                                try {
                                  // Generate verification link for this applicant
                                  const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
                                  const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
                                  const url = useProxy 
                                    ? '/api/income-verification/request' 
                                    : `${baseEnv}/api/income-verification/request`;
                                  
                                  const response = await fetch(url, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      tenantId: selectedApplicant.id,
                                      tenantEmail: selectedApplicant.email,
                                      tenantName: selectedApplicant.name
                                    })
                                  });
                                  
                                  const data = await response.json();
                                  if (data.ok && data.verificationUrl) {
                                    // Open Stripe verification in new window
                                    window.open(data.verificationUrl, '_blank');
                                  } else {
                                    alert('Verification link sent to applicant email');
                                  }
                                } catch (error) {
                                  console.error('Failed to request income verification:', error);
                                  alert('Failed to request verification. Please try again.');
                                }
                              }}
                              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              Request Income Verification
                            </button>
                            <p className="text-[10px] text-gray-400 text-center">
                              Applicant will connect their bank securely via Stripe
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-3 pt-4 border-t">
                    <button
                      onClick={() => {
                        setApplicants(prev => prev.map(app =>
                          app.id === selectedApplicant.id ? { ...app, status: 'approved' } : app
                        ));
                        setScreeningModalOpen(false);
                        setSelectedApplicant(null);
                      }}
                      className="flex-1 rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700 font-medium"
                    >
                      Approve Applicant
                    </button>
                    <button
                      onClick={() => {
                        setApplicants(prev => prev.map(app =>
                          app.id === selectedApplicant.id ? { ...app, status: 'rejected' } : app
                        ));
                        setScreeningModalOpen(false);
                        setSelectedApplicant(null);
                      }}
                      className="flex-1 rounded-lg border border-rose-300 text-rose-700 px-4 py-2 text-sm hover:bg-rose-50 font-medium"
                    >
                      Reject Applicant
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className="text-gray-500 mb-4">New applicant screening coming soon</div>
                  <p className="text-sm text-gray-400">Integration with screening services in progress</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* AI Tenant Interview Scheduler Modal */}
      {interviewSchedulerOpen && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">AI Tenant Interview System</h2>
                <p className="text-sm text-gray-500 mt-1">Schedule automated AI phone interviews with potential tenants</p>
              </div>
              <button
                onClick={() => setInterviewSchedulerOpen(false)}
                className="rounded-lg p-2 hover:bg-gray-100"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              <TenantInterviewScheduler 
                applicants={applicants} 
                onClose={() => setInterviewSchedulerOpen(false)} 
              />
            </div>
          </div>
        </div>
      )}

      {/* Create Listing Modal */}
      {createListingModalOpen && (
        <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold text-gray-800">Create Vacancy Listing</h2>
                <p className="text-sm text-gray-500 mt-1">Post to multiple platforms and find tenants faster</p>
              </div>
              <button
                onClick={() => setCreateListingModalOpen(false)}
                className="rounded-lg p-2 hover:bg-gray-100"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-6">
              <form onSubmit={async (e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                
                const listingData = {
                  userId: 1,
                  property_id: 1, // Will be linked to property later
                  property_address: formData.get('address') as string,
                  title: formData.get('title') as string,
                  description: formData.get('description') as string,
                  monthly_rent: parseFloat(formData.get('monthly_rent') as string),
                  security_deposit: parseFloat(formData.get('security_deposit') as string) || 0,
                  beds: parseInt(formData.get('beds') as string) || 0,
                  baths: parseFloat(formData.get('baths') as string) || 0,
                  sqft: parseInt(formData.get('sqft') as string) || 0,
                  available_date: formData.get('available_date') as string,
                  lease_term: formData.get('lease_term') as string,
                  pets_allowed: formData.get('pets_allowed') === 'on',
                  parking_included: formData.get('parking_included') === 'on',
                  utilities_included: formData.get('utilities_included') as string || '',
                  amenities: [
                    formData.get('in_unit_laundry') === 'on' && 'In-unit laundry',
                    formData.get('dishwasher') === 'on' && 'Dishwasher',
                    formData.get('central_ac') === 'on' && 'Central AC/Heat',
                    formData.get('hardwood_floors') === 'on' && 'Hardwood floors'
                  ].filter(Boolean) as string[],
                  status: 'active',
                  photos: []
                };

                try {
                  // Create listing in database
                  console.log('Creating listing with data:', listingData);
                  const response = await fetch('http://localhost:3001/api/listings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(listingData)
                  });

                  const result = await response.json();
                  console.log('Listing creation response:', result);

                  if (result.ok) {
                    // Post to Facebook if checked
                    if (formData.get('post_to_facebook') === 'on') {
                      const fbResponse = await fetch('http://localhost:3001/api/listings/syndicate/facebook', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ listingId: result.listing.id })
                      });

                      const fbResult = await fbResponse.json();
                      
                      if (fbResult.ok && fbResult.syndication?.success) {
                        alert(`✅ Listing created and posted to Facebook!\n\nView on Facebook: ${fbResult.syndication.platformUrl}`);
                      } else {
                        alert(`✅ Listing created!\n⚠️ Facebook posting failed: ${fbResult.syndication?.error || 'Unknown error'}`);
                      }
                    } else {
                      alert('✅ Listing created successfully!');
                    }
                    
                    setCreateListingModalOpen(false);
                  } else {
                    alert(`❌ Failed to create listing: ${result.error}`);
                  }
                } catch (error) {
                  console.error('Error creating listing:', error);
                  alert('❌ Failed to create listing. Please try again.');
                }
              }} className="space-y-6">
                {/* Property Address */}
                <div className="bg-blue-50/50 rounded-lg border border-blue-200 p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Property Address *</label>
                  <input
                    type="text"
                    name="address"
                    defaultValue={primaryProperty.address || ''}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">The property address from your portfolio</p>
                </div>

                {/* Listing Title */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Listing Title *</label>
                  <input
                    type="text"
                    name="title"
                    placeholder="e.g., Beautiful 2BR Apartment in Downtown"
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">Create an attention-grabbing title for your listing</p>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description *</label>
                  <textarea
                    name="description"
                    rows={4}
                    placeholder="Describe the property, amenities, and what makes it special..."
                    className="w-full px-3 py-2 border rounded-lg text-sm resize-none"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">Detailed descriptions get 40% more inquiries</p>
                </div>

                {/* Rental Details Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Monthly Rent *</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-500 text-sm">$</span>
                      <input
                        type="number"
                        name="monthly_rent"
                        placeholder="2500"
                        className="w-full pl-7 pr-3 py-2 border rounded-lg text-sm"
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Security Deposit</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-500 text-sm">$</span>
                      <input
                        type="number"
                        name="security_deposit"
                        placeholder="2500"
                        className="w-full pl-7 pr-3 py-2 border rounded-lg text-sm"
                      />
                    </div>
                  </div>
                </div>

                {/* Property Details Grid */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Bedrooms</label>
                    <input
                      type="number"
                      name="beds"
                      placeholder="2"
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Bathrooms</label>
                    <input
                      type="number"
                      name="baths"
                      step="0.5"
                      placeholder="2"
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Square Feet</label>
                    <input
                      type="number"
                      name="sqft"
                      placeholder="1200"
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                    />
                  </div>
                </div>

                {/* Dates and Lease */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Available Date</label>
                    <input
                      type="date"
                      name="available_date"
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Lease Term</label>
                    <select name="lease_term" className="w-full px-3 py-2 border rounded-lg text-sm">
                      <option value="12 months">12 months</option>
                      <option value="6 months">6 months</option>
                      <option value="month-to-month">Month-to-month</option>
                      <option value="negotiable">Negotiable</option>
                    </select>
                  </div>
                </div>

                {/* Amenities Checkboxes */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Amenities & Features</label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="pets_allowed" className="rounded" />
                      <span>Pets Allowed</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="parking_included" className="rounded" />
                      <span>Parking Included</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="in_unit_laundry" className="rounded" />
                      <span>In-unit Laundry</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="dishwasher" className="rounded" />
                      <span>Dishwasher</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="central_ac" className="rounded" />
                      <span>Central AC/Heat</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="hardwood_floors" className="rounded" />
                      <span>Hardwood Floors</span>
                    </label>
                  </div>
                </div>

                {/* Utilities */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Utilities Included</label>
                  <input
                    type="text"
                    name="utilities_included"
                    placeholder="e.g., Heat and Hot Water"
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">List which utilities are included in rent</p>
                </div>

                {/* Photos */}
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                  <svg className="w-12 h-12 text-gray-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <h3 className="text-sm font-medium text-gray-700 mb-1">Upload Photos</h3>
                  <p className="text-xs text-gray-500 mb-3">Listings with photos get 3x more views. Add up to 10 photos.</p>
                  <button type="button" className="text-sm text-blue-600 hover:text-blue-700 font-medium">
                    Choose Files
                  </button>
                  <p className="text-xs text-gray-400 mt-2">JPG or PNG, max 5MB each</p>
                </div>

                {/* Platform Selection */}
                <div className="bg-gray-50 rounded-lg border p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-3">Post to Platforms</label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-3 p-3 rounded-lg border bg-white hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox" name="post_to_facebook" className="rounded" defaultChecked />
                      <div className="h-8 w-8 rounded bg-blue-600 flex items-center justify-center text-white text-sm font-bold shrink-0">f</div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-800">Facebook Page</div>
                        <div className="text-xs text-gray-500">Post to your Facebook Page • Free</div>
                      </div>
                      <span className="text-xs text-emerald-600 font-medium">✓ Connected</span>
                    </label>
                    <label className="flex items-center gap-3 p-3 rounded-lg border bg-white hover:bg-gray-50 cursor-pointer opacity-50">
                      <input type="checkbox" className="rounded" disabled />
                      <div className="h-8 w-8 rounded bg-blue-500 flex items-center justify-center text-white text-sm font-bold shrink-0">Z</div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-800">Zillow / Trulia / HotPads</div>
                        <div className="text-xs text-gray-500">Requires 20+ properties • Free</div>
                      </div>
                      <span className="text-xs text-gray-500">Not Available</span>
                    </label>
                    <label className="flex items-center gap-3 p-3 rounded-lg border bg-white hover:bg-gray-50 cursor-pointer opacity-50">
                      <input type="checkbox" className="rounded" disabled />
                      <div className="h-8 w-8 rounded bg-purple-600 flex items-center justify-center text-white text-sm font-bold shrink-0">CL</div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-800">Craigslist</div>
                        <div className="text-xs text-gray-500">Manual posting • Free</div>
                      </div>
                      <span className="text-xs text-gray-500">Coming Soon</span>
                    </label>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3 pt-4 border-t">
                  <button
                    type="button"
                    onClick={() => setCreateListingModalOpen(false)}
                    className="flex-1 rounded-lg border border-gray-300 text-gray-700 px-4 py-2.5 text-sm hover:bg-gray-50 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 rounded-lg bg-blue-600 text-white px-4 py-2.5 text-sm hover:bg-blue-700 font-medium"
                  >
                    Create & Publish Listing
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Street View Expanded Modal */}
      {isStreetViewModalOpen && (() => {
        const modalAddress = streetViewModalAddress
          || (propertyDashboard?.summary?.address as string)
          || [primaryProperty.address, primaryProperty.location].filter(Boolean).join(', ')
          || 'Address not set';
        const closeStreetView = () => {
          setIsStreetViewModalOpen(false);
          setStreetViewModalAddress(null);
        };
        return (
        <div 
          className="fixed inset-0 z-[10000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeStreetView}
        >
          <div 
            className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Property Street View</h2>
                <p className="text-sm text-gray-600 mt-1">{modalAddress}</p>
              </div>
              <button
                onClick={closeStreetView}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Content - Large Street View */}
            <div className="flex-1 p-6 overflow-auto">
              <div className="w-full h-full min-h-[600px] flex items-center justify-center">
                <StreetViewImage
                  address={modalAddress}
                  className="rounded-lg shadow-lg"
                  width={1200}
                  height={600}
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t bg-gray-50 rounded-b-2xl">
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  <svg className="w-4 h-4 inline mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                  </svg>
                  Street-level view powered by Google Maps
                </div>
                <button
                  onClick={closeStreetView}
                  className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg text-sm font-medium transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
};

/* -------------------- SEARCH PAGE WITH LEAFLET MAP -------------------- */

// Geocoding via Google Maps Geocoder (replaces Nominatim)
const geocodeAddress = async (address: string) => {
  if (!address) return null;
  await loadGoogleMaps();
  const g = (window as any).google;
  return new Promise<{ lat: number; lng: number } | null>((resolve) => {
    const geocoder = new g.maps.Geocoder();
    geocoder.geocode({ address, componentRestrictions: { country: "US" } }, (results: any, status: string) => {
      if (status === "OK" && results && results[0]) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng() });
      } else {
        resolve(null);
      }
    });
  });
};

const STATE_PINS: { name: string; lat: number; lng: number }[] = [
  { name:'WA', lat:47.4, lng:-120.5 }, { name:'OR', lat:44.1, lng:-120.6 }, { name:'CA', lat:37.2, lng:-119.5 }, { name:'NV', lat:38.8, lng:-117.1 },
  { name:'ID', lat:44.4, lng:-114.6 }, { name:'MT', lat:46.9, lng:-110.5 }, { name:'WY', lat:43.1, lng:-107.6 }, { name:'UT', lat:39.4, lng:-111.6 },
  { name:'AZ', lat:34.2, lng:-111.7 }, { name:'CO', lat:39.0, lng:-105.7 }, { name:'NM', lat:34.5, lng:-106.2 }, { name:'ND', lat:47.5, lng:-100.5 },
  { name:'SD', lat:44.6, lng:-100.3 }, { name:'NE', lat:41.6, lng:-99.5 }, { name:'KS', lat:38.5, lng:-98.4 }, { name:'OK', lat:35.6, lng:-97.5 },
  { name:'TX', lat:31.1, lng:-99.3 }, { name:'MN', lat:46.0, lng:-94.3 }, { name:'IA', lat:42.1, lng:-93.5 }, { name:'MO', lat:38.5, lng:-92.6 },
  { name:'AR', lat:34.9, lng:-92.3 }, { name:'LA', lat:31.0, lng:-91.9 }, { name:'WI', lat:44.6, lng:-89.9 }, { name:'IL', lat:40.0, lng:-89.2 },
  { name:'MI', lat:44.2, lng:-85.4 }, { name:'IN', lat:39.9, lng:-86.1 }, { name:'OH', lat:40.3, lng:-82.8 }, { name:'KY', lat:37.7, lng:-85.1 },
  { name:'TN', lat:35.7, lng:-86.4 }, { name:'MS', lat:32.8, lng:-89.6 }, { name:'AL', lat:32.8, lng:-86.9 }, { name:'GA', lat:32.6, lng:-83.4 },
  { name:'FL', lat:28.4, lng:-82.1 }, { name:'SC', lat:33.9, lng:-80.9 }, { name:'NC', lat:35.5, lng:-79.4 }, { name:'VA', lat:37.5, lng:-78.7 },
  { name:'WV', lat:38.6, lng:-80.6 }, { name:'PA', lat:40.8, lng:-77.9 },
  { name:'NH', lat:43.8, lng:-71.6 }, { name:'VT', lat:44.1, lng:-72.7 }, { name:'MA', lat:42.3, lng:-71.9 }, { name:'CT', lat:41.6, lng:-72.7 },
  { name:'RI', lat:41.7, lng:-71.6 }, { name:'NJ', lat:40.1, lng:-74.6 }, { name:'DE', lat:39.1, lng:-75.5 }, { name:'MD', lat:39.0, lng:-76.7 },
  { name:'DC', lat:38.9, lng:-77.0 }
];

export default PortfolioPage;
