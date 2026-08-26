/**
 * Extreme weather assessment for Predictive Maintenance.
 *
 * Pulls OpenWeather current + 5-day/3h forecast and NWS active alerts,
 * scores property hazards over the next ~48–72h, and returns prep actions
 * for the live property twin / Analytics weather layer.
 */

import { getFirestore } from '../firebase-admin.js';
import { getIotFirestore } from '../iot-cloud-firestore.js';

const CACHE_TTL_MS = 45 * 60 * 1000;
const FORECAST_HOURS = 72;
/** Bump when assessment math/units change so stale in-memory results are discarded. */
const ASSESSMENT_CACHE_VERSION = 3;

const FLOOD_STORM_STEPS = [0.5, 1, 2, 3, 4, 6];

/** Map forecast rainfall onto the Portfolio Flood Risk storm-intensity chips. */
function snapFloodStormInches(inches) {
  if (!Number.isFinite(inches) || inches <= 0) return 0.5;
  const capped = Math.min(6, inches);
  const ceilStep = FLOOD_STORM_STEPS.find((step) => step >= capped);
  return ceilStep ?? 6;
}

function buildFloodMapBridge(current, forecast, events) {
  const now = Date.now();
  const horizon24 = now + 24 * 60 * 60 * 1000;
  const points = [current, ...(forecast || [])].filter((p) => p && Number.isFinite(p.timestamp));
  const next24 = points.filter((p) => p.timestamp >= now - 30 * 60 * 1000 && p.timestamp <= horizon24);
  const precipNext24hIn = next24.reduce((sum, p) => sum + (Number(p.precipIn) || 0), 0);
  const peakPrecipIn3h = Math.max(0, ...points.map((p) => Number(p.precipIn) || 0));
  const rainEvent = (events || []).find((e) => e.hazard === 'heavy_rain' || e.hazard === 'flood');
  const suggestedStormInches = snapFloodStormInches(Math.max(precipNext24hIn, peakPrecipIn3h * 1.5));
  const shouldSimulateWaterFlow = precipNext24hIn >= 0.25 || peakPrecipIn3h >= 0.15 || Boolean(rainEvent);

  let actionHint = 'No meaningful rain in the next day — FEMA map stays on baseline simulation.';
  if (peakPrecipIn3h >= 0.5 || precipNext24hIn >= 1) {
    actionHint = 'Heavy rain in the forecast — simulate this storm on the Flood Risk water-flow map and confirm leak sensors are awake.';
  } else if (shouldSimulateWaterFlow) {
    actionHint = 'Light–moderate rain ahead — open Flood Risk water flow and compare pooling paths to your drains.';
  }

  return {
    suggestedStormInches,
    precipNext24hIn: Math.round(precipNext24hIn * 100) / 100,
    peakPrecipIn3h: Math.round(peakPrecipIn3h * 100) / 100,
    shouldSimulateWaterFlow,
    actionHint,
  };
}

const DEFAULT_THRESHOLDS = {
  heatWarnF: 95,
  heatDangerF: 105,
  windWarnMph: 40,
  windDangerMph: 58,
  rainWarnInPer3h: 0.5,
  rainDangerInPer3h: 1.0,
  humidityWarnRh: 85,
};

/** @type {Map<string, { expiresAt: number, assessment: object }>} */
const memoryCache = new Map();

function openWeatherKey() {
  return process.env.OPENWEATHER_API_KEY
    || process.env.VITE_OPENWEATHER_API_KEY
    || '';
}

/** OpenWeather `units=imperial` already returns wind in mph — do not convert from m/s. */
function asMph(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function precipInches(entry) {
  const rain = entry?.rain?.['3h'] ?? entry?.rain?.['1h'] ?? 0;
  const snow = entry?.snow?.['3h'] ?? entry?.snow?.['1h'] ?? 0;
  const mm = Number(rain) + Number(snow);
  if (!Number.isFinite(mm) || mm <= 0) return 0;
  return mm / 25.4;
}

function riskRank(risk) {
  return { none: 0, low: 1, moderate: 2, high: 3, critical: 4 }[risk] ?? 0;
}

function maxRisk(a, b) {
  return riskRank(a) >= riskRank(b) ? a : b;
}

function severityToRisk(severity) {
  if (severity === 'extreme') return 'critical';
  if (severity === 'warning') return 'high';
  if (severity === 'watch') return 'moderate';
  return 'low';
}

async function geocodeAddress(address, apiKey) {
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(address)}&limit=1&appid=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const rows = await response.json();
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit || hit.lat == null || hit.lon == null) return null;
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    label: [hit.name, hit.state, hit.country].filter(Boolean).join(', '),
  };
}

