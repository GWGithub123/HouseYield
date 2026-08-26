import { authenticatedFetch } from '../utils/authenticatedFetch';

const baseUrl = (import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

export type WeatherHazard =
  | 'heat'
  | 'cold'
  | 'high_wind'
  | 'heavy_rain'
  | 'flood'
  | 'thunderstorm'
  | 'winter_storm'
  | 'humidity_spike';

export type WeatherOverallRisk = 'none' | 'low' | 'moderate' | 'high' | 'critical';

export type WeatherSample = {
  timestamp: number;
  tempF: number;
  feelsLikeF?: number;
  humidity?: number | null;
  windMph?: number | null;
  windGustMph?: number | null;
  precipIn?: number;
  weatherId?: number | null;
  description?: string;
};

export type ExtremeEventWindow = {
  hazard: WeatherHazard;
  startTs: number;
  endTs: number;
  peakValue: number;
  peakLabel: string;
  severity: 'watch' | 'warning' | 'extreme';
  propertyImpact: string;
  source?: string;
  alertId?: string;
};

export type WeatherPrepAction = {
  id: string;
  label: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
};

export type FloodMapBridge = {
  suggestedStormInches: 0.5 | 1 | 2 | 3 | 4 | 6;
  precipNext24hIn: number;
  peakPrecipIn3h: number;
  shouldSimulateWaterFlow: boolean;
  actionHint: string;
};

export type ExtremeWeatherAssessment = {
  propertyId: string;
  propertyAddress?: string;
  overallRisk: WeatherOverallRisk;
  mostUrgentHazard: WeatherHazard | null;
  hoursToNextEvent: number | null;
  current: WeatherSample;
  forecast: WeatherSample[];
  events: ExtremeEventWindow[];
  actions: WeatherPrepAction[];
  indoorBridge: {
    risingOutdoorHumidity: boolean;
    roomsToWatch: string[];
  };
  floodMapBridge?: FloodMapBridge;
  alerts: Array<{
    id: string;
    event: string;
    severity: string;
    headline: string;
    description?: string;
    instruction?: string;
    onset?: string | null;
    ends?: string | null;
  }>;
  chartData: Array<{
    time: number;
    tempF?: number;
    humidity?: number | null;
    windMph?: number | null;
    precipIn?: number;
  }>;
  recommendation: string;
  generatedAt: string;
  location: { lat: number; lng: number; label?: string };
  disclaimer?: string;
  cache?: string;
};

export type ForecastSlotAction = 'none' | 'watch' | 'prep' | 'act';

export type ForecastTimelineSlot = {
  timestamp: number;
  label: string;
  tempF: number | null;
  humidity: number | null;
  windMph: number | null;
  windGustMph: number | null;
  precipIn: number;
  description: string;
  action: ForecastSlotAction;
  actionLabel: string;
  actionDetail: string;
};

export async function fetchPropertyWeatherAssessment(params: {
  propertyId: string;
  latitude?: number | null;
  longitude?: number | null;
  address?: string;
  refresh?: boolean;
}): Promise<ExtremeWeatherAssessment> {
  const query = new URLSearchParams({ propertyId: params.propertyId });
  if (params.latitude != null) query.set('latitude', String(params.latitude));
  if (params.longitude != null) query.set('longitude', String(params.longitude));
  if (params.address) query.set('address', params.address);
  if (params.refresh) query.set('refresh', '1');

  const response = await authenticatedFetch(`${baseUrl}/api/property-weather/assessment?${query}`);
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data?.success || !data.assessment) {
    const detail = data?.message || data?.error || `HTTP ${response.status}`;
    // Catch-all backend 404 usually means the local push-server needs a restart
    // after deploying the property-weather route.
    if (response.status === 404 && (detail === 'Not found' || data?.path?.includes('property-weather'))) {
      throw new Error('Weather API not available — restart the local backend (port 3001) and try again.');
    }
    throw new Error(detail || 'Failed to load weather assessment');
  }
  return data.assessment as ExtremeWeatherAssessment;
}

export function weatherRiskTone(
  risk: WeatherOverallRisk | undefined | null,
): 'healthy' | 'attention' | 'critical' {
  if (risk === 'critical' || risk === 'high') return 'critical';
  if (risk === 'moderate' || risk === 'low') return 'attention';
  return 'healthy';
}

export function weatherRiskLabel(risk: WeatherOverallRisk | undefined | null): string {
  if (risk === 'critical') return 'CRITICAL';
  if (risk === 'high') return 'HIGH RISK';
  if (risk === 'moderate') return 'WATCH';
  if (risk === 'low') return 'ADVISORY';
  return 'CLEAR';
}