async function fetchOpenWeather(lat, lng, apiKey) {
  const [currentRes, forecastRes] = await Promise.all([
    fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}&units=imperial`),
    fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&appid=${apiKey}&units=imperial`),
  ]);
  if (!currentRes.ok || !forecastRes.ok) {
    throw new Error(`OpenWeather request failed (${currentRes.status}/${forecastRes.status})`);
  }
  const currentData = await currentRes.json();
  const forecastData = await forecastRes.json();

  const current = {
    timestamp: Date.now(),
    tempF: Number(currentData.main?.temp),
    feelsLikeF: Number(currentData.main?.feels_like),
    humidity: currentData.main?.humidity != null ? Number(currentData.main.humidity) : null,
    windMph: asMph(currentData.wind?.speed),
    windGustMph: asMph(currentData.wind?.gust),
    precipIn: precipInches(currentData),
    weatherId: currentData.weather?.[0]?.id ?? null,
    description: currentData.weather?.[0]?.description || '',
  };

  const horizonMs = Date.now() + FORECAST_HOURS * 60 * 60 * 1000;
  const forecast = (forecastData.list || [])
    .map((entry) => ({
      timestamp: Number(entry.dt) * 1000,
      tempF: Number(entry.main?.temp),
      feelsLikeF: Number(entry.main?.feels_like),
      humidity: entry.main?.humidity != null ? Number(entry.main.humidity) : null,
      windMph: asMph(entry.wind?.speed),
      windGustMph: asMph(entry.wind?.gust),
      precipIn: precipInches(entry),
      weatherId: entry.weather?.[0]?.id ?? null,
      description: entry.weather?.[0]?.description || '',
    }))
    .filter((point) => Number.isFinite(point.timestamp) && point.timestamp <= horizonMs);

  return { current, forecast };
}

async function fetchNwsAlerts(lat, lng) {
  try {
    const response = await fetch(
      `https://api.weather.gov/alerts/active?point=${lat},${lng}`,
      {
        headers: {
          Accept: 'application/geo+json',
          'User-Agent': 'HouseYieldWeather/1.0 (property-protection)',
        },
      },
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.features || []).map((feature) => {
      const props = feature.properties || {};
      return {
        id: props.id || feature.id || randomId(),
        event: props.event || 'Weather alert',
        severity: String(props.severity || '').toLowerCase(),
        urgency: String(props.urgency || '').toLowerCase(),
        headline: props.headline || props.event || 'Active weather alert',
        description: props.description || '',
        instruction: props.instruction || '',
        onset: props.onset || props.effective || null,
        ends: props.ends || props.expires || null,
      };
    });
  } catch (error) {
    console.warn('[ExtremeWeather] NWS alerts unavailable:', error.message);
    return [];
  }
}

function randomId() {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function classifyOwStorm(weatherId) {
  if (weatherId == null) return null;
  const id = Number(weatherId);
  if (id >= 200 && id < 300) return 'thunderstorm';
  if (id >= 500 && id < 600) return 'heavy_rain';
  if (id >= 600 && id < 700) return 'winter_storm';
  return null;
}

function nwsHazard(eventName = '') {
  const name = String(eventName).toLowerCase();
  if (name.includes('tornado') || name.includes('severe thunderstorm') || name.includes('thunderstorm')) {
    return 'thunderstorm';
  }
  if (name.includes('high wind') || name.includes('wind advisory') || name.includes('gale')) {
    return 'high_wind';
  }
  if (name.includes('flash flood') || name.includes('flood')) return 'flood';
  if (name.includes('winter') || name.includes('ice') || name.includes('blizzard') || name.includes('snow')) {
    return 'winter_storm';
  }
  if (name.includes('heat')) return 'heat';
  if (name.includes('hurricane') || name.includes('tropical')) return 'thunderstorm';
  return null;
}

function nwsSeverityBucket(severity, urgency) {
  if (severity === 'extreme') return 'extreme';
  if (severity === 'severe') return 'warning';
  if (severity === 'moderate' || urgency === 'immediate') return 'watch';
  if (severity === 'minor') return 'watch';
  return 'watch';
}

function pushEvent(events, event) {
  const existing = events.find((row) =>
    row.hazard === event.hazard
    && Math.abs(row.startTs - event.startTs) < 3 * 60 * 60 * 1000,
  );
  if (!existing) {
    events.push(event);
    return;
  }
  if (riskRank(severityToRisk(event.severity)) > riskRank(severityToRisk(existing.severity))) {
    Object.assign(existing, event);
  } else if (event.peakValue > existing.peakValue) {
    existing.peakValue = event.peakValue;
    existing.peakLabel = event.peakLabel;
    existing.endTs = Math.max(existing.endTs, event.endTs);
  }
}

function buildActions(events, indoorBridge, alerts) {
  const actions = [];
  const has = (hazard) => events.some((event) => event.hazard === hazard)
    || alerts.some((alert) => nwsHazard(alert.event) === hazard);

  if (has('thunderstorm') || has('high_wind')) {
    actions.push({
      id: 'close-storm-protection',
      label: 'Close storm doors and shutters; secure loose outdoor items',
      reason: 'High wind or severe storm is in the forecast window.',
      priority: 'high',
    });
  }
  if (has('heavy_rain') || has('flood')) {
    actions.push({
      id: 'clear-drains-flood',
      label: 'Clear drains and confirm leak sensors are awake',
      reason: 'Heavy rain or flood risk can drive water intrusion.',
      priority: 'high',
    });
  }
  if (has('heat')) {
    actions.push({
      id: 'hvac-heat',
      label: 'Confirm HVAC cooling and check attic / sun-exposed rooms',
      reason: 'Heat wave conditions raise equipment and comfort stress.',
      priority: 'medium',
    });
  }
  if (has('humidity_spike') || indoorBridge?.risingOutdoorHumidity) {
    actions.push({
      id: 'humidity-control',
      label: 'Run dehumidifier or AC in damp rooms; watch basement/laundry RH',
      reason: 'Outdoor humidity surge can push indoor mold-risk conditions.',
      priority: 'medium',
    });
  }
  if (has('winter_storm')) {
    actions.push({
      id: 'winter-access',
      label: 'Clear walkways and check roof / outdoor shutoff access',
      reason: 'Winter precipitation may limit access and add roof load.',
      priority: 'medium',
    });
  }
  if (actions.length === 0) {
    actions.push({
      id: 'all-clear',
      label: 'No urgent outdoor prep in the next 48–72 hours',
      reason: 'Continue normal monitoring.',
      priority: 'low',
    });
  }
  return actions;
}

function analyzeSamples(current, forecast, alerts, indoorRooms, thresholds = DEFAULT_THRESHOLDS) {
  const events = [];
  const points = [current, ...forecast].filter((point) => point && Number.isFinite(point.tempF));

  for (const point of points) {
    const startTs = point.timestamp;
    const endTs = startTs + 3 * 60 * 60 * 1000;
    const gust = point.windGustMph ?? point.windMph ?? 0;
    const wind = point.windMph ?? 0;

    if (point.tempF >= thresholds.heatDangerF) {
      pushEvent(events, {
        hazard: 'heat',
        startTs,
        endTs,
        peakValue: point.tempF,
        peakLabel: `${Math.round(point.tempF)}°F`,
        severity: 'extreme',
        propertyImpact: 'Extreme heat stress on HVAC and occupied spaces.',
      });
    } else if (point.tempF >= thresholds.heatWarnF) {
      pushEvent(events, {
        hazard: 'heat',
        startTs,
        endTs,
        peakValue: point.tempF,
        peakLabel: `${Math.round(point.tempF)}°F`,
        severity: 'watch',
        propertyImpact: 'Elevated cooling load and heat exposure.',
      });
    }

    if (gust >= thresholds.windDangerMph || wind >= thresholds.windDangerMph) {
      pushEvent(events, {
        hazard: 'high_wind',
        startTs,
        endTs,
        peakValue: Math.max(gust, wind),
        peakLabel: `${Math.round(Math.max(gust, wind))} mph`,
        severity: 'warning',
        propertyImpact: 'Damaging wind risk to envelope, trees, and outdoor fixtures.',
      });
    } else if (gust >= thresholds.windWarnMph || wind >= thresholds.windWarnMph) {
      pushEvent(events, {
        hazard: 'high_wind',
        startTs,
        endTs,
        peakValue: Math.max(gust, wind),
        peakLabel: `${Math.round(Math.max(gust, wind))} mph`,
        severity: 'watch',
        propertyImpact: 'Secure outdoor items; close storm protection.',
      });
    }

    if ((point.precipIn || 0) >= thresholds.rainDangerInPer3h) {
      pushEvent(events, {
        hazard: 'heavy_rain',
        startTs,
        endTs,
        peakValue: point.precipIn,
        peakLabel: `${point.precipIn.toFixed(2)} in / 3h`,
        severity: 'warning',
        propertyImpact: 'Heavy rainfall — watch for intrusion and drainage backup.',
      });
    } else if ((point.precipIn || 0) >= thresholds.rainWarnInPer3h) {
      pushEvent(events, {
        hazard: 'heavy_rain',
        startTs,
        endTs,
        peakValue: point.precipIn,
        peakLabel: `${point.precipIn.toFixed(2)} in / 3h`,
        severity: 'watch',
        propertyImpact: 'Elevated rain volume — clear drains and verify leak sensors.',
      });
    }

    if ((point.humidity ?? 0) >= thresholds.humidityWarnRh) {
      pushEvent(events, {
        hazard: 'humidity_spike',
        startTs,
        endTs,
        peakValue: point.humidity,
        peakLabel: `${Math.round(point.humidity)}% RH`,
        severity: 'watch',
        propertyImpact: 'Outdoor humidity surge may lift indoor mold-risk conditions.',
      });
    }

    const storm = classifyOwStorm(point.weatherId);
    if (storm === 'thunderstorm') {
      pushEvent(events, {
        hazard: 'thunderstorm',
        startTs,
        endTs,
        peakValue: gust || wind || 1,
        peakLabel: point.description || 'Thunderstorm',
        severity: 'warning',
        propertyImpact: 'Thunderstorm conditions — secure outdoor items and storm doors.',
      });
    } else if (storm === 'winter_storm') {
      pushEvent(events, {
        hazard: 'winter_storm',
        startTs,
        endTs,
        peakValue: point.tempF,
        peakLabel: point.description || 'Winter precip',
        severity: 'watch',
        propertyImpact: 'Winter precipitation — access and roof load awareness (pipe freeze stays on Freeze layer).',
      });
    }
  }

  for (const alert of alerts) {
    const hazard = nwsHazard(alert.event);
    if (!hazard) continue;
    const startTs = alert.onset ? new Date(alert.onset).getTime() : Date.now();
    const endTs = alert.ends ? new Date(alert.ends).getTime() : startTs + 6 * 60 * 60 * 1000;
    pushEvent(events, {
      hazard,
      startTs: Number.isFinite(startTs) ? startTs : Date.now(),
      endTs: Number.isFinite(endTs) ? endTs : Date.now() + 6 * 60 * 60 * 1000,
      peakValue: 1,
      peakLabel: alert.event,
      severity: nwsSeverityBucket(alert.severity, alert.urgency),
      propertyImpact: alert.headline || alert.event,
      source: 'nws',
      alertId: alert.id,
    });
  }

  events.sort((a, b) => a.startTs - b.startTs);

  const risingOutdoorHumidity = (current?.humidity ?? 0) >= thresholds.humidityWarnRh
    || events.some((event) => event.hazard === 'humidity_spike');
  const roomsToWatch = risingOutdoorHumidity
    ? indoorRooms
      .filter((room) => (room.humidity ?? 0) >= 55)
      .sort((a, b) => (b.humidity ?? 0) - (a.humidity ?? 0))
      .slice(0, 3)
      .map((room) => room.name)
    : [];

  const indoorBridge = {
    risingOutdoorHumidity,
    roomsToWatch,
  };

  let overallRisk = 'none';
  for (const event of events) {
    overallRisk = maxRisk(overallRisk, severityToRisk(event.severity));
  }
  if (overallRisk === 'none' && alerts.length > 0) overallRisk = 'low';

  const now = Date.now();
  const upcoming = events.find((event) => event.endTs >= now) || events[0] || null;
  const hoursToNextEvent = upcoming
    ? Math.max(0, Math.round((upcoming.startTs - now) / (60 * 60 * 1000)))
    : null;

  // `time` is a numeric unix ms for Recharts (same convention as Analytics layers).
  const chartData = points.map((point) => ({
    time: point.timestamp,
    tempF: point.tempF,
    humidity: point.humidity,
    windMph: point.windMph,
    precipIn: point.precipIn,
  }));

  const actions = buildActions(events, indoorBridge, alerts);
  const floodMapBridge = buildFloodMapBridge(current, forecast, events);
  const recommendation = overallRisk === 'none'
    ? 'No significant outdoor weather risk in the next 48–72 hours. Keep normal sensor monitoring.'
    : `${upcoming?.peakLabel || 'Weather risk'} ahead — complete the prep checklist before the window arrives.`;

  return {
    overallRisk,
    mostUrgentHazard: upcoming?.hazard || null,
    hoursToNextEvent,
    current,
    forecast,
    events,
    actions,
    indoorBridge,
    floodMapBridge,
    alerts,
    chartData,
    recommendation,
    generatedAt: new Date().toISOString(),
  };
}

async function loadIndoorClimateRooms(propertyId) {
  if (!propertyId) return [];
  try {
    const db = getIotFirestore();
    const snap = await db.collection('shelly_devices').where('propertyId', '==', propertyId).get();
    return snap.docs
      .map((doc) => {
        const data = doc.data() || {};
        const type = String(data.type || data.deviceType || '').toLowerCase();
        const id = String(data.deviceId || doc.id || '').toLowerCase();
        const isHt = type.includes('humidity')
          || type.includes('temperature')
          || id.includes('blu-ht')
          || id.includes('shellyht');
        if (!isHt) return null;
        return {
          name: data.name || data.location || doc.id,
          humidity: data.humidity != null ? Number(data.humidity) : null,
          temperatureF: data.temperatureF != null
            ? Number(data.temperatureF)
            : (data.temperature != null ? (Number(data.temperature) * 9) / 5 + 32 : null),
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn('[ExtremeWeather] Indoor climate lookup failed:', error.message);
    return [];
  }
}

async function resolvePropertyAccess(ownerId, propertyId) {
  const db = getFirestore();
  const snap = await db.collection('properties').doc(propertyId).get();
  if (!snap.exists) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }
  const data = snap.data() || {};
  const allowed = [data.ownerId, data.userId, data.landlordId].filter(Boolean);
  if (ownerId && allowed.length && !allowed.includes(ownerId)) {
    const err = new Error('Property access denied');
    err.status = 403;
    throw err;
  }
  return { id: propertyId, ...data };
}

export async function buildExtremeWeatherAssessment({
  ownerId,
  propertyId,
  latitude = null,
  longitude = null,
  address = '',
  forceRefresh = false,
}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  const cacheKey = `v${ASSESSMENT_CACHE_VERSION}__${ownerId || 'anon'}__${propertyId}`;
  const cached = memoryCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return { ...cached.assessment, cache: 'hit' };
  }

  const apiKey = openWeatherKey();
  if (!apiKey) {
    const err = new Error('OPENWEATHER_API_KEY is not configured');
    err.status = 503;
    err.code = 'no_weather_key';
    throw err;
  }

  const property = await resolvePropertyAccess(ownerId, propertyId);
  const summary = property.propertyData?.summary || {};
  let lat = latitude != null ? Number(latitude) : Number(summary.latitude);
  let lng = longitude != null ? Number(longitude) : Number(summary.longitude);
  let locationLabel = address || property.address || '';

  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && locationLabel) {
    const geo = await geocodeAddress(locationLabel, apiKey);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      locationLabel = geo.label || locationLabel;
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const err = new Error('Property latitude/longitude unavailable');
    err.status = 422;
    err.code = 'no_location';
    throw err;
  }

  const [{ current, forecast }, alerts, indoorRooms] = await Promise.all([
    fetchOpenWeather(lat, lng, apiKey),
    fetchNwsAlerts(lat, lng),
    loadIndoorClimateRooms(propertyId),
  ]);

  const analysis = analyzeSamples(current, forecast, alerts, indoorRooms);
  const assessment = {
    ...analysis,
    propertyId,
    propertyAddress: property.address || locationLabel,
    location: { lat, lng, label: locationLabel || property.address || `${lat.toFixed(3)}, ${lng.toFixed(3)}` },
    cache: 'miss',
    disclaimer: 'Advisory outdoor prep only. Does not guarantee loss prevention, code compliance, or insurance eligibility. Pipe freeze risk remains on the Freeze analytics layer.',
  };

  memoryCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    assessment,
  });

  // Best-effort persist for twin reloads / debugging.
  try {
    await getFirestore().collection('properties').doc(propertyId).set({
      weatherAssessment: {
        overallRisk: assessment.overallRisk,
        mostUrgentHazard: assessment.mostUrgentHazard,
        hoursToNextEvent: assessment.hoursToNextEvent,
        recommendation: assessment.recommendation,
        generatedAt: assessment.generatedAt,
        current: assessment.current,
      },
      weatherAssessmentUpdatedAt: assessment.generatedAt,
    }, { merge: true });
  } catch (error) {
    console.warn('[ExtremeWeather] Could not persist assessment summary:', error.message);
  }

  return assessment;
}

export function __resetExtremeWeatherCacheForTests() {
  memoryCache.clear();
}