function slotAction(sample: WeatherSample): Pick<ForecastTimelineSlot, 'action' | 'actionLabel' | 'actionDetail'> {
  const precip = Number(sample.precipIn) || 0;
  const gust = sample.windGustMph ?? sample.windMph ?? 0;
  const temp = sample.tempF;
  const humidity = sample.humidity ?? 0;

  if (precip >= 1.0 || gust >= 58 || (temp != null && temp >= 105)) {
    return {
      action: 'act',
      actionLabel: 'Act',
      actionDetail: precip >= 1
        ? 'Heavy rain window — clear drains; confirm Flood sensors awake.'
        : gust >= 58
          ? 'Damaging wind — secure outdoor items / storm protection.'
          : 'Extreme heat — reduce HVAC stress if possible.',
    };
  }
  if (precip >= 0.5 || gust >= 40 || (temp != null && temp >= 95)) {
    return {
      action: 'prep',
      actionLabel: 'Prep',
      actionDetail: precip >= 0.5
        ? 'Elevated rain — simulate on Flood Risk water-flow map.'
        : gust >= 40
          ? 'High wind watch — secure loose outdoor items.'
          : 'Heat watch — check cooling capacity.',
    };
  }
  if (precip >= 0.1 || gust >= 25 || humidity >= 85) {
    return {
      action: 'watch',
      actionLabel: 'Watch',
      actionDetail: precip >= 0.1
        ? 'Light rain — no urgent action; keep an eye on drainage.'
        : humidity >= 85
          ? 'Humid outdoor air — watch indoor RH / mold rooms.'
          : 'Breezy — no urgent outdoor prep.',
    };
  }
  return {
    action: 'none',
    actionLabel: 'Clear',
    actionDetail: 'No weather-driven action for this window.',
  };
}

/** OpenWeather 5‑day feed is 3‑hour steps — present as a timeline, not true 60‑min hours. */
export function buildForecastTimeline(
  assessment: ExtremeWeatherAssessment | null | undefined,
  options?: { hours?: number; maxSlots?: number },
): ForecastTimelineSlot[] {
  if (!assessment) return [];
  const hours = options?.hours ?? 48;
  const maxSlots = options?.maxSlots ?? 16;
  const now = Date.now();
  const horizon = now + hours * 60 * 60 * 1000;
  const points: WeatherSample[] = [];

  if (assessment.current?.timestamp) {
    points.push(assessment.current);
  }
  for (const sample of assessment.forecast || []) {
    if (sample.timestamp >= now - 60 * 60 * 1000 && sample.timestamp <= horizon) {
      points.push(sample);
    }
  }

  const seen = new Set<number>();
  const slots: ForecastTimelineSlot[] = [];
  for (const sample of points.sort((a, b) => a.timestamp - b.timestamp)) {
    const bucket = Math.round(sample.timestamp / (3 * 60 * 60 * 1000));
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    const action = slotAction(sample);
    const isNow = Math.abs(sample.timestamp - now) < 45 * 60 * 1000;
    slots.push({
      timestamp: sample.timestamp,
      label: isNow
        ? 'Now'
        : new Date(sample.timestamp).toLocaleString(undefined, {
          weekday: 'short',
          hour: 'numeric',
        }),
      tempF: Number.isFinite(sample.tempF) ? sample.tempF : null,
      humidity: sample.humidity ?? null,
      windMph: sample.windMph ?? null,
      windGustMph: sample.windGustMph ?? null,
      precipIn: Number(sample.precipIn) || 0,
      description: sample.description || '',
      ...action,
    });
    if (slots.length >= maxSlots) break;
  }
  return slots;
}

export function floodBridgeFromAssessment(
  assessment: ExtremeWeatherAssessment | null | undefined,
): FloodMapBridge | null {
  if (assessment?.floodMapBridge) return assessment.floodMapBridge;
  if (!assessment) return null;
  // Client-side fallback if an older server response omits the bridge.
  const now = Date.now();
  const points = [assessment.current, ...(assessment.forecast || [])].filter(Boolean);
  const next24 = points.filter((p) => p.timestamp >= now - 30 * 60 * 1000 && p.timestamp <= now + 24 * 60 * 60 * 1000);
  const precipNext24hIn = next24.reduce((sum, p) => sum + (Number(p.precipIn) || 0), 0);
  const peakPrecipIn3h = Math.max(0, ...points.map((p) => Number(p.precipIn) || 0));
  const steps = [0.5, 1, 2, 3, 4, 6] as const;
  const raw = Math.max(precipNext24hIn, peakPrecipIn3h * 1.5);
  const suggestedStormInches = (steps.find((s) => s >= Math.min(6, raw)) ?? 6) as FloodMapBridge['suggestedStormInches'];
  const shouldSimulateWaterFlow = precipNext24hIn >= 0.25 || peakPrecipIn3h >= 0.15;
  return {
    suggestedStormInches: raw <= 0 ? 0.5 : suggestedStormInches,
    precipNext24hIn: Math.round(precipNext24hIn * 100) / 100,
    peakPrecipIn3h: Math.round(peakPrecipIn3h * 100) / 100,
    shouldSimulateWaterFlow,
    actionHint: shouldSimulateWaterFlow
      ? 'Rain in the forecast — simulate on the Flood Risk water-flow map.'
      : 'No meaningful rain in the next day — FEMA map stays on baseline simulation.',
  };
}
